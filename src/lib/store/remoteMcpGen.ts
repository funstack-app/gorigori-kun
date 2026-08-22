import { create } from "zustand";

import {
  buildRemoteMcpParams,
  type RemoteMcpParamInput,
  type RemoteMcpToolKind,
} from "../remoteMcpTools";
import type {
  RemoteMcpDiscoveredModel,
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
  model?: RemoteMcpDiscoveredModel;
};

export type RemoteMcpRunInput = RemoteMcpParamInput & {
  kind: RemoteMcpGenerationKind;
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
  jobs: Record<string, RemoteMcpGenJob>;
  latestRequestId: Record<RemoteMcpGenerationKind, string | null>;
  validationMessage: Record<RemoteMcpGenerationKind, string | null>;
  setSelection: (
    kind: RemoteMcpGenerationKind,
    selection: RemoteMcpSelection | null,
  ) => void;
  start: (input: RemoteMcpRunInput) => Promise<RemoteMcpStartResult>;
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
    model: selection.model?.id,
    aspectRatio: input.aspectRatio,
    count: input.count,
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
    jobs: {},
    latestRequestId: { image: null, video: null },
    validationMessage: { image: null, video: null },

    setSelection: (kind, selection) =>
      set((state) => ({
        selections: {
          ...state.selections,
          [kind]: selection?.kind === kind ? selection : null,
        },
        validationMessage: { ...state.validationMessage, [kind]: null },
      })),

    start: async (input) => {
      const selection = get().selections[input.kind];
      if (!selection) {
        const message = "生成に使うツールを選択してください。";
        set((state) => ({
          validationMessage: { ...state.validationMessage, [input.kind]: message },
        }));
        return { ok: false, message };
      }
      return launch(selection, input);
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
