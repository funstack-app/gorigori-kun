use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
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

/// Write a clipboard-pasted PNG into `~/.codex/generated_images/clipboard/`.
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

/// Persist a dropped / picked browser File into `~/.codex/generated_images/uploads/`.
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
}
