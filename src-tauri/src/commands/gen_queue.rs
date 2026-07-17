use tokio::sync::Semaphore;

/// アプリ全体で同時に実行できる画像生成 `codex exec` の上限。
///
/// 2026-07-17 実測: 同時6枚・同時9枚とも429ゼロで全完走(gpt-5.6-sol/low、
/// 各57-78秒)。9まで通る実力に対し安全マージンを取って6とする。
/// 旧値3は2026-06時点の実測(「3が安定・5で時々429」)で、レート実力が
/// 改善している。混雑時間帯に429が再発したら下げる。
pub static GLOBAL_GEN_SEMAPHORE: Semaphore = Semaphore::const_new(6);
