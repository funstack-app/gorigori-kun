import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditCandidateStrip } from "../src/components/edit/EditCandidateStrip";
import { EditChatBar } from "../src/components/edit/EditChatBar";
import { EditFloatingPanel } from "../src/components/edit/EditFloatingPanel";
import { EditHistoryRail } from "../src/components/edit/EditHistoryRail";
import { EditToolRail } from "../src/components/edit/EditToolRail";

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
            hasRegion: false,
            busy: false,
            disabled: true,
            onChange: () => undefined,
            onSubmit: () => undefined,
            onSelectWhole: () => undefined,
            onSelectRegion: () => undefined,
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
    expect(textarea?.placeholder).toBe("どこを変更したいですか？");
    const regionChip = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "囲った場所",
    );
    expect(regionChip?.disabled).toBe(true);
  });
});
