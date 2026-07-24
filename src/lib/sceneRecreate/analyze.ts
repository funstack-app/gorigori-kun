/**
 * シーン再現(映像分析)の実行オーケストレーション。
 *
 * codex は動画を直接見られないため、2段構成で成立させる:
 *   1. 各キーフレームを codex_describe_image(単画像 vision)で説明文化する。
 *      → 複数画像を1回で渡せる vision コマンドはフロント/ipc に未露出のため、
 *        フレームごとに逐次呼ぶ(ギャップとして報告)。
 *   2. 説明文列 + ユーザー補足を codexTextQuery(テキスト・JSON)へ渡し、
 *      映像文法でショット割りを構造化する。
 *
 * 既存の露出済み経路(ipc の codex_describe_image / agents/codexQuery の
 * codexTextQuery)だけを使い、新しい Rust コマンドは足さない。
 */

import { invoke } from "@tauri-apps/api/core";

import { codexTextQuery } from "../agents/codexQuery";
import {
  SCENE_ANALYSIS_SYSTEM_PROMPT,
  buildSceneAnalysisPrompt,
  normalizeSceneAnalysis,
} from "./prompts";
import type { Keyframe, SceneAnalysis } from "./types";

/** 分析の進捗を UI へ返すためのコールバック(任意)。 */
export type AnalyzeProgress = {
  /** 説明文化が完了したフレーム数 / 全体。 */
  onDescribeProgress?: (done: number, total: number) => void;
  /** 一部フレームだけ説明文化に失敗した場合に件数を通知する。 */
  onDescribePartialFailure?: (failed: number, total: number) => void;
};

/** 1フレームを説明文化する。失敗しても他フレームを止めないため、空文字で継続する。 */
async function describeFrame(path: string): Promise<string> {
  try {
    const desc = await invoke<string>("codex_describe_image", { imagePath: path });
    return typeof desc === "string" ? desc.trim() : "";
  } catch {
    return "";
  }
}

/**
 * キーフレーム列を映像文法で分析して SceneAnalysis を返す。
 * @throws 説明が1件も取れなかった / Codex 応答が JSON として壊れていた場合。
 */
export async function analyzeScene(
  keyframes: Keyframe[],
  userNote: string,
  progress?: AnalyzeProgress,
): Promise<SceneAnalysis> {
  const total = keyframes.length;
  if (total === 0) {
    throw new Error("キーフレームを1枚以上投入してください。");
  }

  // 第1段: 各フレームを逐次で説明文化(単画像 vision しか露出していないため)。
  const descriptions: string[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const desc = await describeFrame(keyframes[i].path);
    descriptions.push(desc);
    progress?.onDescribeProgress?.(i + 1, total);
  }

  if (descriptions.every((d) => d.length === 0)) {
    throw new Error(
      "キーフレームの説明を取得できませんでした(Codex 認証・ネットワークを確認してください)。",
    );
  }
  const failedDescriptions = descriptions.filter((d) => d.length === 0).length;
  if (failedDescriptions > 0) {
    progress?.onDescribePartialFailure?.(failedDescriptions, total);
  }

  // 第2段: 説明文列 + 補足を JSON でショット割り化。
  const prompt = buildSceneAnalysisPrompt({ frameDescriptions: descriptions, userNote });
  const res = await codexTextQuery({
    prompt,
    systemPrompt: SCENE_ANALYSIS_SYSTEM_PROMPT,
    expectJson: true,
    // フレーム数が多いと推論が伸びるので長めに取る(上限300)。
    timeoutSecs: 180,
  });

  const analysis = normalizeSceneAnalysis(res.parsedJson);
  if (!analysis) {
    throw new Error("分析結果を構造化できませんでした(もう一度お試しください)。");
  }
  return analysis;
}
