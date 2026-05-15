/**
 * Higgsfield プラン × モデルラベル table。
 *
 * 公式 UI (higgsfield.ai のモデル選択ピッカー) を直接観察して構築 (2026-05 時点)。
 * - "UNLIMITED": そのプランで無制限利用可
 * - "EXCLUSIVE": そのプランでのみ使える特別モデル (年契約縛り含む)
 * - キー: subscription_plan_type (lowercase)、未知のプランはラベルなし
 *
 * 重要: ラベル付きで居ないモデルは「クレジット消費する通常扱い」。
 * 過去 commit b4a8c19 では "creator は全画像モデル無制限" と推測したが、
 * 公式 UI を確認したら**ホワイトリスト方式**だったので個別列挙に修正。
 *
 * モデル名 (job_set_type) は CLI `higgsfield model list --image --json` から
 * 突き合わせ済み。
 */

export type ModelLabel = "UNLIMITED" | "EXCLUSIVE" | "NEW";

/**
 * 公式 UI の「Featured models」順序。
 * job_set_type の配列。この順番で表示、含まれないものは All models セクションへ。
 */
export const FEATURED_IMAGE_MODELS: readonly string[] = [
  "gpt_image_2",
  "imagegen_2_0",
  "image_auto",
  "text2image_soul_v2",
  "soul_cinematic",
  "seedream_v5_lite",
  "seedream_v4_5",
  "nano_banana_flash",
  "nano_banana_2",
  "grok_image",
];

/**
 * 表示名の上書き (公式 CLI の display_name → アプリ内で見せる名前)。
 * 一覧/トリガー/コスト表示など全ての見せ場で適用する。
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  gpt_image_2: "GPTimage2",
  imagegen_2_0: "GPTimage2",
};

/**
 * 与えられたモデルのアプリ内表示名を返す。
 * オーバーライドが無ければ CLI の display_name をそのまま返す。
 */
export function getDisplayName(model: { jobSetType: string; displayName: string }): string {
  return DISPLAY_NAME_OVERRIDES[model.jobSetType] ?? model.displayName;
}

export const FEATURED_VIDEO_MODELS: readonly string[] = [];

/**
 * モデルの短い説明文 (1 行)。公式 UI を参考に。
 * 含まれないモデルは説明なしで表示。
 */
export const MODEL_DESCRIPTIONS: Record<string, string> = {
  image_auto: "プロンプトに応じて最適なモデルを自動選択",
  text2image_soul_v2: "超リアルなファッション系画像",
  soul_cinematic: "シネマティックなビジュアル生成",
  gpt_image_2: "テキスト描画に強い 4K 画像",
  imagegen_2_0: "テキスト描画に強い 4K 画像",
  seedream_v5_lite: "高速・推論ベースの画像生成",
  seedream_v4_5: "ByteDance の 4K 画像生成",
  nano_banana_flash: "Pro 品質を Flash スピードで",
  nano_banana_2: "Google のフラッグシップ画像生成",
  grok_image: "xAI による多用途画像生成",
  flux_2: "速度最適化の高精細描写",
  flux_kontext: "コンテキスト保持型編集",
  kling_omni_image: "Kling 系の写実画像",
  z_image: "リアルなポートレート",
  cinematic_studio_2_5: "シネマ風のスタジオ生成",
  marketing_studio_image: "マーケティング素材向け生成",
  openai_hazel: "OpenAI 製の汎用画像",
  soul_location: "風景・ロケーション専用",
};

type PlanLabels = {
  /** 無制限対象モデル (job_set_type) */
  unlimited: ReadonlySet<string>;
  /** プラン専用モデル (job_set_type) */
  exclusive?: ReadonlySet<string>;
  /** NEW バッジ対象 (job_set_type) — UNLIMITED とは独立の表示ラベル */
  new?: ReadonlySet<string>;
};

/**
 * creator プランの UNLIMITED 対象。
 * 公式 UI のスクショを再読 (Featured + All models) して 2026-05-11 に再校正。
 *
 *   公式 UI 名 + ラベル              → CLI job_set_type     → ラベル
 *   ─────────────────────────────────────────────────────────────────
 *   Auto · UNLIMITED                → image_auto            → UNLIMITED
 *   Nano Banana · UNLIMITED          → nano_banana           → UNLIMITED
 *   Nano Banana 2 (ラベルなし)        → nano_banana_flash      → なし
 *   Nano Banana Pro · UNLIMITED      → nano_banana_2          → UNLIMITED
 *   Seedream 5.0 lite · UNLIMITED    → seedream_v5_lite       → UNLIMITED
 *   Seedream 4.5 · UNLIMITED         → seedream_v4_5          → UNLIMITED
 *   Z-Image · UNLIMITED              → z_image                → UNLIMITED
 *   Kling O1 · UNLIMITED             → kling_omni_image       → UNLIMITED
 *   FLUX.2 Pro · UNLIMITED           → flux_2                 → UNLIMITED
 *   GPT Image 2 · NEW                → gpt_image_2 / imagegen_2_0 → なし (NEW のみ)
 *   Higgsfield Soul 2.0 · NEW        → text2image_soul_v2     → NEW (旧 Soul とは別物)
 *   Higgsfield Soul Cinema · NEW     → ※ CLI 未提供
 *   Higgsfield Face Swap · UNLIMITED → ※ CLI 未提供
 *   Multi Reference · UNLIMITED      → ※ CLI 未提供
 *   Reve · UNLIMITED                 → ※ CLI 未提供
 *
 * 旧コミット (37623fd) で誤って imagegen_2_0 / gpt_image_2 / text2image_soul_v2
 * を UNLIMITED にしていたが、公式は NEW なので外す (NEW ラベルは下のテーブルへ)。
 * Higgsfield Soul (UNLIMITED) は公式に存在するが CLI からは text2image_soul_v2
 * (= Soul 2.0) しか出ないので、Soul UNLIMITED は対応モデルなしとして扱う。
 */
const CREATOR_UNLIMITED = new Set<string>([
  "image_auto",
  "nano_banana",
  "nano_banana_2",
  "seedream_v5_lite",
  "seedream_v4_5",
  "z_image",
  "kling_omni_image",
  "flux_2",
]);

/**
 * creator プランの NEW 表示対象 (公式 UI で NEW バッジ)。
 * UNLIMITED とは別カテゴリ。
 */
const CREATOR_NEW = new Set<string>([
  "gpt_image_2",
  "imagegen_2_0",
  "text2image_soul_v2",
  "soul_cinematic",
]);

/**
 * creator プランの EXCLUSIVE モデル (公式 UI で EXCLUSIVE ラベル):
 *   Kling 3.0 (動画モデル) → kling_3 (CLI 名は推測、要確認)
 */
const CREATOR_EXCLUSIVE = new Set<string>(["kling_3"]);

export const PLAN_LABELS: Record<string, PlanLabels> = {
  free: { unlimited: new Set() },
  starter: { unlimited: new Set() },
  basic: { unlimited: new Set() },
  // plus / pro / ultra / ultimate は公式 UI 未確認なので推測値で残す
  // (要 pricing ページ確認後に正確化)
  plus: {
    unlimited: new Set([
      "seedream_v5_lite",
      "flux_2",
      "gpt_image_2",
      "imagegen_2_0",
    ]),
  },
  pro: {
    unlimited: new Set([
      "seedream_v5_lite",
      "flux_2",
      "gpt_image_2",
      "imagegen_2_0",
    ]),
  },
  ultra: {
    unlimited: new Set([
      "seedream_v5_lite",
      "flux_2",
      "gpt_image_2",
      "imagegen_2_0",
      "nano_banana_2",
      "seedream_v4_5",
    ]),
    exclusive: new Set(["kling_3"]),
  },
  ultimate: {
    unlimited: new Set([
      "seedream_v5_lite",
      "flux_2",
      "gpt_image_2",
      "imagegen_2_0",
      "nano_banana_2",
      "seedream_v4_5",
    ]),
    exclusive: new Set(["kling_3"]),
  },
  creator: {
    unlimited: CREATOR_UNLIMITED,
    exclusive: CREATOR_EXCLUSIVE,
    new: CREATOR_NEW,
  },
};

/**
 * 与えられた jobSetType に対応するラベル (UNLIMITED / EXCLUSIVE / なし) を返す。
 * 不明プラン or 該当なしは null。
 */
export function getModelLabel(
  plan: string | null | undefined,
  jobSetType: string,
): ModelLabel | null {
  if (!plan) return null;
  const labels = PLAN_LABELS[plan.toLowerCase()];
  if (!labels) return null;
  if (labels.unlimited.has(jobSetType)) return "UNLIMITED";
  if (labels.exclusive?.has(jobSetType)) return "EXCLUSIVE";
  if (labels.new?.has(jobSetType)) return "NEW";
  return null;
}

/**
 * 同じ display_name で複数 job_set_type が返るケース (例: GPT Image 2 が
 * imagegen_2_0 と gpt_image_2 で 2 件) を 1 件にまとめる。
 *
 * 優先順序: PREFERRED_DUPLICATE_WINNER に列挙された job_set_type を優先。
 * 含まれないなら最初に出現した方を採用。
 */
const PREFERRED_DUPLICATE_WINNER = new Set<string>([
  "gpt_image_2", // imagegen_2_0 より新しい canonical id
]);

export function dedupeModels<T extends { displayName: string; jobSetType: string }>(
  models: readonly T[],
): T[] {
  const byName = new Map<string, T>();
  for (const m of models) {
    const key = m.displayName.trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, m);
      continue;
    }
    // 既に登録あり: PREFERRED_DUPLICATE_WINNER を優先
    if (
      PREFERRED_DUPLICATE_WINNER.has(m.jobSetType) &&
      !PREFERRED_DUPLICATE_WINNER.has(prev.jobSetType)
    ) {
      byName.set(key, m);
    }
  }
  return [...byName.values()];
}

/**
 * 後方互換: 既存の isModelUnlimited 呼び出しを維持する。
 * 新規コードは getModelLabel を使う。
 */
export function isModelUnlimited(
  plan: string | null | undefined,
  jobSetType: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _modelType: "image" | "video",
): boolean {
  return getModelLabel(plan, jobSetType) === "UNLIMITED";
}
