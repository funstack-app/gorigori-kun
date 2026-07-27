//! 1カット画像生成の共有下部構造 (multiangle / character_sheet が共用)。
//!
//! `multiangle.rs:8-9` のコメントが予告していた「段階3で shared モジュールへ括り出す」
//! を実施したもの。ここに集めた関数はカットの意味 (構図か表情か) に依存せず、
//!   - 一時 CODEX_HOME の mirror
//!   - codex exec 起動 + セマフォ + PID台帳 + timeout + kill_on_drop
//!   - 名前非依存の PNG 回収 (ig_*/call_*/exec-*)
//!   - image_gen 呼び忘れ救済のリトライ
//! だけを担う。プロンプトの中身 (構図/表情/属性の焼き込み) は呼び出し側が組む。
//!
//! **括り出しは「移動のみ・挙動不変」**。multiangle の実測済み挙動を壊さないため、
//! generate_one_cut / attempt_one_cut / mirror_codex_home / find_newest_generated_png /
//! collect_generated_pngs / timestamp_id / short_id を multiangle.rs から丸ごと移した
//! (ロジック変更なし)。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;

/// 1カットの生成が何秒でタイムアウトするか。
pub const GENERATION_TIMEOUT_SECS: u64 = 900;
/// 画像生成に使う codex モデル。
pub const GENERATION_MODEL: &str = "gpt-5.6-sol";
/// reasoning effort。速度優先で low (image_gen 呼び忘れはリトライで救済)。
pub const GENERATION_EFFORT: &str = "low";

/// image_gen を呼ばずに codex が正常終了したとき(画像が生成されない)に
/// 何回まで作り直すか。effort=low の GPT-5.5 が「OK」だけ返して image_gen を
/// 呼び忘れるケースがあり、その救済(2026-06-08 マルチアングル生成失敗の修正)。
pub const GENERATION_MAX_ATTEMPTS: u32 = 3;

/// 1枚生成の最小単位(リトライ込み)。
///
/// codex(GPT-5.5)が image_gen(gpt-image-2)を呼ばずに正常終了し、画像が
/// 一枚も生成されないことがある。これは codex の異常終了ではないので status は
/// success のまま「生成画像が見つかりません」になる。1回で諦めず最大
/// GENERATION_MAX_ATTEMPTS 回まで作り直す。コア(batch_gen)の自動リトライと同思想。
#[allow(clippy::too_many_arguments)]
pub async fn generate_one_cut(
    app: &AppHandle,
    state: &crate::state::AppState,
    codex_bin: &Path,
    codex_home_orig: &Path,
    prompt: &str,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    cwd: Option<String>,
) -> Result<PathBuf, String> {
    // ── 常駐 app-server 経路を先に試す (2026-07-27) ────────────────────
    //
    // なぜ: batch_gen.rs は冒頭コメントのとおり「1枚ごとの codex exec 起動コストを
    // 払わないため」に常駐化済みだが、スキル系 (マルチアングル / キャラ登録 / 絵コンテ) は
    // その改修から取り残され、1カットごとに codex プロセスを新規起動していた。
    // codex は Node.js 実装なので起動だけで数秒かかり、それがカット数ぶん積み上がる。
    //
    // 失敗したら従来の codex exec 経路へ落ちるので、常駐が使えない環境
    // (Windows は gen_server 側で無効) でも挙動は変わらない。
    let image_paths: Vec<String> = reference_images
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    match crate::codex::gen_server::generate_image(
        app,
        state,
        prompt,
        &image_paths,
        cwd.as_deref().filter(|value| !value.is_empty()),
        Some(GENERATION_MODEL),
        Some(GENERATION_EFFORT),
    )
    .await
    {
        Ok(src_png) => {
            let dest = output_dir.join(format!("cut_{cut_id}_{}.png", short_id()));
            match std::fs::copy(&src_png, &dest) {
                Ok(_) => return Ok(dest),
                Err(error) => {
                    // コピーだけ失敗した場合は exec 経路でも同じ結果にならないので、
                    // フォールバックせずそのまま失敗を返す。
                    return Err(format!(
                        "常駐経路の生成画像コピー失敗 ({}): {error}",
                        src_png.display()
                    ));
                }
            }
        }
        Err(resident_error) => {
            tracing::warn!(
                target: "codex.gen_worker",
                "cut {cut_id}: 常駐 app-server 経路に失敗したため codex exec へフォールバックします: {resident_error}"
            );
        }
    }

    let mut last_err = String::new();
    for attempt in 1..=GENERATION_MAX_ATTEMPTS {
        match attempt_one_cut(
            app,
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
                    "gen cut {cut_id} attempt {attempt}/{GENERATION_MAX_ATTEMPTS} failed: {e}"
                );
                last_err = e;
            }
        }
    }
    // 外部 API 障害(ServerError/5xx/401 等)なら非エンジニア向けの文言に整形する。
    Err(crate::codex::process::humanize_generation_failure(&format!(
        "{GENERATION_MAX_ATTEMPTS}回試行しても生成できませんでした ({cut_id}): {last_err}"
    )))
}

/// 1枚生成の1試行。画像が出れば Ok、image_gen 未呼び出し等で画像が無ければ Err。
pub async fn attempt_one_cut(
    app: &AppHandle,
    codex_bin: &Path,
    codex_home_orig: &Path,
    prompt: &str,
    reference_images: &[PathBuf],
    output_dir: &Path,
    cut_id: &str,
    cwd: Option<String>,
) -> Result<PathBuf, String> {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("codex-gencut-{cut_id}-"))
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
        &format!("model={GENERATION_MODEL}"),
        "-c",
        &format!("model_reasoning_effort={GENERATION_EFFORT}"),
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
    let output = timeout(
        Duration::from_secs(GENERATION_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("画像生成が {GENERATION_TIMEOUT_SECS} 秒でタイムアウトしました"))?
    .map_err(|e| format!("codex exec 待機失敗: {e}"))?;
    drop(worker_registration);
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

/// 一時 CODEX_HOME に auth/config/skills を symlink し、generated_images だけを分離する。
pub fn mirror_codex_home(codex_home_orig: &Path, tmp_home: &Path) -> Result<(), String> {
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
        .map_err(|e| format!("generated_images 作成失敗: {e}"))?;
    Ok(())
}

/// ワーカー専用 generated_images 配下で最も新しい PNG を1枚返す (保存名非依存)。
pub fn find_newest_generated_png(root: &Path) -> Option<PathBuf> {
    let mut newest: Option<(u128, PathBuf)> = None;
    collect_generated_pngs(root, &mut newest);
    newest.map(|(_, path)| path)
}

pub fn collect_generated_pngs(dir: &Path, newest: &mut Option<(u128, PathBuf)>) {
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

pub fn timestamp_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
        .to_string()
}

pub fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos & 0xffff_ffff)
}
