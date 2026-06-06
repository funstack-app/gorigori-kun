use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::Row as _;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::storage::{watcher_dirs, StorageSettings};
use crate::images::watcher::{scan_existing, start_watcher};
use crate::state::AppState;

#[derive(Serialize)]
pub struct StartWatchResult {
    pub dir: String,
    pub watching: bool,
}

#[tauri::command]
pub async fn images_start_watcher(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartWatchResult, String> {
    let settings = state
        .storage_settings()
        .await
        .or_else(|| StorageSettings::load().ok());
    let dirs = watcher_dirs(settings.as_ref());
    if dirs.is_empty() {
        return Err("no home directory".to_string());
    }
    for dir in &dirs {
        if !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // emit initial scan synchronously (so the UI renders existing assets fast)
        scan_existing(&app, dir);
    }
    let dir = dirs
        .last()
        .cloned()
        .ok_or_else(|| "no home directory".to_string())?;

    // already watching?
    if state.image_watcher.lock().await.is_some() {
        return Ok(StartWatchResult {
            dir: dir.to_string_lossy().into_owned(),
            watching: true,
        });
    }

    let watcher = start_watcher(app.clone(), dirs).map_err(|e| e.to_string())?;
    state.set_image_watcher(watcher).await;
    Ok(StartWatchResult {
        dir: dir.to_string_lossy().into_owned(),
        watching: true,
    })
}

/// Move (or copy when across mounts) an image into the project's working
/// directory. Returns the destination path so the frontend can update the
/// gallery in place.
#[tauri::command]
pub async fn images_save_to_project(
    src: String,
    project_dir: String,
    new_name: Option<String>,
) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let project = PathBuf::from(&project_dir);
    if !project.is_dir() {
        std::fs::create_dir_all(&project).map_err(|e| e.to_string())?;
    }
    let file_name = new_name.unwrap_or_else(|| {
        src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image.png")
            .to_string()
    });
    let dest = pick_unique(&project, &file_name)
        .ok_or_else(|| "could not find a free destination filename".to_string())?;
    // try rename, fall back to copy + remove (cross-device)
    if std::fs::rename(&src_path, &dest).is_err() {
        std::fs::copy(&src_path, &dest).map_err(|e| e.to_string())?;
        if let Err(err) = std::fs::remove_file(&src_path) {
            tracing::warn!(
                target: "codex.images",
                "saved {} but failed to remove source {}: {err}",
                dest.display(),
                src_path.display()
            );
        }
    }
    Ok(dest.to_string_lossy().into_owned())
}

fn pick_unique(project: &Path, file_name: &str) -> Option<PathBuf> {
    let initial = project.join(file_name);
    if !initial.exists() {
        return Some(initial);
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    for i in 1..10_000 {
        let cand = project.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return Some(cand);
        }
    }
    None
}

#[tauri::command]
pub async fn images_reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

/// Copy an image to an arbitrary user-chosen path. Used by the gallery's
/// "名前を付けて保存" action (the frontend gets the destination via
/// tauri-plugin-dialog's save dialog).
#[tauri::command]
pub async fn images_save_as(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dest_path = PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::copy(&src_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Rename an image in-place within its current directory. The caller supplies
/// a file name, not a path; moving between directories is intentionally rejected.
///
/// v0.7.3 (F-#2): rename 後に history.db の images.path を UPDATE する。
/// 旧パスを掴んだままだとライブラリ/制作タブ/プロジェクトで画像が消える。
#[tauri::command]
pub async fn images_rename(
    app: AppHandle,
    src: String,
    new_name: String,
) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_absolute() {
        return Err(format!("not an absolute path: {src}"));
    }
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }

    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("new file name is empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("new file name must not contain path separators".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("new file name is invalid".to_string());
    }

    let parent = src_path
        .parent()
        .ok_or_else(|| format!("source has no parent dir: {src}"))?;
    let mut file_name = PathBuf::from(trimmed);
    if file_name.extension().is_none() {
        if let Some(ext) = src_path.extension() {
            file_name.set_extension(ext);
        }
    }
    let dest = parent.join(file_name);
    if dest.exists() {
        return Err("file already exists".to_string());
    }

    std::fs::rename(&src_path, &dest).map_err(|e| e.to_string())?;
    let dest_string = dest.to_string_lossy().into_owned();

    // history.db の images.path を更新。pool が無くても rename 自体は成功扱い。
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(pool) = state.db_pool().await {
            let update_result =
                sqlx::query("UPDATE images SET path = ?1 WHERE path = ?2")
                    .bind(&dest_string)
                    .bind(&src)
                    .execute(&pool)
                    .await;
            if let Err(e) = update_result {
                tracing::warn!(
                    error = ?e,
                    old_path = %src,
                    new_path = %dest_string,
                    "images_rename: history.db の path 更新に失敗 (rename 自体は成功)"
                );
            }
        }
    }

    Ok(dest_string)
}

/// Decode an image and write it to a user-chosen path as PNG or JPEG.
#[tauri::command]
pub async fn images_save_as_format(
    src: String,
    dest: String,
    format: String,
    quality: Option<u8>,
) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dest_path = PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let img = image::open(&src_path).map_err(|e| format!("decode failed: {e}"))?;
    let normalized = format.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "png" => {
            let rgba = img.to_rgba8();
            rgba.save_with_format(&dest_path, image::ImageFormat::Png)
                .map_err(|e| format!("png encode failed: {e}"))?;
        }
        "jpeg" => {
            let quality = quality.unwrap_or(92).clamp(1, 100);
            let file =
                std::fs::File::create(&dest_path).map_err(|e| format!("create failed: {e}"))?;
            let rgb = img.to_rgb8();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality);
            encoder
                .encode_image(&rgb)
                .map_err(|e| format!("jpeg encode failed: {e}"))?;
        }
        _ => return Err("unsupported format".to_string()),
    }
    Ok(())
}

/// Write a PNG mask alongside the source image under a hidden `.masks/`
/// sibling directory. Returns the destination absolute path.
///
/// The gallery watcher skips `.masks/` so masks never show up as gallery
/// items, even though they live next to the source.
#[tauri::command]
pub async fn images_write_mask(src_path: String, png_bytes: Vec<u8>) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let parent = src
        .parent()
        .ok_or_else(|| format!("source has no parent dir: {src_path}"))?;
    let masks_dir = parent.join(".masks");
    if !masks_dir.exists() {
        std::fs::create_dir_all(&masks_dir).map_err(|e| e.to_string())?;
    }
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = masks_dir.join(format!("{stem}-mask-{ts}.png"));
    std::fs::write(&dest, &png_bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Write a clipboard-pasted PNG into `<CODEX_HOME>/generated_images/clipboard/`
/// (GORI 専用 CODEX_HOME, FB#19)。
/// The recursive watcher already monitors that tree, so the new file
/// shows up in the gallery automatically; the returned path is what the
/// composer uses as a reference.
#[tauri::command]
pub async fn images_write_clipboard(png_bytes: Vec<u8>) -> Result<String, String> {
    if png_bytes.is_empty() {
        return Err("クリップボードから読み取れる画像がありません".into());
    }
    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    let dir = base.join("clipboard");
    std::fs::create_dir_all(&dir).map_err(|e| format!("dir 作成失敗: {e}"))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // The basename starts with `ig_` so the existing recursive watcher
    // (which is liberal about what it includes) treats it as a regular
    // image and surfaces it in the gallery without further plumbing.
    let dest = dir.join(format!("ig_clip_{ts}.png"));
    std::fs::write(&dest, &png_bytes).map_err(|e| format!("write 失敗: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Persist a dropped / picked browser File into
/// `<CODEX_HOME>/generated_images/uploads/` (GORI 専用 CODEX_HOME, FB#19)。
/// This is the fallback path for cases where the webview cannot expose the
/// original filesystem path to the frontend. Keeping the file under the
/// generated_images tree also makes it visible in the gallery watcher.
#[tauri::command]
pub async fn images_write_upload(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("画像データが空です".into());
    }
    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    let dir = base.join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("dir 作成失敗: {e}"))?;

    let safe_name = sanitize_upload_name(&file_name);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = pick_unique(&dir, &format!("ig_upload_{ts}_{safe_name}"))
        .ok_or_else(|| "保存先ファイル名の確保に失敗".to_string())?;
    std::fs::write(&dest, &bytes).map_err(|e| format!("write 失敗: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn sanitize_upload_name(file_name: &str) -> String {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("image.png");
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.contains('.') {
        out
    } else {
        format!("{out}.png")
    }
}

/// Remove the background of an image using the bundled `removebg.swift`
/// helper (macOS Vision API, no network). Writes a transparent PNG next
/// to the source under the `~/.codex/generated_images/<session>/` tree
/// so the watcher picks it up automatically.
///
/// `bg_color_hex` (optional, e.g. "#f8f8f7") switches to chroma-key
/// fallback when Vision can't isolate a subject (UI mockups, flat
/// backgrounds, etc.).
#[tauri::command]
pub async fn images_remove_background(
    app: AppHandle,
    src_path: String,
    bg_color_hex: Option<String>,
) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("背景透過は macOS のみ対応です (Vision API 使用)".into());
    }

    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err(format!("ソース画像が見つかりません: {src_path}"));
    }

    let script = app
        .path()
        .resolve(
            "resources/removebg.swift",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("removebg.swift の解決に失敗: {e}"))?;
    if !script.exists() {
        return Err(format!(
            "removebg.swift がバンドルに見つかりません: {}",
            script.display()
        ));
    }

    let parent = src
        .parent()
        .ok_or_else(|| format!("ソースの親ディレクトリ取得に失敗: {src_path}"))?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let dest = pick_unique(parent, &format!("{stem}-nobg.png"))
        .ok_or_else(|| "保存先ファイル名の確保に失敗".to_string())?;

    let mut cmd = tokio::process::Command::new("swift");
    cmd.arg(&script).arg(&src).arg(&dest);
    if let Some(hex) = bg_color_hex.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--bg-color").arg(hex);
    }
    // GUI 起動された .app は PATH に `swift` の場所 (/usr/bin) を含むものの
    // Xcode のコマンドラインツールが他経路で配置されているケースがあるので、
    // login shell の PATH を渡しておく。
    cmd.env("PATH", crate::codex::process::enriched_path());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("swift 実行に失敗 (Xcode コマンドラインツールが必要): {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!(
            "背景透過処理が失敗しました: {}",
            stderr
                .trim()
                .is_empty()
                .then(|| "(stderr 出力なし)")
                .unwrap_or(stderr.trim())
        ));
    }

    Ok(dest.to_string_lossy().into_owned())
}

/// Remove a single media file from disk only (no history.db touch).
///
/// 単一削除・一括削除の両コマンドが共有する物理削除コア。
/// - 絶対パス必須、ディレクトリは拒否 (構造的に巨大削除を防ぐ)
/// - 拡張子が画像/動画のものだけ許可 (設定ファイル等の誤削除を防ぐ)
/// - 既に無いファイルは成功扱い (二重削除や watcher 遅延を吸収)
fn remove_media_file(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }

    // ディレクトリ削除を構造的に防ぐ。
    if target.is_dir() {
        return Err(format!("refusing to delete a directory: {path}"));
    }

    if target.exists() {
        // 画像/動画ファイルのみ許可。設定ファイル等の誤削除を防ぐ。
        let ext = target
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        const ALLOWED: &[&str] = &[
            "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "mp4", "mov", "webm", "m4v",
        ];
        if !ALLOWED.contains(&ext.as_str()) {
            return Err(format!("refusing to delete non-media file: {path}"));
        }

        std::fs::remove_file(&target)
            .map_err(|e| format!("削除に失敗しました ({path}): {e}"))?;
    }

    Ok(())
}

/// Drop a path's row from history.db. Failure is logged, not propagated:
/// the on-disk delete already succeeded and history.db is a cache.
async fn drop_history_row(app: &AppHandle, path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(pool) = state.db_pool().await {
            if let Err(e) = sqlx::query("DELETE FROM images WHERE path = ?1")
                .bind(path)
                .execute(&pool)
                .await
            {
                tracing::warn!(
                    error = ?e,
                    path = %path,
                    "images_delete: history.db からの削除に失敗 (ファイル削除自体は成功)"
                );
            }
        }
    }
}

/// Delete an image file from disk and drop its row from history.db.
///
/// F-#12 (Ta4low/没作品削除): ライブラリ/プロジェクトの没作品を右クリックから
/// 物理削除できるようにする。trash クレートを増やすとビルドリスクが上がるため、
/// `std::fs::remove_file` で直接消す。誤って巨大削除しないよう、対象は
/// **拡張子が画像/動画のファイル1件のみ**に限定する。
///
/// 失敗を握り潰さない方針 (Rust ルール): ファイルが既に無い場合は成功扱い
/// (UI からの二重削除や watcher 遅延を吸収)、それ以外の I/O エラーは Err で返す。
#[tauri::command]
pub async fn images_delete(app: AppHandle, path: String) -> Result<(), String> {
    remove_media_file(&path)?;
    drop_history_row(&app, &path).await;
    Ok(())
}

/// Result of a batch delete: how many files were removed and which paths
/// failed (with their error message). One failing path does not abort the
/// rest — partial success is reported so the UI can update what did delete.
#[derive(Serialize)]
pub struct BatchDeleteResult {
    pub deleted: usize,
    pub failed: Vec<BatchDeleteFailure>,
}

#[derive(Serialize)]
pub struct BatchDeleteFailure {
    pub path: String,
    pub error: String,
}

/// Delete multiple media files at once (複数選択での一括削除).
///
/// 各パスごとに物理削除 + history.db 行削除を行う。1 件失敗しても残りは続行し、
/// 成功件数と失敗内訳を返す。フロントは成功したパスだけ表示から外せばよいよう、
/// 失敗内訳に path を含める。
#[tauri::command]
pub async fn images_delete_many(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<BatchDeleteResult, String> {
    let mut deleted = 0usize;
    let mut failed: Vec<BatchDeleteFailure> = Vec::new();

    for path in paths {
        match remove_media_file(&path) {
            Ok(()) => {
                drop_history_row(&app, &path).await;
                deleted += 1;
            }
            Err(error) => failed.push(BatchDeleteFailure { path, error }),
        }
    }

    Ok(BatchDeleteResult { deleted, failed })
}

/// ファイル名 → 実在する絶対パス の対応表を返す再リンク用インデックス。
///
/// α版→β版で画像の保存先ディレクトリが変わった (FB#19 で CODEX_HOME を専用
/// HOME に切り替えた、storage_root が `~/Pictures/GORI GORI` に変わった等) ため、
/// history.db / projects.json が記録した旧パスの実体が「別ディレクトリに同名で
/// 存在する」状態になっている。候補ディレクトリを再帰走査して
/// `basename -> 実在パス` の索引を作り、旧パスの basename で引き直す。
///
/// 同名ファイルが複数候補にある場合は **最初に見つけた 1 つ** を採用する
/// (走査順は watcher_dirs と同じ: 現行 HOME → 旧 ~/.codex → storage_root)。
fn build_filename_index(dirs: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, PathBuf> = HashMap::new();
    for dir in dirs {
        index_dir_recursive(dir, &mut index);
    }
    index
}

fn index_dir_recursive(dir: &Path, index: &mut HashMap<String, PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // symlink はループ防止でスキップ (watcher と同方針)。
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            // マスク PNG はギャラリーに出さない隠しディレクトリなので索引対象外。
            if path.file_name().and_then(|s| s.to_str()) == Some(".masks") {
                continue;
            }
            index_dir_recursive(&path, index);
        } else if file_type.is_file() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                // 先勝ち。既に入っている basename は上書きしない (走査順を尊重)。
                index.entry(name.to_string()).or_insert(path);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkResult {
    /// history.db で旧パス→新パスに張り替えた件数。
    pub db_updated: u32,
    /// 候補が見つからずスキップした (= SafeImage フォールバック対象) 件数。
    pub db_unresolved: u32,
    /// フロント側 (projects.json) が同じ張り替えを適用するための旧→新マップ。
    /// projects.json は Rust から触らない (フロントの正本) ため、対応表だけ返す。
    pub path_map: HashMap<String, String>,
}

/// 記録パスと実体のズレを再リンクで解消する (非破壊・冪等)。
///
/// α版は画像を `~/.codex/generated_images/` に保存していたが、β版 (FB#19 認証分離)
/// で保存先が専用 CODEX_HOME や `~/Pictures/GORI GORI` に変わった。history.db の
/// `images.path` と projects.json の `imagePath` が旧パスのままだと、その場所に
/// 実体が無いので「画像が見えない (黒画像/画像なし)」になる。
///
/// この関数は:
///   1. 候補ディレクトリ (現行 HOME / 旧 ~/.codex / storage_root) を再帰走査し
///      `basename -> 実在パス` の索引を作る。
///   2. history.db の各 `images.path` を見て、**実在しないものだけ** basename で
///      索引を引き、見つかれば DB のパスを張り替える (UPDATE)。
///   3. フロント (projects.json) が同じ張り替えを適用できるよう、旧→新の
///      対応表 (`path_map`) を返す。
///
/// 非破壊性: ファイルの移動・削除は一切しない。DB 内のパス文字列を更新するのみ。
/// 冪等性: 既に実在するパスは触らない。再実行しても同じ結果。
/// 見つからない画像はそのまま (SafeImage がフォールバック表示するのでクラッシュしない)。
#[tauri::command]
pub async fn images_relink_missing(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RelinkResult, String> {
    // 候補ディレクトリ = watcher と同じ集合 (現行 HOME / 旧 ~/.codex / storage_root)。
    let settings = state
        .storage_settings()
        .await
        .or_else(|| StorageSettings::load().ok());
    let dirs = watcher_dirs(settings.as_ref());
    let index = build_filename_index(&dirs);

    let mut result = RelinkResult {
        db_updated: 0,
        db_unresolved: 0,
        path_map: HashMap::new(),
    };

    // DB pool が無くても (= 初期化前) クラッシュさせない。空の結果を返す。
    let Some(pool) = state.db_pool().await else {
        tracing::warn!(
            target: "codex.images",
            "images_relink_missing: db pool 未初期化のため history.db の再リンクをスキップ"
        );
        let _ = &app;
        return Ok(result);
    };

    // 全 images.path を取得 (重複は DISTINCT で 1 回だけ評価)。
    let rows = sqlx::query("SELECT DISTINCT path FROM images")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("images.path の読み出しに失敗: {e}"))?;

    for row in rows {
        let old_path: String = row.get::<String, _>("path");
        if old_path.is_empty() {
            continue;
        }
        // 既に実在するパスは触らない (冪等)。
        if Path::new(&old_path).is_file() {
            continue;
        }
        // basename で実在場所を探す。
        let Some(file_name) = Path::new(&old_path).file_name().and_then(|s| s.to_str()) else {
            result.db_unresolved += 1;
            continue;
        };
        let Some(new_path) = index.get(file_name) else {
            // 候補なし。SafeImage フォールバックに任せる。
            result.db_unresolved += 1;
            continue;
        };
        let new_path_str = new_path.to_string_lossy().into_owned();
        if new_path_str == old_path {
            // basename 一致だが同一パス (理屈上ありえないが防御的に)。
            continue;
        }

        let update = sqlx::query("UPDATE images SET path = ?1 WHERE path = ?2")
            .bind(&new_path_str)
            .bind(&old_path)
            .execute(&pool)
            .await;
        match update {
            Ok(_) => {
                result.db_updated += 1;
                result.path_map.insert(old_path, new_path_str);
            }
            Err(e) => {
                tracing::warn!(
                    target: "codex.images",
                    error = ?e,
                    old_path = %old_path,
                    new_path = %new_path_str,
                    "images_relink_missing: history.db の path 更新に失敗"
                );
                result.db_unresolved += 1;
            }
        }
    }

    // app は将来の拡張 (再リンク後の再スキャン emit 等) で使う余地を残すため受け取る。
    let _ = &app;

    tracing::info!(
        target: "codex.images",
        db_updated = result.db_updated,
        db_unresolved = result.db_unresolved,
        "images_relink_missing: 完了"
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_unique_increments_when_taken() {
        let dir = tempfile::tempdir().unwrap();
        let initial = pick_unique(dir.path(), "foo.png").unwrap();
        std::fs::write(&initial, b"x").unwrap();
        let next = pick_unique(dir.path(), "foo.png").unwrap();
        assert_eq!(next.file_name().unwrap(), "foo (1).png");
    }

    #[tokio::test]
    async fn write_mask_creates_masks_subdir_and_returns_path() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("hero.png");
        std::fs::write(&src, b"\x89PNG").unwrap();

        let out = images_write_mask(src.to_string_lossy().into_owned(), vec![0u8, 1, 2, 3, 4, 5])
            .await
            .unwrap();

        let out_path = PathBuf::from(out);
        assert_eq!(out_path.parent().unwrap().file_name().unwrap(), ".masks");
        assert!(out_path.starts_with(dir.path()));
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(bytes, vec![0u8, 1, 2, 3, 4, 5]);
        let name = out_path.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("hero-mask-"));
        assert!(name.ends_with(".png"));
    }

    #[test]
    fn filename_index_finds_files_recursively_and_skips_masks() {
        let root = tempfile::tempdir().unwrap();
        // ネストしたサブフォルダに同名ファイルを置く (β版の新ディレクトリ想定)。
        let nested = root.path().join("batch-123");
        std::fs::create_dir_all(&nested).unwrap();
        let img = nested.join("ig_abc.png");
        std::fs::write(&img, b"x").unwrap();
        // .masks 配下のファイルは索引対象外。
        let masks = nested.join(".masks");
        std::fs::create_dir_all(&masks).unwrap();
        std::fs::write(masks.join("ig_abc-mask-1.png"), b"y").unwrap();

        let index = build_filename_index(&[root.path().to_path_buf()]);
        assert_eq!(index.get("ig_abc.png"), Some(&img));
        assert!(index.get("ig_abc-mask-1.png").is_none());
    }

    #[test]
    fn filename_index_first_dir_wins_on_duplicate_name() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let a = dir_a.path().join("dup.png");
        let b = dir_b.path().join("dup.png");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        // dir_a を先に渡すと dir_a 側が勝つ (走査順を尊重)。
        let index =
            build_filename_index(&[dir_a.path().to_path_buf(), dir_b.path().to_path_buf()]);
        assert_eq!(index.get("dup.png"), Some(&a));
    }
}
