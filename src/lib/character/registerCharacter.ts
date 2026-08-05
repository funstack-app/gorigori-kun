import { convertFileSrc } from "@tauri-apps/api/core";

import {
  CHARACTER_CATEGORY_ID,
  presetKind,
  usePresets,
  type Preset,
} from "../store/presets";
import type { IdentityCheckResult } from "./identityCheck";
import type { SheetBackground, SheetCutState, SheetPromptMode } from "./types";

/**
 * キャラクター登録パイプライン Phase 4: 統合シート1枚をキャラ型プリセットへ橋渡しする。
 *
 * 既存の usePresets.addPreset({ kind: "character", ... }) をそのまま使う(登録先は新設しない)。
 * attachedImages には統合シートだけを入れ、sheetRoles(path -> role)に character-sheet を記録する。
 * 以降は既存の
 * presetAttachedImagesToReferences 経路で画像・動画生成へそのまま流れる(S3 で確認済みの導線)。
 */

/**
 * 画像 path から 256x256 のサムネ JPEG(base64 data URL)を生成する。
 * 失敗時は null(登録は続行、サムネだけ無しになる)。RegisterPresetDialog と同じ canvas 手法。
 */
async function generateThumbnailDataUrl(imagePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const SIZE = 256;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        const ratio = img.naturalWidth / img.naturalHeight;
        let drawW: number;
        let drawH: number;
        let drawX: number;
        let drawY: number;
        if (ratio >= 1) {
          drawH = SIZE;
          drawW = SIZE * ratio;
          drawX = (SIZE - drawW) / 2;
          drawY = 0;
        } else {
          drawW = SIZE;
          drawH = SIZE / ratio;
          drawX = 0;
          drawY = (SIZE - drawH) / 2;
        }
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = convertFileSrc(imagePath);
  });
}

export type RegisterCharacterArgs = {
  name: string;
  attributes: string;
  /** 生成元の参照画像 (全量)。先頭がメイン=同一性の正。 */
  sourceImages: string[];
  cuts: SheetCutState[];
  /** 検品結果(NoopIdentityChecker のときは verdict="unavailable"、score/checkedAt 無し)。 */
  identity?: IdentityCheckResult;
  categoryId?: string | null;
  /** 上書き対象のプリセット ID (シート作り直し)。無ければ新規登録。 */
  targetPresetId?: string;
  /** シート背景色(登録時の選択。作り直しで復元する) */
  sheetBackground: SheetBackground;
  /** シートの作り方 */
  sheetPromptMode: SheetPromptMode;
  /** 自分で作るモードのプロンプト全文。default モードでは undefined */
  sheetCustomPrompt?: string;
};

/**
 * 完成した統合シートからキャラ型プリセットを登録する。完成画像が無ければ null を返す。
 * identityScore / verifiedAt は identity 結果が持つときだけ埋める(未検品は undefined のまま。
 * no-silent-gap-filling: もっともらしく埋めない)。
 */
export async function registerCharacter(
  args: RegisterCharacterArgs,
): Promise<Preset | null> {
  const completed = args.cuts.filter(
    (c) => c.status === "completed" && Boolean(c.imagePath),
  );
  if (completed.length === 0) return null;

  const imagePath = completed[0].imagePath as string;
  const sheetRoles: Record<string, string> = {
    [imagePath]: "character-sheet",
  };
  const attachedImages = [{ path: imagePath, role: "subject" }];
  const thumbnail = await generateThumbnailDataUrl(imagePath);

  const attributes = args.attributes.trim();
  // 旧読み手 (表情差分の参照解決・シート作り直し・パス改名移行) は単数 sourceImage を
  // 読む。先頭を重複保持することで、新形式で登録したキャラも無修正で扱える。
  const sourceImages = args.sourceImages;
  const primarySourceImage = sourceImages[0];

  // B-5 シート作り直し: 対象プリセットが現存すれば新規追加せず上書きする。
  // 消えていたら通常の新規登録へフォールバック (古い作り直し状態で失敗させない)。
  // identityScore / verifiedAt は新シートの検品結果で置き換える (旧シートの
  // スコアを残すと「検品済み」の偽装になる。未検品なら undefined = 欠落のまま)。
  // 旧シート画像は attachedImages から外れるが、ディスク上のファイルは消さない。
  if (args.targetPresetId) {
    const store = usePresets.getState();
    const target = store.presets.find((p) => p.id === args.targetPresetId);
    if (target && presetKind(target) === "character") {
      store.updatePreset(target.id, {
        name: args.name.trim(),
        characterMeta: {
          ...target.characterMeta,
          attributes: attributes || undefined,
          sourceImage: primarySourceImage,
          sourceImages,
          sheetRoles,
          identityScore: args.identity?.score,
          verifiedAt: args.identity?.checkedAt,
          sheetBackground: args.sheetBackground,
          sheetPromptMode: args.sheetPromptMode,
          // custom→default で作り直したキャラに古いプロンプトが残らないよう、
          // default 登録では明示的に undefined で消す (spread した旧値の上書き)。
          sheetCustomPrompt:
            args.sheetPromptMode === "custom" ? args.sheetCustomPrompt : undefined,
        },
        thumbnail: thumbnail ?? undefined,
        attachedImages,
      });
      return usePresets.getState().presets.find((p) => p.id === target.id) ?? null;
    }
  }

  return usePresets.getState().addPreset({
    name: args.name.trim(),
    // プロンプト型と違いキャラは属性で代替する(RegisterPresetDialog と同挙動)。
    prompt: "",
    kind: "character",
    characterMeta: {
      attributes: attributes || undefined,
      sourceImage: primarySourceImage,
      sourceImages,
      sheetRoles,
      // 未検品は undefined のまま(欠落を可視化)。実採点が付いたときだけ埋める。
      identityScore: args.identity?.score,
      verifiedAt: args.identity?.checkedAt,
      sheetBackground: args.sheetBackground,
      sheetPromptMode: args.sheetPromptMode,
      sheetCustomPrompt:
        args.sheetPromptMode === "custom" ? args.sheetCustomPrompt : undefined,
    },
    // 2026-07-25 STΛCK指示: 登録キャラは「キャラクター」カテゴリへ入れる。
    // 以前は null で保存され、UI 側の並び順で「衣装」等の用途カテゴリに
    // 紛れて見えていた。自分のIPを探せなくなるため独立した箱に入れる。
    categoryId: args.categoryId ?? CHARACTER_CATEGORY_ID,
    thumbnail: thumbnail ?? undefined,
    attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
  });
}
