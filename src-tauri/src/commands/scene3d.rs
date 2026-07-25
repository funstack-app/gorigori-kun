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
///
/// 成果物の置き場 (2026-07-25 修正):
///   フレーム連番は OS の一時領域のまま(エンコード後は不要)。
///   **完成した mp4 と開始フレーム PNG はユーザーの保存先** (`storage_root`、
///   既定 `~/Pictures/GORI GORI`、プロジェクト別サブフォルダ) に出す。
///   以前は成果物も temp_dir 配下に置いていたため、再起動や OS のクリーンアップで
///   消え、「時間をかけて書き出したのに無くなった」事故になっていた。
///   保存先の解決は他スキル(batch_gen 等)と同じ resolve_output_dir を使う。
#[tauri::command]
pub async fn scene3d_encode(
    export_dir: String,
    fps: u32,
    project_name: Option<String>,
) -> Result<(String, String), String> {
    let dir = validate_export_dir(&export_dir)?;
    let frames = frames_dir(&dir);
    let first = frames.join("frame_00000.png");
    if !first.exists() {
        return Err("フレームが1枚も書き出されていません".into());
    }

    // 完成物の出力先(消えない場所)。解決に失敗した場合のみ temp 配下へ退避する。
    let leaf = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("scene3d");
    let out_dir = match crate::commands::storage::StorageSettings::load() {
        Ok(settings) => {
            let resolved = crate::commands::storage::resolve_output_dir(
                &settings,
                project_name.as_deref(),
                &format!("scene3d-{leaf}"),
            );
            match std::fs::create_dir_all(&resolved) {
                Ok(()) => resolved,
                Err(err) => {
                    tracing::warn!(
                        target: "scene3d",
                        error = %err,
                        path = %resolved.display(),
                        "保存先の作成に失敗したため一時領域へ書き出します"
                    );
                    dir.clone()
                }
            }
        }
        Err(err) => {
            tracing::warn!(
                target: "scene3d",
                error = %err,
                "ストレージ設定の読み込みに失敗したため一時領域へ書き出します"
            );
            dir.clone()
        }
    };

    // 開始フレーム(Seedance の start_image 用)を複製
    let first_frame_out = out_dir.join("first-frame.png");
    std::fs::copy(&first, &first_frame_out).map_err(|e| format!("first-frame 複製失敗: {e}"))?;

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "ffmpeg-not-found: PNG連番までは書き出せました。ffmpeg をインストールすると MP4 に変換できます"
            .to_string()
    })?;

    let out = out_dir.join("motion-guide.mp4");
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

/// URL取り込みの上限(bytes)。取り込み自体が20秒制限なので150MBで十分
/// (Rustバッファ+ArrayBuffer+File+デコードが重なるため上限は控えめにする)
const CAPTURE_FETCH_MAX_BYTES: u64 = 150 * 1024 * 1024;

fn resolve_ytdlp() -> Option<PathBuf> {
    let candidates = [
        "yt-dlp",
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp",
        "/usr/bin/yt-dlp",
    ];
    for cand in candidates {
        let ok = Command::new(cand)
            .arg("--version")
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

/// 直リンクをダウンロードする。Ok(None) = 動画でなくWebページだった(ページ解析へフォールバック)
async fn fetch_direct(parsed: reqwest::Url) -> Result<Option<Vec<u8>>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化に失敗: {e}"))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("ダウンロードできません: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "ダウンロードできません (HTTP {})",
            resp.status().as_u16()
        ));
    }
    if let Some(len) = resp.content_length() {
        if len > CAPTURE_FETCH_MAX_BYTES {
            return Err("動画が大きすぎます(150MBまで)。短く切った動画を使ってください".into());
        }
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("text/html") {
        return Ok(None);
    }
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("ダウンロード中断: {e}"))?;
        if (buf.len() as u64 + chunk.len() as u64) > CAPTURE_FETCH_MAX_BYTES {
            return Err("動画が大きすぎます(150MBまで)。短く切った動画を使ってください".into());
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("空のファイルでした".into());
    }
    Ok(Some(buf))
}

/// 動画ページのURLから yt-dlp で動画を取り出す(PCに導入済みの場合のみ。同梱はしない)。
/// 取り込み上限が20秒なので、ffmpegがあれば先頭25秒だけダウンロードする
async fn fetch_via_page(url: String) -> Result<Vec<u8>, String> {
    let Some(ytdlp) = resolve_ytdlp() else {
        return Err(
            "動画ページのURLのようです。PCに yt-dlp をインストールすると、ページURLからの取り込みに対応します(Mac: brew install yt-dlp)。権利のある動画だけに使ってください"
                .into(),
        );
    };
    let dir = std::env::temp_dir().join("gorigori-url-capture");
    std::fs::create_dir_all(&dir).map_err(|e| format!("一時フォルダ作成失敗: {e}"))?;
    // pid+時刻で一意化(複数インスタンス同時実行での衝突対策)
    let stem = format!("cap_{}_{}", std::process::id(), now_millis());
    let outtmpl = dir.join(format!("{stem}.%(ext)s")).to_string_lossy().into_owned();
    let has_ffmpeg = resolve_ffmpeg().is_some();

    // 失敗経路の残骸を掃除するヘルパ(成功時も最後に呼ぶ)
    let cleanup = |dir: &Path, stem: &str| {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(stem) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    };

    let mut cmd = tokio::process::Command::new(&ytdlp);
    cmd.args([
        "--no-playlist",
        "--max-filesize",
        "150M",
        "--socket-timeout",
        "30",
        "--retries",
        "2",
    ]);
    if has_ffmpeg {
        // 合成可能なら画質を絞りつつ先頭25秒だけ(取り込み上限20秒+余白)
        cmd.args([
            "-f",
            "bv*[height<=1080]+ba/b",
            "--merge-output-format",
            "mp4",
            "--download-sections",
            "*0-25",
        ]);
    } else {
        // ffmpegなし: 単一ファイル形式のみ(合成・切り出し不可)
        cmd.args(["-f", "b[ext=mp4]/b"]);
    }
    cmd.args(["-o", &outtmpl]);
    cmd.arg("--"); // 以降をオプションと解釈させない(引数すり替え防御)
    cmd.arg(&url);
    cmd.kill_on_drop(true); // タイムアウト時に子プロセスを道連れにする(UIが処理中のまま固まる事故防止)
    let output = tokio::time::timeout(std::time::Duration::from_secs(240), cmd.output())
        .await
        .map_err(|_| {
            cleanup(&dir, &stem);
            "ダウンロードが時間切れになりました(240秒)。短い動画で試してください".to_string()
        })?
        .map_err(|e| format!("yt-dlp 起動失敗: {e}"))?;

    if !output.status.success() {
        cleanup(&dir, &stem);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 本質的なエラー行(ERROR:)を優先して見せる(末尾切り出しだと文が途中から始まり意味不明になる)
        let msg = stderr
            .lines()
            .rev()
            .find(|l| l.contains("ERROR"))
            .map(|l| l.trim().to_string())
            .unwrap_or_else(|| stderr.lines().last().unwrap_or("原因不明").trim().to_string());
        let msg: String = msg.chars().take(240).collect();
        return Err(format!("このページから動画を取り出せませんでした: {msg}"));
    }

    // 拡張子は yt-dlp が決めるので stem 前方一致で生成物を探す(.part等の中間ファイルは除外)
    let produced = std::fs::read_dir(&dir)
        .map_err(|e| format!("一時フォルダ読み取り失敗: {e}"))?
        .filter_map(|e| e.ok())
        .find(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with(&stem) && !name.ends_with(".part") && !name.ends_with(".ytdl")
        })
        .ok_or_else(|| {
            cleanup(&dir, &stem);
            "動画ファイルが生成されませんでした".to_string()
        })?;
    // メモリへ読む前にサイズで弾く(--max-filesizeは分割取得・結合では厳密上限にならない)
    let size = std::fs::metadata(produced.path()).map(|m| m.len()).unwrap_or(u64::MAX);
    if size > CAPTURE_FETCH_MAX_BYTES {
        cleanup(&dir, &stem);
        return Err("動画が大きすぎます(150MBまで)。短い動画で試してください".into());
    }
    let bytes = std::fs::read(produced.path()).map_err(|e| format!("読み取り失敗: {e}"))?;
    cleanup(&dir, &stem);
    if bytes.is_empty() {
        return Err("空のファイルでした".into());
    }
    Ok(bytes)
}

/// 参照動画のURLをダウンロードして生バイトを返す(「動画から動きを取り込む」のURL入力用)。
/// WebView の fetch は CORS で大半のホストに弾かれるため Rust 側で取得する。
/// 直リンクはそのまま、動画ページは yt-dlp(導入済みの場合)で取り出す。
/// ファイルは保存せずメモリ経由でフロントへ渡す(取り込み後は破棄される)
#[tauri::command]
pub async fn scene3d_fetch_capture_video(url: String) -> Result<tauri::ipc::Response, String> {
    let trimmed = url.trim().to_string();
    let parsed =
        reqwest::Url::parse(&trimmed).map_err(|_| "URLの形式が正しくありません".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("http/https のURLだけ対応しています".into());
    }
    match fetch_direct(parsed).await? {
        Some(bytes) => Ok(tauri::ipc::Response::new(bytes)),
        None => Ok(tauri::ipc::Response::new(fetch_via_page(trimmed).await?)),
    }
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
