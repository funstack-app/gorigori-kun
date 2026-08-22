import { describe, expect, it } from "vitest";

import {
  appendVideoGenerationRevision,
  buildVideoGenerationPrompt,
  VIDEO_GENERATION_ABSOLUTE_RULES,
} from "../src/lib/film/videoGenPrompts";

describe("動画生成の3層合成プロンプト", () => {
  it("設計、決定版アセット、1ブロック台本を絶対規律付きで順番固定する", () => {
    const prompt = buildVideoGenerationPrompt({
      title: "春の駅",
      theme: "言えなかった気持ちを渡す",
      lookDescription: "静かな実写映画。自然光と長めの間を保つ。",
      lookMasterPath: "/film/look.png",
      stylePrefix: "同じレンズ感と現実的な質感を保つ。",
      sceneId: "S1",
      sceneLocation: "駅前広場",
      block: {
        id: "B1",
        sceneId: "S1",
        durationSeconds: 8,
        visual: "改札前で文子が封筒を握る",
        performance: "一度息を止め、顔を上げる。終わりの余白: 2秒",
        dialogue: "文子『これ、読んで』",
        sound: "朝の電車、靴音",
        foreshadowIds: [],
      },
      assets: [
        {
          id: "CH-01",
          name: "文子",
          type: "character",
          prompt: "肩までの黒髪。紺のコート。",
          referencePath: "/film/fumiko.png",
        },
      ],
      referenceNotation: "`@Image N`で役割を名指しする",
    });

    expect(prompt.indexOf("# ① 設計の決定事項")).toBeLessThan(prompt.indexOf("# ② 登場アセットの決定版"));
    expect(prompt.indexOf("# ② 登場アセットの決定版")).toBeLessThan(prompt.indexOf("# ③ この1ブロックの台本"));
    expect(prompt).toContain("CH-01 文子（character）");
    expect(prompt).toContain("参照画像1: /film/fumiko.png");
    expect(prompt).toContain("S1/B1 / 8秒");
    expect(prompt).toContain("画: 改札前で文子が封筒を握る");
    expect(prompt).toContain("芝居: 一度息を止め、顔を上げる。終わりの余白: 2秒");
    for (const rule of VIDEO_GENERATION_ABSOLUTE_RULES) expect(prompt).toContain(rule);
    expect(prompt).toContain("文字やロゴの生成を指示しない");
    expect(prompt).toContain("色は仕上げで一括調整する");
    expect(prompt).toMatch(/# 全動画に共通する見た目の固定文（末尾固定）\n同じレンズ感と現実的な質感を保つ。$/u);
  });

  it("アセットがないブロックも推測で補わない", () => {
    const prompt = buildVideoGenerationPrompt({
      title: "無人駅",
      theme: "余白",
      stylePrefix: "固定されたカメラ。",
      sceneId: "S2",
      block: {
        id: "B2",
        sceneId: "S2",
        durationSeconds: 5,
        visual: "空のホーム",
        performance: "なし",
        dialogue: "なし",
        sound: "風",
        foreshadowIds: [],
      },
      assets: [],
    });
    expect(prompt).toContain("このブロックに登録された決定版アセットはなし。");
  });

  it("NG理由を空のまま再生成せず、理由を次のプロンプトへ残す", () => {
    expect(() => appendVideoGenerationRevision("元の指示", "  ")).toThrow("やり直す理由");
    expect(appendVideoGenerationRevision("元の指示", "顔が途中で別人になった")).toBe(
      "元の指示\n\n# 前回の不採用理由と今回の修正\n- 前回の問題: 顔が途中で別人になった\n- この問題を直し、それ以外の確定事項は変えない。",
    );
  });
});
