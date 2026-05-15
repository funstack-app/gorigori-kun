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
  };

  const toggleLock = (id: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setLocked(object, object.get?.("locked") !== true);
    (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    bumpRevision();
  };

  const rename = (id: string, name: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setObjectName(object, name);
    bumpRevision();
  };

  const remove = (id: string) => {
    removeObjectById(canvas, id);
    if (selectedLayerId === id) setSelectedLayerId(null);
    bumpRevision();
  };

  const dropOn = (targetIndex: number) => {
    if (!draggingId) return;
    reorderObject(canvas, draggingId, targetIndex);
    setDraggingId(null);
    bumpRevision();
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
                  className="text-sm"
                  title={layer.visible ? "非表示" : "表示"}
                >
                  {layer.visible ? "👁" : "—"}
                </button>
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-[#343434] bg-[#181818] text-xs">
                  {layer.thumbnail ? <img src={layer.thumbnail} alt="" className="h-full w-full object-contain" /> : layer.kind === "text" ? "📝" : "🖼"}
                </div>
                <input
                  value={layer.name}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => rename(layer.id, event.target.value)}
                  className="min-w-0 rounded border border-transparent bg-transparent px-1 py-1 text-xs font-bold text-neutral-100 outline-none focus:border-pink-400 focus:bg-[#181818]"
                />
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleLock(layer.id);
                  }}
                  className="text-sm opacity-70 hover:opacity-100"
                  title={layer.locked ? "ロック解除" : "ロック"}
                >
                  {layer.locked ? "🔒" : "🔓"}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(layer.id);
                  }}
                  className="text-sm opacity-60 hover:opacity-100"
                  title="削除"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
