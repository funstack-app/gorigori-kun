import {
  images as imagesIpc,
  history,
  sessions as sessionsApi,
  type GenerationInfo,
} from "../lib/ipc";
import { useComposer } from "../lib/store/composer";
import { useImagePreview } from "../lib/store/imagePreview";
import {
  useImages,
  type GalleryItem,
  type Judgement,
} from "../lib/store/images";
import { useProjects } from "../lib/store/projects";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useSnsExport } from "../lib/store/snsExport";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
import { useEditor } from "./edit/editor/editorStore";
import { sendImageToPlanForRediscuss } from "../lib/sendToPlan";
import type { ContextMenuItem } from "./ContextMenu";

/** 履歴 turn の逆引き上限。ImageMetaPanel と揃える (Rust 側 clamp(1, 2000))。 */
const HISTORY_LOOKUP_LIMIT = 2000;

export type ImagePreviewMetadata = {
  source: "history" | "project" | "missing" | "error";
  prompt: string | null;
  modelLabel: string | null;
  generatedAt: number | null;
  notice: string | null;
};

export type ImagePreviewPrimaryActions = {
  canUseAsReference: boolean;
  canRecreate: boolean;
  recreateDisabledReason: string | null;
  canSave: boolean;
};

function previewModelLabel(meta: GenerationInfo): string | null {
  const displayName = meta.modelDisplayName?.trim();
  if (displayName) {
    if (meta.provider === "magnific") return `Magnific · ${displayName}`;
    if (meta.provider === "higgsfield") return `Higgsfield · ${displayName}`;
    if (meta.provider === "codex") return `Codex · ${displayName}`;
    return displayName;
  }
  return meta.model?.trim() || null;
}

/**
 * 詳細パネルの表示値を、取得済みの履歴と projects.json のプロンプトだけから作る。
 * 履歴が無い場合にモデルや日時を推測しないことが、この関数の重要な境界。
 */
export function buildImagePreviewMetadata(
  generation: GenerationInfo | null,
  projectPrompt: string | null = null,
): ImagePreviewMetadata {
  if (generation) {
    const prompt = generation.prompt?.trim() || null;
    return {
      source: "history",
      prompt,
      modelLabel: previewModelLabel(generation),
      generatedAt:
        Number.isFinite(generation.generatedAt) && generation.generatedAt > 0
          ? generation.generatedAt
          : null,
      notice: prompt ? null : "生成プロンプトは記録されていません。",
    };
  }

  const prompt = projectPrompt?.trim() || null;
  if (prompt) {
    return {
      source: "project",
      prompt,
      modelLabel: null,
      generatedAt: null,
      notice: "プロンプトのみ保存されています。モデルと生成日時は未取得です。",
    };
  }

  return {
    source: "missing",
    prompt: null,
    modelLabel: null,
    generatedAt: null,
    notice: "この画像は取り込み画像のため、生成情報がありません。",
  };
}

/** 主要3アクションの活性条件。UIとテストが同じ判断を使う。 */
export function getImagePreviewPrimaryActions(
  metadata: ImagePreviewMetadata,
  mediaType: "image" | "video" = "image",
): ImagePreviewPrimaryActions {
  const hasRecordedPrompt =
    metadata.source === "history" && !!metadata.prompt?.trim();
  return {
    canUseAsReference: mediaType === "image",
    canRecreate: hasRecordedPrompt,
    recreateDisabledReason: hasRecordedPrompt
      ? null
      : metadata.source === "history"
        ? "生成プロンプトが記録されていないため、同じ設定を読み込めません。"
        : metadata.source === "error"
          ? "生成情報を取得できないため、同じ設定を読み込めません。"
          : "生成履歴がないため、同じ設定を読み込めません。",
    canSave: true,
  };
}

function projectPromptForImage(path: string): string | null {
  for (const project of useProjects.getState().projects) {
    for (const item of project.items) {
      if (item.imagePath === path && item.prompt?.trim()) {
        return item.prompt.trim();
      }
    }
  }
  return null;
}

/** 既存の履歴APIを1回だけ使って、詳細パネル用の正直な表示値を解決する。 */
export async function resolveImagePreviewMetadata(
  path: string,
): Promise<ImagePreviewMetadata> {
  const projectPrompt = projectPromptForImage(path);
  try {
    const generation = await history.generationInfoForImage(path);
    return buildImagePreviewMetadata(generation, projectPrompt);
  } catch {
    if (projectPrompt) return buildImagePreviewMetadata(null, projectPrompt);
    return {
      source: "error",
      prompt: null,
      modelLabel: null,
      generatedAt: null,
      notice: "生成情報を取得できませんでした。",
    };
  }
}

/**
 * ある画像 path の「生成時プロンプト」を解決する。ImageMetaPanel と同じ手順:
 *  1. history.recent で直近 turn を逆引きし、対象 path を含む turn の prompt を採用
 *  2. turn が無ければ projects.json の item.prompt をフォールバックに使う
 * どちらでも取れなければ null。
 */
async function resolvePromptForImage(path: string): Promise<string | null> {
  try {
    const rows = await history.recent(HISTORY_LOOKUP_LIMIT);
    for (const row of rows) {
      try {
        const turn = await sessionsApi.getTurn(row.id);
        if (turn.images.some((img) => img.path === path)) {
          const p = row.prompt?.trim();
          if (p) return p;
        }
      } catch {
        // 単発の getTurn 失敗は無視して次へ
      }
    }
  } catch {
    // 履歴取得失敗時も projects.json フォールバックへ進む
  }
  for (const project of useProjects.getState().projects) {
    for (const it of project.items) {
      if (it.imagePath === path && it.prompt && it.prompt.trim()) {
        return it.prompt.trim();
      }
    }
  }
  return null;
}

/**
 * W3-1 (Command Dock): 画像カードの生成時プロンプトを制作コマンド入力欄へ
 * 読み込む。履歴/projects.json から解決できたら composer.setText で流し込み、
 * 取れなければトーストで通知する。
 */
async function loadPromptIntoComposer(path: string): Promise<void> {
  const prompt = await resolvePromptForImage(path);
  if (!prompt) {
    useToasts.getState().push({
      kind: "info",
      text: "この画像のプロンプトが見つかりませんでした",
      ttlMs: 3200,
    });
    return;
  }
  useComposer.getState().setText(prompt);
  useToasts.getState().push({
    kind: "success",
    text: "制作コマンドに読み込みました",
    ttlMs: 2400,
  });
}

function downloadImageAs(path: string, suggestedName: string): void {
  void useImages
    .getState()
    .downloadAs(path, suggestedName)
    .catch((err) => {
      useToasts.getState().push({
        kind: "error",
        text: `画像の保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    });
}

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
  const label = name ?? path.split(/[\\/]/).pop() ?? "この素材";
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
    // プロジェクトに保存済みの画像を削除した場合、items[].imagePath が実体なしで
    // 残ると「画像が見つかりません」のゴーストになる (2026-06-10 調査)。同期で掃除する。
    useProjects.getState().pruneItemPaths([path]);
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
 * 複数の没作品を一括削除する。選択モードのツールバーから使う。
 * 破壊的操作なので、件数を明示した確認ダイアログを必ず挟む
 * (単一削除と同じく Tauri ネイティブ ask() を優先、webview フォールバックに window.confirm)。
 *
 * 1 件失敗しても残りは続行する Rust 側 (images_delete_many) に合わせ、
 * 成功したパスだけ表示 (useImages.items) から外す。返り値は削除した件数。
 * サムネ付き確認画面を先に出す呼び出し側だけ、確認の重複を避けられる。
 */
export async function deleteGalleryImages(
  paths: string[],
  options: { skipConfirmation?: boolean } = {},
): Promise<number> {
  if (paths.length === 0) return 0;

  if (!options.skipConfirmation) {
    const message = `${paths.length}件の素材を削除します。元に戻せません。よろしいですか？`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "没作品の一括削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return 0;
  }

  try {
    const result = await imagesIpc.deleteFiles(paths);
    const failedPaths = new Set(result.failed.map((f) => f.path));
    const deletedPaths: string[] = [];
    for (const path of paths) {
      // 失敗したパスは実体が残っているので表示からは外さない。
      if (!failedPaths.has(path)) {
        useImages.getState().remove(path);
        deletedPaths.push(path);
      }
    }
    // プロジェクト保存済みアイテムのゴースト化防止 (単一削除と同じ)。
    if (deletedPaths.length > 0) useProjects.getState().pruneItemPaths(deletedPaths);

    if (result.failed.length > 0) {
      useToasts.getState().push({
        kind: result.deleted > 0 ? "warn" : "error",
        text:
          result.deleted > 0
            ? `${result.deleted}件を削除しました（${result.failed.length}件は失敗）`
            : `削除に失敗しました（${result.failed.length}件）`,
        ttlMs: 5000,
      });
    } else {
      useToasts.getState().push({
        kind: "success",
        text: `${result.deleted}件を削除しました`,
        ttlMs: 2500,
      });
    }
    return result.deleted;
  } catch (err) {
    useToasts.getState().push({
      kind: "error",
      text: `一括削除に失敗しました: ${String(err)}`,
      ttlMs: 5000,
    });
    return 0;
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
    /**
     * 判定 (採用/ボツ) の現在値。undefined は「候補」。省略時は
     * store から直接読む (呼び出し側が judgements を渡さなくても動くフォールバック)。
     */
    judgement?: Judgement;
    onSetJudgement?: (path: string, value: Judgement | null) => void;
    /**
     * プロジェクト詳細ビューから開いたとき指定。
     * 「プロジェクトへ移動」(セッション作業フォルダへのファイル移動) は
     * この文脈では自己言及で紛らわしいため出さず、代わりに
     * 「このプロジェクトから外す」(箱から外すだけ・ファイルはライブラリに残る) を出す。
     */
    projectScope?: { onRemoveFromProject: (path: string) => void };
    /**
     * 拡大表示の矢印キーで巡回する前後リスト。省略時は useImages.items 全体に
     * フォールバックする (imagePreview.open の既定挙動)。
     * プロジェクト詳細ではライブラリ全体でなく「この箱の中身」を渡す。
     */
    previewSiblings?: string[];
  },
): ContextMenuItem[] {
  const isFav = ctx.favorites.has(item.path);
  const cwd = useThreads.getState().cwd;
  // ctx.judgement 省略時は store から現在値を引く (candidate = undefined)。
  const judgement =
    ctx.judgement ?? useImages.getState().judgements.get(item.path);
  const setJudgement =
    ctx.onSetJudgement ??
    ((path: string, value: Judgement | null) =>
      void useImages.getState().setJudgement(path, value));
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
    {
      // W3-1 (Command Dock): この画像の生成時プロンプトを制作コマンド入力欄へ
      // 読み込み、同じ設定で微修正・再実行できるようにする。
      label: "このプロンプトを制作コマンドに読込",
      icon: "L",
      onClick: () => void loadPromptIntoComposer(item.path),
    },
    { kind: "separator" },
    {
      label: "拡大表示",
      icon: "O",
      // プロジェクト詳細では、タイルのダブルクリック (VirtualGalleryGrid) と同じく
      // 「この箱の中身」を巡回対象にする。渡さないとライブラリ全体へ
      // フォールバックし、右クリック経由だけプロジェクト外の画像へ矢印で
      // 移動してしまう。
      onClick: () =>
        useImagePreview.getState().open(item.path, ctx.previewSiblings),
    },
    {
      /*
       * 編集タブ (編集スタジオ) への入口。ギャラリーから1手で編集へ入れる。
       *
       * ここで openImageForEditing を直接呼べないのは、非アクティブタブの
       * EditWorkspace がアンマウントされている (GenerationWorkspace が activeTab で
       * 出し分ける) ため。予約 (pendingOpenPath) を置いてタブを切り替え、
       * マウントされた EditWorkspace 側に開かせる。
       */
      label: "編集スタジオで開く",
      icon: "S",
      onClick: () => {
        useEditor.getState().setPendingOpenPath(item.path);
        useWorkspace.getState().setActiveTab("edit");
      },
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
    {
      // W2-2: SNS 用リサイズ書き出し。単一画像を対象に、各 SNS 推奨サイズへ
      // 一括リサイズするモーダルを開く。useMaskEditor と同じく store 経由で開く。
      label: "SNS用に書き出し…",
      icon: "E",
      onClick: () => useSnsExport.getState().open([item.path]),
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
      onClick: () => downloadImageAs(item.path, item.name),
    },
    ctx.projectScope
      ? {
          // プロジェクト詳細ビュー限定。箱から外すだけの非破壊操作なので確認なし。
          label: "このプロジェクトから外す",
          icon: "P",
          onClick: () => ctx.projectScope?.onRemoveFromProject(item.path),
        }
      : {
          label: item.savedTo ? "プロジェクトへ保存済み" : "プロジェクトへ移動",
          icon: "P",
          disabled: !cwd || !!item.savedTo,
          onClick: () => {
            if (!cwd) return;
            void useImages
              .getState()
              .saveToProject(item.path, cwd)
              .then((ok) => {
                useToasts.getState().push(
                  ok
                    ? {
                        kind: "success",
                        text: "プロジェクトへ保存しました",
                        ttlMs: 3000,
                      }
                    : {
                        kind: "error",
                        text: "プロジェクトへの保存に失敗しました。画像は元の場所に残っています",
                      },
                );
              });
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
    // judgement 3値: 採用 / ボツ / 判定を外す。現在値はチェック代わりに
    // 「(採用中)」等のラベルで示す。同じ値を再度押しても no-op にならないよう、
    // 採用中に「採用にする」を押しても害はない (同値 set)。
    {
      label: judgement === "adopted" ? "採用中" : "採用にする",
      icon: "A",
      disabled: judgement === "adopted",
      onClick: () => setJudgement(item.path, "adopted"),
    },
    {
      label: judgement === "rejected" ? "ボツ中" : "ボツにする",
      icon: "R",
      disabled: judgement === "rejected",
      onClick: () => setJudgement(item.path, "rejected"),
    },
    {
      label: "判定を外す",
      icon: "C",
      disabled: judgement === undefined,
      onClick: () => setJudgement(item.path, null),
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
