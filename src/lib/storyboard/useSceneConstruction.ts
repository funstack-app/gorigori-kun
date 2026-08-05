import { usePlanChat } from "../store/planChat";
import { useStoryboardRun } from "../store/storyboardRun";
import type { SceneConstruction, StoryboardParams } from "./types";

/** storyboard スキルの id (skillUiMode.activeSkillId / skillReset と同じ値)。 */
export const STORYBOARD_SKILL_ID = "gori-storyboard";

/**
 * storyboard の本生成入力 (シーン構成) を、共有ストアの寿命に左右されずに読む。
 *
 * ## なぜこの1本にまとめるか (Sol 評価 blocking#3 / 2026-08-04)
 *
 * 正本は共有ストア `planChat.sceneConstruction` (AI 応答のパーサが書く唯一の書き手)。
 * しかし planChat は **別スキルへ入った瞬間に resetThread() で破棄される**。これは
 * FB#A7 / FB#5 (制作モードの企画チャット・前スキルの構図がスキル側へ混ざる) を
 * 防ぐための意図的な設計で、ゆるめてはならない。
 *
 * 一方 storyboard の DoD は「目標確定 → 漫画へ寄り道 → 戻ると目標確定状態が残る」。
 * 共有ストアの破棄を維持したままこれを満たすには、**storyboard 専用の控え**
 * (`storyboardRun.sceneConstruction`。目標確定時に GoalChatPanel が写す) を
 * フォールバック先に持つしかない。
 *
 * ## なぜ planChat を「無条件には」優先しないか (Sol 評価 2周目 blocking#2)
 *
 * planChat は全スキル共有の 1 本。そして skillReset は
 * 「storyboard に作業が残っていれば planChat を破棄しない」(storyboardDirty 保護)。
 * この 2 つが噛み合うと、
 *
 *   1. storyboard で目標確定 (専用控えに構成が入る)
 *   2. 別スキルへ移動し、そこで planChat に別の構成ができる
 *   3. storyboard へ戻る → storyboardDirty なので planChat が保護されて生き残る
 *   4. 読み手が planChat を無条件優先 → **別スキルの構成で storyboard が生成される**
 *
 * という混入が起きる (Sol の Node プローブで `mixingReproduced: true`)。
 * 書き手が出所 (`sceneConstructionOwner` = 書いた時点の activeSkillId) を名乗るように
 * したので、読み手は「これは storyboard 自身が作ったものか」を確かめてから優先する。
 * 出所が storyboard でない / 不明なら、共有ストアは無かったものとして
 * 専用控えだけを使う。これで FB#A7 型の分離を保ったまま、同一スキル内で会話を
 * 続けて構成を作り直したときの即時反映 (下記) も維持できる。
 *
 * 読み順は「storyboard 由来の planChat」→ storyboard 専用控え。planChat を先に見るのは、
 * 同一スキル内で会話を続けて構成を作り直したとき、最新の応答が即座に反映されるようにするため
 * (控えは目標確定のたびに上書きされるので、確定後は両者が一致する)。
 *
 * 参照箇所を1本にまとめているのは、フォールバックを入れ忘れた読み手が1つでも残ると
 * そこだけ「戻ったら生成できない」に落ちるため。
 */
export function useSceneConstruction(): SceneConstruction | null {
  const fromPlanChat = usePlanChat((s) => s.sceneConstruction);
  const planChatOwner = usePlanChat((s) => s.sceneConstructionOwner);
  const fromRun = useStoryboardRun((s) => s.sceneConstruction);
  return pick(fromPlanChat, planChatOwner, fromRun);
}

/** フック外 (イベントハンドラ等) から同じ優先順で読む版。 */
export function getSceneConstruction(): SceneConstruction | null {
  const plan = usePlanChat.getState();
  return pick(
    plan.sceneConstruction,
    plan.sceneConstructionOwner,
    useStoryboardRun.getState().sceneConstruction,
  );
}

/**
 * 目標確定 (Phase 1 → 2/3) が要求する「構成 + パラメータ」の組を、同じ所有者判定で読む。
 *
 * ## なぜ params も一緒に見るか (Sol 評価 3周目 / 2026-08-04)
 *
 * `storyboardParams` と `sceneConstruction` は AI 応答パーサが **同時に 1 回の set で**
 * 書き、resetThread でも同時に落ちる 1 組 (planChat.ts の set / clear を参照)。
 * よって出所も 1 つ (`sceneConstructionOwner`) で足りる。
 * GoalChatPanel が params だけ共有ストアから直読みすると、構成側は所有者判定で
 * 弾かれたのに params は別スキルのものを掴む、という食い違いが起きうる。
 * 「読む窓口を 1 本にする」方針 (このファイルの存在理由) を params にも広げて塞ぐ。
 *
 * 控え (storyboardRun) 側は params を持たない。控えは「目標確定済み」の状態を
 * 保つためのもので、params の中身は確定時に goal (durationSeconds / aspectRatio /
 * 参照画像パス等) へ写し取られているため、再確定の入力としては不要だから。
 * したがって params が null のときは目標確定できない = 共有ストアに storyboard 自身の
 * 応答が要る、という従来の前提のまま。
 */
export function useStoryboardFinalizeInput(): {
  params: StoryboardParams | null;
  scene: SceneConstruction | null;
} {
  const params = usePlanChat((s) => s.storyboardParams);
  const scene = usePlanChat((s) => s.sceneConstruction);
  const owner = usePlanChat((s) => s.sceneConstructionOwner);
  return pickFinalizeInput(params, scene, owner);
}

/** フック外 (イベントハンドラ等) から同じ判定で読む版。 */
export function getStoryboardFinalizeInput(): {
  params: StoryboardParams | null;
  scene: SceneConstruction | null;
} {
  const plan = usePlanChat.getState();
  return pickFinalizeInput(
    plan.storyboardParams,
    plan.sceneConstruction,
    plan.sceneConstructionOwner,
  );
}

/** 出所が storyboard でなければ組ごと無かったことにする (片方だけ採らない)。 */
function pickFinalizeInput(
  params: StoryboardParams | null,
  scene: SceneConstruction | null,
  owner: string | null,
): { params: StoryboardParams | null; scene: SceneConstruction | null } {
  if (owner !== STORYBOARD_SKILL_ID) return { params: null, scene: null };
  return { params, scene };
}

/**
 * 共有ストアの構成を採用してよいのは、それを **storyboard 自身が作った** ときだけ。
 * hook 版と非 hook 版で判定がずれないよう 1 か所に置く。
 */
function pick(
  fromPlanChat: SceneConstruction | null,
  planChatOwner: string | null,
  fromRun: SceneConstruction | null,
): SceneConstruction | null {
  const planChatIsOurs =
    fromPlanChat !== null && planChatOwner === STORYBOARD_SKILL_ID;
  return planChatIsOurs ? fromPlanChat : fromRun;
}
