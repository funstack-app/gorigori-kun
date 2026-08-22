import { create } from "zustand";

import {
  buildRemoteMcpParams,
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
  paramsJson: string;
  selection: RemoteMcpSelection;
  input: RemoteMcpRunInput;
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

function validationFailure(
  selection: RemoteMcpSelection,
  input: RemoteMcpRunInput,
): { ok: false; message: string } | { ok: true; paramsJson: string } {
  if (!input.prompt.trim()) {
    return { ok: false, message: "プロンプトが空です。作りたい内容を入力してください。" };
  }
  const built = buildRemoteMcpParams(selection.inputSchemaJson, {
    prompt: input.prompt,
    model: selection.model?.passModel === false ? undefined : selection.model?.id,
    aspectRatio: input.aspectRatio,
    count: input.count,
    durationSeconds: input.durationSeconds,
    startImagePath: input.startImagePath,
    endImagePath: input.endImagePath,
    referenceImagePaths: input.referenceImagePaths,
    referenceVideoPaths: input.referenceVideoPaths,
    motionReferencePaths: input.motionReferencePaths,
  });
  if (built.schemaError) return { ok: false, message: built.schemaError };
  if (built.missingRequired.length > 0) {
    return {
      ok: false,
      message: `このツールには追加の必須入力が必要です: ${built.missingRequired.join("、")}`,
    };
  }
  return { ok: true, paramsJson: built.paramsJson };
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
  const launch = async (
    selection: RemoteMcpSelection,
    input: RemoteMcpRunInput,
  ): Promise<RemoteMcpStartResult> => {
    const validation = validationFailure(selection, input);
    if (!validation.ok) {
      set((state) => ({
        validationMessage: { ...state.validationMessage, [input.kind]: validation.message },
      }));
      return { ok: false, message: validation.message };
    }

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
      paramsJson: validation.paramsJson,
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
      toolName: selection.toolName,
      paramsJson: validation.paramsJson,
      kind: input.kind,
    };

    try {
      if (selection.providerId === "magnific" && input.kind === "video") {
        const { magnific } = await import("../ipc");
        const localImagePaths = [
          input.startImagePath,
          input.endImagePath,
          ...(input.referenceImagePaths ?? []),
        ].filter((path): path is string => Boolean(path?.trim()));
        const result = await magnific.videoGenerate({
          paramsJson: validation.paramsJson,
          localImagePaths: [...new Set(localImagePaths)],
        });
        if (result.generatedPaths.length === 0) {
          throw new Error(result.errors.join(" ") || "Magnific の動画を保存できませんでした。");
        }
        set((state) => {
          const current = state.jobs[requestId];
          if (!current) return state;
          return {
            jobs: {
              ...state.jobs,
              [requestId]: {
                ...current,
                phase: "done",
                message:
                  result.errors.length > 0
                    ? `保存は完了しました。一部の処理に失敗しました: ${result.errors.join(" ")}`
                    : "保存が完了しました。",
                savedPaths: result.generatedPaths,
                updatedAt: Date.now(),
              },
            },
          };
        });
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
    modelCatalogs: {},

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
      set((state) => ({ modelCatalogs: { ...state.modelCatalogs, [key]: catalog } })),

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

    applyEvent: (event) =>
      set((state) => {
        const current = state.jobs[event.requestId];
        if (!current || current.providerId !== event.providerId) return state;
        const message =
          event.phase === "error"
            ? friendlyRemoteMcpError(event.message)
            : event.message ??
              (event.phase === "saving"
                ? "生成結果を保存しています…"
                : event.phase === "done"
                  ? "保存が完了しました。"
                  : "生成しています…");
        return {
          jobs: {
            ...state.jobs,
            [event.requestId]: {
              ...current,
              phase: event.phase,
              message,
              savedPaths: event.savedPaths,
              updatedAt: Date.now(),
            },
          },
        };
      }),
  };
});

export function isRemoteMcpJobRunning(job: RemoteMcpGenJob | null): boolean {
  return job?.phase === "running" || job?.phase === "saving";
}
