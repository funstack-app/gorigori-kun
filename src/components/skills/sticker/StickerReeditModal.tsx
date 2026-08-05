/**
 * 工程⑤ 個別マスク編集（設計書 v3 §1.5 / STΛCK決定5）。
 *
 * ## なぜ既存の MaskEditorModal を使わないか（実コード確認済み）
 *
 * - `MaskEditorModal.tsx:39-55` は確定時に `imagesIpc.writeMask` した後、
 *   **`useComposer` に参照とマスクを添付して閉じる**。出力先が「チャットのプロンプト入力欄」に
 *   ハードコードされている。
 * - `lib/store/maskEditor.ts` の store は `{ source, open, close }` だけで、
 *   **結果を受け取るコールバックが無い**。
 *
 * つまり「このスタンプ1枚を塗って、その場で再生成して差し替える」用途には
 * 結果の行き先が違う。**MaskEditorModal 自体は触らない**（既存のチャット経路を壊さないため）。
 * 描画部品 `MaskCanvas` だけを再利用し、モーダルはここに持つ。
 *
 * ## 合成は1行も自前で書かない
 *
 * マスクの二値化・寸法一致検証・量子化寸法の救済・**マスク外差分ゼロ検証**は
 * すべて `lib/imageReedit/maskReedit.ts`（漫画のコマ編集で検証済み）を呼ぶ。
 *
 * ## 二重起動防止
 *
 * `ComicWorkspace.tsx:786-788` と同じトークン方式。古い非同期runが新しい状態を
 * 上書きしないよう、採用の直前に毎回 `isCurrentPanelReeditRun` で自分の番か確かめる。
 */
import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { MaskCanvas, type MaskCanvasHandle, type MaskMode } from "../../MaskCanvas";
import { images as imagesIpc } from "../../../lib/ipc";
import { humanizeError } from "../../../lib/humanizeError";
import { useToasts } from "../../../lib/store/toasts";
import {
  buildBrushMaskArtifact,
  compositePanelImages,
  countMaskWhitePixels,
  isCurrentPanelReeditRun,
} from "../../../lib/imageReedit/maskReedit";
import {
  buildStickerReeditRequest,
  cutOutBeforeComposite,
  STICKER_REEDIT_SOURCE_PREFIX,
} from "../../../lib/sticker/reedit";
import type { CutoutOutcome } from "../../../lib/sticker/cutout";
import type { StickerPickItem } from "./StickerPickPanel";

type Props = {
  item: StickerPickItem;
  /** キャラの同一性を保つための参照画像（登録キャラの参照など）。無ければ空配列。 */
  referencePaths?: string[];
  /**
   * 採用成功。呼び出し側が差し替え後のパスを正本にする。
   *
   * `cutout` は**この差し替えで実際に抜いたときの結果**（R2 / I2）。呼び出し側が
   * 層Aの材料として登録する。旧実装はこれを渡しておらず、個別再生成の1枚だけが
   * 縁の検査と `chroma-not-cleared` の判定から外れていた。
   *
   * AI抜き経路では `cutout.chroma === null`。**そのときは層Aへ統計を渡さない**
   * （測っていない縁の品質を語らない）。
   */
  onAdopted: (index: number, newImagePath: string, cutout: CutoutOutcome) => void;
  onClose: () => void;
};

export function StickerReeditModal({
  item,
  referencePaths = [],
  onAdopted,
  onClose,
}: Props) {
  const pushToast = useToasts((s) => s.push);
  const canvasRef = useRef<MaskCanvasHandle | null>(null);
  const tokenRef = useRef(0);
  const [brushSize, setBrushSize] = useState(40);
  const [mode, setMode] = useState<MaskMode>("paint");
  const [opacity, setOpacity] = useState(0.5);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  // 塗り・undo・clear のたびに増やして、ツールバーの可否を再評価させる。
  const [version, setVersion] = useState(0);
  const bumpVersion = () => setVersion((value) => value + 1);
  const canUndo = version >= 0 && (canvasRef.current?.canUndo() ?? false);

  const run = async () => {
    const canvas = canvasRef.current;
    if (!canvas || busy) return;

    const runToken = tokenRef.current + 1;
    tokenRef.current = runToken;
    const stillMine = () => isCurrentPanelReeditRun(runToken, tokenRef.current);
    setBusy(true);

    try {
      // ブラシのマスクは「白 on 透明」。共有層が要求する白黒不透明へ二値化する
      // （縁のアンチエイリアスを内外どちらかへ確定させないと、マスク外差分ゼロ検証が成立しない）。
      const mask = await buildBrushMaskArtifact(await canvas.toBlob());
      if (countMaskWhitePixels(mask.raster) === 0) {
        pushToast({
          kind: "warn",
          text: "直したいところを塗ってから実行してください。",
          ttlMs: 4000,
        });
        return;
      }
      if (!stillMine()) return;

      const maskPath = await imagesIpc.writeMask(item.imagePath, mask.pngBytes);
      if (!stillMine()) return;

      const generated = await imagesIpc.generateBatch(
        buildStickerReeditRequest(
          instruction,
          item.imagePath,
          maskPath,
          referencePaths,
          `${STICKER_REEDIT_SOURCE_PREFIX}-${item.index}-${runToken}`,
        ),
      );
      if (!stillMine()) return;
      if (generated.cancelled) {
        pushToast({
          kind: "warn",
          text: "再生成は中止されました。元の絵は変えていません。",
          ttlMs: 4500,
        });
        return;
      }
      const generatedPath = generated.generatedPaths[0];
      if (!generatedPath || generated.failedCount > 0) {
        throw new Error(generated.errors[0] ?? "再生成した画像を取得できませんでした。");
      }

      // ⚠️ **合成の前に背景を抜く**（A1）。順序を入れ替えてはいけない。
      //
      // 生成プロンプトは緑背景を要求している（`reedit.ts` の CHROMA_BACKGROUND_CLAUSE）。
      // 合成はマスクの内側を生成物のまま採るので、抜かずに合成すると
      // **塗った範囲に緑が残ったまま採用される**。マスク外差分ゼロ検証は
      // 「マスクの外」しか守らないので、この緑を誰も検出できない。
      //
      // 抜きは本流と同じ `cutOutBeforeComposite`（既定=AI / 保険=クロマキー・I2）。
      // 戻りは**パスと抜きの結果の両方**（R2）。結果を捨てると、この1枚だけが層Aの
      // 縁の検査・「緑が抜けなかった」判定の材料を持たないまま採否リストへ載る。
      const cutout = await cutOutBeforeComposite(generatedPath);
      const cutPath = cutout.path;
      if (!stillMine()) return;

      // マスク外が1画素でも変わっていたらここで throw する（別人になった1枚を採用しない）。
      const composite = await compositePanelImages(item.imagePath, cutPath, mask.raster);
      if (!stillMine()) return;

      const compositePath = await imagesIpc.writeUpload(
        `sticker-reedit-${String(item.index).padStart(2, "0")}-${Date.now()}.png`,
        composite.bytes,
      );
      if (!stillMine()) return;

      // 抜きの結果は**合成後のパス**に紐づけて渡す（層Aが検査するのはこの1枚だから）。
      onAdopted(item.index, compositePath, cutout);
      pushToast({
        kind: "success",
        text: `${String(item.index).padStart(2, "0")} の塗ったところだけ差し替えました。`,
        ttlMs: 4000,
      });
      onClose();
    } catch (error) {
      if (stillMine()) {
        // 生エラーを直に連結しない（B4）。`humanizeError` が権限・不明ファイルの
        // 定型化と長文の切り詰めを持つので、そこを通してから文脈を足す。
        pushToast({
          kind: "error",
          text: `採用できませんでした。元の絵は変えていません。塗る範囲や指示を変えて、もう一度お試しください。（詳しい内容: ${humanizeError(error)}）`,
          ttlMs: 6500,
        });
      }
    } finally {
      if (stillMine()) setBusy(false);
    }
  };

  const cancel = () => {
    // 走行中の run を「自分の番ではない」状態にしてから閉じる。
    tokenRef.current += 1;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex h-full max-h-[46rem] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#242424] bg-[#121212]">
        <header className="flex items-center gap-3 border-b border-[#242424] px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
              {String(item.index).padStart(2, "0")} を直す
            </span>
            <span className="text-[11px] text-neutral-500">
              直したいところだけ塗ってください。塗っていないところは1画素も変わりません。
            </span>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="ml-auto rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e]"
          >
            閉じる
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-4 border-b border-[#242424] bg-[#101010] px-4 py-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setMode("paint")}
              className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                mode === "paint" ? "bg-[#2a2a2a] text-neutral-100" : "text-neutral-500 hover:bg-[#1a1a1a]"
              }`}
            >
              塗る
            </button>
            <button
              type="button"
              onClick={() => setMode("erase")}
              className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                mode === "erase" ? "bg-[#2a2a2a] text-neutral-100" : "text-neutral-500 hover:bg-[#1a1a1a]"
              }`}
            >
              消す
            </button>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-neutral-500">
            太さ
            <input
              type="range"
              min={4}
              max={160}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-28"
            />
            <span className="w-8 tabular-nums text-neutral-400">{brushSize}</span>
          </label>

          <label className="flex items-center gap-2 text-[11px] text-neutral-500">
            表示の濃さ
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="w-24"
            />
          </label>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                canvasRef.current?.undo();
                bumpVersion();
              }}
              disabled={busy || !canUndo}
              className="rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
            >
              1つ戻す
            </button>
            <button
              type="button"
              onClick={() => {
                canvasRef.current?.clear();
                bumpVersion();
              }}
              disabled={busy}
              className="rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
            >
              全部消す
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <MaskCanvas
            ref={canvasRef}
            src={convertFileSrc(item.imagePath)}
            brushSize={brushSize}
            mode={mode}
            opacity={opacity}
            onChange={bumpVersion}
          />
        </div>

        <footer className="flex items-center gap-3 border-t border-[#242424] px-4 py-3">
          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
            placeholder="どう直したいか（例: 指を5本にする / 口を閉じる）。空でも破綻の修正はします。"
            className="min-w-0 flex-1 rounded border border-[#2f2f2f] bg-[#0e0e0e] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-[#3f3f3f] focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="shrink-0 rounded bg-[#2a2a2a] px-4 py-2 text-[12px] font-bold text-neutral-100 transition hover:bg-[#333] disabled:opacity-40"
          >
            {busy ? "直しています…" : "この範囲を直す"}
          </button>
        </footer>
      </div>
    </div>
  );
}
