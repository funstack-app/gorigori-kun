/**
 * 「調整」チップの色調補正 (AI 不使用・数学的処理のみ)。
 *
 * ## なぜ AI を使わないのか (STΛCK 確定方針 2026-07-28)
 *
 * 明るさ・色の調整は「同じ入力なら必ず同じ出力」が保証できる決定論の領域。
 * ここに AI を挟むと、Intel Mac / Apple Silicon / Windows で結果が変わり、
 * 待ち時間も課金も発生する。fabric の filters は WebGL が無ければ 2D の
 * 素の配列演算にフォールバックするため、**全 OS で同じ画素が出る**。
 *
 * ## 値の単位 (fabric 6.9.1 の実装に合わせる)
 *
 * | フィルタ | プロパティ | 範囲 | 備考 |
 * |---|---|---|---|
 * | Brightness  | brightness | -1..1 | 2D では ±255 に換算される |
 * | Contrast    | contrast   | -1..1 | |
 * | Saturation  | saturation | -1..1 | |
 * | HueRotation | rotation   | -1..1 | **1 = 180°**。度からは /180 で換算する |
 * | Noise       | noise      | 0..   | 画素に加える乱数の振れ幅 (整数) |
 *
 * 色合い (hue) だけ UI の単位が「度」なので、`HUE_DEGREES_PER_UNIT` で換算する。
 * 設計書のプリセット値も度で書かれているため、換算を1箇所に閉じ込める。
 */

import { SOURCE_PREVIEW_ID } from "./magicLayerToFabric";

/** 調整の5値。すべて「無調整」が 0 になるように揃える (リセット = 全部 0)。 */
export type AdjustValues = {
  /** 明るさ -1..1 */
  brightness: number;
  /** コントラスト -1..1 */
  contrast: number;
  /** 彩度 -1..1 */
  saturation: number;
  /** 色合い (度) -180..180 */
  hue: number;
  /** 粒子 0..100 */
  noise: number;
  /** モノクロ (Grayscale) */
  grayscale: boolean;
  /** セピア (Sepia) */
  sepia: boolean;
};

/** 何も調整していない状態。「リセット」はこの値に戻す。 */
export const NEUTRAL_ADJUST: AdjustValues = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  noise: 0,
  grayscale: false,
  sepia: false,
};

/** fabric の HueRotation は 1 = 180°。UI は度で扱うのでここで換算する。 */
const HUE_DEGREES_PER_UNIT = 180;

/**
 * 調整プリセット16種 (基本8 + LUT風フィルム8。2026-08-26 STΛCK指示で増量)。
 *
 * サムネイルは現在画像 + cssFilter で表現するため画像アセットを持たない。
 */
export type AdjustPreset = {
  id: string;
  label: string;
  values: AdjustValues;
  /** 現在画像のサムネイルに掛ける、実処理へ近いCSSプレビュー。 */
  cssFilter: string;
};

export const ADJUST_PRESETS: readonly AdjustPreset[] = [
  {
    id: "vintage",
    label: "vintage",
    values: { ...NEUTRAL_ADJUST, contrast: 0.08, saturation: -0.2, noise: 18, sepia: true },
    cssFilter: "sepia(.65) saturate(.75) contrast(1.08)",
  },
  {
    id: "retrofilm",
    label: "retrofilm",
    values: { ...NEUTRAL_ADJUST, brightness: 0.04, contrast: 0.12, saturation: -0.12, hue: -8, noise: 30 },
    cssFilter: "sepia(.2) saturate(.8) contrast(1.12) brightness(1.04)",
  },
  {
    id: "duotone",
    label: "duotone",
    values: { ...NEUTRAL_ADJUST, contrast: 0.25, grayscale: true },
    cssFilter: "grayscale(1) contrast(1.35) sepia(.18)",
  },
  {
    id: "vibrant",
    label: "vibrant",
    values: { ...NEUTRAL_ADJUST, brightness: 0.03, contrast: 0.18, saturation: 0.45 },
    cssFilter: "saturate(1.5) contrast(1.18) brightness(1.03)",
  },
  {
    id: "warmtone",
    label: "warmtone",
    values: { ...NEUTRAL_ADJUST, brightness: 0.05, saturation: 0.12, hue: -12 },
    cssFilter: "sepia(.2) saturate(1.18) brightness(1.05)",
  },
  {
    id: "coolbreeze",
    label: "coolbreeze",
    values: { ...NEUTRAL_ADJUST, brightness: 0.03, saturation: 0.05, hue: 12 },
    cssFilter: "hue-rotate(12deg) saturate(1.05) brightness(1.05)",
  },
  {
    id: "redtint",
    label: "redtint",
    values: { ...NEUTRAL_ADJUST, saturation: 0.15, hue: -25 },
    cssFilter: "hue-rotate(-18deg) saturate(1.25)",
  },
  {
    id: "coldtone",
    label: "coldtone",
    values: { ...NEUTRAL_ADJUST, contrast: 0.1, saturation: -0.05, hue: 20 },
    cssFilter: "hue-rotate(20deg) saturate(.9) contrast(1.1)",
  },
  // ここから LUT 風フィルムプリセット (2026-08-26 STΛCK指示で増量)
  {
    id: "cineteal",
    label: "cineteal",
    values: { ...NEUTRAL_ADJUST, hue: 8, contrast: 0.18, saturation: 0.18 },
    cssFilter: "hue-rotate(8deg) saturate(1.2) contrast(1.2)",
  },
  {
    id: "noir",
    label: "noir",
    values: { ...NEUTRAL_ADJUST, grayscale: true, contrast: 0.35, brightness: -0.03, noise: 12 },
    cssFilter: "grayscale(1) contrast(1.4) brightness(.97)",
  },
  {
    id: "kodakgold",
    label: "kodakgold",
    values: { ...NEUTRAL_ADJUST, hue: -18, brightness: 0.06, saturation: 0.2, contrast: 0.08 },
    cssFilter: "sepia(.28) saturate(1.25) brightness(1.06) contrast(1.08)",
  },
  {
    id: "fujigreen",
    label: "fujigreen",
    values: { ...NEUTRAL_ADJUST, hue: 25, saturation: 0.08, contrast: 0.1, brightness: 0.02 },
    cssFilter: "hue-rotate(25deg) saturate(1.08) contrast(1.1)",
  },
  {
    id: "pastel",
    label: "pastel",
    values: { ...NEUTRAL_ADJUST, brightness: 0.1, saturation: -0.25, contrast: -0.15 },
    cssFilter: "brightness(1.1) saturate(.75) contrast(.85)",
  },
  {
    id: "mattefade",
    label: "mattefade",
    values: { ...NEUTRAL_ADJUST, contrast: -0.2, brightness: 0.06, saturation: -0.08, noise: 8 },
    cssFilter: "contrast(.8) brightness(1.06) saturate(.92)",
  },
  {
    id: "sunset",
    label: "sunset",
    values: { ...NEUTRAL_ADJUST, hue: -30, saturation: 0.3, brightness: 0.04, contrast: 0.12 },
    cssFilter: "hue-rotate(-22deg) saturate(1.3) brightness(1.04) contrast(1.12)",
  },
  {
    id: "arctic",
    label: "arctic",
    values: { ...NEUTRAL_ADJUST, hue: 35, saturation: -0.1, brightness: 0.05, contrast: 0.08 },
    cssFilter: "hue-rotate(35deg) saturate(.9) brightness(1.05) contrast(1.08)",
  },
] as const;

/** 調整値が「無調整」かどうか (リセットボタンの活性判定に使う)。 */
export function isNeutralAdjust(values: AdjustValues): boolean {
  return (
    values.brightness === 0 &&
    values.contrast === 0 &&
    values.saturation === 0 &&
    values.hue === 0 &&
    values.noise === 0 &&
    !values.grayscale &&
    !values.sepia
  );
}

type FabricObjectLike = {
  filters?: unknown[];
  applyFilters?: () => void;
  set?: (values: Record<string, unknown>) => void;
  get?: (key: string) => unknown;
};

/**
 * 調整値から fabric の filters 配列を組み立てる。
 *
 * 0 の項目はフィルタ自体を積まない。fabric は filters の数だけ画素を走査するので、
 * 無調整の項目を積むと**何もしない処理でループが増える**だけになる。
 *
 * 適用順は「色 → 粒子」。粒子 (Noise) を先に乗せると、後段の彩度・コントラストが
 * ノイズ自体を強調してしまい、同じ値でも見え方が安定しない。
 */
async function buildFilters(values: AdjustValues): Promise<unknown[]> {
  // @ts-ignore fabric is installed at runtime via package dependency
  const fabric = (await import("fabric")) as any;
  const f = fabric.filters ?? {};
  const list: unknown[] = [];
  if (f.Grayscale && values.grayscale) list.push(new f.Grayscale());
  if (f.Sepia && values.sepia) list.push(new f.Sepia());
  if (f.Brightness && values.brightness !== 0) {
    list.push(new f.Brightness({ brightness: values.brightness }));
  }
  if (f.Contrast && values.contrast !== 0) {
    list.push(new f.Contrast({ contrast: values.contrast }));
  }
  if (f.Saturation && values.saturation !== 0) {
    list.push(new f.Saturation({ saturation: values.saturation }));
  }
  if (f.HueRotation && values.hue !== 0) {
    list.push(new f.HueRotation({ rotation: values.hue / HUE_DEGREES_PER_UNIT }));
  }
  if (f.Noise && values.noise !== 0) {
    list.push(new f.Noise({ noise: values.noise }));
  }
  return list;
}

/** ベース画像レイヤー (元画像プレビュー) を探す。無ければ最背面の画像レイヤー。 */
export function findBaseImageObject(canvas: unknown): FabricObjectLike | null {
  const objects =
    (canvas as { getObjects?: () => FabricObjectLike[] } | null)?.getObjects?.() ?? [];
  const preview = objects.find((object) => object.get?.("id") === SOURCE_PREVIEW_ID);
  if (preview) return preview;
  // 分解済みキャンバス等、元画像プレビューが無い構成では最背面の画像を基準にする。
  // マジックグラブの確定待ちプレビューは「見せるだけ」の一時レイヤーなので除く。
  return (
    objects.find(
      (object) => object.get?.("layerKind") === "image" && object.get?.("id") !== "grab-preview",
    ) ?? null
  );
}

/**
 * 調整をベース画像レイヤーへ適用する (プレビュー反映まで)。
 *
 * 履歴は積まない。スライダーを動かしている最中に積むと1ドラッグで数十手になるため、
 * 確定 (pointerup / プリセット押下) のタイミングで呼び出し側が pushHistory する。
 *
 * 調整値そのものは `adjust` カスタム属性としてオブジェクトに保存する。
 * これが無いと undo/redo でスライダーの表示値だけ元に戻らない
 * (filters は fabric が既定でシリアライズするので見た目は戻る)。
 */
export async function applyAdjustToCanvas(
  canvas: unknown,
  values: AdjustValues,
): Promise<boolean> {
  const target = findBaseImageObject(canvas);
  if (!target) return false;
  // 画像以外 (矩形など) には filters が効かないので、applyFilters を持つものだけ扱う。
  if (typeof target.applyFilters !== "function") return false;
  target.set?.({ adjust: { ...values } });
  target.filters = await buildFilters(values);
  target.applyFilters();
  (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
  return true;
}

/**
 * キャンバスに今入っている調整値を読み戻す (undo/redo・画像切替のあとの表示同期)。
 * 保存されていなければ「無調整」を返す。
 */
export function readAdjustFromCanvas(canvas: unknown): AdjustValues {
  const target = findBaseImageObject(canvas);
  const raw = target?.get?.("adjust");
  if (!raw || typeof raw !== "object") return { ...NEUTRAL_ADJUST };
  const source = raw as Partial<AdjustValues>;
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    brightness: num(source.brightness, 0),
    contrast: num(source.contrast, 0),
    saturation: num(source.saturation, 0),
    hue: num(source.hue, 0),
    noise: num(source.noise, 0),
    grayscale: source.grayscale === true,
    sepia: source.sepia === true,
  };
}
