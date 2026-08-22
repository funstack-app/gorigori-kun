import {
  FilmTextTurnAbortedError,
  FilmTextTurnTimeoutError,
  runFilmTextTurn,
  type FilmTextTurnProgress,
} from "./codexText";
import { parseAdvisorResponse, type AdvisorParseResult } from "./advisorParse";
import { buildFilmAdvisorPrompt, getFilmAdvisorStage } from "./advisorPrompts";
import type { FilmChatMessage, FilmProject } from "./types";

export { FilmTextTurnAbortedError, FilmTextTurnTimeoutError };

export const INITIAL_FILM_ADVISOR_MESSAGE = `一緒に、話の種から映像にしていきます。決める順番はこちらで案内します。

まず2つだけ教えてください。
1. 誰の、どんな話にしたいですか？ 断片で大丈夫です。
2. 一番伝えたいことは？ 一言で大丈夫です。

まだ何もなければ「何も決まっていない」と送ってください。こちらから3案出します。`;

export function projectResumeMessage(project: FilmProject): string {
  const stage = getFilmAdvisorStage(project);
  if (stage === "design") {
    return "物語づくりの5工程はOKになりました。次は③設計です。映像の見た目を決めましょう。お手本画像が1枚あると速いです。";
  }
  const labels = {
    logline: "一文のあらすじ",
    beatsheet: "物語の流れ（起きることの順番）",
    treatment: "最初から最後までの物語",
    scenelist: "場面の一覧",
    blocks: "動画1回分ずつの台本",
    premise: "企画",
  } as const;
  return `「${project.title}」の続きから進めます。次は${labels[stage]}です。迷わないよう、こちらから順番に提案します。`;
}

export function createFilmChatMessage(
  role: FilmChatMessage["role"],
  text: string,
): FilmChatMessage {
  const createdAt = new Date().toISOString();
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, role, text: text.trim(), createdAt };
}

export async function runFilmAdvisorTurn(
  input: {
    project: FilmProject | null;
    messages: FilmChatMessage[];
    userMessage: string;
  },
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: FilmTextTurnProgress) => void;
  } = {},
): Promise<AdvisorParseResult> {
  const raw = await runFilmTextTurn(buildFilmAdvisorPrompt(input), {
    label: "映像づくり相談",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return parseAdvisorResponse(raw);
}
