import { useEffect, useMemo, useRef, useState } from "react";

import { warnImagePayloadInBackground } from "../../../lib/imagePayloadGuard";
import { ensureDownscaledCopy } from "../../../lib/referenceDownscale";
import {
  AUDIO_EXTS,
  AUDIO_REPLACED_MESSAGE,
  audioAttachedMessage,
  formatDuration,
  isAudioFileName,
  probeAudio,
} from "../../../lib/audio/attach";
import { usePlanChat } from "../../../lib/store/planChat";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useSkillMode } from "../../../lib/store/skillMode";
import { useToasts } from "../../../lib/store/toasts";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useReferenceRoles } from "../../../lib/store/referenceRoles";
import type { StoryboardGoal } from "../../../lib/storyboard/types";
import {
  getStoryboardFinalizeInput,
  useStoryboardFinalizeInput,
} from "../../../lib/storyboard/useSceneConstruction";
import { ReferenceLibraryModal } from "../../ReferenceLibraryModal";
import { PresetPickerPopover } from "../../PresetPickerPopover";
import { selectCharacterReferences } from "../../../lib/presets/character";
import { ReferenceRoleToggle } from "../../ReferenceRoleToggle";
import { PageHelp } from "../../PageHelp";
import { SafeImage } from "../../SafeImage";
import { CandidatesSelect } from "./CandidatesSelect";

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
  const resetThread = usePlanChat((s) => s.resetThread);
  // 目標確定の入力は共有ストアを直読みしない (Sol 評価 3周目 / 2026-08-04)。
  // planChat は全スキル共有の 1 本なので、別スキルで作られた構成・パラメータが
  // 残っていると「確定」ボタンが押せてしまい、他人の構成で storyboard が進む。
  // 出所判定つきの窓口 1 本に通す (useSceneConstruction.ts)。
  const { params: storyboardParams, scene: sceneConstruction } =
    useStoryboardFinalizeInput();
  // go4: 音源は planChat の単一送信ファネルに合流させる (企画タブと共通)。
  const pendingAudio = usePlanChat((s) => s.pendingAudio);
  const clearPendingAudio = usePlanChat((s) => s.clearPendingAudio);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const skillEnabled = useSkillMode((s) => s.enabled);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  // P10: 「すぐに本生成」用の枚数選択
  const generationCandidatesPerCut = useStoryboardRun((s) => s.generationCandidatesPerCut);
  const setGenerationCandidatesPerCut = useStoryboardRun((s) => s.setGenerationCandidatesPerCut);

  const [draft, setDraft] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  /*
   * 登録キャラの選択 (STΛCK指示 2026-07-25)。
   *
   * なぜ必要か: 絵コンテ (ストーリーカット) だけ登録キャラを選ぶ導線が無く、
   * 自分のIPで映像を作るという主動線が絵コンテで途切れていた。
   * 参照画像の入口が「PCから添付」と「ライブラリから選ぶ」の2つしかなく、
   * キャラを使うにはライブラリの全生成画像の中から目で探す必要があった
   * (キャラ名で引けない)。企画タブ (PlanWorkspace) と同じ
   * PresetPickerPopover を置いて、キャラ名で選べるようにする。
   */
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetAnchor, setPresetAnchor] = useState<DOMRect | null>(null);
  const presetButtonRef = useRef<HTMLButtonElement | null>(null);
  // 「ゴール確定」を押した直後フラグ。JSON 応答が来たら自動で次フェーズに進む。
  // P7 (2026-05-20): 進む先を sketch / generation で選べるよう保持する。
  const [awaitingTarget, setAwaitingTarget] = useState<null | "sketch" | "generation">(null);
  // ライブラリピッカー (生成済み画像から選ぶ)
  const [libraryOpen, setLibraryOpen] = useState(false);
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

  // 最新メッセージに自動追従スクロール (2026-06-07 STΛCK報告)。
  // 旧実装は messages.length だけを依存にしており、AI 返信のストリーミング中は
  // 件数が変わらないため本文が下に伸びても追従せず、手動スクロールが必要だった。
  // 件数 + 最後のメッセージの本文長を依存にして、delta で本文が伸びるたびに追従する。
  const lastMessage = messages[messages.length - 1];
  const lastMessageLen = lastMessage?.text.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [messages.length, lastMessageLen]);

  // FB#3 (2026-06-06): 添付画像に役割 (キャラ既定) を初期化する。冪等。
  useEffect(() => {
    if (attachedImages.length > 0) {
      useReferenceRoles.getState().ensureRoles(attachedImages);
    }
    // 7zf (2026-08-03): 合計サイズの予告警告。GoalChat の添付はローカル state
    // なので planChat の addPendingImages 側フックが効かない。この effect が
    // 全入口 (dialog / ライブラリ / プリセット) をカバーする。
    // N-01 (Wave 2 REVISE): 0 件でも呼ぶ。空配列は警告去重 (lastWarnedMb) の
    // リセットになっており、条件から外すと「全部外して同じ枚数を付け直すと
    // 警告が出ない」取りこぼしが残る。
    warnImagePayloadInBackground(attachedImages);
  }, [attachedImages]);

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
  // awaitingTarget 中は再クリックを防ぐため無効化する
  // 2026-06-07 STΛCK指示: 参照画像 (キャラ基準) を必ず1枚以上アップロードしないと
  // 次に進めない。参照が無いと本生成が "characterReferenceImage must not be empty" で
  // 失敗し、キャラ一貫性も保てないため。現在の添付 or 過去メッセージの添付を見る。
  const hasReferenceImage =
    attachedImages.length > 0 ||
    messages.some((m) => (m.attachedImages?.length ?? 0) > 0);
  const canFinalize =
    messages.length >= 4 && hasReferenceImage && !sending && !awaitingTarget;

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    const images = attachedImages.slice();
    // 送信直前に1枚ずつ軽量コピーを用意する。planChat 側は同じキャッシュを使うため、
    // 実際の送信時に二重変換されない。state は元パスのままなのでプレビューも不変。
    for (const path of images) {
      try {
        await ensureDownscaledCopy(path);
      } catch (error) {
        // 共通送信口でも再試行し、失敗時は入力を残したまま送信を止める。
        console.warn("[GoalChatPanel] reference downscale preflight failed", error);
        break;
      }
    }
    // B-02 (Wave 2 REVISE): 入力文と添付を消すのは send が受け付けた後だけ。
    // GoalChat の添付はこのコンポーネントのローカル state なので、380MB ガードで
    // ブロックされた後に消すと復元手段が無く、添付を減らして再送できない。
    const accepted = await send(text, images.length > 0 ? images : undefined);
    if (!accepted) return;
    setDraft("");
    setAttachedImages([]);
  }

  /**
   * PC から画像 / 音源を添付する (go4)。
   *
   * 音源は画像とは別経路に載せる。probe したメタデータだけを planChat の
   * pendingAudio へ渡し、送信時に文字情報としてプロンプトに供給する
   * (**音声パスを attachedImages に入れてはいけない** — codex に localImage として
   * 渡ると Windows で sandbox-setup エラーに化ける)。
   * D&D 経路は現状ゴールチャットに無いので picker のみ。
   */
  async function pickFiles() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [
          { name: "画像", extensions: IMAGE_EXTS },
          { name: "音源", extensions: [...AUDIO_EXTS] },
        ],
      });
      if (!r) return;
      const paths = (Array.isArray(r) ? r : [r]).filter(
        (p): p is string => typeof p === "string",
      );
      if (paths.length === 0) return;

      const imagePaths = paths.filter((p) => !isAudioFileName(p));
      const audioPaths = paths.filter((p) => isAudioFileName(p));

      if (imagePaths.length > 0) {
        setAttachedImages((prev) => {
          // 重複を弾く
          const set = new Set(prev);
          for (const p of imagePaths) set.add(p);
          return Array.from(set);
        });
      }

      // 音源は 1 曲まで。複数選ばれたら最後の 1 件を採用する。
      const audioPath = audioPaths[audioPaths.length - 1];
      if (audioPath) {
        try {
          const attachment = await probeAudio(audioPath);
          const replacing = usePlanChat.getState().pendingAudio !== null;
          usePlanChat.getState().setPendingAudio(attachment);
          useToasts.getState().push({
            kind: "success",
            text: replacing
              ? AUDIO_REPLACED_MESSAGE
              : audioAttachedMessage(attachment),
            ttlMs: 2800,
          });
        } catch (err) {
          useToasts.getState().push({
            kind: "error",
            text: (err as Error)?.message ?? String(err),
            ttlMs: 6000,
          });
        }
      }
    } catch (err) {
      useToasts.getState().push({
        kind: "error",
        text: `ファイルの選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  function removeAttachment(path: string) {
    setAttachedImages((prev) => prev.filter((p) => p !== path));
    // FB#3: 添付解除時に役割エントリも掃除する。
    useReferenceRoles.getState().clearRole(path);
  }

  // ストア状態を見て StoryboardGoal を組み立てる共通関数。
  // 「storyboardParams + sceneConstruction が揃っている」前提。
  // P7 (2026-05-20): 進む先 Phase を引数で受ける (sketch or generation)。
  function buildAndAdvance(targetPhase: "sketch" | "generation") {
    // ここも直読みしない。描画時点 (上の hook) と実行時点で判定がずれないよう、
    // 非 hook 版の同じ窓口を通す (Sol 評価 3周目 / 2026-08-04)。
    const { params, scene } = getStoryboardFinalizeInput();
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
      // FB#3 (2026-06-06): 複数キャラ/スタイル参照を goal に運ぶ (後方互換: 単数も維持)。
      characterReferencePaths: params.character_reference_paths,
      styleReferencePaths: params.style_reference_paths,
    };
    setGoal(goal);
    // 生成入力の分離保持 (Sol 評価 blocking#3 / 2026-08-04)。
    // 正本の planChat.sceneConstruction は「別スキルへ入った瞬間」に消える共有ストア。
    // 目標確定と同時に storyboard 専用の控えへ写しておき、漫画などへ寄り道して
    // 戻ってきても本生成入力が残るようにする。goal と同じ寿命 (phaseEmptyState) なので、
    // ストーリー境界のリセットでは goal ごと破棄される。
    useStoryboardRun.getState().setSceneConstruction(scene);
    setPhase(targetPhase);
    useToasts.getState().push({
      kind: "success",
      text:
        targetPhase === "sketch"
          ? "ゴールを確定しました。絵コンテレビューに進みます。"
          : "ゴールを確定しました。本生成に進みます。",
      ttlMs: 3000,
    });
    return true;
  }

  // P7 (2026-05-20): 2 ルート分岐
  //  - ルートA (絵コンテ経由): finalize("sketch") → Phase 2
  //  - ルートB (直接本生成): finalize("generation") → Phase 3
  async function handleFinalize(targetPhase: "sketch" | "generation") {
    if (storyboardParams && sceneConstruction) {
      buildAndAdvance(targetPhase);
      return;
    }
    setAwaitingTarget(targetPhase);
    useToasts.getState().push({
      kind: "info",
      text: "AI に絵コンテ構成を依頼しています…応答後、自動で次へ進みます。",
      ttlMs: 4000,
    });
    // B-02: 送信が受け付けられなかった (送信中 / 添付が 380MB 超過) 場合は
    // awaitingTarget を戻す。そのままだと AI 応答が永遠に来ないのに
    // 「応答後、自動で次へ進みます」の待機状態が残り、確定ボタンも無効のまま固まる。
    const accepted = await send(
      "[FINALIZE_STORYBOARD] ここまでの内容で確定 JSON を出してください。",
    );
    if (!accepted) setAwaitingTarget(null);
  }

  // AI 応答で揃ったら待機中のターゲットへ自動遷移
  useEffect(() => {
    if (!awaitingTarget) return;
    if (storyboardParams && sceneConstruction && !sending) {
      const ok = buildAndAdvance(awaitingTarget);
      if (ok) setAwaitingTarget(null);
    }
  // buildAndAdvance は内部で getState() を使うので依存に入れない
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingTarget, storyboardParams, sceneConstruction, sending]);

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-200">Phase 1: ゴール深掘り</h2>
            {/*
              2026-07-27: 説明を見出しの横のヘルプボタンに畳んだ (STΛCK 指摘
              「貴重なUIを説明で取りすぎている」)。旧: 見出しの下に常時4行のボックス。
            */}
            <PageHelp
              what="作りたい話を伝えると、AI が聞き返しながら絵コンテに起こし、そのままカットを続けて作ります。登録キャラと画風を固定するので、話が進んでも同じ人物・同じ絵柄のまま並びます。"
              first="まずは下の入力欄に、作りたい映像を思いつきの一言で書いてください。足りないところは AI が聞き返します。"
              note="同じ人物のまま並べるには、参照画像を1枚以上入れてください。"
            />
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (sending) return;
                  void (async () => {
                    const message = "この目標タブの会話をリセットして最初からやり直しますか？";
                    let ok = false;
                    try {
                      const { ask } = await import("@tauri-apps/plugin-dialog");
                      ok = await ask(message, { title: "会話のリセット", kind: "warning" });
                    } catch {
                      ok = window.confirm(message);
                    }
                    if (!ok) return;
                    resetThread();
                    setAttachedImages([]);
                    // S3 (2026-07-28): checkpoint 待機の解除は撤去 (停止区間が消えたため)。
                    useStoryboardRun.getState().reset();
                  })();
                }}
                disabled={sending}
                className="rounded-md border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400 hover:text-white disabled:opacity-40"
                title="この会話をリセットして最初からやり直す"
              >
                ↺ リセット
              </button>
            )}
          </div>
          {probingFromAi && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-pink-500/40 bg-pink-500/10 px-3 py-1 text-[11px] text-pink-200">
              <span className="opacity-70">AI が知りたい:</span>
              <span className="font-medium">{probingFromAi}</span>
            </div>
          )}
        </div>
        {/* P7: 2 ルート分岐ボタン */}
        <div className="flex shrink-0 flex-col gap-2">
          {!hasReferenceImage && messages.length >= 4 && (
            <p className="max-w-[180px] text-right text-[10px] leading-relaxed text-amber-300/80">
              キャラの一貫性のため、参照画像を1枚以上アップロードしてください
            </p>
          )}
          <button
            type="button"
            onClick={() => handleFinalize("sketch")}
            disabled={!canFinalize}
            className={[
              "rounded-md border px-4 py-2 text-sm font-semibold transition",
              canFinalize
                ? "border-pink-500/40 bg-pink-500/10 text-pink-100 hover:bg-pink-500/20"
                : "cursor-not-allowed border-[#2a2a2a] bg-zinc-800 text-zinc-500",
            ].join(" ")}
            title="まず絵コンテで構図を確認してから本生成 (推奨)"
          >
            {awaitingTarget === "sketch" ? "AI 応答待ち…" : "絵コンテを作る →"}
          </button>
          <div className="flex items-center gap-2">
            <CandidatesSelect
              value={generationCandidatesPerCut}
              onChange={setGenerationCandidatesPerCut}
              label="本生成"
              disabled={!canFinalize}
            />
            <button
              type="button"
              onClick={() => handleFinalize("generation")}
              disabled={!canFinalize}
              className={[
                "rounded-md px-4 py-2 text-sm font-semibold transition",
                canFinalize
                  ? "bg-pink-500 text-white hover:bg-pink-400"
                  : "cursor-not-allowed bg-zinc-700 text-zinc-400",
              ].join(" ")}
              title={`絵コンテをスキップして本番カット (${generationCandidatesPerCut}案/カット) を生成`}
            >
              {awaitingTarget === "generation" ? "AI 応答待ち…" : "すぐに本生成 →"}
            </button>
          </div>
        </div>
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
              {/* P20a (2026-05-21): 添付画像があればサムネ表示+ダブルクリックでプレビュー */}
              {m.attachedImages && m.attachedImages.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-2">
                  {m.attachedImages.map((path) => (
                    <li key={path}>
                      <SafeImage
                        path={path}
                        alt={basename(path)}
                        title="ダブルクリックで拡大"
                        onDoubleClick={() =>
                          useImagePreview
                            .getState()
                            .open(path, m.attachedImages ?? [])
                        }
                        className="h-20 w-auto max-w-40 cursor-zoom-in rounded border border-pink-500/30 object-contain hover:border-pink-500"
                      />
                    </li>
                  ))}
                </ul>
              )}
              {/*
                go4 (Sol caveat): 送信済みの音源を履歴にも残す。
                PlanWorkspace の吹き出し (:662) と同じ見た目の読み取り専用チップ。
                解除ボタンは付けない (送信済みの添付は変更できない)。
              */}
              {m.attachedAudio && (
                <div className="mb-2 flex items-center gap-1.5 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1">
                  <span className="text-[12px] text-pink-400">♪</span>
                  <span className="max-w-[200px] truncate text-[10px] font-bold text-zinc-300">
                    {m.attachedAudio.fileName}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    ({formatDuration(m.attachedAudio.durationSec)})
                  </span>
                </div>
              )}
              <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
              {m.streaming && (
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
                  入力中…
                </div>
              )}
            </li>
          ))}
          {/*
            2026-07-27: 送信してから AI の返信が始まるまでの空白を埋める (STΛCK 指摘)。
            以前この間の表示は右下の送信ボタン (「送信中…」) だけだった。
            視線は会話の流れを追っているのに、状態は入力欄の隅にしか出ておらず、
            送ったのに何も起きていないように見えていた。
            返信が始まれば m.streaming の「入力中…」に引き継がれるので、
            AI の吹き出しが既にある場合はこれを出さない (二重表示の防止)。
          */}
          {sending && messages[messages.length - 1]?.role !== "assistant" && (
            <li className="max-w-[80%] rounded-md bg-[#1c1c1c] px-3 py-2 text-sm text-zinc-200">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                AI
              </div>
              <div className="flex items-center gap-2 text-[12px] text-zinc-400">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
                考えています…
              </div>
            </li>
          )}
        </ul>
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
        {attachedImages.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium text-zinc-500">
              各画像の役割を選べます (キャラ参照 = 同一性を保つ / スタイル参照 = タッチのみ)
            </p>
            <ul className="flex flex-wrap gap-2">
              {attachedImages.map((p) => (
                <li
                  key={p}
                  className="group relative flex flex-col gap-1.5 rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <SafeImage
                      path={p}
                      alt={basename(p)}
                      title="ダブルクリックで拡大"
                      onDoubleClick={() =>
                        useImagePreview.getState().open(p, attachedImages)
                      }
                      className="h-8 w-auto max-w-16 cursor-zoom-in rounded object-contain hover:opacity-80"
                    />
                    <span className="max-w-[120px] truncate text-[11px] text-zinc-300">
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
                  </div>
                  <ReferenceRoleToggle path={p} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* go4: 添付音源チップ。役割トグルは音声には出さない。 */}
        {pendingAudio && (
          <div className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5">
            <span className="text-[12px] text-pink-400">♪</span>
            <span className="max-w-[200px] truncate text-[11px] text-zinc-300">
              {pendingAudio.fileName}
            </span>
            <span className="text-[10px] text-zinc-500">
              ({formatDuration(pendingAudio.durationSec)})
            </span>
            <button
              type="button"
              onClick={clearPendingAudio}
              className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-pink-500/10 hover:text-pink-300"
              title="音源を外す"
              aria-label="音源を外す"
            >
              <IconClose />
            </button>
          </div>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 2026-07-27: 企画チャット・3D画面と規則を揃えた (Enter=送信 / Shift+Enter=改行)。
            // 以前は ⌘/Ctrl+Enter のみで、同じアプリ内でも画面ごとに送信キーが違っていた。
            // 変換確定の Enter を送信と取り違えないよう isComposing でガードする
            // (旧実装にはこのガードが無く、日本語入力中に誤送信しうる状態だった)。
            const isComposing =
              (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
            if (e.key !== "Enter" || isComposing) return;
            if (e.shiftKey) return; // 改行
            e.preventDefault();
            void handleSend();
          }}
          rows={4}
          placeholder="作りたい映像を一言で… (Enter で送信・改行は Shift+Enter)"
          className="w-full resize-none bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={pickFiles}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2a2a2a] text-zinc-300 hover:border-pink-500/40 hover:text-pink-200"
              title="PC から画像・音源を添付"
              aria-label="PC から画像・音源を添付"
            >
              <IconPaperclip />
            </button>
            <button
              type="button"
              onClick={() => setLibraryOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2a2a2a] text-zinc-300 hover:border-pink-500/40 hover:text-pink-200"
              title="ライブラリから画像を選ぶ"
              aria-label="ライブラリから画像を選ぶ"
            >
              <IconLibrary />
            </button>
            {/* 登録キャラを名前で選ぶ (企画タブと同じ PresetPickerPopover) */}
            <button
              type="button"
              ref={presetButtonRef}
              onClick={() => {
                if (presetButtonRef.current) {
                  setPresetAnchor(presetButtonRef.current.getBoundingClientRect());
                }
                setPresetOpen(true);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2a2a2a] text-zinc-300 hover:border-pink-500/40 hover:text-pink-200"
              title="登録したキャラクターを使う"
              aria-label="登録したキャラクターを使う"
            >
              <IconCharacter />
            </button>
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft.trim() || sending}
            className={[
              "flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition",
              !draft.trim() || sending
                ? "cursor-not-allowed bg-zinc-700 text-zinc-400"
                : "bg-pink-500 text-white hover:bg-pink-400",
            ].join(" ")}
          >
            {sending && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
            )}
            {sending ? "送信中…" : "送信"}
          </button>
        </div>
      </div>

      {/* ライブラリピッカー (生成済み画像から添付参照を選ぶ)。
          FB#3: roleMode でキャラ/スタイルを選んで取り込める。 */}
      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        roleMode
        onPick={(path) => {
          setAttachedImages((prev) => {
            const set = new Set(prev);
            set.add(path);
            return Array.from(set);
          });
        }}
      />
      {/*
        登録キャラのピッカー。企画タブ (PlanWorkspace) と同じ onPick 構造にする。
        キャラ型は速度対策で既定3枚に絞られる (selectCharacterReferences)。
        ここで添付すると useReferenceRoles.ensureRoles が role を付け、
        planChat の character_reference_path 抽出経路にそのまま乗る。
      */}
      <PresetPickerPopover
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        anchorRect={presetAnchor}
        onPick={(preset) => {
          const paths = selectCharacterReferences(preset)
            .map((ref) => ref.path)
            .filter((path) => path.length > 0);
          if (paths.length === 0) return;
          setAttachedImages((prev) => {
            const set = new Set(prev);
            for (const path of paths) set.add(path);
            return Array.from(set);
          });
        }}
      />
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

function IconCharacter() {
  // 人物のシルエット (登録キャラを表す)
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
      aria-hidden
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </svg>
  );
}

function IconLibrary() {
  // Lucide images: 重なった2つの画像枠 (ライブラリ表現)
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
      <path d="M18 22H4a2 2 0 0 1-2-2V6" />
      <path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
      <circle cx="12" cy="8" r="2" />
      <rect width="16" height="16" x="6" y="2" rx="2" />
    </svg>
  );
}
