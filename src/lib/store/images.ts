import { create } from "zustand";
import {
  images as imagesIpc,
  onImageGenerated,
  type ImageEvent,
} from "../ipc";
import { useProjects } from "./projects";

export type GalleryItem = {
  path: string;
  name: string;
  bucket: string;
  mtimeMs: number;
  size: number;
  kind: "initial" | "created";
  /** Bound to the active turn that produced it (best-effort heuristic). */
  turnId?: string;
  /** If we already moved this image into the project, the destination path. */
  savedTo?: string;
  /** For derived images: parent reference path. */
  derivedFrom?: string;
  // 動画対応 (P0-3, 2026-05-28)。未指定は "image" 扱い。
  mediaType?: "image" | "video";
  /** 動画のみ。 */
  durationSeconds?: number;
  /** 動画サムネイルのパス。 */
  thumbnailPath?: string;
};

export type GalleryFilter = "all" | "favorites";

type ImagesState = {
  items: GalleryItem[];
  knownPaths: Set<string>;
  watching: boolean;
  watchDir?: string;
  attached: boolean;
  selectedPath?: string;
  /** Multi-selection set. Plain click sets single; Cmd-click toggles;
   *  Shift-click extends from `selectionAnchor` through the clicked path. */
  selection: Set<string>;
  selectionAnchor?: string;
  filter: GalleryFilter;
  /** Set of paths that the user has marked as favorite. Persisted. */
  favorites: Set<string>;
  favoritesLoaded: boolean;
  // Active turns whose image_gen output we should attribute. Stack so we can
  // bind to the most recently started one without losing earlier turns that
  // haven't reached turn/completed yet.
  activeTurns: string[];
  startWatcher: () => Promise<void>;
  attachListeners: () => Promise<void>;
  setSelected: (p: string | undefined) => void;
  /** Selection helper called from the gallery cell click. Mods determine
   *  the action: plain = single, cmd = toggle, shift = range. */
  selectClick: (
    path: string,
    mods: { meta?: boolean; shift?: boolean },
  ) => void;
  clearSelection: () => void;
  setFilter: (f: GalleryFilter) => void;
  toggleFavorite: (path: string) => Promise<void>;
  loadFavorites: () => Promise<void>;
  pushActiveTurn: (turnId: string) => void;
  popActiveTurn: (turnId: string) => void;
  saveToProject: (path: string, projectDir: string) => Promise<void>;
  revealInFinder: (path: string) => Promise<void>;
  /** Open a save dialog and copy the file to the chosen path. */
  downloadAs: (path: string, suggestedName?: string) => Promise<string | null>;
  /** Remove the background of `path` via the bundled Vision-API helper.
   * Returns the new transparent-PNG path on success, null on failure. */
  removeBackground: (
    path: string,
    bgColorHex?: string,
  ) => Promise<string | null>;
  remove: (path: string) => void;
  /** リネーム後にローカルキャッシュ (items + knownPaths) を更新する。
   *  Rust 側が rename を成功させた直後にフロントから呼ぶ。
   *  watcher の create/delete イベントが追いつかなくても古い path が残らないように手動同期する。 */
  renameLocal: (oldPath: string, newPath: string) => void;
  /** F-#2: リネームが起きるたびに +1 する世代カウンタ。タイムラインの
   *  PastBatchRow など「row.id では変化を検知できない」表示が、これを購読して
   *  リネーム後に turn 詳細を再取得し、旧パスの黒画像を解消するために使う。 */
  renameNonce: number;
  /** renameNonce を +1 する。複数枚を逐次 renameLocal する場合は、各回で上げると
   *  購読側 (PastBatchRow) の getTurn 再取得が N×M 回に膨らむため、ループ後に
   *  これを 1 回だけ呼ぶ。renameLocal 自体は nonce を上げない (増幅防止)。 */
  bumpRenameNonce: () => void;
};

let listenerHandle: undefined | (() => void);

const FAVORITES_STORE_FILE = "favorites.json";
const FAVORITES_KEY = "paths";

async function favoritesStore() {
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    return await loadStore(FAVORITES_STORE_FILE, {
      defaults: {},
      autoSave: true,
    });
  } catch {
    return null;
  }
}

export const useImages = create<ImagesState>((set, get) => ({
  items: [],
  knownPaths: new Set(),
  watching: false,
  attached: false,
  filter: "all",
  selection: new Set(),
  favorites: new Set(),
  favoritesLoaded: false,
  activeTurns: [],
  renameNonce: 0,

  startWatcher: async () => {
    if (get().watching) return;
    try {
      const r = await imagesIpc.startWatcher();
      set({ watching: r.watching, watchDir: r.dir });
    } catch (err) {
      console.warn("images_start_watcher failed", err);
    }
  },

  attachListeners: async () => {
    if (get().attached) return;
    set({ attached: true });
    listenerHandle?.();
    listenerHandle = await onImageGenerated((ev: ImageEvent) => {
      set((state) => {
        if (state.knownPaths.has(ev.path)) return state;
        const known = new Set(state.knownPaths);
        known.add(ev.path);
        // Bind to the most recently-started in-flight turn so concurrent
        // turns don't smear provenance.
        const turnId =
          ev.kind === "created"
            ? state.activeTurns[state.activeTurns.length - 1]
            : undefined;
        const item: GalleryItem = {
          path: ev.path,
          name: ev.name,
          bucket: ev.bucket,
          mtimeMs: ev.mtime_ms,
          size: ev.size,
          kind: ev.kind,
          turnId,
        };
        return { items: [item, ...state.items], knownPaths: known };
      });
    });
  },

  setSelected: (p) => set({ selectedPath: p }),

  selectClick: (path, mods) =>
    set((s) => {
      const visible = s.items
        .filter((it) =>
          s.filter === "favorites" ? s.favorites.has(it.path) : true,
        )
        .map((it) => it.path);
      // Cmd / Ctrl: toggle membership without changing the rest.
      if (mods.meta) {
        const next = new Set(s.selection);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return {
          selection: next,
          selectionAnchor: path,
          selectedPath: path,
        };
      }
      // Shift: extend the range from anchor through the clicked path.
      if (mods.shift && s.selectionAnchor) {
        const a = visible.indexOf(s.selectionAnchor);
        const b = visible.indexOf(path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const next = new Set(s.selection);
          for (let i = lo; i <= hi; i++) next.add(visible[i]);
          return { selection: next, selectedPath: path };
        }
      }
      // Plain click: collapse to a single selection.
      return {
        selection: new Set([path]),
        selectionAnchor: path,
        selectedPath: path,
      };
    }),

  clearSelection: () =>
    set({ selection: new Set(), selectionAnchor: undefined }),

  setFilter: (f) => set({ filter: f }),

  loadFavorites: async () => {
    if (get().favoritesLoaded) return;
    const store = await favoritesStore();
    if (!store) {
      set({ favoritesLoaded: true });
      return;
    }
    try {
      const paths = (await store.get<string[]>(FAVORITES_KEY)) ?? [];
      set({ favorites: new Set(paths), favoritesLoaded: true });
    } catch (err) {
      console.warn("favorites load failed", err);
      set({ favoritesLoaded: true });
    }
  },

  toggleFavorite: async (path) => {
    const next = new Set(get().favorites);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ favorites: next });
    const store = await favoritesStore();
    if (!store) return;
    try {
      await store.set(FAVORITES_KEY, Array.from(next));
      await store.save();
    } catch (err) {
      console.warn("favorites save failed", err);
    }
  },

  pushActiveTurn: (turnId) =>
    set((s) =>
      s.activeTurns.includes(turnId)
        ? s
        : { activeTurns: [...s.activeTurns, turnId] },
    ),
  popActiveTurn: (turnId) =>
    set((s) => ({ activeTurns: s.activeTurns.filter((id) => id !== turnId) })),

  saveToProject: async (path, projectDir) => {
    try {
      const dest = await imagesIpc.saveToProject(path, projectDir);
      set((state) => {
        const items = state.items.map((it) =>
          it.path === path ? { ...it, savedTo: dest, path: dest } : it,
        );
        // Carry the favorite flag over to the new path
        const favorites = new Set(state.favorites);
        if (favorites.delete(path)) favorites.add(dest);
        return {
          items,
          knownPaths: new Set(items.map((it) => it.path)),
          favorites,
          selectedPath:
            state.selectedPath === path ? dest : state.selectedPath,
        };
      });
      // Persist favorites if path changed
      const store = await favoritesStore();
      if (store) {
        try {
          await store.set(FAVORITES_KEY, Array.from(get().favorites));
          await store.save();
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      console.error("save_to_project failed", err);
    }
  },

  revealInFinder: async (path) => {
    try {
      await imagesIpc.revealInFinder(path);
    } catch (err) {
      console.warn("reveal failed", err);
    }
  },

  downloadAs: async (path, suggestedName) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const fallbackName =
        suggestedName ?? path.split("/").pop() ?? "image.png";
      const ext = fallbackName.split(".").pop() ?? "png";
      const dest = await save({
        defaultPath: fallbackName,
        filters: [{ name: "Image", extensions: [ext, "png", "jpg", "webp"] }],
      });
      if (typeof dest !== "string") return null;
      await imagesIpc.saveAs(path, dest);
      return dest;
    } catch (err) {
      console.error("downloadAs failed", err);
      return null;
    }
  },

  removeBackground: async (path, bgColorHex) => {
    const { useToasts } = await import("./toasts");
    try {
      const out = await imagesIpc.removeBackground(path, bgColorHex);
      // The watcher only sees ~/.codex/generated_images/, so files under
      // arbitrary cwds won't auto-register. Push the new item directly
      // into the gallery so the user sees it immediately.
      const stat = await statFileFallback(out);
      const item: GalleryItem = {
        path: out,
        name: out.split("/").pop() ?? "image-nobg.png",
        bucket: "removebg",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        kind: "created",
      };
      set((state) =>
        state.knownPaths.has(out)
          ? state
          : {
              items: [item, ...state.items],
              knownPaths: new Set([out, ...state.knownPaths]),
            },
      );
      useToasts.getState().push({
        kind: "success",
        text: "背景を透過しました",
        ttlMs: 3000,
      });
      return out;
    } catch (err) {
      console.error("removeBackground failed", err);
      useToasts.getState().push({
        kind: "error",
        text: `背景透過に失敗: ${String(err)}`,
        ttlMs: 5000,
      });
      return null;
    }
  },

  remove: (path) => {
    set((state) => ({
      items: state.items.filter((it) => it.path !== path),
      knownPaths: new Set(
        state.items.filter((it) => it.path !== path).map((it) => it.path),
      ),
    }));
  },

  renameLocal: (oldPath, newPath) => {
    set((state) => {
      // 旧 path が items に無くても何もしない (既に消えている時)
      const oldItem = state.items.find((it) => it.path === oldPath);
      if (!oldItem) return state;
      // 新 path の basename を name に流す
      const newName = newPath.split(/[\\/]/).pop() ?? oldItem.name;
      const items = state.items.map((it) =>
        it.path === oldPath ? { ...it, path: newPath, name: newName } : it,
      );
      const knownPaths = new Set(items.map((it) => it.path));
      // selectedPath / selection が古い path を握っていたら追従
      const selectedPath =
        state.selectedPath === oldPath ? newPath : state.selectedPath;
      const selection = new Set(state.selection);
      if (selection.has(oldPath)) {
        selection.delete(oldPath);
        selection.add(newPath);
      }
      // 注意: ここでは renameNonce を上げない。複数枚を逐次 renameLocal する
      // (LibraryAutoRenameButton のループ) と N×M 回の getTurn 再取得が走るため、
      // nonce の increment は呼び出し側がループ後に bumpRenameNonce() で 1 回だけ行う。
      return { items, knownPaths, selectedPath, selection };
    });
    // F-#2 修正: 全プロジェクトの items[].imagePath も追従して書き換える。
    // Rust 側で history.db は UPDATE 済み (images_rename), projects.json はフロント管理。
    try {
      useProjects.getState().renameItemPath(oldPath, newPath);
    } catch (err) {
      console.warn("[images.renameLocal] projects path 追従に失敗:", err);
    }
  },

  bumpRenameNonce: () => set((state) => ({ renameNonce: state.renameNonce + 1 })),
}));

async function statFileFallback(
  path: string,
): Promise<{ mtimeMs: number; size: number }> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const meta = await fs.stat(path);
    return {
      mtimeMs: Number(meta.mtime ?? Date.now()),
      size: Number(meta.size ?? 0),
    };
  } catch {
    return { mtimeMs: Date.now(), size: 0 };
  }
}

if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    listenerHandle?.();
    listenerHandle = undefined;
  });
}

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.images = useImages;
}
