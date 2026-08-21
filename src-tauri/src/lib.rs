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

/// 履歴DBを開いてマイグレーションを当て、state に載せる。
///
/// setup フックから2回呼ばれうる (1回目が壊れたDBで失敗 → 退避 → 作り直し)。
/// そのため副作用は「pool を作って state に入れる」だけに閉じている。
async fn init_history_db(db_url: &str, state: &state::AppState) -> Result<(), String> {
    use sqlx::sqlite::SqlitePoolOptions;
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect(db_url)
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
    state.set_db(pool).await;
    Ok(())
}

/// 壊れた履歴DBを消さずに退避する。退避できたら true。
///
/// なぜ消さないか: 中にユーザーの生成履歴が入っている。SQLite は一部が
/// 壊れていても `sqlite3 .recover` で救えることがあるので、上書きで消しては
/// いけない。退避先は連番で、前回の退避を潰さない。
///
/// WAL/SHM も一緒に退避する。本体だけ動かすと、次回接続時に古い WAL が
/// 新しい空DBへ適用されて壊れ方が伝染する。
fn quarantine_broken_db(db_path: &std::path::Path) -> bool {
    if !db_path.exists() {
        // そもそもDBが無いのに失敗した = ディスクフルや権限の問題。
        // 退避しても直らないので、作り直しを試みない。
        return false;
    }
    let Some(backup) = next_free_db_backup(db_path) else {
        tracing::error!(target: "codex.sessions", "履歴DBの退避先が確保できませんでした");
        return false;
    };
    if let Err(e) = std::fs::rename(db_path, &backup) {
        tracing::error!(target: "codex.sessions", "履歴DBの退避に失敗 (続行): {e}");
        return false;
    }
    // 付随ファイルも同じ接尾辞で退避する (無ければ何もしない)。
    for suffix in ["-wal", "-shm"] {
        let side = with_suffix(db_path, suffix);
        if side.exists() {
            let _ = std::fs::rename(&side, with_suffix(&backup, suffix));
        }
    }
    tracing::warn!(
        target: "codex.sessions",
        "壊れた履歴DBを {} に退避しました (sqlite3 で救える可能性があります)",
        backup.display()
    );
    true
}

/// 既存の退避を潰さないDBの退避先。`history.db.broken` → `.broken.2` …
fn next_free_db_backup(db_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let first = with_suffix(db_path, ".broken");
    if !first.exists() {
        return Some(first);
    }
    (2..=50)
        .map(|n| with_suffix(db_path, &format!(".broken.{n}")))
        .find(|candidate| !candidate.exists())
}

/// パス末尾に文字列を足す。`with_extension` と違い既存の拡張子を消さない
/// (`history.db` → `history.db-wal` を作りたいため)。
fn with_suffix(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    std::path::PathBuf::from(name)
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

    let app = tauri::Builder::default()
        // single-instance は **必ず最初に登録する** (公式要件:
        // v2.tauri.app/plugin/single-instance)。ここより前に別 plugin を
        // 足すと 2 個目の起動が正しく抑止されず、同じデータファイルを
        // 2 プロセスが同時に書いて全量上書き事故が起きる (bd 97a)。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 2 個目の起動要求 = 既存ウィンドウを前面へ (公式レシピ)。
            // ラベルは既定 "main" (tauri.conf.json の windows にラベル指定なし)。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // ウィンドウの大きさ調整は「できたら嬉しい」処理であって、
            // 失敗しても既定サイズで開けばよい。`?` で伝播させると
            // モニタ情報が取れない環境 (リモートデスクトップ・ディスプレイの
            // 抜き差し直後・ヘッドレス) で **窓が出る前にアプリが終了する**。
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let target_w = (logical_w * 0.8).clamp(820.0, 1400.0);
                    let target_h = (logical_h * 0.8).clamp(540.0, 900.0);

                    let _ = window.set_size(tauri::LogicalSize::new(target_w, target_h));
                    let _ = window.center();

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
            // initialize_storage は失敗しない (Err を返さない) 設計にした。
            // 以前は `?` で伝播しており、設定JSONの破損や保存先ボリュームの不在で
            // **ウィンドウが出る前にアプリが終了**していた。ユーザーには
            // 「ダブルクリックしても何も起きない」としか見えず、設定画面に
            // 到達できないため保存先を戻すこともできなかった (2026-07-26 監査)。
            tauri::async_runtime::block_on(commands::storage::initialize_storage(&state_for_setup));
            crate::cloud::sync_worker::spawn_background_sync();
            crate::storage_cleanup::spawn_background_cleanup();
            // 撤去済みの MCP 認可専用バイナリ (200〜290MB) のキャッシュを掃除する。
            // best-effort。失敗しても起動は止めない。
            crate::codex::cleanup_legacy_mcp_auth_cache();

            // 起動時デイリーバックアップ (2026-08-06)。
            //
            // なぜ要るか: 従来 .bak は「保存の直前」かつ「ファイルが既に存在する」
            // ときしか作られず、移行したきり保存していないユーザーは
            // **バックアップ0件**のままだった (「バックアップがありません」の正体)。
            // 起動のたびにここを通すことで、触っていないユーザーにも必ず1世代届く。
            //
            // block_on しないのは、バックアップ (ファイルコピー) でウィンドウ表示を
            // 遅らせないため。24時間以内に .bak があれば即 no-op で返る。
            // 失敗しても起動は止めない (付帯機能で本流を止めない)。
            tauri::async_runtime::spawn(async {
                if let Err(err) = commands::storage::storage_ensure_daily_backups().await {
                    tracing::warn!(
                        target: "codex.storage",
                        "起動時デイリーバックアップに失敗 (続行): {err}"
                    );
                }
            });

            // アプリデータ置き場。**ここでも起動を止めない。**
            //
            // 解決できない/作れない場合 (権限破損・読み取り専用・ディスクフル)
            // でも、一時ディレクトリへ退避してウィンドウは開く。履歴が残らない
            // 不便より、「ダブルクリックしても何も起きない」ほうが圧倒的に困る。
            let app_data_dir = match app.handle().path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    let fallback = std::env::temp_dir().join(crate::secrets::SERVICE_NAME);
                    tracing::error!(
                        target: "codex.storage",
                        "アプリデータ置き場を解決できません ({e})。一時領域で起動します: {}",
                        fallback.display()
                    );
                    fallback
                }
            };
            if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
                tracing::error!(
                    target: "codex.storage",
                    error = ?e,
                    path = %app_data_dir.display(),
                    "アプリデータ置き場を作れませんでした (起動は続行。履歴が保存できない可能性があります)"
                );
            }
            // 前回クラッシュ時に台帳へ残った生成専用 app-server を先に停止する。
            // この後の汎用清掃は台帳を空にするため、順序を逆にしない。
            crate::codex::gen_server::cleanup_stale_registered_servers(&app.handle());
            // 前回クラッシュ時に台帳へ残った worker だけを、安全確認後に停止する。
            commands::worker_registry::cleanup_stale_workers(&app.handle());

            // 生成の区間タイム計測 (T0)。保存先を確定させてから記録が有効になる。
            commands::gen_metrics::init(&app.handle());
            // 生成用 app-server のプリウォーム (T4)。残骸掃除の**後**に置く
            // — 先に起動すると、直後の cleanup が今起こしたサーバーを
            // 掃除対象と誤認しかねない。turn は発行しないので枠は消費しない。
            crate::codex::gen_server::spawn_prewarm(&app.handle());

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

            // 履歴DBの初期化。**失敗しても起動を止めない (2026-07-26 監査)。**
            //
            // なぜ: 以前は `?` で伝播していたため、生成中に電源が落ちて
            // history.db が壊れると **ウィンドウが出る前にアプリが終了**した。
            // ユーザーには「ダブルクリックしても何も起きない」としか見えず、
            // アプリ内から履歴を作り直すこともできない完全な詰みになる。
            // これは同 setup 内の initialize_storage で塞いだのと同型の穴で、
            // 電源断という物理原因まで同じだった (方針が不統一だった)。
            //
            // state.db は元々 Option 型で、「commands that need it await
            // db_pool() and surface a clear error if init failed」と
            // state.rs:43-45 に設計が明記されている。つまりコマンド側は
            // 未初期化を織り込み済みで、ここで止める必要がそもそも無かった。
            let state_for_init = state_for_setup.clone();
            let db_init = tauri::async_runtime::block_on(init_history_db(&db_url, &state_for_init));
            if let Err(e) = db_init {
                tracing::error!(target: "codex.sessions", "db init failed: {e}");
                // 壊れたDBを退避して1度だけ作り直す。退避せずに削除しないのは、
                // 中にユーザーの生成履歴が入っており、壊れていても後から
                // sqlite3 で救える可能性があるため (資産は残す)。
                if quarantine_broken_db(&db_path) {
                    match tauri::async_runtime::block_on(init_history_db(&db_url, &state_for_init)) {
                        Ok(()) => tracing::warn!(
                            target: "codex.sessions",
                            "壊れた履歴DBを退避し、新しい履歴DBで起動しました"
                        ),
                        Err(e) => tracing::error!(
                            target: "codex.sessions",
                            "履歴DBを作り直せませんでした (起動は続行。履歴機能は使えません): {e}"
                        ),
                    }
                }
            }
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
            commands::codex_vision::codex_extract_text_blocks,
            commands::codex_vision::codex_analyze_scene_layout,
            commands::codex_vision::codex_review_facts,
            commands::edit_models::edit_models_list,
            commands::edit_models::edit_models_download,
            commands::edit_models::edit_models_delete,
            commands::edit_models::edit_platform_info,
            commands::edit_export::edit_export_psd,
            commands::edit_export::edit_export_png,
            commands::edit_fonts::edit_fonts_list,
            // ── ort (ONNX Runtime) 依存の編集コマンド群 ──────────────────
            // ort は Windows 限定依存に格下げした (2026-07-28、Intel Mac 対応の復活)。
            // 非 Windows では commands/edit_unsupported.rs の同名スタブを登録し、
            // 「この機能は現在 Windows 版のみです」を返す。未登録にしないのは、
            // フロント (src/lib/ipc.ts) に invoke ラッパが残っており、
            // 呼ばれた場合に "Command not found" という原因不明のエラーになるため。
            #[cfg(edit_ai)]
            commands::edit_sam2::edit_sam2_embed,
            #[cfg(edit_ai)]
            commands::edit_sam2::edit_sam2_predict,
            #[cfg(edit_ai)]
            commands::edit_ocr::edit_ocr_detect,
            #[cfg(edit_ai)]
            commands::edit_inpaint::edit_inpaint_run,
            #[cfg(edit_ai)]
            commands::edit_grab::edit_grab_object,
            #[cfg(edit_ai)]
            commands::edit_magic::edit_magic_run,
            #[cfg(edit_ai)]
            commands::edit_words::edit_words_segment,
            #[cfg(edit_ai)]
            commands::edit_segment::edit_segment_run,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_sam2_embed,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_sam2_predict,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_ocr_detect,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_inpaint_run,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_grab_object,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_magic_run,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_words_segment,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::edit_segment_run,
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
            commands::images::images_thumbnail,
            commands::images::images_remove_background,
            commands::images::images_delete,
            commands::images::images_delete_many,
            commands::images::images_relink_missing,
            commands::images::images_write_clipboard,
            commands::images::images_write_upload,
            commands::audio_probe::audio_probe,
            commands::audio_probe::audio_write_upload,
            commands::images::images_export_resized,
            commands::images::images_file_sizes,
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
            commands::storage::presets_read,
            commands::storage::presets_write,
            commands::storage::presets_list_backups,
            commands::storage::presets_read_backup,
            commands::storage::storage_ensure_daily_backups,
            commands::storage::motions_list_backups,
            commands::storage::motions_read_backup,
            commands::storage::scene3d_list_backups,
            commands::storage::scene3d_read_backup,
            commands::storage::scene3d_read,
            commands::storage::scene3d_write,
            commands::storage::motions_read,
            commands::storage::motions_write,
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
            commands::remote_mcp::remote_mcp_providers,
            commands::remote_mcp::remote_mcp_status_all,
            commands::remote_mcp::remote_mcp_login,
            commands::remote_mcp::remote_mcp_logout,
            commands::higgsfield_mcp::higgsfield_mcp_status,
            commands::higgsfield_mcp::higgsfield_mcp_login,
            commands::higgsfield_mcp::higgsfield_mcp_logout,
            commands::higgsfield_mcp::higgsfield_mcp_generate_batch,
            commands::higgsfield_mcp::higgsfield_mcp_list_models,
            commands::higgsfield_mcp::higgsfield_mcp_generate_cost,
            commands::higgsfield_mcp::higgsfield_mcp_account,
            commands::batch_gen::images_generate_batch,
            commands::worker_registry::cancel_generation,
            commands::gen_queue::gen_capacity,
            commands::sessions::sessions_list,
            commands::sessions::session_create,
            commands::sessions::session_rename,
            commands::sessions::session_delete,
            commands::sessions::session_get_full,
            commands::sessions::turn_record,
            commands::sessions::image_record,
            commands::sessions::generation_info_for_image,
            commands::sessions::session_export,
            commands::sessions::turns_recent,
            commands::sessions::turns_recent_with_images,
            commands::sessions::turn_get,
            // BiRefNet (ort) 経路。Mac の背景透過 (Vision/removebg.swift) は
            // images.rs 側の別経路なので、この cfg の影響を受けない。
            #[cfg(edit_ai)]
            commands::segment::segment_image,
            #[cfg(not(edit_ai))]
            commands::edit_unsupported::segment_image,
            commands::segment::is_segmentation_model_ready,
            commands::segment::download_segmentation_model,
            commands::scene3d::scene3d_export_begin,
            commands::scene3d::scene3d_write_frame,
            commands::scene3d::scene3d_encode,
            commands::scene3d::scene3d_fetch_capture_video,
            commands::video_concat::video_concat_story,
            commands::storyboard::storyboard_run,
            commands::storyboard::storyboard_regenerate_cut,
            commands::multiangle::multiangle_run,
            commands::multiangle::multiangle_regenerate_cut,
            commands::character_sheet::character_sheet_run,
            commands::character_sheet::character_sheet_regenerate_cut,
            commands::storyboard::storyboard_persist_adoption,
            commands::storyboard::storyboard_read_adoptions,
            commands::storyboard::storyboard_read_debug_log,
            commands::storyboard::storyboard_write_run_snapshot,
            commands::storyboard::storyboard_read_run_snapshot,
            commands::storyboard::storyboard_list_run_snapshots,
            commands::sticker::sticker_chroma_key,
            commands::sticker::sticker_inspect,
            commands::sticker::sticker_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let state = app_handle.state::<AppState>().inner_clone();
            tauri::async_runtime::block_on(crate::codex::gen_server::shutdown(&state));
            commands::worker_registry::terminate_registered_workers(app_handle);
        }
    });
}
