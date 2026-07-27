/**
 * 書き出しファイル名の共通ルール。
 *
 * ## なぜ共通化するか (2026-07-27)
 *
 * 4職種(広告制作/キャラIP/EC運用/映像プリプロ)の実務診断で、全職種が
 * 「出てきた画像をそのまま入稿・納品できない」で詰まった。原因はファイル名:
 *
 * | 職種 | 必要な形 | 現状 |
 * |---|---|---|
 * | EC   | `SKU_連番`(半角) | `白背景・正面.png` → モールが日本語名を弾く |
 * | 映像 | `C001, C002...`  | `front.png` → 編集ソフトが順番に並べられない |
 * | キャラ | `キャラ名_役割_版` | 上書きすると前の版が消える |
 * | 広告 | 案件の命名規則     | 合わせる手段がない |
 *
 * 各スキルが個別に `` `${cut.label}.${ext}` `` を組んでいたため、直すなら全箇所を
 * 触る必要があった。命名を1箇所に集約し、以降のスキル追加でも同じ形になるようにする。
 */

/** 命名の型。用途ごとに並び順と要素が違う。 */
export type NamingStyle =
  /** 連番主体。映像・絵コンテ向け (`C001_close.png`)。編集ソフトの昇順に乗る */
  | "sequence"
  /** 品番主体。EC向け (`SKU123_01_white.png`)。半角のみ */
  | "sku"
  /** 名前+役割+版。キャラIP向け (`yuki_front_v2.png`) */
  | "asset"
  /** 素の名前だけ。従来互換 */
  | "plain";

export type NamingOptions = {
  style: NamingStyle;
  /** 案件・商品・キャラを識別する接頭辞 (SKU / キャラ名 / 案件コード)。 */
  prefix?: string;
  /** 1始まりの通し番号。 */
  index?: number;
  /** ゼロ埋めの桁数。既定3桁 (`001`)。 */
  digits?: number;
  /** 役割・バリエーション名 (front / white / close 等)。 */
  role?: string;
  /** 版番号。1以下なら付けない。 */
  version?: number;
  /** 拡張子 (ドット無し)。 */
  ext: string;
};

/**
 * ファイル名に使えない文字を落とす。
 *
 * OS の禁止文字に加えて、**全角文字・空白も落とす**のが要点。ECモールは
 * 日本語ファイル名を受け付けず、映像の編集ソフトは空白入りのパスで
 * 取り違えを起こすため、実務では半角英数・アンダースコア・ハイフンだけが安全。
 */
export function toSafeSegment(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "_") // OS 禁止文字
    .replace(/\s+/g, "_") // 空白 → _
    .replace(/[^\w-]/g, "_") // 半角英数・_・- 以外 (全角含む) → _
    .replace(/_{2,}/g, "_") // 連続 _ を畳む
    .replace(/^_+|_+$/g, ""); // 前後の _ を落とす
}

/**
 * 日本語ラベルを英数の役割名へ寄せる。辞書に無いものは安全化した文字列を返す。
 *
 * 完全な翻訳は目指さない。実務で頻出する役割語だけを拾って、
 * 残りは `toSafeSegment` に委ねる (推測で埋めず、変換できないものは
 * `_` 区切りの安全な文字列として残す)。
 */
const ROLE_DICTIONARY: ReadonlyArray<readonly [RegExp, string]> = [
  [/正面|フロント/, "front"],
  [/背面|後ろ|後姿|バック/, "back"],
  [/側面|横|サイド/, "side"],
  [/斜め|3\/4|クォーター/, "three_quarter"],
  [/顔|フェイス|アップ/, "face"],
  [/全身/, "full_body"],
  [/白背景/, "white_bg"],
  [/使用シーン|シーン/, "scene"],
  [/ディテール|寄り|クローズ/, "detail"],
  [/引き|ロング/, "wide"],
  [/見上げ|ローアングル/, "low_angle"],
  [/見下ろし|ハイアングル/, "high_angle"],
  [/俯瞰/, "overhead"],
];

export function toRoleSlug(label: string): string {
  for (const [pattern, slug] of ROLE_DICTIONARY) {
    if (pattern.test(label)) return slug;
  }
  return toSafeSegment(label).toLowerCase();
}

/** 通し番号をゼロ埋めする。 */
function padIndex(index: number, digits: number): string {
  return String(Math.max(0, Math.trunc(index))).padStart(digits, "0");
}

/**
 * 実務規格に沿ったファイル名を組み立てる。
 *
 * 例:
 * - sequence: `C001_close.png` / prefix 有りなら `PJ01_C001_close.png`
 * - sku:      `SKU123_01_white_bg.png`
 * - asset:    `yuki_front_v2.png`
 * - plain:    `front.png`
 */
export function buildExportFileName(opts: NamingOptions): string {
  const digits = opts.digits ?? 3;
  const prefix = opts.prefix ? toSafeSegment(opts.prefix) : "";
  const role = opts.role ? toRoleSlug(opts.role) : "";
  const parts: string[] = [];

  switch (opts.style) {
    case "sequence":
      if (prefix) parts.push(prefix);
      if (opts.index !== undefined) parts.push(`C${padIndex(opts.index, digits)}`);
      if (role) parts.push(role);
      break;
    case "sku":
      if (prefix) parts.push(prefix);
      // EC は「SKU + 掲載順」が主キー。2桁で足りる運用が多いので既定を短くする。
      if (opts.index !== undefined) parts.push(padIndex(opts.index, Math.min(digits, 2)));
      if (role) parts.push(role);
      break;
    case "asset":
      if (prefix) parts.push(prefix);
      if (role) parts.push(role);
      if (opts.index !== undefined) parts.push(padIndex(opts.index, digits));
      break;
    case "plain":
      if (prefix) parts.push(prefix);
      if (role) parts.push(role);
      if (opts.index !== undefined) parts.push(padIndex(opts.index, digits));
      break;
  }

  if (opts.version !== undefined && opts.version > 1) {
    parts.push(`v${opts.version}`);
  }

  // 全部空になる異常時でも無名ファイルを作らない
  const stem = parts.filter(Boolean).join("_") || "image";
  const ext = toSafeSegment(opts.ext).toLowerCase() || "png";
  return `${stem}.${ext}`;
}

/** スキル単位の既定スタイル。UI の初期値に使う。 */
export const DEFAULT_NAMING_STYLE: Record<string, NamingStyle> = {
  "gori-product-set": "sku",
  "gori-storyboard": "sequence",
  "gori-multi-angle": "sequence",
  "gori-comic": "sequence",
  "gori-character-register": "asset",
  "gori-expression-set": "asset",
  "gori-scene-3d": "sequence",
};
