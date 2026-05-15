import { useEffect, useState, type PropsWithChildren } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useAppServer } from "../lib/store/appServer";
import { useAuth } from "../lib/store/auth";
import { LoginPanel } from "./LoginPanel";

type Diagnostics = {
  os: string;
  arch: string;
  appVersion: string;
  resolvedCodexPath: string | null;
  codexPathExists: boolean;
  currentExe: string | null;
  logDir: string | null;
};

export function AuthGate({ children }: PropsWithChildren) {
  const appServer = useAppServer();
  const auth = useAuth();

  useEffect(() => {
    appServer.bootstrap();
    // listeners + initial fetch are wired together once app-server is ready
  }, []);

  useEffect(() => {
    if (appServer.status === "ready") {
      auth.attachListeners().then(() => auth.refresh());
    }
  }, [appServer.status]);

  if (appServer.status === "starting" || appServer.status === "idle") {
    return <Splash text="codex app-server を起動中..." />;
  }
  if (appServer.status === "error") {
    return <ErrorSplash error={appServer.error} onRetry={() => appServer.bootstrap()} />;
  }
  if (auth.loading) {
    return <Splash text="認証情報を確認中..." />;
  }
  if (!auth.account) {
    return (
      <div className="flex min-h-full items-center justify-center bg-stone-100 p-6">
        <LoginPanel />
      </div>
    );
  }
  return <>{children}</>;
}

function Splash({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-stone-100 p-6 text-center">
      <div className="rounded-md border border-neutral-200 bg-white px-5 py-4 shadow-sm">
        <div className="mx-auto mb-3 h-8 w-8 animate-pulse rounded-md bg-neutral-950 text-xs font-black leading-8 text-lime-300">
          GG
        </div>
        <p className="text-sm font-medium text-neutral-800">{text}</p>
        {sub && <pre className="mt-3 max-w-lg whitespace-pre-wrap text-xs text-rose-600">{sub}</pre>}
      </div>
    </div>
  );
}

function ErrorSplash({ error, onRetry }: { error?: string; onRetry: () => void }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<Diagnostics>("codex_diagnostics")
      .then((d) => setDiag(d))
      .catch((e) => setDiagErr(String(e)));
  }, []);

  const fullReport = buildReport(error, diag, diagErr);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(fullReport);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard が無い (古い Edge 等) の保険: textarea で select
      const ta = document.createElement("textarea");
      ta.value = fullReport;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const openLogDir = async () => {
    if (!diag?.logDir) return;
    try {
      await openPath(diag.logDir);
    } catch (e) {
      console.error("failed to open log dir:", e);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-stone-100 p-6">
      <div className="w-full max-w-2xl rounded-md border border-rose-200 bg-white shadow-sm">
        <div className="border-b border-rose-100 bg-rose-50/50 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-rose-600 text-center text-xs font-black leading-8 text-white">
              ⚠
            </div>
            <div>
              <p className="text-sm font-semibold text-rose-900">
                Codex app-server を起動できませんでした
              </p>
              <p className="text-xs text-rose-700">
                エラー詳細を STΛCK に送ってください。下の「全部コピー」を押して Discord に貼り付けるだけです。
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-500">
            エラー内容
          </h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-800">
{error || "(エラーメッセージなし)"}
          </pre>

          <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wider text-neutral-500">
            環境情報
          </h3>
          <pre className="whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-800">
{diag
  ? `OS: ${diag.os} / ${diag.arch}
アプリ: v${diag.appVersion}
codex バイナリ: ${diag.resolvedCodexPath || "(見つからない)"}
バイナリ存在: ${diag.codexPathExists ? "あり" : "なし"}
アプリ exe: ${diag.currentExe || "(取得失敗)"}
ログディレクトリ: ${diag.logDir || "(取得失敗)"}`
  : diagErr
    ? `診断情報の取得失敗: ${diagErr}`
    : "診断情報を取得中..."}
          </pre>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-neutral-200 bg-neutral-50/50 px-5 py-3">
          <button
            type="button"
            onClick={copyAll}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            {copied ? "✓ コピーしました" : "全部コピー (Discord に貼って STΛCK へ送信)"}
          </button>
          {diag?.logDir && (
            <button
              type="button"
              onClick={openLogDir}
              className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              ログフォルダを開く
            </button>
          )}
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
          >
            再試行
          </button>
        </div>
      </div>
    </div>
  );
}

function buildReport(error: string | undefined, diag: Diagnostics | null, diagErr: string | null): string {
  const lines: string[] = [];
  lines.push("=== GORI GORI KUN エラーレポート ===");
  lines.push(`日時: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("--- 環境情報 ---");
  if (diag) {
    lines.push(`OS: ${diag.os} / ${diag.arch}`);
    lines.push(`アプリ: v${diag.appVersion}`);
    lines.push(`codex バイナリ: ${diag.resolvedCodexPath || "(見つからない)"}`);
    lines.push(`バイナリ存在: ${diag.codexPathExists ? "あり" : "なし"}`);
    lines.push(`アプリ exe: ${diag.currentExe || "(取得失敗)"}`);
    lines.push(`ログディレクトリ: ${diag.logDir || "(取得失敗)"}`);
  } else if (diagErr) {
    lines.push(`診断情報取得失敗: ${diagErr}`);
  } else {
    lines.push("(診断情報がまだ取得できていません)");
  }
  lines.push("");
  lines.push("--- エラー内容 ---");
  lines.push(error || "(エラーメッセージなし)");
  return lines.join("\n");
}
