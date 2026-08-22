use font_kit::source::SystemSource;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

const FONT_LIST_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub family: String,
    pub display_name: String,
    pub style: String,
    pub language_tags: Vec<String>,
}

#[tauri::command]
pub async fn edit_fonts_list(language_hint: Option<String>) -> Result<Vec<FontInfo>, String> {
    let hint = language_hint
        .as_deref()
        .map(normalize_hint)
        .filter(|value| !value.is_empty());

    // システムフォントには、実体がクラウド上にしか無いものや壊れたものも混ざり得る。
    // 別スレッドへ隔離し、OS 側が返さなくても画面を待たせ続けない。
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("edit-font-list".to_string())
        .spawn(move || {
            let _ = sender.send(collect_fonts(hint));
        })
        .map_err(|e| format!("フォント一覧の読み込みを始められませんでした: {e}"))?;

    let received =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(FONT_LIST_TIMEOUT))
            .await
            .map_err(|e| format!("フォント一覧の読み込み処理が停止しました: {e}"))?;

    match received {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            Err("フォント一覧の読み込みに時間がかかりすぎました".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err("フォント一覧の読み込みが途中で終了しました".to_string())
        }
    }
}

fn collect_fonts(hint: Option<String>) -> Result<Vec<FontInfo>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|e| format!("システムフォント一覧を取得できませんでした: {e}"))?;
    families.sort_by_key(|name| name.to_lowercase());
    families.dedup_by(|a, b| a.eq_ignore_ascii_case(b));

    let mut fonts = Vec::with_capacity(families.len() + 1);
    fonts.push(FontInfo {
        family: "system-ui".to_string(),
        display_name: "System Default".to_string(),
        style: "Regular".to_string(),
        language_tags: vec!["ja".to_string(), "en".to_string()],
    });

    let mut seen = HashSet::from(["system-ui".to_string()]);
    for family in families {
        let key = family.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let language_tags = language_tags_for_family(&family);
        // 旧実装は全familyの先頭フォントを `load()` していた。クラウドフォント等で
        // ここが返らないと一覧全体が止まるため、一覧ではファイルを開かない。
        let style = "Regular".to_string();
        fonts.push(FontInfo {
            display_name: if style == "Regular" {
                family.clone()
            } else {
                format!("{family} {style}")
            },
            family,
            style,
            language_tags,
        });
    }

    sort_by_hint(&mut fonts, hint.as_deref());

    if let Some(hint) = hint.as_deref() {
        let filtered: Vec<FontInfo> = fonts
            .iter()
            .filter(|font| font.language_tags.iter().any(|tag| tag == hint))
            .cloned()
            .collect();
        if !filtered.is_empty() {
            return Ok(filtered);
        }
    }

    Ok(fonts)
}

fn normalize_hint(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    if lower.starts_with("ja") || lower.contains("jpn") || lower.contains("日本") {
        "ja".to_string()
    } else if lower.starts_with("en") || lower.contains("latin") {
        "en".to_string()
    } else {
        lower
    }
}

fn language_tags_for_family(family: &str) -> Vec<String> {
    let lower = family.to_lowercase();
    let is_ja = lower.contains("hiragino")
        || lower.contains("yu gothic")
        || lower.contains("yu mincho")
        || lower.contains("meiryo")
        || lower.contains("noto sans cjk")
        || lower.contains("noto serif cjk")
        || lower.contains("noto sans jp")
        || lower.contains("noto serif jp")
        || lower.contains("source han")
        || lower.contains("ipa")
        || lower.contains("biz ud")
        || lower.contains("osaka")
        || family.contains('日')
        || family.contains('明')
        || family.contains('角')
        || family.contains('丸')
        || family.contains('ゴ')
        || family.contains('メ');

    if is_ja {
        vec!["ja".to_string(), "en".to_string()]
    } else {
        vec!["en".to_string()]
    }
}

fn sort_by_hint(fonts: &mut [FontInfo], hint: Option<&str>) {
    fonts.sort_by(|a, b| {
        let ap = priority(&a.family, hint);
        let bp = priority(&b.family, hint);
        ap.cmp(&bp)
            .then_with(|| a.family.to_lowercase().cmp(&b.family.to_lowercase()))
    });
}

fn priority(family: &str, hint: Option<&str>) -> usize {
    let lower = family.to_lowercase();
    if lower == "system-ui" {
        return 0;
    }
    let ja_order = [
        "hiragino sans",
        "hiragino kaku gothic",
        "noto sans jp",
        "noto sans cjk",
        "yu gothic",
        "meiryo",
        "biz udgothic",
        "source han sans",
    ];
    let en_order = ["sf pro", "arial", "helvetica", "avenir", "inter", "roboto"];
    let preferred = if hint == Some("ja") {
        &ja_order[..]
    } else {
        &en_order[..]
    };
    preferred
        .iter()
        .position(|needle| lower.contains(needle))
        .map(|index| index + 1)
        .unwrap_or(100)
}
