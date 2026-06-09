// Higgsfield モデルの静的カタログ (2026-06-10 models_explore 実データから生成)。
//
// なぜ静的に持つか: モデル一覧の動的取得 (models_explore) は実測1-2秒だが、
// 取得完了までピッカーが「モデル一覧を確認中...」でブロックされる。
// 静的カタログを即表示のベースにし、裏で最新を取得して差し替える
// (stale-while-revalidate)。動的取得が成功すればこのリストは上書きされるので、
// 多少古くても実害がない (生成時の model id はサーバ側で検証される)。
//
// 更新方法: mcpServer/tool/call で models_explore {action:"list", type, limit:100} を
// 叩いた結果を写す (DEV-PLAYBOOK §5-1)。

import type { HiggsfieldModelInfo } from "../ipc";

export const STATIC_IMAGE_MODELS: HiggsfieldModelInfo[] = [
  { jobSetType: "nano_banana_2", displayName: "Nano Banana 2", type: "image" },
  { jobSetType: "nano_banana_pro", displayName: "Nano Banana Pro", type: "image" },
  { jobSetType: "nano_banana", displayName: "Nano Banana", type: "image" },
  { jobSetType: "soul_2", displayName: "Higgsfield Soul 2.0", type: "image" },
  { jobSetType: "soul_cinematic", displayName: "Soul Cinema", type: "image" },
  { jobSetType: "seedream_v4_5", displayName: "Seedream 4.5", type: "image" },
  { jobSetType: "seedream_v5_lite", displayName: "Seedream 5.0 lite", type: "image" },
  { jobSetType: "z_image", displayName: "Z Image", type: "image" },
  { jobSetType: "flux_2", displayName: "Flux 2.0", type: "image" },
  { jobSetType: "flux_kontext", displayName: "Flux Kontext Max", type: "image" },
  { jobSetType: "kling_omni_image", displayName: "Kling O1 Image", type: "image" },
  { jobSetType: "gpt_image", displayName: "GPT Image 1.5", type: "image" },
  { jobSetType: "gpt_image_2", displayName: "GPT Image 2", type: "image" },
  { jobSetType: "grok_image", displayName: "Grok Imagine", type: "image" },
  { jobSetType: "recraft-v4-1", displayName: "Recraft 4.1", type: "image" },
  { jobSetType: "cinematic_studio_2_5", displayName: "Cinema Studio Image 2.5", type: "image" },
  { jobSetType: "marketing_studio_image", displayName: "Marketing Studio Image", type: "image" },
  { jobSetType: "ms_image", displayName: "DTC Ads", type: "image" },
  { jobSetType: "image_auto", displayName: "Auto", type: "image" },
  { jobSetType: "soul_cast", displayName: "Soul Cast", type: "image" },
  { jobSetType: "soul_location", displayName: "Soul Location", type: "image" },
  { jobSetType: "soul_v2", displayName: "Higgsfield Soul 2.0", type: "image" },
];

export const STATIC_VIDEO_MODELS: HiggsfieldModelInfo[] = [
  { jobSetType: "seedance_2_0", displayName: "Seedance 2.0", type: "video" },
  { jobSetType: "seedance_1_5", displayName: "Seedance 1.5 Pro", type: "video" },
  { jobSetType: "minimax_hailuo", displayName: "Minimax Hailuo", type: "video" },
  { jobSetType: "wan2_6", displayName: "Wan 2.6", type: "video" },
  { jobSetType: "wan2_7", displayName: "Wan 2.7", type: "video" },
  { jobSetType: "kling2_6", displayName: "Kling 2.6", type: "video" },
  { jobSetType: "kling3_0", displayName: "Kling 3.0", type: "video" },
  { jobSetType: "grok_video", displayName: "Grok Imagine", type: "video" },
  { jobSetType: "grok_video_v15", displayName: "Grok Imagine 1.5", type: "video" },
  { jobSetType: "veo3", displayName: "Google Veo 3", type: "video" },
  { jobSetType: "veo3_1", displayName: "Google Veo 3.1", type: "video" },
  { jobSetType: "veo3_1_lite", displayName: "Veo 3.1 Lite", type: "video" },
  { jobSetType: "cinematic_studio_3_0", displayName: "Cinema Studio Video 3.0", type: "video" },
  { jobSetType: "cinematic_studio_video", displayName: "Cinema Studio Video", type: "video" },
  { jobSetType: "cinematic_studio_video_v2", displayName: "Cinema Studio Video", type: "video" },
  { jobSetType: "marketing_studio_video", displayName: "Marketing Studio", type: "video" },
  { jobSetType: "higgsfield_preset", displayName: "Higgsfield Preset", type: "video" },
  { jobSetType: "video_standard", displayName: "Seedance 2.0", type: "video" },
];

export function staticModelsFor(media: "image" | "video"): HiggsfieldModelInfo[] {
  return media === "video" ? STATIC_VIDEO_MODELS : STATIC_IMAGE_MODELS;
}
