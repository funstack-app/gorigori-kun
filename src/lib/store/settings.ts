import { create } from "zustand";
import type { Store } from "@tauri-apps/plugin-store";

/**
 * ## 設定の永続化先マップ (SET-04 / 2026-07-25 現況の記録)
 *
 * 設定の保存先が3系統に分かれている。**どれが何系統かを見失うと
 * 「保存先を移行したのに設定が付いてこない」の原因が追えない**ので、
 * 現況をここに1箇所だけ記録する。実装の統合は移行を伴うため別作業。
 *
 * | 系統 | 実体 | 保存先が移行したら付いてくるか |
 * |---|---|---|
 * | (1) Tauri plugin-store | `settings.json` / `images` 系 (アプリデータディレクトリ配下) | **付いてこない** (OS 標準のアプリデータ固定) |
 * | (2) localStorage | WebView のローカルストレージ | **付いてこない** (WebView ごと。dev版↔配布版でも別) |
 * | (3) JSON ファイル (Rust) | `storage-settings.json` / `projects.json` / `presets.json` / `scene3d.json` / `motions.json` | `storage-settings.json` 以外の4ファイルが `projectsDataRoot` で移行可 (自己参照になる storage-settings.json だけアプリデータ固定) |
 *
 * ### (1) plugin-store
 * - `settings.json` (このファイル): codexBinaryPath / defaultModel / defaultEffort /
 *   defaultCwd / approvalPolicy / sandbox / worldContext
 * - `lib/store/images.ts`: お気に入り (favorites) / 採否判定 (judgements)
 * - `lib/store/savedPrompts.ts`: 保存済みプロンプト
 * - `world-contexts.json` (`lib/store/worldContexts.ts`): 世界観 / コンテキストの複数保持
 * - `reference-roles.json` (`lib/store/referenceRoles.ts`): 参照画像のロール割り当て。
 *   localStorage は冗長バックアップとして併用 (2026-08-03 r9c で移行)
 *
 * ### (2) localStorage (キー名 → 用途)
 * - `gori.fontScale.v1` — 文字サイズ倍率 (初回ペイント前に同期で要るため。理由は fontScale.ts 参照)
 * - `presets.presets` / `presets.categories` — プリセットとカテゴリの**冗長バックアップ**。
 *   正本は (3) の `presets.json` (2026-07-30 移行)
 * - `activeProject.id` — 選択中プロジェクト
 * - `composer.aspect` / `composer.count` — 生成フォームの前回値
 * - `higgsfield.selectedModels` / `magnific.selectedModels` — 外部サービスの選択モデル
 * - `codex.plan.v1` — Codex プラン種別
 * - `referenceRoles.byPath` — 参照ロールの**冗長バックアップ**。正本は (1) の
 *   `reference-roles.json` (2026-08-03 r9c)
 * - `library.viewMode` / `library.tileSize` / `workspace.timelineSize` /
 *   `workspace.storyboardCardSize` — 表示設定 (UI 状態)
 * - `gori.generationStatusPanel.pos` — 生成状況パネルの表示位置 (UI 状態)
 * - `gori:refine-format:image` / `gori:refine-format:video` — 「AIで整える」の
 *   出力形式 (JSON / YAML)。画像・動画で独立 (UI 状態)
 * - `gori.higgsfield.models.<media>` — Higgsfield モデル一覧のキャッシュ
 *   (再取得可能。UI 状態)
 * - `scene3d.panel.*` / `scene3d.paneLayout.v1` / `scene3d.timeline.*` — 3D ワークスペースの
 *   レイアウト (UI 状態)
 * - `scene3d.project.v3` / `scene3d.generatedMotions.v1` — 3Dシーン / 生成モーションの
 *   **冗長バックアップ**。正本は (3) の `scene3d.json` / `motions.json`
 * - `gori.gauge.durations.v1` — 進捗ゲージの学習済み所要時間
 * - `gori_gori_kun.first_run_storage_notice_v1` — 初回案内の既読
 * - `projects.projects` (+ `.backup`) — プロジェクトの**冗長バックアップ**。正本は
 *   v0.6.9 で (3) の `projects.json` へ移行済みだが、緊急時の救出経路として
 *   現在も保存のたびに書き続けている (`store/projects.ts` の `persist`。
 *   `.backup` の方は空配列では上書きしない)。起動時マイグレーションの読み出し元も兼ねる
 * - `referenceSets.sets.migrated_<epoch>` — 参照セット移行時の退避データ (残骸)。
 *   移行元を消さずに残す安全策。増殖条件は未検証・実害未観測のため掃除は保留
 *
 * ### (3) JSON ファイル (Rust 側 / commands/storage.rs)
 * - `storage-settings.json` — 画像の保存先 (storageRoot) / プロジェクトサブフォルダ /
 *   projectsDataRoot / Supabase 連携。**アプリデータディレクトリ固定** (自己参照になるため移行不可)
 * - `projects.json` — プロジェクト本体。`projectsDataRoot` で保存先を変更できる (世代バックアップ付き)
 * - `presets.json` — プリセット / 登録キャラ (2026-07-30 に localStorage から移行)
 * - `scene3d.json` — 3D シーン (2026-07-30 に移行)
 * - `motions.json` — 3D モーション仕様 (AI生成 / 動画取り込み。2026-08-03 gj7 で移行)。
 *   参照元の `scene3d.json` と同じ保存先・同じ移行経路に置き、シーンとモーションの
 *   生死を一致させる
 *
 * ### 保存先を変えたとき、何が移って何が移らないか (2026-08-03 l99 で確定)
 *
 * | データ | 保存先変更時の扱い |
 * |---|---|
 * | 画像実体 | **移動しない**。旧 root を `previousStorageRoots` (無上限) に積み、watcher / relink / 索引が読み続ける |
 * | `history.db` | `app_data_dir` 固定。そもそも storageRoot 配下に無いので「取り残される」は誤認。パス文字列の張り替えは relink が担う |
 * | plugin-store 6ファイル | アプリデータ固定 (Tauri 標準)。同上。パスキー (お気に入り / 採否 / 参照ロール) の張り替えも relink が担う |
 * | `storage-settings.json` | アプリデータ固定。自己参照になるため移行不可 |
 * | `projects.json` / `presets.json` / `scene3d.json` / `motions.json` | `projectsDataRoot` 変更時に「件数の多い方を勝たせる + バックアップ + 非破壊」で移行する |
 * | `*.json.bak-<epoch>` 世代バックアップ | 上記4ファイルの移行に合わせて best-effort でコピーする (2026-08-03 l99 4-3) |
 *
 * 「設定・台帳はアプリデータ、作品は storageRoot」が境界。台帳側を storageRoot 配下へ
 * 移すと、保存先がクラウド同期フォルダのときに DB / 設定が同期競合で壊れるため移さない。
 *
 * ### 仕分け完了 (2026-08-03 ddt)
 * 資産側 (消えると作り直せないデータ) の移行は完了した。プリセット / 3Dシーン /
 * モーションは (3) のファイル正本へ、パスキーの作品メタ (お気に入り / 採否 /
 * 参照ロール) と世界観・保存済みプロンプトは (1) plugin-store へ寄せ終えている。
 * localStorage に残っているものは**冗長バックアップか UI 状態**であり、消えても
 * 実害は「再設定 1 操作」または「再学習」に収まる。よって localStorage のままが正。
 *
 * この境界を維持する理由:
 * - `gori.fontScale.v1` は初回ペイント前の**同期読み**が必須で、非同期の
 *   plugin-store には構造的に移せない (fontScale.ts 参照)
 * - 冗長バックアップ (`scene3d.project.v3` / `referenceRoles.byPath` /
 *   `presets.presets` 等) は、正本ファイルが読めない環境 (Tauri 外プレビュー /
 *   ファイル破損時) の最後の砦として意図的に残している
 * - 残る制約: (1) は**アプリデータディレクトリ固定**で、保存先 (projectsDataRoot) を
 *   移行しても付いてこない。再指定コストが小さいデータに限っているため許容している
 *
 * localStorage に**新しいキーを足すとき**は、そのデータが消えてユーザーが作り直せるかを
 * 先に判定する。作り直せないなら (1) か (3) へ置き、この台帳へ追記する。
 */

const STORE_FILE = "settings.json";
const STORE_KEY = "config";

export type AppSettings = {
  codexBinaryPath?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultCwd?: string;
  approvalPolicy?: "never" | "on-request" | "everything";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * FB#16: 作品の世界観・コンテキスト (Markdown 等の自由文)。
   * 企画チャット (PlanWorkspace) の初回ターンでシステムプロンプトに注入され、
   * AI が作品設定を踏まえた状態で対話を始められる。空欄なら注入しない。
   *
   * 2026-08: world-contexts.json へ移行済みのレガシー。読み取り (初回移行の種) 専用。
   * 新規書き込み禁止。
   */
  worldContext?: string;
};

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
};

let storeHandle: Store | null = null;

async function getStore(): Promise<Store | null> {
  if (storeHandle) return storeHandle;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    storeHandle = await loadStore(STORE_FILE, { defaults: {}, autoSave: true });
    return storeHandle;
  } catch (err) {
    console.warn("settings store unavailable", err);
    return null;
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const store = await getStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const data = (await store.get<AppSettings>(STORE_KEY)) ?? {};
      set({ settings: data, loaded: true });
    } catch (err) {
      console.warn("settings load failed", err);
      set({ loaded: true });
    }
  },
  save: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    const store = await getStore();
    if (!store) return;
    try {
      await store.set(STORE_KEY, next);
      await store.save();
    } catch (err) {
      console.warn("settings save failed", err);
    }
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.settings = useSettings;
}
