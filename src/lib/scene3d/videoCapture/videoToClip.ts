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

/** キーフレームのサンプリングレート(fps)。
 * 12→24に引き上げ(2026-07-21): 対称比較の実測で 12fps は関節角RMS 3.5-5.1度・キレ9%損失、
 * 24fps で RMS 1.5-2.5度・損失2-3%まで回復(diagnose_solver.cjs、ダンスShort 473フレーム)。
 * 取り込み時間は約2倍になるが進捗表示があるため許容 */
const SAMPLE_FPS = 24;
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
      // 競合対策(2026-07-21): リスナーを張ってからシークを開始する。
      // 旧実装(currentTime代入→後からonseeked代入)は、直前シークの完了イベントを
      // 誤って拾い、シーク未完了の画で骨格検出する取り違えが起きる
      // (12fpsでは間隔が長く顕在化せず、24fps化で常時発火した)
      await new Promise<void>((res) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          res();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = t;
      });
      // 単調増加タイムスタンプ(同一・逆行を渡すと追跡が壊れる)
      const tsMs = Math.max(lastTsMs + 1, baseTsMs + Math.round(t * 1000));
      lastTsMs = tsMs;
      const res = landmarker.detectForVideo(video, tsMs);
      const world = res.worldLandmarks?.[0];
      const img = res.landmarks?.[0];
      if (world && world.length >= 33) {
        frames.push({
          time: Math.round(t * 1000) / 1000,
          landmarks: world.map((l) => ({
            x: l.x,
            y: l.y,
            z: l.z,
            visibility: l.visibility,
          })),
          // 画像座標も持ち回る(ジャンプ=床からの浮きの復元に使う)
          image: img?.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility })),
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
    // 取り込み時刻を名前に含める(同じ動画を設定違いで取り込み直したとき一覧で区別できるように)
    const stamp = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    return solveFramesToSpec(smoothed, `${baseName}(動画 ${stamp})`);
  } finally {
    URL.revokeObjectURL(url);
    video.src = "";
  }
}
