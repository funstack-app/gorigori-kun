import { SafeImage } from "./SafeImage";
import { useMemo, useState } from "react";
import { useComposer } from "../lib/store/composer";
import { useImages, type GalleryItem } from "../lib/store/images";
import { useImagePreview } from "../lib/store/imagePreview";
import { useSessions, type Session } from "../lib/store/sessions";
import { useToasts } from "../lib/store/toasts";
import { Badge, Button, EmptyState, IconButton, SegmentedTabs } from "./ui";

type LibraryTab = "all" | "created" | "upload" | "favorites";

export function ProductSidebar() {
  const items = useImages((s) => s.items);
  const selectedPath = useImages((s) => s.selectedPath);
  const favorites = useImages((s) => s.favorites);
  const setSelected = useImages((s) => s.setSelected);
  const toggleFavorite = useImages((s) => s.toggleFavorite);
  const addReference = useComposer((s) => s.addReference);
  const pushToast = useToasts((s) => s.push);
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const displayedSession = useSessions((s) => s.displayedSession);
  const isFrozen = useSessions((s) => s.isFrozen);
  const loadingSessions = useSessions((s) => s.loading);
  const createSession = useSessions((s) => s.createNew);
  const switchToSession = useSessions((s) => s.switchTo);
  const renameSession = useSessions((s) => s.rename);
  const removeSession = useSessions((s) => s.remove);
  const [tab, setTab] = useState<LibraryTab>("all");
  const [query, setQuery] = useState("");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filteredImages = useMemo(() => {
    return items
      .filter((item) => {
        if (tab === "favorites" && !favorites.has(item.path)) return false;
        if (tab === "created" && item.kind !== "created") return false;
        if (tab === "upload" && !isUploadItem(item)) return false;
        if (!normalizedQuery) return true;
        return (
          item.name.toLowerCase().includes(normalizedQuery) ||
          item.path.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, 60);
  }, [favorites, items, normalizedQuery, tab]);
  const sessionMatches = useMemo(() => {
    return sessions
      .filter((session) => {
        if (!normalizedQuery) return true;
        return session.title.toLowerCase().includes(normalizedQuery);
      })
      .slice(0, 60);
  }, [normalizedQuery, sessions]);

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ kind: "success", text: `${label}をコピーしました`, ttlMs: 2200 });
    } catch {
      pushToast({ kind: "error", text: "コピーに失敗しました", ttlMs: 3000 });
    }
  };

  return (
    <aside className="flex h-full w-80 flex-col border-r border-neutral-200 bg-[#fbfbfc] text-neutral-950">
      <div className="border-b border-neutral-200 bg-white px-4 py-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">
              Assets
            </p>
            <h2 className="mt-1 text-xl font-black tracking-normal text-neutral-950">
              ライブラリ
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              生成物・アップロード・指示をまとめて扱います
            </p>
          </div>
          <Badge>{items.length} 素材</Badge>
        </div>
        <label className="mt-3 block">
          <span className="sr-only">ライブラリ検索</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="画像名・パス・指示を検索"
            className="h-8 w-full rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-950 outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <div className="mt-3">
          <SegmentedTabs
            value={tab}
            onChange={setTab}
            options={[
              ["all", "すべて"],
              ["created", "生成"],
              ["upload", "追加"],
              ["favorites", "保存"],
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold text-neutral-800">画像素材</p>
          <p className="text-[10px] text-neutral-400">ドラッグで入力欄へ</p>
        </div>
        {filteredImages.length === 0 ? (
          <EmptyState
            title="該当する画像がありません"
            description="生成画像やアップロード素材がここに並びます。"
          />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filteredImages.map((item) => (
              <HistoryImage
                key={item.path}
                item={item}
                active={selectedPath === item.path}
                favorite={favorites.has(item.path)}
                onSelect={() => setSelected(item.path)}
                onPreview={() => useImagePreview.getState().open(item.path)}
                onAttach={() =>
                  addReference({
                    path: item.path,
                    name: item.name,
                    source: isUploadItem(item) ? "upload" : "gallery",
                    role: "subject",
                  })
                }
                onCopy={() => copyText(item.path, "画像パス")}
                onFavorite={() => void toggleFavorite(item.path)}
              />
            ))}
          </div>
        )}

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-neutral-800">プロジェクト</p>
              <p className="mt-0.5 text-[10px] text-neutral-400">
                ChatGPTの履歴のように制作を遡れます
              </p>
            </div>
            <Button
              size="xs"
              tone="primary"
              onClick={() => {
                void createSession("新規案件");
              }}
            >
              新規
            </Button>
          </div>
          <div className="space-y-1.5">
            {loadingSessions && <p className="text-xs text-neutral-500">読み込み中...</p>}
            {!loadingSessions && sessionMatches.length === 0 && (
              <EmptyState
                title="該当する案件がありません"
                description="新規制作を始めると案件として保存されます。"
              />
            )}
            {sessionMatches.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={!isFrozen && session.id === activeSessionId}
                viewing={isFrozen && displayedSession?.session.id === session.id}
                editing={editingSessionId === session.id}
                editingTitle={editingTitle}
                setEditingTitle={setEditingTitle}
                onOpen={() => void switchToSession(session.id)}
                onRenameStart={() => {
                  setEditingSessionId(session.id);
                  setEditingTitle(session.title);
                }}
                onRenameCancel={() => {
                  setEditingSessionId(null);
                  setEditingTitle("");
                }}
                onRenameSave={() => {
                  const title = editingTitle.trim();
                  if (!title) return;
                  void renameSession(session.id, title).then(() => {
                    setEditingSessionId(null);
                    setEditingTitle("");
                  });
                }}
                onExport={() => {
                  void useSessions.getState().exportZip(session.id);
                }}
                onDelete={() => {
                  if (session.id === activeSessionId) {
                    pushToast({
                      kind: "warn",
                      text: "開いている案件は削除できません。別の案件を開いてから削除してください。",
                      ttlMs: 3500,
                    });
                    return;
                  }
                  void (async () => {
                    const message = `案件「${session.title}」を削除しますか？`;
                    let ok = false;
                    try {
                      const { ask } = await import("@tauri-apps/plugin-dialog");
                      ok = await ask(message, { title: "案件の削除", kind: "warning" });
                    } catch {
                      ok = window.confirm(message);
                    }
                    if (!ok) return;
                    void removeSession(session.id);
                  })();
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function isUploadItem(item: GalleryItem) {
  return item.bucket.toLowerCase().includes("upload") || item.path.includes("/uploads/");
}

function SessionRow({
  session,
  active,
  viewing,
  editing,
  editingTitle,
  setEditingTitle,
  onOpen,
  onRenameStart,
  onRenameCancel,
  onRenameSave,
  onExport,
  onDelete,
}: {
  session: Session;
  active: boolean;
  viewing: boolean;
  editing: boolean;
  editingTitle: string;
  setEditingTitle: (value: string) => void;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameSave: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const selected = active || viewing;
  return (
    <div
      className={`rounded-xl border bg-white p-2.5 text-xs transition ${
        selected
          ? "border-blue-400 shadow-sm ring-2 ring-blue-100"
          : "border-neutral-200 hover:border-neutral-300 hover:shadow-sm"
      }`}
    >
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="h-11 w-11 flex-shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100"
          title="案件を開く"
        >
          {session.lastImagePath ? (
            <SafeImage
              path={session.lastImagePath}
              className="h-full w-full object-cover"
              fallbackLabel="GG"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[10px] font-black text-neutral-400">
              GG
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRenameSave();
                if (e.key === "Escape") onRenameCancel();
              }}
              autoFocus
              className="h-7 w-full rounded-md border border-blue-300 bg-white px-2 text-xs font-semibold text-neutral-950 outline-none ring-2 ring-blue-100"
            />
          ) : (
            <button
              type="button"
              onClick={onOpen}
              className="block max-w-full truncate text-left text-sm font-bold text-neutral-950"
              title={session.title}
            >
              {session.title}
            </button>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-400">
            <span>{timeAgo(session.lastUsedAt)}</span>
            {active && <span className="text-blue-700">作業中</span>}
            {viewing && <span className="text-blue-700">表示中</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-1">
        {editing ? (
          <>
            <Button size="xs" tone="primary" onClick={onRenameSave} className="flex-1">
              保存
            </Button>
            <Button size="xs" onClick={onRenameCancel} className="flex-1">
              戻す
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" onClick={onOpen} className="flex-1">
              開く
            </Button>
            <Button size="xs" onClick={onRenameStart} className="flex-1">
              名前
            </Button>
            <Button size="xs" onClick={onExport} className="flex-1">
              書出
            </Button>
            <Button size="xs" tone="danger" onClick={onDelete} className="flex-1">
              削除
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "たった今";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}日前`;
  return new Date(ms).toLocaleDateString("ja-JP", {
    month: "numeric",
    day: "numeric",
  });
}

function HistoryImage({
  item,
  active,
  favorite,
  onSelect,
  onPreview,
  onAttach,
  onCopy,
  onFavorite,
}: {
  item: GalleryItem;
  active: boolean;
  favorite: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onAttach: () => void;
  onCopy: () => void;
  onFavorite: () => void;
}) {
  const dragPayload = JSON.stringify({
    path: item.path,
    name: item.name,
    source: isUploadItem(item) ? "upload" : "gallery",
    role: "subject",
  });

  return (
    <div
      className={`group overflow-hidden rounded-xl border bg-white transition hover:-translate-y-0.5 hover:shadow-md ${
        active ? "border-blue-500 ring-2 ring-blue-100" : "border-neutral-200"
      }`}
    >
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-gori-reference", dragPayload);
          e.dataTransfer.setData("application/json", dragPayload);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={onSelect}
        onDoubleClick={onPreview}
        className="relative block aspect-square w-full bg-neutral-100"
        title={item.name}
      >
        <SafeImage
          path={item.path}
          alt={item.name}
          className="h-full w-full object-cover"
          loading="lazy"
          draggable={false}
        />
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
          Drag
        </span>
        {favorite && (
          <span className="absolute right-1.5 top-1.5 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-bold text-neutral-950 shadow-sm">
            Saved
          </span>
        )}
      </button>
      <div className="border-t border-neutral-100 p-1.5">
        <div className="flex gap-1">
          <Button size="xs" tone="primary" onClick={onAttach} className="flex-1 px-1">
            参照
          </Button>
          <IconButton label="拡大表示" onClick={onPreview}>
            □
          </IconButton>
          <IconButton label="パスをコピー" onClick={onCopy}>
            #
          </IconButton>
          <IconButton
            label={favorite ? "お気に入りから外す" : "お気に入りに追加"}
            active={favorite}
            onClick={onFavorite}
          >
            S
          </IconButton>
        </div>
      </div>
    </div>
  );
}
