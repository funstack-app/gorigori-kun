/**
 * モーション取り込み口のガード(純関数のみ・副作用なし)。
 *
 * エンジンは全クリップを「その場再生(ルートモーションなし)」とみなす(clipSpeed.ts)。
 * 移動は followPath がパス側で与えるため、移動成分入りのクリップ(Mixamo非In Place版等)を
 * そのまま取り込むと「クリップ内前進 + パス移動」の二重移動になり、ループ境界でワープする。
 * またスケールは FBX=0.01 / GLB=1 の固定係数しか無く、cm系GLBを入れると巨人になる。
 *
 * ここは検出と補正の計算だけを持ち、登録・通知は importMotionFiles 側の責務。
 */

import type { AnimationClip } from "three";

/**
 * 非in-place判定のしきい値(メートル)。
 * 歩幅の揺れ・体重移動のsway(その場足踏みでも腰は数cm〜十数cm動く)を
 * 誤検出しないための余白として、正味変位25cm / 最大偏差50cm を採る。
 */
const NET_XZ_THRESHOLD_M = 0.25;
const MAX_XZ_THRESHOLD_M = 0.5;

/** 人体として妥当な身長レンジ(メートル)。この外は単位系違いを疑う */
const MIN_HEIGHT_M = 0.5;
const MAX_HEIGHT_M = 3.0;
/** 補正の目標身長(メートル)。10の冪で最も近づける先 */
const TARGET_HEIGHT_M = 1.7;
/** 補正の指数レンジ(10^-3 〜 10^3)。単位間違いは常に10の冪なのでこの形しか使わない */
const MIN_EXP = -3;
const MAX_EXP = 3;
/** これ未満は測定不能(骨のみFBX等でバウンディングボックスが潰れている) */
const UNMEASURABLE_HEIGHT_M = 0.01;

/** ルートに相当するボーン名。Mixamo/Godot/Blender系で共通して使われる */
const ROOT_BONE_RE = /hips|root|pelvis/i;

/** トラックが位置トラック(`.position`)かどうか */
function isPositionTrack(track: { name: string }): boolean {
  return track.name.endsWith(".position");
}

/** i番目のキーの水平距離(XZ平面)を初回キーから測る。values は [x,y,z,...] 並び */
function horizontalDistanceFromFirst(values: ArrayLike<number>, i: number): number {
  const dx = values[i * 3] - values[0];
  const dz = values[i * 3 + 2] - values[2];
  return Math.hypot(dx, dz);
}

/**
 * ルートの位置トラックのインデックスを返す。
 * ルート名にマッチするものを優先し、無ければXZ水平変位が最大の位置トラックを採る。
 * 位置トラックが1つも無ければ null。
 */
export function findRootPositionTrack(clip: AnimationClip): number | null {
  const positionIndices: number[] = [];
  for (let i = 0; i < clip.tracks.length; i++) {
    const track = clip.tracks[i];
    if (!isPositionTrack(track)) continue;
    if (ROOT_BONE_RE.test(track.name)) return i;
    positionIndices.push(i);
  }
  if (positionIndices.length === 0) return null;

  let bestIndex = positionIndices[0];
  let bestSpan = -1;
  for (const i of positionIndices) {
    const values = clip.tracks[i].values;
    const keyCount = Math.floor(values.length / 3);
    let span = 0;
    for (let k = 1; k < keyCount; k++) {
      span = Math.max(span, horizontalDistanceFromFirst(values, k));
    }
    if (span > bestSpan) {
      bestSpan = span;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * ルートの水平移動量を測る(メートル)。
 * netXZ = 最終キーと初回キーの水平距離 / maxXZ = 初回キーからの最大水平偏差。
 */
export function measureRootMotion(
  clip: AnimationClip,
  trackIndex: number,
  scaleToMeters: number,
): { netXZ: number; maxXZ: number } {
  const track = clip.tracks[trackIndex];
  if (!track) return { netXZ: 0, maxXZ: 0 };
  const values = track.values;
  const keyCount = Math.floor(values.length / 3);
  if (keyCount < 2) return { netXZ: 0, maxXZ: 0 };

  let maxXZ = 0;
  for (let k = 1; k < keyCount; k++) {
    maxXZ = Math.max(maxXZ, horizontalDistanceFromFirst(values, k));
  }
  const netXZ = horizontalDistanceFromFirst(values, keyCount - 1);
  return { netXZ: netXZ * scaleToMeters, maxXZ: maxXZ * scaleToMeters };
}

/** 測定結果が「移動しながらのアニメーション」かどうか */
export function isNonInPlace(motion: { netXZ: number; maxXZ: number }): boolean {
  return motion.netXZ > NET_XZ_THRESHOLD_M || motion.maxXZ > MAX_XZ_THRESHOLD_M;
}

/**
 * 該当トラックの全キーの X/Z を初回キー値に固定した複製を返す(Y は保持)。
 * 引数の clip は変更しない。
 */
export function convertClipInPlace(clip: AnimationClip, trackIndex: number): AnimationClip {
  const converted = clip.clone();
  const track = converted.tracks[trackIndex];
  if (!track) return converted;
  const values = track.values;
  const keyCount = Math.floor(values.length / 3);
  const baseX = values[0];
  const baseZ = values[2];
  for (let k = 1; k < keyCount; k++) {
    values[k * 3] = baseX;
    values[k * 3 + 2] = baseZ;
  }
  return converted;
}

/**
 * 補正係数の指数から推定単位の表記を作る。専門用語は出さず「元の単位→m」の形で示す。
 * factor = 10^exp なので、cm系(100倍で大きい)を縮める補正は exp = -2 になる。
 */
function scaleLabel(exp: number): string {
  if (exp === -2) return "cm→m";
  if (exp === -3) return "mm→m";
  return "m換算";
}

/**
 * 身長(メートル)から10の冪の補正係数を推定する。
 * 正常範囲内なら null(補正不要)。10の冪で正常範囲に入れられない場合も null(補正不能)。
 */
export function estimateScaleCorrection(
  heightMeters: number,
): { factor: number; label: string } | null {
  if (!Number.isFinite(heightMeters) || heightMeters <= 0) return null;
  if (heightMeters >= MIN_HEIGHT_M && heightMeters <= MAX_HEIGHT_M) return null;

  const raw = Math.round(Math.log10(TARGET_HEIGHT_M / heightMeters));
  const exp = Math.min(MAX_EXP, Math.max(MIN_EXP, raw));
  const factor = 10 ** exp;
  const corrected = heightMeters * factor;
  if (corrected < MIN_HEIGHT_M || corrected > MAX_HEIGHT_M) return null;
  return { factor, label: scaleLabel(exp) };
}

/** 高さが測定不能(骨のみFBX等)か。サイズ検証をスキップする判定に使う */
export function isUnmeasurableHeight(heightMeters: number): boolean {
  return !Number.isFinite(heightMeters) || heightMeters < UNMEASURABLE_HEIGHT_M;
}

/** 身長が人体として妥当な範囲を外れているか(補正の要否・補正不能warningの判定に使う) */
export function isHeightOutOfRange(heightMeters: number): boolean {
  return heightMeters < MIN_HEIGHT_M || heightMeters > MAX_HEIGHT_M;
}
