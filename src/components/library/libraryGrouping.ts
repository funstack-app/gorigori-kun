import type { GalleryItem } from "../../lib/store/images";

export type LibraryDateGroup = {
  key: string;
  label: string;
  items: GalleryItem[];
};

/**
 * ライブラリ検索用の文字列を揃える。
 * 日本語には大文字・小文字の差がないが、英数字のファイル名も同じ入力で探せるようにする。
 */
function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase("ja-JP");
}

/** ファイル名または AI 題名の部分一致。空の検索語は全件一致。 */
export function matchesLibrarySearch(item: GalleryItem, query: string): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const basename = item.path.split(/[\\/]/).pop() ?? "";
  return [item.name, item.aiTitle ?? "", basename].some((value) =>
    normalizeSearchText(value).includes(needle),
  );
}

/** ローカル時刻で同じ日を同じキーへまとめる。 */
export function libraryDateKey(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  if (Number.isNaN(date.getTime())) return "unknown";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 仕様の「2026年8月19日」形式。 */
export function formatLibraryDate(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  if (Number.isNaN(date.getTime())) return "日付不明";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 作成日時の新しい順に並べ、同じ日を1グループにする。
 * 入力配列は並べ替えず、大容量ライブラリの正本 state を変更しない。
 */
export function groupLibraryItemsByDate(items: GalleryItem[]): LibraryDateGroup[] {
  const sorted = [...items].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const groups = new Map<string, LibraryDateGroup>();

  for (const item of sorted) {
    const key = libraryDateKey(item.mtimeMs);
    const current = groups.get(key);
    if (current) {
      current.items.push(item);
    } else {
      groups.set(key, {
        key,
        label: formatLibraryDate(item.mtimeMs),
        items: [item],
      });
    }
  }

  return Array.from(groups.values());
}
