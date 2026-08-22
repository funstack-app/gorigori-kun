import { useState, type ReactNode } from "react";

export type LibraryScope =
  | "all"
  | "favorites"
  | "image"
  | "video"
  | `project:${string}`;

export type LibraryProjectSummary = {
  id: string;
  name: string;
  count: number;
};

type LibrarySidebarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  scope: LibraryScope;
  onScopeChange: (scope: LibraryScope) => void;
  counts: { all: number; favorites: number; image: number; video: number };
  projects: LibraryProjectSummary[];
};

export function LibrarySidebar({
  query,
  onQueryChange,
  scope,
  onScopeChange,
  counts,
  projects,
}: LibrarySidebarProps) {
  const [collapsed, setCollapsed] = usePersistentCollapsedState();

  if (collapsed) {
    return (
      <aside
        data-tour="library-sidebar"
        className="flex w-12 shrink-0 flex-col items-center rounded-2xl border border-white/10 bg-white/[0.045] py-3 backdrop-blur-xl"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/10 hover:text-white"
          title="サイドバーを開く"
          aria-label="サイドバーを開く"
        >
          <PanelOpenIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-tour="library-sidebar"
      className="flex w-60 shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.045] backdrop-blur-xl"
    >
      <div className="flex items-center gap-2 border-b border-white/10 p-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-2.5 py-2 text-neutral-500 focus-within:border-pink-400/70 focus-within:text-pink-300">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="ファイル名・AI題名"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-neutral-100 outline-none placeholder:text-neutral-600"
            aria-label="ライブラリを検索"
          />
        </label>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-white/10 hover:text-white"
          title="サイドバーを折りたたむ"
          aria-label="サイドバーを折りたたむ"
        >
          <PanelCloseIcon />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="ライブラリの絞り込み">
        <SidebarButton
          active={scope === "all"}
          icon={<LibraryIcon />}
          label="すべてのアセット"
          count={counts.all}
          onClick={() => onScopeChange("all")}
        />
        <SidebarButton
          active={scope === "favorites"}
          icon={<HeartIcon />}
          label="お気に入り"
          count={counts.favorites}
          onClick={() => onScopeChange("favorites")}
        />

        <p className="mb-1 mt-4 px-2 text-[10px] font-bold tracking-wide text-neutral-600">
          種別
        </p>
        <SidebarButton
          active={scope === "image"}
          icon={<ImageIcon />}
          label="画像"
          count={counts.image}
          onClick={() => onScopeChange("image")}
        />
        <SidebarButton
          active={scope === "video"}
          icon={<VideoIcon />}
          label="動画"
          count={counts.video}
          onClick={() => onScopeChange("video")}
        />

        <div className="my-4 h-px bg-white/10" />
        <div className="mb-1 flex items-center justify-between px-2">
          <p className="text-[10px] font-bold tracking-wide text-neutral-600">
            プロジェクト
          </p>
          <FolderIcon />
        </div>
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-[10px] leading-relaxed text-neutral-600">
            プロジェクトはまだありません
          </p>
        ) : (
          projects.map((project) => (
            <SidebarButton
              key={project.id}
              active={scope === `project:${project.id}`}
              icon={<FolderIcon />}
              label={project.name}
              count={project.count}
              onClick={() => onScopeChange(`project:${project.id}`)}
            />
          ))
        )}
      </nav>
    </aside>
  );
}

const SIDEBAR_COLLAPSED_KEY = "library.sidebarCollapsed";

function usePersistentCollapsedState(): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
    } catch {
      // 表示設定なので、保存できなくても画面内の操作は続ける。
    }
  };
  return [collapsed, setCollapsed];
}

function SidebarButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "mb-0.5 flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[11px] transition",
        active
          ? "bg-pink-500/15 font-bold text-pink-200 ring-1 ring-pink-400/30"
          : "text-neutral-400 hover:bg-white/[0.06] hover:text-white",
      ].join(" ")}
    >
      <span className={active ? "text-pink-300" : "text-neutral-500"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="rounded-full bg-black/25 px-1.5 py-0.5 text-[9px] tabular-nums text-neutral-500">
        {count}
      </span>
    </button>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
      <path d="m5 18 5-5 3 3 2-2 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="3" y="5" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="m17 10 4-2v8l-4-2" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function PanelCloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 4v16m7-11-3 3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PanelOpenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 4v16m4-11 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
