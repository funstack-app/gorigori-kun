import { GORI_SKILLS, type GoriSkillId } from "../skills/catalog";
import { useSkillMode } from "../store/skillMode";
import { useToasts } from "../store/toasts";
import { useWorkspace } from "../store/workspace";

/**
 * キャラクター登録の完了 → 登録キャラを使う次工程スキルへの移動 (H1 2026-08-05)。
 *
 * STΛCK 方針 (A案): スキルは独立を保ち順路を強制しない。ただし**終点は分岐点**なので、
 * そこに「次に持っていける先」を明示型で一度だけ出す。
 *
 * 実装が薄い理由 (ここが要点):
 *   受け取り側 4 スキル (表情差分 / スタンプ / 漫画 / マルチアングル) は
 *   **既に usePresets を読んで presetKind(p) === "character" で絞るピッカーを持っている**。
 *   登録が済んだ時点でキャラはそのストアに入っているので、受け取り側は無改修で拾える。
 *   よって送る側がやることは「そのスキルを開く」だけで、
 *   sendImageToCharacterRegister のような state 事前セットは**要らない**。
 *   受け渡し用のストアを新設しないのはこのため (作ると二重の正本になる)。
 *
 * 遷移の順序は既存の activateSkill (SkillBadge.tsx) と同じ経路を通す。
 * skillMode → syncUiMode → skillUiMode.enterSkill。独自経路を作らない。
 *
 * mount-pool (SkillWorkspaceRouter 2026-08-04) により、移動先から戻っても
 * キャラクター登録の画面は生きている。押しても行き止まりにならないのが前提。
 */

/** 登録直後に案内する展開先。並び順がそのまま UI の並び順になる。 */
export const CHARACTER_NEXT_STEP_SKILL_IDS = [
  "gori-expression-set",
  "gori-multi-angle",
  "gori-sticker",
  "gori-comic",
] as const satisfies readonly GoriSkillId[];

export type CharacterNextStepSkillId =
  (typeof CHARACTER_NEXT_STEP_SKILL_IDS)[number];

/**
 * 登録済みキャラを使う次工程スキルを開く。
 *
 * キャラ自体の選択は移動先のピッカーに委ねる (ここで選ばせない)。
 * 登録直後は presets の末尾に入っているので、ユーザーは一覧の中から選ぶ。
 *
 * @param skillId 移動先スキル ID
 * @param characterName トースト文言に使うキャラ名 (任意)
 */
export function openSkillWithCharacter(
  skillId: CharacterNextStepSkillId,
  characterName?: string,
): void {
  const skill = GORI_SKILLS.find((s) => s.id === skillId);
  if (!skill) {
    // catalog から消えたスキルを指していた場合。黙って何もしないと
    // 「押しても反応しない」になるので、理由を出して止める。
    useToasts.getState().push({
      kind: "error",
      text: "この機能はいま使えません。",
      ttlMs: 4000,
    });
    return;
  }

  const workspace = useWorkspace.getState();
  workspace.setActiveTab("generate");

  const skillMode = useSkillMode.getState();
  skillMode.setEnabled(true);
  skillMode.setSelectedSkillId(skill.id);

  const name = characterName?.trim();
  useToasts.getState().push({
    kind: "success",
    text: name
      ? `${skill.name}を開きました。「${name}」を選んで進めてください。`
      : `${skill.name}を開きました。登録したキャラを選んで進めてください。`,
    ttlMs: 4000,
  });
}
