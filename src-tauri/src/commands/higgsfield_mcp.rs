//! Higgsfield リモート HTTP MCP 拡張 (2026-06-10 段階3)。
//!
//! ## なぜ MCP 方式か (CLI 同梱方式からの作り直し)
//!
//! 従来の higgsfield.rs は Higgsfield CLI バイナリ + 拡張パックを別 DL して同梱する
//! 方式で、Windows での MODULE_NOT_FOUND / 文字化け / 拡張パック DL 失敗など、配布の
//! 自己完結性が壊れやすかった。
//!
//! このモジュールは Magnific (magnific.rs) と同じ「リモート HTTP MCP に `codex mcp` で
//! 接続するだけ」の方式で Higgsfield を作り直す。CLI バイナリの別 DL は不要で、GORI 専用
//! CODEX_HOME の config.toml に `https://mcp.higgsfield.ai/mcp` を OAuth 登録するだけで
//! 有効化される。共通基盤は `crate::codex::mcp_shared`。
//!
//! ## 実機で確定済みの事実 (PoC 実証済み・2026-06-10)
//! - Higgs MCP は `generate_image` ツールを提供 (params: model, prompt, medias,
//!   aspect_ratio, count, get_cost)。実生成成功・URL 返却・DL 可能を確認済み。
//! - `models_explore` でモデルを動的取得できる。
//! - `auth_status` は Magnific と同一の "o_auth"。
//! - `codex mcp add higgsfield --url ...` だけで OAuth が自動完了する (Magnific の
//!   add→login 2 段階と同じ構造で実装し、login も冪等に試みる)。
//!
//! ## スコープ (段階3 = 画像生成 + 認証, 段階5 = 動画生成 + 参照画像アップロード)
//! 段階5 で `generate_video` と参照画像の `media_upload`→PUT→`media_confirm` を追加する。
//! 既存 higgsfield.rs (CLI 版) は触らず共存。
//!
//! ## 段階5 で PoC 実証済みの事実 (推測でなくこれに従う・2026-06-10)
//! - `generate_video` params: model, prompt, medias, duration, aspect_ratio, count, get_cost
//!   に加え、モデル固有パラメータ (mode/genre/resolution/sound 等) を **トップレベル** で渡す。
//! - seedance_2_0: resolution(480p/720p/1080p) / mode(std/fast) /
//!   genre(auto/action/horror/comedy/noir/drama/epic)。
//! - kling3_0: sound(on/off)。
//! - 参照画像は `media_upload` でアップロード URL を発行 → その URL に PUT →
//!   `media_confirm` で media_id を取得 → `generate_image`/`generate_video` の
//!   `medias` パラメータに media_id を渡す (codex exec 経由で実証済み)。

use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::codex::mcp_shared::{
    entry_is_authenticated, extract_first_url, find_mcp_entry, gori_codex_command,
    run_codex_capture,
};
use crate::codex::process::{enriched_path, resolve_codex_cli_binary};

const HIGGSFIELD_MCP_NAME: &str = "higgsfield";
const HIGGSFIELD_MCP_URL: &str = "https://mcp.higgsfield.ai/mcp";

/// Higgsfield MCP 拡張の接続状態。未接続なら全 false で UI が degrade する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpStatus {
    /// config.toml に higgsfield MCP が登録されているか。
    pub registered: bool,
    /// OAuth 認証済みか (codex mcp list の auth_status が OAuth 系)。
    pub authenticated: bool,
}

/// 全 false の未接続状態 (degrade 用)。codex 不在・実行失敗・JSON 解析失敗の
/// いずれでも起動を止めず、Higgsfield を「持っていない」扱いにする。
fn higgsfield_mcp_status_unavailable() -> HiggsfieldMcpStatus {
    HiggsfieldMcpStatus {
        registered: false,
        authenticated: false,
    }
}

/// Higgsfield MCP 拡張の接続状態を返す。失敗しても起動を止めず、未接続として degrade する。
#[tauri::command]
pub async fn higgsfield_mcp_status() -> Result<HiggsfieldMcpStatus, String> {
    let mut cmd = match gori_codex_command() {
        Ok(c) => c,
        // codex が無い環境では「未接続」として扱う (コアは別経路なので影響しない)。
        Err(_) => return Ok(higgsfield_mcp_status_unavailable()),
    };
    cmd.args(["mcp", "list", "--json"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return Ok(higgsfield_mcp_status_unavailable()),
    };
    // `mcp list` はローカル config を読むだけなので速いが、念のため上限を設ける。
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        // 実行失敗・タイムアウトとも未接続として degrade。
        _ => return Ok(higgsfield_mcp_status_unavailable()),
    };

    let Some(entry) = find_mcp_entry(&output.stdout, HIGGSFIELD_MCP_NAME) else {
        return Ok(higgsfield_mcp_status_unavailable());
    };
    Ok(HiggsfieldMcpStatus {
        registered: true,
        authenticated: entry_is_authenticated(&entry),
    })
}

/// `codex mcp login` の OAuth がブラウザ完了までブロックしうる上限。
/// ユーザーがブラウザでログインを終えるまで子プロセスが生きるので、待ち時間を長めに取る。
const HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS: u64 = 180;

/// Higgsfield MCP を登録し OAuth 認証を起動する。
///
/// 実機確認 (2026-06-10): `codex mcp add higgsfield --url ...` だけで OAuth が自動完了する。
/// ただし Magnific の add→login 2 段階と同じ構造で実装し、add 後に login も **冪等に**
/// 試みる (既に認証済みなら login は no-op / 成功する想定。万一 add だけで認証が完了
/// しない codex バージョンでも login が補完する)。最後に status を再確認して結果を返す。
#[tauri::command]
pub async fn higgsfield_mcp_login() -> Result<String, String> {
    // ① 登録 (mcp add)。実機ではこの段階で OAuth が自動完了する。既に登録済みだと
    //    codex が非ゼロ終了することがあるが、それはエラーにせず login に進む (冪等性)。
    let add = run_codex_capture(
        &["mcp", "add", HIGGSFIELD_MCP_NAME, "--url", HIGGSFIELD_MCP_URL],
        std::time::Duration::from_secs(HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS),
    )
    .await?;
    if !add.0 {
        // 「already exists」系は無視して login に進む。それ以外の本当の失敗で login が
        // また失敗すれば、下で status 確認時にエラーが返るので二重に止めない。
        let lower = format!("{} {}", add.1, add.2).to_lowercase();
        let already_registered =
            lower.contains("already") || lower.contains("exist") || lower.contains("既に");
        if !already_registered {
            tracing::warn!(target: "higgsfield_mcp", "mcp add 非ゼロ終了 (login で再試行): {}", add.2);
        }
    }

    // ② OAuth 認証 (mcp login)。add で既に完了している場合も冪等に試みる。
    //    login が失敗しても add で認証済みなら status 確認で救えるので、ここでは止めない。
    let login = run_codex_capture(
        &["mcp", "login", HIGGSFIELD_MCP_NAME],
        std::time::Duration::from_secs(HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS),
    )
    .await;
    if let Err(e) = &login {
        tracing::warn!(target: "higgsfield_mcp", "mcp login 失敗 (add で認証済みの可能性・status で再確認): {e}");
    }

    // ③ 認証済みかを status で最終確認する。add だけで完了するケース・login で完了する
    //    ケースの両方を、実際の auth_status で判定する (推測しない)。
    let status = higgsfield_mcp_status().await?;
    if status.authenticated {
        Ok("Higgsfield の認証が完了しました。".to_string())
    } else if status.registered {
        Err("Higgsfield を登録しましたが、認証が完了していません。ブラウザでのログインを完了してから、もう一度「接続」を押してください。".to_string())
    } else {
        // 登録すらできていない = add が本当に失敗した。login の stderr があれば添える。
        let detail = login
            .ok()
            .map(|(_, _, stderr)| stderr)
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        Err(if detail.is_empty() {
            "Higgsfield MCP の登録に失敗しました。codex が利用可能か確認してください。".to_string()
        } else {
            format!("Higgsfield MCP の登録に失敗しました: {detail}")
        })
    }
}

/// Higgsfield MCP の登録を解除する (codex mcp remove)。
///
/// magnific_logout はタイムアウト無しだったが、こちらは run_codex_capture 経由で
/// タイムアウトを付ける (remove がローカル config 操作で速いとはいえ、万一ハングしても
/// UI を固めない)。
#[tauri::command]
pub async fn higgsfield_mcp_logout() -> Result<(), String> {
    let _ = run_codex_capture(
        &["mcp", "remove", HIGGSFIELD_MCP_NAME],
        std::time::Duration::from_secs(30),
    )
    .await?;
    Ok(())
}

/// Higgsfield 生成の結果。コアの BatchGenResult / MagnificGenResult と同じ形に揃えて
/// フロントが区別不要にする。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpGenResult {
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
    pub errors: Vec<String>,
}

/// 画像 / 動画の分岐。フロントの `MediaType` ("image" | "video") と鏡映。
/// 未指定 (None) は image 扱い (段階3 までの画像生成と後方互換)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HiggsfieldMcpMediaType {
    Image,
    Video,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpGenArgs {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub ref_image_paths: Vec<String>,
    /// "image" | "video"。未指定なら image (後方互換)。
    #[serde(default)]
    pub media_type: Option<HiggsfieldMcpMediaType>,
    // ── 以下は media_type=video のときだけ意味を持つ動画パラメータ ──
    /// 秒数 (例: 5)。generate_video の duration。
    #[serde(default)]
    pub duration: Option<u32>,
    /// 描画モード (例: seedance std/fast)。トップレベルで渡す。
    #[serde(default)]
    pub mode: Option<String>,
    /// 解像度 (例: seedance 480p/720p/1080p)。トップレベルで渡す。
    #[serde(default)]
    pub resolution: Option<String>,
    /// 効果音 (例: kling on/off)。トップレベルで渡す。
    #[serde(default)]
    pub sound: Option<String>,
    /// ジャンル (例: seedance auto/action/horror/comedy/noir/drama/epic)。
    #[serde(default)]
    pub genre: Option<String>,
    /// モデルのバリアント (CLI 版の --model に相当する model_variant)。
    #[serde(default)]
    pub model_variant: Option<String>,
}

impl HiggsfieldMcpGenArgs {
    fn is_video(&self) -> bool {
        matches!(self.media_type, Some(HiggsfieldMcpMediaType::Video))
    }
}

/// 参照画像(ローカルパス)を medias として渡すための共通プロンプト断片を組む。
///
/// PoC 実証済み: `media_upload` でアップロード URL を発行 → その URL に PUT →
/// `media_confirm` で media_id を取得 → `generate_image`/`generate_video` の
/// `medias` に media_id を渡す、という3段フローを codex に実行させる。参照画像が
/// 無ければ空文字を返す (medias 指示なし)。
fn ref_medias_instruction(ref_image_paths: &[String]) -> String {
    let paths: Vec<&String> = ref_image_paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .collect();
    if paths.is_empty() {
        return String::new();
    }
    let list = paths
        .iter()
        .map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join("\n  - ");
    format!(
        "参照画像(ローカルファイル)を入力として使います。次の手順で media_id を取得し、\
         生成ツールの `medias` パラメータに渡してください:\n  \
         1. 各ローカル参照画像について `media_upload` を呼び、アップロード用URLを発行する。\n  \
         2. 発行されたURLに、対応するローカルファイルの中身を **HTTP PUT** でアップロードする\
         (curl 等で `--upload-file <ローカルパス> <発行URL>`)。\n  \
         3. `media_confirm` を呼び、各アップロードの media_id を取得する。\n  \
         4. 取得した media_id を生成ツールの `medias` パラメータ(配列)に渡す。\n  \
         対象ローカル参照画像:\n  - {list}\n"
    )
}

/// 動画 / 画像で異なる「ツール名・成果物の語」を返す。保存拡張子は結果 URL から
/// `extension_for` で別途決める (ここでは持たない)。
struct MediaCopy {
    /// 呼ぶべき MCP ツール名 (generate_image / generate_video)。
    tool: &'static str,
    /// 成果物の語 (画像 / 動画)。プロンプト文面に差し込む。
    noun: &'static str,
}

/// 動画モデル固有パラメータを「- key: value」形式のプロンプト断片に組む。
/// 空 / None のものは出力しない。CLI 版 run_one_higgsfield_job のフラグ集合と対応する。
fn video_param_lines(args: &HiggsfieldMcpGenArgs) -> String {
    let mut out = String::new();
    if let Some(d) = args.duration {
        out.push_str(&format!("- duration: {d}\n"));
    }
    let mut push_opt = |label: &str, v: &Option<String>| {
        if let Some(s) = v.as_deref().filter(|s| !s.trim().is_empty()) {
            out.push_str(&format!("- {label}: {s}\n"));
        }
    };
    // モデル固有パラメータは **トップレベル** で渡す (PoC 実証済み)。
    push_opt("mode", &args.mode);
    push_opt("resolution", &args.resolution);
    push_opt("sound", &args.sound);
    push_opt("genre", &args.genre);
    // model_variant は model のバリアント指定。model が未指定でもバリアントだけ来うる。
    if let Some(mv) = args.model_variant.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("- model_variant: {mv}\n"));
    }
    out
}

/// 1枚分の codex exec プロンプトを組む。media_type で generate_image / generate_video を
/// 分岐し、参照画像があれば media_upload→PUT→media_confirm→medias の手順を必ず入れる。
/// 動画版にも画像版と同じ【重要・厳守】ガード(新規生成強制 + 参照URL返却禁止)を入れる。
fn build_gen_prompt(args: &HiggsfieldMcpGenArgs, aspect: &str) -> String {
    let video = args.is_video();
    let copy = if video {
        MediaCopy { tool: "generate_video", noun: "動画" }
    } else {
        MediaCopy { tool: "generate_image", noun: "画像" }
    };

    // モデル指定の有無で文面を変える。未指定なら models_explore で選ばせる。
    let model_note = match args.model.as_deref().filter(|s| !s.is_empty()) {
        Some(model) => format!("- model: {model}\n"),
        None => "- model: models_explore で利用可能なモデルから適切なものを1つ選ぶ\n".to_string(),
    };
    // 動画だけ duration / mode / resolution / sound / genre 等を渡す。
    let video_lines = if video {
        let lines = video_param_lines(args);
        if lines.is_empty() {
            String::new()
        } else {
            format!("以下のモデル固有パラメータをトップレベルで渡してください:\n{lines}")
        }
    } else {
        String::new()
    };
    let ref_note = ref_medias_instruction(&args.ref_image_paths);

    format!(
        "higgsfield MCP の {tool} ツールを**必ず実行して**、{noun}を新規に1つ生成してください。\n\
         {model_note}\
         - aspect_ratio: {aspect}\n\
         - count: 1\n\
         - prompt: {user_prompt}\n\
         {video_lines}\
         {ref_note}\
         モデルが分からなければ models_explore で選んでください。\n\
         【重要・厳守】\n\
         - {tool} を実行せずに、既存メディアや参照画像(medias)のURLをそのまま返すことは禁止です。\
         必ず {tool} を呼び出して、**今回新しく生成された{noun}**の結果URLを返してください。\n\
         - 参照画像(medias)は {tool} の入力として渡すだけです。参照画像そのもののURLを最終回答にしてはいけません。\n\
         生成が完了したら、最終メッセージは\
         **今回新規生成された{noun}のダウンロードURL(http(s)で始まる1個)だけ**を1行で返してください。\
         説明文や他のテキストは一切含めないこと。",
        tool = copy.tool,
        noun = copy.noun,
        model_note = model_note,
        aspect = aspect,
        user_prompt = args.prompt,
        video_lines = video_lines,
        ref_note = ref_note,
    )
}

/// 結果 URL から保存に使う拡張子を決める。URL のクエリを除いたパスの末尾拡張子を
/// 優先し、無ければ media_type のデフォルト (video=mp4 / image=png) にフォールバックする。
/// mp4 等の動画拡張子に対応するための関数 (受入基準4)。
fn extension_for(url: &str, is_video: bool) -> String {
    // クエリ・フラグメントを落としてからパスの拡張子を見る。
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url);
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, e)| e))
        .map(|e| e.to_ascii_lowercase());
    let known = [
        "mp4", "mov", "webm", "m4v", // 動画
        "png", "jpg", "jpeg", "webp", "gif", // 画像
    ];
    match ext {
        Some(e) if known.contains(&e.as_str()) => e,
        // 拡張子が無い / 未知の場合は media_type で決める。
        _ => if is_video { "mp4".to_string() } else { "png".to_string() },
    }
}

/// Higgsfield MCP 経由で画像 **または動画** を生成し、結果 URL を
/// generated_images/higgsfield/ にダウンロードする。コア(batch_gen)は触らず、
/// Higgsfield モデルが選ばれたときだけこの経路を通る。
///
/// PoC 実証済みの `generate_image` / `generate_video` ツールを codex exec 経由で叩く。
/// モデル未指定なら codex に `models_explore` でモデルを選ばせる。
/// 参照画像があれば media_upload→PUT→media_confirm→medias の手順を codex に実行させる。
#[tauri::command]
pub async fn higgsfield_mcp_generate_batch(
    args: HiggsfieldMcpGenArgs,
) -> Result<HiggsfieldMcpGenResult, String> {
    let binary = resolve_codex_cli_binary()
        .map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
    let home = crate::codex::home::gori_codex_home_path();
    let count = args.count.unwrap_or(1).clamp(1, 4);
    let aspect = args.aspect.as_deref().filter(|s| !s.is_empty()).unwrap_or("1:1");
    let is_video = args.is_video();

    let mut generated_paths = Vec::new();
    let mut errors = Vec::new();
    let mut failed_count = 0u32;

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("higgsfield");
    std::fs::create_dir_all(&dir).map_err(|e| format!("higgsfield dir 作成失敗: {e}"))?;
    let http = reqwest::Client::new();

    for i in 0..count {
        // codex に Higgsfield MCP の generate_image / generate_video を使わせ、結果 URL
        // だけを返させる。参照画像があれば media_upload→PUT→media_confirm→medias の手順を
        // 同じプロンプトで指示する。
        let prompt = build_gen_prompt(&args, aspect);

        let mut cmd = tokio::process::Command::new(&binary);
        cmd.args([
            "exec",
            // Windows では --full-auto(=--sandbox workspace-write)が
            // codex-windows-sandbox-setup.exe を要求して「見つかりません」で死ぬ。
            // BYO 配布(ユーザー自身の PC・自身のサブスク=外部サンドボックス環境)では
            // サンドボックス無効の bypass を使う。これで Windows でも生成できる。
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--color",
            "never",
            "-c",
            "model=gpt-5.5",
            "-c",
            "model_reasoning_effort=low",
            "-",
        ]);
        cmd.env("PATH", enriched_path());
        if let Some(h) = home.as_ref() {
            cmd.env("CODEX_HOME", h);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);

        use tokio::io::AsyncWriteExt;
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                failed_count += 1;
                errors.push(format!("codex spawn 失敗: {e}"));
                continue;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }

        // Higgsfield 生成は MCP 往復 + クラウド生成で時間がかかる。動画は画像より重く、
        // 参照画像アップロード(media_upload→PUT→media_confirm)も挟むので長めに取る。
        // 画像 300 秒 / 動画 900 秒 (DEV-PLAYBOOK の生成3点セット = タイムアウト 900 秒に揃える)。
        let timeout_secs = if is_video { 900 } else { 300 };
        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                failed_count += 1;
                errors.push(format!("codex 実行失敗: {e}"));
                continue;
            }
            Err(_) => {
                failed_count += 1;
                errors.push(format!(
                    "Higgsfield 生成が {timeout_secs} 秒でタイムアウトしました"
                ));
                continue;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(url) = extract_first_url(&stdout) else {
            failed_count += 1;
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!(
                "Higgsfield 生成結果のURLを取得できませんでした (stderr: {})",
                stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("")
            ));
            continue;
        };

        // 成果物の語 (画像/動画) をエラー文面に揃える。
        let noun = if is_video { "動画" } else { "画像" };
        // URL の拡張子 (無ければ media_type デフォルト) で保存名を決める。mp4 等の
        // 動画拡張子に対応 (extract_first_url は拡張子を問わず http(s) URL を拾う)。
        let ext = extension_for(&url, is_video);

        // URL を generated_images/higgsfield/ にダウンロード保存。
        match http.get(&url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) if !bytes.is_empty() => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let dest = dir.join(format!("higgsfield-{ts}-{i}.{ext}"));
                    if let Err(e) = std::fs::write(&dest, &bytes) {
                        failed_count += 1;
                        errors.push(format!("{noun}保存失敗: {e}"));
                    } else {
                        generated_paths.push(dest.to_string_lossy().into_owned());
                    }
                }
                _ => {
                    failed_count += 1;
                    errors.push(format!("Higgsfield {noun}データが空でした"));
                }
            },
            Ok(res) => {
                failed_count += 1;
                errors.push(format!("Higgsfield {noun}取得に失敗 (HTTP {})", res.status()));
            }
            Err(e) => {
                failed_count += 1;
                errors.push(format!("Higgsfield {noun}取得に失敗: {e}"));
            }
        }
    }

    Ok(HiggsfieldMcpGenResult {
        generated_paths,
        failed_count,
        errors,
    })
}
