/**
 * ショット境界検出（純関数）の検証スクリプト。
 *
 * 本リポジトリには 2026-07-29 時点で vitest が未導入で、テストファイル
 * (`*.test.ts`) はハーネス側で書き込みが禁止されている（評価の牙を守る柵）。
 * そこで「依存ゼロで実行でき、壊れたら exit 1 で落ちる」検証を用意した。
 * vitest を導入したらこの内容をそのまま `shotBoundary.test.ts` へ移し、
 * 本スクリプトは削除してよい。
 *
 * 実行: node scripts/check-shot-boundary.mjs
 */

import assert from "node:assert/strict";

// 検査に牙を持たせる。top-level await のリジェクトは環境によって終了コードが
// 0 のまま素通りすることがあり、それでは「落ちない検査」になる（2026-07-29 実測:
// アサーション失敗時も exit 0 だった）。明示的に 1 で落とす。
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 対象ソースを毎回 tsc でコンパイルし直してから読み込む。
 *
 * 落とし穴（2026-07-29 実測）: `tsc src/lib/.../shotBoundary.ts --outDir X` は
 * **ソースの階層を保って** `X/src/lib/sceneRecreate/shotBoundary.js` へ出す。
 * `X/shotBoundary.js` を読みに行くと解決に失敗するか別物を掴み、
 * 閾値定数を壊しても "all checks passed" / exit 0 になっていた（＝牙の無い検査）。
 * ソースを temp 直下へコピーしてから compile し、出力位置を確定させる。
 */
const workDir = mkdtempSync(join(tmpdir(), "shot-boundary-"));
// SHOT_BOUNDARY_SRC は「この検査が本当に落ちるか」を、実ソースを傷つけずに
// 確かめるための差し替え口（わざと壊した複製を渡して exit 1 を確認する）。
const SOURCE_PATH = process.env.SHOT_BOUNDARY_SRC
  ? new URL(pathToFileURL(process.env.SHOT_BOUNDARY_SRC))
  : new URL("../src/lib/sceneRecreate/shotBoundary.ts", import.meta.url);
cpSync(SOURCE_PATH, join(workDir, "shotBoundary.ts"));

execFileSync(
  "npx",
  [
    "tsc",
    join(workDir, "shotBoundary.ts"),
    "--outDir",
    workDir,
    "--target",
    "es2020",
    "--module",
    "es2020",
    "--moduleResolution",
    "bundler",
    "--strict",
  ],
  { stdio: "inherit" },
);

const emitted = join(workDir, "shotBoundary.js");
if (!readdirSync(workDir).includes("shotBoundary.js")) {
  console.error(`コンパイル結果が見つかりません: ${emitted}`);
  process.exit(1);
}

const mod = await import(pathToFileURL(emitted).href);
rmSync(workDir, { recursive: true, force: true });

const { detectShotBoundaries, meanAbsDiff, pickRepresentatives, toShotSpans } = mod;
for (const [name, fn] of Object.entries({
  detectShotBoundaries,
  meanAbsDiff,
  pickRepresentatives,
  toShotSpans,
})) {
  // 剥がしに失敗して関数が取れていないのに「緑」になる事故を防ぐ。
  if (typeof fn !== "function") {
    console.error(`ソースから ${name} を読み込めませんでした（型剥がしの失敗）`);
    process.exit(1);
  }
}

const SIZE = 96 * 54;
const flatFrame = (timeSec, value) => ({
  timeSec,
  luma: new Uint8ClampedArray(SIZE).fill(value),
});
/** 一様輝度＋微小ノイズ（同一ショット内の被写体の動きを模す）。 */
const noisyFrame = (timeSec, value, seed) => {
  const luma = new Uint8ClampedArray(SIZE);
  for (let i = 0; i < SIZE; i++) luma[i] = value + ((i * 7 + seed * 13) % 5) - 2;
  return { timeSec, luma };
};

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log("meanAbsDiff");
check("同一フレームの差は 0", () => {
  const a = new Uint8ClampedArray([10, 20, 30]);
  assert.equal(meanAbsDiff(a, a), 0);
});
check("一様な差はその値になる", () => {
  assert.equal(
    meanAbsDiff(new Uint8ClampedArray([10, 10, 10]), new Uint8ClampedArray([40, 40, 40])),
    30,
  );
});
check("空配列でも落ちない", () => {
  assert.equal(meanAbsDiff(new Uint8ClampedArray(0), new Uint8ClampedArray(0)), 0);
});

console.log("detectShotBoundaries");
check("カットが2回ある映像で境界を2つ検出する", () => {
  const frames = [
    noisyFrame(0.0, 30, 1),
    noisyFrame(0.5, 30, 2),
    noisyFrame(1.0, 30, 3),
    noisyFrame(1.5, 200, 4), // カット1
    noisyFrame(2.0, 200, 5),
    noisyFrame(2.5, 200, 6),
    noisyFrame(3.0, 110, 7), // カット2
    noisyFrame(3.5, 110, 8),
    noisyFrame(4.0, 110, 9),
  ];
  assert.deepEqual(detectShotBoundaries(frames), [3, 6]);
});
check("単一カット（ノイズのみ）では境界を検出しない", () => {
  const frames = Array.from({ length: 10 }, (_, i) => noisyFrame(i * 0.5, 120, i));
  assert.deepEqual(detectShotBoundaries(frames), []);
});
check("フレームが少なすぎる場合は空を返す", () => {
  assert.deepEqual(detectShotBoundaries([]), []);
  assert.deepEqual(detectShotBoundaries([flatFrame(0, 10), flatFrame(0.5, 200)]), []);
});
check("暗い映像でも同じカットを拾う（適応閾値・固定値でない）", () => {
  const dark = [
    noisyFrame(0, 12, 1),
    noisyFrame(0.5, 12, 2),
    noisyFrame(1.0, 12, 3),
    noisyFrame(1.5, 60, 4), // カット
    noisyFrame(2.0, 60, 5),
    noisyFrame(2.5, 60, 6),
  ];
  assert.deepEqual(detectShotBoundaries(dark), [3]);
});

console.log("toShotSpans");
check("境界ゼロなら全体で1ショット", () => {
  const frames = [flatFrame(0, 10), flatFrame(0.5, 10), flatFrame(1.0, 10)];
  assert.deepEqual(toShotSpans(frames, [], 1.5), [
    { index: 0, startSec: 0, endSec: 1.5 },
  ]);
});
check("境界の数だけ区間が増え、時刻が連続する", () => {
  const frames = [
    flatFrame(0, 10),
    flatFrame(0.5, 10),
    flatFrame(1.0, 200),
    flatFrame(1.5, 200),
  ];
  assert.deepEqual(toShotSpans(frames, [2], 2.0), [
    { index: 0, startSec: 0, endSec: 1.0 },
    { index: 1, startSec: 1.0, endSec: 2.0 },
  ]);
});

console.log("pickRepresentatives");
check("単一ショットでも最低2枚出す（1枚では時系列で読めない）", () => {
  const { picks, clamped } = pickRepresentatives([{ index: 0, startSec: 0, endSec: 2 }], 2, 16);
  assert.ok(picks.length >= 2, `expected >=2, got ${picks.length}`);
  assert.equal(clamped, false);
});
check("4秒超の長回しは 1/4・中央・3/4 の3枚を選ぶ", () => {
  const shots = [
    { index: 0, startSec: 0, endSec: 8 },
    { index: 1, startSec: 8, endSec: 10 },
  ];
  const { picks } = pickRepresentatives(shots, 10, 16);
  assert.deepEqual(
    picks.filter((p) => p.shotIndex === 0).map((p) => p.timeSec),
    [2, 4, 6],
  );
  assert.deepEqual(
    picks.filter((p) => p.shotIndex === 1).map((p) => p.timeSec),
    [9],
  );
});
check("上限超過で間引き、clamped=true を返す（黙って捨てない）", () => {
  const shots = Array.from({ length: 20 }, (_, i) => ({
    index: i,
    startSec: i,
    endSec: i + 1,
  }));
  const { picks, clamped } = pickRepresentatives(shots, 20, 16);
  assert.ok(picks.length <= 16, `expected <=16, got ${picks.length}`);
  assert.equal(clamped, true);
});
check("長回しが多くても上限内に収める", () => {
  const shots = Array.from({ length: 10 }, (_, i) => ({
    index: i,
    startSec: i * 10,
    endSec: i * 10 + 10,
  }));
  const { picks, clamped } = pickRepresentatives(shots, 100, 16);
  assert.ok(picks.length <= 16, `expected <=16, got ${picks.length}`);
  assert.equal(clamped, true);
});
check("ショットが無い / 上限0なら空", () => {
  assert.deepEqual(pickRepresentatives([], 10, 16).picks, []);
  assert.deepEqual(
    pickRepresentatives([{ index: 0, startSec: 0, endSec: 5 }], 5, 0).picks,
    [],
  );
});
check("結果は必ず時刻の昇順に並ぶ", () => {
  const shots = [
    { index: 0, startSec: 0, endSec: 6 },
    { index: 1, startSec: 6, endSec: 7 },
    { index: 2, startSec: 7, endSec: 14 },
  ];
  const times = pickRepresentatives(shots, 14, 16).picks.map((p) => p.timeSec);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
});

console.log(`\nall ${passed} checks passed`);
