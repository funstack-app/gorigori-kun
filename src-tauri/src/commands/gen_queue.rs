use tokio::sync::Semaphore;

/// アプリ全体で同時に実行できる画像生成 `codex exec` の上限。
pub static GLOBAL_GEN_SEMAPHORE: Semaphore = Semaphore::const_new(3);
