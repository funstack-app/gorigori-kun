import { useCallback, useMemo, useState } from "react";
import { buildVideoScenePrompt } from "./buildVideoScenePrompt";
import { higgsfield, type HiggsfieldVideoParams } from "../ipc";
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

function paramDefaultToVideoArgs(params: VideoModelParam[]): HiggsfieldVideoParams {
  const args: HiggsfieldVideoParams = {};
  for (const param of params) {
    const value = param.default;
    if (param.name === "model" || param.name === "model_variant") {
      args.modelVariant = String(value);
    } else if (param.name === "quality") {
      args.quality = String(value);
    } else if (param.name === "mode") {
      args.mode = String(value);
    } else if (param.name === "resolution") {
      args.resolution = String(value);
    } else if (param.name === "sound") {
      args.sound = String(value);
    } else if (param.name === "genre") {
      args.genre = String(value);
    }
  }
  return args;
}

function useVideoSceneSnapshot(): VideoSceneState {
  const subject = useVideoSceneStore((state) => state.subject);
  const cameraMovement = useVideoSceneStore((state) => state.cameraMovement);
  const motion = useVideoSceneStore((state) => state.motion);
  const lighting = useVideoSceneStore((state) => state.lighting);
  const style = useVideoSceneStore((state) => state.style);
  const pacing = useVideoSceneStore((state) => state.pacing);

  return useMemo(
    () => ({ subject, cameraMovement, motion, lighting, style, pacing }),
    [subject, cameraMovement, motion, lighting, style, pacing],
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
  const model = findVideoModel(modelId) ?? VIDEO_MODELS[0];

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
    const prompt = effectivePrompt.trim();
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
    setStatus({ kind: "running", message: "動画生成を開始しています..." });

    const batchId = `local-video-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    useBatches.getState().startBatch({
      batchId,
      prompt,
      references: refImagePaths.map((path) => ({ path, name: basename(path) })),
      count: 1,
      provider: "higgsfield",
      modelJobSetType: model.jobSetType,
      modelDisplayName: model.label,
      mediaType: "video",
    });

    try {
      const result = await higgsfield.generateBatch({
        jobSetType: model.jobSetType,
        displayName: model.label,
        prompt,
        count: 1,
        aspect: aspectRatio,
        refImagePaths,
        mediaType: "video",
        duration,
        i2vInputField: model.i2vInputField,
        ...paramDefaultToVideoArgs(model.extraParams),
      });

      if (result.failedCount > 0 || result.generatedPaths.length === 0) {
        const message =
          "動画生成に失敗しました。\n" +
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
  }, [effectivePrompt, refImagePaths, model, aspectRatio, duration]);

  return {
    scene,
    generatedPrompt,
    refImagePaths,
    model,
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
