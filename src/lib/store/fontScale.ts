import { create } from "zustand";

/**
 * 文字サイズ倍率 (STΛCK指示 2026-07-25)。
 *
 * ## なぜ localStorage か
 *
 * 設定本体 (useSettings) は Tauri plugin-store で非同期に読む。文字サイズを
 * そこに置くと、起動直後に既定サイズで描画されてから設定値へ切り替わり、
 * 画面全体がちらつく。文字サイズは「最初のペイントの前に確定していないと崩れて見える」
 * 種類の設定なので、同期的に読める localStorage を使う。
 *
 * ## なぜ zoom / transform: scale を使わないか
 *
 * ブラウザ zoom や transform: scale はレイアウト計算とスクロール量がずれて
 * 表示崩れを起こす (スイスイ君で実測: エンジンによって挙動が真逆になり、
 * 実寸px測定方式に切り替えた経緯がある)。
 * ここでは CSS 変数 --font-scale を :root に立て、html の font-size に
 * 掛けるだけにする。Tailwind のサイズ指定は全て rem 連動なので、
 * 余白・行間・ボタン高さも一緒に拡縮し、比率が保たれる = 崩れない。
 *
 * ## 上限を 1.3 に抑える理由
 *
 * それ以上にすると 13インチ (縦 720px 以下) で生成ボタンが画面外へ出る。
 * App.css の既存方針「生成できなくなったら本末転倒なので『見える』を最優先」と同じ。
 */

const LS_KEY = "gori.fontScale.v1";

/** 選べる倍率。極端な値を作らせないため離散値にする。 */
export const FONT_SCALE_OPTIONS = [
  { value: 0.9, label: "小", hint: "情報を多く表示" },
  { value: 1.0, label: "標準", hint: "画面サイズに自動調整" },
  { value: 1.15, label: "大", hint: "読みやすさ優先" },
  { value: 1.3, label: "特大", hint: "13インチでは要素が収まらない場合あり" },
] as const;

const MIN_SCALE = 0.9;
const MAX_SCALE = 1.3;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function readStoredScale(): number {
  try {
    if (typeof window === "undefined") return 1;
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return 1;
    return clampScale(Number.parseFloat(raw));
  } catch {
    return 1;
  }
}

/** :root に倍率を反映する。CSS 側 (App.css) が var(--font-scale) を読む。 */
function applyScale(scale: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-scale", String(scale));
}

type FontScaleState = {
  scale: number;
  setScale: (scale: number) => void;
};

export const useFontScale = create<FontScaleState>((set) => ({
  scale: readStoredScale(),
  setScale: (next) => {
    const scale = clampScale(next);
    applyScale(scale);
    try {
      window.localStorage.setItem(LS_KEY, String(scale));
    } catch {
      // localStorage が使えなくても、そのセッション中は反映される
    }
    set({ scale });
  },
}));

/**
 * 最初のペイント前に倍率を適用する。main.tsx から同期的に呼ぶ。
 * React のマウントを待つと一瞬既定サイズで描画されてちらつく。
 */
export function initFontScale(): void {
  applyScale(readStoredScale());
}
