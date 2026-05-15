//! Smoke test: spawn `codex app-server` and run the initialize handshake.
//!
//! Skipped automatically when the codex binary is not on PATH or fallback
//! locations, so CI on machines without codex still succeeds.

use std::time::Duration;

use codex_image_editor_lib as _; // ensure crate links

use codex_image_editor_lib::__test_support as t;

#[tokio::test]
async fn handshake_with_real_codex() {
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

    let result = tokio::time::timeout(Duration::from_secs(20), t::handshake(&client))
        .await
        .expect("handshake didn't time out")
        .expect("handshake should succeed");

    eprintln!("initialize result: {result}");
    assert!(result.is_object(), "initialize should return an object");
}
