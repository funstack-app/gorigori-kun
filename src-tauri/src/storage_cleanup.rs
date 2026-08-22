//! ストレージ自動掃除モジュール
//!
//! 起動時 + 24時間ごとに、Codex の一時データを軽量化・削除する。
//! 設定画面から明示選択された場合だけ、カテゴリ単位の追加削除も行う。
//!
//! 軽量化対象 (GORI 専用 CODEX_HOME / 生成専用 CODEX_HOME のみ):
//! - <CODEX_HOME>/sessions/**/*.jsonl : 24時間より古い rollout の画像ペイロードのみ除去
//!
//! 削除対象 (再生成できるキャッシュのみ):
//! - <CODEX_HOME>/logs_<数字>.sqlite (-wal / -shm を含む)
//! - GORI の WebView キャッシュ
//!
//! FB#19 対応で GORI は専用 CODEX_HOME
//! (~/Library/Application Support/app.codexframefactory/codex-home) を使うように
//! なった。今後 GORI が吐く sessions はこの専用 HOME 配下に溜まるため、専用 HOME と
//! 生成専用 HOME の sessions を対象にする。旧 ~/.codex は共通 Codex CLI の領域なので
//! 容量の参考表示以外では走査・変更しない。バックグラウンド掃除では sessions 自体を
//! 削除せず、画像ペイロードのみ除去する。手動のカテゴリ選択削除では、ユーザー確認後に
//! 最終更新24時間以上の sessions ファイルだけを削除できる。
//!
//! 絶対に触らないもの:
//! - **~/Library/WebKit/<id>/WebsiteData/ (localStorage の実体)**
//!   2026-08-06: ここを消していたため実ユーザーのプリセット30体が消えた。
//!   localStorage は presets/scene3d/motions の冗長バックアップで、ファイル正本の
//!   作成に失敗したときの唯一の生き残りになる。掃除が消してよいものではない。
//! - ~/Pictures/GORI GORI/ (ユーザーの作品データ)
//! - ~/Desktop/ (ユーザーデータ)
//! - 直近24時間以内の sessions ファイル (稼働中 app-server の保護。手動でも消さない)
//! - <CODEX_HOME>/generated_images/ / ~/.codex/generated_images/ (生成画像)
//! - <CODEX_HOME>/history.db / projects/ (履歴・プロジェクト)
//! - <CODEX_HOME>/skills/ / ~/.codex/skills/ (スキル本体)
//! - <CODEX_HOME>/memories/ / ~/.codex/memories/ (メモリ本体)
//! - <CODEX_HOME>/auth.json / config.toml (認証・設定)

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::time::interval;

/// rollout の画像ペイロードを除去するまでの時間。
const STRIP_MIN_AGE_HOURS: u64 = 24;
/// 24時間ごと
const SWEEP_INTERVAL_HOURS: u64 = 24;
const DATA_IMAGE_PREFIX: &[u8] = b"data:image/";
const BASE64_MARKER: &[u8] = b";base64,";
const STRIPPED_PAYLOAD: &[u8] = b"[stripped]";

/// 画像ペイロード専用フィールドの名前 (2026-08-06 監査指摘)。
///
/// **なぜ限定が要るか**: 従来は「JSON文字列の中にある `data:image/...;base64,`」を
/// 位置だけで判定しており、**どのフィールドに入っているかを見ていなかった**。
/// そのため会話ログ本文 (`text` 等) がたまたま画像URLを含んでいると、
/// ユーザーの発言やツール出力の中身まで `[stripped]` に書き換わる。
///
/// 実測 (2026-08-06、実 rollout 1666ファイル走査): `data:image/` を含む文字列 909 件のうち
/// 908 件は `image_url`、**1 件は `text`** (ツール出力の本文が `{"image_url":"data:image/..."}`
/// という文字列を引用していたケース) だった。後者は掃除対象ではない = 本文の改変にあたる。
///
/// ここに載せるのは「その値が画像ペイロードそのもの」であるフィールドだけ。
/// 本文・説明・ログを載せてはいけない。
const IMAGE_PAYLOAD_FIELDS: &[&[u8]] = &[b"image_url", b"imageUrl"];
const STRIP_STATE_FILE: &str = "rollout-image-strip-v1.json";
pub(crate) const THUMB_CACHE_DIR_NAME: &str = "thumb-cache";

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub sessions_deleted: u64,
    pub sessions_bytes_freed: u64,
    pub stripped_files: u64,
    pub stripped_bytes_freed: u64,
    pub generated_images_deleted: u64,
    pub generated_images_bytes_freed: u64,
    /// Codex ログ (logs_<数字>.sqlite*) と WebView キャッシュの解放バイト数。
    /// FB-A4: 掃除前 inspect で表示していたのに run_cleanup が消していなかった分。
    pub cache_bytes_freed: u64,
    pub errors: Vec<String>,
}

/// ストレージ内訳の1カテゴリ分。
///
/// `bytes` / `count` は実際に存在する総量、`deletable_*` は現在の安全条件で
/// 選択削除できる量。sessions は直近24時間を保護するため、この2組が異なる。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategoryStats {
    pub bytes: u64,
    pub count: u64,
    pub deletable_bytes: u64,
    pub deletable_count: u64,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    pub sessions: StorageCategoryStats,
    pub logs: StorageCategoryStats,
    pub webview_cache: StorageCategoryStats,
    pub backups: StorageCategoryStats,
    pub broken_quarantine: StorageCategoryStats,
    pub app_data: StorageCategoryStats,
    /// 共通 `~/.codex` の参考容量。GORI の削除対象には絶対に入れない。
    pub common_codex: StorageCategoryStats,
    pub total_bytes: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupCategoriesReport {
    pub freed_bytes_by_category: BTreeMap<String, u64>,
    pub deleted_counts_by_category: BTreeMap<String, u64>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum StorageCategory {
    Sessions,
    Logs,
    WebviewCache,
    Backups,
    BrokenQuarantine,
    AppData,
}

impl StorageCategory {
    fn key(self) -> &'static str {
        match self {
            Self::Sessions => "sessions",
            Self::Logs => "logs",
            Self::WebviewCache => "webviewCache",
            Self::Backups => "backups",
            Self::BrokenQuarantine => "brokenQuarantine",
            Self::AppData => "appData",
        }
    }

    fn parse_cleanup(value: &str) -> Result<Self, String> {
        match value {
            "sessions" => Ok(Self::Sessions),
            "logs" => Ok(Self::Logs),
            "webviewCache" => Ok(Self::WebviewCache),
            "backups" => Ok(Self::Backups),
            "brokenQuarantine" => Ok(Self::BrokenQuarantine),
            // appData は作品・画像・登録データを含む。UIの状態に関係なく、
            // Rust 境界で構造的に拒否して削除不能にする。
            "appData" => Err("実データ (appData) は削除できません".to_string()),
            other => Err(format!("不明なストレージカテゴリです: {other}")),
        }
    }
}

#[derive(Debug, Clone)]
struct StorageScanContext {
    /// GORI が所有する2つの CODEX_HOME だけ。共通 `~/.codex` は含めない。
    gori_codex_homes: Vec<PathBuf>,
    generation_codex_home: Option<PathBuf>,
    legacy_codex_home: Option<PathBuf>,
    app_data_dir: Option<PathBuf>,
    cache_roots: Vec<PathBuf>,
}

#[derive(Debug)]
enum CleanupTarget {
    File {
        path: PathBuf,
        category: StorageCategory,
    },
    Tree {
        path: PathBuf,
        category: StorageCategory,
    },
}

#[derive(Debug, Default)]
struct StorageScan {
    breakdown: StorageBreakdown,
    cleanup_targets: Vec<CleanupTarget>,
}

impl StorageBreakdown {
    fn stats_mut(&mut self, category: StorageCategory) -> &mut StorageCategoryStats {
        match category {
            StorageCategory::Sessions => &mut self.sessions,
            StorageCategory::Logs => &mut self.logs,
            StorageCategory::WebviewCache => &mut self.webview_cache,
            StorageCategory::Backups => &mut self.backups,
            StorageCategory::BrokenQuarantine => &mut self.broken_quarantine,
            StorageCategory::AppData => &mut self.app_data,
        }
    }

    fn add_total(&mut self, category: StorageCategory, bytes: u64, count: u64) {
        let stats = self.stats_mut(category);
        stats.bytes = stats.bytes.saturating_add(bytes);
        stats.count = stats.count.saturating_add(count);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }

    fn add_deletable(&mut self, category: StorageCategory, bytes: u64, count: u64) {
        let stats = self.stats_mut(category);
        stats.deletable_bytes = stats.deletable_bytes.saturating_add(bytes);
        stats.deletable_count = stats.deletable_count.saturating_add(count);
    }
}

/// カテゴリ別の実測容量を取得する。大きなディレクトリ走査は blocking thread へ逃がし、
/// Tauri の非同期処理と画面描画を止めない。
pub async fn inspect_storage_breakdown() -> Result<StorageBreakdown, String> {
    tokio::task::spawn_blocking(|| {
        let context = storage_scan_context()?;
        let mut breakdown = scan_storage(&context, SystemTime::now()).breakdown;
        add_common_codex_reference(&mut breakdown, context.legacy_codex_home.as_deref());
        Ok(breakdown)
    })
    .await
    .map_err(|err| format!("ストレージ走査タスクに失敗: {err}"))?
}

/// 指定カテゴリだけを削除し、実際に解放できた量をカテゴリ別に返す。
pub async fn cleanup_storage_categories(
    categories: Vec<String>,
) -> Result<StorageCleanupCategoriesReport, String> {
    let selected = parse_cleanup_categories(&categories)?;
    tokio::task::spawn_blocking(move || {
        let context = storage_scan_context()?;
        let scan = scan_storage(&context, SystemTime::now());
        Ok(delete_scan_targets(scan, &context, &selected))
    })
    .await
    .map_err(|err| format!("ストレージ削除タスクに失敗: {err}"))?
}

fn parse_cleanup_categories(values: &[String]) -> Result<BTreeSet<StorageCategory>, String> {
    if values.is_empty() {
        return Err("削除するカテゴリが選ばれていません".to_string());
    }
    values
        .iter()
        .map(|value| StorageCategory::parse_cleanup(value))
        .collect()
}

fn storage_scan_context() -> Result<StorageScanContext, String> {
    let gori_codex_homes = gori_cleanup_codex_homes();
    let generation_codex_home = crate::codex::home::gen_codex_home_path();
    let legacy_codex_home = crate::codex::home::legacy_codex_home();
    let app_data_dir = dirs::data_dir().map(|dir| dir.join(crate::secrets::SERVICE_NAME));
    let cache_roots = dirs::home_dir()
        .map(|home| webkit_cache_candidates(&home))
        .unwrap_or_default();

    if gori_codex_homes.is_empty() && app_data_dir.is_none() && cache_roots.is_empty() {
        return Err("ストレージの保存場所を解決できません".to_string());
    }

    Ok(StorageScanContext {
        gori_codex_homes,
        generation_codex_home,
        legacy_codex_home,
        app_data_dir,
        cache_roots,
    })
}

fn scan_storage(context: &StorageScanContext, now: SystemTime) -> StorageScan {
    let mut scan = StorageScan::default();
    let mut roots = context.gori_codex_homes.clone();
    if let Some(app_data) = &context.app_data_dir {
        roots.push(app_data.clone());
    }
    roots.extend(context.cache_roots.iter().cloned());

    // app_data_dir の中に専用 CODEX_HOME があるため、同じパスを複数の起点から
    // 見つけても二重計上しない。
    let mut seen = HashSet::<PathBuf>::new();
    let mut stack = roots;
    while let Some(path) = stack.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                scan.breakdown
                    .errors
                    .push(format!("{}: {err}", path.display()));
                continue;
            }
        };

        // 掃除対象外へ飛ぶ近道になり得るため、シンボリックリンクは辿らない。
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if is_broken_quarantine_root(&path, context.generation_codex_home.as_deref()) {
                let (bytes, count, errors) = tree_stats_without_following_links(&path);
                scan.breakdown.errors.extend(errors);
                scan.breakdown
                    .add_total(StorageCategory::BrokenQuarantine, bytes, count.max(1));
                scan.breakdown.add_deletable(
                    StorageCategory::BrokenQuarantine,
                    bytes,
                    count.max(1),
                );
                scan.cleanup_targets.push(CleanupTarget::Tree {
                    path,
                    category: StorageCategory::BrokenQuarantine,
                });
                continue;
            }

            match std::fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries {
                        match entry {
                            Ok(entry) => stack.push(entry.path()),
                            Err(err) => scan
                                .breakdown
                                .errors
                                .push(format!("{} の項目を読めません: {err}", path.display())),
                        }
                    }
                }
                Err(err) => scan
                    .breakdown
                    .errors
                    .push(format!("{} を読めません: {err}", path.display())),
            }
            continue;
        }

        if !metadata.is_file() {
            continue;
        }
        let Some(category) = classify_storage_path(
            &path,
            &context.gori_codex_homes,
            context.generation_codex_home.as_deref(),
            context.app_data_dir.as_deref(),
            &context.cache_roots,
        ) else {
            continue;
        };

        scan.breakdown.add_total(category, metadata.len(), 1);
        let deletable = category != StorageCategory::AppData
            && (category != StorageCategory::Sessions
                || metadata
                    .modified()
                    .ok()
                    .is_some_and(|modified| session_is_outside_safety_margin(modified, now)));
        if deletable {
            scan.breakdown.add_deletable(category, metadata.len(), 1);
            scan.cleanup_targets
                .push(CleanupTarget::File { path, category });
        }
    }

    scan
}

/// パスをカテゴリへ分類する唯一の判定表。
///
/// 優先順は「保護済みキャッシュの名指し → broken 退避 → sessions → logs →
/// バックアップ → その他の app data」。この順序により app_data_dir 内にある
/// codex-home も `appData` へ埋もれない。
fn classify_storage_path(
    path: &Path,
    gori_codex_homes: &[PathBuf],
    generation_codex_home: Option<&Path>,
    app_data_dir: Option<&Path>,
    cache_roots: &[PathBuf],
) -> Option<StorageCategory> {
    if cache_roots.iter().any(|root| path.starts_with(root)) {
        // 候補ルートの組み立てに加え、個々の子パスでも保護名を再確認する。
        // 将来キャッシュ配下の構造が変わっても WebsiteData / LocalStorage 等は消さない。
        if path.components().any(|component| {
            WEBKIT_PROTECTED_SUBDIRS
                .iter()
                .any(|protected| component.as_os_str() == *protected)
        }) {
            return None;
        }
        return Some(StorageCategory::WebviewCache);
    }
    if path_is_in_broken_quarantine(path, generation_codex_home) {
        return Some(StorageCategory::BrokenQuarantine);
    }
    if gori_codex_homes
        .iter()
        .any(|home| path.starts_with(home.join("sessions")))
    {
        return Some(StorageCategory::Sessions);
    }

    if is_engine_log(path, gori_codex_homes) {
        return Some(StorageCategory::Logs);
    }
    if app_data_dir.is_some_and(|root| path.starts_with(root)) && is_generation_backup(path) {
        return Some(StorageCategory::Backups);
    }
    if app_data_dir.is_some_and(|root| path.starts_with(root)) {
        return Some(StorageCategory::AppData);
    }
    None
}

fn is_engine_log(path: &Path, gori_codex_homes: &[PathBuf]) -> bool {
    if !gori_codex_homes
        .iter()
        .any(|home| path.parent() == Some(home.as_path()))
    {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let sqlite_name = name
        .strip_suffix("-wal")
        .or_else(|| name.strip_suffix("-shm"))
        .unwrap_or(name);
    let Some(index) = sqlite_name
        .strip_prefix("logs_")
        .and_then(|value| value.strip_suffix(".sqlite"))
    else {
        return false;
    };
    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_generation_backup(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    [
        "presets.json.bak-",
        "projects.json.bak-",
        "film-projects.json.bak-",
    ]
    .iter()
    .any(|prefix| {
        name.strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
    })
}

fn is_broken_quarantine_name(name: &str) -> bool {
    name.strip_prefix("broken-").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn is_broken_quarantine_root(path: &Path, generation_codex_home: Option<&Path>) -> bool {
    generation_codex_home.is_some_and(|home| path.parent() == Some(home))
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_broken_quarantine_name)
}

fn path_is_in_broken_quarantine(path: &Path, generation_codex_home: Option<&Path>) -> bool {
    let Some(root) = generation_codex_home else {
        return false;
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut components = relative.components();
    let Some(quarantine_name) = components.next() else {
        return false;
    };
    quarantine_name
        .as_os_str()
        .to_str()
        .is_some_and(is_broken_quarantine_name)
        && components.next().is_some()
}

/// app-server が現在書き込んでいる可能性があるため、最終更新24時間以内の
/// sessions ファイルは削除しない。この安全マージンは手動削除でも必ず適用する。
fn session_is_outside_safety_margin(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .map(|age| age >= Duration::from_secs(STRIP_MIN_AGE_HOURS * 3_600))
        .unwrap_or(false)
}

fn tree_stats_without_following_links(path: &Path) -> (u64, u64, Vec<String>) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let mut errors = Vec::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(err) => {
                errors.push(format!("{} を読めません: {err}", current.display()));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    errors.push(format!("{} の項目を読めません: {err}", current.display()));
                    continue;
                }
            };
            let item = entry.path();
            match std::fs::symlink_metadata(&item) {
                Ok(metadata) if metadata.file_type().is_symlink() => {}
                Ok(metadata) if metadata.is_dir() => stack.push(item),
                Ok(metadata) if metadata.is_file() => {
                    bytes = bytes.saturating_add(metadata.len());
                    count = count.saturating_add(1);
                }
                Ok(_) => {}
                Err(err) => errors.push(format!("{}: {err}", item.display())),
            }
        }
    }
    (bytes, count, errors)
}

/// 共通 Codex CLI の領域は参考容量だけを読み、削除候補へは渡さない。
fn add_common_codex_reference(breakdown: &mut StorageBreakdown, legacy_home: Option<&Path>) {
    let Some(path) = legacy_home else {
        return;
    };
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == ErrorKind::NotFound => return,
        Err(err) => {
            breakdown
                .errors
                .push(format!("共通 Codex {}: {err}", path.display()));
            return;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let (bytes, count, errors) = tree_stats_without_following_links(path);
    breakdown.common_codex.bytes = bytes;
    breakdown.common_codex.count = count;
    breakdown.errors.extend(
        errors
            .into_iter()
            .map(|error| format!("共通 Codex: {error}")),
    );
}

fn delete_scan_targets(
    scan: StorageScan,
    context: &StorageScanContext,
    selected: &BTreeSet<StorageCategory>,
) -> StorageCleanupCategoriesReport {
    let mut report = StorageCleanupCategoriesReport {
        errors: scan.breakdown.errors,
        ..StorageCleanupCategoriesReport::default()
    };
    for category in selected {
        report
            .freed_bytes_by_category
            .insert(category.key().to_string(), 0);
        report
            .deleted_counts_by_category
            .insert(category.key().to_string(), 0);
    }

    for target in scan.cleanup_targets {
        let category = match &target {
            CleanupTarget::File { category, .. } | CleanupTarget::Tree { category, .. } => {
                *category
            }
        };
        if !selected.contains(&category) {
            continue;
        }

        let result = match target {
            CleanupTarget::File { path, category } => {
                delete_classified_file(&path, category, context)
            }
            CleanupTarget::Tree { path, category } => {
                delete_classified_tree(&path, category, context)
            }
        };
        match result {
            Ok((bytes, count)) => {
                if let Some(total) = report.freed_bytes_by_category.get_mut(category.key()) {
                    *total = total.saturating_add(bytes);
                }
                if let Some(total) = report.deleted_counts_by_category.get_mut(category.key()) {
                    *total = total.saturating_add(count);
                }
            }
            Err(err) => report.errors.push(format!("{}: {err}", category.key())),
        }
    }
    report
}

fn delete_classified_file(
    path: &Path,
    expected_category: StorageCategory,
    context: &StorageScanContext,
) -> Result<(u64, u64), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|err| format!("metadata: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "通常ファイルではないためスキップ: {}",
            path.display()
        ));
    }
    let actual_category = classify_storage_path(
        path,
        &context.gori_codex_homes,
        context.generation_codex_home.as_deref(),
        context.app_data_dir.as_deref(),
        &context.cache_roots,
    );
    if actual_category != Some(expected_category) || expected_category == StorageCategory::AppData {
        return Err(format!("安全な削除対象ではありません: {}", path.display()));
    }

    if expected_category == StorageCategory::Sessions {
        let modified = metadata
            .modified()
            .map_err(|err| format!("更新日時を確認できません: {err}"))?;
        // 走査後に app-server が書き込んだ競合も守るため、削除直前に再判定する。
        if !session_is_outside_safety_margin(modified, SystemTime::now()) {
            return Ok((0, 0));
        }
    }

    let bytes = metadata.len();
    std::fs::remove_file(path).map_err(|err| format!("{}: {err}", path.display()))?;
    Ok((bytes, 1))
}

fn delete_classified_tree(
    path: &Path,
    expected_category: StorageCategory,
    context: &StorageScanContext,
) -> Result<(u64, u64), String> {
    if expected_category != StorageCategory::BrokenQuarantine
        || !is_broken_quarantine_root(path, context.generation_codex_home.as_deref())
    {
        return Err(format!(
            "安全な退避フォルダではありません: {}",
            path.display()
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|err| format!("metadata: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "通常フォルダではないためスキップ: {}",
            path.display()
        ));
    }
    remove_tree_without_following_links(path)
}

fn remove_tree_without_following_links(path: &Path) -> Result<(u64, u64), String> {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let entries = std::fs::read_dir(path).map_err(|err| format!("read_dir: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("directory entry: {err}"))?;
        let item = entry.path();
        let metadata = std::fs::symlink_metadata(&item)
            .map_err(|err| format!("{} metadata: {err}", item.display()))?;
        if metadata.file_type().is_symlink() {
            // リンク先には触れず、退避フォルダ内のリンクそのものだけを外す。
            std::fs::remove_file(&item)
                .map_err(|err| format!("{} symlink: {err}", item.display()))?;
        } else if metadata.is_dir() {
            let (child_bytes, child_count) = remove_tree_without_following_links(&item)?;
            bytes = bytes.saturating_add(child_bytes);
            count = count.saturating_add(child_count);
        } else if metadata.is_file() {
            std::fs::remove_file(&item).map_err(|err| format!("{}: {err}", item.display()))?;
            bytes = bytes.saturating_add(metadata.len());
            count = count.saturating_add(1);
        }
    }
    std::fs::remove_dir(path).map_err(|err| format!("{}: {err}", path.display()))?;
    Ok((bytes, count.max(1)))
}

/// バックグラウンド掃除タスクを起動する。
///
/// アプリ起動時に1度呼ぶ。内部で `tokio::spawn` するので非ブロッキング。
/// 初回は起動直後、その後は24時間ごとに自動実行。
pub fn spawn_background_cleanup() {
    // Tauri の setup フック内では Tokio runtime がまだ起動していないため、
    // `tokio::spawn` を直接呼ぶと panic する。
    // `tauri::async_runtime::spawn` を使うことで、Tauri が用意した runtime に
    // 安全にタスクを乗せられる。
    tauri::async_runtime::spawn(async {
        // 初回: 起動5秒後 (アプリ起動を妨げない)
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(err) = run_cleanup().await {
            tracing::warn!(target: "storage.cleanup", "initial cleanup failed: {err}");
        }

        // 以降: 24時間ごと
        let mut ticker = interval(Duration::from_secs(SWEEP_INTERVAL_HOURS * 3600));
        ticker.tick().await; // 初回 tick はすぐ完了するので捨てる
        loop {
            ticker.tick().await;
            if let Err(err) = run_cleanup().await {
                tracing::warn!(target: "storage.cleanup", "scheduled cleanup failed: {err}");
            }
        }
    });
}

/// 1回分の掃除処理。テストや手動実行から呼べる。
pub async fn run_cleanup() -> Result<CleanupReport, String> {
    let mut report = CleanupReport::default();

    // 削除・書換対象は GORI が所有する2つの CODEX_HOME だけ。
    // 共通 ~/.codex は Codex CLI の対話履歴なので、容量表示以外では触らない。
    let codex_homes = gori_cleanup_codex_homes();
    let session_dirs: Vec<PathBuf> = codex_homes
        .iter()
        .map(|home| home.join("sessions"))
        .collect();
    if session_dirs.is_empty() {
        return Err("$HOME が解決できません".to_string());
    }

    // 1. 各 sessions/ 配下の古い .jsonl から画像ペイロードだけを除去する。
    //    sessions のファイル自体と、会話・プロンプトは一切削除しない。
    for sessions in &session_dirs {
        if sessions.exists() {
            match strip_old_rollout_images(sessions, STRIP_MIN_AGE_HOURS).await {
                Ok(result) => {
                    report.stripped_files += result.files;
                    report.stripped_bytes_freed += result.bytes_freed;
                    report.errors.extend(result.errors);
                }
                Err(err) => report.errors.push(format!("sessions: {err}")),
            }
        }
    }

    // 2. Codex ログ (logs_2.sqlite*) と WebView キャッシュ。
    //    FB-A4: これらは掃除前の inspect では合計に表示されていたのに run_cleanup が
    //    一切消していなかったため、「今すぐ整理する」を押しても合計がほとんど減らず
    //    「効かない」と見えていた。いずれも再生成される一時データだけを対象にする。
    if let Some(home) = dirs::home_dir() {
        // Codex ログ。GORI 所有 HOME 直下の既知名だけを消す。
        // 2026-07-25: codex-home-gen/logs_2.sqlite が実測 866MB あったが、
        // ここの列挙漏れで一切回収されていなかった。
        for ch in &codex_homes {
            for name in ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm"] {
                report.cache_bytes_freed += remove_file_if_exists(&ch.join(name)).await;
            }
        }

        // WebView キャッシュ (macOS のみ実体あり。他 OS では候補が存在せず 0)
        // 2026-07-25 修正: 以前は "gori-gori-kun" をハードコードしていたが、実際の
        // ディレクトリ名は bundle identifier (app.codexframefactory) であり、
        // 掃除も容量表示も常に空振りしていた (実体 WebKit/app.codexframefactory は 4.3MB)。
        // identifier を正本 (secrets::SERVICE_NAME) から組み立てて再発を防ぐ。
        // 旧名は空ディレクトリとして残っている環境があるため候補に残す (無害)。
        //
        // 2026-08-06 重大修正 (実ユーザーのプリセット30体消失): `Library/WebKit/<id>` を
        // 丸ごと remove_dir_contents していたため、**localStorage の実体を掃除が消していた**。
        // localStorage は presets / scene3d / motions の冗長バックアップであり、
        // ファイル正本の作成に失敗した初回移行時の**唯一の生き残り**になる。
        // 掃除がそのバックアップを消す = 自分のバックアップを自分で消す構造だった。
        // したがって WebKit 配下は「キャッシュだけ」を名指しで対象にし、
        // LocalStorage / WebsiteData には**絶対に触らない** (webkit_cache_candidates 参照)。
        for dir in webkit_cache_candidates(&home) {
            if dir.exists() {
                match remove_dir_contents(&dir).await {
                    Ok((_, bytes)) => report.cache_bytes_freed += bytes,
                    Err(err) => report.errors.push(format!("cache: {err}")),
                }
            }
        }
    }

    tracing::info!(
        target: "storage.cleanup",
        sessions = report.sessions_deleted,
        sessions_mb = report.sessions_bytes_freed / 1_000_000,
        stripped_files = report.stripped_files,
        stripped_mb = report.stripped_bytes_freed / 1_000_000,
        generated = report.generated_images_deleted,
        generated_mb = report.generated_images_bytes_freed / 1_000_000,
        cache_mb = report.cache_bytes_freed / 1_000_000,
        "cleanup completed"
    );

    Ok(report)
}

/// ファイルが存在すれば削除し、解放したバイト数を返す。存在しない/失敗時は 0。
async fn remove_file_if_exists(path: &std::path::Path) -> u64 {
    let size = match fs::metadata(path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return 0,
    };
    if fs::remove_file(path).await.is_ok() {
        size
    } else {
        0
    }
}

/// WebView 領域のうち、**掃除してよいディレクトリ名**のホワイトリスト。
///
/// ここに挙げた名前だけを消す。`Library/WebKit/<id>` を丸ごと消してはならない。
/// 直下には `WebsiteData/` (localStorage / IndexedDB の実体) が同居しており、
/// 2026-08-06 の実ユーザー被害 (プリセット30体消失) はこれを消したことが原因。
const WEBKIT_CACHE_SUBDIRS: &[&str] = &["NetworkCache", "MediaCache", "ResourceLoadStatistics"];

/// 掃除対象から**恒久的に除外**するディレクトリ名 (localStorage の実体)。
///
/// なぜ定数として持つか: 「WebsiteData を消さない」は実装の暗黙知にすると
/// 次の改修で再び消える (実際 b1371c5 でそうなった)。名前で持ち、テストで固定する。
const WEBKIT_PROTECTED_SUBDIRS: &[&str] =
    &["WebsiteData", "LocalStorage", "Databases", "IndexedDB"];

/// 掃除対象の WebView キャッシュディレクトリ候補を返す。
///
/// 契約: 返すパスは必ず `WEBKIT_CACHE_SUBDIRS` のいずれかで終わるか、
/// `Library/Caches/` 配下 (OS が再生成する純キャッシュ) のどちらかであり、
/// `WEBKIT_PROTECTED_SUBDIRS` を含むパスは**絶対に返さない**。
/// この契約は `webkit_candidates_never_include_localstorage` テストが固定する。
pub(crate) fn webkit_cache_candidates(home: &std::path::Path) -> Vec<PathBuf> {
    let service = crate::secrets::SERVICE_NAME;
    let mut out: Vec<PathBuf> = Vec::new();

    // Library/Caches 配下は OS が再生成する純キャッシュなので丸ごとでよい
    // (localStorage はここには無い。実体は Library/WebKit/<id>/WebsiteData)。
    for id in [service, "gori-gori-kun"] {
        out.push(home.join("Library/Caches").join(id));
    }

    // Library/WebKit 配下は localStorage と同居するため、キャッシュ名を名指しする。
    for id in [service, "gori-gori-kun"] {
        let webkit_root = home.join("Library/WebKit").join(id);
        for sub in WEBKIT_CACHE_SUBDIRS {
            out.push(webkit_root.join(sub));
        }
    }

    // 二重の安全弁: 万一上の組み立てが将来壊れても、保護名を含むパスは落とす。
    out.retain(|p| {
        !p.components().any(|c| {
            WEBKIT_PROTECTED_SUBDIRS
                .iter()
                .any(|protected| c.as_os_str() == *protected)
        })
    });
    out
}

/// GORI が所有する CODEX_HOME だけを重複なしで返す。
/// `cleanup_target_codex_homes()` は容量表示向けに共通 `~/.codex` も含むため、
/// 削除・書換処理からは意図的に使わない。
pub(crate) fn gori_cleanup_codex_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for candidate in [
        crate::codex::home::gori_codex_home_path(),
        crate::codex::home::gen_codex_home_path(),
    ]
    .into_iter()
    .flatten()
    {
        if !homes.contains(&candidate) {
            homes.push(candidate);
        }
    }
    homes
}

/// Tauri の app_data_dir と同じ `<OS data dir>/<bundle identifier>` 配下にある
/// サムネイル保存先を返す。現在は削除許可リスト外なので、掃除には使わない。
pub(crate) fn thumbnail_cache_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| {
        dir.join(crate::secrets::SERVICE_NAME)
            .join(THUMB_CACHE_DIR_NAME)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
struct FileFingerprint {
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

impl FileFingerprint {
    fn from_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Self {
            len: metadata.len(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        })
    }
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct ProcessedRolloutState {
    files: BTreeMap<String, FileFingerprint>,
}

#[derive(Debug, Default)]
struct StripSweepResult {
    files: u64,
    bytes_freed: u64,
    errors: Vec<String>,
}

enum StripFileResult {
    Unchanged,
    Stripped { bytes_freed: u64 },
}

/// 24時間より古い rollout から画像ペイロードだけを除去する。
///
/// 処理済みファイルはパス・サイズ・更新時刻を状態ファイルに記録し、ファイルが
/// 変わらない限り再読込しない。状態ファイル自体も一時ファイルから rename する。
async fn strip_old_rollout_images(
    dir: &std::path::Path,
    min_age_hours: u64,
) -> Result<StripSweepResult, String> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(min_age_hours * 3_600))
        .ok_or_else(|| "cutoff 計算に失敗".to_string())?;
    let state_path = dir
        .parent()
        .ok_or_else(|| "sessions の親ディレクトリがありません".to_string())?
        .join(".storage_cleanup")
        .join(STRIP_STATE_FILE);
    let (mut state, state_load_error) = load_processed_state(&state_path).await;
    let mut result = StripSweepResult::default();
    if let Some(err) = state_load_error {
        result.errors.push(format!("strip state: {err}"));
    }
    let mut state_changed = false;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(err) => {
                result
                    .errors
                    .push(format!("sessions read_dir {}: {err}", current.display()));
                continue;
            }
        };
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(err) => {
                    result
                        .errors
                        .push(format!("sessions next_entry {}: {err}", current.display()));
                    break;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // sessions 外へ出る可能性があるため、シンボリックリンクは追わない。
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
            {
                continue;
            }
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = match meta.modified() {
                Ok(modified) => modified,
                Err(_) => continue,
            };
            if modified >= cutoff {
                continue;
            }
            let fingerprint = match FileFingerprint::from_metadata(&meta) {
                Some(fingerprint) => fingerprint,
                None => continue,
            };
            let relative_path = match path.strip_prefix(dir).ok().and_then(|p| p.to_str()) {
                Some(relative_path) => relative_path.to_string(),
                None => continue,
            };
            if state.files.get(&relative_path) == Some(&fingerprint) {
                continue;
            }

            match strip_rollout_file_atomically(&path, fingerprint, meta.permissions()).await {
                Ok(StripFileResult::Unchanged) => {
                    state.files.insert(relative_path, fingerprint);
                    state_changed = true;
                }
                Ok(StripFileResult::Stripped { bytes_freed }) => {
                    result.files += 1;
                    result.bytes_freed += bytes_freed;
                    match fs::metadata(&path)
                        .await
                        .ok()
                        .and_then(|m| FileFingerprint::from_metadata(&m))
                    {
                        Some(new_fingerprint) => {
                            state.files.insert(relative_path, new_fingerprint);
                            state_changed = true;
                        }
                        None => result.errors.push(format!(
                            "strip fingerprint {}: 書き換え後の情報を取得できません",
                            path.display()
                        )),
                    }
                }
                Err(err) => result
                    .errors
                    .push(format!("strip {}: {err}", path.display())),
            }
        }
    }

    if state_changed {
        if let Err(err) = save_processed_state_atomically(&state_path, &state).await {
            result.errors.push(format!("strip state: {err}"));
        }
    }

    Ok(result)
}

/// 1ファイルを一時ファイルへ書き、元が処理中に変わっていない場合だけ rename する。
async fn strip_rollout_file_atomically(
    path: &std::path::Path,
    expected: FileFingerprint,
    permissions: std::fs::Permissions,
) -> Result<StripFileResult, String> {
    let input = fs::File::open(path)
        .await
        .map_err(|err| format!("open: {err}"))?;
    let opened_fingerprint = input
        .metadata()
        .await
        .ok()
        .and_then(|metadata| FileFingerprint::from_metadata(&metadata))
        .ok_or_else(|| "open 後のファイル情報を取得できません".to_string())?;
    if opened_fingerprint != expected {
        return Err("処理開始前にファイルが更新されたためスキップ".to_string());
    }

    let (temp_path, temp_file) = create_unique_temp_file(path).await?;
    let write_result: Result<(u64, u64), String> = async {
        let mut reader = BufReader::new(input);
        let mut writer = BufWriter::new(temp_file);
        let mut line = Vec::new();
        let mut replacements = 0u64;

        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .await
                .map_err(|err| format!("read: {err}"))?;
            if read == 0 {
                break;
            }
            if let Some((stripped_line, count)) = strip_image_payloads_from_line(&line) {
                writer
                    .write_all(&stripped_line)
                    .await
                    .map_err(|err| format!("write: {err}"))?;
                replacements += count;
            } else {
                writer
                    .write_all(&line)
                    .await
                    .map_err(|err| format!("write: {err}"))?;
            }
        }

        writer
            .flush()
            .await
            .map_err(|err| format!("flush: {err}"))?;
        writer
            .get_ref()
            .sync_all()
            .await
            .map_err(|err| format!("sync: {err}"))?;
        let new_len = writer
            .get_ref()
            .metadata()
            .await
            .map_err(|err| format!("temp metadata: {err}"))?
            .len();
        drop(writer);
        drop(reader);
        Ok((replacements, new_len))
    }
    .await;

    let (replacements, new_len) = match write_result {
        Ok(result) => result,
        Err(err) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(err);
        }
    };

    let current_fingerprint = fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| FileFingerprint::from_metadata(&metadata));
    if current_fingerprint != Some(expected) {
        let _ = fs::remove_file(&temp_path).await;
        return Err("処理中にファイルが更新されたためスキップ".to_string());
    }

    if replacements == 0 {
        let _ = fs::remove_file(&temp_path).await;
        return Ok(StripFileResult::Unchanged);
    }

    if let Err(err) = fs::set_permissions(&temp_path, permissions).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(format!("set_permissions: {err}"));
    }
    if let Err(err) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(format!("atomic rename: {err}"));
    }

    Ok(StripFileResult::Stripped {
        bytes_freed: expected.len.saturating_sub(new_len),
    })
}

/// 1行内の data:image/<mime>;base64,<payload> の payload だけを置換する。
/// 閉じ引用符が見つからない候補がある行は、壊れた行として一切変更しない。
fn strip_image_payloads_from_line(line: &[u8]) -> Option<(Vec<u8>, u64)> {
    if find_subslice(line, DATA_IMAGE_PREFIX).is_none() || !is_valid_json_line(line) {
        return None;
    }

    let mut ranges = Vec::new();
    let mut search_from = 0usize;

    while let Some(prefix_offset) = find_subslice(&line[search_from..], DATA_IMAGE_PREFIX) {
        let prefix_start = search_from + prefix_offset;
        let mime_start = prefix_start + DATA_IMAGE_PREFIX.len();

        // JSON文字列の外や、一般的な画像MIMEでない候補は触らない。
        if !is_inside_json_string(line, prefix_start) {
            search_from = mime_start;
            continue;
        }
        // **画像ペイロード専用フィールドの値でなければ触らない** (2026-08-06 / V6)。
        // 会話ログ本文が画像URLを含むだけの行を書き換えると、ユーザーの発言や
        // ツール出力そのものを改変することになる (実測で 1 件該当。定数の doc 参照)。
        if !is_image_payload_field_value(line, prefix_start) {
            search_from = mime_start;
            continue;
        }
        let mut marker_start = mime_start;
        while marker_start < line.len() && is_safe_mime_byte(line[marker_start]) {
            marker_start += 1;
        }
        if marker_start == mime_start || !line[marker_start..].starts_with(BASE64_MARKER) {
            search_from = mime_start;
            continue;
        }

        let payload_start = marker_start + BASE64_MARKER.len();
        let payload_end = find_next_unescaped_quote(line, payload_start)?;
        let payload = &line[payload_start..payload_end];
        if !payload.is_empty() && payload != STRIPPED_PAYLOAD {
            ranges.push((payload_start, payload_end));
        }
        search_from = payload_end + 1;
    }

    if ranges.is_empty() {
        return None;
    }

    let mut output = Vec::with_capacity(line.len());
    let mut copied_until = 0usize;
    for (start, end) in &ranges {
        output.extend_from_slice(&line[copied_until..*start]);
        output.extend_from_slice(STRIPPED_PAYLOAD);
        copied_until = *end;
    }
    output.extend_from_slice(&line[copied_until..]);
    Some((output, ranges.len() as u64))
}

fn is_valid_json_line(line: &[u8]) -> bool {
    let mut deserializer = serde_json::Deserializer::from_slice(line);
    if <serde::de::IgnoredAny as serde::Deserialize>::deserialize(&mut deserializer).is_err() {
        return false;
    }
    deserializer.end().is_ok()
}

fn is_safe_mime_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'_' | b'-')
}

/// `prefix_start` (= `data:image/` の開始位置) が、**画像ペイロード専用フィールドの
/// 値の先頭**にあるかを判定する (2026-08-06 監査指摘 / V6)。
///
/// 満たすべき形: `"<whitelisted key>"` `:` (空白可) `"` `data:image/...`
/// つまり `data:image/` はその文字列値の**先頭**でなければならない。
///
/// これにより次を弾く:
///   - 会話ログ本文 (`"text":"... data:image/... ..."`) — 値の途中に現れるため不一致
///   - 本文が画像URLを引用した JSON 断片 (`"text":"{\"image_url\":\"data:image/...\"}"`)
///     — 直前の引用符がエスケープ済み (`\"`) なので、キーの終端引用符として認めない
///   - ホワイトリスト外のフィールド (`url` / `note` 等)
fn is_image_payload_field_value(line: &[u8], prefix_start: usize) -> bool {
    // 値の開始引用符は data:image/ の直前でなければならない。
    if prefix_start == 0 {
        return false;
    }
    let quote_pos = prefix_start - 1;
    if line[quote_pos] != b'"' {
        return false;
    }
    // その引用符自体がエスケープされていないこと (本文中に引用された JSON 断片を弾く)。
    let mut backslashes = 0usize;
    let mut i = quote_pos;
    while i > 0 && line[i - 1] == b'\\' {
        backslashes += 1;
        i -= 1;
    }
    if backslashes % 2 != 0 {
        return false;
    }

    // 開始引用符の手前を遡り、`:` と空白を読み飛ばしてキーの終端引用符に到達する。
    let mut cursor = quote_pos;
    // 空白
    while cursor > 0 && line[cursor - 1].is_ascii_whitespace() {
        cursor -= 1;
    }
    // コロン
    if cursor == 0 || line[cursor - 1] != b':' {
        return false;
    }
    cursor -= 1;
    // 空白
    while cursor > 0 && line[cursor - 1].is_ascii_whitespace() {
        cursor -= 1;
    }
    // キーの終端引用符
    if cursor == 0 || line[cursor - 1] != b'"' {
        return false;
    }
    let key_end = cursor - 1;

    IMAGE_PAYLOAD_FIELDS.iter().any(|field| {
        let need = field.len();
        // `"<field>"` の形で終端引用符の直前に一致するか。
        if key_end < need + 1 {
            return false;
        }
        let key_start = key_end - need;
        &line[key_start..key_end] == *field && line[key_start - 1] == b'"'
    })
}

fn is_inside_json_string(line: &[u8], position: usize) -> bool {
    let mut inside = false;
    let mut backslashes = 0usize;
    for &byte in &line[..position] {
        if byte == b'\\' {
            backslashes += 1;
            continue;
        }
        if byte == b'"' && backslashes % 2 == 0 {
            inside = !inside;
        }
        backslashes = 0;
    }
    inside
}

fn find_next_unescaped_quote(line: &[u8], start: usize) -> Option<usize> {
    let mut backslashes = 0usize;
    for (offset, &byte) in line[start..].iter().enumerate() {
        if byte == b'\\' {
            backslashes += 1;
            continue;
        }
        if byte == b'"' && backslashes % 2 == 0 {
            return Some(start + offset);
        }
        backslashes = 0;
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn load_processed_state(path: &std::path::Path) -> (ProcessedRolloutState, Option<String>) {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return (
                ProcessedRolloutState::default(),
                Some("状態ファイルがシンボリックリンクのため読み込みません".to_string()),
            );
        }
        Ok(metadata) if !metadata.is_file() => {
            return (
                ProcessedRolloutState::default(),
                Some("状態ファイルが通常ファイルではありません".to_string()),
            );
        }
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return (ProcessedRolloutState::default(), None);
        }
        Err(err) => {
            return (
                ProcessedRolloutState::default(),
                Some(format!("metadata: {err}")),
            );
        }
    }

    match fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(state) => (state, None),
            Err(err) => (
                ProcessedRolloutState::default(),
                Some(format!("parse: {err}")),
            ),
        },
        Err(err) => (
            ProcessedRolloutState::default(),
            Some(format!("read: {err}")),
        ),
    }
}

async fn save_processed_state_atomically(
    path: &std::path::Path,
    state: &ProcessedRolloutState,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "状態ファイルの親ディレクトリがありません".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|err| format!("create state dir: {err}"))?;
    let mut bytes = serde_json::to_vec(state).map_err(|err| format!("serialize: {err}"))?;
    bytes.push(b'\n');
    let (temp_path, mut temp_file) = create_unique_temp_file(path).await?;

    let write_result: Result<(), String> = async {
        temp_file
            .write_all(&bytes)
            .await
            .map_err(|err| format!("write: {err}"))?;
        temp_file
            .sync_all()
            .await
            .map_err(|err| format!("sync: {err}"))?;
        drop(temp_file);
        fs::rename(&temp_path, path)
            .await
            .map_err(|err| format!("atomic rename: {err}"))?;
        Ok(())
    }
    .await;

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path).await;
    }
    write_result
}

async fn create_unique_temp_file(
    destination: &std::path::Path,
) -> Result<(PathBuf, fs::File), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "一時ファイルの親ディレクトリがありません".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "一時ファイル名を安全に作れません".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    for attempt in 0..16u8 {
        let temp_path = parent.join(format!(
            ".{file_name}.gori-cleanup-{}-{nonce}-{attempt}.tmp",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("create temp: {err}")),
        }
    }

    Err("一時ファイル名を確保できません".to_string())
}

/// ディレクトリの中身を全削除(ディレクトリ自体は残す)
async fn remove_dir_contents(dir: &std::path::Path) -> Result<(u64, u64), String> {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut entries = fs::read_dir(dir)
        .await
        .map_err(|e| format!("read_dir: {e}"))?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let dir_size = dir_size_recursive(&path).await;
            if fs::remove_dir_all(&path).await.is_ok() {
                count += 1;
                bytes += dir_size;
            }
        } else {
            let size = meta.len();
            if fs::remove_file(&path).await.is_ok() {
                count += 1;
                bytes += size;
            }
        }
    }
    Ok((count, bytes))
}

async fn dir_size_recursive(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            match entry.metadata().await {
                Ok(m) if m.is_dir() => stack.push(p),
                Ok(m) => total += m.len(),
                Err(_) => continue,
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::strip_image_payloads_from_line;
    use super::{
        classify_storage_path, gori_cleanup_codex_homes, is_broken_quarantine_root,
        parse_cleanup_categories, session_is_outside_safety_margin, webkit_cache_candidates,
        StorageCategory, WEBKIT_PROTECTED_SUBDIRS,
    };
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    #[test]
    fn storage_paths_are_classified_by_the_shared_rules() {
        let app_data = PathBuf::from("/tmp/app.codexframefactory");
        let gori_home = app_data.join("codex-home");
        let generation_home = app_data.join("codex-home-gen");
        let codex_homes = vec![gori_home.clone(), generation_home.clone()];
        let cache_roots = vec![PathBuf::from(
            "/tmp/home/Library/WebKit/app.codexframefactory/NetworkCache",
        )];

        let cases = [
            (
                gori_home.join("sessions/2026/rollout.jsonl"),
                StorageCategory::Sessions,
            ),
            (
                generation_home.join("sessions/2026/rollout.jsonl"),
                StorageCategory::Sessions,
            ),
            (gori_home.join("logs_2.sqlite"), StorageCategory::Logs),
            (
                generation_home.join("logs_17.sqlite-wal"),
                StorageCategory::Logs,
            ),
            (
                cache_roots[0].join("Cache.db"),
                StorageCategory::WebviewCache,
            ),
            (
                app_data.join("projects.json.bak-20260822"),
                StorageCategory::Backups,
            ),
            (
                app_data.join("presets.json.bak-20260822"),
                StorageCategory::Backups,
            ),
            (
                app_data.join("film-projects.json.bak-20260822"),
                StorageCategory::Backups,
            ),
            (
                generation_home.join("broken-1724313600/logs_2.sqlite"),
                StorageCategory::BrokenQuarantine,
            ),
            (app_data.join("projects.json"), StorageCategory::AppData),
        ];

        for (path, expected) in cases {
            assert_eq!(
                classify_storage_path(
                    &path,
                    &codex_homes,
                    Some(&generation_home),
                    Some(&app_data),
                    &cache_roots,
                ),
                Some(expected),
                "分類が不正: {}",
                path.display()
            );
        }

        assert_eq!(
            classify_storage_path(
                &cache_roots[0].join("LocalStorage/should-never-delete.db"),
                &codex_homes,
                Some(&generation_home),
                Some(&app_data),
                &cache_roots,
            ),
            None,
            "キャッシュ候補配下でも保護名を含むパスは削除対象にしない"
        );
    }

    #[test]
    fn log_extension_outside_known_direct_name_is_not_deletable() {
        let app_data = PathBuf::from("/tmp/app.codexframefactory");
        let gori_home = app_data.join("codex-home");
        let generation_home = app_data.join("codex-home-gen");
        let codex_homes = vec![gori_home.clone(), generation_home.clone()];

        for path in [
            gori_home.join("skills/foo.log"),
            gori_home.join("skills/logs_2.sqlite"),
            gori_home.join("memories/notes.log"),
            gori_home.join("logs_2.sqlite.backup"),
            gori_home.join("logs_latest.sqlite"),
            app_data.join("film-notes.json.bak-20260822"),
        ] {
            assert_eq!(
                classify_storage_path(
                    &path,
                    &codex_homes,
                    Some(&generation_home),
                    Some(&app_data),
                    &[],
                ),
                Some(StorageCategory::AppData),
                "既知名でないログを削除対象にしてはいけない: {}",
                path.display()
            );
        }
    }

    #[test]
    fn broken_name_outside_generated_quarantine_is_not_deletable() {
        let app_data = PathBuf::from("/tmp/app.codexframefactory");
        let gori_home = app_data.join("codex-home");
        let generation_home = app_data.join("codex-home-gen");
        let codex_homes = vec![gori_home, generation_home.clone()];
        let memory_file = app_data.join("memories/broken-メモ/note.md");

        assert_eq!(
            classify_storage_path(
                &memory_file,
                &codex_homes,
                Some(&generation_home),
                Some(&app_data),
                &[],
            ),
            Some(StorageCategory::AppData)
        );
        assert!(!is_broken_quarantine_root(
            &app_data.join("memories/broken-メモ"),
            Some(&generation_home)
        ));
        assert!(!is_broken_quarantine_root(
            &generation_home.join("broken-memo"),
            Some(&generation_home)
        ));
        assert!(is_broken_quarantine_root(
            &generation_home.join("broken-1724313600"),
            Some(&generation_home)
        ));
    }

    #[test]
    fn legacy_codex_sessions_are_not_cleanup_targets() {
        let app_data = PathBuf::from("/tmp/app.codexframefactory");
        let gori_home = app_data.join("codex-home");
        let generation_home = app_data.join("codex-home-gen");
        let codex_homes = vec![gori_home, generation_home.clone()];
        let legacy_session = PathBuf::from("/tmp/home/.codex/sessions/rollout.jsonl");

        assert_eq!(
            classify_storage_path(
                &legacy_session,
                &codex_homes,
                Some(&generation_home),
                Some(&app_data),
                &[],
            ),
            None,
            "共通 ~/.codex の対話履歴は削除走査に入れてはいけない"
        );
    }

    #[test]
    fn actual_gori_cleanup_homes_exclude_legacy_codex() {
        let Some(legacy_home) = crate::codex::home::legacy_codex_home() else {
            return;
        };
        let homes = gori_cleanup_codex_homes();
        assert!(
            !homes.contains(&legacy_home),
            "共通 ~/.codex を GORI の削除ホームへ戻してはいけない"
        );
        assert_eq!(
            classify_storage_path(
                &legacy_home.join("sessions/rollout.jsonl"),
                &homes,
                crate::codex::home::gen_codex_home_path().as_deref(),
                dirs::data_dir()
                    .map(|dir| dir.join(crate::secrets::SERVICE_NAME))
                    .as_deref(),
                &[],
            ),
            None
        );
    }

    #[test]
    fn app_data_is_rejected_even_if_requested_directly() {
        let result = parse_cleanup_categories(&["appData".to_string()]);
        assert!(
            result.is_err(),
            "appData を削除カテゴリとして受理してはいけない"
        );
    }

    #[test]
    fn sessions_modified_within_24_hours_are_protected() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 3_600);
        assert!(!session_is_outside_safety_margin(
            now - Duration::from_secs(23 * 3_600 + 59 * 60),
            now
        ));
        assert!(session_is_outside_safety_margin(
            now - Duration::from_secs(24 * 3_600),
            now
        ));
        assert!(!session_is_outside_safety_margin(
            now + Duration::from_secs(60),
            now
        ));
    }

    /// S1 の牙: 掃除候補に localStorage の実体が**一度も**現れないことを固定する。
    ///
    /// 壊し方の実証 (2026-08-06 実施): webkit_cache_candidates の retain による
    /// 除外を消し、WEBKIT_CACHE_SUBDIRS に "WebsiteData" を足すと、このテストは
    /// `掃除候補に localStorage の実体が含まれている` で落ちる。
    #[test]
    fn webkit_candidates_never_include_localstorage() {
        let home = PathBuf::from("/tmp/test-home");
        let candidates = webkit_cache_candidates(&home);
        assert!(
            !candidates.is_empty(),
            "候補が空だと本テストが素通りしてしまう (掃除自体が死んでいる兆候)"
        );
        for path in &candidates {
            for protected in WEBKIT_PROTECTED_SUBDIRS {
                assert!(
                    !path.components().any(|c| c.as_os_str() == *protected),
                    "掃除候補に localStorage の実体が含まれている: {} (保護名: {protected})",
                    path.display()
                );
            }
        }
    }

    /// `Library/WebKit/<id>` そのもの (= 直下を丸ごと消す形) が候補に無いこと。
    /// b1371c5 で入った故障そのものの再発検知。ディレクトリ名の追加では守れないので
    /// 「WebKit 配下は必ずサブディレクトリまで指定されている」を直接検査する。
    #[test]
    fn webkit_root_itself_is_never_a_cleanup_target() {
        let home = PathBuf::from("/tmp/test-home");
        let webkit_root = home.join("Library/WebKit");
        for path in webkit_cache_candidates(&home) {
            if let Ok(rel) = path.strip_prefix(&webkit_root) {
                assert!(
                    rel.components().count() >= 2,
                    "WebKit 配下は <id>/<キャッシュ名> まで指定が必要 (丸ごと削除は禁止): {}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn normal_line_is_unchanged() {
        let line = r#"{"type":"message","text":"お餅が好き"}"#.as_bytes();
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    // 以下のフィクスチャは実 rollout の形 (`image_url`) を使う。
    // 2026-08-06 以前は架空の `"image"` キーを使っていたが、実データに存在しない形
    // だったため「フィールドを見ずに位置だけで書き換える」不具合をテストが素通ししていた。
    #[test]
    fn strips_only_image_payload() {
        let line = br#"{"image_url":"data:image/png;base64,QUJDRA==","text":"keep me"}"#;
        let expected = br#"{"image_url":"data:image/png;base64,[stripped]","text":"keep me"}"#;
        let (actual, count) = strip_image_payloads_from_line(line).expect("画像を検出");
        assert_eq!(actual, expected);
        assert_eq!(count, 1);
    }

    #[test]
    fn escaped_quote_does_not_end_payload() {
        let line = br#"{"image_url":"data:image/webp;base64,AAAA\"BBBB","text":"keep"}"#;
        let expected = br#"{"image_url":"data:image/webp;base64,[stripped]","text":"keep"}"#;
        let (actual, count) = strip_image_payloads_from_line(line).expect("画像を検出");
        assert_eq!(actual, expected);
        assert_eq!(count, 1);
    }

    #[test]
    fn malformed_line_without_closing_quote_is_unchanged() {
        let line = br#"{"image_url":"data:image/png;base64,QUJDRA==}"#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    #[test]
    fn malformed_json_with_closing_quote_is_unchanged() {
        let line = br#"{"image_url":"data:image/png;base64,QUJDRA==""#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    #[test]
    fn already_stripped_payload_is_unchanged() {
        let line = br#"{"image_url":"data:image/jpeg;base64,[stripped]"}"#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    /// V6: 会話ログ本文 (`text`) に含まれる画像URLは**書き換えない**。
    ///
    /// なぜ要るか (実測 2026-08-06): 実 rollout 1666 ファイルを走査したところ、
    /// `data:image/` を含む文字列 909 件のうち 1 件が `text` フィールドだった
    /// (ツール出力の本文が `{"image_url":"data:image/..."}` を引用していた)。
    /// 従来は「JSON文字列の中にあるか」だけを見ていたため、この本文まで
    /// `[stripped]` に書き換わっていた = ユーザーの成果物であるログの改変。
    #[test]
    fn text_field_containing_image_url_is_not_rewritten() {
        // 本文の途中に画像URLが現れるケース (値の先頭ではない)。
        let line = br#"{"type":"message","text":"see data:image/png;base64,QUJDRA== here"}"#;
        assert!(
            strip_image_payloads_from_line(line).is_none(),
            "会話ログ本文が書き換えられた"
        );
    }

    /// V6: 本文が JSON 断片を引用しているケース (エスケープ済み引用符) も触らない。
    /// 実測で見つかった実物に最も近い形。
    #[test]
    fn quoted_json_fragment_inside_text_is_not_rewritten() {
        let line = br#"{"payload":{"text":"Total output lines: 1\n{\"image_url\":\"data:image/png;base64,QUJDRA==\"}"}}"#;
        assert!(
            strip_image_payloads_from_line(line).is_none(),
            "本文中に引用された JSON 断片が書き換えられた"
        );
    }

    /// V6: ホワイトリスト外のフィールドは触らない (`url` は画像ペイロード専用ではない)。
    #[test]
    fn non_whitelisted_field_is_not_rewritten() {
        let line = br#"{"url":"data:image/png;base64,QUJDRA=="}"#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    /// V6: 同じ行に「本文の画像URL」と「本物のペイロード」が混在しても、
    /// 剥がすのはペイロード側だけで本文は 1 バイトも変えない。
    #[test]
    fn mixed_line_strips_payload_but_preserves_text() {
        let line = br#"{"text":"data:image/png;base64,KEEPME==","image_url":"data:image/png;base64,QUJDRA=="}"#;
        let expected =
            br#"{"text":"data:image/png;base64,KEEPME==","image_url":"data:image/png;base64,[stripped]"}"#;
        let (actual, count) = strip_image_payloads_from_line(line).expect("画像を検出");
        assert_eq!(actual, expected);
        assert_eq!(count, 1);
    }
}
