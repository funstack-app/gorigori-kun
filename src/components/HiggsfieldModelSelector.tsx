import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { higgsfieldMcp, type HiggsfieldModelInfo } from "../lib/ipc";
import { buildPrompt } from "../lib/scene/buildPrompt";
import { resolveImageMentions } from "../lib/scene/resolveImageMentions";
import {
  FEATURED_IMAGE_MODELS,
  FEATURED_VIDEO_MODELS,
  MODEL_DESCRIPTIONS,
  dedupeModels,
  getDisplayName,
  getModelLabel,
  type ModelLabel,
} from "../lib/higgsfield/unlimited";
import { staticModelsFor } from "../lib/higgsfield/staticCatalog";
import { useHiggsfieldModel, type SelectedModel } from "../lib/store/higgsfieldModel";
import { useMagnificModel, MAX_MAGNIFIC_COMPARE } from "../lib/store/magnificModel";
import { useAccounts } from "../lib/store/accounts";
import { FEATURED_MAGNIFIC_IMAGE_MODELS, getMagnificModelName } from "../lib/magnific/models";
import { useSceneStore } from "../lib/store/scene";
import { useScenePromptOverride } from "../lib/store/scenePrompt";
import { useToasts } from "../lib/store/toasts";

// 接続先タブ (2026-06-08)。デフォルト(コア)の下にタブを置き、接続先ごとにモデルを切り替える。
type ProviderTab = "default" | "higgsfield" | "magnific";

type LoadState = "idle" | "loading" | "ready" | "missing" | "needsAuth" | "error";
type CostState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; credits: number }
  | { kind: "error" };

type ModelSection = {
  title: string;
  items: HiggsfieldModelInfo[];
};

const CODEX_STANDARD_LABEL = "GPT Image 2 (デフォルト)";
const PICKER_WIDTH = 390;
const MAX_COMPARE_MODELS = 4;

// モデル一覧の localStorage キャッシュ (2026-06-10)。
// 直接呼び出し化で取得は1-2秒に縮んだが、キャッシュがあれば開いた瞬間に表示し、
// 裏で最新を取得して差し替える (stale-while-revalidate)。
const MODEL_CACHE_PREFIX = "gori.higgsfield.models.";

type ModelCache = {
  models: HiggsfieldModelInfo[];
  planType: string | null;
  savedAt: number;
};

function readModelCache(media: "image" | "video"): ModelCache | null {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_PREFIX + media);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelCache;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeModelCache(media: "image" | "video", cache: ModelCache) {
  try {
    localStorage.setItem(MODEL_CACHE_PREFIX + media, JSON.stringify(cache));
  } catch {
    // localStorage が使えなくてもキャッシュ無しで動くだけ (致命ではない)。
  }
}

export function HiggsfieldModelSelector({ media }: { media: "image" | "video" }) {
  const selectedModels = useHiggsfieldModel((s) => s.selectedModels);
  const setSelectedModels = useHiggsfieldModel((s) => s.setSelectedModels);
  // Magnific選択をトリガーボタンに反映するため、メイン関数でも購読する(2026-06-08)。
  const selectedMagnificForTrigger = useMagnificModel((s) => s.selectedModels);
  // 段階7 (2026-06-10): Higgsfield は MCP接続方式に移行。installed 概念を廃止し、
  // 接続済み判定は accounts.higgsfield.authenticated (MCP status 由来) を正とする。
  const higgsfieldAuthed = useAccounts((s) => s.higgsfield.authenticated);
  const pushToast = useToasts((s) => s.push);
  const [models, setModels] = useState<HiggsfieldModelInfo[]>([]);
  const [planType, setPlanType] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const subjectFraming = useSceneStore((state) => state.subjectFraming);
  const lightingMood = useSceneStore((state) => state.lightingMood);
  const camera = useSceneStore((state) => state.camera);
  const style = useSceneStore((state) => state.style);
  const reference = useSceneStore((state) => state.reference);
  const promptOverride = useScenePromptOverride((s) => s.value);
  const promptForCost = useMemo(() => {
    const raw =
      promptOverride ??
      buildPrompt({ subjectFraming, lightingMood, camera, style, reference });
    // Higgsfield CLI は --prompt 内の "@..." をファイル参照と解釈するため、
    // @imgN を残すとコスト計算が "Failed to read ..." で失敗する (2026-06-04 修正)。
    return resolveImageMentions(raw, []).cleanedPrompt;
  }, [promptOverride, subjectFraming, lightingMood, camera, style, reference]);
  const aspectForCost = subjectFraming.aspectRatio;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadState("loading");
      setOpen(false);
      setModels([]);
      setPlanType(null);
      // 段階7: installed 概念を廃止。接続済み判定は MCP status 由来の
      // accounts.higgsfield.authenticated を正とする。未認証なら拡張未接続
      // (= GPT Image 2 デフォルトで動く正常状態) として needsAuth で抜ける。
      if (!higgsfieldAuthed) {
        if (cancelled) return;
        setLoadState("needsAuth");
        return;
      }

      // キャッシュ (なければ静的カタログ) を即表示し、裏で最新を取得して差し替える
      // (stale-while-revalidate)。「モデル一覧を確認中...」でピッカーがブロックされる
      // 時間をゼロにする (2026-06-10 実機FB)。
      const cached = readModelCache(media);
      if (!cancelled) {
        setModels(cached ? cached.models : staticModelsFor(media));
        setPlanType(cached?.planType ?? null);
        setLoadState("ready");
      }

      try {
        // モデル一覧 / アカウント情報は mcpServer/tool/call の直接呼び出し
        // (models_explore / balance、実測1-2秒。LLM 仲介は 2026-06-10 に全廃)。
        const [nextModels, account] = await Promise.all([
          higgsfieldMcp.listModels(media),
          higgsfieldMcp.account().catch((err) => {
            // account は任意なので失敗しても null で degrade し、一覧表示は止めない。
            console.error("[HiggsfieldModelSelector] account fetch failed:", err);
            return null;
          }),
        ]);
        if (cancelled) return;
        const planType = account?.subscriptionPlanType ?? null;
        setModels(nextModels);
        setPlanType(planType);
        setLoadState("ready");
        writeModelCache(media, { models: nextModels, planType, savedAt: Date.now() });
      } catch (err) {
        if (cancelled) return;
        // キャッシュ or 静的カタログを既に表示しているので、UI は止めず静かに degrade。
        // (静的カタログの model id でも生成は通る。サーバ側で検証される)
        console.error("[HiggsfieldModelSelector] model list refresh failed:", err);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [media, pushToast, higgsfieldAuthed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // HiggsField 未接続でも GPT Image 2 (デフォルト) を使えるので、
  // picker を開けるようにする。読み込み中だけ disabled。
  const disabled = loadState === "loading" || loadState === "idle";
  const selectedJobSetTypes = useMemo(
    () => new Set(selectedModels.map((model) => model.jobSetType)),
    [selectedModels],
  );
  const triggerText = getTriggerText(selectedModels, selectedMagnificForTrigger);
  const helperText = getHelperText(loadState, selectedModels.length);
  const sections = useMemo(() => buildSections(media, models, query), [media, models, query]);
  const totalVisibleModels = sections.reduce((sum, section) => sum + section.items.length, 0);

  const toggleOpen = () => {
    if (disabled) return;
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen((current) => !current);
  };

  const toggleModel = (model: SelectedModel) => {
    if (selectedJobSetTypes.has(model.jobSetType)) {
      setSelectedModels(
        selectedModels.filter((selected) => selected.jobSetType !== model.jobSetType),
      );
      return;
    }
    if (selectedModels.length >= MAX_COMPARE_MODELS) return;
    setSelectedModels([...selectedModels, model]);
  };

  return (
    <div ref={containerRef} className="relative space-y-1">
      {/*
        STΛCK 指示 (2026-05-17): 老眼ターゲット向けに行を縦分割。
        ラベルを上に置いてボタンに横幅をフル開放、ギチギチ感を解消。

        F-#10 修正 (2026-05-19): marche_izm さん Windows 11 13インチ報告で
        モデルカードの表示位置に違和感とあるため、ラベル「生成モデル」を
        ボタン内に統合した左寄せキャプションに変更。
        他の下部コントロール (枚数/アスペクト) はラベルなしの単行ボタンで
        揃えているため、ここだけラベルが上にあると縦余白がズレて見える。
      */}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        className="shrink-13-row flex h-9 w-full items-center justify-between gap-2 rounded-md border border-[#343434] bg-[#101010] px-2.5 text-left text-sm font-semibold text-neutral-100 outline-none transition hover:border-[#444] hover:bg-[#151515] focus:border-pink-500 disabled:cursor-not-allowed disabled:text-neutral-600"
        title="生成モデル"
      >
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-neutral-500">
          モデル
        </span>
        <span className="min-w-0 flex-1 truncate text-right">{triggerText}</span>
        {selectedModels.length > 1 && (
          <span className="shrink-0 rounded bg-pink-500/20 px-1.5 py-0.5 text-xs font-semibold text-pink-200">
            {selectedModels.length}
          </span>
        )}
        <ChevronDownIcon />
      </button>
      {helperText && (
        <p
          className={
            loadState === "ready" && selectedModels.length > 0
              ? "text-[11px] font-medium text-amber-300"
              : "text-[11px] font-medium text-neutral-500"
          }
        >
          {helperText}
        </p>
      )}

      {open && (
        <ModelPickerPopover
          anchorRect={anchorRect}
          loadState={loadState}
          query={query}
          onQueryChange={setQuery}
          sections={sections}
          totalVisibleModels={totalVisibleModels}
          selectedModels={selectedModels}
          selectedJobSetTypes={selectedJobSetTypes}
          planType={planType}
          prompt={promptForCost}
          aspect={aspectForCost}
          onPickCodex={() => setSelectedModels([])}
          onToggleModel={toggleModel}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ModelPickerPopover({
  anchorRect,
  loadState: _loadState,
  query,
  onQueryChange,
  sections,
  totalVisibleModels,
  selectedModels,
  selectedJobSetTypes,
  planType,
  prompt,
  aspect,
  onPickCodex,
  onToggleModel,
  onClose,
}: {
  anchorRect: DOMRect | null;
  loadState: LoadState;
  query: string;
  onQueryChange: (query: string) => void;
  sections: ModelSection[];
  totalVisibleModels: number;
  selectedModels: SelectedModel[];
  selectedJobSetTypes: Set<string>;
  planType: string | null;
  prompt: string;
  aspect: string;
  onPickCodex: () => void;
  onToggleModel: (model: SelectedModel) => void;
  onClose: () => void;
}) {
  const [cost, setCost] = useState<CostState>({ kind: "idle" });
  const selectedCount = selectedModels.length;

  // Magnific オプショナル拡張 (2026-06-08)。接続済みのときだけタブが出る(degrade)。
  const setSelectedModels = useHiggsfieldModel((s) => s.setSelectedModels);
  const magnificAuthed = useAccounts((s) => s.magnific.authenticated);
  const selectedMagnificModels = useMagnificModel((s) => s.selectedModels);
  const toggleMagnific = useMagnificModel((s) => s.toggleModel);
  const clearMagnific = useMagnificModel((s) => s.clear);
  const magnificCount = selectedMagnificModels.length;
  const [providerTab, setProviderTab] = useState<ProviderTab>(
    magnificCount > 0 ? "magnific" : selectedCount > 0 ? "higgsfield" : "default",
  );

  // Magnific 未接続なのに magnific タブが開いたままだと、タブボタンは消えるのに
  // 中身 (モデル一覧+選択チェック) だけ残る (2026-06-10 実機FB)。強制的に default へ戻す。
  useEffect(() => {
    if (!magnificAuthed && providerTab === "magnific") {
      setProviderTab("default");
      if (magnificCount > 0) clearMagnific();
    }
  }, [magnificAuthed, providerTab, magnificCount, clearMagnific]);

  useEffect(() => {
    let cancelled = false;
    if (selectedModels.length === 0) {
      setCost({ kind: "idle" });
      return;
    }
    setCost({ kind: "loading" });
    Promise.all(
      selectedModels.map((model) =>
        higgsfieldMcp.generateCost({
          // 段階8: MCP コスト見積もり。jobSetType→model に対応付ける。
          // media 未指定なので image 扱い (このセレクタは画像/動画両方で使うが
          // generateCost の動画パラメータは未使用。動画コストは動画パネル側で計算)。
          model: model.jobSetType,
          prompt,
          aspect,
        }),
      ),
    )
      .then((credits) => {
        if (!cancelled) {
          setCost({ kind: "ready", credits: credits.reduce((sum, value) => sum + value, 0) });
        }
      })
      .catch(() => {
        if (!cancelled) setCost({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedModels, prompt, aspect]);

  // ボタン下に出すと画面下端で隠れる場合は、ボタン上 (上方向にフリップ) に出す。
  // anchorRect が無い場合 (初回 mount 等) は画面中央に表示するフォールバック。
  const placement = anchorRect ? computePlacement(anchorRect) : null;
  const style: CSSProperties = placement
    ? {
        position: "fixed",
        top: placement.top,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        zIndex: 60,
      }
    : {
        // 画面中央フォールバック (上 20% だと高すぎて違和感あるため中央へ)
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        // 狭い window でも横にはみ出さないよう viewport で打ち切る。
        width: `min(${PICKER_WIDTH}px, calc(100vw - 16px))`,
        maxHeight: "70vh",
        zIndex: 60,
      };

  return (
    <div
      style={style}
      className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[#242424] px-3 py-2">
        <h3 className="text-[13px] font-black text-neutral-100">生成モデル</h3>
        <span className="text-[10px] font-medium tabular-nums text-neutral-500">
          {totalVisibleModels} 件
        </span>
      </div>
      <div className="shrink-0 border-b border-[#242424] p-3">
        <input
          type="search"
          value={query}
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="モデルを検索"
          className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
        />
      </div>
      {/*
        接続先タブ (2026-06-08 STΛCK構想)。デフォルト(コア)の下にタブを置き、
        接続済みの拡張ごとにモデルを切り替える。未接続の拡張はタブが出ない(degrade)。
        タブ切替時は他providerの選択をクリアして排他にする(コアを壊さない)。
      */}
      <div className="flex shrink-0 gap-1 border-b border-[#242424] px-2 pt-2">
        <button
          type="button"
          onClick={() => {
            setProviderTab("default");
            setSelectedModels([]);
            clearMagnific();
          }}
          className={`rounded-t-md px-2.5 py-1 text-[11px] font-bold ${providerTab === "default" ? "bg-[#1e1e1e] text-white" : "text-neutral-500 hover:text-white"}`}
        >
          デフォルト
        </button>
        <button
          type="button"
          onClick={() => {
            setProviderTab("higgsfield");
            clearMagnific();
          }}
          className={`rounded-t-md px-2.5 py-1 text-[11px] font-bold ${providerTab === "higgsfield" ? "bg-pink-500/20 text-pink-100" : "text-neutral-500 hover:text-white"}`}
        >
          HiggsField
        </button>
        {magnificAuthed && (
          <button
            type="button"
            onClick={() => {
              setProviderTab("magnific");
              setSelectedModels([]);
            }}
            className={`rounded-t-md px-2.5 py-1 text-[11px] font-bold ${providerTab === "magnific" ? "bg-violet-500/20 text-violet-100" : "text-neutral-500 hover:text-white"}`}
          >
            Magnific
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {providerTab === "default" && (
          <div className="mb-3">
            <ModelRow
              title={CODEX_STANDARD_LABEL}
              description="標準モデル。すぐに生成できます"
              icon="C"
              selected={selectedCount === 0 && magnificCount === 0}
              disabled={false}
              onToggle={onPickCodex}
              variant="muted"
            />
          </div>
        )}

        {providerTab === "higgsfield" &&
          (sections.length === 0 ? (
            <p className="rounded-md px-2 py-3 text-center text-[11px] text-neutral-600">
              設定の「接続先」から HiggsField を接続するとモデルが出ます。
            </p>
          ) : (
            sections.map((section) => (
              <section key={section.title} className="mb-3 last:mb-0">
                <div className="mb-1 flex items-center justify-between gap-2 px-1">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                    {section.title}
                  </h4>
                  <span className="text-[10px] font-medium tabular-nums text-neutral-600">
                    {section.items.length}
                  </span>
                </div>
                {section.items.length > 0 ? (
                  <div className="space-y-1">
                    {section.items.map((model) => {
                      const selected = selectedJobSetTypes.has(model.jobSetType);
                      const shownName = getDisplayName(model);
                      return (
                        <ModelRow
                          key={model.jobSetType}
                          title={shownName}
                          description={MODEL_DESCRIPTIONS[model.jobSetType] ?? ""}
                          icon={getModelIcon(model)}
                          label={getModelLabel(planType, model.jobSetType)}
                          selected={selected}
                          disabled={!selected && selectedCount >= MAX_COMPARE_MODELS}
                          onToggle={() =>
                            onToggleModel({
                              jobSetType: model.jobSetType,
                              displayName: shownName,
                            })
                          }
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-md px-2 py-3 text-center text-[11px] text-neutral-600">
                    該当モデルがありません
                  </p>
                )}
              </section>
            ))
          ))}

        {providerTab === "magnific" && (
          <div className="space-y-1">
            {FEATURED_MAGNIFIC_IMAGE_MODELS.map((model) => {
              const isSelected = selectedMagnificModels.includes(model.id);
              return (
                <ModelRow
                  key={model.id}
                  title={model.name}
                  description=""
                  icon="M"
                  selected={isSelected}
                  // 上限(4)に達したら未選択モデルは選べない(Higgsfieldと同じ)。
                  disabled={!isSelected && magnificCount >= MAX_MAGNIFIC_COMPARE}
                  onToggle={() => toggleMagnific(model.id)}
                />
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-[#242424] p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-neutral-300">
            {magnificCount === 1
              ? `Magnific: ${getMagnificModelName(selectedMagnificModels[0])}`
              : magnificCount >= 2
                ? `Magnific: ${magnificCount} 件選択 (最大 ${MAX_MAGNIFIC_COMPARE})`
                : `${selectedCount} 件選択 (最大 ${MAX_COMPARE_MODELS})`}
          </span>
          <span className="font-semibold text-neutral-500">
            {/* Magnificはクレジット情報をMCPが返さないため推定は出さない(嘘の数字を出さない)。 */}
            推定: {magnificCount > 0 ? "—" : formatCost(cost)}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-full rounded-md bg-pink-500 px-3 text-xs font-semibold text-white transition hover:bg-pink-600"
        >
          {magnificCount >= 2
            ? `Magnific ${magnificCount} モデルで比較生成`
            : magnificCount === 1
              ? "Magnific で生成"
              : selectedCount >= 2
                ? `${selectedCount} モデルで比較生成`
                : selectedCount === 1
                  ? "このモデルで生成"
                  : "選択を確定"}
        </button>
      </div>
    </div>
  );
}

function ModelRow({
  title,
  description,
  icon,
  label,
  selected,
  disabled,
  onToggle,
  variant = "primary",
}: {
  title: string;
  description: string;
  /** 1 文字のアイコンプレースホルダ (Higgsfield 公式 UI と同じ位置の枠) */
  icon: string;
  label?: ModelLabel | null;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  /**
   * primary: Higgsfield モデル行 (選択時に pink ring)。
   * muted  : (codex 標準で生成) のような非 Higgsfield 行。選択時も neutral ring で控えめ。
   */
  variant?: "primary" | "muted";
}) {
  // Higgsfield 公式 UI のレイアウトを忠実に再現:
  // [icon枠 40x40] [title + ラベルピル / description (2行)]
  // 選択状態は行全体に薄い ring + 右端にチェックアイコンで表現
  // (チェックボックスは描かない — Higgsfield 公式は「クリックで選択、もう一度で解除」)
  const selectedRing =
    variant === "muted" ? "ring-1 ring-neutral-600/60" : "ring-1 ring-pink-400/40";
  const checkColor = variant === "muted" ? "text-neutral-300" : "text-pink-300";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={description ? `${title} - ${description}` : title}
      className={[
        "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-xs text-neutral-200 transition hover:bg-[#1f1f1f]",
        selected ? `bg-[#1a1a1a] ${selectedRing}` : "",
        disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : "",
      ].join(" ")}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#2a2a2a] bg-[#0d0d0d] text-sm font-medium text-neutral-300">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/*
          タイトル行は左にモデル名、右端にラベルピル。
          ピルが各行で縦に揃うよう justify-between で配置。
          ラベルがない行は右端が空白になるだけで揃いは崩れない。
        */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-neutral-100">
            {title}
          </span>
          {label && <ModelLabelPill label={label} />}
        </span>
        <span className="line-clamp-2 text-[10px] leading-snug text-neutral-500">
          {description || "説明なし"}
        </span>
      </span>
      {selected && (
        <span className={`shrink-0 self-center pr-1 ${checkColor}`} aria-hidden>
          <CheckIcon />
        </span>
      )}
    </button>
  );
}

function ModelLabelPill({ label }: { label: ModelLabel }) {
  // STΛCK 指示 (2026-05-14):
  // - NEW ラベルは表示しない (新旧の区別はユーザーに不要)
  // - UNLIMITED は ∞ シンボルだけにシンプル化
  // - EXCLUSIVE はそのまま (該当する場合)
  if (label === "NEW") return null;
  if (label === "UNLIMITED") {
    return (
      <span
        className="inline-flex h-[16px] shrink-0 items-center self-center rounded-md bg-lime-300 px-1.5 text-[12px] font-black leading-none text-black shadow-sm"
        title="無制限利用可"
      >
        ∞
      </span>
    );
  }
  return (
    <span className="inline-flex h-[16px] shrink-0 items-center self-center rounded-md bg-lime-300 px-1.5 text-[9px] font-black italic uppercase leading-none text-black shadow-sm">
      {label}
    </span>
  );
}

/* --- フラットアイコン (絵文字廃止) --- */

const PICKER_SVG = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** トリガーボタンの下向き山カッコ。 */
function ChevronDownIcon() {
  return (
    <svg {...PICKER_SVG} width={12} height={12} className="shrink-0 text-neutral-500" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** 選択済みモデル行のチェック。 */
function CheckIcon() {
  return (
    <svg {...PICKER_SVG} width={14} height={14} strokeWidth={2.6} aria-hidden>
      <path d="M4 12.5l5.5 5.5L20 6" />
    </svg>
  );
}

function buildSections(
  media: "image" | "video",
  models: HiggsfieldModelInfo[],
  query: string,
): ModelSection[] {
  // 同名モデル (例: GPT Image 2 が imagegen_2_0 と gpt_image_2 で 2 件返る)
  // を 1 件に集約する。canonical job_set_type を優先。
  const deduped = dedupeModels(models);
  const featuredIds = media === "image" ? FEATURED_IMAGE_MODELS : FEATURED_VIDEO_MODELS;
  const featuredIdSet = new Set(featuredIds);
  const byJobSetType = new Map(deduped.map((model) => [model.jobSetType, model]));
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (model: HiggsfieldModelInfo) => matchesModel(model, normalizedQuery);

  // STΛCK 指示: HIGGSFIELD MODELS / Featured / All の区分けを廃止し、
  // 接続先名 (HiggsField) で1グループにまとめる。表示順は featured 優先。
  const featured = featuredIds
    .map((jobSetType) => byJobSetType.get(jobSetType))
    .filter((model): model is HiggsfieldModelInfo => !!model)
    .filter(matches);
  const others = deduped
    .filter((model) => !featuredIdSet.has(model.jobSetType))
    .filter(matches)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  void media;

  const items = [...featured, ...others];
  // STΛCK 指示 (2026-05-17): items 空のときは HIGGSFIELD セクションを出さない。
  // 未接続時に「⚡ HIGGSFIELD 0件」と空表示するのは UX 上ノイズ。
  if (items.length === 0) return [];
  return [{ title: "HiggsField", items }];
}

function matchesModel(model: HiggsfieldModelInfo, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const description = MODEL_DESCRIPTIONS[model.jobSetType] ?? "";
  const haystack = `${model.displayName} ${model.jobSetType} ${description}`.toLowerCase();
  return haystack.includes(normalizedQuery);
}

// このアプリの MOST は Codex 経由 GPT Image 2 で生成すること。
// HiggsField は「契約してる人だけが追加する拡張モデル」という位置づけ。
//
// したがって HiggsField CLI が未インストール / 未認証 でも、
// それは「拡張未接続」という正常状態であり、エラーや警告として
// 「設定で認証してください」と出すのは設計ミス。常に GPT Image 2 を
// デフォルトとして表示する。
function getTriggerText(
  selectedModels: SelectedModel[],
  selectedMagnific: string[] = [],
): string {
  // Magnific選択は最優先で反映(Higgsfield/codexより優先する生成経路と一致)。
  if (selectedMagnific.length === 1)
    return `Magnific: ${getMagnificModelName(selectedMagnific[0])}`;
  if (selectedMagnific.length >= 2)
    return `Magnific ${selectedMagnific.length} models`;
  // 選択済みモデルがあれば読み込み状態に関係なく表示する (確認中で隠さない)。
  if (selectedModels.length === 1) return selectedModels[0].displayName;
  if (selectedModels.length >= 2) return `${selectedModels.length} models compared`;
  // 未選択時は常にデフォルト表示。loading/idle は静的カタログ即表示 (2026-06-10) に
  // より一瞬で ready になるため、「確認中」でトリガーを占有しない。
  return CODEX_STANDARD_LABEL;
}

function getHelperText(loadState: LoadState, _selectedCount: number): string | null {
  if (loadState === "loading" || loadState === "idle") return "モデル一覧を確認中...";
  // missing / needsAuth でも、ヘルパー文言は出さない。
  // GPT Image 2 がデフォルトで使えるので、警告を出す必要がない。
  // 拡張モデルを追加したい人は設定の「接続先」から HiggsField を接続できる。
  if (loadState === "missing" || loadState === "needsAuth") return null;
  if (loadState === "error") return null;
  return null;
}

function formatCost(cost: CostState): string {
  if (cost.kind === "idle") return "-";
  if (cost.kind === "loading") return "checking...";
  if (cost.kind === "error") return "unknown";
  return `${cost.credits} credits`;
}

/**
 * ピッカーの実幅。狭い window (13インチ / 分割表示) では PICKER_WIDTH が
 * viewport を超えて横にはみ出すため、左右 8px の余白を残して詰める。
 */
function getPopoverWidth(): number {
  return Math.min(PICKER_WIDTH, Math.max(240, window.innerWidth - 16));
}

function getPopoverLeft(anchorRect: DOMRect, width: number): number {
  const viewportWidth = window.innerWidth;
  const maxLeft = Math.max(8, viewportWidth - width - 8);
  return Math.min(Math.max(8, anchorRect.left), maxLeft);
}

/**
 * アンカー位置と画面サイズから、ピッカーの top / left / 幅 / max-height を決める。
 */
function computePlacement(anchorRect: DOMRect): {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
} {
  const GAP = 8;
  const PADDING = 16;
  const MIN_HEIGHT = 280;
  const PREFERRED_HEIGHT = 520;
  const viewportHeight = window.innerHeight;

  const spaceBelow = viewportHeight - anchorRect.bottom - GAP - PADDING;
  const spaceAbove = anchorRect.top - GAP - PADDING;
  const width = getPopoverWidth();
  const left = getPopoverLeft(anchorRect, width);

  if (spaceBelow >= MIN_HEIGHT || spaceBelow >= spaceAbove) {
    const maxHeight = Math.min(PREFERRED_HEIGHT, Math.max(MIN_HEIGHT, spaceBelow));
    return { top: anchorRect.bottom + GAP, left, width, maxHeight };
  }
  // 上フリップ: maxHeight に MIN_HEIGHT の下駄を履かせているため、上の空きが
  // MIN_HEIGHT 未満だと top が負になり画面上端からはみ出す (2026-07-25 修正)。
  // maxHeight は実際に使える高さで打ち切り、top は 8px 以上に clamp する。
  const usableAbove = Math.max(MIN_HEIGHT, spaceAbove);
  const maxHeight = Math.min(PREFERRED_HEIGHT, usableAbove, viewportHeight - 2 * PADDING);
  const top = Math.max(PADDING / 2, anchorRect.top - GAP - maxHeight);
  return { top, left, width, maxHeight };
}

/**
 * モデル行のアイコン枠に出す 1 文字を返す。
 * display_name の頭文字を大文字化、空なら video/image の頭文字でフォールバック。
 * Higgsfield 公式 UI は SVG ロゴだが、現状は文字プレースホルダで枠だけ揃える。
 */
function getModelIcon(model: HiggsfieldModelInfo): string {
  const firstLetter = model.displayName.trim().charAt(0).toUpperCase();
  return firstLetter || (model.type === "video" ? "V" : "I");
}

