//! Inspect `model/list` to discover available models / modalities.

use std::time::Duration;

use codex_image_editor_lib::__test_support as t;
use serde_json::json;

#[tokio::test]
async fn model_list_payload() {
    let bin = match t::resolve_codex_binary(None) {
        Ok(p) => p,
        Err(_) => return,
    };
    let proc = t::spawn_app_server(&bin).await.unwrap();
    let handle = t::RpcClient::start(proc.stdin, proc.stdout);
    let client = handle.client.clone();

    tokio::time::timeout(Duration::from_secs(20), t::handshake(&client))
        .await
        .unwrap()
        .unwrap();

    let r = client
        .request_raw("model/list", json!({ "limit": 50, "includeHidden": false }))
        .await;
    match r {
        Ok(v) => eprintln!("model/list: {}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => eprintln!("err: {e}"),
    }
}
