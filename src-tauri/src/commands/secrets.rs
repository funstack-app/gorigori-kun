use keyring::Entry;

use crate::secrets::{SERVICE_NAME, SUPABASE_ANON_KEY, SUPABASE_BUCKET, SUPABASE_PROJECT_URL};

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    eprintln!("[secret_set] key={} value_len={}", key, value.len());
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| {
        eprintln!("[secret_set] Entry::new failed: {e}");
        e.to_string()
    })?;
    entry.set_password(&value).map_err(|e| {
        eprintln!("[secret_set] set_password failed: {e}");
        e.to_string()
    })?;
    eprintln!("[secret_set] OK key={}", key);
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_list() -> Result<Vec<String>, String> {
    eprintln!("[secret_list] called");
    let known = [
        "openai_api_key",
        "anthropic_api_key",
        "replicate_api_token",
        "fal_api_key",
        "stability_api_key",
        "google_api_key",
        "bfl_api_key",
        "ideogram_api_key",
        "recraft_api_key",
        "runway_api_key",
        "luma_api_key",
        "pika_api_key",
        "elevenlabs_api_key",
        "magnific_api_key",
        "unsplash_access_key",
        "pexels_api_key",
        "pixabay_api_key",
        "tripo_api_key",
        "meshy_api_key",
        SUPABASE_ANON_KEY,
        SUPABASE_PROJECT_URL,
        SUPABASE_BUCKET,
    ];
    let mut found = Vec::new();
    for key in known {
        match Entry::new(SERVICE_NAME, key) {
            Ok(entry) => match entry.get_password() {
                Ok(_) => {
                    found.push(key.to_string());
                }
                Err(keyring::Error::NoEntry) => {
                    // 未保存、これは正常
                }
                Err(e) => {
                    eprintln!("[secret_list] get_password({}) error: {}", key, e);
                }
            },
            Err(e) => {
                eprintln!("[secret_list] Entry::new({}) error: {}", key, e);
            }
        }
    }
    eprintln!("[secret_list] found: {:?}", found);
    Ok(found)
}
