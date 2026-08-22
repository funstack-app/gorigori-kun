import { describe, expect, it } from "vitest";

import {
  VIDEO_SERVICE_PROFILES,
  type VideoServiceId,
} from "../src/lib/film/serviceProfiles";
import { normalizeFilmProject } from "../src/lib/store/filmProject";

describe("動画サービスプロファイル", () => {
  it("6サービスのidが重複せず、正典の尺上限を保持する", () => {
    const ids = VIDEO_SERVICE_PROFILES.map((profile) => profile.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.fromEntries(VIDEO_SERVICE_PROFILES.map((profile) => [profile.id, profile.maxBlockSeconds]))).toEqual({
      "seedance-2.5": 25,
      "seedance-2.0": 15,
      "kling-3.0": 15,
      "veo-3.1": null,
      "minimax-h3": 15,
      flux3: 20,
    } satisfies Record<VideoServiceId, number | null>);
  });

  it("実測フラグと注意書きが一致する", () => {
    const measured = VIDEO_SERVICE_PROFILES.filter((profile) => profile.measured);
    expect(measured.map((profile) => profile.id)).toEqual(["seedance-2.5"]);

    for (const profile of VIDEO_SERVICE_PROFILES) {
      expect(profile.referenceNotation.trim()).not.toBe("");
      if (profile.measured) continue;
      if (profile.id === "veo-3.1") {
        expect(profile.notes).toBe(
          "プロファイル未作成。生成前に公式ガイドからプロファイルを作る（run-ai-film の原則）",
        );
      } else {
        expect(profile.notes).toContain("本番前にテスト生成1ブロックの合格が前提");
      }
    }
  });

  it("正典にある参照種類・上限・開始終了フレーム対応を推測せず保持する", () => {
    const profiles = Object.fromEntries(
      VIDEO_SERVICE_PROFILES.map((profile) => [profile.id, profile.referenceRules]),
    );

    expect(profiles["seedance-2.5"]).toMatchObject({
      startEndFrames: { start: null, end: null, combined: null },
      kinds: ["image", "video", "audio"],
      limits: { images: 30, videos: 10, audio: 10, total: 50 },
    });
    expect(profiles["seedance-2.0"]).toMatchObject({
      kinds: ["image", "video", "audio"],
      limits: { images: 9, videos: 3, audio: 3, total: 12 },
    });
    expect(profiles["kling-3.0"]).toMatchObject({
      startEndFrames: { start: true, end: null, combined: null },
      kinds: ["image", "video"],
      limits: { images: null, videos: null, audio: null, total: null },
    });
    expect(profiles["minimax-h3"]).toMatchObject({
      startEndFrames: { start: true, end: true, combined: true },
      kinds: ["image", "video", "audio"],
      limits: { images: 9, videos: 3, audio: 3, total: 12 },
    });
    expect(profiles.flux3).toMatchObject({
      startEndFrames: { start: true, end: true, combined: true },
      kinds: ["image", "video"],
      limits: { images: null, videos: null, audio: null, total: null },
    });
    expect(profiles["veo-3.1"]).toBeNull();
  });
});

describe("旧フィルムプロジェクトの読み替え", () => {
  it("旧serviceをvideoServiceIdへ移し、他の保存内容を残す", () => {
    const legacyProject = {
      id: "legacy-film",
      title: "残したい作品",
      theme: "残したいテーマ",
      mode: "film",
      service: "kling-3.0",
      phase: 2,
      approvals: {
        logline: null,
        beatsheet: null,
        treatment: null,
        scenelist: null,
        blocks: null,
        look: null,
      },
      script: [],
      assets: [],
      foreshadow: [],
      stylePrefix: "残したいスタイル",
      lookMasterPath: null,
      takes: [],
    } as unknown as Parameters<typeof normalizeFilmProject>[0];

    const migrated = normalizeFilmProject(legacyProject);

    expect(migrated.videoServiceId).toBe("kling-3.0");
    expect(migrated.assetServiceId).toBe("gpt-image-2");
    expect(migrated.title).toBe("残したい作品");
    expect(migrated.stylePrefix).toBe("残したいスタイル");
    expect("service" in migrated).toBe(false);
  });
});
