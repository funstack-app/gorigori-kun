import { create } from "zustand";

import {
  appServerReady,
  onAppServerStatus,
  restartAppServer,
  rpcRequest,
  startAppServer,
  type AppServerStatus,
} from "../ipc";
import { useSettings } from "./settings";
import { useToasts } from "./toasts";
import { useThreads } from "./threads";

type AppServerState = {
  status: "idle" | "starting" | "ready" | "error";
  error?: string;
  initInfo?: unknown;
  bootstrap: () => Promise<void>;
};

let listenAttached = false;

export const useAppServer = create<AppServerState>((set, get) => ({
  status: "idle",
  bootstrap: async () => {
    if (!listenAttached) {
      listenAttached = true;
      await onAppServerStatus((s: AppServerStatus) => {
        set({
          status: s.state === "ready" ? "ready" : s.state === "exited" ? "error" : "starting",
          error: s.error,
        });
        if (s.state === "exited") {
          useToasts.getState().push({
            kind: "warn",
            text: `codex app-server が終了しました — 5 秒後に再起動します${s.error ? `\n${s.error}` : ""}`,
            ttlMs: 6000,
          });
          // attempt automatic recovery
          setTimeout(() => attemptRecovery(), 5000);
        }
      });
    }
    if (get().status === "ready") return;
    if (await appServerReady()) {
      set({ status: "ready" });
      return;
    }
    set({ status: "starting", error: undefined });
    try {
      // load settings first so codexBinaryPath override applies on cold start
      await useSettings.getState().load();
      const override = useSettings.getState().settings.codexBinaryPath;
      const initInfo = await startAppServer(override);
      set({ status: "ready", initInfo });
    } catch (err) {
      set({ status: "error", error: String(err) });
    }
  },
}));

let recovering = false;
async function attemptRecovery() {
  if (recovering) return;
  recovering = true;
  const toast = useToasts.getState();
  try {
    const override = useSettings.getState().settings.codexBinaryPath;
    await restartAppServer(override);
    useAppServer.setState({ status: "ready", error: undefined });
    // Reuse the previous thread if we had one so the user keeps context.
    const tid = useThreads.getState().activeThreadId;
    if (tid) {
      try {
        await rpcRequest("thread/resume", { threadId: tid });
        toast.push({
          kind: "success",
          text: "codex を再起動して直前のスレッドを再開しました",
          ttlMs: 4000,
        });
      } catch {
        toast.push({
          kind: "warn",
          text: "codex は再起動しましたが、直前スレッドの resume に失敗しました",
          ttlMs: 6000,
        });
      }
    } else {
      toast.push({
        kind: "success",
        text: "codex を再起動しました",
        ttlMs: 3000,
      });
    }
  } catch (err) {
    useAppServer.setState({ status: "error", error: String(err) });
    toast.push({
      kind: "error",
      text: `codex の再起動に失敗しました: ${err}`,
      ttlMs: 0,
    });
  } finally {
    recovering = false;
  }
}
