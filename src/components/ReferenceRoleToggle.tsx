import {
  useReferenceRoles,
  type ReferenceRoleKind,
} from "../lib/store/referenceRoles";

/**
 * 添付画像の役割 (キャラ参照 / スタイル参照) を切り替えるトグル。
 *
 * FB#3 (2026-06-06 STΛCK 指示): 登場キャラが複数いるケースで、各添付画像を
 * 「これはキャラ」「これはスタイル」と明示指定できるようにする。AI の文脈推測に
 * 任せず、ユーザーが上から役割を選べる。役割は referenceRoles ストアが握る。
 */
export function ReferenceRoleToggle({
  path,
  size = "sm",
}: {
  path: string;
  /** sm = 添付サムネ脇の極小トグル、md = ライブラリ等のやや大きめ。 */
  size?: "sm" | "md";
}) {
  const role = useReferenceRoles((s) => s.roles[path]) ?? "character";
  const setRole = useReferenceRoles((s) => s.setRole);

  const base =
    size === "md"
      ? "px-2 py-0.5 text-[11px]"
      : "px-1.5 py-0.5 text-[9px]";

  const btn = (kind: ReferenceRoleKind, label: string) => {
    const active = role === kind;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setRole(path, kind);
        }}
        aria-pressed={active}
        className={[
          base,
          "rounded font-bold transition",
          active
            ? kind === "character"
              ? "bg-pink-500 text-white"
              : "bg-indigo-500 text-white"
            : "bg-[#1a1a1a] text-neutral-400 hover:text-white",
        ].join(" ")}
        title={
          kind === "character"
            ? "キャラ参照: 人物/被写体の同一性を保つ対象"
            : "スタイル参照: 絵のタッチ/質感のみ参照 (同一性には使わない)"
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-[#343434] bg-[#0b0b0b] p-0.5">
      {btn("character", "キャラ")}
      {btn("style", "スタイル")}
    </div>
  );
}
