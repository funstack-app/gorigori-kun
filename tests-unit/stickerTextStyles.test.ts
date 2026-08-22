import { describe, expect, it } from "vitest";

import {
  buildShoutBubblePoints,
  decorationFitsWithinMargin,
  defaultColorsForStickerTextStyle,
  layoutStickerDecoration,
  layoutStickerText,
  stickerTextVariant,
  STICKER_TEXT_SIZE_RATIOS,
  STICKER_TEXT_STYLE_PRESETS,
  textOutputPath,
} from "../src/lib/sticker/text";

describe("スタンプの文字スタイル5種", () => {
  it("決められた5種類を順番どおり持つ", () => {
    expect(STICKER_TEXT_STYLE_PRESETS.map((preset) => preset.label)).toEqual([
      "文字だけ（白フチ太文字）",
      "丸吹き出し",
      "角丸吹き出し",
      "叫び（トゲトゲ）",
      "下帯（テロップ風）",
    ]);
  });

  it("吹き出しは色を選ばなくても白地と黒文字で成立する", () => {
    for (const preset of STICKER_TEXT_STYLE_PRESETS.slice(1)) {
      const colors = defaultColorsForStickerTextStyle(preset.id);
      expect(colors.backgroundColor.toLowerCase()).toBe("#ffffff");
      expect(colors.color.toLowerCase()).toBe("#222222");
    }
    expect(defaultColorsForStickerTextStyle("outline").outlineColor).toBe("#ffffff");
  });

  it("入れ直した見た目が変わると保存先も変わり、サムネイルを更新できる", () => {
    const common = {
      fontFamily: "system-ui",
      sizeRatio: STICKER_TEXT_SIZE_RATIOS.medium,
      color: "#222222",
      backgroundColor: "#ffffff",
      outline: true,
      outlineColor: "#222222",
      position: "bottom" as const,
    };
    const round = stickerTextVariant({
      ...common,
      text: "ありがとう",
      styleId: "roundBubble",
    });
    const shout = stickerTextVariant({
      ...common,
      text: "ありがとう",
      styleId: "shoutBubble",
    });
    expect(round).not.toBe(shout);
    expect(textOutputPath("/tmp/01.png", round)).not.toBe(
      textOutputPath("/tmp/01.png", shout),
    );
    expect(textOutputPath("/tmp/01.png", round)).toMatch(/-text\.png$/);
  });
});

describe("吹き出しは文字に合わせつつ安全余白へ収まる", () => {
  const decoratedStyles = STICKER_TEXT_STYLE_PRESETS
    .map((preset) => preset.id)
    .filter((styleId) => styleId !== "outline");

  for (const styleId of decoratedStyles) {
    for (const position of ["top", "bottom"] as const) {
      it(`${styleId} / ${position} が余白から出ない`, () => {
        const layout = layoutStickerText(1024, 1024, {
          styleId,
          position,
          sizeRatio: STICKER_TEXT_SIZE_RATIOS.large,
        });
        const bounds = layoutStickerDecoration(1024, styleId, 460, layout);
        expect(bounds).not.toBeNull();
        expect(
          decorationFitsWithinMargin(1024, 1024, layout.marginPx, bounds),
        ).toBe(true);
      });
    }
  }

  it("短い言葉より長い言葉の吹き出しを大きくする", () => {
    const layout = layoutStickerText(1024, 1024, {
      styleId: "roundedBubble",
      position: "bottom",
      sizeRatio: STICKER_TEXT_SIZE_RATIOS.medium,
    });
    const short = layoutStickerDecoration(1024, "roundedBubble", 80, layout);
    const long = layoutStickerDecoration(1024, "roundedBubble", 420, layout);
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(long?.width ?? 0).toBeGreaterThan(short?.width ?? 0);
  });

  it("テロップ帯は安全域の横幅いっぱいにする", () => {
    const layout = layoutStickerText(1024, 1024, {
      styleId: "captionBand",
      position: "bottom",
      sizeRatio: STICKER_TEXT_SIZE_RATIOS.medium,
    });
    const bounds = layoutStickerDecoration(1024, "captionBand", 80, layout);
    expect(bounds?.x).toBe(layout.marginPx);
    expect(bounds?.width).toBe(1024 - layout.marginPx * 2);
  });

  it("叫びの外周は12個の山と谷を交互に作る", () => {
    const bounds = { x: 10, y: 20, width: 200, height: 100 };
    const points = buildShoutBubblePoints(bounds, 2, 12);
    expect(points).toHaveLength(24);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.x);
      expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  });
});
