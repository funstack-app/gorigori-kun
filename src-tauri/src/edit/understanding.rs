//! 理解層 (工程0): Codex vision が返すデザイン分解 JSON の解析・検証。
//!
//! なぜ必要か (2026-07-09 実測): 小型モデル分散 (SAM3 int8 / PP-OCR mobile) では
//! 誤読 (補聴器→通腮器)・プロンプト取り違え (badge で本体を掴む) が下流へ伝播する。
//! Codex vision は同一画像で読解全問正解・アイコン区別・グループ化を 1 コールで返す
//! (正本: _work/gori-layer-tech-scan/00-synthesis.md 検証③)。
//!
//! 出力は未信頼入力として扱う: 座標形式の揺れ (xywh / x1y1x2y2 の混在を実測) を
//! 正規化し、画像境界へクランプし、壊れた要素は黙って捨てず件数をログに残す。

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
struct RawTextBlock {
    #[serde(default)]
    text: String,
    #[serde(default)]
    bbox: Vec<f64>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    group: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawGraphic {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    bbox: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawUnderstanding {
    #[serde(default)]
    text_blocks: Vec<RawTextBlock>,
    #[serde(default)]
    graphics: Vec<RawGraphic>,
}

#[derive(Debug, Clone)]
pub struct DesignTextBlock {
    pub text: String,
    /// [x, y, w, h] 元画像ピクセル座標 (正規化・クランプ済み)。
    pub bbox: [i32; 4],
    /// "#rrggbb"。検証を通らなければ None (呼び出し側が実測色にフォールバック)。
    pub color: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DesignGraphic {
    /// 短い日本語レイヤー名 (SAM3 物体レイヤーのリネーム照合に使う)。
    pub name: Option<String>,
    pub kind: Option<String>,
    pub bbox: [i32; 4],
}

#[derive(Debug, Clone, Default)]
pub struct DesignUnderstanding {
    pub text_blocks: Vec<DesignTextBlock>,
    pub graphics: Vec<DesignGraphic>,
}

/// Codex の生出力からデザイン分解 JSON を取り出して検証する。
///
/// - JSON 本体は最初の `{` から最後の `}` まで (前後の説明文・フェンスを無視)
/// - bbox は xywh を要求しているが x1y1x2y2 も実測で混在するため両解釈で正規化する
/// - text が空 / "unreadable" のブロックは捨てる (創作・欠落をレイヤー化しない)
pub fn parse_design_understanding(
    raw: &str,
    img_w: u32,
    img_h: u32,
) -> Result<DesignUnderstanding, String> {
    let start = raw.find('{').ok_or("JSONが見つからない")?;
    let end = raw.rfind('}').ok_or("JSONが閉じていない")?;
    if end <= start {
        return Err("JSONが壊れている".to_string());
    }
    let parsed: RawUnderstanding = serde_json::from_str(&raw[start..=end])
        .map_err(|e| format!("JSON解析失敗: {e}"))?;

    let mut out = DesignUnderstanding::default();
    let mut dropped = 0usize;
    for b in parsed.text_blocks {
        let text = b.text.trim().to_string();
        if text.is_empty() || text.eq_ignore_ascii_case("unreadable") {
            dropped += 1;
            continue;
        }
        let Some(bbox) = normalize_bbox(&b.bbox, img_w, img_h) else {
            dropped += 1;
            continue;
        };
        out.text_blocks.push(DesignTextBlock {
            text,
            bbox,
            color: b.color.filter(|c| is_valid_hex(c)),
            group: b.group.filter(|g| !g.trim().is_empty()),
        });
    }
    for g in parsed.graphics {
        let Some(bbox) = normalize_bbox(&g.bbox, img_w, img_h) else {
            dropped += 1;
            continue;
        };
        out.graphics.push(DesignGraphic {
            name: g.name.filter(|n| !n.trim().is_empty()),
            kind: g.kind,
            bbox,
        });
    }
    if dropped > 0 {
        tracing::info!(target: "codex.edit", "understanding: 壊れた/空の要素を{dropped}件破棄");
    }
    Ok(out)
}

/// bbox の書式揺れを正規化して [x, y, w, h] (画像内クランプ済み) を返す。
///
/// 判定規則 (決定論): xywh 解釈で bbox が画像内に収まるならそれを採用 (要求した書式を
/// 優先)。収まらないが x1y1x2y2 解釈 (x2>x1, y2>y1, 画像内) が成立するならそちら。
/// どちらも成立しなければ xywh でクランプし、退化 (幅/高さ<2px) は None。
fn normalize_bbox(raw: &[f64], img_w: u32, img_h: u32) -> Option<[i32; 4]> {
    if raw.len() != 4 || raw.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (iw, ih) = (img_w as f64, img_h as f64);
    let [a, b, c, d] = [raw[0], raw[1], raw[2], raw[3]];
    // 少しの座標誤差は許す (実測: 右上バッジで x2=1204 等、数px の食み出し)。
    let margin = 8.0;
    let xywh_fits =
        c > 0.0 && d > 0.0 && a >= -margin && b >= -margin && a + c <= iw + margin && b + d <= ih + margin;
    let xyxy_fits =
        c > a && d > b && a >= -margin && b >= -margin && c <= iw + margin && d <= ih + margin;
    let (x, y, w, h) = if xywh_fits {
        (a, b, c, d)
    } else if xyxy_fits {
        (a, b, c - a, d - b)
    } else {
        (a, b, c.max(0.0), d.max(0.0))
    };
    let x0 = x.max(0.0).min(iw - 1.0);
    let y0 = y.max(0.0).min(ih - 1.0);
    let x1 = (x + w).max(0.0).min(iw);
    let y1 = (y + h).max(0.0).min(ih);
    let (w, h) = (x1 - x0, y1 - y0);
    if w < 2.0 || h < 2.0 {
        return None;
    }
    Some([x0 as i32, y0 as i32, w as i32, h as i32])
}

fn is_valid_hex(c: &str) -> bool {
    let c = c.trim();
    c.len() == 7
        && c.starts_with('#')
        && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// 矩形 IoU。SAM3 物体レイヤーと graphics の照合 (リネーム) に使う。
pub fn rect_iou(a: [i32; 4], b: [i32; 4]) -> f64 {
    let ax1 = a[0] + a[2];
    let ay1 = a[1] + a[3];
    let bx1 = b[0] + b[2];
    let by1 = b[1] + b[3];
    let ix = (ax1.min(bx1) - a[0].max(b[0])).max(0) as f64;
    let iy = (ay1.min(by1) - a[1].max(b[1])).max(0) as f64;
    let inter = ix * iy;
    let union = (a[2] as f64 * a[3] as f64) + (b[2] as f64 * b[3] as f64) - inter;
    if union <= 0.0 {
        return 0.0;
    }
    inter / union
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_normalizes_mixed_bbox_formats() {
        // 実測の揺れを再現: text は xywh、graphics は x1y1x2y2。
        let raw = r##"前置き {"text_blocks":[
            {"text":"レンタル","bbox":[61,478,753,170],"color":"#003F6F","group":"main"},
            {"text":"","bbox":[0,0,10,10]},
            {"text":"unreadable","bbox":[0,0,10,10]}
        ],"graphics":[
            {"name":"耳アイコン","kind":"icon","bbox":[985,43,1118,174]},
            {"name":"壊れ","bbox":[1,2,3]}
        ]} 後置き"##;
        let u = parse_design_understanding(raw, 1200, 1200).unwrap();
        assert_eq!(u.text_blocks.len(), 1, "空/unreadable は捨てる");
        assert_eq!(u.text_blocks[0].bbox, [61, 478, 753, 170], "xywh はそのまま");
        assert_eq!(u.text_blocks[0].color.as_deref(), Some("#003F6F"));
        assert_eq!(u.graphics.len(), 1, "bbox破損は捨てる");
        // [985,43,1118,174]: xywh だと x+w=2103 が画像外 → x1y1x2y2 解釈で幅133,高さ131。
        assert_eq!(u.graphics[0].bbox, [985, 43, 133, 131], "x1y1x2y2 を正規化");
    }

    #[test]
    fn parse_rejects_garbage_and_clamps() {
        assert!(parse_design_understanding("JSONなし", 100, 100).is_err());
        let raw = r#"{"text_blocks":[{"text":"はみ出し","bbox":[-20,-20,80,80]}],"graphics":[]}"#;
        let u = parse_design_understanding(raw, 100, 100).unwrap();
        assert_eq!(u.text_blocks[0].bbox, [0, 0, 60, 60], "画像内へクランプ");
        // 不正な色は None に落とす。
        let raw2 = r#"{"text_blocks":[{"text":"色壊れ","bbox":[0,0,10,10],"color":"blue"}],"graphics":[]}"#;
        let u2 = parse_design_understanding(raw2, 100, 100).unwrap();
        assert!(u2.text_blocks[0].color.is_none());
    }

    #[test]
    fn rect_iou_basics() {
        assert!((rect_iou([0, 0, 10, 10], [0, 0, 10, 10]) - 1.0).abs() < 1e-9);
        assert_eq!(rect_iou([0, 0, 10, 10], [20, 20, 5, 5]), 0.0);
        let iou = rect_iou([0, 0, 10, 10], [5, 0, 10, 10]);
        assert!(iou > 0.3 && iou < 0.4, "半分重なり ≈ 1/3: {iou}");
    }
}
