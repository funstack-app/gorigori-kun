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

const GOOGLE_ADS: RegulationRuleSet = {
  id: "google-ads",
  name: "Google広告",
  description:
    "Google広告（P-MAX/ディスプレイ/デマンドジェネレーション）向け。画質規定・編集品質・クリックベイト・虚偽表現を検査する。",
  rules: [
    {
      id: "google-image-quality",
      name: "画質・向き・フレーム",
      description: "Google の画質ポリシー（不鮮明・傾き・余白・フレーム逸脱）に適合するか。",
      criteria:
        "次のいずれかが読み取れたら high: (a) 画像が横倒し・上下逆になっている、(b) 被写体や構図が枠いっぱいに収まらず意図しない余白・レターボックスが生じている、(c) 全体的にボケている/低解像度で輪郭がつぶれている、(d) 文字が判読不能なほど潰れている。軽度のソフトフォーカスや意図的な被写界深度は該当しない。いずれも無ければ問題なし。出典: Image quality（support.google.com/adspolicy/answer/14848199）",
    },
    {
      id: "google-distracting-visual",
      name: "点滅・過剰な視覚刺激",
      description: "ストロボ・点滅など注意をそらす表現がないか。",
      criteria:
        "強い明滅を想起させる高コントラストの縞・放射状フラッシュ・残像的な多重露光など、ストロボ/点滅表現として審査されうる視覚要素が主要面積を占めていたら mid。装飾的な光彩や自然な光源表現は該当しない。無ければ問題なし。出典: Image quality（support.google.com/adspolicy/answer/14848199）",
    },
    {
      id: "google-fake-ui-element",
      name: "UI偽装・警告画面模倣",
      description: "システム警告・エラー画面・偽の操作要素を模倣していないか。",
      criteria:
        "OSやブラウザの警告ダイアログ・エラーメッセージ・ウイルス検知画面を模した意匠、または実際には機能しない閉じるボタン（×）・再生ボタン・チェックボックス等の偽の操作要素が読み取れたら high。ブランド独自デザインのCTAボタンは該当しない。出典: Image ad requirements（support.google.com/adspolicy/answer/176108）",
    },
    {
      id: "google-editorial-quality",
      name: "編集品質（記号・大文字・反復）",
      description: "ギミック的な記号・大文字・語の反復がないか。",
      criteria:
        "次が読み取れたら mid: (a) 同じ語・社名の不自然な繰り返し、(b) 意味のない過剰な字間/スペース、(c) 用法から外れた大文字の多用（例: SALE を S A L E や SaLe と表記）、(d) 記号や句読点の逸脱した使用（例: S@LE、!!!!! の連打）。通常の強調表現は該当しない。出典: Editorial（support.google.com/adspolicy/answer/6021546）",
    },
    {
      id: "google-clickbait-sensational",
      name: "クリックベイト・扇情表現",
      description: "煽り・ビフォーアフター・身体部位の強調など扇情的表現がないか。",
      criteria:
        "次のいずれかが読み取れたら high: (a) 身体の一部を明らかに加工/拡大した画像（体型・肌・患部のズームなど）、(b) 身体変化を訴求する before/after 並置、(c) 事故・災害・遺体・逮捕写真など実際の惨事の画像、(d) 死・病気・破産などの不幸を用いて恐怖や罪悪感を煽る構成。「続きはクリック」「衝撃の結末」等の内容を伏せて誘導する文言は mid。出典: Clickbait ads（support.google.com/adspolicy/answer/15936667）",
    },
    {
      id: "google-unrealistic-claim",
      name: "非現実的・保証的な効果表現",
      description: "改善が見込めない結果を確実であるかのように訴求していないか。",
      criteria:
        "「必ず」「確実に」「保証」「〇日で〇kg」「誰でも稼げる」等、実現が不確実な結果を確約する表現が読み取れたら high。数値実績に出典・調査年・条件の併記が視認できる場合は low。該当表現が無ければ問題なし。出典: False, misleading, or unrealistic claims（support.google.com/adspolicy/answer/6086777）",
    },
    {
      id: "google-advertiser-identity",
      name: "広告主体の明示",
      description: "何を・誰が提供する広告か画像から分かるか。",
      criteria:
        "商品名・サービス名・提供事業者のいずれも画像内に読み取れず、何の広告か判別できない場合は mid。ロゴまたは商品名のどちらかが視認できれば問題なし。出典: Editorial「Ads or destinations that don't name the product, service, or entity they are promoting」（support.google.com/adspolicy/answer/6021546）",
    },
  ],
};

const YAHOO_ADS: RegulationRuleSet = {
  id: "yahoo-ads",
  name: "Yahoo!広告",
  description:
    "LINEヤフー広告（ディスプレイ/検索）向け。最上級表示の根拠併記・主体者明示・視認性・誤認表現を検査する。",
  rules: [
    {
      id: "yahoo-superlative-evidence",
      name: "最上級・No.1表示の根拠",
      description: "最上級表現に出典・調査機関・調査年が近接表示されているか。",
      criteria:
        "「No.1」「日本一」「最高」「最大」「最速」「最安」「世界初」等の最上級・順位表示が読み取れる場合、同一クリエイティブ内の近接した位置に (a) 調査データの出典、(b) 調査機関名、(c) 調査年 の3点が視認できなければ high。3点が併記され判読可能なら問題なし。調査年が2年以上前と読み取れる場合は mid（直近1年以内の調査が要件のため）。最上級表現自体が無ければ問題なし。出典: Yahoo!広告ヘルプ「最上級表示、No.1 表示」（ads-help.yahoo-net.jp/s/article/H000044774）",
    },
    {
      id: "yahoo-advertiser-identity",
      name: "主体者名の明示",
      description: "広告主体（正式な社名）が画像内で判別できるか。",
      criteria:
        "広告主体を示す社名表記が画像内に読み取れなければ mid。表記があっても (a) 略称・部署名・サービス愛称のみ、(b) 商品ロゴのみで社名が無い、のいずれかなら mid。正式な社名が視認できれば問題なし。出典: LINEヤフー for Business「違反の多い広告掲載基準」（lycbiz.com/jp/column/ly-ads/guideline/2020082430131350/）",
    },
    {
      id: "yahoo-text-legibility",
      name: "文字の視認性",
      description: "画像内の文字、特に主体者名が潰れず判読できるか。",
      criteria:
        "画像内の文字（特に社名・注記・打消し表記）が潰れている、背景と同化している、極端に小さいなどで判読不可能なら high（主体者名が視認不可能な広告は掲載できないため）。装飾的なキャッチのみが読みにくい場合は mid。すべて判読可能なら問題なし。出典: 「画像広告上に記載した主体者名の文字が潰れていて視認不可能なものは掲載できません」（lycbiz.com/jp/column/ly-ads/guideline/2020082430131350/）",
    },
    {
      id: "yahoo-misleading-design",
      name: "誤操作の誘導・デザイン模倣",
      description: "サービスUIの模倣や広告境界の不明瞭さがないか。",
      criteria:
        "次のいずれかが読み取れたら high: (a) Yahoo!/LINE 等のサービス画面・通知・UIパーツを模した意匠、(b) 実際には機能しない閉じるボタン・再生ボタン・チェックボックス等、(c) 広告と記事/コンテンツの境界が意図的に曖昧で広告と分からない構成。ブランド独自デザインのCTAは該当しない。出典: Yahoo!広告ヘルプ「ユーザーに誤解を与えるような表現」（ads-help.yahoo-net.jp/s/article/H000044785）",
    },
    {
      id: "yahoo-undue-representation",
      name: "不当表示・優良誤認",
      description: "実際や競合より著しく優良・有利と誤認させる表示がないか。",
      criteria:
        "価格・内容・効果について、実際のものや競合より著しく優良/有利であるとユーザーに誤認させる表示（根拠なき「他社の半額」「業界最安」「効果〇倍」等）が読み取れたら high。根拠・条件・調査出典の併記が視認できれば low。該当表現が無ければ問題なし。出典: LINEヤフー広告 広告掲載基準（ads-help.yahoo-net.jp/s/guideline-editorial）",
    },
    {
      id: "yahoo-disclaimer-visibility",
      name: "打消し表記の視認性",
      description: "体験談・効果訴求に対応する打消し表記が判読可能な形であるか。",
      criteria:
        "体験談・効果・成果を訴求する文言（例: 〇kg減、〇円稼げた、満足度〇%）が読み取れる場合、対応する打消し表記（個人の感想です／効果には個人差があります／当社調べ 等）が同一画像内にあり、かつ判読可能なサイズ・コントラストでなければ high。表記があっても潰れて読めないものは表記なしと同じ扱いにする。訴求文言自体が無ければ問題なし。出典: LINEヤフー広告 広告掲載基準 第9章 広告表現規制（ads-help.yahoo-net.jp/s/guideline-editorial）",
    },
  ],
};

const META_ADS: RegulationRuleSet = {
  id: "meta-ads",
  name: "Meta広告",
  description:
    "Meta広告（Facebook/Instagram）向け。パーソナル属性の言及・ビフォーアフター・身体描写・誇大表現を検査する。",
  rules: [
    {
      id: "meta-personal-attributes",
      name: "パーソナル属性への言及",
      description: "閲覧者本人の属性を知っているかのような表現がないか。",
      criteria:
        "人種・民族・宗教・信条・年齢・性的指向・性自認・障害・心身の健康状態（病歴含む）・経済的困窮・投票状況・労働組合加入・犯罪歴・氏名 のいずれかについて、閲覧者本人がそうであると断定/示唆する表現が読み取れたら high。判定の勘所は「相手を知っている前提か」で、『あなたは〇〇ですか?』『他の〇〇の人はこちら』は NG、『〇〇の方向けサービス』のように対象を述べるだけなら問題なし。該当表現が無ければ問題なし。出典: Privacy Violations and Personal Attributes（transparency.meta.com/policies/ad-standards/objectionable-content/privacy-violations-personal-attributes/）",
    },
    {
      id: "meta-before-after",
      name: "ビフォーアフター表現",
      description: "施術・化粧品等の変化を並置した比較画像がないか。",
      criteria:
        "美容・healthcare・ダイエット・整形などの文脈で、使用前後・施術前後の変化を並置または矢印等で対比した構成が読み取れたら high。商品そのものの状態変化（汚れが落ちる等、人体でないもの）は該当しない。出典: Health and Wellness「General cosmetic products, procedures, surgeries depicting before and after transformation」（transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/）",
    },
    {
      id: "meta-body-inferiority",
      name: "外見に対する否定的表現",
      description: "体型・容姿・衛生を否定的に扱っていないか。",
      criteria:
        "体型・容姿・特定の身体部位・衛生状態を否定的に指摘したり、劣っていると示唆する文言や描写（例: 『その体型で大丈夫?』『汚い〇〇』、コンプレックスを煽る対比）が読み取れたら high。ポジティブな訴求のみなら問題なし。出典: Health and Wellness（transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/）",
    },
    {
      id: "meta-zoomed-body-part",
      name: "身体部位のクローズアップ",
      description: "脂肪をつまむ等、特定部位を強調した描写がないか。",
      criteria:
        "腹部の脂肪をつまむ、二の腕・太もも等の特定部位を単独で大きく映すなど、身体の一部を強調して問題を意識させる構図が読み取れたら high。全身の自然なポーズやライフスタイル描写は該当しない。出典: Health and Wellness「Close up on specific body area by pinching fat」（transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/）",
    },
    {
      id: "meta-health-clickbait",
      name: "健康・減量文脈の断定的訴求",
      description: "期間を区切った成果の断定に打消しがあるか。",
      criteria:
        "健康・減量・増量の文脈で「〇日で〇kg」「1週間で効果」等、期間を区切った具体的成果を約束する表現が読み取れる場合、打消し・条件注記（効果には個人差があります 等）が同一画像内に視認できなければ high。注記が判読可能な形であれば mid。該当表現が無ければ問題なし。出典: Health and Wellness（transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/）",
    },
    {
      id: "meta-deceptive-claim",
      name: "誇大表現・著名人の無断利用",
      description: "成果の誇張、または著名人画像による誘引がないか。",
      criteria:
        "(a) 商品/サービスの成果について誇張・虚偽と読み取れる断定（『絶対儲かる』『100%成功』等）、(b) 著名人・公人の顔写真を推薦であるかのように用いた構成（許諾の明示が読み取れないもの）、(c) 報道機関やロゴを装った意匠 のいずれかが読み取れたら high。出典: Unacceptable Business Practices（transparency.meta.com/policies/ad-standards/fraud-scams/unacceptable-business-practices/）",
    },
    {
      id: "meta-shocking-content",
      name: "衝撃的・扇情的表現",
      description: "ショッキングな画像や過度に扇情的な表現がないか。",
      criteria:
        "流血・患部・害虫・事故現場など不快感や衝撃を与える画像、または過度に扇情的な演出が主要面積を占めていたら high。医療・啓発文脈でも配慮のない直接描写は同様に扱う。無ければ問題なし。出典: Introduction to the Advertising Standards「shocking, sensational or excessively violent content」（transparency.meta.com/policies/ad-standards/）",
    },
  ],
};

const TIKTOK_ADS: RegulationRuleSet = {
  id: "tiktok-ads",
  name: "TikTok広告",
  description:
    "TikTok広告向け。解像度・黒帯・不完全な文字・偽の操作要素・誇大表現を検査する。",
  rules: [
    {
      id: "tiktok-visual-quality",
      name: "解像度・鮮明さ",
      description: "低解像度・不鮮明・被写体が判別できない画像でないか。",
      criteria:
        "全体または主要被写体がボケている、圧縮ノイズやジャギーが目立つ、低解像度を引き伸ばしたと読み取れる、被写体が判別できない、のいずれかなら high。TikTok は「blurry, unclear, and unrecognizable visuals」を明示的に不可としている。鮮明であれば問題なし。出典: Ad Format and Functionality（ads.tiktok.com/help/article/tiktok-ads-policy-ad-format-and-functionality）",
    },
    {
      id: "tiktok-black-bar-cover",
      name: "黒帯・部分的な被覆",
      description: "黒帯やモザイクで画面の一部が覆われていないか。",
      criteria:
        "上下または左右の黒帯・単色帯で本来の画面が縮小されている、モザイク/ピクセル化で一部が潰されている、ステッカーで文字やロゴが覆われている、のいずれかなら high。ただし単色の帯や枠は、主要なクリエイティブ内容が重なりなく明瞭に視認できる場合は許容されるため、その場合は low。出典: Common Reasons Ads Fail Review（ads.tiktok.com/help/article/common-reasons-ads-fail-review）",
    },
    {
      id: "tiktok-incomplete-text",
      name: "文字の欠け・可読性",
      description: "文字が見切れていないか、判読できるか。",
      criteria:
        "画像内の文字が枠外で見切れている、行が途中で切れている、判読できないほど小さい/潰れている場合は high。加えて次は mid: (a) 過剰で読みにくい大文字化（例: S.a.L.e）、(b) 記号による文字置換（例: S@le）、(c) 明らかなスペルミス。出典: Ad Format and Functionality / Common Reasons Ads Fail Review（ads.tiktok.com/help/article/tiktok-ads-policy-ad-format-and-functionality）",
    },
    {
      id: "tiktok-invalid-button",
      name: "偽の操作要素・誘導ジェスチャー",
      description: "実際には機能しないボタンや操作誘導がないか。",
      criteria:
        "実際には反応しない再生ボタン・閉じるボタン（×）・チェックボックス・進捗バー等、あるいは「上にスワイプ」「ここをタップ」など画像上では機能しない操作を促す表現が読み取れたら high。TikTok は「buttons, gestures, or text that portray unsupported functionality」を明示的に不可としている。ブランド独自デザインのCTAは該当しない。出典: Ad Format and Functionality（ads.tiktok.com/help/article/tiktok-ads-policy-ad-format-and-functionality）",
    },
    {
      id: "tiktok-exaggerated-result",
      name: "効果の誇張・即効性の約束",
      description: "商品効果について過度な約束をしていないか。",
      criteria:
        "「すぐに痩せる」「10秒で稼げる」等、効果の即時性や確実性を約束する表現が読み取れたら high。TikTok は「must not promise or exaggerate results concerning a product's effect」としている。条件・個人差の注記が判読可能な形で併記されていれば mid。該当表現が無ければ問題なし。出典: Misleading and false content（ads.tiktok.com/help/article/tiktok-ads-policy-misleading-and-false-content）",
    },
    {
      id: "tiktok-before-after",
      name: "ビフォーアフター比較",
      description: "使用前後の効果比較を並置していないか。",
      criteria:
        "商品の効果について使用前後を並置・対比した構成（人体・肌・髪・歯などの変化）が読み取れたら high。TikTok は before-and-after 型の効果比較を明示的に不可としている。出典: Misleading and false content（ads.tiktok.com/help/article/tiktok-ads-policy-misleading-and-false-content）",
    },
    {
      id: "tiktok-absolute-claim",
      name: "絶対表現・順位表示",
      description: "時期・地域・ブランドに関する絶対表現に根拠があるか。",
      criteria:
        "「No.1」「世界初」「最速」「業界唯一」等、時期・地域・ブランドに関する絶対表現が読み取れる場合、根拠（出典・調査機関・調査年）が同一画像内に視認できなければ high。根拠が判読可能な形で併記されていれば low。該当表現が無ければ問題なし。出典: Misleading and false content（ads.tiktok.com/help/article/tiktok-ads-policy-misleading-and-false-content）",
    },
    {
      id: "tiktok-third-party-logo",
      name: "第三者ロゴ・ウォーターマーク",
      description: "無断の他社ロゴやぼかしたウォーターマークがないか。",
      criteria:
        "許諾が読み取れない他社ロゴ・商標（TikTok自身のロゴやUIを含む）が使われている場合は high。第三者のウォーターマークをぼかす/隠す処理が読み取れる場合も high。自社ロゴのみなら問題なし。出典: Ad Format and Functionality / Common Reasons Ads Fail Review（ads.tiktok.com/help/article/common-reasons-ads-fail-review）",
    },
  ],
};

/** 既定の媒体プリセット一覧。UI のセレクタに並ぶ順。 */
export const DEFAULT_RULE_SETS: readonly RegulationRuleSet[] = [
  GENERIC_SNS_AD,
  YOUTUBE_THUMBNAIL,
  EC_PRODUCT_IMAGE,
  GOOGLE_ADS,
  YAHOO_ADS,
  META_ADS,
  TIKTOK_ADS,
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
