import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appServerReady: vi.fn(),
  check: vi.fn(),
  environment: vi.fn(),
  higgsfieldStatus: vi.fn(),
  magnificStatus: vi.fn(),
  network: vi.fn(),
  remoteStatusAll: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));

vi.mock("../src/lib/ipc", () => ({
  appServerReady: mocks.appServerReady,
  diagnostics: {
    environment: mocks.environment,
    network: mocks.network,
  },
  higgsfieldMcp: { status: mocks.higgsfieldStatus },
  magnific: { status: mocks.magnificStatus },
  remoteMcp: { statusAll: mocks.remoteStatusAll },
}));

import {
  AUTO_DIAGNOSTICS_COOLDOWN_MS,
  useDiagnosticsRun,
} from "../src/lib/store/diagnosticsRun";

const initialState = useDiagnosticsRun.getState();
const environmentResult = {
  appVersion: "1.0.0",
  os: "macos",
  arch: "aarch64",
  codex: { status: "ok", version: "1.0.0" },
  ffmpeg: { status: "ok", version: "7.0" },
  disk: { status: "ok", freeBytes: 100, reason: "" },
  temporaryStorage: { status: "ok", totalBytes: 0, warning: false, errorCount: 0 },
  reportText: "report",
} as const;
const networkResult = {
  codex: { id: "codex", label: "Codex", status: "ok" },
  updates: { id: "updates", label: "更新", status: "ok" },
} as const;
const connected = { registered: true, authenticated: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-22T09:00:00.000Z"));
  useDiagnosticsRun.setState(initialState, true);
  mocks.environment.mockReset().mockResolvedValue(environmentResult);
  mocks.network.mockReset().mockResolvedValue(networkResult);
  mocks.higgsfieldStatus.mockReset().mockResolvedValue(connected);
  mocks.magnificStatus.mockReset().mockResolvedValue(connected);
  mocks.remoteStatusAll.mockReset().mockResolvedValue([]);
  mocks.appServerReady.mockReset().mockResolvedValue(true);
  mocks.check.mockReset().mockResolvedValue(null);
});

describe("diagnosticsRun", () => {
  it("自動診断は5分以内の再実行を抑え、5分後は再実行する", async () => {
    const first = await useDiagnosticsRun.getState().run("automatic");

    expect(first).toEqual({ status: "completed" });
    expect(mocks.environment).toHaveBeenCalledTimes(1);
    expect(useDiagnosticsRun.getState()).toMatchObject({
      environment: environmentResult,
      network: networkResult,
      lastRunKind: "automatic",
      running: false,
    });

    vi.advanceTimersByTime(AUTO_DIAGNOSTICS_COOLDOWN_MS - 1);
    const skipped = await useDiagnosticsRun.getState().run("automatic");
    expect(skipped).toEqual({ status: "skipped", reason: "cooldown" });
    expect(mocks.environment).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const afterCooldown = await useDiagnosticsRun.getState().run("automatic");
    expect(afterCooldown).toEqual({ status: "completed" });
    expect(mocks.environment).toHaveBeenCalledTimes(2);
  });

  it("実行中は手動・自動どちらの多重起動も始めない", async () => {
    let finishEnvironment: ((value: typeof environmentResult) => void) | undefined;
    mocks.environment.mockReturnValueOnce(
      new Promise((resolve) => {
        finishEnvironment = resolve;
      }),
    );

    const firstRun = useDiagnosticsRun.getState().run("automatic");
    expect(useDiagnosticsRun.getState().running).toBe(true);

    await expect(useDiagnosticsRun.getState().run("manual")).resolves.toEqual({
      status: "skipped",
      reason: "running",
    });
    await expect(useDiagnosticsRun.getState().run("automatic")).resolves.toEqual({
      status: "skipped",
      reason: "running",
    });
    expect(mocks.environment).toHaveBeenCalledTimes(1);

    finishEnvironment?.(environmentResult);
    await firstRun;
    expect(useDiagnosticsRun.getState().running).toBe(false);
  });
});
