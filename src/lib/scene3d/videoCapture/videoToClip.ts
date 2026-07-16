/**
 * 動画ファイル → モーションクリップの配管。
 * MediaPipe Pose(同梱WASM・完全ローカル)でworld landmarksを抽出し、
 * poseSolver で GeneratedMotionSpec に変換して既存のクリップ登録経路へ流す。
 *
 * 注意(罠リスト対応):
 *   - WASM/モデルは public/ に同梱済み(オフライン・版固定)
 *   - detectForVideo へは単調増加のタイムスタンプを渡す
 *   - v1のフレーム取りは currentTime シーク(可変FPS動画で欠落しうる。製品化でWebCodecs)
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

import type { GeneratedMotionSpec } from "../motionGen";
import { smoothFrames, solveFramesToSpec } from "./poseSolver";
import type { CapturedFrame } from "./poseSolver";

/** キーフレームのサンプリングレート(fps)。補間が滑らかにするので撮影fpsより低くてよい */
const SAMPLE_FPS = 12;
/** v1の取り込み上限(秒)。長尺はUIで分割を促す */
const MAX_SECONDS = 20;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;
/**
 * landmarker はシングルトンで、VIDEOモードはインスタンス生涯で単調増加の
 * タイムスタンプを要求する。取り込みごとに0へ巻き戻すと
 * "Packet timestamp mismatch" で2回目以降が必ず落ちるため、通算で管理する。
 */
let lastTsMs = 0;

/** PoseLandmarkerのシングルトン(初期化は重いので1回だけ) */
function getLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/pose_landmarker_full.task" },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // 失敗したら次回作り直す
    });
  }
  return landmarkerPromise;
}

/**
 * 動画ファイルから演技(関節の動き)を抽出して GeneratedMotionSpec を返す。
 * 平行移動は含まない(軌跡はアプリの経路レイヤーで演出する)
 */
export async function captureVideoToSpec(
  file: File,
  onProgress?: (msg: string, ratio: number) => void,
): Promise<GeneratedMotionSpec> {
  onProgress?.("骨格エンジンを準備中…", 0);
  const landmarker = await getLandmarker();

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((res, rej) => {
      video.onloadeddata = () => res();
      video.onerror = () =>
        rej(new Error("この動画を再生できません(対応形式: mp4/mov/webm。形式変換を試してください)"));
    });

    const duration = Math.min(video.duration || 0, MAX_SECONDS);
    if (!Number.isFinite(duration) || duration < 0.5) {
      throw new Error("動画が短すぎるか、長さを取得できませんでした");
    }

    const frames: CapturedFrame[] = [];
    let missed = 0;
    // 前回取り込みの続きから1秒空けて開始(トラッカーに別セグメントと認識させつつ、
    // フレーム間の実時間間隔は保つ)
    const baseTsMs = lastTsMs + 1000;
    const step = 1 / SAMPLE_FPS;
    for (let t = 0.001; t < duration; t += step) {
      video.currentTime = t;
      await new Promise<void>((r) => {
        video.onseeked = () => r();
      });
      // 単調増加タイムスタンプ(同一・逆行を渡すと追跡が壊れる)
      const tsMs = Math.max(lastTsMs + 1, baseTsMs + Math.round(t * 1000));
      lastTsMs = tsMs;
      const res = landmarker.detectForVideo(video, tsMs);
      const world = res.worldLandmarks?.[0];
      if (world && world.length >= 33) {
        frames.push({
          time: Math.round(t * 1000) / 1000,
          landmarks: world.map((l) => ({
            x: l.x,
            y: l.y,
            z: l.z,
            visibility: l.visibility,
          })),
        });
      } else {
        missed++;
      }
      onProgress?.(
        `動きを読み取り中… ${Math.round((t / duration) * 100)}%`,
        t / duration,
      );
    }

    const total = frames.length + missed;
    if (total === 0 || frames.length < SAMPLE_FPS) {
      throw new Error("人物を検出できませんでした(全身が映った実写の動画を使ってください)");
    }
    if (frames.length / total < 0.5) {
      throw new Error(
        `人物を見失うフレームが多すぎます(検出${Math.round((frames.length / total) * 100)}%)。全身が映り続ける動画を使ってください`,
      );
    }

    onProgress?.("動きをキャラの骨格に変換中…", 0.95);
    const smoothed = smoothFrames(frames);
    const baseName = file.name.replace(/\.[^.]+$/, "").slice(0, 20) || "取り込み";
    return solveFramesToSpec(smoothed, `${baseName}(動画)`);
  } finally {
    URL.revokeObjectURL(url);
    video.src = "";
  }
}
