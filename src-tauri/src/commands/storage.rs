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

/// 保持する projects.json バックアップの世代数。これを超えた古いものは削除する。
const PROJECTS_BACKUP_KEEP: usize = 10;

/// JSON 文字列に含まれるプロジェクト件数 (トップレベル配列の要素数) を数える。
/// パースできない/配列でないときは None。空上書きガードと件数比較に使う。
fn count_projects(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Array(arr)) => Some(arr.len()),
        _ => None,
    }
}

/// projects.json を世代付きバックアップする。`path` が存在しなければ何もしない。
/// `<path>.bak-YYYYMMDD-HHMMSS` を作り、PROJECTS_BACKUP_KEEP を超えた古い世代を削除。
/// バックアップ失敗は致命ではない (ログのみ) — 本書き込みは止めない。
fn backup_projects_file(path: &Path) {
    if !path.exists() {
        return;
    }
    let file_name = match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return,
    };
    let dir = match path.parent() {
        Some(d) => d,
        None => return,
    };
    // タイムスタンプ (epochミリ秒)。chrono 非依存で SystemTime から組む。
    // 秒だと同一秒内の連続保存でバックアップ名が衝突し世代が潰れるため、ミリ秒にする。
    // ミリ秒は13桁で当面桁揃いなので、文字列 sort = 数値 sort が成り立つ。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let bak = dir.join(format!("{file_name}.bak-{stamp}"));
    if let Err(err) = fs::copy(path, &bak) {
        eprintln!("[projects] バックアップ作成失敗 (継続): {err}");
        return;
    }
    // 古い世代を掃除する。`<file_name>.bak-` 始まりを集めて、名前順 (= 時刻順) で
    // 末尾 PROJECTS_BACKUP_KEEP 件だけ残す。
    let prefix = format!("{file_name}.bak-");
    let mut baks: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| n.starts_with(&prefix))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return,
    };
    if baks.len() > PROJECTS_BACKUP_KEEP {
        baks.sort();
        let remove_count = baks.len() - PROJECTS_BACKUP_KEEP;
        for old in baks.into_iter().take(remove_count) {
            let _ = fs::remove_file(old);
        }
    }
}

/// projects.json に書き込む (上書き)。
/// フロント側で JSON.stringify した文字列をそのまま渡す。
///
/// データ消失を構造的に防ぐため、以下を行う:
///   1. 書き込み前に既存ファイルを世代バックアップ (`.bak-<epochミリ秒>`、最大10世代)。
///      → 何が起きても直前の状態に戻せる (配布ユーザーが自力復旧できる土台)。
///   2. 「既存はN件(N>0)あるのに、今回0件で上書き」する場合は、`allow_empty` が
///      false のとき **拒否** する。
///      → 起動直後の読込失敗や誤操作で全プロジェクトが空書き潰しされる事故を防ぐ。
///      → ただしユーザーが**意図的に全削除した**ときはフロントが `allow_empty=true` を
///        渡すので、その場合は空書き込みを許可する (「消せない」退行を防ぐ)。
///   3. tmp 経由でアトミックに rename (書き込み中断でも旧ファイルが壊れない)。
///
/// `allow_empty`: 0件での上書きを許可するか。通常の保存は false (事故防止)。
///   ユーザー操作による明示的な全削除のときだけ true を渡す。
#[tauri::command]
pub async fn projects_write(content: String, allow_empty: Option<bool>) -> Result<(), String> {
    let path = projects_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    // 空上書きガード: 既存が非空で今回が0件、かつ明示許可でないなら拒否 (事故防止)。
    if !allow_empty && path.exists() {
        if let Ok(existing) = fs::read_to_string(&path) {
            let existing_count = count_projects(&existing).unwrap_or(0);
            let incoming_count = count_projects(&content).unwrap_or(0);
            if existing_count > 0 && incoming_count == 0 {
                // 念のためバックアップは取った上で、上書きは行わない。
                backup_projects_file(&path);
                return Err(format!(
                    "空のプロジェクトデータで {existing_count} 件を上書きしようとしたため中止しました (データ保護)。意図的な全削除なら allow_empty を指定してください。"
                ));
            }
        }
    }

    // 書き込み前に世代バックアップ。
    backup_projects_file(&path);

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content)
        .map_err(|err| format!("projects.json 一時書込失敗: {err}"))?;
    fs::rename(&tmp_path, &path)
        .map_err(|err| format!("projects.json リネーム失敗: {err}"))?;
    Ok(())
}

/// projects.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epoch秒, プロジェクト件数)。
/// 設定画面の「バックアップから復元」UI が使う。
#[tauri::command]
pub async fn projects_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "projects.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = format!("{file_name}.bak-");
    let mut out: Vec<(String, u64, usize)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            let stamp: u64 = name[prefix.len()..].parse().unwrap_or(0);
            let count = fs::read_to_string(&p)
                .ok()
                .and_then(|c| count_projects(&c))
                .unwrap_or(0);
            // 0件のバックアップは復元候補に出さない (空で復元しても意味がなく、
            // 空上書きガードに弾かれて無言で失敗するため。evaluator 指摘)。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1)); // 新しい順
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// 復元前のプレビュー、または復元適用にフロントが使う。
/// パスは projects_list_backups が返したものに限定 (prefix 一致で検証)。
#[tauri::command]
pub async fn projects_read_backup(backup_path: String) -> Result<String, String> {
    let path = projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "projects.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    // 任意パス読み出しを防ぐ: 既定のバックアップ命名にマッチするものだけ許可。
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// projects.json ファイルのプロジェクト件数を返す。
///   - 存在しない → Ok(0)
///   - 存在して読めて配列 → Ok(件数)
///   - 存在して読めるが壊れたJSON → Ok(0) (中身が無効＝0件相当)
///   - **存在するが read 失敗 (Google Drive の os error 13 等)** → Err
///
/// read 失敗を 0 と混同すると、旧側が読めないときに「0件＝引き継ぎ不要」と誤判定して
/// 旧データを取りこぼす (今回の事故の読み取り側変種)。Err で区別し、呼び出し側が中止できるようにする。
fn projects_count_at(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    match fs::read_to_string(path) {
        Ok(c) => Ok(count_projects(&c).unwrap_or(0)),
        Err(err) => Err(format!(
            "プロジェクトデータの読み取りに失敗 ({}): {err}",
            path.display()
        )),
    }
}

/// プロジェクトデータ保存先 (projects_data_root) を変更する。
///
/// **データ消失を構造的に防ぐ移行ポリシー (2026-06-09 改修)**:
///   - 旧 = 新 のときは何もしない。
///   - 旧側の件数 >= 新側の件数 のとき、旧側を新側へコピーして引き継ぐ。
///     新側を上書きする前に世代バックアップを取る。
///     → 「8件の保存先から、空/古い保存先へ切り替えたら消えた」事故を防ぐ
///       (件数の多い/同等な方を必ず勝たせる。古い方を黙って正にしない)。
///   - 新側の方が件数が多いときは新側を尊重しコピーしない。
///   - **コピーに失敗 (Google Drive の os error 13 等) したら、設定変更を中止して
///     元の保存先のままにする**。データは旧側にそのまま残るので消えない。
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

    if old_path != new_path {
        // 旧側が「存在するのに読めない」(os error 13 等) ときは、引き継ぎ可否を
        // 判断できないまま保存先を切り替えると旧データを取りこぼす。中止して保持する。
        let old_count = projects_count_at(&old_path).map_err(|err| {
            format!("保存先の変更を中止しました (データは元の場所に保持されています)。{err}")
        })?;
        // 新側が読めない場合は「件数不明」だが、ここで中止すると新規フォルダに切り替え
        // られなくなるため、安全側に new_count=0 (新側は空とみなす) で進める。
        // (新側に実データがあって読めないケースでも、上書き前に backup を取る)
        let new_count = projects_count_at(&new_path).unwrap_or(0);

        // 旧側が新側と同等以上の件数を持つときだけ、旧→新へ引き継ぐ。
        // (新側が多いなら新側のデータを尊重して触らない)
        if old_count > 0 && old_count >= new_count {
            if let Some(parent) = new_path.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!("プロジェクトデータ保存先の作成に失敗: {err}")
                })?;
            }
            // 新側に既存データがあるなら上書き前にバックアップ (戻せるように)。
            if new_path.exists() {
                backup_projects_file(&new_path);
            }
            // コピー失敗時は設定を変更しない = 元の保存先のままデータを保持する。
            fs::copy(&old_path, &new_path).map_err(|err| {
                format!(
                    "保存先の変更を中止しました (データは元の場所に保持されています)。移行に失敗 ({} -> {}): {err}",
                    old_path.display(),
                    new_path.display()
                )
            })?;
        }
    }

    settings.projects_data_root = normalized;
    settings.save()?;
    state.set_storage_settings(settings).await;
    Ok(())
}
