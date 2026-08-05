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

#[cfg(edit_ai)]
pub mod auto_segment;
pub mod download;
#[cfg(edit_ai)]
pub mod grab;
#[cfg(edit_ai)]
pub mod human_parse;
#[cfg(edit_ai)]
pub mod inpaint;
#[cfg(edit_ai)]
pub mod magic_layer;
#[cfg(all(test, edit_ai))]
mod magic_layer_e2e;
#[cfg(edit_ai)]
pub mod ocr;
pub mod registry;
#[cfg(edit_ai)]
pub mod runtime;
#[cfg(edit_ai)]
pub mod sam2;
#[cfg(edit_ai)]
pub mod sam3_text;
#[cfg(edit_ai)]
pub mod segment;
// subject_split は edit::grab::dilate_mask_pub に依存し、消費側も magic_layer だけ。
#[cfg(edit_ai)]
pub mod subject_split;
pub mod understanding;
