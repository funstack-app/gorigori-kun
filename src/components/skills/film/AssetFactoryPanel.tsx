import { useEffect, useMemo, useRef, useState } from "react";

import {
  adoptAssetCandidate,
  areAllAssetPromptsDrafted,
  beginAssetGeneration,
  beginStressTest,
  canStartStressTest,
  chooseExtraStressRound,
  completeAssetGeneration,
  completeStressTestGeneration,
  evaluateStressTest,
  failAssetGeneration,
  failStressTestGeneration,
  findLocationPairReferencePath,
  getAssetFactoryGateState,
  needsPromptRevisionBeforeRegeneration,
  rejectAssetCandidates,
  saveAssetPromptDraft,
  setStressTestVerdict,
  sortAssetsForFactory,
  updateStressConditions,
} from "../../../lib/film/assetFactory";
import {
  buildAssetPromptDraftPrompt,
  buildStressTestImagePrompt,
  cleanAssetPromptDraftResponse,
} from "../../../lib/film/assetPrompts";
import {
  FilmTextTurnAbortedError,
  FilmTextTurnTimeoutError,
  runFilmTextTurn,
  type FilmTextTurnProgress,
} from "../../../lib/film/codexText";
import type {
  AssetImportance,
  AssetLedgerEntry,
  AssetType,
  FilmAsset,
  FilmProject,
} from "../../../lib/film/types";
import { images } from "../../../lib/ipc";
import { beginDirectRun } from "../../../lib/store/generationStatus";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";
import { SafeImage } from "../../SafeImage";

const TYPE_LABELS: Record<AssetType, string> = {
  character: "キャラ",
  location: "ロケ",
  text: "文字物",
  prop: "小道具",
};

const IMPORTANCE_LABELS: Record<AssetImportance, string> = {
  primary: "主要",
  supporting: "準",
  background: "背景",
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] || path;
}

function statusLabel(asset: FilmAsset): string {
  if (asset.locked) return "ロック";
  if (asset.status === "reviewed") return "検品済";
  if (asset.status === "generating" && asset.generatedImagePaths.length > 0) return "検品待ち";
  if (asset.status === "generating") return "生成中";
  if (asset.status === "interrupted") return "中断されました";
  if (asset.status === "planned") return "起草済";
  return "未起草";
}

function PromptEditor({
  asset,
  drafting,
  generationLocked,
  onDraft,
  onSave,
  onGenerate,
}: {
  asset: FilmAsset;
  drafting: boolean;
  generationLocked: boolean;
  onDraft: () => void;
  onSave: (prompt: string) => void;
  onGenerate: () => void;
}) {
  const [draft, setDraft] = useState(asset.promptDraft);

  useEffect(() => {
    setDraft(asset.promptDraft);
  }, [asset.id, asset.promptDraft]);

  const dirty = draft.trim() !== asset.promptDraft.trim();
  const mustRevise = needsPromptRevisionBeforeRegeneration(asset);
  const generating = asset.status === "generating" && asset.generatedImagePaths.length === 0;
  const interrupted = asset.status === "interrupted";

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-zinc-300">生成プロンプト全文</p>
        {!asset.locked ? (
          <button
            type="button"
            onClick={onDraft}
            disabled={drafting || generating}
            className="rounded-md border border-[#3a3a3a] px-3 py-1.5 text-[11px] font-semibold text-zinc-200 transition hover:bg-[#242424] disabled:opacity-40"
          >
            {drafting ? "AIが起草中…" : asset.promptDraft ? "AIで起草し直す" : "AIで起草"}
          </button>
        ) : null}
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={asset.locked || drafting || generating}
        rows={asset.type === "character" ? 14 : 9}
        placeholder="AIで起草すると、ここに画像生成へ渡す全文が入ります。"
        className="mt-2 w-full resize-y rounded-lg border border-[#303030] bg-[#101010] px-3 py-3 font-mono text-xs leading-5 text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-pink-500 disabled:cursor-not-allowed disabled:text-zinc-500"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {!asset.locked ? (
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={!draft.trim() || !dirty || drafting || generating}
            className="rounded-md border border-[#3a3a3a] px-3 py-1.5 text-[11px] font-semibold text-zinc-200 transition hover:bg-[#242424] disabled:opacity-40"
          >
            文面を保存
          </button>
        ) : null}
        <span className={dirty ? "text-[11px] text-amber-300" : "text-[11px] text-zinc-600"}>
          {asset.locked ? "ロック後は編集できません" : dirty ? "未保存の変更あり" : asset.promptDraft ? "保存済み" : "未起草"}
        </span>
      </div>
      {mustRevise ? (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
          直さずに回し直しません。NG理由を文面へ反映して保存すると、再生成できます。
        </p>
      ) : null}
      {interrupted ? (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
          前回の生成はアプリ終了などで中断されました。保存済みの文面から再試行できます。
        </p>
      ) : null}
      {!asset.locked && asset.promptDraft ? (
        <button
          type="button"
          onClick={onGenerate}
          disabled={generationLocked || generating || mustRevise || dirty || asset.status === "reviewed"}
          className="mt-3 rounded-md bg-pink-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {generating ? "3枚を生成中…" : interrupted ? "再試行" : "このアセットを3枚生成"}
        </button>
      ) : null}
    </div>
  );
}

function CandidateReview({
  asset,
  onAdopt,
  onReject,
}: {
  asset: FilmAsset;
  onAdopt: (path: string) => void;
  onReject: (note: string) => void;
}) {
  const [ngNote, setNgNote] = useState("");
  if (asset.status !== "generating" || asset.generatedImagePaths.length === 0) return null;

  return (
    <section className="mt-5 rounded-lg border border-pink-500/30 bg-pink-500/5 p-4">
      <h4 className="text-sm font-semibold text-zinc-100">3枚を人の目で検品</h4>
      {asset.type === "text" ? (
        <p className="mt-1 text-xs leading-5 text-amber-200">
          文字物は3〜4枚から、文字が一字一句すべて正しいものだけを選びます。今回は既定の3枚です。
        </p>
      ) : null}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {asset.generatedImagePaths.map((path, index) => (
          <article key={path} className="overflow-hidden rounded-lg border border-[#303030] bg-[#111111]">
            <SafeImage path={path} alt={`${asset.name} 候補${index + 1}`} className="aspect-video w-full bg-black object-contain" />
            <div className="p-3">
              <p className="truncate text-[11px] text-zinc-500">{basename(path)}</p>
              <button
                type="button"
                onClick={() => onAdopt(path)}
                className="mt-2 w-full rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-400"
              >
                この1枚を採用
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="mt-4 border-t border-[#303030] pt-4">
        <p className="text-xs font-semibold text-zinc-300">全部NG</p>
        <p className="mt-1 text-[11px] leading-5 text-zinc-500">
          理由を一言残し、プロンプトを直してから再生成します。直さずに回し直しません。
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={ngNote}
            onChange={(event) => setNgNote(event.target.value)}
            placeholder="例：横顔で別人になった"
            className="h-9 min-w-0 flex-1 rounded-md border border-[#303030] bg-[#101010] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-amber-500"
          />
          <button
            type="button"
            onClick={() => {
              onReject(ngNote);
              setNgNote("");
            }}
            disabled={!ngNote.trim()}
            className="rounded-md border border-amber-500/50 px-3 text-xs font-semibold text-amber-200 disabled:opacity-40"
          >
            理由を記録
          </button>
        </div>
      </div>
    </section>
  );
}

function StressTestSection({
  asset,
  running,
  onUpdateConditions,
  onRun,
  onVerdict,
  onEvaluate,
  onChooseExtra,
}: {
  asset: FilmAsset;
  running: boolean;
  onUpdateConditions: (conditions: [string, string]) => void;
  onRun: (round: "primary" | "extra") => void;
  onVerdict: (round: "primary" | "extra", index: number, verdict: "pass" | "fail") => void;
  onEvaluate: (round: "primary" | "extra") => void;
  onChooseExtra: (decision: "run" | "skip") => void;
}) {
  const stress = asset.stressTest;
  if (asset.type !== "character" || !asset.canonicalImagePath || !stress || asset.locked) return null;

  const extraActive = stress.extraRoundDecision === "run" && stress.extraRound !== null;
  const roundName: "primary" | "extra" = extraActive ? "extra" : "primary";
  const round = roundName === "extra" ? stress.extraRound : stress.primaryRound;
  if (!round) return null;
  const canJudge = round.status === "review" && round.verdicts.every((verdict) => verdict !== null);

  return (
    <section className="mt-5 rounded-lg border border-[#353535] bg-[#131313] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-zinc-100">人物ストレステスト</h4>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            採用シートを参照に、壊れやすい5条件で同じ人物を保てるか確認します。
          </p>
        </div>
        <span className="rounded-full border border-[#3a3a3a] px-2.5 py-1 text-[11px] text-zinc-400">
          {roundName === "extra" ? "追加5枚" : "必須5枚"}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-5">
        {stress.conditions.map((condition, index) => (
          <label key={`${asset.id}-${index}`} className="grid gap-1">
            <span className="text-[10px] text-zinc-600">条件 {index + 1}</span>
            <input
              value={condition}
              disabled={index < 3 || stress.primaryRound.status !== "idle" || running}
              onChange={(event) => {
                const custom: [string, string] = [stress.conditions[3], stress.conditions[4]];
                custom[index - 3] = event.target.value;
                onUpdateConditions(custom);
              }}
              className="h-9 min-w-0 rounded border border-[#303030] bg-[#101010] px-2 text-[11px] text-zinc-200 outline-none disabled:text-zinc-500"
            />
          </label>
        ))}
      </div>

      {round.status === "idle" || round.status === "interrupted" ? (
        <div className="mt-4">
          {round.status === "interrupted" ? (
            <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
              前回の5枚テストは中断されました。同じ条件から再試行できます。
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => onRun(roundName)}
            disabled={running || !canStartStressTest(asset, roundName)}
            className="rounded-md bg-pink-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {round.status === "interrupted"
              ? "再試行"
              : roundName === "extra"
                ? "追加5枚を生成"
                : "5枚を生成してテスト"}
          </button>
        </div>
      ) : null}

      {round.status === "generating" || running ? (
        <div className="mt-4 flex items-center gap-3 rounded-md border border-pink-500/30 bg-pink-500/5 px-3 py-3 text-xs text-pink-200">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
          5条件を1枚ずつ生成しています
        </div>
      ) : null}

      {round.status === "review" || round.status === "passed" || round.status === "failed" ? (
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          {round.imagePaths.map((path, index) => {
            const verdict = round.verdicts[index];
            return (
              <article key={path} className="overflow-hidden rounded-lg border border-[#303030] bg-[#101010]">
                <SafeImage path={path} alt={`${stress.conditions[index]}のテスト`} className="aspect-video w-full bg-black object-contain" />
                <div className="p-2">
                  <p className="truncate text-[11px] font-semibold text-zinc-300">{stress.conditions[index]}</p>
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      disabled={round.status !== "review"}
                      onClick={() => onVerdict(roundName, index, "pass")}
                      className={`rounded px-2 py-1.5 text-[11px] font-semibold ${verdict === "pass" ? "bg-emerald-500 text-white" : "border border-[#3a3a3a] text-zinc-400"}`}
                    >
                      合格
                    </button>
                    <button
                      type="button"
                      disabled={round.status !== "review"}
                      onClick={() => onVerdict(roundName, index, "fail")}
                      className={`rounded px-2 py-1.5 text-[11px] font-semibold ${verdict === "fail" ? "bg-amber-500 text-black" : "border border-[#3a3a3a] text-zinc-400"}`}
                    >
                      NG
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {round.status === "review" ? (
        <button
          type="button"
          onClick={() => onEvaluate(roundName)}
          disabled={!canJudge}
          className="mt-4 rounded-md bg-emerald-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          5/5の結果を確定
        </button>
      ) : null}

      {round.status === "failed" ? (
        <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs leading-5 text-amber-200">
          1枚でもNGなら、直すのはモデルでなくディスクリプタの言葉です。上の文面を直したら、5枚を最初からやり直します。
        </div>
      ) : null}

      {roundName === "primary"
        && round.status === "passed"
        && asset.importance === "primary"
        && !stress.extraRoundOffered ? (
        <div className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <p className="text-xs font-semibold text-emerald-200">
            重要キャラはあと5枚（計10枚）で確度が上がります。やりますか？
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => onChooseExtra("run")} className="rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-white">やる</button>
            <button type="button" onClick={() => onChooseExtra("skip")} className="rounded-md border border-[#3a3a3a] px-3 py-2 text-xs font-semibold text-zinc-300">やらないでロック</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function AssetFactoryPanel({ project }: { project: FilmProject }) {
  const updateAsset = useFilmProjectStore((state) => state.updateAssetFactoryAsset);
  const pushToast = useToasts((state) => state.push);
  const assets = useMemo(() => sortAssetsForFactory(project.assets), [project.assets]);
  const allDrafted = areAllAssetPromptsDrafted(project.assets);
  const gate = useMemo(() => getAssetFactoryGateState(project.assets), [project.assets]);
  const [draftingAssetId, setDraftingAssetId] = useState<string | null>(null);
  const [draftingAll, setDraftingAll] = useState(false);
  const [draftProgress, setDraftProgress] = useState<FilmTextTurnProgress>();
  const [stressRunningAssetId, setStressRunningAssetId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function persist(assetId: string, next: (asset: AssetLedgerEntry) => AssetLedgerEntry) {
    updateAsset(assetId, next);
  }

  async function draftOne(asset: FilmAsset, controller?: AbortController): Promise<boolean> {
    if (asset.locked) return false;
    const ownController = controller ?? new AbortController();
    if (!controller) abortRef.current = ownController;
    setDraftingAssetId(asset.id);
    setDraftProgress({ phase: "waiting", receivedChars: 0 });
    try {
      const raw = await runFilmTextTurn(buildAssetPromptDraftPrompt(project, asset), {
        label: "アセットプロンプト",
        signal: ownController.signal,
        onProgress: setDraftProgress,
      });
      const prompt = cleanAssetPromptDraftResponse(raw);
      if (!prompt) throw new Error("AIから空の文面が返りました");
      persist(asset.id, (current) => saveAssetPromptDraft(current, prompt));
      return true;
    } catch (error) {
      if (!(error instanceof FilmTextTurnAbortedError)) {
        pushToast({
          kind: error instanceof FilmTextTurnTimeoutError ? "warn" : "error",
          text: `${asset.name}の起草に失敗しました: ${(error as Error)?.message ?? error}`,
          ttlMs: 7000,
        });
      }
      return false;
    } finally {
      setDraftingAssetId(null);
      setDraftProgress(undefined);
      if (!controller) abortRef.current = null;
    }
  }

  async function draftAllMissing() {
    const targets = assets.filter((asset) => !asset.promptDraft.trim() && !asset.locked);
    if (targets.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDraftingAll(true);
    let completed = 0;
    for (const asset of targets) {
      if (controller.signal.aborted) break;
      if (await draftOne(asset, controller)) completed += 1;
      else if (!controller.signal.aborted) break;
    }
    setDraftingAll(false);
    abortRef.current = null;
    if (completed > 0) {
      pushToast({ kind: "success", text: `${completed}件のプロンプトを起草して保存しました。`, ttlMs: 4000 });
    }
  }

  async function generateAsset(asset: FilmAsset) {
    if (!allDrafted) return;
    let started: FilmAsset;
    try {
      started = beginAssetGeneration(asset);
    } catch (error) {
      pushToast({ kind: "warn", text: String((error as Error)?.message ?? error), ttlMs: 5000 });
      return;
    }
    persist(asset.id, () => started);
    const pairReference = findLocationPairReferencePath(asset, project.assets);
    const tracker = beginDirectRun("characterSheet", 1, `film-asset-${project.id}-${asset.id}-${Date.now()}`);
    try {
      const result = await tracker.step(() => images.generateBatch({
        prompt: started.promptDraft,
        count: 3,
        refImagePaths: pairReference ? [pairReference] : undefined,
        aspect: "16:9",
        enforceAspect: true,
        maxAttempts: 1,
        sourceTag: tracker.id,
      }));
      if (result.generatedPaths.length !== 3) {
        throw new Error(`3枚のうち${result.generatedPaths.length}枚だけ完成しました。3枚そろえてから検品します。`);
      }
      persist(asset.id, (current) => completeAssetGeneration(current, result.generatedPaths));
      pushToast({ kind: "success", text: `${asset.name}の候補3枚ができました。採用1枚を選んでください。`, ttlMs: 5000 });
    } catch (error) {
      persist(asset.id, failAssetGeneration);
      pushToast({ kind: "error", text: `${asset.name}の生成に失敗しました: ${(error as Error)?.message ?? error}` });
    } finally {
      tracker.done();
    }
  }

  async function runStress(asset: FilmAsset, round: "primary" | "extra") {
    let started: FilmAsset;
    try {
      started = beginStressTest(asset, round);
    } catch (error) {
      pushToast({ kind: "warn", text: String((error as Error)?.message ?? error), ttlMs: 5000 });
      return;
    }
    persist(asset.id, () => started);
    setStressRunningAssetId(asset.id);
    const tracker = beginDirectRun("characterSheet", 5, `film-stress-${project.id}-${asset.id}-${round}-${Date.now()}`);
    const otherNames = project.assets
      .filter((candidate) => candidate.type === "character" && candidate.id !== asset.id)
      .map((candidate) => candidate.name);
    const paths: string[] = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const condition = started.stressTest?.conditions[index];
        if (!condition || !started.canonicalImagePath) throw new Error("5条件または採用シートが不足しています");
        const result = await tracker.step(() => images.generateBatch({
          prompt: buildStressTestImagePrompt(started, condition, otherNames),
          count: 1,
          refImagePaths: [started.canonicalImagePath as string],
          aspect: "16:9",
          enforceAspect: true,
          maxAttempts: 1,
          sourceTag: tracker.id,
        }));
        const path = result.generatedPaths[0];
        if (!path) throw new Error(`${condition}の画像が完成しませんでした`);
        paths.push(path);
      }
      persist(asset.id, (current) => completeStressTestGeneration(current, paths, round));
      pushToast({ kind: "success", text: `${asset.name}の5枚ができました。1枚ずつ合否を付けてください。`, ttlMs: 5000 });
    } catch (error) {
      persist(asset.id, (current) => failStressTestGeneration(current, round));
      pushToast({ kind: "error", text: `ストレステスト生成に失敗しました: ${(error as Error)?.message ?? error}` });
    } finally {
      tracker.done();
      setStressRunningAssetId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">④ アセット工場</p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">設計を全部書いてから、素材を固定する</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          全キャラ・全ロケ・全小道具をロックし、人物はストレステストに通すまで、⑤の1ショットも生成しません。
        </p>
      </header>

      <section className="rounded-xl border border-[#303030] bg-[#171717] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">設計・生成の順序ガイド</h3>
            <p className="mt-2 text-xs font-semibold text-pink-200">
              主要キャラ → 主要ロケ → 文字物 → 小道具 → 準キャラ
            </p>
            <p className="mt-2 text-xs leading-5 text-zinc-500">
              生成しながら設計すると、後半の設定が前半と食い違います。だから画像を1枚も作らないうちに、全プロンプトを書き切ります。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void draftAllMissing()}
            disabled={draftingAll || Boolean(draftingAssetId) || allDrafted}
            className="rounded-md bg-pink-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {draftingAll ? "未起草を順番に作成中…" : "未起草をすべてAIで起草"}
          </button>
        </div>
        {draftingAssetId ? (
          <div className="mt-4 flex items-center gap-3 rounded-md border border-[#303030] bg-[#121212] px-3 py-3">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-pink-200">{draftingAssetId} の全文をAIが起草中</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{draftProgress?.receivedChars ?? 0}文字を受信</p>
            </div>
            <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-[#3a3a3a] px-3 py-1.5 text-[11px] text-zinc-300">中止</button>
          </div>
        ) : null}
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#252525]">
          <div
            className="h-full rounded-full bg-pink-500 transition-all"
            style={{ width: `${project.assets.length === 0 ? 0 : (project.assets.filter((asset) => Boolean(asset.promptDraft?.trim())).length / project.assets.length) * 100}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          起草済み {project.assets.filter((asset) => Boolean(asset.promptDraft?.trim())).length} / {project.assets.length}
        </p>
      </section>

      {!allDrafted ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          生成セクションはロック中です。全アセットのプロンプトを保存すると開きます。
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          全アセットの設計が揃いました。ここから1アセット3枚ずつ生成できます。
        </div>
      )}

      <div className="grid gap-5">
        {assets.map((asset) => {
          const pairReference = findLocationPairReferencePath(asset, project.assets);
          return (
            <article key={asset.id} className="rounded-xl border border-[#292929] bg-[#171717] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-pink-300">{asset.id}</span>
                    <span className="rounded-full border border-[#3a3a3a] px-2 py-0.5 text-[10px] text-zinc-400">{TYPE_LABELS[asset.type]}</span>
                    <span className="rounded-full border border-[#3a3a3a] px-2 py-0.5 text-[10px] text-zinc-400">{IMPORTANCE_LABELS[asset.importance]}</span>
                    <span className={asset.locked ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300" : "rounded-full bg-zinc-700/40 px-2 py-0.5 text-[10px] font-semibold text-zinc-400"}>{statusLabel(asset)}</span>
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-zinc-100">{asset.name}</h3>
                  <p className="mt-1 text-[11px] text-zinc-600">登場: {asset.blockIds.join(", ") || "未設定"}</p>
                </div>
                {asset.locked ? <span className="text-xs font-semibold text-emerald-300">正典を固定済み</span> : null}
              </div>

              {asset.type === "prop" ? (
                <p className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-200">
                  硬貨・記章・特殊な瓶など正確さが必要なら、生成前に実物写真を参照添付します。
                </p>
              ) : null}
              {asset.type === "location" && asset.pairKey ? (
                <p className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs leading-5 text-violet-200">
                  状態違いペア「{asset.pairKey}」{pairReference ? "の採用済み画像を参照に添付して生成します。" : "です。先に片方を採用すると、もう片方へ自動で参照添付します。"}
                </p>
              ) : null}

              <PromptEditor
                asset={asset}
                drafting={draftingAssetId === asset.id}
                generationLocked={!allDrafted}
                onDraft={() => void draftOne(asset)}
                onSave={(prompt) => persist(asset.id, (current) => saveAssetPromptDraft(current, prompt))}
                onGenerate={() => void generateAsset(asset)}
              />

              <CandidateReview
                asset={asset}
                onAdopt={(path) => {
                  persist(asset.id, (current) => adoptAssetCandidate(current, path));
                  pushToast({
                    kind: "success",
                    text: asset.type === "character"
                      ? `${asset.name}の正典シートを採用しました。次は5枚テストです。`
                      : `${asset.name}を採用し、ロックしました。`,
                    ttlMs: 5000,
                  });
                }}
                onReject={(note) => {
                  persist(asset.id, (current) => rejectAssetCandidates(current, note));
                  pushToast({ kind: "warn", text: "NG理由を保存しました。文面を直してから再生成してください。", ttlMs: 6000 });
                }}
              />

              {asset.canonicalImagePath ? (
                <section className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
                  <h4 className="text-xs font-semibold text-emerald-200">採用画像</h4>
                  <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,320px)_1fr]">
                    <SafeImage path={asset.canonicalImagePath} alt={`${asset.name}の採用画像`} className="aspect-video w-full rounded-lg bg-black object-contain" />
                    <div>
                      <p className="break-all text-xs text-zinc-400">{basename(asset.canonicalImagePath)}</p>
                      {asset.locked ? (
                        <p className="mt-3 text-xs leading-5 text-amber-200">
                          ロック後は編集できません。変えたくなったら、このアセットを使った生成物を全部作り直す覚悟が要ります。
                        </p>
                      ) : (
                        <p className="mt-3 text-xs leading-5 text-zinc-500">人物はまだ仮固定です。5枚テストを通るとロックされます。</p>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}

              <StressTestSection
                asset={asset}
                running={stressRunningAssetId === asset.id}
                onUpdateConditions={(conditions) => persist(asset.id, (current) => updateStressConditions(current, conditions))}
                onRun={(round) => void runStress(asset, round)}
                onVerdict={(round, index, verdict) => persist(asset.id, (current) => setStressTestVerdict(current, index, verdict, round))}
                onEvaluate={(round) => {
                  persist(asset.id, (current) => evaluateStressTest(current, round));
                }}
                onChooseExtra={(decision) => {
                  const chosen = chooseExtraStressRound(asset, decision);
                  persist(asset.id, () => chosen);
                  if (decision === "run") void runStress(chosen, "extra");
                  else pushToast({ kind: "success", text: `${asset.name}をロックしました。`, ttlMs: 4000 });
                }}
              />

              {asset.ngNotes.length > 0 ? (
                <details className="mt-4 rounded-md border border-[#303030] bg-[#121212] px-3 py-2 text-xs text-zinc-400">
                  <summary className="cursor-pointer">NG記録 {asset.ngNotes.length}件</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {asset.ngNotes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>

      <section className="rounded-xl border border-[#303030] bg-[#141414] p-5">
        <h3 className="text-sm font-semibold text-zinc-100">④完了ゲート</h3>
        <ul className="mt-3 grid gap-2 text-xs">
          <li className={gate.undraftedAssetIds.length === 0 ? "text-emerald-300" : "text-zinc-500"}>全アセット起草済み {gate.undraftedAssetIds.length ? `（未: ${gate.undraftedAssetIds.join(", ")}）` : ""}</li>
          <li className={gate.unlockedPrimaryAssetIds.length === 0 ? "text-emerald-300" : "text-zinc-500"}>主要アセット全点ロック {gate.unlockedPrimaryAssetIds.length ? `（未: ${gate.unlockedPrimaryAssetIds.join(", ")}）` : ""}</li>
        </ul>
        {gate.unlockedOptionalAssetIds.length > 0 ? (
          <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">
            準・背景は未ロックでも進めます。未ロック: {gate.unlockedOptionalAssetIds.join(", ")}
          </p>
        ) : null}
        <button
          type="button"
          disabled
          className="mt-4 rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          ⑤生成は近日対応（次のアップデート）
        </button>
      </section>
    </div>
  );
}
