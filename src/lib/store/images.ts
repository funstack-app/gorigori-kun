import { create } from "zustand";
import {
  images as imagesIpc,
  onImageGenerated,
  type ImageEvent,
} from "../ipc";
import { createPersistGuard, describeOutcome } from "./persistGuard";
import { usePresets } from "./presets";
import { useProjects } from "./projects";
import { useReferenceRoles } from "./referenceRoles";

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
  /** AI 自動命名などで付いた表示題名。未設定なら name を使う。 */
  aiTitle?: string;
};

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "avi",
  "mkv",
]);

/** watcher の旧イベントには mediaType が無いため、拡張子から安全に補完する。 */
export function inferGalleryMediaType(path: string): "image" | "video" {
  const cleanPath = path.split(/[?#]/, 1)[0];
  const dot = cleanPath.lastIndexOf(".");
  const extension = dot >= 0 ? cleanPath.slice(dot + 1).toLowerCase() : "";
  return VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
}

/** 明示された種別を優先し、旧データだけ拡張子で補う。 */
export function galleryItemMediaType(item: GalleryItem): "image" | "video" {
  return item.mediaType ?? inferGalleryMediaType(item.path);
}

export type GalleryFilter = "all" | "favorites" | "adopted" | "rejected";

/** 画像の判定ステータス。未設定 (Map に無い) は「候補 (candidate)」扱い。 */
export type Judgement = "adopted" | "rejected";

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
  /** path -> 判定 (adopted / rejected)。Map に無い path は「候補」扱い。Persisted. */
  judgements: Map<string, Judgement>;
  judgementsLoaded: boolean;
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
  /** 複数素材のお気に入りを1回の永続化でまとめて変更する。 */
  setFavorites: (paths: string[], favorite: boolean) => Promise<void>;
  loadFavorites: () => Promise<void>;
  /** 単一画像の判定を設定する。value=null で判定を外す (候補に戻す)。Persisted. */
  setJudgement: (path: string, value: Judgement | null) => Promise<void>;
  loadJudgements: () => Promise<void>;
  pushActiveTurn: (turnId: string) => void;
  popActiveTurn: (turnId: string) => void;
  /** プロジェクトフォルダへ移動する。成功なら true、失敗なら false
   * (呼び出し側がトーストで実態を伝えられるよう握りつぶさず伝播する)。 */
  saveToProject: (path: string, projectDir: string) => Promise<boolean>;
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
  /** rr2: relink (画像パス修復) の旧→新マップを favorites / judgements へ一括適用する。
   *  変化があった側だけ 1 回ずつ永続化する (件数分の persist を避ける)。
   *  items / knownPaths は watcher が実体から作り直すため対象外。 */
  relinkPaths: (pathMap: Record<string, string>) => void;
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

/**
 * B-01 (Wave 2 REVISE): 起動時 relink が「お気に入り / 採否判定の読み込み完了前」に
 * 適用されると、後から完了したファイル読込が旧パスのまま state を丸ごと set し、
 * 張り替え済みの内容を上書きして消してしまう。
 *
 * 対策は 2 本立て:
 *
 * 1. **単一実行化** — loadFavorites / loadJudgements は in-flight の Promise を
 *    共有する (`favoritesLoading` / `judgementsLoading`)。従来は完了後に立つ
 *    `favoritesLoaded` フラグでしか多重呼出を弾いておらず、App.tsx と
 *    ImageGallery / ProjectGallery が同時に呼ぶと 2 本とも読込を走らせ、
 *    遅い方が先勝ちの結果を潰していた。
 *
 * 2. **pathMap のリプレイ** — relinkPaths が適用した対応表をここに累積し、
 *    ファイル読込の直後 (state に set する前) に必ず適用し直す。読込が relink より
 *    遅れて完了しても、その読込結果自体を新パスへ張り替えてから set するので、
 *    「後から旧パスで上書き」経路が閉じる。
 *
 * relink は起動時 / 設定の修復ボタン / 保存先変更後の 3 経路あり、いずれの順序でも
 * 成立させたいので、単発フラグではなく累積 Map を正本にする。
 */
const appliedRelinkMap = new Map<string, string>();

/** 累積 pathMap を辿って、旧パスの最終的な現在パスを返す (未登録ならそのまま)。 */
function currentPathFor(path: string): string {
  let cur = path;
  // 保存先変更を跨ぐと A→B, B→C と鎖になりうる。循環しても抜けるよう上限を置く。
  for (let i = 0; i < 8; i++) {
    const next = appliedRelinkMap.get(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

let favoritesLoading: Promise<void> | undefined;
let judgementsLoading: Promise<void> | undefined;

const FAVORITES_STORE_FILE = "favorites.json";
const FAVORITES_KEY = "paths";

const JUDGEMENTS_STORE_FILE = "judgements.json";
const JUDGEMENTS_KEY = "map";

/**
 * お気に入り・採否は **パスをキーにした作品メタ** (2026-08-06 / DL-15)。
 *
 * 以前は読込失敗を「空の正常状態」として確定し、次の toggle が既存メタを空基準で
 * 上書きしていた。favorites/judgements は画像そのものではないが、数百枚に付けた
 * 印は手作業でしか復元できないので、正本と同じ扱いで守る。
 *
 * parse は「形が壊れていたら invalid」。要素単位の不正 (未知の judgement 値) は
 * 従来どおり畳む — 値の追加は将来のバージョンで起きうる正常な差分であり、
 * それで書き込み全体を止めると新旧バージョンの往復で保存できなくなる。
 */
const favoritesGuard = createPersistGuard<string[]>({
  name: "favorites",
  file: FAVORITES_STORE_FILE,
  key: FAVORITES_KEY,
  parse: (raw) => {
    if (!Array.isArray(raw)) return { ok: false, reason: "配列ではありません" };
    for (const p of raw) {
      if (typeof p !== "string") {
        return { ok: false, reason: "パスが文字列でない要素があります" };
      }
    }
    return { ok: true, value: raw as string[] };
  },
});

const judgementsGuard = createPersistGuard<Record<string, Judgement>>({
  name: "judgements",
  file: JUDGEMENTS_STORE_FILE,
  key: JUDGEMENTS_KEY,
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: "オブジェクトではありません" };
    }
    const out: Record<string, Judgement> = {};
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      // 未知の値は畳む (将来バージョンの新しい判定値との後方互換)。
      if (value !== "adopted" && value !== "rejected") continue;
      out[path] = value;
    }
    return { ok: true, value: out };
  },
});

/**
 * judgements Map を永続化する。読込が未確定 / 失敗中なら **書かずに false**。
 * 返り値は呼び出し側の判断用 (現状は fire-and-forget が主)。
 */
async function persistJudgements(map: Map<string, Judgement>): Promise<boolean> {
  return judgementsGuard.save(Object.fromEntries(map));
}

/** favorites Set を永続化する。読込が未確定 / 失敗中なら **書かずに false**。 */
async function persistFavorites(favorites: Set<string>): Promise<boolean> {
  return favoritesGuard.save(Array.from(favorites));
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
  judgements: new Map(),
  judgementsLoaded: false,
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
          // ImageEvent の旧形式には種別フィールドが無い。動画拡張子をここで
          // mediaType="video" に補完し、画像と同じ仮想一覧へ載せる。
          mediaType: inferGalleryMediaType(ev.path),
        };
        return { items: [item, ...state.items], knownPaths: known };
      });
    });
  },

  setSelected: (p) => set({ selectedPath: p }),

  selectClick: (path, mods) =>
    set((s) => {
      const visible = s.items
        .filter((it) => matchesFilter(it.path, s.filter, s.favorites, s.judgements))
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

  // B-01: 単一実行化 + 読込結果への relink リプレイ。詳細は appliedRelinkMap の注釈。
  loadFavorites: () => {
    if (get().favoritesLoaded) return Promise.resolve();
    if (favoritesLoading) return favoritesLoading;
    favoritesLoading = (async () => {
      const outcome = await favoritesGuard.load();
      if (outcome.status !== "ok") {
        if (outcome.status !== "absent") {
          // 読めなかった。画面は空だが favoritesGuard が書き込みを封鎖するので、
          // その空が次の toggleFavorite で既存のお気に入りを潰すことはない。
          console.warn(`[favorites] ${describeOutcome(outcome)}`);
        }
        set({ favoritesLoaded: true });
        return;
      }
      const paths = outcome.value;
      // 読込中に relink が走っていた場合、ファイル上の旧パスを現在パスへ
      // 直してから set する (張り替え済み state の巻き戻しを防ぐ)。
      const mapped = paths.map(currentPathFor);
      const changed = mapped.some((p, i) => p !== paths[i]);
      set({ favorites: new Set(mapped), favoritesLoaded: true });
      // 張り替えが起きたならファイル側も現在パスへ揃えておく
      // (次回起動で再び旧パスを読み直さないように)。
      if (changed) void persistFavorites(get().favorites);
    })().finally(() => {
      favoritesLoading = undefined;
    });
    return favoritesLoading;
  },

  toggleFavorite: async (path) => {
    // 起動直後 (読込未完了) の toggle でディスクの既存お気に入りを空基準で
    // 上書きしない。loadFavorites は favoritesLoaded ガード付きで冪等。
    if (!get().favoritesLoaded) await get().loadFavorites();
    const next = new Set(get().favorites);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ favorites: next });
    await persistFavorites(next);
  },

  setFavorites: async (paths, favorite) => {
    if (!get().favoritesLoaded) await get().loadFavorites();
    const next = new Set(get().favorites);
    let changed = false;
    for (const path of new Set(paths)) {
      if (favorite && !next.has(path)) {
        next.add(path);
        changed = true;
      } else if (!favorite && next.delete(path)) {
        changed = true;
      }
    }
    if (!changed) return;
    set({ favorites: next });
    await persistFavorites(next);
  },

  // B-01: favorites と同型 (単一実行化 + 読込結果への relink リプレイ)。
  loadJudgements: () => {
    if (get().judgementsLoaded) return Promise.resolve();
    if (judgementsLoading) return judgementsLoading;
    judgementsLoading = (async () => {
      const outcome = await judgementsGuard.load();
      if (outcome.status !== "ok") {
        if (outcome.status !== "absent") {
          // 読めなかった。judgementsGuard が書き込みを封鎖するので、この空が
          // 次の setJudgement で既存の採否を潰すことはない。
          console.warn(`[judgements] ${describeOutcome(outcome)}`);
        }
        set({ judgementsLoaded: true });
        return;
      }
      const map = new Map<string, Judgement>();
      let changed = false;
      for (const [path, value] of Object.entries(outcome.value)) {
        const cur = currentPathFor(path);
        if (cur !== path) changed = true;
        map.set(cur, value);
      }
      set({ judgements: map, judgementsLoaded: true });
      if (changed) void persistJudgements(get().judgements);
    })().finally(() => {
      judgementsLoading = undefined;
    });
    return judgementsLoading;
  },

  setJudgement: async (path, value) => {
    // toggleFavorite と同じ理由。読込前の変更でディスクの採否を潰さない。
    if (!get().judgementsLoaded) await get().loadJudgements();
    const next = new Map(get().judgements);
    if (value === null) next.delete(path);
    else next.set(path, value);
    set({ judgements: next });
    await persistJudgements(next);
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
        // Carry the judgement over to the new path as well.
        const judgements = new Map(state.judgements);
        const j = judgements.get(path);
        if (j !== undefined) {
          judgements.delete(path);
          judgements.set(dest, j);
        }
        return {
          items,
          knownPaths: new Set(items.map((it) => it.path)),
          favorites,
          judgements,
          selectedPath:
            state.selectedPath === path ? dest : state.selectedPath,
        };
      });
      // Persist favorites if path changed (封鎖中なら書かずに false が返る)
      await persistFavorites(get().favorites);
      // Persist judgements if path changed (best effort)
      await persistJudgements(get().judgements);
      // biy: 移動もリネーム (renameLocal) と同じ追従面に揃える。
      // history.db は Rust 側 images_save_to_project が UPDATE 済み。
      // ここを欠くと、移動した画像がプロジェクト/プリセット/ロールから参照切れになる。
      try {
        useProjects.getState().renameItemPath(path, dest);
      } catch (err) {
        console.warn("[images.saveToProject] projects path 追従に失敗:", err);
      }
      try {
        usePresets.getState().renameImagePath(path, dest);
      } catch (err) {
        console.warn("[images.saveToProject] presets path 追従に失敗:", err);
      }
      try {
        useReferenceRoles.getState().renamePath(path, dest);
      } catch (err) {
        console.warn("[images.saveToProject] referenceRoles path 追従に失敗:", err);
      }
      return true;
    } catch (err) {
      console.error("save_to_project failed", err);
      return false;
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
    set((state) => {
      // 判定 Map からも掃除する (削除済み path の孤立エントリ / stale 永続化を防ぐ)。
      let judgements = state.judgements;
      if (judgements.has(path)) {
        judgements = new Map(judgements);
        judgements.delete(path);
        void persistJudgements(judgements);
      }
      // お気に入りも同じ扱いに揃える (S3)。judgements だけ掃除して favorites を
      // 残していたのは非対称のバグ。favorites.json はファイルから読み戻される
      // (loadFavorites) ため、掃除しないと**再起動で死んだパスが復活し**、
      // お気に入りフィルタに読めない画像が並ぶ。
      let favorites = state.favorites;
      if (favorites.has(path)) {
        favorites = new Set(favorites);
        favorites.delete(path);
        void persistFavorites(favorites);
      }
      return {
        items: state.items.filter((it) => it.path !== path),
        knownPaths: new Set(
          state.items.filter((it) => it.path !== path).map((it) => it.path),
        ),
        judgements,
        favorites,
      };
    });
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
      // favorites / judgements も古い path を握っていたら新 path へ付け替える。
      let favorites = state.favorites;
      if (favorites.has(oldPath)) {
        favorites = new Set(favorites);
        favorites.delete(oldPath);
        favorites.add(newPath);
        // 付け替えたら永続化する。ここを欠くと再起動でお気に入りが旧パスに
        // 戻り、リネーム済みの画像がフィルタから消える (judgements と同じ扱い)。
        void persistFavorites(favorites);
      }
      let judgements = state.judgements;
      const j = judgements.get(oldPath);
      if (j !== undefined) {
        judgements = new Map(judgements);
        judgements.delete(oldPath);
        judgements.set(newPath, j);
        void persistJudgements(judgements);
      }
      // 注意: ここでは renameNonce を上げない。複数枚を逐次 renameLocal する
      // (LibraryAutoRenameButton のループ) と N×M 回の getTurn 再取得が走るため、
      // nonce の increment は呼び出し側がループ後に bumpRenameNonce() で 1 回だけ行う。
      return { items, knownPaths, selectedPath, selection, favorites, judgements };
    });
    // F-#2 修正: 全プロジェクトの items[].imagePath も追従して書き換える。
    // Rust 側で history.db は UPDATE 済み (images_rename), projects.json はフロント管理。
    try {
      useProjects.getState().renameItemPath(oldPath, newPath);
    } catch (err) {
      console.warn("[images.renameLocal] projects path 追従に失敗:", err);
    }
    // d98: プリセット (添付画像 / キャラの正本画像・sheetRoles) も追従させる。
    // ここを欠くとライブラリでリネームした瞬間にキャラ登録の参照画像が切れる。
    try {
      usePresets.getState().renameImagePath(oldPath, newPath);
    } catch (err) {
      console.warn("[images.renameLocal] presets path 追従に失敗:", err);
    }
    // r9c: 参照ロール割当 (これはキャラ/これはスタイル) も追従させる。
    // ここを欠くとリネームした瞬間にロールが既定 (キャラ) に剥がれる。
    try {
      useReferenceRoles.getState().renamePath(oldPath, newPath);
    } catch (err) {
      console.warn("[images.renameLocal] referenceRoles path 追従に失敗:", err);
    }
  },

  relinkPaths: (pathMap) => {
    const entries = Object.entries(pathMap).filter(
      ([oldPath, newPath]) => oldPath && newPath && oldPath !== newPath,
    );
    if (entries.length === 0) return;
    const map = new Map(entries);
    // B-01: 適用した対応表を累積しておく。favorites / judgements のファイル読込が
    // この relink より遅れて完了した場合、読込側が currentPathFor() でこの表を
    // 引き直し、旧パスのまま state を上書きするのを防ぐ。
    for (const [oldPath, newPath] of entries) {
      appliedRelinkMap.set(oldPath, newPath);
    }
    let favoritesChanged = false;
    let judgementsChanged = false;
    set((state) => {
      // favorites: 旧パスを持つものだけ新パスへ付け替える。
      let favorites = state.favorites;
      const favHits = Array.from(favorites).filter((p) => map.has(p));
      if (favHits.length > 0) {
        favorites = new Set(favorites);
        for (const oldPath of favHits) {
          favorites.delete(oldPath);
          favorites.add(map.get(oldPath) as string);
        }
        favoritesChanged = true;
      }
      // judgements: 採用/ボツの判定値は保持したままキーだけ差し替える。
      let judgements = state.judgements;
      const judgeHits = Array.from(judgements.keys()).filter((p) => map.has(p));
      if (judgeHits.length > 0) {
        judgements = new Map(judgements);
        for (const oldPath of judgeHits) {
          const j = judgements.get(oldPath) as Judgement;
          judgements.delete(oldPath);
          judgements.set(map.get(oldPath) as string, j);
        }
        judgementsChanged = true;
      }
      if (!favoritesChanged && !judgementsChanged) return state;
      return { ...state, favorites, judgements };
    });
    // 変化した側だけ 1 回ずつ永続化する (renameLocal と同じ機構)。
    if (favoritesChanged) void persistFavorites(get().favorites);
    if (judgementsChanged) void persistJudgements(get().judgements);
  },

  bumpRenameNonce: () => set((state) => ({ renameNonce: state.renameNonce + 1 })),
}));

/**
 * ギャラリーのフィルタ (all / favorites / adopted / rejected) に対して、
 * 1 枚の画像が表示対象かを判定する。判定 Map に無い path は「候補」扱いなので
 * adopted / rejected のどちらのフィルタにもヒットしない。
 * ImageGallery の可視リスト算出と store の selectClick で共有する。
 */
export function matchesFilter(
  path: string,
  filter: GalleryFilter,
  favorites: Set<string>,
  judgements: Map<string, Judgement>,
): boolean {
  switch (filter) {
    case "favorites":
      return favorites.has(path);
    case "adopted":
      return judgements.get(path) === "adopted";
    case "rejected":
      return judgements.get(path) === "rejected";
    default:
      return true;
  }
}

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
