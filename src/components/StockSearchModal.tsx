import { useEffect, useMemo, useState } from "react";

import {
  codexVision,
  stock,
  translate,
  type SecretKey,
  type StockPhoto,
  type StockProvider,
  type StockSearchFilters,
} from "../lib/ipc";
import { useAccounts } from "../lib/store/accounts";
import { usePresets } from "../lib/store/presets";
import { useScenePromptOverride } from "../lib/store/scenePrompt";
import { useToasts } from "../lib/store/toasts";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
};

type ProviderMeta = {
  id: StockProvider;
  label: string;
  keyName: SecretKey;
  signupUrl: string;
  hint: string;
  licenseNote: string;
};

type PexelsFilters = {
  orientation: string;
  size: string;
  perPage: number;
};

type UnsplashFilters = {
  orientation: string;
  orderBy: "relevant" | "latest";
  perPage: number;
};

type ActionKind = "add" | "analyze" | "translate";

const PROVIDERS: ProviderMeta[] = [
  {
    id: "pexels",
    label: "Pexels",
    keyName: "pexels_api_key",
    signupUrl: "https://www.pexels.com/api/new/",
    hint: "Pexels にログイン → API キーをコピーして貼り付け (無料、申請不要、200 req/時)",
    licenseNote: "Pexels License: 商用 OK / 改変 OK / 出典任意 / 参照画像用途 OK",
  },
  {
    id: "unsplash",
    label: "Unsplash",
    keyName: "unsplash_access_key",
    signupUrl: "https://unsplash.com/oauth/applications",
    hint: "Unsplash にログイン → 新規アプリ作成 → Access Key をコピー (Demo 50 req/時)",
    licenseNote:
      "Unsplash License (無料版): 商用 OK / 改変 OK / 出典任意 ⚠ Unsplash+ (有料) の画像は AI 用途禁止",
  },
];

const DEFAULT_PEXELS_FILTERS: PexelsFilters = {
  orientation: "",
  size: "",
  perPage: 15,
};

const DEFAULT_UNSPLASH_FILTERS: UnsplashFilters = {
  orientation: "",
  orderBy: "relevant",
  perPage: 10,
};

function hasJapanese(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(value);
}

export function StockSearchModal({ open, onClose, onPick }: Props) {
  const secretsState = useAccounts((s) => s.secrets);
  const refreshSecrets = useAccounts((s) => s.refreshSecrets);
  const pushToast = useToasts((s) => s.push);
  const availableProviders = useMemo(
    () =>
      PROVIDERS.map((item) => ({
        ...item,
        has: item.id === "pexels" ? secretsState.hasPexels : secretsState.hasUnsplash,
      })),
    [secretsState.hasPexels, secretsState.hasUnsplash],
  );
  const firstConnected = useMemo(
    () => availableProviders.find((item) => item.has)?.id ?? "pexels",
    [availableProviders],
  );

  const [provider, setProvider] = useState<StockProvider>(firstConnected);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<StockPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pexelsFilters, setPexelsFilters] = useState<PexelsFilters>(
    DEFAULT_PEXELS_FILTERS,
  );
  const [unsplashFilters, setUnsplashFilters] = useState<UnsplashFilters>(
    DEFAULT_UNSPLASH_FILTERS,
  );
  const [loading, setLoading] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [actionRunning, setActionRunning] = useState<ActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCredit, setLastCredit] = useState<StockPhoto | null>(null);
  // 画像をダブルクリックで開く拡大プレビュー (元画像 URL を直接表示)
  const [previewPhoto, setPreviewPhoto] = useState<StockPhoto | null>(null);
  // 選択モード: ON でシングルクリックが選択トグル動作になる。
  // OFF だとサムネクリックは無反応 (誤クリックでアクション暴発しないよう)。
  const [selectionMode, setSelectionMode] = useState(false);
  // 画像分析の結果モーダル: 各画像の (thumbUrl, prompt) を保持
  const [analyzeResults, setAnalyzeResults] = useState<
    Array<{ photo: StockPhoto; prompt: string }>
  >([]);

  const activeProvider = availableProviders.find((item) => item.id === provider);
  const connected = Boolean(activeProvider?.has);
  const queryHasJapanese = hasJapanese(query);
  const selectedPhotos = useMemo(
    () => results.filter((photo) => selectedIds.has(photo.id)),
    [results, selectedIds],
  );
  const selectedCount = selectedPhotos.length;
  const busy = loading || actionRunning !== null;

  useEffect(() => {
    if (!open) return;
    void (async () => {
      await refreshSecrets();
      console.log(
        "[StockSearchModal] refreshed secrets:",
        useAccounts.getState().secrets,
      );
    })();
  }, [open, refreshSecrets]);

  useEffect(() => {
    if (!open) return;
    setProvider((current) => {
      const currentProvider = availableProviders.find((item) => item.id === current);
      return currentProvider?.has ? current : firstConnected;
    });
  }, [availableProviders, firstConnected, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setResults([]);
    setSelectedIds(new Set());
    setError(null);
    setLastCredit(null);
    setPage(1);
    setProcessingId(null);
    setSelectionMode(false);
    setPreviewPhoto(null);
    if (provider === "pexels") {
      setPexelsFilters(DEFAULT_PEXELS_FILTERS);
    } else if (provider === "unsplash") {
      setUnsplashFilters(DEFAULT_UNSPLASH_FILTERS);
    }
  }, [open, provider]);

  if (!open) return null;

  const buildFilters = (): StockSearchFilters => {
    if (provider === "pexels") {
      return {
        orientation: pexelsFilters.orientation || undefined,
        size: pexelsFilters.size || undefined,
        locale: queryHasJapanese ? "ja-JP" : undefined,
        perPage: pexelsFilters.perPage,
      };
    }
    return {
      orientation: unsplashFilters.orientation || undefined,
      orderBy: unsplashFilters.orderBy,
      perPage: unsplashFilters.perPage,
    };
  };

  const runSearch = async (nextPage = page) => {
    const trimmed = query.trim();
    if (!trimmed || !connected) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const photos = await stock.search(provider, trimmed, nextPage, buildFilters());
      setResults(photos);
      setPage(nextPage);
      setLastCredit(photos[0] ?? null);
      if (photos.length === 0) {
        setError("検索結果がありません");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const translateQuery = async () => {
    const trimmed = query.trim();
    if (provider !== "unsplash" || !trimmed || !queryHasJapanese || actionRunning) return;
    setActionRunning("translate");
    setError(null);
    try {
      const translated = await translate.jaToEn(trimmed);
      setQuery(translated);
      pushToast({ kind: "success", text: `英訳しました: ${translated}`, ttlMs: 4000 });
    } catch (err) {
      setError(String(err));
      pushToast({ kind: "error", text: `英訳に失敗しました: ${String(err)}` });
    } finally {
      setActionRunning(null);
    }
  };

  const togglePhoto = (photo: StockPhoto) => {
    if (busy) return;
    setLastCredit(photo);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(photo.id)) {
        next.delete(photo.id);
      } else {
        next.add(photo.id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const downloadSelected = async (): Promise<string[]> => {
    const paths: string[] = [];
    for (const photo of selectedPhotos) {
      setProcessingId(photo.id);
      setLastCredit(photo);
      const path = await stock.download(provider, photo);
      paths.push(path);
    }
    return paths;
  };

  const addSelectedReferences = async () => {
    if (selectedPhotos.length === 0 || actionRunning) return;
    setActionRunning("add");
    setError(null);
    try {
      const paths = await downloadSelected();
      for (const path of paths) {
        onPick(path);
      }
      pushToast({
        kind: "success",
        text: `${paths.length} 件を参照に追加しました`,
        ttlMs: 3000,
      });
      clearSelection();
    } catch (err) {
      setError(String(err));
      pushToast({ kind: "error", text: `参照追加に失敗しました: ${String(err)}` });
    } finally {
      setProcessingId(null);
      setActionRunning(null);
    }
  };

  const analyzeSelectedImages = async () => {
    if (selectedPhotos.length === 0 || actionRunning) return;
    setActionRunning("analyze");
    setError(null);
    // 結果を蓄積して、終了後に結果モーダルへ。
    // トーストでの単発表示はやめて、専用画面で 採用 / プリセット登録 へ分岐する。
    const collected: Array<{ photo: StockPhoto; prompt: string }> = [];
    try {
      for (const photo of selectedPhotos) {
        setProcessingId(photo.id);
        setLastCredit(photo);
        const path = await stock.download(provider, photo);
        const prompt = await codexVision.describeImage(path);
        collected.push({ photo, prompt });
      }
      setAnalyzeResults(collected);
      clearSelection();
    } catch (err) {
      setError(String(err));
      pushToast({ kind: "error", text: `画像分析に失敗しました: ${String(err)}` });
      // 途中までの結果も見せる (1 件以上あれば)
      if (collected.length > 0) setAnalyzeResults(collected);
    } finally {
      setProcessingId(null);
      setActionRunning(null);
    }
  };

  /** 採用: シーン構築の promptOverride に反映して、素材検索モーダルごと閉じる */
  const adoptPrompt = (prompt: string) => {
    useScenePromptOverride.getState().set(prompt);
    setAnalyzeResults([]);
    pushToast({
      kind: "success",
      text: "プロンプトを採用しました (シーン構築に反映)",
      ttlMs: 3000,
    });
    onClose();
  };

  /**
   * プリセット登録: サイドバー「プリセット」画面と連動する `usePresets` store に保存。
   * (旧実装は `useSavedPrompts` に保存していたが別の store でサイドバーに出ない問題があった)
   *
   * 保存先カテゴリ: 「素材分析」カテゴリがあればそこ、なければ自動作成して「未分類」(null) 回避。
   * 結果モーダルは閉じない (連続登録可)。
   */
  const saveAsPreset = (entry: { photo: StockPhoto; prompt: string }) => {
    try {
      const presetsApi = usePresets.getState();
      // 「素材分析」カテゴリを再利用 or 自動作成
      const ANALYSIS_CATEGORY = "素材分析";
      let category = presetsApi.categories.find((c) => c.name === ANALYSIS_CATEGORY);
      if (!category) {
        category = presetsApi.addCategory(ANALYSIS_CATEGORY, "#ec4899");
      }
      const name =
        entry.photo.author && entry.photo.author.length > 0
          ? `${provider}: ${entry.photo.author}`
          : `${provider} 素材`;
      presetsApi.addPreset({
        name,
        prompt: entry.prompt,
        categoryId: category.id,
        tags: [provider],
        thumbnail: entry.photo.thumbUrl, // サムネ URL を流す (data URL じゃないので表示は MVP)
      });
      pushToast({
        kind: "success",
        text: `「${name}」をプリセット (素材分析) に登録しました`,
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `プリセット登録に失敗しました: ${String(err)}`,
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">ストック素材検索</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-neutral-400 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="border-b border-[#242424] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {availableProviders.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setProvider(item.id)}
                className={[
                  "flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-bold transition",
                  provider === item.id
                    ? "border-pink-400 bg-pink-500/15 text-pink-100"
                    : "border-[#343434] bg-[#101010] text-neutral-300 hover:border-pink-400 hover:text-white",
                ].join(" ")}
                title={item.has ? `${item.label} で検索` : `${item.label} に接続`}
              >
                {item.has && <span className="text-lime-400">●</span>}
                {item.label}
              </button>
            ))}
          </div>

          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(1);
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="検索キーワード"
              disabled={!connected}
              className="h-9 min-w-52 flex-1 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400 disabled:text-neutral-600"
            />
            {provider === "unsplash" && (
              <button
                type="button"
                onClick={() => void translateQuery()}
                disabled={!connected || !query.trim() || !queryHasJapanese || busy}
                className="h-9 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
              >
                {actionRunning === "translate" ? "英訳中" : "Aa→ 英訳"}
              </button>
            )}
            <button
              type="submit"
              disabled={!connected || !query.trim() || busy}
              className="h-9 rounded-md bg-pink-500 px-4 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              {loading ? "検索中" : "検索"}
            </button>
            {/*
              選択モードトグル: ピンク以外の色で目立たせず、ON/OFF が一目で分かる
              チェック式デザイン。OFF の時はサムネクリックが無反応 = 誤クリック対策。
            */}
            <button
              type="button"
              onClick={() => {
                setSelectionMode((prev) => {
                  // 選択モードを OFF にする時は選択も解除
                  if (prev) setSelectedIds(new Set());
                  return !prev;
                });
              }}
              disabled={!connected || busy}
              className={[
                "h-9 rounded-md border px-3 text-xs font-semibold transition disabled:cursor-not-allowed",
                selectionMode
                  ? "border-lime-300 bg-lime-300/15 text-lime-100"
                  : "border-[#343434] bg-[#101010] text-neutral-300 hover:border-[#555] hover:text-white",
                "disabled:opacity-40",
              ].join(" ")}
              title={selectionMode ? "選択モード ON (クリックで✓)" : "選択モード OFF"}
            >
              {selectionMode ? "✓ 選択モード" : "選択モード"}
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {provider === "pexels" ? (
              <>
                <FilterSelect
                  label="向き"
                  value={pexelsFilters.orientation}
                  onChange={(value) =>
                    setPexelsFilters((current) => ({ ...current, orientation: value }))
                  }
                  options={[
                    ["", "すべて"],
                    ["landscape", "横長"],
                    ["portrait", "縦長"],
                    ["square", "正方形"],
                  ]}
                />
                {/*
                  色フィルター削除 (STΛCK 判断): Pexels API の color は
                  公式に厳密度の記載なく、実挙動も色が一致しない画像が混ざる
                  ことが多い。フィルターとして機能しないので UI から外す。
                  PEXELS_COLORS 定数も削除した。
                */}
                <FilterSelect
                  label="サイズ"
                  value={pexelsFilters.size}
                  onChange={(value) =>
                    setPexelsFilters((current) => ({ ...current, size: value }))
                  }
                  options={[
                    ["", "すべて"],
                    ["large", "large"],
                    ["medium", "medium"],
                    ["small", "small"],
                  ]}
                />
                <span className="h-8 rounded-md border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[11px] font-bold text-neutral-500">
                  並び: 関連順固定
                </span>
                <NumberSelect
                  label="件数"
                  value={pexelsFilters.perPage}
                  onChange={(value) =>
                    setPexelsFilters((current) => ({ ...current, perPage: value }))
                  }
                  options={[15, 30, 50, 80]}
                />
              </>
            ) : (
              <>
                <FilterSelect
                  label="向き"
                  value={unsplashFilters.orientation}
                  onChange={(value) =>
                    setUnsplashFilters((current) => ({
                      ...current,
                      orientation: value,
                    }))
                  }
                  options={[
                    ["", "すべて"],
                    ["landscape", "横長"],
                    ["portrait", "縦長"],
                    ["squarish", "正方形"],
                  ]}
                />
                {/* 色フィルター削除 (Pexels と同じく挙動が不確実) */}
                <FilterSelect
                  label="並び"
                  value={unsplashFilters.orderBy}
                  onChange={(value) =>
                    setUnsplashFilters((current) => ({
                      ...current,
                      orderBy: value === "latest" ? "latest" : "relevant",
                    }))
                  }
                  options={[
                    ["relevant", "関連順"],
                    ["latest", "新着順"],
                  ]}
                />
                <NumberSelect
                  label="件数"
                  value={unsplashFilters.perPage}
                  onChange={(value) =>
                    setUnsplashFilters((current) => ({ ...current, perPage: value }))
                  }
                  options={[10, 20, 30]}
                />
              </>
            )}
          </div>
        </div>

        {/*
          選択バーは画像 grid の上に floating (絶対配置) で重ねる。
          こうすると選択時に画像が下にシフトせず、UX 違和感が消える。
        */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
        {selectedCount > 0 && (
          <div className="pointer-events-none absolute left-0 right-0 top-3 z-20 flex justify-center px-4">
            <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-full border border-[#262626] bg-[#101010]/95 px-4 py-2 shadow-2xl backdrop-blur">
            <span className="text-xs font-semibold text-neutral-200">
              {selectedCount} 件選択中
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void addSelectedReferences()}
                disabled={busy}
                className="h-8 rounded-md bg-pink-500 px-3 text-xs font-semibold text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                {actionRunning === "add" ? "追加中" : "参照に追加"}
              </button>
              <button
                type="button"
                onClick={() => void analyzeSelectedImages()}
                disabled={busy}
                className="h-8 rounded-md border border-[#343434] bg-[#181818] px-3 text-xs font-semibold text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
              >
                {actionRunning === "analyze" ? "分析中" : "画像を分析"}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={busy}
                className="h-8 px-2 text-xs font-medium text-neutral-400 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
              >
                選択解除
              </button>
            </div>
            </div>
          </div>
        )}

        <div className="h-full overflow-y-auto p-4">
          {error && (
            <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200">
              {error}
            </p>
          )}

          {results.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs text-neutral-500">
              {connected
                ? "キーワードを入力して検索してください"
                : `設定 → 接続先で ${activeProvider?.label ?? "プロバイダ"} の API キーを登録してください`}
            </div>
          ) : (
            /*
              CSS columns で Pinterest 風 masonry レイアウト。
              画像はアスペクト比そのまま、縦長/横長/正方形が混在しても綺麗に並ぶ。

              クリック動作 (STΛCK 仕様):
                - 選択モード OFF: クリックは無反応 (誤クリック対策で落ちないように)
                - 選択モード ON:
                  - シングルクリック → 選択トグル
                  - ダブルクリック → 拡大プレビュー
              選択中の枠は ring-2 のみ、丸の border-2 と二重にならないよう
              左上アイコンを小さく単線に。
            */
            <div className="columns-2 gap-3 sm:columns-3 md:columns-4 lg:columns-5">
              {results.map((photo) => {
                const selected = selectedIds.has(photo.id);
                const processing = processingId === photo.id;
                return (
                  <div
                    key={`${provider}-${photo.id}`}
                    className={[
                      "group relative mb-3 break-inside-avoid overflow-hidden rounded-md transition",
                      selected
                        ? "ring-2 ring-pink-400"
                        : "ring-1 ring-[#343434] hover:ring-pink-400/60",
                    ].join(" ")}
                    onMouseEnter={() => setLastCredit(photo)}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        // 選択モード ON のみ反応 (誤クリック暴発防止)
                        if (!selectionMode || busy) return;
                        togglePhoto(photo);
                      }}
                      onDoubleClick={() => {
                        // 選択モード ON のみ反応、プレビュー開く
                        if (!selectionMode || busy) return;
                        setPreviewPhoto(photo);
                      }}
                      disabled={busy && !processing}
                      className={[
                        "block w-full bg-[#0b0b0b] disabled:cursor-wait disabled:opacity-60",
                        selectionMode ? "cursor-pointer" : "cursor-default",
                      ].join(" ")}
                      title={
                        selectionMode
                          ? "クリックで選択 / ダブルクリックで拡大"
                          : "選択モードを ON にしてください"
                      }
                    >
                      <img
                        src={photo.thumbUrl}
                        alt={
                          photo.author
                            ? `${provider} by ${photo.author}`
                            : `${provider} stock photo`
                        }
                        className="block w-full pointer-events-none select-none"
                        loading="lazy"
                        draggable={false}
                      />
                    </button>
                    {/*
                      選択チェック表示: 選択時のみ表示、サイズダウンして二重丸感を排除。
                      非選択時は何も出さず、画像の見た目をクリーンに保つ。
                    */}
                    {selected && (
                      <span
                        aria-hidden
                        className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-pink-500 text-[11px] font-bold text-white shadow"
                      >
                        ✓
                      </span>
                    )}
                    {processing && (
                      <span className="absolute inset-x-2 bottom-2 rounded bg-pink-500/90 px-2 py-1 text-center text-[10px] font-black text-white">
                        {actionRunning === "analyze" ? "分析中" : "追加中"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#242424] px-4 py-3">
          <div className="min-w-0 text-xs text-neutral-500">
            {lastCredit ? (
              <>
                クレジット:{" "}
                <span className="font-semibold text-neutral-300">
                  {lastCredit.author || "unknown"}
                </span>
                {lastCredit.sourceUrl && (
                  <>
                    {" | "}
                    <a
                      href={lastCredit.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-pink-300 hover:underline"
                    >
                      元ページ ↗
                    </a>
                  </>
                )}
              </>
            ) : (
              "クリックで選択、選択バーから一括操作"
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runSearch(Math.max(1, page - 1))}
              disabled={!connected || busy || page <= 1}
              className="h-8 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              前へ
            </button>
            <span className="min-w-12 text-center text-xs font-black text-neutral-300">
              {page}
            </span>
            <button
              type="button"
              onClick={() => void runSearch(page + 1)}
              disabled={!connected || busy || results.length === 0}
              className="h-8 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600"
            >
              次へ
            </button>
          </div>
        </div>
      </div>

      {/*
        拡大プレビュー用 lightbox. 元画像 URL を直接表示してアスペクト比保持.
        モーダル背景クリック / Escape で閉じる (Escape は親モーダルが拾うのでここでは追加実装不要)。
      */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
          onClick={(event) => {
            // 親モーダル (素材検索) の onClick={onClose} に届かないよう
            // バブリングを必ず止める。背景クリックではプレビューだけ閉じて、
            // 素材検索画面に戻るのが正解の挙動。
            event.stopPropagation();
            setPreviewPhoto(null);
          }}
        >
          <div
            className="relative flex max-h-[calc(100vh-2rem)] max-w-6xl flex-col items-center gap-3 overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={previewPhoto.fullUrl}
              alt={
                previewPhoto.author
                  ? `${provider} by ${previewPhoto.author}`
                  : `${provider} preview`
              }
              className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-2xl"
              loading="eager"
            />
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-black/60 px-4 py-2 text-xs text-neutral-200 backdrop-blur">
              <span>
                クレジット: <span className="font-semibold">{previewPhoto.author || "unknown"}</span>
              </span>
              {previewPhoto.sourceUrl && (
                <a
                  href={previewPhoto.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-pink-300 hover:underline"
                >
                  元ページ ↗
                </a>
              )}
              <button
                type="button"
                onClick={() => {
                  togglePhoto(previewPhoto);
                }}
                className="rounded-md bg-pink-500 px-3 py-1 font-semibold text-white hover:bg-pink-600"
              >
                {selectedIds.has(previewPhoto.id) ? "選択を外す" : "選択に追加"}
              </button>
              <button
                type="button"
                onClick={() => setPreviewPhoto(null)}
                className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 font-medium text-neutral-300 hover:border-[#555] hover:text-white"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        画像分析の結果モーダル (専用画面).
        各画像のサムネ + Codex Vision が生成したプロンプト + 2 軸アクション:
          - 採用 → useScenePromptOverride にセットして素材モーダルごと閉じる
          - プリセットに登録 → useSavedPrompts に保存、結果モーダルは閉じない (連続登録可)
        背景クリックは閉じる、素材モーダルへ戻る (stopPropagation で親に伝播させない)。
      */}
      {analyzeResults.length > 0 && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
          onClick={(event) => {
            event.stopPropagation();
            setAnalyzeResults([]);
          }}
        >
          <div
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
              <h3 className="text-sm font-semibold text-white">
                画像分析の結果 ({analyzeResults.length} 件)
              </h3>
              <button
                type="button"
                onClick={() => setAnalyzeResults([])}
                aria-label="閉じる"
                className="text-neutral-400 hover:text-white"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ul className="space-y-3">
                {analyzeResults.map((entry, index) => (
                  <li
                    key={`${entry.photo.id}-${index}`}
                    className="flex flex-col gap-3 rounded-lg border border-[#2a2a2a] bg-[#101010] p-3 sm:flex-row"
                  >
                    <img
                      src={entry.photo.thumbUrl}
                      alt={entry.photo.author ?? "stock"}
                      className="h-28 w-28 shrink-0 rounded-md object-cover"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-200">
                        {entry.prompt}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => adoptPrompt(entry.prompt)}
                          className="h-8 rounded-md bg-pink-500 px-3 text-xs font-semibold text-white hover:bg-pink-600"
                        >
                          採用 (シーン構築に反映)
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveAsPreset(entry)}
                          className="h-8 rounded-md border border-[#343434] bg-[#181818] px-3 text-xs font-medium text-neutral-200 hover:border-pink-400 hover:text-white"
                        >
                          ★ プリセットに登録
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(entry.prompt);
                            pushToast({
                              kind: "success",
                              text: "プロンプトをコピーしました",
                              ttlMs: 1800,
                            });
                          }}
                          className="h-8 rounded-md border border-[#343434] bg-[#181818] px-3 text-xs font-medium text-neutral-300 hover:border-[#555] hover:text-white"
                        >
                          コピー
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-4 py-3">
              <button
                type="button"
                onClick={() => setAnalyzeResults([])}
                className="h-8 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs font-medium text-neutral-300 hover:border-[#555] hover:text-white"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  hint?: string;
}) {
  return (
    <label
      className="flex h-8 items-center gap-2 rounded-md border border-[#343434] bg-[#101010] px-2 text-[11px] font-bold text-neutral-400"
      title={hint}
    >
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 min-w-20 border-0 bg-transparent text-xs font-semibold text-neutral-100 outline-none"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue || "all"} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {hint && <span className="text-[10px] font-normal text-neutral-600">ⓘ</span>}
    </label>
  );
}

function NumberSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  options: readonly number[];
}) {
  return (
    <label className="flex h-8 items-center gap-2 rounded-md border border-[#343434] bg-[#101010] px-2 text-[11px] font-bold text-neutral-400">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-6 min-w-16 border-0 bg-transparent text-xs font-semibold text-neutral-100 outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
