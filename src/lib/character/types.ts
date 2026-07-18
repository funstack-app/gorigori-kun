/**
 * キャラクター登録パイプラインのフロント型定義。
 *
 * Rust 側 `CharacterSheetEvent` (serde tag="kind", rename_all="camelCase") と 1:1 で対応する。
 * 1枚の参照画像から固定カタログ(3面図+表情+ディテール)を並列生成し、終わったものから
 * 順にイベントで通知される。multiangle の types.ts を役割(role)ベースに読み替えた複製。
 */

/** Tauri emit のイベントチャンネル名。Rust 側 `EVENT_CHARACTER_SHEET` と一致。 */
export const EVENT_CHARACTER_SHEET = "codex://character-sheet";

/**
 * Rust `CharacterSheetEvent` のフロント表現 (camelCase)。
 * - started:      run 開始。total = 生成するカット総数
 * - cutStarted:   個別カットの生成開始
 * - cutCompleted: 個別カット完了。imagePath に生成画像
 * - cutFailed:    個別カット失敗。reason に理由
 * - completed:    run 全体完了。outputDir に出力先
 */
export type CharacterSheetEvent =
  | { kind: "started"; runId: string; total: number }
  | { kind: "cutStarted"; runId: string; cutId: string; role: string; index: number }
  | { kind: "cutCompleted"; runId: string; cutId: string; role: string; imagePath: string }
  | { kind: "cutFailed"; runId: string; cutId: string; reason: string }
  | { kind: "completed"; runId: string; outputDir: string };

/** 1カット分の仕様。Rust 側 `SheetCutSpec` (camelCase) と一致。 */
export type SheetCutSpec = {
  cutId: string;
  role: string;
  promptFragment: string;
};

/**
 * `invoke("character_sheet_run", { params })` に渡す引数 (camelCase)。
 * Rust 側 `CharacterSheetParams` (serde rename_all="camelCase") と一致。
 */
export type CharacterSheetParams = {
  characterImage: string;
  attributes: string;
  aspectRatio: string;
  cutSpecs: SheetCutSpec[];
  cwd?: string;
  /** フロントが先に採番する run_id。beginRun 時点から確定 run_id を持ち、
   *  画面往復後の別 run 後着通知を照合で捨てるために使う (B1 混線対策)。 */
  runId?: string;
};

/** ストアが保持する1カットの実行状態。 */
export type SheetCutState = {
  cutId: string;
  /** UI 表示名(日本語)。cutId から SHEET_CUTS で解決した label を入れる */
  label: string;
  /** characterMeta.sheetRoles に入る役割値 */
  role: string;
  status: "pending" | "running" | "completed" | "failed";
  imagePath?: string;
  reason?: string;
};
