import { useCallback, useMemo, useState } from "react";
import { buildVideoScenePrompt } from "./buildVideoScenePrompt";
import { resolveImageMentions } from "./resolveImageMentions";
import { higgsfield, type HiggsfieldCompareModel, type HiggsfieldVideoParams } from "../ipc";
import { useAuth } from "../store/auth";
import { useBatches } from "../store/batches";
import { useComposer } from "../store/composer";
import { useScenePromptOverride } from "../store/scenePrompt";
import { useToasts } from "../store/toasts";
import { useVideoGen } from "../store/videoGen";
import { useVideoSceneStore } from "../store/videoScene";
import type { VideoSceneState } from "./video-types";
import {
  findVideoModel,
  VIDEO_MODELS,
  type VideoModelDefinition,
  type VideoModelParam,
} from "../videoModels";

export type VideoGenerationStatus =
  | { kind: "idle" }
  | { kind: "running"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export type UseVideoSceneGenerationReturn = {
  scene: VideoSceneState;
  generatedPrompt: string;
  refImagePaths: string[];
  model: VideoModelDefinition;
  /** 比較モード (2モデル以上選択中) か */
  compareMode: boolean;
  /** 比較対象モデル (compareMode 時のみ 2件以上) */
  compareModels: VideoModelDefinition[];
  promptOverride: string | null;
  setPromptOverride: (value: string | null) => void;
  effectivePrompt: string;
  status: VideoGenerationStatus;
  hasRunningBatch: boolean;
  runningBatchCount: number;
  maxConcurrentBatches: number;
  isQueueFull: boolean;
  activeBatchSummary: string | null;
  disabled: boolean;
  generate: () => Promise<void>;
};

const MAX_CONCURRENT_BATCHES = 3;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * モデルの extraParams を Higgsfield 引数へ変換する。
 * ユーザーが UI で選んだ値 (selected) を優先し、無ければ param.default にフォールバックする。
 */
export function paramsToVideoArgs(
  params: VideoModelParam[],
  selected: Record<string, string>,
): HiggsfieldVideoParams {
  const args: HiggsfieldVideoParams = {};
  for (const param of params) {
    const value = selected[param.name] ?? String(param.default);
    if (param.name === "model" || param.name === "model_variant") {
      args.modelVariant = value;
    } else if (param.name === "quality") {
      args.quality = value;
    } else if (param.name === "mode") {
      args.mode = value;
    } else if (param.name === "resolution") {
      args.resolution = value;
    } else if (param.name === "sound") {
      args.sound = value;
    } else if (param.name === "genre") {
      args.genre = value;
    }
  }
  return args;
}

/**
 * 比較生成では各モデルを生成する。尺は共通設定 (commonDuration) を各モデルの
 * 有効範囲に丸めて適用し、モデル固有パラメータ (mode/resolution/genre 等) は
 * 各モデルのおすすめ値 (param.default) を使う。比率は generateCompare 側で共通適用。
 */
function toCompareModel(
  model: VideoModelDefinition,
  commonDuration: number,
): HiggsfieldCompareModel {
  // 共通尺をモデルの制約に丸める (enum は最も近い許容値、integer は min/max クランプ)
  const duration =
    model.duration.kind === "enum"
      ? model.duration.values.includes(commonDuration)
        ? commonDuration
        : model.duration.default
      : Math.min(model.duration.max, Math.max(model.duration.min, commonDuration));
  return {
    jobSetType: model.jobSetType,
    displayName: model.label,
    duration,
    i2vInputField: model.i2vInputField,
    // extraParams は selected を渡さず空 → 各 param.default が使われる
    ...paramsToVideoArgs(model.extraParams, {}),
  };
}

function useVideoSceneSnapshot(): VideoSceneState {
  const subject = useVideoSceneStore((state) => state.subject);
  const motion = useVideoSceneStore((state) => state.motion);
  const camera = useVideoSceneStore((state) => state.camera);
  const staging = useVideoSceneStore((state) => state.staging);

  return useMemo(
    () => ({ subject, motion, camera, staging }),
    [subject, motion, camera, staging],
  );
}

/**
 * 画像版 useSceneGeneration の動画版。
 * useVideoSceneStore の 6 要素からプロンプトを組み立て、
 * higgsfield.generateBatch({ mediaType: "video" }) で動画を生成する。
 *
 * 元画像 (i2v) は useVideoGen.sourceImagePath を最優先で使い、
 * 無ければ useComposer の参照画像 (プロンプト欄上のラック) を i2v 元画像として使う。
 */
export function useVideoSceneGeneration(): UseVideoSceneGenerationReturn {
  const scene = useVideoSceneSnapshot();
  const generatedPrompt = useMemo(() => buildVideoScenePrompt(scene), [scene]);

  const sourceImagePath = useVideoGen((s) => s.sourceImagePath);
  const duration = useVideoGen((s) => s.duration);
  const aspectRatio = useVideoGen((s) => s.aspectRatio);
  const modelId = useVideoGen((s) => s.modelId);
  const count = useVideoGen((s) => s.count);
  const extraParamValues = useVideoGen((s) => s.extraParamValues);
  const compareModelIds = useVideoGen((s) => s.compareModelIds);
  const model = findVideoModel(modelId) ?? VIDEO_MODELS[0];

  // 比較モード: 2モデル以上選択。各モデルをデフォルト設定で1本ずつ生成する (A案)。
  const compareModels = useMemo(
    () =>
      compareModelIds
        .map((id) => findVideoModel(id))
        .filter((m): m is VideoModelDefinition => m !== undefined),
    [compareModelIds],
  );
  const compareMode = compareModels.length >= 2;

  // i2v 元画像: 動画タブの sourceImagePath を優先。無ければ参照ラックの先頭。
  const composerReferences = useComposer((s) => s.references);
  const refImagePaths = useMemo(() => {
    if (sourceImagePath) return [sourceImagePath];
    return composerReferences.map((r) => r.path);
  }, [sourceImagePath, composerReferences]);

  const promptOverride = useScenePromptOverride((s) => s.value);
  const setPromptOverride = useScenePromptOverride((s) => s.set);
  const effectivePrompt =
    promptOverride !== null ? promptOverride : generatedPrompt;

  const [status, setStatus] = useState<VideoGenerationStatus>({ kind: "idle" });
  const [_generating, setGenerating] = useState(false);
  void _generating;

  const allBatches = useBatches((state) => state.batches);
  const runningBatches = useMemo(
    () => allBatches.filter((batch) => batch.status === "running"),
    [allBatches],
  );
  const runningBatchCount = runningBatches.length;
  const hasRunningBatch = runningBatchCount > 0;
  const isQueueFull = runningBatchCount >= MAX_CONCURRENT_BATCHES;
  const disabled = isQueueFull || effectivePrompt.trim().length === 0;

  const activeBatchSummary = useMemo(() => {
    const active = runningBatches[0];
    if (!active) return null;
    const completed = active.workers.filter(
      (worker) => worker.status === "completed",
    ).length;
    return `${completed}/${active.count}`;
  }, [runningBatches]);

  const generate = useCallback(async (): Promise<void> => {
    // @imgN メンションを解決する。本文から @imgN を取り除き、指定された
    // 参照画像 (登場順・重複排除) を i2v 入力として優先採用する。
    // メンションが無ければ従来フォールバック (sourceImage / 参照ラック全部) を使う。
    const mentionResult = resolveImageMentions(
      effectivePrompt,
      composerReferences,
    );
    const prompt = mentionResult.cleanedPrompt.trim();
    const effectiveRefPaths =
      mentionResult.mentioned.length > 0
        ? mentionResult.mentioned.map((m) => m.path)
        : refImagePaths;
    if (!prompt) {
      setStatus({ kind: "error", message: "動きを1つ選ぶか書いてください" });
      return;
    }

    const authState = useAuth.getState();
    await authState.refresh({ silent: true });
    if (!useAuth.getState().account) {
      const message =
        "ChatGPT にログインしていないため、生成できません。\n" +
        "左下の「ログイン」ボタンから ChatGPT にログインしてください。";
      setStatus({ kind: "error", message });
      useToasts.getState().push({ kind: "error", text: message, ttlMs: 0 });
      return;
    }

    setGenerating(true);
    setStatus({
      kind: "running",
      message: compareMode
        ? `${compareModels.length}モデルで比較生成を開始しています...`
        : "動画生成を開始しています...",
    });

    // 比較モードは「モデル数」本、単一モードは count 本を生成する。
    const batchCount = compareMode ? compareModels.length : count;
    const batchId = `local-video-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    useBatches.getState().startBatch({
      batchId,
      prompt,
      references: effectiveRefPaths.map((path) => ({ path, name: basename(path) })),
      count: batchCount,
      provider: "higgsfield",
      modelJobSetType: compareMode ? undefined : model.jobSetType,
      modelDisplayName: compareMode
        ? `${compareModels.length} モデル比較`
        : model.label,
      compareMode,
      mediaType: "video",
    });

    try {
      const result = compareMode
        ? await higgsfield.generateCompare({
            prompt,
            models: compareModels.map((m) => toCompareModel(m, duration)),
            // 比率・尺は全モデル共通で適用 (各モデルの制約は toCompareModel 側で丸める)
            aspect: aspectRatio,
            refImagePaths: effectiveRefPaths,
            mediaType: "video",
          })
        : await higgsfield.generateBatch({
            jobSetType: model.jobSetType,
            displayName: model.label,
            prompt,
            count,
            aspect: aspectRatio,
            refImagePaths: effectiveRefPaths,
            mediaType: "video",
            duration,
            i2vInputField: model.i2vInputField,
            ...paramsToVideoArgs(model.extraParams, extraParamValues),
          });

      if (result.failedCount > 0 || result.generatedPaths.length === 0) {
        // モデル側が返した実際の理由 (NSFW判定・制限コンテンツ等) を最優先で表示する。
        // 理由が取れない時だけ一般的な再試行ガイドにフォールバックする。
        const reasons = (result.errors ?? []).filter((r) => r && r.trim().length > 0);
        const uniqueReasons = Array.from(new Set(reasons));
        const message =
          uniqueReasons.length > 0
            ? "動画生成に失敗しました。\n\n理由:\n" + uniqueReasons.join("\n\n")
            : "動画生成に失敗しました。\n" +
              "・モデル・尺・アスペクト比を変えて再試行してください\n" +
              "・i2v の場合は元画像のアスペクト比とモデルの対応を確認してください";
        setStatus({ kind: "error", message });
        useToasts.getState().push({ kind: "error", text: message, ttlMs: 0 });
        return;
      }
      setStatus({
        kind: "success",
        message: "動画を生成しました。右側のタイムラインに追加されます。",
      });
    } catch (error) {
      useBatches.getState().removeBatch(batchId);
      const errorMessage = String(error);
      setStatus({ kind: "error", message: `動画生成に失敗しました: ${errorMessage}` });
      useToasts.getState().push({
        kind: "error",
        text: `動画生成に失敗しました\n${errorMessage}`,
        ttlMs: 12000,
      });
      console.error("[useVideoSceneGeneration] generate failed:", error);
    } finally {
      setGenerating(false);
    }
  }, [
    effectivePrompt,
    refImagePaths,
    composerReferences,
    model,
    aspectRatio,
    duration,
    count,
    extraParamValues,
    compareMode,
    compareModels,
  ]);

  return {
    scene,
    generatedPrompt,
    refImagePaths,
    model,
    compareMode,
    compareModels,
    promptOverride,
    setPromptOverride,
    effectivePrompt,
    status,
    hasRunningBatch,
    runningBatchCount,
    maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
    isQueueFull,
    activeBatchSummary,
    disabled,
    generate,
  };
}
