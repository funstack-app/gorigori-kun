import type { FilmBlock, FilmScript } from "./types";

function blockSource(script: FilmScript): string {
  if (script.blockScriptText?.trim()) return script.blockScriptText.trim();
  return script.blocks
    .map(
      (block) =>
        `${block.id}\n画: ${block.visual}\n芝居: ${block.performance}\nセリフ: ${block.dialogue}\n音: ${block.sound}`,
    )
    .join("\n\n");
}

export function buildAssetLedgerPrompt(input: { script: FilmScript }): string {
  const blockIds = input.script.blocks.map((block) => block.id).join("、");
  return `あなたは映像制作の設計担当です。承認済みの全ブロックから、映像プロンプトに登場する名詞をすべて抽出し、アセット台帳にしてください。

絶対条件:
- プロンプトに出る人物・場所・文字が書かれた物・小道具を漏らさない
- 同じものは1行にまとめ、登場するB番号をすべて並べる
- 種別は「キャラ」「ロケ」「文字物」「小道具」のどれか
- IDは種別ごとに CH-01 / LO-01 / TX-01 / PR-01 から連番
- 重要度は「主要」「準」「背景」のどれか
- 使えるB番号: ${blockIds || "なし"}
- 説明、自己採点、コードフェンスを付けない

次のMarkdown表だけを返してください。
| ID | 名称 | 種別 | 重要度 | 登場ブロック |
|---|---|---|---|---|
| CH-01 | 名称 | キャラ | 主要 | B1, B2 |

承認済みブロック脚本:
${blockSource(input.script)}`;
}

export function buildLookProposalPrompt(input: {
  title: string;
  theme: string;
  treatment: string;
}): string {
  return `あなたは映像のルックデベロップ担当です。同じ脚本を2つの異なる方向から比較できる、参照画像1枚用のルック提案を2案書いてください。

タイトル: ${input.title}
一番伝えたいこと: ${input.theme}
トリートメント:
${input.treatment}

条件:
- 各案は撮影方式・光の質・レンズ感・質感・時代感を1文で設計する
- 色調名、色指定、カラーコードは書かない。色は仕上げで一括調整する
- 画像内に文字やロゴを出さない
- 説明や自己採点を付けない
- 書式を守る: 「案A: ...」「案B: ...」を各1行`;
}

export function parseLookProposals(raw: string): [string, string] | null {
  const proposals = new Map<string, string>();
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^\s*案\s*([AB])\s*[:：]\s*(.+?)\s*$/iu);
    if (match) proposals.set(match[1].toUpperCase(), match[2].trim());
  }
  const a = proposals.get("A");
  const b = proposals.get("B");
  return a && b ? [a, b] : null;
}

export function buildLookImagePrompt(input: {
  title: string;
  theme: string;
  proposal: string;
}): string {
  return `映画「${input.title}」のルックマスター候補となる、16:9の参照フレーム1枚。
主題: ${input.theme}
ルック設計: ${input.proposal}
参照用の単一フレームとし、分割画面、コラージュ、比較表示、文字、ロゴ、透かしを入れない。色調名やカラーコードで色を追い込まない。`;
}

export function buildStylePrefixPrompt(input: {
  theme: string;
  treatment: string;
  lookMasterPath: string;
  lookDescription?: string;
}): string {
  return `あなたは映像生成プロンプトの設計担当です。すべての動画プロンプトの末尾に、毎回そのまま付ける固定文（Style Prefix）を1つ起草してください。

一番伝えたいこと: ${input.theme}
トリートメント:
${input.treatment}
決定ルックの参照画像: ${input.lookMasterPath}
決定ルックの設計文: ${input.lookDescription?.trim() || "ユーザーが選んだ参照画像を正本とする"}

条件:
- カメラの距離感、レンズ感、光の質、質感、現実感、人物と空間の一貫性を固定する
- 色調名、色指定、カラーコードは絶対に入れない。色は仕上げで一括調整する
- 文字やロゴの生成を指示しない
- 120〜220文字の1段落にする
- 見出し、説明、引用符、自己採点を付けず、固定文だけを返す`;
}

export function compactBlockSummary(blocks: FilmBlock[]): string {
  return blocks.map((block) => `${block.id}: ${block.visual}`).join("\n");
}
