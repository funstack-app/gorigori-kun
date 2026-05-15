mod cloud;
mod codex;
mod commands;
mod edit;
mod events;
mod images;
mod secrets;
mod segmentation;
mod state;
mod storage_cleanup;

use sqlx::Row as _;
use state::AppState;
use tauri::Manager;

async fn apply_provider_model_migration(pool: &sqlx::SqlitePool) -> Result<(), String> {
    let _migration_003 = include_str!("../migrations/003_provider_model.sql");
    let rows = sqlx::query("PRAGMA table_info(turns)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("migration 003 table_info failed: {e}"))?;
    let existing: std::collections::HashSet<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();
    for (column, sql) in [
        ("provider", "ALTER TABLE turns ADD COLUMN provider TEXT"),
        (
            "model_job_set_type",
            "ALTER TABLE turns ADD COLUMN model_job_set_type TEXT",
        ),
        (
            "model_display_name",
            "ALTER TABLE turns ADD COLUMN model_display_name TEXT",
        ),
    ] {
        if !existing.contains(column) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("migration 003 add {column} failed: {e}"))?;
        }
    }
    Ok(())
}

fn log_dir() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Logs/gori-gori-kun"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(home.join(".local/state/gori-gori-kun"))
    }
}

#[doc(hidden)]
pub mod __test_support {
    pub use crate::codex::process::{resolve_codex_binary, spawn_app_server, AppServerProcess};
    pub use crate::codex::rpc::{handshake, RpcClient, RpcHandle};
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("info,codex_frame_factory_lib=debug,codex=debug")
    });

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr));

    // Best-effort: also write to ~/Library/Logs/gori-gori-kun/gori-gori-kun.log
    // (or platform equivalent). If we can't open the file we just keep stderr.
    let log_dir = log_dir();
    if let Some(dir) = log_dir.as_ref() {
        let _ = std::fs::create_dir_all(dir);
        let appender = tracing_appender::rolling::daily(dir, "gori-gori-kun.log");
        // We deliberately leak the guard for the lifetime of the process so the
        // background writer keeps draining; otherwise lines are dropped on
        // panic-free exits.
        let (writer, guard) = tracing_appender::non_blocking(appender);
        Box::leak(Box::new(guard));
        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(writer)
            .with_ansi(false);
        registry.with(file_layer).init();
        tracing::info!(target: "codex", "log dir: {}", dir.display());
    } else {
        registry.init();
    }

    let state = AppState::default();
    let state_for_setup = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(move |app| {
            // Initialize the SQLite session-history pool synchronously
            // at startup so every command-side `state.db_pool().await`
            // returns a ready pool. We avoid `tauri-plugin-sql` because
            // its pool is only created when the frontend explicitly
            // calls `Database.load(url)` — adding an extra hop and a
            // capability requirement that's easy to miss.
            tauri::async_runtime::block_on(commands::storage::initialize_storage(&state_for_setup))
                .map_err(|e| {
                    tracing::error!(target: "codex.storage", "storage init failed: {e}");
                    Box::<dyn std::error::Error>::from(e)
                })?;
            crate::cloud::sync_worker::spawn_background_sync();
            crate::storage_cleanup::spawn_background_cleanup();

            let app_data_dir = app
                .handle()
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir failed: {e}"))?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("history.db");
            let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
            tracing::info!(target: "codex.sessions", "db url: {db_url}");

            let state_for_init = state_for_setup.clone();
            tauri::async_runtime::block_on(async move {
                use sqlx::sqlite::SqlitePoolOptions;
                let pool = SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect(&db_url)
                    .await
                    .map_err(|e| format!("sqlite connect failed: {e}"))?;
                // Foreign-key checks must be enabled explicitly per
                // connection — SQLite ships with them OFF.
                sqlx::query("PRAGMA foreign_keys = ON")
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("PRAGMA foreign_keys failed: {e}"))?;
                // Apply migrations idempotently. They're CREATE TABLE
                // IF NOT EXISTS so re-running on an existing DB is safe.
                sqlx::raw_sql(include_str!("../migrations/001_init.sql"))
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("migration 001 failed: {e}"))?;
                sqlx::raw_sql(include_str!("../migrations/002_dedup_images.sql"))
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("migration 002 failed: {e}"))?;
                apply_provider_model_migration(&pool).await?;
                state_for_init.set_db(pool).await;
                tracing::info!(target: "codex.sessions", "db ready at {}", db_path.display());
                Ok::<(), String>(())
            })
            .map_err(|e| {
                tracing::error!(target: "codex.sessions", "db init failed: {e}");
                Box::<dyn std::error::Error>::from(e)
            })?;
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::codex_start,
            commands::codex_restart,
            commands::codex_request,
            commands::codex_resolve_server_request,
            commands::codex_status,
            commands::cloud_supabase::supabase_test_connection,
            commands::cloud_supabase::supabase_save_config,
            commands::cloud_supabase::supabase_get_config,
            commands::cloud_supabase::supabase_disconnect,
            commands::cloud_supabase::supabase_usage,
            commands::cloud_supabase::supabase_sync_now,
            commands::codex_text::codex_text_query,
            commands::codex_vision::codex_describe_image,
            commands::edit_models::edit_models_list,
            commands::edit_models::edit_models_download,
            commands::edit_models::edit_models_delete,
            commands::edit_export::edit_export_psd,
            commands::edit_fonts::edit_fonts_list,
            commands::edit_sam2::edit_sam2_embed,
            commands::edit_sam2::edit_sam2_predict,
            commands::edit_ocr::edit_ocr_detect,
            commands::edit_inpaint::edit_inpaint_run,
            commands::edit_magic::edit_magic_run,
            commands::edit_segment::edit_segment_run,
            commands::storage_cleanup::storage_cleanup_run,
            commands::storage_cleanup::storage_cleanup_inspect,
            commands::auth::auth_read,
            commands::auth::auth_login_api_key,
            commands::auth::auth_login_chatgpt,
            commands::auth::auth_login_chatgpt_device_code,
            commands::auth::auth_logout,
            commands::images::images_start_watcher,
            commands::images::images_save_to_project,
            commands::images::images_reveal_in_finder,
            commands::images::images_write_mask,
            commands::images::images_save_as,
            commands::images::images_rename,
            commands::images::images_save_as_format,
            commands::images::images_remove_background,
            commands::images::images_write_clipboard,
            commands::images::images_write_upload,
            commands::layer_splitter::layer_splitter_run,
            commands::higgsfield::higgsfield_status,
            commands::higgsfield::higgsfield_login,
            commands::higgsfield::higgsfield_logout,
            commands::higgsfield::higgsfield_list_models,
            commands::higgsfield::higgsfield_account,
            commands::higgsfield::higgsfield_generate_batch,
            commands::higgsfield::higgsfield_generate_compare,
            commands::higgsfield::higgsfield_cancel_batch,
            commands::higgsfield::higgsfield_generate_cost,
            commands::secrets::secret_set,
            commands::secrets::secret_get,
            commands::secrets::secret_delete,
            commands::secrets::secret_list,
            commands::storage::storage_get_settings,
            commands::storage::storage_set_settings,
            commands::storage::storage_migrate_from_codex_home,
            commands::storage::storage_legacy_summary,
            commands::storage::storage_usage_stats,
            commands::storage::storage_home_dir,
            commands::stock::stock_search,
            commands::stock::stock_download,
            commands::translate::translate_ja_to_en,
            commands::mcp::mcp_list,
            commands::mcp::mcp_upsert,
            commands::mcp::mcp_delete,
            commands::batch_gen::images_generate_batch,
            commands::sessions::sessions_list,
            commands::sessions::session_create,
            commands::sessions::session_rename,
            commands::sessions::session_delete,
            commands::sessions::session_get_full,
            commands::sessions::turn_record,
            commands::sessions::image_record,
            commands::sessions::session_export,
            commands::sessions::turns_recent,
            commands::sessions::turn_get,
            commands::segment::segment_image,
            commands::segment::is_segmentation_model_ready,
            commands::segment::download_segmentation_model,
            commands::storyboard::storyboard_run,
            commands::storyboard::storyboard_read_debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
