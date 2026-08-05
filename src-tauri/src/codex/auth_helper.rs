//! MCP 認可専用の補助バイナリ (codex-auth) を **オンデマンドで取得** する。
//!
//! ## なぜ同梱をやめたか (2026-08-06)
//!
//! codex-auth は codex CLI 本体そのもの (0.147.0-alpha.4) で、展開後 200〜290MB ある。
//! これを `bundle.resources` に同梱した結果、**Windows の更新 DL が 518MB** に達した。
//! Tauri updater は更新アーカイブを **全体をメモリに載せてから** 署名検証するため、
//! この大きさでは「アプデを確認 → 更新する」が Windows で失敗する
//! (v2.5.1 で実際にユーザーが更新できなくなった)。
//!
//! codex-auth を使うのは **MCP の認可 2 操作 (`mcp add` / `mcp login`) だけ** で、
//! 生成・日常実行は同梱 0.146.0 が担う。つまり「全ユーザーが常時持つ必要はなく、
//! Magnific / Higgsfield を繋ぐ人だけが 1 回落とせばよい」性質のものだった。
//! そこで同梱をやめ、接続時にその場で取得して data_dir にキャッシュする。
//!
//! 取得に失敗しても **接続処理は止めない**。従来どおり同梱 0.146.0 へフォールバックし、
//! issuer バグが出た場合は既存のエラー文言でユーザーに次の一手を示す。
//!
//! ## 0.147.0 安定版が出たら
//!
//! 本モジュールごと撤去し、同梱 codex 一本に戻せる (2026-08-05 時点では
//! alpha.10 までしか無く、安定版は未リリース)。

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

/// 取得する codex のリリースタグ。**バージョンの正本はここ 1 箇所**。
/// CLI 0.143〜0.146 の iss 破棄バグ (openai/codex PR #35720) の修正が入る最初の版。
const CODEX_AUTH_VERSION: &str = "rust-v0.147.0-alpha.4";

/// GitHub Releases のダウンロード基底 URL (末尾はタグ)。
const CODEX_RELEASE_BASE: &str = "https://github.com/openai/codex/releases/download";

/// data_dir に置くキャッシュファイル名 (拡張子は plaform 別に付ける)。
const CACHE_STEM: &str = "codex-auth";

/// 壊れ DL とみなす下限サイズ。codex CLI は 100MB 級なので、これを下回るものは
/// 中身が違う (HTML エラーページ・途中で切れた本体など)。
///
/// CI の同梱ステップが使っていた閾値と同じ値を、こちら側の唯一の正本として持つ。
/// **1 箇所でだけ定義する** (取得直後の検査とキャッシュ採用時の検査で共用)。
pub const MIN_CODEX_AUTH_BYTES: u64 = 10 * 1024 * 1024;

/// キャッシュした codex-auth のファイル名 (`codex-auth` / `codex-auth.exe`)。
pub fn cache_file_name() -> &'static str {
    if cfg!(windows) {
        "codex-auth.exe"
    } else {
        CACHE_STEM
    }
}

/// オンデマンド取得した codex-auth を置くパス。
///
/// `~/Library/Application Support/app.codexframefactory/codex-auth` (macOS) /
/// `%APPDATA%\app.codexframefactory\codex-auth.exe` (Windows) /
/// `~/.local/share/app.codexframefactory/codex-auth` (Linux)。
///
/// 既存の CODEX_HOME 解決 (`codex::home`) と同じ `dirs::data_dir()` +
/// `secrets::SERVICE_NAME` を土台にする (保存先の流儀を増やさない)。
pub fn codex_auth_cache_path() -> Option<PathBuf> {
    dirs::data_dir().map(|data| {
        data.join(crate::secrets::SERVICE_NAME)
            .join(cache_file_name())
    })
}

/// ファイルが「使える codex-auth」かを判定する。
///
/// 存在するだけでは信じない。途中で落ちた DL・HTML エラーページが残っていると
/// spawn しても意味不明なエラーになるため、サイズ下限で弾く。
pub fn is_usable_codex_auth(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.len() >= MIN_CODEX_AUTH_BYTES,
        Err(_) => false,
    }
}

/// 現在のプラットフォーム向けのアセット名と、アーカイブ内のバイナリ名を返す。
///
/// 返り値は `(アセット名, アーカイブ内のファイル名)`。
/// 未対応プラットフォーム (Linux 等) では `None` (= オンデマンド取得なし。
/// 従来どおり同梱 codex / PATH の codex にフォールバックする)。
pub fn asset_for_current_platform() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some((
            "codex-aarch64-apple-darwin.tar.gz",
            "codex-aarch64-apple-darwin",
        )),
        ("macos", "x86_64") => Some((
            "codex-x86_64-apple-darwin.tar.gz",
            "codex-x86_64-apple-darwin",
        )),
        ("windows", "x86_64") => Some((
            "codex-x86_64-pc-windows-msvc.exe.zip",
            "codex-x86_64-pc-windows-msvc.exe",
        )),
        _ => None,
    }
}

/// 取得元 URL を組み立てる。バージョン定数はここでしか読まない。
pub fn asset_url(asset: &str) -> String {
    format!("{CODEX_RELEASE_BASE}/{CODEX_AUTH_VERSION}/{asset}")
}

/// codex-auth を GitHub Releases から取得し、data_dir にキャッシュして
/// そのパスを返す。**既にキャッシュ済みなら何もせずそのパスを返す** (冪等)。
///
/// 失敗しても panic しない。呼び出し側は `Err` を受けてフォールバックを続行する。
pub async fn ensure_codex_auth() -> Result<PathBuf> {
    let dest = codex_auth_cache_path()
        .ok_or_else(|| anyhow!("アプリのデータ保存先を解決できませんでした"))?;

    if is_usable_codex_auth(&dest) {
        return Ok(dest);
    }

    let (asset, inner_name) = asset_for_current_platform().ok_or_else(|| {
        anyhow!(
            "この環境 ({} / {}) 向けの接続コンポーネントは配布されていません",
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    })?;

    let url = asset_url(asset);
    tracing::info!(
        target: "mcp.auth",
        url = %url,
        dest = %dest.display(),
        "接続コンポーネント (codex-auth) をダウンロードします"
    );

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| anyhow!("保存先の作成に失敗しました: {e}"))?;
    }

    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| anyhow!("接続コンポーネントの取得に失敗しました: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow!("接続コンポーネントの取得に失敗しました: {e}"))?
        .bytes()
        .await
        .map_err(|e| anyhow!("接続コンポーネントの読み込みに失敗しました: {e}"))?;

    // 展開は CPU バウンド (数百MB の gzip/deflate)。async ランタイムを塞がない。
    let asset_owned = asset.to_string();
    let inner_owned = inner_name.to_string();
    let binary = tokio::task::spawn_blocking(move || {
        extract_codex_binary(&asset_owned, &inner_owned, &bytes)
    })
    .await
    .map_err(|e| anyhow!("接続コンポーネントの展開に失敗しました: {e}"))??;

    // 取得後のサイズ検査。壊れ DL をキャッシュに昇格させない。
    if (binary.len() as u64) < MIN_CODEX_AUTH_BYTES {
        return Err(anyhow!(
            "接続コンポーネントのサイズが不正です ({} bytes)。ネットワークを確認してもう一度お試しください。",
            binary.len()
        ));
    }

    write_atomically(&dest, &binary).await?;

    tracing::info!(
        target: "mcp.auth",
        dest = %dest.display(),
        bytes = binary.len(),
        "接続コンポーネント (codex-auth) の準備が完了しました"
    );
    Ok(dest)
}

/// tar.gz / zip アーカイブから目的のバイナリ 1 本を取り出す。
///
/// アーカイブ内のパスは `codex-x86_64-.../codex-x86_64-...` のように階層を持つ
/// ことがあるため、**ファイル名一致** で探す (CI の `find -name` / PowerShell の
/// `Where-Object { $_.Name -eq ... }` と同じ判定)。
fn extract_codex_binary(asset: &str, inner_name: &str, data: &[u8]) -> Result<Vec<u8>> {
    if asset.ends_with(".zip") {
        extract_from_zip(inner_name, data)
    } else if asset.ends_with(".tar.gz") {
        extract_from_tar_gz(inner_name, data)
    } else {
        Err(anyhow!("未知のアーカイブ形式です: {asset}"))
    }
}

fn extract_from_zip(inner_name: &str, data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;

    let cursor = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| anyhow!("zip を読めませんでした: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| anyhow!("zip の要素を読めませんでした: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let matches = Path::new(entry.name())
            .file_name()
            .map(|n| n == inner_name)
            .unwrap_or(false);
        if !matches {
            continue;
        }
        let mut out = Vec::new();
        entry
            .read_to_end(&mut out)
            .map_err(|e| anyhow!("zip の展開に失敗しました: {e}"))?;
        return Ok(out);
    }
    Err(anyhow!("zip に {inner_name} が含まれていませんでした"))
}

fn extract_from_tar_gz(inner_name: &str, data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;

    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
    let mut archive = tar::Archive::new(decoder);

    let entries = archive
        .entries()
        .map_err(|e| anyhow!("tar を読めませんでした: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| anyhow!("tar の要素を読めませんでした: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| anyhow!("tar のパスを読めませんでした: {e}"))?
            .into_owned();
        let matches = path
            .file_name()
            .map(|n| n == inner_name)
            .unwrap_or(false);
        if !matches {
            continue;
        }
        let mut out = Vec::new();
        entry
            .read_to_end(&mut out)
            .map_err(|e| anyhow!("tar の展開に失敗しました: {e}"))?;
        return Ok(out);
    }
    Err(anyhow!("tar に {inner_name} が含まれていませんでした"))
}

/// 一時ファイルへ書いてから rename する。
///
/// なぜアトミックにするか: 途中で落ちた半端なファイルが本パスに残ると、次回起動時に
/// 「キャッシュがある」と判定されて壊れたバイナリを spawn してしまう。サイズ検査で
/// 大半は弾けるが、10MB を超えた時点で切れた場合は通ってしまう。
async fn write_atomically(dest: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = dest.with_extension("download-tmp");
    let _ = tokio::fs::remove_file(&tmp).await;

    tokio::fs::write(&tmp, bytes)
        .await
        .map_err(|e| anyhow!("接続コンポーネントの保存に失敗しました: {e}"))?;

    set_executable(&tmp)?;

    if let Err(e) = tokio::fs::rename(&tmp, dest).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(anyhow!("接続コンポーネントの配置に失敗しました: {e}"));
    }
    Ok(())
}

/// Unix では実行権限を付ける。Windows では何もしない (拡張子で判断されるため)。
fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| anyhow!("権限の取得に失敗しました: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| anyhow!("実行権限の付与に失敗しました: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// URL 組み立てとアセット名の対応が壊れていないこと。
    /// バージョンは定数 1 箇所からしか読まない (二重定義の検出)。
    #[test]
    fn asset_url_uses_the_single_version_constant() {
        let url = asset_url("codex-x86_64-pc-windows-msvc.exe.zip");
        assert!(url.starts_with(CODEX_RELEASE_BASE), "url = {url}");
        assert!(url.contains(CODEX_AUTH_VERSION), "url = {url}");
        assert!(url.ends_with("codex-x86_64-pc-windows-msvc.exe.zip"), "url = {url}");
    }

    /// アーカイブ名と中のバイナリ名が対応していること
    /// (`.zip` には `.exe`、`.tar.gz` には拡張子なし)。
    #[test]
    fn asset_for_current_platform_is_self_consistent() {
        let Some((asset, inner)) = asset_for_current_platform() else {
            // 未対応プラットフォーム。オンデマンド取得はせずフォールバックする。
            return;
        };
        if asset.ends_with(".zip") {
            assert!(inner.ends_with(".exe"), "zip の中身は exe: {inner}");
        } else {
            assert!(asset.ends_with(".tar.gz"), "asset = {asset}");
            assert!(!inner.ends_with(".exe"), "tar.gz の中身は exe ではない: {inner}");
        }
        // アーカイブ名は「中のバイナリ名 + 圧縮拡張子」になっている。
        assert!(asset.starts_with(inner), "asset = {asset} / inner = {inner}");
    }

    /// キャッシュ名がプラットフォームと一致すること。
    #[test]
    fn cache_file_name_matches_platform() {
        if cfg!(windows) {
            assert_eq!(cache_file_name(), "codex-auth.exe");
        } else {
            assert_eq!(cache_file_name(), "codex-auth");
        }
    }

    /// 小さすぎるファイルはキャッシュとして採用しない (壊れ DL 検出)。
    /// **サイズはハードコードせず閾値定数から導く**。
    #[test]
    fn small_file_is_not_usable() {
        let dir = std::env::temp_dir().join(format!("gori-auth-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let small = dir.join("small.bin");
        std::fs::write(&small, vec![0u8; 1024]).expect("write");
        assert!(!is_usable_codex_auth(&small));

        // 存在しないパスも当然 usable でない。
        assert!(!is_usable_codex_auth(&dir.join("missing.bin")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 閾値ちょうどのファイルは採用される (境界の向きが逆転していないことの確認)。
    #[test]
    fn file_at_threshold_is_usable() {
        let dir = std::env::temp_dir().join(format!("gori-auth-th-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let big = dir.join("threshold.bin");
        std::fs::write(&big, vec![0u8; MIN_CODEX_AUTH_BYTES as usize]).expect("write");
        assert!(is_usable_codex_auth(&big));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// zip / tar.gz からファイル名一致で 1 本取り出せること
    /// (アーカイブ内が階層を持っていても拾えるか)。
    #[test]
    fn extract_finds_binary_by_file_name_in_nested_archive() {
        // zip: サブディレクトリの下に置く。
        let mut buf = Vec::new();
        {
            use std::io::Write;
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            w.start_file("nested/dir/codex-x86_64-pc-windows-msvc.exe", opts)
                .expect("start_file");
            w.write_all(b"WINDOWS-BINARY").expect("write");
            w.start_file("nested/other.txt", opts).expect("start_file");
            w.write_all(b"noise").expect("write");
            w.finish().expect("finish");
        }
        let got = extract_codex_binary(
            "codex-x86_64-pc-windows-msvc.exe.zip",
            "codex-x86_64-pc-windows-msvc.exe",
            &buf,
        )
        .expect("zip 展開");
        assert_eq!(got, b"WINDOWS-BINARY");

        // tar.gz: 同じくサブディレクトリの下。
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            let payload = b"MAC-BINARY";
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "nested/codex-aarch64-apple-darwin",
                    &payload[..],
                )
                .expect("append");
            builder.finish().expect("finish");
        }
        let mut gz = Vec::new();
        {
            use std::io::Write;
            let mut enc = flate2::write::GzEncoder::new(&mut gz, flate2::Compression::fast());
            enc.write_all(&tar_buf).expect("gz write");
            enc.finish().expect("gz finish");
        }
        let got = extract_codex_binary(
            "codex-aarch64-apple-darwin.tar.gz",
            "codex-aarch64-apple-darwin",
            &gz,
        )
        .expect("tar.gz 展開");
        assert_eq!(got, b"MAC-BINARY");

        // 目的のファイルが無いアーカイブでは失敗する (見つからないのに成功しない)。
        assert!(extract_codex_binary(
            "codex-aarch64-apple-darwin.tar.gz",
            "not-in-archive",
            &gz,
        )
        .is_err());
    }
}
