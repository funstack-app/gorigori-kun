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

const { createDefaultProject, createDefaultShot } = require(path.resolve(libDir, "types.js"));
const { evaluateCamera, totalDurationFrames, locateShot } = require(
  path.resolve(libDir, "evaluateScene.js"),
);

function snapshot(project) {
  const frames = [];
  const total = totalDurationFrames(project);
  for (let f = 0; f < total; f++) {
    frames.push(evaluateCamera(project, f));
  }
  return JSON.stringify(frames);
}

// 2カメラ2カット構成で検証(ショット境界の通しフレーム変換も検査対象に含める)
function buildProject() {
  const project = createDefaultProject();
  const camera2 = {
    id: "camera-2",
    label: "カメラ2",
    move: {
      preset: "pushIn",
      targetEntityId: "actor-1",
      startPos: [0, 1.4, 5],
      endPos: [0, 1.3, 1.8],
      orbitDegrees: 0,
      lensMm: 35,
      easing: "easeInOut",
      midPos: null,
    },
  };
  const shot2 = createDefaultShot("shot-2", "カット2", "camera-2");
  return {
    ...project,
    cameras: [...project.cameras, camera2],
    shots: [...project.shots, shot2],
  };
}

const project = buildProject();
const total = totalDurationFrames(project);
const run1 = snapshot(project);
const run2 = snapshot(project);

if (run1 !== run2) {
  console.error("NG: 同一入力で出力が一致しない(決定性違反)");
  process.exit(1);
}

// カメラが実際に動いていること(全フレーム同一なら評価器が死んでいる)
const first = JSON.stringify(evaluateCamera(project, 0));
const last = JSON.stringify(evaluateCamera(project, total - 1));
if (first === last) {
  console.error("NG: 開始と終了のカメラ姿勢が同一(評価器が機能していない)");
  process.exit(1);
}

// ショット境界: 通しフレームが2カット目に正しく着地するか
const boundary = locateShot(project, project.shots[0].durationFrames);
if (boundary.shotIndex !== 1 || boundary.localFrame !== 0) {
  console.error(
    `NG: ショット境界の変換が不正 (shotIndex=${boundary.shotIndex}, localFrame=${boundary.localFrame})`,
  );
  process.exit(1);
}

if (process.argv.includes("--self-test")) {
  // 検査の牙: わざと入力を変えて差分が検出されることを実証する
  const broken = buildProject();
  broken.cameras[0].move.orbitDegrees += 1;
  if (snapshot(broken) === run1) {
    console.error("NG: self-test 失敗(入力を変えても出力が同じ=比較が機能していない)");
    process.exit(1);
  }
  console.log("self-test OK: 壊した入力で差分を検出できた");
}

console.log(
  `OK: 2カット${total}フレーム x 2回評価が完全一致 / ショット境界の変換も正常`,
);
