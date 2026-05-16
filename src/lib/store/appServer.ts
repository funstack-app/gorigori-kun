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
    // load settings first so codexBinaryPath override applies on cold start
    await useSettings.getState().load();
    const override = useSettings.getState().settings.codexBinaryPath;

    // 自動リトライ: 初回 handshake が transport closed 等で失敗することがある
    // (codex-app-server が stdin 準備完了する前に initialize 投げてしまう競合)。
    // 再試行で成功するパターンが大半なので、ユーザーには見せずに自動リトライする。
    const MAX_RETRIES = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const initInfo = await startAppServer(override);
        set({ status: "ready", initInfo, error: undefined });
        return;
      } catch (err) {
        lastErr = err;
        const msg = String(err);
        // 既に起動済みなら次回ループで appServerReady が拾うので break
        if (msg.includes("already running")) {
          if (await appServerReady()) {
            set({ status: "ready", error: undefined });
            return;
          }
        }
        // 次の試行まで少し待つ (子プロセスが完全に落ちる/起動する猶予)
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
    set({ status: "error", error: String(lastErr) });
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
