/**
 * 画像→3Dシーン再構成ダイアログ (Slice D)。
 *
 * 3入口 (スケッチパッド / ギャラリー右クリック / scene3d ツールバー) が共通で開く。
 * 実処理は useSceneFromImage が持ち、ここは「入力の確認」「進行の可視化」
 * 「結果の正直な報告」だけを担当する。
 *
 * 進行表示は GenerationWorkspace.tsx:899-916 の useElapsedSeconds/formatElapsed と同型
 * (実進捗が取れない処理なので経過秒で「動いている」ことを見せる)。
 */

import { useEffect, useState } from "react";

import {
  useSceneFromImage,
  type SceneFromImagePhase,
} from "../../../lib/store/sceneFromImage";
import { SafeImage } from "../../SafeImage";

/** フェーズの表示名と補足。①は分単位でかかるので明示する。 */
const PHASE_STEPS: { id: SceneFromImagePhase; label: string; note?: string }[] = [
  { id: "blockout", label: "ブロックアウトに変換", note: "数分かかります" },
  { id: "pose", label: "ポーズを読み取り", note: "この端末内で処理します" },
  { id: "layout", label: "配置とカメラを解析" },
  { id: "apply", label: "3Dシーンに反映" },
];

/** 経過秒。active でない間は interval を張らない (GenerationWorkspace と同型)。 */
function useElapsedSeconds(active: boolean, startedAt?: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!active || !startedAt) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

export function SceneFromImageDialog({
  open,
  imagePath,
  /** スケッチ入口は正規化を省略できない (線画は解析が通らない)。true でトグルを隠す。 */
  forceBlockout = false,
  onClose,
}: {
  open: boolean;
  imagePath: string | null;
  forceBlockout?: boolean;
  onClose: () => void;
}) {
  const job = useSceneFromImage((s) => s.job);
  const result = useSceneFromImage((s) => s.result);
  const run = useSceneFromImage((s) => s.run);
  const clearResult = useSceneFromImage((s) => s.clearResult);

  const [skipBlockout, setSkipBlockout] = useState(false);
  const running = job !== null;
  const elapsed = useElapsedSeconds(running, job?.startedAt);

  // 開き直すたびに前回の結果表示を消す (前回の成功/失敗が新しい画像に見えないように)。
  useEffect(() => {
    if (open) {
      clearResult();
      if (forceBlockout) setSkipBlockout(false);
    }
  }, [open, forceBlockout, clearResult]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 実行中は Esc で閉じない (処理が続いていることを見失わせない)。
      if (e.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, running, onClose]);

  if (!open || !imagePath) return null;

  const effectiveSkip = forceBlockout ? false : skipBlockout;
  const activeIndex = job ? PHASE_STEPS.findIndex((p) => p.id === job.phase) : -1;

  const onRun = () => {
    void run(imagePath, { skipBlockout: effectiveSkip });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex max-h-[calc(100vh-80px)] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-[#242424] px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-neutral-100">画像から3Dシーンを起こす</h2>
            <p className="text-[11px] text-neutral-500">
              人物はマネキンに、物はプリミティブに置き換えて 3D シーンを組み立てます
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md border border-[#333] px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
          >
            閉じる
          </button>
        </header>

        <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-4">
          <div className="w-40 shrink-0">
            <SafeImage
              path={imagePath}
              alt="入力画像"
              className="w-full rounded-lg border border-[#2a2a2a] object-contain"
            />
            <p className="mt-1 truncate text-[10px] text-neutral-500" title={imagePath}>
              {imagePath.split(/[\\/]/).pop()}
            </p>
          </div>

          <div className="min-w-0 flex-1">
            {!running && !result?.ok && (
              <>
                {!forceBlockout && (
                  <label className="mb-3 flex items-start gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      checked={skipBlockout}
                      onChange={(e) => setSkipBlockout(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      ブロックアウト変換をスキップする
                      <span className="block text-[10px] text-neutral-500">
                        速く終わりますが、写真以外では配置の精度が落ちます
                      </span>
                    </span>
                  </label>
                )}
                {forceBlockout && (
                  <p className="mb-3 rounded-md border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[11px] text-neutral-400">
                    手描きの線画はそのままだと読み取れないため、必ずブロックアウトに変換してから解析します。
                  </p>
                )}
                {result?.error && (
                  <p className="mb-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-300">
                    {result.error}
                  </p>
                )}
              </>
            )}

            <ol className="flex flex-col gap-1.5">
              {PHASE_STEPS.map((step, i) => {
                // スキップ時はブロックアウト行を「省略」として残す (黙って消さない)。
                const skipped = step.id === "blockout" && effectiveSkip;
                const state =
                  activeIndex < 0
                    ? "idle"
                    : i < activeIndex
                      ? "done"
                      : i === activeIndex
                        ? "active"
                        : "idle";
                return (
                  <li
                    key={step.id}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${
                      state === "active"
                        ? "bg-[#1e1e1e] text-neutral-100"
                        : state === "done"
                          ? "text-neutral-400"
                          : "text-neutral-600"
                    }`}
                  >
                    <span className="w-4 text-center text-[11px]">
                      {skipped ? "–" : state === "done" ? "✓" : state === "active" ? "▶" : "○"}
                    </span>
                    <span className="flex-1">
                      {step.label}
                      {skipped && <span className="ml-1 text-[10px] text-neutral-600">(省略)</span>}
                      {step.note && state === "active" && (
                        <span className="ml-1 text-[10px] text-neutral-500">{step.note}</span>
                      )}
                    </span>
                    {state === "active" && elapsed != null && (
                      <span className="text-[10px] tabular-nums text-neutral-500">
                        {formatElapsed(elapsed)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>

            {result?.ok && (
              <div className="mt-3 rounded-md border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[11px] text-neutral-300">
                <p className="font-bold text-neutral-100">
                  3Dシーンに{result.applied?.mode === "replace" ? "反映" : "追加"}しました
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-neutral-400">
                  <li>物体 {result.applied?.objectCount ?? 0} 件を配置しました</li>
                  {result.applied?.personEntityId ? (
                    <li>
                      {result.poseSource === "tpose"
                        ? "ポーズは読み取れなかったので位置のみ反映しました (T字で配置)"
                        : result.poseSource === "blockout"
                          ? "ポーズはブロックアウト画像から読み取りました"
                          : "ポーズは元画像から読み取りました"}
                    </li>
                  ) : (
                    <li>人物は見つかりませんでした</li>
                  )}
                  {result.dropped ? <li>{result.dropped}件は読み取れませんでした</li> : null}
                  {result.demoted ? <li>{result.demoted}件は近似形状にしました</li> : null}
                  {result.blockoutFailed ? (
                    <li>ブロックアウト生成に失敗したため元画像から解析しました</li>
                  ) : null}
                </ul>
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[#242424] px-4 py-3">
          {result?.ok ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/20"
            >
              3Dビューを見る
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={running}
              className="rounded-md border border-neutral-200 bg-neutral-100 px-4 py-1.5 text-xs font-bold text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              {running ? "処理中…" : "3Dシーンにする"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
