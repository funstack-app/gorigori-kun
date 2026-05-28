import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { higgsfield, type HiggsfieldVideoParams } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { useVideoGen, CAMERA_PRESETS, MOTION_PRESETS } from "../lib/store/videoGen";
import type { SceneOption } from "../lib/scene/catalog";
import { VIDEO_MODELS, findVideoModel, type VideoModelDefinition, type VideoModelParam } from "../lib/videoModels";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";
import { OptionPickerModal } from "./scene/OptionPickerModal";
import { SceneCompactCard } from "./scene/SceneCompactCard";
import { SceneSectionModal } from "./scene/SceneSectionModal";

const STATUS_IDLE = "動きを1つ選ぶか書いて、動画生成を開始できます。";

type VideoGenerationWorkspaceProps = {
  /** 右側は既存タイムラインを流用。動画サムネ再生は part2 で拡張する */
  timeline?: ReactNode;
};

type CostState =
  | { kind: "idle"; value: number | null; source: "api" | "static" | null }
  | { kind: "loading"; value: number | null; source: "api" | "static" | null }
  | { kind: "error"; value: number | null; source: "static" | null };

type VideoSectionId = "source" | "subject" | "camera";

const MOTION_PICKER_OPTIONS: SceneOption[] = MOTION_PRESETS.map((motion) => ({
  value: motion,
  visual: "none",
}));

const CAMERA_PICKER_OPTIONS: SceneOption[] = CAMERA_PRESETS.map((preset) => ({
  value: preset.label,
  hint: preset.phrase,
  visual: "none",
}));

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function compactPath(path: string): string {
  if (path.length <= 42) return path;
  return `…${path.slice(-39)}`;
}

function getCameraPhrase(cameraMovement: string): string {
  return (
    CAMERA_PRESETS.find((preset) => preset.id === cameraMovement)?.phrase ??
    CAMERA_PRESETS[0].phrase
  );
}

function getCameraLabel(cameraMovement: string): string {
  return (
    CAMERA_PRESETS.find((preset) => preset.id === cameraMovement)?.label ??
    CAMERA_PRESETS[0].label
  );
}

function getCameraIdByLabel(label: string): string {
  return CAMERA_PRESETS.find((preset) => preset.label === label)?.id ?? CAMERA_PRESETS[0].id;
}

function buildVideoPrompt(subjectMotion: string, cameraMovement: string): string {
  const motion = subjectMotion.trim();
  const camera = getCameraPhrase(cameraMovement);
  return [motion, camera].filter(Boolean).join(", ");
}

function selectableButtonClass(selected: boolean, extra = ""): string {
  return [
    "h-9 rounded-md border px-3 text-xs font-black transition",
    selected
      ? "border-pink-400 bg-pink-500/10 text-white"
      : "border-[#2a2a2a] bg-[#101010] text-neutral-400 hover:border-neutral-500",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

function paramDefaultToVideoArgs(params: VideoModelParam[]): HiggsfieldVideoParams {
  const args: HiggsfieldVideoParams = {};
  for (const param of params) {
    const value = param.default;
    if (param.name === "model" || param.name === "model_variant") {
      args.modelVariant = String(value);
    } else if (param.name === "quality") {
      args.quality = String(value);
    } else if (param.name === "mode") {
      args.mode = String(value);
    } else if (param.name === "resolution") {
      args.resolution = String(value);
    } else if (param.name === "sound") {
      args.sound = String(value);
    } else if (param.name === "genre") {
      args.genre = String(value);
    }
  }
  return args;
}

function useSelectedVideoModel(): VideoModelDefinition {
  const modelId = useVideoGen((s) => s.modelId);
  return findVideoModel(modelId) ?? VIDEO_MODELS[0];
}

export function VideoGenerationWorkspace({ timeline }: VideoGenerationWorkspaceProps) {
  return (
    <div className="grid h-full min-h-0 gap-4 md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <VideoInputPanel />
      {timeline ?? (
        <section className="flex h-full min-h-0 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#181818] text-sm text-neutral-500">
          生成タイムライン
        </section>
      )}
    </div>
  );
}

function VideoInputPanel() {
  const sourceImagePath = useVideoGen((s) => s.sourceImagePath);
  const subjectMotion = useVideoGen((s) => s.subjectMotion);
  const cameraMovement = useVideoGen((s) => s.cameraMovement);
  const duration = useVideoGen((s) => s.duration);
  const aspectRatio = useVideoGen((s) => s.aspectRatio);
  const setSourceImage = useVideoGen((s) => s.setSourceImage);
  const setSubjectMotion = useVideoGen((s) => s.setSubjectMotion);
  const setCameraMovement = useVideoGen((s) => s.setCameraMovement);
  const setModel = useVideoGen((s) => s.setModel);
  const setDuration = useVideoGen((s) => s.setDuration);
  const setAspectRatio = useVideoGen((s) => s.setAspectRatio);

  const model = useSelectedVideoModel();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState(STATUS_IDLE);
  const [generating, setGenerating] = useState(false);
  const [openSection, setOpenSection] = useState<VideoSectionId | null>(null);
  const prompt = useMemo(
    () => buildVideoPrompt(subjectMotion, cameraMovement),
    [subjectMotion, cameraMovement],
  );
  const canGenerate = subjectMotion.trim().length > 0 && !generating;
  const closeSection = () => setOpenSection(null);
  const sourceSummary = sourceImagePath ? basename(sourceImagePath) : "画像なし (t2v)";
  const subjectSummary = subjectMotion.trim() || "未設定";
  const cameraSummary = getCameraLabel(cameraMovement);
  const [cost, setCost] = useState<CostState>({
    kind: "idle",
    value: model.costEstimate,
    source: "static",
  });

  useEffect(() => {
    let cancelled = false;
    const fallback = model.costEstimate;
    if (!prompt.trim()) {
      setCost({ kind: "idle", value: fallback, source: "static" });
      return () => {
        cancelled = true;
      };
    }

    setCost({ kind: "loading", value: fallback, source: "static" });
    const timer = window.setTimeout(() => {
      higgsfield
        .generateCost({
          jobSetType: model.jobSetType,
          prompt,
          aspect: aspectRatio,
        })
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
  }, [model, prompt, aspectRatio]);

  const setSelectedImageFromFile = async (file: File) => {
    const ref = await fileToUploadReference(file);
    setSourceImage(ref.path);
    setStatus(`元画像を設定しました: ${ref.name}`);
  };

  const onFilesSelected = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("画像ファイルを選んでください。対応形式: png / jpg / webp など");
      return;
    }
    try {
      await setSelectedImageFromFile(file);
    } catch (error) {
      console.error("video source upload failed", error);
      setStatus(`元画像の読み込みに失敗しました: ${String(error)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const onDropImage = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const { refs, files } = extractDropped(event.dataTransfer);
    const ref = refs[0];
    if (ref) {
      setSourceImage(ref.path);
      setStatus(`元画像を設定しました: ${ref.name}`);
      return;
    }
    const file = files[0];
    if (file) {
      try {
        await setSelectedImageFromFile(file);
      } catch (error) {
        console.error("video source drop failed", error);
        setStatus(`元画像の読み込みに失敗しました: ${String(error)}`);
      }
    }
  };

  const generate = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setStatus("被写体の動きを1つ書いてください。例: ゆっくり振り返る");
      return;
    }

    setGenerating(true);
    setStatus("動画生成を開始しています...");
    const batchId = `local-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const refImagePaths = sourceImagePath ? [sourceImagePath] : [];

    useBatches.getState().startBatch({
      batchId,
      prompt: trimmedPrompt,
      references: refImagePaths.map((path) => ({ path, name: basename(path) })),
      count: 1,
      provider: "higgsfield",
      modelJobSetType: model.jobSetType,
      modelDisplayName: model.label,
      mediaType: "video",
    });

    try {
      const result = await higgsfield.generateBatch({
        jobSetType: model.jobSetType,
        displayName: model.label,
        prompt: trimmedPrompt,
        count: 1,
        aspect: aspectRatio,
        refImagePaths,
        mediaType: "video",
        duration,
        i2vInputField: model.i2vInputField,
        ...paramDefaultToVideoArgs(model.extraParams),
      });

      if (result.failedCount > 0 || result.generatedPaths.length === 0) {
        setStatus("動画生成に失敗しました。モデル・尺・アスペクト比を変えて再試行してください。");
      } else {
        setStatus("動画を生成しました。右側のタイムラインに追加されます。");
      }
    } catch (error) {
      useBatches.getState().removeBatch(batchId);
      console.error("video generation failed", error);
      setStatus(`動画生成に失敗しました: ${String(error)}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
        <div className="shrink-0 border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">動画生成</h3>
        </div>

        <div className="shrink-0 p-3">
          <div className="space-y-2">
            <SceneCompactCard
              number="01"
              title="元画像 (i2v)"
              summary={sourceSummary}
              onClick={() => setOpenSection("source")}
            />
            <SceneCompactCard
              number="02"
              title="被写体の動き"
              summary={subjectSummary}
              onClick={() => setOpenSection("subject")}
            />
            <SceneCompactCard
              number="03"
              title="カメラの動き"
              summary={cameraSummary}
              onClick={() => setOpenSection("camera")}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[#242424] bg-[#181818]">
          <div className="flex min-h-[80px] flex-1 flex-col p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-black tracking-wide text-neutral-500">被写体の動き</span>
            </div>
            <textarea
              value={subjectMotion}
              onChange={(event) => setSubjectMotion(event.currentTarget.value)}
              placeholder="自由記述 例: ゆっくり振り返る"
              className="min-h-0 flex-1 resize-none rounded-md border border-[#343434] bg-[#101010] p-2 font-mono text-[11px] leading-5 text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
            />
          </div>

          <div className="shrink-0 space-y-1.5 border-t border-[#2a2a2a] p-2.5">
            <ModelSettingsSection
              model={model}
              duration={duration}
              aspectRatio={aspectRatio}
              onModelChange={setModel}
              onDurationChange={setDuration}
              onAspectRatioChange={setAspectRatio}
            />

            <div className="flex items-center justify-between gap-2 rounded-md border border-[#2a2a2a] bg-[#101010] px-2.5 py-2">
              <span className="text-[11px] font-black tracking-wide text-neutral-500">Cost</span>
              <CostBadge cost={cost} />
            </div>

            <button
              type="button"
              onClick={() => void generate()}
              disabled={!canGenerate}
              className="h-11 w-full rounded-md bg-pink-500 px-4 py-2 text-sm font-black text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              {generating ? "生成中..." : "動画を生成"}
            </button>

            <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-500">{status}</p>
          </div>
        </div>
      </section>

      <SceneSectionModal
        open={openSection === "source"}
        number="01"
        title="元画像 (i2v)"
        onClose={closeSection}
      >
        <SourceImageSection
          sourceImagePath={sourceImagePath}
          fileInputRef={fileInputRef}
          onPickClick={() => fileInputRef.current?.click()}
          onFilesSelected={onFilesSelected}
          onDropImage={onDropImage}
          onClear={() => setSourceImage(null)}
        />
      </SceneSectionModal>

      <OptionPickerModal
        open={openSection === "subject"}
        title="被写体の動きを選ぶ"
        options={MOTION_PICKER_OPTIONS}
        selectedValue={subjectMotion.trim()}
        onPick={(value) => setSubjectMotion(value)}
        onClose={closeSection}
      />

      <OptionPickerModal
        open={openSection === "camera"}
        title="カメラの動きを選ぶ"
        options={CAMERA_PICKER_OPTIONS}
        selectedValue={cameraSummary}
        onPick={(value) => setCameraMovement(getCameraIdByLabel(value))}
        onClose={closeSection}
      />

    </>
  );
}

function SourceImageSection({
  sourceImagePath,
  fileInputRef,
  onPickClick,
  onFilesSelected,
  onDropImage,
  onClear,
}: {
  sourceImagePath: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onPickClick: () => void;
  onFilesSelected: (files: FileList | null) => void;
  onDropImage: (event: React.DragEvent<HTMLDivElement>) => void;
  onClear: () => void;
}) {
  return (
    <section className="space-y-2">
      <SectionHeader index="01" title="元画像" note="未選択ならテキスト→動画" />
      <div
        className="rounded-xl border border-dashed border-[#3a3a3a] bg-[#111] p-3 transition hover:border-pink-500/50"
        onDragOver={(event) => {
          if (isImageDrop(event.dataTransfer)) event.preventDefault();
        }}
        onDrop={onDropImage}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void onFilesSelected(event.currentTarget.files)}
        />

        {sourceImagePath ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-black">
              <img
                src={convertFileSrc(sourceImagePath)}
                alt="動画生成の元画像"
                className="h-36 w-full object-contain"
                draggable={false}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-xs text-neutral-400" title={sourceImagePath}>
                {compactPath(sourceImagePath)}
              </p>
              <button
                type="button"
                onClick={onClear}
                className="shrink-0 rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-1.5 text-xs font-bold text-neutral-400 hover:border-neutral-500 hover:text-white"
              >
                解除
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-5 text-center">
            <p className="text-sm font-bold text-neutral-300">画像を1枚ドロップ</p>
            <p className="text-xs text-neutral-500">画像生成タブのサムネ、またはローカル画像を使えます。</p>
            <button
              type="button"
              onClick={onPickClick}
              className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-xs font-black text-neutral-300 hover:border-neutral-500 hover:text-white"
            >
              画像を選ぶ
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ModelSettingsSection({
  model,
  duration,
  aspectRatio,
  onModelChange,
  onDurationChange,
  onAspectRatioChange,
}: {
  model: VideoModelDefinition;
  duration: number;
  aspectRatio: string;
  onModelChange: (id: VideoModelDefinition["id"]) => void;
  onDurationChange: (duration: number) => void;
  onAspectRatioChange: (aspectRatio: string) => void;
}) {
  return (
    <section className="space-y-1.5">
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
          onChange={(event) => onModelChange(event.currentTarget.value as VideoModelDefinition["id"])}
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

      <div className="grid grid-cols-2 gap-2">
        <DurationControl
          model={model}
          value={duration}
          onChange={onDurationChange}
        />
        <AspectControl
          model={model}
          value={aspectRatio}
          onChange={onAspectRatioChange}
        />
      </div>
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
              className={selectableButtonClass(value === seconds, "px-1 text-[11px]")}
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

function SectionHeader({
  index,
  title,
  note,
}: {
  index: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-black text-white">
        <span className="mr-2 text-pink-400">{index}</span>
        {title}
      </h4>
      {note && <span className="text-[11px] font-bold text-neutral-500">{note}</span>}
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
