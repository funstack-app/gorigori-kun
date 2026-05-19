export type ScoreBundle = {
  identity: number;
  outfit: number;
  prop: number;
  face: number;
  hand: number;
  background: number;
};

export type SceneGroup = { id: string; cutIds: string[] };

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

export type StoryboardRunParams = {
  storyPrompt: string;
  characterReferenceImage: string;
  styleReferenceImage?: string;
  aspectRatio: StoryboardAspectRatio;
  durationSeconds: number;
  tempo: StoryboardTempo;
  candidatesPerCut: 1 | 3;
  cwd?: string;
  sceneConstruction?: SceneConstruction;
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
