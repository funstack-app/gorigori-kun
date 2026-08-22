import { useEffect, useMemo, useRef, useState } from "react";
import { useSceneGeneration } from "../lib/scene/useSceneGeneration";
import { buildPromptForOverrideCompare } from "../lib/scene/buildPrompt";
import {
  buildImagePromptJson,
  type ImagePromptJson,
} from "../lib/scene/buildPromptJson";
import {
  stringifyPromptByFormat,
  type PromptFormat,
} from "../lib/scene/promptFormat";
import { refineImageInput } from "../lib/scene/refinePrompt";
import { useRefineFormat } from "../lib/store/refineFormat";
import { useToasts } from "../lib/store/toasts";
import type { SceneAspectRatio } from "../lib/scene/types";
import {
  ASPECT_RATIO_HINTS,
  ASPECT_RATIO_PICKER_OPTIONS,
} from "../lib/scene/aspectRatioPicker";
import { useComposer, type Reference } from "../lib/store/composer";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";
import { useSceneStore } from "../lib/store/scene";
import { useWorkspace } from "../lib/store/workspace";
import {
  presetKind,
  type Preset,
} from "../lib/store/presets";
import {
  composePresetPrompt,
  selectCharacterReferences,
} from "../lib/presets/character";
import { HiggsfieldModelSelector } from "./HiggsfieldModelSelector";
import { SafeImage } from "./SafeImage";
import { OptionPickerModal } from "./scene/OptionPickerModal";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { SkillPickerPopover } from "./SkillPickerPopover";
import { PromptTextareaWithMentions } from "./PromptTextareaWithMentions";
import { ElementwisePromptModal } from "./ElementwisePromptModal";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { ReferencePicker } from "./ReferencePicker";
import { StockSearchModal } from "./StockSearchModal";
import { SketchPadModal } from "./sketch/SketchPadModal";

const MAX_COUNT = 30;

/**
 * Compact prompt + generation control. Header is intentionally removed
 * so the panel is shorter; the prompt textarea is the visual anchor.
 */
export function ConstructedPromptPanel() {
  const {
    scene,
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
  /** 「AIで整える」実行中フラグ。二重起動を防ぐ。 */
  const [refining, setRefining] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);
  /**
   * スケッチパッド (Wave 4 Slice A)。
   * 旧 PromptComposer にしか繋がっておらず実機で到達できなかったため、
   * 現行の生成タブ本体である本パネルのボタン列にも取り付ける。
   */
  const [sketchOpen, setSketchOpen] = useState(false);
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
  const removeReferenceGroup = useComposer((s) => s.removeReferenceGroup);
  const purpose = useWorkspace((s) => s.purpose);
  const modelMedia = purpose === "videoStory" ? "video" : "image";
  const aspectRatio = useSceneStore((s) => s.subjectFraming.aspectRatio);
  const setSubjectFramingField = useSceneStore((s) => s.setSubjectFramingField);
  const pushToast = useToasts((s) => s.push);
  /** 「AIで整える」の出力形式。画像と動画で独立に記憶する。 */
  const format = useRefineFormat((s) => s.image);
  const setFormat = useRefineFormat((s) => s.setImage);

  /**
   * プリセット選択時の追記。既存プロンプト末尾に「, 」で繋げる。空なら本文のみ。
   *
   * F-#7 (2026-05-19): プリセットに attachedImages があれば、参照画像として
   * composer に流し込む。Ta4low さん「プリセットでキャラ画像も呼び出し」対応。
   */
  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    // キャラ型プリセットは preset.prompt に加えて属性テキスト (characterMeta.attributes)
    // を合成する (プロンプト型は composePresetPrompt が preset.prompt をそのまま返す)。
    const presetBody = composePresetPrompt(preset, ", ");
    const next = current ? `${current}, ${presetBody}` : presetBody;
    onChangeDraft(next);
    // F-#6/#7: プリセットに参照画像があれば composer.references にも自動追加。
    // role 検証は presetAttachedImagesToReferences 側で済み (不正値は undefined)。
    // キャラ型は速度対策で既定3枚に絞り (selectCharacterReferences)、
    // 同一キャラを1チップに畳むため groupId/groupLabel を付ける。
    const isCharacter = presetKind(preset) === "character";
    const refs = selectCharacterReferences(preset);
    if (refs.length > 0) {
      const withGroup = isCharacter
        ? refs.map((r) => ({
            ...r,
            groupId: `preset:${preset.id}`,
            groupLabel: preset.name.trim() || "キャラ",
          }))
        : refs;
      useComposer.getState().addReferences(withGroup as Reference[]);
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
  // 前回の「アスペクト比を除いた」プロンプトを保持。マウント直後やタブ切替直後の
  // 「初回計算」では override をクリアしないようにする (企画タブから採用したプロンプトが
  // 消えるバグ修正)。
  //
  // DEV-PLAYBOOK §6 D / Ta4low さん系FB修正 (2026-06-16):
  // 旧版は generatedPrompt そのもの (アスペクト比を含む) を比較していたため、
  // アスペクト比だけ変えても「シーン構築を操作した」と誤判定して手入力プロンプトを
  // 破棄していた。アスペクト比は画像サイズ指定でありシーン記述ではないので、
  // buildPromptForOverrideCompare (アスペクト比を除いた版) で「実際にシーン要素が
  // 変わったか」だけを判定する。generatedPrompt 本文 (生成に渡す文字列) は従来どおり
  // アスペクト比を含んだままなので、生成側への影響はゼロ。
  const sceneSignature = buildPromptForOverrideCompare(scene);
  const prevSceneSigRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSceneSigRef.current;
    prevSceneSigRef.current = sceneSignature;
    // 初回 (prev===null): まだシーン構築を操作していない。override は維持する。
    // 2回目以降で sceneSignature が「実際に変化」したときだけ = ユーザーが
    // シーン構築 UI を操作したときだけ override を解除する (アスペクト比変更は除く)。
    if (prev === null) return;
    if (prev === sceneSignature) return;
    if (promptOverride !== null && promptOverride !== generatedPrompt) {
      setPromptOverride(null);
    }
    // promptOverride / generatedPrompt / setPromptOverride を依存に入れない
    // (無限ループ回避。sceneSignature の変化だけをトリガーにする)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneSignature]);

  const isOverriding = promptOverride !== null;

  const onChangeDraft = (next: string) => {
    setDraft(next);
    setPromptOverride(next === generatedPrompt ? null : next);
  };

  const onResetOverride = () => {
    setPromptOverride(null);
    setDraft(generatedPrompt);
  };

  /** 選択から積まれた JSON を取り出す (シーン構築由来のAI整形で使う)。 */
  const scenePromptJson = useMemo(
    () => buildImagePromptJson(scene),
    // scene の中身が変わったときだけ作り直す
    [scene],
  );

  /** 表示中のテキスト。これが「整える対象」の正 (override 設計と一致させる)。 */
  const displayed = (isOverriding ? draft : generatedPrompt).trim();

  /**
   * 直前の整形結果。形式だけ切り替えたいときに LLM を呼ばず再シリアライズする。
   * 永続化しない (タブ離脱で消えてよい。消えても LLM 経路で同じ結果になる)。
   */
  const lastRefinedRef = useRef<{
    json: ImagePromptJson;
    texts: Record<PromptFormat, string>;
  } | null>(null);

  /**
   * 「AIで整える」— 構造化テキストを textarea に入れる。
   *
   * 入力ソースは問わない (2026-08-03 STΛCK指示 ②): シーン構築の選択でも、
   * 手入力でも、企画タブから採用したテキストでも整う。表示中のテキストが
   * override なら「テキスト入力」、無ければ「シーン構築の構造化 JSON」を整える。
   * 結果は override として入るので「自動に戻す」で元に戻せる。
   */
  const refinePromptWithAi = async () => {
    if (refining) return;
    if (!displayed) {
      pushToast({
        kind: "info",
        text: "整える内容がありません。左で要素を選ぶか、プロンプトを入力してください。",
        ttlMs: 3000,
      });
      return;
    }

    // 直前の整形結果がそのまま表示されているなら、形式変換だけで済ませる。
    const last = lastRefinedRef.current;
    if (
      last &&
      (displayed === last.texts.json.trim() || displayed === last.texts.yaml.trim())
    ) {
      onChangeDraft(last.texts[format]);
      pushToast({ kind: "info", text: "形式を変換しました。", ttlMs: 3000 });
      return;
    }

    setRefining(true);
    try {
      const result = await refineImageInput(
        isOverriding
          ? { kind: "text", text: draft }
          : { kind: "structured", json: scenePromptJson },
      );
      if (result.json === null) {
        pushToast({
          kind: "error",
          text: `AIの整形は使えませんでした（プロンプトはそのままです）: ${result.error ?? ""}`,
          ttlMs: 5000,
        });
        return;
      }
      const texts: Record<PromptFormat, string> = {
        json: stringifyPromptByFormat(result.json, "json"),
        yaml: stringifyPromptByFormat(result.json, "yaml"),
      };
      if (!texts[format]) {
        pushToast({ kind: "info", text: "整える要素がありません。", ttlMs: 3000 });
        return;
      }
      lastRefinedRef.current = { json: result.json, texts };
      onChangeDraft(texts[format]);
      if (result.refined) {
        pushToast({ kind: "success", text: "プロンプトを整えました。", ttlMs: 3000 });
      } else if (result.converted) {
        pushToast({ kind: "info", text: "形式を変換しました。", ttlMs: 3000 });
      } else {
        pushToast({
          kind: "info",
          text: `AIの整形は使えませんでした（選んだ内容を${format === "yaml" ? "YAML" : "JSON"}にしました）: ${result.error ?? ""}`,
          ttlMs: 5000,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `整形に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    } finally {
      setRefining(false);
    }
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
        - 中: 「要素別編集」ボタン (textarea の直前で目立たせる)
        - 下: プロンプト textarea
      */}
      <div className="shrink-0">
        <ReferenceRack
          references={references}
          onRemove={(path) => removeReference(path)}
          onRemoveGroup={(groupId) => removeReferenceGroup(groupId)}
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
      <div
        data-tour="generation-prompt"
        className="prompt-row-container shrink-13-textarea flex min-h-[80px] flex-1 flex-col p-3"
      >
        <div className="mb-1.5 flex items-center justify-end gap-1.5">
          {/* スケッチ — プロンプトを作る手段の同族（ui-placement-grammar §2）。
              描いた絵を参照に追加/ブロックアウト化/3Dシーン化して生成の入力にする。
              mr-auto は「右3つと視覚分離する」ためだけのもの。狭幅のはみ出し対策は
              mr-auto ではなく App.css の @container promptrow が担う
              （mr-auto は余った幅を配るだけで、足りないときは効かない。Sol 指摘 2026-08-04）。 */}
          <button
            type="button"
            onClick={() => setSketchOpen(true)}
            title="スケッチ — 自分で描いた絵を参照に追加 / 3Dシーンに変換"
            aria-label="スケッチを開く"
            className="mr-auto flex h-[26px] w-[26px] items-center justify-center rounded border border-[#343434] bg-[#101010] text-neutral-400 transition hover:border-pink-400 hover:text-white"
          >
            <SketchIcon />
          </button>
          {/*
            「AIで整える」— 要素別編集の左に置く (STΛCK指示 2026-07-25)。
            選択から積まれた JSON を、生成AIが読みやすい構造化プロンプトへ整える。
            余計な要素を足さない・長くしないことをシステムプロンプトとコード両方で縛る。
          */}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as PromptFormat)}
            title="「AIで整える」の出力形式を選びます"
            aria-label="整形の出力形式"
            className="h-[26px] rounded border border-[#343434] bg-[#101010] px-1.5 text-[10px] font-bold text-neutral-400 outline-none transition hover:border-pink-400 focus:border-pink-500"
          >
            <option value="json">JSON</option>
            <option value="yaml">YAML</option>
          </select>
          <button
            type="button"
            onClick={() => void refinePromptWithAi()}
            disabled={refining || displayed.length === 0}
            className="prompt-row-compact-btn flex items-center gap-1.5 rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 transition hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            title="選んだ要素や入力したプロンプトを、AIが読みやすい構造化プロンプト（JSON / YAML）に整えます。要素は足しません"
            aria-label="AIで整える"
          >
            <SparkleIcon />
            <span className="prompt-row-compact-label">
              {refining ? "整えています…" : "AIで整える"}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setElementModalOpen(true)}
            className="prompt-row-compact-btn flex items-center gap-1.5 rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 transition hover:border-pink-400 hover:text-white"
            title="要素別編集モーダルを開く — 構図/光/カメラ等を中央画面で個別に編集"
            aria-label="要素別編集"
          >
            <ElementGridIcon />
            <span className="prompt-row-compact-label">要素別編集</span>
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
            <span className="shrink-0 text-neutral-500">
              <ChevronDownIcon />
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
          data-tour="generation-submit"
          onClick={() => void generate()}
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
      {/*
        スケッチパッド。「参照に追加」は useComposer.addReferences を叩くので、
        本パネルが表示している references ラックと、生成が読む
        useSceneGeneration.refImagePaths の両方にそのまま載る。
      */}
      <SketchPadModal open={sketchOpen} onClose={() => setSketchOpen(false)} />
    </section>
  );
}

/**
 * 参照画像ラック（Magnific 風）。
 * プロンプト textarea のすぐ上に置き、現在の参照（@imgN）を一覧表示する。
 * - 「ライブラリ」ボタン: 過去生成画像から選ぶモーダルを開く
 * - 「素材」ボタン: 接続済みストック素材 API から検索して追加する
 * - 「追加」ボタン: ローカル PC から画像を選ぶ（ReferencePicker 経由）
 * - 各チップにマウスを乗せると閉じるボタンで外せる
 */
function ReferenceRack({
  references,
  onRemove,
  onRemoveGroup,
  onOpenLibrary,
  onOpenStock,
  onOpenPreset,
  presetButtonRef,
  onOpenSkill,
  skillButtonRef,
}: {
  references: ReturnType<typeof useComposer.getState>["references"];
  onRemove: (path: string) => void;
  onRemoveGroup: (groupId: string) => void;
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
      {/* 操作ボタン (アイコン上 / 文字下) を常に横並び。
          参照を足す手段の同族列。上限5 (ui-placement-grammar §3)。 */}
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

      {/* 2 段目: 参照画像チップ行（@imgN）。空のときは何も表示しない。
          同一グループ(キャラ)は1チップ「@<キャラ名>」に畳んで表示し、削除もまとめて。 */}
      {references.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {renderReferenceChips(references, onRemove, onRemoveGroup)}
        </div>
      )}
    </div>
  );
}

/**
 * 参照チップを描画する。groupId 付きの参照は1チップに畳む(「@<groupLabel>」)。
 * `@imgN` の N は参照の絶対位置(index+1)を保つ。グループは代表(先頭メンバー)の
 * サムネと枚数を出し、削除はグループ全体に効く。
 */
function renderReferenceChips(
  references: ReturnType<typeof useComposer.getState>["references"],
  onRemove: (path: string) => void,
  onRemoveGroup: (groupId: string) => void,
) {
  const renderedGroups = new Set<string>();
  return references.map((ref, index) => {
    if (ref.groupId) {
      if (renderedGroups.has(ref.groupId)) return null;
      renderedGroups.add(ref.groupId);
      const members = references.filter((r) => r.groupId === ref.groupId);
      const groupId = ref.groupId;
      return (
        <GroupReferenceChip
          key={`group:${groupId}`}
          label={ref.groupLabel || "キャラ"}
          path={ref.path}
          count={members.length}
          onRemove={() => onRemoveGroup(groupId)}
        />
      );
    }
    return (
      <ReferenceChip
        key={ref.path}
        index={index + 1}
        path={ref.path}
        name={ref.name}
        onRemove={() => onRemove(ref.path)}
      />
    );
  });
}

/** キャラ等の参照グループを1つに畳んだチップ。ラベルは `@<キャラ名>`。 */
function GroupReferenceChip({
  label,
  path,
  count,
  onRemove,
}: {
  label: string;
  path: string;
  count: number;
  onRemove: () => void;
}) {
  return (
    <div
      className="group relative h-14 w-14 overflow-hidden rounded-md border border-pink-400/60 bg-[#0b0b0b]"
      title={`${label}（参照${count}枚）`}
    >
      <SafeImage
        path={path}
        alt={label}
        className="h-full w-full object-cover"
      />
      <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 text-[9px] font-black text-pink-200">
        @{label}
      </span>
      {count > 1 && (
        <span className="absolute left-0.5 top-0.5 rounded bg-pink-500/90 px-1 text-[9px] font-black text-white">
          {count}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="キャラ参照を外す"
        className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/80 text-white group-hover:flex hover:bg-red-500"
      >
        <CloseIcon />
      </button>
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
      <SafeImage
        path={path}
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
        className="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/80 text-white group-hover:flex hover:bg-red-500"
      >
        <CloseIcon />
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

/** スケッチ — 鉛筆。「自分で描く」を象徴 */
function SketchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
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

/** 「AIで整える」用。きらめき (絵文字を使わずフラットアイコンで表現)。 */
function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z" />
      <path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" />
    </svg>
  );
}

/** チップの「外す」ボタン用。× 記号でなくフラットアイコンで描く。 */
function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** アスペクト比セレクタの開閉インジケータ (記号でなくフラットアイコン)。 */
function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
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
