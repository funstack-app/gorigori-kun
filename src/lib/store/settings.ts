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
 * | (3) JSON ファイル (Rust) | `storage-settings.json` / `projects.json` | projects.json のみ `projectsDataRoot` で移行可 |
 *
 * ### (1) plugin-store
 * - `settings.json` (このファイル): codexBinaryPath / defaultModel / defaultEffort /
 *   defaultCwd / approvalPolicy / sandbox / worldContext
 * - `lib/store/images.ts`: お気に入り (favorites) / 採否判定 (judgements)
 * - `lib/store/savedPrompts.ts`: 保存済みプロンプト
 *
 * ### (2) localStorage (キー名 → 用途)
 * - `gori.fontScale.v1` — 文字サイズ倍率 (初回ペイント前に同期で要るため。理由は fontScale.ts 参照)
 * - `presets.presets` / `presets.categories` — プリセットとカテゴリ
 * - `activeProject.id` — 選択中プロジェクト
 * - `composer.aspect` / `composer.count` — 生成フォームの前回値
 * - `higgsfield.selectedModels` / `magnific.selectedModels` — 外部サービスの選択モデル
 * - `codex.plan.v1` — Codex プラン種別
 * - `referenceRoles.byPath` — 参照画像のロール割り当て
 * - `library.viewMode` / `library.tileSize` / `workspace.timelineSize` — 表示設定 (UI 状態)
 * - `scene3d.*` — 3D ワークスペースのレイアウト・プロジェクト・生成モーション
 * - `gori.gauge.durations.v1` — 進捗ゲージの学習済み所要時間
 * - `gori_gori_kun.first_run_storage_notice_v1` — 初回案内の既読
 * - `projects.projects` (+ `.backup`) — **旧**プロジェクト保存先。v0.6.9 で (3) へ移行済み。
 *   起動時マイグレーション用に読むだけ (新規書き込みはしない)
 *
 * ### (3) JSON ファイル (Rust 側 / commands/storage.rs)
 * - `storage-settings.json` — 画像の保存先 (storageRoot) / プロジェクトサブフォルダ /
 *   projectsDataRoot / Supabase 連携。**アプリデータディレクトリ固定** (自己参照になるため移行不可)
 * - `projects.json` — プロジェクト本体。`projectsDataRoot` で保存先を変更できる (世代バックアップ付き)
 *
 * ### 注意 (矛盾として記録)
 * UI 状態 (レイアウト・タイルサイズ) が localStorage にあるのは妥当だが、
 * プリセット・参照ロールのような**作品資産に近いデータも localStorage にある**。
 * これらは保存先を移行しても付いてこないし、WebView のデータを消すと失われる。
 * (3) へ寄せるのが筋だが、データ移行を伴うのでリリース当日には触らない。
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
