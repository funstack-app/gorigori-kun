//! Rust-side orchestrator for GORI multi-angle generation.
//!
//! 1枚の被写体参照画像から、選んだ構図カット (最大30) を【並列】で一気に生成する。
//! storyboard.rs と違い、ストーリー対話・絵コンテ・AI評価器・連続性契約・180度ルール・
//! カット役割割当は持たない。各カットは独立した1枚画像で、生成された1枚をそのまま採用する。
//!
//! 共通ユーティリティ (codex_oneshot / extract_json_from_codex_stdout) は storyboard.rs
//! からコピーして独立させている。
//! 1カット生成の下部構造 (generate_one_cut / attempt_one_cut / mirror_codex_home /
//! find_newest_generated_png / collect_generated_pngs / timestamp_id / short_id) は
//! 段階3 (キャラシート追加) で commands/gen_worker.rs へ括り出し、両者から共用する。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_worker::{
    generate_one_cut, short_id, timestamp_id, GENERATION_EFFORT, GENERATION_MODEL,
};
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_MULTIANGLE;
use crate::state::AppState;

/// 選択上限。フロント側 MAX_CUTS と一致させる。
const MAX_CUTS: usize = 30;

/// フロントから渡る各カットの構図指定。
/// `src/lib/multiangle/angles.ts` の AngleCut から { id, label, promptFragment } を抜いたもの。
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CutPromptSpec {
    pub cut_id: String,
    pub label: String,
    pub prompt_fragment: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiAngleParams {
    /// 被写体参照画像 (必須・1枚)。
    pub character_image: String,
    /// 環境・ライティングを固定する指示文 (任意)。
    #[serde(default)]
    pub environment_description: String,
    /// "1:1" | "9:16" | "16:9" | "4:5" など。
    pub aspect_ratio: String,
    /// 選択されたカット ID の配列 (cut_prompts と同順を想定するが、検証は cut_prompts を正とする)。
    #[serde(default)]
    pub cut_ids: Vec<String>,
    /// 各カットの構図プロンプト指定 (ANGLE_CUTS の選択分)。
    pub cut_prompts: Vec<CutPromptSpec>,
    /// 出力先プロジェクト判定用の cwd (任意)。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 被写体の種別。"character"(人物・既定) or "product"(商品)。
    /// 未指定なら "character" 扱いで従来と完全に同一のプロンプトになる (後方互換)。
    /// 人物向けの「顔・体型・服を維持」「画面内テキスト・ロゴ禁止」は product では出さない。
    #[serde(default)]
    pub subject_kind: Option<String>,
    /// フロントが先に採番する run_id (任意)。渡された場合はそれを使い、
    /// beginRun 時点から確定 run_id を持てるようにする。
    /// 省略時はバックエンドで採番し、既存の呼び出しとの互換性を保つ。
    #[serde(default)]
    pub run_id: Option<String>,
}

/// この run を識別するトークン。共有イベントチャンネル上で別スキルの通知を
/// フロントが確実に除外できるよう、全バリアントに載せる。
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MultiAngleEvent {
    Started {
        run_id: String,
        total: u32,
    },
    CutStarted {
        run_id: String,
        cut_id: String,
        label: String,
        index: u32,
    },
    CutCompleted {
        run_id: String,
        cut_id: String,
        label: String,
        image_path: String,
    },
    CutFailed {
        run_id: String,
        cut_id: String,
        reason: String,
    },
    Completed {
        run_id: String,
        output_dir: String,
    },
}

#[tauri::command]
pub async fn multiangle_run(
    app: AppHandle,
    _state: State<'_, AppState>,
    params: MultiAngleParams,
) -> Result<String, String> {
    // app-server と同じ GORI 専用 CODEX_HOME を使う。worker は mirror_codex_home で
    // この HOME から auth/config/skills を一時 HOME に複製する。
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    let run_id = match params.run_id.as_deref() {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => format!("{}-{}", timestamp_id(), short_id()),
    };
    let task_run_id = run_id.clone();
    let fail_run_id = run_id.clone();

    tokio::spawn(async move {
        if let Err(err) =
            run_multiangle_orchestrator(app.clone(), codex_bin, codex_home_orig, task_run_id, params)
                .await
        {
            tracing::warn!(target: "codex.multiangle", "multiangle orchestrator failed: {err}");
            let _ = app.emit(
                EVENT_MULTIANGLE,
                MultiAngleEvent::CutFailed {
                    run_id: fail_run_id,
                    cut_id: "unknown".into(),
                    reason: err,
                },
            );
        }
    });

    Ok(run_id)
}

/// 単一カット再生成。該当カットだけ再度1枚生成して CutCompleted / CutFailed を再emit する。
#[tauri::command]
pub async fn multiangle_regenerate_cut(
    app: AppHandle,
    _state: State<'_, AppState>,
    run_id: String,
    cut_id: String,
    params: MultiAngleParams,
) -> Result<String, String> {
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;

    let character_path = PathBuf::from(&params.character_image);
    if !character_path.is_file() {
        return Err(format!(
            "被写体参照画像が見つかりません: {}",
            params.character_image
        ));
    }

    let cut = params
        .cut_prompts
        .iter()
        .find(|c| c.cut_id == cut_id)
        .cloned()
        .ok_or_else(|| format!("再生成対象のカットが見つかりません: {cut_id}"))?;

    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(params.cwd.as_deref());
    let out_dir = resolve_output_dir(
        &storage_settings,
        project_name.as_deref(),
        &format!("gori-multiangle-{run_id}"),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("multiangle 出力先作成失敗: {e}"))?;

    let task_app = app.clone();
    let cwd = params.cwd.clone();
    let aspect_ratio = params.aspect_ratio.clone();
    let environment = params.environment_description.clone();
    let subject_kind = resolve_subject_kind(&params);
    let event_run_id = run_id.clone();

    tokio::spawn(async move {
        let prompt = build_multiangle_prompt(&cut, &aspect_ratio, &environment, subject_kind);
        let _ = task_app.emit(
            EVENT_MULTIANGLE,
            MultiAngleEvent::CutStarted {
                run_id: event_run_id.clone(),
                cut_id: cut.cut_id.clone(),
                label: cut.label.clone(),
                index: 0,
            },
        );
        match generate_one_cut(
            &task_app,
            &codex_bin,
            &codex_home_orig,
            &prompt,
            &[character_path],
            &out_dir,
            &cut.cut_id,
            cwd,
        )
        .await
        {
            Ok(image_path) => {
                let _ = task_app.emit(
                    EVENT_MULTIANGLE,
                    MultiAngleEvent::CutCompleted {
                        run_id: event_run_id,
                        cut_id: cut.cut_id,
                        label: cut.label,
                        image_path: image_path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(err) => {
                tracing::warn!(target: "codex.multiangle", "regenerate_cut failed: {err}");
                let _ = task_app.emit(
                    EVENT_MULTIANGLE,
                    MultiAngleEvent::CutFailed {
                        run_id: event_run_id,
                        cut_id: cut.cut_id,
                        reason: err,
                    },
                );
            }
        }
    });

    Ok(cut_id)
}

async fn run_multiangle_orchestrator(
    app: AppHandle,
    codex_bin: PathBuf,
    codex_home_orig: PathBuf,
    run_id: String,
    params: MultiAngleParams,
) -> Result<(), String> {
    validate_params(&params)?;

    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(params.cwd.as_deref());
    let out_dir = resolve_output_dir(
        &storage_settings,
        project_name.as_deref(),
        &format!("gori-multiangle-{run_id}"),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("multiangle 出力先作成失敗: {e}"))?;

    let total = params.cut_prompts.len() as u32;
    let _ = app.emit(
        EVENT_MULTIANGLE,
        MultiAngleEvent::Started {
            run_id: run_id.clone(),
            total,
        },
    );

    let character_path = PathBuf::from(&params.character_image);
    let aspect_ratio = params.aspect_ratio.clone();
    let environment = params.environment_description.clone();
    let cwd = params.cwd.clone();
    let subject_kind = resolve_subject_kind(&params);

    // ★並列。選んだ全カットを一気に走らせる。同時実行の制御は
    // gen_queue::GLOBAL_GEN_SEMAPHORE(全機能共通・上限6)に一本化(2026-07-17)。
    let tasks = params
        .cut_prompts
        .iter()
        .enumerate()
        .map(|(index, cut)| {
            let app = app.clone();
            let codex_bin = codex_bin.clone();
            let codex_home_orig = codex_home_orig.clone();
            let character_path = character_path.clone();
            let out_dir = out_dir.clone();
            let aspect_ratio = aspect_ratio.clone();
            let environment = environment.clone();
            let cwd = cwd.clone();
            let cut = cut.clone();
            let event_run_id = run_id.clone();
            async move {

                let _ = app.emit(
                    EVENT_MULTIANGLE,
                    MultiAngleEvent::CutStarted {
                        run_id: event_run_id.clone(),
                        cut_id: cut.cut_id.clone(),
                        label: cut.label.clone(),
                        index: index as u32,
                    },
                );
                let prompt = build_multiangle_prompt(&cut, &aspect_ratio, &environment, subject_kind);
                match generate_one_cut(
                    &app,
                    &codex_bin,
                    &codex_home_orig,
                    &prompt,
                    &[character_path],
                    &out_dir,
                    &cut.cut_id,
                    cwd,
                )
                .await
                {
                    Ok(image_path) => {
                        let _ = app.emit(
                            EVENT_MULTIANGLE,
                            MultiAngleEvent::CutCompleted {
                                run_id: event_run_id.clone(),
                                cut_id: cut.cut_id.clone(),
                                label: cut.label.clone(),
                                image_path: image_path.to_string_lossy().into_owned(),
                            },
                        );
                    }
                    Err(err) => {
                        tracing::warn!(target: "codex.multiangle", "cut {} failed: {err}", cut.cut_id);
                        let _ = app.emit(
                            EVENT_MULTIANGLE,
                            MultiAngleEvent::CutFailed {
                                run_id: event_run_id.clone(),
                                cut_id: cut.cut_id.clone(),
                                reason: err,
                            },
                        );
                    }
                }
            }
        })
        .collect::<Vec<_>>();
    join_all(tasks).await;

    let _ = app.emit(
        EVENT_MULTIANGLE,
        MultiAngleEvent::Completed {
            run_id,
            output_dir: out_dir.to_string_lossy().into_owned(),
        },
    );

    Ok(())
}

fn validate_params(params: &MultiAngleParams) -> Result<(), String> {
    if params.character_image.trim().is_empty() {
        return Err("characterImage must not be empty".into());
    }
    if !Path::new(&params.character_image).is_file() {
        return Err(format!(
            "被写体参照画像が見つかりません: {}",
            params.character_image
        ));
    }
    if params.cut_prompts.is_empty() {
        return Err("生成するカットが1個も選択されていません".into());
    }
    if params.cut_prompts.len() > MAX_CUTS {
        return Err(format!(
            "選択カットが上限 {MAX_CUTS} を超えています ({} 個)",
            params.cut_prompts.len()
        ));
    }
    Ok(())
}

/// 被写体の種別。人物(既定)と商品でプロンプトの同一性維持句を切り替える。
#[derive(Clone, Copy, PartialEq, Eq)]
enum SubjectKind {
    Character,
    Product,
}

/// params.subject_kind を SubjectKind に解決する。未指定/未知の値は Character(後方互換)。
fn resolve_subject_kind(params: &MultiAngleParams) -> SubjectKind {
    match params.subject_kind.as_deref() {
        Some("product") => SubjectKind::Product,
        _ => SubjectKind::Character,
    }
}

/// 構図プロンプトを組み立てる。storyboard の build_generation_prompt を参考にしつつ
/// 大幅簡略化 (structured_prompt JSON も continuity も評価も不要)。
///
/// subject_kind == Character のときは従来と完全に同一の文字列を返す (後方互換)。
/// Product のときは同一性維持句を商品向け(形状/色/ラベル/ロゴ維持・別商品にしない)へ差し替え、
/// 人物向けの「顔・体型・服」「画面内テキスト・ロゴ禁止」は出さない。
fn build_multiangle_prompt(
    cut: &CutPromptSpec,
    aspect_ratio: &str,
    environment: &str,
    subject_kind: SubjectKind,
) -> String {
    let environment_line = if environment.trim().is_empty() {
        String::new()
    } else {
        format!("\n- 環境・背景・ライティングは次の指示で固定する: {}\n", environment.trim())
    };
    match subject_kind {
        SubjectKind::Character => format!(
            "添付したキャラクター参照画像を使い、次の構図で画像を1枚だけ生成してください。\n\n\
             ## この画像の役割\n\
             - 構図 (英語指定): {prompt_fragment}\n{environment_line}\n\
             ## 厳守事項\n\
             1. 被写体の同一性 (顔・体型・服) を参照画像から厳密に保つ。別人にしない。\n\
             2. 環境・背景・ライティングは一貫させる。カメラだけが被写体の周りを移動したように見せる。\n\
             3. 上記「構図 (英語指定)」のショット距離・カメラアングル・向きを正確に反映する。\n\
             4. カメラ視点 (位置・距離・パース・被写体の見え方) は、前のアングルと見間違えないくらい大胆にはっきり変える。煽り・俯瞰・斜め・横顔などの違いを誇張気味に強調する。ただし顔・体型・服・環境の同一性は崩さない (変えるのはカメラだけ)。\n\
             5. image_gen ツールを1回だけ呼び出す。\n\
             6. アスペクト比は必ず {aspect_ratio} にする (縦長指定なら縦長で。勝手に 16:9 にしない)。high quality で生成する。\n\
             7. 画面内テキスト、ロゴ、透かし、グリッド、コラージュ、複数パネルは禁止。1枚の単独画像にする。\n\
             8. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
             最終メッセージは OK または NG <理由> の1行のみ。",
            prompt_fragment = cut.prompt_fragment,
            environment_line = environment_line,
            aspect_ratio = aspect_ratio,
        ),
        SubjectKind::Product => format!(
            "添付した商品参照画像を使い、次の構図で画像を1枚だけ生成してください。\n\n\
             ## この画像の役割\n\
             - 構図 (英語指定): {prompt_fragment}\n{environment_line}\n\
             ## 厳守事項\n\
             1. 商品の同一性 (形状・色・素材・ラベル・ロゴ・刻印) を参照画像から厳密に保つ。別商品にしない。ラベルやロゴの文字・配置も改変しない。\n\
             2. 環境・背景・ライティングは一貫させる。カメラだけが商品の周りを移動したように見せる。\n\
             3. 上記「構図 (英語指定)」のショット距離・カメラアングル・向きを正確に反映する。\n\
             4. カメラ視点 (位置・距離・パース・商品の見え方) は、前のアングルと見間違えないくらい大胆にはっきり変える。俯瞰・煽り・斜め・真横などの違いを誇張気味に強調する。ただし商品の形状・色・ラベル・ロゴ・環境の同一性は崩さない (変えるのはカメラだけ)。\n\
             5. image_gen ツールを1回だけ呼び出す。\n\
             6. アスペクト比は必ず {aspect_ratio} にする (縦長指定なら縦長で。勝手に 16:9 にしない)。high quality で生成する。\n\
             7. 透かし、グリッド、コラージュ、複数パネルは禁止。1枚の単独画像にする。商品本来のラベル・ロゴ・パッケージ文字はそのまま残す。\n\
             8. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
             最終メッセージは OK または NG <理由> の1行のみ。",
            prompt_fragment = cut.prompt_fragment,
            environment_line = environment_line,
            aspect_ratio = aspect_ratio,
        ),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// storyboard.rs からコピーした共通ユーティリティ (無変更)。
// 1カット生成の下部構造は commands/gen_worker.rs へ括り出し済み。
// ─────────────────────────────────────────────────────────────────────────────

/// codex exec を1回だけ叩いて stdout を返す最小ヘルパ。
/// 現状 multiangle 本体では直接使わないが、storyboard と同じ流用基盤として持つ。
#[allow(dead_code)]
async fn codex_oneshot(
    app: &AppHandle,
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
        // では workspace-write になり直らなかった)。BYO 配布はユーザー自身の
        // PC=外部サンドボックス環境なので bypass で問題ない(書き込み権限も維持)。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &format!("model={GENERATION_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={GENERATION_EFFORT}"),
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
    let pid = child
        .id()
        .ok_or_else(|| "codex exec の PID を取得できません".to_string())?;
    let worker_registration =
        crate::commands::worker_registry::WorkerPidGuard::register(app, pid, "multiangle")?;
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
    drop(worker_registration);
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
