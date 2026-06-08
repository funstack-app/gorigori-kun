use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};

const CODEX_VISION_TIMEOUT_SECS: u64 = 120;
const VISION_MODEL: &str = "gpt-5.5";
const VISION_EFFORT: &str = "low";

#[tauri::command]
pub async fn codex_describe_image(image_path: String) -> Result<String, String> {
    let image_path = image_path.trim();
    if image_path.is_empty() {
        return Err("image_path must not be empty".to_string());
    }
    let path = Path::new(image_path);
    if !path.is_file() {
        return Err("画像ファイルが見つかりません".to_string());
    }

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    let prompt = [
        "添付画像を解析し、この画像をAI画像生成で再現するための英語プロンプトを1行で書いてください。",
        "被写体、構図、レンズ感、照明、色調、質感、背景を具体的に含めること。",
        "説明、箇条書き、前置き、引用符、Markdown は不要。プロンプト本文だけを返してください。",
    ]
    .join("\n");

    // Codex CLI の正規フラグ:
    //   --skip-git-repo-check : リポジトリ外でも実行可
    //   --color never         : ANSI カラー出力を無効化 (--no-color は存在しない)
    //   -c key=value          : config 上書き
    //   -i, --image <FILE>    : 画像添付
    //   PROMPT は省略すると stdin から読む (末尾の `-` は不要)
    let model_arg = format!("model={VISION_MODEL}");
    let effort_arg = format!("model_reasoning_effort={VISION_EFFORT}");
    let mut cmd = Command::new(&codex_bin);
    cmd.args([
        "exec",
        // Windows でデフォルト/workspace-write サンドボックスが
        // codex-windows-sandbox-setup.exe を要求して落ちる。参照画像→プロンプト
        // 変換は画像生成の前段で走るため、ここが落ちると生成も巻き添えで失敗する。
        // サンドボックス無効の bypass で回避(2026-06-09 Windows修正。--full-auto
        // では workspace-write になり直らなかった)。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &model_arg,
        "-c",
        &effort_arg,
        "-i",
        image_path,
    ])
    .env("PATH", enriched_path())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::codex::process::no_window_flag(&mut cmd);
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
    }

    let output = timeout(
        Duration::from_secs(CODEX_VISION_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("codex exec が {CODEX_VISION_TIMEOUT_SECS} 秒でタイムアウトしました"))?
    .map_err(|e| format!("codex exec 待機失敗: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("(stderr 出力なし)");
        return Err(format!(
            "codex exec が異常終了 (code={:?}): {detail}",
            output.status.code()
        ));
    }

    let description = clean_codex_output(&stdout);
    if description.is_empty() {
        return Err("Codex Vision の応答が空でした".to_string());
    }
    Ok(description)
}

fn clean_codex_output(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`'))
        .trim()
        .to_string()
}
