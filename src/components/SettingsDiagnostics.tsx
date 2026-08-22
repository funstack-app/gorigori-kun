import { useMemo, useState, type ReactNode } from "react";
import { check } from "@tauri-apps/plugin-updater";

import {
  appServerReady,
  diagnostics,
  higgsfieldMcp,
  magnific,
  remoteMcp,
  restartAppServer,
  type DiagnosticEnvironment,
  type DiagnosticNetwork,
  type MagnificStatus,
  type RemoteMcpStatus,
  type HiggsfieldMcpStatus,
} from "../lib/ipc";
import { useAppServer } from "../lib/store/appServer";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";

type Health = "ok" | "warn" | "error";
type UpdateDiagnostic =
  | { kind: "unchecked" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "error" };

type ConnectionDiagnostic = {
  higgsfield: HiggsfieldMcpStatus;
  magnific: MagnificStatus;
  remote: RemoteMcpStatus[];
};

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

const safeVersion = (value: string): string =>
  value.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 80) || "不明";

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

export function SettingsDiagnostics() {
  const push = useToasts((state) => state.push);
  const appServerStatus = useAppServer((state) => state.status);
  const [environment, setEnvironment] = useState<DiagnosticEnvironment | null>(null);
  const [network, setNetwork] = useState<DiagnosticNetwork | null>(null);
  const [connections, setConnections] = useState<ConnectionDiagnostic | null>(null);
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
  const [update, setUpdate] = useState<UpdateDiagnostic>({ kind: "unchecked" });
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [environmentFailed, setEnvironmentFailed] = useState(false);
  const [networkFailed, setNetworkFailed] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const effectiveEngineReady = engineReady ?? appServerStatus === "ready";

  const runUpdateCheck = async (): Promise<void> => {
    setUpdate({ kind: "checking" });
    try {
      const result = await check();
      setUpdate(
        result
          ? { kind: "available", version: safeVersion(result.version) }
          : { kind: "current" },
      );
    } catch {
      setUpdate({ kind: "error" });
    }
  };

  const openUpdateSettings = () => {
    useWorkspace.getState().requestSettingsTab("basic");
    window.setTimeout(() => {
      const heading = Array.from(document.querySelectorAll("h3")).find(
        (element) => element.textContent?.trim() === "アップデート",
      );
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const runDiagnostics = async () => {
    if (running) return;
    setRunning(true);
    setRan(true);
    setEnvironmentFailed(false);
    setNetworkFailed(false);
    setConnectionsFailed(false);
    setUpdate({ kind: "checking" });

    const [environmentResult, networkResult, connectionsResult, engineResult, updateResult] =
      await Promise.allSettled([
        diagnostics.environment(),
        diagnostics.network(),
        Promise.all([higgsfieldMcp.status(), magnific.status(), remoteMcp.statusAll()]),
        appServerReady(),
        check(),
      ]);

    if (environmentResult.status === "fulfilled") {
      setEnvironment(environmentResult.value);
    } else {
      setEnvironment(null);
      setEnvironmentFailed(true);
    }
    if (networkResult.status === "fulfilled") {
      setNetwork(networkResult.value);
    } else {
      setNetwork(null);
      setNetworkFailed(true);
    }
    if (connectionsResult.status === "fulfilled") {
      const [higgsfield, magnificStatus, remote] = connectionsResult.value;
      setConnections({ higgsfield, magnific: magnificStatus, remote });
    } else {
      setConnections(null);
      setConnectionsFailed(true);
    }
    if (engineResult.status === "fulfilled") {
      setEngineReady(engineResult.value);
    } else {
      setEngineReady(false);
    }
    if (updateResult.status === "fulfilled") {
      setUpdate(
        updateResult.value
          ? { kind: "available", version: safeVersion(updateResult.value.version) }
          : { kind: "current" },
      );
    } else {
      setUpdate({ kind: "error" });
    }
    setRunning(false);
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
      setEngineReady(true);
      push({ kind: "success", text: "生成エンジンを再起動しました", ttlMs: 2600 });
    } catch (error) {
      if (String(error).includes("already running")) {
        useAppServer.setState({ status: "ready", error: undefined });
        setEngineReady(true);
        push({ kind: "info", text: "生成エンジンはすでに動いています", ttlMs: 2400 });
      } else {
        // 通常の自動検出で失敗した場合は、既存の起動処理へ戻す。
        // bootstrap は保存済みのカスタム Codex パスを読み、3回まで再試行する。
        await useAppServer.getState().bootstrap();
        if (useAppServer.getState().status === "ready") {
          setEngineReady(true);
          push({ kind: "success", text: "生成エンジンを再起動しました", ttlMs: 2600 });
          return;
        }
        setEngineReady(false);
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
    update.kind === "current"
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
            ? "更新情報を確認できませんでした"
            : "まだ更新を確認していません";

  const codexHealth: Health = environmentFailed
    ? "error"
    : environment?.codex.status === "ok"
      ? "ok"
      : ran && environment
        ? "error"
        : "warn";
  const codexDescription = environmentFailed
    ? "Codex の状態を確認できませんでした"
    : environment?.codex.status === "ok"
      ? `${environment.codex.version}${environment.codex.path ? ` / ${environment.codex.path}` : ""}`
      : environment?.codex.reason ?? "まだ診断していません";

  const ffmpegHealth: Health = environmentFailed
    ? "error"
    : environment?.ffmpeg.status === "ok"
      ? "ok"
      : "warn";
  const ffmpegDescription = environmentFailed
    ? "ffmpeg の状態を確認できませんでした"
    : environment?.ffmpeg.status === "ok"
      ? environment.ffmpeg.version
      : environment?.ffmpeg.reason ?? "まだ診断していません";

  const connectionHealth: Health = connectionsFailed
    ? "error"
    : reconnectCount > 0
      ? "warn"
      : connections
        ? "ok"
        : "warn";
  const connectionDescription = connectionsFailed
    ? "接続状態を確認できませんでした"
    : connections
      ? `${authenticatedCount}/${allConnectionStates.length} 接続済み${reconnectCount > 0 ? `、${reconnectCount}件は再接続が必要です` : "。未登録の接続先は任意です"}`
      : "まだ診断していません";

  const networkOk = Boolean(
    network && network.codex.status === "ok" && network.updates.status === "ok",
  );
  const networkHealth: Health = networkFailed ? "error" : networkOk ? "ok" : ran ? "error" : "warn";
  const networkDescription = networkFailed
    ? "通信状態を確認できませんでした"
    : networkOk
      ? "Codex と更新先の両方へ到達できます"
      : network
        ? "オフライン、またはプロキシ設定の影響が考えられます"
        : "まだ診断していません";

  const storage = environment?.temporaryStorage;
  const storageHealth: Health = environmentFailed
    ? "error"
    : storage?.warning || storage?.status !== "ok"
      ? "warn"
      : storage
        ? "ok"
        : "warn";
  const storageDescription = environmentFailed
    ? "一時データを確認できませんでした"
    : storage?.totalBytes != null
      ? `一時データ ${formatBytes(storage.totalBytes)}${storage.warning ? "。10 GBを超えています" : ""}`
      : storage?.reason ?? "まだ診断していません";

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-white">診断</h2>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            動かない原因をまとめて確認します。診断だけでは設定や作品を変更しません。
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => void runDiagnostics()}
          className="rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-400 disabled:opacity-50"
        >
          {running ? "診断中…" : ran ? "もう一度診断" : "診断を実行"}
        </button>
      </header>

      <div className="divide-y divide-[#2a2a2a] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]">
        <DiagnosticRow health={updateHealth} name="アプリの更新" description={updateDescription}>
          <button
            type="button"
            disabled={update.kind === "checking"}
            onClick={() =>
              update.kind === "available"
                ? openUpdateSettings()
                : void runUpdateCheck()
            }
            className={BUTTON}
          >
            {update.kind === "available" ? "更新画面へ" : "更新を確認"}
          </button>
        </DiagnosticRow>

        <DiagnosticRow health={codexHealth} name="AIエンジン（Codex）" description={codexDescription}>
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
          health={effectiveEngineReady ? "ok" : ran ? "error" : "warn"}
          name="生成エンジン"
          description={
            effectiveEngineReady
              ? "画像生成のエンジンは動いています"
              : ran
                ? "生成エンジンが停止しています"
                : "まだ診断していません"
          }
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

        <DiagnosticRow health={connectionHealth} name="接続先" description={connectionDescription}>
          <button
            type="button"
            onClick={() => useWorkspace.getState().requestSettingsTab("connections")}
            className={BUTTON}
          >
            {reconnectCount > 0 ? "再接続" : "接続先を見る"}
          </button>
        </DiagnosticRow>

        <DiagnosticRow health={ffmpegHealth} name="ffmpeg" description={ffmpegDescription}>
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

        <DiagnosticRow health={networkHealth} name="ネットワーク" description={networkDescription}>
          <button
            type="button"
            disabled={running}
            onClick={() => void runDiagnostics()}
            className={BUTTON}
          >
            もう一度診断
          </button>
        </DiagnosticRow>

        <DiagnosticRow health={storageHealth} name="ストレージ" description={storageDescription}>
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
  children,
}: {
  health: Health;
  name: string;
  description: string;
  children: ReactNode;
}) {
  const icon = health === "ok" ? "✅" : health === "warn" ? "⚠️" : "❌";
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap">
      <span aria-label={health} className="text-lg" role="img">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-black text-neutral-100">{name}</p>
        <p className="mt-0.5 break-words text-[11px] leading-relaxed text-neutral-400">
          {description}
        </p>
      </div>
      {children}
    </div>
  );
}
