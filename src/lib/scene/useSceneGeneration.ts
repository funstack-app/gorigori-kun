import { useCallback, useMemo, useState } from "react";
import { buildPrompt } from "./buildPrompt";
import {
  generateFromScene,
  type SceneGenerationCount,
  type SceneGenerationResult,
} from "./generate";
import type { SceneState } from "./types";
import { useBatches } from "../store/batches";
import { useComposer } from "../store/composer";
import { useHiggsfieldModel } from "../store/higgsfieldModel";
import { useSceneStore } from "../store/scene";
import { useScenePromptOverride } from "../store/scenePrompt";
import { useSessions } from "../store/sessions";
import { useThreads } from "../store/threads";
import { useToasts } from "../store/toasts";

export type SceneGenerationStatus =
  | { kind: "idle" }
  | { kind: "running"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export type UseSceneGenerationReturn = {
  scene: SceneState;
  generatedPrompt: string;
  refImagePaths: string[];
  count: SceneGenerationCount;
  setCount: (value: SceneGenerationCount) => void;
  promptOverride: string | null;
  setPromptOverride: (value: string | null) => void;
  effectivePrompt: string;
  status: SceneGenerationStatus;
  hasRunningBatch: boolean;
  runningBatchCount: number;
  maxConcurrentBatches: number;
  isQueueFull: boolean;
  activeBatchSummary: string | null;
  disabled: boolean;
  generate: () => Promise<SceneGenerationResult | null>;
};

const MAX_CONCURRENT_BATCHES = 3;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function useSceneSnapshot(): SceneState {
  const subjectFraming = useSceneStore((state) => state.subjectFraming);
  const lightingMood = useSceneStore((state) => state.lightingMood);
  const camera = useSceneStore((state) => state.camera);
  const style = useSceneStore((state) => state.style);
  const reference = useSceneStore((state) => state.reference);

  return useMemo(
    () => ({
      subjectFraming,
      lightingMood,
      camera,
      style,
      reference,
    }),
    [subjectFraming, lightingMood, camera, style, reference],
  );
}

export function useSceneGeneration(): UseSceneGenerationReturn {
  const scene = useSceneSnapshot();
  const generatedPrompt = useMemo(() => buildPrompt(scene), [scene]);
  // 参照画像は scene.reference（旧 §05 セクション）ではなく
  // useComposer.references（プロンプト欄上のラック）から取る。
  // §05 セクションは UI から廃止済み（Magnific 仕様に統一）。
  const composerReferences = useComposer((s) => s.references);
  const refImagePaths = useMemo(
    () => composerReferences.map((r) => r.path),
    [composerReferences],
  );

  const allBatches = useBatches((state) => state.batches);
  const runningBatches = useMemo(
    () => allBatches.filter((batch) => batch.status === "running"),
    [allBatches],
  );

  const selectedModel = useThreads((state) => state.selectedModel);
  const selectedEffort = useThreads((state) => state.selectedEffort);
  const cwd = useThreads((state) => state.cwd);
  const [count, setCount] = useState<SceneGenerationCount>(4);
  const selectedHiggsfieldModels = useHiggsfieldModel((state) => state.selectedModels);
  const selectedHiggsfield = useMemo(() => {
    const first = selectedHiggsfieldModels[0];
    if (!first) return null;
    return {
      jobSetType: first.jobSetType,
      displayName: first.displayName,
    };
  }, [selectedHiggsfieldModels]);
  const compareMode = selectedHiggsfieldModels.length >= 2;
  const generationCount = compareMode ? selectedHiggsfieldModels.length : count;

  // promptOverride はグローバルストア (useScenePromptOverride) を使う。
  // 企画タブの「採用」ボタンから外部 set できるようにするため、useState から
  // Zustand に昇格させた。
  const promptOverride = useScenePromptOverride((s) => s.value);
  const setPromptOverride = useScenePromptOverride((s) => s.set);
  const [status, setStatus] = useState<SceneGenerationStatus>({ kind: "idle" });
  const [generating, setGenerating] = useState(false);

  const effectivePrompt =
    promptOverride !== null ? promptOverride : generatedPrompt;

  const runningBatchCount = runningBatches.length;
  const hasRunningBatch = runningBatchCount > 0;
  const isQueueFull = runningBatchCount >= MAX_CONCURRENT_BATCHES;
  const disabled = generating || isQueueFull;

  const activeBatchSummary = useMemo(() => {
    const active = runningBatches[0];
    if (!active) return null;
    const completed = active.workers.filter(
      (worker) => worker.status === "completed",
    ).length;
    return `${completed}/${active.count}`;
  }, [runningBatches]);

  const generate = useCallback(async (): Promise<SceneGenerationResult | null> => {
    const prompt = effectivePrompt.trim();
    if (!prompt) {
      setStatus({ kind: "error", message: "プロンプトが空です" });
      return null;
    }

    setGenerating(true);
    setStatus({ kind: "running", message: "生成を開始しています..." });

    const tempId = `local-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt,
      references: refImagePaths.map((path) => ({
        path,
        name: basename(path),
      })),
      count: generationCount,
      provider: selectedHiggsfield ? "higgsfield" : "codex",
      modelJobSetType: compareMode ? undefined : selectedHiggsfield?.jobSetType,
      modelDisplayName: compareMode
        ? undefined
        : (selectedHiggsfield?.displayName ?? "image_gen"),
      compareMode,
      workerModels: compareMode ? selectedHiggsfieldModels : undefined,
    });

    try {
      const sess = useSessions.getState();
      const dbTurnId = await sess.recordTurn({
        sessionId: sess.activeSessionId ?? "",
        prompt,
        model: selectedModel,
        effort: selectedEffort,
        provider: selectedHiggsfield ? "higgsfield" : "codex",
        modelJobSetType: compareMode ? undefined : selectedHiggsfield?.jobSetType,
        modelDisplayName: compareMode
          ? `${selectedHiggsfieldModels.length} models compared`
          : (selectedHiggsfield?.displayName ?? "image_gen"),
        refImagePaths,
        count: generationCount,
        kind: "batch",
      });
      if (dbTurnId) sess.enqueueBatchDbTurnId(dbTurnId);

      setGenerating(false);
      const result = await generateFromScene(scene, {
        count,
        cwd,
        model: selectedModel,
        effort: selectedEffort,
        promptOverride: prompt,
        refImagePaths,
        maskPaths: refImagePaths.map(() => ""),
        higgsfield: compareMode ? undefined : (selectedHiggsfield ?? undefined),
        higgsfieldModels: compareMode ? selectedHiggsfieldModels : undefined,
      });
      const okCount = result.generatedPaths.length;
      // STΛCK 報告 (2026-05-17): 0 枚成功を success として表示すると
      // 「生成中表示が一瞬で消えたのに何も起きていない」現象になる。
      // 1 枚も生成できなかった場合は明示エラー扱いにし、toast でも
      // 通知して原因認識を促す。
      if (okCount === 0) {
        const message = `画像生成に失敗しました。${generationCount}件すべて失敗しています。Codex CLI のパス・認証状況・モデル設定を確認してください。`;
        setStatus({ kind: "error", message });
        useToasts.getState().push({
          kind: "error",
          text: message,
          ttlMs: 0, // 手動で閉じるまで残す
        });
        return result;
      }
      setStatus({
        kind: result.failedCount === 0 ? "success" : "error",
        message:
          result.failedCount === 0
            ? `${okCount}枚を生成しました`
            : `${okCount}/${generationCount}枚を生成しました（${result.failedCount}件失敗）`,
      });
      return result;
    } catch (error) {
      useBatches.getState().removeBatch(tempId);
      const errorMessage = String(error);
      setStatus({
        kind: "error",
        message: `画像生成に失敗しました: ${errorMessage}`,
      });
      // STΛCK 報告 (2026-05-17): 生成ボタン押下後 'status エリアの一瞬の表示
      // しか見えない' 問題対策。toast でも明示通知して、ユーザーが原因を
      // 確実に認識できるようにする。エラー詳細は ttl 長めで残す。
      useToasts.getState().push({
        kind: "error",
        text: `生成に失敗しました\n${errorMessage}`,
        ttlMs: 12000,
      });
      console.error("[useSceneGeneration] generate failed:", error);
      return null;
    } finally {
      setGenerating(false);
    }
  }, [
    effectivePrompt,
    refImagePaths,
    count,
    scene,
    cwd,
    selectedModel,
    selectedEffort,
    selectedHiggsfield,
    selectedHiggsfieldModels,
    compareMode,
    generationCount,
  ]);

  return {
    scene,
    generatedPrompt,
    refImagePaths,
    count,
    setCount,
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
