//! Session history commands.
//!
//! Persists sessions, turns, and image records to a local SQLite database via
//! `tauri-plugin-sql`.  The DB lives at `{app_data_dir}/history.db`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::Row as _;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

// ──────────────────────────── helpers ────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos)
}

async fn get_sqlite_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not registered".to_string())?;
    state.db_pool().await.ok_or_else(|| {
        "DB pool not initialised yet (setup hook may have failed — check tracing logs)".to_string()
    })
}

// ──────────────────────────── public types ────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub last_used_at: i64,
    /// Path to the most-recent image generated under this session.
    /// Powers the small thumbnail icon on each sidebar row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_image_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnRow {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub provider: Option<String>,
    pub model_job_set_type: Option<String>,
    pub model_display_name: Option<String>,
    pub ref_image_paths: Vec<String>,
    pub count: i64,
    pub kind: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageRow {
    pub id: String,
    pub turn_id: String,
    pub path: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub kind: String,
    pub media_type: String,
    pub duration_seconds: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnWithImages {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub provider: Option<String>,
    pub model_job_set_type: Option<String>,
    pub model_display_name: Option<String>,
    pub ref_image_paths: Vec<String>,
    pub count: i64,
    pub kind: String,
    pub created_at: i64,
    pub images: Vec<ImageRow>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithTurns {
    pub session: Session,
    pub turns: Vec<TurnWithImages>,
}

/// Trimmed-down row used by the prompt-history sidebar.
/// Includes the first generated image (if any) so the sidebar can
/// render a small thumbnail next to each past prompt.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryRow {
    pub id: String,
    pub prompt: String,
    pub count: i64,
    pub kind: String,
    pub created_at: i64,
    pub provider: Option<String>,
    pub model_job_set_type: Option<String>,
    pub model_display_name: Option<String>,
    pub thumb_path: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecordArgs {
    pub session_id: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub provider: Option<String>,
    pub model_job_set_type: Option<String>,
    pub model_display_name: Option<String>,
    #[serde(default)]
    pub ref_image_paths: Vec<String>,
    pub count: i64,
    pub kind: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecordArgs {
    pub turn_id: String,
    pub path: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub kind: String,
    #[serde(default)]
    pub media_type: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<i64>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub exported_images: u32,
    pub missing_images: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerationInfo {
    pub prompt: String,
    pub model: Option<String>,
    pub model_display_name: Option<String>,
    pub effort: Option<String>,
    pub provider: Option<String>,
    pub kind: String,
    pub ref_image_paths: Vec<String>,
    pub generated_at: i64,
}

// ──────────────────────────── commands ────────────────────────────

#[tauri::command]
pub async fn sessions_list(app: AppHandle) -> Result<Vec<Session>, String> {
    let pool = get_sqlite_pool(&app).await?;
    // Correlated subquery so the sidebar can render a thumbnail for
    // each session without a second roundtrip per row.
    let rows = sqlx::query(
        "SELECT s.id, s.title, s.created_at, s.last_used_at, \
                (SELECT i.path FROM images i \
                   JOIN turns t ON i.turn_id = t.id \
                   WHERE t.session_id = s.id \
                   ORDER BY i.created_at DESC LIMIT 1) AS last_image_path \
         FROM sessions s ORDER BY s.last_used_at DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("sessions_list failed: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| Session {
            id: r.get::<String, _>("id"),
            title: r.get::<String, _>("title"),
            created_at: r.get::<i64, _>("created_at"),
            last_used_at: r.get::<i64, _>("last_used_at"),
            last_image_path: r.get::<Option<String>, _>("last_image_path"),
        })
        .collect())
}

#[tauri::command]
pub async fn session_create(app: AppHandle, title: Option<String>) -> Result<Session, String> {
    let pool = get_sqlite_pool(&app).await?;
    let id = short_id();
    let now = now_ms();
    // Default title includes the id prefix so multiple "新規セッション"
    // are visually distinguishable in the sidebar (the user reported
    // "全部新規セッションで区別できない"). Users can rename later.
    let title = title.unwrap_or_else(|| {
        let prefix: String = id.chars().take(8).collect();
        format!("新規セッション:{prefix}")
    });

    sqlx::query(
        "INSERT INTO sessions (id, title, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&id)
    .bind(&title)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|e| format!("session_create failed: {e}"))?;

    Ok(Session {
        id,
        title,
        created_at: now,
        last_used_at: now,
        last_image_path: None,
    })
}

#[tauri::command]
pub async fn session_rename(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let pool = get_sqlite_pool(&app).await?;
    sqlx::query("UPDATE sessions SET title = ?1 WHERE id = ?2")
        .bind(&title)
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| format!("session_rename failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let pool = get_sqlite_pool(&app).await?;
    // SQLite ships with foreign-key checks OFF by default and
    // tauri-plugin-sql doesn't enable PRAGMA foreign_keys=ON per
    // pooled connection, so the schema's `ON DELETE CASCADE` declarations
    // are dead letters. Cascade explicitly inside a transaction so deletes
    // never leave orphaned rows in `turns` / `images`.
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin tx failed: {e}"))?;
    sqlx::query("DELETE FROM images WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?1)")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("delete images failed: {e}"))?;
    sqlx::query("DELETE FROM turns WHERE session_id = ?1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("delete turns failed: {e}"))?;
    sqlx::query("DELETE FROM sessions WHERE id = ?1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("delete session failed: {e}"))?;
    tx.commit()
        .await
        .map_err(|e| format!("commit tx failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn session_get_full(app: AppHandle, id: String) -> Result<SessionWithTurns, String> {
    let pool = get_sqlite_pool(&app).await?;

    let session_rows =
        sqlx::query("SELECT id, title, created_at, last_used_at FROM sessions WHERE id = ?1")
            .bind(&id)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("session_get_full sessions query failed: {e}"))?;

    let session = session_rows
        .first()
        .map(|r| Session {
            id: r.get::<String, _>("id"),
            title: r.get::<String, _>("title"),
            created_at: r.get::<i64, _>("created_at"),
            last_used_at: r.get::<i64, _>("last_used_at"),
            last_image_path: None,
        })
        .ok_or_else(|| format!("session not found: {id}"))?;

    // Load the most-recent N turns (cap to keep `session_get_full`
    // bounded even when the session has accumulated thousands of
    // turns over time). The user can scroll back to load older turns
    // via `session_get_full_before` (TODO).
    const MAX_TURNS: i64 = 500;
    let turn_rows = sqlx::query(
        "SELECT id, session_id, prompt, model, effort, provider, model_job_set_type, model_display_name, ref_image_paths, count, kind, created_at \
         FROM turns WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(&id)
    .bind(MAX_TURNS)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("session_get_full turns query failed: {e}"))?;

    // Reverse so the chat renders oldest-first, matching ASC order.
    let mut turn_rows: Vec<_> = turn_rows.into_iter().collect();
    turn_rows.reverse();

    if turn_rows.is_empty() {
        return Ok(SessionWithTurns {
            session,
            turns: vec![],
        });
    }

    // Single bulk query for all images of the loaded turns. Avoids
    // the N+1 loop that would issue one query per turn.
    let turn_ids: Vec<String> = turn_rows
        .iter()
        .map(|tr| tr.get::<String, _>("id"))
        .collect();
    let placeholders = turn_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let image_query = format!(
        "SELECT id, turn_id, path, mtime_ms, size, kind, media_type, duration_seconds, thumbnail_path, created_at \
         FROM images WHERE turn_id IN ({placeholders}) ORDER BY created_at ASC"
    );
    let mut q = sqlx::query(&image_query);
    for tid in &turn_ids {
        q = q.bind(tid);
    }
    let img_rows = q
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("session_get_full images bulk query failed: {e}"))?;

    let mut images_by_turn: std::collections::HashMap<String, Vec<ImageRow>> =
        std::collections::HashMap::new();
    for r in img_rows {
        let turn_id: String = r.get("turn_id");
        images_by_turn
            .entry(turn_id.clone())
            .or_default()
            .push(ImageRow {
                id: r.get::<String, _>("id"),
                turn_id,
                path: r.get::<String, _>("path"),
                mtime_ms: r.get::<i64, _>("mtime_ms"),
                size: r.get::<i64, _>("size"),
                kind: r.get::<String, _>("kind"),
                media_type: r.get::<String, _>("media_type"),
                duration_seconds: r.get::<Option<i64>, _>("duration_seconds"),
                thumbnail_path: r.get::<Option<String>, _>("thumbnail_path"),
                created_at: r.get::<i64, _>("created_at"),
            });
    }

    let turns_with_images: Vec<TurnWithImages> = turn_rows
        .iter()
        .map(|tr| {
            let turn_id: String = tr.get("id");
            let ref_paths_json: String = tr
                .get::<Option<String>, _>("ref_image_paths")
                .unwrap_or_else(|| "[]".to_string());
            let ref_image_paths: Vec<String> =
                serde_json::from_str(&ref_paths_json).unwrap_or_default();
            let images = images_by_turn.remove(&turn_id).unwrap_or_default();
            TurnWithImages {
                id: turn_id,
                session_id: tr.get::<String, _>("session_id"),
                prompt: tr.get::<String, _>("prompt"),
                model: tr.get::<Option<String>, _>("model"),
                effort: tr.get::<Option<String>, _>("effort"),
                provider: tr.get::<Option<String>, _>("provider"),
                model_job_set_type: tr.get::<Option<String>, _>("model_job_set_type"),
                model_display_name: tr.get::<Option<String>, _>("model_display_name"),
                ref_image_paths,
                count: tr.get::<i64, _>("count"),
                kind: tr.get::<String, _>("kind"),
                created_at: tr.get::<i64, _>("created_at"),
                images,
            }
        })
        .collect();

    Ok(SessionWithTurns {
        session,
        turns: turns_with_images,
    })
}

#[tauri::command]
pub async fn turn_record(app: AppHandle, args: TurnRecordArgs) -> Result<TurnRow, String> {
    let pool = get_sqlite_pool(&app).await?;
    let id = short_id();
    let now = now_ms();
    let ref_paths_json =
        serde_json::to_string(&args.ref_image_paths).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO turns (id, session_id, prompt, model, effort, provider, model_job_set_type, model_display_name, ref_image_paths, count, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
    .bind(&id)
    .bind(&args.session_id)
    .bind(&args.prompt)
    .bind(args.model.as_deref())
    .bind(args.effort.as_deref())
    .bind(args.provider.as_deref())
    .bind(args.model_job_set_type.as_deref())
    .bind(args.model_display_name.as_deref())
    .bind(&ref_paths_json)
    .bind(args.count)
    .bind(&args.kind)
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|e| format!("turn_record insert failed: {e}"))?;

    // bump last_used_at on session
    sqlx::query("UPDATE sessions SET last_used_at = ?1 WHERE id = ?2")
        .bind(now)
        .bind(&args.session_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("turn_record last_used_at update failed: {e}"))?;

    Ok(TurnRow {
        id,
        session_id: args.session_id,
        prompt: args.prompt,
        model: args.model,
        effort: args.effort,
        provider: args.provider,
        model_job_set_type: args.model_job_set_type,
        model_display_name: args.model_display_name,
        ref_image_paths: args.ref_image_paths,
        count: args.count,
        kind: args.kind,
        created_at: now,
    })
}

#[tauri::command]
pub async fn image_record(app: AppHandle, args: ImageRecordArgs) -> Result<ImageRow, String> {
    let pool = get_sqlite_pool(&app).await?;
    let id = short_id();
    let now = now_ms();

    // INSERT OR IGNORE so the watcher firing twice for the same file
    // (or a manual + watcher double-record) doesn't create duplicate rows.
    // The UNIQUE INDEX on (turn_id, path) added in migration v2 backs this.
    let media_type = args.media_type.unwrap_or_else(|| "image".to_string());

    sqlx::query(
        "INSERT OR IGNORE INTO images (id, turn_id, path, mtime_ms, size, kind, media_type, duration_seconds, thumbnail_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(&id)
    .bind(&args.turn_id)
    .bind(&args.path)
    .bind(args.mtime_ms)
    .bind(args.size)
    .bind(&args.kind)
    .bind(&media_type)
    .bind(args.duration_seconds)
    .bind(args.thumbnail_path.as_deref())
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|e| format!("image_record insert failed: {e}"))?;

    Ok(ImageRow {
        id,
        turn_id: args.turn_id,
        path: args.path,
        mtime_ms: args.mtime_ms,
        size: args.size,
        kind: args.kind,
        media_type,
        duration_seconds: args.duration_seconds,
        thumbnail_path: args.thumbnail_path,
        created_at: now,
    })
}

/// Look up the generation-process snapshot associated with an exact image path.
/// Missing rows are expected for imported or legacy images, so they return None.
#[tauri::command]
pub async fn generation_info_for_image(
    app: AppHandle,
    path: String,
) -> Result<Option<GenerationInfo>, String> {
    let pool = get_sqlite_pool(&app).await?;
    let row = sqlx::query(
        "SELECT t.prompt, t.model, t.model_display_name, t.effort, t.provider, \
                t.kind, t.ref_image_paths, t.created_at \
         FROM images i \
         JOIN turns t ON t.id = i.turn_id \
         WHERE i.path = ?1 \
         ORDER BY i.created_at DESC \
         LIMIT 1",
    )
    .bind(&path)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("generation_info_for_image query failed: {e}"))?;

    let Some(row) = row else {
        return Ok(None);
    };
    let ref_paths_json = row
        .get::<Option<String>, _>("ref_image_paths")
        .unwrap_or_else(|| "[]".to_string());
    let ref_image_paths = serde_json::from_str::<Vec<String>>(&ref_paths_json)
        .map_err(|e| format!("generation_info_for_image invalid ref_image_paths: {e}"))?;

    Ok(Some(GenerationInfo {
        prompt: row.get::<String, _>("prompt"),
        model: row.get::<Option<String>, _>("model"),
        model_display_name: row.get::<Option<String>, _>("model_display_name"),
        effort: row.get::<Option<String>, _>("effort"),
        provider: row.get::<Option<String>, _>("provider"),
        kind: row.get::<String, _>("kind"),
        ref_image_paths,
        generated_at: row.get::<i64, _>("created_at"),
    }))
}

/// Load a single past turn with all its generated images. Used when
/// the user clicks a row in the prompt-history sidebar — we replay
/// the turn as a frozen BatchCard in the chat so they can see what
/// they generated last time while editing the prompt.
#[tauri::command]
pub async fn turn_get(app: AppHandle, id: String) -> Result<TurnWithImages, String> {
    let pool = get_sqlite_pool(&app).await?;
    let rows = sqlx::query(
        "SELECT id, session_id, prompt, model, effort, provider, model_job_set_type, model_display_name, ref_image_paths, count, kind, created_at \
         FROM turns WHERE id = ?1",
    )
    .bind(&id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("turn_get query failed: {e}"))?;

    let tr = rows
        .first()
        .ok_or_else(|| format!("turn not found: {id}"))?;
    let turn_id: String = tr.get("id");
    let ref_paths_json: String = tr
        .get::<Option<String>, _>("ref_image_paths")
        .unwrap_or_else(|| "[]".to_string());
    let ref_image_paths: Vec<String> = serde_json::from_str(&ref_paths_json).unwrap_or_default();

    let img_rows = sqlx::query(
        "SELECT id, turn_id, path, mtime_ms, size, kind, media_type, duration_seconds, thumbnail_path, created_at \
         FROM images WHERE turn_id = ?1 ORDER BY created_at ASC",
    )
    .bind(&turn_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("turn_get images query failed: {e}"))?;

    let images: Vec<ImageRow> = img_rows
        .iter()
        .map(|r| ImageRow {
            id: r.get::<String, _>("id"),
            turn_id: r.get::<String, _>("turn_id"),
            path: r.get::<String, _>("path"),
            mtime_ms: r.get::<i64, _>("mtime_ms"),
            size: r.get::<i64, _>("size"),
            kind: r.get::<String, _>("kind"),
            media_type: r.get::<String, _>("media_type"),
            duration_seconds: r.get::<Option<i64>, _>("duration_seconds"),
            thumbnail_path: r.get::<Option<String>, _>("thumbnail_path"),
            created_at: r.get::<i64, _>("created_at"),
        })
        .collect();

    Ok(TurnWithImages {
        id: turn_id,
        session_id: tr.get::<String, _>("session_id"),
        prompt: tr.get::<String, _>("prompt"),
        model: tr.get::<Option<String>, _>("model"),
        effort: tr.get::<Option<String>, _>("effort"),
        provider: tr.get::<Option<String>, _>("provider"),
        model_job_set_type: tr.get::<Option<String>, _>("model_job_set_type"),
        model_display_name: tr.get::<Option<String>, _>("model_display_name"),
        ref_image_paths,
        count: tr.get::<i64, _>("count"),
        kind: tr.get::<String, _>("kind"),
        created_at: tr.get::<i64, _>("created_at"),
        images,
    })
}

/// Return the most-recent N prompts (across all sessions) for the
/// prompt-history sidebar. Each row also carries the first image
/// generated under that turn so the sidebar can render a thumbnail.
#[tauri::command]
pub async fn turns_recent(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<PromptHistoryRow>, String> {
    let pool = get_sqlite_pool(&app).await?;
    let limit = limit.unwrap_or(200).clamp(1, 2000);
    let rows = sqlx::query(
        "SELECT t.id, t.prompt, t.count, t.kind, t.created_at, \
                t.provider, t.model_job_set_type, t.model_display_name, \
                (SELECT i.path FROM images i \
                   WHERE i.turn_id = t.id \
                   ORDER BY i.created_at ASC LIMIT 1) AS thumb_path \
         FROM turns t \
         WHERE TRIM(t.prompt) <> '' \
         ORDER BY t.created_at DESC LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("turns_recent query failed: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| PromptHistoryRow {
            id: r.get::<String, _>("id"),
            prompt: r.get::<String, _>("prompt"),
            count: r.get::<i64, _>("count"),
            kind: r.get::<String, _>("kind"),
            created_at: r.get::<i64, _>("created_at"),
            provider: r.get::<Option<String>, _>("provider"),
            model_job_set_type: r.get::<Option<String>, _>("model_job_set_type"),
            model_display_name: r.get::<Option<String>, _>("model_display_name"),
            thumb_path: r.get::<Option<String>, _>("thumb_path"),
        })
        .collect())
}

#[tauri::command]
pub async fn session_export(
    app: AppHandle,
    id: String,
    dest_zip_path: String,
) -> Result<ExportSummary, String> {
    let pool = get_sqlite_pool(&app).await?;

    let session_rows =
        sqlx::query("SELECT id, title, created_at, last_used_at FROM sessions WHERE id = ?1")
            .bind(&id)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("session_export session query failed: {e}"))?;

    let session = session_rows
        .first()
        .map(|r| Session {
            id: r.get::<String, _>("id"),
            title: r.get::<String, _>("title"),
            created_at: r.get::<i64, _>("created_at"),
            last_used_at: r.get::<i64, _>("last_used_at"),
            last_image_path: None,
        })
        .ok_or_else(|| format!("session not found: {id}"))?;

    let turn_rows = sqlx::query(
        "SELECT id, session_id, prompt, model, effort, provider, model_job_set_type, model_display_name, ref_image_paths, count, kind, created_at FROM turns WHERE session_id = ?1 ORDER BY created_at ASC",
    )
    .bind(&id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("session_export turns query failed: {e}"))?;

    let mut all_images: Vec<(String, ImageRow)> = Vec::new(); // (turn_id, image)
    let mut turns_for_json: Vec<serde_json::Value> = Vec::new();

    for tr in &turn_rows {
        let turn_id: String = tr.get("id");
        let ref_paths_json: String = tr
            .get::<Option<String>, _>("ref_image_paths")
            .unwrap_or_else(|| "[]".to_string());
        let ref_image_paths: Vec<String> =
            serde_json::from_str(&ref_paths_json).unwrap_or_default();

        let img_rows = sqlx::query(
            "SELECT id, turn_id, path, mtime_ms, size, kind, media_type, duration_seconds, thumbnail_path, created_at FROM images WHERE turn_id = ?1 ORDER BY created_at ASC",
        )
        .bind(&turn_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("session_export images query failed: {e}"))?;

        let images: Vec<ImageRow> = img_rows
            .iter()
            .map(|r| ImageRow {
                id: r.get::<String, _>("id"),
                turn_id: r.get::<String, _>("turn_id"),
                path: r.get::<String, _>("path"),
                mtime_ms: r.get::<i64, _>("mtime_ms"),
                size: r.get::<i64, _>("size"),
                kind: r.get::<String, _>("kind"),
                media_type: r.get::<String, _>("media_type"),
                duration_seconds: r.get::<Option<i64>, _>("duration_seconds"),
                thumbnail_path: r.get::<Option<String>, _>("thumbnail_path"),
                created_at: r.get::<i64, _>("created_at"),
            })
            .collect();

        turns_for_json.push(serde_json::json!({
            "id": turn_id,
            "sessionId": tr.get::<String, _>("session_id"),
            "prompt": tr.get::<String, _>("prompt"),
            "model": tr.get::<Option<String>, _>("model"),
            "effort": tr.get::<Option<String>, _>("effort"),
            "provider": tr.get::<Option<String>, _>("provider"),
            "modelJobSetType": tr.get::<Option<String>, _>("model_job_set_type"),
            "modelDisplayName": tr.get::<Option<String>, _>("model_display_name"),
            "refImagePaths": ref_image_paths,
            "count": tr.get::<i64, _>("count"),
            "kind": tr.get::<String, _>("kind"),
            "createdAt": tr.get::<i64, _>("created_at"),
            "images": images.iter().map(|img| serde_json::json!({
                "id": img.id,
                "turnId": img.turn_id,
                "path": img.path,
                "mtimeMs": img.mtime_ms,
                "size": img.size,
                "kind": img.kind,
                "mediaType": img.media_type,
                "durationSeconds": img.duration_seconds,
                "thumbnailPath": img.thumbnail_path,
                "createdAt": img.created_at,
            })).collect::<Vec<_>>(),
        }));

        for img in images {
            all_images.push((turn_id.clone(), img));
        }
    }

    let manifest = serde_json::json!({
        "session": {
            "id": session.id,
            "title": session.title,
            "createdAt": session.created_at,
            "lastUsedAt": session.last_used_at,
        },
        "turns": turns_for_json,
    });

    // Build the zip atomically: write to <dest>.tmp first, fsync, then
    // rename. If anything fails mid-write we clean up the tmp file so
    // the user's chosen destination never sees a half-formed zip.
    let dest_path = std::path::PathBuf::from(&dest_zip_path);
    let tmp_path = {
        let mut p = dest_path.clone();
        let mut name = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "export.zip".into());
        name.push_str(".tmp");
        p.set_file_name(name);
        p
    };

    let result: Result<(u32, u32), String> = (|| {
        let file = std::fs::File::create(&tmp_path).map_err(|e| format!("zip 作成失敗: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        // session.json
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("JSON シリアライズ失敗: {e}"))?;
        zip.start_file("session.json", opts)
            .map_err(|e| format!("zip start_file failed: {e}"))?;
        use std::io::Write as _;
        zip.write_all(&manifest_bytes)
            .map_err(|e| format!("zip write failed: {e}"))?;

        let mut exported = 0u32;
        let mut missing = 0u32;
        for (_turn_id, img) in &all_images {
            let img_path = std::path::Path::new(&img.path);
            if !img_path.exists() {
                missing += 1;
                continue;
            }
            let file_name = img_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("image.png");
            // Use the full image id as the dir prefix so two images with
            // the same basename (rare but possible) keep distinct entries.
            let entry_name = format!("images/{}_{}", &img.id, file_name);
            // Soft-fail on per-image read errors: we'd rather export an
            // incomplete-but-valid zip than abort the whole operation
            // because one file got moved while exporting.
            let data = match std::fs::read(img_path) {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(
                        target: "codex.sessions",
                        "skipping unreadable image {}: {e}", img.path
                    );
                    missing += 1;
                    continue;
                }
            };
            zip.start_file(&entry_name, opts)
                .map_err(|e| format!("zip entry failed: {e}"))?;
            zip.write_all(&data)
                .map_err(|e| format!("zip write image failed: {e}"))?;
            exported += 1;
        }

        zip.finish()
            .map_err(|e| format!("zip finish failed: {e}"))?;
        Ok((exported, missing))
    })();

    let (exported, missing) = match result {
        Ok(t) => t,
        Err(e) => {
            // Don't leave a half-written tmp lying around.
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    std::fs::rename(&tmp_path, &dest_path).map_err(|e| format!("zip rename failed: {e}"))?;

    Ok(ExportSummary {
        exported_images: exported,
        missing_images: missing,
    })
}
