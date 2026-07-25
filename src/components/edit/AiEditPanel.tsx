import { useState } from "react";

import { images as imagesIpc } from "../../lib/ipc";
import { useBatches } from "../../lib/store/batches";
import { beginDirectRun } from "../../lib/store/generationStatus";
import { useThreads } from "../../lib/store/threads";
import { useEditor } from "./editor/editorStore";

/**
 * 編集タブの主導線: 「ことばで直す」AI編集パネル (STΛCK 指示 2026-07-25)。
 *
 * なぜこれが主役になったか:
 *   従来の主導線は「レイヤーに分解する」だった。画像を開くと自動で分解が走り、
 *   分解を経ないと何もできなかった。だが STΛCK の使い方は「この画像のここを
 *   こう変えたい」であって、分解はその手段の1つにすぎない。しかも分解は
 *   ローカル AI (ort/ONNX) に依存し、モデル DL が必要で、Intel Mac では
 *   そもそも動かない (v2.0.0 で Intel 版の配布を停止した原因)。
 *   → 分解を必須の入口から外し、「ことばで指示する」を既定の入口にする。
 *
 * この経路の依存: images_generate_batch (通常の画像生成と同じ) だけ。
 *   ローカル AI モデルの DL 不要 / ort 不要 / 全 OS で同じに動く。
 *   マスクは任意で、無指定なら画像全体が対象になる (maskPaths を渡さない)。
 *
 * レイヤーとの関係:
 *   「レイヤーを選ばないと実行できない」という従来の制約は外した
 *   (旧 AICommandBar は canRun に selectedLayerName を要求していたため、
 *    レイヤー分解を経ないと押せず、結果どの画面にも配置されないまま放置されていた)。
 *
 * 適用範囲は現状「画像全体」のみ。レイヤー範囲だけを直す部分適用は、
 * fabric オブジェクト座標 → 元画像実寸座標の変換とマスク PNG 生成が必要で、
 * 道具は既にある (useEditor.ts の buildFullSizeMaskFromNormalizedBbox が
 * 赤入れ機能で同じことをしている) が EditorLayerMeta が bbox を持たないため
 * 別途の実装になる。**選べない機能を選択肢として並べない**方針で、
 * 実装するまで範囲切替の UI は出さない (押せるのに効かないのが最悪)。
 */
export function AiEditPanel() {
  const sourceImagePath = useEditor((s) => s.sourceImagePath);
  const busyTool = useEditor((s) => s.busyTool);

  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canRun = Boolean(sourceImagePath && instruction.trim()) && !busy && busyTool === null;

  const run = async () => {
    const prompt = instruction.trim();
    if (!sourceImagePath || !prompt || busy) return;

    const threads = useThreads.getState();
    const tempId = `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setBusy(true);
    setError(null);

    // 右上の生成状況パネルに出す (フリーズに見えないようにする。2026-07-25)。
    const track = beginDirectRun("aiEdit", 1, tempId);
    track.markStarted();
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt,
      references: [{ path: sourceImagePath, name: basename(sourceImagePath) }],
      count: 1,
    });

    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: 1,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
      });
      if (result.failedCount > 0) {
        // 失敗理由を握りつぶさない。errors[0] があればそのまま出す
        // (「失敗しました」だけだと原因が分からず問い合わせになる)。
        const detail = result.errors?.[0];
        setError(detail ? `編集に失敗しました: ${detail}` : "編集に失敗しました。");
        track.fail(detail ?? "編集に失敗しました");
      } else {
        track.markCompleted();
      }
    } catch (err) {
      useBatches.getState().removeBatch(tempId);
      setError(`編集に失敗しました: ${String(err)}`);
      track.fail(String(err));
    } finally {
      // 成否にかかわらず状況パネルを閉じる (開いたままだと「まだ動いている」
      // ように見えてフリーズと区別できない)。
      track.done();
      setBusy(false);
    }
  };

  if (!sourceImagePath) return null;

  return (
    <div className="shrink-0 border-b border-[#2a2a2a] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-pink-300">
          <WandIcon />
        </span>
        <h3 className="text-xs font-black text-white">ことばで直す</h3>
      </div>

      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={3}
        placeholder="例: 背景を夕暮れの海辺にする / 服の色を白に変える"
        className="w-full resize-none rounded-lg border border-[#343434] bg-[#101010] px-2.5 py-2 text-xs leading-5 text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
      />

      <button
        type="button"
        onClick={() => void run()}
        disabled={!canRun}
        className="mt-2 h-9 w-full rounded-lg bg-pink-500 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {busy ? "AIが直しています…" : "AIで直す"}
      </button>

      <p className="mt-1.5 text-[10px] font-bold leading-4 text-neutral-500">
        画像全体に対して実行します。結果は制作タブに届きます。
      </p>

      {error ? (
        <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-bold leading-4 text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/** ことばで直す (魔法の杖)。絵文字は使わない方針 (STΛCK 2026-07-25)。 */
function WandIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 4V2M15 10V8M11.5 6h-2M20.5 6h-2" />
      <path d="M4 20l9-9" />
      <path d="M13.5 7.5l3 3" />
    </svg>
  );
}

export default AiEditPanel;
