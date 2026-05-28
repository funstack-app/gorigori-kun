import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { higgsfield, type HiggsfieldVideoParams } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { useVideoGen, CAMERA_PRESETS, MOTION_PRESETS } from "../lib/store/videoGen";
import { VIDEO_MODELS, findVideoModel, type VideoModelDefinition, type VideoModelParam } from "../lib/videoModels";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";

const STATUS_IDLE = "動きを1つ選ぶか書いて、動画生成を開始できます。";

type VideoGenerationWorkspaceProps = {
  /** 右側は既存タイムラインを流用。動画サムネ再生は part2 で拡張する */
  timeline?: ReactNode;
};

type CostState =
  | { kind: "idle"; value: number | null; source: "api" | "static" | null }
  | { kind: "loading"; value: number | null; source: "api" | "static" | null }
  | { kind: "error"; value: number | null; source: "static" | null };

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

function buildVideoPrompt(subjectMotion: string, cameraMovement: string): string {
  const motion = subjectMotion.trim();
  const camera = getCameraPhrase(cameraMovement);
  return [motion, camera].filter(Boolean).join(", ");
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
    <div className="grid h-full min-h-0 gap-4 md:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
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
  const prompt = useMemo(
    () => buildVideoPrompt(subjectMotion, cameraMovement),
    [subjectMotion, cameraMovement],
  );
  const canGenerate = subjectMotion.trim().length > 0 && !generating;
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
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      <div className="shrink-0 border-b border-[#242424] px-4 py-3">
        <h3 className="text-sm font-black text-white">動画生成</h3>
        <p className="mt-1 text-xs text-neutral-500">
          画像説明は書かず、「何がどう動くか」と「カメラ」だけを決めます。
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <SourceImageSection
          sourceImagePath={sourceImagePath}
          fileInputRef={fileInputRef}
          onPickClick={() => fileInputRef.current?.click()}
          onFilesSelected={onFilesSelected}
          onDropImage={onDropImage}
          onClear={() => setSourceImage(null)}
        />

        <SubjectMotionSection
          value={subjectMotion}
          onChange={setSubjectMotion}
        />

        <CameraMovementSection
          value={cameraMovement}
          onChange={setCameraMovement}
        />

        <ModelSettingsSection
          model={model}
          duration={duration}
          aspectRatio={aspectRatio}
          onModelChange={setModel}
          onDurationChange={setDuration}
          onAspectRatioChange={setAspectRatio}
        />
      </div>

      <div className="shrink-0 space-y-3 border-t border-[#242424] p-4">
        <div className="rounded-lg border border-[#2a2a2a] bg-[#111] p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-black tracking-wide text-neutral-500">生成プロンプト</span>
            <CostBadge cost={cost} />
          </div>
          <p className="min-h-5 break-words text-xs leading-relaxed text-neutral-300">
            {prompt || "被写体の動きを入力すると、ここに簡易プロンプトが出ます。"}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void generate()}
          disabled={!canGenerate}
          className={`h-11 w-full rounded-lg text-sm font-black transition ${
            canGenerate
              ? "bg-pink-500 text-white hover:bg-pink-400"
              : "cursor-not-allowed bg-neutral-800 text-neutral-500"
          }`}
        >
          {generating ? "生成中..." : "動画を生成"}
        </button>

        <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-500">{status}</p>
      </div>
    </section>
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
                className="shrink-0 rounded-md border border-[#333] px-2 py-1 text-xs font-bold text-neutral-300 hover:border-pink-500 hover:text-white"
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
              className="rounded-lg border border-[#333] bg-[#1f1f1f] px-3 py-2 text-xs font-black text-white hover:border-pink-500"
            >
              画像を選ぶ
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function SubjectMotionSection({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="space-y-2">
      <SectionHeader index="02" title="被写体の動き" note="1つだけ" />
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        rows={2}
        placeholder="1つの動きを書いてください 例: ゆっくり振り返る"
        className="min-h-[72px] w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-pink-500"
      />
      <div className="flex flex-wrap gap-2">
        {MOTION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className="rounded-full border border-[#333] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-500 hover:bg-pink-500/10 hover:text-white"
          >
            {preset}
          </button>
        ))}
      </div>
    </section>
  );
}

function CameraMovementSection({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="space-y-2">
      <SectionHeader index="03" title="カメラの動き" note="単一選択" />
      <div className="grid grid-cols-2 gap-2">
        {CAMERA_PRESETS.map((preset) => {
          const selected = value === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange(preset.id)}
              className={`rounded-lg border px-3 py-2 text-left text-xs font-black transition ${
                selected
                  ? "border-pink-500 bg-pink-500/15 text-white"
                  : "border-[#333] bg-[#101010] text-neutral-400 hover:border-pink-500/70 hover:text-white"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
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
    <section className="space-y-3">
      <SectionHeader index="04" title="モデル + 尺 + アスペクト" />

      <div className="space-y-2">
        <p className="text-[11px] font-black tracking-wide text-neutral-500">モデル</p>
        <div className="space-y-2">
          {VIDEO_MODELS.map((item) => {
            const selected = model.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onModelChange(item.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/15"
                    : "border-[#333] bg-[#101010] hover:border-pink-500/70"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-black text-white">
                    {item.label}
                    {item.id === "kling3_0" && (
                      <span className="ml-2 rounded bg-pink-500 px-1.5 py-0.5 text-[10px] text-white">
                        おすすめ
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-bold text-neutral-500">約{item.costEstimate} credits</span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">{item.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
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
      <div className="space-y-2">
        <p className="text-[11px] font-black tracking-wide text-neutral-500">尺</p>
        <div className="grid grid-cols-3 gap-2">
          {model.duration.values.map((seconds) => (
            <button
              key={seconds}
              type="button"
              onClick={() => onChange(seconds)}
              className={`rounded-lg border px-2 py-2 text-xs font-black ${
                value === seconds
                  ? "border-pink-500 bg-pink-500/15 text-white"
                  : "border-[#333] bg-[#101010] text-neutral-400 hover:border-pink-500/70 hover:text-white"
              }`}
            >
              {seconds}秒
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-black tracking-wide text-neutral-500">尺</p>
      <div className="flex items-center rounded-lg border border-[#333] bg-[#101010] p-1">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          className="h-8 w-8 rounded-md text-lg font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を短くする"
        >
          −
        </button>
        <div className="flex-1 text-center text-sm font-black text-white">{value}秒</div>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          className="h-8 w-8 rounded-md text-lg font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を長くする"
        >
          +
        </button>
      </div>
      <p className="text-[11px] text-neutral-600">
        {model.duration.min}〜{model.duration.max}秒
      </p>
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
    <div className="space-y-2">
      <p className="text-[11px] font-black tracking-wide text-neutral-500">アスペクト比</p>
      <div className="grid grid-cols-2 gap-2">
        {model.aspectRatios.map((ratio) => (
          <button
            key={ratio}
            type="button"
            onClick={() => onChange(ratio)}
            className={`rounded-lg border px-2 py-2 text-xs font-black ${
              value === ratio
                ? "border-pink-500 bg-pink-500/15 text-white"
                : "border-[#333] bg-[#101010] text-neutral-400 hover:border-pink-500/70 hover:text-white"
            }`}
          >
            {ratio}
          </button>
        ))}
      </div>
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
