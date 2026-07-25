import { useEffect, useState } from "react";

import {
  editModels,
  images,
  storage,
  storageCleanup,
  type CleanupInspection,
  type CleanupReport,
} from "../lib/ipc";
import type { ModelStatus } from "../lib/edit/types";
import { useProjects } from "../lib/store/projects";
import { useToasts } from "../lib/store/toasts";

/**
 * フラットラインアイコン群 (STΛCK 指示 2026-07-25: 絵文字を全廃し SVG へ)。
 * SkillIcon.tsx と同じ流儀: 24x24 viewBox / stroke=currentColor / ラウンドキャップ。
 */
function LockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="mt-[2px] shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M15 4a5 5 0 0 0-4.6 7l-6 6 2.6 2.6 6-6A5 5 0 1 0 15 4z" />
    </svg>
  );
}

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
  // F-4 (2026-07-25): 再DL可能な AI モデル (models/ 配下) は掃除手段が無く数GB残っていた。
  // 自動削除はしない (機能が壊れる)。DL 済みだけを一覧し、明示操作で消せるようにする。
  const [models, setModels] = useState<ModelStatus[] | null>(null);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
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
    // モデル一覧は失敗しても他の表示を止めない (未DL環境では空一覧が正常)。
    try {
      setModels(await editModels.list());
    } catch (err) {
      console.error("[StorageManagementSection] model list failed:", err);
      setModels([]);
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

  /**
   * F-4: DL 済みモデルを1件削除する。実体は既存の edit_models_delete (ファイル1本を消して
   * 推論ランタイムをクリア)。次に使うときに自動で再DLされるため作品データは失われない。
   */
  const deleteModel = async (model: ModelStatus) => {
    if (deletingModelId) return;
    setDeletingModelId(model.id);
    try {
      await editModels.delete(model.id);
      pushToast({
        kind: "success",
        text: `${model.displayName} を削除しました (次に使うとき自動で再ダウンロード)`,
      });
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", text: `削除に失敗: ${String(err)}` });
    } finally {
      setDeletingModelId(null);
    }
  };

  const downloadedModels = (models ?? []).filter((m) => m.downloaded);
  const downloadedModelBytes = downloadedModels.reduce((sum, m) => sum + m.sizeBytes, 0);

  const runCleanup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const report = await storageCleanup.run();
      setLastReport(report);
      // FB-A4: Codex ログ + WebView キャッシュ解放分 (cacheBytesFreed) も合算する。
      // run_cleanup がこれらも消すようになったので、解放量が実態に合うようにする。
      const freedMb = Math.round(
        (report.sessionsBytesFreed +
          report.generatedImagesBytesFreed +
          report.cacheBytesFreed) /
          1_000_000,
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
      <header className="border-b border-[#2a2a2a] pb-3">
        <h3 className="text-[15px] font-black tracking-tight text-neutral-50">
          ストレージ管理
        </h3>
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
          このアプリは一時データを自動で整理します。作品データは絶対に消えません。
        </p>
      </header>

      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        {/* SET-03 (2026-07-25): サイドバーの容量表示と設定画面の容量表示が
            互いに素の集合を数えており、どちらも「何の合計か」が書いていなかった。
            数える対象は変えず、役割とラベルを分ける:
              ・ここ(作品データ) = 作業フォルダ配下の総量。サイドバーの数値と同じ集計
                (storage_usage_stats)。Finder で作業フォルダを見たサイズに対応する。
              ・下(一時データ)   = 掃除対象だけの内訳 (storage_cleanup_inspect)。
                作業フォルダの外にある Codex ログ・キャッシュなので上とは重複しない。
            2つを足しても「アプリが使う容量の全部」ではない (下のモデル欄が別枠)。 */}
        <h4 className="flex items-center gap-2 text-[13px] font-black text-emerald-300">
          <LockIcon />
          <span>あなたの作品データ</span>
        </h4>
        <p className="mt-1 text-[10px] text-emerald-200/50">
          自動削除されません / サイドバーの容量表示と同じ数値
        </p>
        <ul className="mt-2.5 space-y-1 border-t border-emerald-500/15 pt-2.5 text-[11px] text-neutral-300">
          <li className="flex items-center justify-between">
            <span>作業フォルダの合計</span>
            <span className="font-mono tabular-nums text-neutral-400">{formatBytes(workSize)}</span>
          </li>
          <li className="flex items-center justify-between text-[10px] text-neutral-500">
            <span>プリセット / スキル</span>
            <span>保護されています</span>
          </li>
        </ul>
        {workPath && (
          <p className="mt-2 truncate text-[10px] text-neutral-500">
            <span className="text-[10px] font-bold text-neutral-400">作業フォルダ </span>
            <span className="font-mono">{workPath}</span>
          </p>
        )}
        <button
          type="button"
          onClick={runRelink}
          disabled={relinking}
          className="mt-3 flex w-full flex-col items-center gap-0.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {/* 主文 + 補足の2段。長い1行だと視線の負荷が高いため分けた (2026-07-25) */}
          <span className="flex items-center gap-1.5 text-[12px] font-black text-emerald-100">
            <WrenchIcon />
            {relinking ? "修復中…" : "画像パスを修復する"}
          </span>
          {!relinking && (
            <span className="text-[10px] font-normal text-emerald-200/60">
              画像が見えない時はここを押す
            </span>
          )}
        </button>
        <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
          昔の作品が黒画像/「画像が見つかりません」になる場合に、記録と実体の
          ズレを直します。ファイルは移動・削除しません。
        </p>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        {/* 2026-07-25 文言修正: 実装は「24時間より古い対話履歴の画像部分を除去」+
            「ログ/キャッシュの削除」であり、対話履歴そのものは削除しない。
            以前の「3日以上前のものは自動削除」は実装と不一致だった。 */}
        <h4 className="flex items-center gap-2 text-[13px] font-black text-amber-300">
          <TrashIcon />
          <span>一時データ</span>
        </h4>
        <p className="mt-1 text-[10px] text-amber-200/50">
          24時間ごとに自動で軽くします / 作業フォルダの外にある掃除対象だけの合計
        </p>
        <ul className="mt-2.5 space-y-1 border-t border-amber-500/15 pt-2.5 text-[11px] text-neutral-300">
          <li className="flex items-center justify-between">
            <span>Codex 対話履歴</span>
            <span className="font-mono tabular-nums text-neutral-400">
              {formatBytes(inspection?.sessionsBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>Codex ログ</span>
            <span className="font-mono tabular-nums text-neutral-400">
              {formatBytes(inspection?.logsBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>古い生成画像キャッシュ</span>
            <span className="font-mono tabular-nums text-neutral-400">
              {formatBytes(inspection?.generatedBytes)}
            </span>
          </li>
          <li className="flex items-center justify-between">
            <span>WebView キャッシュ</span>
            <span className="font-mono tabular-nums text-neutral-400">
              {formatBytes(inspection?.cacheBytes)}
            </span>
          </li>
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-amber-500/20 pt-2">
          <span className="text-[11px] font-bold text-amber-200">一時データの合計</span>
          <span className="font-mono tabular-nums text-sm font-black text-amber-100">
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

      {/* F-4 (2026-07-25): 再ダウンロードできる資産 (AI モデル)。
          自動削除はしない。機能を使うと自動で再DLされるので、消しても作品は失われない。
          何が消えて何が再DLされるかを行ごとに書く。 */}
      {downloadedModels.length > 0 && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
          <h4 className="flex items-center gap-2 text-[13px] font-black text-sky-300">
            <TrashIcon />
            <span>再ダウンロードできる資産</span>
          </h4>
          <p className="mt-1 text-[10px] text-sky-200/50">
            自動削除されません / 消しても次に使うとき自動で入り直します
          </p>
          <ul className="mt-2.5 space-y-1.5 border-t border-sky-500/15 pt-2.5 text-[11px] text-neutral-300">
            {downloadedModels.map((model) => (
              <li key={model.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                <span className="shrink-0 font-mono tabular-nums text-[10px] text-neutral-500">
                  {formatBytes(model.sizeBytes)}
                </span>
                <button
                  type="button"
                  onClick={() => void deleteModel(model)}
                  disabled={deletingModelId !== null}
                  className="shrink-0 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-black text-sky-100 hover:border-sky-400 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {deletingModelId === model.id ? "削除中…" : "削除"}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-sky-500/20 pt-2">
            <span className="text-[11px] font-bold text-sky-200">削除できる合計 (目安)</span>
            <span className="font-mono tabular-nums text-sm font-black text-sky-100">
              {formatBytes(downloadedModelBytes)}
            </span>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
            消えるのは AI モデルのファイルだけです (背景除去・ことばで分離・人物パーツ認識など
            編集機能が使うもの)。作品・プリセット・スキル・設定は消えません。次にその機能を
            使ったときに自動でダウンロードし直すので、通信量だけがかかります。容量は
            ダウンロード時の想定サイズで、実ファイルとわずかにずれることがあります。
          </p>
        </div>
      )}

      {lastReport && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3 text-[11px] text-neutral-300">
          {/* 2026-07-25: sessionsDeleted / generatedImagesDeleted は Rust 側で
              代入される箇所が無く常に 0 だった (会話は削除しない設計なので当然)。
              常に「0 件削除」と出て壊れて見えるため、実際に効いている
              「画像部分の除去」と「キャッシュ削除」だけを表示する。 */}
          <p className="text-[12px] font-bold text-neutral-100">前回の整理結果</p>
          <div className="mt-2 space-y-1 border-t border-[#2a2a2a] pt-2 text-[11px] text-neutral-400">
            <p className="flex items-center justify-between gap-3">
              <span>対話履歴を軽量化</span>
              <span className="font-mono tabular-nums text-neutral-300">
                {lastReport.strippedFiles} 件 / {formatBytes(lastReport.strippedBytesFreed)}
              </span>
            </p>
            <p className="flex items-center justify-between gap-3">
              <span>キャッシュ・ログ削除</span>
              <span className="font-mono tabular-nums text-neutral-300">
                {formatBytes(lastReport.cacheBytesFreed)}
              </span>
            </p>
          </div>
          {lastReport.errors.length > 0 && (
            <p className="mt-2 text-[10px] text-red-300">
              エラー: {lastReport.errors.join(", ")}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2 rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-neutral-500">
        <InfoIcon />
        <p className="text-[10px] leading-relaxed">
          一時データを残しておくと PC の空き容量を圧迫します。24時間ごとに、裏側で
          古い対話履歴の画像部分とログ・キャッシュを自動で整理しています(会話の文章は
          消しません)。作品(画像/プリセット/スキル)には一切影響しません。
        </p>
      </div>
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
