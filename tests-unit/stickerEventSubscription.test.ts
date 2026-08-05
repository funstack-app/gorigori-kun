/**
 * F1: 生成中に画面を離れてもイベント購読が切れない。
 *
 * ## この検査が守っているもの
 *
 * 旧実装のイベント購読 useEffect は `if (!visible) return;` で張られ、依存配列にも
 * `visible` が入っていた。`visible`（`useSkillVisible`）はライブラリ/設定 drawer を
 * 開いただけ・他スキルへ切り替えただけ・生成タブ以外を開いただけで false になる。
 *
 * false になった瞬間に cleanup が走り、`unlisten()` で購読が外れる。その間に届く
 * `cutCompleted` / `completed` は誰も受け取らないので:
 *   - 完成したカットが採否リストに載らない
 *   - 波待ち（`waveWaitersRef`）が cleanup で強制解放され、次の波が早すぎるタイミングで
 *     走り出す／`running` の連打ガードが崩れる
 * ＝ 生成中に画面を離れるだけで固まる。
 *
 * S2 の mount-pool 化で Workspace 自体は unmount されない（display:none で残る）ので、
 * 購読を可視性に結ぶ理由が無い。**マウント中は常駐**が正しい。
 *
 * ## なぜソースを読む方式か
 *
 * ここは React hook の依存配列という「描画されない構造」であり、部品を単体で呼んでも
 * 確かめられない。この repo で `stickerNotCleared.test.ts`（R5）や Rust 側の
 * `a3_every_gallery_exclusion_site_filters_the_sticker_work_dir` が使っているのと
 * 同じ、実ソースを読んで構造を固定する方式を採る。
 */
import { describe, expect, it } from "vitest";

async function readSrc(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return readFile(resolve(process.cwd(), relative), "utf8");
}

const WORKSPACE = "src/components/skills/sticker/StickerWorkspace.tsx";

/**
 * コメントを落として実コードだけにする。
 *
 * これを挟まないと、修正の意図を説明したコメント（「なぜ `visible` に連動させないか」）
 * 自体にマッチして、**コードは直っているのにテストが落ちる**。検査対象は散文ではなく
 * 構造なので、比較の前にコメントを取り除く。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** イベント購読 useEffect の本体（宣言から依存配列の閉じまで）を切り出す。 */
function subscriptionEffect(src: string): string {
  const start = src.indexOf("useEffect(() => {", src.indexOf("const cutOut = useCallback"));
  expect(start, "イベント購読の useEffect が見つからない（目印が変わった？）").toBeGreaterThan(
    -1,
  );
  // この useEffect の依存配列は `}, [...]);` で閉じる。最初の1つが本体の終わり。
  const end = src.indexOf("}, [", start);
  expect(end, "useEffect の依存配列が見つからない").toBeGreaterThan(start);
  const depsEnd = src.indexOf(");", end);
  return src.slice(start, depsEnd + 2);
}

describe("F1: 生成中に画面を離れても購読が切れない", () => {
  it("購読を可視性でガードしていない", async () => {
    const effect = subscriptionEffect(codeOnly(await readSrc(WORKSPACE)));
    expect(
      effect,
      "可視性で購読を打ち切っている（画面を離れると cutCompleted / completed を取りこぼす / F1 の再発）",
    ).not.toMatch(/if\s*\(\s*!\s*visible\s*\)/);
  });

  it("依存配列に可視性が入っていない（切替のたびに張り直さない）", async () => {
    const effect = subscriptionEffect(codeOnly(await readSrc(WORKSPACE)));
    const deps = effect.slice(effect.lastIndexOf("}, ["));
    expect(
      deps,
      `依存配列に visible が残っている（画面切替で購読が張り直され、その隙にイベントを落とす / F1 の再発）: ${deps}`,
    ).not.toMatch(/\bvisible\b/);
  });

  it("購読と波待ちの解放は残っている（常駐化で救済まで消していない）", async () => {
    const effect = subscriptionEffect(codeOnly(await readSrc(WORKSPACE)));
    // アンマウント時には解放が要る。無くすと本当に永久に固まる。
    expect(effect, "unlisten を呼んでいない").toContain("unlisten?.()");
    expect(effect, "波待ちの解放が消えている").toContain("waveWaitersRef.current");
    // 受け取るイベントの種類は変えていない。
    for (const kind of ["cutStarted", "cutCompleted", "cutFailed", "completed"]) {
      expect(effect, `${kind} の処理が消えている`).toContain(kind);
    }
  });

  it("Workspace が可視性フックに依存しなくなっている", async () => {
    const src = codeOnly(await readSrc(WORKSPACE));
    // 常駐化で `visible` の消費先が無くなった。呼び出しが残っていると、
    // 「まだ可視性で何かを止めている」という誤読を生む。
    expect(
      src,
      "useSkillVisible がまだ呼ばれている（可視性でイベント処理を止める経路が残っていないか確認）",
    ).not.toContain("useSkillVisible");
  });
});
