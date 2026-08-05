/**
 * LINEスタンプ 審査セルフチェック（層B）のルールセット定義
 *
 * 既存の `regulationCheck/rules.ts` は景表法・薬機法まわりの広告レギュレーションであり、
 * **別物**（媒体入稿の文字量・打消し表記・誇大表現）。こちらは LINE Creators Market の
 * 審査ガイドラインに対応する専用セットとして分けて持つ。
 *
 * ## この層が約束しないこと（最重要）
 *
 * **「審査に通る」とは判定しない。** LINE は「判断基準は当社の裁量で変更しうる」と明言して
 * おり、合否を外部から保証することは構造的に不可能。ここが出せるのは
 * 「公式のリジェクト理由に照らして、気になる箇所を機械的に洗い出す」までで、
 * 最終的な承認可否は LINE の審査による。UI 文言もその位置づけに揃える（設計書 §6.4）。
 *
 * ## AI生成物の扱い
 *
 * 一次情報（`_work/gorigori-feedback/wave7/line-ai-policy-verified.md`）で確定した事実:
 * **AI生成のみのスタンプでも審査は通る**。「AI生成は審査対象外」説は否定されている。
 * したがって本ルールセットは「AIだから落ちる」を前提にしない。AI固有のルールは1つも無い。
 * また公式の判定ではAIを補助的に使った場合もAIラベルが付くため、**ラベル回避は構造的に
 * 不可能**であり、隠す方向の設計もしない（申告支援はスコープ外・設計書 §3）。
 *
 * ## 実際に落ちている理由に寄せる
 *
 * 同 §5-4 の実例14件では、リジェクトは **カテゴリ1（視認性・バランス・重複）と
 * カテゴリ5（権利）に集中**している。前者は主観判断で人の目が要るため層Bでは
 * `low-visibility` の1本に留め、工程④で人が並べて見る導線に委ねる（設計書 §1.6）。
 *
 * ## 未確認事項を推測で埋めていない
 *
 * - **電話番号・QRコードの明示的禁止は公式に見つからなかった** → ルール化しない。
 *   「たぶんNGだろう」で作らない。ただし `textStrings` には現れるので人間が判断できる。
 * - **画像内URLの明示禁止も一次情報で未確認**（公式のURL禁止はタイトル・説明文の項）
 *   → `url-in-image` は high ではなく **mid** に留める。
 */

import { humanizeError } from "../humanizeError";
import type { RegulationRule, RegulationSeverity } from "../regulationCheck/rules";

/**
 * 層Bルール1件。既存の `RegulationRule`（id/name/description/criteria）に、
 * このルールが最大でどの重大度を出しうるかを **コード側の契約として** 持たせる。
 *
 * なぜ severity をルール側に持つか: 重大度は「公式カテゴリのどれに当たるか」で決まる
 * 設計判断であり、AI の気分で上下してよい値ではない。プロンプトに書くだけでは
 * 守られる保証がないので、`check.ts` 側で **この値を超える severity を切り下げる**
 * ための正本として持つ（未確認事項の url-in-image が high で出てくるのを構造的に防ぐ）。
 */
export type StickerReviewRule = RegulationRule & {
  /** このルールが出しうる最大の重大度。これを超える申告は check.ts が切り下げる。 */
  maxSeverity: RegulationSeverity;
};

/** 層Bで参照する LINE スタンプ審査ルール（12本）。 */
export const LINE_STICKER_REVIEW: readonly StickerReviewRule[] = [
  {
    id: "text-only-image",
    name: "文字だけの画像",
    description: "絵の要素が無く、単純なテキストのみで構成されていないか。",
    maxSeverity: "high",
    criteria:
      "「文字面積比が 0.4 以上」かつ「絵の要素（人物・動物・物・背景）が一切描写されていない」の**両方**を満たす場合にだけ high。文字と絵が併存していれば問題なしとする（文字が主役のスタンプは正当に存在するため、面積比だけで指摘しない）。事実材料の hasPictorialContent が true なら、面積比が高くても指摘しない。",
  },
  {
    id: "real-person",
    name: "実在人物の肖像",
    description: "実在する人物の顔を無断で使用していないか（公式カテゴリ5 肖像）。",
    maxSeverity: "high",
    criteria:
      "事実材料の realPersons に「実在人物として識別できる顔がある」と記録されている場合に high。uncertain（判別できない）の場合は指摘しない（推測で断定しない）。",
  },
  {
    id: "brand-mark",
    name: "ブランド・商標",
    description: "実在企業のロゴ・商標・製品意匠が写り込んでいないか（公式カテゴリ5 知的財産）。",
    maxSeverity: "high",
    criteria:
      "事実材料の brandMarks が空でない場合に high。名称が特定できず「〜風」としか言えないものは brandMarks に載らない約束なので、載っていれば指摘する。",
  },
  {
    id: "derivative-work",
    name: "二次創作・権利の所在",
    description:
      "既存の商用キャラクター・作品由来のものが含まれていないか（公式 5.2 権利の所在が明確でないもの）。",
    maxSeverity: "high",
    criteria:
      "事実材料の knownCharacters が空でない場合に high。自作キャラクターであれば載らないため、載っていれば権利の所在を確認する必要がある。",
  },
  {
    id: "skin-exposure",
    name: "肌の露出・性的表現",
    description: "肌の露出が多い、または性的な表現でないか（公式 3.3 / 3.16）。",
    maxSeverity: "high",
    criteria:
      "事実材料の skinExposure が present: true の場合に high。uncertain の場合は指摘しない。",
  },
  {
    id: "violence-crime",
    name: "暴力・犯罪",
    description: "暴力的表現・犯罪を助長する表現でないか（公式カテゴリ3）。",
    maxSeverity: "high",
    criteria: "事実材料の violence が present: true の場合に high。uncertain の場合は指摘しない。",
  },
  {
    id: "politics-religion",
    name: "政治・宗教",
    description: "政治的表現・選挙運動・宗教的表現でないか（公式 3.14）。",
    maxSeverity: "high",
    criteria:
      "事実材料の politicalReligious が present: true の場合に high。uncertain の場合は指摘しない。",
  },
  {
    id: "discrimination",
    name: "差別的表現",
    description: "差別・誹謗中傷にあたる表現でないか（公式カテゴリ3）。",
    maxSeverity: "high",
    criteria:
      "事実材料の discrimination が present: true の場合に high。uncertain の場合は指摘しない。",
  },
  {
    id: "gambling",
    name: "ギャンブル",
    description: "賭博・ギャンブルを想起させる表現でないか（公式 3.19）。",
    maxSeverity: "mid",
    criteria:
      "事実材料の gambling が present: true の場合に mid。実例にリジェクト事由として存在するが、表現の度合いで判断が分かれるため mid に留める。",
  },
  {
    id: "url-in-image",
    name: "画像内のURL",
    description: "画像内にURLが写り込んでいないか。",
    maxSeverity: "mid",
    criteria:
      "事実材料の textStrings、または文字情報に URL（http/https/www/ドメイン形式）が含まれる場合に mid。**公式のURL禁止はタイトル・説明文の項であり、画像内URLの明示禁止は一次情報で確認できていない**ため high にはしない。電話番号・QRコードは公式の禁止が確認できていないため指摘しない。",
  },
  {
    id: "commercial-ad",
    name: "商業広告",
    description: "企業の商業用広告・宣伝を目的とした構成でないか（公式カテゴリ4）。",
    maxSeverity: "mid",
    criteria:
      "価格・キャンペーン告知・企業名の宣伝など、スタンプではなく広告と読める構成である場合に mid。単にキャラクターが商品を持っているだけでは指摘しない。",
  },
  {
    id: "low-visibility",
    name: "視認性",
    description: "小さすぎる・低コントラスト・潰れて見えないものでないか（公式カテゴリ1）。",
    maxSeverity: "mid",
    criteria:
      "被写体が極端に小さい、背景と同化して輪郭が判別できない、細部が潰れて何か分からない場合に mid。トークルームの小さい表示で判別できるかを基準にする。",
  },
] as const;

/** ruleId → ルール定義の逆引き。UI 表示名の解決に使う。 */
export const LINE_STICKER_REVIEW_BY_ID: ReadonlyMap<string, StickerReviewRule> = new Map(
  LINE_STICKER_REVIEW.map((rule) => [rule.id, rule]),
);

/**
 * 層Bの結果に必ず添える但し書き。
 *
 * **この文言を出さずに結果を表示してはいけない。** 自己点検であって審査結果ではない、
 * という限界の明示は誠実さの問題であり、UI 側の裁量で省いてよい装飾ではない（設計書 §6.4）。
 */
export const REVIEW_DISCLAIMER =
  "これは自己点検であり、審査結果を保証するものではありません。最終的な承認可否はLINEの審査によります。";

/**
 * 審査ガイドラインの一次情報リンク。
 *
 * LINE は「判断基準は当社の裁量で変更しうる」と明言しているため、
 * **本ルールセットは古くなりうる**。結果画面から必ず原典に辿れるようにしておく
 * （規律モジュール条項7「前提の鮮度を確かめる」）。
 */
export const REVIEW_GUIDELINE_URL =
  "https://creator.line.me/ja/guideline/sticker/";

/**
 * Rust / 生成側の生エラーを、そのまま画面に出さないための整形（設計書 §6.6）。
 *
 * 3点書式にそろえる: **起きたこと / データは無事か / 次の一手**。
 * 生の英語スタックや `invoke` の内部表現を見せても、非エンジニアには次の行動が決まらない。
 * 原因の手がかりは失うと調査できなくなるので**消さずに末尾へ括弧で残す**
 * （「欠落は埋めずに可視化する」と同じ思想で、ここは「詳細を握り潰さない」）。
 *
 * ## `humanizeError` との役割分担（B4・2026-08-05）
 *
 * 両者は**別の仕事**をしており、片方をもう片方で置き換えることはできない:
 *
 * - `humanizeError`（`lib/humanizeError.ts`）: **1つの生エラー文字列を短くする**。
 *   権限エラー・ファイル未検出を定型文へ畳み、それ以外は空白を潰して120字で切る
 * - `formatStickerError`（ここ）: **3点書式の文脈を組み立てる**。
 *   何が起きたか / 作った画像は無事か / 次に何をすればよいか
 *
 * 以前はここが生エラーをそのまま括弧へ入れていたため、Tauri の権限エラー全文が
 * トーストへあふれていた。**詳細の圧縮は `humanizeError` に委ね、ここは文脈だけを持つ。**
 * 詳細を消さない方針（「握り潰さない」）は維持する — 圧縮であって削除ではない。
 */
export function formatStickerError(
  what: string,
  err: unknown,
  next: string,
  opts?: { dataSafe?: string },
): string {
  const raw = String((err as Error)?.message ?? err ?? "").trim();
  const detail = raw ? `（詳しい内容: ${humanizeError(raw).replace(/。+$/, "")}）` : "";
  const safe = opts?.dataSafe ?? "作った画像はそのまま残っています。";
  return `${what} ${safe} ${next}${detail}`;
}
