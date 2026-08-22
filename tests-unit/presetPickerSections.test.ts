import { describe, expect, it } from "vitest";

import {
  changePresetPickerSection,
  getAssetPickerEmptyMessage,
} from "../src/components/PresetPickerPopover";

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
});
