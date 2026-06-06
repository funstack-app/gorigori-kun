//! Skill import / export commands.
//!
//! ユーザーが書いた SKILL.md ファイルをアプリにインポートして、
//! `~/.codex/skills/<name>/SKILL.md` として配置する。
//! 既存スキルを外部にエクスポートすることも可能。

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub id: String,
    pub name: String,
    pub installed_at: String,
}

/// `<CODEX_HOME>/skills` ディレクトリのパスを返す。無ければ作成する。
///
/// FB#19 で GORI は専用 CODEX_HOME を使うようになったため、app-server が読みに
/// 行く skills も専用 HOME 配下に統一する。これがズレるとインポートしたスキルが
/// app-server から見えなくなる。
fn skills_root() -> Result<PathBuf> {
    let home = crate::codex::home::gori_codex_home_path()
        .or_else(crate::codex::home::legacy_codex_home)
        .ok_or_else(|| anyhow!("$HOME が解決できません"))?;
    let root = home.join("skills");
    std::fs::create_dir_all(&root).with_context(|| {
        format!(
            "スキルディレクトリの作成に失敗: {}",
            root.display()
        )
    })?;
    Ok(root)
}

/// SKILL.md の frontmatter (---...---) から `name:` フィールドを抽出する。
/// 簡素な実装: 完全な YAML パーサは使わず、文字列ベースで `name: xxx` を拾う。
fn extract_skill_name(markdown: &str) -> Result<String> {
    let trimmed = markdown.trim_start();
    let after_open = trimmed
        .strip_prefix("---")
        .ok_or_else(|| anyhow!("SKILL.md に frontmatter が見つかりません (--- で始まる必要があります)"))?;
    let end = after_open
        .find("\n---")
        .ok_or_else(|| anyhow!("SKILL.md の frontmatter 終端 (---) が見つかりません"))?;
    let frontmatter = &after_open[..end];

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("name:") {
            let name = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if name.is_empty() {
                return Err(anyhow!("SKILL.md の name: フィールドが空です"));
            }
            return Ok(name);
        }
    }
    Err(anyhow!(
        "SKILL.md の frontmatter に name: フィールドがありません"
    ))
}

/// インポートしたいファイルパス (絶対) を受け取り、
/// `~/.codex/skills/<name>/SKILL.md` に複製する。
#[tauri::command]
pub async fn skill_import(source_path: String) -> Result<SkillImportResult, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("インポート元ファイルが見つかりません: {source_path}"));
    }

    let content = std::fs::read_to_string(&src)
        .map_err(|e| format!("ファイル読み込みに失敗: {e}"))?;
    let name = extract_skill_name(&content).map_err(|e| format!("{e}"))?;

    // name のバリデーション: 危険な文字列を弾く (パストラバーサル防止)
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("スキル名に不正な文字が含まれています: {name}"));
    }

    let root = skills_root().map_err(|e| format!("{e}"))?;
    let skill_dir = root.join(&name);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("スキルディレクトリ作成に失敗: {e}"))?;

    let dest = skill_dir.join("SKILL.md");
    std::fs::write(&dest, content)
        .map_err(|e| format!("SKILL.md の書き込みに失敗: {e}"))?;

    Ok(SkillImportResult {
        id: name.clone(),
        name,
        installed_at: skill_dir.display().to_string(),
    })
}

/// 既存スキルの SKILL.md を読み出す (export 用)。
/// 結果は (markdown content, skill 名) のタプル。
#[tauri::command]
pub async fn skill_export_read(skill_id: String) -> Result<(String, String), String> {
    let root = skills_root().map_err(|e| format!("{e}"))?;

    // ID は ".." や "/" を含めない
    if skill_id.contains('/') || skill_id.contains('\\') || skill_id.contains("..") {
        return Err(format!("スキル ID に不正な文字が含まれています: {skill_id}"));
    }

    let skill_md = root.join(&skill_id).join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("スキル {skill_id} の SKILL.md が見つかりません"));
    }

    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("SKILL.md 読み込みに失敗: {e}"))?;
    Ok((content, skill_id))
}

/// インストール済みスキルの一覧を返す (id だけ)。
#[tauri::command]
pub async fn skill_list_installed() -> Result<Vec<String>, String> {
    let root = skills_root().map_err(|e| format!("{e}"))?;

    let mut ids = Vec::new();
    let entries =
        std::fs::read_dir(&root).map_err(|e| format!("スキルディレクトリ読み込み失敗: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.join("SKILL.md").is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids.sort();
    Ok(ids)
}
