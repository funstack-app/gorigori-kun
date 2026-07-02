import { useMemo, useState } from "react";

import { useEditor } from "./editor/editorStore";
import {
  getObjectById,
  layerMetasFromCanvas,
  removeObjectById,
  reorderObject,
  selectObjectById,
  setLocked,
  setObjectName,
  setObjectVisible,
} from "./editor/layerHelpers";

export function EditorLayerList() {
  const canvas = useEditor((state) => state.canvas);
  const selectedLayerId = useEditor((state) => state.selectedLayerId);
  const revision = useEditor((state) => state.revision);
  const setSelectedLayerId = useEditor((state) => state.setSelectedLayerId);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const layers = useMemo(() => layerMetasFromCanvas(canvas), [canvas, revision]);

  const select = (id: string) => {
    setSelectedLayerId(id);
    selectObjectById(canvas, id);
    bumpRevision();
  };

  const toggleVisible = (id: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setObjectVisible(object, object.visible === false);
    (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };

  const toggleLock = (id: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setLocked(object, object.get?.("locked") !== true);
    (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };

  const rename = (id: string, name: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setObjectName(object, name);
    bumpRevision();
    // 履歴はキーストロークごとではなく確定時 (onBlur) に積む (連打で埋めない)。
  };

  const remove = (id: string) => {
    removeObjectById(canvas, id);
    if (selectedLayerId === id) setSelectedLayerId(null);
    bumpRevision();
    pushHistory();
  };

  const dropOn = (targetIndex: number) => {
    if (!draggingId) return;
    reorderObject(canvas, draggingId, targetIndex);
    setDraggingId(null);
    bumpRevision();
    pushHistory();
  };

  return (
    <section className="min-h-0 flex-1 overflow-hidden border-b border-[#2a2a2a]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-2">
        <h3 className="text-xs font-black text-white">レイヤー</h3>
        <span className="rounded border border-[#343434] bg-[#101010] px-2 py-0.5 text-[10px] font-bold text-neutral-500">
          {layers.length}
        </span>
      </div>
      <div className="h-full overflow-y-auto p-2 pb-12">
        {layers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-8 text-center text-xs font-bold text-neutral-600">
            レイヤーなし
          </div>
        ) : (
          <div className="space-y-2">
            {layers.map((layer, index) => (
              <div
                key={layer.id}
                draggable
                onDragStart={() => setDraggingId(layer.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropOn(index)}
                onClick={() => select(layer.id)}
                className={`group grid cursor-pointer grid-cols-[26px_42px_minmax(0,1fr)_26px_26px] items-center gap-2 rounded-lg border bg-[#101010] p-2 transition ${
                  selectedLayerId === layer.id
                    ? "border-pink-500 shadow-[0_0_0_1px_rgba(236,72,153,.35)]"
                    : "border-[#303030] hover:border-pink-400/70"
                }`}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleVisible(layer.id);
                  }}
                  className="flex h-5 w-5 items-center justify-center text-neutral-400 hover:text-white"
                  title={layer.visible ? "非表示" : "表示"}
                >
                  {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-[#343434] bg-[#181818] text-neutral-500">
                  {layer.thumbnail ? (
                    <img src={layer.thumbnail} alt="" className="h-full w-full object-contain" />
                  ) : layer.kind === "text" ? (
                    <LayerTextIcon />
                  ) : (
                    <LayerImageIcon />
                  )}
                </div>
                <input
                  value={layer.name}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => rename(layer.id, event.target.value)}
                  onBlur={() => pushHistory()}
                  className="min-w-0 rounded border border-transparent bg-transparent px-1 py-1 text-xs font-bold text-neutral-100 outline-none focus:border-pink-400 focus:bg-[#181818]"
                />
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleLock(layer.id);
                  }}
                  className="flex h-5 w-5 items-center justify-center text-neutral-400 opacity-70 hover:text-white hover:opacity-100"
                  title={layer.locked ? "ロック解除" : "ロック"}
                >
                  {layer.locked ? <LockIcon /> : <LockOpenIcon />}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(layer.id);
                  }}
                  className="flex h-5 w-5 items-center justify-center text-neutral-400 opacity-60 hover:text-red-300 hover:opacity-100"
                  title="削除"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* --- フラットアイコン (絵文字廃止) --- */

const LAYER_SVG = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function EyeIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 004.2 4.2" />
      <path d="M9.3 5.3A9.5 9.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 3.9M6 6.6A17 17 0 002 12s3.5 7 10 7a9.3 9.3 0 003-.5" />
    </svg>
  );
}

function LayerTextIcon() {
  return (
    <svg {...LAYER_SVG} width={18} height={18} aria-hidden>
      <path d="M5 6h14M5 6V4.5h14V6M12 6v13M9 19h6" />
    </svg>
  );
}

function LayerImageIcon() {
  return (
    <svg {...LAYER_SVG} width={18} height={18} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="M3 16l5-4 4 3 3-2 6 5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...LAYER_SVG} width={14} height={14} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  );
}

function LockOpenIcon() {
  return (
    <svg {...LAYER_SVG} width={14} height={14} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 017.5-2" />
    </svg>
  );
}
