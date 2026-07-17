//! Rust-side orchestrator for GORI storyboard generation.
//!
//! The `gori-storyboard` skill files are used as prompt/reference material only.
//! Progress events are owned and emitted by Rust on `codex://storyboard`.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_STORYBOARD;
use crate::state::{AppState, CheckpointAction};

// 120秒では実運用でタイムアウトした (2026-07-09 STΛCK報告、codex_vision と同型)。
// プロンプト生成は絵コンテ生成の前段で、ここが落ちると生成全体が巻き添えになるため 300 秒にする。
const PROMPT_TIMEOUT_SECS: u64 = 300;
const GENERATION_TIMEOUT_SECS: u64 = 900;
const STORYBOARD_MODEL: &str = "gpt-5.6-sol";
const STORYBOARD_EFFORT: &str = "low";

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardParams {
    pub story_prompt: String,
    pub character_reference_image: String,
    pub style_reference_image: Option<String>,
    /// FB#3 (2026-06-06): 複数キャラ参照 (登場キャラ全員) / 複数スタイル参照。
    /// 配列が非空ならそれを優先し、全キャラ参照を画像生成に渡す。
    /// 空 or 未指定なら単数 character_reference_image にフォールバック (後方互換)。
    #[serde(default)]
    pub character_reference_images: Vec<String>,
    #[serde(default)]
    pub style_reference_images: Vec<String>,
    pub aspect_ratio: String,
    pub duration_seconds: f64,
    pub tempo: String,
    pub candidates_per_cut: u32,
    pub cwd: Option<String>,
    #[serde(default)]
    pub scene_construction: Option<Value>,
    /**
     * 絵コンテ (storyboard panel) 生成モード。
     * true のとき: 1 candidate に固定 + 評価スキップ + プロンプト末尾に
     * 「rough pencil sketch, monochrome, hand-drawn」等のスケッチ強制スタイルを差し込む。
     * 本番カットと明確に違うルックで「これは絵コンテ」と分かる出力を得る。
     */
    #[serde(default)]
    pub sketch_mode: bool,

    /**
     * 手動採用モード (P2 STΛCK指示 2026-05-20)。
     * true のとき:
     *   - AI 評価ループ (evaluate_one_take + select_best_take) を完全にスキップ
     *   - 全 take を TakeCompleted イベントで流す
     *   - CutConfirmed は出さず、ユーザー側のフロントから `storyboard_adopt_take` を
     *     受け取って次カット起動する設計に切り替える (Phase 2.5 で実装)
     *   - 本実装 (P2) では「全 take 流すまでで止まる」最小版を提供
     */
    #[serde(default)]
    pub manual_selection: bool,

    /**
     * P12 (2026-05-20 STΛCK 指示): 絵コンテ画像を本生成の追加参照として渡す。
     * cutId → imagePath のマップ。本番 run (sketch_mode=false) 時に、各カットの
     * 構図を絵コンテ画像で誘導するために使用。
     */
    #[serde(default)]
    pub sketch_references: std::collections::HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBundle {
    pub identity: f64,
    pub outfit: f64,
    pub prop: f64,
    pub face: f64,
    pub hand: f64,
    pub background: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneGroup {
    pub id: String,
    pub cut_ids: Vec<String>,
    /// P18b: シーンの狙い (1文)。各カットの構造化プロンプトに含める。
    #[serde(default)]
    pub intent: Option<String>,
    /// P18b: シーンの大ロケーション (例: "abandoned church nave")。
    #[serde(default)]
    pub primary_location: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum StoryboardEvent {
    Started {
        run_id: String,
        total_cuts: u32,
        scene_groups: Vec<SceneGroup>,
    },
    CutStarted {
        cut_id: String,
        scene_group_id: String,
        take_count: u32,
    },
    TakeCompleted {
        cut_id: String,
        take_id: String,
        image_path: String,
        scores: ScoreBundle,
    },
    CutCheckpoint {
        cut_id: String,
        reason: String,
    },
    CutConfirmed {
        cut_id: String,
        selected_take_id: String,
    },
    CutFailed {
        cut_id: String,
        reason: String,
    },
    Completed {
        run_id: String,
        manifest_path: String,
    },
}

#[derive(Clone)]
struct SkillRefs {
    skill_md: String,
    prompt_builder: String,
    verb_dictionary: String,
    scene_grouping: String,
    evaluator_rubric: String,
    film_grammar: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CutPlan {
    cut_id: String,
    scene_group_id: String,
    description: String,
    duration_seconds: f64,
    /// 2026-06-06: 企画タブで前出しした演出情報。Some のとき、本生成は裏側の
    /// build_structured_prompt (毎カット LLM 設計・120秒×カット数) をスキップし、
    /// この情報からローカルで構造化プロンプトを組み立てて即生成する。
    /// None のとき従来どおり (後方互換: 旧い企画データや手入力 story_prompt 経由)。
    prefilled: Option<PrefilledDirection>,
}

/// 企画タブで前出しされたカットの演出指示 (2026-06-06 STΛCK 指示)。
/// SceneConstruction.cuts[] の演出フィールドをそのまま運ぶ。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrefilledDirection {
    cut_role: Option<String>,
    shot_type: Option<String>,
    camera_angle: Option<String>,
    action_verbs: Vec<String>,
    camera_motion: Option<String>,
    must_keep: Vec<String>,
    must_change: Vec<String>,
    negative_constraints: Vec<String>,
}

// =============================================================
// P15 (2026-05-20): Continuity Contract / Cut Visual Plan
// =============================================================
// 設計参照:
//   _work/storyboard-v2/codex-session-2.md
//
// 業界知見の出典:
//   - Walter Murch "Rule of Six" (emotion>story>rhythm>eye_trace>plane_2d>space_3d)
//   - Pixar Story Reel
//   - 宮崎駿 画コンテ / 新海誠 演出
//   - Runway Image-to-Video Prompting Guide
//   - TikTok Creative Best Practices
//
// 核心: 「前カットの属性をそのまま渡す」のではなく、
//       「何を保つ・変える・禁ずるか」を契約として渡す。
//       これで AI が前カットを真似に行くことを防ぐ。

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ShotSize {
    ExtremeWide,
    Wide,
    Medium,
    CloseUp,
    ExtremeCloseUp,
}

impl ShotSize {
    fn as_str(&self) -> &'static str {
        match self {
            ShotSize::ExtremeWide => "EWS",
            ShotSize::Wide => "WS",
            ShotSize::Medium => "MS",
            ShotSize::CloseUp => "CU",
            ShotSize::ExtremeCloseUp => "ECU",
        }
    }

    /// 0=EWS .. 4=ECU の段階値。隣接 shot の距離計算に使う。
    fn level(&self) -> i8 {
        match self {
            ShotSize::ExtremeWide => 0,
            ShotSize::Wide => 1,
            ShotSize::Medium => 2,
            ShotSize::CloseUp => 3,
            ShotSize::ExtremeCloseUp => 4,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ScreenDirection {
    LeftToRight,
    RightToLeft,
    TowardCamera,
    AwayFromCamera,
    Static,
}

/// P17a (2026-05-21 STΛCK指示): カメラアングルを機械的に多様化する。
/// STΛCK 体感「アングルがほぼ全部 eye-level、ノペッとした動画になる」への対応。
/// Codex セッション2 のC マトリクスに「カメラアングル軸」を追加した形。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CameraAngle {
    EyeLevel,      // 目線、共感
    High,          // 俯瞰、被写体を弱く見せる
    Low,           // 煽り、被写体を強く見せる
    Dutch,         // 傾き、不安/狂気
    BirdsEye,      // 真上から、神視点
    OverShoulder,  // 肩越し、対話/緊張
    Pov,           // 主観視点、没入
    ThreeQuarter,  // 斜め45度、自然
}

impl CameraAngle {
    fn as_str(&self) -> &'static str {
        match self {
            CameraAngle::EyeLevel => "eye_level",
            CameraAngle::High => "high_angle",
            CameraAngle::Low => "low_angle",
            CameraAngle::Dutch => "dutch_angle",
            CameraAngle::BirdsEye => "birds_eye",
            CameraAngle::OverShoulder => "over_shoulder",
            CameraAngle::Pov => "pov_subjective",
            CameraAngle::ThreeQuarter => "three_quarter",
        }
    }

    /// 自然言語の指示文。AI への構造化プロンプトで使う。
    fn directive(&self) -> &'static str {
        match self {
            CameraAngle::EyeLevel => "shot at character eye-level for direct empathy",
            CameraAngle::High => "high-angle looking down, making subject appear vulnerable or small",
            CameraAngle::Low => "low-angle looking up, making subject appear powerful or imposing",
            CameraAngle::Dutch => "dutch tilt (canted angle, ~10-15deg) to convey unease",
            CameraAngle::BirdsEye => "bird's-eye top-down view, near 90deg overhead",
            CameraAngle::OverShoulder => "over-the-shoulder framing of another presence in foreground",
            CameraAngle::Pov => "first-person POV through the character's eyes",
            CameraAngle::ThreeQuarter => "three-quarter angle, ~45deg around the subject",
        }
    }
}

impl ScreenDirection {
    fn as_str(&self) -> &'static str {
        match self {
            ScreenDirection::LeftToRight => "left_to_right",
            ScreenDirection::RightToLeft => "right_to_left",
            ScreenDirection::TowardCamera => "toward_camera",
            ScreenDirection::AwayFromCamera => "away_from_camera",
            ScreenDirection::Static => "static",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CutVisualPlan {
    cut_id: String,
    scene_group_id: String,
    cut_role: String,        // establishing / action / detail / reaction / climax / resolution
    shot_size: ShotSize,
    camera_angle: CameraAngle, // P17a: カメラアングル軸
    screen_direction: ScreenDirection,
    camera_side: String,     // "axis_left" / "axis_right" / "neutral"
    subject_position: String, // "left_third" / "center" / "right_third" / ...
    action_start: String,    // 動作の開始姿勢 (i2v 用)
    action_end: String,      // 動作の終了姿勢 (i2v 用、次カットの action_start に接続)
    emotional_intent: String, // 感情・狙い
    micro_location: String,   // P17b: 同じ大ロケーション内の微小な場所 (nave/altar/pew等)
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ContinuityContract {
    /// preserve: 前カットから引き継ぐべき要素
    preserve: Vec<String>,
    /// change: 今カットで意図的に変えるべき要素
    change: Vec<String>,
    /// forbidden: 絶対やってはいけない変化
    forbidden: Vec<String>,
    /// bridge: 動作の接続点 (i2v 用)
    bridge: Vec<String>,
}

/// Murch の 6 基準による重み付け。プロンプトに含める。
/// emotion 51% / story 23% / rhythm 10% / eye_trace 7% / plane_2d 5% / space_3d 4%
fn murch_priority_text() -> &'static str {
    "Walter Murch Rule of Six priority weights — emotion:51, story:23, rhythm:10, eye_trace:7, plane_2d:5, space_3d:4. \
     Prioritize emotional and narrative continuity over spatial continuity when they conflict."
}

#[derive(Clone, Debug)]
struct EvaluatedTake {
    take_id: String,
    image_path: PathBuf,
    scores: ScoreBundle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    run_id: String,
    story_prompt: String,
    aspect_ratio: String,
    duration_seconds: f64,
    tempo: String,
    total_cuts: u32,
    candidates_per_cut: u32,
    character_reference_path: String,
    style_reference_path: String,
    created_at: u64,
    cuts: Vec<ManifestCut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCut {
    cut_id: String,
    scene_group_id: String,
    description: String,
    duration_seconds: f64,
    takes: Vec<ManifestTake>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTake {
    take_id: String,
    image_path: String,
    scores: ScoreBundle,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugLog {
    run_id: String,
    prompts: Vec<DebugPromptEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugPromptEntry {
    cut_id: String,
    structured_prompt: Value,
}

#[derive(Deserialize)]
struct SceneConstructionSnake {
    #[serde(default, alias = "totalCuts")]
    total_cuts: Option<u32>,
    #[serde(default)]
    cuts: Vec<SceneConstructionCutSnake>,
}

#[derive(Deserialize)]
struct SceneConstructionCutSnake {
    #[serde(default, alias = "cutId")]
    cut_id: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, alias = "durationSeconds")]
    duration_seconds: Option<f64>,
    #[serde(default, alias = "sceneGroupId")]
    scene_group_id: Option<String>,
    // === 演出前出しフィールド (2026-06-06 STΛCK 指示) ===
    #[serde(default, alias = "cutRole")]
    cut_role: Option<String>,
    #[serde(default, alias = "shotType")]
    shot_type: Option<String>,
    #[serde(default, alias = "cameraAngle")]
    camera_angle: Option<String>,
    #[serde(default, alias = "actionVerbs")]
    action_verbs: Option<Vec<String>>,
    #[serde(default, alias = "cameraMotion")]
    camera_motion: Option<String>,
    #[serde(default, alias = "mustKeep")]
    must_keep: Option<Vec<String>>,
    #[serde(default, alias = "mustChange")]
    must_change: Option<Vec<String>>,
    #[serde(default, alias = "negativeConstraints")]
    negative_constraints: Option<Vec<String>>,
}

/// P2.5 (2026-05-20): ユーザー採用 take を永続化する。
///
/// 設計:
///   manifest.json は run 完了時に一度書かれるだけで Deserialize 型が定義
///   されていない。adoption をサイドカー JSON (adoptions.json) として別管理
///   にして、`storyboard_persist_adoption` で書き込み、
///   `storyboard_read_adoptions` で起動時に読み込む。
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AdoptionsSidecar {
    run_id: String,
    /// cutId → takeId
    adoptions: std::collections::BTreeMap<String, String>,
}

fn adoptions_sidecar_path(run_id: &str) -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    let out_dir = resolve_output_dir(&settings, None, &format!("gori-storyboard-{run_id}"));
    Ok(out_dir.join("adoptions.json"))
}

#[tauri::command]
pub async fn storyboard_persist_adoption(
    run_id: String,
    cut_id: String,
    take_id: String,
) -> Result<(), String> {
    let path = adoptions_sidecar_path(&run_id)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("adoptions ディレクトリ作成失敗: {e}"))?;
    }

    let mut sidecar: AdoptionsSidecar = match tokio::fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => AdoptionsSidecar::default(),
    };
    sidecar.run_id = run_id;
    sidecar.adoptions.insert(cut_id, take_id);

    let json = serde_json::to_string_pretty(&sidecar)
        .map_err(|e| format!("adoptions JSON serialize 失敗: {e}"))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("adoptions.json 書き込み失敗: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn storyboard_read_adoptions(
    run_id: String,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let path = adoptions_sidecar_path(&run_id)?;
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return Ok(Default::default()),
    };
    let sidecar: AdoptionsSidecar = serde_json::from_str(&raw)
        .map_err(|e| format!("adoptions.json parse 失敗: {e}"))?;
    Ok(sidecar.adoptions)
}

/// Read the debug-log.json for a given run id.
/// Returns the JSON content as a string so the UI can pretty-print it.
/// Used by the "デバッグログ表示" panel to show structured prompts after a run completes.
#[tauri::command]
pub async fn storyboard_read_debug_log(run_id: String) -> Result<String, String> {
    let leaf = format!("gori-storyboard-{run_id}");
    let settings = StorageSettings::load()?;
    let path = find_storyboard_file(&settings, &leaf, "debug-log.json")
        .or_else(|| {
            // FB#19: 生成画像と同じく GORI 専用 CODEX_HOME/generated_images を見る。
            crate::images::watcher::generated_images_dir()
                .map(|base| base.join(&leaf).join("debug-log.json"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            // 旧 ~/.codex/generated_images に残る過去ランの debug-log も後方互換で見る。
            crate::images::watcher::legacy_generated_images_dir()
                .map(|base| base.join(&leaf).join("debug-log.json"))
                .filter(|path| path.is_file())
        })
        .ok_or_else(|| format!("debug-log.json が見つかりません: {leaf}"))?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("debug-log.json 読み込み失敗 ({}): {e}", path.display()))
}

#[tauri::command]
pub async fn storyboard_run(
    app: AppHandle,
    state: State<'_, AppState>,
    params: StoryboardParams,
) -> Result<String, String> {
    // FB#19: app-server と同じ GORI 専用 CODEX_HOME を使う。worker は
    // mirror_codex_home でこの HOME から auth/config/skills を一時 HOME に複製する。
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let skill_dir = codex_home_orig.join("skills").join("gori-storyboard");
    if !skill_dir.exists() {
        return Err(format!(
            "gori-storyboard スキルが見つかりません: {}",
            skill_dir.display()
        ));
    }

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    let run_id = format!("{}-{}", timestamp_id(), short_id());
    let task_run_id = run_id.clone();
    // AppState は Arc ベースなので clone は共有ハンドル。checkpoint シグナルを
    // spawn した orchestrator と `storyboard_checkpoint_resume` の両方から触る。
    let task_state = state.inner_clone();

    tokio::spawn(async move {
        // checkpoint シグナルがリークしないよう、orchestrator の成否に関わらず
        // 終了時に必ず clear する。early return / panic 相当のエラーでも
        // この後の clear_checkpoint が走る。
        let result = run_storyboard_orchestrator(
            app.clone(),
            task_state.clone(),
            codex_bin,
            codex_home_orig,
            task_run_id.clone(),
            params,
        )
        .await;
        task_state.clear_checkpoint(&task_run_id).await;
        if let Err(err) = result {
            tracing::warn!(target: "codex.storyboard", "storyboard orchestrator failed: {err}");
            let _ = app.emit(
                EVENT_STORYBOARD,
                StoryboardEvent::CutFailed {
                    cut_id: "unknown".into(),
                    reason: err,
                },
            );
        }
    });

    Ok(run_id)
}

/// storyboard の方向性チェック (checkpoint) から生成ループを再開/中断する (A-2)。
/// フロントの StoryboardCheckpointDialog の「このまま続ける」/「中止」から呼ぶ。
/// - action="continue": 残りカットの生成を続行する
/// - action="cancel": 生成を安全に中断する (生成済みカットは保持される)
/// 対象 run が checkpoint で待機していない場合 (既に再開済み等) は false を返す。
#[tauri::command]
pub async fn storyboard_checkpoint_resume(
    state: State<'_, AppState>,
    run_id: String,
    action: String,
) -> Result<bool, String> {
    let parsed = match action.as_str() {
        "continue" => CheckpointAction::Continue,
        "cancel" => CheckpointAction::Cancel,
        other => return Err(format!("未知の checkpoint アクション: {other}")),
    };
    Ok(state.resume_checkpoint(&run_id, parsed).await)
}

/// 単一カット再生成 (P4 STΛCK 指示 2026-05-20)。
/// 既存 run で生成済みのカットを、追加参照画像を投げて再度 1 take 生成する。
///
/// 流れ:
///  1. フロントから cut_id + additional_refs (ユーザー投入画像) を受ける
///  2. 既存 generate_one_take を 1 回だけ呼ぶ (sketch_mode=false, manual_selection=true 扱い)
///  3. TakeCompleted を既存 EVENT_STORYBOARD で発火 → フロントは既存ストアで自動的に take 追加扱い
///  4. 評価ループはスキップ (ユーザー手動採用に委ねる)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerateCutParams {
    pub run_id: String,
    pub cut_id: String,
    pub character_reference_image: String,
    #[serde(default)]
    pub style_reference_image: Option<String>,
    #[serde(default)]
    pub additional_refs: Vec<String>,
    /// optional intent text。指定があれば structured_prompt 末尾に「USER_DIRECTIVE: ...」で差し込む。
    #[serde(default)]
    pub prompt_override: Option<String>,
    pub aspect_ratio: String,
    /// 直前確定カット画像 (前後文脈用)。フロントが既知なら渡す。
    #[serde(default)]
    pub previous_cut_image: Option<String>,
    /// 再生成対象カットの description (structured_prompt 構築用)
    pub cut_description: String,
    #[serde(default = "default_duration")]
    pub cut_duration_seconds: f64,
    #[serde(default)]
    pub sketch_mode: bool,
}

fn default_duration() -> f64 {
    2.0
}

#[tauri::command]
pub async fn storyboard_regenerate_cut(
    app: AppHandle,
    _state: State<'_, AppState>,
    params: RegenerateCutParams,
) -> Result<String, String> {
    // FB#19: app-server と同じ GORI 専用 CODEX_HOME を使う (regenerate も同様)。
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;

    let storage_settings = StorageSettings::load()?;
    let out_dir = resolve_output_dir(
        &storage_settings,
        None,
        &format!("gori-storyboard-{}", params.run_id),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("storyboard 出力先作成失敗: {e}"))?;

    let take_id = format!("re_{}", short_id());
    let task_app = app.clone();
    let task_cut_id = params.cut_id.clone();
    let task_take_id = take_id.clone();

    tokio::spawn(async move {
        // 参照画像配列を構築:
        //  1. character_reference_image (任意。無ければテキストのみ生成)
        //  2. style_reference_image (任意)
        //  3. previous_cut_image (任意・前後文脈)
        //  4. additional_refs (ユーザー投入の追加参照、複数可)
        // character も style/prev と同じく「あれば入れる」に統一 (2026-06-08 参照任意化)。
        let mut reference_images: Vec<PathBuf> = Vec::new();
        if !params.character_reference_image.trim().is_empty() {
            reference_images.push(PathBuf::from(&params.character_reference_image));
        }
        if let Some(style) = params.style_reference_image.as_ref() {
            if !style.trim().is_empty() {
                reference_images.push(PathBuf::from(style));
            }
        }
        if let Some(prev) = params.previous_cut_image.as_ref() {
            if !prev.trim().is_empty() {
                reference_images.push(PathBuf::from(prev));
            }
        }
        for r in &params.additional_refs {
            if !r.trim().is_empty() {
                reference_images.push(PathBuf::from(r));
            }
        }

        // 簡易な structured_prompt を組み立てる (フル plan_cuts は走らない)
        let mut prompt_obj = serde_json::json!({
            "cut_id": params.cut_id,
            "description": params.cut_description,
            "duration_seconds": params.cut_duration_seconds,
            "aspect_ratio": params.aspect_ratio,
            "user_directive": params.prompt_override.clone().unwrap_or_default(),
            "additional_references_count": params.additional_refs.len(),
        });
        // user_directive が空文字なら除去 (LLM 混乱回避)
        if params.prompt_override.is_none()
            || params.prompt_override.as_deref().unwrap_or("").trim().is_empty()
        {
            if let Some(map) = prompt_obj.as_object_mut() {
                map.remove("user_directive");
            }
        }

        let generated = generate_one_take(
            &codex_bin,
            &codex_home_orig,
            &prompt_obj,
            &reference_images,
            &out_dir,
            &params.cut_id,
            &task_take_id,
            1,
            1,
            None,
            &params.aspect_ratio,
            params.sketch_mode,
        )
        .await;

        match generated {
            Ok((tid, image_path)) => {
                let image_path_string = image_path.to_string_lossy().into_owned();
                let _ = task_app.emit(
                    EVENT_STORYBOARD,
                    StoryboardEvent::TakeCompleted {
                        cut_id: task_cut_id,
                        take_id: tid,
                        image_path: image_path_string,
                        scores: ScoreBundle::default(),
                    },
                );
            }
            Err(err) => {
                tracing::warn!(target: "codex.storyboard", "regenerate_cut failed: {err}");
                let _ = task_app.emit(
                    EVENT_STORYBOARD,
                    StoryboardEvent::CutFailed {
                        cut_id: task_cut_id,
                        reason: err,
                    },
                );
            }
        }
    });

    Ok(take_id)
}

async fn run_storyboard_orchestrator(
    app: AppHandle,
    state: AppState,
    codex_bin: PathBuf,
    codex_home_orig: PathBuf,
    run_id: String,
    params: StoryboardParams,
) -> Result<(), String> {
    validate_params(&params)?;

    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(params.cwd.as_deref());
    let out_dir = resolve_output_dir(
        &storage_settings,
        project_name.as_deref(),
        &format!("gori-storyboard-{run_id}"),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("storyboard 出力先作成失敗: {e}"))?;

    let skill_refs = read_skill_refs().await?;

    // 2026-06-06: 企画タブのルック分析を取り出す (look_analysis / lookAnalysis)。
    // 全カットの構造化プロンプトに注入する一貫性アンカー。
    let look_analysis: Option<Value> = params.scene_construction.as_ref().and_then(|sc| {
        sc.get("look_analysis")
            .or_else(|| sc.get("lookAnalysis"))
            .cloned()
    });

    // 企画タブで scene_construction (カット割り) が来ていれば、plan_cuts (LLM で
    // カット割りを再生成・120秒) をスキップして企画データをそのまま使う。
    // 来ていなければ従来どおり plan_cuts → local フォールバック。
    let mut cuts = if let Some(sc) = params.scene_construction.as_ref() {
        match plan_from_scene_construction(&params, sc) {
            Ok(planned) if !planned.is_empty() => {
                tracing::info!(
                    target: "codex.storyboard",
                    "scene_construction からカット割りを使用 (plan_cuts LLM をスキップ)"
                );
                planned
            }
            _ => plan_cuts(&codex_bin, &params, &skill_refs)
                .await
                .unwrap_or_else(|err| {
                    tracing::warn!(target: "codex.storyboard", "scene planning fallback: {err}");
                    local_cut_plan(&params)
                }),
        }
    } else {
        plan_cuts(&codex_bin, &params, &skill_refs)
            .await
            .unwrap_or_else(|err| {
                tracing::warn!(target: "codex.storyboard", "scene planning fallback: {err}");
                local_cut_plan(&params)
            })
    };
    if cuts.is_empty() {
        cuts = local_cut_plan(&params);
    }
    let mut scene_groups = build_scene_groups(&cuts);
    // P18b: AI が scene_construction.scene_groups を返している場合、intent / primary_location を取り込む
    if let Some(scene_construction) = params.scene_construction.as_ref() {
        if let Some(ai_groups) = scene_construction.get("sceneGroups").and_then(|v| v.as_array())
            .or_else(|| scene_construction.get("scene_groups").and_then(|v| v.as_array()))
        {
            for ai_group in ai_groups {
                let id_str = ai_group
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if id_str.is_empty() {
                    continue;
                }
                let intent_str = ai_group
                    .get("intent")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let location_str = ai_group
                    .get("primaryLocation")
                    .or_else(|| ai_group.get("primary_location"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(existing) = scene_groups.iter_mut().find(|g| g.id == id_str) {
                    if existing.intent.is_none() {
                        existing.intent = intent_str.clone();
                    }
                    if existing.primary_location.is_none() {
                        existing.primary_location = location_str.clone();
                    }
                }
            }
        }
    }
    let total_cuts = cuts.len() as u32;
    let candidates_per_cut = normalize_candidates(params.candidates_per_cut);
    let style_ref = params
        .style_reference_image
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| params.character_reference_image.clone());

    let _ = app.emit(
        EVENT_STORYBOARD,
        StoryboardEvent::Started {
            run_id: run_id.clone(),
            total_cuts,
            scene_groups: scene_groups.clone(),
        },
    );

    let char_ref_path = PathBuf::from(&params.character_reference_image);
    let style_ref_path = PathBuf::from(&style_ref);
    // FB#3 (2026-06-06): 複数キャラ参照 (登場キャラ全員) / 複数スタイル参照。
    // 配列から先頭 (= 単数フィールドと同じ) を除いた残りを「追加参照」として渡す。
    let extra_char_refs: Vec<PathBuf> = params
        .character_reference_images
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p != &char_ref_path)
        .collect();
    let extra_style_refs: Vec<PathBuf> = params
        .style_reference_images
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p != &style_ref_path)
        .collect();
    let mut previous_cut_image: Option<PathBuf> = None;
    let mut manifest_cuts: Vec<ManifestCut> = Vec::new();
    let mut debug_prompts: Vec<DebugPromptEntry> = Vec::new();
    let mut previous_shot_types: Vec<String> = Vec::new();
    let mut aborted = false;
    let cuts_count = cuts.len();

    // P15 (2026-05-20): 全カットの VisualPlan を事前に算出する。
    // これにより隣接カットの shot_size / screen_direction / camera_side が
    // 機械的に整合する。
    // P17a/b/c (2026-05-21): camera_angle 多様化 + micro_location 遷移 + POV/OTS 強制投入も同関数内で実施。
    let visual_plans = plan_visual_continuity(&cuts);

    // P17d: 違反 warn ログ。自動修正は plan_visual_continuity で完了済み。
    for w in validate_neighbor_plans(&visual_plans) {
        tracing::warn!(target: "codex.storyboard", "[continuity] {}", w);
    }

    for (cut_index, cut) in cuts.iter().enumerate() {
        let _ = app.emit(
            EVENT_STORYBOARD,
            StoryboardEvent::CutStarted {
                cut_id: cut.cut_id.clone(),
                scene_group_id: cut.scene_group_id.clone(),
                take_count: candidates_per_cut,
            },
        );

        // === 2026-06-06 STΛCK 指示: 企画タブで演出を前出ししてあれば、裏側の
        //     build_structured_prompt (Codex 呼び出し 120秒/カット) を全廃し、
        //     企画で決まったプロンプトをそのまま組み立てて即生成する。
        //     prefilled が無い旧データ/手入力時のみ、従来の裏側設計にフォールバック。
        let mut structured_prompt = if cut.prefilled.is_some() {
            tracing::info!(
                target: "codex.storyboard",
                "{}: prefilled direction を使用 (裏側 LLM 設計をスキップ)",
                cut.cut_id
            );
            prefilled_structured_prompt(
                &params,
                cut,
                previous_cut_image.as_deref(),
                &previous_shot_types,
                look_analysis.as_ref(),
            )
        } else {
            build_structured_prompt(
                &codex_bin,
                &params,
                &skill_refs,
                cut,
                previous_cut_image.as_deref(),
                cut_index,
                cuts_count,
                &previous_shot_types,
            )
            .await
            .unwrap_or_else(|err| {
                tracing::warn!(target: "codex.storyboard", "structured prompt fallback for {}: {err}", cut.cut_id);
                local_structured_prompt(&params, cut, previous_cut_image.as_deref(), &previous_shot_types)
            })
        };

        // P15 (2026-05-20): Continuity Contract と Murch priority を
        // structured_prompt に差し込む。
        // ※ sketch_mode (絵コンテ生成) では Contract をスキップ
        //    (絵コンテはラフスケッチなので連動性ルールは緩める)
        if !params.sketch_mode {
            if let Some(curr_plan) = visual_plans.get(cut_index) {
                let prev_plan = if cut_index > 0 {
                    visual_plans.get(cut_index - 1)
                } else {
                    None
                };
                // P18c: 現カットの scene_group の intent / primary_location を取得して渡す
                let curr_scene_group = scene_groups
                    .iter()
                    .find(|g| g.id == curr_plan.scene_group_id);
                let scene_intent = curr_scene_group.and_then(|g| g.intent.as_deref());
                let scene_primary_location = curr_scene_group
                    .and_then(|g| g.primary_location.as_deref());
                let contract = build_continuity_contract(
                    prev_plan,
                    curr_plan,
                    scene_intent,
                    scene_primary_location,
                );
                if let Some(obj) = structured_prompt.as_object_mut() {
                    obj.insert(
                        "continuity_contract".to_string(),
                        serde_json::to_value(&contract).unwrap_or(Value::Null),
                    );
                    obj.insert(
                        "visual_plan".to_string(),
                        serde_json::json!({
                            "shot_size": curr_plan.shot_size.as_str(),
                            "camera_angle": curr_plan.camera_angle.as_str(),
                            "camera_angle_directive": curr_plan.camera_angle.directive(),
                            "screen_direction": curr_plan.screen_direction.as_str(),
                            "camera_side": curr_plan.camera_side,
                            "subject_position": curr_plan.subject_position,
                            "micro_location": curr_plan.micro_location,
                            "action_start": curr_plan.action_start,
                            "action_end": curr_plan.action_end,
                            "cut_role": curr_plan.cut_role,
                        }),
                    );
                    obj.insert(
                        "murch_priority".to_string(),
                        Value::String(murch_priority_text().to_string()),
                    );
                    // P16 (2026-05-20 STΛCK指示): 参照画像の役割を JSON 上でも明示。
                    // 絵コンテ画像が含まれている場合に、AI が「鉛筆スケッチ」を
                    // 絵柄として解釈しないよう、構図のみ参考にすることを強制。
                    let mut roles: Vec<serde_json::Value> = vec![
                        serde_json::json!({
                            "slot": 1,
                            "role": "character_reference",
                            "use_for": ["face", "body_proportions", "costume_details"],
                            "do_not_use_for": ["overall_style", "color_palette"]
                        }),
                        serde_json::json!({
                            "slot": 2,
                            "role": "style_reference",
                            "use_for": ["overall_look", "color_palette", "lighting", "texture"],
                            "do_not_use_for": ["character_identity"]
                        }),
                    ];
                    if previous_cut_image.is_some() {
                        roles.push(serde_json::json!({
                            "slot": 3,
                            "role": "previous_confirmed_cut",
                            "use_for": ["temporal_continuity", "screen_direction_check"],
                            "do_not_use_for": ["style_change", "character_change"]
                        }));
                    }
                    if params
                        .sketch_references
                        .get(&cut.cut_id)
                        .filter(|p| !p.trim().is_empty())
                        .is_some()
                    {
                        roles.push(serde_json::json!({
                            "slot": "last",
                            "role": "storyboard_sketch",
                            "use_for": [
                                "composition",
                                "camera_angle",
                                "character_position_in_frame",
                                "framing_intent"
                            ],
                            "do_not_use_for": [
                                "art_style",
                                "pencil_or_monochrome_look",
                                "low_fidelity_appearance",
                                "paper_texture"
                            ],
                            "note": "This is a pencil sketch storyboard panel. ONLY borrow composition and camera angle. The final output MUST be a photorealistic/colored frame, not a sketch."
                        }));
                    }
                    obj.insert(
                        "reference_image_roles".to_string(),
                        serde_json::Value::Array(roles),
                    );
                }
            }
        }
        debug_prompts.push(DebugPromptEntry {
            cut_id: cut.cut_id.clone(),
            structured_prompt: structured_prompt.clone(),
        });
        // Track this cut's shot_type for adjacent-diversity enforcement in the next iteration.
        if let Some(shot_type) = structured_prompt
            .get("framing")
            .and_then(|f| f.get("shot_type"))
            .and_then(|s| s.as_str())
        {
            previous_shot_types.push(shot_type.to_string());
        }

        let mut all_takes_for_manifest: Vec<ManifestTake> = Vec::new();
        let mut selected: Option<EvaluatedTake> = None;
        let mut last_failure = String::new();

        // === 2026-06-06 STΛCK 指示: AI 評価ループ + リトライを完全撤去 ===
        // 旧: for attempt in 0..=MAX_RETRIES_PER_CUT { 生成 → 評価 → しきい値未満なら再生成 }
        // 新: 指定枚数を1回だけ生成し、全 take をそのまま流す。1枚目を即採用、
        //     残りは候補として Phase 4 でユーザーが手動切替する。
        //     「後ろで採点して遅くする」より「先に出してダメなら手動で再生成」が良い UX。
        {
            // P12: cut_id に対応する絵コンテ画像があれば参考として追加
            let sketch_ref_pathbuf: Option<PathBuf> = params
                .sketch_references
                .get(&cut.cut_id)
                .filter(|p| !p.trim().is_empty())
                .map(PathBuf::from);
            let reference_images = build_reference_images(
                &char_ref_path,
                &extra_char_refs,
                &style_ref_path,
                &extra_style_refs,
                previous_cut_image.as_deref(),
                sketch_ref_pathbuf.as_deref(),
            );
            // ユーザー指定枚数 (candidates_per_cut) ぶんだけ生成する。
            let take_specs = (0..candidates_per_cut)
                .map(|idx| (take_label(idx), idx + 1))
                .collect::<Vec<_>>();

            let generated = generate_cut_takes(
                &app,
                &codex_bin,
                &codex_home_orig,
                &structured_prompt,
                &reference_images,
                &out_dir,
                &cut.cut_id,
                &take_specs,
                params.cwd.clone(),
                &params.aspect_ratio,
                params.sketch_mode,
            )
            .await;

            let mut evaluated_takes = Vec::new();
            for item in generated {
                match item {
                    Ok((take_id, image_path)) => {
                        // 評価は行わない (撤去済み)。全 take をデフォルトスコアで素通し。
                        let scores = ScoreBundle::default();
                        let image_path_string = image_path.to_string_lossy().into_owned();
                        all_takes_for_manifest.push(ManifestTake {
                            take_id: take_id.clone(),
                            image_path: image_path_string,
                            scores: scores.clone(),
                            status: "candidate".into(),
                        });
                        evaluated_takes.push(EvaluatedTake {
                            take_id,
                            image_path,
                            scores,
                        });
                    }
                    Err(err) => {
                        last_failure = err;
                    }
                }
            }

            // 評価なしで最初の take を即採用。残りは候補として Phase 4 でユーザーが切替。
            if let Some(best) = select_first_take(&evaluated_takes) {
                mark_manifest_take_status(&mut all_takes_for_manifest, &best.take_id, "confirmed");
                let _ = app.emit(
                    EVENT_STORYBOARD,
                    StoryboardEvent::CutConfirmed {
                        cut_id: cut.cut_id.clone(),
                        selected_take_id: best.take_id.clone(),
                    },
                );
                previous_cut_image = Some(best.image_path.clone());
                selected = Some(best);
            }
        }

        if selected.is_none() {
            let reason = if last_failure.trim().is_empty() {
                "このカットの画像生成に失敗しました".to_string()
            } else {
                format!("このカットの画像生成に失敗しました: {last_failure}")
            };
            let _ = app.emit(
                EVENT_STORYBOARD,
                StoryboardEvent::CutFailed {
                    cut_id: cut.cut_id.clone(),
                    reason,
                },
            );
            aborted = true;
            break;
        }

        manifest_cuts.push(ManifestCut {
            cut_id: cut.cut_id.clone(),
            scene_group_id: cut.scene_group_id.clone(),
            description: cut.description.clone(),
            duration_seconds: cut.duration_seconds,
            takes: all_takes_for_manifest,
        });

        // A-2 (2026-06 監査): 3カット目 (cut_index==2) 到達で「方向性チェック」を挟む。
        // 従来は emit するだけでループを止められず、残りカットを全部生成し続けていた
        // (フロントの paused は見せかけ)。ここで実際に await 停止し、フロントの
        // storyboard_checkpoint_resume が来るまで次カットに進まない。
        // 残りカットが無い (このカットが最後) 場合は止める意味が無いのでスキップ。
        let has_remaining = cut_index + 1 < cuts_count;
        if cut_index == 2 && has_remaining {
            // 先に受信端を登録してから emit する (フロントが即 resume を返しても
            // sender が登録済みで取りこぼさない)。
            let resume_rx = state.register_checkpoint(&run_id).await;
            let _ = app.emit(
                EVENT_STORYBOARD,
                StoryboardEvent::CutCheckpoint {
                    cut_id: cut.cut_id.clone(),
                    reason: "midRun review at cut 3".into(),
                },
            );
            // ユーザー判断待ちは無期限 (タイムアウト無し)。resume/cancel が来るか、
            // run 終了/アプリ終了で sender が drop される (Err) まで待つ。
            let action = match resume_rx.await {
                Ok(action) => action,
                // sender が drop された = run クリーンアップ (アプリ終了等)。
                // 安全側に倒して中断扱いにする (生成済みカットは保持)。
                Err(_) => CheckpointAction::Cancel,
            };
            match action {
                CheckpointAction::Continue => {
                    // 続行: 何もせず次カットへ。
                }
                CheckpointAction::Cancel => {
                    // 中断: 生成済みカットを保持したままループを抜ける。
                    // aborted にはしない (Completed を出さず、部分成果を残す)。
                    tracing::info!(
                        target: "codex.storyboard",
                        "storyboard run {run_id} cancelled at checkpoint (cut {cut_index})"
                    );
                    break;
                }
            }
        }
    }

    let debug_path = out_dir.join("debug-log.json");
    let debug = DebugLog {
        run_id: run_id.clone(),
        prompts: debug_prompts,
    };
    write_json_file(&debug_path, &debug).await?;

    let manifest_path = out_dir.join("manifest.json");
    let manifest = Manifest {
        run_id: run_id.clone(),
        story_prompt: params.story_prompt.clone(),
        aspect_ratio: params.aspect_ratio.clone(),
        duration_seconds: params.duration_seconds,
        tempo: params.tempo.clone(),
        total_cuts,
        candidates_per_cut,
        character_reference_path: params.character_reference_image.clone(),
        style_reference_path: style_ref,
        created_at: now_secs(),
        cuts: manifest_cuts,
    };
    write_json_file(&manifest_path, &manifest).await?;

    if !aborted && manifest.cuts.len() == total_cuts as usize {
        let _ = app.emit(
            EVENT_STORYBOARD,
            StoryboardEvent::Completed {
                run_id,
                manifest_path: manifest_path.to_string_lossy().into_owned(),
            },
        );
    }

    Ok(())
}

fn find_storyboard_file(
    settings: &StorageSettings,
    leaf: &str,
    file_name: &str,
) -> Option<PathBuf> {
    let root = PathBuf::from(&settings.storage_root);
    let direct = root.join(leaf).join(file_name);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let candidate = entry.path().join(leaf).join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn validate_params(params: &StoryboardParams) -> Result<(), String> {
    if params.story_prompt.trim().is_empty() {
        return Err("storyPrompt must not be empty".into());
    }
    // キャラクター参照画像は任意。無ければテキストのみで生成し、あれば参照する
    // (2026-06-08 STΛCK 指示: 「参照が無ければテキスト経由、来たら参照」が正しい仕様)。
    // 指定がある場合だけ実在チェックする (style_reference_image と同じ扱い)。
    if !params.character_reference_image.trim().is_empty()
        && !Path::new(&params.character_reference_image).is_file()
    {
        return Err(format!(
            "キャラクター参照画像が見つかりません: {}",
            params.character_reference_image
        ));
    }
    if let Some(style) = params
        .style_reference_image
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        if !Path::new(style).is_file() {
            return Err(format!("スタイル参照画像が見つかりません: {style}"));
        }
    }
    if params.duration_seconds <= 0.0 {
        return Err("durationSeconds must be > 0".into());
    }
    Ok(())
}

async fn read_skill_refs() -> Result<SkillRefs, String> {
    // FB#19: バンドルスキルは GORI 専用 CODEX_HOME/skills に展開されるので、ここも
    // 専用 HOME を参照する (旧 ~/.codex フォールバックつき)。
    let home = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "home dir not found".to_string())?;
    let skill_dir = home.join("skills/gori-storyboard");
    let refs_dir = skill_dir.join("references");
    Ok(SkillRefs {
        skill_md: tokio::fs::read_to_string(skill_dir.join("SKILL.md"))
            .await
            .map_err(|e| format!("SKILL.md 読み込み失敗: {e}"))?,
        prompt_builder: read_skill_reference(&refs_dir, "prompt-builder.md").await?,
        verb_dictionary: read_skill_reference(&refs_dir, "verb-dictionary.md").await?,
        scene_grouping: read_skill_reference(&refs_dir, "scene-grouping.md").await?,
        evaluator_rubric: read_skill_reference(&refs_dir, "evaluator-rubric.md").await?,
        film_grammar: read_skill_reference(&refs_dir, "film-grammar.md").await?,
    })
}

async fn read_skill_reference(refs_dir: &Path, name: &str) -> Result<String, String> {
    tokio::fs::read_to_string(refs_dir.join(name))
        .await
        .map_err(|e| format!("スキル参照読み込み失敗 ({name}): {e}"))
}

async fn plan_cuts(
    codex_bin: &Path,
    params: &StoryboardParams,
    refs: &SkillRefs,
) -> Result<Vec<CutPlan>, String> {
    if let Some(scene_construction) = params.scene_construction.as_ref() {
        let planned = plan_from_scene_construction(params, scene_construction)?;
        if !planned.is_empty() {
            return Ok(planned);
        }
    }

    let target_count = compute_cut_count(params.duration_seconds, &params.tempo);
    let prompt = format!(
        "You are the GORI Storyboard scene planner. Use these references.\n\n\
         ## SKILL.md\n{skill_md}\n\n\
         ## Scene Grouping\n{scene_grouping}\n\n\
         ## Task\n\
         Split the story into exactly {target_count} video storyboard cuts.\n\
         Story: {story}\n\
         Aspect ratio: {aspect}\n\
         Duration seconds: {duration}\n\
         Tempo: {tempo}\n\n\
         Return ONLY JSON with this shape, no markdown/prose:\n\
         {{\"cuts\":[{{\"cutId\":\"shot_001\",\"description\":\"...\",\"durationSeconds\":1.7,\"sceneGroupId\":\"morningHome\"}}],\"sceneGroups\":[{{\"id\":\"morningHome\",\"cutIds\":[\"shot_001\"]}}]}}",
        skill_md = refs.skill_md,
        scene_grouping = refs.scene_grouping,
        target_count = target_count,
        story = params.story_prompt,
        aspect = params.aspect_ratio,
        duration = params.duration_seconds,
        tempo = params.tempo,
    );
    let raw = codex_oneshot(
        codex_bin,
        &prompt,
        &[],
        PROMPT_TIMEOUT_SECS,
        params.cwd.as_deref(),
    )
    .await?;
    let json = extract_json_from_codex_stdout(&raw)?;
    let cuts_value = json
        .get("cuts")
        .ok_or_else(|| "scene planner JSON に cuts がありません".to_string())?;
    let cuts = cuts_value
        .as_array()
        .ok_or_else(|| "scene planner cuts が配列ではありません".to_string())?;
    let fallback_duration = params.duration_seconds / target_count.max(1) as f64;
    let mut planned = Vec::new();
    for (idx, value) in cuts.iter().enumerate() {
        let cut_id = value
            .get("cutId")
            .or_else(|| value.get("cut_id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("shot_{:03}", idx + 1));
        let scene_group_id = value
            .get("sceneGroupId")
            .or_else(|| value.get("scene_group_id"))
            .and_then(Value::as_str)
            .map(sanitize_group_id)
            .unwrap_or_else(|| {
                local_scene_group_id(
                    value
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )
            });
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or(&params.story_prompt)
            .to_string();
        let duration_seconds = value
            .get("durationSeconds")
            .or_else(|| value.get("duration_seconds"))
            .and_then(Value::as_f64)
            .unwrap_or(fallback_duration);
        planned.push(CutPlan {
            cut_id,
            scene_group_id,
            description,
            duration_seconds,
            prefilled: None,
        });
    }
    Ok(planned)
}

fn plan_from_scene_construction(
    params: &StoryboardParams,
    value: &Value,
) -> Result<Vec<CutPlan>, String> {
    let parsed: SceneConstructionSnake = serde_json::from_value(value.clone())
        .map_err(|e| format!("sceneConstruction parse failed: {e}"))?;
    let count = parsed
        .total_cuts
        .unwrap_or_else(|| parsed.cuts.len() as u32)
        .max(1);
    if parsed.cuts.is_empty() {
        return Ok(local_cut_plan_with_count(params, count));
    }
    let fallback_duration = params.duration_seconds / parsed.cuts.len().max(1) as f64;
    let mut last_group = String::from("mainScene");
    let mut planned = Vec::new();
    for (idx, cut) in parsed.cuts.iter().enumerate() {
        let description = cut
            .description
            .clone()
            .unwrap_or_else(|| format!("{} / beat {}", params.story_prompt, idx + 1));
        let scene_group_id = cut
            .scene_group_id
            .as_ref()
            .map(|s| sanitize_group_id(s))
            .unwrap_or_else(|| {
                let id = local_scene_group_id(&description);
                if id == "mainScene" && idx > 0 {
                    last_group.clone()
                } else {
                    id
                }
            });
        last_group = scene_group_id.clone();
        // 演出が1つでも前出しされていれば prefilled として束ねる。
        // 全部 None なら prefilled=None (従来どおり裏側設計にフォールバック)。
        let has_direction = cut.cut_role.is_some()
            || cut.shot_type.is_some()
            || cut.camera_angle.is_some()
            || cut.action_verbs.as_ref().is_some_and(|v| !v.is_empty())
            || cut.camera_motion.is_some()
            || cut.must_keep.as_ref().is_some_and(|v| !v.is_empty())
            || cut.must_change.as_ref().is_some_and(|v| !v.is_empty())
            || cut
                .negative_constraints
                .as_ref()
                .is_some_and(|v| !v.is_empty());
        let prefilled = if has_direction {
            Some(PrefilledDirection {
                cut_role: cut.cut_role.clone(),
                shot_type: cut.shot_type.clone(),
                camera_angle: cut.camera_angle.clone(),
                action_verbs: cut.action_verbs.clone().unwrap_or_default(),
                camera_motion: cut.camera_motion.clone(),
                must_keep: cut.must_keep.clone().unwrap_or_default(),
                must_change: cut.must_change.clone().unwrap_or_default(),
                negative_constraints: cut.negative_constraints.clone().unwrap_or_default(),
            })
        } else {
            None
        };
        planned.push(CutPlan {
            cut_id: cut
                .cut_id
                .clone()
                .unwrap_or_else(|| format!("shot_{:03}", idx + 1)),
            scene_group_id,
            description,
            duration_seconds: cut.duration_seconds.unwrap_or(fallback_duration),
            prefilled,
        });
    }
    Ok(planned)
}

async fn build_structured_prompt(
    codex_bin: &Path,
    params: &StoryboardParams,
    refs: &SkillRefs,
    cut: &CutPlan,
    previous_cut: Option<&Path>,
    cut_index: usize,
    total_cuts: usize,
    previous_shot_types: &[String],
) -> Result<Value, String> {
    let previous_state = previous_cut
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "none; first cut".into());
    let style_ref = params
        .style_reference_image
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&params.character_reference_image);
    // Previously confirmed shot types in this run (for adjacent-diversity enforcement).
    let recent_shots = previous_shot_summary(previous_shot_types);
    // Film-grammar driven cut role + shot/angle hints for this position in the sequence.
    let role_assignment = assign_cut_role(cut_index, total_cuts, &cut.description);
    let step_zoom_hint =
        compute_step_zoom_hint(previous_shot_types, role_assignment.shot_type_hint);
    let prompt = format!(
        "You are GORI storyboard prompt builder. Reference the following specs.\n\n\
         ## SKILL.md\n{skill_md}\n\n\
         ## Prompt Builder Spec\n{prompt_builder}\n\n\
         ## Verb Dictionary\n{verb_dict}\n\n\
         ## Film Grammar (MANDATORY)\n{film_grammar}\n\n\
         ## Cut Role Assignment\n\
         - cut_role: {cut_role}\n\
         - shot_type_hint: {shot_type_hint}\n\
         - camera_angle_hint: {camera_angle_hint}\n\
         - step_zoom_direction: {step_zoom_hint}\n\
         - role_purpose: {role_purpose}\n\n\
         ## Task\n\
         Build a structured prompt JSON for cut {cut_id}.\n\
         Cut index: {cut_index} of {total_cuts}\n\
         Story prompt: {story}\n\
         Scene group id: {scene_group_id}\n\
         Previous cut state/reference path: {previous_state}\n\
         Current action: {current_action}\n\
         Character identity reference: {char_ref}\n\
         Style reference: {style_ref}\n\
         Aspect ratio: {aspect_ratio}\n\n\
         ## Hard Diversity Constraints (MUST FOLLOW)\n\
         {recent_shots}\n\
         - Honor the `cut_role` above. Pick a shot_type and camera_angle consistent with that role from `film-grammar.md`.\n\
         - Do NOT reuse the same shot_type as the immediately previous cut. Pick a clearly different value.\n\
         - Across the full sequence of {total_cuts} cuts, the run MUST already include or aim to include at least one extreme close-up or close-up, one medium / medium-wide, one wide / extreme wide, and one unconventional angle (dutch / aerial / ground-level / strong over-shoulder).\n\
         - Avoid the default \"medium close-up + slightly low angle\" pairing unless the verb mapping clearly demands it.\n\
         - The shot_type MUST be derived from the verb mapping in `Verb Dictionary` and justified by the `current_action`. If you cannot justify it from the action, choose again.\n\
         - Rotate camera_angle among at least 3 distinct values across the sequence: eye-level, low angle, high angle, dutch tilt, top-down, ground-up.\n\
         - The Step Zoom Rule applies. Read the `step_zoom_direction` above and pick framing accordingly.\n\n\
         ## Cinematic Detail Mandate (MUST FILL)\n\
         The output JSON's `framing` MUST include these fields beyond shot_type and camera_angle:\n\
         - `focus_detail`: which body part or object the camera fixates on. Be specific (e.g. \"right hand fingers gripping the lever\", \"left iris with a sliver of blue glow reflection\").\n\
         - `body_position_in_frame`: where the subject sits in the frame (e.g. \"left third, gaze leading toward right negative space\").\n\
         - `light_fall`: light source direction relative to subject (e.g. \"rim from screen-right, soft fill below\").\n\
         - `motion_residue`: what was just moving and is now mid-flow (e.g. \"hair mid-flick, fabric in S-curve\").\n\
         - `atmospheric_layer`: foreground/background depth cues (e.g. \"foreground bokeh of glassware, background dust motes in light shaft\").\n\
         The output JSON's `narrative` MUST include `cut_role` set to \"{cut_role}\".\n\
         The output JSON's `style` MUST include `color_grade_note` and `motion_blur_intent`.\n\
         Skip the cinematic detail mandate ONLY if the resulting fields would be meaningless for the action; otherwise fill all.\n\n\
         Return ONLY the JSON object matching the Prompt Builder shape. No prose, no markdown fence.",
        skill_md = refs.skill_md,
        prompt_builder = refs.prompt_builder,
        verb_dict = refs.verb_dictionary,
        film_grammar = refs.film_grammar,
        cut_role = role_assignment.role,
        shot_type_hint = role_assignment.shot_type_hint,
        camera_angle_hint = role_assignment.camera_angle_hint,
        role_purpose = role_assignment.purpose,
        step_zoom_hint = step_zoom_hint,
        cut_id = cut.cut_id,
        cut_index = cut_index + 1,
        total_cuts = total_cuts,
        story = params.story_prompt,
        scene_group_id = cut.scene_group_id,
        previous_state = previous_state,
        current_action = cut.description,
        char_ref = params.character_reference_image,
        style_ref = style_ref,
        aspect_ratio = params.aspect_ratio,
        recent_shots = recent_shots,
    );
    let raw = codex_oneshot(
        codex_bin,
        &prompt,
        &[],
        PROMPT_TIMEOUT_SECS,
        params.cwd.as_deref(),
    )
    .await?;
    extract_json_from_codex_stdout(&raw)
}

fn local_structured_prompt(
    params: &StoryboardParams,
    cut: &CutPlan,
    previous_cut: Option<&Path>,
    previous_shot_types: &[String],
) -> Value {
    let style_ref = params
        .style_reference_image
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&params.character_reference_image);
    let role_assignment = assign_cut_role(
        previous_shot_types.len(),
        previous_shot_types.len() + 1,
        &cut.description,
    );
    // Use role hint, then adjust if it collides with previous shot.
    let mut shot_type: &str = role_assignment.shot_type_hint;
    if let Some(last) = previous_shot_types.last() {
        if last.as_str() == shot_type {
            shot_type = swap_to_alternative_shot(shot_type);
        }
    }
    // Verb override has priority.
    let verb_shot = infer_shot_type(&cut.description);
    if !matches!(verb_shot, "medium-wide") {
        // verb dictionary returned a strong signal; honor it
        shot_type = verb_shot;
    }
    let camera_angle = pick_diverse_camera_angle(&cut.description, previous_shot_types.len());
    serde_json::json!({
        "scene_context": {
            "scene_id": cut.cut_id,
            "scene_group_id": cut.scene_group_id,
            "is_same_scene_group_as_previous": previous_cut.is_some(),
            "characters_in_scene": ["A"],
            "character_layout": {"A": "center"},
            "180_rule_active": false
        },
        "identity": {
            "character_reference": params.character_reference_image,
            "must_keep": ["same face", "same hair", "same body type", "same outfit"]
        },
        "style": {
            "style_reference": style_ref,
            "must_keep": ["same art direction", "same color tone", "same lighting feel"],
            "color_grade_note": "preserve the established palette and tonality",
            "motion_blur_intent": "tack-sharp subject with subtle motion residue on moving extremities"
        },
        "narrative": {
            "previous_cut_state": previous_cut.map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "first cut".into()),
            "current_action": cut.description,
            "cut_role": role_assignment.role,
            "must_change": ["camera angle", "composition", "story progression"]
        },
        "framing": {
            "aspect_ratio": params.aspect_ratio,
            "shot_type": shot_type,
            "camera_angle": camera_angle,
            "spatial_room_for_motion": infer_motion_room(&cut.description),
            "focus_detail": infer_focus_detail(&cut.description, role_assignment.role),
            "body_position_in_frame": "rule-of-thirds placement consistent with the cut role",
            "light_fall": "directional fill consistent with the established lighting",
            "motion_residue": "fabric or hair caught mid-flow if the body is in motion",
            "atmospheric_layer": "subtle foreground/background depth without competing with subject",
            "rule_of_thirds": true,
            "head_room": "standard",
            "lead_room": "forward"
        },
        "negative": "different face, outfit drift, missing props, distorted face, broken hands, background discontinuity, text, logo, watermark, collage, split screen"
    })
}

/// 企画タブで前出しした演出 (prefilled) + ルック分析から、構造化プロンプトを
/// 「LLM を一切呼ばずに」組み立てる (2026-06-06 STΛCK 指示)。
///
/// これが本機能の心臓部: 従来は各カットで build_structured_prompt (Codex 呼び出し
/// 120秒) を回していたが、企画タブで演出を詰めてあれば、その値をそのまま反映する
/// だけで済むので **裏側の LLM 設計を全廃** できる (18分 → ほぼ0秒)。
///
/// ベースは local_structured_prompt (決定論) とし、prefilled に値があるフィールド
/// だけ上書きする。空のフィールドは決定論のデフォルトが残る (部分前出しも許容)。
/// look_analysis があれば identity/style の must_keep に注入して一貫性を底上げする。
fn prefilled_structured_prompt(
    params: &StoryboardParams,
    cut: &CutPlan,
    previous_cut: Option<&Path>,
    previous_shot_types: &[String],
    look: Option<&Value>,
) -> Value {
    let mut base = local_structured_prompt(params, cut, previous_cut, previous_shot_types);
    let Some(p) = cut.prefilled.as_ref() else {
        return base;
    };

    // framing: 企画で指定された shot_type / camera_angle で上書き。
    if let Some(framing) = base.get_mut("framing").and_then(|v| v.as_object_mut()) {
        if let Some(st) = p.shot_type.as_ref().filter(|s| !s.trim().is_empty()) {
            framing.insert("shot_type".into(), Value::String(st.clone()));
        }
        if let Some(ca) = p.camera_angle.as_ref().filter(|s| !s.trim().is_empty()) {
            framing.insert("camera_angle".into(), Value::String(ca.clone()));
        }
        if let Some(cm) = p.camera_motion.as_ref().filter(|s| !s.trim().is_empty()) {
            framing.insert("camera_motion".into(), Value::String(cm.clone()));
        }
    }

    // narrative: cut_role / must_change を企画値で上書き。action_verbs を current_action に補強。
    if let Some(narrative) = base.get_mut("narrative").and_then(|v| v.as_object_mut()) {
        if let Some(role) = p.cut_role.as_ref().filter(|s| !s.trim().is_empty()) {
            narrative.insert("cut_role".into(), Value::String(role.clone()));
        }
        if !p.action_verbs.is_empty() {
            narrative.insert(
                "action_verbs".into(),
                Value::Array(p.action_verbs.iter().cloned().map(Value::String).collect()),
            );
        }
        if !p.must_change.is_empty() {
            narrative.insert(
                "must_change".into(),
                Value::Array(p.must_change.iter().cloned().map(Value::String).collect()),
            );
        }
    }

    // identity.must_keep: 企画の must_keep + ルック分析の identity_anchors を合流。
    if let Some(identity) = base.get_mut("identity").and_then(|v| v.as_object_mut()) {
        let mut keep: Vec<Value> = p.must_keep.iter().cloned().map(Value::String).collect();
        if let Some(anchors) = look
            .and_then(|l| l.get("identityAnchors").or_else(|| l.get("identity_anchors")))
            .and_then(|v| v.as_array())
        {
            keep.extend(anchors.iter().cloned());
        }
        if !keep.is_empty() {
            identity.insert("must_keep".into(), Value::Array(keep));
        }
    }

    // ルック分析を style に注入 (色/質感/ムードを全カット共通の一貫性アンカーに)。
    if let (Some(style), Some(look)) =
        (base.get_mut("style").and_then(|v| v.as_object_mut()), look)
    {
        if let Some(color) = look
            .get("colorProfile")
            .or_else(|| look.get("color_profile"))
            .and_then(|v| v.as_str())
        {
            style.insert("look_color".into(), Value::String(color.to_string()));
        }
        if let Some(material) = look.get("material").and_then(|v| v.as_str()) {
            style.insert("look_material".into(), Value::String(material.to_string()));
        }
        if let Some(mood) = look.get("mood").and_then(|v| v.as_str()) {
            style.insert("look_mood".into(), Value::String(mood.to_string()));
        }
    }

    // negative: 企画の negative_constraints をデフォルト negative に追記。
    if !p.negative_constraints.is_empty() {
        let extra = p.negative_constraints.join(", ");
        let merged = match base.get("negative").and_then(|v| v.as_str()) {
            Some(existing) if !existing.is_empty() => format!("{existing}, {extra}"),
            _ => extra,
        };
        if let Some(obj) = base.as_object_mut() {
            obj.insert("negative".into(), Value::String(merged));
        }
    }

    base
}

/// Provide a focus_detail hint based on action keywords and cut role.
fn infer_focus_detail(action: &str, role: &str) -> &'static str {
    if contains_any(action, &["手元", "指", "ボタン", "レバー", "配線"]) {
        "fingers and the manipulated object"
    } else if contains_any(action, &["目", "瞳", "視線", "見つめ", "凝視"]) {
        "the eye closest to camera, including iris detail"
    } else if contains_any(action, &["顔", "表情", "微笑", "驚"]) {
        "face center, especially the mouth-to-eye axis"
    } else if contains_any(action, &["全体", "包まれ"]) {
        "the protagonist's silhouette in the environment"
    } else {
        match role {
            "detail" => "the specific object being manipulated",
            "reaction" => "the face, with eye-line clearly readable",
            "establishing" => "the protagonist anchored within the location",
            "climax" => "the apex of the action mid-motion",
            "resolution" => "the protagonist receding into the wider frame",
            _ => "the protagonist's primary action axis",
        }
    }
}

/// Cut role assignment derived from the cut's position in the sequence.
/// Follows the film-grammar.md default role table.
struct CutRoleAssignment {
    role: &'static str,
    shot_type_hint: &'static str,
    camera_angle_hint: &'static str,
    purpose: &'static str,
}

/// P15 (2026-05-20): cut_role から推奨 ShotSize を引く。
/// Codex セッション2の D 表「cut_role別の推奨shot」を反映。
fn shot_size_for_role(role: &str) -> ShotSize {
    match role {
        "establishing" => ShotSize::Wide,
        "action" => ShotSize::Medium,
        "detail" => ShotSize::ExtremeCloseUp,
        "reaction" => ShotSize::CloseUp,
        "climax" => ShotSize::CloseUp,
        "resolution" => ShotSize::Wide,
        _ => ShotSize::Medium,
    }
}

/// P17a (2026-05-21 STΛCK指示): cut_role から推奨 CameraAngle を引く。
/// establishing は俯瞰や眼下、action は eye-level や low、reaction は OTS や POV など、
/// 役割に応じて多様なアングルを散らばらせる初期値を返す。
/// 隣接カットでの連続を避けるため、plan_visual_continuity 内で再調整する。
fn camera_angle_for_role(role: &str, cut_index: usize) -> CameraAngle {
    // cut_index を mod でずらしてバリエーションを作る
    match role {
        "establishing" => match cut_index % 3 {
            0 => CameraAngle::Low,         // 教会の柱を見上げる
            1 => CameraAngle::High,        // 俯瞰で空間紹介
            _ => CameraAngle::ThreeQuarter, // 斜めから入場
        },
        "action" => match cut_index % 3 {
            0 => CameraAngle::EyeLevel,
            1 => CameraAngle::Low,
            _ => CameraAngle::ThreeQuarter,
        },
        "detail" => match cut_index % 3 {
            0 => CameraAngle::BirdsEye,    // 物の真上 (insert)
            1 => CameraAngle::EyeLevel,
            _ => CameraAngle::Low,
        },
        "reaction" => match cut_index % 3 {
            0 => CameraAngle::OverShoulder, // OTS で対話/緊張
            1 => CameraAngle::EyeLevel,
            _ => CameraAngle::Pov,          // POV で没入
        },
        "climax" => match cut_index % 3 {
            0 => CameraAngle::Dutch,       // 不安/狂気
            1 => CameraAngle::Low,         // 強さ
            _ => CameraAngle::OverShoulder,
        },
        "resolution" => match cut_index % 3 {
            0 => CameraAngle::High,        // 引いて締める
            1 => CameraAngle::ThreeQuarter,
            _ => CameraAngle::EyeLevel,
        },
        _ => CameraAngle::EyeLevel,
    }
}

/// P17b (2026-05-21 STΛCK指示): 「教会の中で移動している感がない、同じ場所でぐるぐる」
/// 問題への対応。description から主ロケーションを推測し、その内側の micro-location
/// プリセットを cut_index に応じてローテーションする。
///
/// micro_location は「同じ大空間内で物理的に移動した位置」を意味する。
/// 同じ場所3カット連続を避けることで、カメラが空間内を移動する印象を作る。
fn micro_locations_for(description: &str) -> Vec<&'static str> {
    let lower = description.to_lowercase();
    // 教会
    if description.contains("教会") || lower.contains("church") || lower.contains("cathedral") {
        return vec![
            "near the entrance doors looking inward",
            "central nave between the pews",
            "at the altar with candles",
            "side aisle by stained-glass windows",
            "front row of pews looking toward the altar",
            "behind the pulpit",
            "by a confessional booth",
            "stone steps leading to the choir loft",
        ];
    }
    // ジム
    if description.contains("ジム") || lower.contains("gym") {
        return vec![
            "by the dumbbell rack",
            "in front of the squat rack",
            "on the bench press",
            "mirror wall reflection",
            "by the cable machine",
            "treadmill row",
            "stretching mat area",
            "locker hallway",
        ];
    }
    // 廃墟
    if description.contains("廃墟") || lower.contains("ruin") || lower.contains("abandoned") {
        return vec![
            "in front of broken entrance",
            "down a collapsing corridor",
            "central atrium with debris",
            "by a shattered window",
            "on a rusted staircase",
            "under a partially fallen ceiling",
            "next to overgrown machinery",
            "on the rooftop edge",
        ];
    }
    // ステージ
    if description.contains("ステージ") || lower.contains("stage") {
        return vec![
            "downstage center spotlight",
            "upstage left in shadow",
            "wings backstage glimpse",
            "near the drum riser",
            "in front of the amp wall",
            "stage edge facing audience",
            "above the catwalk lighting rig",
            "from the back of the venue",
        ];
    }
    // 屋外 (一般)
    if lower.contains("street") || description.contains("通り") || description.contains("街") {
        return vec![
            "intersection corner",
            "narrow alley",
            "main avenue sidewalk",
            "under a neon sign",
            "by a storefront window",
            "rooftop view",
            "across a crosswalk",
            "near a bus stop",
        ];
    }
    // 屋内一般
    if lower.contains("room") || description.contains("部屋") {
        return vec![
            "by the door",
            "center of the room",
            "near the window",
            "by the wall",
            "at the desk",
            "from a high corner",
            "from the floor level",
            "from outside through the doorway",
        ];
    }
    // フォールバック (汎用)
    vec![
        "front entry framing",
        "central interior wide view",
        "side wall close framing",
        "rear back-angle framing",
        "near a primary prop in the foreground",
        "looking out toward open space",
        "looking inward from edge",
        "from elevated viewpoint",
    ]
}

/// P17a: 同じ camera_angle が直前と被ったら別の angle に切り替える。
/// 多様性を強制する。
fn alternate_camera_angle(prev: &CameraAngle, candidate: CameraAngle, cut_index: usize) -> CameraAngle {
    if std::mem::discriminant(prev) != std::mem::discriminant(&candidate) {
        return candidate;
    }
    // 候補プール (prev 以外) から cut_index ベースで選ぶ
    let pool = [
        CameraAngle::EyeLevel,
        CameraAngle::High,
        CameraAngle::Low,
        CameraAngle::ThreeQuarter,
        CameraAngle::OverShoulder,
        CameraAngle::Pov,
        CameraAngle::Dutch,
        CameraAngle::BirdsEye,
    ];
    for offset in 1..pool.len() {
        let pick = &pool[(cut_index + offset) % pool.len()];
        if std::mem::discriminant(pick) != std::mem::discriminant(prev) {
            return pick.clone();
        }
    }
    CameraAngle::ThreeQuarter
}

/// P15: 隣接カットで同じ shot_size が連続したら、emotional_intent に応じて
/// 自然な遷移先 (medium→close or wide) を提案する。Codex セッション2の C マトリクス準拠。
fn suggest_next_shot_size(prev: &ShotSize, emotional_intent: &str) -> ShotSize {
    let going_emotional = emotional_intent.contains("感情")
        || emotional_intent.contains("緊張")
        || emotional_intent.contains("決意");
    let going_environmental = emotional_intent.contains("環境")
        || emotional_intent.contains("広がり")
        || emotional_intent.contains("呼吸");
    match prev {
        ShotSize::ExtremeWide => ShotSize::Wide,
        ShotSize::Wide => {
            if going_emotional {
                ShotSize::Medium
            } else {
                ShotSize::Medium
            }
        }
        ShotSize::Medium => {
            if going_emotional {
                ShotSize::CloseUp
            } else if going_environmental {
                ShotSize::Wide
            } else {
                ShotSize::CloseUp
            }
        }
        ShotSize::CloseUp => {
            if going_environmental {
                ShotSize::Wide
            } else {
                ShotSize::Medium
            }
        }
        ShotSize::ExtremeCloseUp => ShotSize::Medium,
    }
}

/// P15: 全カットに対して CutVisualPlan を構築する。
/// 1. cut_role から初期 shot_size を引く
/// 2. 隣接カットで同じ shot_size 連続なら suggest_next_shot_size で変更
/// 3. screen_direction / camera_side は scene_group_id 内で維持
/// 4. action_end → 次カットの action_start に接続
fn plan_visual_continuity(cuts: &[CutPlan]) -> Vec<CutVisualPlan> {
    let mut plans: Vec<CutVisualPlan> = Vec::new();

    // P17b: 全カットの description を結合して主ロケーションを推測 → micro_location プール取得
    let combined_description: String = cuts
        .iter()
        .map(|c| c.description.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let micro_pool = micro_locations_for(&combined_description);

    for (i, cut) in cuts.iter().enumerate() {
        let role_assignment = assign_cut_role(i, cuts.len(), &cut.description);
        let mut shot_size = shot_size_for_role(role_assignment.role);

        // 隣接カットとの shot_size 衝突を解消
        if let Some(prev) = plans.last() {
            if prev.shot_size == shot_size {
                shot_size = suggest_next_shot_size(&prev.shot_size, &cut.description);
            }
            // shot_size の飛躍が大きすぎる場合 (±3 以上) は1段階に丸める
            let delta = (shot_size.level() - prev.shot_size.level()).abs();
            if delta >= 3 {
                shot_size = match prev.shot_size {
                    ShotSize::ExtremeWide => ShotSize::Medium,
                    ShotSize::Wide => ShotSize::CloseUp,
                    ShotSize::Medium => ShotSize::Wide,
                    ShotSize::CloseUp => ShotSize::Wide,
                    ShotSize::ExtremeCloseUp => ShotSize::Medium,
                };
            }
        }

        // P17a: camera_angle を機械的にアサイン。隣接同 angle を避ける。
        let mut camera_angle = camera_angle_for_role(role_assignment.role, i);
        if let Some(prev) = plans.last() {
            camera_angle = alternate_camera_angle(&prev.camera_angle, camera_angle, i);
        }

        // P17b: micro_location を機械的にアサイン (cut_index ベースでローテーション)。
        // 同じ micro_location 3連続を避けるため、隣接2つと被らないように選ぶ。
        let micro_location = {
            let pool_len = micro_pool.len().max(1);
            let mut idx = i % pool_len;
            // 直前2カットと被ったらシフト
            let recent_locations: Vec<String> = plans
                .iter()
                .rev()
                .take(2)
                .map(|p| p.micro_location.clone())
                .collect();
            for offset in 0..pool_len {
                let candidate = micro_pool[(i + offset) % pool_len];
                if !recent_locations.iter().any(|r| r == candidate) {
                    idx = (i + offset) % pool_len;
                    break;
                }
            }
            micro_pool[idx].to_string()
        };

        // screen_direction は scene_group 内で前カットを継承、別グループなら static
        let (screen_direction, camera_side) = match plans.last() {
            Some(prev) if prev.scene_group_id == cut.scene_group_id => {
                (prev.screen_direction.clone(), prev.camera_side.clone())
            }
            _ => (ScreenDirection::Static, "neutral".to_string()),
        };

        // action_end → action_start の接続。前カットの end が今カットの start。
        let action_start = plans
            .last()
            .map(|p| p.action_end.clone())
            .unwrap_or_else(|| "establish character standing posture".to_string());

        // action_end は cut.description から動詞っぽい末尾要素を取り出す簡易ロジック。
        // 完全な抽出は LLM 任せだが、Rust 側でも一応推定する。
        let action_end = derive_action_end(&cut.description);

        // subject_position は scene_group の axis に応じて選択 (簡易)
        let subject_position = match (i % 3, role_assignment.role) {
            (_, "establishing") | (_, "resolution") => "center".to_string(),
            (0, _) => "left_third".to_string(),
            (1, _) => "center".to_string(),
            _ => "right_third".to_string(),
        };

        plans.push(CutVisualPlan {
            cut_id: cut.cut_id.clone(),
            scene_group_id: cut.scene_group_id.clone(),
            cut_role: role_assignment.role.to_string(),
            shot_size,
            camera_angle,
            screen_direction,
            camera_side,
            subject_position,
            action_start,
            action_end,
            emotional_intent: cut.description.clone(),
            micro_location,
        });
    }

    // P18d (2026-05-21 STΛCK指示): 「ストーリーに無いショットを強制投入するな」
    // 旧 enforce_pov_or_ots を撤廃。POV/OTS はストーリーが求める時だけ自然に出る。
    // camera_angle_for_role の reaction/climax 既定値で OTS/POV は候補に入っているので、
    // 強制投入なしでも適切な役割で自然に登場する。

    plans
}

/// P17d (2026-05-21): 隣接カット validate — 違反を warn ログに出す。
/// 自動修正は plan_visual_continuity 内で完了している前提。
#[allow(dead_code)]
fn validate_neighbor_plans(plans: &[CutVisualPlan]) -> Vec<String> {
    let mut warnings: Vec<String> = Vec::new();
    for window in plans.windows(2) {
        let prev = &window[0];
        let curr = &window[1];

        // 同 shot_size 連続
        if prev.shot_size == curr.shot_size {
            warnings.push(format!(
                "{} → {}: same shot_size {:?} (avoid jump cut)",
                prev.cut_id, curr.cut_id, curr.shot_size
            ));
        }
        // 同 camera_angle 連続
        if std::mem::discriminant(&prev.camera_angle) == std::mem::discriminant(&curr.camera_angle) {
            warnings.push(format!(
                "{} → {}: same camera_angle {} (lacks angle variation)",
                prev.cut_id,
                curr.cut_id,
                curr.camera_angle.as_str()
            ));
        }
        // sceneGroup 内で screen_direction 反転
        if prev.scene_group_id == curr.scene_group_id
            && prev.screen_direction != curr.screen_direction
            && prev.screen_direction != ScreenDirection::Static
            && curr.screen_direction != ScreenDirection::Static
        {
            warnings.push(format!(
                "{} → {}: screen_direction reversal within same scene_group (180-rule risk)",
                prev.cut_id, curr.cut_id
            ));
        }
    }
    // micro_location 3連続
    for window in plans.windows(3) {
        if window[0].micro_location == window[1].micro_location
            && window[1].micro_location == window[2].micro_location
        {
            warnings.push(format!(
                "{} ~ {}: same micro_location '{}' for 3 consecutive cuts",
                window[0].cut_id, window[2].cut_id, window[1].micro_location
            ));
        }
    }
    warnings
}

/// 動詞抽出の簡易ロジック。description の末尾フレーズから動作を推定する。
fn derive_action_end(description: &str) -> String {
    // 末尾の句読点直前を取る。これが action_end の起点となる。
    let trimmed = description.trim_end_matches(['.', '。', '!', '?'].as_ref());
    let last_clause = trimmed
        .rsplit_once(['、', '，', '.', '。'])
        .map(|(_, tail)| tail.trim())
        .unwrap_or(trimmed)
        .trim();
    if last_clause.is_empty() {
        "subject holds final pose".to_string()
    } else {
        format!("pose at end of: {last_clause}")
    }
}

/// P15: 隣接カットの ContinuityContract を構築する。
/// 「前カットから何を preserve / change / forbid / bridge するか」を渡す。
///
/// P18c (2026-05-21): scene_group 切替時はルールを大胆に緩める。
///   - 同一 scene_group: シーン内連続性を厳格化 (screen_direction / axis / 構図変化等)
///   - scene_group 切替: 新シーンとして自由度を保つ (キャラ identity のみ厳格)
fn build_continuity_contract(
    prev: Option<&CutVisualPlan>,
    curr: &CutVisualPlan,
    scene_intent: Option<&str>,
    scene_primary_location: Option<&str>,
) -> ContinuityContract {
    let mut preserve: Vec<String> = vec![
        "character_id".into(),
        "costume_palette".into(),
        "world_rules".into(),
        "aspect_ratio".into(),
    ];
    let mut change: Vec<String> = vec![format!("cut_role: {}", curr.cut_role)];
    let mut forbidden: Vec<String> = vec![
        "identity_drift".into(),
        "costume_drift".into(),
        "unintroduced_extra_character".into(),
        "background_teleport".into(),
        "text_gibberish".into(),
        "hand_face_artifact".into(),
    ];
    let mut bridge: Vec<String> = Vec::new();

    // シーン情報を change に明示する (AI がシーンの狙いを把握できるように)
    if let Some(intent) = scene_intent {
        if !intent.trim().is_empty() {
            change.push(format!("scene_intent: \"{}\"", intent));
        }
    }
    if let Some(loc) = scene_primary_location {
        if !loc.trim().is_empty() {
            change.push(format!("scene_primary_location: \"{}\"", loc));
        }
    }

    if let Some(p) = prev {
        let same_scene = p.scene_group_id == curr.scene_group_id;

        if same_scene {
            // === 同一 scene_group: 連続性を厳格に保つ ===
            preserve.push(format!("screen_direction: {}", p.screen_direction.as_str()));
            preserve.push(format!("camera_side: {}", p.camera_side));
            forbidden.push("axis_flip_without_bridge".into());
            forbidden.push(format!(
                "same_camera_angle_as_prev ({})",
                p.camera_angle.as_str()
            ));
            forbidden.push("camera_remaining_in_exact_same_spot_as_prev".into());
            forbidden.push("exact_same_framing_as_previous".into());

            // shot_size 比較
            let delta = curr.shot_size.level() - p.shot_size.level();
            if delta > 0 {
                change.push(format!(
                    "shot_size: move closer ({} → {})",
                    p.shot_size.as_str(),
                    curr.shot_size.as_str()
                ));
            } else if delta < 0 {
                change.push(format!(
                    "shot_size: pull back ({} → {})",
                    p.shot_size.as_str(),
                    curr.shot_size.as_str()
                ));
            }

            // camera_angle の変化を明示
            if std::mem::discriminant(&p.camera_angle) != std::mem::discriminant(&curr.camera_angle)
            {
                change.push(format!(
                    "camera_angle: change to {} ({})",
                    curr.camera_angle.as_str(),
                    curr.camera_angle.directive()
                ));
            }

            // micro_location の変化を強制
            if p.micro_location != curr.micro_location {
                change.push(format!(
                    "camera_position_within_scene: move from \"{}\" to \"{}\"",
                    p.micro_location, curr.micro_location
                ));
            }

            // 動作橋渡し
            bridge.push(format!("cut_on_action: continue from \"{}\"", p.action_end));
            bridge.push(format!("action_start: \"{}\"", curr.action_start));
        } else {
            // === scene_group 切替: 連続性ルールを緩める ===
            // 新シーンとしてフレッシュに作る。キャラ identity と aspect だけ保つ。
            change.push("new_scene_start: this cut begins a new scene_group".into());
            change.push(format!(
                "new_setting: {}",
                scene_primary_location.unwrap_or("(continuation)")
            ));
            change.push(format!(
                "shot_size: {} (chosen for new scene opening)",
                curr.shot_size.as_str()
            ));
            change.push(format!(
                "camera_angle: {} ({})",
                curr.camera_angle.as_str(),
                curr.camera_angle.directive()
            ));
            // 厳格な制約は外す (axis / framing 連続禁止は不要)
            // ただしキャラ identity は引き続き厳格に preserve
            forbidden.push("character_appearance_change".into());
        }
    } else {
        // === 最初のカット (prev なし) ===
        change.push("opening_cut: establish this scene's first frame".into());
        change.push(format!(
            "shot_size: {} (opening)",
            curr.shot_size.as_str()
        ));
        change.push(format!(
            "camera_angle: {}",
            curr.camera_angle.as_str()
        ));
    }

    change.push(format!("emphasis: {}", curr.emotional_intent));
    change.push(format!("subject_position: {}", curr.subject_position));
    change.push(format!("camera_position: \"{}\"", curr.micro_location));

    ContinuityContract {
        preserve,
        change,
        forbidden,
        bridge,
    }
}

fn assign_cut_role(cut_index: usize, total_cuts: usize, action: &str) -> CutRoleAssignment {
    // Verb-driven overrides take precedence over positional default.
    // If the action strongly implies a specific role, honor it.
    if contains_any(
        action,
        &[
            "手元",
            "指",
            "ボタン",
            "レバー",
            "配線",
            "knob",
            "lever",
            "wire",
        ],
    ) {
        return CutRoleAssignment {
            role: "detail",
            shot_type_hint: "extreme close-up",
            camera_angle_hint: "top-down",
            purpose: "B-roll insert: emphasize the manipulated object",
        };
    }
    if contains_any(
        action,
        &["驚", "息を呑", "目を見開", "微笑", "安堵", "stare", "gaze"],
    ) {
        return CutRoleAssignment {
            role: "reaction",
            shot_type_hint: "close-up",
            camera_angle_hint: "eye-level",
            purpose: "B-roll: emotional response shot, face-focused",
        };
    }
    if contains_any(
        action,
        &["全体", "包まれ", "establishing", "panorama", "vista"],
    ) {
        return CutRoleAssignment {
            role: "establishing",
            shot_type_hint: "wide shot",
            camera_angle_hint: "low angle",
            purpose: "A-roll: locate the protagonist in the scene",
        };
    }
    if contains_any(
        action,
        &["異変", "歪", "崩", "震", "揺れ", "クライマックス", "climax"],
    ) {
        return CutRoleAssignment {
            role: "climax",
            shot_type_hint: "medium-wide",
            camera_angle_hint: "dutch angle",
            purpose: "A-roll: visually distinctive peak moment",
        };
    }
    // Positional default from film-grammar.md.
    role_by_position(cut_index, total_cuts)
}

fn role_by_position(cut_index: usize, total_cuts: usize) -> CutRoleAssignment {
    // 0-indexed cut_index, total_cuts is the run length.
    // Maps to the default role table in film-grammar.md.
    let role: &'static str = match total_cuts {
        0..=2 => match cut_index {
            0 => "establishing",
            _ => "resolution",
        },
        3 => match cut_index {
            0 => "establishing",
            1 => "action",
            _ => "resolution",
        },
        4 => match cut_index {
            0 => "establishing",
            1 => "action",
            2 => "reaction",
            _ => "resolution",
        },
        5 => match cut_index {
            0 => "establishing",
            1 => "action",
            2 => "detail",
            3 => "reaction",
            _ => "resolution",
        },
        6 => match cut_index {
            0 => "establishing",
            1 => "action",
            2 => "detail",
            3 => "climax",
            4 => "reaction",
            _ => "resolution",
        },
        7 => match cut_index {
            0 => "establishing",
            1 => "action",
            2 => "detail",
            3 => "action",
            4 => "climax",
            5 => "reaction",
            _ => "resolution",
        },
        _ => {
            // 8+: two mini-arcs.
            let half = total_cuts / 2;
            if cut_index < half {
                match cut_index {
                    0 => "establishing",
                    1 => "action",
                    _ if cut_index == half - 1 => "reaction",
                    _ => "detail",
                }
            } else if cut_index == half {
                "establishing"
            } else if cut_index == total_cuts - 1 {
                "resolution"
            } else if cut_index == total_cuts - 2 {
                "reaction"
            } else if cut_index == total_cuts - 3 {
                "climax"
            } else {
                "detail"
            }
        }
    };
    role_to_assignment(role)
}

fn role_to_assignment(role: &'static str) -> CutRoleAssignment {
    match role {
        "establishing" => CutRoleAssignment {
            role,
            shot_type_hint: "wide shot",
            camera_angle_hint: "low angle",
            purpose: "A-roll: locate the protagonist in the scene",
        },
        "action" => CutRoleAssignment {
            role,
            shot_type_hint: "medium-wide",
            camera_angle_hint: "eye-level",
            purpose: "A-roll: the main verb happens, body in motion",
        },
        "detail" => CutRoleAssignment {
            role,
            shot_type_hint: "extreme close-up",
            camera_angle_hint: "top-down",
            purpose: "B-roll: hands, objects, textures",
        },
        "reaction" => CutRoleAssignment {
            role,
            shot_type_hint: "close-up",
            camera_angle_hint: "eye-level",
            purpose: "B-roll: emotional response, face-focused",
        },
        "climax" => CutRoleAssignment {
            role,
            shot_type_hint: "medium",
            camera_angle_hint: "dutch angle",
            purpose: "A-roll: peak moment, break the pattern",
        },
        "resolution" => CutRoleAssignment {
            role,
            shot_type_hint: "wide shot",
            camera_angle_hint: "eye-level",
            purpose: "A-roll: pull back, settle, breathe out",
        },
        _ => CutRoleAssignment {
            role: "action",
            shot_type_hint: "medium-wide",
            camera_angle_hint: "eye-level",
            purpose: "A-roll: the main verb happens",
        },
    }
}

/// Compute step zoom direction based on previous shot types vs target shot type.
/// Returns one of: "zoom_in", "zoom_out", "break", "first".
fn compute_step_zoom_hint(previous: &[String], target: &str) -> &'static str {
    let target_rank = shot_distance_rank(target);
    let Some(last) = previous.last() else {
        return "first (no previous cut; pick framing that fits the cut role)";
    };
    let last_rank = shot_distance_rank(last);
    if target_rank < last_rank {
        "zoom_in (target is tighter than previous)"
    } else if target_rank > last_rank {
        "zoom_out (target is wider than previous)"
    } else {
        "break (same distance as previous; FORCE a contrasting shot_type to satisfy step zoom rule)"
    }
}

/// Rank shot types by camera distance. Lower = tighter.
fn shot_distance_rank(shot: &str) -> i32 {
    let s = shot.to_lowercase();
    if s.contains("extreme close-up") || s.contains("extreme closeup") {
        0
    } else if s.contains("close-up") || s.contains("closeup") {
        1
    } else if s.contains("medium close-up") || s.contains("medium closeup") {
        2
    } else if s.contains("medium-wide") {
        4
    } else if s.contains("medium") {
        3
    } else if s.contains("extreme wide") {
        7
    } else if s.contains("wide") {
        6
    } else {
        5
    }
}

/// Summarize previously confirmed shot types as a constraint hint for the LLM.
fn previous_shot_summary(previous: &[String]) -> String {
    if previous.is_empty() {
        return "- This is the first cut. Pick a shot type that establishes the scene (often wide or establishing) unless the action specifically demands close detail.".to_string();
    }
    let recent = previous
        .iter()
        .rev()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let all = previous.join(", ");
    format!(
        "- Already used shot types so far (most recent first): {recent}.\n\
         - Full sequence so far: {all}.\n\
         - The next cut's shot_type MUST be different from the immediately previous cut.\n\
         - If close-up has not appeared yet and the sequence is past the midpoint, prefer adding one now if the action allows.\n\
         - If wide / extreme wide has not appeared yet and the sequence is past the midpoint, prefer adding one now."
    )
}

async fn generate_cut_takes(
    app: &AppHandle,
    codex_bin: &Path,
    codex_home_orig: &Path,
    structured_prompt: &Value,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    take_specs: &[(String, u32)],
    cwd: Option<String>,
    aspect_ratio: &str,
    sketch_mode: bool,
) -> Vec<Result<(String, PathBuf), String>> {
    let mut tasks = take_specs
        .iter()
        .enumerate()
        .map(|(order, (take_id, idx))| {
            let cwd = cwd.clone();
            async move {
                let result = generate_one_take(
                    codex_bin,
                    codex_home_orig,
                    structured_prompt,
                    reference_images,
                    output_dir,
                    cut_id,
                    take_id,
                    *idx,
                    take_specs.len() as u32,
                    cwd,
                    aspect_ratio,
                    sketch_mode,
                )
                .await;
                (order, result)
            }
        })
        .collect::<FuturesUnordered<_>>();

    let mut completed = Vec::with_capacity(take_specs.len());
    while let Some((order, result)) = tasks.next().await {
        if let Ok((take_id, image_path)) = &result {
            let _ = app.emit(
                EVENT_STORYBOARD,
                StoryboardEvent::TakeCompleted {
                    cut_id: cut_id.to_string(),
                    take_id: take_id.clone(),
                    image_path: image_path.to_string_lossy().into_owned(),
                    scores: ScoreBundle::default(),
                },
            );
        }
        completed.push((order, result));
    }

    // 表示は完成順に行うが、主候補の選択結果は従来どおり take 番号順に保つ。
    completed.sort_by_key(|(order, _)| *order);
    completed.into_iter().map(|(_, result)| result).collect()
}

#[allow(clippy::too_many_arguments)]
/// image_gen を呼ばずに codex が正常終了したとき(画像が生成されない)に何回まで
/// 作り直すか。effort の低い LLM が「OK」だけ返して image_gen を呼び忘れるケースの
/// 救済(2026-06-08 storyboard 生成失敗の修正。マルチアングルと同思想)。
const STORYBOARD_MAX_ATTEMPTS: u32 = 3;

/// 1テイク生成(リトライ込み)。
///
/// codex が image_gen を呼ばずに正常終了し画像が生成されないことがある(status は
/// success のまま「生成画像が見つかりません」になる)。1回で諦めず最大
/// STORYBOARD_MAX_ATTEMPTS 回まで作り直す。
#[allow(clippy::too_many_arguments)]
async fn generate_one_take(
    codex_bin: &Path,
    codex_home_orig: &Path,
    structured_prompt: &Value,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    take_id: &str,
    candidate_index: u32,
    candidate_count: u32,
    cwd: Option<String>,
    aspect_ratio: &str,
    sketch_mode: bool,
) -> Result<(String, PathBuf), String> {
    let mut last_err = String::new();
    for attempt in 1..=STORYBOARD_MAX_ATTEMPTS {
        match attempt_one_take(
            codex_bin,
            codex_home_orig,
            structured_prompt,
            reference_images,
            output_dir,
            cut_id,
            take_id,
            candidate_index,
            candidate_count,
            cwd.clone(),
            aspect_ratio,
            sketch_mode,
        )
        .await
        {
            Ok(v) => return Ok(v),
            Err(e) => {
                tracing::warn!(
                    "storyboard {cut_id} {take_id} attempt {attempt}/{STORYBOARD_MAX_ATTEMPTS} failed: {e}"
                );
                last_err = e;
            }
        }
    }
    // 外部 API 障害(ServerError/5xx/401 等)なら非エンジニア向けの文言に整形する。
    Err(crate::codex::process::humanize_generation_failure(&format!(
        "{STORYBOARD_MAX_ATTEMPTS}回試行しても生成できませんでした ({cut_id} {take_id}): {last_err}"
    )))
}

/// 1テイク生成の1試行。画像が出れば Ok、image_gen 未呼び出し等で画像が無ければ Err。
#[allow(clippy::too_many_arguments)]
async fn attempt_one_take(
    codex_bin: &Path,
    codex_home_orig: &Path,
    structured_prompt: &Value,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    take_id: &str,
    candidate_index: u32,
    candidate_count: u32,
    cwd: Option<String>,
    aspect_ratio: &str,
    sketch_mode: bool,
) -> Result<(String, PathBuf), String> {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("codex-storyboard-{cut_id}-{take_id}-"))
        .tempdir()
        .map_err(|e| format!("tempdir 作成失敗: {e}"))?;
    let tmp_home = tmp.path().to_path_buf();
    mirror_codex_home(codex_home_orig, &tmp_home)?;
    let tmp_gen = tmp_home.join("generated_images");
    std::fs::create_dir_all(&tmp_gen)
        .map_err(|e| format!("worker generated_images 作成失敗: {e}"))?;

    let final_prompt = build_generation_prompt(
        structured_prompt,
        cut_id,
        take_id,
        candidate_index,
        candidate_count,
        aspect_ratio,
        sketch_mode,
    );
    let mut cmd = Command::new(codex_bin);
    cmd.args([
        "exec",
        // Windows では --full-auto(=--sandbox workspace-write)が
        // codex-windows-sandbox-setup.exe を要求して「見つかりません」で死ぬ。
        // サンドボックス無効の bypass を使う(2026-06-09 Windows修正。--full-auto
        // では直らなかった)。BYO 配布はユーザー自身の PC=外部サンドボックス環境。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &format!("model={STORYBOARD_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={STORYBOARD_EFFORT}"),
    ]);
    if let Some(c) = cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("-C").arg(c);
    }
    for image in reference_images {
        cmd.arg("-i").arg(image);
    }
    cmd.arg("-");
    cmd.env("CODEX_HOME", &tmp_home);
    cmd.env("PATH", enriched_path());
    cmd.kill_on_drop(true);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::codex::process::no_window_flag(&mut cmd);

    let gen_permit = GLOBAL_GEN_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| "画像生成キューが閉じられました".to_string())?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(final_prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
    }
    let output = timeout(
        Duration::from_secs(GENERATION_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("画像生成が {GENERATION_TIMEOUT_SECS} 秒でタイムアウトしました"))?
    .map_err(|e| format!("codex exec 待機失敗: {e}"))?;
    drop(gen_permit);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("(stderr 出力なし)");
        return Err(format!(
            "画像生成 codex exec が異常終了 (code={:?}): {last}",
            output.status.code()
        ));
    }

    let src_png = match find_newest_generated_png(&tmp_gen) {
        Some(p) => p,
        None => {
            // codex は正常終了したのに画像が無い = image_gen を呼ばずに終わった等。
            // 原因究明のため stdout 末尾を残す(マルチアングルと同じ)。
            let stdout = String::from_utf8_lossy(&output.stdout);
            let tail = stdout
                .lines()
                .rev()
                .filter(|l| !l.trim().is_empty())
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" / ");
            return Err(format!(
                "生成画像が見つかりませんでした: {cut_id} {take_id} (codex最終出力: {})",
                if tail.is_empty() { "(出力なし)" } else { &tail }
            ));
        }
    };
    let dest = output_dir.join(format!("{cut_id}_take_{take_id}.png"));
    std::fs::copy(&src_png, &dest).map_err(|e| format!("出力コピー失敗: {e}"))?;
    Ok((take_id.to_string(), dest))
}

fn build_generation_prompt(
    structured_prompt: &Value,
    cut_id: &str,
    take_id: &str,
    candidate_index: u32,
    candidate_count: u32,
    aspect_ratio: &str,
    sketch_mode: bool,
) -> String {
    let prompt_json = serde_json::to_string_pretty(structured_prompt)
        .unwrap_or_else(|_| structured_prompt.to_string());

    if sketch_mode {
        // 絵コンテモード: 本番カットと明確に違う「鉛筆スケッチ・モノクロ・荒い線」スタイルを強制。
        // STΛCK 指示 (2026-05-20): 絵コンテは本番と被ってはいけない。
        return format!(
            "次の構造化プロンプトに従って、ストーリーボード絵コンテ用のラフスケッチ画像を1枚だけ生成してください。\n\n\
             ## この画像の役割\n\
             - cutId: {cut_id}\n\
             - takeId: {take_id}\n\
             - 候補 {candidate_index}/{candidate_count}\n\
             - 参照画像は順に、キャラクター基準、スタイル基準、必要なら直前確定カットです。\n\
             - これは「絵コンテ」です。本番の写真品質ではなく、紙に鉛筆で描いたラフなスケッチが正解。\n\n\
             ## 手順\n\
             1. image_gen ツールを1回だけ呼び出す。\n\
             2. {aspect_ratio} aspect ratio で生成する。\n\
             3. 必ず以下のスタイルを厳守:\n\
                rough pencil sketch on storyboard paper, monochrome graphite drawing, hand-drawn loose linework, low fidelity, no color, no photorealism, traditional film storyboard panel style, quick concept sketch, visible pencil strokes, off-white paper background, minimal shading.\n\
             4. 構造化プロンプトの shot_type / camera_angle / subject_position / motion / props を必ず構図に反映する (絵コンテとして読めること)。\n\
             5. 画面内テキスト、ロゴ、透かし、グリッド線、コラージュ、複数パネルは禁止。\n\
             6. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
             ## Structured Prompt JSON\n{prompt_json}\n\n\
             最終メッセージは OK または NG <理由> の1行のみ。"
        );
    }

    format!(
        "次の構造化プロンプトに従って、動画ストーリーボード用の画像を1枚だけ生成してください。\n\n\
         ## この画像の役割\n\
         - cutId: {cut_id}\n\
         - takeId: {take_id}\n\
         - 候補 {candidate_index}/{candidate_count}\n\
         - 参照画像は順に、キャラクター基準、スタイル基準、必要なら直前確定カットです。\n\n\
         ## 参照画像の役割 (重要)\n\
         参照画像は順番に以下の役割を持ちます。各画像は「指定された役割」だけを参考にしてください。\n\
         - 1枚目: キャラクター基準画像 — 顔・体型・服のディテールを厳守する。スタイル基準にしてはいけない。\n\
         - 2枚目: スタイル基準画像 (任意) — 全体のルック、色調、ライティング、質感のリファレンス。**最終出力の絵のスタイルはこの画像に従う**。\n\
         - 3枚目: 直前確定カット (任意) — 前後の連続性 (キャラ位置・カット間文脈) の参考。スタイルではない。\n\
         - 4枚目: 絵コンテ画像 (任意、鉛筆スケッチ) — **構図・カメラアングル・キャラ配置・画面内空間のみ参考**。鉛筆線・モノクロ・紙質感などのスタイルは絶対に取り込まない。最終出力は本番カットの写実/カラー画像であるべき。\n\n\
         ## 手順\n\
         1. image_gen ツールを1回だけ呼び出す。\n\
         2. **アスペクト比は必ず {aspect_ratio} にする (縦長指定なら縦長で。勝手に 16:9 横長にしない)**。high quality で生成する。\n\
         3. 画面内テキスト、ロゴ、透かし、グリッド、コラージュ、複数パネルは禁止。\n\
         4. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
         ## ★最重要: framing (構図) を厳守する — カットごとに必ず構図を変える\n\
         Structured Prompt JSON の `framing` は **このカット専用に決められた構図**。絶対に厳守する。\n\
         - `framing.shot_type` の通りに被写体の画面占有率を決める。\n\
           extreme_close=目元など極端な寄り / close=顔のクロースアップ / medium=上半身 / full=全身 / wide=全身+環境 / extreme_wide=大引き。\n\
           **wide 指定なのに顔アップにする、close 指定なのに全身にする、は禁止**。指定通りの寄り引きにする。\n\
         - `framing.camera_angle` の通りにカメラ位置を取る。\n\
           front=正面 / side=真横 / three_quarter=斜め45度 / high=俯瞰(上から) / low=煽り(下から) / dutch=傾き。\n\
           **low 指定なら必ず下から煽る、high 指定なら必ず上から見下ろす**。eye-level に勝手に戻さない。\n\
         - `framing.camera_motion` (dolly_in/out, pan, tilt, handheld 等) の動きが感じられる構図にする。\n\
         - 隣り合うカットは shot_type と camera_angle が必ず異なるよう設計済み。**その差を絵に出す**。\n\
           全カットが「同じ寄りで同じ正面アングル」になるのは絶対 NG。look が似ていても構図は大きく変える。\n\
         - `framing.focus_detail` `framing.body_position_in_frame` `framing.light_fall` も構図に反映する。\n\n\
         ## 重要: Continuity Contract に従う (もし含まれていれば)\n\
         - JSON に `continuity_contract` がある場合、その preserve/change/forbidden/bridge を厳格に守る。\n\
         - `visual_plan.shot_size` `visual_plan.camera_angle` `visual_plan.micro_location` は機械的に決定済み。**揺らがせない**。\n\
         - 特に `camera_angle_directive` の文言通りにカメラ位置を取る。eye-level に勝手に戻さない。\n\
         - `micro_location` は同一大空間内でカメラが移動した位置。「同じ場所でぐるぐる」を避けるため、ここに書かれた位置を厳守する。\n\
         - 「前カットの属性を真似る」のではなく「contract が指示する変化」を作る。\n\
         - `murch_priority` に従い、emotion/story/rhythm を優先。空間整合より感情整合。\n\
         - bridge.cut_on_action がある場合、前カットの末尾動作から自然に繋がる開始姿勢で描く。\n\
         - 人物を動かすのではなく **カメラを動かす** ことで空間に展開を作る。被写体は同じ場所でも、カメラ位置とアングルを変える。\n\n\
         ## Structured Prompt JSON\n{prompt_json}\n\n\
         最終メッセージは OK または NG <理由> の1行のみ。"
    )
}


async fn codex_oneshot(
    codex_bin: &Path,
    prompt: &str,
    image_paths: &[&Path],
    timeout_secs: u64,
    cwd: Option<&str>,
) -> Result<String, String> {
    let mut cmd = Command::new(codex_bin);
    cmd.args([
        "exec",
        // Windows では --full-auto(=--sandbox workspace-write)が
        // codex-windows-sandbox-setup.exe を要求して「見つかりません」で死ぬ。
        // サンドボックス無効の bypass を使う(2026-06-09 Windows修正。--full-auto
        // では直らなかった)。BYO 配布はユーザー自身の PC=外部サンドボックス環境。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &format!("model={STORYBOARD_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={STORYBOARD_EFFORT}"),
    ]);
    if let Some(c) = cwd.filter(|s| !s.is_empty()) {
        cmd.arg("-C").arg(c);
    }
    for img in image_paths {
        cmd.arg("-i").arg(img);
    }
    cmd.arg("-");
    cmd.env("PATH", enriched_path());
    cmd.kill_on_drop(true);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::codex::process::no_window_flag(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
    }

    let output = timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| format!("codex exec が {timeout_secs} 秒でタイムアウトしました"))?
        .map_err(|e| format!("codex exec 待機失敗: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("(stderr 出力なし)");
        return Err(format!(
            "codex exec が異常終了 (code={:?}): {detail}",
            output.status.code()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn extract_json_from_codex_stdout(stdout: &str) -> Result<Value, String> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                return Ok(value);
            }
        }
    }

    let codex_marker_pos = stdout
        .rfind("\ncodex\n")
        .map(|idx| idx + "\ncodex\n".len())
        .unwrap_or(0);
    let response_section = &stdout[codex_marker_pos..];
    if let Some(value) = extract_first_json_object(response_section) {
        return Ok(value);
    }

    if let Some(value) = extract_first_json_object(stdout) {
        return Ok(value);
    }

    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("JSON extract failed (all strategies): {e}"))
}

fn extract_first_json_object(input: &str) -> Option<Value> {
    let start = input.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    let bytes = input[start..].as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    let json_str = &input[start..start + i + 1];
                    if let Ok(value) = serde_json::from_str::<Value>(json_str) {
                        return Some(value);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// 生成された take から採用する1枚を選ぶ。
/// 2026-06-06 STΛCK 指示で AI 評価ループを撤去したため、常に最初の take を採用する
/// (残りは候補として Phase 4 でユーザーが手動切替)。
fn select_first_take(takes: &[EvaluatedTake]) -> Option<EvaluatedTake> {
    takes.first().cloned()
}

fn mark_manifest_take_status(takes: &mut [ManifestTake], selected_take_id: &str, status: &str) {
    for take in takes {
        if take.take_id == selected_take_id {
            take.status = status.to_string();
        } else if take.status == status {
            take.status = "candidate".into();
        }
    }
}

fn build_reference_images(
    char_ref: &Path,
    extra_char_refs: &[PathBuf],
    style_ref: &Path,
    extra_style_refs: &[PathBuf],
    previous_cut: Option<&Path>,
    sketch_ref: Option<&Path>,
) -> Vec<PathBuf> {
    // キャラ参照は任意 (2026-06-08 参照任意化)。空パスのときは追加しない。
    // 無ければ後続の style/previous/sketch だけ、または参照ゼロ(テキスト生成)になる。
    let mut refs: Vec<PathBuf> = Vec::new();
    if !char_ref.as_os_str().is_empty() {
        refs.push(char_ref.to_path_buf());
    }
    // FB#3 (2026-06-06): 追加のキャラ参照 (登場キャラ全員) を char_ref の直後に並べる。
    // 重複は除く。先頭キャラの直後に置くことで「全員がキャラ基準」と認識させる。
    for c in extra_char_refs {
        if !refs.contains(c) {
            refs.push(c.clone());
        }
    }
    if style_ref != char_ref && !refs.contains(&style_ref.to_path_buf()) {
        refs.push(style_ref.to_path_buf());
    }
    for s in extra_style_refs {
        if !refs.contains(s) {
            refs.push(s.clone());
        }
    }
    if let Some(previous) = previous_cut {
        refs.push(previous.to_path_buf());
    }
    // P12 (2026-05-20 STΛCK 指示): 絵コンテ画像を参考画像として追加。
    // 構図を絵コンテに沿って誘導するため、char/style/previous の後ろに置く。
    if let Some(sketch) = sketch_ref {
        refs.push(sketch.to_path_buf());
    }
    refs
}

fn mirror_codex_home(codex_home_orig: &Path, tmp_home: &Path) -> Result<(), String> {
    if codex_home_orig.exists() {
        let entries = std::fs::read_dir(codex_home_orig)
            .map_err(|e| format!("CODEX_HOME 読み込み失敗: {e}"))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == OsStr::new("generated_images") {
                continue;
            }
            let dest = tmp_home.join(&name);
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(entry.path(), dest);
            }
            #[cfg(not(unix))]
            {
                if entry.path().is_dir() {
                    let _ = std::fs::create_dir_all(dest);
                } else {
                    let _ = std::fs::copy(entry.path(), dest);
                }
            }
        }
    }
    std::fs::create_dir_all(tmp_home.join("generated_images"))
        .map_err(|e| format!("storyboard generated_images 作成失敗: {e}"))?;
    Ok(())
}

fn find_newest_generated_png(root: &Path) -> Option<PathBuf> {
    let mut newest: Option<(u128, PathBuf)> = None;
    collect_generated_pngs(root, &mut newest);
    newest.map(|(_, path)| path)
}

fn collect_generated_pngs(dir: &Path, newest: &mut Option<(u128, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_generated_pngs(&path, newest);
            continue;
        }
        // 保存名は codex 世代・経路で変わる(ig_*/call_*/exec-*)。名前に依存せず
        // ワーカー専用 generated_images 配下の PNG を回収する(2026-07-17)。
        let is_png = path.is_file()
            && path
                .extension()
                .and_then(OsStr::to_str)
                .map(|e| e.eq_ignore_ascii_case("png"))
                .unwrap_or(false);
        if !is_png {
            continue;
        }
        let mtime = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        match newest {
            Some((best_time, _)) if *best_time > mtime => {}
            _ => *newest = Some((mtime, path)),
        }
    }
}

fn build_scene_groups(cuts: &[CutPlan]) -> Vec<SceneGroup> {
    let mut groups: Vec<SceneGroup> = Vec::new();
    for cut in cuts {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.id == cut.scene_group_id)
        {
            group.cut_ids.push(cut.cut_id.clone());
        } else {
            groups.push(SceneGroup {
                id: cut.scene_group_id.clone(),
                cut_ids: vec![cut.cut_id.clone()],
                intent: None,
                primary_location: None,
            });
        }
    }
    groups
}

fn local_cut_plan(params: &StoryboardParams) -> Vec<CutPlan> {
    let count = compute_cut_count(params.duration_seconds, &params.tempo);
    local_cut_plan_with_count(params, count)
}

fn local_cut_plan_with_count(params: &StoryboardParams, count: u32) -> Vec<CutPlan> {
    let count = count.max(1);
    let per_cut = params.duration_seconds / count as f64;
    (0..count)
        .map(|idx| {
            let description = format!(
                "{} / storyboard beat {} of {}",
                params.story_prompt,
                idx + 1,
                count
            );
            let group = if idx == 0 {
                local_scene_group_id(&params.story_prompt)
            } else {
                local_scene_group_id(&description)
            };
            CutPlan {
                cut_id: format!("shot_{:03}", idx + 1),
                scene_group_id: group,
                description,
                duration_seconds: per_cut,
                prefilled: None,
            }
        })
        .collect()
}

fn compute_cut_count(duration_seconds: f64, tempo: &str) -> u32 {
    let seconds_per_cut = match tempo {
        "fast" => 1.75,
        "slow" => 4.0,
        _ => 2.5,
    };
    (duration_seconds / seconds_per_cut).ceil().max(1.0) as u32
}

/// ユーザーが UI で選んだ生成枚数 (1〜3) をそのまま尊重する。
///
/// 旧実装は `2 => 3` に勝手に繰り上げており、「2枚指定したのに3枚生成される」
/// バグの原因だった (STΛCK 報告 2026-06-06)。ユーザーの指定枚数 = 実生成枚数に
/// 一致させる。0 のときだけ最低 1 枚を保証し、上限は 3 にクランプする
/// (UI が 1〜3 しか出さないので実質クランプは保険)。
fn normalize_candidates(value: u32) -> u32 {
    value.clamp(1, 3)
}

fn local_scene_group_id(text: &str) -> String {
    let lower = text.to_lowercase();
    let location = if contains_any(
        &lower,
        &["部屋", "家", "リビング", "寝室", "キッチン", "home", "room"],
    ) {
        "Home"
    } else if contains_any(&lower, &["カフェ", "店内", "cafe"]) {
        "Cafe"
    } else if contains_any(&lower, &["電車", "車内", "train"]) {
        "TrainInterior"
    } else if contains_any(&lower, &["駅", "station"]) {
        "Station"
    } else if contains_any(&lower, &["街", "道", "street", "city"]) {
        "Street"
    } else if contains_any(&lower, &["公園", "park"]) {
        "Park"
    } else if contains_any(&lower, &["夢", "回想", "memory", "dream", "flashback"]) {
        "Dream"
    } else {
        "Scene"
    };
    let time = if contains_any(&lower, &["朝", "morning"]) {
        "morning"
    } else if contains_any(&lower, &["昼", "noon", "day"]) {
        "day"
    } else if contains_any(&lower, &["夕", "evening", "sunset"]) {
        "evening"
    } else if contains_any(&lower, &["夜", "night"]) {
        "night"
    } else {
        "main"
    };
    sanitize_group_id(&format!("{time}{location}"))
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn sanitize_group_id(value: &str) -> String {
    let mut out = String::new();
    let mut capitalize_next = false;
    for (idx, ch) in value.chars().enumerate() {
        if ch.is_ascii_alphanumeric() {
            if idx == 0 {
                out.push(ch.to_ascii_lowercase());
            } else if capitalize_next {
                out.push(ch.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                out.push(ch);
            }
        } else {
            capitalize_next = true;
        }
    }
    if out.is_empty() {
        "mainScene".into()
    } else {
        out
    }
}

fn infer_shot_type(action: &str) -> &'static str {
    // Extreme close-up: tight focus on hands, eyes, small objects.
    if contains_any(
        action,
        &[
            "手元",
            "指",
            "ボタン",
            "レバー",
            "配線",
            "つまみ",
            "ネジ",
            "目に反射",
            "瞳",
            "瞼",
            "瞬き",
            "涙",
            "knob",
            "lever",
            "wire",
            "button",
            "trigger",
        ],
    ) {
        "extreme close-up"
    // Close-up: face, expression, reaction, glow on face.
    } else if contains_any(
        action,
        &[
            "見つめる",
            "凝視",
            "驚",
            "息を呑",
            "目を見開",
            "微笑",
            "安堵",
            "顔",
            "表情",
            "笑う",
            "泣く",
            "stare",
            "gaze",
            "smile",
            "shocked",
        ],
    ) {
        "close-up"
    // Wide / establishing: location, environment, scale, magic spreading.
    } else if contains_any(
        action,
        &[
            "全体",
            "包まれ",
            "広がる",
            "満たさ",
            "工房",
            "研究室",
            "街",
            "establishing",
            "panorama",
            "vista",
        ],
    ) {
        "wide shot"
    // Movement: walk / run / enter / exit.
    } else if contains_any(
        action,
        &[
            "歩", "走", "近づ", "離れ", "入", "出", "jump", "walk", "run",
        ],
    ) {
        "wide shot"
    // Turn / look around.
    } else if contains_any(action, &["振り返", "見渡", "look", "turn"]) {
        "medium shot"
    } else {
        "medium-wide"
    }
}

/// Pick a shot type that satisfies adjacent diversity (avoid repeating the previous cut's type).
fn pick_diverse_shot_type(action: &str, previous: &[String]) -> &'static str {
    let preferred = infer_shot_type(action);
    if let Some(last) = previous.last() {
        if last == preferred {
            // Same as immediately previous; swap to a different family.
            return swap_to_alternative_shot(preferred);
        }
    }
    preferred
}

fn swap_to_alternative_shot(current: &str) -> &'static str {
    match current {
        "extreme close-up" => "wide shot",
        "close-up" => "medium-wide",
        "medium close-up" => "wide shot",
        "medium shot" => "close-up",
        "medium-wide" => "close-up",
        "wide shot" => "close-up",
        "extreme wide" => "close-up",
        _ => "medium-wide",
    }
}

/// Rotate camera_angle across the sequence so consecutive cuts do not pile up the same value.
fn pick_diverse_camera_angle(action: &str, cut_index: usize) -> &'static str {
    // Verb-driven hints first.
    if contains_any(action, &["見上", "look up"]) {
        return "low angle";
    }
    if contains_any(action, &["見下", "look down"]) {
        return "high angle";
    }
    if contains_any(action, &["異変", "歪", "崩", "震", "揺れ"]) {
        return "dutch angle";
    }
    if contains_any(action, &["手元", "操作", "knob", "lever", "wire"]) {
        return "top-down";
    }
    if contains_any(action, &["全体", "包まれ", "広がる", "壮大"]) {
        return "low angle";
    }
    // Fallback: rotate through a varied set based on cut index.
    const ROTATION: &[&str] = &[
        "eye-level",
        "low angle",
        "high angle",
        "dutch angle",
        "eye-level",
        "top-down",
    ];
    ROTATION[cut_index % ROTATION.len()]
}

fn infer_motion_room(action: &str) -> &'static str {
    if contains_any(action, &["歩", "走", "近づ", "walk", "run", "approach"]) {
        "preserve depth and lead room in the movement direction"
    } else if contains_any(action, &["入", "出", "enter", "exit"]) {
        "leave usable negative space near the frame edge"
    } else if contains_any(action, &["見上", "見下", "look up", "look down"]) {
        "preserve vertical head room for gaze direction"
    } else {
        "preserve enough room for implied video motion"
    }
}

fn take_label(index: u32) -> String {
    if index < 26 {
        ((b'A' + index as u8) as char).to_string()
    } else {
        format!("T{}", index + 1)
    }
}

async fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("JSON serialize failed: {e}"))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|e| format!("{} 書き込み失敗: {e}", path.display()))
}

fn timestamp_id() -> String {
    now_secs().to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos & 0xffff_ffff)
}
