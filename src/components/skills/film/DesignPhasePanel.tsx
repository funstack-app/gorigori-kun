import { useEffect, useMemo, useRef, useState } from "react";

import {
  extractForeshadowLedger,
  nextAssetId,
  parseAssetLedgerResponse,
  validateAssetLedger,
  type AssetParseFailure,
} from "../../../lib/film/assetParse";
import {
  FilmTextTurnAbortedError,
  FilmTextTurnTimeoutError,
  runFilmTextTurn,
  type FilmTextTurnLabel,
  type FilmTextTurnProgress,
} from "../../../lib/film/codexText";
import {
  buildAssetLedgerPrompt,
  buildLookImagePrompt,
  buildLookProposalPrompt,
  buildStylePrefixPrompt,
  parseLookProposals,
} from "../../../lib/film/designPrompts";
import type {
  AssetImportance,
  AssetLedgerEntry,
  AssetPairSide,
  AssetType,
  FilmProject,
  ForeshadowEntry,
} from "../../../lib/film/types";
import { images } from "../../../lib/ipc";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";
import { SafeImage } from "../../SafeImage";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  character: "登場人物",
  location: "場所",
  text: "文字物",
  prop: "小道具",
};

const IMPORTANCE_LABELS: Record<AssetImportance, string> = {
  primary: "主要",
  supporting: "補助",
  background: "背景",
};

type RunningText = "assets" | "look" | "style";
type LookCandidate = { label: "A" | "B"; description: string; path: string };

function basename(path: string): string {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] || path;
}

function splitBlockIds(value: string): string[] {
  return value
    .split(/[,、／/\s]+/u)
    .map((blockId) => blockId.trim().toUpperCase())
    .filter(Boolean)
    .filter((blockId, index, blockIds) => blockIds.indexOf(blockId) === index);
}

function nextForeshadowId(entries: ForeshadowEntry[]): string {
  const highest = entries.reduce((max, entry) => {
    const match = entry.id.match(/^F(\d+)$/u);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `F${highest + 1}`;
}

function TextProgressCard({
  label,
  progress,
  onCancel,
}: {
  label: string;
  progress?: FilmTextTurnProgress;
  onCancel: () => void;
}) {
  const stalled = progress?.phase === "stalled";
  return (
    <div className="mt-4 flex items-center gap-3 rounded-lg border border-[#303030] bg-[#141414] px-4 py-3">
      <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold ${stalled ? "text-amber-300" : "text-pink-300"}`}>
          {stalled
            ? "応答が止まっています。待てば続くことがあります"
            : progress?.phase === "streaming"
              ? `${label}を受信中`
              : "AIの応答を待っています"}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {progress?.receivedChars ? `${progress.receivedChars.toLocaleString()}文字を受信` : "届いた内容は途中で捨てません"}
        </p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-[#3a3a3a] px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-[#242424]"
      >
        中止
      </button>
    </div>
  );
}

function AssetParseErrorCard({ failure, raw }: { failure: AssetParseFailure; raw: string }) {
  return (
    <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <p className="text-xs font-semibold text-amber-200">
        {failure.error.line}行目・{failure.error.column}列目: {failure.error.reason}
      </p>
      {failure.error.sourceLine ? (
        <code className="mt-2 block overflow-x-auto rounded bg-black/20 px-2 py-1.5 text-[11px] text-amber-100">
          {failure.error.sourceLine}
        </code>
      ) : null}
      <details className="mt-3 text-[11px] text-zinc-400">
        <summary className="cursor-pointer text-amber-200/80">AIから届いた文を表示</summary>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-3 text-zinc-300">
          {raw}
        </pre>
      </details>
    </div>
  );
}

function StatusLine({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li className={ok ? "text-emerald-300" : "text-zinc-500"}>
      <span className="mr-2 inline-block w-4 text-center">{ok ? "済" : "未"}</span>
      {children}
    </li>
  );
}

function BlockIdListInput({
  blockIds,
  placeholder,
  disabled = false,
  onCommit,
}: {
  blockIds: string[];
  placeholder: string;
  disabled?: boolean;
  onCommit: (blockIds: string[]) => void;
}) {
  const joined = blockIds.join(", ");
  const [draft, setDraft] = useState(joined);

  useEffect(() => {
    setDraft(joined);
  }, [joined]);

  return (
    <input
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(splitBlockIds(draft))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      placeholder={placeholder}
      className="h-9 w-36 rounded border border-[#303030] bg-[#111111] px-2 font-mono outline-none placeholder:text-zinc-700 focus:border-pink-500"
    />
  );
}

export function DesignPhasePanel({ project }: { project: FilmProject }) {
  const saveAssets = useFilmProjectStore((state) => state.saveAssets);
  const saveForeshadow = useFilmProjectStore((state) => state.saveForeshadow);
  const saveLookMaster = useFilmProjectStore((state) => state.saveLookMaster);
  const saveStylePrefix = useFilmProjectStore((state) => state.saveStylePrefix);
  const approveLook = useFilmProjectStore((state) => state.approveLook);
  const approveLookLenient = useFilmProjectStore((state) => state.approveLookLenient);
  const pushToast = useToasts((state) => state.push);

  const script = Array.isArray(project.script) ? null : project.script;
  const blockIds = useMemo(() => script?.blocks.map((block) => block.id) ?? [], [script]);
  const scriptReady = Boolean(project.approvals.blocks && script && blockIds.length > 0);
  const assetIssues = useMemo(
    () => validateAssetLedger(project.assets, blockIds),
    [blockIds, project.assets],
  );
  const pairWarnings = useMemo(() => {
    const pairs = new Map<string, Set<AssetPairSide>>();
    for (const asset of project.assets) {
      const key = asset.pairKey?.trim();
      if (!key && !asset.pairSide) continue;
      const group = key || `${asset.id}（組名未設定）`;
      const sides = pairs.get(group) ?? new Set<AssetPairSide>();
      if (asset.pairSide) sides.add(asset.pairSide);
      pairs.set(group, sides);
    }
    return [...pairs.entries()]
      .filter(([, sides]) => !sides.has("①") || !sides.has("②"))
      .map(([key]) => `${key} は①と②の片方だけです。`);
  }, [project.assets]);
  const foreshadowWarnings = useMemo(
    () => project.foreshadow.flatMap((entry) => {
      const missing: string[] = [];
      if (!entry.plantedInBlockId.trim()) missing.push("植込B");
      else if (!blockIds.includes(entry.plantedInBlockId)) missing.push("脚本にない植込B");
      if (!entry.paidOffInBlockId.trim()) missing.push("回収B");
      else if (!blockIds.includes(entry.paidOffInBlockId)) missing.push("脚本にない回収B");
      return missing.length > 0 ? [`${entry.id || "伏線番号が未設定"}: ${missing.join("・")}を確認してください。`] : [];
    }),
    [blockIds, project.foreshadow],
  );

  const [runningText, setRunningText] = useState<RunningText | null>(null);
  const [progress, setProgress] = useState<FilmTextTurnProgress>();
  const [assetFailure, setAssetFailure] = useState<AssetParseFailure | null>(null);
  const [assetRaw, setAssetRaw] = useState("");
  const [lookProposals, setLookProposals] = useState<[string, string] | null>(null);
  const [lookCandidates, setLookCandidates] = useState<LookCandidate[]>([]);
  const [generatingLooks, setGeneratingLooks] = useState(false);
  const [styleDraft, setStyleDraft] = useState(project.stylePrefix);
  const abortRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);
  const foreshadowInitializedForRef = useRef<string | null>(null);

  useEffect(() => {
    setAssetFailure(null);
    setAssetRaw("");
    setLookProposals(null);
    setLookCandidates([]);
    setStyleDraft(project.stylePrefix);
  }, [project.id]);

  useEffect(() => {
    setStyleDraft(project.stylePrefix);
  }, [project.stylePrefix]);

  useEffect(() => {
    if (foreshadowInitializedForRef.current === project.id) return;
    foreshadowInitializedForRef.current = project.id;
    if (!script || project.foreshadow.length > 0) return;
    const extracted = extractForeshadowLedger(script.blockScriptText ?? "");
    if (extracted.length > 0) saveForeshadow(extracted);
  }, [project.foreshadow.length, project.id, saveForeshadow, script]);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  async function runText(
    kind: RunningText,
    label: FilmTextTurnLabel,
    prompt: string,
  ): Promise<string | null> {
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunningText(kind);
    setProgress({ phase: "waiting", receivedChars: 0 });
    try {
      const raw = await runFilmTextTurn(prompt, {
        label,
        signal: abort.signal,
        onProgress: setProgress,
      });
      return runTokenRef.current === runToken ? raw.trim() : null;
    } catch (error) {
      if (runTokenRef.current !== runToken) return null;
      if (error instanceof FilmTextTurnAbortedError) {
        pushToast({ kind: "info", text: error.message, ttlMs: 3000 });
      } else {
        pushToast({
          kind: "error",
          text:
            error instanceof FilmTextTurnTimeoutError
              ? error.message
              : `${label}の作成に失敗しました: ${(error as Error)?.message ?? error}`,
          ttlMs: 7000,
        });
      }
      return null;
    } finally {
      if (runTokenRef.current === runToken) {
        setRunningText(null);
        setProgress(undefined);
        if (abortRef.current === abort) abortRef.current = null;
      }
    }
  }

  async function generateAssetLedger() {
    if (!scriptReady || !script) return;
    if (
      project.assets.length > 0 &&
      !window.confirm("いまの素材の一覧を、OK済みの脚本から作り直しますか？")
    ) {
      return;
    }
    const raw = await runText("assets", "素材の一覧", buildAssetLedgerPrompt({ script }));
    if (raw === null) return;
    setAssetRaw(raw);
    const parsed = parseAssetLedgerResponse(raw);
    if (!parsed.ok) {
      setAssetFailure(parsed);
      return;
    }
    setAssetFailure(null);
    saveAssets(parsed.value);
    pushToast({ kind: "success", text: `${parsed.value.length}件を素材の一覧に入れました。`, ttlMs: 3500 });
  }

  async function pickReferenceLook() {
    if (!scriptReady) return;
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!selected || Array.isArray(selected) || typeof selected !== "string") return;
      saveLookMaster(selected, "ユーザーが選んだお手本画像を、映像の見た目の決定版とする");
      pushToast({ kind: "success", text: "お手本画像を映像の見た目の決定版にしました。", ttlMs: 3000 });
    } catch (error) {
      pushToast({
        kind: "error",
        text: `お手本画像を選べませんでした: ${(error as Error)?.message ?? error}`,
        ttlMs: 6000,
      });
    }
  }

  async function generateLookChoices() {
    if (!scriptReady || !script) return;
    const raw = await runText(
      "look",
      "映像の見た目案",
      buildLookProposalPrompt({
        title: project.title,
        theme: project.theme,
        treatment: script.treatment,
      }),
    );
    if (raw === null) return;
    const proposals = parseLookProposals(raw);
    if (!proposals) {
      pushToast({
        kind: "warn",
        text: "映像の見た目案をA・Bに分けられませんでした。もう一度お試しください。",
        ttlMs: 6000,
      });
      return;
    }

    setLookProposals(proposals);
    setLookCandidates([]);
    setGeneratingLooks(true);
    try {
      const labels = ["A", "B"] as const;
      const results = await Promise.allSettled(
        proposals.map((proposal, index) =>
          images.generateBatch({
            prompt: buildLookImagePrompt({
              title: project.title,
              theme: project.theme,
              proposal,
            }),
            count: 1,
            aspect: "16:9",
            enforceAspect: true,
            maxAttempts: 1,
            sourceTag: `film-look-${project.id}-${labels[index]}`,
          }),
        ),
      );
      const candidates: LookCandidate[] = [];
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const path = result.value.generatedPaths[0];
        if (!path) return;
        candidates.push({ label: labels[index], description: proposals[index], path });
      });
      setLookCandidates(candidates);
      if (candidates.length < 2) {
        pushToast({
          kind: "warn",
          text: `映像の見た目候補は${candidates.length}枚できました。各案1枚の上限を守り、失敗分は自動で増やしていません。`,
          ttlMs: 7000,
        });
      }
    } catch (error) {
      pushToast({
        kind: "error",
        text: `映像の見た目画像を作れませんでした: ${(error as Error)?.message ?? error}`,
        ttlMs: 7000,
      });
    } finally {
      setGeneratingLooks(false);
    }
  }

  async function draftStylePrefix() {
    if (!script || !project.lookMasterPath) return;
    const raw = await runText(
      "style",
      "共通の見た目指定",
      buildStylePrefixPrompt({
        theme: project.theme,
        treatment: script.treatment,
        lookMasterPath: project.lookMasterPath,
        lookDescription: project.lookMasterDescription,
      }),
    );
    if (raw !== null) setStyleDraft(raw);
  }

  function updateAsset(index: number, patch: Partial<AssetLedgerEntry>) {
    saveAssets(project.assets.map((asset, assetIndex) => (assetIndex === index ? { ...asset, ...patch } : asset)));
  }

  function changeAssetType(index: number, type: AssetType) {
    const others = project.assets.filter((_, assetIndex) => assetIndex !== index);
    updateAsset(index, { type, id: nextAssetId(others, type) });
  }

  function addAsset() {
    const type: AssetType = "prop";
    saveAssets([
      ...project.assets,
      {
        id: nextAssetId(project.assets, type),
        name: "",
        type,
        importance: "primary",
        blockIds: blockIds.slice(0, 1),
        status: "unplanned",
        pairKey: null,
        pairSide: null,
        promptDraft: "",
        generatedImagePaths: [],
        lastGeneratedPrompt: null,
        canonicalImagePath: null,
        ngNotes: [],
        stressTest: null,
        locked: false,
      },
    ]);
  }

  function renumberAssetIds() {
    const numbered: AssetLedgerEntry[] = [];
    for (const asset of project.assets) {
      numbered.push({ ...asset, id: nextAssetId(numbered, asset.type) });
    }
    saveAssets(numbered);
  }

  function updateForeshadow(index: number, patch: Partial<ForeshadowEntry>) {
    saveForeshadow(
      project.foreshadow.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  }

  function addForeshadow() {
    saveForeshadow([
      ...project.foreshadow,
      {
        id: nextForeshadowId(project.foreshadow),
        description: "",
        initialMeaning: "",
        trueMeaning: "",
        plantedInBlockId: "",
        paidOffInBlockId: "",
      },
    ]);
  }

  const styleSaved = Boolean(
    project.stylePrefix.trim() && styleDraft.trim() === project.stylePrefix,
  );
  const namesReady = project.assets.length > 0 && project.assets.every((asset) => asset.name.trim());
  const assetsReady = namesReady && assetIssues.length === 0;
  const canComplete = Boolean(
    scriptReady && project.lookMasterPath?.trim() && styleSaved && assetsReady,
  );

  function completeDesign() {
    if (!canComplete || !approveLook()) {
      pushToast({
        kind: "warn",
        text: "映像の見た目の決定版・保存済みの共通指定・自動確認済みの素材一覧をそろえてください。",
        ttlMs: 5000,
      });
    }
  }

  function skipDetailedDesign() {
    if (!scriptReady) {
      pushToast({ kind: "warn", text: "先に②脚本でブロック台本をOKしてください。", ttlMs: 4000 });
      return;
    }
    if (!window.confirm("見た目や素材を作り込まず、おまかせの共通指定で先へ進みますか？")) {
      return;
    }
    if (!approveLookLenient()) {
      pushToast({ kind: "warn", text: "先に②脚本でブロック台本をOKしてください。", ttlMs: 4000 });
    }
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">③ 設計</p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">作る前に、必要なものを全部書く</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          今から映像の見た目と必要な素材を決めます。ここで書くと、人物・場所・小物の食い違いを先に防げます。
        </p>
      </div>

      {!scriptReady ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4 text-sm text-amber-100">
          ②の動画1回分ずつの台本をOKにすると、この設計工程を始められます。
        </div>
      ) : null}

      <section className="rounded-xl border border-[#292929] bg-[#171717] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-pink-400">設計 1/4</p>
            <h3 className="mt-1 text-lg font-semibold text-zinc-100">素材の一覧（登場人物・場所・小物）</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              今から、必要な人物・場所・文字入りの物・小道具を、OK済みの台本すべてから拾います。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void generateAssetLedger()}
            disabled={!scriptReady || Boolean(runningText) || generatingLooks || project.assets.some((asset) => asset.locked)}
            className="rounded-md bg-pink-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {project.assets.length > 0 ? "一覧を作り直す" : "一覧を作る"}
          </button>
        </div>

        {runningText === "assets" ? (
          <TextProgressCard label="素材の一覧" progress={progress} onCancel={() => abortRef.current?.abort()} />
        ) : null}
        {assetFailure ? <AssetParseErrorCard failure={assetFailure} raw={assetRaw} /> : null}

        {project.assets.length > 0 ? (
          <div className="mt-5 min-w-0 overflow-x-auto">
            <table className="min-w-[1060px] w-full border-separate border-spacing-0 text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">管理番号</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">名称</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">種類</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">大切さ</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">使う動画番号</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">同じ物の組</th>
                  <th className="border-b border-[#303030] px-2 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {project.assets.map((asset, index) => (
                  <tr key={`${asset.id}-${index}`} className="text-zinc-200">
                    <td className="border-b border-[#252525] px-2 py-2 font-mono text-zinc-400">{asset.id}</td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <input
                        value={asset.name}
                        disabled={asset.locked}
                        onChange={(event) => updateAsset(index, { name: event.target.value })}
                        className="h-9 w-48 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500"
                      />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <select
                        value={asset.type}
                        disabled={asset.locked}
                        onChange={(event) => changeAssetType(index, event.target.value as AssetType)}
                        className="h-9 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500"
                      >
                        {(Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map((type) => (
                          <option key={type} value={type}>{ASSET_TYPE_LABELS[type]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <select
                        value={asset.importance}
                        disabled={asset.locked}
                        onChange={(event) => updateAsset(index, { importance: event.target.value as AssetImportance })}
                        className="h-9 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500"
                      >
                        {(Object.keys(IMPORTANCE_LABELS) as AssetImportance[]).map((importance) => (
                          <option key={importance} value={importance}>{IMPORTANCE_LABELS[importance]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <BlockIdListInput
                        blockIds={asset.blockIds}
                        disabled={asset.locked}
                        placeholder={blockIds.join(", ")}
                        onCommit={(nextBlockIds) => updateAsset(index, { blockIds: nextBlockIds })}
                      />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <div className="flex gap-1.5">
                        <input
                          value={asset.pairKey ?? ""}
                          disabled={asset.locked}
                          onChange={(event) => updateAsset(index, { pairKey: event.target.value || null })}
                          placeholder="組名"
                          className="h-9 w-24 rounded border border-[#303030] bg-[#111111] px-2 outline-none placeholder:text-zinc-700 focus:border-pink-500"
                        />
                        <select
                          value={asset.pairSide ?? ""}
                          disabled={asset.locked}
                          onChange={(event) => updateAsset(index, { pairSide: (event.target.value || null) as AssetPairSide })}
                          className="h-9 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500"
                        >
                          <option value="">なし</option>
                          <option value="①">①</option>
                          <option value="②">②</option>
                        </select>
                      </div>
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <button
                        type="button"
                        disabled={asset.locked}
                        onClick={() => saveAssets(project.assets.filter((_, assetIndex) => assetIndex !== index))}
                        className="rounded px-2 py-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-5 rounded-lg border border-dashed border-[#303030] px-4 py-5 text-center text-xs text-zinc-600">
            まだ一覧はありません。AIで拾い出すか、自分で1行追加してください。
          </p>
        )}

        <button
          type="button"
          onClick={addAsset}
          disabled={!scriptReady}
          className="mt-3 rounded-md border border-[#3a3a3a] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-[#242424] disabled:opacity-40"
        >
          行を追加
        </button>
        <button
          type="button"
          onClick={renumberAssetIds}
          disabled={project.assets.length === 0 || project.assets.some((asset) => asset.locked)}
          className="ml-2 mt-3 rounded-md border border-[#3a3a3a] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-[#242424] disabled:opacity-40"
        >
          管理番号を自動で振り直す
        </button>
        <p className="mt-3 text-[11px] leading-5 text-zinc-500">
          同じ物の別状態は①②でそろえます。片方だけ作ると、伏線の回収が壊れます。
        </p>
        {project.assets.some((asset) => asset.locked) ? (
          <p className="mt-2 text-[11px] leading-5 text-amber-200">
            確定済みの行は編集・削除・管理番号の振り直しができません。変える場合は、その素材を使った画像や映像を全部作り直す必要があります。
          </p>
        ) : null}

        {assetIssues.length > 0 || pairWarnings.length > 0 ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-semibold text-amber-200">素材一覧の自動確認</p>
            <ul className="mt-2 grid gap-1 text-xs leading-5 text-amber-100/90">
              {assetIssues.map((issue, index) => <li key={`${issue.code}-${issue.location}-${index}`}>・{issue.message}</li>)}
              {pairWarnings.map((warning) => <li key={warning}>・{warning}</li>)}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-[#292929] bg-[#171717] p-5">
        <div>
          <p className="text-xs font-semibold text-pink-400">設計 2/4</p>
          <h3 className="mt-1 text-lg font-semibold text-zinc-100">伏線の一覧</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            今から伏線番号を並べます。最初の見え方と、本当の意味を明かす場所を決めるためです。
          </p>
        </div>

        {project.foreshadow.length > 0 ? (
          <div className="mt-5 min-w-0 overflow-x-auto">
            <table className="min-w-[1080px] w-full border-separate border-spacing-0 text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  {["伏線番号", "伏線", "最初に見える意味", "本当の意味", "最初に出す動画", "意味を明かす動画", "操作"].map((label) => (
                    <th key={label} className="border-b border-[#303030] px-2 py-2 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {project.foreshadow.map((entry, index) => (
                  <tr key={`${entry.id}-${index}`} className="text-zinc-200">
                    <td className="border-b border-[#252525] px-2 py-2">
                      <input value={entry.id} onChange={(event) => updateForeshadow(index, { id: event.target.value.toUpperCase() })} className="h-9 w-16 rounded border border-[#303030] bg-[#111111] px-2 font-mono outline-none focus:border-pink-500" />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <input value={entry.description} onChange={(event) => updateForeshadow(index, { description: event.target.value })} className="h-9 w-52 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500" />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <input value={entry.initialMeaning ?? ""} onChange={(event) => updateForeshadow(index, { initialMeaning: event.target.value })} className="h-9 w-52 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500" />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <input value={entry.trueMeaning ?? ""} onChange={(event) => updateForeshadow(index, { trueMeaning: event.target.value })} className="h-9 w-52 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500" />
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <select value={entry.plantedInBlockId} onChange={(event) => updateForeshadow(index, { plantedInBlockId: event.target.value })} className="h-9 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500">
                        <option value="">未設定</option>
                        {blockIds.map((blockId) => <option key={blockId} value={blockId}>{blockId}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <select value={entry.paidOffInBlockId} onChange={(event) => updateForeshadow(index, { paidOffInBlockId: event.target.value })} className="h-9 rounded border border-[#303030] bg-[#111111] px-2 outline-none focus:border-pink-500">
                        <option value="">未設定</option>
                        {blockIds.map((blockId) => <option key={blockId} value={blockId}>{blockId}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-[#252525] px-2 py-2">
                      <button type="button" onClick={() => saveForeshadow(project.foreshadow.filter((_, entryIndex) => entryIndex !== index))} className="rounded px-2 py-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300">削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-5 rounded-lg border border-dashed border-[#303030] px-4 py-5 text-center text-xs text-zinc-600">
            脚本に伏線番号がない場合は、空のままで大丈夫です。
          </p>
        )}
        <button type="button" onClick={addForeshadow} disabled={!scriptReady} className="mt-3 rounded-md border border-[#3a3a3a] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-[#242424] disabled:opacity-40">伏線を追加</button>
        {foreshadowWarnings.length > 0 ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-semibold text-amber-200">植込と回収の対応を確認してください</p>
            <ul className="mt-2 grid gap-1 text-xs text-amber-100/90">
              {foreshadowWarnings.map((warning) => <li key={warning}>・{warning}</li>)}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-[#292929] bg-[#171717] p-5">
        <div>
          <p className="text-xs font-semibold text-pink-400">設計 3/4</p>
          <h3 className="mt-1 text-lg font-semibold text-zinc-100">映像の見た目を決める</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            今から色や雰囲気のお手本を決めます。おすすめはお手本画像を1枚選ぶ方法です。
          </p>
        </div>

        {project.lookMasterPath ? (
          <div className="mt-5 grid gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 md:grid-cols-[220px_1fr]">
            <SafeImage path={project.lookMasterPath} alt="決めた映像の見た目" className="aspect-video w-full rounded-lg bg-black object-contain" />
            <div className="min-w-0 self-center">
              <p className="text-xs font-semibold text-emerald-300">映像の見た目の決定版</p>
              <p className="mt-2 truncate text-sm text-zinc-200">{basename(project.lookMasterPath)}</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{project.lookMasterDescription || "この一枚を、すべての場面の見た目の決定版にします。"}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-pink-500/40 bg-pink-500/5 p-4">
            <p className="text-sm font-semibold text-pink-200">A. お手本画像を1枚選ぶ</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">手元に近い雰囲気の画像がある場合はこちらがおすすめです。</p>
            <button type="button" onClick={() => void pickReferenceLook()} disabled={!scriptReady || Boolean(runningText) || generatingLooks} className="mt-4 rounded-md bg-pink-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:opacity-40">画像を選ぶ</button>
          </div>
          <div className="rounded-lg border border-[#303030] bg-[#141414] p-4">
            <p className="text-sm font-semibold text-zinc-200">B. AIに2案作らせる</p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">案A・案Bを各1枚だけ作り、並べて選びます。</p>
            <button type="button" onClick={() => void generateLookChoices()} disabled={!scriptReady || Boolean(runningText) || generatingLooks} className="mt-4 rounded-md border border-[#3a3a3a] px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-[#242424] disabled:opacity-40">
              {generatingLooks ? "各案を1枚ずつ作成中" : "2案を作る"}
            </button>
          </div>
        </div>

        {runningText === "look" ? <TextProgressCard label="映像の見た目案" progress={progress} onCancel={() => abortRef.current?.abort()} /> : null}
        {generatingLooks ? (
          <div className="mt-4 rounded-lg border border-[#303030] bg-[#141414] px-4 py-3 text-xs text-zinc-400">案A・案Bを各1枚だけ作っています。失敗しても自動で作り直しません。</div>
        ) : null}
        {lookProposals && lookCandidates.length > 0 ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {lookCandidates.map((candidate) => (
              <button key={candidate.label} type="button" onClick={() => saveLookMaster(candidate.path, candidate.description)} className="overflow-hidden rounded-xl border border-[#303030] bg-[#111111] text-left transition hover:border-pink-500/70 hover:bg-pink-500/5">
                <SafeImage path={candidate.path} alt={`映像の見た目案${candidate.label}`} className="aspect-video w-full bg-black object-contain" />
                <span className="block p-4">
                  <span className="text-sm font-semibold text-pink-300">案{candidate.label}を選ぶ</span>
                  <span className="mt-1 block text-xs leading-5 text-zinc-400">{candidate.description}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-[#292929] bg-[#171717] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-pink-400">設計 4/4</p>
            <h3 className="mt-1 text-lg font-semibold text-zinc-100">共通の見た目指定</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">今から、動画を作る指示文の最後へ毎回付ける共通文を決めます。映像全体の見た目をそろえるためです。</p>
          </div>
          <button type="button" onClick={() => void draftStylePrefix()} disabled={!project.lookMasterPath || Boolean(runningText) || generatingLooks} className="rounded-md border border-[#3a3a3a] px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-[#242424] disabled:cursor-not-allowed disabled:opacity-40">下書きする</button>
        </div>
        <p className="mt-3 text-xs font-medium text-amber-200">色は生成で追わない（色の指定はここに入れず、仕上げで一括調整）</p>
        {runningText === "style" ? <TextProgressCard label="共通の見た目指定" progress={progress} onCancel={() => abortRef.current?.abort()} /> : null}
        <textarea value={styleDraft} onChange={(event) => setStyleDraft(event.target.value)} rows={7} placeholder="映像の見た目を決めたあとに「下書きする」を押すと、ここに共通文が入ります。" className="mt-4 w-full resize-y rounded-lg border border-[#303030] bg-[#111111] px-4 py-3 text-sm leading-6 text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-pink-500 focus:ring-1 focus:ring-pink-500/30" />
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={() => {
            const trimmed = styleDraft.trim();
            if (!trimmed) return;
            saveStylePrefix(trimmed);
            setStyleDraft(trimmed);
            pushToast({ kind: "success", text: "共通の見た目指定を保存しました。", ttlMs: 3000 });
          }} disabled={!styleDraft.trim() || styleSaved} className="rounded-md bg-pink-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400">保存</button>
          <span className={styleSaved ? "text-xs text-emerald-300" : "text-xs text-zinc-600"}>{styleSaved ? "保存済み" : "未保存の変更があります"}</span>
        </div>
      </section>

      <section className="rounded-xl border border-[#303030] bg-[#141414] p-5">
        <h3 className="text-sm font-semibold text-zinc-100">④へ進む前の確認</h3>
        <ul className="mt-3 grid gap-2 text-xs">
          <StatusLine ok={Boolean(project.lookMasterPath?.trim())}>映像の見た目を決定済み</StatusLine>
          <StatusLine ok={styleSaved}>共通の見た目指定を保存済み</StatusLine>
          <StatusLine ok={assetsReady}>素材が1件以上あり、自動確認のエラーなし</StatusLine>
        </ul>
        <p className="mt-3 text-[11px] leading-5 text-zinc-500">素材の一覧を書き切るまでは画像づくりへ進みません。先に文の上で食い違いを止めるためです。</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={completeDesign} disabled={!canComplete} className="rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400">④素材づくりへ進む</button>
          <button type="button" onClick={skipDetailedDesign} disabled={!scriptReady} className="rounded-md border border-[#3a3a3a] px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-pink-500/50 disabled:cursor-not-allowed disabled:opacity-40">作り込みなしで進む（おまかせ）</button>
        </div>
      </section>
    </div>
  );
}
