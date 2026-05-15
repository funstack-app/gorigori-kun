import { useEffect, useMemo } from "react";
import { useComposer } from "../lib/store/composer";
import { useThreads } from "../lib/store/threads";
import { useBatches } from "../lib/store/batches";
import { useSessions } from "../lib/store/sessions";
import { useImages } from "../lib/store/images";
import { useWorkflow } from "../lib/store/workflow";
import { MessageList } from "./MessageList";
import { PromptComposer } from "./PromptComposer";
import type { Turn } from "../lib/codex-types";

function labelForEffort(value: string): string {
  switch (value) {
    case "low":
      return "低 (速い)";
    case "medium":
      return "中";
    case "high":
      return "高 (じっくり)";
    case "xhigh":
      return "最高";
    default:
      return value;
  }
}

export function ChatPanel() {
  const {
    threadsById,
    activeThreadId,
    attachListeners,
    loadModels,
    ensureThread,
    starting,
    models,
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    cwd,
  } = useThreads();
  const currentModel = models.find((m) => (m.model ?? m.id) === selectedModel);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];

  useEffect(() => {
    attachListeners();
    loadModels();
    ensureThread().catch((err) => console.error("ensureThread failed", err));
  }, []);

  const sessionIsFrozen = useSessions((s) => s.isFrozen);
  const displayedSession = useSessions((s) => s.displayedSession);

  // Convert historical session data into synthetic Turn objects for rendering
  const historyTurns = useMemo<Turn[]>(() => {
    if (!sessionIsFrozen || !displayedSession) return [];
    return displayedSession.turns.map((t) => ({
      id: t.id,
      status: "completed" as const,
      items: [
        // user message
        {
          id: `${t.id}-user`,
          type: "userMessage" as const,
          status: "completed" as const,
          content: [{ type: "text", text: t.prompt }],
        },
        // image generation items for each recorded image
        ...t.images.map((img) => ({
          id: img.id,
          type: "imageGeneration" as const,
          status: "completed" as const,
          savedPath: img.path,
        })),
      ],
    }));
  }, [sessionIsFrozen, displayedSession]);

  const liveTurns = useMemo(
    () => (activeThreadId ? threadsById[activeThreadId]?.turns ?? [] : []),
    [threadsById, activeThreadId],
  );

  // Frozen historical sessions render the persisted turns; the live
  // session uses the in-memory thread state. Either way, batches
  // (parallel-generation pseudo-turns) are interleaved on top in
  // MessageList and only appear in the live view.
  const turns = useMemo<Turn[]>(() => {
    if (sessionIsFrozen) return historyTurns;
    return liveTurns;
  }, [sessionIsFrozen, historyTurns, liveTurns]);

  const batches = useBatches((s) => s.batches);
  const referenceCount = useComposer((s) => s.references.length);
  const imageCount = useImages((s) => s.items.length);
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const videoMode = useWorkflow((s) => s.videoMode);
  const imageMode = useWorkflow((s) => s.imageMode);
  const resumeDisplayedSession = () => {
    if (!displayedSession) return;
    useSessions.setState({
      activeSessionId: displayedSession.session.id,
      isFrozen: false,
      displayedSession: undefined,
    });
    useThreads.getState().resetThread();
  };
  const stageTitle =
    sessionIsFrozen && displayedSession
      ? displayedSession.session.title
      : primaryMode === "video"
      ? videoMode === "multiAngle"
        ? "マルチアングル制作"
        : "ストーリーカット制作"
      : imageMode === "edit"
        ? "画像編集"
        : imageMode === "layers"
          ? "レイヤー設計"
          : "画像生成";
  const stageCopy =
    sessionIsFrozen
      ? "過去の制作チャットと生成画像を確認しています。続ける場合は、この案件を再開してください。"
      : primaryMode === "video"
      ? videoMode === "multiAngle"
        ? "同じ世界観のまま、カメラだけを動かす。"
        : "1枚の基準から、使えるカットを積み上げる。"
      : imageMode === "edit"
        ? "生成した素材を、そのまま次の編集へ回す。"
        : imageMode === "layers"
          ? "背景・人物・素材を分けて扱う準備をする。"
          : "広告、サムネ、LP素材まで使える1枚を作る。";
  const emptyHint = (
    <div className="mx-auto mt-10 max-w-2xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 bg-[linear-gradient(135deg,#f8fafc,#eef2ff)] px-6 py-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-blue-700">
          Ready
        </p>
        <h3 className="mt-2 text-2xl font-black tracking-normal text-neutral-950">
          {stageTitle}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600">
          {stageCopy}
        </p>
      </div>
      <div className="grid grid-cols-3 divide-x divide-neutral-100 text-center">
        <StageMetric label="参照" value={referenceCount} />
        <StageMetric label="素材" value={imageCount} />
        <StageMetric label="実行" value={batches.length} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f3f4f6]">
      <div className="border-b border-neutral-200 bg-white px-5 py-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-blue-700">
              Stage
            </p>
            <h2 className="mt-1 text-2xl font-black tracking-normal text-neutral-950">
              {stageTitle}
            </h2>
            <p className="mt-1 text-sm text-neutral-500">{stageCopy}</p>
          </div>
          <div
            className="max-w-sm truncate rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-right text-[11px] text-neutral-500"
            title={
              cwd
                ? `作業フォルダ (codex の cwd / 「プロジェクトへ保存」先): ${cwd}`
                : undefined
            }
          >
            {starting ? "Codex の制作スレッドを準備中..." : cwd ? cwd : ""}
          </div>
        </div>
        {sessionIsFrozen && displayedSession && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-3 py-2">
            <div>
              <p className="text-xs font-bold text-blue-900">履歴を表示中</p>
              <p className="mt-0.5 text-[11px] text-blue-700">
                この案件に新しく生成を追加するには、案件を再開します。
              </p>
            </div>
            <button
              type="button"
              onClick={resumeDisplayedSession}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-600"
            >
              この案件で続ける
            </button>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
          <label className="flex min-w-0 items-center gap-2">
            <span className="whitespace-nowrap text-[11px] font-semibold text-neutral-500">モデル</span>
            <select
              value={selectedModel ?? ""}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="min-w-0 max-w-[220px] rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-950 shadow-sm"
            >
              {models.map((m) => (
                <option key={m.id} value={m.model ?? m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          {efforts.length > 0 && (
            <label className="flex min-w-0 items-center gap-2">
              <span className="whitespace-nowrap text-[11px] font-semibold text-neutral-500">思考</span>
              <select
                value={selectedEffort ?? ""}
                onChange={(e) => setSelectedEffort(e.target.value || undefined)}
                className="min-w-0 max-w-[120px] rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-950 shadow-sm"
                title="思考レベル: 高いほどじっくり考えますが、時間とトークンを使います"
              >
                {efforts.map((e) => (
                  <option key={e.reasoningEffort} value={e.reasoningEffort}>
                    {labelForEffort(e.reasoningEffort)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <MessageList
        turns={turns}
        batches={sessionIsFrozen ? [] : batches}
        emptyHint={emptyHint}
      />
      {sessionIsFrozen ? (
        <div className="mx-6 mb-5 rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm shadow-[0_18px_45px_rgba(15,23,42,0.10)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-bold text-neutral-950">この案件は閲覧モードです</p>
              <p className="mt-0.5 text-xs text-neutral-500">
                続きから制作する場合は、案件を再開してください。
              </p>
            </div>
            <button
              type="button"
              onClick={resumeDisplayedSession}
              className="rounded-md bg-neutral-950 px-3 py-1.5 text-xs font-bold text-white hover:bg-neutral-800"
            >
              制作を続ける
            </button>
          </div>
        </div>
      ) : (
        <PromptComposer />
      )}
    </div>
  );
}

function StageMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-4">
      <p className="text-2xl font-black tabular-nums text-neutral-950">{value}</p>
      <p className="mt-1 text-[11px] font-semibold text-neutral-500">{label}</p>
    </div>
  );
}
