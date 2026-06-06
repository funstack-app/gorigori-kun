//! バンドル同梱スキルを `~/.codex/skills/` に展開する。
//!
//! ## なぜ必要か
//!
//! `commands/storyboard.rs` は実行時に `~/.codex/skills/gori-storyboard/`
//! を読みに行く。これは Codex CLI のスキル仕様 (フォルダ + SKILL.md) に
//! 合わせた設計だが、新規ユーザー Mac には当然このフォルダが存在しない。
//!
//! ## 何をするか
//!
//! 起動時に 1 度だけ:
//!   1. アプリバンドル内 (`resources/skills/<name>/`) を列挙
//!   2. ユーザーホームの `~/.codex/skills/<name>/` が無いか、
//!      バンドル側の `SKILL.md` のほうが新しければ上書きコピー
//!   3. 失敗してもアプリ起動は止めない (警告ログだけ)
//!
//! ## 設計判断
//!
//! - **ユーザーが自分で `~/.codex/skills/` 配下を編集している場合は壊さない**:
//!   バンドル `SKILL.md` の mtime がユーザー側 `SKILL.md` より新しい時だけ
//!   差し替える。ユーザーが手で書き換えても、アプリ更新前なら保護される。
//! - **バージョンファイルは持たない**: mtime 比較で十分。シンプルさ優先。

use std::path::Path;

use tauri::{AppHandle, Manager};

const BUNDLED_SKILLS: &[&str] = &["gori-storyboard"];

/// 起動時に呼ぶ。失敗してもエラーを伝播せず、ログだけ出す。
pub fn ensure_bundled_skills(app: &AppHandle) {
    // FB#19: app-server は GORI 専用 CODEX_HOME を使うため、バンドルスキルも
    // 専用 HOME 配下の skills/ に展開する。専用 HOME が解決できなければ旧 ~/.codex に
    // フォールバック (起動を止めない)。
    let home = match crate::codex::home::gori_codex_home_path()
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
    {
        Some(h) => h,
        None => {
            tracing::warn!(target: "codex.skills", "CODEX_HOME が取得できないためスキル展開を skip");
            return;
        }
    };

    let dest_root = home.join("skills");
    if let Err(e) = std::fs::create_dir_all(&dest_root) {
        tracing::warn!(
            target: "codex.skills",
            error = ?e,
            path = %dest_root.display(),
            "CODEX_HOME/skills の作成に失敗 (スキル展開を skip)"
        );
        return;
    }

    for skill in BUNDLED_SKILLS {
        if let Err(e) = ensure_one_skill(app, &dest_root, skill) {
            tracing::warn!(
                target: "codex.skills",
                error = %e,
                skill = %skill,
                "バンドルスキルの展開に失敗 (アプリ起動は続行)"
            );
        }
    }
}

fn ensure_one_skill(app: &AppHandle, dest_root: &Path, skill: &str) -> Result<(), String> {
    let bundle_skill_md = app
        .path()
        .resolve(
            format!("resources/skills/{skill}/SKILL.md"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("バンドル SKILL.md 解決失敗 ({skill}): {e}"))?;

    if !bundle_skill_md.exists() {
        return Err(format!(
            "バンドルに SKILL.md が見つかりません: {}",
            bundle_skill_md.display()
        ));
    }

    let bundle_root = bundle_skill_md
        .parent()
        .ok_or_else(|| format!("バンドル {skill} の親ディレクトリ取得に失敗"))?
        .to_path_buf();

    let dest = dest_root.join(skill);
    let dest_skill_md = dest.join("SKILL.md");

    // 差分判定: ユーザー側に SKILL.md が無い、または mtime が古いなら展開する
    let needs_install = match (dest_skill_md.metadata(), bundle_skill_md.metadata()) {
        (Err(_), _) => true,
        (Ok(d), Ok(b)) => match (d.modified(), b.modified()) {
            (Ok(dm), Ok(bm)) => bm > dm,
            _ => false,
        },
        _ => false,
    };

    if !needs_install {
        tracing::debug!(target: "codex.skills", skill = %skill, "既に最新の SKILL を検出、展開を skip");
        return Ok(());
    }

    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("{} の作成失敗: {e}", dest.display()))?;

    copy_dir_recursive(&bundle_root, &dest)
        .map_err(|e| format!("スキル {skill} のコピー失敗: {e}"))?;

    tracing::info!(
        target: "codex.skills",
        skill = %skill,
        from = %bundle_root.display(),
        to = %dest.display(),
        "バンドルスキルを展開しました"
    );
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.is_dir() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
        return Ok(());
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}
