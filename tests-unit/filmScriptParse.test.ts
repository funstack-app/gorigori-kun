import { describe, expect, it } from "vitest";

import {
  detectCharacterNameVariations,
  parseBlockScript,
  validateBeatsheetDuration,
  validateBlockDurationLimit,
  validateBlockSequence,
  validateForeshadowPairs,
  validateSceneDuration,
} from "../src/lib/film/scriptParse";
import type { FilmBlock, FilmScene } from "../src/lib/film/types";

const VALID_SCRIPT = `## S1 駅前広場 / 20s
### B1 (10s) 美咲が封筒を拾う
- 画: 雨上がりの広場と白い封筒
- 芝居: 美咲が立ち止まる。終わりの余白: 2秒
- セリフ: 美咲「これは…」
- 音: 遠い電車の音
- 伏線: F1 植込
### B2 (10s) 封筒を渡す
- 画: 美咲が少年へ封筒を差し出す
- 芝居: 少年が受け取り、二人が笑う。終わりの余白: 3秒
- セリフ: 少年「ありがとう」
- 音: 雨粒が止む
- 伏線: F1 回収`;

function block(id: string, durationSeconds = 10): FilmBlock {
  return {
    id,
    sceneId: "S1",
    durationSeconds,
    visual: "画",
    performance: "芝居",
    dialogue: "なし",
    sound: "音",
    foreshadowIds: [],
  };
}

describe("ブロック脚本パーサ", () => {
  it("強制書式を scenes / blocks 構造へ変換する", () => {
    const parsed = parseBlockScript(VALID_SCRIPT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.scenes).toEqual([
      expect.objectContaining({ id: "S1", location: "駅前広場", durationSeconds: 20 }),
    ]);
    expect(parsed.value.blocks).toHaveLength(2);
    expect(parsed.value.blocks[0]).toMatchObject({
      id: "B1",
      sceneId: "S1",
      durationSeconds: 10,
      foreshadowIds: ["F1"],
    });
  });

  it("壊れた行を黙って捨てず、失敗位置と理由を返す", () => {
    const broken = VALID_SCRIPT.replace("- 芝居:", "- 演技:");
    const parsed = parseBlockScript(broken);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    expect(parsed.error.line).toBe(4);
    expect(parsed.error.column).toBe(1);
    expect(parsed.error.sourceLine).toContain("演技");
    expect(parsed.error.reason).toContain("項目");
  });
});

describe("機械検算の牙", () => {
  it("拍/シーン秒数合計は不一致で発火し、一致または±10%内で発火しない", () => {
    expect(validateBeatsheetDuration("日常: 20秒\n事件: 20秒", 50)).toHaveLength(1);
    expect(validateBeatsheetDuration("日常: 20秒\n事件: 30秒", 50)).toHaveLength(0);

    const scenes: FilmScene[] = [
      { id: "S1", location: "駅", purpose: "出会う", characterNames: [], durationSeconds: 45 },
    ];
    expect(validateSceneDuration(scenes, 60)).toHaveLength(1);
    expect(validateSceneDuration(scenes, 50)).toHaveLength(0);
  });

  it("サービス上限超過だけを blocking で発火させる", () => {
    expect(validateBlockDurationLimit([block("B1", 26)], 25)).toEqual([
      expect.objectContaining({ code: "block-duration-limit", severity: "blocking" }),
    ]);
    expect(validateBlockDurationLimit([block("B1", 25)], 25)).toHaveLength(0);
  });

  it("B番号の非連番で発火し、連番では発火しない", () => {
    expect(validateBlockSequence([block("B1"), block("B3")])).toEqual([
      expect.objectContaining({ code: "block-sequence", location: "B3" }),
    ]);
    expect(validateBlockSequence([block("B1"), block("B2")])).toHaveLength(0);
  });

  it("登場人物名の1文字ゆれで発火し、正しい表記では発火しない", () => {
    expect(detectCharacterNameVariations("美崎が駅へ向かう。", ["美咲"])).toEqual([
      expect.objectContaining({ code: "character-name-variation", location: "美崎" }),
    ]);
    expect(detectCharacterNameVariations("美咲が駅へ向かう。", ["美咲"])).toHaveLength(0);
  });

  it("F番号の植込/回収欠落で発火し、対応していれば発火しない", () => {
    const missing = VALID_SCRIPT.replace("- 伏線: F1 回収", "- 伏線: なし");
    expect(validateForeshadowPairs(missing)).toEqual([
      expect.objectContaining({ code: "foreshadow-pair", location: "F1" }),
    ]);
    expect(validateForeshadowPairs(VALID_SCRIPT)).toHaveLength(0);
  });
});
