use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::secrets::secret_get;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockPhoto {
    pub id: String,
    pub thumb_url: String,
    pub full_url: String,
    pub author: String,
    pub source_url: Option<String>,
    pub download_trigger: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockSearchFilters {
    pub orientation: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub order_by: Option<String>,
    pub locale: Option<String>,
    pub per_page: Option<u32>,
}

#[tauri::command]
pub async fn stock_search(
    provider: String,
    query: String,
    page: u32,
    filters: Option<StockSearchFilters>,
) -> Result<Vec<StockPhoto>, String> {
    let provider = normalize_provider(&provider)?;
    let query = query.trim();
    if query.is_empty() {
        return Err("検索キーワードを入力してください".to_string());
    }

    let key = secret_get_for(provider)?;
    let page = page.max(1);
    let page_s = page.to_string();
    let client = Client::new();
    let filters = filters.unwrap_or_default();
    eprintln!(
        "[stock_search] provider={} query={:?} page={} filters={:?}",
        provider, query, page, filters
    );
    // 法務対応 (2026-05-21): Unsplash 分岐は撤去。
    //   理由: Unsplash API Guidelines は BYO API キー方式 (ユーザーに
    //   developer account 登録を要求する設計) を推奨していない。
    //   ゴリゴリくんの BYO 方針と衝突するため、素材ソースは Pexels に
    //   絞った。pixabay は将来用に実装は残す。
    let mut req = match provider {
        "pexels" => {
            let per_page = filters.per_page.unwrap_or(15).clamp(1, 80).to_string();
            let mut params = vec![
                ("query", query.to_string()),
                ("page", page_s.clone()),
                ("per_page", per_page),
            ];
            push_if_valid(
                &mut params,
                "orientation",
                filters.orientation.as_deref(),
                &["landscape", "portrait", "square"],
            );
            if let Some(color) = filters.color.as_deref().and_then(clean_filter) {
                if is_pexels_color(color) {
                    params.push(("color", color.to_string()));
                }
            }
            push_if_valid(
                &mut params,
                "size",
                filters.size.as_deref(),
                &["large", "medium", "small"],
            );
            if let Some(locale) = filters.locale.as_deref().and_then(clean_filter) {
                params.push(("locale", locale.to_string()));
            }
            client
                .get("https://api.pexels.com/v1/search")
                .query(&params)
                .header("Authorization", key)
        }
        "pixabay" => client.get("https://pixabay.com/api/").query(&[
            ("key", key.as_str()),
            ("q", query),
            ("page", page_s.as_str()),
            ("per_page", "20"),
        ]),
        _ => unreachable!(),
    };
    req = req.header("Accept", "application/json");

    // 実際に Pexels に投げる URL をログ出力 (フィルター動作確認用)
    if let Some(cloned) = req.try_clone() {
        if let Ok(built) = cloned.build() {
            eprintln!("[stock_search] outgoing URL: {}", built.url());
        }
    }

    let res = req
        .send()
        .await
        .map_err(|e| request_error(provider, "検索リクエスト", e))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "{} の検索に失敗しました ({status})",
            label(provider)
        ));
    }
    let json: Value = res
        .json()
        .await
        .map_err(|e| request_error(provider, "検索レスポンス", e))?;

    Ok(match provider {
        // unsplash 分岐は法務対応 (2026-05-21) で撤去。
        "pexels" => parse_pexels(&json),
        "pixabay" => parse_pixabay(&json),
        _ => Vec::new(),
    })
}

#[tauri::command]
pub async fn stock_download(provider: String, photo: StockPhoto) -> Result<String, String> {
    let provider = normalize_provider(&provider)?;
    if photo.full_url.trim().is_empty() {
        return Err("ダウンロード URL が空です".to_string());
    }

    // 法務対応 (2026-05-21): Unsplash 撤去に伴い download_trigger は不使用。
    let _key = secret_get_for(provider)?;
    let client = Client::new();

    let res = client
        .get(&photo.full_url)
        .send()
        .await
        .map_err(|e| request_error(provider, "画像取得", e))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "{} の画像取得に失敗しました ({status})",
            label(provider)
        ));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| request_error(provider, "画像データ", e))?;
    if bytes.is_empty() {
        return Err("画像データが空です".to_string());
    }

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    let dir = base.join("stock");
    std::fs::create_dir_all(&dir).map_err(|e| format!("dir 作成失敗: {e}"))?;

    let id = sanitize_part(&photo.id).unwrap_or_else(timestamp_id);
    let dest = dir.join(format!("stock-{provider}-{id}.jpg"));
    std::fs::write(&dest, &bytes).map_err(|e| format!("write 失敗: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

impl Default for StockSearchFilters {
    fn default() -> Self {
        Self {
            orientation: None,
            color: None,
            size: None,
            order_by: Some("relevant".to_string()),
            locale: None,
            per_page: None,
        }
    }
}

fn clean_filter(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value == "all" {
        None
    } else {
        Some(value)
    }
}

fn push_if_valid(
    params: &mut Vec<(&'static str, String)>,
    key: &'static str,
    value: Option<&str>,
    allowed: &[&str],
) {
    let Some(value) = value.and_then(clean_filter) else {
        return;
    };
    if allowed.contains(&value) {
        params.push((key, value.to_string()));
    }
}

fn is_pexels_color(value: &str) -> bool {
    matches!(
        value,
        "red"
            | "orange"
            | "yellow"
            | "green"
            | "turquoise"
            | "blue"
            | "violet"
            | "pink"
            | "brown"
            | "black"
            | "gray"
            | "white"
    ) || is_hex_color(value)
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.chars().skip(1).all(|ch| ch.is_ascii_hexdigit())
}

// parse_unsplash は法務対応 (2026-05-21) で撤去。

fn parse_pexels(json: &Value) -> Vec<StockPhoto> {
    json.get("photos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| StockPhoto {
            id: id_at(item, &["id"]),
            thumb_url: string_at(item, &["src", "medium"]),
            full_url: string_at(item, &["src", "large"]),
            author: string_at(item, &["photographer"]),
            source_url: optional_string_at(item, &["url"]),
            download_trigger: None,
        })
        .filter(|photo| {
            !photo.id.is_empty() && !photo.thumb_url.is_empty() && !photo.full_url.is_empty()
        })
        .collect()
}

fn parse_pixabay(json: &Value) -> Vec<StockPhoto> {
    json.get("hits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| StockPhoto {
            id: id_at(item, &["id"]),
            thumb_url: string_at(item, &["previewURL"]),
            full_url: string_at(item, &["largeImageURL"]),
            author: string_at(item, &["user"]),
            source_url: optional_string_at(item, &["pageURL"]),
            download_trigger: None,
        })
        .filter(|photo| {
            !photo.id.is_empty() && !photo.thumb_url.is_empty() && !photo.full_url.is_empty()
        })
        .collect()
}

// unsplash は法務対応 (2026-05-21) で全分岐から撤去。
fn normalize_provider(provider: &str) -> Result<&'static str, String> {
    match provider {
        "pexels" => Ok("pexels"),
        "pixabay" => Ok("pixabay"),
        _ => Err("unknown provider".to_string()),
    }
}

fn secret_get_for(provider: &str) -> Result<String, String> {
    let key_name = match provider {
        "pexels" => "pexels_api_key",
        "pixabay" => "pixabay_api_key",
        _ => return Err("unknown provider".to_string()),
    };
    secret_get(key_name.to_string())?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| format!("{} の API キーを設定してください", label(provider)))
}

fn label(provider: &str) -> &'static str {
    match provider {
        "pexels" => "Pexels",
        "pixabay" => "Pixabay",
        _ => "stock provider",
    }
}

fn request_error(provider: &str, action: &str, err: reqwest::Error) -> String {
    format!(
        "{} の{}に失敗しました: {}",
        label(provider),
        action,
        err.without_url()
    )
}

fn string_at(value: &Value, path: &[&str]) -> String {
    optional_string_at(value, path).unwrap_or_default()
}

fn optional_string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn id_at(value: &Value, path: &[&str]) -> String {
    let mut current = value;
    for key in path {
        match current.get(*key) {
            Some(next) => current = next,
            None => return String::new(),
        }
    }
    current
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| current.to_string())
}

fn sanitize_part(value: &str) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn timestamp_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "now".to_string())
}
