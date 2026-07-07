import { objectGenre, type FabricLikeObject } from "../../components/edit/editor/layerHelpers";

/**
 * 背景ジャンルの編集操作 (gap-audit G4) の純ロジック。
 * fabric 非依存。「このレイヤーは背景か」「背景に出す操作の一覧」を決定論で決める。
 * UI・fabric 副作用は EditorPropertyPanel 側に置き、判定と操作定義だけをここに集約する。
 */

/** 背景として編集操作を出してよいレイヤーか。genre==="background" のみ。 */
export function isBackgroundLayer(object: FabricLikeObject): boolean {
  return objectGenre(object) === "background";
}

export type BackgroundAction =
  | { kind: "blur"; label: string }
  | { kind: "brightness"; label: string }
  | { kind: "ai-regenerate"; label: string; requires: "inpaint" };

/**
 * 背景レイヤーに対して出す編集操作の一覧。
 * sourcePath（AI差し替え可能な元画像由来）があるときだけ AI再生成を含める
 * ——存在しない導線ボタンを出さない（張りぼて防止・gap-audit「AI再生成は既存インペイント経路流用」）。
 */
export function backgroundActions(object: FabricLikeObject): BackgroundAction[] {
  const actions: BackgroundAction[] = [
    { kind: "blur", label: "ぼかし" },
    { kind: "brightness", label: "明るさ" },
  ];
  if (object.get?.("sourcePath")) {
    actions.push({ kind: "ai-regenerate", label: "AIで背景を再生成", requires: "inpaint" });
  }
  return actions;
}
