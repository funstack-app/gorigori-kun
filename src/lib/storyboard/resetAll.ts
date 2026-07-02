import { usePlanChat } from "../store/planChat";
import { useSceneStore } from "../store/scene";
import { useScenePromptOverride } from "../store/scenePrompt";
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
  // 走行中 run の安全中止 (2026-07-02 W3-4):
  //  run が方向性チェック (checkpoint) で待機中なら、フロントを wipe する前に
  //  バックエンドの orchestrator へ cancel を送って oneshot 待機を解く。
  //  これをやらないと、reset() でストアを空にした後も orchestrator が checkpoint で
  //  await し続け (waiter リーク)、空ストアへイベントを emit し続ける。
  //  cancelCheckpoint は checkpointResume(cancel) を fire-and-forget で呼び、
  //  生成済みカットは保持したまま status を cancelled にする (状態はこの直後の
  //  reset() で初期化されるので、ここでの目的はバックエンド解放のみ)。
  //  注意: checkpoint 待機中でない mid-flight run はバックエンドに中止 API が無いため
  //  (checkpoint 到達時のみ oneshot が登録される)、ここでは解放できない。
  if (run.checkpointCutId !== null) {
    run.cancelCheckpoint();
  }
  run.reset();
  run.resetPhases();

  // シーン構築 (要素別編集の元データ) と override プロンプトも破棄して、
  // 次のセッションを完全な別物として始める (#5 残留対策 2026-06-07)。
  // ここは「企画を丸ごとやめてスキルモードも抜ける」完全リセット (上で
  // setEnabled(false)) なので、動画 i2v の override も一緒に消えてよい。
  // (プロジェクト切替=ActiveProjectSelector では override を消さない。あちらは
  //  案件を移るだけで動画作業を捨てる意図がないため。区別は意図的。)
  useSceneStore.getState().resetScene();
  useScenePromptOverride.getState().clear();
}
