/**
 * スケッチのベクターモデル (DOM 非依存の純ロジック)。
 *
 * 描いた線を「ピクセル」ではなく「線の記録」で持つのが要点。
 * 表示は画面の実解像度 (CSS サイズ × devicePixelRatio) で描き直せるので、
 * 1024px のビットマップを拡大コピーしていた頃の滲みが構造的に消える。
 *
 * 座標は正規化 (0-1) で保存する。キャンバスの表示サイズ・DPR・書き出し解像度が
 * それぞれ違っても、同じストロークを任意の解像度で再現できる。
 */

export type PenType = "pen" | "pencil" | "marker";

export type SketchStroke = {
  pen: PenType;
  mode: "draw" | "erase";
  color: string;
  /** 1024 長辺基準の px。実際の線幅は strokeLineWidth() で解像度に合わせる。 */
  size: number;
  /** 正規化座標 0-1 (x = px / 幅, y = px / 高さ)。 */
  points: { x: number; y: number }[];
};

/** ペンの見た目。今のところ差は不透明度だけ (テクスチャはスコープ外)。 */
export const PEN_STYLES: Record<PenType, { label: string; alpha: number }> = {
  pen: { label: "ペン", alpha: 1.0 },
  pencil: { label: "鉛筆", alpha: 0.7 },
  marker: { label: "マーカー", alpha: 0.4 },
};

export const MIN_BRUSH_PX = 1;
export const MAX_BRUSH_PX = 64;

/** 太さの基準となる長辺 (px)。ストロークの size はこの解像度での太さ。 */
const BASE_LONG_EDGE = 1024;

/**
 * 太さを整数化して 1〜64 に収める。
 * 数値入力は空文字・NaN・小数・範囲外が普通に飛んでくるので、ここが唯一の関門。
 */
export function clampBrushSize(n: number): number {
  if (!Number.isFinite(n)) return MIN_BRUSH_PX;
  const i = Math.round(n);
  if (i < MIN_BRUSH_PX) return MIN_BRUSH_PX;
  if (i > MAX_BRUSH_PX) return MAX_BRUSH_PX;
  return i;
}

/**
 * 何も描かれていないか。
 * 消しゴムのストロークは「描いたもの」に数えない (消しただけの紙は空)。
 */
export function isSketchEmpty(strokes: SketchStroke[]): boolean {
  return !strokes.some((s) => s.mode === "draw");
}

/** 1024 長辺基準の太さを、実際の描画解像度での線幅に換算する。 */
export function strokeLineWidth(size: number, pxW: number, pxH: number): number {
  return size * (Math.max(pxW, pxH) / BASE_LONG_EDGE);
}

/**
 * renderStrokes が使う 2D コンテキストの構造的部分型。
 *
 * CanvasRenderingContext2D をそのまま要求するとテストでフェイクを渡せないので、
 * 実際に呼ぶメソッド/プロパティだけを列挙する。
 */
export type StrokeRenderTarget = {
  globalCompositeOperation: string;
  globalAlpha: number;
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
};

/**
 * 全ストロークを順に描画する。表示・書き出しの両方がこの1関数を通るので、
 * 「画面で見た線」と「PNG に出る線」が式レベルで一致する。
 */
export function renderStrokes(
  g: StrokeRenderTarget,
  strokes: SketchStroke[],
  pxW: number,
  pxH: number,
): void {
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const erasing = stroke.mode === "erase";
    g.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    // 消しゴムは半透明にしない (薄く消える消しゴムは操作感が壊れる)
    g.globalAlpha = erasing ? 1 : PEN_STYLES[stroke.pen].alpha;
    const width = strokeLineWidth(stroke.size, pxW, pxH);
    g.lineWidth = width;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = stroke.color;
    g.fillStyle = stroke.color;

    if (stroke.points.length === 1) {
      // 点置き (クリックしただけ) は円で描く。線では面積がゼロになる
      const p = stroke.points[0];
      g.beginPath();
      g.arc(p.x * pxW, p.y * pxH, width / 2, 0, Math.PI * 2);
      g.fill();
      continue;
    }

    g.beginPath();
    const first = stroke.points[0];
    g.moveTo(first.x * pxW, first.y * pxH);
    for (let i = 1; i < stroke.points.length; i += 1) {
      const p = stroke.points[i];
      g.lineTo(p.x * pxW, p.y * pxH);
    }
    g.stroke();
  }

  // 呼び出し元が次に何を描いても影響が出ないよう既定へ戻す
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}
