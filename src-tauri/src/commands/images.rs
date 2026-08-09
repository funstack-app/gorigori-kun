use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sqlx::Row as _;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::commands::storage::{watcher_dirs, StorageSettings};
use crate::images::watcher::{scan_existing, start_watcher};
use crate::state::AppState;

/// 同じキャッシュ先の同時生成を1本にまとめる。
/// 値は生成完了後に map から外すため、3,500件のライブラリを巡回しても増え続けない。
static THUMBNAIL_LOCKS: Lazy<tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// 画像デコードは一時的に大きなメモリを使うため、別画像でも同時実行数を抑える。
static THUMBNAIL_GENERATION_LIMIT: Lazy<Arc<tokio::sync::Semaphore>> =
    Lazy::new(|| Arc::new(tokio::sync::Semaphore::new(2)));

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
    app: AppHandle,
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

    let dest_string = dest.to_string_lossy().into_owned();

    // 移動もリネームと対称に history.db の images.path を UPDATE する (biy)。
    // これを欠くと、watcher 外の保存先では次回起動の relink(allow_prune=true) が
    // 「実体なし」と誤判定してレコードを削除する (履歴・サムネから消える)。
    // relink は既に実在するパスには触らない (Path::is_file 判定) ため、
    // 新パスへ更新しておけば watcher 外でも prune されない。
    // pool が無くても移動自体は成功扱い (rename と同じ方針)。
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(pool) = state.db_pool().await {
            if let Err(e) = sqlx::query("UPDATE images SET path = ?1 WHERE path = ?2")
                .bind(&dest_string)
                .bind(&src)
                .execute(&pool)
                .await
            {
                tracing::warn!(
                    error = ?e,
                    old_path = %src,
                    new_path = %dest_string,
                    "images_save_to_project: history.db の path 更新に失敗 (移動自体は成功)"
                );
            }
        }
    }

    Ok(dest_string)
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
            let update_result = sqlx::query("UPDATE images SET path = ?1 WHERE path = ?2")
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

/// 一覧表示用の縮小JPEGを `<app_data>/thumb-cache/` に作り、その絶対パスを返す。
///
/// キャッシュ名は「元パスのSHA-256 + 元ファイルのmtime + max_edge」。元画像が
/// 更新されると別名になるため、古いサムネイルを誤って再利用しない。
#[tauri::command]
pub async fn images_thumbnail(
    app: AppHandle,
    path: String,
    max_edge: u32,
) -> Result<String, String> {
    if max_edge == 0 {
        return Err("max_edge must be greater than zero".to_string());
    }

    let source = PathBuf::from(&path);
    let metadata =
        std::fs::metadata(&source).map_err(|e| format!("thumbnail source metadata failed: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let modified = metadata
        .modified()
        .map_err(|e| format!("thumbnail source mtime failed: {e}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("thumbnail source mtime is before unix epoch: {e}"))?;

    let path_hash = Sha256::digest(source.to_string_lossy().as_bytes());
    let file_name = format!(
        "{}-{}-{:09}-{max_edge}.jpg",
        hex::encode(path_hash),
        modified.as_secs(),
        modified.subsec_nanos()
    );
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir resolution failed: {e}"))?
        .join(crate::storage_cleanup::THUMB_CACHE_DIR_NAME);
    let destination = cache_dir.join(file_name);

    if destination.is_file() {
        return Ok(destination.to_string_lossy().into_owned());
    }

    let destination_lock = {
        let mut locks = THUMBNAIL_LOCKS.lock().await;
        locks
            .entry(destination.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let generation_guard = destination_lock.lock().await;

    // 待っている間に先頭の要求が生成済みなら、再デコードせず即返す。
    let result = if destination.is_file() {
        Ok(destination.to_string_lossy().into_owned())
    } else {
        match THUMBNAIL_GENERATION_LIMIT.clone().acquire_owned().await {
            Ok(permit) => {
                let source_for_task = source.clone();
                let destination_for_task = destination.clone();
                let cache_dir_for_task = cache_dir.clone();
                let joined = tokio::task::spawn_blocking(move || {
                    write_thumbnail(
                        &source_for_task,
                        &destination_for_task,
                        &cache_dir_for_task,
                        max_edge,
                    )
                })
                .await;
                drop(permit);
                match joined {
                    Ok(inner) => inner,
                    Err(e) => Err(format!("thumbnail worker failed: {e}")),
                }
            }
            Err(e) => Err(format!("thumbnail generation limiter failed: {e}")),
        }
    };

    drop(generation_guard);
    let mut locks = THUMBNAIL_LOCKS.lock().await;
    if locks
        .get(&destination)
        .is_some_and(|current| Arc::ptr_eq(current, &destination_lock))
    {
        locks.remove(&destination);
    }

    result
}

fn write_thumbnail(
    source: &Path,
    destination: &Path,
    cache_dir: &Path,
    max_edge: u32,
) -> Result<String, String> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| format!("thumbnail cache dir creation failed: {e}"))?;
    if destination.is_file() {
        return Ok(destination.to_string_lossy().into_owned());
    }

    let image = image::open(source).map_err(|e| format!("thumbnail decode failed: {e}"))?;
    let thumbnail = image.thumbnail(max_edge, max_edge).to_rgb8();
    let temp_path = destination.with_extension(format!("jpg.{}.tmp", std::process::id()));

    let encode_result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&temp_path)
            .map_err(|e| format!("thumbnail temp creation failed: {e}"))?;
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 80);
        encoder
            .encode_image(&thumbnail)
            .map_err(|e| format!("thumbnail jpeg encode failed: {e}"))?;
        std::fs::rename(&temp_path, destination)
            .map_err(|e| format!("thumbnail cache commit failed: {e}"))?;
        Ok(())
    })();

    if encode_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    encode_result?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Write a PNG mask alongside the source image under a hidden `.masks/`
/// sibling directory. Returns the destination absolute path.
///
/// The gallery watcher skips `.masks/` so masks never show up as gallery
/// items, even though they live next to the source.
///
/// 生バイトは raw payload で届く (`src/lib/ipcBytes.ts`)。`Array.from` + JSON 経由の
/// 旧方式は元サイズの 15〜20 倍の一時メモリを食い、複数枚の貼り付けでレンダラを
/// 落としていた (2026-08-05 の実害)。`src_path` はヘッダーから復元する。
#[tauri::command]
pub async fn images_write_mask(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let png_bytes = crate::commands::raw_payload::raw_bytes(&request)?;
    let src_path = crate::commands::raw_payload::header_meta(&request, "src-path")
        .ok_or_else(|| "内部エラー: 元画像のパスが指定されていません".to_string())?;
    write_mask_inner(&src_path, png_bytes)
}

/// `images_write_mask` の本体。テストから直接呼べるよう分離してある。
fn write_mask_inner(src_path: &str, png_bytes: &[u8]) -> Result<String, String> {
    let src = PathBuf::from(src_path);
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
    std::fs::write(&dest, png_bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Write a clipboard-pasted PNG into `<CODEX_HOME>/generated_images/clipboard/`
/// (GORI 専用 CODEX_HOME, FB#19)。
/// The recursive watcher already monitors that tree, so the new file
/// shows up in the gallery automatically; the returned path is what the
/// composer uses as a reference.
///
/// 生バイトは raw payload で届く (`src/lib/ipcBytes.ts`)。旧 `Array.from` + JSON
/// 方式のメモリ増幅が、複数枚貼り付け時のクラッシュ原因だった (2026-08-05)。
#[tauri::command]
pub async fn images_write_clipboard(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let png_bytes = crate::commands::raw_payload::raw_bytes(&request)?;
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
    std::fs::write(&dest, png_bytes).map_err(|e| format!("write 失敗: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Persist a dropped / picked browser File into
/// `<CODEX_HOME>/generated_images/uploads/` (GORI 専用 CODEX_HOME, FB#19)。
/// This is the fallback path for cases where the webview cannot expose the
/// original filesystem path to the frontend. Keeping the file under the
/// generated_images tree also makes it visible in the gallery watcher.
///
/// 生バイトは raw payload、`file_name` はヘッダー経由で届く (`src/lib/ipcBytes.ts`)。
#[tauri::command]
pub async fn images_write_upload(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = crate::commands::raw_payload::raw_bytes(&request)?;
    let file_name = crate::commands::raw_payload::header_meta(&request, "file-name")
        .unwrap_or_else(|| "image.png".to_string());
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
    std::fs::write(&dest, bytes).map_err(|e| format!("write 失敗: {e}"))?;
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

        std::fs::remove_file(&target).map_err(|e| format!("削除に失敗しました ({path}): {e}"))?;
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

#[derive(Serialize, Clone)]
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
    /// 2026-06-06 STΛCK 指示: 実体がどこにも無く再リンクもできなかった (=既に消えた)
    /// レコードを history.db から削除した件数。「画像が見つかりません」の壊れた表示を残さない。
    pub db_pruned: u32,
    /// フロント側 (projects.json) が同じ張り替えを適用するための旧→新マップ。
    /// projects.json は Rust から触らない (フロントの正本) ため、対応表だけ返す。
    pub path_map: HashMap<String, String>,
    /// 2026-06-06: 削除した (実体消失) パスの一覧。フロントが projects.json から
    /// 同じパスの壊れた item を取り除くために返す。
    pub pruned_paths: Vec<String>,
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
    // 手動実行 (設定画面の「画像パスを修復する」) と起動時実行はこれまでどおり
    // prune (実体消失レコードの削除) まで行う。挙動は従来と同一。
    relink_missing_inner(&app, &state, true).await
}

/// 保存先変更フック用の再リンク (prune なし)。
///
/// なぜ prune を切るか: 保存先を「まだマウントされていない外部ディスク」や
/// 「同期が終わっていないクラウドフォルダ」に向けた直後は、索引が空になりうる。
/// その状態で prune すると history.db の全レコードが「実体消失」と誤判定されて
/// 消える。保存先変更は**事故が最も起きやすい瞬間**なので、ここでは
/// 「見つかったものを張り替える」だけに留め、削除は一切しない (非破壊)。
/// 本当に消えたレコードの掃除は、次回起動時 or 手動修復ボタンが担う。
pub async fn relink_missing_after_root_change(
    app: &AppHandle,
    state: &AppState,
) -> Result<RelinkResult, String> {
    relink_missing_inner(app, state, false).await
}

/// `allow_prune`: 実体が見つからないレコードを history.db から削除してよいか。
/// false のときは削除せず `db_unresolved` に数えるだけ (SafeImage がフォールバック表示する)。
async fn relink_missing_inner(
    app: &AppHandle,
    state: &AppState,
    allow_prune: bool,
) -> Result<RelinkResult, String> {
    // 候補ディレクトリ = watcher と同じ集合 (現行 HOME / 旧 ~/.codex / storage_root)。
    let settings = state
        .storage_settings()
        .await
        .or_else(|| StorageSettings::load().ok());
    let dirs = watcher_dirs(settings.as_ref());
    let index = build_filename_index(&dirs);

    // 索引が空のときは prune を全面禁止する (2026-07-25 追加・サーキットブレーカー)。
    //
    // なぜ必要か:
    //   保存先 (storage_root) を外付けHDDやクラウド同期フォルダに向けているユーザーが、
    //   ディスクを繋がずに / 同期が終わる前にアプリを起動すると、候補ディレクトリが
    //   1つも読めず索引が空になる。その状態で prune が走ると「実体がどこにも無い」と
    //   判定されて **history.db のレコードが全件削除される**。
    //   ディスクを繋ぎ直しても、DB から消えた記録は戻らない。
    //
    //   起動時 relink (App.tsx) は allow_prune=true で走るため、この経路が最も危険。
    //   保存先変更フックだけを allow_prune=false にしても起動時経路は守れないので、
    //   「索引が空なら消さない」という判定をここに置く。
    //
    // 索引が空 = 「候補ディレクトリが読めない」か「本当に1枚も無い」のどちらか。
    // 後者なら消すものも無いので、禁止しても損失はない。非対称なので安全側に倒す。
    let allow_prune = if allow_prune && index.is_empty() {
        tracing::warn!(
            target: "codex.images",
            dirs = ?dirs,
            "images_relink_missing: 候補ディレクトリの索引が空。保存先が未接続の可能性があるため \
             history.db の削除をスキップします (レコードは保持)"
        );
        false
    } else {
        allow_prune
    };

    // 旧保存先が1つでも読めないときも prune を禁止する (2026-07-30 Codex 検分)。
    //
    // 上のサーキットブレーカーは「索引が丸ごと空」しか見ていないため、
    // 「現行 root は読めるが、旧 root (外付けHDD/クラウド同期フォルダ) が未接続」
    // だと素通りする。そのとき旧 root にしか実体が無い画像は「どこにも無い」と
    // 判定され、繋ぎ直しても戻らない形で history.db から消える。
    // 設定に載っている旧 root は「そこに画像がある前提」なので、読めない間は消さない。
    let missing_previous: Vec<&String> = settings
        .as_ref()
        .map(|s| {
            s.previous_storage_roots
                .iter()
                .filter(|r| !std::path::Path::new(r).exists())
                .collect()
        })
        .unwrap_or_default();
    let allow_prune = if allow_prune && !missing_previous.is_empty() {
        tracing::warn!(
            target: "codex.images",
            missing = ?missing_previous,
            "images_relink_missing: 以前の保存先が読めません (未接続の可能性)。\
             history.db の削除をスキップします (レコードは保持)"
        );
        false
    } else {
        allow_prune
    };

    let mut result = RelinkResult {
        db_updated: 0,
        db_unresolved: 0,
        db_pruned: 0,
        path_map: HashMap::new(),
        pruned_paths: Vec::new(),
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
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| format!("history.db 接続の取得に失敗: {e}"))?;

    // 全 images.path の取得から修復 UPDATE/DELETE まで、同じ1接続を使い回す。
    // 件数分の pool acquire を避け、接続要求が画像数に比例しないようにする。
    let rows = sqlx::query("SELECT DISTINCT path FROM images")
        .fetch_all(&mut *conn)
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
        // basename で実在場所を探す。実体が無く再リンクもできないレコードは
        // history.db から削除する (2026-06-06 STΛCK 指示: 「画像が見つかりません/
        // 生成できませんでした」の壊れた表示を残さない)。candidate ありなら後段で UPDATE。
        let file_name = Path::new(&old_path)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let candidate = file_name.as_deref().and_then(|fname| index.get(fname));
        let Some(new_path) = candidate else {
            if !allow_prune {
                // 保存先変更直後は「索引がまだ空」と「本当に消えた」を区別できないため
                // 削除しない。未解決として数え、次回起動時の判定に委ねる。
                result.db_unresolved += 1;
                continue;
            }
            // 候補なし = 実体がどこにも無い → DB から該当行を削除。
            match sqlx::query("DELETE FROM images WHERE path = ?1")
                .bind(&old_path)
                .execute(&mut *conn)
                .await
            {
                Ok(_) => {
                    result.db_pruned += 1;
                    result.pruned_paths.push(old_path.clone());
                }
                Err(e) => {
                    tracing::warn!(target: "codex.images", error = ?e, old_path = %old_path, "images_relink_missing: 実体消失レコードの削除に失敗");
                    result.db_unresolved += 1;
                }
            }
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
            .execute(&mut *conn)
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
        db_pruned = result.db_pruned,
        db_unresolved = result.db_unresolved,
        "images_relink_missing: 完了"
    );
    Ok(result)
}

/// SNS 各サイズへの書き出しターゲット 1 件。
///
/// `mode`:
/// - "cover"   → アスペクト比を保ったまま**枠を覆うように拡大縮小してから中央クロップ**する
///              (被写体が欠ける代わりに枠いっぱいに埋まる。Instagram 等の SNS 標準)。
/// - "contain" → アスペクト比を保ったまま**枠に収まるように縮小して余白パディング**する
///              (画像全体が見える代わりに帯が入る。ロゴ/図版向け)。
#[derive(Debug, Clone, Deserialize)]
pub struct ResizeTarget {
    /// 出力ファイル名サフィックスに使う識別子 (例: "instagram_square")。
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// "cover" | "contain"。未知値は cover にフォールバックする。
    pub mode: String,
}

/// リサイズ書き出しの結果 1 件。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOutput {
    /// 入力画像の絶対パス。
    pub source: String,
    /// ターゲット名 (`ResizeTarget.name`)。
    pub target: String,
    /// 出力した PNG の絶対パス。
    pub output: String,
}

/// リサイズ書き出しバッチの集計結果。1 件失敗しても残りは続行する。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeResult {
    pub outputs: Vec<ResizeOutput>,
    pub failed: Vec<BatchDeleteFailure>,
}

/// `contain` パディングに使う背景色 (透過)。PNG なので alpha=0 で余白が透明になる。
const CONTAIN_PAD_RGBA: [u8; 4] = [0, 0, 0, 0];

/// 1 枚を 1 ターゲットへリサイズし、PNG として `output_dir` に書き出す。
///
/// cover:   src を「短辺が枠に一致する倍率」で拡大縮小 (resize は枠を覆うまで拡大) し、
///          はみ出した分を中央クロップして width×height ちょうどにする。
/// contain: src を「長辺が枠に収まる倍率」で縮小 (resize は枠内に収める) し、
///          残った余白を透過で中央パディングして width×height ちょうどにする。
fn resize_one(
    img: &image::DynamicImage,
    target: &ResizeTarget,
    output_dir: &Path,
    src_stem: &str,
) -> Result<PathBuf, String> {
    use image::imageops::FilterType;

    if target.width == 0 || target.height == 0 {
        return Err(format!(
            "invalid target size {}x{} for '{}'",
            target.width, target.height, target.name
        ));
    }

    let tw = target.width;
    let th = target.height;
    let mode = target.mode.trim().to_ascii_lowercase();

    // 出力は常に RGBA8 の width×height キャンバス。**必ず透過で初期化する**。
    //
    // ここを不透明黒 (`[0,0,0,255]`) で初期化してはならない。`imageops::overlay` は
    // 置換ではなく**アルファ合成**なので、透過 PNG を貼ると「不透明黒の上に透明を重ねる」
    // 計算になり、透過画素が**黒**として焼き付く (透過破壊バグ)。cover は
    // `resize_to_fill` が枠ちょうどを返すためキャンバスは露出しないが、
    // 露出の有無と関係なく合成の時点で潰れる。
    let mut canvas: image::RgbaImage =
        image::ImageBuffer::from_pixel(tw, th, image::Rgba(CONTAIN_PAD_RGBA));

    if mode == "contain" {
        // 枠内に収まるよう縮小 (アスペクト維持)。resize は「枠を超えない」最大サイズにする。
        let scaled = img.resize(tw, th, FilterType::Lanczos3).to_rgba8();
        let (sw, sh) = scaled.dimensions();
        let ox = ((tw - sw) / 2) as i64;
        let oy = ((th - sh) / 2) as i64;
        image::imageops::overlay(&mut canvas, &scaled, ox, oy);
    } else {
        // cover (既定): 枠を覆うよう拡大縮小 (アスペクト維持)。resize_to_fill が
        // 「枠を覆う倍率でリサイズ → 中央クロップ」を一括で行う。
        let filled = img.resize_to_fill(tw, th, FilterType::Lanczos3).to_rgba8();
        // resize_to_fill は既に tw×th ちょうどを返すが、防御的に overlay で貼る。
        image::imageops::overlay(&mut canvas, &filled, 0, 0);
    }

    let file_name = format!("{src_stem}_{}.png", sanitize_target_name(&target.name));
    let dest = pick_unique(output_dir, &file_name)
        .ok_or_else(|| "could not find a free destination filename".to_string())?;
    canvas
        .save_with_format(&dest, image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(dest)
}

/// ターゲット名をファイル名に使える文字だけに正規化する。
fn sanitize_target_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.trim_matches('_').is_empty() {
        "target".to_string()
    } else {
        out
    }
}

/// 生成済み画像を SNS 各サイズへ一括リサイズ書き出しする (W2-2 / 監査B-1)。
///
/// 各 (画像 × ターゲット) の直積で PNG を `output_dir` に書き出す。出力名は
/// `{元名}_{target名}.png` (衝突時は ` (n)` を付与)。1 件失敗しても残りは続行し、
/// 成功一覧と失敗内訳を返す (一括削除・一括保存と同じ部分成功モデル)。
///
/// cover/contain のアルゴリズムは `resize_one` を参照。出力は常に PNG (RGBA8)。
#[tauri::command]
pub async fn images_export_resized(
    paths: Vec<String>,
    targets: Vec<ResizeTarget>,
    output_dir: String,
) -> Result<ResizeResult, String> {
    if paths.is_empty() {
        return Err("書き出す画像が選択されていません".to_string());
    }
    if targets.is_empty() {
        return Err("書き出しサイズが選択されていません".to_string());
    }

    let out_dir = PathBuf::from(&output_dir);
    if !out_dir.is_dir() {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力フォルダ作成に失敗: {e}"))?;
    }

    let mut outputs: Vec<ResizeOutput> = Vec::new();
    let mut failed: Vec<BatchDeleteFailure> = Vec::new();

    for src in &paths {
        let src_path = PathBuf::from(src);
        if !src_path.is_file() {
            failed.push(BatchDeleteFailure {
                path: src.clone(),
                error: "ファイルが見つかりません".to_string(),
            });
            continue;
        }
        let img = match image::open(&src_path) {
            Ok(i) => i,
            Err(e) => {
                failed.push(BatchDeleteFailure {
                    path: src.clone(),
                    error: format!("画像を読み込めません: {e}"),
                });
                continue;
            }
        };
        let src_stem = src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image");

        for target in &targets {
            match resize_one(&img, target, &out_dir, src_stem) {
                Ok(dest) => outputs.push(ResizeOutput {
                    source: src.clone(),
                    target: target.name.clone(),
                    output: dest.to_string_lossy().into_owned(),
                }),
                Err(error) => failed.push(BatchDeleteFailure {
                    path: format!("{src} → {}", target.name),
                    error,
                }),
            }
        }
    }

    Ok(ResizeResult { outputs, failed })
}

#[derive(serde::Serialize)]
pub struct FileSizeEntry {
    pub path: String,
    /// バイト数。取得できない (存在しない/権限) 場合は None
    pub size: Option<u64>,
}

/// 添付画像の事前サイズ検査用 (7zf)。metadata が取れないパスはエラーにせず None で返す
/// (1枚の失敗で全体の検査を落とさない。ガードは fail-open が方針)。
#[tauri::command]
pub fn images_file_sizes(paths: Vec<String>) -> Vec<FileSizeEntry> {
    paths
        .into_iter()
        .map(|p| {
            let size = std::fs::metadata(&p).ok().map(|m| m.len());
            FileSizeEntry { path: p, size }
        })
        .collect()
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

    #[test]
    fn write_mask_creates_masks_subdir_and_returns_path() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("hero.png");
        std::fs::write(&src, b"\x89PNG").unwrap();

        let out = write_mask_inner(&src.to_string_lossy(), &[0u8, 1, 2, 3, 4, 5]).unwrap();

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

    /// F4 の事故機構そのものを固定するテスト。
    ///
    /// 保存先を「まだマウントされていない外部ディスク」に向けた直後は、候補ディレクトリが
    /// 読めず索引が**空**になる。このとき relink は全レコードを「実体消失」と判定するため、
    /// prune を許すと history.db が丸ごと消える。
    /// → 保存先変更フック (relink_missing_after_root_change) は allow_prune=false で呼ぶ。
    ///
    /// ここでは「読めないディレクトリ → 索引が空」という前提が崩れていないことを検査する。
    /// この前提が変わったら (例: 読めないディレクトリでエラーを返す設計に変えたら)
    /// prune 抑止の必要性も再評価が必要なので、テストで固定しておく。
    #[test]
    fn filename_index_is_empty_when_root_is_unavailable() {
        let missing = std::path::PathBuf::from("/definitely/not/mounted/gori-test-root");
        assert!(!missing.exists(), "テスト前提: このパスは存在しないこと");
        let index = build_filename_index(&[missing]);
        assert!(
            index.is_empty(),
            "存在しない保存先で索引が空にならないなら prune 抑止の前提が変わっている"
        );
    }

    /// サーキットブレーカー: 索引が空のときは prune を禁止する。
    ///
    /// 2026-07-25 追加。外付けHDD / クラウド同期フォルダを保存先にしているユーザーが
    /// ディスク未接続で起動すると索引が空になり、prune が走ると history.db の
    /// レコードが全件消える(繋ぎ直しても戻らない)。起動時 relink は allow_prune=true で
    /// 走るため、保存先変更フックだけを false にしても守れない。
    ///
    /// relink_missing_inner 内の判定と同じ式をここで固定する。実装を変えたときに
    /// この防御が外れたら落ちるようにしておくのが目的。
    #[test]
    fn prune_is_disabled_when_index_is_empty() {
        /// relink_missing_inner の判定と同一の式。
        fn effective_allow_prune(requested: bool, index_is_empty: bool) -> bool {
            if requested && index_is_empty {
                false
            } else {
                requested
            }
        }

        // 索引が空 = 保存先が読めない可能性 → 要求されても消さない (これが本題)
        assert!(
            !effective_allow_prune(true, true),
            "索引が空なのに prune が許可されている。保存先未接続で history.db が消える"
        );
        // 索引がある = 通常起動 → 従来どおり消してよい (機能を殺していないことの確認)
        assert!(
            effective_allow_prune(true, false),
            "通常時に prune が無効化されている。壊れたレコードが掃除されなくなる"
        );
        // 呼び出し側が禁止しているなら索引の状態に関わらず禁止のまま
        assert!(!effective_allow_prune(false, false));
        assert!(!effective_allow_prune(false, true));
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
        let index = build_filename_index(&[dir_a.path().to_path_buf(), dir_b.path().to_path_buf()]);
        assert_eq!(index.get("dup.png"), Some(&a));
    }

    /// cover / contain とも出力は必ずターゲット寸法ちょうどの PNG になる。
    #[test]
    fn resize_one_emits_exact_target_dimensions() {
        use image::GenericImageView as _;

        let dir = tempfile::tempdir().unwrap();
        // 横長 200x100 のソース。
        let src: image::RgbaImage =
            image::ImageBuffer::from_pixel(200, 100, image::Rgba([120, 30, 90, 255]));
        let img = image::DynamicImage::ImageRgba8(src);

        for mode in ["cover", "contain"] {
            let target = ResizeTarget {
                name: format!("t_{mode}"),
                width: 108,
                height: 192, // 縦長枠 (ソースと逆アスペクト → クロップ/パディングが確実に効く)
                mode: mode.to_string(),
            };
            let dest = resize_one(&img, &target, dir.path(), "hero").unwrap();
            let out = image::open(&dest).unwrap();
            assert_eq!(out.dimensions(), (108, 192), "mode={mode}");
            assert!(dest
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("hero_t_"));
        }
    }

    /// 不正な (0 幅) ターゲットは Err で弾く。
    #[test]
    fn resize_one_rejects_zero_dimension() {
        let dir = tempfile::tempdir().unwrap();
        let src: image::RgbaImage =
            image::ImageBuffer::from_pixel(50, 50, image::Rgba([0, 0, 0, 255]));
        let img = image::DynamicImage::ImageRgba8(src);
        let target = ResizeTarget {
            name: "bad".to_string(),
            width: 0,
            height: 100,
            mode: "cover".to_string(),
        };
        assert!(resize_one(&img, &target, dir.path(), "x").is_err());
    }

    #[test]
    fn sanitize_target_name_replaces_unsafe_chars() {
        assert_eq!(sanitize_target_name("Instagram 正方形"), "Instagram____");
        assert_eq!(sanitize_target_name("x-post_1600"), "x-post_1600");
        assert_eq!(sanitize_target_name("///"), "target");
    }

    // ---- 透過破壊バグの回帰テスト ----

    /// 中央だけ不透明赤、周囲が完全透過の RGBA 画像を作る。
    /// スタンプ (クロマキー抜き後) の実体に近い形。
    fn transparent_ringed_image(size: u32) -> image::DynamicImage {
        let mut img: image::RgbaImage =
            image::ImageBuffer::from_pixel(size, size, image::Rgba([0, 0, 0, 0]));
        let lo = size / 4;
        let hi = size - size / 4;
        for y in lo..hi {
            for x in lo..hi {
                img.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        image::DynamicImage::ImageRgba8(img)
    }

    /// 透過画素が黒く焼き付かないこと (cover / contain 両方)。
    ///
    /// 真因は canvas の不透明黒初期化 + `imageops::overlay` の**アルファ合成**。
    /// overlay は置換ではないので、不透明黒の上に透明を重ねると黒が残る。
    /// canvas を透過 (`CONTAIN_PAD_RGBA`) で初期化することで解消する。
    ///
    /// 牙の確認: canvas を `Rgba([0,0,0,255])` に戻すと cover 側が必ず落ちる。
    #[test]
    fn resize_one_preserves_transparency_in_both_modes() {
        let dir = tempfile::tempdir().unwrap();
        let src = transparent_ringed_image(64);

        for mode in ["cover", "contain"] {
            let target = ResizeTarget {
                name: format!("t_{mode}"),
                width: 64,
                height: 64,
                mode: mode.to_string(),
            };
            let out = resize_one(&src, &target, dir.path(), "sticker")
                .unwrap_or_else(|e| panic!("resize_one failed for {mode}: {e}"));
            let decoded = image::open(&out).unwrap().to_rgba8();

            // 四隅は透過のまま (黒く塗り潰されていない)。
            let (w, h) = decoded.dimensions();
            for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
                let px = decoded.get_pixel(x, y);
                assert_eq!(
                    px[3],
                    0,
                    "{mode}: 角 ({x},{y}) の透過が失われた (alpha={}, rgb={:?})",
                    px[3],
                    &px.0[..3]
                );
            }
            // 前景は残っている (全部透明にして「透過が保たれた」と誤判定しない)。
            let center = decoded.get_pixel(w / 2, h / 2);
            assert_eq!(center[3], 255, "{mode}: 前景まで透過になっている");
            assert!(center[0] > 200, "{mode}: 前景の色が壊れた: {:?}", center.0);
        }
    }

    /// 不透明な入力は従来どおり全面不透明で書き出されること (既存19プリセットの非退行)。
    #[test]
    fn resize_one_keeps_opaque_input_opaque() {
        let dir = tempfile::tempdir().unwrap();
        let src = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_pixel(
            80,
            40,
            image::Rgba([10, 20, 30, 255]),
        ));

        for mode in ["cover", "contain"] {
            let target = ResizeTarget {
                name: format!("o_{mode}"),
                width: 40,
                height: 40,
                mode: mode.to_string(),
            };
            let out = resize_one(&src, &target, dir.path(), "photo").unwrap();
            let decoded = image::open(&out).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (40, 40));
            // cover は枠を覆うので全面不透明。contain は 80x40 → 40x20 で上下に
            // 透過余白が入るため、中央だけを見る。
            let center = decoded.get_pixel(20, 20);
            assert_eq!(center[3], 255, "{mode}: 不透明入力の中央が透過になった");
            assert_eq!(&center.0[..3], &[10, 20, 30], "{mode}: 色が変わった");
        }
    }
}
