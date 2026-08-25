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
  durationValuesForConstraint,
  durationValuesForConstraintOrGeneric,
  intersectVideoModelCapabilities,
  type VideoModelCapabilities,
  type VideoModelDefinition,
  type VideoModelParam,
} from "../lib/videoModels";
import {
  presetKind,
  type Preset,
} from "../lib/store/presets";
import {
  appendPresetPrompt,
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
  GENERIC_REMOTE_MCP_VIDEO_RESOLUTIONS,
  reconcileRemoteMcpVideoSettings,
  type RemoteMcpVideoSettingOptions,
} from "../lib/remoteMcpModels";
import {
  useRemoteMcpGen,
  type RemoteMcpSelection,
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

function remoteSelectionCapabilities(
  selection: RemoteMcpSelection,
): VideoModelCapabilities {
  const specs = selection.model?.videoSpecs;
  return {
    duration: specs?.durationConstraint ?? null,
    aspectRatios: specs?.aspectRatios ? [...specs.aspectRatios] : null,
    // 接続先固有の追加値は既存生成経路が schema のおすすめ値を使う。
    extraParams: null,
  };
}

function commonRemoteResolutions(
  selections: readonly RemoteMcpSelection[],
): string[] | null {
  if (selections.length === 0) return null;
  const lists = selections.map((selection) => selection.model?.videoSpecs?.resolutions ?? null);
  if (lists.some((list) => list === null)) return null;
  return (lists[0] ?? []).filter((resolution) =>
    lists.slice(1).every((list) => list?.includes(resolution)),
  );
}

/**
 * 画像版 ConstructedPromptPanel の動画版。
 * 構成は画像タブと統一する:
 *   [ReferenceRack: ライブラリ/素材/追加/プリセット/スキル]
 *   [要素別編集ボタン + プロンプト textarea]
 *   [下部コントロール: モデル / 尺プルダウン / 比率 / Cost / 生成ボタン]
 *
 * 画像版との違い:
 * - 生成ロジックは useVideoSceneGeneration (mediaType=video)
 * - モデルは接続先から実取得し、尺/比率は取得仕様を useVideoGen に反映する
 */
export function VideoConstructedPromptPanel() {
  const {
    scene,
    generatedPrompt,
    model,
    promptOverride,
    setPromptOverride,
    effectivePrompt,
    hasRunningBatch,
    runningBatchCount,
    maxConcurrentBatches,
    isQueueFull,
    activeBatchSummary,
    disabled,
    generate,
  } = useVideoSceneGeneration();

  // 旧Higgsfield経路の実コスト取得にだけ使う接続判定。
  // 接続先モデルを選んだ生成は remoteMcpGen 側が担当するため、ここでは判定しない。
  const higgsfieldAuthed = useAccounts((s) => s.higgsfield.authenticated);

  const [draft, setDraft] = useState<string>(generatedPrompt);
  const [elementModalOpen, setElementModalOpen] = useState(false);
  /** 「AIで整える」実行中フラグ。二重起動を防ぐ。 */
  const [refining, setRefining] = useState(false);
  const [openSetting, setOpenSetting] = useState<
    "duration" | "aspect" | "resolution" | null
  >(null);
  const settingChipsRef = useRef<HTMLDivElement | null>(null);
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
  const remoteSelection = useRemoteMcpGen((s) => s.selections.video);
  const remoteVideoSelections = useRemoteMcpGen((s) => s.videoSelections);
  const startRemoteGeneration = useRemoteMcpGen((s) => s.startSelectedVideos);

  // 「内蔵」区分は廃止。動画は接続先から実取得したモデルだけを選択扱いにする。
  const selectedBuiltInModels = useMemo<VideoModelDefinition[]>(() => [], []);
  const selectedModelCount = selectedBuiltInModels.length + remoteVideoSelections.length;
  const compareMode = selectedModelCount >= 2;
  const selectedCapabilities = useMemo(
    () =>
      intersectVideoModelCapabilities(
        [
          ...remoteVideoSelections.map(remoteSelectionCapabilities),
        ],
      ),
    [remoteVideoSelections],
  );
  const hasUnknownRemoteSpecs =
    remoteVideoSelections.length > 0 &&
    remoteVideoSelections.some((selection) => {
      const specs = selection.model?.videoSpecs;
      return !specs?.durationConstraint || !specs.aspectRatios || !specs.resolutions;
    });
  const resolution = extraParamValues.resolution ?? GENERIC_REMOTE_MCP_VIDEO_RESOLUTIONS[0];
  const supportedResolutions = useMemo(
    () => commonRemoteResolutions(remoteVideoSelections),
    [remoteVideoSelections],
  );
  const genericVideoSettings = useMemo<RemoteMcpVideoSettingOptions>(
    () => ({
      durations: durationValuesForConstraintOrGeneric(null),
      aspectRatios: [...ALL_VIDEO_ASPECT_RATIOS],
      resolutions: [...GENERIC_REMOTE_MCP_VIDEO_RESOLUTIONS],
    }),
    [],
  );
  const reconciledVideoSettings = useMemo(
    () =>
      reconcileRemoteMcpVideoSettings(
        {
          durationConstraint: selectedCapabilities.duration,
          aspectRatios: selectedCapabilities.aspectRatios,
          resolutions: supportedResolutions,
        },
        { duration, aspectRatio, resolution },
        genericVideoSettings,
      ),
    [
      aspectRatio,
      duration,
      genericVideoSettings,
      resolution,
      selectedCapabilities.aspectRatios,
      selectedCapabilities.duration,
      supportedResolutions,
    ],
  );
  const hasNoCommonSettings =
    (selectedCapabilities.duration !== null &&
      durationValuesForConstraint(selectedCapabilities.duration).length === 0) ||
    (selectedCapabilities.aspectRatios !== null &&
      selectedCapabilities.aspectRatios.length === 0);
  const generateRef = useRef(generate);
  useEffect(() => {
    generateRef.current = generate;
  }, [generate]);

  useEffect(() => {
    if (!openSetting) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!settingChipsRef.current?.contains(event.target as Node)) setOpenSetting(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSetting(null);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openSetting]);

  const isOverriding = promptOverride !== null;

  const changeDuration = (next: number) => {
    if (remoteVideoSelections.length > 0) useVideoGen.setState({ duration: Math.max(1, next) });
    else setDuration(next);
    setOpenSetting(null);
  };

  const changeAspectRatio = (next: string) => {
    if (remoteVideoSelections.length > 0) useVideoGen.setState({ aspectRatio: next });
    else setAspectRatio(next);
    setOpenSetting(null);
  };

  const changeResolution = (next: string) => {
    setExtraParam("resolution", next);
    setOpenSetting(null);
  };

  // モデル選択が変わったら、全選択モデルが使える値へだけ安全に寄せて知らせる。
  useEffect(() => {
    if (selectedModelCount === 0 || reconciledVideoSettings.adjusted.length === 0) return;
    const next = reconciledVideoSettings.values;
    if (next.duration !== duration) useVideoGen.setState({ duration: next.duration });
    if (next.aspectRatio !== aspectRatio) {
      useVideoGen.setState({ aspectRatio: next.aspectRatio });
    }
    if (next.resolution !== resolution) setExtraParam("resolution", next.resolution);

    const labels = reconciledVideoSettings.adjusted.map((field) =>
      field === "duration" ? "尺" : field === "aspectRatio" ? "比率" : "解像度",
    );
    pushToast({
      kind: "info",
      text: `モデルの対応値に合わせて${labels.join("・")}を調整しました。`,
      ttlMs: 3500,
    });
  }, [
    aspectRatio,
    duration,
    pushToast,
    reconciledVideoSettings,
    resolution,
    setExtraParam,
    selectedModelCount,
  ]);

  const appendPreset = (preset: Preset) => {
    const current = (isOverriding ? draft : generatedPrompt).trim();
    const next = appendPresetPrompt(current, preset);
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
    if (remoteSelection || selectedModelCount === 0) {
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
    selectedModelCount,
  ]);

  const runSelectedGeneration = async () => {
    if (hasNoCommonSettings) {
      pushToast({
        kind: "error",
        text: "全モデルで共通する尺または比率がありません。モデルの選択を減らしてください。",
      });
      return;
    }
    const hasBuiltIn = selectedBuiltInModels.length > 0;
    const hasRemote = remoteVideoSelections.length > 0;
    const tasks: Promise<void>[] = [];

    if (hasBuiltIn) {
      tasks.push(
        (async () => {
          // 内蔵1件 + 接続先の混在比較では、内蔵側も1モデル1本にそろえる。
          if (compareMode && selectedBuiltInModels.length === 1 && count !== 1) {
            setCount(1);
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            await generateRef.current();
          } else {
            await generate();
          }
        })(),
      );
    }

    if (hasRemote) {
      const mentionResult = resolveImageMentions(effectivePrompt, references);
      const mentionedPaths = mentionResult.mentioned.map((mention) => mention.path);
      tasks.push(
        (async () => {
          const result = await startRemoteGeneration({
            kind: "video",
            prompt: mentionResult.cleanedPrompt.trim(),
            aspectRatio,
            resolution,
            count,
            durationSeconds: duration,
            startImagePath:
              mentionedPaths.length > 0 ? undefined : sourceImagePath ?? undefined,
            referenceImagePaths:
              mentionedPaths.length > 0
                ? mentionedPaths
                : references.map((reference) => reference.path),
            compareEach: compareMode,
          });
          if (!result.ok) pushToast({ kind: "error", text: result.message });
        })(),
      );
    }

    await Promise.all(tasks);
  };

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
        <HiggsfieldModelSelector media="video" />

        {/* 3設定は画面を覆うモーダルではなく、押したチップの直上だけで選ぶ。 */}
        <div ref={settingChipsRef} data-video-setting-chips className="grid grid-cols-3 gap-1">
          <div className="relative min-w-0">
            <VideoSettingChip
              label="尺"
              value={`${duration}秒`}
              disabled={reconciledVideoSettings.options.durations.length === 0}
              expanded={openSetting === "duration"}
              onClick={() =>
                setOpenSetting((current) => current === "duration" ? null : "duration")
              }
            />
            {openSetting === "duration" && (
              <VideoSettingPopover
                label="尺"
                value={String(duration)}
                options={reconciledVideoSettings.options.durations.map((seconds) => ({
                  value: String(seconds),
                  label: `${seconds}秒`,
                }))}
                onSelect={(next) => changeDuration(Number(next))}
              />
            )}
          </div>
          <div className="relative min-w-0">
            <VideoSettingChip
              label="比率"
              value={aspectRatio}
              disabled={reconciledVideoSettings.options.aspectRatios.length === 0}
              expanded={openSetting === "aspect"}
              onClick={() =>
                setOpenSetting((current) => current === "aspect" ? null : "aspect")
              }
            />
            {openSetting === "aspect" && (
              <VideoSettingPopover
                label="比率"
                value={aspectRatio}
                options={reconciledVideoSettings.options.aspectRatios.map((ratio) => ({
                  value: ratio,
                  label: ratio,
                }))}
                onSelect={changeAspectRatio}
              />
            )}
          </div>
          <div className="relative min-w-0">
            <VideoSettingChip
              label="解像度"
              value={resolution}
              disabled={reconciledVideoSettings.options.resolutions.length === 0}
              expanded={openSetting === "resolution"}
              onClick={() =>
                setOpenSetting((current) => current === "resolution" ? null : "resolution")
              }
            />
            {openSetting === "resolution" && (
              <VideoSettingPopover
                label="解像度"
                value={resolution}
                options={reconciledVideoSettings.options.resolutions.map((item) => ({
                  value: item,
                  label: item,
                }))}
                onSelect={changeResolution}
              />
            )}
          </div>
        </div>

        {hasUnknownRemoteSpecs && (
          <p className="text-[9px] font-bold text-amber-300">
            対応値は未取得です。非対応の値はサービス側で止まることがあります
          </p>
        )}

        {remoteVideoSelections.length === 0 && !compareMode && model.extraParams.length > 0 && (
          <div className="grid grid-cols-2 items-end gap-1.5">
            {model.extraParams.filter((param) => param.name !== "resolution").map((param) => (
              <ExtraParamControl
                key={param.name}
                param={param}
                value={extraParamValues[param.name] ?? String(param.default)}
                onChange={(next) => setExtraParam(param.name, next)}
              />
            ))}
          </div>
        )}

        {/* 生成数: 比較モードはモデル数固定、単一モードは 1〜4 選択 */}
        {compareMode ? (
          <div className="flex items-center justify-between rounded-md border border-[#2a2a2a] bg-[#101010] px-2.5 py-1.5">
            <span className="text-[10px] font-black tracking-wide text-neutral-500">
              比較生成
            </span>
            <span className="text-[11px] font-bold text-neutral-200">
              {selectedModelCount}モデルを各1本
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
        {!higgsfieldAuthed && selectedBuiltInModels.length > 0 && (
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
            selectedModelCount === 0 ||
            hasNoCommonSettings ||
            (selectedBuiltInModels.length > 0 && (disabled || !higgsfieldAuthed)) ||
            (remoteVideoSelections.length > 0 && (isQueueFull || !effectivePrompt.trim()))
          }
          title={
            selectedModelCount === 0
              ? "生成モデルを選択してください"
              : hasNoCommonSettings
              ? "全モデルで共通する尺または比率がありません"
              : selectedBuiltInModels.length === 0 || higgsfieldAuthed
                ? undefined
                : "Higgsfield 未接続のため生成できません (設定 → 接続先)"
          }
          className="h-9 w-full rounded-md bg-pink-500 px-4 py-1.5 text-sm font-black text-white transition hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {selectedModelCount === 0
            ? "モデルを選択してください"
            : selectedBuiltInModels.length > 0 && !higgsfieldAuthed
            ? "Higgsfield 未接続"
            : isQueueFull
              ? `生成中 ${runningBatchCount}/${maxConcurrentBatches}`
              : compareMode
                ? `${selectedModelCount}モデルで比較生成`
                : "動画を生成"}
        </button>

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

function VideoSettingChip({
  label,
  value,
  disabled,
  expanded,
  onClick,
}: {
  label: string;
  value: string;
  disabled: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      aria-haspopup="listbox"
      className="flex h-9 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-[#343434] bg-[#101010] px-2 text-left transition hover:border-pink-400 disabled:cursor-not-allowed disabled:border-[#292929] disabled:text-neutral-600"
      title={disabled ? `${label}に共通する対応値がありません` : `${label}を変更`}
    >
      <span className="shrink-0 text-[9px] font-black tracking-wide text-neutral-500">
        {label}
      </span>
      <span className="min-w-0 truncate text-[11px] font-black text-neutral-100">
        {disabled ? "非対応" : value}
      </span>
    </button>
  );
}

function VideoSettingPopover({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
}) {
  return (
    <div
      data-video-setting-popover={label}
      role="listbox"
      aria-label={`${label}を選択`}
      className="absolute bottom-full left-0 z-40 mb-1 max-h-48 w-full min-w-[108px] overflow-y-auto rounded-md border border-[#3a3a3a] bg-[#181818] p-1 shadow-2xl"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(option.value)}
            className={[
              "block w-full rounded px-2 py-1.5 text-left text-[11px] font-bold transition",
              selected
                ? "bg-pink-500/15 text-pink-200"
                : "text-neutral-300 hover:bg-[#242424] hover:text-white",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
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

/** 生成数 (1〜4) + 合計コスト (単価 × 本数)。不明なら接続先での確認を案内する。 */
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
          {loading
            ? "確認中…"
            : total === null
              ? "消費量は各サービスの表示を確認"
              : `約${total}cr`}
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
