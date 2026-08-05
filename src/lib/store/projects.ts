import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { GenerationInfo } from "../ipc";
import type { AudioAttachment } from "../audio/attach";
import {
  buildCreditsCsv as buildCreditsCsvRows,
  buildProjectLogCsv,
} from "../projectLogCsv";

/**
 * プロジェクト = 制作物のアーカイブ箱。
 *
 * Code Manager / Notion / Figma のページ的な軽い「箱」として機能する。
 * 制作画面で生成した画像 1 枚ごとに「プロジェクトに保存」できるようにし、
 * このストアに永続化する。プロジェクトを開くと、保存した画像が
 * グリッドで一覧できる。
 *
 * sessions ストア（チャット履歴）とは独立した 2 軸:
 * - sessions: 進行中の作業セッション（時系列、過去のチャット）
 * - projects: 完成物のアーカイブ箱（用途別、案件別、テーマ別）
 *
 * 永続化 (v0.6.9): Tauri 経由のファイル保存に変更。
 *   - Mac:   ~/Library/Application Support/app.codexframefactory/projects.json
 *   - Win:   %APPDATA%/app.codexframefactory/projects.json
 *
 * 旧 localStorage に保存されていたデータは、起動時に自動マイグレーションする。
 * これにより dev版 と 配布版 でデータが共有され、再インストールでも消えない。
 */

export type ProjectItem = {
  id: string;
  /** 元の画像ファイルパス（Tauri convertFileSrc で表示する） */
  imagePath: string;
  /** 任意のメモ（用途、コメント、誰宛 等） */
  note?: string;
  /** 生成時のプロンプト（あれば、後追いで参照しやすいように） */
  prompt?: string;
  /** 元 session id（あれば、戻る導線用） */
  sourceSessionId?: string;
  /** プロジェクト追加時点で history.db から取得した生成プロセスのスナップショット */
  generation?: GenerationInfo;
  addedAt: number;
};

/**
 * プロジェクトに保存する企画チャットの 1 メッセージ。
 * planChat.PlanMessage と互換（streaming は保存しない）。
 */
export type ProjectChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachedImages?: string[];
  /** go4: 添付音源のメタデータ (尺・形式・タグ)。音声ファイル本体は保存しない。
   *  未定義の場合は「音源なし」扱い (後方互換)。 */
  attachedAudio?: AudioAttachment;
  createdAt: number;
};

/**
 * プロジェクトに紐づくストック素材のクレジット記録 (法務対応 2026-05-21)。
 *
 * 用途:
 *   - 商用案件で「この PR 動画で使った素材は？」と聞かれた時の出典トレース
 *   - エクスポート時に credits.csv として一覧出力する
 *
 * 記録タイミング:
 *   - StockSearchModal の「参照に追加」時、アクティブプロジェクトがあれば
 *     useProjects.getState().recordStockCredit(activeProjectId, credit) を呼ぶ
 *
 * 重複排除:
 *   - 同じ photoId が既にあれば addedAt のみ更新 (二重カウントしない)
 */
export type StockCredit = {
  provider: "pexels";
  photoId: string;
  author: string;
  sourceUrl?: string;
  /** ローカルに保存したファイルパス。後追いで「どの素材か」を辿る用。 */
  localPath?: string;
  /** いつ参照に取り込んだか */
  addedAt: number;
};

export type Project = {
  id: string;
  name: string;
  /** 任意の説明 */
  description?: string;
  /**
   * プロジェクトの状態 (監査B-2: 下書き→確定フロー)。
   *   - "draft":  作成直後。まだ「確定」していない下書き。
   *   - "active": 確定済み。通常のプロジェクト。
   *   - undefined: 旧データ (この項目が導入される前) は active として扱う (後方互換)。
   * これにより「作っただけで中身が空のまま放置された箱」を UI 上で見分けられる。
   * 複雑な状態機械にはしない (draft → active の一方向のみ)。
   */
  status?: "draft" | "active";
  items: ProjectItem[];
  /** 企画チャット (PlanWorkspace) のログ。アクティブプロジェクト時に
   *  会話完了ごとに上書き保存される。 */
  planChat?: ProjectChatMessage[];
  /**
   * このプロジェクトで取り込んだストック素材のクレジット累積ログ。
   * 法務対応 (2026-05-21): credits.csv エクスポート用の出典トレース。
   * 未定義の場合は空配列扱い (後方互換)。
   */
  stockCredits?: StockCredit[];
  createdAt: number;
  updatedAt: number;
};

const PROJECTS_LS_KEY = "projects.projects";
/** localStorage の冗長バックアップ。万一 localStorage が一時的に空でも、
 *  ここに最後の正常な配列が残っていれば復元できる。 */
const PROJECTS_LS_BACKUP_KEY = "projects.projects.backup";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 企画チャット 1 メッセージを、比較用の不変な文字列キーへ畳む (g8t 4周目)。
 *
 * 保存完了の内容検証で「期待したメッセージが、ディスクに載った内容と同一か」を
 * 判定するために使う。オブジェクト参照ではなくプリミティブへ落とすので、
 * 待機中に元オブジェクトが変更されても比較結果は動かない。
 * 対象は ProjectChatMessage に実在する全フィールド (id / role / text /
 * attachedImages / attachedAudio / createdAt)。
 */
function planChatMessageKey(m: ProjectChatMessage): string {
  return JSON.stringify([
    m.id,
    m.role,
    m.text,
    m.createdAt,
    m.attachedImages ?? null,
    m.attachedAudio ?? null,
  ]);
}

/**
 * localStorage からのデータ救出 (旧版互換)。
 * v0.6.8 以前は localStorage に保存されていた。新規ファイル保存に
 * 移行した後も、初回起動時に localStorage に残っているデータがあれば
 * それを読み出して、ファイルへ移行する。
 */
function readFromLocalStorage(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Project[];
      }
    }
    const backup = localStorage.getItem(PROJECTS_LS_BACKUP_KEY);
    if (backup) {
      const backupParsed = JSON.parse(backup);
      if (Array.isArray(backupParsed) && backupParsed.length > 0) {
        return backupParsed as Project[];
      }
    }
  } catch (err) {
    console.error("[projects] localStorage 読み出し失敗:", err);
  }
  return [];
}

/**
 * Tauri 経由でファイルから読み出す。
 * 初期化時、または localStorage が空の時に呼ぶ。
 */
async function readFromFile(): Promise<Project[]> {
  try {
    const content = await invoke<string>("projects_read");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed as Project[];
    }
  } catch (err) {
    console.error("[projects] ファイル読み出し失敗:", err);
  }
  return [];
}

/**
 * 大幅減少ガード (Rust 側 projects_write) が返すエラーの機械判定マーカー。
 * Rust の書式 `[DECREASE_GUARD existing=N incoming=M]` と対で保守する
 * (どちらか片方だけ変えるとダイアログが出ず、ただのエラートーストに落ちる)。
 */
const DECREASE_GUARD_PATTERN = /\[DECREASE_GUARD existing=(\d+) incoming=(\d+)\]/;

/**
 * 大幅減少の確認ダイアログが表示中か。
 * キュー上の後続書き込みも同じガードに当たるため、多重表示を防ぐ。
 */
let decreaseDialogOpen = false;

/**
 * ディスクの内容を読み直して store へ反映する (大幅減少ガードの Cancel 経路)。
 * initialize() と同じ「読む → set」を共有するための切り出し。
 *
 * 読み込みに失敗したときは **store を触らない**。readFromFile() は失敗時も
 * 空配列を返す仕様なので、そのまま setState すると「0 件を正常に読み直した」
 * ことになり、画面上のプロジェクトが全部消える (Sol指摘 E-1 の後半)。
 * 失敗時は現状維持のうえ null を返し、呼び出し側にトースト文言を分けさせる。
 */
async function reloadFromDiskIntoStore(): Promise<number | null> {
  // 読み直し中フラグを立てる (Sol指摘 E-1)。
  //
  // 「読み直しをまたいだ古い保存」は **単調カウンタでは判別できない**。
  // 読み直し中に積まれた保存は、進める順序を前にしても後にしても、比較した瞬間には
  // 現在の世代と同じ値を持つ (前に進めれば積む側も新しい値を拾い、後に進めれば
  // 比較時点でまだ進んでいない)。区別すべきは値ではなく「読み直しの最中かどうか」
  // という状態なので、フラグで持つのが正しい (実測: `_work/probe/probe-e1.mjs`)。
  //
  // これは机上の理屈ではなく実在の経路: 書き込みループの async IIFE は最初の await に
  // 達するまで同期に走るため、その区間では writeInFlight がまだ null。読み直し中の
  // 再入 writeToFile() は 2 本目のループを立てて即座に書いてしまう。
  reloadInProgress = true;
  // 読み込みと setState の**全体**を try/finally で囲う (Sol指摘 2026-08-03)。
  // 各経路で個別に `reloadInProgress = false` を書くと、想定外の例外
  // (setState 中の subscriber 例外など) でフラグが立ったまま残り、
  // 以後の保存が全部捨てられて**保存不能**になる。finally なら経路を問わず必ず下りる。
  // 読み直し中に積まれた保存を捨てる判断自体は失敗時も変えない: ユーザーは
  // 「中止」を選んでおり、その中間状態を書き戻さないのが取り消しの意味だから。
  try {
    let fromFile: Project[];
    try {
      const content = await invoke<string>("projects_read");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("projects_read が配列を返しませんでした");
      }
      fromFile = parsed as Project[];
    } catch (err) {
      console.warn("[projects] 読み直しに失敗したため store は現状維持:", err);
      return null;
    }
    useProjects.setState({ projects: fromFile });
    return fromFile.length;
  } finally {
    reloadInProgress = false;
  }
}

/**
 * 減少ガードの再投入が「どの rev の代わりに積まれたか」(g8t 3周目 2026-08-04)。
 *
 * 再投入は新しい rev を採番するため、呼び出し元 (writeToFileNow) が
 * 「自分の要求が再投入されたのか、それとも書かれずに終わったのか」を
 * pendingWrite.rev の一致では判定できなくなった。ここに引き継ぎ元を書いて渡す。
 * 判定した側が読み終えたら null に戻す (状態を残さない)。
 */
let requeuedFromRev: number | null = null;

/**
 * 大幅減少ガードに当たったときの確認フロー (ywf)。
 * OK  → 最新スナップショットを allowDecrease=true で 1 回だけ書き直す
 * Cancel → ディスクから読み直して store を正本に戻す
 */
async function handleDecreaseGuard(
  existingCount: number,
  incomingCount: number,
  /**
   * ガードに当たった保存要求の連番 (g8t 2026-08-04)。
   * 「上書きする」を選んだときの再投入にこの rev を引き継ぐことで、元の待機者は
   * 再投入の実際の成否で解決される (先に true と誤報しない)。
   */
  guardedRev: number,
): Promise<void> {
  // ダイアログ表示中なら何もしない (キュー上の後続も同じガードに当たるため)。
  if (decreaseDialogOpen) return;
  decreaseDialogOpen = true;
  try {
    const message =
      `保存しようとしているプロジェクトデータ（${incomingCount}件）が、ディスク上のデータ（${existingCount}件）より大幅に少なくなっています。\n\n` +
      `クラウド同期などで古いデータを開いている可能性があります。上書きすると、ディスク上の ${existingCount}件のデータはこの内容に置き換わります（直前の状態は自動バックアップに残ります）。`;
    let overwrite = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      overwrite = await ask(message, {
        title: "保存内容の確認",
        kind: "warning",
        okLabel: "このまま上書きする",
        cancelLabel: "中止してディスクから読み直す",
      });
    } catch {
      overwrite = window.confirm(message);
    }

    if (overwrite) {
      // 最新スナップショットで 1 回だけ上書きする。
      //
      // ここで writeToFile() を await してはいけない: 本関数は writeToFileNow() の
      // 内側 = writeInFlight ループの実行中に呼ばれるため、writeToFile() は
      // 実行中の自分自身の Promise を返す。await すると自分の完了を待つ自己デッドロックになり、
      // 以降すべての保存が永久に止まる。キューへ積むだけにして、現在のループの
      // 次の周回で書かせる (while (pendingWrite) が拾う)。
      // 再投入は「いまの最新状態」を書くので、**新しい rev を採番する**
      // (g8t 3周目 2026-08-04)。
      //
      // 2周目までは元の rev (guardedRev) を引き継いでいたが、それだと
      // guardedRev より後に積まれた待機者 (ダイアログ表示中の操作) が置き去りに
      // なる: 内容はこの再投入で実際に書かれるのに、rev が古いままなので
      // settleWaitersUpTo(guardedRev, ...) では刈られず、ループ末尾の安全網で
      // false にされる = 保存できているのに「失敗」と誤報する。
      // 最新状態を書くのだから、その時点の最大 rev を名乗るのが正しい。
      //
      // 元の待機者 (guardedRev) が置き去りにならないのは、新 rev のほうが大きく
      // settleWaitersUpTo(newRev, ...) が rev <= newRev を全部刈るため。
      pendingWrite = {
        projects: useProjects.getState().projects,
        allowEmpty: false,
        allowDecrease: true,
        // この経路は読み直しをしない (ユーザーが上書きを選んだ) ので stale ではない。
        // 次周回で必ず実行される。
        staleFromReload: false,
        rev: ++writeRevSeq,
      };
      // 「自分の rev が pendingWrite に載って戻ってきたか」で requeued を判定する
      // 呼び出し元 (writeToFileNow) のために、引き継ぎ元を記録しておく。
      requeuedFromRev = guardedRev;
      return;
    }

    // Cancel: ディスク側の正本を読み直す。
    //
    // 読み直しの **前に** キューを捨てる (Sol指摘 E-1)。ダイアログ表示中も UI は
    // 動いており、その間の保存要求は pendingWrite に積まれている。捨てないと
    // 「中止してディスクから読み直す」直後に、キューの古いスナップショットが
    // ガードを素通り (allowDecrease=true の再投入や、減少幅が閾値未満の書き込み)
    // して正本を上書きしうる。ユーザーが取り消した内容を書き戻さないため、
    // ここで無条件に破棄する。落とすのは「ディスクより少ない中間状態」だけで、
    // 直後の読み直しで store は正本に揃う。
    //
    // 破棄する要求の待機者は false で閉じる (g8t)。黙って捨てると、その保存を
    // await している昇格処理が永久待ちになりボタンが固まる。
    const droppedRev = pendingWrite?.rev;
    pendingWrite = null;
    if (droppedRev !== undefined) settleWaitersUpTo(droppedRev, false);
    const count = await reloadFromDiskIntoStore();
    try {
      const { useToasts } = await import("./toasts");
      useToasts.getState().push(
        count === null
          ? {
              kind: "error",
              text: "ディスク上のプロジェクトデータを読み直せませんでした。保存は中止したので、画面の内容はそのままです",
              ttlMs: 8000,
            }
          : {
              kind: "info",
              text: `ディスク上のプロジェクトデータ（${count}件）を読み直しました`,
              ttlMs: 6000,
            },
      );
    } catch {
      // トースト取得失敗はログのみ (読み直し自体は完了している)。
    }
  } catch (err) {
    console.error("[projects] 大幅減少ガードの処理に失敗:", err);
  } finally {
    decreaseDialogOpen = false;
  }
}

/**
 * Tauri 経由でファイルに書き込む。
 * allowEmpty: 0件での上書きを許可するか (ユーザーが明示的に全削除したときだけ true)。
 * allowDecrease: 大幅減少 (半分未満) での上書きを許可するか。通常は false で、
 *   確認ダイアログで「このまま上書きする」を選ばれたときだけ true。
 * 書き込みが失敗したら、サイレントに握り潰さずユーザーへトースト通知する
 * (「保存できていないのに成功したと思う」型のデータ消失を防ぐ。evaluator 指摘)。
 *
 * 戻り値 (g8t 2026-08-04):
 *   "ok"       … ディスクへ書けた
 *   "failed"   … 書けなかった (待機者は false で確定)
 *   "requeued" … 減少ガードで「上書きする」を選ばれ、**同じ rev で再投入済み**。
 *                この時点では成否が未確定なので、待機者をまだ解決してはいけない
 *                (次周回の実結果で解決される)。
 */
type WriteOutcome = "ok" | "failed" | "requeued";

/**
 * 直近で **実際にディスクへ載った** JSON 文字列 (g8t 4周目 2026-08-04)。
 *
 * 保存内容の検証はこの文字列を正本にする。invoke へ渡した文字列そのものなので
 * 不変であり、待機中に store 側の変更が同じ配列オブジェクトを触っても
 * 判定は揺れない (可変参照レースの遮断)。rev を併記して「どの保存の内容か」を
 * 曖昧にしない (別の書き込みの content で検証してしまう事故の構造的な防止)。
 */
let lastWrittenContent: { rev: number; content: string } | null = null;

async function writeToFileNow(
  projects: Project[],
  allowEmpty: boolean,
  allowDecrease: boolean,
  /** この書き込み要求の連番 (g8t)。減少ガードの再投入へ引き継ぐ。 */
  rev: number,
): Promise<WriteOutcome> {
  try {
    const serialized = JSON.stringify(projects);
    await invoke("projects_write", {
      content: serialized,
      allowEmpty,
      allowDecrease,
    });
    // 成功した時だけ記録する (失敗経路では触らない)。
    lastWrittenContent = { rev, content: serialized };
    return "ok";
  } catch (err) {
    console.error("[projects] ファイル書き込み失敗:", err);
    // 大幅減少ガード (ywf) は「壊れた保存」ではなくユーザーに選ばせる場面なので、
    // エラートーストではなく確認ダイアログへ分岐する。
    const guard = DECREASE_GUARD_PATTERN.exec(String(err));
    if (guard) {
      await handleDecreaseGuard(Number(guard[1]), Number(guard[2]), rev);
      // ガード経路はこの書き込み自体は成立していない。
      // 「上書きする」を選ばれた場合は **新しい rev で** 再投入されているので、
      // 待機者は次周回の実結果で解決させる ("requeued")。新 rev のほうが大きいため
      // settleWaitersUpTo が自分も一緒に刈ってくれる。
      // それ以外 (中止 / ダイアログ多重表示でスキップ) は書かれないので失敗として確定。
      // 判定は「自分の rev の代わりに再投入が積まれたか」で行う (g8t 3周目)。
      if (requeuedFromRev === rev) {
        requeuedFromRev = null;
        return "requeued";
      }
      return "failed";
    }
    // 保存失敗をユーザーに必ず知らせる (静かに失敗させない)。
    try {
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: `プロジェクトの保存に失敗しました。データ保護のため操作が反映されていない可能性があります: ${String(err)}`,
        ttlMs: 8000,
      });
    } catch {
      // トースト取得すら失敗した場合はログのみ (これ以上できることはない)。
    }
    return "failed";
  }
}

/**
 * 保存の最後勝ちキュー (2026-07-30)。
 * 並列生成改修 (2026-07-28) で persist の並行度が上がり、複数の書き込みが
 * in-flight になると invoke の到着順逆転で古いスナップショットが後勝ちし得る。
 * in-flight 中に来た保存要求は「最新 1 件」だけ保持し、完了後に 1 回だけ書く。
 * 中間状態の保存はスキップしてよい (projects は常に全量スナップショットなので
 * 最終状態が正)。
 */
let pendingWrite: {
  projects: Project[];
  allowEmpty: boolean;
  allowDecrease: boolean;
  /** 積まれた時点で読み直しが進行中だったか。true なら実行せず破棄する。 */
  staleFromReload: boolean;
  /** この保存要求の連番 (g8t 2026-08-04)。待機者の解決に使う。 */
  rev: number;
} | null = null;
let writeInFlight: Promise<void> | null = null;

/**
 * ディスクからの読み直しが進行中か (Sol指摘 E-1)。
 *
 * 「中止してディスクから読み直す」は `pendingWrite = null` でキューを捨てるが、
 * それだけでは窓が残る: 読み直し (`projects_read` の await) の最中も UI は動いており、
 * その間に来た保存要求は **捨てた後のキューに積み直される**。読み直しが終わった
 * 時点でループの次周回がそれを拾い、ユーザーが取り消したはずの中間状態で正本を
 * 上書きしうる (減少幅が閾値未満ならガードも素通りする)。
 *
 * このフラグが立っている間に積まれた保存は「読み直し前の store から計算された内容」
 * なので、書き込みループが実行せずに破棄する。読み直し後にユーザーが行う正当な
 * 新操作はフラグが下りてから積まれるため失われない。
 */
let reloadInProgress = false;

/**
 * 保存要求の連番 (g8t 2026-08-04)。writeToFile() 呼び出しごとに 1 進む。
 * 待機者と「実際にディスクへ載った保存」を対応付けるための唯一の鍵。
 */
let writeRevSeq = 0;

/**
 * 書き込みループの結果を待つための待機者 (g8t 2026-08-04・リビジョン方式)。
 *
 * ループは「最後勝ち」で中間状態をスキップするため、個々の呼び出しと invoke は
 * 1対1にならない。そこで待機者は自分の連番 (rev) を持ち、**自分の rev 以降を
 * 含む保存の結末** だけで解決する:
 *
 *   - 成功 (job.rev >= waiter.rev)  → true。ただし「自分より後のスナップショットが
 *     載れば自分の内容も載っている」は **同じ内容が保たれている場合にだけ** 成り立つ。
 *     載ったのが「その間に削除された後のスナップショット」なら自分の内容は入っていない
 *     (g8t 3周目で塞いだ穴。下記 verify を参照)。
 *   - 失敗 (job.rev >= waiter.rev)  → false。その保存は起きていないので、
 *     **後続の別の保存が成功しても true にしない** (これが 2周目に塞いだ穴。
 *     最後の 1 回の成否を全員に配ると、削除・reload 後の別保存の成功が
 *     「会話が保存できた」と誤報し、未保存台帳を消して消失窓を開けた)。
 *   - stale 破棄 (job.rev >= waiter.rev) → false。書いていないので保存済みと言えない。
 *
 * `verify` (g8t 3周目 2026-08-04 / 4周目で正本を文字列へ変更):
 *   rev だけでは足りない待機者のための **内容検証**。ディスクへ実際に載った
 *   JSON 文字列を受け取り、「自分が保存したかったものがそこに在るか」を
 *   判定する。false を返したら、その保存が成功していても待機者は false で閉じる。
 *
 *   4周目 (2026-08-04): 検証の正本を **メモリ上の Project[] 参照** から
 *   **invoke へ渡した文字列** に変えた。参照を渡すと、待機中に store 側の変更が
 *   同じ配列・同じ要素オブジェクトを触った場合に「ディスクへ載ったのは変更前の
 *   内容 / verify が見るのは変更後の内容」がすり抜ける (可変参照レース)。
 *   文字列はディスクへ載った瞬間に凍結されているので、この窓が構造的に閉じる。
 *
 *   なぜ要るか: 最後勝ちキューは中間要求を上書きスキップする。昇格中に同じ
 *   プロジェクトの削除が割り込むと、
 *     rev1 createProject(空) → rev2 confirm(スキップ) → rev3 会話入り(スキップ)
 *     → rev4 削除(成功・0件)
 *   となり、rev4 の成功が rev3 の待機者へ true として届く。だが**ディスクの
 *   会話は0件**なので、昇格は「保存できた」と誤認して未保存台帳を消す
 *   = 会話がどこにも無くなる。実測で再現済み (probe: diskHasConversation=false
 *   なのに ok=true・ledger=[])。
 *
 *   検証は「載った内容そのもの」を見る決定論的判定なので、タイミングに依存しない。
 *
 * 「rev 以下の待機者をまとめて解決する」ため、writeWaiters は rev 昇順で並ぶ
 * (push 順 = 採番順) 性質を使って先頭から刈る。
 */
let writeWaiters: {
  rev: number;
  resolve: (ok: boolean) => void;
  /** 成功時だけ呼ばれる内容検証 (未指定なら rev 判定のみ)。 */
  verify?: (writtenContent: string) => boolean;
}[] = [];

/**
 * `upTo` 以下の rev を持つ待機者を `ok` で解決する (g8t)。
 * 解決した待機者はリストから外すので、後続の保存結果に二度触れられない。
 *
 * `writtenContent` は「実際にディスクへ載った JSON 文字列」(成功時のみ)。
 * verify を持つ待機者は、その内容に自分の保存対象が在るときだけ true になる。
 * 失敗・破棄のときは渡さないので、verify は呼ばれず全員 false。
 */
function settleWaitersUpTo(
  upTo: number,
  ok: boolean,
  writtenContent?: string,
): void {
  if (writeWaiters.length === 0) return;
  const remaining: typeof writeWaiters = [];
  const settled: typeof writeWaiters = [];
  for (const w of writeWaiters) {
    if (w.rev <= upTo) settled.push(w);
    else remaining.push(w);
  }
  writeWaiters = remaining;
  for (const w of settled) {
    if (!ok || !w.verify) {
      w.resolve(ok);
      continue;
    }
    // 成功したが、載った内容に自分の保存対象が無いなら保存できたとは言えない。
    let verified = false;
    try {
      verified = writtenContent !== undefined && w.verify(writtenContent);
    } catch (err) {
      // 検証自体が壊れたら安全側 (未確認を保存済みと言わない)。
      console.error("[projects] 保存内容の検証に失敗:", err);
      verified = false;
    }
    w.resolve(verified);
  }
}

function writeToFile(
  projects: Project[],
  allowEmpty = false,
  allowDecrease = false,
  /**
   * 保存内容の検証 (g8t 3周目 / 4周目で引数を文字列へ変更)。指定すると、
   * ディスクへ実際に載った JSON 文字列がこの述語を満たすときだけ
   * 待機者へ true が返る。
   */
  verify?: (writtenContent: string) => boolean,
): Promise<boolean> {
  const rev = ++writeRevSeq;
  pendingWrite = {
    projects,
    allowEmpty,
    allowDecrease,
    staleFromReload: reloadInProgress,
    rev,
  };
  const settled = new Promise<boolean>((resolve) => {
    writeWaiters.push({ rev, resolve, verify });
  });
  if (!writeInFlight) {
    writeInFlight = (async () => {
      while (pendingWrite) {
        const job = pendingWrite;
        pendingWrite = null;
        // 読み直し中に積まれた古いスナップショットは捨てる。
        // (捨てても store は読み直し済みの正本と一致しているのでデータは失われない)
        // 破棄も「結末」なので待機者へ必ず false を配る。配らないと永久待ちになる。
        if (job.staleFromReload) {
          settleWaitersUpTo(job.rev, false);
          continue;
        }
        const outcome = await writeToFileNow(
          job.projects,
          job.allowEmpty,
          job.allowDecrease,
          job.rev,
        );
        // "requeued" は成否未確定 (同じ rev で再投入済み)。ここで解決すると
        // 再投入の実結果を待たずに誤報するので、次周回に委ねる。
        if (outcome === "requeued") continue;
        // この保存に含まれていた rev の待機者だけをここで解決する。
        // 後続の周回の成否はこの人たちには届かない。
        // 成功時は「実際に載った JSON 文字列」を渡し、内容検証を持つ
        // 待機者 (昇格など) がそこに自分の保存対象が在るかを確かめられるようにする。
        //
        // rev が一致するときだけ content を渡す (g8t 4周目)。一致しないなら
        // 「この周回で書いた内容」ではないので、別の書き込みの content で
        // 検証してしまう事故を構造的に防ぐ (verify を持つ待機者は false)。
        const landed =
          outcome === "ok" && lastWrittenContent?.rev === job.rev
            ? lastWrittenContent.content
            : undefined;
        settleWaitersUpTo(job.rev, outcome === "ok", landed);
      }
      // ここは最後の await 再開後の同期区間なので、pendingWrite チェックと
      // フラグ解除の間に別コードは割り込めない (JS シングルスレッド)。
      writeInFlight = null;
      // 取りこぼし防止の安全網。上のループで全 rev を解決しているので通常は空だが、
      // 万一残っていたら永久待ちにせず false で閉じる (未確認を保存済みと言わない)。
      settleWaitersUpTo(writeRevSeq, false);
    })();
  }
  return settled;
}

/**
 * 保存する。戻り値は「ディスクへの書き込みが成功したか」の Promise。
 *
 * 既存の呼び出し側は同期のまま戻り値を無視してよい (従来どおり fire-and-forget)。
 * 昇格 (promoteToProject) のように **保存完了を確認してから次の破壊的操作
 * (未保存台帳の削除) に進む** 経路だけが await する。
 */
function persist(
  projects: Project[],
  allowEmpty = false,
  allowDecrease = false,
  /** 保存内容の検証 (g8t 3周目 / 4周目で文字列化)。writeToFile へそのまま渡す。 */
  verify?: (writtenContent: string) => boolean,
): Promise<boolean> {
  // 旧 localStorage にも引き続き書く (緊急時の救出経路として)
  try {
    const serialized = JSON.stringify(projects);
    localStorage.setItem(PROJECTS_LS_KEY, serialized);
    if (projects.length > 0) {
      localStorage.setItem(PROJECTS_LS_BACKUP_KEY, serialized);
    }
  } catch (err) {
    console.error("[projects] localStorage 書き込み失敗:", err);
  }
  // 主たる保存先はファイル (非同期)
  return writeToFile(projects, allowEmpty, allowDecrease, verify);
}

type ProjectsState = {
  projects: Project[];

  createProject: (name: string, description?: string) => Project;
  /**
   * 下書きプロジェクトを「確定」して active にする (監査B-2)。
   * 既に active / 見つからない場合は何もしない (冪等)。
   */
  confirmProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  updateProjectDescription: (id: string, description: string | undefined) => void;
  removeProject: (id: string) => void;

  addItem: (
    projectId: string,
    item: Omit<ProjectItem, "id" | "addedAt">,
  ) => ProjectItem | null;
  removeItem: (projectId: string, itemId: string) => void;

  /**
   * 全プロジェクトを走査して、`imagePath === oldPath` のアイテムを `newPath` に書き換える。
   * F-#2 修正 (2026-05-19): ライブラリで画像をリネームした際、各プロジェクトの items[].imagePath が
   * 古いパスを保持していると黒画像になるため、リネーム成功直後に呼び出して整合性を取る。
   * 該当アイテムが無いプロジェクトは触らない (updatedAt も維持)。
   */
  renameItemPath: (oldPath: string, newPath: string) => void;

  /**
   * 旧→新パスのマップを全プロジェクトのアイテムに一括適用する。
   *
   * α版→β版で画像の保存先ディレクトリが変わり、projects.json の items[].imagePath が
   * 旧パスのまま (実体は別ディレクトリに同名で存在) になって黒画像になる症状の救済。
   * Rust 側 (images_relink_missing) が history.db を張り替えた結果の path_map を
   * そのまま渡す想定。マッチしたアイテムが無いプロジェクトは触らない (updatedAt 維持)。
   * 該当が 1 件も無ければ persist もしない (起動時の no-op で書き込みを増やさない)。
   */
  relinkItemPaths: (pathMap: Record<string, string>) => void;

  /**
   * 2026-06-06: 実体が消えた画像パスを持つ item をプロジェクトから取り除く。
   * 「画像が見つかりません」の壊れた表示を残さないため (relink で削除された分)。
   */
  pruneItemPaths: (paths: string[]) => void;

  /**
   * 企画チャットログを上書き保存する（差分ではなく毎回スナップショット）。
   *
   * ストア更新は同期。戻り値は「ディスクへの保存が成功したか」の Promise で、
   * **保存完了を待ってから次に進みたい呼び出し側だけ** が await する
   * (g8t 2026-08-04: 昇格が未保存台帳を消す前に保存を確認するため)。
   * 従来の呼び出し側は戻り値を無視してよい。
   */
  setPlanChat: (
    projectId: string,
    messages: ProjectChatMessage[],
  ) => Promise<boolean>;

  /**
   * FB#17: 企画チャットを別プロジェクトへ移動する。
   * - source の planChat を target の planChat に **上書きコピー** し、source の planChat はクリアする。
   * - 同一プロジェクトや、source に planChat が無い場合は false を返して何もしない。
   * - target / source が見つからない場合も false。
   * 成功時は true を返す。
   */
  movePlanChat: (sourceProjectId: string, targetProjectId: string) => boolean;

  /**
   * FB#17: 企画チャットを別プロジェクトへ複製する。
   * - source の planChat を target の planChat に **上書きコピー** する。source はそのまま残す。
   * - メッセージ id は衝突回避のため振り直す。
   * - 移動と同じ前提チェックで、不可なら false。
   */
  copyPlanChat: (sourceProjectId: string, targetProjectId: string) => boolean;

  /**
   * ストック素材のクレジットを記録する (法務対応 2026-05-21)。
   * 同じ photoId が既にあれば addedAt のみ更新 (重複排除)。
   * プロジェクトが見つからない場合は何もしない。
   */
  recordStockCredit: (
    projectId: string,
    credit: Omit<StockCredit, "addedAt">,
  ) => void;

  /**
   * プロジェクトの stockCredits を CSV 文字列として生成する。
   * 1 行目はヘッダ。空ログでもヘッダのみ返す。
   * 法務対応 (2026-05-21): 商用案件の出典トレース用。
   */
  buildCreditsCsv: (projectId: string) => string;

  /**
   * 初期化: ファイルから読み出して store に流し込む。
   * 起動時に必ず1回呼ぶ。複数回呼ばれても安全 (最後の結果で上書き)。
   * Tauri が動いていない時 (Vite単体プレビュー等) は localStorage に
   * フォールバックする。
   */
  initialize: () => Promise<void>;

  /**
   * 世代バックアップの一覧を取得する（新しい順）。
   * 返り値: { path, at(epochミリ秒), count(件数) }[]。
   * 「バックアップから復元」UI が選択肢を出すために使う。
   */
  listBackups: () => Promise<{ path: string; at: number; count: number }[]>;

  /**
   * 指定バックアップの内容で現在のプロジェクトを置き換える（復元）。
   * 復元前の現状も projects_write 側で自動バックアップされるので、誤復元しても戻せる。
   * 成功したら復元後の件数を返す。失敗時は throw。
   */
  restoreFromBackup: (backupPath: string) => Promise<number>;
};

export const useProjects = create<ProjectsState>((set, get) => ({
  // 初期値は同期的に localStorage から読む (起動の一瞬を埋めるため)。
  // 直後に initialize() でファイル側の正値で上書きされる。
  projects: readFromLocalStorage(),

  initialize: async () => {
    try {
      const fromFile = await readFromFile();
      const fromLs = readFromLocalStorage();
      // ファイル側が空で localStorage に有効データがあれば、マイグレーション。
      // ファイル側にデータがあればそれを正とする (ファイルが master)。
      if (fromFile.length === 0 && fromLs.length > 0) {
        console.info(
          "[projects] localStorage から", fromLs.length, "件をファイルへ移行",
        );
        await writeToFile(fromLs);
        set({ projects: fromLs });
      } else {
        set({ projects: fromFile });
      }
    } catch (err) {
      console.error("[projects] initialize 失敗:", err);
    }
  },

  listBackups: async () => {
    try {
      const { storage } = await import("../ipc");
      const rows = await storage.listProjectBackups();
      // [path, epochミリ秒, count]。Rust 側がミリ秒で返すのでそのまま使う。
      return rows.map(([path, ms, count]) => ({
        path,
        at: ms,
        count,
      }));
    } catch (err) {
      console.error("[projects] listBackups 失敗:", err);
      return [];
    }
  },

  restoreFromBackup: async (backupPath) => {
    const { storage } = await import("../ipc");
    const raw = await storage.readProjectBackup(backupPath);
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) {
      throw new Error("バックアップの形式が不正です");
    }
    // persist 経由で書き戻すと、復元前の現状も自動バックアップされる（二重に安全）。
    persist(parsed);
    set({ projects: parsed });
    return parsed.length;
  },

  createProject: (name, description) => {
    const now = Date.now();
    const project: Project = {
      id: generateId(),
      name: name.trim() || "無題のプロジェクト",
      description: description?.trim() || undefined,
      // 作成直後は下書き。確定 (confirmProject) するまで UI に「下書き」バッジが出る。
      status: "draft",
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    const next = [project, ...get().projects];
    persist(next);
    set({ projects: next });
    return project;
  },

  confirmProject: (id) => {
    const next = get().projects.map((p) =>
      // undefined (旧データ = active 扱い) や既に active のものは触らない (冪等)。
      p.id === id && p.status === "draft"
        ? { ...p, status: "active" as const, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().projects.map((p) =>
      p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
    );
    persist(next);
    set({ projects: next });
  },

  updateProjectDescription: (id, description) => {
    const next = get().projects.map((p) =>
      p.id === id
        ? {
            ...p,
            description: description?.trim() || undefined,
            updatedAt: Date.now(),
          }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  removeProject: (id) => {
    const next = get().projects.filter((p) => p.id !== id);
    // ユーザーが明示的にプロジェクトを削除した結果 0 件になる場合は、空書き込みを
    // 許可する (allowEmpty)。そうしないと空上書きガードに弾かれ「消したのに再起動で
    // 復活する」退行になる (evaluator 指摘)。
    persist(next, next.length === 0);
    set({ projects: next });
    // 削除したプロジェクトがアクティブのままだと、localStorage に死んだ ID が残り、
    // 再起動後「存在しないプロジェクト選択中」でタイムラインが空に見える (2026-06-10 調査)。
    void import("./activeProject").then(({ useActiveProject }) => {
      const active = useActiveProject.getState();
      if (active.activeProjectId === id) active.setActive(null);
    });
  },

  addItem: (projectId, itemData) => {
    const projects = get().projects;
    const target = projects.find((p) => p.id === projectId);
    if (!target) return null;
    // 同じ画像パスが既に箱の中にあれば addedAt だけ更新（重複追加を防ぐ）
    const existing = target.items.find((it) => it.imagePath === itemData.imagePath);
    let nextItem: ProjectItem;
    if (existing) {
      nextItem = { ...existing, ...itemData, addedAt: Date.now() };
    } else {
      nextItem = {
        id: generateId(),
        addedAt: Date.now(),
        ...itemData,
      };
    }
    const nextItems = existing
      ? target.items.map((it) => (it.id === existing.id ? nextItem : it))
      : [nextItem, ...target.items];
    const next = projects.map((p) =>
      p.id === projectId
        ? { ...p, items: nextItems, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });

    // 呼び出し側の同期 API は保ったまま、履歴が見つかった時だけ生成プロセスを追記する。
    // 取得失敗・履歴なしの場合は推測で埋めず generation 未定義のまま残す。
    if (!nextItem.generation) {
      const itemId = nextItem.id;
      const imagePath = nextItem.imagePath;
      void import("../ipc")
        .then(({ history }) => history.generationInfoForImage(imagePath))
        .then((generation) => {
          if (!generation) return;
          const current = get().projects;
          let changed = false;
          const enriched = current.map((project) => {
            if (project.id !== projectId) return project;
            const items = project.items.map((item) => {
              if (item.id !== itemId || item.generation) return item;
              changed = true;
              return { ...item, generation };
            });
            return changed ? { ...project, items, updatedAt: Date.now() } : project;
          });
          if (!changed) return;
          persist(enriched);
          set({ projects: enriched });
        })
        .catch((err) => {
          console.warn("[projects] 生成プロセスの取得に失敗しました:", err);
        });
    }
    return nextItem;
  },

  removeItem: (projectId, itemId) => {
    const next = get().projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            items: p.items.filter((it) => it.id !== itemId),
            updatedAt: Date.now(),
          }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  renameItemPath: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const now = Date.now();
    let changed = false;
    const next = get().projects.map((p) => {
      let projectChanged = false;
      const items = p.items.map((it) => {
        if (it.imagePath === oldPath) {
          projectChanged = true;
          changed = true;
          return { ...it, imagePath: newPath };
        }
        return it;
      });
      return projectChanged ? { ...p, items, updatedAt: now } : p;
    });
    if (!changed) return;
    persist(next);
    set({ projects: next });
  },

  relinkItemPaths: (pathMap) => {
    if (!pathMap || Object.keys(pathMap).length === 0) return;
    const now = Date.now();
    let changed = false;
    const next = get().projects.map((p) => {
      let projectChanged = false;
      const items = p.items.map((it) => {
        const newPath = pathMap[it.imagePath];
        if (newPath && newPath !== it.imagePath) {
          projectChanged = true;
          changed = true;
          return { ...it, imagePath: newPath };
        }
        return it;
      });
      return projectChanged ? { ...p, items, updatedAt: now } : p;
    });
    if (!changed) return;
    persist(next);
    set({ projects: next });
  },

  pruneItemPaths: (paths) => {
    if (!paths || paths.length === 0) return;
    const dead = new Set(paths);
    const now = Date.now();
    let changed = false;
    const next = get().projects.map((p) => {
      const items = p.items.filter((it) => !dead.has(it.imagePath));
      if (items.length !== p.items.length) {
        changed = true;
        return { ...p, items, updatedAt: now };
      }
      return p;
    });
    if (!changed) return;
    persist(next);
    set({ projects: next });
  },

  setPlanChat: (projectId, messages) => {
    const next = get().projects.map((p) =>
      p.id === projectId
        ? { ...p, planChat: messages, updatedAt: Date.now() }
        : p,
    );
    // g8t (2026-08-04): 保存完了 Promise を返す。ストア更新は従来どおり同期なので
    // 既存の呼び出し側 (turn/completed のスナップショット保存など) は無変更のまま
    // fire-and-forget で使える。昇格だけがこれを await して、保存を確認してから
    // 未保存台帳を消す。
    //
    // g8t 3周目: 「rev が進んだから載ったはず」では足りない。最後勝ちキューは
    // 中間要求を上書きスキップするので、この保存が飛ばされた後に
    // **同じプロジェクトを削除した** スナップショットが載ることがある。
    // その成功を true として受け取ると、会話がディスクに無いのに昇格が成功扱いに
    // なり未保存台帳を消す (= 消失)。実際に載った内容に「このプロジェクトが在り、
    // 会話が入っている」ことを確かめてから true にする。
    //
    // g8t 4周目: 件数 (>= expected) では足りない。同じプロジェクトへ **別の会話**
    // の後続保存が成功すると、スキップされた元会話の待機者にも true が返る
    // (件数だけは満たされるため)。元会話はディスクに無いのに昇格が成功扱いになり、
    // 未保存台帳を消して会話が消える。**全メッセージが id 単位で一致する** ことを
    // 照合する。
    //
    // 期待値は verify 生成時点で文字列キーへ畳んで凍結する。messages 配列も
    // 要素オブジェクトも待機中に外から変更されうるため、参照を持ち越さない。
    //
    // g8t 4周目 追補 (Sol指摘 → 実測で確認 2026-08-04): id も一緒に凍結する。
    // 照合時に `messages[i].id` を live 参照していたため、待機中に配列が縮む
    // (pop など) だけで `messages[1]` が undefined になり throw していた。
    // 安全側 (false) には倒れるが、**ディスクには正しく載っているのに
    // 「保存できていない」と誤報する**ため、昇格が不必要に失敗しうる。
    const expectedEntries = messages.map((m) => ({
      id: m.id,
      key: planChatMessageKey(m),
    }));
    const saved = persist(next, false, false, (writtenContent) => {
      let written: unknown;
      try {
        written = JSON.parse(writtenContent);
      } catch {
        return false; // 読めない内容を「保存できた」とは言わない
      }
      if (!Array.isArray(written)) return false;
      const target = (written as Project[]).find((p) => p?.id === projectId);
      if (!target) return false; // 削除が割り込んだ = 会話は載っていない
      const landed = new Map<string, string>();
      for (const m of target.planChat ?? []) {
        if (!m || typeof m.id !== "string") continue;
        landed.set(m.id, planChatMessageKey(m));
      }
      // 期待した各メッセージが、同じ id で同じ内容として載っているか。
      // 1 件でも欠けるか食い違えば「自分の会話は載っていない」。
      return expectedEntries.every((e) => landed.get(e.id) === e.key);
    });
    set({ projects: next });
    return saved;
  },

  movePlanChat: (sourceProjectId, targetProjectId) => {
    if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) {
      return false;
    }
    const projects = get().projects;
    const source = projects.find((p) => p.id === sourceProjectId);
    const target = projects.find((p) => p.id === targetProjectId);
    if (!source || !target) return false;
    const chat = source.planChat ?? [];
    if (chat.length === 0) return false;
    const now = Date.now();
    // 新規配列を作って immutability を守る（既存メッセージはそのまま運ぶ）。
    const moved = chat.map((m) => ({ ...m }));
    const next = projects.map((p) => {
      if (p.id === targetProjectId) {
        return { ...p, planChat: moved, updatedAt: now };
      }
      if (p.id === sourceProjectId) {
        return { ...p, planChat: [], updatedAt: now };
      }
      return p;
    });
    persist(next);
    set({ projects: next });
    return true;
  },

  copyPlanChat: (sourceProjectId, targetProjectId) => {
    if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId) {
      return false;
    }
    const projects = get().projects;
    const source = projects.find((p) => p.id === sourceProjectId);
    const target = projects.find((p) => p.id === targetProjectId);
    if (!source || !target) return false;
    const chat = source.planChat ?? [];
    if (chat.length === 0) return false;
    const now = Date.now();
    // コピー時は id を振り直して、移動元と target で id が衝突しないようにする。
    const copied = chat.map((m) => ({ ...m, id: generateId() }));
    const next = projects.map((p) =>
      p.id === targetProjectId
        ? { ...p, planChat: copied, updatedAt: now }
        : p,
    );
    persist(next);
    set({ projects: next });
    return true;
  },

  recordStockCredit: (projectId, credit) => {
    const projects = get().projects;
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    const existing = (target.stockCredits ?? []).find(
      (c) => c.provider === credit.provider && c.photoId === credit.photoId,
    );
    const nextCredit: StockCredit = existing
      ? { ...existing, ...credit, addedAt: Date.now() }
      : { ...credit, addedAt: Date.now() };
    const nextCredits = existing
      ? (target.stockCredits ?? []).map((c) =>
          c.provider === existing.provider && c.photoId === existing.photoId
            ? nextCredit
            : c,
        )
      : [nextCredit, ...(target.stockCredits ?? [])];
    const next = projects.map((p) =>
      p.id === projectId
        ? { ...p, stockCredits: nextCredits, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  buildCreditsCsv: (projectId) => {
    const target = get().projects.find((p) => p.id === projectId);
    // 組み立ては純関数 buildCreditsCsv (projectLogCsv.ts) に委譲する。
    // ストアのメソッドはテストから直接呼べないため、CSV の形を決める部分を
    // 依存ゼロの純関数に置き、本体とテストが同じ関数を通るようにする (B4)。
    // 対象プロジェクトが無いときもヘッダだけの CSV を返す (従来と同じ挙動)。
    if (!target) return buildCreditsCsvRows(undefined, { id: projectId, name: "" });
    return buildCreditsCsvRows(target.stockCredits, {
      id: target.id,
      name: target.name,
    });
  },
}));

/**
 * プロジェクトの記録 (生成画像・動画のプロンプト + 企画チャット) を、
 * Excel で開ける 1 枚の CSV として保存する。
 *
 * 旧データで generation が無い場合だけ history.db を後追い照会し、
 * それでも見つからない生成項目は空欄にする (欠落は欠落のまま残す)。
 * CSV の組み立て自体は純関数 buildProjectLogCsv に委譲する。
 */
export async function exportProjectCsv(projectId: string): Promise<boolean> {
  const target = useProjects.getState().projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error("プロジェクトが見つかりません");
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  // ファイル名に使えない文字を除去 (exportCreditsCsv App.tsx と同じ規則)。
  const safeName = target.name.replace(/[\\/:*?"<>|]/g, "_") || "project";
  const fileName = `${safeName}-プロジェクト記録.csv`;
  // 保存先のデフォルトを「書類」フォルダにする。fs:scope で許可済みの場所
  // (書類 / デスクトップ / ダウンロード) に着地させることで、保存ダイアログ
  // 直後の writeTextFile が権限エラーで失敗しないようにする。
  let defaultPath = fileName;
  try {
    const { documentDir, join } = await import("@tauri-apps/api/path");
    defaultPath = await join(await documentDir(), fileName);
  } catch {
    // 書類フォルダの解決に失敗してもファイル名だけで続行する。
  }
  const destination = await save({
    defaultPath,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!destination) return false;

  const { history } = await import("../ipc");
  const resolved = await Promise.all(
    target.items.map(async (item) => {
      let generation = item.generation;
      if (!generation) {
        try {
          generation =
            (await history.generationInfoForImage(item.imagePath)) ?? undefined;
        } catch (err) {
          console.warn("[projects] CSV用の生成プロセス取得に失敗しました:", err);
        }
      }
      return [item.id, generation] as const;
    }),
  );

  const csv = buildProjectLogCsv(target, new Map(resolved));
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(destination, csv);
  return true;
}
