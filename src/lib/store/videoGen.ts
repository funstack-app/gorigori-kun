import { create } from "zustand";
import { findVideoModel, type VideoModelId } from "../videoModels";

export type VideoGenState = {
  /** i2v 元画像。null なら t2v */
  sourceImagePath: string | null;
  /** 選択中の動画モデル */
  modelId: VideoModelId;
  /** 生成尺（秒） */
  duration: number;
  /** アスペクト比 */
  aspectRatio: string;
  /** 1回に生成する本数 (1〜4) */
  count: number;
  /** モデル別パラメータの選択値 (param.name → value)。未設定なら各 param.default を使う */
  extraParamValues: Record<string, string>;
};

type VideoGenStore = VideoGenState & {
  setSourceImage: (path: string | null) => void;
  /** モデル変更時は duration / aspect / extraParam をそのモデルのデフォルトへ戻す */
  setModel: (id: VideoModelId) => void;
  setDuration: (n: number) => void;
  setAspectRatio: (v: string) => void;
  setCount: (n: number) => void;
  setExtraParam: (name: string, value: string) => void;
  reset: () => void;
};

/** モデルの extraParams からデフォルト値マップを作る */
function defaultExtraParams(modelId: VideoModelId): Record<string, string> {
  const model = findVideoModel(modelId);
  if (!model) return {};
  const out: Record<string, string> = {};
  for (const param of model.extraParams) {
    out[param.name] = String(param.default);
  }
  return out;
}

export const MAX_VIDEO_COUNT = 4;

const DEFAULT_MODEL_ID: VideoModelId = "kling3_0";
const DEFAULT_MODEL = findVideoModel(DEFAULT_MODEL_ID);

function defaultState(): VideoGenState {
  return {
    sourceImagePath: null,
    modelId: DEFAULT_MODEL_ID,
    duration: DEFAULT_MODEL?.duration.default ?? 5,
    aspectRatio: DEFAULT_MODEL?.defaultAspectRatio ?? "16:9",
    count: 1,
    extraParamValues: defaultExtraParams(DEFAULT_MODEL_ID),
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

/** モデルが対応する比率に収まらなければモデルのデフォルト比率へ寄せる */
function clampAspect(modelId: VideoModelId, value: string): string {
  const model = findVideoModel(modelId);
  if (!model) return value;
  return model.aspectRatios.includes(value) ? value : model.defaultAspectRatio;
}

function clampCount(value: number): number {
  const rounded = Math.round(value);
  return Math.min(MAX_VIDEO_COUNT, Math.max(1, rounded));
}

export const useVideoGen = create<VideoGenStore>((set) => ({
  ...defaultState(),
  setSourceImage: (sourceImagePath) => set({ sourceImagePath }),
  setModel: (modelId) => {
    const model = findVideoModel(modelId);
    set((state) => ({
      modelId,
      // モデル変更で duration / aspect が非対応になるなら、そのモデルの有効値へ寄せる
      duration: clampDuration(modelId, model?.duration.default ?? state.duration),
      aspectRatio: clampAspect(modelId, model?.defaultAspectRatio ?? state.aspectRatio),
      // 別モデルのパラメータが残らないよう、新モデルのデフォルトで作り直す
      extraParamValues: defaultExtraParams(modelId),
    }));
  },
  setDuration: (duration) => {
    set((state) => ({ duration: clampDuration(state.modelId, duration) }));
  },
  setAspectRatio: (value) => {
    set((state) => ({ aspectRatio: clampAspect(state.modelId, value) }));
  },
  setCount: (count) => set({ count: clampCount(count) }),
  setExtraParam: (name, value) =>
    set((state) => ({ extraParamValues: { ...state.extraParamValues, [name]: value } })),
  reset: () => set(defaultState()),
}));

if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __stores?: Record<string, unknown> }).__stores ??= {};
  (window as unknown as { __stores: Record<string, unknown> }).__stores.videoGen = useVideoGen;
}
