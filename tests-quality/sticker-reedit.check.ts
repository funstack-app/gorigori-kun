/**
 * スタンプ個別編集（S3）の受入テスト。設計書 v3 §4.3 の T17〜T20 + ブラシマスクの二値化。
 *
 * ここで確かめるのは「スタンプ経路が共有層の安全弁をそのまま享受している」こと。
 * 共有層そのものの網羅テストは `panel-reedit.check.ts`（漫画側・41件）が持っており、
 * 移動後もそれが**無変更で全通する**ことで実体が1つであることを担保している（T12 / K5）。
 */
import { expect, test } from "@playwright/test";

import {
  compositePanelRgba,
  countMaskWhitePixels,
  countOutsideMaskDifferences,
  createPanelMaskRgba,
  isPanelReeditResizable,
  normalizeBrushMaskRgba,
  validatePanelPolygon,
  type RgbaRaster,
} from "../src/lib/imageReedit/maskReedit";
import {
  buildStickerReeditPrompt,
  buildStickerReeditRequest,
  fullFramePoints,
  STICKER_REEDIT_SOURCE_PREFIX,
} from "../src/lib/sticker/reedit";
import {
  CHROMA_BACKGROUND_CLAUSE,
  NO_TEXT_CLAUSE,
  STYLE_PRESERVATION_CLAUSE,
} from "../src/lib/sticker/promptStyles";
// 漫画側の import は「隣接制約の頂点変換が注入される」副作用そのものを検証に使う（T17b）。
import { validatePanelPolygon as comicValidatePolygon } from "../src/lib/comic/panelReedit";
import type { ComicPanelSlot } from "../src/lib/comic/layoutTemplates";

function raster(width: number, height: number, value: number): RgbaRaster {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(value) };
}

/** 指定 index の画素だけ白、他は黒の白黒不透明マスク。 */
function maskWithWhiteAt(width: number, height: number, whiteIndexes: number[]): RgbaRaster {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const value = whiteIndexes.includes(pixel) ? 255 : 0;
    const offset = pixel * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return { width, height, rgba };
}

/* ------------------------------------------------------------------ *
 * T17 — constraints を渡さなければ汎用の多角形バリデータとして動く
 * ------------------------------------------------------------------ */

test("T17: スタンプは隣接制約を渡さないので、多角形バリデータとしてそのまま通る", () => {
  // スタンプ1枚には隣のコマも枠線も無い。全面を覆う矩形が通らなければ機能が成立しない。
  expect(() => validatePanelPolygon(fullFramePoints())).not.toThrow();
  expect(() => validatePanelPolygon([
    { x: 20, y: 20 },
    { x: 80, y: 20 },
    { x: 80, y: 80 },
    { x: 20, y: 80 },
  ])).not.toThrow();

  // constraints を渡さなくても、多角形として壊れているものは従来どおり落ちる。
  expect(() => validatePanelPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toThrow("3点以上");
  expect(() => validatePanelPolygon([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ])).toThrow("小さすぎます");
  expect(() => validatePanelPolygon([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ])).toThrow("交差");
  expect(() => validatePanelPolygon([
    { x: -1, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ])).toThrow("外へ出せません");
});

test("T17b: 隣接制約を渡す経路は、変換器が登録済みなら従来どおり隣接判定が効く", () => {
  // 汎用層は ComicPanelSlot を知らないので、変換器は漫画側が起動時に注入する
  // （panelReedit.ts の setNeighborGuideResolver 呼び出し）。
  // ここでその注入を実際に効かせ、「constraints を渡したのに効いていない」という
  // 最も危険な壊れ方をしていないことを確かめる。
  //
  // 未注入時に throw する側は、注入がモジュール読み込みの副作用で起きる以上、
  // 同一プロセス内では再現できない（import 済みなら必ず登録される）。
  // したがってここでは**注入後に隣接判定が実際に働くこと**を証拠にする。
  const slots: ComicPanelSlot[] = [
    { x: 0, y: 0, w: 45, h: 100 },
    { x: 55, y: 0, w: 45, h: 100 },
  ];
  // 選択スロット(0)の内側 → 通る。
  expect(() =>
    comicValidatePolygon(
      [
        { x: 5, y: 5 },
        { x: 40, y: 5 },
        { x: 40, y: 95 },
        { x: 5, y: 95 },
      ],
      { selectedSlotIndex: 0, slots },
    ),
  ).not.toThrow();
  // 隣のスロット(1)へ食い込む → 落ちる。変換器が効いていなければここが素通りする。
  expect(() =>
    comicValidatePolygon(
      [
        { x: 5, y: 5 },
        { x: 90, y: 5 },
        { x: 90, y: 95 },
        { x: 5, y: 95 },
      ],
      { selectedSlotIndex: 0, slots },
    ),
  ).toThrow("隣のコマ");
});

/* ------------------------------------------------------------------ *
 * T18 — マスク外の改変を採用しない（この接続の一番の価値）
 * ------------------------------------------------------------------ */

test("T18: マスク外の画素が変わった生成画像は、スタンプでも throw して採用しない", () => {
  // 部分再生成でAIが画像全体を描き直して返すのは常態。
  // この関門が無いと「口だけ直したはずが顔が別人になった1枚」が採否リストへ黙って混ざる。
  const original = raster(3, 1, 10);
  const generated = raster(3, 1, 200);
  const mask = maskWithWhiteAt(3, 1, [1]);

  // 白は1画素だけ。そこだけ採用され、残り2画素は元のまま。
  const composite = compositePanelRgba(original, generated, mask);
  expect(composite.rgba[0]).toBe(10);
  expect(composite.rgba[4]).toBe(200);
  expect(composite.rgba[8]).toBe(10);
  expect(countOutsideMaskDifferences(original, composite, mask)).toBe(0);

  // マスク外が動いた合成結果は、検証側が必ず件数を数え上げる。
  const tampered: RgbaRaster = { ...composite, rgba: new Uint8ClampedArray(composite.rgba) };
  tampered.rgba[0] = 99;
  expect(countOutsideMaskDifferences(original, tampered, mask)).toBe(1);

  // マスクが全黒（＝どこも編集許可していない）なら、AI出力は1画素も採用されない。
  const allBlack = maskWithWhiteAt(3, 1, []);
  const untouched = compositePanelRgba(original, generated, allBlack);
  expect(Array.from(untouched.rgba)).toEqual(Array.from(original.rgba));
});

test("T18b: アルファだけが違う生成画像もマスク外差分として数える（透過スタンプの要）", () => {
  // スタンプは透過が命。RGBが同じでもアルファが動けば「抜けが変わった」ことになる。
  // 3チャンネルしか見ない実装だとここを見逃す。
  const width = 2;
  const original: RgbaRaster = { width, height: 1, rgba: new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255]) };
  const alphaOnly: RgbaRaster = { width, height: 1, rgba: new Uint8ClampedArray([10, 10, 10, 0, 10, 10, 10, 255]) };
  const mask = maskWithWhiteAt(width, 1, []);
  expect(countOutsideMaskDifferences(original, alphaOnly, mask)).toBe(1);
});

/* ------------------------------------------------------------------ *
 * T19 / T20 — 量子化寸法の救済と、比率違いの不採用
 * ------------------------------------------------------------------ */

test("T19/T20: スタンプ寸法でも、比率一致は救済し比率違いは不採用にする", () => {
  // スタンプは 370x320 を指定しても、AIは量子化寸法で返す（normalize.rs の実測と同型）。
  // 比率が合っていれば同じ絵なので救済する。
  expect(isPanelReeditResizable({ width: 370, height: 320 }, { width: 740, height: 640 })).toBe(true);
  expect(isPanelReeditResizable({ width: 370, height: 320 }, { width: 1110, height: 960 })).toBe(true);

  // T20: 比率が違う＝別の絵。救済しない。
  expect(isPanelReeditResizable({ width: 370, height: 320 }, { width: 1024, height: 1024 })).toBe(false);
  expect(isPanelReeditResizable({ width: 370, height: 320 }, { width: 320, height: 370 })).toBe(false);
});

/* ------------------------------------------------------------------ *
 * ブラシ由来マスクの二値化（MaskCanvas と共有層の実装差を埋める橋）
 * ------------------------------------------------------------------ */

test("ブラシマスクの白 on 透明を、白黒不透明へ二値化する", () => {
  // MaskCanvas.toBlob() は「塗った所だけ白・他は透明」を返す。
  // 共有層は R チャンネルだけで白黒を判定するため、
  // アンチエイリアスの縁（R が 1〜254）が「0 でない＝白」と誤判定される。
  const width = 4;
  const brush: RgbaRaster = {
    width,
    height: 1,
    rgba: new Uint8ClampedArray([
      0, 0, 0, 0,        // 未塗り（透明）→ 黒
      255, 255, 255, 255, // 塗り（不透明白）→ 白
      255, 255, 255, 60,  // 縁（白いがほぼ透明）→ 黒へ倒す
      200, 200, 200, 255, // 半端に濃い塗り（しきい値以上）→ 白
    ]),
  };
  const normalized = normalizeBrushMaskRgba(brush);

  expect(Array.from(normalized.rgba.slice(0, 4))).toEqual([0, 0, 0, 255]);
  expect(Array.from(normalized.rgba.slice(4, 8))).toEqual([255, 255, 255, 255]);
  expect(Array.from(normalized.rgba.slice(8, 12))).toEqual([0, 0, 0, 255]);
  expect(Array.from(normalized.rgba.slice(12, 16))).toEqual([255, 255, 255, 255]);

  // 二値化後は全画素のアルファが 255。共有層の4チャンネル差分検証が成立する前提。
  for (let offset = 3; offset < normalized.rgba.length; offset += 4) {
    expect(normalized.rgba[offset]).toBe(255);
  }

  expect(countMaskWhitePixels(normalized)).toBe(2);
  expect(countMaskWhitePixels(maskWithWhiteAt(4, 1, []))).toBe(0);
});

test("二値化を通したブラシマスクは、マスク外差分ゼロ検証をそのまま満たす", () => {
  // 縁が二値化されていないと、compositePanelRgba が半端な縁まで AI 出力を採用し、
  // countOutsideMaskDifferences が「白でない画素が動いた」として throw する。
  const width = 3;
  const fuzzy: RgbaRaster = {
    width,
    height: 1,
    rgba: new Uint8ClampedArray([
      0, 0, 0, 0,
      255, 255, 255, 255,
      90, 90, 90, 120, // 中途半端な縁
    ]),
  };
  const mask = normalizeBrushMaskRgba(fuzzy);
  const original = raster(width, 1, 10);
  const generated = raster(width, 1, 200);

  const composite = compositePanelRgba(original, generated, mask);
  expect(composite.rgba[0]).toBe(10);   // 未塗り → 元のまま
  expect(composite.rgba[4]).toBe(200);  // 塗り   → AI 出力
  expect(composite.rgba[8]).toBe(10);   // 縁     → 黒へ倒れたので元のまま
  expect(countOutsideMaskDifferences(original, composite, mask)).toBe(0);
});

/* ------------------------------------------------------------------ *
 * 生成リクエストの形（count:1 / 元画像が第1参照 / マスクがその対）
 * ------------------------------------------------------------------ */

test("スタンプ個別編集のリクエストは count:1 で、元画像とマスクを対で固定する", () => {
  const request = buildStickerReeditRequest(
    "指を5本にする",
    "/tmp/sticker/01.png",
    "/tmp/sticker/.masks/01.png",
    ["/tmp/ref/character.png"],
    `${STICKER_REEDIT_SOURCE_PREFIX}-1-1`,
  );

  expect(request.count).toBe(1);
  // 元画像が第1参照で、マスクは同 index に置かれる（参照側のマスクは空文字）。
  expect(request.refImagePaths).toEqual(["/tmp/sticker/01.png", "/tmp/ref/character.png"]);
  expect(request.maskPaths).toEqual(["/tmp/sticker/.masks/01.png", ""]);
  expect(request.sourceTag).toBe(`${STICKER_REEDIT_SOURCE_PREFIX}-1-1`);
  // 元画像とマスクの実寸が正なので、規格寸法を焼く aspect は渡さない。
  expect(request).not.toHaveProperty("aspect");
  expect(request).not.toHaveProperty("enforceAspect");
});

test("個別編集の指示文は、共通句を再掲せず promptStyles の同じ定数を使う", () => {
  // 個別編集だけ別文言にすると、直した1枚だけ絵柄や背景が割れる。
  const prompt = buildStickerReeditPrompt("口を閉じる");
  expect(prompt).toContain("口を閉じる");
  expect(prompt).toContain("Keep every pixel outside the white mask unchanged");
  expect(prompt).toContain(STYLE_PRESERVATION_CLAUSE);
  expect(prompt).toContain(CHROMA_BACKGROUND_CLAUSE);
  expect(prompt).toContain(NO_TEXT_CLAUSE);

  // 指示が空でも破綻修正の既定文で成立する（生成を止めない）。
  const fallback = buildStickerReeditPrompt("   ");
  expect(fallback).toContain("Fix the anatomy and rendering errors inside the masked area");
  expect(fallback).toContain(STYLE_PRESERVATION_CLAUSE);
});

/* ------------------------------------------------------------------ *
 * K5 — マスク合成の実装が1箇所にしかない
 * ------------------------------------------------------------------ */

test("K5: 全面矩形からもマスクを作れる（多角形経路が汎用層で生きている）", () => {
  const mask = createPanelMaskRgba(20, 20, fullFramePoints(), 2);
  // 枠線保護余白ぶん縁は黒のまま。中央は白。
  const centerOffset = (10 * 20 + 10) * 4;
  expect(mask[centerOffset]).toBe(255);
  expect(mask[0]).toBe(0);
});
