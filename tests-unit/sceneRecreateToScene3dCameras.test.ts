import { describe, expect, it } from "vitest";

import { shotToCameraSpec } from "../src/lib/sceneRecreate/toScene3dCameras";
import type {
  CameraAngle,
  CameraWork,
  ShotAnalysis,
  ShotSize,
} from "../src/lib/sceneRecreate/types";

const SHOT_SIZES: ShotSize[] = [
  "extreme-close-up",
  "close-up",
  "medium",
  "long",
  "extreme-long",
  "unknown",
];
const CAMERA_ANGLES: CameraAngle[] = [
  "eye-level",
  "high-angle",
  "low-angle",
  "birds-eye",
  "dutch",
  "unknown",
];
const CAMERA_WORKS: CameraWork[] = [
  "fixed",
  "pan",
  "tilt",
  "dolly",
  "zoom",
  "handheld",
  "crane",
  "unknown",
];

function makeShot(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    shotNumber: 1,
    shotSize: "medium",
    angle: "eye-level",
    cameraWork: "fixed",
    subjectMotion: "",
    cutMotivation: "",
    directorialIntent: "",
    ...overrides,
  };
}

describe("shotToCameraSpec", () => {
  it("全 enum 値の組み合わせを例外なく有限のカメラ配置へ変換する", () => {
    for (const shotSize of SHOT_SIZES) {
      for (const angle of CAMERA_ANGLES) {
        for (const cameraWork of CAMERA_WORKS) {
          const spec = shotToCameraSpec(makeShot({ shotSize, angle, cameraWork }));
          expect(spec.label).toMatch(/^S1 /);
          expect(spec.preset).toBeTruthy();
          expect(spec.lensMm).toBeGreaterThan(0);
          expect([...spec.startPos, ...spec.endPos, ...spec.lookAtPos].every(Number.isFinite)).toBe(
            true,
          );
        }
      }
    }
  });

  it.each([
    ["fixed", "fixed"],
    ["pan", "pan"],
    ["tilt", "crane"],
    ["dolly", "pushIn"],
    ["zoom", "pushIn"],
    ["handheld", "handheld"],
    ["crane", "crane"],
    ["unknown", "fixed"],
  ] as const)("cameraWork=%s を preset=%s へ写す", (cameraWork, expected) => {
    expect(shotToCameraSpec(makeShot({ cameraWork })).preset).toBe(expected);
  });

  it.each([
    ["extreme-close-up", 85, 1.2],
    ["close-up", 65, 2],
    ["medium", 50, 3.5],
    ["long", 35, 6],
    ["extreme-long", 24, 10],
    ["unknown", 50, 3.5],
  ] as const)("shotSize=%s を %imm・距離%im へ写す", (shotSize, lensMm, distanceM) => {
    const spec = shotToCameraSpec(makeShot({ shotSize, cameraWork: "fixed" }));
    expect(spec.lensMm).toBe(lensMm);
    expect(spec.startPos).toEqual([0, 1.5, distanceM]);
  });

  it.each([
    ["eye-level", 1.5],
    ["high-angle", 3.5],
    ["low-angle", 0.6],
    ["dutch", 1.5],
    ["unknown", 1.5],
  ] as const)("angle=%s のカメラ高さを %im にする", (angle, heightM) => {
    expect(shotToCameraSpec(makeShot({ angle })).startPos[1]).toBe(heightM);
  });

  it("真俯瞰は被写体の真上に置き、ダッチは手動調整をラベルで知らせる", () => {
    const birdsEye = shotToCameraSpec(makeShot({ angle: "birds-eye" }));
    expect(birdsEye.startPos).toEqual([0, 3.5, 0.01]);
    expect(birdsEye.lookAtPos).toEqual([0, 0, 0]);

    const dutch = shotToCameraSpec(makeShot({ angle: "dutch" }));
    expect(dutch.label).toContain("ダッチ(傾き)（傾きは手動）");
  });

  it("型の外から未知値が来ても fixed・eye-level・medium 相当に戻す", () => {
    const unknownShot = makeShot({
      cameraWork: "future-work" as CameraWork,
      shotSize: "future-size" as ShotSize,
      angle: "future-angle" as CameraAngle,
    });
    const spec = shotToCameraSpec(unknownShot);

    expect(spec.preset).toBe("fixed");
    expect(spec.lensMm).toBe(50);
    expect(spec.startPos).toEqual([0, 1.5, 3.5]);
    expect(spec.endPos).toEqual(spec.startPos);
    expect(spec.lookAtPos).toEqual([0, 1.5, 0]);
  });
});
