use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorPayload {
    pub code: i64,
    pub message: String,
}
