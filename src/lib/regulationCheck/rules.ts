/**
 * 広告クリエイティブの媒体別ルールセット（2026-08-22確認）。
 *
 * `_work/update-2026-08-22/design/ad-regulations-2026-08.md` を正本とし、
 * 未確認の数値はルール化しない。各ルールは検査方法・出典・確認日・確度を持つ。
 */

/** 指摘の重大度。high=配布ブロッカー相当 / mid=要修正 / low=推奨・軽微。 */
export type RegulationSeverity = "high" | "mid" | "low";

/** ルールの検査方法。 */
export type RegulationRuleKind = "machine" | "ai" | "legal";

/** 出典に対する確度。未確認の項目はルール自体へ収録しない。 */
export type RegulationConfidence = "high" | "medium" | "low";

/** 検査観点1件。id は issue との突き合わせキー、criteria が Codex に渡す判定基準。 */
export type RegulationRule = {
  id: string;
  name: string;
  description: string;
  criteria: string;
  /** 既存の共有利用者を壊さないため optional。既定の媒体ルールでは必ず設定する。 */
  kind?: RegulationRuleKind;
  sourceUrl?: string;
  checkedAt?: string;
  confidence?: RegulationConfidence;
};

/** 媒体プリセット。複数の検査観点をまとめた1セット。 */
export type RegulationRuleSet = {
  id: string;
  name: string;
  description: string;
  /** 未確認のため収録しなかった事項を、ルール一覧より先に示す。 */
  notes: readonly string[];
  rules: RegulationRule[];
};

const CHECKED_AT = "2026-08-22";

const SOURCES = {
  metaSpecs: "https://www.facebook.com/business/ads-guide/image/facebook-feed",
  metaStandards: "https://transparency.meta.com/policies/ad-standards/",
  metaPersonalAttributes:
    "https://transparency.meta.com/policies/ad-standards/objectionable-content/privacy-violations-personal-attributes/",
  metaHealth:
    "https://transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/",
  metaLegacyText: "https://www.facebook.com/business/help/980593475366490",
  googleSpecs: "https://support.google.com/google-ads/answer/10724748",
  googlePolicies: "https://support.google.com/adspolicy/answer/6008942",
  lineSpecs: "https://www.lycbiz.com/jp/manual/line-ads/policy_009/",
  lineGuideline: "https://www.lycbiz.com/jp/manual/line-ads/policy_002/",
  tiktokSpecs: "https://ads.tiktok.com/help/article/specifications-for-carousel-ads",
  tiktokPolicies: "https://ads.tiktok.com/help/article/tiktok-advertising-policies-industry-entry",
  tiktokMisleading: "https://ads.tiktok.com/help/article/tiktok-ads-policy-misleading-and-false-content",
  xSpecs: "https://business.x.com/en/help/campaign-setup/creative-ad-specifications",
  xPolicies: "https://business.x.com/en/help/ads-policies",
  yahooGuideline: "https://ads-help.yahoo-net.jp/s/guideline-editorial",
  yahooIdentity: "https://www.lycbiz.com/jp/column/ly-ads/guideline/2020082430131350/",
  yahooSuperlative: "https://ads-help.yahoo-net.jp/s/article/H000044774",
  pmdAct: "https://elaws.e-gov.go.jp/document?lawid=335AC0000000145",
  premiumAct: "https://elaws.e-gov.go.jp/document?lawid=337AC0000000134",
  medicalAds:
    "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iryou/kokokukisei/",
} as const;

type RuleSource = {
  sourceUrl: string;
  confidence?: RegulationConfidence;
};

function withSource(
  rule: Omit<RegulationRule, "sourceUrl" | "checkedAt" | "confidence">,
  source: RuleSource,
): RegulationRule {
  return {
    ...rule,
    sourceUrl: source.sourceUrl,
    checkedAt: CHECKED_AT,
    confidence: source.confidence ?? "high",
  };
}

function commonAiRules(
  prefix: string,
  categorySourceUrl: string,
  superlativeSourceUrl = categorySourceUrl,
): RegulationRule[] {
  return [
    withSource(
      {
        id: `${prefix}-regulated-category`,
        name: "規制カテゴリの確認",
        description: "暗号資産・ギャンブル・医療・健康食品に該当する訴求を見つける。",
        criteria:
          "暗号資産、ギャンブル、医療、健康食品に関する商品・サービス・効能の訴求が読み取れた場合は mid。媒体ごとに禁止・制限・事前承認の条件が異なるため、画像だけで適法・掲載可とは断定せず、該当カテゴリとして媒体規定の人手確認を促す。該当しなければ問題なし。",
        kind: "ai",
      },
      { sourceUrl: categorySourceUrl },
    ),
    withSource(
      {
        id: `${prefix}-superlative-source`,
        name: "最大級・順位表示の出典",
        description: "「No.1」「世界初」等に根拠の明記があるか。",
        criteria:
          "「No.1」「世界初」等の最大級・順位表現が読み取れるのに、その根拠となる出典が同一クリエイティブ内で確認できなければ high。出典が判読できれば問題なし。最大級・順位表現が無ければ問題なし。",
        kind: "ai",
      },
      { sourceUrl: superlativeSourceUrl },
    ),
  ];
}

function legalCautionRules(prefix: string): RegulationRule[] {
  return [
    withSource(
      {
        id: `${prefix}-legal-pmd-act`,
        name: "法務注意: 薬機法",
        description: "医薬品・医療機器・化粧品等の効能効果の標榜は法務確認が必要。",
        criteria:
          "医薬品、医療機器、化粧品等について治療・予防・身体機能への効能効果をうたう表現が読み取れた場合は high の法務注意として挙げる。画像だけで違法とは断定せず、対象商品区分・承認範囲を専門家が確認するよう明記する。",
        kind: "legal",
      },
      { sourceUrl: SOURCES.pmdAct },
    ),
    withSource(
      {
        id: `${prefix}-legal-premium-act`,
        name: "法務注意: 景品表示法",
        description: "実際より著しく優良・有利と誤認させる表示は法務確認が必要。",
        criteria:
          "商品・サービスの品質、効果、価格、取引条件について、根拠のない優良・有利表現が読み取れた場合は high の法務注意として挙げる。画像だけで違法とは断定せず、表示を裏付ける合理的根拠を専門家が確認するよう明記する。",
        kind: "legal",
      },
      { sourceUrl: SOURCES.premiumAct },
    ),
    withSource(
      {
        id: `${prefix}-legal-medical-ads`,
        name: "法務注意: 医療広告",
        description: "医療の体験談・ビフォーアフターは医療広告の専門確認が必要。",
        criteria:
          "医療機関・医療行為の体験談、または治療前後の写真・比較表現が読み取れた場合は high の法務注意として挙げる。画像だけで適法性を断定せず、医療広告ガイドライン上の条件を専門家が確認するよう明記する。",
        kind: "legal",
      },
      { sourceUrl: SOURCES.medicalAds },
    ),
  ];
}

const META_ADS: RegulationRuleSet = {
  id: "meta-ads",
  name: "Meta広告（Facebook / Instagram）",
  description: "2026年8月確認のMeta静止画広告向け。画像規格と主要な表現規定を検査する。",
  notes: ["未確認のため未収録: Stories / Reelsのセーフゾーンの正確な割合。"],
  rules: [
    withSource(
      {
        id: "meta-image-spec",
        name: "画像規格",
        description: "4:5、推奨1440×1800px、最小600×750px、JPG/PNG、30MB以下を機械照合する。",
        criteria: "実寸・アスペクト比・拡張子・ファイル容量を決定論で照合する。AIには判定させない。",
        kind: "machine",
      },
      { sourceUrl: SOURCES.metaSpecs },
    ),
    ...commonAiRules("meta", SOURCES.metaStandards),
    withSource(
      {
        id: "meta-personal-attributes",
        name: "個人属性の示唆",
        description: "閲覧者本人の属性を知っているかのような表現がないか。",
        criteria:
          "閲覧者本人の人種、宗教、年齢、健康状態、経済状態等を知っている前提で断定・示唆する文言が読み取れたら high。対象者を一般的に説明するだけなら問題なし。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.metaPersonalAttributes },
    ),
    withSource(
      {
        id: "meta-before-after",
        name: "健康分野のビフォーアフター",
        description: "人体の使用前後・施術前後を対比していないか。",
        criteria:
          "健康、美容、減量、施術の文脈で人体の使用前後・施術前後を並置または対比した構成が読み取れたら high。人体でない商品の状態変化は該当しない。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.metaHealth },
    ),
    withSource(
      {
        id: "meta-legacy-text-20",
        name: "旧20%テキストルール（廃止済み）",
        description: "20%超を違反扱いせず、読みやすさだけを案内する情報ルール。",
        criteria:
          "Metaの画像内テキスト20%ルールは2020年に廃止済み。文字面積が20%を超えた事実だけでは絶対に指摘しない。文字が密集して著しく読みにくい場合に限り low の読みやすさ推奨として挙げ、規則違反ではないと明記する。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.metaLegacyText, confidence: "medium" },
    ),
    ...legalCautionRules("meta"),
  ],
};

const GOOGLE_ADS: RegulationRuleSet = {
  id: "google-ads",
  name: "Google広告",
  description: "2026年8月確認のGoogle広告向け。1.91:1・1:1・4:5と主要表現を検査する。",
  notes: [],
  rules: [
    withSource(
      {
        id: "google-image-spec",
        name: "画像規格",
        description: "1.91:1・1:1・4:5、JPG/PNGを機械照合する。",
        criteria:
          "実寸からアスペクト比を計算し、拡張子と合わせて決定論で照合する。正本に無い最小寸法は判定しない。",
        kind: "machine",
      },
      { sourceUrl: SOURCES.googleSpecs },
    ),
    ...commonAiRules("google", SOURCES.googlePolicies),
    // v1では外周10%に重要要素があるかを座標だけで確実に判定できない。
    // 将来: OCR/物体bboxが安定した時点で中央80%の座標判定を機械チェックへ移す。
    withSource(
      {
        id: "google-center-80",
        name: "重要要素は中央80%",
        description: "外周10%ずつに重要要素を置かないGoogleの推奨をAIで注意喚起する。",
        criteria:
          "ロゴ、商品、主要人物、重要な文字が画像の外周10%領域にかかり、配信時の切り抜きで欠けるおそれが高い場合は mid。v1は注意喚起であり、座標による決定論の合否ではない。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.googleSpecs },
    ),
    ...legalCautionRules("google"),
  ],
};

const LINE_ADS: RegulationRuleSet = {
  id: "line-ads",
  name: "LINE広告",
  description: "2026年8月確認のLINE静止画広告向け。入稿寸法と主要表現を検査する。",
  notes: [],
  rules: [
    withSource(
      {
        id: "line-image-spec",
        name: "画像規格",
        description: "1200×628px・1080×1080px、JPG/PNG、10MB以下を機械照合する。",
        criteria: "実寸・アスペクト比・拡張子・ファイル容量を決定論で照合する。AIには判定させない。",
        kind: "machine",
      },
      { sourceUrl: SOURCES.lineSpecs },
    ),
    ...commonAiRules("line", SOURCES.lineGuideline),
    ...legalCautionRules("line"),
  ],
};

const TIKTOK_ADS: RegulationRuleSet = {
  id: "tiktok-ads",
  name: "TikTok広告",
  description: "2026年8月確認のTikTokカルーセル広告向け。画像規格と主要表現を検査する。",
  notes: ["未確認のため未収録: TikTok In-Feed単体画像の規格、縦型セーフゾーンの数値。"],
  rules: [
    withSource(
      {
        id: "tiktok-image-spec",
        name: "カルーセル画像規格",
        description: "1200×628px・640×640px・720×1280px、JPG/PNG、100KB以下推奨を機械照合する。",
        criteria:
          "実寸・アスペクト比・拡張子・ファイル容量を決定論で照合する。100KBは必須上限ではなく推奨として扱う。AIには判定させない。",
        kind: "machine",
      },
      { sourceUrl: SOURCES.tiktokSpecs },
    ),
    ...commonAiRules("tiktok", SOURCES.tiktokPolicies),
    withSource(
      {
        id: "tiktok-before-after",
        name: "ビフォーアフター比較",
        description: "商品の効果を使用前後で対比していないか。",
        criteria:
          "商品の効果について使用前後を並置・対比した構成が読み取れたら high。人体、肌、髪、歯などの変化を含む。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.tiktokMisleading },
    ),
    ...legalCautionRules("tiktok"),
  ],
};

const X_ADS: RegulationRuleSet = {
  id: "x-ads",
  name: "X広告",
  description: "2026年8月確認のX静止画広告向け。対応アスペクト比と法務注意を検査する。",
  notes: ["未確認のため未収録: X Quality Policyの詳細本文。"],
  rules: [
    withSource(
      {
        id: "x-image-spec",
        name: "画像規格",
        description: "1.91:1・1:1・4:5・2:3・16:9・9:16と画像形式を機械照合する。",
        criteria:
          "実寸からアスペクト比を計算し、拡張子と合わせて決定論で照合する。正本に無い最小寸法は判定しない。",
        kind: "machine",
      },
      { sourceUrl: SOURCES.xSpecs },
    ),
    ...commonAiRules("x", SOURCES.xPolicies),
    ...legalCautionRules("x"),
  ],
};

const YAHOO_ADS: RegulationRuleSet = {
  id: "yahoo-ads",
  name: "Yahoo!広告",
  description: "2026年8月確認のYahoo!広告向け。主体者表示と主要表現を検査する。",
  notes: ["未確認のため未収録: Yahoo!広告の画像サイズ・アスペクト比・ファイル形式。"],
  rules: [
    ...commonAiRules("yahoo", SOURCES.yahooGuideline, SOURCES.yahooSuperlative),
    withSource(
      {
        id: "yahoo-advertiser-identity",
        name: "広告主体者名の表示",
        description: "広告主名が画像内に明記され、読める状態か。",
        criteria:
          "広告主体者名が画像内に無い、または文字が潰れる・背景と同化する等で読めない場合は high。視認できる主体者名があれば問題なし。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.yahooIdentity },
    ),
    withSource(
      {
        id: "yahoo-medical-before-after",
        name: "医療分野のビフォーアフター",
        description: "医療の治療前後を誤認させる形で対比していないか。",
        criteria:
          "医療・施術の文脈で治療前後の写真や効果を対比し、必要な詳細説明が確認できず誤認のおそれがある場合は high。最終的な適法性は法務確認が必要と明記する。",
        kind: "ai",
      },
      { sourceUrl: SOURCES.yahooGuideline },
    ),
    ...legalCautionRules("yahoo"),
  ],
};

/** 既定の媒体プリセット一覧。UI のセレクタに並ぶ順。 */
export const DEFAULT_RULE_SETS: readonly RegulationRuleSet[] = [
  META_ADS,
  GOOGLE_ADS,
  LINE_ADS,
  TIKTOK_ADS,
  X_ADS,
  YAHOO_ADS,
] as const;

/** 自由記述ルールに割り当てる固定 id。issue 突き合わせと重複防止に使う。 */
export const CUSTOM_RULE_ID = "custom-user-rule";

/** 選択中プリセットへ、ユーザーの自由記述ルール（あれば）を1件合流させる。 */
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
    kind: "ai",
    checkedAt: CHECKED_AT,
    confidence: "medium",
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
