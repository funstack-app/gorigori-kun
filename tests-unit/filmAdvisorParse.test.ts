import { describe, expect, it } from "vitest";

import {
  parseAdvisorResponse,
  parsePremiseFields,
} from "../src/lib/film/advisorParse";

describe("フィルムアドバイザー成果物パーサ", () => {
  it("地の文と正常な成果物フェンスを分ける", () => {
    const parsed = parseAdvisorResponse(`この方向がおすすめです。\n\n\`\`\`artifact:logline\n雨の駅で、少女が届かなかった手紙の持ち主を探す。\n\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.text).toBe("この方向がおすすめです。");
    expect(parsed.artifacts).toEqual([
      {
        type: "logline",
        content: "雨の駅で、少女が届かなかった手紙の持ち主を探す。",
      },
    ]);
  });

  it("閉じ忘れたフェンスを黙って捨てず、原文と壊れ状態を返す", () => {
    const raw = "案をまとめました。\n```artifact:treatment\n冒頭から結末まで";
    const parsed = parseAdvisorResponse(raw);

    expect(parsed.malformed).toBe(true);
    expect(parsed.error).toContain("開始と終了");
    expect(parsed.text).toBe(raw);
    expect(parsed.artifacts).toHaveLength(0);
  });

  it("premise の全角・半角コロンと箇条書きから key-value を抽出する", () => {
    const fields = parsePremiseFields(`タイトル：最後のバス\n- 目標尺: 90秒\n登場人物：美咲、少年\n題材: 届かなかった手紙`);

    expect(fields).toEqual({
      タイトル: "最後のバス",
      目標尺: "90秒",
      登場人物: "美咲、少年",
      題材: "届かなかった手紙",
    });
  });

  it("1つの返事にある複数成果物を出現順に返す", () => {
    const parsed = parseAdvisorResponse(`確認用です。\n\`\`\`artifact:logline\n一文のあらすじ\n\`\`\`\n次に流れです。\n\`\`\`artifact:beatsheet\n1. 日常: 10秒 — 朝を待つ\n\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.artifacts.map((artifact) => artifact.type)).toEqual([
      "logline",
      "beatsheet",
    ]);
    expect(parsed.text).toBe("確認用です。\n\n次に流れです。");
  });
});
