import {
  ADJUST_PRESETS,
  isNeutralAdjust,
  type AdjustValues,
} from "./editor/adjustFilters";
import type { TransformKind } from "./editor/canvasTransforms";

type Props = {
  values: AdjustValues;
  /** つまみを動かしている最中 (プレビューだけ更新。履歴は積まない)。 */
  onChange: (patch: Partial<AdjustValues>) => void;
  /** つまみを離した / プリセットを押した (ここで履歴1手)。 */
  onCommit: () => void;
  onPreset: (values: AdjustValues) => void;
  onReset: () => void;
  onTransform: (kind: TransformKind) => void;
  busy?: boolean;
};

/** スライダー1本の定義 (ラベル・範囲・刻み)。 */
type SliderSpec = {
  key: "brightness" | "contrast" | "saturation" | "hue" | "noise";
  label: string;
  min: number;
  max: number;
  step: number;
};

/**
 * スライダーの範囲。
 *
 * 明るさ・コントラスト・彩度は fabric の単位そのまま (-1..1)。ただし ±1 は
 * 実用域を大きく超えて「真っ白 / 真っ黒」になるだけなので、扱いやすい
 * ±0.5 に狭めている (境界ちょうどの値を使わせない = 事故る余地を減らす)。
 * 色合いは度 (-180..180)、粒子は 0..100。
 */
const SLIDERS: readonly SliderSpec[] = [
  { key: "brightness", label: "明るさ", min: -0.5, max: 0.5, step: 0.01 },
  { key: "contrast", label: "コントラスト", min: -0.5, max: 0.5, step: 0.01 },
  { key: "saturation", label: "彩度", min: -1, max: 1, step: 0.01 },
  { key: "hue", label: "色合い", min: -180, max: 180, step: 1 },
  { key: "noise", label: "粒子", min: 0, max: 100, step: 1 },
] as const;

const TRANSFORMS: ReadonlyArray<{ kind: TransformKind; label: string }> = [
  { kind: "rotate-left", label: "90°左回転" },
  { kind: "rotate-right", label: "90°右回転" },
  { kind: "flip-h", label: "左右反転" },
  { kind: "flip-v", label: "上下反転" },
] as const;

/**
 * 「調整」チップの右パネル。明るさ・色をその場で変える (AI 不使用)。
 *
 * つまみを動かしている最中は onChange でプレビューだけ更新し、離した時点
 * (pointerup / keyup / change) で onCommit を呼んで履歴を1手だけ積む。
 * 動かしている間ずっと積むと、1回のドラッグで数十手になって「戻す」が
 * 実質使えなくなる (既存の文字サイズ変更と同じ流儀)。
 */
export function AdjustPanel({
  values,
  onChange,
  onCommit,
  onPreset,
  onReset,
  onTransform,
  busy,
}: Props) {
  const neutral = isNeutralAdjust(values);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <h3 className="text-xs font-black text-white">調整</h3>
      <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
        明るさや色をその場で変えられます。AIは使わないので待ち時間はありません。
      </p>

      {/* プリセット: まずは押すだけで雰囲気が変わる入口を上に置く。 */}
      <p className="mt-3 text-[10px] font-black text-neutral-400">おまかせ</p>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {ADJUST_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onPreset(preset.values)}
            disabled={busy}
            className="group flex flex-col items-center gap-1 rounded-lg border border-[#343434] bg-[#1c1c1c] p-1.5 hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span
              className="block h-7 w-full rounded"
              style={{ background: preset.swatch }}
              aria-hidden
            />
            <span className="text-[9px] font-bold leading-3 text-neutral-300 group-hover:text-white">
              {preset.label}
            </span>
          </button>
        ))}
      </div>

      {/* スライダー: 自分で細かく決めたい人向け。 */}
      <p className="mt-4 text-[10px] font-black text-neutral-400">こまかく調整</p>
      <div className="mt-1.5 space-y-2.5 rounded-lg border border-[#333] bg-[#1c1c1c] p-2.5">
        {SLIDERS.map((slider) => (
          <label key={slider.key} className="block">
            <span className="flex items-center justify-between text-[10px] font-bold text-neutral-400">
              <span>{slider.label}</span>
              <span className="tabular-nums text-neutral-500">
                {formatValue(slider, values[slider.key])}
              </span>
            </span>
            <input
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={values[slider.key]}
              disabled={busy}
              onChange={(event) =>
                onChange({ [slider.key]: Number(event.target.value) } as Partial<AdjustValues>)
              }
              // つまみを離したときだけ履歴を積む。マウス・キーボード・タッチの
              // どれで操作されても確定を取りこぼさないよう3経路とも拾う。
              onPointerUp={onCommit}
              onKeyUp={onCommit}
              onTouchEnd={onCommit}
              className="mt-1 w-full accent-pink-500 disabled:cursor-not-allowed disabled:opacity-40"
            />
          </label>
        ))}

        <button
          type="button"
          onClick={onReset}
          disabled={busy || neutral}
          className="w-full rounded-md border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-[10px] font-black text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          リセット
        </button>
      </div>

      {/* 回転・反転: 押した瞬間に効く決定論操作。 */}
      <p className="mt-4 text-[10px] font-black text-neutral-400">回転・反転</p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {TRANSFORMS.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => onTransform(item.kind)}
            disabled={busy}
            className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-2 py-2 text-[10px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] font-bold leading-4 text-neutral-500">
        画像ぜんぶに効きます。右の履歴から戻せます。
      </p>
    </div>
  );
}

/** つまみの現在値を人が読める形にする (小数は百分率、度と粒子はそのまま)。 */
function formatValue(slider: SliderSpec, value: number): string {
  if (slider.key === "hue") return `${Math.round(value)}°`;
  if (slider.key === "noise") return String(Math.round(value));
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)}`;
}

export default AdjustPanel;
