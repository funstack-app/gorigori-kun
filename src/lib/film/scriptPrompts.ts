import type { FilmBlock, FilmScene } from "./types";

export type ScriptStage =
  | "logline"
  | "beatsheet"
  | "treatment"
  | "scenelist"
  | "blocks";

export type BeatDefinition = {
  id: string;
  nameJa: string;
  nameEn: string;
  minuteFrom: number;
  minuteTo: number;
  weightMinutes: number;
};

/** 110分映画を基準にした Save the Cat 15拍。秒数は目標尺へ比例配分する。 */
export const SAVE_THE_CAT_15_BEATS: readonly BeatDefinition[] = [
  { id: "opening-image", nameJa: "冒頭の一枚", nameEn: "Opening Image", minuteFrom: 0, minuteTo: 1, weightMinutes: 1 },
  { id: "theme-stated", nameJa: "テーマの提示", nameEn: "Theme Stated", minuteFrom: 1, minuteTo: 2, weightMinutes: 1 },
  { id: "setup", nameJa: "状況設定", nameEn: "Set-Up", minuteFrom: 2, minuteTo: 11, weightMinutes: 9 },
  { id: "catalyst", nameJa: "きっかけ", nameEn: "Catalyst", minuteFrom: 11, minuteTo: 13, weightMinutes: 2 },
  { id: "debate", nameJa: "迷い", nameEn: "Debate", minuteFrom: 13, minuteTo: 25, weightMinutes: 12 },
  { id: "break-into-two", nameJa: "第二幕へ", nameEn: "Break into Two", minuteFrom: 25, minuteTo: 27, weightMinutes: 2 },
  { id: "b-story", nameJa: "もう一つの物語", nameEn: "B Story", minuteFrom: 27, minuteTo: 30, weightMinutes: 3 },
  { id: "fun-and-games", nameJa: "お楽しみ", nameEn: "Fun and Games", minuteFrom: 30, minuteTo: 52, weightMinutes: 22 },
  { id: "midpoint", nameJa: "中間点", nameEn: "Midpoint", minuteFrom: 52, minuteTo: 55, weightMinutes: 3 },
  { id: "bad-guys-close-in", nameJa: "迫る困難", nameEn: "Bad Guys Close In", minuteFrom: 55, minuteTo: 73, weightMinutes: 18 },
  { id: "all-is-lost", nameJa: "すべてを失う", nameEn: "All Is Lost", minuteFrom: 73, minuteTo: 75, weightMinutes: 2 },
  { id: "dark-night", nameJa: "心の暗夜", nameEn: "Dark Night of the Soul", minuteFrom: 75, minuteTo: 83, weightMinutes: 8 },
  { id: "break-into-three", nameJa: "第三幕へ", nameEn: "Break into Three", minuteFrom: 83, minuteTo: 85, weightMinutes: 2 },
  { id: "finale", nameJa: "決着", nameEn: "Finale", minuteFrom: 85, minuteTo: 109, weightMinutes: 24 },
  { id: "final-image", nameJa: "最後の一枚", nameEn: "Final Image", minuteFrom: 109, minuteTo: 110, weightMinutes: 1 },
] as const;

export const SHORT_FILM_5_BEATS = [
  { id: "ordinary", nameJa: "日常", nameEn: "Ordinary" },
  { id: "incident", nameJa: "事件", nameEn: "Incident" },
  { id: "decision", nameJa: "決断", nameEn: "Decision" },
  { id: "climax", nameJa: "山", nameEn: "Climax" },
  { id: "landing", nameJa: "落とし", nameEn: "Landing" },
] as const;

export type AllocatedBeat = {
  id: string;
  nameJa: string;
  nameEn: string;
  durationSeconds: number;
};

function allocateByWeights(
  targetSeconds: number,
  beats: ReadonlyArray<{ id: string; nameJa: string; nameEn: string; weight: number }>,
): AllocatedBeat[] {
  const safeTarget = Math.max(1, Math.round(targetSeconds));
  const totalWeight = beats.reduce((sum, beat) => sum + beat.weight, 0);
  const raw = beats.map((beat) => (safeTarget * beat.weight) / totalWeight);
  const base = raw.map((seconds) => Math.floor(seconds));
  let remaining = safeTarget - base.reduce((sum, seconds) => sum + seconds, 0);
  const remainderOrder = raw
    .map((seconds, index) => ({ index, remainder: seconds - base[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of remainderOrder) {
    if (remaining <= 0) break;
    base[item.index] += 1;
    remaining -= 1;
  }
  return beats.map((beat, index) => ({
    id: beat.id,
    nameJa: beat.nameJa,
    nameEn: beat.nameEn,
    durationSeconds: base[index],
  }));
}

/** 90秒以下は5拍、91秒以上は15拍へ按分する。合計は必ず目標秒数になる。 */
export function allocateScriptBeats(targetDurationSeconds: number): AllocatedBeat[] {
  if (targetDurationSeconds <= 90) {
    return allocateByWeights(
      targetDurationSeconds,
      SHORT_FILM_5_BEATS.map((beat) => ({ ...beat, weight: 1 })),
    );
  }
  return allocateByWeights(
    targetDurationSeconds,
    SAVE_THE_CAT_15_BEATS.map((beat) => ({ ...beat, weight: beat.weightMinutes })),
  );
}

function revisionLine(revisionNote?: string): string {
  return revisionNote?.trim()
    ? `\n前の案への修正希望: ${revisionNote.trim()}\n修正希望を反映し、全文を書き直してください。`
    : "";
}

export function buildLoglinePrompt(input: {
  title: string;
  theme: string;
  topicMemo?: string;
  revisionNote?: string;
}): string {
  return `あなたは映像脚本家です。ログライン（一文のあらすじ）を日本語で3案書いてください。
作品タイトル: ${input.title}
一番伝えたいこと: ${input.theme}
題材メモ: ${input.topicMemo?.trim() || "なし"}

条件:
- それぞれ一行のピッチにする
- 主人公・出来事・選択・観たくなる引きを入れる
- 喪失や死別だけに偏らず、異なる方向の3案にする
- 説明や自己採点は付けない
- 書式を厳守する: 「案1: ...」「案2: ...」「案3: ...」${revisionLine(input.revisionNote)}`;
}

export function buildBeatsheetPrompt(input: {
  approvedLogline: string;
  targetDurationSeconds: number;
  revisionNote?: string;
}): string {
  const beats = allocateScriptBeats(input.targetDurationSeconds);
  const format = beats
    .map((beat, index) => `${index + 1}. ${beat.nameJa}（${beat.nameEn}）: ${beat.durationSeconds}秒`)
    .join("\n");
  return `あなたは映像脚本家です。承認済みログラインからビートシート（物語の拍）を書いてください。
承認済みログライン: ${input.approvedLogline}
目標尺: ${Math.round(input.targetDurationSeconds)}秒

${input.targetDurationSeconds <= 90 ? "短編5拍圧縮（日常→事件→決断→山→落とし）" : "Save the Cat 15拍"}を使い、次の拍名・秒数を変えないでください。秒数合計は目標尺と完全一致させます。
${format}

各行は「番号. 拍名（英語名）: 秒数秒 — 起きること」の一行にしてください。説明や自己採点は付けません。${revisionLine(input.revisionNote)}`;
}

export function buildTreatmentPrompt(input: {
  approvedBeatsheet: string;
  characterNames: string[];
  revisionNote?: string;
}): string {
  return `あなたは映像脚本家です。承認済みビートシートからトリートメント（最初から最後までの物語）を日本語の散文で書いてください。
承認済みビートシート:
${input.approvedBeatsheet}

登場人物名（表記を一字一句そろえる）: ${input.characterNames.length > 0 ? input.characterNames.join("、") : "未指定"}

条件:
- 冒頭から結末までを順番に、映像が浮かぶ具体性で書く
- 伏線は F1、F2… と番号を付け、最初は別の意味だと思わせる形で植える
- 回収時にも同じF番号を書く
- 登場人物名の表記を勝手に変えない
- 説明や自己採点は付けない${revisionLine(input.revisionNote)}`;
}

export function buildScenelistPrompt(input: {
  approvedTreatment: string;
  targetDurationSeconds: number;
  characterNames: string[];
  revisionNote?: string;
}): string {
  return `あなたは映像脚本家です。承認済みトリートメントからシーンリスト（場面一覧）を作ってください。
承認済みトリートメント:
${input.approvedTreatment}

目標尺: ${Math.round(input.targetDurationSeconds)}秒（全シーン合計は±10%以内）
登場人物名（表記を一字一句そろえる）: ${input.characterNames.length > 0 ? input.characterNames.join("、") : "未指定"}

次のMarkdown表だけを出力してください。S番号はS1から連番です。
| S番号 | 場所 | 目的（1行） | 登場人物 | 推定秒数 |
|---|---|---|---|---|
| S1 | 場所 | 目的 | 人物名、人物名 | 10秒 |

登場人物がいない場合は「なし」と書きます。説明や自己採点は付けません。${revisionLine(input.revisionNote)}`;
}

export function buildBlockScriptPrompt(input: {
  approvedScenes: FilmScene[];
  approvedScenelistText: string;
  serviceMaxSeconds?: number;
  revisionNote?: string;
}): string {
  const serviceMaxSeconds = input.serviceMaxSeconds ?? 25;
  return `あなたは映像脚本家です。承認済みシーンリストからブロック脚本（動画生成1回ごとの脚本）を書いてください。
承認済みシーンリスト:
${input.approvedScenelistText || input.approvedScenes.map((scene) => `${scene.id} ${scene.location} ${scene.durationSeconds}秒`).join("\n")}

絶対規律:
- P9: カット数はビート数とする。意味のない細切れカットを足さない
- 1ブロックは${serviceMaxSeconds}秒以下
- P13: 各ブロックの末尾に、感情や動作が残る「終わりの余白」を秒数で明記する
- P14: カット尺は感情の余白で決める。全体を等分割しない
- B番号は全シーンを通してB1から連番
- 伏線は「F1 植込」「F1 回収」のように同じ番号と役割を書く。無ければ「なし」

次の書式を一字一句守り、説明・コードフェンス・自己採点を付けないでください。
## S{n} {場所} / {秒}s
### B{通し番号} ({秒数}s) {一行要約}
- 画: {画面に見えるもの。カットごとの内容もここに書く}
- 芝居: {人物の動き。末尾に「終わりの余白: 2秒」の形で秒数を書く}
- セリフ: {セリフ。無ければ「なし」}
- 音: {環境音・効果音・音楽}
- 伏線: {F番号 植込/回収。無ければ「なし」}${revisionLine(input.revisionNote)}`;
}

export function buildBlockScriptRepairPrompt(raw: string, reason: string): string {
  return `次のブロック脚本は内容を変えず、書式だけを1回修復してください。
壊れている理由: ${reason}

必須書式:
## S{n} {場所} / {秒}s
### B{通し番号} ({秒数}s) {一行要約}
- 画: ...
- 芝居: ...（終わりの余白を秒数で残す）
- セリフ: ...
- 音: ...
- 伏線: F番号 植込/回収 または なし

説明・コードフェンスを付けず、修復後の全文だけを返してください。

修復対象:
${raw}`;
}

export function formatScenesAsScenelist(scenes: FilmScene[]): string {
  return [
    "| S番号 | 場所 | 目的（1行） | 登場人物 | 推定秒数 |",
    "|---|---|---|---|---|",
    ...scenes.map(
      (scene) =>
        `| ${scene.id} | ${scene.location} | ${scene.purpose} | ${scene.characterNames.join("、") || "なし"} | ${scene.durationSeconds}秒 |`,
    ),
  ].join("\n");
}

export function formatBlocksAsScript(blocks: FilmBlock[], scenes: FilmScene[]): string {
  const byScene = new Map(scenes.map((scene) => [scene.id, scene]));
  const lines: string[] = [];
  let currentScene = "";
  for (const block of blocks) {
    if (block.sceneId !== currentScene) {
      currentScene = block.sceneId;
      const scene = byScene.get(currentScene);
      lines.push(`## ${currentScene} ${scene?.location ?? "場所未設定"} / ${scene?.durationSeconds ?? block.durationSeconds}s`);
    }
    lines.push(
      `### ${block.id} (${block.durationSeconds}s) ブロック`,
      `- 画: ${block.visual}`,
      `- 芝居: ${block.performance}`,
      `- セリフ: ${block.dialogue}`,
      `- 音: ${block.sound}`,
      `- 伏線: ${block.foreshadowIds.join("、") || "なし"}`,
    );
  }
  return lines.join("\n");
}
