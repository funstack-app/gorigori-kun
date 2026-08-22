import { describe, expect, it } from "vitest";

import {
  GORI_SKILLS,
  VISIBLE_GORI_SKILLS,
} from "../src/lib/skills/catalog";

describe("skill catalog visibility", () => {
  it("hidden スキルを通常一覧の描画対象から除外する", () => {
    // 2026-08-22 STΛCK指示: ストーリーカットは AIフィルムと別スキルとして
    // 両方表示する（hidden 解除）。hidden の仕組み自体の検査は維持する。
    const storyboard = GORI_SKILLS.find((skill) => skill.id === "gori-storyboard");

    expect(storyboard?.hidden).not.toBe(true);
    expect(VISIBLE_GORI_SKILLS.some((skill) => skill.id === "gori-storyboard")).toBe(
      true,
    );
    expect(VISIBLE_GORI_SKILLS.every((skill) => skill.hidden !== true)).toBe(true);
  });

  it("film が旧 storyboard の並び位置を引き継ぐ", () => {
    const filmIndex = GORI_SKILLS.findIndex((skill) => skill.id === "film");
    const multiAngleIndex = GORI_SKILLS.findIndex(
      (skill) => skill.id === "gori-multi-angle",
    );

    expect(filmIndex).toBeGreaterThanOrEqual(0);
    expect(multiAngleIndex).toBeGreaterThanOrEqual(0);
    expect(filmIndex).toBeLessThan(multiAngleIndex);
  });
});
