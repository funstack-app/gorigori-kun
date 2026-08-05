/**
 * L2: AI切り抜きを既定にし、**失敗したらクロマキーへ落ちる**ことの検査（J4）。
 *
 * ## この検査が守っているもの
 *
 * 設計書 §1.4 はクロマキーを既定に置き、抜け残りが多い場合の代替として J4
 * （Mac=Vision / Win通常版=BiRefNet）を用意していた。実機で抜けのばらつきが
 * 観測されたので分岐を発動した。
 *
 * 降格であって**廃止ではない**。クロマキーが要るのは2つ:
 * (1) Windows互換版（`edit-ai` 無効ビルド）には BiRefNet も Vision も無い
 * (2) AI抜きの失敗（モデル未DL・推論エラー・OS API の失敗）
 *
 * どちらでも生成物を失わせない（設計原則 第5条: 救済 + 可視化）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  canUseAiCutout,
  cutOutBackground,
  type CutoutDeps,
} from "../src/lib/sticker/cutout";

function platform(overrides: Record<string, unknown> = {}) {
  return {
    os: "macos",
    arch: "aarch64",
    isAppleSilicon: true,
    editAiAvailable: true,
    ...overrides,
  } as never;
}

function chromaOk(overrides: Record<string, unknown> = {}) {
  return {
    output: "/tmp/cut.png",
    cleared: 4000,
    semiTransparent: 40,
    opaque: 100,
    despilled: 12,
    fringeWarn: false,
    ...overrides,
  };
}

/** 既定の継ぎ目。各テストが必要な口だけ差し替える。 */
function deps(overrides: Partial<CutoutDeps> = {}): CutoutDeps {
  return {
    platformInfo: vi.fn().mockResolvedValue(platform()),
    removeBackground: vi.fn().mockResolvedValue("/tmp/ai-cut.png"),
    segment: vi.fn().mockResolvedValue({ foregroundPath: "/tmp/birefnet-cut.png" }),
    chromaKey: vi.fn().mockResolvedValue(chromaOk()),
    ...overrides,
  };
}

describe("L2: 構成でAI抜きが使えるかを判定する", () => {
  it("Windows互換版（edit-ai 無効）は AI を使えない", () => {
    // `os` だけ見て判定すると互換版で必ず失敗する（os は "windows" のまま）。
    expect(canUseAiCutout(platform({ os: "windows", editAiAvailable: false }))).toBe(false);
  });

  it("Mac / Windows通常版は AI を使える", () => {
    expect(canUseAiCutout(platform({ os: "macos" }))).toBe(true);
    expect(canUseAiCutout(platform({ os: "windows" }))).toBe(true);
  });
});

describe("L2: 既定はAI抜き", () => {
  it("Mac では removeBackground（Vision）を通る", async () => {
    const d = deps();
    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(d.removeBackground).toHaveBeenCalledWith("/tmp/gen.png");
    expect(d.chromaKey, "AIで抜けたのにクロマキーも呼んでいる（二重処理）").not.toHaveBeenCalled();
    expect(out.method).toBe("ai");
    expect(out.path).toBe("/tmp/ai-cut.png");
    expect(out.notCleared).toBe(false);
  });

  it("Windows通常版では BiRefNet（segment）を通る", async () => {
    const d = deps({ platformInfo: vi.fn().mockResolvedValue(platform({ os: "windows" })) });
    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(d.segment).toHaveBeenCalled();
    expect(out.path).toBe("/tmp/birefnet-cut.png");
    expect(out.method).toBe("ai");
  });

  it("AI経路では統計を作らない（測っていないものを測ったふりにしない）", async () => {
    // クロマキーを通していないので `cleared` も `fringe` も存在しない。
    // 偽の統計を置くと、層Aの縁の検査が測っていない値で動く。
    const out = await cutOutBackground("/tmp/gen.png", deps());
    expect(out.chroma).toBeNull();
  });
});

describe("L2 牙: AIが失敗したらクロマキーへ落ちる", () => {
  it("removeBackground が例外を投げてもクロマキーで抜ける", async () => {
    const d = deps({
      removeBackground: vi.fn().mockRejectedValue(new Error("モデルが見つかりません")),
    });

    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(d.chromaKey, "AI失敗で止まっている（保険が働いていない）").toHaveBeenCalledWith(
      "/tmp/gen.png",
    );
    expect(out.method).toBe("chroma");
    expect(out.path).toBe("/tmp/cut.png");
    // クロマキーで抜いたので統計は存在する（層Aの縁の検査の材料）。
    expect(out.chroma?.cleared).toBe(4000);
  });

  it("removeBackground が空パスを返してもクロマキーへ落ちる", async () => {
    // 例外にならない失敗（空文字）。成功として扱うと元画像が消える。
    const d = deps({ removeBackground: vi.fn().mockResolvedValue("") });
    const out = await cutOutBackground("/tmp/gen.png", d);
    expect(out.method).toBe("chroma");
  });

  it("互換版（AI無効）は最初からクロマキーを通る", async () => {
    const d = deps({
      platformInfo: vi.fn().mockResolvedValue(platform({ os: "windows", editAiAvailable: false })),
    });
    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(d.removeBackground).not.toHaveBeenCalled();
    expect(d.segment).not.toHaveBeenCalled();
    expect(out.method).toBe("chroma");
  });

  it("構成が読めないときもクロマキーへ倒す（AI可否が不明なら保険側）", async () => {
    const d = deps({ platformInfo: vi.fn().mockRejectedValue(new Error("不明")) });
    const out = await cutOutBackground("/tmp/gen.png", d);
    expect(out.method).toBe("chroma");
  });
});

describe("L2: どの段でも生成物を失わせない（救済 + 可視化）", () => {
  it("クロマキーで1画素も抜けなければ元のパスで進み、抜けなかったと出す", async () => {
    const d = deps({
      platformInfo: vi.fn().mockResolvedValue(platform({ editAiAvailable: false })),
      chromaKey: vi.fn().mockResolvedValue(chromaOk({ cleared: 0 })),
    });

    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(out.path, "抜けていないのに差し替えている").toBe("/tmp/gen.png");
    expect(out.notCleared, "抜けなかった事実が消えている（黙って進んでいる）").toBe(true);
    // 「抜きを試みて 0 だった」という事実は層Aへ運ぶ（R2）。
    expect(out.chroma?.cleared).toBe(0);
    // 縁の品質は抜けた画像にしか語れない。
    expect(out.chroma?.fringeWarn).toBe(false);
  });

  it("AIもクロマキーも失敗したら元のパスを返して可視化する", async () => {
    const d = deps({
      removeBackground: vi.fn().mockRejectedValue(new Error("推論エラー")),
      chromaKey: vi.fn().mockRejectedValue(new Error("画像を読めません")),
    });

    const out = await cutOutBackground("/tmp/gen.png", d);

    expect(out.path, "生成物を失わせている").toBe("/tmp/gen.png");
    expect(out.method).toBe("none");
    expect(out.notCleared, "全滅したのに黙って進んでいる").toBe(true);
    expect(out.chroma, "測っていない統計を作っている").toBeNull();
  });
});
