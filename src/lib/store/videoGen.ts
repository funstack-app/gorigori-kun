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
  /**
   * 比較生成で使うモデル (A案: 各モデルはデフォルト設定で1本ずつ生成)。
   * - 空配列 = 比較OFF。単一 modelId で従来どおり生成
   * - 2〜4件 = 比較モード。選んだモデルそれぞれで1本生成して並べる
   */
  compareModelIds: VideoModelId[];
};

type VideoGenStore = VideoGenState & {
  setSourceImage: (path: string | null) => void;
  /** モデル変更時は duration / aspect / extraParam をそのモデルのデフォルトへ戻す */
  setModel: (id: VideoModelId) => void;
  setDuration: (n: number) => void;
  setAspectRatio: (v: string) => void;
  setCount: (n: number) => void;
  setExtraParam: (name: string, value: string) => void;
  /** 比較対象モデルを丸ごと差し替える (UI のチェックボックス選択を反映) */
  setCompareModelIds: (ids: VideoModelId[]) => void;
  /** 比較対象モデルの1件を ON/OFF する */
  toggleCompareModel: (id: VideoModelId) => void;
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
    compareModelIds: [],
  };
}

const MAX_COMPARE_MODELS = 4;

/** 比較モデル配列を正規化 (重複除去・最大4件) */
function normalizeCompareModelIds(ids: VideoModelId[]): VideoModelId[] {
  const seen = new Set<VideoModelId>();
  const next: VideoModelId[] = [];
  for (const id of ids) {
    if (seen.has(id) || !findVideoModel(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_COMPARE_MODELS) break;
  }
  return next;
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
  setCompareModelIds: (ids) =>
    set({ compareModelIds: normalizeCompareModelIds(ids) }),
  toggleCompareModel: (id) =>
    set((state) => {
      const exists = state.compareModelIds.includes(id);
      const next = exists
        ? state.compareModelIds.filter((x) => x !== id)
        : [...state.compareModelIds, id];
      return { compareModelIds: normalizeCompareModelIds(next) };
    }),
  reset: () => set(defaultState()),
}));

if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __stores?: Record<string, unknown> }).__stores ??= {};
  (window as unknown as { __stores: Record<string, unknown> }).__stores.videoGen = useVideoGen;
}
