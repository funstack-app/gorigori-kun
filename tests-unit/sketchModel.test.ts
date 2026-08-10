/**
 * スケッチのベクターモデル (sketchModel.ts) の契約テスト。
 *
 * ここが守るのは「画面で見た線と書き出した PNG の線が同じ式で描かれる」こと。
 * 表示は実解像度 (CSS × DPR)、書き出しは 1024 長辺と解像度が違うので、
 * 正規化座標 → ピクセル座標の換算と線幅のスケールが唯一の接点になる。
 *
 * DOM を持ち込まずに検証するため、2D コンテキストは呼び出しを記録する
 * フェイクを渡す (renderStrokes は構造的部分型で受けている)。
 */
import { describe, expect, it } from "vitest";

import {
  MAX_BRUSH_PX,
  MIN_BRUSH_PX,
  clampBrushSize,
  isSketchEmpty,
  renderStrokes,
  strokeLineWidth,
  type SketchStroke,
  type StrokeRenderTarget,
} from "../src/components/sketch/sketchModel";

type Call = { op: string; args: number[] };

type FakeCtx = StrokeRenderTarget & {
  calls: Call[];
  /** op ごとに、その呼び出し時点の globalAlpha / composite を記録する。 */
  states: { op: string; alpha: number; composite: string; lineWidth: number }[];
};

function makeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    calls: [],
    states: [],
    beginPath() {
      record("beginPath", []);
    },
    moveTo(x, y) {
      record("moveTo", [x, y]);
    },
    lineTo(x, y) {
      record("lineTo", [x, y]);
    },
    stroke() {
      record("stroke", []);
    },
    arc(x, y, r, a0, a1) {
      record("arc", [x, y, r, a0, a1]);
    },
    fill() {
      record("fill", []);
    },
  };
  function record(op: string, args: number[]) {
    ctx.calls.push({ op, args });
    ctx.states.push({
      op,
      alpha: ctx.globalAlpha,
      composite: ctx.globalCompositeOperation,
      lineWidth: ctx.lineWidth,
    });
  }
  return ctx;
}

function stroke(over: Partial<SketchStroke> = {}): SketchStroke {
  return {
    pen: "pen",
    mode: "draw",
    color: "#111111",
    size: 10,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    ...over,
  };
}

describe("strokeLineWidth — 太さは長辺比でスケールする", () => {
  it("size=2 を 2048×1152 に描くと 4px (1024 基準の2倍)", () => {
    expect(strokeLineWidth(2, 2048, 1152)).toBe(4);
  });

  it("1024 長辺ではそのままの値 (書き出し解像度が基準)", () => {
    expect(strokeLineWidth(10, 1024, 576)).toBe(10);
  });
});

describe("renderStrokes — 正規化座標をピクセル座標へ", () => {
  it("(0.5, 0.5) は (pxW/2, pxH/2) に落ちる", () => {
    const g = makeCtx();
    renderStrokes(
      g,
      [
        stroke({
          points: [
            { x: 0.5, y: 0.5 },
            { x: 1, y: 0.25 },
          ],
        }),
      ],
      800,
      400,
    );

    const moveTo = g.calls.find((c) => c.op === "moveTo");
    const lineTo = g.calls.find((c) => c.op === "lineTo");
    expect(moveTo?.args).toEqual([400, 200]);
    expect(lineTo?.args).toEqual([800, 100]);
  });

  it("鉛筆は alpha=0.7、消しゴムは destination-out かつ alpha=1", () => {
    const g = makeCtx();
    renderStrokes(g, [stroke({ pen: "pencil" })], 1024, 576);
    const drawState = g.states.find((s) => s.op === "stroke");
    expect(drawState?.alpha).toBeCloseTo(0.7);
    expect(drawState?.composite).toBe("source-over");

    const e = makeCtx();
    renderStrokes(e, [stroke({ pen: "pencil", mode: "erase" })], 1024, 576);
    const eraseState = e.states.find((s) => s.op === "stroke");
    // 消しゴムはペン種別に関係なく完全に消す (半透明の消しゴムを作らない)
    expect(eraseState?.alpha).toBe(1);
    expect(eraseState?.composite).toBe("destination-out");

    // 描画後は既定へ戻す (次に描く人へ状態を漏らさない)
    expect(e.globalAlpha).toBe(1);
    expect(e.globalCompositeOperation).toBe("source-over");
  });

  it("1点は arc+fill の点、2点以上は stroke の線", () => {
    const dot = makeCtx();
    renderStrokes(dot, [stroke({ size: 20, points: [{ x: 0.5, y: 0.5 }] })], 1024, 1024);
    const arc = dot.calls.find((c) => c.op === "arc");
    expect(arc).toBeTruthy();
    // 半径は線幅の半分 (size 20 / 1024 長辺 → lineWidth 20 → r=10)
    expect(arc?.args.slice(0, 3)).toEqual([512, 512, 10]);
    expect(dot.calls.some((c) => c.op === "fill")).toBe(true);
    expect(dot.calls.some((c) => c.op === "stroke")).toBe(false);

    const line = makeCtx();
    renderStrokes(line, [stroke()], 1024, 1024);
    expect(line.calls.some((c) => c.op === "stroke")).toBe(true);
    expect(line.calls.some((c) => c.op === "arc")).toBe(false);
  });
});

describe("isSketchEmpty — 消しただけの紙は空", () => {
  it("ストロークなしは空", () => {
    expect(isSketchEmpty([])).toBe(true);
  });

  it("消しゴムだけなら空 (描いたものが無い)", () => {
    expect(isSketchEmpty([stroke({ mode: "erase" })])).toBe(true);
  });

  it("draw が1本でもあれば空でない", () => {
    expect(isSketchEmpty([stroke({ mode: "erase" }), stroke()])).toBe(false);
  });
});

describe("clampBrushSize — 数値入力の唯一の関門", () => {
  it("下限・上限に丸める", () => {
    expect(clampBrushSize(0)).toBe(MIN_BRUSH_PX);
    expect(clampBrushSize(-5)).toBe(MIN_BRUSH_PX);
    expect(clampBrushSize(999)).toBe(MAX_BRUSH_PX);
  });

  it("小数は四捨五入で整数化する", () => {
    expect(clampBrushSize(12.7)).toBe(13);
    expect(clampBrushSize(12.2)).toBe(12);
  });

  it("NaN (空入力) は下限へ倒す", () => {
    expect(clampBrushSize(Number.NaN)).toBe(MIN_BRUSH_PX);
  });
});
