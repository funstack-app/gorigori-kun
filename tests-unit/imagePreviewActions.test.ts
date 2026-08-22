import { describe, expect, it } from "vitest";

import {
  buildImagePreviewMetadata,
  getImagePreviewPrimaryActions,
} from "../src/components/galleryItemMenu";
import type { GenerationInfo } from "../src/lib/ipc";

function generation(
  overrides: Partial<GenerationInfo> = {},
): GenerationInfo {
  return {
    prompt: "白い背景に置かれた桜餅の商品写真",
    model: "gpt-image-1",
    modelDisplayName: "Seedream V5 Lite",
    effort: null,
    provider: "higgsfield",
    count: 1,
    kind: "batch",
    refImagePaths: [],
    generatedAt: new Date(2026, 7, 22, 12, 30).getTime(),
    ...overrides,
  };
}

describe("画像詳細パネルのメタ情報", () => {
  it("履歴がある画像はプロンプト・モデル・生成日時をそのまま表示に使う", () => {
    const meta = buildImagePreviewMetadata(generation());

    expect(meta).toEqual({
      source: "history",
      prompt: "白い背景に置かれた桜餅の商品写真",
      modelLabel: "Higgsfield · Seedream V5 Lite",
      generatedAt: new Date(2026, 7, 22, 12, 30).getTime(),
      notice: null,
    });
    expect(getImagePreviewPrimaryActions(meta)).toMatchObject({
      canUseAsReference: true,
      canRecreate: true,
      recreateDisabledReason: null,
      canSave: true,
      canMakeVideo: true,
      canEditImage: true,
      canRegisterAsset: true,
    });
  });

  it("履歴がない取り込み画像は生成情報を推測せず、再生成を無効にする", () => {
    const meta = buildImagePreviewMetadata(null);

    expect(meta).toEqual({
      source: "missing",
      prompt: null,
      modelLabel: null,
      generatedAt: null,
      notice: "この画像は取り込み画像のため、生成情報がありません。",
    });
    expect(getImagePreviewPrimaryActions(meta)).toMatchObject({
      canUseAsReference: true,
      canRecreate: false,
      recreateDisabledReason:
        "生成履歴がないため、同じ設定を読み込めません。",
      canSave: true,
      canMakeVideo: true,
      canEditImage: true,
      canRegisterAsset: true,
    });
  });

  it("プロジェクトにプロンプトだけあっても履歴扱いにせず、再生成を有効にしない", () => {
    const meta = buildImagePreviewMetadata(
      null,
      "  プロジェクトに保存されたプロンプト  ",
    );

    expect(meta).toMatchObject({
      source: "project",
      prompt: "プロジェクトに保存されたプロンプト",
      modelLabel: null,
      generatedAt: null,
    });
    expect(getImagePreviewPrimaryActions(meta).canRecreate).toBe(false);
  });

  it("動画には画像専用の生成・編集・台帳アクションを出さない", () => {
    const meta = buildImagePreviewMetadata(generation());
    const actions = getImagePreviewPrimaryActions(meta, "video");

    expect(actions.canUseAsReference).toBe(false);
    expect(actions.canSave).toBe(true);
    expect(actions.canMakeVideo).toBe(false);
    expect(actions.canEditImage).toBe(false);
    expect(actions.canRegisterAsset).toBe(false);
  });
});
