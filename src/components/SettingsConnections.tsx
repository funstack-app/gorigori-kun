import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  auth,
  higgsfieldMcp,
  magnific,
  mcp,
  remoteMcp,
  secrets,
  type MagnificAccount,
  type McpServer,
  type SecretKey,
} from "../lib/ipc";
import {
  REMOTE_MCP_PROVIDERS,
  type RemoteMcpProviderCatalogEntry,
} from "../lib/remoteMcpProviders";
import { useAccounts, type SecretsState } from "../lib/store/accounts";
import { useToasts } from "../lib/store/toasts";
import { ProviderIcon } from "./ProviderIcon";

const PRIMARY_BUTTON = "rounded-md bg-pink-500 font-bold text-white hover:bg-pink-600";
/**
 * 接続カードの共通コンテナ (2026-08-22 STΛCK指定)。
 * カード本体は他のカードと同じ黒。ピンクはボタンのみ。min-h と justify-between で
 * テキスト量が違ってもボタンの縦位置が全カードで揃う。
 */
const PROVIDER_CARD =
  "flex min-h-36 flex-col justify-between gap-3 rounded-xl border border-[#2a2a2a] bg-[#151515] p-3";
const MUTED_BUTTON =
  "rounded-md border border-[#343434] bg-[#1e1e1e] font-bold text-neutral-300 hover:border-[#555] hover:text-white";

type SecretService = {
  icon: string; name: string; description: string; keyName?: SecretKey;
  secretField?: keyof SecretsState; signupUrl?: string; comingSoon?: boolean;
};
type ServiceCategory = { title: string; services: SecretService[] };

const svc = (
  icon: string,
  name: string,
  description: string,
  keyName: SecretKey,
  secretField: keyof SecretsState,
  signupUrl: string,
  comingSoon = true,
): SecretService => ({ icon, name, description, keyName, secretField, signupUrl, comingSoon });

/*
 * 接続先カタログ (整理後).
 * 「Coming soon」だけ並べる詐欺っぽさを避けるため、
 * **実際に GORI GORI KUN から使えるサービスだけ**を残す。
 *
 * 削除した行の実装は git 履歴に残っているので、将来実生成経路を
 * 実装したら順次このリストに復活させる方針:
 *   - Replicate / fal.ai / Stability / Google Gemini / Black Forest Labs /
 *     Ideogram / Recraft  (画像生成)
 *   - Runway / Luma AI / Pika  (動画生成)
 *   - ElevenLabs  (音声 — 将来追加予定、STΛCK 確認済み)
 *   - Magnific  (アップスケール)
 *   - Tripo / Meshy  (3D)
 *   - MCP プリセット (Notion / GitHub / Slack / Linear / Figma / Drive 等)
 *     → 画像制作 OS としての具体的な経路 (Figma 参照画像取得 等) が定義
 *       されてから復活させる
 */
const SERVICE_CATEGORIES: ServiceCategory[] = [
  {
    title: "素材",
    services: [
      svc("▧", "Pexels", "規約の範囲で無料／商用可／改変可。合成・背景・シーン素材向け。単体再配布・素材集化・AI/ML 用収集は禁止 (200 req/時)", "pexels_api_key", "hasPexels", "https://www.pexels.com/api/new/", false),
      // Unsplash は法務対応 (2026-05-21) でカタログから撤去。
      //   理由: Unsplash API Guidelines は (1) アプリ内表示時に写真家・Unsplash
      //   への attribution を必須としており、(2) ユーザーに developer account
      //   登録を要求するアプリ設計 (BYO API キー) を推奨していない。
      //   ゴリゴリくんの BYO 方針と Unsplash 規約が衝突するため、
      //   素材ソースとしては Pexels のみに絞る。
    ],
  },
];

// (旧 LINKED_AI_SERVICES は HiggsfieldConnectionCard に内包したので削除)
/*
 * OpenAI API カードは UI から再度撤去 (今は Roadmap 行き)。
 * STΛCK は Codex サブスクログインで完結する利用形態なので、画像生成
 * カテゴリに OpenAI カードがあると混乱の元。
 *
 * ただし saveSecret 内の「openai_api_key 保存時に auth.loginApiKey も
 * 自動実行」ロジックはそのまま残す。将来カードを復活させた時に動く設計。
 * 配布フェーズで Codex を触れないユーザー向けに使う。
 */

/*
 * Roadmap セクションは UI から撤去 (STΛCK 指示 2026-07-28)。
 * 未実装サービスのカードを並べる読み物枠は削除し、接続先ページは
 * 「実際に GORI GORI KUN から使えるサービスだけ」を表示する。
 * 将来 BYO 対応を実装したら SERVICE_CATEGORIES に追加する。
 */

type McpPreset = {
  name: string; label: string; command: string; args: string[];
  envHint?: string; comingSoon?: boolean;
};

const MCP_PRESETS: McpPreset[] = [
  { name: "notion", label: "Notion", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], envHint: "NOTION_TOKEN" },
  { name: "github", label: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envHint: "GITHUB_TOKEN" },
  { name: "slack", label: "Slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], envHint: "SLACK_BOT_TOKEN" },
  { name: "gdrive", label: "Google Drive", command: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"] },
  { name: "linear", label: "Linear", command: "npx", args: ["-y", "mcp-linear"], envHint: "LINEAR_API_KEY" },
  { name: "figma", label: "Figma", command: "npx", args: ["-y", "figma-developer-mcp"], envHint: "FIGMA_TOKEN" },
  { name: "canva", label: "Canva", command: "", args: [], comingSoon: true },
];

const SECRET_SERVICES = SERVICE_CATEGORIES.flatMap((category) =>
  category.services.filter((service): service is SecretService & { keyName: SecretKey } => Boolean(service.keyName)),
);

function maskSecret(value: string | null | undefined) {
  if (!value) return "";
  const suffix = value.slice(-4);
  const prefix = value.startsWith("sk-ant-") ? "sk-ant-" : value.startsWith("sk-") ? "sk-" : "";
  return `${prefix}•••••...••${suffix}`;
}

function parseArgs(value: string) {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export function SettingsConnections() {
  const accounts = useAccounts();
  const push = useToasts((s) => s.push);
  const [masks, setMasks] = useState<Partial<Record<SecretKey, string>>>({});
  const [selectedService, setSelectedService] = useState<SecretService | null>(null);
  const [secretDraft, setSecretDraft] = useState("");
  const [presetDraft, setPresetDraft] = useState<McpPreset | null>(null);
  const [presetEnvValue, setPresetEnvValue] = useState("");
  const [customMcp, setCustomMcp] = useState({ name: "", command: "", args: "", envKey: "", envValue: "" });
  const envSummaries = useMemo(
    () => accounts.mcp.map((server) => ({ name: server.name, keys: Object.keys(server.env).sort() })),
    [accounts.mcp],
  );

  useEffect(() => {
    void loadMasks();
  }, []);

  const loadMasks = async () => {
    const values = await Promise.all(SECRET_SERVICES.map((service) => secrets.get(service.keyName)));
    const next: Partial<Record<SecretKey, string>> = {};
    SECRET_SERVICES.forEach((service, index) => {
      next[service.keyName] = maskSecret(values[index]);
    });
    setMasks(next);
    await accounts.refreshSecrets();
  };

  const saveSecret = async () => {
    const key = selectedService?.keyName;
    const value = secretDraft.trim();
    if (!key || !value) return;
    await secrets.set(key, value);
    setMasks((prev) => ({ ...prev, [key]: maskSecret(value) }));
    accounts.setSecretPresence(key, true);
    setSecretDraft("");
    setSelectedService(null);
    push({ kind: "success", text: "API キーを OS Keychain に保存しました", ttlMs: 2400 });

    // OpenAI キーは保存だけでなく、Codex CLI に流して認証を完了させる。
    // ユーザーは「キー貼って接続ボタン押す」だけ、裏側で codex login --with-api-key
    // 相当の処理が走り、画像生成パイプ (Codex 経由 GPT Image 2 等) が即動く状態に。
    // STΛCK 指示「UI 上の接続を押すと裏側で Codex が実際に使えるまで設定し続ける」を実現。
    if (key === "openai_api_key") {
      try {
        await auth.loginApiKey(value);
        push({
          kind: "success",
          text: "Codex を OpenAI API キーで初期化しました。GPT Image 2 等が使えます",
          ttlMs: 3400,
        });
      } catch (err) {
        push({
          kind: "error",
          text: `Codex 初期化に失敗しました: ${String(err)}`,
          ttlMs: 5000,
        });
      }
    }
  };

  const deleteSecret = async (service: SecretService) => {
    if (!service.keyName) return;
    const message = `${service.name} の API キーを OS Keychain から削除しますか？`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "API キーの削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    await secrets.delete(service.keyName);
    setMasks((prev) => ({ ...prev, [service.keyName as SecretKey]: "" }));
    accounts.setSecretPresence(service.keyName, false);
    push({ kind: "success", text: "API キーを削除しました", ttlMs: 2000 });
  };

  const upsertMcp = async (server: McpServer) => {
    await mcp.upsert(server);
    await accounts.refreshMcp();
    push({ kind: "success", text: "MCP サーバーを追加 / 更新しました", ttlMs: 2200 });
  };

  const selectPreset = async (preset: McpPreset) => {
    if (preset.comingSoon) return;
    if (preset.envHint) {
      setPresetDraft(preset);
      setPresetEnvValue("");
      return;
    }
    await upsertMcp({ name: preset.name, command: preset.command, args: preset.args, env: {} });
  };

  const savePreset = async () => {
    if (!presetDraft || !presetDraft.envHint) return;
    const value = presetEnvValue.trim();
    if (!value) {
      push({ kind: "error", text: `${presetDraft.envHint} を入力してください`, ttlMs: 2400 });
      return;
    }
    await upsertMcp({
      name: presetDraft.name,
      command: presetDraft.command,
      args: presetDraft.args,
      env: { [presetDraft.envHint]: value },
    });
    setPresetEnvValue("");
    setPresetDraft(null);
  };

  const saveCustomMcp = async () => {
    const env =
      customMcp.envKey.trim() && customMcp.envValue.trim()
        ? { [customMcp.envKey.trim()]: customMcp.envValue.trim() }
        : {};
    await upsertMcp({
      name: customMcp.name.trim(),
      command: customMcp.command.trim(),
      args: parseArgs(customMcp.args),
      env,
    });
    setCustomMcp({ name: "", command: "", args: "", envKey: "", envValue: "" });
  };

  const removeMcp = async (serverName: string) => {
    const message = `MCP サーバー「${serverName}」を削除しますか？`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "MCP サーバーの削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    await mcp.delete(serverName);
    await accounts.refreshMcp();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h2 className="text-lg font-black text-white">接続先</h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          自分の API キーや MCP サーバーを接続して、GORI GORI KUN から使えるサービスを増やせます。
          キー本体は localStorage に保存せず、OS Keychain にだけ保存します。
        </p>
      </header>

      {/*
        AI 生成サービス (OAuth ベース)
        実際の接続管理は「アカウント」タブで行う。ここでは存在を明示する。
      */}
      <ConnectionSection title="AI 生成">
        <HiggsfieldConnectionCard />
        <MagnificConnectionCard />
        {REMOTE_MCP_PROVIDERS.map((provider) => (
          <RemoteMcpConnectionCard key={provider.id} provider={provider} />
        ))}
      </ConnectionSection>

      {SERVICE_CATEGORIES.map((category) => (
        <ConnectionSection key={category.title} title={category.title}>
          {category.services.map((service) => {
            const connected = service.secretField ? accounts.secrets[service.secretField] : false;
            return (
              <ConnectionCard
                key={service.name}
                service={service}
                connected={connected}
                mask={service.keyName ? masks[service.keyName] : ""}
                onSaveKey={async (value) => {
                  const key = service.keyName;
                  if (!key) return;
                  await secrets.set(key, value);
                  setMasks((prev) => ({ ...prev, [key]: maskSecret(value) }));
                  accounts.setSecretPresence(key, true);
                  push({ kind: "success", text: `${service.name} のキーを保存しました`, ttlMs: 2400 });
                  // OpenAI キーは Codex 認証も自動実行
                  if (key === "openai_api_key") {
                    try {
                      await auth.loginApiKey(value);
                      push({
                        kind: "success",
                        text: "Codex を OpenAI API キーで初期化しました",
                        ttlMs: 4000,
                      });
                    } catch (err) {
                      push({
                        kind: "warn",
                        text: `キーは保存しましたが Codex 初期化失敗: ${String(err)}`,
                        ttlMs: 6000,
                      });
                    }
                  }
                  await accounts.refreshSecrets();
                }}
                onDelete={() => void deleteSecret(service)}
              />
            );
          })}
        </ConnectionSection>
      ))}

      {/*
        MCP セクションは UI から非表示化。
        画像制作 OS としての具体的な経路 (Figma 参照画像取得、Drive 素材入出力 等)
        が定義されてから復活させる方針。実装コード (mcp.rs / MCP_PRESETS /
        McpPresetCard / McpServerList / CustomMcpForm) は将来用に保持。
        TypeScript の未使用 warning を抑えるための ref:
      */}
      {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
      {(false as boolean) && (
        <>
          {MCP_PRESETS.length}
          {saveCustomMcp.name}
          {removeMcp.name}
          {selectPreset.name}
          {envSummaries.length}
          {McpPresetCard.name}
          {McpServerList.name}
          {CustomMcpForm.name}
        </>
      )}

      {selectedService && (
        <Modal title={`${selectedService.name} のキーを設定`} onClose={() => { setSelectedService(null); setSecretDraft(""); }}>
          <p className="text-xs text-neutral-500">
            保存先: <span className="font-mono text-neutral-300">{selectedService.keyName}</span>
          </p>
          <input
            type="password"
            value={secretDraft}
            onChange={(e) => setSecretDraft(e.target.value)}
            placeholder="API key"
            className="mt-3 h-10 w-full rounded-md border border-[#343434] bg-[#101010] px-3 font-mono text-xs text-neutral-100 outline-none focus:border-pink-500"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => { setSelectedService(null); setSecretDraft(""); }} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
              キャンセル
            </button>
            <button type="button" onClick={() => void saveSecret()} className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}>
              保存
            </button>
          </div>
        </Modal>
      )}

      {presetDraft && (
        <Modal title={`${presetDraft.label} MCP を追加`} onClose={() => { setPresetDraft(null); setPresetEnvValue(""); }}>
          <p className="text-xs text-neutral-500">
            env: <span className="font-mono text-neutral-300">{presetDraft.envHint}</span> (値は一覧に表示しません)
          </p>
          <input
            type="password"
            value={presetEnvValue}
            onChange={(e) => setPresetEnvValue(e.target.value)}
            placeholder={presetDraft.envHint}
            className="mt-3 h-10 w-full rounded-md border border-[#343434] bg-[#101010] px-3 font-mono text-xs text-neutral-100 outline-none focus:border-pink-500"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => { setPresetDraft(null); setPresetEnvValue(""); }} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
              キャンセル
            </button>
            <button type="button" onClick={() => void savePreset()} className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}>
              追加 / 更新
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ConnectionSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-black text-white">{title}</h3>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

function ConnectionCard(props: {
  service: SecretService;
  connected: boolean;
  mask?: string;
  /** インラインで API キーを入力して保存 */
  onSaveKey: (key: string) => Promise<void>;
  onDelete: () => void;
}) {
  const { service, connected } = props;
  const [expanded, setExpanded] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!keyDraft.trim() || saving) return;
    setSaving(true);
    try {
      await props.onSaveKey(keyDraft.trim());
      setKeyDraft("");
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="flex min-h-44 flex-col justify-between rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#242424] text-lg font-black text-white">{service.icon}</span>
            <div className="min-w-0">
              <h4 className="truncate text-sm font-black text-white">{service.name}</h4>
              <p className="mt-1 text-[11px] font-bold text-neutral-500">{connected ? "接続済み" : "未接続"}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {connected && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-300">接続済み</span>}
            {service.comingSoon && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-300">Coming soon</span>}
          </div>
        </div>
        <p className="mt-3 min-h-9 text-xs leading-relaxed text-neutral-400">{service.description}</p>
        <p className="mt-2 h-4 font-mono text-[11px] text-neutral-600">{props.mask || ""}</p>

        {/* インライン API キー入力 (展開時のみ表示) */}
        {expanded && service.keyName && (
          <div className="mt-3 space-y-2 rounded-md border border-[#343434] bg-[#0d0d0d] p-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setExpanded(false);
              }}
              placeholder="API キーを貼り付け"
              autoFocus
              className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 font-mono text-[11px] text-neutral-100 outline-none focus:border-pink-500"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="h-7 rounded-md px-2 text-[11px] font-bold text-neutral-400 hover:text-neutral-200"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!keyDraft.trim() || saving}
                className={`${PRIMARY_BUTTON} h-7 px-3 text-[11px] disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {service.signupUrl && (
          <a href={service.signupUrl} target="_blank" rel="noreferrer" className={`${MUTED_BUTTON} inline-flex h-8 items-center px-3 text-xs`}>
            キー取得
          </a>
        )}
        {service.keyName ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`${connected ? MUTED_BUTTON : PRIMARY_BUTTON} h-8 px-3 text-xs`}
            >
              {expanded ? "閉じる" : connected ? "再設定" : "キーを入力"}
            </button>
            {connected && (
              <button type="button" onClick={props.onDelete} className={`${MUTED_BUTTON} h-8 px-3 text-xs`}>
                削除
              </button>
            )}
          </>
        ) : (
          <button type="button" disabled className="h-8 rounded-md border border-[#2a2a2a] px-3 text-xs font-bold text-neutral-600">
            準備中
          </button>
        )}
      </div>
    </article>
  );
}

function McpPresetCard({ preset, connected, onAdd }: { preset: McpPreset; connected: boolean; onAdd: () => void }) {
  return (
    <article className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-black text-white">{preset.label}</h4>
          <p className="mt-1 font-mono text-[11px] text-neutral-500">{preset.command || "template pending"} {preset.args.join(" ")}</p>
          {preset.envHint && <p className="mt-1 text-[11px] text-neutral-600">env: {preset.envHint}</p>}
        </div>
        {connected && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-300">登録済み</span>}
        {preset.comingSoon && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-300">Coming soon</span>}
      </div>
      <button type="button" onClick={onAdd} disabled={preset.comingSoon} className={`${preset.comingSoon ? "border-[#2a2a2a] text-neutral-600" : connected ? MUTED_BUTTON : PRIMARY_BUTTON} mt-4 h-8 rounded-md px-3 text-xs font-bold`}>
        {connected ? "再設定" : "追加"}
      </button>
    </article>
  );
}

function McpServerList(props: {
  servers: McpServer[];
  envSummaries: Array<{ name: string; keys: string[] }>;
  onRemove: (name: string) => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      {props.servers.length === 0 ? (
        <p className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4 text-xs text-neutral-500">
          ~/.codex/config.toml に MCP サーバーは登録されていません。
        </p>
      ) : (
        props.servers.map((server) => {
          const summary = props.envSummaries.find((item) => item.name === server.name);
          return (
            <div key={server.name} className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#151515] p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-white">{server.name}</p>
                <p className="truncate font-mono text-xs text-neutral-500">{server.command} {server.args.join(" ")}</p>
                {summary && summary.keys.length > 0 && (
                  <p className="mt-1 text-[11px] text-neutral-600">env: {summary.keys.join(", ")} (値は非表示)</p>
                )}
              </div>
              <button type="button" onClick={() => void props.onRemove(server.name)} className={`${MUTED_BUTTON} h-8 px-3 text-xs`}>
                削除
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

function CustomMcpForm(props: {
  value: { name: string; command: string; args: string; envKey: string; envValue: string };
  onChange: (value: { name: string; command: string; args: string; envKey: string; envValue: string }) => void;
  onSave: () => void;
}) {
  const update = (key: keyof typeof props.value, value: string) => props.onChange({ ...props.value, [key]: value });
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
      <h4 className="text-sm font-black text-white">カスタム MCP</h4>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <TextInput label="name" value={props.value.name} onChange={(v) => update("name", v)} placeholder="github" />
        <TextInput label="command" value={props.value.command} onChange={(v) => update("command", v)} placeholder="npx" mono />
      </div>
      <TextInput label="args" value={props.value.args} onChange={(v) => update("args", v)} placeholder="-y @modelcontextprotocol/server-github" mono />
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <TextInput label="env key" value={props.value.envKey} onChange={(v) => update("envKey", v)} placeholder="GITHUB_TOKEN" mono />
        <PasswordInput label="env value" value={props.value.envValue} onChange={(v) => update("envValue", v)} placeholder="値は一覧に表示しません" />
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={props.onSave} className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}>
          追加 / 更新
        </button>
      </div>
    </div>
  );
}

function TextInput(props: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label className="mt-3 block space-y-1">
      <span className="text-xs font-medium text-neutral-300">{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        className={`h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-500 ${props.mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function PasswordInput(props: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="mt-3 block space-y-1">
      <span className="text-xs font-medium text-neutral-300">{props.label}</span>
      <input
        type="password"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 font-mono text-xs text-neutral-100 outline-none focus:border-pink-500"
      />
    </label>
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4">
      <section className="w-full max-w-md rounded-lg border border-[#343434] bg-[#151515] p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-black text-white">{title}</h3>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-md text-lg leading-none text-neutral-400 hover:bg-[#242424] hover:text-white">
            ×
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </section>
    </div>
  );
}

/**
 * Higgsfield 接続カード (2026-06-10 段階7: MCP方式へ作り直し)。
 * 旧CLI同梱(拡張パックDL+installed概念)を廃止し、Magnific と同型の
 * リモートMCP(mcp.higgsfield.ai, OAuth)接続に統一。
 * 接続ボタン1つで codex mcp add → ブラウザOAuth → 接続済み。
 * installed/拡張パック導入は無くなり、authenticated だけで接続済み/未接続を切替。
 * 未接続でもコア(gpt-image-2)には一切影響しない。
 */
function HiggsfieldConnectionCard() {
  const status = useAccounts((s) => s.higgsfield);
  const refresh = useAccounts((s) => s.refreshHiggsfield);
  const toast = useToasts.getState();
  const [busy, setBusy] = useState(false);

  const authed = status.authenticated;

  const connect = async () => {
    setBusy(true);
    try {
      // higgsfieldMcp.login は codex mcp add → login を叩き、OAuth をブラウザで開く。
      // login コマンドの成功 = OAuth 完了ではないため、refresh 後に実際の
      // authenticated を確認してからトーストを出し分ける（成功を装わない）。
      await higgsfieldMcp.login();
      await refresh();
      const connected = useAccounts.getState().higgsfield.authenticated;
      if (connected) {
        toast.push({ kind: "success", text: "HiggsField に接続しました", ttlMs: 3000 });
      } else {
        toast.push({
          kind: "info",
          text: "ブラウザで HiggsField のログインを完了してから、もう一度「接続する」を押してください。",
          ttlMs: 7000,
        });
      }
    } catch (err) {
      toast.push({
        kind: "error",
        text: `HiggsField 接続に失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await higgsfieldMcp.logout();
      await refresh();
      toast.push({ kind: "success", text: "HiggsField の接続を解除しました", ttlMs: 3000 });
    } catch (err) {
      toast.push({
        kind: "error",
        text: `HiggsField 接続解除に失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PROVIDER_CARD}>
      <div className="flex items-center gap-2">
        <ProviderIcon id="higgsfield" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-black text-white">HiggsField</p>
            {authed && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-200">
                接続済み
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            動画・画像 AI 生成 (Soul / Mix / Speak / Sketch / Edit 等)
          </p>
        </div>
      </div>

      {!authed ? (
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="h-9 w-full rounded-lg bg-pink-500 px-3 text-xs font-black text-white transition hover:bg-pink-400 disabled:opacity-60"
        >
          {busy ? "接続中…" : "接続する (ブラウザでログイン)"}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={disconnect}
          className="h-9 w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 text-xs font-bold text-neutral-300 transition hover:border-rose-400 hover:text-rose-300 disabled:opacity-60"
        >
          {busy ? "解除中…" : "接続を解除"}
        </button>
      )}
    </div>
  );
}

/**
 * Magnific オプショナル拡張の接続カード (2026-06-08)。
 * Higgsfield と違い MCP(mcp.magnific.com, OAuth) なので拡張パックDL不要。
 * 接続ボタン1つで codex mcp add → ブラウザOAuth → 接続済み。
 * 未接続なら「接続する」だけ表示し、コア(gpt-image-2)には一切影響しない。
 */
function MagnificConnectionCard() {
  const status = useAccounts((s) => s.magnific);
  const refresh = useAccounts((s) => s.refreshMagnific);
  const toast = useToasts.getState();
  const [busy, setBusy] = useState(false);
  // account_balance 由来の残高表示 (接続済みのときだけ取得)。取得失敗しても
  // カード自体は degrade させない (残高ピルが出ないだけ)。
  const [account, setAccount] = useState<MagnificAccount | null>(null);
  // 残高取得の失敗理由。console.error に握りつぶすと「0クレジット」と
  // 「取得できなかった」がユーザーから区別できないため UI に出す。
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  // 「再試行」ボタンで再取得するためのトリガ。
  const [accountReloadKey, setAccountReloadKey] = useState(0);

  const authed = status.authenticated;

  useEffect(() => {
    let cancelled = false;
    if (!authed) {
      setAccount(null);
      setAccountError(null);
      setAccountLoading(false);
      return;
    }
    setAccountLoading(true);
    magnific
      .account()
      .then((acc) => {
        if (cancelled) return;
        setAccount(acc);
        setAccountError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail = String(err);
        console.error("[MagnificConnectionCard] account fetch failed:", err);
        setAccount(null);
        setAccountError(detail);
        // エラーログセンターに乗せる (kind: "error" は ttl 0 で残る)。
        useToasts.getState().push({
          kind: "error",
          text: `Magnific クレジット残高を取得できませんでした: ${detail}`,
        });
      })
      .finally(() => {
        if (!cancelled) setAccountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authed, accountReloadKey]);

  const connect = async () => {
    setBusy(true);
    try {
      // magnific.login は codex mcp add → login を叩き、OAuth をブラウザで開く。
      // login コマンドの成功 = OAuth 完了ではないため、refresh 後に実際の
      // authenticated を確認してからトーストを出し分ける（成功を装わない）。
      await magnific.login();
      await refresh();
      const connected = useAccounts.getState().magnific.authenticated;
      if (connected) {
        toast.push({ kind: "success", text: "Magnific に接続しました", ttlMs: 3000 });
      } else {
        toast.push({
          kind: "info",
          text: "ブラウザで Magnific のログインを完了してから、もう一度「接続する」を押してください。",
          ttlMs: 7000,
        });
      }
    } catch (err) {
      toast.push({ kind: "error", text: `Magnific 接続に失敗: ${String(err)}`, ttlMs: 6000 });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await magnific.logout();
      await refresh();
      toast.push({ kind: "success", text: "Magnific の接続を解除しました", ttlMs: 3000 });
    } catch (err) {
      toast.push({ kind: "error", text: `Magnific 接続解除に失敗: ${String(err)}`, ttlMs: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PROVIDER_CARD}>
      <div className="flex items-center gap-2">
        <ProviderIcon id="magnific" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-black text-white">Magnific</p>
            {authed && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-200">
                接続済み
              </span>
            )}
            {authed && account && (
              <span className="rounded-full bg-pink-500/15 px-2 py-0.5 text-[10px] font-black text-pink-200">
                {account.unlimited
                  ? `${account.plan ?? "Unlimited"} (無制限)`
                  : `${Math.floor(account.credits).toLocaleString()} クレジット`}
              </span>
            )}
            {authed && !account && accountLoading && (
              <span className="rounded-full bg-neutral-500/15 px-2 py-0.5 text-[10px] font-black text-neutral-300">
                クレジット確認中…
              </span>
            )}
            {authed && !account && !accountLoading && accountError && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-200">
                <span title={accountError}>クレジットを取得できませんでした</span>
                <button
                  type="button"
                  onClick={() => setAccountReloadKey((n) => n + 1)}
                  className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-black text-amber-100 transition hover:bg-amber-400/40"
                >
                  再試行
                </button>
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            画像・動画 AI 生成 + 高精細アップスケール (無制限モデル対応)
          </p>
        </div>
      </div>

      {!authed ? (
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="h-9 w-full rounded-lg bg-pink-500 px-3 text-xs font-black text-white transition hover:bg-pink-400 disabled:opacity-60"
        >
          {busy ? "接続中…" : "接続する (ブラウザでログイン)"}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={disconnect}
          className="h-9 w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 text-xs font-bold text-neutral-300 transition hover:border-rose-400 hover:text-rose-300 disabled:opacity-60"
        >
          {busy ? "解除中…" : "接続を解除"}
        </button>
      )}
    </div>
  );
}

/** 段階1の汎用リモート MCP 接続カード。専用生成 UI にはまだ配線しない。 */
function RemoteMcpConnectionCard({
  provider,
}: {
  provider: RemoteMcpProviderCatalogEntry;
}) {
  const status = useAccounts((state) => state.remoteMcp[provider.id]);
  const refresh = useAccounts((state) => state.refreshRemoteMcp);
  const toast = useToasts.getState();
  const [busy, setBusy] = useState(false);

  const authed = status?.authenticated ?? false;

  const connect = async () => {
    setBusy(true);
    try {
      await remoteMcp.login(provider.id);
      await refresh();
      const connected =
        useAccounts.getState().remoteMcp[provider.id]?.authenticated ?? false;
      if (connected) {
        toast.push({
          kind: "success",
          text: `${provider.label} に接続しました`,
          ttlMs: 3000,
        });
      } else {
        toast.push({
          kind: "info",
          text: "ブラウザでログインを完了してから、もう一度接続を押してください。",
          ttlMs: 7000,
        });
      }
    } catch (error) {
      toast.push({
        kind: "error",
        text: `${provider.label} 接続に失敗: ${String(error)}`,
        ttlMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await remoteMcp.logout(provider.id);
      await refresh();
      const refreshedStatus = useAccounts.getState().remoteMcp[provider.id];
      const disconnected =
        refreshedStatus != null &&
        !refreshedStatus.registered &&
        !refreshedStatus.authenticated;
      if (disconnected) {
        toast.push({
          kind: "success",
          text: `${provider.label} の接続を解除しました`,
          ttlMs: 3000,
        });
      } else {
        toast.push({
          kind: "warn",
          text: "解除を確認できませんでした。もう一度お試しください",
          ttlMs: 6000,
        });
      }
    } catch (error) {
      toast.push({
        kind: "error",
        text: `${provider.label} 接続解除に失敗: ${String(error)}`,
        ttlMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PROVIDER_CARD}>
      <div className="flex items-start gap-2">
        <ProviderIcon id={provider.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-black text-white">{provider.label}</p>
            {authed && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-200">
                接続済み
              </span>
            )}
            {provider.note && (
              <span className="rounded-full bg-neutral-500/15 px-2 py-0.5 text-[10px] font-black text-neutral-400">
                {provider.note}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            {provider.capabilities}
          </p>
        </div>
      </div>

      {!authed ? (
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="h-9 w-full rounded-lg bg-pink-500 px-3 text-xs font-black text-white transition hover:bg-pink-400 disabled:opacity-60"
        >
          {busy ? "接続中…" : "接続する (ブラウザでログイン)"}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={disconnect}
          className="h-9 w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 text-xs font-bold text-neutral-300 transition hover:border-rose-400 hover:text-rose-300 disabled:opacity-60"
        >
          {busy ? "解除中…" : "接続を解除"}
        </button>
      )}
    </div>
  );
}
