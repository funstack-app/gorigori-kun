/** 媒体の画像規格を、AIを使わず同じ入力なら同じ結果になる形で照合する。 */

export type MachineCheckStatus = "pass" | "fail" | "warning" | "not-checked";

export type MachineCheckResult = {
  id: string;
  name: string;
  status: MachineCheckStatus;
  message: string;
  sourceUrl: string | null;
};

export type ImageFacts = {
  width: number;
  height: number;
  extension: string;
  /** 読み取りに失敗した場合は null。寸法・形式の検査は続ける。 */
  fileSizeBytes: number | null;
};

type Dimension = { width: number; height: number };

type ImageVariant = {
  label: string;
  ratio: readonly [number, number];
  exact?: Dimension;
  minimum?: Dimension;
  recommended?: Dimension;
};

type PlatformImageSpec = {
  sourceUrl: string | null;
  allowedExtensions?: readonly string[];
  variants?: readonly ImageVariant[];
  maxFileSizeBytes?: number;
  recommendedFileSizeBytes?: number;
  unverifiedNote?: string;
};

const MB = 1024 * 1024;
const KB = 1024;

/** 正本に数値がある規格だけを収録する。未確認値を近い他媒体から流用しない。 */
export const PLATFORM_IMAGE_SPECS: Readonly<Record<string, PlatformImageSpec>> = {
  "meta-ads": {
    sourceUrl: "https://www.facebook.com/business/ads-guide/image/facebook-feed",
    allowedExtensions: ["jpg", "jpeg", "png"],
    variants: [
      {
        label: "4:5",
        ratio: [4, 5],
        minimum: { width: 600, height: 750 },
        recommended: { width: 1440, height: 1800 },
      },
    ],
    maxFileSizeBytes: 30 * MB,
  },
  "google-ads": {
    sourceUrl: "https://support.google.com/google-ads/answer/10724748",
    allowedExtensions: ["jpg", "jpeg", "png"],
    variants: [
      { label: "1.91:1", ratio: [1.91, 1] },
      { label: "1:1", ratio: [1, 1] },
      { label: "4:5", ratio: [4, 5] },
    ],
  },
  "line-ads": {
    sourceUrl: "https://www.lycbiz.com/jp/manual/line-ads/policy_009/",
    allowedExtensions: ["jpg", "jpeg", "png"],
    variants: [
      { label: "Card", ratio: [1200, 628], exact: { width: 1200, height: 628 } },
      { label: "Square", ratio: [1, 1], exact: { width: 1080, height: 1080 } },
    ],
    maxFileSizeBytes: 10 * MB,
  },
  "tiktok-ads": {
    sourceUrl: "https://ads.tiktok.com/help/article/specifications-for-carousel-ads",
    allowedExtensions: ["jpg", "jpeg", "png"],
    variants: [
      { label: "横型", ratio: [1200, 628], exact: { width: 1200, height: 628 } },
      { label: "正方形", ratio: [1, 1], exact: { width: 640, height: 640 } },
      { label: "縦型", ratio: [9, 16], exact: { width: 720, height: 1280 } },
    ],
    recommendedFileSizeBytes: 100 * KB,
  },
  "x-ads": {
    sourceUrl: "https://business.x.com/en/help/campaign-setup/creative-ad-specifications",
    allowedExtensions: ["jpg", "jpeg", "png", "gif"],
    variants: [
      { label: "1.91:1", ratio: [1.91, 1] },
      { label: "1:1", ratio: [1, 1] },
      { label: "4:5", ratio: [4, 5] },
      { label: "2:3", ratio: [2, 3] },
      { label: "16:9", ratio: [16, 9] },
      { label: "9:16", ratio: [9, 16] },
    ],
  },
  "yahoo-ads": {
    sourceUrl: null,
    unverifiedNote:
      "Yahoo!広告の画像サイズ・アスペクト比・ファイル形式は未確認のため未収録です。",
  },
} as const;

function cleanExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

function formatDimensions(items: readonly ImageVariant[]): string {
  return items
    .map((item) => {
      if (item.exact) return `${item.exact.width}×${item.exact.height}px`;
      if (item.minimum) return `${item.minimum.width}×${item.minimum.height}px以上`;
      return item.label;
    })
    .join(" / ");
}

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${bytes / MB}MB`;
  return `${bytes / KB}KB`;
}

/**
 * 実寸の比率が規格比率の許容範囲内かを判定する。
 * 境界（既定3%ちょうど）は合格。浮動小数点の丸め誤差だけを極小値で吸収する。
 */
export function isAspectRatioWithinTolerance(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  tolerance = 0.03,
): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(targetWidth) ||
    !Number.isFinite(targetHeight) ||
    width <= 0 ||
    height <= 0 ||
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    tolerance < 0
  ) {
    return false;
  }
  const actual = width / height;
  const target = targetWidth / targetHeight;
  const relativeDifference = Math.abs(actual - target) / target;
  return relativeDifference <= tolerance + Number.EPSILON * 8;
}

/** 画像の実測値と媒体規格を照合する純関数。 */
export function checkImageSpecification(
  ruleSetId: string,
  facts: ImageFacts,
  aspectTolerance = 0.03,
): MachineCheckResult[] {
  const spec = PLATFORM_IMAGE_SPECS[ruleSetId];
  if (!spec) {
    return [
      {
        id: `${ruleSetId}-spec-unavailable`,
        name: "画像規格",
        status: "not-checked",
        message: "この媒体の画像規格表がありません。",
        sourceUrl: null,
      },
    ];
  }

  const sourceUrl = spec.sourceUrl;
  const unavailable = spec.unverifiedNote ?? "正本で数値を確認できないため判定していません。";
  const results: MachineCheckResult[] = [];
  const variants = spec.variants ?? [];

  if (spec.allowedExtensions?.length) {
    const actual = cleanExtension(facts.extension);
    const allowed = spec.allowedExtensions.includes(actual);
    results.push({
      id: `${ruleSetId}-file-format`,
      name: "ファイル形式",
      status: allowed ? "pass" : "fail",
      message: allowed
        ? `${actual.toUpperCase()}は対応形式です。`
        : `${actual ? actual.toUpperCase() : "拡張子なし"}は対象外です。対応: ${spec.allowedExtensions.join(" / ").toUpperCase()}`,
      sourceUrl,
    });
  } else {
    results.push({
      id: `${ruleSetId}-file-format`,
      name: "ファイル形式",
      status: "not-checked",
      message: unavailable,
      sourceUrl,
    });
  }

  const matchingVariants = variants.filter((variant) =>
    isAspectRatioWithinTolerance(
      facts.width,
      facts.height,
      variant.ratio[0],
      variant.ratio[1],
      aspectTolerance,
    ),
  );

  if (variants.length) {
    results.push({
      id: `${ruleSetId}-aspect-ratio`,
      name: "アスペクト比",
      status: matchingVariants.length ? "pass" : "fail",
      message: matchingVariants.length
        ? `${facts.width}×${facts.height}pxは${matchingVariants.map((v) => v.label).join(" / ")}の許容範囲内です。`
        : `${facts.width}×${facts.height}pxは対象比率（${variants.map((v) => v.label).join(" / ")}）から3%を超えて外れます。`,
      sourceUrl,
    });
  } else {
    results.push({
      id: `${ruleSetId}-aspect-ratio`,
      name: "アスペクト比",
      status: "not-checked",
      message: unavailable,
      sourceUrl,
    });
  }

  const variantsWithDimensions = variants.filter((variant) => variant.exact || variant.minimum);
  if (!variantsWithDimensions.length) {
    results.push({
      id: `${ruleSetId}-dimensions`,
      name: "画像サイズ",
      status: "not-checked",
      message: variants.length
        ? "正本に最小・固定ピクセル寸法が無いため、実寸の合否は判定していません。"
        : unavailable,
      sourceUrl,
    });
  } else {
    const dimensionMatch = matchingVariants.find((variant) => {
      if (variant.exact) {
        return facts.width === variant.exact.width && facts.height === variant.exact.height;
      }
      if (variant.minimum) {
        return facts.width >= variant.minimum.width && facts.height >= variant.minimum.height;
      }
      return false;
    });
    const recommended = dimensionMatch?.recommended;
    results.push({
      id: `${ruleSetId}-dimensions`,
      name: "画像サイズ",
      status: dimensionMatch ? "pass" : "fail",
      message: dimensionMatch
        ? `${facts.width}×${facts.height}pxは規格内です。${
            recommended ? ` 推奨は${recommended.width}×${recommended.height}pxです。` : ""
          }`
        : `${facts.width}×${facts.height}pxは対象寸法（${formatDimensions(variantsWithDimensions)}）に合いません。`,
      sourceUrl,
    });
  }

  if (spec.maxFileSizeBytes || spec.recommendedFileSizeBytes) {
    if (facts.fileSizeBytes === null || !Number.isFinite(facts.fileSizeBytes)) {
      results.push({
        id: `${ruleSetId}-file-size`,
        name: "ファイル容量",
        status: "not-checked",
        message: "ファイル容量を取得できなかったため判定していません。",
        sourceUrl,
      });
    } else if (spec.maxFileSizeBytes) {
      const passed = facts.fileSizeBytes <= spec.maxFileSizeBytes;
      results.push({
        id: `${ruleSetId}-file-size`,
        name: "ファイル容量",
        status: passed ? "pass" : "fail",
        message: passed
          ? `${formatBytes(facts.fileSizeBytes)}は上限${formatBytes(spec.maxFileSizeBytes)}以内です。`
          : `${formatBytes(facts.fileSizeBytes)}は上限${formatBytes(spec.maxFileSizeBytes)}を超えています。`,
        sourceUrl,
      });
    } else if (spec.recommendedFileSizeBytes) {
      const recommended = facts.fileSizeBytes <= spec.recommendedFileSizeBytes;
      results.push({
        id: `${ruleSetId}-file-size`,
        name: "ファイル容量",
        status: recommended ? "pass" : "warning",
        message: recommended
          ? `${formatBytes(facts.fileSizeBytes)}は推奨${formatBytes(spec.recommendedFileSizeBytes)}以内です。`
          : `${formatBytes(facts.fileSizeBytes)}です。必須上限ではありませんが、推奨${formatBytes(spec.recommendedFileSizeBytes)}を超えています。`,
        sourceUrl,
      });
    }
  } else {
    results.push({
      id: `${ruleSetId}-file-size`,
      name: "ファイル容量",
      status: "not-checked",
      message: spec.unverifiedNote ?? "正本に容量の数値が無いため判定していません。",
      sourceUrl,
    });
  }

  return results;
}
