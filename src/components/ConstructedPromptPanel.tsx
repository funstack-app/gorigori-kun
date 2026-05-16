import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSceneGeneration } from "../lib/scene/useSceneGeneration";
import { aspectRatioOptions, type SceneOption } from "../lib/scene/catalog";
import type { SceneAspectRatio } from "../lib/scene/types";
import { useComposer } from "../lib/store/composer";
import { useSceneStore } from "../lib/store/scene";
import { useWorkspace } from "../lib/store/workspace";
import type { Preset } from "../lib/store/presets";
import { HiggsfieldModelSelector } from "./HiggsfieldModelSelector";
import { OptionPickerModal } from "./scene/OptionPickerModal";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { SkillPickerPopover } from "./SkillPickerPopover";
import { PromptTextareaWithMentions } from "./PromptTextareaWithMentions";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { ReferencePicker } from "./ReferencePicker";
import { StockSearchModal } from "./StockSearchModal";

const MAX_COUNT = 30;

/**
 * アスペクト比の選択肢にアプリ内で見せる短い説明を結びつける。
 * モデル選択モーダルと同じパターン (SceneOption[] を渡してリスト表示) で使える。
 */
const ASPECT_RATIO_HINTS: Record<SceneAspectRatio, string> = {
  "21:9": "シネマスコープ・超横長",
  "16:9": "動画/YouTube・標準横長",
  "3:2": "写真標準・カメラ初期値",
  "4:3": "クラシック・印刷/プレゼン",
  "1:1": "正方形・Instagram投稿",
  "4:5": "縦長・Instagram投稿",
  "2:3": "ポートレート・ポスター",
  "9:16": "Reels/TikTok/Stories",
};

/**
 * アスペクト比のサムネ SVG を data URI で生成する。
 * 縦横比に応じた枠線だけのシンプルなプレビュー。
 */
function aspectThumbnail(ratio: string): { src: string; alt: string } {
  const [wStr, hStr] = ratio.split(":");
  const w = parseInt(wStr, 10) || 1;
  const h = parseInt(hStr, 10) || 1;
  const maxSide = 56;
  const max = Math.max(w, h);
  const rectW = (w / max) * maxSide;
  const rectH = (h / max) * maxSide;
  const x = (64 - rectW) / 2;
  const y = (64 - rectH) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="${x}" y="${y}" width="${rectW}" height="${rectH}" rx="3" fill="#1a1a1a" stroke="#666" stroke-width="1.5"/>
    <text x="32" y="36" text-anchor="middle" font-family="ui-sans-serif,system-ui" font-size="10" font-weight="700" fill="#bbb">${ratio}</text>
  </svg>`;
  return {
    src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    alt: ratio,
  };
}

const ASPECT_RATIO_PICKER_OPTIONS: SceneOption[] = aspectRatioOptions.map((value) => ({
  value,
  hint: ASPECT_RATIO_HINTS[value],
  visual: "aspect",
  thumbnail: aspectThumbnail(value),
}));

/**
 * Compact prompt + generation control. Header is intentionally removed
 * so the panel is shorter; the prompt textarea is the visual anchor.
 */
export function ConstructedPromptPanel() {
  const {
    generatedPrompt,
    count,
    setCount,
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
  } = useSceneGeneration();

  const [draft, setDraft] = useState<string>(generatedPrompt);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [aspectPickerOpen, setAspectPickerOpen] = useState(false);
  const [presetAnchor, setPresetAnchor] = useState<DOMRect | null>(null);
  const presetButtonRef = useRef<HTMLButtonElement | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillAnchor, setSkillAnchor] = useState<DOMRect | null>(null);
  const skillButtonRef = useRef<HTMLButtonElement | null>(null);
  const references = useComposer((s) => s.references);
  const addReference = useComposer((s) => s.addReference);
  const removeReference = useComposer((s) => s.removeReference);
  const purpose = useWorkspace((s) => s.purpose);
  const modelMedia = purpose === "videoStory" ? "video" : "image";
  const aspectRatio = useSceneStore((s) => s.subjectFraming.aspectRatio);
  const setSubjectFramingField = useSceneStore((s) => s.setSubjectFramingField);

  /** プリセット選択時の追記。既存プロンプト末尾に「, 」で繋げる。空なら本文のみ。 */
  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    const next = current ? `${current}, ${preset.prompt}` : preset.prompt;
    onChangeDraft(next);
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
    // promptOverride がクリアされたらシーン構築から作った文字列に戻る。
    // promptOverride に値が入った時 (= 企画タブの採用 等で外部から設定された時) も
    // draft を同期して、入力欄に即反映する。手で直接編集中の場合は draft と
    // override が同値なので無害。
    if (promptOverride === null) {
      setDraft(generatedPrompt);
    } else if (promptOverride !== draft) {
      setDraft(promptOverride);
    }
    // draft を依存に入れると無限ループの懸念があるので意図的に外す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedPrompt, promptOverride]);

  const isOverriding = promptOverride !== null;

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

  const decrement = () => setCount(Math.max(1, count - 1) as never);
  const increment = () => setCount(Math.min(MAX_COUNT, count + 1) as never);

  // 数値直接入力用の draft。フォーカス中は空文字や 1-2 桁の途中入力を許可し、
  // blur/Enter で int + clamp に変換して store に反映する。
  const [countDraft, setCountDraft] = useState<string>(String(count));
  // 外部 (decrement/increment, preset 等) で count が変わったら draft を同期。
  // ただし入力中 (フォーカス中) は触らない。
  const countInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (document.activeElement !== countInputRef.current) {
      setCountDraft(String(count));
    }
  }, [count]);

  const commitCount = () => {
    const parsed = Number.parseInt(countDraft, 10);
    if (Number.isNaN(parsed)) {
      setCountDraft(String(count));
      return;
    }
    const clamped = Math.max(1, Math.min(MAX_COUNT, parsed));
    setCount(clamped as never);
    setCountDraft(String(clamped));
  };

  return (
    // 外枠は親（LeftPanel の flex-1 領域）の高さを満たす flex column。
    // 上から: ラック(shrink-0) / textareaラッパー(flex-1, 内部 textarea を h-full で伸ばす) / 生成コントロール(shrink-0)
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
      <div className="flex min-h-0 flex-1 flex-col p-3">
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

      {/*
        下部コントロール (モデル選択 / 枚数 / アスペクト / 生成ボタン).
        13 インチ画面 (~720-800 縦) でも生成ボタンに到達できるよう、
        max-height を 50vh に制限してこの中で縦スクロール可能にする。
        textarea (上の flex-1) は最低限の高さを保つ。
      */}
      <div className="shrink-0 space-y-3 overflow-y-auto border-t border-[#2a2a2a] p-3" style={{ maxHeight: "50vh" }}>
        <HiggsfieldModelSelector media={modelMedia} />

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-bold text-neutral-300">生成枚数</span>
          <div className="inline-flex items-center gap-1 rounded-md border border-[#343434] bg-[#101010]">
            <button
              type="button"
              onClick={decrement}
              disabled={count <= 1}
              className="h-7 w-7 text-sm font-bold text-neutral-300 hover:bg-[#1f1f1f] disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              −
            </button>
            <input
              ref={countInputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={countDraft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                // 数字のみ通す。空文字も許可 (途中入力)
                const sanitized = event.target.value.replace(/[^0-9]/g, "");
                setCountDraft(sanitized);
              }}
              onBlur={commitCount}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCount();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setCountDraft(String(count));
                  event.currentTarget.blur();
                }
              }}
              className="w-10 border-0 bg-transparent text-center text-sm font-bold text-neutral-100 outline-none"
            />
            <button
              type="button"
              onClick={increment}
              disabled={count >= MAX_COUNT}
              className="h-7 w-7 text-sm font-bold text-neutral-300 hover:bg-[#1f1f1f] disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              +
            </button>
          </div>
        </div>

        {/*
          アスペクト比: モデル選択と同じく「現在値ボタン → ポップアップ」型。
          ボタン内に値 (16:9) + 短い説明 (横長・動画) を併記。
          OptionPickerModal を流用してカード式に説明文付きで一覧表示する。
        */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs font-bold text-neutral-300">アスペクト比</span>
          <button
            type="button"
            onClick={() => setAspectPickerOpen(true)}
            className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-[#343434] bg-[#101010] px-2 text-left text-xs font-semibold text-neutral-100 outline-none transition hover:border-[#444] hover:bg-[#151515] focus:border-pink-500"
            title="アスペクト比を選ぶ"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-bold text-neutral-100">{aspectRatio}</span>
              <span className="truncate text-[10px] font-medium text-neutral-500">
                {ASPECT_RATIO_HINTS[aspectRatio as SceneAspectRatio] ?? ""}
              </span>
            </span>
            <span className="shrink-0 text-[10px] text-neutral-500" aria-hidden>
              ▾
            </span>
          </button>
        </div>

        {hasRunningBatch && activeBatchSummary && (
          <p className="flex items-center justify-between gap-2 text-xs font-semibold text-neutral-400">
            <span>
              生成中 {runningBatchCount}/{maxConcurrentBatches}
            </span>
            <span className="text-[10px] text-neutral-500">
              先頭 {activeBatchSummary}
            </span>
          </p>
        )}

        <button
          type="button"
          onClick={generate}
          disabled={disabled}
          className="w-full rounded-md bg-pink-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {isQueueFull
            ? `生成中 ${runningBatchCount}/${maxConcurrentBatches}`
            : "この内容で生成"}
        </button>

        {status.kind !== "idle" && (
          <p
            className={
              status.kind === "error"
                ? "text-xs font-semibold text-red-400"
                : "text-xs font-semibold text-neutral-400"
            }
          >
            {status.message}
          </p>
        )}
      </div>

      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
      />
      <StockSearchModal
        open={stockOpen}
        onClose={() => setStockOpen(false)}
        onPick={(path) => {
          addReference({
            path,
            name: path.split(/[\\/]/).pop() || "stock image",
            source: "gallery",
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
      <OptionPickerModal
        open={aspectPickerOpen}
        title="アスペクト比を選ぶ"
        options={ASPECT_RATIO_PICKER_OPTIONS}
        selectedValue={aspectRatio}
        onPick={(value) =>
          setSubjectFramingField("aspectRatio", value as SceneAspectRatio)
        }
        onClose={() => setAspectPickerOpen(false)}
      />
      <ReferencePicker />
    </section>
  );
}

/**
 * 参照画像ラック（Magnific 風）。
 * プロンプト textarea のすぐ上に置き、現在の参照（@imgN）を一覧表示する。
 * - 「ライブラリ」ボタン: 過去生成画像から選ぶモーダルを開く
 * - 「素材」ボタン: 接続済みストック素材 API から検索して追加する
 * - 「追加」ボタン: ローカル PC から画像を選ぶ（ReferencePicker 経由）
 * - 各チップにマウスを乗せると × で外せる
 */
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
  return (
    <div className="border-b border-[#2a2a2a] p-3">
      {/* 1 段目: 操作ボタン行（ライブラリ / 追加 / プリセット） */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onOpenLibrary}
          className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md border border-[#343434] bg-[#101010] text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
          title="このアプリで生成した画像から選ぶ"
        >
          <LibraryIcon />
          <span>ライブラリ</span>
        </button>
        <button
          type="button"
          onClick={onOpenStock}
          className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md border border-[#343434] bg-[#101010] text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
          title="ストック素材 API から写真を検索"
        >
          <StockIcon />
          <span>素材</span>
        </button>
        <label
          className="flex h-14 w-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-[#343434] bg-[#101010] text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
          title="ローカル PC から画像を追加"
        >
          <PlusIcon />
          <span>追加</span>
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
        <button
          ref={presetButtonRef}
          type="button"
          onClick={onOpenPreset}
          className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md border border-[#343434] bg-[#101010] text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
          title="登録済みプロンプトを呼び出す"
        >
          <PresetIcon />
          <span>プリセット</span>
        </button>
        <button
          ref={skillButtonRef}
          type="button"
          onClick={onOpenSkill}
          className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md border border-[#343434] bg-[#101010] text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white"
          title="スキルを呼び出す"
        >
          <SkillIcon />
          <span>スキル</span>
        </button>
      </div>

      {/* 2 段目: 参照画像チップ行（@imgN）。空のときは何も表示しない */}
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
    <div
      className="group relative h-14 w-14 overflow-hidden rounded-md border border-[#343434] bg-[#0b0b0b]"
      title={name}
    >
      <img
        src={convertFileSrc(path)}
        alt={name}
        className="h-full w-full object-cover"
      />
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
  // bookmark + sparkle のミックス。「お気に入り登録した呼び出し」を象徴
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SkillIcon() {
  // 4本の星状アイコン。「複数の力(機能)を組み合わせて使う」を象徴
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
