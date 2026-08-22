import { describe, expect, it } from "vitest";

import {
  formatReferenceSnapshotError,
  formatStickerGenerationFailure,
} from "../src/lib/sticker/referenceSnapshot";

describe("スタンプ参照画像の失敗表示", () => {
  it("現在の未検出理由を一般文言で隠さない", () => {
    const message = formatStickerGenerationFailure(16, [
      "参照画像が見つかりません（ig_b02_missing.png）。画像を選び直してください",
    ]);
    expect(message).toBe(
      "参照画像が見つかりません（ig_b02_missing.png）。画像を選び直してください",
    );
    expect(message).not.toContain("もう一度お試しください");
  });

  it("旧形式の外部パスもファイル名つきの案内へ直す", () => {
    expect(
      formatStickerGenerationFailure(16, [
        "参照画像が見つかりません: /Users/example/Downloads/ig_b02_old.png",
      ]),
    ).toContain("参照画像が見つかりません（ig_b02_old.png）。画像を選び直してください");
  });

  it("その他の orchestrator 理由も消さずに表示する", () => {
    const message = formatStickerGenerationFailure(3, ["生成サービスとの接続が切れました"]);
    expect(message).toContain("3枚の生成に失敗しました");
    expect(message).toContain("生成サービスとの接続が切れました");
  });

  it("複製失敗は選択時に次の行動と詳細を示す", () => {
    const message = formatReferenceSnapshotError("disk full while copying reference");
    expect(message).toContain("参照画像をアプリ内に保存できませんでした");
    expect(message).toContain("画像を選び直してください");
    expect(message).toContain("詳しい内容: disk full while copying reference");
  });
});
