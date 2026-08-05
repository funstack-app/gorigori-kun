//! raw payload (生バイト) で invoke されたコマンドの受け口ヘルパ (2026-08-06)。
//!
//! ## なぜ要るか（実害）
//!
//! 2026-08-05、9 枚の画像貼り付け中にアプリがクラッシュし、プリセット 30 体消失の
//! 引き金になった。真因はフロント側の転送方式で、`Array.from(Uint8Array)` +
//! JSON シリアライズにより **元サイズの 15〜20 倍の一時メモリスパイク**が出ていた。
//!
//! 対策として `invoke` に `Uint8Array` を直接渡す Tauri 2 の raw payload へ移行した。
//! その受け側がこのモジュール。`InvokeBody::Raw` から `Vec<u8>` を取り出し、
//! 同伴する文字列メタは **ヘッダー**から復元する。
//!
//! ## メタはヘッダー・非 ASCII は percent-encoding
//!
//! raw payload はバイト列 1 本しか運べないため、`srcPath` / `fileName` はヘッダーへ回す。
//! ヘッダーは非 ASCII を安全に運べないので、フロントは `encodeURIComponent` で符号化し、
//! こちらで復号する。日本語ファイル名を壊さないための対です。
//! 参照: `src/lib/ipcBytes.ts`

use tauri::ipc::{InvokeBody, Request};

/// フロント (`src/lib/ipcBytes.ts`) と揃えるヘッダー名の接頭辞。
const HEADER_PREFIX: &str = "x-gori-";

/// raw payload の本体バイト列を取り出す。
///
/// JSON body で呼ばれた場合は明示的にエラーにする。黙って空扱いにすると
/// 「保存されたのに 0 バイト」という静かな破損になるため。
pub fn raw_bytes<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(
            "内部エラー: 画像データが生バイトで届いていません（アプリの更新が必要な可能性があります）"
                .to_string(),
        ),
    }
}

/// ヘッダーから文字列メタを取り出して percent-decode する。
///
/// 見つからない場合は `None`。呼び出し側が既定値を決める。
pub fn header_meta(request: &Request<'_>, key: &str) -> Option<String> {
    let name = format!("{HEADER_PREFIX}{key}");
    let raw = request.headers().get(&name)?.to_str().ok()?;
    Some(percent_decode(raw))
}

/// `encodeURIComponent` の逆変換。
///
/// 外部 crate を足さずに済ませるための最小実装。`%XX` を 1 バイトに戻し、
/// UTF-8 として解釈する。不正なシーケンスは元の文字をそのまま残す
/// （壊れた入力で保存自体を落とすより、名前が多少崩れても保存を通す方が実害が小さい）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_ascii_unchanged() {
        assert_eq!(percent_decode("plain-name.png"), "plain-name.png");
    }

    #[test]
    fn decodes_japanese_file_name() {
        // encodeURIComponent("猫.png")
        assert_eq!(percent_decode("%E7%8C%AB.png"), "猫.png");
    }

    #[test]
    fn decodes_path_with_spaces_and_slashes() {
        // encodeURIComponent("/a b/c.png")
        assert_eq!(percent_decode("%2Fa%20b%2Fc.png"), "/a b/c.png");
    }

    #[test]
    fn leaves_malformed_sequence_as_is() {
        assert_eq!(percent_decode("%ZZ.png"), "%ZZ.png");
        assert_eq!(percent_decode("trailing%"), "trailing%");
    }
}
