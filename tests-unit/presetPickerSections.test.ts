import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  changePresetPickerSection,
  getAssetPickerEmptyMessage,
} from "../src/components/PresetPickerPopover";
import { ASSET_LEDGER_TYPE_OPTIONS } from "../src/lib/store/assetLedger";

describe("プリセット呼び出しの2区分", () => {
  it("アセットとプロンプトを切り替えると検索語を空にする", () => {
    expect(changePresetPickerSection("asset")).toEqual({
      section: "asset",
      query: "",
    });
    expect(changePresetPickerSection("prompt")).toEqual({
      section: "prompt",
      query: "",
    });
  });

  it("台帳が空なら登録先を案内する", () => {
    expect(getAssetPickerEmptyMessage(0, 0, "")).toBe(
      "アセットはまだありません。プリセット画面やライブラリから登録できます",
    );
  });

  it("検索結果と種類だけが空の場合を区別する", () => {
    expect(getAssetPickerEmptyMessage(3, 0, "夜景")).toBe(
      "検索条件に一致するアセットがありません",
    );
    expect(getAssetPickerEmptyMessage(3, 0, "")).toBe(
      "この種類のアセットはまだありません",
    );
    expect(getAssetPickerEmptyMessage(3, 1, "")).toBeNull();
  });

  it("登録と呼び出しで同じ5種類の共有一覧を使う", () => {
    expect(ASSET_LEDGER_TYPE_OPTIONS).toEqual([
      { value: "character", label: "キャラ" },
      { value: "scene", label: "シーン" },
      { value: "look", label: "ルック" },
      { value: "prop", label: "小物" },
      { value: "custom", label: "その他" },
    ]);

    const previewSource = readFileSync(
      resolve("src/components/ImagePreviewModal.tsx"),
      "utf8",
    );
    const pickerSource = readFileSync(
      resolve("src/components/PresetPickerPopover.tsx"),
      "utf8",
    );
    expect(previewSource).toContain("ASSET_LEDGER_TYPE_OPTIONS.map");
    expect(pickerSource).toContain("ASSET_LEDGER_TYPE_OPTIONS.map");
    expect(previewSource).not.toContain("const ASSET_TYPE_OPTIONS");
    expect(pickerSource).not.toContain("const ASSET_TYPES");
  });
});
