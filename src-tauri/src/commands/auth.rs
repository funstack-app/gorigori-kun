use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

#[tauri::command]
pub async fn auth_read(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    client
        .request_raw("account/read", json!({ "refreshToken": false }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_login_api_key(
    state: State<'_, AppState>,
    api_key: String,
) -> Result<Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    client
        .request_raw(
            "account/login/start",
            json!({ "type": "apiKey", "apiKey": api_key }),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Start ChatGPT OAuth: ask app-server for an authUrl, then open the user's
/// default browser. Frontend should listen for `account/login/completed`
/// notifications to know when the flow finished.
#[tauri::command]
pub async fn auth_login_chatgpt(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;

    let result: Value = client
        .request_raw("account/login/start", json!({ "type": "chatgpt" }))
        .await
        .map_err(|e| e.to_string())?;

    if let Some(url) = result.get("authUrl").and_then(|v| v.as_str()) {
        if let Err(err) = app.opener().open_url(url, None::<&str>) {
            tracing::warn!(target: "codex.auth", "failed to open authUrl: {err}");
        }
    } else {
        tracing::warn!(target: "codex.auth", "login/start did not return authUrl: {result}");
    }

    Ok(result)
}

#[tauri::command]
pub async fn auth_login_chatgpt_device_code(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    client
        .request_raw(
            "account/login/start",
            json!({ "type": "chatgptDeviceCode" }),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    client
        .request_raw("account/logout", json!({}))
        .await
        .map_err(|e| e.to_string())
}
