import { convertFileSrc } from "@tauri-apps/api/core";

import { usePresets, type Preset } from "../store/presets";
import type { IdentityCheckResult } from "./identityCheck";
import type { SheetCutState } from "./types";

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
  sourceImage: string;
  cuts: SheetCutState[];
  /** 検品結果(NoopIdentityChecker のときは verdict="unavailable"、score/checkedAt 無し)。 */
  identity?: IdentityCheckResult;
  categoryId?: string | null;
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

  return usePresets.getState().addPreset({
    name: args.name.trim(),
    // プロンプト型と違いキャラは属性で代替する(RegisterPresetDialog と同挙動)。
    prompt: "",
    kind: "character",
    characterMeta: {
      attributes: attributes || undefined,
      sourceImage: args.sourceImage,
      sheetRoles,
      // 未検品は undefined のまま(欠落を可視化)。実採点が付いたときだけ埋める。
      identityScore: args.identity?.score,
      verifiedAt: args.identity?.checkedAt,
    },
    categoryId: args.categoryId ?? null,
    thumbnail: thumbnail ?? undefined,
    attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
  });
}
