#!/usr/bin/env node
/**
 * poseSolver 接地補正チェック
 *
 * hipsY(骨盤の上下)が接地関節の切り替わり(足首→手首/膝)に追従することを機械検証する。
 * 逆立ち・床技で骨盤が -0.4 に張り付いて沈む退行(2026-07-21 PoC で実測した弱点)を検出する。
 *
 * 使い方: node scripts/pose-grounding-check.cjs <コンパイル済み videoCapture ディレクトリ>
 * (npx tsc --module commonjs で src/lib/scene3d/videoCapture をコンパイルした出力を指す)
 */
const path = require("path");

const libDir = process.argv[2];
if (!libDir) {
  console.error("usage: node pose-grounding-check.cjs <compiled videoCapture dir>");
  process.exit(2);
}
const { solveFramesToSpec } = require(path.resolve(libDir, "poseSolver.js"));

/** 33点ランドマークの雛形(全点 visibility=0.9) */
function makeLandmarks(map) {
  const lms = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
  for (const [i, [x, y, z]] of Object.entries(map)) {
    lms[Number(i)] = { x, y, z, visibility: 0.9 };
  }
  return lms;
}

// MediaPipe world 流儀: 腰中央が原点近傍・y は下向き正(メートル)
// 立ち: 足が最下端(腰から+0.90)
const STANDING = {
  0: [0, -0.65, -0.08], 7: [0.06, -0.62, 0.02], 8: [-0.06, -0.62, 0.02],
  11: [0.17, -0.5, 0], 12: [-0.17, -0.5, 0],
  13: [0.21, -0.22, 0.02], 14: [-0.21, -0.22, 0.02],
  15: [0.22, 0.03, 0.04], 16: [-0.22, 0.03, 0.04],
  23: [0.09, 0, 0], 24: [-0.09, 0, 0],
  25: [0.1, 0.45, 0.02], 26: [-0.1, 0.45, 0.02],
  27: [0.1, 0.85, 0.04], 28: [-0.1, 0.85, 0.04],
  29: [0.1, 0.88, 0.08], 30: [-0.1, 0.88, 0.08],
  31: [0.1, 0.9, -0.06], 32: [-0.1, 0.9, -0.06],
};
// 深いしゃがみ: 足首が腰から+0.50 まで縮む(沈み込みは維持されるべき)
const CROUCH = {
  ...STANDING,
  25: [0.14, 0.12, -0.25], 26: [-0.14, 0.12, -0.25],
  27: [0.1, 0.5, 0.02], 28: [-0.1, 0.5, 0.02],
  29: [0.1, 0.52, 0.06], 30: [-0.1, 0.52, 0.06],
  31: [0.1, 0.53, -0.08], 32: [-0.1, 0.53, -0.08],
};
// 逆立ち: 手首が接地(腰から+0.90)・足は頭上(-0.90)。骨盤は立ち相当の高さに留まるべき
const HANDSTAND = {
  0: [0, 0.62, -0.08], 7: [0.06, 0.6, 0.02], 8: [-0.06, 0.6, 0.02],
  11: [0.17, 0.5, 0], 12: [-0.17, 0.5, 0],
  13: [0.19, 0.7, 0.02], 14: [-0.19, 0.7, 0.02],
  15: [0.2, 0.9, 0.04], 16: [-0.2, 0.9, 0.04],
  23: [0.09, 0, 0], 24: [-0.09, 0, 0],
  25: [0.1, -0.45, 0.02], 26: [-0.1, -0.45, 0.02],
  27: [0.1, -0.85, 0.04], 28: [-0.1, -0.85, 0.04],
  29: [0.1, -0.88, 0.08], 30: [-0.1, -0.88, 0.08],
  31: [0.1, -0.9, -0.06], 32: [-0.1, -0.9, -0.06],
};

function seq(...poses) {
  return poses.map((m, i) => ({ time: i * 0.1, landmarks: makeLandmarks(m) }));
}

// 立ち→しゃがみ→逆立ち のシーケンスで hipsY を観察。
// 各姿勢3フレーム以上(平滑化窓=3が姿勢の中間フレームに他姿勢を混ぜないため。実映像相当の条件)
const spec = solveFramesToSpec(
  seq(
    STANDING, STANDING, STANDING,
    CROUCH, CROUCH, CROUCH,
    HANDSTAND, HANDSTAND, HANDSTAND, HANDSTAND,
  ),
  "grounding-check",
);
const hipsY = spec.keyframes.map((k) => k.hipsY);
const fmt = hipsY.map((v) => v.toFixed(2)).join(", ");
console.log(`hipsY: [${fmt}]`);

let failed = 0;
function check(label, cond, actual) {
  if (cond) {
    console.log(`  OK  ${label}`);
  } else {
    console.error(`  NG  ${label} (actual: ${actual})`);
    failed++;
  }
}

check("立ち: hipsY ≈ 0", Math.abs(hipsY[1]) <= 0.05, hipsY[1]);
check("しゃがみ: hipsY ≤ -0.25 (沈み込みは維持)", hipsY[4] <= -0.25, hipsY[4]);
check("逆立ち: hipsY ≥ -0.15 (手首接地で骨盤は沈まない)", hipsY[9] >= -0.15, hipsY[9]);

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log("ALL OK");
