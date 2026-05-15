use font_kit::source::{Source, SystemSource};
use serde::Serialize;
use std::collections::HashSet;

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
        let style = best_effort_style(&source, &family).unwrap_or_else(|| "Regular".to_string());
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

fn best_effort_style<S: Source>(source: &S, family: &str) -> Option<String> {
    let handle = source.select_family_by_name(family).ok()?;
    let font = handle.fonts().first()?.load().ok()?;
    let properties = font.properties();
    let mut parts = Vec::new();
    if properties.weight.0 >= 650.0 {
        parts.push("Bold");
    }
    let style = format!("{}", properties.style);
    if style != "Normal" {
        parts.push(style.as_str());
    }
    if parts.is_empty() {
        Some("Regular".to_string())
    } else {
        Some(parts.join(" "))
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
