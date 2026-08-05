/**
 * スタンプの「中身の方向」カタログ（設計書 v3 §1.3・STΛCK決定3）。
 *
 * ## なぜ4プリセットなのか
 *
 * 実測ランキング（`sticker-craft-research.md` §1-1、n=232）は**上位10位が全て社会的儀礼**
 * （ありがとう / おはよう / OK！/ ごめんね / 了解！…）で、感情表現が1つも入らない。
 * このデータは強いが、**全員をここに寄せない**のが STΛCK決定3。売れ線に全員を寄せると
 * 出てくるスタンプが全部同じになる。方向自体を選べるようにする。
 *
 * ## 枚数配分テンプレは持たない
 *
 * `sticker-craft-research.md` §1-2 が複数クエリで確認したとおり、
 * **「40枚の内訳テンプレ（挨拶n枚・返事n枚…）」は業界に存在しない**。どの資料も
 * 「ターゲット次第」としている。存在しないものを発明して権威づけしない
 * （no-silent-gap-filling）。
 *
 * 代わりに **カテゴリ順に並べた配列の先頭から、選んだ枚数だけ採る**単純な規則にする。
 * 並び順そのものが配分になり、ユーザーはチェックリストで差し替えられる。
 *
 * ## セリフ文字を焼き込まない
 *
 * `entries` の `label` は**UIでの識別と、ユーザーが後から文字入れする際の目安**であって、
 * プロンプトに文字として渡すものではない。理由は2つ、どちらも実測:
 *
 * 1. 審査NG「単純なテキストのみの画像」を踏むリスク
 * 2. AIに日本語文字を描かせると崩れる（同 §1-5・§3-2。漢字は画数が多く透過時に欠け、
 *    白文字は背景と判別されて一緒に抜ける）
 *
 * プロンプトへ渡すのは `promptFragment`（表情・ポーズの英語記述）だけ。
 * 文字入れは既存の編集機能でユーザーが決定論的に行う。
 */

/** プリセットID。 */
export type StickerToneId = "basic" | "playful" | "polite" | "reaction";

/** カタログ1件＝スタンプ1枚に対応する。 */
export type StickerEntry = {
  /** 一意ID。生成カットのキー・出力ファイル名の素材に使う（`stk-` プレフィックスで衝突回避）。 */
  id: string;
  /** UI 表示名（日本語）。**プロンプトには渡さない**（文字は焼き込まない）。 */
  label: string;
  /** 生成カットの role 値。 */
  role: string;
  /** 表情・ポーズの英語プロンプト断片。文字・吹き出しの指示を含めない。 */
  promptFragment: string;
};

export type StickerCatalog = {
  id: StickerToneId;
  /** UI 表示名。 */
  label: string;
  /** 1行説明。何が入るかを言う。 */
  description: string;
  /** 40件以上。選んだ枚数だけ先頭から採る。 */
  entries: StickerEntry[];
};

/**
 * 基本形（挨拶・返事中心）。実測ランキング上位帯そのまま。
 * 出典: `sticker-craft-research.md` §1-1 の1〜20位。
 */
const BASIC_ENTRIES: StickerEntry[] = [
  { id: "stk-thanks", label: "ありがとう", role: "sticker-thanks", promptFragment: "grateful happy expression, slight bow of the head, both hands together in thanks" },
  { id: "stk-morning", label: "おはよう", role: "sticker-morning", promptFragment: "fresh cheerful morning expression, one hand raised in a small wave, bright eyes" },
  { id: "stk-ok", label: "OK！", role: "sticker-ok", promptFragment: "confident bright smile, making a clear OK ring gesture with one hand" },
  { id: "stk-sorry", label: "ごめんね", role: "sticker-sorry", promptFragment: "apologetic expression, slanted brows, one hand raised flat in front of the face in apology" },
  { id: "stk-roger", label: "了解！", role: "sticker-roger", promptFragment: "brisk positive expression, casual salute with one hand at the brow" },
  { id: "stk-goodwork", label: "おつかれさま", role: "sticker-goodwork", promptFragment: "warm relieved smile, gentle relaxed shoulders, one hand offering a small pat" },
  { id: "stk-congrats", label: "おめでとう", role: "sticker-congrats", promptFragment: "delighted celebratory expression, both arms raised high in celebration" },
  { id: "stk-goodnight", label: "おやすみ", role: "sticker-goodnight", promptFragment: "sleepy contented expression, eyes closed, palms pressed together beside the cheek" },
  { id: "stk-leaving", label: "いってきます", role: "sticker-leaving", promptFragment: "energetic forward-leaning pose, one hand waving, ready to head out" },
  { id: "stk-imhome", label: "ただいま", role: "sticker-imhome", promptFragment: "relaxed happy expression arriving home, one hand raised in a soft greeting" },
  { id: "stk-yes", label: "はーい", role: "sticker-yes", promptFragment: "cheerful agreeable expression, one arm raised straight up answering a call" },
  { id: "stk-thanks-warm", label: "ありがとう〜！", role: "sticker-thanks-warm", promptFragment: "beaming overjoyed smile, sparkling eyes, both hands clasped near the chest in delight" },
  { id: "stk-amazing", label: "すごい！", role: "sticker-amazing", promptFragment: "impressed astonished expression, wide eyes, both hands raised in admiration" },
  { id: "stk-nice", label: "いいね！", role: "sticker-nice", promptFragment: "approving satisfied smile, clear thumbs-up with one hand" },
  { id: "stk-hungry", label: "おなかすいた", role: "sticker-hungry", promptFragment: "hungry pleading expression, one hand resting on the stomach, slightly drooping posture" },
  { id: "stk-whereareyou", label: "今どこ？", role: "sticker-whereareyou", promptFragment: "questioning expression, head tilted, one hand shading the eyes while looking around" },
  { id: "stk-areyouok", label: "だいじょうぶ？", role: "sticker-areyouok", promptFragment: "concerned caring expression, slightly leaning forward, one hand reaching out gently" },
  { id: "stk-roger-polite", label: "了解です！", role: "sticker-roger-polite", promptFragment: "attentive polite expression, upright posture, one hand flat against the chest" },
  { id: "stk-exhausted", label: "しんどい…", role: "sticker-exhausted", promptFragment: "worn out expression, half-closed eyes, shoulders slumped, head drooping" },
  { id: "stk-goodwork-casual", label: "お疲れ〜", role: "sticker-goodwork-casual", promptFragment: "easygoing relaxed smile, one hand raised in a loose casual wave" },
  { id: "stk-hello", label: "こんにちは", role: "sticker-hello", promptFragment: "friendly open smile, one hand raised at shoulder height in greeting" },
  { id: "stk-regards", label: "よろしく", role: "sticker-regards", promptFragment: "sincere polite expression, a small respectful bow with hands at the sides" },
  { id: "stk-goodbye", label: "さようなら", role: "sticker-goodbye", promptFragment: "gentle parting smile, one hand waving slowly, slight backward lean" },
  { id: "stk-youre-welcome", label: "どういたしまして", role: "sticker-youre-welcome", promptFragment: "modest warm smile, one hand waving off the thanks lightly" },
  { id: "stk-isee", label: "なるほど〜", role: "sticker-isee", promptFragment: "understanding expression, one hand on the chin, eyes slightly narrowed in thought" },
  { id: "stk-checking", label: "確認します", role: "sticker-checking", promptFragment: "focused attentive expression, looking down at something held in both hands" },
  { id: "stk-onemoment", label: "少々お待ちください", role: "sticker-onemoment", promptFragment: "polite apologetic expression, one palm raised forward asking to wait" },
  { id: "stk-cheerup", label: "がんばって！", role: "sticker-cheerup", promptFragment: "encouraging bright expression, both fists raised at chest height in support" },
  { id: "stk-sorry-deep", label: "ごめんなさい〜", role: "sticker-sorry-deep", promptFragment: "deeply apologetic expression, head lowered in a full bow, both hands together" },
  { id: "stk-takecare", label: "お大事に", role: "sticker-takecare", promptFragment: "gentle worried smile, one hand held softly against the chest" },
  { id: "stk-yay", label: "やったー！", role: "sticker-yay", promptFragment: "triumphant joyful expression, jumping pose with both arms thrown upward" },
  { id: "stk-seeyou", label: "またね！", role: "sticker-seeyou", promptFragment: "bright cheerful smile, one hand waving energetically" },
  { id: "stk-sleeping", label: "寝るね〜", role: "sticker-sleeping", promptFragment: "drowsy expression, one hand covering a yawn, eyes nearly closed" },
  { id: "stk-happy", label: "嬉しい", role: "sticker-happy", promptFragment: "genuinely happy expression, cheeks lifted, both hands raised near the face in joy" },
  { id: "stk-sad", label: "落ち込む", role: "sticker-sad", promptFragment: "downcast expression, eyes lowered, shoulders drawn in, head tilted down" },
  { id: "stk-angry", label: "怒る", role: "sticker-angry", promptFragment: "angry expression, furrowed brows, both fists clenched at the sides" },
  { id: "stk-surprised", label: "驚く", role: "sticker-surprised", promptFragment: "startled expression, wide open eyes and mouth, both hands raised in surprise" },
  { id: "stk-crying", label: "泣く", role: "sticker-crying", promptFragment: "crying expression, large tears, both hands rubbing the eyes" },
  { id: "stk-thinking", label: "悩む", role: "sticker-thinking", promptFragment: "troubled pondering expression, arms folded, head tilted to one side" },
  { id: "stk-applause", label: "拍手", role: "sticker-applause", promptFragment: "delighted expression, both hands clapping together in front of the chest" },
  { id: "stk-waiting", label: "待ってる", role: "sticker-waiting", promptFragment: "patiently waiting expression, chin resting on one propped-up hand" },
  { id: "stk-please", label: "おねがい", role: "sticker-please", promptFragment: "pleading hopeful expression, both palms pressed together in front of the face" },
];

/**
 * ふざけた系。
 * 出典: `sticker-craft-research.md` §1-2「ポジティブな感情表現」「その他」カテゴリ。
 */
const PLAYFUL_ENTRIES: StickerEntry[] = [
  { id: "stk-smug", label: "ドヤ顔", role: "sticker-smug", promptFragment: "smug self-satisfied expression, chin raised, one hand on the hip" },
  { id: "stk-dodge", label: "ごまかす", role: "sticker-dodge", promptFragment: "awkward evasive smile, eyes darting to the side, one hand scratching the cheek" },
  { id: "stk-escape", label: "現実逃避", role: "sticker-escape", promptFragment: "vacant far-away stare, blank expression, both hands limp at the sides" },
  { id: "stk-whatever", label: "テキトー", role: "sticker-whatever", promptFragment: "careless indifferent expression, one shoulder shrugged, palms turned up" },
  { id: "stk-pun", label: "ダジャレ", role: "sticker-pun", promptFragment: "goofy proud grin, one finger raised as if delivering a joke, eyes closed in amusement" },
  { id: "stk-snicker", label: "含み笑い", role: "sticker-snicker", promptFragment: "mischievous suppressed laugh, one hand covering the mouth, narrowed knowing eyes" },
  { id: "stk-burst", label: "吹き出す", role: "sticker-burst", promptFragment: "bursting into laughter, head thrown back, both hands clutching the stomach" },
  { id: "stk-nomatter", label: "知らんけど", role: "sticker-nomatter", promptFragment: "detached breezy expression, both palms raised in an exaggerated shrug" },
  { id: "stk-showoff", label: "自慢げ", role: "sticker-showoff", promptFragment: "boastful beaming expression, chest puffed out, thumb pointed at own chest" },
  { id: "stk-sulk", label: "ふてくされ", role: "sticker-sulk", promptFragment: "sulking pouty expression, cheeks puffed, arms crossed tightly" },
  { id: "stk-sparkle", label: "キラキラ", role: "sticker-sparkle", promptFragment: "dazzling delighted expression, sparkling wide eyes, both hands framing the face" },
  { id: "stk-nod-fake", label: "適当なあいづち", role: "sticker-nod-fake", promptFragment: "half-listening expression, eyes wandering, one hand giving a lazy thumbs-up" },
  { id: "stk-panic", label: "焦る", role: "sticker-panic", promptFragment: "panicking expression, sweat on the brow, both hands waving frantically" },
  { id: "stk-dumbfounded", label: "呆れる", role: "sticker-dumbfounded", promptFragment: "exasperated expression, eyes half-lidded, one palm pressed to the forehead" },
  { id: "stk-drawback", label: "ドン引き", role: "sticker-drawback", promptFragment: "recoiling disgusted expression, leaning back, both hands raised defensively" },
  { id: "stk-scream", label: "叫ぶ", role: "sticker-scream", promptFragment: "screaming expression, mouth wide open, both hands on the cheeks" },
  { id: "stk-dance", label: "踊る", role: "sticker-dance", promptFragment: "joyful dancing pose, arms swinging, one leg lifted mid-step" },
  { id: "stk-run", label: "走る", role: "sticker-run", promptFragment: "running pose in a hurry, arms pumping, leaning forward" },
  { id: "stk-peek", label: "のぞく", role: "sticker-peek", promptFragment: "curious peeking expression, head tilted around an edge, one hand gripping the side" },
  { id: "stk-love", label: "好き", role: "sticker-love", promptFragment: "adoring blissful expression, both hands forming a heart shape near the chest" },
  { id: "stk-jealous", label: "うらやましい", role: "sticker-jealous", promptFragment: "envious longing expression, biting the lip, one hand reaching out weakly" },
  { id: "stk-embarrassed", label: "恥ずかしい", role: "sticker-embarrassed", promptFragment: "flustered blushing expression, both hands covering the face partly" },
  { id: "stk-scared", label: "怯える", role: "sticker-scared", promptFragment: "frightened trembling expression, hunched shoulders, both hands clutched near the chin" },
  { id: "stk-deadpan", label: "真顔", role: "sticker-deadpan", promptFragment: "completely deadpan expression, blank eyes, mouth a flat line, arms at the sides" },
  { id: "stk-best", label: "最高！", role: "sticker-best", promptFragment: "ecstatic expression, both thumbs up, eyes shining" },
  { id: "stk-fun", label: "楽しい", role: "sticker-fun", promptFragment: "gleeful playful expression, spinning pose with arms spread wide" },
  { id: "stk-relief", label: "安心", role: "sticker-relief", promptFragment: "relieved expression, exhaling, one hand resting on the chest" },
  { id: "stk-shock", label: "ショック", role: "sticker-shock", promptFragment: "stunned devastated expression, frozen wide eyes, body slightly petrified" },
  { id: "stk-complain", label: "不満", role: "sticker-complain", promptFragment: "displeased grumbling expression, lips pursed, arms folded" },
  { id: "stk-tired", label: "疲れた", role: "sticker-tired", promptFragment: "utterly drained expression, slumped forward, arms hanging loose" },
  { id: "stk-noreply", label: "返信不要", role: "sticker-noreply", promptFragment: "casual dismissive expression, one hand waving it off, turning slightly away" },
  { id: "stk-oshi", label: "推し活", role: "sticker-oshi", promptFragment: "fervent adoring expression, both fists clenched near the face in excitement" },
  { id: "stk-eating", label: "食べる", role: "sticker-eating", promptFragment: "happily eating expression, cheeks full, one hand holding food near the mouth" },
  { id: "stk-drinking", label: "飲む", role: "sticker-drinking", promptFragment: "refreshed expression after a drink, one hand holding a cup near the mouth" },
  { id: "stk-bath", label: "お風呂いってくる", role: "sticker-bath", promptFragment: "relaxed contented expression, a towel draped over the head" },
  { id: "stk-memo", label: "メモする", role: "sticker-memo", promptFragment: "focused expression, writing into a small notepad held in one hand" },
  { id: "stk-bored", label: "ひま〜", role: "sticker-bored", promptFragment: "bored listless expression, chin propped on one hand, eyes drifting" },
  { id: "stk-busy", label: "いま忙しい", role: "sticker-busy", promptFragment: "harried overwhelmed expression, both hands full, hurrying" },
  { id: "stk-sleepy", label: "ねむい…", role: "sticker-sleepy", promptFragment: "drowsy expression, eyes drooping half shut, head tipping to one side" },
  { id: "stk-sick", label: "体調不良", role: "sticker-sick", promptFragment: "unwell pale expression, one hand pressed to the forehead, weak posture" },
  { id: "stk-wakeup", label: "起きる", role: "sticker-wakeup", promptFragment: "just-woken expression, stretching both arms overhead, tousled look" },
  { id: "stk-hooray", label: "わーい", role: "sticker-hooray", promptFragment: "carefree elated expression, both arms flung up, feet off the ground" },
];

/**
 * ていねい系（敬語トーン）。
 * 出典: `sticker-craft-research.md` §1-2「あいさつ・連絡系」15項目を中心に構成。
 */
const POLITE_ENTRIES: StickerEntry[] = [
  { id: "stk-p-goodwork", label: "お疲れ様です", role: "sticker-p-goodwork", promptFragment: "courteous warm expression, a shallow polite bow, hands held together in front" },
  { id: "stk-p-thanks", label: "ありがとうございます", role: "sticker-p-thanks", promptFragment: "sincerely grateful expression, a deeper respectful bow, both hands at the sides" },
  { id: "stk-p-checking", label: "確認します", role: "sticker-p-checking", promptFragment: "attentive professional expression, looking down at documents held in both hands" },
  { id: "stk-p-onemoment", label: "少々お待ちください", role: "sticker-p-onemoment", promptFragment: "polite composed expression, one palm raised forward requesting a moment" },
  { id: "stk-p-understood", label: "承知しました", role: "sticker-p-understood", promptFragment: "attentive respectful expression, upright posture, one hand flat against the chest" },
  { id: "stk-p-apology", label: "申し訳ありません", role: "sticker-p-apology", promptFragment: "deeply apologetic expression, a full deep bow, head lowered" },
  { id: "stk-p-regards", label: "よろしくお願いします", role: "sticker-p-regards", promptFragment: "earnest polite expression, both hands together in front, a small bow" },
  { id: "stk-p-contact", label: "また連絡します", role: "sticker-p-contact", promptFragment: "reassuring professional smile, one hand raised in a measured wave" },
  { id: "stk-p-morning", label: "おはようございます", role: "sticker-p-morning", promptFragment: "crisp fresh morning expression, upright posture, a brief courteous bow" },
  { id: "stk-p-excuse", label: "失礼します", role: "sticker-p-excuse", promptFragment: "reserved polite expression, stepping back with a small bow" },
  { id: "stk-p-accept", label: "かしこまりました", role: "sticker-p-accept", promptFragment: "formal attentive expression, hands folded neatly, a respectful nod" },
  { id: "stk-p-help", label: "お手伝いします", role: "sticker-p-help", promptFragment: "willing helpful expression, sleeves rolled, both hands ready" },
  { id: "stk-p-takecare", label: "お大事になさってください", role: "sticker-p-takecare", promptFragment: "gently concerned expression, one hand held softly against the chest" },
  { id: "stk-p-congrats", label: "おめでとうございます", role: "sticker-p-congrats", promptFragment: "warm dignified smile, applauding politely with both hands" },
  { id: "stk-p-goodbye", label: "失礼いたします", role: "sticker-p-goodbye", promptFragment: "composed parting expression, a courteous bow before leaving" },
  { id: "stk-p-received", label: "拝受しました", role: "sticker-p-received", promptFragment: "attentive expression, receiving something with both hands respectfully" },
  { id: "stk-p-ask", label: "お伺いします", role: "sticker-p-ask", promptFragment: "inquiring polite expression, head slightly tilted, one hand raised modestly" },
  { id: "stk-p-consider", label: "検討します", role: "sticker-p-consider", promptFragment: "thoughtful measured expression, one hand at the chin, eyes lowered in consideration" },
  { id: "stk-p-report", label: "ご報告です", role: "sticker-p-report", promptFragment: "composed professional expression, presenting a document with both hands" },
  { id: "stk-p-thanksinadvance", label: "お願いいたします", role: "sticker-p-thanksinadvance", promptFragment: "earnest requesting expression, both palms together, a deep bow of the head" },
  { id: "stk-p-sorry-late", label: "遅くなりました", role: "sticker-p-sorry-late", promptFragment: "apologetic hurried expression, slight bow while stepping forward" },
  { id: "stk-p-agree", label: "同意します", role: "sticker-p-agree", promptFragment: "affirming composed expression, a single clear nod, hands at the sides" },
  { id: "stk-p-decline", label: "見送らせてください", role: "sticker-p-decline", promptFragment: "regretful polite expression, one hand raised flat in gentle refusal" },
  { id: "stk-p-confirmdone", label: "確認しました", role: "sticker-p-confirmdone", promptFragment: "satisfied professional expression, giving a small approving nod over documents" },
  { id: "stk-p-welcome", label: "いらっしゃいませ", role: "sticker-p-welcome", promptFragment: "welcoming courteous expression, one arm extended in invitation, a small bow" },
  { id: "stk-p-goodjob", label: "助かりました", role: "sticker-p-goodjob", promptFragment: "relieved appreciative expression, both hands together in gratitude" },
  { id: "stk-p-question", label: "ご質問です", role: "sticker-p-question", promptFragment: "polite questioning expression, one index finger raised modestly" },
  { id: "stk-p-schedule", label: "日程調整します", role: "sticker-p-schedule", promptFragment: "organized focused expression, looking at a calendar held in one hand" },
  { id: "stk-p-wait-reply", label: "お返事お待ちしております", role: "sticker-p-wait-reply", promptFragment: "patient courteous expression, hands folded in front, calm posture" },
  { id: "stk-p-sorry-trouble", label: "お手数おかけします", role: "sticker-p-sorry-trouble", promptFragment: "apologetic considerate expression, a modest bow with hands together" },
  { id: "stk-p-good-evening", label: "お世話になっております", role: "sticker-p-good-evening", promptFragment: "professional cordial expression, a standard business bow" },
  { id: "stk-p-leaving-work", label: "お先に失礼します", role: "sticker-p-leaving-work", promptFragment: "polite departing expression, a small bow while holding a bag" },
  { id: "stk-p-noted", label: "了解いたしました", role: "sticker-p-noted", promptFragment: "attentive acknowledging expression, a crisp respectful nod" },
  { id: "stk-p-effort", label: "尽力いたします", role: "sticker-p-effort", promptFragment: "determined earnest expression, one fist lightly clenched at the chest" },
  { id: "stk-p-apologize-again", label: "重ねてお詫びします", role: "sticker-p-apologize-again", promptFragment: "gravely apologetic expression, the deepest bow, both hands at the sides" },
  { id: "stk-p-inform", label: "お知らせします", role: "sticker-p-inform", promptFragment: "clear composed expression, one hand raised presenting information" },
  { id: "stk-p-review", label: "拝見します", role: "sticker-p-review", promptFragment: "attentive reading expression, eyes lowered toward a held document" },
  { id: "stk-p-happy-work", label: "よろしくどうぞ", role: "sticker-p-happy-work", promptFragment: "friendly professional smile, a light bow with one hand extended" },
  { id: "stk-p-rest", label: "ご自愛ください", role: "sticker-p-rest", promptFragment: "kind caring expression, both hands held gently together" },
  { id: "stk-p-anytime", label: "いつでもどうぞ", role: "sticker-p-anytime", promptFragment: "open reassuring expression, one arm extended welcomingly" },
  { id: "stk-p-done", label: "完了しました", role: "sticker-p-done", promptFragment: "satisfied composed expression, presenting finished work with both hands" },
  { id: "stk-p-start", label: "始めます", role: "sticker-p-start", promptFragment: "focused ready expression, both hands poised to begin" },
];

/**
 * リアクション多め（状態報告帯）。
 * 出典: `sticker-craft-research.md` §1-1 の21〜30位（ひま / 忙しい / ねむい / おなかすいた）
 * および §1-2「会話・リアクション系」14項目。
 */
const REACTION_ENTRIES: StickerEntry[] = [
  { id: "stk-r-bored", label: "ひま〜", role: "sticker-r-bored", promptFragment: "bored listless expression, chin propped on one hand, eyes drifting sideways" },
  { id: "stk-r-busy", label: "いま忙しい", role: "sticker-r-busy", promptFragment: "overwhelmed hurried expression, arms full, moving quickly" },
  { id: "stk-r-sleepy", label: "ねむい…", role: "sticker-r-sleepy", promptFragment: "drowsy expression, eyes half shut, head tipping to one side" },
  { id: "stk-r-hungry", label: "おなかすいた", role: "sticker-r-hungry", promptFragment: "hungry drooping expression, one hand on the stomach" },
  { id: "stk-r-nod", label: "あいづち", role: "sticker-r-nod", promptFragment: "attentive listening expression, a small nod, one hand near the chin" },
  { id: "stk-r-ng", label: "NG", role: "sticker-r-ng", promptFragment: "firm refusing expression, both arms crossed in front forming an X" },
  { id: "stk-r-askback", label: "え、なに？", role: "sticker-r-askback", promptFragment: "puzzled questioning expression, one hand cupped behind the ear, leaning in" },
  { id: "stk-r-praise", label: "褒める", role: "sticker-r-praise", promptFragment: "admiring delighted expression, applauding with both hands" },
  { id: "stk-r-excited", label: "楽しみ！", role: "sticker-r-excited", promptFragment: "eager anticipating expression, both fists clenched near the chest, bouncing" },
  { id: "stk-r-cheer", label: "応援", role: "sticker-r-cheer", promptFragment: "enthusiastic cheering expression, both arms raised waving in support" },
  { id: "stk-r-gonna", label: "がんばるぞ！", role: "sticker-r-gonna", promptFragment: "fired-up determined expression, one fist punched into the air" },
  { id: "stk-r-worry", label: "心配", role: "sticker-r-worry", promptFragment: "worried expression, brows drawn together, both hands clasped near the chest" },
  { id: "stk-r-comfort", label: "なぐさめる", role: "sticker-r-comfort", promptFragment: "gentle consoling expression, one hand reaching out to pat softly" },
  { id: "stk-r-wow", label: "えー！", role: "sticker-r-wow", promptFragment: "astonished expression, mouth open wide, both hands raised near the face" },
  { id: "stk-r-hmm", label: "うーん", role: "sticker-r-hmm", promptFragment: "unconvinced pondering expression, head tilted, one hand at the chin" },
  { id: "stk-r-really", label: "ほんとに？", role: "sticker-r-really", promptFragment: "skeptical narrowed-eye expression, one brow raised, leaning slightly back" },
  { id: "stk-r-lol", label: "笑", role: "sticker-r-lol", promptFragment: "laughing expression, eyes crinkled shut, one hand covering the mouth" },
  { id: "stk-r-cry", label: "泣く", role: "sticker-r-cry", promptFragment: "tearful expression, large tears, both hands rubbing the eyes" },
  { id: "stk-r-angry", label: "怒る", role: "sticker-r-angry", promptFragment: "angry expression, furrowed brows, both fists clenched at the sides" },
  { id: "stk-r-down", label: "落ち込む", role: "sticker-r-down", promptFragment: "dejected expression, head hanging, shoulders drawn in" },
  { id: "stk-r-shock", label: "ショック", role: "sticker-r-shock", promptFragment: "stunned frozen expression, wide unblinking eyes, body rigid" },
  { id: "stk-r-panic", label: "焦る", role: "sticker-r-panic", promptFragment: "panicked expression, sweating, both hands waving frantically" },
  { id: "stk-r-drawback", label: "ドン引き", role: "sticker-r-drawback", promptFragment: "recoiling uncomfortable expression, leaning away, both palms raised" },
  { id: "stk-r-tired", label: "疲れた", role: "sticker-r-tired", promptFragment: "exhausted expression, slumped forward, arms hanging limp" },
  { id: "stk-r-fine", label: "だいじょうぶ", role: "sticker-r-fine", promptFragment: "reassuring calm smile, one thumb up, relaxed posture" },
  { id: "stk-r-yes", label: "うんうん", role: "sticker-r-yes", promptFragment: "agreeing expression, nodding repeatedly, both hands lightly clasped" },
  { id: "stk-r-no", label: "ちがうよ", role: "sticker-r-no", promptFragment: "denying expression, one hand waving side to side in front of the face" },
  { id: "stk-r-please", label: "おねがい！", role: "sticker-r-please", promptFragment: "pleading expression, both palms pressed together, head tilted" },
  { id: "stk-r-sparkle", label: "きゃー！", role: "sticker-r-sparkle", promptFragment: "squealing excited expression, both hands on the cheeks, sparkling eyes" },
  { id: "stk-r-thinking", label: "考え中", role: "sticker-r-thinking", promptFragment: "deep in thought expression, arms folded, eyes looking upward" },
  { id: "stk-r-relief", label: "ほっ", role: "sticker-r-relief", promptFragment: "relieved expression, exhaling, one hand resting on the chest" },
  { id: "stk-r-clap", label: "拍手", role: "sticker-r-clap", promptFragment: "delighted expression, clapping both hands in front of the chest" },
  { id: "stk-r-jealous", label: "いいなー", role: "sticker-r-jealous", promptFragment: "envious wistful expression, one hand reaching out weakly, slight pout" },
  { id: "stk-r-proud", label: "えっへん", role: "sticker-r-proud", promptFragment: "proud smug expression, chest puffed out, hands on the hips" },
  { id: "stk-r-blank", label: "…", role: "sticker-r-blank", promptFragment: "completely blank expression, vacant eyes, motionless posture" },
  { id: "stk-r-sweat", label: "あせあせ", role: "sticker-r-sweat", promptFragment: "flustered expression, beads of sweat, one hand scratching the back of the head" },
  { id: "stk-r-love", label: "すき！", role: "sticker-r-love", promptFragment: "adoring expression, both hands forming a heart near the chest" },
  { id: "stk-r-sorry", label: "ごめん！", role: "sticker-r-sorry", promptFragment: "apologetic expression, one hand raised flat in front of the face, head tilted" },
  { id: "stk-r-ok", label: "オッケー", role: "sticker-r-ok", promptFragment: "bright confident expression, both arms raised forming a large circle overhead" },
  { id: "stk-r-go", label: "いこう！", role: "sticker-r-go", promptFragment: "energetic expression, one arm pointing forward, stepping ahead" },
  { id: "stk-r-wait", label: "まって", role: "sticker-r-wait", promptFragment: "urgent expression, one hand outstretched forward to stop, leaning in" },
  { id: "stk-r-bye", label: "ばいばい", role: "sticker-r-bye", promptFragment: "cheerful expression, one hand waving broadly" },
];

/**
 * カタログ本体。**先頭が既定**（`basic`）。
 *
 * 実測ランキングは強いが、そこに全員を寄せないのがSTΛCK決定3。既定は `basic` に置くが、
 * 他の3方向を同格の選択肢として並べる（既定以外を「応用」扱いにしない）。
 */
export const STICKER_CATALOGS: readonly StickerCatalog[] = [
  {
    id: "basic",
    label: "基本形（挨拶・返事中心）",
    description: "ありがとう・おはよう・OK など、実測でよく使われる挨拶と返事が中心。",
    entries: BASIC_ENTRIES,
  },
  {
    id: "playful",
    label: "ふざけた系",
    description: "ドヤ顔・ごまかし・現実逃避・ダジャレなど、崩した表情が中心。",
    entries: PLAYFUL_ENTRIES,
  },
  {
    id: "polite",
    label: "ていねい系",
    description: "お疲れ様です・確認します・少々お待ちください など、敬語トーンが中心。",
    entries: POLITE_ENTRIES,
  },
  {
    id: "reaction",
    label: "リアクション多め",
    description: "ひま・忙しい・ねむい など、会話を進めない状態報告とあいづちが中心。",
    entries: REACTION_ENTRIES,
  },
] as const;

/** 既定のプリセット。 */
export const DEFAULT_STICKER_TONE: StickerToneId = "basic";

/** id → カタログの逆引き。未知IDは undefined。 */
export function getStickerCatalog(id: StickerToneId): StickerCatalog | undefined {
  return STICKER_CATALOGS.find((c) => c.id === id);
}

/**
 * 選んだ枚数だけ先頭から採る。
 *
 * 配分テンプレは持たない（業界に存在しないため）。**並び順そのものが配分**であり、
 * ユーザーはチェックリストで差し替えられる。`count` がエントリ数を超える場合は
 * **黙って足さず、持っている分だけ返す**（欠落は埋めずに可視化する。呼び出し側が
 * 不足枚数を見て判断する）。
 */
export function pickEntries(id: StickerToneId, count: number): StickerEntry[] {
  const catalog = getStickerCatalog(id);
  if (!catalog) return [];
  return catalog.entries.slice(0, Math.max(0, count));
}
