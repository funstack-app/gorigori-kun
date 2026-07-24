import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { EVENT_MULTIANGLE, type MultiAngleEvent } from "../multiangle/types";
import { useProductSetRun } from "./store";

/**
 * EC納品セットのイベントリスナ。
 *
 * 生成は既存の Rust コマンド（multiangle_run / multiangle_regenerate_cut）を再利用するため、
 * イベントチャンネルもマルチアングルと同じ EVENT_MULTIANGLE（codex://multiangle）を使う。
 * useProductSetRun に反映する。マルチアングル側のリスナも残るため、各ストアが
 * 自分で開始した runId と一致するイベントだけを受け取る。
 */

let listenerPromise: Promise<UnlistenFn> | null = null;

export function ensureProductSetEventListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    listenerPromise = listen<MultiAngleEvent>(EVENT_MULTIANGLE, (event) => {
      useProductSetRun.getState().applyEvent(event.payload);
    }).catch((err) => {
      listenerPromise = null;
      throw err;
    });
  }
  return listenerPromise;
}

export function disposeProductSetEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
