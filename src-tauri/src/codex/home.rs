//! GORI GORI 専用 CODEX_HOME の解決と初回コピー移行。
//!
//! ## なぜ専用 CODEX_HOME が必要か (FB#19 / Codex クロスレビュー 2026-06-06)
//!
//! GORI GORI は内部で `codex app-server` と `codex exec` を spawn する。これらは
//! 既定で `~/.codex` を CODEX_HOME として使う。だが `~/.codex` はユーザーが
//! 直接インストールした Codex CLI と **共有** されており、両者が同じ `auth.json`
//! を奪い合うと、片方のログインがもう片方のトークンを無効化する事故が起きる
//! (認証 token 競合)。
//!
//! そこで GORI 専用の CODEX_HOME を新設し、app-server / codex exec の両方に
//! 同じ専用 HOME を渡すことで、ユーザーの素の Codex CLI から認証を隔離する。
//!
//! ## 安全策 (Codex 指定・厳守)
//!
//! - **「移動」ではなく「初回コピー移行」**。既存 `~/.codex` は絶対に削除・変更しない。
//! - 専用 HOME が空のとき、`~/.codex` から `auth.json` / `config.toml` / `skills/`
//!   **だけ** をコピーする。`generated_images` と `sessions` はコピーしない
//!   (前者は肥大化していて不要、後者は会話履歴で巨大かつ不要)。
//! - 冪等。既に専用 HOME 側にファイルがあれば上書きしない (ユーザーが GORI 内で
//!   再ログインした結果を、起動のたびに `~/.codex` の古いトークンで踏み潰さない)。
//!
//! ## 画像が見えなくなる退行への対策
//!
//! `image_gen` ツールは `$CODEX_HOME/generated_images/` に画像を書き出す。
//! CODEX_HOME を専用 HOME に切り替えると、書き出し先も専用 HOME 配下に移る。
//! このため画像監視 (watcher) とギャラリーの参照先も専用 HOME に統一する必要が
//! ある。さらに、旧 `~/.codex/generated_images` に残る過去画像も引き続き見える
//! よう、watcher は旧ディレクトリも **読み取り専用で監視対象に含める** (消さない)。

use std::path::PathBuf;

/// 専用 CODEX_HOME のサブディレクトリ名。
/// `~/Library/Application Support/app.codexframefactory/codex-home` (macOS) /
/// `%APPDATA%\app.codexframefactory\codex-home` (Windows) /
/// `~/.local/share/app.codexframefactory/codex-home` (Linux) に解決される。
const CODEX_HOME_LEAF: &str = "codex-home";

/// 初回コピー移行でコピーするファイル/ディレクトリ。
/// `generated_images` (肥大化・不要) と `sessions` (会話履歴・巨大) は **含めない**。
// auth.json は絶対にコピーしない（2026-07-10 改訂）: OAuth はリフレッシュトークン
// ローテーション（使うたびに旧トークンが即失効）のため、同じ auth.json のコピーが
// 2箇所にあると先にリフレッシュした側が勝ち、もう片方（素の Codex CLI 等）の
// ログインが 401 token_revoked で死ぬ。スイスイ君・generate.sh でも同型事故を実測。
// 認証は必ずアプリ内ログインで独立グラントを新規発行する（1ツール=1ログイン原則）。
const MIGRATE_FILES: &[&str] = &["config.toml"];
const MIGRATE_DIRS: &[&str] = &["skills"];

/// 旧 (ambient) `~/.codex` を返す。移行元・レガシー画像参照に使う。
/// **このディレクトリは読み取り専用で扱い、削除・変更しない。**
pub fn legacy_codex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

/// GORI GORI 専用 CODEX_HOME のパスを返す (ディレクトリの作成・移行はしない・純粋関数)。
///
/// パス解決だけが必要な箇所 (watcher のレガシー判定など) はこちらを使う。
/// 実際に app-server / codex exec を起動する前には [`ensure_gori_codex_home`] を
/// 呼んでディレクトリ作成と初回移行を済ませること。
pub fn gori_codex_home_path() -> Option<PathBuf> {
    dirs::data_dir().map(|data| data.join(crate::secrets::SERVICE_NAME).join(CODEX_HOME_LEAF))
}

/// 専用 CODEX_HOME を解決し、無ければ作成し、初回コピー移行を冪等に実行する。
///
/// 返り値は専用 CODEX_HOME の絶対パス。app-server / codex exec を spawn する
/// 直前に呼ぶ。移行に失敗してもパス自体は返す (起動を止めない)。
pub fn ensure_gori_codex_home() -> Option<PathBuf> {
    let home = gori_codex_home_path()?;
    if let Err(e) = std::fs::create_dir_all(&home) {
        tracing::warn!(
            target: "codex.home",
            error = ?e,
            path = %home.display(),
            "専用 CODEX_HOME の作成に失敗 (ambient ~/.codex フォールバックの可能性)"
        );
        return Some(home);
    }
    migrate_from_legacy(&home);
    Some(home)
}

/// コマンド側 (higgsfield / storyboard / batch_gen) が `codex exec` を spawn する
/// ときに渡す CODEX_HOME を解決する。
///
/// 優先順位:
///   1. プロセスに明示された `CODEX_HOME` env (テスト・上級者の上書き)
///   2. GORI 専用 CODEX_HOME (作成 + 初回移行つき)
///   3. 旧 ambient `~/.codex` (最終フォールバック)
///
/// app-server に渡す HOME ([`ensure_gori_codex_home`]) と同じ HOME を返すので、
/// `image_gen` の出力先 (`$CODEX_HOME/generated_images`) と watcher の参照先が
/// 一致する。
pub fn resolve_command_codex_home() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("CODEX_HOME") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    ensure_gori_codex_home().or_else(legacy_codex_home)
}

/// `~/.codex` から auth/config/skills を専用 HOME へ初回コピーする。
///
/// 冪等性: 専用 HOME 側に既にファイル/ディレクトリが存在すれば **何もしない**。
/// 既存 `~/.codex` には一切書き込まない (読み取りのみ)。
fn migrate_from_legacy(dest_home: &std::path::Path) {
    let Some(legacy) = legacy_codex_home() else {
        return;
    };
    if !legacy.exists() {
        // 素の Codex CLI を入れていないユーザー。移行元なし。専用 HOME で
        // ゼロからログインしてもらう (退行ではない・正常)。
        return;
    }

    for file in MIGRATE_FILES {
        let src = legacy.join(file);
        let dst = dest_home.join(file);
        if dst.exists() {
            // 既に移行済み / GORI 内でユーザーが更新済み。踏み潰さない。
            continue;
        }
        if src.is_file() {
            if let Err(e) = std::fs::copy(&src, &dst) {
                tracing::warn!(
                    target: "codex.home",
                    error = ?e,
                    file = %file,
                    "{} の初回コピー移行に失敗 (起動は続行)",
                    file
                );
            } else {
                tracing::info!(target: "codex.home", file = %file, "初回コピー移行 OK");
            }
        }
    }

    for dir in MIGRATE_DIRS {
        let src = legacy.join(dir);
        let dst = dest_home.join(dir);
        if dst.exists() {
            // skills は GORI が起動時に別途バンドル展開もする。既に存在するなら触らない。
            continue;
        }
        if src.is_dir() {
            if let Err(e) = copy_dir_recursive(&src, &dst) {
                tracing::warn!(
                    target: "codex.home",
                    error = %e,
                    dir = %dir,
                    "{} の初回コピー移行に失敗 (起動は続行)",
                    dir
                );
            } else {
                tracing::info!(target: "codex.home", dir = %dir, "初回コピー移行 OK");
            }
        }
    }
}

/// ディレクトリを再帰コピーする。symlink はスキップ (ループ防止)。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("copy {}: {e}", src_path.display()))?;
        }
    }
    Ok(())
}
