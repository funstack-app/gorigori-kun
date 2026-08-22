import { useEffect, useMemo, useRef, useState } from "react";

import {
  createFilmChatMessage,
  FilmTextTurnAbortedError,
  FilmTextTurnTimeoutError,
  INITIAL_FILM_ADVISOR_MESSAGE,
  projectResumeMessage,
  runFilmAdvisorTurn,
} from "../../../lib/film/advisor";
import {
  parseAdvisorResponse,
  type AdvisorArtifact,
  type AdvisorArtifactType,
} from "../../../lib/film/advisorParse";
import {
  detectCharacterNameVariations,
  parseBlockScript,
  parseSceneList,
  validateBeatsheetDuration,
  validateBlockScript,
  validateSceneDuration,
  type ScriptCheckIssue,
} from "../../../lib/film/scriptParse";
import {
  DEFAULT_VIDEO_SERVICE_ID,
  findVideoServiceProfile,
  VIDEO_SERVICE_PROFILES,
} from "../../../lib/film/serviceProfiles";
import type { FilmProject, FilmScript } from "../../../lib/film/types";
import { humanizeError } from "../../../lib/humanizeError";
import {
  useFilmProjectStore,
  type FilmScriptApprovalStage,
} from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";
import { IssueList, ProgressCard } from "./ScriptPhasePanel";

const ARTIFACT_LABELS: Record<AdvisorArtifactType, string> = {
  premise: "企画で決めたこと",
  logline: "一文のあらすじ",
  beatsheet: "物語の流れ（起きることの順番）",
  treatment: "最初から最後までの物語",
  scenelist: "場面の一覧",
  blocks: "動画1回分ずつの台本",
};

const ARTIFACT_PURPOSES: Record<AdvisorArtifactType, string> = {
  premise: "これを決めると、作品の向かう先がそろいます。",
  logline: "これを書くと、物語の魅力を一目で伝えられます。",
  beatsheet: "これを書くと、起きることの順番と物語の山が決まります。",
  treatment: "これを書くと、最初から最後までの映像を思い描けます。",
  scenelist: "これを書くと、場所ごとの場面と長さが分かります。",
  blocks: "これを書くと、AIが一度に作る動画ごとの内容が決まります。",
};

const STAGE_BY_ARTIFACT: Partial<Record<AdvisorArtifactType, FilmScriptApprovalStage>> = {
  logline: "logline",
  beatsheet: "beatsheet",
  treatment: "treatment",
  scenelist: "scenelist",
  blocks: "blocks",
};

function scriptOf(project: FilmProject): FilmScript {
  return Array.isArray(project.script)
    ? {
        logline: "",
        beatsheet: "",
        treatment: "",
        scenes: [],
        blocks: [],
        scenelistText: "",
        blockScriptText: "",
        targetDurationSeconds: 90,
        topicMemo: "",
        characterNames: [],
      }
    : project.script;
}

function fieldValue(
  fields: Record<string, string>,
  aliases: string[],
): string | undefined {
  for (const alias of aliases) {
    const entry = Object.entries(fields).find(([key]) => key.replace(/\s+/gu, "") === alias);
    if (entry?.[1]?.trim()) return entry[1].trim();
  }
  return undefined;
}

function splitNames(value: string | undefined): string[] {
  if (!value || /^(なし|無し|いない)$/u.test(value.trim())) return [];
  return value
    .split(/[、,／/]/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function resolveServiceId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const profile = VIDEO_SERVICE_PROFILES.find(
    (candidate) =>
      candidate.id.toLowerCase() === normalized ||
      candidate.label.toLowerCase() === normalized,
  );
  return profile?.id ?? null;
}

type PremiseDraft = {
  title: string;
  theme: string;
  targetDurationSeconds: number;
  characterNames: string[];
  topicMemo: string;
  postingTarget: string;
  videoServiceId: string;
};

type FilmChatSendFailure = {
  message: string;
  detail: string;
};

function describeChatFailure(error: unknown): FilmChatSendFailure {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  if (error instanceof FilmTextTurnAbortedError) {
    return {
      message: "送信を中止しました。入力内容は戻してあります。",
      detail,
    };
  }
  if (error instanceof FilmTextTurnTimeoutError) {
    return {
      message: "AIの返事に時間がかかりすぎました。入力内容は戻したので、もう一度送れます。",
      detail,
    };
  }
  const humanized = humanizeError(error);
  return {
    message: humanized.includes("AIの利用枠")
      ? humanized
      : "AIアドバイザーと通信できませんでした。入力内容は戻したので、もう一度お試しください。",
    detail,
  };
}

function readPremise(artifact: AdvisorArtifact): {
  value: PremiseDraft | null;
  missing: string[];
} {
  const fields = artifact.premiseFields ?? {};
  const title = fieldValue(fields, ["タイトル", "作品タイトル"]);
  const theme = fieldValue(fields, ["伝えたいこと", "一番伝えたいこと", "テーマ"]);
  const durationText = fieldValue(fields, ["目標尺", "目標尺（秒）", "目標の長さ"]);
  const durationMatch = durationText?.match(/\d+/u);
  const targetDurationSeconds = durationMatch ? Number(durationMatch[0]) : 0;
  const characterText = fieldValue(fields, ["登場人物", "人物"]);
  const topicMemo = fieldValue(fields, ["題材", "題材メモ"]);
  const postingTarget = fieldValue(fields, ["投稿先", "公開先"]);
  const serviceText = fieldValue(fields, ["動画サービス", "生成サービス"]);
  const videoServiceId = resolveServiceId(serviceText);
  const missing = [
    !title ? "タイトル" : "",
    !theme ? "伝えたいこと" : "",
    !(targetDurationSeconds >= 1 && targetDurationSeconds <= 3600) ? "目標の長さ（1〜3600秒）" : "",
    characterText === undefined ? "登場人物（いなければ「なし」）" : "",
    topicMemo === undefined ? "題材（なければ「なし」）" : "",
    !postingTarget ? "投稿先" : "",
    !videoServiceId ? "使う動画サービス" : "",
  ].filter(Boolean);
  if (missing.length > 0 || !title || !theme || !postingTarget || !videoServiceId) {
    return { value: null, missing };
  }
  return {
    value: {
      title,
      theme,
      targetDurationSeconds,
      characterNames: splitNames(characterText),
      topicMemo: /^(なし|無し)$/u.test(topicMemo ?? "") ? "" : (topicMemo ?? ""),
      postingTarget,
      videoServiceId,
    },
    missing: [],
  };
}

function artifactReview(
  artifact: AdvisorArtifact,
  project: FilmProject | null,
): { parseError: string | null; issues: ScriptCheckIssue[] } {
  if (!project || artifact.type === "premise" || artifact.type === "logline") {
    return { parseError: null, issues: [] };
  }
  const script = scriptOf(project);
  const targetDurationSeconds = script.targetDurationSeconds ?? 90;
  const characterNames = script.characterNames ?? [];
  if (artifact.type === "beatsheet") {
    return {
      parseError: null,
      issues: validateBeatsheetDuration(artifact.content, targetDurationSeconds),
    };
  }
  if (artifact.type === "treatment") {
    return {
      parseError: null,
      issues: detectCharacterNameVariations(artifact.content, characterNames),
    };
  }
  if (artifact.type === "scenelist") {
    const parsed = parseSceneList(artifact.content);
    if (!parsed.ok) {
      return {
        parseError: `${parsed.error.line}行目: ${parsed.error.reason}`,
        issues: [],
      };
    }
    return {
      parseError: null,
      issues: [
        ...validateSceneDuration(parsed.value, targetDurationSeconds),
        ...detectCharacterNameVariations(artifact.content, characterNames),
      ],
    };
  }
  const parsed = parseBlockScript(artifact.content);
  if (!parsed.ok) {
    return {
      parseError: `${parsed.error.line}行目: ${parsed.error.reason}`,
      issues: [],
    };
  }
  const profile = findVideoServiceProfile(project.videoServiceId);
  const serviceMaxSeconds = profile?.maxBlockSeconds ?? 15;
  const issues = validateBlockScript(
    artifact.content,
    parsed.value.blocks,
    serviceMaxSeconds,
  );
  if (profile?.maxBlockSeconds === null) {
    issues.unshift({
      code: "block-duration-limit",
      severity: "warning",
      message: `${profile.label}はまだ実際に試せていないため、仮の上限15秒で確認しています。`,
    });
  }
  return { parseError: null, issues };
}

function savedArtifactText(
  type: AdvisorArtifactType,
  project: FilmProject,
): string {
  const script = scriptOf(project);
  switch (type) {
    case "logline":
      return script.logline;
    case "beatsheet":
      return script.beatsheet;
    case "treatment":
      return script.treatment;
    case "scenelist":
      return script.scenelistText ?? "";
    case "blocks":
      return script.blockScriptText ?? "";
    case "premise":
      return "";
  }
}

function ArtifactCard({
  artifact,
  project,
  busy,
  onApprove,
  onRevoke,
  onRevise,
}: {
  artifact: AdvisorArtifact;
  project: FilmProject | null;
  busy: boolean;
  onApprove: () => void;
  onRevoke: () => void;
  onRevise: () => void;
}) {
  const premise = artifact.type === "premise" ? readPremise(artifact) : null;
  const review = artifactReview(artifact, project);
  const stage = STAGE_BY_ARTIFACT[artifact.type];
  const approved = Boolean(
    project &&
      stage &&
      project.approvals[stage] &&
      savedArtifactText(artifact.type, project).trim() === artifact.content.trim(),
  );
  const premiseLocked = artifact.type === "premise" && Boolean(project);
  const blocked =
    Boolean(review.parseError) ||
    review.issues.some((issue) => issue.severity === "blocking") ||
    Boolean(premise && premise.missing.length > 0);

  return (
    <section className="mt-3 min-w-0 overflow-hidden rounded-lg border border-pink-500/30 bg-[#151515]">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-[#2b2b2b] bg-pink-500/5 px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-pink-400">
            できあがった内容
          </p>
          <h3 className="mt-0.5 text-xs font-semibold text-zinc-200">
            {ARTIFACT_LABELS[artifact.type]}
          </h3>
          <p className="mt-1 text-[10px] leading-4 text-zinc-500">
            {ARTIFACT_PURPOSES[artifact.type]}
          </p>
        </div>
        {approved || premiseLocked ? (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
            {premiseLocked ? "企画を決めました" : "OK済み"}
          </span>
        ) : null}
      </header>

      {artifact.type === "premise" && artifact.premiseFields ? (
        <dl className="grid min-w-0 gap-2 px-4 py-4 text-xs">
          {Object.entries(artifact.premiseFields).map(([key, value]) => (
            <div key={key} className="grid min-w-0 grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3">
              <dt className="break-words text-zinc-500">{key}</dt>
              <dd className="min-w-0 break-words text-zinc-200">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div
          className={[
            "min-w-0 max-h-80 overflow-y-auto px-4 py-4 font-mono text-xs leading-6 text-zinc-200",
            artifact.type === "scenelist"
              ? "overflow-x-auto whitespace-pre"
              : "overflow-x-hidden whitespace-pre-wrap break-words",
          ].join(" ")}
        >
          {artifact.content}
        </div>
      )}

      {premise && premise.missing.length > 0 ? (
        <div className="mx-4 mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          確定値が足りません: {premise.missing.join("、")}
        </div>
      ) : null}
      {review.parseError ? (
        <div className="mx-4 mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
          書き方を読み取れません（{review.parseError}）。届いた文は残しています。
        </div>
      ) : null}
      <div className="px-4 pb-1">
        <IssueList issues={review.issues} />
      </div>

      {approved ? (
        <footer className="flex flex-wrap gap-2 border-t border-[#2b2b2b] px-4 py-3">
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="rounded-md border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/10 disabled:opacity-40"
          >
            OKを取り消す
          </button>
        </footer>
      ) : !premiseLocked ? (
        <footer className="flex flex-wrap gap-2 border-t border-[#2b2b2b] px-4 py-3">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy || blocked || artifact.type === "premise"}
            className="rounded-md bg-pink-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            これでOK
          </button>
          <button
            type="button"
            onClick={onRevise}
            disabled={busy}
            className="rounded-md border border-[#3a3a3a] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200 disabled:opacity-40"
          >
            一言で直す
          </button>
        </footer>
      ) : null}
    </section>
  );
}

export function FilmChatPanel({ project }: { project: FilmProject | null }) {
  const planningChatMessages = useFilmProjectStore((state) => state.planningChatMessages);
  const appendPlanningChatMessage = useFilmProjectStore((state) => state.appendPlanningChatMessage);
  const appendChatMessage = useFilmProjectStore((state) => state.appendChatMessage);
  const createProject = useFilmProjectStore((state) => state.createProject);
  const saveLogline = useFilmProjectStore((state) => state.saveLogline);
  const saveBeatsheet = useFilmProjectStore((state) => state.saveBeatsheet);
  const saveTreatment = useFilmProjectStore((state) => state.saveTreatment);
  const saveScenelist = useFilmProjectStore((state) => state.saveScenelist);
  const saveBlocks = useFilmProjectStore((state) => state.saveBlocks);
  const approveStage = useFilmProjectStore((state) => state.approveStage);
  const revokeStageApproval = useFilmProjectStore((state) => state.revokeStageApproval);
  const pushToast = useToasts((state) => state.push);

  const messages = project ? (project.chatMessages ?? []) : planningChatMessages;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailure, setSendFailure] = useState<FilmChatSendFailure | null>(null);
  const [revisionTarget, setRevisionTarget] = useState<AdvisorArtifactType | null>(null);
  const [progress, setProgress] = useState<Parameters<typeof ProgressCard>[0]["progress"]>();
  const abortRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);
  const failedUserMessageRef = useRef<{
    conversationId: string;
    message: ReturnType<typeof createFilmChatMessage>;
    revisionTarget: AdvisorArtifactType | null;
  } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // StrictMode の二重 effect でも挨拶が二重にならないよう、
    // レンダ時のスナップショットでなくストアの現在値で空判定する。
    const state = useFilmProjectStore.getState();
    const current = project
      ? (state.projects.find((candidate) => candidate.id === project.id)?.chatMessages ?? [])
      : state.planningChatMessages;
    if (current.length > 0) return;
    const first = createFilmChatMessage(
      "assistant",
      project ? projectResumeMessage(project) : INITIAL_FILM_ADVISOR_MESSAGE,
    );
    if (project) appendChatMessage(first);
    else appendPlanningChatMessage(first);
  }, [appendChatMessage, appendPlanningChatMessage, messages.length, project]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, sending]);

  useEffect(() => {
    setDraft("");
    setRevisionTarget(null);
    runTokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setSendFailure(null);
    setProgress(undefined);
    failedUserMessageRef.current = null;
  }, [project?.id]);

  useEffect(() => () => {
    runTokenRef.current += 1;
    abortRef.current?.abort();
  }, []);

  async function requestTurn(
    text: string,
    revisionOverride: AdvisorArtifactType | null = revisionTarget,
  ) {
    const userText = text.trim();
    if (!userText || sending) return;
    const revisionAtStart = revisionOverride;
    const advisorUserMessage = revisionAtStart
      ? `${ARTIFACT_LABELS[revisionAtStart]}を直してください。修正希望: ${userText}`
      : userText;
    const stateAtStart = useFilmProjectStore.getState();
    const projectAtStart = stateAtStart.projects.find(
      (candidate) => candidate.id === stateAtStart.activeProjectId,
    ) ?? null;
    const conversationId = projectAtStart?.id ?? "planning";
    const previousMessages = projectAtStart?.chatMessages ?? stateAtStart.planningChatMessages;
    const failedMessage = failedUserMessageRef.current;
    const isRetry = Boolean(
      failedMessage
      && failedMessage.conversationId === conversationId
      && failedMessage.message.text === userText
      && failedMessage.revisionTarget === revisionAtStart,
    );
    const userMessage = isRetry && failedMessage
      ? failedMessage.message
      : createFilmChatMessage("user", userText);
    // 失敗した同じ文の再送では、履歴に残っている発言をそのまま再利用する。
    // AIへ渡す過去履歴からだけ一度外し、userMessage として1回分を送る。
    const requestMessages = isRetry
      ? previousMessages.filter((message) => message.id !== userMessage.id)
      : previousMessages;
    if (!isRetry) {
      if (projectAtStart) stateAtStart.appendChatMessage(userMessage);
      else stateAtStart.appendPlanningChatMessage(userMessage);
    }
    failedUserMessageRef.current = null;
    setDraft("");
    setRevisionTarget(null);
    setSendFailure(null);
    setSending(true);
    setProgress({ phase: "waiting", receivedChars: 0 });
    const abort = new AbortController();
    abortRef.current = abort;
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;

    try {
      const response = await runFilmAdvisorTurn(
        {
          project: projectAtStart,
          messages: requestMessages,
          userMessage: advisorUserMessage,
        },
        {
          signal: abort.signal,
          onProgress: (next) => {
            if (runTokenRef.current === runToken) setProgress(next);
          },
        },
      );
      if (runTokenRef.current !== runToken) return;
      const currentState = useFilmProjectStore.getState();
      const currentConversationId = currentState.activeProjectId ?? "planning";
      if (currentConversationId !== conversationId) {
        pushToast({
          kind: "info",
          text: "別の企画へ切り替わったため、前のAI応答は追加しませんでした。",
          ttlMs: 5000,
        });
        return;
      }

      const assistantMessage = createFilmChatMessage("assistant", response.raw);
      if (projectAtStart) {
        currentState.appendChatMessage(assistantMessage);
      } else {
        currentState.appendPlanningChatMessage(assistantMessage);
        const premiseArtifact = response.artifacts.find((artifact) => artifact.type === "premise");
        if (premiseArtifact) {
          const premise = readPremise(premiseArtifact);
          if (premise.value) {
            const chatMessages = [...requestMessages, userMessage, assistantMessage];
            createProject(
              premise.value.title,
              premise.value.theme,
              premise.value.videoServiceId,
              {
                chatMessages,
                postingTarget: premise.value.postingTarget,
                scriptSettings: {
                  targetDurationSeconds: premise.value.targetDurationSeconds,
                  topicMemo: premise.value.topicMemo,
                  characterNames: premise.value.characterNames,
                },
                startInScript: true,
              },
            );
            useFilmProjectStore.getState().appendChatMessage(
              createFilmChatMessage(
                "assistant",
                "企画を決めました。次は一文のあらすじです。避けたい雰囲気があれば一言だけ教えてください。なければ「お任せ」で、こちらから3案出します。",
              ),
            );
          } else {
            pushToast({
              kind: "warn",
              text: `企画の確定値が足りません: ${premise.missing.join("、")}`,
              ttlMs: 7000,
            });
          }
        }
      }
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      setDraft(userText);
      setRevisionTarget(revisionAtStart);
      failedUserMessageRef.current = {
        conversationId,
        message: userMessage,
        revisionTarget: revisionAtStart,
      };
      setSendFailure(describeChatFailure(error));
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      if (runTokenRef.current === runToken) {
        setSending(false);
        setProgress(undefined);
        if (abortRef.current === abort) abortRef.current = null;
      }
    }
  }

  function approveArtifact(artifact: AdvisorArtifact) {
    const currentState = useFilmProjectStore.getState();
    const currentProject = currentState.projects.find(
      (candidate) => candidate.id === currentState.activeProjectId,
    ) ?? null;
    if (!currentProject || artifact.type === "premise") return;
    const stage = STAGE_BY_ARTIFACT[artifact.type];
    if (!stage) return;
    const review = artifactReview(artifact, currentProject);
    if (review.parseError || review.issues.some((issue) => issue.severity === "blocking")) {
      pushToast({
        kind: "warn",
        text: "読み取りエラーか上限超過を直してからOKにしてください。",
        ttlMs: 5000,
      });
      return;
    }
    if (artifact.type === "logline") saveLogline(artifact.content);
    else if (artifact.type === "beatsheet") saveBeatsheet(artifact.content);
    else if (artifact.type === "treatment") saveTreatment(artifact.content);
    else if (artifact.type === "scenelist") {
      const parsed = parseSceneList(artifact.content);
      if (!parsed.ok) return;
      saveScenelist(artifact.content, parsed.value);
    } else if (artifact.type === "blocks") {
      const parsed = parseBlockScript(artifact.content);
      if (!parsed.ok) return;
      saveBlocks(artifact.content, parsed.value.blocks);
    }
    if (!approveStage(stage)) {
      pushToast({
        kind: "warn",
        text: "前のできあがった内容のOKが必要です。ひとつ前から確認してください。",
        ttlMs: 5000,
      });
      return;
    }
    setRevisionTarget(null);
    void requestTurn(
      `この${ARTIFACT_LABELS[artifact.type]}でOKです。次の工程へ進めてください。`,
      null,
    );
  }

  function revokeArtifact(artifact: AdvisorArtifact) {
    const stage = STAGE_BY_ARTIFACT[artifact.type];
    if (!stage) return;
    const confirmed = window.confirm(
      `「${ARTIFACT_LABELS[artifact.type]}」のOKを取り消します。\n\nこの内容より後の脚本と③設計のOKも無効になります。④素材づくり以降へは、前の段階をOKにし直すまで進めません。\n\n書いた文や作成済み画像は消えません。続けますか？`,
    );
    if (!confirmed) return;
    if (!revokeStageApproval(stage)) {
      pushToast({ kind: "warn", text: "OKの状態を更新できませんでした。", ttlMs: 4000 });
    }
  }

  const lastMessageText = messages[messages.length - 1]?.text ?? "";
  const hasMalformedLastResponse = useMemo(() => {
    if (!lastMessageText) return false;
    return parseAdvisorResponse(lastMessageText).malformed;
  }, [lastMessageText]);

  return (
    <div className="mx-auto flex h-full min-h-[620px] w-full min-w-0 max-w-5xl flex-col gap-3">
      <header className="flex min-w-0 items-center justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">
            ①企画・②脚本
          </p>
          <h2 className="mt-1 text-sm font-semibold text-zinc-200">
            AIアドバイザーと話して決める
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            今から企画と物語を順番に決めます。ここでOKにした内容が、あとの映像づくりの土台になります。
          </p>
        </div>
        {project ? (
          <div className="min-w-0 break-words text-right text-[11px] text-zinc-500">
            <p className="break-words">{project.title}</p>
            <p className="break-words">{findVideoServiceProfile(project.videoServiceId)?.label ?? DEFAULT_VIDEO_SERVICE_ID}</p>
          </div>
        ) : null}
      </header>

      <div
        ref={scrollerRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4"
      >
        <ul className="min-w-0 space-y-3">
          {messages.map((message) => {
            const parsed = message.role === "assistant"
              ? parseAdvisorResponse(message.text)
              : null;
            return (
              <li
                key={message.id}
                className={[
                  "min-w-0 rounded-md px-3 py-2 text-sm",
                  message.role === "user"
                    ? "ml-auto max-w-[82%] bg-pink-500/15 text-pink-100"
                    : "max-w-[88%] bg-[#1c1c1c] text-zinc-200",
                ].join(" ")}
              >
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {message.role === "user" ? "あなた" : "AIアドバイザー"}
                </div>
                {parsed?.text ? (
                  <div className="min-w-0 whitespace-pre-wrap break-words leading-6">{parsed.text}</div>
                ) : message.role === "user" ? (
                  <div className="min-w-0 whitespace-pre-wrap break-words leading-6">{message.text}</div>
                ) : null}
                {parsed?.malformed ? (
                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
                    できあがった内容の表示方法を読み取れませんでした。返事は上に丸ごと残しています。
                  </div>
                ) : null}
                {!parsed?.malformed
                  ? parsed?.artifacts.map((artifact, index) => (
                      <ArtifactCard
                        key={`${message.id}-${artifact.type}-${index}`}
                        artifact={artifact}
                        project={project}
                        busy={sending}
                        onApprove={() => approveArtifact(artifact)}
                        onRevoke={() => revokeArtifact(artifact)}
                        onRevise={() => {
                          setRevisionTarget(artifact.type);
                          setDraft("");
                          requestAnimationFrame(() => inputRef.current?.focus());
                        }}
                      />
                    ))
                  : null}
              </li>
            );
          })}
          {sending ? (
            <li className="min-w-0 max-w-[88%] rounded-md bg-[#1c1c1c] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                AIアドバイザー
              </div>
              <ProgressCard
                label="返事"
                progress={progress}
                onCancel={() => abortRef.current?.abort()}
              />
            </li>
          ) : null}
        </ul>
      </div>

      {hasMalformedLastResponse && !sending ? (
        <button
          type="button"
          onClick={() => void requestTurn("さきほどの説明文は変えず、できあがった内容を決められた囲み方でもう一度お願いします。", null)}
          className="w-fit rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
        >
          もう一度お願いする
        </button>
      ) : null}

      {sendFailure && !sending ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
          <p className="font-semibold">{sendFailure.message}</p>
          <details className="mt-1 text-[10px] text-zinc-500">
            <summary className="cursor-pointer">詳しい内容</summary>
            <p className="mt-1 break-all">{sendFailure.detail}</p>
          </details>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
        {revisionTarget ? (
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-pink-500/10 px-3 py-2 text-xs text-pink-200">
            <span className="min-w-0 break-words">
              {ARTIFACT_LABELS[revisionTarget]}を直します。一言で大丈夫です（例: もっと切なく）
            </span>
            <button
              type="button"
              onClick={() => setRevisionTarget(null)}
              className="shrink-0 text-zinc-400 hover:text-white"
            >
              閉じる
            </button>
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const isComposing =
              (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
            if (event.key !== "Enter" || event.shiftKey || isComposing) return;
            event.preventDefault();
            void requestTurn(draft);
          }}
          rows={3}
          placeholder={
            revisionTarget
              ? "例: もっと切なく（Enterで送信・改行はShift+Enter）"
              : "思ったことを一言で…（Enterで送信・改行はShift+Enter）"
          }
          className="w-full min-w-0 resize-none bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void requestTurn(draft)}
            disabled={!draft.trim() || sending}
            className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {sending ? "送信中…" : "送信"}
          </button>
        </div>
      </div>
    </div>
  );
}
