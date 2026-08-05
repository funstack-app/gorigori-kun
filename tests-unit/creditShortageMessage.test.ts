// クレジット/利用枠の不足が、生の英語エラーのままユーザーに出ないことを守るテスト。
//
// 背景 (アンケート36回答 2026-08-04): Q6 最多の不満が「エラーで進めない」(9件)、
// さらに #2「クレジットがとけて、断念」/ #26「料金がわからなくて怖い」。
// 枠切れは動画生成(53%が主目的)で最初に踏む地雷なのに、
// `not_enough_credits` が生文字列のままトーストに出ていた。
//
// 3層で同じ語彙を使う設計になっている:
//   1. retryClassify.ts    … 恒久的失敗としてリトライ対象から外す
//   2. Rust humanize_generation_failure … 生成経路のエラーを日本語化
//   3. humanizeError.ts    … フロントのトースト表示を日本語化 (このテストの主対象)
// 語彙がズレると「リトライしないのに英語のまま」等の中途半端な状態になるため、
// 1 と 3 の一致もここで固定する。

import { describe, expect, it } from "vitest";
import { humanizeError } from "../src/lib/humanizeError";
import { isPermanentFailure } from "../src/lib/scene/retryClassify";

/** Higgsfield MCP の job_status が返す `generation.error` を素通しした実際の形。 */
const RAW_CREDIT_ERRORS = [
  "not_enough_credits",
  "Generation failed: not enough credits",
  "insufficient_credits",
  "insufficient_quota",
  "You are out of credits",
  "クレジットが不足しています",
];

describe("humanizeError: クレジット不足", () => {
  it.each(RAW_CREDIT_ERRORS)("生エラー %s を日本語に変換する", (raw) => {
    const msg = humanizeError(raw);
    expect(msg).toContain("利用枠(クレジット)が不足");
    // 生の英語がそのままユーザーに出ていないこと。
    expect(msg).not.toContain("not_enough_credits");
    expect(msg).not.toContain("insufficient");
  });

  it("料金不安を煽らず、事実と選択肢だけを伝える", () => {
    const msg = humanizeError("not_enough_credits");
    // 「課金してください」と迫らない (#26「料金がわからなくて怖い」への配慮)。
    expect(msg).not.toContain("購入");
    expect(msg).not.toContain("課金");
    expect(msg).not.toContain("お支払い");
    // 3点書式: 起きたこと / データは無事か / 次の一手。
    expect(msg).toContain("残っています"); // データは無事
    expect(msg).toContain("設定 → アカウント"); // 次の一手
  });

  it("Error オブジェクトで渡されても拾う", () => {
    expect(humanizeError(new Error("not_enough_credits"))).toContain(
      "利用枠(クレジット)が不足",
    );
  });

  it("既存の権限エラー・不明ファイルの分岐を壊さない", () => {
    expect(humanizeError("fs.write_text_file not allowed")).toContain("保存先の権限");
    expect(humanizeError("ENOENT: no such file")).toContain("ファイルが見つかりません");
  });

  it("無関係なエラーはそのまま通す (原因究明のため)", () => {
    expect(humanizeError("なにか未知のエラー xyz")).toBe("なにか未知のエラー xyz");
  });
});

describe("語彙の整合: リトライ分類と表示が同じ語で判断する", () => {
  it.each(RAW_CREDIT_ERRORS)(
    "%s は恒久的失敗であり、かつ日本語化もされる",
    (raw) => {
      // リトライしても直らないと分類しているのに英語のまま出す、
      // という中途半端な状態を作らない。
      expect(isPermanentFailure(raw)).toBe(true);
      expect(humanizeError(raw)).toContain("利用枠(クレジット)が不足");
    },
  );
});
