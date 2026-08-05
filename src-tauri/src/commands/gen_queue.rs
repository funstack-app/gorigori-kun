use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

/// 呼び出し側が通常の生成失敗と区別できる、キャンセル専用のエラー。
pub const GENERATION_CANCELLED_ERROR: &str = "キャンセルされました";

/// 完了時の明示削除に加え、終了後に届いたキャンセルも永久に残さないための保険。
/// 通常の最大30カット・同時6件・1件15分の待ち時間を十分に上回る。
const CANCELLED_RUN_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static CANCELLED_RUNS: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 実行中 run の台帳。cancel_generation が「知っている run か」を判定するために使う。
/// TTL は end 漏れ (panic 等) で永久に「実行中」扱いになる残骸の保険。
const ACTIVE_RUN_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static ACTIVE_RUNS: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// RAII: run 統括コマンドが保持し、Drop で必ず台帳から外れる。
///
/// spawn するコマンドは `begin` をコマンド本体で呼び、guard を task 内へ move する。
/// invoke が返った瞬間からフロントは run_id を知っているため、登録は spawn より前に要る。
/// 明示的な `end_run()` は作らない (呼び忘れを構造的に排除する)。
pub struct ActiveRunGuard {
    run_id: String,
}

impl ActiveRunGuard {
    pub fn begin(run_id: &str) -> Self {
        let run_id = run_id.trim().to_string();
        if run_id.is_empty() {
            // 空 ID は台帳に入れない。Drop 側も同じ条件で何もしない。
            return Self { run_id };
        }
        let mut active = active_runs();
        prune_stale_active(&mut active);
        active.insert(run_id.clone(), Instant::now());
        Self { run_id }
    }
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        if self.run_id.is_empty() {
            return;
        }
        active_runs().remove(&self.run_id);
    }
}

/// その run が今このアプリで走っているか。cancel_generation の既知/未知の判定に使う。
pub fn is_run_active(run_id: &str) -> bool {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return false;
    }
    let mut active = active_runs();
    prune_stale_active(&mut active);
    active.contains_key(run_id)
}

/// アプリ全体で同時に実行できる画像生成 `codex exec` の上限(通常時)。
///
/// 2026-07-17 実測: 同時6枚・同時9枚とも429ゼロで全完走(gpt-5.6-sol/low、
/// 各57-78秒)。旧値3は2026-06時点の実測(「3が安定・5で時々429」)で、
/// レート実力が改善している。
///
/// 2026-07-28: 実測済みの9まで引き上げた(旧値6は「9まで通る実力に対し
/// 安全マージンを取って6」だったが、波数削減の得が確実なのに対しリスクは
/// 下の自動降格で刈れるため、マージンを構造で置き換える)。
/// 混雑時間帯の429再発に備え、429を検知したら DEGRADED_LIMIT へ自動降格する。
pub const NORMAL_LIMIT: usize = 9;

/// 429 を検知したときに降格する同時実行数。2026-07-17 以前の実績値。
pub const DEGRADED_LIMIT: usize = 6;

pub static GLOBAL_GEN_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(NORMAL_LIMIT)));

/// 降格済みか。true の間は新規 permit の実効上限が DEGRADED_LIMIT。
static DEGRADED: AtomicBool = AtomicBool::new(false);

/// まだ回収できていない「引き上げるべき permit 数」。
///
/// `Semaphore::forget_permits` は **空いている permit しか減らせない**
/// (全部使用中なら 0 しか減らない)。降格時に減らし切れなかった分をここに
/// 借金として残し、permit が返ってくるたびに `settle_permit_with` が回収する。
static DEGRADE_DEBT: AtomicUsize = AtomicUsize::new(0);

/// 画像生成の失敗メッセージがレート制限(429)由来か。
///
/// 判定語は `codex::process::humanize_generation_failure` の429分岐と同じ
/// (整形前の生エラー・整形後の日本語文のどちらで渡されても拾えるようにする)。
pub fn is_rate_limit_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("http 429")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || error.contains("短時間に生成しすぎて")
}

/// 429 を観測したので同時実行数を DEGRADED_LIMIT へ落とす。
///
/// 何度呼んでも結果は同じ(初回だけ実際に絞る)。戻り値は「この呼び出しで
/// 実際に降格したか」で、呼び出し側はこれを見てユーザー通知を1回だけ出す。
pub fn degrade_on_rate_limit() -> bool {
    if DEGRADED.swap(true, Ordering::AcqRel) {
        return false;
    }
    let remaining = shrink_semaphore(
        &GLOBAL_GEN_SEMAPHORE,
        NORMAL_LIMIT.saturating_sub(DEGRADED_LIMIT),
    );
    if remaining > 0 {
        // 使用中で減らせなかった分は借金として残し、返却時に回収する。
        DEGRADE_DEBT.fetch_add(remaining, Ordering::AcqRel);
    }
    tracing::warn!(
        target: "codex.gen_queue",
        "429を検知したため画像生成の同時実行数を {NORMAL_LIMIT} → {DEGRADED_LIMIT} へ降格します (返却待ち={remaining})"
    );
    true
}

/// セマフォから最大 `target` 枚を即時回収し、**回収できなかった枚数**を返す。
///
/// `forget_permits` は空いている permit しか減らせないため、戻り値がそのまま
/// 「permit の返却時に回収すべき借金」になる。降格ロジックの本体で、
/// グローバル状態に触らないためテストから直接検査できる。
fn shrink_semaphore(semaphore: &Semaphore, target: usize) -> usize {
    target - semaphore.forget_permits(target)
}

/// permit を返す直前に呼び、降格の借金が残っていれば1枚ぶん回収する。
///
/// 戻り値 true = この permit は借金の返済に充てたので、呼び出し側は
/// セマフォへ戻さず握り潰す(`forget`)。
fn take_degrade_debt() -> bool {
    take_debt_from(&DEGRADE_DEBT)
}

/// `take_degrade_debt` の本体。カウンタを引数で受けるため、グローバル状態に
/// 触らずテストから直接検査できる (`shrink_semaphore` と同じ方針)。
fn take_debt_from(debt_counter: &AtomicUsize) -> bool {
    let mut debt = debt_counter.load(Ordering::Acquire);
    loop {
        if debt == 0 {
            return false;
        }
        match debt_counter.compare_exchange_weak(
            debt,
            debt - 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return true,
            Err(current) => debt = current,
        }
    }
}

/// 返済経路の本体: 借金があれば permit を握り潰し、無ければセマフォへ戻す。
///
/// `GenPermit` / `OwnedGenPermit` の Drop が実運用でここを通る。カウンタを
/// 引数で受ける形にしてあるので、ローカル Semaphore + ローカルカウンタで
/// 「返済1回で available_permits が増えないこと」を直接 assert できる。
fn settle_permit_with(debt_counter: &AtomicUsize, permit: tokio::sync::SemaphorePermit<'_>) {
    if take_debt_from(debt_counter) {
        permit.forget();
    } else {
        drop(permit);
    }
}

/// 現在の実効同時実行上限。ログ・テスト・表示用。
pub fn current_limit() -> usize {
    if DEGRADED.load(Ordering::Acquire) {
        DEGRADED_LIMIT
    } else {
        NORMAL_LIMIT
    }
}

pub fn is_degraded() -> bool {
    DEGRADED.load(Ordering::Acquire)
}

/// 生成枠の現在値。UI の「使用中 k / 上限 N」表示用 (cne / 2026-08-04)。
///
/// `limit` はその時点の実効上限で、429 による自動降格後は DEGRADED_LIMIT になる。
/// **フロントに定数をミラーしない**ためのコマンド: NORMAL 9 / DEGRADED 6 を
/// TypeScript 側にも書くと、降格したときに UI だけが 9 と言い続けて
/// 「嘘の上限」を出す。上限の正本はここ1箇所に保つ。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenCapacity {
    /// いま有効な同時実行上限。
    pub limit: usize,
    /// 429 を検知して降格済みか。UI が理由を添えられるようにする。
    pub degraded: bool,
}

/// 読み取り専用。生成枠の上限を返すだけで、キューの状態は一切変えない。
#[tauri::command]
pub fn gen_capacity() -> GenCapacity {
    GenCapacity {
        limit: current_limit(),
        degraded: is_degraded(),
    }
}

/// RAII: 画像生成 permit の保持者。**Drop が唯一の解放経路**。
///
/// permit を素の `drop` で手放すと必ずセマフォへ1枚戻るため、降格の借金
/// (`DEGRADE_DEBT`) がある間は `forget()` して戻してはならない。生の
/// `SemaphorePermit` を持ち回すと、早期 return や `?` の脱出経路がこの規約を
/// 黙って迂回する (2026-07-28 の統合評価で、キャンセル/spawn失敗/PID取得失敗/
/// 台帳登録/stdin失敗/900秒タイムアウトの各経路がすり抜けていた)。
///
/// このラッパーは permit を private に閉じ込め、Drop で必ず `settle` を通す。
/// **明示的な解放関数は用意しない**(呼び忘れを構造的に排除する。`ActiveRunGuard`
/// と同じ思想)。早い解放が要るときは `drop(permit)` するか、スコープを切る。
pub struct GenPermit<'a> {
    permit: Option<tokio::sync::SemaphorePermit<'a>>,
}

impl<'a> GenPermit<'a> {
    /// セマフォの空きを待って permit を1枚確保する。
    pub async fn acquire(semaphore: &'a Semaphore) -> Result<Self, String> {
        let permit = semaphore
            .acquire()
            .await
            .map_err(|_| "画像生成キューが閉じられました".to_string())?;
        Ok(Self {
            permit: Some(permit),
        })
    }
}

impl Drop for GenPermit<'_> {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            // 返済経路の本体。テストは同じ関数をローカル Semaphore で検査する。
            settle_permit_with(&DEGRADE_DEBT, permit);
        }
    }
}

/// `GenPermit` の owned 版 (gen_server が task 間で持ち回す permit 用)。
///
/// 規約・Drop の意味は `GenPermit` と同じ。
pub struct OwnedGenPermit {
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl OwnedGenPermit {
    /// セマフォの空きを待って owned permit を1枚確保する。
    pub async fn acquire(semaphore: Arc<Semaphore>) -> Result<Self, String> {
        let permit = semaphore
            .acquire_owned()
            .await
            .map_err(|_| "画像生成キューが閉じられました".to_string())?;
        Ok(Self {
            permit: Some(permit),
        })
    }
}

impl Drop for OwnedGenPermit {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            if take_degrade_debt() {
                permit.forget();
            }
        }
    }
}

/// run をキャンセル済みにする。同じ run を何度指定しても結果は同じ。
pub fn mark_cancelled(run_id: &str) {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return;
    }
    let mut cancelled = cancelled_runs();
    prune_stale(&mut cancelled);
    cancelled.insert(run_id.to_string(), Instant::now());
}

/// 待機中・実行中の仕事が、プロセス開始や結果採用の前に確認する。
pub fn is_cancelled(run_id: &str) -> bool {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return false;
    }
    let mut cancelled = cancelled_runs();
    prune_stale(&mut cancelled);
    cancelled.contains_key(run_id)
}

/// run の全仕事が終わった時に印を消し、run ID が台帳へ残り続けるのを防ぐ。
pub fn clear_cancelled(run_id: &str) {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return;
    }
    cancelled_runs().remove(run_id);
}

pub fn cancelled_error() -> String {
    GENERATION_CANCELLED_ERROR.to_string()
}

pub fn is_cancelled_error(error: &str) -> bool {
    error == GENERATION_CANCELLED_ERROR
}

fn cancelled_runs() -> MutexGuard<'static, HashMap<String, Instant>> {
    CANCELLED_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prune_stale(cancelled: &mut HashMap<String, Instant>) {
    cancelled.retain(|_, marked_at| marked_at.elapsed() < CANCELLED_RUN_TTL);
}

fn active_runs() -> MutexGuard<'static, HashMap<String, Instant>> {
    ACTIVE_RUNS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prune_stale_active(active: &mut HashMap<String, Instant>) {
    active.retain(|_, started_at| started_at.elapsed() < ACTIVE_RUN_TTL);
}

#[cfg(test)]
mod tests {
    use super::{
        clear_cancelled, is_cancelled, is_cancelled_error, is_rate_limit_error, is_run_active,
        mark_cancelled, settle_permit_with, shrink_semaphore, take_debt_from, ActiveRunGuard,
        AtomicUsize, GenPermit, Ordering, DEGRADED_LIMIT, GLOBAL_GEN_SEMAPHORE, NORMAL_LIMIT,
    };
    use tokio::sync::Semaphore;

    #[test]
    fn semaphore_starts_at_normal_limit() {
        // 上限を上げた変更が定数だけの書き換えで終わっていないことの確認。
        assert_eq!(NORMAL_LIMIT, 9);
        assert_eq!(DEGRADED_LIMIT, 6);
        // 降格前の初期容量。他テストが降格させたあとでも初期値の意味は変わらない
        // ため、静的定数側で検証する(可用 permit 数は並列テストで揺れる)。
        assert!(GLOBAL_GEN_SEMAPHORE.available_permits() <= NORMAL_LIMIT);
    }

    #[test]
    fn rate_limit_error_is_detected_in_raw_and_humanized_forms() {
        assert!(is_rate_limit_error(
            "codex exec failed: HTTP 429 Too Many Requests"
        ));
        assert!(is_rate_limit_error("Error: rate limit exceeded"));
        assert!(is_rate_limit_error("openai rate_limit_exceeded"));
        assert!(is_rate_limit_error(
            "短時間に生成しすぎてサーバーから一時的に制限されています。1〜2分おいてから再生成してください。"
        ));
        // 429 以外の失敗で降格させない (誤発火は同時実行数を無用に落とす)。
        assert!(!is_rate_limit_error("生成画像が見つかりませんでした"));
        assert!(!is_rate_limit_error(
            "画像生成サーバーが混雑または一時的に不安定です"
        ));
        assert!(!is_rate_limit_error("Higgsfield API error (HTTP 502)"));
    }

    #[test]
    fn shrink_reclaims_idle_permits_immediately() {
        // 全て空いているときは、その場で3枚回収でき借金は残らない。
        let semaphore = Semaphore::new(NORMAL_LIMIT);
        let debt = shrink_semaphore(&semaphore, NORMAL_LIMIT - DEGRADED_LIMIT);
        assert_eq!(debt, 0);
        assert_eq!(semaphore.available_permits(), DEGRADED_LIMIT);
    }

    #[test]
    fn shrink_defers_reclaim_to_debt_when_permits_are_in_flight() {
        // 9枚すべて生成中に429が来た場合。今すぐ減らせる permit は無いので
        // 3枚まるごと借金になり、返却時に回収される必要がある。
        // ここが壊れると「降格したつもりで実際は9本のまま走り続ける」ため、
        // 自動降格が名前だけの安全装置になる。
        let semaphore = Semaphore::new(NORMAL_LIMIT);
        let held: Vec<_> = (0..NORMAL_LIMIT)
            .map(|_| semaphore.try_acquire().expect("permit"))
            .collect();
        assert_eq!(semaphore.available_permits(), 0);

        let debt = shrink_semaphore(&semaphore, NORMAL_LIMIT - DEGRADED_LIMIT);
        assert_eq!(debt, NORMAL_LIMIT - DEGRADED_LIMIT);

        // 借金ぶんは forget で握り潰し、残りは通常どおり返す。
        let mut held = held.into_iter();
        for _ in 0..debt {
            held.next().expect("held permit").forget();
        }
        for permit in held {
            drop(permit);
        }
        assert_eq!(semaphore.available_permits(), DEGRADED_LIMIT);
    }

    #[test]
    fn shrink_partially_reclaims_when_some_permits_are_in_flight() {
        // 混在ケース: 8枚使用中 / 1枚空き。1枚は即時回収、2枚は借金。
        let semaphore = Semaphore::new(NORMAL_LIMIT);
        let held: Vec<_> = (0..NORMAL_LIMIT - 1)
            .map(|_| semaphore.try_acquire().expect("permit"))
            .collect();

        let debt = shrink_semaphore(&semaphore, NORMAL_LIMIT - DEGRADED_LIMIT);
        assert_eq!(debt, 2);

        let mut held = held.into_iter();
        for _ in 0..debt {
            held.next().expect("held permit").forget();
        }
        for permit in held {
            drop(permit);
        }
        assert_eq!(semaphore.available_permits(), DEGRADED_LIMIT);
    }

    /// 返済経路の本体テスト。既存の shrink 系テストは「借金が幾ら残るか」まで
    /// しか見ておらず、返済側 (`settle_permit_with`) は手動 forget で再現して
    /// いたため未検査だった。ここは実運用コードそのものを呼ぶ。
    #[test]
    fn settle_swallows_permit_while_debt_remains() {
        let semaphore = Semaphore::new(NORMAL_LIMIT);
        let debt = AtomicUsize::new(2);

        let permit = semaphore.try_acquire().expect("permit");
        assert_eq!(semaphore.available_permits(), NORMAL_LIMIT - 1);

        // 借金がある間の返済は、セマフォへ戻さず握り潰す。
        settle_permit_with(&debt, permit);
        assert_eq!(
            semaphore.available_permits(),
            NORMAL_LIMIT - 1,
            "借金返済に充てた permit がセマフォへ戻ってしまっている"
        );
        assert_eq!(debt.load(Ordering::Acquire), 1, "借金が1減っていない");
    }

    #[test]
    fn settle_returns_permit_once_debt_is_cleared() {
        let semaphore = Semaphore::new(NORMAL_LIMIT);
        let debt = AtomicUsize::new(1);

        // 1枚目は借金の返済に消える。
        let first = semaphore.try_acquire().expect("permit");
        settle_permit_with(&debt, first);
        assert_eq!(semaphore.available_permits(), NORMAL_LIMIT - 1);
        assert_eq!(debt.load(Ordering::Acquire), 0);

        // 借金が無くなったら、以降は通常どおりセマフォへ戻る。
        let second = semaphore.try_acquire().expect("permit");
        assert_eq!(semaphore.available_permits(), NORMAL_LIMIT - 2);
        settle_permit_with(&debt, second);
        assert_eq!(semaphore.available_permits(), NORMAL_LIMIT - 1);
    }

    #[test]
    fn take_debt_stops_at_zero() {
        let debt = AtomicUsize::new(1);
        assert!(take_debt_from(&debt));
        assert!(!take_debt_from(&debt));
        assert_eq!(
            debt.load(Ordering::Acquire),
            0,
            "借金がマイナスへ回り込んだ"
        );
    }

    /// 修正1のラッパーの Drop 経路。早期 return を模した早すぎるスコープ離脱でも、
    /// permit が「素の drop」ではなく返済経路を通ってセマフォへ戻ること。
    /// ここが壊れると早期エラー経路のすり抜けが再発する。
    #[tokio::test]
    async fn gen_permit_drop_returns_permit_to_semaphore() {
        let semaphore = Semaphore::new(1);

        // 早期 return を模して、内側スコープで permit を取って即抜ける。
        {
            let _permit = GenPermit::acquire(&semaphore).await.expect("acquire");
            assert_eq!(semaphore.available_permits(), 0);
        }

        assert_eq!(
            semaphore.available_permits(),
            1,
            "GenPermit の Drop が permit を解放していない"
        );

        // 解放後は再取得できる (次の生成が詰まらない)。
        let again = GenPermit::acquire(&semaphore).await;
        assert!(again.is_ok());
    }

    #[test]
    fn active_run_guard_registers_and_drops() {
        let run_id = "gen-queue-active-run-test";
        assert!(!is_run_active(run_id));

        {
            let _guard = ActiveRunGuard::begin(run_id);
            assert!(is_run_active(run_id));
        }

        assert!(!is_run_active(run_id));
    }

    #[test]
    fn cancellation_is_idempotent_and_clearable() {
        let run_id = "gen-queue-cancel-test";
        clear_cancelled(run_id);

        mark_cancelled(run_id);
        mark_cancelled(run_id);
        assert!(is_cancelled(run_id));
        assert!(is_cancelled_error("キャンセルされました"));

        clear_cancelled(run_id);
        assert!(!is_cancelled(run_id));
    }
}
