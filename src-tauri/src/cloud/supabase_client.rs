use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseConfig {
    pub project_url: String,
    pub anon_key: String,
    pub bucket_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudUsage {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub file_count: u32,
}

pub struct SupabaseClient {
    config: SupabaseConfig,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct StorageListItem {
    name: String,
    #[serde(default)]
    metadata: Option<StorageMetadata>,
}

#[derive(Debug, Deserialize)]
struct StorageMetadata {
    #[serde(default)]
    size: Option<u64>,
}

impl SupabaseClient {
    pub fn new(config: SupabaseConfig) -> Self {
        Self {
            config: normalize_config(config),
            http: reqwest::Client::new(),
        }
    }

    pub async fn test_connection(&self) -> Result<(), String> {
        let test_path = format!("/_test_connection_{}.txt", unix_ms());
        self.upload_bytes(&test_path, b"test").await?;
        self.delete_file(&test_path).await?;
        Ok(())
    }

    pub async fn upload_file(
        &self,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<String, String> {
        let bytes = tokio::fs::read(local_path)
            .await
            .map_err(|e| format!("read local: {e}"))?;
        let content_type = content_type_for_path(local_path);
        self.upload_bytes_with_content_type(remote_path, &bytes, content_type)
            .await
    }

    pub async fn upload_bytes(&self, remote_path: &str, bytes: &[u8]) -> Result<String, String> {
        self.upload_bytes_with_content_type(remote_path, bytes, "image/png")
            .await
    }

    pub async fn upload_bytes_with_content_type(
        &self,
        remote_path: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<String, String> {
        let object_path = normalize_remote_path(remote_path);
        let url = format!(
            "{}/storage/v1/object/{}/{}",
            self.config.project_url,
            self.config.bucket_name,
            percent_encode_path(object_path.trim_start_matches('/'))
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.config.anon_key)
            .header("Authorization", format!("Bearer {}", self.config.anon_key))
            .header("Content-Type", content_type)
            .header("x-upsert", "true")
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| format!("upload: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("upload failed: {status} {text}"));
        }
        Ok(self.public_url(&object_path))
    }

    pub async fn delete_file(&self, remote_path: &str) -> Result<(), String> {
        let object_path = normalize_remote_path(remote_path);
        let url = format!(
            "{}/storage/v1/object/{}/{}",
            self.config.project_url,
            self.config.bucket_name,
            percent_encode_path(object_path.trim_start_matches('/'))
        );
        let resp = self
            .http
            .delete(&url)
            .header("apikey", &self.config.anon_key)
            .header("Authorization", format!("Bearer {}", self.config.anon_key))
            .send()
            .await
            .map_err(|e| format!("delete: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("delete failed: {status} {text}"));
        }
        Ok(())
    }

    pub async fn get_usage(&self) -> Result<CloudUsage, String> {
        let mut used_bytes = 0u64;
        let mut file_count = 0u32;
        self.accumulate_usage("", &mut used_bytes, &mut file_count)
            .await?;
        Ok(CloudUsage {
            used_bytes,
            // Supabase 無料枠の Storage 上限。UIでは約1GBとして表示する。
            limit_bytes: 1024 * 1024 * 1024,
            file_count,
        })
    }

    async fn accumulate_usage(
        &self,
        prefix: &str,
        used_bytes: &mut u64,
        file_count: &mut u32,
    ) -> Result<(), String> {
        let mut stack = vec![prefix.trim_matches('/').to_string()];
        while let Some(current_prefix) = stack.pop() {
            let mut offset = 0u32;
            loop {
                let items = self.list_prefix(&current_prefix, offset).await?;
                if items.is_empty() {
                    break;
                }
                let got = items.len();
                for item in items {
                    if let Some(meta) = item.metadata {
                        *file_count = file_count.saturating_add(1);
                        *used_bytes = used_bytes.saturating_add(meta.size.unwrap_or(0));
                    } else {
                        let next = if current_prefix.is_empty() {
                            item.name
                        } else {
                            format!("{}/{}", current_prefix, item.name)
                        };
                        stack.push(next);
                    }
                }
                if got < 1000 {
                    break;
                }
                offset += got as u32;
            }
        }
        Ok(())
    }

    async fn list_prefix(&self, prefix: &str, offset: u32) -> Result<Vec<StorageListItem>, String> {
        let url = format!(
            "{}/storage/v1/object/list/{}",
            self.config.project_url, self.config.bucket_name
        );
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.config.anon_key)
            .header("Authorization", format!("Bearer {}", self.config.anon_key))
            .json(&serde_json::json!({
                "prefix": prefix,
                "limit": 1000,
                "offset": offset,
                "sortBy": { "column": "name", "order": "asc" }
            }))
            .send()
            .await
            .map_err(|e| format!("list: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("list failed: {status} {text}"));
        }
        resp.json::<Vec<StorageListItem>>()
            .await
            .map_err(|e| format!("list parse: {e}"))
    }

    fn public_url(&self, object_path: &str) -> String {
        format!(
            "{}/storage/v1/object/public/{}/{}",
            self.config.project_url,
            self.config.bucket_name,
            percent_encode_path(object_path.trim_start_matches('/'))
        )
    }
}

fn normalize_config(mut config: SupabaseConfig) -> SupabaseConfig {
    config.project_url = config.project_url.trim().trim_end_matches('/').to_string();
    config.bucket_name = config.bucket_name.trim().to_string();
    config.anon_key = config.anon_key.trim().to_string();
    config
}

fn normalize_remote_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim().trim_start_matches('/');
    format!("/{trimmed}")
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("txt") => "text/plain",
        _ => "image/png",
    }
}

fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}
