import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { EVENT_MULTIANGLE, type MultiAngleEvent } from "../multiangle/types";
import { useProductSetRun } from "./store";

/**
 * EC納品セットのイベントリスナ。
 *
 * 生成は既存の Rust コマンド（multiangle_run / multiangle_regenerate_cut）を再利用するため、
 * イベントチャンネルもマルチアングルと同じ EVENT_MULTIANGLE（codex://multiangle）を使う。
 * 納品セット Workspace が表示されている間だけ購読し、useProductSetRun に反映する。
 *
 * 注意: マルチアングル Workspace とは同時表示されない（SkillWorkspaceRouter は
 * activeUiMode で単一 Workspace を描画する）ため、同一チャンネルの二重購読で
 * 状態が混ざる懸念はない。
 */

let listenerPromise: Promise<UnlistenFn> | null = null;

export function ensureProductSetEventListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    listenerPromise = listen<MultiAngleEvent>(EVENT_MULTIANGLE, (event) => {
      useProductSetRun.getState().applyEvent(event.payload);
    });
  }
  return listenerPromise;
}

export function disposeProductSetEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
