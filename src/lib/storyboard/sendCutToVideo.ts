import { useScenePromptOverride } from "../store/scenePrompt";
import { useToasts } from "../store/toasts";
import { useVideoGen } from "../store/videoGen";
import { hasGeneratedWork, useVideoStory } from "../store/videoStory";
import { useWorkspace } from "../store/workspace";

/**
 * 確定カット → 動画タブ連携 (B3 / B5)。
 *
 * STΛCK 指示 (2026-06-06 ベータ): ストーリーモードで確定したカット画像を
 * 動画タブの i2v 元画像にそのまま渡せる導線を作る。
 *
 * FB#1 修正 (2026-06-06 夜): 以前は exitSkill() でスキルモードを抜けてから
 * 動画タブに切り替えていた。しかしこれは StoryboardWorkspace から完全に離脱し、
 * ストーリーモードの状態 (Phase レール / 確定カット) を画面から失わせていた
 * (UI が崩れる主因)。
 *
 * 現在は StoryboardWorkspace 自身が activeTab === "video" のとき動画タブを
 * インライン描画する (SkillWorkspaceRouter は storyboard モードのまま)。
 * よって exitSkill() は呼ばず、activeTab を "video" にするだけで
 * 「動画タブに切り替わるが、ストーリーモードからは抜けない」を実現する。
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
  // 出自を "i2v" にして、別スキル切替時の clear から保護する (R-1)。
  if (typeof input.prompt === "string" && input.prompt.trim().length > 0) {
    useScenePromptOverride.getState().set(input.prompt.trim(), "i2v");
  }

  // スキルモードは抜けず、ストーリーモード内の動画タブに切り替えるだけ。
  // (StoryboardWorkspace が activeTab === "video" を見てインライン描画する)
  useWorkspace.getState().setActiveTab("video");

  useToasts.getState().push({
    kind: "success",
    text: "動画タブに確定カットをセットしました。",
    ttlMs: 3000,
  });
}

export type SendCutsBatchInput = {
  /** 動画化するカット (確定順)。この順序がそのまま結合順になる。 */
  cuts: Array<{
    cutId: string;
    imagePath: string;
    prompt: string;
    label: string;
    durationSeconds: number;
  }>;
};

/**
 * 確定カットを一括でストーリー動画キューへ積む (B5 → uy6 Wave 3)。
 *
 * 旧実装は「先頭カットだけ i2v 元画像にセット + 全カットのプロンプトを
 * クリップボードへコピー」で、ユーザーが 1 カットずつ画像を差し替えながら
 * 手動生成する前提だった。uy6 でキュー方式 (カットごとに自動 i2v 生成 →
 * ffmpeg で 1 本に結合) に置き換えたため、クリップボード導線は廃止した
 * (design-video-story.md §1-B)。
 *
 * 返り値: キューへ積んだカット数。積まなかった (ユーザーが取り消した) 場合は 0。
 */
export async function sendCutsBatchToVideoTab(input: SendCutsBatchInput): Promise<number> {
  const cuts = input.cuts.filter((c) => c.imagePath);
  if (cuts.length === 0) {
    useToasts.getState().push({
      kind: "error",
      text: "動画化できる確定カットがありません。",
      ttlMs: 4000,
    });
    return 0;
  }

  // setQueue は全置換なので、生成済みのカット動画・結合済み動画があると
  // 黙って捨てることになる (再生成は有料枠を再消費する)。捨てる前に必ず聞く。
  // 新しいモーダルは足さず、既存の破壊的操作と同じ window.confirm に揃える
  // (ActiveProjectSelector / PresetsDrawer / projects.ts と同型)。
  const story = useVideoStory.getState();
  if (hasGeneratedWork(story)) {
    const doneCount = story.cuts.filter((c) => c.status === "done").length;
    const message =
      `ストーリー動画キューに生成済みの動画が ${doneCount} 本あります。\n` +
      "積み直すとこの生成結果は失われ、作り直すには再度生成が必要です。\n\n" +
      "積み直しますか？";
    let ok = false;
    try {
      ok = window.confirm(message);
    } catch {
      // confirm が使えない環境 (jsdom 等) では捨てない側に倒す。
      ok = false;
    }
    if (!ok) {
      useToasts.getState().push({
        kind: "info",
        text: "積み直しをやめました。今のキューはそのままです。",
        ttlMs: 4000,
      });
      return 0;
    }
  }

  useVideoStory.getState().setQueue(
    cuts.map((c, i) => ({
      cutId: c.cutId,
      order: i + 1,
      imagePath: c.imagePath,
      prompt: c.prompt,
      requestedSeconds: c.durationSeconds,
    })),
  );

  // FB#1 修正: スキルモードは抜けず、ストーリーモード内の動画タブへ切り替える。
  useWorkspace.getState().setActiveTab("video");

  useToasts.getState().push({
    kind: "success",
    text: `${cuts.length} カットをストーリー動画キューにセットしました。`,
    ttlMs: 4500,
  });
  return cuts.length;
}
