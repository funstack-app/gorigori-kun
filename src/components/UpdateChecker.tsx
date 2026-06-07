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
  | { kind: "error"; message: string };

/**
 * 設定画面に置く「アップデート確認」セクション。
 * Tauri Updater プラグイン経由で更新メタファイルを見にいき、新バージョンが
 * あれば DL + 自動再起動。参照先は tauri.conf.json の updater.endpoints で定義:
 *   https://github.com/funstack-app/gorigori-kun/releases/latest/download/latest.json
 * (このコメントは説明用。実際の参照先は必ず tauri.conf.json 側を正とする)
 */
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
      const msg = String(err);
      setStatus({ kind: "error", message: msg });
      pushToast({ kind: "error", text: `更新確認に失敗: ${msg}`, ttlMs: 6000 });
    }
  };

  const runInstall = async () => {
    setStatus({ kind: "downloading", downloaded: 0, total: 0 });
    try {
      const update = await check();
      if (!update) {
        setStatus({ kind: "up-to-date" });
        return;
      }
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
      const msg = String(err);
      setStatus({ kind: "error", message: msg });
      pushToast({ kind: "error", text: `更新に失敗: ${msg}`, ttlMs: 8000 });
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
            className="w-full rounded-lg bg-pink-500 px-3 py-2 text-sm font-black text-white transition hover:bg-pink-400"
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
              エラー: {status.message}
            </p>
            <button
              type="button"
              onClick={runCheck}
              className="w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              再試行
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
