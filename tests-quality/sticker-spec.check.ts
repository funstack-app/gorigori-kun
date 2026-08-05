/**
 * LINEスタンプのデータ層（spec / catalog / promptStyles / exportNaming）の回帰。
 * ブラウザ不要の純ロジック検査。
 *
 * 検査の芯は4つ:
 *  1) 規格の数値が一次情報どおりに焼かれていること（書き換え事故の検知）
 *  2) カタログが「選んだ枚数だけ先頭から採る」規則を守り、最大枚数40を賄えること
 *  3) 書き味2実装が**共通句を必ず持つ**こと（実験を成立させる構造制約・設計書 §1.7）
 *  4) sticker 命名が連番だけを返し、既存4styleを壊していないこと
 */
import { expect, test } from "@playwright/test";

import { buildExportFileName, type NamingStyle } from "../src/lib/exportNaming";
import {
  DEFAULT_STICKER_TONE,
  STICKER_CATALOGS,
  getStickerCatalog,
  pickEntries,
  type StickerToneId,
} from "../src/lib/sticker/catalog";
import {
  CHROMA_BACKGROUND_CLAUSE,
  DEFAULT_PROMPT_STYLE,
  FRINGE_PREVENTION_CLAUSE,
  NO_TEXT_CLAUSE,
  STICKER_PROMPT_STYLES,
  STYLE_PRESERVATION_CLAUSE,
  buildStickerPrompt,
  getPromptStyle,
} from "../src/lib/sticker/promptStyles";
import {
  DEFAULT_STICKER_COUNT,
  MAX_BYTES_PER_IMAGE,
  MAX_BYTES_TOTAL,
  MIN_INK_RATIO,
  NORMAL_STICKER_SPEC,
  STICKER_BATCH_MAX_CUTS,
  STICKER_COUNTS,
  STICKER_SPECS,
  isValidStickerCount,
  splitIntoBatches,
} from "../src/lib/sticker/spec";

/* ---------------------------------------------------------------- *
 * 1. 規格の数値（一次情報の固定）
 * ---------------------------------------------------------------- */

test("通常スタンプの規格が一次情報どおり（370×320 / 余白10px / 240×240 / 96×74）", () => {
  expect(NORMAL_STICKER_SPEC.maxWidth).toBe(370);
  expect(NORMAL_STICKER_SPEC.maxHeight).toBe(320);
  expect(NORMAL_STICKER_SPEC.padding).toBe(10);
  expect(NORMAL_STICKER_SPEC.mainImage).toEqual({ width: 240, height: 240 });
  expect(NORMAL_STICKER_SPEC.tabImage).toEqual({ width: 96, height: 74 });
  expect(NORMAL_STICKER_SPEC.implemented).toBe(true);
});

test("容量上限は 1MB / 60MB のバイト値ちょうど", () => {
  expect(MAX_BYTES_PER_IMAGE).toBe(1024 * 1024);
  expect(MAX_BYTES_TOTAL).toBe(60 * 1024 * 1024);
  expect(NORMAL_STICKER_SPEC.maxBytesPerImage).toBe(MAX_BYTES_PER_IMAGE);
  expect(NORMAL_STICKER_SPEC.maxBytesTotal).toBe(MAX_BYTES_TOTAL);
});

test("枚数は 8/16/24/32/40 の5択。既定は16", () => {
  expect([...STICKER_COUNTS]).toEqual([8, 16, 24, 32, 40]);
  expect(DEFAULT_STICKER_COUNT).toBe(16);
  expect(isValidStickerCount(16)).toBe(true);
  // 5択にない値は弾く（層A D10）。
  expect(isValidStickerCount(20)).toBe(false);
  expect(isValidStickerCount(0)).toBe(false);
});

test("余白ポリシーがカテゴリ間で真逆であること（共通化事故の検知・設計書 §3）", () => {
  // 通常だけ余白必須。絵文字は全面配置、BIGはシステムが自動付与するので付けない。
  expect(STICKER_SPECS.normal.padding).toBe(10);
  expect(STICKER_SPECS.emoji.padding).toBe(0);
  expect(STICKER_SPECS.big.padding).toBe(0);
  // v1 で実装するのは通常のみ。
  expect(STICKER_SPECS.emoji.implemented).toBe(false);
  expect(STICKER_SPECS.big.implemented).toBe(false);
});

test("MIN_INK_RATIO は暫定値として存在し、境界値が判定できる（層A D13）", () => {
  expect(MIN_INK_RATIO).toBe(0.03);
  // 境界: ちょうどは満たす、わずかに下回れば警告対象。
  expect(0.03 >= MIN_INK_RATIO).toBe(true);
  expect(0.0299 >= MIN_INK_RATIO).toBe(false);
});

/* ---------------------------------------------------------------- *
 * 2. バッチ分割（波はUIに出さない・設計書 §1.2）
 * ---------------------------------------------------------------- */

test("全枚数が MAX_SHEET_CUTS(30) 未満のバッチへ分割され、合計が一致する", () => {
  for (const count of STICKER_COUNTS) {
    const batches = splitIntoBatches(count);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(count);
    for (const b of batches) {
      expect(b).toBeLessThanOrEqual(STICKER_BATCH_MAX_CUTS);
      expect(b).toBeLessThan(30); // character_sheet.rs の MAX_SHEET_CUTS
      expect(b).toBeGreaterThan(0);
    }
  }
});

test("24枚以下は1バッチ、32/40は2バッチへ均等に割れる", () => {
  expect(splitIntoBatches(8)).toEqual([8]);
  expect(splitIntoBatches(16)).toEqual([16]);
  expect(splitIntoBatches(20)).toEqual([20]);
  // 端数を最後へ寄せず均等に割る（24 → 12+12、40 → 20+20）。
  expect(splitIntoBatches(24)).toEqual([12, 12]);
  expect(splitIntoBatches(32)).toEqual([16, 16]);
  expect(splitIntoBatches(40)).toEqual([20, 20]);
});

test("splitIntoBatches は不正入力で空を返す（例外を投げない）", () => {
  expect(splitIntoBatches(0)).toEqual([]);
  expect(splitIntoBatches(-5)).toEqual([]);
  expect(splitIntoBatches(10, 0)).toEqual([]);
});

/* ---------------------------------------------------------------- *
 * 3. カタログ（4プリセット・実測に全員を寄せない）
 * ---------------------------------------------------------------- */

const ALL_TONES: StickerToneId[] = ["basic", "playful", "polite", "reaction"];

test("4プリセットが揃い、既定は basic", () => {
  expect(STICKER_CATALOGS.map((c) => c.id)).toEqual(ALL_TONES);
  expect(DEFAULT_STICKER_TONE).toBe("basic");
});

test("全プリセットが最大枚数40を賄える（40件以上持つ）", () => {
  const maxCount = Math.max(...STICKER_COUNTS);
  for (const catalog of STICKER_CATALOGS) {
    expect(catalog.entries.length).toBeGreaterThanOrEqual(maxCount);
  }
});

test("全プリセットで entry の id / role が一意（出力ファイル名の衝突防止）", () => {
  for (const catalog of STICKER_CATALOGS) {
    const ids = catalog.entries.map((e) => e.id);
    const roles = catalog.entries.map((e) => e.role);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(roles).size).toBe(roles.length);
    // 他スキル（expr- 等）と衝突しない接頭辞。
    for (const id of ids) expect(id.startsWith("stk-")).toBe(true);
  }
});

test("pickEntries は先頭から選んだ枚数だけ採る（配分テンプレを持たない）", () => {
  for (const tone of ALL_TONES) {
    const catalog = getStickerCatalog(tone)!;
    for (const count of STICKER_COUNTS) {
      const picked = pickEntries(tone, count);
      expect(picked.length).toBe(count);
      // 並び順そのものが配分。先頭から順に一致する。
      expect(picked.map((e) => e.id)).toEqual(
        catalog.entries.slice(0, count).map((e) => e.id),
      );
    }
  }
});

test("pickEntries はエントリ数を超える要求で黙って足さない（欠落を可視化する）", () => {
  const catalog = getStickerCatalog("basic")!;
  const picked = pickEntries("basic", catalog.entries.length + 50);
  expect(picked.length).toBe(catalog.entries.length);
});

test("promptFragment に文字・吹き出しを描かせる指示が含まれない（設計書 §1.3）", () => {
  // セリフは label に持つが、プロンプトへは渡さない。日本語がそのまま混ざっていたら
  // 「文字を焼き込ませる」経路が生まれた合図。
  for (const catalog of STICKER_CATALOGS) {
    for (const entry of catalog.entries) {
      expect(entry.promptFragment).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(entry.promptFragment.toLowerCase()).not.toContain("speech bubble");
      expect(entry.promptFragment.toLowerCase()).not.toContain("text saying");
    }
  }
});

/* ---------------------------------------------------------------- *
 * 4. 書き味（実験を成立させる構造制約・設計書 §1.7）
 * ---------------------------------------------------------------- */

test("書き味は2実装。既定は spec（暫定）", () => {
  expect(STICKER_PROMPT_STYLES.map((s) => s.id).sort()).toEqual(["emotive", "spec"]);
  expect(DEFAULT_PROMPT_STYLE).toBe("spec");
  // 既定IDは必ず実装として存在する（存在しないIDを既定に置く事故の検知）。
  expect(getPromptStyle(DEFAULT_PROMPT_STYLE)).toBeDefined();
});

test("両スタイルが共通句（画風保持・緑背景・フリンジ予防・文字なし）を必ず含む", () => {
  // 制約2・3: 共通句が片方にしか無いと、比較しているのが書き味でなくなる。
  for (const style of STICKER_PROMPT_STYLES) {
    const prompt = style.build({ promptFragment: "waving one hand" });
    expect(prompt).toContain(STYLE_PRESERVATION_CLAUSE);
    expect(prompt).toContain(CHROMA_BACKGROUND_CLAUSE);
    expect(prompt).toContain(FRINGE_PREVENTION_CLAUSE);
    expect(prompt).toContain(NO_TEXT_CLAUSE);
  }
});

test("両スタイルは共通句以外の部分で実際に異なる（データが同一の張りぼてでない）", () => {
  const input = { promptFragment: "waving one hand" };
  const emotive = getPromptStyle("emotive")!.build(input);
  const spec = getPromptStyle("spec")!.build(input);
  expect(emotive).not.toBe(spec);
  // 共通句を差し引いても差分が残る＝書き味そのものが違う。
  const strip = (p: string) =>
    [STYLE_PRESERVATION_CLAUSE, CHROMA_BACKGROUND_CLAUSE, FRINGE_PREVENTION_CLAUSE, NO_TEXT_CLAUSE]
      .reduce((acc, clause) => acc.replace(clause, ""), p);
  expect(strip(emotive)).not.toBe(strip(spec));
});

test("緑背景の値が Rust 側 COMPOSITE_SHEET_BG_LINE_GREEN と同じ色指定を持つ", () => {
  expect(CHROMA_BACKGROUND_CLAUSE).toContain("#00FF00");
  expect(CHROMA_BACKGROUND_CLAUSE).toContain("RGB 0,255,0");
  expect(CHROMA_BACKGROUND_CLAUSE).toContain("evenly lit");
});

test("promptFragment と attributes がプロンプトへ反映される", () => {
  const prompt = buildStickerPrompt("spec", {
    promptFragment: "grateful happy expression",
    attributes: "short black hair, red hoodie",
  });
  expect(prompt).toContain("grateful happy expression");
  expect(prompt).toContain("short black hair, red hoodie");
});

test("attributes 未指定でも区切りが崩れない（空要素を落とす）", () => {
  const prompt = buildStickerPrompt("spec", { promptFragment: "waving one hand" });
  expect(prompt).not.toContain(", ,");
  expect(prompt.startsWith(",")).toBe(false);
  expect(prompt.endsWith(",")).toBe(false);
});

test("未知のスタイルIDは既定へ落ちて生成を止めない", () => {
  const fallback = buildStickerPrompt("nope" as never, { promptFragment: "waving one hand" });
  const expected = buildStickerPrompt(DEFAULT_PROMPT_STYLE, { promptFragment: "waving one hand" });
  expect(fallback).toBe(expected);
});

/* ---------------------------------------------------------------- *
 * 5. 命名（連番の完全性）
 * ---------------------------------------------------------------- */

test("sticker 命名はゼロ埋め2桁の連番だけを返す", () => {
  expect(buildExportFileName({ style: "sticker", index: 1, ext: "png" })).toBe("01.png");
  expect(buildExportFileName({ style: "sticker", index: 9, ext: "png" })).toBe("09.png");
  expect(buildExportFileName({ style: "sticker", index: 40, ext: "png" })).toBe("40.png");
});

test("sticker 命名は prefix / role / version を無視する（連番の完全性を守る）", () => {
  // 他styleでは名前に載るものが、stickerでは一切載らない。
  const name = buildExportFileName({
    style: "sticker",
    prefix: "PJ01",
    role: "笑顔",
    version: 3,
    index: 7,
    ext: "png",
  });
  expect(name).toBe("07.png");
});

test("sticker 命名は digits 明示で桁数を変えられる（将来拡張）", () => {
  expect(buildExportFileName({ style: "sticker", index: 7, digits: 3, ext: "png" })).toBe("007.png");
});

test("既存4styleの挙動が変わっていない（回帰）", () => {
  const cases: Array<[NamingStyle, string]> = [
    ["sequence", "PJ01_C001_front.png"],
    ["sku", "PJ01_01_front.png"],
    ["asset", "PJ01_front_001.png"],
    ["plain", "PJ01_front_001.png"],
  ];
  for (const [style, expected] of cases) {
    expect(
      buildExportFileName({ style, prefix: "PJ01", role: "正面", index: 1, ext: "png" }),
    ).toBe(expected);
  }
  // version は既存styleでは従来どおり付く（sticker だけが例外）。
  expect(
    buildExportFileName({ style: "asset", prefix: "yuki", role: "正面", version: 2, ext: "png" }),
  ).toBe("yuki_front_v2.png");
});
