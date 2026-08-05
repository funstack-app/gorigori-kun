import { expect, test } from "@playwright/test";

import { recoverPanelSlots } from "../src/lib/comic/panelSlotRecovery";
import type { PanelImageData } from "../src/lib/comic/panelReedit";

/**
 * 線認識（再帰ガター射影分割）の回帰ハーネス。
 *
 * fixture は panel-reedit.check.ts と同じ「白地に枠線を直描き」方式で、
 * テンプレ定義には一切依存しない（テンプレを正解データに使うと、テンプレを
 * そのまま返す偽装実装が通ってしまう）。
 *
 * ⑤⑥は「わざと壊した入力で失敗すること」の実証を兼ねる（検査の牙）。
 */

const WIDTH = 1152 / 4;   // 288。実ページ 1152x1536 の 1/4 で比率は同一。
const HEIGHT = 1536 / 4;  // 384

type Rect = { x: number; y: number; w: number; h: number };

/** 白地キャンバス。地は 245（生成ページの地と同じ）。 */
function blankPage(width = WIDTH, height = HEIGHT, fill = 245): PanelImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(fill) };
}

function paint(image: PanelImageData, x: number, y: number, value: number) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
  image.data[offset] = value;
  image.data[offset + 1] = value;
  image.data[offset + 2] = value;
  image.data[offset + 3] = 255;
}

/** percent 指定の矩形を、黒枠線 2px で描く（内部は地のまま = 白）。 */
function strokeRect(image: PanelImageData, rect: Rect, value = 8, thickness = 2) {
  const left = Math.round((rect.x * image.width) / 100);
  const top = Math.round((rect.y * image.height) / 100);
  const right = Math.round(((rect.x + rect.w) * image.width) / 100) - 1;
  const bottom = Math.round(((rect.y + rect.h) * image.height) / 100) - 1;
  for (let t = 0; t < thickness; t += 1) {
    for (let x = left; x <= right; x += 1) { paint(image, x, top + t, value); paint(image, x, bottom - t, value); }
    for (let y = top; y <= bottom; y += 1) { paint(image, left + t, y, value); paint(image, right - t, y, value); }
  }
}

/** 矩形の内側をベタで塗る（絵の代わり。ガターを覆わせたい時に使う）。 */
function fillRect(image: PanelImageData, rect: Rect, value: number) {
  const left = Math.round((rect.x * image.width) / 100);
  const top = Math.round((rect.y * image.height) / 100);
  const right = Math.round(((rect.x + rect.w) * image.width) / 100) - 1;
  const bottom = Math.round(((rect.y + rect.h) * image.height) / 100) - 1;
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) paint(image, x, y, value);
}

/** ページを枠線付きコマ矩形の集合から作る。 */
function pageWithPanels(rects: Rect[], options?: { width?: number; height?: number; fill?: number }) {
  const image = blankPage(options?.width, options?.height, options?.fill);
  for (const rect of rects) strokeRect(image, rect);
  return image;
}

/** 復元スロットが期待矩形と percent で ±tolerance 以内に一致すること。 */
function expectSlotsNear(
  actual: { x: number; y: number; w: number; h: number }[],
  expected: Rect[],
  tolerance = 1.5,
) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((slot, index) => {
    const want = expected[index];
    expect(Math.abs(slot.x - want.x), `slot${index}.x actual=${slot.x} want=${want.x}`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(slot.y - want.y), `slot${index}.y actual=${slot.y} want=${want.y}`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(slot.w - want.w), `slot${index}.w actual=${slot.w} want=${want.w}`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(slot.h - want.h), `slot${index}.h actual=${slot.h} want=${want.h}`).toBeLessThanOrEqual(tolerance);
  });
}

// 6コマ・3段2列（manga02 相当の矩形割り）。外周マージン4%・ガター3%。
const SIX_PANEL_ROWS: Rect[] = [
  { x: 51.5, y: 4, w: 44.5, h: 29 },   // 1: 右上
  { x: 4, y: 4, w: 44.5, h: 29 },      // 2: 左上
  { x: 51.5, y: 35.5, w: 44.5, h: 29 }, // 3: 右中
  { x: 4, y: 35.5, w: 44.5, h: 29 },   // 4: 左中
  { x: 51.5, y: 67, w: 44.5, h: 29 },  // 5: 右下
  { x: 4, y: 67, w: 44.5, h: 29 },     // 6: 左下
];

test("① 3段2列の矩形割りを全コマ復元し、読み順(右→左・上→下)で返す", () => {
  const result = recoverPanelSlots(pageWithPanels(SIX_PANEL_ROWS));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expectSlotsNear(result.slots, SIX_PANEL_ROWS);
  // 読み順の芯: 各段の1コマ目が右側（中心xが大きい）であること。
  for (let row = 0; row < 3; row += 1) {
    const first = result.slots[row * 2];
    const second = result.slots[row * 2 + 1];
    expect(first.x + first.w / 2).toBeGreaterThan(second.x + second.w / 2);
  }
});

test("② 2段2列（4コマ）を復元する", () => {
  const rects: Rect[] = [
    { x: 51.5, y: 4, w: 44.5, h: 44 },
    { x: 4, y: 4, w: 44.5, h: 44 },
    { x: 51.5, y: 52, w: 44.5, h: 44 },
    { x: 4, y: 52, w: 44.5, h: 44 },
  ];
  const result = recoverPanelSlots(pageWithPanels(rects));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expectSlotsNear(result.slots, rects);
});

test("③ 1コマ（全面1枠）を1スロットとして復元する", () => {
  const rects: Rect[] = [{ x: 4, y: 4, w: 92, h: 92 }];
  const result = recoverPanelSlots(pageWithPanels(rects));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expectSlotsNear(result.slots, rects);
});

test("④ 吹き出しがガターを跨いでも帯が途切れず復元できる", () => {
  const image = pageWithPanels(SIX_PANEL_ROWS);
  // 段1と段2のガター(y=33..35.5)を跨ぐ吹き出し輪郭。黒2px×2本の細線なので
  // 白率0.97のしきい値では帯を割らない、という設計値の検査。
  const cx = Math.round((70 * image.width) / 100);
  const cyTop = Math.round((31 * image.height) / 100);
  const cyBottom = Math.round((37 * image.height) / 100);
  for (let y = cyTop; y <= cyBottom; y += 1) {
    paint(image, cx, y, 8);
    paint(image, cx + 1, y, 8);
    paint(image, cx + 18, y, 8);
    paint(image, cx + 19, y, 8);
  }
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.slots.length).toBe(6);
  expectSlotsNear(result.slots, SIX_PANEL_ROWS);
});

/**
 * 解像度セット。**縮小と実寸の両方で回す**（Sol 指摘 2026-08-03）。
 *
 * 枠線の太さ 2px はページ解像度に比例しない（生成ページは実寸 1152×1536 でも 2px 前後）。
 * 縮小 fixture だけで検査していると、判定しきい値を span 比で置いた実装が
 * 「縮小では通り実寸では落ちる」状態のまま緑になる。実際その退行が起きていた
 * （実寸で ⑤=coverage・⑨=no-panels）。fixture が実寸を代表するようここで固定する。
 */
const RESOLUTIONS = [
  { label: "縮小288x384", width: WIDTH, height: HEIGHT },
  { label: "実寸1152x1536", width: 1152, height: 1536 },
] as const;

for (const res of RESOLUTIONS) {
test(`⑤ コマ内の白い空（偽ガター）で誤分割しない — 枠線構造の牙 [${res.label}]`, () => {
  // 横長1コマ（ページ幅いっぱい）を2つ積んだ構成。
  // 上のコマの内部を「絵 / 真っ白な帯 / 絵」に作り分ける。
  //
  // この白帯はコマを左右に貫き、白率1.0・厚みもガター相当なので、
  // 「白率 + 厚み」だけの判定では必ず分割線に化ける（＝コマ数が3になる）。
  // 弾ける根拠は BORDER_ADJACENT ただ一つ: 真のガターは上下を枠線に挟まれるが、
  // この偽帯の上下にあるのは絵であって枠線ではない。
  //
  // 横長コマにしているのは、2列レイアウトだと region の左右に自分の枠線が入って
  // 白率が 0.97 に届かず、BORDER_ADJACENT に到達する前に落ちてしまうため
  // （＝ガードの必要性を証明できないテストになる）。
  //
  // このケースを実際に弾いているのは `hasEdgeBorder`（帯の行の左右両端に
  // コマの縦枠線が乗っている＝枠線に挟まれた行）であり、BORDER_ADJACENT 単独ではない
  // （Sol 指摘 D、2026-08-03）。BORDER_ADJACENT は「帯の上下に黒い行があるか」しか見ず、
  // ここでは上下がベタ絵（黒率≈1.0）なので通過してしまう。
  // 左右枠線を白で塗り抜いた変種で実測し、3コマへ過分割することを確認済み。
  // したがって本ケースは「枠線構造（両端＋隣接）を合わせた牙」の検査として扱う。
  const rects: Rect[] = [
    { x: 4, y: 4, w: 92, h: 44 },
    { x: 4, y: 52, w: 92, h: 44 },
  ];
  const image = pageWithPanels(rects, { width: res.width, height: res.height });
  fillRect(image, { x: 6, y: 7, w: 88, h: 14 }, 60);   // 上の絵
  fillRect(image, { x: 6, y: 21, w: 88, h: 6 }, 255);  // 偽ガター（完全な白帯）
  fillRect(image, { x: 6, y: 27, w: 88, h: 18 }, 60);  // 下の絵
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  // 誤分割していれば 3 になる。ここが落ちたら枠線構造の判定が効いていない。
  expect(result.slots.length, `偽ガターで過分割した: ${JSON.stringify(result.slots)}`).toBe(2);
  expectSlotsNear(result.slots, rects);
});
}

test("⑥ 全面ベタ絵（コマ枠なし）は coverage 失敗になる", () => {
  const image = blankPage();
  // ページ全面が絵。白ガターが存在しないので、復元は安全側に倒れる。
  fillRect(image, { x: 0, y: 0, w: 100, h: 100 }, 90);
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("coverage");
});

test("⑦ グレー地（ガターが白でない）ページは復元に失敗する", () => {
  // 地が 200（WHITE_LUMA 232 未満）。ガター行が白判定されず帯が立たない。
  const image = pageWithPanels(SIX_PANEL_ROWS, { fill: 200 });
  const result = recoverPanelSlots(image);
  expect(result.ok, `グレー地を復元してしまった: ${JSON.stringify(result)}`).toBe(false);
  if (result.ok) return;
  expect(["no-panels", "coverage"]).toContain(result.failureCode);
});

for (const res of RESOLUTIONS) {
test(`⑨ ガター端を細い黒線が横切っても2列を復元する — hasEdgeBorder の過敏さ回帰 [${res.label}]`, () => {
  // Sol の追加プローブ（2026-08-03 外部評価 D）。2列レイアウトの縦ガターを、
  // 上端から6%以内（＝probe 範囲）で細い黒線が1本横切るケース。
  //
  // 旧実装は「片端に黒画素が1個でもあれば枠線」と判定していたため、
  // このガター列が丸ごと「枠線に挟まれた列」に化け、2コマが1コマへ縮退していた。
  // 両端 AND に変えた今は、下端が白いままなので枠線と誤認しない。
  const rects: Rect[] = [
    { x: 51.5, y: 4, w: 44.5, h: 92 },
    { x: 4, y: 4, w: 44.5, h: 92 },
  ];
  const image = pageWithPanels(rects, { width: res.width, height: res.height });
  // 縦ガターの中心 x（2コマの間 48.5%〜51.5% の中央 = 50%）。
  const gutterX = Math.round((50 * image.width) / 100);
  // 上端から 3%（probe = 6% 以内）を横切る黒の細線。
  const crossY = Math.round((3 * image.height) / 100);
  for (let x = gutterX - 4; x <= gutterX + 4; x += 1) {
    paint(image, x, crossY, 8);
    paint(image, x, crossY + 1, 8);
  }
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    result.slots.length,
    `端側の黒線でガターを見失い縮退した: ${JSON.stringify(result.slots)}`,
  ).toBe(2);
  expectSlotsNear(result.slots, rects);
});

test(`⑩ ガター両端の孤立1px黒点を枠線と誤認しない [${res.label}]`, () => {
  // `EDGE_BORDER_MIN_PX = 2` の下限が生きているかの検査。
  //
  // 端の黒画素を無条件に枠線とみなすと、アンチエイリアスの残り・トーンの粒
  // （1px の孤立点）でガター列が「枠線に挟まれた列」に化け、2コマが1コマへ縮退する。
  // 逆に下限を span 比で置くと実寸で 2px の実枠線を落とす（⑤⑨ の実寸ケースが担保）。
  // この2つで下限を上下から挟み、絶対 2px という値を固定する。
  const rects: Rect[] = [
    { x: 51.5, y: 4, w: 44.5, h: 92 },
    { x: 4, y: 4, w: 44.5, h: 92 },
  ];
  const image = pageWithPanels(rects, { width: res.width, height: res.height });
  const gutterX = Math.round((50 * image.width) / 100);
  // 縦ガターの上端寄り・下端寄り（probe 範囲内）に 1px ずつだけ黒点を置く。
  paint(image, gutterX, Math.round((2 * image.height) / 100), 8);
  paint(image, gutterX, Math.round((97 * image.height) / 100), 8);
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    result.slots.length,
    `孤立1px を枠線と誤認しガターを見失った: ${JSON.stringify(result.slots)}`,
  ).toBe(2);
  expectSlotsNear(result.slots, rects);
});

test(`⑪ ガター端に離れた1px黒点が2個あっても枠線と誤認しない [${res.label}]`, () => {
  // Sol 追加指摘（2026-08-03）。⑩ は「片端あたり 1px が 1 個」しか置かないので、
  // 下限を**合計**で数える実装でも通ってしまう（合計 1 < 2）。
  // 端 probe 内に**離れた 1px 点を 2 個**置くと合計は 2 に達し、合計方式は
  // 枠線と誤認して 2 コマを 1 コマへ縮退させる。連続ラン長で見れば各ランは 1 のままで通らない。
  // 実測: `_work/probe/probe-edge-unit.ts` ケース A（合計方式のみ誤判定）。
  const rects: Rect[] = [
    { x: 51.5, y: 4, w: 44.5, h: 92 },
    { x: 4, y: 4, w: 44.5, h: 92 },
  ];
  const image = pageWithPanels(rects, { width: res.width, height: res.height });
  // 攻撃は**ガター帯の全列**に置く。1 列だけ潰しても残りの列がガターのままなので
  // 帯が生き残り、合計方式の誤判定が結果まで伝播しない（＝牙が抜けたテストになる）。
  const gutterStart = Math.round((48.5 * image.width) / 100);
  const gutterEnd = Math.round((51.5 * image.width) / 100);
  // 端 probe（短辺 6%）の内側に、互いに離れた 1px 点を上下それぞれ 2 個ずつ置く。
  // 各ランの長さは 1 のままだが合計は 2 に達するので、合計方式だけが枠線と誤認する。
  //
  // 点は**コマの上下端より内側**に置く。コマ枠の外（ページ余白側）に置くと、
  // 復元されるスロットの外接矩形がそこまで広がり、座標比較が座標ズレで落ちる
  // （検査したいのは「2コマに割れるか」なので、そこを汚さない）。
  const top = Math.round((4 * image.height) / 100);
  const bottom = Math.round((96 * image.height) / 100) - 1;
  const probe = Math.round((bottom - top + 1) * 0.06);
  const near = Math.max(1, Math.round(probe * 0.2));
  const far = Math.max(near + 2, Math.round(probe * 0.7));
  for (let x = gutterStart; x <= gutterEnd; x += 1) {
    for (const offset of [near, far]) {
      paint(image, x, top + offset, 8);
      paint(image, x, bottom - offset, 8);
    }
  }
  const result = recoverPanelSlots(image);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(
    result.slots.length,
    `離れた1px黒点2個の合計を枠線と誤認しガターを見失った: ${JSON.stringify(result.slots)}`,
  ).toBe(2);
  expectSlotsNear(result.slots, rects);
});
}

/**
 * ⑫⑬: 本格漫画スタイル（黒ベタ主体・細い仕切り線）の回帰。
 *
 * 実ページ実測（2026-08-04、ユーザー報告の全滅ケース）で確定した構造:
 *   - コマ内部が黒ベタ（絵）で埋まり、白い余白がほぼ無い
 *   - コマ間隔は**細い白線 2〜6px のみ**で、ページ解像度に比例しない
 *     実測: 1086x1448 のページでガター 2px / 4px / 5px、1024x1536 で 6px
 *
 * 旧実装は minBand を `max(4px, 短辺 × 0.006)` と**短辺比**で置いていたため、
 * 1086px 幅で 7px・1254px 幅で 8px を要求し、実在するガターを構造的に全て落とした
 * （実測 26 ページ中 13 ページが coverage 失敗 = ユーザー報告の「白いコマ間隔を
 * 見つけられませんでした」の正体）。
 *
 * ここは `EDGE_BORDER_MIN_PX` が既に踏んだのと**同型の誤り**なので、同じ形の
 * 回帰柵を置く: 実寸と縮小の両方で回し、比率で置いた実装が緑にならないようにする。
 */
for (const res of RESOLUTIONS) {
test(`⑫ 黒ベタコマを細い白線(2px)で仕切ったページを復元する — 実ページ回帰 [${res.label}]`, () => {
  // 上下2コマ。コマ内部は黒ベタ（＝絵）で、間は 2px の白線だけ。
  // 枠線は描かず、「黒ベタが白線で仕切られている」実ページの構造をそのまま作る。
  const image = blankPage(res.width, res.height, 245);
  const midY = Math.round(res.height / 2);
  // 上コマ: y=0..midY-2 を黒ベタ。下コマ: midY+1..end を黒ベタ。間の 2px(midY-1, midY) が白。
  for (let y = 0; y < midY - 1; y += 1) for (let x = 0; x < res.width; x += 1) paint(image, x, y, 20);
  for (let y = midY + 1; y < res.height; y += 1) for (let x = 0; x < res.width; x += 1) paint(image, x, y, 20);

  const result = recoverPanelSlots(image);
  expect(result.ok, `細い白線ガターを見つけられなかった: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) return;
  expect(
    result.slots.length,
    `2px の白線で仕切られた2コマを復元できなかった: ${JSON.stringify(result.slots)}`,
  ).toBe(2);
});

test(`⑬ 細い白線が水平・垂直の両方にある黒ベタ4コマを復元する [${res.label}]`, () => {
  // 2x2。仕切りは 3px の白線のみ（枠線なし・内部は黒ベタ）。
  const image = blankPage(res.width, res.height, 245);
  const midY = Math.round(res.height / 2);
  const midX = Math.round(res.width / 2);
  const inGutterY = (y: number) => y >= midY - 1 && y <= midY + 1;
  const inGutterX = (x: number) => x >= midX - 1 && x <= midX + 1;
  for (let y = 0; y < res.height; y += 1) {
    if (inGutterY(y)) continue;
    for (let x = 0; x < res.width; x += 1) {
      if (inGutterX(x)) continue;
      paint(image, x, y, 20);
    }
  }
  const result = recoverPanelSlots(image);
  expect(result.ok, `細い白線(縦横)を見つけられなかった: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) return;
  expect(
    result.slots.length,
    `3px の白線で仕切られた4コマを復元できなかった: ${JSON.stringify(result.slots)}`,
  ).toBe(4);
});
}

test("⑧ 9コマ（3x3）は上限8コマを超えるため too-many-panels", () => {
  const rects: Rect[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      rects.push({ x: 4 + col * 31, y: 4 + row * 31, w: 28, h: 28 });
    }
  }
  const result = recoverPanelSlots(pageWithPanels(rects));
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("too-many-panels");
});
