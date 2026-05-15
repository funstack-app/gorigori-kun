import type { EditorLayerKind, EditorLayerMeta } from "./editorStore";

type FabricLikeObject = {
  type?: string;
  visible?: boolean;
  selectable?: boolean;
  evented?: boolean;
  lockMovementX?: boolean;
  lockMovementY?: boolean;
  set?: (values: Record<string, unknown>) => void;
  get?: (key: string) => unknown;
  toDataURL?: (options?: Record<string, unknown>) => string;
};

type FabricLikeCanvas = {
  getObjects?: () => FabricLikeObject[];
  setActiveObject?: (object: FabricLikeObject) => void;
  discardActiveObject?: () => void;
  requestRenderAll?: () => void;
  renderAll?: () => void;
};

export function objectId(object: FabricLikeObject): string {
  const existing = object.get?.("id");
  if (typeof existing === "string" && existing) return existing;
  const generated = createLayerId();
  object.set?.({ id: generated });
  return generated;
}

export function objectName(object: FabricLikeObject): string {
  const name = object.get?.("name");
  if (typeof name === "string" && name.trim()) return name;
  return object.type === "textbox" ? "テキスト" : "画像";
}

export function objectKind(object: FabricLikeObject): EditorLayerKind {
  const kind = object.get?.("layerKind");
  if (kind === "text" || kind === "image" || kind === "mask") return kind;
  if (object.type === "textbox" || object.type === "text" || object.type === "i-text") {
    return "text";
  }
  return "image";
}

export function isLocked(object: FabricLikeObject): boolean {
  return object.get?.("locked") === true;
}

export function setLocked(object: FabricLikeObject, locked: boolean) {
  object.set?.({
    locked,
    selectable: !locked,
    evented: !locked,
    lockMovementX: locked,
    lockMovementY: locked,
  });
}

export function layerMetasFromCanvas(canvas: unknown | null): EditorLayerMeta[] {
  const fabricCanvas = canvas as FabricLikeCanvas | null;
  const objects = fabricCanvas?.getObjects?.() ?? [];
  return objects
    .map((object) => ({
      id: objectId(object),
      name: objectName(object),
      kind: objectKind(object),
      visible: object.visible !== false,
      locked: isLocked(object),
      thumbnail: objectToThumbnail(object),
    }))
    .reverse();
}

export function getObjectById(canvas: unknown | null, id: string | null): FabricLikeObject | null {
  if (!id) return null;
  const objects = (canvas as FabricLikeCanvas | null)?.getObjects?.() ?? [];
  return objects.find((object) => objectId(object) === id) ?? null;
}

export function selectObjectById(canvas: unknown | null, id: string | null) {
  const fabricCanvas = canvas as FabricLikeCanvas | null;
  if (!fabricCanvas) return;
  const object = getObjectById(canvas, id);
  if (object && !isLocked(object)) {
    fabricCanvas.setActiveObject?.(object);
  } else {
    fabricCanvas.discardActiveObject?.();
  }
  fabricCanvas.requestRenderAll?.();
}

export function setObjectVisible(object: FabricLikeObject, visible: boolean) {
  object.set?.({ visible });
}

export function setObjectName(object: FabricLikeObject, name: string) {
  object.set?.({ name });
}

export function removeObjectById(canvas: unknown | null, id: string) {
  const fabricCanvas = canvas as (FabricLikeCanvas & { remove?: (object: FabricLikeObject) => void }) | null;
  const object = getObjectById(canvas, id);
  if (!fabricCanvas || !object) return;
  fabricCanvas.remove?.(object);
  fabricCanvas.requestRenderAll?.();
}

export function reorderObject(canvas: unknown | null, objectIdValue: string, topIndex: number) {
  const fabricCanvas = canvas as (FabricLikeCanvas & {
    moveObjectTo?: (object: FabricLikeObject, index: number) => void;
    moveTo?: (object: FabricLikeObject, index: number) => void;
    _objects?: FabricLikeObject[];
  }) | null;
  if (!fabricCanvas) return;
  const objects = fabricCanvas.getObjects?.() ?? [];
  const object = objects.find((item) => objectId(item) === objectIdValue);
  if (!object) return;
  const bottomIndex = Math.max(0, objects.length - 1 - topIndex);
  if (typeof fabricCanvas.moveObjectTo === "function") {
    fabricCanvas.moveObjectTo(object, bottomIndex);
  } else if (typeof fabricCanvas.moveTo === "function") {
    fabricCanvas.moveTo(object, bottomIndex);
  } else if (Array.isArray(fabricCanvas._objects)) {
    const next = fabricCanvas._objects.filter((item) => item !== object);
    next.splice(bottomIndex, 0, object);
    fabricCanvas._objects.splice(0, fabricCanvas._objects.length, ...next);
  }
  fabricCanvas.requestRenderAll?.();
}

export function createLayerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function objectToThumbnail(object: FabricLikeObject): string | null {
  try {
    return object.toDataURL?.({ format: "png", multiplier: 0.18 }) ?? null;
  } catch {
    return null;
  }
}
