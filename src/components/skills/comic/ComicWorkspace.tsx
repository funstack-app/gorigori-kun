import { useEffect, useMemo, useRef, useState } from "react";

import { images } from "../../../lib/ipc";
import { runComicTextTurn } from "../../../lib/comic/codexText";
import {
  buildNamePrompt,
  buildPanelImagePrompt,
  parseComicName,
} from "../../../lib/comic/prompts";
import type {
  ComicCharacter,
  ComicFormat,
  ComicPanel,
  ComicPanelResult,
  ComicPhase,
} from "../../../lib/comic/types";
import { presetKind, usePresets } from "../../../lib/store/presets";
import { selectCharacterReferences } from "../../../lib/presets/character";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useImages } from "../../../lib/store/images";
import { useProjects } from "../../../lib/store/projects";
import { useToasts } from "../../../lib/store/toasts";
import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { SafeImage } from "../../SafeImage";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { beginDirectRun } from "../../../lib/store/generationStatus";

/**
 * 漫画制作 Workspace（スキル一覧v2.1 #9・MVP）
 *
 * 話 → ネーム（コマ割り+セリフ）→ 登録キャラ固定でコマ生成 → ページ確認、の
 * 専用ワークスペース。写植・吹き出し合成は MVP 対象外（将来課題として表示のみ）。
 *
 * 工程（ComicPhase）:
 *   1. input   — あらすじ + 形式(4/8コマ) + 登場キャラ(プリセット)を入力
 *   2. name    — AI がネームを JSON 生成。コマごとに人が構図/セリフ/プロンプトを直す（工程の要）
 *   3. panels  — 各コマのプロンプト＋キャラ参照画像で画像生成（images.generateBatch）
 *   4. preview — 生成済みコマを縦組みで並べる簡易ページプレビュー
 *
 * SkillWorkspaceRouter が activeUiMode === "comic" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function ComicWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ComicFlow />
      </div>
    </section>
  );
}

const PHASE_LABELS: Record<ComicPhase, string> = {
  input: "1. 話とキャラ",
  name: "2. ネーム確認",
  panels: "3. コマ生成",
  preview: "4. ページ確認",
};

function ComicFlow() {
  const presets = usePresets((s) => s.presets);
  const pushToast = useToasts((s) => s.push);

  const characterPresets = useMemo(
    () => presets.filter((p) => presetKind(p) === "character"),
    [presets],
  );

  const [phase, setPhase] = useState<ComicPhase>("input");
  const [synopsis, setSynopsis] = useState("");
  const [format, setFormat] = useState<ComicFormat>(4);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [panels, setPanels] = useState<ComicPanel[]>([]);
  const [results, setResults] = useState<ComicPanelResult[]>([]);
  const [generatingName, setGeneratingName] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const runTokenRef = useRef(0);
  /** 全コマ生成中に右上パネルへ進捗を報告するためのトラッカー。 */
  const comicTrackRef = useRef<ReturnType<typeof beginDirectRun> | null>(null);

  useEffect(
    () => () => {
      runTokenRef.current += 1;
    },
    [],
  );

  // 選択されたキャラプリセットを ComicCharacter に変換
  const characters = useMemo<ComicCharacter[]>(() => {
    return selectedIds
      .map((id) => characterPresets.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({
        presetId: p.id,
        name: p.name,
        attributes: p.characterMeta?.attributes,
        // キャラ参照は速度対策で既定3枚に絞る (selectCharacterReferences)。
        referenceImagePaths: selectCharacterReferences(p).map((r) => r.path),
      }));
  }, [selectedIds, characterPresets]);

  const toggleCharacter = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const generateName = async () => {
    if (!synopsis.trim()) {
      pushToast({ kind: "error", text: "話（あらすじ）を入力してください", ttlMs: 4000 });
      return;
    }
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    setGeneratingAll(false);
    setResults((prev) => prev.map((result) => ({ ...result, generating: false })));
    setGeneratingName(true);
    try {
      const prompt = buildNamePrompt(synopsis, format, characters);
      const raw = await runComicTextTurn(prompt);
      if (runTokenRef.current !== runToken) return;
      const parsed = parseComicName(raw);
      if (!parsed) {
        pushToast({
          kind: "error",
          text: "ネームの JSON を取得できませんでした。もう一度お試しください。",
          ttlMs: 6000,
        });
        return;
      }
      setPanels(parsed);
      setResults(parsed.map((p) => ({ index: p.index, generating: false })));
      setPhase("name");
    } catch (err) {
      if (runTokenRef.current !== runToken) return;
      pushToast({
        kind: "error",
        text: `ネーム生成に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      if (runTokenRef.current === runToken) setGeneratingName(false);
    }
  };

  const updatePanel = (index: number, patch: Partial<ComicPanel>) => {
    setPanels((prev) => prev.map((p) => (p.index === index ? { ...p, ...patch } : p)));
  };

  const generatePanel = async (panel: ComicPanel, batchToken?: number) => {
    if (batchToken === undefined && generatingAll) return;
    const runToken = batchToken ?? runTokenRef.current;
    if (runTokenRef.current !== runToken) return;
    setResults((prev) =>
      prev.map((r) =>
        r.index === panel.index ? { ...r, generating: true, error: undefined } : r,
      ),
    );
    comicTrackRef.current?.markStarted();
    try {
      const prompt = buildPanelImagePrompt(panel, characters);
      // このコマに登場するキャラの参照画像を集める
      const refPaths = characters
        .filter((c) => panel.characters.some((n) => n.trim() === c.name.trim()))
        .flatMap((c) => c.referenceImagePaths);
      const res = await images.generateBatch({
        prompt,
        count: 1,
        refImagePaths: refPaths.length > 0 ? refPaths : undefined,
      });
      if (runTokenRef.current !== runToken) return;
      const imagePath = res.generatedPaths[0];
      if (!imagePath) {
        throw new Error(res.errors[0] ?? "画像が生成されませんでした");
      }
      setResults((prev) =>
        prev.map((r) =>
          r.index === panel.index ? { ...r, generating: false, imagePath } : r,
        ),
      );
      comicTrackRef.current?.markCompleted();
    } catch (err) {
      if (runTokenRef.current !== runToken) return;
      const message = (err as Error)?.message ?? String(err);
      setResults((prev) =>
        prev.map((r) =>
          r.index === panel.index
            ? { ...r, generating: false, error: message }
            : r,
        ),
      );
      comicTrackRef.current?.fail(message);
      pushToast({
        kind: "error",
        text: `コマ ${panel.index} の生成に失敗しました`,
        ttlMs: 5000,
      });
    }
  };

  const generateAllPanels = async () => {
    if (generatingAll || results.some((result) => result.generating)) return;
    const runToken = runTokenRef.current;
    setGeneratingAll(true);
    // 右上の生成状況パネルへ全体の進捗を出す (2026-07-25 STΛCK指示)。
    // 逐次生成なので「何コマ目か」が分かることが体感に直結する。
    // 各コマの成否は generatePanel 側から直接 track へ報告する。
    const track = beginDirectRun("comic", panels.length);
    comicTrackRef.current = track;
    try {
      for (const panel of panels) {
        if (runTokenRef.current !== runToken) return;
        // 逐次生成（並列にすると CODEX_HOME / セマフォ競合の懸念があるため MVP は直列）
        await generatePanel(panel, runToken);
      }
    } finally {
      track.done();
      comicTrackRef.current = null;
      if (runTokenRef.current === runToken) setGeneratingAll(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 text-neutral-200">
      <PhaseNav phase={phase} setPhase={setPhase} hasPanels={panels.length > 0} />

      {phase === "input" && (
        <InputPhase
          synopsis={synopsis}
          setSynopsis={setSynopsis}
          format={format}
          setFormat={setFormat}
          characterPresets={characterPresets}
          selectedIds={selectedIds}
          toggleCharacter={toggleCharacter}
          generatingName={generatingName}
          onGenerate={generateName}
        />
      )}

      {phase === "name" && (
        <NamePhase panels={panels} updatePanel={updatePanel} onNext={() => setPhase("panels")} />
      )}

      {phase === "panels" && (
        <PanelsPhase
          panels={panels}
          results={results}
          onGeneratePanel={generatePanel}
          onGenerateAll={generateAllPanels}
          onPreview={() => setPhase("preview")}
          generatingAll={generatingAll}
        />
      )}

      {phase === "preview" && (
        <PreviewPhase format={format} panels={panels} results={results} />
      )}
    </div>
  );
}

function PhaseNav({
  phase,
  setPhase,
  hasPanels,
}: {
  phase: ComicPhase;
  setPhase: (p: ComicPhase) => void;
  hasPanels: boolean;
}) {
  const order: ComicPhase[] = ["input", "name", "panels", "preview"];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {order.map((p) => {
        const disabled = p !== "input" && !hasPanels;
        const active = p === phase;
        return (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => setPhase(p)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
              active
                ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:border-[#3a3a3a] hover:text-neutral-200"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {PHASE_LABELS[p]}
          </button>
        );
      })}
    </div>
  );
}

function InputPhase({
  synopsis,
  setSynopsis,
  format,
  setFormat,
  characterPresets,
  selectedIds,
  toggleCharacter,
  generatingName,
  onGenerate,
}: {
  synopsis: string;
  setSynopsis: (v: string) => void;
  format: ComicFormat;
  setFormat: (v: ComicFormat) => void;
  characterPresets: ReturnType<typeof usePresets.getState>["presets"];
  selectedIds: string[];
  toggleCharacter: (id: string) => void;
  generatingName: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          話（あらすじ）
        </label>
        <textarea
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
          rows={5}
          placeholder="どんな話にする？ ざっくりでOK（例: 遅刻しそうな主人公が近道でトラブルに巻き込まれる）"
          className="w-full resize-y rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">形式</label>
        <div className="flex gap-2">
          {([4, 8] as ComicFormat[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                format === f
                  ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                  : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {f}コマ
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          登場キャラ（登録キャラから複数選択可）
        </label>
        {characterPresets.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-3 text-xs text-neutral-500">
            登録キャラがありません。キャラを登録すると、同一キャラでコマを生成できます（キャラなしでも話は作れます）。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {characterPresets.map((p) => {
              const selected = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleCharacter(p.id)}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${
                    selected
                      ? "border-indigo-500 bg-indigo-500/20 text-indigo-100"
                      : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-[#3a3a3a]"
                  }`}
                >
                  {p.thumbnail && (
                    <img src={p.thumbnail} alt="" className="h-6 w-6 rounded object-cover" />
                  )}
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generatingName || !synopsis.trim()}
          className="flex items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generatingName && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-transparent" />
          )}
          {generatingName ? "ネーム生成中…" : "ネームを生成"}
        </button>
      </div>
    </div>
  );
}

function NamePhase({
  panels,
  updatePanel,
  onNext,
}: {
  panels: ComicPanel[];
  updatePanel: (index: number, patch: Partial<ComicPanel>) => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500">
        コマごとに構図・セリフ・生成プロンプトを直せます。ここで直したものがコマ生成に使われます。
      </p>
      {panels.map((panel) => (
        <div key={panel.index} className="rounded-md border border-[#2a2a2a] bg-[#181818] p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs font-semibold text-indigo-200">
              コマ {panel.index}
            </span>
            {panel.characters.length > 0 && (
              <span className="text-xs text-neutral-500">
                登場: {panel.characters.join("、")}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="構図・カメラ">
              <input
                value={panel.composition}
                onChange={(e) => updatePanel(panel.index, { composition: e.target.value })}
                className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
              />
            </Field>
            <Field label="演技・表情">
              <input
                value={panel.acting}
                onChange={(e) => updatePanel(panel.index, { acting: e.target.value })}
                className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
              />
            </Field>
          </div>

          <Field label="セリフ" className="mt-2">
            <textarea
              value={panel.dialogue}
              onChange={(e) => updatePanel(panel.index, { dialogue: e.target.value })}
              rows={2}
              className="w-full resize-y rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
            />
          </Field>

          <Field label="生成プロンプト" className="mt-2">
            <textarea
              value={panel.prompt}
              onChange={(e) => updatePanel(panel.index, { prompt: e.target.value })}
              rows={2}
              className="w-full resize-y rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
            />
          </Field>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={onNext}
          className="rounded-md border border-indigo-500 bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
        >
          コマ生成へ進む
        </button>
      </div>
    </div>
  );
}

function PanelsPhase({
  panels,
  results,
  onGeneratePanel,
  onGenerateAll,
  onPreview,
  generatingAll,
}: {
  panels: ComicPanel[];
  results: ComicPanelResult[];
  onGeneratePanel: (panel: ComicPanel) => void;
  onGenerateAll: () => void;
  onPreview: () => void;
  generatingAll: boolean;
}) {
  const anyGenerating = generatingAll || results.some((r) => r.generating);
  const anyDone = results.some((r) => r.imagePath);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onGenerateAll}
          disabled={anyGenerating}
          className="flex items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {anyGenerating && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-transparent" />
          )}
          {anyGenerating
            ? `生成中… (${results.filter((r) => r.imagePath).length}/${panels.length})`
            : "全コマ生成"}
        </button>
        <button
          type="button"
          onClick={onPreview}
          disabled={!anyDone}
          className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-neutral-200 transition hover:border-[#3a3a3a] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ページ確認へ
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {panels.map((panel) => {
          const result = results.find((r) => r.index === panel.index);
          return (
            <div
              key={panel.index}
              className="flex flex-col gap-1.5 rounded-md border border-[#2a2a2a] bg-[#181818] p-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-indigo-200">コマ {panel.index}</span>
                <button
                  type="button"
                  onClick={() => onGeneratePanel(panel)}
                  disabled={generatingAll || result?.generating}
                  className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-neutral-300 transition hover:border-indigo-500 disabled:opacity-40"
                >
                  {result?.generating ? "…" : result?.imagePath ? "再生成" : "生成"}
                </button>
              </div>
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-[#0f0f0f]">
                {result?.generating ? (
                  <span className="flex flex-col items-center gap-1.5 text-[11px] text-neutral-500">
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500/40 border-t-indigo-300" />
                    生成中…
                  </span>
                ) : result?.imagePath ? (
                  <SafeImage
                    path={result.imagePath}
                    alt={`コマ ${panel.index}`}
                    className="h-full w-full object-contain"
                  />
                ) : result?.error ? (
                  <span className="px-1 text-center text-[11px] text-rose-400">失敗</span>
                ) : (
                  <span className="text-[11px] text-neutral-600">未生成</span>
                )}
              </div>
              {panel.dialogue.trim() && (
                <p className="line-clamp-2 text-[11px] text-neutral-400">{panel.dialogue}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PreviewPhase({
  format,
  panels,
  results,
}: {
  format: ComicFormat;
  panels: ComicPanel[];
  results: ComicPanelResult[];
}) {
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const downloadAs = useImages((s) => s.downloadAs);
  const pushToast = useToasts((s) => s.push);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const completedResults = results.filter(
    (result): result is ComicPanelResult & { imagePath: string } =>
      Boolean(result.imagePath),
  );

  function savePanelToProject(panel: ComicPanel, imagePath?: string) {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    if (!imagePath) return;
    addItem(activeProjectId, {
      imagePath,
      note: `漫画: コマ ${panel.index}`,
    });
    pushToast({
      kind: "success",
      text: `コマ ${panel.index} を ${activeProject?.name ?? "プロジェクト"} に保存しました。`,
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
    for (const result of completedResults) {
      addItem(activeProjectId, {
        imagePath: result.imagePath,
        note: `漫画: コマ ${result.index}`,
      });
    }
    pushToast({
      kind: completedResults.length > 0 ? "success" : "info",
      text:
        completedResults.length > 0
          ? `${completedResults.length} コマを ${activeProject?.name ?? "プロジェクト"} に保存しました。`
          : "保存できるコマがまだありません。",
      ttlMs: 3000,
    });
  }

  async function savePanelToLocal(panel: ComicPanel, imagePath?: string) {
    if (!imagePath) return;
    const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
    try {
      const dest = await downloadAs(imagePath, `comic-p${panel.index}.${ext}`);
      if (!dest) return;
      pushToast({
        kind: "success",
        text: `コマ ${panel.index} をローカルに保存しました。`,
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

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        吹き出し・写植（セリフの画像合成）は今後対応します。現状はコマの下にセリフをテキスト表示します。
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">{format}コマの縦組みプレビュー</p>
        <button
          type="button"
          onClick={saveAllToProject}
          disabled={completedResults.length === 0}
          className="rounded-md border border-indigo-500 bg-indigo-500/20 px-3 py-1.5 text-xs font-semibold text-indigo-100 transition hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          全コマをプロジェクトに保存
        </button>
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-4">
        {panels.map((panel) => {
          const result = results.find((r) => r.index === panel.index);
          return (
            <div key={panel.index} className="flex flex-col gap-1.5">
              <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded border border-[#242424] bg-[#161616]">
                {result?.imagePath ? (
                  <SafeImage
                    path={result.imagePath}
                    alt={`コマ ${panel.index}`}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-[11px] text-neutral-600">
                    コマ {panel.index}（未生成）
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => savePanelToProject(panel, result?.imagePath)}
                  disabled={!result?.imagePath}
                  className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-indigo-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  プロジェクトに保存
                </button>
                <button
                  type="button"
                  onClick={() => void savePanelToLocal(panel, result?.imagePath)}
                  disabled={!result?.imagePath}
                  className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-emerald-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ローカルに保存
                </button>
              </div>
              {panel.dialogue.trim() && (
                <p className="whitespace-pre-wrap rounded bg-[#1a1a1a] px-2 py-1 text-xs text-neutral-200">
                  {panel.dialogue}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <span className="mb-1 block text-[11px] font-medium text-neutral-500">{label}</span>
      {children}
    </div>
  );
}
