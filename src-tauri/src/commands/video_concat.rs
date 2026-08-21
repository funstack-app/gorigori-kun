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
//!     この判断は音声有無の判定についてのもの。クロスフェードでは各カットの尺が
//!     必要なので ffprobe をオプショナルに使い、不在・取得失敗時は素の連結へ戻す。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CROSSFADE_SECONDS: f64 = 0.5;
const MIN_CROSSFADE_CLIP_SECONDS: f64 = 1.2;

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
pub async fn video_concat_story(
    paths: Vec<String>,
    transition: Option<String>,
) -> Result<String, String> {
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

    let wants_crossfade = match transition.as_deref() {
        None | Some("cut") => false,
        Some("crossfade") => true,
        Some(value) => {
            tracing::warn!(
                target: "video_concat",
                transition = %value,
                "未知のつなぎ方が指定されたため、そのまま連結します"
            );
            false
        }
    };
    let crossfade_durations = if wants_crossfade {
        prepare_crossfade_durations(&ffmpeg, &paths).await
    } else {
        None
    };

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("higgsfield");
    std::fs::create_dir_all(&dir).map_err(|e| format!("higgsfield dir 作成失敗: {e}"))?;
    let out = dir.join(format!("story_{}.mp4", now_millis()));

    // ① 音声込みで結合を試す。
    let status = run_concat(&ffmpeg, &paths, &out, true, crossfade_durations.as_deref()).await?;
    if status_success(&status) {
        return Ok(out.to_string_lossy().into_owned());
    }

    // ② 音声ストリームが無いカットが混ざっていると ① は必ず失敗する。
    //    映像のみで結合し直す (音は落ちるが 1 本にはなる)。
    let status = run_concat(&ffmpeg, &paths, &out, false, crossfade_durations.as_deref()).await?;
    if status_success(&status) {
        return Ok(out.to_string_lossy().into_owned());
    }

    // xfade 自体が入力形式の差などで失敗しても、1 本化を優先して素の連結へ戻す。
    // 素の連結でも従来どおり「音声込み → 映像のみ」の 2 段を維持する。
    if crossfade_durations.is_some() {
        tracing::warn!(
            target: "video_concat",
            exit = %status,
            "クロスフェード結合に失敗したため、そのまま連結し直します"
        );

        let status = run_concat(&ffmpeg, &paths, &out, true, None).await?;
        if status_success(&status) {
            return Ok(out.to_string_lossy().into_owned());
        }

        let status = run_concat(&ffmpeg, &paths, &out, false, None).await?;
        if status_success(&status) {
            return Ok(out.to_string_lossy().into_owned());
        }

        return Err(format!("ffmpeg がエラー終了しました (exit: {status})"));
    }

    Err(format!("ffmpeg がエラー終了しました (exit: {status})"))
}

fn status_success(status: &std::process::ExitStatus) -> bool {
    status.success()
}

/// ffmpeg と同じディレクトリを先に見て、最後に PATH 上の ffprobe を探す。
/// ffprobe はクロスフェード演出のためだけのオプショナル依存。
fn resolve_ffprobe(ffmpeg: &Path) -> Option<PathBuf> {
    let ffprobe_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    let sibling = ffmpeg
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join(ffprobe_name))
        .or_else(|| {
            let path = std::env::var_os("PATH")?;
            let ffmpeg_name = ffmpeg.file_name()?;
            std::env::split_paths(&path)
                .find(|dir| dir.join(ffmpeg_name).is_file())
                .map(|dir| dir.join(ffprobe_name))
        });
    if let Some(candidate) = sibling {
        if command_available(&candidate) {
            return Some(candidate);
        }
    }

    let path_candidate = PathBuf::from(ffprobe_name);
    command_available(&path_candidate).then_some(path_candidate)
}

fn command_available(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

async fn prepare_crossfade_durations(ffmpeg: &Path, paths: &[String]) -> Option<Vec<f64>> {
    let Some(ffprobe) = resolve_ffprobe(ffmpeg) else {
        tracing::warn!(
            target: "video_concat",
            "ffprobe が見つからないため、クロスフェードを使わずそのまま連結します"
        );
        return None;
    };

    let mut durations = Vec::with_capacity(paths.len());
    for path in paths {
        match probe_duration(&ffprobe, path).await {
            Ok(duration) => durations.push(duration),
            Err(error) => {
                tracing::warn!(
                    target: "video_concat",
                    path = %path,
                    error = %error,
                    "動画の長さを取得できないため、クロスフェードを使わずそのまま連結します"
                );
                return None;
            }
        }
    }

    if let Some(shortest) = durations
        .iter()
        .copied()
        .reduce(f64::min)
        .filter(|duration| *duration < MIN_CROSSFADE_CLIP_SECONDS)
    {
        tracing::warn!(
            target: "video_concat",
            shortest_seconds = shortest,
            minimum_seconds = MIN_CROSSFADE_CLIP_SECONDS,
            "短すぎるカットがあるため、クロスフェードを使わずそのまま連結します"
        );
        return None;
    }

    Some(durations)
}

async fn probe_duration(ffprobe: &Path, path: &str) -> Result<f64, String> {
    let output = tokio::process::Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .await
        .map_err(|error| format!("ffprobe 起動失敗: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe がエラー終了しました (exit: {})",
            output.status
        ));
    }

    let raw = std::str::from_utf8(&output.stdout)
        .map_err(|error| format!("ffprobe 出力の読み取り失敗: {error}"))?
        .trim();
    let duration = raw
        .parse::<f64>()
        .map_err(|error| format!("ffprobe の長さを数値化できません: {error}"))?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("ffprobe が不正な長さを返しました: {raw}"));
    }
    Ok(duration)
}

fn build_cut_filter(n: usize, with_audio: bool) -> String {
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
    filter
}

/// 各入力の尺だけから、決定論的に xfade / acrossfade の連鎖を組み立てる純関数。
fn build_crossfade_filter(durations: &[f64], with_audio: bool) -> String {
    debug_assert!(durations.len() >= 2);

    let last = durations.len() - 1;
    let mut filters = Vec::with_capacity(if with_audio { last * 2 } else { last });
    let mut timeline_duration = durations[0];
    for i in 1..durations.len() {
        let input = if i == 1 {
            "[0:v]".to_string()
        } else {
            format!("[vx{}]", i - 1)
        };
        let output = if i == last {
            "[v]".to_string()
        } else {
            format!("[vx{i}]")
        };
        let offset = format_seconds(timeline_duration - CROSSFADE_SECONDS);
        filters.push(format!(
            "{input}[{i}:v]xfade=transition=fade:duration=0.5:offset={offset}{output}"
        ));
        timeline_duration += durations[i] - CROSSFADE_SECONDS;
    }

    if with_audio {
        for i in 1..durations.len() {
            let input = if i == 1 {
                "[0:a]".to_string()
            } else {
                format!("[ax{}]", i - 1)
            };
            let output = if i == last {
                "[a]".to_string()
            } else {
                format!("[ax{i}]")
            };
            filters.push(format!("{input}[{i}:a]acrossfade=d=0.5{output}"));
        }
    }

    filters.join(";")
}

fn format_seconds(seconds: f64) -> String {
    let formatted = format!("{seconds:.6}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

/// concat filter で結合を 1 回実行する。`with_audio` が false なら映像のみ。
async fn run_concat(
    ffmpeg: &PathBuf,
    paths: &[String],
    out: &PathBuf,
    with_audio: bool,
    crossfade_durations: Option<&[f64]>,
) -> Result<std::process::ExitStatus, String> {
    let n = paths.len();

    let filter = if let Some(durations) = crossfade_durations {
        debug_assert_eq!(durations.len(), n);
        build_crossfade_filter(durations, with_audio)
    } else {
        // "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" 形式。
        build_cut_filter(n, with_audio)
    };

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

#[cfg(test)]
mod tests {
    use super::build_crossfade_filter;

    #[test]
    fn crossfade_filter_for_two_cuts() {
        assert_eq!(
            build_crossfade_filter(&[2.0, 2.0], true),
            "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[v];[0:a][1:a]acrossfade=d=0.5[a]"
        );
    }

    #[test]
    fn crossfade_filter_for_three_cuts() {
        assert_eq!(
            build_crossfade_filter(&[2.0, 2.0, 2.0], true),
            "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[vx1];[vx1][2:v]xfade=transition=fade:duration=0.5:offset=3[v];[0:a][1:a]acrossfade=d=0.5[ax1];[ax1][2:a]acrossfade=d=0.5[a]"
        );
    }

    #[test]
    fn crossfade_filter_without_audio() {
        assert_eq!(
            build_crossfade_filter(&[2.0, 2.0], false),
            "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[v]"
        );
    }
}
