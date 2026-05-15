use serde_json::Value;

#[tauri::command]
pub async fn translate_ja_to_en(text: String) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("翻訳するテキストを入力してください".to_string());
    }

    let client = reqwest::Client::new();
    let res = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", "ja"),
            ("tl", "en"),
            ("dt", "t"),
            ("q", text),
        ])
        .send()
        .await
        .map_err(|e| format!("翻訳リクエストに失敗しました: {}", e.without_url()))?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("翻訳に失敗しました ({status})"));
    }

    let json: Value = res
        .json()
        .await
        .map_err(|e| format!("翻訳レスポンスの解析に失敗しました: {}", e.without_url()))?;
    let translated = json
        .get(0)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|chunk| chunk.get(0).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");

    if translated.trim().is_empty() {
        return Err("翻訳レスポンスが空でした".to_string());
    }
    Ok(translated.trim().to_string())
}
