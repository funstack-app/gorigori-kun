import { create } from "zustand";

/**
 * SNS リサイズ書き出しモーダル (W2-2) の開閉状態。
 *
 * SnsExportModal は「対象画像パスの配列」を受け取って各 SNS 推奨サイズへ
 * 一括リサイズする。導線 (右クリックメニュー / プレビュー / 一括選択バー) は
 * この store を経由して開く。useMaskEditor / useImagePreview と同じく、
 * App.tsx に常設マウントした 1 つのモーダルを store 状態で駆動する。
 *
 * - paths が undefined ならモーダルは閉じている。
 * - paths が空配列でも「開く」扱いにはしない (書き出す対象が無いため)。
 */

type SnsExportState = {
  /** 書き出し対象の画像絶対パス一覧。undefined なら閉じている。 */
  paths?: string[];
  /** 対象パスを指定して開く。空配列なら no-op (開かない)。 */
  open: (paths: string[]) => void;
  /** モーダルを閉じる。 */
  close: () => void;
};

export const useSnsExport = create<SnsExportState>((set) => ({
  paths: undefined,
  open: (paths) => {
    if (paths.length === 0) return;
    set({ paths });
  },
  close: () => set({ paths: undefined }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.snsExport = useSnsExport;
}
