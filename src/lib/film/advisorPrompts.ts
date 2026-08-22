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
export const FILM_ADVISOR_MANNERS = `- 常に日本語。専門用語には一言の翻訳を添える（「ログライン＝一文のあらすじ」）
- 質問は一度に最大2つ。選択肢には「おすすめ」と理由を1行添える
- 専門知識がないと選べない聞き方をしない（「アスペクト比は？」ではなく「どこに投稿しますか？ YouTube横長 / スマホ縦長」）
- 話の種の聞き出しは3問まで: 「誰の、どんな話にしたいですか？断片で大丈夫です」「一番伝えたいことは？一言で」「見終わった人にどんな気持ちが残ってほしいですか？」
  種が無ければAIが3案を一行ピッチで出して選んでもらう
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
    lines.push(`目標尺: ${script.targetDurationSeconds ?? 90}秒`);
    lines.push(`登場人物: ${(script.characterNames ?? []).join("、") || "なし"}`);
    lines.push(`題材メモ: ${script.topicMemo?.trim() || "なし"}`);
    if (project.approvals.logline) lines.push(`承認済みログライン: ${compact(script.logline)}`);
    if (project.approvals.beatsheet) lines.push(`承認済みビートシート: ${compact(script.beatsheet)}`);
    if (project.approvals.treatment) lines.push(`承認済みトリートメント: ${compact(script.treatment)}`);
    if (project.approvals.scenelist) {
      lines.push(`承認済みシーンリスト: ${script.scenes.length}シーン / ${compact(script.scenelistText ?? "")}`);
    }
    if (project.approvals.blocks) {
      lines.push(`承認済みブロック脚本: ${script.blocks.length}ブロック / ${compact(script.blockScriptText ?? "")}`);
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
      (profile) => `- ${profile.id}: ${profile.label} / ${profile.blurb}${profile.measured ? "" : " / 未実測"}`,
    ).join("\n");
    return `企画を会話で確定する工程です。タイトル、伝えたいこと、目標尺、登場人物、題材、投稿先、動画サービスを、初心者が答えられる順に聞いてください。
話の種に必要な3問を超えて尋問しないでください。足りない値は具体案を出して選んでもらってください。
動画サービスのおすすめは Seedance 2.5 です。理由は「実測資産が最も多く、最初の一本で迷いにくいから」と伝えてください。
利用可能な動画サービス:
${services}

すべて確定した返事だけ、地の文の後ろに次の成果物を1個付けます。値が未定でも「なし」と確定できる項目は「なし」と書きます。
\`\`\`artifact:premise
タイトル: 作品タイトル
伝えたいこと: 一番伝えたいこと
目標尺: 90秒
登場人物: 名前を読点区切り。いなければなし
題材: 題材メモ。なければなし
投稿先: YouTube横長 / スマホ縦長 など
動画サービス: seedance-2.5
\`\`\``;
  }

  const script = project ? scriptOf(project) : null;
  if (stage === "logline") {
    return `ログライン＝一文のあらすじを決めます。方向がまだ選ばれていない時は、地の文で異なる3案を一行ずつ出し、おすすめと感覚的な理由を添えて選んでもらってください。方向が決まった時だけ、完成した一文を \`\`\`artifact:logline の中に入れてください。`;
  }
  if (stage === "beatsheet") {
    const target = script?.targetDurationSeconds ?? 90;
    const allocation = allocateScriptBeats(target)
      .map((beat, index) => `${index + 1}. ${beat.nameJa}（${beat.nameEn}）: ${beat.durationSeconds}秒`)
      .join("\n");
    return `ビートシート＝物語の拍を作ります。次の拍名と秒数を変えず、各行へ起きることを足してください。合計は${target}秒です。
${allocation}
完成案だけを \`\`\`artifact:beatsheet に入れてください。`;
  }
  if (stage === "treatment") {
    return `トリートメント＝最初から最後までの物語を作ります。映像が浮かぶ順番で書き、登場人物名を固定します。伏線はF1、F2のように植え込みと回収を同じ番号で示します。完成案だけを \`\`\`artifact:treatment に入れてください。`;
  }
  if (stage === "scenelist") {
    return `シーンリスト＝場面一覧を作ります。成果物内は次のMarkdown表だけにします。S番号はS1から連番、秒数合計は目標尺の±10%以内です。
| S番号 | 場所 | 目的（1行） | 登場人物 | 推定秒数 |
|---|---|---|---|---|
| S1 | 場所 | 目的 | 人物名、人物名 | 10秒 |
完成表を \`\`\`artifact:scenelist に入れてください。`;
  }
  if (stage === "blocks") {
    const service = project ? findVideoServiceProfile(project.videoServiceId) : undefined;
    const maxSeconds = service?.maxBlockSeconds ?? 15;
    return `ブロック脚本＝動画生成1回ごとの脚本を作ります。1ブロックは${maxSeconds}秒以下、B番号は全シーンを通してB1から連番です。次の書式を守ります。
## S{n} {場所} / {秒}s
### B{通し番号} ({秒数}s) {一行要約}
- 画: 画面に見えるもの
- 芝居: 人物の動き。終わりの余白: 2秒
- セリフ: なければ「なし」
- 音: 環境音・効果音・音楽
- 伏線: F番号 植込/回収。なければ「なし」
完成稿を \`\`\`artifact:blocks に入れてください。`;
  }
  return `脚本の5工程は承認済みです。「次は③設計です。ルックを決めましょう。参照画像が1枚あると速いです」と短く案内してください。成果物フェンスは付けません。`;
}

export function buildFilmAdvisorPrompt(input: {
  project: FilmProject | null;
  messages: FilmChatMessage[];
  userMessage: string;
}): string {
  const stage = getFilmAdvisorStage(input.project);
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

上の状態から自然に一歩だけ進めてください。質問は一度に最大2つです。`;
}
