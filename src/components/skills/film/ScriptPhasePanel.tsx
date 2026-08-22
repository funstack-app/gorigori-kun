import { useEffect, useMemo, useRef, useState } from "react";

import {
  FilmTextTurnAbortedError,
  FilmTextTurnTimeoutError,
  runFilmTextTurn,
  type FilmTextTurnLabel,
  type FilmTextTurnProgress,
} from "../../../lib/film/codexText";
import {
  detectCharacterNameVariations,
  parseBlockScript,
  parseSceneList,
  validateBeatsheetDuration,
  validateBlockScript,
  validateSceneDuration,
  type ScriptCheckIssue,
  type ScriptParseFailure,
} from "../../../lib/film/scriptParse";
import {
  buildBeatsheetPrompt,
  buildBlockScriptPrompt,
  buildBlockScriptRepairPrompt,
  buildLoglinePrompt,
  buildScenelistPrompt,
  buildTreatmentPrompt,
  formatBlocksAsScript,
  formatScenesAsScenelist,
} from "../../../lib/film/scriptPrompts";
import { findVideoServiceProfile } from "../../../lib/film/serviceProfiles";
import type { FilmProject, FilmScript } from "../../../lib/film/types";
import {
  useFilmProjectStore,
  type FilmScriptApprovalStage,
} from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";

type StageDefinition = {
  id: FilmScriptApprovalStage;
  name: string;
  purpose: string;
  turnLabel: FilmTextTurnLabel;
  gateQuestion: string;
};

const STAGES: StageDefinition[] = [
  {
    id: "logline",
    name: "一文のあらすじ",
    purpose: "これを書くと、物語の魅力を一目で伝えられます。",
    turnLabel: "一文のあらすじ",
    gateQuestion: "観たいと思えますか？",
  },
  {
    id: "beatsheet",
    name: "物語の流れ（起きることの順番）",
    purpose: "今から起きることを順番に並べ、物語の山と終わりを決めます。",
    turnLabel: "物語の流れ",
    gateQuestion: "物語の山と流れに納得できますか？",
  },
  {
    id: "treatment",
    name: "最初から最後までの物語",
    purpose: "これを書くと、最初から最後までの映像を具体的に思い描けます。",
    turnLabel: "最初から最後までの物語",
    gateQuestion: "最初から最後まで、映像が浮かびますか？",
  },
  {
    id: "scenelist",
    name: "場面の一覧",
    purpose: "今から場所ごとに場面を分け、長さと登場人物を確かめます。",
    turnLabel: "場面の一覧",
    gateQuestion: "場所・目的・登場人物・長さに無理はありませんか？",
  },
  {
    id: "blocks",
    name: "動画1回分ずつの台本",
    purpose: "これを書くと、AIが一度に作る動画ごとの内容が決まります。",
    turnLabel: "動画1回分ずつの台本",
    gateQuestion: "この分け方で映像を作れそうですか？",
  },
];

function emptyScript(): FilmScript {
  return {
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
  };
}

function parseTargetDuration(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return null;
  const seconds = Number(normalized);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) return null;
  return seconds;
}

function splitCharacterNames(value: string): string[] {
  return value
    .split(/[、,\n]/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function parseLoglineOptions(raw: string): string[] {
  const numbered = [...raw.matchAll(/(?:^|\n)\s*案\s*[1-3]\s*[:：]\s*(.+)/gu)].map(
    (match) => match[1].trim(),
  );
  if (numbered.length >= 3) return numbered.slice(0, 3);
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:案\s*)?[1-3][.：:]\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function getStageText(stage: FilmScriptApprovalStage, script: FilmScript): string {
  switch (stage) {
    case "logline":
      return script.logline;
    case "beatsheet":
      return script.beatsheet;
    case "treatment":
      return script.treatment;
    case "scenelist":
      return script.scenelistText ?? formatScenesAsScenelist(script.scenes);
    case "blocks":
      return script.blockScriptText ?? formatBlocksAsScript(script.blocks, script.scenes);
  }
}

function parseFailureMessage(failure: ScriptParseFailure): string {
  return `${failure.error.line}行目: ${failure.error.reason}`;
}

export function ProgressCard({
  label,
  progress,
  onCancel,
}: {
  label: string;
  progress?: FilmTextTurnProgress;
  onCancel: () => void;
}) {
  const stalled = progress?.phase === "stalled";
  return (
    <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-[#303030] bg-[#141414] px-6 py-5">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
      <p className={`text-xs font-semibold ${stalled ? "text-amber-300" : "text-pink-300"}`}>
        {stalled
          ? "応答が止まっています"
          : progress?.phase === "streaming"
            ? `${label}を書き出し中…`
            : "AIの応答を待っています…"}
      </p>
      <p className="text-center text-[11px] text-zinc-500">
        {stalled
          ? `${Math.round((progress.idleMs ?? 0) / 1000)}秒ぶん応答がありません（${progress.receivedChars.toLocaleString()}文字を受信済み・待てば続くことがあります）`
          : progress?.phase === "streaming"
            ? `${progress.receivedChars.toLocaleString()}文字を受信`
            : "最初の返事が届くまで、そのままお待ちください"}
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-[#3a3a3a] px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-[#242424] hover:text-white"
      >
        中止
      </button>
    </div>
  );
}

export function IssueList({ issues }: { issues: ScriptCheckIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <p className="text-xs font-semibold text-amber-200">自動チェックからの確認メモ</p>
      <ul className="mt-2 grid gap-1.5 text-xs leading-5 text-amber-100/90">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.location ?? "all"}-${index}`}>
            ・{issue.message}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-amber-200/70">
        上限超過以外は注意のお知らせだけです。内容を見て、問題なければOKにできます。
      </p>
    </div>
  );
}

export function ScriptPhasePanel({ project }: { project: FilmProject }) {
  const saveScriptSettings = useFilmProjectStore((state) => state.saveScriptSettings);
  const saveLogline = useFilmProjectStore((state) => state.saveLogline);
  const saveBeatsheet = useFilmProjectStore((state) => state.saveBeatsheet);
  const saveTreatment = useFilmProjectStore((state) => state.saveTreatment);
  const saveScenelist = useFilmProjectStore((state) => state.saveScenelist);
  const saveBlocks = useFilmProjectStore((state) => state.saveBlocks);
  const approveStage = useFilmProjectStore((state) => state.approveStage);
  const pushToast = useToasts((state) => state.push);

  const script = Array.isArray(project.script) ? emptyScript() : project.script;
  const selectedVideoService = findVideoServiceProfile(project.videoServiceId);
  const serviceMaxSeconds = selectedVideoService?.maxBlockSeconds ?? 15;
  const usesProvisionalServiceLimit = selectedVideoService?.maxBlockSeconds === null;
  const [targetDuration, setTargetDuration] = useState(
    String(script.targetDurationSeconds ?? 90),
  );
  const [targetDurationError, setTargetDurationError] = useState<string | null>(null);
  const [topicMemo, setTopicMemo] = useState(script.topicMemo ?? "");
  const [characterNamesText, setCharacterNamesText] = useState(
    (script.characterNames ?? []).join("、"),
  );
  const [expanded, setExpanded] = useState<Partial<Record<FilmScriptApprovalStage, boolean>>>({});
  const [loglineOptions, setLoglineOptions] = useState<string[]>([]);
  const [revisionStage, setRevisionStage] = useState<FilmScriptApprovalStage | null>(null);
  const [revisionNotes, setRevisionNotes] = useState<Partial<Record<FilmScriptApprovalStage, string>>>({});
  const [runningStage, setRunningStage] = useState<FilmScriptApprovalStage | null>(null);
  const [progress, setProgress] = useState<FilmTextTurnProgress | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);

  useEffect(() => {
    const currentScript = Array.isArray(project.script) ? emptyScript() : project.script;
    setTargetDuration(String(currentScript.targetDurationSeconds ?? 90));
    setTargetDurationError(null);
    setTopicMemo(currentScript.topicMemo ?? "");
    setCharacterNamesText((currentScript.characterNames ?? []).join("、"));
    setLoglineOptions([]);
    setExpanded({});
    setRevisionStage(null);
    setRevisionNotes({});
  }, [project.id]);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const characterNames = useMemo(
    () => splitCharacterNames(characterNamesText),
    [characterNamesText],
  );
  const targetDurationForChecks =
    parseTargetDuration(targetDuration) ?? script.targetDurationSeconds ?? 90;

  function persistSettings(): number | null {
    const parsedTargetDuration = parseTargetDuration(targetDuration);
    const savedTargetDuration = script.targetDurationSeconds ?? 90;
    if (parsedTargetDuration === null) {
      setTargetDurationError("1〜3600の整数で入力してください。");
    } else {
      setTargetDurationError(null);
      setTargetDuration(String(parsedTargetDuration));
    }
    saveScriptSettings({
      targetDurationSeconds: parsedTargetDuration ?? savedTargetDuration,
      topicMemo,
      characterNames,
    });
    return parsedTargetDuration;
  }

  function stageIssues(stage: FilmScriptApprovalStage): ScriptCheckIssue[] {
    const text = getStageText(stage, script);
    if (!text.trim()) return [];
    if (stage === "beatsheet") {
      return validateBeatsheetDuration(text, targetDurationForChecks);
    }
    if (stage === "treatment") {
      return detectCharacterNameVariations(text, characterNames);
    }
    if (stage === "scenelist") {
      const parsed = parseSceneList(text);
      if (!parsed.ok) return [];
      return [
        ...validateSceneDuration(parsed.value, targetDurationForChecks),
        ...detectCharacterNameVariations(text, characterNames),
      ];
    }
    if (stage === "blocks") {
      const parsed = parseBlockScript(text);
      if (!parsed.ok) return [];
      const issues = validateBlockScript(text, parsed.value.blocks, serviceMaxSeconds);
      if (!usesProvisionalServiceLimit) return issues;
      return [
        {
          code: "block-duration-limit",
          severity: "warning",
          message: `${selectedVideoService?.label ?? "選んだサービス"}はまだ実際に試せていないため、仮の上限15秒で確認しています。映像を作る前に、公式案内に合わせた設定を用意してください。`,
        },
        ...issues,
      ];
    }
    return [];
  }

  function stageParseFailure(stage: FilmScriptApprovalStage): ScriptParseFailure | null {
    const text = getStageText(stage, script);
    if (!text.trim()) return null;
    if (stage === "scenelist") {
      const parsed = parseSceneList(text);
      return parsed.ok ? null : parsed;
    }
    if (stage === "blocks") {
      const parsed = parseBlockScript(text);
      return parsed.ok ? null : parsed;
    }
    return null;
  }

  function saveStageText(stage: FilmScriptApprovalStage, value: string) {
    switch (stage) {
      case "logline":
        saveLogline(value);
        break;
      case "beatsheet":
        saveBeatsheet(value);
        break;
      case "treatment":
        saveTreatment(value);
        break;
      case "scenelist": {
        const parsed = parseSceneList(value);
        saveScenelist(value, parsed.ok ? parsed.value : []);
        break;
      }
      case "blocks": {
        const parsed = parseBlockScript(value);
        saveBlocks(value, parsed.ok ? parsed.value.blocks : []);
        break;
      }
    }
  }

  async function generateStage(definition: StageDefinition) {
    if (runningStage) return;
    const targetDurationSeconds = persistSettings();
    if (targetDurationSeconds === null) {
      pushToast({
        kind: "warn",
        text: "目標の長さを1〜3600の整数で入力してください。",
        ttlMs: 5000,
      });
      return;
    }
    const revisionNote = revisionNotes[definition.id]?.trim();
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunningStage(definition.id);
    setProgress(undefined);

    const progressOptions = {
      label: definition.turnLabel,
      signal: abort.signal,
      onProgress: (nextProgress: FilmTextTurnProgress) => {
        if (runTokenRef.current === runToken) setProgress(nextProgress);
      },
    };

    try {
      let prompt: string;
      switch (definition.id) {
        case "logline":
          prompt = buildLoglinePrompt({
            title: project.title,
            theme: project.theme,
            topicMemo,
            revisionNote,
          });
          break;
        case "beatsheet":
          prompt = buildBeatsheetPrompt({
            approvedLogline: script.logline,
            targetDurationSeconds,
            revisionNote,
          });
          break;
        case "treatment":
          prompt = buildTreatmentPrompt({
            approvedBeatsheet: script.beatsheet,
            characterNames,
            revisionNote,
          });
          break;
        case "scenelist":
          prompt = buildScenelistPrompt({
            approvedTreatment: script.treatment,
            targetDurationSeconds,
            characterNames,
            revisionNote,
          });
          break;
        case "blocks":
          prompt = buildBlockScriptPrompt({
            approvedScenes: script.scenes,
            approvedScenelistText: script.scenelistText ?? "",
            serviceMaxSeconds,
            revisionNote,
          });
          break;
      }

      let raw = await runFilmTextTurn(prompt, progressOptions);
      if (runTokenRef.current !== runToken) return;

      if (definition.id === "logline") {
        const options = parseLoglineOptions(raw);
        setLoglineOptions(options);
        if (options.length < 3) {
          pushToast({
            kind: "warn",
            text: "一文のあらすじを3案に分けきれませんでした。届いた文章は表示しています。必要ならもう一度お試しください。",
            ttlMs: 6000,
          });
        }
      } else if (definition.id === "beatsheet") {
        saveBeatsheet(raw.trim());
      } else if (definition.id === "treatment") {
        saveTreatment(raw.trim());
      } else if (definition.id === "scenelist") {
        raw = raw.trim();
        const parsed = parseSceneList(raw);
        saveScenelist(raw, parsed.ok ? parsed.value : []);
        if (!parsed.ok) {
          pushToast({
            kind: "warn",
            text: `場面の一覧の書き方を読み取れませんでした（${parseFailureMessage(parsed)}）。届いた文を表示するので、その場で直せます。`,
            ttlMs: 7000,
          });
        }
      } else {
        raw = raw.trim();
        let parsed = parseBlockScript(raw);
        if (!parsed.ok) {
          const repaired = await runFilmTextTurn(
            buildBlockScriptRepairPrompt(raw, parseFailureMessage(parsed)),
            progressOptions,
          );
          if (runTokenRef.current !== runToken) return;
          raw = repaired.trim();
          parsed = parseBlockScript(raw);
        }
        saveBlocks(raw, parsed.ok ? parsed.value.blocks : []);
        if (!parsed.ok) {
          pushToast({
            kind: "warn",
            text: `書き方の直しを1回試しましたが読み取れませんでした（${parseFailureMessage(parsed)}）。届いた文は消さずに表示しています。`,
            ttlMs: 8000,
          });
        }
      }
      setRevisionStage(null);
      setRevisionNotes((notes) => ({ ...notes, [definition.id]: "" }));
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error instanceof FilmTextTurnAbortedError) {
        pushToast({ kind: "info", text: error.message, ttlMs: 3000 });
      } else {
        pushToast({
          kind: "error",
          text:
            error instanceof FilmTextTurnTimeoutError
              ? error.message
              : `${definition.name}の作成に失敗しました: ${(error as Error)?.message ?? error}`,
          ttlMs: 7000,
        });
      }
    } finally {
      if (runTokenRef.current === runToken) {
        setRunningStage(null);
        setProgress(undefined);
        if (abortRef.current === abort) abortRef.current = null;
      }
    }
  }

  function approve(definition: StageDefinition) {
    const parseFailure = stageParseFailure(definition.id);
    const issues = stageIssues(definition.id);
    if (parseFailure || issues.some((issue) => issue.severity === "blocking")) return;
    if (!approveStage(definition.id)) {
      pushToast({
        kind: "warn",
        text: "前の段階のOKか、読み取れる文が必要です。ひとつ前から確認してください。",
        ttlMs: 5000,
      });
      return;
    }
    setExpanded((current) => ({ ...current, [definition.id]: false }));
    setRevisionStage(null);
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">② 脚本</p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">五つのOKで物語を固める</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          今から物語を固めます。ここでOKにした文が、すべての映像の土台になります。
        </p>
      </div>

      <section className="min-w-0 rounded-xl border border-[#292929] bg-[#171717] p-5">
        <h3 className="text-sm font-semibold text-zinc-200">脚本の前提</h3>
        <p className="mt-1 text-xs text-zinc-500">AIが秒数と人名をそろえるための基準です。</p>
        <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-zinc-300">目標の長さ（秒）</span>
            <input
              type="number"
              min={1}
              max={3600}
              step={1}
              value={targetDuration}
              onChange={(event) => {
                setTargetDuration(event.target.value);
                setTargetDurationError(null);
              }}
              onBlur={persistSettings}
              aria-invalid={Boolean(targetDurationError)}
              aria-describedby={targetDurationError ? "film-target-duration-error" : undefined}
              className="h-10 min-w-0 rounded-md border border-[#303030] bg-[#121212] px-3 text-sm text-zinc-100 outline-none focus:border-pink-500"
            />
            {targetDurationError ? (
              <span id="film-target-duration-error" role="alert" className="text-xs text-amber-300">
                {targetDurationError}
              </span>
            ) : null}
          </label>
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-zinc-300">登場人物名</span>
            <input
              value={characterNamesText}
              onChange={(event) => setCharacterNamesText(event.target.value)}
              onBlur={persistSettings}
              placeholder="例：美咲、蓮"
              className="h-10 min-w-0 rounded-md border border-[#303030] bg-[#121212] px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-pink-500"
            />
          </label>
        </div>
        <label className="mt-4 grid min-w-0 gap-1.5">
          <span className="text-xs font-medium text-zinc-300">題材メモ（任意）</span>
          <input
            value={topicMemo}
            onChange={(event) => setTopicMemo(event.target.value)}
            onBlur={persistSettings}
            placeholder="例：雨上がりの駅、渡せなかった封筒"
            className="h-10 min-w-0 rounded-md border border-[#303030] bg-[#121212] px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-pink-500"
          />
        </label>
      </section>

      <div className="grid min-w-0 gap-4">
        {STAGES.map((definition, index) => {
          const previousStage = STAGES[index - 1]?.id;
          const available = index === 0 || Boolean(project.approvals[previousStage]);
          if (!available) return null;
          const approved = Boolean(project.approvals[definition.id]);
          const isExpanded = !approved || Boolean(expanded[definition.id]);
          const text = getStageText(definition.id, script);
          const issues = stageIssues(definition.id);
          const parseFailure = stageParseFailure(definition.id);
          const blocking = Boolean(parseFailure) || issues.some((issue) => issue.severity === "blocking");
          const generating = runningStage === definition.id;

          if (!isExpanded) {
            return (
              <button
                key={definition.id}
                type="button"
                onClick={() => setExpanded((current) => ({ ...current, [definition.id]: true }))}
                className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-left transition hover:border-emerald-500/50"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm text-emerald-300">✓</span>
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-100">
                    {index + 1}. {definition.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-zinc-500">{text}</span>
                </span>
                <span className="text-xs text-zinc-500">開く</span>
              </button>
            );
          }

          return (
            <section key={definition.id} className="min-w-0 rounded-xl border border-[#2b2b2b] bg-[#171717] p-5">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-pink-400">脚本 {index + 1}/5</p>
                  <h3 className="mt-1 break-words text-lg font-semibold text-zinc-100">
                    {definition.name}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{definition.purpose}</p>
                </div>
                {approved ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [definition.id]: false }))}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    畳む
                  </button>
                ) : null}
              </div>

              {approved ? (
                <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-100">
                  このOK済みの内容を編集すると、この段階以降のOKをやり直します。書いた文は消えません。
                </div>
              ) : null}

              {!text.trim() && !(definition.id === "logline" && loglineOptions.length > 0) ? (
                <button
                  type="button"
                  onClick={() => void generateStage(definition)}
                  disabled={Boolean(runningStage)}
                  className="mt-5 inline-flex items-center gap-2 rounded-md bg-pink-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {generating ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
                  ) : null}
                  AIで{definition.name}を書く
                </button>
              ) : null}

              {definition.id === "logline" && loglineOptions.length > 0 ? (
                <div className="mt-5 grid min-w-0 gap-3">
                  <p className="text-xs font-medium text-zinc-300">3案から、いちばん観たい案を選んでください。</p>
                  {loglineOptions.map((option, optionIndex) => (
                    <button
                      key={`${optionIndex}-${option}`}
                      type="button"
                      onClick={() => {
                        saveLogline(option);
                        setLoglineOptions([]);
                      }}
                      className="min-w-0 break-words rounded-lg border border-[#323232] bg-[#121212] px-4 py-3 text-left text-sm leading-6 text-zinc-200 transition hover:border-pink-500/70 hover:bg-pink-500/5"
                    >
                      <span className="mr-2 font-semibold text-pink-300">案{optionIndex + 1}</span>
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}

              {text.trim() ? (
                <div className="mt-5 min-w-0">
                  <label className="grid min-w-0 gap-2">
                    <span className="text-xs font-medium text-zinc-400">できあがった文（そのまま直せます）</span>
                    <textarea
                      value={text}
                      onChange={(event) => saveStageText(definition.id, event.target.value)}
                      rows={definition.id === "logline" ? 4 : definition.id === "blocks" ? 22 : 13}
                      spellCheck={false}
                      className="w-full min-w-0 resize-y whitespace-pre-wrap break-words rounded-lg border border-[#303030] bg-[#111111] px-4 py-3 font-mono text-sm leading-6 text-zinc-200 outline-none transition focus:border-pink-500 focus:ring-1 focus:ring-pink-500/30"
                    />
                  </label>

                  {parseFailure ? (
                    <div className="mt-4 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-100">
                      書き方を読み取れません（{parseFailureMessage(parseFailure)}）。届いた文は残しています。行を直すともう一度確認します。
                    </div>
                  ) : null}
                  <IssueList issues={issues} />

                  <div className="mt-5 border-t border-[#292929] pt-4">
                    <p className="text-sm font-semibold text-zinc-200">{definition.gateQuestion}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => approve(definition)}
                        disabled={blocking || Boolean(runningStage)}
                        title={blocking ? "書き方のエラーまたは動画サービスの長さ制限を先に直してください" : undefined}
                        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                      >
                        OKで次へ
                      </button>
                      <button
                        type="button"
                        onClick={() => setRevisionStage(definition.id)}
                        disabled={Boolean(runningStage)}
                        className="rounded-md border border-[#3a3a3a] px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-[#242424] disabled:opacity-40"
                      >
                        直したい
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {revisionStage === definition.id ? (
                <div className="mt-4 min-w-0 rounded-lg border border-[#303030] bg-[#121212] p-4">
                  <label className="grid min-w-0 gap-2">
                    <span className="text-xs font-medium text-zinc-300">どう直したいですか？</span>
                    <input
                      value={revisionNotes[definition.id] ?? ""}
                      onChange={(event) =>
                        setRevisionNotes((notes) => ({ ...notes, [definition.id]: event.target.value }))
                      }
                      placeholder="もっと切なく"
                      className="h-10 min-w-0 rounded-md border border-[#303030] bg-[#171717] px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-pink-500"
                    />
                  </label>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    一言で大丈夫です（例: もっと切なく）
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void generateStage(definition)}
                      disabled={!revisionNotes[definition.id]?.trim() || Boolean(runningStage)}
                      className="rounded-md bg-pink-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      この一言で書き直す
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevisionStage(null)}
                      className="rounded-md px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      閉じる
                    </button>
                  </div>
                </div>
              ) : null}

              {generating ? (
                <ProgressCard
                  label={definition.name}
                  progress={progress}
                  onCancel={() => abortRef.current?.abort()}
                />
              ) : null}
            </section>
          );
        })}
      </div>

      {project.approvals.blocks ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
          <p className="text-sm font-semibold text-emerald-200">物語づくりの5段階がすべてOKになりました</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            左の工程一覧から③設計へ進めます（映像の見た目・素材の一覧・共通の見た目指定）。
          </p>
        </div>
      ) : null}
    </div>
  );
}
