import { create } from "zustand";

import { appendVideoGenerationRevision } from "../film/videoGenPrompts";
import {
  findVideoServiceProfile,
  type VideoServiceId,
} from "../film/serviceProfiles";
import { higgsfieldMcp } from "../ipc";
import {
  isMcpAuthError,
  mcpReauthMessage,
  pushMcpReauthToast,
} from "../mcpAuthError";
import { paramsToVideoArgs } from "../scene/useVideoSceneGeneration";
import {
  clampDurationForModel,
  findVideoModel,
  type VideoModelId,
} from "../videoModels";
import { useActiveProject } from "./activeProject";
import { useAuth } from "./auth";
import { useBatches } from "./batches";
import { useProjects } from "./projects";
import { useToasts } from "./toasts";

export const HIGGSFIELD_VIDEO_MODEL_BY_SERVICE: Readonly<
  Record<VideoServiceId, VideoModelId | null>
> = {
  "seedance-2.5": null,
  "seedance-2.0": "seedance_2_0",
  "kling-3.0": "kling3_0",
  "veo-3.1": "veo3_1",
  "minimax-h3": null,
  flux3: null,
};

export type FilmGenReferenceSource = "asset" | "character" | "library" | "local";

export type FilmGenReference = {
  id: string;
  path: string;
  name: string;
  source: FilmGenReferenceSource;
  assetId?: string;
};

export type FilmGenBlockStatus = "idle" | "running" | "review" | "adopted" | "error";

export type FilmGenBlockRun = {
  projectId: string;
  blockId: string;
  promptDraft: string;
  savedPrompt: string;
  references: FilmGenReference[];
  status: FilmGenBlockStatus;
  progress: number;
  progressLabel: string;
  resultPath: string | null;
  error: string | null;
  lastNgReason: string;
};

export type FilmGenConnectionStatus = "unchecked" | "checking" | "ready" | "disconnected" | "error";

export type FilmGenRequest = {
  projectId: string;
  blockId: string;
  serviceId: string;
  durationSeconds: number;
};

type InitializeFilmGenBlock = {
  projectId: string;
  blockId: string;
  prompt: string;
  references: FilmGenReference[];
  adoptedPath?: string | null;
};

type FilmGenRunState = {
  runs: Record<string, FilmGenBlockRun>;
  connectionStatus: FilmGenConnectionStatus;
  connectionReason: string | null;
  initializeBlock: (input: InitializeFilmGenBlock) => void;
  setPromptDraft: (projectId: string, blockId: string, prompt: string) => void;
  savePrompt: (projectId: string, blockId: string) => boolean;
  replaceReference: (
    projectId: string,
    blockId: string,
    index: number,
    reference: FilmGenReference,
  ) => void;
  removeReference: (projectId: string, blockId: string, index: number) => void;
  setImportedResult: (projectId: string, blockId: string, path: string) => void;
  setNgReason: (projectId: string, blockId: string, reason: string) => void;
  refreshConnection: () => Promise<void>;
  generate: (request: FilmGenRequest) => Promise<string | null>;
  retry: (request: FilmGenRequest, reason: string) => Promise<string | null>;
  markAdopted: (projectId: string, blockId: string) => void;
};

export function filmGenRunKey(projectId: string, blockId: string): string {
  return `${projectId}\u0000${blockId}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/u).pop() || path;
}

function makeReferenceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `film-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createFilmGenReference(
  path: string,
  name: string,
  source: FilmGenReferenceSource,
  assetId?: string,
): FilmGenReference {
  return {
    id: makeReferenceId(),
    path,
    name,
    source,
    ...(assetId ? { assetId } : {}),
  };
}

export function isPacketService(serviceId: string): boolean {
  const profile = findVideoServiceProfile(serviceId);
  return profile ? HIGGSFIELD_VIDEO_MODEL_BY_SERVICE[profile.id] === null : false;
}

export function getFilmGenerationDisabledReason(input: {
  run: FilmGenBlockRun;
  serviceId: string;
  durationSeconds: number;
  connectionStatus: FilmGenConnectionStatus;
}): string | null {
  const profile = findVideoServiceProfile(input.serviceId);
  if (!profile) return `${input.serviceId}は⑤映像づくりに未登録です。`;
  if (isPacketService(profile.id)) {
    if (!input.run.savedPrompt.trim()) return "合成プロンプトを保存してください。";
    if (input.run.promptDraft.trim() !== input.run.savedPrompt.trim()) {
      return "合成プロンプトに未保存の変更があります。";
    }
    if (profile.maxBlockSeconds !== null && input.durationSeconds > profile.maxBlockSeconds) {
      return `${profile.label}は1ブロック${profile.maxBlockSeconds}秒までです。現在は${input.durationSeconds}秒です。`;
    }
    const referenceCount = input.run.references.length;
    if (!profile.referenceRules && referenceCount > 0) {
      return `${profile.label}の参照条件は未取得です。参照画像を外すと文章だけで生成できます。`;
    }
    const imageLimit = profile.referenceRules?.limits.images ?? null;
    if (imageLimit !== null && referenceCount > imageLimit) {
      return `${profile.label}は参照画像${imageLimit}枚までです。現在${referenceCount}枚です。`;
    }
    const totalLimit = profile.referenceRules?.limits.total ?? null;
    if (totalLimit !== null && referenceCount > totalLimit) {
      return `${profile.label}は参照素材を合計${totalLimit}点まで渡せます。現在${referenceCount}点です。`;
    }
    return null;
  }
  const modelId = HIGGSFIELD_VIDEO_MODEL_BY_SERVICE[profile.id];
  if (!modelId) {
    return `${profile.label}に対応するHiggsfieldモデルIDが既存の動画生成表にありません。対応を確認できるまで実行しません。`;
  }
  const model = findVideoModel(modelId);
  if (!model) return `${profile.label}のHiggsfieldモデル設定を確認できません。`;
  if (input.connectionStatus === "unchecked" || input.connectionStatus === "checking") {
    return "Higgsfieldの接続を確認しています。";
  }
  if (input.connectionStatus === "disconnected" || input.connectionStatus === "error") {
    return "Higgsfieldが未接続です。設定 > 接続先から接続してください。";
  }
  if (input.run.status === "running") return "このブロックは生成中です。";
  if (!input.run.savedPrompt.trim()) return "合成プロンプトを保存してください。";
  if (input.run.promptDraft.trim() !== input.run.savedPrompt.trim()) {
    return "合成プロンプトに未保存の変更があります。";
  }
  if (profile.maxBlockSeconds !== null && input.durationSeconds > profile.maxBlockSeconds) {
    return `${profile.label}は1ブロック${profile.maxBlockSeconds}秒までです。現在は${input.durationSeconds}秒です。`;
  }
  if (model.duration.kind === "integer" && input.durationSeconds > model.duration.max) {
    return `既存のHiggsfield ${model.label}経路は${model.duration.max}秒までです。現在は${input.durationSeconds}秒です。`;
  }
  if (model.duration.kind === "integer" && input.durationSeconds < model.duration.min) {
    return `既存のHiggsfield ${model.label}経路は${model.duration.min}秒からです。現在は${input.durationSeconds}秒です。`;
  }
  if (model.duration.kind === "enum" && !model.duration.values.includes(input.durationSeconds)) {
    return `既存のHiggsfield ${model.label}経路で選べる尺は${model.duration.values.join("・")}秒です。現在は${input.durationSeconds}秒です。`;
  }
  const referenceCount = input.run.references.length;
  if (!profile.referenceRules && referenceCount > 0) {
    return `${profile.label}の参照条件は未取得です。参照画像を外すと文章だけで生成できます。`;
  }
  const imageLimit = profile.referenceRules?.limits.images ?? null;
  if (imageLimit !== null && referenceCount > imageLimit) {
    return `${profile.label}は参照画像${imageLimit}枚までです。現在${referenceCount}枚です。`;
  }
  const totalLimit = profile.referenceRules?.limits.total ?? null;
  if (totalLimit !== null && referenceCount > totalLimit) {
    return `${profile.label}は参照素材を合計${totalLimit}点まで渡せます。現在${referenceCount}点です。`;
  }
  return null;
}

let connectionPromise: Promise<void> | null = null;

async function performGeneration(
  get: () => FilmGenRunState,
  set: (
    update:
      | Partial<FilmGenRunState>
      | ((state: FilmGenRunState) => Partial<FilmGenRunState>),
  ) => void,
  request: FilmGenRequest,
): Promise<string | null> {
  const key = filmGenRunKey(request.projectId, request.blockId);
  const run = get().runs[key];
  if (!run) throw new Error("このブロックの生成準備がまだできていません");
  const disabledReason = getFilmGenerationDisabledReason({
    run,
    serviceId: request.serviceId,
    durationSeconds: request.durationSeconds,
    connectionStatus: get().connectionStatus,
  });
  if (disabledReason) throw new Error(disabledReason);

  const profile = findVideoServiceProfile(request.serviceId);
  const modelId = profile ? HIGGSFIELD_VIDEO_MODEL_BY_SERVICE[profile.id] : null;
  const model = modelId ? findVideoModel(modelId) : undefined;
  if (!profile || !modelId || !model) throw new Error("動画モデルの対応を確認できません");

  const runningBatchCount = useBatches
    .getState()
    .batches.filter((batch) => batch.status === "running").length;
  if (runningBatchCount >= 3) {
    throw new Error("同時に作れる動画は3本までです。進行中の動画が終わってからお試しください");
  }

  const prompt = run.savedPrompt.trim();
  const referencePaths = run.references.map((reference) => reference.path);
  set((state) => ({
    runs: {
      ...state.runs,
      [key]: {
        ...state.runs[key],
        status: "running",
        progress: 0.1,
        progressLabel: "ログインと接続を確認しています",
        resultPath: null,
        error: null,
      },
    },
  }));

  const batchId = `film-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let batchStarted = false;
  try {
    await useAuth.getState().refresh({ silent: true });
    if (!useAuth.getState().account) {
      throw new Error("ChatGPTにログインしていないため生成できません。左下のログインから接続してください。");
    }
    const connection = await higgsfieldMcp.status();
    if (!connection.registered || !connection.authenticated) {
      set({ connectionStatus: "disconnected", connectionReason: "Higgsfieldが未接続です" });
      throw new Error("Higgsfieldが未接続です。設定 > 接続先から接続してください。");
    }

    const duration = clampDurationForModel(modelId, request.durationSeconds);
    const { quality: _quality, i2vInputField: _i2v, ...modelParams } = paramsToVideoArgs(
      model.extraParams,
      {},
    );
    void _quality;
    void _i2v;

    useBatches.getState().startBatch({
      batchId,
      prompt,
      references: referencePaths.map((path) => ({ path, name: basename(path) })),
      count: 1,
      provider: "higgsfield",
      modelJobSetType: model.jobSetType,
      modelDisplayName: model.label,
      mediaType: "video",
    });
    batchStarted = true;
    useBatches.getState().applyEvent({ kind: "workerStarted", batchId, idx: 1 });
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: {
          ...state.runs[key],
          progress: 0.35,
          progressLabel: "Higgsfieldで動画を作っています",
        },
      },
    }));

    const result = await higgsfieldMcp.generateBatch({
      prompt,
      model: model.jobSetType,
      count: 1,
      aspect: model.defaultAspectRatio,
      refImagePaths: referencePaths,
      mediaType: "video",
      duration,
      ...modelParams,
    });
    const resultPath = result.generatedPaths.find((path) => Boolean(path?.trim())) ?? null;
    if (result.failedCount > 0 || !resultPath) {
      const reasons = Array.from(new Set(result.errors.filter((reason) => reason?.trim())));
      throw new Error(reasons.join("\n") || "動画が完成しませんでした");
    }

    useBatches.getState().applyEvent({
      kind: "completed",
      batchId,
      generatedPaths: result.generatedPaths,
      failedCount: result.failedCount,
      provider: "higgsfield",
    });
    const activeProjectId = useActiveProject.getState().activeProjectId;
    if (activeProjectId) {
      useProjects.getState().addItem(activeProjectId, { imagePath: resultPath, prompt });
    }
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: {
          ...state.runs[key],
          status: "review",
          progress: 1,
          progressLabel: "完成。内容を確認してください",
          resultPath,
          error: null,
          lastNgReason: "",
        },
      },
    }));
    return resultPath;
  } catch (error) {
    if (batchStarted) useBatches.getState().removeBatch(batchId);
    const raw = error instanceof Error ? error.message : String(error);
    const authError = isMcpAuthError(raw);
    const message = authError ? mcpReauthMessage("Higgsfield") : raw;
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: {
          ...state.runs[key],
          status: "error",
          progress: 0,
          progressLabel: "生成できませんでした",
          resultPath: null,
          error: message,
        },
      },
    }));
    if (authError) pushMcpReauthToast("Higgsfield");
    else useToasts.getState().push({ kind: "error", text: message, ttlMs: 8000 });
    return null;
  }
}

/**
 * タブを離れても走行状態を残す、ディスク保存しないモジュールストア。
 * Higgsfield MCPは同期結果を返し完了イベントを出さないため、別のイベント購読は作らない。
 */
export const useFilmGenRun = create<FilmGenRunState>((set, get) => ({
  runs: {},
  connectionStatus: "unchecked",
  connectionReason: null,

  initializeBlock: (input) => {
    const key = filmGenRunKey(input.projectId, input.blockId);
    set((state) => {
      const current = state.runs[key];
      if (current) {
        if (!input.adoptedPath || current.status === "adopted") return state;
        return {
          runs: {
            ...state.runs,
            [key]: {
              ...current,
              status: "adopted",
              resultPath: input.adoptedPath,
              progress: 1,
              progressLabel: "採用済み",
            },
          },
        };
      }
      return {
        runs: {
          ...state.runs,
          [key]: {
            projectId: input.projectId,
            blockId: input.blockId,
            promptDraft: input.prompt,
            savedPrompt: "",
            references: input.references,
            status: input.adoptedPath ? "adopted" : "idle",
            progress: input.adoptedPath ? 1 : 0,
            progressLabel: input.adoptedPath ? "採用済み" : "未生成",
            resultPath: input.adoptedPath ?? null,
            error: null,
            lastNgReason: "",
          },
        },
      };
    });
  },

  setPromptDraft: (projectId, blockId, promptDraft) => {
    const key = filmGenRunKey(projectId, blockId);
    set((state) => {
      const current = state.runs[key];
      return current
        ? { runs: { ...state.runs, [key]: { ...current, promptDraft } } }
        : state;
    });
  },

  savePrompt: (projectId, blockId) => {
    const key = filmGenRunKey(projectId, blockId);
    const current = get().runs[key];
    const savedPrompt = current?.promptDraft.trim() ?? "";
    if (!current || !savedPrompt) return false;
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: { ...state.runs[key], promptDraft: savedPrompt, savedPrompt },
      },
    }));
    return true;
  },

  replaceReference: (projectId, blockId, index, reference) => {
    const key = filmGenRunKey(projectId, blockId);
    set((state) => {
      const current = state.runs[key];
      if (!current) return state;
      const references = [...current.references];
      if (index >= 0 && index < references.length) references[index] = reference;
      else references.push(reference);
      return { runs: { ...state.runs, [key]: { ...current, references } } };
    });
  },

  removeReference: (projectId, blockId, index) => {
    const key = filmGenRunKey(projectId, blockId);
    set((state) => {
      const current = state.runs[key];
      if (!current) return state;
      return {
        runs: {
          ...state.runs,
          [key]: {
            ...current,
            references: current.references.filter((_, currentIndex) => currentIndex !== index),
          },
        },
      };
    });
  },

  setImportedResult: (projectId, blockId, path) => {
    const key = filmGenRunKey(projectId, blockId);
    const resultPath = path.trim();
    if (!resultPath) return;
    set((state) => {
      const current = state.runs[key];
      return current
        ? {
            runs: {
              ...state.runs,
              [key]: {
                ...current,
                status: "review",
                progress: 0,
                progressLabel: "",
                resultPath,
                error: null,
                lastNgReason: "",
              },
            },
          }
        : state;
    });
  },

  setNgReason: (projectId, blockId, lastNgReason) => {
    const key = filmGenRunKey(projectId, blockId);
    set((state) => {
      const current = state.runs[key];
      return current
        ? { runs: { ...state.runs, [key]: { ...current, lastNgReason } } }
        : state;
    });
  },

  refreshConnection: async () => {
    if (connectionPromise) return connectionPromise;
    set({ connectionStatus: "checking", connectionReason: null });
    connectionPromise = (async () => {
      try {
        const status = await higgsfieldMcp.status();
        set({
          connectionStatus: status.registered && status.authenticated ? "ready" : "disconnected",
          connectionReason: status.registered && status.authenticated
            ? null
            : "Higgsfieldが未接続です",
        });
      } catch (error) {
        set({ connectionStatus: "error", connectionReason: String(error) });
      } finally {
        connectionPromise = null;
      }
    })();
    return connectionPromise;
  },

  generate: (request) => performGeneration(get, set, request),

  retry: async (request, reason) => {
    const key = filmGenRunKey(request.projectId, request.blockId);
    const current = get().runs[key];
    if (!current?.resultPath) throw new Error("やり直す動画がありません");
    const lastNgReason = reason.trim();
    const revisedPrompt = appendVideoGenerationRevision(current.savedPrompt, lastNgReason);
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: {
          ...state.runs[key],
          promptDraft: revisedPrompt,
          savedPrompt: revisedPrompt,
          lastNgReason,
          status: "idle",
          progress: 0,
          progressLabel: "不採用理由を反映しました",
          resultPath: null,
          error: null,
        },
      },
    }));
    if (isPacketService(request.serviceId)) return null;
    return performGeneration(get, set, request);
  },

  markAdopted: (projectId, blockId) => {
    const key = filmGenRunKey(projectId, blockId);
    set((state) => {
      const current = state.runs[key];
      return current
        ? {
            runs: {
              ...state.runs,
              [key]: {
                ...current,
                status: "adopted",
                progress: 1,
                progressLabel: "採用済み",
              },
            },
          }
        : state;
    });
  },
}));
