//! Trigger a real `turn/start` and dump every notification we receive so we
//! can validate our reducer assumptions and discover the actual item type
//! used for `image_gen` invocations.

use std::time::Duration;

use codex_frame_factory_lib::__test_support as t;
use serde_json::json;

#[tokio::test]
async fn dump_image_gen_streaming() {
    let bin = match t::resolve_codex_binary(None) {
        Ok(p) => p,
        Err(_) => return,
    };
    let proc = t::spawn_app_server(&bin).await.unwrap();
    let handle = t::RpcClient::start(proc.stdin, proc.stdout);
    let client = handle.client.clone();
    let mut notif = client.subscribe();

    tokio::time::timeout(Duration::from_secs(20), t::handshake(&client))
        .await
        .unwrap()
        .unwrap();

    // try to start a thread; pick a model with image input modality if avail
    let model_list = client
        .request_raw("model/list", json!({ "limit": 50, "includeHidden": false }))
        .await
        .unwrap();
    eprintln!(
        "model_list keys: {:?}",
        model_list.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );
    let arr = model_list["data"].as_array().cloned().unwrap_or_default();
    eprintln!("model count: {}", arr.len());
    let chosen = arr
        .iter()
        .find(|m| m["isDefault"].as_bool().unwrap_or(false))
        .or_else(|| {
            arr.iter().find(|m| {
                m["inputModalities"]
                    .as_array()
                    .map(|im| im.iter().any(|v| v == "image"))
                    .unwrap_or(false)
            })
        })
        .or_else(|| arr.first())
        .cloned()
        .expect("at least one model");
    let model = chosen["model"].as_str().unwrap_or("gpt-5.4").to_string();
    eprintln!("using model: {model}");

    let cwd = std::env::temp_dir().join("codex-image-editor-test");
    std::fs::create_dir_all(&cwd).unwrap();

    let thread = client
        .request_raw(
            "thread/start",
            json!({
                "model": model,
                "cwd": cwd.to_string_lossy(),
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
            }),
        )
        .await;
    let thread = match thread {
        Ok(t) => t,
        Err(e) => {
            eprintln!("thread/start failed: {e}");
            return;
        }
    };
    eprintln!(
        "thread/start: {}",
        serde_json::to_string_pretty(&thread).unwrap()
    );
    let thread_id = thread["thread"]["id"].as_str().unwrap_or("").to_string();
    if thread_id.is_empty() {
        eprintln!("no thread id");
        return;
    }

    // listen in background
    tokio::spawn(async move {
        loop {
            match notif.recv().await {
                Ok(n) => eprintln!(
                    "NOTIF [{}]: {}",
                    n.method,
                    serde_json::to_string(&n.params).unwrap_or_default()
                ),
                Err(_) => break,
            }
        }
    });

    let prompt = "1+1 を返してください。短く。";
    let r = client
        .request_raw(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt }],
                "model": model,
            }),
        )
        .await;
    eprintln!("turn/start: {:?}", r);

    // give the server some time to stream back
    tokio::time::sleep(Duration::from_secs(45)).await;
}
