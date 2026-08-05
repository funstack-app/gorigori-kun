//! 音源ファイルのメタデータ抽出 (MV 用・bd go4)。
//!
//! ## 設計上の不変条件
//!
//! **音声データ本体は codex に渡さない。** codex の入力モダリティは Text + Image のみで
//! (app-server の入力アイテム型は `text | image | localImage` の 3 種)、音声パスを
//! `localImage` に載せるとモデルがファイルを調べようとシェル実行を試み、Windows では
//! `codex-windows-sandbox-setup.exe` が無いため「sandbox-setup エラー」に化ける
//! (DB1 報告の事故連鎖)。
//!
//! そこでここでは lofty (pure Rust・ヘッダ読みのみ) で尺・形式・タグを取り出し、
//! **文字情報だけ**をプロンプトへ供給する。絵コンテ (MV) は `[STORYBOARD_PARAMS]` の
//! `duration_seconds` 合計を全体尺に合わせる設計が既にあるため、「長さを文字で渡す」
//! だけで曲に合ったカット割りが成立する。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};

/// 対応拡張子。lofty が全て pure Rust で解析できるものに限定する。
/// フロント側 `src/lib/audio/attach.ts` の `AUDIO_EXTS` と一致させること。
const AUDIO_EXTS: [&str; 6] = ["mp3", "wav", "m4a", "aac", "flac", "ogg"];

const SUPPORTED_LIST: &str = "mp3 / wav / m4a / aac / flac / ogg";

/// 音源 1 ファイルの上限 (200MB)。
/// フロント側 `src/lib/audio/attach.ts` の `MAX_AUDIO_BYTES` と一致させること。
///
/// UI 側にも同じチェックがあるが、それは「親切な早期エラー」でしかない。
/// UI を経由しない呼び出し (別経路・将来の再利用) では 200MB 超のバイト列を
/// そのまま受けてメモリを圧迫しうるため、境界であるここでも拒否する
/// (Sol指摘 G-3)。
const MAX_AUDIO_BYTES: u64 = 200 * 1024 * 1024;

/// 上限超過のエラー文言。UI 側 (`attach.ts:102`) と同一の文面にして、
/// どちらで弾かれてもユーザーには同じメッセージが出るようにする。
fn too_large_error(file_name: &str) -> String {
    format!("音源が大きすぎます: {file_name}（上限 200MB）")
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbeResult {
    pub file_name: String,
    pub ext: String,
    pub duration_sec: f64,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub bitrate_kbps: Option<u32>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// 空文字・空白のみのタグは None に落とす (行ごと省略させるため)。
///
/// lofty は不正なエンコーディングのタグを読み飛ばす。ID3v2 に Shift_JIS が
/// 生で入った古い mp3 は化けうるが、その場合も「黙って化けた文字を渡す」より
/// 省略する方が実害が小さい (設計書リスク欄)。
fn clean_tag(v: Option<&str>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn probe_inner(path: &Path) -> Result<AudioProbeResult, String> {
    let file_name = file_name_of(path);
    let ext = ext_of(path);

    if !path.is_file() {
        return Err(format!(
            "音源を読み込めませんでした: {file_name}。ファイルが見つかりません"
        ));
    }
    if !AUDIO_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "音源を読み込めませんでした: {file_name}。ファイルが壊れているか、対応していない形式です（対応: {SUPPORTED_LIST}）"
        ));
    }
    // 読み込みの前にサイズを見る (Sol指摘 G-3)。native drop 経由は bytes を
    // JS に載せないため UI 側チェックを通らず、ここが唯一の関門になる。
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_AUDIO_BYTES {
            return Err(too_large_error(&file_name));
        }
    }

    let tagged = lofty::read_from_path(path).map_err(|_| {
        format!(
            "音源を読み込めませんでした: {file_name}。ファイルが壊れているか、対応していない形式です（対応: {SUPPORTED_LIST}）"
        )
    })?;

    let props = tagged.properties();
    let duration_sec = props.duration().as_secs_f64();
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        // 尺が取れない個体は黙って 0 秒にせず明示エラーへ落とす (設計書リスク欄: m4a 亜種)。
        return Err(format!(
            "音源を読み込めませんでした: {file_name}。ファイルが壊れているか、対応していない形式です（対応: {SUPPORTED_LIST}）"
        ));
    }

    // bps → kbps。audio_bitrate が無ければ overall_bitrate で代替する。
    let bitrate_kbps = props.audio_bitrate().or_else(|| props.overall_bitrate());

    let (title, artist) = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(tag) => (
            clean_tag(tag.title().as_deref()),
            clean_tag(
                tag.artist()
                    .as_deref()
                    .or_else(|| tag.get_string(&ItemKey::AlbumArtist)),
            ),
        ),
        None => (None, None),
    };

    Ok(AudioProbeResult {
        file_name,
        ext,
        duration_sec,
        sample_rate: props.sample_rate(),
        channels: props.channels(),
        bitrate_kbps,
        title,
        artist,
    })
}

/// 音源ファイルのメタデータを返す。失敗は日本語エラー (フロントはそのままトーストに出す)。
#[tauri::command]
pub async fn audio_probe(path: String) -> Result<AudioProbeResult, String> {
    probe_inner(Path::new(&path))
}

/// picker 経由 (`file.path` が取れない) の File bytes を
/// `<GORI CODEX_HOME>/audio_uploads/` に保存してパスを返す。
///
/// `images_write_upload` と同じ流儀だが、保存先を **generated_images と分離する**。
/// 画像 watcher は generated_images 配下を監視しているため、そこに mp3 を置くと
/// ギャラリー / 履歴が汚染される。
///
/// 生バイトは raw payload、`file_name` はヘッダー経由で届く (`src/lib/ipcBytes.ts`)。
/// 旧 `Array.from` + JSON 方式はメモリを 15〜20 倍に増幅していた (2026-08-05 の実害)。
#[tauri::command]
pub async fn audio_write_upload(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = crate::commands::raw_payload::raw_bytes(&request)?;
    let file_name = crate::commands::raw_payload::header_meta(&request, "file-name")
        .unwrap_or_else(|| "audio.mp3".to_string());
    if bytes.is_empty() {
        return Err("音源データが空です".into());
    }
    // UI の 200MB チェックを通っていない呼び出しでも、ここで必ず弾く (Sol指摘 G-3)。
    // 書き出す前に判定するので、上限超のデータがディスクに落ちることはない。
    if bytes.len() as u64 > MAX_AUDIO_BYTES {
        return Err(too_large_error(&sanitize_upload_name(&file_name)));
    }
    let dir = audio_uploads_dir().ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("dir 作成失敗: {e}"))?;

    let safe_name = sanitize_upload_name(&file_name);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = pick_unique(&dir, &format!("audio_{ts}_{safe_name}"))
        .ok_or_else(|| "保存先ファイル名の確保に失敗".to_string())?;
    std::fs::write(&dest, bytes).map_err(|e| format!("write 失敗: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn audio_uploads_dir() -> Option<PathBuf> {
    crate::codex::home::gori_codex_home_path().map(|home| home.join("audio_uploads"))
}

fn sanitize_upload_name(file_name: &str) -> String {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("audio.mp3");
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "audio.mp3".to_string()
    } else {
        out
    }
}

/// 同名衝突を避けて実際に使えるパスを返す。
fn pick_unique(dir: &Path, base: &str) -> Option<PathBuf> {
    let cand = dir.join(base);
    if !cand.exists() {
        return Some(cand);
    }
    let path = Path::new(base);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(base);
    let ext = path.extension().and_then(|s| s.to_str());
    for i in 1..1000 {
        let name = match ext {
            Some(e) => format!("{stem}_{i}.{e}"),
            None => format!("{stem}_{i}"),
        };
        let cand = dir.join(name);
        if !cand.exists() {
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 44 バイトの WAV ヘッダ + 無音 PCM を合成する。
    /// 16bit / mono / sample_rate Hz で `seconds` 秒ぶん。
    fn synth_wav(sample_rate: u32, seconds: u32) -> Vec<u8> {
        let channels: u16 = 1;
        let bits: u16 = 16;
        let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
        let block_align = channels * (bits / 8);
        let data_len = byte_rate * seconds;

        let mut b = Vec::with_capacity(44 + data_len as usize);
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
        b.extend_from_slice(&1u16.to_le_bytes()); // format = PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&sample_rate.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&block_align.to_le_bytes());
        b.extend_from_slice(&bits.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(44 + data_len as usize, 0); // 無音
        b
    }

    #[test]
    fn reads_duration_from_synthetic_wav() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("song.wav");
        std::fs::write(&path, synth_wav(44_100, 3)).unwrap();

        let got = probe_inner(&path).expect("probe should succeed");
        assert_eq!(got.file_name, "song.wav");
        assert_eq!(got.ext, "wav");
        assert!(
            (got.duration_sec - 3.0).abs() <= 0.1,
            "duration_sec = {}",
            got.duration_sec
        );
        assert_eq!(got.sample_rate, Some(44_100));
        assert_eq!(got.channels, Some(1));
    }

    #[test]
    fn broken_bytes_return_err() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("broken.wav");
        std::fs::write(&path, b"not a wav at all, just garbage bytes").unwrap();

        let err = probe_inner(&path).expect_err("broken file must fail");
        assert!(err.contains("音源を読み込めませんでした"), "err = {err}");
        assert!(err.contains("broken.wav"), "err = {err}");
        assert!(err.contains(SUPPORTED_LIST), "err = {err}");
    }

    #[test]
    fn unsupported_extension_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("song.aiff");
        std::fs::write(&path, synth_wav(44_100, 1)).unwrap();

        let err = probe_inner(&path).expect_err("aiff is out of AUDIO_EXTS");
        assert!(err.contains("音源を読み込めませんでした"), "err = {err}");
    }

    #[test]
    fn missing_file_returns_err() {
        let tmp = tempfile::tempdir().unwrap();
        let err = probe_inner(&tmp.path().join("nope.mp3")).expect_err("missing file must fail");
        assert!(err.contains("見つかりません"), "err = {err}");
    }

    /// Sol指摘 G-3: 200MB 超は lofty へ渡す前に拒否する。
    ///
    /// 実体 200MB を書くとテストが遅く CI のディスクも食うため、`set_len` で
    /// **スパースファイル** (中身を書かずに長さだけ伸ばす) を作る。probe_inner が
    /// 見るのは `metadata().len()` なので、この作り方で上限判定を正しく突ける。
    #[test]
    fn oversized_file_rejected_before_parse() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.wav");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_AUDIO_BYTES + 1).unwrap();
        drop(f);

        let err = probe_inner(&path).expect_err("200MB 超は拒否されるべき");
        assert!(err.contains("音源が大きすぎます"), "err = {err}");
        assert!(err.contains("huge.wav"), "err = {err}");
        assert!(err.contains("200MB"), "err = {err}");
    }

    /// 上限ちょうどは通す (境界の片側を固定する。壊れファイル扱いで別エラーになる
    /// のが正しく、「大きすぎます」には**ならない**ことだけを見る)。
    #[test]
    fn at_limit_is_not_rejected_by_size() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("edge.wav");
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(MAX_AUDIO_BYTES).unwrap();
        drop(f);

        let err = probe_inner(&path).expect_err("中身は空なので解析には失敗する");
        assert!(
            !err.contains("音源が大きすぎます"),
            "上限ちょうどをサイズ超過にしてはいけない: {err}"
        );
    }

    #[test]
    fn sanitize_and_unique_are_safe() {
        assert_eq!(sanitize_upload_name("my song.mp3"), "my_song.mp3");
        assert_eq!(sanitize_upload_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_upload_name(""), "audio.mp3");

        let tmp = tempfile::tempdir().unwrap();
        let first = pick_unique(tmp.path(), "a.wav").unwrap();
        std::fs::write(&first, b"x").unwrap();
        let second = pick_unique(tmp.path(), "a.wav").unwrap();
        assert_ne!(first, second);
        assert!(second.to_string_lossy().contains("a_1.wav"));
    }
}
