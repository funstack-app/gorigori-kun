/**
 * キャラクター登録パイプラインのフロント型定義。
 *
 * Rust 側 `CharacterSheetEvent` (serde tag="kind", rename_all="camelCase") と 1:1 で対応する。
 * 1枚の参照画像から、キャラクター登録では統合シート1枚、表情差分では複数カットを生成し、
 * 終わったものから順にイベントで通知される。
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

/** Rust 側で選ぶ生成経路。未指定は後方互換で従来の複数カット生成。 */
export type CharacterSheetGenerationMode = "composite" | "multi-cut";

/**
 * シート背景色 (STΛCK 2026-08-03 確定仕様の4択)。
 * auto = 既定(背景句を差し替えない。既定シート=従来のクリーム系 / 自分で作る=プロンプト準拠)
 * green = グリーンバック #00FF00 / blue = ブルーバック #0000FF (クロマキー標準値)
 */
export type SheetBackground = "auto" | "white" | "green" | "blue";
/** シートの作り方。default=既定シートテンプレ / custom=入力プロンプトをそのまま使う */
export type SheetPromptMode = "default" | "custom";

/**
 * `invoke("character_sheet_run", { params })` に渡す引数 (camelCase)。
 * Rust 側 `CharacterSheetParams` (serde rename_all="camelCase") と一致。
 */
export type CharacterSheetParams = {
  characterImage: string;
  /**
   * 参照画像の全量。`[0]` はメイン=同一性の正。省略時は Rust 側が `characterImage`
   * 1 枚にフォールバックする(後方互換)。最大 6 枚。
   */
  characterImages?: string[];
  attributes: string;
  aspectRatio: string;
  /** キャラクター登録は composite、表情差分は未指定のまま従来経路を使う。 */
  generationMode?: CharacterSheetGenerationMode;
  /** 複数カット生成だけで使用。統合シート生成では送らない。 */
  cutSpecs?: SheetCutSpec[];
  cwd?: string;
  /** フロントが先に採番する run_id。beginRun 時点から確定 run_id を持ち、
   *  画面往復後の別 run 後着通知を照合で捨てるために使う (B1 混線対策)。 */
  runId?: string;
  /** シート背景色。省略時は Rust 側が "auto"(従来挙動)にフォールバック */
  sheetBackground?: SheetBackground;
  /** 自分で作るモードのプロンプト全文。空/省略 = 既定シートテンプレを使う。上限8000文字 */
  customPrompt?: string;
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
