/**
 * ショット境界検出（決定論・純関数）。
 *
 * カット割りは「隣接フレームの絵が大きく変わる点」で決まる。これは推論でなく
 * 計算で出せるので Codex に投げない（skill-core 第2条: 決定論で組めるなら
 * スクリプトに落とす）。Codex には「各ショットの意味づけ・演出意図」だけを残す。
 *
 * このファイルは DOM にも Tauri にも依存しない純関数だけを置く。
 * 走査（video 要素シーク）は videoFrameExtract.ts が担当し、ここへは
 * 輝度配列だけが渡ってくる。分離しているのはユニットテストのため。
 */

/** 1走査フレーム分のグレースケイル輝度（0-255）と時刻。 */
export type LumaFrame = {
  /** 動画内の時刻（秒）。 */
  timeSec: number;
  /** 縮小画像のグレースケイル輝度配列（全フレームで同じ長さ）。 */
  luma: Uint8ClampedArray;
};

/** 検出された1ショット（カット間の区間）。 */
export type ShotSpan = {
  /** 0 始まりのショット番号。 */
  index: number;
  /** ショット開始時刻（秒）。 */
  startSec: number;
  /** ショット終了時刻（秒・排他的でなく最後のフレーム時刻＋1フレーム分）。 */
  endSec: number;
};

/** 代表フレームの抽出指示（この時刻の絵をフル解像度で書き出す）。 */
export type RepresentativePick = {
  /** 動画内の時刻（秒）。 */
  timeSec: number;
  /** どのショットに属するか（0 始まり）。 */
  shotIndex: number;
};

/**
 * 隣接フレームの平均絶対差（MAD: Mean Absolute Difference）。
 * 値域は 0-255。カットでは大きく跳ね、同一ショット内の動きでは小さく留まる。
 */
export function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

/** 数値配列の中央値（入力を破壊しない）。 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 適応閾値の係数。中央値からの偏差（MAD of MAD）の何倍を「跳ねた」とみなすか。
 * 固定の絶対値を閾値にしない: 暗い映像・明るい映像・ノイズの多い映像で
 * 差分の基準値がまるごとスライドするため、絶対値のハードコードは必ず破綻する
 * （work-discipline-module 条項3: 境界値・その時の値を信じない）。
 */
const THRESHOLD_K = 6;

/**
 * 閾値の下限。静止画に近い映像（差分がほぼ 0）では中央値も偏差も 0 に潰れ、
 * 微小なノイズが「カット」に化けるため、絶対的な床を1枚だけ敷く。
 */
const MIN_ABS_THRESHOLD = 8;

/**
 * 輝度フレーム列からカット境界のインデックスを検出する。
 *
 * 返すのは「そのフレームから新しいショットが始まる」インデックスの昇順配列。
 * 先頭（0）は含めない（呼び出し側が常にショット先頭として扱うため）。
 *
 * 適応閾値: median(diff) + K × median(|diff - median|)。
 * 映像全体の差分の散らばりを基準にするので、暗い/明るい/ノイジーな映像でも
 * 同じコードで効く。
 */
export function detectShotBoundaries(frames: readonly LumaFrame[]): number[] {
  if (frames.length < 3) return [];

  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    diffs.push(meanAbsDiff(frames[i - 1].luma, frames[i].luma));
  }

  const med = median(diffs);
  const deviation = median(diffs.map((d) => Math.abs(d - med)));
  const threshold = Math.max(med + THRESHOLD_K * deviation, MIN_ABS_THRESHOLD);

  const boundaries: number[] = [];
  for (let i = 0; i < diffs.length; i++) {
    // diffs[i] は frames[i] → frames[i+1] の差。跳ねたら i+1 が新ショットの先頭。
    if (diffs[i] >= threshold) boundaries.push(i + 1);
  }
  return boundaries;
}

/**
 * 境界インデックス列を ShotSpan（時刻つき区間）へ変換する。
 * 境界ゼロなら「全体で1ショット」を返す。
 */
export function toShotSpans(
  frames: readonly LumaFrame[],
  boundaries: readonly number[],
  durationSec: number,
): ShotSpan[] {
  if (frames.length === 0) return [];
  const starts = [0, ...boundaries];
  return starts.map((startIdx, i) => {
    const nextStart = i + 1 < starts.length ? starts[i + 1] : frames.length;
    const endSec =
      nextStart < frames.length ? frames[nextStart].timeSec : durationSec;
    return {
      index: i,
      startSec: frames[startIdx].timeSec,
      endSec: Math.max(endSec, frames[startIdx].timeSec),
    };
  });
}

/**
 * 各ショットの代表フレーム時刻を選ぶ。
 *
 * - 基本は各ショットの中央1枚（カットの切り替わり際は絵が不安定なため中央を取る）
 * - 4秒を超えるショットは ±1/4 点も足す（長回しの中の変化を拾う）
 * - 全体で maxFrames を超える場合は、ショットあたり1枚へ落としてから
 *   長いショット優先で間引く。**間引いた事実は戻り値の clamped で返す**
 *   （黙って捨てない = no-silent-gap-filling）
 * - 境界ゼロ（単一カット）で結果が1枚しか出ないときは等間隔サンプリングへ
 *   フォールバックし、最低2枚を確保する
 */
export function pickRepresentatives(
  shots: readonly ShotSpan[],
  durationSec: number,
  maxFrames: number,
): { picks: RepresentativePick[]; clamped: boolean } {
  if (shots.length === 0 || maxFrames <= 0) return { picks: [], clamped: false };

  /** 長回しショットで追加点を出す閾値（秒）。 */
  const LONG_SHOT_SEC = 4;

  // 第1希望: 中央 + （長いショットなら）±1/4 点。
  const preferred = shots.map((shot) => {
    const len = Math.max(0, shot.endSec - shot.startSec);
    const mid = shot.startSec + len / 2;
    if (len <= LONG_SHOT_SEC) return [mid];
    return [shot.startSec + len / 4, mid, shot.startSec + (len * 3) / 4];
  });

  const flatten = (perShot: readonly (readonly number[])[]): RepresentativePick[] =>
    perShot.flatMap((times, shotIndex) =>
      times.map((timeSec) => ({ timeSec, shotIndex })),
    );

  let picks = flatten(preferred);
  let clamped = false;

  // 上限超過: まず全ショット1枚（中央のみ）へ落とす。
  if (picks.length > maxFrames) {
    clamped = true;
    picks = flatten(preferred.map((times) => [times[Math.floor(times.length / 2)]]));
  }

  // それでも超えるならショット数自体が多い。長いショットを優先して残す
  // （短い挿入カットより、尺のあるショットの方が分析価値が高い）。
  if (picks.length > maxFrames) {
    clamped = true;
    const ranked = [...shots]
      .map((shot, i) => ({ i, len: shot.endSec - shot.startSec }))
      .sort((a, b) => b.len - a.len)
      .slice(0, maxFrames)
      .map((entry) => entry.i);
    const keep = new Set(ranked);
    picks = picks.filter((p) => keep.has(p.shotIndex));
  }

  // 単一カット（境界ゼロ）で1枚しか出ないときは等間隔で最低2枚に増やす。
  // 1枚では「時系列で読む」というスキルの前提が成立しない。
  if (picks.length < 2 && durationSec > 0) {
    const wanted = Math.min(Math.max(2, picks.length), maxFrames);
    const step = durationSec / (wanted + 1);
    picks = Array.from({ length: wanted }, (_, i) => ({
      timeSec: step * (i + 1),
      shotIndex: 0,
    }));
  }

  return {
    picks: picks.sort((a, b) => a.timeSec - b.timeSec),
    clamped,
  };
}
