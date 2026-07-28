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
 * プリセット8種 (設計確定値・変更禁止)。
 *
 * 値は設計書のとおりで、発明しない。サムネイルは CSS グラデーションで表現するため
 * 画像アセットを持たない (全 OS で同じ見え方・追加ファイルゼロ)。
 */
export type AdjustPreset = {
  id: string;
  label: string;
  values: AdjustValues;
  /** チップのサムネイルに使う CSS グラデーション (軽量表現)。 */
  swatch: string;
};

export const ADJUST_PRESETS: readonly AdjustPreset[] = [
  {
    id: "warm",
    label: "あたたかい",
    values: { ...NEUTRAL_ADJUST, brightness: 0.05, saturation: 0.1, hue: -10 },
    swatch: "linear-gradient(135deg, #ffd9a0, #ff9a6b)",
  },
  {
    id: "cool",
    label: "つめたい",
    values: { ...NEUTRAL_ADJUST, hue: 10, brightness: 0.02 },
    swatch: "linear-gradient(135deg, #a8d8ff, #6b8bff)",
  },
  {
    id: "vivid",
    label: "ビビッド",
    values: { ...NEUTRAL_ADJUST, saturation: 0.35, contrast: 0.15 },
    swatch: "linear-gradient(135deg, #ff5fa2, #ffd12e)",
  },
  {
    id: "soft",
    label: "ふんわり",
    values: { ...NEUTRAL_ADJUST, brightness: 0.12, contrast: -0.12 },
    swatch: "linear-gradient(135deg, #ffe9f2, #d9e6ff)",
  },
  {
    id: "mono",
    label: "モノクロ",
    values: { ...NEUTRAL_ADJUST, grayscale: true },
    swatch: "linear-gradient(135deg, #f2f2f2, #4a4a4a)",
  },
  {
    id: "sepia",
    label: "セピア",
    values: { ...NEUTRAL_ADJUST, sepia: true },
    swatch: "linear-gradient(135deg, #e6ceac, #8a6a44)",
  },
  {
    id: "film",
    label: "フィルム",
    values: { ...NEUTRAL_ADJUST, contrast: 0.1, saturation: -0.15, noise: 25 },
    swatch: "linear-gradient(135deg, #cfc7b8, #6f6a5f)",
  },
  {
    id: "crisp",
    label: "くっきり",
    values: { ...NEUTRAL_ADJUST, contrast: 0.25 },
    swatch: "linear-gradient(135deg, #ffffff, #1a1a1a)",
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
