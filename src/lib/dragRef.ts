import { images as imagesIpc } from "./ipc";
import type { Reference } from "./store/composer";

/**
 * ゴリゴリくん内部の画像 D&D の共通ヘルパー。
 *
 * STΛCK 指示 (2026-05-19) 全方向 D&D 化:
 * - 内部画像は `application/x-gori-reference` MIME に JSON でエンコード
 * - 外部 OS ファイル (Finder ドラッグ) は dataTransfer.files で受け取り、
 *   imagesIpc.writeUpload で内部ストレージに書き込んでから Reference として扱う
 * - drop ターゲット側はこの2系統を統一的に扱える
 *
 * MIME 一覧:
 * - `application/x-gori-reference`: アプリ内部の Reference JSON (path/name/source/role)
 * - `application/json`: 互換用 (旧版が json で投げているケース)
 * - `Files`: OS ドラッグの File オブジェクト
 */
export const REFERENCE_DRAG_MIME = "application/x-gori-reference";

export type DragSource = "gallery" | "preset" | "upload" | "external";

export type DraggableRef = {
  path: string;
  name: string;
  source?: DragSource;
  role?: string;
};

/** drag source 側ヘルパー: dataTransfer に JSON をセットする */
export function setDragRef(
  dataTransfer: DataTransfer,
  ref: DraggableRef,
): void {
  const payload = JSON.stringify(ref);
  dataTransfer.setData(REFERENCE_DRAG_MIME, payload);
  // application/json も併用 (古い drop ターゲット互換)
  dataTransfer.setData("application/json", payload);
  dataTransfer.effectAllowed = "copy";
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** drop target 側ヘルパー: dataTransfer から内部 Reference をパースする */
export function parseDraggedReference(
  dataTransfer: DataTransfer,
): Reference | null {
  const raw =
    dataTransfer.getData(REFERENCE_DRAG_MIME) ||
    dataTransfer.getData("application/json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Reference>;
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    return {
      path: parsed.path,
      name:
        typeof parsed.name === "string" && parsed.name
          ? parsed.name
          : basename(parsed.path),
      source: parsed.source === "upload" ? "upload" : "gallery",
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

/**
 * drop event から「内部 Reference 配列」と「外部 File 配列」を統一的に取得する。
 *
 * 戻り値の `paths` は内部画像 (= 既にローカル PC 上にあって path で参照可能) の
 * 配列、`files` は OS ドラッグで投げ込まれた File オブジェクトの配列。
 * drop 先は paths はそのまま参照に追加、files は writeUpload で取り込んでから
 * 追加する。
 */
export function extractDropped(dataTransfer: DataTransfer): {
  refs: Reference[];
  files: File[];
} {
  const refs: Reference[] = [];
  const ref = parseDraggedReference(dataTransfer);
  if (ref) refs.push(ref);

  const files: File[] = [];
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      if (file.type.startsWith("image/")) {
        files.push(file);
      }
    }
  }
  return { refs, files };
}

/** File を内部 Upload して Reference に変換 */
export async function fileToUploadReference(file: File): Promise<Reference> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const path = await imagesIpc.writeUpload(
    file.name && file.name.trim() ? file.name : `drop-${Date.now()}.png`,
    buf,
  );
  return {
    path,
    name: file.name && file.name.trim() ? file.name : basename(path),
    source: "upload",
    role: "subject",
  };
}

/** drop event が画像系の drop か判定 (内部 ref or 画像ファイル) */
export function isImageDrop(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes(REFERENCE_DRAG_MIME) ||
    dataTransfer.types.includes("application/json") ||
    dataTransfer.types.includes("Files")
  );
}
