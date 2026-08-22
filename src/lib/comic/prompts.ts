/**
 * 漫画制作スキルのプロンプト組み立て。
 *
 * - ネーム生成プロンプト: 話+コマ割りテンプレ+登場キャラ → JSON でコマ割りを返させる
 * - コマ画像生成プロンプト: コマの構図・演技・登場キャラ属性を1本のプロンプトへ合成
 *
 * AI が知っている一般知識（コマ割りの一般論など）は書かない。
 * 「必ず JSON で返す」「テンプレのコマ数と役割を守る」という制約だけを明示する。
 */

import { SFX_INTENT } from "./balloonLayout";
import {
  ALL_COMIC_LAYOUT_TEMPLATES,
  COMIC_LAYOUT_TEMPLATES,
  describeSlotShape,
  type ComicLayoutTemplate,
  type ComicPanelSlot,
} from "./layoutTemplates";
import { synthesizeSlotsFromRows } from "./layoutSynthesis";
// references.ts は ./types しか import しないため循環しない（cast の導出規則を1箇所に閉じる）。
import { unionPanelCharacters } from "./references";
import type {
  ComicBalloon,
  ComicBalloonKind,
  ComicCharacter,
  ComicColorMode,
  ComicFrameStyle,
  ComicGutterStyle,
  ComicPanel,
  ComicReadingDirection,
  ComicSfx,
  ComicSfxIntent,
  ComicStoryPage,
} from "./types";

/**
 * 吹き出しの種類ごとの英語記述子（gtm 2026-08-03）。
 *
 * ページ生成プロンプトのコマ行で、そのセリフの引用の直後に括弧書きで足す。
 * 黒系2種に white outer rim を含めるのは、白黒漫画で黒ベタ吹き出しが背景の黒と
 * 同化する事故を防ぐため（Chico ①の「白縁」指定そのもの）。
 */
export const BALLOON_KIND_DESCRIPTOR: Record<ComicBalloonKind, string> = {
  normal: "rounded speech balloon",
  black:
    "solid black speech balloon with white lettering and a thin white outer rim",
  shout: "jagged spiky shout balloon",
  shout_black:
    "solid black jagged spiky shout balloon with white lettering and a thin white outer rim",
  monologue:
    "thought bubble whose tail is a trail of small round bubbles instead of a pointed tail, lettered in a softer rounded style distinct from spoken dialogue",
  narration: "rectangular narration box",
  caption:
    "narration text floating directly on the artwork with no box or balloon around it",
  machine:
    "angular polygonal balloon with straight edges, for an electronic, broadcast, or animal voice",
};

/**
 * 数珠つなぎ（gtm ②）の分割。1個の吹き出しの text 内の「／」「/」を区切りとして
 * 連結吹き出しのセグメントへ割る。
 *
 * データ上は1個の ComicBalloon のまま（表示・編集・保存の正本は「／」入りテキスト）。
 * プロンプト組み立てだけがこれを使う唯一の実装点。
 */
export function balloonSegments(text: string): string[] {
  return text
    .split(/[／/]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * 吹き出しを「引用 + kind記述子」へ変換する共通規則。
 * ページ一枚描きと、きっちりコマ割りのコマ生成で同じ文言を使う。
 */
function balloonPromptLines(panel: Pick<ComicPanel, "balloons">): string[] {
  return panel.balloons
    .filter((balloon) => balloon.visible && balloon.text.trim().length > 0)
    .map((balloon) => {
      const segments = balloonSegments(balloon.text);
      const quoted = (segments.length > 0 ? segments : [balloon.text.trim()])
        .map((segment) => `「${segment}」`)
        .join("");
      const descriptor =
        segments.length > 1
          ? `${BALLOON_KIND_DESCRIPTOR[balloon.kind]}, drawn as a chain of ${segments.length} linked balloons, one balloon per quoted phrase, connected in reading order`
          : BALLOON_KIND_DESCRIPTOR[balloon.kind];
      return `${quoted} (${descriptor})`;
    });
}

/** ページ/コマ生成で共通の、可視な擬音だけを引用へ変換する規則。 */
function sfxPromptQuotes(panel: Pick<ComicPanel, "sfx">): string[] {
  return panel.sfx
    .filter((sfx) => sfx.visible && sfx.text.trim().length > 0)
    .map((sfx) => `「${sfx.text.trim()}」`);
}

/** ページ/コマ再生成で共通の「吹き出し＋擬音」句。対象が無ければ空文字。 */
export function buildPanelBalloonSfxClause(panel: ComicPanel): string {
  const parts: string[] = [];
  const balloonLines = balloonPromptLines(panel);
  if (balloonLines.length > 0) {
    parts.push(
      `speech balloon${balloonLines.length > 1 ? "s" : ""}: ${balloonLines.join(" ")}`,
    );
  }
  const sfxLines = sfxPromptQuotes(panel);
  if (sfxLines.length > 0) {
    parts.push(
      `sound effect${sfxLines.length > 1 ? "s" : ""}: ${sfxLines.join(" ")}`,
    );
  }
  return parts.join(" ");
}

/**
 * 登場キャラ一覧と「名前の厳守」ブロックを導出する。
 *
 * buildNamePrompt（detail）と buildStoryPrompt（auto）の両方から呼ぶ共通ヘルパ。
 * 名前がズレると参照画像が付かず「別人が生成される」ため、名前の厳守を明示する
 * (2026-07-28 STΛCK 実機FB)。受け側にもフォールバックがあるが、まず発生率を下げる。
 */
function characterListLines(characters: ComicCharacter[]): {
  charList: string;
  nameDiscipline: string[];
} {
  const charList =
    characters.length > 0
      ? characters
          .map((c) => {
            const attr = c.attributes?.trim();
            return attr ? `- ${c.name}（${attr}）` : `- ${c.name}`;
          })
          .join("\n")
      : "（登場キャラの指定なし。話に合わせて配役してよい）";

  const nameDiscipline =
    characters.length > 0
      ? [
          "",
          "【登場キャラの厳守（重要）】",
          "- このネームに登場させてよい名前付きの人物は、上記【登場キャラ】に列挙した名前だけです。",
          "- characters 配列には、上記の名前を一字一句そのまま（表記を変えずに）入れてください。別名・愛称・改名・新しい名前の発明は禁止です。",
          "- 通行人などの名前のないモブが必要な場合は、characters には入れず、composition / prompt の説明文の中でだけ描写してください。",
        ]
      : [];

  return { charList, nameDiscipline };
}

/**
 * ネーム（コマ割り+セリフ）を JSON で生成させるプロンプトを組む。
 *
 * 応答は下記スキーマの JSON 配列だけを返させる（前置き・後置きの散文を禁止）。
 * パースは parseComicName() が担う（コードフェンス除去＋部分抽出に耐える）。
 */
export function buildNamePrompt(
  synopsis: string,
  template: ComicLayoutTemplate,
  characters: ComicCharacter[],
): string {
  const { charList, nameDiscipline } = characterListLines(characters);

  // コマ割りはユーザーが選んだ静的テンプレが正本。AI にはテンプレの
  // コマ数・各コマの役割・コマの形を守らせる (2026-07-28 STΛCK 実機FB)。
  const roleLines = template.roles.map(
    (role, i) => `- コマ${i + 1}: ${role}（${describeSlotShape(template, i)}）`,
  );

  return [
    "あなたはプロの漫画ネーム作家です。以下の話を、指定コマ数の漫画ネーム（コマ割り＋セリフ）に構成してください。",
    "",
    "【話（あらすじ）】",
    synopsis.trim(),
    "",
    "【形式】",
    `全 ${template.panelCount} コマ。コマ割りテンプレ「${template.label}」に従います。各コマの役割と形:`,
    ...roleLines,
    "",
    "【吹き出し（セリフ）のルール】",
    `- 全コマにセリフを入れないでください。全 ${template.panelCount} コマ中 ${template.panelCount <= 4 ? "0〜1" : "1〜2"} コマは balloons を空配列にして、表情や間で見せる無言のコマにします。`,
    "- balloons は1コマ最大2個、1コマの合計40字以内。話す順に並べてください（漫画は右上から読むため、先頭の吹き出しが右上に置かれます）。",
    '- kind の使い分け: 通常の発話は "normal"、叫び・驚きは "shout"、心の中の声は "monologue"、状況説明・時間経過の説明文は "narration"（narration の speaker は空文字にします）。',
    "",
    "【擬音（オノマトペ）のルール】",
    "- 動き・衝撃・静けさを強調したいコマにだけ、sfx にカタカナ中心の短い擬音（2〜6文字）を最大2個入れます。他のコマは空配列にします。付けるのは全体の半分以下のコマにします。",
    '- intent の使い分け: 衝撃は "impact"、動き・スピードは "motion"、静けさ・間は "quiet"、感情の強調は "emotion"。',
    "- 無言コマ＋擬音だけ、という演出は有効です。",
    "",
    "【コマ展開（厳守）】",
    "隣り合うコマで同じ構図・同じカメラ距離・同じアングルを繰り返さない。",
    "カメラ距離（大引き・引き・ミドル・寄り・大写し）と角度（目線・俯瞰・あおり）をコマごとに変えて、物語にリズムを作る。",
    "大きいコマは見せ場や状況説明に、小さいコマはリアクションや細部の描写に使う。",
    "各コマの composition には距離と角度を必ず明記し、prompt にも同じ内容を英語で反映する。",
    "",
    "【登場キャラ】",
    charList,
    ...nameDiscipline,
    "",
    "【出力形式（厳守）】",
    "次のスキーマの JSON 配列だけを出力してください。前置き・説明・コードフェンス外の文章を一切付けないでください。",
    "各要素:",
    "{",
    '  "index": コマ番号(1始まりの整数),',
    '  "composition": "構図・カメラの説明（引き/寄り、アングル、画角）",',
    '  "characters": ["このコマに登場するキャラ名", ...],',
    '  "acting": "演技・表情・動きの説明",',
    '  "balloons": [{"speaker": "話者名（narration は空文字）", "text": "セリフ", "kind": "normal|shout|monologue|narration"}],',
    '  "sfx": [{"text": "擬音（例: ガタッ）", "intent": "impact|motion|quiet|emotion"}],',
    '  "prompt": "画像生成用の1コマ分プロンプト（構図＋演技＋背景を英語で簡潔に）"',
    "}",
    "",
    `配列の要素数は必ず ${template.panelCount} 個にしてください。characters には上記の登場キャラ名を使ってください。`,
  ].join("\n");
}

/**
 * おまかせ時に AI へ示すページ数の**目安**（2026-07-28 STΛCK指示で上限撤廃）。
 *
 * かつては「機械側の関所」だったが、ページ生成は並列＋セマフォで順番に消化されるため
 * 枚数を機械で遮断する理由がない。ページ数を人が明示したときは何ページでも通す。
 * この定数はもう入力・検証を**遮断しない**。おまかせ時に「短い話を無理に引き伸ばすな」を
 * 伝えるための目安値としてだけ使う。
 */
export const MAX_STORY_PAGES = 20;
/** テンプレ未指定時の1ページあたりコマ数の上限。 */
export const MAX_PANELS_PER_PAGE = 8;

/**
 * ページ構成（ページ割り＋コマ割り＋セリフ）を JSON オブジェクトで生成させる
 * プロンプトを組む（auto＝主経路）。
 *
 * 応答は `{ pages: [...] }` だけを返させる（前置き・後置きの散文を禁止）。
 * パースは parseComicStory()、条件との突き合わせは isValidStory() が担う。
 */
export function buildStoryPrompt(
  synopsis: string,
  characters: ComicCharacter[],
  opts: {
    /** 指定ページ数。undefined = おまかせ。 */
    pageCount?: number;
    /** 参考テンプレ。undefined = AI にコマ割り最適化させる。 */
    template?: ComicLayoutTemplate;
    /** 読み方向。省略時 "rtl"。 */
    readingDirection?: ComicReadingDirection;
    /** 固定の背景・小物の名前（3ir）。省略時は出力不変。 */
    envNames?: string[];
  },
): string {
  const { charList, nameDiscipline } = characterListLines(characters);
  const { pageCount, template } = opts;

  const pageCountLines = pageCount
    ? [`全 ${pageCount} ページで構成してください。`]
    : [
        // 上限ではなく目安として示す（機械側の関所は撤廃済み）。数値は MAX_STORY_PAGES から
        // 導出し、プロンプトと定数がズレないようにする。
        `ページ数はあなたが決めてください。決め方: 1つの場面転換・見せ場ごとに1ページ。話が過不足なく収まる最小のページ数にします（話の長さに応じた適切なページ数。目安は1〜${MAX_STORY_PAGES}ページ）。短い話を無理に引き伸ばさないでください。`,
      ];

  const panelCountLines = template
    ? [
        `全ページ ${template.panelCount} コマ固定です。コマ割りテンプレ「${template.label}」を参考にします。各コマの役割と形:`,
        ...template.roles.map(
          (role, i) => `- コマ${i + 1}: ${role}（${describeSlotShape(template, i)}）`,
        ),
      ]
    : [
        "ページごとに 1〜8 コマの範囲で、そのページの内容に合う最適なコマ数を決めてください。見せ場のページはコマ数を減らして1コマを大きく、テンポの速い掛け合いのページはコマ数を増やします。",
        `各ページで、次の12テンプレから1つだけ選び、その id を layoutTemplateId に入れてください: ${COMIC_LAYOUT_TEMPLATES.map((item) => `${item.id}(${item.panelCount}コマ)`).join(", ")}。panelCount と panels の要素数は、選んだテンプレのコマ数と一致させてください。`,
        '各ページの rows には、読み順のコマ番号を上の行から順にグループ化して入れてください（例: [[1,2],[3],[4,5,6]]）。1 から panelCount までの番号を、重複・欠番なく1回ずつ使います。',
      ];

  return [
    "あなたはプロの漫画ネーム作家です。以下の話を、複数ページの漫画の構成（ページ割り＋コマ割り＋セリフ）にしてください。",
    "",
    "【話（あらすじ）】",
    synopsis.trim(),
    "",
    "【ページ数】",
    ...pageCountLines,
    "",
    "【各ページのコマ数】",
    ...panelCountLines,
    "",
    "【ページ間の流れ（厳守）】",
    "- 各ページの synopsis に「このページで起きること」を40字以内で書いてください。ページを順に読むと話がつながるようにします。",
    "- 最終ページ以外の最後のコマは、次のページをめくらせる引き（疑問・驚き・転換）にします。最終ページの最後のコマはオチで締めます。",
    "- layoutHint には、そのページのコマ割り方針を英語1文で書いてください（例: large opening panel on top, three small reaction panels below）。",
    "",
    "【吹き出し（セリフ）のルール】",
    "- 全コマにセリフを入れないでください。各ページで、4 コマ以下のページは 0〜1 コマ、5 コマ以上のページは 1〜2 コマを balloons 空配列にして、表情や間で見せる無言のコマにします。",
    opts.readingDirection === "ltr"
      ? "- balloons は1コマ最大2個、1コマの合計40字以内。話す順に並べてください（左→右で読む設定のため、先頭の吹き出しが左上に置かれます）。"
      : "- balloons は1コマ最大2個、1コマの合計40字以内。話す順に並べてください（漫画は右上から読むため、先頭の吹き出しが右上に置かれます）。",
    '- kind の使い分け: 通常の発話は "normal"、強い感情・威圧・不気味さの演出は "black"（黒ベタ）、叫び・驚きは "shout"、ひときわ強い叫びは "shout_black"（黒ギザギザ）、心の中の声は "monologue"、状況説明・時間経過の説明文は "narration"（四角囲み）、囲みを付けない説明文は "caption"。"narration" と "caption" の speaker は空文字にします。機械音声・スピーカー越しの声・動物の声は "machine" にします。',
    '- ひと息で畳みかけるセリフは、1個の吹き出しの text の中を「／」で区切ってください。連結した数珠つなぎの吹き出しとして描かれます（例: "もうっ！／勝手なことばかり言っちゃって"）。',
    "",
    "【擬音（オノマトペ）のルール】",
    "- 動き・衝撃・静けさを強調したいコマにだけ、sfx にカタカナ中心の短い擬音（2〜6文字）を最大2個入れます。他のコマは空配列にします。付けるのは全体の半分以下のコマにします。",
    '- intent の使い分け: 衝撃は "impact"、動き・スピードは "motion"、静けさ・間は "quiet"、感情の強調は "emotion"。',
    "- 無言コマ＋擬音だけ、という演出は有効です。",
    "",
    "【コマ展開（厳守）】",
    "隣り合うコマで同じ構図・同じカメラ距離・同じアングルを繰り返さない。",
    "カメラ距離（大引き・引き・ミドル・寄り・大写し）と角度（目線・俯瞰・あおり）をコマごとに変えて、物語にリズムを作る。",
    "大きいコマは見せ場や状況説明に、小さいコマはリアクションや細部の描写に使う。",
    "各コマの composition には距離と角度を必ず明記し、prompt にも同じ内容を英語で反映する。",
    "",
    "【登場キャラ】",
    charList,
    ...nameDiscipline,
    ...(opts.envNames && opts.envNames.length > 0
      ? [
          "",
          "【固定の背景・小物】",
          `この作品には毎回同じデザインで描く背景・小物があります: ${opts.envNames.map((n) => `「${n}」`).join("")}`,
          "話に登場する場面では、各コマの composition / prompt にこの名前をそのまま使って言及してください（無理に全コマへ登場させる必要はありません）。",
        ]
      : []),
    ...(characters.length > 0
      ? [
          "",
          "【ページごとの登場キャラ（cast・厳守）】",
          "- 各ページの cast には、そのページのコマに登場する登場キャラの名前を全て入れてください。",
          "- cast の名前は【登場キャラ】に列挙した名前を一字一句そのまま使ってください（別名・愛称・改名は禁止）。",
          "- 名前のないモブは cast に入れないでください。",
          "- そのページの panels の characters に入れた名前は、必ずそのページの cast にも入れてください。",
          "- 長編の一貫性のため、話の必然性がないキャラを全ページに出さないでください。出ないページの cast には入れません。",
        ]
      : []),
    "",
    "【出力形式（厳守）】",
    "次のスキーマの JSON オブジェクトだけを出力してください。前置き・説明・コードフェンス外の文章を一切付けないでください。",
    "{",
    '  "pages": [',
    "    {",
    '      "page": ページ番号(1始まりの整数),',
    '      "synopsis": "このページで起きること（40字以内）",',
    '      "layoutHint": "このページのコマ割り方針（英語1文）",',
    '      "cast": ["このページに登場するキャラ名", ...],',
    '      "panelCount": このページのコマ数(整数),',
    ...(template
      ? []
      : [
          '      "layoutTemplateId": "manga01〜manga12のいずれか1つ",',
          '      "rows": [[上段のコマ番号を読み順で], [次の段のコマ番号を読み順で], ...],',
        ]),
    '      "panels": [',
    "        {",
    '          "index": ページ内のコマ番号(1始まりの整数),',
    '          "composition": "構図・カメラの説明（引き/寄り、アングル、画角）",',
    '          "characters": ["このコマに登場するキャラ名", ...],',
    '          "acting": "演技・表情・動きの説明",',
    '          "balloons": [{"speaker": "話者名（narration は空文字）", "text": "セリフ", "kind": "normal|black|shout|shout_black|monologue|narration|caption|machine"}],',
    '          "sfx": [{"text": "擬音（例: ガタッ）", "intent": "impact|motion|quiet|emotion"}],',
    '          "prompt": "画像生成用の1コマ分プロンプト（構図＋演技＋背景を英語で簡潔に）"',
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "各ページの panels の要素数は必ずそのページの panelCount と同じにし、index はページ内で 1 から panelCount の連番にします。",
    ...(pageCount ? [`pages の要素数は必ず ${pageCount} 個にしてください。`] : []),
    "characters と cast には上記の登場キャラ名を使ってください。",
  ].join("\n");
}

/** balloons の取り込み。新スキーマ優先、旧 dialogue 文字列からの移行を後方互換で持つ。 */
function toBalloons(obj: Record<string, unknown>): ComicBalloon[] {
  const KINDS = new Set([
    "normal",
    "black",
    "shout",
    "shout_black",
    "monologue",
    "narration",
    "caption",
    "machine",
  ]);
  let items: Array<{ speaker: string; text: string; kind: ComicBalloonKind }> = [];
  if (Array.isArray(obj.balloons)) {
    items = obj.balloons
      .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
      .map((b) => ({
        speaker: typeof b.speaker === "string" ? b.speaker.trim() : "",
        text: typeof b.text === "string" ? b.text.trim() : "",
        kind: (KINDS.has(String(b.kind)) ? b.kind : "normal") as ComicBalloonKind,
      }))
      .filter((b) => b.text.length > 0);
  } else if (typeof obj.dialogue === "string" && obj.dialogue.trim()) {
    // 旧スキーマ移行: 1行目=吹き出し1、残り=吹き出し2へ畳む（旧 PanelBalloons と同じ畳み方）
    const lines = obj.dialogue
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    items = (lines.length <= 1 ? lines : [lines[0], lines.slice(1).join("\n")]).map(
      (text) => ({ speaker: "", text, kind: "normal" as ComicBalloonKind }),
    );
  }
  // 最大2個。3個目以降は2個目へ改行で畳む（黙って捨てない）。
  if (items.length > 2) {
    console.warn(`comic: balloons ${items.length} 個を2個へ畳みました`);
    items = [
      items[0],
      { ...items[1], text: [items[1], ...items.slice(2)].map((b) => b.text).join("\n") },
    ];
  }
  return items.map((b) => ({ id: crypto.randomUUID(), ...b, pos: null, visible: true }));
}

/**
 * sfx の取り込み。text 非空 trim・10文字超は切詰め・intent 不正値は "motion"。
 * 3個目以降は破棄（プロンプトで最大2個を明示済みの製品ルール適用）。
 * rotation / scale は intent 表から材料化する。
 */
function toSfx(obj: Record<string, unknown>): ComicSfx[] {
  const INTENTS = new Set(["impact", "motion", "quiet", "emotion"]);
  if (!Array.isArray(obj.sfx)) return [];
  const items = obj.sfx
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => {
      const raw = typeof s.text === "string" ? s.text.trim() : "";
      const chars = [...raw];
      const intent = (
        INTENTS.has(String(s.intent)) ? s.intent : "motion"
      ) as ComicSfxIntent;
      return {
        text: chars.length > 10 ? chars.slice(0, 10).join("") : raw,
        intent,
      };
    })
    .filter((s) => s.text.length > 0);
  const kept = items.slice(0, 2);
  if (items.length > kept.length) {
    console.warn(`comic: sfx ${items.length} 個のうち ${kept.length} 個だけ採用しました`);
  }
  return kept.map((s) => ({
    id: crypto.randomUUID(),
    text: s.text,
    intent: s.intent,
    pos: null,
    rotation: SFX_INTENT[s.intent].rotation,
    scale: SFX_INTENT[s.intent].scale,
    visible: true,
  }));
}

/**
 * ComicPanel 配列としての妥当性検査＋変換。parseComicName の本体を抽出（挙動不変）。
 *
 * ネーム（detail）とページ構成（auto）の両方が同じコマ配列スキーマを使うため、
 * 検査を1箇所に集約する。壊れていれば null（部分採用しない）。
 */
function parsePanelArray(data: unknown): ComicPanel[] | null {
  if (!Array.isArray(data) || data.length === 0) return null;

  const panels: ComicPanel[] = [];
  const panelNumbers = new Set<number>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.index !== "number" ||
      !Number.isInteger(obj.index) ||
      obj.index < 1 ||
      panelNumbers.has(obj.index)
    ) {
      return null;
    }
    if (typeof obj.prompt !== "string" || !obj.prompt.trim()) return null;
    panelNumbers.add(obj.index);
    const chars = Array.isArray(obj.characters)
      ? obj.characters.filter((c): c is string => typeof c === "string")
      : [];
    panels.push({
      index: obj.index,
      composition: typeof obj.composition === "string" ? obj.composition : "",
      characters: chars,
      acting: typeof obj.acting === "string" ? obj.acting : "",
      balloons: toBalloons(obj),
      sfx: toSfx(obj),
      prompt: obj.prompt,
    });
  }

  return panels;
}

/**
 * おまかせレイアウトの rows を全体単位で検査する。
 * 1..panelCount が重複・欠番なく1回ずつ揃わない場合は null（部分採用しない）。
 */
function parseStoryRows(data: unknown, panelCount: number): number[][] | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows: number[][] = [];
  const seen = new Set<number>();
  for (const rawRow of data) {
    if (!Array.isArray(rawRow) || rawRow.length === 0) return null;
    const row: number[] = [];
    for (const value of rawRow) {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > panelCount ||
        seen.has(value)
      ) {
        return null;
      }
      seen.add(value);
      row.push(value);
    }
    rows.push(row);
  }
  if (seen.size !== panelCount) return null;
  for (let index = 1; index <= panelCount; index += 1) {
    if (!seen.has(index)) return null;
  }
  return rows;
}

/**
 * AI 未指定・無効時の決定論補完として、ページのコマ数に合う型を解決する。
 * 有効な指定IDを優先し、それ以外はID昇順の候補をページ番号で循環させる。
 * 同じ入力は必ず同じ型になり、コマ数一致がなければ null を返す。
 */
export function resolveStoryLayoutTemplateWithDeterministicFallback(
  pageNumber: number,
  panelCount: number,
  candidateId?: unknown,
): ComicLayoutTemplate | null {
  const id = typeof candidateId === "string" ? candidateId.trim() : "";
  const selected = ALL_COMIC_LAYOUT_TEMPLATES.find(
    (template) => template.id === id && template.panelCount === panelCount,
  );
  if (selected) return selected;

  const matches = COMIC_LAYOUT_TEMPLATES.filter(
    (template) => template.panelCount === panelCount,
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (matches.length === 0) return null;
  return matches[(pageNumber - 1) % matches.length] ?? null;
}

/**
 * ネーム応答テキストから ComicPanel[] を抽出する。
 * - ```json フェンスがあれば剥がす
 * - 最初の '[' から対応する ']' までを JSON としてパースする
 * パースできない/形が違う場合は null を返す（呼び出し側でエラー表示）。
 */
export function parseComicName(raw: string): ComicPanel[] | null {
  if (!raw) return null;

  // コードフェンスを剥がす
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // 最初の配列を抽出（前後に散文が混ざっても拾う）
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);

  let data: unknown;
  try {
    data = JSON.parse(slice);
  } catch {
    return null;
  }
  return parsePanelArray(data);
}

/**
 * 構成応答テキストから ComicStoryPage[] を抽出する。
 * - ```json フェンスがあれば剥がす（parseComicName と同じ正規表現）
 * - 最初の '{' から最後の '}' までを JSON としてパース
 * - obj.pages が非空配列であること。各要素:
 *   - page: 整数・1以上・重複なし（Set で検査。並びは後で昇順ソート）
 *   - panelCount: 整数・1以上
 *   - panels: parsePanelArray が非 null
 *   - synopsis: string なら trim、それ以外は ""（欠落を落とさず空で可視化）
 *   - layoutHint: string なら trim、それ以外は ""
 *   - rows: 任意。1..panelCount が重複・欠番なく揃う場合だけ受理し、readingDirection
 *     とともに synthesizeSlotsFromRows へ渡して layoutPlan を保存する
 *     （不整合時は rows/layoutPlan だけを捨てて従来動作）
 * 1ページでも壊れていれば全体を null（部分採用しない。黙って切り捨てない）。
 * 返却前に page 昇順へソートする。
 */
export function parseComicStory(
  raw: string,
  readingDirection: ComicReadingDirection = "rtl",
): ComicStoryPage[] | null {
  if (!raw) return null;

  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);

  let data: unknown;
  try {
    data = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rawPages = (data as Record<string, unknown>).pages;
  if (!Array.isArray(rawPages) || rawPages.length === 0) return null;

  const pages: ComicStoryPage[] = [];
  const pageNumbers = new Set<number>();
  for (const item of rawPages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.page !== "number" ||
      !Number.isInteger(obj.page) ||
      obj.page < 1 ||
      pageNumbers.has(obj.page)
    ) {
      return null;
    }
    if (
      typeof obj.panelCount !== "number" ||
      !Number.isInteger(obj.panelCount) ||
      obj.panelCount < 1
    ) {
      return null;
    }
    const panels = parsePanelArray(obj.panels);
    if (!panels) return null;
    const layoutTemplate = resolveStoryLayoutTemplateWithDeterministicFallback(
      obj.page,
      panels.length,
      obj.layoutTemplateId,
    );
    // rows は任意。壊れている場合はページ全体を落とさず、rows/layoutPlan だけを
    // 丸ごと捨てて従来経路へ戻す（旧履歴・AIの省略との後方互換）。
    const rows = parseStoryRows(obj.rows, obj.panelCount);
    const layoutPlan = rows
      ? synthesizeSlotsFromRows(rows, obj.panelCount, readingDirection)
      : null;
    pageNumbers.add(obj.page);
    // cast の正規化（検証で落とさず、構成的に不変条件を作る）:
    //   cast := dedupe(rawCast ∪ panels の characters 和集合)
    // これで「panels に出る名前 ⊆ cast」が常に成立し、cast 欠落・空・部分欠けの
    // すべてがこの1規則で埋まる。parse を null にする新条件は足さない。
    const rawCast = Array.isArray(obj.cast)
      ? obj.cast
          .filter((n): n is string => typeof n === "string")
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
      : [];
    const cast: string[] = [];
    const castSeen = new Set<string>();
    for (const name of [...rawCast, ...unionPanelCharacters(panels)]) {
      if (castSeen.has(name)) continue;
      castSeen.add(name);
      cast.push(name);
    }
    pages.push({
      page: obj.page,
      synopsis: typeof obj.synopsis === "string" ? obj.synopsis.trim() : "",
      layoutHint: typeof obj.layoutHint === "string" ? obj.layoutHint.trim() : "",
      cast,
      panelCount: obj.panelCount,
      panels,
      ...(layoutTemplate ? { layoutTemplateId: layoutTemplate.id } : {}),
      ...(rows && layoutPlan ? { rows, layoutPlan } : {}),
    });
  }

  return pages.sort((a, b) => a.page - b.page);
}

/**
 * 構成がページ数・コマ数の条件と一致するかを判定する（生成前の関所）。
 *
 * - pages.length: expectedPages 指定時は === expectedPages、未指定時は 1 以上（上限なし）
 * - page 番号が 1..pages.length の連番（ソート済み前提で pages[i].page === i + 1）
 * - 各ページ: panelCount が templatePanelCount 指定時は === templatePanelCount、
 *   未指定時は 1..MAX_PANELS_PER_PAGE
 * - 各ページ: isValidPanelSet(page.panels, page.panelCount)（既存関数をそのまま使う）
 */
export function isValidStory(
  pages: ComicStoryPage[],
  opts: {
    expectedPages?: number;
    templatePanelCount?: number;
    /** おまかせ新規生成で、各ページの12テンプレ選択を必須にする。 */
    requireLayoutTemplateId?: boolean;
  },
): boolean {
  const { expectedPages, templatePanelCount, requireLayoutTemplateId = false } = opts;
  // ページ数の上限判定は撤廃（2026-07-28 STΛCK指示）。ページ生成は並列＋セマフォで
  // 順番に消化されるため、枚数はここで遮断しない。1ページ未満だけが不正。
  if (expectedPages !== undefined) {
    if (pages.length !== expectedPages) return false;
  } else if (pages.length < 1) {
    return false;
  }
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    // ソート済み前提。連番が欠けていれば（1,2,4 等）ここで落ちる。
    if (page.page !== i + 1) return false;
    if (templatePanelCount !== undefined) {
      if (page.panelCount !== templatePanelCount) return false;
    } else if (page.panelCount < 1 || page.panelCount > MAX_PANELS_PER_PAGE) {
      return false;
    }
    if (requireLayoutTemplateId) {
      const selectedTemplate = ALL_COMIC_LAYOUT_TEMPLATES.find(
        (template) => template.id === page.layoutTemplateId,
      );
      if (!selectedTemplate || selectedTemplate.panelCount !== page.panelCount) return false;
    }
    if (!isValidPanelSet(page.panels, page.panelCount)) return false;
  }
  return true;
}

/**
 * パース済みコマ配列が、テンプレのコマ数・番号と一致するかを判定する。
 *
 * parseComicName は「非空・index 一意・1以上」までしか見ない（テンプレを知らない）。
 * テンプレとの突き合わせはここで行う: 要素数 === panelCount かつ index が
 * 1..panelCount の連番で揃っていること。順序は問わない（呼び出し側が昇順へ整える）。
 *
 * 期待コマ数は必ずテンプレ (`template.panelCount`) から渡す。実行時点の値を
 * 決め打ちしない。
 */
export function isValidPanelSet(panels: ComicPanel[], panelCount: number): boolean {
  if (panels.length !== panelCount) return false;
  const seen = new Set<number>();
  for (const panel of panels) {
    if (panel.index < 1 || panel.index > panelCount) return false;
    if (seen.has(panel.index)) return false;
    seen.add(panel.index);
  }
  return seen.size === panelCount;
}

/** 参照画像がある時に足す画風変換句（同一性の維持）。 */
const REFERENCE_IDENTITY_CLAUSE =
  "redraw every referenced subject as a hand-drawn manga character in this exact style — never photorealistic — while keeping their identity, hairstyle, outfit, and distinctive features recognizable";

/** 参照画像のポーズ・構図を写してしまうのを防ぐ句。 */
const REFERENCE_POSE_CLAUSE =
  "use the reference images only for the character's appearance and identity — do not copy the reference's pose, framing, or camera distance; follow this panel's composition instructions instead";

/**
 * 参照画像の描画スタイル（写真調・3D調）が画風に勝つのを防ぐ句。
 *
 * identity / pose 句だけでは「白黒漫画にもアニメ調にもならない」実機FB
 * (2026-07-28 STΛCK) があったため、レンダリングスタイルの無視を明示する。
 */
const REFERENCE_STYLE_DOMINANCE_CLAUSE =
  "completely ignore the reference image's rendering style — whether photographic, 3D, or painterly — and redraw everything strictly in this page's manga art style";

/**
 * 画風「キャラ忠実」(faithful) 専用。参照画像の描画スタイルを**そのまま保つ**句。
 *
 * mono/color とは狙いが正反対で、REFERENCE_STYLE_DOMINANCE_CLAUSE
 * （参照の画風を無視して漫画へ変換する）とは併用しない。faithful では
 * この句が STYLE_DOMINANCE と finalStyleClause の代わりに入る。
 * ポーズ・構図だけは各コマの指示に従わせるため、POSE 句相当の意図を末尾に含む。
 */
const REFERENCE_FAITHFUL_CLAUSE =
  "preserve the reference images' original rendering style, medium, and level of realism exactly — do not convert to a different art style; keep pose and framing following each panel's composition instructions";

/**
 * 画風「キャラ忠実」(faithful) 専用の同一性句。
 *
 * mono/color 用の REFERENCE_IDENTITY_CLAUSE は「漫画キャラとして描き直せ
 * （never photorealistic）」を含むため、faithful の「元の画風を保て
 * （do not convert）」と同居すると指示が矛盾する。faithful では
 * 描き直しを求めず、参照どおりの見た目の再現だけを指示する。
 */
const REFERENCE_FAITHFUL_IDENTITY_CLAUSE =
  "depict every referenced subject exactly as they appear in the reference images — same face, hairstyle, outfit, and distinctive features";

/**
 * 画風「キャラ忠実」(faithful) の最終仕上げ句。
 * mono/color の finalStyleClause（漫画調へ寄せる）とは併用しない。
 */
const FAITHFUL_FINAL_CLAUSE =
  "final output must look like a professional comic page where every panel faithfully reproduces the referenced characters' appearance and original art style, with consistent rendering across panels";

/** faithful の1コマ再編集では、reference image 1（元ページ）を画風アンカーにする。 */
const FAITHFUL_PANEL_BASE_CLAUSE =
  "manga panel edit, rendered in the exact art style of the existing page — reference image 1 is the page being edited; match its style precisely";

/** faithful の1コマ再編集専用の仕上げ句。未編集コマとの画風一致を要求する。 */
const FAITHFUL_PANEL_FINAL_CLAUSE =
  "the edited panel must be indistinguishable in style from the untouched panels around it";

/**
 * 作品に固定した画風のお手本へ一致させる句。
 * ページ丸ごと生成・旧コマ生成・1コマ再編集で同じ関数を使い、要求の強さを揃える。
 */
export function comicStyleAnchorMatchClause(referenceIndex: number): string {
  return `reference image ${referenceIndex} is the approved art-style anchor for this manga work — it is the sole authority for rendering style and is exempt from any instruction to ignore reference rendering styles; match its style precisely, including its line work, shading, coloring, texture, and level of detail`;
}

/** 既存の faithful 再編集と同じく、末尾でも「見分けがつかない一致」を要求する。 */
function comicStyleAnchorFinalClause(referenceIndex: number): string {
  return `the generated artwork must be indistinguishable in style from the approved art-style anchor in reference image ${referenceIndex}`;
}

/**
 * ページの形（縦長）と、全ページで同じ大きさに揃えることを念押しする句。
 *
 * 生成サイズがページごとにバラつく実機FB (2026-07-28 STΛCK) への対応。
 * 機械側は `images.generateBatch` の `aspect` (COMIC_PAGE_ASPECT) で指定するが、
 * プロンプト側にも同じ意図を1句だけ足して取りこぼしを減らす。
 * detail 経路（コマ）と主経路（ページ）の両方で同一文字列を使う。
 */
const PAGE_SIZE_CLAUSE = "portrait page, consistent page size";

/**
 * メタ情報の焼き込み禁止句。プロンプトには「page 3 of 8」「panel 1:」等の
 * 構造記述が必要だが、モデルがそれを絵に描き込む実機FBがあった (2026-07-29 STΛCK:
 * ページ番号・テンプレの縦横サイズ・謎の数字が出力画像に入る)。
 * 構造記述は残しつつ「画面上に描いてよい文字はセリフと擬音だけ」を明示する。
 * ページ経路 (buildFullPagePrompt) とコマ経路 (buildPanelImagePrompt) の両方で使う。
 */
const NO_META_TEXT_CLAUSE =
  "do not render any meta text or numbers on the image — no page numbers, no panel numbers, no dimensions or measurements, no template or layout labels; page/panel numbering in this prompt is structural context only, never draw it; the only text allowed on the page is the given dialogue and sound effects";

/**
 * 最終出力の画風を末尾で念押しする句（参照画像のフォト/3D調に勝たせる）。
 *
 * detail 経路（buildPanelImagePrompt）と主経路（buildFullPagePrompt）で
 * 同一文字列を使うため1箇所に置く（重複定義しない）。
 *
 * 引数は mono/color だけを受ける。faithful は「参照の画風をそのまま保つ」で
 * 狙いが逆であり、専用の FAITHFUL_FINAL_CLAUSE を呼び出し側が使う
 * （ここへ faithful を渡すと mono 扱いで漫画調へ寄せてしまうため、型で塞ぐ）。
 */
function finalStyleClause(colorMode: Exclude<ComicColorMode, "faithful">): string {
  return colorMode === "color"
    ? "final output must look like a professional Japanese color manga illustration: clean ink lines, anime cel shading, no photographic textures"
    : "final output must look like a page from a professional Japanese black-and-white manga: ink lines, screentones, no photographic textures";
}

type IndexedSlot = ComicPanelSlot & { i: number };

/**
 * スロットを y 帯の重なりで「段（row）」にまとめる (describePageLayout の段検出を
 * 共有化。B-1 の位置語導出 panelPositionPhrases と同じ段構造を使うため)。
 * 各スロットは元配列 index (= 読み順) を i に持つ。
 */
function groupSlotsIntoRows(template: ComicLayoutTemplate): IndexedSlot[][] {
  const slots = template.slots.map((s, i) => ({ ...s, i }));
  const sorted = [...slots].sort((a, b) => a.y - b.y || b.x - a.x);
  const rows: IndexedSlot[][] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (const slot of sorted) {
    // 現在の段の下端より上に始まるなら同じ段（斜めコマの数percentのズレを吸収）。
    if (rows.length > 0 && slot.y < bottom) {
      rows[rows.length - 1].push(slot);
      bottom = Math.min(bottom, slot.y + slot.h);
    } else {
      rows.push([slot]);
      bottom = slot.y + slot.h;
    }
  }
  return rows;
}

/** rows の番号どおりに layoutPlan を段へ束ねる。座標からの段再検出はしない。 */
function layoutPlanRows(
  slots: ComicPanelSlot[],
  rows: number[][] | undefined,
): IndexedSlot[][] | null {
  const parsed = parseStoryRows(rows, slots.length);
  if (!parsed) return null;
  return parsed.map((row) =>
    row.map((panelNumber) => ({ ...slots[panelNumber - 1], i: panelNumber - 1 })),
  );
}

function positionPhrasesFromRows(
  rows: IndexedSlot[][],
  slotCount: number,
  direction: ComicReadingDirection,
): string[] {
  const phrases: string[] = new Array(slotCount).fill("");
  rows.forEach((row, ri) => {
    const vertical =
      rows.length === 1 ? "middle" : ri === 0 ? "top" : ri === rows.length - 1 ? "bottom" : "middle";
    const ordered = [...row].sort((a, b) => a.i - b.i);
    ordered.forEach((slot, j) => {
      if (row.length === 1) {
        phrases[slot.i] = `${vertical}, full width`;
        return;
      }
      const horizontal =
        j === 0
          ? direction === "ltr"
            ? "left"
            : "right"
          : j === row.length - 1
            ? direction === "ltr"
              ? "right"
              : "left"
            : "center";
      phrases[slot.i] = `${vertical}-${horizontal}`;
    });
  });
  return phrases;
}

/**
 * 各コマ (配列順 = 読み順) の紙面位置語を導出する (B-1 2026-07-30)。
 * 例: "top-right" / "top-center" / "middle, full width" / "bottom-left"。
 *
 * 段内の順序はスロット座標でなく **読み順 (配列 index)** で決める。
 * rtl では読み順どおり右→左 (テンプレ座標と一致)、ltr では同じ段構造を
 * 左右反転して panel 1 が top-left になるように語を割り当てる
 * (レイアウトはAIが描き直すため、座標の実位置でなく「panel N をどこに
 * 置かせたいか」が正)。
 */
export function panelPositionPhrases(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): string[] {
  const rows = groupSlotsIntoRows(template);
  return positionPhrasesFromRows(rows, template.slots.length, direction);
}

/**
 * テンプレのスロットから「段（row）ごとに何コマ・どの大きさか」を英語1行で導出する。
 *
 * 手書きの決め打ちをしない（テンプレを足したら自動で追従する）。導出手順:
 *   1. スロットを y 昇順に見て、**y帯が重なるもの**を同じ段にまとめる
 *      （斜めコマ割りで y が数 percent ずれても同じ段として拾えるように、
 *        「次のスロットの y が、現在の段の下端より上にあるか」で判定する）
 *   2. 各段のコマを面積（w*h。ページ実比率は段内比較では不要）で相対分類し、
 *      `two small panels` / `one large panel` のような語にする
 *
 * 例: `row 1: three small panels; row 2: one large wide panel; row 3: two medium panels`
 */
function describeRowsLayout(
  slots: ComicPanelSlot[],
  pageAspect: { w: number; h: number },
  rows: IndexedSlot[][],
  direction: ComicReadingDirection,
): string {
  if (slots.length === 0) return "";

  // ページ全体の平均コマ面積。大小の基準はテンプレ内から導出する（定数の決め打ちをしない）。
  const areas = slots.map((s) => s.w * s.h);
  const avgArea = areas.reduce((a, b) => a + b, 0) / areas.length;

  const countWord = (n: number): string =>
    ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ??
    String(n);

  const parts = rows.map((row, ri) => {
    // 段内のコマは読み順に見る
    const ordered = [...row].sort((a, b) => a.i - b.i);
    // 段内で面積がほぼ同じなら1グループにまとめて「N panels」と言う。
    const describeSize = (w: number, h: number): string => {
      const area = w * h;
      const size = area >= avgArea * 1.5 ? "large" : area <= avgArea * 0.6 ? "small" : "medium";
      // 実アスペクト比（pageAspect 込み）で横長/縦長を足す
      const ratio = (w * pageAspect.w) / (h * pageAspect.h);
      const shape = ratio >= 1.4 ? " wide" : ratio <= 0.72 ? " tall" : "";
      return `${size}${shape}`;
    };
    // 連続する同サイズをまとめる
    const groups: Array<{ label: string; n: number }> = [];
    for (const slot of ordered) {
      const label = describeSize(slot.w, slot.h);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.n += 1;
      else groups.push({ label, n: 1 });
    }
    const desc = groups
      .map((g) => `${countWord(g.n)} ${g.label} panel${g.n > 1 ? "s" : ""}`)
      .join(" then ");
    return `row ${ri + 1}: ${desc}`;
  });

  return `${parts.join("; ")}; within each row the panels are numbered in ${
    direction === "ltr" ? "left-to-right" : "right-to-left"
  } order`;
}

function describePageLayout(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): string {
  return describeRowsLayout(
    template.slots,
    template.pageAspect,
    groupSlotsIntoRows(template),
    direction,
  );
}

function formatPercent(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** layoutPlan の bbox をページpercentとして全コマ分明示する。 */
function describeLayoutCoordinates(slots: ComicPanelSlot[]): string {
  return slots
    .map(
      (slot, index) =>
        `panel ${index + 1} bounds: x ${formatPercent(slot.x)}%-${formatPercent(slot.x + slot.w)}%, y ${formatPercent(slot.y)}%-${formatPercent(slot.y + slot.h)}%`,
    )
    .join("; ");
}

/** ページ生成プロンプトへ渡す、ページ番号・前後のあらすじ・コマ割り方針。 */
export type FullPageContext = {
  pageNumber?: number;
  totalPages?: number;
  prevSynopsis?: string;
  currentSynopsis?: string;
  nextSynopsis?: string;
  /** テンプレ未指定時のみ使うコマ割り方針（構成 AI 由来・ユーザー編集可）。 */
  layoutHint?: string;
  /** テンプレ未指定時の行構造。上から順、各行の値は読み順のコマ番号。 */
  rows?: number[][];
  /** rows から合成済みのページpercent座標。rows と揃う場合だけ焼き込む。 */
  layoutPlan?: ComicPanelSlot[];
  /** このページの cast（名前一致解決済みのみ）。指定時は「このページに出るのはこの面々だけ」句を足す。 */
  castNames?: string[];
  /** 読み方向 (B-1)。省略時 "rtl" (右→左・日本式)。 */
  readingDirection?: ComicReadingDirection;
  /** 枠線の太さ (B-4b)。省略時 "standard" = 従来と同一文字列。 */
  frameStyle?: ComicFrameStyle;
  /** コマ間隔 (B-4b)。省略時 "standard" = 従来と同一文字列。 */
  gutterStyle?: ComicGutterStyle;
  /** 環境参照（背景・小物）。resolvePageCast の envReferences をそのまま渡す（3ir）。 */
  envReferences?: Array<{ name: string; kind: "location" | "item" }>;
  /** refImagePaths のうちキャラ参照の枚数。環境参照のインデックス起点（3ir）。 */
  charRefCount?: number;
  /** 絵柄テキスト（qvs）。空/未指定は従来どおり。faithful では呼び出し側が渡さない。 */
  styleText?: string;
  /** 作品に固定した画風のお手本が、プロンプト上で何番目の参照画像か。 */
  styleAnchorReferenceIndex?: number;
  /** scaffold 等、キャラ参照より前に呼び出し側が置く参照画像の枚数。 */
  referenceIndexOffset?: number;
};

/**
 * 絵柄テキスト句（qvs 2026-08-03）。ページ経路とコマ経路で**同一文字列**を使う
 * （PAGE_SIZE_CLAUSE と同じ「両経路で同一句」原則）。
 */
const STYLE_TEXT_CLAUSE = (text: string): string =>
  `art style: ${text} — apply this exact art style consistently to every panel and every page`;

type PromptEnvReference = { name: string; kind: "location" | "item" };

/** キャラ参照との区分句 + 環境参照ごとの固定句（ページ/コマ共通）。 */
function environmentReferenceClauses(
  envReferences: PromptEnvReference[],
  charRefCount: number,
  hasCharReferences: boolean,
  referenceIndexOffset = 0,
): string[] {
  const clauses: string[] = [];
  if (hasCharReferences && envReferences.length > 0) {
    const firstCharacterIndex = referenceIndexOffset + 1;
    const lastCharacterIndex = referenceIndexOffset + charRefCount;
    clauses.push(
      `reference images ${firstCharacterIndex}-${lastCharacterIndex} are character references — the character identity instructions apply only to these images`,
    );
  }
  envReferences.forEach((reference, index) => {
    const refIndex = referenceIndexOffset + charRefCount + 1 + index;
    clauses.push(
      reference.kind === "item"
        ? `reference image ${refIndex}: 「${reference.name}」 — a fixed prop reference; whenever this object appears in any panel on any page, reproduce this exact design: same shape, proportions, colors, materials, and details; never redesign or restyle it between panels or pages`
        : `reference image ${refIndex}: 「${reference.name}」 — a fixed location/background reference; whenever this place appears in any panel on any page, reproduce this exact environment: same layout, architecture, furniture, colors, and details; never redesign it between panels or pages`,
    );
  });
  return clauses;
}

/** このコマに実際に登場するキャラだけの属性句を導出する。 */
function panelCharacterAttributeBlock(
  panel: Pick<ComicPanel, "characters">,
  characters: ComicCharacter[],
): string {
  return characters
    .filter((character) =>
      panel.characters.some((name) => name.trim() === character.name.trim()),
    )
    .map((character) =>
      character.attributes?.trim()
        ? `${character.name}: ${character.attributes.trim()}`
        : "",
    )
    .filter(Boolean)
    .join("; ");
}

const DIALOGUE_AND_SFX_FINISH_CLAUSE =
  "hand-drawn speech balloons with vertical Japanese text — write the dialogue exactly as given, character for character, do not invent or alter any text; bold hand-lettered manga sound effects integrated with the art";

const STRUCTURE_PANEL_MONO_BASE_CLAUSE =
  "single manga panel artwork, black and white manga illustration, professional ink line art, screentone shading";
const STRUCTURE_PANEL_COLOR_BASE_CLAUSE =
  "single manga panel artwork, full color manga illustration, clean ink line art, anime-style cel shading, vibrant colors";
const STRUCTURE_PANEL_FAITHFUL_BASE_CLAUSE =
  "single manga panel artwork, rendered in the exact art style of the reference images";
const STRUCTURE_PANEL_FULL_BLEED_CLAUSE =
  "full-bleed single panel: draw the scene edge to edge — no panel frame, no border lines, no gutters, no surrounding panels; the frame will be added mechanically afterwards";
const STRUCTURE_PANEL_EDGE_MARGIN_CLAUSE =
  "keep every speech balloon and sound effect fully inside the artwork with a comfortable margin from all edges (the outer edges may be trimmed slightly)";
const STRUCTURE_PANEL_FAITHFUL_FINAL_CLAUSE =
  "faithfully reproduce the referenced characters' appearance and original art style";

function structureBalloonOrderClause(direction: ComicReadingDirection): string {
  return direction === "ltr"
    ? "balloons read left to right — the first quoted balloon sits toward the upper LEFT of the panel"
    : "balloons read right to left — the first quoted balloon sits toward the upper RIGHT of the panel";
}

/**
 * ページ丸ごと1枚を生成するプロンプトを組む（主経路）。
 *
 * template=null で rows/layoutPlan が揃うときは座標・段構造・全コマ位置語を焼き込む。
 * layoutPlan が無い旧データだけは AI にコマ割りを最適化させる（layoutHint を補助に渡す）。
 * template があるときは従来どおり describePageLayout で slots から機械導出する。
 *
 * 参照画像があるときは detail 経路（buildPanelImagePrompt）と同じ画風支配句
 * （REFERENCE_STYLE_DOMINANCE_CLAUSE）を足し、末尾でも finalStyleClause で
 * 画風を念押しする。参照の写真調・3D調が画風に勝って「白黒漫画にもアニメ調にも
 * ならない」実機FB (2026-07-28 STΛCK) への対応。
 */
export function buildFullPagePrompt(
  panels: ComicPanel[],
  template: ComicLayoutTemplate | null,
  characters: ComicCharacter[],
  colorMode: ComicColorMode = "mono",
  hasReferences = false,
  context: FullPageContext = {},
): string {
  const parts: string[] = [];

  const direction = context.readingDirection ?? "rtl";
  const plannedRows =
    !template && context.layoutPlan?.length === panels.length
      ? layoutPlanRows(context.layoutPlan, context.rows)
      : null;
  // B-1 (2026-07-30): 読み順を「言葉1句」でなく空間位置で明示する。
  // 従来の "Japanese right-to-left reading order." 1句では panel 1 の置き場所が
  // 未指定で、モデルが西洋コミックの学習分布に引かれて左上から並べていた
  // (実機報告4件)。効果は確率的 (保証はない)。
  const readingOrderClause =
    direction === "ltr"
      ? "CRITICAL reading order: left-to-right (western comic style) — panel 1 is the TOP-LEFT panel, panels flow left to right, then top to bottom; the last panel is the BOTTOM-RIGHT panel. never arrange panels right-to-left; within each panel, speech balloons follow the same left-to-right order — the first quoted balloon sits on the LEFT side of its panel and is read first"
      : "CRITICAL reading order: Japanese manga right-to-left — panel 1 is the TOP-RIGHT panel, panels flow right to left, then top to bottom; the last panel is the BOTTOM-LEFT panel. never arrange panels left-to-right; within each panel, speech balloons follow the same right-to-left order — the first quoted balloon sits on the RIGHT side of its panel and is read first, even if its text is written horizontally";

  // 1. ベース句（mono/color は既存文字列・無変更。faithful だけ新規）
  parts.push(
    colorMode === "faithful"
      ? "one complete manga page composed of comic panels, rendered in the exact art style of the reference images"
      : colorMode === "color"
        ? "one complete manga page, full color manga illustration, clean ink line art, anime-style cel shading, vibrant colors"
        : "one complete manga page, black and white manga illustration, professional ink line art, screentone shading",
  );

  // 1b. 絵柄句（qvs）。faithful は参照画像が絵柄の供給源なので受けない（呼び出し側
  //     ゲートに加えた二重防御）。空文字は従来どおり何も足さない。
  const styleText = context.styleText?.trim();
  if (styleText && colorMode !== "faithful") {
    parts.push(STYLE_TEXT_CLAUSE(styleText));
  }
  if (context.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorMatchClause(context.styleAnchorReferenceIndex));
  }

  // 2. レイアウト句
  if (template) {
    const layout = describePageLayout(template, direction);
    parts.push(
      `${template.panelCount} panels. ${readingOrderClause}.${layout ? ` ${layout}` : ""}`,
    );
  } else if (context.layoutPlan && plannedRows) {
    const hint = context.layoutHint?.trim();
    const pageAspect = COMIC_LAYOUT_TEMPLATES[0].pageAspect;
    const layout = describeRowsLayout(context.layoutPlan, pageAspect, plannedRows, direction);
    const coordinates = describeLayoutCoordinates(context.layoutPlan);
    parts.push(
      `${panels.length} panels. ${readingOrderClause}. follow this exact panel layout: ${layout}. exact page-percent coordinates — ${coordinates}${hint ? `. layout direction: ${hint}` : ""}`,
    );
  } else {
    const hint = context.layoutHint?.trim();
    parts.push(
      `${panels.length} panels. ${readingOrderClause}. design the panel layout yourself for maximum readability and dramatic impact: vary panel sizes and shapes, give the key moment the largest panel, keep the gutters clean${hint ? `. layout direction: ${hint}` : ""}`,
    );
  }
  parts.push(
    "uniform outer margin on all four sides — do not extend panels to the page edges",
  );

  // 3. 連続ストーリー文脈（複数ページのときだけ）
  if ((context.totalPages ?? 1) > 1 && context.pageNumber) {
    const seg: string[] = [];
    if (context.prevSynopsis?.trim()) seg.push(`previous page: 「${context.prevSynopsis.trim()}」`);
    if (context.currentSynopsis?.trim()) seg.push(`this page: 「${context.currentSynopsis.trim()}」`);
    if (context.nextSynopsis?.trim()) seg.push(`next page: 「${context.nextSynopsis.trim()}」`);
    parts.push(
      `this is page ${context.pageNumber} of ${context.totalPages} in one continuous manga story${
        seg.length > 0 ? `. story context — ${seg.join("; ")}` : ""
      }`,
    );
  }

  // 3b. cast 限定句（前後ページの synopsis に出る他キャラを描かせない）
  if (context.castNames && context.castNames.length > 0) {
    parts.push(
      `characters appearing on this page: ${context.castNames.join(", ")} only — do not draw any other named recurring character on this page; other names in the story context are context only`,
    );
  }

  // 4. コマごとの内容（セリフ・擬音は日本語のまま渡す）
  // 位置語はテンプレとコマ数が一致するときだけ導出する (B-4 のコマ追加/削除で
  // ズレたページは呼び出し側が template=null を渡すが、二重の防御)。
  const positionPhrases =
    template && panels.length === template.slots.length
      ? panelPositionPhrases(template, direction)
      : context.layoutPlan && plannedRows
        ? positionPhrasesFromRows(plannedRows, context.layoutPlan.length, direction)
        : null;
  for (const panel of panels) {
    const body = panel.prompt.trim() || panel.composition.trim();
    const balloonSfxClause = buildPanelBalloonSfxClause(panel);
    const pos = positionPhrases?.[panel.index - 1]
      ? ` (${positionPhrases[panel.index - 1]})`
      : !template && panels.length > 1 && panel.index === 1
        ? ` (${direction === "ltr" ? "top-left" : "top-right"} opening panel)`
        : !template && panels.length > 1 && panel.index === panels.length
          ? ` (${direction === "ltr" ? "bottom-right" : "bottom-left"} final panel)`
          : "";
    parts.push(
      `panel ${panel.index}${pos}: ${body}.${balloonSfxClause ? ` ${balloonSfxClause}` : ""}`,
    );
  }

  // 5. 参照画像がある時だけ同一性・ポーズ写し防止・画風句（mono/color は既存文字列・無変更）
  //
  // faithful は狙いが逆（参照の画風をそのまま保つ）ので、画風を漫画へ変換させる
  // STYLE_DOMINANCE の代わりに REFERENCE_FAITHFUL_CLAUSE を入れる。
  // 同一性（IDENTITY）も faithful では専用句を使う。mono/color 用の
  // REFERENCE_IDENTITY_CLAUSE は「漫画キャラとして描き直せ（never photorealistic）」を
  // 含み、faithful の「元の画風を保て（do not convert）」と矛盾するため。
  // ポーズ非写し（POSE）は faithful でも要るので共通。
  //
  // 3ir (2026-08-03): キャラ参照句（既存・無変更）→ ロール区分（新規）→
  // 環境参照句（新規）→ 画風支配句（既存・無変更）の順。
  // hasReferences は「キャラ参照が1枚以上」の意味（呼び出し側が charRefCount で渡す）。
  const envRefs = context.envReferences ?? [];
  const charRefCount = context.charRefCount ?? 0;
  if (hasReferences) {
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_IDENTITY_CLAUSE
        : REFERENCE_IDENTITY_CLAUSE,
    );
    parts.push(REFERENCE_POSE_CLAUSE);
  }
  parts.push(
    ...environmentReferenceClauses(
      envRefs,
      charRefCount,
      hasReferences,
      context.referenceIndexOffset ?? 0,
    ),
  );
  // 画風支配句は「どちらかの参照があれば」出す（環境参照の写真調が画風に勝つ事故対策）。
  if (hasReferences || envRefs.length > 0) {
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_CLAUSE
        : REFERENCE_STYLE_DOMINANCE_CLAUSE,
    );
  }

  // 6. 仕上げ句（文字を発明・改変させない指示を追加した確定文字列）
  // B-4b (2026-07-30): 枠線・間隔はプロンプト近似 (AI任せ・保証なし)。
  // 既定 (standard/standard) では従来と同一文字列になる。
  const frame = context.frameStyle ?? "standard";
  const gutter = context.gutterStyle ?? "standard";
  const borderWord =
    frame === "thin"
      ? "thin clean black panel borders"
      : frame === "bold"
        ? "bold thick black panel borders"
        : "clean black panel borders";
  const gutterWord =
    gutter === "narrow"
      ? "narrow white gutters between panels"
      : gutter === "wide"
        ? "wide white gutters between panels"
        : "white gutters";
  parts.push(`${DIALOGUE_AND_SFX_FINISH_CLAUSE}; ${borderWord} and ${gutterWord}`);

  // 6b. 最終出力の画風を末尾で念押しする。
  // mono/color は参照画像のフォト/3D調に勝たせる（実機FB 2026-07-28 STΛCK）。
  // faithful は逆に「参照の画風を忠実に再現した」ことを念押しする専用句を使う。
  parts.push(
    colorMode === "faithful" ? FAITHFUL_FINAL_CLAUSE : finalStyleClause(colorMode),
  );
  if (context.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorFinalClause(context.styleAnchorReferenceIndex));
  }

  // 6c. ページの形・大きさを全ページで揃える（生成サイズのバラつき対策）。
  parts.push(PAGE_SIZE_CLAUSE);
  parts.push(NO_META_TEXT_CLAUSE);

  // 7. キャラ属性ブロック（登場する全キャラ分。1コマ生成の attrBlock と同じ導出）
  const appearingNames = new Set(
    panels.flatMap((p) => p.characters.map((n) => n.trim())),
  );
  const appearing = characters.filter((c) => appearingNames.has(c.name.trim()));
  const attrBlock = (appearing.length > 0 ? appearing : characters)
    .map((c) => (c.attributes?.trim() ? `${c.name}: ${c.attributes.trim()}` : ""))
    .filter(Boolean)
    .join("; ");
  if (attrBlock) parts.push(`character design — ${attrBlock}`);

  return parts.filter(Boolean).join(", ");
}

/**
 * 塗り絵方式（stencil）でだけ足す句（設計書 §2）。
 *
 * 1枚目の参照画像は機械が描いた枠だけのページ（scaffold）で、対になるマスクの
 * 白い部分がコマの内側。枠線・ガター・外周は生成後に機械が焼き戻すため、AIには
 * 「白い所だけに描け・黒い線には触るな」だけを伝える。
 */
export const STENCIL_FRAME_CLAUSE =
  "the first reference image is the fixed panel frame layout of this page — draw the manga artwork and speech balloons ONLY inside the white panel areas of the mask; never redraw, move, or cover the black frame lines, gutters, or outer margins";

/**
 * 既存のページプロンプトへ stencil 句を足す（塗り絵生成のときだけ呼ぶ）。
 *
 * 既存句には一切触らず末尾に1句足すだけ。区切りは buildFullPagePrompt の
 * parts 連結と同じ `, ` にして、ページ経路のプロンプトの見え方を揃える。
 */
export function buildStencilPagePrompt(basePagePrompt: string): string {
  return `${basePagePrompt}, ${STENCIL_FRAME_CLAUSE}`;
}

/**
 * 「きっちりコマ割り」で初回生成する、1コマ分のプロンプトを組む。
 *
 * ページ枠は後段の機械合成で描くため、AIには枠・ガターを描かせない。
 * ページ生成ではないので PAGE_SIZE_CLAUSE も入れず、スロット比率は呼び出し側の
 * aspectヒントとcover-clipで扱う。
 */
export function buildStructurePanelPrompt(args: {
  panel: ComicPanel;
  characters: ComicCharacter[];
  colorMode: ComicColorMode;
  styleText?: string;
  hasCharRefs: boolean;
  envReferences?: PromptEnvReference[];
  charRefCount?: number;
  /** 作品に固定した画風のお手本が、プロンプト上で何番目の参照画像か。 */
  styleAnchorReferenceIndex?: number;
  /** キャラ参照より前に置く、お手本等の参照画像の枚数。 */
  referenceIndexOffset?: number;
  direction: ComicReadingDirection;
  pageContext: { panelNo: number; panelTotal: number; synopsis: string };
}): string {
  const {
    panel,
    characters,
    colorMode,
    hasCharRefs,
    direction,
    pageContext,
  } = args;
  const envReferences = args.envReferences ?? [];
  const charRefCount = args.charRefCount ?? 0;
  const parts: string[] = [
    colorMode === "faithful"
      ? STRUCTURE_PANEL_FAITHFUL_BASE_CLAUSE
      : colorMode === "color"
        ? STRUCTURE_PANEL_COLOR_BASE_CLAUSE
        : STRUCTURE_PANEL_MONO_BASE_CLAUSE,
    STRUCTURE_PANEL_FULL_BLEED_CLAUSE,
  ];

  const styleText = args.styleText?.trim();
  if (styleText && colorMode !== "faithful") {
    parts.push(STYLE_TEXT_CLAUSE(styleText));
  }
  if (args.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorMatchClause(args.styleAnchorReferenceIndex));
  }

  if (hasCharRefs) {
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_IDENTITY_CLAUSE
        : REFERENCE_IDENTITY_CLAUSE,
    );
    parts.push(REFERENCE_POSE_CLAUSE);
  }
  parts.push(
    ...environmentReferenceClauses(
      envReferences,
      charRefCount,
      hasCharRefs,
      args.referenceIndexOffset ?? 0,
    ),
  );
  if (hasCharRefs || envReferences.length > 0) {
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_CLAUSE
        : REFERENCE_STYLE_DOMINANCE_CLAUSE,
    );
  }

  parts.push(panel.prompt.trim() || panel.composition.trim());

  const balloonLines = balloonPromptLines(panel);
  if (balloonLines.length > 0) {
    parts.push(
      `speech balloon${balloonLines.length > 1 ? "s" : ""}: ${balloonLines.join(" ")}`,
    );
  }
  parts.push(structureBalloonOrderClause(direction));
  parts.push(STRUCTURE_PANEL_EDGE_MARGIN_CLAUSE);

  const sfxLines = sfxPromptQuotes(panel);
  if (sfxLines.length > 0) {
    parts.push(
      `sound effect${sfxLines.length > 1 ? "s" : ""}: ${sfxLines.join(" ")}`,
    );
  }
  const attrBlock = panelCharacterAttributeBlock(panel, characters);
  if (attrBlock) parts.push(`character design — ${attrBlock}`);
  if (panel.acting.trim()) parts.push(panel.acting.trim());

  parts.push(
    `story context: this is panel ${pageContext.panelNo} of ${pageContext.panelTotal} on one manga page — 「${pageContext.synopsis.trim()}」; keep character appearance and art style consistent with the other panels of this page`,
  );
  parts.push(DIALOGUE_AND_SFX_FINISH_CLAUSE);
  parts.push(
    colorMode === "faithful"
      ? STRUCTURE_PANEL_FAITHFUL_FINAL_CLAUSE
      : finalStyleClause(colorMode),
  );
  if (args.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorFinalClause(args.styleAnchorReferenceIndex));
  }
  parts.push(NO_META_TEXT_CLAUSE);

  return parts.filter(Boolean).join(", ");
}

/**
 * 1コマの画像生成プロンプトを組む。
 * コマの prompt（人が編集済み）に、登場キャラの属性テキストを合成する。
 * 参照画像は既存の refImagePaths 経路で別途渡すので、ここでは属性テキストのみ足す。
 *
 * `colorMode` は mono/color の漫画化句と faithful の既存ページ忠実句を切り替える
 * （既定 "mono" = 従来どおり）。
 *
 * `hasReferences` は「このコマに参照画像が1枚以上渡るか」。実写写真を参照に
 * 渡すと写真調のまま出てしまうため、参照があるときだけ画風変換句
 * （同一性維持・ポーズ非写し・参照の描画スタイル無視）を足して
 * 「同一人物のまま手描き漫画に描き直す」を明示する (2026-07-28 STΛCK 実機FB)。
 * さらに末尾で最終出力の画風を念押しする（参照のフォト/3D調に勝たせる）。
 *
 * faithful は reference image 1（編集元ページ）を画風アンカーとして、未編集コマと
 * 見分けがつかない画風を要求する。mono/color 用の漫画化句とは排他にする。
 */
export function buildPanelImagePrompt(
  panel: ComicPanel,
  characters: ComicCharacter[],
  colorMode: ComicColorMode = "mono",
  hasReferences = false,
  styleText = "",
  options: { styleAnchorReferenceIndex?: number } = {},
): string {
  const base = panel.prompt.trim() || panel.composition.trim();

  // このコマに登場するキャラの属性だけを合成する
  const appearing = characters.filter((c) =>
    panel.characters.some((name) => name.trim() === c.name.trim()),
  );
  const attrBlock = appearing
    .map((c) => (c.attributes?.trim() ? `${c.name}: ${c.attributes.trim()}` : ""))
    .filter(Boolean)
    .join("; ");

  // A-c faithful の6項構成。文言と順序を設計書どおり固定し、mono/color 用の
  // styleText・finalStyleClause・PAGE_SIZE_CLAUSE は混ぜない。
  if (colorMode === "faithful") {
    const faithfulParts = [FAITHFUL_PANEL_BASE_CLAUSE];
    if (options.styleAnchorReferenceIndex !== undefined) {
      faithfulParts.push(
        comicStyleAnchorMatchClause(options.styleAnchorReferenceIndex),
      );
    }
    if (hasReferences) {
      faithfulParts.push(REFERENCE_FAITHFUL_IDENTITY_CLAUSE);
      faithfulParts.push(REFERENCE_POSE_CLAUSE);
    }
    faithfulParts.push(REFERENCE_FAITHFUL_CLAUSE);
    faithfulParts.push(base);
    if (attrBlock) faithfulParts.push(`character design — ${attrBlock}`);
    if (panel.acting.trim()) faithfulParts.push(panel.acting.trim());
    faithfulParts.push(FAITHFUL_PANEL_FINAL_CLAUSE);
    if (options.styleAnchorReferenceIndex !== undefined) {
      faithfulParts.push(
        comicStyleAnchorFinalClause(options.styleAnchorReferenceIndex),
      );
    }
    faithfulParts.push(NO_META_TEXT_CLAUSE);
    return faithfulParts.filter(Boolean).join(", ");
  }

  const parts = [
    colorMode === "color"
      ? "manga panel, full color manga illustration, clean ink line art, anime-style cel shading, vibrant colors"
      : "manga panel, black and white manga illustration, professional ink line art, screentone shading",
  ];
  // 絵柄句（qvs）。ページ経路と同一文字列。空文字は従来どおり何も足さない。
  const trimmedStyle = styleText.trim();
  if (trimmedStyle) {
    parts.push(STYLE_TEXT_CLAUSE(trimmedStyle));
  }
  if (options.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorMatchClause(options.styleAnchorReferenceIndex));
  }
  if (hasReferences) {
    parts.push(REFERENCE_IDENTITY_CLAUSE);
    parts.push(REFERENCE_POSE_CLAUSE);
    parts.push(REFERENCE_STYLE_DOMINANCE_CLAUSE);
  }
  parts.push(base);
  if (attrBlock) parts.push(`character design — ${attrBlock}`);
  if (panel.acting.trim()) parts.push(panel.acting.trim());

  // 最終出力の画風を末尾で念押しする（参照画像のフォト/3D調に勝たせる）。
  parts.push(finalStyleClause(colorMode));
  if (options.styleAnchorReferenceIndex !== undefined) {
    parts.push(comicStyleAnchorFinalClause(options.styleAnchorReferenceIndex));
  }

  // 一気生成はコマ経路を通るため、ページ経路と同じ形・大きさへ揃える句を足す
  // （生成サイズのバラつき対策。aspect も同じ COMIC_PAGE_ASPECT を渡している）。
  parts.push(PAGE_SIZE_CLAUSE);
  parts.push(NO_META_TEXT_CLAUSE);

  return parts.filter(Boolean).join(", ");
}
