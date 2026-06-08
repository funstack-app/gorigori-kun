use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};

const CODEX_TEXT_TIMEOUT_SECS: u64 = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTextQueryResult {
    text: String,
    parsed_json: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn codex_text_query(
    prompt: String,
    system_prompt: Option<String>,
    expect_json: bool,
) -> Result<CodexTextQueryResult, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt must not be empty".into());
    }

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    let full_prompt = match system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(system) => format!("{system}\n\n{prompt}"),
        None => prompt.to_string(),
    };

    let mut cmd = Command::new(&codex_bin);
    // --full-auto を付ける。付けないと Windows でデフォルトサンドボックスが
    // codex-windows-sandbox-setup.exe を要求して「見つかりません」エラーになる
    // (画像生成 batch_gen と同じ問題)。--full-auto は workspace-write sandbox を
    // 選ぶため Windows で死ぬ。サンドボックス無効の bypass で回避(2026-06-09 修正)。
    cmd.args([
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--no-color",
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
            .write_all(full_prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
    }

    let output = timeout(
        Duration::from_secs(CODEX_TEXT_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("codex exec が {CODEX_TEXT_TIMEOUT_SECS} 秒でタイムアウトしました"))?
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

    let parsed_json = if expect_json {
        Some(
            extract_last_json(&stdout)
                .ok_or_else(|| "codex exec の応答から JSON を抽出できませんでした".to_string())?,
        )
    } else {
        None
    };

    Ok(CodexTextQueryResult {
        text: stdout,
        parsed_json,
    })
}

fn extract_last_json(text: &str) -> Option<serde_json::Value> {
    json_blocks(text)
        .into_iter()
        .rev()
        .find_map(|candidate| serde_json::from_str(candidate).ok())
}

fn json_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut start: Option<usize> = None;
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escape = false;

    for (idx, ch) in text.char_indices() {
        if start.is_none() {
            match ch {
                '{' => {
                    start = Some(idx);
                    stack.push('}');
                }
                '[' => {
                    start = Some(idx);
                    stack.push(']');
                }
                _ => {}
            }
            continue;
        }

        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.pop() != Some(ch) {
                    start = None;
                    stack.clear();
                    in_string = false;
                    escape = false;
                    continue;
                }
                if stack.is_empty() {
                    if let Some(s) = start.take() {
                        blocks.push(&text[s..idx + ch.len_utf8()]);
                    }
                }
            }
            _ => {}
        }
    }

    blocks
}
