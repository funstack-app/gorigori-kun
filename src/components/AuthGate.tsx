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
  const [showDetails, setShowDetails] = useState(false);

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
      <div className="w-full max-w-md rounded-md border border-neutral-200 bg-white shadow-sm">
        <div className="px-6 py-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-500">
            <WarnTriangleIcon />
          </div>
          <h2 className="mb-2 text-base font-semibold text-neutral-900">
            起動に失敗しました
          </h2>
          <p className="text-sm text-neutral-600">
            Codex の起動でエラーが発生しました。<br />
            再試行を押して、もう一度お試しください。
          </p>
        </div>

        <div className="flex gap-2 px-6 pb-4">
          <button
            type="button"
            onClick={onRetry}
            className="flex-1 rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700"
          >
            再試行
          </button>
        </div>

        {/* 折りたたみ式の詳細情報 (デフォルト閉じる) */}
        <div className="border-t border-neutral-200 px-6 py-3">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="flex w-full items-center gap-1.5 text-[12px] font-bold text-neutral-500 hover:text-neutral-700"
            aria-expanded={showDetails}
          >
            <DisclosureIcon open={showDetails} />
            <span>{showDetails ? "詳細を隠す" : "詳細を表示 (サポート向け)"}</span>
          </button>

          {showDetails && (
            <div className="mt-3 space-y-3">
              <div>
                <h3 className="mb-1 text-[11px] font-black uppercase tracking-wider text-neutral-600">
                  エラー内容
                </h3>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-700">
{error || "(エラーメッセージなし)"}
                </pre>
              </div>

              <div>
                <h3 className="mb-1 text-[11px] font-black uppercase tracking-wider text-neutral-600">
                  環境情報
                </h3>
                <pre className="whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-700">
{diag
  ? `OS: ${diag.os} / ${diag.arch}
アプリ: v${diag.appVersion}`
  : diagErr
    ? `診断情報の取得失敗: ${diagErr}`
    : "診断情報を取得中..."}
                </pre>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyAll}
                  className="flex items-center gap-1.5 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200"
                >
                  {copied && <CheckIcon />}
                  <span>{copied ? "コピー済み" : "情報をコピー"}</span>
                </button>
                {diag?.logDir && (
                  <button
                    type="button"
                    onClick={openLogDir}
                    className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                  >
                    ログフォルダ
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- フラットアイコン (絵文字廃止) --- */

const GATE_SVG = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function WarnTriangleIcon() {
  return (
    <svg {...GATE_SVG} width={24} height={24} aria-hidden>
      <path d="M12 3.5L22 20H2z" />
      <path d="M12 9.5v4.5M12 16.9v.3" />
    </svg>
  );
}

/** 折りたたみ三角 (open=展開中で下向き, 閉=右向き)。 */
function DisclosureIcon({ open }: { open: boolean }) {
  return (
    <svg
      {...GATE_SVG}
      width={11}
      height={11}
      className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...GATE_SVG} width={12} height={12} strokeWidth={2.6} aria-hidden>
      <path d="M4 12.5l5.5 5.5L20 6" />
    </svg>
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
