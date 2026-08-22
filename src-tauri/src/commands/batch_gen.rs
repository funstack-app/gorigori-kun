//! Parallel image generation through a dedicated resident `codex app-server`.
//!
//! Each image uses an independent app-server thread, so separate turns can run
//! concurrently without paying the fixed `codex exec` startup cost per image.
//! The former per-worker `codex exec` path remains as an automatic fallback.
//!
//! The completed PNGs are copied into the configured local storage root
//! (default `~/Pictures/GORI GORI/batch-<id>/`) so user-visible output
//! no longer depends on Codex CLI's volatile `~/.codex/generated_images/`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_queue::{self, GLOBAL_GEN_SEMAPHORE};
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_IMAGE_BATCH;
use crate::state::AppState;

type ExecFallback = Result<(PathBuf, PathBuf), String>;

#[cfg(not(windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttemptPath {
    Resident,
    Exec,
}

#[cfg(not(windows))]
fn next_attempt_path(resident_timed_out: bool) -> AttemptPath {
    if resident_timed_out {
        AttemptPath::Exec
    } else {
        AttemptPath::Resident
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchGenArgs {
    pub prompt: String,
    pub count: u32,
    pub cwd: Option<String>,
    #[serde(default)]
    pub ref_image_paths: Vec<String>,
    /// `ref_image_paths` と同 index で対応するマスク画像。空文字は「マスクなし」。
    /// 空配列のときも全 ref がマスクなし扱い。
    #[serde(default)]
    pub mask_paths: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub aspect: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    /// 呼び出し元スキルの親 run ID（漫画など、複数の batch を1つの run として
    /// 束ねる direct-run 経路が渡す）。Started イベントで echo するだけで、
    /// 生成・保存・台帳のキーには一切使わない。
    #[serde(default)]
    pub source_tag: Option<String>,
    /// 生成画像を `aspect` の規格寸法へ正規化するか（通常生成専用の明示オプトイン）。
    /// 既定 false のため、comic・マスク編集・img2img など既存呼び出し元の挙動は不変。
    /// 表は `crate::images::normalize::canonical_size`。
    #[serde(default)]
    pub enforce_aspect: bool,
    /// 1 worker あたりの生成試行回数の上限（1..=`DEFAULT_MAX_ATTEMPTS`）。
    ///
    /// 未指定なら従来どおり `DEFAULT_MAX_ATTEMPTS`（=3）。
    /// ブロックアウト生成のように「1操作 = 最大1生成」を守る必要がある呼び出し元
    /// （生成枠を燃やさない。設計 r3 追補1）が `1` を渡して自動リトライを止める。
    #[serde(default)]
    pub max_attempts: Option<u32>,
}

/// 1 worker あたりの生成試行回数の既定上限。
///
/// マルチアングル/storyboard と同じく、失敗したら自動でやり直す。gpt-image-2 の
/// ServerError や image_gen 呼び忘れは一時的なことが多く、2 回目以降で成功する
/// ことがある(2026-06-09 通常生成にもリトライを横展開)。
const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// 呼び出し元指定の `max_attempts` を有効範囲へ丸める。
///
/// 0 や巨大値を素通しすると「1回も試さない」「生成枠を延々燃やす」の両方が起きるため、
/// 1..=`DEFAULT_MAX_ATTEMPTS` に clamp する。未指定は既定値（従来挙動）。
fn resolve_max_attempts(requested: Option<u32>) -> u32 {
    match requested {
        Some(n) => n.clamp(1, DEFAULT_MAX_ATTEMPTS),
        None => DEFAULT_MAX_ATTEMPTS,
    }
}

/// 常駐経路の失敗時に、**同じ周回のうちに** codex exec 経路へ切り替えてよいか。
///
/// `max_attempts == 1` の呼び出し元（ブロックアウト等の「1操作 = 最大1生成」）では
/// false を返す。ループ上限を1にしただけでは、常駐失敗→exec フォールバックが1周の
/// 中で連続して走り、生成が計2回発火してしまうため（設計 r3 追補1）。
/// 2回以上の呼び出し元は従来どおりフォールバックする（挙動不変）。
fn allows_exec_fallback(max_attempts: u32) -> bool {
    max_attempts > 1
}

/// リトライループを打ち切るべきエラーか。
///
/// 中止（ユーザー操作）とサイズ不一致は、同じ条件で再実行しても結果が変わらない
/// 確定的失敗。特にサイズ不一致で再生成すると生成枠を無駄に燃やすため即 break する。
fn should_abort_attempts(error: &str) -> bool {
    gen_queue::is_cancelled_error(error) || crate::images::normalize::is_size_mismatch_error(error)
}

/// 常駐経路が失敗して codex exec へフォールバックしたときの、最終エラー文言を作る。
///
/// 通常は両方の理由を並べて真因を追えるようにするが、`should_abort_attempts` が
/// 見る確定的失敗（中止・サイズ不一致）は**包まずに素通しする**。包むと接頭辞判定が
/// 外れ、再生成しても直らないのにリトライループが最大 MAX_ATTEMPTS 回まわり、
/// 生成枠を無駄に燃やす。
fn merge_fallback_error(resident_error: &str, exec_error: String) -> String {
    if should_abort_attempts(&exec_error) {
        return exec_error;
    }
    format!("常駐 app-server 経路: {resident_error}; codex exec フォールバック: {exec_error}")
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchGenResult {
    pub batch_id: String,
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
    // 失敗した worker の理由 (NSFW / 認証切れ / タイムアウト / image_gen 未呼び出し等)。
    // これを返さないと、フロントは理由ゼロ件→「アスペクト比が原因」の固定文言に
    // 丸めてしまい、真因がユーザーに届かない (2026-06-07 独立診断の根本原因)。
    pub errors: Vec<String>,
    /// この run に中止印が付いていたか。true なら「生成0枚・失敗0件」は
    /// 異常ではなく中止の結果。フロントはこれだけを根拠に中止と判定してよい。
    pub cancelled: bool,
}

// `rename_all` on the enum only renames variant names, not the
// variant *fields*. We need `rename_all_fields` so `batch_id` /
// `failed_count` / `generated_paths` actually serialize as
// `batchId` / `failedCount` / `generatedPaths` — without it, the
// frontend sees `e.failedCount === undefined` and the BatchCard
// renders "⚠ 3/3 枚完了 — 件失敗" with the count missing.
#[derive(Serialize, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum BatchEvent {
    Started {
        batch_id: String,
        count: u32,
        /// 呼び出し元が渡した親 run ID の echo。direct-run 経路 (漫画など) が
        /// 「この子 batch はどの親のものか」をフロントで紐付けるためだけに使う。
        #[serde(skip_serializing_if = "Option::is_none")]
        source_tag: Option<String>,
    },
    WorkerStarted {
        batch_id: String,
        idx: u32,
    },
    WorkerCompleted {
        batch_id: String,
        idx: u32,
        path: String,
    },
    WorkerFailed {
        batch_id: String,
        idx: u32,
        error: String,
    },
    Completed {
        batch_id: String,
        generated_paths: Vec<String>,
        failed_count: u32,
        errors: Vec<String>,
    },
}

#[tauri::command]
pub async fn images_generate_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    args: BatchGenArgs,
) -> Result<BatchGenResult, String> {
    if args.count == 0 {
        return Err("count must be >= 1".into());
    }
    // 旧 codex exec 用の情報は予備ルートとして保持する。解決できなくても常駐
    // app-server が成功する限り生成できるよう、エラーはフォールバック時まで遅延する。
    let exec_fallback: ExecFallback = resolve_codex_cli_binary()
        .map_err(|error| format!("Codex CLI の解決に失敗: {error}"))
        .and_then(|codex_bin| {
            crate::codex::home::resolve_command_codex_home()
                .map(|codex_home| (codex_bin, codex_home))
                .ok_or_else(|| "CODEX_HOME を解決できません".to_string())
        });

    let batch_id = format!("batch-{}", short_id());
    gen_queue::clear_cancelled(&batch_id);
    // 実行中 run 台帳への登録。この関数は inline await なので、guard をローカルに
    // 持つだけで関数を抜けるとき (成功・早期 return・エラー) に必ず外れる。
    let _active_run = gen_queue::ActiveRunGuard::begin(&batch_id);
    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(args.cwd.as_deref());
    let out_dir = resolve_output_dir(&storage_settings, project_name.as_deref(), &batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        BatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.count,
            source_tag: args.source_tag.clone(),
        },
    );

    // 同時実行の制御は gen_queue::GLOBAL_GEN_SEMAPHORE(全機能共通・上限6)に一本化。
    // 旧バッチ内上限3は撤去(2026-07-17 実測: 同時9枚まで429ゼロ)。

    let mut handles = Vec::with_capacity(args.count as usize);
    for idx in 1..=args.count {
        let app = app.clone();
        let state = state.inner_clone();
        let exec_fallback = exec_fallback.clone();
        let out_dir = out_dir.clone();
        let batch_id = batch_id.clone();
        let prompt = args.prompt.clone();
        let cwd = args.cwd.clone();
        let refs = args.ref_image_paths.clone();
        let masks = args.mask_paths.clone();
        let model = args.model.clone();
        let effort = args.effort.clone();
        let aspect = args.aspect.clone();
        let turn_id = args.turn_id.clone();
        let total_count = args.count;
        let enforce_aspect = args.enforce_aspect;
        let max_attempts = resolve_max_attempts(args.max_attempts);
        handles.push(tokio::spawn(async move {
            run_one_worker(
                app,
                state,
                exec_fallback,
                out_dir,
                batch_id,
                idx,
                prompt,
                cwd,
                refs,
                masks,
                model,
                effort,
                aspect,
                total_count,
                turn_id,
                enforce_aspect,
                max_attempts,
            )
            .await
        }));
    }

    let mut generated_paths = Vec::new();
    let mut failed_count = 0u32;
    let mut errors: Vec<String> = Vec::new();
    for h in handles {
        match h.await {
            Ok(Ok(p)) => generated_paths.push(p),
            Ok(Err(reason)) if gen_queue::is_cancelled_error(&reason) => {}
            Ok(Err(reason)) => {
                failed_count += 1;
                errors.push(reason);
            }
            Err(join_err) => {
                tracing::warn!(target: "codex.batch", "worker join failed: {join_err}");
                failed_count += 1;
                errors.push(format!("内部エラー (worker join 失敗): {join_err}"));
            }
        }
    }

    let was_cancelled = gen_queue::is_cancelled(&batch_id);
    if !was_cancelled {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            BatchEvent::Completed {
                batch_id: batch_id.clone(),
                generated_paths: generated_paths.clone(),
                failed_count,
                errors: errors.clone(),
            },
        );
    }
    gen_queue::clear_cancelled(&batch_id);

    Ok(BatchGenResult {
        batch_id,
        generated_paths,
        failed_count,
        errors,
        // 208行の was_cancelled をそのまま運ぶ。clear_cancelled の後に読むと
        // 常に false になるため、読み取り位置 (clear より前) を動かさないこと。
        cancelled: was_cancelled,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_one_worker(
    app: AppHandle,
    state: AppState,
    exec_fallback: ExecFallback,
    out_dir: PathBuf,
    batch_id: String,
    idx: u32,
    prompt: String,
    cwd: Option<String>,
    ref_paths: Vec<String>,
    mask_paths: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
    aspect: Option<String>,
    total_count: u32,
    turn_id: Option<String>,
    // true なら回収点で規格寸法へ正規化する (通常生成のみ)。
    enforce_aspect: bool,
    // 試行回数の上限 (呼び出し元指定。`resolve_max_attempts` で clamp 済み)。
    max_attempts: u32,
    // Ok(成功画像パス) / Err(失敗理由)。理由を呼び出し元に伝えることで、
    // フロントが真因を表示できる (握りつぶし解消)。
) -> Result<String, String> {
    if gen_queue::is_cancelled(&batch_id) {
        return Err(gen_queue::cancelled_error());
    }
    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        BatchEvent::WorkerStarted {
            batch_id: batch_id.clone(),
            idx,
        },
    );

    // 失敗したら最大 max_attempts 回まで自動でやり直す（既定 DEFAULT_MAX_ATTEMPTS=3。
    // 由来は同定数のドキュメント参照）。呼び出し元が 1 を渡した場合はループが1周で
    // 終わるため、自動リトライは**構造的に発生しない**（設計 r3 追補1）。
    // 注意: WorkerStarted/Completed/Failed イベントは1回だけ発火させたいので、
    // リトライは inner 呼び出しだけをループする。
    let max_attempts = max_attempts.max(1);
    // 上限1周の呼び出し元は「1操作 = 最大1生成」を求めている。ループ上限だけでは
    // 常駐失敗時の exec フォールバックが**同じ周回の中で**走り、生成が計2回発火する。
    // 生成経路の実呼び出しを構造的に最大1回へ抑えるため、フォールバック自体を止める。
    #[cfg(not(windows))]
    let allow_exec_fallback = allows_exec_fallback(max_attempts);
    let mut result: Result<String, String> = Err("未実行".to_string());
    #[cfg(not(windows))]
    let mut attempt_path = AttemptPath::Resident;
    for attempt in 1..=max_attempts {
        if gen_queue::is_cancelled(&batch_id) {
            result = Err(gen_queue::cancelled_error());
            break;
        }
        #[cfg(windows)]
        {
            // Windows は常駐 app-server を使わず、各試行を従来の exec 経路へ直行させる。
            result = match exec_fallback.clone() {
                Ok((codex_bin, codex_home_orig)) => {
                    run_one_worker_exec_inner(
                        &app,
                        codex_bin,
                        codex_home_orig,
                        &out_dir,
                        idx,
                        prompt.clone(),
                        cwd.clone(),
                        ref_paths.clone(),
                        mask_paths.clone(),
                        model.clone(),
                        effort.clone(),
                        aspect.clone(),
                        total_count,
                        &batch_id,
                        enforce_aspect,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
        }
        #[cfg(not(windows))]
        {
            let mut resident_timed_out = false;
            result = run_one_worker_inner(
                &app,
                &state,
                exec_fallback.clone(),
                &out_dir,
                idx,
                prompt.clone(),
                cwd.clone(),
                ref_paths.clone(),
                mask_paths.clone(),
                model.clone(),
                effort.clone(),
                aspect.clone(),
                total_count,
                attempt_path,
                &mut resident_timed_out,
                &batch_id,
                enforce_aspect,
                allow_exec_fallback,
            )
            .await;
            attempt_path = next_attempt_path(resident_timed_out);
        }
        if result.is_ok() {
            break;
        }
        if let Err(e) = &result {
            // 中止・サイズ不一致は再試行しても同じ結果になるため、枠を燃やさず即中断する。
            if should_abort_attempts(e) {
                break;
            }
            tracing::warn!(
                target: "codex.batch_gen",
                "worker {idx} attempt {attempt}/{max_attempts} failed: {e}"
            );
        }
    }

    if gen_queue::is_cancelled(&batch_id) {
        result = Err(gen_queue::cancelled_error());
    }

    // DB 記録失敗で画像生成そのものを再試行しないよう、既存の生成リトライが
    // 終わった後に1回だけ確定記録する。PNG は inner ですでに保存済み。
    if let (Some(path), Some(turn_id)) = (
        result.as_ref().ok().cloned(),
        turn_id.as_deref().filter(|id| !id.trim().is_empty()),
    ) {
        if let Err(error) =
            crate::commands::sessions::record_generated_image(&app, turn_id, Path::new(&path)).await
        {
            result = Err(format!(
                "画像は保存しましたが、履歴DBへの記録に失敗しました: {error}"
            ));
        }
    }
    if gen_queue::is_cancelled(&batch_id) {
        result = Err(gen_queue::cancelled_error());
    }

    // inner は Result<成功パス, 失敗理由> を返す。失敗理由は WorkerFailed
    // イベントと戻り値の Err の両方に同じ文言を載せ、フロントがどちらの経路でも
    // 真因を拾えるようにする。外部API障害(ServerError/5xx/401等)なら非エンジニア
    // 向けの文言に整形する(humanize)。
    let normalized: Result<String, String> = result.map_err(|e| {
        // サイズ不一致は cancelled と同列で humanize を通さない。整形すると
        // 「実測 W×H」「素材は _raw.png に残しています」という真因が上書きされる。
        if gen_queue::is_cancelled_error(&e) || crate::images::normalize::is_size_mismatch_error(&e)
        {
            e
        } else {
            // 429 なら同時実行数を自動降格する (T3)。humanize より前に判定する
            // — 整形後も429語は拾えるが、生エラーのほうが判定材料が多い。
            crate::codex::gen_server::note_rate_limit(&app, &e);
            crate::codex::process::humanize_generation_failure(&e)
        }
    });

    match &normalized {
        Ok(path) => {
            let _ = app.emit(
                EVENT_IMAGE_BATCH,
                BatchEvent::WorkerCompleted {
                    batch_id: batch_id.clone(),
                    idx,
                    path: path.clone(),
                },
            );
        }
        Err(reason) => {
            if gen_queue::is_cancelled_error(reason) {
                return normalized;
            }
            let _ = app.emit(
                EVENT_IMAGE_BATCH,
                BatchEvent::WorkerFailed {
                    batch_id: batch_id.clone(),
                    idx,
                    error: reason.clone(),
                },
            );
        }
    }

    normalized
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
async fn run_one_worker_inner(
    app: &AppHandle,
    state: &AppState,
    exec_fallback: ExecFallback,
    out_dir: &Path,
    idx: u32,
    prompt: String,
    cwd: Option<String>,
    ref_paths: Vec<String>,
    mask_paths: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
    aspect: Option<String>,
    total_count: u32,
    attempt_path: AttemptPath,
    resident_timed_out: &mut bool,
    run_id: &str,
    enforce_aspect: bool,
    // false なら、常駐経路が失敗しても**同じ周回のうちに** codex exec へ切り替えない。
    // 呼び出し元が `max_attempts = 1`（1操作 = 最大1生成）を指定したときに立つ。
    // ループ上限だけでは exec フォールバックが同一周回で走り、生成が2回発火しうる
    // （設計 r3 追補1 の「生成枠を燃やさない」に反する）ため、ここで塞ぐ。
    allow_exec_fallback: bool,
) -> Result<String, String> {
    if attempt_path == AttemptPath::Exec {
        tracing::info!(
            target: "codex.batch_gen",
            "worker {idx}: 前試行の常駐 app-server タイムアウト後のため codex exec 経路を使用します"
        );
        let (codex_bin, codex_home_orig) = exec_fallback?;
        return run_one_worker_exec_inner(
            app,
            codex_bin,
            codex_home_orig,
            out_dir,
            idx,
            prompt,
            cwd,
            ref_paths,
            mask_paths,
            model,
            effort,
            aspect,
            total_count,
            run_id,
            enforce_aspect,
        )
        .await;
    }

    // ref と mask は従来の `-i` と同じ順序で app-server の localImage input にする。
    let mut slots: Vec<(SlotKind, String)> = Vec::new();
    for (i, path) in ref_paths.iter().enumerate() {
        slots.push((SlotKind::Source, path.clone()));
        if let Some(mask) = mask_paths.get(i).filter(|mask| !mask.is_empty()) {
            slots.push((SlotKind::Mask, mask.clone()));
        }
    }
    let aspect_label = aspect
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("1:1");
    let final_prompt = build_final_prompt(&prompt, &slots, aspect_label, idx, total_count);
    let image_paths: Vec<String> = slots.iter().map(|(_, path)| path.clone()).collect();

    match crate::codex::gen_server::generate_image_for_run(
        app,
        state,
        &final_prompt,
        &image_paths,
        cwd.as_deref().filter(|value| !value.is_empty()),
        model.as_deref().filter(|value| !value.is_empty()),
        effort.as_deref().filter(|value| !value.is_empty()),
        Some(run_id),
        // フェーズ表示はタイル1枚ごとに出すので、どの枠かを識別する idx を渡す
        // (workerStarted/Completed と同じ番号なのでフロント側で突き合わせられる)。
        Some(idx),
        "batch",
    )
    .await
    {
        Ok(src_png) => {
            if gen_queue::is_cancelled(run_id) {
                return Err(gen_queue::cancelled_error());
            }
            let stem = short_id();
            let dest = out_dir.join(format!("ig_b{idx:02}_{stem}.png"));
            if enforce_normalization(enforce_aspect, &slots) {
                let raw_dest = out_dir.join(format!("ig_b{idx:02}_{stem}_raw.png"));
                crate::images::normalize::normalize_or_salvage(
                    &src_png,
                    &dest,
                    &raw_dest,
                    aspect_label,
                )?;
            } else {
                std::fs::copy(&src_png, &dest).map_err(|error| {
                    format!(
                        "app-server 生成画像の出力コピー失敗 ({}): {error}",
                        src_png.display()
                    )
                })?;
            }
            return Ok(dest.to_string_lossy().into_owned());
        }
        Err(resident_error) => {
            if gen_queue::is_cancelled_error(&resident_error) {
                return Err(resident_error);
            }
            if crate::codex::gen_server::is_timeout_error(&resident_error)
                || crate::codex::gen_server::is_stale_server_error(&resident_error)
            {
                // この試行では二重生成を避けて失敗とし、同じ worker の次試行だけ
                // 旧 exec 経路に切り替える。900秒タイムアウトと無音接続の両方が対象。
                *resident_timed_out = true;
                return Err(resident_error);
            }
            if !allow_exec_fallback {
                // 「1操作 = 最大1生成」の呼び出し元。正直に失敗を返し、再実行は
                // ユーザーの明示操作に委ねる（黙って2回目を焼かない）。
                tracing::warn!(
                    target: "codex.batch_gen",
                    "worker {idx}: 常駐 app-server 経路に失敗しましたが max_attempts=1 のため codex exec へフォールバックしません: {resident_error}"
                );
                return Err(resident_error);
            }
            tracing::warn!(
                target: "codex.batch_gen",
                "worker {idx}: 常駐 app-server 経路に失敗したため codex exec へフォールバックします: {resident_error}"
            );
            let (codex_bin, codex_home_orig) = exec_fallback.map_err(|fallback_error| {
                format!(
                    "常駐 app-server 経路: {resident_error}; codex exec フォールバックを準備できません: {fallback_error}"
                )
            })?;
            return run_one_worker_exec_inner(
                app,
                codex_bin,
                codex_home_orig,
                out_dir,
                idx,
                prompt,
                cwd,
                ref_paths,
                mask_paths,
                model,
                effort,
                aspect,
                total_count,
                run_id,
                enforce_aspect,
            )
            .await
            .map_err(|exec_error| merge_fallback_error(&resident_error, exec_error));
        }
    }
}

/// 常駐 app-server が使えない場合の旧 `codex exec` 経路。
/// tmp CODEX_HOME・PNG 走査・PID guard を含む従来実装を温存する。
#[allow(clippy::too_many_arguments)]
async fn run_one_worker_exec_inner(
    app: &AppHandle,
    codex_bin: PathBuf,
    codex_home_orig: PathBuf,
    out_dir: &Path,
    idx: u32,
    prompt: String,
    cwd: Option<String>,
    ref_paths: Vec<String>,
    mask_paths: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
    aspect: Option<String>,
    total_count: u32,
    run_id: &str,
    enforce_aspect: bool,
    // Ok(成功画像パス) / Err(失敗理由)。画像が無い場合も Err に理由を載せる
    // (旧 Ok(None) は廃止。画像なし=失敗理由つき Err に統一)。
) -> Result<String, String> {
    if gen_queue::is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    // 1. mktemp -d で per-worker CODEX_HOME を作る
    let tmp = tempfile::Builder::new()
        .prefix(&format!("codex-batch-{idx:02}-"))
        .tempdir()
        .map_err(|e| format!("tempdir 作成失敗: {e}"))?;
    let tmp_home = tmp.path().to_path_buf();

    // 2. 認証・設定は元 HOME からミラーし、生成画像と会話履歴は分離する。
    mirror_codex_home(&codex_home_orig, &tmp_home)?;
    let tmp_gen = tmp_home.join("generated_images");

    // 3. ref と mask をペアで並べる ([source_i, mask_i?] の順)。codex exec は
    //    `-i` でファイルパスを attach するだけなので、prompt のテキストで
    //    「N 枚目はマスク」と明示する必要がある。空文字 mask は「なし」。
    let mut slots: Vec<(SlotKind, String)> = Vec::new();
    for (i, p) in ref_paths.iter().enumerate() {
        slots.push((SlotKind::Source, p.clone()));
        if let Some(m) = mask_paths.get(i).filter(|m| !m.is_empty()) {
            slots.push((SlotKind::Mask, m.clone()));
        }
    }

    let aspect_label = aspect.as_deref().filter(|a| !a.is_empty()).unwrap_or("1:1");
    let final_prompt = build_final_prompt(&prompt, &slots, aspect_label, idx, total_count);

    // 4. codex exec を spawn (per-worker CODEX_HOME)
    let mut cmd = Command::new(&codex_bin);
    // --full-auto(=workspace-write sandbox)は Windows で codex-windows-sandbox-setup.exe
    // を要求して死ぬため、サンドボックス無効の bypass を使う(2026-06-09 Windows 修正)。
    cmd.args([
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
    ]);
    if let Some(c) = cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("-C").arg(c);
    }
    if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("-c").arg(format!("model={m}"));
    }
    if let Some(e) = effort.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("-c").arg(format!("model_reasoning_effort={e}"));
    }
    for (_, p) in &slots {
        cmd.arg("-i").arg(p);
    }
    cmd.arg("-"); // prompt is read from stdin
    cmd.env("CODEX_HOME", &tmp_home);
    // GUI 起動された .app は PATH が骨抜きで、codex (Node.js shebang) が
    // `env: node: No such file` で死ぬ。login shell から拾った PATH を渡す。
    cmd.env("PATH", enriched_path());
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // タイムアウトで future を drop したとき、子プロセス(codex + node)も道連れに
    // kill する。これが無いとタイムアウトした codex が生き残り、並列+再試行で
    // 累積して裏で CPU を焼く (2026-06-07 独立レビュー指摘)。
    cmd.kill_on_drop(true);
    crate::codex::process::no_window_flag(&mut cmd);

    if gen_queue::is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    // RAII: 以降どの早期 return / `?` で抜けても Drop が債務返済を通す。
    let gen_permit = gen_queue::GenPermit::acquire(&GLOBAL_GEN_SEMAPHORE).await?;
    // キュー待機中にキャンセルされたworkerは、codex execを起動しない。
    if gen_queue::is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "codex exec の PID を取得できません".to_string())?;
    let worker_registration = crate::commands::worker_registry::WorkerPidGuard::register(
        app,
        pid,
        "batch",
        Some(run_id),
    )?;
    if gen_queue::is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(final_prompt.as_bytes())
            .await
            .map_err(|e| format!("stdin 書き込み失敗: {e}"))?;
        // drop closes stdin so codex can finish reading.
    }

    // codex exec が image_gen を呼ぶ前に長考して無限に待つのを防ぐタイムアウト。
    // gpt-image-2 は高品質1枚で中央値195秒・p95で280秒かかる(2026-06 実測/業界報告)。
    // 旧 240 秒は p95 に対して短く、完成間際の遅い生成を打ち切って失敗にしていた
    // (α版はタイムアウト無限待機だったので成功していた)。マルチアングル/storyboard と
    // 同じ 900 秒に揃え、混雑時の遅延を吸収する(2026-06-09 ServerError多発の対策)。
    const WORKER_TIMEOUT: Duration = Duration::from_secs(900);
    let output = match tokio::time::timeout(WORKER_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(_)) if gen_queue::is_cancelled(run_id) => {
            return Err(gen_queue::cancelled_error());
        }
        Ok(Err(e)) => return Err(format!("codex exec 待機失敗: {e}")),
        Err(_) if gen_queue::is_cancelled(run_id) => {
            return Err(gen_queue::cancelled_error());
        }
        Err(_elapsed) => {
            return Err(format!(
                "画像生成がタイムアウトしました（{}秒）。プロンプトを短くするか、時間をおいて再試行してください。",
                WORKER_TIMEOUT.as_secs()
            ));
        }
    };
    drop(worker_registration);
    // 429降格中は permit をセマフォへ戻さず握り潰す(実効上限を下げる)。
    drop(gen_permit);
    if gen_queue::is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }

    // 終了コードが非ゼロでも、画像が生成されていれば成功扱いにする
    // (codex が最後に NG 自己申告や非ゼロ終了しても ig_*.png が残っていれば
    //  その画像は有効。先に画像走査してから終了コードを理由に使う)。
    let exited_ok = output.status.success();
    let stderr_tail = if exited_ok {
        String::new()
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("(stderr 出力なし)")
            .to_string()
    };

    // 5. tmp_home/generated_images/<session>/ig_*.png を 1 枚拾う
    let mut found: Option<PathBuf> = None;
    if let Ok(sessions) = std::fs::read_dir(&tmp_gen) {
        let mut newest = (0u128, PathBuf::new());
        for sess in sessions.flatten() {
            let sess_path = sess.path();
            if !sess_path.is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(&sess_path) {
                for f in files.flatten() {
                    let p = f.path();
                    // 保存名は codex 世代・経路で変わる (0.128系=ig_*、0.144直接
                    // 呼び出し=call_*、0.144実行セル経由=exec-*。2026-07-17実測)。
                    // 内部名に依存すると新経路のたびに壊れるため、ワーカー専用
                    // generated_images 配下の PNG なら名前を問わず回収する。
                    let is_png = p.is_file()
                        && p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("png"))
                            .unwrap_or(false);
                    if !is_png {
                        continue;
                    }
                    let mtime = std::fs::metadata(&p)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    if mtime >= newest.0 {
                        newest = (mtime, p);
                    }
                }
            }
        }
        if !newest.1.as_os_str().is_empty() {
            found = Some(newest.1);
        }
    }

    let src_png = match found {
        Some(p) => p,
        None => {
            // 画像が1枚も無い = 失敗。理由を可能な限り具体的にする。
            // 非ゼロ終了なら stderr 末尾を、ゼロ終了なら image_gen 未呼び出しを示す。
            if !exited_ok {
                return Err(format!(
                    "codex exec が異常終了 (code={:?}): {}",
                    output.status.code(),
                    stderr_tail
                ));
            }
            return Err(
                "生成画像を回収できませんでした（画像ツールの出力ファイルが見つかりません）。\
                 再試行しても続く場合は開発ログの確認が必要です。"
                    .to_string(),
            );
        }
    };

    // 6. configured storage root / batch-<id> / ig_<idx>_<short>.png にコピー
    let stem = short_id();
    let dest = out_dir.join(format!("ig_b{idx:02}_{stem}.png"));
    if enforce_normalization(enforce_aspect, &slots) {
        let raw_dest = out_dir.join(format!("ig_b{idx:02}_{stem}_raw.png"));
        crate::images::normalize::normalize_or_salvage(&src_png, &dest, &raw_dest, aspect_label)?;
    } else {
        std::fs::copy(&src_png, &dest).map_err(|e| format!("出力コピー失敗: {e}"))?;
    }

    Ok(dest.to_string_lossy().into_owned())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SlotKind {
    Source,
    Mask,
}

/// 回収点で規格寸法への正規化を実行するか。
///
/// フロントのオプトインに加えて、マスクが1枚でもあれば Rust 側でも機械的に
/// 除外する（二重の柵）。マスク編集は「出力＝元画像と同じ解像度」が正であり
/// （`build_final_prompt` の inpainting テンプレ）、固定表に嵌めるのは誤り。
fn enforce_normalization(enforce_aspect: bool, slots: &[(SlotKind, String)]) -> bool {
    enforce_aspect && !slots.iter().any(|(kind, _)| *kind == SlotKind::Mask)
}

/// codex exec に流す prompt を組み立てる。マスクが含まれるときは
/// inpainting 用のテンプレ、含まれないときは新規生成用テンプレ。
fn build_final_prompt(
    prompt: &str,
    slots: &[(SlotKind, String)],
    aspect_label: &str,
    frame_index: u32,
    total_count: u32,
) -> String {
    let has_mask = slots.iter().any(|(k, _)| *k == SlotKind::Mask);
    let is_multi_angle = prompt.contains("Mode: multi-angle.");
    let camera_angle = multi_angle_label(frame_index);
    if has_mask {
        let mut lines: Vec<String> = Vec::new();
        for (i, (kind, _)) in slots.iter().enumerate() {
            let idx = i + 1;
            let line = match kind {
                SlotKind::Source => {
                    format!("{idx} 枚目: 編集対象のオリジナル画像")
                }
                SlotKind::Mask => {
                    format!(
                        "{idx} 枚目: 直前の画像のマスク (白い領域だけが編集対象、それ以外は不変)"
                    )
                }
            };
            lines.push(line);
        }
        let instruction = if prompt.is_empty() {
            "塗りつぶされた領域を自然に補完してください。"
        } else {
            prompt
        };
        format!(
            "次の指示に従って画像を 1 枚だけ生成してください。出力先は $CODEX_HOME/generated_images/<session>/ig_*.png に自動保存されるため、保存先指定や変換は不要です。\n\n## この画像の役割\n- 全 {total_count} 枚の動画用連番フレームのうち {frame_index} 枚目\n- 前後フレームと同一の被写体・衣装・空間・色調を保ちながら、少しだけ構図や動きを進める\n\n## 入力構成\n{lines}\n\n## 手順\n1. マスクの白い領域だけを下記指示に従って編集し、それ以外の領域はオリジナルから 1 ピクセルも変更しないこと\n2. 出力は元画像と同じ解像度・アスペクト比 ({aspect_label})\n3. 画像生成ツールを 1 回だけ呼ぶ\n\n## 指示\n{instruction}\n\n## 制約\n- 失敗したら 1 回だけリトライしてよい\n- 最終メッセージは `OK` か `NG <理由>` の 1 行のみ",
            lines = lines.join("\n"),
        )
    } else {
        let role_lines = if is_multi_angle {
            format!(
                "- 全 {total_count} 枚のマルチアングル検討のうち {frame_index} 枚目\n- このフレームの担当アングル: {camera_angle}\n- 時間、ポーズ、位置関係、環境、衣装、商品形状、照明、色調は固定する\n- 変えるのはカメラ角度、カメラ高、焦点距離、フレーミング、視点だけ\n- 1 枚の独立画像として生成し、グリッド、コラージュ、接触シート、複数パネルにはしない"
            )
        } else {
            format!(
                "- 全 {total_count} 枚の制作カットのうち {frame_index} 枚目\n- これは単なる参照画像の複製ではなく、ユーザー指示を満たすための完成カット\n- 参照画像は被写体・雰囲気・ルックのアンカーとして使う。ユーザー指示の目的、用途、構図、演出を最優先する\n- 広告画像、キービジュアル、サムネイル、商品ビジュアル、LP素材、SNSクリエイティブを求められた場合は、商用利用しやすい構図、余白、視線誘導、完成感を明確に作る\n- 同一バッチ内では被写体の主要特徴、色調、レンズ感を保ちながら、各フレームの役割や構図は指示に合わせて十分に変える\n- {frame_index} 枚目として、視点、ポーズ、背景処理、余白、光の入り方、広告らしい見せ方を調整する"
            )
        };
        format!(
            "次の指示に従って画像を 1 枚だけ生成してください。出力先は $CODEX_HOME/generated_images/<session>/ig_*.png に自動保存されるため、保存先指定や変換は不要です。\n\n## 優先順位\n1. ユーザー指示の目的と用途を最優先する\n2. 参照画像は被写体、雰囲気、質感、色、レンズ感のアンカーとして使う\n3. 一貫性は大事だが、指示内容を弱めるほど参照画像に寄せすぎない\n\n## この画像の役割\n{role_lines}\n\n## 手順\n1. 画像生成ツールを 1 回呼び出し、下記プロンプトの内容を {aspect_label} aspect ratio / quality=high で生成する。プロンプト末尾に必ず \"{aspect_label} aspect ratio, high quality\" を含めること。\n2. 他のファイルは作らない。magick 等の変換も不要。\n\n## プロンプト\n{prompt}\n\n## 制約\n- 画面内テキスト、ロゴ、透かしは、ユーザーが明示した場合以外は入れない\n- グリッド、コラージュ、接触シート、分割画面、複数パネルは禁止\n- 参照画像をそのままコピーしただけの近似画像は禁止。ユーザー指示に対する明確な変化を入れる\n- 失敗したら 1 回だけリトライしてよい\n- 最終メッセージは `OK` か `NG <理由>` の 1 行のみ。"
        )
    }
}

fn multi_angle_label(frame_index: u32) -> &'static str {
    const ANGLES: [&str; 9] = [
        "extreme close-up",
        "medium shot",
        "over-the-shoulder",
        "wide shot",
        "high-angle top-down",
        "low-angle",
        "profile",
        "three-quarter rear view",
        "full back view",
    ];
    let idx = frame_index.saturating_sub(1) as usize % ANGLES.len();
    ANGLES[idx]
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 16 hex chars — plenty of entropy for a per-batch / per-file id.
    format!("{:016x}", nanos)
}

/// `codex-home-gen` のミラー入口。Unix の常駐経路と Windows の exec 経路で共有する。
pub(crate) fn mirror_resident_codex_home(
    codex_home_orig: &Path,
    worker_home: &Path,
) -> Result<(), String> {
    mirror_codex_home(codex_home_orig, worker_home)
}

/// 旧 exec 経路の一時 worker HOME へ認証・設定をミラーする。
/// Unix では symlink、Windows では従来どおり一時ディレクトリへコピーし、監視対象の
/// `generated_images` と会話履歴の `sessions` だけは必ず独立ディレクトリにする。
fn mirror_codex_home(codex_home_orig: &Path, worker_home: &Path) -> Result<(), String> {
    std::fs::create_dir_all(worker_home).map_err(|e| format!("worker CODEX_HOME 作成失敗: {e}"))?;

    if codex_home_orig.exists() {
        let entries = std::fs::read_dir(codex_home_orig)
            .map_err(|e| format!("CODEX_HOME 読み込み失敗: {e}"))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == "generated_images" || name == "sessions" {
                continue;
            }
            let src = entry.path();
            let dst = worker_home.join(&name);
            #[cfg(unix)]
            {
                if let Err(error) = std::os::unix::fs::symlink(&src, &dst) {
                    if error.kind() != std::io::ErrorKind::AlreadyExists {
                        tracing::warn!(
                            target: "codex.batch_gen",
                            "symlink {src:?} -> {dst:?} failed: {error}"
                        );
                    }
                }
            }
            #[cfg(windows)]
            {
                if let Err(err) = copy_recursive(&src, &dst) {
                    tracing::warn!(
                        target: "codex.batch_gen",
                        "copy {src:?} -> {dst:?} failed: {err}"
                    );
                }
            }
        }
    }

    for local_dir in ["generated_images", "sessions"] {
        std::fs::create_dir_all(worker_home.join(local_dir))
            .map_err(|e| format!("worker {local_dir} 作成失敗: {e}"))?;
    }
    Ok(())
}

/// Windows で `~/.codex/` 配下を per-worker tmp_home に複製するヘルパー。
/// シンボリックリンクが使えない環境向け。ファイルは fs::copy、
/// ディレクトリは再帰コピー。
///
/// 失敗を error にすると 1 ファイルでも欠けたときバッチ全体が落ちるので、
/// 個別の Err はログに残しつつ Ok を返す方が頑健。とはいえ呼び出し側
/// で握りつぶしているので、ここでは普通に Result を返しておく。
#[cfg(windows)]
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let metadata = std::fs::metadata(src)?;
    if metadata.is_file() {
        // 同名ファイルが既にあれば上書き (空 tmpdir のはずだが安全側)
        std::fs::copy(src, dst)?;
        return Ok(());
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let entry_name = entry.file_name();
            let child_src = entry.path();
            let child_dst = dst.join(&entry_name);
            // ネストしたディレクトリも再帰でカバー
            if let Err(err) = copy_recursive(&child_src, &child_dst) {
                tracing::warn!(
                    target: "codex.batch_gen",
                    "copy_recursive child failed: {child_src:?} -> {child_dst:?}: {err}"
                );
            }
        }
        return Ok(());
    }
    Ok(())
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{next_attempt_path, AttemptPath};

    #[test]
    fn resident_timeout_switches_only_the_next_attempt_to_exec() {
        assert_eq!(next_attempt_path(true), AttemptPath::Exec);
        assert_eq!(next_attempt_path(false), AttemptPath::Resident);
    }
}

#[cfg(test)]
mod normalize_gate_tests {
    use super::{
        enforce_normalization, merge_fallback_error, should_abort_attempts, BatchGenArgs, SlotKind,
    };
    use crate::images::normalize::SIZE_MISMATCH_PREFIX;

    fn slot(kind: SlotKind) -> (SlotKind, String) {
        (kind, "/tmp/x.png".to_string())
    }

    /// DoD-7: リトライ中断の真偽表。一時故障は従来どおりリトライを続ける。
    #[test]
    fn abort_only_on_cancel_or_size_mismatch() {
        assert!(should_abort_attempts(&format!(
            "{SIZE_MISMATCH_PREFIX}生成画像（実測 1024×1536）が…"
        )));
        assert!(should_abort_attempts(
            &crate::commands::gen_queue::cancelled_error()
        ));
        assert!(!should_abort_attempts("ServerError: 500"));
        assert!(!should_abort_attempts("タイムアウトしました"));
    }

    /// A-1: exec フォールバック経由のサイズ不一致が、包まれずに 1 回で停止する。
    ///
    /// 常駐経路が落ちて exec へ回った先でサイズ不一致になったとき、両方の理由を
    /// 連結すると先頭が「常駐 app-server 経路:」になり接頭辞判定をすり抜ける。
    /// すると確定的失敗なのに最大 3 回まで再生成され、生成枠を燃やす。
    #[test]
    fn size_mismatch_through_exec_fallback_still_aborts_attempts() {
        let resident = "ServerError: 500";
        let size_mismatch = format!("{SIZE_MISMATCH_PREFIX}生成画像（実測 1024×1536）が…");

        let merged = merge_fallback_error(resident, size_mismatch.clone());

        assert_eq!(merged, size_mismatch, "サイズ不一致は包まず素通しする");
        assert!(
            should_abort_attempts(&merged),
            "リトライループが 1 回で止まる: {merged}"
        );

        // 中止も同様に素通しする（従来の挙動を維持していること）。
        let cancelled = crate::commands::gen_queue::cancelled_error();
        let merged_cancel = merge_fallback_error(resident, cancelled.clone());
        assert_eq!(merged_cancel, cancelled);
        assert!(should_abort_attempts(&merged_cancel));

        // 一時故障は従来どおり両方の理由を並べ、リトライを続ける。
        let merged_transient = merge_fallback_error(resident, "タイムアウトしました".to_string());
        assert!(merged_transient.contains(resident), "真因を追える");
        assert!(merged_transient.contains("タイムアウトしました"));
        assert!(
            !should_abort_attempts(&merged_transient),
            "リトライは継続する"
        );
    }

    /// マスクが1枚でもあれば、フロントが enforce を立てていても正規化しない。
    #[test]
    fn mask_slots_disable_normalization_even_when_opted_in() {
        let no_mask = vec![slot(SlotKind::Source), slot(SlotKind::Source)];
        let with_mask = vec![slot(SlotKind::Source), slot(SlotKind::Mask)];

        assert!(enforce_normalization(true, &no_mask));
        assert!(enforce_normalization(true, &[]));
        assert!(!enforce_normalization(true, &with_mask), "マスク混在は除外");
        assert!(!enforce_normalization(false, &no_mask), "既定は OFF");
        assert!(!enforce_normalization(false, &with_mask));
    }

    /// r3 追補1: `maxAttempts:1` を渡した呼び出し元では 2 回目の試行が起きない。
    ///
    /// リトライは `for attempt in 1..=max_attempts` の1本だけなので、上限が 1 に
    /// なった時点で「2周目が存在しない」＝自動リトライが構造的に発生しない。
    /// ここではその上限計算（clamp）と、上限が生むループ周回数を突き合わせる。
    #[test]
    fn max_attempts_one_prevents_a_second_generation_attempt() {
        use super::{resolve_max_attempts, DEFAULT_MAX_ATTEMPTS};

        // 実際のループと同じ形で周回数を数える（本体は inner 呼び出しだけをループする）。
        fn attempts_executed(max_attempts: u32) -> u32 {
            let max_attempts = max_attempts.max(1);
            let mut ran = 0;
            for _attempt in 1..=max_attempts {
                ran += 1;
                // 失敗し続ける worker を模す（result.is_ok() の break を通らない）。
            }
            ran
        }

        // ブロックアウト生成の2呼び出しが渡す値。1回で打ち止め。
        assert_eq!(resolve_max_attempts(Some(1)), 1);
        assert_eq!(
            attempts_executed(resolve_max_attempts(Some(1))),
            1,
            "maxAttempts:1 では失敗しても2回目の生成試行が起きない"
        );

        // 未指定（既存呼び出し元）は従来どおり最大3回。挙動不変。
        assert_eq!(resolve_max_attempts(None), DEFAULT_MAX_ATTEMPTS);
        assert_eq!(attempts_executed(resolve_max_attempts(None)), 3);

        // 範囲外は clamp する: 0 は「1回も試さない」を防ぎ、過大値は枠を燃やさない。
        assert_eq!(resolve_max_attempts(Some(0)), 1);
        assert_eq!(resolve_max_attempts(Some(99)), DEFAULT_MAX_ATTEMPTS);
    }

    /// r3 追補1（B-1）: `maxAttempts:1` では常駐失敗時に exec 経路へ落ちない。
    ///
    /// ループ上限が1でも、`run_one_worker_inner` の常駐失敗ハンドラが同じ周回の中で
    /// `run_one_worker_exec_inner` を呼ぶため、上限だけでは生成が2回発火しうる。
    /// 本番の分岐条件そのもの（`allows_exec_fallback`）を検査して、その経路が
    /// 塞がっていることを確かめる。
    #[test]
    fn max_attempts_one_disables_same_round_exec_fallback() {
        use super::{allows_exec_fallback, resolve_max_attempts, DEFAULT_MAX_ATTEMPTS};

        // 1操作=最大1生成の呼び出し元。常駐が失敗しても exec を焼かない。
        assert!(
            !allows_exec_fallback(resolve_max_attempts(Some(1))),
            "maxAttempts:1 では同一周回の exec フォールバックが発動しない"
        );
        // clamp 経由で 1 になる値も同じ扱い。
        assert!(!allows_exec_fallback(resolve_max_attempts(Some(0))));

        // 既存呼び出し元（未指定=3・明示2）は従来どおりフォールバックする。挙動不変。
        assert!(allows_exec_fallback(resolve_max_attempts(None)));
        assert!(allows_exec_fallback(DEFAULT_MAX_ATTEMPTS));
        assert!(allows_exec_fallback(resolve_max_attempts(Some(2))));

        // 生成経路の実呼び出し回数: 常駐1回のみ（フォールバック分が加算されない）。
        fn generation_calls(max_attempts: u32) -> u32 {
            let max_attempts = max_attempts.max(1);
            let allow = allows_exec_fallback(max_attempts);
            let mut calls = 0;
            for _attempt in 1..=max_attempts {
                calls += 1; // 常駐経路の呼び出し（失敗すると仮定）
                if allow {
                    calls += 1; // 同一周回の exec フォールバック
                }
            }
            calls
        }
        assert_eq!(
            generation_calls(resolve_max_attempts(Some(1))),
            1,
            "1操作あたりの生成 API 実呼び出しは最大1回"
        );
        assert_eq!(generation_calls(resolve_max_attempts(None)), 6);
    }

    /// serde 後方互換: `maxAttempts` 未指定は None（=既定3回）になり挙動が変わらない。
    #[test]
    fn max_attempts_defaults_to_none_for_existing_callers() {
        let legacy: BatchGenArgs = serde_json::from_str(r#"{"prompt":"p","count":1}"#).unwrap();
        assert_eq!(legacy.max_attempts, None);

        let capped: BatchGenArgs =
            serde_json::from_str(r#"{"prompt":"p","count":1,"maxAttempts":1}"#).unwrap();
        assert_eq!(capped.max_attempts, Some(1));
    }

    /// DoD-8: serde 後方互換。既存呼び出し元（comic・edit）は enforceAspect を
    /// 渡さないため false になり、挙動が変わらない。
    #[test]
    fn enforce_aspect_defaults_to_false_for_existing_callers() {
        let legacy: BatchGenArgs =
            serde_json::from_str(r#"{"prompt":"p","count":1,"aspect":"3:4"}"#).unwrap();
        assert!(!legacy.enforce_aspect);

        let opted_in: BatchGenArgs =
            serde_json::from_str(r#"{"prompt":"p","count":1,"enforceAspect":true}"#).unwrap();
        assert!(opted_in.enforce_aspect);

        let explicit_off: BatchGenArgs =
            serde_json::from_str(r#"{"prompt":"p","count":1,"enforceAspect":false}"#).unwrap();
        assert!(!explicit_off.enforce_aspect);
    }
}
