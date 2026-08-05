/**
 * スタンプ1枚の個別マスク編集（設計書 v3 §1.5 / S3・STΛCK決定5）。
 *
 * ## この層が持つもの / 持たないもの
 *
 * マスク合成の実体は **1つも書かない**。すべて `src/lib/imageReedit/maskReedit.ts` の
 * 共有層（漫画のコマ編集で検証済み）を呼ぶ。ここにあるのは
 * 「スタンプ用の sourceTag とプロンプト組み立て」という薄い差分だけ。
 *
 * 合成ロジックを持たない理由は STΛCK決定5 の「新規に作らない」そのもの。
 * 同じロジックが2箇所にあると、次にバグが見つかったとき片方だけ直る。
 *
 * ## 共有層の安全弁がスタンプで効く理由
 *
 * 部分再生成でAIが**画像全体を描き直して返す**のは常態（漫画で実証済み）。
 * `compositePanelRgba` のマスク外差分ゼロ検証が無いと「口だけ直したはずが顔が
 * 別人になった1枚」が採否リストに黙って混ざる。同一性維持がGORI GORI KUNの核なので、
 * この関門は漫画よりむしろスタンプで重要度が高い。
 */
import {
  buildPanelReeditGenerationRequest,
  type PanelReeditPoint,
} from "../imageReedit/maskReedit";
import {
  cutOutBackground,
  defaultCutoutDeps,
  type CutoutDeps,
  type CutoutOutcome,
} from "./cutout";
import {
  CHROMA_BACKGROUND_CLAUSE,
  FRINGE_PREVENTION_CLAUSE,
  NO_TEXT_CLAUSE,
  REFERENCE_CLAUSES,
  STYLE_PRESERVATION_CLAUSE,
} from "./promptStyles";

/** 個別編集の生成に付ける sourceTag の接頭辞（direct-run の親IDと突き合わせる）。 */
export const STICKER_REEDIT_SOURCE_PREFIX = "sticker-reedit";

/**
 * 個別編集の指示文。
 *
 * ## 共通句を再掲せず import している理由
 *
 * 画風保持・緑背景・フリンジ予防・文字禁止は `promptStyles.ts` の**同じ定数**を使う。
 * 個別編集だけ別の文言にすると、**直した1枚だけ絵柄や背景が割れる**
 * （漫画の `pageStyleText` が「そのページを生成した時の記録値」を使うのと同じ問題）。
 *
 * 一方 `promptStyles.ts` の `build()` は**カットの表情断片から全体を組む**関数なので、
 * 「既存画像のマスク内だけを直す」用途には合わない。共通句だけを借りて、
 * マスク編集固有の指示（マスク外を1画素も変えるな）をここで足す。
 *
 * ## 参照支配句も本流と同じ条件で足す（I4 / 2026-08-05）
 *
 * 個別編集にも参照画像を渡している（`StickerReeditModal` の `referencePaths`）ので、
 * 本流と同じく画風がアニメ調へ流れうる。共通句と同じ理由で
 * **同じ定数**（`REFERENCE_CLAUSES`）を使う。ここだけ別文言にすると、
 * 直した1枚だけ絵柄が割れる。
 *
 * @param instruction ユーザーが日本語で書いた直したい内容。空なら破綻修正の既定文だけ。
 * @param hasReference 参照画像を渡しているか。false なら参照支配句を足さない。
 */
export function buildStickerReeditPrompt(
  instruction: string,
  hasReference = false,
): string {
  const trimmed = instruction.trim();
  return [
    trimmed
      ? `Edit this existing sticker image. Requested change: ${trimmed}.`
      : "Edit this existing sticker image. Fix the anatomy and rendering errors inside the masked area.",
    "Change only the area inside the supplied white mask. Keep every pixel outside the white mask unchanged.",
    STYLE_PRESERVATION_CLAUSE,
    CHROMA_BACKGROUND_CLAUSE,
    FRINGE_PREVENTION_CLAUSE,
    NO_TEXT_CLAUSE,
    ...(hasReference ? REFERENCE_CLAUSES : []),
  ].join(" ");
}

/**
 * スタンプ個別編集の生成リクエスト。
 *
 * 共有層の `buildPanelReeditGenerationRequest`（`count: 1` 固定・元画像を第1参照・
 * マスクをその対に固定）をそのまま使う。**aspect は渡さない** —
 * 元画像とマスクの実寸が正であり、規格寸法へ潰すのは書き出し時（S6）の仕事だから。
 */
export function buildStickerReeditRequest(
  instruction: string,
  originalPath: string,
  maskPath: string,
  referencePaths: string[],
  sourceTag: string,
): ReturnType<typeof buildPanelReeditGenerationRequest> {
  return buildPanelReeditGenerationRequest(
    // 参照支配句は**参照を実際に渡すときだけ**（I4）。渡していないのに
    // 「参照に一致させろ」と書くと、存在しない画像を探して指示の解像度が落ちる。
    buildStickerReeditPrompt(instruction, referencePaths.length > 0),
    originalPath,
    maskPath,
    referencePaths,
    sourceTag,
  );
}

/**
 * 個別再生成の抜きの結果（パス + 統計）。
 *
 * ## なぜパス1本でなく統計ごと返すのか（R2 / 2026-08-05）
 *
 * 旧実装は `string` だけを返しており、**統計がここで捨てられていた**。
 * その結果 `StickerWorkspace` の `adoptReedit` は統計を登録できず（`delete` するだけ）、
 * 個別再生成で差し替えた1枚だけが層Aの縁の検査・`chroma-not-cleared` の判定から
 * 外れていた。本流の `cutOut` は同じ統計を `chromaStatsRef` へ登録しているので、
 * **同じ経路には同じ材料を流す**（判断を2箇所に置かないのと同じ理由で、
 * 材料の欠落も2箇所に作らない）。
 *
 * `path` は「合成に渡すべきパス」。`cleared === 0` のときは元のパスがそのまま入る。
 */
export type StickerReeditChromaOutcome = {
  /** 合成に渡すべきパス。抜けたなら抜いた結果、抜けなければ元のまま。 */
  path: string;
  cleared: number;
  semiTransparent: number;
  opaque: number;
  despilled: number;
  /** 抜いた時点で「縁のにじみが多い」と判定されたか。 */
  fringeWarn: boolean;
};

/**
 * 個別再生成の結果を**合成する前に背景を抜く**（A1 / 設計原則 第3条）。
 *
 * ## 抜きの経路は本流と同じ（I2 / 2026-08-05 J4発動）
 *
 * 既定は AI 抜き（Mac=Vision / Win通常版=BiRefNet）で、失敗と互換版のときだけ
 * クロマキーへ落ちる。**本流（`StickerWorkspace` の `cutOut`）と同じ関数**
 * （`cutout.ts` の `cutOutBackground`）を通す — 経路が分かれると、
 * 個別に直した1枚だけ抜き方が違うことになる（「同じ経路には同じ関所」の逆）。
 *
 * ## なぜ順序を変えられないか（A1・旧 `chromaKeyBeforeComposite` から不変）
 *
 * `buildStickerReeditPrompt` は `CHROMA_BACKGROUND_CLAUSE` でAIに緑背景を要求する。
 * 一方、共有層の `compositePanelRgba` が守るのは**マスクの外**（1画素も変わっていないか）
 * だけで、**マスクの内側**は生成物をそのまま採る契約。
 *
 * つまり抜きを挟まないと、**塗った範囲に緑が残ったまま採用される**。
 * これは層Aの `no-alpha` でも拾えない — 画像の他の部分は既に透過済みなので
 * 「透明画素が1つでもあるか」は真になる。抜き直す以外に閉じ方が無い。
 *
 * ## 抜けなかったときに止めない（本流の `cutOut` と同じ判断）
 *
 * 抜けなかったのは失敗ではなく事実。元のパスで先へ進め、規格の可否は層Aに任せる
 * （判断を2箇所に置かない）。ただし**事実は捨てない** — `notCleared` を戻して
 * 呼び出し側が画面に出す（設計原則 第5条は「救済 + 可視化」の両輪）。
 *
 * @param generatedPath AIが返した画像の絶対パス。
 * @param deps 抜きの実体。既定は本番の依存（テストが差し替える継ぎ目）。
 */
export async function cutOutBeforeComposite(
  generatedPath: string,
  deps: CutoutDeps = defaultCutoutDeps,
): Promise<CutoutOutcome> {
  return cutOutBackground(generatedPath, deps);
}

/**
 * クロマキー**だけ**を通す下位API。
 *
 * `cutOutBeforeComposite` が保険として内部で使う経路と同じ判断（`cleared === 0` は
 * 救済して先へ進める）をここに持つ。単体で残しているのは、
 * **クロマキー経路の挙動そのもの**をテストが直接固定できるようにするため。
 *
 * `cleared === 0` は「緑背景が無かった」という事実であって、失敗ではない。
 * AIが緑を使わずに（既に透過された絵として）返すこともある。ここで止めると
 * その1枚を採用できなくなる。**元のパスを使って先へ進め、規格の可否は層Aに任せる**。
 * 統計は `cleared === 0` でも戻す（測った事実を捨てない）。
 *
 * @param generatedPath AIが返した画像の絶対パス。
 * @param chromaKey 抜きの実体。既定は `stickerIpc.chromaKey`（テストが差し替える継ぎ目）。
 * @returns 合成に渡すべきパスと、抜きの統計。
 */
export async function chromaKeyBeforeComposite(
  generatedPath: string,
  chromaKey: (path: string) => Promise<{
    output: string;
    cleared: number;
    semiTransparent: number;
    opaque: number;
    despilled: number;
    fringeWarn: boolean;
  }>,
): Promise<StickerReeditChromaOutcome> {
  const res = await chromaKey(generatedPath);
  return {
    path: res.cleared > 0 ? res.output : generatedPath,
    cleared: res.cleared,
    semiTransparent: res.semiTransparent,
    opaque: res.opaque,
    despilled: res.despilled,
    fringeWarn: res.fringeWarn,
  };
}

/**
 * 画像全体を覆う矩形の頂点（percent）。
 *
 * ブラシで塗る経路が既定だが、「この1枚をまるごと描き直す」用の逃げ道として
 * 多角形経路も使えるようにしておく。共有層の `createPanelMaskPng` に渡せる形。
 * 枠線保護余白があるので完全な全面にはならない（それでよい。縁は元画像を残す）。
 */
export function fullFramePoints(): PanelReeditPoint[] {
  return [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
}
