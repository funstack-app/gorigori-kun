import { useEffect } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { ensureMultiAngleEventListener } from "../../../lib/multiangle/events";
import { useMultiAngleRun } from "../../../lib/store/multiAngleRun";
import { useToasts } from "../../../lib/store/toasts";

import { AngleSettingsPanel } from "./AngleSettingsPanel";
import { AngleGridPanel } from "./AngleGridPanel";

/**
 * マルチアングル Workspace（β版）
 *
 * ユーザー合意 (2026-06-06):
 *   - 画像生成タブのような「左に設定 / 右に出力グリッド」の2ペイン
 *   - 1枚の被写体参照から、選んだ構図カット（最大30）を並列で一気に生成
 *   - 出力は普通の1枚画像。各カットは独立してグリッドに並ぶ
 *   - ActiveProjectSelector で案件横断（生成物をそのまま案件へ）
 *
 * SkillWorkspaceRouter が activeUiMode === "multiAngle" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / StoryboardWorkspace は触らない。
 * 画像プレビューは App ルートの ImagePreviewModal（グローバル）を useImagePreview.open で呼ぶ。
 */
export function MultiAngleWorkspace() {
  const openPreview = useImagePreview((s) => s.open);
  const pushToast = useToasts((s) => s.push);
  const status = useMultiAngleRun((s) => s.status);
  const startNewRun = useMultiAngleRun((s) => s.startNewRun);
  const characterImagePath = useMultiAngleRun((s) => s.characterImagePath);
  const selectedCutIds = useMultiAngleRun((s) => s.selectedCutIds);
  const cutOrder = useMultiAngleRun((s) => s.cutOrder);
  const environmentDescription = useMultiAngleRun((s) => s.environmentDescription);
  const aspectRatio = useMultiAngleRun((s) => s.aspectRatio);

  /*
   * 「新規開始」= run 単位のゼロスタート (Sol 評価 blocking#6 / 2026-08-04)。
   *
   * S2 の mount-pool 化で、スキルを離れて戻っても作業が残るようになった。
   * その裏返しで「前の被写体・前の構図選択・前の結果を消して最初から」の手段が
   * 画面から失われる。設計書 §4 DoD 7 が各スキルに明示操作を求めているのはこのため。
   *
   * 生成中は押せなくする。走っている run の表示だけ消えて生成は裏で続く、という
   * 分かりにくい状態を作らないため (止めたい場合は右上の進捗パネルから中止する)。
   */
  const running = status === "running";
  /*
   * 「消す作業があるか」は startNewRun() が実際に初期化する入力すべてを見る
   * (Sol 評価 2周目 blocking#3 / 2026-08-04)。
   *
   * 旧判定は 被写体画像・カット選択・結果 の 3 つだけを見ていたため、
   * 環境文だけ書いた / 比率だけ 16:9 に変えた状態ではボタンが押せず、
   * 「消す作業がありません」と出るのに入力欄は埋まっている、という
   * 説明できない状態になっていた。startNewRun() 側 (multiAngleRun.ts:247-256) が
   * 環境文と比率も初期値へ戻す以上、判定もそこへ揃える。
   * 既定値との比較なので、初期状態では従来どおり押せない。
   */
  const hasWork =
    characterImagePath !== null ||
    selectedCutIds.length > 0 ||
    cutOrder.length > 0 ||
    environmentDescription !== "" ||
    aspectRatio !== "1:1";

  function handleNewRun() {
    if (running) return;
    startNewRun();
    pushToast({
      kind: "info",
      text: "マルチアングルを新規開始しました。",
      ttlMs: 2500,
    });
  }

  useEffect(() => {
    void ensureMultiAngleEventListener().catch((err) => {
      useMultiAngleRun.getState().reset();
      pushToast({
        kind: "error",
        text: `生成結果の受信準備に失敗しました: ${(err as Error)?.message ?? err}`,
      });
    });
  }, [pushToast]);

  return (
    <section
      data-tour="multi-angle-workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]"
    >
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
          <button
            type="button"
            onClick={handleNewRun}
            disabled={running || !hasWork}
            title={
              running
                ? "生成中は新規開始できません"
                : hasWork
                  ? "被写体・構図・環境・比率と結果をすべて消して最初からやり直します"
                  : "消す作業がありません"
            }
            className="ml-auto shrink-0 rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:border-[#242424] disabled:text-neutral-600 disabled:hover:border-[#242424] disabled:hover:text-neutral-600"
          >
            新規開始
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AngleSettingsPanel />
        <div
          data-tour="multi-angle-results"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <AngleGridPanel
            onPreview={(path, all) => openPreview(path, all)}
          />
        </div>
      </div>
    </section>
  );
}
