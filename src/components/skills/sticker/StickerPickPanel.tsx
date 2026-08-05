/**
 * 工程④ 採否（設計書 v3 §1.6・STΛCK決定6）。
 *
 * ## なぜ一覧表示が必須なのか（1枚ずつの順送りにしない理由）
 *
 * 公式リジェクト 1.10「似た絵柄の多用」は**セット全体を並べて見ないと原理的に検出できない**。
 * 1枚ずつ確認する UI では、機械検査でも人間でも見つからない。
 * したがってここは「並べて見せる」ことが機能そのものであり、見た目の都合ではない。
 *
 * 同じくリジェクト 1.4「バランスを著しく欠く」（指の破綻・背景の歪み）の最終判定も主観なので、
 * ここに人の目を置く。**人の手を置く理由は審査対策（AI生成の秘匿）ではない** — AI生成のみでも
 * 審査は通る（一次情報で確定済み。設計書 §0.2 / §1.6）。
 *
 * ## スキップ導線を作らない（K6）
 *
 * 「全部OK」ボタンは置くが、**採否画面自体を飛ばす導線は無い**。
 * 既定は全部「使う」なので、良ければ1クリックで進める。手間は最小、ゲートは残す。
 */
import { useMemo } from "react";

import { SafeImage } from "../../SafeImage";
import { isValidStickerCount, NORMAL_STICKER_SPEC } from "../../../lib/sticker/spec";

/** 採否の対象になる生成済み1枚。 */
export type StickerPickItem = {
  /** 通し番号（1始まり）。波の概念はUIに出さないので、これは常に通し番号（設計書 §1.2）。 */
  index: number;
  /** 表示・編集の対象になる画像の実パス。 */
  imagePath: string;
  /** 何の表情・セリフとして作ったか（カタログ由来のラベル）。 */
  label: string;
};

type Props = {
  items: StickerPickItem[];
  /** 「使う」に入っている index の集合。 */
  keptIndexes: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onKeepAll: () => void;
  /** 工程⑤へ。個別マスク編集を開く。 */
  onReedit: (item: StickerPickItem) => void;
  /** 「使わない」にした枚数を作り直す。 */
  onRegenerate: (indexes: number[]) => void;
  /** 他の生成が走っている間は操作させない。 */
  busy?: boolean;
  /**
   * 緑背景が1画素も抜けなかった画像のパス（R5）。
   *
   * 抜きに失敗しても元の絵で先へ進める（救済）が、**黙って進めない**。
   * 設計原則 第5条は「救済 + 可視化」の両輪で、旧実装は画面に何も出さず
   * 救済しか満たしていなかった。ここでは採否の段階で気づけるよう
   * バッジを1つ足すだけにする（**新しいボタンは足さない** —
   * 一等地のボタンを増やさない配置文法）。規格としての判定は層Aが行う。
   */
  notClearedPaths?: ReadonlySet<string>;
};

export function StickerPickPanel({
  items,
  keptIndexes,
  onToggle,
  onKeepAll,
  onReedit,
  onRegenerate,
  busy = false,
  notClearedPaths,
}: Props) {
  const keptCount = useMemo(
    () => items.filter((item) => keptIndexes.has(item.index)).length,
    [items, keptIndexes],
  );
  const droppedIndexes = useMemo(
    () => items.filter((item) => !keptIndexes.has(item.index)).map((item) => item.index),
    [items, keptIndexes],
  );
  // 申請モードは枚数が5択に一致していないと書き出しを止める（設計書 §1.1）。
  // ここでは「止める」のではなく、あと何枚で選択肢に届くかを先に見せる。
  const countIsValid = isValidStickerCount(keptCount);
  const nextValidCount = NORMAL_STICKER_SPEC.counts.find((count) => count > keptCount);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[#242424] px-4 py-3">
        {/*
          「全部を並べて見て、気になる1枚だけ直せます」は PageHelp の what へ移した
          （B2 / ui-placement-grammar §4「常時表示の説明文は禁止」）。
        */}
        <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
          使うものを選ぶ
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-neutral-400">
            使う <span className="font-bold text-neutral-100">{keptCount}</span> / {items.length} 枚
          </span>
          <button
            type="button"
            onClick={onKeepAll}
            disabled={busy || keptCount === items.length}
            className="rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
          >
            全部使う
          </button>
          <button
            type="button"
            onClick={() => onRegenerate(droppedIndexes)}
            disabled={busy || droppedIndexes.length === 0}
            className="rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
          >
            使わない {droppedIndexes.length} 枚を作り直す
          </button>
        </div>
      </header>

      {/* 枚数の案内。「審査に通る」とは書かない（設計書 §0.4）。書けるのは画像規格の話まで。 */}
      {!countIsValid && (
        <p className="border-b border-[#242424] bg-[#161616] px-4 py-2 text-[11px] text-amber-300/80">
          申請用に書き出すときは {NORMAL_STICKER_SPEC.counts.join(" / ")} 枚のいずれかにする必要があります。
          {nextValidCount !== undefined
            ? `いまは ${keptCount} 枚なので、あと ${nextValidCount - keptCount} 枚です。`
            : `いまは ${keptCount} 枚です。`}
          このまま自分で使うぶんには何枚でも書き出せます。
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {items.map((item) => {
            const kept = keptIndexes.has(item.index);
            const notCleared = notClearedPaths?.has(item.imagePath) ?? false;
            return (
              <li
                key={item.index}
                className={`flex flex-col overflow-hidden rounded-lg border transition ${
                  kept ? "border-[#2f2f2f] bg-[#171717]" : "border-[#242424] bg-[#0e0e0e]"
                }`}
              >
                {/*
                  透過スタンプなので、市松模様の上に置かないと「白い部分」と
                  「抜けている部分」を人が見分けられない。採否の判断材料そのもの。
                */}
                <div
                  className={`relative aspect-[37/32] w-full ${kept ? "" : "opacity-35 grayscale"}`}
                  style={{
                    backgroundColor: "#1b1b1b",
                    backgroundImage:
                      "linear-gradient(45deg,#232323 25%,transparent 25%),linear-gradient(-45deg,#232323 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#232323 75%),linear-gradient(-45deg,transparent 75%,#232323 75%)",
                    backgroundSize: "12px 12px",
                    backgroundPosition: "0 0,0 6px,6px -6px,-6px 0",
                  }}
                >
                  <SafeImage
                    path={item.imagePath}
                    alt={item.label}
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-neutral-300">
                    {String(item.index).padStart(2, "0")}
                  </span>
                  {/*
                    抜けなかったことを黙らない（R5）。既存の番号バッジと同じ形で、
                    反対側の角に1つ足すだけにする。色は他の注意表示と同じ amber 系。
                  */}
                  {notCleared && (
                    <span
                      className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-amber-300/90"
                      title="背景の緑が抜けませんでした。この絵は元のまま残しています。「直す」で塗り直すか、別の1枚を使ってください。"
                    >
                      背景が抜けていません
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 p-2">
                  <span className="truncate text-[11px] text-neutral-300" title={item.label}>
                    {item.label}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onToggle(item.index)}
                      disabled={busy}
                      className={`flex-1 rounded px-2 py-1 text-[11px] font-bold transition disabled:opacity-40 ${
                        kept
                          ? "bg-[#2a2a2a] text-neutral-100 hover:bg-[#333]"
                          : "border border-[#2f2f2f] text-neutral-500 hover:bg-[#1a1a1a]"
                      }`}
                    >
                      {kept ? "使う" : "使わない"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReedit(item)}
                      disabled={busy}
                      className="rounded border border-[#2f2f2f] px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e] disabled:opacity-40"
                      title="気になるところだけ塗って直す"
                    >
                      直す
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
