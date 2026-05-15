import { invoke } from "@tauri-apps/api/core";

import type {
  SegmentationModel,
  SegmentationModelStatus,
  SegmentationResult,
} from "./types";

export { SEGMENTATION_MODELS } from "./types";
export type {
  SegmentationModel,
  SegmentationModelOption,
  SegmentationModelStatus,
  SegmentationResult,
} from "./types";

export async function isSegmentationModelReady(
  model: SegmentationModel,
): Promise<SegmentationModelStatus> {
  return invoke<SegmentationModelStatus>("is_segmentation_model_ready", {
    model,
  });
}

export async function downloadSegmentationModel(
  model: SegmentationModel,
): Promise<SegmentationModelStatus> {
  return invoke<SegmentationModelStatus>("download_segmentation_model", {
    model,
  });
}

export async function segmentImage(args: {
  imagePath: string;
  model: SegmentationModel;
}): Promise<SegmentationResult> {
  return invoke<SegmentationResult>("segment_image", args);
}
