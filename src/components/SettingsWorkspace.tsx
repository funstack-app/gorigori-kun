import { useEffect, useState } from "react";
import {
  higgsfieldMcp,
  type LegacySummary,
  magnific,
  type StorageSettings,
  storage,
} from "../lib/ipc";
import { type CodexPlan, useAccounts } from "../lib/store/accounts";
import { useProjects } from "../lib/store/projects";
import { useSettings } from "../lib/store/settings";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
// SettingsCloudSection は v0.6.13 でα版非表示。β以降で復活予定。
// import { SettingsCloudSection } from "./SettingsCloudSection";
import { SettingsConnections } from "./SettingsConnections";
import { StorageManagementSection } from "./StorageManagementSection";
import { UpdateChecker } from "./UpdateChecker";
import { FONT_SCALE_OPTIONS, useFontScale } from "../lib/store/fontScale";

type Tab = "basic" | "storage" | "accounts" | "connections";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "basic", label: "基本" },
  { id: "storage", label: "保存先" },
  { id: "accounts", label: "アカウント" },
  { id: "connections", label: "接続先 (拡張機能)" },
];
const PLAN_LABELS: Record<CodexPlan, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
};
const PRIMARY_BUTTON = "rounded-md bg-pink-500 font-bold text-white hover:bg-pink-600";
const MUTED_BUTTON =
  "rounded-md border border-[#343434] bg-[#1e1e1e] font-bold text-neutral-300 hover:border-[#555] hover:text-white";
export function SettingsWorkspace() {
  const [tab, setTab] = useState<Tab>("basic");
  const accounts = useAccounts();
  useEffect(() => {
    void accounts.refresh();
  }, []);
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav className="w-48 shrink-0 border-r border-[#242424] bg-[#151515] p-3">
          <div className="space-y-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`h-9 w-full rounded-lg px-3 text-left text-xs font-bold ${
                  tab === item.id
                    ? "bg-[#303030] text-white"
                    : "text-neutral-400 hover:bg-[#242424] hover:text-white"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <div className="space-y-6">
              <BasicSettings />
              <WorldContextSettings />
              <UpdateChecker />
            </div>
          )}
          {tab === "storage" && (
            <div className="space-y-6">
              {/*
                v0.6.13 STΛCK 指示:
                クラウドストレージ連携 (Supabase) はβ以降で公開予定。
                α版では RLS 403 エラーで「接続テストに失敗」が出るため、
                混乱回避のため SettingsCloudSection を非表示にする。
                ローカル保存先のみ表示する。
              */}
              <StorageSettingsTab />
            </div>
          )}
          {tab === "accounts" && <AccountSettings />}
          {tab === "connections" && <SettingsConnections />}
        </div>
      </div>
    </section>
  );
}
function BasicSettings() {
  const { settings, save, load, loaded } = useSettings();
  const { models, selectedModel, setSelectedModel, setSelectedEffort, setCwd } = useThreads();
  const push = useToasts((s) => s.push);
  // 文字サイズは localStorage 即時反映なので、settings の保存フローとは独立させる
  // (保存ボタンを押さなくても押した瞬間に効く)。
  const fontScale = useFontScale((s) => s.scale);
  const setFontScale = useFontScale((s) => s.setScale);
  const [draft, setDraft] = useState(settings);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => setDraft(settings), [settings]);
  const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  const pickFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({ directory: true, multiple: false });
      if (typeof r === "string") update("defaultCwd", r);
    } catch (err) {
      push({ kind: "error", text: `フォルダ選択に失敗しました: ${String(err)}` });
    }
  };
  const onSave = async () => {
    await save(draft);
    if (draft.defaultModel && draft.defaultModel !== selectedModel)
      setSelectedModel(draft.defaultModel);
    if (draft.defaultEffort) setSelectedEffort(draft.defaultEffort);
    if (draft.defaultCwd) setCwd(draft.defaultCwd);
    push({ kind: "success", text: "基本設定を保存しました", ttlMs: 2400 });
  };
  return (
    <Panel title="基本">
      {/*
        文字サイズ (STΛCK指示 2026-07-25)。
        画面サイズは人によって違うので、自動調整の上にユーザーの好みを掛ける。
        rem 基準への倍率なので余白・ボタン高さも一緒に拡縮し、崩れない。
        押した瞬間に反映される (保存ボタン不要) ため、見ながら選べる。
      */}
      <Field label="文字サイズ">
        <div className="flex gap-1.5">
          {FONT_SCALE_OPTIONS.map((option) => {
            const isActive = Math.abs(fontScale - option.value) < 0.001;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setFontScale(option.value)}
                title={option.hint}
                aria-pressed={isActive}
                className={`flex h-9 flex-1 flex-col items-center justify-center rounded-md border transition ${
                  isActive
                    ? "border-pink-500 bg-pink-500/15 text-pink-100"
                    : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-neutral-500 hover:text-neutral-100"
                }`}
              >
                <span className="text-[12px] font-black leading-none">{option.label}</span>
                <span className="mt-0.5 text-[9px] leading-none opacity-70">
                  {Math.round(option.value * 100)}%
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
          画面の大きさに応じた自動調整に、この倍率を掛けます。押すとすぐ反映されます。
          小さい画面で「特大」にすると、ボタンが収まらない場合があります。
        </p>
      </Field>
      <Field label="Codex 本体のパス (空欄で自動検出)">
        <TextInput
          value={draft.codexBinaryPath ?? ""}
          onChange={(v) => update("codexBinaryPath", v || undefined)}
          placeholder="/opt/homebrew/bin/codex"
          mono
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="既定モデル">
          <select
            value={draft.defaultModel ?? selectedModel ?? ""}
            onChange={(e) => update("defaultModel", e.target.value || undefined)}
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100"
          >
            <option value="">(自動)</option>
            {models.map((model) => (
              <option key={model.id} value={model.model ?? model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="既定 思考レベル">
          <select
            value={draft.defaultEffort ?? ""}
            onChange={(e) => update("defaultEffort", e.target.value || undefined)}
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100"
          >
            <option value="">(モデル既定)</option>
            <option value="low">低 (速い)</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="xhigh">最高</option>
          </select>
        </Field>
      </div>
      <Field label="作業フォルダ (cwd)">
        <div className="flex gap-2">
          <TextInput
            value={draft.defaultCwd ?? ""}
            onChange={(v) => update("defaultCwd", v || undefined)}
            placeholder="~/Documents/codex-frame-factory/default"
            mono
          />
          <button type="button" onClick={pickFolder} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
            選ぶ
          </button>
        </div>
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="承認ポリシー">
          <select
            value={draft.approvalPolicy ?? "never"}
            onChange={(e) =>
              update("approvalPolicy", e.target.value as typeof draft.approvalPolicy)
            }
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100"
          >
            <option value="never">承認しない</option>
            <option value="on-request">必要な時だけ確認</option>
            <option value="everything">毎回確認</option>
          </select>
        </Field>
        <Field label="サンドボックス">
          <select
            value={draft.sandbox ?? "workspace-write"}
            onChange={(e) => update("sandbox", e.target.value as typeof draft.sandbox)}
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100"
          >
            <option value="read-only">読み取り専用</option>
            <option value="workspace-write">作業フォルダのみ書き込み</option>
            <option value="danger-full-access">全アクセス</option>
          </select>
        </Field>
      </div>
      <button
        type="button"
        onClick={() => void onSave()}
        className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}
      >
        保存
      </button>
    </Panel>
  );
}

/**
 * FB#16: 作品の世界観 / コンテキスト登録欄。
 *
 * ここに登録した自由文 (Markdown 等) は、企画タブ (PlanWorkspace) の
 * 初回ターンでシステムプロンプトに注入される。AI が作品設定を前提に
 * 対話を始められるようにするのが狙い。
 *
 * - 直接テキスト入力 / .md などのテキストファイル読み込みの両方に対応。
 * - 保存しないと反映されないので、明示的な「保存」ボタンを置く。
 */
function WorldContextSettings() {
  const { settings, save, load, loaded } = useSettings();
  const push = useToasts((s) => s.push);
  const [draft, setDraft] = useState(settings.worldContext ?? "");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => setDraft(settings.worldContext ?? ""), [settings.worldContext]);

  const dirty = draft !== (settings.worldContext ?? "");

  const importFile = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({
        directory: false,
        multiple: false,
        filters: [{ name: "テキスト / Markdown", extensions: ["md", "markdown", "txt"] }],
      });
      if (typeof picked !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const content = await readTextFile(picked);
      setDraft(content);
      push({
        kind: "success",
        text: "ファイルを読み込みました。保存で反映されます。",
        ttlMs: 2800,
      });
    } catch (err) {
      push({ kind: "error", text: `ファイルの読み込みに失敗しました: ${String(err)}` });
    }
  };

  const onSave = async () => {
    const value = draft.trim();
    await save({ worldContext: value || undefined });
    push({
      kind: "success",
      text: value ? "世界観 / コンテキストを保存しました" : "世界観 / コンテキストをクリアしました",
      ttlMs: 2400,
    });
  };

  return (
    <Panel title="世界観 / コンテキスト">
      <p className="text-xs leading-relaxed text-neutral-400">
        作品の世界観・キャラ設定・トーンなどをここに書いておくと、企画タブの AI
        がこの設定を踏まえて会話を始めます。Markdown / テキストファイルの読み込みも可能です。
      </p>
      <Field label="作品の世界観・コンテキスト (Markdown 可)">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={10}
          placeholder={
            "# 世界観\n- 舞台: ...\n- 主人公: ...\n- トーン: ...\n\n企画チャットがこの設定を踏まえて提案します。"
          }
          className="min-h-[180px] w-full resize-y rounded-md border border-[#343434] bg-[#101010] px-3 py-2 font-mono text-xs leading-relaxed text-neutral-100 outline-none focus:border-pink-500"
        />
      </Field>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onSave()}
          className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}
        >
          {dirty ? "保存" : "保存済み"}
        </button>
        <button
          type="button"
          onClick={() => void importFile()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
        >
          ファイルから読み込む
        </button>
        {draft.length > 0 && (
          <button
            type="button"
            onClick={() => setDraft("")}
            className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
            title="入力欄を空にする（保存するとクリアされます）"
          >
            クリア
          </button>
        )}
      </div>
    </Panel>
  );
}

// 生成画像のローカル保存先設定タブ。
// デフォルトは ~/Pictures/GORI GORI/。
// 既存の ~/.codex/generated_images/ から新保存先へのマイグレーション機能つき。
function StorageSettingsTab() {
  const push = useToasts((s) => s.push);
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [legacy, setLegacy] = useState<LegacySummary | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [saving, setSaving] = useState(false);
  // バックアップから復元 UI 用。
  const [backups, setBackups] = useState<
    { path: string; at: number; count: number }[]
  >([]);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // 初回マウント時に現在の設定 / レガシー画像 / ホームディレクトリを取得。
  // home は Rust から正しい絶対パスを取得（パス逆算によるバグを避けるため）。
  useEffect(() => {
    void (async () => {
      try {
        const [s, l, h] = await Promise.all([
          storage.getSettings(),
          storage.legacySummary(),
          storage.homeDir(),
        ]);
        setSettings(s);
        setLegacy(l);
        setHome(h);
      } catch (err) {
        push({ kind: "error", text: `保存先設定の読み込みに失敗: ${String(err)}` });
      }
    })();
  }, [push]);

  if (!settings || !home) {
    return (
      <Panel title="ローカル保存先">
        <p className="text-xs text-neutral-500">読み込み中…</p>
      </Panel>
    );
  }

  // 推奨パスのプリセット。home は必ず Rust 側で解決した絶対パスを使う。
  // 旧版では現在の storageRoot から逆算していたが、カスタムパス設定時に
  // 「テスト用」のような任意ディレクトリを home と誤認するバグがあった。
  const presets: Array<{ label: string; path: string; hint: string }> = [
    {
      label: "Pictures（推奨、Finderで見える）",
      path: `${home}/Pictures/GORI GORI`,
      hint: "Mac標準の写真フォルダ",
    },
    { label: "Documents", path: `${home}/Documents/GORI GORI`, hint: "書類フォルダ" },
    { label: "Desktop", path: `${home}/Desktop/GORI GORI`, hint: "デスクトップ" },
    {
      label: "iCloud Drive",
      path: `${home}/Library/Mobile Documents/com~apple~CloudDocs/GORI GORI`,
      hint: "iCloud で自動同期",
    },
  ];

  // 表示用にパスを短縮する。/Users/{username}/ → ~/ に置換。
  // /Volumes/ や ~/Library/Mobile Documents/com~apple~CloudDocs/ は特殊扱い。
  const shortenPath = (path: string): string => {
    let s = path;
    // ホームディレクトリの ~/ 短縮（Rust から取得した home を使用）
    if (s.startsWith(home)) {
      s = "~" + s.slice(home.length);
    }
    // iCloud Drive の冗長なパスを iCloud Drive に置換
    s = s.replace(/~\/Library\/Mobile Documents\/com~apple~CloudDocs/, "~/iCloud Drive");
    return s;
  };

  const pickFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({ directory: true, multiple: false });
      if (typeof r === "string") void applyUnifiedRoot(r);
    } catch (err) {
      push({ kind: "error", text: `フォルダ選択に失敗: ${String(err)}` });
    }
  };

  // 2026-06-06 STΛCK 指示: 保存先を1つ選んだら、画像 (storageRoot) も
  // プロジェクトデータ (projectsDataRoot) も両方そこへ集約する。
  // 「自分の好きな場所 (外付けSSD/Google Drive) に全部入れたい」を叶える。
  // 既存ユーザーが別々に設定していた場合も壊さない (両方を同じ root に揃えるだけ)。
  const applyUnifiedRoot = async (root: string) => {
    setSaving(true);
    try {
      // 1. 画像保存先 (storageRoot) を更新。
      const next = { ...settings, storageRoot: root };
      await storage.setSettings(next);
      // 2. プロジェクトデータも同じ root へ (既存の安全移行ロジックを再利用)。
      await storage.setProjectsDataRoot(root);
      const merged = await storage.getSettings();
      setSettings(merged);
      // 3. 新しい場所の projects.json から読み直す (移行済みデータを反映)。
      await useProjects.getState().initialize();
      push({
        kind: "success",
        text: "保存先を更新しました（画像・作品データを集約）",
        ttlMs: 2800,
      });
    } catch (err) {
      push({ kind: "error", text: `保存先の更新に失敗: ${String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const applySettings = async (next: StorageSettings) => {
    setSaving(true);
    try {
      await storage.setSettings(next);
      setSettings(next);
      push({ kind: "success", text: "保存先を更新しました", ttlMs: 2400 });
    } catch (err) {
      push({ kind: "error", text: `保存に失敗: ${String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const revealInFinder = async () => {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(settings.storageRoot);
    } catch (err) {
      push({ kind: "error", text: `Finderで開けません: ${String(err)}` });
    }
  };

  // プロジェクトデータ (projects.json) の保存先を変更する。
  // Rust 側で既存 projects.json を新フォルダへ移行してから設定保存し、
  // フロント側は projects ストアを再初期化して新ファイルから読み直す。
  const applyProjectsDataRoot = async (newRoot: string | null) => {
    setSaving(true);
    try {
      await storage.setProjectsDataRoot(newRoot);
      const next = await storage.getSettings();
      setSettings(next);
      // 新しい保存先のファイルから projects を読み直す（移行済みデータを反映）。
      await useProjects.getState().initialize();
      push({
        kind: "success",
        text: newRoot
          ? "プロジェクトデータ保存先を更新しました（既存データを移行済み）"
          : "プロジェクトデータ保存先を既定に戻しました",
        ttlMs: 3200,
      });
    } catch (err) {
      push({ kind: "error", text: `保存先の変更に失敗: ${String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const pickProjectsDataFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({ directory: true, multiple: false });
      if (typeof r === "string") void applyProjectsDataRoot(r);
    } catch (err) {
      push({ kind: "error", text: `フォルダ選択に失敗: ${String(err)}` });
    }
  };

  // バックアップ一覧を開く（取得して展開）。
  const openBackups = async () => {
    try {
      const list = await useProjects.getState().listBackups();
      setBackups(list);
      setBackupsOpen(true);
      if (list.length === 0) {
        push({
          kind: "info",
          text: "まだバックアップがありません（保存のたびに自動で作られます）。",
          ttlMs: 3500,
        });
      }
    } catch (err) {
      push({ kind: "error", text: `バックアップ取得に失敗: ${String(err)}` });
    }
  };

  // 選んだバックアップで現在のプロジェクトを置き換える（復元）。
  const restoreBackup = async (backupPath: string) => {
    setRestoring(true);
    try {
      const restored = await useProjects.getState().restoreFromBackup(backupPath);
      push({
        kind: "success",
        text: `バックアップから ${restored} 件のプロジェクトを復元しました。`,
        ttlMs: 3500,
      });
      setBackupsOpen(false);
    } catch (err) {
      push({ kind: "error", text: `復元に失敗: ${String(err)}` });
    } finally {
      setRestoring(false);
    }
  };

  const runMigration = async () => {
    if (!legacy?.exists) return;
    const sizeMb = (legacy.totalBytes / (1024 * 1024)).toFixed(1);
    const message = `${legacy.fileCount} ファイル (約${sizeMb}MB) を新しい保存先へコピーします。元ファイルは ~/.codex/ に残ります。よろしいですか？`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "保存先の移行", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) {
      return;
    }
    setMigrating(true);
    try {
      const result = await storage.migrateFromCodexHome();
      push({
        kind: "success",
        text: `移行完了: ${result.copiedCount} ファイル / 約${(result.totalBytes / (1024 * 1024)).toFixed(1)}MB をコピーしました（失敗 ${result.failedCount} 件）`,
        ttlMs: 4800,
      });
      // 移行後にレガシー集計を再取得（元ファイルは消えないので件数は変わらないが、念のため）。
      const next = await storage.legacySummary();
      setLegacy(next);
    } catch (err) {
      push({ kind: "error", text: `移行に失敗: ${String(err)}` });
    } finally {
      setMigrating(false);
    }
  };

  return (
    <Panel title="ローカル保存先">
      <Field label="現在の保存先">
        <div className="flex gap-2">
          <TextInput value={shortenPath(settings.storageRoot)} onChange={() => undefined} mono />
          <button
            type="button"
            onClick={() => void revealInFinder()}
            className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
          >
            Finderで開く
          </button>
          <button
            type="button"
            onClick={() => void pickFolder()}
            className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
          >
            変更...
          </button>
        </div>
      </Field>

      <Field label="推奨パス（クリックで設定）">
        <div className="space-y-1.5">
          {presets.map((preset) => {
            const isActive = preset.path === settings.storageRoot;
            return (
              <button
                key={preset.path}
                type="button"
                disabled={saving || isActive}
                onClick={() => void applyUnifiedRoot(preset.path)}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                  isActive
                    ? "border-pink-500 bg-pink-500/10 text-pink-100"
                    : "border-[#343434] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold">
                    {isActive ? "✓ " : ""}
                    {preset.label}
                  </span>
                  <span className="text-[10px] text-neutral-500">{preset.hint}</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
                  {shortenPath(preset.path)}
                </div>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="プロジェクト名でサブフォルダを作成">
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            checked={settings.projectSubfolder}
            onChange={(e) =>
              void applySettings({ ...settings, projectSubfolder: e.target.checked })
            }
            className="h-4 w-4"
          />
          <span>
            ON にすると {shortenPath(settings.storageRoot)}/プロジェクト名/{`{画像}`} の構造になる
          </span>
        </label>
      </Field>

      {/*
        プロジェクトデータ (projects.json) の保存先。
        画像 (storageRoot) とは別軸。Google Drive 等のローカル同期フォルダを
        指定すると、作品データ（プロジェクト一覧・企画チャット等）を別 PC と
        共有・バックアップできる。未指定なら従来どおりアプリ内部に保存。
      */}
      <Field label="プロジェクトデータの保存先（作品一覧・企画ログ）">
        <p className="mb-1.5 text-[11px] leading-relaxed text-neutral-400">
          プロジェクト一覧や企画チャットのデータ (projects.json) を保存する場所です。 Google Drive
          などのローカル同期フォルダ（例:{" "}
          <span className="font-mono">
            ~/Library/CloudStorage/GoogleDrive-…/マイドライブ/GORI GORI
          </span>
          ）を選ぶと、別の PC とデータを同期・バックアップできます。
          未設定ならアプリ内部に保存します（従来どおり）。
        </p>
        <div className="flex gap-2">
          <TextInput
            value={
              settings.projectsDataRoot
                ? shortenPath(settings.projectsDataRoot)
                : "（既定: アプリ内部に保存）"
            }
            onChange={() => undefined}
            mono
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void pickProjectsDataFolder()}
            className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
          >
            フォルダを選ぶ
          </button>
          {settings.projectsDataRoot ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void applyProjectsDataRoot(null)}
              className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
              title="アプリ内部の既定の保存先に戻します（データはコピーで移行されます）"
            >
              既定に戻す
            </button>
          ) : null}
        </div>
      </Field>

      {/*
        バックアップから復元。projects.json は保存のたびに自動で世代バックアップ
        される（最大10世代）。万一プロジェクトが消えた・おかしくなったときは、
        ここから過去の状態にワンクリックで戻せる（対話サポート不要で自力復旧）。
      */}
      <Field label="プロジェクトのバックアップ（消えたとき・戻したいとき）">
        <p className="mb-1.5 text-[11px] leading-relaxed text-neutral-400">
          プロジェクト一覧は保存のたびに自動でバックアップされています。
          もしプロジェクトが消えた・おかしくなった場合は、ここから過去の状態に戻せます。
        </p>
        <button
          type="button"
          disabled={restoring}
          onClick={() => void openBackups()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
        >
          バックアップから復元…
        </button>

        {backupsOpen && backups.length > 0 ? (
          <div className="mt-2 max-h-60 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-[11px] font-bold text-neutral-300">
                復元する時点を選ぶ（新しい順）
              </span>
              <button
                type="button"
                onClick={() => setBackupsOpen(false)}
                className="text-[11px] text-neutral-500 hover:text-neutral-200"
              >
                閉じる
              </button>
            </div>
            <ul className="space-y-1">
              {backups.map((b) => (
                <li
                  key={b.path}
                  className="flex items-center justify-between rounded-md bg-[#141414] px-2.5 py-1.5"
                >
                  <span className="text-[12px] text-neutral-200">
                    {new Date(b.at).toLocaleString("ja-JP")}{" "}
                    <span className="text-neutral-500">— {b.count} 件</span>
                  </span>
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => void restoreBackup(b.path)}
                    className={`${MUTED_BUTTON} h-7 px-2.5 text-[11px] disabled:opacity-40`}
                  >
                    {restoring ? "復元中…" : "これで復元"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 px-1 text-[10px] text-neutral-500">
              復元しても、その直前の状態もバックアップされるので、間違えてもまた戻せます。
            </p>
          </div>
        ) : null}
      </Field>

      {legacy?.exists && legacy.fileCount > 0 ? (
        <Field label="既存画像の移行">
          <div className="rounded-md border border-orange-400/40 bg-orange-500/5 p-3">
            <p className="text-xs text-orange-100">
              旧保存先 <span className="font-mono">~/.codex/generated_images/</span> に
              <strong> {legacy.fileCount} ファイル </strong>
              （約 {(legacy.totalBytes / (1024 * 1024)).toFixed(1)} MB）が残っています。
              新しい保存先へコピーできます（元ファイルは残ります）。
            </p>
            <button
              type="button"
              onClick={() => void runMigration()}
              disabled={migrating}
              className={`${PRIMARY_BUTTON} mt-2 h-9 px-3 text-xs disabled:opacity-40`}
            >
              {migrating ? "移行中..." : "新しい保存先へコピー"}
            </button>
          </div>
        </Field>
      ) : null}
      <StorageManagementSection />
    </Panel>
  );
}

function AccountSettings() {
  const accounts = useAccounts();
  const push = useToasts((s) => s.push);
  // 段階7 (2026-06-10): Higgsfield は MCP接続方式へ移行。installed/拡張パック導入
  // (installExtension / install-progress 購読) と CLI 診断 (debug) を廃止し、
  // Magnific と同じ接続/解除のみのシンプル UI にする。
  const refresh = async () => {
    await accounts.refresh();
    push({ kind: "success", text: "接続状態を更新しました", ttlMs: 2000 });
  };
  // A5: Higgsfield 接続/解除。接続先タブと同じ store (accounts.higgsfield) を読むため、
  // アカウントタブと接続先タブで接続状態が必ず一致する。MCP方式 (Magnific と同型)。
  const loginHiggsfield = async () => {
    try {
      await higgsfieldMcp.login();
      await accounts.refreshHiggsfield();
      const connected = useAccounts.getState().higgsfield.authenticated;
      push(
        connected
          ? { kind: "success", text: "Higgsfield に接続しました", ttlMs: 3000 }
          : {
              kind: "info",
              text: "ブラウザで Higgsfield のログインを完了してから、もう一度「接続」を押してください。",
              ttlMs: 7000,
            },
      );
    } catch (err) {
      push({ kind: "error", text: `Higgsfield 接続に失敗: ${String(err)}`, ttlMs: 6000 });
    }
  };
  const logoutHiggsfield = async () => {
    try {
      await higgsfieldMcp.logout();
      await accounts.refreshHiggsfield();
      push({ kind: "success", text: "Higgsfield の接続を解除しました", ttlMs: 3000 });
    } catch (err) {
      push({ kind: "error", text: `Higgsfield 接続解除に失敗: ${String(err)}`, ttlMs: 6000 });
    }
  };
  // A5: Magnific 接続/解除。接続先タブと同じ store (accounts.magnific) を読むため、
  // アカウントタブと接続先タブで接続状態が必ず一致する。
  const loginMagnific = async () => {
    try {
      await magnific.login();
      await accounts.refreshMagnific();
      push({ kind: "success", text: "Magnific に接続しました", ttlMs: 3000 });
    } catch (err) {
      push({ kind: "error", text: `Magnific 接続に失敗: ${String(err)}`, ttlMs: 6000 });
    }
  };
  const logoutMagnific = async () => {
    try {
      await magnific.logout();
      await accounts.refreshMagnific();
      push({ kind: "success", text: "Magnific の接続を解除しました", ttlMs: 3000 });
    } catch (err) {
      push({ kind: "error", text: `Magnific 接続解除に失敗: ${String(err)}`, ttlMs: 6000 });
    }
  };
  return (
    <Panel title="アカウント / 接続">
      <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">Codex (ChatGPT)</h3>
            <p className="mt-1 text-xs text-neutral-500">
              {accounts.codex.loggedIn ? (accounts.codex.email ?? "ログイン済み") : "未ログイン"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void accounts.loginCodex()}
            className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}
          >
            codex login
          </button>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-1 rounded-lg bg-[#101010] p-1">
          {(["free", "plus", "pro", "team"] as CodexPlan[]).map((plan) => (
            <button
              key={plan}
              type="button"
              onClick={() => accounts.setCodexPlan(plan)}
              className={`h-8 rounded-md text-xs font-bold ${
                accounts.codex.plan === plan
                  ? "bg-pink-500 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              {PLAN_LABELS[plan]}
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">Higgsfield</h3>
            <p className="mt-1 text-xs text-neutral-500">
              {accounts.higgsfield.authenticated
                ? `接続済み${accounts.higgsfield.plan ? ` · ${accounts.higgsfield.plan}` : ""}`
                : "未接続"}
            </p>
            {accounts.higgsfield.credits !== undefined && (
              <p className="mt-1 text-xs font-semibold text-pink-200">
                credits: {Math.round(accounts.higgsfield.credits)}
              </p>
            )}
            <p className="mt-1 text-[11px] text-neutral-500">
              動画・画像 AI 生成（オプショナル拡張・MCP接続）
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
            >
              テスト接続
            </button>
            {accounts.higgsfield.authenticated ? (
              <button
                type="button"
                onClick={() => void logoutHiggsfield()}
                className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
              >
                ログアウト
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loginHiggsfield()}
                className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}
              >
                接続
              </button>
            )}
          </div>
        </div>
      </section>
      {/*
        A5: Magnific 接続カード。接続先 (拡張機能) タブには既に Magnific カードが
        あるのに、ここ (アカウント / 接続) には無く、右上バッジが点灯していても
        不整合だった。Higgsfield カードと同じ UI パターンで追加し、接続状態を
        accounts.magnific (接続先タブと同一 store) から読むことで表示を一致させる。
      */}
      <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">Magnific</h3>
            <p className="mt-1 text-xs text-neutral-500">
              {accounts.magnific.authenticated ? "接続済み" : "未接続"}
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              画像・動画 AI 生成 + 高精細アップスケール（オプショナル拡張）
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {accounts.magnific.authenticated ? (
              <button
                type="button"
                onClick={() => void logoutMagnific()}
                className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
              >
                ログアウト
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loginMagnific()}
                className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}
              >
                接続
              </button>
            )}
          </div>
        </div>
      </section>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // A3: 設定パネルの横幅を制作タブ (App.tsx) の max-w-6xl に合わせる。
    // 設定だけ狭くて不統一だった問題を解消。接続先タブ (SettingsConnections) も
    // 既に max-w-6xl なので、これで全設定タブの横幅が揃う。
    <div className="mx-auto max-w-6xl space-y-4">
      <h2 className="text-lg font-black text-white">{title}</h2>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-300">{label}</span>
      {children}
    </label>
  );
}
function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      spellCheck={false}
      className={`h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-500 ${props.mono ? "font-mono" : ""}`}
    />
  );
}
