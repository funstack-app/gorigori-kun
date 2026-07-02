//! Skill import / export commands.
//!
//! ユーザーが書いた SKILL.md ファイルをアプリにインポートして、
//! `~/.codex/skills/<name>/SKILL.md` として配置する。
//! 既存スキルを外部にエクスポートすることも可能。

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportResult {
    pub id: String,
    pub name: String,
    pub installed_at: String,
    /// zip 一括インポートで展開されたファイル数 (単一 .md では 1)。
    #[serde(default)]
    pub file_count: usize,
}

/// zip 展開時の許可拡張子ホワイトリスト。
/// これ以外の拡張子を持つエントリは無視する (実行ファイル等の混入防止)。
const ALLOWED_EXTENSIONS: &[&str] = &[
    "md", "yaml", "yml", "json", "txt", "png", "jpg", "jpeg", "webp",
];

/// zip 爆弾対策: 解凍後の合計サイズ上限 (50 MiB)。
const MAX_TOTAL_UNCOMPRESSED: u64 = 50 * 1024 * 1024;

/// zip 内の 1 エントリあたりの解凍後サイズ上限 (20 MiB)。
const MAX_ENTRY_UNCOMPRESSED: u64 = 20 * 1024 * 1024;

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
        file_count: 1,
    })
}

/// zip エントリ名がパストラバーサル安全かを検証し、正規化した相対 PathBuf を返す。
///
/// セキュリティ①: 以下を拒否する。
/// - 絶対パス (`/foo`, `C:\foo`, `\foo`)
/// - `..` を含むパス (親ディレクトリ脱出)
/// - Windows のドライブレター / UNC (`\\server\share`)
/// - 空パス / ディレクトリ末尾以外の異常
///
/// `Path::components` で分解し、`Component::Normal` 以外が現れたら拒否する。
/// これにより「途中に `..` を挟んで最終的に元へ戻る」型のトラバーサルも弾ける。
fn sanitize_zip_entry_path(raw_name: &str) -> Result<PathBuf> {
    if raw_name.is_empty() {
        return Err(anyhow!("zip 内に空のエントリ名があります"));
    }
    // zip 仕様上は `/` 区切り。Windows 生成 zip の `\` も念のため正規化する。
    let normalized = raw_name.replace('\\', "/");

    // 絶対パス (先頭 `/`) を明示拒否。
    if normalized.starts_with('/') {
        return Err(anyhow!("zip 内に絶対パスのエントリがあります: {raw_name}"));
    }
    // Windows ドライブレター (`C:...`) を拒否。
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        return Err(anyhow!("zip 内にドライブ指定のエントリがあります: {raw_name}"));
    }

    let candidate = Path::new(&normalized);
    let mut safe = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            // CurDir (`.`) は無害だが正規化のため無視。
            Component::CurDir => {}
            // ParentDir (`..`) / RootDir / Prefix はトラバーサルにつながるため即拒否。
            Component::ParentDir => {
                return Err(anyhow!(
                    "zip 内に親ディレクトリ参照 (..) を含むエントリがあります: {raw_name}"
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!("zip 内に不正な絶対パス要素があります: {raw_name}"));
            }
        }
    }
    if safe.as_os_str().is_empty() {
        return Err(anyhow!("zip 内に解決不能なエントリ名があります: {raw_name}"));
    }
    Ok(safe)
}

/// ファイルパスの拡張子がホワイトリストに含まれるか判定する。
/// セキュリティ②: 許可拡張子以外 (実行ファイル・シェルスクリプト等) を弾く。
fn is_allowed_extension(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let lower = ext.to_ascii_lowercase();
            ALLOWED_EXTENSIONS.contains(&lower.as_str())
        }
        None => false,
    }
}

/// `.gori-skill.zip` を受け取り、`<CODEX_HOME>/skills/<name>/` へ展開する。
///
/// セキュリティ (task 要件 4 点):
/// ① パストラバーサル禁止: `sanitize_zip_entry_path` で `..`・絶対パス・シンボリックリンクを拒否
/// ② 許可拡張子ホワイトリスト: `ALLOWED_EXTENSIONS` 以外は展開しない
/// ③ 展開サイズ上限: 解凍後合計 50 MiB / 1 エントリ 20 MiB を超えたら中止 (zip 爆弾対策)
/// ④ SKILL.md 検証: ルートに SKILL.md が存在し frontmatter の name を抽出できることを確認
#[tauri::command]
pub async fn skill_import_zip(source_path: String) -> Result<SkillImportResult, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("インポート元 zip が見つかりません: {source_path}"));
    }

    let file = std::fs::File::open(&src).map_err(|e| format!("zip を開けません: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip 読み込みに失敗: {e}"))?;

    // ── パス 1: 全エントリを検証し、SKILL.md の中身と name を先に確定する ──
    // 展開前に検証を済ませることで、途中で失敗しても skills/ を汚さない。
    let mut skill_md_content: Option<String> = None;
    // (安全な相対パス, 解凍後バイト列) を貯めて、検証通過後にまとめて書き出す。
    let mut staged: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut total_uncompressed: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip エントリ {i} の読み込みに失敗: {e}"))?;

        // ① シンボリックリンク拒否: Unix mode の S_IFLNK (0o120000) を検出。
        if let Some(mode) = entry.unix_mode() {
            const S_IFMT: u32 = 0o170000;
            const S_IFLNK: u32 = 0o120000;
            if mode & S_IFMT == S_IFLNK {
                return Err(format!(
                    "zip 内にシンボリックリンクが含まれています: {}",
                    entry.name()
                ));
            }
        }

        // ディレクトリエントリはスキップ (書き出し時に親を create_dir_all する)。
        if entry.is_dir() {
            continue;
        }

        // ① パストラバーサル検証。
        let safe_rel = sanitize_zip_entry_path(entry.name()).map_err(|e| format!("{e}"))?;

        // ③ 1 エントリのサイズ上限 (宣言サイズで先にチェック)。
        let declared = entry.size();
        if declared > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "zip 内のファイルが大きすぎます (上限 20MiB): {}",
                entry.name()
            ));
        }

        // ② 拡張子ホワイトリスト。SKILL.md を含む .md 等のみ通す。
        if !is_allowed_extension(&safe_rel) {
            return Err(format!(
                "許可されていない拡張子のファイルが含まれています: {}",
                entry.name()
            ));
        }

        // 実データ読み込み。宣言サイズを信用せず、読みながら上限で打ち切る (zip 爆弾対策)。
        let mut buf = Vec::new();
        let mut limited = entry.by_ref().take(MAX_ENTRY_UNCOMPRESSED + 1);
        limited
            .read_to_end(&mut buf)
            .map_err(|e| format!("zip エントリの展開に失敗: {e}"))?;
        if buf.len() as u64 > MAX_ENTRY_UNCOMPRESSED {
            return Err(format!(
                "zip 内のファイルが上限を超えています (20MiB): {}",
                entry.name()
            ));
        }

        // ③ 合計サイズ上限。
        total_uncompressed += buf.len() as u64;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
            return Err("zip の展開後合計サイズが上限 (50MiB) を超えています".to_string());
        }

        // ④ ルートの SKILL.md を記録 (frontmatter 抽出用)。
        if safe_rel == Path::new("SKILL.md") {
            let text = String::from_utf8(buf.clone())
                .map_err(|_| "SKILL.md が UTF-8 として読めません".to_string())?;
            skill_md_content = Some(text);
        }

        staged.push((safe_rel, buf));
    }

    // ④ SKILL.md がルートに存在することを検証。
    let skill_md = skill_md_content
        .ok_or_else(|| "zip のルートに SKILL.md がありません".to_string())?;
    let name = extract_skill_name(&skill_md).map_err(|e| format!("{e}"))?;

    // name のバリデーション (skill_import と同一): 保存先ディレクトリ名の安全化。
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("スキル名に不正な文字が含まれています: {name}"));
    }

    let root = skills_root().map_err(|e| format!("{e}"))?;
    let skill_dir = root.join(&name);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("スキルディレクトリ作成に失敗: {e}"))?;

    // ── パス 2: 検証済みの staged を skills/<name>/ 配下へ書き出す ──
    let mut written = 0usize;
    for (rel, data) in &staged {
        let dest = skill_dir.join(rel);
        // 二重防御: 結合後のパスが skill_dir 配下に収まることを確認する。
        // (sanitize で弾いているが、symlink 経由の脱出も考慮した最終ガード)
        if !dest.starts_with(&skill_dir) {
            return Err(format!(
                "展開先がスキルディレクトリ外になりました: {}",
                dest.display()
            ));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ディレクトリ作成に失敗 ({}): {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("ファイル書き込みに失敗 ({}): {e}", dest.display()))?;
        out.write_all(data)
            .map_err(|e| format!("ファイル書き込みに失敗 ({}): {e}", dest.display()))?;
        written += 1;
    }

    Ok(SkillImportResult {
        id: name.clone(),
        name,
        installed_at: skill_dir.display().to_string(),
        file_count: written,
    })
}

/// 既存スキルディレクトリ全体を `.gori-skill.zip` として書き出す (export 用)。
///
/// `<CODEX_HOME>/skills/<skill_id>/` 配下の許可拡張子ファイル
/// (SKILL.md / references/ / agents/ 等) を再帰的に集めて zip 化する。
/// `dest_zip_path` はフロントの保存ダイアログで得た絶対パス。
#[tauri::command]
pub async fn skill_export_zip(
    skill_id: String,
    dest_zip_path: String,
) -> Result<usize, String> {
    // ID は ".." や "/" を含めない (skill_export_read と同一ガード)。
    if skill_id.contains('/') || skill_id.contains('\\') || skill_id.contains("..") {
        return Err(format!("スキル ID に不正な文字が含まれています: {skill_id}"));
    }

    let root = skills_root().map_err(|e| format!("{e}"))?;
    let skill_dir = root.join(&skill_id);
    if !skill_dir.join("SKILL.md").is_file() {
        return Err(format!("スキル {skill_id} の SKILL.md が見つかりません"));
    }

    // ディレクトリを再帰走査し、許可拡張子のファイルだけを (相対パス, 絶対パス) で集める。
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![skill_dir.clone()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("ディレクトリ読み込み失敗 ({}): {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            // symlink はエクスポートに含めない (実体外参照の混入防止)。
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !is_allowed_extension(&path) {
                continue;
            }
            // zip 内エントリ名は skill_dir からの相対 (`/` 区切り) に正規化。
            let rel = match path.strip_prefix(&skill_dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let entry_name = rel
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/");
            if entry_name.is_empty() {
                continue;
            }
            files.push((entry_name, path));
        }
    }

    if files.is_empty() {
        return Err("エクスポート対象のファイルがありません".to_string());
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));

    // sessions.rs と同じく tmp に書いて fsync 後 rename する (半端な zip を残さない)。
    let dest_path = PathBuf::from(&dest_zip_path);
    let tmp_path = dest_path.with_extension("zip.tmp");
    let count = files.len();

    let out_file =
        std::fs::File::create(&tmp_path).map_err(|e| format!("zip 作成失敗: {e}"))?;
    let mut zip = zip::ZipWriter::new(out_file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (entry_name, path) in &files {
        let data = std::fs::read(path)
            .map_err(|e| format!("ファイル読み込み失敗 ({}): {e}", path.display()))?;
        zip.start_file(entry_name, opts)
            .map_err(|e| format!("zip start_file 失敗: {e}"))?;
        zip.write_all(&data)
            .map_err(|e| format!("zip write 失敗: {e}"))?;
    }
    let finished = zip.finish().map_err(|e| format!("zip finish 失敗: {e}"))?;
    finished.sync_all().map_err(|e| format!("zip fsync 失敗: {e}"))?;
    drop(finished);

    std::fs::rename(&tmp_path, &dest_path).map_err(|e| format!("zip rename 失敗: {e}"))?;

    Ok(count)
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
