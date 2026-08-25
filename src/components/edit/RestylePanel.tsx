import { convertFileSrc } from "@tauri-apps/api/core";

export type RestylePreset = {
  id: string;
  label: string;
  prompt: string;
  filter: string;
  pixelated?: boolean;
};

export const RESTYLE_PRESETS: readonly RestylePreset[] = [
  { id: "anime", label: "アニメ", prompt: "clean 2D anime illustration style, cel shading, vivid colors", filter: "saturate(1.4) contrast(1.12) brightness(1.05)" },
  { id: "watercolor", label: "水彩", prompt: "delicate watercolor painting style, translucent pigments, soft paper texture", filter: "saturate(.78) contrast(.82) brightness(1.12)" },
  { id: "oil", label: "油絵", prompt: "rich classical oil painting style, visible brush strokes, layered pigments", filter: "saturate(1.2) contrast(1.22)" },
  { id: "pixel", label: "ピクセルアート", prompt: "detailed retro pixel art style, limited color palette, crisp pixel clusters", filter: "contrast(1.35) saturate(1.25)", pixelated: true },
  { id: "mono", label: "モノクロ映画", prompt: "cinematic black and white film style, dramatic contrast, fine film grain", filter: "grayscale(1) contrast(1.25)" },
  { id: "sepia", label: "セピア写真", prompt: "antique sepia photograph style, warm faded tones, subtle aged texture", filter: "sepia(.85) contrast(.92) brightness(.96)" },
  { id: "cyberpunk", label: "サイバーパンク", prompt: "neon cyberpunk style, electric magenta and cyan lighting, futuristic atmosphere", filter: "saturate(1.65) contrast(1.25) hue-rotate(12deg)" },
  { id: "3d", label: "3Dレンダー", prompt: "polished cinematic 3D render style, physically based materials, studio lighting", filter: "contrast(1.12) saturate(1.12) brightness(1.06)" },
  { id: "line", label: "線画", prompt: "clean expressive ink line art style, precise contours, minimal shading", filter: "grayscale(1) contrast(2) brightness(1.25)" },
  { id: "riso", label: "リソグラフ", prompt: "two-color risograph print style, misregistered ink layers, tactile paper grain", filter: "contrast(1.25) saturate(1.5) sepia(.15)" },
  { id: "retrofilm", label: "レトロフィルム", prompt: "nostalgic retro film still style, faded colors, analog grain, soft highlights", filter: "sepia(.2) saturate(.78) contrast(.92)" },
  { id: "clay", label: "粘土フィギュア", prompt: "handmade clay figurine style, soft sculpted forms, charming stop-motion texture", filter: "saturate(1.18) contrast(.92) brightness(1.08)" },
] as const;

type Props = {
  imagePath: string;
  value: string;
  busy?: boolean;
  onSelect: (prompt: string) => void;
};

/** 現在の画像そのものを12通りの雰囲気で見比べるリスタイル一覧。 */
export function RestylePanel({ imagePath, value, busy = false, onSelect }: Props) {
  const src = convertFileSrc(imagePath);
  return (
    <div className="px-4 pb-2 pt-2">
      <p className="text-[10px] font-bold leading-4 text-neutral-500">
        雰囲気を選ぶと、下のスタイル欄へ文章が入ります。文章は自由に直せます。
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {RESTYLE_PRESETS.map((preset) => {
          const active = value.trim() === preset.prompt;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(preset.prompt)}
              className={`group overflow-hidden rounded-lg border bg-[#101010] text-left transition ${
                active ? "border-pink-400 ring-1 ring-pink-400" : "border-[#343434] hover:border-pink-400"
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <img
                src={src}
                alt=""
                className="aspect-[4/3] w-full object-cover"
                style={{
                  filter: preset.filter,
                  imageRendering: preset.pixelated ? "pixelated" : "auto",
                }}
              />
              <span className="block truncate px-2 py-1.5 text-[9px] font-black text-neutral-300 group-hover:text-white">
                {preset.label}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] font-bold text-neutral-600">
        下の入力欄に好みのスタイルを書いて「実行」を押します。
      </p>
    </div>
  );
}

export default RestylePanel;
