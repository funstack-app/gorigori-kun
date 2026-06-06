import { images as imagesIpc } from "../lib/ipc";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages, type GalleryItem } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { sendImageToPlanForRediscuss } from "../lib/sendToPlan";
import type { ContextMenuItem } from "./ContextMenu";

/**
 * F-#12 (没作品削除): ライブラリ/プロジェクトの没作品を物理削除する共通処理。
 * 破壊的操作なので必ず確認ダイアログを挟む。Tauri ネイティブ ask() を優先し、
 * webview によっては no-op になる window.confirm はフォールバックに回す
 * (PromptLibraryModal と同方針)。
 *
 * 成功時は表示 (useImages.items) からも除外し、トーストで通知する。
 */
export async function deleteGalleryImage(
  path: string,
  name?: string,
): Promise<boolean> {
  const label = name ?? path.split(/[\\/]/).pop() ?? "この画像";
  let ok = false;
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    ok = await ask(`「${label}」を削除します。元に戻せません。よろしいですか？`, {
      title: "没作品の削除",
      kind: "warning",
    });
  } catch {
    ok = window.confirm(`「${label}」を削除します。元に戻せません。よろしいですか？`);
  }
  if (!ok) return false;

  try {
    await imagesIpc.deleteFile(path);
    useImages.getState().remove(path);
    useToasts.getState().push({
      kind: "success",
      text: "削除しました",
      ttlMs: 2500,
    });
    return true;
  } catch (err) {
    useToasts.getState().push({
      kind: "error",
      text: `削除に失敗しました: ${String(err)}`,
      ttlMs: 5000,
    });
    return false;
  }
}

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
    { kind: "separator" },
    {
      // F-#12: 没作品の削除。確認ダイアログ付きでファイル実体ごと消す。
      label: "削除…",
      icon: "X",
      danger: true,
      onClick: () => void deleteGalleryImage(item.path, item.name),
    },
  );
  return menu;
}
