export type FilmPhase = 1 | 2 | 3 | 4 | 5 | 6;

export type FilmApproval = { approvedAt: string } | null;

export type FilmApprovals = {
  logline: FilmApproval;
  beatsheet: FilmApproval;
  treatment: FilmApproval;
  scenelist: FilmApproval;
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
};

export type AssetImportance = "primary" | "supporting" | "background";

export type AssetLedgerStatus =
  | "unplanned"
  | "planned"
  | "generating"
  | "reviewed"
  | "locked";

export type AssetLedgerEntry = {
  id: string;
  name: string;
  importance: AssetImportance;
  blockIds: string[];
  status: AssetLedgerStatus;
};

export type ForeshadowEntry = {
  id: string;
  description: string;
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
  takes: FilmTake[];
};
