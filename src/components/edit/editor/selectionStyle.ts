/**
 * キャンバス上の選択枠をアプリのピンク基調に揃える (2026-07-28 STΛCK 実機指摘)。
 *
 * ## なぜ必要か
 *
 * fabric の既定の選択枠は `rgb(178,204,255)` (薄い青) で、これは fabric に
 * 焼かれた値そのもの (`interactiveObjectDefaultValues`)。アプリの他の UI は
 * すべてピンク (`--color-accent` = #ec4899) なので、キャンバスだけ青い枠が出る。
 * 「このアプリの部品ではないものが乗っている」ように見えるのが実害。
 *
 * ## なぜ生成箇所ごとに指定せず1点で決めるか
 *
 * オブジェクトを作る場所は addFillRectLayer / addOverlayTextLayer / addTextLayer /
 * レイヤー分解 / 赤入れ差し替え … と多数ある。生成箇所ごとに書くと、次に
 * 追加される生成箇所で必ず書き忘れる (静かに青枠が復活する)。
 *
 * fabric 6 では各クラスの `getDefaults()` が `super.getDefaults()` と自クラスの
 * `ownDefaults` を**呼び出しのたびに**マージするため、基底の
 * `InteractiveFabricObject.ownDefaults` を書き換えれば以後に作られる全オブジェクト
 * (Rect / Textbox / FabricImage / Group …) に効く。生成側のコードは一切触らない。
 *
 * ## 色はハードコードしない
 *
 * 実行時に CSS 変数 `--color-accent` を読む。App.css のテーマトークンが正本で、
 * ここはその読み手にすぎない。読めない環境 (テスト等) だけ pink-500 の実値に落ちる。
 */

/** `--color-accent` が読めないときの退避値 (App.css と同じ pink-500)。 */
const FALLBACK_ACCENT = "#ec4899";

/** CSS 変数を1つ読む。空文字・SSR 相当の環境では fallback を返す。 */
function readCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** テーマのアクセント色 (ピンク)。App.css の `--color-accent` が正本。 */
export function accentColor(): string {
  return readCssVar("--color-accent", FALLBACK_ACCENT);
}

/**
 * 選択枠・ハンドルのブランド既定値。
 *
 * - `cornerStyle: "circle"` + `transparentCorners: false` … 塗りつぶした丸ハンドル。
 *   既定の白抜き四角より「掴める場所」だと分かりやすい。
 * - `cornerSize: 12` … 既定 13 とほぼ同じだが、丸にすると見かけが一回り小さくなる分の
 *   埋め合わせ。触りやすさを落とさない範囲で控えめにする。
 * - `touchCornerSize: 28` … 実際の当たり判定 (既定 24 より広い)。見た目を大きくせずに
 *   掴みやすさだけ上げる。
 * - `borderScaleFactor: 1.5` … 枠線を少し太く。暗い画像の上でも枠が沈まない。
 * - `cornerStrokeColor` を白にして、暗い画素の上でもハンドルの輪郭が消えないようにする。
 */
export function brandSelectionDefaults(): Record<string, unknown> {
  const accent = accentColor();
  return {
    borderColor: accent,
    borderScaleFactor: 1.5,
    cornerColor: accent,
    cornerStrokeColor: "#ffffff",
    cornerStyle: "circle",
    transparentCorners: false,
    cornerSize: 12,
    touchCornerSize: 28,
  };
}

/**
 * fabric モジュールの基底クラス既定値をブランド色で上書きする。
 *
 * 冪等 (何度呼んでも同じ結果)。キャンバス初期化のたびに呼んでよい。
 * `InteractiveFabricObject` が取れない fabric ビルドでは `FabricObject` に落とす —
 * どちらも取れなければ何もしない (選択枠の色が既定に戻るだけで、機能は壊さない)。
 */
export function applyBrandSelectionDefaults(fabric: Record<string, any>): void {
  const defaults = brandSelectionDefaults();
  const base = fabric?.InteractiveFabricObject ?? fabric?.FabricObject ?? fabric?.Object;
  if (base && typeof base === "object") {
    base.ownDefaults = { ...(base.ownDefaults ?? {}), ...defaults };
  }
}

/**
 * 既にキャンバス上にあるオブジェクトへブランド色を反映する。
 *
 * `ownDefaults` は**これから作られる**オブジェクトにしか効かない。履歴復元
 * (loadFromJSON) で作り直された分や、上書き前に作られた分はここで揃える。
 */
export function applyBrandSelectionToCanvas(canvas: unknown): void {
  const defaults = brandSelectionDefaults();
  const objects =
    (canvas as { getObjects?: () => Array<{ set?: (values: Record<string, unknown>) => void }> })
      ?.getObjects?.() ?? [];
  for (const object of objects) {
    object.set?.(defaults);
  }
  (canvas as { requestRenderAll?: () => void })?.requestRenderAll?.();
}

/**
 * `#rrggbb` を `rgba(r, g, b, alpha)` にする。アクセント色は CSS 変数から来るので、
 * 塗りの薄さ (alpha) だけをここで足す。16進以外の記法で来たらそのまま返す
 * (色を推測して作り替えない)。
 */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * ドラッグで複数選択したときの投げ縄 (キャンバス自体のプロパティ) もピンクにする。
 * オブジェクトの選択枠と色が違うと、同じ「選んでいる」表現に見えない。
 */
export function applyBrandCanvasSelection(canvas: Record<string, any>): void {
  const accent = accentColor();
  canvas.selectionColor = withAlpha(accent, 0.12);
  canvas.selectionBorderColor = accent;
  canvas.selectionLineWidth = 1.5;
}
