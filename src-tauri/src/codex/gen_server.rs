//! 通常画像生成専用の常駐 Codex app-server。
//!
//! チャット用 app-server とはプロセスも RPC 購読も分離し、通知は Rust 内だけで
//! 消費する。初回生成時に遅延起動し、RPC/子プロセスの死活が失われていれば次回
//! 利用時に自動で起動し直す。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{broadcast, watch};
use tokio::time::{interval, timeout, MissedTickBehavior};

use crate::codex::process::{
    enriched_path, no_window_flag, resolve_codex_binary, AppServerProcess, StderrBuffer,
};
use crate::codex::rpc::{handshake, RpcClient, RpcNotification};
use crate::commands::gen_metrics;
use crate::commands::gen_queue::{self, GLOBAL_GEN_SEMAPHORE};
use crate::commands::worker_registry::{WorkerPidGuard, RESIDENT_GEN_SERVER_WORKER_KIND};
use crate::state::AppState;

pub(crate) const GENERATION_TIMEOUT: Duration = Duration::from_secs(900);
// セマフォ取得済みの turn はすぐ開始されるため、健全な接続なら数秒〜数十秒で
// 最初の通知が届く。900秒の生成全体タイムアウトとは別に、接続死による「無音」を
// 早く検出するための上限。
const FIRST_SIGNAL_TIMEOUT: Duration = Duration::from_secs(120);
const WORKER_REGISTRY_FILE: &str = "worker-pids.json";
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const STALE_SERVER_ERROR: &str =
    "生成サーバーが応答しません（接続が古くなっている可能性があります）。別の経路で再試行します。";

/// 画像1枚がいまどの段階にいるか (設計書 S1)。
///
/// 「順番待ち → AI準備中 → 描画中 → 完成」の4段。表示文言はフロント側が持ち、
/// ここは**状態の名前だけ**を運ぶ (Rust に日本語文言を置くと、UI 文言の変更が
/// バックエンド改修になる)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GenPhase {
    /// ① セマフォの空き待ち。まだ1バイトも送っていない。
    Queued,
    /// ② turn/start 発行済み。LLM が構図を考えている区間。
    Thinking,
    /// ③ `item/started`(imageGeneration) を受信。実際に絵を描き始めた。
    Drawing,
    /// ④ 画像の保存パスを受け取った。
    Done,
}

impl GenPhase {
    /// フロントの payload に載る値。TS 側 `GenPhaseName` と1対1で対応する。
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Thinking => "thinking",
            Self::Drawing => "drawing",
            Self::Done => "done",
        }
    }
}

/// 1枚ぶんのフェーズ通知の宛先。run_id が無い経路 (単発生成) では
/// 何も emit しない — 宛先の無いイベントを投げても受け手が結び付けられないため。
#[derive(Clone)]
pub(crate) struct GenPhaseReporter {
    app: AppHandle,
    run_id: Option<String>,
    image_index: Option<u32>,
}

impl GenPhaseReporter {
    pub(crate) fn new(app: &AppHandle, run_id: Option<&str>, image_index: Option<u32>) -> Self {
        Self {
            app: app.clone(),
            run_id: run_id.map(str::to_owned),
            image_index,
        }
    }

    /// フェーズ遷移を1件送る。**送信失敗は生成を失敗させない** (計測ログと同じ扱いで、
    /// 演出のための通知が生成本体を壊してはならない)。
    pub(crate) fn emit(&self, phase: GenPhase) {
        self.emit_with_position(phase, None);
    }

    /// `queued` のときだけ「あと何枚待ちか」を添える。
    pub(crate) fn emit_with_position(&self, phase: GenPhase, position: Option<u32>) {
        let Some(run_id) = self.run_id.as_deref() else {
            return;
        };
        let mut payload = Map::new();
        payload.insert("runId".into(), Value::String(run_id.to_string()));
        if let Some(index) = self.image_index {
            payload.insert("imageIndex".into(), Value::Number(index.into()));
        }
        payload.insert("phase".into(), Value::String(phase.as_str().to_string()));
        if let Some(position) = position {
            payload.insert("position".into(), Value::Number(position.into()));
        }
        if let Err(error) = self
            .app
            .emit(crate::events::EVENT_GEN_PHASE, Value::Object(payload))
        {
            tracing::warn!(
                target: "codex.gen_server",
                "生成フェーズ通知を送れませんでした (生成には影響しません): {error}"
            );
        }
    }
}

/// AppState に 1 本だけ保持する生成専用プロセス。
pub(crate) struct GenServerProcess {
    client: RpcClient,
    child: Child,
    // 生存中は PID 台帳に残し、正常終了時は Drop で台帳から外す。
    _registration: WorkerPidGuard,
    /// このプロセスで開始した生成 turn 数。app-server には thread を閉じる
    /// API が無く、画像1枚ごとの thread がプロセス内に蓄積するため、
    /// 一定数でプロセスごと入れ替えてメモリ肥大を防ぐ(2026-07-17 レビュー指摘)。
    turns_started: u64,
    /// 実行中の turn 数。プロセス交代は 0 のときだけ行う。
    active_turns: Arc<AtomicU64>,
    /// interrupt の完了を確認できず、次のアイドル時交代が必要な状態。
    poisoned: Arc<AtomicBool>,
    /// stop_server が子プロセスの終了を実際に確認したときだけ true になる。
    process_stopped: watch::Sender<bool>,
}

struct GenServerLease {
    client: RpcClient,
    poisoned: Arc<AtomicBool>,
    process_stopped: watch::Receiver<bool>,
    _active_turn: ActiveTurnGuard,
}

struct WaitForSavedPathError {
    message: String,
    hold_permit: bool,
}

impl WaitForSavedPathError {
    fn release(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hold_permit: false,
        }
    }

    fn hold(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hold_permit: true,
        }
    }
}

/// generate_image がどの終了経路を通っても実行中数を戻すガード。
struct ActiveTurnGuard {
    active_turns: Arc<AtomicU64>,
}

impl Drop for ActiveTurnGuard {
    fn drop(&mut self) {
        let previous = self.active_turns.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "active turn counter underflow");
    }
}

/// このターン数を超えたら次の ensure_client でプロセスを入れ替える。
const MAX_TURNS_PER_SERVER: u64 = 60;

/// 1 turn で画像を生成し、app-server が通知した保存元パスを返す。
///
/// セマフォは thread/start やプロセス起動中には持たず、turn/start から
/// imageGeneration 完了までの間だけ保持する。
#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
pub(crate) async fn generate_image(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    feature: &'static str,
) -> Result<PathBuf, String> {
    generate_image_for_run(
        app,
        state,
        prompt,
        image_paths,
        cwd,
        model,
        effort,
        None,
        None,
        feature,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
pub(crate) async fn generate_image_for_run(
    _app: &AppHandle,
    _state: &AppState,
    _prompt: &str,
    _image_paths: &[String],
    _cwd: Option<&str>,
    _model: Option<&str>,
    _effort: Option<&str>,
    _run_id: Option<&str>,
    _image_index: Option<u32>,
    _feature: &'static str,
) -> Result<PathBuf, String> {
    Err("resident path disabled on windows".to_string())
}

/// Windows は常駐経路が無効なので、フックを呼ばずそのまま失敗を返す。
/// 呼び出し側は exec フォールバックへ落ち、そちらの permit でフックが発火する。
#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
pub(crate) async fn generate_image_for_run_with_slot_hook(
    _app: &AppHandle,
    _state: &AppState,
    _prompt: &str,
    _image_paths: &[String],
    _cwd: Option<&str>,
    _model: Option<&str>,
    _effort: Option<&str>,
    _run_id: Option<&str>,
    _image_index: Option<u32>,
    _feature: &'static str,
    _slot_hook: &crate::commands::gen_worker::SlotHook<'_>,
) -> Result<PathBuf, String> {
    Err("resident path disabled on windows".to_string())
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
pub(crate) async fn generate_image(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    feature: &'static str,
) -> Result<PathBuf, String> {
    generate_image_for_run(
        app,
        state,
        prompt,
        image_paths,
        cwd,
        model,
        effort,
        None,
        None,
        feature,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
pub(crate) async fn generate_image_for_run(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    run_id: Option<&str>,
    image_index: Option<u32>,
    feature: &'static str,
) -> Result<PathBuf, String> {
    generate_image_for_run_with_slot_hook(
        app,
        state,
        prompt,
        image_paths,
        cwd,
        model,
        effort,
        run_id,
        image_index,
        feature,
        &crate::commands::gen_worker::SlotHook::none(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
pub(crate) async fn generate_image_for_run_with_slot_hook(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    run_id: Option<&str>,
    image_index: Option<u32>,
    feature: &'static str,
    slot_hook: &crate::commands::gen_worker::SlotHook<'_>,
) -> Result<PathBuf, String> {
    // T0: 1枚の区間タイムを jsonl へ排気する。どの脱出経路を通っても
    // 必ず1行残るよう、成功/失敗の分岐すべてで record する。
    // feature は呼び出し元の機能名 (batch / storyboard / multiangle)。
    // 固定値にすると機能別の前後比較ができない。
    let mut timer = gen_metrics::GenTimer::start("resident", feature);
    let phase = GenPhaseReporter::new(app, run_id, image_index);
    let result = generate_image_measured(
        app,
        state,
        prompt,
        image_paths,
        cwd,
        model,
        effort,
        run_id,
        &phase,
        &mut timer,
        slot_hook,
    )
    .await;
    match &result {
        Ok(_) => timer.record_ok(),
        Err(error) => {
            // 429 を観測したら同時実行数を自動で降格する (T3 のフェイルセーフ)。
            note_rate_limit(app, error);
            timer.record_err(error);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
async fn generate_image_measured(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    run_id: Option<&str>,
    phase: &GenPhaseReporter,
    timer: &mut gen_metrics::GenTimer,
    slot_hook: &crate::commands::gen_worker::SlotHook<'_>,
) -> Result<PathBuf, String> {
    let run_id = run_id.map(str::trim).filter(|value| !value.is_empty());
    if run_is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }

    let server = ensure_client(app, state).await?;
    // ② 常駐サーバーの起動 + handshake。再利用できたときはほぼ0になる。
    timer.server_ready();
    let client = &server.client;

    let mut thread_params = Map::new();
    thread_params.insert("approvalPolicy".into(), Value::String("never".into()));
    thread_params.insert("sandbox".into(), Value::String("workspace-write".into()));
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        thread_params.insert("cwd".into(), Value::String(cwd.to_string()));
    }

    let thread_result = client
        .request_raw("thread/start", Value::Object(thread_params))
        .await
        .map_err(|error| format!("生成用 thread/start に失敗: {error}"))?;
    let thread_id = extract_thread_id(&thread_result)
        .ok_or_else(|| "生成用 thread/start の応答から threadId を取得できません".to_string())?;

    // turn/start より先に購読し、開始直後の item 通知も取りこぼさない。
    let mut notifications = client.subscribe();
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    input.extend(
        image_paths
            .iter()
            .map(|path| json!({ "type": "localImage", "path": path })),
    );

    let mut turn_params = Map::new();
    turn_params.insert("threadId".into(), Value::String(thread_id.clone()));
    turn_params.insert("input".into(), Value::Array(input));
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        turn_params.insert("model".into(), Value::String(model.to_string()));
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        turn_params.insert("effort".into(), Value::String(effort.to_string()));
    }

    if run_is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    // ① 順番待ちの開始を先に知らせる。ここを過ぎるまで UI は「送ったのに無反応」に
    // 見えていた。空きがあれば下の acquire は即座に返るので、queued は一瞬で
    // thinking に上書きされる (待ち0枚のときに嘘の待機表示を出さない)。
    //
    // position は「自分の前に何枚走っているか」。available_permits() から求める。
    // 実行中でなく空き枠を見るのは、降格 (9→6) 中でも実効の待ち数になるため。
    let position = (gen_queue::current_limit() as u32)
        .saturating_sub(GLOBAL_GEN_SEMAPHORE.available_permits() as u32);
    phase.emit_with_position(GenPhase::Queued, Some(position));
    // RAII: 以降どの経路で抜けても Drop が債務返済を通す (直接 drop できない)。
    let permit = gen_queue::OwnedGenPermit::acquire(Arc::clone(&*GLOBAL_GEN_SEMAPHORE)).await?;
    // 枠が取れた = このカットが本当に動き始めた。呼び出し側 (character_sheet の
    // cutStarted) へ折り返す。acquire より前で呼ばないのが要点。
    slot_hook.fire();
    // ① 順番待ち (セマフォ空き待ち)。
    timer.permit_acquired();
    // 待機中にキャンセルされた turn は共有サーバーへ発行しない。
    if run_is_cancelled(run_id) {
        return Err(gen_queue::cancelled_error());
    }
    let started_at = Instant::now();
    let turn_result = client
        .request_raw("turn/start", Value::Object(turn_params))
        .await
        .map_err(|error| format!("生成用 turn/start に失敗: {error}"))?;
    let turn_id = extract_turn_id(&turn_result)
        .ok_or_else(|| "生成用 turn/start の応答から turnId を取得できません".to_string())?;
    // ② turn を発行できた = LLM が動き始めた。ここから描画開始までが「構図を考える」区間。
    phase.emit(GenPhase::Thinking);

    let remaining = GENERATION_TIMEOUT.saturating_sub(started_at.elapsed());
    // 描画開始通知の受信有無。成功でも失敗でも1行に残すので、match の外で持つ。
    let drawing_seen = AtomicBool::new(false);
    let wait_result = timeout(
        remaining,
        wait_for_saved_path(
            client,
            &mut notifications,
            &thread_id,
            &turn_id,
            &server.poisoned,
            run_id,
            phase,
            &drawing_seen,
        ),
    )
    .await;
    if drawing_seen.load(Ordering::Relaxed) {
        timer.drawing_started();
    }
    match wait_result {
        Ok(Ok(path)) => {
            // ③④⑤ turn/start から画像の保存通知まで。
            timer.turn_done();
            // 降格中は permit をセマフォへ戻さず握り潰す (上限を実際に下げる)。
            drop(permit);
            // 完了通知とキャンセルが競合した場合も、キャンセル後の成果は採用しない。
            if run_is_cancelled(run_id) {
                Err(gen_queue::cancelled_error())
            } else {
                // ⑥ 保存確認 (wait_for_saved_path 内の is_file リトライ) の完了時点。
                timer.saved();
                // 完成。キャンセル済みの run では出さない (上の分岐で先に抜ける) ——
                // 中止したのに「完成」と表示するのは嘘の完了表示になる。
                phase.emit(GenPhase::Done);
                Ok(path)
            }
        }
        Ok(Err(error)) => {
            if error.hold_permit {
                spawn_permit_watchdog(
                    permit,
                    notifications,
                    thread_id,
                    turn_id,
                    server.process_stopped.clone(),
                );
            } else {
                drop(permit);
            }
            if run_is_cancelled(run_id) {
                Err(gen_queue::cancelled_error())
            } else {
                Err(error.message)
            }
        }
        Err(_) => {
            // interrupt の RPC 成功と turn/completed の両方を確認する。
            // 確認できなければ番犬へ permit を渡し、ゾンビ生成が生死不明の間も
            // 全体同時実行数の 1 枠として数え続ける。
            let interruption_confirmed = interrupt_or_poison(
                client,
                &mut notifications,
                &thread_id,
                &turn_id,
                &server.poisoned,
            )
            .await;
            if !interruption_confirmed {
                spawn_permit_watchdog(
                    permit,
                    notifications,
                    thread_id,
                    turn_id,
                    server.process_stopped.clone(),
                );
            } else {
                drop(permit);
            }
            if run_is_cancelled(run_id) {
                Err(gen_queue::cancelled_error())
            } else {
                Err(format!(
                    "画像生成がタイムアウトしました（{}秒）。プロンプトを短くするか、時間をおいて再試行してください。",
                    GENERATION_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

/// 常駐経路のタイムアウト失敗か。呼び出し側は同じ試行内で二重化せず、
/// 次の試行だけ旧 exec 経路へ切り替える。
pub(crate) fn is_timeout_error(error: &str) -> bool {
    error.contains("画像生成がタイムアウトしました")
}

/// turn/start は受理されたのに最初の通知が届かなかった接続死か。
/// 呼び出し側はタイムアウトと同じく、次の試行だけ旧 exec 経路へ切り替える。
pub(crate) fn is_stale_server_error(error: &str) -> bool {
    error.contains(STALE_SERVER_ERROR)
}

/// 生成失敗が429なら同時実行数を自動降格し、ユーザーへ1度だけ通知する (T3)。
///
/// 上限を9へ上げた得は確実だが、混雑時間帯の429再発リスクは残る
/// (2026-07-17 の実測は特定時間帯のもの)。人が設定を戻す運用に頼らず、
/// 観測したその場で6へ落とす。降格は当該プロセスが終了するまで維持する
/// (混雑が続く間に上げ直して再発させない)。
pub(crate) fn note_rate_limit(app: &AppHandle, error: &str) {
    if !gen_queue::is_rate_limit_error(error) {
        return;
    }
    if !gen_queue::degrade_on_rate_limit() {
        // すでに降格済み。通知の重複は出さない。
        return;
    }
    let payload = json!({
        "kind": "genConcurrencyDegraded",
        "from": gen_queue::NORMAL_LIMIT,
        "to": gen_queue::DEGRADED_LIMIT,
        "message": format!(
            "生成サーバーが混雑しているため、同時生成数を{}枚から{}枚に自動で下げました。生成は続きます。",
            gen_queue::NORMAL_LIMIT,
            gen_queue::DEGRADED_LIMIT
        ),
    });
    if let Err(emit_error) = app.emit(crate::events::EVENT_GEN_CONCURRENCY, payload) {
        tracing::warn!(
            target: "codex.gen_server",
            "同時実行数の降格通知を送れませんでした: {emit_error}"
        );
    }
}

/// 常駐サーバーを先に起動しておく (計画書 T4 プリウォーム)。
///
/// なぜ: 常駐サーバーは初回生成時に遅延起動するため、「最初の1枚」だけ
/// プロセス起動 + handshake (最大30秒) を待たされる。生成を発行しなければ
/// turn は走らず枠は消費しないので、起動だけ先に済ませて先払いにする。
///
/// 失敗しても何もしない。次の生成時に従来どおり遅延起動されるだけで、
/// プリウォームの失敗がアプリの起動や生成を妨げてはならない。
#[cfg(not(windows))]
pub fn spawn_prewarm(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let started = Instant::now();
        match ensure_client(&app, &state).await {
            Ok(lease) => {
                // lease を即 drop して active_turns を戻す。turn は発行しない
                // ため画像生成は走らず、枠 (サブスク quota) も消費しない。
                drop(lease);
                tracing::info!(
                    target: "codex.gen_server",
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "生成用 app-server をプリウォームしました"
                );
            }
            Err(error) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "生成用 app-server のプリウォームに失敗 (初回生成時に遅延起動されます): {error}"
                );
            }
        }
    });
}

/// Windows は常駐経路そのものが無効なので、プリウォームも何もしない。
#[cfg(windows)]
pub fn spawn_prewarm(_app: &AppHandle) {}

async fn wait_for_saved_path(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
    poisoned: &AtomicBool,
    run_id: Option<&str>,
    phase: &GenPhaseReporter,
    // `item/started`(imageGeneration) を1度でも受信したら true を立てる。
    // どの経路 (成功/失敗/中止/タイムアウト) で抜けても呼び出し側が読めるよう、
    // 戻り値ではなく外から渡された旗に書く (設計書 S1 受入(c) の記録用)。
    drawing_seen: &AtomicBool,
) -> Result<PathBuf, WaitForSavedPathError> {
    let mut health_tick = interval(Duration::from_millis(250));
    health_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let first_signal_deadline = tokio::time::sleep(FIRST_SIGNAL_TIMEOUT);
    tokio::pin!(first_signal_deadline);
    let mut first_signal_seen = false;

    loop {
        if run_is_cancelled(run_id) {
            // 共有プロセスを止めず、このrunの turn だけを正規RPCで中断する。
            let interruption_confirmed =
                interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
            return Err(if interruption_confirmed {
                WaitForSavedPathError::release(gen_queue::cancelled_error())
            } else {
                WaitForSavedPathError::hold(gen_queue::cancelled_error())
            });
        }

        tokio::select! {
            _ = &mut first_signal_deadline, if !first_signal_seen => {
                // turn/start が通っても、この turn の通知が1件も来ない接続は
                // 認証更新などで実質的に死んでいる。次の turn で交換されるよう
                // 先に汚染マークを付け、現在の turn は正規RPCで中断を試みる。
                poisoned.store(true, Ordering::Release);
                let interruption_confirmed =
                    interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                return Err(if interruption_confirmed {
                    WaitForSavedPathError::release(STALE_SERVER_ERROR)
                } else {
                    WaitForSavedPathError::hold(STALE_SERVER_ERROR)
                });
            }
            notification = notifications.recv() => {
                match notification {
                    Ok(notification) => {
                        if notification_matches(&notification.params, thread_id, turn_id)
                            || turn_notification_matches(&notification.params, thread_id, turn_id)
                        {
                            // この turn の通知が1件でも来れば接続は生きている。
                            // 以後は通常の900秒全体タイムアウトだけに委ねる。
                            first_signal_seen = true;
                        }
                        // ③ 描画開始。app-server は以前からこの通知を送っていたが、
                        // GORI は item/completed しか見ておらず**受信者がいなかった**
                        // (設計書 1-3)。ここが「LLMが考え中」と「実際に描いている」を
                        // 区別できる唯一の実データ。
                        if notification.method == "item/started"
                            && notification_matches(&notification.params, thread_id, turn_id)
                            && notification
                                .params
                                .get("item")
                                .and_then(|item| item.get("type"))
                                .and_then(Value::as_str)
                                == Some("imageGeneration")
                        {
                            phase.emit(GenPhase::Drawing);
                            // 「描画開始の通知が実際に届いた」事実を計測ログへ残す。
                            // 届かない環境では false のまま記録され、設計書 S1 の
                            // fallback (3フェーズへ縮退) を判断する根拠になる。
                            drawing_seen.store(true, Ordering::Relaxed);
                        }

                        if notification.method == "item/completed"
                            && notification_matches(&notification.params, thread_id, turn_id)
                        {
                            let item = notification.params.get("item").unwrap_or(&Value::Null);
                            if item.get("type").and_then(Value::as_str) == Some("imageGeneration") {
                                if let Some(saved_path) = item
                                    .get("savedPath")
                                    .and_then(Value::as_str)
                                    .filter(|path| !path.is_empty())
                                {
                                    let path = PathBuf::from(saved_path);
                                    // PNG の書き込みが通知より遅れることがある
                                    // (フロント側 MessageList にも同じレースの前例)。
                                    // 250ms x 4 まで待ってから諦める。
                                    for _ in 0..4 {
                                        if path.is_file() {
                                            return Ok(path);
                                        }
                                        tokio::time::sleep(Duration::from_millis(250)).await;
                                    }
                                    if path.is_file() {
                                        return Ok(path);
                                    }
                                    return Err(WaitForSavedPathError::release(format!(
                                        "app-server が通知した生成画像が見つかりません: {}",
                                        path.display()
                                    )));
                                }
                            }
                        }

                        if notification.method == "turn/completed"
                            && turn_notification_matches(&notification.params, thread_id, turn_id)
                        {
                            return Err(WaitForSavedPathError::release(
                                turn_completed_without_image_error(&notification.params),
                            ));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // 通知相関を保証できないため、interrupt が確認できても
                        // このサーバー自体は次のアイドル時に入れ替える。
                        poisoned.store(true, Ordering::Release);
                        let interruption_confirmed =
                            interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                        let message = format!(
                            "生成用 app-server の通知が混雑し、{skipped}件を取りこぼしました"
                        );
                        return Err(if interruption_confirmed {
                            WaitForSavedPathError::release(message)
                        } else {
                            WaitForSavedPathError::hold(message)
                        });
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        poisoned.store(true, Ordering::Release);
                        let interruption_confirmed =
                            interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                        let message = "生成用 app-server の通知接続が閉じました";
                        return Err(if interruption_confirmed {
                            WaitForSavedPathError::release(message)
                        } else {
                            WaitForSavedPathError::hold(message)
                        });
                    }
                }
            }
            _ = health_tick.tick() => {
                if !client.is_alive() {
                    poisoned.store(true, Ordering::Release);
                    let interruption_confirmed =
                        interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                    let message = "生成用 app-server が生成中に終了しました";
                    return Err(if interruption_confirmed {
                        WaitForSavedPathError::release(message)
                    } else {
                        WaitForSavedPathError::hold(message)
                    });
                }
            }
        }
    }
}

fn run_is_cancelled(run_id: Option<&str>) -> bool {
    run_id.map(gen_queue::is_cancelled).unwrap_or(false)
}

async fn interrupt_or_poison(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
    poisoned: &AtomicBool,
) -> bool {
    match interrupt_and_confirm(client, notifications, thread_id, turn_id).await {
        Ok(()) => true,
        Err(error) => {
            poisoned.store(true, Ordering::Release);
            tracing::warn!(
                target: "codex.gen_server",
                "turn/interrupt 完了を確認できないため app-server を交代予約します: {error}"
            );
            false
        }
    }
}

fn spawn_permit_watchdog(
    permit: gen_queue::OwnedGenPermit,
    notifications: broadcast::Receiver<RpcNotification>,
    thread_id: String,
    turn_id: String,
    process_stopped: watch::Receiver<bool>,
) {
    spawn_permit_watchdog_with_timeout(
        permit,
        notifications,
        thread_id,
        turn_id,
        process_stopped,
        GENERATION_TIMEOUT,
    );
}

fn spawn_permit_watchdog_with_timeout(
    permit: gen_queue::OwnedGenPermit,
    mut notifications: broadcast::Receiver<RpcNotification>,
    thread_id: String,
    turn_id: String,
    mut process_stopped: watch::Receiver<bool>,
    max_hold: Duration,
) {
    tokio::spawn(async move {
        let deadline = tokio::time::sleep(max_hold);
        tokio::pin!(deadline);
        let mut notifications_open = true;
        let mut process_watch_open = true;

        let release_reason = loop {
            if *process_stopped.borrow() {
                break "poisoned server process stopped";
            }

            tokio::select! {
                _ = &mut deadline => {
                    break "watchdog maximum hold elapsed";
                }
                notification = notifications.recv(), if notifications_open => {
                    match notification {
                        Ok(notification)
                            if notification.method == "turn/completed"
                                && turn_notification_matches(
                                    &notification.params,
                                    &thread_id,
                                    &turn_id,
                                ) =>
                        {
                            break "turn/completed received";
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {
                            notifications_open = false;
                        }
                    }
                }
                changed = process_stopped.changed(), if process_watch_open => {
                    match changed {
                        Ok(()) if *process_stopped.borrow() => {
                            break "poisoned server process stopped";
                        }
                        Ok(()) => {}
                        Err(_) => {
                            process_watch_open = false;
                        }
                    }
                }
            }
        };

        tracing::info!(
            target: "codex.gen_server",
            thread_id,
            turn_id,
            release_reason,
            "生死不明 turn の番犬が画像生成 permit を解放します"
        );
        // 降格中は握り潰して実効上限を下げる (通常時はセマフォへ戻る)。
        drop(permit);
    });
}

async fn interrupt_and_confirm(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let request = client.request_raw(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    );
    match timeout(INTERRUPT_TIMEOUT, request).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Err(format!("turn/interrupt 失敗: {error}")),
        Err(_) => return Err("turn/interrupt 応答待機がタイムアウト".to_string()),
    }

    match timeout(
        INTERRUPT_TIMEOUT,
        wait_for_turn_completed(notifications, thread_id, turn_id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("interrupt 後の turn/completed 待機がタイムアウト".to_string()),
    }
}

async fn wait_for_turn_completed(
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    loop {
        match notifications.recv().await {
            Ok(notification)
                if notification.method == "turn/completed"
                    && turn_notification_matches(&notification.params, thread_id, turn_id) =>
            {
                return Ok(());
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return Err(format!(
                    "interrupt 完了通知を待つ間に {skipped}件を取りこぼしました"
                ));
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err("interrupt 完了通知を待つ前に接続が閉じました".to_string());
            }
        }
    }
}

fn notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
}

fn turn_notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            == Some(turn_id)
}

fn turn_completed_without_image_error(params: &Value) -> String {
    let turn = params.get("turn").unwrap_or(&Value::Null);
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if let Some(message) = turn
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
    {
        return format!("生成用 turn が失敗しました: {message}");
    }
    format!("生成用 turn が画像を返さず終了しました (status={status})")
}

fn extract_thread_id(result: &Value) -> Option<String> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("threadId").and_then(Value::as_str))
        .map(str::to_string)
}

fn extract_turn_id(result: &Value) -> Option<String> {
    result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("turnId").and_then(Value::as_str))
        .map(str::to_string)
}

fn should_replace_server(turns_started: u64, active_turns: u64, poisoned: bool) -> bool {
    active_turns == 0 && (turns_started >= MAX_TURNS_PER_SERVER || poisoned)
}

async fn ensure_client(app: &AppHandle, state: &AppState) -> Result<GenServerLease, String> {
    let mut slot = state.gen_server.lock().await;
    if let Some(server) = slot.as_mut() {
        let child_alive = match server.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "生成用 app-server が終了していたため再起動します: {status}"
                );
                false
            }
            Err(error) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "生成用 app-server の死活確認に失敗したため再起動します: {error}"
                );
                false
            }
        };
        if child_alive && server.client.is_alive() {
            let active_turns = server.active_turns.load(Ordering::Acquire);
            let poisoned = server.poisoned.load(Ordering::Acquire);
            if should_replace_server(server.turns_started, active_turns, poisoned) {
                tracing::info!(
                    target: "codex.gen_server",
                    "生成用 app-server が交代条件に達したため、アイドル状態で入れ替えます (turns={}, poisoned={poisoned})",
                    server.turns_started
                );
            } else {
                server.turns_started += 1;
                server.active_turns.fetch_add(1, Ordering::AcqRel);
                return Ok(GenServerLease {
                    client: server.client.clone(),
                    poisoned: Arc::clone(&server.poisoned),
                    process_stopped: server.process_stopped.subscribe(),
                    _active_turn: ActiveTurnGuard {
                        active_turns: Arc::clone(&server.active_turns),
                    },
                });
            }
        }
    }

    if let Some(server) = slot.take() {
        stop_server(server).await;
    }

    let mut server = spawn_server(app).await?;
    server.turns_started = 1;
    server.active_turns.store(1, Ordering::Release);
    let lease = GenServerLease {
        client: server.client.clone(),
        poisoned: Arc::clone(&server.poisoned),
        process_stopped: server.process_stopped.subscribe(),
        _active_turn: ActiveTurnGuard {
            active_turns: Arc::clone(&server.active_turns),
        },
    };
    *slot = Some(server);
    Ok(lease)
}

#[cfg(unix)]
async fn spawn_server(app: &AppHandle) -> Result<GenServerProcess, String> {
    let source_home = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "生成用 CODEX_HOME のミラー元を解決できません".to_string())?;
    let generation_home = crate::codex::home::gen_codex_home_path()
        .ok_or_else(|| "生成用 CODEX_HOME の場所を解決できません".to_string())?;
    crate::commands::batch_gen::mirror_resident_codex_home(&source_home, &generation_home)?;

    let bin = resolve_codex_binary(None)
        .map_err(|error| format!("生成用 Codex app-server の解決に失敗: {error:#}"))?;
    let first_error = match spawn_server_attempt(app, &bin, &generation_home).await {
        Ok(server) => return Ok(server),
        Err(error) => error,
    };
    if !first_error.sqlite_state_corruption {
        return Err(first_error.message);
    }

    let quarantine = match quarantine_sqlite_state(&generation_home) {
        Ok(Some(result)) => result,
        Ok(None) => return Err(first_error.message),
        Err(error) => {
            tracing::warn!(
                target: "codex.gen_server",
                "壊れた可能性がある sqlite state を退避できませんでした: {error}"
            );
            return Err(first_error.message);
        }
    };
    tracing::warn!(
        target: "codex.gen_server",
        path = %quarantine.path.display(),
        moved_files = quarantine.moved_files,
        "壊れた可能性がある sqlite state を退避し、app-server を1回だけ再起動します"
    );

    match spawn_server_attempt(app, &bin, &generation_home).await {
        Ok(server) => Ok(server),
        Err(retry_error) => Err(format!(
            "生成エンジンの内部データが壊れています。自動修復を試みましたが復旧できませんでした。アプリを再起動しても直らない場合は、設定 → ストレージから生成エンジンのデータ初期化をお試しください。(詳細: 初回: {}; 再試行: {})",
            first_error.message, retry_error.message
        )),
    }
}

#[cfg(unix)]
struct SpawnServerAttemptError {
    message: String,
    sqlite_state_corruption: bool,
}

#[cfg(unix)]
impl SpawnServerAttemptError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            sqlite_state_corruption: false,
        }
    }
}

#[cfg(unix)]
struct SqliteQuarantine {
    path: PathBuf,
    moved_files: usize,
}

#[cfg(unix)]
async fn spawn_server_attempt(
    app: &AppHandle,
    bin: &Path,
    generation_home: &Path,
) -> Result<GenServerProcess, SpawnServerAttemptError> {
    let proc = spawn_generation_app_server(bin, generation_home)
        .await
        .map_err(|error| {
            SpawnServerAttemptError::plain(format!("生成用 Codex app-server の起動に失敗: {error}"))
        })?;
    let AppServerProcess {
        mut child,
        stdin,
        stdout,
        stderr_buf,
    } = proc;

    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = child.kill().await;
            return Err(SpawnServerAttemptError::plain(
                "生成用 Codex app-server の PID を取得できません",
            ));
        }
    };
    // 常駐サーバーは複数runで共有するため run_id を紐づけず、個別キャンセルの
    // PID停止対象から外す。実行中turnは turn/interrupt で止める。
    let registration =
        match WorkerPidGuard::register(app, pid, RESIDENT_GEN_SERVER_WORKER_KIND, None) {
            Ok(registration) => registration,
            Err(error) => {
                let _ = child.kill().await;
                return Err(SpawnServerAttemptError::plain(format!(
                    "生成用 app-server の PID 台帳登録に失敗: {error}"
                )));
            }
        };

    let handle = RpcClient::start(stdin, stdout);
    let client = handle.client.clone();

    // 生成専用プロセスの server request は UI に流さず、内部で明示的に拒否する。
    // approvalPolicy=never のため通常は来ないが、未応答で turn を止めない安全策。
    {
        let client_for_requests = client.clone();
        let mut guard = handle.server_req_rx.lock().await;
        if let Some(mut requests) = guard.take() {
            tokio::spawn(async move {
                while let Some(request) = requests.recv().await {
                    tracing::warn!(
                        target: "codex.gen_server",
                        method = %request.method,
                        "生成専用 app-server の server request を自動拒否しました"
                    );
                    let _ = client_for_requests.respond_error(
                        request.id,
                        -32000,
                        "generation worker does not accept interactive requests",
                    );
                }
            });
        }
    }

    let handshake_error = match timeout(HANDSHAKE_TIMEOUT, handshake(&client)).await {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(format!("{error:#}")),
        Err(_) => Some(format!(
            "initialize handshake が{}秒でタイムアウト",
            HANDSHAKE_TIMEOUT.as_secs()
        )),
    };
    if let Some(error) = handshake_error {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stderr = stderr_buf.snapshot();
        let sqlite_state_corruption = is_sqlite_state_corruption_error(&error, &stderr);
        let stderr_tail = stderr
            .last()
            .map(String::as_str)
            .unwrap_or("stderr 出力なし");
        if let Err(kill_error) = child.start_kill() {
            tracing::warn!(
                target: "codex.gen_server",
                "初期化失敗後の app-server 停止シグナル送信に失敗: {kill_error}"
            );
        }
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            tracing::warn!(
                target: "codex.gen_server",
                "初期化失敗後の app-server 終了待機がタイムアウトしました"
            );
        }
        return Err(SpawnServerAttemptError {
            message: format!("生成用 Codex app-server の初期化に失敗: {error} ({stderr_tail})"),
            sqlite_state_corruption,
        });
    }

    let (process_stopped, _) = watch::channel(false);
    tracing::info!(target: "codex.gen_server", pid, "生成用 app-server を起動しました");
    Ok(GenServerProcess {
        client,
        child,
        _registration: registration,
        turns_started: 0,
        active_turns: Arc::new(AtomicU64::new(0)),
        poisoned: Arc::new(AtomicBool::new(false)),
        process_stopped,
    })
}

fn is_sqlite_state_corruption_error(error: &str, stderr_snapshot: &[String]) -> bool {
    let combined = std::iter::once(error)
        .chain(stderr_snapshot.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();

    // handshake 失敗に限定して既知のDB系シグナルだけを見る。
    // `state` 単独や `runtime` 単独では発火させず、誤退避を避ける。
    [
        "sqlite",
        "state runtime",
        "database",
        "malformed",
        "unable to open",
    ]
    .iter()
    .any(|signal| combined.contains(signal))
}

#[cfg(unix)]
fn quarantine_sqlite_state(generation_home: &Path) -> Result<Option<SqliteQuarantine>, String> {
    let entries = std::fs::read_dir(generation_home).map_err(|error| {
        format!(
            "生成用 CODEX_HOME を読み込めません ({}): {error}",
            generation_home.display()
        )
    })?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "sqlite state の退避候補を読み取れませんでした: {error}"
                );
                continue;
            }
        };
        let name = entry.file_name();
        if !name.to_string_lossy().contains(".sqlite") {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    path = %entry.path().display(),
                    "sqlite state の種類を確認できませんでした: {error}"
                );
                continue;
            }
        };
        if file_type.is_file() || file_type.is_symlink() {
            candidates.push(entry.path());
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }

    let base_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("sqlite state 退避時刻の取得に失敗: {error}"))?
        .as_secs();
    let mut quarantine_seconds = base_seconds;
    let quarantine_path = loop {
        let path = generation_home.join(format!("broken-{quarantine_seconds}"));
        match std::fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                quarantine_seconds = quarantine_seconds
                    .checked_add(1)
                    .ok_or_else(|| "sqlite state の退避先名を決められません".to_string())?;
            }
            Err(error) => {
                return Err(format!(
                    "sqlite state の退避先を作成できませんでした ({}): {error}",
                    path.display()
                ));
            }
        }
    };

    let mut moved_files = 0;
    for source in candidates {
        let Some(file_name) = source.file_name() else {
            continue;
        };
        let destination = quarantine_path.join(file_name);
        match std::fs::rename(&source, &destination) {
            Ok(()) => moved_files += 1,
            Err(error) => tracing::warn!(
                target: "codex.gen_server",
                source = %source.display(),
                destination = %destination.display(),
                "sqlite state を退避できませんでした: {error}"
            ),
        }
    }

    Ok((moved_files > 0).then_some(SqliteQuarantine {
        path: quarantine_path,
        moved_files,
    }))
}

#[cfg(not(unix))]
async fn spawn_server(_app: &AppHandle) -> Result<GenServerProcess, String> {
    Err("resident path disabled on windows".to_string())
}

#[cfg(unix)]
async fn spawn_generation_app_server(
    bin: &Path,
    generation_home: &Path,
) -> Result<AppServerProcess, String> {
    let bin_name = bin
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_native_app_server = bin_name.starts_with("codex-app-server");

    let mut cmd = TokioCommand::new(bin);
    if !is_native_app_server {
        cmd.arg("app-server");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", enriched_path())
        .env("CODEX_HOME", generation_home)
        .kill_on_drop(true);
    no_window_flag(&mut cmd);

    let mut child = cmd.spawn().map_err(|error| {
        format!(
            "{} の起動に失敗 (CODEX_HOME={}): {error}",
            bin.display(),
            generation_home.display()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child stdin を取得できません".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout を取得できません".to_string())?;

    let stderr_buf = StderrBuffer::default();
    if let Some(stderr) = child.stderr.take() {
        let logger_buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "codex.stderr", "{}", line);
                logger_buf.push(line);
            }
        });
    }

    tracing::info!(
        target: "codex.home",
        path = %generation_home.display(),
        "生成専用 app-server CODEX_HOME"
    );
    Ok(AppServerProcess {
        child,
        stdin,
        stdout,
        stderr_buf,
    })
}

async fn stop_server(mut server: GenServerProcess) {
    if let Err(error) = server.child.start_kill() {
        tracing::warn!(
            target: "codex.gen_server",
            "生成用 app-server の停止シグナル送信に失敗: {error}"
        );
    }
    match timeout(Duration::from_secs(5), server.child.wait()).await {
        Ok(Ok(_)) => {
            let _ = server.process_stopped.send(true);
        }
        Ok(Err(error)) => {
            tracing::warn!(
                target: "codex.gen_server",
                "生成用 app-server の終了確認に失敗しました: {error}"
            );
        }
        Err(_) => {
            tracing::warn!(target: "codex.gen_server", "生成用 app-server の終了待機がタイムアウトしました");
        }
    }
}

/// アプリ終了時に常駐 child を止め、PID 台帳の guard も破棄する。
pub(crate) async fn shutdown(state: &AppState) {
    let server = state.gen_server.lock().await.take();
    if let Some(server) = server {
        stop_server(server).await;
    }
}

#[derive(Deserialize)]
struct RegistryEntry {
    pid: u32,
    kind: String,
}

/// worker_registry の同じ PID 台帳にクラッシュ時だけ残る生成用 app-server を、
/// 汎用 worker 清掃が台帳を空にする前に停止する。
pub(crate) fn cleanup_stale_registered_servers(app: &AppHandle) {
    let path = match app.path().app_data_dir() {
        Ok(path) => path.join(WORKER_REGISTRY_FILE),
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳の場所を解決できません: {error}");
            return;
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳を読めません: {error}");
            return;
        }
    };
    let entries: Vec<RegistryEntry> = match serde_json::from_slice(&bytes) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳を解析できません: {error}");
            return;
        }
    };

    for entry in entries
        .into_iter()
        .filter(|entry| entry.kind == RESIDENT_GEN_SERVER_WORKER_KIND)
    {
        let Some(command_line) = command_line_for_pid(entry.pid) else {
            continue;
        };
        if !is_gen_server_command(&command_line) {
            tracing::warn!(
                target: "codex.gen_server",
                pid = entry.pid,
                "PID台帳と app-server のコマンドが一致しないため kill を見送りました"
            );
            continue;
        }
        if send_terminate(entry.pid) {
            tracing::info!(
                target: "codex.gen_server",
                pid = entry.pid,
                "前回クラッシュ時に残った生成用 app-server を停止しました"
            );
        }
    }
}

fn is_gen_server_command(command_line: &str) -> bool {
    let normalized = command_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    normalized.contains("codex-app-server")
        || (normalized.contains("codex") && normalized.contains(" app-server"))
}

#[cfg(unix)]
fn command_line_for_pid(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command_line = String::from_utf8(output.stdout).ok()?;
    let command_line = command_line.trim().to_string();
    (!command_line.is_empty()).then_some(command_line)
}

#[cfg(not(unix))]
fn command_line_for_pid(_pid: u32) -> Option<String> {
    // 既存 worker_registry と同じく、PID 再利用を安全に検証できない環境では kill しない。
    None
}

#[cfg(unix)]
fn send_terminate(pid: u32) -> bool {
    Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn send_terminate(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{
        extract_thread_id, extract_turn_id, gen_queue, is_gen_server_command,
        is_sqlite_state_corruption_error, is_stale_server_error, notification_matches,
        should_replace_server, spawn_permit_watchdog_with_timeout, GenPhase, MAX_TURNS_PER_SERVER,
    };
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{broadcast, watch, Semaphore};
    use tokio::time::timeout;

    use crate::codex::rpc::RpcNotification;

    #[test]
    fn extracts_v2_ids() {
        assert_eq!(
            extract_thread_id(&json!({ "thread": { "id": "thread-1" } })).as_deref(),
            Some("thread-1")
        );
        assert_eq!(
            extract_turn_id(&json!({ "turn": { "id": "turn-1" } })).as_deref(),
            Some("turn-1")
        );
    }

    #[test]
    fn phase_names_match_frontend_contract() {
        // TS 側 `GEN_PHASE_ORDER` と1文字でもずれるとフェーズ表示が無反応になる。
        assert_eq!(GenPhase::Queued.as_str(), "queued");
        assert_eq!(GenPhase::Thinking.as_str(), "thinking");
        assert_eq!(GenPhase::Drawing.as_str(), "drawing");
        assert_eq!(GenPhase::Done.as_str(), "done");
    }

    /// `item/started` の判定を、実際に走らせる emit 経路と同じ条件式で切り出したもの。
    /// wait_for_saved_path 全体は RpcClient と app-server を要求するため、
    /// ここでは通知の形だけを対象にする。
    fn is_drawing_start(notification: &RpcNotification, thread_id: &str, turn_id: &str) -> bool {
        notification.method == "item/started"
            && notification_matches(&notification.params, thread_id, turn_id)
            && notification
                .params
                .get("item")
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("imageGeneration")
    }

    #[test]
    fn drawing_phase_fires_only_for_matching_image_generation_start() {
        let started = RpcNotification {
            method: "item/started".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": { "id": "item-1", "type": "imageGeneration", "status": "inProgress" }
            }),
        };
        assert!(is_drawing_start(&started, "thread-1", "turn-1"));

        // 別 turn の通知で他の枠のフェーズを進めない (並列9枚が混線する)。
        assert!(!is_drawing_start(&started, "thread-1", "turn-2"));

        // 画像以外の item (reasoning 等) では描画中にしない。
        let reasoning = RpcNotification {
            method: "item/started".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": { "id": "item-2", "type": "reasoning" }
            }),
        };
        assert!(!is_drawing_start(&reasoning, "thread-1", "turn-1"));

        // completed は描画開始ではない (done 側で扱う)。
        let completed = RpcNotification {
            method: "item/completed".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": { "id": "item-1", "type": "imageGeneration", "savedPath": "/tmp/a.png" }
            }),
        };
        assert!(!is_drawing_start(&completed, "thread-1", "turn-1"));
    }

    #[test]
    fn recognizes_cli_and_native_app_server_commands() {
        assert!(is_gen_server_command("/usr/local/bin/codex app-server"));
        assert!(is_gen_server_command("/Applications/GORI/codex-app-server"));
        assert!(!is_gen_server_command("/usr/local/bin/codex exec -"));
    }

    #[test]
    fn recognizes_sqlite_state_corruption_without_matching_plain_state_errors() {
        assert!(is_sqlite_state_corruption_error(
            "SQLite state runtime initialization failed",
            &[],
        ));
        assert!(is_sqlite_state_corruption_error(
            "initialize failed",
            &["DATABASE disk image is MALFORMED".to_string()],
        ));
        assert!(is_sqlite_state_corruption_error(
            "unable to open state store",
            &[],
        ));
        assert!(is_sqlite_state_corruption_error("database error", &[]));
        assert!(is_sqlite_state_corruption_error("malformed page", &[]));
        assert!(!is_sqlite_state_corruption_error(
            "state initialization failed",
            &[],
        ));
        assert!(!is_sqlite_state_corruption_error(
            "runtime initialization failed",
            &[],
        ));
    }

    #[test]
    fn recognizes_only_stale_server_fallback_error() {
        assert!(is_stale_server_error(
            "生成サーバーが応答しません（接続が古くなっている可能性があります）。別の経路で再試行します。"
        ));
        assert!(!is_stale_server_error(
            "生成用 app-server が生成中に終了しました"
        ));
    }

    #[test]
    fn replaces_expired_or_poisoned_server_only_when_idle() {
        assert!(should_replace_server(MAX_TURNS_PER_SERVER, 0, false));
        assert!(!should_replace_server(MAX_TURNS_PER_SERVER, 1, false));
        assert!(should_replace_server(1, 0, true));
        assert!(!should_replace_server(1, 1, true));
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_matching_turn_completed() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = gen_queue::OwnedGenPermit::acquire(Arc::clone(&semaphore))
            .await
            .unwrap();
        let (notification_tx, notifications) = broadcast::channel(4);
        let (_process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_secs(1),
        );

        notification_tx
            .send(RpcNotification {
                method: "turn/completed".to_string(),
                params: json!({ "threadId": "thread-1", "turn": { "id": "turn-1" } }),
            })
            .unwrap();

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_process_stop_confirmation() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = gen_queue::OwnedGenPermit::acquire(Arc::clone(&semaphore))
            .await
            .unwrap();
        let (_notification_tx, notifications) = broadcast::channel(4);
        let (process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_secs(1),
        );

        process_stopped_tx.send(true).unwrap();

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_maximum_hold() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = gen_queue::OwnedGenPermit::acquire(Arc::clone(&semaphore))
            .await
            .unwrap();
        let (_notification_tx, notifications) = broadcast::channel(4);
        let (_process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_millis(20),
        );

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }
}
