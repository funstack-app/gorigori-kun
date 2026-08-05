import { create } from "zustand";

import { storyboard } from "../ipc";
import type {
  SceneConstruction,
  SceneGroup,
  ScoreBundle,
  StoryboardChatMessage,
  StoryboardEvent,
  StoryboardGoal,
  StoryboardPhase,
  StoryboardRunParams,
  StoryboardSketchCut,
  StoryboardSketchVersion,
} from "../storyboard/types";
import { buildProductionParams } from "../storyboard/productionParams";
import { useActiveProject } from "./activeProject";
import {
  stallFromFailure,
  useGenerationStatus,
  type GenerationKind,
} from "./generationStatus";
import { usePlanChat } from "./planChat";
import { useProjects } from "./projects";
import { clearLastRunPointer, writeLastRunPointer } from "./storyboardLastRun";
import { useToasts } from "./toasts";

export type Take = {
  takeId: string;
  imagePath: string;
  scores: ScoreBundle;
};

export type CutState = {
  cutId: string;
  sceneGroupId?: string;
  description?: string;
  status: "pending" | "running" | "review" | "confirmed" | "failed";
  takes: Take[];
  selectedTakeId: string | null;
  error?: string;
  takeCount?: number;
};

type StoryboardRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  // ユーザーが生成中止 (cancel_generation) を実行した状態。
  // failed とは区別する (エラーではなくユーザー意思。生成済みカットは保持)。
  | "cancelled";

/**
 * 完了した過去 run のスナップショット。新しい run を始めても消さず保持する。
 * STΛCK 指示 (2026-05-15): 「前のが消えるのを防ぐ」
 */
export type PastRunSummary = {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: StoryboardRunStatus;
  totalCuts: number;
  confirmedCuts: number;
  manifestPath: string | null;
  storyDigest: string;
};

type StoryboardRunState = {
  activeRunId: string | null;
  /**
   * P19a (2026-05-21 STΛCK指示): 絵コンテと本生成を完全分離。
   * cuts は **本生成 run 専用** の Map。絵コンテのイベントは sketchCuts に
   * 振り分けられる。これで Phase 2/3 の混線を物理的に排除する。
   */
  cuts: Map<string, CutState>;
  /** 絵コンテ run 専用の cuts Map (P19a)。Phase 2 が購読する。 */
  sketchCuts: Map<string, CutState>;
  sceneGroups: SceneGroup[];
  status: StoryboardRunStatus;
  totalCuts: number;
  manifestPath: string | null;
  /** 直近 completed 時のプロジェクト追加実績。null = 未完了 or ラフ run（追加処理なし）。 */
  projectAddResult: { noProject: boolean; added: number; total: number } | null;
  lastError: string | null;
  params: StoryboardRunParams | null;
  debugLog: StoryboardEvent[];
  /**
   * B-6: 直近の storyboard イベントを受信した時刻 (epoch ms)。
   * 生成中カットの経過秒表示に使う (通常生成 batches.runningAt と同じ流儀)。
   * イベントが来るたびに更新し、UI は now - lastEventAt で「最後の進捗から
   * 何秒経ったか」を出せる。null = まだイベント未受信。
   */
  lastEventAt: number | null;
  /** 完了した過去 run のサマリー一覧。新しい run を始めても消えない。 */
  pastRuns: PastRunSummary[];

  // ===== β版 4-Phase ワークフロー =====
  /** 現在の Phase (goal / sketch / generation / review)。 */
  phase: StoryboardPhase;
  /** Phase 1: ユーザーと AI の対話ログ。 */
  chatMessages: StoryboardChatMessage[];
  /** Phase 1 終了時に確定したゴール。Phase 2 入力になる。 */
  goal: StoryboardGoal | null;
  /**
   * Phase 1 で確定したシーン構成 (本生成の必須入力)。
   *
   * ## なぜ storyboard 側に複製を持つか (Sol 評価 blocking#3 / 2026-08-04)
   *
   * 正本は共有ストア `planChat.sceneConstruction` (AI 応答のパーサがそこへ書く)。
   * だが planChat は **スキルを離れた瞬間に resetThread() で消える共有ストア**で、
   * これは FB#A7 (制作モードの企画チャットがスキルの Phase 1 に流れ込む) /
   * FB#5 (前スキルの構図が要素別編集に混ざる) を防ぐための意図的な設計。
   * その破棄は維持したまま「storyboard で目標確定 → 漫画へ寄り道 → storyboard へ
   * 戻る」で本生成入力だけを生かす必要がある。
   *
   * そこで **共有ストアの寿命に依存しない storyboard 専用の控え**をここに持つ。
   * 読み手 (GenerationProgressPanel 等) は planChat を優先し、消えていたら
   * こちらへフォールバックする。共有ストアのリセット原則は一切ゆるめない。
   *
   * 寿命は goal と同じ (phaseEmptyState)。ストーリー境界のリセット
   * (resetPhases / resetAll / 「↺ リセット」) で goal ごと破棄されるので、
   * 前ストーリーの構成が次へ持ち越されることはない。
   */
  sceneConstruction: SceneConstruction | null;
  /** Phase 1 の構成確定時に storyboard 側の控えへ写す。 */
  setSceneConstruction: (scene: SceneConstruction | null) => void;
  /** Phase 2: 提示したスケッチ案のバージョン履歴 (再生成で増える)。 */
  sketchVersions: StoryboardSketchVersion[];
  /** 現在表示中のスケッチ versionId。null なら最新を使う。 */
  activeSketchVersionId: string | null;
  /**
   * B1' 補完 (2026-06-06): Phase 4 の i2v プロンプト生成がカメラワーク等のスケッチメタを
   * 失わないよう、本生成開始時に cutId → SketchCut のスナップショットを撮っておく。
   * これは「今の run に紐づく確定絵コンテ」だけを保持し、reset() では破棄して次の
   * ストーリーに残さない。
   *
   * ラフ消失修正 (2026-07-28): reset() は startGeneration から呼ばれなくなった
   * (ストーリー境界専用)。本スナップショットは Phase 3 のラフ下敷き表示のデータ源
   * でもある。全量上書きなので前 run のメタは残らない。
   */
  generationCutSketchMeta: Record<string, StoryboardSketchCut>;
  /** B1': 本生成開始時に確定絵コンテのメタを run スナップショットへ格納する。 */
  setGenerationCutSketchMeta: (meta: Record<string, StoryboardSketchCut>) => void;

  beginRun: (runId: string, params: StoryboardRunParams) => void;
  applyEvent: (e: StoryboardEvent) => void;
  setStatus: (status: StoryboardRunStatus) => void;
  // dismissCheckpoint / continueCheckpoint / cancelCheckpoint は S3 (2026-07-28)
  // で撤去。本生成が全カット並列になり方向性チェックの停止区間が消えたため。
  /**
   * S3 (2026-07-28): 採用ゲート式の本生成。指定した cutId のカットだけを
   * 本番へ送る (productionScope 付きで storyboard.run を呼ぶ)。
   *
   * 全カット一括の導線 (GenerationProgressPanel の「本生成を開始」) は従来のまま
   * 残す。こちらは「ラフを採用したカットから順に本番へ」を可能にする追加経路。
   *
   * 直前の本生成 run の params があればそれを土台にし、無ければ
   * buildProductionParams で goal + 確定ラフから組み立てる。
   * (「一括を1回走らせないと採用ゲートが使えない」= 枠の節約という目的と
   *  矛盾する前提を潰すため。issue-2)
   *
   * 本生成 run が走行中の場合は cutIds を pendingProductionCuts へ積み、
   * その run の完了/失敗を受けてから自動で発射する (issue-3: activeRunId を
   * 差し替えると走行中 run のイベントが applyEvent の別 run ガードで全部
   * 捨てられ、生成結果が画面から消えるため)。
   */
  startProductionForCuts: (cutIds: string[]) => Promise<boolean>;
  /**
   * S3 issue-3 (2026-07-28): 走行中の本生成が終わるのを待っている cutId。
   * 走行中 run の completed/failed 受信時に自動発射して空になる。
   */
  pendingProductionCuts: string[];
  /**
   * 23g (2026-08-03): 採用ゲート待機キューを手動で取り消す。イベント途絶で
   * 発射契機が失われたキューの脱出口 (パネルのエスカレーション表示から呼ばれる)。
   * 自動では呼ばない。
   */
  clearPendingProduction: () => void;
  /**
   * S3 issue-7 (2026-07-28): 中止 (cancel_generation) が実際に効いた run の
   * フロント状態を 'cancelled' に落とす。backend は中止 run のイベントを
   * 一切出さないため、これが無いと Phase 3 の表示が 'running' のまま残る。
   */
  markCancelled: (runId: string) => void;
  /** run 関連だけリセット (phase/goal/sketchVersions/chatMessages は保持) */
  reset: () => void;
  /** Phase ワークフロー (phase/goal/sketchVersions/chatMessages) もリセット */
  resetPhases: () => void;

  // ===== Phase 操作 =====
  setPhase: (phase: StoryboardPhase) => void;
  appendChatMessage: (msg: Omit<StoryboardChatMessage, "id" | "ts"> & { id?: string; ts?: number }) => void;
  clearChat: () => void;
  setGoal: (goal: StoryboardGoal | null) => void;
  pushSketchVersion: (version: StoryboardSketchVersion) => void;
  setActiveSketchVersion: (versionId: string | null) => void;
  /**
   * P19b: 絵コンテバージョンを「確定」状態にする。
   * confirmed=true の sketchVersion からのみ Phase 3 が参照画像を取り出す。
   */
  confirmSketchVersion: (versionId: string) => void;
  /** スケッチ内の特定カットを部分更新する (自由記述上書き等)。activeSketchVersionId 対象。 */
  updateSketchCut: (
    cutId: string,
    patch: Partial<{
      intent: string;
      cameraNote: string;
      visualLayout: string;
      userOverride: string;
      durationSeconds: number;
      sketchImagePath: string | undefined;
      sketchStatus: "pending" | "generating" | "done" | "failed";
    }>,
  ) => void;

  // ===== 各 Phase の起動済みフラグ (Phase 間往復で消えないようストア管理) =====
  // P1 修正 (2026-05-20): SketchReviewPanel / GenerationProgressPanel が
  // ローカル useState で起動済み判定をしていたため、Phase 切替でアンマウント
  // → 再マウント時に false に戻り重複 run が起動するバグがあった。
  sketchRunStartedAt: number | null;
  generationRunStartedAt: number | null;
  setSketchRunStartedAt: (ts: number | null) => void;
  setGenerationRunStartedAt: (ts: number | null) => void;

  // ===== P3b: ユーザーが D&D で並べ替えた表示順 =====
  // null なら sceneConstruction.cuts の元順序を使う。
  // cutIds 配列で順序を表現 (重複/欠落はクライアント側でガード)。
  cutDisplayOrder: string[] | null;
  setCutDisplayOrder: (order: string[] | null) => void;

  // ===== B2: キービジュアル固定参照 (NOCTURNE @img1 移植) =====
  // 全カット共通の基準画像。設定すると本生成時、各カットの参照画像として
  // 固定で渡される (per-cut の絵コンテ参照が無いカットに適用)。
  // null = 未設定 (従来どおり)。
  keyVisualPath: string | null;
  setKeyVisualPath: (path: string | null) => void;

  // ===== P10: 同時生成枚数 (1カットあたりの take 数) =====
  // 絵コンテ生成と本番生成で別々に保持する。
  // (絵コンテは速度優先で 1 デフォルト、本番は選択肢から 3 デフォルト)
  sketchCandidatesPerCut: 1 | 2 | 3;
  generationCandidatesPerCut: 1 | 2 | 3;
  setSketchCandidatesPerCut: (n: 1 | 2 | 3) => void;
  setGenerationCandidatesPerCut: (n: 1 | 2 | 3) => void;

  // ===== レビュー UI 操作系 (採用確認待ち時) =====
  /** 表示中の take をユーザー意思で確定 (採用ボタン) */
  adoptTake: (cutId: string, takeId?: string) => void;
  /** 採用済みカットを review に戻して別 take を選ばせる (戻る) */
  revertCut: (cutId: string) => void;
  /** review 状態の take を切り替え (左右ボタンで比較) */
  selectTake: (cutId: string, takeId: string) => void;

  // ===== D1: 確定カットの個別除外 (2026-08-05) =====
  /**
   * Phase 4 で「このカットだけ要らない」を表現する除外集合。
   *
   * **cuts Map からは消さない**。terminalStatusFor が `map.size !== totalCuts`
   * で終端を判定し、settleAndFlushQueue が決着件数と totalCuts の一致を要求する
   * (A-7 件数充足ガード)ため、Map から実削除すると走行中 run の終端検知が
   * 恒久的に成立せず、pendingProductionCuts が永久待機になる。
   * run のライフサイクルには一切触れず、「成果物として採るか」だけを別集合で持つ。
   *
   * 除外カットは Phase 4 の下流 (一括保存 / ストーリー動画キュー / i2v 一括コピー /
   * 確定フォルダ) から外れる。生成済み画像そのものは消さない (取り消し可能)。
   */
  excludedCutIds: string[];
  /** カットを成果物から除外する (再実行しても増殖しない)。 */
  excludeCut: (cutId: string) => void;
  /** 除外を取り消して成果物へ戻す。 */
  includeCut: (cutId: string) => void;
  /**
   * このカットを1枚だけ作り直す。UI を「生成中」に戻し、Rust の
   * storyboard_regenerate_cut を呼ぶ。新しい take は TakeCompleted イベントで
   * ストアに追加される。
   *
   * 2026-07-27: 以前はトーストで「未対応です」と出すだけの空実装だった。
   * Rust 側 (commands/storyboard.rs) と ipc (storyboard.regenerateCut) は完成済みで、
   * StoryboardCutCard だけが自前で実呼び出しを持っていたため、
   * 「絵コンテ段階のボタンは動くのに本生成中のボタンは死んでいる」状態になっていた。
   * ストア側に実装を集約し、呼び出し元すべてが同じ挙動になるようにする。
   */
  regenerateCut: (cutId: string) => void;
  /** スキップして次へ進む (このカットは confirmed 扱いで次に行く) */
  skipCut: (cutId: string) => void;

  // ===== デバッグログ拡充 =====
  /** UI から任意のメモログを追加 (パラメータ・エラー文脈などを保存) */
  appendDebug: (entry: { ts: number; level: "info" | "warn" | "error"; message: string; data?: unknown }) => void;
  uiDebugLog: Array<{ ts: number; level: "info" | "warn" | "error"; message: string; data?: unknown }>;
};

/**
 * STΛCK 報告 (2026-05-20): emptyState で phase/goal/sketchVersions/chatMessages
 * まで巻き戻していたため、beginRun() が走ると Phase 2 から Phase 1 に
 * 強制的に戻されてしまうバグがあった。
 *
 * これを修正するため、emptyState を 2 つに分割する:
 *
 *  - runEmptyState  : run (生成) に関する状態だけ。beginRun/reset で初期化される
 *  - phaseEmptyState: Phase ワークフロー (goal/sketch等) の状態。
 *                     ユーザー意思によるリセット (resetAll) でだけ初期化される
 *
 * これにより「Phase 1 で確定 → Phase 2 で run 起動 → Phase 2 にとどまる」が
 * 成立する。
 */
const runEmptyState = {
  activeRunId: null,
  cuts: new Map<string, CutState>(),
  sketchCuts: new Map<string, CutState>(),
  sceneGroups: [],
  status: "idle" as const,
  totalCuts: 0,
  manifestPath: null,
  projectAddResult: null,
  lastError: null,
  params: null,
  debugLog: [],
  lastEventAt: null,
  // D1: 除外は run に紐づく (新しい run が始まれば前 run の除外は無意味)。
  excludedCutIds: [] as string[],
};

const phaseEmptyState = {
  phase: "goal" as StoryboardPhase,
  chatMessages: [] as StoryboardChatMessage[],
  goal: null as StoryboardGoal | null,
  sceneConstruction: null as SceneConstruction | null,
  sketchVersions: [] as StoryboardSketchVersion[],
  activeSketchVersionId: null as string | null,
  sketchRunStartedAt: null as number | null,
  generationRunStartedAt: null as number | null,
  cutDisplayOrder: null as string[] | null,
  keyVisualPath: null as string | null,
};

const emptyState = {
  ...runEmptyState,
  ...phaseEmptyState,
};

function ensureCut(cuts: Map<string, CutState>, cutId: string): CutState {
  const existing = cuts.get(cutId);
  if (existing) return existing;
  const created: CutState = {
    cutId,
    status: "pending",
    takes: [],
    selectedTakeId: null,
  };
  cuts.set(cutId, created);
  return created;
}

/**
 * scoped 本生成 run (productionScope 付き) の判定対象カットだけを取り出す。
 *
 * 採用ゲート持ち越し修正 (2026-07-30): beginRun は productionScope 付き run で
 * scope外カット (確定済みの前 run 分) を cuts Map に持ち越すようになった。
 * backend の totalCuts は scope 内カット数 (storyboard.rs:1214) なので、
 * Map 全体と totalCuts の件数一致で終端を見ると恒久的に不一致になり、
 * r2-2/r3-4 の自力終端検知が死ぬ。終端・決着・完了時のプロジェクト追加は
 * すべてこのヘルパーで scope 内に絞ってから判定する。
 * scope 無し (全カット一括 / ラフ run / params 未確定) は Map をそのまま返す。
 */
const runScopedCuts = (
  map: Map<string, CutState>,
  params: StoryboardRunParams | null,
): Map<string, CutState> => {
  const scope =
    params &&
    params.sketchMode !== true &&
    params.productionScope &&
    params.productionScope.length > 0
      ? new Set(params.productionScope)
      : null;
  if (!scope) return map;
  const next = new Map<string, CutState>();
  map.forEach((cut, cutId) => {
    if (scope.has(cutId)) next.set(cutId, cut);
  });
  return next;
};

/**
 * r2-2 (2026-07-28): 部分失敗 run の自力終端検知。
 * backend は failures>0 のとき Completed を出さず (storyboard.rs:1066)、
 * run レベルの Failed イベントも存在しない (StoryboardEvent は
 * started/cutStarted/takeCompleted/cutConfirmed/cutFailed/completed の6種)。
 * 旧直列実装では失敗=break で cutFailed が最終イベントになり status が
 * 'failed' で止まったが、並列では失敗カットの後に他カットの
 * takeCompleted/cutConfirmed が届いて status が 'running' へ戻り、以後
 * 終端イベントが来ない → 表示が永久に生成中 + キューが永久待機になる。
 * そこで「全カットが確定か失敗で、その件数が run の totalCuts と一致」した
 * 時点をフロント側で終端とみなす。
 * 件数は run の totalCuts (started イベント値 / scoped run なら scope 数) を
 * 使い、実行時の値を決め打ちしない。
 *
 * r3-1 (2026-07-28): 'failed' 専用に戻した。全 confirmed のときは null を返し、
 * 成功終端の確定は backend の Completed イベントに任せる。
 * 自力で 'completed' を確定すると、キュー非空の全成功 run で backend Completed
 * 到達前に発射 → beginRun が activeRunId を差し替え → 直後に届く Completed が
 * 別 run ガードで破棄され、プロジェクト自動追加・manifestPath 記録・gs.finish が
 * すべて失われる (issue-3 が防ごうとした「生成結果が画面から消える」の再導入)。
 * backend は failures==0 のとき必ず Completed を emit する (storyboard.rs:1066)
 * ため、成功終端をイベント側に任せても取りこぼしはない。
 */
const terminalStatusFor = (
  map: Map<string, CutState>,
  totalCuts: number,
): "failed" | null => {
  if (totalCuts <= 0) return null;
  const settled = Array.from(map.values()).filter(
    (c) => c.status === "confirmed" || c.status === "failed",
  );
  if (settled.length !== totalCuts || map.size !== totalCuts) return null;
  return settled.some((c) => c.status === "failed") ? ("failed" as const) : null;
};

/**
 * r3-4 (2026-07-28): 自力終端を右上の生成状況パネルへ橋渡しする。
 *
 * 部分失敗 run は backend が Completed を出さない (storyboard.rs:1066 は
 * failures==0 のときのみ) ため、completed ハンドラの gs.finish が呼ばれず、
 * Phase 3 の status が 'failed' に確定してもパネルのジョブだけ走行中表示の
 * まま残る。残留ジョブの中止ボタンを押しても backend は該当 run を発見できず
 * (found=false) markCancelled も呼ばれないため、× で手動クローズするしか
 * なくなる。completed ハンドラと同じ処置 (finish + 4秒後 clear) を行う。
 */
const notifySelfTerminal = (runId: string) => {
  useGenerationStatus.getState().finish(runId);
  setTimeout(() => useGenerationStatus.getState().clear(runId), 4000);
};

export const useStoryboardRun = create<StoryboardRunState>((set, get) => {
  /**
   * r3-3 (2026-07-28): 終端再判定 + 待機キューの自動発射。
   *
   * 元は applyEvent の post-set にだけ置かれていたため、backend イベントを
   * 伴わない決着 (adoptTake / skipCut。regenerateCut 後は backend が
   * TakeCompleted しか emit せず、確定はフロント側で行う設計:
   * storyboard.rs:640-641) では発射契機が永久に来ず、
   * 「走行中の生成が終わり次第、自動で開始します」と約束したまま静かに
   * 詰まっていた。共有ヘルパーに切り出し、決着を起こす全経路から呼ぶ。
   *
   * 判定条件は従来の post-set 実装と同一:
   *  - completed: run 全体の終了 (唯一の run 終端イベント)
   *  - failed:    全カットが走り終えて1枚も running が残っていない場合のみ。
   *               cutFailed は1カットの失敗でも status を failed にするが、
   *               他カットはまだ走っているので、そこで発射すると
   *               issue-3 で塞いだはずの run 差し替えを自分で踏む。
   * 二重発射は terminal 判定 (全カット非running) + 発射前のキュー空化で防ぐ。
   */
  const settleAndFlushQueue = (opts: { wasSketchRun: boolean }) => {
    const after = get();
    if (after.pendingProductionCuts.length === 0) return;
    // r3-B1: 終端判定に使う Map は run 種別で切り替える (ラフ run のカットは
    // sketchCuts 側に入るため、cuts を見ると常に「全カット非running」となり
    // 誤発射しうる)。
    const afterCuts = runScopedCuts(
      opts.wasSketchRun ? after.sketchCuts : after.cuts,
      after.params,
    );
    const terminal =
      after.status === "completed" ||
      (after.status === "failed" &&
        Array.from(afterCuts.values()).every((c) => c.status !== "running") &&
        // A-7 件数充足ガード (2026-07-30): CutStarted が全カット分届く前の
        // CutFailed で早発射すると beginRun が activeRunId を差し替え、旧 run の
        // 後続イベントが全破棄される。terminalStatusFor / r3-4 allSettled は
        // 件数を見るのにここだけ見ていない非対称の解消。
        // - totalCuts <= 0: orchestrator が Started 前に死んだ run (CutFailed
        //   "unknown" のみ・後続イベント無し) を perma-queue にしないための脱出口
        // - >= (=== にしない): 非 scoped run では cutFailed "unknown" を ensureCut
        //   が Map に足すため size が totalCuts を超え得る (=== だと恒久不発射)
        (after.totalCuts <= 0 || afterCuts.size >= after.totalCuts));
    if (!terminal) return;
    const queued = after.pendingProductionCuts;
    set({ pendingProductionCuts: [] });
    void get().startProductionForCuts(queued);
  };

  /**
   * r3-3 (2026-07-28): backend イベントを伴わない決着 (adoptTake / skipCut) の
   * あとに、自力終端の確定とキュー発射を行う。
   *
   * 本生成 run の cuts 側だけを見る (両者とも cuts を更新するため)。
   * terminalStatusFor は 'failed' しか返さない (r3-1) ので、全カット成功で
   * 決着した場合は status を触らず backend の Completed に任せる。
   */
  const settleLocalAdoption = () => {
    const before = get();
    if (before.activeRunId === null) return;
    if (before.params?.sketchMode === true) return;
    if (before.status !== "running" && before.status !== "failed") return;
    const settledStatus = terminalStatusFor(
      runScopedCuts(before.cuts, before.params),
      before.totalCuts,
    );
    if (settledStatus !== null && before.status !== settledStatus) {
      set({ status: settledStatus });
      notifySelfTerminal(before.activeRunId);
    }
    settleAndFlushQueue({ wasSketchRun: false });
  };

  return {
  ...emptyState,
  pastRuns: [],
  // B1' 補完: 本生成開始時に撮る確定絵コンテメタのスナップショット。
  // runEmptyState/phaseEmptyState には入れない (beginRun の spread で消えるため)。
  // 破棄は reset() で明示的に行う。
  generationCutSketchMeta: {} as Record<string, StoryboardSketchCut>,
  setGenerationCutSketchMeta: (meta) => set({ generationCutSketchMeta: meta }),
  // P10: 同時生成枚数 (デフォルト)
  // 2026-06-08 速度優先(STΛCK指示): デフォルトを 3→1 に変更。
  // 3枚並列だと「一番遅い1枚」を毎カット待つ(実測 最遅573秒)のが体感の遅さの主因。
  // 1枚なら各カット約130秒で即完成・即表示され、気に入らなければカードの再生成で
  // その場で作り直せる(storyboard_regenerate_cut)。複数候補が欲しい人はUIで2/3に上げる。
  sketchCandidatesPerCut: 1 as 1 | 2 | 3,
  generationCandidatesPerCut: 1 as 1 | 2 | 3,

  beginRun: (runId, params) => {
    // rr2 (2026-08-03): 本生成 run の「未回収ポインタ」を書く。採用は
    // adoptions.json に残るのにプロジェクト追加は completed でしか走らないため、
    // 途中でアプリが落ちると採用判断が UI から消えていた。ポインタが残っている
    // 状態 = 未回収のまま終了、として起動時に復元する。
    // 絵コンテ (sketchMode) は採用ゲート→本生成が同一セッション内のフローで、
    // 成果はスケッチ画像としてディスクに残るため対象外。
    if (params.sketchMode !== true) {
      void writeLastRunPointer({
        runId,
        projectId: useActiveProject.getState().activeProjectId ?? null,
        startedAt: Date.now(),
      });
    }
    set((s) => {
      // 既存の run があれば pastRuns に退避してから新 run を開始する
      const archived: PastRunSummary[] =
        s.activeRunId && s.cuts.size > 0
          ? [
              ...s.pastRuns,
              {
                runId: s.activeRunId,
                startedAt: Date.now(),
                finishedAt: Date.now(),
                status: s.status,
                totalCuts: s.totalCuts,
                confirmedCuts: Array.from(
                  runScopedCuts(s.cuts, s.params).values(),
                ).filter((c) => c.status === "confirmed").length,
                manifestPath: s.manifestPath,
                storyDigest:
                  (s.params?.storyPrompt ?? "").slice(0, 80) +
                  ((s.params?.storyPrompt?.length ?? 0) > 80 ? "…" : ""),
              },
            ]
          : s.pastRuns;
      // run 関連だけリセット。phase/goal/sketchVersions/chatMessages は保持する。
      // P19a: sketch_mode の run が始まる場合は sketchCuts を、本生成なら cuts を新規 Map に。
      // どちらの run でも「もう片方の Map」は既存値を保持する。
      const isSketch = params.sketchMode === true;
      // 採用ゲート持ち越し (2026-07-30): productionScope 付き本生成では cuts を
      // 全消去せず、scope外カット (前 run で確定/レビュー済みの資産) をそのまま
      // 持ち越す。scope内カットだけ落として作り直す (cutStarted の ensureCut が
      // 再生成する)。全カット一括 (scope無し) は従来どおり全消去。
      const productionScope =
        !isSketch && params.productionScope && params.productionScope.length > 0
          ? new Set(params.productionScope)
          : null;
      const carriedCuts = (() => {
        if (isSketch) return s.cuts; // ラフ run は本生成側 Map に触らない (従来どおり)
        if (!productionScope) return new Map<string, CutState>(); // 一括は全消去 (従来どおり)
        const next = new Map<string, CutState>();
        s.cuts.forEach((cut, cutId) => {
          if (!productionScope.has(cutId)) next.set(cutId, cut);
        });
        return next;
      })();
      return {
        ...runEmptyState,
        cuts: carriedCuts,
        sketchCuts: isSketch ? new Map<string, CutState>() : s.sketchCuts,
        pastRuns: archived,
        activeRunId: runId,
        params,
        status: "running" as const,
        // r3-5 (2026-07-28): 待機キューを次 run へ持ち越さない。
        // 自動発射経路は呼び出し前にキューを空化済みなので副作用はない。
        // 万一 perma-queue 状態から別経路で beginRun に到達しても、古いキューが
        // 次 run の終端で突然発射される持ち越し誤発射を防ぐ防御的クリア。
        pendingProductionCuts: [],
      };
    });
    // 23g (2026-08-03): フロント主導でパネルへ即時登録する。
    //
    // ## なぜ set() の後で呼ぶか
    // backend の `started` イベントが来る前に固まると、従来はパネルにジョブ自体が
    // 存在せず番犬が一切効かなかった (「4時間順番待ち」問題の一因)。ここで登録して
    // おけば lastEventAt=起動時刻 のジョブが必ず存在する。start は同一 id 冪等
    // (generationStatus.ts の `if (s.jobs[id]) return s;`) なので、後から backend の
    // `started` が来ても二重登録にならない。
    // クロスストア呼び出しは reducer 入れ子を避けるため set() の外に置く。
    const total =
      params.sketchMode === true
        ? params.sceneConstruction?.cuts.length
        : (params.productionScope?.length ?? params.sceneConstruction?.cuts.length);
    useGenerationStatus
      .getState()
      .start({ id: runId, kind: "storyboard", total: total || undefined });
  },

  pendingProductionCuts: [],

  clearPendingProduction: () => {
    const dropped = get().pendingProductionCuts.length;
    if (dropped === 0) return;
    set({ pendingProductionCuts: [] });
    useToasts.getState().push({
      kind: "warn",
      text: `順番待ちだった本生成 ${dropped} 件を取り消しました`,
      ttlMs: 6000,
    });
  },

  markCancelled: (runId) => {
    // r2-1 (2026-07-28): 中止時に待機キューを放置しない。
    // キューへ積んだ時点でユーザーには「走行中の本生成が終わり次第、自動で
    // 開始します」と約束しているが、その run を中止すると status='cancelled'
    // になり、キューの自動発射 (applyEvent の終端検知) は永久に発火しない。
    // さらに残したままだと、次の別 run が完走したときに古いキューが突然
    // 発射される持ち越し誤発射の経路にもなる。
    // 中止直後に別 run が勝手に走り出すのは意外性が高いので、自動発射では
    // なくクリア + 明示通知にする。
    // r3-NB1 (2026-07-28): ガードを B1/r2-3 と同じ「走行中判定」に揃える。
    // status === 'running' 限定だと、1カット失敗後で status='failed' だが
    // 他カットはまだ走っている窓で中止しても cancelled に落ちず、表示が
    // 'failed' のまま残り待機キューも破棄されない。
    const isRunActive = (s: StoryboardRunState) =>
      s.activeRunId === runId &&
      (s.status === "running" ||
        Array.from(s.cuts.values()).some((c) => c.status === "running") ||
        Array.from(s.sketchCuts.values()).some((c) => c.status === "running"));

    const before = get();
    const willCancel = isRunActive(before);
    const droppedCount = willCancel ? before.pendingProductionCuts.length : 0;

    // r3-2 (2026-07-28): 中止時に走行中カットを決着させる。
    // backend は中止 run のイベントを一切出さない (storyboard.rs:965-967 で
    // cancelled 検知後、976 の filter と 987 の else-if で CutConfirmed/CutFailed を
    // 抑止、1061-1064 で Completed 前に Err return) ため、放置すると running の
    // まま永久に残る。すると anyRunActive / productionRunActive / isRunActive の
    // cut-level 走行中判定が stale running を拾い続け、以後の
    // startProductionForCuts が常にキュー行きになるのに発射契機が二度と来ない
    // = 採用ゲートの恒久封鎖になる。Phase 3 カードのスピナー残留も同根。
    const settleRunningCuts = (map: Map<string, CutState>) => {
      if (!Array.from(map.values()).some((c) => c.status === "running")) {
        return map;
      }
      const next = new Map(map);
      next.forEach((cut, cutId) => {
        if (cut.status === "running") {
          next.set(cutId, {
            ...cut,
            status: "failed",
            error: "ユーザーが生成を中止しました",
          });
        }
      });
      return next;
    };

    set((s) =>
      isRunActive(s)
        ? {
            ...s,
            status: "cancelled" as const,
            cuts: settleRunningCuts(s.cuts),
            sketchCuts: settleRunningCuts(s.sketchCuts),
            pendingProductionCuts: [],
            uiDebugLog: [
              ...s.uiDebugLog,
              {
                ts: Date.now(),
                level: "info" as const,
                message: `markCancelled: ${runId} (待機キュー ${droppedCount} 件を破棄)`,
              },
            ].slice(-500),
          }
        : s,
    );

    if (droppedCount > 0) {
      useToasts.getState().push({
        kind: "warn",
        text: `順番待ちだった本生成 ${droppedCount} 件を取り消しました`,
        ttlMs: 6000,
      });
    }
  },

  // S3 (2026-07-28): 採用したラフのカットだけを本番へ送る。
  startProductionForCuts: async (cutIds) => {
    const wanted = Array.from(new Set(cutIds.map((id) => id.trim()).filter(Boolean)));
    if (wanted.length === 0) {
      useToasts.getState().push({
        kind: "error",
        text: "本生成に送るカットが選ばれていません。",
      });
      return false;
    }

    const current = get();

    // r3-B3 (2026-07-28): 同じカットの二重生成を入口で塞ぐ。
    // 従来の重複除去は待機配列内 (Set) だけで、「走行中の本生成 run の
    // productionScope に既に入っているカット」を見ていなかった。そのため
    // 連打すると2本目が同じカットを本番へ送り、生成枠を二重に焼いていた。
    //  (a) 走行中の本生成 run の productionScope に含まれるカット
    //  (b) 既に pendingProductionCuts に積まれているカット
    // を除外する。productionScope が undefined の走行中本生成 run は
    // 「全カット一括」なので、全カットが走行中とみなして全部除外する。
    const productionRunActive =
      current.activeRunId !== null &&
      current.params?.sketchMode !== true &&
      (current.status === "running" ||
        Array.from(current.cuts.values()).some((c) => c.status === "running"));
    const inFlightScope: Set<string> | null = productionRunActive
      ? current.params?.productionScope &&
        current.params.productionScope.length > 0
        ? new Set(current.params.productionScope)
        : null // null = 全カット一括が走行中 (= 全部除外)
      : new Set<string>(); // 本生成が走っていない = 除外対象なし
    const queuedSet = new Set(current.pendingProductionCuts);
    const targets = wanted.filter((id) => {
      if (queuedSet.has(id)) return false;
      if (inFlightScope === null) return false;
      return !inFlightScope.has(id);
    });
    if (targets.length === 0) {
      useToasts.getState().push({
        kind: "warn",
        text: "選択したカットは既に本番へ送信済みです",
        ttlMs: 4000,
      });
      return false;
    }

    // issue-3: 走行中の run があるなら差し替えず、キューに積んで待つ。
    // ここで beginRun してしまうと activeRunId が変わり、走行中 run の
    // イベントが applyEvent の別 run ガードで全部捨てられる。
    // r2-3 (2026-07-28): 判定を自動発射側の終端検知と対称にする。
    // status==='running' だけを見ていると、cutFailed 直後の
    // 「status='failed' だが他カットはまだ走行中」の窓 (次イベントまで
    // 数十秒〜数分) で手動押下されたときにキューを素通りし、beginRun が
    // 走行中 run を差し替えて issue-3 の「走行中 run のイベント全破棄」を
    // 踏む。cuts に running が1枚でも残っていれば走行中とみなす。
    // r3-B1 (2026-07-28): sketchMode の除外をやめ、**走行中の run が何であれ**
    // 順番待ちにする。ラフ生成中に「このカットを本番へ」を押すと beginRun が
    // activeRunId を上書きし、残りのラフイベントが applyEvent の別 run ガードで
    // 破棄される (ラフ run 乗っ取り) ためで、issue-3 と同じ故障を絵コンテ側で
    // 踏んでいた。ラフが終わってから本番が動き出すのが意図どおりの挙動。
    const anyRunActive =
      current.activeRunId !== null &&
      (current.status === "running" ||
        Array.from(current.cuts.values()).some((c) => c.status === "running") ||
        Array.from(current.sketchCuts.values()).some(
          (c) => c.status === "running",
        ));
    if (anyRunActive) {
      set((s) => ({
        pendingProductionCuts: Array.from(
          new Set([...s.pendingProductionCuts, ...targets]),
        ),
      }));
      useToasts.getState().push({
        kind: "info",
        text: "走行中の生成が終わり次第、自動で開始します",
        ttlMs: 4000,
      });
      return true;
    }

    // 直前の本生成 run のパラメータがあればそれを土台にする (参照画像・
    // アスペクト比・sceneConstruction などを作り直さないため)。
    // 無い場合 (絵コンテ run の params / run 未起動) は goal + 確定ラフから
    // 組み立てる。issue-2: 「先に一括本生成を1回」という前提は、枠を節約する
    // という採用ゲートの目的と矛盾するため撤去した。
    const base = current.params;
    const runId = crypto.randomUUID();
    let params: StoryboardRunParams;
    if (base && base.sketchMode !== true) {
      params = {
        ...base,
        runId,
        sketchMode: false,
        productionScope: targets,
      };
    } else {
      const goal = current.goal;
      // 共有 planChat が消えていても storyboard 側の控えから読む
      // (Sol 評価 blocking#3 / 2026-08-04)。読み順は useSceneConstruction と同じ。
      // ここを直読みのままにすると、漫画へ寄り道して戻った後の採用ゲート経由の
      // 本生成だけが「ゴール・カット構成が揃っていません」で落ちる。
      //
      // 2周目 (blocking#2): 直読みだと「別スキルで作られた planChat の構成」まで
      // 拾ってしまう。共有ストアを採るのは、それを storyboard 自身が作ったときだけ。
      // 判定は useSceneConstruction.pick と同じ (あちらから import すると
      // storyboardRun ↔ useSceneConstruction の循環になるのでここでは条件を直書きする)。
      const plan = usePlanChat.getState();
      const planIsOurs =
        plan.sceneConstruction !== null &&
        plan.sceneConstructionOwner === "gori-storyboard";
      const sceneConstruction = planIsOurs
        ? plan.sceneConstruction
        : current.sceneConstruction;
      if (!goal || !sceneConstruction || sceneConstruction.cuts.length === 0) {
        useToasts.getState().push({
          kind: "error",
          text: "本生成に必要なゴール・カット構成が揃っていません。",
        });
        return false;
      }
      const built = buildProductionParams({
        runId,
        goal,
        sceneConstruction,
        run: current,
        productionScope: targets,
      });
      params = built.params;
      // B1' 補完: i2v プロンプトが参照する確定絵コンテメタを退避しておく
      // (一括経路と同じ扱い。ここでは reset を挟まないので上書きのみ)。
      if (Object.keys(built.cutSketchMeta).length > 0) {
        set({ generationCutSketchMeta: built.cutSketchMeta });
      }
    }
    try {
      get().beginRun(runId, params);
      await storyboard.run(params);
      return true;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      set((s) =>
        s.activeRunId === runId
          ? { ...s, activeRunId: null, status: "failed" as const, lastError: msg }
          : s,
      );
      // r3-6 (2026-07-28): 自動発射経路では呼び出し前にキューを空化している
      // (発射側で set({ pendingProductionCuts: [] }))。起動に失敗してもキューは
      // 復元しないので、待機していたカットが静かに消えたことが分かるよう
      // 対象カット数をトーストに含める (自動再キューは無限リトライの危険が
      // あるため行わない)。
      useToasts.getState().push({
        kind: "error",
        text: `本生成の起動に失敗しました (自動開始待ちだった${params.productionScope?.length ?? 0}件を含む): ${msg}`,
        ttlMs: 6000,
      });
      return false;
    }
  },

  applyEvent: (e) => {
    // issue-3: 走行中だった run が終わったら、待たせていた採用ゲートのカットを
    // 自動発射する。set() の内側から startProductionForCuts を呼ぶと beginRun の
    // set が入れ子になるため、reducer の外で「running → 非running」の遷移だけを
    // 見て発射する。
    // r3-B1 (2026-07-28): 起点 run を本生成に限定しない。ラフ生成中の押下も
    // キューに積むようにした (startProductionForCuts の anyRunActive) ため、
    // ラフ run の終端 (completed / 全カット決着) でも発射しないとキューが
    // 永久待機になる。
    const beforeStatus = get().status;
    const wasSketchRun = get().params?.sketchMode === true;
    const wasActiveRun = get().activeRunId === e.runId;

    set((s) => {
      // 別 run の遅延イベントを現在の画面へ混ぜない。
      // run 未開始時も受け入れず、beginRun() で activeRunId が確定してから処理する。
      if (s.activeRunId === null || e.runId !== s.activeRunId) {
        return s;
      }
      const debugLog = [...s.debugLog, e];
      // B-6: イベント受信時刻を記録し、生成中カットの経過秒表示に使う。
      const lastEventAt = Date.now();
      // P19a: 現在の run の sketch_mode に応じて、どちらの Map を更新するか決める。
      // params が null の場合は started イベントを待っているので cuts (本生成) 側を仮で使う。
      const isSketch = s.params?.sketchMode === true;
      const sourceMap = isSketch ? s.sketchCuts : s.cuts;
      const targetMap = new Map(sourceMap);

      // 共通の patch ヘルパー: どちらの Map に書き込んだかを反映する
      const applyMap = <T extends object>(patch: T) =>
        isSketch
          ? ({ ...s, sketchCuts: targetMap, debugLog, lastEventAt, ...patch } as typeof s)
          : ({ ...s, cuts: targetMap, debugLog, lastEventAt, ...patch } as typeof s);

      // 右上の生成状況パネルへ橋渡し (2026-07-25 STΛCK指示)。
      // 絵コンテは他スキルとイベント名が違う(takeCompleted / cutConfirmed)ため専用に扱う。
      {
        const gs = useGenerationStatus.getState();
        const kind: GenerationKind = "storyboard";
        if (e.kind === "started") {
          gs.start({ id: e.runId, kind, total: e.totalCuts });
        } else if (e.kind === "cutStarted") {
          gs.setRunning(e.runId, e.takeCount ?? 1);
          gs.setStall(e.runId, null);
        } else if (e.kind === "cutConfirmed") {
          gs.addCompleted(e.runId);
          gs.setRunning(e.runId, 0);
        } else if (e.kind === "cutFailed") {
          gs.addFailed(e.runId);
          gs.setRunning(e.runId, 0);
          if (e.reason) gs.setStall(e.runId, stallFromFailure(e.reason));
        } else if (e.kind === "completed") {
          gs.finish(e.runId);
          setTimeout(() => useGenerationStatus.getState().clear(e.runId), 4000);
        }
      }

      if (e.kind === "started") {
        return {
          ...s,
          totalCuts: e.totalCuts,
          sceneGroups: e.sceneGroups,
          status: "running",
          debugLog,
          lastEventAt,
        };
      }

      if (e.kind === "cutStarted") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, {
          ...cut,
          sceneGroupId: e.sceneGroupId,
          status: "running",
          error: undefined,
          takeCount: e.takeCount,
        });
        return applyMap({ status: "running" as const });
      }

      if (e.kind === "takeCompleted") {
        const cut = ensureCut(targetMap, e.cutId);
        const takes = [
          ...cut.takes.filter((take) => take.takeId !== e.takeId),
          { takeId: e.takeId, imagePath: e.imagePath, scores: e.scores },
        ];
        targetMap.set(e.cutId, { ...cut, status: "review", takes });
        // r3-3 (2026-07-28): 既に決着した run の status を running に巻き戻さない。
        // regenerateCut は backend が TakeCompleted しか emit しない設計
        // (storyboard.rs:640-641) なので、終端後の作り直しでここに来たときに
        // 無条件で 'running' に戻すと、run が二度と終端に到達しなくなる
        // (決着は adoptTake/skipCut のローカル set で行われるため)。
        const settledRun =
          s.status === "completed" ||
          s.status === "failed" ||
          s.status === "cancelled";
        return applyMap(settledRun ? {} : { status: "running" as const });
      }

      if (e.kind === "cutConfirmed") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, {
          ...cut,
          status: "confirmed",
          selectedTakeId: e.selectedTakeId,
        });
        const settledStatus = terminalStatusFor(
          runScopedCuts(targetMap, s.params),
          s.totalCuts,
        );
        return applyMap({ status: settledStatus ?? ("running" as const) });
      }

      if (e.kind === "cutFailed") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, { ...cut, status: "failed", error: e.reason });
        // 全カットが決着済みなら 'failed' で終端確定。まだ走行中カットがある
        // 途中経過でも、既存挙動どおり status は 'failed' を出す
        // (キュー発射側は「全カット非running」を別途要求するので誤発射しない)。
        return applyMap({ status: "failed" as const, lastError: e.reason });
      }

      if (e.kind === "completed") {
        // 本生成 (sketch_mode=false) の完了時のみ採用画像をプロジェクトへ
        let projectAddResult:
          | { noProject: boolean; added: number; total: number }
          | null = null;
        if (!isSketch) {
          const scoped = runScopedCuts(targetMap, s.params);
          const activeProjectId = useActiveProject.getState().activeProjectId;
          let added = 0;
          if (activeProjectId) {
            scoped.forEach((cut) => {
              const take =
                cut.takes.find((item) => item.takeId === cut.selectedTakeId) ??
                cut.takes[0];
              if (take) {
                const item = useProjects.getState().addItem(activeProjectId, {
                  imagePath: take.imagePath,
                  prompt: s.params?.storyPrompt,
                  note: `storyboard ${cut.cutId}`,
                });
                if (item) added += 1;
              }
            });
          }
          projectAddResult = {
            noProject: !activeProjectId,
            added,
            total: scoped.size,
          };
          // rr2: プロジェクト追加まで到達したので未回収ポインタを消す。
          // ここを残すと、正常完了した run を次回起動で復元しようとする
          // (addItem は冪等なので item は増えないが、無意味なトーストが出る)。
          void clearLastRunPointer();
        }
        return {
          ...s,
          status: "completed",
          manifestPath: e.manifestPath,
          debugLog,
          lastEventAt,
          projectAddResult,
        };
      }

      return { ...s, debugLog, lastEventAt };
    });

    if (!wasActiveRun) return;

    // r3-4 (2026-07-28): 自力終端 ('failed' への確定遷移) を右上の生成状況
    // パネルへ橋渡しする。backend は部分失敗 run に Completed を出さないため、
    // これが無いとパネルのジョブが走行中表示のまま残る。
    // completed イベント経由の終端は set 内の gs.finish (橋渡しブロック) が
    // 既に処理しているので、ここでは 'failed' 確定だけを見る。
    {
      const afterStatus = get().status;
      if (beforeStatus !== "failed" && afterStatus === "failed") {
        const settledCuts = runScopedCuts(
          wasSketchRun ? get().sketchCuts : get().cuts,
          get().params,
        );
        const allSettled =
          get().totalCuts > 0 &&
          Array.from(settledCuts.values()).every((c) => c.status !== "running") &&
          settledCuts.size === get().totalCuts;
        if (allSettled) notifySelfTerminal(e.runId);
      }
    }

    // --- issue-3: キューの自動発射 ---
    // r3-3 (2026-07-28): 終端再判定+発射は共有ヘルパー settleAndFlushQueue に
    // 切り出した。applyEvent 以外 (adoptTake / skipCut) からも同じ判定に
    // 到達させるため。判定条件そのものは従来と同一。
    if (beforeStatus !== "running" && beforeStatus !== "failed") return;
    settleAndFlushQueue({ wasSketchRun });
  },

  setStatus: (status) => set({ status }),

  // ===== Phase 操作 =====
  setPhase: (phase) =>
    set((s) => ({
      phase,
      uiDebugLog: [
        ...s.uiDebugLog,
        { ts: Date.now(), level: "info" as const, message: `setPhase: ${phase}` },
      ].slice(-500),
    })),

  appendChatMessage: (msg) =>
    set((s) => {
      const finalized: StoryboardChatMessage = {
        id: msg.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: msg.role,
        text: msg.text,
        ts: msg.ts ?? Date.now(),
        probing: msg.probing,
      };
      return { chatMessages: [...s.chatMessages, finalized] };
    }),

  clearChat: () => set({ chatMessages: [] }),

  setGoal: (goal) => set({ goal }),

  setSceneConstruction: (scene) => set({ sceneConstruction: scene }),

  pushSketchVersion: (version) =>
    set((s) => ({
      sketchVersions: [...s.sketchVersions, version],
      activeSketchVersionId: version.versionId,
    })),

  setActiveSketchVersion: (versionId) => set({ activeSketchVersionId: versionId }),

  // P19b: 絵コンテ確定
  confirmSketchVersion: (versionId) =>
    set((s) => ({
      sketchVersions: s.sketchVersions.map((v) =>
        v.versionId === versionId
          ? { ...v, confirmed: true, confirmedAt: Date.now() }
          : v,
      ),
    })),

  updateSketchCut: (cutId, patch) =>
    set((s) => {
      if (s.sketchVersions.length === 0) return s;
      const targetVersionId = s.activeSketchVersionId ?? s.sketchVersions[s.sketchVersions.length - 1].versionId;
      const nextVersions = s.sketchVersions.map((v) => {
        if (v.versionId !== targetVersionId) return v;
        return {
          ...v,
          cuts: v.cuts.map((c) => (c.cutId === cutId ? { ...c, ...patch } : c)),
        };
      });
      return { ...s, sketchVersions: nextVersions };
    }),

  // run 関連をリセット。phase/goal/chatMessages は保持する。
  //
  // B1' 修正 (2026-06-06): 旧実装は sketchVersions / activeSketchVersionId を
  // 保持していた。そのため「前のストーリーで確定した絵コンテ」が次のストーリーの
  // 本生成に参照として流れ込む残留バグがあった (古い goal/run に紐づく確定絵コンテが
  // 残る)。reset 時に絵コンテ版も破棄し、今の goal/run に紐づく確定絵コンテだけが
  // 使われる状態にする。
  //
  // ラフ消失修正 (2026-07-28): reset() は startGeneration から呼ばれない。
  // ストーリー境界専用 (GoalChat の「↺ リセット」/ resetAll / skillReset)。
  // 本生成開始でラフを破棄するとユーザーが生成枠を消費した資産を失うため、
  // 「前ストーリーの Phase 2 表示残留」は破棄ではなく SketchReviewPanel の
  // goal キーガード (表示選択) で防ぐ。本生成参照への流入防止は B1 の goal
  // バインディング検査 (buildProductionParams) が独立に担保している。
  reset: () =>
    set((s) => ({
      ...runEmptyState,
      cuts: new Map<string, CutState>(),
      sketchCuts: new Map<string, CutState>(),
      sketchVersions: [],
      activeSketchVersionId: null,
      generationCutSketchMeta: {},
      // S3 issue-3: 待機中の採用ゲート行きカットも破棄する。次のストーリーに
      // 前のストーリーの cutId が持ち越されて誤発射するのを防ぐ。
      pendingProductionCuts: [],
      debugLog: [],
      uiDebugLog: [],
      pastRuns: s.pastRuns, // 過去 run のサマリーは保持
    })),

  resetPhases: () =>
    set({ ...phaseEmptyState }),

  setSketchRunStartedAt: (ts) => set({ sketchRunStartedAt: ts }),
  setGenerationRunStartedAt: (ts) => set({ generationRunStartedAt: ts }),
  setCutDisplayOrder: (order) => set({ cutDisplayOrder: order }),
  setKeyVisualPath: (path) => set({ keyVisualPath: path }),
  setSketchCandidatesPerCut: (n) => set({ sketchCandidatesPerCut: n }),
  setGenerationCandidatesPerCut: (n) => set({ generationCandidatesPerCut: n }),

  uiDebugLog: [],
  appendDebug: (entry) =>
    set((s) => ({ uiDebugLog: [...s.uiDebugLog, entry].slice(-500) })),

  adoptTake: (cutId, takeId) => {
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      const finalTakeId =
        takeId ?? cut.selectedTakeId ?? cut.takes[0]?.takeId ?? null;
      next.set(cutId, {
        ...cut,
        status: "confirmed",
        selectedTakeId: finalTakeId,
      });
      const log = [
        ...s.uiDebugLog,
        {
          ts: Date.now(),
          level: "info" as const,
          message: `adoptTake: ${cutId} → ${finalTakeId ?? "(none)"}`,
        },
      ];
      // P2.5 (2026-05-20): 採用結果をサイドカー JSON に永続化 (fire-and-forget)。
      // adoptions.json はディスク上の台帳。run 画面そのものは復元しないが、
      // 起動時の restoreUnrecoveredAdoptions が「プロジェクトへ未回収の採用」を
      // 拾ってプロジェクトへ復元する (rr2 2026-08-03)。
      // 復元が画像を特定できるよう、採用時点の imagePath も一緒に焼く。
      if (s.activeRunId && finalTakeId) {
        const adoptedTake =
          cut.takes.find((item) => item.takeId === finalTakeId) ?? cut.takes[0];
        void storyboard
          .persistAdoption(
            s.activeRunId,
            cutId,
            finalTakeId,
            adoptedTake?.imagePath,
          )
          .catch(() => {
            useToasts.getState().push({
              kind: "error",
              text: "採用結果を保存できませんでした。画面上の選択は残っています。",
            });
          });
      }
      return { ...s, cuts: next, uiDebugLog: log.slice(-500) };
    });
    // r3-3: 決着後に終端再判定 + 待機キューの発射を行う。
    settleLocalAdoption();
  },

  revertCut: (cutId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, status: "review" });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `revertCut: ${cutId} (confirmed → review)`,
          },
        ].slice(-500),
      };
    }),

  selectTake: (cutId, takeId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, selectedTakeId: takeId });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `selectTake: ${cutId} → ${takeId}`,
          },
        ].slice(-500),
      };
    }),

  // D1 (2026-08-05): 成果物からの個別除外。cuts Map は触らない (型定義側の
  // コメント参照: 実削除すると終端検知と待機キューが壊れる)。
  excludeCut: (cutId) =>
    set((s) => {
      if (s.excludedCutIds.includes(cutId)) return s;
      return {
        ...s,
        excludedCutIds: [...s.excludedCutIds, cutId],
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `excludeCut: ${cutId}`,
          },
        ].slice(-500),
      };
    }),

  includeCut: (cutId) =>
    set((s) => {
      if (!s.excludedCutIds.includes(cutId)) return s;
      return {
        ...s,
        excludedCutIds: s.excludedCutIds.filter((id) => id !== cutId),
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `includeCut: ${cutId}`,
          },
        ].slice(-500),
      };
    }),

  regenerateCut: (cutId) => {
    const state = get();
    const runId = state.activeRunId;
    const cut = state.cuts.get(cutId);
    // 2026-07-27: 多重起動ガード。ボタンが即再押下できるため、連打すると同じカットに
    // 対して生成が何本も並列で走っていた (Rust 側に重複ガードが無い)。
    // 既に running のカットへの再要求は黙って無視する。
    if (cut?.status === "running") return;
    if (!runId || !cut) {
      useToasts.getState().push({
        kind: "warn",
        text: "生成中のカットが見つかりませんでした。",
        ttlMs: 3000,
      });
      return;
    }

    // UI を先に「生成中」へ戻す (押した手応えを即返す)。実際の take 追加は
    // TakeCompleted イベント経由で入る。
    set((s) => {
      const target = s.cuts.get(cutId);
      if (!target) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...target, status: "running" });
      return { cuts: next };
    });

    // 参照画像・比率は **走っている run 自身の params** から取る
    // (Sol 評価 2周目 blocking#2 の付随指摘 / 2026-08-04)。
    //
    // 旧実装は共有ストア planChat.storyboardParams を直読みしていた。だが planChat は
    // 別スキルへ入った瞬間に消える共有ストアなので、漫画などへ寄り道して戻ってから
    // 個別カットを作り直すと、参照画像が空・比率が既定値 9:16 に化けていた
    // (本生成のときと違う絵が返る)。逆に別スキルの構成が残っていた場合は
    // そちらの参照画像を掴む。run params はこの run の生成時に確定して以後動かないので、
    // 「作り直し」が一括本生成と同じ入力を使うことが構造的に保証される。
    const runParams = state.params;
    const params = usePlanChat.getState().storyboardParams;
    void storyboard
      .regenerateCut({
        runId,
        cutId,
        characterReferenceImage:
          runParams?.characterReferenceImage ?? params?.character_reference_path ?? "",
        styleReferenceImage:
          runParams?.styleReferenceImage ?? params?.style_reference_path,
        additionalRefs: [],
        aspectRatio: runParams?.aspectRatio ?? params?.aspect_ratio ?? "9:16",
        cutDescription: cut.description ?? "",
      })
      .catch((err) => {
        // ここに来るのは Codex の起動失敗など **生成が始まる前のエラーだけ**。
        // 生成が始まった後の失敗は Rust が Ok を返した後に cutFailed イベントで届く
        // (commands/storyboard.rs)。そちらは applyEvent 側で処理される。
        // running のまま固まらないよう review / failed へ戻して理由を出す。
        set((s) => {
          const target = s.cuts.get(cutId);
          if (!target) return s;
          const next = new Map(s.cuts);
          next.set(cutId, { ...target, status: target.takes.length > 0 ? "review" : "failed" });
          return { cuts: next };
        });
        useToasts.getState().push({
          kind: "error",
          text: `作り直しに失敗しました: ${(err as Error)?.message ?? String(err)}`,
          ttlMs: 5000,
        });
      });
  },

  skipCut: (cutId) => {
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, status: "confirmed" });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `skipCut: ${cutId} (スキップして次へ)`,
          },
        ].slice(-500),
      };
    });
    // r3-3: 決着後に終端再判定 + 待機キューの発射を行う。
    settleLocalAdoption();
  },
  };
});
