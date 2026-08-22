/**
 * スキル画面への遷移が、真実の起点である useSkillMode を必ず通ることを守る。
 *
 * useSkillUiMode.enterSkill を直接呼ぶと、画面だけ切り替わって停止ボタンの状態が
 * 追いつかない。src 全域を走査し、正規の同期実装 skillMode.ts 以外の直呼びを禁止する。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.join(process.cwd(), "src");
const ALLOWED_SYNC_FILE = "lib/store/skillMode.ts";
const DIRECT_ENTER_SKILL =
  /useSkillUiMode\s*\.\s*getState\s*\(\s*\)\s*\.\s*enterSkill\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  });
}

describe("skillMode UI synchronization", () => {
  it("skillMode.ts 以外から useSkillUiMode.enterSkill を直接呼ばない", () => {
    const violations = sourceFiles(SRC_ROOT).flatMap((filePath) => {
      const relativePath = path.relative(SRC_ROOT, filePath).split(path.sep).join("/");
      if (relativePath === ALLOWED_SYNC_FILE) return [];

      const source = readFileSync(filePath, "utf8");
      const matches = [...source.matchAll(DIRECT_ENTER_SKILL)];
      return matches.map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${relativePath}:${line}`;
      });
    });

    expect(violations).toEqual([]);
  });
});
