import { create } from "zustand";
import { resetSkillScopedState } from "./skillReset";
import { resolveUiMode, useSkillUiMode } from "./skillUiMode";

type SkillModeState = {
  enabled: boolean;
  selectedSkillId: string | null;
  candidatesPerCut: 1 | 3;
  setEnabled: (v: boolean) => void;
  setSelectedSkillId: (id: string | null) => void;
  setCandidatesPerCut: (n: 1 | 3) => void;
};

/*
 * STΛCK 指示 (2026-05-20): 「スキル ON で UI 切替」仕様を有効化するため、
 * 旧 skillMode (skill 実行制御用) と新 skillUiMode (UI 切替) を連動させる。
 *
 * - enabled=true + selectedSkillId が変わる → skillUiMode に enterSkill 伝搬
 * - enabled=false に戻る → skillUiMode を exitSkill (default 復帰)
 *
 * 旧ストアの互換を保ちつつ、新ストアが自動的に正しいモードに収束する。
 */
function syncUiMode(enabled: boolean, skillId: string | null) {
  const ui = useSkillUiMode.getState();
  if (enabled && skillId) {
    const prevSkillId = ui.activeSkillId;
    const mode = resolveUiMode(skillId);
    ui.enterSkill(skillId, mode);
    // スキル切替時の前スキル残留データ対策 (2026-06-06 STΛCK報告):
    //   別スキルに入ったら、前スキルの企画チャット履歴・シーン構築を破棄して
    //   新スキルが前回データを抱えたまま始まらないようにする。
    //   同じスキルの再開 (prevSkillId === skillId) では破棄しないので進行中の作業は壊れない。
    //   prevSkillId === null (作品モードからの初回起動) も「別スキルに入った」扱いで
    //   破棄する。前回別スキルの残留が新スキルに流れ込むのを防ぐため。
    //
    //   S2 改訂 (2026-08-04 / bd 2ak): 破棄対象は **共有ストアだけ** になった。
    //   per-skill run ストア (storyboardRun / multiAngleRun) は mount-pool 化による
    //   keep-alive と矛盾するため破棄しない ＝ スキルを行き来しても自分の作業は残る。
    //   したがってここは「新スキルを初期状態から始める」ではなく
    //   「共有ストア経由の混入を断つ」処理である。詳細は skillReset.ts 冒頭。
    if (prevSkillId !== skillId) {
      resetSkillScopedState(skillId);
    }
  } else {
    ui.exitSkill();
  }
}

export const useSkillMode = create<SkillModeState>((set, get) => ({
  enabled: false,
  selectedSkillId: null,
  candidatesPerCut: 1,
  setEnabled: (enabled) => {
    set({ enabled });
    syncUiMode(enabled, get().selectedSkillId);
  },
  setSelectedSkillId: (selectedSkillId) => {
    set({ selectedSkillId });
    syncUiMode(get().enabled, selectedSkillId);
  },
  setCandidatesPerCut: (candidatesPerCut) => set({ candidatesPerCut }),
}));
