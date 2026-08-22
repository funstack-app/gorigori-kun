import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGalleryItemMenu,
  buildImagePreviewMetadata,
  getImagePreviewPrimaryActions,
} from "../src/components/galleryItemMenu";
import type { GenerationInfo } from "../src/lib/ipc";
import type { GalleryItem } from "../src/lib/store/images";

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

  it("動画の右クリックには画像専用メニューを出さない", () => {
    const video: GalleryItem = {
      path: "/library/sample.mp4",
      name: "sample.mp4",
      bucket: "2026-08-22",
      mtimeMs: 1,
      size: 100,
      kind: "created",
      mediaType: "video",
    };
    const labels = buildGalleryItemMenu(video, {
      favorites: new Set(),
      onToggleFavorite: () => undefined,
      onRegisterPreset: () => undefined,
    })
      .map((item) => ("label" in item ? item.label : null))
      .filter((label): label is string => Boolean(label));

    expect(labels).not.toEqual(
      expect.arrayContaining([
        "編集スタジオで開く",
        "マスクで編集",
        "背景を透過 (Vision)",
        "SNS用に書き出し…",
        "プリセットに登録…",
      ]),
    );
    expect(labels).toContain("拡大表示");
    expect(labels).toContain("名前を付けて保存…");
  });

  it("再利用ボタンは正直なラベルで、詳細操作は11px・3列にする", () => {
    const source = readFileSync(
      resolve("src/components/ImagePreviewModal.tsx"),
      "utf8",
    );

    expect(source).toContain('label="生成時の指示文を読み込む"');
    expect(source).not.toContain('label="もう一度作る"');
    expect(source).toContain("grid grid-cols-3 gap-1.5");
    expect(source).toContain("text-[11px] font-bold leading-tight");
    expect(source).not.toContain("grid grid-cols-5 gap-1");
    expect(source).not.toContain("text-[9px] font-bold leading-tight");
  });
});
