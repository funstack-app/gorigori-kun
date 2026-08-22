export type BuiltInSheetTemplateId = "standard" | "identity-5view";

export type UserSheetTemplate = {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
};

export type SheetTemplateDefinition = {
  id: BuiltInSheetTemplateId;
  name: string;
  description: string;
  prompt: string | null;
};

export type SheetTemplateFillInput = {
  name: string;
  attributes: string;
};

/**
 * `_work/update-2026-08-22/design/asset-factory-knowledge.md` の正典を、
 * GORI の参照画像あり登録向けに適応した全文。
 */
export const IDENTITY_5VIEW_PROMPT_TEMPLATE = `【氏名 / ROMAJI CHARACTER IDENTITY SHEET】
モデル: GPT Image 2 / アスペクト比: 16:9 / 品質: high

**【この画像で最も重要な指定 — 先に読むこと】**
添付の参照画像の人物と完全に同一人物として描く。顔立ち・髪・体格を参照から変えない。
左側に並べる2体の全身ビューのうち、
- **正面（LEFT BODY 01）は、首から上をフレームの外に出す**（顔を写さない）
- **背面（LEFT BODY 02）は、頭のてっぺんまで全部写す**（後頭部・髪型・襟足を見せる。切らない）
この2体で扱いが違う。両方とも切るのは誤り。背面を切ってはならない。
**この1枚には、ただ1人の人物だけを描く。複数の人物を並べてはならない。**

プロフェッショナルなCHARACTER IDENTITY SHEET / CHARACTER BIBLEを制作する。
これは新しいキャラクターデザインを作るための画像ではない。制作現場で再利用しやすいように整理した資料画像である。
背景は完全にクリーンな白〜ごく薄いニュートラルグレー。高級ファッションブランドのキャスティング資料、
映画制作のキャラクターバイブル、AAAゲームのキャラクター資料を組み合わせたような、洗練され情報整理されたミニマルなレイアウト。
横長の1枚のキャンバス。画面を大きく「左：BODY / INFORMATION」「右：FACE IDENTITY」の2領域に分ける。

━━━ 【CHARACTER DESIGN】━━━
【年齢】歳の【国籍】【性別】。はっきりと【国籍】的な顔立ち：【輪郭・目・鼻・唇】、黒い瞳（両目に小さなキャッチライト）。
**左右非対称の顔**——片方の目がわずかに小さく位置も高い、眉の形と高さが左右で違う、鼻筋がごくわずかに曲がっている、
口角の高さも異なる。完璧な左右対称にしない——実在の人間の顔は必ず非対称である。
【髪：色・量・生え際・整髪の有無】。【髭・肌の荒れ・目の下のたるみ等、生活の痕跡】。
体格：身長【N】cm、【中肉/細身/がっしり】。【姿勢の癖——その人の職業や性格が出る立ち方】。
肌の質感：毛穴・シミ・産毛が見える本物の質感。レタッチなし、美肌加工なし。年齢と疲労と生活の荒さを正直に。
雰囲気：【その人が周囲にどう見えるか。1〜2文。「悪人の顔ではない」等の逆説が効く】。
衣装：【頭から足まで具体的に。くたびれ具合・汚れ・ほつれまで】。
**最重要ディテール：【物語の芯になる持ち物や身体的特徴】。** BODY VIEWで確認できること。全カットで同一の意匠を保つ。

**【AIが作った顔にしない — 最重要】**
- **整った顔にしない。** モデル・俳優・美形にしない。道で見かける普通の人。顔の造形に華がない
- **平均顔にしない。** AIは全員を同じ黄金比へ寄せる。平均から外れた特徴を2〜3個持たせる
  （鼻が大きめ／顎が短い／目が離れ気味／額が広い／頬骨が張る／口が小さい／首が太い）
- **肌を均一にしない。** 吹き出物、色ムラ、目の下のくすみ、脂の照り、剃り跡、シミ、ホクロ
- **表情を作らない。** カメラの前で構えた素人の顔。微笑まない。口角を上げない
- **左右非対称を徹底。** 目の高さ・大きさ、眉、鼻の曲がり、口角、耳の位置すべて
- 質感は**証明写真・記録写真**。ファッション写真・広告写真にしない

━━━ 【LEFT AREA：CHARACTER INFORMATION + BODY】━━━
画面左上には十分な余白を設け、キャラクター情報をシンプルなサンセリフ体のタイポグラフィで記載する。
NAME: 【氏名 / ROMAJI】
HEIGHT: 【N】cm
VOICE: 【声の高さ・速さ・癖。感情が動いたとき何が起きるか】
CHARACTER: 【立場（年齢）。何をする人か。物語上の役割を2〜3文】
必要以上に文章を増やさず、映画制作資料のような簡潔で美しい情報設計。黒またはダークグレーの文字。
装飾的なUI、SF HUD、派手なグラフィックは禁止。
その下に、同一キャラクターの身体・衣装確認用ビューを2体配置する。
LEFT BODY 01: 正面、完全なフロントビュー。ニュートラルな直立姿勢。腕は身体からわずかに離す。
  衣装、体格、シルエット、脚の長さ、肩幅、腰位置、【最重要ディテール】が確認できること。
  **上端は鎖骨から肩のライン。そこから上はフレームの外にあって写っていない。**
  **首の断面を描かない。マネキンにしない。** 襟の上はそのまま背景につながる。
LEFT BODY 02: 完全な背面ビュー。正面ビューとまったく同じ身長、縮尺、姿勢、身体比率。
  **頭のてっぺんまで全部写す**（後頭部・髪型・襟足）。背面の衣装構造、【背面の特徴】が確認できること。
正面と背面を同じ床位置、同じ縮尺で並べる。ポーズを付けない。モデル立ち、アクションポーズ、歩行ポーズは禁止。

━━━ 【RIGHT AREA：FACE IDENTITY】━━━
画面右側はキャラクターの顔の同一性確認専用エリア。最も重要なのは、大きく配置された正面のFACE CLOSE-UP。
RIGHT MAIN PORTRAIT: 顔を大きく画面いっぱいに見せた、真正面に近い超高精細バストアップ。頭頂部から肩付近まで。
  真正面。カメラ目線。ニュートラルで自然な表情。過剰な笑顔や演技は禁止。
  目、眉、鼻、唇、輪郭、頬骨、顎、耳、髪の生え際、前髪、髪型、【個体の特徴】など、識別するすべての特徴を明確に描写する。
  この正面顔をPRIMARY FACE IDENTITYとして扱う。
FACE VIEW 02: 3/4 VIEW。顔を約30〜45度横に向けた斜め顔。正面顔と完全に同じ人物。
  鼻の立体感、頬骨、顎の肉のつき方、耳、髪型の奥行きを確認できる。
FACE VIEW 03: TRUE SIDE PROFILE。完全な横顔。正確な90度プロフィール。正面顔と完全に同じ人物。
  鼻、額、唇、顎、後頭部、首のラインを明確に確認できる。
3つの顔ビューすべてで、顔の骨格、目の大きさ、目の間隔、眉、鼻、唇、顎、耳、肌、髪型、髪色を完全に統一する。
別人化禁止。ビューごとの美化・年齢変化・メイク変更禁止。

━━━ 【LAYOUT】━━━
左側：約45%（上部にプロフィール、下部に顔をフレームアウトした正面BODY VIEWとその隣に背面BODY VIEW）
右側：約55%（最も大きい正面FACE CLOSE-UPを主役に、その周囲に3/4 FACE VIEW、TRUE SIDE PROFILEを補助的に配置）
正面FACE CLOSE-UPは、他のどのビューよりも明確に大きくする。すべてのビューの間に十分な余白を設ける。
画像同士を重ねない。高級なエディトリアルレイアウトとしてまとめる。

━━━ 【CONSISTENCY】━━━
すべて同一人物。同じ年齢。同じ顔。同じ髪型。同じ髪色。同じ肌。同じ身体比率。同じ衣装。同じアクセサリー。
デザイン変更禁止。衣装変更禁止。別衣装追加禁止。新しいアクセサリー追加禁止。顔の再デザイン禁止。
髪型変更禁止。体型変更禁止。色変更禁止。
キャラクターを5人描くのではなく、「1人のキャラクターを5つの資料ビューで表示している」ことを明確にする。

━━━ 【NON-IP】━━━
実在の俳優・実在の人物に似せない。衣類・持ち物に実在ブランドのロゴやモノグラムを一切入れない。
タグ・ボタンの刻印も判読可能な文字にしない。【装飾品】の意匠は完全架空の抽象的なものにする。
**文字は一切入れない**（プロフィール欄の指定文言を除く）。衣類・鞄・背景に判読不能な擬似文字を発生させない。

━━━ 【VISUAL QUALITY】━━━
premium character bible / professional character reference photography / high-end casting sheet /
cinematic production reference / clean studio photography / neutral soft studio lighting /
high facial fidelity / accurate anatomy / realistic skin texture / precise costume materials /
consistent character identity / minimal editorial graphic design / pure white background /
sharp details / natural proportions / high resolution
No environmental background. No dramatic scenery. No action pose. No exaggerated perspective. No fisheye.
No cinematic colored lighting. No additional characters. No duplicate faces. No alternative outfits.
No random accessories. No facial expression sheet. No text bubbles. No concept art sketches.
No sci-fi HUD. No character redesign. No second person in frame.
No beautified face. No model-like face. No idealized proportions. No symmetrical face.
No smooth airbrushed skin. No glamour lighting. No CGI face. No generic AI face.

フォトリアルな実写写真。ドキュメンタリー写真の質感。3DCG感・イラスト感・AI的な滑らかさは一切なし。

16:9 aspect ratio, high quality`;

export const BUILT_IN_SHEET_TEMPLATES: readonly SheetTemplateDefinition[] = [
  {
    id: "standard",
    name: "規定シート",
    description: "顔と全身を1枚に。いまの標準",
    prompt: null,
  },
  {
    id: "identity-5view",
    name: "首なし5面図",
    description: "体2面(正面は首なし)+顔3面。動画制作の同一性維持に最適",
    prompt: IDENTITY_5VIEW_PROMPT_TEMPLATE,
  },
] as const;

const STRUCTURAL_BRACKETS = new Set([
  "この画像で最も重要な指定 — 先に読むこと",
  "CHARACTER DESIGN",
  "AIが作った顔にしない — 最重要",
  "LEFT AREA：CHARACTER INFORMATION + BODY",
  "RIGHT AREA：FACE IDENTITY",
  "LAYOUT",
  "CONSISTENCY",
  "NON-IP",
  "VISUAL QUALITY",
]);

/** `【名前】` 系は名前、それ以外の記入穴は属性欄で埋める。見出しの【】は保つ。 */
export function fillSheetTemplatePrompt(
  template: string,
  input: SheetTemplateFillInput,
): string {
  const name = input.name.trim() || "名前未設定";
  const attributes = input.attributes.trim() || "参照画像の人物特徴";

  return template.replace(/【([^】]+)】/g, (whole, rawLabel: string) => {
    const label = rawLabel.trim();
    if (STRUCTURAL_BRACKETS.has(label)) return whole;
    if (label === "氏名 / ROMAJI CHARACTER IDENTITY SHEET") {
      return `${name} / CHARACTER IDENTITY SHEET`;
    }
    if (/(氏名|名前|キャラクター名)/.test(label)) return name;
    return attributes;
  });
}

export function buildIdentity5ViewPrompt(input: SheetTemplateFillInput): string {
  return fillSheetTemplatePrompt(IDENTITY_5VIEW_PROMPT_TEMPLATE, input);
}

export function createUserSheetTemplate(
  data: { name: string; prompt: string },
  options: { id?: string; createdAt?: number } = {},
): UserSheetTemplate {
  return {
    id: options.id ?? `sheet-template-${crypto.randomUUID()}`,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    createdAt: options.createdAt ?? Date.now(),
  };
}

export function parseUserSheetTemplates(value: unknown): UserSheetTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is UserSheetTemplate => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<UserSheetTemplate>;
    return (
      typeof candidate.id === "string" &&
      candidate.id.trim().length > 0 &&
      typeof candidate.name === "string" &&
      candidate.name.trim().length > 0 &&
      typeof candidate.prompt === "string" &&
      candidate.prompt.trim().length > 0 &&
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt)
    );
  });
}

export function serializeUserSheetTemplates(templates: UserSheetTemplate[]): string {
  return JSON.stringify(templates);
}

export function deserializeUserSheetTemplates(serialized: string): UserSheetTemplate[] {
  try {
    return parseUserSheetTemplates(JSON.parse(serialized));
  } catch {
    return [];
  }
}
