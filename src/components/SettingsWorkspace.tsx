import { useCallback, useEffect, useState } from "react";
import {
  higgsfieldMcp,
  type LegacySummary,
  magnific,
  type StorageBreakdown,
  type StorageCategoryKey,
  type StorageCleanupCategory,
  type StorageSettings,
  storage,
  storageCleanup,
} from "../lib/ipc";
import {
  beginStorageRootSwitch,
  ensureStorageRootSwitchClosed,
  initializeGeneratedMotions,
} from "../lib/scene3d/motionStore";
import { applyRelinkResult } from "../lib/relinkApply";
import {
  type BackupListResult,
  formatRelativeAge,
  summarizeBackupHealth,
} from "../lib/store/backupHealth";
import { type CodexPlan, useAccounts } from "../lib/store/accounts";
import { usePresets } from "../lib/store/presets";
import { initializeScene3d } from "../lib/store/scene3d";
import { useProjects } from "../lib/store/projects";
import { useSettings } from "../lib/store/settings";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { type SettingsWorkspaceTab, useWorkspace } from "../lib/store/workspace";
import { useWorldContexts } from "../lib/store/worldContexts";
// SettingsCloudSection は v0.6.13 でα版非表示。β以降で復活予定。
// import { SettingsCloudSection } from "./SettingsCloudSection";
import { SettingsConnections } from "./SettingsConnections";
import { SettingsDiagnostics } from "./SettingsDiagnostics";
import { UpdateChecker } from "./UpdateChecker";
import { FONT_SCALE_OPTIONS, useFontScale } from "../lib/store/fontScale";
import { useGuidePreference } from "../lib/store/guidePreference";

const TABS: Array<{ id: SettingsWorkspaceTab; label: string }> = [
  { id: "basic", label: "基本" },
  { id: "storage", label: "保存先" },
  { id: "accounts", label: "アカウント" },
  { id: "connections", label: "接続先 (拡張機能)" },
  { id: "diagnostics", label: "診断" },
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
  const [tab, setTab] = useState<SettingsWorkspaceTab>(
    () => useWorkspace.getState().requestedSettingsTab ?? "basic",
  );
  const requestedSettingsTab = useWorkspace((state) => state.requestedSettingsTab);
  const consumeRequestedSettingsTab = useWorkspace(
    (state) => state.consumeRequestedSettingsTab,
  );
  const accounts = useAccounts();
  useEffect(() => {
    if (!requestedSettingsTab) return;
    setTab(requestedSettingsTab);
    consumeRequestedSettingsTab();
  }, [requestedSettingsTab, consumeRequestedSettingsTab]);
  useEffect(() => {
    void accounts.refresh();
  }, []);
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          data-tour="settings-tabs"
          className="w-48 shrink-0 border-r border-[#242424] bg-[#151515] p-3"
        >
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
            <div data-tour="settings-panel-basic" className="space-y-6">
              <BasicSettings />
              <WorldContextSettings />
              <UpdateChecker />
            </div>
          )}
          {tab === "storage" && (
            <div data-tour="settings-panel-storage" className="space-y-6">
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
          {tab === "accounts" && (
            <div data-tour="settings-panel-accounts"><AccountSettings /></div>
          )}
          {tab === "connections" && (
            <div data-tour="settings-panel-connections"><SettingsConnections /></div>
          )}
          {tab === "diagnostics" && (
            <div data-tour="settings-panel-diagnostics"><SettingsDiagnostics /></div>
          )}
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
  const guideEnabled = useGuidePreference((s) => s.enabled);
  const setGuideEnabled = useGuidePreference((s) => s.setEnabled);
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
      <Field label="はじめてガイド">
        <div className="flex items-center justify-between gap-4 rounded-md border border-[#343434] bg-[#101010] px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-neutral-400">
            初回の案内と、いつでも画面ガイドを開ける左下の「?」を表示します。
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={guideEnabled}
            onClick={() => setGuideEnabled(!guideEnabled)}
            className={`relative h-7 w-14 shrink-0 rounded-full border transition ${
              guideEnabled
                ? "border-pink-400 bg-pink-500/25"
                : "border-[#444] bg-[#1e1e1e]"
            }`}
          >
            <span
              className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition ${
                guideEnabled ? "left-8 bg-pink-300" : "left-1 bg-neutral-500"
              }`}
              aria-hidden
            />
            <span className="sr-only">{guideEnabled ? "オン" : "オフ"}</span>
          </button>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
          {guideEnabled
            ? "オン: はじめてガイドと左下の「?」を表示します。"
            : "オフ: 自動の案内と左下の「?」を表示しません。"}
          変更はすぐ反映されます。
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
 * FB#16 → v29: 作品の世界観 / コンテキスト登録欄。
 *
 * ここに登録した自由文 (Markdown 等) は、企画タブ (PlanWorkspace) の
 * 初回ターンでシステムプロンプトに注入される。AI が作品設定を前提に
 * 対話を始められるようにするのが狙い。
 *
 * v29 で **複数保持 + プルダウン切替** に変更した。案件・作品ごとにコンテキストを
 * 使い分けたいという要望を受けたもの。実体は `world-contexts.json`
 * (lib/store/worldContexts.ts)。旧 `settings.worldContext` は初回ロード時に
 * 1 エントリへ移行され、以後は読まない (値自体は残置)。
 *
 * - 直接テキスト入力 / .md などのテキストファイル読み込みの両方に対応。
 * - 保存しないと反映されないので、明示的な「保存」ボタンを置く。
 * - 選択が変わる操作の前に、未保存なら確認ダイアログを挟む。
 */
function WorldContextSettings() {
  const { items, activeId, loaded, load, create, update, importFromFile, archive, setActive } =
    useWorldContexts();
  const push = useToasts((s) => s.push);
  const [nameDraft, setNameDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const active = activeId ? (items.find((e) => e.id === activeId) ?? null) : null;
  // プルダウンに出すのは非 archived のみ。順序は作成順で固定する
  // (更新のたびに並びが動くと選びにくい)。
  const visible = items.filter((e) => !e.archived).sort((a, b) => a.createdAt - b.createdAt);

  // 選択が変わったら編集中の下書きを選択中エントリの保存値に合わせる。
  useEffect(() => {
    setNameDraft(active?.name ?? "");
    setContentDraft(active?.content ?? "");
  }, [active?.id, active?.name, active?.content]);

  const dirty =
    !!active && (nameDraft !== active.name || contentDraft !== active.content);

  /** 選択が変わる操作の前に、未保存の変更を破棄してよいか確認する。 */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    const message = "保存されていない変更があります。破棄して切り替えますか？";
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return await ask(message, { title: "世界観 / コンテキスト" });
    } catch {
      return window.confirm(message);
    }
  };

  const onSelect = async (id: string | null) => {
    if (!(await confirmDiscard())) return;
    await setActive(id);
  };

  const onCreate = async () => {
    if (!(await confirmDiscard())) return;
    await create("新しいコンテキスト");
  };

  const importFile = async () => {
    if (!(await confirmDiscard())) return;
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
      // 選択中への上書きではなく、新規エントリとして追加する
      // (既存のコンテキストを踏み潰さない)。
      const fileName = picked.split(/[\\/]/).pop() ?? picked;
      const entry = await importFromFile(fileName, content);
      // 永続化に失敗していたら importFromFile 側がエラートーストを出している。
      // 「追加しました」を重ねない（再起動で消えるものを成功と言わない）。
      if (!entry.persisted) return;
      push({
        kind: "success",
        text: `ファイルを「${entry.name}」として追加しました`,
        ttlMs: 2800,
      });
    } catch (err) {
      push({ kind: "error", text: `ファイルの読み込みに失敗しました: ${String(err)}` });
    }
  };

  const onSave = async () => {
    if (!active) return;
    // 名前が空でも保存はブロックせず、既定名を当てる。
    const name = nameDraft.trim() || "無題のコンテキスト";
    // 保存に失敗したときは persistOrToast がエラートーストを出す。ここで
    // 成功トーストを重ねると「保存しました」と嘘をつくことになるので出さない。
    const ok = await update(active.id, { name, content: contentDraft });
    if (!ok) return;
    push({
      kind: "success",
      text: `世界観 / コンテキスト「${name}」を保存しました`,
      ttlMs: 2400,
    });
  };

  const onDelete = async () => {
    if (!active) return;
    const message = `「${active.name}」を削除しますか？`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "コンテキストの削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    const name = active.name;
    const ok2 = await archive(active.id);
    if (!ok2) return; // 失敗時は archive 側のエラートーストだけを見せる
    push({ kind: "success", text: `「${name}」を削除しました`, ttlMs: 2400 });
  };

  return (
    <Panel title="世界観 / コンテキスト">
      <p className="text-xs leading-relaxed text-neutral-400">
        作品ごとの世界観・キャラ設定・トーンを複数登録し、プルダウンで切り替えられます。選択中のコンテキストを企画タブの
        AI が踏まえて会話を始めます。
      </p>
      <Field label="使用するコンテキスト">
        <select
          value={activeId ?? ""}
          onChange={(e) => void onSelect(e.target.value || null)}
          className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100"
        >
          <option value="">なし（AI に渡さない）</option>
          {visible.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </Field>
      {active && (
        <Field label="名前">
          <TextInput value={nameDraft} onChange={setNameDraft} />
        </Field>
      )}
      <Field label="内容 (Markdown 可)">
        <textarea
          value={active ? contentDraft : ""}
          onChange={(e) => setContentDraft(e.target.value)}
          disabled={!active}
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
          disabled={!dirty}
          className={`${PRIMARY_BUTTON} h-9 px-4 text-xs disabled:opacity-50`}
        >
          {dirty ? "保存" : "保存済み"}
        </button>
        <button
          type="button"
          onClick={() => void onCreate()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
        >
          新規作成
        </button>
        <button
          type="button"
          onClick={() => void importFile()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
        >
          ファイルから読み込む
        </button>
        {active && (
          <button
            type="button"
            onClick={() => void onDelete()}
            className={`${MUTED_BUTTON} h-9 px-3 text-xs`}
          >
            削除
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
  const presetsFileState = usePresets((s) => s.presetsFileState);
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [legacy, setLegacy] = useState<LegacySummary | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [saving, setSaving] = useState(false);
  // バックアップから復元 UI 用。
  // 「取得できなかった」と「0件だった」を区別するため、配列でなく
  // BackupListResult を保持する（2026-08-06。空配列に畳むと故障時に
  // 「バックアップがありません」と誤って断言してしまう）。
  const [backups, setBackups] = useState<
    BackupListResult<{ path: string; at: number; count: number }> | null
  >(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // プリセット（キャラクター含む）のバックアップから復元 UI 用。
  // projects 側と state を分ける（片方を開いても他方の一覧が出ない）。
  const [presetBackups, setPresetBackups] = useState<
    BackupListResult<{ path: string; at: number; count: number }> | null
  >(null);
  const [presetBackupsOpen, setPresetBackupsOpen] = useState(false);
  const [presetRestoring, setPresetRestoring] = useState(false);
  // 3Dシーンのバックアップから復元 UI 用。
  // presets / projects と state を分ける（片方を開いても他方の一覧が出ない）。
  const [scene3dBackups, setScene3dBackups] = useState<
    BackupListResult<{ path: string; at: number; shots: number }> | null
  >(null);
  const [scene3dBackupsOpen, setScene3dBackupsOpen] = useState(false);
  const [scene3dRestoring, setScene3dRestoring] = useState(false);

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
    // 保存先を変えても既存画像は移動しない（巨大で失敗リスクが高いため）。
    // 「変えたら過去の画像が消えた」と誤解されないよう、事前に正直に伝える。
    // 実際には旧保存先も読み続けるので画像は見えたままになる
    // （watcher_dirs が previous_storage_roots を含む。2026-07-30）。
    const message =
      "新しい保存先に切り替えます。\n\n" +
      "・キャラクター、プリセット、プロジェクト、3Dシーン、3Dモーションは新しい場所にコピーされます\n" +
      "・これまでに作った画像は元の場所に残ります（動かしません）\n" +
      "・元の場所の画像もこれまでどおり表示されます\n\n" +
      "続けますか？";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "保存先の変更", kind: "info" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) {
      return;
    }
    setSaving(true);
    // B1-A-03: finally から参照するため try の外で宣言 (const in try は finally から不可視)。
    let switchToken = -1;
    try {
      // 0. モーションのファイル書き込みをロックし、進行中の書き込みを
      //    **旧保存先で決着させてから** 保存先を切り替える (B1 2026-08-03)。
      //    ここを抜くと、切替直前に始まった motions_write が新しい保存先へ
      //    古い内容を書き、移行してきた正本を潰す。
      switchToken = await beginStorageRootSwitch();
      // 1. 画像保存先 (storageRoot) を更新。
      const next = { ...settings, storageRoot: root };
      // l99 4-2: root が変わると Rust 側が再リンクを走らせ、旧→新パスマップを返す。
      // 適用は下の initialize 群が終わってから (先に当てるとファイル読込で消える)。
      const relink = await storage.setSettings(next);
      // 2. プロジェクトデータも同じ root へ (既存の安全移行ロジックを再利用)。
      // 戻り値は「新 root へ運べなかった世代バックアップの件数」(2026-08-06 DL-04)。
      // 移行自体は成功しているので処理は続け、下で警告だけ出す。
      const backupCopyFailures = await storage.setProjectsDataRoot(root);
      const merged = await storage.getSettings();
      setSettings(merged);
      // 3. 新しい場所の projects.json から読み直す (移行済みデータを反映)。
      await useProjects.getState().initialize();
      // presets.json も新 root から読み直す。未作成なら initialize の移行パスが
      // 現 in-memory 状態 (= 変更前の全データ) を新 root へ書くので移行も成立する。
      await usePresets.getState().initialize();
      // 3Dシーンも新 root から読み直す（未作成なら現 in-memory 状態を新 root へ移行）。
      await initializeScene3d();
      // 3Dモーション (motions.json) も同じ root に置かれる。ここを抜くと
      // シーンの clipId だけ新 root に移り、モーション実体は旧 root の
      // キャッシュのまま残る（次回起動まで参照が宙に浮く）。
      // force=true: 起動時の読み込みが未完了でも、それは旧 root を読んでいるので
      // 相乗りせず新 root を読み直す。
      await initializeGeneratedMotions(true);
      // 4. 保存先変更で走った再リンクの結果を、読み直し後の state へ適用する。
      //    ここを欠くと projects / presets / favorites / judgements /
      //    referenceRoles が旧パスを握ったままで、次回起動まで stale になる。
      if (relink) applyRelinkResult(relink);
      push({
        kind: "success",
        text: "保存先を更新しました（画像・作品データを集約）",
        ttlMs: 2800,
      });
      if (backupCopyFailures > 0) {
        push({
          kind: "error",
          text: `過去のバックアップ ${backupCopyFailures} 件を新しい保存先へコピーできませんでした。現在のデータは問題なく使えます（過去のバックアップは元のフォルダに残っています）。`,
          ttlMs: 8000,
        });
      }
    } catch (err) {
      push({ kind: "error", text: `保存先の更新に失敗: ${String(err)}` });
    } finally {
      // B1-A案: 途中で例外が出て force 初期化に到達しなかった場合でも、
      // モーション保存のブロックを再初期化経由で必ず解除する (張り付き防止)。
      // B1-A-03: 自分の切替トークンを渡す (古い finally が新しい切替を触らない)。
      ensureStorageRootSwitchClosed(switchToken);
      setSaving(false);
    }
  };

  const applySettings = async (next: StorageSettings) => {
    setSaving(true);
    try {
      // l99 4-2: storageRoot が変わっていれば再リンク結果が返る。
      // この経路は store の読み直しを伴わないため、受け取り次第すぐ適用してよい。
      const relink = await storage.setSettings(next);
      setSettings(next);
      if (relink) applyRelinkResult(relink);
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
    // B1-A-03: finally から参照するため try の外で宣言する。
    let switchToken = -1;
    try {
      // applyUnifiedRoot と同じ理由でモーション書き込みを先に決着させる (B1)。
      switchToken = await beginStorageRootSwitch();
      // 戻り値は「新 root へ運べなかった世代バックアップの件数」(2026-08-06 DL-04)。
      const backupCopyFailures = await storage.setProjectsDataRoot(newRoot);
      const next = await storage.getSettings();
      setSettings(next);
      // 新しい保存先のファイルから projects を読み直す（移行済みデータを反映）。
      await useProjects.getState().initialize();
      // presets も同じ保存先に置かれるため、同じタイミングで読み直す
      // （ここを抜くと保存先変更後に古いキャラ一覧が残り、次回起動まで直らない）。
      await usePresets.getState().initialize();
      // 3Dシーンも新 root から読み直す（未作成なら現 in-memory 状態を新 root へ移行）。
      await initializeScene3d();
      // 3Dモーションも同様（applyUnifiedRoot と同じ理由。抜くと clipId が宙に浮く）。
      await initializeGeneratedMotions(true);
      push({
        kind: "success",
        text: newRoot
          ? "プロジェクトデータ保存先を更新しました（既存データを移行済み）"
          : "プロジェクトデータ保存先を既定に戻しました",
        ttlMs: 3200,
      });
      if (backupCopyFailures > 0) {
        push({
          kind: "error",
          text: `過去のバックアップ ${backupCopyFailures} 件を新しい保存先へコピーできませんでした。現在のデータは問題なく使えます（過去のバックアップは元のフォルダに残っています）。`,
          ttlMs: 8000,
        });
      }
    } catch (err) {
      push({ kind: "error", text: `保存先の変更に失敗: ${String(err)}` });
    } finally {
      // B1-A案: applyUnifiedRoot と同じ張り付き防止 (再初期化経由の解除)。
      // B1-A-03: 自分の切替トークンを渡す。
      ensureStorageRootSwitchClosed(switchToken);
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
  // 0件でも一覧を開く（枠内に「無い」or「取れなかった」を出し分ける）。
  const openBackups = async () => {
    setBackups(await useProjects.getState().listBackups());
    setBackupsOpen(true);
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

  // プリセットのバックアップ一覧を開く（取得して展開）。
  // projects 側と同じく、0件でも一覧を開いて枠内で理由を出し分ける。
  const openPresetBackups = async () => {
    setPresetBackups(await usePresets.getState().listBackups());
    setPresetBackupsOpen(true);
  };

  // 選んだバックアップでプリセット・キャラクターを置き換える（復元）。
  const restorePresetBackup = async (backupPath: string) => {
    setPresetRestoring(true);
    try {
      const restored = await usePresets.getState().restoreFromBackup(backupPath);
      push({
        kind: "success",
        text: `バックアップから ${restored} 件のプリセット・キャラクターを復元しました。`,
        ttlMs: 3500,
      });
      setPresetBackupsOpen(false);
    } catch (err) {
      push({ kind: "error", text: `復元に失敗: ${String(err)}` });
    } finally {
      setPresetRestoring(false);
    }
  };

  // 3Dシーンのバックアップ一覧を開く（取得して展開）。
  // 0件でも一覧を開く（presets 側のトースト方式と違い、空であることを枠内に出す）。
  const openScene3dBackups = async () => {
    const { listScene3dBackups } = await import("../lib/store/scene3d");
    setScene3dBackups(await listScene3dBackups());
    setScene3dBackupsOpen(true);
  };

  // 選んだバックアップで3Dシーンを置き換える（復元）。
  // 成否のトーストは store 側（scene3d.ts）が出すので、ここでは出さない
  // （文言の正本を1箇所に保つ）。
  const restoreScene3dBackup = async (backupPath: string) => {
    setScene3dRestoring(true);
    try {
      const { restoreScene3dFromBackupWithToast } = await import("../lib/store/scene3d");
      const restored = await restoreScene3dFromBackupWithToast(backupPath);
      if (restored !== null) setScene3dBackupsOpen(false);
    } finally {
      setScene3dRestoring(false);
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
        <p className="mb-1.5 text-[11px] text-neutral-400">
          作品一覧と企画ログの保存場所です。未設定ならアプリ内部に保存します。
        </p>
        <details className="mb-2 text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">同期・バックアップの詳細</summary>
          <p className="mt-1.5 leading-relaxed">
            Google Driveなどのローカル同期フォルダ（例: {" "}
            <span className="font-mono">
              ~/Library/CloudStorage/GoogleDrive-…/マイドライブ/GORI GORI
            </span>
            ）を選ぶと、別のPCともデータを同期できます。
          </p>
        </details>
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
        <p className="mb-1.5 text-[11px] text-neutral-400">
          保存のたびに自動でバックアップしています。
        </p>
        <details className="mb-2 text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">復元について</summary>
          <p className="mt-1.5 leading-relaxed">
            プロジェクトが消えた・おかしくなった場合に、過去の状態へ戻せます。
          </p>
        </details>
        <BackupHealthLine result={backups} />
        <button
          type="button"
          disabled={restoring}
          onClick={() => void openBackups()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
        >
          バックアップから復元…
        </button>

        {backupsOpen && backups ? (
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
            <BackupListBody
              result={backups}
              emptyText="まだバックアップがありません（保存のたびに自動で作られます）。"
              onRetry={() => void openBackups()}
              renderMeta={(b) => `${b.count} 件`}
              renderAction={(b) => (
                <button
                  type="button"
                  disabled={restoring}
                  onClick={() => void restoreBackup(b.path)}
                  className={`${MUTED_BUTTON} h-7 px-2.5 text-[11px] disabled:opacity-40`}
                >
                  {restoring ? "復元中…" : "これで復元"}
                </button>
              )}
            />
          </div>
        ) : null}
      </Field>

      {/*
        プリセット・キャラクターのバックアップから復元。
        presets.json も保存のたびに自動で世代バックアップされる（最大10世代、
        backup_projects_file がパス汎用のため projects と同じ仕組みが効いている）。
        バックアップは前から作られていたのに到達導線が無く、開発者しか戻せなかった。
        （2026-07-30 全ユーザーデータ生存監査 §5）
      */}
      <Field label="プリセット・キャラクターのバックアップ（消えたとき・戻したいとき）">
        <p className="mb-1.5 text-[11px] text-neutral-400">
          キャラクターとプリセットを保存のたびに自動で守ります。
        </p>
        <details className="mb-2 text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">復元について</summary>
          <p className="mt-1.5 leading-relaxed">
            登録内容が消えた・おかしくなった場合に、過去の状態へ戻せます。
          </p>
        </details>
        {presetsFileState === "corrupted" || presetsFileState === "unreadable" ? (
          <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold leading-relaxed text-amber-200">
            プリセット正本ファイルが読み込めない状態です。復元をおすすめします
          </p>
        ) : null}
        <BackupHealthLine result={presetBackups} />
        <button
          type="button"
          disabled={presetRestoring}
          onClick={() => void openPresetBackups()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
        >
          バックアップから復元…
        </button>

        {presetBackupsOpen && presetBackups ? (
          <div className="mt-2 max-h-60 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-[11px] font-bold text-neutral-300">
                復元する時点を選ぶ（新しい順）
              </span>
              <button
                type="button"
                onClick={() => setPresetBackupsOpen(false)}
                className="text-[11px] text-neutral-500 hover:text-neutral-200"
              >
                閉じる
              </button>
            </div>
            <BackupListBody
              result={presetBackups}
              emptyText="まだバックアップがありません（保存のたびに自動で作られます）。"
              onRetry={() => void openPresetBackups()}
              renderMeta={(b) => `${b.count} 件`}
              renderAction={(b) => (
                <button
                  type="button"
                  disabled={presetRestoring}
                  onClick={() => void restorePresetBackup(b.path)}
                  className={`${MUTED_BUTTON} h-7 px-2.5 text-[11px] disabled:opacity-40`}
                >
                  {presetRestoring ? "復元中…" : "これで復元"}
                </button>
              )}
            />
          </div>
        ) : null}
      </Field>

      {/*
        3Dシーンのバックアップから復元。
        scene3d.json も保存のたびに自動で世代バックアップされていた（最大10世代）のに、
        presets と同じく到達導線が無く、開発者しか戻せない状態だった。
        （2026-07-30 独立評価 H-2）
      */}
      <Field label="3Dシーンのバックアップ（消えたとき・戻したいとき）">
        <p className="mb-1.5 text-[11px] text-neutral-400">
          3Dシーンを編集のたびに自動でバックアップします。
        </p>
        <details className="mb-2 text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">復元について</summary>
          <p className="mt-1.5 leading-relaxed">
            シーンがおかしくなった・前へ戻したい場合に、過去の状態を選べます。
          </p>
        </details>
        <BackupHealthLine result={scene3dBackups} />
        <button
          type="button"
          disabled={scene3dRestoring}
          onClick={() => void openScene3dBackups()}
          className={`${MUTED_BUTTON} h-9 px-3 text-xs disabled:opacity-40`}
        >
          バックアップから復元…
        </button>

        {scene3dBackupsOpen && scene3dBackups ? (
          <div className="mt-2 max-h-60 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#0b0b0b] p-2">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <span className="text-[11px] font-bold text-neutral-300">
                復元する時点を選ぶ（新しい順）
              </span>
              <button
                type="button"
                onClick={() => setScene3dBackupsOpen(false)}
                className="text-[11px] text-neutral-500 hover:text-neutral-200"
              >
                閉じる
              </button>
            </div>
            <BackupListBody
              result={scene3dBackups}
              emptyText="まだバックアップがありません。3Dシーンを編集すると自動で作られます。"
              onRetry={() => void openScene3dBackups()}
              renderMeta={(b) => `${b.shots} カット`}
              renderAction={(b) => (
                <button
                  type="button"
                  disabled={scene3dRestoring}
                  onClick={() => void restoreScene3dBackup(b.path)}
                  className={`${MUTED_BUTTON} h-7 px-2.5 text-[11px] disabled:opacity-40`}
                >
                  {scene3dRestoring ? "復元中…" : "これで復元"}
                </button>
              )}
            />
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
      <StorageBreakdownSection />
    </Panel>
  );
}

const STORAGE_CATEGORY_ROWS: Array<{
  key: StorageCategoryKey;
  label: string;
  description: string;
}> = [
  {
    key: "sessions",
    label: "対話履歴",
    description:
      "消してOK。過去のAIとのやりとりを再開できなくなるだけで、作品・画像は消えません",
  },
  {
    key: "logs",
    label: "エンジンログ",
    description: "消してOK。不具合調査用の記録です",
  },
  {
    key: "webviewCache",
    label: "表示キャッシュ",
    description: "消してOK。次回表示が一瞬遅くなるだけです",
  },
  {
    key: "backups",
    label: "バックアップ世代",
    description: "直近の復元用です。容量が気になる場合だけ消してください",
  },
  {
    key: "brokenQuarantine",
    label: "退避データ（broken）",
    description: "壊れて自動退避したデータです。問題なく使えていれば消してOK",
  },
  {
    key: "appData",
    label: "実データ（参考）",
    description: "作品・画像・登録データ。ここからは消しません",
  },
];

const formatStorageBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
};

function StorageBreakdownSection() {
  const push = useToasts((s) => s.push);
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [selected, setSelected] = useState<StorageCleanupCategory[]>([]);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const refreshBreakdown = useCallback(async () => {
    setScanning(true);
    try {
      const next = await storageCleanup.breakdown();
      setBreakdown(next);
    } catch (err) {
      push({ kind: "error", text: `一時データの内訳を確認できません: ${String(err)}` });
    } finally {
      setScanning(false);
    }
  }, [push]);

  useEffect(() => {
    void refreshBreakdown();
  }, [refreshBreakdown]);

  const selectedTotal = selected.reduce(
    (total, category) => total + (breakdown?.[category].deletableBytes ?? 0),
    0,
  );

  const toggleCategory = (category: StorageCleanupCategory) => {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  };

  const runSelectedCleanup = async () => {
    if (!breakdown || selected.length === 0) return;
    const message =
      `選んだ一時データ ${formatStorageBytes(selectedTotal)} を削除します。\n\n` +
      "作品・画像・登録データは削除しません。\n" +
      "共通Codexのデータは対象外です。続けますか？";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "選んだものを削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;

    setCleaning(true);
    try {
      const report = await storageCleanup.cleanupCategories(selected);
      const summary = selected
        .map((category) => {
          const label = STORAGE_CATEGORY_ROWS.find((row) => row.key === category)?.label ?? category;
          return `${label} ${formatStorageBytes(report.freedBytesByCategory[category] ?? 0)}`;
        })
        .join(" / ");
      push({
        kind: "success",
        text: summary ? `削除しました: ${summary}` : "削除対象はありませんでした",
        ttlMs: 5200,
      });
      if (report.errors.length > 0) {
        push({
          kind: "warn",
          text: `一部を削除できませんでした（${report.errors.length}件）。内訳を再計算しました。`,
          ttlMs: 6200,
        });
      }
      setSelected([]);
      await refreshBreakdown();
    } catch (err) {
      push({ kind: "error", text: `選んだデータを削除できません: ${String(err)}` });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Field label="一時データの内訳">
      <div className="rounded-lg border border-[#303030] bg-[#151515] p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-neutral-200">消す種類を自分で選べます</p>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              対話履歴は、使用中の可能性がある直近24時間分を自動で残します。
            </p>
          </div>
          <button
            type="button"
            disabled={scanning || cleaning}
            onClick={() => void refreshBreakdown()}
            className={`${MUTED_BUTTON} flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-[11px] disabled:opacity-40`}
          >
            {scanning ? (
              <span
                aria-hidden="true"
                className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-500 border-t-white"
              />
            ) : null}
            {scanning ? "計算中…" : "内訳を再計算"}
          </button>
        </div>

        <div className="divide-y divide-[#2a2a2a] rounded-md border border-[#2a2a2a]">
          {STORAGE_CATEGORY_ROWS.map((row) => {
            const stats = breakdown?.[row.key];
            const cleanupCategory: StorageCleanupCategory | null =
              row.key === "appData" ? null : row.key;
            const checked = cleanupCategory ? selected.includes(cleanupCategory) : false;
            const shownBytes = cleanupCategory ? stats?.deletableBytes : stats?.bytes;
            const shownCount = cleanupCategory ? stats?.deletableCount : stats?.count;
            const protectedSessionBytes =
              row.key === "sessions" && stats
                ? Math.max(0, stats.bytes - stats.deletableBytes)
                : 0;
            return (
              <label
                key={row.key}
                className={`flex gap-3 px-3 py-2.5 ${
                  cleanupCategory ? "cursor-pointer hover:bg-white/[0.025]" : "cursor-not-allowed"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!cleanupCategory || scanning || cleaning || !breakdown}
                  onChange={() => cleanupCategory && toggleCategory(cleanupCategory)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-pink-500 disabled:opacity-40"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-bold text-neutral-200">{row.label}</span>
                    <span className="shrink-0 font-mono text-xs font-bold text-neutral-100">
                      {stats ? formatStorageBytes(shownBytes ?? 0) : scanning ? "計算中…" : "—"}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">
                    {row.description}
                  </span>
                  {stats ? (
                    <span className="mt-0.5 block text-[10px] text-neutral-600">
                      {shownCount ?? 0}件
                      {protectedSessionBytes > 0
                        ? ` ／ 直近24時間分 ${formatStorageBytes(protectedSessionBytes)} は保護中`
                        : ""}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          <div className="flex cursor-not-allowed gap-3 px-3 py-2.5">
            <input
              type="checkbox"
              checked={false}
              disabled
              readOnly
              className="mt-0.5 h-4 w-4 shrink-0 accent-pink-500 opacity-40"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-bold text-neutral-200">
                  共通Codexの領域（削除対象外）
                </span>
                <span className="shrink-0 font-mono text-xs font-bold text-neutral-100">
                  {breakdown
                    ? formatStorageBytes(
                        (
                          breakdown as StorageBreakdown & {
                            commonCodex?: StorageBreakdown["appData"];
                          }
                        ).commonCodex?.bytes ?? 0,
                      )
                    : scanning
                      ? "計算中…"
                      : "—"}
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">
                共通のCodex CLIが使う履歴・設定です。GORI GORI KUNからは削除しません
              </span>
            </span>
          </div>
        </div>

        {breakdown && breakdown.errors.length > 0 ? (
          <p className="mt-2 text-[10px] text-amber-300">
            読み取れない項目が {breakdown.errors.length} 件ありました。表示は確認できた範囲です。
          </p>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] text-neutral-500">選択した合計</p>
            <p className="font-mono text-sm font-bold text-white">
              {formatStorageBytes(selectedTotal)}
            </p>
          </div>
          <button
            type="button"
            disabled={selected.length === 0 || selectedTotal === 0 || scanning || cleaning}
            onClick={() => void runSelectedCleanup()}
            className={`${PRIMARY_BUTTON} h-9 px-4 text-xs disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {cleaning ? "削除中…" : "選んだものを削除"}
          </button>
        </div>
      </div>
    </Field>
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

/**
 * バックアップ健全性の1行表示（2026-08-06 / U4）。
 *
 * 「最終バックアップ: N時間前 / M世代」を出し、ユーザーが自分のデータが守られて
 * いるかを設定画面で確認できるようにする。**ゼロのときだけ目立たせる**
 * （守られている状態は静かでよい。一等地には出さない方針）。
 */
function BackupHealthLine({
  result,
}: {
  result: BackupListResult<{ at: number }> | null;
}) {
  // まだ開いていない（取得していない）ときは何も出さない。
  if (result === null) return null;
  const health = summarizeBackupHealth(result);
  if (health.failed) {
    return (
      <p className="mb-1.5 text-[11px] font-bold text-orange-300">
        バックアップの状態を確認できませんでした（保存先に接続できない可能性）。
      </p>
    );
  }
  if (health.generations === 0 || health.latestAt === null) {
    return (
      <p className="mb-1.5 text-[11px] font-bold text-orange-300">
        バックアップがまだ 0 件です。
      </p>
    );
  }
  return (
    <p className="mb-1.5 text-[11px] text-neutral-500">
      最終バックアップ: {formatRelativeAge(health.latestAt, Date.now())} ／{" "}
      {health.generations} 世代
    </p>
  );
}

/**
 * バックアップ一覧の中身（空 / 取得失敗 / 一覧）を出し分ける共通枠。
 *
 * **「まだありません」と「取得できませんでした」を必ず分ける**（U3 の要点）。
 * 前者は正常、後者は保存先に届いていない故障で、ユーザーが取るべき行動が違う。
 */
function BackupListBody<T extends { path: string; at: number }>({
  result,
  emptyText,
  onRetry,
  renderMeta,
  renderAction,
}: {
  result: BackupListResult<T>;
  emptyText: string;
  onRetry: () => void;
  renderMeta: (item: T) => React.ReactNode;
  renderAction: (item: T) => React.ReactNode;
}) {
  if (!result.ok) {
    return (
      <div className="px-1 py-1">
        <p className="text-[11px] font-bold text-orange-300">
          バックアップ一覧を取得できませんでした。
        </p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-neutral-400">
          保存先に接続できていない可能性があります（外付けドライブ・クラウド同期
          フォルダが未接続など）。保存先を確認してから、もう一度お試しください。
        </p>
        <p className="mt-0.5 break-all text-[10px] text-neutral-600">{result.error}</p>
        <button
          type="button"
          onClick={onRetry}
          className={`${MUTED_BUTTON} mt-1.5 h-7 px-2.5 text-[11px]`}
        >
          再試行
        </button>
      </div>
    );
  }
  if (result.items.length === 0) {
    return <p className="px-1 py-1 text-[11px] text-neutral-500">{emptyText}</p>;
  }
  return (
    <>
      <ul className="space-y-1">
        {result.items.map((b) => (
          <li
            key={b.path}
            className="flex items-center justify-between rounded-md bg-[#141414] px-2.5 py-1.5"
          >
            <span className="text-[12px] text-neutral-200">
              {new Date(b.at).toLocaleString("ja-JP")}{" "}
              <span className="text-neutral-500">— {renderMeta(b)}</span>
            </span>
            {renderAction(b)}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 px-1 text-[10px] text-neutral-500">
        復元しても、その直前の状態もバックアップされるので、間違えてもまた戻せます。
      </p>
    </>
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
