//! キャラクター登録 IPアセット化パイプライン (スライスS4) の Rust オーケストレータ。
//!
//! 1枚の参照画像から「3面図 + 表情セット + 顔ディテール」の固定カタログを【並列】生成する。
//! multiangle_run の直接流用ではなく新コマンドにした理由 (設計書 §3):
//!   - カットの供給元が違う (可変な構図カタログ vs 固定のシートカタログ)
//!   - 全カット共通で *不変の見た目属性* を焼き込む必要がある (multiangle の environment とは別軸)
//!   - プロンプトの主眼が反転する (multiangle=カメラを大胆に変える / sheet=表情カットはアングル固定)
//!
//! 生成の下部構造 (セマフォ / PID台帳 / PNG回収 / リトライ / timeout) は
//! commands/gen_worker.rs を multiangle と共用する。

use std::path::{Path, PathBuf};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::codex::process::resolve_codex_cli_binary;
use crate::commands::gen_worker::{generate_one_cut, short_id, timestamp_id};
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_CHARACTER_SHEET;
use crate::state::AppState;

/// カタログ上限。フロント側 DEFAULT_SHEET(10) / 詳しく(14) を安全に収める。
/// gen_queue::GLOBAL_GEN_SEMAPHORE(上限6)が同時実行を絞るので枚数自体は安全。
const MAX_SHEET_CUTS: usize = 30;

/// フロントが SHEET_CUTS から展開して渡す各カット。
/// `src/lib/character/sheetCuts.ts` の SheetCut から { cutId, role, promptFragment } を抜いたもの。
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SheetCutSpec {
    /// 一意ID。出力ファイル名・sheetRoles のキーに使う ("front" | "expression-smile" 等)。
    pub cut_id: String,
    /// sheetRoles に入る役割値 ("front" | "side" | "expression-smile" 等)。
    pub role: String,
    /// 構図/表情の英語指定 (プロンプトに焼き込む)。
    pub prompt_fragment: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSheetParams {
    /// 参照画像 (必須・1枚)。
    pub character_image: String,
    /// 不変の見た目テキスト (全カット共通で焼く。任意)。
    #[serde(default)]
    pub attributes: String,
    /// "1:1" | "9:16" | "16:9" | "4:5" など。
    pub aspect_ratio: String,
    /// 生成するカットのカタログ (フロントが SHEET_CUTS から展開)。
    pub cut_specs: Vec<SheetCutSpec>,
    /// 出力先プロジェクト判定用の cwd (任意)。
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CharacterSheetEvent {
    Started {
        run_id: String,
        total: u32,
    },
    CutStarted {
        cut_id: String,
        role: String,
        index: u32,
    },
    CutCompleted {
        cut_id: String,
        role: String,
        image_path: String,
    },
    CutFailed {
        cut_id: String,
        reason: String,
    },
    Completed {
        run_id: String,
        output_dir: String,
    },
}

#[tauri::command]
pub async fn character_sheet_run(
    app: AppHandle,
    _state: State<'_, AppState>,
    params: CharacterSheetParams,
) -> Result<String, String> {
    // app-server と同じ GORI 専用 CODEX_HOME を使う。worker は mirror_codex_home で
    // この HOME から auth/config/skills を一時 HOME に複製する。
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    let run_id = format!("{}-{}", timestamp_id(), short_id());
    let task_run_id = run_id.clone();

    tokio::spawn(async move {
        if let Err(err) = run_character_sheet_orchestrator(
            app.clone(),
            codex_bin,
            codex_home_orig,
            task_run_id,
            params,
        )
        .await
        {
            tracing::warn!(target: "codex.character_sheet", "character_sheet orchestrator failed: {err}");
            let _ = app.emit(
                EVENT_CHARACTER_SHEET,
                CharacterSheetEvent::CutFailed {
                    cut_id: "unknown".into(),
                    reason: err,
                },
            );
        }
    });

    Ok(run_id)
}

/// 単一カット再生成。検品で落ちた/破綻したカットだけ再度1枚生成して再emitする。
#[tauri::command]
pub async fn character_sheet_regenerate_cut(
    app: AppHandle,
    _state: State<'_, AppState>,
    run_id: String,
    cut_id: String,
    params: CharacterSheetParams,
) -> Result<String, String> {
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;

    let character_path = PathBuf::from(&params.character_image);
    if !character_path.is_file() {
        return Err(format!(
            "参照画像が見つかりません: {}",
            params.character_image
        ));
    }

    let cut = params
        .cut_specs
        .iter()
        .find(|c| c.cut_id == cut_id)
        .cloned()
        .ok_or_else(|| format!("再生成対象のカットが見つかりません: {cut_id}"))?;

    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(params.cwd.as_deref());
    let out_dir = resolve_output_dir(
        &storage_settings,
        project_name.as_deref(),
        &format!("gori-character-sheet-{run_id}"),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("character-sheet 出力先作成失敗: {e}"))?;

    let task_app = app.clone();
    let cwd = params.cwd.clone();
    let aspect_ratio = params.aspect_ratio.clone();
    let attributes = params.attributes.clone();

    tokio::spawn(async move {
        let prompt = build_sheet_prompt(&cut, &aspect_ratio, &attributes);
        let _ = task_app.emit(
            EVENT_CHARACTER_SHEET,
            CharacterSheetEvent::CutStarted {
                cut_id: cut.cut_id.clone(),
                role: cut.role.clone(),
                index: 0,
            },
        );
        match generate_one_cut(
            &task_app,
            &codex_bin,
            &codex_home_orig,
            &prompt,
            &[character_path],
            &out_dir,
            &cut.cut_id,
            cwd,
        )
        .await
        {
            Ok(image_path) => {
                let _ = task_app.emit(
                    EVENT_CHARACTER_SHEET,
                    CharacterSheetEvent::CutCompleted {
                        cut_id: cut.cut_id,
                        role: cut.role,
                        image_path: image_path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(err) => {
                tracing::warn!(target: "codex.character_sheet", "regenerate_cut failed: {err}");
                let _ = task_app.emit(
                    EVENT_CHARACTER_SHEET,
                    CharacterSheetEvent::CutFailed {
                        cut_id: cut.cut_id,
                        reason: err,
                    },
                );
            }
        }
    });

    Ok(cut_id)
}

async fn run_character_sheet_orchestrator(
    app: AppHandle,
    codex_bin: PathBuf,
    codex_home_orig: PathBuf,
    run_id: String,
    params: CharacterSheetParams,
) -> Result<(), String> {
    validate_params(&params)?;

    let storage_settings = StorageSettings::load()?;
    let project_name = project_name_from_cwd(params.cwd.as_deref());
    let out_dir = resolve_output_dir(
        &storage_settings,
        project_name.as_deref(),
        &format!("gori-character-sheet-{run_id}"),
    );
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("character-sheet 出力先作成失敗: {e}"))?;

    let total = params.cut_specs.len() as u32;
    let _ = app.emit(
        EVENT_CHARACTER_SHEET,
        CharacterSheetEvent::Started {
            run_id: run_id.clone(),
            total,
        },
    );

    let character_path = PathBuf::from(&params.character_image);
    let aspect_ratio = params.aspect_ratio.clone();
    let attributes = params.attributes.clone();
    let cwd = params.cwd.clone();

    // ★並列。カタログの全カットを一気に走らせる。同時実行の制御は
    // gen_queue::GLOBAL_GEN_SEMAPHORE(全機能共通・上限6)に一本化。
    let tasks = params
        .cut_specs
        .iter()
        .enumerate()
        .map(|(index, cut)| {
            let app = app.clone();
            let codex_bin = codex_bin.clone();
            let codex_home_orig = codex_home_orig.clone();
            let character_path = character_path.clone();
            let out_dir = out_dir.clone();
            let aspect_ratio = aspect_ratio.clone();
            let attributes = attributes.clone();
            let cwd = cwd.clone();
            let cut = cut.clone();
            async move {
                let _ = app.emit(
                    EVENT_CHARACTER_SHEET,
                    CharacterSheetEvent::CutStarted {
                        cut_id: cut.cut_id.clone(),
                        role: cut.role.clone(),
                        index: index as u32,
                    },
                );
                let prompt = build_sheet_prompt(&cut, &aspect_ratio, &attributes);
                match generate_one_cut(
                    &app,
                    &codex_bin,
                    &codex_home_orig,
                    &prompt,
                    &[character_path],
                    &out_dir,
                    &cut.cut_id,
                    cwd,
                )
                .await
                {
                    Ok(image_path) => {
                        let _ = app.emit(
                            EVENT_CHARACTER_SHEET,
                            CharacterSheetEvent::CutCompleted {
                                cut_id: cut.cut_id.clone(),
                                role: cut.role.clone(),
                                image_path: image_path.to_string_lossy().into_owned(),
                            },
                        );
                    }
                    Err(err) => {
                        tracing::warn!(target: "codex.character_sheet", "cut {} failed: {err}", cut.cut_id);
                        let _ = app.emit(
                            EVENT_CHARACTER_SHEET,
                            CharacterSheetEvent::CutFailed {
                                cut_id: cut.cut_id.clone(),
                                reason: err,
                            },
                        );
                    }
                }
            }
        })
        .collect::<Vec<_>>();
    join_all(tasks).await;

    let _ = app.emit(
        EVENT_CHARACTER_SHEET,
        CharacterSheetEvent::Completed {
            run_id,
            output_dir: out_dir.to_string_lossy().into_owned(),
        },
    );

    Ok(())
}

fn validate_params(params: &CharacterSheetParams) -> Result<(), String> {
    if params.character_image.trim().is_empty() {
        return Err("characterImage must not be empty".into());
    }
    if !Path::new(&params.character_image).is_file() {
        return Err(format!(
            "参照画像が見つかりません: {}",
            params.character_image
        ));
    }
    if params.cut_specs.is_empty() {
        return Err("生成するカットが1個も選択されていません".into());
    }
    if params.cut_specs.len() > MAX_SHEET_CUTS {
        return Err(format!(
            "カット数が上限 {MAX_SHEET_CUTS} を超えています ({} 個)",
            params.cut_specs.len()
        ));
    }
    Ok(())
}

/// シートカット用のプロンプトを組み立てる。build_multiangle_prompt とは主眼が違い、
/// (1) 全カット共通で不変の見た目属性を焼き込む (2) 表情カットでもアングルを大胆に変えず
/// 顔の同一性を最優先にする。3面図と表情シートの両方を1つのビルダで扱う。
fn build_sheet_prompt(cut: &SheetCutSpec, aspect_ratio: &str, attributes: &str) -> String {
    let attributes_line = if attributes.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n- 不変の見た目 (全カット共通で厳守): {}\n",
            attributes.trim()
        )
    };
    format!(
        "添付したキャラクター参照画像を使い、同一人物のリファレンスシート用に次の1枚を生成してください。\n\n\
         ## この画像の役割\n\
         - 指定 (英語): {prompt_fragment}\n{attributes_line}\n\
         ## 厳守事項\n\
         1. 参照画像の顔・骨格・髪・肌・体型・服を厳密に保持する。別人にしない。同一人物のリファレンスシートである。\n\
         2. 上記「指定 (英語)」のショット距離・向き・表情を正確に反映する。表情を変える指定でも、顔の造作は変えず表情の筋肉だけを動かす (same face, change only the expression muscles)。\n\
         3. 顔ディテール等の寄り指定では、寄るだけで別人化しない (same identity, zoom in only)。\n\
         4. 背景は無地の淡いグレースタジオ、均一で柔らかいライティングに揃える。シートとして並べたときに背景・光が一貫するようにする。\n\
         5. image_gen ツールを1回だけ呼び出す。\n\
         6. アスペクト比は必ず {aspect_ratio} にする (縦長指定なら縦長で。勝手に 16:9 にしない)。high quality で生成する。\n\
         7. 画面内テキスト、ロゴ、透かし、グリッド、コラージュ、複数パネルは禁止。1枚の単独画像にする。\n\
         8. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
         最終メッセージは OK または NG <理由> の1行のみ。",
        prompt_fragment = cut.prompt_fragment,
        attributes_line = attributes_line,
        aspect_ratio = aspect_ratio,
    )
}
