import type { ChangeEvent, DragEvent } from "react";
import type { ReferenceSlotId } from "../../lib/scene/types";
import { useSceneStore } from "../../lib/store/scene";

export function ReferenceSection() {
  const slots = useSceneStore((state) => state.reference.slots);
  const setReferenceSlot = useSceneStore((state) => state.setReferenceSlot);
  const clearReferenceSlot = useSceneStore((state) => state.clearReferenceSlot);

  const onDrop = (event: DragEvent<HTMLDivElement>, id: ReferenceSlotId) => {
    event.preventDefault();
    const file = event.dataTransfer.files.item(0);
    setReferenceSlot(id, {
      enabled: true,
      label: file?.name ?? id,
    });
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const onNoteChange = (event: ChangeEvent<HTMLInputElement>, id: ReferenceSlotId) => {
    setReferenceSlot(id, {
      note: event.target.value,
      enabled: true,
    });
  };

  return (
    <div className="space-y-2">
      {slots.map((slot) => (
        <div
          key={slot.id}
          onDrop={(event) => onDrop(event, slot.id)}
          onDragOver={onDragOver}
          className={`rounded-md border border-dashed p-2.5 transition ${
            slot.enabled
              ? "border-pink-400 bg-pink-500/10"
              : "border-[#343434] bg-[#101010] hover:border-pink-400 hover:bg-[#1f1f1f]"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-neutral-100">{slot.id}</p>
              <p className="truncate text-[10px] text-neutral-500">
                {slot.label || "画像をドロップ / 追加"}
              </p>
            </div>
            {slot.enabled ? (
              <button
                type="button"
                onClick={() => clearReferenceSlot(slot.id)}
                className="rounded border border-[#343434] bg-[#181818] px-2 py-0.5 text-[10px] font-semibold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                外す
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setReferenceSlot(slot.id, { enabled: true, label: slot.id })}
                className="rounded border border-pink-500 bg-pink-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-pink-400"
              >
                追加
              </button>
            )}
          </div>
          {slot.enabled && (
            <input
              value={slot.note}
              onChange={(event) => onNoteChange(event, slot.id)}
              placeholder="例: 顔 / 服装 / 小物 / 背景"
              className="mt-2 w-full rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[11px] text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
            />
          )}
        </div>
      ))}
    </div>
  );
}
