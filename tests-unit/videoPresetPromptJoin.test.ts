import { describe, expect, it } from "vitest";

import { appendPresetPrompt } from "../src/lib/presets/character";
import type { Preset } from "../src/lib/store/presets";

function preset(kind: "character" | "prompt", prompt: string): Preset {
  return {
    id: "preset-1",
    name: "人物A",
    prompt,
    kind,
    categoryId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("動画プロンプトへのプリセット追加", () => {
  it("本文が空のキャラプリセットでは末尾に区切り文字を足さない", () => {
    expect(appendPresetPrompt("駅前を歩く", preset("character", "保存済み説明"))).toBe(
      "駅前を歩く",
    );
  });

  it("通常プリセットはこれまでどおり区切って追加する", () => {
    expect(appendPresetPrompt("駅前を歩く", preset("prompt", "  夕暮れ  "))).toBe(
      "駅前を歩く, 夕暮れ",
    );
  });
});
