import { describe, expect, it } from "vitest";

import {
  VIDEO_MODELS,
  durationValuesForConstraint,
  intersectVideoModelCapabilities,
  videoModelCapabilities,
  type VideoModelCapabilities,
} from "../src/lib/videoModels";

describe("video model capabilities", () => {
  it("範囲と刻みから選べる秒数だけを作る", () => {
    expect(
      durationValuesForConstraint({
        kind: "integer",
        min: 4,
        max: 10,
        step: 2,
        default: 6,
      }),
    ).toEqual([4, 6, 8, 10]);
  });

  it("複数の内蔵モデルでは全モデル共通の尺と比率だけを残す", () => {
    const kling = videoModelCapabilities(VIDEO_MODELS[0]);
    const veo = videoModelCapabilities(VIDEO_MODELS[2]);
    const common = intersectVideoModelCapabilities([kling, veo]);

    expect(common.duration).toEqual({ kind: "enum", values: [4, 6, 8], default: 4 });
    expect(common.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(common.extraParams).toEqual([]);
  });

  it("仕様未取得の接続先を含むと偽の対応値を作らない", () => {
    const known = videoModelCapabilities(VIDEO_MODELS[0]);
    const unknown: VideoModelCapabilities = {
      duration: null,
      aspectRatios: null,
      extraParams: null,
    };
    const common = intersectVideoModelCapabilities([known, unknown]);

    expect(common.duration).toBeNull();
    expect(common.aspectRatios).toBeNull();
    expect(common.extraParams).toEqual([]);
  });
});
