/**
 * スケッチパッドの「出口プリセット」定義。
 *
 * ここが規定プロンプトの**単一正本**。SketchPadModal と (Slice D の) 共通ブリッジ
 * が同じ定義を import する。プリセット追加は配列に1件足すだけで済ませる
 * (コード分岐を増やさない = キャラシート背景4択と同じ規定プロンプト差し替え方式)。
 *
 * プロンプトが英語なのは、生成経路 (PromptComposer の buildGoriPrompt) が全編
 * 英語プロンプト前提のため。
 */

/** ブロックアウト正規化 i2i の規定プロンプト (設計書 §1 論点1 の確定文言)。 */
export const BLOCKOUT_PRESET_PROMPT = [
  "Reconstruct the attached image as a Blender-style 3D blockout (greybox) scene render.",
  "Use the input strictly as a layout blueprint: preserve the composition, camera angle,",
  "perspective, subject poses, and object placement exactly as shown.",
  "Rules:",
  "- Every object becomes a simple primitive volume (box, cylinder, sphere, plane) in",
  "  matte uniform grey material. No textures, no colors, no gloss.",
  "- Replace every person with an articulated pose dummy (wooden-mannequin style with",
  "  ball joints) holding exactly the same pose, proportions and position.",
  "  No face, hair, clothing or surface details.",
  "- Floor: light grey ground plane with a subtle perspective grid, soft contact shadows",
  "  and ambient occlusion only.",
  "- Neutral studio lighting, plain light-grey background.",
  "- Do NOT preserve or reproduce the input's line art, drawing style, colors, shading,",
  "  textures or any decorative detail. The output must look like a clean 3D viewport",
  "  blockout render.",
].join("\n");

export type SketchPromptPreset = {
  id: string;
  label: string;
  description: string;
  /** 空文字 = 規定プロンプトを持たない (参照ラック合流のみ)。 */
  prompt: string;
};

/**
 * v1 のプリセット群。
 * - plain: そのまま画像化。プロンプトは持たず、参照ラックに合流させるだけ
 * - blockout: 規定プロンプトで直接1枚生成する
 */
export const SKETCH_PRESETS: SketchPromptPreset[] = [
  {
    id: "plain",
    label: "そのまま画像化",
    description: "描いた絵を参照画像として追加し、通常の生成に使う",
    prompt: "",
  },
  {
    id: "blockout",
    label: "ブロックアウト化",
    description: "グレーの3Dブロックアウト風レンダーに変換した1枚を生成する",
    prompt: BLOCKOUT_PRESET_PROMPT,
  },
];

export function findSketchPreset(id: string): SketchPromptPreset | undefined {
  return SKETCH_PRESETS.find((p) => p.id === id);
}
