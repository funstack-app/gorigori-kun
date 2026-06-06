use std::path::{Path, PathBuf};
use std::process::Command;

#[tauri::command]
pub async fn layer_splitter_run(
    input_path: String,
    preset: String,
    custom_prompts: Option<Vec<String>>,
    output_path: Option<String>,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.is_file() {
        return Err(format!("入力画像が見つかりません: {input_path}"));
    }

    let preset = preset.trim().to_ascii_lowercase();
    if !matches!(preset.as_str(), "portrait" | "illustration" | "general") {
        return Err(format!("未対応のプリセットです: {preset}"));
    }

    let splitter_dir = resolve_splitter_dir()?;
    let python = splitter_dir.join("venv/bin/python");
    if !python.is_file() {
        return Err(format!(
            "Layer Splitter のセットアップ未完了です。{} で ./setup.sh を実行してください。",
            splitter_dir.display()
        ));
    }

    let script = splitter_dir.join("splitter.py");
    if !script.is_file() {
        return Err(format!(
            "splitter.py が見つかりません: {}",
            script.display()
        ));
    }

    let output = match output_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => default_output_path(&input)?,
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("出力ディレクトリの作成に失敗: {e}"))?;
    }

    let prompts = custom_prompts
        .unwrap_or_default()
        .into_iter()
        .map(|prompt| prompt.trim().to_string())
        .filter(|prompt| !prompt.is_empty())
        .collect::<Vec<_>>();

    let mut command = Command::new(&python);
    command
        .current_dir(&splitter_dir)
        .arg(&script)
        .arg("split")
        .arg(&input)
        .arg("--preset")
        .arg(&preset)
        .arg("--output")
        .arg(&output);

    if !prompts.is_empty() {
        for prompt in &prompts {
            command.arg("--prompts").arg(prompt);
        }
    }

    let result = command.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Python が見つかりません: {}", python.display())
        } else {
            format!("Layer Splitter の実行に失敗: {e}")
        }
    })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Layer Splitter が失敗しました: {}", result.status)
        } else {
            detail.to_string()
        });
    }

    Ok(output.to_string_lossy().into_owned())
}

fn resolve_splitter_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../../../extensions/layer-splitter"),
        manifest_dir.join("../../extensions/layer-splitter"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("splitter.py").is_file())
        .map(normalize_path)
        .ok_or_else(|| {
            "extensions/layer-splitter が見つかりません。Layer Splitter の配置を確認してください。"
                .to_string()
        })
}

fn default_output_path(input: &Path) -> Result<PathBuf, String> {
    // FB#19: 生成画像と同じ GORI 専用 CODEX_HOME/generated_images 配下に出す
    // (watcher が見えるディレクトリに統一)。
    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    Ok(base
        .join("_layers")
        .join(format!("{stem}_layered.psd")))
}

fn normalize_path(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}
