import { describe, expect, it } from "vitest";

import {
  buildEraseInstruction,
  DEFAULT_EDIT_CANDIDATE_COUNT,
  ERASE_INSTRUCTION_PREFIX,
  normalizeEditCandidateCount,
} from "../src/components/edit/EditChatBar";
import { isVersionSelectDisabled } from "../src/components/edit/EditCandidateStrip";
import {
  addEditCandidates,
  addEditVersion,
  createEditSession,
} from "../src/lib/store/editSession";

describe("純化した編集ツール", () => {
  it("消去の定型文を、利用者の指示より前へ必ず付ける", () => {
    expect(buildEraseInstruction("看板も消す")).toBe(
      `${ERASE_INSTRUCTION_PREFIX}\n看板も消す`,
    );
    expect(buildEraseInstruction("   ")).toBe(ERASE_INSTRUCTION_PREFIX);
  });

  it("候補枚数は既定2枚で、1〜4枚の外へ出ない", () => {
    expect(DEFAULT_EDIT_CANDIDATE_COUNT).toBe(2);
    expect(normalizeEditCandidateCount(0)).toBe(1);
    expect(normalizeEditCandidateCount(1)).toBe(1);
    expect(normalizeEditCandidateCount(4)).toBe(4);
    expect(normalizeEditCandidateCount(5)).toBe(4);
    expect(normalizeEditCandidateCount(Number.NaN)).toBe(2);
  });

  it("復元不能でも履歴と候補を選べ、生成中・版操作中は選べない", () => {
    const idleRecoveryState = {
      generationBusy: false,
      backgroundRemovalBusy: false,
      toolBusy: false,
      versionInFlight: false,
      versionRecoveryRequired: true,
    };

    expect(isVersionSelectDisabled(idleRecoveryState)).toBe(false);
    expect(isVersionSelectDisabled({ ...idleRecoveryState, generationBusy: true })).toBe(true);
    expect(isVersionSelectDisabled({ ...idleRecoveryState, versionInFlight: true })).toBe(true);
  });

  it("生成候補は選ぶまで版にならず、選んだ1枚だけが版になる", () => {
    const initial = createEditSession("/images/original.png");
    const withCandidates = addEditCandidates(initial, [
      "/images/candidate-1.png",
      "/images/candidate-2.png",
    ]);

    expect(withCandidates.candidates).toEqual([
      "/images/candidate-1.png",
      "/images/candidate-2.png",
    ]);
    expect(withCandidates.versions).toEqual([]);
    expect(withCandidates.currentPath).toBe("/images/original.png");

    const selected = addEditVersion(withCandidates, "/images/candidate-2.png", {
      at: 123,
      label: "ことばで直す",
    });
    expect(selected.versions).toEqual([
      { path: "/images/candidate-2.png", at: 123, label: "ことばで直す" },
    ]);
    expect(selected.currentPath).toBe("/images/candidate-2.png");
    expect(selected.versions.some((version) => version.path === "/images/candidate-1.png")).toBe(
      false,
    );
  });
});
