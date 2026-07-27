//! キャラクター登録 / 表情差分パイプラインの Rust オーケストレータ。
//!
//! キャラクター登録は統合キャラクターシート1枚を生成し、表情差分は従来どおり
//! 任意の複数カットを並列生成する。生成経路は params.generation_mode で分ける。
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

const COMPOSITE_CUT_ID: &str = "character-sheet";
const COMPOSITE_ROLE: &str = "character-sheet";

const COMPOSITE_CHARACTER_SHEET_PROMPT: &str = r#"役割:
あなたはプロのキャラクターデザイナー兼コンセプトアーティストです。添付した参考画像1枚のキャラクターを、商業作品で使用できる品質のキャラクターシートに再構築してください。原画の造形・配色・衣装・小物・世界観のディテールは一切変えず、忠実に保持してください。

出力スタイル:添付した写真通り

出力構成
1枚の縦長レイアウト(アスペクト比 3:4)で、上下2段構成にしてください。
上段:リファレンスシート(全身三面図+アセット詳細)
・背景はニュートラルなオフホワイト(淡いベージュ系)で統一
・全身の三面図を等身を揃え、共通の地平線で水平に整列配置
└ Front View(正面・全身)
└ Side Profile (L)(左側面・全身)
└ Back View(背面・全身)
・各ビューの下に英語ラベルを小さく入れる
・三面図と重ならない上部中央またはサイドの余白に、以下2つのインセットボックスを配置
└ Head Detail:頭部のクローズアップ(別状態・別表情のバリエーションを含む)
└ Costume / Pattern Detail:衣装の柄・テクスチャ・ロゴの拡大
・右下隅にカラーパレットのスウォッチ(主要色を5〜7色、四角いタイル状に小さく並べる)
・各インセットには英語の小見出しと簡潔な説明文を1〜2行添える
下段:シーンショット(シネマティック・横並び2カット)
キャラクターを原画の世界観に沿った環境内に配置し、劇場映画のキービジュアル風にドラマティックな光と影で演出してください。横並びの2カット構成です。
左カット:顔(または頭部)のエクストリーム・クローズアップ
・キャラクターの最も象徴的な顔・頭部の特徴をフレームいっぱいに切り取る
・表情・造形ディテール・素材感を強調
・背景は最小限、または暗めにフェードさせて顔を主役にする
右カット:背景が写っている全身ショット
・立位または座位で、キャラクターの世界観・空気感が伝わる背景込みの構図
・ロケーションが読み取れるだけの引き(全身がフレームに収まる)
・小物や環境ディテールも一緒に映り込ませる
・2カットでカメラアングルに変化をつける(クローズアップは正面・アイレベル寄り、全身は俯瞰/ローアングル/横位置など)
ビジュアル原則
・上段は資料的で整然とした構図、下段はシネマティックでドラマティックな構図
・上段と下段は「スタイル指定」で書いた1つのスタイルで全体を統一すること(混在禁止)
・全体を通して同一キャラクターであることが一目で分かる一貫性を最優先
・解像度は最高品質、描写の精度を保つこと
厳密に保持すべき要素(変更禁止)
・顔立ち、髪型、瞳の形と色
・体型とプロポーション、頭身
・衣装のシルエット、色、柄、装飾、素材感
・アクセサリー、小道具、ロゴ、武器、シンボル
・キャラクター固有のモチーフや象徴的なディテール
変更してよい要素
・各カットの表情(自然な範囲で)
・ポーズと身体の向き
・光源の方向と色温度
・背景の細部(世界観の範囲内で)
禁止事項
・原画にない衣装や装飾の追加
・体型・年齢・人種の改変
・「スタイル指定」で記入したスタイル以外の描画方式が混入すること
・参考画像と異なる配色への置き換え
・ロゴ・シンボル・固有モチーフの省略や改変"#;

#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CharacterSheetGenerationMode {
    Composite,
    #[default]
    MultiCut,
}

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
    /// composite=統合シート1枚 / multi-cut=従来の複数カット。省略時は後方互換で multi-cut。
    #[serde(default)]
    pub generation_mode: CharacterSheetGenerationMode,
    /// 生成するカットのカタログ。multi-cut のときだけ使用する。
    #[serde(default)]
    pub cut_specs: Vec<SheetCutSpec>,
    /// 出力先プロジェクト判定用の cwd (任意)。
    #[serde(default)]
    pub cwd: Option<String>,
    /// フロントが先に採番する run_id (任意)。渡された場合はそれを使い、
    /// beginRun 時点から確定 run_id を持てるようにする (B1 後着通知混線対策)。
    /// 省略時はバックエンドで採番する (再生成など既存経路の互換のため)。
    #[serde(default)]
    pub run_id: Option<String>,
}

/// この run を識別するトークン。全バリアントに載せてフロントで照合し、
/// 画面往復で別 run の後着通知が現在の状態を汚染するのを防ぐ (B1 混線対策)。
#[derive(Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CharacterSheetEvent {
    Started {
        run_id: String,
        total: u32,
    },
    CutStarted {
        run_id: String,
        cut_id: String,
        role: String,
        index: u32,
    },
    CutCompleted {
        run_id: String,
        cut_id: String,
        role: String,
        image_path: String,
    },
    CutFailed {
        run_id: String,
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
    state: State<'_, AppState>,
    params: CharacterSheetParams,
) -> Result<String, String> {
    // app-server と同じ GORI 専用 CODEX_HOME を使う。worker は mirror_codex_home で
    // この HOME から auth/config/skills を一時 HOME に複製する。
    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;
    // フロントが先に採番した run_id があればそれを使う。beginRun 時点から確定 run_id を
    // 持てるので、全イベントがその run_id を載せ、画面往復後の後着通知を照合で捨てられる。
    let run_id = match params.run_id.as_deref() {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => format!("{}-{}", timestamp_id(), short_id()),
    };
    let task_run_id = run_id.clone();

    let fail_run_id = run_id.clone();
    let fail_cut_id = match params.generation_mode {
        CharacterSheetGenerationMode::Composite => COMPOSITE_CUT_ID,
        CharacterSheetGenerationMode::MultiCut => "unknown",
    };
    // 2026-07-27: 常駐 app-server 経路 (gen_worker) へ渡すため state を複製する
    let task_state = state.inner_clone();
    tokio::spawn(async move {
        if let Err(err) = run_character_sheet_orchestrator(
            app.clone(),
            task_state,
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
                    run_id: fail_run_id,
                    cut_id: fail_cut_id.into(),
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
    state: State<'_, AppState>,
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

    // 2026-07-27: 常駐 app-server 経路 (gen_worker) に渡すため state も複製する

    let task_state = state.inner_clone();
    let cwd = params.cwd.clone();
    let aspect_ratio = params.aspect_ratio.clone();
    let attributes = params.attributes.clone();
    let event_run_id = run_id.clone();

    tokio::spawn(async move {
        let prompt = build_sheet_prompt(&cut, &aspect_ratio, &attributes);
        let _ = task_app.emit(
            EVENT_CHARACTER_SHEET,
            CharacterSheetEvent::CutStarted {
                run_id: event_run_id.clone(),
                cut_id: cut.cut_id.clone(),
                role: cut.role.clone(),
                index: 0,
            },
        );
        match generate_one_cut(
            &task_app,
            &task_state,
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
                        run_id: event_run_id,
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
                        run_id: event_run_id,
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
    // 2026-07-27: 常駐 app-server 経路 (gen_worker) へ渡すため追加
    state: AppState,
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

    let total = match params.generation_mode {
        CharacterSheetGenerationMode::Composite => 1,
        CharacterSheetGenerationMode::MultiCut => params.cut_specs.len() as u32,
    };
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

    match params.generation_mode {
        CharacterSheetGenerationMode::Composite => {
            let _ = app.emit(
                EVENT_CHARACTER_SHEET,
                CharacterSheetEvent::CutStarted {
                    run_id: run_id.clone(),
                    cut_id: COMPOSITE_CUT_ID.into(),
                    role: COMPOSITE_ROLE.into(),
                    index: 0,
                },
            );
            let prompt = build_composite_character_sheet_prompt(&attributes);
            match generate_one_cut(
                &app,
                &state,
                &codex_bin,
                &codex_home_orig,
                &prompt,
                &[character_path],
                &out_dir,
                COMPOSITE_CUT_ID,
                cwd,
            )
            .await
            {
                Ok(image_path) => {
                    let _ = app.emit(
                        EVENT_CHARACTER_SHEET,
                        CharacterSheetEvent::CutCompleted {
                            run_id: run_id.clone(),
                            cut_id: COMPOSITE_CUT_ID.into(),
                            role: COMPOSITE_ROLE.into(),
                            image_path: image_path.to_string_lossy().into_owned(),
                        },
                    );
                }
                Err(err) => {
                    tracing::warn!(target: "codex.character_sheet", "composite sheet failed: {err}");
                    let _ = app.emit(
                        EVENT_CHARACTER_SHEET,
                        CharacterSheetEvent::CutFailed {
                            run_id: run_id.clone(),
                            cut_id: COMPOSITE_CUT_ID.into(),
                            reason: err,
                        },
                    );
                }
            }
        }
        CharacterSheetGenerationMode::MultiCut => {
            // 従来の複数カット生成。表情差分が利用するため、並列処理をそのまま維持する。
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
                    let event_run_id = run_id.clone();
                    // 2026-07-27: 各カットのクロージャへ渡すため複製する
                    let state = state.inner_clone();
                    async move {
                        let _ = app.emit(
                            EVENT_CHARACTER_SHEET,
                            CharacterSheetEvent::CutStarted {
                                run_id: event_run_id.clone(),
                                cut_id: cut.cut_id.clone(),
                                role: cut.role.clone(),
                                index: index as u32,
                            },
                        );
                        let prompt = build_sheet_prompt(&cut, &aspect_ratio, &attributes);
                        match generate_one_cut(
                            &app,
                            &state,
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
                                        run_id: event_run_id.clone(),
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
                                        run_id: event_run_id.clone(),
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
        }
    }

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
    if params.generation_mode == CharacterSheetGenerationMode::MultiCut {
        if params.cut_specs.is_empty() {
            return Err("生成するカットが1個も選択されていません".into());
        }
        if params.cut_specs.len() > MAX_SHEET_CUTS {
            return Err(format!(
                "カット数が上限 {MAX_SHEET_CUTS} を超えています ({} 個)",
                params.cut_specs.len()
            ));
        }
    }
    Ok(())
}

fn build_composite_character_sheet_prompt(attributes: &str) -> String {
    if attributes.trim().is_empty() {
        return COMPOSITE_CHARACTER_SHEET_PROMPT.to_string();
    }
    format!(
        "{COMPOSITE_CHARACTER_SHEET_PROMPT}\n\n追加の見た目指定: {}",
        attributes.trim()
    )
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
