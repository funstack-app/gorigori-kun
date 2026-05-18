import { useEffect, useMemo, useState, type ReactNode } from "react";
import { auth, higgsfield, mcp, secrets, type McpServer, type SecretKey } from "../lib/ipc";
import { useAccounts, type SecretsState } from "../lib/store/accounts";
import { useToasts } from "../lib/store/toasts";

const PRIMARY_BUTTON = "rounded-md bg-pink-500 font-bold text-white hover:bg-pink-600";
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
      svc("▧", "Pexels", "完全無料、200 req/時、AI 参照用途 OK (推奨)", "pexels_api_key", "hasPexels", "https://www.pexels.com/api/new/", false),
      svc("U", "Unsplash", "無料、Demo 50 req/時、無料版は AI 参照 OK (Unsplash+ は NG)", "unsplash_access_key", "hasUnsplash", "https://unsplash.com/oauth/applications", false),
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
 * 対応予定リスト (Roadmap).
 *
 * 「実装まだ無いが今後 BYO 対応を検討しているサービス」を、
 * カードで読み物として並べる。キー入力ボタンは出さず、
 * 公式ページへのリンクのみで「契約検討の支援」に止める。
 *
 * 実装の進め方:
 *   - STΛCK がそのサブスク/キーを取得した時に、Worker 委譲で順次実装
 *   - 動作確認できないものは作らない (BYO の精神)
 *   - 実装したらこのリストから SERVICE_CATEGORIES に昇格
 */
type RoadmapService = {
  icon: string;
  name: string;
  description: string;
  badge: "サブスク内完結" | "API 課金" | "MCP";
  detailUrl: string;
};
const ROADMAP: { title: string; services: RoadmapService[] }[] = [
  {
    title: "AI 生成 (連携予定)",
    services: [
      { icon: "S", name: "Splash", description: "AI 動画/画像生成 (近日対応予定)", badge: "サブスク内完結", detailUrl: "https://splash.so/" },
    ],
  },
  {
    title: "サブスク内完結 (BYO 推奨)",
    services: [
      { icon: "K", name: "Krea AI", description: "40+ モデル (Flux/Imagen/Runway/Kling/Hailuo)、Web と API で同じ compute units を共有", badge: "サブスク内完結", detailUrl: "https://www.krea.ai/pricing" },
      { icon: "P", name: "Picsart GenAI", description: "130+ モデル (Sora/Veo/Kling/Flux/Recraft/ElevenLabs)、OAuth サブスクログイン", badge: "サブスク内完結", detailUrl: "https://picsart.com/genai-cli" },
      { icon: "A", name: "Adobe Firefly", description: "Creative Cloud に同梱の generative credits を画像/動画/音声で利用", badge: "サブスク内完結", detailUrl: "https://www.adobe.com/products/firefly.html" },
    ],
  },
  {
    title: "API 課金 (安く繋ぎたい人向け)",
    services: [
      { icon: "R", name: "Replicate", description: "100+ OSS モデル統一 API (FLUX/SDXL/Imagen 等)、$0.008〜$0.04/画像", badge: "API 課金", detailUrl: "https://replicate.com/pricing" },
      { icon: "F", name: "fal.ai", description: "高速版モデル特化 (FLUX/SD/動画)、リアルタイム生成向き", badge: "API 課金", detailUrl: "https://fal.ai/pricing" },
      { icon: "T", name: "Together AI", description: "最安級 API (FLUX/SDXL/SD 系)、$0.008/画像〜", badge: "API 課金", detailUrl: "https://www.together.ai/pricing" },
    ],
  },
  {
    title: "個別 API",
    services: [
      { icon: "O", name: "OpenAI Images API", description: "DALL-E 3 / GPT Image を API 直叩きで生成 (Codex CLI 不要、Free アカウントでも使える)", badge: "API 課金", detailUrl: "https://platform.openai.com/docs/api-reference/images" },
      { icon: "S", name: "Stability AI", description: "Stable Image / SD 3.5 系 API", badge: "API 課金", detailUrl: "https://platform.stability.ai/" },
      { icon: "G", name: "Google Gemini", description: "Imagen 4 / Gemini 系", badge: "API 課金", detailUrl: "https://ai.google.dev/" },
      { icon: "B", name: "Black Forest Labs", description: "FLUX 公式プロバイダ", badge: "API 課金", detailUrl: "https://api.bfl.ai/" },
      { icon: "I", name: "Ideogram", description: "文字入りデザインに強い画像生成", badge: "API 課金", detailUrl: "https://ideogram.ai/manage-api" },
      { icon: "R", name: "Recraft", description: "ブランド素材・ベクター向け", badge: "API 課金", detailUrl: "https://www.recraft.ai/" },
      { icon: "R", name: "Runway", description: "Gen-4 動画", badge: "API 課金", detailUrl: "https://runwayml.com/pricing" },
      { icon: "L", name: "Luma AI", description: "Dream Machine 動画", badge: "API 課金", detailUrl: "https://lumalabs.ai/dream-machine" },
      { icon: "P", name: "Pika", description: "Pika 2.x 動画", badge: "API 課金", detailUrl: "https://pika.art/" },
      { icon: "E", name: "ElevenLabs", description: "音声合成・ナレーション (将来実装予定)", badge: "API 課金", detailUrl: "https://elevenlabs.io/" },
      { icon: "M", name: "Magnific / Freepik", description: "高精細アップスケール", badge: "API 課金", detailUrl: "https://www.magnific.com/api" },
      { icon: "3D", name: "Tripo / Meshy", description: "画像→3D モデル", badge: "API 課金", detailUrl: "https://platform.tripo3d.ai/" },
    ],
  },
  {
    title: "MCP サーバー (経路定義後に実装)",
    services: [
      { icon: "M", name: "Notion / Figma / Drive 等", description: "MCP プリセットあり、画像制作との具体経路 (参照画像取得 等) を定義したら実装", badge: "MCP", detailUrl: "https://modelcontextprotocol.io/" },
    ],
  },
];

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
    if (!window.confirm(`${service.name} の API キーを OS Keychain から削除しますか？`)) return;
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
    if (!window.confirm(`MCP サーバー「${serverName}」を削除しますか？`)) return;
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
        対応予定 (Roadmap) セクション。
        実装まだ無いサービスを、「動かない接続ボタン」ではなく
        「読み物 + 公式ページへのリンク」として並べる。
        STΛCK が該当サブスクを取得した時点で順次実装、SERVICE_CATEGORIES へ昇格。
      */}
      <div className="space-y-4 pt-4">
        <div>
          <h3 className="text-sm font-semibold text-white">対応予定</h3>
          <p className="mt-1 text-[11px] text-neutral-500">
            今後 BYO 対応を検討しているサービス。動作確認ができないものは作らない方針なので、
            まずは公式ページで内容を確認できます。
          </p>
        </div>
        {ROADMAP.map((category) => (
          <div key={category.title} className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {category.title}
            </h4>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {category.services.map((service) => (
                <a
                  key={service.name}
                  href={service.detailUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col gap-1 rounded-lg border border-[#262626] bg-[#141414] p-3 transition hover:border-[#3a3a3a] hover:bg-[#1a1a1a]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#262626] bg-[#0d0d0d] text-xs font-semibold text-neutral-300">
                        {service.icon}
                      </span>
                      <span className="truncate text-xs font-semibold text-neutral-200">
                        {service.name}
                      </span>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                        service.badge === "サブスク内完結"
                          ? "bg-lime-300/15 text-lime-300"
                          : service.badge === "API 課金"
                            ? "bg-pink-500/15 text-pink-300"
                            : "bg-neutral-500/15 text-neutral-400"
                      }`}
                    >
                      {service.badge}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[10px] leading-snug text-neutral-500 group-hover:text-neutral-400">
                    {service.description}
                  </p>
                  <span className="mt-0.5 text-[10px] text-neutral-600 group-hover:text-neutral-300">
                    詳細を見る ↗
                  </span>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>

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
 * Higgsfield ワンタップ接続カード。
 * STΛCK の設計思想: MOST=GPT Image 2 すぐ動く、おまけ=拡張機能はワンタップで追加。
 *
 * 状態:
 *   - CLI 未インストール    → 接続不可、インストール案内
 *   - 未認証                → 「接続する」ボタン (一発で OAuth)
 *   - 認証済み              → 「接続済み」+ プラン/クレジット表示 + 解除ボタン
 *
 * 認証完了後は accounts.refreshHiggsfield() を呼んで生成タブの UI に伝播。
 */
function HiggsfieldConnectionCard() {
  const status = useAccounts((s) => s.higgsfield);
  const refresh = useAccounts((s) => s.refreshHiggsfield);
  const toast = useToasts.getState();
  const [busy, setBusy] = useState(false);

  const installed = status.installed;
  const authed = status.authenticated;
  const plan = status.plan;
  const credits = status.credits;

  const connect = async () => {
    setBusy(true);
    try {
      // higgsfield.login は CLI を `auth login` で叩いてブラウザを開く。
      // CLI 内部で stdout に device code / URL を吐くので、それを toast で
      // 軽く知らせて、ユーザーがブラウザでログイン完了したら次の refresh で
      // authenticated=true になる。
      await higgsfield.login();
      // 認証完了を確認 (CLI 側がブラウザ完了まで待ってから戻ってくる仕様)
      await refresh();
      toast.push({ kind: "success", text: "HiggsField に接続しました", ttlMs: 3000 });
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
      await higgsfield.logout();
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

  // v0.6.19: Higgsfield 拡張パック方式に切り替え。
  // 別配布の拡張パック dmg をユーザーがインストールすると、Rust 側の
  // resolve_higgsfield_binary が
  //   ~/Library/Application Support/app.codexframefactory/extensions/higgsfield/
  // を検出して動く設計。未インストール時は CLI 未検出として案内表示。

  return (
    <div className="space-y-3 rounded-xl border border-pink-400/30 bg-pink-500/5 p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-md border border-pink-400/20 bg-[#101010] text-xs font-black text-pink-200">HF</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-black text-pink-100">HiggsField</p>
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

      {authed && (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[11px]">
          <div>
            <p className="text-neutral-500">プラン</p>
            <p className="font-bold text-neutral-200">{plan ?? "—"}</p>
          </div>
          <div>
            <p className="text-neutral-500">クレジット</p>
            <p className="font-bold text-neutral-200">
              {credits !== undefined ? credits.toLocaleString() : "—"}
            </p>
          </div>
        </div>
      )}

      {!installed ? (
        <div className="space-y-2">
          <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5 text-[11px] text-yellow-200">
            HiggsField 拡張パックがまだ入っていません。
            <br />
            下記からDL → インストール → GORI GORI を再起動 で繋がります。
          </p>
          <a
            href="https://github.com/shoutayamazaki0811/gorigori-kun/releases/latest"
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg bg-pink-500 px-3 py-2 text-center text-xs font-black text-white transition hover:bg-pink-400"
          >
            ⬇ 拡張パックをダウンロード
          </a>
          <a
            href="https://higgsfield.ai/"
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-center text-[11px] font-bold text-neutral-200 hover:border-pink-400 hover:text-white"
          >
            HiggsField の使い方を見る ↗
          </a>
        </div>
      ) : !authed ? (
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="h-9 w-full rounded-lg bg-pink-500 px-3 text-xs font-black text-white transition hover:bg-pink-400 disabled:opacity-60"
        >
          {busy ? "接続中…" : "接続する (ワンタップ)"}
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
