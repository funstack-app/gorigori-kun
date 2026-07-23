import { convertFileSrc } from "@tauri-apps/api/core";

import { usePresets, type Preset } from "../store/presets";
import type { IdentityCheckResult } from "./identityCheck";
import type { SheetCutState } from "./types";

/**
 * キャラクター登録パイプライン Phase 4: 生成した全カットをキャラ型プリセットへ橋渡しする。
 *
 * 既存の usePresets.addPreset({ kind: "character", ... }) をそのまま使う(登録先は新設しない)。
 * RegisterPresetDialog.handleSave と同じ addPreset 形だが、attachedImages が「生成した全カット」に
 * なり、sheetRoles(path -> role)を埋める点だけが違う。以降は既存の
 * presetAttachedImagesToReferences 経路で画像・動画生成へそのまま流れる(S3 で確認済みの導線)。
 */

/**
 * サムネ元(=正本画像)に選ぶカットの優先順。上から順に最初に完成しているカットを使う。
 * STΛCK 指示 (2026-07-19): 顔が一番よく見えるカットを正本にする。
 * 顔ディテール → 顔・正面 → 全身正面 の順。該当が無ければ先頭の完成カットへフォールバック。
 */
const THUMBNAIL_PREFERENCE = ["face-detail", "face-front", "front"];

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

/** サムネ元にする完成カットの path を選ぶ(face-detail→face-front→front→先頭の完成カット)。 */
function pickThumbnailPath(cuts: SheetCutState[]): string | undefined {
  const completed = cuts.filter(
    (c) => c.status === "completed" && Boolean(c.imagePath),
  );
  for (const cutId of THUMBNAIL_PREFERENCE) {
    const hit = completed.find((c) => c.cutId === cutId);
    if (hit?.imagePath) return hit.imagePath;
  }
  return completed[0]?.imagePath;
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
 * 完成カットからキャラ型プリセットを登録する。完成カットが1枚も無ければ null を返す。
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

  const thumbnailPath = pickThumbnailPath(completed);

  // 正本(顔が一番見えるカット)を attachedImages 先頭に置く。
  // STΛCK 指示 (2026-07-19): 呼び出し時の代表参照 (@img1) が顔基準になるように。
  // path・@imgN 採番の実体は変えず、並び順だけ変える。
  const orderedCompleted = thumbnailPath
    ? [
        ...completed.filter((c) => c.imagePath === thumbnailPath),
        ...completed.filter((c) => c.imagePath !== thumbnailPath),
      ]
    : completed;

  // sheetRoles: path -> role。同一 role の重複は最初の1枚を採用。
  const sheetRoles: Record<string, string> = {};
  const attachedImages = orderedCompleted.map((c) => {
    const path = c.imagePath as string;
    if (sheetRoles[path] === undefined) {
      sheetRoles[path] = c.role;
    }
    return { path, role: "subject" };
  });

  const thumbnail = thumbnailPath
    ? await generateThumbnailDataUrl(thumbnailPath)
    : null;

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
