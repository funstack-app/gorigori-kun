import { create } from "zustand";

import {
  type RemoteMcpParamInput,
  type RemoteMcpToolKind,
} from "../remoteMcpTools";
import type {
  RemoteMcpCatalogModel,
  RemoteMcpModelCatalog,
} from "../remoteMcpModels";
import type {
  RemoteMcpGenEvent,
  RemoteMcpGenerateArgs,
} from "../ipc";
import { registerGeneratedMedia } from "./images";

export type RemoteMcpGenerationKind = Exclude<RemoteMcpToolKind, "other">;

export type RemoteMcpSelection = {
  providerId: string;
  providerLabel: string;
  toolName: string;
  toolTitle?: string;
  inputSchemaJson: string;
  kind: RemoteMcpGenerationKind;
  model?: RemoteMcpCatalogModel;
};

export type RemoteMcpRunInput = RemoteMcpParamInput & {
  kind: RemoteMcpGenerationKind;
  /** 内蔵モデルとの混在比較でも、接続先モデルは1モデル1本に固定する。 */
  compareEach?: boolean;
};

export type RemoteMcpGenJob = {
  requestId: string;
  providerId: string;
  providerLabel: string;
  toolName: string;
  toolTitle?: string;
  kind: RemoteMcpGenerationKind;
  phase: RemoteMcpGenEvent["phase"];
  message?: string;
  savedPaths?: string[];
  selection: RemoteMcpSelection;
  input: RemoteMcpRunInput;
  /** 保存後のライブラリ・履歴・プロジェクト登録まで試行済みか。 */
  registrationCompleted?: boolean;
  registrationWarnings?: string[];
  createdAt: number;
  updatedAt: number;
};

export type RemoteMcpStartResult =
  | { ok: true; requestId: string }
  | { ok: false; message: string; requestId?: string };

type RemoteMcpGenState = {
  selections: Record<RemoteMcpGenerationKind, RemoteMcpSelection | null>;
  /** 動画だけは同じモデル一覧から最大3件を比較選択できる。 */
  videoSelections: RemoteMcpSelection[];
  jobs: Record<string, RemoteMcpGenJob>;
  latestRequestId: Record<RemoteMcpGenerationKind, string | null>;
  validationMessage: Record<RemoteMcpGenerationKind, string | null>;
  modelCatalogs: Record<string, RemoteMcpModelCatalog>;
  setSelection: (
    kind: RemoteMcpGenerationKind,
    selection: RemoteMcpSelection | null,
  ) => void;
  setVideoSelections: (selections: RemoteMcpSelection[]) => void;
  setModelCatalog: (key: string, catalog: RemoteMcpModelCatalog) => void;
  start: (input: RemoteMcpRunInput) => Promise<RemoteMcpStartResult>;
  startSelectedVideos: (input: RemoteMcpRunInput) => Promise<RemoteMcpStartResult>;
  retry: (requestId: string) => Promise<RemoteMcpStartResult>;
  applyEvent: (event: RemoteMcpGenEvent) => void;
};

const MODEL_CATALOG_CACHE_KEY = "gori.remoteMcp.modelCatalogs.v1";

function readModelCatalogCache(): Record<string, RemoteMcpModelCatalog> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_CATALOG_CACHE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const catalogs: Record<string, RemoteMcpModelCatalog> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const catalog = value as RemoteMcpModelCatalog;
      if (!Array.isArray(catalog.models) || !catalog.providerId || !catalog.kind) continue;
      catalogs[key] = { ...catalog, loadedFromCache: true };
    }
    return catalogs;
  } catch {
    return {};
  }
}

function writeModelCatalogCache(catalogs: Record<string, RemoteMcpModelCatalog>) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(catalogs));
  } catch {
    // 保存できない環境では、その起動中のメモリ表示だけを使う。
  }
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `remote-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function friendlyRemoteMcpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const detail = raw
    .replace(/^error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) {
    return "生成に失敗しました。接続状態を確認して、もう一度お試しください。";
  }
  return `生成に失敗しました。接続状態や入力内容を確認してください。詳細: ${detail}`;
}

function validationFailure(input: RemoteMcpRunInput): string | null {
  if (!input.prompt.trim()) {
    return "プロンプトが空です。作りたい内容を入力してください。";
  }
  return null;
}

let remoteMcpGenListener: Promise<() => void> | null = null;

/** remote-mcp-gen の購読をストア内で1本だけ維持する。 */
export function ensureRemoteMcpGenListener(): Promise<() => void> {
  if (!remoteMcpGenListener) {
    const pending = import("../ipc").then(({ onRemoteMcpGen }) =>
      onRemoteMcpGen((event) => useRemoteMcpGen.getState().applyEvent(event)),
    );
    remoteMcpGenListener = pending;
    void pending.catch(() => {
      if (remoteMcpGenListener === pending) remoteMcpGenListener = null;
    });
  }
  return remoteMcpGenListener;
}

export const useRemoteMcpGen = create<RemoteMcpGenState>((set, get) => {
  const completeRegistration = async (
    requestId: string,
    selection: RemoteMcpSelection,
    input: RemoteMcpRunInput,
    savedPaths: string[],
    saveWarnings: string[] = [],
  ): Promise<void> => {
    const noun = input.kind === "video" ? "動画" : "画像";
    try {
      const refImagePaths = [
        input.startImagePath,
        input.endImagePath,
        ...(input.referenceImagePaths ?? []),
      ].filter((path): path is string => Boolean(path?.trim()));
      const registration = await registerGeneratedMedia({
        paths: savedPaths,
        mediaType: input.kind,
        prompt: input.prompt,
        providerId: selection.providerId,
        providerLabel: selection.providerLabel,
        modelId: selection.model?.id,
        modelLabel: selection.toolTitle || selection.model?.id,
        refImagePaths: [...new Set(refImagePaths)],
        durationSeconds: input.durationSeconds,
      });
      const warnings = [...saveWarnings, ...registration.warnings].filter(Boolean);
      const projectText = registration.hadActiveProject
        ? `・プロジェクト${registration.projectCount}件`
        : "";
      const message =
        warnings.length > 0
          ? `${noun}は保存しました。ライブラリ${registration.libraryCount}件・履歴${registration.historyCount}件${projectText}を登録しました。注意: ${warnings.join(" ")}`
          : `${noun}を保存し、ライブラリ${registration.libraryCount}件・履歴${registration.historyCount}件${projectText}へ登録しました。`;
      set((state) => {
        const current = state.jobs[requestId];
        if (!current) return state;
        return {
          jobs: {
            ...state.jobs,
            [requestId]: {
              ...current,
              phase: "done",
              message,
              savedPaths,
              registrationCompleted: true,
              registrationWarnings: warnings,
              updatedAt: Date.now(),
            },
          },
        };
      });
    } catch (error) {
      const warning = `${noun}は保存しましたが、ライブラリ・履歴への登録処理に失敗しました: ${String(error)}`;
      console.warn("[remote-mcp-registration]", warning);
      set((state) => {
        const current = state.jobs[requestId];
        if (!current) return state;
        return {
          jobs: {
            ...state.jobs,
            [requestId]: {
              ...current,
              phase: "done",
              message: warning,
              savedPaths,
              registrationCompleted: true,
              registrationWarnings: [warning],
              updatedAt: Date.now(),
            },
          },
        };
      });
    }
  };

  const launch = async (
    selection: RemoteMcpSelection,
    input: RemoteMcpRunInput,
  ): Promise<RemoteMcpStartResult> => {
    const validationMessage = validationFailure(input);
    if (validationMessage) {
      set((state) => ({
        validationMessage: { ...state.validationMessage, [input.kind]: validationMessage },
      }));
      return { ok: false, message: validationMessage };
    }

    const referencePaths = [
      input.startImagePath,
      input.endImagePath,
      ...(input.referenceImagePaths ?? []),
      ...(input.referenceVideoPaths ?? []),
      ...(input.motionReferencePaths ?? []),
    ].filter((path): path is string => Boolean(path?.trim()));

    const requestId = createRequestId();
    const now = Date.now();
    const job: RemoteMcpGenJob = {
      requestId,
      providerId: selection.providerId,
      providerLabel: selection.providerLabel,
      toolName: selection.toolName,
      toolTitle: selection.toolTitle,
      kind: input.kind,
      phase: "running",
      message: "生成を開始しています…",
      selection,
      input,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      jobs: { ...state.jobs, [requestId]: job },
      latestRequestId: { ...state.latestRequestId, [input.kind]: requestId },
      validationMessage: { ...state.validationMessage, [input.kind]: null },
    }));

    const args: RemoteMcpGenerateArgs = {
      requestId,
      providerId: selection.providerId,
      prompt: input.prompt,
      model: selection.model?.passModel === false ? undefined : selection.model?.id,
      durationSeconds: input.durationSeconds,
      aspect: input.aspectRatio,
      referencePaths: [...new Set(referencePaths)],
      kind: input.kind,
    };

    try {
      if (selection.providerId === "higgsfield" && input.kind === "video") {
        const { higgsfieldMcp } = await import("../ipc");
        const refImagePaths = [
          input.startImagePath,
          input.endImagePath,
          ...(input.referenceImagePaths ?? []),
        ].filter((path): path is string => Boolean(path?.trim()));
        const result = await higgsfieldMcp.generateBatch({
          prompt: input.prompt,
          model: selection.model?.passModel === false ? undefined : selection.model?.id,
          aspect: input.aspectRatio,
          count: input.count,
          refImagePaths: [...new Set(refImagePaths)],
          mediaType: "video",
          duration: input.durationSeconds,
        });
        if (result.generatedPaths.length === 0) {
          throw new Error(result.errors.join(" ") || "HiggsField の動画を保存できませんでした。");
        }
        await completeRegistration(
          requestId,
          selection,
          input,
          result.generatedPaths,
          result.errors,
        );
        return { ok: true, requestId };
      }

      // イベントを取りこぼさないよう、購読完了後にだけ生成を開始する。
      await ensureRemoteMcpGenListener();
      const { remoteMcp } = await import("../ipc");
      await remoteMcp.generate(args);
      // invoke の解決だけでは完了表示にしない。done イベントだけを完了の根拠にする。
      return { ok: true, requestId };
    } catch (error) {
      const message = friendlyRemoteMcpError(error);
      set((state) => {
        const current = state.jobs[requestId];
        if (!current) return state;
        return {
          jobs: {
            ...state.jobs,
            [requestId]: {
              ...current,
              phase: "error",
              message,
              updatedAt: Date.now(),
            },
          },
        };
      });
      return { ok: false, requestId, message };
    }
  };

  return {
    selections: { image: null, video: null },
    videoSelections: [],
    jobs: {},
    latestRequestId: { image: null, video: null },
    validationMessage: { image: null, video: null },
    modelCatalogs: readModelCatalogCache(),

    setSelection: (kind, selection) =>
      set((state) => {
        const valid = selection?.kind === kind ? selection : null;
        return {
          selections: {
            ...state.selections,
            [kind]: valid,
          },
          videoSelections:
            kind === "video" ? (valid ? [valid] : []) : state.videoSelections,
          validationMessage: { ...state.validationMessage, [kind]: null },
        };
      }),

    setVideoSelections: (selections) =>
      set((state) => {
        const valid = selections
          .filter((selection) => selection.kind === "video")
          .filter(
            (selection, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.providerId === selection.providerId &&
                  candidate.toolName === selection.toolName &&
                  candidate.model?.id === selection.model?.id,
              ) === index,
          )
          .slice(0, 3);
        return {
          videoSelections: valid,
          selections: { ...state.selections, video: valid[0] ?? null },
          validationMessage: { ...state.validationMessage, video: null },
        };
      }),

    setModelCatalog: (key, catalog) =>
      set((state) => {
        const modelCatalogs = {
          ...state.modelCatalogs,
          [key]: { ...catalog, loadedFromCache: false },
        };
        writeModelCatalogCache(modelCatalogs);
        return { modelCatalogs };
      }),

    start: async (input) => {
      const selection = get().selections[input.kind];
      if (!selection) {
        const message = "生成に使うモデルを選択してください。";
        set((state) => ({
          validationMessage: { ...state.validationMessage, [input.kind]: message },
        }));
        return { ok: false, message };
      }
      return launch(selection, input);
    },

    startSelectedVideos: async (input) => {
      const selections = get().videoSelections;
      if (input.kind !== "video" || selections.length === 0) {
        return get().start(input);
      }
      const compare = selections.length >= 2 || input.compareEach === true;
      const results = await Promise.all(
        selections.map((selection) =>
          launch(selection, compare ? { ...input, count: 1 } : input),
        ),
      );
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        return {
          ok: false,
          message: `${failed.length}/${results.length}モデルの生成を開始できませんでした。${failed
            .map((result) => (result.ok ? "" : result.message))
            .filter(Boolean)
            .join(" ")}`,
        };
      }
      return results[results.length - 1] ?? {
        ok: false,
        message: "生成に使うモデルを選択してください。",
      };
    },

    retry: async (requestId) => {
      const job = get().jobs[requestId];
      if (!job) return { ok: false, message: "再試行する生成情報が見つかりません。" };
      return launch(job.selection, job.input);
    },

    applyEvent: (event) => {
      const current = get().jobs[event.requestId];
      if (!current || current.providerId !== event.providerId) return;

      if (event.phase === "done" && event.savedPaths?.length) {
        // 同じ done が再送されても履歴 turn を二重に作らない。
        if (
          current.registrationCompleted ||
          (current.phase === "saving" && current.savedPaths?.length)
        ) {
          return;
        }
        set((state) => ({
          jobs: {
            ...state.jobs,
            [event.requestId]: {
              ...current,
              phase: "saving",
              message: "保存した生成物をライブラリ・履歴へ登録しています…",
              savedPaths: event.savedPaths,
              updatedAt: Date.now(),
            },
          },
        }));
        void completeRegistration(
          event.requestId,
          current.selection,
          current.input,
          event.savedPaths,
          event.message ? [event.message] : [],
        );
        return;
      }

      const message =
        event.phase === "error"
          ? friendlyRemoteMcpError(event.message)
          : event.message ??
            (event.phase === "saving"
              ? "生成結果を保存しています…"
              : event.phase === "done"
                ? "保存は完了しましたが、登録できる生成物が見つかりませんでした。"
                : "生成しています…");
      set((state) => ({
        jobs: {
          ...state.jobs,
          [event.requestId]: {
            ...current,
            phase: event.phase,
            message,
            savedPaths: event.savedPaths,
            registrationCompleted:
              event.phase === "done" ? true : current.registrationCompleted,
            registrationWarnings:
              event.phase === "done" && !event.savedPaths?.length
                ? [message]
                : current.registrationWarnings,
            updatedAt: Date.now(),
          },
        },
      }));
    },
  };
});

export function isRemoteMcpJobRunning(job: RemoteMcpGenJob | null): boolean {
  return job?.phase === "running" || job?.phase === "saving";
}
