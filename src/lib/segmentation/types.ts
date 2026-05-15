export type SegmentationModel = "u2net" | "u2netp" | "mobile_sam" | "sam3";

export type SegmentationModelOption = {
  id: SegmentationModel;
  label: string;
  sizeMb: number;
  description: string;
};

export type SegmentationModelStatus = {
  model: SegmentationModel;
  installed: boolean;
  cachePath: string;
  estimatedSizeMb: number;
};

export type SegmentationResult = {
  foregroundPath: string;
  backgroundPath: string;
  maskPath: string;
};

export const SEGMENTATION_MODELS: SegmentationModelOption[] = [
  {
    id: "u2net",
    label: "U2Net",
    sizeMb: 176,
    description: "前景と背景をざっくり分ける標準モデル",
  },
  {
    id: "u2netp",
    label: "U2NetP",
    sizeMb: 5,
    description: "軽量で試しやすい小型モデル",
  },
  {
    id: "mobile_sam",
    label: "MobileSAM",
    sizeMb: 39,
    description: "手動指定や高精度化に備えた候補モデル",
  },
  {
    id: "sam3",
    label: "SAM 3",
    sizeMb: 3490,
    description: "高精度モード用のオンデマンドモデル",
  },
];
