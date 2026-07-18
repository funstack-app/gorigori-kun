import { presetKind, type Preset } from "../store/presets";

/**
 * キャラクター登録機能（2026-07-19 スキル一覧v2.1）の共有ヘルパー。
 *
 * キャラ型プリセット（kind === "character"）は、正本画像を attachedImages に
 * 持ち、属性テキスト（髪色・目・服装・体型など）を characterMeta.attributes に
 * 持つ。参照画像は既存の presetAttachedImagesToReferences 経路でそのまま流し、
 * 属性テキストだけをここでプロンプト合成用の1行に変換する。
 *
 * 参照画像の流し込みロジックは複製しない（プロンプト型と共通の既存経路を使う）。
 * この関数は「属性テキスト → プロンプト断片」の変換だけを担う。
 */

/**
 * キャラ型プリセットの属性テキストを、生成プロンプトに合成する断片へ変換する。
 *
 * - kind !== "character" なら undefined（プロンプト型は一切変化させない）
 * - attributes が空/未設定なら undefined（合成する内容が無い）
 * - それ以外は `キャラクター設定: <attributes>` を返す
 */
export function characterPromptText(preset: Preset): string | undefined {
  if (presetKind(preset) !== "character") return undefined;
  const attributes = preset.characterMeta?.attributes?.trim();
  if (!attributes) return undefined;
  return `キャラクター設定: ${attributes}`;
}

/**
 * プリセット本文（preset.prompt）とキャラ属性テキストを合成する。
 * プロンプト型（characterPromptText が undefined）なら preset.prompt をそのまま返す。
 * 区切りは呼び出し側の既存流儀（", " / "\n"）に合わせられるよう separator で受ける。
 */
export function composePresetPrompt(
  preset: Preset,
  separator = ", ",
): string {
  const character = characterPromptText(preset);
  const body = preset.prompt.trim();
  // 属性テキストが無ければプロンプト本文だけを返す（空/空白のみなら空文字）。
  // これで「preset.prompt が空白のみ」でも区切りだけが付く事故は起きない。
  if (!character) return body;
  // 本文が空/空白のみなら属性テキストのみ（先頭に区切りが付かない）。
  return body ? `${body}${separator}${character}` : character;
}
