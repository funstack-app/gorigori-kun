import { describe, expect, it } from "vitest";

import {
  addEditVersion,
  confirmEditCandidate,
  createEditSession,
  switchEditVersion,
} from "../src/lib/store/editSession";

describe("編集タブの一時版履歴", () => {
  it("AI編集版を追加し、最新の版を現在表示へ切り替える", () => {
    const initial = createEditSession("/images/original.png");
    const next = addEditVersion(initial, "/images/edit-1.png", {
      at: 123,
      label: "ことばで直す",
    });

    expect(next).toEqual({
      basePath: "/images/original.png",
      versions: [{ path: "/images/edit-1.png", at: 123, label: "ことばで直す" }],
      currentPath: "/images/edit-1.png",
      candidates: [],
    });
    expect(initial.versions).toEqual([]);
  });

  it("元画像と存在する編集版を相互に切り替え、不明なpathは無視する", () => {
    const withVersion = addEditVersion(
      createEditSession("/images/original.png"),
      "/images/edit-1.png",
      { at: 123 },
    );
    const original = switchEditVersion(withVersion, "/images/original.png");

    expect(original.currentPath).toBe("/images/original.png");
    expect(switchEditVersion(original, "/images/edit-1.png").currentPath).toBe(
      "/images/edit-1.png",
    );
    expect(switchEditVersion(original, "/images/not-found.png")).toBe(original);
  });

  it("同じ結果pathと元画像pathを版へ重複追加しない", () => {
    const once = addEditVersion(
      createEditSession("/images/original.png"),
      "/images/edit-1.png",
      { at: 123 },
    );

    expect(addEditVersion(once, "/images/edit-1.png", { at: 456 })).toBe(once);
    expect(addEditVersion(once, "/images/original.png", { at: 456 })).toBe(once);
    expect(once.versions).toHaveLength(1);
  });

  it("確定した候補を一度だけ追加し、版にないpathは候補にしない", () => {
    const withVersion = addEditVersion(
      createEditSession("/images/original.png"),
      "/images/edit-1.png",
      { at: 123 },
    );
    const confirmed = confirmEditCandidate(withVersion, "/images/edit-1.png");

    expect(confirmed.candidates).toEqual(["/images/edit-1.png"]);
    expect(confirmEditCandidate(confirmed, "/images/edit-1.png")).toBe(confirmed);
    expect(confirmEditCandidate(confirmed, "/images/not-found.png")).toBe(confirmed);
  });
});
