/**
 * 確認（層A）の進捗を実測で出すための分割実行（I3 / 2026-08-05 STΛCK実機FB）。
 *
 * ## 何を直したか
 *
 * 「確認する」を押しても、生成中に出るのと同じ横ゲージが出なかった。
 * `sticker_inspect` を全枚数まとめて1回呼ぶだけだったので、
 * **途中経過を出す材料が無かった**（「確認中…」の文字だけで、押したあと
 * 何も動いていないように見える）。
 *
 * 検査は**枚数が分かっている**ので、生成と同じく実測 k/N を渡せる。
 * ここでは呼び出しを小分けにして、1件終わるたびに進捗を報告する。
 *
 * ## セット判定（`total-too-large` / `count-invalid`）を壊さない（最重要）
 *
 * `inspect_set`（Rust）は**セット全体**を見て判定する:
 *
 * - `total-too-large` — 全枚数の合計バイト数
 * - `count-invalid` — 枚数が申請可能な選択肢のどれかか
 *
 * 小分けにした戻りの `setIssues` をそのまま採ると、
 * **4枚ずつのチャンクが「4枚だから枚数が不正」と言い出す**（分割の都合が
 * 規格の判定に化ける）。合計バイト数も同様にチャンク単位になる。
 *
 * したがってこの層は:
 *
 * - **1件ずつの所見（`items`）はチャンクの戻りから集める**（同じ関数が出した事実）
 * - **セットの所見（`setIssues` / `totalBytes`）は全件を渡した1回の呼び出しから採る**
 *
 * 判定をTSで再実装しない（判断を2箇所に置かない）。分割は進捗を出すための
 * 都合であって、規格の判定を変えるものではない。
 */
import type {
  StickerChromaSample,
  StickerInspectResult,
  StickerExportMode,
} from "../ipc";

/**
 * 1回の呼び出しで検査する枚数。
 *
 * 小さいほど進捗が細かく出るが、呼び出し回数が増える。最大40枚なので
 * 4 なら最多10回。1枚ずつ（40回）は往復が無駄で、20枚ずつでは
 * 進捗がほぼ2段階しか出ない。
 */
export const INSPECT_CHUNK_SIZE = 4;

/** 進捗の報告。`done` は決着した枚数、`total` は全枚数。 */
export type InspectProgress = { done: number; total: number };

/** 差し替え可能な依存（テストが継ぎ目として使う）。 */
export type InspectFn = (
  paths: string[],
  mode: StickerExportMode,
  chromaSamples?: StickerChromaSample[],
) => Promise<StickerInspectResult>;

/** 与えた配列を `size` ごとに切る。端数は最後のチャンクに入る。 */
export function chunkPaths(paths: readonly string[], size: number): string[][] {
  if (size <= 0) return paths.length > 0 ? [[...paths]] : [];
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) {
    out.push(paths.slice(i, i + size));
  }
  return out;
}

/**
 * 進捗を報告しながら層Aの検査を実行する。
 *
 * 戻りは**全件を1回で検査したときと同じ形**:
 *
 * - `items` — チャンクごとの戻りを順序どおり連結したもの
 * - `setIssues` / `totalBytes` — **全件を渡した最後の1回**から採る
 *
 * `onProgress` は各チャンクの完了時に呼ばれる（0件のときは呼ばれない）。
 * 最後のセット判定の呼び出しでは進捗を進めない — そこは「もう一度全部見る」
 * のではなく**セットの判定だけを採る**ための呼び出しで、枚数の進み具合とは別だから。
 *
 * @param paths 検査対象。空なら呼び出しを1つも行わず空の結果を返す。
 */
export async function inspectWithProgress(
  paths: readonly string[],
  mode: StickerExportMode,
  chromaSamples: StickerChromaSample[],
  inspect: InspectFn,
  onProgress: (progress: InspectProgress) => void,
): Promise<StickerInspectResult> {
  const total = paths.length;
  if (total === 0) {
    return { items: [], setIssues: [], totalBytes: 0 };
  }

  const chunks = chunkPaths(paths, INSPECT_CHUNK_SIZE);
  const items: StickerInspectResult["items"] = [];
  let done = 0;

  // 進捗の起点を出す（押した瞬間にゲージが 0 で現れる。無反応に見せない）。
  onProgress({ done: 0, total });

  for (const chunk of chunks) {
    // 統計は**そのチャンクに含まれる画像の分だけ**渡す。全部渡しても Rust 側は
    // パスで引くので害は無いが、渡す材料と検査対象を揃えておくほうが読み違えない。
    const chunkSamples = chromaSamples.filter((s) => chunk.includes(s.path));
    const res = await inspect(chunk, mode, chunkSamples);
    items.push(...res.items);
    done += chunk.length;
    onProgress({ done, total });
  }

  // セットの判定は**全件を渡した1回**から採る（分割の都合を規格の判定に化けさせない）。
  // チャンクが1つしか無い場合でも同じ経路を通す — 分岐を作ると
  // 「1チャンクのときだけ挙動が違う」という穴になる。
  const full = await inspect([...paths], mode, chromaSamples);

  return {
    items,
    setIssues: full.setIssues,
    totalBytes: full.totalBytes,
  };
}
