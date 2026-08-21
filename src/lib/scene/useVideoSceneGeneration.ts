import { useCallback, useMemo, useState } from "react";
import { buildVideoScenePrompt } from "./buildVideoScenePrompt";
import { resolveImageMentions } from "./resolveImageMentions";
import { resolveVideoRefPaths } from "./resolveVideoRefPaths";
import { higgsfieldMcp, type HiggsfieldVideoParams } from "../ipc";
import {
  isMcpAuthError,
  mcpReauthMessage,
  pushMcpReauthToast,
} from "../mcpAuthError";
import { useActiveProject } from "../store/activeProject";
import { useAuth } from "../store/auth";
import { useBatches } from "../store/batches";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";
import { useScenePromptOverride, type ScenePromptSource } from "../store/scenePrompt";
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
  setPromptOverride: (value: string | null, source?: ScenePromptSource) => void;
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
// Higgsfield MCP 比較生成の同時接続上限 (画像版 generate.ts と同じ理由: codex exec→MCP の
// OAuth セッション競合を避ける)。MCP には generateCompare が無いので各モデルを 1本ずつ生成する。
const HIGGSFIELD_COMPARE_CONCURRENCY = 2;

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
 * 1モデル分の Higgsfield MCP 動画生成引数。jobSetType→model、HiggsfieldVideoParams の
 * うち MCP が受け取るフラグ (duration/mode/resolution/sound/genre/modelVariant) だけを
 * トップレベルに展開する。quality / i2vInputField は MCP 側が使わないので渡さない
 * (参照画像は refImagePaths を MCP が media_upload→medias で自動処理する)。
 */
type HiggsfieldMcpVideoModel = {
  jobSetType: string;
  displayName: string;
} & Pick<
  HiggsfieldVideoParams,
  "duration" | "mode" | "resolution" | "sound" | "genre" | "modelVariant"
>;

/**
 * 比較生成では各モデルを生成する。尺は共通設定 (commonDuration) を各モデルの
 * 有効範囲に丸めて適用し、モデル固有パラメータ (mode/resolution/genre 等) は
 * 各モデルのおすすめ値 (param.default) を使う。比率は呼び出し側で共通適用。
 */
function toCompareModel(
  model: VideoModelDefinition,
  commonDuration: number,
): HiggsfieldMcpVideoModel {
  // 共通尺をモデルの制約に丸める (enum は最も近い許容値、integer は min/max クランプ)
  const duration =
    model.duration.kind === "enum"
      ? model.duration.values.includes(commonDuration)
        ? commonDuration
        : model.duration.default
      : Math.min(model.duration.max, Math.max(model.duration.min, commonDuration));
  // extraParams は selected を渡さず空 → 各 param.default が使われる。
  // i2vInputField / quality は MCP が使わないので落とす。
  const { quality: _quality, i2vInputField: _i2v, ...mcpParams } = paramsToVideoArgs(
    model.extraParams,
    {},
  );
  void _quality;
  void _i2v;
  return {
    jobSetType: model.jobSetType,
    displayName: model.label,
    duration,
    ...mcpParams,
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
 * higgsfieldMcp.generateBatch({ mediaType: "video" }) で動画を生成する。
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

  // i2v 元画像 + 参照ラックの両方を渡す。元画像は「動きの起点」、参照ラックは
  // 「同一性の指定 (キャラ)」で役割が違うため、どちらかを捨てるのは誤り。
  // 旧実装は sourceImagePath があると参照ラックを丸ごと捨てており、キャラ参照が
  // 属性テキストでしか効かなくなっていた (詳細と MCP 側の無制限の根拠は
  // resolveVideoRefPaths.ts のドキュメントコメント)。
  const composerReferences = useComposer((s) => s.references);
  const refImagePaths = useMemo(
    () =>
      resolveVideoRefPaths({
        sourceImagePath,
        referencePaths: composerReferences.map((r) => r.path),
      }).paths,
    [sourceImagePath, composerReferences],
  );

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
      // 比較モードは 1 モデル = 1 本。どの動画がどのモデルかタイル下に出すため
      // worker ごとのモデル名を渡す (画像側の useSceneGeneration と同型)。
      workerModels: compareMode
        ? compareModels.map((m) => ({
            jobSetType: m.jobSetType,
            displayName: m.label,
          }))
        : undefined,
    });

    try {
      // 2026-06-10 段階8: 動画生成も CLI 版 higgsfield から MCP 版 higgsfieldMcp へ移行。
      // MCP は同期的に結果を返し、generateCompare が無いので比較は各モデルを 1本ずつ
      // generateBatch して index 対応を保ったまま並べる (画像版 generate.ts と同型)。
      let result: { generatedPaths: string[]; failedCount: number; errors: string[] };

      if (compareMode) {
        const models = compareModels.map((m) => toCompareModel(m, duration));
        const perModel: { path: string; failed: boolean; error?: string }[] =
          models.map(() => ({ path: "", failed: true, error: "生成が実行されませんでした" }));
        let cursor = 0;
        const runWorker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= models.length) return;
            try {
              // 外部 provider は Rust からイベントが出ないため、リクエスト発行の
              // 直前にフロントで開始イベントを合成し、タイルを「生成中」にする
              // (2026-07-28)。比較は 1リクエスト=1モデル=1タイル。
              useBatches.getState().applyEvent({
                kind: "workerStarted",
                batchId,
                idx: i + 1,
              });
              const r = await higgsfieldMcp.generateBatch({
                prompt,
                model: models[i].jobSetType,
                count: 1,
                aspect: aspectRatio,
                refImagePaths: effectiveRefPaths,
                mediaType: "video",
                duration: models[i].duration,
                mode: models[i].mode,
                resolution: models[i].resolution,
                sound: models[i].sound,
                genre: models[i].genre,
                modelVariant: models[i].modelVariant,
              });
              const path = r.generatedPaths[0];
              if (path) {
                perModel[i] = { path, failed: false };
              } else {
                perModel[i] = {
                  path: "",
                  failed: true,
                  error: r.errors?.[0] ?? "動画生成に失敗しました",
                };
              }
            } catch (e) {
              perModel[i] = {
                path: "",
                failed: true,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          }
        };
        const concurrency = Math.min(HIGGSFIELD_COMPARE_CONCURRENCY, models.length);
        await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
        result = {
          generatedPaths: perModel.map((m) => m.path),
          failedCount: perModel.filter((m) => m.failed).length,
          errors: perModel.filter((m) => m.error).map((m) => m.error as string),
        };
      } else {
        // 単一モデル。HiggsfieldVideoParams のうち MCP が受け取るフラグだけを展開する
        // (quality / i2vInputField は MCP 側が使わない。参照画像は refImagePaths を MCP が
        // media_upload→medias で自動処理する)。
        const { quality: _q, i2vInputField: _i, ...mcpParams } = paramsToVideoArgs(
          model.extraParams,
          extraParamValues,
        );
        void _q;
        void _i;
        // 単一生成は 1リクエストが全本数を担うため、発行の瞬間に全タイルが同時に
        // 「生成中」になるのが実態 (2026-07-28)。
        for (let idx = 1; idx <= count; idx++) {
          useBatches.getState().applyEvent({
            kind: "workerStarted",
            batchId,
            idx,
          });
        }
        const r = await higgsfieldMcp.generateBatch({
          prompt,
          model: model.jobSetType,
          count,
          aspect: aspectRatio,
          refImagePaths: effectiveRefPaths,
          mediaType: "video",
          duration,
          ...mcpParams,
        });
        result = {
          generatedPaths: r.generatedPaths,
          failedCount: r.failedCount,
          errors: r.errors ?? [],
        };
      }

      if (result.failedCount > 0 || result.generatedPaths.length === 0) {
        // モデル側が返した実際の理由 (NSFW判定・制限コンテンツ等) を最優先で表示する。
        // 理由が取れない時だけ一般的な再試行ガイドにフォールバックする。
        const reasons = (result.errors ?? []).filter((r) => r && r.trim().length > 0);
        const uniqueReasons = Array.from(new Set(reasons));
        // p20 (2026-08-04): Higgsfield の認証切れ (invalid_grant 等) は生 RPC 文字列を
        // 出さず、再接続導線つきの日本語に差し替える。プロンプトを変えても直らない
        // ので、他の失敗と同じ再試行ガイドを出すのは誤り。認証切れ以外は従来どおり。
        const isAuthError = uniqueReasons.some((reason) => isMcpAuthError(reason));
        const message = isAuthError
          ? mcpReauthMessage("Higgsfield")
          : uniqueReasons.length > 0
            ? "動画生成に失敗しました。\n\n理由:\n" + uniqueReasons.join("\n\n")
            : "動画生成に失敗しました。\n" +
              "・モデル・尺・アスペクト比を変えて再試行してください\n" +
              "・i2v の場合は元画像のアスペクト比とモデルの対応を確認してください";
        // 同期生成では started/completed イベントが流れず楽観カードが残るため、
        // 全件失敗時は明示的にカードを除去する (画像版で removeBatch している経路と揃える)。
        useBatches.getState().removeBatch(batchId);
        setStatus({ kind: "error", message });
        if (isAuthError) {
          pushMcpReauthToast("Higgsfield");
        } else {
          useToasts.getState().push({ kind: "error", text: message, ttlMs: 0 });
        }
        return;
      }

      // 2026-06-10 段階8: MCP は同期的に結果を返し、CLI のようなライブ image-batch
      // イベント(started/workerCompleted/completed)が流れない。そのため楽観カードを
      // 手動で completed にし、活動中プロジェクトにも追加する(画像版 useSceneGeneration の
      // 同期 provider 経路と同型)。これが無いとカードが「生成中」のまま固まる。
      useBatches.getState().applyEvent({
        kind: "completed",
        batchId,
        generatedPaths: result.generatedPaths,
        failedCount: result.failedCount,
        provider: "higgsfield",
      });
      const activeProjectId = useActiveProject.getState().activeProjectId;
      if (activeProjectId) {
        for (const path of result.generatedPaths) {
          if (!path) continue; // 失敗枠の空文字はスキップ
          useProjects.getState().addItem(activeProjectId, { imagePath: path, prompt });
        }
      }
      setStatus({
        kind: "success",
        message: "動画を生成しました。右側のタイムラインに追加されます。",
      });
    } catch (error) {
      useBatches.getState().removeBatch(batchId);
      const errorMessage = String(error);
      // p20 (2026-08-04): 例外経路でも認証切れは生文字列を出さない (上の失敗理由
      // 経路と同じ扱い)。トークン更新は MCP 呼び出し中に例外として上がることもある。
      const isAuthError = isMcpAuthError(errorMessage);
      const message = isAuthError
        ? mcpReauthMessage("Higgsfield")
        : `動画生成に失敗しました: ${errorMessage}`;
      setStatus({ kind: "error", message });
      if (isAuthError) {
        pushMcpReauthToast("Higgsfield");
      } else {
        useToasts.getState().push({
          kind: "error",
          text: message,
          ttlMs: 12000,
        });
      }
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
