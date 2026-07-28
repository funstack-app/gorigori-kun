//! 画像生成1枚ごとの区間タイムを jsonl へ排気する計測ログ (計画書 T0)。
//!
//! なぜ: 生成が「どこで遅いのか」が全区間 **未計測** で、速度改修の効果を
//! 数字で判定できなかった (`_work/gori-ux-redesign/generation-speed-plan.md` 1-1)。
//! 以後の速度施策の受入判定はこのログの前後比較で行う。
//!
//! 設計:
//! - **記録は生成の付帯物**。書き込み失敗は生成を失敗させない (warn だけ残す)
//! - 1枚 = 1行。行の追記のみで、既存行は書き換えない
//! - 保存先は `app_data_dir()/gen-metrics.jsonl`。上限を超えたら1世代だけ
//!   `.1` へ退避する (無限肥大の防止。計画書「ローテーション1行で回避」)
//!
//! 区間名は計画書 1-1 の丸数字に対応する:
//!   `permit_wait_ms`  = ① 順番待ち (セマフォ空き待ち)
//!   `server_start_ms` = ② 常駐サーバー起動 + handshake (再利用時は 0)
//!   `turn_ms`         = ③④⑤ turn/start 発行から画像の保存通知まで
//!   `save_ms`         = ⑥ 保存確認 + コピー
//!   `total_ms`        = 呼び出し側から見た1枚の所要 (区間の合計とは一致しない)

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const METRICS_FILE: &str = "gen-metrics.jsonl";

/// これを超えたら1世代だけ退避する。1行 300B 弱 × 約2万行。
const MAX_BYTES: u64 = 6 * 1024 * 1024;

/// 保存先。`AppHandle` を持たない場所 (常駐サーバー内部) からも書けるよう、
/// 起動時に1度だけ解決して覚えておく。未設定なら記録しない (no-op)。
static METRICS_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 起動時に1度呼ぶ。以後 `record` が有効になる。
pub fn init(app: &AppHandle) {
    let path = match app.path().app_data_dir() {
        Ok(dir) => dir.join(METRICS_FILE),
        Err(error) => {
            tracing::warn!(
                target: "codex.gen_metrics",
                "計測ログの保存先を解決できないため記録を無効にします: {error}"
            );
            return;
        }
    };
    *lock_path() = Some(path);
}

fn lock_path() -> std::sync::MutexGuard<'static, Option<PathBuf>> {
    METRICS_PATH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 生成1枚ぶんの計測結果。全区間は「測れたものだけ」入る (未計測は null)。
#[derive(Debug, Clone, Serialize)]
pub struct GenSample {
    /// UNIX ミリ秒。記録時刻。
    pub at_ms: i64,
    /// どの経路か。`resident` (常駐app-server) / `exec` (codex exec 都度起動)。
    pub route: &'static str,
    /// 呼び出し元の機能名。`batch` / `storyboard` / `multiangle` など。
    pub feature: &'static str,
    /// ① セマフォ待ち。
    pub permit_wait_ms: u64,
    /// ② 常駐サーバー起動 + handshake。再利用できたときは 0。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_start_ms: Option<u64>,
    /// ③④⑤ turn/start から画像保存の通知まで。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_ms: Option<u64>,
    /// ⑥ 保存確認 + コピー。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_ms: Option<u64>,
    /// 1枚の全体所要。
    pub total_ms: u64,
    /// 成功したか。
    pub ok: bool,
    /// 記録時点の同時実行上限 (降格中は DEGRADED_LIMIT)。
    pub limit: usize,
    /// `item/started`(imageGeneration) を実際に受信したか (設計書 S1 受入(c))。
    ///
    /// これが false のまま溜まるなら app-server は描画開始を通知していない。
    /// そのときフェーズ3「描いています…」は永久に出ないので、設計書の fallback
    /// (「準備中→完成」の3フェーズへ落とす) の判断根拠になる。**届かない事実を
    /// 推測でなくログの事実として残す** (no-silent-gap-filling)。
    pub drawing_seen: bool,
    /// 失敗時のみ。エラー文の先頭 200 文字。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 1枚ぶんの区間タイムを組み立てるストップウォッチ。
///
/// `Instant` の差分だけを持ち、`record` を呼ばなければ何も書かない。
/// 計測点を挿し忘れた区間は `None` のまま残り、「未計測」がログ上で
/// 埋められた値と区別できる (推測で埋めない)。
pub struct GenTimer {
    route: &'static str,
    feature: &'static str,
    started: Instant,
    permit_wait_ms: u64,
    server_start_ms: Option<u64>,
    turn_ms: Option<u64>,
    save_ms: Option<u64>,
    drawing_seen: bool,
    mark: Instant,
}

impl GenTimer {
    pub fn start(route: &'static str, feature: &'static str) -> Self {
        let now = Instant::now();
        Self {
            route,
            feature,
            started: now,
            permit_wait_ms: 0,
            server_start_ms: None,
            turn_ms: None,
            save_ms: None,
            drawing_seen: false,
            mark: now,
        }
    }

    /// 直前の `mark` からの経過を返し、`mark` を今に進める。
    fn lap(&mut self) -> u64 {
        let now = Instant::now();
        let elapsed = now.duration_since(self.mark).as_millis() as u64;
        self.mark = now;
        elapsed
    }

    /// ② 常駐サーバーの確保が終わった時点で呼ぶ。
    pub fn server_ready(&mut self) {
        self.server_start_ms = Some(self.lap());
    }

    /// ① permit を取得した時点で呼ぶ。
    pub fn permit_acquired(&mut self) {
        self.permit_wait_ms = self.lap();
    }

    /// ③④⑤ 画像の保存パスを受け取った時点で呼ぶ。
    pub fn turn_done(&mut self) {
        self.turn_ms = Some(self.lap());
    }

    /// ⑥ 保存確認とコピーが終わった時点で呼ぶ。
    pub fn saved(&mut self) {
        self.save_ms = Some(self.lap());
    }

    /// `item/started`(imageGeneration) を受信した時点で呼ぶ。
    /// 区間時間ではなく「届いたか」の事実だけを立てる (mark は進めない)。
    pub fn drawing_started(&mut self) {
        self.drawing_seen = true;
    }

    fn into_sample(self, ok: bool, error: Option<String>) -> GenSample {
        GenSample {
            at_ms: now_ms(),
            route: self.route,
            feature: self.feature,
            permit_wait_ms: self.permit_wait_ms,
            server_start_ms: self.server_start_ms,
            turn_ms: self.turn_ms,
            save_ms: self.save_ms,
            total_ms: self.started.elapsed().as_millis() as u64,
            ok,
            limit: crate::commands::gen_queue::current_limit(),
            drawing_seen: self.drawing_seen,
            error,
        }
    }

    /// 成功として1行書く。
    pub fn record_ok(self) {
        record(self.into_sample(true, None));
    }

    /// 失敗として1行書く。エラー文は先頭200文字だけ残す。
    pub fn record_err(self, error: &str) {
        record(self.into_sample(false, Some(truncate_error(error))));
    }
}

/// エラー文を1行ログに載る長さへ切り詰める。
/// バイトでなく文字数で切る (日本語エラーを途中で割ると JSON が壊れる)。
fn truncate_error(error: &str) -> String {
    error.chars().take(200).collect()
}

/// 1行追記する。失敗しても生成の成否には影響させない。
pub fn record(sample: GenSample) {
    let path = match lock_path().clone() {
        Some(path) => path,
        // init 前 (テスト・起動直後) は黙って捨てる。
        None => return,
    };

    let mut line = match serde_json::to_string(&sample) {
        Ok(line) => line,
        Err(error) => {
            tracing::warn!(target: "codex.gen_metrics", "計測ログのJSON化に失敗: {error}");
            return;
        }
    };
    line.push('\n');

    if let Err(error) = append_line(&path, line.as_bytes()) {
        tracing::warn!(
            target: "codex.gen_metrics",
            path = %path.display(),
            "計測ログの追記に失敗 (生成には影響しません): {error}"
        );
    }
}

fn append_line(path: &std::path::Path, line: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rotate_if_needed(path);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(line)
}

/// 上限を超えていたら1世代だけ `.1` へ退避する。世代は1つしか持たない
/// (古いログは速度改修の前後比較に使わないため、無限に積む価値がない)。
fn rotate_if_needed(path: &std::path::Path) {
    let too_big = std::fs::metadata(path)
        .map(|meta| meta.len() >= MAX_BYTES)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let backup = path.with_extension("jsonl.1");
    if let Err(error) = std::fs::rename(path, &backup) {
        tracing::warn!(
            target: "codex.gen_metrics",
            "計測ログのローテーションに失敗 (追記は継続します): {error}"
        );
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{truncate_error, GenTimer, MAX_BYTES};

    #[test]
    fn unmeasured_segments_stay_none() {
        // 「未計測」を 0 で埋めない。埋めると後日のログ読解で
        // 「速かった」と「測っていない」が区別できなくなる。
        let timer = GenTimer::start("resident", "batch");
        let sample = timer.into_sample(true, None);
        assert!(sample.server_start_ms.is_none());
        assert!(sample.turn_ms.is_none());
        assert!(sample.save_ms.is_none());
        assert_eq!(sample.permit_wait_ms, 0);
    }

    #[test]
    fn measured_segments_are_recorded_in_order() {
        let mut timer = GenTimer::start("resident", "storyboard");
        timer.server_ready();
        timer.permit_acquired();
        timer.turn_done();
        timer.saved();
        let sample = timer.into_sample(true, None);
        assert!(sample.server_start_ms.is_some());
        assert!(sample.turn_ms.is_some());
        assert!(sample.save_ms.is_some());
        assert_eq!(sample.route, "resident");
        assert_eq!(sample.feature, "storyboard");
        assert!(sample.ok);
    }

    #[test]
    fn error_is_truncated_by_chars_not_bytes() {
        // 日本語のエラー文をバイトで切ると UTF-8 が壊れて JSON 行が読めなくなる。
        let japanese = "短時間に生成しすぎてサーバーから制限されています。".repeat(20);
        let truncated = truncate_error(&japanese);
        assert_eq!(truncated.chars().count(), 200);
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());

        // 200文字未満はそのまま残す。
        assert_eq!(truncate_error("短い失敗"), "短い失敗");
    }

    #[test]
    fn failed_sample_carries_error_and_not_ok() {
        let timer = GenTimer::start("exec", "multiangle");
        let sample = timer.into_sample(false, Some(truncate_error("HTTP 429")));
        assert_eq!(sample.error.as_deref(), Some("HTTP 429"));
        assert!(!sample.ok);
        assert_eq!(sample.route, "exec");
    }

    #[test]
    fn drawing_seen_defaults_false_and_is_recorded_when_observed() {
        // 設計書 S1 受入(c): item/started が届かない事実を記録に残す。
        // 既定を true にすると「届かなかった」が観測できなくなる。
        let never = GenTimer::start("resident", "batch").into_sample(true, None);
        assert!(!never.drawing_seen);

        let mut timer = GenTimer::start("resident", "batch");
        timer.drawing_started();
        assert!(timer.into_sample(true, None).drawing_seen);

        // 失敗した枚でも受信有無は残す (失敗時こそ届いていたかが要る)。
        let mut failed = GenTimer::start("resident", "batch");
        failed.drawing_started();
        assert!(failed.into_sample(false, Some("boom".into())).drawing_seen);
    }

    #[test]
    fn drawing_seen_is_serialized_into_the_line() {
        // フィールドが skip されると jsonl を後から読んでも判定できない。
        let sample = GenTimer::start("resident", "batch").into_sample(true, None);
        let line = serde_json::to_string(&sample).expect("sample serializes");
        assert!(line.contains("\"drawing_seen\":false"), "line={line}");
    }

    #[test]
    fn rotation_threshold_is_sane() {
        assert!(MAX_BYTES > 1024 * 1024);
    }

    #[test]
    fn record_without_init_is_noop() {
        // init 前に呼ばれても panic せず黙って捨てる (テスト・起動直後の経路)。
        let timer = GenTimer::start("resident", "batch");
        timer.record_ok();
    }
}
