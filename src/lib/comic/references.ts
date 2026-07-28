/**
 * コマごとのキャラ参照画像の解決（2026-07-28 追加）。
 *
 * ## なぜ関数に切り出したか
 *
 * 従来は ComicWorkspace の中で「ネームのキャラ名と登録キャラ名が完全一致したものだけ
 * 参照を添付する」を直書きしていた。AI が独自名を付けると一致ゼロになり、
 * **参照ゼロのまま警告も無く生成される**（沈黙の失敗）。STΛCK 実機FB
 * 「キャラ選択しても反映されない」の直接の原因。
 *
 * 解決を1関数に寄せることで、
 *   - 実際に渡す refPaths
 *   - UI に出すバッジ（matched / fallback / none）
 * が**同じ判定**を使う。表示と実際の受け渡しが乖離する経路を構造的に塞ぐ。
 */

import type { ComicCharacter, ComicPanel, ComicStoryPage } from "./types";

export type PanelReferenceResolution = {
  refPaths: string[];
  /** 名前一致した選択キャラ名（表示用） */
  matchedNames: string[];
  /**
   * matched  = 1体以上が名前一致（一致分のみ渡す）
   * fallback = 登場キャラ欄はあるが一致ゼロ → 選択キャラ全員の参照を渡す
   * none     = 参照なし（キャラ未選択、またはこのコマにキャラ登場なし）
   */
  mode: "matched" | "fallback" | "none";
};

/**
 * このコマに渡す参照画像を決める。
 *
 * 判定は決定論（trim 後の完全一致のみ）。部分一致・かな正規化はしない
 * ——「ミノリ」vs「みのり先生」のような取り違えは、嘘の参照を作るため。
 */
export function resolvePanelReferences(
  panel: Pick<ComicPanel, "characters">,
  characters: ComicCharacter[],
): PanelReferenceResolution {
  if (characters.length === 0) {
    return { refPaths: [], matchedNames: [], mode: "none" };
  }

  const panelNames = panel.characters
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (panelNames.length === 0) {
    // 風景・無人コマ。意図を尊重して参照を渡さない。
    return { refPaths: [], matchedNames: [], mode: "none" };
  }

  const matched = characters.filter((c) =>
    panelNames.some((name) => name === c.name.trim()),
  );
  if (matched.length > 0) {
    return {
      refPaths: matched.flatMap((c) => c.referenceImagePaths),
      matchedNames: matched.map((c) => c.name),
      mode: "matched",
    };
  }

  // 一致ゼロ。名前がズレただけで参照が消えるより、全員渡して
  // 「一致しなかった」ことを UI で見せるほうが実害が小さい。
  return {
    refPaths: characters.flatMap((c) => c.referenceImagePaths),
    matchedNames: [],
    mode: "fallback",
  };
}

/**
 * ページ生成1回に添付する参照画像の上限（2026-07-28 追加）。
 *
 * 現行のキャラ参照は1体最大3枚（selectCharacterReferences 既定）。cast が3体以下なら
 * 9枚＝現行フル品質のまま無変化。STΛCK 実測「14枚で激遅」（2026-07-19・
 * presets/character.ts コメント）に対しマージンを取って 9 で確定。
 */
export const MAX_PAGE_REFERENCES = 9;

/**
 * panels 配列順 → 各コマの characters 配列順で trim・非空・初出順 dedupe した名前配列。
 *
 * parseComicStory（cast の正規化）と resolvePageCast（stale state の導出フォールバック）の
 * 両方がこれを使い、「panels から cast を導く規則」を1箇所に閉じる。
 */
export function unionPanelCharacters(panels: Pick<ComicPanel, "characters">[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const panel of panels) {
    for (const raw of panel.characters) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 参照画像の配分（決定論）。
 *
 * 「全 cast キャラに最低1枚」を保証する（一部キャラだけ3枚より、全員の同一性を優先）。
 * 手順:
 *   1. 各キャラの referenceImagePaths をパス完全一致で先勝ち dedupe（キャラ間の重複も先勝ち）
 *   2. 基本割当 k = max(1, floor(max / n))、take[i] = min(k, 手持ち枚数)
 *   3. 残予算がある間、引数順に1周ずつ「まだ未使用参照が残るキャラ」へ1枚ずつ追加
 *   4. キャラ順にグループ化して連結し、最後に slice(0, max)
 *
 * cast が max を超える縮退ケース（10体以上）では、手順4の slice により
 * **引数順の先頭 max 体が各1枚**になる（末尾のキャラは参照が付かない）。
 */
export function allocatePageReferences(
  chars: ComicCharacter[],
  max: number = MAX_PAGE_REFERENCES,
): string[] {
  if (chars.length === 0 || max <= 0) return [];

  // 1. キャラ間もまたいだ先勝ち dedupe
  const seenPath = new Set<string>();
  const pools: string[][] = chars.map((c) => {
    const pool: string[] = [];
    for (const path of c.referenceImagePaths) {
      if (typeof path !== "string" || path.length === 0) continue;
      if (seenPath.has(path)) continue;
      seenPath.add(path);
      pool.push(path);
    }
    return pool;
  });

  // 2. 基本割当（最低1枚）
  const n = pools.length;
  const base = Math.max(1, Math.floor(max / n));
  const take = pools.map((pool) => Math.min(base, pool.length));

  // 3. 残予算を引数順に1枚ずつ配る
  let remaining = max - take.reduce((sum, t) => sum + t, 0);
  while (remaining > 0) {
    let added = false;
    for (let i = 0; i < n && remaining > 0; i += 1) {
      if (take[i] < pools[i].length) {
        take[i] += 1;
        remaining -= 1;
        added = true;
      }
    }
    if (!added) break; // 全キャラの手持ちを使い切った
  }

  // 4. キャラ順に連結して上限で切る
  return pools.flatMap((pool, i) => pool.slice(0, take[i])).slice(0, max);
}

export type PageCastResolution = {
  /** 実際に生成へ渡す参照パス（配分・上限適用済み） */
  refPaths: string[];
  /** 表示用の実効 cast（stale state では panels から導出） */
  castNames: string[];
  /** 名前一致した選択キャラ名（cast 順） */
  matchedNames: string[];
  /** 一致しなかった cast 名（cast 順）。UI の黄チップ対象 */
  unmatchedNames: string[];
  /** buildFullPagePrompt の characters 引数へ渡すキャラ集合 */
  castCharacters: ComicCharacter[];
  /** matched / fallback / none（resolvePanelReferences と同語彙） */
  mode: "matched" | "fallback" | "none";
};

/**
 * このページに渡す参照画像・属性キャラ集合を決める（resolvePanelReferences のページ版）。
 *
 * UI 表示（PageCastRow）と実際の添付（generateStoryPage）が**同じ関数**を使うので、
 * 「バッジは matched なのに全員添付されている」型の乖離が構造的に起きない。
 *
 * 判定は決定論（trim 後の完全一致のみ）。部分一致・かな正規化はしない
 * ——「ミノリ」vs「みのり先生」のような取り違えは、嘘の参照を作るため。
 */
export function resolvePageCast(
  page: Pick<ComicStoryPage, "cast" | "panels">,
  characters: ComicCharacter[],
): PageCastResolution {
  const empty = (castNames: string[]): PageCastResolution => ({
    refPaths: [],
    castNames,
    matchedNames: [],
    unmatchedNames: [],
    castCharacters: [],
    mode: "none",
  });

  if (characters.length === 0) return empty([]);

  // `??` は HMR で cast 未定義の stale state が残るケース専用の防御。
  // 正常系では parseComicStory が必ず配列を入れる。
  const castNames = (
    page.cast ?? unionPanelCharacters(page.panels)
  )
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (castNames.length === 0) {
    // 風景・無人ページ。意図を尊重して参照を渡さない。
    return empty([]);
  }

  // cast の並び順で引く（ページ内の重要度順を保つ）。
  const matchedCharacters: ComicCharacter[] = [];
  const matchedNames: string[] = [];
  const unmatchedNames: string[] = [];
  for (const name of castNames) {
    const hit = characters.find((c) => c.name.trim() === name);
    if (hit && !matchedCharacters.includes(hit)) {
      matchedCharacters.push(hit);
      matchedNames.push(hit.name);
    } else if (!hit) {
      unmatchedNames.push(name);
    }
  }

  if (matchedCharacters.length > 0) {
    return {
      refPaths: allocatePageReferences(matchedCharacters),
      castNames,
      matchedNames,
      unmatchedNames,
      castCharacters: matchedCharacters,
      mode: "matched",
    };
  }

  // 一致ゼロ。名前がズレただけで参照が消えるより、全員渡して
  // 「一致しなかった」ことを UI で見せるほうが実害が小さい。
  return {
    refPaths: allocatePageReferences(characters),
    castNames,
    matchedNames: [],
    unmatchedNames,
    castCharacters: characters,
    mode: "fallback",
  };
}

/**
 * 全ページの cast のうち、選択キャラ名（trim 完全一致）に無い名前を初出順 dedupe で返す。
 * 構成生成直後の1回きりのトースト（「割り当てできます」案内）に使う。
 */
export function collectUnboundCastNames(
  pages: Pick<ComicStoryPage, "cast" | "panels">[],
  characters: ComicCharacter[],
): string[] {
  if (characters.length === 0) return [];
  const known = new Set(characters.map((c) => c.name.trim()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const castNames = page.cast ?? unionPanelCharacters(page.panels);
    for (const raw of castNames) {
      const name = raw.trim();
      if (name.length === 0 || known.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
