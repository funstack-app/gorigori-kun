import { findVideoServiceProfile, VIDEO_SERVICE_PROFILES } from "./serviceProfiles";
import { allocateScriptBeats } from "./scriptPrompts";
import type { FilmChatMessage, FilmProject, FilmScript } from "./types";

export type FilmAdvisorStage =
  | "premise"
  | "logline"
  | "beatsheet"
  | "treatment"
  | "scenelist"
  | "blocks"
  | "design";

const RECENT_MESSAGE_LIMIT = 8;
const SUMMARY_TEXT_LIMIT = 900;

/** STΛCK直指示の正本。言い換えず、そのまま毎回のプロンプトへ入れる。 */
export const FILM_ADVISOR_MANNERS = `- 常に日本語。ユーザーに見せる文では日常語を主にする。専門用語が必要な時は、必ず日常語を先に書いて短い言い換えを添える
- 呼び方は「一文のあらすじ」「物語の流れ（起きることの順番）」「最初から最後までの物語」「場面の一覧」「動画1回分ずつの台本」「素材（登場人物・場所・小物）」「生成の指示文」「お手本画像」「映像の見た目」「決定版」「確定（変更しない印）」「同一人物チェック（5つの条件で崩れないか確認）」「空間の設計図」「人物シート（5方向の姿）」を使う
- 専門用語をそのまま見出しや質問に使わない。内部の書式名が必要な時も、ユーザー向けの説明は上の日常語で書く
- 質問は一度に最大2つ。選択肢には「おすすめ」と理由を1行添える
- 専門知識がないと選べない聞き方をしない（「アスペクト比は？」ではなく「どこに投稿しますか？ YouTube横長 / スマホ縦長」）
- 話の種の聞き出しは3問まで: 「誰の、どんな話にしたいですか？断片で大丈夫です」「一番伝えたいことは？一言で」「見終わった人にどんな気持ちが残ってほしいですか？」
  種が無ければAIが3案を一行ずつ出して選んでもらう
- 提案の理由は感覚の言葉で（❌構造上ここがMidpoint → ⭕ここで一度どん底に落とすと最後の笑顔が効く）
- NGの返事はハードルを下げる（「一言で大丈夫です（例: もっと切なく）」）
- 迷いを感じたら、次の一歩をAIが具体的に提案して引っ張る`;

function scriptOf(project: FilmProject): FilmScript | null {
  return Array.isArray(project.script) ? null : project.script;
}

function compact(text: string, limit = SUMMARY_TEXT_LIMIT): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

export function getFilmAdvisorStage(project: FilmProject | null): FilmAdvisorStage {
  if (!project) return "premise";
  if (!project.approvals.logline) return "logline";
  if (!project.approvals.beatsheet) return "beatsheet";
  if (!project.approvals.treatment) return "treatment";
  if (!project.approvals.scenelist) return "scenelist";
  if (!project.approvals.blocks) return "blocks";
  return "design";
}

function approvedSummary(project: FilmProject | null): string {
  if (!project) return "まだプロジェクトは作成されていません。";
  const script = scriptOf(project);
  const lines = [
    `タイトル: ${project.title}`,
    `一番伝えたいこと: ${project.theme}`,
    `投稿先: ${project.postingTarget?.trim() || "未確定"}`,
    `動画サービス: ${findVideoServiceProfile(project.videoServiceId)?.label ?? project.videoServiceId}`,
  ];
  if (script) {
    lines.push(`目標の長さ: ${script.targetDurationSeconds ?? 90}秒`);
    lines.push(`登場人物: ${(script.characterNames ?? []).join("、") || "なし"}`);
    lines.push(`題材メモ: ${script.topicMemo?.trim() || "なし"}`);
    if (project.approvals.logline) lines.push(`OK済みの一文のあらすじ: ${compact(script.logline)}`);
    if (project.approvals.beatsheet) lines.push(`OK済みの物語の流れ: ${compact(script.beatsheet)}`);
    if (project.approvals.treatment) lines.push(`OK済みの最初から最後までの物語: ${compact(script.treatment)}`);
    if (project.approvals.scenelist) {
      lines.push(`OK済みの場面の一覧: ${script.scenes.length}場面 / ${compact(script.scenelistText ?? "")}`);
    }
    if (project.approvals.blocks) {
      lines.push(`OK済みの動画1回分ずつの台本: ${script.blocks.length}本分 / ${compact(script.blockScriptText ?? "")}`);
    }
  }
  return lines.join("\n");
}

function recentConversation(messages: FilmChatMessage[]): string {
  return messages
    .slice(-RECENT_MESSAGE_LIMIT)
    .map((message) => `${message.role === "user" ? "ユーザー" : "AIアドバイザー"}: ${message.text}`)
    .join("\n\n") || "（まだ会話はありません）";
}

function stageInstruction(stage: FilmAdvisorStage, project: FilmProject | null): string {
  if (stage === "premise") {
    const services = VIDEO_SERVICE_PROFILES.map(
      (profile) => `- ${profile.id}: ${profile.label} / ${profile.blurb}${profile.measured ? "" : " / まだ実際に試せていない"}`,
    ).join("\n");
    return `企画を会話で確定する工程です。タイトル、伝えたいこと、目標の長さ、登場人物、題材、投稿先、動画サービスを、初心者が答えられる順に聞いてください。
話の種に必要な3問を超えて尋問しないでください。足りない値は具体案を出して選んでもらってください。
動画サービスのおすすめは Seedance 2.5 です。理由は「実際に試した記録が最も多く、最初の一本で迷いにくいから」と伝えてください。
利用可能な動画サービス:
${services}

すべて確定した返事だけ、地の文の後ろに次の成果物を1個付けます。値が未定でも「なし」と確定できる項目は「なし」と書きます。
\`\`\`artifact:premise
タイトル: 作品タイトル
伝えたいこと: 一番伝えたいこと
目標の長さ: 90秒
登場人物: 名前を読点区切り。いなければなし
題材: 題材メモ。なければなし
投稿先: YouTube横長 / スマホ縦長 など
動画サービス: seedance-2.5
\`\`\``;
  }

  const script = project ? scriptOf(project) : null;
  if (stage === "logline") {
    return `一文のあらすじを決めます。方向がまだ選ばれていない時は、説明文で異なる3案を一行ずつ出し、おすすめと感覚的な理由を添えて選んでもらってください。方向が決まった時だけ、完成した一文を \`\`\`artifact:logline の中に入れてください。`;
  }
  if (stage === "beatsheet") {
    const target = script?.targetDurationSeconds ?? 90;
    const allocation = allocateScriptBeats(target)
      .map((beat, index) => `${index + 1}. ${beat.nameJa}: ${beat.durationSeconds}秒`)
      .join("\n");
    return `物語の流れ（起きることの順番）を作ります。次の区切り名と秒数を変えず、各行へ起きることを足してください。合計は${target}秒です。
${allocation}
完成案だけを \`\`\`artifact:beatsheet に入れてください。`;
  }
  if (stage === "treatment") {
    return `最初から最後までの物語を作ります。映像が浮かぶ順番で書き、登場人物名を変えません。伏線はF1、F2のように最初に出す場所と意味を明かす場所を同じ番号で示します。完成案だけを \`\`\`artifact:treatment に入れてください。`;
  }
  if (stage === "scenelist") {
    return `場面の一覧を作ります。できあがった内容は次の表だけにします。場面番号はS1から順番に付け、合計の長さは目標の±10%以内です。
| S番号 | 場所 | 目的（1行） | 登場人物 | 推定秒数 |
|---|---|---|---|---|
| S1 | 場所 | 目的 | 人物名、人物名 | 10秒 |
完成表を \`\`\`artifact:scenelist に入れてください。`;
  }
  if (stage === "blocks") {
    const service = project ? findVideoServiceProfile(project.videoServiceId) : undefined;
    const maxSeconds = service?.maxBlockSeconds ?? 15;
    return `動画1回分ずつの台本を作ります。1回分は${maxSeconds}秒以下、動画番号はすべての場面を通してB1から順番に付けます。次の書き方を守ります。
## S{n} {場所} / {秒}s
### B{通し番号} ({秒数}s) {一行要約}
- 画: 画面に見えるもの
- 芝居: 人物の動き。終わりの余白: 2秒
- セリフ: なければ「なし」
- 音: 環境音・効果音・音楽
- 伏線: F番号 植込/回収。なければ「なし」
完成稿を \`\`\`artifact:blocks に入れてください。`;
  }
  return `物語づくりの5工程はOKになりました。「次は③設計です。映像の見た目を決めましょう。お手本画像が1枚あると速いです」と短く案内してください。できあがった内容の囲みは付けません。`;
}

export function buildFilmAdvisorPrompt(input: {
  project: FilmProject | null;
  messages: FilmChatMessage[];
  userMessage: string;
  referenceImageCount?: number;
}): string {
  const stage = getFilmAdvisorStage(input.project);
  const referenceImageNotice = (input.referenceImageCount ?? 0) > 0
    ? `${input.referenceImageCount}枚がアプリ内に保存されています。ただし、この文字専用の会話経路には画像の内容が渡っていません。画像を見た、確認した、読み取ったとは絶対に書かないでください。画像は③設計でユーザーがお手本に選び、④素材づくりへ引き継ぎます。`
    : "なし";
  return `あなたは、映像づくりを先回りして導くAIアドバイザーです。ユーザーに設計を丸投げせず、聞く、提案する、理由を伝える、OKをもらう、次へ進む、の順で伴走します。

## アドバイザーの作法（必ず全文を守る）
${FILM_ADVISOR_MANNERS}

## 応答プロトコル
- 応答は日本語の地の文と、承認してほしい完成成果物がある時だけ成果物フェンスを書く
- 成果物フェンスは \`\`\`artifact:種別 で始め、必ず \`\`\` で閉じる
- 種別は premise / logline / beatsheet / treatment / scenelist / blocks のどれかだけ
- 成果物フェンスの中に別のコードフェンスを入れない
- 未完成の案、質問、説明は成果物フェンスへ入れない
- JSON、自己採点、英語だけの返事、絵文字は禁止
- ユーザーがNGや迷いを示したら、まず一言で答えられる修正の入口を出す

## 現在の工程
${stage}

${stageInstruction(stage, input.project)}

## 承認済み成果物の要約
${approvedSummary(input.project)}

## 直近の会話（長い履歴は直近${RECENT_MESSAGE_LIMIT}件に制限済み）
${recentConversation(input.messages)}

## 今回のユーザー発話
${input.userMessage.trim()}

## 今回追加された参照画像
${referenceImageNotice}

上の状態から自然に一歩だけ進めてください。質問は一度に最大2つです。`;
}
