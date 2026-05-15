import { useEffect, useRef } from "react";

import { GORI_SKILLS, type GoriSkill } from "../lib/skills/catalog";
import { useSkillMode } from "../lib/store/skillMode";
import { activateSkill } from "./SkillBadge";

type Props = {
  open: boolean;
  onClose: () => void;
  /** スキル選択時に外側で追加処理したいときに呼ぶ。なくても良い。 */
  onPick?: (skill: GoriSkill) => void;
  /** ボタン要素のアンカー(位置合わせ用)。null なら画面中央 */
  anchorRect?: DOMRect | null;
};

/**
 * スキル呼び出しポップオーバー。参照ラックの「スキル」ボタンから開く。
 *
 * STΛCK 指示 (2026-05-15):
 *  生成タブの「スキル」ボタンはスキルページに遷移するのではなく、
 *  プリセットと同じくその場でスキルを呼び出せるようにする。
 *
 * 動作:
 *  - クリック = そのスキルをアクティブ化 (useSkillMode に反映)
 *  - 既にアクティブなスキルなら解除 (トグル)
 *  - 「使う」状態は SkillBadge と同じく pink ハイライトで一覧でも分かる
 */
export function SkillPickerPopover({ open, onClose, onPick, anchorRect }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const enabled = useSkillMode((s) => s.enabled);
  const setEnabled = useSkillMode((s) => s.setEnabled);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);

  // クリック外しで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  // ESC で閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // アンカーから位置を計算 (anchorRect.bottom の下に表示)
  const style = anchorRect
    ? {
        position: "fixed" as const,
        top: anchorRect.bottom + 6,
        left: Math.max(8, anchorRect.left),
      }
    : {
        position: "fixed" as const,
        top: "30%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };

  const pick = (skill: GoriSkill) => {
    const isCurrent = enabled && selectedSkillId === skill.id;
    if (isCurrent) {
      // トグル: 既に選択中ならスキルモード解除
      setEnabled(false);
      setSelectedSkillId(null);
    } else {
      activateSkill(skill);
      onPick?.(skill);
    }
    onClose();
  };

  return (
    <div
      ref={ref}
      style={style}
      className="z-50 w-[320px] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-2xl"
    >
      <div className="border-b border-[#242424] px-3 py-2">
        <p className="text-xs font-black text-white">スキルを呼び出す</p>
        <p className="mt-0.5 text-[10px] text-neutral-500">
          選ぶとスキルモードがONになり、その場で実行できます
        </p>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-2">
        {enabled && selectedSkillId && (
          <button
            type="button"
            onClick={() => {
              setEnabled(false);
              setSelectedSkillId(null);
              onClose();
            }}
            className="mb-2 w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-2 py-1.5 text-[11px] font-bold text-neutral-300 hover:border-rose-400 hover:text-rose-200"
          >
            スキルモードを解除
          </button>
        )}
        {GORI_SKILLS.map((skill) => {
          const isActive = enabled && selectedSkillId === skill.id;
          return (
            <button
              key={skill.id}
              type="button"
              onClick={() => pick(skill)}
              className={`mb-1 flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition ${
                isActive
                  ? "border-pink-400 bg-pink-500/15"
                  : "border-[#2a2a2a] bg-[#0b0b0b] hover:border-pink-400"
              }`}
            >
              <span className="mt-0.5 text-lg" aria-hidden>
                {skill.icon}
              </span>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-xs font-black ${
                    isActive ? "text-pink-100" : "text-white"
                  }`}
                >
                  {skill.name}
                  {isActive && (
                    <span className="ml-2 rounded bg-pink-500/30 px-1.5 py-0.5 text-[9px] font-black text-pink-100">
                      使用中
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">
                  {skill.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
