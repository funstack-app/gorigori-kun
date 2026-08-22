import { useEffect, useMemo, useState, type ReactNode } from "react";

import { restartAppServer } from "../lib/ipc";
import { useAppServer } from "../lib/store/appServer";
import { useDiagnosticsRun } from "../lib/store/diagnosticsRun";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";

type Health = "idle" | "ok" | "warn" | "error";

const BUTTON =
  "shrink-0 rounded-md border border-[#414141] bg-[#202020] px-3 py-1.5 text-[11px] font-bold text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-default disabled:opacity-40";

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(index === 0 ? 0 : 1) : value.toFixed(2)} ${units[index]}`;
};

const sanitizeReport = (value: string): string =>
  value
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "~")
    .split("\n")
    .map((line) =>
      /sk-|token|api[_-]?key|authorization|bearer|secret/i.test(line)
        ? "[秘匿情報を除外]"
        : line,
    )
    .join("\n");

const connectionLabel = (status: { registered: boolean; authenticated: boolean }): string => {
  if (status.authenticated) return "接続済み";
  if (status.registered) return "再接続が必要";
  return "未登録（任意）";
};

const formatElapsedMinutes = (at: number, now: number): string =>
  `${Math.max(0, Math.floor((now - at) / 60_000))}分前`;

export function SettingsDiagnostics() {
  const push = useToasts((state) => state.push);
  const appServerStatus = useAppServer((state) => state.status);
  const {
    checkUpdate,
    connections,
    connectionsError,
    engineError,
    engineReady,
    environment,
    environmentError,
    lastRunAt,
    lastRunKind,
    network,
    networkError,
    run,
    running,
    update,
  } = useDiagnosticsRun();
  const [restarting, setRestarting] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const ran = lastRunAt != null;
  const effectiveEngineReady = engineReady ?? appServerStatus === "ready";
  const detectionContext =
    lastRunKind === "automatic"
      ? "最後のエラー発生時に検出"
      : lastRunKind === "manual"
        ? "最後の手動診断で検出"
        : undefined;

  const openUpdateSettings = () => {
    useWorkspace.getState().requestSettingsTab("basic");
    window.setTimeout(() => {
      const heading = Array.from(document.querySelectorAll("h3")).find(
        (element) => element.textContent?.trim() === "アップデート",
      );
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const allConnectionStates = useMemo(() => {
    if (!connections) return [];
    return [connections.higgsfield, connections.magnific, ...connections.remote];
  }, [connections]);
  const reconnectCount = allConnectionStates.filter(
    (item) => item.registered && !item.authenticated,
  ).length;
  const authenticatedCount = allConnectionStates.filter((item) => item.authenticated).length;

  const createReport = (): string => {
    const updateText =
      update.kind === "current"
        ? "最新版"
        : update.kind === "available"
          ? `更新あり ${update.version}`
          : update.kind === "error"
            ? "確認失敗"
            : "未確認";
    const networkLines = network
      ? [network.codex, network.updates].map(
          (item) =>
            `${item.label}: ${item.status === "ok" ? `到達可 (HTTP ${item.statusCode ?? "応答あり"})` : item.reason ?? "到達不可"}`,
        )
      : ["ネットワーク: 確認失敗"];
    const connectionLines = connections
      ? [
          `Higgsfield: ${connectionLabel(connections.higgsfield)}`,
          `Magnific: ${connectionLabel(connections.magnific)}`,
          ...connections.remote.map(
            (item) => `Remote/${item.id}: ${connectionLabel(item)}`,
          ),
        ]
      : ["接続先: 確認失敗"];
    return sanitizeReport(
      [
        environment?.reportText ?? "GORI GORI KUN 診断レポート\n環境: 確認失敗",
        `アプリ更新: ${updateText}`,
        `生成エンジン: ${effectiveEngineReady ? "稼働中" : "停止中"}`,
        ...networkLines,
        ...connectionLines,
      ].join("\n"),
    );
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(createReport());
      push({ kind: "success", text: "報告用の環境情報をコピーしました", ttlMs: 2600 });
    } catch {
      push({ kind: "error", text: "コピーできませんでした", ttlMs: 3000 });
    }
  };

  const copyInstallCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      push({ kind: "success", text: "インストール用の文をコピーしました", ttlMs: 2200 });
    } catch {
      push({ kind: "error", text: "コピーできませんでした", ttlMs: 3000 });
    }
  };

  const restartEngine = async () => {
    if (restarting) return;
    setRestarting(true);
    useAppServer.setState({ status: "starting", error: undefined });
    try {
      await restartAppServer();
      useAppServer.setState({ status: "ready", error: undefined });
      useDiagnosticsRun.setState({ engineReady: true, engineError: null });
      push({ kind: "success", text: "生成エンジンを再起動しました", ttlMs: 2600 });
    } catch (error) {
      if (String(error).includes("already running")) {
        useAppServer.setState({ status: "ready", error: undefined });
        useDiagnosticsRun.setState({ engineReady: true, engineError: null });
        push({ kind: "info", text: "生成エンジンはすでに動いています", ttlMs: 2400 });
      } else {
        // 通常の自動検出で失敗した場合は、既存の起動処理へ戻す。
        // bootstrap は保存済みのカスタム Codex パスを読み、3回まで再試行する。
        await useAppServer.getState().bootstrap();
        if (useAppServer.getState().status === "ready") {
          useDiagnosticsRun.setState({ engineReady: true, engineError: null });
          push({ kind: "success", text: "生成エンジンを再起動しました", ttlMs: 2600 });
          return;
        }
        useDiagnosticsRun.setState({ engineReady: false });
        push({
          kind: "error",
          text: "再起動できませんでした。報告用の環境情報をコピーしてください",
          ttlMs: 5200,
        });
      }
    } finally {
      setRestarting(false);
    }
  };

  const updateHealth: Health =
    update.kind === "unchecked"
      ? "idle"
      : update.kind === "current"
        ? "ok"
        : update.kind === "error"
          ? "error"
          : "warn";
  const updateDescription =
    update.kind === "current"
      ? "最新版を使っています"
      : update.kind === "available"
        ? `新しい版 ${update.version} があります。基本設定から更新できます`
        : update.kind === "checking"
          ? "更新があるか確認中です"
          : update.kind === "error"
            ? `更新情報を確認できませんでした。理由: ${update.reason}`
            : "未実行";

  const codexHealth: Health = !ran
    ? "idle"
    : environmentError
      ? "error"
      : environment?.codex.status === "ok"
        ? "ok"
        : "error";
  const codexDescription = !ran
    ? "未実行"
    : environmentError
      ? `Codex の診断を実行できませんでした。理由: ${environmentError}`
      : environment?.codex.status === "ok"
        ? `${environment.codex.version}${environment.codex.path ? ` / ${environment.codex.path}` : ""}`
        : environment?.codex.reason ?? "Codex を利用できません";

  const ffmpegHealth: Health = !ran
    ? "idle"
    : environmentError
      ? "error"
      : environment?.ffmpeg.status === "ok"
        ? "ok"
        : "warn";
  const ffmpegDescription = !ran
    ? "未実行"
    : environmentError
      ? `ffmpeg の診断を実行できませんでした。理由: ${environmentError}`
      : environment?.ffmpeg.status === "ok"
        ? environment.ffmpeg.version
        : environment?.ffmpeg.reason ?? "ffmpeg を利用できません";

  const connectionHealth: Health = !ran
    ? "idle"
    : connectionsError
      ? "error"
      : reconnectCount > 0
        ? "warn"
        : connections
          ? "ok"
          : "error";
  const connectionDescription = !ran
    ? "未実行"
    : connectionsError
      ? `接続先の診断を実行できませんでした。理由: ${connectionsError}`
      : connections
        ? `${authenticatedCount}/${allConnectionStates.length} 接続済み${reconnectCount > 0 ? `、${reconnectCount}件は再接続が必要です` : "。未登録の接続先は任意です"}`
        : "接続先の状態を取得できませんでした";

  const networkOk = Boolean(
    network && network.codex.status === "ok" && network.updates.status === "ok",
  );
  const networkHealth: Health = !ran ? "idle" : networkError ? "error" : networkOk ? "ok" : "error";
  const networkDescription = !ran
    ? "未実行"
    : networkError
      ? `通信の診断を実行できませんでした。理由: ${networkError}`
      : networkOk
        ? "Codex と更新先の両方へ到達できます"
        : network
          ? "オフライン、または会社や学校の通信設定（プロキシ）の影響が考えられます"
          : "通信状態を取得できませんでした";

  const storage = environment?.temporaryStorage;
  const storageHealth: Health = !ran
    ? "idle"
    : environmentError
      ? "error"
      : storage?.warning || storage?.status !== "ok"
        ? "warn"
        : storage
          ? "ok"
          : "error";
  const storageDescription = !ran
    ? "未実行"
    : environmentError
      ? `一時データの診断を実行できませんでした。理由: ${environmentError}`
      : storage?.totalBytes != null
        ? `一時データ ${formatBytes(storage.totalBytes)}${storage.warning ? "。10 GBを超えています" : ""}`
        : storage?.reason ?? "一時データの状態を取得できませんでした";

  const engineHealth: Health = !ran
    ? "idle"
    : engineError
      ? "error"
      : effectiveEngineReady
        ? "ok"
        : "error";
  const engineDescription = !ran
    ? "未実行"
    : engineError
      ? `生成エンジンの診断を実行できませんでした。理由: ${engineError}`
      : effectiveEngineReady
        ? "画像生成のエンジンは動いています"
        : "生成エンジンが停止しています";

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-white">診断</h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            動かない原因をまとめて確認します。診断だけでは設定や作品を変更しません。
          </p>
          <p className="mt-1 text-[11px] font-bold text-neutral-300">
            最終実行: {lastRunAt == null
              ? "未実行"
              : `${formatElapsedMinutes(lastRunAt, now)}（${lastRunKind === "automatic" ? "自動" : "手動"}）`}
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => void run("manual")}
          className="rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-400 disabled:opacity-50"
        >
          {running ? "診断中…" : "診断を実行"}
        </button>
      </header>

      <div className="divide-y divide-[#2a2a2a] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]">
        <DiagnosticRow
          health={updateHealth}
          name="アプリの更新"
          description={updateDescription}
          context={updateHealth === "ok" || updateHealth === "idle" ? undefined : detectionContext}
        >
          <button
            type="button"
            disabled={update.kind === "checking"}
            onClick={() =>
              update.kind === "available"
                ? openUpdateSettings()
                : void checkUpdate()
            }
            className={BUTTON}
          >
            {update.kind === "available" ? "更新画面へ" : "更新を確認"}
          </button>
        </DiagnosticRow>

        <DiagnosticRow
          health={codexHealth}
          name="AIエンジン（Codex）"
          description={codexDescription}
          context={codexHealth === "ok" || codexHealth === "idle" ? undefined : detectionContext}
        >
          <button
            type="button"
            disabled={!ran || running}
            onClick={() => void copyReport()}
            className={BUTTON}
          >
            詳しい状態を報告用にコピー
          </button>
        </DiagnosticRow>

        <DiagnosticRow
          health={engineHealth}
          name="生成エンジン"
          description={engineDescription}
          context={engineHealth === "ok" || engineHealth === "idle" ? undefined : detectionContext}
        >
          <button
            type="button"
            disabled={restarting || effectiveEngineReady}
            onClick={() => void restartEngine()}
            className={BUTTON}
          >
            {restarting ? "再起動中…" : effectiveEngineReady ? "稼働中" : "エンジンを再起動"}
          </button>
        </DiagnosticRow>

        <DiagnosticRow
          health={connectionHealth}
          name="接続先"
          description={connectionDescription}
          context={
            connectionHealth === "ok" || connectionHealth === "idle" ? undefined : detectionContext
          }
        >
          <button
            type="button"
            onClick={() => useWorkspace.getState().requestSettingsTab("connections")}
            className={BUTTON}
          >
            {reconnectCount > 0 ? "再接続" : "接続先を見る"}
          </button>
        </DiagnosticRow>

        <DiagnosticRow
          health={ffmpegHealth}
          name="ffmpeg（動画の変換部品）"
          description={ffmpegDescription}
          context={ffmpegHealth === "ok" || ffmpegHealth === "idle" ? undefined : detectionContext}
        >
          {environment?.ffmpeg.status !== "ok" && environment?.os === "macos" ? (
            <button
              type="button"
              onClick={() => void copyInstallCommand("brew install ffmpeg")}
              className={BUTTON}
            >
              brew install ffmpeg をコピー
            </button>
          ) : environment?.ffmpeg.status !== "ok" && environment?.os === "windows" ? (
            <button
              type="button"
              onClick={() => void copyInstallCommand("winget install Gyan.FFmpeg")}
              className={BUTTON}
            >
              winget の文をコピー
            </button>
          ) : (
            <button type="button" disabled className={BUTTON}>
              {environment?.ffmpeg.status === "ok" ? "導入済み" : "診断後に案内"}
            </button>
          )}
        </DiagnosticRow>

        <DiagnosticRow
          health={networkHealth}
          name="ネットワーク"
          description={networkDescription}
          context={networkHealth === "ok" || networkHealth === "idle" ? undefined : detectionContext}
        >
          <button
            type="button"
            disabled={running}
            onClick={() => void run("manual")}
            className={BUTTON}
          >
            もう一度診断
          </button>
        </DiagnosticRow>

        <DiagnosticRow
          health={storageHealth}
          name="ストレージ"
          description={storageDescription}
          context={storageHealth === "ok" || storageHealth === "idle" ? undefined : detectionContext}
        >
          <button
            type="button"
            onClick={() => useWorkspace.getState().requestSettingsTab("storage")}
            className={BUTTON}
          >
            ストレージ整理へ
          </button>
        </DiagnosticRow>
      </div>

      <div className="rounded-xl border border-pink-500/20 bg-pink-500/5 p-3">
        <p className="text-xs font-bold text-pink-100">サポートへ伝える時</p>
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
          ユーザー名や秘密の認証情報を除いた診断結果だけをコピーします。
        </p>
        <button
          type="button"
          disabled={!ran || running}
          onClick={() => void copyReport()}
          className="mt-2 rounded-md bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-400 disabled:opacity-40"
        >
          報告用に環境情報をコピー
        </button>
      </div>
    </div>
  );
}

function DiagnosticRow({
  health,
  name,
  description,
  context,
  children,
}: {
  health: Health;
  name: string;
  description: string;
  context?: string;
  children: ReactNode;
}) {
  const status =
    health === "ok"
      ? { label: "正常", className: "border-emerald-500/40 text-emerald-300" }
      : health === "warn"
        ? { label: "注意", className: "border-amber-500/40 text-amber-300" }
        : health === "error"
          ? { label: "エラー", className: "border-red-500/40 text-red-300" }
          : { label: "未実行", className: "border-neutral-600 text-neutral-400" };
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap">
      <span
        aria-label={status.label}
        className={`w-14 shrink-0 rounded border px-1.5 py-1 text-center text-[10px] font-black ${status.className}`}
      >
        {status.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-black text-neutral-100">{name}</p>
        <p className="mt-0.5 break-words text-[11px] leading-relaxed text-neutral-400">
          {description}
        </p>
        {context ? (
          <p className="mt-1 text-[10px] font-bold text-neutral-500">{context}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
