import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { SafeImage } from "../../SafeImage";
import { useSkillVisible } from "../../SkillWorkspaceRouter";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { PageHelp } from "../../PageHelp";
import { GenerationGauge } from "../../GenerationGauge";
import { CharacterIcon } from "../../SkillIcon";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useToasts } from "../../../lib/store/toasts";
import {
  MAX_CHARACTER_REFERENCE_IMAGES,
  MAX_OUTSTANDING_SHEET_JOBS,
  ensureSheetSlotPhaseListener,
  selectModeJobs,
  sheetJobPhase,
  useCharacterSheetRun,
  useFocusedSheetJob,
} from "../../../lib/store/characterSheetRun";
import type { SheetJob, SheetJobPhase } from "../../../lib/store/characterSheetRun";
import { cancelGeneration, type CharacterSheetRunParams } from "../../../lib/ipc";
import { usePresets } from "../../../lib/store/presets";
import { ensureCharacterSheetEventListener } from "../../../lib/character/events";
import type { SheetBackground, SheetCutState, SheetPromptMode } from "../../../lib/character/types";
import {
  BUILT_IN_SHEET_TEMPLATES,
  IDENTITY_5VIEW_PROMPT_TEMPLATE,
  fillSheetTemplatePrompt,
  type UserSheetTemplate,
} from "../../../lib/character/sheetTemplates";
import { defaultIdentityChecker } from "../../../lib/character/identityCheck";
import type { IdentityCheckResult } from "../../../lib/character/identityCheck";
import { registerCharacter } from "../../../lib/character/registerCharacter";
import {
  CHARACTER_NEXT_STEP_SKILL_IDS,
  openSkillWithCharacter,
} from "../../../lib/character/openSkillWithCharacter";
import { GORI_SKILLS } from "../../../lib/skills/catalog";
import { SheetTemplatePickerModal } from "./SheetTemplatePickerModal";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const COMPOSITE_ASPECT_RATIO = "3:4";
const COMPOSITE_SHEET_CUT = {
  cutId: "character-sheet",
  label: "キャラクターシート",
  role: "character-sheet",
} as const;

/** 背景色セレクタの選択肢 (2026-08-03 STΛCK確定仕様の4択)。 */
const SHEET_BACKGROUND_OPTIONS: { value: SheetBackground; label: string }[] = [
  { value: "auto", label: "既定" },
  { value: "white", label: "白" },
  { value: "green", label: "グリーンバック" },
  { value: "blue", label: "ブルーバック" },
];

const SAVED_CUSTOM_TEMPLATE_ID = "saved-custom-template";
const USER_TEMPLATE_MARKER_PREFIX = "<!-- gori-sheet-template-id:";

type ResolvedSheetTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string | null;
};

function encodeUserTemplatePrompt(id: string, prompt: string): string {
  return `${USER_TEMPLATE_MARKER_PREFIX}${id} -->\n${prompt}`;
}

function decodeUserTemplatePrompt(rawPrompt: string): { id: string | null; prompt: string } {
  if (!rawPrompt.startsWith(USER_TEMPLATE_MARKER_PREFIX)) {
    return { id: null, prompt: rawPrompt };
  }
  const markerEnd = rawPrompt.indexOf(" -->\n");
  if (markerEnd < 0) return { id: null, prompt: rawPrompt };
  return {
    id: rawPrompt.slice(USER_TEMPLATE_MARKER_PREFIX.length, markerEnd),
    prompt: rawPrompt.slice(markerEnd + " -->\n".length),
  };
}

function resolveSheetTemplate(
  mode: SheetPromptMode,
  prompt: string,
  userTemplates: UserSheetTemplate[],
): ResolvedSheetTemplate {
  if (mode === "default" || !prompt.trim()) return BUILT_IN_SHEET_TEMPLATES[0];
  const decoded = decodeUserTemplatePrompt(prompt);
  const userTemplate = decoded.id
    ? userTemplates.find((template) => template.id === decoded.id)
    : undefined;
  if (userTemplate) {
    return {
      ...userTemplate,
      description: userTemplate.name,
    };
  }
  if (decoded.prompt === IDENTITY_5VIEW_PROMPT_TEMPLATE) return BUILT_IN_SHEET_TEMPLATES[1];
  // 旧「自分で作る」で保存済みのキャラも、作り直し経路を壊さず使えるようにする。
  return {
    id: SAVED_CUSTOM_TEMPLATE_ID,
    name: "登録済みテンプレート",
    description: "以前に登録したシート設定",
    prompt: decoded.prompt,
  };
}

function resolveSheetPromptOverride(
  mode: SheetPromptMode,
  rawPrompt: string,
  characterName: string,
  attributes: string,
): string | undefined {
  if (mode === "default" || !rawPrompt.trim()) return undefined;
  return fillSheetTemplatePrompt(decodeUserTemplatePrompt(rawPrompt).prompt, {
    name: characterName,
    attributes,
  });
}

/** セグメント型ボタンの共通クラス (選択中 / 非選択)。参照ラックのボタンと同系トーン。 */
function segmentButtonClass(selected: boolean): string {
  return (
    "rounded-md px-2 py-1 text-[10px] font-bold transition " +
    (selected
      ? "bg-pink-500 text-white"
      : "border border-[#343434] text-neutral-400 hover:border-pink-400/60 hover:text-white")
  );
}

function buildCompositeSheetParams(
  characterImages: string[],
  attributes: string,
  runId: string,
  sheetBackground: SheetBackground,
  sheetPromptOverride?: string,
): CharacterSheetRunParams {
  return {
    // 単数 characterImage は後方互換のため常にメイン(先頭)を入れて送る。
    characterImage: characterImages[0],
    characterImages,
    attributes,
    aspectRatio: COMPOSITE_ASPECT_RATIO,
    generationMode: "composite",
    runId,
    sheetBackground,
    customPrompt: "",
    ...(sheetPromptOverride ? { sheetPromptOverride } : {}),
  };
}

/**
 * キャラクター登録 Workspace(IPアセット化パイプライン・スライスS4)
 *
 * 1枚の参照画像から統合キャラクターシート1枚を生成し、キャラ型プリセットへ登録する
 * ウィザード(ステップ制の1ワークスペース)。
 *
 * SkillWorkspaceRouter が activeUiMode === "characterRegister" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / MultiAngleWorkspace は触らない。
 */
export function CharacterRegisterWorkspace() {
  const openPreview = useImagePreview((s) => s.open);
  const enterMode = useCharacterSheetRun((s) => s.enterMode);
  const pushToast = useToasts((s) => s.push);

  // 表情差分と run ストアを共有するため、入場時に「他スキルの mode を引き継いで
  // いれば」初期化する。自分(character)の実行中 run は保持する。
  //
  // マウント時ではなく「表示になった時」に呼ぶ (Sol 評価 blocking#4 / 2026-08-04)。
  // S2 の mount-pool 化で再訪しても再マウントされないため、マウント時 useEffect の
  // ままだと 2 回目以降の入場で enterMode が走らず、表情差分の mode を引きずったまま
  // キャラ登録の画面が出る (警告も出ない)。visible を依存に入れることで、裏へ回って
  // 戻るたびに 1 回ずつ発火する。enterMode は自分の mode なら何もしない冪等な実装
  // (characterSheetRun.ts: `if (s.mode === mode) return s;`) なので、
  // 同じスキル内でのタブ往復で状態が壊れることはない。
  const visible = useSkillVisible();
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    enterMode("character");
    async function registerEventListener() {
      try {
        await ensureCharacterSheetEventListener();
      } catch (err) {
        if (cancelled) return;
        useCharacterSheetRun.getState().reset();
        pushToast({
          kind: "error",
          text: `進捗通知の受信準備に失敗しました: ${(err as Error)?.message ?? err}`,
          ttlMs: 6000,
        });
      }
    }
    void registerEventListener();
    // 生成枠のフェーズ通知。失敗しても生成は動くので画面は止めない
    // (「順番待ち」の判別が従来どおりカットイベント基準に落ちるだけ)。
    void ensureSheetSlotPhaseListener().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, enterMode, pushToast]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <StepIndicator />
        <JobRail />
        <div className="px-4 pt-3">
          <PageHelp
            what="キャラの絵を1〜6枚渡すと、正面・横・後ろ姿と表情、顔アップをまとめて作り、「このキャラ」として登録します。登録しておくと、他のスキルからも同じ顔のまま呼び出せます。"
            first="まずは下から、そのキャラが写った絵を選んでください。2枚目以降は角度違いや衣装の資料として使われます。"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <CharacterRegisterBody onPreview={(path, all) => openPreview(path, all)} />
        </div>
      </div>
    </section>
  );
}

const STEP_LABELS: { step: 1 | 2 | 3; label: string }[] = [
  { step: 1, label: "1. 入力" },
  { step: 2, label: "2. 生成・結果" },
  { step: 3, label: "3. 確認して登録" },
];

function StepIndicator() {
  const step = useCharacterSheetRun((s) => s.step);
  return (
    <div className="flex items-center gap-2 border-b border-[#242424] px-4 py-2">
      {STEP_LABELS.map((s) => (
        <div
          key={s.step}
          className={
            "rounded-full px-3 py-1 text-[11px] font-black " +
            (step === s.step
              ? "bg-pink-500 text-white"
              : step > s.step
                ? "bg-[#1c2a20] text-emerald-300"
                : "bg-[#1a1a1a] text-neutral-500")
          }
        >
          {s.label}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ジョブレール: 仕込んだキャラを横並びで見せる (SQ2 / 2026-08-04)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * レールのカードに出す状態バッジ (文言と色)。
 * 状態そのものの導出は store 側の `sheetJobPhase` が持つ (UI を描かずに検査できる形にしてある)。
 */
const RAIL_BADGE: Record<SheetJobPhase, { text: string; className: string }> = {
  waiting: { text: "順番待ち", className: "bg-[#242424] text-neutral-400" },
  running: { text: "生成中", className: "bg-pink-500/20 text-pink-300" },
  completed: {
    text: "完成・登録待ち",
    className: "bg-emerald-500/20 text-emerald-300",
  },
  failed: { text: "失敗", className: "bg-red-500/15 text-red-300" },
};

/**
 * 仕込み中・完成待ちのジョブを仕込み順に並べる横帯。
 *
 * ジョブが 0 件なら**何も描かない**。1体だけ登録する人の画面は今日と完全に同じままにする
 * (連続登録のための器が、単発利用者の視界を常時削らないようにする)。
 */
function JobRail() {
  // zustand v5 はセレクタの返り値を Object.is で比較するので、毎回新しい配列を返す
  // セレクタを直に渡すと無限再描画になる。台帳の3つの原子だけを購読し、
  // 導出は useMemo でやる (参照が安定する)。
  const jobs = useCharacterSheetRun((s) => s.jobs);
  const jobOrder = useCharacterSheetRun((s) => s.jobOrder);
  const mode = useCharacterSheetRun((s) => s.mode);
  const focusedJobId = useCharacterSheetRun((s) => s.focusedJobId);
  const focusJob = useCharacterSheetRun((s) => s.focusJob);
  const dismissJob = useCharacterSheetRun((s) => s.dismissJob);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const pushToast = useToasts((s) => s.push);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const railJobs = useMemo(
    () => selectModeJobs({ jobs, jobOrder, mode }),
    [jobs, jobOrder, mode],
  );

  if (railJobs.length === 0) return null;

  /** カードをクリックしたときの行き先。完成なら登録画面、それ以外は結果画面。 */
  function openJob(job: SheetJob) {
    focusJob(job.jobId);
    setStep(job.status === "completed" ? 3 : 2);
  }

  /**
   * 中止。押した瞬間に「やめました」と言わず、cancel_generation の結果を見てから
   * 文言を決める (ipc.ts cancelGeneration の注記どおり)。
   * 台帳から外すのは中止の成否によらない —— ユーザーが「これはもう要らない」と
   * 言った以上、レールに残し続けるほうが混乱する。
   */
  async function cancelJob(job: SheetJob) {
    setCancelling(job.jobId);
    try {
      const result = await cancelGeneration(job.activeRunId);
      pushToast({
        kind: "info",
        text: result.found
          ? "生成を中止しました。"
          : "この生成はすでに終わっていたため、表示だけ片付けました。",
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `中止に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    } finally {
      dismissJob(job.jobId);
      setCancelling(null);
    }
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-[#242424] bg-[#101010] px-4 py-2">
      <span className="shrink-0 text-[10px] font-black uppercase tracking-wider text-neutral-600">
        仕込み中 {railJobs.length}/{MAX_OUTSTANDING_SHEET_JOBS}
      </span>
      {railJobs.map((job) => {
        const badge = RAIL_BADGE[sheetJobPhase(job)];
        const thumbnail = job.input.characterImagePaths[0];
        const focused = job.jobId === focusedJobId;
        return (
          <div
            key={job.jobId}
            role="button"
            tabIndex={0}
            onClick={() => openJob(job)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openJob(job);
              }
            }}
            title={
              job.status === "completed"
                ? "クリックすると、このキャラの登録画面へ進みます"
                : "クリックすると、このキャラの結果画面へ移動します"
            }
            className={
              "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 transition " +
              (focused
                ? "border-pink-400/60 bg-[#1a1416]"
                : "border-[#2a2a2a] bg-[#141414] hover:border-neutral-500")
            }
          >
            {thumbnail ? (
              <SafeImage
                path={thumbnail}
                alt=""
                className="h-8 w-8 shrink-0 rounded object-cover"
              />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[#0d0d0d]">
                <CharacterIcon className="h-4 w-4 text-neutral-600" />
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="max-w-[9rem] truncate text-[11px] font-bold text-neutral-200">
                {job.input.characterName.trim() || "名前未入力"}
              </span>
              <span
                className={
                  "w-fit rounded px-1.5 py-0.5 text-[9px] font-black " + badge.className
                }
              >
                {badge.text}
              </span>
            </div>
            {/*
              × は「取り消し」。走行中・順番待ちなら実際に cancel_generation を送る。
              完成・失敗したジョブでは走っている生成が無いので、台帳から外すだけ。
            */}
            <button
              type="button"
              aria-label={`${job.input.characterName.trim() || "名前未入力"}のジョブを取り消す`}
              title={
                job.status === "running"
                  ? "この生成を中止して、レールから外します"
                  : "このジョブをレールから外します"
              }
              disabled={cancelling === job.jobId}
              onClick={(e) => {
                e.stopPropagation();
                if (job.status === "running") {
                  void cancelJob(job);
                } else {
                  dismissJob(job.jobId);
                }
              }}
              className="shrink-0 rounded p-1 text-neutral-600 transition hover:bg-[#2a2a2a] hover:text-red-300 disabled:opacity-40"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function CharacterRegisterBody({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  const step = useCharacterSheetRun((s) => s.step);
  if (step === 1) return <StepInput />;
  if (step === 2) return <StepGenerate onPreview={onPreview} />;
  return <StepRegister onPreview={onPreview} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: 入力
// ─────────────────────────────────────────────────────────────────────────────

function StepInput() {
  const characterName = useCharacterSheetRun((s) => s.characterName);
  const setCharacterName = useCharacterSheetRun((s) => s.setCharacterName);
  const characterImagePaths = useCharacterSheetRun((s) => s.characterImagePaths);
  const addCharacterImages = useCharacterSheetRun((s) => s.addCharacterImages);
  const removeCharacterImage = useCharacterSheetRun((s) => s.removeCharacterImage);
  const promoteCharacterImage = useCharacterSheetRun((s) => s.promoteCharacterImage);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const setAttributes = useCharacterSheetRun((s) => s.setAttributes);
  const sheetPromptMode = useCharacterSheetRun((s) => s.sheetPromptMode);
  const setSheetPromptMode = useCharacterSheetRun((s) => s.setSheetPromptMode);
  const customSheetPrompt = useCharacterSheetRun((s) => s.customSheetPrompt);
  const setCustomSheetPrompt = useCharacterSheetRun((s) => s.setCustomSheetPrompt);
  const sheetBackground = useCharacterSheetRun((s) => s.sheetBackground);
  const setSheetBackground = useCharacterSheetRun((s) => s.setSheetBackground);
  const beginRun = useCharacterSheetRun((s) => s.beginRun);
  const regenerateTargetPresetId = useCharacterSheetRun((s) => s.regenerateTargetPresetId);
  const setRegenerateTarget = useCharacterSheetRun((s) => s.setRegenerateTarget);
  const regenTarget = usePresets(
    (s) => s.presets.find((p) => p.id === regenerateTargetPresetId) ?? null,
  );
  const sheetTemplates = usePresets((s) => s.sheetTemplates);

  const pushToast = useToasts((s) => s.push);
  const openPreview = useImagePreview((s) => s.open);
  const [extracting, setExtracting] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  /**
   * invoke の往復中だけ立つ連打ガード (SQ2 / 2026-08-04)。
   *
   * 旧実装は「ストア全体で走行中なら押せない」だったが、それが
   * 「1体終わるまで次に着手できない」の正体だった。走行中でも仕込めるようにする以上、
   * 全体ガードは撤去する。各ジョブは独立した runId を持つので衝突しない。
   * ここで防ぎたいのは「1回の押下が2本のジョブになる」ことだけ。
   */
  const [submitting, setSubmitting] = useState(false);

  const selectedTemplate = resolveSheetTemplate(
    sheetPromptMode,
    customSheetPrompt,
    sheetTemplates,
  );
  const canRun = characterImagePaths.length >= 1 && !submitting;

  function selectSheetTemplate(template: { id: string; prompt: string | null }) {
    if (template.prompt == null) {
      setSheetPromptMode("default");
      setCustomSheetPrompt("");
      return;
    }
    setSheetPromptMode("custom");
    // 生の雛形を保持し、名前・属性の穴埋めは生成の直前に行う。
    setCustomSheetPrompt(
      template.id === "identity-5view"
        ? template.prompt
        : encodeUserTemplatePrompt(template.id, template.prompt),
    );
  }

  async function pickCharacterImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      // multiple: true でも実装によっては単一文字列が返るため両対応にする。
      const picked = Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
      if (picked.length === 0) return;
      const result = addCharacterImages(picked);
      if (result.rejected > 0) {
        pushToast({
          kind: "info",
          text: `参照画像は最大6枚までです。${result.added} 枚を追加し、${result.rejected} 枚は追加できませんでした。`,
          ttlMs: 4000,
        });
      } else if (result.added > 0) {
        pushToast({
          kind: "success",
          text: `参照画像を ${result.added} 枚追加しました。`,
          ttlMs: 2500,
        });
      } else if (result.duplicates > 0) {
        pushToast({
          kind: "info",
          text: "選択した画像はすでに参照画像にあります。",
          ttlMs: 3000,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function autoExtractAttributes() {
    // 抽出対象はメイン(先頭)1枚のみ。補助画像の食い違いを拾うと属性が汚れる。
    const mainImage = characterImagePaths[0];
    if (!mainImage) {
      pushToast({ kind: "info", text: "先に参照画像を選んでください。", ttlMs: 3000 });
      return;
    }
    setExtracting(true);
    try {
      let desc: string;
      try {
        desc = await invoke<string>("codex_describe_image", {
          imagePath: mainImage,
        });
      } catch (firstErr) {
        const message = (firstErr as Error)?.message ?? String(firstErr);
        // タイムアウトは即時再試行しても 300 秒待たせるだけなのでリトライしない。
        // 判定文字列は src-tauri/src/commands/codex_vision.rs のエラー文言に依存する
        // (あちらの文言を変えるときはここも合わせること)。
        if (message.includes("タイムアウト")) {
          pushToast({
            kind: "error",
            text: "属性の自動抽出がタイムアウトしました。少し時間をおいて再度お試しください。属性は手入力でも設定できます。",
            ttlMs: 8000,
          });
          return;
        }
        // 「stream disconnected」等の一過性の通信断は即時再試行で回復する型。1回だけ再試行する。
        pushToast({
          kind: "info",
          text: "属性の自動抽出に失敗したため、もう一度試しています…",
          ttlMs: 3000,
        });
        try {
          desc = await invoke<string>("codex_describe_image", {
            imagePath: mainImage,
          });
        } catch (secondErr) {
          const reason = (secondErr as Error)?.message ?? String(secondErr);
          pushToast({
            kind: "error",
            text: `属性の自動抽出に2回失敗しました。通信が不安定な可能性があります。少し時間をおいて再度お試しください。属性は手入力でも設定できます。(詳細: ${reason})`,
            ttlMs: 8000,
          });
          return;
        }
      }
      setAttributes(desc);
      pushToast({ kind: "success", text: "属性の下書きを生成しました(編集できます)。", ttlMs: 3000 });
    } finally {
      setExtracting(false);
    }
  }

  async function runGeneration() {
    if (submitting) return;
    if (characterImagePaths.length === 0) {
      pushToast({ kind: "info", text: "先に参照画像を選んでください。", ttlMs: 3000 });
      return;
    }
    // 全体ガードを撤去した代わりの3本柱のうち2本 (残り1本は上の submitting)。
    // 走行中でも仕込めるようにすると、この2つが新たに現実の事故になる。
    const runState = useCharacterSheetRun.getState();
    const outstanding = selectModeJobs(runState);
    if (outstanding.length >= MAX_OUTSTANDING_SHEET_JOBS) {
      pushToast({
        kind: "info",
        text: `仕込めるのは同時に ${MAX_OUTSTANDING_SHEET_JOBS} 体までです。先に完成したキャラを登録するか、ジョブを取り消してください。`,
        ttlMs: 6000,
      });
      return;
    }
    // 同じプリセットの作り直しを二重に積ませない。両方完成すると、後から登録したほうが
    // 先の結果を黙って上書きする (B-5 の上書き事故と同型)。積む前に止める。
    if (
      regenerateTargetPresetId &&
      outstanding.some(
        (job) => job.input.regenerateTargetPresetId === regenerateTargetPresetId,
      )
    ) {
      pushToast({
        kind: "info",
        text: `「${regenTarget?.name ?? "このキャラ"}」の作り直しはすでに仕込み中です。先に登録するか取り消してください。`,
        ttlMs: 6000,
      });
      return;
    }

    // フロントで先に run_id を採番し、beginRun 時点から確定 run_id を持つ。これで
    // 全イベントが同じ run_id を載せ、画面往復後の別 run 後着通知を照合で捨てられる
    // (B1 混線対策)。バックエンドは params.runId をそのまま使う。
    const runId = crypto.randomUUID();
    const sheetPromptOverride = resolveSheetPromptOverride(
      sheetPromptMode,
      customSheetPrompt,
      characterName,
      attributes,
    );

    const params = buildCompositeSheetParams(
      characterImagePaths,
      attributes,
      runId,
      sheetBackground,
      sheetPromptOverride,
    );

    // 先に1枚分の pending 状態を作り、開始直後の通知も取りこぼさない。
    // ここで下書きが凍結される (以後この生成の内容は入力欄の変化に影響されない)。
    const jobId = beginRun("character", runId, [COMPOSITE_SHEET_CUT]);
    setSubmitting(true);

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "success",
        text: "キャラクターシートの生成を開始しました。",
        ttlMs: 3000,
      });
    } catch (err) {
      // 起動に失敗したジョブだけを台帳から外す。他のジョブ・下書きは巻き込まない。
      useCharacterSheetRun.getState().dismissJob(jobId);
      useCharacterSheetRun.getState().setStep(1);
      pushToast({
        kind: "error",
        text: `生成の開始に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#242424] bg-[#141414] px-4 py-4">
        {regenTarget && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <p className="text-[11px] leading-relaxed text-amber-200">
              登録キャラ「{regenTarget.name}」のシートを作り直しています。登録すると、このキャラのシートと属性が新しい内容に置き換わります。
            </p>
            <button
              type="button"
              onClick={() => setRegenerateTarget(null)}
              className="mt-1.5 rounded border border-amber-500/40 px-2 py-1 text-[10px] font-bold text-amber-200 transition hover:bg-amber-500/20"
            >
              新規キャラとして登録する
            </button>
          </div>
        )}
        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            キャラ名
          </div>
          <input
            type="text"
            value={characterName}
            onChange={(e) => setCharacterName(e.target.value)}
            placeholder="例: 主人公アリス"
            className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
              参照画像(1〜6枚)
            </span>
            <span className="text-[11px] font-bold text-neutral-500">
              {characterImagePaths.length} / {MAX_CHARACTER_REFERENCE_IMAGES}
            </span>
          </div>
          {characterImagePaths.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {characterImagePaths.map((path, index) => (
                <div key={path} className="flex flex-col gap-1">
                  <div className="relative overflow-hidden rounded-lg border border-[#2a2a2a]">
                    <SafeImage
                      path={path}
                      alt={index === 0 ? "メインの参照画像" : `参照画像 ${index + 1}`}
                      className="aspect-square w-full object-cover"
                    />
                    {index === 0 && (
                      <span className="absolute left-1 top-1 rounded bg-pink-500 px-1.5 py-0.5 text-[9px] font-black text-white">
                        メイン
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label="この参照画像を削除"
                      onClick={() => removeCharacterImage(path)}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] font-black text-neutral-300 transition hover:bg-black hover:text-white"
                    >
                      ×
                    </button>
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => promoteCharacterImage(path)}
                      className="rounded border border-[#343434] px-1 py-0.5 text-[9px] font-bold text-neutral-400 transition hover:border-pink-400/60 hover:text-white"
                    >
                      メインにする
                    </button>
                  )}
                </div>
              ))}
              {characterImagePaths.length < MAX_CHARACTER_REFERENCE_IMAGES && (
                <button
                  type="button"
                  onClick={pickCharacterImage}
                  className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500 transition hover:border-pink-400/60 hover:text-neutral-300"
                >
                  <span className="text-lg">＋</span>
                  <span className="text-[10px] font-bold">追加</span>
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={pickCharacterImage}
              className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500 hover:border-pink-400/60 hover:text-neutral-300"
            >
              <span className="text-2xl">＋</span>
              <span className="text-[12px] font-bold">参照画像を選ぶ</span>
              <span className="text-[10px] text-neutral-600">
                クリックで選択 / 画像をここへドラッグ&ドロップ
              </span>
              <span className="text-[10px] text-neutral-600">
                複数選択できます(最大6枚)
              </span>
            </button>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            シートの作り方
          </div>
          <button
            type="button"
            onClick={() => setTemplatePickerOpen(true)}
            className="w-full rounded-xl border border-pink-500/40 bg-pink-500/10 px-3 py-2.5 text-left transition hover:border-pink-400 hover:bg-pink-500/15"
          >
            <span className="block text-[12px] font-black text-pink-100">
              選択中: {selectedTemplate.name}
            </span>
            <span className="mt-1 block text-[10px] leading-relaxed text-neutral-500">
              {selectedTemplate.description}
            </span>
            <span className="mt-1.5 block text-[10px] font-bold text-pink-300">
              種類を変更する →
            </span>
          </button>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            シートの背景色
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SHEET_BACKGROUND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setSheetBackground(option.value)}
                className={segmentButtonClass(sheetBackground === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-neutral-600">
            {selectedTemplate.id !== "standard"
              ? "既定はプロンプトの指示に従います。色を選ぶと、プロンプト内の背景指定より優先してその背景になります。"
              : "既定はこれまで通りの背景です。色を選ぶと、上段(三面図エリア)の背景がその色になります。下段のシーンショットは変わりません。"}
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
              属性(不変の見た目)
            </span>
            <button
              type="button"
              onClick={() => void autoExtractAttributes()}
              disabled={extracting || characterImagePaths.length === 0}
              className="rounded-md border border-[#343434] px-2 py-0.5 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
            >
              {extracting ? "抽出中…" : "自動抽出"}
            </button>
          </div>
          <textarea
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
            placeholder="例: 黒髪ロング / 青い瞳 / 白いワンピース / 華奢な体型"
            rows={4}
            className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-neutral-600">
            シート全体に反映します。テンプレート内の【記入欄】も、この属性で埋めます。空欄なら参照画像の見た目を踏襲します。
          </p>
        </div>

        <div className="border-t border-[#242424] pt-4">
          <div className="mt-2 text-center text-[12px] font-bold text-neutral-400">
            生成: <span className="text-pink-300">統合シート 1枚</span>
          </div>
          <div className="mt-1 text-center text-[10px] text-neutral-600">
            {selectedTemplate.id === "standard"
              ? "縦長 3:4・全身三面図とシーンショットを1枚にまとめます"
              : `${selectedTemplate.name}の内容で1枚生成します`}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void runGeneration()}
          disabled={!canRun}
          className={`mt-auto flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-black transition ${
            canRun
              ? "bg-pink-500 text-white hover:bg-pink-400"
              : "cursor-not-allowed bg-[#242424] text-neutral-600"
          }`}
        >
          {submitting && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
          )}
          {/*
            走行中でも「生成する」のままにする (SQ2)。ここが「生成中…」で固まるのが
            「1体終わるまで次に着手できない」の見た目だった。走っているものの進捗は
            レールと右上パネルが持つので、このボタンは常に次の1体のためにある。
          */}
          {submitting ? "開始中…" : "キャラクターシートを生成する"}
        </button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-neutral-500">
        {characterImagePaths.length > 0 ? (
          <div className="max-w-md">
            <SafeImage
              path={characterImagePaths[0]}
              alt="参照プレビュー"
              className="mx-auto max-h-[50vh] rounded-xl border border-[#2a2a2a] object-contain"
            />
            {characterImagePaths.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {characterImagePaths.slice(1).map((path) => (
                  <SafeImage
                    key={path}
                    path={path}
                    alt="補助の参照画像"
                    onClick={() => openPreview(path, characterImagePaths)}
                    className="h-16 w-16 cursor-pointer rounded-lg border border-[#2a2a2a] object-cover"
                  />
                ))}
              </div>
            )}
            <p className="mt-4 text-[12px]">
              {selectedTemplate.id !== "standard"
                ? characterImagePaths.length > 1
                  ? `${characterImagePaths.length}枚の参照画像から「${selectedTemplate.name}」を生成します。`
                  : `この参照画像から「${selectedTemplate.name}」を生成します。`
                : characterImagePaths.length > 1
                  ? `1枚目をメインの見た目として、${characterImagePaths.length}枚の参照からキャラクターシートを生成します。`
                  : "この1枚から、全身三面図とシーンショットをまとめたキャラクターシートを生成します。"}
            </p>
          </div>
        ) : (
          <>
            <CharacterIcon className="h-9 w-9 text-neutral-500" />
            <p className="text-[13px] font-bold">参照画像を選んでください(1〜6枚)</p>
            <p className="text-[12px]">統合キャラクターシートを1枚生成します</p>
          </>
        )}
      </div>
      {templatePickerOpen && (
        <SheetTemplatePickerModal
          selectedId={selectedTemplate.id}
          onSelect={selectSheetTemplate}
          onClose={() => setTemplatePickerOpen(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: 生成中・結果
// ─────────────────────────────────────────────────────────────────────────────

function StepGenerate({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  // SQ1: 表示も再生成も「フォーカス中ジョブの凍結スナップショット」から読む。
  // ストアの現在値(下書き)を読まないのが要点 —— 走行中に次のキャラを仕込んでも、
  // この画面が別のキャラの入力を混ぜて表示・再生成することがなくなる。
  const job = useFocusedSheetJob();
  const status = job.status;
  const cuts = job.cuts;
  const cutOrder = job.cutOrder;
  // 2026-07-27: 生成中ゲージ用。カット開始時刻から経過を測る。
  const cutStartedAt = job.cutStartedAt;
  const characterName = job.input.characterName;
  const characterImagePaths = job.input.characterImagePaths;
  const attributes = job.input.attributes;
  const sheetPromptMode = job.input.sheetPromptMode;
  const customSheetPrompt = job.input.customSheetPrompt;
  const sheetBackground = job.input.sheetBackground;
  const replaceJobRun = useCharacterSheetRun((s) => s.replaceJobRun);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const prepareNextCharacter = useCharacterSheetRun((s) => s.prepareNextCharacter);
  const pushToast = useToasts((s) => s.push);
  const sheetTemplates = usePresets((s) => s.sheetTemplates);
  const selectedTemplate = resolveSheetTemplate(
    sheetPromptMode,
    customSheetPrompt,
    sheetTemplates,
  );

  const sheet = cutOrder
    .map((id) => cuts[id])
    .find((cut): cut is SheetCutState => Boolean(cut));
  const startedAt = sheet ? cutStartedAt[sheet.cutId] : undefined;
  const completedPaths =
    sheet?.status === "completed" && sheet.imagePath ? [sheet.imagePath] : [];
  const canProceedToRegister =
    sheet?.status === "completed" && Boolean(sheet.imagePath);

  async function regenerateSheet() {
    if (!job.jobId || characterImagePaths.length === 0 || status === "running") return;
    const nextRunId = crypto.randomUUID();
    // 再生成はジョブの入力(凍結済み)をそのまま使う。同じジョブの run を張り替えるだけなので
    // jobId は変わらず、レール上のカードも同じ位置に居続ける。
    const params = buildCompositeSheetParams(
      characterImagePaths,
      attributes,
      nextRunId,
      sheetBackground,
      resolveSheetPromptOverride(
        sheetPromptMode,
        customSheetPrompt,
        characterName,
        attributes,
      ),
    );
    replaceJobRun(job.jobId, nextRunId, [COMPOSITE_SHEET_CUT]);

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "info",
        text: "キャラクターシートを再生成しています。",
        ttlMs: 2500,
      });
    } catch (err) {
      // 起動に失敗した run は台帳から外す (走っていないジョブを「生成中」に見せない)。
      useCharacterSheetRun.getState().dismissJob(job.jobId);
      pushToast({
        kind: "error",
        text: `再生成に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold text-neutral-300">
          <span>
            {sheet?.status === "failed"
              ? "生成失敗"
              : sheet?.status === "completed"
                ? "生成完了"
                : sheet?.status === "running"
                  ? "生成中…"
                  : "待機中"}
          </span>
          <span className="rounded-full bg-pink-500/15 px-2 py-0.5 text-[10px] text-pink-200">
            シート: {selectedTemplate.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-neutral-500 hover:text-white"
          >
            ← 入力に戻る
          </button>
          {/*
            走行中に次のキャラを仕込む導線 (SQ2 / 2026-08-04)。「← 入力に戻る」との違い:
            あちらは今の下書きを触りに戻るだけ、こちらは**キャラ個別の下書きを空にして**戻る。
            シートの作り方・背景色は残す (連続登録では作り方を揃えるのが普通で、
            毎回選び直させるほうが事故に近い)。逆に名前・参照画像・属性・作り直し対象は
            前のキャラの混入がそのまま誤登録になるので必ず消す。
          */}
          <button
            type="button"
            onClick={prepareNextCharacter}
            title="いまの生成は続けたまま、次のキャラの入力を始めます"
            className="rounded-lg border border-pink-400/50 px-3 py-1.5 text-[12px] font-bold text-pink-200 transition hover:bg-pink-500/15 hover:text-white"
          >
            ＋ 次のキャラを仕込む
          </button>
          <button
            type="button"
            onClick={() => setStep(3)}
            disabled={!canProceedToRegister}
            className={
              "rounded-lg px-3 py-1.5 text-[12px] font-black transition " +
              (!canProceedToRegister
                ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                : "bg-pink-500 text-white hover:bg-pink-400")
            }
          >
            確認して登録へ →
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]">
          <div
            className="relative w-full bg-[#0d0d0d]"
            style={{ aspectRatio: "3 / 4" }}
          >
            {sheet?.status === "completed" && sheet.imagePath ? (
              <SafeImage
                path={sheet.imagePath}
                alt={sheet.label}
                className="h-full w-full cursor-pointer object-contain"
                onClick={() => onPreview(sheet.imagePath as string, completedPaths)}
              />
            ) : sheet?.status === "failed" ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-red-300">
                <span className="font-bold">生成に失敗しました</span>
                {sheet.reason && (
                  <span className="max-w-lg text-[10px] text-neutral-500">
                    {sheet.reason}
                  </span>
                )}
              </div>
            ) : (
              /*
                2026-07-27: 生成中の表示を「生成中…」の文字だけから、通常の画像生成と
                同じ「ぐるぐる + 進捗ゲージ」に揃えた (STΛCK 要望)。
                文字だけだと、待たされている間に進んでいるのか固まったのか分からない。
              */
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8">
                {sheet?.status === "running" ? (
                  <>
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                    <span className="text-[12px] font-bold text-pink-300">生成中…</span>
                    {startedAt ? (
                      <div className="w-full max-w-xs">
                        <GenerationGauge startedAt={startedAt} mode="batch" />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[12px] font-bold text-neutral-600">待機中</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div className="text-[12px] font-bold text-neutral-200">
              キャラクターシート（{selectedTemplate.name}）
            </div>
            <button
              type="button"
              onClick={() => void regenerateSheet()}
              disabled={status === "running"}
              className="rounded-lg border border-[#343434] px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
            >
              再生成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: 確認して登録
// ─────────────────────────────────────────────────────────────────────────────

function StepRegister({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  // SQ1: 登録内容は**確定時に凍結したスナップショット**から読む。
  // 旧実装はストアの現在値を読んでいたため、生成中に入力を書き換えると
  // 「Aのシートが、後から入れたBの名前・属性で登録される」事故が成立していた。
  const job = useFocusedSheetJob();
  const characterName = job.input.characterName;
  const characterImagePaths = job.input.characterImagePaths;
  const attributes = job.input.attributes;
  const sheetPromptMode = job.input.sheetPromptMode;
  const customSheetPrompt = job.input.customSheetPrompt;
  const sheetBackground = job.input.sheetBackground;
  const cuts = job.cuts;
  const cutOrder = job.cutOrder;
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const completeJob = useCharacterSheetRun((s) => s.completeJob);
  const regenTarget = usePresets(
    (s) =>
      s.presets.find((p) => p.id === job.input.regenerateTargetPresetId) ?? null,
  );
  const sheetTemplates = usePresets((s) => s.sheetTemplates);
  const pushToast = useToasts((s) => s.push);
  const selectedTemplate = resolveSheetTemplate(
    sheetPromptMode,
    customSheetPrompt,
    sheetTemplates,
  );

  const orderedCuts = useMemo(
    () =>
      cutOrder
        .map((id) => cuts[id])
        .filter((c): c is SheetCutState => Boolean(c)),
    [cutOrder, cuts],
  );
  const completed = useMemo(
    () => orderedCuts.filter((c) => c.status === "completed" && c.imagePath),
    [orderedCuts],
  );
  const sheet = completed[0];
  const completedPaths = completed.map((c) => c.imagePath as string);

  const [identity, setIdentity] = useState<IdentityCheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * H1 (2026-08-05): 登録に成功したキャラ名。null の間は登録前。
   *
   * 旧実装は登録成功と同時に setStep(1) で入力画面へ戻していたため、
   * 「登録できた」の直後が**完全な行き止まり**だった (アンケート最頻出:
   * 「キャラシートの使い道がわからない」同型3件)。そこで登録後は
   * この画面に留まり、次工程の展開先を一度だけ出す。
   *
   * 「次のキャラを登録する」を押したときに初めて Step1 へ戻す
   * (順路を強制しないので、戻る操作もユーザーが選ぶ)。
   */
  const [registeredName, setRegisteredName] = useState<string | null>(null);

  // 検品はメイン(先頭)の参照画像を基準にする。identityCheck は現状 Noop なので
  // 挙動は変わらない (S5 実装時に「メイン基準 + 補助参照」へ拡張する)。
  const mainSourceImage = characterImagePaths[0] ?? "";

  // Phase 3: 生成完了後・登録前に検品フックを await(Noop は unavailable を返す)。
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    void defaultIdentityChecker
      .check(
        mainSourceImage,
        completed.map((c) => ({ cutId: c.cutId, path: c.imagePath as string })),
      )
      .then((result) => {
        if (!cancelled) setIdentity(result);
      })
      .catch(() => {
        if (!cancelled) setIdentity({ verdict: "unavailable" });
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // completed は run 完了後は不変。参照画像とカット数で再検品する。
  }, [mainSourceImage, completed.length]);

  const canRegister =
    Boolean(sheet?.imagePath) && characterName.trim().length > 0 && !saving;

  async function handleRegister() {
    if (!canRegister || characterImagePaths.length === 0) return;
    setSaving(true);
    try {
      const preset = await registerCharacter({
        name: characterName,
        attributes,
        sourceImages: characterImagePaths,
        cuts: sheet ? [sheet] : [],
        identity: identity ?? undefined,
        targetPresetId: regenTarget?.id,
        sheetBackground,
        sheetPromptMode,
        sheetCustomPrompt:
          sheetPromptMode === "custom" ? customSheetPrompt.trim() : undefined,
      });
      if (!preset) {
        pushToast({
          kind: "error",
          text: "登録できるキャラクターシートがありません。",
          ttlMs: 4000,
        });
        return; // saving は finally で解除する
      }
      // どこに入ったかを伝える。2026-07-25 に登録先を「キャラクター」カテゴリへ
      // 変更したので、場所を言わないと「登録したのに見つからない」になる。
      pushToast({
        kind: "success",
        text: regenTarget
          ? `キャラ「${characterName.trim()}」のシートを更新しました。`
          : `キャラ「${characterName.trim()}」を登録しました。プリセットの「キャラクター」から使えます。`,
        ttlMs: 4500,
      });
      // ここで下書きの作り直し対象を解除しない (Sol 評価 blocking#3 / 2026-08-04)。
      // 単発運用のころは「登録した下書き = いま画面にある下書き」だったので解除が
      // 正しかったが、多重化後は「A を登録する時点で下書きは既に B の作り直し」
      // という状態が普通に起きる。そこで解除すると A の登録が B の設定を壊す。
      // 登録に使う対象は凍結済みの job.input から読んでいるので、下書きを
      // 残しても A が別プリセットを誤って上書きすることはない。
      // 下書き側のクリアは「＋ 次のキャラを仕込む」等の既存導線が担う。
      //
      // 登録できたジョブだけを台帳から外す。**下書きには触らない** ——
      // 仕込み途中の次のキャラが消えないことが、連続登録の体験の本体。
      completeJob(job.jobId);
      // H1: ここで setStep(1) しない。登録直後こそ「で、これで何ができるの?」が
      // 最大化する瞬間なので、この画面に留まって展開先を出す。Step1 へ戻すのは
      // 「次のキャラを登録する」を押したときだけ (下の完了パネル)。
      setRegisteredName(characterName.trim());
    } catch (err) {
      pushToast({
        kind: "error",
        text: `登録に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      // 2026-07-25 修正: 成功パスで setSaving(false) が呼ばれておらず、
      // ボタンが永久に「登録中…」のまま固まっていた。reset() は
      // useCharacterSheetRun(store) の関数で、このコンポーネントのローカル state
      // である saving には触らないため、成功しても解除されなかった。
      // 成功・失敗どちらでも必ず解除する。
      setSaving(false);
    }
  }

  // 同一性スコアが取れたときだけバッジを出す。
  // 2026-07-25 STΛCK指示: 内部の未実装事情(「同一性採点は未実装」等)はUIに書かない。
  // 採点できないことはユーザーの関心事ではないので、黙って何も出さない。
  const identityLabel = checking
    ? "検品中"
    : identity?.score != null
      ? `同一性スコア ${identity.score}`
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold text-neutral-300">
          <span>
            登録内容の確認 <span className="text-neutral-500">(シート 1枚)</span>
          </span>
          <span className="rounded-full bg-pink-500/15 px-2 py-0.5 text-[10px] text-pink-200">
            シート: {selectedTemplate.name}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setStep(2)}
          className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-neutral-500 hover:text-white"
        >
          ← 結果に戻る
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px]">
          <span className="font-black text-white">{characterName || "(名前未入力)"}</span>
          {identityLabel && (
            <span
              className={
                "rounded-full px-2 py-0.5 text-[11px] font-bold " +
                (identity?.score != null
                  ? "bg-[#1c2a20] text-emerald-300"
                  : "bg-[#242424] text-neutral-400")
              }
            >
              {identityLabel}
            </span>
          )}
          {attributes.trim() && (
            <span className="truncate text-[11px] text-neutral-500">
              属性: {attributes.trim()}
            </span>
          )}
        </div>

        {sheet?.imagePath && (
          <div className="mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]">
            <SafeImage
              path={sheet.imagePath}
              alt={sheet.label}
              className="w-full cursor-pointer bg-[#0d0d0d] object-contain"
              style={{ aspectRatio: "3 / 4" }}
              onClick={() => onPreview(sheet.imagePath as string, completedPaths)}
            />
            <div className="px-3 py-2 text-[11px] font-bold text-neutral-200">
              キャラクターシート
            </div>
          </div>
        )}
      </div>

      {registeredName ? (
        <NextStepPanel
          characterName={registeredName}
          onRegisterNext={() => {
            setRegisteredName(null);
            setStep(1);
          }}
        />
      ) : (
        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-4 py-3">
          <button
            type="button"
            onClick={() => void handleRegister()}
            disabled={!canRegister}
            className={
              "rounded-xl px-5 py-2.5 text-[14px] font-black transition " +
              (canRegister
                ? "bg-pink-500 text-white hover:bg-pink-400"
                : "cursor-not-allowed bg-[#242424] text-neutral-600")
            }
          >
            {saving ? "登録中…" : regenTarget ? "このキャラを上書き登録" : "このキャラを登録"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * H1 (2026-08-05): 登録完了 → 次の工程への分岐点。
 *
 * 配置文法は AngleGridPanel.tsx:636-641 で確立済みの形に従う ——
 * 「保存系」とは役割が違う「次の工程へ進む」導線なので**行を分けて**出し、
 * アクセント色 (ピンク) を当てる。一等地 (共通ヘッダー等) には足さない。
 *
 * 明示型・一度だけ: 登録直後のこの位置に出す。モーダルで割り込まない。
 * 押さずに「次のキャラを登録する」へ抜けるのも同じ重さで選べるようにする
 * (順路を強制しない = STΛCK 方針 A案)。
 *
 * ラベルはスキル名 + 短い動詞だけにする。長い説明は置かない (H2)。
 */
function NextStepPanel({
  characterName,
  onRegisterNext,
}: {
  characterName: string;
  onRegisterNext: () => void;
}) {
  // catalog を正本にする (ここでスキル名を二重管理しない)。
  // id は絞り込んだ型のまま持ち回る (find の戻り値だけ使うと GoriSkillId へ
  // 広がってしまい、openSkillWithCharacter の型が受け付けない)。
  const nextSkills = useMemo(
    () =>
      CHARACTER_NEXT_STEP_SKILL_IDS.map((id) => ({
        id,
        skill: GORI_SKILLS.find((s) => s.id === id),
      })).filter(
        (entry): entry is { id: typeof entry.id; skill: (typeof GORI_SKILLS)[number] } =>
          Boolean(entry.skill),
      ),
    [],
  );

  return (
    <div className="border-t border-[#242424] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] font-bold text-neutral-300">
          「{characterName}」を登録しました。このキャラで次を作れます
        </div>
        <button
          type="button"
          onClick={onRegisterNext}
          className="rounded-lg border border-[#343434] px-3 py-1.5 text-[11px] font-bold text-neutral-400 transition hover:border-neutral-500 hover:text-white"
        >
          次のキャラを登録する
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {nextSkills.map(({ id, skill }) => (
          <button
            key={id}
            type="button"
            onClick={() => openSkillWithCharacter(id, characterName)}
            title={skill.launchHint}
            className="flex items-center justify-center rounded-md border border-pink-500/40 bg-pink-500/10 px-2 py-1.5 text-[11px] font-bold text-pink-200 transition hover:border-pink-400 hover:bg-pink-500/20 hover:text-white"
          >
            {skill.name}を作る
          </button>
        ))}
      </div>
    </div>
  );
}
