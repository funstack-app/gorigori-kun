use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

fn codex_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex/config.toml"))
}

fn read_config(path: &PathBuf) -> Result<toml::Value, String> {
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    text.parse::<toml::Value>()
        .map_err(|e| format!("toml parse: {e}"))
}

fn root_table_mut(
    value: &mut toml::Value,
) -> Result<&mut toml::map::Map<String, toml::Value>, String> {
    value
        .as_table_mut()
        .ok_or_else(|| "config.toml の root が table ではありません".to_string())
}

fn backup_config(path: &PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let backup = path.with_file_name(format!("config.toml.bak.{ts}"));
    fs::copy(path, backup).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_config(path: &PathBuf, value: &toml::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup_config(path)?;
    let text = toml::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn parse_server(name: &str, val: &toml::Value) -> Option<McpServer> {
    let table = val.as_table()?;
    let command = table.get("command")?.as_str()?.to_string();
    let args = table
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default();
    let env = table
        .get("env")
        .and_then(|v| v.as_table())
        .map(|env_table| {
            env_table
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some(McpServer {
        name: name.to_string(),
        command,
        args,
        env,
    })
}

fn server_to_value(server: McpServer) -> toml::Value {
    let mut table = toml::map::Map::new();
    table.insert("command".to_string(), toml::Value::String(server.command));
    table.insert(
        "args".to_string(),
        toml::Value::Array(server.args.into_iter().map(toml::Value::String).collect()),
    );
    if !server.env.is_empty() {
        let env = server
            .env
            .into_iter()
            .map(|(k, v)| (k, toml::Value::String(v)))
            .collect();
        table.insert("env".to_string(), toml::Value::Table(env));
    }
    toml::Value::Table(table)
}

#[tauri::command]
pub fn mcp_list() -> Result<Vec<McpServer>, String> {
    let path = codex_config_path().ok_or_else(|| "HOME を解決できません".to_string())?;
    let value = read_config(&path)?;
    let Some(servers) = value.get("mcp_servers").and_then(|v| v.as_table()) else {
        return Ok(vec![]);
    };
    let mut out: Vec<McpServer> = servers
        .iter()
        .filter_map(|(name, val)| parse_server(name, val))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn mcp_upsert(server: McpServer) -> Result<(), String> {
    let name = server.name.trim().to_string();
    if name.is_empty() {
        return Err("MCP server name is required".to_string());
    }
    if server.command.trim().is_empty() {
        return Err("MCP command is required".to_string());
    }

    let path = codex_config_path().ok_or_else(|| "HOME を解決できません".to_string())?;
    let mut value = read_config(&path)?;
    let root = root_table_mut(&mut value)?;
    let servers = root
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "mcp_servers が table ではありません".to_string())?;
    servers.insert(name, server_to_value(server));
    write_config(&path, &value)
}

#[tauri::command]
pub fn mcp_delete(name: String) -> Result<(), String> {
    let path = codex_config_path().ok_or_else(|| "HOME を解決できません".to_string())?;
    let mut value = read_config(&path)?;
    if let Some(servers) = root_table_mut(&mut value)?
        .get_mut("mcp_servers")
        .and_then(|v| v.as_table_mut())
    {
        servers.remove(name.trim());
    }
    write_config(&path, &value)
}
