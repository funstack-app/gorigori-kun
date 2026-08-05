import { useEffect, useState } from "react";

const STORAGE_KEY = "gori.gauge.durations.v1";
const DEFAULT_EXPECTED_SECONDS = 120;
const MAX_HISTORY = 10;
const TICK_MS = 1000;

export type GenerationGaugeMode =
  | "batch"
  | "multiangle"
  | "storyboard"
  // 外部 provider は codex 経路と所要時間の桁が違うため、学習バケットを分ける
  // (2026-07-28)。codex の中央値を Magnific(数十秒級)や Higgsfield 動画(分単位)に
  // 使うと推定の前提が崩れる。
  | "magnific" // Magnific 画像 (単一/比較共通バケット)
  | "higgsfield" // Higgsfield 画像
  | "higgsfield-video"; // Higgsfield 動画 (画像と所要が桁違いのため分離)

type GenerationGaugeProps = {
  startedAt: number;
  mode: GenerationGaugeMode;
  done?: boolean;
  /**
   * 実測の進捗（0〜1）。渡した場合は**経過時間の推定を使わず、この値をそのまま描く**。
   *
   * 既存の呼び出し元（batch / multiangle / storyboard / magnific / higgsfield）は
   * **カード1枚ごと**にゲージを出しており、1枚の中の進み具合は取れないので推定に頼る。
   * 一方スタンプは「N枚のうち k 枚が完了した」という**正確な数字が取れる**（2026-08-05）。
   * 正確な数字があるのに推定を描くと、実際は 8/16 なのにゲージだけ 90% という
   * ズレが出る。取れるなら実測を描く。
   *
   * 省略時は従来どおり経過時間からの推定（既存5画面の挙動は変わらない）。
   */
  progress?: number;
};

type DurationHistory = Partial<Record<GenerationGaugeMode, number[]>>;

function readHistory(): DurationHistory {
  try {
    if (typeof window === "undefined") return {};
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as DurationHistory;
  } catch {
    return {};
  }
}

function validDurations(history: DurationHistory, mode: GenerationGaugeMode): number[] {
  const values = history[mode];
  if (!Array.isArray(values)) return [];
  return values.filter((value) => Number.isFinite(value) && value > 0).slice(-MAX_HISTORY);
}

function expectedSeconds(mode: GenerationGaugeMode): number {
  const values = validDurations(readHistory(), mode).sort((a, b) => a - b);
  if (values.length === 0) return DEFAULT_EXPECTED_SECONDS;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

/** 成功したカードの実測時間だけを、モード別の直近10件へ追加する。 */
export function recordGenerationDuration(mode: GenerationGaugeMode, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    if (typeof window === "undefined") return;
    const history = readHistory();
    history[mode] = [...validDurations(history, mode), seconds].slice(-MAX_HISTORY);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage が使えない環境でも、ゲージ表示と生成処理は継続する。
  }
}

function estimatePercent(elapsedSeconds: number, expected: number): number {
  if (elapsedSeconds <= expected) {
    return 90 * (elapsedSeconds / expected);
  }
  const overtime = elapsedSeconds - expected;
  return Math.min(99, 90 + 9 * (1 - Math.exp(-overtime / expected)));
}

/**
 * バーの幅（%）を決める**唯一の式**。コンポーネントとテストが同じ経路を通る。
 *
 * 分けてあるのは、React の描画を経由せずに「実測を渡したら実測が出るか」を
 * 固定できるようにするため（この判定はDOMに依存しない）。
 *
 * - `progress` が有効な数値なら**実測**（0〜1 を 0〜100% にクランプ）
 * - 無ければ従来どおり経過時間からの**推定**（`done` なら 100%）
 */
export function gaugeWidthPercent(params: {
  progress?: number;
  done: boolean;
  elapsedSeconds: number;
  expected: number;
}): number {
  const { progress, done, elapsedSeconds, expected } = params;
  // 0 も有効な進捗なので `!= null` で判定する（`progress ||` にすると 0 が推定へ落ちる）。
  if (progress != null && Number.isFinite(progress)) {
    return Math.min(100, Math.max(0, progress * 100));
  }
  return done ? 100 : estimatePercent(elapsedSeconds, expected);
}

/**
 * 生成の進捗バー。
 *
 * `progress` を渡せば**実測**を描き、渡さなければ経過時間からの**推定**を描く。
 * 見た目（高さ・色・角丸）は両者で同じにする。ユーザーから見て「他のスキルと
 * 同じゲージ」であることが目的で、中身が実測か推定かは表示の差にしない。
 */
export function GenerationGauge({
  startedAt,
  mode,
  done = false,
  progress,
}: GenerationGaugeProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expected, setExpected] = useState(() => expectedSeconds(mode));
  // 実測が渡っているか。0 も有効な進捗なので `!= null` で判定する（`progress || ...` にしない）。
  const hasMeasured = progress != null && Number.isFinite(progress);

  useEffect(() => {
    setExpected(expectedSeconds(mode));
  }, [mode, startedAt]);

  useEffect(() => {
    // 実測を描くときはタイマーが要らない（k/N が変わったときだけ再描画されればよい）。
    if (done || hasMeasured) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [done, startedAt, hasMeasured]);

  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const percent = gaugeWidthPercent({ progress, done, elapsedSeconds, expected });

  return (
    <div
      className="h-[3px] w-full overflow-hidden rounded-full bg-[#2a2a2a]"
      aria-label={hasMeasured ? "生成の進捗" : "生成の推定進捗"}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-pink-600 to-pink-400 transition-[width] duration-700 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
