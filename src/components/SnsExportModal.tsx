import { useMemo, useState } from "react";

import { images as imagesIpc, type ResizeResult } from "../lib/ipc";
import { SNS_TARGETS, groupTargetsByCategory, type ResizeMode } from "../lib/snsTargets";
import { useToasts } from "../lib/store/toasts";

/**
 * SNS リサイズ書き出しモーダル (W2-2 / 監査B-1)。
 *
 * 対象画像のパスリストを受け取り、
 *   1. 書き出しサイズ (Instagram / ストーリー / X / YouTube / LP) をチェックで選択
 *   2. cover(中央クロップ) / contain(余白パディング) を一括切替
 *   3. 出力先フォルダをダイアログで選択
 *   4. Rust `images_export_resized` で一括書き出し
 *   5. 成功/失敗件数を結果表示
 * まで行う。呼び出し導線 (メニュー配線) は後続スライスが担当するため、
 * このコンポーネントは export するだけで App.tsx 等への組み込みはしない。
 */

export type SnsExportModalProps = {
  /** 書き出し対象画像の絶対パス一覧。空ならボタンを無効化する。 */
  paths: string[];
  /** モーダルを閉じる。書き出し実行中は呼ばない。 */
  onClose: () => void;
};

export function SnsExportModal({ paths, onClose }: SnsExportModalProps) {
  const pushToast = useToasts((s) => s.push);

  // 既定は SNS のみ ON。name をキーに ON/OFF を持つ。
  //
  // 2026-07-27: 以前は全ターゲット ON だった。広告バナー・ECモール規格を足して
  // 19件になったため、全 ON のままだと 1 枚書き出すつもりで 19 枚出てしまう。
  // 既定は従来と同じ SNS 5 種に絞り、他は必要なときに選ぶ形にする。
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SNS_TARGETS.map((t) => [t.name, (t.category ?? "sns") === "sns"])),
  );
  // リサイズ方式。"auto" は各プリセットの既定に従う (EC は余白付き、SNS は中央クロップ)。
  // cover / contain を選ぶと全プリセットへ一括で強制する。
  const [mode, setMode] = useState<ResizeMode | "auto">("auto");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResizeResult | null>(null);

  const selectedTargets = useMemo(
    () => SNS_TARGETS.filter((t) => selected[t.name]),
    [selected],
  );

  const selectedCount = selectedTargets.length;
  const canRun = paths.length > 0 && selectedCount > 0 && !running;

  const toggleTarget = (name: string) => {
    setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const handleRun = async () => {
    if (!canRun) return;
    setRunning(true);
    setResult(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "書き出し先フォルダを選択",
      });
      if (typeof dir !== "string") {
        // キャンセル: モーダルは開いたまま (再操作できるように)。
        return;
      }

      // 2026-07-27: mode="auto" を既定にした。以前は全プリセットへ単一 mode を
      // 強制していたため、EC モール規格 (商品を切ってはいけない=contain) を選んでも
      // 中央クロップで書き出され、商品の端が欠けたまま入稿される事故が起きうる。
      // auto では各プリセットの既定 (snsTargets.ts の mode) をそのまま使う。
      const targets = selectedTargets.map((t) => ({
        name: t.name,
        width: t.width,
        height: t.height,
        mode: mode === "auto" ? t.mode : mode,
      }));

      const res = await imagesIpc.exportResized(paths, targets, dir);
      setResult(res);

      const okCount = res.outputs.length;
      const ngCount = res.failed.length;
      if (okCount > 0) {
        pushToast({
          kind: ngCount > 0 ? "warn" : "success",
          text:
            ngCount > 0
              ? `${okCount} 件を書き出し (${ngCount} 件失敗)`
              : `${okCount} 件をリサイズ書き出ししました`,
          ttlMs: 4000,
        });
      } else {
        pushToast({
          kind: "error",
          text: "書き出せる画像がありませんでした",
          ttlMs: 6000,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `リサイズ書き出しに失敗しました: ${String(err)}`,
        ttlMs: 6000,
      });
    } finally {
      setRunning(false);
    }
  };

  const totalOutputs = paths.length * selectedCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!running) onClose();
      }}
    >
      <div
        className="flex max-h-[calc(100vh-80px)] min-h-0 w-[440px] flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 shrink-0 text-[14px] font-bold text-neutral-100">
          入稿サイズに書き出し
        </h3>
        <p className="mb-4 shrink-0 text-[11px] text-neutral-400">
          選択中の {paths.length} 枚を、SNS・広告バナー・ECモールの規格サイズにリサイズして書き出します。
        </p>

        {/* cover / contain 切替 */}
        <div className="mb-4 shrink-0">
          <span className="mb-1.5 block text-[11px] font-medium text-neutral-300">
            リサイズ方式
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("auto")}
              className={[
                "flex-1 rounded-md border px-3 py-2 text-left transition",
                mode === "auto"
                  ? "border-pink-400 bg-pink-500/10"
                  : "border-[#343434] bg-[#0b0b0b] hover:border-neutral-500",
              ].join(" ")}
            >
              <span className="block text-[12px] font-bold text-neutral-100">
                おまかせ
              </span>
              <span className="mt-0.5 block text-[10px] text-neutral-400">
                サイズごとに最適な方式（EC は余白付き）
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode("cover")}
              className={[
                "flex-1 rounded-md border px-3 py-2 text-left transition",
                mode === "cover"
                  ? "border-pink-400 bg-pink-500/10"
                  : "border-[#343434] bg-[#0b0b0b] hover:border-neutral-500",
              ].join(" ")}
            >
              <span className="block text-[12px] font-bold text-neutral-100">
                中央クロップ
              </span>
              <span className="mt-0.5 block text-[10px] text-neutral-400">
                枠いっぱいに埋める (端が切れる)
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode("contain")}
              className={[
                "flex-1 rounded-md border px-3 py-2 text-left transition",
                mode === "contain"
                  ? "border-pink-400 bg-pink-500/10"
                  : "border-[#343434] bg-[#0b0b0b] hover:border-neutral-500",
              ].join(" ")}
            >
              <span className="block text-[12px] font-bold text-neutral-100">
                余白パディング
              </span>
              <span className="mt-0.5 block text-[10px] text-neutral-400">
                全体を収める (余白は透過)
              </span>
            </button>
          </div>
        </div>

        {/* ターゲット選択 */}
        <div className="mb-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <span className="mb-1.5 block text-[11px] font-medium text-neutral-300">
            書き出しサイズ
          </span>
          {/* 2026-07-27: 広告バナー・ECモール規格を足して19件になったため、
              用途で区切って選べるようにする (ベタ並べだと目的のサイズを探せない)。 */}
          <div className="space-y-3">
            {groupTargetsByCategory().map((group) => (
              <div key={group.category}>
                <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-neutral-500">
                  {group.label}
                </div>
                <div className="space-y-1.5">
                  {group.targets.map((t) => {
                    const on = !!selected[t.name];
                    return (
                      <label
                        key={t.name}
                        title={t.note}
                        className={[
                          "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition",
                          on
                            ? "border-[#3a3a3a] bg-[#0f0f0f]"
                            : "border-[#242424] bg-[#0b0b0b] opacity-60",
                        ].join(" ")}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleTarget(t.name)}
                          className="h-3.5 w-3.5 accent-pink-500"
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
                          {t.label}
                        </span>
                        {/* 商品を切らない設定は入稿可否に直結するので明示する */}
                        {t.mode === "contain" ? (
                          <span className="shrink-0 rounded bg-[#1a1a1a] px-1.5 py-0.5 text-[9px] font-bold text-sky-300">
                            余白付き
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 出力見込み */}
        <div className="mb-4 shrink-0 rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2">
          <span className="text-[10px] text-neutral-500">書き出し予定</span>
          <p className="mt-0.5 text-[12px] text-neutral-200">
            {paths.length} 枚 × {selectedCount} サイズ ={" "}
            <span className="font-bold text-pink-300">{totalOutputs}</span> ファイル
          </p>
        </div>

        {/* 結果表示 */}
        {result && (
          <div className="mb-4 shrink-0 rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2">
            <p className="text-[12px] text-emerald-300">
              成功 {result.outputs.length} 件
              {result.failed.length > 0 && (
                <span className="ml-2 text-rose-300">
                  / 失敗 {result.failed.length} 件
                </span>
              )}
            </p>
            {result.failed.length > 0 && (
              <ul className="mt-1.5 max-h-24 space-y-0.5 overflow-y-auto">
                {result.failed.map((f, i) => (
                  <li
                    key={`${f.path}-${i}`}
                    className="truncate text-[10px] text-rose-400/80"
                    title={`${f.path}: ${f.error}`}
                  >
                    {f.path}: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* アクション */}
        <div className="flex shrink-0 justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="h-8 rounded-md border border-[#343434] bg-[#0b0b0b] px-3 text-[11px] font-bold text-neutral-300 hover:border-neutral-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {result ? "閉じる" : "キャンセル"}
          </button>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={!canRun}
            className="h-8 rounded-md bg-pink-600 px-4 text-[11px] font-bold text-white hover:bg-pink-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {running ? "書き出し中…" : "フォルダを選んで書き出し"}
          </button>
        </div>
      </div>
    </div>
  );
}
