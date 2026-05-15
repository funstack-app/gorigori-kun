use super::{is_model_installed, validate_image_path, SegmentationModel, SegmentationResult};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub fn run_segmentation(
    app: &AppHandle,
    model: SegmentationModel,
    image_path: impl AsRef<Path>,
) -> Result<SegmentationResult, String> {
    let image_path = image_path.as_ref();
    validate_image_path(image_path)?;

    if !is_model_installed(model) {
        return Err(format!(
            "{} の準備ができていません。先にモデルをダウンロードしてください。",
            model.display_name()
        ));
    }

    let output_dir = output_dir_for(app, model)?;
    fs::create_dir_all(&output_dir).map_err(|err| err.to_string())?;

    run_python_segmenter(image_path, &output_dir, model)?;

    let foreground_path = output_dir.join("foreground.png");
    let background_path = output_dir.join("background.png");
    let mask_path = output_dir.join("mask.png");
    ensure_output_exists(&foreground_path)?;
    ensure_output_exists(&background_path)?;
    ensure_output_exists(&mask_path)?;

    Ok(SegmentationResult {
        foreground_path: foreground_path.display().to_string(),
        background_path: background_path.display().to_string(),
        mask_path: mask_path.display().to_string(),
    })
}

fn run_python_segmenter(
    image_path: &Path,
    output_dir: &Path,
    model: SegmentationModel,
) -> Result<(), String> {
    let model_arg = match model {
        SegmentationModel::U2Net => "u2net",
        SegmentationModel::U2NetP => "u2netp",
        SegmentationModel::MobileSAM | SegmentationModel::Sam3 => {
            return Err(format!(
                "{} はこの分解実行ではまだ利用できません。",
                model.display_name()
            ))
        }
    };

    let scripts_dir = scripts_dir()?;
    let script_path = scripts_dir.join("run_single.py");
    if !script_path.is_file() {
        return Err(format!(
            "分解スクリプトが見つかりません: {}",
            script_path.display()
        ));
    }

    let python_bin = resolve_python(&scripts_dir);
    let output = Command::new(&python_bin)
        .arg(&script_path)
        .arg("--image")
        .arg(image_path)
        .arg("--model")
        .arg(model_arg)
        .arg("--output-dir")
        .arg(output_dir)
        .env("PYTHONPATH", python_path_with(&scripts_dir)?)
        .output()
        .map_err(|err| {
            format!(
                "python の起動に失敗: {err} (使用 python: {})",
                python_bin.display()
            )
        })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.is_empty() {
            Err(format!("分解処理が失敗しました: {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

fn output_dir_for(app: &AppHandle, model: SegmentationModel) -> Result<PathBuf, String> {
    let session_id = session_id();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("app_data_dir を解決できませんでした: {err}"))?;
    Ok(app_data_dir
        .join("segmentation_results")
        .join(session_id)
        .join(model.key()))
}

fn session_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

fn scripts_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let scripts_dir = manifest_dir
        .join("../../..")
        .join("extensions/layer-splitter/scripts")
        .canonicalize()
        .map_err(|err| format!("分解スクリプトの場所を解決できませんでした: {err}"))?;
    Ok(scripts_dir)
}

/// Why: extensions/layer-splitter/scripts/.venv 配下に依存（rembg / onnxruntime 等）が
/// インストールされている前提のため、その python を絶対パスで優先する。
/// 見つからなければ system PATH の `python3` にフォールバック。
/// venv が壊れている／別 OS で命名規則が違う場合に備えて、
/// POSIX (`bin/python3`) と Windows (`Scripts/python.exe`) の両方を確認する。
fn resolve_python(scripts_dir: &Path) -> PathBuf {
    let venv_root = scripts_dir.join(".venv");
    let candidates = [
        venv_root.join("bin").join("python3"),
        venv_root.join("bin").join("python"),
        venv_root.join("Scripts").join("python.exe"),
        venv_root.join("Scripts").join("python3.exe"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return candidate.clone();
        }
    }
    PathBuf::from("python3")
}

fn python_path_with(scripts_dir: &Path) -> Result<OsString, String> {
    let paths = std::iter::once(scripts_dir.to_path_buf()).chain(
        std::env::var_os("PYTHONPATH")
            .into_iter()
            .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>()),
    );
    std::env::join_paths(paths).map_err(|err| err.to_string())
}

fn ensure_output_exists(path: &Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("分解結果が見つかりません: {}", path.display()))
    }
}
