use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Codex app-server の stderr を、起動失敗時にユーザーに見せるためバッファする。
/// メモリ暴走を防ぐため最新 200 行までに制限。
#[derive(Clone, Default)]
pub struct StderrBuffer {
    inner: Arc<Mutex<Vec<String>>>,
}

impl StderrBuffer {
    pub fn push(&self, line: String) {
        if let Ok(mut buf) = self.inner.lock() {
            if buf.len() >= 200 {
                buf.remove(0);
            }
            buf.push(line);
        }
    }
    pub fn snapshot(&self) -> Vec<String> {
        self.inner.lock().ok().map(|b| b.clone()).unwrap_or_default()
    }
}

const FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
];

/// macOS の Finder / launchd 起動では shell の dotfiles が読まれず PATH が
/// `/usr/bin:/bin:/usr/sbin:/sbin` だけになる。これだと Homebrew や nvm /
/// mise / volta / npm prefix 配下にいる codex が見つからない。login shell
/// から $PATH を取り出して補強する。
fn login_shell_path() -> Option<String> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
    let out = std::process::Command::new(&shell)
        .arg("-lic")
        .arg("printf %s \"$PATH\"")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 現プロセスの PATH を login shell の値とマージする (順序保持・重複排除)。
///
/// macOS の Finder / launchd 起動された .app には dotfiles 由来の PATH が
/// 載らないので、`codex` (Node.js shebang) や `swift` 等を spawn する全箇所で
/// `Command::env("PATH", enriched_path())` を呼ぶこと。
pub fn enriched_path() -> OsString {
    let mut seen: HashSet<String> = HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for src in [std::env::var("PATH").ok(), login_shell_path()]
        .into_iter()
        .flatten()
    {
        for p in src.split(':') {
            if !p.is_empty() && seen.insert(p.to_string()) {
                parts.push(p.to_string());
            }
        }
    }
    OsString::from(parts.join(":"))
}

pub fn resolve_codex_binary(override_path: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = override_path {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
        return Err(anyhow!(
            "codex binary not found at override path: {}",
            p.display()
        ));
    }

    // ① アプリと同じディレクトリに同梱された codex バイナリを最優先 (Windows配布対策)
    // STΛCK 指示 (2026-05-15): Windows ユーザーが PATH 設定しなくても動くように、
    // アプリ exe と同階層の codex.exe / codex を自動検出する。
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = if cfg!(windows) {
                vec!["codex.exe", "codex-app-server.exe"]
            } else {
                vec!["codex", "codex-app-server"]
            };
            for name in candidates {
                let cand = exe_dir.join(name);
                if cand.is_file() {
                    return Ok(cand);
                }
            }
            // Tauri bundle 内の resources ディレクトリも見る (macOS .app, Windows install dir)
            for rel in ["resources", "../Resources"] {
                let res_dir = exe_dir.join(rel);
                for name in if cfg!(windows) {
                    vec!["codex.exe"]
                } else {
                    vec!["codex"]
                } {
                    let cand = res_dir.join(name);
                    if cand.is_file() {
                        return Ok(cand);
                    }
                }
            }
        }
    }

    let path = enriched_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if let Ok(p) = which::which_in(OsStr::new("codex"), Some(&path), &cwd) {
        return Ok(p);
    }

    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".bun/bin/codex",
            ".cargo/bin/codex",
            ".volta/bin/codex",
            ".npm-global/bin/codex",
            "Library/pnpm/codex",
        ] {
            let cand = home.join(rel);
            if cand.is_file() {
                return Ok(cand);
            }
        }

        for prefix in [".nvm/versions/node", ".local/share/mise/installs/node"] {
            let dir = home.join(prefix);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let cand = entry.path().join("bin/codex");
                    if cand.is_file() {
                        return Ok(cand);
                    }
                }
            }
        }
    }

    for p in FALLBACK_PATHS {
        let cand = PathBuf::from(p);
        if cand.is_file() {
            return Ok(cand);
        }
    }

    // 全部見つからなかった: ユーザーが見て切り分けできるよう、どこを探したかを全て載せる
    let mut searched: Vec<String> = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            searched.push(format!("アプリと同階層: {}", exe_dir.display()));
            searched.push(format!(
                "アプリ同階層の resources: {}",
                exe_dir.join("resources").display()
            ));
            searched.push(format!(
                "アプリ同階層の ../Resources: {}",
                exe_dir.join("../Resources").display()
            ));
        }
    }
    searched.push(format!("PATH 環境変数: {:?}", enriched_path()));
    if let Some(home) = dirs::home_dir() {
        searched.push(format!("ホーム配下: {}", home.display()));
    }
    for p in FALLBACK_PATHS {
        searched.push(format!("FALLBACK: {p}"));
    }

    Err(anyhow!(
        "codex バイナリが見つかりませんでした\n\
         OS: {} / {}\n\
         探した場所:\n  - {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        searched.join("\n  - ")
    ))
}

pub struct AppServerProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr_buf: StderrBuffer,
}

pub async fn spawn_app_server(bin: &Path) -> Result<AppServerProcess> {
    let mut cmd = Command::new(bin);
    cmd.arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", enriched_path());

    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Codex バイナリの起動に失敗しました\n\
             コマンド: {} app-server --listen stdio://\n\
             OS: {} / {}\n\
             バイナリパス: {}\n\
             バイナリ存在: {}",
            bin.display(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            bin.display(),
            bin.is_file()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("child stdin not captured"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("child stdout not captured"))?;

    let stderr_buf = StderrBuffer::default();
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_logger(stderr, stderr_buf.clone());
    }

    Ok(AppServerProcess {
        child,
        stdin,
        stdout,
        stderr_buf,
    })
}

fn spawn_stderr_logger(stderr: tokio::process::ChildStderr, buf: StderrBuffer) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!(target: "codex.stderr", "{}", line);
            buf.push(line);
        }
    });
}
