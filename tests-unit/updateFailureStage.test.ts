import { describe, expect, it } from "vitest";
import {
  classifyUpdateFailure,
  classifyUpdateStage,
  RELEASES_URL,
  UPDATE_STAGE_LABEL,
} from "../src/components/UpdateChecker";

/**
 * R2 (2026-08-06): 更新失敗の「段階」と手動DL導線の検査。
 *
 * ## なぜこのテストか
 *
 * v2.5.1 で Windows ユーザーがアプデボタンから更新できなくなった。報告に残ったのは
 * 分類済みの日本語文だけで、**どこで落ちたのか** (マニフェストに届いていないのか /
 * 518MB 落とし切った後で検証に失敗したのか) が読み取れず、原因特定が遅れた。
 * さらに逃げ道の「最新版をダウンロード」が、本体の無いページ
 * (funstack-app/gorigori-kun = マニフェスト置き場) を指していた。
 *
 * 守るのは 2 点:
 *   1. 失敗した段階が出ること (呼び出し元ヒント + エラー文字列の両方を使う)
 *   2. 手動DLの遷移先が配布リポジトリ (gorigori-kun-releases) であること
 */

describe("手動DLの遷移先", () => {
  it("本体が置かれている配布リポジトリを指す (マニフェスト置き場ではない)", () => {
    // 本体 (dmg / setup.exe) は publish-manual.yml が
    // funstack-app/gorigori-kun-releases に上げている。
    expect(RELEASES_URL).toContain("funstack-app/gorigori-kun-releases");
    expect(RELEASES_URL).toMatch(/\/releases\/latest$/);
  });

  it("マニフェスト専用リポジトリ (gorigori-kun) を指していない (今日の実害)", () => {
    // "gorigori-kun-releases" は "gorigori-kun" を部分文字列に含むので、
    // contains では検出できない。リポジトリ名として厳密に比較する。
    const repo = new URL(RELEASES_URL).pathname.split("/").slice(1, 3).join("/");
    expect(repo).not.toBe("funstack-app/gorigori-kun");
    expect(repo).toBe("funstack-app/gorigori-kun-releases");
  });
});

describe("classifyUpdateStage", () => {
  it("check 経路の失敗は必ずマニフェスト取得段階 (まだ DL に入っていない)", () => {
    // 同じ「network error」でも、check 経路なら DL 中ではありえない。
    expect(classifyUpdateStage("network error", "check")).toBe("manifest");
    expect(classifyUpdateStage("signature verification failed", "check")).toBe(
      "manifest",
    );
  });

  it("install 経路で署名系の文言なら検証段階", () => {
    for (const raw of [
      "signature verification failed",
      "Could not verify the update",
      "untrusted signature",
      "minisign error",
    ]) {
      expect(classifyUpdateStage(raw, "install"), raw).toBe("verify");
    }
  });

  it("install 経路でインストール系の文言ならインストール段階", () => {
    for (const raw of [
      "failed to install the update",
      "could not extract archive",
      "failed to mount dmg",
      "requires elevation",
    ]) {
      expect(classifyUpdateStage(raw, "install"), raw).toBe("install");
    }
  });

  it("install 経路のそれ以外はダウンロード段階 (v2.5.1 の Windows 更新不能がここ)", () => {
    for (const raw of [
      "network error while fetching",
      "connection reset by peer",
      "memory allocation failed",
      "no space left on device",
    ]) {
      expect(classifyUpdateStage(raw, "install"), raw).toBe("download");
    }
  });

  it("段階は必ず日本語ラベルを持つ (報告用に出せる)", () => {
    const stages = [
      classifyUpdateStage("x", "check"),
      classifyUpdateStage("signature", "install"),
      classifyUpdateStage("install failed", "install"),
      classifyUpdateStage("x", "install"),
    ];
    for (const s of stages) {
      expect(UPDATE_STAGE_LABEL[s], s).toBeTruthy();
    }
  });
});

describe("classifyUpdateFailure", () => {
  it("どの分類でも段階が付く (5分類すべて)", () => {
    const cases: Array<[string, string]> = [
      ["network timeout", "インターネット"],
      ["signature verification failed", "検証に失敗"],
      ["no space left on device", "空き容量"],
      ["permission denied", "許可されませんでした"],
      ["something totally unexpected", "更新に失敗"],
    ];
    for (const [raw, expectedText] of cases) {
      const f = classifyUpdateFailure(raw, "install");
      expect(f.text, raw).toContain(expectedText);
      expect(f.stage, raw).toBeTruthy();
      expect(UPDATE_STAGE_LABEL[f.stage], raw).toBeTruthy();
      // 生メッセージは報告用に必ず残す。
      expect(f.raw, raw).toContain(raw);
    }
  });

  it("既存の分類5種を壊していない (文言と手動DL導線の出し分け)", () => {
    // ネットワーク断・容量不足は再試行で直りうるので手動DLを出さない。
    expect(classifyUpdateFailure("network timeout", "check").showManual).toBe(
      false,
    );
    expect(
      classifyUpdateFailure("no space left on device", "install").showManual,
    ).toBe(false);
    // 署名・権限・原因不明は再試行で直らないので手動DLを出す。
    expect(
      classifyUpdateFailure("signature verification failed", "install")
        .showManual,
    ).toBe(true);
    expect(
      classifyUpdateFailure("permission denied", "install").showManual,
    ).toBe(true);
    expect(classifyUpdateFailure("unexpected", "install").showManual).toBe(true);
  });

  it("同じエラーでも呼び出し元が違えば段階が変わる (ヒントが効いている)", () => {
    const raw = "network error";
    expect(classifyUpdateFailure(raw, "check").stage).toBe("manifest");
    expect(classifyUpdateFailure(raw, "install").stage).toBe("download");
  });
});
