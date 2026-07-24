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
  | { kind: "cutStarted"; runId: string; cutId: string; sceneGroupId: string; takeCount: number }
  | {
      kind: "takeCompleted";
      runId: string;
      cutId: string;
      takeId: string;
      imagePath: string;
      scores: ScoreBundle;
    }
  | { kind: "cutCheckpoint"; runId: string; cutId: string; reason: string }
  | { kind: "cutConfirmed"; runId: string; cutId: string; selectedTakeId: string }
  | { kind: "cutFailed"; runId: string; cutId: string; reason: string }
  | { kind: "completed"; runId: string; manifestPath: string };

// GPT Image 2 公式対応の10種に揃える (scene/types.ts SceneAspectRatio と同一集合)。
// 旧 4種 (9:16/1:1/16:9/4:5) 固定だと、AI が 21:9 等を [STORYBOARD_PARAMS] に
// 返したとき isAspectRatio が false になり extractStructuredStoryboard が null を返し、
// 「ゴールを確定」ボタンが無反応になる (2026-06-16 Ta4low 報告 N-1)。scene/video 側は
// 全10種を受け入れるため、storyboard 層もここで揃える。
export type StoryboardAspectRatio =
  | "21:9"
  | "16:9"
  | "3:2"
  | "4:3"
  | "5:4"
  | "1:1"
  | "4:5"
  | "3:4"
  | "2:3"
  | "9:16";
export type StoryboardTempo = "fast" | "standard" | "slow";

export type StoryboardParams = {
  duration_seconds: number;
  aspect_ratio: StoryboardAspectRatio;
  tempo: StoryboardTempo;
  character_reference_path: string;
  style_reference_path?: string;
  /**
   * FB#3 (2026-06-06 STΛCK 指示): 複数キャラ参照 (登場キャラ全員) / 複数スタイル参照。
   * 後方互換のため単数フィールド (character_reference_path / style_reference_path) は
   * 残す。配列が存在すればそれを優先し、下流 (本生成) は全参照を画像生成に渡す。
   * 単数フィールドは配列の先頭要素を指す。
   */
  character_reference_paths?: string[];
  style_reference_paths?: string[];
};

/**
 * ルック分析 (2026-06-06 STΛCK 指示)。参照画像 (キャラ/IP) を企画段階で1回だけ
 * 詳細分析し、全カットで使い回す「一貫性の核」。Fashion Photo GPT 級の詳細さで
 * シルエット・色 (光が当たる部分/影の部分の色変化まで)・素材の質感・各パーツの
 * 構造・全体のムードを言語化する。これを各カットのプロンプトに注入することで、
 * 裏側で毎カット LLM 再設計せずとも一貫性が保たれる (NOCTURNE のキービジュアル固定と同思想)。
 */
export type LookAnalysis = {
  /** 被写体/キャラの正体 (例: "レトロな機械式カウンターの奥に座る小柄なヒューマノイド型キャラクター") */
  subjectIdentity: string;
  /** シルエット・体型・全体フォルム */
  silhouette: string;
  /** 色 (光が当たる部分/影の部分の色変化を含む。例: "ややくすんだ消防服レッド。肩や袖山はオレンジ寄り、影部はレンガ色に沈む") */
  colorProfile: string;
  /** 素材・質感 (例: "中厚のコットンツイル。光が強く跳ねる頭部のグロス塗装と対比") */
  material: string;
  /** 各パーツの構造 (頭部/顔/手/服の特徴など、一貫させるべき固有ディテール) */
  keyParts: string[];
  /** 絶対に維持すべき同一性要素 (identity anchor。これがブレると別人になる) */
  identityAnchors: string[];
  /** 全体のムード・世界観 (例: "赤と銅の密室的な世界。制御された熱、孤独な職務") */
  mood: string;
  /** 分析元の参照画像パス */
  sourceImagePath: string;
};

export type SceneConstruction = {
  total_cuts: number;
  /**
   * 2026-06-06: ルック分析を企画段階で詰めて持つ。
   * これがあれば裏側の build_structured_prompt (毎カット LLM 設計) をスキップできる。
   */
  look_analysis?: LookAnalysis;
  cuts: Array<{
    cut_id: string;
    description: string;
    duration_seconds: number;
    // === 演出を企画段階で前出しする (2026-06-06 STΛCK 指示) ===
    // これらが埋まっていれば、裏側 build_structured_prompt の LLM 呼び出し
    // (120秒×カット数) を全廃し、企画で決まったプロンプトをそのまま画像生成へ投げる。
    /** カットの役割 (establishing/action/detail/reaction/climax/resolution) */
    cut_role?: string;
    /** ショットサイズ (extreme_close/close/medium/full/wide/extreme_wide) */
    shot_type?: string;
    /** カメラアングル (front/side/three_quarter/high/low/dutch 等) */
    camera_angle?: string;
    /** このカットの動き・アクションを表す動詞群 */
    action_verbs?: string[];
    /** カメラの動き (static/pan/tilt/dolly/handheld) */
    camera_motion?: string;
    /** 維持すべき要素 (前カットから継承) */
    must_keep?: string[];
    /** 変化させる要素 (このカットで動かす) */
    must_change?: string[];
    /** 避けるべき制約 (identity崩れ・背景の不自然な変化など) */
    negative_constraints?: string[];
  }>;
};

/**
 * 同時生成枚数 (1 カットあたりの take 数)。
 * P10 (2026-05-20): 1 / 2 / 3 から選べるよう拡張 (旧 1 | 3 固定から)。
 */
export type CandidatesPerCut = 1 | 2 | 3;

export type StoryboardRunParams = {
  runId?: string;
  storyPrompt: string;
  characterReferenceImage: string;
  styleReferenceImage?: string;
  /**
   * FB#3 (2026-06-06): 複数キャラ参照 (登場キャラ全員)。後方互換のため
   * characterReferenceImage (単数, 先頭キャラ) は残す。Rust 側 storyboard_run が
   * この配列を受け取り、build_reference_images で全キャラ参照を画像生成に渡す。
   * (Rust 側の対応は別途。配列が無ければ従来通り単数で動く)
   */
  characterReferenceImages?: string[];
  styleReferenceImages?: string[];
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
  /**
   * FB#3 (2026-06-06): 複数キャラ参照 / 複数スタイル参照。
   * 後方互換のため characterReferencePath (単数, 先頭) は残す。
   * 本生成時に全参照を Rust 側へ渡す。
   */
  characterReferencePaths?: string[];
  styleReferencePaths?: string[];
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
  /**
   * P19b (2026-05-21 STΛCK指示): ユーザーが「絵コンテを確定」を押した後 true になる。
   * Phase 3 (本生成) はこの flag が true の sketchVersion からのみ参照画像を取り出す。
   * これで「絵コンテ生成中のまま本生成に絵コンテ画像が流れ込む」現象を防ぐ。
   */
  confirmed?: boolean;
  confirmedAt?: number;
};
