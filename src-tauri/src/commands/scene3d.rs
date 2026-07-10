//! scene3d: 3Dシーン演出のモーションガイド動画書き出し
//!
//! フロント(R3F)が evaluateCamera で1フレームずつ描画した PNG を受け取り、
//! ffmpeg で H.264 MP4 にエンコードする。WebView の MediaRecorder は
//! WKWebView で既知の不安定さがあるため使わない(フレーム単位で決定性を保つ)。
//!
//! 出力先は OS の一時ディレクトリ配下(ギャラリー監視対象の generated_images を
//! 汚さない)。採用された成果物のプロジェクト保存は Phase 1 で配線する。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn export_base_dir() -> PathBuf {
    std::env::temp_dir().join("gorigori-scene3d")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// export_dir がこのモジュールの管理領域内かを検証する(領域外への書き込み防止)
fn validate_export_dir(export_dir: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(export_dir);
    let base = export_base_dir();
    if !dir.starts_with(&base) {
        return Err("不正な書き出しディレクトリです".into());
    }
    Ok(dir)
}

/// ffmpeg バイナリの解決。PATH → よくあるインストール先の順で探す。
/// 配布版の PATH は GUI 起動だと最小構成のため、Homebrew 等の標準的な
/// システム位置もフォールバックとして見る(ユーザー固有パスは含めない)。
/// TODO(Phase 2): sidecar 同梱 or 設定画面でのパス上書きに置き換える
fn resolve_ffmpeg() -> Option<PathBuf> {
    let candidates = [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for cand in candidates {
        let ok = Command::new(cand)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(PathBuf::from(cand));
        }
    }
    None
}

fn frames_dir(dir: &Path) -> PathBuf {
    dir.join("frames")
}

/// 書き出しセッションを開始し、専用ディレクトリを作って返す
#[tauri::command]
pub async fn scene3d_export_begin() -> Result<String, String> {
    let dir = export_base_dir().join(format!("export_{}", now_millis()));
    std::fs::create_dir_all(frames_dir(&dir)).map_err(|e| format!("dir 作成失敗: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 1フレーム分の PNG を書き込む
#[tauri::command]
pub async fn scene3d_write_frame(
    export_dir: String,
    index: u32,
    png_bytes: Vec<u8>,
) -> Result<(), String> {
    if png_bytes.is_empty() {
        return Err("フレームデータが空です".into());
    }
    let dir = validate_export_dir(&export_dir)?;
    let path = frames_dir(&dir).join(format!("frame_{index:05}.png"));
    std::fs::write(&path, &png_bytes).map_err(|e| format!("frame write 失敗: {e}"))
}

/// PNG 連番を H.264 MP4 にエンコードし、開始フレームPNGも複製する。
/// 戻り値: (mp4パス, 開始フレームPNGパス)
#[tauri::command]
pub async fn scene3d_encode(export_dir: String, fps: u32) -> Result<(String, String), String> {
    let dir = validate_export_dir(&export_dir)?;
    let frames = frames_dir(&dir);
    let first = frames.join("frame_00000.png");
    if !first.exists() {
        return Err("フレームが1枚も書き出されていません".into());
    }

    // 開始フレーム(Seedance の start_image 用)を複製
    let first_frame_out = dir.join("first-frame.png");
    std::fs::copy(&first, &first_frame_out).map_err(|e| format!("first-frame 複製失敗: {e}"))?;

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "ffmpeg-not-found: PNG連番までは書き出せました。ffmpeg をインストールすると MP4 に変換できます"
            .to_string()
    })?;

    let out = dir.join("motion-guide.mp4");
    let pattern = frames.join("frame_%05d.png");
    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-framerate",
            &fps.to_string(),
            "-i",
            &pattern.to_string_lossy(),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(&out)
        .status()
        .map_err(|e| format!("ffmpeg 起動失敗: {e}"))?;

    if !status.success() {
        return Err(format!("ffmpeg がエラー終了しました (exit: {status})"));
    }
    Ok((
        out.to_string_lossy().into_owned(),
        first_frame_out.to_string_lossy().into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_outside_dir() {
        assert!(validate_export_dir("/etc").is_err());
        let inside = export_base_dir().join("export_123");
        assert!(validate_export_dir(&inside.to_string_lossy()).is_ok());
    }
}
