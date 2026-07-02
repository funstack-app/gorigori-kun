import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useProjects } from "../lib/store/projects";
import { useSnsExport } from "../lib/store/snsExport";
import { useToasts } from "../lib/store/toasts";
import { sendImageToPlanForRediscuss } from "../lib/sendToPlan";
import { setDragRef } from "../lib/dragRef";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { deleteGalleryImage } from "./galleryItemMenu";
import { ImageMetaPanel } from "./ImageMetaPanel";
import { RegisterPresetDialog } from "./RegisterPresetDialog";

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
  /** F-#1: プリセット登録ダイアログの開閉。null なら閉じ、文字列なら対象画像 path。 */
  const [presetTarget, setPresetTarget] = useState<string | null>(null);
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

  if (!path) return null;

  const name = item?.name ?? path.split("/").pop() ?? "";

  return (
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
        {/^.+\.(mp4|webm|mov|m4v)$/i.test(path) ? (
          // 動画は controls 付きで再生 (音も出る)。クリックで再生/一時停止できるよう
          // モーダルの閉じ操作と競合しないよう stopPropagation。
          <video
            src={convertFileSrc(path)}
            className={
              fullscreen
                ? "max-h-screen max-w-full object-contain"
                : "max-h-full max-w-full object-contain"
            }
            controls
            autoPlay
            loop
            playsInline
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setFullscreen((v) => !v);
            }}
          />
        ) : (
          <img
            src={convertFileSrc(path)}
            alt={name}
            className={
              fullscreen
                ? "max-h-screen max-w-full cursor-zoom-out object-contain"
                : "max-h-full max-w-full cursor-zoom-in object-contain"
            }
            draggable
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
          className="flex h-full w-[360px] shrink-0 flex-col border-l border-[#2a2a2a] bg-[#161616]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ヘッダ: タイトル + 閉じるボタン */}
          <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                PREVIEW
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#343434] bg-[#181818] text-neutral-300 outline-none transition hover:border-pink-400 hover:text-white focus-visible:border-pink-400 focus-visible:ring-2 focus-visible:ring-pink-400/40"
            >
              <CloseIcon />
            </button>
          </div>

          {/*
            STΛCK 指示 (2026-05-19): 右ペインを上下 2 ブロックに固定分離。
            - 上 (flex-1): メタ情報 (内部の ImageMetaPanel が自身で flex column を組み、
              プロンプト欄が border-t (下のアクションエリア) の直前まで縦に拡張する)
            - 下 (shrink-0): 次のアクションリスト
            これでアクションボタンの位置が画像ごとに動かず、プロンプトの長短にも
            影響されない安定したレイアウトになる。
          */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            <ImageMetaPanel path={path} />
          </div>

          {/* 次のアクションリスト (ペイン下部に固定) */}
          <div className="shrink-0 border-t border-[#242424] p-4">
            <p className="mb-2 text-[10px] font-black uppercase tracking-wide text-neutral-500">
              次のアクション
            </p>
            <div className="flex flex-col gap-1.5">
              {/*
                判定 (採用 / ボツ) を横並びのトグルで置く。押している方が
                色付きでハイライトされ、もう一度押すと候補に戻る (null)。
                ImageGallery のフィルタ「採用」「ボツ」と連動する。
              */}
              <div className="flex gap-1.5">
                <JudgementToggle
                  label="採用"
                  active={judgement === "adopted"}
                  activeClass="border-pink-400 bg-pink-500/20 text-pink-100"
                  onClick={() =>
                    void setJudgement(
                      path,
                      judgement === "adopted" ? null : "adopted",
                    )
                  }
                />
                <JudgementToggle
                  label="ボツ"
                  active={judgement === "rejected"}
                  activeClass="border-neutral-400 bg-neutral-500/25 text-neutral-100"
                  onClick={() =>
                    void setJudgement(
                      path,
                      judgement === "rejected" ? null : "rejected",
                    )
                  }
                />
              </div>
              <ActionRow
                icon={<ChatIcon />}
                label="企画で再検討"
                hint="GPT-5.5 と対話してプロンプトを練り直す"
                primary
                onClick={() => {
                  void sendImageToPlanForRediscuss(path);
                  close();
                }}
              />
              <ActionRow
                icon={<MaskIcon />}
                label="マスクで編集"
                hint="部分的に塗って AI 編集"
                onClick={() => {
                  openMask({ path, name });
                  close();
                }}
              />
              <ActionRow
                icon={<BookmarkIcon />}
                label="プリセットに登録"
                hint="プロンプト+画像をテンプレ化"
                onClick={() => setPresetTarget(path)}
              />
              <ActionRow
                icon={<SnsExportIcon />}
                label="SNS用に書き出し"
                hint="各 SNS の推奨サイズへリサイズ"
                onClick={() => useSnsExport.getState().open([path])}
              />
              <SaveToProjectAction path={path} />
              <ActionRow
                icon={<DownloadIcon />}
                label="名前を付けて保存"
                hint="ローカル PC にダウンロード"
                onClick={() => void useImages.getState().downloadAs(path, name)}
              />
              <ActionRow
                icon={<FinderIcon />}
                label="Finder で表示"
                hint="保存場所を開く"
                onClick={() => useImages.getState().revealInFinder(path)}
              />
            </div>
          </div>
        </aside>
      )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            [
              {
                label: "企画で再検討",
                icon: "T",
                onClick: () => {
                  void sendImageToPlanForRediscuss(path);
                  close();
                },
              },
              { kind: "separator" },
              {
                label: "プリセットに登録…",
                icon: "P",
                onClick: () => setPresetTarget(path),
              },
              { kind: "separator" },
              {
                label: "名前を付けて保存…",
                onClick: () =>
                  useImages.getState().downloadAs(path, name),
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
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget}
          defaultName={name}
          onClose={() => setPresetTarget(null)}
        />
      )}
    </div>
  );
}

/* ── 判定 (採用/ボツ) トグルボタン ───────────────────── */
function JudgementToggle({
  label,
  active,
  activeClass,
  onClick,
}: {
  label: string;
  active: boolean;
  activeClass: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        "flex-1 rounded-md border px-3 py-2 text-sm font-bold transition",
        active
          ? activeClass
          : "border-[#262626] bg-[#141414] text-neutral-400 hover:border-pink-400/40 hover:text-neutral-100",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/* ── 右ペイン用の縦リストアクション行 ───────────────────── */
function ActionRow({
  icon,
  label,
  hint,
  primary,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "group flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition",
        primary
          ? "border-pink-400/60 bg-pink-500/10 hover:border-pink-400 hover:bg-pink-500/20"
          : "border-[#262626] bg-[#141414] hover:border-pink-400/40 hover:bg-[#1a1a1a]",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          primary
            ? "bg-pink-500/20 text-pink-200"
            : "bg-[#1f1f1f] text-neutral-400 group-hover:text-pink-300",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={[
            "block text-sm font-bold",
            primary ? "text-pink-100" : "text-neutral-100",
          ].join(" ")}
        >
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

/** 「プロジェクトに保存」だけは既存ポップオーバーUIを活かしたいので別行に */
/**
 * 「プロジェクトに保存」アクション行。
 *
 * STΛCK 指示 (2026-05-19): 他の ActionRow と完全に同じ見た目で、クリックすると
 * 既存の SaveToProjectButton のポップオーバー (プロジェクト選択UI) を行の下に
 * 開く。旧版は ActionRow 内に SaveToProjectButton をめり込ませていたため、
 * テキストが改行されて統一感が崩れていた。
 */
function SaveToProjectAction({ path }: { path: string }) {
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
      <ActionRow
        icon={<ProjectIcon />}
        label="プロジェクトに保存"
        hint="作品の箱に追加して整理"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          className="mt-1 rounded-md border border-[#343434] bg-[#161616] p-2 shadow-2xl"
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
                className="h-7 flex-1 rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={handleCreateAndSave}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
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

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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

function BookmarkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
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
        ◱ プロジェクトに保存
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
