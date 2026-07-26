import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { CharacterIcon } from "../../SkillIcon";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useToasts } from "../../../lib/store/toasts";
import { useCharacterSheetRun } from "../../../lib/store/characterSheetRun";
import { ensureCharacterSheetEventListener } from "../../../lib/character/events";
import type {
  CharacterSheetParams,
  SheetCutState,
} from "../../../lib/character/types";
import { defaultIdentityChecker } from "../../../lib/character/identityCheck";
import type { IdentityCheckResult } from "../../../lib/character/identityCheck";
import { registerCharacter } from "../../../lib/character/registerCharacter";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const COMPOSITE_ASPECT_RATIO = "3:4";
const COMPOSITE_SHEET_CUT = {
  cutId: "character-sheet",
  label: "キャラクターシート",
  role: "character-sheet",
} as const;

function buildCompositeSheetParams(
  characterImage: string,
  attributes: string,
  runId: string,
): CharacterSheetParams {
  return {
    characterImage,
    attributes,
    aspectRatio: COMPOSITE_ASPECT_RATIO,
    generationMode: "composite",
    runId,
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
  useEffect(() => {
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
    return () => {
      cancelled = true;
    };
  }, [enterMode, pushToast]);

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
  const beginRun = useCharacterSheetRun((s) => s.beginRun);
  const status = useCharacterSheetRun((s) => s.status);

  const pushToast = useToasts((s) => s.push);
  const [extracting, setExtracting] = useState(false);

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

    // フロントで先に run_id を採番し、beginRun 時点から確定 run_id を持つ。これで
    // 全イベントが同じ run_id を載せ、画面往復後の別 run 後着通知を照合で捨てられる
    // (B1 混線対策)。バックエンドは params.runId をそのまま使う。
    const runId = crypto.randomUUID();

    const params = buildCompositeSheetParams(characterImagePath, attributes, runId);

    // 先に1枚分の pending 状態を作り、開始直後の通知も取りこぼさない。
    beginRun("character", runId, [COMPOSITE_SHEET_CUT]);

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "success",
        text: "キャラクターシートの生成を開始しました。",
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
            シート全体に反映します。空欄なら参照画像の見た目を踏襲します。
          </p>
        </div>

        <div className="border-t border-[#242424] pt-4">
          <div className="mt-2 text-center text-[12px] font-bold text-neutral-400">
            生成: <span className="text-pink-300">統合シート 1枚</span>
          </div>
          <div className="mt-1 text-center text-[10px] text-neutral-600">
            縦長 3:4・全身三面図とシーンショットを1枚にまとめます
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
          {running && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
          )}
          {running ? "生成中…" : "キャラクターシートを生成する"}
        </button>
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
              この1枚から、全身三面図とシーンショットをまとめた
              キャラクターシートを生成します。
            </p>
          </div>
        ) : (
          <>
            <CharacterIcon className="h-9 w-9 text-neutral-500" />
            <p className="text-[13px] font-bold">参照画像を1枚選んでください</p>
            <p className="text-[12px]">統合キャラクターシートを1枚生成します</p>
          </>
        )}
      </div>
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
  const status = useCharacterSheetRun((s) => s.status);
  const cuts = useCharacterSheetRun((s) => s.cuts);
  const cutOrder = useCharacterSheetRun((s) => s.cutOrder);
  const characterImagePath = useCharacterSheetRun((s) => s.characterImagePath);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const beginRun = useCharacterSheetRun((s) => s.beginRun);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const pushToast = useToasts((s) => s.push);

  const sheet = cutOrder
    .map((id) => cuts[id])
    .find((cut): cut is SheetCutState => Boolean(cut));
  const completedPaths =
    sheet?.status === "completed" && sheet.imagePath ? [sheet.imagePath] : [];
  const canProceedToRegister =
    sheet?.status === "completed" && Boolean(sheet.imagePath);

  async function regenerateSheet() {
    if (!characterImagePath || status === "running") return;
    const nextRunId = crypto.randomUUID();
    const params = buildCompositeSheetParams(
      characterImagePath,
      attributes,
      nextRunId,
    );
    beginRun("character", nextRunId, [COMPOSITE_SHEET_CUT]);

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "info",
        text: "キャラクターシートを再生成しています。",
        ttlMs: 2500,
      });
    } catch (err) {
      useCharacterSheetRun.getState().reset();
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
          {sheet?.status === "failed"
            ? "生成失敗"
            : sheet?.status === "completed"
              ? "生成完了"
              : sheet?.status === "running"
                ? "生成中…"
                : "待機中"}
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
              <img
                src={convertFileSrc(sheet.imagePath)}
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
              <div className="flex h-full w-full items-center justify-center">
                <span
                  className={
                    "text-[12px] font-bold " +
                    (sheet?.status === "running"
                      ? "animate-pulse text-pink-300"
                      : "text-neutral-600")
                  }
                >
                  {sheet?.status === "running" ? "生成中…" : "待機中"}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-3">
            <div className="text-[12px] font-bold text-neutral-200">
              キャラクターシート（3:4）
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
  const sheet = completed[0];
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

  const canRegister =
    Boolean(sheet?.imagePath) && characterName.trim().length > 0 && !saving;

  async function handleRegister() {
    if (!canRegister || !characterImagePath) return;
    setSaving(true);
    try {
      const preset = await registerCharacter({
        name: characterName,
        attributes,
        sourceImage: characterImagePath,
        cuts: sheet ? [sheet] : [],
        identity: identity ?? undefined,
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
        text: `キャラ「${characterName.trim()}」を登録しました。プリセットの「キャラクター」から使えます。`,
        ttlMs: 4500,
      });
      reset();
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
        <div className="text-[12px] font-bold text-neutral-300">
          登録内容の確認 <span className="text-neutral-500">(シート 1枚)</span>
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
            <img
              src={convertFileSrc(sheet.imagePath)}
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
