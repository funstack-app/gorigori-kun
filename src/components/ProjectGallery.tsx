import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../lib/store/projects";
import { useProjects } from "../lib/store/projects";
import {
  inferGalleryMediaType,
  useImages,
  type GalleryItem,
} from "../lib/store/images";
import { useComposer } from "../lib/store/composer";
import { useSnsExport } from "../lib/store/snsExport";
import { useToasts } from "../lib/store/toasts";
import { VirtualGalleryGrid } from "./VirtualGalleryGrid";

/**
 * プロジェクト内画像を「ライブラリと同じ体験」で見せるグリッド。
 *
 * 実体は ImageGallery と同じ部品 (VirtualGalleryGrid + buildGalleryItemMenu +
 * ImagePreviewModal) の合成で、ライブラリ本体 (ImageGallery.tsx) には一切
 * 手を入れない。ライブラリと共有するのは favorites / judgements (path キーで
 * アプリ全体共有) だけで、選択状態はこのコンポーネントのローカル state に持つ
 * (ライブラリパネルの選択を壊さないため)。
 *
 * items が 0 件のときは呼び出し側 (ProjectDetailPanel) が DarkEmpty を出す前提で、
 * このコンポーネントは items > 0 でのみ描画される。
 */
export function ProjectGallery({ project }: { project: Project }) {
  const favorites = useImages((s) => s.favorites);
  const judgements = useImages((s) => s.judgements);
  const pushToast = useToasts((s) => s.push);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | undefined>();
  const [primary, setPrimary] = useState<string | undefined>();

  // ライブラリと同じ ♥ / 採用・ボツバッジを出すため、未ロードなら読み込む。
  // どちらも loaded ガード付きなので何度呼んでも安全。
  useEffect(() => {
    void useImages.getState().loadFavorites();
    void useImages.getState().loadJudgements();
  }, []);

  const galleryItems: GalleryItem[] = useMemo(
    () =>
      project.items.map((it) => ({
        path: it.imagePath,
        name: it.imagePath.split(/[\\/]/).pop() ?? it.imagePath,
        bucket: "project",
        mtimeMs: it.generation?.generatedAt ?? it.addedAt,
        size: 0,
        kind: "created" as const,
        mediaType: inferGalleryMediaType(it.imagePath),
      })),
    [project.items],
  );

  const visiblePaths = useMemo(
    () => galleryItems.map((it) => it.path),
    [galleryItems],
  );

  // 別プロジェクトを開いたら選択をリセットする。
  useEffect(() => {
    setSelection(new Set());
    setAnchor(undefined);
    setPrimary(undefined);
  }, [project.id]);

  // プロジェクトから外した / 削除された path を選択から落とす。
  useEffect(() => {
    const alive = new Set(visiblePaths);
    setSelection((prev) => {
      const next = new Set([...prev].filter((p) => alive.has(p)));
      return next.size === prev.size ? prev : next;
    });
    setPrimary((prev) => (prev && !alive.has(prev) ? undefined : prev));
    setAnchor((prev) => (prev && !alive.has(prev) ? undefined : prev));
  }, [visiblePaths]);

  /** images.ts の selectClick と同じ 3 分岐 (plain / meta トグル / shift レンジ)。 */
  const handleSelectClick = useCallback(
    (path: string, mods: { meta?: boolean; shift?: boolean }) => {
      if (mods.meta) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setAnchor(path);
        setPrimary(path);
        return;
      }
      if (mods.shift && anchor) {
        const a = visiblePaths.indexOf(anchor);
        const b = visiblePaths.indexOf(path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          setSelection((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(visiblePaths[i]);
            return next;
          });
          setPrimary(path);
          return;
        }
      }
      setSelection(new Set([path]));
      setAnchor(path);
      setPrimary(path);
    },
    [anchor, visiblePaths],
  );

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setAnchor(undefined);
  }, []);

  /**
   * 1 枚をプロジェクトから外す。ファイル実体はライブラリに残る非破壊操作なので
   * 確認ダイアログは挟まない。
   */
  const removeFromProject = useCallback(
    (path: string) => {
      const current = useProjects
        .getState()
        .projects.find((p) => p.id === project.id);
      const target = current?.items.find((it) => it.imagePath === path);
      if (!target) return;
      useProjects.getState().removeItem(project.id, target.id);
      pushToast({
        kind: "success",
        text: "プロジェクトから外しました（ライブラリには残ります）",
        ttlMs: 2500,
      });
    },
    [project.id, pushToast],
  );

  /** 選択分をまとめて外す。トーストはループ後に 1 回だけ出す。 */
  const removeSelectedFromProject = useCallback(() => {
    const current = useProjects
      .getState()
      .projects.find((p) => p.id === project.id);
    if (!current) return;
    const targets = current.items.filter((it) => selection.has(it.imagePath));
    for (const it of targets) {
      useProjects.getState().removeItem(project.id, it.id);
    }
    clearSelection();
    pushToast({
      kind: "success",
      text: `${targets.length} 枚をプロジェクトから外しました（ライブラリには残ります）`,
      ttlMs: 2500,
    });
  }, [clearSelection, project.id, pushToast, selection]);

  const attachSelected = useCallback(() => {
    const refs = galleryItems
      .filter((it) => selection.has(it.path))
      .map((it) => ({
        path: it.path,
        name: it.name,
        source: "gallery" as const,
      }));
    useComposer.getState().addReferences(refs);
    clearSelection();
    pushToast({
      kind: "success",
      text: `${refs.length} 枚を入力欄に添付しました`,
      ttlMs: 3500,
    });
  }, [clearSelection, galleryItems, pushToast, selection]);

  const favoriteSelected = useCallback(() => {
    void (async () => {
      for (const path of selection) {
        if (!useImages.getState().favorites.has(path)) {
          await useImages.getState().toggleFavorite(path);
        }
      }
      clearSelection();
    })();
  }, [clearSelection, selection]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <VirtualGalleryGrid
        items={galleryItems}
        selectedPath={primary}
        selection={selection}
        favorites={favorites}
        judgements={judgements}
        onSelectClick={handleSelectClick}
        onToggleFavorite={(p) => void useImages.getState().toggleFavorite(p)}
        onSetJudgement={(p, v) => void useImages.getState().setJudgement(p, v)}
        previewSiblings={visiblePaths}
        projectScope={{ onRemoveFromProject: removeFromProject }}
        minCellWidth={200}
      />

      {selection.size > 1 && (
        <div className="border-t border-[#2a2a2a] bg-[#181818] px-3 py-2 text-xs text-neutral-300">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-bold text-pink-300">
              {selection.size} 枚を選択中
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="text-neutral-500 hover:text-white"
              title="選択解除"
            >
              解除
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={attachSelected}
              className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              一括添付
            </button>
            <button
              type="button"
              onClick={favoriteSelected}
              className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              一括お気に入り
            </button>
            <button
              type="button"
              onClick={() =>
                useSnsExport.getState().open(Array.from(selection))
              }
              className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              SNS書き出し
            </button>
            <button
              type="button"
              onClick={removeSelectedFromProject}
              className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-[10px] font-bold text-neutral-300 hover:border-red-400 hover:text-red-300"
            >
              プロジェクトから外す ({selection.size})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
