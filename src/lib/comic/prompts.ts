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
import { describeSlotShape, type ComicLayoutTemplate } from "./layoutTemplates";
// references.ts は ./types しか import しないため循環しない（cast の導出規則を1箇所に閉じる）。
import { unionPanelCharacters } from "./references";
import type {
  ComicBalloon,
  ComicBalloonKind,
  ComicCharacter,
  ComicColorMode,
  ComicPanel,
  ComicSfx,
  ComicSfxIntent,
  ComicStoryPage,
} from "./types";

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
    '      "panels": [',
    "        {",
    '          "index": ページ内のコマ番号(1始まりの整数),',
    '          "composition": "構図・カメラの説明（引き/寄り、アングル、画角）",',
    '          "characters": ["このコマに登場するキャラ名", ...],',
    '          "acting": "演技・表情・動きの説明",',
    '          "balloons": [{"speaker": "話者名（narration は空文字）", "text": "セリフ", "kind": "normal|shout|monologue|narration"}],',
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
  const KINDS = new Set(["normal", "shout", "monologue", "narration"]);
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
 * 1ページでも壊れていれば全体を null（部分採用しない。黙って切り捨てない）。
 * 返却前に page 昇順へソートする。
 */
export function parseComicStory(raw: string): ComicStoryPage[] | null {
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
  opts: { expectedPages?: number; templatePanelCount?: number },
): boolean {
  const { expectedPages, templatePanelCount } = opts;
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
function describePageLayout(template: ComicLayoutTemplate): string {
  const slots = template.slots.map((s, i) => ({ ...s, i }));
  if (slots.length === 0) return "";

  // ページ全体の平均コマ面積。大小の基準はテンプレ内から導出する（定数の決め打ちをしない）。
  const areas = slots.map((s) => s.w * s.h);
  const avgArea = areas.reduce((a, b) => a + b, 0) / areas.length;

  // 1. y帯の重なりで段にまとめる
  const sorted = [...slots].sort((a, b) => a.y - b.y || b.x - a.x);
  const rows: (typeof sorted)[] = [];
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

  const countWord = (n: number): string =>
    ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ??
    String(n);

  const parts = rows.map((row, ri) => {
    // 段内のコマは読み順（右→左）に見る
    const ordered = [...row].sort((a, b) => b.x - a.x);
    // 段内で面積がほぼ同じなら1グループにまとめて「N panels」と言う。
    const describeSize = (w: number, h: number): string => {
      const area = w * h;
      const size = area >= avgArea * 1.5 ? "large" : area <= avgArea * 0.6 ? "small" : "medium";
      // 実アスペクト比（pageAspect 込み）で横長/縦長を足す
      const ratio = (w * template.pageAspect.w) / (h * template.pageAspect.h);
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

  return parts.join("; ");
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
  /** このページの cast（名前一致解決済みのみ）。指定時は「このページに出るのはこの面々だけ」句を足す。 */
  castNames?: string[];
};

/**
 * ページ丸ごと1枚を生成するプロンプトを組む（主経路）。
 *
 * template=null のときは AI にコマ割りを最適化させる（layoutHint があれば方向を渡す）。
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

  // 1. ベース句（mono/color は既存文字列・無変更。faithful だけ新規）
  parts.push(
    colorMode === "faithful"
      ? "one complete manga page composed of comic panels, rendered in the exact art style of the reference images"
      : colorMode === "color"
        ? "one complete manga page, full color manga illustration, clean ink line art, anime-style cel shading, vibrant colors"
        : "one complete manga page, black and white manga illustration, professional ink line art, screentone shading",
  );

  // 2. レイアウト句
  if (template) {
    const layout = describePageLayout(template);
    parts.push(
      `${template.panelCount} panels, Japanese right-to-left reading order.${layout ? ` ${layout}` : ""}`,
    );
  } else {
    const hint = context.layoutHint?.trim();
    parts.push(
      `${panels.length} panels, Japanese right-to-left reading order. design the panel layout yourself for maximum readability and dramatic impact: vary panel sizes and shapes, give the key moment the largest panel, keep the gutters clean${hint ? `. layout direction: ${hint}` : ""}`,
    );
  }

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
  for (const panel of panels) {
    const body = panel.prompt.trim() || panel.composition.trim();
    const lines = panel.balloons
      .filter((b) => b.visible && b.text.trim().length > 0)
      .map((b) => `「${b.text.trim()}」`);
    const balloonPart =
      lines.length > 0
        ? ` speech balloon${lines.length > 1 ? "s" : ""}: ${lines.join(" ")}`
        : "";
    const sfxLines = panel.sfx
      .filter((s) => s.visible && s.text.trim().length > 0)
      .map((s) => `「${s.text.trim()}」`);
    const sfxPart =
      sfxLines.length > 0
        ? ` sound effect${sfxLines.length > 1 ? "s" : ""}: ${sfxLines.join(" ")}`
        : "";
    parts.push(`panel ${panel.index}: ${body}.${balloonPart}${sfxPart}`);
  }

  // 5. 参照画像がある時だけ同一性・ポーズ写し防止・画風句（mono/color は既存文字列・無変更）
  //
  // faithful は狙いが逆（参照の画風をそのまま保つ）ので、画風を漫画へ変換させる
  // STYLE_DOMINANCE の代わりに REFERENCE_FAITHFUL_CLAUSE を入れる。
  // 同一性（IDENTITY）も faithful では専用句を使う。mono/color 用の
  // REFERENCE_IDENTITY_CLAUSE は「漫画キャラとして描き直せ（never photorealistic）」を
  // 含み、faithful の「元の画風を保て（do not convert）」と矛盾するため。
  // ポーズ非写し（POSE）は faithful でも要るので共通。
  if (hasReferences) {
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_IDENTITY_CLAUSE
        : REFERENCE_IDENTITY_CLAUSE,
    );
    parts.push(REFERENCE_POSE_CLAUSE);
    parts.push(
      colorMode === "faithful"
        ? REFERENCE_FAITHFUL_CLAUSE
        : REFERENCE_STYLE_DOMINANCE_CLAUSE,
    );
  }

  // 6. 仕上げ句（文字を発明・改変させない指示を追加した確定文字列）
  parts.push(
    "hand-drawn speech balloons with vertical Japanese text — write the dialogue exactly as given, character for character, do not invent or alter any text; bold hand-lettered manga sound effects integrated with the art; clean black panel borders and white gutters",
  );

  // 6b. 最終出力の画風を末尾で念押しする。
  // mono/color は参照画像のフォト/3D調に勝たせる（実機FB 2026-07-28 STΛCK）。
  // faithful は逆に「参照の画風を忠実に再現した」ことを念押しする専用句を使う。
  parts.push(
    colorMode === "faithful" ? FAITHFUL_FINAL_CLAUSE : finalStyleClause(colorMode),
  );

  // 6c. ページの形・大きさを全ページで揃える（生成サイズのバラつき対策）。
  parts.push(PAGE_SIZE_CLAUSE);

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
 * 1コマの画像生成プロンプトを組む。
 * コマの prompt（人が編集済み）に、登場キャラの属性テキストを合成する。
 * 参照画像は既存の refImagePaths 経路で別途渡すので、ここでは属性テキストのみ足す。
 *
 * `colorMode` は先頭のベース句だけを切り替える（既定 "mono" = 従来どおり）。
 *
 * `hasReferences` は「このコマに参照画像が1枚以上渡るか」。実写写真を参照に
 * 渡すと写真調のまま出てしまうため、参照があるときだけ画風変換句
 * （同一性維持・ポーズ非写し・参照の描画スタイル無視）を足して
 * 「同一人物のまま手描き漫画に描き直す」を明示する (2026-07-28 STΛCK 実機FB)。
 * さらに末尾で最終出力の画風を念押しする（参照のフォト/3D調に勝たせる）。
 *
 * `colorMode` は mono/color だけを受ける。画風「キャラ忠実」(faithful) は
 * ページ丸ごと生成（buildFullPagePrompt）専用で、コマ単位のこの関数は対応しない
 * （唯一の呼び出し元だった詳細編集・コマ別経路は 2026-07-28 に撤去済み）。
 */
export function buildPanelImagePrompt(
  panel: ComicPanel,
  characters: ComicCharacter[],
  colorMode: Exclude<ComicColorMode, "faithful"> = "mono",
  hasReferences = false,
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

  const parts = [
    colorMode === "color"
      ? "manga panel, full color manga illustration, clean ink line art, anime-style cel shading, vibrant colors"
      : "manga panel, black and white manga illustration, professional ink line art, screentone shading",
  ];
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

  // 一気生成はコマ経路を通るため、ページ経路と同じ形・大きさへ揃える句を足す
  // （生成サイズのバラつき対策。aspect も同じ COMIC_PAGE_ASPECT を渡している）。
  parts.push(PAGE_SIZE_CLAUSE);

  return parts.filter(Boolean).join(", ");
}
