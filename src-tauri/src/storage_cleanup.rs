//! ストレージ自動掃除モジュール
//!
//! 起動時 + 24時間ごとに、Codex の一時データを軽量化・削除する。
//!
//! 軽量化対象 (GORI 専用 CODEX_HOME と 旧 ~/.codex の両方):
//! - <CODEX_HOME>/sessions/**/*.jsonl : 24時間より古い rollout の画像ペイロードのみ除去
//!
//! 削除対象 (再生成できるキャッシュのみ):
//! - GORI 専用 CODEX_HOME/.tmp/marketplaces/
//! - <CODEX_HOME>/logs_2.sqlite*
//! - GORI の WebView キャッシュ
//!
//! FB#19 対応で GORI は専用 CODEX_HOME
//! (~/Library/Application Support/app.codexframefactory/codex-home) を使うように
//! なった。今後 GORI が吐く sessions はこの専用 HOME 配下に溜まるため、専用 HOME と
//! 旧 ~/.codex の sessions を対象にする。ただし sessions 自体は絶対に削除しない。
//! 画像ペイロードのみ除去し、会話・プロンプトは永久保存する。
//!
//! 絶対に触らないもの:
//! - ~/Pictures/GORI GORI/ (ユーザーの作品データ)
//! - ~/Desktop/ (ユーザーデータ)
//! - sessions のファイル・会話・プロンプト (画像ペイロード以外は**消さない**)
//! - <CODEX_HOME>/generated_images/ / ~/.codex/generated_images/ (生成画像)
//! - <CODEX_HOME>/history.db / projects/ (履歴・プロジェクト)
//! - <CODEX_HOME>/skills/ / ~/.codex/skills/ (スキル本体)
//! - <CODEX_HOME>/memories/ / ~/.codex/memories/ (メモリ本体)
//! - <CODEX_HOME>/auth.json / config.toml (認証・設定)

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::time::interval;

/// rollout の画像ペイロードを除去するまでの時間。
const STRIP_MIN_AGE_HOURS: u64 = 24;
/// 24時間ごと
const SWEEP_INTERVAL_HOURS: u64 = 24;
const DATA_IMAGE_PREFIX: &[u8] = b"data:image/";
const BASE64_MARKER: &[u8] = b";base64,";
const STRIPPED_PAYLOAD: &[u8] = b"[stripped]";
const STRIP_STATE_FILE: &str = "rollout-image-strip-v1.json";

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub sessions_deleted: u64,
    pub sessions_bytes_freed: u64,
    pub stripped_files: u64,
    pub stripped_bytes_freed: u64,
    pub generated_images_deleted: u64,
    pub generated_images_bytes_freed: u64,
    /// Codex ログ (logs_2.sqlite*) と WebView キャッシュの解放バイト数。
    /// FB-A4: 掃除前 inspect で表示していたのに run_cleanup が消していなかった分。
    pub cache_bytes_freed: u64,
    pub errors: Vec<String>,
}

/// バックグラウンド掃除タスクを起動する。
///
/// アプリ起動時に1度呼ぶ。内部で `tokio::spawn` するので非ブロッキング。
/// 初回は起動直後、その後は24時間ごとに自動実行。
pub fn spawn_background_cleanup() {
    // Tauri の setup フック内では Tokio runtime がまだ起動していないため、
    // `tokio::spawn` を直接呼ぶと panic する。
    // `tauri::async_runtime::spawn` を使うことで、Tauri が用意した runtime に
    // 安全にタスクを乗せられる。
    tauri::async_runtime::spawn(async {
        // 初回: 起動5秒後 (アプリ起動を妨げない)
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(err) = run_cleanup().await {
            tracing::warn!(target: "storage.cleanup", "initial cleanup failed: {err}");
        }

        // 以降: 24時間ごと
        let mut ticker = interval(Duration::from_secs(SWEEP_INTERVAL_HOURS * 3600));
        ticker.tick().await; // 初回 tick はすぐ完了するので捨てる
        loop {
            ticker.tick().await;
            if let Err(err) = run_cleanup().await {
                tracing::warn!(target: "storage.cleanup", "scheduled cleanup failed: {err}");
            }
        }
    });
}

/// 1回分の掃除処理。テストや手動実行から呼べる。
pub async fn run_cleanup() -> Result<CleanupReport, String> {
    let mut report = CleanupReport::default();

    // 掃除対象の sessions ディレクトリ候補は codex::home::cleanup_target_codex_homes()
    // が唯一の正本 (GORI 専用 / 生成専用 codex-home-gen / 旧 ~/.codex)。
    // 2026-07-25: 以前ここに手書きで列挙していたため codex-home-gen が漏れ、
    // sessions 1.5GB が掃除にも容量表示にも現れていなかった。
    let codex_homes = crate::codex::home::cleanup_target_codex_homes();
    let session_dirs: Vec<PathBuf> = codex_homes
        .iter()
        .map(|home| home.join("sessions"))
        .collect();
    if session_dirs.is_empty() {
        return Err("$HOME が解決できません".to_string());
    }

    // 1. 各 sessions/ 配下の古い .jsonl から画像ペイロードだけを除去する。
    //    sessions のファイル自体と、会話・プロンプトは一切削除しない。
    for sessions in &session_dirs {
        if sessions.exists() {
            match strip_old_rollout_images(sessions, STRIP_MIN_AGE_HOURS).await {
                Ok(result) => {
                    report.stripped_files += result.files;
                    report.stripped_bytes_freed += result.bytes_freed;
                    report.errors.extend(result.errors);
                }
                Err(err) => report.errors.push(format!("sessions: {err}")),
            }
        }
    }

    // 2. Codex ログ (logs_2.sqlite*)、marketplaces、WebView キャッシュ。
    //    FB-A4: これらは掃除前の inspect では合計に表示されていたのに run_cleanup が
    //    一切消していなかったため、「今すぐ整理する」を押しても合計がほとんど減らず
    //    「効かない」と見えていた。いずれも再生成される一時データだけを対象にする。
    if let Some(home) = dirs::home_dir() {
        // Codex ログ。対象ホームは session_dirs と同じ正本 (codex_homes) を使う。
        // 2026-07-25: codex-home-gen/logs_2.sqlite が実測 866MB あったが、
        // ここの列挙漏れで一切回収されていなかった。
        for ch in &codex_homes {
            for name in ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm"] {
                report.cache_bytes_freed += remove_file_if_exists(&ch.join(name)).await;
            }
        }

        // デスクトップ版から複製されたプラグインカタログのキャッシュ。
        // auth/config/skills/memories には触れず、このディレクトリだけを対象にする。
        if let Some(gori) = gori_codex_home_dir() {
            let marketplaces = gori.join(".tmp/marketplaces");
            if marketplaces.exists() {
                match remove_dir_contents(&marketplaces).await {
                    Ok((_, bytes)) => report.cache_bytes_freed += bytes,
                    Err(err) => report.errors.push(format!("marketplaces cache: {err}")),
                }
            }
        }

        // WebView キャッシュ (macOS のみ実体あり。他 OS では候補が存在せず 0)
        // 2026-07-25 修正: 以前は "gori-gori-kun" をハードコードしていたが、実際の
        // ディレクトリ名は bundle identifier (app.codexframefactory) であり、
        // 掃除も容量表示も常に空振りしていた (実体 WebKit/app.codexframefactory は 4.3MB)。
        // identifier を正本 (secrets::SERVICE_NAME) から組み立てて再発を防ぐ。
        // 旧名は空ディレクトリとして残っている環境があるため候補に残す (無害)。
        let service = crate::secrets::SERVICE_NAME;
        for rel in [
            format!("Library/Caches/{service}"),
            format!("Library/WebKit/{service}"),
            "Library/Caches/gori-gori-kun".to_string(),
            "Library/WebKit/gori-gori-kun".to_string(),
        ] {
            let dir = home.join(rel);
            if dir.exists() {
                match remove_dir_contents(&dir).await {
                    Ok((_, bytes)) => report.cache_bytes_freed += bytes,
                    Err(err) => report.errors.push(format!("cache: {err}")),
                }
            }
        }
    }

    tracing::info!(
        target: "storage.cleanup",
        sessions = report.sessions_deleted,
        sessions_mb = report.sessions_bytes_freed / 1_000_000,
        stripped_files = report.stripped_files,
        stripped_mb = report.stripped_bytes_freed / 1_000_000,
        generated = report.generated_images_deleted,
        generated_mb = report.generated_images_bytes_freed / 1_000_000,
        cache_mb = report.cache_bytes_freed / 1_000_000,
        "cleanup completed"
    );

    Ok(report)
}

/// ファイルが存在すれば削除し、解放したバイト数を返す。存在しない/失敗時は 0。
async fn remove_file_if_exists(path: &std::path::Path) -> u64 {
    let size = match fs::metadata(path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return 0,
    };
    if fs::remove_file(path).await.is_ok() {
        size
    } else {
        0
    }
}

/// 旧 ambient `~/.codex`。sessions の後方互換軽量化とログ掃除に使う。
fn legacy_codex_home_dir() -> Option<PathBuf> {
    crate::codex::home::legacy_codex_home()
}

/// GORI 専用 CODEX_HOME。sessions の軽量化と一時キャッシュ掃除に使う。
/// パス解決のみ (作成・移行はしない)。
fn gori_codex_home_dir() -> Option<PathBuf> {
    crate::codex::home::gori_codex_home_path()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
struct FileFingerprint {
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

impl FileFingerprint {
    fn from_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Self {
            len: metadata.len(),
            modified_secs: modified.as_secs(),
            modified_nanos: modified.subsec_nanos(),
        })
    }
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
struct ProcessedRolloutState {
    files: BTreeMap<String, FileFingerprint>,
}

#[derive(Debug, Default)]
struct StripSweepResult {
    files: u64,
    bytes_freed: u64,
    errors: Vec<String>,
}

enum StripFileResult {
    Unchanged,
    Stripped { bytes_freed: u64 },
}

/// 24時間より古い rollout から画像ペイロードだけを除去する。
///
/// 処理済みファイルはパス・サイズ・更新時刻を状態ファイルに記録し、ファイルが
/// 変わらない限り再読込しない。状態ファイル自体も一時ファイルから rename する。
async fn strip_old_rollout_images(
    dir: &std::path::Path,
    min_age_hours: u64,
) -> Result<StripSweepResult, String> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(min_age_hours * 3_600))
        .ok_or_else(|| "cutoff 計算に失敗".to_string())?;
    let state_path = dir
        .parent()
        .ok_or_else(|| "sessions の親ディレクトリがありません".to_string())?
        .join(".storage_cleanup")
        .join(STRIP_STATE_FILE);
    let (mut state, state_load_error) = load_processed_state(&state_path).await;
    let mut result = StripSweepResult::default();
    if let Some(err) = state_load_error {
        result.errors.push(format!("strip state: {err}"));
    }
    let mut state_changed = false;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(err) => {
                result
                    .errors
                    .push(format!("sessions read_dir {}: {err}", current.display()));
                continue;
            }
        };
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(err) => {
                    result
                        .errors
                        .push(format!("sessions next_entry {}: {err}", current.display()));
                    break;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type().await {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            // sessions 外へ出る可能性があるため、シンボリックリンクは追わない。
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
            {
                continue;
            }
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = match meta.modified() {
                Ok(modified) => modified,
                Err(_) => continue,
            };
            if modified >= cutoff {
                continue;
            }
            let fingerprint = match FileFingerprint::from_metadata(&meta) {
                Some(fingerprint) => fingerprint,
                None => continue,
            };
            let relative_path = match path.strip_prefix(dir).ok().and_then(|p| p.to_str()) {
                Some(relative_path) => relative_path.to_string(),
                None => continue,
            };
            if state.files.get(&relative_path) == Some(&fingerprint) {
                continue;
            }

            match strip_rollout_file_atomically(&path, fingerprint, meta.permissions()).await {
                Ok(StripFileResult::Unchanged) => {
                    state.files.insert(relative_path, fingerprint);
                    state_changed = true;
                }
                Ok(StripFileResult::Stripped { bytes_freed }) => {
                    result.files += 1;
                    result.bytes_freed += bytes_freed;
                    match fs::metadata(&path)
                        .await
                        .ok()
                        .and_then(|m| FileFingerprint::from_metadata(&m))
                    {
                        Some(new_fingerprint) => {
                            state.files.insert(relative_path, new_fingerprint);
                            state_changed = true;
                        }
                        None => result.errors.push(format!(
                            "strip fingerprint {}: 書き換え後の情報を取得できません",
                            path.display()
                        )),
                    }
                }
                Err(err) => result
                    .errors
                    .push(format!("strip {}: {err}", path.display())),
            }
        }
    }

    if state_changed {
        if let Err(err) = save_processed_state_atomically(&state_path, &state).await {
            result.errors.push(format!("strip state: {err}"));
        }
    }

    Ok(result)
}

/// 1ファイルを一時ファイルへ書き、元が処理中に変わっていない場合だけ rename する。
async fn strip_rollout_file_atomically(
    path: &std::path::Path,
    expected: FileFingerprint,
    permissions: std::fs::Permissions,
) -> Result<StripFileResult, String> {
    let input = fs::File::open(path)
        .await
        .map_err(|err| format!("open: {err}"))?;
    let opened_fingerprint = input
        .metadata()
        .await
        .ok()
        .and_then(|metadata| FileFingerprint::from_metadata(&metadata))
        .ok_or_else(|| "open 後のファイル情報を取得できません".to_string())?;
    if opened_fingerprint != expected {
        return Err("処理開始前にファイルが更新されたためスキップ".to_string());
    }

    let (temp_path, temp_file) = create_unique_temp_file(path).await?;
    let write_result: Result<(u64, u64), String> = async {
        let mut reader = BufReader::new(input);
        let mut writer = BufWriter::new(temp_file);
        let mut line = Vec::new();
        let mut replacements = 0u64;

        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .await
                .map_err(|err| format!("read: {err}"))?;
            if read == 0 {
                break;
            }
            if let Some((stripped_line, count)) = strip_image_payloads_from_line(&line) {
                writer
                    .write_all(&stripped_line)
                    .await
                    .map_err(|err| format!("write: {err}"))?;
                replacements += count;
            } else {
                writer
                    .write_all(&line)
                    .await
                    .map_err(|err| format!("write: {err}"))?;
            }
        }

        writer
            .flush()
            .await
            .map_err(|err| format!("flush: {err}"))?;
        writer
            .get_ref()
            .sync_all()
            .await
            .map_err(|err| format!("sync: {err}"))?;
        let new_len = writer
            .get_ref()
            .metadata()
            .await
            .map_err(|err| format!("temp metadata: {err}"))?
            .len();
        drop(writer);
        drop(reader);
        Ok((replacements, new_len))
    }
    .await;

    let (replacements, new_len) = match write_result {
        Ok(result) => result,
        Err(err) => {
            let _ = fs::remove_file(&temp_path).await;
            return Err(err);
        }
    };

    let current_fingerprint = fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| FileFingerprint::from_metadata(&metadata));
    if current_fingerprint != Some(expected) {
        let _ = fs::remove_file(&temp_path).await;
        return Err("処理中にファイルが更新されたためスキップ".to_string());
    }

    if replacements == 0 {
        let _ = fs::remove_file(&temp_path).await;
        return Ok(StripFileResult::Unchanged);
    }

    if let Err(err) = fs::set_permissions(&temp_path, permissions).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(format!("set_permissions: {err}"));
    }
    if let Err(err) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(format!("atomic rename: {err}"));
    }

    Ok(StripFileResult::Stripped {
        bytes_freed: expected.len.saturating_sub(new_len),
    })
}

/// 1行内の data:image/<mime>;base64,<payload> の payload だけを置換する。
/// 閉じ引用符が見つからない候補がある行は、壊れた行として一切変更しない。
fn strip_image_payloads_from_line(line: &[u8]) -> Option<(Vec<u8>, u64)> {
    if find_subslice(line, DATA_IMAGE_PREFIX).is_none() || !is_valid_json_line(line) {
        return None;
    }

    let mut ranges = Vec::new();
    let mut search_from = 0usize;

    while let Some(prefix_offset) = find_subslice(&line[search_from..], DATA_IMAGE_PREFIX) {
        let prefix_start = search_from + prefix_offset;
        let mime_start = prefix_start + DATA_IMAGE_PREFIX.len();

        // JSON文字列の外や、一般的な画像MIMEでない候補は触らない。
        if !is_inside_json_string(line, prefix_start) {
            search_from = mime_start;
            continue;
        }
        let mut marker_start = mime_start;
        while marker_start < line.len() && is_safe_mime_byte(line[marker_start]) {
            marker_start += 1;
        }
        if marker_start == mime_start || !line[marker_start..].starts_with(BASE64_MARKER) {
            search_from = mime_start;
            continue;
        }

        let payload_start = marker_start + BASE64_MARKER.len();
        let payload_end = find_next_unescaped_quote(line, payload_start)?;
        let payload = &line[payload_start..payload_end];
        if !payload.is_empty() && payload != STRIPPED_PAYLOAD {
            ranges.push((payload_start, payload_end));
        }
        search_from = payload_end + 1;
    }

    if ranges.is_empty() {
        return None;
    }

    let mut output = Vec::with_capacity(line.len());
    let mut copied_until = 0usize;
    for (start, end) in &ranges {
        output.extend_from_slice(&line[copied_until..*start]);
        output.extend_from_slice(STRIPPED_PAYLOAD);
        copied_until = *end;
    }
    output.extend_from_slice(&line[copied_until..]);
    Some((output, ranges.len() as u64))
}

fn is_valid_json_line(line: &[u8]) -> bool {
    let mut deserializer = serde_json::Deserializer::from_slice(line);
    if <serde::de::IgnoredAny as serde::Deserialize>::deserialize(&mut deserializer).is_err() {
        return false;
    }
    deserializer.end().is_ok()
}

fn is_safe_mime_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'_' | b'-')
}

fn is_inside_json_string(line: &[u8], position: usize) -> bool {
    let mut inside = false;
    let mut backslashes = 0usize;
    for &byte in &line[..position] {
        if byte == b'\\' {
            backslashes += 1;
            continue;
        }
        if byte == b'"' && backslashes % 2 == 0 {
            inside = !inside;
        }
        backslashes = 0;
    }
    inside
}

fn find_next_unescaped_quote(line: &[u8], start: usize) -> Option<usize> {
    let mut backslashes = 0usize;
    for (offset, &byte) in line[start..].iter().enumerate() {
        if byte == b'\\' {
            backslashes += 1;
            continue;
        }
        if byte == b'"' && backslashes % 2 == 0 {
            return Some(start + offset);
        }
        backslashes = 0;
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn load_processed_state(path: &std::path::Path) -> (ProcessedRolloutState, Option<String>) {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return (
                ProcessedRolloutState::default(),
                Some("状態ファイルがシンボリックリンクのため読み込みません".to_string()),
            );
        }
        Ok(metadata) if !metadata.is_file() => {
            return (
                ProcessedRolloutState::default(),
                Some("状態ファイルが通常ファイルではありません".to_string()),
            );
        }
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return (ProcessedRolloutState::default(), None);
        }
        Err(err) => {
            return (
                ProcessedRolloutState::default(),
                Some(format!("metadata: {err}")),
            );
        }
    }

    match fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(state) => (state, None),
            Err(err) => (
                ProcessedRolloutState::default(),
                Some(format!("parse: {err}")),
            ),
        },
        Err(err) => (
            ProcessedRolloutState::default(),
            Some(format!("read: {err}")),
        ),
    }
}

async fn save_processed_state_atomically(
    path: &std::path::Path,
    state: &ProcessedRolloutState,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "状態ファイルの親ディレクトリがありません".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|err| format!("create state dir: {err}"))?;
    let mut bytes = serde_json::to_vec(state).map_err(|err| format!("serialize: {err}"))?;
    bytes.push(b'\n');
    let (temp_path, mut temp_file) = create_unique_temp_file(path).await?;

    let write_result: Result<(), String> = async {
        temp_file
            .write_all(&bytes)
            .await
            .map_err(|err| format!("write: {err}"))?;
        temp_file
            .sync_all()
            .await
            .map_err(|err| format!("sync: {err}"))?;
        drop(temp_file);
        fs::rename(&temp_path, path)
            .await
            .map_err(|err| format!("atomic rename: {err}"))?;
        Ok(())
    }
    .await;

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path).await;
    }
    write_result
}

async fn create_unique_temp_file(
    destination: &std::path::Path,
) -> Result<(PathBuf, fs::File), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "一時ファイルの親ディレクトリがありません".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "一時ファイル名を安全に作れません".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    for attempt in 0..16u8 {
        let temp_path = parent.join(format!(
            ".{file_name}.gori-cleanup-{}-{nonce}-{attempt}.tmp",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("create temp: {err}")),
        }
    }

    Err("一時ファイル名を確保できません".to_string())
}

/// ディレクトリの中身を全削除(ディレクトリ自体は残す)
async fn remove_dir_contents(dir: &std::path::Path) -> Result<(u64, u64), String> {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut entries = fs::read_dir(dir)
        .await
        .map_err(|e| format!("read_dir: {e}"))?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let dir_size = dir_size_recursive(&path).await;
            if fs::remove_dir_all(&path).await.is_ok() {
                count += 1;
                bytes += dir_size;
            }
        } else {
            let size = meta.len();
            if fs::remove_file(&path).await.is_ok() {
                count += 1;
                bytes += size;
            }
        }
    }
    Ok((count, bytes))
}

async fn dir_size_recursive(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            match entry.metadata().await {
                Ok(m) if m.is_dir() => stack.push(p),
                Ok(m) => total += m.len(),
                Err(_) => continue,
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::strip_image_payloads_from_line;

    #[test]
    fn normal_line_is_unchanged() {
        let line = r#"{"type":"message","text":"お餅が好き"}"#.as_bytes();
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    #[test]
    fn strips_only_image_payload() {
        let line = br#"{"image":"data:image/png;base64,QUJDRA==","text":"keep me"}"#;
        let expected = br#"{"image":"data:image/png;base64,[stripped]","text":"keep me"}"#;
        let (actual, count) = strip_image_payloads_from_line(line).expect("画像を検出");
        assert_eq!(actual, expected);
        assert_eq!(count, 1);
    }

    #[test]
    fn escaped_quote_does_not_end_payload() {
        let line = br#"{"image":"data:image/webp;base64,AAAA\"BBBB","text":"keep"}"#;
        let expected = br#"{"image":"data:image/webp;base64,[stripped]","text":"keep"}"#;
        let (actual, count) = strip_image_payloads_from_line(line).expect("画像を検出");
        assert_eq!(actual, expected);
        assert_eq!(count, 1);
    }

    #[test]
    fn malformed_line_without_closing_quote_is_unchanged() {
        let line = br#"{"image":"data:image/png;base64,QUJDRA==}"#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    #[test]
    fn malformed_json_with_closing_quote_is_unchanged() {
        let line = br#"{"image":"data:image/png;base64,QUJDRA==""#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }

    #[test]
    fn already_stripped_payload_is_unchanged() {
        let line = br#"{"image":"data:image/jpeg;base64,[stripped]"}"#;
        assert!(strip_image_payloads_from_line(line).is_none());
    }
}
