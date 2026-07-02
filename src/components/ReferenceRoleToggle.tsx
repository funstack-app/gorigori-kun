import {
  useReferenceRoles,
  type ReferenceRoleKind,
  REFERENCE_ROLE_KINDS,
  REFERENCE_ROLE_META,
} from "../lib/store/referenceRoles";

/**
 * 添付画像の役割 (キャラ / スタイル / ロケーション / アイテム) を切り替えるトグル。
 *
 * FB#3 (2026-06-06 STΛCK 指示): 登場キャラが複数いるケースで、各添付画像を
 * 明示指定できるようにする。AI の文脈推測に任せず、ユーザーが上から役割を選べる。
 * N-2 (2026-06-16 Ta4low 要望): ロケーション / アイテムの 2 種を追加。全 4 種を
 * REFERENCE_ROLE_KINDS / REFERENCE_ROLE_META から生成する (種別追加時の記述漏れ防止)。
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

  const btn = (kind: ReferenceRoleKind) => {
    const meta = REFERENCE_ROLE_META[kind];
    const active = role === kind;
    return (
      <button
        key={kind}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setRole(path, kind);
        }}
        aria-pressed={active}
        className={[
          base,
          "rounded font-bold transition",
          active ? meta.activeClass : "bg-[#1a1a1a] text-neutral-400 hover:text-white",
        ].join(" ")}
        title={meta.description}
      >
        {meta.label}
      </button>
    );
  };

  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-md border border-[#343434] bg-[#0b0b0b] p-0.5">
      {REFERENCE_ROLE_KINDS.map((kind) => btn(kind))}
    </div>
  );
}
