import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useComposer } from "../lib/store/composer";
import { images } from "../lib/ipc";
import { usePlanChat, type PlanMessage } from "../lib/store/planChat";
import { useScenePromptOverride } from "../lib/store/scenePrompt";
import { useSkillMode } from "../lib/store/skillMode";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
/**
 * 企画ワークスペース。
 *
 * GPT-5.5 と対話しながら画像生成プロンプトを詰める ChatGPT 風 UI。
 * 裏側は usePlanChat（codex app-server に独立した plan thread を起こす）。
 *
 * 「採用」ボタン:
 *   - 直近 assistant メッセージ全文を composer.text に上書き
 *   - 自動で生成タブに切り替え
 *   - シーン構築のアスペクト等の設定はスキップ
 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function isImageFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

async function fileToImagePath(file: File): Promise<string | null> {
  const directPath = (file as unknown as { path?: string }).path;
  if (directPath) return directPath;
  if (!file.type.startsWith("image/") && !isImageFileName(file.name)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return images.writeUpload(file.name || `plan-chat-${Date.now()}.png`, bytes);
}

function stripStoryboardParams(text: string): string {
  return text.replace(/\n?\[STORYBOARD_PARAMS\][\s\S]*$/g, "").trim();
}

export function PlanWorkspace() {
  const messages = usePlanChat((s) => s.messages);
  const sending = usePlanChat((s) => s.sending);
  const starting = usePlanChat((s) => s.starting);
  const pendingImages = usePlanChat((s) => s.pendingImages);
  const send = usePlanChat((s) => s.send);
  const attach = usePlanChat((s) => s.attach);
  const resetThread = usePlanChat((s) => s.resetThread);
  const addPendingImages = usePlanChat((s) => s.addPendingImages);
  const removePendingImage = usePlanChat((s) => s.removePendingImage);
  const storyboardParams = usePlanChat((s) => s.storyboardParams);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);

  const setText = useComposer((s) => s.setText);
  const setScenePromptOverride = useScenePromptOverride((s) => s.set);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const pushToast = useToasts((s) => s.push);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void attach();
  }, [attach]);

  /**
   * (配布前クリーニング 2026-05-15: 一度だけ実行のリカバリーコードは個人情報を含むため削除済み)
   */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  /**
   * ストーリーカットスキル判定。
   *
   * STΛCK 指示 (2026-05-15):
   *  - 自動遷移は完全に廃止 (企画タブに戻れなくなる原因だった)
   *  - 確定ボタン押下後の遷移は handleFinalize 内のレスポンス到着時のみ実行
   *  - 企画タブには自由に行き来できる
   */
  const skillEnabled = useSkillMode((s) => s.enabled);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const isStoryboardSkill =
    skillEnabled && selectedSkillId === "gori-storyboard";

  const addFiles = async (files: FileList | File[]) => {
    const paths: string[] = [];
    for (const file of Array.from(files)) {
      const path = await fileToImagePath(file);
      if (path) paths.push(path);
    }
    if (paths.length === 0) {
      pushToast({ kind: "error", text: "画像ファイルを選んでください。", ttlMs: 3000 });
      return;
    }
    addPendingImages(paths);
    pushToast({ kind: "success", text: `${paths.length} 枚を企画チャットに添付しました`, ttlMs: 2400 });
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text && pendingImages.length === 0) return;
    setDraft("");
    await send(text || "添付画像を参照してください。", pendingImages);
  };

  /**
   * 「確定」ボタン押下時の処理 (ストーリーカットスキル専用)。
   *
   * STΛCK 指示 (2026-05-15):
   *  AI に「今までの内容を確定形式の JSON で出して」と最終リクエストを送り、
   *  返信に [STORYBOARD_PARAMS] が含まれた段階で生成タブへ自動遷移する。
   *  (storyboardParams 検知は planChat store 側のロジックが既にやっている)
   */
  const handleFinalize = async () => {
    if (sending || starting) return;
    // STΛCK 指示 (2026-05-15):
    //  AI が Phase C で具体描写の構成を出していることが前提。
    //  この finalize メッセージで、その構成を **そのまま** JSON 化させる。
    //  仮の抽象的な構成を出してきたら ★失敗扱い★ にしてユーザーに再試行を促す。
    await send(
      [
        "[FINALIZE_STORYBOARD]",
        "",
        "これまでの対話で提示したカット構成 (Phase C の番号付きリスト) を、",
        "そのまま JSON にコピーして返答末尾に出してください。",
        "",
        "重要な制約:",
        "- description には Phase C で書いた具体的な描写文字列をそのまま入れる",
        "  (「展開を進める」「冒頭: 状況提示」などの抽象テンプレは絶対 NG)",
        "- duration_seconds は Phase C で書いた秒数をそのまま使う",
        "- cuts.length は Phase C のカット数と一致させる (最低 8 個以上)",
        "",
        "返答末尾に必ず以下の1行を出力:",
        "[STORYBOARD_PARAMS] { ... 構造化JSON ... }",
      ].join("\n"),
    );
  };

  const adopt = (text: string) => {
    const cleanText = stripStoryboardParams(text);
    setScenePromptOverride(cleanText);
    setText(cleanText);
    if (storyboardParams && sceneConstruction) {
      setSkillEnabled(true);
      setSelectedSkillId("gori-storyboard");
    }
    setActiveTab("generate");
    pushToast({
      kind: "success",
      text: storyboardParams ? "動画パラメータを採用し、生成タブへ送信しました。" : "企画から採用しました。生成タブに切り替えました。",
      ttlMs: 2400,
    });
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      {/*
        ステータスバッジとリセットは右上にフローティング配置。
        ・チャットバブルと被らないよう、scroll エリア外側の上端にオーバーレイ。
        ・スクロールしても固定位置のまま見える。
      */}
      {(starting || storyboardParams || messages.length > 0) && (
        <div className="pointer-events-none absolute right-4 top-2 z-20 flex items-center gap-2">
          {starting && (
            <span className="rounded bg-pink-500/20 px-2 py-0.5 text-[10px] font-bold text-pink-200 backdrop-blur">
              GPT-5.5 接続中…
            </span>
          )}
          {storyboardParams && (
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-200 backdrop-blur">
              動画パラメータ取得済み
            </span>
          )}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                // ストーリーカットスキルがアクティブな場合は「全リセット」(企画 + 構成 + run + スキルモード)。
                // 通常モードはチャットだけリセット。
                if (isStoryboardSkill) {
                  if (
                    window.confirm(
                      "ストーリーカットを最初からやり直しますか？\n(企画チャット・確定済み構成・生成 run が全て消えます。生成済みの画像タイムラインは残ります)",
                    )
                  ) {
                    void import("../lib/storyboard/resetAll").then((m) =>
                      m.resetStoryboardSession(),
                    );
                  }
                  return;
                }
                if (
                  window.confirm("企画チャットをリセットしますか？（履歴が消えます）")
                ) {
                  resetThread();
                }
              }}
              className="pointer-events-auto rounded-md border border-[#343434] bg-[#0b0b0b]/90 px-2 py-0.5 text-[10px] font-bold text-neutral-300 backdrop-blur hover:border-pink-400 hover:text-white"
              title={
                isStoryboardSkill
                  ? "ストーリーカット全体をリセット (企画・構成・生成 run)"
                  : "現在のチャットを破棄して新しい thread を開始"
              }
            >
              {isStoryboardSkill ? "全リセット" : "リセット"}
            </button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-10"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
        }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <h2 className="text-2xl font-black text-neutral-300">
              何を作りますか?
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-neutral-500">
              下のチャット欄に作りたいものを書くと、AIが画像生成プロンプトに整えます。<br />
              画像も添付できます。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => (
              <ChatBubble key={msg.id} msg={msg} onAdopt={adopt} />
            ))}
            {sending && messages[messages.length - 1]?.role !== "assistant" && (
              <div className="text-[11px] text-neutral-500">考え中...</div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[#242424] bg-[#161616] p-3">
        {/*
          ストーリーカットスキルがアクティブな時だけ「確定」ボタンを表示。
          STΛCK 指示 (2026-05-15): キーワード検知ではなくボタン明示。
          押すまで AI は完成形を勝手に確定しない。
        */}
        {isStoryboardSkill && messages.length > 0 && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-pink-400/30 bg-pink-500/5 px-3 py-2">
            <p className="text-[11px] font-bold leading-relaxed text-pink-100">
              ストーリーがまとまったら確定して生成タブへ
            </p>
            <button
              type="button"
              onClick={handleFinalize}
              disabled={sending || starting}
              className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-black text-white shadow hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              確定
            </button>
          </div>
        )}
        <ChatInput
          value={draft}
          attachments={pendingImages}
          onAddFiles={addFiles}
          onRemoveAttachment={removePendingImage}
          onChange={setDraft}
          onSend={handleSend}
          disabled={sending || starting}
        />
      </div>
    </section>
  );
}

/**
 * assistant 本文を「テキスト」と「コードブロック」のセグメントに分解する。
 * GPT-5.5 には ``` で囲んだプロンプト案を出すよう指示しているので、
 * その ``` ブロックを抽出して採用ボタン付きエリアブロックに置き換える。
 */
type Segment =
  | { kind: "text"; content: string }
  | { kind: "code"; content: string };

const FENCE_RE = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g;

function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  // 正規表現を使い回すので毎回 lastIndex をリセット
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "text", content: text.slice(cursor, match.index) });
    }
    const inner = match[1].replace(/\n+$/g, "").trim();
    if (inner.length > 0) {
      segments.push({ kind: "code", content: inner });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", content: text.slice(cursor) });
  }
  // 何も抽出できなかったら全文を text 1 個として返す
  if (segments.length === 0) {
    segments.push({ kind: "text", content: text });
  }
  return segments;
}

function ChatBubble({
  msg,
  onAdopt,
}: {
  msg: PlanMessage;
  onAdopt: (text: string) => void;
}) {
  const isUser = msg.role === "user";
  const displayText = stripStoryboardParams(msg.text);
  const segments = !isUser ? splitSegments(displayText) : null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[85%] space-y-2 rounded-2xl px-4 py-3 text-[15px] leading-relaxed",
          isUser
            ? "bg-pink-500/15 text-pink-50 ring-1 ring-pink-500/40"
            : "bg-[#1f1f1f] text-neutral-100 ring-1 ring-[#2a2a2a]",
        ].join(" ")}
      >
        {isUser ? (
          <>
            <p className="whitespace-pre-wrap break-words">
              {displayText || (msg.streaming ? "…" : "")}
            </p>
            <AttachmentThumbs paths={msg.attachedImages ?? []} />
          </>
        ) : (
          <>
            {segments && segments.length > 0 ? (
              segments.map((seg, i) =>
                seg.kind === "text" ? (
                  <p
                    key={`t-${i}`}
                    className="whitespace-pre-wrap break-words"
                  >
                    {seg.content.trim()}
                  </p>
                ) : (
                  <PromptBlock
                    key={`c-${i}`}
                    prompt={seg.content}
                    onAdopt={onAdopt}
                    disabled={msg.streaming}
                  />
                ),
              )
            ) : (
              <p className="whitespace-pre-wrap break-words text-neutral-500">…</p>
            )}
            {msg.streaming && (
              <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-pink-300" />
            )}
            {/* 通常メッセージ末尾の「✓ この回答を採用」は撤去。
                採用ボタンは PromptBlock 内（```で囲まれた最終プロンプト）のみに表示する。
                理由: AI 対話の各応答に都度ボタンが出ると採用ポイントが曖昧になるため。
                最終確定プロンプトを ``` で囲ませる運用に統一。 */}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * プロンプト案 1 つ分のエリアブロック。
 * モノスペースで原文表示 + 「採用」ボタン + コピー用ボタン。
 *
 * 「採用」: composer.text にこの prompt をそのまま流して生成タブへ遷移。
 */
function PromptBlock({
  prompt,
  onAdopt,
  disabled,
}: {
  prompt: string;
  onAdopt: (prompt: string) => void;
  disabled?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      /* noop */
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-[#3a3a3a] bg-[#0d0d0d]">
      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-neutral-100">
        {prompt}
      </pre>
      <div className="flex items-center justify-end gap-1.5 border-t border-[#242424] bg-[#161616] px-2 py-1.5">
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          title="クリップボードにコピー"
        >
          コピー
        </button>
        <button
          type="button"
          onClick={() => onAdopt(prompt)}
          disabled={disabled}
          className="rounded-md bg-pink-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          title="このプロンプトを採用して生成タブへ"
        >
          ✓ 採用
        </button>
      </div>
    </div>
  );
}

function ChatInput({
  value,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  attachments: string[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canSend = value.trim().length > 0 || attachments.length > 0;

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (files && files.length > 0) onAddFiles(files);
    event.currentTarget.value = "";
  };

  return (
    <div className="space-y-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2">
          {attachments.map((path) => (
            <div key={path} className="flex items-center gap-2 rounded-md border border-[#343434] bg-[#0b0b0b] p-1.5">
              <img src={convertFileSrc(path)} alt="" className="h-9 w-9 rounded object-cover" />
              <span className="max-w-[160px] truncate text-[10px] font-bold text-neutral-300">{basename(path)}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(path)}
                className="text-xs font-black text-neutral-500 hover:text-white"
                aria-label={`${basename(path)} を外す`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {/*
        ChatGPT 風スマート入力欄 (2026-05-14 STΛCK 指示):
        - 角丸の1つのボックスに textarea + 内部にアイコンボタン
        - placeholder は短く、操作ヒントは省略
        - 画像クリップは左下、送信ボタンは右下、ともにアイコン化
      */}
      <div className="relative flex flex-col rounded-2xl border border-[#343434] bg-[#0b0b0b] focus-within:border-pink-400">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onPick}
          className="hidden"
        />
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            const isComposing =
              (event.nativeEvent as KeyboardEvent).isComposing ||
              event.keyCode === 229;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder="メッセージを入力"
          disabled={disabled}
          className="min-h-[52px] resize-none bg-transparent px-4 pb-1 pt-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 disabled:opacity-60"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="画像を添付"
            aria-label="画像を添付"
            className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            title="送信 (⌘/Ctrl + Enter)"
            aria-label="送信"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-500 text-white shadow hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachmentThumbs({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {paths.map((path) => (
        <div key={path} className="overflow-hidden rounded-md border border-pink-300/30 bg-black/20">
          <img src={convertFileSrc(path)} alt={basename(path)} className="h-16 w-16 object-cover" />
        </div>
      ))}
    </div>
  );
}
