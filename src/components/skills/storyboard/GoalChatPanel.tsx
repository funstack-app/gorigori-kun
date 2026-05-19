import { useEffect, useMemo, useRef, useState } from "react";

import { usePlanChat } from "../../../lib/store/planChat";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useSkillMode } from "../../../lib/store/skillMode";
import { useToasts } from "../../../lib/store/toasts";
import type { StoryboardGoal } from "../../../lib/storyboard/types";

/**
 * Phase 1: GoalChat
 *
 * STΛCK 指示 (2026-05-20):
 *   - agentic UX = AI が「次に何を聞くべきか」を判断して深掘り質問する
 *   - ユーザーは思いつきレベルの一言を投げるだけで OK
 *   - 一定の充足度になったら「ゴールを確定」ボタンを押せる
 *
 * 実装:
 *   - 対話本体は既存 planChat (codex GPT-5.5) を再利用
 *   - planChat 側は ROLE_PREFIX = STORYBOARD_ROLE_PREFIX に切替済み
 *     (useSkillMode.enabled=true + selectedSkillId=gori-storyboard の時)
 *   - 「ゴールを確定」を押すと、現在の対話履歴をローカル要約して
 *     storyboardRun.goal にセット + Phase 2 へ遷移
 */
export function GoalChatPanel() {
  const messages = usePlanChat((s) => s.messages);
  const sending = usePlanChat((s) => s.sending);
  const send = usePlanChat((s) => s.send);
  const ensureThread = usePlanChat((s) => s.ensureThread);
  const storyboardParams = usePlanChat((s) => s.storyboardParams);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const skillEnabled = useSkillMode((s) => s.enabled);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const setPhase = useStoryboardRun((s) => s.setPhase);

  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // ストーリーカットスキルを ON にしておく (planChat の prefix 切替条件)
  useEffect(() => {
    if (!skillEnabled || selectedSkillId !== "gori-storyboard") {
      setSkillId("gori-storyboard");
      setSkillEnabled(true);
    }
  }, [skillEnabled, selectedSkillId, setSkillEnabled, setSkillId]);

  useEffect(() => {
    void ensureThread();
  }, [ensureThread]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages.length]);

  // AI が直近のメッセージで「いま何を聞こうとしているか」を抽出する簡易版。
  // テキストの末尾に出てくる「？」を含む短い文を probing として抜き出す。
  const probingFromAi = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const sentences = m.text.split(/[。\n]/).map((s) => s.trim()).filter(Boolean);
      const lastQ = sentences.reverse().find((s) => /[?？]/.test(s));
      return lastQ ?? null;
    }
    return null;
  }, [messages]);

  // 「ゴール確定」可能か = 数ターン回って AI が storyboardParams を提案できる状態か
  const canFinalize = messages.length >= 4 && !sending;

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await send(text);
  }

  async function handleFinalize() {
    // planChat 側に既に storyboardParams を抽出する仕組みがあるので、
    // それを使えるなら使う。無ければユーザー対話の要約から最低限を組む。
    if (storyboardParams && storyboardParams.character_reference_path) {
      const goal: StoryboardGoal = {
        summary: messages
          .filter((m) => m.role === "assistant")
          .slice(-2)
          .map((m) => m.text)
          .join("\n")
          .slice(0, 400),
        characterDescription: "",
        toneKeywords: [],
        durationSeconds: storyboardParams.duration_seconds,
        aspectRatio: storyboardParams.aspect_ratio,
        tempo: storyboardParams.tempo,
        characterReferencePath: storyboardParams.character_reference_path,
        styleReferencePath: storyboardParams.style_reference_path,
      };
      setGoal(goal);
      setPhase("sketch");
      return;
    }

    // フォールバック: 必要な情報が足りない場合は AI に [FINALIZE_STORYBOARD] を投げる
    await send("[FINALIZE_STORYBOARD] ここまでの内容で確定 JSON を出してください。");
    useToasts.getState().push({
      kind: "info",
      text: "AI に確定 JSON を依頼しました。生成完了後、再度「ゴールを確定」を押してください。",
      ttlMs: 5000,
    });
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Phase 1: ゴール深掘り</h2>
          <p className="mt-1 text-xs text-zinc-500">
            AI が「作りたい映像」を引き出します。思いつきの一言からで OK。
          </p>
          {probingFromAi && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-pink-500/40 bg-pink-500/10 px-3 py-1 text-[11px] text-pink-200">
              <span className="opacity-70">AI が知りたい:</span>
              <span className="font-medium">{probingFromAi}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleFinalize}
          disabled={!canFinalize}
          className={[
            "shrink-0 rounded-md px-4 py-2 text-sm font-semibold transition",
            canFinalize
              ? "bg-pink-500 text-white hover:bg-pink-400"
              : "cursor-not-allowed bg-zinc-700 text-zinc-400",
          ].join(" ")}
        >
          ゴールを確定 →
        </button>
      </header>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4"
      >
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-sm text-zinc-500">
            まずは「どんな映像を作りたいか」を一言投げてみてください。
            <br />
            例: 「朝の光で目覚めるシーンを 15 秒くらいで」
          </div>
        )}
        <ul className="space-y-3">
          {messages.map((m) => (
            <li
              key={m.id}
              className={[
                "rounded-md px-3 py-2 text-sm",
                m.role === "user"
                  ? "ml-auto max-w-[80%] bg-pink-500/15 text-pink-100"
                  : "max-w-[80%] bg-[#1c1c1c] text-zinc-200",
              ].join(" ")}
            >
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {m.role === "user" ? "あなた" : "AI"}
              </div>
              <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
              {m.streaming && (
                <div className="mt-1 text-[10px] text-zinc-500">入力中…</div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-end gap-2 rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
          placeholder="作りたい映像を一言で… (⌘+Enter で送信)"
          className="flex-1 resize-none bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim() || sending}
          className={[
            "rounded-md px-4 py-2 text-sm font-semibold transition",
            !draft.trim() || sending
              ? "cursor-not-allowed bg-zinc-700 text-zinc-400"
              : "bg-pink-500 text-white hover:bg-pink-400",
          ].join(" ")}
        >
          {sending ? "送信中…" : "送信"}
        </button>
      </div>
    </div>
  );
}
