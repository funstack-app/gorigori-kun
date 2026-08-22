import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Preset } from "../src/lib/store/presets";
import {
  characterPromptText,
  composePresetPrompt,
  selectCharacterReferences,
} from "../src/lib/presets/character";

function preset(overrides: Partial<Preset>): Preset {
  return {
    id: "preset-1",
    name: "人物A",
    prompt: "Extreme low-angle portrait, dramatic lighting",
    categoryId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("キャラ参照は画像だけを渡す", () => {
  it("キャラの属性と保存プロンプトを生成文へ注入せず、参照画像は残す", () => {
    const character = preset({
      kind: "character",
      characterMeta: {
        attributes: "黒髪、青い瞳、白いコート",
      },
      attachedImages: [
        { path: "/characters/a-front.png", role: "subject" },
        { path: "/characters/a-face.png", role: "subject" },
      ],
    });

    expect(characterPromptText(character)).toBeUndefined();
    expect(composePresetPrompt(character)).toBe("");
    expect(selectCharacterReferences(character).map((ref) => ref.path)).toEqual([
      "/characters/a-front.png",
      "/characters/a-face.png",
    ]);
  });

  it("通常のプロンプト型プリセットはこれまでどおり本文を返す", () => {
    const promptPreset = preset({ kind: "prompt", prompt: "  soft daylight  " });
    expect(composePresetPrompt(promptPreset)).toBe("soft daylight");
  });

  it("シーン再現は選択キャラの画像だけを制作処理へ渡す", () => {
    const source = readFileSync(
      resolve("src/components/skills/sceneRecreate/SceneRecreateWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("selectCharacterReferences(next)");
    expect(source).toContain("composer.addReferences(references as Reference[])");
    expect(source).toContain("キャラの説明文は自動で足しません");
  });

  it("縦長のシート見本は黒地に全体表示する", () => {
    const source = readFileSync(
      resolve("src/components/skills/character/SheetTemplatePickerModal.tsx"),
      "utf8",
    );

    expect(source).toContain("aspect-video w-full bg-black");
    expect(source).toContain('className="h-full w-full object-contain"');
    expect(source).not.toContain('className="h-full w-full object-cover"');
  });
});
