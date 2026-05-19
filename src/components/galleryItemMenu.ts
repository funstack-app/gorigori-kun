import { useImagePreview } from "../lib/store/imagePreview";
import { useImages, type GalleryItem } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useThreads } from "../lib/store/threads";
import { sendImageToPlanForRediscuss } from "../lib/sendToPlan";
import type { ContextMenuItem } from "./ContextMenu";

/**
 * Build the context menu for a generated image. Used by both the gallery
 * sidebar (VirtualGalleryGrid) and the inline chat thumbnails
 * (ImageGenerationGroup) so right-click is consistent everywhere.
 *
 * F-#1 修正 (2026-05-19): `onRegisterPreset` を ctx に渡すと「プリセットに登録」
 * 項目が先頭ブロックに差し込まれる。f_matsu106 さんの「ライブラリ画像右クリックで
 * プリセット登録できない」報告への対応。
 */
export function buildGalleryItemMenu(
  item: GalleryItem,
  ctx: {
    favorites: Set<string>;
    onToggleFavorite: (path: string) => void;
    onRegisterPreset?: (path: string) => void;
  },
): ContextMenuItem[] {
  const isFav = ctx.favorites.has(item.path);
  const cwd = useThreads.getState().cwd;
  const menu: ContextMenuItem[] = [
    /*
     * STΛCK 指示 (2026-05-19, NRC さん要望): 最上位の特別アクションとして
     * 「企画で再検討」を配置。お気に入りの生成画像をベースに、企画タブで
     * GPT-5.5 と対話しながらプロンプトを練り直す導線。
     */
    {
      label: "企画で再検討",
      icon: "T",
      onClick: () => void sendImageToPlanForRediscuss(item.path),
    },
    { kind: "separator" },
    {
      label: "拡大表示",
      icon: "O",
      onClick: () => useImagePreview.getState().open(item.path),
    },
    {
      label: "マスクで編集",
      icon: "M",
      onClick: () =>
        useMaskEditor.getState().open({ path: item.path, name: item.name }),
    },
    {
      label: "背景を透過 (Vision)",
      icon: "B",
      onClick: () => {
        void useImages.getState().removeBackground(item.path);
      },
    },
  ];
  if (ctx.onRegisterPreset) {
    menu.push({
      label: "プリセットに登録…",
      icon: "P",
      onClick: () => ctx.onRegisterPreset?.(item.path),
    });
  }
  menu.push(
    { kind: "separator" },
    {
      label: "名前を付けて保存…",
      icon: "D",
      onClick: () => useImages.getState().downloadAs(item.path, item.name),
    },
    {
      label: item.savedTo ? "プロジェクトへ保存済み" : "プロジェクトへ移動",
      icon: "P",
      disabled: !cwd || !!item.savedTo,
      onClick: () => {
        if (cwd) useImages.getState().saveToProject(item.path, cwd);
      },
    },
    {
      label: "Finder で表示",
      icon: "F",
      onClick: () => useImages.getState().revealInFinder(item.path),
    },
    { kind: "separator" },
    {
      label: isFav ? "お気に入りから外す" : "お気に入りに追加",
      icon: "S",
      onClick: () => ctx.onToggleFavorite(item.path),
    },
  );
  return menu;
}
