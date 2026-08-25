import { useEffect, useMemo, useRef, useState } from "react";
import { useImagePreview } from "../lib/store/imagePreview";
import {
  ASSET_LEDGER_TYPE_OPTIONS,
  useAssetLedger,
} from "../lib/store/assetLedger";
import { useComposer } from "../lib/store/composer";
import { useImages } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useProjects } from "../lib/store/projects";
import { useSnsExport } from "../lib/store/snsExport";
import { useToasts } from "../lib/store/toasts";
import { useVideoGen } from "../lib/store/videoGen";
import { useWorkspace } from "../lib/store/workspace";
import { setDragRef } from "../lib/dragRef";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useEditor } from "./edit/editor/editorStore";
import {
  deleteGalleryImage,
  getImagePreviewPrimaryActions,
  resolveImagePreviewMetadata,
  type ImagePreviewMetadata,
} from "./galleryItemMenu";
import { SafeImage, SafeVideo } from "./SafeImage";
import { SceneFromImageDialog } from "./skills/scene3d/SceneFromImageDialog";
import { ModalPortal } from "./ModalPortal";

type LedgerUpsertInput = Parameters<
  ReturnType<typeof useAssetLedger.getState>["upsert"]
>[0];
type LedgerAssetType = LedgerUpsertInput["type"];

export function ImagePreviewModal() {
  const path = useImagePreview((s) => s.path);
  const close = useImagePreview((s) => s.close);
  const siblings = useImagePreview((s) => s.siblings);
  const goPrev = useImagePreview((s) => s.goPrev);
  const goNext = useImagePreview((s) => s.goNext);
  const setPreview = useImagePreview((s) => s.open);
  const openMask = useMaskEditor((s) => s.open);
  // Subscribe so the name updates if the gallery store loads the item
  // after the modal opens (rare, but happens when a generated image
  // arrives a tick after we navigate to its preview).
  const item = useImages((s) => s.items.find((it) => it.path === path));
  // 判定 (採用/ボツ)。path が変わっても購読で追従する。
  const judgement = useImages((s) => (path ? s.judgements.get(path) : undefined));
  const setJudgement = useImages((s) => s.setJudgement);
  const pushToast = useToasts((s) => s.push);
  // Fallback リスト: open(path) だけで開かれた場合も矢印キーで巡回できるように
  // useImages.items 全体 (mtime 降順) を採用する。
  // ライブラリ / タイムライン由来のプレビューはこれで十分カバー、
  // プロジェクト詳細など限定的な文脈は呼び出し側で open(path, siblings) を渡す。
  //
  // 重要: Zustand selector の中で .map() などの派生配列を返すと毎レンダー
  // 新しい参照になり、無限ループ → 白画面の原因になる (React + Zustand 安全パターン)。
  // raw の items を取得 → useMemo で path 配列を導出する。
  const galleryItems = useImages((s) => s.items);
  const fallbackSiblings = useMemo(
    () =>
      galleryItems.length > 0 ? galleryItems.map((it) => it.path) : undefined,
    [galleryItems],
  );
  const effectiveSiblings = siblings ?? fallbackSiblings;
  const canNavigate = !!effectiveSiblings && effectiveSiblings.length > 1;

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [panelTab, setPanelTab] = useState<"info" | "edit">("info");
  const [imageDimensions, setImageDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [assetRegisterOpen, setAssetRegisterOpen] = useState(false);
  const [assetRegisterBusy, setAssetRegisterBusy] = useState(false);
  const [previewMetadata, setPreviewMetadata] =
    useState<ImagePreviewMetadata | null>(null);
  // 3Dシーン化 (Slice D)。写真は元画像のほうがポーズ検出精度が高いので正規化はスキップ可
  const [scene3dTarget, setScene3dTarget] = useState<string | null>(null);
  /**
   * STΛCK 指示 (2026-05-19): 画像ダブルクリックで画面いっぱい表示。
   * もう一度ダブルクリック or Esc で通常表示に戻る。
   * メタ情報パネルや上部バー・矢印ボタンを一時的に非表示にして、画像だけに集中。
   */
  const [fullscreen, setFullscreen] = useState(false);
  // STΛCK 指示 (2026-05-19): Magnific 風レイアウトで詳細パネルは
  // 右ペインに常時表示されるため metaOpen ステートは不要 (削除済み)

  // siblings の文脈で前/次へ移動するヘルパー。siblings prop と fallback どちらでも動く。
  const navigateBy = (delta: 1 | -1) => {
    if (!path) return;
    if (siblings && siblings.length > 0) {
      delta === 1 ? goNext() : goPrev();
      return;
    }
    if (!fallbackSiblings || fallbackSiblings.length === 0) return;
    const idx = fallbackSiblings.indexOf(path);
    if (idx < 0) return;
    const next =
      fallbackSiblings[
        (idx + delta + fallbackSiblings.length) % fallbackSiblings.length
      ];
    setPreview(next);
  };

  const downloadImageAs = (imagePath: string, suggestedName: string) => {
    void useImages
      .getState()
      .downloadAs(imagePath, suggestedName)
      .catch((err) => {
        pushToast({
          kind: "error",
          text: `画像の保存に失敗しました: ${(err as Error)?.message ?? err}`,
          ttlMs: 6000,
        });
      });
  };

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // STΛCK 指示 (2026-05-19): fullscreen 中なら fullscreen を解除、
        // そうでなければモーダル自体を閉じる。
        if (fullscreen) {
          setFullscreen(false);
        } else {
          close();
        }
        return;
      }
      // 矢印キー (← / →) で前後の画像へ移動。input/textarea にフォーカスが
      // ある時はテキスト編集を優先するためスキップ。
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) {
          return;
        }
        e.preventDefault();
        navigateBy(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      // Trap Tab inside the dialog so keyboard users can't wander into
      // the chat behind us.
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // navigateBy はクロージャ更新で OK、依存に入れると毎レンダー張替えになる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, close, siblings, fallbackSiblings, fullscreen]);

  /*
    STΛCK 指示 (2026-05-19): フォーカスは「モーダルを最初に開いた時」だけ
    閉じるボタンに当てる。画像ナビ (path 変更) で再フォーカスすると緑の
    focus-ring が点滅して目障り。マウント時のみ実行。
  */
  useEffect(() => {
    closeBtnRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!path) {
      setPreviewMetadata(null);
      return;
    }
    let cancelled = false;
    setPreviewMetadata(null);
    void resolveImagePreviewMetadata(path).then((metadata) => {
      if (!cancelled) setPreviewMetadata(metadata);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    setPanelTab("info");
    setImageDimensions(null);
    setAssetRegisterOpen(false);
  }, [path]);

  if (!path) return null;

  const name = item?.name ?? path.split("/").pop() ?? "";
  // 動画は3Dシーン化の入力にできない (解析・ポーズ推定はどちらも静止画が前提)。
  // 表示の出し分けと右クリックメニューの出し分けで同じ判定を使う。
  const isVideo = /^.+\.(mp4|webm|mov|m4v)$/i.test(path);
  const primaryActions = previewMetadata
    ? getImagePreviewPrimaryActions(
        previewMetadata,
        isVideo ? "video" : "image",
      )
    : {
        canUseAsReference: !isVideo,
        canRecreate: false,
        recreateDisabledReason: "生成情報を読み込み中です。",
        canSave: true,
        canMakeVideo: !isVideo,
        canEditImage: !isVideo,
        canRegisterAsset: !isVideo,
      };

  const useAsReference = () => {
    if (!primaryActions.canUseAsReference) return;
    useComposer.getState().addReference({
      path,
      name,
      source: "gallery",
    });
    useWorkspace.getState().setActiveTab("generate");
    pushToast({
      kind: "success",
      text: "制作タブの参照画像に追加しました",
      ttlMs: 2600,
    });
    close();
  };

  const recreateWithSameSettings = () => {
    if (
      !previewMetadata ||
      !primaryActions.canRecreate ||
      !previewMetadata.prompt
    ) {
      return;
    }
    useComposer.getState().setText(previewMetadata.prompt);
    useWorkspace.getState().setActiveTab("generate");
    pushToast({
      kind: "success",
      text: "生成時のプロンプトを制作タブに読み込みました",
      ttlMs: 2800,
    });
    close();
  };

  const makeVideoFromImage = () => {
    if (!primaryActions.canMakeVideo) return;
    useVideoGen.getState().setSourceImage(path);
    useWorkspace.getState().setActiveTab("video");
    pushToast({
      kind: "success",
      text: "動画タブの開始画像に設定しました",
      ttlMs: 2600,
    });
    close();
  };

  const openEditStudio = () => {
    if (!primaryActions.canEditImage) return;
    useEditor.getState().setPendingOpenPath(path);
    useWorkspace.getState().setActiveTab("edit");
    close();
  };

  const openMaskEditor = () => {
    if (!primaryActions.canEditImage) return;
    openMask({ path, name });
    close();
  };

  const removeImageBackground = () => {
    if (!primaryActions.canEditImage) return;
    void useImages.getState().removeBackground(path);
    close();
  };

  const openSnsExport = () => {
    if (!primaryActions.canEditImage) return;
    useSnsExport.getState().open([path]);
    close();
  };

  const registerInAssetLedger = async (type: LedgerAssetType) => {
    if (!primaryActions.canRegisterAsset || assetRegisterBusy) return;
    setAssetRegisterBusy(true);
    try {
      let ledger = useAssetLedger.getState();
      if (!ledger.loaded) {
        await ledger.load();
        ledger = useAssetLedger.getState();
      }
      const id = `al-gallery-${encodeURIComponent(path)}`;
      const existing = ledger.assets.find((asset) => asset.id === id);
      const timestamp = new Date().toISOString();
      const asset: LedgerUpsertInput = {
        id,
        type,
        name: name.replace(/\.[^.]+$/, "") || name,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        primaryImagePath: path,
        imagePaths: existing?.imagePaths ?? [],
        prompt: previewMetadata?.prompt ?? "",
        negativePrompt: existing?.negativePrompt ?? null,
        source: "library",
        locked: existing?.locked ?? false,
        tags: existing?.tags ?? [],
      };
      await ledger.upsert(asset);
      setAssetRegisterOpen(false);
      pushToast({
        kind: "success",
        text: "アセット台帳に登録しました",
        ttlMs: 2600,
      });
    } catch (error) {
      pushToast({
        kind: "error",
        text: `アセット登録に失敗しました: ${String(error)}`,
        ttlMs: 5000,
      });
    } finally {
      setAssetRegisterBusy(false);
    }
  };

  const copyPreviewPrompt = async () => {
    const prompt = previewMetadata?.prompt?.trim();
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      pushToast({
        kind: "success",
        text: "プロンプトをコピーしました",
        ttlMs: 2400,
      });
    } catch {
      pushToast({
        kind: "error",
        text: "プロンプトのコピーに失敗しました",
        ttlMs: 4000,
      });
    }
  };

  return (
    <ModalPortal>
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
      role="dialog"
      aria-label="画像プレビュー"
      aria-modal="true"
      onClick={(event) => {
        // STΛCK 報告 (2026-05-19): クリックターゲットが「このバックドロップ自身」
        // の時だけ閉じる。モーダル内部のクリック (画像、ペイン、ContextMenu 等)
        // で誤って閉じないようにする。
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      {/*
        STΛCK 指示 (2026-05-19) Magnific 風レイアウト + ポップアップ化:
        - 全画面占有ではなく中央ポップアップ
        - 背景は bg-black/85 + backdrop-blur-md で強くぼかして奥行きを出す
        - モーダルは少し明るめの灰 (#1a1a1a) + 強い影 + 明るめのボーダーで
          背景から「浮いている」感を明示
        - 左ペイン: 画像エリア
        - 右ペイン: アクションペイン (固定幅 360px、縦スクロール)
        - fullscreen 時はこのコンテナを inset-0 化して画像のみ画面いっぱい
        - ダブルクリックで fullscreen トグル
      */}
      <div
        className={
          fullscreen
            ? "fixed inset-0 z-10 flex bg-black/95"
            : "flex h-[90vh] w-full max-w-7xl overflow-hidden rounded-xl border border-[#3a3a3a] bg-[#1a1a1a] shadow-[0_25px_80px_-15px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.05)] ring-1 ring-white/5"
        }
        onClick={(e) => e.stopPropagation()}
      >
      {/* 左: 画像エリア */}
      <div
        className={[
          "relative flex flex-1 items-center justify-center overflow-hidden bg-[#0a0a0a]",
          fullscreen ? "" : "p-6",
        ].join(" ")}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/*
          STΛCK 指示 (2026-05-19): 画像本体を drag source 化。プレビューから直接
          参照ラックや企画タブ等にドラッグで投げ込める。fullscreen 中も draggable
          のままだが、cursor の見た目で zoom-in/out 操作と区別できる。
        */}
        {isVideo ? (
          // 動画は controls 付きで再生 (音も出る)。クリックで再生/一時停止できるよう
          // モーダルの閉じ操作と競合しないよう stopPropagation。
          <SafeVideo
            path={path}
            className={
              fullscreen
                ? "max-h-screen max-w-full object-contain"
                : "max-h-full max-w-full object-contain"
            }
            fallbackLabel="動画が見つかりません"
            controls
            autoPlay
            loop
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setFullscreen((v) => !v);
            }}
          />
        ) : (
          <SafeImage
            path={path}
            alt={name}
            className={
              fullscreen
                ? "max-h-screen max-w-full cursor-zoom-out object-contain"
                : "max-h-full max-w-full cursor-zoom-in object-contain"
            }
            draggable
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setImageDimensions({
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              }
            }}
            onDragStart={(e) => {
              setDragRef(e.dataTransfer, {
                path,
                name,
                source: "gallery",
                role: "subject",
              });
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setFullscreen((v) => !v);
            }}
            title={
              fullscreen
                ? "ダブルクリックまたは Esc で通常表示に戻る"
                : "ダブルクリックで画面いっぱい / ドラッグで他へ移動"
            }
          />
        )}
        {canNavigate && !fullscreen && (
          <>
            <button
              type="button"
              aria-label="前の画像"
              title="前の画像 (←)"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(-1);
              }}
              className="absolute left-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white outline-none backdrop-blur transition hover:border-pink-400/60 hover:bg-pink-500/30 focus-visible:border-pink-400 focus-visible:ring-2 focus-visible:ring-pink-400/40"
            >
              <ChevronLeftIcon />
            </button>
            <button
              type="button"
              aria-label="次の画像"
              title="次の画像 (→)"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(1);
              }}
              className="absolute right-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white outline-none backdrop-blur transition hover:border-pink-400/60 hover:bg-pink-500/30 focus-visible:border-pink-400 focus-visible:ring-2 focus-visible:ring-pink-400/40"
            >
              <ChevronRightIcon />
            </button>
          </>
        )}
        {fullscreen && (
          /* fullscreen 中の閉じるヒント */
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setFullscreen(false);
            }}
            className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-md border border-white/30 bg-black/60 px-3 py-1.5 text-xs font-bold text-white backdrop-blur hover:border-pink-400 hover:bg-pink-500/30"
            title="通常表示に戻る (Esc)"
          >
            <MinimizeIcon /> 縮小
          </button>
        )}
        {/*
          STΛCK 指示 (2026-05-19): 左下のファイル名/操作ヒントは削除。
          画像を情報のメインにして余計な装飾は消す。
          閉じる導線は「枠外クリック」または「右ペインの×ボタン」に統一。
        */}
      </div>

      {/* 右: アクションペイン (fullscreen 時は非表示) */}
      {!fullscreen && (
        <aside
          className="flex h-full w-[390px] shrink-0 flex-col border-l border-white/10 bg-black/75 backdrop-blur-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ヘッダ: タイトル + 閉じるボタン */}
          <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                詳細
              </p>
              <p className="truncate text-sm font-bold text-white" title={name}>
                {name}
              </p>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={close}
              aria-label="閉じる"
              title="閉じる (Esc)"
              /*
                STΛCK 指示 (2026-05-19): 画像ナビ後に macOS system accent color の
                緑フォーカスリングが出る問題対策。ブラウザデフォルト outline を
                消し、キーボード操作時のみピンクの focus-visible ring を表示する。
              */
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#343434] bg-[#181818] text-neutral-300 outline-none transition hover:border-white/30 hover:text-white focus-visible:border-white/40 focus-visible:ring-2 focus-visible:ring-white/15"
            >
              <CloseIcon />
            </button>
          </div>

          <div
            className="grid h-11 shrink-0 grid-cols-2 border-b border-white/10 px-4"
            role="tablist"
            aria-label="詳細パネル"
          >
            {(["info", "edit"] as const).map((tab) => {
              const active = panelTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setPanelTab(tab)}
                  className={[
                    "relative text-xs font-bold outline-none transition",
                    active
                      ? "text-white after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-white"
                      : "text-neutral-500 hover:text-neutral-200",
                  ].join(" ")}
                >
                  {tab === "info" ? "情報" : "編集"}
                </button>
              );
            })}
          </div>

          {panelTab === "info" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
              <PreviewMetadataPanel
                key={path}
                metadata={previewMetadata}
                dimensions={imageDimensions}
                onCopyPrompt={() => void copyPreviewPrompt()}
              />

              <section className="mt-5 border-t border-white/10 pt-4">
                {primaryActions.canMakeVideo && (
                  <button
                    type="button"
                    onClick={makeVideoFromImage}
                    className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-pink-500 px-4 text-sm font-black text-white shadow-[0_10px_30px_-12px_rgba(236,72,153,0.9)] transition hover:bg-pink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-300/60"
                  >
                    <VideoIcon />
                    動画にする
                  </button>
                )}

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <StackActionButton
                    icon={<RecreateIcon />}
                    label="生成時の指示文を読み込む"
                    disabled={!primaryActions.canRecreate}
                    title={primaryActions.recreateDisabledReason ?? undefined}
                    onClick={recreateWithSameSettings}
                  />
                  <StackActionButton
                    icon={<ReferenceIcon />}
                    label="参照に使う"
                    disabled={!primaryActions.canUseAsReference}
                    title={
                      primaryActions.canUseAsReference
                        ? "制作タブの参照画像に追加"
                        : "動画は参照画像に追加できません"
                    }
                    onClick={useAsReference}
                  />
                </div>
                {!primaryActions.canRecreate &&
                  primaryActions.recreateDisabledReason && (
                    <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
                      {primaryActions.recreateDisabledReason}
                    </p>
                  )}

                <div className="mt-2">
                  <StackActionButton
                    icon={<DownloadIcon />}
                    label="保存"
                    disabled={!primaryActions.canSave}
                    title="名前を付けてローカル保存"
                    onClick={() => downloadImageAs(path, name)}
                    wide
                  />
                </div>

                <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-white/[0.07] pt-3">
                  <CompactActionButton
                    icon={<AdoptIcon />}
                    label="採用"
                    active={judgement === "adopted"}
                    onClick={() =>
                      void setJudgement(
                        path,
                        judgement === "adopted" ? null : "adopted",
                      )
                    }
                  />
                  <CompactActionButton
                    icon={<RejectIcon />}
                    label="ボツ"
                    active={judgement === "rejected"}
                    onClick={() =>
                      void setJudgement(
                        path,
                        judgement === "rejected" ? null : "rejected",
                      )
                    }
                  />
                  {primaryActions.canRegisterAsset && (
                    <AssetRegisterAction
                      open={assetRegisterOpen}
                      busy={assetRegisterBusy}
                      onToggle={() => setAssetRegisterOpen((value) => !value)}
                      onSelect={(type) => void registerInAssetLedger(type)}
                    />
                  )}
                  <SaveToProjectAction path={path} />
                  <CompactActionButton
                    icon={<FinderIcon />}
                    label="Finderで表示"
                    title="Finderで表示"
                    onClick={() => useImages.getState().revealInFinder(path)}
                  />
                </div>
              </section>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {primaryActions.canEditImage ? (
                <div className="flex flex-col gap-1.5">
                  <ActionRow
                    icon={<EditStudioIcon />}
                    label="ことばで直す"
                    hint="編集スタジオで画像を開く"
                    onClick={openEditStudio}
                  />
                  <ActionRow
                    icon={<MaskIcon />}
                    label="部分を塗って直す（マスク）"
                    hint="マスク編集を開く"
                    onClick={openMaskEditor}
                  />
                  <ActionRow
                    icon={<CropIcon />}
                    label="切り抜き・サイズ変更"
                    hint="編集スタジオの切り抜きを使う"
                    onClick={openEditStudio}
                  />
                  <ActionRow
                    icon={<TextIcon />}
                    label="文字を入れる"
                    hint="編集スタジオの文字編集を使う"
                    onClick={openEditStudio}
                  />
                  <ActionRow
                    icon={<BackgroundIcon />}
                    label="背景を透過"
                    hint="被写体を切り抜いて透過画像を作る"
                    onClick={removeImageBackground}
                  />
                  <ActionRow
                    icon={<SnsExportIcon />}
                    label="SNS用に書き出し"
                    hint="SNS向けサイズの書き出しを開く"
                    onClick={openSnsExport}
                  />
                </div>
              ) : (
                <p className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4 text-xs leading-relaxed text-neutral-500">
                  この動画に使える画像編集機能はありません。
                </p>
              )}
            </div>
          )}
        </aside>
      )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            [
              // 添付画像→3Dシーン再構成の主導線 (Slice D)。
              // 動画は入力にできないので項目ごと出さない (押せるのに必ず失敗する導線を作らない)。
              ...(isVideo
                ? []
                : [
                    {
                      label: "3Dシーンにする…",
                      icon: "3",
                      onClick: () => setScene3dTarget(path),
                    },
                    {
                      label: "アセットに登録…",
                      icon: "A",
                      onClick: () => {
                        setPanelTab("info");
                        setAssetRegisterOpen(true);
                      },
                    },
                  ]),
              { kind: "separator" },
              {
                label: "名前を付けて保存…",
                onClick: () => downloadImageAs(path, name),
              },
              {
                label: "マスクで編集",
                onClick: () => {
                  openMask({ path, name });
                  close();
                },
              },
              {
                label: "Finder で表示",
                onClick: () => useImages.getState().revealInFinder(path),
              },
              { kind: "separator" },
              {
                // F-#12: 没作品の削除。削除後はプレビューを閉じる。
                label: "削除…",
                danger: true,
                onClick: () => {
                  void deleteGalleryImage(path, name).then((deleted) => {
                    if (deleted) close();
                  });
                },
              },
            ] satisfies ContextMenuItem[]
          }
          onClose={() => setMenu(null)}
        />
      )}
      <SceneFromImageDialog
        open={scene3dTarget !== null}
        imagePath={scene3dTarget}
        onClose={() => setScene3dTarget(null)}
      />
    </div>
    </ModalPortal>
  );
}

/* ── 生成メタ情報 ─────────────────────────────────────── */
function PreviewMetadataPanel({
  metadata,
  dimensions,
  onCopyPrompt,
}: {
  metadata: ImagePreviewMetadata | null;
  dimensions: { width: number; height: number } | null;
  onCopyPrompt: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);

  if (!metadata) {
    return (
      <p className="text-[11px] text-neutral-500">生成情報を読み込み中...</p>
    );
  }

  const hasPrompt = !!metadata.prompt?.trim();
  const hasGenerationDetails = metadata.source === "history";
  const prompt = metadata.prompt ?? "";
  const canExpandPrompt =
    prompt.length > 100 || prompt.split(/\r?\n/).length > 4;

  return (
    <div className="flex flex-col gap-5 text-xs text-neutral-300">
      <section>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-black text-white">プロンプト</h3>
          {hasPrompt && (
            <button
              type="button"
              onClick={onCopyPrompt}
              className="text-[10px] font-bold text-neutral-400 transition hover:text-white"
              title="プロンプトをコピー"
            >
              コピー
            </button>
          )}
        </div>
        <div className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          {hasPrompt ? (
            <p
              className="whitespace-pre-wrap break-words text-[12px] leading-[1.65] text-neutral-200"
              style={
                promptExpanded
                  ? undefined
                  : {
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 4,
                      overflow: "hidden",
                    }
              }
            >
              {prompt}
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500">
              プロンプトは記録されていません。
            </p>
          )}
          {hasPrompt && canExpandPrompt && (
            <button
              type="button"
              onClick={() => setPromptExpanded((value) => !value)}
              className="mt-2 text-[11px] font-bold text-neutral-300 transition hover:text-white"
            >
              {promptExpanded ? "閉じる" : "すべて見る"}
            </button>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-black text-white">詳細</h3>
        <div className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          {(hasGenerationDetails || dimensions) && (
            <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-[11px]">
              {hasGenerationDetails && (
                <>
                  <dt className="text-neutral-500">モデル</dt>
                  <dd className="min-w-0 break-words text-neutral-200">
                    {metadata.modelLabel ?? "未記録"}
                  </dd>
                </>
              )}
              {dimensions && (
                <>
                  <dt className="text-neutral-500">サイズ</dt>
                  <dd className="text-neutral-200">
                    {dimensions.width} × {dimensions.height} px
                  </dd>
                </>
              )}
              {hasGenerationDetails && (
                <>
                  <dt className="text-neutral-500">生成日時</dt>
                  <dd className="text-neutral-200">
                    {metadata.generatedAt
                      ? new Date(metadata.generatedAt).toLocaleString("ja-JP")
                      : "未記録"}
                  </dd>
                </>
              )}
            </dl>
          )}
          {metadata.notice && (
            <p
              className={[
                "text-[11px] leading-relaxed text-neutral-500",
                hasGenerationDetails || dimensions
                  ? "mt-3 border-t border-white/[0.07] pt-3"
                  : "",
              ].join(" ")}
            >
              {metadata.notice}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/* ── 情報タブのアクション ─────────────────────────────── */
function StackActionButton({
  icon,
  label,
  disabled,
  title,
  onClick,
  wide = false,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={[
        "flex h-11 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-center text-[11px] font-bold text-neutral-200 outline-none transition hover:border-white/20 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/15 disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:bg-white/[0.015] disabled:text-neutral-600 disabled:ring-0",
        wide ? "w-full" : "",
      ].join(" ")}
    >
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function CompactActionButton({
  icon,
  label,
  active = false,
  disabled = false,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={[
        "flex min-h-14 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-[11px] font-bold leading-tight transition disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-white/25 bg-white/10 text-white"
          : "border-transparent bg-transparent text-neutral-500 hover:border-white/10 hover:bg-white/[0.04] hover:text-neutral-200",
      ].join(" ")}
    >
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}

function AssetRegisterAction({
  open,
  busy,
  onToggle,
  onSelect,
}: {
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onSelect: (type: LedgerAssetType) => void;
}) {
  return (
    <div className="relative min-w-0">
      <CompactActionButton
        icon={<AssetIcon />}
        label="アセットに登録"
        active={open}
        disabled={busy}
        title="種類を選んでアセット台帳に登録"
        onClick={onToggle}
      />
      {open && (
        <div
          className="absolute bottom-full left-1/2 z-50 mb-2 w-40 -translate-x-1/2 rounded-lg border border-[#343434] bg-[#161616] p-1.5 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="px-2 py-1 text-[10px] font-bold text-neutral-500">
            種類を選ぶ
          </p>
          {ASSET_LEDGER_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={busy}
              onClick={() => onSelect(option.value)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] font-bold text-neutral-200 hover:bg-white/[0.07] disabled:opacity-40"
            >
              {option.label}
              <ChevronRightSmallIcon />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 右ペイン用の縦リストアクション行 ───────────────────── */
function ActionRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-md border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5 text-left transition hover:border-white/15 hover:bg-white/[0.05]"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-neutral-500 group-hover:text-neutral-200">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-neutral-200">
          {label}
        </span>
        {hint && (
          <span className="block truncate text-[11px] text-neutral-500">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

/** 小アイコン行から既存のプロジェクト選択UIを開く。 */
function SaveToProjectAction({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const addItem = useProjects((s) => s.addItem);
  const pushToast = useToasts((s) => s.push);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    setOpen(false);
  }, [path]);

  const handleSave = (projectId: string, projectName: string) => {
    const item = addItem(projectId, { imagePath: path });
    if (item) {
      pushToast({
        kind: "success",
        text: `「${projectName}」に保存しました`,
        ttlMs: 2200,
      });
    }
    setOpen(false);
  };

  const handleCreateAndSave = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    handleSave(created.id, created.name);
    setDraftName("");
  };

  return (
    <div className="relative min-w-0">
      <CompactActionButton
        icon={<ProjectIcon />}
        label="プロジェクトに保存"
        active={open}
        title="プロジェクトに保存"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-md border border-[#343434] bg-[#161616] p-2 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            既存プロジェクト
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-neutral-500">
                まだプロジェクトがありません
              </p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleSave(project.id, project.name)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-[#1f1f1f]"
                >
                  <span className="truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {project.items.length} 件
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="mt-2 border-t border-[#242424] pt-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              新規作成して保存
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  const isComposing =
                    (event.nativeEvent as KeyboardEvent).isComposing ||
                    event.keyCode === 229;
                  if (event.key === "Enter" && !isComposing) {
                    event.preventDefault();
                    handleCreateAndSave();
                  } else if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="プロジェクト名"
                className="h-7 flex-1 rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none focus:border-white/40"
              />
              <button
                type="button"
                onClick={handleCreateAndSave}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-white px-2 text-[11px] font-bold text-black hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                作成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 既存トンマナの SVG アイコン群 (Lucide風: viewBox 24, stroke 2, round) ── */

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronRightSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v4a1 1 0 0 1-1 1H3" />
      <path d="M21 8h-4a1 1 0 0 1-1-1V3" />
      <path d="M3 16h4a1 1 0 0 1 1 1v4" />
      <path d="M16 21v-4a1 1 0 0 1 1-1h4" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="14" rx="2" />
      <path d="m17 10 4-2v8l-4-2z" />
    </svg>
  );
}

function EditStudioIcon() {
  // 編集スタジオ (キャンバスとペン先) を示すアイコン。
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </svg>
  );
}

function MaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function CropIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </svg>
  );
}

function BackgroundIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h7v7H3z" />
      <path d="M14 3h7v7h-7z" />
      <path d="M3 14h7v7H3z" />
      <path d="M14 14h7v7h-7z" />
    </svg>
  );
}

function AssetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 2 9 5-9 5-9-5z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

function AdoptIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RejectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SnsExportIcon() {
  // 共有/書き出しを示すアイコン (箱から矢印が出る)
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function ProjectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ReferenceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
      <path d="M18 3v5" />
      <path d="M15.5 5.5h5" />
    </svg>
  );
}

function RecreateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function FinderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 21H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v3" />
      <circle cx="18" cy="17" r="3" />
      <line x1="20.5" y1="19.5" x2="22" y2="21" />
    </svg>
  );
}

/**
 * 「プロジェクトに保存」ボタン + ポップオーバー。
 * 押すと既存プロジェクト一覧 + 新規作成入力が出てきて、選択でその箱に追加する。
 *
 * F-#4 (2026-05-19): export 化して、生成バッチの 1 枚ごとの保存にも再利用。
 */
export function SaveToProjectButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const addItem = useProjects((s) => s.addItem);
  const pushToast = useToasts((s) => s.push);
  const [draftName, setDraftName] = useState("");

  const handleSave = (projectId: string, projectName: string) => {
    const item = addItem(projectId, { imagePath: path });
    if (item) {
      pushToast({
        kind: "success",
        text: `「${projectName}」に保存しました`,
        ttlMs: 2200,
      });
    }
    setOpen(false);
  };

  const handleCreateAndSave = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    handleSave(created.id, created.name);
    setDraftName("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className={[
          "rounded border px-2 py-1 transition",
          open
            ? "border-pink-400 bg-pink-500/15 text-pink-100"
            : "border-pink-400/60 text-pink-200 hover:bg-pink-500/10",
        ].join(" ")}
        title="プロジェクトに保存"
      >
        <ProjectIcon />
        <span>プロジェクトに保存</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            既存プロジェクト
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-neutral-500">
                まだプロジェクトがありません
              </p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleSave(project.id, project.name)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                >
                  <span className="truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {project.items.length} 件
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="mt-2 border-t border-neutral-800 pt-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              新しいプロジェクトに保存
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  const isComposing =
                    (event.nativeEvent as KeyboardEvent).isComposing ||
                    event.keyCode === 229;
                  if (event.key === "Enter" && !isComposing) {
                    event.preventDefault();
                    handleCreateAndSave();
                  } else if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="プロジェクト名"
                className="h-7 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={handleCreateAndSave}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                作成して保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/*
 * SaveAsFormatButton: PNG/JPEG 形式選択保存ボタン。
 * STΛCK 指示 (2026-05-19) Magnific 風レイアウトで「名前を付けて保存」
 * (downloadAs) に統合されたため未使用化。今後復活させたくなったら history を辿る。
 */
