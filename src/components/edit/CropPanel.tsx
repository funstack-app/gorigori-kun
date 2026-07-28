import type { NormalizedBbox } from "./RegionSelectOverlay";

type Props = {
  region: NormalizedBbox | null;
  onApply: () => void;
  onClear: () => void;
  busy?: boolean;
};

/**
 * 「切り抜き」チップの右パネル。
 *
 * 囲む → 「切り抜く」を押す、の2手だけ。囲む前は押せるボタンを出さない
 * (押せるのに何も起きないボタンを作らない)。
 */
export function CropPanel({ region, onApply, onClear, busy }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <h3 className="text-xs font-black text-white">切り抜き</h3>
      <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
        残したいところをドラッグで囲んでください。
      </p>

      <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-[#343434] bg-[#1c1c1c] px-2.5 py-2">
        <span className="min-w-0 flex-1 text-[10px] font-bold leading-4 text-neutral-300">
          {region ? "囲んだところだけ残します" : "まだ囲んでいません"}
        </span>
        {region ? (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="shrink-0 rounded border border-[#3a3a3a] px-1.5 py-0.5 text-[10px] font-bold text-neutral-400 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            範囲をやめる
          </button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onApply}
        disabled={busy || !region}
        className="mt-2.5 h-10 w-full rounded-lg bg-pink-500 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        切り抜く
      </button>

      <p className="mt-1.5 text-[10px] font-bold leading-4 text-neutral-500">
        置いた文字や直した部分も、位置関係そのままで一緒に切り抜かれます。『戻す』で元に戻せます。
      </p>
    </div>
  );
}

export default CropPanel;
