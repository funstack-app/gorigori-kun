fn main() {
    // cfg(edit_ai) エイリアスを発行する (2026-08-02)。
    //
    // 「Windows かつ edit-ai feature が有効」= ort が依存ツリーに居る、という
    // 条件をソース側で毎回書くと二重条件の書き漏れが必ず出る。build.rs で 1 語に
    // 畳んでおき、ソースは #[cfg(edit_ai)] だけを見る。
    //
    // ort は [target.'cfg(target_os = "windows")'.dependencies] にあるため、
    // Mac/Linux では feature が立っていても ort は存在しない。だから OS 条件も
    // ここで AND を取る。
    println!("cargo:rustc-check-cfg=cfg(edit_ai)");
    let is_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let edit_ai_enabled = std::env::var_os("CARGO_FEATURE_EDIT_AI").is_some();
    if is_windows && edit_ai_enabled {
        println!("cargo:rustc-cfg=edit_ai");
    }

    tauri_build::build()
}
