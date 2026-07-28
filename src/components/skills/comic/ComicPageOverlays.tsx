/**
 * ページ上のオーバーレイ（吹き出し・擬音）。
 *
 * 吹き出しは「SVG 背景シェイプ（絶対配置・inset-0）+ 縦書き HTML テキスト」の2層。
 * CSS クリップパス単体では枠線が描けず、border-radius 単体では楕円・トゲが作れないため、
 * 形は SVG（viewBox 0-100 / preserveAspectRatio="none" / vectorEffect="non-scaling-stroke"）
 * に一本化する。頂点は balloonShapes.ts が単一の真実（表示と書き出しで共用）。
 *
 * しっぽ（話者を指すツノ）は、生成画像内の話者位置を決定論で知る手段が無いため v1 では付けない。
 *
 * 擬音は SVG <text> の白塗り + 黒縁（paint-order: stroke）。画像への AI 焼き込みは
 * 検品も再現もできないため使わない。文字は決定論領域なのでコード描画が正しい。
 * 回転・倍率・字間・フォント px はすべて balloonLayout.ts の intent 表から導く
 * （表示と書き出しが同じ定数を読む = 見たとおりに書き出される）。
 */

import {
  BALLOON_PADDING,
  BALLOON_STROKE_PX,
  balloonPoints,
} from "../../../lib/comic/balloonShapes";
import {
  BALLOON_FONT_FAMILY,
  BALLOON_FONT_WEIGHT,
  SFX_AUTO_SLOTS,
  SFX_FONT_FAMILY,
  SFX_LETTER_SPACING,
  SFX_STROKE_RATIO,
  balloonAutoPlacement,
  balloonFontSize,
  sfxBoxSize,
  sfxFontPx,
  type SlotShapeClass,
} from "../../../lib/comic/balloonLayout";
import type { ComicBalloon, ComicSfx } from "../../../lib/comic/types";

/**
 * 吹き出し1個。コマ div の中に絶対配置する。
 * `order` は balloons 配列内の位置（0 = 先に話す = 右上）。
 */
export function BalloonView({
  balloon,
  order,
  shape,
}: {
  balloon: ComicBalloon;
  order: number;
  shape: SlotShapeClass;
}) {
  // 空テキスト・非表示はページに出さない（編集途中の行がページを汚さない）。
  if (!balloon.visible || !balloon.text.trim()) return null;

  const auto = balloonAutoPlacement(shape, order);
  // pos が数値のとき（ドラッグ確定後）は left/top のみ。null のときは自動スロット。
  const positionStyle: React.CSSProperties = balloon.pos
    ? {
        left: `${balloon.pos.x}%`,
        top: `${balloon.pos.y}%`,
        maxWidth: auto.maxWidth,
        maxHeight: auto.maxHeight,
      }
    : {
        left: auto.left,
        right: auto.right,
        top: auto.top,
        bottom: auto.bottom,
        maxWidth: auto.maxWidth,
        maxHeight: auto.maxHeight,
      };

  const pad = BALLOON_PADDING[balloon.kind];
  const points = balloonPoints(balloon.kind);

  return (
    <div
      data-balloon-id={balloon.id}
      className="absolute select-none"
      style={positionStyle}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {points ? (
          <polygon
            points={points.map((p) => p.join(",")).join(" ")}
            fill="rgba(255,255,255,0.95)"
            stroke="#000"
            strokeWidth={BALLOON_STROKE_PX}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <ellipse
            cx={50}
            cy={50}
            rx={49}
            ry={49}
            fill="rgba(255,255,255,0.95)"
            stroke="#000"
            strokeWidth={BALLOON_STROKE_PX}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div
        className="relative overflow-hidden leading-snug whitespace-pre-wrap text-black [writing-mode:vertical-rl] [text-orientation:upright]"
        style={{
          padding: `${pad.y}px ${pad.x}px`,
          fontSize: balloonFontSize(balloon.text),
          fontFamily: BALLOON_FONT_FAMILY,
          fontWeight: BALLOON_FONT_WEIGHT[balloon.kind],
        }}
      >
        {balloon.text}
      </div>
    </div>
  );
}

/**
 * 擬音1個。コマ div の中に絶対配置し、intent 由来の回転をかける。
 *
 * 白塗り + 黒縁は `paint-order: stroke`（縁を先に描いて塗りで上書き）で作る。
 * これが無いと縁が文字の内側へ食い込んで細字に見える。
 * `order` は sfx 配列内の位置（自動スロットの選択に使う）。
 */
export function SfxView({ sfx, order }: { sfx: ComicSfx; order: number }) {
  // 空テキスト・非表示はページに出さない（編集途中の行がページを汚さない）。
  if (!sfx.visible || !sfx.text.trim()) return null;

  const fontPx = sfxFontPx(sfx.text, sfx.scale);
  const { w, h } = sfxBoxSize(sfx.text, sfx.intent, fontPx);
  const slot = SFX_AUTO_SLOTS[Math.min(order, SFX_AUTO_SLOTS.length - 1)];
  const pos = sfx.pos ?? slot;

  return (
    <div
      data-sfx-id={sfx.id}
      className="absolute select-none"
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        width: w,
        height: h,
        transform: `rotate(${sfx.rotation}deg)`,
      }}
    >
      <svg width={w} height={h} className="overflow-visible">
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fill="#fff"
          stroke="#000"
          strokeWidth={fontPx * SFX_STROKE_RATIO}
          strokeLinejoin="round"
          style={{ paintOrder: "stroke" }}
          fontFamily={SFX_FONT_FAMILY}
          fontWeight={900}
          fontSize={fontPx}
          letterSpacing={`${SFX_LETTER_SPACING[sfx.intent]}em`}
        >
          {sfx.text}
        </text>
      </svg>
    </div>
  );
}

/**
 * 1コマ分のオーバーレイ（吹き出し最大2個・擬音最大2個）。
 * どちらも空配列＝無言・無音のコマなら何も描かない。
 */
export function PanelOverlays({
  balloons,
  sfx,
  shape,
}: {
  balloons: ComicBalloon[];
  sfx: ComicSfx[];
  shape: SlotShapeClass;
}) {
  if (balloons.length === 0 && sfx.length === 0) return null;
  return (
    <>
      {/* 擬音を先に置き、吹き出しを上に重ねる（セリフが擬音に隠れないように）。 */}
      {sfx.map((item, i) => (
        <SfxView key={item.id} sfx={item} order={i} />
      ))}
      {balloons.map((balloon, i) => (
        <BalloonView key={balloon.id} balloon={balloon} order={i} shape={shape} />
      ))}
    </>
  );
}
