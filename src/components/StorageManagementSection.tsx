import { useEffect, useState } from "react";

import {
  images,
  storage,
  storageCleanup,
  type CleanupInspection,
  type CleanupReport,
} from "../lib/ipc";
import { useProjects } from "../lib/store/projects";
import { useToasts } from "../lib/store/toasts";

/**
 * 設定画面の「保存先」タブに表示するストレージ管理セクション。
 *
 * 上段: ユーザーの作品データ(絶対に自動削除しないもの)
 * 下段: 一時データ(自動削除対象、手動でも削除可)
 */
export function StorageManagementSection() {
  const [inspection, setInspection] = useState<CleanupInspection | null>(null);
  const [workSize, setWorkSize] = useState<number | null>(null);
  const [workPath, setWorkPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const [lastReport, setLastReport] = useState<CleanupReport | null>(null);
  const pushToast = useToasts((s) => s.push);

  const refresh = async () => {
    try {
      const [i, settings, stats] = await Promise.all([
        storageCleanup.inspect(),
        storage.getSettings(),
        storage.usageStats(),
      ]);
      setInspection(i);
      setWorkPath(settings.storageRoot);
      setWorkSize(stats.totalBytes);
    } catch (err) {
      pushToast({ kind: "error", text: `ストレージ情報の取得失敗: ${String(err)}` });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const runRelink = async () => {
    if (relinking) return;
    setRelinking(true);
    try {
      // history.db は Rust が張り替える。projects.json は返ってきた旧→新マップで適用。
      const result = await images.relinkMissing();
      useProjects.getState().relinkItemPaths(result.pathMap);
      const fixed = result.dbUpdated + Object.keys(result.pathMap).length;
      if (fixed > 0) {
        pushToast({
          kind: "success",
          text: `画像パスを ${fixed} 件修復しました${
            result.dbUnresolved > 0 ? ` (見つからなかった: ${result.dbUnresolved} 件)` : ""
          }`,
        });
      } else {
        pushToast({
          kind: "success",
          text: "修復が必要な画像はありませんでした",
        });
      }
    } catch (err) {
      pushToast({ kind: "error", text: `画像パス修復に失敗: ${String(err)}` });
    } finally {
      setRelinking(false);
    }
  };

  const runCleanup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const report = await storageCleanup.run();
      setLastReport(report);
      const freedMb = Math.round(
        (report.sessionsBytesFreed + report.generatedImagesBytesFreed) / 1_000_000,
      );
      pushToast({
        kind: "success",
        text: `掃除完了: 約 ${freedMb}MB 解放しました`,
      });
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", text: `掃除失敗: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 space-y-3">
      <header>
        <h3 className="text-sm font-black text-neutral-100">ストレージ管理</h3>
        <p className="mt-1 text-[11px] text-neutral-500">
          このアプリは一時データを自動で整理します。作品データは絶対に消えません。
        </p>
      </header>

      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        <h4 className="text-xs font-black text-emerald-300">
          🔒 あなたの作品データ (自動削除されません)
        </h4>
        <ul className="mt-2 space-y-1 text-[11px] text-neutral-300">
          <li className="flex items-center justify-between">
            <span>生成画像</span>
            <span className="font-mono text-neutral-400">{formatBytes(workSize)}</span>
          </li>
          <li className="flex items-center justify-between text-[10px] text-neutral-500">
            <span>プリセット / スキル</span>
            <span>保護されています</span>
          </li>
        </ul>
        {workPath && (
          <p className="mt-2 truncate text-[10px] text-neutral-500">{workPath}</p>
        )}
        <button
          type="button"
          onClick={runRelink}
          disabled={relinking}
          className="mt-3 w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-black text-emerald-100 hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {relinking ? "修復中…" : "画像が見えない時はここを押す (パス修復)"}
        </button>
        <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
          昔の作品が黒画像/「画像が見つかりません」になる場合に、記録と実体の
          ズレを直します。ファイルは移動・削除しません。
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <h4 className="text-xs font-black text-amber-300">
          🗑 一時データ (3日以上前のものは自動削除)
        </h4>
        <ul className="mt-2 space-y-1 text-[11px] text-neutral-300">
          <li className="flex items-center justify-between">
            <span>Codex 対話履歴</span>
            <span className="font-mono text-neutral-400">
              {formatBytes(inspection?.sessionsBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>Codex ログ</span>
            <span className="font-mono text-neutral-400">
              {formatBytes(inspection?.logsBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>古い生成画像キャッシュ</span>
            <span className="font-mono text-neutral-400">
              {formatBytes(inspection?.generatedBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>WebView キャッシュ</span>
            <span className="font-mono text-neutral-400">
              {formatBytes(inspection?.cacheBytes)}
            </span>
          </li>
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-amber-500/20 pt-2">
          <span className="text-[11px] font-bold text-amber-200">合計</span>
          <span className="font-mono text-sm font-black text-amber-100">
            {formatBytes(inspection?.totalBytes)}
          </span>
        </div>
        <button
          type="button"
          onClick={runCleanup}
          disabled={busy}
          className="mt-3 w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-black text-amber-100 hover:border-amber-400 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "整理中…" : "今すぐ整理する"}
        </button>
      </div>

      {lastReport && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3 text-[11px] text-neutral-300">
          <p className="font-bold text-neutral-100">前回の整理結果</p>
          <p className="mt-1">
            セッション {lastReport.sessionsDeleted} 件 (
            {formatBytes(lastReport.sessionsBytesFreed)}) 削除
          </p>
          <p>
            古い画像キャッシュ {lastReport.generatedImagesDeleted} 件 (
            {formatBytes(lastReport.generatedImagesBytesFreed)}) 削除
          </p>
          {lastReport.errors.length > 0 && (
            <p className="mt-1 text-red-300">
              エラー: {lastReport.errors.join(", ")}
            </p>
          )}
        </div>
      )}

      <p className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[10px] leading-relaxed text-neutral-500">
        💡 一時データを残しておくと PC の空き容量を圧迫します。3日以上前のものは
        裏側で自動的に削除しています。作品(画像/プリセット/スキル)には一切影響しません。
      </p>
    </section>
  );
}

function formatBytes(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
