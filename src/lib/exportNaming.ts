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
  | "plain"
  /**
   * LINEスタンプ向け。ゼロ埋め2桁の連番のみ (`01.png`)。
   *
   * 他の style と違い **prefix / role / version を一切付けない**。LINE Creators Market へ
   * 入稿する `01.png`〜`NN.png` は連番の完全性そのものが要件で、余計な要素が混ざると
   * 「01〜NNの欠番なし」の検査(層A D11)が通らなくなるため。
   */
  | "sticker";

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
  // 背景・場面（複合ラベルで先に来てほしいので上に置く）
  [/白背景/, "white_bg"],
  [/使用シーン|シーン/, "scene"],
  // 画角・距離
  [/全身/, "full_body"],
  [/ディテール|寄り|クローズ/, "detail"],
  [/引き|ロング/, "wide"],
  // 向き
  [/正面|フロント/, "front"],
  [/背面|後ろ|後姿|バック/, "back"],
  [/側面|真横|横顔|サイド/, "side"],
  [/斜め|3\/4|クォーター/, "three_quarter"],
  [/顔|フェイス|アップ/, "face"],
  // 高さ
  [/見上げ|ローアングル/, "low_angle"],
  [/見下ろし|ハイアングル/, "high_angle"],
  [/俯瞰/, "overhead"],
  // 表情（表情差分スキル。ここが無いと日本語ラベルが空になり全部同名になる）
  // 注: 「笑顔」は上の /顔/ にも当たるので face_smile と二重になる。
  // 表情語は単独で意味が通るため、当たったら顔系を落とす（下の toRoleSlug で処理）。
  [/ニュートラル|真顔|無表情/, "neutral"],
  [/笑顔|笑い|スマイル/, "smile"],
  [/怒り|怒っ/, "angry"],
  [/悲し|泣き/, "sad"],
  [/驚き|驚い/, "surprised"],
  [/照れ|恥ずかし/, "shy"],
  [/困り|困惑/, "troubled"],
  [/不安|心配/, "worried"],
  [/得意|ドヤ/, "confident"],
  [/呆れ/, "unimpressed"],
  [/眠|寝/, "sleepy"],
];

/**
 * 日本語ラベルを英数の役割名へ寄せる。
 *
 * 2026-07-27 修正: 以前は (a) 最初に当たった1語だけ返し (b) 辞書に無ければ
 * `toSafeSegment` の結果をそのまま返していた。この2つが同時に事故を起こしていた:
 *
 * - (a) 「白背景・正面」が `front` になり、白背景かシーンかが名前から消えた
 * - (b) `toSafeSegment` は全角を全部 `_` に変えてから前後の `_` を削るので、
 *   **日本語だけのラベルは必ず空文字になる**（「怒り」「悲しみ」→ ""）。
 *   空になった役割名は buildExportFileName の filter(Boolean) で落ち、
 *   最後の受け皿 "image" に落ちて **11枚中8枚が image.png** になっていた（実測）。
 *
 * 現在は当たった語を辞書の定義順に全部連結し、1つも当たらなければ null を返す
 * （呼び出し側が index 等の代替で一意性を保てるようにする。空文字を返さない）。
 */
const EXPRESSION_SLUGS = new Set([
  "neutral", "smile", "angry", "sad", "surprised",
  "shy", "troubled", "worried", "confident", "unimpressed", "sleepy",
]);

export function toRoleSlug(label: string): string | null {
  let hits: string[] = [];
  for (const [pattern, slug] of ROLE_DICTIONARY) {
    if (pattern.test(label) && !hits.includes(slug)) hits.push(slug);
  }
  // 表情語が当たっているなら "face" は冗長 (「笑顔」→ face_smile を smile にする)
  if (hits.some((h) => EXPRESSION_SLUGS.has(h))) {
    hits = hits.filter((h) => h !== "face");
  }
  if (hits.length > 0) return hits.join("_");
  const fallback = toSafeSegment(label).toLowerCase();
  return fallback || null;
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
  // toRoleSlug は当てはまらなければ null。空文字を混ぜると parts から落ちて
  // 全部同名になるため、null は最初から無かったものとして扱う。
  const role = (opts.role ? toRoleSlug(opts.role) : null) ?? "";
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
    case "sticker":
      // 連番だけ。prefix / role / version は意図的に無視する（型注釈参照）。
      // 既定2桁。digits を明示されたらそれに従う（40枚超の将来拡張のため）。
      if (opts.index !== undefined) parts.push(padIndex(opts.index, opts.digits ?? 2));
      break;
  }

  // sticker は連番の完全性が要件なので版番号を付けない。
  if (opts.style !== "sticker" && opts.version !== undefined && opts.version > 1) {
    parts.push(`v${opts.version}`);
  }

  // 全部空になる異常時でも無名ファイルを作らない
  const stem = parts.filter(Boolean).join("_") || "image";
  const ext = toSafeSegment(opts.ext).toLowerCase() || "png";
  return `${stem}.${ext}`;
}

// 2026-07-27: DEFAULT_NAMING_STYLE を削除した。
//
// どこからも参照されておらず (呼び出し4箇所はすべて style を直書き)、書き換えても挙動が
// 変わらない死んだ台帳だった。さらに載せていた7スキルのうち storyboard / character-register
// / scene-3d は buildExportFileName を1度も呼んでおらず、**実装のない挙動を「対応済み」と
// 記述している**状態で、次に読む人を誤認させる。
//
// TODO: 下記3スキルは書き出し名の統一が未対応。対応するときはここに命名規則を戻すか、
// 各スキルの保存処理で buildExportFileName を呼ぶ。
//   - gori-storyboard        (絵コンテ: 連番 C001 形式にすべき)
//   - gori-character-register (キャラ登録: キャラ名_役割 形式にすべき)
//   - gori-scene-3d          (3D: 連番形式にすべき)
