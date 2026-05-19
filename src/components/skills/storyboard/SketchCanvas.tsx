import { useEffect, useRef } from "react";

import type {
  StoryboardAspectRatio,
  StoryboardCameraAngle,
  StoryboardCameraMotion,
  StoryboardGazeDirection,
  StoryboardShotType,
  StoryboardSketchCut,
  StoryboardSubjectPosition,
} from "../../../lib/storyboard/types";

type Props = {
  cut: StoryboardSketchCut;
  aspectRatio: StoryboardAspectRatio;
  /** カット番号などの枠外ラベルを描画するか。デフォルト true。 */
  showLabels?: boolean;
};

/**
 * Canvas で「スケッチ風」の絵コンテを描画するコンポーネント。
 *
 * STΛCK 指示 (2026-05-20):
 *   - 絵コンテは AI で作らない (本番と被るのを避ける)
 *   - テキストだけだと物足りないので、Canvas で構造化された絵コンテを自前描画
 *   - スケッチ風 (鉛筆・線画) で「これは絵コンテ」と分かるルック
 *   - カット割り情報 (shot_type, camera_angle, subject_position 等) を反映
 *
 * 設計:
 *   - 軽量: GPU/AI を使わず Canvas 2D だけで描画
 *   - 構造化: shotType でキャラの大きさ、cameraAngle で枠の歪み、
 *     subjectPosition で配置、gazeDirection で視線矢印、
 *     cameraMotion でカメラベクトル矢印を表現
 *   - 手書き感: 線にジッターを乗せて鉛筆風に
 *   - 構造化メタが無いカットは intent から推論
 */
export function SketchCanvas({ cut, aspectRatio, showLabels = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawSketch(canvas, cut, aspectRatio, showLabels);
  }, [cut, aspectRatio, showLabels]);

  // アスペクト比に応じたキャンバスサイズ (CSS px)
  const { w, h } = sizeForAspect(aspectRatio);

  return (
    <canvas
      ref={canvasRef}
      width={w * 2}
      height={h * 2}
      style={{ width: w, height: h }}
      className="rounded-md bg-[#fcfbf5]"
    />
  );
}

// ============================================================
// サイズ・座標系
// ============================================================
function sizeForAspect(a: StoryboardAspectRatio): { w: number; h: number } {
  const base = 640;
  switch (a) {
    case "9:16":
      return { w: 360, h: base };
    case "1:1":
      return { w: base, h: base };
    case "4:5":
      return { w: 512, h: base };
    case "16:9":
    default:
      return { w: base, h: 360 };
  }
}

// ============================================================
// 構造化メタの推論 (AI から取れなかった場合のフォールバック)
// ============================================================
function inferShotType(cut: StoryboardSketchCut): StoryboardShotType {
  if (cut.shotType) return cut.shotType;
  const t = (cut.intent + cut.cameraNote).toLowerCase();
  if (/close|寄り|クローズアップ|アップ/.test(t)) return "close";
  if (/wide|引き|ワイド|遠景/.test(t)) return "wide";
  if (/full|全身/.test(t)) return "full";
  if (/extreme|大引き|超寄り/.test(t)) return "extreme_close";
  return "medium";
}

function inferAngle(cut: StoryboardSketchCut): StoryboardCameraAngle {
  if (cut.cameraAngle) return cut.cameraAngle;
  const t = (cut.intent + cut.cameraNote).toLowerCase();
  if (/俯瞰|上から|high.angle|bird/.test(t)) return "high";
  if (/煽り|下から|low.angle/.test(t)) return "low";
  if (/横|side|プロフィール/.test(t)) return "side";
  if (/後ろ|背中|back/.test(t)) return "back";
  return "front";
}

function inferPosition(cut: StoryboardSketchCut): StoryboardSubjectPosition {
  if (cut.subjectPosition) return cut.subjectPosition;
  const t = cut.intent;
  if (/左/.test(t)) return "left";
  if (/右/.test(t)) return "right";
  return "center";
}

function inferGaze(cut: StoryboardSketchCut): StoryboardGazeDirection {
  if (cut.gazeDirection) return cut.gazeDirection;
  const t = cut.intent.toLowerCase();
  if (/カメラ目線|to.camera|正面を見|こちらを/.test(t)) return "to_camera";
  if (/左/.test(t)) return "left";
  if (/右/.test(t)) return "right";
  if (/上/.test(t)) return "up";
  if (/下|うつむ/.test(t)) return "down";
  return "to_camera";
}

function inferMotion(cut: StoryboardSketchCut): StoryboardCameraMotion {
  if (cut.cameraMotion) return cut.cameraMotion;
  const t = (cut.intent + cut.cameraNote).toLowerCase();
  if (/ドリー.イン|前進|寄っていく/.test(t)) return "dolly_in";
  if (/ドリー.アウト|後退|引いていく/.test(t)) return "dolly_out";
  if (/パン.*左|pan.left/.test(t)) return "pan_left";
  if (/パン.*右|pan.right/.test(t)) return "pan_right";
  if (/手持ち|ハンディ|handheld/.test(t)) return "handheld";
  return "static";
}

// ============================================================
// 描画本体
// ============================================================
function drawSketch(
  canvas: HTMLCanvasElement,
  cut: StoryboardSketchCut,
  _aspect: StoryboardAspectRatio,
  showLabels: boolean,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Retina 対応: backing scale = 2
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const W = canvas.width / 2;
  const H = canvas.height / 2;

  // 背景: 紙色
  ctx.fillStyle = "#fcfbf5";
  ctx.fillRect(0, 0, W, H);

  const shot = inferShotType(cut);
  const angle = inferAngle(cut);
  const pos = inferPosition(cut);
  const gaze = inferGaze(cut);
  const motion = inferMotion(cut);

  const pad = 16;
  const frameX = pad;
  const frameY = pad + (showLabels ? 22 : 0);
  const frameW = W - pad * 2;
  const frameH = H - frameY - (showLabels ? 32 : pad);

  // ── カット枠 (シネマ画面) ──
  drawFrame(ctx, frameX, frameY, frameW, frameH, angle);

  // ── キャラクター ──
  drawCharacter(ctx, frameX, frameY, frameW, frameH, shot, pos, angle, gaze);

  // ── 小道具 ──
  if (cut.props && cut.props.length > 0) {
    drawProps(ctx, frameX, frameY, frameW, frameH, cut.props);
  }

  // ── カメラモーション矢印 ──
  drawMotion(ctx, frameX, frameY, frameW, frameH, motion);

  // ── ラベル (枠外) ──
  if (showLabels) {
    drawLabels(ctx, W, H, cut, frameX, frameY, frameW, frameH, shot, angle, motion);
  }
}

// 鉛筆風: 数本の線を微妙にずらして重ねる
function pencilLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  alpha = 0.85,
  jitter = 1.2,
) {
  ctx.save();
  ctx.strokeStyle = `rgba(40,40,40,${alpha})`;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    const j = () => (Math.random() - 0.5) * jitter;
    ctx.moveTo(x1 + j(), y1 + j());
    // ベジエでわずかな弧
    const cx = (x1 + x2) / 2 + j() * 2;
    const cy = (y1 + y2) / 2 + j() * 2;
    ctx.quadraticCurveTo(cx, cy, x2 + j(), y2 + j());
    ctx.stroke();
  }
  ctx.restore();
}

function pencilCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  alpha = 0.85,
) {
  ctx.save();
  ctx.strokeStyle = `rgba(40,40,40,${alpha})`;
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    const off = (Math.random() - 0.5) * 0.8;
    ctx.arc(cx + off, cy + off, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  angle: StoryboardCameraAngle,
) {
  // ダッチアングルは枠を少し傾ける
  const tilt = angle === "dutch" ? -5 : 0;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((tilt * Math.PI) / 180);
  ctx.translate(-(x + w / 2), -(y + h / 2));

  pencilLine(ctx, x, y, x + w, y);
  pencilLine(ctx, x + w, y, x + w, y + h);
  pencilLine(ctx, x + w, y + h, x, y + h);
  pencilLine(ctx, x, y + h, x, y);

  // 三分割グリッド (薄く)
  ctx.save();
  ctx.strokeStyle = "rgba(60,60,60,0.18)";
  ctx.lineWidth = 0.6;
  ctx.setLineDash([3, 3]);
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
    ctx.stroke();
  }
  ctx.restore();

  // 俯瞰/煽りは下端 or 上端に horizon line を引く
  if (angle === "high" || angle === "low") {
    const horizonY = angle === "high" ? y + h * 0.25 : y + h * 0.75;
    ctx.save();
    ctx.strokeStyle = "rgba(40,40,40,0.45)";
    ctx.lineWidth = 0.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, horizonY);
    ctx.lineTo(x + w, horizonY);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function positionToXY(
  pos: StoryboardSubjectPosition,
  x: number,
  y: number,
  w: number,
  h: number,
): { cx: number; cy: number } {
  // 三分割法的な配置
  const xs = { left: x + w * 0.3, center: x + w * 0.5, right: x + w * 0.7 };
  const ys = { upper: y + h * 0.35, center: y + h * 0.55, lower: y + h * 0.75 };
  switch (pos) {
    case "left":
      return { cx: xs.left, cy: ys.center };
    case "right":
      return { cx: xs.right, cy: ys.center };
    case "upper_left":
      return { cx: xs.left, cy: ys.upper };
    case "upper_right":
      return { cx: xs.right, cy: ys.upper };
    case "lower_left":
      return { cx: xs.left, cy: ys.lower };
    case "lower_right":
      return { cx: xs.right, cy: ys.lower };
    case "center":
    default:
      return { cx: xs.center, cy: ys.center };
  }
}

function shotScale(shot: StoryboardShotType): number {
  switch (shot) {
    case "extreme_close":
      return 1.6;
    case "close":
      return 1.2;
    case "medium":
      return 0.9;
    case "full":
      return 0.65;
    case "wide":
      return 0.45;
    case "extreme_wide":
      return 0.3;
  }
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  shot: StoryboardShotType,
  pos: StoryboardSubjectPosition,
  angle: StoryboardCameraAngle,
  gaze: StoryboardGazeDirection,
) {
  const { cx, cy } = positionToXY(pos, x, y, w, h);
  const scale = shotScale(shot) * (h / 360); // フレーム高さに比例
  const headR = 14 * scale;
  // 顔
  pencilCircle(ctx, cx, cy - 18 * scale, headR);

  // 目 (アングルで形を変える)
  ctx.save();
  ctx.fillStyle = "rgba(40,40,40,0.85)";
  const eyeY = cy - 18 * scale + (angle === "high" ? 3 * scale : angle === "low" ? -2 * scale : 0);
  ctx.beginPath();
  ctx.arc(cx - 4 * scale, eyeY, 1.4 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 4 * scale, eyeY, 1.4 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 棒人間ボディ (extreme_close/close は省略)
  if (shot !== "extreme_close" && shot !== "close") {
    const bodyTop = cy - 18 * scale + headR;
    const bodyBottom = bodyTop + 50 * scale;
    // 胴
    pencilLine(ctx, cx, bodyTop, cx, bodyBottom);
    // 腕
    pencilLine(ctx, cx, bodyTop + 6 * scale, cx - 18 * scale, bodyTop + 26 * scale);
    pencilLine(ctx, cx, bodyTop + 6 * scale, cx + 18 * scale, bodyTop + 26 * scale);
    // 脚 (full / wide のみ)
    if (shot === "full" || shot === "wide" || shot === "extreme_wide") {
      pencilLine(ctx, cx, bodyBottom, cx - 12 * scale, bodyBottom + 28 * scale);
      pencilLine(ctx, cx, bodyBottom, cx + 12 * scale, bodyBottom + 28 * scale);
    }
  }

  // 視線矢印
  drawGaze(ctx, cx, cy - 18 * scale, headR, gaze);
}

function drawGaze(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  gaze: StoryboardGazeDirection,
) {
  if (gaze === "off_screen") return;
  const length = r * 2.5;
  let dx = 0;
  let dy = 0;
  switch (gaze) {
    case "to_camera":
      // カメラ目線は外側に短い矢印で点線
      drawArrow(ctx, cx, cy, cx, cy + r * 1.4, "rgba(220,80,120,0.7)", true);
      return;
    case "left":
      dx = -length;
      break;
    case "right":
      dx = length;
      break;
    case "up":
      dy = -length;
      break;
    case "down":
      dy = length;
      break;
  }
  drawArrow(ctx, cx, cy, cx + dx, cy + dy, "rgba(220,80,120,0.7)");
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  dashed = false,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  // ヘッド
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = 6;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - head * Math.cos(ang - Math.PI / 6),
    y2 - head * Math.sin(ang - Math.PI / 6),
  );
  ctx.lineTo(
    x2 - head * Math.cos(ang + Math.PI / 6),
    y2 - head * Math.sin(ang + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawProps(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  _w: number,
  h: number,
  props: string[],
) {
  ctx.save();
  ctx.font = "italic 11px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(60,60,60,0.55)";
  const max = Math.min(props.length, 3);
  for (let i = 0; i < max; i++) {
    ctx.fillText(`· ${props[i]}`, x + 10, y + h - 10 - (max - 1 - i) * 14);
  }
  ctx.restore();
}

function drawMotion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  motion: StoryboardCameraMotion,
) {
  if (motion === "static") return;
  const color = "rgba(60,90,200,0.75)";
  switch (motion) {
    case "pan_left":
      drawArrow(ctx, x + w - 30, y + h - 18, x + w - 90, y + h - 18, color);
      break;
    case "pan_right":
      drawArrow(ctx, x + 30, y + h - 18, x + 90, y + h - 18, color);
      break;
    case "tilt_up":
      drawArrow(ctx, x + w - 18, y + h - 30, x + w - 18, y + 30, color);
      break;
    case "tilt_down":
      drawArrow(ctx, x + w - 18, y + 30, x + w - 18, y + h - 30, color);
      break;
    case "dolly_in":
      // 内向きの 4 本矢印で「寄っていく」を表現
      drawArrow(ctx, x + 10, y + 10, x + 30, y + 30, color);
      drawArrow(ctx, x + w - 10, y + 10, x + w - 30, y + 30, color);
      drawArrow(ctx, x + 10, y + h - 10, x + 30, y + h - 30, color);
      drawArrow(ctx, x + w - 10, y + h - 10, x + w - 30, y + h - 30, color);
      break;
    case "dolly_out":
      drawArrow(ctx, x + 30, y + 30, x + 10, y + 10, color);
      drawArrow(ctx, x + w - 30, y + 30, x + w - 10, y + 10, color);
      drawArrow(ctx, x + 30, y + h - 30, x + 10, y + h - 10, color);
      drawArrow(ctx, x + w - 30, y + h - 30, x + w - 10, y + h - 10, color);
      break;
    case "handheld":
      // 波線で手持ち感
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 20, y + h - 14);
      for (let i = 0; i < 6; i++) {
        ctx.quadraticCurveTo(
          x + 20 + i * 10 + 5,
          y + h - 14 + (i % 2 === 0 ? -4 : 4),
          x + 20 + (i + 1) * 10,
          y + h - 14,
        );
      }
      ctx.stroke();
      ctx.restore();
      break;
  }
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  _W: number,
  _H: number,
  cut: StoryboardSketchCut,
  fx: number,
  fy: number,
  fw: number,
  fh: number,
  shot: StoryboardShotType,
  angle: StoryboardCameraAngle,
  motion: StoryboardCameraMotion,
) {
  ctx.save();
  ctx.font = "bold 13px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(30,30,30,0.9)";
  ctx.textBaseline = "middle";
  ctx.fillText(`CUT ${cut.order}`, fx, fy - 12);

  ctx.font = "11px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(60,60,60,0.75)";
  ctx.textAlign = "right";
  ctx.fillText(`${cut.durationSeconds}s`, fx + fw, fy - 12);

  // フッターに shot / angle / motion を簡易表示
  ctx.textAlign = "left";
  ctx.font = "11px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(60,60,60,0.75)";
  const tags = [labelOfShot(shot), labelOfAngle(angle), labelOfMotion(motion)]
    .filter(Boolean)
    .join("  /  ");
  ctx.fillText(tags, fx, fy + fh + 16);
  ctx.restore();
}

function labelOfShot(s: StoryboardShotType): string {
  return {
    extreme_close: "極寄り",
    close: "クロースアップ",
    medium: "ミディアム",
    full: "フルショット",
    wide: "ワイド",
    extreme_wide: "大ワイド",
  }[s];
}

function labelOfAngle(a: StoryboardCameraAngle): string {
  return {
    front: "正面",
    side: "横",
    back: "背面",
    three_quarter: "斜め",
    high: "俯瞰",
    low: "煽り",
    dutch: "ダッチ",
  }[a];
}

function labelOfMotion(m: StoryboardCameraMotion): string {
  return {
    static: "FIX",
    pan_left: "PAN ←",
    pan_right: "PAN →",
    tilt_up: "TILT ↑",
    tilt_down: "TILT ↓",
    dolly_in: "DOLLY IN",
    dolly_out: "DOLLY OUT",
    handheld: "手持ち",
  }[m];
}
