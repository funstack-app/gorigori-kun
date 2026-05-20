//! Rust-side orchestrator for GORI storyboard generation.
//!
//! The `gori-storyboard` skill files are used as prompt/reference material only.
//! Progress events are owned and emitted by Rust on `codex://storyboard`.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_STORYBOARD;
use crate::state::AppState;

const PROMPT_TIMEOUT_SECS: u64 = 120;
const EVALUATION_TIMEOUT_SECS: u64 = 120;
const GENERATION_TIMEOUT_SECS: u64 = 900;
const MAX_RETRIES_PER_CUT: u32 = 2;
const STORYBOARD_MODEL: &str = "gpt-5.5";
const STORYBOARD_EFFORT: &str = "low";

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardParams {
    pub story_prompt: String,
    pub character_reference_image: String,
    pub style_reference_image: Option<String>,
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
            dirs::home_dir()
                .map(|home| {
                    home.join(".codex/generated_images")
                        .join(&leaf)
                        .join("debug-log.json")
                })
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
    _state: State<'_, AppState>,
    params: StoryboardParams,
) -> Result<String, String> {
    let codex_home_orig = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
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

    tokio::spawn(async move {
        if let Err(err) = run_storyboard_orchestrator(
            app.clone(),
            codex_bin,
            codex_home_orig,
            task_run_id,
            params,
        )
        .await
        {
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

async fn run_storyboard_orchestrator(
    app: AppHandle,
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
    let mut cuts = plan_cuts(&codex_bin, &params, &skill_refs)
        .await
        .unwrap_or_else(|err| {
            tracing::warn!(target: "codex.storyboard", "scene planning fallback: {err}");
            local_cut_plan(&params)
        });
    if cuts.is_empty() {
        cuts = local_cut_plan(&params);
    }
    let scene_groups = build_scene_groups(&cuts);
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
    let mut previous_cut_image: Option<PathBuf> = None;
    let mut manifest_cuts: Vec<ManifestCut> = Vec::new();
    let mut debug_prompts: Vec<DebugPromptEntry> = Vec::new();
    let mut previous_shot_types: Vec<String> = Vec::new();
    let mut aborted = false;
    let cuts_count = cuts.len();

    for (cut_index, cut) in cuts.iter().enumerate() {
        let _ = app.emit(
            EVENT_STORYBOARD,
            StoryboardEvent::CutStarted {
                cut_id: cut.cut_id.clone(),
                scene_group_id: cut.scene_group_id.clone(),
                take_count: candidates_per_cut,
            },
        );

        let structured_prompt = build_structured_prompt(
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
        });
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
        let mut global_take_index = 0u32;

        for attempt in 0..=MAX_RETRIES_PER_CUT {
            let reference_images = build_reference_images(
                &char_ref_path,
                &style_ref_path,
                previous_cut_image.as_deref(),
            );
            let take_specs = (0..candidates_per_cut)
                .map(|idx| {
                    let take_id = take_label(global_take_index + idx);
                    (take_id, idx + 1)
                })
                .collect::<Vec<_>>();
            global_take_index += candidates_per_cut;

            let generated = generate_cut_takes(
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
                        // sketch_mode 時は評価をスキップ (鉛筆絵コンテはキャラ一貫性の
                        // 評価に通らない設計なので、評価ループは絵コンテと噛み合わない)。
                        // STΛCK 報告 (2026-05-20): 評価ループで shot_001 が何度も
                        // 再生成され続けて絵コンテ生成が異常に遅くなる問題への対応。
                        let scores = if params.sketch_mode {
                            ScoreBundle::default()
                        } else {
                            match evaluate_one_take(
                                &codex_bin,
                                &image_path,
                                &char_ref_path,
                                Some(&style_ref_path),
                                previous_cut_image.as_deref(),
                                &skill_refs.evaluator_rubric,
                                params.cwd.as_deref(),
                            )
                            .await
                            {
                                Ok(scores) => scores,
                                Err(err) => {
                                    tracing::warn!(target: "codex.storyboard", "evaluation failed for {} {}: {err}", cut.cut_id, take_id);
                                    ScoreBundle::default()
                                }
                            }
                        };
                        let image_path_string = image_path.to_string_lossy().into_owned();
                        let _ = app.emit(
                            EVENT_STORYBOARD,
                            StoryboardEvent::TakeCompleted {
                                cut_id: cut.cut_id.clone(),
                                take_id: take_id.clone(),
                                image_path: image_path_string.clone(),
                                scores: scores.clone(),
                            },
                        );
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

            // sketch_mode は評価スコアを使わず最初の take を即採用、再試行も無し。
            let picked = if params.sketch_mode {
                select_first_take(&evaluated_takes)
            } else {
                select_best_take(&evaluated_takes)
            };
            if let Some(best) = picked {
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
                break;
            }

            if attempt < MAX_RETRIES_PER_CUT {
                last_failure = format!(
                    "{}: 全候補が評価しきい値未満のため再生成します ({}/{})",
                    cut.cut_id,
                    attempt + 1,
                    MAX_RETRIES_PER_CUT
                );
                tracing::warn!(target: "codex.storyboard", "{last_failure}");
            }
        }

        if selected.is_none() {
            let reason = if last_failure.trim().is_empty() {
                "all takes below threshold after 2 retries".to_string()
            } else {
                format!("all takes below threshold after 2 retries: {last_failure}")
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

        if cut_index == 2 {
            let _ = app.emit(
                EVENT_STORYBOARD,
                StoryboardEvent::CutCheckpoint {
                    cut_id: cut.cut_id.clone(),
                    reason: "midRun review at cut 3".into(),
                },
            );
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
    if params.character_reference_image.trim().is_empty() {
        return Err("characterReferenceImage must not be empty".into());
    }
    if !Path::new(&params.character_reference_image).is_file() {
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
    let home = dirs::home_dir().ok_or_else(|| "home dir not found".to_string())?;
    let skill_dir = home.join(".codex/skills/gori-storyboard");
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
        planned.push(CutPlan {
            cut_id: cut
                .cut_id
                .clone()
                .unwrap_or_else(|| format!("shot_{:03}", idx + 1)),
            scene_group_id,
            description,
            duration_seconds: cut.duration_seconds.unwrap_or(fallback_duration),
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
    let tasks = take_specs
        .iter()
        .map(|(take_id, idx)| {
            generate_one_take(
                codex_bin,
                codex_home_orig,
                structured_prompt,
                reference_images,
                output_dir,
                cut_id,
                take_id,
                *idx,
                take_specs.len() as u32,
                cwd.clone(),
                aspect_ratio,
                sketch_mode,
            )
        })
        .collect::<Vec<_>>();
    join_all(tasks).await
}

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
        "--sandbox",
        "workspace-write",
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

    let src_png = find_newest_generated_png(&tmp_gen)
        .ok_or_else(|| format!("生成画像が見つかりませんでした: {cut_id} {take_id}"))?;
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
         ## 手順\n\
         1. image_gen ツールを1回だけ呼び出す。\n\
         2. {aspect_ratio} aspect ratio / high quality で生成する。\n\
         3. 画面内テキスト、ロゴ、透かし、グリッド、コラージュ、複数パネルは禁止。\n\
         4. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
         ## Structured Prompt JSON\n{prompt_json}\n\n\
         最終メッセージは OK または NG <理由> の1行のみ。"
    )
}

async fn evaluate_one_take(
    codex_bin: &Path,
    image_path: &Path,
    char_ref: &Path,
    style_ref: Option<&Path>,
    previous_cut: Option<&Path>,
    evaluator_rubric: &str,
    cwd: Option<&str>,
) -> Result<ScoreBundle, String> {
    let mut image_paths: Vec<&Path> = vec![image_path, char_ref];
    if let Some(style) = style_ref {
        if style != char_ref {
            image_paths.push(style);
        }
    }
    if let Some(previous) = previous_cut {
        image_paths.push(previous);
    }

    let prompt = format!(
        "You are the GORI Storyboard evaluator. Reference this rubric.\n\n\
         {evaluator_rubric}\n\n\
         Score the first image (candidate) against the attached references.\n\
         Attached image order: 1=candidate, 2=character reference, 3=style reference if present, last=previous confirmed cut if present.\n\
         Return ONLY a JSON object matching this shape:\n\
         {{\"scores\":{{\"identity\":N,\"outfit\":N,\"prop\":N,\"face\":N,\"hand\":N,\"background\":N}},\"warnings\":[],\"decision\":\"adoptable|warning|reject\",\"reason\":\"...\"}}\n\
         No prose, no markdown."
    );
    let raw = codex_oneshot(
        codex_bin,
        &prompt,
        &image_paths,
        EVALUATION_TIMEOUT_SECS,
        cwd,
    )
    .await?;
    let json = extract_json_from_codex_stdout(&raw)?;
    let scores_value = json.get("scores").cloned().unwrap_or(json);
    serde_json::from_value(scores_value).map_err(|e| format!("score parse failed: {e}"))
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
        "--sandbox",
        "workspace-write",
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

fn select_best_take(takes: &[EvaluatedTake]) -> Option<EvaluatedTake> {
    takes
        .iter()
        .filter(|take| !has_reject_score(&take.scores))
        .max_by(|a, b| {
            weighted_score(&a.scores)
                .partial_cmp(&weighted_score(&b.scores))
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    a.scores
                        .background
                        .partial_cmp(&b.scores.background)
                        .unwrap_or(Ordering::Equal)
                })
        })
        .cloned()
}

/// sketch_mode 用: 評価スコアを無視し、最初に生成された take を採用する。
/// STΛCK 報告 (2026-05-20): 鉛筆絵コンテはキャラ一貫性の評価に通らない
/// 設計なので、評価ベースの絞り込みは絵コンテと噛み合わない。
fn select_first_take(takes: &[EvaluatedTake]) -> Option<EvaluatedTake> {
    takes.first().cloned()
}

fn has_reject_score(scores: &ScoreBundle) -> bool {
    scores.identity < 50.0
        || scores.outfit < 50.0
        || scores.prop < 50.0
        || scores.face < 50.0
        || scores.hand < 50.0
        || scores.background < 50.0
}

fn weighted_score(scores: &ScoreBundle) -> f64 {
    scores.identity * 1.4
        + scores.outfit * 1.3
        + scores.face * 1.4
        + scores.hand * 1.4
        + scores.prop
        + scores.background
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
    style_ref: &Path,
    previous_cut: Option<&Path>,
) -> Vec<PathBuf> {
    let mut refs = vec![char_ref.to_path_buf()];
    if style_ref != char_ref {
        refs.push(style_ref.to_path_buf());
    }
    if let Some(previous) = previous_cut {
        refs.push(previous.to_path_buf());
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
        let is_ig_png = path.extension().and_then(OsStr::to_str) == Some("png")
            && path
                .file_name()
                .and_then(OsStr::to_str)
                .map(|name| name.starts_with("ig_"))
                .unwrap_or(false);
        if !is_ig_png {
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

fn normalize_candidates(value: u32) -> u32 {
    match value {
        0 => 1,
        1 => 1,
        _ => 3,
    }
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
