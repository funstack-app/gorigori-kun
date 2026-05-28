import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { higgsfield } from "../lib/ipc";
import { useVideoSceneGeneration } from "../lib/scene/useVideoSceneGeneration";
import { useComposer } from "../lib/store/composer";
import { useVideoGen } from "../lib/store/videoGen";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";
import { VIDEO_MODELS, type VideoModelDefinition } from "../lib/videoModels";
import type { Preset } from "../lib/store/presets";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { SkillPickerPopover } from "./SkillPickerPopover";
import { PromptTextareaWithMentions } from "./PromptTextareaWithMentions";
import { ElementwisePromptModal } from "./ElementwisePromptModal";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { ReferencePicker } from "./ReferencePicker";
import { StockSearchModal } from "./StockSearchModal";

type CostState =
  | { kind: "idle"; value: number | null; source: "api" | "static" | null }
  | { kind: "loading"; value: number | null; source: "api" | "static" | null }
  | { kind: "error"; value: number | null; source: "static" | null };

/**
 * 画像版 ConstructedPromptPanel の動画版。
 * 構成は画像タブと統一する:
 *   [ReferenceRack: ライブラリ/素材/追加/プリセット/スキル]
 *   [要素別編集ボタン + プロンプト textarea]
 *   [下部コントロール: モデル / 尺± / 比率 / Cost / 生成ボタン]
 *
 * 画像版との違い:
 * - 生成ロジックは useVideoSceneGeneration (mediaType=video)
 * - モデル/尺/比率は VIDEO_MODELS 静的定義 + useVideoGen を使う
 *   (動画モデルは Higgsfield の動的 model/list ではなく静的定義が正)
 */
export function VideoConstructedPromptPanel() {
  const {
    generatedPrompt,
    model,
    promptOverride,
    setPromptOverride,
    effectivePrompt,
    status,
    hasRunningBatch,
    runningBatchCount,
    maxConcurrentBatches,
    isQueueFull,
    activeBatchSummary,
    disabled,
    generate,
  } = useVideoSceneGeneration();

  const [draft, setDraft] = useState<string>(generatedPrompt);
  const [elementModalOpen, setElementModalOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetAnchor, setPresetAnchor] = useState<DOMRect | null>(null);
  const presetButtonRef = useRef<HTMLButtonElement | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillAnchor, setSkillAnchor] = useState<DOMRect | null>(null);
  const skillButtonRef = useRef<HTMLButtonElement | null>(null);

  const references = useComposer((s) => s.references);
  const addReference = useComposer((s) => s.addReference);
  const removeReference = useComposer((s) => s.removeReference);

  const setModel = useVideoGen((s) => s.setModel);
  const duration = useVideoGen((s) => s.duration);
  const setDuration = useVideoGen((s) => s.setDuration);
  const aspectRatio = useVideoGen((s) => s.aspectRatio);
  const setAspectRatio = useVideoGen((s) => s.setAspectRatio);

  const isOverriding = promptOverride !== null;

  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    const next = current ? `${current}, ${preset.prompt}` : preset.prompt;
    onChangeDraft(next);
    if (preset.attachedImages && preset.attachedImages.length > 0) {
      const refs = preset.attachedImages.map((img) => ({
        path: img.path,
        name: img.path.split(/[\\/]/).pop() || "preset image",
        source: "gallery" as const,
        role: img.role as never,
      }));
      useComposer.getState().addReferences(refs);
    }
  };

  const openPreset = () => {
    if (presetButtonRef.current) {
      setPresetAnchor(presetButtonRef.current.getBoundingClientRect());
    }
    setPresetOpen(true);
  };

  const openSkill = () => {
    if (skillButtonRef.current) {
      setSkillAnchor(skillButtonRef.current.getBoundingClientRect());
    }
    setSkillOpen(true);
  };

  useEffect(() => {
    if (promptOverride === null) {
      setDraft(generatedPrompt);
    } else if (promptOverride !== draft) {
      setDraft(promptOverride);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedPrompt, promptOverride]);

  useEffect(() => {
    if (promptOverride !== null && promptOverride !== generatedPrompt) {
      setPromptOverride(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedPrompt]);

  const onChangeDraft = (next: string) => {
    setDraft(next);
    setPromptOverride(next === generatedPrompt ? null : next);
  };

  const onResetOverride = () => {
    setPromptOverride(null);
    setDraft(generatedPrompt);
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(effectivePrompt);
    } catch {
      // ignore
    }
  };

  // Cost 見積もり (画像版 VideoInputPanel と同じ debounce 350ms)。
  const [cost, setCost] = useState<CostState>({
    kind: "idle",
    value: model.costEstimate,
    source: "static",
  });
  useEffect(() => {
    let cancelled = false;
    const fallback = model.costEstimate;
    const prompt = effectivePrompt.trim();
    if (!prompt) {
      setCost({ kind: "idle", value: fallback, source: "static" });
      return () => {
        cancelled = true;
      };
    }
    setCost({ kind: "loading", value: fallback, source: "static" });
    const timer = window.setTimeout(() => {
      higgsfield
        .generateCost({ jobSetType: model.jobSetType, prompt, aspect: aspectRatio })
        .then((value) => {
          if (!cancelled) setCost({ kind: "idle", value, source: "api" });
        })
        .catch(() => {
          if (!cancelled) setCost({ kind: "error", value: fallback, source: "static" });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [model, effectivePrompt, aspectRatio]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#181818]">
      <div className="shrink-0">
        <ReferenceRack
          references={references}
          onRemove={(path) => removeReference(path)}
          onOpenLibrary={() => setLibraryOpen(true)}
          onOpenStock={() => setStockOpen(true)}
          onOpenPreset={openPreset}
          presetButtonRef={presetButtonRef}
          onOpenSkill={openSkill}
          skillButtonRef={skillButtonRef}
        />
      </div>

      <div className="shrink-13-textarea flex min-h-[80px] flex-1 flex-col p-3">
        <div className="mb-1.5 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setElementModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 transition hover:border-pink-400 hover:text-white"
            title="要素別編集モーダルを開く"
          >
            <ElementGridIcon />
            <span>要素別編集</span>
          </button>
        </div>
        <PromptTextareaWithMentions
          value={isOverriding ? draft : generatedPrompt}
          onChange={onChangeDraft}
          references={references}
          fullHeight
          placeholder="左で要素を選ぶか、ここに自由記述。@ を打つと参照画像を挿入できます"
          className="w-full resize-none rounded-md border border-[#343434] bg-[#101010] p-2 pr-9 font-mono text-[11px] leading-5 text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
          topRightSlot={
            <>
              <IconButton title="コピー" onClick={copyPrompt} label="copy" />
              {isOverriding && (
                <IconButton title="自動に戻す" onClick={onResetOverride} label="reset" />
              )}
            </>
          }
        />
      </div>

      <div className="shrink-13-controls shrink-0 space-y-1.5 border-t border-[#2a2a2a] p-2.5">
        {/* モデル */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="video-model-select" className="text-[11px] font-black tracking-wide text-neutral-500">
              モデル
            </label>
            <span className="truncate text-[10px] font-bold text-neutral-600">約{model.costEstimate} credits</span>
          </div>
          <select
            id="video-model-select"
            value={model.id}
            onChange={(event) => setModel(event.currentTarget.value as VideoModelDefinition["id"])}
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2.5 text-sm font-bold text-neutral-100 outline-none transition hover:border-[#444] focus:border-pink-500"
            title={model.description}
          >
            {VIDEO_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}{item.id === "kling3_0" ? "（おすすめ）" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* 尺 + 比率 */}
        <div className="grid grid-cols-2 gap-2">
          <DurationControl model={model} value={duration} onChange={setDuration} />
          <AspectControl model={model} value={aspectRatio} onChange={setAspectRatio} />
        </div>

        {/* Cost */}
        <div className="flex items-center justify-between gap-2 rounded-md border border-[#2a2a2a] bg-[#101010] px-2.5 py-2">
          <span className="text-[11px] font-black tracking-wide text-neutral-500">Cost</span>
          <CostBadge cost={cost} />
        </div>

        {hasRunningBatch && activeBatchSummary && (
          <p className="flex items-center justify-between gap-2 text-[11px] font-semibold text-neutral-400">
            <span>生成中 {runningBatchCount}/{maxConcurrentBatches}</span>
            <span className="text-[10px] text-neutral-500">先頭 {activeBatchSummary}</span>
          </p>
        )}

        <button
          type="button"
          onClick={() => void generate()}
          disabled={disabled}
          className="h-11 w-full rounded-md bg-pink-500 px-4 py-2 text-sm font-black text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {isQueueFull ? `生成中 ${runningBatchCount}/${maxConcurrentBatches}` : "動画を生成"}
        </button>

        {status.kind !== "idle" && (
          <p
            className={
              status.kind === "error"
                ? "whitespace-pre-wrap text-xs font-semibold text-red-400"
                : "whitespace-pre-wrap text-xs font-semibold text-neutral-400"
            }
          >
            {status.message}
          </p>
        )}
      </div>

      <ReferenceLibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} />
      <StockSearchModal
        open={stockOpen}
        onClose={() => setStockOpen(false)}
        onPick={(path, stockSource) => {
          addReference({
            path,
            name: path.split(/[\\/]/).pop() || "stock image",
            source: "gallery",
            stockSource,
          });
          setStockOpen(false);
        }}
      />
      <PresetPickerPopover
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        onPick={appendPreset}
        anchorRect={presetAnchor}
      />
      <SkillPickerPopover
        open={skillOpen}
        onClose={() => setSkillOpen(false)}
        anchorRect={skillAnchor}
      />
      <ReferencePicker />
      <ElementwisePromptModal
        open={elementModalOpen}
        prompt={isOverriding ? draft : generatedPrompt}
        onClose={() => setElementModalOpen(false)}
        onApply={onChangeDraft}
      />
    </section>
  );
}

function DurationControl({
  model,
  value,
  onChange,
}: {
  model: VideoModelDefinition;
  value: number;
  onChange: (duration: number) => void;
}) {
  if (model.duration.kind === "enum") {
    return (
      <div className="space-y-1">
        <p className="text-[11px] font-black tracking-wide text-neutral-500">尺</p>
        <div className="grid grid-cols-3 gap-1">
          {model.duration.values.map((seconds) => (
            <button
              key={seconds}
              type="button"
              onClick={() => onChange(seconds)}
              className={[
                "h-9 rounded-md border px-1 text-[11px] font-black transition",
                value === seconds
                  ? "border-pink-400 bg-pink-500/10 text-white"
                  : "border-[#2a2a2a] bg-[#101010] text-neutral-400 hover:border-neutral-500",
              ].join(" ")}
            >
              {seconds}秒
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <p className="text-[11px] font-black tracking-wide text-neutral-500">尺</p>
        <span className="text-[10px] font-bold text-neutral-600">
          {model.duration.min}〜{model.duration.max}秒
        </span>
      </div>
      <div className="flex h-9 items-center rounded-md border border-[#343434] bg-[#101010]">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          className="h-9 w-9 rounded-l-md text-base font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を短くする"
        >
          −
        </button>
        <div className="flex-1 text-center text-sm font-black text-white">{value}秒</div>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          className="h-9 w-9 rounded-r-md text-base font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を長くする"
        >
          +
        </button>
      </div>
    </div>
  );
}

function AspectControl({
  model,
  value,
  onChange,
}: {
  model: VideoModelDefinition;
  value: string;
  onChange: (aspectRatio: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor="video-aspect-select" className="text-[11px] font-black tracking-wide text-neutral-500">
        比率
      </label>
      <select
        id="video-aspect-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2.5 text-sm font-bold text-neutral-100 outline-none transition hover:border-[#444] focus:border-pink-500"
      >
        {model.aspectRatios.map((ratio) => (
          <option key={ratio} value={ratio}>
            {ratio}
          </option>
        ))}
      </select>
    </div>
  );
}

function CostBadge({ cost }: { cost: CostState }) {
  if (cost.value === null) {
    return <span className="text-[11px] font-bold text-neutral-600">見積もりなし</span>;
  }
  const suffix = cost.kind === "loading" ? "確認中" : cost.source === "api" ? "見積もり" : "目安";
  return (
    <span className="rounded-full bg-pink-500/15 px-2 py-1 text-[11px] font-black text-pink-200">
      約{cost.value} credits（{suffix}）
    </span>
  );
}

/** 参照画像ラック (画像版 ConstructedPromptPanel と同じ 5 ボタン構成)。 */
function ReferenceRack({
  references,
  onRemove,
  onOpenLibrary,
  onOpenStock,
  onOpenPreset,
  presetButtonRef,
  onOpenSkill,
  skillButtonRef,
}: {
  references: ReturnType<typeof useComposer.getState>["references"];
  onRemove: (path: string) => void;
  onOpenLibrary: () => void;
  onOpenStock: () => void;
  onOpenPreset: () => void;
  presetButtonRef: React.RefObject<HTMLButtonElement | null>;
  onOpenSkill: () => void;
  skillButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const iconBtn =
    "shrink-13-rack flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-[#343434] bg-[#101010] px-1 text-[9px] font-bold leading-tight tracking-tighter text-neutral-300 transition hover:border-pink-400 hover:text-white";
  const iconLabel = "block w-full truncate whitespace-nowrap text-center";

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const { refs, files } = extractDropped(event.dataTransfer);
    const composer = useComposer.getState();
    if (refs.length > 0) {
      composer.addReferences(
        refs.map((r) => ({ path: r.path, name: r.name, source: r.source, role: r.role })),
      );
    }
    if (files.length > 0) {
      void Promise.all(files.map((f) => fileToUploadReference(f))).then((uploadedRefs) => {
        composer.addReferences(uploadedRefs);
      });
    }
  };

  return (
    <div
      className="border-b border-[#2a2a2a] p-3"
      onDragOver={(event) => {
        if (isImageDrop(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <div className="grid grid-cols-5 gap-1.5">
        <button type="button" onClick={onOpenLibrary} className={iconBtn} title="このアプリで生成した画像から選ぶ">
          <LibraryIcon />
          <span className={iconLabel}>ライブラリ</span>
        </button>
        <button type="button" onClick={onOpenStock} className={iconBtn} title="ストック素材 API から写真を検索">
          <StockIcon />
          <span className={iconLabel}>素材</span>
        </button>
        <label className={`${iconBtn} cursor-pointer`} title="ローカル PC から画像を追加">
          <PlusIcon />
          <span className={iconLabel}>追加</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              if (!files || files.length === 0) return;
              const detail = Array.from(files);
              window.dispatchEvent(new CustomEvent("gori:add-local-files", { detail }));
              event.target.value = "";
            }}
          />
        </label>
        <button ref={presetButtonRef} type="button" onClick={onOpenPreset} className={iconBtn} title="登録済みプロンプトを呼び出す">
          <PresetIcon />
          <span className={iconLabel}>プリセット</span>
        </button>
        <button ref={skillButtonRef} type="button" onClick={onOpenSkill} className={iconBtn} title="スキルを呼び出す">
          <SkillIcon />
          <span className={iconLabel}>スキル</span>
        </button>
      </div>

      {references.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {references.map((ref, index) => (
            <ReferenceChip
              key={ref.path}
              index={index + 1}
              path={ref.path}
              name={ref.name}
              onRemove={() => onRemove(ref.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReferenceChip({
  index,
  path,
  name,
  onRemove,
}: {
  index: number;
  path: string;
  name: string;
  onRemove: () => void;
}) {
  return (
    <div className="group relative h-14 w-14 overflow-hidden rounded-md border border-[#343434] bg-[#0b0b0b]" title={name}>
      <img src={convertFileSrc(path)} alt={name} className="h-full w-full object-cover" />
      <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] font-black text-white">
        @img{index}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="参照を外す"
        className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/80 text-[10px] font-black text-white group-hover:flex hover:bg-red-500"
      >
        ×
      </button>
    </div>
  );
}

function PresetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SkillIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15 9 22 9 16 14 18 21 12 17 6 21 8 14 2 9 9 9 12 2" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function StockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ElementGridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" ry="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" ry="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" ry="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" ry="1" />
    </svg>
  );
}

function IconButton({
  title,
  onClick,
  label,
}: {
  title: string;
  onClick: () => void;
  label: "copy" | "reset";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-6 w-6 items-center justify-center rounded border border-[#343434] bg-[#181818] text-neutral-300 hover:border-pink-400 hover:text-white"
    >
      {label === "copy" ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      )}
    </button>
  );
}
