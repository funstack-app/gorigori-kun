export type FilmPhase = 1 | 2 | 3 | 4 | 5 | 6;

export type FilmChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: string;
};

export type FilmApproval = { approvedAt: string } | null;

export type FilmApprovals = {
  logline: FilmApproval;
  beatsheet: FilmApproval;
  treatment: FilmApproval;
  scenelist: FilmApproval;
  blocks: FilmApproval;
  look: FilmApproval;
};

export type FilmScene = {
  id: string;
  location: string;
  purpose: string;
  characterNames: string[];
  durationSeconds: number;
};

export type FilmBlock = {
  id: string;
  sceneId: string;
  durationSeconds: number;
  visual: string;
  performance: string;
  dialogue: string;
  sound: string;
  foreshadowIds: string[];
};

/** S2 で執筆結果を格納する脚本の完成形。S1 の初期値は空配列。 */
export type FilmScript = {
  logline: string;
  beatsheet: string;
  treatment: string;
  scenes: FilmScene[];
  blocks: FilmBlock[];
  /** 編集可能なカードを再起動後も同じ文章で復元するための原文。 */
  scenelistText?: string;
  blockScriptText?: string;
  /** S2 の執筆条件。S1 で作った既存プロジェクトでは未設定になり得る。 */
  targetDurationSeconds?: number;
  topicMemo?: string;
  characterNames?: string[];
};

export type AssetImportance = "primary" | "supporting" | "background";

export type AssetType = "character" | "location" | "prop" | "text";

export type AssetPairSide = "①" | "②" | null;

export type AssetLedgerStatus =
  | "unplanned"
  | "planned"
  | "generating"
  | "reviewed"
  | "locked";

export type FilmAssetStressVerdict = "pass" | "fail" | null;

export type FilmAssetStressRoundStatus =
  | "idle"
  | "generating"
  | "review"
  | "passed"
  | "failed";

export type FilmAssetStressRound = {
  status: FilmAssetStressRoundStatus;
  imagePaths: string[];
  verdicts: FilmAssetStressVerdict[];
};

export type FilmAssetStressTest = {
  /** 必須3条件 + 作品固有2条件。 */
  conditions: string[];
  primaryRound: FilmAssetStressRound;
  extraRound: FilmAssetStressRound | null;
  /** 失敗時、同じ文面のまま回し直す事故を止める。 */
  needsPromptRevision: boolean;
  /** 重要キャラへの追加5枚案内は、判断後に再表示しない。 */
  extraRoundOffered: boolean;
  extraRoundDecision: "run" | "skip" | null;
};

export type AssetLedgerEntry = {
  id: string;
  name: string;
  type: AssetType;
  importance: AssetImportance;
  blockIds: string[];
  status: AssetLedgerStatus;
  /** 同じ物の別状態を結ぶ任意の組名。同じ組名で ① / ② をそろえる。 */
  pairKey?: string | null;
  pairSide?: AssetPairSide;
  /** 画像を作る前に全文を書き切る、編集可能な生成プロンプト。 */
  promptDraft?: string;
  /** 直近の生成で検品待ちになった候補。 */
  generatedImagePaths?: string[];
  /** NG後に同じ文面のまま再生成しないための比較元。 */
  lastGeneratedPrompt?: string | null;
  /** ユーザーが正典として採用した1枚。 */
  canonicalImagePath?: string | null;
  /** 「全部NG」で残す一言。NGも次の改善材料として保存する。 */
  ngNotes?: string[];
  /** 人物だけが持つ5枚（必要なら追加5枚）の検証状態。 */
  stressTest?: FilmAssetStressTest | null;
  /** true 以後は正典文・正典画像を編集しない。 */
  locked?: boolean;
};

/** S1〜S3の旧保存データを補完した、S4内で扱う完成形。 */
export type FilmAsset = AssetLedgerEntry & {
  promptDraft: string;
  generatedImagePaths: string[];
  lastGeneratedPrompt: string | null;
  canonicalImagePath: string | null;
  ngNotes: string[];
  stressTest: FilmAssetStressTest | null;
  locked: boolean;
};

export type ForeshadowEntry = {
  id: string;
  description: string;
  initialMeaning?: string;
  trueMeaning?: string;
  plantedInBlockId: string;
  paidOffInBlockId: string;
};

export type FilmTake = {
  blockId: string;
  path: string;
  adopted: boolean;
  version: number;
  verdictNote: string;
};

export type FilmProject = {
  id: string;
  title: string;
  /** この作品で一番伝えたいこと。以降の全判断の親になる。 */
  theme: string;
  mode: "film";
  assetServiceId: "gpt-image-2";
  videoServiceId: string;
  phase: FilmPhase;
  approvals: FilmApprovals;
  /** S1 は空配列。S2 で FilmScript へ置き換える。 */
  script: [] | FilmScript;
  assets: AssetLedgerEntry[];
  foreshadow: ForeshadowEntry[];
  stylePrefix: string;
  lookMasterPath: string | null;
  /** AI生成ルックを選んだ場合に、Style Prefix起草へ渡す設計文。 */
  lookMasterDescription?: string;
  takes: FilmTake[];
  /** 企画から脚本までのAIアドバイザーとの会話。旧データでは未設定。 */
  chatMessages?: FilmChatMessage[];
  /** 「YouTube横長」など、専門用語を使わず会話で確定した投稿先。 */
  postingTarget?: string;
  /** 一覧の更新日表示に使う。旧データでは未設定。 */
  updatedAt?: string;
};
