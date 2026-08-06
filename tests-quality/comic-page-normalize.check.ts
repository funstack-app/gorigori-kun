/**
 * 漫画ページ受領時正規化の純ロジック回帰。
 * canvasやTauriを起動せず、contain配置・警告・contentRectを固定する。
 */
import { expect, test } from "@playwright/test";

import {
  assertValidComicPageNormalizationPlan,
  COMIC_PAGE_NORMALIZE_TARGET,
  planComicPageNormalization,
} from "../src/lib/comic/pageNormalize";

test("規格は3:4 1080x1440・contain・白帯", () => {
  expect(COMIC_PAGE_NORMALIZE_TARGET).toEqual({
    width: 1080,
    height: 1440,
    mode: "contain",
    pad: "#ffffff",
  });
});

test("1086x1448は歪めず1080x1440へ縮小し、全面がcontentRect", () => {
  const plan = planComicPageNormalization(1086, 1448);
  expect(plan.targetWidth).toBe(1080);
  expect(plan.targetHeight).toBe(1440);
  expect(plan.scale).toBeCloseTo(1080 / 1086, 12);
  expect(plan.scale).toBeLessThanOrEqual(1);
  expect(plan.drawRect).toEqual({ x: 0, y: 0, w: 1080, h: 1440 });
  expect(plan.contentRect).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  expect(plan.aspectWarn).toBe(false);
});

test("1024x1536はcontain+左右対称の白帯で、入力比率を保つ", () => {
  const plan = planComicPageNormalization(1024, 1536);
  expect(plan.scale).toBe(0.9375);
  expect(plan.drawRect).toEqual({ x: 60, y: 0, w: 960, h: 1440 });
  expect(plan.contentRect.x).toBeCloseTo(100 / 18, 12);
  expect(plan.contentRect.y).toBe(0);
  expect(plan.contentRect.w).toBeCloseTo(800 / 9, 12);
  expect(plan.contentRect.h).toBe(100);
  expect(plan.drawRect.x).toBe(
    plan.targetWidth - plan.drawRect.x - plan.drawRect.w,
  );
  // 実pixelへ戻したcontent比率が入力の2:3と一致する＝非等方の歪みなし。
  const contentAspect =
    (plan.contentRect.w * plan.targetWidth) /
    (plan.contentRect.h * plan.targetHeight);
  expect(contentAspect).toBeCloseTo(1024 / 1536, 12);
  expect(plan.aspectWarn).toBe(false);
});

test("比率差15%超でも無変換にせず正規化し、aspectWarnを立てる", () => {
  const plan = planComicPageNormalization(2000, 1000);
  expect(plan.targetWidth).toBe(1080);
  expect(plan.targetHeight).toBe(1440);
  expect(plan.drawRect).toEqual({ x: 0, y: 450, w: 1080, h: 540 });
  expect(plan.contentRect).toEqual({ x: 0, y: 31.25, w: 100, h: 37.5 });
  expect(plan.aspectWarn).toBe(true);
});

test("小さい入力は拡大せず、原寸のまま中央へ置く", () => {
  const plan = planComicPageNormalization(540, 720);
  expect(plan.scale).toBe(1);
  expect(plan.drawRect).toEqual({ x: 270, y: 360, w: 540, h: 720 });
  expect(plan.contentRect).toEqual({ x: 25, y: 25, w: 50, h: 50 });
});

test("牙: 意図的な非対称帯は安全検査で拒否する", () => {
  const valid = planComicPageNormalization(1024, 1536);
  const broken = {
    ...valid,
    drawRect: { ...valid.drawRect, x: valid.drawRect.x + 1 },
  };
  expect(() => assertValidComicPageNormalizationPlan(broken)).toThrow(
    /非対称/,
  );
});

test("0や非数の入力寸法は正規化計画に入れない", () => {
  expect(() => planComicPageNormalization(0, 1440)).toThrow(/sourceWidth/);
  expect(() => planComicPageNormalization(1080, Number.NaN)).toThrow(
    /sourceHeight/,
  );
});
