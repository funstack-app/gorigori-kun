use tauri::State;

use crate::cloud::supabase_client::{CloudUsage, SupabaseClient, SupabaseConfig};
use crate::cloud::sync_worker::{sync_storage_root, SyncResult};
use crate::commands::storage::StorageSettings;
use crate::secrets::{self, SUPABASE_ANON_KEY};
use crate::state::AppState;

#[tauri::command]
pub async fn supabase_test_connection(config: SupabaseConfig) -> Result<(), String> {
    validate_config(&config)?;
    let client = SupabaseClient::new(config);
    client.test_connection().await
}

#[tauri::command]
pub async fn supabase_save_config(
    state: State<'_, AppState>,
    config: SupabaseConfig,
) -> Result<(), String> {
    validate_config(&config)?;
    secrets::store_set(SUPABASE_ANON_KEY, config.anon_key.trim())?;

    let mut settings = StorageSettings::load()?;
    settings.cloud_supabase_enabled = true;
    settings.supabase_project_url =
        Some(config.project_url.trim().trim_end_matches('/').to_string());
    settings.supabase_bucket_name = Some(config.bucket_name.trim().to_string());
    settings.save()?;
    state.set_storage_settings(settings).await;
    Ok(())
}

#[tauri::command]
pub async fn supabase_get_config() -> Result<Option<SupabaseConfig>, String> {
    load_saved_config()
}

#[tauri::command]
pub async fn supabase_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    secrets::store_delete(SUPABASE_ANON_KEY)?;

    let mut settings = StorageSettings::load()?;
    settings.cloud_supabase_enabled = false;
    settings.supabase_project_url = None;
    settings.supabase_bucket_name = None;
    settings.save()?;
    state.set_storage_settings(settings).await;
    Ok(())
}

#[tauri::command]
pub async fn supabase_usage() -> Result<CloudUsage, String> {
    let config = load_saved_config()?.ok_or_else(|| "Supabase が未連携です".to_string())?;
    SupabaseClient::new(config).get_usage().await
}

#[tauri::command]
pub async fn supabase_sync_now() -> Result<SyncResult, String> {
    supabase_sync_now_core().await
}

pub async fn supabase_sync_now_core() -> Result<SyncResult, String> {
    let config = load_saved_config()?.ok_or_else(|| "Supabase が未連携です".to_string())?;
    let settings = StorageSettings::load()?;
    sync_storage_root(config, settings.storage_root).await
}

fn load_saved_config() -> Result<Option<SupabaseConfig>, String> {
    let settings = StorageSettings::load()?;
    if !settings.cloud_supabase_enabled {
        return Ok(None);
    }
    let Some(anon_key) = secrets::store_get(SUPABASE_ANON_KEY)? else {
        return Ok(None);
    };
    let Some(project_url) = settings.supabase_project_url else {
        return Ok(None);
    };
    let Some(bucket_name) = settings.supabase_bucket_name else {
        return Ok(None);
    };
    Ok(Some(SupabaseConfig {
        project_url,
        anon_key,
        bucket_name,
    }))
}

fn validate_config(config: &SupabaseConfig) -> Result<(), String> {
    let url = config.project_url.trim();
    if !url.starts_with("https://") || !url.contains(".supabase.co") {
        return Err("Project URL は https://xxx.supabase.co の形式で入力してください".into());
    }
    if config.anon_key.trim().is_empty() {
        return Err("anon key を入力してください".into());
    }
    if config.bucket_name.trim().is_empty() {
        return Err("バケット名を入力してください".into());
    }
    Ok(())
}
