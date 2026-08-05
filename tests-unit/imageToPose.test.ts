/**
 * 画像→ポーズ(Slice B)の単体テスト。
 *
 * 検証対象は決定論の核だけ:
 *   1. 2フレーム複製で静止 spec が組めること(solveFramesToSpec の「2枚以上必要」制約を
 *      決定論的に回避できている)
 *   2. 検出失敗(33点未満 / visibility 平均が閾値未満)で **null を正直に返す** こと
 *
 * MediaPipe 本体(WASM)・Tauri の convertFileSrc は jsdom で動かないため、
 * ランドマーク配列を直接受ける `buildStaticSpecFromLandmarks` を対象にする。
 * 実画像での MediaPipe 検出精度は **実機未検証**(このテストの範囲外)。
 */
import { describe, expect, it } from "vitest";

import { buildStaticSpecFromLandmarks } from "../src/lib/scene3d/imageToPose";

type Landmark = { x: number; y: number; z: number; visibility?: number };

/**
 * MediaPipe Pose world landmarks 33点の直立フィクスチャ。
 * 腰中央が原点・単位メートル・**y は画像流儀で下向き正**(poseSolver.ts:17-18)。
 * 身長 1.7m 相当のTポーズ寄りの直立で、実測値ではなく「解ければよい」幾何値。
 */
function standingLandmarks(visibility = 0.95): Landmark[] {
  const v = visibility;
  const pt = (x: number, y: number, z: number): Landmark => ({ x, y, z, visibility: v });
  const lm: Landmark[] = [];
  // 0-10: 顔まわり(頭部は腰から約0.6m上 = y負)
  lm[0] = pt(0, -0.62, 0.05); // nose
  lm[1] = pt(-0.03, -0.65, 0.04);
  lm[2] = pt(-0.04, -0.65, 0.04);
  lm[3] = pt(-0.05, -0.65, 0.04);
  lm[4] = pt(0.03, -0.65, 0.04);
  lm[5] = pt(0.04, -0.65, 0.04);
  lm[6] = pt(0.05, -0.65, 0.04);
  lm[7] = pt(-0.08, -0.63, 0); // earL
  lm[8] = pt(0.08, -0.63, 0); // earR
  lm[9] = pt(-0.02, -0.58, 0.04);
  lm[10] = pt(0.02, -0.58, 0.04);
  // 11-16: 肩・肘・手首(腕は体側にやや開いた直立)
  lm[11] = pt(-0.18, -0.5, 0); // shoulderL
  lm[12] = pt(0.18, -0.5, 0); // shoulderR
  lm[13] = pt(-0.22, -0.22, 0); // elbowL
  lm[14] = pt(0.22, -0.22, 0); // elbowR
  lm[15] = pt(-0.25, 0.05, 0); // wristL
  lm[16] = pt(0.25, 0.05, 0); // wristR
  // 17-22: 手先
  lm[17] = pt(-0.27, 0.1, 0);
  lm[18] = pt(0.27, 0.1, 0);
  lm[19] = pt(-0.26, 0.12, 0);
  lm[20] = pt(0.26, 0.12, 0);
  lm[21] = pt(-0.25, 0.09, 0);
  lm[22] = pt(0.25, 0.09, 0);
  // 23-32: 腰・膝・足首・かかと・つま先
  lm[23] = pt(-0.1, 0, 0); // hipL
  lm[24] = pt(0.1, 0, 0); // hipR
  lm[25] = pt(-0.1, 0.42, 0); // kneeL
  lm[26] = pt(0.1, 0.42, 0); // kneeR
  lm[27] = pt(-0.1, 0.84, 0); // ankleL
  lm[28] = pt(0.1, 0.84, 0); // ankleR
  lm[29] = pt(-0.1, 0.88, -0.04); // heelL
  lm[30] = pt(0.1, 0.88, -0.04); // heelR
  lm[31] = pt(-0.1, 0.86, 0.12); // footL(つま先)
  lm[32] = pt(0.1, 0.86, 0.12); // footR
  return lm;
}

describe("buildStaticSpecFromLandmarks", () => {
  it("33点の直立ランドマークから静止 spec を作る(2フレーム複製が効いている)", () => {
    const spec = buildStaticSpecFromLandmarks(standingLandmarks(), "テストポーズ");

    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec.name).toBe("テストポーズ");
    // 取り込みは Y Bot(Mixamo規格)で再生する
    expect(spec.rig).toBe("mixamo");
    // 1枚絵なので繰り返さない・その場(前進しない)
    expect(spec.loop).toBe(false);
    expect(spec.moveSpeed).toBe(0);
    // 複製した2フレームぶんのキーフレームが出る(1枚に減らすと solve が throw する)
    expect(spec.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(spec.keyframes[0].time).toBe(0);
    expect(Object.keys(spec.keyframes[0].bones).length).toBeGreaterThan(0);
    // ボーン名は Mixamo 規格
    expect(Object.keys(spec.keyframes[0].bones).every((b) => b.startsWith("mixamorig:"))).toBe(true);
  });

  it("同一ランドマークの複製なので動きゼロ(全フレームで同じ関節角)になる", () => {
    const spec = buildStaticSpecFromLandmarks(standingLandmarks(), "静止");
    expect(spec).not.toBeNull();
    if (!spec) return;

    const first = spec.keyframes[0].bones;
    for (const kf of spec.keyframes.slice(1)) {
      for (const [bone, angles] of Object.entries(first)) {
        const other = kf.bones[bone];
        expect(other).toBeDefined();
        if (!other) continue;
        for (let i = 0; i < 3; i++) {
          // 同一入力なので平滑化を通しても角度は一致する(浮動小数の誤差のみ許容)
          expect(Math.abs(other[i] - angles[i])).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("landmarks が undefined なら null(検出そのものが失敗)", () => {
    expect(buildStaticSpecFromLandmarks(undefined, "なし")).toBeNull();
  });

  it("33点未満なら null(人物を捉えていない)", () => {
    const partial = standingLandmarks().slice(0, 20);
    expect(buildStaticSpecFromLandmarks(partial, "部分")).toBeNull();
  });

  it("visibility 平均が 0.5 未満なら null(黙って劣化した spec を作らない)", () => {
    expect(buildStaticSpecFromLandmarks(standingLandmarks(0.3), "低信頼")).toBeNull();
  });

  it("visibility が全て未定義でも null(欠落を「見えている」と読み替えない)", () => {
    const noVis = standingLandmarks().map(({ x, y, z }) => ({ x, y, z }));
    expect(buildStaticSpecFromLandmarks(noVis, "visibility無し")).toBeNull();
  });

  it("visibility 平均が閾値ちょうど(0.5)なら採用する", () => {
    const spec = buildStaticSpecFromLandmarks(standingLandmarks(0.5), "境界");
    expect(spec).not.toBeNull();
  });
});

/**
 * 欠測ボーンの埋め(2026-08-05)。
 *
 * 1枚絵は同一フレームを2枚に複製するため、poseSolver の「前後の実測から補間」が
 * 構造的に効かない(前後とも同じ = 欠測なら両方欠測)。埋めないとその部位だけ
 * Y Bot のレスト = **Tポーズ**で残る(実データで右腕だけ/両脚だけTポーズが発生)。
 */
describe("欠測ボーンの埋め(静止画1枚の穴)", () => {
  /** 指定 landmark だけ visibility を落とす(その部位を poseSolver に欠測扱いさせる) */
  function hide(lm: Landmark[], indices: number[]): Landmark[] {
    const out = lm.map((l) => ({ ...l }));
    for (const i of indices) out[i] = { ...out[i], visibility: 0.05 };
    return out;
  }
  // poseSolver は 肩/肘/手首 の visibility 平均が MIN_VIS(0.5)未満で腕を欠測にする
  const RIGHT_ARM = [12, 14, 16];
  const BOTH_LEGS = [23, 24, 25, 26, 27, 28];

  it("右腕が見えていなくても、右腕ボーンが spec に書かれる(Tポーズで残らない)", () => {
    const spec = buildStaticSpecFromLandmarks(hide(standingLandmarks(), RIGHT_ARM), "右腕欠測");
    expect(spec).not.toBeNull();
    if (!spec) return;

    for (const kf of spec.keyframes) {
      // 埋め処理を外すとこれらのキーが存在せず undefined になる(牙の実証済み)
      expect(kf.bones["mixamorig:RightArm"]).toBeDefined();
      expect(kf.bones["mixamorig:RightForeArm"]).toBeDefined();
      expect(kf.bones["mixamorig:RightShoulder"]).toBeDefined();
    }
    // 埋め値は自然な立ち(腕を下ろす)。Tポーズ(0,0,0)ではない
    // ＝ここが 0 だと「片腕だけ真横に突き出た人」になる
    expect(spec.keyframes[0].bones["mixamorig:RightArm"][0]).toBeGreaterThan(60);
  });

  it("両脚が見えていなくても、脚ボーンが spec に書かれる", () => {
    const spec = buildStaticSpecFromLandmarks(hide(standingLandmarks(), BOTH_LEGS), "両脚欠測");
    expect(spec).not.toBeNull();
    if (!spec) return;

    for (const bone of [
      "mixamorig:LeftUpLeg",
      "mixamorig:LeftLeg",
      "mixamorig:LeftFoot",
      "mixamorig:RightUpLeg",
      "mixamorig:RightLeg",
      "mixamorig:RightFoot",
    ]) {
      expect(spec.keyframes[0].bones[bone]).toBeDefined();
    }
  });

  it("欠測があってもボーンは常に22本すべて書き切られる(レスト落ちの穴を残さない)", () => {
    for (const hidden of [[], RIGHT_ARM, BOTH_LEGS, [...RIGHT_ARM, ...BOTH_LEGS]]) {
      const spec = buildStaticSpecFromLandmarks(hide(standingLandmarks(), hidden), "網羅");
      expect(spec).not.toBeNull();
      if (!spec) continue;
      for (const kf of spec.keyframes) {
        expect(Object.keys(kf.bones).length).toBe(22);
      }
    }
  });

  it("埋めた部位が estimatedParts に記録される(黙って埋めない)", () => {
    const spec = buildStaticSpecFromLandmarks(hide(standingLandmarks(), RIGHT_ARM), "告知");
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec.estimatedParts).toContain("右腕");
    // 見えている左腕は推定扱いにしない(過剰申告で告知が信用されなくなる)
    expect(spec.estimatedParts).not.toContain("左腕");
  });

  it("両脚欠測なら左脚・右脚の両方が記録される", () => {
    const spec = buildStaticSpecFromLandmarks(hide(standingLandmarks(), BOTH_LEGS), "両脚告知");
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec.estimatedParts).toContain("左脚");
    expect(spec.estimatedParts).toContain("右脚");
  });

  it("全身が見えていれば estimatedParts は付かない(埋めていないのに告知しない)", () => {
    const spec = buildStaticSpecFromLandmarks(standingLandmarks(), "全身検出");
    expect(spec).not.toBeNull();
    if (!spec) return;
    expect(spec.estimatedParts).toBeUndefined();
  });
});
