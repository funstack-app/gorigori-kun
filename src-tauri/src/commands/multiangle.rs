//! Rust-side orchestrator for GORI multi-angle generation.
//!
//! 1枚の被写体参照画像から、選んだ構図カット (最大30) を【並列】で一気に生成する。
//! storyboard.rs と違い、ストーリー対話・絵コンテ・AI評価器・連続性契約・180度ルール・
//! カット役割割当は持たない。各カットは独立した1枚画像で、生成された1枚をそのまま採用する。
//!
//! 共通ユーティリティ (mirror_codex_home / codex_oneshot / find_newest_generated_png /
//! extract_json_from_codex_stdout) は storyboard.rs からコピーして独立させている。
//! 段階3でキャラシートも作る時に shared モジュールへ括り出す (早すぎる抽象化を避ける)。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_MULTIANGLE;
use crate::state::AppState;

const GENERATION_TIMEOUT_SECS: u64 = 900;
const MULTIANGLE_MODEL: &str = "gpt-5.6-sol";
const MULTIANGLE_EFFORT: &str = "low";
/// 同時実行数の上限。rate limit 保護のため並列度を制限する (30枚を無制限同時起動すると
/// プラン上限を直撃するため)。gpt-image-2 は同時実行 3 までが安定で 5 で時々 429 になる
/// (2026-06 実測/業界報告)ため、5→3 に下げて ServerError/429 を減らす(2026-06-09)。
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
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MultiAngleEvent {
    Started {
        run_id: String,
        total: u32,
    },
    CutStarted {
        cut_id: String,
        label: String,
        index: u32,
    },
    CutCompleted {
        cut_id: String,
        label: String,
        image_path: String,
    },
    CutFailed {
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
    let run_id = format!("{}-{}", timestamp_id(), short_id());
    let task_run_id = run_id.clone();

    tokio::spawn(async move {
        if let Err(err) =
            run_multiangle_orchestrator(app.clone(), codex_bin, codex_home_orig, task_run_id, params)
                .await
        {
            tracing::warn!(target: "codex.multiangle", "multiangle orchestrator failed: {err}");
            let _ = app.emit(
                EVENT_MULTIANGLE,
                MultiAngleEvent::CutFailed {
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

    tokio::spawn(async move {
        let prompt = build_multiangle_prompt(&cut, &aspect_ratio, &environment);
        let _ = task_app.emit(
            EVENT_MULTIANGLE,
            MultiAngleEvent::CutStarted {
                cut_id: cut.cut_id.clone(),
                label: cut.label.clone(),
                index: 0,
            },
        );
        match generate_one_cut(
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
            async move {

                let _ = app.emit(
                    EVENT_MULTIANGLE,
                    MultiAngleEvent::CutStarted {
                        cut_id: cut.cut_id.clone(),
                        label: cut.label.clone(),
                        index: index as u32,
                    },
                );
                let prompt = build_multiangle_prompt(&cut, &aspect_ratio, &environment);
                match generate_one_cut(
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

/// 構図プロンプトを組み立てる。storyboard の build_generation_prompt を参考にしつつ
/// 大幅簡略化 (structured_prompt JSON も continuity も評価も不要)。
fn build_multiangle_prompt(cut: &CutPromptSpec, aspect_ratio: &str, environment: &str) -> String {
    let environment_line = if environment.trim().is_empty() {
        String::new()
    } else {
        format!("\n- 環境・背景・ライティングは次の指示で固定する: {}\n", environment.trim())
    };
    format!(
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
    )
}

/// image_gen を呼ばずに codex が正常終了したとき(画像が生成されない)に
/// 何回まで作り直すか。effort=low の GPT-5.5 が「OK」だけ返して image_gen を
/// 呼び忘れるケースがあり、その救済(2026-06-08 マルチアングル生成失敗の修正)。
const MULTIANGLE_MAX_ATTEMPTS: u32 = 3;

/// 1枚生成の最小単位(リトライ込み)。
///
/// codex(GPT-5.5)が image_gen(gpt-image-2)を呼ばずに正常終了し、画像が
/// 一枚も生成されないことがある。これは codex の異常終了ではないので status は
/// success のまま「生成画像が見つかりません」になる。1回で諦めず最大
/// MULTIANGLE_MAX_ATTEMPTS 回まで作り直す。コア(batch_gen)の自動リトライと同思想。
async fn generate_one_cut(
    codex_bin: &Path,
    codex_home_orig: &Path,
    prompt: &str,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    cwd: Option<String>,
) -> Result<PathBuf, String> {
    let mut last_err = String::new();
    for attempt in 1..=MULTIANGLE_MAX_ATTEMPTS {
        match attempt_one_cut(
            codex_bin,
            codex_home_orig,
            prompt,
            reference_images,
            output_dir,
            cut_id,
            cwd.clone(),
        )
        .await
        {
            Ok(path) => return Ok(path),
            Err(e) => {
                tracing::warn!(
                    "multiangle cut {cut_id} attempt {attempt}/{MULTIANGLE_MAX_ATTEMPTS} failed: {e}"
                );
                last_err = e;
            }
        }
    }
    // 外部 API 障害(ServerError/5xx/401 等)なら非エンジニア向けの文言に整形する。
    Err(crate::codex::process::humanize_generation_failure(&format!(
        "{MULTIANGLE_MAX_ATTEMPTS}回試行しても生成できませんでした ({cut_id}): {last_err}"
    )))
}

/// 1枚生成の1試行。画像が出れば Ok、image_gen 未呼び出し等で画像が無ければ Err。
async fn attempt_one_cut(
    codex_bin: &Path,
    codex_home_orig: &Path,
    prompt: &str,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    cwd: Option<String>,
) -> Result<PathBuf, String> {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("codex-multiangle-{cut_id}-"))
        .tempdir()
        .map_err(|e| format!("tempdir 作成失敗: {e}"))?;
    let tmp_home = tmp.path().to_path_buf();
    mirror_codex_home(codex_home_orig, &tmp_home)?;
    let tmp_gen = tmp_home.join("generated_images");
    std::fs::create_dir_all(&tmp_gen)
        .map_err(|e| format!("worker generated_images 作成失敗: {e}"))?;

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
        &format!("model={MULTIANGLE_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={MULTIANGLE_EFFORT}"),
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
            .write_all(prompt.as_bytes())
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
            // 原因究明のため stdout 末尾を残す(GPT-5.5 が「OK」だけ返したか、NG 理由を
            // 言ったか、image_gen を試みて失敗したかが分かる)。
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
                "生成画像が見つかりませんでした: {cut_id} (codex最終出力: {})",
                if tail.is_empty() { "(出力なし)" } else { &tail }
            ));
        }
    };
    let dest = output_dir.join(format!("{cut_id}.png"));
    std::fs::copy(&src_png, &dest).map_err(|e| format!("出力コピー失敗: {e}"))?;
    Ok(dest)
}

// ─────────────────────────────────────────────────────────────────────────────
// storyboard.rs からコピーした共通ユーティリティ (無変更)。
// 段階3で shared モジュールへ括り出す予定。それまでは独立コピーで運用する。
// ─────────────────────────────────────────────────────────────────────────────

/// codex exec を1回だけ叩いて stdout を返す最小ヘルパ。
/// 現状 multiangle 本体では直接使わないが、storyboard と同じ流用基盤として持つ。
#[allow(dead_code)]
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
        // では workspace-write になり直らなかった)。BYO 配布はユーザー自身の
        // PC=外部サンドボックス環境なので bypass で問題ない(書き込み権限も維持)。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &format!("model={MULTIANGLE_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={MULTIANGLE_EFFORT}"),
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
        .map_err(|e| format!("multiangle generated_images 作成失敗: {e}"))?;
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

fn timestamp_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos & 0xffff_ffff)
}
