/**
 * スキル画面の冒頭に置く共通の案内ボックス。
 *
 * STΛCK 指摘 (2026-07-26): 「スキルを開いても、この画面で何をすればいいか分からない」。
 * 各 Workspace がバラバラに書くと見た目が揃わないので、1つの部品に寄せる。
 *
 * 書く内容は2つだけ:
 *   what — 何を渡すと何が手に入るか (1文)
 *   first — まず何をすればいいか (1文。「まず〜」で始める)
 * note は「できないこと」を正直に伝える必要があるときだけ使う (任意)。
 *
 * 文言は src/lib/skills/catalog.ts の description と矛盾させない。
 * 実装していないことを書かない (表情差分の自動検品 / シーン再現の動画URL /
 * 漫画の吹き出し焼き込みは、いずれも未実装)。
 */
export function SkillIntro({
  what,
  first,
  note,
}: {
  what: string;
  first: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#181818] px-3.5 py-3">
      <p className="text-[12px] leading-relaxed text-neutral-400">{what}</p>
      <p className="mt-1.5 text-[12px] font-bold leading-relaxed text-pink-300">{first}</p>
      {note ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">{note}</p>
      ) : null}
    </div>
  );
}
