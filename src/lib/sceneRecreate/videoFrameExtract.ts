/**
 * ローカル動画ファイル → キーフレーム抽出（依存追加ゼロ）。
 *
 * 方式は scene3d/videoCapture/videoToClip.ts と同じ「HTML5 video 要素の
 * currentTime シーク + seeked イベント」。外部バイナリ（yt-dlp 等）も
 * npm 依存も増やさない。URL からの直接取得はやらない: 配布バイナリに
 * 外部ツールを同梱すると bundle 肥大・規約リスク・壊れたときに直せない
 * の3点が同時に来るため（設計書 §2.1）。
 *
 * 2パス構成:
 *   パス1: 低解像度グレースケイルで全走査 → 隣接フレーム差分でカット境界検出
 *   パス2: 各ショットの代表時刻だけフル解像度 PNG で書き出し
 *
 * MediaPipe（videoToClip.ts のポーズ抽出）は使わない。あれは3Dボーン数値化で、
 * こちらの目的は「動きの言語化」。骨格座標は過剰かつ人物動画にしか効かない。
 */

import { detectShotBoundaries, pickRepresentatives, toShotSpans } from "./shotBoundary";
import type { LumaFrame } from "./shotBoundary";

/** 走査パスのサンプリングレート（fps）。カット検出には 2fps で足りる。 */
const SCAN_FPS = 2;

/** 走査パスの縮小サイズ。小さいほど速く、カット判定には十分。 */
const SCAN_WIDTH = 96;
const SCAN_HEIGHT = 54;

/** 取り込み上限（秒）。超過分は切り捨て、UI でトースト明示する。 */
export const MAX_VIDEO_SECONDS = 60;

/** 書き出すキーフレームの上限枚数。フレーム説明が1枚ずつ逐次のため。 */
export const MAX_KEYFRAMES = 16;

/** 抽出したキーフレーム1枚。 */
export type ExtractedKeyframe = {
  /** 書き出した PNG の絶対パス。 */
  path: string;
  /** 動画内の時刻（秒）。 */
  timeSec: number;
  /** 属するショット番号（0 始まり）。 */
  shotIndex: number;
};

/** 抽出結果。クランプの有無は呼び出し側がトーストで明示する。 */
export type ExtractResult = {
  keyframes: ExtractedKeyframe[];
  /** 検出したショット数。 */
  shotCount: number;
  /** 動画の実長（秒）。 */
  durationSec: number;
  /** MAX_VIDEO_SECONDS で尺を切ったか。 */
  durationClamped: boolean;
  /** MAX_KEYFRAMES で枚数を間引いたか。 */
  frameClamped: boolean;
};

export type ExtractProgress = (message: string, ratio: number) => void;

/** video 要素を指定時刻へシークし、完了を待つ。 */
function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    // 競合対策: リスナーを張ってからシークを開始する。
    // 逆順（currentTime 代入 → 後から onseeked 代入）だと直前シークの完了
    // イベントを誤って拾い、シーク未完了の画を掴む取り違えが起きる
    // （videoToClip.ts が 24fps 化で踏んだ実バグ。同じ順序を踏襲する）。
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = timeSec;
  });
}

/** File から再生可能な video 要素を作る。呼び出し側が dispose を呼ぶこと。 */
async function loadVideo(
  file: File,
): Promise<{ video: HTMLVideoElement; dispose: () => void }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  const dispose = () => {
    URL.revokeObjectURL(url);
    video.src = "";
  };
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () =>
        reject(
          new Error(
            "この動画を再生できません（対応形式: mp4 / mov / webm。形式変換を試してください）",
          ),
        );
    });
  } catch (err) {
    dispose();
    throw err;
  }
  return { video, dispose };
}

/** canvas を PNG Blob へ。toBlob が null を返す環境差を潰す。 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG への変換に失敗しました"))),
      "image/png",
    );
  });
}

/** 走査パス: 低解像度グレースケイルで全体を舐める。 */
async function scanLumaFrames(
  video: HTMLVideoElement,
  durationSec: number,
  onProgress?: ExtractProgress,
): Promise<LumaFrame[]> {
  const canvas = document.createElement("canvas");
  canvas.width = SCAN_WIDTH;
  canvas.height = SCAN_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("画像処理を初期化できませんでした");

  const frames: LumaFrame[] = [];
  const step = 1 / SCAN_FPS;
  // 0 ちょうどは環境によって黒フレームが返るため僅かにずらす（videoToClip.ts と同じ）。
  for (let t = 0.001; t < durationSec; t += step) {
    await seekTo(video, t);
    ctx.drawImage(video, 0, 0, SCAN_WIDTH, SCAN_HEIGHT);
    const { data } = ctx.getImageData(0, 0, SCAN_WIDTH, SCAN_HEIGHT);
    const luma = new Uint8ClampedArray(SCAN_WIDTH * SCAN_HEIGHT);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // ITU-R BT.601 の輝度式。人間の明るさ知覚に合うのでカット検出に向く。
      luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    frames.push({ timeSec: Math.round(t * 1000) / 1000, luma });
    onProgress?.(
      `フレームを走査中… ${Math.round((t / durationSec) * 100)}%`,
      (t / durationSec) * 0.7,
    );
  }
  return frames;
}

/**
 * 動画ファイルからキーフレームを抽出し、appData 配下へ PNG で書き出す。
 *
 * @param file ユーザーが選んだローカル動画（mp4 / mov / webm）
 * @param runId 書き出し先ディレクトリ名に使う実行 ID
 */
export async function extractKeyframes(
  file: File,
  runId: string,
  onProgress?: ExtractProgress,
): Promise<ExtractResult> {
  onProgress?.("動画を読み込み中…", 0);
  const { video, dispose } = await loadVideo(file);

  try {
    const rawDuration = video.duration;
    if (!Number.isFinite(rawDuration) || rawDuration < 0.5) {
      throw new Error("動画が短すぎるか、長さを取得できませんでした");
    }
    const durationSec = Math.min(rawDuration, MAX_VIDEO_SECONDS);
    const durationClamped = rawDuration > MAX_VIDEO_SECONDS;

    // パス1: 走査してカット境界を出す。
    const lumaFrames = await scanLumaFrames(video, durationSec, onProgress);
    if (lumaFrames.length === 0) {
      throw new Error("動画からフレームを取得できませんでした");
    }
    const boundaries = detectShotBoundaries(lumaFrames);
    const shots = toShotSpans(lumaFrames, boundaries, durationSec);
    const { picks, clamped: frameClamped } = pickRepresentatives(
      shots,
      durationSec,
      MAX_KEYFRAMES,
    );

    // パス2: 代表フレームだけフル解像度で書き出す。
    onProgress?.("キーフレームを書き出し中…", 0.7);
    const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const outDir = await join(await appDataDir(), "scene_recreate_frames", runId);
    await mkdir(outDir, { recursive: true });

    const full = document.createElement("canvas");
    full.width = video.videoWidth || SCAN_WIDTH;
    full.height = video.videoHeight || SCAN_HEIGHT;
    const fullCtx = full.getContext("2d");
    if (!fullCtx) throw new Error("画像処理を初期化できませんでした");

    const keyframes: ExtractedKeyframe[] = [];
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      await seekTo(video, pick.timeSec);
      fullCtx.drawImage(video, 0, 0, full.width, full.height);
      const blob = await canvasToPngBlob(full);
      const name = `f_${String(i + 1).padStart(3, "0")}.png`;
      const path = await join(outDir, name);
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      keyframes.push({ path, timeSec: pick.timeSec, shotIndex: pick.shotIndex });
      onProgress?.(
        `キーフレームを書き出し中… ${i + 1}/${picks.length}`,
        0.7 + (0.3 * (i + 1)) / picks.length,
      );
    }

    return {
      keyframes,
      shotCount: shots.length,
      durationSec: rawDuration,
      durationClamped,
      frameClamped,
    };
  } finally {
    dispose();
  }
}
