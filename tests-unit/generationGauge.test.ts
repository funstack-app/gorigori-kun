/**
 * `GenerationGauge` の幅計算（STΛCK指摘 2026-08-05・責務1）。
 *
 * ## 何を守るテストか
 *
 * スタンプは他スキルと違い「N枚のうち k 枚が終わった」という**正確な数字が取れる**。
 * 正確な数字があるのに経過時間の推定を描くと、実際は 8/16 なのにゲージだけ 90%
 * というズレが出る。`progress` を渡したときは**実測がそのまま出る**ことを固定する。
 *
 * 同時に、`progress` を渡さない**既存5画面（batch / multiangle / storyboard /
 * magnific / higgsfield）の挙動が変わっていない**ことも固定する。既存の呼び出しは
 * `progress` を渡さないので、推定の式を通り続けなければならない。
 */
import { describe, expect, it } from "vitest";

import { gaugeWidthPercent } from "../src/components/GenerationGauge";

/** 推定側の既定値（コンポーネントの DEFAULT_EXPECTED_SECONDS と同じ 120 秒）。 */
const EXPECTED = 120;

describe("実測 progress を渡したとき", () => {
  it("k/N がそのまま幅になる", () => {
    // 16枚中8枚 = 50%。経過時間がいくつでも実測が優先される。
    expect(
      gaugeWidthPercent({
        progress: 8 / 16,
        done: false,
        elapsedSeconds: 0,
        expected: EXPECTED,
      }),
    ).toBe(50);
  });

  it("経過時間に引っ張られない（実測が推定を上書きする）", () => {
    // 経過時間だけ見れば推定は 90% まで伸びる場面でも、実測 2/16 なら 12.5%。
    const measured = gaugeWidthPercent({
      progress: 2 / 16,
      done: false,
      elapsedSeconds: EXPECTED,
      expected: EXPECTED,
    });
    const estimated = gaugeWidthPercent({
      done: false,
      elapsedSeconds: EXPECTED,
      expected: EXPECTED,
    });

    expect(measured).toBe(12.5);
    // 推定はこの時点で 90%。実測とはっきり違う値になる＝取り違えたら気づける。
    expect(estimated).toBe(90);
    expect(measured).not.toBe(estimated);
  });

  it("0 枚完了は 0%（0 を「未指定」と取り違えない）", () => {
    // `progress ||` で書くと 0 が falsy なので推定へ落ちる。そのバグを固定で防ぐ。
    expect(
      gaugeWidthPercent({
        progress: 0,
        done: false,
        elapsedSeconds: 60,
        expected: EXPECTED,
      }),
    ).toBe(0);
  });

  it("全部終われば 100%", () => {
    expect(
      gaugeWidthPercent({
        progress: 1,
        done: true,
        elapsedSeconds: 5,
        expected: EXPECTED,
      }),
    ).toBe(100);
  });

  it("範囲外の値でも 0〜100 に収まる", () => {
    expect(
      gaugeWidthPercent({ progress: 1.5, done: false, elapsedSeconds: 0, expected: EXPECTED }),
    ).toBe(100);
    expect(
      gaugeWidthPercent({ progress: -1, done: false, elapsedSeconds: 0, expected: EXPECTED }),
    ).toBe(0);
  });

  it("NaN は実測とみなさず推定へ落ちる", () => {
    // 壊れた値を実測として描くと 0% で固まって見える。推定に倒すほうが安全。
    expect(
      gaugeWidthPercent({
        progress: Number.NaN,
        done: true,
        elapsedSeconds: 1,
        expected: EXPECTED,
      }),
    ).toBe(100);
  });
});

describe("progress を渡さない既存5画面の挙動（退行防止）", () => {
  it("開始直後は 0%", () => {
    expect(gaugeWidthPercent({ done: false, elapsedSeconds: 0, expected: EXPECTED })).toBe(0);
  });

  it("想定時間の半分で 45%（推定式 90×経過/想定 のまま）", () => {
    expect(
      gaugeWidthPercent({ done: false, elapsedSeconds: EXPECTED / 2, expected: EXPECTED }),
    ).toBe(45);
  });

  it("想定時間ちょうどで 90%", () => {
    expect(
      gaugeWidthPercent({ done: false, elapsedSeconds: EXPECTED, expected: EXPECTED }),
    ).toBe(90);
  });

  it("超過しても 99% を超えない（完了までは満タンにしない）", () => {
    const late = gaugeWidthPercent({
      done: false,
      elapsedSeconds: EXPECTED * 100,
      expected: EXPECTED,
    });
    expect(late).toBeGreaterThan(90);
    expect(late).toBeLessThanOrEqual(99);
  });

  it("done なら 100%", () => {
    expect(gaugeWidthPercent({ done: true, elapsedSeconds: 1, expected: EXPECTED })).toBe(100);
  });
});
