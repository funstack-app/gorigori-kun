use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};

// 120秒では実運用でタイムアウトした (2026-07-09 STΛCK報告)。gpt-5.5 は effort=low でも
// 混雑・初回認証リフレッシュ・大きい画像で応答が伸びる。この呼び出しは非同期の前段処理で
// 遅い成功は速い失敗に勝るため 300 秒にする。
const CODEX_VISION_TIMEOUT_SECS: u64 = 300;
const VISION_MODEL: &str = "gpt-5.6-terra";
const VISION_EFFORT: &str = "low";

#[tauri::command]
pub async fn codex_describe_image(image_path: String) -> Result<String, String> {
    let prompt = [
        "添付画像を解析し、この画像をAI画像生成で再現するための英語プロンプトを1行で書いてください。",
        "被写体、構図、レンズ感、照明、色調、質感、背景を具体的に含めること。",
        "説明、箇条書き、前置き、引用符、Markdown は不要。プロンプト本文だけを返してください。",
    ]
    .join("\n");
    let stdout = run_codex_vision(&image_path, &prompt).await?;
    let description = clean_codex_output(&stdout);
    if description.is_empty() {
        return Err("Codex Vision の応答が空でした".to_string());
    }
    Ok(description)
}

/// ことばで分離の自動モード用: 画像に写っている独立した被写体・物体を列挙する。
/// 返り値は SAM3 プロンプト (英語) + レイヤー名 (日本語) + 大ジャンル。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ImageObjectWord {
    pub en: String,
    pub ja: String,
    /// 大ジャンル (person/text/background/prop)。編集タブのレイヤーツリー見出しに使う。
    /// Codex が省略/壊れた値を返したら None (フロントの決定論分類器がフォールバック)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// category として受け入れる大ジャンル4値。これ以外は None に落とす (未信頼入力の検証)。
const VALID_CATEGORIES: [&str; 4] = ["person", "text", "background", "prop"];

#[tauri::command]
pub async fn codex_list_image_objects(image_path: String) -> Result<Vec<ImageObjectWord>, String> {
    let prompt = [
        "添付画像に写っている「独立した被写体・物体」を列挙してください。",
        "用途: 各物体をセグメンテーションAI (SAM3) のテキストプロンプトで切り出してレイヤー化する。",
        "ルール:",
        "- 最大10個。画像の主要な物体から順に。",
        "- en は SAM3 が認識しやすい簡潔な英語名詞 (例: basketball, robot, sneakers)。",
        "- ja はレイヤー名に使う短い日本語 (例: バスケットボール)。",
        "- 背景そのもの (floor, wall, sky, ground, background) は含めない。",
        "- 人物・キャラクターが身につけている服・装備・体のパーツは列挙しない (人物ごと1つにまとめる)。",
        "- 人型の被写体は en を 'person' を基本に全身を指す語で書く (例: person in black coat)。",
        "  robot/cyborg 等の種族名は頭部だけにマッチしやすいので使わない。",
        "- 物体の一部分 (取っ手・タイヤ・ボタン等) も列挙しない。独立して動かせる単位だけ。",
        "- 画像上のオーバーレイ文字・ロゴのうち、物体に印字されたものは含めない。",
        "- category は各物体の大ジャンル。次の4値のみ: person (人・人型の被写体) /",
        "  text (独立したロゴ・タイトル等の文字要素) / background (背景そのもの) / prop (その他の小物)。",
        "- 出力は JSON 配列のみ。説明・前置き・Markdown コードフェンス不要。",
        "形式: [{\"en\":\"basketball\",\"ja\":\"バスケットボール\",\"category\":\"prop\"}]",
    ]
    .join("\n");
    let stdout = run_codex_vision(&image_path, &prompt).await?;
    parse_object_words(&stdout)
}

/// レギュレーション検査用: 画像内の文字ブロックを座標付きで抽出して JSON 文字列で返す。
///
/// なぜ独立コマンドにするか (2026-07-27):
///   レギュレーション検査は `codex_describe_image` の出力 (AI画像生成用の英語プロンプト1行)
///   だけを判定材料にしていた。あれは「絵として何が写っているか」を書くもので、画像内の
///   文字列を1文字も含まない。そのため文字面積・NG表現・打消し表記・ロゴといった
///   *文字を読まないと判定できないルール* が構造的に空振りしていた
///   (「業界No.1」と大書きされていても検出されない)。
///   文字抽出の実装自体は `codex_analyze_design` として既に存在したが、Tauri コマンドとして
///   公開されておらず編集タブの内部からしか呼べなかった。ここを公開経路にする。
///
/// 返り値は `codex_analyze_design` の生出力 (未検証の JSON 文字列)。パースと検証は
/// 呼び出し側が行う (未信頼入力の検証を呼び出し側1箇所に集約する)。
#[tauri::command]
pub async fn codex_extract_text_blocks(image_path: String, img_w: u32, img_h: u32) -> Result<String, String> {
    codex_analyze_design(&image_path, img_w, img_h).await
}

/// 理解層 (工程0): 画像をグラフィックデザインとして分解した構造化 JSON を返す。
///
/// 生出力をそのまま返し、解析・検証は `edit::understanding::parse_design_understanding`
/// が行う (未信頼入力の検証を1箇所に集約するため)。プロンプトの実測検証:
/// _work/gori-layer-tech-scan/understanding-ab/codex-vision/report.md (読解全問正解)。
pub async fn codex_analyze_design(
    image_path: &str,
    img_w: u32,
    img_h: u32,
) -> Result<String, String> {
    let prompt = format!(
        "あなたはグラフィックデザインの分解エンジンです。添付画像 (幅{img_w}px × 高さ{img_h}px) を解析し、以下のJSONだけを出力してください (説明文・コードフェンス不要)。\n\
        {{\n\
          \"text_blocks\": [{{\"text\": \"正確な文字内容\", \"bbox\": [x, y, 幅, 高さ], \"color\": \"#rrggbb\", \"group\": \"視覚グループ名\"}}],\n\
          \"graphics\": [{{\"name\": \"短い日本語レイヤー名\", \"kind\": \"icon|photo|shape\", \"bbox\": [x, y, 幅, 高さ]}}]\n\
        }}\n\
        規則:\n\
        - text_blocks は視覚的な行・ブロック単位。文字は1文字も創作しない (読めなければその要素を出さない)\n\
        - 文字が主体のロゴ (ワードマーク) は text_blocks に入れる。絵的なアイコン・写真・図形は graphics に入れる\n\
        - 同じ視覚的まとまりに属する text_blocks には同じ group 名を付ける\n\
        - bbox は必ず [左上x, 左上y, 幅, 高さ] の4要素。**座標系は 0〜1000 の正規化スケール** (画像の左上=[0,0]、右下=[1000,1000]。ピクセル値ではない)\n\
        - color は文字の塗り色の近似16進"
    );
    run_codex_vision(image_path, &prompt).await
}

/// Codex CLI (`codex exec -i <image>`) で画像付きプロンプトを実行し stdout を返す共通経路。
async fn run_codex_vision(image_path: &str, prompt: &str) -> Result<String, String> {
    let image_path = image_path.trim();
    if image_path.is_empty() {
        return Err("image_path must not be empty".to_string());
    }
    let path = Path::new(image_path);
    if !path.is_file() {
        return Err("画像ファイルが見つかりません".to_string());
    }

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;

    // Codex CLI の正規フラグ:
    //   --skip-git-repo-check : リポジトリ外でも実行可
    //   --color never         : ANSI カラー出力を無効化 (--no-color は存在しない)
    //   -c key=value          : config 上書き
    //   -i, --image <FILE>    : 画像添付
    //   PROMPT は省略すると stdin から読む (末尾の `-` は不要)
    let model_arg = format!("model={VISION_MODEL}");
    let effort_arg = format!("model_reasoning_effort={VISION_EFFORT}");
    let mut cmd = Command::new(&codex_bin);
    cmd.args([
        "exec",
        // Windows でデフォルト/workspace-write サンドボックスが
        // codex-windows-sandbox-setup.exe を要求して落ちる。参照画像→プロンプト
        // 変換は画像生成の前段で走るため、ここが落ちると生成も巻き添えで失敗する。
        // サンドボックス無効の bypass で回避(2026-06-09 Windows修正。--full-auto
        // では workspace-write になり直らなかった)。
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-c",
        &model_arg,
        "-c",
        &effort_arg,
        "-i",
        image_path,
    ])
    .env("PATH", enriched_path())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // GORI 専用 CODEX_HOME を渡す (app-server と認証を揃える)。
    // これが無いと codex exec は既定の ~/.codex を見に行き、アプリ内で再ログインした
    // 新トークンを使えず「refresh token was revoked」で落ちる (企画タブは app-server 経由
    // で CODEX_HOME 済みなので動くのに、編集タブだけ落ちる乖離の真因)。
    if let Some(home) = crate::codex::home::ensure_gori_codex_home() {
        cmd.env("CODEX_HOME", &home);
    }
    crate::codex::process::no_window_flag(&mut cmd);
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
    }

    let output = timeout(
        Duration::from_secs(CODEX_VISION_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("codex exec が {CODEX_VISION_TIMEOUT_SECS} 秒でタイムアウトしました"))?
    .map_err(|e| format!("codex exec 待機失敗: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("(stderr 出力なし)");
        return Err(format!(
            "codex exec が異常終了 (code={:?}): {detail}",
            output.status.code()
        ));
    }

    Ok(stdout)
}

/// Codex の応答から JSON 配列部分を取り出して ImageObjectWord 群へ解釈する。
/// Codex はフォーマット指示をしても前置きやコードフェンスを混ぜることがあるため、
/// 最初の '[' 〜 最後の ']' を JSON として読む。
fn parse_object_words(raw: &str) -> Result<Vec<ImageObjectWord>, String> {
    let start = raw
        .find('[')
        .ok_or_else(|| format!("物体リストのJSONが見つかりません: {raw}"))?;
    let end = raw
        .rfind(']')
        .ok_or_else(|| format!("物体リストのJSONが閉じていません: {raw}"))?;
    if end <= start {
        return Err("物体リストのJSONが壊れています".to_string());
    }
    let words: Vec<ImageObjectWord> = serde_json::from_str(&raw[start..=end])
        .map_err(|e| format!("物体リストの解釈に失敗: {e}"))?;

    // 正規化: 空要素を捨て、en の小文字一致で重複排除、最大10件。
    // category は4値以外 (壊れた値・大文字・空) を None に落とす (小文字化のみ吸収)。
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for mut w in words {
        w.en = w.en.trim().to_string();
        w.ja = w.ja.trim().to_string();
        w.category = w.category.and_then(|c| {
            let c = c.trim().to_lowercase();
            VALID_CATEGORIES.contains(&c.as_str()).then_some(c)
        });
        if w.en.is_empty() {
            continue;
        }
        if w.ja.is_empty() {
            w.ja = w.en.clone();
        }
        if seen.insert(w.en.to_lowercase()) {
            out.push(w);
        }
        if out.len() >= 10 {
            break;
        }
    }
    if out.is_empty() {
        return Err("物体が1つも見つかりませんでした".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::parse_object_words;

    #[test]
    fn parses_category_and_normalizes_invalid_values() {
        let raw = r#"前置きテキスト
[
  {"en": "person in black coat", "ja": "人物", "category": "person"},
  {"en": "basketball", "ja": "バスケットボール", "category": "PROP"},
  {"en": "logo", "ja": "ロゴ", "category": "banner"},
  {"en": "sneakers", "ja": "スニーカー"}
]
後置きテキスト"#;
        let words = parse_object_words(raw).expect("パースできる");
        assert_eq!(words.len(), 4);
        // 正常値はそのまま。
        assert_eq!(words[0].category.as_deref(), Some("person"));
        // 大文字は小文字化して受理 (フォーマット揺れの吸収)。
        assert_eq!(words[1].category.as_deref(), Some("prop"));
        // 4値以外は None に落とす (フロントの決定論分類器がフォールバックする契約)。
        assert_eq!(words[2].category, None);
        // 欠落も None (旧応答互換)。
        assert_eq!(words[3].category, None);
    }

    #[test]
    fn keeps_working_without_category_field_legacy_response() {
        let raw = r#"[{"en":"basketball","ja":"バスケットボール"},{"en":"robot","ja":"ロボット"}]"#;
        let words = parse_object_words(raw).expect("category 無しの旧形式もパースできる");
        assert_eq!(words.len(), 2);
        assert!(words.iter().all(|w| w.category.is_none()));
    }

    #[test]
    fn rejects_broken_json_instead_of_guessing() {
        // JSON が閉じない・配列が無い応答は推測で埋めずエラーで返す (silent failure 禁止)。
        assert!(parse_object_words("物体は見つかりませんでした").is_err());
        assert!(parse_object_words(r#"[{"en":"a","ja":"あ""#).is_err());
    }

    #[test]
    fn dedupes_and_caps_at_ten_entries() {
        let mut entries = Vec::new();
        for i in 0..12 {
            entries.push(format!(r#"{{"en":"item {i}","ja":"物 {i}","category":"prop"}}"#));
        }
        entries.push(r#"{"en":"item 0","ja":"重複","category":"prop"}"#.to_string());
        let raw = format!("[{}]", entries.join(","));
        let words = parse_object_words(&raw).expect("パースできる");
        assert_eq!(words.len(), 10, "重複排除+最大10件の上限");
    }
}

fn clean_codex_output(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`'))
        .trim()
        .to_string()
}
