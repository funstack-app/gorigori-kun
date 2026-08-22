import { describe, expect, it } from "vitest";

import {
  IDENTITY_5VIEW_PROMPT_TEMPLATE,
  buildIdentity5ViewPrompt,
  deserializeUserSheetTemplates,
  serializeUserSheetTemplates,
  type UserSheetTemplate,
} from "../src/lib/character/sheetTemplates";

describe("首なし5面図の正典テンプレート", () => {
  it("外してはいけない5点の必須句を省略していない", () => {
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).toContain(
      "この2体で扱いが違う。両方とも切るのは誤り。背面を切ってはならない。",
    );
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).toContain(
      "上端は鎖骨から肩のライン。そこから上はフレームの外にあって写っていない。",
    );
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).toContain(
      "この1枚には、ただ1人の人物だけを描く。",
    );
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).toContain(
      "16:9 aspect ratio, high quality",
    );
  });

  it("参照画像の人物を変えず、新規キャスティングを指示しない", () => {
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).not.toContain("参照画像なし");
    expect(IDENTITY_5VIEW_PROMPT_TEMPLATE).toContain(
      "添付の参照画像の人物と完全に同一人物として描く。顔立ち・髪・体格を参照から変えない。",
    );
  });

  it("登録フォームの名前と属性で記入穴を埋める", () => {
    const prompt = buildIdentity5ViewPrompt({
      name: "山田ハル / HARU YAMADA",
      attributes: "42歳の日本人男性、短い黒髪、身長175cm、紺色の作業着",
    });

    expect(prompt).toContain("山田ハル / HARU YAMADA / CHARACTER IDENTITY SHEET");
    expect(prompt).toContain("NAME: 山田ハル / HARU YAMADA");
    expect(prompt).toContain("42歳の日本人男性、短い黒髪、身長175cm、紺色の作業着");
    expect(prompt).not.toContain("【年齢】");
    expect(prompt).not.toContain("【最重要ディテール】");
    // 見出しとして使う【】は記入穴ではないため、そのまま保つ。
    expect(prompt).toContain("【CHARACTER DESIGN】");
  });
});

describe("ユーザーシートテンプレートの保存形式", () => {
  it("シリアライズして読み戻しても内容が変わらない", () => {
    const templates: UserSheetTemplate[] = [
      {
        id: "sheet-template-test",
        name: "自分の3面図",
        prompt: "【キャラクター名】を【特徴】のまま3方向から描く",
        createdAt: 1_787_315_200_000,
      },
    ];

    expect(deserializeUserSheetTemplates(serializeUserSheetTemplates(templates))).toEqual(
      templates,
    );
  });
});
