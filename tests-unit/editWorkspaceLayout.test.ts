import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditCandidateStrip } from "../src/components/edit/EditCandidateStrip";
import { EditChatBar } from "../src/components/edit/EditChatBar";
import { EditFloatingPanel } from "../src/components/edit/EditFloatingPanel";
import { EditHistoryRail } from "../src/components/edit/EditHistoryRail";
import { EditToolRail } from "../src/components/edit/EditToolRail";
import {
  clampEditorZoom,
  editorFitZoom,
  isEditorViewportAboveFit,
  zoomViewportAtPoint,
} from "../src/components/edit/EditorCanvas";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

describe("編集タブの Magnific 型レイアウト部品", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("チャット・ツール帯・左上パネル・候補・右履歴の主要要素を描画する", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        createElement(
          "div",
          { className: "relative" },
          createElement(
            EditFloatingPanel,
            { title: "調整", onClose: () => undefined },
            createElement("p", null, "既存パネル"),
          ),
          createElement(EditCandidateStrip, {
            basePath: "/images/original.png",
            candidates: ["/images/edit-1.png"],
            currentPath: "/images/edit-1.png",
            onSelect: () => undefined,
            onDownload: () => undefined,
          }),
          createElement(EditHistoryRail, {
            basePath: "/images/original.png",
            versions: [{ path: "/images/edit-1.png", at: 123 }],
            currentPath: "/images/edit-1.png",
            onSelect: () => undefined,
          }),
          createElement(EditChatBar, {
            value: "",
            activeTool: "region",
            candidateCount: 2,
            regionMode: "replace",
            busy: false,
            disabled: true,
            onChange: () => undefined,
            onSubmit: () => undefined,
            onCandidateCountChange: () => undefined,
            onRegionModeChange: () => undefined,
          }),
          createElement(EditToolRail, {
            activeTool: "ai",
            disabled: false,
            removingBackground: false,
            onSelect: () => undefined,
            onRemoveBackground: () => undefined,
          }),
        ),
      );
    });

    expect(host.querySelector("[data-edit-chat-bar]")).not.toBeNull();
    expect(host.querySelector("[data-edit-tool-rail]")).not.toBeNull();
    expect(host.querySelector("[data-edit-floating-panel]")).not.toBeNull();
    expect(host.querySelector("[data-edit-candidate-strip]")).not.toBeNull();
    expect(host.querySelector("[data-edit-history-rail]")).not.toBeNull();

    const textarea = host.querySelector("textarea");
    expect(textarea?.placeholder).toBe(
      "選択範囲を囲んで、変更したい内容を説明してください",
    );
    expect(host.querySelector('button[aria-label="文字認識"]')).toBeNull();
    expect(host.querySelector('button[aria-label="ことばで分離"]')).toBeNull();
    expect(host.querySelector('button[aria-label="レイヤー分解"]')).toBeNull();
  });

  it("ツール帯は5個だけを表示し、背景透過は押した瞬間に実行する", () => {
    const onRemoveBackground = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        createElement(EditToolRail, {
          activeTool: "ai",
          disabled: false,
          removingBackground: false,
          onSelect: () => undefined,
          onRemoveBackground,
        }),
      );
    });

    const toolButtons = host.querySelectorAll<HTMLButtonElement>(
      "[data-edit-tool-rail] > button",
    );
    expect(Array.from(toolButtons, (button) => button.getAttribute("aria-label"))).toEqual([
      "ことばで直す",
      "囲んで直す",
      "切り抜き",
      "調整",
      "背景透過",
    ]);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="背景透過"]')?.click());
    expect(onRemoveBackground).toHaveBeenCalledOnce();
  });

  it("ズームを25%〜400%に制限し、カーソル中心とフィット超パンを計算する", () => {
    expect(clampEditorZoom(0.1)).toBe(0.25);
    expect(clampEditorZoom(5)).toBe(4);

    const zoomed = zoomViewportAtPoint([1, 0, 0, 1, 0, 0], { x: 100, y: 80 }, 2);
    expect(zoomed).toEqual([2, 0, 0, 2, -100, -80]);
    expect((100 - zoomed[4]) / zoomed[0]).toBe(100);
    expect((80 - zoomed[5]) / zoomed[3]).toBe(80);

    expect(editorFitZoom(1080, 720, 2000, 1000)).toBe(0.5);
    expect(isEditorViewportAboveFit(1080, 720, 2000, 1000, 0.75)).toBe(true);
    expect(isEditorViewportAboveFit(1080, 720, 2000, 1000, 0.5)).toBe(false);
  });
});
