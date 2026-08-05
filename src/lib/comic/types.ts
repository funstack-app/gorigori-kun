/**
 * 漫画制作スキル（スキル一覧v2.1 #9）の型定義。
 *
 * データフロー（おまかせ一括・唯一の経路）:
 *   話 + キャラ + ページ数 + 参考テンプレ(任意)
 *     → 構成生成（AI が JSON でページ割り+コマ割り+セリフを返す）
 *     → 構成確認（人がページ/コマ単位で直す）
 *     → ページ並列生成（1ページ=1枚。吹き出し・擬音は絵として描かれる）
 *     → ページ一覧（再生成・保存・一括保存）
 *
 * 旧「詳細編集（コマ別）」経路（ネーム → コマ生成 → CSS合成ページ確認 →
 * Canvas 1枚書き出し）は 2026-07-28 に撤去した（STΛCK指示）。
 * つくり方の選択自体を無くし、上の一気生成だけを残している。
 *
 * コマ数の正本は layoutTemplates.ts の `panelCount`（旧・形式(4|8)型は 2026-07-28 に廃止）。
 * 吹き出しの画像への焼き込み（書き出し）は将来課題（表示は CSS で成立させる）。
 */

import type { ComicPanelSlot } from "./layoutTemplates";

/** ページ数の指定。"auto"=AI が決める（目安 MAX_STORY_PAGES）／数値=そのページ数（上限なし）。 */
export type PageCountChoice = "auto" | number;

/** 選択された登場キャラ（プリセット由来 or 画像から追加）の最小情報。 */
export type ComicCharacter = {
  /** 元プリセット ID。画像から追加したキャラは undefined。 */
  presetId?: string;
  /** 表示名（プリセット名）。ネームの登場キャラ指定と突き合わせる。 */
  name: string;
  /** 属性テキスト（髪色・服装など）。生成プロンプトに合成する。 */
  attributes?: string;
  /** 正本画像パス（3面図・表情など）。生成時の参照画像に流す。 */
  referenceImagePaths: string[];
};

/**
 * 画像から追加した登場キャラ（PC 添付 / ライブラリ選択）。
 * ComicFlow のセッション内 state 専用（ディスク保存しない。新規保存領域を作らない）。
 * name は編集可能で、ComicCharacter.name → ネーム配役・参照解決にそのまま流れる。
 */
export type ComicImageCharacter = {
  /** セッション内一意 ID（crypto.randomUUID()）。削除・名前編集のキー。 */
  id: string;
  /** 表示名。既定は「キャラN」（セッション通し連番）。空にはさせない。 */
  name: string;
  /** 参照画像の絶対パス。 */
  imagePath: string;
  /** 入力元（チップのラベル表示用）。 */
  source: "file" | "library";
};

/**
 * 背景・小物の環境参照（3ir 2026-08-03）。
 * ページ間でデザインを固定したい物・背景・環境をユーザーが明示添付する。
 * ComicFlow のセッション内 state 専用（ディスク保存しない。imageCharacters と同格）。
 * kind の語彙は referenceRoles.ts の ReferenceRoleKind から location / item を流用する
 * （企画チャットの参照ロールと同じ意味論。ただし保存 regime は別＝グローバル
 * referenceRoles ストアには書かない）。
 */
export type ComicEnvReference = {
  /** セッション内一意 ID（crypto.randomUUID()）。削除・編集のキー。 */
  id: string;
  /** 表示名。プロンプトへ「名前」としてそのまま出す（例:「ドア」）。空にはさせない。 */
  name: string;
  /** location = 背景・環境・舞台 / item = 小物・オブジェクト（形状・質感を固定） */
  kind: "location" | "item";
  /** 参照画像の絶対パス。 */
  imagePath: string;
  /** 入力元（チップのラベル表示用）。 */
  source: "file" | "library";
};

/**
 * コマ絵の画風。生成プロンプトのベース句を切り替える（セッション内のみ・保存しない）。
 * 既定は "mono"（従来どおりの白黒漫画）。
 *
 * "faithful"（キャラ忠実）はリファレンス画像の画風・質感をそのまま保つモード。
 * mono/color が「参照の写真調・3D調を無視して漫画へ変換する」のに対し、
 * faithful は変換をせず参照の描画スタイルを維持する（狙いが正反対）。
 */
export type ComicColorMode = "mono" | "color" | "faithful";

/**
 * コマの読み方向 (B-1 2026-07-30)。生成プロンプトの空間指示
 * (panel 位置の明示・読み順強調句) に効く。既定は "rtl" (右→左・日本式)。
 * 最終レイアウトは画像生成AIが描くため、指示を強めても保証はされない
 * (効果は確率的)。決定論保証はコード合成経路の復活が必要で、今回はやらない。
 */
export type ComicReadingDirection = "rtl" | "ltr";

/** 枠線の太さ (B-4b)。プロンプト近似のため再現は保証されない。既定 "standard"。 */
export type ComicFrameStyle = "thin" | "standard" | "bold";
/** コマ間隔 (B-4b)。プロンプト近似のため再現は保証されない。既定 "standard"。 */
export type ComicGutterStyle = "narrow" | "standard" | "wide";

/** 保存形式（セッション内のみ・保存しない）。 */
export type ComicSaveFormat = "png" | "jpeg";

/**
 * 吹き出しの種類（gtm 2026-08-03。出典: Chico 要望 DB3 / bd gtm ①〜⑥）。
 * ページ生成プロンプトへ kind 別の英語記述子として焼き込む（効果は確率的）。
 */
export type ComicBalloonKind =
  | "normal" // 通常
  | "black" // 黒ベタ（Chico ①）
  | "shout" // 叫び（既存）
  | "shout_black" // 黒ギザギザ（Chico ⑥）
  | "monologue" // 心の声（既存。記述子を④仕様に強化）
  | "narration" // ナレーション・四角囲み（既存）
  | "caption" // ナレーション・文字のみ（Chico ③）
  | "machine"; // 機械音声・動物用の多角形（Chico ⑤）

/** ネームの吹き出し1個。AI が生成し、ネーム確認とページ編集で人が直す。 */
export type ComicBalloon = {
  /** セッション内一意 ID（crypto.randomUUID()）。編集・描画キー。 */
  id: string;
  /** 話者名（表示補助。narration は空文字）。生成参照の解決には使わない。 */
  speaker: string;
  /** セリフ本文（改行可）。 */
  text: string;
  kind: ComicBalloonKind;
  /**
   * コマ bbox 内の位置（percent・吹き出し左上）。null = 自動初期配置
   * （読み順スロット: 1個目=右上 / 2個目=左下。balloonLayout.ts が決める）。
   * ユーザーがドラッグしたときだけ数値が入る。
   */
  pos: { x: number; y: number } | null;
  /** ページ表示・書き出しに含めるか。 */
  visible: boolean;
};

export type ComicSfxIntent = "impact" | "motion" | "quiet" | "emotion";

/** 擬音（オノマトペ）1個。 */
export type ComicSfx = {
  id: string;
  /** 擬音テキスト（カタカナ中心・2〜6文字目安）。 */
  text: string;
  intent: ComicSfxIntent;
  /** コマ bbox 内 percent。null = 自動初期配置。 */
  pos: { x: number; y: number } | null;
  /** 回転（deg）。intent から初期決定。 */
  rotation: number;
  /** 大きさ倍率。intent から初期決定。 */
  scale: number;
  visible: boolean;
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
  /** 吹き出し（最大2個。空配列=無言コマ）。配列順=発話順=配置順。 */
  balloons: ComicBalloon[];
  /** 擬音（最大2個。無ければ空配列）。 */
  sfx: ComicSfx[];
  /** 画像生成用プロンプト（英語/日本語混在可）。人が編集できる。 */
  prompt: string;
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

/**
 * 構成フェーズが確定させる1ページ分。panels は既存 ComicPanel をそのまま使う
 * （balloons/sfx スキーマ・編集 UI・toBalloons/toSfx の検証を全部流用するため）。
 */
export type ComicStoryPage = {
  /** ページ番号（1始まり・連番）。 */
  page: number;
  /** このページで起きること（40字目安・編集可）。前後ページの連続性コンテキストに使う。 */
  synopsis: string;
  /** コマ割り方針（英語1文・編集可・空可）。テンプレ未選択時のレイアウト指示に使う。 */
  layoutHint: string;
  /**
   * このページに登場する登場キャラ名（ページ=参照紐付けの単位の正本）。
   * parseComicStory が panels[].characters の和集合を必ず含む形に正規化する
   * （trim 済み・重複なし）。モブは含めない。
   */
  cast: string[];
  /** このページのコマ数。panels.length と常に一致（isValidStory が保証）。 */
  panelCount: number;
  panels: ComicPanel[];
  /**
   * 生成後のコマ分割/統合でこのページ専用に上書きされたスロット。
   * undefined = テンプレ（getComicTemplate(storyTemplateId).slots）が正。
   * ある場合は length === panels.length を分割/統合の操作側が常に保証する。
   * ページ丸ごと再生成が成功した時点で破棄される（新画像には適用されないため）。
   */
  slotsOverride?: ComicPanelSlot[];
};

/** 1ページの生成結果。ComicPanelResult のページ版（構造を揃えて実装を写経可能にする）。 */
export type ComicPageResult = {
  page: number;
  imagePath?: string;
  generating: boolean;
  startedAt?: number;
  error?: string;
  /** この画像を生成したときの読み方向。1コマ再編集の対応判定に使う（B-1 の鏡像問題）。 */
  direction?: ComicReadingDirection;
  /** この画像を生成したときの画風。faithful は1コマ再編集の対象外判定に使う。 */
  colorMode?: ComicColorMode;
  /** この画像を生成したときの絵柄テキスト（qvs）。1コマ再編集が同じ絵柄を引き継ぐための記録。 */
  styleText?: string;
};

/**
 * ワークスペースの工程フェーズ。
 * 旧・詳細編集の "name" / "panels" / "preview" は経路ごと撤去した (2026-07-28)。
 */
export type ComicPhase = "input" | "plan" | "pages";
