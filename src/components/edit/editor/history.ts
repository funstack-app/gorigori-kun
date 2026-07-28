/**
 * 編集タブの Undo / Redo 履歴 (スナップショット型)。
 *
 * なぜスナップショット型か:
 * fabric には差分 (command) パターンも組めるが、この編集タブは操作が多様
 * (移動/拡縮/回転・レイヤー追加削除・不透明度/明度/コントラスト・マジックレイヤー
 * 適用・グラブ適用) で、しかも AI 操作 (magic / grab) はキャンバス全体を作り
 * 直すため 1 操作 = 1 差分に落とすのが難しい。全操作を「canvas 全体の JSON を
 * 撮る」1 手段に統一すると、どの操作でも同じ 1 手で戻せる (Photoshop の
 * ヒストリーと同じ体験)。差分型より実装が単純で、AI 操作も 1 手で戻せる利点が
 * 大きい。メモリは後述の見積りで 50 件でも許容範囲。
 *
 * 保存内容: fabric v6 の `canvas.toJSON(propertiesToInclude)`。
 * カスタム属性 (id / name / layerKind / locked / brightness / contrast) を
 * propertiesToInclude に列挙して漏れなく保存する。画像の filters (明度/
 * コントラストの見た目) は fabric が既定でシリアライズするため、raw の
 * brightness/contrast はプロパティパネルの数値表示復元用に別途保存する。
 */

import { applyBrandSelectionToCanvas } from "./selectionStyle";

/**
 * 履歴の 1 スナップショット。fabric の toJSON が返す任意構造をそのまま持つ。
 * fabric 型は編集タブ全体で any 扱いに統一しているのでここも any。
 */
type CanvasSnapshot = unknown;

/** 履歴に積むときに toJSON へ渡すカスタム属性一覧。 */
export const HISTORY_PROPERTIES = [
  "id",
  "name",
  "layerKind",
  // 大ジャンル (人/テキスト/背景/小物)。undo/redo でツリー見出しが崩れないよう保存する。
  "genre",
  // テキスト打ち替え変換 (textSpec) と AI差し替え (sourcePath/sourceBbox) のメタデータ。
  // 2026-07-07 修理: magicLayerToFabric は「JSON化しても残るプレーン値」として付与して
  // いたが、ここに列挙されておらず undo/redo で静かに消えていた (打ち替え・AI差し替えが
  // 1回の undo で不能になる潜在バグ)。
  "textSpec",
  "sourcePath",
  "sourceBbox",
  // 「セリフ・文字を直す」で載せた文字レイヤーの向きと原文。
  // 縦書きは表示用 text を1文字ずつ改行した文字列に組み替えているため、原文
  // (textSource) を保存しないと undo/redo 後に縦→横へ戻せなくなる。
  "textOrientation",
  "textSource",
  "locked",
  "selectable",
  "evented",
  "lockMovementX",
  "lockMovementY",
  "brightness",
  "contrast",
] as const;

/** 履歴スタックの上限。超過分は古い方 (index 0 側) から破棄する。 */
export const HISTORY_LIMIT = 50;

type FabricLikeCanvas = {
  toJSON?: (propertiesToInclude?: readonly string[]) => CanvasSnapshot;
  loadFromJSON?: (
    json: CanvasSnapshot,
    reviver?: unknown,
  ) => Promise<unknown> | unknown;
  discardActiveObject?: () => void;
  requestRenderAll?: () => void;
  renderAll?: () => void;
  viewportTransform?: number[];
  setViewportTransform?: (transform: number[]) => void;
};

/**
 * 1 画像 (編集セッション) 分の履歴。past / present / future の 3 分割で持つ。
 * present = 現在のキャンバス状態のスナップショット。
 *
 * - push(snapshot): 新しい操作が確定したとき。future を捨て present を past へ送る。
 * - undo(): present を future へ送り past の末尾を present にする。
 * - redo(): future の先頭を present に戻す。
 *
 * 別画像を開いたら reset(initial) で丸ごと差し替える (画像単位でリセット)。
 */
export class EditorHistory {
  private past: CanvasSnapshot[] = [];
  private present: CanvasSnapshot | null = null;
  private future: CanvasSnapshot[] = [];

  /** 現在の状態を初期スナップショットとして履歴を初期化する (画像を開いた直後)。 */
  reset(initial: CanvasSnapshot | null): void {
    this.past = [];
    this.present = initial;
    this.future = [];
  }

  /**
   * 新しい状態を積む。直前の present を past に送り、future (やり直し候補) を捨てる。
   * present が null (初期化前) のときは past に何も送らず present だけ更新する。
   */
  push(snapshot: CanvasSnapshot): void {
    if (this.present !== null) {
      this.past.push(this.present);
      if (this.past.length > HISTORY_LIMIT) {
        // 上限超過は古い方 (先頭) から捨てる。
        this.past.splice(0, this.past.length - HISTORY_LIMIT);
      }
    }
    this.present = snapshot;
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** undo 先のスナップショットを返して内部状態を進める。戻せないときは null。 */
  undo(): CanvasSnapshot | null {
    if (this.past.length === 0 || this.present === null) return null;
    const previous = this.past.pop() as CanvasSnapshot;
    this.future.unshift(this.present);
    this.present = previous;
    return previous;
  }

  /** redo 先のスナップショットを返して内部状態を進める。やり直せないときは null。 */
  redo(): CanvasSnapshot | null {
    if (this.future.length === 0 || this.present === null) return null;
    const next = this.future.shift() as CanvasSnapshot;
    this.past.push(this.present);
    this.present = next;
    return next;
  }
}

/** canvas から現在状態のスナップショットを撮る (カスタム属性込み)。 */
export function snapshotCanvas(canvas: unknown | null): CanvasSnapshot | null {
  const fabricCanvas = canvas as FabricLikeCanvas | null;
  if (!fabricCanvas?.toJSON) return null;
  return fabricCanvas.toJSON(HISTORY_PROPERTIES);
}

/**
 * スナップショットを canvas に復元する。loadFromJSON は canvas を丸ごと作り直す
 * ため、復元中に発火するイベント (object:added 等) で履歴を汚さないよう、呼び出し
 * 側が suppress フラグを立ててから使う。選択状態は復元後にクリアする。
 */
export async function restoreCanvas(
  canvas: unknown | null,
  snapshot: CanvasSnapshot,
): Promise<void> {
  const fabricCanvas = canvas as FabricLikeCanvas | null;
  if (!fabricCanvas?.loadFromJSON) return;
  // toJSON はズーム/パン (viewportTransform) をシリアライズしない。undo/redo で
  // 表示位置が勝手にリセットされると操作感が悪いので、現在のビューを退避して復元後に戻す。
  const viewport = Array.isArray(fabricCanvas.viewportTransform)
    ? [...fabricCanvas.viewportTransform]
    : null;
  const loaded = fabricCanvas.loadFromJSON(snapshot);
  if (loaded && typeof (loaded as Promise<unknown>).then === "function") {
    await loaded;
  }
  if (viewport && fabricCanvas.setViewportTransform) {
    fabricCanvas.setViewportTransform(viewport);
  }
  // 復元で作り直されたオブジェクトの選択枠をブランド色に揃える。
  // ownDefaults は「これから作られる分」に効くが、スナップショット JSON に
  // 旧い borderColor が焼かれている場合はそちらが勝つため、明示的に上書きする。
  applyBrandSelectionToCanvas(fabricCanvas);
  fabricCanvas.discardActiveObject?.();
  (fabricCanvas.requestRenderAll ?? fabricCanvas.renderAll)?.();
}
