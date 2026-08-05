/**
 * 生成モーション仕様 (AI生成 / 動画取り込み) の永続化ストア。
 *
 * **ファイル (motions.json) を正本**、localStorage を冗長バックアップとして二重に保存する。
 *
 * なぜファイル正本にしたか (2026-08-03 gj7):
 *   localStorage だけだと WebView のビルドID (app.codexframefactory / .dev / .capture)
 *   ごとに別領域になり、ビルドを跨ぐと空に見える。WebView データ消去でも全損する。
 *   一方でモーションを参照する側 (scene3d.json の motion.type:"clip" の clipId) は
 *   ファイル正本なので、**シーンは残るのにモーション実体だけ消えて clipId が宙に浮く**。
 *   参照元と同じ保存 regime へ揃えて、シーンとモーションの生死を構造的に一致させる。
 *
 * 安全機構は scene3d.ts / presets.ts をそのまま踏襲する
 * (fileWriteUnlocked / 最後勝ちキュー / 空上書きガード / 世代バックアップ)。
 *
 * scene3d.ts との差:
 *   - **デバウンスを持たない**。モーションの変更は生成/削除時のみで低頻度なので、
 *     書き込みを間引く必要がない (逆に間引くと取りこぼしのリスクだけが残る)。
 *   - 公開 API は**同期シグネチャを維持**する。呼び出し側 (Scene3dWorkspace /
 *     directorGen) が同期呼び出しのため、非同期化すると呼び出し側の改修が要る。
 */

import { invoke } from "@tauri-apps/api/core";
// 実行時循環を作らないため type-only import にする (motionGen 側は本ファイルを import しない)。
import type { GeneratedMotionSpec } from "./motionGen";

/** localStorage の冗長バックアップキー (移行元でもある)。 */
const GEN_KEY = "scene3d.generatedMotions.v1";

/** motions.json の形。`{version, motions}` の object (配列 = projects.json との取り違え検出)。 */
const MOTIONS_FILE_VERSION = 1;

export type StoredGeneratedMotion = { id: string; spec: GeneratedMotionSpec };

/** motions.json の中身 1 件を検証する (localStorage / ファイルで共通)。 */
function isStoredMotion(x: unknown): x is StoredGeneratedMotion {
  return x != null && typeof x === "object" && typeof (x as StoredGeneratedMotion).id === "string";
}

/** localStorage から同期で読む (起動直後の初期表示を今までどおりにするため)。 */
function readLocalStorage(): StoredGeneratedMotion[] {
  try {
    const raw = localStorage.getItem(GEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMotion);
  } catch {
    return [];
  }
}

function writeLocalStorage(list: StoredGeneratedMotion[]) {
  try {
    localStorage.setItem(GEN_KEY, JSON.stringify(list));
  } catch {
    // 容量超過等は握りつぶす。**ファイルが正本**なのでデータは失われない
    // (旧実装では localStorage の quota 超過がそのままデータ喪失だった)。
  }
}

/**
 * モジュールキャッシュ。localStorage から同期初期化し、initializeGeneratedMotions()
 * でファイル正本に差し替える。
 */
let cache: StoredGeneratedMotion[] = readLocalStorage();

/**
 * ファイルへ書いてよいと確定したか。
 * true になるのは「正常に読めた」か「ファイルが存在しないと確認できた」ときだけ。
 * **読み出しに失敗した場合は false のまま**で、ファイルへは一切書かない
 * (読めない正本を localStorage 由来の内容で上書きしない。scene3d.ts と同じ不変条件)。
 */
let fileWriteUnlocked = false;
/** 解禁前に save された id (解禁時にファイル側へ再適用する)。 */
const mutatedIds = new Set<string>();
/** 解禁前に remove された id (解禁時にファイル側から落とす)。 */
const removedIds = new Set<string>();
/** 解禁前に mutate があったか。解禁時に1回フラッシュして取りこぼしを防ぐ。 */
let pendingBeforeUnlock = false;

/**
 * 保存先 (storageRoot / projectsDataRoot) の世代印 (B1 2026-08-03 r3)。
 *
 * motions_read / motions_write は「呼んだ時点の設定の保存先」を見る。つまり
 * 「読み書きを開始 → その await 中にユーザーが保存先を変更」が起きると、
 * **古い内容が新しい保存先へ着地**したり、**旧保存先の読み込み結果が
 * 新保存先向けに解禁を出す**。invoke は必ず非同期なのでこの窓は常に存在する。
 *
 * r2 まではフラグと個別条件 (initializeToken / writeInFlight / storageGeneration)
 * の組み合わせで塞ごうとして失敗した。条件を足すたびに別の順序が抜けた。
 * r3 では**単一の直列キュー**に構造を作り直す (下記 enqueue)。
 */
let switchEpoch = 0;

/**
 * すべてのファイル操作を通す **1本の直列キュー** (B1 2026-08-03 r3)。
 *
 * 不変条件は3つだけ:
 *   1. **motions.json への読み書きは必ずこの enqueue を通る**
 *      (persist も initialize も switch も。他の経路は存在しない)。
 *   2. 各ジョブは**投入時**に `switchEpoch` を捕獲し、**実行直前 (デキュー時)**
 *      に現在値と照合する。不一致なら**無条件で破棄**する。
 *      投入から実行までの間に切替が起きたジョブは、内容が何であれ捨てる。
 *   3. 直列なので、ジョブ実行中に別のジョブが割り込むことはない。
 *      「読んでいる最中に書く」「切替中に読む」が構造的に起こらない。
 *
 * この3つだけで、r2 の残存経路
 * (旧 root の読み込み → 切替 → 旧読み込み完了 → 解禁 → 新 root へ旧内容を書く)
 * が閉じる。旧読み込みジョブは切替で epoch がずれるため、**完了しても
 * 解禁処理そのものが実行されない**。解禁は「キュー経由で新 root を読み終えた
 * ジョブの中でだけ」起きる (initializeJob 内。他に fileWriteUnlocked=true を
 * 書く場所は無い)。
 *
 * 直列化により保存先変更中に書き込みが数百 ms 待つが、モーションの保存は
 * 生成/削除時のみで低頻度なので体感差は無い。理解しやすさを優先する。
 */
let queueTail: Promise<void> = Promise.resolve();

/**
 * ジョブを直列キューへ投入する (B1 2026-08-03 r3)。
 *
 * **motions.json に触る処理はすべてこの関数を通す**。ここが唯一の入口。
 *
 * 投入時に `switchEpoch` を捕獲し、デキュー時 (= 実際に走る直前) に現在値と
 * 照合する。不一致なら job は**呼ばれない**。「投入されたが、実行までの間に
 * 保存先が変わったジョブ」は内容を問わず捨てられる。
 *
 * job が throw しても後続は止まらない (キューは常に resolve へ倒す)。
 * 1つのジョブの失敗で保存機能が永久に死ぬのを防ぐ。
 */
function enqueue(label: string, job: (epochAtEnqueue: number) => Promise<void>): Promise<void> {
  const myEpoch = switchEpoch;
  const run = queueTail.then(async () => {
    if (myEpoch !== switchEpoch) {
      // 保存先の切替をまたいだジョブ。内容は localStorage と
      // mutatedIds/removedIds に残っており、切替後の
      // initializeGeneratedMotions(true) が新 root を読んでマージし直す。
      console.warn(`[motionStore] 保存先変更をまたいだ ${label} を破棄しました`);
      return;
    }
    // ジョブ本体にも投入時世代を渡す。ジョブ内の await (motions_read 等) の最中に
    // 切替が起きた場合、ジョブ自身が完了前に再照合できるようにする (B1-R3-1)。
    await job(myEpoch);
  });
  // キューの尾は「失敗しても進む」形にする (中身の握りつぶしは各ジョブの責務)。
  queueTail = run.catch(() => {});
  return run;
}

/** 起動時の initialize を共有するための Promise (force 指定時は共有しない)。 */
let initializePromise: Promise<void> | null = null;

/**
 * 保存先切替の進行中フラグ (B1 最終決着 = A案。STΛCK承認 2026-08-03 bon q01)。
 *
 * 切替中 (beginStorageRootSwitch 〜 initializeGeneratedMotions(true) 完了) は
 * モーションの保存・削除を**明示的に断る**。競合を「正しく処理する」のではなく
 * 「起こさせない」ことで、6周の REVISE で塞ぎ切れなかった微小窓の議論を終える。
 * 実運用でこの数百ms にユーザー保存が重なることはまず無く、重なった場合も
 * トーストで正直に断る (黙って落とさない)。
 */
let storageRootSwitching = false;
/**
 * 切替フローの所有権トークン (B1-A-02 最終決着)。
 *
 * switchEpoch は「ドレイン後」に進むため、再試行のドレイン中に完了した古い後始末の
 * finally は世代照合をすり抜けて新しいフラグを解除できてしまう (Sol 3周目 0.99)。
 * このトークンは **begin の冒頭 (フラグを立てるのと同時)** に進むので、
 * 「フラグを立てた切替」と「解除してよい初期化」の対応が正確に取れる。
 */
let switchingToken = 0;

/** 切替中なら true を返し、ユーザーへトーストで断る。 */
function rejectDuringSwitch(action: string): boolean {
  if (!storageRootSwitching) return false;
  console.warn(`[motionStore] 保存先切替中のため${action}を保留しました`);
  void (async () => {
    try {
      const { useToasts } = await import("../store/toasts");
      useToasts.getState().push({
        kind: "info",
        text: "保存先を切替中です。数秒後にもう一度お試しください。",
        ttlMs: 4000,
      });
    } catch {
      // トースト不可ならログのみ。
    }
  })();
  return true;
}

/**
 * 保存先変更の直前に呼ぶ。
 *
 * やることは2つだけ:
 *   1. `switchEpoch` を進める → **これ以降にデキューされる旧世代ジョブは全滅**。
 *      進行中の initialize が後から完了しても、その解禁処理は旧世代ジョブの
 *      中にあるので実行されない (B1-R1 の残存経路がここで閉じる)。
 *   2. `fileWriteUnlocked=false` にして、新 root を読み終えるまで書き込みを止める。
 *
 * そのうえで、既にキューに積まれた (= 旧 root で決着すべき) ジョブを流し切る。
 * 呼び出し側は await 後に保存先を切り替え、切替後に
 * initializeGeneratedMotions(true) で解禁する (SettingsWorkspace の2経路)。
 */
export async function beginStorageRootSwitch(): Promise<number> {
  // (B1-A案) 切替中フラグを立てる。以後 initializeGeneratedMotions(true) の完了まで
  // saveGeneratedSpec / removeGeneratedSpec は明示的に断られる (競合の窓を封鎖)。
  //
  // タイマーによる自動解除は置かない (Sol指摘 B1-A-01: 30秒超の正当な切替で
  // 窓が開き直る)。異常系の張り付きは、切替フローの finally から
  // ensureStorageRootSwitchClosed() を呼ぶ**決定論の経路**で回収する。
  storageRootSwitching = true;
  // 所有権トークンを進める。以前の切替に紐づく初期化の finally は解除できなくなる。
  switchingToken += 1;
  // (B1-A-03 最終) **この時点の自分のトークンを固定**する。関数末尾で返すのは
  // 必ずこの値。await (ドレイン) 中に新しい切替が始まって switchingToken が
  // 進んでも、古い呼び出し元に新しいトークンを渡さない。
  const ownToken = switchingToken;
  // (B1-R5) **ドレインの前に一度ロックする**。ドレイン待機中にユーザーが保存/削除
  // した場合、persist() はファイルへ出さず mutatedIds/removedIds + pending へ積む。
  // ここをロックせずにドレインすると、待機中の保存が enqueue され、後の世代更新で
  // 破棄されて「旧にも新にも残らない」消失になる (Sol 5周目指摘)。
  fileWriteUnlocked = false;
  pendingBeforeUnlock = pendingBeforeUnlock || mutatedIds.size > 0 || removedIds.size > 0;
  // (B1-R3-2) 現時点のキューを流し切る。切替前に積まれた正当なジョブ
  // (書き込み・初期化) は旧 root で決着させる。世代を先に進めてしまうと、
  // 待機中の書き込みがデキュー時照合で「破棄」され、旧 root に着地しない。
  try {
    await queueTail;
  } catch {
    // 各ジョブは自前で握りつぶすのでここには来ないが、切替は続行する。
  }
  // (B1-R3-1) ドレイン完了後に世代を進め、**もう一度ロックする**。ドレイン中に
  // 旧 initialize が完了して fileWriteUnlocked=true を立てた場合も、この false が
  // 必ず後から上書きする (unlocked=true を書くのは initialize ジョブ内のみで、
  // それらは直前の await queueTail で完了済み)。ドレイン中〜この行までに新たに
  // 積まれたジョブは旧 epoch を捕獲しているため、以後のデキュー照合で破棄される
  // (その内容は上のロックにより pending 側へも記録済みで、失われない)。
  switchEpoch += 1;
  fileWriteUnlocked = false;
  pendingBeforeUnlock = pendingBeforeUnlock || mutatedIds.size > 0 || removedIds.size > 0;
  // 進行中の initialize の相乗り先を切る (旧 root を読んでいる Promise なので、
  // 切替後の initializeGeneratedMotions() がこれに合流してはいけない)。
  initializePromise = null;
  // (B1-A-03) 呼び出し側の finally が「自分の切替」に限って後始末できるよう、
  // **冒頭で固定した自分の**所有権トークンを返す (await 後の最新値を返すと、
  // ドレイン中に始まった新しい切替のトークンを古い呼び出し元へ渡してしまう)。
  return ownToken;
}

/**
 * 切替フロー (SettingsWorkspace) の finally から呼ぶ後始末 (B1-A案)。
 *
 * 正常系では initializeGeneratedMotions(true) の finally が既にフラグを解除して
 * いるので何もしない。異常系 (begin と force初期化の間で例外) でフラグが残って
 * いた場合だけ、強制初期化を走らせて**初期化完了経由で**解除する。
 * タイマーと違い「再同期してからしか解禁しない」ため、窓が開き直らない。
 */
export function ensureStorageRootSwitchClosed(ownToken: number): void {
  // (B1-A-03) 自分の切替のときだけ回復を発動する。古いフローの finally が
  // 新しい切替 (トークン不一致) の最中に force 初期化を起動すると、切替途中の
  // 状態を読んで新しいフラグを早期解除しうる。所有権の一致を必須にする。
  if (storageRootSwitching && ownToken === switchingToken) {
    console.warn("[motionStore] 切替フローが異常終了したため、再初期化でブロックを解除します");
    void initializeGeneratedMotions(true);
  }
}

async function writeMotionsToFileNow(
  data: StoredGeneratedMotion[],
  allowEmpty: boolean,
): Promise<void> {
  try {
    await invoke("motions_write", {
      content: JSON.stringify({ version: MOTIONS_FILE_VERSION, motions: data }),
      allowEmpty,
    });
  } catch (err) {
    console.error("[motionStore] ファイル書き込み失敗:", err);
    // 黙って失敗させない。「保存できていないのに保存されたと思う」型のデータ消失を防ぐ
    // (scene3d.ts / presets.ts / projects.ts と同じ防御)。
    try {
      const { useToasts } = await import("../store/toasts");
      useToasts.getState().push({
        kind: "error",
        text: `モーションの保存に失敗しました。データ保護のため操作が反映されていない可能性があります: ${String(err)}`,
        ttlMs: 8000,
      });
    } catch {
      // トースト取得すら失敗した場合はログのみ (これ以上できることはない)。
    }
  }
}

/**
 * 書き込みをキューへ積む (B1 r3)。
 *
 * r2 の「最後勝ち + writeInFlight」をやめ、**素直に直列で全部書く**。
 * デバウンスが無く低頻度 (生成/削除時のみ) なので、間引きの利得より
 * 「経路が1本しかない」ことの分かりやすさを取る。
 */
function writeMotionsToFile(data: StoredGeneratedMotion[], allowEmpty = false): Promise<void> {
  return enqueue("書き込み", () => writeMotionsToFileNow(data, allowEmpty));
}

/** キャッシュ更新後の永続化 (localStorage 即時 + ファイル)。 */
function persist(allowEmpty = false) {
  writeLocalStorage(cache);
  if (!fileWriteUnlocked) {
    // 解禁前の mutate。localStorage には既に書いたので取りこぼしはない。
    pendingBeforeUnlock = true;
    return;
  }
  void writeMotionsToFile(cache, allowEmpty);
}

/** 保存済みモーション仕様の一覧 (モジュールキャッシュ)。 */
export function loadGeneratedSpecs(): StoredGeneratedMotion[] {
  return cache;
}

/** モーション仕様を保存 (同 id は差し替え)。 */
export function saveGeneratedSpec(id: string, spec: GeneratedMotionSpec): void {
  // (B1-A案) 切替中は明示的に断る。これにより「切替の微小窓の保存をどう退避するか」
  // という問題自体が消える。常時記録 (B1-R5 の旧対策) は保存先をまたぐ汚染
  // (Sol 6周目 B1-R5-6B) を生むため撤回し、解禁前のみ記録に戻した。
  if (rejectDuringSwitch("保存")) return;
  cache = [...cache.filter((x) => x.id !== id), { id, spec }];
  // 解禁前 = ファイル正本をまだ読めていない窓。この間の変更は読み込み後に
  // マージし直す必要があるので id を控える。
  if (!fileWriteUnlocked) {
    mutatedIds.add(id);
    removedIds.delete(id);
  }
  persist();
}

/** モーション仕様を削除。 */
export function removeGeneratedSpec(id: string): void {
  if (rejectDuringSwitch("削除")) return;
  const before = cache.length;
  cache = cache.filter((x) => x.id !== id);
  if (!fileWriteUnlocked) {
    removedIds.add(id);
    mutatedIds.delete(id);
  }
  // 「実際に1件消えて0件になった」ときだけ空書き込みを許可する。
  // ユーザーの明示的な全削除だけを通し、初期化前の空 state が正本を潰すのは防ぐ。
  const allowEmpty = before > 0 && cache.length === 0;
  persist(allowEmpty);
}

/**
 * 起動時 / 保存先変更時の移行フロー (scene3d.ts の initializeScene3d と同型)。
 * 守るべき不変条件:
 * **「読めなかった」経路では絶対にファイルへ書かない**。書いてよいのは
 * 「ファイルが存在しない」ときと「ファイルを正しく読めた後の変化」だけ。
 *
 * 起動時の呼び出し (force なし) は Promise を共有する。App.tsx と
 * Scene3dWorkspace の両方から呼ばれても motions.json を二重に読まない。
 *
 * **読み込みも解禁も1本のキューの中で起こる (B1 r3)**。
 * r2 までは initializeToken という第2の世代印で古い読み込みを無効化しようと
 * していたが、token は「初期化開始時」にしか進まないため、
 * 「旧 root の読み込み開始 → 切替 → 旧読み込み完了 → 解禁」の窓が残っていた
 * (B1-R1)。r3 では読み込み〜解禁の全体が enqueue したジョブの中にあり、
 * ジョブは実行直前に switchEpoch を照合されるので、切替をまたいだ初期化は
 * **そもそも走らない**。世代印はもう switchEpoch 1つだけ。
 *
 * @param force 保存先が変わった直後は必ず true。進行中の読み込みは
 *   **切替前の保存先**を読んでいるため、それに相乗りすると新しい保存先を
 *   一度も読まないまま解禁してしまう。true なら常に新しい読み込みを積む。
 */
export function initializeGeneratedMotions(force = false): Promise<void> {
  if (initializePromise && !force) return initializePromise;
  // (B1-A-02) 呼び出し時点の切替所有権トークンを控える。解除は「自分の切替の
  // まま」のときだけ。switchEpoch でなくトークンを使う理由: epoch はドレイン後に
  // 進むため、再試行のドレイン中に完了した古い後始末が照合をすり抜ける
  // (Sol 3周目)。トークンは begin 冒頭で進むのですり抜けない。
  const tokenAtCall = switchingToken;
  const p = enqueue("初期化", (epoch) => initializeGeneratedMotionsImpl(epoch)).finally(() => {
    // 自分が最新世代のときだけクリアする (後発が入れ替えた Promise は残す)。
    if (initializePromise === p) initializePromise = null;
    // (B1-A案) 切替後の強制初期化が終わったら保存ブロックを解除する。
    // 成否を問わず解除する (bailOut 経路でも、以後の保存は pending 機構が受ける)。
    // ただし自分より後に新しい切替が始まっていたら (トークン不一致) 解除しない。
    if (force && tokenAtCall === switchingToken) {
      storageRootSwitching = false;
    }
  });
  initializePromise = p;
  return p;
}

/**
 * initialize の本体。**必ず enqueue 経由で呼ぶ** (直接呼ぶと epoch 照合を
 * 素通りし、B1-R1 の競合が復活する)。ジョブとして走っている時点で
 * 「現世代である」ことは enqueue が保証済みなので、ここでは epoch を見ない。
 */
async function initializeGeneratedMotionsImpl(epochAtEnqueue: number): Promise<void> {
  // 読み込み中はファイル書き込みを再ロックする。保存先を切り替えた直後は
  // cache が「切替前の保存先の内容」であり、これを新しい保存先へ書くと
  // 移行先の (件数の多い) 正本を古いキャッシュで潰す。読み終わって
  // マージし終わるまでは、変更は localStorage + mutatedIds/removedIds に
  // だけ積み、ファイルへは出さない。
  fileWriteUnlocked = false;

  /**
   * 読めなかった経路の後始末。ロックしたまま return すると、以後この
   * セッションでは一切ファイルへ書かなくなる (再初期化に失敗しただけで
   * 保存が静かに死ぬ)。**新しい正本を読めていない以上、解禁はしない**が、
   * ロック中に積まれた変更は次の initialize で拾えるよう pending を維持する。
   */
  const bailOut = (): void => {
    pendingBeforeUnlock = pendingBeforeUnlock || mutatedIds.size > 0 || removedIds.size > 0;
  };

  let content: string;
  try {
    content = await invoke<string>("motions_read");
  } catch (err) {
    // Tauri 外 (Vite 単体プレビュー等)。localStorage 由来のキャッシュのまま動く。
    console.error("[motionStore] ファイル読み出し失敗:", err);
    bailOut();
    return; // 解禁しない (読めない正本を localStorage で潰さない)
  }

  // (B1-R3-1) motions_read の await 中に保存先が切り替わった場合、読んだ内容は
  // 旧 root のもの。マージも解禁もせず退避に回す (デキュー照合を通過した直後の
  // 微小窓で切替が始まるケースの封鎖。切替後の initializeGeneratedMotions(true)
  // が新 root を読み直す)。
  if (epochAtEnqueue !== switchEpoch) {
    console.warn("[motionStore] 保存先変更をまたいだ初期化結果を破棄しました");
    bailOut();
    return;
  }

  if (content.trim().length > 0) {
    // ファイル有 = 正本。壊れていたら localStorage 由来のキャッシュを維持し、
    // ファイルへは何も書かない (壊れた正本を上書きしない。.bak-* も残っている)。
    let parsed: { version?: number; motions?: unknown };
    try {
      parsed = JSON.parse(content) as { version?: number; motions?: unknown };
    } catch (err) {
      console.error("[motionStore] motions.json のパースに失敗 (localStorage を継続使用):", err);
      bailOut();
      return;
    }
    if (parsed?.version !== MOTIONS_FILE_VERSION || !Array.isArray(parsed.motions)) {
      console.error("[motionStore] motions.json の形が不正 (localStorage を継続使用)");
      bailOut();
      return;
    }
    // ファイルが勝つ。ただし読み込み窓の間に起きたセッション内変更 (mutatedIds /
    // removedIds) だけは再適用する。
    //
    // ここが「古いキャッシュで移動先を上書きしない」ことの根拠:
    // マージのベースは **常に読み出したファイル (fileMotions)** であって cache ではない。
    // cache は mutatedIds に載った id を引くためだけに使う。保存先変更時は
    // 変更操作が無ければ mutatedIds が空なので、cache の中身は 1 件も混ざらず
    // 新しい保存先の内容がそのまま cache になる。
    const fileMotions = parsed.motions.filter(isStoredMotion);
    const merged = fileMotions.filter((m) => !removedIds.has(m.id));
    for (const id of mutatedIds) {
      const local = cache.find((x) => x.id === id);
      if (!local) continue;
      const idx = merged.findIndex((m) => m.id === id);
      if (idx >= 0) merged[idx] = local;
      else merged.push(local);
    }
    const hadPending = pendingBeforeUnlock || mutatedIds.size > 0 || removedIds.size > 0;
    cache = merged;
    mutatedIds.clear();
    removedIds.clear();
    writeLocalStorage(cache);
    fileWriteUnlocked = true;
    pendingBeforeUnlock = false;
    if (hadPending) {
      // 解禁前の変更をファイルへ1回フラッシュする。
      // **ここで writeMotionsToFile (= enqueue) を await してはいけない**。
      // 自分がキューのジョブとして走っている最中なので、後続ジョブを待つと
      // 自己デッドロックする。書き込みは直接実行する (既に現世代であることは
      // enqueue が保証済み・直列性もジョブ内なので保たれている)。
      await writeMotionsToFileNow(cache, false);
    }
    return;
  }

  // ファイル未作成 = localStorage からの移行 or 新規ユーザー。
  // 現在のキャッシュ (localStorage 由来) を正とする。
  fileWriteUnlocked = true;
  pendingBeforeUnlock = false;
  mutatedIds.clear();
  removedIds.clear();
  // 1件も無いなら空ファイルを作らない (新規ユーザーに空の正本を置かない)。
  if (cache.length > 0) {
    console.info(`[motionStore] localStorage から ${cache.length} 件のモーションをファイルへ移行`);
    // 上と同じ理由でキューを経由しない (自ジョブ内での直接実行)。
    await writeMotionsToFileNow(cache, false);
  }
}

/**
 * テスト専用: 現時点でキューに積まれた全ジョブの完了を待つ (u73)。
 * 製品コードから呼ばない。queueTail は enqueue のたびに付け替わるため、
 * 呼び出し時点のスナップショットを await する。
 */
export function __test_drainMotionQueue(): Promise<void> {
  return queueTail;
}
