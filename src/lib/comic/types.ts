/**
 * 漫画制作スキル（スキル一覧v2.1 #9）の型定義。
 *
 * MVP のデータフロー:
 *   話（あらすじ）+ 形式 + 登場キャラ
 *     → ネーム生成（AI が JSON でコマ割り+セリフを返す）
 *     → ネーム確認（人がコマごとに構図・セリフ・プロンプトを直す。工程設計の要）
 *     → コマ生成（各コマのプロンプト＋キャラ参照画像で既存の画像生成経路を発火）
 *     → ページプレビュー（縦組みで並べる。吹き出し合成は将来課題）
 *
 * 写植・吹き出し合成は MVP 対象外（表示のみ・将来課題）。
 */

/** コマ数の形式。MVP は 4コマ / 8コマ の2種のみ。 */
export type ComicFormat = 4 | 8;

/** 選択された登場キャラ（プリセット由来）の最小情報。 */
export type ComicCharacter = {
  /** 元プリセット ID。 */
  presetId: string;
  /** 表示名（プリセット名）。ネームの登場キャラ指定と突き合わせる。 */
  name: string;
  /** 属性テキスト（髪色・服装など）。生成プロンプトに合成する。 */
  attributes?: string;
  /** 正本画像パス（3面図・表情など）。生成時の参照画像に流す。 */
  referenceImagePaths: string[];
};

/**
 * ネームの1コマ分。AI が生成し、ネーム確認 UI で人が編集する。
 * セリフと生成用プロンプトはユーザー編集可能にするのが工程設計の要。
 */
export type ComicPanel = {
  /** コマ番号（1始まり）。 */
  index: number;
  /** 構図・カメラの説明（例: 「引きのロングショット、俯瞰」）。 */
  composition: string;
  /** このコマに登場するキャラ名（ComicCharacter.name と対応）。 */
  characters: string[];
  /** 演技・表情の説明（例: 「驚いて目を見開く」）。 */
  acting: string;
  /** セリフ（複数行可。空なら無言コマ）。 */
  dialogue: string;
  /** 画像生成用プロンプト（英語/日本語混在可）。人が編集できる。 */
  prompt: string;
};

/** ネーム全体（コマの配列＋メタ）。 */
export type ComicName = {
  format: ComicFormat;
  panels: ComicPanel[];
};

/** 1コマの生成結果。 */
export type ComicPanelResult = {
  /** 対応するコマ番号。 */
  index: number;
  /** 生成された画像の絶対パス（未生成は undefined）。 */
  imagePath?: string;
  /** 生成中フラグ。 */
  generating: boolean;
  /** 生成開始時刻（Date.now()）。推定進捗ゲージの基準。未開始は undefined。 */
  startedAt?: number;
  /** 生成エラーメッセージ（成功時は undefined）。 */
  error?: string;
};

/** ワークスペースの工程フェーズ。 */
export type ComicPhase = "input" | "name" | "panels" | "preview";
