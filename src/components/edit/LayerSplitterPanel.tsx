import { useState } from "react";

import { layerSplitter } from "../../lib/ipc";
import { useEditor } from "./editor/editorStore";
import { EditErrorBox } from "./EditErrorBox";

type Preset = "portrait" | "illustration" | "general";

const PRESETS: { id: Preset; label: string; hint: string }[] = [
  { id: "general", label: "汎用", hint: "テキスト/人物/アイコン/写真/背景" },
  { id: "portrait", label: "人物", hint: "人物/髪/顔/目/口/服/装飾/背景" },
  { id: "illustration", label: "イラスト", hint: "キャラ/髪/顔/目/服/アイテム/効果/背景" },
];

/**
 * SAM3 レイヤースプリッター UI (昔の extensions/layer-splitter を編集タブに復活)。
 * テキストプロンプトを打ち込んで対象を分離する。これが旧レイヤースプリッターの核心UI。
 * バックエンドは layer_splitter_run (SAM3 CLI 経由)。現状 Mac 専用・テスト用途。
 *
 * エラー表示の設計 (2026-07-02 Photoshop 風再構成):
 * SAM3 CLI は失敗時に Python traceback を丸ごと返す。以前はこれを共有ストア
 * (useEditor.setError) に流していたため、キャンバス下部オーバーレイに traceback 全文が
 * 描画されてキャンバスが事故画面になっていた。エラーはこのパネル内のローカル state に
 * 閉じ込め、コンパクトな EditErrorBox (最大4行 + コピー) で表示する。共有ストアの
 * error は触らない (= キャンバスへ流入させない)。
 */
export function LayerSplitterPanel() {
  const sourceImagePath = useEditor((s) => s.sourceImagePath);
  const setMessage = useEditor((s) => s.setMessage);

  const [preset, setPreset] = useState<Preset>("general");
  // 自由入力プロンプト (カンマ/改行区切り)。空ならプリセットのプロンプトを使う。
  const [promptText, setPromptText] = useState("");
  const [running, setRunning] = useState(false);
  const [resultPath, setResultPath] = useState<string | null>(null);
  // エラーはこのパネル内に閉じ込める (共有ストア error を汚染しない)。
  const [error, setLocalError] = useState<string | null>(null);

  const run = async () => {
    if (!sourceImagePath) {
      setLocalError("先に画像を選んでください。");
      return;
    }
    const custom = promptText
      .split(/[,\n、]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    setRunning(true);
    setLocalError(null);
    setResultPath(null);
    setMessage(
      custom.length > 0
        ? `SAM3 で「${custom.join(" / ")}」を分離中…(初回はモデルDLで時間がかかります)`
        : `SAM3 で ${preset} プリセットを分離中…(初回はモデルDLで時間がかかります)`,
    );
    try {
      const out = await layerSplitter.run(
        sourceImagePath,
        preset,
        custom.length > 0 ? custom : undefined,
      );
      setResultPath(out);
      setMessage(`レイヤー分離が完了しました: ${out}`);
    } catch (caught) {
      // traceback 全文はローカル error にだけ入れる。message は短く戻す。
      setLocalError(caught instanceof Error ? caught.message : String(caught));
      setMessage(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-neutral-400">
          言葉で対象を指定して分離
        </span>
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
          Mac専用・テスト
        </span>
      </div>
      <p className="text-[10px] leading-4 text-neutral-500">
        例: 人物, 髪, 服。空欄ならプリセットを使用。
      </p>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => setPreset(p.id)}
            className={[
              "rounded-md border px-2 py-1 text-[10px] font-bold transition",
              preset === p.id
                ? "border-pink-500 bg-pink-500/15 text-pink-200"
                : "border-[#2a2a2a] bg-[#151515] text-neutral-400 hover:border-pink-400/50",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
      </div>

      <textarea
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        placeholder="分離したい対象を入力 (例: person, hair, clothing)。カンマ区切りで複数指定"
        rows={2}
        className="resize-none rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-pink-400 focus:outline-none"
      />

      <button
        type="button"
        onClick={() => void run()}
        disabled={running || !sourceImagePath}
        className="rounded-lg bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {running ? "分離中…" : "レイヤーに分離"}
      </button>

      <EditErrorBox message={error} />

      {resultPath && (
        <p className="truncate rounded bg-[#0d0d0d] px-2 py-1 text-[9px] text-emerald-400/80">
          出力: {resultPath}
        </p>
      )}
    </div>
  );
}

export default LayerSplitterPanel;
