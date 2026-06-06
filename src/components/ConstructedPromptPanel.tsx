import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSceneGeneration } from "../lib/scene/useSceneGeneration";
import { aspectRatioOptions, type SceneOption } from "../lib/scene/catalog";
import type { SceneAspectRatio } from "../lib/scene/types";
import { useComposer, type Reference } from "../lib/store/composer";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";
import { useSceneStore } from "../lib/store/scene";
import { useWorkspace } from "../lib/store/workspace";
import {
  presetAttachedImagesToReferences,
  type Preset,
} from "../lib/store/presets";
import { HiggsfieldModelSelector } from "./HiggsfieldModelSelector";
import { OptionPickerModal } from "./scene/OptionPickerModal";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { SkillPickerPopover } from "./SkillPickerPopover";
import { PromptTextareaWithMentions } from "./PromptTextareaWithMentions";
import { ElementwisePromptModal } from "./ElementwisePromptModal";
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
 *
 * STΛCK 指示 (2026-05-19, 修正版):
 * - 数字は白で統一 (ピンクはやめる)
 * - フォントサイズは固定値 (全カードで同じ)
 * - サムネ枠の中に必ず収まる (max-side を 70% に制限)
 * - 背景にグラデ、内側カードに薄ストロークでアスペクト比を視覚化
 */
function aspectThumbnail(ratio: string): { src: string; alt: string } {
  const [wStr, hStr] = ratio.split(":");
  const w = parseInt(wStr, 10) || 1;
  const h = parseInt(hStr, 10) || 1;
  // canvas は 16:9 想定 (PickerCard が aspect-video のため)
  const canvasW = 320;
  const canvasH = 180;
  // 内側 rect は canvas の 70% を上限に、アスペクト比に応じて自動調整
  const maxW = canvasW * 0.7;
  const maxH = canvasH * 0.7;
  const ratioWH = w / h;
  let rectW: number;
  let rectH: number;
  if (ratioWH >= maxW / maxH) {
    // 横長 → 幅で制約
    rectW = maxW;
    rectH = rectW / ratioWH;
  } else {
    // 縦長 → 高さで制約
    rectH = maxH;
    rectW = rectH * ratioWH;
  }
  const x = (canvasW - rectW) / 2;
  const y = (canvasH - rectH) / 2;
  // 文字サイズは全カード固定 (28px)。色は白。
  const fontSize = 28;
  const gradId = `bg-${ratio.replace(":", "x")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1a1a1a"/>
        <stop offset="100%" stop-color="#0a0a0a"/>
      </linearGradient>
    </defs>
    <rect width="${canvasW}" height="${canvasH}" fill="url(#${gradId})"/>
    <rect x="${x}" y="${y}" width="${rectW}" height="${rectH}" rx="4" fill="#202020" stroke="#3a3a3a" stroke-width="1"/>
    <text x="${canvasW / 2}" y="${canvasH / 2 + fontSize * 0.34}" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff" letter-spacing="-1">${ratio}</text>
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
  /**
   * F-#5 (Ta4low さん要望) + STΛCK 指示 (2026-05-19):
   * 要素別編集は ConstructedPromptPanel 内のトグルではなく、独立した
   * 中央モーダルで開く。狭い PC でも十分なサイズで編集できる。
   */
  const [elementModalOpen, setElementModalOpen] = useState(false);
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

  /**
   * プリセット選択時の追記。既存プロンプト末尾に「, 」で繋げる。空なら本文のみ。
   *
   * F-#7 (2026-05-19): プリセットに attachedImages があれば、参照画像として
   * composer に流し込む。Ta4low さん「プリセットでキャラ画像も呼び出し」対応。
   */
  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    const next = current ? `${current}, ${preset.prompt}` : preset.prompt;
    onChangeDraft(next);
    // F-#6/#7: プリセットに参照画像があれば composer.references にも自動追加。
    // role 検証は presetAttachedImagesToReferences 側で済み (不正値は undefined)。
    const refs = presetAttachedImagesToReferences(preset);
    if (refs.length > 0) {
      useComposer.getState().addReferences(refs as Reference[]);
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

  /**
   * STΛCK 指示 (2026-05-19): シーン構築で値を選んだら即プロンプトに反映する。
   *
   * 旧版は一度 promptOverride に値が入ると、シーン構築で何を選んでも上書きされ
   * 続けて反映されなかった (「自動に戻す」ボタンを押すまで止まる)。
   *
   * generatedPrompt が変化 = シーン構築 (主役/光/カメラ/スタイル) のどれかが
   * 更新された = ユーザーがシーン構築 UI を操作した、と判定して promptOverride を
   * 自動で解除する。
   *
   * 注意: 「手書きで textarea を編集」した時の onChangeDraft でも generatedPrompt
   * は変わらない (=この useEffect は発火しない) ので、手書き編集は壊れない。
   */
  // 前回の generatedPrompt を保持。マウント直後やタブ切替直後の「初回計算」では
  // override をクリアしないようにする (企画タブから採用したプロンプトが消えるバグ修正)。
  const prevGeneratedRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevGeneratedRef.current;
    prevGeneratedRef.current = generatedPrompt;
    // 初回 (prev===null): まだシーン構築を操作していない。override は維持する。
    // 2回目以降で generatedPrompt が「実際に変化」したときだけ = ユーザーが
    // シーン構築 UI を操作したときだけ override を解除する。
    if (prev === null) return;
    if (prev === generatedPrompt) return;
    if (promptOverride !== null && promptOverride !== generatedPrompt) {
      setPromptOverride(null);
    }
    // promptOverride / setPromptOverride を依存に入れない (無限ループ回避)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedPrompt]);

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
    // STΛCK 報告 (2026-05-17 v0.6.7): 13インチWindows高DPI(縦512px)で
    // 下部の生成ボタンが画面外に押し出される問題への根本対処。
    //
    // Codex クロスレビュー指摘の通り、二重スクロールを避けつつ
    // 「下部コントロールが必ず見える」を担保する。
    //
    // 構造:
    //   <section h-full min-h-0 flex-col>      ← 外枠固定高さ
    //     <ReferenceRack shrink-0>             ← 上部、潰れない
    //     <スクロール領域 flex-1 min-h-0       ← ここだけスクロール
    //        overflow-y-auto>
    //       <textarea min-h-[80px]>
    //     </スクロール領域>
    //     <下部コントロール shrink-0>          ← 必ず最下部
    <section className="flex h-full min-h-0 flex-col bg-[#181818]">
      {/*
        STΛCK 指示 (2026-05-19): 縦並びを以下に再構成。
        - 上: 「ライブラリ / 素材 / 追加 / プリセット / スキル」
              (シーン構築パネルの直下、参照追加系)
        - 区切り線 (ReferenceRack 内の border-b で既に表現済み)
        - 中: 「⛶ 要素別編集」ボタン (textarea の直前で目立たせる)
        - 下: プロンプト textarea
      */}
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
      {/*
        textarea は flex-1 で残り高さを取る。13インチでは min-h を
        撤廃して完全に潰せるようにする (下部コントロールが必ず見える)。
        13インチ以上 (画面高さ 720px超) では @media で復活させ、
        通常の使用感は維持する。
      */}
      <div className="shrink-13-textarea flex min-h-[80px] flex-1 flex-col p-3">
        <div className="mb-1.5 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setElementModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 transition hover:border-pink-400 hover:text-white"
            title="要素別編集モーダルを開く — 構図/光/カメラ等を中央画面で個別に編集"
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

      {/*
        下部コントロール (モデル選択 / 枚数 / アスペクト / 生成ボタン).
        shrink-0 で常に最下部に固定。textarea (上の flex-1) が縮むことで
        どんな画面高さでも生成ボタンが画面内に見える設計。
        STΛCK 指示 (2026-05-17): 内部スクロールではなく、全体が見える
        ことを優先。間隔も space-y-2 に詰めて高さを節約。
      */}
      <div className="shrink-13-controls shrink-0 space-y-1.5 border-t border-[#2a2a2a] p-2.5">
        <HiggsfieldModelSelector media={modelMedia} />

        {/*
          STΛCK 指示 (2026-05-17 第3版): 老眼ターゲット向けに stepper と
          アスペクト比ボタンを大きくする。1 行は維持しつつ h-9 に統一して
          押しやすさを確保。アスペクト比のヒントは text-xs に拡大。
        */}
        <div className="flex items-center gap-2">
          {/* 生成枚数 */}
          <div className="flex items-center gap-1 rounded-md border border-[#343434] bg-[#101010]">
            <button
              type="button"
              onClick={decrement}
              disabled={count <= 1}
              className="shrink-13-row h-9 w-9 text-base font-bold text-neutral-300 hover:bg-[#1f1f1f] disabled:cursor-not-allowed disabled:text-neutral-600"
              title="生成枚数を減らす"
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
              className="shrink-13-row w-9 border-0 bg-transparent text-center text-base font-bold text-neutral-100 outline-none"
              title="生成枚数"
            />
            <button
              type="button"
              onClick={increment}
              disabled={count >= MAX_COUNT}
              className="shrink-13-row h-9 w-9 text-base font-bold text-neutral-300 hover:bg-[#1f1f1f] disabled:cursor-not-allowed disabled:text-neutral-600"
              title="生成枚数を増やす"
            >
              +
            </button>
          </div>

          {/* アスペクト比 */}
          <button
            type="button"
            onClick={() => setAspectPickerOpen(true)}
            className="shrink-13-row flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-[#343434] bg-[#101010] px-2.5 text-left text-sm font-semibold text-neutral-100 outline-none transition hover:border-[#444] hover:bg-[#151515] focus:border-pink-500"
            title="アスペクト比を選ぶ"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-bold text-neutral-100">{aspectRatio}</span>
              <span className="truncate text-xs font-medium text-neutral-500">
                {ASPECT_RATIO_HINTS[aspectRatio as SceneAspectRatio] ?? ""}
              </span>
            </span>
            <span className="shrink-0 text-xs text-neutral-500" aria-hidden>
              ▾
            </span>
          </button>
        </div>

        {hasRunningBatch && activeBatchSummary && (
          <p className="flex items-center justify-between gap-2 text-[11px] font-semibold text-neutral-400">
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
          className="w-full rounded-md bg-pink-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
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
        onPick={(path, stockSource) => {
          // ストック素材のクレジット情報を Reference に保持する。
          // 完成作品のエクスポート時に「素材出典一覧」を出すための土台
          // (2026-05-21 法務対応)。
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
      {/*
        STΛCK 指示 (2026-05-19): 要素別編集モーダル。
        ConstructedPromptPanel 内の狭い textarea ではなく、画面中央に大きく開く
        ことで、どの PC サイズでも快適に編集できる。
      */}
      <ElementwisePromptModal
        open={elementModalOpen}
        prompt={isOverriding ? draft : generatedPrompt}
        onClose={() => setElementModalOpen(false)}
        onApply={onChangeDraft}
      />
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
  // STΛCK 指示 (2026-05-19): どのデバイス幅でもラベル1行表示を厳守。
  // - 旧版は text-[10px] leading-tight でも幅不足で「ライブラ/リ」と
  //   2行に折り返していた
  // - whitespace-nowrap + overflow-hidden で 1 行強制
  // - text-[9px] にダウンサイズ + tracking-tighter で詰める
  // - もしそれでも枠から溢れる場合は truncate で省略表示
  const iconBtn =
    "shrink-13-rack flex h-14 w-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-[#343434] bg-[#101010] px-1 text-[9px] font-bold leading-tight tracking-tighter text-neutral-300 transition hover:border-pink-400 hover:text-white";
  // ラベル <span> 共通クラス: 改行禁止 + はみ出し省略
  const iconLabel = "block w-full truncate whitespace-nowrap text-center";
  /*
    STΛCK 指示 (2026-05-20): ボタン群 (ライブラリ/素材/追加/プリセット/スキル)
    全体を drop target 化。生成タイムラインや拡大プレビューから画像を
    投げ込むと、ボタンの「クリックで開く」機能は維持しつつ、参照ラックに
    画像を直接追加する別経路を提供する。
  */
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const { refs, files } = extractDropped(event.dataTransfer);
    const composer = useComposer.getState();
    if (refs.length > 0) {
      composer.addReferences(
        refs.map((r) => ({
          path: r.path,
          name: r.name,
          source: r.source,
          role: r.role,
        })),
      );
    }
    if (files.length > 0) {
      void Promise.all(files.map((f) => fileToUploadReference(f))).then(
        (uploadedRefs) => {
          composer.addReferences(uploadedRefs);
        },
      );
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
      {/* 操作ボタン (アイコン上 / 文字下) を常に横並び */}
      <div className="grid grid-cols-5 gap-1.5">
        <button
          type="button"
          onClick={onOpenLibrary}
          className={iconBtn}
          title="このアプリで生成した画像から選ぶ"
        >
          <LibraryIcon />
          <span className={iconLabel}>ライブラリ</span>
        </button>
        <button
          type="button"
          onClick={onOpenStock}
          className={iconBtn}
          title="ストック素材 API から写真を検索"
        >
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
        <button
          ref={presetButtonRef}
          type="button"
          onClick={onOpenPreset}
          className={iconBtn}
          title="登録済みプロンプトを呼び出す"
        >
          <PresetIcon />
          <span className={iconLabel}>プリセット</span>
        </button>
        <button
          ref={skillButtonRef}
          type="button"
          onClick={onOpenSkill}
          className={iconBtn}
          title="スキルを呼び出す"
        >
          <SkillIcon />
          <span className={iconLabel}>スキル</span>
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

/** 要素別編集 — 4 分割グリッドで「カテゴリ別に分けて編集」を象徴 */
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
