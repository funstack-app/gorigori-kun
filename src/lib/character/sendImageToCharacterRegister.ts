import { GORI_SKILLS } from "../skills/catalog";
import type { SheetBackground, SheetPromptMode } from "./types";
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
 *        → mode が "character" でなければ他モードのジョブ台帳と step を初期化する。
 *          ただし characterImagePaths / characterName / attributes は
 *          「下書き」側のフィールドなので消えない (characterSheetRun.ts 参照)。
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
  //    この連携は 1 枚 API のまま (複数送り込みはスコープ外)。
  const run = useCharacterSheetRun.getState();
  // 属性は前スキルの文脈を持ち込まない。参照画像から「自動抽出」し直す前提。
  // 属性クリア→画像クリア→addCharacterImages の順で通すと 0→1枚の追加として
  // autoExtractPending が立ち、画面内の選択時自動抽出と同じ経路になる。
  run.setAttributes("");
  run.setCharacterImages([]);
  run.addCharacterImages([imagePath]);
  // シートの作り方・背景色・カスタムプロンプトも同様に初期値へ戻す
  // (前キャラの custom プロンプトを新キャラに持ち込む事故防止)。
  run.setSheetPromptMode("default");
  run.setCustomSheetPrompt("");
  run.setSheetBackground("auto");
  // B-5: 新規登録経路では上書き対象を必ずクリアする (前回の「シート作り直し」を
  // 持ち越すと、無関係な新キャラで既存プリセットを上書きする事故になる)。
  run.setRegenerateTarget(null);

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

export type SendCharacterPresetToSheetRegenerateInput = {
  /** 上書き対象のキャラ型プリセット ID。 */
  presetId: string;
  /** プリセット名 (キャラ名としてそのまま使う)。 */
  name: string;
  /** 編集後の属性テキスト。 */
  attributes: string;
  /** 元参照画像 (characterMeta.sourceImage)。旧データ互換のため残す。 */
  sourceImage: string;
  /**
   * 元参照画像の全量 (characterMeta.sourceImages)。先頭がメイン。
   * 省略・空なら sourceImage 1 枚へフォールバックする (旧データ互換)。
   */
  sourceImages?: string[];
  /** 登録時のシート背景色 (characterMeta.sheetBackground)。省略 = "auto"。 */
  sheetBackground?: SheetBackground;
  /** 登録時のシートの作り方 (characterMeta.sheetPromptMode)。省略 = "default"。 */
  sheetPromptMode?: SheetPromptMode;
  /** 自分で作るモードのプロンプト全文 (characterMeta.sheetCustomPrompt)。省略 = 空。 */
  sheetCustomPrompt?: string;
};

/**
 * 登録済みキャラ型プリセットの「シート作り直し」(B-5 2026-07-30)。
 * 属性を直してシートを再生成し、登録時に既存プリセットへ上書きする。
 * 生成は既存の StepInput の生成ボタンをそのまま使う (新 invoke 経路を作らない)。
 * 遷移順序は sendImageToCharacterRegister と同じ (state セットが先)。
 *
 * 戻り値: 送り込みに成功したら true。元画像が無く送れなかったら false。
 * 呼び出し側はこれを見て画面遷移 (ドロワーを閉じる等) を行う。
 */
export function sendCharacterPresetToSheetRegenerate(
  input: SendCharacterPresetToSheetRegenerateInput,
): boolean {
  // 新形式 (全量) を優先し、無ければ旧形式の単数へフォールバックする。
  const sourceImages = (input.sourceImages ?? [])
    .map((path) => path?.trim())
    .filter((path): path is string => Boolean(path));
  const sourceImage = sourceImages[0] ?? input.sourceImage?.trim();
  if (!sourceImage) {
    useToasts.getState().push({
      kind: "error",
      text: "このキャラには元画像の記録がないため、シートを作り直せません。",
      ttlMs: 5000,
    });
    return false;
  }

  const run = useCharacterSheetRun.getState();
  // 前の生成結果 (別キャラのシート) と step を持ち込ませない。
  // SQ1 以降 reset() は「focus を外して Step1 へ戻す」表示初期化で、走行中ジョブは
  // 台帳に残したまま画面から外れる (裏の生成を巻き込まない)。setStep(1) は
  // reset() に含まれるが、意図を読み取れる形で明示しておく。Step1 に戻ることで
  // regenTarget バナー (StepInput のみ表示) が必ず見える状態から始まる。
  run.reset();
  run.setStep(1);
  run.setCharacterName(input.name);
  run.setCharacterImages(sourceImages.length > 0 ? sourceImages : [sourceImage]);
  run.setAttributes(input.attributes);
  // 旧データ (フィールド無し) は既定値 = 従来挙動へ落ちる。
  run.setSheetPromptMode(input.sheetPromptMode ?? "default");
  run.setCustomSheetPrompt(input.sheetCustomPrompt ?? "");
  run.setSheetBackground(input.sheetBackground ?? "auto");
  run.setRegenerateTarget(input.presetId);

  const workspace = useWorkspace.getState();
  workspace.setActiveTab("generate");

  const skillMode = useSkillMode.getState();
  skillMode.setEnabled(true);
  skillMode.setSelectedSkillId(CHARACTER_REGISTER_SKILL_ID);

  useToasts.getState().push({
    kind: "success",
    text: `「${input.name}」のシート作り直しを開きました。属性を確認して生成してください。`,
    ttlMs: 4000,
  });

  return true;
}
