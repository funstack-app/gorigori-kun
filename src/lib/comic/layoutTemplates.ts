/**
 * 漫画のコマ割りテンプレ（静的定義）。
 *
 * STΛCK 実機FB (2026-07-28):「コマ割りテンプレを作って、話とキャラの時点で選ばせて」。
 * 実行時に AI へコマ割りを作らせると非決定論でレイアウト破綻を検品できないため、
 * テンプレ集をコード内の定数として持ち、ユーザーに選ばせる。
 *
 * このテンプレの `panelCount` が「コマ数」の唯一の正本（旧・形式(4|8)型は廃止）。
 * 座標はページ左上原点の percent（0-100）。gutter 3%・外周マージン4%で全テンプレ共通。
 *
 * JSON 外部ファイルにしないのは、配布アプリで bundle.resources 漏れが
 * 配布ブロッカーになる類型を避けるため（TS 定数なら型検査も効く）。
 */

/** ページ上のコマ。ページ左上原点・percent（0-100）。配列順 = 読み順（右→左・上→下）。 */
export type ComicPanelSlot = {
  /** bbox。points がある場合は poly() が導出した外接矩形（手書き禁止）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 多角形コマ（斜めコマ割り用）。4点・ページpercent・左上から時計回り
   * （TL→TR→BR→BL）。無ければ従来どおり長方形。
   */
  points?: [number, number][];
};

export type ComicLayoutTemplate = {
  id: string;
  /** UI 表示名。 */
  label: string;
  panelCount: number;
  /** ページの縦横比（width : height）。 */
  pageAspect: { w: number; h: number };
  /** length === panelCount。配列順が読み順。 */
  slots: ComicPanelSlot[];
  /** 各コマの役割。ネーム生成プロンプトに流す。length === panelCount */
  roles: string[];
};

/** 多角形スロットを作る。bbox は points から導出し、手書きとのドリフトを構造的に消す。 */
function poly(...points: [number, number][]): ComicPanelSlot {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, points };
}

/**
 * clip-path 用の polygon() 文字列を返す（bbox ローカル percent へ変換）。
 * 長方形スロット（points なし）は undefined（呼び出し側は従来の border 描画）。
 */
export function slotClipPath(slot: ComicPanelSlot): string | undefined {
  if (!slot.points) return undefined;
  return `polygon(${slot.points
    .map(
      ([px, py]) =>
        `${(((px - slot.x) / slot.w) * 100).toFixed(2)}% ${(((py - slot.y) / slot.h) * 100).toFixed(2)}%`,
    )
    .join(", ")})`;
}

export const COMIC_LAYOUT_TEMPLATES: ComicLayoutTemplate[] = [
  {
    id: "manga01",
    label: "マンガ01",
    panelCount: 6,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([67, 4], [96, 4], [96, 26], [65, 27]),
      poly([34, 4], [64, 4], [62, 27.03], [36, 28]),
      poly([4, 4], [31, 4], [33, 28], [4, 29]),
      poly([4, 31.97], [96, 29], [96, 68], [4, 65.99]),
      poly([53, 70], [96, 71.06], [96, 96], [51, 96]),
      poly([4, 69], [50, 69.99], [48, 96], [4, 96]),
    ],
    roles: ["起", "承", "受け", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga02",
    label: "マンガ02",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([61, 4], [96, 4], [96, 25.93], [58, 27.93]),
      poly([4, 4], [58, 4], [55, 27.97], [4, 29.97]),
      poly([4, 33.07], [96, 29.11], [96, 63.99], [4, 62.01]),
      poly([51, 66.01], [96, 67.01], [96, 96], [53, 96]),
      poly([4, 64.99], [48, 65.98], [50, 96], [4, 96]),
    ],
    roles: ["起", "承", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga03",
    label: "マンガ03",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([46, 4], [96, 4], [96, 30], [49, 30]),
      poly([4, 4], [43, 4], [46, 30], [4, 30]),
      { x: 4, y: 33, w: 92, h: 31 },
      poly([65, 67], [96, 67], [96, 96], [62, 96]),
      poly([4, 67], [62, 67], [59, 96], [4, 96]),
    ],
    roles: ["起", "承", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga04",
    label: "マンガ04",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([48.01, 4], [96, 4], [96, 48.29], [55.54, 54.21]),
      poly([4, 4], [45.06, 4], [50.06, 38], [4, 36.01]),
      poly([4, 38.99], [50.59, 41.05], [53.94, 63.99], [4, 65.98]),
      poly([55.89, 56.73], [96, 51.72], [96, 61.94], [56.93, 63.95]),
      poly([4, 69.06], [96, 65.11], [96, 96], [4, 96]),
    ],
    roles: [
      "起（大ゴマで引き込む）",
      "承",
      "展開",
      "転（間・タメ）",
      "結（オチ）",
    ],
  },
  {
    id: "manga05",
    label: "マンガ05",
    panelCount: 6,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([48, 4], [96, 4], [96, 26.01], [47, 28.01]),
      poly([4, 4], [45, 4], [44, 28.01], [4, 29.01]),
      poly([48, 30.99], [96, 28.99], [96, 67.07], [65, 66.07]),
      poly([4, 31.99], [45, 31], [62, 66.05], [4, 65.07]),
      poly([51, 68.95], [96, 69.9], [96, 96], [49, 96]),
      poly([4, 67.94], [48, 68.94], [46, 96], [4, 96]),
    ],
    roles: ["起", "承", "展開", "見せ場（大ゴマ）", "転（タメ）", "結（オチ）"],
  },
  {
    id: "manga06",
    label: "マンガ06",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([58.02, 4], [96, 4], [96, 30.85], [61.02, 29.85]),
      poly([4, 4], [54.98, 4], [57.98, 29.13], [4, 27.13]),
      poly([4, 29.87], [96, 34.17], [96, 62.02], [4, 64]),
      poly([53, 65.98], [96, 64.98], [96, 96], [50, 96]),
      poly([4, 67.01], [50, 66], [47, 96], [4, 96]),
    ],
    roles: ["起", "承", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga07",
    label: "マンガ07",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([63.99, 4], [96, 4], [96, 27.03], [64, 30.03]),
      poly([4, 4], [61.01, 4], [60.98, 30.77], [4, 34.77]),
      poly([4, 38.31], [96, 30.1], [96, 62.97], [4, 64.94]),
      poly([45, 67.02], [96, 66.01], [96, 96], [44, 96]),
      poly([4, 68.03], [42, 67.03], [41, 96], [4, 96]),
    ],
    roles: ["起", "承", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga08",
    label: "マンガ08",
    panelCount: 6,
    pageAspect: { w: 3, h: 4 },
    slots: [
      { x: 66, y: 4, w: 30, h: 26 },
      { x: 35, y: 4, w: 28, h: 26 },
      { x: 4, y: 4, w: 28, h: 26 },
      { x: 4, y: 33, w: 92, h: 30 },
      { x: 57, y: 66, w: 39, h: 30 },
      { x: 4, y: 66, w: 50, h: 30 },
    ],
    roles: ["起", "承", "受け", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga09",
    label: "マンガ09",
    panelCount: 5,
    pageAspect: { w: 3, h: 4 },
    slots: [
      { x: 44, y: 4, w: 52, h: 26 },
      { x: 4, y: 4, w: 37, h: 26 },
      { x: 60, y: 33, w: 36, h: 30 },
      { x: 4, y: 33, w: 53, h: 30 },
      { x: 4, y: 66, w: 92, h: 30 },
    ],
    roles: ["起", "承", "転", "見せ場（大ゴマ）", "結（オチ）"],
  },
  {
    id: "manga10",
    label: "マンガ10",
    panelCount: 4,
    pageAspect: { w: 3, h: 4 },
    slots: [
      { x: 4, y: 4, w: 92, h: 26 },
      { x: 52, y: 33, w: 44, h: 30 },
      { x: 4, y: 33, w: 45, h: 30 },
      { x: 4, y: 66, w: 92, h: 30 },
    ],
    roles: ["起（状況を大きく）", "承", "転", "結（オチ・大ゴマ）"],
  },
  {
    id: "manga11",
    label: "マンガ11",
    panelCount: 4,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([4, 4], [96, 4], [96, 31], [4, 28]),
      poly([4, 31], [96, 34], [96, 56.15], [4, 70.33]),
      poly([53, 65.96], [96, 58.97], [96, 96], [51.01, 96]),
      poly([4, 72.79], [49.96, 66.79], [47.99, 96], [4, 96]),
    ],
    roles: ["起（状況を大きく）", "見せ場（大ゴマ）", "転", "結（オチ）"],
  },
  {
    id: "manga12",
    label: "マンガ12",
    panelCount: 6,
    pageAspect: { w: 3, h: 4 },
    slots: [
      poly([53, 4], [96, 4], [96, 32], [50, 32]),
      poly([4, 4], [50, 4], [47, 32], [4, 32]),
      poly([49, 35], [96, 35], [96, 64], [52, 64]),
      poly([4, 35], [46, 35], [49, 64], [4, 64]),
      poly([53, 67], [96, 67], [96, 96], [50, 96]),
      poly([4, 67], [50, 67], [47, 96], [4, 96]),
    ],
    roles: ["起", "承", "展開", "転", "タメ", "結（オチ）"],
  },
];

export const USER_COMIC_LAYOUT_TEMPLATES: ComicLayoutTemplate[] = [
  {
    id: "user01",
    label: "手作り01",
    panelCount: 3,
    pageAspect: { w: 3, h: 4 },
    slots: [
      { x: 58.80, y: 2.36, w: 37.69, h: 36.04 },
      { x: 3.52, y: 2.36, w: 52.92, h: 36.04 },
      { x: 3.52, y: 41.53, w: 92.96, h: 56.01 },
    ],
    roles: ["起（導入）", "承（展開）", "見せ場（大ゴマ）"],
  },
];

export const ALL_COMIC_LAYOUT_TEMPLATES = [
  ...COMIC_LAYOUT_TEMPLATES,
  ...USER_COMIC_LAYOUT_TEMPLATES,
];

export const DEFAULT_COMIC_TEMPLATE_ID = "manga01";

/**
 * 生成に渡すページの縦横比ラベル（`images.generateBatch` の `aspect`）。
 *
 * 2026-07-28 STΛCK FB「最終の生成サイズがバラバラ」への対応。ページ生成は
 * `3:4` を渡す一方、コマ生成は aspect 未指定で Rust 既定の `1:1` に落ちていたため、
 * 一気生成（コマ経路）とページ経路で出来上がりの形が食い違っていた。
 *
 * 値は手書きせず先頭テンプレの `pageAspect` から導出する（テンプレを直したら追従する）。
 * 全テンプレが同一比であることは DEV アサートで固定する（下部）。
 */
export const COMIC_PAGE_ASPECT: string = `${COMIC_LAYOUT_TEMPLATES[0].pageAspect.w}:${COMIC_LAYOUT_TEMPLATES[0].pageAspect.h}`;

/** 不明な ID は先頭テンプレへフォールバックする（保存データの前方互換）。 */
export function getComicTemplate(id: string): ComicLayoutTemplate {
  return (
    ALL_COMIC_LAYOUT_TEMPLATES.find((t) => t.id === id) ?? COMIC_LAYOUT_TEMPLATES[0]
  );
}

/**
 * スロットの実アスペクト比（width / height。pageAspect 込み）を返す。
 * percent 幅/高さをページの実比率でスケールして実アスペクト比を出す。
 * points がある場合も bbox 実比率で判定する（bbox は poly() 導出値）。
 * スロットが無い場合は 1（正方形扱い）。
 */
export function slotAspectRatio(t: ComicLayoutTemplate, i: number): number {
  const slot = t.slots[i];
  if (!slot) return 1;
  return (slot.w * t.pageAspect.w) / (slot.h * t.pageAspect.h);
}

/**
 * スロットの実比率（pageAspect 込み）から、ネーム生成に流す形状ヒントを返す。
 * 生成時に aspect を渡す代わりに、構図側で吸収させるための文言。
 */
export function describeSlotShape(t: ComicLayoutTemplate, i: number): string {
  const ratio = slotAspectRatio(t, i);
  if (ratio >= 1.4) return "横長のワイドコマ";
  if (ratio <= 0.72) return "縦長のコマ";
  return "ほぼ正方形のコマ";
}

// Playwright の純ロジックテストでは Vite を通らず import.meta.env が無いため、
// その場合は開発専用の検査だけを飛ばす（アプリの DEV 時は従来どおり実行）。
if (import.meta.env?.DEV) {
  for (const t of COMIC_LAYOUT_TEMPLATES) {
    // COMIC_PAGE_ASPECT は先頭テンプレから導出している。全テンプレが同一比で
    // ないなら「ページの比率は1つ」という前提が崩れるので、DEV で気付かせる。
    if (
      t.pageAspect.w !== COMIC_LAYOUT_TEMPLATES[0].pageAspect.w ||
      t.pageAspect.h !== COMIC_LAYOUT_TEMPLATES[0].pageAspect.h
    ) {
      throw new Error(
        `comic template ${t.id}: pageAspect が他テンプレと不一致（COMIC_PAGE_ASPECT の前提が崩れる）`,
      );
    }
    if (t.slots.length !== t.panelCount || t.roles.length !== t.panelCount) {
      throw new Error(`comic template ${t.id}: slots/roles と panelCount が不一致`);
    }
    for (const s of t.slots) {
      if (s.points && s.points.length !== 4) {
        throw new Error(`comic template ${t.id}: points は4点固定`);
      }
      if (s.w <= 0 || s.h <= 0) {
        throw new Error(`comic template ${t.id}: 退化スロット`);
      }
    }
  }
}
