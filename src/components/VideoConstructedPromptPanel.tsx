import { useEffect, useMemo, useRef, useState } from "react";

import { SafeImage } from "./SafeImage";
import { higgsfieldMcp, type HiggsfieldMcpCostArgs } from "../lib/ipc";
import { paramsToVideoArgs, useVideoSceneGeneration } from "../lib/scene/useVideoSceneGeneration";
import { resolveImageMentions } from "../lib/scene/resolveImageMentions";
import { buildVideoScenePromptJson } from "../lib/scene/buildVideoScenePrompt";
import type { VideoPromptJson } from "../lib/scene/buildPromptJson";
import {
  stringifyPromptByFormat,
  type PromptFormat,
} from "../lib/scene/promptFormat";
import { refineVideoInput } from "../lib/scene/refinePrompt";
import { useRefineFormat } from "../lib/store/refineFormat";
import { useToasts } from "../lib/store/toasts";
import { useAccounts } from "../lib/store/accounts";
import { useComposer, type Reference } from "../lib/store/composer";
import { useVideoGen } from "../lib/store/videoGen";
import {
  extractDropped,
  fileToUploadReference,
  isImageDrop,
} from "../lib/dragRef";
import {
  ALL_VIDEO_ASPECT_RATIOS,
  VIDEO_MODELS,
  modelSupportsAspect,
  videoModelSpecItems,
  type VideoModelDefinition,
  type VideoModelParam,
} from "../lib/videoModels";
import {
  presetKind,
  type Preset,
} from "../lib/store/presets";
import {
  composePresetPrompt,
  selectCharacterReferences,
} from "../lib/presets/character";
import { PresetPickerPopover } from "./PresetPickerPopover";
import { SkillPickerPopover } from "./SkillPickerPopover";
import { PromptTextareaWithMentions } from "./PromptTextareaWithMentions";
import { ElementwisePromptModal } from "./ElementwisePromptModal";
import { ReferenceLibraryModal } from "./ReferenceLibraryModal";
import { ReferencePicker } from "./ReferencePicker";
import { StockSearchModal } from "./StockSearchModal";
import { HiggsfieldModelSelector } from "./HiggsfieldModelSelector";
import {
  isRemoteMcpJobRunning,
  useRemoteMcpGen,
} from "../lib/store/remoteMcpGen";

type CostState =
  | { kind: "idle"; value: number | null; source: "api" | "static" | null }
  | { kind: "loading"; value: number | null; source: "api" | "static" | null }
  | { kind: "error"; value: number | null; source: "static" | null };

/**
 * 動画モデル + 尺 から Higgsfield MCP のコスト見積もり引数を組む (2026-06-10 段階8)。
 * jobSetType→model に対応付け、mediaType="video" を立て、paramsToVideoArgs のうち
 * MCP が受け取るフラグ (mode/resolution/sound/genre/modelVariant) だけを展開する。
 * quality / i2vInputField は MCP が使わないので落とす。動画コストは duration/mode 等で
 * 変わるため、生成と同じパラメータを渡さないと表示と実コストがずれる。
 */
function toMcpCostArgs(
  model: VideoModelDefinition,
  prompt: string,
  aspect: string,
  duration: number,
  selectedParams: Record<string, string>,
): HiggsfieldMcpCostArgs {
  const { quality: _q, i2vInputField: _i, ...mcpParams } = paramsToVideoArgs(
    model.extraParams,
    selectedParams,
  );
  void _q;
  void _i;
  return {
    prompt,
    model: model.jobSetType,
    aspect,
    mediaType: "video",
    duration,
    ...mcpParams,
  };
}

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
    scene,
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

  // API-02 (2026-07-25): 動画生成は必ず Higgsfield MCP (higgsfieldMcp.generateBatch) を叩く。
  // 未接続のまま押せると MCP エラーで落ち、ユーザーには原因が見えなかった。
  // 接続済み判定は HiggsfieldModelSelector と同じ accounts.higgsfield.authenticated を正とする。
  const higgsfieldAuthed = useAccounts((s) => s.higgsfield.authenticated);

  const [draft, setDraft] = useState<string>(generatedPrompt);
  const [elementModalOpen, setElementModalOpen] = useState(false);
  /** 「AIで整える」実行中フラグ。二重起動を防ぐ。 */
  const [refining, setRefining] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const removeReferenceGroup = useComposer((s) => s.removeReferenceGroup);

  const setModel = useVideoGen((s) => s.setModel);
  const duration = useVideoGen((s) => s.duration);
  const setDuration = useVideoGen((s) => s.setDuration);
  const aspectRatio = useVideoGen((s) => s.aspectRatio);
  const sourceImagePath = useVideoGen((s) => s.sourceImagePath);
  const pushToast = useToasts((s) => s.push);
  /** 「AIで整える」の出力形式。画像と動画で独立に記憶する。 */
  const format = useRefineFormat((s) => s.video);
  const setFormat = useRefineFormat((s) => s.setVideo);
  const setAspectRatio = useVideoGen((s) => s.setAspectRatio);
  const count = useVideoGen((s) => s.count);
  const setCount = useVideoGen((s) => s.setCount);
  const extraParamValues = useVideoGen((s) => s.extraParamValues);
  const setExtraParam = useVideoGen((s) => s.setExtraParam);
  const compareModelIds = useVideoGen((s) => s.compareModelIds);
  const toggleCompareModel = useVideoGen((s) => s.toggleCompareModel);
  const compareMode = compareModelIds.length >= 2;
  const remoteSelection = useRemoteMcpGen((s) => s.selections.video);
  const latestRemoteRequestId = useRemoteMcpGen((s) => s.latestRequestId.video);
  const latestRemoteJob = useRemoteMcpGen((s) => {
    const requestId = s.latestRequestId.video;
    return requestId ? (s.jobs[requestId] ?? null) : null;
  });
  const remoteValidationMessage = useRemoteMcpGen((s) => s.validationMessage.video);
  const startRemoteGeneration = useRemoteMcpGen((s) => s.start);
  const retryRemoteGeneration = useRemoteMcpGen((s) => s.retry);

  const isOverriding = promptOverride !== null;

  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    // キャラ型プリセットは属性テキストも合成 (プロンプト型は preset.prompt のまま)。
    const presetBody = composePresetPrompt(preset, ", ");
    const next = current ? `${current}, ${presetBody}` : presetBody;
    onChangeDraft(next);
    // F-#6/#7: プリセットの参照画像を composer.references に自動追加。
    // キャラ型は既定3枚に絞り、同一キャラを1チップに畳む groupId/groupLabel を付ける。
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
    if (promptOverride === null) {
      setDraft(generatedPrompt);
    } else if (promptOverride !== draft) {
      setDraft(promptOverride);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedPrompt, promptOverride]);

  // D-4 と同型の override 消失バグ修正 (ConstructedPromptPanel.tsx L151-167 参照)。
  // 旧版はガード無しで、generatedPrompt が変化するたびに override を解除していた。
  // そのため「タブ切替でのアンマウント→再マウント初回」など、ユーザーがシーンを
  // 操作していないのに effect が走る局面で、手入力の override が消えていた。
  //
  // 動画版の generatedPrompt は buildVideoScenePrompt(scene) 由来でアスペクト比を
  // 含まないため、これがそのまま「シーン構築のシグネチャ」になる。prevSceneSigRef
  // で「前回と比べて実際にシーンが変化したときだけ」override を解除する。初回
  // (prev===null) は解除しない。
  const sceneSignature = generatedPrompt;
  const prevSceneSigRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSceneSigRef.current;
    prevSceneSigRef.current = sceneSignature;
    if (prev === null) return;
    if (prev === sceneSignature) return;
    if (promptOverride !== null && promptOverride !== generatedPrompt) {
      setPromptOverride(null);
    }
    // sceneSignature の変化だけをトリガーにする (無限ループ回避)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneSignature]);

  /** 選択から積まれた動画JSON。要素数の表示とAI整形の両方で使う。 */
  const videoPromptJson = useMemo(
    () => buildVideoScenePromptJson(scene, { aspectRatio, durationSeconds: duration }),
    [scene, aspectRatio, duration],
  );
  /** 表示中のテキスト。これが「整える対象」の正 (override 設計と一致させる)。 */
  const displayed = (isOverriding ? draft : generatedPrompt).trim();

  /**
   * 直前の整形結果。形式だけ切り替えたいときに LLM を呼ばず再シリアライズする。
   * 永続化しない (タブ離脱で消えてよい)。
   */
  const lastRefinedRef = useRef<{
    json: VideoPromptJson;
    texts: Record<PromptFormat, string>;
  } | null>(null);

  /**
   * 「AIで整える」— 動画用の構造化テキストへ整えて textarea に入れる。
   * 画像とは別スキーマ (subject_motion / camera_motion / duration_seconds /
   * timeline 等)。入力ソースは問わない (手入力・企画由来も整う)。
   * override として入るので「自動に戻す」で元に戻せる。
   */
  const refineVideoPromptWithAi = async () => {
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
      const result = await refineVideoInput(
        isOverriding
          ? { kind: "text", text: draft }
          : { kind: "structured", json: videoPromptJson },
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

  const onChangeDraft = (next: string) => {
    setDraft(next);
    // 動画タブでの手編集は i2v 文脈。値があるときは出自 "i2v" を維持し、別スキル
    // 切替の clear から保護する (R-1)。generatedPrompt と同値なら override 解除
    // (null + 出自は image デフォルトに戻す。「override なしなのに source=i2v」を作らない)。
    if (next === generatedPrompt) {
      setPromptOverride(null);
    } else {
      setPromptOverride(next, "i2v");
    }
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
    if (remoteSelection) {
      setCost({ kind: "idle", value: null, source: null });
      return () => {
        cancelled = true;
      };
    }
    // @imgN を除去した本文でコスト計算する。
    // Higgsfield CLI は --prompt 内の "@..." をファイル参照と解釈するため、
    // @img1 を残すと "Failed to read img1" でコスト計算が失敗する (2026-06-04 修正)。
    const prompt = resolveImageMentions(effectivePrompt, references).cleanedPrompt.trim();
    // API-02: 未接続なら get_cost も必ず MCP エラーになる。静的見積もりのまま置き、
    // 入力のたびに失敗する MCP 呼び出しを投げない (エラーを増やさない)。
    if (!prompt || !higgsfieldAuthed) {
      setCost({ kind: "idle", value: fallback, source: "static" });
      return () => {
        cancelled = true;
      };
    }
    setCost({ kind: "loading", value: fallback, source: "static" });
    const timer = window.setTimeout(() => {
      higgsfieldMcp
        // コストは mode/resolution/genre 等でも変わるため全て渡す (MCP 互換に整形)。
        .generateCost(toMcpCostArgs(model, prompt, aspectRatio, duration, extraParamValues))
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
    // higgsfieldAuthed を依存に入れる: 接続直後に実コストを取り直すため。
  }, [
    model,
    effectivePrompt,
    references,
    aspectRatio,
    duration,
    extraParamValues,
    higgsfieldAuthed,
    remoteSelection,
  ]);

  const runSelectedGeneration = async () => {
    if (!remoteSelection) {
      await generate();
      return;
    }
    const result = await startRemoteGeneration({
      kind: "video",
      prompt: effectivePrompt,
      aspectRatio,
      count,
      durationSeconds: duration,
      startImagePath: sourceImagePath ?? undefined,
      referenceImagePaths: references.map((reference) => reference.path),
    });
    if (!result.ok) pushToast({ kind: "error", text: result.message });
  };

  const retryRemote = async () => {
    if (!latestRemoteRequestId) return;
    const result = await retryRemoteGeneration(latestRemoteRequestId);
    if (!result.ok) pushToast({ kind: "error", text: result.message });
  };

  const remoteRunning = isRemoteMcpJobRunning(latestRemoteJob);

  // 設定サマリ行のラベル。
  // 比較モード: 「N モデルで比較 · 16:9」。単一モード: 「Kling · 9秒 · 16:9 · ...」
  const settingsSummary = compareMode
    ? [
        `${compareModelIds.length} モデルで比較`,
        aspectRatio,
      ].join(" · ")
    : [
        model.label,
        `${duration}秒`,
        aspectRatio,
        ...model.extraParams.map(
          (param) => `${param.label}${extraParamValues[param.name] ?? String(param.default)}`,
        ),
      ].join(" · ");

  return (
    <section
      data-tour="video-generation-controls"
      className="flex h-full min-h-0 flex-col bg-[#181818]"
    >
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

      <div
        data-tour="video-generation-prompt"
        className="shrink-13-textarea flex min-h-[80px] flex-1 flex-col p-3"
      >
        <div className="mb-1.5 flex items-center justify-end gap-1.5">
          {/*
            「AIで整える」— 要素別編集の左 (STΛCK指示 2026-07-25)。
            動画は画像と別スキーマ (時間軸の軸を持つ) の JSON へ整える。
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
            onClick={() => void refineVideoPromptWithAi()}
            disabled={refining || displayed.length === 0}
            className="flex items-center gap-1.5 rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-400 transition hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            title="選んだ要素や入力したプロンプトを、動画生成AIが読みやすい構造化プロンプト（JSON / YAML）に整えます。動画は時間軸に沿って整えます。要素は足しません"
          >
            <SparkleIcon />
            <span>{refining ? "整えています…" : "AIで整える"}</span>
          </button>
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

      <div className="shrink-13-controls shrink-0 space-y-1 border-t border-[#2a2a2a] p-2">
        <HiggsfieldModelSelector
          media="video"
          fallbackLabel="Higgsfield（既存の動画生成）"
        />

        {/* 設定サマリ行 (モデル/尺/比率/モデル別パラメータ) → タップでモーダル */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-[#343434] bg-[#101010] px-2.5 text-left transition hover:border-pink-400"
          title="モデル・尺・比率・詳細設定を開く"
        >
          <SettingsGearIcon />
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-neutral-200">
            {settingsSummary}
          </span>
          <span className="shrink-0 text-[10px] font-black text-neutral-500">変更</span>
        </button>

        {/* 生成数: 比較モードはモデル数固定、単一モードは 1〜4 選択 */}
        {compareMode && !remoteSelection ? (
          <div className="flex items-center justify-between rounded-md border border-[#2a2a2a] bg-[#101010] px-2.5 py-1.5">
            <span className="text-[10px] font-black tracking-wide text-neutral-500">
              比較生成
            </span>
            <span className="text-[11px] font-bold text-neutral-200">
              {compareModelIds.length}モデルを各1本
            </span>
          </div>
        ) : (
          <CountAndCostControl
            count={count}
            onChangeCount={setCount}
            unitCost={remoteSelection ? null : cost.value}
            loading={!remoteSelection && cost.kind === "loading"}
          />
        )}

        {hasRunningBatch && activeBatchSummary && (
          <p className="flex items-center justify-between gap-2 text-[11px] font-semibold text-neutral-400">
            <span>生成中 {runningBatchCount}/{maxConcurrentBatches}</span>
            <span className="text-[10px] text-neutral-500">先頭 {activeBatchSummary}</span>
          </p>
        )}

        {/* API-02: 未接続を「押せるが落ちる」から「押せない + 次の一手が読める」へ。
            原因不明のエラーで終わらせないため、案内をボタンの直上に置く。 */}
        {!higgsfieldAuthed && !remoteSelection && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2">
            <p className="text-[11px] font-black text-amber-200">
              Higgsfield に接続してください
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">
              動画生成は Higgsfield を使います。設定 → 接続先 → HiggsField を接続すると
              このボタンが押せるようになります。
            </p>
          </div>
        )}

        <button
          data-tour="video-generation-submit"
          type="button"
          onClick={() => void runSelectedGeneration()}
          disabled={
            remoteSelection
              ? remoteRunning || !effectivePrompt.trim()
              : disabled || !higgsfieldAuthed
          }
          title={
            remoteSelection || higgsfieldAuthed
              ? undefined
              : "Higgsfield 未接続のため生成できません (設定 → 接続先)"
          }
          className="h-9 w-full rounded-md bg-pink-500 px-4 py-1.5 text-sm font-black text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {remoteSelection && remoteRunning
            ? latestRemoteJob?.phase === "saving"
              ? "保存中…"
              : "生成中…"
            : !remoteSelection && !higgsfieldAuthed
            ? "Higgsfield 未接続"
            : !remoteSelection && isQueueFull
              ? `生成中 ${runningBatchCount}/${maxConcurrentBatches}`
              : !remoteSelection && compareMode
                ? `${compareModelIds.length}モデルで比較生成`
                : "動画を生成"}
        </button>

        {(latestRemoteJob || remoteValidationMessage) && (
          <div
            data-request-id={latestRemoteJob?.requestId}
            className={
              latestRemoteJob?.phase === "error" || (!latestRemoteJob && remoteValidationMessage)
                ? "rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-xs font-semibold text-red-300"
                : "rounded-md border border-[#2a2a2a] bg-[#101010] px-2.5 py-2 text-xs font-semibold text-neutral-400"
            }
          >
            <p>
              {latestRemoteJob?.phase === "done"
                ? "保存が完了しました。動画はギャラリー・履歴へ自動登録されます。"
                : latestRemoteJob?.message ?? remoteValidationMessage}
            </p>
            {latestRemoteJob?.phase === "error" && (
              <button
                type="button"
                onClick={() => void retryRemote()}
                className="mt-2 rounded border border-red-300/30 px-2 py-1 text-[11px] font-bold text-red-200 hover:bg-red-500/10"
              >
                再試行
              </button>
            )}
          </div>
        )}

        {!remoteSelection && status.kind !== "idle" && (
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
      <VideoSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        model={model}
        onModelChange={setModel}
        duration={duration}
        onDurationChange={setDuration}
        aspectRatio={aspectRatio}
        onAspectRatioChange={setAspectRatio}
        extraParamValues={extraParamValues}
        onExtraParamChange={setExtraParam}
        compareModelIds={compareModelIds}
        onToggleCompareModel={toggleCompareModel}
      />
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
      <div className="space-y-0.5">
        <p className="block h-3.5 text-[10px] font-black leading-[14px] tracking-wide text-neutral-500">尺</p>
        <div className="grid grid-cols-3 gap-1">
          {model.duration.values.map((seconds) => (
            <button
              key={seconds}
              type="button"
              onClick={() => onChange(seconds)}
              className={[
                "h-8 rounded-md border px-1 text-[10px] font-black transition",
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
    <div className="space-y-0.5">
      <p className="block h-3.5 text-[10px] font-black leading-[14px] tracking-wide text-neutral-500">尺</p>
      <div className="flex h-8 items-center rounded-md border border-[#343434] bg-[#101010]">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          className="h-8 w-8 rounded-l-md text-sm font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を短くする"
        >
          −
        </button>
        <div className="flex-1 text-center text-xs font-black text-white">{value}秒</div>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          className="h-8 w-8 rounded-r-md text-sm font-black text-neutral-300 hover:bg-[#222] hover:text-white"
          aria-label="尺を長くする"
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * 比率セレクタ。全モデルの比率 (ALL_VIDEO_ASPECT_RATIOS) を並べ、選択中モデルが
 * 未対応のものはグレーアウト (disabled) して「このモデルは未対応」を明示する。
 * 旧版は model.aspectRatios だけを出していたため、ユーザーには「なぜこの比率が
 * 選べないのか」が見えなかった (clampAspect の裏補正が黙って走るだけだった)。
 */
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
    <div className="space-y-0.5">
      <p className="block h-3.5 text-[10px] font-black leading-[14px] tracking-wide text-neutral-500">
        比率
      </p>
      <div className="grid grid-cols-4 gap-1">
        {ALL_VIDEO_ASPECT_RATIOS.map((ratio) => {
          const supported = modelSupportsAspect(model, ratio);
          const selected = supported && value === ratio;
          return (
            <button
              key={ratio}
              type="button"
              disabled={!supported}
              onClick={() => onChange(ratio)}
              title={supported ? ratio : `${model.label} はこの比率に未対応`}
              className={[
                "h-8 rounded-md border px-1 text-[10px] font-black transition",
                selected
                  ? "border-pink-400 bg-pink-500/10 text-white"
                  : supported
                    ? "border-[#2a2a2a] bg-[#101010] text-neutral-400 hover:border-neutral-500"
                    : "cursor-not-allowed border-[#1e1e1e] bg-[#0b0b0b] text-neutral-700",
              ].join(" ")}
            >
              {ratio}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** モデル別パラメータ (音声/解像度/genre/quality/mode 等) の汎用コントロール */
function ExtraParamControl({
  param,
  value,
  onChange,
}: {
  param: VideoModelParam;
  value: string;
  onChange: (next: string) => void;
}) {
  if (param.kind === "boolean") {
    const on = value === "true" || value === "on";
    return (
      <div className="space-y-0.5">
        <p className="block h-3.5 text-[10px] font-black leading-[14px] tracking-wide text-neutral-500">{param.label}</p>
        <button
          type="button"
          onClick={() => onChange(on ? "off" : "on")}
          className={[
            "h-8 w-full rounded-md border px-2 text-xs font-black transition",
            on
              ? "border-pink-400 bg-pink-500/10 text-white"
              : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-neutral-500",
          ].join(" ")}
        >
          {on ? "ON" : "OFF"}
        </button>
      </div>
    );
  }
  if (param.kind === "integer") {
    return (
      <div className="space-y-0.5">
        <p className="block h-3.5 text-[10px] font-black leading-[14px] tracking-wide text-neutral-500">{param.label}</p>
        <input
          type="number"
          min={param.min}
          max={param.max}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs font-bold text-neutral-100 outline-none transition hover:border-[#444] focus:border-pink-500"
        />
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-black tracking-wide text-neutral-500">{param.label}</p>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs font-bold text-neutral-100 outline-none transition hover:border-[#444] focus:border-pink-500"
      >
        {param.values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 生成数 (1〜4) + 合計コスト (単価 × 本数)。「約N credits」だけ表示。 */
function CountAndCostControl({
  count,
  onChangeCount,
  unitCost,
  loading,
}: {
  count: number;
  onChangeCount: (n: number) => void;
  unitCost: number | null;
  loading: boolean;
}) {
  const total = unitCost === null ? null : unitCost * count;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black tracking-wide text-neutral-500">生成数</p>
        <span className="text-[11px] font-black text-pink-200">
          {loading ? "確認中…" : total === null ? "—" : `約${total} credits`}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChangeCount(n)}
            className={[
              "h-8 rounded-md border text-xs font-black transition",
              count === n
                ? "border-pink-400 bg-pink-500/10 text-white"
                : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-neutral-500",
            ].join(" ")}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 動画設定モーダル (モデル / 尺 / 比率 / モデル別パラメータ)。
 * 下部コントロールを圧迫しないよう、頻繁に変えない設定はここに逃がす。
 * 生成数・生成ボタンは下部常駐のまま。
 */
function VideoSettingsModal({
  open,
  onClose,
  model,
  onModelChange,
  duration,
  onDurationChange,
  aspectRatio,
  onAspectRatioChange,
  extraParamValues,
  onExtraParamChange,
  compareModelIds,
  onToggleCompareModel,
}: {
  open: boolean;
  onClose: () => void;
  model: VideoModelDefinition;
  onModelChange: (id: VideoModelDefinition["id"]) => void;
  duration: number;
  onDurationChange: (duration: number) => void;
  aspectRatio: string;
  onAspectRatioChange: (aspectRatio: string) => void;
  extraParamValues: Record<string, string>;
  onExtraParamChange: (name: string, value: string) => void;
  compareModelIds: VideoModelDefinition["id"][];
  onToggleCompareModel: (id: VideoModelDefinition["id"]) => void;
}) {
  const compareMode = compareModelIds.length >= 2;
  const pushToast = useToasts((s) => s.push);

  /**
   * B-7 (2026-07-30): モデル追加の要望テンプレをコピーする。アプリ内に要望
   * フォーム/外部 URL が無いため、送り先は「ユーザーがアプリを受け取った窓口」
   * に委ねる (存在しない URL を作らない)。
   */
  function copyModelRequestTemplate() {
    const text = [
      "【GORI GORI KUN 動画モデルの要望】",
      "使いたいモデル: ",
      "作りたいもの・用途: ",
      `いま使えるモデル: ${VIDEO_MODELS.map((m) => m.label).join(" / ")}`,
    ].join("\n");
    void navigator.clipboard.writeText(text).then(
      () => {
        pushToast({
          kind: "success",
          text: "要望テンプレをコピーしました。いつもの窓口に貼って送ってください。",
          ttlMs: 4000,
        });
      },
      () => {
        pushToast({ kind: "error", text: "コピーに失敗しました。", ttlMs: 4000 });
      },
    );
  }

  // モデル変更でアスペクト比が自動補正されたときの通知 (store 由来)。
  // モーダルを閉じたら通知を消す (次に開いたとき古い通知が残らないように)。
  const aspectAdjustment = useVideoGen((s) => s.lastAspectAdjustment);
  const clearAspectAdjustment = useVideoGen((s) => s.clearAspectAdjustment);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) clearAspectAdjustment();
  }, [open, clearAspectAdjustment]);

  // 比較リストの各モデルのコストを実 API で計算する (静的 costEstimate ではなく)。
  // 比較生成は「共通 duration を各モデルに丸める + 各モデルおすすめ設定」で走るため、
  // コスト計算も同じ条件で行う (toCompareModel と整合)。
  const [compareCosts, setCompareCosts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(
        VIDEO_MODELS.map(async (m) => {
          const d =
            m.duration.kind === "enum"
              ? m.duration.values.includes(duration)
                ? duration
                : m.duration.default
              : Math.min(m.duration.max, Math.max(m.duration.min, duration));
          try {
            // 各モデルおすすめ設定 (selected を渡さず空 → param.default) でコスト計算。
            const credits = await higgsfieldMcp.generateCost(
              toMcpCostArgs(m, "preview", aspectRatio, d, {}),
            );
            return [m.id, credits] as const;
          } catch {
            return null;
          }
        }),
      ).then((pairs) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const pair of pairs) {
          if (pair) next[pair[0]] = pair[1];
        }
        setCompareCosts(next);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, duration, aspectRatio]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-2.5">
          <p className="text-xs font-black tracking-wide text-neutral-200">動画の設定</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-[#222] hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="space-y-3 p-3">
          {/* モデル */}
          <div className="space-y-0.5">
            <label htmlFor="video-model-select" className="text-[10px] font-black tracking-wide text-neutral-500">
              モデル
            </label>
            <select
              id="video-model-select"
              value={model.id}
              onChange={(event) => onModelChange(event.currentTarget.value as VideoModelDefinition["id"])}
              className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs font-bold text-neutral-100 outline-none transition hover:border-[#444] focus:border-pink-500"
              title={model.description}
            >
              {VIDEO_MODELS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}{item.id === "kling3_0" ? "（おすすめ）" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* B-7 (2026-07-30): 説明はツールチップだけだと気づかれないため常時表示。
              モデルの追加方針も見える化する (裏付けのない「近日追加」は書かない)。 */}
          <p className="text-[10px] leading-relaxed text-neutral-500">
            {model.description}
          </p>
          {/* 6cn (B-7 追補): 対応状況は VIDEO_MODELS 定義から決定論で表示 (手書きと二重管理しない) */}
          <div className="space-y-1 rounded-md border border-[#262626] bg-[#101010] p-2">
            {videoModelSpecItems(model).map((item) => (
              <div key={item.label} className="flex items-baseline gap-2">
                <span className="w-[72px] shrink-0 text-[9px] font-black tracking-wide text-neutral-600">
                  {item.label}
                </span>
                <span className="text-[10px] font-bold leading-snug text-neutral-300">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-1 rounded-md border border-[#262626] bg-[#101010] p-2">
            <p className="text-[10px] leading-relaxed text-neutral-500">
              使えるモデルはアプリの更新で追加されます。使いたいモデルがあれば、下のボタンで要望テンプレをコピーして、いつもの窓口（コミュニティや配布元）に貼ってください。
            </p>
            <button
              type="button"
              onClick={copyModelRequestTemplate}
              className="rounded-md border border-[#343434] bg-[#181818] px-2 py-1 text-[10px] font-bold text-neutral-300 transition hover:border-pink-500/40 hover:text-pink-200"
            >
              モデルの要望をコピー
            </button>
          </div>

          {/* 比較生成 (A案: 各モデルをデフォルト設定で1本ずつ並べる) */}
          <div className="space-y-1.5 rounded-md border border-[#262626] bg-[#101010] p-2.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black tracking-wide text-neutral-500">
                モデル比較
              </p>
              <span className="text-[10px] font-bold text-neutral-500">
                2〜4モデルで同時生成
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1">
              {VIDEO_MODELS.map((item) => {
                const checked = compareModelIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onToggleCompareModel(item.id)}
                    className={[
                      "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs font-bold transition",
                      checked
                        ? "border-pink-400 bg-pink-500/10 text-white"
                        : "border-[#2a2a2a] bg-[#181818] text-neutral-300 hover:border-neutral-500",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                        checked
                          ? "border-pink-400 bg-pink-500 text-white"
                          : "border-[#444] bg-transparent text-transparent",
                      ].join(" ")}
                    >
                      ✓
                    </span>
                    <span className="flex-1 truncate">
                      {item.label}
                      {item.id === "kling3_0" ? "（おすすめ）" : ""}
                    </span>
                    <span className="shrink-0 text-[10px] font-normal text-neutral-500">
                      約{compareCosts[item.id] ?? item.costEstimate}cr
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] leading-relaxed text-neutral-500">
              {compareMode
                ? `${compareModelIds.length}モデルを比較します。尺・比率は共通で適用、モデル固有設定(モード/解像度等)は各モデルのおすすめ値を使います。`
                : "2つ以上選ぶと比較モードになります（各モデルはおすすめ設定で生成）。"}
            </p>
          </div>

          {/* 尺 + 比率: 比較モードでも共通設定として効かせる。
              比率は全モデルぶんを並べて未対応をグレーアウトするため、尺とは別行にして
              横幅をフルに使う。 */}
          <div className="space-y-1.5">
            <div className="grid grid-cols-1 gap-1.5">
              <DurationControl model={model} value={duration} onChange={onDurationChange} />
            </div>
            <AspectControl model={model} value={aspectRatio} onChange={onAspectRatioChange} />
            {aspectAdjustment && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-bold leading-snug text-amber-300">
                モデル変更のため {aspectAdjustment.to} に調整しました（{aspectAdjustment.from} は{" "}
                {model.label} 未対応）
              </p>
            )}
          </div>

          {/* モデル別パラメータ(mode/resolution/genre等)は単一モード時のみ
              (比較時はモデルごとに項目が違うため各デフォルトを使う) */}
          {!compareMode && model.extraParams.length > 0 && (
            <div className="grid grid-cols-2 items-end gap-1.5">
              {model.extraParams.map((param) => (
                <ExtraParamControl
                  key={param.name}
                  param={param}
                  value={extraParamValues[param.name] ?? String(param.default)}
                  onChange={(next) => onExtraParamChange(param.name, next)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-[#2a2a2a] p-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-full rounded-md bg-pink-500 text-sm font-black text-white transition hover:bg-pink-600"
          >
            完了
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsGearIcon() {
  return (
    <svg className="shrink-0 text-neutral-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 参照画像ラック (画像版 ConstructedPromptPanel と同じ 5 ボタン構成)。 */
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
          {renderReferenceChips(references, onRemove, onRemoveGroup)}
        </div>
      )}
    </div>
  );
}

/**
 * 参照チップを描画する。groupId 付きの参照は1チップ「@<groupLabel>」に畳む。
 * `@imgN` の N は参照の絶対位置(index+1)を保ち、エンジンへの採番は変えない。
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
      <SafeImage path={path} alt={name} className="h-full w-full object-cover" fallbackLabel="なし" />
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
      <SafeImage path={path} alt={label} className="h-full w-full object-cover" fallbackLabel="なし" />
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

/** 「AIで整える」用。きらめき (絵文字を使わずフラットアイコンで表現)。 */
function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z" />
      <path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" />
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
