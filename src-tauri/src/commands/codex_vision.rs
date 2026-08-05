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

/// 審査セルフチェック経路 (`codex_review_facts`) 専用の effort。
///
/// 既存経路 (`VISION_EFFORT = "low"`) を上げない理由: describe/analyze は
/// 「絵として何が写っているか」を書く用途で low で足りており、生成の前段に挟まるため
/// 遅くすると生成全体が遅くなる。一方この経路は **ブランド名・作品名を名指しさせる**
/// タスクで、low では固有名詞が出にくい。審査観点の見落としは
/// 「速い正解」より高くつくので、ここだけ medium にする。
const REVIEW_FACTS_EFFORT: &str = "medium";

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
pub async fn codex_extract_text_blocks(
    image_path: String,
    img_w: u32,
    img_h: u32,
) -> Result<String, String> {
    codex_analyze_design(&image_path, img_w, img_h).await
}

/// 審査セルフチェック用: 画像から「審査観点の事実」だけを列挙して JSON 文字列で返す。
///
/// なぜ独立コマンドにするか (2026-08-05):
///   審査観点の判定材料に `codex_describe_image` を流用できない。あれのプロンプトは
///   「この画像をAI画像生成で再現するための英語プロンプトを1行で」(:19-24) であり、
///   **固有名詞を出さないよう最適化された出力**になる ("a red sports car" であって
///   "a Ferrari" ではない)。ブランド名・実在人物名・作品名は構造的に出てこないため、
///   権利・肖像まわりのルールが材料不足で空振りする。
///   これは `codex_extract_text_blocks` を新設した時 (:74-86) と同型の問題で、
///   `regulationCheck/check.ts` 冒頭が「ルール定義は数値基準で要求しているのに、
///   材料が入力に無かった」と記録している事故の再演にあたる。
///
/// **判断ではなく事実の列挙に徹する**: 「審査に通るか」は LINE の裁量であり、ここで
/// 可否を推定させない。出すのは「何が見えるか」だけで、ルールへの当てはめは
/// 呼び出し側 (`sticker/check.ts` の `LINE_STICKER_REVIEW`) が行う。
///
/// 返り値は **未検証の生 JSON 文字列**。パースと検証は呼び出し側が行う
/// (`codex_extract_text_blocks` / `codex_analyze_scene_layout` と同じく、
/// 未信頼入力の検証を呼び出し側1箇所に集約する)。
#[tauri::command]
pub async fn codex_review_facts(image_path: String) -> Result<String, String> {
    run_codex_vision_with_effort(&image_path, &review_facts_prompt(), REVIEW_FACTS_EFFORT).await
}

/// `codex_review_facts` のプロンプト本文。テストから中身を検証できるよう関数に切ってある
/// (「可否を判定させない」「不確かなら uncertain」がこのコマンドの契約そのもののため)。
fn review_facts_prompt() -> String {
    [
        "添付画像について以下だけを JSON で答えてください (説明文・コードフェンス不要)。",
        "あなたは事実の列挙だけを行います。**評価・判断・可否の推定はしません**。",
        "",
        "{",
        "  \"brandMarks\": [\"識別できる実在の企業ロゴ・商標・製品意匠の名称\"],",
        "  \"realPersons\": {\"present\": true, \"reason\": \"実在人物と識別できる理由\"},",
        "  \"knownCharacters\": [\"既存の商用キャラクター・作品由来と識別できるものの名称\"],",
        "  \"textStrings\": [\"画像内の文字 (URL・電話番号を含む)\"],",
        "  \"hasPictorialContent\": true,",
        "  \"skinExposure\": {\"present\": false, \"reason\": \"\"},",
        "  \"violence\": {\"present\": false, \"reason\": \"\"},",
        "  \"politicalReligious\": {\"present\": false, \"reason\": \"\"},",
        "  \"discrimination\": {\"present\": false, \"reason\": \"\"},",
        "  \"gambling\": {\"present\": false, \"reason\": \"\"}",
        "}",
        "",
        "規則:",
        "- 該当が無い項目は空配列、または present: false にする。省略しない。",
        "- **確信が持てない場合は present の代わりに文字列 \"uncertain\" を書く**。",
        "  推測で断定しない。分からないものを分かったことにしない。",
        "- brandMarks / knownCharacters は「〜風」「〜に似ている」ではなく、",
        "  **その名称だと識別できる場合にだけ**名前を書く。断定できないなら空配列。",
        "- textStrings は読める文字をそのまま書く。1文字も創作しない (読めなければ出さない)。",
        "- hasPictorialContent は「文字以外の絵の要素 (人物・動物・物・背景) が描かれているか」。",
        "  文字だけの画像なら false。",
        "- reason は日本語で簡潔に。該当なしなら空文字でよい。",
        "- **この画像が審査に通るかどうかは書かないでください**。見えるものだけを答えます。",
    ]
    .join("\n")
}

/// 画像→3Dシーン再構成用: 画像を Blender 風ブロックアウトとして解析し、
/// 床平面上の配置図・カメラを構造化 JSON で返す。
///
/// 返り値は **未検証の生 JSON 文字列**。kind ホワイトリスト照合・数値 clamp・
/// lensMm のプリセット丸めはフロント (`src/lib/scene3d/layoutAnalysis.ts`) が行う
/// (`codex_extract_text_blocks` と同じく、未信頼入力の検証を呼び出し側1箇所に集約する)。
///
/// 座標系は 0〜1000 正規化ではなくメートル実寸 (人物身長 1.7m 基準)。
/// `codex_analyze_design` が bbox を正規化スケールで出させるのと同じ意図
/// (モデルに絶対値を推測させず、既知の基準からの相対で答えさせる) を、
/// 3D 空間では「人物身長 1.7m を物差しにする」形で満たしている。
#[tauri::command]
pub async fn codex_analyze_scene_layout(image_path: String) -> Result<String, String> {
    let prompt = [
        "あなたは3Dレイアウトの分解エンジンです。添付画像を Blender 風ブロックアウトとして解析し、",
        "以下の JSON だけを出力してください (説明文・コードフェンス不要)。",
        "",
        "{",
        "  \"person\": {\"floorX\": 0.0, \"floorZ\": 0.0, \"rotationYDeg\": 0} または null,",
        "  \"objects\": [{\"kind\": \"box\", \"label\": \"机\", \"floorX\": 1.2, \"floorZ\": -0.5,",
        "               \"rotationYDeg\": 30, \"width\": 1.4, \"height\": 0.8, \"depth\": 0.7}],",
        "  \"camera\": {\"azimuthDeg\": 15, \"distanceM\": 4.0, \"heightM\": 1.5, \"lensMm\": 35}",
        "}",
        "",
        "座標系の規約:",
        "- 床平面を真上から見た配置図として答える。主要人物 (いなければ主要被写体) の足元を原点 (0,0)。",
        "- カメラはおおむね +Z 側から原点方向を見る。X=画像の右方向、Z=カメラに近づく方向。単位はメートル。",
        "- 人物の身長を 1.7m として全体のスケールを推定する。",
        "規則:",
        "- kind は次のみ: box / wall / column / table / chair / sofa / bed / shelf / pedestal /",
        "  car / tree / streetlight / building / sphere。当てはまらない物は box にして寸法で表現。",
        "- 人物は person に1人だけ (最も主要な1人)。他の人型は objects に入れない。",
        "- rotationYDeg は反時計回り。camera.azimuthDeg は真正面=0、右回り込みが正。",
        "- lensMm は 18/24/35/50/85/135 のいずれかに丸める。",
        "- 床・背景・グリッド・影は列挙しない。objects は最大12個、主要な物から。",
    ]
    .join("\n");
    run_codex_vision(&image_path, &prompt).await
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

/// `codex exec` に渡す `-c key=value` 2本を組み立てる。
/// effort が経路ごとに分岐する唯一の箇所なので、テストから直接検証できるよう関数に切ってある
/// (プロセス起動を伴わずに「審査経路だけ effort が上がっている」を確かめるため)。
fn vision_config_args(effort: &str) -> (String, String) {
    (
        format!("model={VISION_MODEL}"),
        format!("model_reasoning_effort={effort}"),
    )
}

/// Codex CLI (`codex exec -i <image>`) で画像付きプロンプトを実行し stdout を返す共通経路。
/// effort は既存経路の既定値 (`VISION_EFFORT`)。上げたい経路は
/// `run_codex_vision_with_effort` を直接呼ぶ。
async fn run_codex_vision(image_path: &str, prompt: &str) -> Result<String, String> {
    run_codex_vision_with_effort(image_path, prompt, VISION_EFFORT).await
}

/// `run_codex_vision` の effort 可変版。審査セルフチェックのように固有名詞の想起が要る
/// 経路だけ effort を上げるために分けてある (既存経路の速度を巻き添えにしないため)。
async fn run_codex_vision_with_effort(
    image_path: &str,
    prompt: &str,
    effort: &str,
) -> Result<String, String> {
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
    let (model_arg, effort_arg) = vision_config_args(effort);
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
    use super::{review_facts_prompt, vision_config_args, REVIEW_FACTS_EFFORT, VISION_EFFORT};

    #[test]
    fn review_facts_prompt_asks_for_all_review_material_keys() {
        // S7 (sticker/check.ts) の LINE_STICKER_REVIEW が材料として要求するキー。
        // どれか1つでもプロンプトから落ちると、対応するルールが材料不足で静かに空振りする
        // (codex_extract_text_blocks 新設のきっかけになった事故と同型)。
        let prompt = review_facts_prompt();
        for key in [
            "brandMarks",
            "realPersons",
            "knownCharacters",
            "textStrings",
            "hasPictorialContent",
            "skinExposure",
            "violence",
            "politicalReligious",
            "discrimination",
            "gambling",
        ] {
            assert!(
                prompt.contains(key),
                "材料キー {key} がプロンプトから欠落している"
            );
        }
    }

    #[test]
    fn review_facts_prompt_forbids_verdicts_and_guessing() {
        // このコマンドの契約: 事実の列挙に徹し、可否を判定しない (承認可否は LINE の裁量)。
        // 不確かなものを推測で断定させない (no-silent-gap-filling と同じ思想)。
        let prompt = review_facts_prompt();
        assert!(
            prompt.contains("審査に通るかどうかは書かないでください"),
            "可否を判定させない指示が消えている"
        );
        assert!(
            prompt.contains("uncertain"),
            "確信が持てない場合の逃げ道が消えている"
        );
        assert!(
            prompt.contains("推測で断定しない"),
            "推測禁止の指示が消えている"
        );
        assert!(
            prompt.contains("1文字も創作しない"),
            "文字の創作禁止 (codex_analyze_design と同じ規律) が消えている"
        );
    }

    #[test]
    fn review_facts_uses_higher_effort_than_existing_vision_paths() {
        // 審査経路だけ effort を上げるのがこのスライスの要点。
        // 既存経路 (describe/analyze) を巻き添えで遅くしていないことも同時に固定する。
        assert_eq!(VISION_EFFORT, "low", "既存経路の effort は据え置き");
        assert_ne!(
            REVIEW_FACTS_EFFORT, VISION_EFFORT,
            "審査経路が既存経路と同じ effort なら、低 effort ではブランド名が出ないという\
             このコマンドの存在理由が消える"
        );

        let (_, existing) = vision_config_args(VISION_EFFORT);
        let (_, review) = vision_config_args(REVIEW_FACTS_EFFORT);
        assert_eq!(existing, "model_reasoning_effort=low");
        assert_eq!(review, "model_reasoning_effort=medium");
    }

    #[test]
    fn review_facts_config_keeps_shared_vision_model() {
        // effort だけを分岐させる設計 (モデルは既存経路と同じ) を固定する。
        let (model_default, _) = vision_config_args(VISION_EFFORT);
        let (model_review, _) = vision_config_args(REVIEW_FACTS_EFFORT);
        assert_eq!(model_default, model_review);
        assert_eq!(model_default, "model=gpt-5.6-terra");
    }

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
            entries.push(format!(
                r#"{{"en":"item {i}","ja":"物 {i}","category":"prop"}}"#
            ));
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
