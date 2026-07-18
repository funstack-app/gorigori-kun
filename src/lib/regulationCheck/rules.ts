/**
 * レギュレーション検査のルールセット定義（スキル一覧v2.1 #11・MVP）
 *
 * 入稿画像を媒体ごとの規定（文字量比率・必須表記・NG表現・ロゴ）で検査するための
 * ルール辞書。各ルールは Codex への検査プロンプトにそのまま埋め込まれる判定基準テキストを持つ。
 *
 * MVP の設計判断:
 * - ルールセットは「媒体プリセット」単位。既定は汎用SNS広告 / YouTubeサムネ / EC商品画像 の3種。
 * - ユーザーは自由記述ルール（textarea）を1件追加でき、選択中プリセットに合流して検査される。
 * - 実際の合否判定は Codex（画像入力可）が行う。ここは「何を見るか」の基準文だけを持つ。
 */

/** 指摘の重大度。high=配布ブロッカー相当 / mid=要修正 / low=推奨・軽微。 */
export type RegulationSeverity = "high" | "mid" | "low";

/** 検査観点1件。id は issue との突き合わせキー、criteria が Codex に渡す判定基準。 */
export type RegulationRule = {
  /** ルール識別子（issue.ruleId と対応）。英小文字+ハイフン。 */
  id: string;
  /** UI 表示用の短い名前。 */
  name: string;
  /** このルールが何を守るかの一文説明（UI 表示用）。 */
  description: string;
  /** Codex に渡す判定基準テキスト。「何を満たせば OK / 何が NG か」を具体的に書く。 */
  criteria: string;
};

/** 媒体プリセット。複数の検査観点をまとめた1セット。 */
export type RegulationRuleSet = {
  /** プリセット識別子。 */
  id: string;
  /** UI 表示名。 */
  name: string;
  /** このプリセットの用途説明。 */
  description: string;
  /** このプリセットに含まれる検査観点。 */
  rules: RegulationRule[];
};

const GENERIC_SNS_AD: RegulationRuleSet = {
  id: "generic-sns-ad",
  name: "汎用SNS広告",
  description: "Meta/X/LINE 等の汎用フィード広告向け。文字量・必須表記・誇大表現を検査する。",
  rules: [
    {
      id: "text-area-ratio",
      name: "文字量比率",
      description: "画像に占めるテキスト面積が過大でないか。",
      criteria:
        "画像内のテキスト（見出し・キャッチ・注釈すべて）が占める面積の概算が画像全体の20%を超えていたら high、20%以下15%超なら mid、15%以下なら問題なし。ロゴ内の社名文字はテキスト面積に含めない。",
    },
    {
      id: "required-disclaimer",
      name: "必須表記",
      description: "「個人の感想です」「効果には個人差があります」等の注記が必要な訴求に注記があるか。",
      criteria:
        "効果・成果・体験談を訴求する文言（例: 痩せた/稼げた/治った/満足度No.1）が読み取れる場合、それに対応する打消し表記（例: 個人の感想です・効果には個人差があります・当社調べ）が同一画像内に視認できなければ high。訴求文言自体が無ければ問題なし。",
    },
    {
      id: "ng-expression",
      name: "NG表現",
      description: "断定的・最上級・差別的表現などの禁止ワードが含まれないか。",
      criteria:
        "「必ず」「100%」「日本一」「業界No.1」等の客観的根拠なく断定/最上級を用いた表現、または差別的・攻撃的な表現が読み取れたら high。根拠併記のある比較表現は mid。該当が無ければ問題なし。",
    },
    {
      id: "logo-presence",
      name: "ロゴ表示",
      description: "ブランドロゴ・提供元表記が視認できる位置にあるか。",
      criteria:
        "ブランドロゴまたは提供元の社名表記が画像内に1つも視認できなければ mid。視認できるが極端に小さく（画像高さの3%未満相当）判読困難なら low。適切に視認できれば問題なし。",
    },
  ],
};

const YOUTUBE_THUMBNAIL: RegulationRuleSet = {
  id: "youtube-thumbnail",
  name: "YouTubeサムネ",
  description: "YouTube サムネイル向け。誇張サムネ・可読性・注意過多を検査する。",
  rules: [
    {
      id: "text-legibility",
      name: "文字の可読性",
      description: "サムネの主要テキストがスマホ縮小でも読めるか。",
      criteria:
        "サムネ内の最も目立つ文字列が、縮小表示（横幅約120px相当）で判読できないほど小さい/コントラスト不足なら mid。主要文字が明瞭で十分なコントラストがあれば問題なし。",
    },
    {
      id: "clickbait-mismatch",
      name: "誇張・釣り表現",
      description: "内容と乖離した過度な煽り・虚偽の可能性。",
      criteria:
        "「衝撃」「ヤバい」「削除覚悟」等の過度な煽り、または矢印/赤丸/驚き顔などの注意喚起要素が画面の半分以上を占めるほど過剰なら mid。適度なら low。落ち着いた構成なら問題なし。",
    },
    {
      id: "prohibited-marks",
      name: "禁止マーク混入",
      description: "YouTube UI 模倣（再生ボタン・偽サムネ枠）や他者商標の無断使用。",
      criteria:
        "YouTube の再生ボタン風アイコンをコンテンツ上に重ねてクリックを誘導する表現、または明らかな他社ロゴ・商標の無断使用が読み取れたら high。無ければ問題なし。",
    },
  ],
};

const EC_PRODUCT_IMAGE: RegulationRuleSet = {
  id: "ec-product-image",
  name: "EC商品画像",
  description: "Amazon/楽天等のEC商品画像向け。背景・テキスト・比較表現を検査する。",
  rules: [
    {
      id: "main-image-background",
      name: "メイン画像の背景",
      description: "メイン画像が白背景・商品のみ等のモール規定に沿うか。",
      criteria:
        "商品が主役で背景が白または無地に近ければ問題なし。背景に説明テキスト・帯・装飾・第三者の写り込みが多いと、メイン画像規定に抵触しうるため mid。",
    },
    {
      id: "text-overlay-limit",
      name: "テキスト載せ制限",
      description: "メイン画像に価格・キャンペーン等の文言を載せていないか。",
      criteria:
        "「送料無料」「セール」「◯◯%OFF」「価格」等の販促文言が画像内に焼き込まれていたら mid（多くのモールでメイン画像への文字焼き込みが制限されるため）。商品名の刻印など商品自体の一部は除く。",
    },
    {
      id: "comparison-claim",
      name: "比較・優良誤認",
      description: "根拠なき比較・効果保証表現がないか。",
      criteria:
        "「他社比◯倍」「最安」「No.1」等の比較・最上級表現に根拠（出典・調査年）の併記が読み取れなければ high。根拠併記があれば low。該当表現が無ければ問題なし。",
    },
  ],
};

/** 既定の媒体プリセット一覧。UI のセレクタに並ぶ順。 */
export const DEFAULT_RULE_SETS: readonly RegulationRuleSet[] = [
  GENERIC_SNS_AD,
  YOUTUBE_THUMBNAIL,
  EC_PRODUCT_IMAGE,
] as const;

/** 自由記述ルールに割り当てる固定 id。issue 突き合わせと重複防止に使う。 */
export const CUSTOM_RULE_ID = "custom-user-rule";

/**
 * 選択中プリセットのルールに、ユーザーの自由記述ルール（あれば）を1件合流させて返す。
 * 自由記述が空文字/空白のみなら合流しない。
 */
export function resolveRules(
  ruleSet: RegulationRuleSet,
  customRuleText: string,
): RegulationRule[] {
  const trimmed = customRuleText.trim();
  if (!trimmed) return ruleSet.rules;
  const customRule: RegulationRule = {
    id: CUSTOM_RULE_ID,
    name: "追加ルール（自由記述）",
    description: "ユーザーが入力した独自の検査基準。",
    criteria: trimmed,
  };
  return [...ruleSet.rules, customRule];
}

/** id からルールを引く（issue 表示でルール名・説明を出すため）。 */
export function findRule(
  rules: readonly RegulationRule[],
  ruleId: string,
): RegulationRule | undefined {
  return rules.find((r) => r.id === ruleId);
}
