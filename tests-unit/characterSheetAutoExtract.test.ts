import { beforeEach, describe, expect, it } from "vitest";

type StoreModule = typeof import("../src/lib/store/characterSheetRun");

describe("キャラクターシートの属性自動抽出合図", () => {
  let mod: StoreModule;

  beforeEach(async () => {
    mod = await import("../src/lib/store/characterSheetRun");
  });

  it("0→1枚の追加で自動抽出待ちをONにする", () => {
    mod.useCharacterSheetRun.getState().addCharacterImages(["/img/first.png"]);

    expect(mod.useCharacterSheetRun.getState().autoExtractPending).toBe(true);
  });

  it("attributes入力済みなら最初の画像でも自動抽出待ちをONにしない", () => {
    const run = mod.useCharacterSheetRun.getState();
    run.setAttributes("黒髪 / 青い瞳");
    run.addCharacterImages(["/img/first.png"]);

    expect(mod.useCharacterSheetRun.getState().autoExtractPending).toBe(false);
  });

  it("2枚目以降の追加では自動抽出待ちをONにしない", () => {
    const run = mod.useCharacterSheetRun.getState();
    run.addCharacterImages(["/img/first.png"]);
    mod.useCharacterSheetRun.getState().setAutoExtractPending(false);
    mod.useCharacterSheetRun.getState().addCharacterImages(["/img/second.png"]);

    expect(mod.useCharacterSheetRun.getState().autoExtractPending).toBe(false);
  });

  it("他画面からの「キャラ登録へ送る」でも自動抽出待ちをONにする", async () => {
    const run = mod.useCharacterSheetRun.getState();
    run.setAttributes("前キャラの属性");
    run.addCharacterImages(["/img/old.png"]);
    const { sendImageToCharacterRegister } = await import(
      "../src/lib/character/sendImageToCharacterRegister"
    );

    sendImageToCharacterRegister({ imagePath: "/img/new.png" });

    const state = mod.useCharacterSheetRun.getState();
    expect(state.characterImagePaths).toEqual(["/img/new.png"]);
    expect(state.attributes).toBe("");
    expect(state.autoExtractPending).toBe(true);
  });

  it("自動抽出待ちはpersistスナップショットに含めない", async () => {
    const { snapshotCharacterSheetRun } = await import(
      "../src/lib/store/characterSheetRunPersist"
    );
    mod.useCharacterSheetRun.getState().addCharacterImages(["/img/first.png"]);
    const state = mod.useCharacterSheetRun.getState();

    expect(state.autoExtractPending).toBe(true);
    expect(snapshotCharacterSheetRun(state)).not.toHaveProperty("autoExtractPending");
  });
});
