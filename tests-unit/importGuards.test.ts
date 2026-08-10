/**
 * モーション取り込みガードの単体テスト。
 *
 * 検証対象は取り込み口の決定論の核だけ:
 *   1. その場再生クリップを誤検出しないこと(sway を移動と誤らない)
 *   2. 移動成分入りクリップを検出し、Y を壊さずに XZ だけ固定できること
 *   3. 閾値未満の微小移動は変換しないこと
 *   4. 単位系違い(cm系)を10の冪で補正できること / 正常身長は補正しないこと
 *   5. 位置トラックが無いクリップでクラッシュしないこと
 *
 * ローダ(FBX/GLB)と Box3 の実測は jsdom で回せないため、AnimationClip を
 * 合成データで直接組んで純関数だけを対象にする。実ファイルでの挙動は実機未検証。
 */
import { AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";

import {
  convertClipInPlace,
  estimateScaleCorrection,
  findRootPositionTrack,
  isNonInPlace,
  measureRootMotion,
} from "../src/lib/scene3d/importGuards";

/**
 * 腰の位置トラックを持つクリップを合成する。
 * 単位はメートル(scaleToMeters=1 で使う想定)。keyCount 個のキーを等間隔に置き、
 * XZ は forwardMeters まで直線的に前進、Y は上下に揺れる(歩行の重心上下の模擬)。
 */
function makeClip(opts: {
  forwardMeters: number;
  keyCount?: number;
  swayMeters?: number;
  trackName?: string;
}): AnimationClip {
  const { forwardMeters, keyCount = 5, swayMeters = 0, trackName = "mixamorigHips.position" } = opts;
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < keyCount; k++) {
    const t = k / (keyCount - 1);
    times.push(t);
    // X: 左右の sway(その場足踏みでも腰は揺れる) / Z: 前進 / Y: 重心の上下
    values.push(
      Math.sin(t * Math.PI * 2) * swayMeters,
      1.0 + Math.sin(t * Math.PI * 4) * 0.03,
      t * forwardMeters,
    );
  }
  return new AnimationClip("test", 1, [new VectorKeyframeTrack(trackName, times, values)]);
}

/** i番目のキーの [x,y,z] を取り出す */
function keyAt(clip: AnimationClip, trackIndex: number, i: number): [number, number, number] {
  const v = clip.tracks[trackIndex].values;
  return [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
}

describe("findRootPositionTrack / measureRootMotion", () => {
  it("その場再生クリップ(XZ固定+Y上下)は移動と判定しない", () => {
    const clip = makeClip({ forwardMeters: 0, swayMeters: 0.05 });
    const idx = findRootPositionTrack(clip);
    expect(idx).toBe(0);

    const motion = measureRootMotion(clip, idx as number, 1);
    expect(motion.netXZ).toBeLessThan(0.25);
    expect(motion.maxXZ).toBeLessThan(0.5);
    expect(isNonInPlace(motion)).toBe(false);
  });

  it("前進2mクリップは検出し、変換後は netXZ≒0 かつ Y トラック値は不変", () => {
    const clip = makeClip({ forwardMeters: 2 });
    const idx = findRootPositionTrack(clip) as number;
    expect(idx).not.toBeNull();

    const before = measureRootMotion(clip, idx, 1);
    expect(before.netXZ).toBeCloseTo(2, 5);
    expect(isNonInPlace(before)).toBe(true);

    const converted = convertClipInPlace(clip, idx);
    const after = measureRootMotion(converted, idx, 1);
    expect(after.netXZ).toBeCloseTo(0, 6);
    expect(after.maxXZ).toBeCloseTo(0, 6);
    expect(isNonInPlace(after)).toBe(false);

    // Y(重心の上下)は保持される
    const keyCount = clip.tracks[idx].values.length / 3;
    for (let k = 0; k < keyCount; k++) {
      expect(keyAt(converted, idx, k)[1]).toBe(keyAt(clip, idx, k)[1]);
    }
    // 元のクリップは変更しない(immutability)
    expect(measureRootMotion(clip, idx, 1).netXZ).toBeCloseTo(2, 5);
  });

  it("netXZ 0.2m は閾値未満なので変換しない", () => {
    const clip = makeClip({ forwardMeters: 0.2 });
    const idx = findRootPositionTrack(clip) as number;
    const motion = measureRootMotion(clip, idx, 1);
    expect(motion.netXZ).toBeCloseTo(0.2, 5);
    expect(motion.maxXZ).toBeLessThan(0.5);
    expect(isNonInPlace(motion)).toBe(false);
  });

  it("位置トラックが無いクリップは null を返す(クラッシュしない)", () => {
    const clip = new AnimationClip("rot-only", 1, [
      new QuaternionKeyframeTrack("mixamorigHips.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(findRootPositionTrack(clip)).toBeNull();
  });
});

describe("estimateScaleCorrection", () => {
  it("cm系モデル相当(高さ170)は factor 0.01 に補正する", () => {
    const correction = estimateScaleCorrection(170);
    expect(correction).not.toBeNull();
    expect(correction?.factor).toBeCloseTo(0.01, 10);
    expect(170 * (correction as { factor: number }).factor).toBeCloseTo(1.7, 10);
  });

  it("正常身長1.8mは補正しない(null)", () => {
    expect(estimateScaleCorrection(1.8)).toBeNull();
  });

  // 表記は factor の符号と対応していること(exp の符号を取り違えると
  // cm系巨人に「m換算」、極小モデルに「cm→m」が出る)
  it("factor 0.01(cm系)の表記は cm→m", () => {
    const correction = estimateScaleCorrection(170);
    expect(correction?.factor).toBeCloseTo(0.01, 10);
    expect(correction?.label).toBe("cm→m");
  });

  it("factor 0.001(mm系)の表記は mm→m", () => {
    const correction = estimateScaleCorrection(1700);
    expect(correction?.factor).toBeCloseTo(0.001, 10);
    expect(correction?.label).toBe("mm→m");
  });

  it("factor 100(極小モデル)の表記は m換算", () => {
    const correction = estimateScaleCorrection(0.017);
    expect(correction?.factor).toBeCloseTo(100, 10);
    expect(correction?.label).toBe("m換算");
  });
});
