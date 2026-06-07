import { useMultiAngleRun } from "./multiAngleRun";
import { usePlanChat } from "./planChat";
import { useSceneStore } from "./scene";
import { useScenePromptOverride } from "./scenePrompt";
import { useStoryboardRun } from "./storyboardRun";

/**
 * スキル横断のセッション状態を一括破棄する (2026-06-06 STΛCK報告)。
 *
 * 別スキルへ切り替えたとき、前スキルの企画チャット履歴・生成 run・選択状態が
 * 残ってしまうと、新スキルが前回データを抱えたまま始まってしまう。これを防ぎ、
 * 新スキルが 01 (目標 Phase) の初期状態から始まるようにする。
 *
 * 注意:
 *  - skillMode / skillUiMode はここでは触らない。
 *    本関数は syncUiMode (skillMode.ts) の enterSkill 後から呼ばれるため、
 *    ここでモードを巻き戻すと切替先スキルの UI が壊れる。
 *  - 生成タイムライン (useImages / useBatches) は分離保持の方針で消さない。
 *    ライブラリの作品は別スキルに切り替えても残す。
 */
/**
 * @param enteringSkillId これから入るスキルの id。
 *   ストーリーカット生成 (gori-storyboard) は企画タブの sceneConstruction を
 *   本生成の入力に使うため、このスキルへ切り替えるときは企画チャットを破棄しない。
 *   (破棄すると「目標確定→本生成に進んでも生成が始まらない」バグになる。2026-06-07 STΛCK報告)
 */
export function resetSkillScopedState(enteringSkillId?: string | null): void {
  const isStoryboard = enteringSkillId === "gori-storyboard";

  // 企画タブ (storyboard 等の企画フェーズで使う共有チャット)。
  // ストーリーカット生成へ入るときは企画チャット (sceneConstruction含む) を保護する。
  if (!isStoryboard) {
    const planChat = usePlanChat.getState();
    planChat.resetThread();
    planChat.clearPendingImages();
  }

  // ストーリーカット生成スキルの run/phase。これから storyboard に入る場合でも、
  // 前回の本生成 run の残骸はクリアしてよい (sceneConstruction は planChat 側で保持)。
  const storyboard = useStoryboardRun.getState();
  storyboard.reset();
  storyboard.resetPhases();

  // マルチアングル生成スキル (run も選択も設定も初期化して新規開始にする)
  const multiAngle = useMultiAngleRun.getState();
  multiAngle.reset();
  multiAngle.clearSelection();
  multiAngle.setCharacterImage(null);
  multiAngle.setEnvironment("");

  // シーン構築 (画像/動画タブの要素別編集の元データ) を破棄する。
  // これが残ると、別スキルへ切り替えた後も前回の主役/構図/光/カメラ/スタイルが
  // 要素別編集に混ざる (#5 「ミックスされる/リセットされない」report 2026-06-07)。
  // 注: storyboard の本生成入力は planChat.sceneConstruction であって useSceneStore ではないため、
  //     storyboard へ入るときにここを消しても本生成バグは起きない。
  useSceneStore.getState().resetScene();

  // override プロンプトの破棄は出自で判定する (R-1 修正 2026-06-07 独立レビュー指摘)。
  // scenePromptOverride は画像生成と動画 i2v が共有する単一 value。出自が "i2v"
  // (ストーリーカットを動画タブへ送ったときの i2v プロンプト) のときは、別スキルへ
  // 切り替えても消さない。消すと送ったばかりの i2v プロンプトが失われる。
  // 出自が "image" (画像のシーン構築/手書き/企画採用) のときだけ #5 のとおり消す。
  // 旧実装は useVideoGen.sourceImagePath で代用していたが、それは「i2v元画像を
  // セットしたまま外していないか」であって「今i2v作業中か」ではなく、動画タブを
  // 離れた後も true のまま残って画像作業中に誤判定した。出自フラグで根治する。
  if (useScenePromptOverride.getState().source !== "i2v") {
    useScenePromptOverride.getState().clear();
  }
}
