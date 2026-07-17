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
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_IMAGE_BATCH;
use crate::state::AppState;

type ExecFallback = Result<(PathBuf, PathBuf), String>;

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
    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(args.cwd.as_deref());
    let out_dir = resolve_output_dir(&storage_settings, project_name.as_deref(), &batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        BatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.count,
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

    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        BatchEvent::Completed {
            batch_id: batch_id.clone(),
            generated_paths: generated_paths.clone(),
            failed_count,
            errors: errors.clone(),
        },
    );

    Ok(BatchGenResult {
        batch_id,
        generated_paths,
        failed_count,
        errors,
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
    // Ok(成功画像パス) / Err(失敗理由)。理由を呼び出し元に伝えることで、
    // フロントが真因を表示できる (握りつぶし解消)。
) -> Result<String, String> {
    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        BatchEvent::WorkerStarted {
            batch_id: batch_id.clone(),
            idx,
        },
    );

    // マルチアングル/storyboard と同じく、失敗したら最大 MAX_ATTEMPTS 回まで自動で
    // やり直す。gpt-image-2 の ServerError や image_gen 呼び忘れは一時的なことが多く、
    // 2 回目以降で成功することがある(2026-06-09 通常生成にもリトライを横展開)。
    // 注意: WorkerStarted/Completed/Failed イベントは1回だけ発火させたいので、
    // リトライは inner 呼び出しだけをループする。
    const MAX_ATTEMPTS: u32 = 3;
    let mut result: Result<String, String> = Err("未実行".to_string());
    for attempt in 1..=MAX_ATTEMPTS {
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
        )
        .await;
        if result.is_ok() {
            break;
        }
        if let Err(e) = &result {
            tracing::warn!(
                target: "codex.batch_gen",
                "worker {idx} attempt {attempt}/{MAX_ATTEMPTS} failed: {e}"
            );
        }
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

    // inner は Result<成功パス, 失敗理由> を返す。失敗理由は WorkerFailed
    // イベントと戻り値の Err の両方に同じ文言を載せ、フロントがどちらの経路でも
    // 真因を拾えるようにする。外部API障害(ServerError/5xx/401等)なら非エンジニア
    // 向けの文言に整形する(humanize)。
    let normalized: Result<String, String> =
        result.map_err(|e| crate::codex::process::humanize_generation_failure(&e));

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
) -> Result<String, String> {
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

    match crate::codex::gen_server::generate_image(
        app,
        state,
        &final_prompt,
        &image_paths,
        cwd.as_deref().filter(|value| !value.is_empty()),
        model.as_deref().filter(|value| !value.is_empty()),
        effort.as_deref().filter(|value| !value.is_empty()),
    )
    .await
    {
        Ok(src_png) => {
            let dest = out_dir.join(format!("ig_b{idx:02}_{}.png", short_id()));
            std::fs::copy(&src_png, &dest).map_err(|error| {
                format!(
                    "app-server 生成画像の出力コピー失敗 ({}): {error}",
                    src_png.display()
                )
            })?;
            return Ok(dest.to_string_lossy().into_owned());
        }
        Err(resident_error) => {
            if crate::codex::gen_server::is_timeout_error(&resident_error) {
                // タイムアウトは生成自体が遅い/詰まっているサイン。旧経路で作り直すと
                // 1試行が最悪 900秒x2 に伸びるため、旧実装同様この試行の失敗として返す。
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
            )
            .await
            .map_err(|exec_error| {
                format!(
                    "常駐 app-server 経路: {resident_error}; codex exec フォールバック: {exec_error}"
                )
            });
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
    // Ok(成功画像パス) / Err(失敗理由)。画像が無い場合も Err に理由を載せる
    // (旧 Ok(None) は廃止。画像なし=失敗理由つき Err に統一)。
) -> Result<String, String> {
    // 1. mktemp -d で per-worker CODEX_HOME を作る
    let tmp = tempfile::Builder::new()
        .prefix(&format!("codex-batch-{idx:02}-"))
        .tempdir()
        .map_err(|e| format!("tempdir 作成失敗: {e}"))?;
    let tmp_home = tmp.path().to_path_buf();

    // 2. ~/.codex/* を tmp_home に複製
    //    (config.toml は最小構成で新規生成、generated_images は独立 dir)
    //
    // Unix: シンボリックリンクで参照だけ通す (高速、無料)
    // Windows: シンボリックリンクは管理者権限必須。代わりに
    //          ファイル/ディレクトリを再帰コピーする。
    //          これがないと tmp_home に auth.json / cache/ などが無い状態で
    //          codex exec が起動し、
    //          認証なしエラーで即落ちする (Windows で生成ボタン押下
    //          後の不発の真因)。
    if codex_home_orig.exists() {
        let entries = std::fs::read_dir(&codex_home_orig)
            .map_err(|e| format!("CODEX_HOME 読み込み失敗: {e}"))?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == "generated_images" {
                continue;
            }
            let src = entry.path();
            let dst = tmp_home.join(&name);
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(&src, &dst);
            }
            #[cfg(windows)]
            {
                // Windows ではシンボリックリンクが原則使えないので、
                // ファイルは fs::copy、ディレクトリは再帰コピーで複製する。
                if let Err(err) = copy_recursive(&src, &dst) {
                    tracing::warn!(
                        target: "codex.batch_gen",
                        "copy {src:?} -> {dst:?} failed: {err}"
                    );
                }
            }
        }
    }

    let tmp_gen = tmp_home.join("generated_images");
    std::fs::create_dir_all(&tmp_gen)
        .map_err(|e| format!("worker generated_images 作成失敗: {e}"))?;

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

    let gen_permit = GLOBAL_GEN_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| "画像生成キューが閉じられました".to_string())?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("codex exec の spawn に失敗: {e}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "codex exec の PID を取得できません".to_string())?;
    let worker_registration =
        crate::commands::worker_registry::WorkerPidGuard::register(app, pid, "batch")?;
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
        Ok(Err(e)) => return Err(format!("codex exec 待機失敗: {e}")),
        Err(_elapsed) => {
            return Err(format!(
                "画像生成がタイムアウトしました（{}秒）。プロンプトを短くするか、時間をおいて再試行してください。",
                WORKER_TIMEOUT.as_secs()
            ));
        }
    };
    drop(worker_registration);
    drop(gen_permit);

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
    let dest = out_dir.join(format!("ig_b{idx:02}_{}.png", short_id()));
    std::fs::copy(&src_png, &dest).map_err(|e| format!("出力コピー失敗: {e}"))?;

    Ok(dest.to_string_lossy().into_owned())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SlotKind {
    Source,
    Mask,
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
