import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  higgsfield,
  storage,
  type HiggsfieldDebugInfo,
  type HiggsfieldInstallProgress,
  type LegacySummary,
  type StorageSettings,
} from "../lib/ipc";
import { useAccounts, type CodexPlan } from "../lib/store/accounts";
import { useSettings } from "../lib/store/settings";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
// SettingsCloudSection は v0.6.13 でα版非表示。β以降で復活予定。
// import { SettingsCloudSection } from "./SettingsCloudSection";
import { SettingsConnections } from "./SettingsConnections";
import { UpdateChecker } from "./UpdateChecker";
import { StorageManagementSection } from "./StorageManagementSection";
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
    if (draft.defaultModel && draft.defaultModel !== selectedModel) setSelectedModel(draft.defaultModel);
    if (draft.defaultEffort) setSelectedEffort(draft.defaultEffort);
    if (draft.defaultCwd) setCwd(draft.defaultCwd);
    push({ kind: "success", text: "基本設定を保存しました", ttlMs: 2400 });
  };
  return (
    <Panel title="基本">
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
            value={draft.approvalPolicy ?? "on-request"}
            onChange={(e) => update("approvalPolicy", e.target.value as typeof draft.approvalPolicy)}
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
      <button type="button" onClick={() => void onSave()} className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}>
        保存
      </button>
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
    { label: "Pictures（推奨、Finderで見える）", path: `${home}/Pictures/GORI GORI`, hint: "Mac標準の写真フォルダ" },
    { label: "Documents", path: `${home}/Documents/GORI GORI`, hint: "書類フォルダ" },
    { label: "Desktop", path: `${home}/Desktop/GORI GORI`, hint: "デスクトップ" },
    { label: "iCloud Drive", path: `${home}/Library/Mobile Documents/com~apple~CloudDocs/GORI GORI`, hint: "iCloud で自動同期" },
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
      if (typeof r === "string") void applySettings({ ...settings, storageRoot: r });
    } catch (err) {
      push({ kind: "error", text: `フォルダ選択に失敗: ${String(err)}` });
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

  const runMigration = async () => {
    if (!legacy?.exists) return;
    const sizeMb = (legacy.totalBytes / (1024 * 1024)).toFixed(1);
    if (!window.confirm(`${legacy.fileCount} ファイル (約${sizeMb}MB) を新しい保存先へコピーします。元ファイルは ~/.codex/ に残ります。よろしいですか？`)) {
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
          <button type="button" onClick={() => void revealInFinder()} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
            Finderで開く
          </button>
          <button type="button" onClick={() => void pickFolder()} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
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
                onClick={() => void applySettings({ ...settings, storageRoot: preset.path })}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs transition ${
                  isActive
                    ? "border-pink-500 bg-pink-500/10 text-pink-100"
                    : "border-[#343434] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold">{isActive ? "✓ " : ""}{preset.label}</span>
                  <span className="text-[10px] text-neutral-500">{preset.hint}</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-neutral-500">{shortenPath(preset.path)}</div>
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
            onChange={(e) => void applySettings({ ...settings, projectSubfolder: e.target.checked })}
            className="h-4 w-4"
          />
          <span>ON にすると {shortenPath(settings.storageRoot)}/プロジェクト名/{`{画像}`} の構造になる</span>
        </label>
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
  // F-#13: Higgsfield 診断ダイアログ。ユーザー環境の実測情報を取得・表示する。
  const [debugInfo, setDebugInfo] = useState<HiggsfieldDebugInfo | null>(null);
  const [debugRunning, setDebugRunning] = useState(false);
  /**
   * 真のワンタップ化 (2026-05-19): アプリ内ボタン一発で拡張パックを DL → 配置 → 検出 する。
   * 進捗を Tauri event "higgsfield:install-progress" で受け取り、UI に出す。
   */
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<string>("");
  useEffect(() => {
    let unlisten: undefined | (() => void);
    void (async () => {
      const handle = await listen<HiggsfieldInstallProgress>(
        "higgsfield:install-progress",
        (event) => {
          const p = event.payload;
          switch (p.kind) {
            case "started":
              setInstallProgress("インストール開始…");
              break;
            case "downloading":
              setInstallProgress("拡張パックをダウンロード中…");
              break;
            case "downloaded":
              setInstallProgress(
                `ダウンロード完了 (${Math.round(p.bytes / 1024 / 1024)} MB)`,
              );
              break;
            case "extracting":
              setInstallProgress("展開中…");
              break;
            case "installed":
              setInstallProgress(`配置完了: ${p.path}`);
              break;
            case "failed":
              setInstallProgress(`失敗: ${p.message}`);
              break;
          }
        },
      );
      unlisten = handle;
    })();
    return () => {
      unlisten?.();
    };
  }, []);
  const refresh = async () => {
    await accounts.refresh();
    push({ kind: "success", text: "接続状態を更新しました", ttlMs: 2000 });
  };
  const installExtension = async () => {
    setInstalling(true);
    setInstallProgress("インストール開始…");
    try {
      await higgsfield.installExtension();
      await accounts.refreshHiggsfield();
      push({
        kind: "success",
        text: "Higgsfield 拡張パックを自動インストールしました",
        ttlMs: 3500,
      });
      setInstallProgress("");
    } catch (err) {
      push({ kind: "error", text: `自動インストールに失敗: ${String(err)}` });
    } finally {
      setInstalling(false);
    }
  };
  const loginHiggsfield = async () => {
    await higgsfield.login();
    await accounts.refreshHiggsfield();
  };
  const logoutHiggsfield = async () => {
    await higgsfield.logout();
    await accounts.refreshHiggsfield();
  };
  const runDebug = async () => {
    setDebugRunning(true);
    try {
      const info = await higgsfield.debug();
      setDebugInfo(info);
    } catch (err) {
      push({ kind: "error", text: `診断に失敗: ${String(err)}` });
    } finally {
      setDebugRunning(false);
    }
  };
  return (
    <Panel title="アカウント / 接続">
      <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">Codex (ChatGPT)</h3>
            <p className="mt-1 text-xs text-neutral-500">
              {accounts.codex.loggedIn ? accounts.codex.email ?? "ログイン済み" : "未ログイン"}
            </p>
          </div>
          <button type="button" onClick={() => void accounts.loginCodex()} className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}>
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
                accounts.codex.plan === plan ? "bg-pink-500 text-white" : "text-neutral-400 hover:text-white"
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
              {!accounts.higgsfield.installed
                ? "拡張パック未インストール"
                : accounts.higgsfield.authenticated
                  ? `接続済み${accounts.higgsfield.plan ? ` · ${accounts.higgsfield.plan}` : ""}`
                  : "未認証"}
            </p>
            {accounts.higgsfield.credits !== undefined && (
              <p className="mt-1 text-xs font-semibold text-pink-200">
                credits: {Math.round(accounts.higgsfield.credits)}
              </p>
            )}
            {installing && installProgress && (
              <p className="mt-1 text-xs font-semibold text-amber-300">
                {installProgress}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {/*
              真のワンタップ化 (2026-05-19): 拡張パック未検出時はこのボタン1つで
              GitHub Release から DL → 配置 → 検出 が完結する。
              既にインストール済みでも「再インストール」用途で残しておく。
            */}
            <button
              type="button"
              onClick={() => void installExtension()}
              disabled={installing}
              className={`${PRIMARY_BUTTON} h-9 px-3 text-xs disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500`}
              title={
                accounts.higgsfield.installed
                  ? "拡張パックを最新版に再インストール"
                  : "Higgsfield 拡張パックを自動でダウンロード・配置します"
              }
            >
              {installing
                ? "インストール中…"
                : accounts.higgsfield.installed
                  ? "再インストール"
                  : "ワンタップ導入"}
            </button>
            <button type="button" onClick={() => void refresh()} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
              テスト接続
            </button>
            {/* F-#13: Higgsfield 診断 — 接続できない時に実測情報を吐く */}
            <button
              type="button"
              onClick={() => void runDebug()}
              disabled={debugRunning}
              className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60`}
              title="Higgsfield CLI のパス・PATH 環境変数・実行結果を表示します。接続できない時のサポート用。"
            >
              {debugRunning ? "診断中…" : "診断"}
            </button>
            {accounts.higgsfield.authenticated ? (
              <button type="button" onClick={() => void logoutHiggsfield()} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
                ログアウト
              </button>
            ) : (
              <button type="button" onClick={() => void loginHiggsfield()} className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}>
                接続
              </button>
            )}
          </div>
        </div>
      </section>
      {debugInfo && (
        <HiggsfieldDebugDialog info={debugInfo} onClose={() => setDebugInfo(null)} />
      )}
    </Panel>
  );
}

function HiggsfieldDebugDialog({
  info,
  onClose,
}: {
  info: HiggsfieldDebugInfo;
  onClose: () => void;
}) {
  const push = useToasts((s) => s.push);
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
      push({ kind: "success", text: "診断情報をクリップボードにコピーしました", ttlMs: 2500 });
    } catch (err) {
      push({ kind: "error", text: `コピーに失敗: ${String(err)}` });
    }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl min-h-0 flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
          <div>
            <h3 className="text-sm font-black text-white">Higgsfield 診断結果</h3>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              この情報をサポート (Discord 等) にコピペで送ってください
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void copyAll()} className={`${MUTED_BUTTON} h-8 px-3 text-xs`}>
              全部コピー
            </button>
            <button type="button" onClick={onClose} aria-label="閉じる" className="text-neutral-400 hover:text-white">
              ×
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <DebugRow label="OS / Arch" value={`${info.os} / ${info.arch}`} />
          <DebugRow label="拡張パック存在" value={info.extensionDirExists ? "✓ あり" : "✗ なし"} />
          <DebugRow label="拡張パックパス" value={info.extensionDir} mono />
          {info.extensionDirExists && info.extensionDirListing.length > 0 && (
            <DebugRow
              label="拡張パック中身"
              value={info.extensionDirListing.join("\n")}
              mono
              multiline
            />
          )}
          <DebugRow label="検出した higgsfield" value={info.resolvedBinary ?? "(未検出)"} mono />
          <DebugRow label="現在の PATH" value={info.currentPath} mono multiline />
          <DebugRow label="enriched_path" value={info.enrichedPath} mono multiline />
          <DebugProbe label="higgsfield --version" probe={info.versionProbe} />
          <DebugProbe label="higgsfield auth token" probe={info.authTokenProbe} />
          <DebugProbe label="higgsfield account status --json" probe={info.accountProbe} />
        </div>
      </div>
    </div>
  );
}

function DebugRow({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="mb-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={[
          "mt-0.5 break-all rounded bg-[#101010] p-2 text-[11px] text-neutral-200",
          mono ? "font-mono" : "",
          multiline ? "whitespace-pre-wrap" : "",
        ].join(" ")}
      >
        {value || "(空)"}
      </p>
    </div>
  );
}

function DebugProbe({
  label,
  probe,
}: {
  label: string;
  probe: HiggsfieldDebugInfo["versionProbe"];
}) {
  return (
    <div className="mb-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
        {label}{" "}
        <span className="text-neutral-400">
          {probe.ran ? `(exit ${probe.exitCode ?? "?"})` : "(未実行)"}
        </span>
      </p>
      {probe.error && (
        <p className="mt-0.5 rounded bg-rose-950/40 p-2 text-[11px] font-mono text-rose-200">
          ERROR: {probe.error}
        </p>
      )}
      {probe.stdout && (
        <p className="mt-0.5 whitespace-pre-wrap break-all rounded bg-[#101010] p-2 text-[11px] font-mono text-neutral-200">
          stdout: {probe.stdout}
        </p>
      )}
      {probe.stderr && (
        <p className="mt-0.5 whitespace-pre-wrap break-all rounded bg-amber-950/40 p-2 text-[11px] font-mono text-amber-200">
          stderr: {probe.stderr}
        </p>
      )}
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
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
