use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn layer_splitter_run(
    app: AppHandle,
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

    let splitter_dir = resolve_splitter_dir(&app)?;
    let python = resolve_venv_python(&splitter_dir).ok_or_else(|| {
        "Layer Splitter のセットアップが未完了です（Python 環境が見つかりません）。\
         設定 > 拡張機能 からセットアップしてください。"
            .to_string()
    })?;

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

    // HuggingFace のオフライン化 + キャッシュを app_data_dir 配下へ隔離する。
    // なぜ: 実機で `PermissionError: ~/.cache/huggingface/token Operation not permitted` が
    // 発生した。配布アプリのサンドボックスから `~/.cache` へ書けないため、HF_HOME を専用
    // ディレクトリに向け、HF_HUB_OFFLINE でトークン/リモートアクセスを一切試みさせない
    // (モデルは venv セットアップ時に同梱済みの前提)。
    let hf_home = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("hf-cache"))
        .unwrap_or_else(|_| splitter_dir.join("hf-cache"));
    let _ = std::fs::create_dir_all(&hf_home);

    let mut command = Command::new(&python);
    command
        .current_dir(&splitter_dir)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HOME", &hf_home)
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
            format!("レイヤー分解の実行に失敗しました: {e}")
        }
    })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        // Python の traceback 全文はフロントへ返さない (ユーザーには意味不明で、内部パス等が
        // 漏れる)。全文は tracing::error でログに残し、フロントには最終行 (例外名 + メッセージ)
        // だけを日本語エラーに包んで返す。
        tracing::error!(
            target: "codex.edit.layer_splitter",
            "layer splitter failed: status={} stderr=\n{}",
            result.status, detail
        );
        let last_line = detail
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim();
        return Err(if last_line.is_empty() {
            format!("レイヤー分解の実行に失敗しました: {}", result.status)
        } else {
            format!("レイヤー分解の実行に失敗しました: {last_line}")
        });
    }

    Ok(output.to_string_lossy().into_owned())
}

/// 解決優先順:
/// 1. GORI_LAYER_SPLITTER_DIR 環境変数（検証・上級者向けの明示 override）
/// 2. app_data_dir()/extensions/layer-splitter（配布版の正本。将来のセットアップ機能の展開先）
/// 3. debug ビルド限定: リポジトリ相対（dev 体験の維持。release バイナリには
///    cfg(debug_assertions) でコンパイルされないため、ビルドマシンのパスが焼き込まれない）
fn resolve_splitter_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let has_entry = |dir: &Path| dir.join("splitter.py").is_file();

    if let Some(dir) = std::env::var_os("GORI_LAYER_SPLITTER_DIR").map(PathBuf::from) {
        if has_entry(&dir) {
            return Ok(normalize_path(dir));
        }
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        let dir = data_dir.join("extensions").join("layer-splitter");
        if has_entry(&dir) {
            return Ok(normalize_path(dir));
        }
    }

    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for candidate in [
            manifest_dir.join("../../../extensions/layer-splitter"),
            manifest_dir.join("../../extensions/layer-splitter"),
        ] {
            if has_entry(&candidate) {
                return Ok(normalize_path(candidate));
            }
        }
    }

    Err(
        "Layer Splitter が未インストールです。設定 > 拡張機能 からセットアップしてください。"
            .to_string(),
    )
}

/// venv の python を OS 差込みで解決（削除済み runner.rs の resolve_python と同型）。
fn resolve_venv_python(splitter_dir: &Path) -> Option<PathBuf> {
    let venv = splitter_dir.join("venv");
    [
        venv.join("bin").join("python"),
        venv.join("bin").join("python3"),
        venv.join("Scripts").join("python.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
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
