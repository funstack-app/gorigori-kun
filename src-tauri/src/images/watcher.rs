use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::events::EVENT_IMAGE_GENERATED;

/// Payload emitted on every new image we observe under the legacy Codex
/// generated-images directory and the configured local storage root.
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

pub fn generated_images_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".codex").join("generated_images"))
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase),
        Some(ref ext) if ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "webp"
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

fn payload(path: &Path, kind: &'static str) -> Option<ImageEvent> {
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

/// Walk `dir` and emit one event per existing image, sorted by mtime ascending
/// so the gallery loads chronologically.
pub fn scan_existing(app: &AppHandle, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut images = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if p.file_name().and_then(|s| s.to_str()) == Some(".masks") {
                continue;
            }
            collect_images_recursive(&p, &mut images);
        } else if is_image(&p) {
            images.push(p);
        }
    }
    // sort oldest → newest by mtime
    images.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0)
    });
    for p in images {
        if let Some(ev) = payload(&p, "initial") {
            let _ = app.emit(EVENT_IMAGE_GENERATED, ev);
        }
    }
}

fn collect_images_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
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
            collect_images_recursive(&p, out);
        } else if ft.is_file() && is_image(&p) {
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
                        if !is_image(p) {
                            continue;
                        }
                        if is_in_masks_dir(p) {
                            continue;
                        }
                        // CREATE / MODIFY only (REMOVE is ignored — gallery handles
                        // deletion via direct project moves)
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
