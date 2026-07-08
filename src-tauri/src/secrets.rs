//! シークレット保存の抽象化。
//!
//! リリースビルドは macOS キーチェーン (keyring クレート) を使う。
//! だが `cargo tauri dev` の開発ビルドはビルドの度にアドホック署名が変わり、
//! キーチェーンが「別アプリ」と見なして毎回パスワード確認ダイアログを出す
//! (2026-07-08 STΛCK 指摘)。開発中はこれが邪魔なので、debug ビルドでは
//! キーチェーンを使わず CODEX_HOME 配下のファイルに平文保存する。
//!
//! 平文ファイルは開発マシンのローカルにしか出ず、配布物には含まれない
//! (debug_assertions は release ビルドで false)。リリース版の挙動は不変。

pub const SERVICE_NAME: &str = "app.codexframefactory";

pub const SUPABASE_ANON_KEY: &str = "supabase_anon_key";
pub const SUPABASE_PROJECT_URL: &str = "supabase_project_url";
pub const SUPABASE_BUCKET: &str = "supabase_bucket_name";

/// 開発ビルドでシークレットを平文保存するファイルパス。
/// GORI 専用 CODEX_HOME 配下に置き、`~/.codex` と混ざらないようにする。
/// 専用 HOME が解決できない場合はシステム一時ディレクトリにフォールバックする。
#[cfg(debug_assertions)]
fn dev_store_path() -> std::path::PathBuf {
    crate::codex::home::gori_codex_home_path()
        .unwrap_or_else(std::env::temp_dir)
        .join("dev-secrets.json")
}

#[cfg(debug_assertions)]
fn dev_load() -> std::collections::HashMap<String, String> {
    let path = dev_store_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn dev_save(map: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = dev_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir dev-secrets: {e}"))?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("write dev-secrets: {e}"))
}

/// キー value を保存する。debug=ファイル / release=キーチェーン。
pub fn store_set(key: &str, value: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_load();
        map.insert(key.to_string(), value.to_string());
        return dev_save(&map);
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }
}

/// キーの値を取得する。未保存は Ok(None)。
pub fn store_get(key: &str) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        return Ok(dev_load().get(key).cloned());
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// キーを削除する。未保存でも Ok。
pub fn store_delete(key: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let mut map = dev_load();
        map.remove(key);
        return dev_save(&map);
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
