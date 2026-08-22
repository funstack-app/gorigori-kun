import {
  presetAttachedImagesToReferences,
  presetKind,
  type Preset,
  type PresetReference,
} from "../store/presets";

/**
 * キャラクター登録機能（2026-07-19 スキル一覧v2.1）の共有ヘルパー。
 *
 * キャラ型プリセット（kind === "character"）は、正本画像を attachedImages に
 * 持ち、属性テキスト（髪色・目・服装・体型など）を characterMeta.attributes に
 * 持つ。参照画像は presetAttachedImagesToReferences を土台に、キャラ型のみ
 * selectCharacterReferences で既定3枚へ絞ってから生成へ流す（速度対策）。
 *
 * キャラ型は画像アセットとしてだけ扱い、属性や保存プロンプトを生成文へ自動注入しない。
 * このファイルは「キャラ参照の枚数選抜」と、プロンプト型プリセットとの境界を担う。
 */

/**
 * 後方互換のため公開名は残すが、キャラ説明文の自動注入は廃止済み。
 * キャラの見た目は selectCharacterReferences() が返す画像だけでモデルへ渡す。
 */
export function characterPromptText(_preset: Preset): undefined {
  return undefined;
}

/**
 * プロンプト型だけ本文を返す。キャラ型は画像アセットなので常に空文字を返す。
 * separator は旧呼び出しとの互換のため残す（自動合成には使わない）。
 */
export function composePresetPrompt(
  preset: Preset,
  _separator = ", ",
): string {
  if (presetKind(preset) === "character") return "";
  return preset.prompt.trim();
}

/**
 * キャラ型プリセットが記録している「生成元の参照画像」を全量で読む。
 *
 * 新形式 (characterMeta.sourceImages) を優先し、無ければ旧形式の単数
 * sourceImage を 1 要素配列として返す。両方無ければ空配列。
 * 旧データ (sourceImages を持たない既存キャラ) をそのまま扱えるようにするための
 * 唯一の読み出し口。
 */
export function characterSourceImages(preset: Preset): string[] {
  const meta = preset.characterMeta;
  const multiple = meta?.sourceImages;
  if (multiple && multiple.length > 0) return multiple;
  const single = meta?.sourceImage;
  return single ? [single] : [];
}

/** キャラ参照の既定上限。STΛCK 報告 (2026-07-19): 14枚渡ると生成が激遅になる。 */
export const DEFAULT_CHARACTER_REFERENCE_LIMIT = 3;

/**
 * sheetRole の優先順。顔が一番よく見えるカット → 正面 → 斜め の順で選ぶ。
 * ここに無い role は「その他」として後ろに回す。
 */
const CHARACTER_ROLE_PRIORITY = [
  "face-detail",
  "face-front",
  "front",
  "three-quarter",
];

/**
 * キャラ型プリセットを適用するとき、composer / 企画チャットへ渡す参照を
 * 既定上限(3枚)に絞る。顔ディテール・正面系の sheetRole を優先し、無ければ
 * attachedImages の先頭から詰める。
 *
 * - kind !== "character" は絞らない（全参照をそのまま返す。プロンプト型の挙動は不変）
 * - 同一 path の重複は先勝ちで除去する（重複を残すと limit を超えて返してしまう）
 * - sheetRoles の role で並べ替え、上位 limit 件を attachedImages の元の順序で返す
 * - エンジンに渡る path・role は presetAttachedImagesToReferences のまま（絞るのは枚数だけ）
 */
export function selectCharacterReferences(
  preset: Preset,
  limit = DEFAULT_CHARACTER_REFERENCE_LIMIT,
): PresetReference[] {
  const all = presetAttachedImagesToReferences(preset);
  if (presetKind(preset) !== "character") return all;

  // path 重複は先勝ちで除去。後段の Set(path) 判定が重複を数え漏らし、
  // limit 超過の枚数を返す穴になる（Sol Verifier 指摘 2026-07-23）。
  const seen = new Set<string>();
  const unique = all.filter((ref) => {
    if (seen.has(ref.path)) return false;
    seen.add(ref.path);
    return true;
  });
  if (unique.length <= limit) return unique;

  const sheetRoles = preset.characterMeta?.sheetRoles ?? {};
  const rank = (path: string): number => {
    const role = sheetRoles[path];
    const idx = role ? CHARACTER_ROLE_PRIORITY.indexOf(role) : -1;
    // 優先ロールに無いものは末尾グループ(大きい値)へ。
    return idx >= 0 ? idx : CHARACTER_ROLE_PRIORITY.length;
  };

  // 元の並び順を保ちつつ優先ロールを前に出す（安定ソート）。
  const chosen = new Set(
    unique
      .map((ref, order) => ({ ref, order, rank: rank(ref.path) }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .slice(0, limit)
      .map((x) => x.ref.path),
  );
  // 出力は attachedImages の元順序（@img 採番の直感と揃える）。
  return unique.filter((ref) => chosen.has(ref.path));
}
