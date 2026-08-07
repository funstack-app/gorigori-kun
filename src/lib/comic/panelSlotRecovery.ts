/**
 * 非テンプレページ（おまかせ / コマ追加後 / 1-2コマ構成）のコマ割りを、
 * 完成画像そのものから復元する純関数群。
 *
 * 位置づけ: 復元結果は `page.slotsOverride`（このページの実枠の正）へ書き込む「種の供給装置」。
 * slotsOverride は既にゲート・モーダル・マスク・合成・分割/統合・undo・ページ再生成時の破棄まで
 * 全下流に配線済みなので、復元に成功した瞬間からおまかせページはテンプレページと同じ
 * コードパスに乗る（1コマ再生成だけでなく分割/統合も同時に解禁される）。
 *
 * アルゴリズムは再帰ガター射影分割（XY-cut）。漫画ページは
 * 白地 + 黒枠線 + 白ガター（テンプレ正典でガター約3%）の高コントラストなので、
 * エッジ検出 + ハフ変換級は不要で、行/列の白率プロファイルによる再帰分割で足りる。
 * 斜めコマは対象外（射影分割は軸平行のみ）。外れたページは復元失敗＝安全側に倒す。
 *
 * **数値の信頼度はページ単位では持たない**。コマ単位の自信は選択時の
 * `detectPanelInterior`（±2.5%帯で実枠線へ再フィット、confidence<0.8 で生成不可 + 手動移行）が
 * 既にその役割を持つ。ここは種の供給に徹し、安全ゲートは既存の一段に集約する。
 */

import type { PanelImageData } from "./panelReedit";
import type { ComicLayoutTemplate, ComicPanelSlot } from "./layoutTemplates";
import type { ComicReadingDirection } from "./types";

export type PanelSlotRecoveryFailure =
  /** 分割結果0個 or 全 leaf が最小サイズ未満。 */
  | "no-panels"
  /** MAX_PANELS_PER_PAGE(8) 超。 */
  | "too-many-panels"
  /** スロット合計面積がページの40%未満（白地でない / 全面絵の疑い）。 */
  | "coverage";

export type PanelSlotRecovery =
  /** slots は読み順（rtl）・percent座標・矩形（points なし）。 */
  | { ok: true; slots: ComicPanelSlot[] }
  /**
   * `detectedCount` は too-many-panels のときだけ意味を持つ（認識できたコマ数）。
   * UI 文言が実数を出せるように返す（推測の数字を表示しないため）。
   */
  | { ok: false; failureCode: PanelSlotRecoveryFailure; detectedCount?: number };

export type TemplateSlotAlignmentFailure =
  | "invalid-input"
  | "low-confidence"
  | "drift-too-large"
  | "too-few-boundaries";

export type TemplateSlotAlignmentMetrics = {
  /** テンプレ境界のうち、実画像の枠線へスナップできた割合。 */
  snappedBoundaryRatio: number;
  /** スナップできた境界がテンプレ位置から動いた平均距離（ページ短辺percent）。 */
  averageDriftPercent: number;
  snappedBoundaries: number;
  totalBoundaries: number;
};

export type TemplateSlotAlignment =
  | {
      ok: true;
      /** 実画像の枠外縁へ合わせた、ページpercent座標。 */
      slots: ComicPanelSlot[];
      /** 実測した枠線太さ。複数境界の中央値。 */
      borderPx: number;
      /** 再組立で枠を絵に混ぜないための切り出し余白（borderPx + 1px）。 */
      insetPx: number;
      confidence: number;
      metrics: TemplateSlotAlignmentMetrics;
    }
  | {
      ok: false;
      failureCode: TemplateSlotAlignmentFailure;
      confidence: number;
      metrics: TemplateSlotAlignmentMetrics;
    };

/**
 * 白判定の輝度しきい値。`grayscaleGradient` と同じ係数（0.299/0.587/0.114）を使う。
 * 生成ページの地は 245-255。スクリーントーンは 232 未満に落ちるので拾わない。
 */
const WHITE_LUMA = 232;
/**
 * ガター行/列とみなす白率。吹き出し輪郭（黒2px×2本 ≈ 0.35%）がガターを跨いでも
 * 帯が途切れないよう 1.0 ではなく 0.97 に置く。
 */
const GUTTER_WHITE_RATIO = 0.97;
/**
 * 帯の最小厚み（**絶対 px。解像度に依存させない**）。
 *
 * 旧実装は `max(4px, 短辺 × 0.006)` だったが、これは `EDGE_BORDER_MIN_PX` が
 * 既に踏んだのと同型の誤り: **ガターの実寸はページ解像度に比例しない**。
 * 本格漫画スタイル（黒ベタ主体・コマを細い線で仕切る）では、実ページのコマ間隔は
 * ページが 1024〜1254px でも 2〜6px しかない。短辺比で置くと 1086px 幅で 7px、
 * 1254px 幅で 8px を要求し、**実在するガターを構造的に全て落とす**。
 *
 * 実測（2026-08-04、実ページ26枚のプロファイル）:
 *   ig_b01_18c860e2def8fa40 (1086x1448): ガター行 496-497(2px) / 895-896(2px)
 *   ig_b01_18c877099b3c3190 (1086x1448): ガター行 541-545(5px) / 860-863(4px)
 *   ig_b01_18c8770890558c78 (1024x1536): ガター行 488-493(6px)
 * いずれも旧しきい値 7〜8px 未満で、13/26 ページが coverage 失敗していた。
 *
 * 弾きたいのは「アンチエイリアスの1px にじみ」だけなので、必要なのは 2px という
 * 絶対値であって比率ではない。薄い帯を許した分の安全性は、帯の両側に枠線を要求する
 * `BORDER_ADJACENT` と、行の両端を見る `hasEdgeBorder` が引き続き担う
 * （どちらも実測でこれらの実ページを一切落としていない: 両側 dark 率 0.95〜1.00）。
 */
const MIN_BAND_PX = 2;
/**
 * 枠線隣接の判定範囲（ページ短辺比）。真のガターは黒い枠線に挟まれる。
 * この帯の両側 0.5% 以内に黒率 30% 以上の行/列が無ければ、コマ内の空・白背景による
 * 偽帯とみなして分割に使わない（誤分割の主対策）。
 */
const BORDER_ADJACENT_RANGE_RATIO = 0.005;
/** 枠線とみなす行/列の黒率。 */
const BORDER_ADJACENT_DARK_RATIO = 0.3;
/** leaf として採用する最小コマ寸法（ページ percent）。テンプレ最小コマより一回り小さい下限。 */
const MIN_PANEL_WIDTH_PERCENT = 8;
const MIN_PANEL_HEIGHT_PERCENT = 6;
/** 再帰深さの天井。8コマ上限のレイアウトは深さ3で分割し切れる。 */
const MAX_DEPTH = 4;
/** 復元スロットの上限（prompts.ts の MAX_PANELS_PER_PAGE と一致させる）。 */
const MAX_RECOVERED_PANELS = 8;
/** スロット合計面積の下限（ページ比）。これ未満は白地でない/全面絵の疑い。 */
const MIN_COVERAGE_RATIO = 0.4;
/**
 * 「1スロットがページ全面」とみなす寸法（percent）。
 * テンプレ正典の外周マージンは約4%（＝正当な1コマページでも 92% 程度に収まる）ので、
 * 98% 以上を占める単独スロットは trim が何も剥げなかった＝認識失敗の指紋。
 */
const FULL_PAGE_SLOT_PERCENT = 98;
/**
 * leaf を採用する条件: その region に枠線相当の黒画素が最低限あること。
 *
 * 白紙・ベタ塗りのみの region（＝コマではない）を leaf にしないための下限。
 * これが無いと、ガターが1本も無いページ（全面絵・グレー地）で「ページ全体が1コマ」に
 * なってしまい、coverage ゲートが構造的に発火しない。
 */
const MIN_LEAF_DARK_RATIO = 0.002;

/** 画素インデックス単位の白/黒マップ。行列走査を1回に畳んで再帰中は集計だけを行う。 */
type LumaMask = {
  width: number;
  height: number;
  /** true = 白（輝度 >= WHITE_LUMA）。 */
  white: Uint8Array;
  /** true = 黒（輝度 < WHITE_LUMA の中でも枠線相当に暗いもの）。 */
  dark: Uint8Array;
};

/** 枠線とみなす暗さ。ガター判定の白しきい値とは別軸で、灰色トーンを枠線に数えない。 */
const DARK_LUMA = 128;
/** 内側テンプレ境界の探索幅（ページ短辺比）。detectPanelInterior と同じ ±2.5%。 */
const TEMPLATE_ALIGNMENT_BAND_RATIO = 0.025;
/** 外周境界は、AIの余白量の揺れを覆うため各軸の ±8% を探索する。 */
const TEMPLATE_OUTER_ALIGNMENT_BAND_RATIO = 0.08;
/** 全境界の40%以上を確認できれば、未検出境界はテンプレ位置のまま再組立する。 */
const TEMPLATE_ALIGNMENT_MIN_SNAP_RATIO = 0.4;
/** 1〜2本の偶然一致で通さない、実画像で確認できた境界数の下限。 */
const TEMPLATE_ALIGNMENT_MIN_SNAPPED_BOUNDARIES = 3;
/** 誤マッチの群れを弾く、平均ドリフト量 / 各境界の探索幅の上限。 */
const TEMPLATE_ALIGNMENT_MAX_AVERAGE_DRIFT_RATIO = 0.6;

type Region = { left: number; top: number; right: number; bottom: number };

function buildLumaMask(image: PanelImageData): LumaMask {
  const { width, height, data } = image;
  const white = new Uint8Array(width * height);
  const dark = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const luma = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
    if (luma >= WHITE_LUMA) white[pixel] = 1;
    else if (luma < DARK_LUMA) dark[pixel] = 1;
  }
  return { width, height, white, dark };
}

/** region 内の1行の白率。 */
function rowWhiteRatio(mask: LumaMask, region: Region, y: number): number {
  const span = region.right - region.left + 1;
  if (span <= 0) return 0;
  let count = 0;
  const base = y * mask.width;
  for (let x = region.left; x <= region.right; x += 1) count += mask.white[base + x];
  return count / span;
}

/** region 内の1列の白率。 */
function columnWhiteRatio(mask: LumaMask, region: Region, x: number): number {
  const span = region.bottom - region.top + 1;
  if (span <= 0) return 0;
  let count = 0;
  for (let y = region.top; y <= region.bottom; y += 1) count += mask.white[y * mask.width + x];
  return count / span;
}

function rowDarkRatio(mask: LumaMask, region: Region, y: number): number {
  const span = region.right - region.left + 1;
  if (span <= 0) return 0;
  let count = 0;
  const base = y * mask.width;
  for (let x = region.left; x <= region.right; x += 1) count += mask.dark[base + x];
  return count / span;
}

function columnDarkRatio(mask: LumaMask, region: Region, x: number): number {
  const span = region.bottom - region.top + 1;
  if (span <= 0) return 0;
  let count = 0;
  for (let y = region.top; y <= region.bottom; y += 1) count += mask.dark[y * mask.width + x];
  return count / span;
}

/**
 * region の各辺から、白率がガター相当の行/列を内側へ剥ぐ。
 * 外周マージンと、分割で生じた半ガターを落とす。
 *
 * 剥ぎ切って何も残らなければ（＝region が全面白）null を返す。
 * 「どれだけ剥いだか」では棄却しない: 外周マージン4% + 半ガターは子 region の比率で見ると
 * 簡単に20%を超え、正当なコマまで消えるため（比率での棄却は誤りだった）。
 * コマかどうかの判定は leaf 採用時の `MIN_LEAF_DARK_RATIO` が担う。
 */
function trimRegion(mask: LumaMask, region: Region): Region | null {
  if (region.right <= region.left || region.bottom <= region.top) return null;
  let { left, top, right, bottom } = region;

  // 剥ぐのは「完全な余白行」だけ。黒画素を1つでも含む行/列に達したら止める。
  // 白率だけで剥ぐと、コマ内部の空白行（左右の枠線2pxを除けば白＝白率98.6%）まで
  // 食い進み、コマが丸ごと消える（`GUTTER_WHITE_RATIO` 0.97 を上回るため）。
  // 真のガターは枠線の外側にあり黒画素を含まない、という構造差でここを分ける。
  const rowIsBlank = (y: number) =>
    rowWhiteRatio(mask, { left, top, right, bottom }, y) >= GUTTER_WHITE_RATIO &&
    !rowHasEdgeBorder(mask, { left, top, right, bottom }, y);
  const columnIsBlank = (x: number) =>
    columnWhiteRatio(mask, { left, top, right, bottom }, x) >= GUTTER_WHITE_RATIO &&
    !columnHasEdgeBorder(mask, { left, top, right, bottom }, x);

  while (top < bottom && rowIsBlank(top)) top += 1;
  while (bottom > top && rowIsBlank(bottom)) bottom -= 1;
  while (left < right && columnIsBlank(left)) left += 1;
  while (right > left && columnIsBlank(right)) right -= 1;

  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/**
 * 行/列の「両端に枠線があるか」。ガター行とコマ内部の空白行を分ける構造判定。
 *
 * 白率だけでは両者を分けられない（コマ内部の空白行は左右の枠線2pxを除けば白率98.6%で、
 * ガターしきい値0.97を上回る）。黒率でも分けられない（吹き出しがガターを跨ぐ正当なケースと
 * 同じオーダーになる）。効くのは**黒画素の位置**:
 *
 *   コマ内部の空白行 → 両端（左右の枠線）が黒     ← 分割してはいけない
 *   真のガター行     → 両端は白。跨ぐ吹き出しは中央 ← 分割してよい
 *
 * 端から `EDGE_BORDER_PROBE_RATIO` の範囲を見る。判定は**両端**（Sol 指摘 D 対応）:
 *
 * 枠線に挟まれた行は、定義上「左の枠線」と「右の枠線」の両方を持つ。
 * 一方、吹き出し・効果線がガターの端寄りを1本横切っただけの場合、黒が乗るのは
 * 片側だけになる。片側 OR で拒否していたため、正当な2列ガターが1コマへ縮退していた
 * （端6%以内を細い黒線が横切るプローブで実測）。両端 AND にすると、
 * ⑤（コマ内の偽白帯＝左右とも自分の枠線が黒）は従来どおり弾ける。
 *
 * さらに、片端あたり1画素だけの点（アンチエイリアスの残り・トーンの粒）で
 * 枠線と誤認しないよう、`EDGE_BORDER_MIN_PX` の下限を**連続ラン長**に対して置く。
 */
const EDGE_BORDER_PROBE_RATIO = 0.06;
/**
 * 端の黒画素を「枠線」とみなす最小画素数（**絶対 px。解像度に依存させない**）。
 *
 * 枠線の太さはページ解像度に比例しない: 生成ページの枠線は 1152×1536 の実寸でも
 * 2px 前後で、ページを大きくしても太くならない。したがってここを span 比で置くと、
 * 実寸ほど要求が厳しくなって正当なページを落とす。
 * 旧実装は `max(2, span * 0.004)` だったため、実寸 1152px 幅では約 5px 以上の
 * 枠線を要求し、⑤ が coverage・⑨ が no-panels になっていた（Sol 実測 2026-08-03。
 * 縮小 288×384 の fixture でだけ通っていたのは、そこでは下限が 2px に落ちるため）。
 *
 * 除きたいのは「アンチエイリアスの残り・トーンの粒」＝孤立 1px の点だけなので、
 * 必要なのは 2px という絶対値であって比率ではない。span 比の項は完全に外す。
 *
 * この下限は **連続ラン長**に対して課す（合計画素数ではない）。理由は
 * `longestDarkRun` のコメントを参照。
 */
const EDGE_BORDER_MIN_PX = 2;

/**
 * probe 範囲の黒画素の**最長連続ラン長**を返す。
 *
 * 「範囲内の黒画素の合計」で数えてはいけない。枠線は連続した線なので長さ 2px 以上の
 * ランを作るが、アンチエイリアスの残り・トーンの粒は離れた孤立点として散る。
 * 合計で数えると、離れた 1px の点が 2 個あるだけで枠線と同じ 2 になり、正当なガターが
 * 「枠線に挟まれた列」に化けて 2 コマが 1 コマへ縮退する（Sol 指摘 2026-08-03。
 * 実測: `_work/probe/probe-edge-unit.ts` ケース A で合計方式のみ誤判定）。
 * 連続ラン長で見れば、離れた点はいくつ散らばってもラン長 1 のままなので通らない。
 */
function longestDarkRun(darkAt: (offset: number) => number, probe: number): number {
  let longest = 0;
  let run = 0;
  for (let offset = 0; offset < probe; offset += 1) {
    if (darkAt(offset)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/** 端の probe 範囲に枠線相当の連続黒ランがあるか（散った孤立点は無視）。 */
function edgeDarkEnough(longestRun: number): boolean {
  return longestRun >= EDGE_BORDER_MIN_PX;
}

function rowHasEdgeBorder(mask: LumaMask, region: Region, y: number): boolean {
  const span = region.right - region.left + 1;
  const probe = Math.max(1, Math.round(span * EDGE_BORDER_PROBE_RATIO));
  const base = y * mask.width;
  const left = longestDarkRun((offset) => mask.dark[base + region.left + offset], probe);
  const right = longestDarkRun((offset) => mask.dark[base + region.right - offset], probe);
  return edgeDarkEnough(left) && edgeDarkEnough(right);
}

function columnHasEdgeBorder(mask: LumaMask, region: Region, x: number): boolean {
  const span = region.bottom - region.top + 1;
  const probe = Math.max(1, Math.round(span * EDGE_BORDER_PROBE_RATIO));
  const top = longestDarkRun((offset) => mask.dark[(region.top + offset) * mask.width + x], probe);
  const bottom = longestDarkRun(
    (offset) => mask.dark[(region.bottom - offset) * mask.width + x],
    probe,
  );
  return edgeDarkEnough(top) && edgeDarkEnough(bottom);
}

/** region 内の黒画素率。leaf が「枠線を持つコマ」かどうかの判定に使う。 */
function regionDarkRatio(mask: LumaMask, region: Region): number {
  const width = region.right - region.left + 1;
  const height = region.bottom - region.top + 1;
  if (width <= 0 || height <= 0) return 0;
  let count = 0;
  for (let y = region.top; y <= region.bottom; y += 1) {
    const base = y * mask.width;
    for (let x = region.left; x <= region.right; x += 1) count += mask.dark[base + x];
  }
  return count / (width * height);
}

type Band = { start: number; end: number };

/**
 * region 内の連続ガター行/列（帯）を列挙する。
 *
 * 採用条件は2つ:
 *  1. 厚みが `MIN_BAND_PX`（絶対2px。実ページのガターは解像度によらず2〜6px）以上
 *  2. `BORDER_ADJACENT`: 帯の両側 0.5% 以内に黒率30%以上の行/列がある
 *
 * 2 が誤分割の主対策。真のガターは枠線に挟まれるが、コマ内の空・白背景が作る偽帯は
 * 両側が絵なので黒い枠線行を持たず、ここで落ちる。
 */
function findBands(
  mask: LumaMask,
  region: Region,
  axis: "horizontal" | "vertical",
  minBandPx: number,
  borderRangePx: number,
): Band[] {
  const from = axis === "horizontal" ? region.top : region.left;
  const to = axis === "horizontal" ? region.bottom : region.right;
  const whiteRatio = (index: number) =>
    axis === "horizontal" ? rowWhiteRatio(mask, region, index) : columnWhiteRatio(mask, region, index);
  const darkRatio = (index: number) =>
    axis === "horizontal" ? rowDarkRatio(mask, region, index) : columnDarkRatio(mask, region, index);
  const hasEdgeBorder = (index: number) =>
    axis === "horizontal" ? rowHasEdgeBorder(mask, region, index) : columnHasEdgeBorder(mask, region, index);

  const bands: Band[] = [];
  let runStart: number | null = null;
  for (let index = from; index <= to; index += 1) {
    const isGutter = whiteRatio(index) >= GUTTER_WHITE_RATIO && !hasEdgeBorder(index);
    if (isGutter && runStart === null) runStart = index;
    if ((!isGutter || index === to) && runStart !== null) {
      const runEnd = isGutter && index === to ? index : index - 1;
      if (runEnd - runStart + 1 >= minBandPx) bands.push({ start: runStart, end: runEnd });
      runStart = null;
    }
  }

  // region の外周に接する帯は、分割線ではなく trim 漏れの余白なので落とす
  // （両側に枠線を要求できず、分割しても片方が空になる）。
  const inner = bands.filter((band) => band.start > from && band.end < to);

  return inner.filter((band) => {
    let beforeBorder = false;
    for (let index = Math.max(from, band.start - borderRangePx); index < band.start; index += 1) {
      if (darkRatio(index) >= BORDER_ADJACENT_DARK_RATIO) { beforeBorder = true; break; }
    }
    if (!beforeBorder) return false;
    for (let index = band.end + 1; index <= Math.min(to, band.end + borderRangePx); index += 1) {
      if (darkRatio(index) >= BORDER_ADJACENT_DARK_RATIO) return true;
    }
    return false;
  });
}

/** 帯の最大厚み。どちらの軸で切るかの決定に使う。 */
function thickestBand(bands: Band[]): number {
  return bands.reduce((max, band) => Math.max(max, band.end - band.start + 1), 0);
}

function splitRegion(
  mask: LumaMask,
  region: Region,
  depth: number,
  minBandPx: number,
  borderRangePx: number,
  out: Region[],
): void {
  const trimmed = trimRegion(mask, region);
  if (!trimmed) return;

  // 枠線相当の黒が無い region はコマではない（白紙・ベタ絵）。leaf にしない。
  const emitLeaf = () => {
    if (regionDarkRatio(mask, trimmed) >= MIN_LEAF_DARK_RATIO) out.push(trimmed);
  };

  if (depth >= MAX_DEPTH) {
    emitLeaf();
    return;
  }

  const horizontal = findBands(mask, trimmed, "horizontal", minBandPx, borderRangePx);
  const vertical = findBands(mask, trimmed, "vertical", minBandPx, borderRangePx);
  if (horizontal.length === 0 && vertical.length === 0) {
    emitLeaf();
    return;
  }

  // 最も厚い帯を持つ軸で切る。段組み（水平ガターが太い）が先に割れ、
  // 各段の中で列（垂直ガター）が割れる、という漫画の自然な階層になる。
  const useHorizontal = thickestBand(horizontal) >= thickestBand(vertical);
  const bands = useHorizontal ? horizontal : vertical;
  const start = useHorizontal ? trimmed.top : trimmed.left;
  const end = useHorizontal ? trimmed.bottom : trimmed.right;

  let cursor = start;
  const cuts: Array<{ from: number; to: number }> = [];
  for (const band of bands) {
    const center = Math.round((band.start + band.end) / 2);
    cuts.push({ from: cursor, to: center - 1 });
    cursor = center + 1;
  }
  cuts.push({ from: cursor, to: end });

  for (const cut of cuts) {
    if (cut.to <= cut.from) continue;
    const child: Region = useHorizontal
      ? { left: trimmed.left, top: cut.from, right: trimmed.right, bottom: cut.to }
      : { left: cut.from, top: trimmed.top, right: cut.to, bottom: trimmed.bottom };
    splitRegion(mask, child, depth + 1, minBandPx, borderRangePx, out);
  }
}

function regionToSlot(region: Region, width: number, height: number): ComicPanelSlot {
  const x = (region.left * 100) / width;
  const y = (region.top * 100) / height;
  return {
    x,
    y,
    w: ((region.right + 1) * 100) / width - x,
    h: ((region.bottom + 1) * 100) / height - y,
  };
}

/**
 * 読み順（rtl）へ並べ替える。
 *
 * y 範囲の重なりが小さい方の高さの50%以上なら同じ段とみなして段クラスタを作り、
 * 段は上→下、段内は中心 x 降順（右→左）。テンプレの「配列順=読み順」規約と同一。
 */
function sortReadingOrderRtl(slots: ComicPanelSlot[]): ComicPanelSlot[] {
  const byTop = [...slots].sort((a, b) => a.y - b.y || b.x - a.x);
  const rows: ComicPanelSlot[][] = [];
  for (const slot of byTop) {
    const row = rows.find((candidate) =>
      candidate.some((member) => {
        const overlap = Math.min(member.y + member.h, slot.y + slot.h) - Math.max(member.y, slot.y);
        return overlap >= Math.min(member.h, slot.h) * 0.5;
      }),
    );
    if (row) row.push(slot);
    else rows.push([slot]);
  }
  rows.sort((a, b) => Math.min(...a.map((s) => s.y)) - Math.min(...b.map((s) => s.y)));
  return rows.flatMap((row) => row.sort((a, b) => b.x + b.w / 2 - (a.x + a.w / 2)));
}

/**
 * 完成ページ画像からコマ矩形を復元する。
 *
 * 返す slots は percent 座標の矩形（points なし）・読み順（rtl）。
 * 座標は黒枠線を含む外接矩形で、選択時に `detectPanelInterior` が実枠へ再フィットする前提の「種」。
 */
export function recoverPanelSlots(image: PanelImageData): PanelSlotRecovery {
  if (image.width <= 0 || image.height <= 0) return { ok: false, failureCode: "no-panels" };
  const shortSide = Math.min(image.width, image.height);
  const minBandPx = MIN_BAND_PX;
  const borderRangePx = Math.max(1, Math.round(shortSide * BORDER_ADJACENT_RANGE_RATIO));
  const mask = buildLumaMask(image);

  const regions: Region[] = [];
  splitRegion(
    mask,
    { left: 0, top: 0, right: image.width - 1, bottom: image.height - 1 },
    0,
    minBandPx,
    borderRangePx,
    regions,
  );

  const slots = regions
    .map((region) => regionToSlot(region, image.width, image.height))
    .filter((slot) => slot.w >= MIN_PANEL_WIDTH_PERCENT && slot.h >= MIN_PANEL_HEIGHT_PERCENT);

  if (slots.length === 0) return { ok: false, failureCode: "no-panels" };
  // ページ全面が1スロットになるのは「コマ割りを認識できた」ではなく「白ガターを1本も
  // 見つけられなかった」状態（全面絵・地が白でないページ）。coverage は 100% になるため
  // 面積ゲートでは捕まらず、ここで明示的に落とす必要がある。
  // 枠線のある正当な1コマページは外周マージンの分だけ小さくなるので、この柵に掛からない。
  if (
    slots.length === 1 &&
    slots[0].w >= FULL_PAGE_SLOT_PERCENT &&
    slots[0].h >= FULL_PAGE_SLOT_PERCENT
  ) {
    return { ok: false, failureCode: "coverage" };
  }
  if (slots.length > MAX_RECOVERED_PANELS) {
    return { ok: false, failureCode: "too-many-panels", detectedCount: slots.length };
  }
  const coverage = slots.reduce((sum, slot) => sum + (slot.w / 100) * (slot.h / 100), 0);
  if (coverage < MIN_COVERAGE_RATIO) return { ok: false, failureCode: "coverage" };

  return { ok: true, slots: sortReadingOrderRtl(slots) };
}

type PixelPoint = { x: number; y: number };

type BoundaryProfile = {
  offset: number;
  whiteRatio: number;
  darkRatio: number;
};

type AlignedBoundary = {
  point: PixelPoint;
  direction: PixelPoint;
  snapped: boolean;
  driftPx: number;
  searchRadiusPx: number;
  borderPx?: number;
};

/** `panelPositionPhrases` と同じく、ltr はコマ番号の空間位置を左右反転する。 */
function slotForReadingDirection(
  slot: ComicPanelSlot,
  direction: ComicReadingDirection,
): ComicPanelSlot {
  if (direction === "rtl") {
    return {
      ...slot,
      points: slot.points?.map(([x, y]) => [x, y] as [number, number]),
    };
  }
  const mirroredPoints = slot.points
    ? [slot.points[1], slot.points[0], slot.points[3], slot.points[2]].map(
        ([x, y]) => [100 - x, y] as [number, number],
      )
    : undefined;
  return { ...slot, x: 100 - slot.x - slot.w, points: mirroredPoints };
}

function slotBoundaryPoints(slot: ComicPanelSlot): [number, number][] {
  return slot.points ?? [
    [slot.x, slot.y],
    [slot.x + slot.w, slot.y],
    [slot.x + slot.w, slot.y + slot.h],
    [slot.x, slot.y + slot.h],
  ];
}

type TemplateOuterBounds = { left: number; top: number; right: number; bottom: number };

function templateOuterBounds(slots: ComicPanelSlot[]): TemplateOuterBounds {
  const points = slots.flatMap(slotBoundaryPoints);
  return {
    left: Math.min(...points.map(([x]) => x)),
    top: Math.min(...points.map(([, y]) => y)),
    right: Math.max(...points.map(([x]) => x)),
    bottom: Math.max(...points.map(([, y]) => y)),
  };
}

/** 全スロットの外接範囲に接する辺だけを外周境界に分類する。 */
function isTemplateOuterBoundary(
  start: [number, number],
  end: [number, number],
  bounds: TemplateOuterBounds,
): boolean {
  const same = (first: number, second: number) => Math.abs(first - second) < 1e-9;
  const outerZonePercent = TEMPLATE_OUTER_ALIGNMENT_BAND_RATIO * 100;
  return (
    (bounds.left <= outerZonePercent &&
      same(start[0], bounds.left) &&
      same(end[0], bounds.left)) ||
    (bounds.right >= 100 - outerZonePercent &&
      same(start[0], bounds.right) &&
      same(end[0], bounds.right)) ||
    (bounds.top <= outerZonePercent &&
      same(start[1], bounds.top) &&
      same(end[1], bounds.top)) ||
    (bounds.bottom >= 100 - outerZonePercent &&
      same(start[1], bounds.bottom) &&
      same(end[1], bounds.bottom))
  );
}

function outerBoundarySearchRadiusPx(
  start: PixelPoint,
  end: PixelPoint,
  width: number,
  height: number,
): number {
  if (Math.abs(start.x - end.x) < 1e-9) {
    return width * TEMPLATE_OUTER_ALIGNMENT_BAND_RATIO;
  }
  if (Math.abs(start.y - end.y) < 1e-9) {
    return height * TEMPLATE_OUTER_ALIGNMENT_BAND_RATIO;
  }
  return Math.min(width, height) * TEMPLATE_OUTER_ALIGNMENT_BAND_RATIO;
}

/** 辺の端5%を除いて走査し、隣接辺の角をプロファイルへ混ぜない。 */
function sampleBoundaryProfile(
  mask: LumaMask,
  start: PixelPoint,
  end: PixelPoint,
  normal: PixelPoint,
  offset: number,
): Pick<BoundaryProfile, "whiteRatio" | "darkRatio"> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return { whiteRatio: 0, darkRatio: 0 };

  const from = length * 0.05;
  const to = length * 0.95;
  const samples = Math.max(2, Math.ceil(to - from));
  let white = 0;
  let dark = 0;
  let measured = 0;
  for (let index = 0; index <= samples; index += 1) {
    const along = from + ((to - from) * index) / samples;
    const x = Math.round(start.x + (dx * along) / length + normal.x * offset);
    const y = Math.round(start.y + (dy * along) / length + normal.y * offset);
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) continue;
    const pixel = y * mask.width + x;
    white += mask.white[pixel];
    dark += mask.dark[pixel];
    measured += 1;
  }
  if (measured === 0) return { whiteRatio: 0, darkRatio: 0 };
  return { whiteRatio: white / measured, darkRatio: dark / measured };
}

function profileWhiteBands(profiles: BoundaryProfile[]): Array<{ start: number; end: number }> {
  const bands: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let index = 0; index < profiles.length; index += 1) {
    const isWhite = profiles[index].whiteRatio >= GUTTER_WHITE_RATIO;
    if (isWhite && start === null) start = index;
    if ((!isWhite || index === profiles.length - 1) && start !== null) {
      const end = isWhite && index === profiles.length - 1 ? index : index - 1;
      if (profiles[end].offset - profiles[start].offset + 1 >= MIN_BAND_PX) {
        bands.push({ start, end });
      }
      start = null;
    }
  }
  return bands;
}

/**
 * ガター帯の内側に隣接する暗線を探す。暗率30%以上という既存基準を使い、
 * ガターから内側へ連続する幅を枠線太さとして測る。
 */
function borderBeforeGutter(
  profiles: BoundaryProfile[],
  band: { start: number; end: number },
  borderRangePx: number,
): { snapOffset: number; borderPx: number } | null {
  const searchFrom = Math.max(0, band.start - borderRangePx);
  let seed = -1;
  for (let index = band.start - 1; index >= searchFrom; index -= 1) {
    if (profiles[index].darkRatio >= BORDER_ADJACENT_DARK_RATIO) {
      seed = index;
      break;
    }
  }
  if (seed < 0) return null;

  // 枠から内側の絵まで黒い場合に、コマ全体を「太い枠」と数えないための上限。
  const maxBorderPx = Math.max(1, borderRangePx * 2);
  let runStart = seed;
  while (
    runStart > 0 &&
    seed - runStart + 1 < maxBorderPx &&
    profiles[runStart - 1].darkRatio >= BORDER_ADJACENT_DARK_RATIO
  ) {
    runStart -= 1;
  }
  let runEnd = seed;
  while (
    runEnd + 1 < profiles.length &&
    runEnd - runStart + 1 < maxBorderPx &&
    profiles[runEnd + 1].darkRatio >= BORDER_ADJACENT_DARK_RATIO
  ) {
    runEnd += 1;
  }
  return {
    // slot は枠を含む外接矩形なので、白ガター側の暗線外縁へ合わせる。
    snapOffset: profiles[runEnd].offset,
    borderPx: profiles[runEnd].offset - profiles[runStart].offset + 1,
  };
}

/** 白帯に隣接する最寄りの暗線を選ぶ。 */
function nearestBorderCandidate(
  profiles: BoundaryProfile[],
  borderRangePx: number,
): { snapOffset: number; borderPx: number } | null {
  return profileWhiteBands(profiles)
    .map((band) => borderBeforeGutter(profiles, band, borderRangePx))
    .filter((candidate): candidate is { snapOffset: number; borderPx: number } => candidate !== null)
    .sort((a, b) => Math.abs(a.snapOffset) - Math.abs(b.snapOffset))[0] ?? null;
}

function alignBoundary(
  mask: LumaMask,
  start: PixelPoint,
  end: PixelPoint,
  centroid: PixelPoint,
  searchRadiusPx: number,
  borderRangePx: number,
): AlignedBoundary {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const radius = Math.max(MIN_BAND_PX, Math.floor(searchRadiusPx));
  if (length <= 0) {
    return {
      point: start,
      direction: { x: dx, y: dy },
      snapped: false,
      driftPx: 0,
      searchRadiusPx: radius,
    };
  }

  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  let normal = { x: -dy / length, y: dx / length };
  if ((midpoint.x - centroid.x) * normal.x + (midpoint.y - centroid.y) * normal.y < 0) {
    normal = { x: -normal.x, y: -normal.y };
  }

  const profiles: BoundaryProfile[] = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    profiles.push({
      offset,
      ...sampleBoundaryProfile(mask, start, end, normal, offset),
    });
  }

  const best = nearestBorderCandidate(profiles, borderRangePx);
  if (!best) {
    return {
      point: start,
      direction: { x: dx, y: dy },
      snapped: false,
      driftPx: 0,
      searchRadiusPx: radius,
    };
  }
  return {
    point: { x: start.x + normal.x * best.snapOffset, y: start.y + normal.y * best.snapOffset },
    direction: { x: dx, y: dy },
    snapped: true,
    driftPx: Math.abs(best.snapOffset),
    searchRadiusPx: radius,
    borderPx: best.borderPx,
  };
}

function intersectBoundaries(first: AlignedBoundary, second: AlignedBoundary): PixelPoint | null {
  const denominator = first.direction.x * second.direction.y - first.direction.y * second.direction.x;
  if (Math.abs(denominator) < 0.00001) return null;
  const dx = second.point.x - first.point.x;
  const dy = second.point.y - first.point.y;
  const t = (dx * second.direction.y - dy * second.direction.x) / denominator;
  return {
    x: first.point.x + first.direction.x * t,
    y: first.point.y + first.direction.y * t,
  };
}

function alignedSlotFromBoundaries(
  sourceSlot: ComicPanelSlot,
  boundaries: AlignedBoundary[],
  width: number,
  height: number,
): ComicPanelSlot | null {
  const points = boundaries.map((boundary, index) =>
    intersectBoundaries(boundaries[(index - 1 + boundaries.length) % boundaries.length], boundary),
  );
  if (points.some((point) => point === null)) return null;
  const percentPoints = points.map((point) => [
    Math.max(0, Math.min(100, (point!.x * 100) / width)),
    Math.max(0, Math.min(100, (point!.y * 100) / height)),
  ] as [number, number]);
  const xs = percentPoints.map(([x]) => x);
  const ys = percentPoints.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return sourceSlot.points ? { x, y, w, h, points: percentPoints } : { x, y, w, h };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const emptyAlignmentMetrics = (): TemplateSlotAlignmentMetrics => ({
  snappedBoundaryRatio: 0,
  averageDriftPercent: 0,
  snappedBoundaries: 0,
  totalBoundaries: 0,
});

/**
 * 既知テンプレを事前分布に、実画像のガターと枠線へ各slotを微修正する。
 * 内側境界はページ短辺±2.5%、外周境界は各軸±8%を探索する。外周で枠線が
 * 見つからないときもテンプレ位置を維持する。全境界の40%以上かつ3本以上を照合し、
 * 平均ドリフトが探索幅の60%以内に収まる画像だけを再組立へ渡す。
 */
export function alignSlotsToTemplate(
  image: PanelImageData,
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): TemplateSlotAlignment {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.data.length < image.width * image.height * 4 ||
    template.slots.length === 0 ||
    (direction !== "rtl" && direction !== "ltr")
  ) {
    return {
      ok: false,
      failureCode: "invalid-input",
      confidence: 0,
      metrics: emptyAlignmentMetrics(),
    };
  }

  const shortSide = Math.min(image.width, image.height);
  const searchRadiusPx = shortSide * TEMPLATE_ALIGNMENT_BAND_RATIO;
  const borderRangePx = Math.max(1, Math.round(shortSide * BORDER_ADJACENT_RANGE_RATIO));
  const mask = buildLumaMask(image);
  const expectedSlots = template.slots.map((slot) => slotForReadingDirection(slot, direction));
  const outerBounds = templateOuterBounds(expectedSlots);
  const alignedSlots: ComicPanelSlot[] = [];
  const allBoundaries: AlignedBoundary[] = [];

  for (const slot of expectedSlots) {
    const percentPoints = slotBoundaryPoints(slot);
    if (
      percentPoints.length !== 4 ||
      percentPoints.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
    ) {
      return {
        ok: false,
        failureCode: "invalid-input",
        confidence: 0,
        metrics: emptyAlignmentMetrics(),
      };
    }
    const points = percentPoints.map(([x, y]) => ({
      x: (x * image.width) / 100,
      y: (y * image.height) / 100,
    }));
    const centroid = points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 },
    );
    const boundaries = points.map((point, index) => {
      const end = points[(index + 1) % points.length];
      const outer = isTemplateOuterBoundary(
        percentPoints[index],
        percentPoints[(index + 1) % percentPoints.length],
        outerBounds,
      );
      const aligned = alignBoundary(
        mask,
        point,
        end,
        centroid,
        outer
          ? outerBoundarySearchRadiusPx(point, end, image.width, image.height)
          : searchRadiusPx,
        borderRangePx,
      );
      // 枠線が見つからない境界は、aligned.point が元のテンプレ位置を保つ。
      // 外周も位置維持はするが、無関係な画像を通さないため照合成功数には数えない。
      return aligned;
    });
    const aligned = alignedSlotFromBoundaries(slot, boundaries, image.width, image.height);
    if (!aligned) {
      return {
        ok: false,
        failureCode: "invalid-input",
        confidence: 0,
        metrics: emptyAlignmentMetrics(),
      };
    }
    alignedSlots.push(aligned);
    allBoundaries.push(...boundaries);
  }

  const snapped = allBoundaries.filter((boundary) => boundary.snapped);
  const snappedBoundaryRatio = snapped.length / Math.max(1, allBoundaries.length);
  const averageDriftPercent =
    snapped.length === 0
      ? 0
      : (snapped.reduce((sum, boundary) => sum + boundary.driftPx, 0) / snapped.length / shortSide) * 100;
  const averageDriftRatio =
    snapped.length === 0
      ? 0
      : snapped.reduce(
          (sum, boundary) => sum + boundary.driftPx / boundary.searchRadiusPx,
          0,
        ) / snapped.length;
  const driftScore = Math.max(0, 1 - averageDriftRatio);
  const confidence = Math.max(
    0,
    Math.min(1, snappedBoundaryRatio * (0.8 + 0.2 * driftScore)),
  );
  const metrics: TemplateSlotAlignmentMetrics = {
    snappedBoundaryRatio,
    averageDriftPercent,
    snappedBoundaries: snapped.length,
    totalBoundaries: allBoundaries.length,
  };

  if (snappedBoundaryRatio + Number.EPSILON < TEMPLATE_ALIGNMENT_MIN_SNAP_RATIO) {
    return { ok: false, failureCode: "low-confidence", confidence, metrics };
  }
  if (snapped.length < TEMPLATE_ALIGNMENT_MIN_SNAPPED_BOUNDARIES) {
    return { ok: false, failureCode: "too-few-boundaries", confidence, metrics };
  }
  if (
    averageDriftRatio - Number.EPSILON >
    TEMPLATE_ALIGNMENT_MAX_AVERAGE_DRIFT_RATIO
  ) {
    return { ok: false, failureCode: "drift-too-large", confidence, metrics };
  }

  const borderPx = Math.round(median(snapped.flatMap((boundary) =>
    boundary.borderPx === undefined || boundary.borderPx === 0 ? [] : [boundary.borderPx],
  )));
  return {
    ok: true,
    slots: alignedSlots,
    borderPx,
    insetPx: borderPx === 0 ? 0 : borderPx + 1,
    confidence,
    metrics,
  };
}
