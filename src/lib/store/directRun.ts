import { cancelGeneration, type ImageBatchEvent } from "../ipc";
import {
  stallFromFailure,
  useGenerationStatus,
} from "./generationStatus";

/**
 * direct-run レジストリ（2026-07-28 追加）。
 *
 * ## 何を繋ぐものか
 *
 * 漫画のようなスキルは `beginDirectRun("comic", N)` で右上パネルに
 * **表示専用の親ジョブ**を作り、その中で `images.generateBatch` を N 回呼ぶ。
 * このとき生まれる子 batch は Rust の実行中 run 台帳に実在する
 * (`batch-<id>` + `ActiveRunGuard`) ので `cancel_generation` で本当に止められる。
 *
 * 足りなかったのは「フロントが実行中の子 batchId を知る経路」だけだった。
 * そこで親→子の対応をこの台帳が持ち、
 *   - 中止  : 親の中止 = 保持している全子への `cancel_generation`
 *   - 進捗  : 子の worker イベントを親ジョブへ橋渡し（自己申告しない）
 *   - 幽霊  : 消費したイベントは batches ストアへ渡さず、カードを作らせない
 * を成立させる。
 *
 * ## なぜ自己申告(markStarted/markCompleted)をやめたか
 *
 * 並列発行では「発行済み」と「実際に走り出した」が一致しない
 * (Rust の GLOBAL_GEN_SEMAPHORE で順番待ちになる)。発行時に running を上げると
 * 8件全部が「実行中」に見え、セマフォ待ちと区別できない。
 * generationStatus の設計思想「実イベントを正とする」に合わせ、
 * running は必ず Rust から届いた workerStarted/Completed/Failed で動かす。
 *
 * Zustand は使わない。UI が購読するのは generationStatus 側の親ジョブであり、
 * この台帳自体は描画されないため、モジュールスコープの Map で足りる。
 */

type DirectRunEntry = {
  /** 未決着の子 batchId。 */
  children: Set<string>;
  /** 子ごとの実行中 worker 数。親の running はこの合計。 */
  runningByChild: Map<string, number>;
  /** 中止要求済みか。以後に届いた Started も即中止する。 */
  cancelRequested: boolean;
  /**
   * 中止要求後に遅れて Started が届いた子への `cancel_generation` の待ち行列。
   *
   * 以前は `void cancelGeneration(...)` の投げっぱなしで、結果も失敗も
   * どこにも届かなかった（親の集計にも入らない）。中止の締めでこれを待って
   * terminated を足し込み、失敗は親のエラー表示へ出す。
   */
  lateCancels: Promise<{ found: boolean; terminated: number }>[];
  /** 中止要求後に届いた子の cancel が失敗したときのエラー通知先。 */
  onLateCancelError?: (error: unknown) => void;
  onCancel?: () => void;
};

const parents = new Map<string, DirectRunEntry>();
/** 子 batchId → 親 run ID の逆引き。 */
const childToParent = new Map<string, string>();

/** 親を登録する。beginDirectRun の直後に呼ぶ。 */
export function registerDirectRunParent(
  parentId: string,
  opts?: { onCancel?: () => void; onLateCancelError?: (error: unknown) => void },
): void {
  const existing = parents.get(parentId);
  if (existing) {
    // 冪等。コールバックだけ最新に差し替える (HMR の二重登録対策)。
    if (opts?.onCancel) existing.onCancel = opts.onCancel;
    if (opts?.onLateCancelError) existing.onLateCancelError = opts.onLateCancelError;
    return;
  }
  parents.set(parentId, {
    children: new Set(),
    runningByChild: new Map(),
    cancelRequested: false,
    lateCancels: [],
    onCancel: opts?.onCancel,
    onLateCancelError: opts?.onLateCancelError,
  });
}

/** 親を解放する（全子決着後 / run 終了の finally で）。逆引きも掃除する。 */
export function releaseDirectRunParent(parentId: string): void {
  const entry = parents.get(parentId);
  if (!entry) return;
  for (const childId of entry.children) {
    if (childToParent.get(childId) === parentId) childToParent.delete(childId);
  }
  parents.delete(parentId);
}

/** 中止ボタンの分岐判定に使う。 */
export function isDirectRunParent(parentId: string): boolean {
  return parents.has(parentId);
}

/** 親の running を「全子の running 合計」で置き直す（絶対値で更新する）。 */
function syncParentRunning(parentId: string, entry: DirectRunEntry): void {
  let running = 0;
  for (const n of entry.runningByChild.values()) running += n;
  useGenerationStatus.getState().setRunning(parentId, running);
}

/** 子を台帳から外す（completed / cancelled で決着したとき）。 */
function detachChild(parentId: string, entry: DirectRunEntry, childId: string): void {
  entry.children.delete(childId);
  entry.runningByChild.delete(childId);
  if (childToParent.get(childId) === parentId) childToParent.delete(childId);
  syncParentRunning(parentId, entry);
}

/**
 * image-batch イベントを親ジョブへ橋渡しする。
 * 消費した（= applyEvent に渡してはいけない）とき true を返す。
 *
 * - started: `sourceTag` が **登録済み親** のときだけ消費する。
 *   未登録の sourceTag は消費しない（通常 batch として振る舞わせる。
 *   親が既に解放済みの孤児 run をカードごと不可視にしないための安全側）。
 * - その他: batchId が登録済みの子のときだけ消費する。
 */
export function routeDirectRunBatchEvent(e: ImageBatchEvent): boolean {
  if (e.kind === "started") {
    const parentId = e.sourceTag;
    if (!parentId) return false;
    const entry = parents.get(parentId);
    if (!entry) return false;

    // 中止済みの親に遅れて届いた開始 = レース窓。即座に止める。
    //
    // 台帳へ登録してから止める。登録しないと、この子の完了/中止イベントが
    // 親へ橋渡しされず（childToParent に無いので通常経路へ抜け）、幽霊カードに
    // なるうえ親の集計にも入らない。cancel の結果は lateCancels に積んで
    // 中止の締め (cancelDirectRun) で待ち合わせる。投げっぱなしにしない。
    if (entry.cancelRequested) {
      entry.children.add(e.batchId);
      entry.runningByChild.set(e.batchId, entry.runningByChild.get(e.batchId) ?? 0);
      childToParent.set(e.batchId, parentId);
      entry.lateCancels.push(
        cancelGeneration(e.batchId).catch((error) => {
          entry.onLateCancelError?.(error);
          return { found: false, terminated: 0 };
        }),
      );
      return true;
    }

    entry.children.add(e.batchId);
    entry.runningByChild.set(e.batchId, entry.runningByChild.get(e.batchId) ?? 0);
    childToParent.set(e.batchId, parentId);
    return true;
  }

  const parentId = childToParent.get(e.batchId);
  if (!parentId) return false;
  const entry = parents.get(parentId);
  if (!entry) {
    // 親が既に解放済み。逆引きだけ掃除して、イベントは通常経路へ返す。
    childToParent.delete(e.batchId);
    return false;
  }

  const status = useGenerationStatus.getState();
  const current = entry.runningByChild.get(e.batchId) ?? 0;

  switch (e.kind) {
    case "workerStarted":
      entry.runningByChild.set(e.batchId, current + 1);
      syncParentRunning(parentId, entry);
      break;
    case "workerCompleted":
      entry.runningByChild.set(e.batchId, Math.max(0, current - 1));
      status.addCompleted(parentId);
      syncParentRunning(parentId, entry);
      break;
    case "workerFailed":
      entry.runningByChild.set(e.batchId, Math.max(0, current - 1));
      status.addFailed(parentId);
      status.setStall(parentId, stallFromFailure(e.error));
      syncParentRunning(parentId, entry);
      break;
    case "completed":
    case "cancelled":
      // 親の finish はここではしない。親の総枚数と子 batch の対応は
      // 呼び出し側 (ComicWorkspace) が知っているので、finish は
      // 呼び出し側の track.done() と中止経路に任せる。
      detachChild(parentId, entry, e.batchId);
      break;
  }
  return true;
}

/**
 * 親 run の中止。
 *
 * `found` は「この親の中止が成立したか」。**登録済みの親なら常に true** にする
 * (2026-07-28 修正)。以前は「子への cancel_generation のいずれかが found:true」
 * を条件にしていたため、発射直後（子の Started がまだ1件も届いていない窓）で
 * 中止すると、実態は cancelRequested によって全子が止まるのに
 * UI だけ「中止できませんでした。この生成は見つかりません」と出ていた
 * ＝表示と実態が真逆。親は台帳に実在し、中止要求は確かに成立しているので
 * 「見つからない」は嘘になる。
 *
 * 子0件でも `cancelRequested` を立てた時点で「新しい生成は開始されません」は真。
 * 中止要求のあとに Started が遅着した子は、その場で台帳へ登録され
 * cancel_generation が飛ぶ。ここではその結果まで待ち合わせて
 * terminated に足し込み、親を確定した数で決着させる。
 *
 * ## failedChildren（2026-07-28 追加）
 *
 * 子への `cancel_generation` が **reject した / `found:false` を返した** 件数。
 * 以前はどちらも握りつぶして親を「止まりました」と表示していたが、
 * 止まっていない子が残っているのに成功表示になるのは、このアプリが
 * 潰そうとしている「表示と実態の食い違い」そのもの。
 * 呼び出し側はこれが 1 以上なら成功表示にしない。
 */
export async function cancelDirectRun(
  parentId: string,
): Promise<{ found: boolean; terminated: number; failedChildren: number }> {
  const entry = parents.get(parentId);
  // 親が台帳に無い = 既に解放済み。こちらは本当に「見つからない」。
  if (!entry) return { found: false, terminated: 0, failedChildren: 0 };

  // 以後に届く Started も即中止する (発行済みだが Started 未達のレース窓)。
  entry.cancelRequested = true;
  entry.onCancel?.();

  const childIds = [...entry.children];
  let terminated = 0;
  let failedChildren = 0;
  const reports = await Promise.allSettled(
    childIds.map((childId) => cancelGeneration(childId)),
  );
  for (const report of reports) {
    // reject = IPC 自体が失敗。その子が止まったかは分からない＝止まっていない扱い。
    if (report.status !== "fulfilled") {
      failedChildren += 1;
      continue;
    }
    // found:false = Rust がその run を知らない。すでに終わっていた可能性もあるが、
    // 「中止できた」とは言えない。安全側で失敗として数える。
    if (!report.value.found) failedChildren += 1;
    terminated += report.value.terminated;
  }

  // 中止要求と同時／直後に Started が届いた子の分を取り込む。
  // 待っている間にさらに増えることがあるので、増えなくなるまで回す。
  while (entry.lateCancels.length > 0) {
    const pending = entry.lateCancels.splice(0, entry.lateCancels.length);
    const lateReports = await Promise.all(pending);
    for (const report of lateReports) {
      // 遅着分の reject は routeDirectRunBatchEvent の catch が
      // {found:false, terminated:0} に潰しているので、ここでも found で拾える。
      if (!report.found) failedChildren += 1;
      terminated += report.terminated;
    }
  }

  return { found: true, terminated, failedChildren };
}

/** テスト用。台帳を空にする。 */
export function __resetDirectRunRegistry(): void {
  parents.clear();
  childToParent.clear();
}
