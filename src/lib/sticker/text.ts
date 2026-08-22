/**
 * スタンプへの文字入れ（決定論・エンジン描画）。
 *
 * ## AIに文字を描かせない（設計書 v3 §1.3）
 *
 * `promptStyles.ts` の `NO_TEXT_CLAUSE` は生成側で文字を禁じている。理由は実測2つ:
 * (1) 審査NG「単純なテキストのみの画像」を踏むリスク、(2) AIに日本語を描かせると崩れる
 * （漢字は透過時に欠け、白文字は背景ごと抜ける）。
 *
 * この層はその方針を**変えない**。生成には文字を入れず、**抜いたあとの透過PNGへ
 * Canvas 2D で焼く**。フォント・サイズ・色は人が決め、描くのは機械なので崩れない。
 *
 * ## `edit/textRender.ts` を使わず薄く自前で持つ理由
 *
 * 編集タブの `renderTextLayer` は `fillText` だけで**縁取り（stroke）を持たない**。
 * スタンプは透過PNGの上に乗るため、トーク画面の背景（白・黒・写真）次第で
 * 文字が消える。白フチは実務上の必須要件であって好みではない。
 *
 * `textRender.ts` 本体は編集タブの正本なので**触らない**（他スキルへの退行ゼロ）。
 * ここでは stroke を持つ最小の描画関数だけを持ち、**配置の計算は純関数に分離**して
 * Canvas 無しで検査できるようにする（jsdom に Canvas 2D が無いため、
 * 余白の安全性はレイアウト計算の側で守る）。
 *
 * ## 余白（padding）を侵さないための設計（最重要）
 *
 * 書き出しの `normalize_sticker`（`src-tauri/src/commands/sticker.rs`）は
 * **アルファのバウンディングボックスで切り抜かない**。元画像を丸ごと
 * `(maxW - padding*2) × (maxH - padding*2)` へ縮めて中央へ置く。
 * 一方で層Aの `margin-short` は**アルファ bbox** と外枠の距離を測る。
 *
 * つまり「作業画像の端に触れている不透明画素」は、書き出し後にちょうど
 * `padding` px の位置に来る。**ちょうどは危うい**（Lanczos 縮小の端の減衰・
 * 丸めで 1px 揺れる）。したがってこの層は、作業画像の側で
 * **`padding` を作業画像の縮尺へ引き戻した安全余白**を確保する。
 * 定数 `10` はここに書かず、必ず `STICKER_SPECS` から引く。
 */
import { STICKER_SPECS, type StickerCategory } from "./spec";

/** 文字の縦位置。ドラッグ自由配置は作らない（過剰。設計の粒度を守る）。 */
export type StickerTextPosition = "top" | "bottom";

/** 文字と、その後ろへ置く装飾をまとめた見た目。 */
export type StickerTextStyleId =
  | "outline"
  | "roundBubble"
  | "roundedBubble"
  | "shoutBubble"
  | "captionBand";

/** 初心者が名前と見本だけで選べる5種類。並び順は画面の順番でもある。 */
export const STICKER_TEXT_STYLE_PRESETS: ReadonlyArray<{
  id: StickerTextStyleId;
  label: string;
}> = [
  { id: "outline", label: "文字だけ（白フチ太文字）" },
  { id: "roundBubble", label: "丸吹き出し" },
  { id: "roundedBubble", label: "角丸吹き出し" },
  { id: "shoutBubble", label: "叫び（トゲトゲ）" },
  { id: "captionBand", label: "下帯（テロップ風）" },
];

/** プリセットを選んだ直後に成立する色。細かな色選びは必須にしない。 */
export function defaultColorsForStickerTextStyle(styleId: StickerTextStyleId): {
  backgroundColor: string;
  color: string;
  outlineColor: string;
} {
  if (styleId === "outline") {
    return {
      backgroundColor: "#ffffff",
      color: "#222222",
      outlineColor: "#ffffff",
    };
  }
  return {
    backgroundColor: "#ffffff",
    color: "#222222",
    outlineColor: "#222222",
  };
}

/** 1枚に焼く文字の指定。 */
export type StickerTextSpec = {
  text: string;
  styleId: StickerTextStyleId;
  /** システムフォントの family 名（`editFonts.list` の `family`）。 */
  fontFamily: string;
  /** 文字の高さ（作業画像のピクセル基準ではなく、画像の短辺に対する比で持つ）。 */
  sizeRatio: number;
  color: string;
  /** 吹き出し・帯の地色。文字だけのときは使わない。 */
  backgroundColor: string;
  /** 縁取り（白フチ）。既定ON。透過PNGの上に乗るので、無いとトーク背景で読めない。 */
  outline: boolean;
  outlineColor: string;
  position: StickerTextPosition;
};

/** 文字の高さの比（画像の短辺に対する割合）。UIのスライダの3段。 */
export const STICKER_TEXT_SIZE_RATIOS = {
  small: 0.09,
  medium: 0.13,
  large: 0.18,
} as const;

export type StickerTextSizeId = keyof typeof STICKER_TEXT_SIZE_RATIOS;

/** 既定値。**縁取りは既定ON**（LINEスタンプの実務標準）。 */
export const DEFAULT_STICKER_TEXT: Omit<StickerTextSpec, "text"> = {
  styleId: "outline",
  fontFamily: "system-ui",
  sizeRatio: STICKER_TEXT_SIZE_RATIOS.medium,
  color: "#222222",
  backgroundColor: "#ffffff",
  outline: true,
  outlineColor: "#ffffff",
  position: "bottom",
};

/**
 * 縁取りの太さ（フォントサイズに対する比）。
 *
 * 細すぎると背景に負け、太すぎると字が潰れる。`lineJoin: "round"` と併用して、
 * 画数の多い漢字でも内側が埋まらない範囲に置く。
 */
export const OUTLINE_WIDTH_RATIO = 0.18;

/** 吹き出しの余白と線幅。すべて文字サイズに連動させる。 */
const DECORATION_PADDING_Y_RATIO = 0.34;
const CAPTION_PADDING_Y_RATIO = 0.28;
const DECORATION_STROKE_RATIO = 0.08;

/**
 * 作業画像の側で確保すべき安全余白（px）。
 *
 * 書き出し時の縮小率は `padding` を引いた内側へ収める比なので、
 * 「作業画像の1px」は書き出し後に `scale` px になる。逆に言えば、書き出し後に
 * `padding` px を残したいなら作業画像では `padding / scale` px 空ける必要がある。
 *
 * `scale` は `normalize_sticker` と同じ式（拡大禁止・contain）で求める。
 * **`10` を直接書かない**（`STICKER_SPECS` から引く。規律3）。
 *
 * @param imageWidth 作業画像の幅（生成直後の実寸。1024級）。
 * @param imageHeight 作業画像の高さ。
 * @param category 規格カテゴリ。既定は v1 で使う通常スタンプ。
 */
export function safeMarginPx(
  imageWidth: number,
  imageHeight: number,
  category: StickerCategory = "normal",
): number {
  const spec = STICKER_SPECS[category];
  if (spec.padding <= 0) return 0;
  if (imageWidth <= 0 || imageHeight <= 0) return spec.padding;

  const innerW = Math.max(1, spec.maxWidth - spec.padding * 2);
  const innerH = Math.max(1, spec.maxHeight - spec.padding * 2);
  // `normalize_sticker` と同じ contain + 拡大禁止。
  const scale = Math.min(innerW / imageWidth, innerH / imageHeight, 1);
  if (scale <= 0) return spec.padding;

  // 書き出し後に padding px を残すために、作業画像で空けるべき px。
  // 端のちょうどは危ういので切り上げる（丸め・リサンプルの揺れを内側へ吸収）。
  return Math.ceil(spec.padding / scale);
}

/** 文字を描く位置と大きさ（Canvas に渡す実座標）。 */
export type StickerTextLayout = {
  /** 描画の基準 x（`textAlign: "center"` の中心）。 */
  x: number;
  /** 描画の基準 y（`textBaseline: "top"` の上端）。 */
  y: number;
  fontSizePx: number;
  outlineWidthPx: number;
  decorationStrokePx: number;
  decorationPaddingYPx: number;
  /** 実際に確保した安全余白（検査・テスト用に返す）。 */
  marginPx: number;
  /** 文字が占める帯の上端・下端（余白判定に使う）。 */
  bandTop: number;
  bandBottom: number;
};

/**
 * 文字の配置を決める**純関数**（Canvas に依存しない）。
 *
 * 余白を侵さないことをここで保証する:
 *
 * 1. フォントサイズは「安全域の高さ」を超えないよう頭打ちにする
 * 2. 上下位置は安全域の内側へクランプする
 * 3. 結果として `bandTop >= marginPx` かつ `bandBottom <= height - marginPx` になる
 *
 * 横方向は `textAlign: "center"` で中心に置き、はみ出しは `maxWidth` 引数
 * （`fillText` の第4引数）で機械的に潰す（`drawStickerText` 側）。
 */
export function layoutStickerText(
  imageWidth: number,
  imageHeight: number,
  spec: Pick<StickerTextSpec, "sizeRatio" | "position"> &
    Partial<Pick<StickerTextSpec, "styleId">>,
  category: StickerCategory = "normal",
): StickerTextLayout {
  const marginPx = safeMarginPx(imageWidth, imageHeight, category);
  const safeH = Math.max(0, imageHeight - marginPx * 2);

  const shortSide = Math.min(imageWidth, imageHeight);
  const requested = Math.max(1, Math.round(shortSide * spec.sizeRatio));

  /**
   * 安全域より大きい文字は入らない。要求より小さくしてでも余白を守る
   * （余白は規格、文字サイズは好み。**規格が勝つ**）。
   *
   * ## 下限を 1px にしない（2026-08-05 実測で修正）
   *
   * 「最低でも 1px は描く」と `Math.max(1, ...)` を置くと、安全域が 0 の画像
   * （余白の2倍が画像の高さ以上＝極端に平たい絵）で**必ず余白を侵す**。
   * 文字は縁取りの分だけさらに外へ広がるので、1px でも規格違反になる。
   *
   * 入る余地が無いなら 0 にして**描かない**のが筋（`drawStickerText` は
   * 空文字と同じく何も描かない）。1px の文字は読めもしないので、
   * 「読めない文字のために規格を割る」という取引には何の得も無い。
   *
   * 縁取りも文字サイズ比なので、0 なら自動的に 0 になる（外へはみ出さない）。
   */
  const styleId = spec.styleId ?? "outline";
  const decorated = styleId !== "outline";
  const paddingRatio = styleId === "captionBand"
    ? CAPTION_PADDING_Y_RATIO
    : DECORATION_PADDING_Y_RATIO;
  const heightRatio = decorated
    ? 1 + paddingRatio * 2 + DECORATION_STROKE_RATIO
    : 1 + OUTLINE_WIDTH_RATIO;
  const available = Math.floor(safeH);
  const maxFontSize = Math.floor(available / heightRatio);
  const fontSizePx = maxFontSize <= 0 ? 0 : Math.max(1, Math.min(requested, maxFontSize));
  const outlineWidthPx = fontSizePx * OUTLINE_WIDTH_RATIO;
  const decorationStrokePx = decorated && fontSizePx > 0
    ? Math.max(1, fontSizePx * DECORATION_STROKE_RATIO)
    : 0;
  const decorationPaddingYPx = decorated ? fontSizePx * paddingRatio : 0;

  const renderedHeight = decorated
    ? fontSizePx + decorationPaddingYPx * 2 + decorationStrokePx
    : fontSizePx + outlineWidthPx;
  const bandTop = spec.position === "top"
    ? marginPx
    : Math.max(marginPx, imageHeight - marginPx - renderedHeight);
  const bandBottom = bandTop + renderedHeight;
  // y は文字の上端。装飾ありなら、外周線と内側余白のぶんだけ下げる。
  const y = decorated
    ? bandTop + decorationStrokePx / 2 + decorationPaddingYPx
    : bandTop + outlineWidthPx / 2;

  return {
    x: imageWidth / 2,
    y,
    fontSizePx,
    outlineWidthPx,
    decorationStrokePx,
    decorationPaddingYPx,
    marginPx,
    bandTop,
    bandBottom,
  };
}

/**
 * 文字が余白を侵していないか（層Aの `margin-short` と同じ向きの判定）。
 *
 * `layoutStickerText` が正しければ常に true。テストが**牙**として使う
 * （わざと余白を侵す入力を与えたとき false になることを確かめる）。
 */
export function textFitsWithinMargin(
  imageWidth: number,
  imageHeight: number,
  layout: Pick<StickerTextLayout, "bandTop" | "bandBottom" | "marginPx">,
): boolean {
  if (imageWidth <= 0 || imageHeight <= 0) return false;
  return (
    layout.bandTop >= layout.marginPx &&
    layout.bandBottom <= imageHeight - layout.marginPx
  );
}

export type StickerDecorationBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 文字を横へつぶさず置ける最大幅。長文だけは Canvas がここまで縮める。 */
  textMaxWidthPx: number;
};

/**
 * 実測した文字幅から、後ろの吹き出し・帯の大きさを決める純関数。
 * 外枠は必ず `safeMarginPx` の内側に収める。
 */
export function layoutStickerDecoration(
  imageWidth: number,
  styleId: StickerTextStyleId,
  measuredTextWidth: number,
  layout: StickerTextLayout,
): StickerDecorationBounds | null {
  if (styleId === "outline" || layout.fontSizePx <= 0) return null;

  const safeWidth = Math.max(0, imageWidth - layout.marginPx * 2);
  if (safeWidth <= 0) return null;
  const measured = Number.isFinite(measuredTextWidth)
    ? Math.max(0, measuredTextWidth)
    : 0;
  const horizontalPaddingRatio = styleId === "roundBubble"
    ? 0.62
    : styleId === "shoutBubble"
      ? 0.72
      : 0.46;
  const paddingX = layout.fontSizePx * horizontalPaddingRatio;

  const width = styleId === "captionBand"
    ? safeWidth
    : Math.min(
        safeWidth,
        Math.max(
          layout.fontSizePx * 1.8,
          measured + paddingX * 2 + layout.decorationStrokePx,
        ),
      );
  const height = Math.max(0, layout.bandBottom - layout.bandTop);
  return {
    x: layout.marginPx + (safeWidth - width) / 2,
    y: layout.bandTop,
    width,
    height,
    textMaxWidthPx: Math.max(
      1,
      width - paddingX * 2 - layout.decorationStrokePx,
    ),
  };
}

/** 装飾の外枠が規格由来の安全余白から出ていないか。 */
export function decorationFitsWithinMargin(
  imageWidth: number,
  imageHeight: number,
  marginPx: number,
  bounds: StickerDecorationBounds | null,
): boolean {
  if (!bounds) return true;
  return (
    bounds.x >= marginPx
    && bounds.y >= marginPx
    && bounds.x + bounds.width <= imageWidth - marginPx
    && bounds.y + bounds.height <= imageHeight - marginPx
  );
}

export type StickerPoint = { x: number; y: number };

/** 「叫び」のトゲトゲ外周。入力だけで結果が決まるので Canvas 無しで検査できる。 */
export function buildShoutBubblePoints(
  bounds: Pick<StickerDecorationBounds, "x" | "y" | "width" | "height">,
  inset = 0,
  spikes = 12,
): StickerPoint[] {
  const count = Math.max(4, Math.floor(spikes));
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const outerX = Math.max(0, bounds.width / 2 - inset);
  const outerY = Math.max(0, bounds.height / 2 - inset);
  const points: StickerPoint[] = [];
  for (let index = 0; index < count * 2; index += 1) {
    const angle = -Math.PI / 2 + (Math.PI * index) / count;
    const radius = index % 2 === 0 ? 1 : 0.76;
    points.push({
      x: cx + Math.cos(angle) * outerX * radius,
      y: cy + Math.sin(angle) * outerY * radius,
    });
  }
  return points;
}

/** `drawStickerText` が受ける最小の Canvas インターフェース（テストで差し替える継ぎ目）。 */
export type TextCanvas2D = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "fillText"
  | "strokeText"
  | "measureText"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "ellipse"
  | "rect"
  | "fill"
  | "stroke"
> & {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

function roundedRectPath(
  ctx: TextCanvas2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

/** 文字より先に、吹き出しまたは帯を描く。 */
function drawStickerDecoration(
  ctx: TextCanvas2D,
  spec: StickerTextSpec,
  layout: StickerTextLayout,
  bounds: StickerDecorationBounds,
): void {
  const halfStroke = layout.decorationStrokePx / 2;
  const x = bounds.x + halfStroke;
  const y = bounds.y + halfStroke;
  const width = Math.max(0, bounds.width - layout.decorationStrokePx);
  const height = Math.max(0, bounds.height - layout.decorationStrokePx);
  if (width <= 0 || height <= 0) return;

  ctx.beginPath();
  if (spec.styleId === "roundBubble") {
    ctx.ellipse(
      x + width / 2,
      y + height / 2,
      width / 2,
      height / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (spec.styleId === "roundedBubble") {
    roundedRectPath(ctx, x, y, width, height, height * 0.28);
  } else if (spec.styleId === "shoutBubble") {
    const points = buildShoutBubblePoints(bounds, halfStroke);
    const first = points[0];
    if (!first) return;
    ctx.moveTo(first.x, first.y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  } else {
    ctx.rect(x, y, width, height);
  }
  ctx.closePath();
  ctx.fillStyle = spec.backgroundColor;
  ctx.fill();
  ctx.strokeStyle = spec.outlineColor;
  ctx.lineWidth = layout.decorationStrokePx;
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.stroke();
}

/**
 * 文字を1本描く（縁取り → 塗りの順）。
 *
 * 順序は入れ替えられない。`strokeText` を後に描くと線幅の内側半分が字の上に乗り、
 * 画数の多い漢字が潰れる。**外側の輪郭を先に置いてから中を塗る**。
 *
 * 横幅は `maxWidth` で機械的に詰める（安全域の幅を超えたら文字が縮む）。
 * はみ出させないことを描画APIの側で保証する。
 */
export function drawStickerText(
  ctx: TextCanvas2D,
  spec: StickerTextSpec,
  layout: StickerTextLayout,
  imageWidth: number,
): void {
  const text = spec.text.trim();
  if (!text) return;
  // 入る余地が無い（安全域 0）。描くと必ず余白を侵すので描かない。
  // `layoutStickerText` が 0 を返した場合だけここへ来る。
  if (layout.fontSizePx <= 0) return;

  ctx.save();
  ctx.font = `bold ${layout.fontSizePx}px "${spec.fontFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const measuredTextWidth = ctx.measureText(text).width;
  const decoration = layoutStickerDecoration(
    imageWidth,
    spec.styleId,
    measuredTextWidth,
    layout,
  );
  if (decoration) drawStickerDecoration(ctx, spec, layout, decoration);

  const maxTextWidth = decoration?.textMaxWidthPx
    ?? Math.max(1, imageWidth - layout.marginPx * 2);
  if (spec.styleId === "outline" && spec.outline) {
    ctx.strokeStyle = spec.outlineColor;
    ctx.lineWidth = layout.outlineWidthPx;
    // 角を丸めないと、画数の多い字で線の交点が尖って飛び出す。
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(text, layout.x, layout.y, maxTextWidth);
  }
  ctx.fillStyle = spec.color;
  ctx.fillText(text, layout.x, layout.y, maxTextWidth);
  ctx.restore();
}

/**
 * 透過PNG（Blob）へ文字を焼いて、新しい透過PNG（Blob）を返す。
 *
 * ## 透過を壊さない
 *
 * キャンバスは透明で初期化し、元画像を `drawImage` してから文字を乗せる。
 * 背景色で初期化すると透過が焼き付く（`normalize_sticker` のコメントが
 * 記録している「`overlay` は置換でなくアルファ合成」と同型の事故）。
 *
 * ## 元画像を保持する呼び出し側の責務
 *
 * この関数は**常に元 Blob から作り直す**。文字入り画像へさらに文字を焼くと
 * 前の文字が残って重なるので、呼び出し側は「文字入れ前のパス」を保持し、
 * 入れ直しのたびにそこから焼くこと（`StickerWorkspace` の `textBaseRef`）。
 */
export async function renderStickerText(
  baseImage: Blob,
  spec: StickerTextSpec,
  category: StickerCategory = "normal",
): Promise<Blob> {
  const url = URL.createObjectURL(baseImage);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    // 透明で初期化された状態のまま元画像を置く（背景色で塗らない）。
    ctx.drawImage(img, 0, 0);

    const layout = layoutStickerText(canvas.width, canvas.height, spec, category);
    drawStickerText(ctx as unknown as TextCanvas2D, spec, layout, canvas.width);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * 文字入れ後の保存先パスを作る（元画像の隣に `-text.png` で置く）。
 *
 * **元画像を上書きしない**。上書きすると「文字を消す（元に戻す）」ができなくなる
 * うえ、焼き直しのたびに前の文字の上へ重なる。元は必ず残す。
 *
 * 拡張子の有無に関わらず末尾を `-text.png` に揃える（クロマキー後は必ず PNG）。
 */
export function textOutputPath(basePath: string, variant?: string): string {
  const suffix = variant ? `-${variant}` : "";
  return `${basePath.replace(/\.[^.\\/]+$/, "")}${suffix}-text.png`;
}

/**
 * 同じ原本へ見た目を入れ直したときも、サムネイルのパスが変わる短い識別子。
 * 画像内容の秘密性には使わず、ブラウザの画像キャッシュを避けるためだけに使う。
 */
export function stickerTextVariant(spec: StickerTextSpec): string {
  const value = JSON.stringify([
    spec.text,
    spec.styleId,
    spec.fontFamily,
    spec.sizeRatio,
    spec.color,
    spec.backgroundColor,
    spec.outline,
    spec.outlineColor,
    spec.position,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * ファイルパスの画像へ文字を焼き、**新しいファイルへ書いてそのパスを返す**。
 *
 * ## `asset://` を Image に読ませない（CORS 汚染の回避）
 *
 * `convertFileSrc` の URL を `Image` に読ませると canvas が汚染され、
 * `toBlob` が "The operation is insecure." で落ちる。comic の `savePage.ts` は
 * `crossOrigin = "anonymous"` で回避しているが、ここでは**そもそも HTTP を経由せず**
 * `plugin-fs` でバイト列を読んで `Blob` にする。読み込み経路が1つ減るぶん、
 * CORS ヘッダの有無という外部条件に依存しない（同じ結果をより少ない前提で得る）。
 *
 * @param basePath 文字を入れる前の画像（透過PNG）の絶対パス。
 * @returns 書いた新しいファイルの絶対パス。
 */
export async function applyStickerTextToFile(
  basePath: string,
  spec: StickerTextSpec,
  category: StickerCategory = "normal",
): Promise<string> {
  const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(basePath);
  // `Blob` にしてから `renderStickerText` へ渡す（blob: URL は同一オリジンなので
  // canvas を汚染しない）。
  const baseBlob = new Blob([new Uint8Array(bytes)], { type: "image/png" });

  const rendered = await renderStickerText(baseBlob, spec, category);

  const dest = textOutputPath(basePath, stickerTextVariant(spec));
  await writeFile(dest, new Uint8Array(await rendered.arrayBuffer()));
  return dest;
}
