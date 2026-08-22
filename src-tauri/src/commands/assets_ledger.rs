use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::storage::{
    backup_before_write, backup_projects_file, read_existing_for_guard, shrink_rejected,
    write_file_synced, StorageSettings,
};

const ASSETS_LEDGER_VERSION: u32 = 1;
const ASSETS_LEDGER_FILE_NAME: &str = "assets-ledger.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetLedgerType {
    Character,
    Scene,
    Look,
    Prop,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetLedgerSource {
    CharacterRegister,
    Preset,
    Film,
    Library,
    Import,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLedgerEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub asset_type: AssetLedgerType,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub primary_image_path: Option<String>,
    pub image_paths: Vec<String>,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub source: AssetLedgerSource,
    pub locked: bool,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetLedgerFile {
    pub version: u32,
    pub assets: Vec<AssetLedgerEntry>,
}

impl Default for AssetLedgerFile {
    fn default() -> Self {
        Self {
            version: ASSETS_LEDGER_VERSION,
            assets: Vec::new(),
        }
    }
}

fn assets_ledger_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    assets_ledger_file_path_for(settings.projects_data_root.as_deref())
}

fn assets_ledger_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root
        .map(str::trim)
        .filter(|root| !root.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!("アセット台帳の保存先作成に失敗 ({}): {err}", dir.display())
                })?;
            }
            Ok(dir.join(ASSETS_LEDGER_FILE_NAME))
        }
        None => {
            let data_dir = dirs::data_dir()
                .ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
            let app_dir = data_dir.join("app.codexframefactory");
            if !app_dir.exists() {
                fs::create_dir_all(&app_dir)
                    .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
            }
            Ok(app_dir.join(ASSETS_LEDGER_FILE_NAME))
        }
    }
}

fn count_assets(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => map
            .get("assets")
            .and_then(|value| value.as_array())
            .map(|assets| assets.len()),
        _ => None,
    }
}

fn guard_assets_ledger_write(
    existing: &str,
    incoming: &str,
    allow_empty: bool,
) -> Result<(), String> {
    if allow_empty {
        return Ok(());
    }

    let existing_count = count_assets(existing).unwrap_or(0);
    let incoming_count = count_assets(incoming).unwrap_or(0);
    if existing_count > 0 && incoming_count == 0 {
        return Err(format!(
            "空のアセット台帳で {existing_count} 件を上書きしようとしたため中止しました (データ保護)。"
        ));
    }

    if let Some((existing_count, incoming_count)) =
        shrink_rejected(existing, incoming, count_assets)
    {
        return Err(format!(
            "[SHRINK_GUARD existing={existing_count} incoming={incoming_count}] 保存内容 ({incoming_count} 件) がディスク上のアセット台帳 ({existing_count} 件) より大幅に少ないため中止しました (データ保護)。"
        ));
    }

    Ok(())
}

static ASSETS_LEDGER_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ASSETS_LEDGER_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn parse_assets_ledger(content: &str) -> Result<AssetLedgerFile, String> {
    let ledger: AssetLedgerFile = serde_json::from_str(content)
        .map_err(|err| format!("assets-ledger.json の形式が不正です: {err}"))?;
    if ledger.version != ASSETS_LEDGER_VERSION {
        return Err(format!(
            "未対応のアセット台帳バージョンです: {}",
            ledger.version
        ));
    }
    Ok(ledger)
}

fn read_assets_ledger_at(path: &Path) -> Result<AssetLedgerFile, String> {
    if !path.exists() {
        return Ok(AssetLedgerFile::default());
    }
    let content =
        fs::read_to_string(path).map_err(|err| format!("assets-ledger.json 読込失敗: {err}"))?;
    parse_assets_ledger(&content)
}

fn validate_asset(asset: &AssetLedgerEntry) -> Result<(), String> {
    if asset.id.trim().is_empty() {
        return Err("アセットIDは空にできません".to_string());
    }
    if asset.name.trim().is_empty() {
        return Err("アセット名は空にできません".to_string());
    }
    if asset.created_at.trim().is_empty() || asset.updated_at.trim().is_empty() {
        return Err("作成日時と更新日時は空にできません".to_string());
    }
    // prompt は意図的に検査しない。画像だけの登録も設計上の正規ケース。
    Ok(())
}

fn upsert_asset_in_ledger(
    ledger: &mut AssetLedgerFile,
    mut incoming: AssetLedgerEntry,
) -> Result<AssetLedgerEntry, String> {
    validate_asset(&incoming)?;
    if let Some(index) = ledger
        .assets
        .iter()
        .position(|asset| asset.id == incoming.id)
    {
        let existing = &ledger.assets[index];
        if existing.locked {
            return Err(format!(
                "locked のアセットは編集できません: {}",
                existing.id
            ));
        }
        incoming.created_at = existing.created_at.clone();
        ledger.assets[index] = incoming.clone();
    } else {
        ledger.assets.push(incoming.clone());
    }
    Ok(incoming)
}

fn delete_asset_from_ledger(ledger: &mut AssetLedgerFile, id: &str) -> Result<(), String> {
    let Some(index) = ledger.assets.iter().position(|asset| asset.id == id) else {
        return Err(format!("削除対象のアセットが見つかりません: {id}"));
    };
    if ledger.assets[index].locked {
        return Err(format!(
            "locked のアセットは削除できません: {}",
            ledger.assets[index].id
        ));
    }
    ledger.assets.remove(index);
    Ok(())
}

fn write_assets_ledger_at(
    path: &Path,
    ledger: &AssetLedgerFile,
    allow_empty: bool,
    backup: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if ledger.version != ASSETS_LEDGER_VERSION {
        return Err(format!(
            "未対応のアセット台帳バージョンです: {}",
            ledger.version
        ));
    }
    let content = serde_json::to_string_pretty(ledger)
        .map_err(|err| format!("アセット台帳のJSON変換に失敗: {err}"))?;
    let existing = read_existing_for_guard(path, "アセット台帳")?;
    if let Some(existing) = existing.as_deref() {
        if let Err(err) = guard_assets_ledger_write(existing, &content, allow_empty) {
            let _ = backup(path);
            return Err(err);
        }
    }

    // バックアップが取れない場合は正本へ書かない。
    backup(path)?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let seq = ASSETS_LEDGER_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("assets-ledger.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("assets-ledger.json リネーム失敗: {err}"));
    }
    Ok(())
}

fn asset_backup_stamp(file_name: &str, backup_id: &str) -> Option<u64> {
    let suffix = backup_id.strip_prefix(&format!("{file_name}.bak-"))?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    suffix.parse().ok()
}

fn resolve_asset_backup_path(ledger_path: &Path, backup_id: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(backup_id).components();
    let Some(Component::Normal(name)) = components.next() else {
        return Err("不正なバックアップIDです".to_string());
    };
    if components.next().is_some() || name.to_str() != Some(backup_id) {
        return Err("不正なバックアップIDです".to_string());
    }

    let file_name = ledger_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "assets-ledger.json パス解決失敗".to_string())?;
    if asset_backup_stamp(file_name, backup_id).is_none() {
        return Err("不正なバックアップIDです".to_string());
    }
    let dir = ledger_path
        .parent()
        .ok_or_else(|| "assets-ledger.json 親ディレクトリ解決失敗".to_string())?;
    let backup_path = dir.join(backup_id);
    let metadata = fs::symlink_metadata(&backup_path)
        .map_err(|_| "バックアップが見つかりません".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("バックアップが通常ファイルではありません".to_string());
    }

    let canonical_dir =
        fs::canonicalize(dir).map_err(|err| format!("バックアップフォルダの確認に失敗: {err}"))?;
    let canonical_backup =
        fs::canonicalize(&backup_path).map_err(|err| format!("バックアップの確認に失敗: {err}"))?;
    if canonical_backup.parent() != Some(canonical_dir.as_path()) {
        return Err("バックアップフォルダ直下のファイルではありません".to_string());
    }

    Ok(backup_path)
}

#[tauri::command]
pub async fn assets_ledger_read() -> Result<AssetLedgerFile, String> {
    read_assets_ledger_at(&assets_ledger_file_path()?)
}

#[tauri::command]
pub async fn assets_ledger_upsert(asset: AssetLedgerEntry) -> Result<AssetLedgerEntry, String> {
    let _guard = ASSETS_LEDGER_WRITE_LOCK.lock().await;
    let path = assets_ledger_file_path()?;
    let mut ledger = read_assets_ledger_at(&path)?;
    let saved = upsert_asset_in_ledger(&mut ledger, asset)?;
    write_assets_ledger_at(&path, &ledger, false, |path| {
        backup_before_write(path, "アセット台帳")
    })?;
    Ok(saved)
}

#[tauri::command]
pub async fn assets_ledger_delete(id: String) -> Result<(), String> {
    let _guard = ASSETS_LEDGER_WRITE_LOCK.lock().await;
    let path = assets_ledger_file_path()?;
    let mut ledger = read_assets_ledger_at(&path)?;
    delete_asset_from_ledger(&mut ledger, &id)?;
    // このコマンドは呼び出し側で確認済みの1件削除だけを扱う。最後の1件なら
    // 0件保存を許可するが、一括削除経路は持たない。
    write_assets_ledger_at(&path, &ledger, ledger.assets.is_empty(), |path| {
        backup_before_write(path, "アセット台帳")
    })
}

#[tauri::command]
pub async fn assets_ledger_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = assets_ledger_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "assets-ledger.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "assets-ledger.json 親ディレクトリ解決失敗".to_string())?;
    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let backup_path = entry.path();
            let Some(backup_id) = backup_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let Some(stamp) = asset_backup_stamp(file_name, &backup_id) else {
                continue;
            };
            let metadata = match fs::symlink_metadata(&backup_path) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                    metadata
                }
                _ => continue,
            };
            if metadata.len() == 0 {
                continue;
            }
            let count = fs::read_to_string(&backup_path)
                .ok()
                .and_then(|content| count_assets(&content))
                .unwrap_or(0);
            if count == 0 {
                continue;
            }
            backups.push((backup_id, stamp, count));
        }
    }
    backups.sort_by(|left, right| right.1.cmp(&left.1));
    Ok(backups)
}

#[tauri::command]
pub async fn assets_ledger_read_backup(backup_id: String) -> Result<AssetLedgerFile, String> {
    let ledger_path = assets_ledger_file_path()?;
    let backup_path = resolve_asset_backup_path(&ledger_path, &backup_id)?;
    let content =
        fs::read_to_string(&backup_path).map_err(|err| format!("バックアップ読込失敗: {err}"))?;
    parse_assets_ledger(&content)
}

#[cfg(test)]
mod tests {
    use super::{
        count_assets, delete_asset_from_ledger, guard_assets_ledger_write,
        resolve_asset_backup_path, upsert_asset_in_ledger, write_assets_ledger_at,
        AssetLedgerEntry, AssetLedgerFile, AssetLedgerSource, AssetLedgerType,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "gori-assets-ledger-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn asset(index: usize, locked: bool) -> AssetLedgerEntry {
        AssetLedgerEntry {
            id: format!("al-{index}"),
            asset_type: AssetLedgerType::Character,
            name: format!("キャラ{index}"),
            created_at: "2026-08-22T00:00:00.000Z".to_string(),
            updated_at: "2026-08-22T00:00:00.000Z".to_string(),
            primary_image_path: Some(format!("/tmp/{index}.png")),
            image_paths: Vec::new(),
            prompt: String::new(),
            negative_prompt: None,
            source: AssetLedgerSource::Import,
            locked,
            tags: Vec::new(),
        }
    }

    fn ledger(count: usize) -> AssetLedgerFile {
        AssetLedgerFile {
            version: 1,
            assets: (0..count).map(|index| asset(index, false)).collect(),
        }
    }

    fn ledger_json(count: usize) -> String {
        serde_json::to_string(&ledger(count)).expect("serialize ledger")
    }

    #[test]
    fn assets_ledger_count_extracts_assets_array_length() {
        assert_eq!(count_assets(&ledger_json(3)), Some(3));
        assert_eq!(count_assets(r#"{"version":1}"#), None);
        assert_eq!(count_assets("[]"), None);
        assert_eq!(count_assets("{broken"), None);
    }

    #[test]
    fn assets_ledger_empty_overwrite_is_rejected() {
        let error = guard_assets_ledger_write(&ledger_json(2), &ledger_json(0), false)
            .expect_err("non-empty data must not be overwritten with an empty list");

        assert!(error.contains("空のアセット台帳"));
        assert!(error.contains("2 件"));
    }

    #[test]
    fn assets_ledger_large_shrink_is_rejected() {
        let error = guard_assets_ledger_write(&ledger_json(10), &ledger_json(4), false)
            .expect_err("a drop below half must be rejected");

        assert!(error.contains("[SHRINK_GUARD existing=10 incoming=4]"));
        assert!(error.contains("アセット台帳"));
    }

    #[test]
    fn assets_ledger_backup_failure_rejects_write_and_preserves_original() {
        let dir = unique_test_dir("backup-failure");
        fs::create_dir_all(&dir).expect("create ledger dir");
        let path = dir.join("assets-ledger.json");
        let original = ledger_json(2);
        fs::write(&path, &original).expect("write original ledger");

        let error = write_assets_ledger_at(&path, &ledger(3), false, |_| {
            Err("forced backup failure".to_string())
        })
        .expect_err("write must stop when backup fails");

        assert!(error.contains("forced backup failure"));
        assert_eq!(fs::read_to_string(&path).expect("read original"), original);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn assets_ledger_locked_delete_is_rejected() {
        let mut data = AssetLedgerFile {
            version: 1,
            assets: vec![asset(1, true)],
        };

        let error = delete_asset_from_ledger(&mut data, "al-1")
            .expect_err("locked asset must not be deleted");

        assert!(error.contains("locked"));
        assert_eq!(data.assets.len(), 1);
    }

    #[test]
    fn assets_ledger_locked_update_is_rejected() {
        let mut data = AssetLedgerFile {
            version: 1,
            assets: vec![asset(1, true)],
        };
        let mut changed = asset(1, false);
        changed.name = "変更後".to_string();

        let error = upsert_asset_in_ledger(&mut data, changed)
            .expect_err("locked asset must not be updated");

        assert!(error.contains("locked"));
        assert_eq!(data.assets[0].name, "キャラ1");
    }

    #[test]
    fn asset_backup_id_accepts_only_direct_known_regular_file() {
        let dir = unique_test_dir("backup-id");
        fs::create_dir_all(&dir).expect("create backup dir");
        let ledger_path = dir.join("assets-ledger.json");
        let backup_id = "assets-ledger.json.bak-1724313600000";
        let backup_path = dir.join(backup_id);
        fs::write(&backup_path, ledger_json(2)).expect("write backup");

        assert_eq!(
            resolve_asset_backup_path(&ledger_path, backup_id).expect("valid backup"),
            backup_path
        );
        for invalid in [
            "../assets-ledger.json.bak-1724313600000",
            "/tmp/assets-ledger.json.bak-1724313600000",
            "nested/assets-ledger.json.bak-1724313600000",
            "assets-ledger.json.bak-note",
            "presets.json.bak-1724313600000",
        ] {
            assert!(
                resolve_asset_backup_path(&ledger_path, invalid).is_err(),
                "不正IDを拒否する: {invalid}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn asset_backup_reader_rejects_symlink_file() {
        use std::os::unix::fs::symlink;

        let root = unique_test_dir("backup-link");
        let dir = root.join("data");
        fs::create_dir_all(&dir).expect("create backup dir");
        let ledger_path = dir.join("assets-ledger.json");
        let outside = root.join("outside.json");
        fs::write(&outside, ledger_json(2)).expect("write outside");
        let backup_id = "assets-ledger.json.bak-1724313600000";
        symlink(&outside, dir.join(backup_id)).expect("create backup symlink");

        assert!(resolve_asset_backup_path(&ledger_path, backup_id).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn production_backup_helper_is_linked_for_asset_ledgers() {
        let dir = unique_test_dir("backup-helper");
        fs::create_dir_all(&dir).expect("create ledger dir");
        let path = dir.join("assets-ledger.json");
        fs::write(&path, ledger_json(1)).expect("write ledger");

        assert!(super::backup_projects_file(&path));
        assert!(fs::read_dir(&dir)
            .expect("read ledger dir")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("assets-ledger.json.bak-")));
        let _ = fs::remove_dir_all(&dir);
    }
}
