import { convertFileSrc } from "@tauri-apps/api/core";

import type { EditLayer } from "../../lib/edit/types";
import { type SegmentationModel } from "../../lib/segmentation";
import { EditModelGate } from "../EditModelGate";
import { InpaintTool } from "./InpaintTool";
import { TextEditTab } from "./TextEditTab";

type LayerPanelProps = {
  sourceImagePath?: string | null;
  layers?: EditLayer[];
  selectedLayerId?: string | null;
  selectedModel?: SegmentationModel;
  loading?: boolean;
  onSelectedModelChange?: (model: SegmentationModel) => void;
  onRedecompose?: () => void;
  onSelectLayer?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
  foregroundPath?: string;
  backgroundPath?: string;
  maskPath?: string;
  projectName?: string | null;
  onSourceImageChange?: (path: string) => void;
};

export function LayerPanel({
  sourceImagePath = null,
  layers = [],
  selectedLayerId = null,
  selectedModel = "u2net",
  loading = false,
  onSelectedModelChange,
  onRedecompose,
  onSelectLayer,
  onToggleVisibility,
  foregroundPath,
  backgroundPath,
  maskPath,
  projectName,
  onSourceImageChange,
}: LayerPanelProps) {
  // 旧 UI で使っていた props は LayerPanel 上での選択 UI 削除に伴い未使用化したが、
  // 呼び出し側 (EditWorkspace) との型互換のため受け取りだけ残す。
  void selectedModel;
  void onSelectedModelChange;
  const directPreview = foregroundPath || backgroundPath || maskPath;
  const showEmptyState = !directPreview && (!sourceImagePath || layers.length === 0);

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col overflow-hidden border-l border-[#2a2a2a] bg-[#181818]">
      <div className="border-b border-[#242424] px-4 py-3">
        <h3 className="text-sm font-black text-white">レイヤー</h3>
      </div>

      {!directPreview && (
        <div className="border-b border-[#242424] px-4 py-3">
          {/*
            STΛCK 指示 (2026-05-14): モデル選択ドロップダウンは削除。
            BiRefNet 固定なので選択不要。
            EditModelGate がモデル未DL時のDL案内を担当する。
          */}
          <button
            type="button"
            onClick={onRedecompose}
            disabled={!sourceImagePath || loading || !onRedecompose}
            className="h-9 w-full rounded-lg bg-pink-500 px-3 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {loading ? "分解中..." : "切り抜き実行 (BiRefNet)"}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!directPreview && (
          <EditModelGate required={["segment", "ocr", "inpaint", "samClick"]}>
            <TextEditTab
              inputPath={sourceImagePath}
              projectName={projectName}
              onResult={onSourceImageChange}
            />
            <InpaintTool
              inputPath={sourceImagePath}
              projectName={projectName}
              onResult={onSourceImageChange}
            />
          </EditModelGate>
        )}

        {directPreview ? (
          <div className="space-y-3">
            <PreviewCard label="前景" path={foregroundPath} />
            <PreviewCard label="背景ソース" path={backgroundPath} />
            <PreviewCard label="マスク" path={maskPath} />
          </div>
        ) : showEmptyState ? (
          <div className="flex h-full min-h-48 items-center justify-center rounded-lg border border-dashed border-[#343434] bg-[#101010] px-4 text-center text-xs font-bold text-neutral-600">
            画像を選ぶとレイヤーが表示されます
          </div>
        ) : (
          <div className="space-y-2">
            {layers.map((layer) => (
              <LayerRow
                key={layer.id}
                layer={layer}
                active={layer.id === selectedLayerId}
                onSelect={() => onSelectLayer?.(layer.id)}
                onToggleVisibility={() => onToggleVisibility?.(layer.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function PreviewCard({ label, path }: { label: string; path?: string }) {
  return (
    <div className="rounded-lg border border-[#303030] bg-[#101010] p-2">
      <div className="mb-2 text-[11px] font-black text-neutral-300">{label}</div>
      {path ? (
        <img
          src={convertFileSrc(path)}
          alt={label}
          className="h-28 w-full rounded border border-[#343434] bg-[#0b0b0b] object-contain"
        />
      ) : (
        <div className="flex h-28 items-center justify-center rounded border border-dashed border-[#343434] text-xs font-bold text-neutral-600">
          未生成
        </div>
      )}
    </div>
  );
}

function LayerRow({
  layer,
  active,
  onSelect,
  onToggleVisibility,
}: {
  layer: EditLayer;
  active: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
}) {
  return (
    <div
      className={[
        "grid grid-cols-[48px_minmax(0,1fr)_56px] items-center gap-3 rounded-lg border p-2 transition",
        active
          ? "border-pink-400 bg-pink-500/10"
          : "border-[#303030] bg-[#101010]",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="h-12 w-12 overflow-hidden rounded border border-[#343434] bg-[#0b0b0b]"
      >
        <img
          src={convertFileSrc(layer.imagePath)}
          alt=""
          className="h-full w-full object-contain"
        />
      </button>

      <button type="button" onClick={onSelect} className="min-w-0 text-left">
        <div className="truncate text-sm font-black text-neutral-100">
          {layer.name}
        </div>
        <div className="mt-1 text-[10px] font-bold text-neutral-600">
          {active ? "選択中" : "クリックで選択"}
        </div>
      </button>

      <button
        type="button"
        onClick={onToggleVisibility}
        aria-pressed={layer.visible}
        className={[
          "h-8 rounded border px-2 text-[10px] font-black transition",
          layer.visible
            ? "border-[#4a4a4a] bg-[#181818] text-neutral-200 hover:border-pink-400"
            : "border-[#303030] bg-[#0b0b0b] text-neutral-600 hover:text-neutral-300",
        ].join(" ")}
      >
        {layer.visible ? "表示" : "非表示"}
      </button>
    </div>
  );
}
