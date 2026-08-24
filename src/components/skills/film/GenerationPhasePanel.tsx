import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { images as imagesIpc } from "../../../lib/ipc";
import {
  findVideoServiceProfile,
  type VideoReferenceKind,
} from "../../../lib/film/serviceProfiles";
import type { FilmBlock, FilmProject } from "../../../lib/film/types";
import {
  buildVideoGenerationPrompt,
  summarizeFilmBlock,
} from "../../../lib/film/videoGenPrompts";
import {
  createFilmGenReference,
  filmGenRunKey,
  getFilmGenerationDisabledReason,
  HIGGSFIELD_VIDEO_MODEL_BY_SERVICE,
  isPacketService,
  useFilmGenRun,
  type FilmGenBlockRun,
  type FilmGenReference,
} from "../../../lib/store/filmGenRun";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";
import { findVideoModel } from "../../../lib/videoModels";
import { ReferenceLibraryModal } from "../../ReferenceLibraryModal";
import { SafeImage } from "../../SafeImage";
import { CharacterPresetPickerModal } from "../multiAngle/CharacterPresetPickerModal";

const KIND_LABELS: Record<VideoReferenceKind, string> = {
  image: "画像",
  video: "動画",
  audio: "音声",
};

function basename(path: string): string {
  return path.split(/[\\/]/u).pop() || path;
}

function supportLabel(value: boolean | null): string {
  if (value === true) return "対応";
  if (value === false) return "非対応";
  return "未確認";
}

function statusLabel(run: FilmGenBlockRun | undefined, adoptedPath: string | null): string {
  if (adoptedPath || run?.status === "adopted") return "採用済み";
  if (run?.status === "running") return "生成中";
  if (run?.status === "review") return "確認待ち";
  return "未生成";
}

function statusClass(label: string): string {
  if (label === "採用済み") return "bg-emerald-500/15 text-emerald-300";
  if (label === "生成中") return "bg-sky-500/15 text-sky-300";
  if (label === "確認待ち") return "bg-amber-500/15 text-amber-300";
  return "bg-zinc-700/40 text-zinc-400";
}

function adoptedPathFor(project: FilmProject, blockId: string): string | null {
  return project.takes.find((take) => take.blockId === blockId && take.adopted)?.path ?? null;
}

function ReferenceGuide({ project, referenceCount }: { project: FilmProject; referenceCount: number }) {
  const profile = findVideoServiceProfile(project.videoServiceId);
  if (!profile) {
    return (
      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        この動画サービスの参照条件は未登録です。
      </p>
    );
  }
  const rules = profile.referenceRules;
  if (!rules) {
    return (
      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        参照条件は未取得です。参照を付ける生成は、条件が分かるまで実行しません。
      </p>
    );
  }
  const limitParts = [
    rules.limits.images === null ? "画像上限は未確認" : `画像${rules.limits.images}枚`,
    rules.limits.videos === null ? null : `動画${rules.limits.videos}本`,
    rules.limits.audio === null ? null : `音声${rules.limits.audio}本`,
    rules.limits.total === null ? null : `合計${rules.limits.total}点`,
  ].filter((part): part is string => Boolean(part));
  return (
    <div className="rounded-md border border-[#303030] bg-[#111111] px-3 py-3 text-[11px] leading-5 text-zinc-400">
      <p className="font-semibold text-zinc-200">{profile.label}の参照ガイド</p>
      <p className="mt-1">
        開始フレーム: {supportLabel(rules.startEndFrames.start)} / 終了フレーム: {supportLabel(rules.startEndFrames.end)} / 開始＋終了: {supportLabel(rules.startEndFrames.combined)}
      </p>
      <p>使える種類: {rules.kinds.map((kind) => KIND_LABELS[kind]).join("・")}</p>
      <p>上限: {limitParts.join(" / ")}（現在は画像{referenceCount}枚）</p>
      <p>書き方: {profile.referenceNotation}</p>
      <ul className="mt-1 list-disc pl-4 text-zinc-500">
        {rules.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </div>
  );
}

type PickerTarget = { blockId: string; index: number };

function ReferenceSlots({
  project,
  block,
  run,
  missingAssetNames,
  onPickCharacter,
  onPickLibrary,
  onPickLocal,
}: {
  project: FilmProject;
  block: FilmBlock;
  run: FilmGenBlockRun;
  missingAssetNames: string[];
  onPickCharacter: (target: PickerTarget) => void;
  onPickLibrary: (target: PickerTarget) => void;
  onPickLocal: (target: PickerTarget) => void;
}) {
  const removeReference = useFilmGenRun((state) => state.removeReference);
  const pushToast = useToasts((state) => state.push);
  const packetService = isPacketService(project.videoServiceId);
  const nextTarget = { blockId: block.id, index: run.references.length };

  async function revealInFinder(path: string) {
    try {
      await imagesIpc.revealInFinder(path);
    } catch (error) {
      pushToast({ kind: "error", text: `Finderで表示できませんでした: ${String(error)}`, ttlMs: 6000 });
    }
  }

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-zinc-100">参照画像</h4>
          <p className="mt-1 text-[11px] text-zinc-500">このブロックに登場する決定版素材を自動で入れています。必要な所だけ差し替えられます。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => onPickCharacter(nextTarget)} className="rounded-md border border-[#3a3a3a] px-2.5 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/50">登録キャラを追加</button>
          <button type="button" onClick={() => onPickLibrary(nextTarget)} className="rounded-md border border-[#3a3a3a] px-2.5 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/50">ライブラリから追加</button>
          <button type="button" onClick={() => onPickLocal(nextTarget)} className="rounded-md border border-[#3a3a3a] px-2.5 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/50">手元の画像を追加</button>
        </div>
      </div>

      {run.references.length > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {run.references.map((reference, index) => (
            <div key={reference.id} className="rounded-lg border border-[#2d2d2d] bg-[#111111] p-2.5">
              <SafeImage path={reference.path} alt={reference.name} className="aspect-video w-full rounded-md bg-black object-contain" />
              <p className="mt-2 truncate text-xs font-semibold text-zinc-200">参照{index + 1}: {reference.name}</p>
              <p className="mt-0.5 text-[10px] text-zinc-600">{reference.source === "asset" ? `自動候補 ${reference.assetId ?? ""}` : "手動で選択"}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onPickCharacter({ blockId: block.id, index })} className="rounded border border-[#343434] px-2 py-1 text-[10px] text-zinc-400">登録キャラ</button>
                <button type="button" onClick={() => onPickLibrary({ blockId: block.id, index })} className="rounded border border-[#343434] px-2 py-1 text-[10px] text-zinc-400">ライブラリ</button>
                <button type="button" onClick={() => onPickLocal({ blockId: block.id, index })} className="rounded border border-[#343434] px-2 py-1 text-[10px] text-zinc-400">手元</button>
                {packetService ? <button type="button" onClick={() => void revealInFinder(reference.path)} className="rounded border border-[#343434] px-2 py-1 text-[10px] text-zinc-400">Finderで表示</button> : null}
                <button type="button" onClick={() => removeReference(project.id, block.id, index)} className="rounded px-2 py-1 text-[10px] text-zinc-600 hover:text-red-300">外す</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-[#343434] px-3 py-4 text-center text-xs text-zinc-600">参照画像なし。文章だけで生成します。</p>
      )}
      {missingAssetNames.length > 0 ? (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          決定版画像がないため自動で付けられない素材: {missingAssetNames.join("、")}
        </p>
      ) : null}
      <div className="mt-3">
        <ReferenceGuide project={project} referenceCount={run.references.length} />
      </div>
    </section>
  );
}

function BlockGenerationCard({
  project,
  block,
  run,
  missingAssetNames,
  onPickCharacter,
  onPickLibrary,
  onPickLocal,
}: {
  project: FilmProject;
  block: FilmBlock;
  run: FilmGenBlockRun;
  missingAssetNames: string[];
  onPickCharacter: (target: PickerTarget) => void;
  onPickLibrary: (target: PickerTarget) => void;
  onPickLocal: (target: PickerTarget) => void;
}) {
  const connectionStatus = useFilmGenRun((state) => state.connectionStatus);
  const setPromptDraft = useFilmGenRun((state) => state.setPromptDraft);
  const savePrompt = useFilmGenRun((state) => state.savePrompt);
  const setImportedResult = useFilmGenRun((state) => state.setImportedResult);
  const setNgReason = useFilmGenRun((state) => state.setNgReason);
  const generate = useFilmGenRun((state) => state.generate);
  const retry = useFilmGenRun((state) => state.retry);
  const markAdopted = useFilmGenRun((state) => state.markAdopted);
  const saveBlockVideoTake = useFilmProjectStore((state) => state.saveBlockVideoTake);
  const pushToast = useToasts((state) => state.push);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const packetService = isPacketService(project.videoServiceId);
  const disabledReason = getFilmGenerationDisabledReason({
    run,
    serviceId: project.videoServiceId,
    durationSeconds: block.durationSeconds,
    connectionStatus,
  });
  const request = {
    projectId: project.id,
    blockId: block.id,
    serviceId: project.videoServiceId,
    durationSeconds: block.durationSeconds,
  };
  const promptDirty = run.promptDraft.trim() !== run.savedPrompt.trim();

  async function copyPacketPrompt() {
    if (disabledReason) {
      pushToast({ kind: "warn", text: disabledReason, ttlMs: 5000 });
      return;
    }
    try {
      await navigator.clipboard.writeText(run.savedPrompt);
      pushToast({ kind: "success", text: "プロンプトをコピーしました。", ttlMs: 2500 });
    } catch (error) {
      pushToast({ kind: "error", text: `プロンプトをコピーできませんでした: ${String(error)}`, ttlMs: 6000 });
    }
  }

  async function importVideo(file: File | null) {
    if (!file) return;
    if (!/\.(mp4|webm|mov)$/iu.test(file.name)) {
      pushToast({ kind: "error", text: "MP4、WebM、MOVの動画を選んでください。", ttlMs: 5000 });
      return;
    }
    try {
      const path = await imagesIpc.writeUpload(file.name, new Uint8Array(await file.arrayBuffer()));
      setImportedResult(project.id, block.id, path);
      pushToast({ kind: "success", text: "動画を取り込みました。内容を確認してください。", ttlMs: 4000 });
    } catch (error) {
      pushToast({ kind: "error", text: `動画を取り込めませんでした: ${String(error)}`, ttlMs: 6000 });
    }
  }

  async function runRetry() {
    const reason = run.lastNgReason.trim();
    if (!reason || !run.resultPath) return;
    if (!saveBlockVideoTake(block.id, run.resultPath, false, reason)) {
      pushToast({ kind: "error", text: "不採用の記録を保存できませんでした。", ttlMs: 5000 });
      return;
    }
    await retry(request, reason);
  }

  function adopt() {
    if (!run.resultPath) return;
    if (!saveBlockVideoTake(block.id, run.resultPath, true, "採用")) {
      pushToast({ kind: "error", text: "採用結果をフィルムへ保存できませんでした。", ttlMs: 5000 });
      return;
    }
    markAdopted(project.id, block.id);
    pushToast({ kind: "success", text: `${block.sceneId}/${block.id}の動画を採用し、保存しました。`, ttlMs: 4000 });
  }

  return (
    <article className="rounded-xl border border-[#303030] bg-[#171717] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs font-semibold text-pink-300">{block.sceneId}/{block.id} ・ {block.durationSeconds}秒</p>
          <h3 className="mt-1 text-base font-semibold text-zinc-100">{summarizeFilmBlock(block, 96)}</h3>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusClass(statusLabel(run, adoptedPathFor(project, block.id)))}`}>
          {statusLabel(run, adoptedPathFor(project, block.id))}
        </span>
      </div>

      <section className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-zinc-100">3層の合成プロンプト</h4>
            <p className="mt-1 text-[11px] text-zinc-500">設計・決定版素材・このブロックの台本を1本にまとめています。直したら保存してください。</p>
          </div>
          <button
            type="button"
            disabled={!run.promptDraft.trim() || !promptDirty || run.status === "running" || run.status === "adopted"}
            onClick={() => {
              if (savePrompt(project.id, block.id)) {
                pushToast({ kind: "success", text: "合成プロンプトを保存しました。", ttlMs: 2500 });
              }
            }}
            className="rounded-md border border-[#3a3a3a] px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:border-pink-500/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            保存して確定
          </button>
        </div>
        <textarea
          rows={18}
          value={run.promptDraft}
          disabled={run.status === "running" || run.status === "adopted"}
          onChange={(event) => setPromptDraft(project.id, block.id, event.target.value)}
          className="mt-3 w-full resize-y rounded-lg border border-[#303030] bg-[#101010] px-3 py-3 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-pink-500 disabled:text-zinc-500"
        />
        <p className={`mt-1 text-[11px] ${promptDirty ? "text-amber-300" : run.savedPrompt ? "text-emerald-300" : "text-zinc-600"}`}>
          {promptDirty ? "未保存の変更があります" : run.savedPrompt ? "保存済み" : "最初に保存すると生成できます"}
        </p>
      </section>

      <ReferenceSlots
        project={project}
        block={block}
        run={run}
        missingAssetNames={missingAssetNames}
        onPickCharacter={onPickCharacter}
        onPickLibrary={onPickLibrary}
        onPickLocal={onPickLocal}
      />

      {run.status === "running" ? (
        <div className="mt-5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-xs text-sky-200"><span>{run.progressLabel}</span><span>{Math.round(run.progress * 100)}%</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sky-950"><div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${run.progress * 100}%` }} /></div>
        </div>
      ) : null}
      {run.error ? <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{run.error}</p> : null}

      {packetService ? (
        <div className="mt-5 rounded-lg border border-[#303030] bg-[#111111] px-4 py-4">
          <p className="text-xs leading-5 text-zinc-400">このサービスは Web で生成します。プロンプトと参照を渡して、できた動画をここへ取り込んでください。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void copyPacketPrompt()} className="rounded-md border border-[#3a3a3a] px-4 py-2 text-sm font-semibold text-zinc-200 hover:border-pink-500/50">プロンプトをコピー</button>
            <button type="button" disabled={run.status === "adopted"} onClick={() => videoInputRef.current?.click()} className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400">できた動画を取り込む</button>
            <input ref={videoInputRef} type="file" accept=".mp4,.webm,.mov" className="hidden" onChange={(event) => { void importVideo(event.target.files?.[0] ?? null); event.target.value = ""; }} />
          </div>
          {disabledReason ? <p className="mt-2 text-xs leading-5 text-amber-200">実行できない理由: {disabledReason}</p> : null}
        </div>
      ) : (run.status === "idle" || run.status === "error") ? (
        <div className="mt-5">
          <button
            type="button"
            disabled={Boolean(disabledReason)}
            onClick={() => void generate(request)}
            className="rounded-md bg-pink-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            この動画を生成
          </button>
          {disabledReason ? <p className="mt-2 text-xs leading-5 text-amber-200">実行できない理由: {disabledReason}</p> : null}
        </div>
      ) : null}

      {run.resultPath ? (
        <section className="mt-5 rounded-xl border border-[#343434] bg-[#111111] p-4">
          <h4 className="text-sm font-semibold text-zinc-100">生成結果</h4>
          <video key={run.resultPath} controls preload="metadata" src={convertFileSrc(run.resultPath)} className="mt-3 aspect-video w-full rounded-lg bg-black" />
          <p className="mt-2 break-all text-[10px] text-zinc-600">{run.resultPath}</p>
          {run.status === "review" ? (
            <div className="mt-4 grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-end">
              <button type="button" onClick={adopt} className="rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-400">採用</button>
              <label className="text-xs text-zinc-400">
                やり直す理由（必須）
                <input
                  value={run.lastNgReason}
                  onChange={(event) => setNgReason(project.id, block.id, event.target.value)}
                  placeholder="例: 顔が途中で別人になった"
                  className="mt-1 h-10 w-full rounded-md border border-[#343434] bg-[#181818] px-3 text-sm text-zinc-100 outline-none focus:border-pink-500"
                />
              </label>
              <button type="button" disabled={!run.lastNgReason.trim()} onClick={() => void runRetry()} className="rounded-md border border-amber-500/50 px-4 py-2.5 text-sm font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40">理由を反映してやり直す</button>
            </div>
          ) : (
            <p className="mt-3 text-sm font-semibold text-emerald-300">この動画をブロックへ採用済みです。</p>
          )}
        </section>
      ) : null}
    </article>
  );
}

export function GenerationPhasePanel({ project }: { project: FilmProject }) {
  const script = Array.isArray(project.script) ? null : project.script;
  const blocks = script?.blocks ?? [];
  const profile = findVideoServiceProfile(project.videoServiceId);
  const packetService = isPacketService(project.videoServiceId);
  const modelId = profile ? HIGGSFIELD_VIDEO_MODEL_BY_SERVICE[profile.id] : null;
  const model = modelId ? findVideoModel(modelId) : undefined;
  const runs = useFilmGenRun((state) => state.runs);
  const initializeBlock = useFilmGenRun((state) => state.initializeBlock);
  const refreshConnection = useFilmGenRun((state) => state.refreshConnection);
  const replaceReference = useFilmGenRun((state) => state.replaceReference);
  const connectionStatus = useFilmGenRun((state) => state.connectionStatus);
  const connectionReason = useFilmGenRun((state) => state.connectionReason);
  const pushToast = useToasts((state) => state.push);
  const [activeBlockId, setActiveBlockId] = useState(blocks[0]?.id ?? "");
  const [characterTarget, setCharacterTarget] = useState<PickerTarget | null>(null);
  const [libraryTarget, setLibraryTarget] = useState<PickerTarget | null>(null);
  const localTargetRef = useRef<PickerTarget | null>(null);
  const localInputRef = useRef<HTMLInputElement | null>(null);

  const sceneById = useMemo(
    () => new Map((script?.scenes ?? []).map((scene) => [scene.id, scene])),
    [script?.scenes],
  );

  useEffect(() => {
    for (const block of blocks) {
      const assets = project.assets.filter((asset) => asset.blockIds.includes(block.id));
      initializeBlock({
        projectId: project.id,
        blockId: block.id,
        prompt: buildVideoGenerationPrompt({
          title: project.title,
          theme: project.theme,
          lookDescription: project.lookMasterDescription,
          lookMasterPath: project.lookMasterPath,
          stylePrefix: project.stylePrefix,
          sceneId: block.sceneId,
          sceneLocation: sceneById.get(block.sceneId)?.location,
          block,
          assets: assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            type: asset.type,
            prompt: asset.promptDraft ?? "",
            referencePath: asset.canonicalImagePath,
          })),
          referenceNotation: profile?.referenceNotation,
        }),
        references: assets.flatMap((asset): FilmGenReference[] =>
          asset.canonicalImagePath
            ? [{
                id: `asset-${asset.id}`,
                path: asset.canonicalImagePath,
                name: asset.name,
                source: "asset",
                assetId: asset.id,
              }]
            : [],
        ),
        adoptedPath: adoptedPathFor(project, block.id),
      });
    }
  }, [blocks, initializeBlock, profile?.referenceNotation, project, sceneById]);

  useEffect(() => {
    if (!packetService) void refreshConnection();
  }, [packetService, refreshConnection]);

  useEffect(() => {
    if (!blocks.some((block) => block.id === activeBlockId)) {
      setActiveBlockId(blocks[0]?.id ?? "");
    }
  }, [activeBlockId, blocks]);

  async function pickLocalImage(file: File | null) {
    const target = localTargetRef.current;
    localTargetRef.current = null;
    if (!target || !file) return;
    if (!/\.(png|jpe?g|webp)$/iu.test(file.name)) {
      pushToast({ kind: "warn", text: "PNG、JPEG、WebPの画像を選んでください。", ttlMs: 4000 });
      return;
    }
    try {
      const path = await imagesIpc.writeUpload(file.name, new Uint8Array(await file.arrayBuffer()));
      replaceReference(project.id, target.blockId, target.index, createFilmGenReference(path, file.name, "local"));
    } catch (error) {
      pushToast({ kind: "error", text: `画像を取り込めませんでした: ${String(error)}`, ttlMs: 6000 });
    }
  }

  const activeBlock = blocks.find((block) => block.id === activeBlockId) ?? blocks[0];
  const activeRun = activeBlock ? runs[filmGenRunKey(project.id, activeBlock.id)] : undefined;
  const activeAssets = activeBlock
    ? project.assets.filter((asset) => asset.blockIds.includes(activeBlock.id))
    : [];
  const missingAssetNames = activeAssets
    .filter((asset) => !asset.canonicalImagePath)
    .map((asset) => `${asset.id} ${asset.name}`);

  if (!script || blocks.length === 0) {
    return <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-200">OK済みのブロック台本がありません。②脚本でブロックを確定してください。</div>;
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">⑤ 映像づくり</p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">1ブロックずつ作り、見てから採用する</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">設計・決定版素材・台本を1本の指示にまとめ、既存のHiggsfield動画生成で実際に作ります。</p>
      </header>

      <section className="rounded-xl border border-[#303030] bg-[#171717] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-zinc-100">動画サービス: {profile?.label ?? project.videoServiceId}</p>
            {!packetService ? <p className="mt-1 text-xs text-zinc-500">Higgsfieldモデル: {model ? `${model.label}（${model.jobSetType}）` : "対応ID未確認"}</p> : null}
          </div>
          {!packetService ? (
            <div className="text-right">
              <p className={connectionStatus === "ready" ? "text-xs font-semibold text-emerald-300" : "text-xs font-semibold text-amber-200"}>
                {connectionStatus === "ready" ? "Higgsfield接続済み" : connectionStatus === "checking" ? "接続を確認中" : "Higgsfield未接続"}
              </p>
              {connectionStatus !== "ready" && connectionStatus !== "checking" ? (
                <button type="button" onClick={() => void refreshConnection()} className="mt-1 text-[11px] text-pink-300 hover:text-pink-200">接続を再確認</button>
              ) : null}
            </div>
          ) : null}
        </div>
        {!packetService && connectionReason && connectionStatus !== "ready" ? <p className="mt-2 text-[11px] text-zinc-600">{connectionReason}</p> : null}
      </section>

      <section className="rounded-xl border border-[#303030] bg-[#141414] p-4">
        <h3 className="text-sm font-semibold text-zinc-100">ブロック一覧</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {blocks.map((block) => {
            const run = runs[filmGenRunKey(project.id, block.id)];
            const label = statusLabel(run, adoptedPathFor(project, block.id));
            const active = activeBlock?.id === block.id;
            return (
              <button
                key={block.id}
                type="button"
                onClick={() => setActiveBlockId(block.id)}
                className={`rounded-lg border px-3 py-3 text-left transition ${active ? "border-pink-500 bg-pink-500/10" : "border-[#303030] bg-[#181818] hover:border-pink-500/40"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-pink-300">{block.sceneId}/{block.id} ・ {block.durationSeconds}秒</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusClass(label)}`}>{label}</span>
                </span>
                <span className="mt-2 block text-xs leading-5 text-zinc-400">{summarizeFilmBlock(block)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {activeBlock && activeRun ? (
        <BlockGenerationCard
          project={project}
          block={activeBlock}
          run={activeRun}
          missingAssetNames={missingAssetNames}
          onPickCharacter={setCharacterTarget}
          onPickLibrary={setLibraryTarget}
          onPickLocal={(target) => {
            localTargetRef.current = target;
            localInputRef.current?.click();
          }}
        />
      ) : (
        <div className="rounded-xl border border-[#303030] bg-[#171717] p-5 text-sm text-zinc-500">生成カードを準備しています。</div>
      )}

      <input ref={localInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void pickLocalImage(event.target.files?.[0] ?? null); event.target.value = ""; }} />
      {characterTarget ? (
        <CharacterPresetPickerModal
          onClose={() => setCharacterTarget(null)}
          onPick={(path) => {
            replaceReference(project.id, characterTarget.blockId, characterTarget.index, createFilmGenReference(path, basename(path), "character"));
            setCharacterTarget(null);
          }}
        />
      ) : null}
      <ReferenceLibraryModal
        open={libraryTarget !== null}
        onClose={() => setLibraryTarget(null)}
        onPick={(path, name) => {
          if (!libraryTarget) return;
          replaceReference(project.id, libraryTarget.blockId, libraryTarget.index, createFilmGenReference(path, name, "library"));
          setLibraryTarget(null);
        }}
      />
    </div>
  );
}
