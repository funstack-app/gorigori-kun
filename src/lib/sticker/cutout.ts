/**
 * 背景の抜き（設計書 v3 §9 J4 の分岐を発動したもの）。
 *
 * ## なぜ既定を変えたか（2026-08-05 STΛCK実機FB「切り抜きにばらつきがある」）
 *
 * 設計書 §1.4 はクロマキーを既定に置き、**「実測で抜け残りが多い場合の代替」**として
 * J4 を用意していた:
 *
 * > 抜け残りが多い場合は J4: Mac=Vision / Windows通常版=BiRefNet を既定にし、
 * > クロマキーは互換版のフォールバックへ降格する
 *
 * 実機で抜けのばらつきが観測されたので、この分岐をそのまま発動する。
 * **設計を作り直したのではなく、設計に書いてあった分岐を引いた**。
 *
 * ## クロマキーは消さない（保険として残す）
 *
 * 降格であって廃止ではない。AI抜きが使えない/失敗する場面が2つ残る:
 *
 * 1. **Windows互換版**（`edit-ai` 無効ビルド。`platform.editAiAvailable === false`）。
 *    BiRefNet も Vision も無い。ここではクロマキーだけが動く
 * 2. **AI抜きの失敗**（モデル未DL・推論エラー・OS APIの失敗）
 *
 * どちらもクロマキーへ落ちる。**緑背景の生成指定（`CHROMA_BACKGROUND_CLAUSE`）は
 * 残す** — 背景のコントラストが高いほうがAI抜きの精度も出るうえ、
 * 保険の前提そのものだから。
 *
 * ## 「測っていない統計を作らない」（規律1・第5条）
 *
 * クロマキーの統計（`cleared` / `fringe`）は**クロマキーで抜いたときにしか存在しない**。
 * AI抜きの経路で偽の統計を作ると、層Aの縁の検査が「測ったふり」の値で動く。
 * したがって AI 経路の戻りは `chroma: null` にする。層Aは統計が無ければ
 * `fringe` を判定しない（既存の契約どおり。`sticker.rs` の `inspect_rgba` コメント）。
 */
import { images as imagesIpc, editModels, type EditPlatformInfo } from "../ipc";
import { segmentImage } from "../segmentation";

/** どの経路で抜いたか。採否画面のバッジ・層Aの材料の出し分けに使う。 */
export type CutoutMethod = "ai" | "chroma" | "none";

/** クロマキーの統計（`sticker_chroma_key` の戻りのうち層Aへ渡す分）。 */
export type ChromaOutcome = {
  cleared: number;
  semiTransparent: number;
  opaque: number;
  despilled: number;
  fringeWarn: boolean;
};

/** 抜きの結果。 */
export type CutoutOutcome = {
  /** 合成・採否に渡すべきパス。抜けなければ元のパスがそのまま入る。 */
  path: string;
  method: CutoutMethod;
  /**
   * クロマキーの統計。**AI経路と失敗時は `null`**。
   * 測っていないものを測ったふりにしない（層Aは null なら fringe を判定しない）。
   */
  chroma: ChromaOutcome | null;
  /**
   * 「抜けなかった」か。採否画面のバッジ（既存の amber バッジ）に出す。
   *
   * AI経路の成功は常に false（透過PNGが返るので抜けている）。
   * クロマキー経路は `cleared === 0` のとき true。両経路とも失敗すれば true。
   */
  notCleared: boolean;
};

/** 差し替え可能な依存（テストが継ぎ目として使う）。 */
export type CutoutDeps = {
  platformInfo: () => Promise<EditPlatformInfo>;
  removeBackground: (path: string) => Promise<string>;
  segment: (path: string) => Promise<{ foregroundPath: string }>;
  chromaKey: (path: string) => Promise<
    { output: string } & ChromaOutcome
  >;
};

/** 本番の依存。呼び出し側は既定のままでよい。 */
export const defaultCutoutDeps: CutoutDeps = {
  platformInfo: () => editModels.platformInfo(),
  removeBackground: (path) => imagesIpc.removeBackground(path),
  // Windows 通常版の BiRefNet。`useEditor.ts` と同じモデルIDを使う。
  segment: (path) => segmentImage({ imagePath: path, model: "u2net" }),
  chromaKey: async (path) => {
    const { sticker } = await import("../ipc");
    return sticker.chromaKey(path);
  },
};

/**
 * AI抜きがこの構成で使えるか。
 *
 * **`os` を直接見て判定しない**。Windows互換版（旧CPU向け）は `os === "windows"` の
 * まま `editAiAvailable === false` になる（`ipc.ts` の `EditPlatformInfo` コメント）。
 */
export function canUseAiCutout(platform: EditPlatformInfo): boolean {
  if (!platform.editAiAvailable) return false;
  return platform.os === "windows" || platform.os === "macos";
}

/** クロマキーで抜く（保険経路）。統計はそのまま運ぶ。 */
async function cutOutByChroma(
  imagePath: string,
  deps: CutoutDeps,
): Promise<CutoutOutcome> {
  const res = await deps.chromaKey(imagePath);
  // 1画素も抜けなかった＝緑背景が無かった。差し替えず元を残す。
  const path = res.cleared > 0 ? res.output : imagePath;
  return {
    path,
    method: "chroma",
    chroma: {
      cleared: res.cleared,
      semiTransparent: res.semiTransparent,
      opaque: res.opaque,
      despilled: res.despilled,
      // 縁の品質は**抜けた画像に対してだけ**語れる（既存 `cutOut` と同じ規則）。
      fringeWarn: res.cleared > 0 ? res.fringeWarn : false,
    },
    notCleared: res.cleared === 0,
  };
}

/**
 * 生成物の背景を抜く。**AI抜きを既定にし、駄目ならクロマキーへ落ちる**（J4）。
 *
 * 順序と落ち方:
 *
 * ```
 * 構成を見る ──(AI使える)──> AI抜き ──成功──> 透過PNG（chroma: null）
 *      │                        └──失敗──┐
 *      └──(互換版・構成不明)─────────────┤
 *                                        ↓
 *                                   クロマキー ──成功──> 透過PNG（統計あり）
 *                                        └──失敗──> 元のパス（救済して可視化）
 * ```
 *
 * **どの段でも生成物を失わせない**（設計原則 第5条）。最後まで抜けなければ
 * 元のパスを返し、`notCleared: true` で画面に出す。規格としての可否は層Aが判定する
 * （判断を2箇所に置かない）。
 */
export async function cutOutBackground(
  imagePath: string,
  deps: CutoutDeps = defaultCutoutDeps,
): Promise<CutoutOutcome> {
  let platform: EditPlatformInfo | null = null;
  try {
    platform = await deps.platformInfo();
  } catch {
    // 構成が読めない＝AI経路の可否が分からない。保険側（クロマキー）へ倒す。
    platform = null;
  }

  if (platform && canUseAiCutout(platform)) {
    try {
      const path =
        platform.os === "windows"
          ? (await deps.segment(imagePath)).foregroundPath
          : await deps.removeBackground(imagePath);
      if (path) {
        return { path, method: "ai", chroma: null, notCleared: false };
      }
      // 空パスは成功として扱えない。保険へ落ちる。
    } catch {
      // モデル未DL・推論エラー・OS API失敗。**ここで止めない**。
      // 緑背景で作ってあるので、クロマキーがまだ残っている。
    }
  }

  try {
    return await cutOutByChroma(imagePath, deps);
  } catch {
    // 両方だめ。生成物は返し、抜けなかったことを可視化する（救済 + 可視化）。
    return { path: imagePath, method: "none", chroma: null, notCleared: true };
  }
}
