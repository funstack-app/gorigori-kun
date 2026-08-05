import { STORYBOARD_SKILL_ID } from "../storyboard/useSceneConstruction";
import { usePlanChat } from "./planChat";
import { useSceneStore } from "./scene";
import { useScenePromptOverride } from "./scenePrompt";

/**
 * スキル横断のセッション状態を一括破棄する (2026-06-06 STΛCK報告)。
 *
 * 別スキルへ切り替えたとき、前スキルの企画チャット履歴・選択状態が **共有ストア経由で**
 * 残ってしまうと、新スキルが前回データを抱えたまま始まってしまう。これを防ぐ。
 *
 * S2 改訂 (2026-08-04 / bd 2ak): 対象を **共有ストアだけ** に絞った。
 * mount-pool 化 (SkillWorkspaceRouter) で「スキルを行き来しても自分の作業が残る」を
 * 実現するため、per-skill run ストア (storyboardRun / multiAngleRun) の切替時 reset は
 * 廃止した。keep-alive で画面を残しながらストアだけ消すのは矛盾するため。
 * これは characterSheetRun が先行している enterMode 方式 (自分の結果は保持・他人の
 * 結果だけ破棄) に揃える形でもある。
 *
 * 破棄し続けるもの (FB#A7 / #5 の実害はこちらが原因なので現行維持):
 *  - planChat (企画チャット。制作モードの会話がスキルの Phase 1 に流れ込む #A7)
 *  - useSceneStore (シーン構築。前スキルの主役/構図/光が要素別編集に混ざる #5)
 *  - useScenePromptOverride (出自が image のときのみ)
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
  const isStoryboard = enteringSkillId === STORYBOARD_SKILL_ID;

  // 企画タブ (storyboard 等の企画フェーズで使う共有チャット)。
  //
  // FB#A7 (2026-06-08): スキルモードはゼロスタート。制作モードで企画チャットした
  // 状態のままスキルモードへ入ると、Phase 1 ゴール深掘りがその会話を引き継いで
  // しまっていた。スキルへ入るときは企画チャットを破棄して 01 の初期状態から始める。
  //
  // ただし storyboard の作業が **既に進んでいる** 場合だけは保護する。
  // これは「目標確定→本生成に進む」中で resetSkillScopedState がもう一度走る経路で、
  // ここで企画チャット (sceneConstruction を含む) を消すと本生成入力が失われ
  // 「目標確定→本生成に進んでも生成が始まらない」バグになる (2026-06-07 STΛCK報告)。
  // フレッシュ起動 (作業が何も無い) なら storyboard でもゼロスタートする。
  //
  // 保護条件は **所有者一致のみ** で判定する (2026-08-04 Sol 4周目 blocking)。
  //
  // 経緯: S2 では「storyboard で目標確定 → 漫画へ寄り道 → storyboard に戻ると目標確定が
  // 失われる」を直すため、storyboardRun 側の作業痕跡 (走行中 run / 本生成カット /
  // 絵コンテ案) を storyboardDirty として保護条件に **OR** で足していた。
  // Sol 3周目で所有者確認を追加したが、OR のままだったため
  //   「storyboard に途中作業がある (dirty=true)」なら **他スキル所有・所有者なしの
  //    planChat まで保護されて生き残る**
  // という迂回路が残っていた。生成入力は読み手側の所有者ゲート
  // (useSceneConstruction) が弾くが、**会話履歴は GoalChatPanel がそのまま表示する**
  // ので、storyboard に戻ると漫画の会話が出る。FB#A7 のゼロスタートが破れる。
  //
  // 直し方は「条件を対象ごとに分ける」。planChat は共有ストアなので、保護してよいのは
  // 「その中身を storyboard 自身が書いた」ときだけ。storyboardRun の作業痕跡は
  // storyboardRun 自身の保護根拠であって、共有ストアを守る根拠にはならない
  // (そして storyboardRun は S2 以降そもそもここで破棄していない = 常に保たれる)。
  //
  // 「寄り道して戻る」ケースが壊れないのはこのため:
  //   - storyboard 自身の構成が planChat に残っていれば owner が一致するので保護される
  //   - 他スキルが planChat を上書きしていたら、それは守るべき自分の状態ではない。
  //     storyboard 自身の構成は storyboardRun の専用控えに写してあり (GoalChatPanel)、
  //     読み手はそちらへ落ちるので目標確定は失われない (T-3 が固定している)
  const planChat = usePlanChat.getState();
  const hasOwnSceneConstruction =
    planChat.sceneConstruction !== null &&
    planChat.sceneConstructionOwner === STORYBOARD_SKILL_ID;
  const protectPlanChat = isStoryboard && hasOwnSceneConstruction;
  if (!protectPlanChat) {
    planChat.resetThread();
    planChat.clearPendingImages();
  }

  // storyboardRun / multiAngleRun の切替時 reset は S2 で廃止した (冒頭コメント参照)。
  // 「スキルを離れて戻ったら続きがある」を成立させるため、per-skill run ストアは
  // スキル切替では触らない。ゼロスタートは各スキルの明示操作 (「新規開始」/
  // Phase レールで入力へ戻る) に委ねる。
  //
  // 旧 CHAIN-01 保護 (2026-07-30 / gori-scene-3d 入場時だけ storyboardRun を残す
  // 特例) は、全スキルで残す方針になったことで不要になったため条件ごと削除した。
  // Scene3dWorkspace の「絵コンテから読み込む」は従来どおり confirmed cuts /
  // generationCutSketchMeta / sketchVersions を読める。

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
