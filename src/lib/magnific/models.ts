// Magnific オプショナル拡張のモデル定義 (2026-06-08)。
// MCP(images_models_list)で取得した実モデルidを静的に持つ(Higgsfieldのunlimited.tsと同方式)。
// Magnific接続済みのときだけ、モデル選択にこれらが追加される。

export type MagnificModel = {
  id: string;
  name: string;
};

// よく使う主力モデルを FEATURED として厳選(全45モデルは多すぎるため)。
// 高品質・話題のモデルを優先。フル一覧が要るなら将来 images_models_list を動的取得する。
export const FEATURED_MAGNIFIC_IMAGE_MODELS: MagnificModel[] = [
  { id: "imagen-nano-banana-2", name: "Nano Banana Pro" },
  { id: "imagen-nano-banana-2-flash", name: "Nano Banana 2" },
  { id: "flux-2", name: "Flux.2 Pro" },
  { id: "flux-2-max", name: "Flux.2 Max" },
  { id: "seedream-4-5", name: "Seedream 4.5" },
  { id: "seedream-5-lite", name: "Seedream 5 Lite" },
  { id: "imagen4-ultra", name: "Imagen 4 Ultra" },
  { id: "gpt-2", name: "GPT 2" },
  { id: "mystic-2-5", name: "Mystic 2.5" },
  { id: "recraft-v4-1", name: "Recraft V4.1" },
  { id: "ideogram-4", name: "Ideogram 4" },
  { id: "z-image", name: "Z-Image" },
];

export function getMagnificModelName(id: string): string {
  return (
    FEATURED_MAGNIFIC_IMAGE_MODELS.find((m) => m.id === id)?.name ?? id
  );
}
