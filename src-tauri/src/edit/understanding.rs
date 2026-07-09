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
// 入力の座標系はプロンプトで **0〜1000 の正規化スケール** を要求している
// (2026-07-09 実測: 4000px 原寸ではモデルが内部縮小した物差しでピクセル座標を返し、
// 全要素が左上へ潰れて補完 10/14 失敗・消去が誤位置に走った。正規化要求で解像度
// 非依存にする)。まず 0..1000 とみなして画像サイズへスケールし、値が 1000 を
// 明確に超える場合のみピクセル座標として扱う (旧応答・指示無視への後方互換)。
fn normalize_bbox(raw: &[f64], img_w: u32, img_h: u32) -> Option<[i32; 4]> {
    if raw.len() != 4 || raw.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (iw, ih) = (img_w as f64, img_h as f64);
    let scale = raw.iter().all(|v| *v <= 1000.0 + 8.0);
    let (sx, sy) = if scale { (iw / 1000.0, ih / 1000.0) } else { (1.0, 1.0) };
    let raw = [raw[0] * sx, raw[1] * sy, raw[2] * sx, raw[3] * sy];
    let [a, b, c, d] = raw;
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
            {"text":"レンタル","bbox":[51,398,628,142],"color":"#003F6F","group":"main"},
            {"text":"","bbox":[0,0,10,10]},
            {"text":"unreadable","bbox":[0,0,10,10]}
        ],"graphics":[
            {"name":"耳アイコン","kind":"icon","bbox":[821,36,932,145]},
            {"name":"壊れ","bbox":[1,2,3]}
        ]} 後置き"##;
        let u = parse_design_understanding(raw, 1200, 1200).unwrap();
        assert_eq!(u.text_blocks.len(), 1, "空/unreadable は捨てる");
        assert_eq!(u.text_blocks[0].bbox, [61, 477, 753, 170], "0-1000正規化→1200pxへスケール");
        assert_eq!(u.text_blocks[0].color.as_deref(), Some("#003F6F"));
        assert_eq!(u.graphics.len(), 1, "bbox破損は捨てる");
        // [821,36,932,145] (0-1000): xywh だと x+w=1753 が範囲外 → x1y1x2y2 解釈 → 1200pxスケール。
        assert_eq!(u.graphics[0].bbox, [985, 43, 133, 130], "x1y1x2y2 解釈 + スケール");
    }

    #[test]
    fn parse_rejects_garbage_and_clamps() {
        assert!(parse_design_understanding("JSONなし", 100, 100).is_err());
        let raw = r#"{"text_blocks":[{"text":"はみ出し","bbox":[-200,-200,800,800]}],"graphics":[]}"#;
        let u = parse_design_understanding(raw, 100, 100).unwrap();
        assert_eq!(u.text_blocks[0].bbox, [0, 0, 60, 60], "0-1000→100pxスケール後にクランプ");
        // 不正な色は None に落とす。
        let raw2 = r#"{"text_blocks":[{"text":"色壊れ","bbox":[0,0,100,100],"color":"blue"}],"graphics":[]}"#;
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
