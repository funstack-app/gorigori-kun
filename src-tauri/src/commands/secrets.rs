use crate::secrets::{
    self, SUPABASE_ANON_KEY, SUPABASE_BUCKET, SUPABASE_PROJECT_URL,
};

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    eprintln!("[secret_set] key={} value_len={}", key, value.len());
    secrets::store_set(&key, &value).map_err(|e| {
        eprintln!("[secret_set] store_set failed: {e}");
        e
    })?;
    eprintln!("[secret_set] OK key={}", key);
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::store_get(&key)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    secrets::store_delete(&key)
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
        // unsplash_access_key は法務対応 (2026-05-21) で撤去。
        // 過去に保存されたキーはキーチェーンに残るが、ここで列挙しないため
        // secret_list には現れなくなる。
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
        match secrets::store_get(key) {
            Ok(Some(_)) => found.push(key.to_string()),
            Ok(None) => {
                // 未保存、これは正常
            }
            Err(e) => {
                eprintln!("[secret_list] store_get({}) error: {}", key, e);
            }
        }
    }
    eprintln!("[secret_list] found: {:?}", found);
    Ok(found)
}
