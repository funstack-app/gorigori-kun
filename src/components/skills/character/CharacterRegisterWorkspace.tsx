import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { CharacterIcon } from "../../SkillIcon";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useToasts } from "../../../lib/store/toasts";
import { useCharacterSheetRun } from "../../../lib/store/characterSheetRun";
import { ensureCharacterSheetEventListener } from "../../../lib/character/events";
import {
  DEFAULT_SHEET_CUT_IDS,
  EXTENDED_SHEET_CUT_IDS,
  getSheetCut,
  resolveSheetCuts,
} from "../../../lib/character/sheetCuts";
import type {
  CharacterSheetParams,
  SheetCutState,
} from "../../../lib/character/types";
import { defaultIdentityChecker } from "../../../lib/character/identityCheck";
import type { IdentityCheckResult } from "../../../lib/character/identityCheck";
import { registerCharacter } from "../../../lib/character/registerCharacter";
import {
  ASPECT_RATIO_HINTS,
  ASPECT_RATIO_PICKER_OPTIONS,
} from "../../../lib/scene/aspectRatioPicker";
import type { SceneAspectRatio } from "../../../lib/scene/types";
import { OptionPickerModal } from "../../scene/OptionPickerModal";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/**
 * キャラクター登録 Workspace(IPアセット化パイプライン・スライスS4)
 *
 * 1枚の参照画像から 3面図+表情+顔ディテールを並列生成し、キャラ型プリセットへ登録する
 * ウィザード(ステップ制の1ワークスペース)。MultiAngleWorkspace の2ペインパターンを踏襲。
 *
 * SkillWorkspaceRouter が activeUiMode === "characterRegister" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / MultiAngleWorkspace は触らない。
 */
export function CharacterRegisterWorkspace() {
  const openPreview = useImagePreview((s) => s.open);
  const enterMode = useCharacterSheetRun((s) => s.enterMode);

  // 表情差分と run ストアを共有するため、入場時に「他スキルの mode を引き継いで
  // いれば」初期化する。自分(character)の実行中 run は保持する。
  useEffect(() => {
    enterMode("character");
    void ensureCharacterSheetEventListener();
  }, [enterMode]);

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
  const characterImagePath = useCharacterSheetRun((s) => s.characterImagePath);
  const setCharacterImage = useCharacterSheetRun((s) => s.setCharacterImage);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const setAttributes = useCharacterSheetRun((s) => s.setAttributes);
  const aspectRatio = useCharacterSheetRun((s) => s.aspectRatio);
  const setAspectRatio = useCharacterSheetRun((s) => s.setAspectRatio);
  const extended = useCharacterSheetRun((s) => s.extended);
  const setExtended = useCharacterSheetRun((s) => s.setExtended);
  const beginRun = useCharacterSheetRun((s) => s.beginRun);
  const status = useCharacterSheetRun((s) => s.status);

  const pushToast = useToasts((s) => s.push);
  const [aspectPickerOpen, setAspectPickerOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const cutIds = extended ? EXTENDED_SHEET_CUT_IDS : DEFAULT_SHEET_CUT_IDS;
  const running = status === "running";
  const canRun = Boolean(characterImagePath) && !running;

  async function pickCharacterImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r || typeof r !== "string") return;
      setCharacterImage(r);
      pushToast({ kind: "success", text: "参照画像を設定しました。", ttlMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function autoExtractAttributes() {
    if (!characterImagePath) {
      pushToast({ kind: "info", text: "先に参照画像を選んでください。", ttlMs: 3000 });
      return;
    }
    setExtracting(true);
    try {
      const desc = await invoke<string>("codex_describe_image", {
        imagePath: characterImagePath,
      });
      setAttributes(desc);
      pushToast({ kind: "success", text: "属性の下書きを生成しました(編集できます)。", ttlMs: 3000 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `属性の自動抽出に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      setExtracting(false);
    }
  }

  async function runGeneration() {
    if (!characterImagePath) {
      pushToast({ kind: "info", text: "先に参照画像を選んでください。", ttlMs: 3000 });
      return;
    }
    const cutSpecs = resolveSheetCuts(cutIds).map((c) => ({
      cutId: c.cutId,
      role: c.role,
      promptFragment: c.promptFragment,
    }));

    // フロントで先に run_id を採番し、beginRun 時点から確定 run_id を持つ。これで
    // 全イベントが同じ run_id を載せ、画面往復後の別 run 後着通知を照合で捨てられる
    // (B1 混線対策)。バックエンドは params.runId をそのまま使う。
    const runId = crypto.randomUUID();

    const params: CharacterSheetParams = {
      characterImage: characterImagePath,
      attributes,
      aspectRatio,
      cutSpecs,
      runId,
    };

    // 先に pending スケルトンを建てて listener を確実に間に合わせる(multiAngle と同じ思想)。
    beginRun(
      "character",
      runId,
      cutSpecs.map((c) => ({
        cutId: c.cutId,
        label: getSheetCut(c.cutId)?.label ?? c.cutId,
        role: c.role,
      })),
    );

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "success",
        text: `${cutSpecs.length} カットの生成を開始しました。`,
        ttlMs: 3000,
      });
    } catch (err) {
      useCharacterSheetRun.getState().reset();
      pushToast({
        kind: "error",
        text: `生成の開始に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#242424] bg-[#141414] px-4 py-4">
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
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            参照画像(1枚)
          </div>
          {characterImagePath ? (
            <div className="space-y-2">
              <div className="overflow-hidden rounded-xl border border-[#2a2a2a]">
                <img
                  src={convertFileSrc(characterImagePath)}
                  alt="参照画像"
                  className="aspect-square w-full object-cover"
                />
              </div>
              <button
                type="button"
                onClick={pickCharacterImage}
                className="w-full rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                画像を変更
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={pickCharacterImage}
              className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500 hover:border-pink-400/60 hover:text-neutral-300"
            >
              <span className="text-2xl">＋</span>
              <span className="text-[12px] font-bold">参照画像を選ぶ</span>
            </button>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
              属性(不変の見た目)
            </span>
            <button
              type="button"
              onClick={() => void autoExtractAttributes()}
              disabled={extracting || !characterImagePath}
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
            全カット共通で焼き込みます。空欄なら参照画像の見た目を踏襲します。
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            アスペクト比
          </div>
          <button
            type="button"
            onClick={() => setAspectPickerOpen(true)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-left text-[13px] font-semibold text-neutral-100 transition hover:border-pink-400 hover:bg-[#151515]"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-bold text-neutral-100">{aspectRatio}</span>
              <span className="truncate text-[11px] font-medium text-neutral-500">
                {ASPECT_RATIO_HINTS[aspectRatio as SceneAspectRatio] ?? ""}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-neutral-500" aria-hidden>
              ▾
            </span>
          </button>
        </div>

        <div className="border-t border-[#242424] pt-4">
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-[12px] font-bold text-neutral-300">
              詳しく(顔補強・目・手・服のディテールも生成)
            </span>
            <input
              type="checkbox"
              checked={extended}
              onChange={(e) => setExtended(e.target.checked)}
              className="h-4 w-4 accent-pink-500"
            />
          </label>
          <div className="mt-2 text-center text-[12px] font-bold text-neutral-400">
            生成:{" "}
            <span className="text-pink-300">{cutIds.length} カット</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void runGeneration()}
          disabled={!canRun}
          className={`mt-auto w-full rounded-xl px-4 py-3 text-[14px] font-black transition ${
            canRun
              ? "bg-pink-500 text-white hover:bg-pink-400"
              : "cursor-not-allowed bg-[#242424] text-neutral-600"
          }`}
        >
          {running ? "生成中…" : `${cutIds.length} カットを生成する`}
        </button>

        <OptionPickerModal
          open={aspectPickerOpen}
          title="アスペクト比を選ぶ"
          options={ASPECT_RATIO_PICKER_OPTIONS}
          selectedValue={aspectRatio}
          onPick={(value) => setAspectRatio(value)}
          onClose={() => setAspectPickerOpen(false)}
        />
      </aside>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-neutral-500">
        {characterImagePath ? (
          <div className="max-w-md">
            <img
              src={convertFileSrc(characterImagePath)}
              alt="参照プレビュー"
              className="mx-auto max-h-[60vh] rounded-xl border border-[#2a2a2a] object-contain"
            />
            <p className="mt-4 text-[12px]">
              この1枚から 3面図・表情・顔ディテールをまとめて生成し、キャラとして登録します。
            </p>
          </div>
        ) : (
          <>
            <CharacterIcon className="h-9 w-9 text-neutral-500" />
            <p className="text-[13px] font-bold">参照画像を1枚選んでください</p>
            <p className="text-[12px]">3面図・表情・顔ディテールをまとめて生成します</p>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: 生成中・結果
// ─────────────────────────────────────────────────────────────────────────────

function aspectRatioCss(ratio: string): string {
  const [w, h] = ratio.split(":").map((s) => parseInt(s, 10));
  if (!w || !h) return "1 / 1";
  return `${w} / ${h}`;
}

function StepGenerate({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  const status = useCharacterSheetRun((s) => s.status);
  const cuts = useCharacterSheetRun((s) => s.cuts);
  const cutOrder = useCharacterSheetRun((s) => s.cutOrder);
  const runId = useCharacterSheetRun((s) => s.runId);
  const characterImagePath = useCharacterSheetRun((s) => s.characterImagePath);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const aspectRatio = useCharacterSheetRun((s) => s.aspectRatio);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const pushToast = useToasts((s) => s.push);

  const tileAspectCss = aspectRatioCss(aspectRatio);

  const orderedCuts = cutOrder
    .map((id) => cuts[id])
    .filter((c): c is SheetCutState => Boolean(c));
  const completedPaths = orderedCuts
    .filter((c) => c.status === "completed" && c.imagePath)
    .map((c) => c.imagePath as string);
  const doneCount = orderedCuts.filter((c) => c.status === "completed").length;
  const total = orderedCuts.length;

  async function regenerateCut(cut: SheetCutState) {
    if (!runId || !characterImagePath) return;
    const spec = getSheetCut(cut.cutId);
    if (!spec) return;

    const params: CharacterSheetParams = {
      characterImage: characterImagePath,
      attributes,
      aspectRatio,
      cutSpecs: [
        { cutId: spec.cutId, role: spec.role, promptFragment: spec.promptFragment },
      ],
    };

    try {
      await invoke<string>("character_sheet_regenerate_cut", {
        runId,
        cutId: cut.cutId,
        params,
      });
      pushToast({ kind: "info", text: `「${cut.label}」を再生成中…`, ttlMs: 2500 });
    } catch (err) {
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
        <div className="text-[12px] font-bold text-neutral-300">
          {status === "running" ? "並列生成中…" : "生成完了"}{" "}
          <span className="text-neutral-500">
            ({doneCount}/{total})
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
          <button
            type="button"
            onClick={() => setStep(3)}
            disabled={doneCount === 0}
            className={
              "rounded-lg px-3 py-1.5 text-[12px] font-black transition " +
              (doneCount === 0
                ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                : "bg-pink-500 text-white hover:bg-pink-400")
            }
          >
            確認して登録へ →
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {orderedCuts.map((cut) => (
            <div
              key={cut.cutId}
              className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]"
            >
              <div
                className="relative w-full bg-[#0d0d0d]"
                style={{ aspectRatio: tileAspectCss }}
              >
                {cut.status === "completed" && cut.imagePath ? (
                  <img
                    src={convertFileSrc(cut.imagePath)}
                    alt={cut.label}
                    className="h-full w-full cursor-pointer object-contain"
                    onClick={() =>
                      onPreview(cut.imagePath as string, completedPaths)
                    }
                  />
                ) : cut.status === "failed" ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-[11px] text-red-300">
                    <span>生成失敗</span>
                    {cut.reason && (
                      <span className="line-clamp-2 text-[9px] text-neutral-500">
                        {cut.reason}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <span
                      className={
                        "text-[11px] font-bold " +
                        (cut.status === "running"
                          ? "animate-pulse text-pink-300"
                          : "text-neutral-600")
                      }
                    >
                      {cut.status === "running" ? "生成中…" : "待機中"}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 px-2 py-2">
                <div className="truncate text-[11px] font-bold text-neutral-200">
                  {cut.label}
                </div>
                <button
                  type="button"
                  onClick={() => void regenerateCut(cut)}
                  disabled={status === "running" && cut.status === "running"}
                  className="rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                >
                  再生成
                </button>
              </div>
            </div>
          ))}
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
  const characterName = useCharacterSheetRun((s) => s.characterName);
  const characterImagePath = useCharacterSheetRun((s) => s.characterImagePath);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const cuts = useCharacterSheetRun((s) => s.cuts);
  const cutOrder = useCharacterSheetRun((s) => s.cutOrder);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const reset = useCharacterSheetRun((s) => s.reset);
  const pushToast = useToasts((s) => s.push);

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
  const completedPaths = completed.map((c) => c.imagePath as string);

  const [identity, setIdentity] = useState<IdentityCheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);

  // Phase 3: 生成完了後・登録前に検品フックを await(Noop は unavailable を返す)。
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    void defaultIdentityChecker
      .check(
        characterImagePath ?? "",
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
  }, [characterImagePath, completed.length]);

  const canRegister = completed.length > 0 && characterName.trim().length > 0 && !saving;

  async function handleRegister() {
    if (!canRegister || !characterImagePath) return;
    setSaving(true);
    try {
      const preset = await registerCharacter({
        name: characterName,
        attributes,
        sourceImage: characterImagePath,
        cuts: completed,
        identity: identity ?? undefined,
      });
      if (!preset) {
        pushToast({
          kind: "error",
          text: "登録できる完成カットがありません。",
          ttlMs: 4000,
        });
        setSaving(false);
        return;
      }
      pushToast({
        kind: "success",
        text: `キャラ「${characterName.trim()}」を登録しました。`,
        ttlMs: 3500,
      });
      reset();
    } catch (err) {
      pushToast({
        kind: "error",
        text: `登録に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
      setSaving(false);
    }
  }

  const identityLabel = checking
    ? "検品中…"
    : identity?.score != null
      ? `同一性スコア: ${identity.score}`
      : "未検品(同一性採点は未実装)";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
        <div className="text-[12px] font-bold text-neutral-300">
          登録内容の確認{" "}
          <span className="text-neutral-500">({completed.length} カット)</span>
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
          <span
            className={
              "rounded-full px-2 py-0.5 text-[11px] font-bold " +
              (identity?.score != null
                ? "bg-[#1c2a20] text-emerald-300"
                : "bg-[#2a2418] text-amber-300")
            }
          >
            {identityLabel}
          </span>
          {attributes.trim() && (
            <span className="truncate text-[11px] text-neutral-500">
              属性: {attributes.trim()}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {completed.map((cut) => (
            <div
              key={cut.cutId}
              className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]"
            >
              <img
                src={convertFileSrc(cut.imagePath as string)}
                alt={cut.label}
                className="aspect-square w-full cursor-pointer object-cover"
                onClick={() => onPreview(cut.imagePath as string, completedPaths)}
              />
              <div className="px-2 py-1.5">
                <div className="truncate text-[11px] font-bold text-neutral-200">
                  {cut.label}
                </div>
                <div className="truncate text-[10px] text-neutral-500">{cut.role}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

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
          {saving ? "登録中…" : "このキャラを登録"}
        </button>
      </div>
    </div>
  );
}
