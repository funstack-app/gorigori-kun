import { GORI_SKILLS } from "../skills/catalog";
import { useCharacterSheetRun } from "../store/characterSheetRun";
import { useSkillMode } from "../store/skillMode";
import { useToasts } from "../store/toasts";
import { useWorkspace } from "../store/workspace";

/**
 * 任意スキルの生成結果 1 枚 → キャラクター登録スキル連携。
 *
 * STΛCK 要望 (2026-07-26): マルチアングルで気に入った 1 枚が出たとき、
 * そこからそのままキャラクター登録に進みたい。画像を選び直させない。
 *
 * 実装上の順序が要点 (sendCutToVideo.ts と違い、こちらはスキルを跨ぐ):
 *
 *   1. スキル切替 (skillMode.setSelectedSkillId)
 *        → syncUiMode が enterSkill + resetSkillScopedState を走らせる。
 *          resetSkillScopedState は multiAngleRun 等を初期化するが、
 *          characterSheetRun には触らない (skillReset.ts 参照)。
 *   2. CharacterRegisterWorkspace がマウントされ enterMode("character") を呼ぶ。
 *        → mode が "character" でなければ run 状態と step を初期化する。
 *          ただし characterImagePath / characterName / attributes は
 *          runEmptyState の外なので消えない (characterSheetRun.ts 参照)。
 *   3. よって参照画像のセットは切替の**前**でも後でも残るが、ここでは
 *      「切替前にセット」する。マウント直後の初回描画から画像が入っている
 *      状態になり、一瞬空欄が見える瞬間を作らないため。
 *
 * enterMode が step を 1 に戻すので、ユーザーは「参照画像が入った入力画面」から
 * 始まる。これが狙いどおりの着地。
 */

const CHARACTER_REGISTER_SKILL_ID = "gori-character-register";

export type SendImageToCharacterRegisterInput = {
  /** 参照画像として渡す画像の絶対パス */
  imagePath: string;
  /** 送り元を示すラベル (トースト文言に使う。任意) */
  sourceLabel?: string;
};

/**
 * 1 枚の画像をキャラクター登録スキルの参照画像にセットし、その画面へ移動する。
 */
export function sendImageToCharacterRegister(
  input: SendImageToCharacterRegisterInput,
): void {
  const imagePath = input.imagePath?.trim();
  if (!imagePath) {
    useToasts.getState().push({
      kind: "error",
      text: "この画像はまだ使えません。生成が終わってから試してください。",
      ttlMs: 4000,
    });
    return;
  }

  // 1. 参照画像を先にセットする (切替後の初回描画から画像が入っている状態にする)。
  const run = useCharacterSheetRun.getState();
  run.setCharacterImage(imagePath);
  // 属性は前スキルの文脈を持ち込まない。参照画像から「自動抽出」し直す前提。
  run.setAttributes("");

  // 2. キャラクター登録スキルへ移動する。activateSkill と同じ経路
  //    (skillMode → syncUiMode → skillUiMode.enterSkill) を通す。
  const workspace = useWorkspace.getState();
  workspace.setActiveTab("generate");

  const skillMode = useSkillMode.getState();
  skillMode.setEnabled(true);
  skillMode.setSelectedSkillId(CHARACTER_REGISTER_SKILL_ID);

  const skillName =
    GORI_SKILLS.find((s) => s.id === CHARACTER_REGISTER_SKILL_ID)?.name ??
    "キャラクター登録";

  useToasts.getState().push({
    kind: "success",
    text: input.sourceLabel
      ? `「${input.sourceLabel}」を参照画像にして${skillName}を開きました。`
      : `参照画像をセットして${skillName}を開きました。`,
    ttlMs: 4000,
  });
}
