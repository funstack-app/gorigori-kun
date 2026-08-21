use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::storage::{
    backup_before_write, backup_projects_file, read_existing_for_guard, shrink_rejected,
    write_file_synced, StorageSettings,
};

// ---------------------------------------------------------------------------
// film-projects.json (フィルムプロジェクト) のファイル永続化
//
// 形は object ({version, projects})。presets.json と同じ多重防御を独立して持つ。
// 共通化リファクタで既存の保存経路を変える差分リスクを避けるため、パス解決・
// コマンド本体は presets 版と同型の意図的な重複にしている。
// ---------------------------------------------------------------------------

/// film-projects.json の保存パス。presets.json と同じ解決規則
/// (StorageSettings.projects_data_root 指定があればその配下、無ければ OS 標準
/// アプリデータディレクトリ)。
fn film_projects_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    film_projects_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) から film-projects.json パスを組み立てる。
fn film_projects_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!(
                        "フィルムプロジェクト保存先の作成に失敗 ({}): {err}",
                        dir.display()
                    )
                })?;
            }
            Ok(dir.join("film-projects.json"))
        }
        None => {
            let data_dir = dirs::data_dir()
                .ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
            let app_dir = data_dir.join("app.codexframefactory");
            if !app_dir.exists() {
                fs::create_dir_all(&app_dir)
                    .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
            }
            Ok(app_dir.join("film-projects.json"))
        }
    }
}

/// film-projects.json (object 形) の `projects` 配列の要素数。
/// object でない / projects が無い / 壊れた JSON は None (= ガードでは 0 扱い)。
fn count_film_projects(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => map
            .get("projects")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        _ => None,
    }
}

/// 書き込み前の空上書き・激減ガード。実パスに触れない純粋な判定に分け、
/// 壊れた incoming JSON も 0 件として拒否側に倒れることを単体テストできるようにする。
fn guard_film_projects_write(
    existing: &str,
    incoming: &str,
    allow_empty: bool,
) -> Result<(), String> {
    if allow_empty {
        return Ok(());
    }

    let existing_count = count_film_projects(existing).unwrap_or(0);
    let incoming_count = count_film_projects(incoming).unwrap_or(0);
    if existing_count > 0 && incoming_count == 0 {
        return Err(format!(
            "空のフィルムプロジェクトで {existing_count} 件を上書きしようとしたため中止しました (データ保護)。意図的な全削除なら allow_empty を指定してください。"
        ));
    }

    if let Some((e, i)) = shrink_rejected(existing, incoming, count_film_projects) {
        return Err(format!(
            "[SHRINK_GUARD existing={e} incoming={i}] 保存内容 ({i} 件) がディスク上のフィルムプロジェクト ({e} 件) より大幅に少ないため中止しました (データ保護)。意図的な整理なら allow_empty を指定してください。"
        ));
    }

    Ok(())
}

/// film_projects_write の直列化ロック。他の保存コマンドとは独立させる。
static FILM_PROJECTS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// tmp 名のプロセス内ユニーク化カウンタ (film-projects 専用、epochナノ秒と併用)。
static FILM_PROJECTS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// film-projects.json を読み出す。存在しなければ**空文字列**を返す。
#[tauri::command]
pub async fn film_projects_read() -> Result<String, String> {
    let path = film_projects_file_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("film-projects.json 読込失敗: {err}"))
}

/// film-projects.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epochミリ秒, プロジェクト件数)。
#[tauri::command]
pub async fn film_projects_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = film_projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "film-projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "film-projects.json 親ディレクトリ解決失敗".to_string())?;
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
                .and_then(|c| count_film_projects(&c))
                .unwrap_or(0);
            // 0件のバックアップは復元候補に出さない (presets 版と同じ防御)。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// パスは film_projects_list_backups が返した命名に限定する。
#[tauri::command]
pub async fn film_projects_read_backup(backup_path: String) -> Result<String, String> {
    let path = film_projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "film-projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "film-projects.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// film-projects.json に書き込む。
/// 直列化 → 空/激減ガード → 世代バックアップ → fsync 済み tmp → rename の順で守る。
#[tauri::command]
pub async fn film_projects_write(content: String, allow_empty: Option<bool>) -> Result<(), String> {
    let _guard = FILM_PROJECTS_WRITE_LOCK.lock().await;
    let path = film_projects_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    let existing = read_existing_for_guard(&path, "フィルムプロジェクトデータ")?;
    if let Some(existing) = existing.as_deref() {
        if let Err(err) = guard_film_projects_write(existing, &content, allow_empty) {
            let _ = backup_projects_file(&path);
            return Err(err);
        }
    }

    // バックアップが取れない場合は正本へ書かない。
    backup_before_write(&path, "フィルムプロジェクトデータ")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = FILM_PROJECTS_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("film-projects.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("film-projects.json リネーム失敗: {err}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{count_film_projects, guard_film_projects_write};

    fn film_projects_json(count: usize) -> String {
        let projects: Vec<serde_json::Value> = (0..count)
            .map(|index| serde_json::json!({ "id": format!("film-{index}") }))
            .collect();
        serde_json::json!({ "version": 1, "projects": projects }).to_string()
    }

    #[test]
    fn film_count_extracts_projects_array_length() {
        assert_eq!(count_film_projects(&film_projects_json(3)), Some(3));
        assert_eq!(count_film_projects(r#"{"version":1}"#), None);
        assert_eq!(count_film_projects("[]"), None);
        assert_eq!(count_film_projects("{broken"), None);
    }

    #[test]
    fn film_empty_overwrite_is_rejected() {
        let error =
            guard_film_projects_write(&film_projects_json(2), &film_projects_json(0), false)
                .expect_err("non-empty data must not be overwritten with an empty list");

        assert!(error.contains("空のフィルムプロジェクト"));
        assert!(error.contains("2 件"));
    }

    #[test]
    fn film_large_shrink_is_rejected() {
        let error =
            guard_film_projects_write(&film_projects_json(10), &film_projects_json(4), false)
                .expect_err("a drop below half must be rejected");

        assert!(error.contains("[SHRINK_GUARD existing=10 incoming=4]"));
        assert!(error.contains("フィルムプロジェクト"));
    }

    #[test]
    fn film_corrupt_incoming_json_is_rejected() {
        let error = guard_film_projects_write(&film_projects_json(2), "{broken", false)
            .expect_err("corrupt incoming JSON must be treated as zero items");

        assert!(error.contains("空のフィルムプロジェクト"));
    }
}
