import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 2026-08-05 STΛCK 実機指示: 配布版の一覧に「インポート済み」カスタムスキルを出さない。
 *
 * `~/.codex/skills/` は開発用スキル置き場と共用のため、そこに置いた作業用スキル
 * (hatch-pet / migrate-to-codex / ui-clone 等) がそのまま配布版の画面に並び、
 * さらにカード内に個人のホームディレクトリの絶対パスまで表示されていた。
 *
 * 「表示しない」を散文の申し送りでなく機械検査で固定する。
 */
describe("skills workspace hides imported custom skills", () => {
  const src = readFileSync(
    resolve(__dirname, "../src/components/SkillsWorkspace.tsx"),
    "utf8",
  );

  it("customSkills never derives from the installed list", () => {
    // installed を filter して customSkills を作る形に戻すと、開発用スキルが再び並ぶ。
    const derives = /const\s+customSkills\s*=\s*useMemo[^;]*installed\s*\.\s*filter/s.test(src);
    expect(derives).toBe(false);
  });

  it("customSkills resolves to an empty list", () => {
    const empty = /const\s+customSkills\s*=\s*useMemo<[^>]*>\(\s*\(\)\s*=>\s*\[\]\s*,/.test(src);
    expect(empty).toBe(true);
  });

  it("keeps reading installed skills for builtin path display", () => {
    // 読み取りごと消すと、組み込みカードの実パス表示が壊れる。
    expect(src).toMatch(/installedPathById/);
    expect(src).toMatch(/skillsIpc\.listInstalled|listInstalled\(\)/);
  });
});
