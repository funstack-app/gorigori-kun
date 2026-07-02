import { useMemo, useState } from "react";

import { FontPicker } from "./FontPicker";
import { useEditor } from "./editor/editorStore";
import { getObjectById, objectKind } from "./editor/layerHelpers";

type FabricObject = any;

type FieldProps = {
  label: string;
  children: React.ReactNode;
};

export function EditorPropertyPanel() {
  const canvas = useEditor((state) => state.canvas);
  const selectedLayerId = useEditor((state) => state.selectedLayerId);
  const revision = useEditor((state) => state.revision);
  const object = useMemo(() => getObjectById(canvas, selectedLayerId), [canvas, selectedLayerId, revision]);

  if (!object) {
    return (
      <section className="min-h-0 flex-[2] overflow-y-auto p-3">
        <h3 className="text-xs font-black text-white">プロパティ</h3>
        <div className="mt-3 rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-10 text-center text-xs font-bold text-neutral-600">
          レイヤーを選択してください
        </div>
      </section>
    );
  }

  const kind = objectKind(object);
  return (
    <section className="min-h-0 flex-[2] overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-black text-white">プロパティ</h3>
        <span className="rounded border border-[#343434] bg-[#101010] px-2 py-0.5 text-[10px] font-bold text-neutral-400">
          {kind === "text" ? "テキスト" : "画像"}
        </span>
      </div>
      {kind === "text" ? <TextPropertyEditor object={object} /> : <ImagePropertyEditor object={object} />}
    </section>
  );
}

function TextPropertyEditor({ object }: { object: FabricObject }) {
  const apply = usePropertyApply(object);
  return (
    <div className="space-y-3">
      <Field label="文字">
        <textarea
          value={String(object.text ?? "")}
          onChange={(event) => apply({ text: event.target.value })}
          rows={4}
          className="w-full resize-none rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-pink-400"
        />
      </Field>
      <FontPicker value={String(object.fontFamily ?? "system-ui")} onChange={(fontFamily) => apply({ fontFamily })} />
      <NumberSlider label="サイズ" value={numberValue(object.fontSize, 32)} min={6} max={180} onChange={(fontSize) => apply({ fontSize })} />
      <Field label="色">
        <input
          type="color"
          value={colorValue(object.fill)}
          onChange={(event) => apply({ fill: event.target.value })}
          className="h-9 w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-2"
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Toggle label="B" active={object.fontWeight === "bold"} onClick={() => apply({ fontWeight: object.fontWeight === "bold" ? "normal" : "bold" })} />
        <Toggle label="I" active={object.fontStyle === "italic"} onClick={() => apply({ fontStyle: object.fontStyle === "italic" ? "normal" : "italic" })} />
        <Toggle label="U" active={object.underline === true} onClick={() => apply({ underline: object.underline !== true })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["left", "center", "right"] as const).map((align) => (
          <Toggle key={align} label={align === "left" ? "左" : align === "center" ? "中央" : "右"} active={object.textAlign === align} onClick={() => apply({ textAlign: align })} />
        ))}
      </div>
      <NumberSlider label="文字間隔" value={numberValue(object.charSpacing, 0)} min={-200} max={800} onChange={(charSpacing) => apply({ charSpacing })} />
      <NumberSlider label="行間" value={numberValue(object.lineHeight, 1.16)} min={0.6} max={3} step={0.05} onChange={(lineHeight) => apply({ lineHeight })} />
      <NumberSlider label="不透明度" value={numberValue(object.opacity, 1)} min={0} max={1} step={0.01} onChange={(opacity) => apply({ opacity })} />
      <NumberSlider label="回転" value={numberValue(object.angle, 0)} min={-180} max={180} onChange={(angle) => apply({ angle })} />
      <AdvancedGeometry object={object} apply={apply} />
    </div>
  );
}

function ImagePropertyEditor({ object }: { object: FabricObject }) {
  const apply = usePropertyApply(object);

  return (
    <div className="space-y-3">
      {/* まず「触ってすぐ効く」直感操作だけを見せる。生の座標・寸法は詳細に畳む。 */}
      <NumberSlider label="不透明度" value={numberValue(object.opacity, 1)} min={0} max={1} step={0.01} onChange={(opacity) => apply({ opacity })} />
      <div className="grid grid-cols-2 gap-2">
        <Toggle label="水平反転" active={object.flipX === true} onClick={() => apply({ flipX: object.flipX !== true })} />
        <Toggle label="垂直反転" active={object.flipY === true} onClick={() => apply({ flipY: object.flipY !== true })} />
      </div>
      <NumberSlider label="明度" value={numberValue(object.get?.("brightness"), 0)} min={-1} max={1} step={0.05} onChange={(brightness) => void applyImageFilters(object, { brightness })} />
      <NumberSlider label="コントラスト" value={numberValue(object.get?.("contrast"), 0)} min={-1} max={1} step={0.05} onChange={(contrast) => void applyImageFilters(object, { contrast })} />
      <NumberSlider label="回転" value={numberValue(object.angle, 0)} min={-180} max={180} onChange={(angle) => apply({ angle })} />
      <AdvancedGeometry object={object} apply={apply} withSize />
    </div>
  );
}

/**
 * 生の位置 (X/Y) と寸法 (幅/高さ) の数値入力。非エンジニアには最初は見せない。
 * 「詳細」を開いたときだけ表示する。開かなくてもドラッグ・ハンドルで直感操作できる前提。
 */
function AdvancedGeometry({
  object,
  apply,
  withSize = false,
}: {
  object: FabricObject;
  apply: (values: Record<string, unknown>) => void;
  withSize?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const width = Math.round((object.width ?? 0) * (object.scaleX ?? 1));
  const height = Math.round((object.height ?? 0) * (object.scaleY ?? 1));
  const setWidth = (nextWidth: number) => {
    if (!object.width) return;
    apply({ scaleX: nextWidth / object.width });
  };
  const setHeight = (nextHeight: number) => {
    if (!object.height) return;
    apply({ scaleY: nextHeight / object.height });
  };
  return (
    <div className="border-t border-[#242424] pt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 text-[10px] font-bold text-neutral-500 hover:text-neutral-300"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        詳細 (位置・大きさの数値)
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="X" value={Math.round(numberValue(object.left, 0))} onChange={(left) => apply({ left })} />
            <NumberInput label="Y" value={Math.round(numberValue(object.top, 0))} onChange={(top) => apply({ top })} />
          </div>
          {withSize && (
            <div className="grid grid-cols-2 gap-2">
              <NumberInput label="幅" value={width} onChange={setWidth} />
              <NumberInput label="高さ" value={height} onChange={setHeight} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function usePropertyApply(object: FabricObject) {
  const canvas = useEditor((state) => state.canvas) as { requestRenderAll?: () => void } | null;
  const bumpRevision = useEditor((state) => state.bumpRevision);
  return (values: Record<string, unknown>) => {
    object.set?.(values);
    object.setCoords?.();
    canvas?.requestRenderAll?.();
    bumpRevision();
  };
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-black text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-pink-400"
      />
    </Field>
  );
}

function NumberSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={`${label}: ${formatNumber(value)}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_74px] gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : min}
          onChange={(event) => onChange(Number(event.target.value))}
          className="accent-pink-500"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : min}
          onChange={(event) => onChange(Number(event.target.value))}
          className="rounded-lg border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-xs text-neutral-100 outline-none focus:border-pink-400"
        />
      </div>
    </Field>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2 py-2 text-xs font-black ${
        active ? "border-pink-500 bg-pink-500/20 text-pink-100" : "border-[#343434] bg-[#101010] text-neutral-300 hover:border-pink-400"
      }`}
    >
      {label}
    </button>
  );
}

async function applyImageFilters(object: FabricObject, next: { brightness?: number; contrast?: number }) {
  const currentBrightness = next.brightness ?? numberValue(object.get?.("brightness"), 0);
  const currentContrast = next.contrast ?? numberValue(object.get?.("contrast"), 0);
  object.set?.({ brightness: currentBrightness, contrast: currentContrast });
  try {
    // @ts-ignore fabric is installed at runtime via package dependency
    const fabric = await import("fabric") as any;
    const filters = fabric.filters ?? {};
    const nextFilters = [];
    if (filters.Brightness && currentBrightness !== 0) nextFilters.push(new filters.Brightness({ brightness: currentBrightness }));
    if (filters.Contrast && currentContrast !== 0) nextFilters.push(new filters.Contrast({ contrast: currentContrast }));
    object.filters = nextFilters;
    object.applyFilters?.();
  } finally {
    useEditor.getState().bumpRevision();
    (useEditor.getState().canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
  }
}

function numberValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function colorValue(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
