/**
 * 漫画ページを、作業用の規格（幅1080・高さはテンプレ比率）にそろえる。
 *
 * 画像生成AIの返却寸法は揺れるため、受領直後に必ずこの関所を通す。
 * 方式は全入力共通の contain。縦横を同じ倍率で縮小し、足りない場所だけ
 * 白で埋める。拡大・非等方リサイズ・無変換分岐は持たない。
 *
 * STΛCK 決定 (2026-08-10):「書き出しは固定規格でなく**テンプレサイズにあわせる**」。
 * 正規化先は 3:4 固定をやめ、**登録テンプレの pageAspect のうち入力に最も近い比率**へ
 * スナップする（現在は 3:4 と 4:5）。3:4 の入力は従来どおり 1080x1440 に落ちる。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { ALL_COMIC_LAYOUT_TEMPLATES } from "./layoutTemplates";

export const COMIC_PAGE_NORMALIZE_TARGET = {
  width: 1080,
  height: 1440,
  mode: "contain",
  pad: "#ffffff",
} as const;

/** スナップ先比率からの乗法比率差が15%を超えたら、正規化は続行したまま警告する。 */
export const COMIC_PAGE_ASPECT_WARN_THRESHOLD = 0.15;

/**
 * 正規化先の候補比率（テンプレの pageAspect のユニーク集合）。
 *
 * 実行時点の値をハードコードしない（規律3）。テンプレを足したら候補も増える。
 */
export function comicPageAspectCandidates(): { w: number; h: number }[] {
  const seen = new Set<string>();
  const candidates: { w: number; h: number }[] = [];
  for (const template of ALL_COMIC_LAYOUT_TEMPLATES) {
    const { w, h } = template.pageAspect;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const key = `${w}:${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ w, h });
  }
  if (candidates.length === 0) {
    // テンプレが空でも関所は止めない。既定の 3:4 へ落とす。
    candidates.push({ w: 3, h: 4 });
  }
  return candidates;
}

/**
 * 入力比率に最も近い候補比率の正規化先寸法を返す。
 *
 * 距離は log 比（乗法差）で測る。3:4 と 4:5 のように近い比率でも、
 * 加法差より取り違えが起きにくい（nearestAspectLabel と同じ流儀）。
 */
export function resolveComicNormalizeTarget(
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  requirePositiveDimension(sourceWidth, "sourceWidth");
  requirePositiveDimension(sourceHeight, "sourceHeight");
  const sourceAspect = sourceWidth / sourceHeight;
  const candidates = comicPageAspectCandidates();
  let nearest = candidates[0];
  let nearestDistance = Math.abs(Math.log(sourceAspect / (nearest.w / nearest.h)));
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(Math.log(sourceAspect / (candidate.w / candidate.h)));
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  const width = COMIC_PAGE_NORMALIZE_TARGET.width;
  return { width, height: Math.round((width * nearest.h) / nearest.w) };
}

export type ComicPageContentRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ComicPagePixelRect = ComicPageContentRect;

export type ComicPageNormalizationPlan = {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  /** 描画倍率。情報を勝手に拡大しないため、必ず 0 < scale <= 1。 */
  scale: number;
  /** 正規化先canvas上で元画像を描く領域（pixel）。 */
  drawRect: ComicPagePixelRect;
  /** drawRectを正規化先に対するpercentへ直したもの。常に返す。 */
  contentRect: ComicPageContentRect;
  /** スナップ先比率から15%超ずれている。trueでも正規化自体は必ず実施する。 */
  aspectWarn: boolean;
};

export type NormalizeComicPageResult = {
  /** 正規化済みPNGの絶対パス。元画像は上書きしない。 */
  imagePath: string;
  contentRect: ComicPageContentRect;
  aspectWarn: boolean;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
};

function requirePositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} は0より大きい有限値で指定してください。`);
  }
}

function nearlyEqual(a: number, b: number, tolerance = 1e-7): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * contain配置だけを決める純関数。canvasやファイルへ触れないため品質checkから直接検査できる。
 */
export function planComicPageNormalization(
  sourceWidth: number,
  sourceHeight: number,
): ComicPageNormalizationPlan {
  requirePositiveDimension(sourceWidth, "sourceWidth");
  requirePositiveDimension(sourceHeight, "sourceHeight");

  const { width: targetWidth, height: targetHeight } =
    resolveComicNormalizeTarget(sourceWidth, sourceHeight);
  const scale = Math.min(
    1,
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  const x = (targetWidth - w) / 2;
  const y = (targetHeight - h) / 2;
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = sourceWidth / sourceHeight;

  const plan: ComicPageNormalizationPlan = {
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    scale,
    drawRect: { x, y, w, h },
    contentRect: {
      x: (x / targetWidth) * 100,
      y: (y / targetHeight) * 100,
      w: (w / targetWidth) * 100,
      h: (h / targetHeight) * 100,
    },
    aspectWarn:
      Math.abs(sourceAspect / targetAspect - 1) >
      COMIC_PAGE_ASPECT_WARN_THRESHOLD,
  };

  assertValidComicPageNormalizationPlan(plan);
  return plan;
}

/**
 * 正規化計画の安全条件を検査する。
 * 実行時の防波堤に加え、checkで「非対称帯」などの意図的な破損を検知する牙になる。
 */
export function assertValidComicPageNormalizationPlan(
  plan: ComicPageNormalizationPlan,
): void {
  requirePositiveDimension(plan.sourceWidth, "sourceWidth");
  requirePositiveDimension(plan.sourceHeight, "sourceHeight");
  const expectedTarget = resolveComicNormalizeTarget(
    plan.sourceWidth,
    plan.sourceHeight,
  );
  if (
    plan.targetWidth !== expectedTarget.width ||
    plan.targetHeight !== expectedTarget.height
  ) {
    throw new Error(
      `漫画ページの正規化先が${expectedTarget.width}x${expectedTarget.height}ではありません。`,
    );
  }
  if (!Number.isFinite(plan.scale) || plan.scale <= 0 || plan.scale > 1) {
    throw new Error("漫画ページの正規化倍率は0より大きく1以下である必要があります。");
  }

  const { x, y, w, h } = plan.drawRect;
  for (const [label, value] of Object.entries({ x, y, w, h })) {
    if (!Number.isFinite(value)) {
      throw new Error(`drawRect.${label} が有限値ではありません。`);
    }
  }
  if (w <= 0 || h <= 0 || x < 0 || y < 0) {
    throw new Error("元画像の描画領域が正規化先の内側にありません。");
  }
  if (
    x + w > plan.targetWidth + 1e-7 ||
    y + h > plan.targetHeight + 1e-7
  ) {
    throw new Error("元画像の描画領域が正規化先からはみ出しています。");
  }
  if (
    !nearlyEqual(w, plan.sourceWidth * plan.scale) ||
    !nearlyEqual(h, plan.sourceHeight * plan.scale)
  ) {
    throw new Error("縦横で異なる倍率が使われています。");
  }
  if (
    !nearlyEqual(x, (plan.targetWidth - w) / 2) ||
    !nearlyEqual(y, (plan.targetHeight - h) / 2)
  ) {
    throw new Error("白帯が左右または上下で非対称です。");
  }

  const expectedPercent = {
    x: (x / plan.targetWidth) * 100,
    y: (y / plan.targetHeight) * 100,
    w: (w / plan.targetWidth) * 100,
    h: (h / plan.targetHeight) * 100,
  };
  for (const key of ["x", "y", "w", "h"] as const) {
    if (!nearlyEqual(plan.contentRect[key], expectedPercent[key])) {
      throw new Error(`contentRect.${key} が描画領域と一致しません。`);
    }
  }

  const sourceAspect = plan.sourceWidth / plan.sourceHeight;
  const targetAspect = plan.targetWidth / plan.targetHeight;
  const expectedWarn =
    Math.abs(sourceAspect / targetAspect - 1) >
    COMIC_PAGE_ASPECT_WARN_THRESHOLD;
  if (plan.aspectWarn !== expectedWarn) {
    throw new Error("aspectWarn が入力画像の比率差と一致しません。");
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("漫画ページの正規化に失敗しました。"));
    }, "image/png");
  });
}

/**
 * blob → base64（data: プレフィックスなし）。
 * 大きな PNG でもスタックを使わないよう FileReader 経由で変換する。
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(new Error("漫画ページの正規化に失敗しました。"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 画像を、最も近いテンプレ比率（幅1080）のPNGへ正規化し、元画像の隣へ別名で保存する。
 * ±15%超でも止めず、aspectWarn=trueを添えて返す。
 */
export async function normalizeComicPage(
  imagePath: string,
): Promise<NormalizeComicPageResult> {
  const img = await loadImage(convertFileSrc(imagePath));
  const plan = planComicPageNormalization(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = plan.targetWidth;
  canvas.height = plan.targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("漫画ページの正規化に失敗しました。");

  ctx.fillStyle = COMIC_PAGE_NORMALIZE_TARGET.pad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    plan.drawRect.x,
    plan.drawRect.y,
    plan.drawRect.w,
    plan.drawRect.h,
  );

  const blob = await canvasToPngBlob(canvas);
  // 書き込みは plugin-fs でなく Rust コマンド経由にする。
  // storageRoot はユーザー設定で任意パス（Pictures / 外付け等）になり、
  // plugin-fs の fs:scope 許可リストでは列挙しきれない（実害 2026-08-06:
  // 保存先が ~/Pictures のとき writeFile が scope 違反で全ページ失敗した）。
  const { editExport } = await import("../ipc");
  const { basename, dirname, extname, join } = await import("@tauri-apps/api/path");
  const extension = await extname(imagePath).catch(() => "");
  const base = await basename(imagePath, extension ? `.${extension}` : undefined);
  // 寸法は plan から書く（実行時点の値をハードコードしない＝規律3）。
  // 旧名 `_comic_1080x1440` も剥がして、再正規化で接尾辞が積み上がるのを防ぐ。
  const stem = base.replace(/_comic_\d+x\d+$/, "") || "manga_page";
  const dest = await join(
    await dirname(imagePath),
    `${stem}_comic_${plan.targetWidth}x${plan.targetHeight}.png`,
  );
  await editExport.png(dest, await blobToBase64(blob));

  return {
    imagePath: dest,
    contentRect: plan.contentRect,
    aspectWarn: plan.aspectWarn,
    sourceWidth: plan.sourceWidth,
    sourceHeight: plan.sourceHeight,
    scale: plan.scale,
  };
}
