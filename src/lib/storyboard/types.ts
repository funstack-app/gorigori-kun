export type ScoreBundle = {
  identity: number;
  outfit: number;
  prop: number;
  face: number;
  hand: number;
  background: number;
};

export type SceneGroup = {
  id: string;
  cutIds: string[];
  /** P18b: シーンの狙い (1文)。AI に「このシーンで何を伝えるか」を渡すため。 */
  intent?: string;
  /** P18b: シーンの大ロケーション (例: "abandoned church nave")。シーン内で動かない。 */
  primaryLocation?: string;
};

export type StoryboardEvent =
  | { kind: "started"; runId: string; totalCuts: number; sceneGroups: SceneGroup[] }
  | { kind: "cutStarted"; cutId: string; sceneGroupId: string; takeCount: number }
  | { kind: "takeCompleted"; cutId: string; takeId: string; imagePath: string; scores: ScoreBundle }
  | { kind: "cutCheckpoint"; cutId: string; reason: string }
  | { kind: "cutConfirmed"; cutId: string; selectedTakeId: string }
  | { kind: "cutFailed"; cutId: string; reason: string }
  | { kind: "completed"; runId: string; manifestPath: string };

export type StoryboardAspectRatio = "9:16" | "1:1" | "16:9" | "4:5";
export type StoryboardTempo = "fast" | "standard" | "slow";

export type StoryboardParams = {
  duration_seconds: number;
  aspect_ratio: StoryboardAspectRatio;
  tempo: StoryboardTempo;
  character_reference_path: string;
  style_reference_path?: string;
};

export type SceneConstruction = {
  total_cuts: number;
  cuts: Array<{
    cut_id: string;
    description: string;
    duration_seconds: number;
  }>;
};

/**
 * 同時生成枚数 (1 カットあたりの take 数)。
 * P10 (2026-05-20): 1 / 2 / 3 から選べるよう拡張 (旧 1 | 3 固定から)。
 */
export type CandidatesPerCut = 1 | 2 | 3;

export type StoryboardRunParams = {
  storyPrompt: string;
  characterReferenceImage: string;
  styleReferenceImage?: string;
  aspectRatio: StoryboardAspectRatio;
  durationSeconds: number;
  tempo: StoryboardTempo;
  candidatesPerCut: CandidatesPerCut;
  cwd?: string;
  sceneConstruction?: SceneConstruction;
  /** 絵コンテ (storyboard panel) モード。バックエンドでスケッチ強制スタイルに切替。 */
  sketchMode?: boolean;
  /** 手動採用モード (P2): AI評価ループをスキップし、ユーザーが take を選ぶ。 */
  manualSelection?: boolean;
  /** P12: 絵コンテ画像を本生成の追加参考にする (cutId → 画像パス)。 */
  sketchReferences?: Record<string, string>;
};

export type StoryboardEditMagicLayerStep = {
  kind: "edit_magic_layer";
  imagePath: string;
  autoRun?: boolean;
};

export type StoryboardSkillStep = StoryboardEditMagicLayerStep;

export type StoryboardCompletedResult = {
  cuts: Array<{
    cutId: string;
    selectedTake: {
      imagePath: string;
    };
  }>;
};

// ============================================================
// β版 Storyboard Workspace 4-Phase ワークフロー型定義
// (STΛCK 指示 2026-05-20: agentic UX。AI が深掘り質問しながら
//  ゴール → スケッチ → 生成 → カット確認 の流れを駆動する)
// ============================================================

/**
 * Phase 1 (GoalChat): 作りたい映像を AI が深掘りヒアリングする会話状態。
 */
export type StoryboardPhase =
  | "goal"       // Phase 1: 目標を会話で深掘り
  | "sketch"     // Phase 2: スケッチ (絵コンテ) を提示してレビュー
  | "generation" // Phase 3: カット画像を順次生成中
  | "review";    // Phase 4: 完成カットを並べて最終確認

/**
 * Phase 1 で蓄積される対話メッセージ。
 * role=user は STΛCK、role=ai は AI、role=system は内部ガイダンス。
 */
export type StoryboardChatMessage = {
  id: string;
  role: "user" | "ai" | "system";
  text: string;
  ts: number;
  /**
   * AI が「これを聞きたい」と思っている探索中の項目 (任意)。
   * 例: "duration" / "main_character" / "mood" / "ending"
   * UI 側で「いま AI が知ろうとしていること」をピル表示するために使う。
   */
  probing?: string;
};

/**
 * Phase 1 終了時に AI が出力する「ストーリーゴール」要約。
 * これを元に Phase 2 のスケッチを生成する。
 */
export type StoryboardGoal = {
  summary: string;             // 「30秒のSNS縦動画。主人公が朝日を見て決意する」等
  characterDescription: string; // 主人公の外見・服装
  toneKeywords: string[];      // ["静謐", "希望", "ノスタルジック"]
  durationSeconds: number;
  aspectRatio: StoryboardAspectRatio;
  tempo: StoryboardTempo;
  characterReferencePath: string;
  styleReferencePath?: string;
};

/**
 * Phase 2 (SketchReview): カット 1 枚分のスケッチ案。
 * 絵コンテ的なざっくりレイアウトと、AI が考えたカット意図のテキスト。
 */
// ============================================================
// Canvas スケッチ絵コンテ描画用の構造化メタ (STΛCK 指示 2026-05-20)
// ============================================================

/** ショットサイズ。被写体の画面占有率 ≒ キャラ描画サイズ。 */
export type StoryboardShotType =
  | "extreme_close" // クロースアップより寄り (目元等)
  | "close"         // クロースアップ (顔)
  | "medium"        // ミディアム (上半身)
  | "full"          // フルショット (全身)
  | "wide"          // ワイド (全身 + 環境)
  | "extreme_wide"; // 引きの大ワイド

/** カメラアングル。俯瞰 / 煽り等。 */
export type StoryboardCameraAngle =
  | "front"   // 正面
  | "side"    // 横
  | "back"    // 背面
  | "three_quarter" // 斜め45°
  | "high"    // 俯瞰
  | "low"     // 煽り
  | "dutch";  // 傾き (ダッチ)

/** 画面内の被写体の位置 (三分割法に近い)。 */
export type StoryboardSubjectPosition =
  | "center"
  | "left"
  | "right"
  | "upper_left"
  | "upper_right"
  | "lower_left"
  | "lower_right";

/** 視線方向 (簡易)。Canvas で矢印として描画する。 */
export type StoryboardGazeDirection =
  | "to_camera"
  | "left"
  | "right"
  | "up"
  | "down"
  | "off_screen";

/** カメラの動き (簡易)。Canvas でベクトル矢印として描画する。 */
export type StoryboardCameraMotion =
  | "static"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "dolly_in"
  | "dolly_out"
  | "handheld";

export type StoryboardSketchCut = {
  cutId: string;
  order: number;            // 1-based。表示順
  durationSeconds: number;
  intent: string;           // 「主人公の朝の表情。寄り、頬に光」
  cameraNote: string;       // 「クロースアップ、目線カメラ寄り」
  visualLayout: string;     // テキスト記述ベースの絵コンテ。SVG/画像が無くても表現できる
  /** AI が補足したい注意点 (180度ルール、A-roll/B-roll 区別等)。 */
  filmNotes?: string[];
  /** ユーザーが手書きで上書きした場合の差分メモ。空なら未編集。 */
  userOverride?: string;

  // === スケッチメタ (Canvas 自前描画用 / プロンプト構造化用に両用) ===
  shotType?: StoryboardShotType;
  cameraAngle?: StoryboardCameraAngle;
  subjectPosition?: StoryboardSubjectPosition;
  gazeDirection?: StoryboardGazeDirection;
  cameraMotion?: StoryboardCameraMotion;
  /** 小道具・背景の簡易メモ (例: "金属ケース", "歯車", "煙"). */
  props?: string[];

  // === 絵コンテ画像 (GPT Image 2 でスケッチ風に生成) ===
  /** バックエンドから到着した絵コンテ画像のパス。未生成なら undefined。 */
  sketchImagePath?: string;
  /** 絵コンテ画像の状態。pending=未着手, generating=生成中, done=完了, failed=失敗。 */
  sketchStatus?: "pending" | "generating" | "done" | "failed";
};

/**
 * Phase 2 のスケッチ全体。複数バージョンを保持できる。
 * STΛCK 要望: 「視覚的に絵コンテとして出せないんですかね」に応えるため
 * visualLayout はテキストだけど、UI 側で枠付きカード + アイコンで
 * 絵コンテ風に描画する。
 */
export type StoryboardSketchVersion = {
  versionId: string;
  createdAt: number;
  /** どの会話から派生したか (再生成の遡及用)。 */
  fromGoalSummary: string;
  cuts: StoryboardSketchCut[];
  /** AI からの全体方針メモ (キャラ一貫性, A-roll/B-roll 比率等)。 */
  directorNotes: string;
};
