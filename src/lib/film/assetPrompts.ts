import type { AssetLedgerEntry, FilmProject } from "./types";

/**
 * run-ai-film 正典の5ビュー雛形。固定文を要約せず、そのままAIへ渡す。
 * 【】の作品固有部分だけを脚本・台帳から埋める。
 */
export const CHARACTER_IDENTITY_SHEET_TEMPLATE = String.raw`【氏名 / ROMAJI CHARACTER IDENTITY SHEET】
モデル: GPT Image 2 / アスペクト比: 16:9 / 品質: high / 参照画像なし（新規キャスティング）

**【この画像で最も重要な指定 — 先に読むこと】**
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

/** run-ai-film 正典の「雛形③」。GEOも同じ全文の中で起草させる。 */
export const LOCATION_SCENE_SHEET_TEMPLATE = String.raw`同一の空間を4つのアングルで写した4分割のロケーションシート（2×2グリッド）。
左上：空間全体が入る引き。右上：入口側から奥を見た視点。
左下：奥から入口側への振り返り。右下：物語上重要な一角の寄り【例: 机まわり／カウンター】。
4枚とも完全に同一の空間で、壁・窓・家具・光源の位置がパネル間で矛盾しないこと。光源は1つ、影の方向は全パネルで同じ。
【空間のGEO：間口の広さ・主要家具の配置（どの壁に何があるか）・光の入り方をここに書く】
人物は入れない。画面内に文字を入れない。誇張のないドキュメンタリー調。`;

export const TEXT_ASSET_PROMPT_TEMPLATE = String.raw`【文字物の名称】を、映画制作で繰り返し参照できる正典画像として生成する。
画面に書く文字は次の文言だけ。一字一句、句読点・改行・大小・字間を含めて指定どおりに書く。

【ここに脚本上の正確な全文を記載】

これ以外の文字は書かない。説明文、ロゴ、透かし、擬似文字、余分な記号を追加しない。
手書きの筆致や紙質を合わせる実物写真がある場合は参照添付し、「筆致と紙質だけを参照。文言は参照しない」と扱う。
正面から判読でき、文字が物や背景で隠れず、作品内で使う素材そのものとして確認できる1枚。`;

export const PROP_ASSET_PROMPT_TEMPLATE = String.raw`【小道具の名称】を、映画制作で繰り返し参照できる正典画像として生成する。
脚本と台帳にある形、材質、寸法感、使い込み、傷、色、物語上重要な特徴を具体的に固定する。
正面・側面・重要部分が分かり、別の物へ勝手にデザイン変更されない資料写真にする。
人物、余分な小道具、ロゴ、判読可能な文字、装飾的な背景を追加しない。
硬貨・記章・特殊な瓶など正確さが必要な実在物は、生成前に実物写真を参照添付する。参照画像の何を形の正典にするかも明記する。`;

function scriptContext(project: FilmProject): string {
  if (Array.isArray(project.script)) return "脚本は未構造化です。台帳情報だけで起草してください。";
  const script = project.script;
  return [
    `ログライン: ${script.logline}`,
    `トリートメント:
${script.treatment}`,
    `シーンリスト:
${script.scenelistText ?? script.scenes.map((scene) => `${scene.id} ${scene.location} ${scene.purpose}`).join("\n")}`,
    `ブロック脚本:
${script.blockScriptText ?? script.blocks.map((block) => `${block.id} 画=${block.visual} 芝居=${block.performance} セリフ=${block.dialogue}`).join("\n")}`,
  ].join("\n\n");
}

function ledgerContext(assets: AssetLedgerEntry[]): string {
  return assets
    .map((asset) => `${asset.id} | ${asset.name} | ${asset.type} | ${asset.importance} | ${asset.blockIds.join(", ")}${asset.pairKey ? ` | ペア=${asset.pairKey}${asset.pairSide ?? ""}` : ""}`)
    .join("\n");
}

function templateFor(asset: AssetLedgerEntry): string {
  switch (asset.type) {
    case "character":
      return CHARACTER_IDENTITY_SHEET_TEMPLATE;
    case "location":
      return LOCATION_SCENE_SHEET_TEMPLATE;
    case "text":
      return TEXT_ASSET_PROMPT_TEMPLATE;
    case "prop":
      return PROP_ASSET_PROMPT_TEMPLATE;
  }
}

export function buildAssetPromptDraftPrompt(
  project: FilmProject,
  asset: AssetLedgerEntry,
): string {
  const typeInstruction = asset.type === "character"
    ? `下記のCHARACTER IDENTITY SHEET雛形の固定文を一文も削らず、要約せず、順番も変えないでください。
作品固有の【氏名】【年齢】【国籍】【性別】【顔・髪・身体・衣装・声・役割・個体特徴】だけを脚本と台帳から具体化してください。
見出しとして必要な【この画像で最も重要な指定 — 先に読むこと】【AIが作った顔にしない — 最重要】等はそのまま残してください。
冒頭の2体の扱い差、首なしの物理記述、AI顔否定ブロック、1人1枚、末尾「16:9 aspect ratio, high quality」は絶対に変更・移動・削除しないでください。`
    : asset.type === "location"
      ? `下記の2×2シーンシート雛形の固定文を一文も削らず、要約せず、順番も変えないでください。
【空間のGEO】を、人物やアクションを入れず、間口・壁・窓・入口・アンカーになる家具・単一光源・影の方向まで具体的に埋めてください。
斜め3/4で空間が読める構図を優先してください。`
      : asset.type === "text"
        ? `脚本に実際に登場する文字列を特定し、一字一句そのまま全文へ入れてください。
不明な字を創作せず、判断できない箇所は「要確認: 文言未確定」と明記してください。
固定文「これ以外の文字は書かない」は必ず残してください。`
        : `脚本上の特徴を具体化してください。正確さが必要な実在物なら、実物写真を参照添付する注記を必ず残してください。`;

  return `あなたは映画制作のアセット設計担当です。まだ画像は1枚も生成しません。
次の1アセットについて、画像生成へそのまま渡せるプロンプト全文だけを書いてください。前置き・解説・Markdownコードフェンスは禁止です。

作品: ${project.title}
一番伝えたいこと: ${project.theme}
対象: ${asset.id} / ${asset.name}
種別: ${asset.type}
重要度: ${asset.importance}
登場ブロック: ${asset.blockIds.join(", ")}

【この種別の絶対規則】
${typeInstruction}

【脚本】
${scriptContext(project)}

【全アセット台帳】
${ledgerContext(project.assets)}

【使用する正典雛形】
${templateFor(asset)}

出力は完成したプロンプト全文だけ。雛形を短くしないでください。`;
}

export function cleanAssetPromptDraftResponse(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/u);
  return (fenced?.[1] ?? trimmed).trim();
}

export function buildStressTestImagePrompt(
  asset: AssetLedgerEntry,
  condition: string,
  otherCharacterNames: string[],
): string {
  const others = otherCharacterNames.filter(Boolean).join("、") || "脚本に登場する別人物1人";
  const together = condition === "他の人物と同フレーム"
    ? `同じフレームに ${others} を1人だけ入れる。顔・髪・衣装・身体特徴を互いに交換しない。`
    : "追加人物を入れない。";
  return `採用済みのIDENTITY SHEETを唯一の人物参照として、同じ1人を次の壊れやすい条件で写す。
条件: ${condition}
${together}

【人物ディスクリプタ】
${asset.promptDraft ?? ""}

顔の骨格、目の間隔、鼻、唇、顎、耳、髪、生え際、年齢、体格、衣装、最重要ディテールを参照画像と完全に一致させる。
美化、若返り、左右反転による特徴交換、衣装変更、別人化をしない。1枚に1条件だけ。映画の実写テストフレーム。
16:9 aspect ratio, high quality`;
}
