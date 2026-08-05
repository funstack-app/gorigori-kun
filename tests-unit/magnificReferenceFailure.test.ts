import { describe, expect, it } from "vitest";
import {
  classifyFailures,
  isPermanentFailure,
} from "../src/lib/scene/retryClassify";
import { connectionHintFor } from "../src/lib/scene/useSceneGeneration";

/**
 * 2026-08-06 実機バグの回帰テスト。
 *
 * 症状: Magnific で「参照をつけないと生成できるが、参照をつけると4件すべて失敗」。
 * 表示は「原因を特定できませんでした … 接続（ChatGPT / Higgsfield）を見直す」。
 *
 * 真因は Rust 側 (creations_request_upload の応答キーが directUploadUrl →
 * proxyUploadUrl に変わっていた) だが、フロント側にも2つの欠陥が重なっていた:
 *   1. 参照アップロード失敗が「一時的失敗」に分類され、3回無駄にリトライした末に
 *      理由が捨てられ「原因を特定できませんでした」になっていた
 *   2. 案内が provider によらず固定で「ChatGPT / Higgsfield」だった
 * 本テストはその2点を固定する。
 */
describe("参照画像の準備失敗はリトライしても直らない", () => {
  // Rust 側 upload_magnific_reference が実際に返す文言 (magnific.rs と対応)。
  const referenceFailures = [
    "Magnific の参照画像は PNG / JPEG / WebP のみ対応です (/tmp/a.gif)",
    "参照画像を読み込めませんでした (/tmp/a.png): No such file",
    "参照画像のアップロード準備に失敗しました: upstream error",
    "参照画像のアップロード先URLを取得できませんでした。受信したキー構成: path:string",
    "参照画像のアップロードに失敗しました (HTTP 403)",
    "参照画像の確定に失敗しました: bad path",
  ];

  it.each(referenceFailures)("恒久的失敗として扱う: %s", (reason) => {
    expect(isPermanentFailure(reason)).toBe(true);
  });

  it("理由が保持され、リトライされない", () => {
    const reason =
      "参照画像のアップロード先URLを取得できませんでした。受信したキー構成: path:string";
    const decision = classifyFailures([reason], true);

    // リトライしない (旧実装は3回リトライして理由を捨てていた)。
    expect(decision.shouldRetry).toBe(false);
    expect(decision.allPermanent).toBe(true);
    // 理由がユーザー表示用に残る = 「原因を特定できませんでした」にならない。
    expect(decision.permanentReasons).toEqual([reason]);
  });

  it("参照と無関係な一時的失敗は従来どおりリトライする", () => {
    // 回帰防止: 参照系の語を足したことで通常の一時的失敗まで
    // 恒久扱いになっていないこと。
    const decision = classifyFailures(["timeout while waiting"], true);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.permanentReasons).toEqual([]);
  });
});

describe("失敗案内は実際に使ったサービスを指す", () => {
  it("provider ごとに宛先が変わる", () => {
    expect(connectionHintFor("magnific")).toBe("Magnific");
    expect(connectionHintFor("higgsfield")).toBe("Higgsfield");
    expect(connectionHintFor("codex")).toBe("ChatGPT");
  });

  it("Magnific 利用時に他サービスへ誘導しない", () => {
    // 旧実装の固定文言 "ChatGPT / Higgsfield" が復活したら落ちる。
    const hint = connectionHintFor("magnific");
    expect(hint).not.toContain("ChatGPT");
    expect(hint).not.toContain("Higgsfield");
  });
});
