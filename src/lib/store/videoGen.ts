import { create } from "zustand";
import { findVideoModel, type VideoModelId } from "../videoModels";

export type VideoGenState = {
  /** i2v 元画像。null なら t2v */
  sourceImagePath: string | null;
  /** 被写体の動き。初心者が詰め込みすぎないよう 1 動作だけを想定する */
  subjectMotion: string;
  /** カメラの動きプリセットID */
  cameraMovement: string;
  /** 選択中の動画モデル */
  modelId: VideoModelId;
  /** 生成尺（秒） */
  duration: number;
  /** アスペクト比 */
  aspectRatio: string;
};

type VideoGenStore = VideoGenState & {
  setSourceImage: (path: string | null) => void;
  setSubjectMotion: (v: string) => void;
  setCameraMovement: (v: string) => void;
  /** モデル変更時は duration / aspect をそのモデルのデフォルトへ戻す */
  setModel: (id: VideoModelId) => void;
  setDuration: (n: number) => void;
  setAspectRatio: (v: string) => void;
  reset: () => void;
};

export const CAMERA_PRESETS = [
  { id: "static", label: "固定", phrase: "static camera, locked-off shot" },
  { id: "zoom_in", label: "ズームイン", phrase: "slow zoom in" },
  { id: "zoom_out", label: "ズームアウト", phrase: "slow zoom out" },
  { id: "dolly_in", label: "ドリーイン", phrase: "gentle dolly push-in" },
  { id: "dolly_out", label: "ドリーアウト", phrase: "gentle dolly pull-out" },
  { id: "orbit", label: "オービット", phrase: "smooth orbit around subject" },
  { id: "pan_left", label: "左パン", phrase: "slow pan left" },
  { id: "pan_right", label: "右パン", phrase: "slow pan right" },
] as const;

export const MOTION_PRESETS = [
  "ゆっくり振り返る",
  "歩いてくる",
  "手を伸ばす",
  "微笑む",
  "髪をなびかせる",
  "見上げる",
] as const;

const DEFAULT_MODEL_ID: VideoModelId = "kling3_0";
const DEFAULT_MODEL = findVideoModel(DEFAULT_MODEL_ID);

function defaultState(): VideoGenState {
  return {
    sourceImagePath: null,
    subjectMotion: "",
    cameraMovement: "static",
    modelId: DEFAULT_MODEL_ID,
    duration: DEFAULT_MODEL?.duration.default ?? 5,
    aspectRatio: DEFAULT_MODEL?.defaultAspectRatio ?? "16:9",
  };
}

function clampDuration(modelId: VideoModelId, value: number): number {
  const model = findVideoModel(modelId);
  if (!model) return Math.max(1, Math.round(value));
  if (model.duration.kind === "enum") {
    return model.duration.values.includes(value) ? value : model.duration.default;
  }
  const rounded = Math.round(value);
  return Math.min(model.duration.max, Math.max(model.duration.min, rounded));
}

export const useVideoGen = create<VideoGenStore>((set, get) => ({
  ...defaultState(),
  setSourceImage: (sourceImagePath) => set({ sourceImagePath }),
  setSubjectMotion: (subjectMotion) => set({ subjectMotion }),
  setCameraMovement: (cameraMovement) => set({ cameraMovement }),
  setModel: (modelId) => {
    const model = findVideoModel(modelId);
    set({
      modelId,
      duration: model?.duration.default ?? get().duration,
      aspectRatio: model?.defaultAspectRatio ?? get().aspectRatio,
    });
  },
  setDuration: (duration) => {
    set({ duration: clampDuration(get().modelId, duration) });
  },
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  reset: () => set(defaultState()),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.videoGen = useVideoGen;
}
