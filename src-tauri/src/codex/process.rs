use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Windows で `Command::spawn()` するときデフォルトで黒い console window が
/// 一瞬出てしまう。これを抑制するためのヘルパー。tokio / std どちらの
/// Command にも `creation_flags(CREATE_NO_WINDOW)` を設定する。
///
/// CREATE_NO_WINDOW = 0x08000000 (winbase.h より)
///
/// macOS / Linux では no-op。
#[cfg(windows)]
pub fn no_window_flag(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn no_window_flag(cmd: &mut Command) -> &mut Command {
    cmd
}

/// std::process::Command 用の同等ヘルパー。
#[cfg(windows)]
pub fn no_window_flag_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn no_window_flag_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

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

/// 画像生成バッチ用に **codex CLI (codex exec を取れるバイナリ)** を解決する。
///
/// Codex の v0.131+ には 2 種類のバイナリがある:
///   - codex (codex.exe): CLI ランチャー。`codex exec ...` で画像生成等を実行できる
///   - codex-app-server (codex-app-server.exe): JSON-RPC stdio サーバー。
///     `exec` サブコマンドは持たない (内部で app-server プロトコルを喋るだけ)。
///
/// resolve_codex_binary は app-server を最優先で返すので、画像生成バッチで
/// それを使うと `codex-app-server exec ...` になって即失敗する (Codex 指摘
/// 2026-05-17)。バッチでは必ずこちらを使う。
pub fn resolve_codex_cli_binary() -> Result<PathBuf> {
    // ① アプリと同階層 / resources の codex(.exe) を最優先
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let cli_bin = if cfg!(windows) { "codex.exe" } else { "codex" };
            // アプリ exe 同階層
            let cand = exe_dir.join(cli_bin);
            if cand.is_file() {
                return Ok(cand);
            }
            // bundle resources
            // STΛCK 報告 (v0.6.16): Tauri は tauri.conf.json の bundle.resources
            // 配列のパスを「そのまま保持して」 Contents/Resources/ 配下に置く。
            // つまり "resources/codex" を指定すると
            //   Contents/Resources/resources/codex
            // に配置される (Contents/Resources/codex ではない)。
            // Mac で codex バイナリが見つからない真の原因はここ。
            for rel in [
                "resources",            // exe_dir(=MacOS)/resources/ ← 古いパス、未使用
                "../Resources",         // Contents/Resources/        ← 旧期待先(空)
                "../Resources/resources", // Contents/Resources/resources/ ← 実際の配置
            ] {
                let cand = exe_dir.join(rel).join(cli_bin);
                if cand.is_file() {
                    return Ok(cand);
                }
            }
        }
    }

    // ② PATH 上の codex
    let path = enriched_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if let Ok(p) = which::which_in(OsStr::new("codex"), Some(&path), &cwd) {
        return Ok(p);
    }

    // ③ ホーム配下の代表的な install 先
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

    Err(anyhow!(
        "Codex CLI (codex exec を実行できるバイナリ) が見つかりませんでした\n\
         画像生成バッチには app-server ではなく `codex exec` が必要です。\n\
         OS: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
    ))
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

    // ① アプリと同じディレクトリに同梱された codex-app-server バイナリを最優先
    // STΛCK 指示 (2026-05-15): Windows ユーザーが Node.js なしで動くように、
    // ネイティブな codex-app-server.exe を直接起動する。
    // codex.exe は Node.js ラッパーなので使わない (Windows で Node 必須になってしまう)。
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // app-server 用のネイティブバイナリ名 (Node.js ラッパーは含めない)
            let server_bin = if cfg!(windows) {
                "codex-app-server.exe"
            } else {
                "codex-app-server"
            };
            // アプリ exe 同階層
            let cand = exe_dir.join(server_bin);
            if cand.is_file() {
                return Ok(cand);
            }
            // Tauri bundle 内 resources ディレクトリ。
            // v0.6.16: Tauri は bundle.resources の "resources/codex-app-server" を
            // Contents/Resources/resources/codex-app-server に配置するため、
            // ../Resources/resources も探索対象に加える。
            for rel in [
                "resources",
                "../Resources",
                "../Resources/resources",
            ] {
                let cand = exe_dir.join(rel).join(server_bin);
                if cand.is_file() {
                    return Ok(cand);
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
    // バイナリ名で起動引数を切り替え (友達のWindows実機エラーログから確定):
    //
    //   codex / codex.exe           : `codex app-server` サブコマンド経由
    //     (Mac/Linux でも Windows のランチャーでも、CLI として複数機能を持つ)
    //
    //   codex-app-server / codex-app-server.exe : 引数なしで直接起動
    //     (Windows 配布で同梱される 188MB のバイナリ。Usage は [OPTIONS] のみ)
    //     `app-server` サブコマンドを渡すと
    //     "error: unexpected argument 'app-server' found" で落ちる
    let bin_name = bin
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    // ファイル名が "codex-app-server" で始まれば single-binary 配布物と判定。
    // 例: codex-app-server / codex-app-server.exe /
    //     codex-app-server-aarch64-apple-darwin / codex-app-server-x86_64-pc-windows-msvc.exe
    let is_native_app_server = bin_name.starts_with("codex-app-server");

    let mut cmd = Command::new(bin);
    if !is_native_app_server {
        // codex / codex.exe は app-server サブコマンドが必要
        cmd.arg("app-server");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", enriched_path());

    // Windows での黒い console window 抑制
    no_window_flag(&mut cmd);

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
