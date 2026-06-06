/**
 * マルチアングル生成のフロント型定義。
 *
 * Rust 側 `MultiAngleEvent` (serde tag="kind", rename_all="camelCase") と
 * 1:1 で対応する。被写体参照1枚から選択した構図カットを並列生成し、終わった
 * ものから順にイベントで通知される。storyboard と違い評価器は通さず、各カット
 * 1枚をそのまま採用する。
 */

/** Tauri emit のイベントチャンネル名。Rust 側 `app.emit("codex://multiangle", ...)` と一致。 */
export const EVENT_MULTIANGLE = "codex://multiangle";

/**
 * Rust `MultiAngleEvent` のフロント表現 (camelCase)。
 * - started:     run 開始。total = 生成するカット総数
 * - cutStarted:  個別カットの生成開始
 * - cutCompleted: 個別カット完了。imagePath に生成画像
 * - cutFailed:   個別カット失敗。reason に理由
 * - completed:   run 全体完了。outputDir に出力先
 */
export type MultiAngleEvent =
  | { kind: "started"; runId: string; total: number }
  | { kind: "cutStarted"; cutId: string; label: string; index: number }
  | { kind: "cutCompleted"; cutId: string; label: string; imagePath: string }
  | { kind: "cutFailed"; cutId: string; reason: string }
  | { kind: "completed"; runId: string; outputDir: string };

/** 1カット分のプロンプト素材。Rust 側に渡す（cutId + 表示名 + 構図の英語句）。 */
export type CutPromptSpec = {
  cutId: string;
  label: string;
  promptFragment: string;
};

/**
 * `invoke("multiangle_run", { params })` に渡す引数 (camelCase)。
 * Rust 側 `MultiAngleParams` (serde rename_all="camelCase") と一致。
 */
export type MultiAngleParams = {
  characterImage: string;
  environmentDescription: string;
  aspectRatio: string;
  cutIds: string[];
  cutPrompts: CutPromptSpec[];
  cwd?: string;
};

/** ストアが保持する1カットの実行状態。 */
export type CutState = {
  cutId: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  imagePath?: string;
  reason?: string;
};
