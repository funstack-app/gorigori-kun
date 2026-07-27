import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { SkillIntro } from "../SkillIntro";
import { CharacterIcon, FaceIcon } from "../../SkillIcon";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useImages } from "../../../lib/store/images";
import { buildExportFileName } from "../../../lib/exportNaming";
import { useProjects } from "../../../lib/store/projects";
import { useToasts } from "../../../lib/store/toasts";
import { useCharacterSheetRun } from "../../../lib/store/characterSheetRun";
import { ensureCharacterSheetEventListener } from "../../../lib/character/events";
import type {
  CharacterSheetParams,
  SheetCutState,
} from "../../../lib/character/types";
import { usePresets, presetKind, type Preset } from "../../../lib/store/presets";
import {
  DEFAULT_EXPRESSION_IDS,
  EXPRESSIONS,
  buildExpressionPromptFragment,
  getExpression,
  resolveExpressions,
} from "../../../lib/expressionSet/catalog";

/**
 * 表情差分 Workspace（スキル一覧v2.1 #2・MVP）
 *
 * 登録済みキャラ（kind === "character" のプリセット）を1体選び、表情セット（基本5種+追加候補）を
 * 一括生成する専用ワークスペース。CharacterRegisterWorkspace の2ペイン+ステップ制を踏襲する。
 *
 * 生成経路: 既存の `invoke("character_sheet_run", { params })`（src-tauri/src/commands/character_sheet.rs）を
 * そのまま再利用する。同コマンドは任意の cutSpecs（{cutId, role, promptFragment}）を受け取り、渡した
 * カットだけを並列生成するため、表情だけの cutSpecs を組めば表情差分がそのまま実現できる。
 * 参照画像はキャラの characterMeta.sourceImage（無ければ attachedImages 先頭）を characterImage に渡し、
 * 属性は characterMeta.attributes を全カット共通で焼き込む。
 *
 * 進捗・結果表示とイベント購読は useCharacterSheetRun / ensureCharacterSheetEventListener を共用する。
 * 検品（同一性採点）は未実装のため「未検品」バッジのみ表示する（NoopIdentityChecker と同じ思想）。
 *
 * SkillWorkspaceRouter が activeUiMode === "expressionSet" のとき本コンポーネントを描画する。
 */
export function ExpressionSetWorkspace() {
  const openPreview = useImagePreview((s) => s.open);
  const enterMode = useCharacterSheetRun((s) => s.enterMode);
  const pushToast = useToasts((s) => s.push);

  // 登録ワークスペースと run ストアを共有するため、入場時に「他スキルの mode を
  // 引き継いでいれば」初期化する。自分(expression)の実行中 run は保持する。
  useEffect(() => {
    let cancelled = false;
    enterMode("expression");
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
        <div className="px-4 pt-3">
          <SkillIntro
            what="登録済みのキャラを1体選ぶと、その顔のまま表情だけを変えたカットをまとめて作ります。"
            first="まずは下から、表情を作りたいキャラを選んでください。先にキャラクター登録を済ませておく必要があります。"
            note="似ているかどうかの最終判断は人の目で行います。自動での作り直しはしません。"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ExpressionSetBody onPreview={(path, all) => openPreview(path, all)} />
        </div>
      </div>
    </section>
  );
}

const STEP_LABELS: { step: 1 | 2; label: string }[] = [
  { step: 1, label: "1. キャラ・表情を選ぶ" },
  { step: 2, label: "2. 生成・結果" },
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

function ExpressionSetBody({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  const step = useCharacterSheetRun((s) => s.step);
  if (step === 1) return <StepSelect />;
  return <StepGenerate onPreview={onPreview} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// キャラ型プリセットのヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/** キャラの参照画像を解決する。sourceImage 優先、無ければ attachedImages の先頭。 */
function resolveCharacterSource(preset: Preset): string | undefined {
  const source = preset.characterMeta?.sourceImage;
  if (source) return source;
  return preset.attachedImages?.[0]?.path;
}

/** キャラのサムネ用画像を解決する（thumbnail data URL 優先、無ければ参照画像を convertFileSrc）。 */
function characterThumbSrc(preset: Preset): string | undefined {
  if (preset.thumbnail) return preset.thumbnail;
  const source = resolveCharacterSource(preset);
  return source ? convertFileSrc(source) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: キャラ選択 + 表情選択
// ─────────────────────────────────────────────────────────────────────────────

function StepSelect() {
  const presets = usePresets((s) => s.presets);
  const characters = useMemo(
    () => presets.filter((p) => presetKind(p) === "character"),
    [presets],
  );

  const beginRun = useCharacterSheetRun((s) => s.beginRun);
  const setAspectRatio = useCharacterSheetRun((s) => s.setAspectRatio);
  const setCharacterName = useCharacterSheetRun((s) => s.setCharacterName);
  const setCharacterImage = useCharacterSheetRun((s) => s.setCharacterImage);
  const setAttributes = useCharacterSheetRun((s) => s.setAttributes);
  const status = useCharacterSheetRun((s) => s.status);
  const pushToast = useToasts((s) => s.push);

  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedExprIds, setSelectedExprIds] = useState<string[]>(DEFAULT_EXPRESSION_IDS);

  const selectedCharacter = useMemo(
    () => characters.find((c) => c.id === selectedCharacterId) ?? null,
    [characters, selectedCharacterId],
  );

  const running = status === "running";
  const sourceImage = selectedCharacter
    ? resolveCharacterSource(selectedCharacter)
    : undefined;
  const canRun =
    Boolean(selectedCharacter) &&
    Boolean(sourceImage) &&
    selectedExprIds.length > 0 &&
    !running;

  function toggleExpression(id: string) {
    setSelectedExprIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function runGeneration() {
    if (!selectedCharacter) {
      pushToast({ kind: "info", text: "先にキャラを選んでください。", ttlMs: 3000 });
      return;
    }
    if (!sourceImage) {
      pushToast({
        kind: "error",
        text: "このキャラには参照画像がありません。別のキャラを選ぶか、登録し直してください。",
        ttlMs: 6000,
      });
      return;
    }
    const expressions = resolveExpressions(selectedExprIds);
    if (expressions.length === 0) {
      pushToast({ kind: "info", text: "表情を1つ以上選んでください。", ttlMs: 3000 });
      return;
    }

    const attributes = selectedCharacter.characterMeta?.attributes ?? "";
    const cutSpecs = expressions.map((expr) => ({
      cutId: expr.id,
      role: expr.role,
      promptFragment: buildExpressionPromptFragment(expr),
    }));

    // run ストアへキャラ情報を反映（Step2 の再生成・表示で使う）。
    setCharacterName(selectedCharacter.name);
    setCharacterImage(sourceImage);
    setAttributes(attributes);
    setAspectRatio("1:1");

    // フロントで先に run_id を採番し、beginRun 時点から確定 run_id を持つ。これで
    // 全イベントが同じ run_id を載せ、画面往復後の別 run 後着通知を照合で捨てられる
    // (B1 混線対策)。バックエンドは params.runId をそのまま使う。
    const runId = crypto.randomUUID();

    const params: CharacterSheetParams = {
      characterImage: sourceImage,
      attributes,
      aspectRatio: "1:1",
      cutSpecs,
      runId,
    };

    // 先に pending スケルトンを建てて listener を確実に間に合わせる（characterRegister と同じ思想）。
    beginRun(
      "expression",
      runId,
      cutSpecs.map((c) => ({
        cutId: c.cutId,
        label: getExpression(c.cutId)?.label ?? c.cutId,
        role: c.role,
      })),
    );

    try {
      await invoke<string>("character_sheet_run", { params });
      pushToast({
        kind: "success",
        text: `${cutSpecs.length} 表情の生成を開始しました。`,
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
            登録キャラを選ぶ
          </div>
          {characters.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#3a3a3a] bg-[#0d0d0d] px-3 py-4 text-center text-[12px] text-neutral-500">
              登録済みのキャラがありません。
              <br />
              「キャラクター登録」で先にキャラを作ってください。
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {characters.map((c) => {
                const thumb = characterThumbSrc(c);
                const selected = c.id === selectedCharacterId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedCharacterId(c.id)}
                    title={c.name}
                    className={
                      "flex flex-col overflow-hidden rounded-lg border text-left transition " +
                      (selected
                        ? "border-pink-400 ring-1 ring-pink-400/50"
                        : "border-[#2a2a2a] hover:border-neutral-500")
                    }
                  >
                    <div className="aspect-square w-full bg-[#0d0d0d]">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={c.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-neutral-600">
                          <CharacterIcon className="h-6 w-6" />
                        </div>
                      )}
                    </div>
                    <span className="truncate px-1 py-1 text-[10px] font-bold text-neutral-300">
                      {c.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedCharacter && !sourceImage && (
          <div className="rounded-lg border border-amber-500/40 bg-[#2a2418] px-3 py-2 text-[11px] font-bold text-amber-300">
            このキャラには参照画像がありません。生成できません。
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
              表情セット
            </span>
            <span className="text-[11px] font-bold text-pink-300">
              {selectedExprIds.length} 種
            </span>
          </div>
          <div className="space-y-1.5">
            {EXPRESSIONS.map((expr) => {
              const checked = selectedExprIds.includes(expr.id);
              return (
                <label
                  key={expr.id}
                  className={
                    "flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-bold transition " +
                    (checked
                      ? "border-pink-400/60 bg-[#1c1418] text-neutral-100"
                      : "border-[#2a2a2a] bg-[#0d0d0d] text-neutral-400 hover:border-neutral-500")
                  }
                >
                  <span>{expr.label}</span>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleExpression(expr.id)}
                    className="h-4 w-4 accent-pink-500"
                  />
                </label>
              );
            })}
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
          {running
            ? "生成中…"
            : `${selectedExprIds.length} 表情を生成する`}
        </button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-neutral-500">
        {selectedCharacter ? (
          <div className="max-w-md">
            {characterThumbSrc(selectedCharacter) && (
              <img
                src={characterThumbSrc(selectedCharacter)}
                alt={selectedCharacter.name}
                className="mx-auto max-h-[50vh] rounded-xl border border-[#2a2a2a] object-contain"
              />
            )}
            <p className="mt-4 text-[13px] font-bold text-neutral-300">
              {selectedCharacter.name}
            </p>
            <p className="mt-1 text-[12px]">
              同一人物・アングル固定で、選んだ表情だけをまとめて生成します。
            </p>
            {selectedCharacter.characterMeta?.attributes && (
              <p className="mt-2 truncate text-[11px] text-neutral-600">
                属性: {selectedCharacter.characterMeta.attributes}
              </p>
            )}
          </div>
        ) : (
          <>
            <FaceIcon className="h-9 w-9 text-neutral-500" />
            <p className="text-[13px] font-bold">登録キャラを1体選んでください</p>
            <p className="text-[12px]">
              選んだキャラの顔を固定したまま、表情差分をまとめて生成します
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: 生成中・結果（検品は未実装 = 未検品バッジのみ）
// ─────────────────────────────────────────────────────────────────────────────

function StepGenerate({
  onPreview,
}: {
  onPreview: (path: string, all: string[]) => void;
}) {
  const status = useCharacterSheetRun((s) => s.status);
  const cuts = useCharacterSheetRun((s) => s.cuts);
  const cutOrder = useCharacterSheetRun((s) => s.cutOrder);
  const runId = useCharacterSheetRun((s) => s.runId);
  const characterName = useCharacterSheetRun((s) => s.characterName);
  const characterImagePath = useCharacterSheetRun((s) => s.characterImagePath);
  const attributes = useCharacterSheetRun((s) => s.attributes);
  const aspectRatio = useCharacterSheetRun((s) => s.aspectRatio);
  const setStep = useCharacterSheetRun((s) => s.setStep);
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const downloadAs = useImages((s) => s.downloadAs);
  const pushToast = useToasts((s) => s.push);

  const orderedCuts = cutOrder
    .map((id) => cuts[id])
    .filter((c): c is SheetCutState => Boolean(c));
  const completedPaths = orderedCuts
    .filter((c) => c.status === "completed" && c.imagePath)
    .map((c) => c.imagePath as string);
  const doneCount = orderedCuts.filter((c) => c.status === "completed").length;
  const total = orderedCuts.length;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  function saveCutToProject(cut: SheetCutState) {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    if (cut.status !== "completed" || !cut.imagePath) return;
    addItem(activeProjectId, {
      imagePath: cut.imagePath,
      note: `表情セット: ${cut.label}`,
    });
    pushToast({
      kind: "success",
      text: `「${cut.label}」を ${activeProject?.name ?? "プロジェクト"} に保存しました。`,
      ttlMs: 2500,
    });
  }

  function saveAllToProject() {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    let saved = 0;
    for (const cut of orderedCuts) {
      if (cut.status !== "completed" || !cut.imagePath) continue;
      addItem(activeProjectId, {
        imagePath: cut.imagePath,
        note: `表情セット: ${cut.label}`,
      });
      saved += 1;
    }
    pushToast({
      kind: saved > 0 ? "success" : "info",
      text:
        saved > 0
          ? `表情セット ${saved} 枚を ${activeProject?.name ?? "プロジェクト"} に保存しました。`
          : "保存できる完成画像がまだありません。",
      ttlMs: 3000,
    });
  }

  async function saveCutToLocal(cut: SheetCutState) {
    if (cut.status !== "completed" || !cut.imagePath) return;
    const ext = cut.imagePath.split(".").pop()?.toLowerCase() || "png";
    // 2026-07-27: キャラ資産形式 (`yuki_smile.png`)。キャラ名が名前に入らないと
    // 複数キャラの差分が混ざって管理できない (外注へ渡すときに identify できない)。
    // 2026-07-27: index を渡す。他2スキル (productSet / multiAngle) は渡していて
    // ここだけ抜けており、役割名が空になったときに全部同名になっていた。
    const fileName = buildExportFileName({
      style: "asset",
      prefix: characterName || undefined,
      index: cutOrder.indexOf(cut.cutId) + 1,
      digits: 2,
      role: cut.label,
      ext,
    });
    try {
      const dest = await downloadAs(cut.imagePath, fileName);
      if (!dest) return;
      pushToast({
        kind: "success",
        text: `「${cut.label}」をローカルに保存しました。`,
        ttlMs: 2500,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  async function regenerateCut(cut: SheetCutState) {
    if (!runId || !characterImagePath) return;
    const expr = getExpression(cut.cutId);
    if (!expr) return;

    const params: CharacterSheetParams = {
      characterImage: characterImagePath,
      attributes,
      aspectRatio,
      cutSpecs: [
        {
          cutId: expr.id,
          role: expr.role,
          promptFragment: buildExpressionPromptFragment(expr),
        },
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[12px] font-bold text-neutral-300">
            {status === "running" && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
            )}
            {status === "running" ? "並列生成中…" : "生成完了"}{" "}
            <span className="text-neutral-500">
              ({doneCount}/{total})
            </span>
          </div>
          {characterName && (
            <span className="text-[12px] font-black text-white">{characterName}</span>
          )}
          <span className="rounded-full bg-[#2a2418] px-2 py-0.5 text-[11px] font-bold text-amber-300">
            未検品(同一性採点は未実装)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={saveAllToProject}
            disabled={doneCount === 0}
            className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-pink-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            全部プロジェクトに保存
          </button>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-neutral-500 hover:text-white"
          >
            ← キャラ選択に戻る
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
              <div className="relative aspect-square w-full bg-[#0d0d0d]">
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
                        "flex flex-col items-center gap-2 text-[11px] font-bold " +
                        (cut.status === "running" ? "text-pink-300" : "text-neutral-600")
                      }
                    >
                      {cut.status === "running" && (
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
                      )}
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
                <button
                  type="button"
                  onClick={() => saveCutToProject(cut)}
                  disabled={cut.status !== "completed" || !cut.imagePath}
                  className="rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                >
                  プロジェクトに保存
                </button>
                <button
                  type="button"
                  onClick={() => void saveCutToLocal(cut)}
                  disabled={cut.status !== "completed" || !cut.imagePath}
                  className="rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-emerald-400/60 hover:text-white disabled:opacity-40"
                >
                  ローカルに保存
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
