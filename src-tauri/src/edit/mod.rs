// ONNX Runtime (ort) を使うモジュールは Windows 限定 (2026-07-28)。
//
// なぜ: ort-sys 2.0.0-rc.12 が Intel Mac (x86_64-apple-darwin) の prebuilt 配布を
// 終了したため、ort を全プラットフォーム依存のままにすると Intel Mac がビルドできない。
// ort を使う編集機能群 (SAM2/SAM3/LaMa/BiRefNet/PP-OCR) は現在フロントで封印済みで、
// Mac の背景透過は Vision (resources/removebg.swift) が担っている。
// 詳細は Cargo.toml の [target.'cfg(target_os = "windows")'.dependencies] のコメント。
//
// 非 Windows では該当コマンドが「Windows 版のみ」を返すスタブに差し替わる
// (commands/edit_unsupported.rs)。

#[cfg(target_os = "windows")]
pub mod auto_segment;
pub mod download;
#[cfg(target_os = "windows")]
pub mod grab;
#[cfg(target_os = "windows")]
pub mod human_parse;
#[cfg(target_os = "windows")]
pub mod inpaint;
#[cfg(target_os = "windows")]
pub mod magic_layer;
#[cfg(all(test, target_os = "windows"))]
mod magic_layer_e2e;
#[cfg(target_os = "windows")]
pub mod ocr;
pub mod registry;
#[cfg(target_os = "windows")]
pub mod runtime;
#[cfg(target_os = "windows")]
pub mod sam2;
#[cfg(target_os = "windows")]
pub mod sam3_text;
#[cfg(target_os = "windows")]
pub mod segment;
// subject_split は edit::grab::dilate_mask_pub に依存し、消費側も magic_layer だけ。
#[cfg(target_os = "windows")]
pub mod subject_split;
pub mod understanding;
