import { useEffect, useMemo, useState } from "react";

import {
  stock,
  type StockPhoto,
  type StockSearchFilters,
} from "../lib/ipc";
import { useAccounts } from "../lib/store/accounts";
import { useActiveProject } from "../lib/store/activeProject";
import { useProjects } from "../lib/store/projects";
import { useToasts } from "../lib/store/toasts";

/**
 * `onPick` でストック素材を「参照に追加」する際、写真本体のローカルパス
 * (path) と一緒にクレジット情報 (stockSource) を呼び出し側に渡す。
 *
 * 法務対応 (2026-05-21):
 *   Pexels の素材を商用合成・PR 動画に使う場合の出典トレース用。
 *   呼び出し側 (ConstructedPromptPanel など) が Reference.stockSource に
 *   保存することで、完成物のエクスポート時にクレジット一覧を出せる土台とする。
 */
type StockPickSource = {
  provider: "pexels";
  photoId: string;
  author: string;
  sourceUrl?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (path: string, source: StockPickSource) => void;
};

type PexelsFilters = {
  orientation: string;
  size: string;
  perPage: number;
};

// 法務対応 (2026-05-21):
//   - 「画像を分析」(Vision プロンプト化) 機能を撤去
//   - Unsplash カテゴリを撤去
//     理由: Unsplash API Guidelines は (1) アプリ内表示時に写真家・Unsplash
//     への attribution を必須とし、(2) ユーザーへの developer account 登録
//     要求 (BYO API キー) を推奨していない。ゴリゴリくんの BYO 方針と
//     衝突するため、素材ソースを Pexels 単独に絞る。
type ActionKind = "add";

const PEXELS_PROVIDER = {
  id: "pexels" as const,
  label: "Pexels",
  keyName: "pexels_api_key" as const,
  signupUrl: "https://www.pexels.com/api/new/",
  hint: "Pexels にログイン → API キーをコピーして貼り付け (無料、申請不要、200 req/時)",
  // 法務対応 (2026-05-21):
  //   - Pexels License は商用利用・改変可、クレジット任意
  //   - 禁止事項を明記: 単体再配布 / 素材集化 / AI/ML 用の収集・データセット化
  //   - AI モデルへの直接入力 (画像解析・キャプション化・プロンプト抽出含む) は本アプリでは非対応
  //   - 写真自体のライセンスはクリアでも、肖像権・商標権・建物の意匠権は別。商用利用前に追加確認推奨
  licenseNote:
    "Pexels License: 規約の範囲で商用 OK / 改変 OK / クレジット任意。合成・背景・シーン素材として利用可。" +
    "禁止: 単体再配布 / 素材集化 / AI/ML 用の収集・データセット化 / 画像解析・キャプション化・プロンプト抽出など AI モデルへの直接入力。" +
    "※ 人物・ロゴ・ブランド・建物・美術作品が写る場合、肖像権・商標権・著作権の追加確認が必要になる場合があります。" +
    "推薦・提携を示す表現は避けてください。",
};

const DEFAULT_PEXELS_FILTERS: PexelsFilters = {
  orientation: "",
  size: "",
  perPage: 15,
};

function hasJapanese(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(value);
}

export function StockSearchModal({ open, onClose, onPick }: Props) {
  const secretsState = useAccounts((s) => s.secrets);
  const refreshSecrets = useAccounts((s) => s.refreshSecrets);
  const pushToast = useToasts((s) => s.push);
  // Pexels 単独運用 (2026-05-21 法務対応で Unsplash 撤去)。
  const connected = secretsState.hasPexels;

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<StockPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pexelsFilters, setPexelsFilters] = useState<PexelsFilters>(
    DEFAULT_PEXELS_FILTERS,
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
    setPexelsFilters(DEFAULT_PEXELS_FILTERS);
  }, [open]);

  if (!open) return null;

  const buildFilters = (): StockSearchFilters => ({
    orientation: pexelsFilters.orientation || undefined,
    size: pexelsFilters.size || undefined,
    locale: queryHasJapanese ? "ja-JP" : undefined,
    perPage: pexelsFilters.perPage,
  });

  const runSearch = async (nextPage = page) => {
    const trimmed = query.trim();
    if (!trimmed || !connected) return;
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    try {
      const photos = await stock.search("pexels", trimmed, nextPage, buildFilters());
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

  /**
   * 選択済み写真を順番に DL。クレジット保持のため、ローカルパスと一緒に
   * 元の StockPhoto も返す (StockPickSource の構築に使う)。
   */
  const downloadSelected = async (): Promise<
    Array<{ path: string; photo: StockPhoto }>
  > => {
    const results: Array<{ path: string; photo: StockPhoto }> = [];
    for (const photo of selectedPhotos) {
      setProcessingId(photo.id);
      setLastCredit(photo);
      const path = await stock.download("pexels", photo);
      results.push({ path, photo });
    }
    return results;
  };

  const addSelectedReferences = async () => {
    if (selectedPhotos.length === 0 || actionRunning) return;
    setActionRunning("add");
    setError(null);
    try {
      const entries = await downloadSelected();
      // アクティブプロジェクトがあれば、クレジットをそこにも記録する
      // (credits.csv エクスポート用、2026-05-21 法務対応)。
      const activeProjectId = useActiveProject.getState().activeProjectId;
      const recordCredit = useProjects.getState().recordStockCredit;
      for (const { path, photo } of entries) {
        // クレジット情報を一緒に渡す。商用案件の出典トレース用。
        onPick(path, {
          provider: "pexels",
          photoId: photo.id,
          author: photo.author || "unknown",
          sourceUrl: photo.sourceUrl,
        });
        if (activeProjectId) {
          recordCredit(activeProjectId, {
            provider: "pexels",
            photoId: photo.id,
            author: photo.author || "unknown",
            sourceUrl: photo.sourceUrl,
            localPath: path,
          });
        }
      }
      pushToast({
        kind: "success",
        text: `${entries.length} 件を参照に追加しました`,
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

  // 法務対応 (2026-05-21):
  //   - 「画像を分析」(Vision プロンプト化) 機能を撤去 (AI 直接入力回避)
  //   - Unsplash カテゴリも撤去 (BYO API キー方式が Unsplash API Guidelines
  //     と衝突するため、素材ソースは Pexels 単独に絞る)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/*
          F-#9 修正 (2026-05-19): 元は overflow-y-auto を親に付けていたため、
          内側の検索結果エリア (flex-1 + h-full overflow-y-auto) がスクロール
          できなかった (Windows 11 marche_izm さん報告)。
          親を overflow-hidden + min-h-0 にして、スクロールは結果エリアだけが
          持つ単一スクロール構造に変更。検索フォームは常時固定表示される。
        */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
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

        <div className="shrink-0 border-b border-[#242424] px-4 py-3">
          {/*
            プロバイダタブは Pexels のみ。Unsplash は法務対応 (2026-05-21) で
            撤去済み。将来別の素材ソースを足す時は配列化を復活させる。

            shrink-0 必須 (F-#9 marche_izm さん報告の再修正 2026-05-27):
            親の flex-col 内でこのヘッダ群が縮むと、検索結果エリアの flex-1 が
            意図した高さにならず、結果一覧がスクロールできなくなる。
          */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={[
                "flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-bold",
                "border-pink-400 bg-pink-500/15 text-pink-100",
              ].join(" ")}
              title={connected ? `${PEXELS_PROVIDER.label} で検索` : `${PEXELS_PROVIDER.label} に接続`}
            >
              {connected && <span className="text-lime-400">●</span>}
              {PEXELS_PROVIDER.label}
            </span>
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
          </div>
        </div>

        {/*
          選択バーは画像 grid の上に floating (絶対配置) で重ねる。
          こうすると選択時に画像が下にシフトせず、UX 違和感が消える。
        */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200">
              {error}
            </p>
          )}

          {results.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs text-neutral-500">
              {connected
                ? "キーワードを入力して検索してください"
                : `設定 → 接続先で ${PEXELS_PROVIDER.label} の API キーを登録してください`}
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
                    key={`pexels-${photo.id}`}
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
                            ? `Pexels by ${photo.author}`
                            : "Pexels stock photo"
                        }
                        width={photo.width || 1}
                        height={photo.height || 1}
                        className="block w-full pointer-events-none select-none"
                        loading="lazy"
                        style={
                          photo.width && photo.height
                            ? { aspectRatio: `${photo.width}/${photo.height}` }
                            : undefined
                        }
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
                      <span className="absolute inset-x-2 bottom-8 rounded bg-pink-500/90 px-2 py-1 text-center text-[10px] font-black text-white">
                        追加中
                      </span>
                    )}
                    {/*
                      クレジット常時表示 (2026-05-21 法務対応):
                      Pexels License はクレジット任意だが、商用案件のトレース性を
                      上げるため画像下に薄く常時表示する。元ページへのリンクは
                      下部フッターに集約 (ホバーで詳細, 大きな画面遷移はモーダル経由)。
                    */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 py-1 text-[10px] font-semibold text-neutral-200">
                      <span className="opacity-90">Pexels</span>
                      {photo.author && (
                        <>
                          <span className="opacity-50"> / </span>
                          <span className="opacity-90">by {photo.author}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>

        {/*
          フッターも shrink-0 必須 (F-#9 marche_izm さん報告の再修正 2026-05-27):
          縮まないことを明示しないと、結果エリアの flex-1 が押し上げられて
          モーダル全体がオーバーフローし、結果一覧がスクロールできなくなる。
        */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#242424] px-4 py-3">
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
                  ? `Pexels by ${previewPhoto.author}`
                  : "Pexels preview"
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
        画像分析の結果モーダル は法務対応 (2026-05-21) で撤去。
        Pexels / Unsplash 画像を AI モデルに入力するフローは
        Unsplash 規約 (AI 学習・データセット禁止) と衝突するため、
        ストック素材は「合成・シーン素材」用途に限定する設計に統一した。
      */}
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
