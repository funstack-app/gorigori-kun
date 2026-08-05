import { create } from "zustand";
import { SKILL_UI_MODE_MAP, useSkillUiMode, type UiMode } from "./skillUiMode";
import { useToasts } from "./toasts";
import { useWorkspace, type WorkspaceTab } from "./workspace";

/**
 * 生成の「今どうなっているか」を1箇所に集約するストア。
 *
 * ## なぜこれが必要か (2026-07-25 STΛCK指示)
 *
 * 実機テストで「生成中のまま進まない」状態に遭遇したが、ログを見ると
 * codex exec が4本並列で正常に走っていた。つまり **止まっていたのではなく、
 * 動いているのが見えていなかった**。ユーザーからは区別が付かない。
 *
 * さらに従来のゲージ (GenerationGauge) は経過時間からの推定のみで実進捗を見ておらず、
 * 実際に完了しても 50% 付近を指したままになることがあった。
 *
 * そこで「何枚が実際に動いていて、何枚終わって、なぜ止まっているか」を
 * 全生成経路が同じ形で報告する場所を作る。UI はここだけを見れば状態が分かる。
 *
 * 設計の要点:
 * - **実イベントを正とする**。running / completed / failed は実際の worker から更新する。
 * - 推定は「経過時間」だけに留め、進捗率の主役にしない。
 * - 進まないときは理由 (stallReason) を必ず持つ。フリーズに見せない。
 */

/** 生成の種類。全スキルを網羅する (従来は batch/multiangle/storyboard の3種のみだった)。 */
export type GenerationKind =
  | "batch"
  | "multiangle"
  | "storyboard"
  | "expressionSet"
  | "comic"
  | "productSet"
  | "sceneRecreate"
  | "characterSheet"
  | "video"
  | "aiEdit";

/**
 * 中止 (cancel_generation) が実際に効く種類か (2026-07-27 追加 / 2026-07-28 更新)。
 *
 * ## なぜ要るか (Fable 5 評価者の指摘 blocking#1)
 *
 * 中止ボタンを全種類のジョブ行に出していたが、**Rust の run_id 台帳に届く経路は
 * batch / multiangle / storyboard 系だけ**。`beginDirectRun` で直接パネルへ登録する
 * 経路 (comic / aiEdit) の ID は Rust 側に存在しない。
 *
 * Phase 1 時点の cancel_generation は未知IDでも marked:true / terminated:0 を返したため、
 * UI が「中止しました（実行中のものは無く…）」と表示するのに何も止まらなかった
 * ——「効かないボタン + 嘘の完了表示」の同型再発だった。
 * **Phase 2 で Rust 側は found:false を返し印も付けない**ようになり、嘘の表示自体は解消済み
 * (worker_registry.rs の claim_cancellable_run)。
 *
 * ## comic を足した理由 (2026-07-28)
 *
 * comic は 2026-07-28 の direct-run レジストリ (`store/directRun.ts`) で、
 * **子 batch run (Rust 台帳に実在する `batch-<id>`) へ中止を橋渡しできる**ように
 * なったため追加した。親 run ID 自体は今も Rust に存在しないが、中止は
 * 保持している子 batchId へ届くので本物の中止になる。
 *
 * ここに種類を足す条件は次のいずれか:
 *   - その経路が Rust の `run_id` を台帳へ届ける (`WorkerPidGuard::register`)
 *   - directRun レジストリが子 batch を保持する (parent → children)
 *
 * aiEdit は配線が未了 (S-C) のため据え置く。
 * 「押せるが必ず失敗するボタンを置かない」原則自体は変えていない
 * ——本物の中止になるから出す、という判断。
 */
export const CANCELLABLE_KINDS: ReadonlySet<GenerationKind> = new Set<GenerationKind>([
  "batch",
  "multiangle",
  "storyboard",
  "expressionSet",
  "comic",
  "productSet",
  "characterSheet",
  "sceneRecreate",
]);

export function isCancellableKind(kind: GenerationKind): boolean {
  return CANCELLABLE_KINDS.has(kind);
}

export const GENERATION_KIND_LABEL: Record<GenerationKind, string> = {
  batch: "画像生成",
  multiangle: "マルチアングル",
  storyboard: "ストーリーカット",
  expressionSet: "表情差分",
  comic: "漫画",
  productSet: "EC納品セット",
  sceneRecreate: "シーン再現",
  characterSheet: "キャラクターシート",
  video: "動画生成",
  aiEdit: "AI編集",
};

/**
 * 生成の種類 → そのスキルの UiMode (cne / 2026-08-04)。
 *
 * ## なぜ「新しい対応表」ではなく UiMode 経由か
 *
 * skillId の正本は `SKILL_UI_MODE_MAP` (skillUiMode.ts) の
 * skillId → UiMode 一方向マップ。ここで skillId を直接持つと
 * **同じ対応関係が2箇所に増える**（スキル ID を変えたときに片方だけ腐る）。
 * そこで持つのは kind → UiMode だけにし、skillId は実行時に
 * `SKILL_UI_MODE_MAP` の逆引きで求める。対応表の正本は1つのまま。
 *
 * null は「専用スキル画面を持たない種類」= 作品モード (default) の生成。
 * batch / video / aiEdit がこれに当たり、遷移先は作品モードになる。
 */
const GENERATION_KIND_UI_MODE: Record<GenerationKind, UiMode | null> = {
  batch: null,
  video: null,
  aiEdit: null,
  multiangle: "multiAngle",
  storyboard: "storyboard",
  expressionSet: "expressionSet",
  comic: "comic",
  productSet: "productSet",
  sceneRecreate: "sceneRecreate",
  characterSheet: "characterRegister",
};

/**
 * その生成の種類が属するスキル ID。作品モードの生成なら null。
 *
 * `SKILL_UI_MODE_MAP` の逆引き。UiMode → skillId はほぼ 1:1 で、
 * 複数の skillId が同じ UiMode を指す場合は最初の1件を採る
 * (現状そのような重複は無い)。
 */
export function skillIdForKind(kind: GenerationKind): string | null {
  const uiMode = GENERATION_KIND_UI_MODE[kind];
  if (!uiMode) return null;
  const hit = Object.entries(SKILL_UI_MODE_MAP).find(([, mode]) => mode === uiMode);
  return hit?.[0] ?? null;
}

/**
 * 生成の種類 → その結果が実際に映るタブ (Sol 評価 blocking#5 / 2026-08-04)。
 *
 * ## なぜ種類別に要るか
 *
 * 専用スキル画面 (漫画・マルチアングル等) は「画像生成」タブの中に描かれるので、
 * 遷移時に generate へ揃えるのが正しい。しかし **作品モード扱いの3種は行き先が
 * それぞれ違う**:
 *
 *   - aiEdit … UiMode は default (専用スキル画面が無い) だが、実画面は「編集」タブ。
 *     全部 generate へ送っていたため、AI 編集のジョブ行を押すと編集結果ではなく
 *     画像生成タブが開いて「押したのに何も起きない」ように見えていた。
 *   - video … 実画面は「動画生成」タブ。
 *   - batch … 画像生成タブの生成タイムライン。
 *
 * UiMode (どのスキル画面か) とタブ (どの枠に描かれるか) は別の軸なので、
 * `GENERATION_KIND_UI_MODE` に相乗りさせず独立した表として持つ。
 */
const GENERATION_KIND_TAB: Record<GenerationKind, WorkspaceTab> = {
  // 作品モードの3種は行き先がそれぞれ違う (上のコメント)。
  aiEdit: "edit",
  video: "video",
  batch: "generate",
  // 専用スキル画面を持つ種類は、その画面が乗る「画像生成」タブ。
  multiangle: "generate",
  storyboard: "generate",
  expressionSet: "generate",
  comic: "generate",
  productSet: "generate",
  sceneRecreate: "generate",
  characterSheet: "generate",
};

/** その生成の結果が映るタブ。 */
export function tabForKind(kind: GenerationKind): WorkspaceTab {
  return GENERATION_KIND_TAB[kind];
}

/**
 * そのジョブが「いま画面に映っていないスキル」のものか (cne / 2026-08-04)。
 *
 * 完了通知を出すかどうかの判定に使う。表示中のスキルの完了は、その画面自身が
 * 結果を出すので**トーストを重ねない**（同じ完了を二重に知らせない）。
 *
 * drawer (ライブラリ等) を開いている間はスキル画面が隠れている (S1 の keep-alive で
 * マウントは維持されるが見えていない) ので、たとえ kind が現在のスキルと一致していても
 * バックグラウンド扱いにする。drawer の開閉は App.tsx が `setDrawerOpen` で伝える。
 */
function isBackgroundJob(kind: GenerationKind): boolean {
  // drawer (ライブラリ等) が被さっていればスキル画面は見えていない。
  if (drawerOpen) return true;
  // その生成の結果が映るタブを開いていなければ、画面には出ていない。
  // 種類別に見る (Sol 評価 blocking#5): スキル画面は「画像生成」タブの中だが、
  // AI 編集は「編集」タブ、動画は「動画生成」タブが定位置。
  if (useWorkspace.getState().activeTab !== tabForKind(kind)) return true;
  const uiMode = GENERATION_KIND_UI_MODE[kind];
  return useSkillUiMode.getState().activeUiMode !== (uiMode ?? "default");
}

/**
 * drawer (ライブラリ/プロジェクト/設定等) が開いているか。
 *
 * App.tsx の `useState` が正本で、ここはその写し。ストアに持ち上げないのは、
 * drawer の状態管理は S1 (keep-alive) が持つ責務で、こちらは
 * 「隠れているか」の一点だけを知りたいため。
 */
let drawerOpen = false;

export function setDrawerOpen(open: boolean) {
  drawerOpen = open;
}

/**
 * このジョブのスキル画面へ移動する (cne / 2026-08-04)。
 *
 * 遷移そのものは App.tsx が持つ (drawer を閉じる操作が App の useState だから)。
 * ここは「どこへ行きたいか」だけを CustomEvent で伝える。
 * `gori:open-settings` / `gori:open-skills` と同じ既存パターン。
 *
 * skillId が null (作品モードの生成) のときも発火する。App 側が
 * 「スキルを抜けて作品モードへ戻す」を担当する。
 */
export function focusGenerationKind(kind: GenerationKind) {
  window.dispatchEvent(
    new CustomEvent<FocusSkillDetail>("gori:focus-skill", {
      // タブは種類で変わる (Sol 評価 blocking#5)。App 側で決め打ちにせず、
      // 対応表を持つこちらから渡す。
      detail: { skillId: skillIdForKind(kind), tab: tabForKind(kind) },
    }),
  );
}

/** `gori:focus-skill` の payload。App.tsx の受け手と型を共有する。 */
export type FocusSkillDetail = {
  /** 移動先スキル。null は作品モード (専用スキル画面を持たない生成)。 */
  skillId: string | null;
  /** 移動先タブ。結果が実際に映る枠。 */
  tab: WorkspaceTab;
};

/** 進まない理由。UI がそのまま文言にできる粒度で持つ。 */
export type StallReason =
  | { type: "waiting-slot"; ahead: number } // 並列上限で順番待ち
  | { type: "waiting-user"; message: string } // 仕様上の停止 (人間の確認待ち)。異常ではない
  | { type: "auth-required"; service: string } // 認証切れ・未接続
  | { type: "no-response"; sinceMs: number } // 応答が来ない
  | { type: "stuck"; sinceMs: number } // イベント途絶。止まっている可能性が高い
  | { type: "error"; message: string; code?: string }; // 明示的な失敗

export type GenerationJob = {
  id: string;
  kind: GenerationKind;
  /**
   * 行の表示名。省略時は種別名 (GENERATION_KIND_LABEL) をそのまま使う。
   *
   * 同じ種別の生成を何本も並べられるようになると (SQ2 / 2026-08-04)、
   * 種別名だけでは行が全部同名になり、どれがどのキャラか区別できなくなる。
   * 「キャラクターシート: アリス」のように、その run が何を作っているかを入れる。
   */
  label?: string;
  /** 全体で何枚作る予定か。不明なら undefined。 */
  total?: number;
  /** 実際に完了した枚数 (実イベント由来。推定しない)。 */
  completed: number;
  /** 実際に失敗した枚数。 */
  failed: number;
  /** いま実行中の枚数 (並列稼働数)。STΛCK が知りたい値。 */
  running: number;
  startedAt: number;
  /** 最後にイベントを受け取った時刻。無反応検出に使う。 */
  lastEventAt: number;
  /** 進まない理由。null なら順調。 */
  stall: StallReason | null;
  /** 終了済みか。 */
  finished: boolean;
};

type GenerationStatusState = {
  jobs: Record<string, GenerationJob>;
  /** 生成を開始する。同じ id なら上書きせず既存を返す。 */
  start: (input: {
    id: string;
    kind: GenerationKind;
    total?: number;
    /** 行の表示名。同種の生成を並べる画面 (キャラ登録) で「どれか」を出すために使う。 */
    label?: string;
  }) => void;
  /** 並列稼働数を更新する。 */
  /**
   * ジョブ ID を差し替える (2026-07-27 追加)。
   *
   * バッチ生成はフロントが先に仮 ID (`local-...`) でカードを出し、Rust から
   * Started イベントが来た時点で本物の ID (`batch-...`) に差し替える。
   * このときパネル側のジョブ ID を移さないと、**「やめる」で Rust に渡す ID が
   * 仮 ID のままになり、Rust 側の run_id と一致せず1件も止まらない**
   * (実機で踏んだ: 「やめました」と出るのにカードは生成中のまま進む)。
   */
  migrateId: (fromId: string, toId: string) => void;
  setRunning: (id: string, running: number) => void;
  /** 1枚完了。 */
  addCompleted: (id: string, count?: number) => void;
  /** 1枚失敗。 */
  addFailed: (id: string, count?: number) => void;
  /** 進まない理由を設定/解除する。 */
  setStall: (id: string, stall: StallReason | null) => void;
  /**
   * 終了させる。
   *
   * `reason` は完了通知を出すかの判定に使う (cne / 2026-08-04)。既定の "completed" は
   * 生成が最後まで走り切った場合で、裏で終わったならトーストで知らせる。
   * 中止・破棄の経路は "cancelled" を渡す —— 止めたのに「完成しました」と
   * 出すのは、このアプリが潰してきた「表示と実態の食い違い」そのものだから。
   */
  finish: (id: string, reason?: "completed" | "cancelled") => void;
  /** 片付け。 */
  clear: (id: string) => void;
  /**
   * ユーザー操作でこの生成の追跡をやめる (2026-07-26 STΛCK指示)。
   *
   * ## できること / できないこと (重要)
   *
   * **走っている生成そのものは止まらない**。Rust 側に生成を中断するコマンドが
   * 存在しないため (`#[tauri::command]` に cancel/abort 系は無く、MCP 生成は
   * 同期完結でサーバー側に「実行中ジョブ」を持たない — batches.ts cancelBatch の
   * コメント参照)、フロントからできるのは「待つのをやめて結果を捨てる」だけ。
   *
   * したがって UI の文言も「中止」ではなく **表示を消す** と書く。
   * 押せるのに効かないボタンを作らないことが、このアプリの一貫した方針。
   */
  dismiss: (id: string) => void;
};

/**
 * 裏で終わった生成だけをトーストで知らせる (cne / 2026-08-04)。
 *
 * ## なぜ「裏だけ」なのか
 *
 * 表示中のスキル画面は、完了を自分の画面で示す (漫画ならページが並ぶ)。
 * そこへトーストを重ねると、同じ完了を2回知らせることになる。
 * 通知が本当に要るのは **その画面を見ていないとき** ——
 * 別スキルで作業中、あるいはライブラリを見ている間に終わった場合だけ。
 *
 * 失敗が混じっていたら「完成」と言い切らない (件数をそのまま出す)。
 */
function notifyIfBackgroundFinish(job: GenerationJob) {
  if (!isBackgroundJob(job.kind)) return;
  const label = GENERATION_KIND_LABEL[job.kind];
  const text =
    job.failed > 0
      ? `${label}: ${job.completed}件 完成 / ${job.failed}件 失敗`
      : `${label}: ${job.completed}件 完成しました`;
  useToasts.getState().push({
    kind: job.failed > 0 ? "warn" : "success",
    text,
    ttlMs: 8000,
    action: { label: "開く", run: () => focusGenerationKind(job.kind) },
  });
}

export const useGenerationStatus = create<GenerationStatusState>((set) => ({
  jobs: {},

  start: ({ id, kind, total, label }) =>
    set((s) => {
      if (s.jobs[id]) return s;
      const now = Date.now();
      return {
        jobs: {
          ...s.jobs,
          [id]: {
            id,
            kind,
            label,
            total,
            completed: 0,
            failed: 0,
            running: 0,
            startedAt: now,
            lastEventAt: now,
            stall: null,
            finished: false,
          },
        },
      };
    }),

  migrateId: (fromId, toId) =>
    set((s) => {
      const job = s.jobs[fromId];
      if (!job || fromId === toId) return s;
      const next = { ...s.jobs };
      delete next[fromId];
      // 移行先に既にジョブがある場合は上書きしない (二重登録の保護)。
      next[toId] = next[toId] ?? { ...job, id: toId };
      return { jobs: next };
    }),

  setRunning: (id, running) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, running, lastEventAt: Date.now(), stall: running > 0 ? null : job.stall },
        },
      };
    }),

  addCompleted: (id, count = 1) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      return {
        jobs: {
          ...s.jobs,
          [id]: {
            ...job,
            completed: job.completed + count,
            lastEventAt: Date.now(),
            stall: null,
          },
        },
      };
    }),

  addFailed: (id, count = 1) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, failed: job.failed + count, lastEventAt: Date.now() },
        },
      };
    }),

  setStall: (id, stall) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      return { jobs: { ...s.jobs, [id]: { ...job, stall } } };
    }),

  finish: (id, reason = "completed") =>
    set((s) => {
      const job = s.jobs[id];
      if (!job) return s;
      // 二重 finish で通知が二度出ないようにする (既に finished なら何もしない)。
      // storyboard 系は completed イベントと中止経路の両方から finish が来る。
      if (job.finished) return s;
      if (reason === "completed") notifyIfBackgroundFinish(job);
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, finished: true, running: 0, lastEventAt: Date.now(), stall: null },
        },
      };
    }),

  clear: (id) =>
    set((s) => {
      if (!s.jobs[id]) return s;
      const next = { ...s.jobs };
      delete next[id];
      return { jobs: next };
    }),

  // 実体は clear と同じ「この id の追跡をやめる」。別名にしているのは、
  // 自動の片付け (clear) と、ユーザーが自分の意思で消したもの (dismiss) を
  // 呼び出し側の意図として区別できるようにするため。
  dismiss: (id) =>
    set((s) => {
      if (!s.jobs[id]) return s;
      const next = { ...s.jobs };
      delete next[id];
      return { jobs: next };
    }),
}));

/**
 * 実進捗を優先した進捗率を返す。
 *
 * total が分かっていれば **完了枚数 ÷ 総数** をそのまま使う (推定しない)。
 * total が不明なときだけ経過時間で補間するが、その場合も 90% で頭打ちにし、
 * 「終わっていないのに 100% に見える」ことを防ぐ。
 */
export function jobPercent(job: GenerationJob, expectedSeconds: number): number {
  if (job.finished) return 100;
  const settled = job.completed + job.failed;
  if (job.total && job.total > 0) {
    return Math.min(99, (settled / job.total) * 100);
  }
  const elapsed = (Date.now() - job.startedAt) / 1000;
  if (expectedSeconds <= 0) return 0;
  return Math.min(90, 90 * (elapsed / expectedSeconds));
}

/**
 * 無反応と見なす閾値。これを超えたら理由を出す。
 *
 * ## なぜ 90秒 → 6分 に延ばしたか (2026-07-26 STΛCK 報告)
 *
 * 90秒は**正常な生成に対して短すぎた**。実測: EC納品セット(6枚同時)は
 * 1分38秒の時点でまだ 0/6 で、この間ずっと黄色い警告アイコン付きで
 * 「98 秒間 応答がありません」が出ていた。何も壊れていないのに
 * 失敗したように見えるため、ユーザーが不安になって中断してしまう。
 *
 * 画像生成は 1枚あたり数十秒〜、複数枚の同時生成では数分かかるのが普通で、
 * その間サーバーからの中間報告は来ない。「応答が無い」のは異常ではなく既定。
 *
 * 6分にした根拠: 上記の実測(6枚で 1分38秒 経過時点で未完了)に対し、
 * 枚数が増えた場合の余白を見込む。境界ぴったりに合わせず余裕を取る。
 * ここを超えて無反応なら、本当に固まっている可能性が高い。
 *
 * **警告そのものは消さない**。本当に固まったときに何も出ないほうが困る。
 * 変えるのは「いつ出すか」と「どう言うか」だけ (describeStall 参照)。
 */
export const NO_RESPONSE_THRESHOLD_MS = 360_000;

/**
 * 待機のみ (running=0) のジョブ用。**全ジョブ横断で** イベント無しがこの時間を
 * 超えたら stuck。ジョブ単体の沈黙で判定してはいけない: 別ジョブが全スロットを
 * 占有している間、後続ジョブは自分のイベントがゼロのまま何十分も正常に待つ
 * (セマフォ6は全ジョブ共有)。「どのジョブも進んでいない」ときだけ異常。
 */
export const WAITING_STUCK_THRESHOLD_MS = 600_000; // 10分

/**
 * 実行中 (running>0) のジョブがイベント無しでこの時間を超えたら stuck。
 * gen server の GENERATION timeout は 900秒 (gen_server.rs:32) なので、
 * イベント経路が生きていれば 15分以内に必ず何かが届く。20分無イベント=経路死。
 */
export const RUNNING_STUCK_THRESHOLD_MS = 1_200_000; // 20分

/**
 * 未終了ジョブ全体で最後にイベントが届いた時刻。未終了ジョブが無ければ null。
 * 待機のみジョブは「キュー全体が流れているか」で健全性を判定するために使う。
 */
export function globalLastEventAt(jobs: Record<string, GenerationJob>): number | null {
  let latest: number | null = null;
  for (const job of Object.values(jobs)) {
    if (job.finished) continue;
    if (latest === null || job.lastEventAt > latest) latest = job.lastEventAt;
  }
  return latest;
}

/**
 * 表示すべき stall を状態から導出する (23g / 2026-08-03)。
 *
 * ## なぜコンポーネントから出したか
 *
 * 従来この判定は GenerationStatusPanel の JobRow にインラインで書かれており、
 * (a) `running > 0` が必須だったため **待機のみのジョブは永遠に無警告** になり、
 * (b) `waiting-slot` はどこからも set されない死にコードだった。
 * 純関数へ出して、待機ジョブの番犬と waiting-slot の導出配線をここに集約する。
 *
 * `globalLast` は `globalLastEventAt(jobs)` の値 (呼び出し側で1回計算して渡す)。
 */
export function deriveEffectiveStall(
  job: GenerationJob,
  now: number,
  globalLast: number | null,
): StallReason | null {
  if (job.finished) return null;
  // 明示 stall のうち、行動が決まっているもの (エラー/認証) は最優先で残す
  if (job.stall?.type === "error" || job.stall?.type === "auth-required") return job.stall;
  const silentFor = now - job.lastEventAt;
  if (job.running > 0) {
    // 実行中: このジョブ自身の沈黙で判定してよい (実行中なら自分のイベントが来るはず)
    if (silentFor > RUNNING_STUCK_THRESHOLD_MS) return { type: "stuck", sinceMs: silentFor };
  } else {
    // 待機のみ: 全体の沈黙で判定 (他ジョブが進んでいる間の順番待ちは正常)
    const globalSilentFor = now - (globalLast ?? job.lastEventAt);
    if (globalSilentFor > WAITING_STUCK_THRESHOLD_MS) {
      return { type: "stuck", sinceMs: globalSilentFor };
    }
  }
  if (job.stall) return job.stall; // waiting-user 等
  if (job.running > 0 && silentFor > NO_RESPONSE_THRESHOLD_MS) {
    return { type: "no-response", sinceMs: silentFor };
  }
  // 死にコードだった waiting-slot をここで初めて配線する (導出)
  const settled = job.completed + job.failed;
  const waiting =
    typeof job.total === "number" ? Math.max(0, job.total - settled - job.running) : 0;
  if (job.running === 0 && waiting > 0) return { type: "waiting-slot", ahead: waiting };
  return null;
}

/**
 * 失敗理由の文字列から、UI に出す stall を組み立てる。
 *
 * 認証切れは「設定から再ログイン」という次の行動が決まっているので専用扱いにする。
 * それ以外は原文をそのまま見せる (Rust 側の humanize_generation_failure が
 * 既に日本語化しており、エラーコードが含まれる場合もそのまま残したい)。
 */
export function stallFromFailure(reason: string): StallReason {
  const lower = (reason ?? "").toLowerCase();
  const authHints = [
    "unauthorized",
    "not authenticated",
    "認証が切れ",
    "認証切れ",
    "再ログイン",
    "401",
  ];
  if (authHints.some((hint) => lower.includes(hint))) {
    return { type: "auth-required", service: "画像生成サービス" };
  }
  // HTTP ステータスや既知のエラーコードを拾えたら code として分離して見せる。
  const codeMatch = reason?.match(/\b(4\d{2}|5\d{2}|E[A-Z_]{3,})\b/);
  return {
    type: "error",
    message: reason || "原因不明のエラー",
    code: codeMatch?.[1],
  };
}

/**
 * cutStarted / cutCompleted / cutFailed / completed 形式のイベントを持つ run store
 * (characterSheetRun / multiAngleRun / storyboardRun 系) の共通橋渡し。
 *
 * cuts の現在状態から running を毎回数え直すので、イベントの取りこぼしがあっても
 * 表示が破綻しない。呼び出し側は「イベント適用前の state」を渡す。
 */
export function syncCutRunStatus(
  kind: GenerationKind,
  cuts: Record<string, { status: string }>,
  totalCuts: number,
  e:
    | { kind: "started"; runId: string }
    | { kind: "cutStarted"; runId: string }
    | { kind: "cutCompleted"; runId: string }
    | { kind: "cutFailed"; runId: string; reason?: string }
    | { kind: "completed"; runId: string }
    | { kind: string; runId: string; reason?: string },
) {
  const status = useGenerationStatus.getState();
  const runningNow = Object.values(cuts).filter((c) => c.status === "running").length;

  switch (e.kind) {
    case "started":
      status.start({ id: e.runId, kind, total: totalCuts || undefined });
      break;
    case "cutStarted":
      // state はまだ更新前なのでこのイベント分を +1 する
      status.setRunning(e.runId, runningNow + 1);
      break;
    case "cutCompleted":
      status.addCompleted(e.runId);
      status.setRunning(e.runId, Math.max(0, runningNow - 1));
      break;
    case "cutFailed":
      status.addFailed(e.runId);
      status.setRunning(e.runId, Math.max(0, runningNow - 1));
      if (e.reason) status.setStall(e.runId, stallFromFailure(e.reason));
      break;
    case "completed":
      status.finish(e.runId);
      setTimeout(() => useGenerationStatus.getState().clear(e.runId), 4000);
      break;
  }
}

/**
 * images.generateBatch を直接呼ぶスキル (漫画・シーン再現など) 用のラッパー。
 *
 * これらのスキルは batches ストアを経由せず ipc を直叩きするため、
 * batch 側の橋渡しでは拾えない。1件ずつ順に呼ぶ構造なので、
 * 「全体で何件やるか」を最初に宣言し、各件の前後で running を上下させる。
 *
 * 使い方:
 *   const track = beginDirectRun("comic", panels.length);
 *   for (const panel of panels) {
 *     await track.step(() => images.generateBatch({...}));
 *   }
 *   track.done();
 */
export function beginDirectRun(kind: GenerationKind, total: number, id?: string) {
  const runId = id ?? `${kind}-${Date.now()}`;
  const status = useGenerationStatus.getState();
  status.start({ id: runId, kind, total: total || undefined });

  return {
    id: runId,
    /** 1件の生成を実行し、成否を状況へ反映する。例外はそのまま投げ直す。 */
    async step<T>(run: () => Promise<T>): Promise<T> {
      const s = useGenerationStatus.getState();
      s.setRunning(runId, 1);
      try {
        const result = await run();
        useGenerationStatus.getState().addCompleted(runId);
        useGenerationStatus.getState().setRunning(runId, 0);
        return result;
      } catch (err) {
        const st = useGenerationStatus.getState();
        st.addFailed(runId);
        st.setRunning(runId, 0);
        st.setStall(runId, stallFromFailure(String((err as Error)?.message ?? err)));
        throw err;
      }
    },
    /** 1件開始したことを記録する (step を使わず自前で await する経路用)。 */
    markStarted() {
      useGenerationStatus.getState().setRunning(runId, 1);
    },
    /** 1件成功したことを記録する。 */
    markCompleted() {
      const s = useGenerationStatus.getState();
      s.addCompleted(runId);
      s.setRunning(runId, 0);
    },
    /** 失敗を明示的に記録する (例外を投げない経路用)。 */
    fail(reason: string) {
      const s = useGenerationStatus.getState();
      s.addFailed(runId);
      s.setRunning(runId, 0);
      s.setStall(runId, stallFromFailure(reason));
    },
    done() {
      useGenerationStatus.getState().finish(runId);
      setTimeout(() => useGenerationStatus.getState().clear(runId), 4000);
    },
  };
}

/**
 * 全ジョブを横断した「いまの合計」。
 *
 * ## なぜこれが要るか (2026-07-27)
 *
 * ヘッダー(BoardHeader)は従来 batches / storyboardRun / multiAngleRun の
 * **3ストアを直接見て** 実行中かどうかを判定していた。そのため
 * 残り8スキル(表情差分・漫画・シーン再現・EC納品セット・キャラ登録・3D等)が
 * 実行中でも「生成準備OK」と表示され、**動いているのに何もしていないと嘘をつく**
 * 状態になっていた。実ユーザーFB「この画像のまま20分くらい動かない」
 * 「生成中から何分かかるか分からない」の直接の原因。
 *
 * 集計をこの1関数に寄せ、ヘッダーも右上パネルも**ここだけを見る**ようにする。
 * 表示箇所ごとに別々の計算をすると、同じ画面で数字が食い違う。
 *
 * `waiting` は「順番待ちで、まだ1枚も走り出していないジョブの残り枚数」。
 * セマフォ上限6で30枚頼むと24枚が待つが、この事実が今までUIに一切出ていなかった。
 */
export type GenerationTotals = {
  /** いま並列で走っている枚数 */
  running: number;
  /** 順番待ちの枚数 (total が分かっているジョブのみ数えられる) */
  waiting: number;
  completed: number;
  failed: number;
  /** 終了していないジョブがあるか。ヘッダーのバッジ表示に使う */
  active: boolean;
  /** 未終了ジョブの数。1件なら種類名を出す等の分岐に使う */
  activeJobCount: number;
};

export function selectTotals(jobs: Record<string, GenerationJob>): GenerationTotals {
  let running = 0;
  let waiting = 0;
  let completed = 0;
  let failed = 0;
  let activeJobCount = 0;

  for (const job of Object.values(jobs)) {
    completed += job.completed;
    failed += job.failed;
    if (job.finished) continue;
    activeJobCount += 1;
    running += job.running;
    if (typeof job.total === "number") {
      // 待ち = 予定枚数 - (決着済み + 実行中)。負にはしない。
      const remaining = job.total - (job.completed + job.failed + job.running);
      if (remaining > 0) waiting += remaining;
    }
  }

  return { running, waiting, completed, failed, active: activeJobCount > 0, activeJobCount };
}

/** 進まない理由を人間の言葉にする。UI はこれを表示すればよい。 */
export function describeStall(stall: StallReason): string {
  switch (stall.type) {
    case "waiting-slot":
      return stall.ahead > 0 ? `順番待ち（残り ${stall.ahead} 件）` : "順番待ち";
    case "waiting-user":
      return stall.message;
    case "auth-required":
      return `${stall.service} の認証が切れています。設定から再ログインしてください`;
    case "no-response": {
      // 2026-07-26: 「N秒間 応答がありません」は、実際には正常に生成中でも
      // 出るため「失敗した」と誤解される (STΛCK 報告)。事実 (時間が経っている)
      // は伝えつつ、壊れたと読めない言い方にする。秒でなく分で言うのは、
      // ここに到達する時点で既に数分経っており、秒表示だと桁が大きく
      // 不安を煽るため。
      const minutes = Math.max(1, Math.round(stall.sinceMs / 60_000));
      return `${minutes}分ほど時間がかかっています（生成は続いています）`;
    }
    case "stuck": {
      // no-response と違い、こちらは「進捗の連絡が来ていない」= 経路が死んでいる
      // 可能性を伝える。断定はしない (生きている長時間生成を殺さないため)。
      const minutes = Math.max(1, Math.round(stall.sinceMs / 60_000));
      return `${minutes}分以上、進捗の連絡がありません。生成が止まっている可能性があります`;
    }
    case "error":
      return stall.code ? `エラー ${stall.code}: ${stall.message}` : `エラー: ${stall.message}`;
  }
}
