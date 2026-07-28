import {
  STORYBOARD_CARD_SIZE_MAX,
  STORYBOARD_CARD_SIZE_MIN,
  useWorkspace,
} from "../../../lib/store/workspace";

/**
 * ストーリーカット3画面 (絵コンテレビュー / 本生成進捗 / 最終確認) で共有する
 * カードサイズの部品。状態は workspace ストアの storyboardCardSize (1-3, localStorage 永続)。
 *
 * 3画面で共有する理由: 絵コンテ→本生成→最終確認は同一ワークフローで同じカットカードを
 * 見るため。画面ごとに独立させると1フローで3回調整させることになる。
 */

/** アスペクト比 + サイズレベル (1=大きく少列 / 2=既定 / 3=小さく多列) に応じた列数クラス。
 *
 *  経緯: P8 (2026-05-20) は「16:9 は2列に絞ってカット全体を確実に表示」だったが、
 *  STΛCK指示 (2026-07-28)「4カラムを通常にする」で上書きし、既定 (level 2) を
 *  全アスペクト xl 4カラムに再定義した。旧 P8 の意図は level 1 (16:9 で xl 2列) に残す。 */
export function gridColsForAspect(a: string, level: number = 2): string {
  const table: Record<string, [string, string, string]> = {
    "9:16": [
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
      "grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
    ],
    "1:1": [
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
      "grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
    ],
    "4:5": [
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
      "grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
    ],
    "16:9": [
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-2",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
      "grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
    ],
  };
  const cols = table[a] ?? table["16:9"];
  const idx = Math.min(2, Math.max(0, level - 1));
  return cols[idx];
}

/** カードサイズのスライダー (大 ⇔ 小)。3画面で同じ状態を読み書きする。 */
export function CardSizeSlider() {
  const storyboardCardSize = useWorkspace((s) => s.storyboardCardSize);
  const setStoryboardCardSize = useWorkspace((s) => s.setStoryboardCardSize);

  return (
    <label className="inline-flex items-center gap-1" title="カードを大きく ⇔ 小さく">
      <span className="text-[10px] font-bold text-neutral-500">大</span>
      <input
        type="range"
        min={STORYBOARD_CARD_SIZE_MIN}
        max={STORYBOARD_CARD_SIZE_MAX}
        step={1}
        value={storyboardCardSize}
        onChange={(e) => setStoryboardCardSize(Number(e.target.value))}
        className="h-1 w-16 cursor-pointer accent-pink-500"
        aria-label="カードサイズ"
      />
      <span className="text-[10px] font-bold text-neutral-500">小</span>
    </label>
  );
}
