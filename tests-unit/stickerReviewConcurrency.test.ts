/**
 * L5: 審査セルフチェック（層B）の限定並列化（2026-08-05 STΛCK実機FB「確認が遅い」）。
 *
 * ## 何を守っているか
 *
 * 旧実装は完全な直列で、40枚が現実的な待ち時間を超えていた。かといって
 * 無制限の並列（`Promise.all` で全部同時）は、旧コメントが警告している
 * 「Codex 側で詰まる」をそのまま踏む。**同時数に上限を置く**のが解。
 *
 * 検査するのは3つ:
 * 1. 同時に走る数が上限を超えないこと（詰まらせない）
 * 2. 結果が**入力順**であること（完了順に並ぶと、どの絵の指摘か追えない）
 * 3. 1枚の失敗で全滅しないこと
 */
import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_CONCURRENCY,
  reviewStickerSet,
  type StickerReviewDeps,
} from "../src/lib/sticker/check";

/** 実 deps の形が変わっても壊れないよう、必要な口だけを持つ最小の偽物を作る。 */
function fakeDeps(delayMs = 5) {
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];

  const deps = {
    describeImage: vi.fn(async (path: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started.push(path);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return `${path} の説明`;
      } finally {
        inFlight -= 1;
      }
    }),
    // ⚠️ **4つの口を全部埋める**。`reviewStickerImage` は3材料を Promise.all で
    // 取ってから query を呼ぶので、1つでも欠けると即座に例外へ落ちて
    // catch に吸われる。その状態では「全部が一瞬で終わる」ため、
    // 並列度の観測が無意味な値（＝枚数そのもの）になる。
    extractText: vi.fn(async () => ({ prompt: "", regions: [] })),
    reviewFacts: vi.fn(async () => JSON.stringify(REVIEW_FACTS_STUB)),
    query: vi.fn(async () => ({ parsedJson: { issues: [] }, text: "{}" })),
  } as unknown as StickerReviewDeps;

  return { deps, peak: () => peak, started };
}

/**
 * `reviewFacts` が返す生 JSON のスタブ。
 *
 * `parseReviewFacts` の検証を通る最小の形にする。壊れた形を返すと
 * 「関所が throw する経路」を踏み、並列度でなく例外処理を測ることになる。
 */
const REVIEW_FACTS_STUB = { version: 1 };

const paths = Array.from({ length: 9 }, (_, i) => `/tmp/${String(i + 1).padStart(2, "0")}.png`);

describe("L5: 同時実行数に上限がある", () => {
  it(`同時に走るのは最大 ${REVIEW_CONCURRENCY} 本`, async () => {
    const { deps, peak } = fakeDeps();

    await reviewStickerSet(paths, [], undefined, deps);

    expect(peak(), "同時実行が上限を超えている（Codex 側で詰まる）").toBeLessThanOrEqual(
      REVIEW_CONCURRENCY,
    );

    // ⚠️ **自己言及を避ける**（規律5）。上の判定は上限値そのものを定数から
    // 引いているので、実装が上限を 999 に緩めると**閾値も一緒に緩んで通ってしまう**
    // （実測: 定数を 999 にしても上の1行は落ちなかった）。
    // 「詰まらせない」という目的は具体的な小さい数でしか守れないため、
    // ここで絶対値の天井を別に置く。上限を上げたいときは、この数も
    // 意識して上げることになる（黙って緩められない）。
    expect(
      peak(),
      "同時実行が多すぎる（上限の定数を緩めても検査が追随してしまう穴の防止）",
    ).toBeLessThanOrEqual(4);
  });

  it("牙: 直列（1本ずつ）に戻っていない", async () => {
    // 上限だけ見ていると「実は直列」でも通る。並列になっていることも確かめる。
    const { deps, peak } = fakeDeps();

    await reviewStickerSet(paths, [], undefined, deps);

    expect(peak(), "直列に戻っている（この改修の目的が消えている）").toBeGreaterThan(1);
  });

  it("枚数が上限より少なくても動く（レーンを余らせて止まらない）", async () => {
    const { deps } = fakeDeps();
    const report = await reviewStickerSet(["/tmp/01.png"], [], undefined, deps);
    expect(report.results).toHaveLength(1);
  });

  it("0枚でも落ちない", async () => {
    const { deps } = fakeDeps();
    const report = await reviewStickerSet([], [], undefined, deps);
    expect(report.results).toHaveLength(0);
  });
});

describe("L5: 結果は入力順のまま", () => {
  it("牙: 完了が逆順でも結果は入力順に並ぶ", async () => {
    // 後ろの画像ほど速く終わるようにする。完了順に push する実装なら逆順になる。
    let call = 0;
    const deps = {
      describeImage: vi.fn(async (path: string) => {
        // 先頭ほど遅い（9番が最初に終わる）。
        const index = call++;
        await new Promise((r) => setTimeout(r, Math.max(1, 20 - index * 2)));
        return `${path} の説明`;
      }),
      extractText: vi.fn(async () => ({ prompt: "", regions: [] })),
      reviewFacts: vi.fn(async () => JSON.stringify(REVIEW_FACTS_STUB)),
      query: vi.fn(async () => ({ parsedJson: { issues: [] }, text: "{}" })),
    } as unknown as StickerReviewDeps;

    const report = await reviewStickerSet(paths, [], undefined, deps);

    expect(
      report.results.map((r) => r.imagePath),
      "結果が完了順に並んでいる（どの絵の指摘か人が追えない）",
    ).toEqual(paths);
  });
});

describe("L5: 1枚の失敗で全滅しない", () => {
  it("途中で例外が出ても、他の結果は返る", async () => {
    const deps = {
      describeImage: vi.fn(async (path: string) => {
        if (path.endsWith("03.png")) throw new Error("説明できません");
        return `${path} の説明`;
      }),
      extractText: vi.fn(async () => ({ prompt: "", regions: [] })),
      reviewFacts: vi.fn(async () => JSON.stringify(REVIEW_FACTS_STUB)),
      query: vi.fn(async () => ({ parsedJson: { issues: [] }, text: "{}" })),
    } as unknown as StickerReviewDeps;

    const report = await reviewStickerSet(paths, [], undefined, deps);

    expect(report.results, "1枚の失敗で全滅している").toHaveLength(paths.length);
    // 失敗した1枚は error として残り、順序の位置も保たれる。
    const failed = report.results.find((r) => r.imagePath.endsWith("03.png"));
    expect(failed?.error, "失敗が黙って握り潰されている").toBeTruthy();
  });
});

describe("L5: 中断されたら新しい実行を始めない", () => {
  it("AbortSignal が立っていれば Codex を呼ばない", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, started } = fakeDeps();

    await reviewStickerSet(paths, [], controller.signal, deps);

    expect(started.length, "中断後も新しい検査を始めている").toBe(0);
  });
});
