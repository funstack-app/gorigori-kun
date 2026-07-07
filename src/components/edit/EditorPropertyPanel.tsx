import { useMemo, useState } from "react";

import { FontPicker } from "./FontPicker";
import { guessSerif, type FontMatchHint } from "../../lib/edit/fontMatch";
import { backgroundActions, isBackgroundLayer } from "../../lib/edit/backgroundEdit";
import { useEditor } from "./editor/editorStore";
import { getObjectById, objectKind } from "./editor/layerHelpers";
import { convertTextImageToTextbox, getCanvasBaseSize } from "./editor/magicLayerToFabric";
import { useEditorActions } from "./editor/useEditor";

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

/** テキスト内容から言語を推定する（日本語文字を含めば ja、なければ en）。決定論。 */
function guessLanguage(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  // ひらがな・カタカナ・CJK統合漢字のいずれかを含めば日本語とみなす
  return /[぀-ヿ㐀-鿿]/.test(text) ? "ja" : "en";
}

function TextPropertyEditor({ object }: { object: FabricObject }) {
  const apply = usePropertyApply(object);
  const matchHint: FontMatchHint = {
    language: guessLanguage(object.text) ?? object.languageHint ?? null,
    bold: object.fontWeight === "bold",
    serif: object.fontFamily
      ? guessSerif({ family: String(object.fontFamily), displayName: String(object.fontFamily) })
      : null,
  };
  return (
    <div className="space-y-3">
      <Field label="文字">
        <textarea
          value={String(object.text ?? "")}
          onChange={(event) => apply({ text: event.target.value })}
          onBlur={apply.commit}
          rows={4}
          className="w-full resize-none rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-pink-400"
        />
      </Field>
      <FontPicker value={String(object.fontFamily ?? "system-ui")} matchHint={matchHint} languageHint={matchHint.language} onChange={(fontFamily) => { apply({ fontFamily }); apply.commit(); }} />
      <NumberSlider label="サイズ" value={numberValue(object.fontSize, 32)} min={6} max={180} onChange={(fontSize) => apply({ fontSize })} onCommit={apply.commit} />
      <Field label="色">
        <input
          type="color"
          value={colorValue(object.fill)}
          onChange={(event) => apply({ fill: event.target.value })}
          onBlur={apply.commit}
          className="h-9 w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-2"
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Toggle label="B" active={object.fontWeight === "bold"} onClick={() => { apply({ fontWeight: object.fontWeight === "bold" ? "normal" : "bold" }); apply.commit(); }} />
        <Toggle label="I" active={object.fontStyle === "italic"} onClick={() => { apply({ fontStyle: object.fontStyle === "italic" ? "normal" : "italic" }); apply.commit(); }} />
        <Toggle label="U" active={object.underline === true} onClick={() => { apply({ underline: object.underline !== true }); apply.commit(); }} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["left", "center", "right"] as const).map((align) => (
          <Toggle key={align} label={align === "left" ? "左" : align === "center" ? "中央" : "右"} active={object.textAlign === align} onClick={() => { apply({ textAlign: align }); apply.commit(); }} />
        ))}
      </div>
      <NumberSlider label="文字間隔" value={numberValue(object.charSpacing, 0)} min={-200} max={800} onChange={(charSpacing) => apply({ charSpacing })} onCommit={apply.commit} />
      <NumberSlider label="行間" value={numberValue(object.lineHeight, 1.16)} min={0.6} max={3} step={0.05} onChange={(lineHeight) => apply({ lineHeight })} onCommit={apply.commit} />
      <div className="grid grid-cols-2 gap-2">
        <ColorField label="縁取りの色" value={colorToHex(object.stroke, "#000000")} onChange={(stroke) => { apply({ stroke, paintFirst: "stroke" }); apply.commit(); }} />
        <div />
      </div>
      <NumberSlider label="縁取りの太さ" value={numberValue(object.strokeWidth, 0)} min={0} max={20} onChange={(strokeWidth) => apply({ strokeWidth, paintFirst: "stroke" })} onCommit={apply.commit} />
      <ShadowControls object={object} apply={apply} />
      <AlignOrderSection object={object} />
      <NumberSlider label="不透明度" value={numberValue(object.opacity, 1)} min={0} max={1} step={0.01} onChange={(opacity) => apply({ opacity })} onCommit={apply.commit} />
      <NumberSlider label="回転" value={numberValue(object.angle, 0)} min={-180} max={180} onChange={(angle) => apply({ angle })} onCommit={apply.commit} />
      <AdvancedGeometry object={object} apply={apply} />
    </div>
  );
}

function ImagePropertyEditor({ object }: { object: FabricObject }) {
  const apply = usePropertyApply(object);
  const canvas = useEditor((state) => state.canvas);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  // 「元画素そのまま」のテキストレイヤーは、打ち替えたいときだけ textbox へ変換できる。
  const hasTextSpec = Boolean(object.get?.("textSpec"));

  const isBackground = isBackgroundLayer(object);
  const bgActions = isBackground ? backgroundActions(object) : [];
  const canAiRegenerate = bgActions.some((a) => a.kind === "ai-regenerate");

  return (
    <div className="space-y-3">
      {isBackground ? (
        <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-2 py-2">
          <span className="block text-[10px] font-bold text-sky-200">背景の編集</span>
          <NumberSlider label="ぼかし" value={numberValue(object.get?.("blur"), 0)} min={0} max={1} step={0.02} onChange={(blur) => void applyImageFilters(object, { blur })} onCommit={() => void applyImageFilters(object, {}, apply.commit)} />
          <NumberSlider label="明るさ" value={numberValue(object.get?.("brightness"), 0)} min={-1} max={1} step={0.05} onChange={(brightness) => void applyImageFilters(object, { brightness })} onCommit={() => void applyImageFilters(object, {}, apply.commit)} />
          {canAiRegenerate ? (
            <p className="text-[10px] leading-relaxed text-neutral-400">
              背景を作り直したいときは、下の「同じ雰囲気でAI差し替え」から再生成できます。
            </p>
          ) : (
            <p className="text-[10px] leading-relaxed text-neutral-500">
              この背景は元画像を持たないため、AI再生成は使えません（ぼかし・明るさで調整してください）。
            </p>
          )}
        </div>
      ) : null}
      {hasTextSpec ? (
        <button
          type="button"
          onClick={() => {
            if (!canvas) return;
            void convertTextImageToTextbox(canvas, object).then((converted) => {
              if (converted) {
                bumpRevision();
                pushHistory();
              }
            });
          }}
          className="w-full rounded-md border border-pink-500/50 bg-pink-500/10 px-3 py-2 text-[11px] font-black text-pink-200 transition hover:bg-pink-500/20"
          title="見た目は元画像のまま。文字を打ち替えたいときだけ編集可能なテキストに変換します"
        >
          テキストとして編集 (打ち替え可能に変換)
        </button>
      ) : null}
      {object.get?.("sourcePath") ? <RestyleSection /> : null}
      {/* 図形 (rect/circle/line/path) は塗り・線の色をここで変えられる。 */}
      {isShapeObject(object) ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <ColorField label="塗り" value={colorToHex(object.fill, "#ff4d8d")} onChange={(fill) => { apply({ fill }); apply.commit(); }} />
            <ColorField label="線色" value={colorToHex(object.stroke, "#ff4d8d")} onChange={(stroke) => { apply({ stroke }); apply.commit(); }} />
          </div>
          <NumberSlider label="線の太さ" value={numberValue(object.strokeWidth, 0)} min={0} max={30} onChange={(strokeWidth) => apply({ strokeWidth })} onCommit={apply.commit} />
        </div>
      ) : null}
      {/* まず「触ってすぐ効く」直感操作だけを見せる。生の座標・寸法は詳細に畳む。 */}
      <NumberSlider label="不透明度" value={numberValue(object.opacity, 1)} min={0} max={1} step={0.01} onChange={(opacity) => apply({ opacity })} onCommit={apply.commit} />
      <div className="grid grid-cols-2 gap-2">
        <Toggle label="水平反転" active={object.flipX === true} onClick={() => { apply({ flipX: object.flipX !== true }); apply.commit(); }} />
        <Toggle label="垂直反転" active={object.flipY === true} onClick={() => { apply({ flipY: object.flipY !== true }); apply.commit(); }} />
      </div>
      {/*
        明度/コントラストは filters を非同期で貼るため、スライダー確定時に「フィルタ適用が
        済んでから」履歴を積む必要がある (onPointerUp 直後だと filters がまだ空の可能性)。
        applyImageFilters に commit を渡し、適用完了後に snapshot させる。
      */}
      <NumberSlider label="明度" value={numberValue(object.get?.("brightness"), 0)} min={-1} max={1} step={0.05} onChange={(brightness) => void applyImageFilters(object, { brightness })} onCommit={() => void applyImageFilters(object, {}, apply.commit)} />
      <NumberSlider label="コントラスト" value={numberValue(object.get?.("contrast"), 0)} min={-1} max={1} step={0.05} onChange={(contrast) => void applyImageFilters(object, { contrast })} onCommit={() => void applyImageFilters(object, {}, apply.commit)} />
      <NumberSlider label="回転" value={numberValue(object.angle, 0)} min={-180} max={180} onChange={(angle) => apply({ angle })} onCommit={apply.commit} />
      <AlignOrderSection object={object} />
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
  apply: ApplyFn;
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
            <NumberInput label="X" value={Math.round(numberValue(object.left, 0))} onChange={(left) => apply({ left })} onCommit={apply.commit} />
            <NumberInput label="Y" value={Math.round(numberValue(object.top, 0))} onChange={(top) => apply({ top })} onCommit={apply.commit} />
          </div>
          {withSize && (
            <div className="grid grid-cols-2 gap-2">
              <NumberInput label="幅" value={width} onChange={setWidth} onCommit={apply.commit} />
              <NumberInput label="高さ" value={height} onChange={setHeight} onCommit={apply.commit} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * プロパティ適用関数。呼ぶたびに object へ set + 再描画するが、履歴はここでは積まない。
 * スライダー/数値入力を動かすたびに積むと 1 操作で履歴が数十件になるため、履歴は
 * 確定時 (スライダーの pointerup / 入力の blur / トグル押下) に commit() で積む。
 * apply には commit を生やして返す。
 */
function usePropertyApply(object: FabricObject) {
  const canvas = useEditor((state) => state.canvas) as { requestRenderAll?: () => void } | null;
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  const apply = (values: Record<string, unknown>) => {
    object.set?.(values);
    object.setCoords?.();
    canvas?.requestRenderAll?.();
    bumpRevision();
  };
  // 確定時に呼ぶ: 現在のキャンバス状態を 1 手として履歴に積む。
  (apply as ApplyFn).commit = () => pushHistory();
  return apply as ApplyFn;
}

type ApplyFn = ((values: Record<string, unknown>) => void) & { commit: () => void };

function Field({ label, children }: FieldProps) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-black text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
        onBlur={onCommit}
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
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
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
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          className="accent-pink-500"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : min}
          onChange={(event) => onChange(Number(event.target.value))}
          onBlur={onCommit}
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

async function applyImageFilters(
  object: FabricObject,
  next: { brightness?: number; contrast?: number; blur?: number },
  onCommit?: () => void,
) {
  const currentBrightness = next.brightness ?? numberValue(object.get?.("brightness"), 0);
  const currentContrast = next.contrast ?? numberValue(object.get?.("contrast"), 0);
  const currentBlur = next.blur ?? numberValue(object.get?.("blur"), 0);
  object.set?.({ brightness: currentBrightness, contrast: currentContrast, blur: currentBlur });
  try {
    // @ts-ignore fabric is installed at runtime via package dependency
    const fabric = await import("fabric") as any;
    const filters = fabric.filters ?? {};
    const nextFilters = [];
    if (filters.Brightness && currentBrightness !== 0) nextFilters.push(new filters.Brightness({ brightness: currentBrightness }));
    if (filters.Contrast && currentContrast !== 0) nextFilters.push(new filters.Contrast({ contrast: currentContrast }));
    if (filters.Blur && currentBlur !== 0) nextFilters.push(new filters.Blur({ blur: currentBlur }));
    object.filters = nextFilters;
    object.applyFilters?.();
  } finally {
    useEditor.getState().bumpRevision();
    (useEditor.getState().canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    // filters を貼り終えてから履歴を積む (呼ばれたときのみ = スライダー確定時)。
    onCommit?.();
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

/** 図形 (fabric の基本シェイプ) かどうか。画像レイヤーとは色プロパティの出し分けに使う。 */
function isShapeObject(object: FabricObject): boolean {
  return ["rect", "circle", "triangle", "line", "polyline", "polygon", "path"].includes(
    String(object.type ?? "").toLowerCase(),
  );
}

/** fabric の色値を color input 用の #rrggbb に寄せる (それ以外はフォールバック)。 */
function colorToHex(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (typeof value === "string" && /^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return fallback;
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full cursor-pointer rounded-lg border border-[#343434] bg-[#0b0b0b]"
      />
    </Field>
  );
}

/**
 * テキストの影。fabric は Shadow インスタンスを要求するため、変更時に fabric を
 * 動的 import して組み立てる (ぼかし 0 で影なし)。
 */
function ShadowControls({ object, apply }: { object: FabricObject; apply: ApplyFn }) {
  const shadow = (object.shadow ?? null) as
    | { color?: string; blur?: number; offsetX?: number; offsetY?: number }
    | null;
  const setShadow = async (partial: { color?: string; blur?: number; offset?: number }) => {
    const nextBlur = partial.blur ?? shadow?.blur ?? 0;
    const nextColor = partial.color ?? shadow?.color ?? "#000000";
    const nextOffset = partial.offset ?? Math.round(shadow?.offsetX ?? 4);
    if (nextBlur <= 0 && nextOffset <= 0) {
      apply({ shadow: null });
      return;
    }
    const fabric = (await import("fabric")) as unknown as {
      Shadow: new (options: Record<string, unknown>) => unknown;
    };
    apply({
      shadow: new fabric.Shadow({
        color: nextColor,
        blur: nextBlur,
        offsetX: nextOffset,
        offsetY: nextOffset,
      }),
    });
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <ColorField
          label="影の色"
          value={colorToHex(shadow?.color, "#000000")}
          onChange={(color) => {
            void setShadow({ color }).then(apply.commit);
          }}
        />
        <div />
      </div>
      <NumberSlider
        label="影のぼかし"
        value={numberValue(shadow?.blur, 0)}
        min={0}
        max={40}
        onChange={(blur) => void setShadow({ blur })}
        onCommit={apply.commit}
      />
      <NumberSlider
        label="影の距離"
        value={numberValue(shadow?.offsetX, 0)}
        min={0}
        max={30}
        onChange={(offset) => void setShadow({ offset })}
        onCommit={apply.commit}
      />
    </div>
  );
}

/** 整列 (元画像基準) と重ね順。画像・テキスト・図形の共通操作。 */
function AlignOrderSection({ object }: { object: FabricObject }) {
  const canvas = useEditor((state) => state.canvas) as {
    getWidth?: () => number;
    getHeight?: () => number;
    requestRenderAll?: () => void;
    bringObjectToFront?: (object: unknown) => void;
    bringObjectForward?: (object: unknown) => void;
    sendObjectBackwards?: (object: unknown) => void;
    sendObjectToBack?: (object: unknown) => void;
    bringToFront?: (object: unknown) => void;
    bringForward?: (object: unknown) => void;
    sendBackwards?: (object: unknown) => void;
    sendToBack?: (object: unknown) => void;
  } | null;
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  if (!canvas) return null;

  const base = getCanvasBaseSize(canvas);
  const baseWidth = base?.width ?? canvas.getWidth?.() ?? 0;
  const baseHeight = base?.height ?? canvas.getHeight?.() ?? 0;
  const scaledWidth = () => (Number(object.width) || 0) * (Number(object.scaleX) || 1);
  const scaledHeight = () => (Number(object.height) || 0) * (Number(object.scaleY) || 1);
  const place = (values: Record<string, unknown>) => {
    object.set?.(values);
    object.setCoords?.();
    canvas.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };
  const reorder = (which: "front" | "forward" | "backward" | "back") => {
    const call = (v6?: (o: unknown) => void, legacy?: (o: unknown) => void) => {
      if (v6) v6.call(canvas, object);
      else legacy?.call(canvas, object);
    };
    if (which === "front") call(canvas.bringObjectToFront, canvas.bringToFront);
    if (which === "forward") call(canvas.bringObjectForward, canvas.bringForward);
    if (which === "backward") call(canvas.sendObjectBackwards, canvas.sendBackwards);
    if (which === "back") call(canvas.sendObjectToBack, canvas.sendToBack);
    canvas.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };
  const alignButton = (label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className="rounded-md border border-[#343434] bg-[#161616] px-1 py-1.5 text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-2 border-t border-[#242424] pt-2">
      <Field label="整列 (画像基準)">
        <div className="grid grid-cols-6 gap-1">
          {alignButton("左", () => place({ left: 0 }))}
          {alignButton("中", () => place({ left: (baseWidth - scaledWidth()) / 2 }))}
          {alignButton("右", () => place({ left: baseWidth - scaledWidth() }))}
          {alignButton("上", () => place({ top: 0 }))}
          {alignButton("央", () => place({ top: (baseHeight - scaledHeight()) / 2 }))}
          {alignButton("下", () => place({ top: baseHeight - scaledHeight() }))}
        </div>
      </Field>
      <Field label="重ね順">
        <div className="grid grid-cols-4 gap-1">
          {alignButton("最前", () => reorder("front"))}
          {alignButton("前へ", () => reorder("forward"))}
          {alignButton("後へ", () => reorder("backward"))}
          {alignButton("最後", () => reorder("back"))}
        </div>
      </Field>
    </div>
  );
}

/**
 * 同じ雰囲気のままAIで差し替える (分解で切り出したレイヤー限定)。
 * 例: 文字レイヤーを選んで「文字を『未来は今日だ』に」→ 書体・質感を保った差し替え。
 */
function RestyleSection() {
  const [instruction, setInstruction] = useState("");
  const busyTool = useEditor((state) => state.busyTool);
  const { restyleSelectedLayer } = useEditorActions();
  const busy = busyTool !== null;
  const run = () => {
    const trimmed = instruction.trim();
    if (!trimmed || busy) return;
    void restyleSelectedLayer(
      `マスクの白い領域だけを編集する: ${trimmed}。周囲と同じ書体・色・質感・光・雰囲気を完全に維持し、白い領域の外は1ピクセルも変更しない。`,
    );
  };
  return (
    <div className="space-y-1.5 rounded-lg border border-pink-500/30 bg-pink-500/5 p-2">
      <p className="text-[10px] font-black text-pink-200">✦ 同じ雰囲気でAI差し替え</p>
      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        rows={2}
        placeholder="例: 文字を「未来は今日だ。」に差し替える"
        disabled={busy}
        className="w-full resize-none rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={run}
        disabled={busy || instruction.trim().length === 0}
        className="w-full rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {busy ? "AIが描き直し中…" : "差し替える"}
      </button>
    </div>
  );
}
