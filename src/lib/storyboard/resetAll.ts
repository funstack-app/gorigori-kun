import { usePlanChat } from "../store/planChat";
import { useSkillMode } from "../store/skillMode";
import { useStoryboardRun } from "../store/storyboardRun";

/**
 * ストーリーカット関連の状態を全てリセットする。
 *
 * STΛCK 指示 (2026-05-15):
 *  企画で確定したストーリーを途中でやめたい時に、企画チャット履歴・
 *  storyboardParams・sceneConstruction・生成 run・スキルモードを一括破棄する。
 *
 * 注意:
 *  - 生成タイムライン(useImages/useBatches)は分離保持の方針で「消さない」。
 *    リセット = 「次のセッションを別物として始める」イメージ。
 */
export function resetStoryboardSession(): void {
  const planChat = usePlanChat.getState();
  planChat.resetThread();
  planChat.setStoryboardParams(null);
  planChat.setSceneConstruction(null);
  planChat.clearPendingImages();

  const skill = useSkillMode.getState();
  skill.setEnabled(false);
  skill.setSelectedSkillId(null);

  const run = useStoryboardRun.getState();
  run.reset();
  run.resetPhases();
}
