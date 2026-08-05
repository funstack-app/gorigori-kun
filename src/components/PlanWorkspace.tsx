import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { SafeImage } from "./SafeImage";
import { PageHelp } from "./PageHelp";
import { useActiveProject } from "../lib/store/activeProject";
import { useComposer } from "../lib/store/composer";
import { images } from "../lib/ipc";
import { usePlanChat, type PlanMessage } from "../lib/store/planChat";
import { deriveTitle } from "../lib/store/unsavedPlanChats";
import { useScenePromptOverride } from "../lib/store/scenePrompt";
import { useSkillMode } from "../lib/store/skillMode";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
import {
  PLAN_REDISCUSS_EVENT,
  type PlanRediscussDetail,
} from "../lib/sendToPlan";
import { extractDropped, isImageDrop } from "../lib/dragRef";
import {
  AUDIO_REPLACED_MESSAGE,
  MAX_AUDIO_BYTES,
  UNSUPPORTED_ATTACHMENT_MESSAGE,
  audioAttachedMessage,
  audioTooLargeMessage,
  fileToAudioPath,
  formatDuration,
  isAudioFileName,
  probeAudio,
  type AudioAttachment,
} from "../lib/audio/attach";
import { useReferenceRoles } from "../lib/store/referenceRoles";
import {
  composePresetPrompt,
  selectCharacterReferences,
} from "../lib/presets/character";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { ReferenceRoleToggle } from "./ReferenceRoleToggle";
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

/**
 * go4: `file.path` 直通の経路にも拡張子検証を効かせる。
 *
 * 以前は directPath があると検証を素通ししていたため、native drop した mp3 が
 * そのまま `localImage` として codex に渡り、モデルがファイルを調べようとして
 * シェル実行 → Windows で `codex-windows-sandbox-setup.exe` 不在の
 * 「sandbox-setup エラー」に化けていた (DB1 の事故連鎖)。
 * 画像と判定できないファイルは必ず null を返し、呼び出し側で音声/その他へ振り分ける。
 */
function isImageFile(file: File): boolean {
  const directPath = (file as unknown as { path?: string }).path;
  if (directPath) {
    // 直接パスは **拡張子だけ**で判定する (Sol指摘 G-2)。
    // MIME (`file.type`) は OS / ブラウザ側の推測値で、native drop では
    // 拡張子と食い違うことがある。`image/*` を or 条件で通していると
    // `song.mp3` が MIME 次第で画像経路に入り、localImage として codex に
    // 渡ってしまう (設計書 design-audio-codexpath.md :140 の「直接パスは
    // 画像拡張子を必須にする」)。ここは and ではなく **拡張子単独**が正。
    return isImageFileName(file.name) || isImageFileName(directPath);
  }
  // picker/クリップボード経由 (bytes を自前で書き出す) は従来どおり。
  // 拡張子の無い貼り付け画像を拾うため MIME も見る。
  return file.type.startsWith("image/") || isImageFileName(file.name);
}

async function fileToImagePath(file: File): Promise<string | null> {
  if (!isImageFile(file)) return null;
  const directPath = (file as unknown as { path?: string }).path;
  if (directPath) return directPath;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return images.writeUpload(file.name || `plan-chat-${Date.now()}.png`, bytes);
}

/**
 * go4: 企画タブが受け入れる drop かの判定 (画像 or 音声)。
 *
 * 共有の `isImageDrop` / `dragDrop.ts` は他タブも使うため変更せず、
 * ここでローカルに包む。dragover 時点では `DataTransfer.items` の kind/type しか
 * 見られない (ファイル名は取れない) ので、"Files" が含まれれば受け入れ、
 * 実際の振り分けは drop 後の `addFiles` が拡張子で行う。
 */
function isAttachableDrop(dataTransfer: DataTransfer): boolean {
  if (isImageDrop(dataTransfer)) return true;
  return Array.from(dataTransfer.items).some(
    (item) => item.kind === "file" && item.type.startsWith("audio/"),
  );
}

function stripStoryboardParams(text: string): string {
  return text.replace(/\n?\[STORYBOARD_PARAMS\][\s\S]*$/g, "").trim();
}

/**
 * 通常企画の「確定」で送る [FINALIZE_PROMPT] 指示文は、チャット表示上は
 * ユーザーの吹き出しに丸ごと出すとノイズになる。表示用に短い一文へ置換する。
 */
function stripFinalizePrompt(text: string): string {
  if (text.startsWith("[FINALIZE_PROMPT]")) {
    return "（ここまでの対話を踏まえてプロンプトを確定）";
  }
  return text;
}

export function PlanWorkspace() {
  const messages = usePlanChat((s) => s.messages);
  const sending = usePlanChat((s) => s.sending);
  const starting = usePlanChat((s) => s.starting);
  const pendingImages = usePlanChat((s) => s.pendingImages);
  const send = usePlanChat((s) => s.send);
  const finalizePlan = usePlanChat((s) => s.finalizePlan);
  const attach = usePlanChat((s) => s.attach);
  const resetThread = usePlanChat((s) => s.resetThread);
  const addPendingImages = usePlanChat((s) => s.addPendingImages);
  const removePendingImage = usePlanChat((s) => s.removePendingImage);
  const pendingAudio = usePlanChat((s) => s.pendingAudio);
  const setPendingAudio = usePlanChat((s) => s.setPendingAudio);
  const clearPendingAudio = usePlanChat((s) => s.clearPendingAudio);
  const storyboardParams = usePlanChat((s) => s.storyboardParams);

  const setText = useComposer((s) => s.setText);
  const setScenePromptOverride = useScenePromptOverride((s) => s.set);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const pushToast = useToasts((s) => s.push);

  const [draft, setDraft] = useState("");
  // 2026-07-27: ライブラリから既存画像を添付する経路 (STΛCK 要望)
  const [libraryOpen, setLibraryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const ensureRoles = useReferenceRoles((s) => s.ensureRoles);

  useEffect(() => {
    void attach();
  }, [attach]);

  // FB#3 (2026-06-06): 添付された画像に役割 (キャラ既定) を初期化する。
  // 役割未指定のパスだけ初期化し、ユーザーが設定済みの役割は保持する (冪等)。
  useEffect(() => {
    if (pendingImages.length > 0) ensureRoles(pendingImages);
  }, [pendingImages, ensureRoles]);

  /**
   * (配布前クリーニング 2026-05-15: 一度だけ実行のリカバリーコードは個人情報を含むため削除済み)
   */

  // 最新メッセージに自動追従スクロール (2026-06-07 STΛCK報告)。
  // AI 返信のストリーミング中も本文が下に伸びるたびに追従させるため、
  // 件数 + 最後のメッセージの本文長を依存に入れる (delta で発火)。
  const lastMessageLen = messages[messages.length - 1]?.text.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, lastMessageLen, sending]);

  /**
   * STΛCK 指示 (2026-05-19, NRC さん要望): 「企画で再検討」アクションで
   * 画像 + 元プロンプトが送られてきたら、入力欄に自動文を入れて GPT-5.5
   * との対話を始めやすくする。
   * - 画像は既に planChat.pendingImages に追加済み (sendToPlan.ts 側)
   * - draft が空の時だけ自動文を入れる (ユーザーが既に書いてたら邪魔しない)
   */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PlanRediscussDetail>).detail;
      if (!detail) return;
      setDraft((prev) => {
        if (prev.trim().length > 0) return prev;
        if (detail.originalPrompt) {
          return `この画像をベースに、プロンプトを練り直したいです。元のプロンプトは以下です:\n\n${detail.originalPrompt}\n\nどう改善できますか?`;
        }
        return "この画像をベースに、プロンプトを練り直したいです。どう改善できますか?";
      });
    };
    window.addEventListener(PLAN_REDISCUSS_EVENT, handler);
    return () => window.removeEventListener(PLAN_REDISCUSS_EVENT, handler);
  }, []);

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

  /**
   * 添付ファイルを画像 / 音源 / その他の 3 分岐で受ける (go4)。
   *
   * 音源は codex に**渡さない**。probe したメタデータだけを planChat の
   * pendingAudio に載せ、送信時に文字情報としてプロンプトへ供給する。
   */
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const paths: string[] = [];
    let audioAttached: AudioAttachment | null = null;
    let hadAudioCandidate = false;
    let unsupported = false;

    for (const file of list) {
      if (isImageFile(file)) {
        const path = await fileToImagePath(file);
        if (path) paths.push(path);
        continue;
      }
      const looksAudio =
        file.type.startsWith("audio/") || isAudioFileName(file.name);
      if (!looksAudio) {
        unsupported = true;
        continue;
      }
      // 対応外の音声拡張子 (.aiff 等) はここで弾く。probe に渡すと
      // 「壊れファイル」と区別がつかないメッセージになる。
      if (!isAudioFileName(file.name)) {
        unsupported = true;
        continue;
      }
      hadAudioCandidate = true;
      if (file.size > MAX_AUDIO_BYTES) {
        pushToast({ kind: "error", text: audioTooLargeMessage(file.name), ttlMs: 5000 });
        continue;
      }
      try {
        const path = await fileToAudioPath(file);
        audioAttached = await probeAudio(path);
      } catch (err) {
        pushToast({
          kind: "error",
          text: (err as Error)?.message ?? String(err),
          ttlMs: 6000,
        });
      }
    }

    if (audioAttached) {
      const replacing = usePlanChat.getState().pendingAudio !== null;
      setPendingAudio(audioAttached);
      pushToast(
        replacing
          ? { kind: "success", text: AUDIO_REPLACED_MESSAGE, ttlMs: 2800 }
          : { kind: "success", text: audioAttachedMessage(audioAttached), ttlMs: 2800 },
      );
    }

    if (paths.length > 0) {
      addPendingImages(paths);
      pushToast({ kind: "success", text: `${paths.length} 枚を企画チャットに添付しました`, ttlMs: 2400 });
    }

    // 何も添付できず、対応外ファイルだけだった場合のみ形式エラーを出す
    // (音源の解析失敗・サイズ超過は既に個別トーストを出している)。
    if (paths.length === 0 && !audioAttached && !hadAudioCandidate && unsupported) {
      pushToast({ kind: "error", text: UNSUPPORTED_ATTACHMENT_MESSAGE, ttlMs: 4000 });
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text && pendingImages.length === 0 && !pendingAudio) return;
    // B-02 (Wave 2 REVISE): 入力欄を消すのは send が受け付けた後だけ。
    // 380MB ガードでブロックされた場合 (false) に消してしまうと、
    // 書いた文章が失われて添付を減らしての再送ができない。
    // go4: 本文が空のときの自動文。音源のみの添付なら音源向けの誘導文にする
    // (「添付画像を参照してください。」だと画像が無いのに画像を探させてしまう)。
    const fallbackText =
      pendingImages.length > 0
        ? "添付画像を参照してください。"
        : "添付音源を踏まえて企画を進めてください。";
    const accepted = await send(text || fallbackText, pendingImages);
    if (accepted) setDraft("");
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
    // B-02: この経路は draft / pendingImages を消さないので、ブロックされても
    // 失われるものは無い。ただし裸呼び出しを残さない規約に従い結果を受け取る
    // (ブロック理由のトーストはガード側が既に出している)。
    const accepted = await send(
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
    if (!accepted) {
      console.warn(
        "[PlanWorkspace] 確定の送信が受け付けられませんでした (送信中 / 添付が容量超過)",
      );
    }
  };

  /**
   * 通常企画タブ (非ストーリーカット) の「確定」ボタン押下時の処理。
   *
   * STΛCK 指示 (2026-06-07): 対話を重視したいので、確定を押すまで AI は
   * プロンプト案を出さない。確定でここまでの履歴を踏まえたプロンプト案を
   * 初めて生成させる (planChat.finalizePlan が [FINALIZE_PROMPT] を送る)。
   */
  const handleFinalizeNormal = async () => {
    if (sending || starting) return;
    await finalizePlan();
  };

  // プロンプト採用。kind で画像生成タブ / 動画生成タブに出し分ける。
  //
  // 重要 (2026-06-07 STΛCK報告): 採用してもチャット履歴は消さない。
  //   旧実装は採用時に setSelectedSkillId("gori-storyboard") でスキルモードを
  //   切り替えており、企画タブが storyboard モードに化けて履歴が見えなくなって
  //   いた。採用ではスキルモードを触らず、履歴リセットは右上の「リセット」
  //   ボタン(resetThread)に一本化する。
  const adopt = (text: string, kind: PromptKind) => {
    const cleanText = stripStoryboardParams(text);
    if (kind === "video") {
      // 動画化プロンプト → 動画生成タブへ。プロンプト入力欄(scenePromptOverride)に
      // i2v 出自でセットし、タブを video に切り替える。元画像は動画タブでセットする。
      setScenePromptOverride(cleanText, "i2v");
      setActiveTab("video");
      pushToast({
        kind: "success",
        text: "動画生成タブにプロンプトを入れました。元になる画像をセットしてください。",
        ttlMs: 3200,
      });
      return;
    }
    // 画像生成プロンプト → 画像生成タブへ。
    setScenePromptOverride(cleanText, "image");
    setText(cleanText);
    setActiveTab("generate");
    pushToast({
      kind: "success",
      text: "画像生成タブに採用しました。",
      ttlMs: 2400,
    });
  };

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      {/*
        ページヘルプ (ui-placement-grammar §4)。本タブは常時表示のヘッダー行を
        持たないため、右上のステータス列と対になる左上へ常設で置く
        (右上の列は messages 件数などの条件付き表示なので、ヘルプの到達性を
        そこに乗せない)。
      */}
      <div className="absolute left-4 top-2 z-20">
        <PageHelp
          what="作りたいものを相談すると、AI が対話でプロンプトに仕上げ、そのまま画像生成に渡せます。"
          first="まずは入力欄に、作りたいものを思いつきの一言で書いてください。"
        />
      </div>
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
                void (async () => {
                  const confirmDialog = async (message: string, title: string) => {
                    try {
                      const { ask } = await import("@tauri-apps/plugin-dialog");
                      return await ask(message, { title, kind: "warning" });
                    } catch {
                      return window.confirm(message);
                    }
                  };
                  if (isStoryboardSkill) {
                    const ok = await confirmDialog(
                      "ストーリーカットを最初からやり直しますか？\n(企画チャット・確定済み構成・生成 run が全て消えます。生成済みの画像タイムラインは残ります)",
                      "ストーリーカットのリセット",
                    );
                    if (ok) {
                      void import("../lib/storyboard/resetAll").then((m) =>
                        m.resetStoryboardSession(),
                      );
                    }
                    return;
                  }
                  const ok = await confirmDialog(
                    "企画チャットをリセットしますか？（履歴が消えます）",
                    "企画のリセット",
                  );
                  if (ok) {
                    resetThread();
                  }
                })();
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
        /*
          STΛCK 指示 (2026-05-19): 企画タブ全体を drop target 化。
          内部 Reference (ライブラリ画像など) と OS Files を統一的に受け入れ、
          いずれも添付画像として企画チャットに追加する。
        */
        onDragOver={(event) => {
          if (isAttachableDrop(event.dataTransfer)) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const { refs, files } = extractDropped(event.dataTransfer);
          if (refs.length > 0) {
            addPendingImages(refs.map((r) => r.path));
            pushToast({
              kind: "success",
              text: `画像 ${refs.length} 枚を添付しました`,
              ttlMs: 2200,
            });
          }
          if (files.length > 0) {
            void addFiles(files);
          }
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
            {/*
              2026-07-27: 送信〜返信開始の間の表示を、絵コンテのチャットと同じ形に揃えた。
              小さい文字だけだと、送ったのに動いていないように見える (STΛCK 指摘)。
            */}
            {sending && messages[messages.length - 1]?.role !== "assistant" && (
              <div className="flex items-center gap-2 text-[12px] text-neutral-400">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
                考えています…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[#242424] bg-[#161616] p-3">
        {/*
          g8t (2026-08-04): 未保存企画チャットの案件昇格バンド。
          プロジェクト未選択のまま進めた会話をその場で案件に確定する導線で、
          スキル/通常の両モードで確定バンドの **上** に出す。
        */}
        <PromoteToProjectBand />
        {/*
          ストーリーカットスキル時の「確定」ボタン (絵コンテ用 JSON を確定して生成タブへ)。
          通常企画タブの確定は下の !isStoryboardSkill ブロックで別途表示する。
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
        {/*
          通常企画タブ (非ストーリーカット) の確定。
          STΛCK 指示 (2026-06-07): 対話を重視するため、確定を押すまで AI は
          プロンプト案を出さない。確定でここまでの対話からプロンプトを生成する。
        */}
        {!isStoryboardSkill && messages.length > 0 && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-pink-400/30 bg-pink-500/5 px-3 py-2">
            <p className="text-[11px] font-bold leading-relaxed text-pink-100">
              対話がまとまったら「確定」でプロンプトを生成
            </p>
            <button
              type="button"
              onClick={handleFinalizeNormal}
              disabled={sending || starting}
              className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-black text-white shadow hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              title="ここまでの対話を踏まえて画像生成プロンプトを生成する"
            >
              確定
            </button>
          </div>
        )}
        <ChatInput
          value={draft}
          attachments={pendingImages}
          audio={pendingAudio}
          onRemoveAudio={clearPendingAudio}
          onAddFiles={addFiles}
          onAddImagePaths={addPendingImages}
          onOpenLibrary={() => setLibraryOpen(true)}
          onRemoveAttachment={(path) => {
            removePendingImage(path);
            // FB#3: 添付解除時に役割エントリも掃除する。
            useReferenceRoles.getState().clearRole(path);
          }}
          onChange={setDraft}
          onSend={handleSend}
          disabled={sending || starting}
        />
      </div>

      {/* 2026-07-27: ライブラリから既存画像を選んで添付する (STΛCK 要望)。
          storyboard の GoalChatPanel と同じ部品を使い、挙動を揃える。 */}
      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        roleMode
        onPick={(path) => {
          addPendingImages([path]);
          pushToast({ kind: "success", text: "ライブラリから添付しました", ttlMs: 2000 });
        }}
      />
    </section>
  );
}

/**
 * assistant 本文を「テキスト」と「コードブロック」のセグメントに分解する。
 * GPT-5.5 には ``` で囲んだプロンプト案を出すよう指示しているので、
 * その ``` ブロックを抽出して採用ボタン付きエリアブロックに置き換える。
 */
// プロンプトの種類。確定後に AI が出す【画像生成プロンプト】/【動画化プロンプト】の
// 見出しから判定する。image=画像生成タブへ、video=動画生成タブへ採用する。
type PromptKind = "image" | "video";

type Segment =
  | { kind: "text"; content: string }
  | { kind: "code"; content: string; promptKind: PromptKind };

const FENCE_RE = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g;

// コードブロック直前の「見出し行」だけを見て image/video を判定する。
// 本文の説明文に「i2v の元画像が要る」等が混じっても誤判定しないよう、
// 末尾の非空行(=直近の見出し)に動画マーカーがあるときだけ video にする。
function detectPromptKind(precedingText: string): PromptKind {
  const lastLine =
    precedingText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop() ?? "";
  if (/【動画化プロンプト】|動画化プロンプト/.test(lastLine)) {
    return "video";
  }
  return "image";
}

function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  // 正規表現を使い回すので毎回 lastIndex をリセット
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const precedingText = text.slice(cursor, match.index);
    if (match.index > cursor) {
      segments.push({ kind: "text", content: precedingText });
    }
    const inner = match[1].replace(/\n+$/g, "").trim();
    if (inner.length > 0) {
      // このコードブロック直前のテキスト（見出し）から画像/動画を判定。
      segments.push({
        kind: "code",
        content: inner,
        promptKind: detectPromptKind(precedingText),
      });
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
  onAdopt: (text: string, kind: PromptKind) => void;
}) {
  const isUser = msg.role === "user";
  const displayText = isUser
    ? stripFinalizePrompt(stripStoryboardParams(msg.text))
    : stripStoryboardParams(msg.text);
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
            {/* go4: 送信した音源をユーザー吹き出しに残す (再起動後の復元でも表示)。 */}
            {msg.attachedAudio && (
              <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1">
                <span className="text-[12px] text-pink-400">♪</span>
                <span className="max-w-[200px] truncate text-[10px] font-bold text-neutral-300">
                  {msg.attachedAudio.fileName}
                </span>
                <span className="text-[10px] text-neutral-500">
                  ({formatDuration(msg.attachedAudio.durationSec)})
                </span>
              </div>
            )}
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
                    promptKind={seg.promptKind}
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
            {/* 通常メッセージ末尾の「この回答を採用」は撤去。
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
 * 採用ボタンは promptKind で出し分ける:
 *  - image: 「画像で採用」(チェックアイコン) → 画像生成タブへ
 *  - video: 「動画で採用」(クラッパーアイコン) → 動画生成タブへ (プロンプト入力済み状態)
 */
function PromptBlock({
  prompt,
  promptKind,
  onAdopt,
  disabled,
}: {
  prompt: string;
  promptKind: PromptKind;
  onAdopt: (prompt: string, kind: PromptKind) => void;
  disabled?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      /* noop */
    }
  };
  const isVideo = promptKind === "video";
  return (
    <div className="overflow-hidden rounded-lg border border-[#3a3a3a] bg-[#0d0d0d]">
      <div
        className={[
          "flex items-center gap-1.5 border-b px-3 py-1.5 text-[12px] font-black",
          isVideo
            ? "border-purple-500/30 bg-purple-500/10 text-purple-200"
            : "border-pink-500/30 bg-pink-500/10 text-pink-200",
        ].join(" ")}
      >
        {isVideo ? <ClapperIcon /> : <ImageIcon />}
        <span>
          {isVideo ? "動画化プロンプト (Image to Video)" : "画像生成プロンプト"}
        </span>
      </div>
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
          onClick={() => onAdopt(prompt, promptKind)}
          disabled={disabled}
          className={[
            "flex items-center gap-1.5 rounded-md px-3 py-1 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500",
            "bg-pink-500 hover:bg-pink-400",
          ].join(" ")}
          title={
            isVideo
              ? "このプロンプトで動画生成タブへ（元画像は動画タブでセット）"
              : "このプロンプトを採用して画像生成タブへ"
          }
        >
          {isVideo ? <ClapperIcon /> : <CheckIcon />}
          <span>{isVideo ? "動画で採用" : "画像で採用"}</span>
        </button>
      </div>
    </div>
  );
}

/** 動画プロンプト用。カチンコ (絵文字を使わずフラットアイコンで表現)。 */
function ClapperIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3.5 10 2.8 6.4a1 1 0 0 1 .8-1.2l14.7-2.6a1 1 0 0 1 1.2.8L20 7z" />
      <path d="m8.4 3.9 1 4.8M13.4 3 14.4 7.8" />
    </svg>
  );
}

/** 画像プロンプト用。写真フレーム (絵文字を使わずフラットアイコンで表現)。 */
function ImageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

/** 添付を外すボタン用。× 記号でなくフラットアイコンで描く。 */
function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** 採用ボタン用のチェック。 */
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChatInput({
  value,
  attachments,
  audio: audioAttachment,
  onRemoveAudio,
  onAddFiles,
  onOpenLibrary,
  onAddImagePaths,
  onRemoveAttachment,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  attachments: string[];
  /** go4: 添付中の音源 (1 曲まで)。null なら未添付。 */
  audio: AudioAttachment | null;
  onRemoveAudio: () => void;
  onAddFiles: (files: FileList | File[]) => void;
  /** ライブラリ選択モーダルを開く (2026-07-27 追加)。 */
  onOpenLibrary: () => void;
  /** プリセット由来の参照画像パスを直接添付する (File 変換を経由しない)。 */
  onAddImagePaths: (paths: string[]) => void;
  onRemoveAttachment: (path: string) => void;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canSend =
    value.trim().length > 0 || attachments.length > 0 || audioAttachment !== null;
  /** 企画タブからプリセットを呼び出し、draft 末尾に追記する。 */
  const presetBtnRef = useRef<HTMLButtonElement | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetAnchor, setPresetAnchor] = useState<DOMRect | null>(null);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (files && files.length > 0) onAddFiles(files);
    event.currentTarget.value = "";
  };

  const openPreset = () => {
    if (presetBtnRef.current) {
      setPresetAnchor(presetBtnRef.current.getBoundingClientRect());
    }
    setPresetOpen(true);
  };

  return (
    <div className="space-y-2">
      {/* go4: 添付音源チップ。役割トグル (キャラ/スタイル) は音声には出さない。 */}
      {audioAttachment && (
        <div className="flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#101010] px-2.5 py-2">
          <span className="text-[13px] text-pink-400">♪</span>
          <span className="max-w-[220px] truncate text-[11px] font-bold text-neutral-200">
            {audioAttachment.fileName}
          </span>
          <span className="text-[10px] text-neutral-500">
            ({formatDuration(audioAttachment.durationSec)})
          </span>
          <button
            type="button"
            onClick={onRemoveAudio}
            className="ml-auto text-neutral-500 hover:text-white"
            title="音源を外す"
            aria-label="音源を外す"
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2">
          <div>
            <p className="text-[12px] font-bold text-neutral-200">添付画像の役割</p>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              キャラ参照 = 同一性を保つ / スタイル参照 = タッチのみ
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {attachments.map((path) => (
              <div
                key={path}
                className="flex flex-col gap-1.5 rounded-md border border-[#343434] bg-[#0b0b0b] p-1.5"
              >
                <div className="flex items-center gap-2">
                  <SafeImage path={path} alt="" className="h-9 w-9 rounded object-cover" fallbackLabel="なし" />
                  <span className="max-w-[140px] truncate text-[10px] font-bold text-neutral-300">{basename(path)}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(path)}
                    className="text-neutral-500 hover:text-white"
                    aria-label={`${basename(path)} を外す`}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <ReferenceRoleToggle path={path} />
              </div>
            ))}
          </div>
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
          accept="image/*,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
          multiple
          onChange={onPick}
          className="hidden"
        />
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // 日本語入力の変換確定 Enter を送信と取り違えないためのガード。
            // isComposing / keyCode 229 のどちらかが立っていたら変換中。
            const isComposing =
              (event.nativeEvent as KeyboardEvent).isComposing ||
              event.keyCode === 229;
            if (event.key !== "Enter" || isComposing) return;
            // 2026-07-27: キーボードだけで送れるようにした (STΛCK 要望: 送信がボタンだけ)。
            //
            // 規則は Enter=送信 / Shift+Enter=改行。一度 Shift+Enter=送信 で実装したが、
            // (a) Slack / ChatGPT / Discord など主要チャットは全て Shift+Enter=改行で、
            //     箇条書きを書こうとした瞬間に書きかけが送信される
            // (b) このアプリ内でも 3D 画面 (Scene3dWorkspace.tsx:3250) が Enter=送信・
            //     Shift+Enter=改行 で、同じアプリで真逆になる
            // という2点でレビューに落ちたため、標準側へ寄せた。
            // ⌘/Ctrl+Enter も送信のまま残す (絵コンテ GoalChatPanel との互換)。
            if (event.shiftKey) return; // 改行
            event.preventDefault();
            onSend();
          }}
          rows={1}
          placeholder="メッセージを入力"
          disabled={disabled}
          className="min-h-[52px] resize-none bg-transparent px-4 pb-1 pt-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 disabled:opacity-60"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="画像・音源を添付"
              aria-label="画像を添付"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            {/*
              F-#8 (2026-05-19): プリセット呼び出し。draft 末尾に追記。
              企画タブで蓄積テンプレからプロンプト雛形を引きやすくする。
            */}
            <button
              ref={presetBtnRef}
              type="button"
              onClick={openPreset}
              disabled={disabled}
              title="プリセット呼び出し"
              aria-label="プリセット呼び出し"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            {/*
              2026-07-27: ライブラリ呼び出し (STΛCK 要望)。
              以前はファイル選択しか無く、アプリ内に既にある画像を使うのに
              一度書き出してから選び直す必要があった。
            */}
            <button
              type="button"
              onClick={onOpenLibrary}
              disabled={disabled}
              title="ライブラリから選ぶ"
              aria-label="ライブラリから選ぶ"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            title="送信 (Enter / 改行は Shift + Enter)"
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
      {/*
        F-#8: プリセット呼び出し → draft 末尾追記。
        F-#6/#7: プリセットに参照画像があれば企画チャットの添付にも自動追加。
        企画タブは composer.references でなく pendingImages (パス配列) で添付を
        管理しているので、attachedImages の path をそのまま流す。
      */}
      <PresetPickerPopover
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        anchorRect={presetAnchor}
        onPick={(preset) => {
          const current = value.trim();
          // キャラ型プリセットは属性テキストも合成 (プロンプト型は preset.prompt のまま)。
          const presetBody = composePresetPrompt(preset, "\n");
          const next = current ? `${current}\n${presetBody}` : presetBody;
          onChange(next);
          // キャラ型は速度対策で既定3枚に絞る (selectCharacterReferences)。
          // 企画タブは path 配列で添付するので、絞った参照の path を流す。
          const paths = selectCharacterReferences(preset)
            .map((ref) => ref.path)
            .filter((p) => p.length > 0);
          if (paths.length > 0) onAddImagePaths(paths);
        }}
      />
    </div>
  );
}

/**
 * g8t (2026-08-04): 未保存企画チャットの案件昇格バンド。
 *
 * プロジェクト未選択 + 会話ありのときだけ、確定バンドの上に出す。
 * 名前は deriveTitle (最初の user メッセージ先頭40字 = 履歴ページの表示名) を
 * プリフィルし、編集可。処理は planChat.promoteToProject に委譲する。
 * 昇格は **ディスク保存の完了を待つ非同期処理** (会話が消える窓を作らないため)
 * なので、待機中は promoting でボタンを止め、失敗したら台帳に残っている旨を伝える。
 *
 * sending / starting で disable **しない**: 昇格は thread を作り直さないので
 * 応答ストリーミング中でも安全で、turn/completed は昇格後の案件へ保存される。
 */
function PromoteToProjectBand() {
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const messages = usePlanChat((s) => s.messages);
  const promoteToProject = usePlanChat((s) => s.promoteToProject);
  // 保存完了を待つあいだボタンを止める (連打で案件が2つ出来るのを見た目でも防ぐ。
  // 実体の二重実行ガードは planChat 側の promoting フラグ)。
  const promoting = usePlanChat((s) => s.promoting);
  const pushToast = useToasts((s) => s.push);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  if (activeProjectId !== null || messages.length === 0) return null;

  const startEditing = () => {
    setName(deriveTitle(messages));
    setEditing(true);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = await promoteToProject(trimmed);
    if (!result.ok) {
      // 保存失敗と、そもそも実行しなかった (guard) を区別して伝える。
      // save-failed でも会話は未保存台帳に残っているので、そこを明言して
      // 「消えた」と誤解させない。編集状態は畳まず、そのまま再試行できる。
      pushToast(
        result.reason === "save-failed"
          ? {
              kind: "error",
              text: "案件の保存に失敗しました。会話は「未保存」のまま残っているので、もう一度お試しください",
              ttlMs: 8000,
            }
          : {
              kind: "error",
              text: "案件にできませんでした。会話が空でないか確認してください",
              ttlMs: 5000,
            },
      );
      return;
    }
    pushToast({
      kind: "success",
      text: `案件「${result.projectName}」を作成し、企画チャットを保存しました。ここからの会話と生成画像も自動で保存されます`,
      ttlMs: 4200,
    });
    // バンド自体は activeProjectId が立つことでレンダー条件から消えるが、
    // 状態は畳んだ形に戻しておく (次に「保存しない」へ戻ったときの初期状態)。
    setEditing(false);
    setName("");
  };

  if (!editing) {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2">
        <p className="text-[11px] font-bold leading-relaxed text-amber-100">
          この企画はまだ案件になっていません（履歴に7日間だけ残ります）
        </p>
        <button
          type="button"
          onClick={startEditing}
          className="shrink-0 rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-black text-white shadow hover:bg-amber-400"
          title="ここまでの会話を新しい案件として保存する"
        >
          案件にする
        </button>
      </div>
    );
  }

  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/5 px-3 py-2">
      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // IME 変換確定の Enter を送信と誤認しない (ActiveProjectSelector と同パターン)。
          const isComposing =
            (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
          if (event.key === "Enter" && !isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
        placeholder="案件名"
        autoFocus
        className="h-7 flex-1 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-xs text-neutral-100 outline-none focus:border-amber-400"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!name.trim() || promoting}
        className="h-7 shrink-0 rounded-md bg-amber-500 px-3 text-[11px] font-bold text-white hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {promoting ? "保存中…" : "この名前で作成"}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        disabled={promoting}
        className="h-7 shrink-0 rounded-md border border-[#343434] px-3 text-[11px] font-bold text-neutral-300 hover:bg-[#242424] disabled:cursor-not-allowed disabled:text-neutral-600"
      >
        やめる
      </button>
    </div>
  );
}

function AttachmentThumbs({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {paths.map((path) => (
        <div key={path} className="overflow-hidden rounded-md border border-pink-300/30 bg-black/20">
          {/* y73 (2026-08-03): 高さ固定のまま幅を原画比率に追従させる (行高さは崩さない) */}
          <SafeImage path={path} alt={basename(path)} className="h-16 w-auto max-w-32 object-contain" />
        </div>
      ))}
    </div>
  );
}
