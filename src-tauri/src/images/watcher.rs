use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::events::EVENT_IMAGE_GENERATED;

/// Payload emitted on every supported image/video we observe under the legacy
/// Codex generated-images directory and the configured local storage root.
#[derive(Debug, Clone, Serialize)]
pub struct ImageEvent {
    pub path: String,
    pub name: String,
    /// Parent directory name — usually a thread or turn id chosen by codex.
    pub bucket: String,
    /// Unix epoch milliseconds (file mtime).
    pub mtime_ms: i64,
    pub size: u64,
    /// "initial" for files discovered on startup, "created" for fs events.
    pub kind: &'static str,
}

/// `image_gen` ツールが画像を書き出す `$CODEX_HOME/generated_images/`。
///
/// FB#19 対応で CODEX_HOME を GORI 専用 HOME に切り替えたため、ここも専用 HOME
/// 配下に統一する。app-server に渡す CODEX_HOME とこの参照先がズレると、
/// 生成画像がギャラリーに出てこなくなる (Codex 警告の核心)。
///
/// 専用 HOME が解決できない (data_dir 取得失敗) 場合のみ、従来の
/// `~/.codex/generated_images` にフォールバックする。
pub fn generated_images_dir() -> Option<PathBuf> {
    crate::codex::home::gori_codex_home_path()
        .or_else(legacy_generated_images_parent)
        .map(|home| home.join("generated_images"))
}

/// 旧 ambient `~/.codex` (移行元)。watcher のレガシー画像参照に使う。
/// **削除・変更しない。読み取り専用。**
fn legacy_generated_images_parent() -> Option<PathBuf> {
    crate::codex::home::legacy_codex_home()
}

/// 旧 `~/.codex/generated_images/`。専用 HOME に切り替える前に生成された
/// 過去画像がここに残っている可能性があるので、watcher は読み取り専用で
/// このディレクトリも監視対象に含める (消さない)。
pub fn legacy_generated_images_dir() -> Option<PathBuf> {
    legacy_generated_images_parent().map(|home| home.join("generated_images"))
}

fn is_supported_media(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase),
        Some(ref ext)
            if ext == "png"
                || ext == "jpg"
                || ext == "jpeg"
                || ext == "webp"
                || ext == "mp4"
                || ext == "mov"
                || ext == "m4v"
                || ext == "webm"
    )
}

/// Mask PNGs (written alongside source images by `images_write_mask`) live
/// inside hidden `.masks/` dirs. The gallery should pretend they don't exist.
fn is_in_masks_dir(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s == ".masks")
            .unwrap_or(false)
    })
}

/// 編集途中版の専用作業場は、起動時走査・リアルタイム監視のどちらでも無視する。
/// ファイル自体は版レールが絶対パスで使うため残し、ライブラリの索引だけに載せない。
fn is_in_edit_session_dir(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| name == "edit-session")
            .unwrap_or(false)
    })
}

fn payload(path: &Path, kind: &'static str) -> Option<ImageEvent> {
    // 呼び出し側の走査ガードが将来変わっても、イベント生成の最後の入口で止める。
    if is_in_edit_session_dir(path) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let bucket = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Some(ImageEvent {
        path: path.to_string_lossy().into_owned(),
        name,
        bucket,
        mtime_ms,
        size: meta.len(),
        kind,
    })
}

/// Walk `dir` and emit one event per existing supported image/video, sorted by
/// mtime ascending so the gallery loads chronologically.
pub fn scan_existing(app: &AppHandle, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut media = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if p.file_name().and_then(|s| s.to_str()) == Some(".masks") {
                continue;
            }
            if p.file_name().and_then(|s| s.to_str()) == Some("edit-session") {
                continue;
            }
            collect_media_recursive(&p, &mut media);
        } else if is_supported_media(&p) {
            media.push(p);
        }
    }
    // sort oldest → newest by mtime
    media.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0)
    });
    for p in media {
        if let Some(ev) = payload(&p, "initial") {
            let _ = app.emit(EVENT_IMAGE_GENERATED, ev);
        }
    }
}

fn collect_media_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        // Skip symlinks: avoids infinite loops if user symlinks into the dir.
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if p.file_name().and_then(|s| s.to_str()) == Some(".masks") {
                continue;
            }
            if p.file_name().and_then(|s| s.to_str()) == Some("edit-session") {
                continue;
            }
            collect_media_recursive(&p, out);
        } else if ft.is_file() && is_supported_media(&p) {
            out.push(p);
        }
    }
}

/// Spin up a debounced recursive watcher. Caller keeps the returned debouncer
/// alive — drop it to stop watching.
pub fn start_watcher(
    app: AppHandle,
    dirs: Vec<PathBuf>,
) -> notify::Result<Debouncer<notify::RecommendedWatcher, FileIdMap>> {
    for dir in &dirs {
        if !dir.exists() {
            std::fs::create_dir_all(dir).ok();
        }
    }

    let app_for_cb = app.clone();
    // 800ms gives large PNG writes (multi-MB) time to settle before we
    // surface the file; otherwise the metadata().len() snapshot might still
    // be the partial size.
    let mut debouncer = new_debouncer(
        Duration::from_millis(800),
        None,
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                for ev in events {
                    for p in &ev.event.paths {
                        if !is_supported_media(p) {
                            continue;
                        }
                        if is_in_masks_dir(p) {
                            continue;
                        }
                        if is_in_edit_session_dir(p) {
                            continue;
                        }
                        // CREATE / MODIFY only. REMOVE is deliberately not picked up:
                        // `save_to_project` moves files with `std::fs::rename`
                        // (images.rs), which reaches the watcher as a REMOVE from the
                        // watched directory. Acting on it would mistake "moved into a
                        // project" for "deleted from the gallery" and drop the item the
                        // frontend just re-pointed at the new path. External deletions
                        // are handled by SafeImage's "image not found" placeholder and
                        // by Settings → "画像パスを修復する" (images_relink_missing).
                        use notify::EventKind;
                        let is_create_or_modify =
                            matches!(ev.event.kind, EventKind::Create(_) | EventKind::Modify(_));
                        if !is_create_or_modify {
                            continue;
                        }
                        if let Some(payload) = payload(p, "created") {
                            let _ = app_for_cb.emit(EVENT_IMAGE_GENERATED, payload);
                        }
                    }
                }
            }
            Err(errs) => {
                for err in errs {
                    tracing::warn!(target: "codex.watcher", "watch error: {err}");
                }
            }
        },
    )?;

    for dir in &dirs {
        debouncer.watcher().watch(dir, RecursiveMode::Recursive)?;
        tracing::info!(target: "codex.watcher", "watching {}", dir.display());
    }
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::{is_in_edit_session_dir, is_in_masks_dir, is_supported_media, payload};
    use std::path::Path;

    #[test]
    fn watcher_accepts_gallery_images_and_supported_videos() {
        for path in [
            "image.png",
            "image.JPG",
            "image.webp",
            "movie.mp4",
            "movie.MOV",
            "movie.m4v",
            "movie.webm",
        ] {
            assert!(is_supported_media(Path::new(path)), "未対応扱い: {path}");
        }
    }

    #[test]
    fn watcher_rejects_unsupported_or_unrelated_files() {
        for path in ["movie.avi", "movie.mkv", "notes.txt", "no-extension"] {
            assert!(
                !is_supported_media(Path::new(path)),
                "誤って対応扱い: {path}"
            );
        }
    }

    #[test]
    fn watcher_still_excludes_hidden_masks() {
        assert!(is_in_masks_dir(Path::new("/gallery/.masks/edit.png")));
        assert!(!is_in_masks_dir(Path::new("/gallery/movie.mp4")));
    }

    #[test]
    fn watcher_excludes_edit_session_at_any_nested_depth() {
        assert!(is_in_edit_session_dir(Path::new(
            "/generated_images/edit-session/ig_edit.png"
        )));
        assert!(is_in_edit_session_dir(Path::new(
            "/generated_images/edit-session/batch-1/ig_b01.png"
        )));
        assert!(!is_in_edit_session_dir(Path::new(
            "/generated_images/ig_edit_saved.png"
        )));
    }

    #[test]
    fn payload_hides_intermediate_version_but_accepts_library_copy() {
        let root = tempfile::tempdir().unwrap();
        let edit_dir = root.path().join("edit-session");
        std::fs::create_dir_all(&edit_dir).unwrap();
        let intermediate = edit_dir.join("current.png");
        let library_copy = root.path().join("saved.png");
        std::fs::write(&intermediate, b"intermediate").unwrap();
        std::fs::write(&library_copy, b"saved").unwrap();

        assert!(payload(&intermediate, "created").is_none());
        assert!(payload(&library_copy, "created").is_some());
    }
}
