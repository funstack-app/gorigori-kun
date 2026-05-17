import { useCallback, useMemo, useState } from "react";
import { buildPrompt } from "./buildPrompt";
import {
  generateFromScene,
  type SceneGenerationCount,
  type SceneGenerationResult,
} from "./generate";
import type { SceneState } from "./types";
import { useAuth } from "../store/auth";
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
  // generating: disabled 判定からは外したが、generate() 内で多重実行ガードに
  // 引き続き使う (preflight 直後に二重呼びされた場合の保護)。
  // 型エラー抑制のため _generating で受ける (未参照警告を黙らせる)。
  const [_generating, setGenerating] = useState(false);
  void _generating;

  const effectivePrompt =
    promptOverride !== null ? promptOverride : generatedPrompt;

  const runningBatchCount = runningBatches.length;
  const hasRunningBatch = runningBatchCount > 0;
  const isQueueFull = runningBatchCount >= MAX_CONCURRENT_BATCHES;
  // STΛCK 報告 (2026-05-17 v0.6.11): 生成ボタンを押すと画面がちらつく問題。
  // 原因: ローカル `generating` ステートと `runningBatches`(notification 経由)
  // が時間差で更新され、ボタンが disabled→enabled→disabled と細かく
  // 切り替わってレイアウト再計算が走っていた。
  // 修正: disabled 判定をキュー満杯チェックのみに変える。
  // generating 状態自体は status メッセージ等で引き続き使うが、
  // disabled 判定からは外して入力UIのちらつきを止める。
  const disabled = isQueueFull;

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

    // STΛCK 報告 (2026-05-17 v0.6.7): 認証未完了で生成すると
    // 「アスペクト比エラー」と誤表示されて原因特定に30分かかった。
    // 生成開始前に Codex 認証を再チェックし、未認証なら明確な
    // メッセージで toast 表示して止める。
    const authState = useAuth.getState();
    // 最新の認証状態を取り直す（OAuth完了直後の refresh 遅延対策）
    await authState.refresh();
    if (!useAuth.getState().account) {
      const message =
        "ChatGPT にログインしていないため、生成できません。\n" +
        "左下の「ログイン」ボタンから ChatGPT にログインしてください。";
      setStatus({ kind: "error", message });
      useToasts.getState().push({
        kind: "error",
        text: message,
        ttlMs: 0,
      });
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
        // STΛCK 報告 (2026-05-17 第2版): 元の文言は「Codex CLI のパス」を
        // 決め打ちで示していたが、実態は Higgsfield API のアスペクト比違反
        // 等のモデル個別エラーが多い。原因を断定せずに「選択中の組み合わせ」
        // を疑うよう促す表現に変更。
        const message =
          `画像生成に失敗しました（${generationCount}件すべて失敗）。\n` +
          `多くの場合、選んだモデルと対応していないアスペクト比が原因です。\n` +
          `・アスペクト比を 16:9 / 1:1 / 9:16 に変えて再試行してみてください\n` +
          `・別のモデルに切り替えても改善する場合があります\n` +
          `・それでも失敗する場合は、ログインや接続を見直してください`;
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
