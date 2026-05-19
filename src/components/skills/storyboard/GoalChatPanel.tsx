import { useEffect, useMemo, useRef, useState } from "react";

import { usePlanChat } from "../../../lib/store/planChat";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useSkillMode } from "../../../lib/store/skillMode";
import { useToasts } from "../../../lib/store/toasts";
import type { StoryboardGoal } from "../../../lib/storyboard/types";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function basename(p: string): string {
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] ?? p;
}

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
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const skillEnabled = useSkillMode((s) => s.enabled);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const setPhase = useStoryboardRun((s) => s.setPhase);

  const [draft, setDraft] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  // 「ゴール確定」を押した直後フラグ。JSON 応答が来たら自動で Phase2 に進む。
  const [awaitingFinalize, setAwaitingFinalize] = useState(false);
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
  // awaitingFinalize 中は再クリックを防ぐため無効化する
  const canFinalize = messages.length >= 4 && !sending && !awaitingFinalize;

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    const images = attachedImages.slice();
    setDraft("");
    setAttachedImages([]);
    await send(text, images.length > 0 ? images : undefined);
  }

  async function pickImages() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = (Array.isArray(r) ? r : [r]).filter(
        (p): p is string => typeof p === "string",
      );
      if (paths.length === 0) return;
      setAttachedImages((prev) => {
        // 重複を弾く
        const set = new Set(prev);
        for (const p of paths) set.add(p);
        return Array.from(set);
      });
    } catch (err) {
      useToasts.getState().push({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  function removeAttachment(path: string) {
    setAttachedImages((prev) => prev.filter((p) => p !== path));
  }

  // ストア状態を見て StoryboardGoal を組み立てる共通関数。
  // 「storyboardParams + sceneConstruction が揃っている」前提。
  function buildAndAdvance() {
    const params = usePlanChat.getState().storyboardParams;
    const scene = usePlanChat.getState().sceneConstruction;
    if (!params || !scene) return false;
    const goal: StoryboardGoal = {
      summary: messages
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m) => m.text)
        .join("\n")
        .slice(0, 400),
      characterDescription: "",
      toneKeywords: [],
      durationSeconds: params.duration_seconds,
      aspectRatio: params.aspect_ratio,
      tempo: params.tempo,
      characterReferencePath: params.character_reference_path || "",
      styleReferencePath: params.style_reference_path,
    };
    setGoal(goal);
    setPhase("sketch");
    useToasts.getState().push({
      kind: "success",
      text: "ゴールを確定しました。絵コンテレビューに進みます。",
      ttlMs: 3000,
    });
    return true;
  }

  async function handleFinalize() {
    // STΛCK 指示 (2026-05-20):
    //  - Phase 1 では画像必須にしない (構想段階)
    //  - scene_construction (カット列) が揃えば Phase 2 へ進む
    //  - 「2 回押し」を撲滅: 1 回目で AI に JSON 要求 → 応答後に自動で Phase2 へ
    if (storyboardParams && sceneConstruction) {
      buildAndAdvance();
      return;
    }

    // まだ JSON が無い → AI に要求して、応答が来たら自動遷移するモードに入る
    setAwaitingFinalize(true);
    useToasts.getState().push({
      kind: "info",
      text: "AI に絵コンテ構成を依頼しています…応答後、自動で絵コンテに進みます。",
      ttlMs: 4000,
    });
    await send("[FINALIZE_STORYBOARD] ここまでの内容で確定 JSON を出してください。");
  }

  // AI 応答で storyboardParams + sceneConstruction が揃ったタイミングで
  // awaitingFinalize なら自動で Phase 2 に進める。
  useEffect(() => {
    if (!awaitingFinalize) return;
    if (storyboardParams && sceneConstruction && !sending) {
      const ok = buildAndAdvance();
      if (ok) setAwaitingFinalize(false);
    }
  // buildAndAdvance は内部で getState() を使うので依存に入れない
  // (毎レンダーで参照が変わって無限ループになるのを防ぐ)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingFinalize, storyboardParams, sceneConstruction, sending]);

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
          {awaitingFinalize ? "AI 応答待ち…" : "ゴールを確定 →"}
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

      <div className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
        {attachedImages.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {attachedImages.map((p) => (
              <li
                key={p}
                className="group relative flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1"
              >
                <img
                  src={`asset://localhost/${encodeURI(p)}`}
                  alt={basename(p)}
                  className="h-8 w-8 rounded object-cover"
                />
                <span className="max-w-[140px] truncate text-[11px] text-zinc-300">
                  {basename(p)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(p)}
                  className="rounded p-0.5 text-zinc-500 hover:bg-pink-500/10 hover:text-pink-300"
                  title="添付を解除"
                  aria-label="添付を解除"
                >
                  <IconClose />
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={4}
          placeholder="作りたい映像を一言で… (⌘+Enter で送信)"
          className="w-full resize-none bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={pickImages}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#2a2a2a] px-2.5 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/40 hover:text-pink-200"
            title="参照画像を添付"
            aria-label="参照画像を添付"
          >
            <IconPaperclip />
            <span>画像を添付</span>
          </button>
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
    </div>
  );
}

// Lucide 風アイコン (viewBox 24, stroke 2, line caps round)
// 絵文字禁止ルールに従い、既存トンマナと揃える。
function IconPaperclip() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
