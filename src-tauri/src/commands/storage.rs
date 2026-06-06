use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::images::watcher::{
    generated_images_dir, legacy_generated_images_dir, scan_existing, start_watcher,
};
use crate::state::AppState;

const SERVICE_DIR: &str = "Library/Application Support/app.codexframefactory";
const SETTINGS_FILE: &str = "storage-settings.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettings {
    #[serde(default = "default_storage_root_string")]
    pub storage_root: String,
    #[serde(default = "default_project_subfolder")]
    pub project_subfolder: bool,
    /// プロジェクトデータ (projects.json) を保存するフォルダ。
    /// 未指定 (None) なら従来どおり OS 標準のアプリデータディレクトリ
    /// (~/Library/Application Support/app.codexframefactory 等) に保存する。
    /// Google Drive 等のローカル同期フォルダを指定すると、作品データを
    /// クラウド同期できる (Drive API は使わず、同期フォルダのパス指定方式)。
    #[serde(default)]
    pub projects_data_root: Option<String>,
    #[serde(default)]
    pub cloud_supabase_enabled: bool,
    #[serde(default)]
    pub supabase_project_url: Option<String>,
    #[serde(default)]
    pub supabase_bucket_name: Option<String>,
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            storage_root: default_storage_root_string(),
            project_subfolder: true,
            projects_data_root: None,
            cloud_supabase_enabled: false,
            supabase_project_url: None,
            supabase_bucket_name: None,
        }
    }
}

impl StorageSettings {
    pub fn load() -> Result<Self, String> {
        let path = settings_path()?;
        let settings = if path.exists() {
            let text = fs::read_to_string(&path)
                .map_err(|e| format!("保存先設定の読み込みに失敗 ({}): {e}", path.display()))?;
            if text.trim().is_empty() {
                Self::default()
            } else {
                serde_json::from_str::<Self>(&text)
                    .map_err(|e| format!("保存先設定の解析に失敗 ({}): {e}", path.display()))?
            }
        } else {
            Self::default()
        };
        settings.ensure_root()?;
        Ok(settings)
    }

    pub fn save(&self) -> Result<(), String> {
        self.ensure_root()?;
        let path = settings_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("保存先設定ディレクトリの作成に失敗: {e}"))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("保存先設定のJSON化に失敗: {e}"))?;
        fs::write(&path, text)
            .map_err(|e| format!("保存先設定の保存に失敗 ({}): {e}", path.display()))
    }

    pub fn ensure_root(&self) -> Result<(), String> {
        fs::create_dir_all(&self.storage_root).map_err(|e| {
            format!(
                "保存先ディレクトリの作成に失敗 ({}): {e}",
                self.storage_root
            )
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub copied_count: u32,
    pub failed_count: u32,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySummary {
    pub exists: bool,
    pub file_count: u32,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    /// 現在のローカル保存先のパス（絶対パス）
    pub storage_root: String,
    /// ローカル保存先配下の全ファイル数（再帰）
    pub file_count: u32,
    /// ローカル保存先配下の合計バイト数
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn storage_get_settings(state: State<'_, AppState>) -> Result<StorageSettings, String> {
    let settings = StorageSettings::load()?;
    state.set_storage_settings(settings.clone()).await;
    Ok(settings)
}

#[tauri::command]
pub async fn storage_set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: StorageSettings,
) -> Result<(), String> {
    settings.save()?;
    state.set_storage_settings(settings).await;
    restart_image_watcher(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn storage_migrate_from_codex_home(
    state: State<'_, AppState>,
) -> Result<MigrationResult, String> {
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    // 「旧保存先から移行」コマンド。対象は旧 ~/.codex/generated_images に残る
    // 過去画像。FB#19 で generated_images_dir() が GORI 専用 HOME を指すように
    // なったため、ここは明示的にレガシーディレクトリを参照する (移行漏れ防止)。
    // コピーのみ・元は消さないので非破壊。
    let legacy =
        legacy_generated_images_dir().ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    if !legacy.exists() {
        return Ok(MigrationResult {
            copied_count: 0,
            failed_count: 0,
            total_bytes: 0,
        });
    }

    let dest_root = PathBuf::from(&settings.storage_root);
    fs::create_dir_all(&dest_root).map_err(|e| format!("移行先の作成に失敗: {e}"))?;

    let mut result = MigrationResult {
        copied_count: 0,
        failed_count: 0,
        total_bytes: 0,
    };

    let entries = fs::read_dir(&legacy)
        .map_err(|e| format!("旧保存先の読み込みに失敗 ({}): {e}", legacy.display()))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            result.failed_count += 1;
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_migratable_legacy_dir(&name) {
            continue;
        }
        copy_dir_contents(&entry.path(), &dest_root.join(&name), &mut result);
    }

    Ok(result)
}

/// ユーザーのホームディレクトリパスを返す。UI で推奨パスを組み立てる時に使う。
/// 「~/ 短縮表示」と「絶対パス」を正しく対応付けるため、UI 側が逆算するのではなく
/// このコマンドで取得する。
#[tauri::command]
pub async fn storage_home_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    Ok(home.to_string_lossy().into_owned())
}

/// 現在のローカル保存先の容量を集計する。サイドバーのストレージインジケータで表示。
#[tauri::command]
pub async fn storage_usage_stats(state: State<'_, AppState>) -> Result<UsageStats, String> {
    let settings = match state.storage_settings().await {
        Some(s) => s,
        None => StorageSettings::load()?,
    };
    let root = PathBuf::from(&settings.storage_root);
    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    if root.exists() {
        summarize_files(&root, &mut file_count, &mut total_bytes);
    }
    Ok(UsageStats {
        storage_root: settings.storage_root,
        file_count,
        total_bytes,
    })
}

#[tauri::command]
pub async fn storage_legacy_summary() -> Result<LegacySummary, String> {
    // 「旧保存先のサマリー」も移行 UI 用なので旧 ~/.codex/generated_images を参照。
    let Some(legacy) = legacy_generated_images_dir() else {
        return Ok(LegacySummary {
            exists: false,
            file_count: 0,
            total_bytes: 0,
        });
    };
    if !legacy.exists() {
        return Ok(LegacySummary {
            exists: false,
            file_count: 0,
            total_bytes: 0,
        });
    }

    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    summarize_files(&legacy, &mut file_count, &mut total_bytes);
    Ok(LegacySummary {
        exists: true,
        file_count,
        total_bytes,
    })
}

pub fn settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    Ok(home.join(SERVICE_DIR).join(SETTINGS_FILE))
}

pub fn resolve_output_dir(
    settings: &StorageSettings,
    project_name: Option<&str>,
    leaf_dir: &str,
) -> PathBuf {
    let mut base = PathBuf::from(&settings.storage_root);
    if settings.project_subfolder {
        if let Some(name) = project_name.map(str::trim).filter(|name| !name.is_empty()) {
            let sanitized = sanitize_filename(name);
            if !sanitized.trim_matches('_').is_empty() {
                base = base.join(sanitized);
            }
        }
    }
    base.join(leaf_dir)
}

pub fn project_name_from_cwd(cwd: Option<&str>) -> Option<String> {
    let cwd = cwd.map(str::trim).filter(|cwd| !cwd.is_empty())?;
    Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect()
}

pub async fn initialize_storage(state: &AppState) -> Result<StorageSettings, String> {
    let settings = StorageSettings::load()?;
    settings.save()?;
    state.set_storage_settings(settings.clone()).await;
    Ok(settings)
}

async fn restart_image_watcher(app: &AppHandle, state: &AppState) {
    let settings = state.storage_settings().await;
    let dirs = watcher_dirs(settings.as_ref());
    for dir in &dirs {
        scan_existing(app, dir);
    }
    match start_watcher(app.clone(), dirs.clone()) {
        Ok(watcher) => state.set_image_watcher(watcher).await,
        Err(err) => {
            tracing::warn!(target: "codex.watcher", "storage watcher restart failed: {err}")
        }
    }
}

pub fn watcher_dirs(settings: Option<&StorageSettings>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // 現行の image_gen 出力先 (GORI 専用 CODEX_HOME/generated_images)。
    if let Some(active) = generated_images_dir() {
        dirs.push(active);
    }
    // FB#19 で CODEX_HOME を切り替える前に生成された過去画像が残る旧
    // ~/.codex/generated_images も読み取り専用で監視に含める (退行防止・消さない)。
    // 専用 HOME に統一した結果、active とは別パスなので重複しない限り追加する。
    if let Some(legacy) = crate::images::watcher::legacy_generated_images_dir() {
        if !dirs.iter().any(|dir| dir == &legacy) {
            dirs.push(legacy);
        }
    }
    if let Some(settings) = settings {
        let storage = PathBuf::from(&settings.storage_root);
        if !dirs.iter().any(|dir| dir == &storage) {
            dirs.push(storage);
        }
    }
    dirs
}

fn default_storage_root_string() -> String {
    let home = dirs::home_dir().expect("home dir");
    home.join("Pictures")
        .join("GORI GORI")
        .to_string_lossy()
        .into_owned()
}

fn default_project_subfolder() -> bool {
    true
}

fn is_migratable_legacy_dir(name: &str) -> bool {
    name.starts_with("batch-") || name.starts_with("hfc-") || name.starts_with("gori-storyboard-")
}

fn copy_dir_contents(src: &Path, dest: &Path, result: &mut MigrationResult) {
    if let Err(err) = fs::create_dir_all(dest) {
        tracing::warn!(target: "codex.storage", "create dir failed {}: {err}", dest.display());
        result.failed_count += 1;
        return;
    }
    let Ok(entries) = fs::read_dir(src) else {
        result.failed_count += 1;
        return;
    };
    for entry in entries.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            result.failed_count += 1;
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_dir_contents(&src_path, &dest_path, result);
        } else if file_type.is_file() {
            match fs::copy(&src_path, &dest_path) {
                Ok(bytes) => {
                    result.copied_count += 1;
                    result.total_bytes += bytes;
                }
                Err(err) => {
                    tracing::warn!(target: "codex.storage", "copy failed {} -> {}: {err}", src_path.display(), dest_path.display());
                    result.failed_count += 1;
                }
            }
        }
    }
}

fn summarize_files(dir: &Path, file_count: &mut u32, total_bytes: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            summarize_files(&path, file_count, total_bytes);
        } else if file_type.is_file() {
            *file_count = file_count.saturating_add(1);
            if let Ok(meta) = entry.metadata() {
                *total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// プロジェクト永続化 (v0.6.9)
//
// 旧設計: localStorage に projects.projects キーで保存
//   → WebView ごとに別、dev版↔配布版でデータが共有されない問題
//
// 新設計: アプリデータディレクトリの projects.json に保存
//   - Mac:   ~/Library/Application Support/app.codexframefactory/projects.json
//   - Win:   %APPDATA%/app.codexframefactory/projects.json
//   - Linux: ~/.local/share/app.codexframefactory/projects.json
//   dirs crate の data_dir() で自動解決、クロスプラットフォーム対応。
//
// 起動時に旧 localStorage データがあれば、フロント側で自動的に
// これらのコマンドを呼んでマイグレーションする。

/// OS 標準のアプリデータディレクトリ配下の projects.json パスを返す。
/// projectsDataRoot が未指定のときのデフォルト保存先 (従来挙動)。
fn default_projects_file_path() -> Result<PathBuf, String> {
    // dirs::data_dir() は OS 標準のアプリデータディレクトリを返す。
    //   Mac:   ~/Library/Application Support
    //   Win:   %APPDATA% (= C:\Users\<user>\AppData\Roaming)
    //   Linux: ~/.local/share
    let data_dir = dirs::data_dir().ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
    let app_dir = data_dir.join("app.codexframefactory");
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir)
            .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
    }
    Ok(app_dir.join("projects.json"))
}

/// projects.json の実際の保存パスを解決する。
///
/// - StorageSettings.projects_data_root が指定されていれば、その配下の
///   projects.json を使う (Google Drive 等の同期フォルダを指せる)。
/// - 未指定なら従来どおり OS 標準のアプリデータディレクトリを使う (後方互換)。
///
/// 指定フォルダが存在しない場合は作成する。
fn projects_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    projects_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) からファイルパスを組み立てる。
/// None なら default_projects_file_path() に委譲する。
fn projects_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!(
                        "プロジェクトデータ保存先の作成に失敗 ({}): {err}",
                        dir.display()
                    )
                })?;
            }
            Ok(dir.join("projects.json"))
        }
        None => default_projects_file_path(),
    }
}

/// projects.json を読み出す。存在しなければ空配列文字列を返す。
/// フロント側で JSON.parse して useProjects.projects に代入する。
#[tauri::command]
pub async fn projects_read() -> Result<String, String> {
    let path = projects_file_path()?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|err| format!("projects.json 読込失敗: {err}"))
}

/// projects.json に書き込む (上書き)。
/// フロント側で JSON.stringify した文字列をそのまま渡す。
/// 失敗時は前のファイルが壊れていないよう、tmp 経由でアトミックに書き換える。
#[tauri::command]
pub async fn projects_write(content: String) -> Result<(), String> {
    let path = projects_file_path()?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content)
        .map_err(|err| format!("projects.json 一時書込失敗: {err}"))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| format!("projects.json リネーム失敗: {err}"))?;
    Ok(())
}

/// プロジェクトデータ保存先 (projects_data_root) を変更する。
///
/// 既存の projects.json を新しい場所へ移行 (コピー) してから設定を保存する。
/// これにより保存先を切り替えても作品データが消えない。移行は冪等:
///   - 旧 = 新 のときは何もしない
///   - 新側に既に projects.json があれば上書きしない (新側を正とする)
///   - 旧側に projects.json が無ければ移行不要 (新規作成扱い)
///
/// `new_root` が空文字列または null なら、デフォルト (アプリデータ
/// ディレクトリ) に戻す。
#[tauri::command]
pub async fn projects_set_data_root(
    state: State<'_, AppState>,
    new_root: Option<String>,
) -> Result<(), String> {
    let mut settings = StorageSettings::load()?;

    let normalized = new_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(ToOwned::to_owned);

    let old_path = projects_file_path_for(settings.projects_data_root.as_deref())?;
    let new_path = projects_file_path_for(normalized.as_deref())?;

    // 旧側にデータがあり、新側にまだ無いときだけコピーする (冪等・非破壊)。
    if old_path != new_path && old_path.exists() && !new_path.exists() {
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!("プロジェクトデータ保存先の作成に失敗: {err}")
            })?;
        }
        fs::copy(&old_path, &new_path).map_err(|err| {
            format!(
                "projects.json の移行に失敗 ({} -> {}): {err}",
                old_path.display(),
                new_path.display()
            )
        })?;
    }

    settings.projects_data_root = normalized;
    settings.save()?;
    state.set_storage_settings(settings).await;
    Ok(())
}
