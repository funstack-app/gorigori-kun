import { check } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

import {
  appServerReady,
  diagnostics,
  higgsfieldMcp,
  magnific,
  remoteMcp,
  type DiagnosticEnvironment,
  type DiagnosticNetwork,
  type HiggsfieldMcpStatus,
  type MagnificStatus,
  type RemoteMcpStatus,
} from "../ipc";

export const AUTO_DIAGNOSTICS_COOLDOWN_MS = 5 * 60 * 1000;

export type DiagnosticsRunKind = "automatic" | "manual";

export type UpdateDiagnostic =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "error"; reason: string };

export type ConnectionDiagnostic = {
  higgsfield: HiggsfieldMcpStatus;
  magnific: MagnificStatus;
  remote: RemoteMcpStatus[];
};

export type DiagnosticsRunResult =
  | { status: "completed" }
  | { status: "skipped"; reason: "cooldown" | "running" };

type DiagnosticsRunState = {
  environment: DiagnosticEnvironment | null;
  network: DiagnosticNetwork | null;
  connections: ConnectionDiagnostic | null;
  engineReady: boolean | null;
  update: UpdateDiagnostic;
  environmentError: string | null;
  networkError: string | null;
  connectionsError: string | null;
  engineError: string | null;
  running: boolean;
  lastRunAt: number | null;
  lastRunKind: DiagnosticsRunKind | null;
  lastAutomaticRunAt: number | null;
  run: (kind: DiagnosticsRunKind) => Promise<DiagnosticsRunResult>;
  checkUpdate: () => Promise<void>;
};

function safeVersion(value: string): string {
  return value.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 80) || "不明";
}

function failureReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "不明なエラー";
  return raw.replace(/\s+/g, " ").trim().slice(0, 240) || "不明なエラー";
}

export const useDiagnosticsRun = create<DiagnosticsRunState>((set, get) => ({
  environment: null,
  network: null,
  connections: null,
  engineReady: null,
  update: { kind: "unchecked" },
  environmentError: null,
  networkError: null,
  connectionsError: null,
  engineError: null,
  running: false,
  lastRunAt: null,
  lastRunKind: null,
  lastAutomaticRunAt: null,

  run: async (kind) => {
    const state = get();
    if (state.running) return { status: "skipped", reason: "running" };

    const startedAt = Date.now();
    if (
      kind === "automatic" &&
      state.lastAutomaticRunAt != null &&
      startedAt - state.lastAutomaticRunAt < AUTO_DIAGNOSTICS_COOLDOWN_MS
    ) {
      return { status: "skipped", reason: "cooldown" };
    }

    set({
      running: true,
      environmentError: null,
      networkError: null,
      connectionsError: null,
      engineError: null,
      update: { kind: "checking" },
      ...(kind === "automatic" ? { lastAutomaticRunAt: startedAt } : {}),
    });

    const [environmentResult, networkResult, connectionsResult, engineResult, updateResult] =
      await Promise.allSettled([
        Promise.resolve().then(() => diagnostics.environment()),
        Promise.resolve().then(() => diagnostics.network()),
        Promise.resolve().then(() =>
          Promise.all([higgsfieldMcp.status(), magnific.status(), remoteMcp.statusAll()]),
        ),
        Promise.resolve().then(() => appServerReady()),
        Promise.resolve().then(() => check()),
      ]);

    set({
      environment:
        environmentResult.status === "fulfilled" ? environmentResult.value : null,
      environmentError:
        environmentResult.status === "rejected"
          ? failureReason(environmentResult.reason)
          : null,
      network: networkResult.status === "fulfilled" ? networkResult.value : null,
      networkError:
        networkResult.status === "rejected" ? failureReason(networkResult.reason) : null,
      connections:
        connectionsResult.status === "fulfilled"
          ? {
              higgsfield: connectionsResult.value[0],
              magnific: connectionsResult.value[1],
              remote: connectionsResult.value[2],
            }
          : null,
      connectionsError:
        connectionsResult.status === "rejected"
          ? failureReason(connectionsResult.reason)
          : null,
      engineReady: engineResult.status === "fulfilled" ? engineResult.value : false,
      engineError:
        engineResult.status === "rejected" ? failureReason(engineResult.reason) : null,
      update:
        updateResult.status === "fulfilled"
          ? updateResult.value
            ? { kind: "available", version: safeVersion(updateResult.value.version) }
            : { kind: "current" }
          : { kind: "error", reason: failureReason(updateResult.reason) },
      lastRunAt: Date.now(),
      lastRunKind: kind,
      running: false,
    });

    return { status: "completed" };
  },

  checkUpdate: async () => {
    set({ update: { kind: "checking" } });
    try {
      const result = await check();
      set({
        update: result
          ? { kind: "available", version: safeVersion(result.version) }
          : { kind: "current" },
      });
    } catch (error) {
      set({ update: { kind: "error", reason: failureReason(error) } });
    }
  },
}));

/** 新しいエラーの記録元から呼ぶ。結果表示や通知は診断画面に任せる。 */
export function requestAutomaticDiagnostics(): Promise<DiagnosticsRunResult> {
  return useDiagnosticsRun.getState().run("automatic");
}
