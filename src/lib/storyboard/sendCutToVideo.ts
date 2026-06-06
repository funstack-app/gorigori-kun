import { useScenePromptOverride } from "../store/scenePrompt";
import { useSkillUiMode } from "../store/skillUiMode";
import { useToasts } from "../store/toasts";
import { useVideoGen } from "../store/videoGen";
import { useWorkspace } from "../store/workspace";

/**
 * 確定カット → 動画タブ連携 (B3 / B5)。
 *
 * STΛCK 指示 (2026-06-06 ベータ): ストーリーモードで確定したカット画像を
 * 動画タブの i2v 元画像にそのまま渡せる導線を作る。
 *
 * ストーリーモード (StoryboardWorkspace) は SkillWorkspaceRouter が
 * activeUiMode === "storyboard" のときに描画している。動画タブは
 * 既存の GenerationWorkspace 側にあるため、動画タブを表示するには
 * (1) スキルモードを抜けて default に戻す
 * (2) activeTab を "video" にする
 * の両方が必要。片方だけだと動画タブに切り替わらない (storyboard UI のまま)。
 */

export type SendCutToVideoInput = {
  /** i2v 元画像に使うカット画像の絶対パス */
  imagePath: string;
  /** 動画タブに自動セットする i2v プロンプト (任意) */
  prompt?: string;
};

/**
 * 単一カットを動画タブの i2v 元画像にセットしてタブを開く。
 */
export function sendCutToVideoTab(input: SendCutToVideoInput): void {
  const video = useVideoGen.getState();
  video.setSourceImage(input.imagePath);

  // プロンプトが渡されていれば override にセット (手動編集可能)。
  if (typeof input.prompt === "string" && input.prompt.trim().length > 0) {
    useScenePromptOverride.getState().set(input.prompt.trim());
  }

  // スキルモードを抜けて動画タブを表示できる状態にする。
  useSkillUiMode.getState().exitSkill();
  useWorkspace.getState().setActiveTab("video");

  useToasts.getState().push({
    kind: "success",
    text: "動画タブに確定カットをセットしました。",
    ttlMs: 3000,
  });
}

export type SendCutsBatchInput = {
  /** 動画化するカット (確定順)。先頭が i2v 元画像にセットされる。 */
  cuts: Array<{ imagePath: string; prompt: string; label: string }>;
};

/**
 * 確定カットを一括で動画タブへ送る (B5)。
 *
 * 動画タブの i2v 元画像は 1 枚なので、先頭カットを元画像にセットしつつ、
 * 全カット分の i2v プロンプトをクリップボードへコピーする。ユーザーは
 * 動画タブで 1 カットずつ画像を差し替えながら、コピーしたプロンプトを
 * 貼り付けて生成できる (プロンプトは自動設定 + 手動コピペの両対応)。
 *
 * 返り値: クリップボードへコピーしたカット数。
 */
export async function sendCutsBatchToVideoTab(
  input: SendCutsBatchInput,
): Promise<number> {
  const cuts = input.cuts.filter((c) => c.imagePath);
  if (cuts.length === 0) {
    useToasts.getState().push({
      kind: "error",
      text: "動画化できる確定カットがありません。",
      ttlMs: 4000,
    });
    return 0;
  }

  const first = cuts[0];
  const video = useVideoGen.getState();
  video.setSourceImage(first.imagePath);
  if (first.prompt.trim().length > 0) {
    useScenePromptOverride.getState().set(first.prompt.trim());
  }

  // 全カット分の i2v プロンプトをクリップボードへ (手動コピペ用)。
  const clipboardText = cuts
    .map((c) => `# ${c.label}\n${c.prompt}`)
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(clipboardText);
  } catch (err) {
    console.warn("[sendCutsBatchToVideoTab] clipboard write failed:", err);
  }

  useSkillUiMode.getState().exitSkill();
  useWorkspace.getState().setActiveTab("video");

  useToasts.getState().push({
    kind: "success",
    text: `${cuts.length} カットを動画タブへ送りました (先頭を元画像にセット、全カットのプロンプトをコピー済み)。`,
    ttlMs: 4500,
  });
  return cuts.length;
}
