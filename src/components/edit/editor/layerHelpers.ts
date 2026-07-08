import { GENRE_LABELS, isLayerGenre, type LayerGenre } from "../../../lib/edit/genre";
import type { EditorLayerKind, EditorLayerMeta } from "./editorStore";

export type FabricLikeObject = {
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

/**
 * レイヤーの大ジャンルを決める。優先順:
 * 1. レイヤー生成時に焼いた明示 genre (magicLayerToFabric が付与)
 * 2. 構造フォールバック — textbox/textSpec 持ち = text、id "bg" = background、残り = prop
 *
 * なぜフォールバックがあるか: genre 付与前に保存された履歴スナップショットや
 * 旧セッション由来のレイヤーでも、ツリー表示が壊れず必ずどこかの見出しに入る。
 */
export function objectGenre(object: FabricLikeObject): LayerGenre {
  const explicit = object.get?.("genre");
  if (isLayerGenre(explicit)) return explicit;
  if (objectKind(object) === "text") return "text";
  if (object.get?.("textSpec")) return "text"; // 元画素そのままのテキスト素材レイヤー
  if (object.get?.("id") === "bg") return "background";
  return "prop";
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
      genre: objectGenre(object),
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

/**
 * 「人 = 1レイヤー」の集約サマリ (gap-audit G2)。
 *
 * SCHP で人物が髪/上衣/パンツ… と複数パーツに割れても、編集タブでは「人」を1つの
 * まとまりとして選択・移動・表示できるようにする。この関数は fabric に触らない純ロジックで、
 * genre === "person" のレイヤーメタ列から「まとめ操作の対象 id 列」「まとめ表示状態」
 * 「畳んだときのサマリ名」を決定論で導く (回帰テストの駆動源)。
 *
 * まとめ表示状態:
 * - "all": 全パーツ表示 → まとめトグルで全非表示にできる
 * - "none": 全パーツ非表示 → まとめトグルで全表示に戻せる
 * - "mixed": 一部だけ表示 → まとめトグルは「全部表示」に寄せる (揃える方向を安全側に固定)
 */
export type PersonGroupState = "all" | "none" | "mixed";

export type PersonGroupSummary = {
  ids: string[];
  count: number;
  visibleState: PersonGroupState;
  /** 全パーツがロック済みなら true (まとめロックのトグル方向判定に使う)。 */
  allLocked: boolean;
  /** 畳んだときに1行で見せる名前 (例: 「人 (3パーツ)」)。単一パーツなら括弧なし。 */
  collapsedLabel: string;
};

export function personGroupSummary(layers: readonly EditorLayerMeta[]): PersonGroupSummary | null {
  const persons = layers.filter((layer) => layer.genre === "person");
  if (persons.length === 0) return null;
  const visibleCount = persons.filter((layer) => layer.visible).length;
  const visibleState: PersonGroupState =
    visibleCount === persons.length ? "all" : visibleCount === 0 ? "none" : "mixed";
  const allLocked = persons.every((layer) => layer.locked);
  const collapsedLabel =
    persons.length === 1 ? GENRE_LABELS.person : `${GENRE_LABELS.person} (${persons.length}パーツ)`;
  return {
    ids: persons.map((layer) => layer.id),
    count: persons.length,
    visibleState,
    allLocked,
    collapsedLabel,
  };
}

/**
 * 複数レイヤーを1つのまとまりとして選択する (fabric ActiveSelection)。
 * ロック済み・非表示のパーツは選択対象から外す (動かせないものを掴んで見た目だけ選択される
 * 事故を避ける)。選択対象が1件なら単純な単一選択にフォールバックする。
 * 戻り値: 実際に選択されたレイヤー数 (0 のときは選択できるパーツが無かった)。
 */
export async function selectLayersByIds(
  canvas: unknown | null,
  ids: readonly string[],
): Promise<number> {
  const fabricCanvas = canvas as
    | (FabricLikeCanvas & { add?: (object: FabricLikeObject) => void })
    | null;
  if (!fabricCanvas) return 0;
  const selectable = ids
    .map((id) => getObjectById(canvas, id))
    .filter((object): object is FabricLikeObject => {
      if (!object) return false;
      if (isLocked(object)) return false;
      if (object.visible === false) return false;
      return true;
    });
  fabricCanvas.discardActiveObject?.();
  if (selectable.length === 0) {
    fabricCanvas.requestRenderAll?.();
    return 0;
  }
  if (selectable.length === 1) {
    fabricCanvas.setActiveObject?.(selectable[0]);
    fabricCanvas.requestRenderAll?.();
    return 1;
  }
  const fabric = (await import("fabric")) as Record<string, unknown>;
  const ActiveSelection = fabric.ActiveSelection as
    | (new (objects: FabricLikeObject[], options: Record<string, unknown>) => FabricLikeObject)
    | undefined;
  if (ActiveSelection) {
    const selection = new ActiveSelection(selectable, { canvas: fabricCanvas });
    fabricCanvas.setActiveObject?.(selection);
  } else {
    // ActiveSelection が無い fabric ビルドでは最前面パーツの単一選択に劣化 (機能を止めない)。
    fabricCanvas.setActiveObject?.(selectable[selectable.length - 1]);
  }
  fabricCanvas.requestRenderAll?.();
  return selectable.length;
}

/**
 * 現在のキャンバス選択状態を、グループUIの出し分けに使う3値で返す。
 * - "multi": 2つ以上のレイヤーを選択中 → 「グループ化」ボタンを出す
 * - "group": グループを1つ選択中 → 「グループ解除」ボタンを出す (id で解除対象を渡す)
 * - "none": それ以外 (未選択・単一の非グループ) → どちらのボタンも出さない
 */
export type GroupSelectionState =
  | { kind: "multi"; count: number }
  | { kind: "group"; id: string }
  | { kind: "none" };

export function groupSelectionState(canvas: unknown | null): GroupSelectionState {
  const fabricCanvas = canvas as
    | (FabricLikeCanvas & { getActiveObject?: () => FabricLikeObject | null })
    | null;
  const active = fabricCanvas?.getActiveObject?.() as
    | (FabricLikeObject & { type?: string; getObjects?: () => FabricLikeObject[] })
    | null;
  if (!active) return { kind: "none" };
  // 単一グループを選択中 (type=group)。
  if (active.type === "group") {
    return { kind: "group", id: objectId(active) };
  }
  // ActiveSelection (複数選択) は getObjects で中身が2件以上取れる。
  const members = active.getObjects?.() ?? [];
  if (members.length >= 2) {
    return { kind: "multi", count: members.length };
  }
  return { kind: "none" };
}

/**
 * 現在の選択 (fabric ActiveSelection) を1つの Group に束ねる (Canva「グループ化」相当・差4)。
 * 分離した複数レイヤーを選んで束ね直し、一体で移動・拡縮できるようにする。
 *
 * 手順 (fabric v6): ActiveSelection から対象を取り出し → キャンバスから外し →
 * new Group(objects) を作ってキャンバスへ追加 → その Group を選択状態にする。
 * 対象が2件未満なら何もしない (グループ化は複数選択が前提)。
 * 戻り値: 作成した Group の id (成功時) / null (対象不足・fabric 非対応)。
 */
export async function groupSelectedLayers(canvas: unknown | null): Promise<string | null> {
  const fabricCanvas = canvas as
    | (FabricLikeCanvas & {
        getActiveObject?: () => FabricLikeObject | null;
        add?: (object: FabricLikeObject) => void;
        remove?: (...objects: FabricLikeObject[]) => void;
      })
    | null;
  if (!fabricCanvas) return null;
  const active = fabricCanvas.getActiveObject?.() as
    | (FabricLikeObject & { getObjects?: () => FabricLikeObject[] })
    | null;
  // ActiveSelection のときだけ getObjects で中身が取れる。単一選択・未選択は対象外。
  const members = active?.getObjects?.() ?? [];
  if (members.length < 2) return null;

  const fabric = (await import("fabric")) as Record<string, unknown>;
  const Group = fabric.Group as
    | (new (objects: FabricLikeObject[], options?: Record<string, unknown>) => FabricLikeObject)
    | undefined;
  if (!Group) return null;

  // 選択を解いてから元オブジェクトをキャンバスから外す (ActiveSelection の変換座標を確定させる)。
  fabricCanvas.discardActiveObject?.();
  fabricCanvas.remove?.(...members);
  const group = new Group(members, {}) as FabricLikeObject;
  const id = objectId(group);
  group.set?.({ name: "グループ", layerKind: "image", genre: "prop" });
  fabricCanvas.add?.(group);
  fabricCanvas.setActiveObject?.(group);
  fabricCanvas.requestRenderAll?.();
  return id;
}

/**
 * Group を解除して中身を個別レイヤーへ戻す (Canva「グループ解除」相当・差4)。
 * 指定 id のオブジェクトが Group でなければ何もしない (誤操作で単一レイヤーを壊さない)。
 * 戻り値: 解除して戻した子レイヤー数 (0 = 対象が Group でない / fabric 非対応)。
 */
export async function ungroupLayer(canvas: unknown | null, id: string): Promise<number> {
  const fabricCanvas = canvas as
    | (FabricLikeCanvas & {
        add?: (object: FabricLikeObject) => void;
        remove?: (...objects: FabricLikeObject[]) => void;
      })
    | null;
  if (!fabricCanvas) return 0;
  const target = getObjectById(canvas, id) as
    | (FabricLikeObject & {
        type?: string;
        removeAll?: () => FabricLikeObject[];
        getObjects?: () => FabricLikeObject[];
      })
    | null;
  // Group 以外 (画像・テキスト単体) は解除対象外。removeAll を持つのは Group/ActiveSelection のみ。
  if (!target || target.type !== "group" || typeof target.removeAll !== "function") {
    return 0;
  }
  // removeAll は子を Group から外して「絶対座標を保ったまま」返す (fabric v6 の仕様)。
  const children = target.removeAll();
  fabricCanvas.remove?.(target);
  for (const child of children) {
    // 子に id が無ければ付与し、キャンバスへ戻す。
    objectId(child);
    fabricCanvas.add?.(child);
  }
  fabricCanvas.discardActiveObject?.();
  fabricCanvas.requestRenderAll?.();
  return children.length;
}

/** 複数レイヤーの表示/非表示をまとめて切り替える (人グループのまとめ表示トグル用)。 */
export function setLayersVisibleByIds(
  canvas: unknown | null,
  ids: readonly string[],
  visible: boolean,
): void {
  const fabricCanvas = canvas as FabricLikeCanvas | null;
  for (const id of ids) {
    const object = getObjectById(canvas, id);
    if (object) setObjectVisible(object, visible);
  }
  fabricCanvas?.requestRenderAll?.();
}

export function createLayerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function objectToThumbnail(object: FabricLikeObject): string | null {
  // サムネイルは「見た目が変わる操作」(拡縮・回転・内容/色変更・表示切替) のときだけ
  // 作り直し、移動 (left/top) では再利用する。
  // なぜ: object:moving のたびに全レイヤーへ toDataURL (PNG エンコード) が走ると、
  // フルサイズ画像レイヤー数×毎フレームの負荷でドラッグが激重になる
  // (2026-07-03 STΛCK報告「素材うごかしたらいきなり動き遅くなる」の真因)。
  const carrier = object as FabricLikeObject & {
    __ggThumbCache?: { key: string; dataUrl: string | null };
    scaleX?: number;
    scaleY?: number;
    angle?: number;
    width?: number;
    height?: number;
  };
  const key = [
    carrier.scaleX ?? 1,
    carrier.scaleY ?? 1,
    carrier.angle ?? 0,
    carrier.width ?? 0,
    carrier.height ?? 0,
    object.visible !== false,
    object.get?.("text") ?? "",
    object.get?.("fill") ?? "",
    object.get?.("fontFamily") ?? "",
  ].join("|");
  if (carrier.__ggThumbCache && carrier.__ggThumbCache.key === key) {
    return carrier.__ggThumbCache.dataUrl;
  }
  let dataUrl: string | null = null;
  try {
    dataUrl = object.toDataURL?.({ format: "png", multiplier: 0.18 }) ?? null;
  } catch {
    dataUrl = null;
  }
  carrier.__ggThumbCache = { key, dataUrl };
  return dataUrl;
}
