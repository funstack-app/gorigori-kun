export type FilmPhase = 1 | 2 | 3 | 4 | 5 | 6;

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
  service: string;
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
};
