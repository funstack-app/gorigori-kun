//! video_concat: ストーリー動画のカット結合 (uy6 Wave 3)
//!
//! 絵コンテの確定カットをカットごとに i2v 生成した動画を、カット順のまま
//! 1 本の mp4 へ結合する。
//!
//! 設計判断 (design-video-story.md §1-B):
//!   - `-c copy` の連結ではなく **再エンコード結合** を使う。モデル間で
//!     コーデック・解像度・fps が揃う保証が無く、copy 連結は壊れるため。
//!   - ffmpeg 不在は **エラーでなく degrade** として扱う。カット動画自体は
//!     既に保存済みで資産として残るため、フロントは `ffmpeg-not-found:` の
//!     prefix を見て案内トーストに切り替える (scene3d.rs と同じ prefix 規約)。
//!   - 音声ストリームの有無はモデル依存 (kling は sound あり / veo3_1 は
//!     音声パラメータ無し) なので、`a=1` で 1 回試し、非ゼロ終了なら
//!     `a=0 -an` で自動リトライする決定論 2 段構成にする (ffprobe 依存を増やさない)。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// カット動画を順に 1 本へ再エンコード結合し、保存先の絶対パスを返す。
///
/// `paths` の順序が結合順の正 (カット順)。
#[tauri::command]
pub async fn video_concat_story(paths: Vec<String>) -> Result<String, String> {
    if paths.len() < 2 {
        return Err("結合できる動画が2本未満です".to_string());
    }
    for path in &paths {
        let p = PathBuf::from(path);
        if !p.is_file() {
            return Err(format!("動画ファイルが見つかりません: {path}"));
        }
    }

    let ffmpeg = crate::commands::scene3d::resolve_ffmpeg().ok_or_else(|| {
        "ffmpeg-not-found: カットごとの動画は保存済みです。ffmpeg をインストールすると1本に結合できます"
            .to_string()
    })?;

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("higgsfield");
    std::fs::create_dir_all(&dir).map_err(|e| format!("higgsfield dir 作成失敗: {e}"))?;
    let out = dir.join(format!("story_{}.mp4", now_millis()));

    // ① 音声込みで結合を試す。
    let status = run_concat(&ffmpeg, &paths, &out, true).await?;
    if status_success(&status) {
        return Ok(out.to_string_lossy().into_owned());
    }

    // ② 音声ストリームが無いカットが混ざっていると ① は必ず失敗する。
    //    映像のみで結合し直す (音は落ちるが 1 本にはなる)。
    let status = run_concat(&ffmpeg, &paths, &out, false).await?;
    if status_success(&status) {
        return Ok(out.to_string_lossy().into_owned());
    }

    Err(format!("ffmpeg がエラー終了しました (exit: {status})"))
}

fn status_success(status: &std::process::ExitStatus) -> bool {
    status.success()
}

/// concat filter で結合を 1 回実行する。`with_audio` が false なら映像のみ。
async fn run_concat(
    ffmpeg: &PathBuf,
    paths: &[String],
    out: &PathBuf,
    with_audio: bool,
) -> Result<std::process::ExitStatus, String> {
    let n = paths.len();

    // "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" 形式を組み立てる。
    let mut filter = String::new();
    for i in 0..n {
        filter.push_str(&format!("[{i}:v]"));
        if with_audio {
            filter.push_str(&format!("[{i}:a]"));
        }
    }
    if with_audio {
        filter.push_str(&format!("concat=n={n}:v=1:a=1[v][a]"));
    } else {
        filter.push_str(&format!("concat=n={n}:v=1:a=0[v]"));
    }

    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.arg("-y");
    for path in paths {
        cmd.arg("-i").arg(path);
    }
    cmd.arg("-filter_complex").arg(&filter);
    cmd.args(["-map", "[v]"]);
    if with_audio {
        cmd.args(["-map", "[a]"]);
    }
    cmd.args([
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    ]);
    if with_audio {
        cmd.args(["-c:a", "aac"]);
    } else {
        cmd.arg("-an");
    }
    cmd.args(["-movflags", "+faststart"]);
    cmd.arg(out);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    cmd.status()
        .await
        .map_err(|e| format!("ffmpeg 起動失敗: {e}"))
}
