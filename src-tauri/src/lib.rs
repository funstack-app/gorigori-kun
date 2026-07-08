// 実装途中の部品（編集タブ等で今後使う関数・構造体）に対する
// 未使用警告を抑制する。リリース前に一度外して棚卸しすること。
#![allow(dead_code, unused_imports)]

mod cloud;
mod codex;
mod commands;
mod edit;
mod events;
mod images;
mod secrets;
mod segmentation;
mod skill_install;
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

async fn apply_media_type_migration(pool: &sqlx::SqlitePool) -> Result<(), String> {
    let _migration_004 = include_str!("../migrations/004_media_type.sql");
    let rows = sqlx::query("PRAGMA table_info(images)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("migration 004 table_info failed: {e}"))?;
    let existing: std::collections::HashSet<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect();
    for (column, sql) in [
        (
            "media_type",
            "ALTER TABLE images ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'",
        ),
        (
            "duration_seconds",
            "ALTER TABLE images ADD COLUMN duration_seconds INTEGER",
        ),
        (
            "thumbnail_path",
            "ALTER TABLE images ADD COLUMN thumbnail_path TEXT",
        ),
    ] {
        if !existing.contains(column) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("migration 004 add {column} failed: {e}"))?;
        }
    }
    Ok(())
}

pub fn log_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Logs/gori-gori-kun"))
    }
    #[cfg(target_os = "windows")]
    {
        // Windows 規約: %APPDATA%\gori-gori-kun\logs
        dirs::data_dir().map(|d| d.join("gori-gori-kun").join("logs"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        dirs::home_dir().map(|h| h.join(".local/state/gori-gori-kun"))
    }
}

#[doc(hidden)]
pub mod __test_support {
    pub use crate::codex::process::{
        resolve_codex_binary, spawn_app_server, AppServerProcess, StderrBuffer,
    };
    pub use crate::codex::rpc::{handshake, RpcClient, RpcHandle};
}

/// Finder 起動の macOS GUI アプリは login shell の `.zshrc` / `.bashrc` を
/// 読まないため、PATH が `/usr/bin:/bin:/usr/sbin:/sbin` の最小構成になる。
///
/// 結果として Homebrew 配下にインストールされた `node` (Apple Silicon は
/// `/opt/homebrew/bin/node`、Intel は `/usr/local/bin/node`) が見つからず、
/// Higgsfield 拡張パックの `env node` ベースの shebang が
/// `env: node: No such file or directory` で落ちる。
///
/// 修正: アプリ起動時に Homebrew 標準 prefix と `~/.npm-global/bin` を
/// 強制的に PATH 先頭付近に追加する。既存 PATH は維持。
/// (むぎさん Mac Apple Silicon で再現、2026-05-18)
fn ensure_unix_path_for_gui_apps() {
    #[cfg(target_os = "macos")]
    {
        let mut current = std::env::var("PATH").unwrap_or_default();
        // 既に含まれていれば追加しない
        let candidates = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ];
        // ユーザーの npm global (もしあれば)
        let home = std::env::var("HOME").unwrap_or_default();
        let npm_global = format!("{home}/.npm-global/bin");
        let mut additions: Vec<&str> = Vec::new();
        for c in candidates {
            if !current.split(':').any(|p| p == c) {
                additions.push(c);
            }
        }
        let npm_global_str = npm_global.as_str();
        if !npm_global.is_empty() && !current.split(':').any(|p| p == npm_global_str) {
            additions.push(npm_global_str);
        }
        if additions.is_empty() {
            return;
        }
        // 既存 PATH の前に追加 (homebrew を見つけやすくする)
        if current.is_empty() {
            current = additions.join(":");
        } else {
            current = format!("{}:{}", additions.join(":"), current);
        }
        // SAFETY: set_var はマルチスレッドで未定義動作の可能性があるが、
        // run() の冒頭、Tauri ビルダ起動前のシングルスレッド時点で呼ぶため安全。
        unsafe {
            std::env::set_var("PATH", &current);
        }
        eprintln!("[gori] extended PATH for GUI app: {}", current);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_unix_path_for_gui_apps();

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.current_monitor()? {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let target_w = (logical_w * 0.8).clamp(820.0, 1400.0);
                    let target_h = (logical_h * 0.8).clamp(540.0, 900.0);

                    window.set_size(tauri::LogicalSize::new(target_w, target_h))?;
                    window.center()?;

                    tracing::info!(
                        target: "codex.window",
                        "optimized window size: physical={}x{} scale={} logical={:.0}x{:.0} target={:.0}x{:.0}",
                        size.width,
                        size.height,
                        scale,
                        logical_w,
                        logical_h,
                        target_w,
                        target_h,
                    );
                }
            }

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

            // STΛCK 報告 (2026-05-18): Higgsfield 拡張パックの README に
            // 「app.codexframefactory/extensions/ にコピー」と書いてあるが、
            // このディレクトリは存在しない場合がある。初回起動時に強制作成して
            // ユーザーが mkdir なしですぐに extensions/ にドラッグできるようにする。
            let extensions_dir = app_data_dir.join("extensions");
            if let Err(e) = std::fs::create_dir_all(&extensions_dir) {
                tracing::warn!(
                    target: "codex.storage",
                    error = ?e,
                    path = %extensions_dir.display(),
                    "extensions ディレクトリの自動作成に失敗 (起動は続行)"
                );
            } else {
                tracing::info!(
                    target: "codex.storage",
                    path = %extensions_dir.display(),
                    "extensions ディレクトリを確保しました"
                );
            }

            // FB#19: GORI 専用 CODEX_HOME を用意し、初回起動なら ~/.codex から
            // auth/config/skills を冪等にコピー移行する。バンドルスキル展開より
            // 前に呼ぶ — 先に skills/ が作られると移行がスキップされ、ユーザーが
            // ~/.codex/skills に持つ自作スキルが専用 HOME に来なくなるため。
            // 既存 ~/.codex は一切変更しない (読み取りのみ)。
            let _ = crate::codex::home::ensure_gori_codex_home();

            // バンドル同梱スキルを <CODEX_HOME>/skills/ に展開する。
            // (新規ユーザーや mtime 比較で古い場合のみ上書き)
            crate::skill_install::ensure_bundled_skills(&app.handle());

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
                // Apply migrations idempotently. Base/index migrations are
                // IF NOT EXISTS; column migrations check PRAGMA table_info first.
                sqlx::raw_sql(include_str!("../migrations/001_init.sql"))
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("migration 001 failed: {e}"))?;
                sqlx::raw_sql(include_str!("../migrations/002_dedup_images.sql"))
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("migration 002 failed: {e}"))?;
                apply_provider_model_migration(&pool).await?;
                apply_media_type_migration(&pool).await?;
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
            commands::codex_diagnostics,
            commands::skills::skill_import,
            commands::skills::skill_import_zip,
            commands::skills::skill_export_zip,
            commands::skills::skill_export_read,
            commands::skills::skill_list_installed,
            commands::cloud_supabase::supabase_test_connection,
            commands::cloud_supabase::supabase_save_config,
            commands::cloud_supabase::supabase_get_config,
            commands::cloud_supabase::supabase_disconnect,
            commands::cloud_supabase::supabase_usage,
            commands::cloud_supabase::supabase_sync_now,
            commands::codex_text::codex_text_query,
            commands::codex_vision::codex_describe_image,
            commands::codex_vision::codex_list_image_objects,
            commands::edit_models::edit_models_list,
            commands::edit_models::edit_models_download,
            commands::edit_models::edit_models_delete,
            commands::edit_models::edit_platform_info,
            commands::edit_export::edit_export_psd,
            commands::edit_export::edit_export_png,
            commands::edit_fonts::edit_fonts_list,
            commands::edit_sam2::edit_sam2_embed,
            commands::edit_sam2::edit_sam2_predict,
            commands::edit_ocr::edit_ocr_detect,
            commands::edit_inpaint::edit_inpaint_run,
            commands::edit_grab::edit_grab_object,
            commands::edit_magic::edit_magic_run,
            commands::edit_words::edit_words_segment,
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
            commands::images::images_delete,
            commands::images::images_delete_many,
            commands::images::images_relink_missing,
            commands::images::images_write_clipboard,
            commands::images::images_write_upload,
            commands::images::images_export_resized,
            commands::layer_splitter::layer_splitter_run,
            // 2026-06-10 段階8: CLI 同梱方式の higgsfield_* コマンドは削除。Higgsfield 連携は
            // 下の higgsfield_mcp_* (MCP 接続方式) に一本化した (higgsfield.rs も削除済み)。
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
            commands::storage::projects_read,
            commands::storage::projects_write,
            commands::storage::projects_list_backups,
            commands::storage::projects_read_backup,
            commands::storage::projects_set_data_root,
            commands::stock::stock_search,
            commands::stock::stock_download,
            commands::translate::translate_ja_to_en,
            commands::mcp::mcp_list,
            commands::mcp::mcp_upsert,
            commands::mcp::mcp_delete,
            commands::magnific::magnific_status,
            commands::magnific::magnific_login,
            commands::magnific::magnific_logout,
            commands::magnific::magnific_generate_batch,
            commands::magnific::magnific_account,
            commands::higgsfield_mcp::higgsfield_mcp_status,
            commands::higgsfield_mcp::higgsfield_mcp_login,
            commands::higgsfield_mcp::higgsfield_mcp_logout,
            commands::higgsfield_mcp::higgsfield_mcp_generate_batch,
            commands::higgsfield_mcp::higgsfield_mcp_list_models,
            commands::higgsfield_mcp::higgsfield_mcp_generate_cost,
            commands::higgsfield_mcp::higgsfield_mcp_account,
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
            commands::storyboard::storyboard_checkpoint_resume,
            commands::storyboard::storyboard_regenerate_cut,
            commands::multiangle::multiangle_run,
            commands::multiangle::multiangle_regenerate_cut,
            commands::storyboard::storyboard_persist_adoption,
            commands::storyboard::storyboard_read_adoptions,
            commands::storyboard::storyboard_read_debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
