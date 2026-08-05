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

/** 1枚に焼く文字の指定。 */
export type StickerTextSpec = {
  text: string;
  /** システムフォントの family 名（`editFonts.list` の `family`）。 */
  fontFamily: string;
  /** 文字の高さ（作業画像のピクセル基準ではなく、画像の短辺に対する比で持つ）。 */
  sizeRatio: number;
  color: string;
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
  fontFamily: "system-ui",
  sizeRatio: STICKER_TEXT_SIZE_RATIOS.medium,
  color: "#222222",
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
  spec: Pick<StickerTextSpec, "sizeRatio" | "position">,
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
  const available = Math.floor(safeH);
  const fontSizePx = available <= 0 ? 0 : Math.max(1, Math.min(requested, available));
  const outlineWidthPx = fontSizePx * OUTLINE_WIDTH_RATIO;

  // 縁取りは文字の外側へ半分はみ出す（`strokeText` は線幅の中心が輪郭）。
  // 帯の上下端はその分だけ外へ広がるので、余白の判定に必ず含める。
  const halfStroke = outlineWidthPx / 2;

  const topLimit = marginPx + halfStroke;
  const bottomLimit = imageHeight - marginPx - halfStroke - fontSizePx;

  const rawY = spec.position === "top" ? topLimit : bottomLimit;
  // 安全域が文字より狭いときは topLimit が bottomLimit を上回る。その場合も
  // 上端側へ寄せて必ず安全域の内側に留める（はみ出すくらいなら詰める）。
  const y = Math.min(Math.max(rawY, topLimit), Math.max(topLimit, bottomLimit));

  return {
    x: imageWidth / 2,
    y,
    fontSizePx,
    outlineWidthPx,
    marginPx,
    bandTop: y - halfStroke,
    bandBottom: y + fontSizePx + halfStroke,
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

/** `drawStickerText` が受ける最小の Canvas インターフェース（テストで差し替える継ぎ目）。 */
export type TextCanvas2D = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "fillText"
  | "strokeText"
  | "measureText"
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

  const maxTextWidth = Math.max(1, imageWidth - layout.marginPx * 2);

  ctx.save();
  ctx.font = `bold ${layout.fontSizePx}px "${spec.fontFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if (spec.outline) {
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
export function textOutputPath(basePath: string): string {
  return `${basePath.replace(/\.[^.\\/]+$/, "")}-text.png`;
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

  const dest = textOutputPath(basePath);
  await writeFile(dest, new Uint8Array(await rendered.arrayBuffer()));
  return dest;
}
