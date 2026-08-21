import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import type { SheetBackground, SheetPromptMode } from "../character/types";
import {
  type BackupListResult,
  ensureDailyBackupsSafe,
  toBackupListResult,
} from "./backupHealth";

/**
 * プロンプトプリセット管理。Midjourney Code Manager 仕様を参考に、
 * カテゴリ × プリセット のシンプルな 2 階層で管理する。
 *
 * 永続化 (2026-07-30 改修): presets.json (ファイル) が正本、localStorage は
 * 冗長バックアップ。localStorage のみだと WebView のビルドID
 * (app.codexframefactory / .dev / .capture) ごとに別領域になり、ビルドを跨ぐと
 * 空に見える + 終了タイミングで失われるため、再起動でキャラ/プリセットが消えた。
 */

export type PresetCategory = {
  id: string;
  name: string;
  /** 一覧で色マーカーに使う hex（#6366f1 等）。ユーザーがカラーピッカーで自由に変更可。 */
  color: string;
  /** カテゴリに紐づく任意タグ。検索やプリセットへの自動補完候補に使う。 */
  tags?: string[];
};

/**
 * サムネ表示時の focal point（注目点）と zoom。
 * Midjourney Code Manager 流の「ズーム + ドラッグで好きな位置に」に対応。
 *
 * - x / y: 0..1 の正規化座標。0 = 左/上、1 = 右/下、0.5 = 中央
 * - zoom: 1.0 = 等倍（object-cover と同じ）、3.0 = 3 倍ズーム
 *
 * 未指定なら center / zoom 1.0（=従来の object-cover と同等）。
 */
export type ThumbnailFocus = {
  x: number;
  y: number;
  zoom: number;
};

export const FOCUS_DEFAULT: ThumbnailFocus = { x: 0.5, y: 0.5, zoom: 1 };
export const FOCUS_ZOOM_MIN = 1;
export const FOCUS_ZOOM_MAX = 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampZoom = (v: number): number =>
  Math.min(FOCUS_ZOOM_MAX, Math.max(FOCUS_ZOOM_MIN, v));

/** focus 値を正規化（範囲外を clamp、未定義は中央 zoom1 へ）。 */
export function normalizeFocus(focus: ThumbnailFocus | undefined): ThumbnailFocus {
  if (!focus) return FOCUS_DEFAULT;
  return {
    x: clamp01(focus.x),
    y: clamp01(focus.y),
    zoom: clampZoom(focus.zoom),
  };
}

/**
 * 旧 9-grid 文字列値（"tl".."br"）から新 {x,y,zoom} へのマイグレーション。
 * 既存 localStorage を読み込む際に通す。
 */
function migrateLegacyFocus(value: unknown): ThumbnailFocus | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && "x" in (value as object) && "y" in (value as object)) {
    return normalizeFocus(value as ThumbnailFocus);
  }
  if (typeof value !== "string") return undefined;
  const map: Record<string, [number, number]> = {
    tl: [0, 0], tc: [0.5, 0], tr: [1, 0],
    cl: [0, 0.5], cc: [0.5, 0.5], cr: [1, 0.5],
    bl: [0, 1], bc: [0.5, 1], br: [1, 1],
  };
  const xy = map[value];
  if (!xy) return undefined;
  return { x: xy[0], y: xy[1], zoom: 1 };
}

/**
 * <img> 要素に当てる CSS スタイル。
 * - object-cover を前提に、object-position で focal point の周辺を見せる
 * - transform: scale で zoom を適用、transform-origin を focal point に合わせる
 *   → ズームアップしても focal point が画面中心に留まる
 */
export function focusToImageStyle(focus: ThumbnailFocus | undefined): {
  objectPosition: string;
  transform: string;
  transformOrigin: string;
} {
  const f = normalizeFocus(focus);
  const xPct = `${(f.x * 100).toFixed(2)}%`;
  const yPct = `${(f.y * 100).toFixed(2)}%`;
  return {
    objectPosition: `${xPct} ${yPct}`,
    transform: f.zoom !== 1 ? `scale(${f.zoom})` : "none",
    transformOrigin: `${xPct} ${yPct}`,
  };
}

/**
 * F-#7 (2026-05-19): プリセットに添付されるキャラ画像 (= 参照画像) の
 * 簡略 record。ファイルパスとオプションのロールだけ持ち、プリセット呼び出し時に
 * composer.references へ流す。
 */
export type PresetAttachedImage = {
  path: string;
  /** "subject" | "look" 等。composer.ReferenceRole と互換だが、依存を避けて string で持つ */
  role?: string;
};

/**
 * composer.ReferenceRole の許容値。presets → composer の境界で
 * 不正な role 文字列を弾くための検証セット。composer.ts に直接依存すると
 * 循環の懸念があるため、許容値だけをここに複製して保持する。
 */
const VALID_REFERENCE_ROLES = new Set([
  "subject",
  "look",
  "background",
  "product",
  "pose",
  "negative",
]);

/**
 * プリセット呼び出し時に composer.references へ流すための record。
 * presets 側は composer に依存しないので、role は検証済み string | undefined で返す。
 */
export type PresetReference = {
  path: string;
  name: string;
  source: "gallery";
  role?: string;
};

/**
 * preset.attachedImages を composer.addReferences に渡せる形へ変換する。
 * 境界検証: 不正 role は undefined に落とす（型の信頼を内部で担保）。
 * 呼び出し側 (PlanWorkspace / ConstructedPromptPanel / VideoConstructedPromptPanel)
 * で同じロジックを書かないよう一本化する。
 */
export function presetAttachedImagesToReferences(
  preset: Preset,
): PresetReference[] {
  if (!preset.attachedImages || preset.attachedImages.length === 0) return [];
  return preset.attachedImages.map((img) => ({
    path: img.path,
    name: img.path.split(/[\\/]/).pop() || "preset image",
    source: "gallery" as const,
    role:
      img.role && VALID_REFERENCE_ROLES.has(img.role) ? img.role : undefined,
  }));
}

/**
 * プリセットの種別（2026-07-19 スキル一覧v2.1 キャラクター登録）。
 * プリセット = プロンプトもキャラも入る型付きの箱（専用ボタンは増やさない方針）。
 * undefined は後方互換で "prompt" として扱う。
 */
export type PresetKind = "prompt" | "character";

/**
 * キャラ型プリセットのメタ情報。正本画像（3面図/表情/ディテール）は
 * attachedImages に格納し、既存の composer 流し込み経路をそのまま使う。
 */
export type CharacterMeta = {
  /** 属性テキスト（髪色・目・服装・体型など）。生成プロンプトに自動合成する */
  attributes?: string;
  /** 正本画像の役割マップ: path -> "front" | "side" | "back" | "face-detail" | "expression-*" 等 */
  sheetRoles?: Record<string, string>;
  /** IPアセット化パイプラインの同一性検品スコア（0-100） */
  identityScore?: number;
  /** 検品を通した日時（epoch ms）。未検品は undefined */
  verifiedAt?: number;
  /** 生成元になった元画像のパス */
  sourceImage?: string;
  /**
   * 生成元になった元画像の全量。先頭がメイン(同一性の正)。
   * 旧読み手 (表情差分・シート作り直し・パス改名移行) は sourceImage 単数を読むため、
   * 先頭を sourceImage にも重複保持する。読み出しは characterSourceImages() を使う。
   */
  sourceImages?: string[];
  /** シート生成時の背景色。省略 = "auto"(従来挙動) */
  sheetBackground?: SheetBackground;
  /** シートの作り方。省略 = "default"(既定シートテンプレ) */
  sheetPromptMode?: SheetPromptMode;
  /** 自分で作るモードで使ったプロンプト全文(作り直し用)。default モードでは持たない */
  sheetCustomPrompt?: string;
};

/** kind 未設定の旧データを含めて種別を解決する。 */
export function presetKind(preset: Preset): PresetKind {
  return preset.kind === "character" ? "character" : "prompt";
}

export type Preset = {
  id: string;
  name: string;
  /** 種別。undefined は後方互換で "prompt"。判定は presetKind() を使う */
  kind?: PresetKind;
  /** kind === "character" のときだけ持つメタ */
  characterMeta?: CharacterMeta;
  /** プロンプトに挿入される本文。日本語可、@imgN 記法も使える */
  prompt: string;
  /** どのカテゴリに属すか。null は「未分類」 */
  categoryId: string | null;
  description?: string;
  /** プリセット個別タグ（検索用）。 */
  tags?: string[];
  /**
   * サムネイル（base64 data URL）。1 枚のみ保存（MVP）。
   * 長辺 1024 / JPEG q=0.92 で 200-400KB 程度を想定。
   */
  thumbnail?: string;
  /** サムネ表示時のフォーカス点（9-grid）。未指定は中央（cc）。 */
  thumbnailFocus?: ThumbnailFocus;
  /**
   * F-#7 (2026-05-19): プリセットに紐づくキャラ添付画像。
   * Ta4low さん要望「プリセットでキャラ画像も保存」対応。
   * プリセット呼び出し時に composer.references にも流し込む。
   */
  attachedImages?: PresetAttachedImage[];
  /** お気に入りフラグ。Code Manager と同じ仕様（チップで絞り込み可）。 */
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SortKey =
  | "updatedDesc"
  | "updatedAsc"
  | "createdDesc"
  | "createdAsc"
  | "nameAsc"
  | "nameDesc"
  | "tagCountDesc";

const CATEGORIES_LS_KEY = "presets.categories";
const PRESETS_LS_KEY = "presets.presets";

/**
 * presets.json (正本ファイル) の形。categories と presets を 1 ファイルに
 * 同居させ、片方だけ保存される不整合を構造的に排除する。
 */
type PresetsFileData = {
  version: 1;
  categories: PresetCategory[];
  presets: Preset[];
};

export type PresetsFileState = "ok" | "missing" | "corrupted" | "unreadable";

/**
 * Tauri 経由でファイルに書く実体。
 * 書き込みが失敗したら、サイレントに握り潰さずユーザーへトースト通知する
 * (「保存できていないのに成功したと思う」型のデータ消失を防ぐ)。
 *
 * **2026-08-06 重大修正 (実ユーザーのプリセット30体消失)**: 以前はトースト通知の
 * あと `return` して**呼び出し側には成功として返っていた**。そのため初回移行
 * (localStorage → ファイル) が失敗しても移行側が成功扱いでファイル書き込みを解禁し、
 * 「ファイルは作られていないのに、作られた前提で動く」状態になった。そこへ掃除が
 * localStorage を消し、再起動で 0 件になった。
 * 失敗は**失敗として throw する**。呼び出し側が解禁判断に使う。
 */
async function writeToFileNow(
  data: PresetsFileData,
  allowEmpty: boolean,
): Promise<void> {
  try {
    await invoke("presets_write", { content: JSON.stringify(data), allowEmpty });
  } catch (err) {
    console.error("[presets] ファイル書き込み失敗:", err);
    try {
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: `プリセットの保存先ファイルに書き込めませんでした。登録済みのデータは一時領域に残っています。アプリを再起動すると再試行します: ${String(err)}`,
        ttlMs: 8000,
      });
    } catch {
      // トースト取得すら失敗した場合はログのみ (これ以上できることはない)。
    }
    // 呼び出し側 (移行・解禁判断) が失敗を検知できるよう再 throw する。
    throw err;
  }
}

/**
 * 保存の最後勝ちキュー。in-flight 中に来た保存要求は「最新 1 件」だけ保持し、
 * 完了後に 1 回だけ書く。複数の書き込みが in-flight になると invoke の到着順
 * 逆転で古いスナップショットが後勝ちし得るのを防ぐ。中間状態の保存はスキップ
 * してよい (常に全量スナップショットなので最終状態が正)。
 */
let pendingWrite: { data: PresetsFileData; allowEmpty: boolean } | null = null;
let writeInFlight: Promise<boolean> | null = null;

/**
 * キュー経由の書き込み。**失敗しても reject しない** (成否は boolean で返す)。
 *
 * writeToFileNow は 2026-08-06 から throw するようになったが、このキューは
 * 「最後勝ち」で複数ジョブを直列処理するため、1 件の失敗で while を抜けると
 * 後続ジョブが落ちる。また mutate 経路 (persistAll) は結果を待たない
 * `void writeToFile(...)` なので、reject させると unhandled rejection になる。
 * したがってここで受け止め、**呼び出し側が知りたい「今回書けたか」だけを返す**。
 */
function writeToFile(data: PresetsFileData, allowEmpty = false): Promise<boolean> {
  pendingWrite = { data, allowEmpty };
  if (!writeInFlight) {
    const run = (async (): Promise<boolean> => {
      let lastOk = true;
      while (pendingWrite) {
        const job = pendingWrite;
        pendingWrite = null;
        try {
          await writeToFileNow(job.data, job.allowEmpty);
          lastOk = true;
        } catch {
          // 通知は writeToFileNow 側で済んでいる。ここでは成否だけ記録し、
          // 後続ジョブの処理は続ける (1 件の失敗で保存経路全体を止めない)。
          lastOk = false;
        }
      }
      // ここは最後の await 再開後の同期区間なので、pendingWrite チェックと
      // フラグ解除の間に別コードは割り込めない (JS シングルスレッド)。
      writeInFlight = null;
      return lastOk;
    })();
    writeInFlight = run;
    // run をそのまま返す。`writeInFlight` は上の async 内で null に戻るため、
    // 戻り値に使うと「完了済みの呼び出しが null を返す」型・実行時両方の穴になる。
    return run;
  }
  return writeInFlight;
}

/**
 * 全 mutate 共通の永続化。ファイル (正本) + localStorage (冗長バックアップ) 併記。
 * allowEmpty: presets 0 件での上書きを許可するか (明示的な全削除時のみ true)。
 */
function persistAll(
  categories: PresetCategory[],
  presets: Preset[],
  allowEmpty = false,
) {
  persist(CATEGORIES_LS_KEY, categories);
  persist(PRESETS_LS_KEY, presets);
  if (!fileWriteUnlocked) {
    // ファイルへ書いてよいと確定する前の mutate（起動直後 or 読み出し失敗中）。
    // ここでファイルへ書くと、localStorage 由来の古い state（別ビルドIDの空配列を
    // 含む）で正本を上書きし得る。localStorage には既に書いたので取りこぼしはない。
    // (2026-07-30 評価者2名の共通指摘: 起動直後の窓で stale 上書きが成立していた)
    pendingBeforeUnlock = true;
    return;
  }
  void writeToFile({ version: 1, categories, presets }, allowEmpty);
}

/**
 * ファイルへ書いてよいと確定したか。
 * true になるのは「正常に読めた」か「ファイルが存在しないと確認できた」ときだけ。
 * **読み出しに失敗した場合は false のまま**で、ファイルへは一切書かない
 * （読めない正本を localStorage 由来の内容で上書きするのが今直している故障モード。
 * Codex 検分 2026-07-30: 「読込失敗後の書込みを許すとデータ消失経路が残る」）。
 */
let fileWriteUnlocked = false;
/**
 * 起動時の読み出しが決着したか（成功・失敗どちらでも true）。
 * 「まだ読み込み中」と「読めなかった」を区別するために持つ。
 * 壊れたファイルのときは decided=true / unlocked=false になり、
 * **その状態でこそ復元が必要**なので復元だけは許可する（Codex検分 2026-07-30）。
 */
let fileReadDecided = false;
/** 解禁前に mutate があったか。解禁時に1回フラッシュして取りこぼしを防ぐ。 */
let pendingBeforeUnlock = false;

/**
 * initialize の呼出番号。保存先変更などで連続呼び出しされたとき、
 * 古い呼び出しの結果（旧 root の内容）で store を上書きしないための世代印。
 */
let initializeToken = 0;

/**
 * 正本ファイルの読み込み異常は、同じセッションでは1回だけ通知する。
 * initialize は保存先変更などでも再実行されるため、呼び出し回数ではなく
 * モジュールの生存期間で重複を防ぐ。
 */
let presetsFileErrorToastShown = false;

async function showPresetsFileErrorToast(reason: string): Promise<void> {
  if (presetsFileErrorToastShown) return;
  presetsFileErrorToastShown = true;
  try {
    const [{ useToasts }, { useWorkspace }] = await Promise.all([
      import("./toasts"),
      import("./workspace"),
    ]);
    useToasts.getState().push({
      kind: "error",
      text: `プリセットの保存ファイルが読み込めません（${reason}）。いま登録・変更した内容はこのファイルには保存されません。設定 → ストレージの「バックアップから復元」で直前の状態に戻せます。`,
      ttlMs: 0,
      action: {
        label: "設定を開く",
        run: () => {
          useWorkspace.getState().requestSettingsTab("storage");
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("gori:open-settings"));
          }
        },
      },
    });
  } catch (err) {
    // トースト取得に失敗しても、正本を上書きしない本来の防御は維持する。
    console.error("[presets] 読み込み異常の通知に失敗:", err);
  }
}

/** Tauri の invoke が無いブラウザ単体プレビューでは読み込み警告を出さない。 */
function hasTauriInvoke(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * ファイル書き込みを解禁し、解禁前の mutate を1回だけ反映する。
 * initialize が「読めた」または「ファイルなし」を確認した経路からのみ呼ぶ。
 */
function unlockFileWrite(next: { categories: PresetCategory[]; presets: Preset[] }) {
  fileWriteUnlocked = true;
  if (!pendingBeforeUnlock) return;
  pendingBeforeUnlock = false;
  void writeToFile({ version: 1, ...next });
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 旧 localStorage["referenceSets.sets"] を「セット」カテゴリの Preset へ移行する。
 * 元キーは migrated_<timestamp> に退避し、ロールバック可能にする。
 */
function migrateLegacyReferenceSets(): Preset[] {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("referenceSets.sets.migrated_")) {
        return [];
      }
    }

    const raw = localStorage.getItem("referenceSets.sets");
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const migrated: Preset[] = parsed
      .filter((rs: any) => rs && typeof rs.id === "string" && typeof rs.prompt === "string")
      .map((rs: any) => ({
        id: rs.id,
        name: rs.name || "無題のセット",
        prompt: rs.prompt || "",
        categoryId: "ref-sets",
        description: rs.description || undefined,
        tags: undefined,
        thumbnail: undefined,
        thumbnailFocus: undefined,
        attachedImages: Array.isArray(rs.references)
          ? rs.references
              .filter((r: any) => r && typeof r.path === "string")
              .map((r: any) => ({
                path: r.path,
                role: typeof r.role === "string" ? r.role : undefined,
              }))
          : undefined,
        favorite: false,
        createdAt: typeof rs.createdAt === "number" ? rs.createdAt : Date.now(),
        updatedAt: typeof rs.updatedAt === "number" ? rs.updatedAt : Date.now(),
      }));

    localStorage.setItem(`referenceSets.sets.migrated_${Date.now()}`, raw);
    localStorage.removeItem("referenceSets.sets");

    return migrated;
  } catch {
    return [];
  }
}

/** localStorage から読んだ Preset 配列に focus マイグレートを適用する。 */
function loadPresets(): Preset[] {
  const raw = readPersisted<Preset[]>(PRESETS_LS_KEY, []);
  return raw.map((p) => {
    const migrated = migrateLegacyFocus(p.thumbnailFocus as unknown);
    if (!migrated) {
      // thumbnailFocus が無い / 認識できない値 → そのまま削除
      const { thumbnailFocus: _drop, ...rest } = p as Preset & { thumbnailFocus?: unknown };
      return rest as Preset;
    }
    return { ...p, thumbnailFocus: migrated };
  });
}

function persist<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function sortPresets(presets: Preset[], key: SortKey): Preset[] {
  const byNameAsc = (a: Preset, b: Preset) => a.name.localeCompare(b.name, "ja");
  return [...presets].sort((a, b) => {
    switch (key) {
      case "updatedAsc":
        return a.updatedAt - b.updatedAt || byNameAsc(a, b);
      case "createdDesc":
        return b.createdAt - a.createdAt || byNameAsc(a, b);
      case "createdAsc":
        return a.createdAt - b.createdAt || byNameAsc(a, b);
      case "nameAsc":
        return byNameAsc(a, b);
      case "nameDesc":
        return byNameAsc(b, a);
      case "tagCountDesc":
        return (b.tags?.length ?? 0) - (a.tags?.length ?? 0) || byNameAsc(a, b);
      case "updatedDesc":
      default:
        return b.updatedAt - a.updatedAt || byNameAsc(a, b);
    }
  });
}

/**
 * 登録キャラクターの既定カテゴリ ID。
 * キャラ登録 (registerCharacter) は必ずここへ入れる。
 */
export const CHARACTER_CATEGORY_ID = "characters";

const DEFAULT_CATEGORIES: PresetCategory[] = [
  // 2026-07-25 STΛCK指示で新設。登録したキャラが「ポートレート」等の
  // 用途カテゴリに混ざると、自分のIPを探せなくなる。キャラは独立した箱にする。
  { id: CHARACTER_CATEGORY_ID, name: "キャラクター", color: "#f472b6" },
  { id: "default-portrait", name: "ポートレート", color: "#ec4899" },
  { id: "default-product", name: "プロダクト", color: "#6366f1" },
  { id: "default-landscape", name: "風景", color: "#10b981" },
  // 旧リファレンスセットの移行先カテゴリ。
  { id: "ref-sets", name: "セット", color: "#f59e0b" },
];

type PresetsState = {
  categories: PresetCategory[];
  presets: Preset[];
  presetsFileState: PresetsFileState;

  addCategory: (name: string, color?: string, tags?: string[]) => PresetCategory;
  updateCategory: (id: string, updates: Partial<Omit<PresetCategory, "id">>) => void;
  removeCategory: (id: string) => void;

  addPreset: (data: Omit<Preset, "id" | "createdAt" | "updatedAt">) => Preset;
  updatePreset: (id: string, updates: Partial<Omit<Preset, "id" | "createdAt">>) => void;
  removePreset: (id: string) => void;

  /** お気に入り toggle。Code Manager と同じ仕様。 */
  toggleFavorite: (id: string) => void;

  /**
   * ライブラリで画像がリネームされたとき、プリセットが握っている画像パスを
   * 一括で新パスへ付け替える (d98)。projects.renameItemPath と同列で
   * images.renameLocal から呼ばれる。
   *
   * 対象は attachedImages[].path / characterMeta.sourceImage /
   * characterMeta.sourceImages[] / characterMeta.sheetRoles のキー。
   * 比較は完全一致 (正規化しない)。
   * 1 件も変化が無ければ set も persist もしない。
   */
  renameImagePath: (oldPath: string, newPath: string) => void;

  /**
   * rr2: relink (画像パス修復) の旧→新マップを一括適用する。
   * renameImagePath と同じ 4 面 (attachedImages[].path / characterMeta.sourceImage /
   * sourceImages[] / sheetRoles キー) を対象に、pathMap の全エントリを 1 回の
   * set + 1 回の persistAll で置き換える。
   *
   * renameImagePath をループ呼びしないのは、persist が pathMap 件数分走って
   * presets.json の世代バックアップを無駄に量産するため。
   * 1 件も変化が無ければ set も persist もしない (no-op)。
   */
  relinkImagePaths: (pathMap: Record<string, string>) => void;

  /** プリセットを並び替え。fromIndex の要素を toIndex の位置に移動。同じカテゴリ内のみ並び替え可能。 */
  reorderPresets: (fromId: string, toId: string) => void;

  /**
   * 起動時に 1 回呼ぶ。presets.json (正本) を読み、無ければ localStorage から
   * 移行する。複数回呼ばれても安全 (最後の結果で上書き)。
   * Tauri が動いていない時 (Vite 単体プレビュー等) は localStorage 由来の
   * 初期値のまま動く。
   */
  initialize: () => Promise<void>;

  /**
   * 世代バックアップの一覧を取得する（新しい順）。
   * 返り値: 成功なら { ok: true, items }、失敗なら { ok: false, error }。
   *
   * **失敗を空配列に畳まない**（2026-08-06）。畳むと、保存先が読めないとき
   * （外付け未接続・権限エラー・クラウド同期の不達）に「まだバックアップが
   * ありません」と表示され、復元がいちばん必要な故障時に原因が消える。
   */
  listBackups: () => Promise<
    BackupListResult<{ path: string; at: number; count: number }>
  >;

  /**
   * 指定バックアップの内容で現在のプリセット・カテゴリを置き換える（復元）。
   * 復元前の現状も presets_write 側で自動バックアップされるので、誤復元しても戻せる。
   * 成功したら復元後のプリセット件数を返す。失敗時は throw。
   */
  restoreFromBackup: (backupPath: string) => Promise<number>;
};

/**
 * 既存ユーザーのカテゴリ一覧に「キャラクター」を足す。
 *
 * カテゴリは localStorage に永続化されるため、DEFAULT_CATEGORIES に追記しても
 * 既存ユーザーには出てこない (保存済みの配列が優先される)。先頭に差し込む。
 * 冪等 (既にあれば何もしない)。
 */
function ensureCharacterCategory(saved: PresetCategory[]): PresetCategory[] {
  if (saved.some((c) => c.id === CHARACTER_CATEGORY_ID)) return saved;
  const characterCategory = DEFAULT_CATEGORIES.find(
    (c) => c.id === CHARACTER_CATEGORY_ID,
  );
  if (!characterCategory) return saved;
  const next = [characterCategory, ...saved];
  // ここは persistAll ではなく localStorage のみ。store 生成時 = initialize() が
  // ファイルを読む**前**に走るため、ここでファイルへ書くと古い localStorage の
  // 内容でファイル正本を上書きするレースになる。ファイルへの反映は initialize()
  // が担う (ファイル有なら ensure 差分だけ書き戻し、ファイル無なら移行で書く)。
  persist(CATEGORIES_LS_KEY, next);
  return next;
}

export const usePresets = create<PresetsState>((set, get) => ({
  categories: ensureCharacterCategory(
    readPersisted<PresetCategory[]>(CATEGORIES_LS_KEY, DEFAULT_CATEGORIES),
  ),
  presets: (() => {
    const existing = loadPresets();
    const migrated = migrateLegacyReferenceSets();
    if (migrated.length === 0) return existing;
    const existingIds = new Set(existing.map((p) => p.id));
    const merged = [...existing, ...migrated.filter((m) => !existingIds.has(m.id))];
    // ensureCharacterCategory と同じ理由で localStorage のみ (initialize() が
    // ファイルを読む前に走るため、ここでファイルを書くとレースになる)。
    persist(PRESETS_LS_KEY, merged);
    return merged;
  })(),
  // 読み込み前は警告しない。initialize が正本の実状態へ更新する。
  presetsFileState: "missing",

  /**
   * 起動時の移行フロー。守るべき不変条件:
   * **「読めなかった」経路では絶対にファイルへ書かない**。書いてよいのは
   * 「ファイルが存在しない」ときと「ファイルを正しく読めた後の変化」だけ。
   */
  initialize: async () => {
    // 「ファイルへ書いてよい」と確定できた経路（正常に読めた / ファイルなしを確認）
    // のときだけ書き込みを解禁する。読み出し失敗時は解禁せず、以後もファイルへは
    // 書かない（読めない正本を localStorage 由来の内容で潰さない）。
    // 解禁前の mutate は localStorage にだけ入っており、解禁時に1回フラッシュされる。
    //
    // 呼出番号: 保存先変更で initialize が続けて走ると、先行呼び出しが旧 root の
    // 内容で store を上書きし得る（後着の新 root 読み込みが先に終わるケース）。
    // 自分より新しい呼び出しが始まっていたら結果を破棄する（Codex検分 2026-07-30）。
    const myToken = ++initializeToken;
    const readable = await readPresetsFileIntoStore(set, get, () => myToken === initializeToken);
    if (myToken !== initializeToken) return; // 後続の initialize が正
    fileReadDecided = true; // 成否によらず「読み込みは終わった」
    if (readable) unlockFileWrite(get());
  },

  listBackups: () =>
    toBackupListResult(async () => {
      const { storage } = await import("../ipc");
      const rows = await storage.listPresetBackups();
      // [path, epochミリ秒, count]。Rust 側がミリ秒で返すのでそのまま使う。
      return rows.map(([path, ms, count]) => ({ path, at: ms, count }));
    }, "presets"),

  restoreFromBackup: async (backupPath) => {
    // 「まだ読み込み中」のときだけ拒否する。persistAll がファイルへ書かずに戻り、
    // 「復元しました」と出るのに正本は変わっていない、という最悪の見え方になるため
    // （評価者指摘 M-3）。
    //
    // 一方「読み出しに失敗した（ファイルが壊れている）」ときは **復元を許可する**。
    // そこを塞ぐと、復元がいちばん必要な場面で復元できないという矛盾になる
    // （Codex検分 2026-07-30「壊れたpresets.json → ユーザー復元不可」）。
    // 壊れた正本を良いバックアップで上書きするのは、まさに意図した操作。
    if (!fileReadDecided) {
      throw new Error("まだ読み込み中です。少し待ってからもう一度お試しください。");
    }
    // 壊れたファイルからの復元では書き込みが未解禁なので、ここで解禁する
    // （ユーザーが明示的に「この内容で上書きする」と決めた操作だから）。
    fileWriteUnlocked = true;
    const { storage } = await import("../ipc");
    const raw = await storage.readPresetBackup(backupPath);
    const parsed = JSON.parse(raw) as Partial<PresetsFileData> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.categories) ||
      !Array.isArray(parsed.presets)
    ) {
      throw new Error("バックアップの形式が不正です");
    }
    const categories = ensureCharacterCategory(parsed.categories as PresetCategory[]);
    const presets = parsed.presets as Preset[];
    // 復元前の現在値。保存に失敗したら画面をここへ戻す (下記)。
    const before = { categories: get().categories, presets: get().presets };
    // 正本ファイルへ書き戻す。復元前の現状も presets_write 側で自動バックアップ
    // される（二重に安全。projects の restoreFromBackup と同じ思想）。
    //
    // **保存完了を待つ** (2026-08-06 / DL-08)。待たずに set すると、画面だけ
    // 復元済みになり「復元しました (N件)」と出るのに正本は変わっていない =
    // 再起動で戻る。復元はユーザーが「これで確定」と決めた操作なので成否を隠さない。
    //
    // localStorage への冗長書き込みは**ファイル書き込みが通ってから**行う。
    // 先に書くと、失敗して画面を戻したのに localStorage だけバックアップの内容が
    // 残り、次回起動の「多い方を勝たせる」判定 (readPresetsFileIntoStore) が
    // 取り消したはずの復元を蘇らせる。
    const ok = await writeToFile({ version: 1, categories, presets });
    if (!ok) {
      set(before);
      throw new Error(
        "バックアップは読めましたが、保存先へ書き込めませんでした。復元は取り消しました。",
      );
    }
    persist(CATEGORIES_LS_KEY, categories);
    persist(PRESETS_LS_KEY, presets);
    set({ categories, presets, presetsFileState: "ok" });
    return presets.length;
  },

  addCategory: (name, color = "#6366f1", tags) => {
    const category: PresetCategory = {
      id: generateId(),
      name: name.trim(),
      color,
      tags: tags && tags.length > 0 ? tags : undefined,
    };
    const next = [...get().categories, category];
    persistAll(next, get().presets);
    set({ categories: next });
    return category;
  },

  updateCategory: (id, updates) => {
    const next = get().categories.map((c) => (c.id === id ? { ...c, ...updates } : c));
    persistAll(next, get().presets);
    set({ categories: next });
  },

  removeCategory: (id) => {
    const nextCategories = get().categories.filter((c) => c.id !== id);
    // 紐づくプリセットは「未分類」へ
    const nextPresets = get().presets.map((p) =>
      p.categoryId === id ? { ...p, categoryId: null, updatedAt: Date.now() } : p,
    );
    // presets が 0 件になる操作ではない (未分類へ付け替え) ので allowEmpty 不要。
    persistAll(nextCategories, nextPresets);
    set({ categories: nextCategories, presets: nextPresets });
  },

  addPreset: (data) => {
    const now = Date.now();
    const preset: Preset = {
      id: generateId(),
      name: data.name.trim(),
      kind: data.kind === "character" ? "character" : undefined,
      characterMeta:
        data.kind === "character" && data.characterMeta
          ? data.characterMeta
          : undefined,
      prompt: data.prompt,
      categoryId: data.categoryId,
      description: data.description?.trim() || undefined,
      tags: data.tags && data.tags.length > 0 ? data.tags : undefined,
      thumbnail: data.thumbnail,
      thumbnailFocus: data.thumbnailFocus,
      // STΛCK 報告 (2026-05-19): F-#7 で Preset 型に attachedImages を追加した
      // が、addPreset 内で参照されておらず localStorage に保存されないバグ。
      // ここで data.attachedImages を引き継ぐことで「プリセットにキャラ画像が
      // 登録されない」問題を根治。
      attachedImages:
        data.attachedImages && data.attachedImages.length > 0
          ? data.attachedImages
          : undefined,
      favorite: data.favorite,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().presets, preset];
    persistAll(get().categories, next);
    set({ presets: next });
    return preset;
  },

  updatePreset: (id, updates) => {
    const next = get().presets.map((p) =>
      p.id === id
        ? {
            ...p,
            ...updates,
            // ID と createdAt は update しないが、念のため上書き防止
            id: p.id,
            createdAt: p.createdAt,
            updatedAt: Date.now(),
          }
        : p,
    );
    persistAll(get().categories, next);
    set({ presets: next });
  },

  removePreset: (id) => {
    const before = get().presets;
    const next = before.filter((p) => p.id !== id);
    // 実際に1件消えたときだけを「削除操作」として扱う。存在しない id を渡された
    // 場合（既に0件の状態での再呼び出し等）に allowEmpty を通すと、空上書きガードを
    // 素通りして正本を空で潰せる（Codex検分 2026-07-30）。
    const removed = next.length < before.length;
    // 本当に最後の1件を消したときだけ allowEmpty で空上書きガードを通す
    // (「消したのに再起動で復活」する退行を防ぐ)。
    persistAll(get().categories, next, removed && next.length === 0);
    set({ presets: next });
  },

  toggleFavorite: (id) => {
    const next = get().presets.map((p) =>
      p.id === id
        ? { ...p, favorite: !p.favorite, updatedAt: Date.now() }
        : p,
    );
    persistAll(get().categories, next);
    set({ presets: next });
  },

  renameImagePath: (oldPath, newPath) => {
    // projects.renameItemPath (projects.ts) と同じガード。
    if (!oldPath || !newPath || oldPath === newPath) return;
    let changed = false;
    const nextPresets = get().presets.map((p) => {
      let presetChanged = false;

      // 1. attachedImages[].path (kind を問わず走査。プロンプト型にも添付画像がある)
      let attachedImages = p.attachedImages;
      if (attachedImages?.some((img) => img.path === oldPath)) {
        attachedImages = attachedImages.map((img) =>
          img.path === oldPath ? { ...img, path: newPath } : img,
        );
        presetChanged = true;
      }

      // 2/3. characterMeta.sourceImage(+ sourceImages) と characterMeta.sheetRoles のキー
      let characterMeta = p.characterMeta;
      if (characterMeta) {
        let metaChanged = false;
        let sourceImage = characterMeta.sourceImage;
        if (sourceImage === oldPath) {
          sourceImage = newPath;
          metaChanged = true;
        }
        // 複数参照 (sourceImages) の各要素も同じ規則で置換する。ここを漏らすと
        // 改名後に「作り直し」で復元される参照だけが古いパスを指す。
        let sourceImages = characterMeta.sourceImages;
        if (sourceImages?.some((path) => path === oldPath)) {
          sourceImages = sourceImages.map((path) =>
            path === oldPath ? newPath : path,
          );
          metaChanged = true;
        }
        let sheetRoles = characterMeta.sheetRoles;
        if (sheetRoles && sheetRoles[oldPath] !== undefined) {
          // 値 (role 文字列) は保持したままキーだけ差し替える。
          const nextRoles: Record<string, string> = {};
          for (const [path, role] of Object.entries(sheetRoles)) {
            nextRoles[path === oldPath ? newPath : path] = role;
          }
          sheetRoles = nextRoles;
          metaChanged = true;
        }
        if (metaChanged) {
          characterMeta = {
            ...characterMeta,
            sourceImage,
            sourceImages,
            sheetRoles,
          };
          presetChanged = true;
        }
      }

      if (!presetChanged) return p;
      changed = true;
      return { ...p, attachedImages, characterMeta };
    });
    if (!changed) return;
    persistAll(get().categories, nextPresets);
    set({ presets: nextPresets });
  },

  relinkImagePaths: (pathMap) => {
    const entries = Object.entries(pathMap).filter(
      ([oldPath, newPath]) => oldPath && newPath && oldPath !== newPath,
    );
    if (entries.length === 0) return;
    const map = new Map(entries);
    /** pathMap に載っていれば新パス、無ければ undefined。 */
    const remap = (path: string | undefined) =>
      path === undefined ? undefined : map.get(path);

    let changed = false;
    const nextPresets = get().presets.map((p) => {
      let presetChanged = false;

      // 1. attachedImages[].path
      let attachedImages = p.attachedImages;
      if (attachedImages?.some((img) => map.has(img.path))) {
        attachedImages = attachedImages.map((img) => {
          const next = remap(img.path);
          return next === undefined ? img : { ...img, path: next };
        });
        presetChanged = true;
      }

      // 2/3. characterMeta.sourceImage(+ sourceImages) と sheetRoles のキー
      let characterMeta = p.characterMeta;
      if (characterMeta) {
        let metaChanged = false;
        let sourceImage = characterMeta.sourceImage;
        const nextSourceImage = remap(sourceImage);
        if (nextSourceImage !== undefined) {
          sourceImage = nextSourceImage;
          metaChanged = true;
        }
        let sourceImages = characterMeta.sourceImages;
        if (sourceImages?.some((path) => map.has(path))) {
          sourceImages = sourceImages.map((path) => remap(path) ?? path);
          metaChanged = true;
        }
        let sheetRoles = characterMeta.sheetRoles;
        if (sheetRoles && Object.keys(sheetRoles).some((k) => map.has(k))) {
          // 値 (role 文字列) は保持したままキーだけ差し替える。
          const nextRoles: Record<string, string> = {};
          for (const [path, role] of Object.entries(sheetRoles)) {
            nextRoles[remap(path) ?? path] = role;
          }
          sheetRoles = nextRoles;
          metaChanged = true;
        }
        if (metaChanged) {
          characterMeta = {
            ...characterMeta,
            sourceImage,
            sourceImages,
            sheetRoles,
          };
          presetChanged = true;
        }
      }

      if (!presetChanged) return p;
      changed = true;
      return { ...p, attachedImages, characterMeta };
    });
    if (!changed) return;
    persistAll(get().categories, nextPresets);
    set({ presets: nextPresets });
  },

  reorderPresets: (fromId, toId) => {
    if (fromId === toId) return;
    const current = get().presets;
    const fromIdx = current.findIndex((p) => p.id === fromId);
    const toIdx = current.findIndex((p) => p.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...current];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    persistAll(get().categories, next);
    set({ presets: next });
  },
}));

/**
 * presets.json を読んで store へ反映する（initialize の読み出し本体）。
 * 呼び出し側が try/finally で決着を記録するため、ここは早期 return してよい。
 * 守るべき不変条件: **「読めなかった」経路では絶対にファイルへ書かない**。
 */
async function readPresetsFileIntoStore(
  set: (partial: Partial<PresetsState>) => void,
  get: () => PresetsState,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!hasTauriInvoke()) {
    // Tauri 外 (Vite 単体プレビュー等)。localStorage 由来の state のまま動く。
    return false;
  }

  let content: string;
  try {
    content = await invoke<string>("presets_read");
  } catch (err) {
    console.error("[presets] ファイル読み出し失敗:", err);
    if (isCurrent()) {
      set({ presetsFileState: "unreadable" });
      void showPresetsFileErrorToast("ファイルを開けません");
    }
    return false; // 解禁しない（読めない正本を localStorage で潰さない）
  }

  if (content.trim().length > 0) {
    // ファイル有 = 正本。壊れていた場合は localStorage 由来の初期値を維持し、
    // ファイルへは何も書かない (壊れた正本を上書きしない。人が読めば復元でき、
    // 直前世代の presets.json.bak-* も残っている)。
    let file: unknown;
    try {
      file = JSON.parse(content);
    } catch (err) {
      console.error("[presets] presets.json のパースに失敗 (localStorage を継続使用):", err);
      if (isCurrent()) {
        set({ presetsFileState: "corrupted" });
        void showPresetsFileErrorToast("内容が壊れています");
      }
      return false; // 壊れた正本を上書きしない
    }
    const parsed = file as Partial<PresetsFileData> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.categories) ||
      !Array.isArray(parsed.presets)
    ) {
      console.error("[presets] presets.json の形が不正 (localStorage を継続使用)");
      if (isCurrent()) {
        set({ presetsFileState: "corrupted" });
        void showPresetsFileErrorToast("形式が正しくありません");
      }
      return false; // 壊れた正本を上書きしない
    }

    const savedCategories = parsed.categories as PresetCategory[];
    const categories = ensureCharacterCategory(savedCategories);
    // loadPresets と同じ focus マイグレートを通す。
    const presets = (parsed.presets as Preset[]).map((p) => {
      const migrated = migrateLegacyFocus(p.thumbnailFocus as unknown);
      if (!migrated) {
        const { thumbnailFocus: _drop, ...rest } = p as Preset & {
          thumbnailFocus?: unknown;
        };
        return rest as Preset;
      }
      return { ...p, thumbnailFocus: migrated };
    });
    // 自分が最新の呼び出しでなければ store を触らない（旧 root の内容で上書きしない）。
    if (!isCurrent()) return false;
    set({ presetsFileState: "ok" });

    // **2026-08-06 重大修正 (実ユーザーのプリセット30体消失)**: ここは以前、
    // ファイルが JSON として読めさえすれば **0 件でも無条件に正本として採用**し、
    // localStorage の冗長バックアップをその 0 件で巻き戻していた。
    // 初回移行の書き込み失敗 + 掃除による localStorage 削除が重なったとき、
    // 「30 件あるバックアップ」を「0 件のファイル」で潰す最後の一押しになった。
    //
    // ファイルが localStorage より明らかに少ないときは、**多い方を採用**して
    // ファイルへ書き戻す。判定は件数だけで足りる: プリセットは追加が主で、
    // 半減以下の減少は正当な操作としてほぼ起きない。タイムスタンプ比較は
    // 時計ずれ・保存漏れで誤判定する要素が増えるだけなので採らない。
    const backupPresets = loadPresets();
    if (backupPresets.length > presets.length) {
      console.warn(
        "[presets] ファイル",
        presets.length,
        "件よりバックアップ",
        backupPresets.length,
        "件の方が多いため、バックアップを正として復元します",
      );
      const backupCategories = ensureCharacterCategory(
        readPersisted<PresetCategory[]>(CATEGORIES_LS_KEY, DEFAULT_CATEGORIES),
      );
      set({ categories: backupCategories, presets: backupPresets });
      // 復元内容をファイルへ書き戻す。少ない件数を多い件数で上書きする方向なので
      // Rust 側の激減ガード (S4) には当たらない。
      void writeToFile({
        version: 1,
        categories: backupCategories,
        presets: backupPresets,
      });
      void (async () => {
        try {
          const { useToasts } = await import("./toasts");
          useToasts.getState().push({
            kind: "info",
            text: `プリセットをバックアップから復元しました (${backupPresets.length} 件)。`,
            ttlMs: 8000,
          });
        } catch {
          /* トースト表示に失敗しても復元自体は成功しているので握り潰す */
        }
      })();
      return true; // 復元できた = 以後ファイルへ書いてよい
    }

    // 読み込みを待つ間にユーザーが編集していた場合、ファイルの内容で上書きしない。
    // 上書きすると「起動直後に足したキャラが消える」「前回ディスク満杯で保存できず
    // localStorage にだけ残っていた最新が、古いファイルに潰される」が実際に起きる
    // （2026-07-30 Codex 検分のシナリオ表）。この場合は画面にある内容（＝ユーザーの
    // 認識と一致する側）を正として、ファイルへ書き戻す。
    if (pendingBeforeUnlock) {
      console.info("[presets] 読み込み中に編集があったため、画面の内容を正として保持します");
      return true; // 解禁だけする。unlockFileWrite が保留分をフラッシュする
    }

    set({ categories, presets });
    // localStorage の冗長バックアップを最新化する。
    persist(CATEGORIES_LS_KEY, categories);
    persist(PRESETS_LS_KEY, presets);
    // ensureCharacterCategory が配列を変えたときだけファイルへ書き戻す
    // (無変化時は書かない = 起動ごとの無用な書き込みとバックアップ世代の消費を避ける)。
    if (categories !== savedCategories) {
      void writeToFile({ version: 1, categories, presets });
    }
    return true; // 正常に読めた = 以後ファイルへ書いてよい
  }

  // ファイル未作成 = localStorage からの移行 or 新規ユーザー。
  // 現在の in-memory state (localStorage 由来 + legacy 移行済み) を正とする。
  if (isCurrent()) set({ presetsFileState: "missing" });
  const { categories, presets } = get();
  const categoriesAreDefault =
    categories.length === DEFAULT_CATEGORIES.length &&
    categories.every((c, i) => c.id === DEFAULT_CATEGORIES[i].id);
  if (presets.length > 0 || !categoriesAreDefault) {
    console.info(
      "[presets] localStorage から",
      presets.length,
      "件のプリセットをファイルへ移行",
    );
    const ok = await writeToFile({ version: 1, categories, presets });
    if (!ok) {
      // **2026-08-06 重大修正 (実ユーザーのプリセット30体消失)**: ここで移行が
      // 失敗しても成功扱いで解禁していた。解禁されると以後の mutate がファイルへ
      // 流れる前提になり、localStorage 側だけが唯一の実体である事実が見えなくなる。
      // 失敗したら**解禁しない**。localStorage を正のまま次回起動で再試行する
      // (掃除側の S1 修正と二重防御: localStorage はもう消されない)。
      console.error("[presets] ファイルへの移行に失敗。localStorage を正のまま維持する");
      return false;
    }
    // 移行に成功した直後に1世代バックアップを取る (2026-08-06)。
    // 従来は「ファイルが既にある + 2回目以降の保存」でしか .bak が作られず、
    // 移行したきり保存していないユーザーは**バックアップ0件**のままだった
    // (「バックアップがありません」の正体)。ここで最初の1世代を確保する。
    // 失敗しても移行自体は成功なので握り潰す (付帯機能で本流を止めない)。
    void ensureDailyBackupsSafe();
  }
  // 両方とも初期値のままなら何も書かない (空ファイルを作らない)。
  return true; // ファイル未作成を確認できた = 以後ファイルへ書いてよい
}
