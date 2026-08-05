import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { useToasts } from "../lib/store/toasts";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; downloaded: number; total: number }
  | { kind: "installing" }
  | {
      kind: "error";
      /** ユーザー向けの説明。次の行動が分かる日本語。 */
      message: string;
      /** 手動DLの導線を出すか。 */
      showManual?: boolean;
      /** 報告用の生メッセージ。 */
      raw?: string;
      /** どの段階で失敗したか。報告用。 */
      stage?: UpdateStage;
    };

/**
 * 設定画面に置く「アップデート確認」セクション。
 * Tauri Updater プラグイン経由で更新メタファイルを見にいき、新バージョンが
 * あれば DL + 自動再起動。参照先は tauri.conf.json の updater.endpoints で定義:
 *   https://github.com/funstack-app/gorigori-kun/releases/latest/download/latest.json
 * (このコメントは説明用。実際の参照先は必ず tauri.conf.json 側を正とする)
 */
/**
 * リリースページ。更新が自動で通らないときの手動DL先。
 *
 * なぜ配布リポジトリ (gorigori-kun-releases) を指すか (2026-08-06 修正):
 *   従来は `funstack-app/gorigori-kun` の releases/latest を開いていたが、
 *   そこに置かれるのは updater マニフェスト (latest.json / latest-compat.json) だけで
 *   **本体インストーラが 1 つも無い**。手動DLボタンを押したユーザーが JSON しか
 *   置いていないページに飛ばされ、逃げ道として機能していなかった (今日の実害)。
 *   本体 (dmg / setup.exe) は publish-manual.yml が
 *   `funstack-app/gorigori-kun-releases` に上げているので、そちらを開く。
 */
export const RELEASES_URL =
  "https://github.com/funstack-app/gorigori-kun-releases/releases/latest";

/**
 * 更新が失敗した段階。「詳細（報告用）」に出して原因の切り分けを助ける。
 *
 * なぜ段階が要るか (2026-08-06):
 *   分類 (ネットワーク / 署名 / ディスク / 権限) だけでは、
 *   「そもそもマニフェストに届いていない」のか「500MB 落とし切った後で
 *   署名検証に失敗した」のかが区別できない。Windows の更新不能 (v2.5.1) は
 *   後者だったが、報告からはそれが読み取れなかった。
 */
export type UpdateStage =
  | "manifest"
  | "download"
  | "verify"
  | "install"
  | "unknown";

/** 段階の日本語ラベル (報告用の表示に使う)。 */
export const UPDATE_STAGE_LABEL: Record<UpdateStage, string> = {
  manifest: "更新情報の取得",
  download: "ダウンロード中",
  verify: "更新ファイルの検証",
  install: "インストール",
  unknown: "不明",
};

/**
 * 呼び出し元が分かっている範囲での段階ヒント。
 *   - `check`: `check()` だけを呼ぶ経路。失敗は必ずマニフェスト取得段階。
 *   - `install`: `downloadAndInstall()` 経路。DL 以降のどこかで失敗している。
 */
export type UpdateStageHint = "check" | "install";

type UpdateFailure = {
  /** ユーザーに見せる本文。次の行動が分かる日本語にする。 */
  text: string;
  /** 手動DLの導線を出すか。署名系・原因不明では必ず出す。 */
  showManual: boolean;
  /** 報告用に残す生のメッセージ。 */
  raw: string;
  /** どの段階で失敗したか。報告用。 */
  stage: UpdateStage;
};

/**
 * 失敗した段階を判定する。
 *
 * エラー文字列だけでは足りない (「network error」は manifest 取得中にも
 * DL 中にも出る) ので、**呼び出し元のヒントと併用**する。
 *   - `check` 経路なら、まだ DL に入っていないので manifest 段階で確定。
 *   - `install` 経路なら DL 以降。文字列から verify / install を拾い、
 *     どちらでもなければ download とみなす。
 */
export function classifyUpdateStage(
  err: unknown,
  hint: UpdateStageHint,
): UpdateStage {
  const lower = String(err).toLowerCase();

  if (hint === "check") return "manifest";

  const isVerify =
    lower.includes("signature") ||
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("untrusted") ||
    lower.includes("minisign");
  if (isVerify) return "verify";

  const isInstall =
    lower.includes("install") ||
    lower.includes("extract") ||
    lower.includes("unpack") ||
    lower.includes("mount") ||
    lower.includes("replace") ||
    lower.includes("elevat");
  if (isInstall) return "install";

  // DL 中の失敗 (ネットワーク断・容量不足・メモリ不足)。
  // v2.5.1 の Windows 更新不能はここに落ちる想定。
  return "download";
}

/**
 * 更新の失敗を分類して、ユーザーが次に何をすればよいかを示す。
 *
 * なぜ (2026-07-25 配布検証の指摘):
 *   従来は String(err) をそのまま「更新に失敗: <生の英語>」と出していた。
 *   ネットワーク断・署名検証失敗・ディスク不足・権限不足が全て同じ見た目になり、
 *   非エンジニアは何が起きたか判断できない。しかも署名不一致のように
 *   「再試行しても永久に直らない」種類の失敗で再試行ボタンだけを見せると、
 *   ユーザーは抜け出せない。
 *   分類して文言を出し分け、どの分岐でも手動DLの逃げ道を残す。
 */
export function classifyUpdateFailure(
  err: unknown,
  hint: UpdateStageHint,
): UpdateFailure {
  const raw = String(err);
  const lower = raw.toLowerCase();
  const stage = classifyUpdateStage(err, hint);

  const isNetwork =
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("dns") ||
    lower.includes("connection") ||
    lower.includes("failed to fetch") ||
    lower.includes("could not connect");
  if (isNetwork) {
    return {
      text: "インターネットに接続できませんでした。接続を確認してもう一度お試しください。",
      showManual: false,
      raw,
      stage,
    };
  }

  const isSignature =
    lower.includes("signature") ||
    lower.includes("verify") ||
    lower.includes("verification") ||
    lower.includes("untrusted") ||
    lower.includes("minisign");
  if (isSignature) {
    return {
      // 再試行しても直らない種類。手動DLへ誘導する。
      text: "更新ファイルの検証に失敗しました。お手数ですが、下のボタンから最新版を直接ダウンロードしてください。",
      showManual: true,
      raw,
      stage,
    };
  }

  const isDisk =
    lower.includes("no space") ||
    lower.includes("disk full") ||
    lower.includes("enospc");
  if (isDisk) {
    return {
      text: "ディスクの空き容量が足りません。空き容量を作ってからもう一度お試しください。",
      showManual: false,
      raw,
      stage,
    };
  }

  const isPermission =
    lower.includes("permission") ||
    lower.includes("access is denied") ||
    lower.includes("eacces") ||
    lower.includes("operation not permitted");
  if (isPermission) {
    return {
      text: "更新の書き込みが許可されませんでした。アプリを一度終了してから、もう一度お試しください。",
      showManual: true,
      raw,
      stage,
    };
  }

  return {
    text: "更新に失敗しました。下のボタンから最新版を直接ダウンロードできます。",
    showManual: true,
    raw,
    stage,
  };
}

/**
 * 起動時の自動更新チェック (UPD-03, 2026-07-25)。
 *
 * なぜ:
 *   従来は設定画面を開いて「アップデートを確認」を手で押すまでチェックが
 *   走らず、既存ユーザーが新版に気づけなかった。起動後に一度だけ静かに見にいく。
 *
 * 設計の制約 (押し付けない・起動を遅くしない):
 *   - モーダルで止めない。控えめな info トーストだけ出し、実際の更新は
 *     設定画面の既存 UI から任意のタイミングで実行させる。
 *   - 失敗は完全に沈黙する。起動直後はネットワーク未接続が普通にあり、
 *     ここでエラートーストを出すと「起動したら毎回赤い通知」になる。
 *     手動チェック側は理由を分類して出すので、情報自体は失われない。
 *   - 呼び出し側を待たせない (即 return して裏で走る)。
 *   - モジュールスコープのフラグで多重起動を防ぐ。UpdateChecker は設定タブの
 *     出入りで再マウントされるため、これが無いと開くたびに走ってしまう。
 */
let startupCheckStarted = false;

/** 起動直後の重い初期化 (codex 起動・認証) と競合させないための待ち。 */
const STARTUP_CHECK_DELAY_MS = 8000;

export function startStartupUpdateCheck(): void {
  if (startupCheckStarted) return;
  startupCheckStarted = true;

  setTimeout(() => {
    void (async () => {
      try {
        const update = await check();
        if (!update) return; // 最新版。何も言わない
        useToasts.getState().push({
          kind: "info",
          text: `新しいバージョン ${update.version} があります。設定 → アップデートから更新できます。`,
          ttlMs: 12000,
        });
      } catch {
        // 起動時チェックの失敗は無視する (オフライン起動で赤い通知を出さない)。
      }
    })();
  }, STARTUP_CHECK_DELAY_MS);
}

/*
 * 起動時チェックの発火点。
 *
 * このモジュールは SettingsWorkspace → App.tsx の静的 import で繋がっており、
 * 設定タブを開かなくてもアプリ起動時に必ず評価される。そのためここで呼ぶだけで
 * 「起動後に一度」が成立する (App.tsx を触らずに済む)。
 *
 * dev では実行しない。開発中はバージョンが配布版より新しく、更新なしと分かって
 * いるのに毎回 HTTP を叩くだけになるため。
 */
if (!import.meta.env.DEV) {
  startStartupUpdateCheck();
}

/** リリースページを既定ブラウザで開く。既存流儀に合わせて動的 import する。 */
async function openReleasesPage(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(RELEASES_URL);
  } catch {
    // 開けなくてもアプリは壊さない。URL は画面に出ているので手で開ける。
  }
}

export function UpdateChecker() {
  const [current, setCurrent] = useState<string>("...");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const pushToast = useToasts((s) => s.push);

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => setCurrent("?"));
  }, []);

  const runCheck = async () => {
    setStatus({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        setStatus({ kind: "up-to-date" });
        return;
      }
      setStatus({
        kind: "available",
        version: update.version,
        notes: update.body,
      });
    } catch (err) {
      // runCheck は check() しか呼ばないので、失敗は必ずマニフェスト取得段階。
      const failure = classifyUpdateFailure(err, "check");
      setStatus({
        kind: "error",
        message: failure.text,
        showManual: failure.showManual,
        raw: failure.raw,
        stage: failure.stage,
      });
      pushToast({ kind: "error", text: failure.text, ttlMs: 7000 });
    }
  };

  const runInstall = async () => {
    setStatus({ kind: "downloading", downloaded: 0, total: 0 });
    // runInstall は check() → downloadAndInstall() の 2 段。どちらで落ちたかで
    // 段階が変わるので、check() を抜けた時点でヒントを install に切り替える。
    let hint: UpdateStageHint = "check";
    try {
      const update = await check();
      if (!update) {
        setStatus({ kind: "up-to-date" });
        return;
      }
      hint = "install";
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setStatus({ kind: "downloading", downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({ kind: "downloading", downloaded, total });
        } else if (event.event === "Finished") {
          setStatus({ kind: "installing" });
        }
      });
      // インストール完了 → 再起動
      await relaunch();
    } catch (err) {
      const failure = classifyUpdateFailure(err, hint);
      setStatus({
        kind: "error",
        message: failure.text,
        showManual: failure.showManual,
        raw: failure.raw,
        stage: failure.stage,
      });
      pushToast({ kind: "error", text: failure.text, ttlMs: 8000 });
    }
  };

  return (
    <section className="mt-6 space-y-3">
      <header>
        <h3 className="text-sm font-black text-neutral-100">アップデート</h3>
        <p className="mt-1 text-[11px] text-neutral-500">
          現在のバージョン: <span className="font-mono">{current}</span>
        </p>
      </header>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#101010] p-3">
        {status.kind === "idle" && (
          <button
            type="button"
            onClick={runCheck}
            className="rounded-md bg-pink-500 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-pink-400"
          >
            アップデートを確認
          </button>
        )}

        {status.kind === "checking" && (
          <p className="py-2 text-center text-sm text-neutral-300">確認中…</p>
        )}

        {status.kind === "up-to-date" && (
          <div className="space-y-2">
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2 py-2 text-center text-sm font-bold text-emerald-200">
              ✓ 最新版を使っています
            </p>
            <button
              type="button"
              onClick={runCheck}
              className="w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              もう一度確認
            </button>
          </div>
        )}

        {status.kind === "available" && (
          <div className="space-y-2">
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-2 py-2 text-sm text-yellow-100">
              新しいバージョン <span className="font-mono font-black">{status.version}</span> が利用可能です
              {status.notes && (
                <p className="mt-1 text-[11px] text-neutral-300">
                  {status.notes}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={runInstall}
              className="w-full rounded-lg bg-pink-500 px-3 py-2 text-sm font-black text-white transition hover:bg-pink-400"
            >
              更新する(自動で再起動)
            </button>
          </div>
        )}

        {status.kind === "downloading" && (
          <div className="space-y-2">
            <p className="text-sm font-bold text-neutral-200">
              ダウンロード中…{" "}
              {status.total > 0 && (
                <span className="font-mono text-xs text-neutral-400">
                  {Math.round((status.downloaded / status.total) * 100)}%
                </span>
              )}
            </p>
            <div className="h-2 overflow-hidden rounded bg-[#2a2a2a]">
              <div
                className="h-full bg-pink-500 transition-all"
                style={{
                  width:
                    status.total > 0
                      ? `${(status.downloaded / status.total) * 100}%`
                      : "0%",
                }}
              />
            </div>
          </div>
        )}

        {status.kind === "installing" && (
          <p className="py-2 text-center text-sm font-bold text-neutral-200">
            インストール中… 自動で再起動します
          </p>
        )}

        {status.kind === "error" && (
          <div className="space-y-2">
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-2 py-2 text-[11px] text-rose-200">
              {status.message}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={runCheck}
                className="flex-1 rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                もう一度試す
              </button>
              {/*
                手動DLの逃げ道。署名検証失敗のように再試行では直らない失敗で、
                これが無いとユーザーは抜け出せない (2026-07-25 配布検証の指摘)。
              */}
              {status.showManual && (
                <button
                  type="button"
                  onClick={() => void openReleasesPage()}
                  className="flex-1 rounded-lg border border-pink-500/50 bg-pink-500/10 px-3 py-1.5 text-xs font-black text-pink-100 hover:border-pink-400 hover:bg-pink-500/20"
                >
                  最新版をダウンロード
                </button>
              )}
            </div>
            {/* 報告用。原因の切り分けに必要なので隠さず、ただし小さく置く */}
            {status.raw && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] text-neutral-600 hover:text-neutral-400">
                  詳細（報告用）
                </summary>
                {/*
                  どの段階で落ちたかを先に出す。生メッセージだけだと
                  「マニフェストに届いていない」のか「落とし切った後で検証に
                  失敗した」のかが読み取れない (2026-08-06)。
                */}
                {status.stage && (
                  <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
                    失敗した段階: {UPDATE_STAGE_LABEL[status.stage]}
                  </p>
                )}
                <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-neutral-500">
                  {status.raw}
                </p>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
