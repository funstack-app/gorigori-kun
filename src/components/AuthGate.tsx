import { useEffect, type PropsWithChildren } from "react";
import { useAppServer } from "../lib/store/appServer";
import { useAuth } from "../lib/store/auth";
import { LoginPanel } from "./LoginPanel";

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
    return (
      <Splash
        text={`app-server を起動できませんでした`}
        sub={appServer.error}
      />
    );
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
