import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 全画面オーバーレイ (fixed inset-0) を body 直下へ描画するための共通部品。
 *
 * なぜ必要か: 祖先に backdrop-filter / transform / filter を持つ要素があると、
 * CSS の仕様で position: fixed の基準がビューポートからその祖先へ変わる。
 * 例: ライブラリの選択バー (backdrop-blur-2xl) の中で開いた削除確認ダイアログが
 * バー基準で配置され、画面下へ溢れてボタンが見えなくなった (2026-08-26 実測)。
 * body 直下に描画すれば祖先のスタイルに影響されず、常にビューポート基準で出せる。
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
