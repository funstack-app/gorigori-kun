//! Inspect what `account/read` returns from a live codex app-server.
//! This is observational — the test passes regardless of auth state, but
//! prints the payload so we can shape our frontend types accordingly.

use std::time::Duration;

use codex_frame_factory_lib::__test_support as t;
use serde_json::json;

#[tokio::test]
async fn account_read_payload() {
    let bin = match t::resolve_codex_binary(None) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("skipping: {err}");
            return;
        }
    };

    let proc = t::spawn_app_server(&bin).await.expect("spawn app-server");
    let handle = t::RpcClient::start(proc.stdin, proc.stdout);
    let client = handle.client.clone();

    tokio::time::timeout(Duration::from_secs(20), t::handshake(&client))
        .await
        .expect("no timeout")
        .expect("handshake ok");

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        client.request_raw("account/read", json!({ "refreshToken": false })),
    )
    .await
    .expect("no timeout");

    match result {
        Ok(v) => eprintln!(
            "account/read OK: {}",
            serde_json::to_string_pretty(&v).unwrap()
        ),
        Err(e) => eprintln!("account/read ERR: {e}"),
    }
}
