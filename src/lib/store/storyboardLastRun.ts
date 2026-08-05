/**
 * 絵コンテ本生成 run の「未回収ポインタ」(rr2 / 2026-08-03)。
 *
 * 何のためにあるか: 採用 (adoptTake) はディスクの adoptions.json に書かれるが、
 * プロジェクトへの追加は run の completed イベントでしか行われない。途中で
 * アプリが落ちる / 強制終了されると、ユーザーの採用判断はディスクに残るのに
 * UI 上は消える。
 *
 * このポインタが**残っている状態 = 採用がプロジェクトへ未回収のままアプリが
 * 終了した**ことを意味する。beginRun (本生成のみ) で書き、completed で
 * プロジェクト追加まで済んだら消す。起動時に残っていれば
 * restoreUnrecoveredAdoptions が拾って復元する。
 *
 * plugin-store に置くのは localStorage が WebView ビルドID ごとに別領域で、
 * 配布版 / dev 版をまたぐと消えるため (presets / referenceRoles と同じ理由)。
 */

const STORE_FILE = "storyboard-last-run.json";
const STORE_KEY = "pointer";

export type StoryboardLastRun = {
  runId: string;
  /** run 開始時点の選択中プロジェクト。null なら復元先が無い (復元時に黙って破棄)。 */
  projectId: string | null;
  startedAt: number;
};

// Store インスタンスはキャッシュする (savedPrompts.ts と同じ流儀)。
// 書き込みのたびに plugin import + load を走らせると無駄で、同時書き込みの
// レースも作りやすい。
let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null =
  null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    console.warn("[storyboardLastRun] loadStore failed", err);
    return null;
  });
  return storePromise;
}

/** ポインタを読む。無い / 読めない / 壊れている場合は null。 */
export async function readLastRunPointer(): Promise<StoryboardLastRun | null> {
  const store = await loadStore();
  if (!store) return null;
  try {
    const raw = await store.get<unknown>(STORE_KEY);
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Partial<StoryboardLastRun>;
    if (typeof value.runId !== "string" || !value.runId) return null;
    return {
      runId: value.runId,
      projectId: typeof value.projectId === "string" ? value.projectId : null,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
    };
  } catch (err) {
    console.warn("[storyboardLastRun] read failed", err);
    return null;
  }
}

/** ポインタを書く (本生成 run の開始時)。best-effort。 */
export async function writeLastRunPointer(
  pointer: StoryboardLastRun,
): Promise<void> {
  const store = await loadStore();
  if (!store) return;
  try {
    await store.set(STORE_KEY, pointer);
    await store.save();
  } catch (err) {
    console.warn("[storyboardLastRun] write failed", err);
  }
}

/** ポインタを消す (プロジェクト追加まで完了 / 復元処理を終えたとき)。best-effort。 */
export async function clearLastRunPointer(): Promise<void> {
  const store = await loadStore();
  if (!store) return;
  try {
    await store.delete(STORE_KEY);
    await store.save();
  } catch (err) {
    console.warn("[storyboardLastRun] clear failed", err);
  }
}
