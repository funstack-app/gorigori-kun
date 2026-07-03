import { useState } from "react";

import { WORD_CHIPS } from "../../lib/edit/wordPresets";
import { EditModelGate } from "../EditModelGate";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";

/**
 * ことばで分離 (SAM3) の入力パネル。
 *
 * 左レールの「ことばで分離」ツールを選ぶと右パネルに現れる。日本語で入力すると
 * 内部辞書で英語プロンプトへ解決して SAM3 に投げる (wordPresets.ts)。
 * モデル未DLのときは EditModelGate が約880MBの追加ダウンロード UI を出す。
 */
export function WordsToolPanel() {
  const [input, setInput] = useState("");
  const busyTool = useEditor((state) => state.busyTool);
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const { runWords, runWordsAuto } = useEditorActions();
  const busy = busyTool === "words";

  const submit = () => {
    if (busy || input.trim().length === 0) return;
    void runWords(input);
  };

  const addChip = (ja: string) => {
    setInput((prev) => {
      const words = prev
        .split(/[,、\s]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);
      if (words.includes(ja)) return prev;
      return [...words, ja].join("、");
    });
  };

  return (
    <div className="shrink-0 border-b border-[#2a2a2a] bg-[#212121] p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-black text-white">ことばで分離</h3>

      </div>
      <EditModelGate required={["textSegment"]}>
        <p className="mb-2 text-[10px] leading-relaxed text-neutral-500">
          切り出したいものを「ことば」で指定します。カンマ区切りで複数OK
          (例: 人物、ボール)。
        </p>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="例: 人物、ボール、ロゴ"
            disabled={busy}
            className="min-w-0 flex-1 rounded-md border border-[#343434] bg-[#0b0b0b] px-2.5 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !sourceImagePath || input.trim().length === 0}
            className="shrink-0 rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy ? (
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-100 border-t-transparent align-middle" />
            ) : (
              "切り出す"
            )}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {WORD_CHIPS.map((chip) => (
            <button
              key={chip.ja}
              type="button"
              onClick={() => addChip(chip.ja)}
              disabled={busy}
              className="rounded-full border border-[#343434] bg-[#161616] px-2 py-0.5 text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white disabled:opacity-40"
            >
              {chip.ja}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void runWordsAuto()}
          disabled={busy || !sourceImagePath}
          className="mt-2 w-full rounded-md border border-pink-500/50 bg-pink-500/10 px-3 py-1.5 text-[11px] font-black text-pink-200 transition hover:bg-pink-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          title="AIが画像に写っているものを全部見つけて、まとめてレイヤーに切り出します"
        >
          {busy ? "処理中…" : "✦ AIにおまかせで全部切り出す"}
        </button>
        {!sourceImagePath ? (
          <p className="mt-2 text-[10px] text-neutral-600">
            先に画像をドロップ、または「画像を選ぶ」で開いてください。
          </p>
        ) : null}
      </EditModelGate>
    </div>
  );
}
