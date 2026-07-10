#!/usr/bin/env node
/**
 * scene3d 決定性チェック
 *
 * evaluateCamera が「同一入力 → 同一出力」であることを機械検証する。
 * 使い方: node scripts/scene3d-determinism-check.cjs <コンパイル済みscene3dディレクトリ>
 * (tsc --module commonjs で src/lib/scene3d をコンパイルした出力を指す)
 *
 * 検査の牙の実証: --self-test で「わざと壊した入力」を比較し、
 * 差分検出が本当に落ちることを確認できる。
 */
const path = require("path");

const libDir = process.argv[2];
if (!libDir) {
  console.error("usage: node scene3d-determinism-check.cjs <compiled scene3d dir> [--self-test]");
  process.exit(2);
}

const { createDefaultProject } = require(path.resolve(libDir, "types.js"));
const { evaluateCamera } = require(path.resolve(libDir, "evaluateScene.js"));

function snapshot(project) {
  const frames = [];
  for (let f = 0; f < project.durationFrames; f++) {
    frames.push(evaluateCamera(project, f));
  }
  return JSON.stringify(frames);
}

const project = createDefaultProject();
const run1 = snapshot(project);
const run2 = snapshot(project);

if (run1 !== run2) {
  console.error("NG: 同一入力で出力が一致しない(決定性違反)");
  process.exit(1);
}

// カメラが実際に動いていること(全フレーム同一なら評価器が死んでいる)
const first = JSON.stringify(evaluateCamera(project, 0));
const last = JSON.stringify(evaluateCamera(project, project.durationFrames - 1));
if (first === last) {
  console.error("NG: orbit プリセットなのに開始と終了のカメラ姿勢が同一(評価器が機能していない)");
  process.exit(1);
}

if (process.argv.includes("--self-test")) {
  // 検査の牙: わざと入力を変えて差分が検出されることを実証する
  const broken = createDefaultProject();
  broken.camera.orbitDegrees = broken.camera.orbitDegrees + 1;
  if (snapshot(broken) === run1) {
    console.error("NG: self-test 失敗(入力を変えても出力が同じ=比較が機能していない)");
    process.exit(1);
  }
  console.log("self-test OK: 壊した入力で差分を検出できた");
}

console.log(
  `OK: ${project.durationFrames}フレーム x 2回評価が完全一致 / frame0とframe${project.durationFrames - 1}は異なる姿勢`,
);
