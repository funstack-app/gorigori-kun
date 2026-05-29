use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::process::Command as TokioCommand;
use tokio::task::{JoinHandle, JoinSet};

use crate::codex::process::enriched_path;
use crate::events::EVENT_IMAGE_BATCH;
use crate::state::{AppState, HiggsfieldCancellation};

/// Higgsfield CLI を起動する全 std::process::Command にかける共通設定:
/// - PATH を enriched_path で統一 (拡張パック wrapper 内 / CLI 内部の env node 対策)
/// - Windows ではコンソールウィンドウを抑制 (CREATE_NO_WINDOW)
///
/// Codex クロスレビュー (2026-05-19): 全 Higgsfield Command に統一適用する
/// ことで「ある操作だけ動く / 動かない」差分をなくす。
fn prepare_higgsfield_command(cmd: &mut Command) {
    cmd.env("PATH", enriched_path());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// 上記の tokio::process::Command 版。
fn prepare_higgsfield_tokio_command(cmd: &mut TokioCommand) {
    cmd.env("PATH", enriched_path());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldModel {
    #[serde(rename(serialize = "displayName", deserialize = "display_name"))]
    pub display_name: String,
    #[serde(rename(serialize = "jobSetType", deserialize = "job_set_type"))]
    pub job_set_type: String,
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldAccount {
    pub email: String,
    // Higgsfield CLI は credits を小数で返すことがある (例: 5139.25)。
    // i64 で受けると JSON パース失敗 → plan も取れずに UNLIMITED ピルが
    // 表示されない事故が起きた。f64 で受ける。
    pub credits: f64,
    #[serde(rename(
        serialize = "subscriptionPlanType",
        deserialize = "subscription_plan_type"
    ))]
    pub subscription_plan_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldBatchArgs {
    pub job_set_type: String,
    pub display_name: String,
    pub prompt: String,
    pub count: u32,
    pub aspect: Option<String>,
    pub ref_image_paths: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// 生成メディアタイプ。None なら Image 扱い (後方互換)。
    /// 動画モデル(kling/seedance/veo等) を指定する時は Some(MediaType::Video) にする。
    #[serde(default)]
    pub media_type: Option<MediaType>,
    // P0-2 動画モデル静的定義 (2026-05-28)
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub sound: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub model_variant: Option<String>,
    #[serde(default)]
    pub i2v_input_field: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldCompareArgs {
    pub prompt: String,
    pub models: Vec<HiggsfieldCompareModel>,
    pub aspect: Option<String>,
    pub ref_image_paths: Option<Vec<String>>,
    pub cwd: Option<String>,
    /// 生成メディアタイプ。None なら Image 扱い (後方互換)。
    /// 動画モデル(kling/seedance/veo等) を指定する時は Some(MediaType::Video) にする。
    #[serde(default)]
    pub media_type: Option<MediaType>,
    // P0-2 動画モデル静的定義 (2026-05-28)
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub sound: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub model_variant: Option<String>,
    #[serde(default)]
    pub i2v_input_field: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldCompareModel {
    pub job_set_type: String,
    pub display_name: String,
    // P0-2 動画モデル静的定義 (2026-05-28)
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub sound: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub model_variant: Option<String>,
    #[serde(default)]
    pub i2v_input_field: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub batch_id: String,
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
}

// P0-1 mediaType 導入 (2026-05-28 動画タブ準備)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Image,
    Video,
}

impl MediaType {
    fn extension(&self) -> &'static str {
        match self {
            MediaType::Image => "png",
            MediaType::Video => "mp4",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum HiggsfieldBatchEvent {
    Started {
        batch_id: String,
        count: u32,
        provider: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    WorkerStarted {
        batch_id: String,
        idx: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    WorkerCompleted {
        batch_id: String,
        idx: u32,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: Option<MediaType>,
    },
    WorkerFailed {
        batch_id: String,
        idx: u32,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    Completed {
        batch_id: String,
        generated_paths: Vec<String>,
        failed_count: u32,
        provider: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: Option<MediaType>,
    },
    Cancelled {
        batch_id: String,
    },
}

#[derive(Debug)]
struct CompareWorkerResult {
    idx: u32,
    path: Option<String>,
}

type PipeReadTask = JoinHandle<Result<Vec<u8>, std::io::Error>>;

#[tauri::command]
pub async fn higgsfield_status() -> Result<HiggsfieldStatus, String> {
    let Some(binary) = resolve_higgsfield_binary() else {
        return Ok(HiggsfieldStatus {
            installed: false,
            authenticated: false,
            binary_path: None,
            version: None,
        });
    };

    let authenticated = auth_status(&binary);
    let version = command_text(&binary, ["--version"]).ok();

    Ok(HiggsfieldStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary.to_string_lossy().into_owned()),
        version,
    })
}

/// 拡張パックの自動インストールの進捗イベント。フロントで進行表示する用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HiggsfieldInstallProgress {
    Started,
    Downloading { url: String },
    Downloaded { bytes: usize },
    Extracting,
    Installed { path: String },
    Failed { message: String },
}

const HIGGSFIELD_INSTALL_EVENT: &str = "higgsfield:install-progress";

fn emit_install_progress(app: &AppHandle, progress: HiggsfieldInstallProgress) {
    if let Err(e) = app.emit(HIGGSFIELD_INSTALL_EVENT, &progress) {
        tracing::warn!(target: "codex.higgsfield", error = ?e, "install progress emit failed");
    }
}

/// 拡張パック zip の GitHub Release URL を OS / arch から組み立てる。
///
/// 命名規則:
/// - Mac aarch64: GORI-HiggsField-Extension_mac-aarch64.zip
/// - Mac x86_64:  GORI-HiggsField-Extension_mac-x64.zip
/// - Windows x86_64: GORI-HiggsField-Extension_windows.zip
///
/// 拡張パックは本体と同じタグで配布されるため、`releases/latest/download/` を
/// 使う (本体アップデートに追従)。
fn extension_zip_url() -> Result<String, String> {
    const BASE: &str = "https://github.com/funstack-app/gorigori-kun/releases/latest/download";
    let asset = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "GORI-HiggsField-Extension_mac-aarch64.zip",
        ("macos", "x86_64") => "GORI-HiggsField-Extension_mac-x64.zip",
        ("windows", "x86_64") => "GORI-HiggsField-Extension_windows.zip",
        (os, arch) => {
            return Err(format!(
                "未対応の OS / arch です: {os} / {arch}。手動インストールしてください。"
            ))
        }
    };
    Ok(format!("{BASE}/{asset}"))
}

/// 拡張パックの zip 内に含まれる higgsfield/ ディレクトリの一意なエントリ名。
/// Windows 版だけ payload ルートに README.txt と install.bat が含まれるので、
/// "higgsfield/" プレフィックスを持つエントリだけを抽出する。
const ZIP_ROOT_PREFIX: &str = "higgsfield/";

fn extension_install_dir() -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir().ok_or_else(|| "OS のデータディレクトリが取得できません".to_string())?;
    Ok(data_dir.join("app.codexframefactory").join("extensions"))
}

/// 拡張パックをアプリ内から自動インストールする (真のワンタップ化、2026-05-19)。
///
/// 動作:
/// 1. OS / arch に合った拡張パック zip を GitHub Release から DL
/// 2. メモリ上で zip を展開
/// 3. extensions/higgsfield/ 配下に上書き配置
/// 4. macOS では bin/node, bin/higgsfield, bin/npm に実行権を付与
/// 5. インストール直後の Higgsfield 状態を返す
///
/// 進捗は EVENT "higgsfield:install-progress" で逐次通知 (UI 進行表示用)。
#[tauri::command]
pub async fn higgsfield_install_extension(app: AppHandle) -> Result<HiggsfieldStatus, String> {
    use std::io::Read;
    emit_install_progress(&app, HiggsfieldInstallProgress::Started);

    let url = extension_zip_url()?;
    emit_install_progress(
        &app,
        HiggsfieldInstallProgress::Downloading { url: url.clone() },
    );

    // ── 1. DL ──
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP クライアントの初期化に失敗しました: {e}"))?;
    let response = client.get(&url).send().await.map_err(|e| {
        let msg = format!("拡張パック zip の DL に失敗しました: {e}");
        emit_install_progress(
            &app,
            HiggsfieldInstallProgress::Failed {
                message: msg.clone(),
            },
        );
        msg
    })?;
    if !response.status().is_success() {
        let msg = format!(
            "拡張パック zip の DL に失敗しました: HTTP {} ({})",
            response.status(),
            url
        );
        emit_install_progress(
            &app,
            HiggsfieldInstallProgress::Failed {
                message: msg.clone(),
            },
        );
        return Err(msg);
    }
    let bytes = response.bytes().await.map_err(|e| {
        let msg = format!("レスポンス body 読み取りに失敗しました: {e}");
        emit_install_progress(
            &app,
            HiggsfieldInstallProgress::Failed {
                message: msg.clone(),
            },
        );
        msg
    })?;
    emit_install_progress(
        &app,
        HiggsfieldInstallProgress::Downloaded { bytes: bytes.len() },
    );

    // ── 2. zip 展開 ──
    emit_install_progress(&app, HiggsfieldInstallProgress::Extracting);
    let install_root = extension_install_dir()?;
    std::fs::create_dir_all(&install_root)
        .map_err(|e| format!("インストール先ディレクトリの作成に失敗しました: {e}"))?;

    // 既存の higgsfield/ ディレクトリを削除 (上書きインストール)
    let target = install_root.join("higgsfield");
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("既存の higgsfield/ 削除に失敗しました: {e}"))?;
    }

    // zip クレートで in-memory 展開
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("zip の解析に失敗しました: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry の読み取りに失敗しました ({i}): {e}"))?;
        let entry_name = entry.name().to_string();
        // payload ルートに含まれる README.txt や install.bat は無視。
        // higgsfield/ 配下のエントリだけを展開する。
        if !entry_name.starts_with(ZIP_ROOT_PREFIX) {
            continue;
        }
        // zip slip 対策: enclosed_name は ".." を含むエントリで None を返す
        let safe_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("不正な zip entry パス: {entry_name}"))?;
        let dest = install_root.join(safe_name);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("ディレクトリ作成に失敗しました: {e}"))?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("ディレクトリ作成に失敗しました: {e}"))?;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("entry 読み取りに失敗しました: {e}"))?;
            std::fs::write(&dest, &buf)
                .map_err(|e| format!("ファイル書き込みに失敗しました: {e}"))?;
            // Unix では zip entry の mode を引き継ぐ。
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = entry.unix_mode() {
                    if let Err(e) = std::fs::set_permissions(
                        &dest,
                        std::fs::Permissions::from_mode(mode),
                    ) {
                        tracing::warn!(
                            target: "codex.higgsfield",
                            error = ?e,
                            path = %dest.display(),
                            "set_permissions failed"
                        );
                    }
                }
            }
        }
    }

    // ── 3. macOS では bin/* に念のため実行権を付与 ──
    // zip 内 unix_mode が欠落しているケース (zip クレートの version によって挙動が変わる)
    // への保険。bin/ 配下の主要ファイルを 0o755 にする。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["node", "higgsfield", "npm"] {
            let bin = target.join("bin").join(name);
            if bin.exists() {
                let _ = std::fs::set_permissions(
                    &bin,
                    std::fs::Permissions::from_mode(0o755),
                );
            }
        }
    }

    emit_install_progress(
        &app,
        HiggsfieldInstallProgress::Installed {
            path: target.to_string_lossy().into_owned(),
        },
    );

    // ── 4. インストール後の状態を返す ──
    higgsfield_status().await
}

/// Higgsfield 接続の状態を「実測」して返すデバッグ専用コマンド。
///
/// Codex クロスレビュー (2026-05-19): エラー報告時に「どのバイナリが選ばれ、
/// どの PATH で実行され、CLI が何を返しているか」をユーザー画面に直接出せる
/// ようにする。推測ベースの修正ループを切るための観測手段。
///
/// 返す情報:
/// - app の現在の PATH (std::env::var)
/// - enriched_path() の結果
/// - resolve_higgsfield_binary() の結果 (見つかったバイナリのフルパス、または未検出)
/// - 拡張パックのインストール先ディレクトリの存在と中身
/// - 見つかったバイナリで実行した `--version`, `auth token`, `account status --json` の
///   stdout/stderr/exit code (それぞれ最初の 500 文字程度に切り詰め)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldDebugInfo {
    pub os: String,
    pub arch: String,
    pub current_path: String,
    pub enriched_path: String,
    pub resolved_binary: Option<String>,
    pub extension_dir: String,
    pub extension_dir_exists: bool,
    pub extension_dir_listing: Vec<String>,
    pub version_probe: HiggsfieldProbeResult,
    pub auth_token_probe: HiggsfieldProbeResult,
    pub account_probe: HiggsfieldProbeResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldProbeResult {
    pub ran: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

fn truncate_for_debug(s: &str) -> String {
    const MAX: usize = 800;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut out = s[..MAX].to_string();
    out.push_str("...[truncated]");
    out
}

fn probe_higgsfield<const N: usize>(binary: &Path, args: [&str; N]) -> HiggsfieldProbeResult {
    let mut cmd = Command::new(binary);
    cmd.args(args);
    prepare_higgsfield_command(&mut cmd);
    match cmd.output() {
        Ok(output) => HiggsfieldProbeResult {
            ran: true,
            exit_code: output.status.code(),
            stdout: truncate_for_debug(&String::from_utf8_lossy(&output.stdout)),
            stderr: truncate_for_debug(&String::from_utf8_lossy(&output.stderr)),
            error: None,
        },
        Err(e) => HiggsfieldProbeResult {
            ran: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn higgsfield_debug() -> Result<HiggsfieldDebugInfo, String> {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let enriched = enriched_path().to_string_lossy().into_owned();
    let resolved = resolve_higgsfield_binary();
    let resolved_str = resolved.as_ref().map(|p| p.to_string_lossy().into_owned());

    let extension_dir = dirs::data_dir()
        .map(|d| {
            d.join("app.codexframefactory")
                .join("extensions")
                .join("higgsfield")
        })
        .unwrap_or_else(|| PathBuf::from("(data_dir 取得失敗)"));
    let extension_dir_exists = extension_dir.exists();
    let mut extension_dir_listing: Vec<String> = Vec::new();
    if extension_dir_exists {
        if let Ok(entries) = std::fs::read_dir(&extension_dir) {
            for entry in entries.flatten() {
                extension_dir_listing.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        // bin ディレクトリも見たい
        let bin_dir = extension_dir.join("bin");
        if bin_dir.exists() {
            extension_dir_listing.push("---- bin/ ----".to_string());
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    extension_dir_listing
                        .push(format!("bin/{}", entry.file_name().to_string_lossy()));
                }
            }
        }
    }

    let (version_probe, auth_token_probe, account_probe) = match resolved.as_ref() {
        Some(binary) => (
            probe_higgsfield(binary, ["--version"]),
            probe_higgsfield(binary, ["auth", "token"]),
            probe_higgsfield(binary, ["account", "status", "--json"]),
        ),
        None => (
            HiggsfieldProbeResult {
                ran: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("binary 未検出のためプローブ不可".to_string()),
            },
            HiggsfieldProbeResult {
                ran: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("binary 未検出のためプローブ不可".to_string()),
            },
            HiggsfieldProbeResult {
                ran: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("binary 未検出のためプローブ不可".to_string()),
            },
        ),
    };

    Ok(HiggsfieldDebugInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        current_path,
        enriched_path: enriched,
        resolved_binary: resolved_str,
        extension_dir: extension_dir.to_string_lossy().into_owned(),
        extension_dir_exists,
        extension_dir_listing,
        version_probe,
        auth_token_probe,
        account_probe,
    })
}

#[tauri::command]
pub async fn higgsfield_login() -> Result<String, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    command_text(&binary, ["auth", "login"])
}

#[tauri::command]
pub async fn higgsfield_logout() -> Result<(), String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    command_text(&binary, ["auth", "logout"]).map(|_| ())
}

#[tauri::command]
pub async fn higgsfield_list_models(media: String) -> Result<Vec<HiggsfieldModel>, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let media_arg = match media.as_str() {
        "image" => "--image",
        "video" => "--video",
        _ => return Err("media は image または video を指定してください。".to_string()),
    };

    // Codex クロスレビュー (2026-05-19): PATH 継承 + Windows CREATE_NO_WINDOW を
    // 全 Higgsfield Command に統一適用する prepare_higgsfield_command を経由する。
    let mut cmd = Command::new(&binary);
    cmd.args(["model", "list", media_arg, "--json"]);
    prepare_higgsfield_command(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("Higgsfield CLI が失敗しました: {}", output.status));
        }
        return Err(format!("Higgsfield CLI が失敗しました: {stderr}"));
    }

    serde_json::from_slice::<Vec<HiggsfieldModel>>(&output.stdout).map_err(|e| {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            format!("Higgsfield モデル一覧の JSON デコードに失敗しました: {e}")
        } else {
            format!("Higgsfield モデル一覧の JSON デコードに失敗しました: {e}; stdout: {stdout}")
        }
    })
}

#[tauri::command]
pub async fn higgsfield_account() -> Result<HiggsfieldAccount, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;

    // PATH に node/npm の bin を含めないと CLI 内部のサブプロセス起動が失敗する
    // 可能性がある (generate_batch 側でも同様の理由で enriched_path を使っている)。
    let mut cmd = Command::new(&binary);
    cmd.args(["account", "status", "--json"]);
    prepare_higgsfield_command(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    eprintln!(
        "[higgsfield_account] status={} stdout_len={} stderr_len={}",
        output.status,
        output.stdout.len(),
        output.stderr.len(),
    );

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        eprintln!("[higgsfield_account] stderr={stderr}");
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield account status が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!(
            "Higgsfield account status が失敗しました: {stderr}"
        ));
    }

    let result = serde_json::from_slice::<HiggsfieldAccount>(&output.stdout).map_err(|e| {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        eprintln!("[higgsfield_account] JSON decode failed: {e}; stdout={stdout}");
        if stdout.is_empty() {
            format!("Higgsfield アカウント情報の JSON デコードに失敗しました: {e}")
        } else {
            format!(
                "Higgsfield アカウント情報の JSON デコードに失敗しました: {e}; stdout: {stdout}"
            )
        }
    });
    if let Ok(ref acc) = result {
        eprintln!(
            "[higgsfield_account] OK plan={}",
            acc.subscription_plan_type
        );
    }
    result
}

#[tauri::command]
pub async fn higgsfield_generate_batch(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: HiggsfieldBatchArgs,
) -> Result<BatchSummary, String> {
    if args.count == 0 {
        return Err("count must be >= 1".into());
    }
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;
    let batch_id = format!("hf-{}", short_id());
    let out_dir = codex_home.join("generated_images").join(&batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力ディレクトリ作成失敗: {e}"))?;
    let cancellation = register_higgsfield_cancellation(&state, &batch_id).await;

    let model_job_set_type = args.job_set_type.clone();
    let model_display_name = args.display_name.clone();
    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        HiggsfieldBatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.count,
            provider: "higgsfield",
            model_job_set_type: Some(model_job_set_type.clone()),
            model_display_name: Some(model_display_name.clone()),
        },
    );

    let mut generated_paths = Vec::new();
    let mut failed_count = 0u32;
    let mut cancelled = false;
    for idx in 1..=args.count {
        if cancellation.flag.load(Ordering::SeqCst) {
            cancelled = true;
            failed_count += emit_cancelled_workers(
                &app,
                &batch_id,
                idx,
                args.count,
                Some(&model_job_set_type),
                Some(&model_display_name),
            );
            break;
        }
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::WorkerStarted {
                batch_id: batch_id.clone(),
                idx,
                model_job_set_type: Some(model_job_set_type.clone()),
                model_display_name: Some(model_display_name.clone()),
            },
        );
        eprintln!(
            "[higgsfield] worker idx={idx} batch={batch_id} model={} prompt_len={} refs={} aspect={:?}",
            args.job_set_type,
            args.prompt.len(),
            args.ref_image_paths.as_deref().map(|v| v.len()).unwrap_or(0),
            args.aspect,
        );
        let result = run_one_higgsfield_job(&binary, &out_dir, idx, &args, &cancellation).await;
        match result {
            Ok(path) => {
                eprintln!("[higgsfield] worker idx={idx} OK path={path}");
                generated_paths.push(path.clone());
                let _ = app.emit(
                    EVENT_IMAGE_BATCH,
                    HiggsfieldBatchEvent::WorkerCompleted {
                        batch_id: batch_id.clone(),
                        idx,
                        path,
                        model_job_set_type: Some(model_job_set_type.clone()),
                        model_display_name: Some(model_display_name.clone()),
                        media_type: args.media_type,
                    },
                );
            }
            Err(error) => {
                eprintln!("[higgsfield] worker idx={idx} FAIL: {error}");
                failed_count += 1;
                let was_cancelled = is_cancelled_error(&error);
                let _ = app.emit(
                    EVENT_IMAGE_BATCH,
                    HiggsfieldBatchEvent::WorkerFailed {
                        batch_id: batch_id.clone(),
                        idx,
                        error: error.clone(),
                        model_job_set_type: Some(model_job_set_type.clone()),
                        model_display_name: Some(model_display_name.clone()),
                    },
                );
                if was_cancelled {
                    cancelled = true;
                    failed_count += emit_cancelled_workers(
                        &app,
                        &batch_id,
                        idx + 1,
                        args.count,
                        Some(&model_job_set_type),
                        Some(&model_display_name),
                    );
                    break;
                }
            }
        }
    }

    if cancelled {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Cancelled {
                batch_id: batch_id.clone(),
            },
        );
    } else {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Completed {
                batch_id: batch_id.clone(),
                generated_paths: generated_paths.clone(),
                failed_count,
                provider: "higgsfield",
                model_job_set_type: Some(model_job_set_type),
                model_display_name: Some(model_display_name),
                media_type: args.media_type,
            },
        );
    }
    unregister_higgsfield_cancellation(&state, &batch_id).await;

    Ok(BatchSummary {
        batch_id,
        generated_paths,
        failed_count,
    })
}

#[tauri::command]
pub async fn higgsfield_generate_compare(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: HiggsfieldCompareArgs,
) -> Result<BatchSummary, String> {
    if args.models.is_empty() {
        return Err("models must contain at least 1".into());
    }
    if args.models.len() > 4 {
        return Err("models must be 4 or fewer".into());
    }

    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;
    let batch_id = format!("hfc-{}", short_id());
    let out_dir = codex_home.join("generated_images").join(&batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力ディレクトリ作成失敗: {e}"))?;
    let cancellation = register_higgsfield_cancellation(&state, &batch_id).await;

    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        HiggsfieldBatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.models.len() as u32,
            provider: "higgsfield",
            model_job_set_type: None,
            model_display_name: None,
        },
    );

    let mut jobs = JoinSet::new();
    for (zero_idx, model) in args.models.iter().cloned().enumerate() {
        let idx = zero_idx as u32 + 1;
        let app_for_worker = app.clone();
        let batch_id_for_worker = batch_id.clone();
        let binary_for_worker = binary.clone();
        let out_dir_for_worker = out_dir.clone();
        let cancellation_for_worker = cancellation.clone();
        let single_args = HiggsfieldBatchArgs {
            job_set_type: model.job_set_type.clone(),
            display_name: model.display_name.clone(),
            prompt: args.prompt.clone(),
            count: 1,
            aspect: args.aspect.clone(),
            ref_image_paths: args.ref_image_paths.clone(),
            cwd: args.cwd.clone(),
            media_type: args.media_type,
            duration: model.duration.or(args.duration),
            quality: model.quality.clone().or_else(|| args.quality.clone()),
            mode: model.mode.clone().or_else(|| args.mode.clone()),
            resolution: model.resolution.clone().or_else(|| args.resolution.clone()),
            sound: model.sound.clone().or_else(|| args.sound.clone()),
            genre: model.genre.clone().or_else(|| args.genre.clone()),
            model_variant: model
                .model_variant
                .clone()
                .or_else(|| args.model_variant.clone()),
            i2v_input_field: model
                .i2v_input_field
                .clone()
                .or_else(|| args.i2v_input_field.clone()),
        };

        jobs.spawn(async move {
            let _ = app_for_worker.emit(
                EVENT_IMAGE_BATCH,
                HiggsfieldBatchEvent::WorkerStarted {
                    batch_id: batch_id_for_worker.clone(),
                    idx,
                    model_job_set_type: Some(model.job_set_type.clone()),
                    model_display_name: Some(model.display_name.clone()),
                },
            );
            eprintln!(
                "[higgsfield] compare worker idx={idx} batch={batch_id_for_worker} model={} prompt_len={} refs={} aspect={:?}",
                single_args.job_set_type,
                single_args.prompt.len(),
                single_args
                    .ref_image_paths
                    .as_deref()
                    .map(|v| v.len())
                    .unwrap_or(0),
                single_args.aspect,
            );
            match run_one_higgsfield_job(
                &binary_for_worker,
                &out_dir_for_worker,
                idx,
                &single_args,
                &cancellation_for_worker,
            )
            .await
            {
                Ok(path) => {
                    eprintln!("[higgsfield] compare worker idx={idx} OK path={path}");
                    let _ = app_for_worker.emit(
                        EVENT_IMAGE_BATCH,
                        HiggsfieldBatchEvent::WorkerCompleted {
                            batch_id: batch_id_for_worker,
                            idx,
                            path: path.clone(),
                            model_job_set_type: Some(model.job_set_type),
                            model_display_name: Some(model.display_name),
                            media_type: single_args.media_type,
                        },
                    );
                    CompareWorkerResult {
                        idx,
                        path: Some(path),
                    }
                }
                Err(error) => {
                    eprintln!("[higgsfield] compare worker idx={idx} FAIL: {error}");
                    let _ = app_for_worker.emit(
                        EVENT_IMAGE_BATCH,
                        HiggsfieldBatchEvent::WorkerFailed {
                            batch_id: batch_id_for_worker,
                            idx,
                            error,
                            model_job_set_type: Some(model.job_set_type),
                            model_display_name: Some(model.display_name),
                        },
                    );
                    CompareWorkerResult { idx, path: None }
                }
            }
        });
    }

    let mut paths_by_idx = vec![None; args.models.len()];
    let mut failed_count = 0u32;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(worker) => {
                if let Some(slot) = paths_by_idx.get_mut(worker.idx.saturating_sub(1) as usize) {
                    *slot = worker.path;
                }
            }
            Err(error) => {
                eprintln!("[higgsfield] compare worker join error: {error}");
            }
        }
    }

    let mut generated_paths = Vec::new();
    for path in paths_by_idx {
        if let Some(path) = path {
            generated_paths.push(path);
        } else {
            failed_count += 1;
        }
    }

    if cancellation.flag.load(Ordering::SeqCst) {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Cancelled {
                batch_id: batch_id.clone(),
            },
        );
    } else {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Completed {
                batch_id: batch_id.clone(),
                generated_paths: generated_paths.clone(),
                failed_count,
                provider: "higgsfield",
                model_job_set_type: None,
                model_display_name: None,
                media_type: args.media_type,
            },
        );
    }
    unregister_higgsfield_cancellation(&state, &batch_id).await;

    Ok(BatchSummary {
        batch_id,
        generated_paths,
        failed_count,
    })
}

#[tauri::command]
pub async fn higgsfield_cancel_batch(
    state: tauri::State<'_, AppState>,
    batch_id: String,
) -> Result<(), String> {
    let map = state.higgsfield_cancellations.lock().await;
    if let Some(cancellation) = map.get(&batch_id) {
        cancellation.flag.store(true, Ordering::SeqCst);
        cancellation.notify.notify_waiters();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldCostArgs {
    pub job_set_type: String,
    pub prompt: String,
    pub aspect: Option<String>,
    /// 動画モデルの尺。コストは尺に比例するため必須級。
    pub duration: Option<u32>,
    /// モデル別パラメータ (kling: mode/sound, seedance: genre/mode/resolution,
    /// veo: quality/model_variant)。コストはこれらでも変わる。
    pub quality: Option<String>,
    pub mode: Option<String>,
    pub resolution: Option<String>,
    pub sound: Option<String>,
    pub genre: Option<String>,
    pub model_variant: Option<String>,
}

#[tauri::command]
pub async fn higgsfield_generate_cost(args: HiggsfieldCostArgs) -> Result<i64, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let mut cmd = TokioCommand::new(binary);
    cmd.args(["generate", "cost", &args.job_set_type]);
    cmd.arg("--prompt").arg(&args.prompt);
    // generate create と同じフラグ名で、コストに影響するパラメータを全て渡す。
    // 渡さないと CLI が default 値でコスト計算するため、UI の表示と実コストがずれる。
    if let Some(aspect) = args.aspect.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--aspect_ratio").arg(aspect);
    }
    if let Some(duration) = args.duration {
        cmd.arg("--duration").arg(duration.to_string());
    }
    if let Some(quality) = args.quality.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--quality").arg(quality);
    }
    if let Some(mode) = args.mode.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--mode").arg(mode);
    }
    if let Some(resolution) = args.resolution.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resolution").arg(resolution);
    }
    if let Some(sound) = args.sound.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--sound").arg(sound);
    }
    if let Some(genre) = args.genre.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--genre").arg(genre);
    }
    if let Some(model_variant) = args.model_variant.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--model").arg(model_variant);
    }
    cmd.arg("--json");
    prepare_higgsfield_tokio_command(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Higgsfield generate cost の実行に失敗しました: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield generate cost が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!("Higgsfield generate cost が失敗しました: {stderr}"));
    }

    let json = parse_json_stdout(&output.stdout)?;
    json.get("credits")
        .and_then(|value| value.as_i64())
        .or_else(|| json.get("credits_exact").and_then(|value| value.as_i64()))
        .ok_or_else(|| {
            let preview = serde_json::to_string(&json).unwrap_or_else(|_| "<invalid json>".into());
            format!("Higgsfield cost JSON から credits を見つけられませんでした: {preview}")
        })
}

fn resolve_higgsfield_binary() -> Option<PathBuf> {
    // [v0.6.19] GORI GORI 専用 Higgsfield 拡張パックを最優先で探す。
    // 拡張パックは別配布の dmg/zip でユーザーがインストールする。
    // インストール先 (固定):
    //   Mac:   ~/Library/Application Support/app.codexframefactory/extensions/higgsfield/bin/higgsfield
    //   Win:   %APPDATA%/app.codexframefactory/extensions/higgsfield/bin/higgsfield.cmd
    // ラッパーは Node.js ポータブル版を内部で使うので、ユーザー環境に
    // Node.js が無くても動く設計。
    if let Some(data_dir) = dirs::data_dir() {
        let ext_bin = if cfg!(windows) { "higgsfield.cmd" } else { "higgsfield" };
        let ext_path = data_dir
            .join("app.codexframefactory")
            .join("extensions")
            .join("higgsfield")
            .join("bin")
            .join(ext_bin);
        if ext_path.exists() {
            return Some(ext_path);
        }
    }

    // Codex クロスレビュー (2026-05-19): 外部 `which` コマンドは
    // Windows に標準で存在しないため、Rust の which クレートで PATH 上を
    // 探索する。enriched_path() を渡すことで Finder 起動でも Homebrew や
    // ~/.npm-global/bin を含む拡張済み PATH を検索対象にできる。
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if let Ok(found) = which::which_in("higgsfield", Some(&enriched_path()), &cwd) {
        if found.exists() {
            return Some(found);
        }
    }

    for candidate in [
        PathBuf::from("/opt/homebrew/bin/higgsfield"),
        PathBuf::from("/usr/local/bin/higgsfield"),
    ] {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    find_nvm_higgsfield()
}

fn find_nvm_higgsfield() -> Option<PathBuf> {
    let versions_dir = dirs::home_dir()?.join(".nvm/versions/node");
    let entries = std::fs::read_dir(versions_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("bin/higgsfield");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn auth_status(binary: &Path) -> bool {
    // higgsfield CLI には `auth status` サブコマンドが無く、ヘルプが返って
    // exit 0 で抜ける → 誤判定の原因 (CLI 0.1.35 で確認)。
    // 代わりに `auth token` を使う:
    //   - 認証済み: 現在のアクセストークンを stdout に出力 + exit 0
    //   - 未認証: error を stderr に出して exit non-zero
    // stdout が空でないことも追加条件にして「ヘルプが間違って通る」事故を防ぐ
    //
    // Codex クロスレビュー (2026-05-19): PATH 継承 + Windows CREATE_NO_WINDOW を統一適用。
    let mut cmd = Command::new(binary);
    cmd.args(["auth", "token"]);
    prepare_higgsfield_command(&mut cmd);
    let Ok(output) = cmd.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    !stdout.trim().is_empty()
}

fn command_text<const N: usize>(binary: &Path, args: [&str; N]) -> Result<String, String> {
    // Codex クロスレビュー (2026-05-19): login / logout / --version 等の根幹操作。
    // prepare_higgsfield_command で PATH + Windows コンソール抑制を統一適用。
    let mut cmd = Command::new(binary);
    cmd.args(args);
    prepare_higgsfield_command(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        return Ok(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("Higgsfield CLI が失敗しました: {}", output.status))
    } else {
        Err(stderr)
    }
}

async fn register_higgsfield_cancellation(
    state: &tauri::State<'_, AppState>,
    batch_id: &str,
) -> HiggsfieldCancellation {
    let cancellation = HiggsfieldCancellation {
        flag: Arc::new(AtomicBool::new(false)),
        notify: Arc::new(tokio::sync::Notify::new()),
    };
    state
        .higgsfield_cancellations
        .lock()
        .await
        .insert(batch_id.to_string(), cancellation.clone());
    cancellation
}

async fn unregister_higgsfield_cancellation(state: &tauri::State<'_, AppState>, batch_id: &str) {
    state.higgsfield_cancellations.lock().await.remove(batch_id);
}

fn cancelled_error() -> String {
    "cancelled (credits consumed)".to_string()
}

fn is_cancelled_error(error: &str) -> bool {
    error.starts_with("cancelled")
}

fn emit_cancelled_workers(
    app: &AppHandle,
    batch_id: &str,
    start_idx: u32,
    end_idx: u32,
    model_job_set_type: Option<&str>,
    model_display_name: Option<&str>,
) -> u32 {
    if start_idx > end_idx {
        return 0;
    }
    for idx in start_idx..=end_idx {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::WorkerFailed {
                batch_id: batch_id.to_string(),
                idx,
                error: cancelled_error(),
                model_job_set_type: model_job_set_type.map(str::to_string),
                model_display_name: model_display_name.map(str::to_string),
            },
        );
    }
    end_idx - start_idx + 1
}

async fn wait_for_cancellation(cancellation: &HiggsfieldCancellation) {
    loop {
        let notified = cancellation.notify.notified();
        tokio::pin!(notified);
        if cancellation.flag.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}

async fn collect_child_output(
    status: ExitStatus,
    stdout_task: PipeReadTask,
    stderr_task: PipeReadTask,
) -> Result<Output, String> {
    let stdout = stdout_task
        .await
        .map_err(|e| format!("Higgsfield stdout 読み取りタスクが失敗しました: {e}"))?
        .map_err(|e| format!("Higgsfield stdout の読み取りに失敗しました: {e}"))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("Higgsfield stderr 読み取りタスクが失敗しました: {e}"))?
        .map_err(|e| format!("Higgsfield stderr の読み取りに失敗しました: {e}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn wait_child_output_or_cancel(
    mut child: Child,
    cancellation: &HiggsfieldCancellation,
) -> Result<Option<Output>, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stdout) = stdout {
            stdout.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stderr) = stderr {
            stderr.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });

    tokio::select! {
        status = child.wait() => {
            let status = status
                .map_err(|e| format!("Higgsfield generate create の待機に失敗しました: {e}"))?;
            collect_child_output(status, stdout_task, stderr_task).await.map(Some)
        }
        _ = wait_for_cancellation(cancellation) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            Ok(None)
        }
    }
}

/// i2v 入力画像を渡す CLI フラグを返す。
///
/// 重要 (2026-05-29 修正): Higgsfield CLI のメディア入力は **メディアフラグ**
/// (`--image` / `--start-image` / `--video` 等) で渡す。CLI が自動アップロードし、
/// モデル定義の params 構造 (seedance/kling の `medias` array、veo の `input_image`
/// object 等) に変換してくれる。
///
/// 旧実装は `i2vInputField` ("medias" 等の **params 名**) をそのままフラグ化して
/// `--medias <path>` を渡していたため、`Invalid types: medias should be array, got
/// string` で全 i2v 生成が失敗していた。params 名は CLI フラグ名ではない。
///
/// 現状の対応モデル (kling3_0 / seedance_2_0 / veo3_1) の i2v 入力はいずれも
/// 単一の開始画像なので `--image` に統一する。`--start-image` 等が必要な
/// モデルを追加する場合はここで分岐する。
fn i2v_cli_flag(field: Option<&str>) -> String {
    // 明示的にメディアフラグ ("--start-image" 等) が指定された場合だけ尊重する。
    // それ以外 (params 名 "medias"/"input_image"/"image"/None) は "--image" に統一。
    match field.map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) if f.starts_with("--") => f.to_string(),
        _ => "--image".to_string(),
    }
}

async fn run_one_higgsfield_job(
    binary: &Path,
    out_dir: &Path,
    idx: u32,
    args: &HiggsfieldBatchArgs,
    cancellation: &HiggsfieldCancellation,
) -> Result<String, String> {
    if cancellation.flag.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }

    let mut cmd = TokioCommand::new(binary);
    cmd.args(["generate", "create", &args.job_set_type]);
    cmd.arg("--prompt").arg(&args.prompt);
    // Higgsfield CLI は params を `--<snake_case_name> <value>` で受け取る
    // (例: `--aspect_ratio 16:9`)。フラグ名は `higgsfield model get <model>` の
    // `params[].name` と一致する必要がある (kebab-case や省略形は Unknown params エラー)。
    if let Some(aspect) = args.aspect.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--aspect_ratio").arg(aspect);
    }
    // P0-2 動画モデル静的定義 (2026-05-28)
    if let Some(duration) = args.duration {
        cmd.arg("--duration").arg(duration.to_string());
    }
    if let Some(quality) = args.quality.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--quality").arg(quality);
    }
    if let Some(mode) = args.mode.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--mode").arg(mode);
    }
    if let Some(resolution) = args.resolution.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resolution").arg(resolution);
    }
    if let Some(sound) = args.sound.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--sound").arg(sound);
    }
    if let Some(genre) = args.genre.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--genre").arg(genre);
    }
    if let Some(model_variant) = args
        .model_variant
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        cmd.arg("--model").arg(model_variant);
    }
    let i2v_flag = i2v_cli_flag(args.i2v_input_field.as_deref());
    for path in args.ref_image_paths.as_deref().unwrap_or(&[]) {
        if !path.trim().is_empty() {
            cmd.arg(&i2v_flag).arg(path);
        }
    }
    cmd.args([
        "--wait",
        "--wait-timeout",
        "20m",
        "--wait-interval",
        "5s",
        "--json",
    ]);
    if let Some(cwd) = args.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.current_dir(cwd);
    }
    prepare_higgsfield_tokio_command(&mut cmd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Higgsfield generate create の実行に失敗しました: {e}"))?;
    let Some(output) = wait_child_output_or_cancel(child, cancellation).await? else {
        return Err(cancelled_error());
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield generate create が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!(
            "Higgsfield generate create が失敗しました: {stderr}"
        ));
    }

    let json = parse_json_stdout(&output.stdout)?;
    let result_url = match extract_result_image(&json) {
        Some(url) => url,
        None => {
            // URL が無い = 多くは status=nsfw/failed。理由を明示して返す。
            if let Some(reason) = extract_failure_reason(&json) {
                return Err(reason);
            }
            let preview =
                serde_json::to_string(&json).unwrap_or_else(|_| "<invalid json>".into());
            return Err(format!(
                "Higgsfield 出力 JSON から画像 URL を見つけられませんでした: {preview}"
            ));
        }
    };
    let media_type = args.media_type.unwrap_or(MediaType::Image);
    let dest = out_dir.join(format!(
        "hf_b{idx:02}_{}.{}",
        short_id(),
        media_type.extension()
    ));
    save_result_image(&result_url, &dest).await?;
    Ok(dest.to_string_lossy().into_owned())
}

fn parse_json_stdout(stdout: &[u8]) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(value);
    }
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            return Ok(value);
        }
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            if start < end {
                let candidate = &text[start..=end];
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                    return Ok(value);
                }
            }
        }
    }
    Err(format!(
        "Higgsfield generate create の JSON デコードに失敗しました: {}",
        trimmed
    ))
}

/// 生成結果 JSON から「失敗理由」を読み取り、ユーザー向けの日本語メッセージを返す。
/// result_url が空でも status が nsfw/failed 等なら、それを明示する。
/// 正常 (completed で URL あり) の場合は None。
fn extract_failure_reason(value: &serde_json::Value) -> Option<String> {
    // トップが配列ならその先頭、オブジェクトならそのまま見る
    let obj = value
        .as_array()
        .and_then(|arr| arr.first())
        .unwrap_or(value);
    let status = obj
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match status.as_str() {
        "nsfw" => Some(
            "このプロンプトは Seedance/Higgsfield の安全フィルターにブロックされました (NSFW 判定)。\n\
             暴力・流血・性的表現などが含まれていると弾かれます。表現を和らげて再試行してください。\n\
             ※ 同じプロンプトでも Kling / Veo は通ることがあります (モデルごとに判定が違うため)。"
                .to_string(),
        ),
        "failed" | "error" | "cancelled" | "canceled" => Some(format!(
            "生成がモデル側で失敗しました (status: {status})。プロンプトや設定を変えて再試行してください。"
        )),
        _ => None,
    }
}

fn extract_result_image(value: &serde_json::Value) -> Option<String> {
    // Higgsfield CLI `generate create --wait --json` の出力形式 (公式 README 準拠):
    //   - トップレベルが配列 [{...}] (1 ジョブ = 1 要素)
    //   - 各要素のトップに `result_url` キー
    //   - status: "completed" を確認した方が安全
    // 例:
    //   [{"id":"...","status":"completed","result_url":"https://.../hf_xxx.png",
    //     "job_set_type":"nano_banana","params":{...}}]
    //
    // POINTERS は公式パターンを最優先で並べる。マッチしなければ再帰で url 系
    // キーを総当たり (古い API / 別モデルへの保険)。
    const POINTERS: [&str; 27] = [
        // 公式形式: トップ配列の [0].result_url
        "/0/result_url",
        "/0/resultUrl",
        "/0/url",
        // 単発オブジェクト形式 (一部モデルが返す可能性)
        "/result_url",
        "/resultUrl",
        "/url",
        // 旧 / 別パターン (フォールバック)
        "/result/images/0/url",
        "/result/images/0",
        "/result/image/url",
        "/result/outputs/0/url",
        "/result/outputs/0",
        "/result/outputUrl",
        "/result/output_url",
        "/result/resultUrl",
        "/result/result_url",
        "/result/url",
        "/data/images/0/url",
        "/data/images/0",
        "/data/image/url",
        "/data/outputs/0/url",
        "/data/outputs/0",
        "/data/outputUrl",
        "/data/output_url",
        "/data/result_url",
        "/outputUrl",
        "/output_url",
        "/0/url",
    ];
    for pointer in POINTERS {
        if let Some(url) = value.pointer(pointer).and_then(|v| v.as_str()) {
            if is_usable_result_ref(url) {
                return Some(url.to_string());
            }
        }
    }

    let mut keyed_urls = Vec::new();
    collect_url_key_strings(value, &mut keyed_urls);
    keyed_urls.into_iter().find(|url| is_usable_result_ref(url))
}

fn collect_url_key_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let lower = key.to_ascii_lowercase();
                if lower.contains("url") {
                    if let Some(s) = child.as_str().filter(|s| is_usable_result_ref(s)) {
                        out.push(s.to_string());
                    }
                }
                collect_url_key_strings(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_url_key_strings(item, out);
            }
        }
        _ => {}
    }
}

fn is_usable_result_ref(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://") || Path::new(trimmed).exists()
}

async fn save_result_image(src: &str, dest: &Path) -> Result<(), String> {
    let trimmed = src.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        // Codex クロスレビュー (2026-05-19): Windows 10 等で `curl.exe` の存在が
        // 保証されないため、外部コマンド依存を reqwest に置き換える。
        // タイムアウト 60s でフェイルセーフを入れる (Higgsfield CDN が遅い時の保護)。
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("HTTP クライアントの初期化に失敗しました: {e}"))?;
        let response = client
            .get(trimmed)
            .send()
            .await
            .map_err(|e| format!("画像ダウンロードに失敗しました: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "画像ダウンロードに失敗しました: HTTP {}",
                response.status()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("レスポンス body の読み取りに失敗しました: {e}"))?;
        tokio::fs::write(dest, &bytes)
            .await
            .map_err(|e| format!("ファイル書き込みに失敗しました: {e}"))?;
        return Ok(());
    }
    std::fs::copy(trimmed, dest)
        .map(|_| ())
        .map_err(|e| format!("Higgsfield 出力画像のコピーに失敗しました: {e}"))
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos)
}
