/**
 * 足の接地ロック(foot planting IK)。足滑り=最も目につく不自然さへの対策。
 *
 * 取り込み時に検出した接地スパン(PlantSpan)の間、足首(DEF-foot)のワールド位置を
 * 「スパン開始時点の足位置(アンカー)」へ2ボーンCCD IK(腿・脛)で固定する。
 * - アンカーはクリップ自身をスパン開始時刻で一時評価して採取する。履歴状態を持たないため
 *   スクラブしても同一フレーム→同一姿勢の決定性が保たれる(採取結果はキャッシュ)
 * - スパンの入り/抜き0.12秒はIK目標をブレンドしてポップを防ぐ(業界定石)
 * Viewport(アプリ再生)と検証ハーネスの両方から使う共有実装。
 */
import { Object3D, Quaternion, Vector3 } from "three";
import type { PlantSpan } from "./motionGen";

export type FootChain = { thigh: Object3D; shin: Object3D; foot: Object3D };
export type FootIKState = {
  chains: { L?: FootChain; R?: FootChain };
  /** スパンindex → クリップルートローカルのアンカー位置(遅延計算キャッシュ) */
  anchors: Map<number, Vector3>;
};

/** スパン端のブレンド幅(秒)。硬い切替はポップになる */
const BLEND = 0.12;

/** リグから左右の脚チェーン(腿・脛・足)を拾う。GLTFLoaderのサニタイズ済み名に対応 */
export function buildFootChains(obj: Object3D): FootIKState {
  const found: Record<"L" | "R", Partial<FootChain>> = { L: {}, R: {} };
  obj.traverse((n) => {
    const m = n.name.match(/DEF-?(thigh|shin|foot)\.?([LR])$/);
    if (m) found[m[2] as "L" | "R"][m[1] as keyof FootChain] = n;
  });
  const chains: FootIKState["chains"] = {};
  for (const s of ["L", "R"] as const) {
    const c = found[s];
    if (c.thigh && c.shin && c.foot) chains[s] = c as FootChain;
  }
  return { chains, anchors: new Map() };
}

const _effector = new Vector3();
const _bonePos = new Vector3();
const _dirE = new Vector3();
const _dirT = new Vector3();
const _qWorld = new Quaternion();
const _parentQ = new Quaternion();
const _qLocal = new Quaternion();
const _cur = new Vector3();

/** 2ボーンCCD: 腿・脛を回して足首(footノード)をtargetへ寄せる。ボーン軸規約に依存しない */
function solveTwoBoneCCD(chain: FootChain, target: Vector3, iterations = 4): void {
  for (let it = 0; it < iterations; it++) {
    for (const bone of [chain.shin, chain.thigh]) {
      chain.foot.getWorldPosition(_effector);
      if (_effector.distanceTo(target) < 0.005) return;
      bone.getWorldPosition(_bonePos);
      _dirE.copy(_effector).sub(_bonePos);
      _dirT.copy(target).sub(_bonePos);
      if (_dirE.lengthSq() < 1e-8 || _dirT.lengthSq() < 1e-8) continue;
      _qWorld.setFromUnitVectors(_dirE.normalize(), _dirT.normalize());
      // ワールド回転をボーンローカルへ(親のワールド回転で挟む)
      if (bone.parent) bone.parent.getWorldQuaternion(_parentQ);
      else _parentQ.identity();
      _qLocal.copy(_parentQ).invert().multiply(_qWorld).multiply(_parentQ);
      bone.quaternion.premultiply(_qLocal);
      bone.updateWorldMatrix(false, true); // 子孫(足)のワールドを更新
    }
  }
}

/**
 * 現在時刻 tc の姿勢(評価済み)に対して接地ロックを適用する。
 * evalPoseAt: クリップを任意時刻の姿勢にする関数(アンカー採取に使用。呼び出し後は
 * 必ず tc の姿勢へ戻してから戻り、以降のIKは現在姿勢に対して行う)
 */
export function applyFootIK(
  state: FootIKState,
  plants: PlantSpan[] | undefined,
  tc: number,
  root: Object3D,
  evalPoseAt: (t: number) => void,
): void {
  if (!plants || plants.length === 0) return;
  // 現在時刻に有効なスパン(足ごとに高々1つ)
  const active: { idx: number; span: PlantSpan; chain: FootChain }[] = [];
  for (let i = 0; i < plants.length; i++) {
    const span = plants[i];
    if (tc < span.start - 1e-4 || tc > span.end + 1e-4) continue;
    const chain = state.chains[span.side];
    if (chain) active.push({ idx: i, span, chain });
  }
  if (active.length === 0) return;

  // 未採取のアンカーを先にまとめて採取し、姿勢を現在時刻へ戻す
  let disturbed = false;
  for (const a of active) {
    if (state.anchors.has(a.idx)) continue;
    evalPoseAt(a.span.start);
    root.updateWorldMatrix(true, true);
    a.chain.foot.getWorldPosition(_cur);
    state.anchors.set(a.idx, root.worldToLocal(_cur.clone()));
    disturbed = true;
  }
  if (disturbed) {
    evalPoseAt(tc);
    root.updateWorldMatrix(true, true);
  }

  for (const a of active) {
    const anchor = state.anchors.get(a.idx);
    if (!anchor) continue;
    // 入り/抜きブレンド: 現在の足位置→アンカーへ重み分だけ寄せた点を目標にする
    const wIn = Math.min(1, Math.max(0, (tc - a.span.start) / BLEND));
    const wOut = Math.min(1, Math.max(0, (a.span.end - tc) / BLEND));
    const s0 = Math.min(wIn, wOut);
    const weight = s0 * s0 * (3 - 2 * s0);
    if (weight <= 1e-3) continue;
    const target = root.localToWorld(anchor.clone());
    a.chain.foot.getWorldPosition(_cur);
    target.lerp(_cur, 1 - weight);
    solveTwoBoneCCD(a.chain, target);
  }
}
