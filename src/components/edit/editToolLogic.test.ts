import { describe, expect, it } from "vitest";

import {
  buildRestylePrompt,
  closestMagnificAspect,
  snapLightAzimuth,
  snapLightElevation,
} from "./editToolLogic";

describe("編集ツールの純粋な値変換", () => {
  it("ライト角度をMagnificの8方位・5段へ吸着する", () => {
    expect(snapLightAzimuth(14)).toBe(0);
    expect(snapLightAzimuth(70)).toBe(90);
    expect(snapLightAzimuth(-172)).toBe(180);
    expect(snapLightAzimuth(225)).toBe(-135);
    expect(snapLightElevation(63)).toBe(45);
    expect(snapLightElevation(-80)).toBe(-90);
  });

  it("リスタイル指示を構図維持の定型文で包む", () => {
    expect(buildRestylePrompt("  clean watercolor style  ")).toBe(
      "Restyle this exact image in clean watercolor style. Keep the composition, subjects and framing identical.",
    );
  });

  it("元画像へ最も近いMagnific対応比率を選ぶ", () => {
    expect(closestMagnificAspect(1920, 1080)).toBe("16:9");
    expect(closestMagnificAspect(1000, 1400)).toBe("3:4");
    expect(closestMagnificAspect(0, 0)).toBe("1:1");
  });
});
