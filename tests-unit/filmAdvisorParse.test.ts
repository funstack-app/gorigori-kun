import { describe, expect, it } from "vitest";

import {
  parseAdvisorResponse,
  parsePremiseFields,
} from "../src/lib/film/advisorParse";
import { createFilmChatMessage } from "../src/lib/film/advisor";
import { buildFilmAdvisorPrompt } from "../src/lib/film/advisorPrompts";

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

  it("参照画像は会話へ保存し、文字専用経路では見たふりを禁止する", () => {
    const message = createFilmChatMessage("user", "この雰囲気で", [
      "/app-data/references/look.png",
    ]);
    expect(message.attachedImagePaths).toEqual(["/app-data/references/look.png"]);

    const prompt = buildFilmAdvisorPrompt({
      project: null,
      messages: [],
      userMessage: message.text,
      referenceImageCount: 1,
    });
    expect(prompt).toContain("この文字専用の会話経路には画像の内容が渡っていません");
    expect(prompt).toContain("画像を見た、確認した、読み取ったとは絶対に書かないでください");
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
