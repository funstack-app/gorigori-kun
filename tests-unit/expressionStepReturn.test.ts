import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/redline/pdf", () => ({}));

import { canReturnToExpressionResults } from "../src/components/skills/expressionSet/ExpressionSetWorkspace";

describe("canReturnToExpressionResults", () => {
  it("running の表情差分ジョブがあれば true を返す", () => {
    const jobs = [{ jobMode: "expression", status: "running" }] as const;

    expect(canReturnToExpressionResults(jobs)).toBe(true);
  });

  it("ジョブが空なら false を返す", () => {
    expect(canReturnToExpressionResults([])).toBe(false);
  });

  it("表情差分以外のジョブだけなら false を返す", () => {
    const jobs = [{ jobMode: "character", status: "running" }] as const;

    expect(canReturnToExpressionResults(jobs)).toBe(false);
  });
});
