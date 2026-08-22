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
use crate::commands::gen_queue;
use crate::commands::gen_worker::{
    generate_one_cut_for_run, generate_one_cut_for_run_with_slot_hook, short_id, timestamp_id,
    SlotHook,
};
use crate::commands::storage::{project_name_from_cwd, resolve_output_dir, StorageSettings};
use crate::events::EVENT_CHARACTER_SHEET;
use crate::state::AppState;

/// カタログ上限。フロント側 DEFAULT_SHEET(10) / 詳しく(14) を安全に収める。
/// gen_queue::GLOBAL_GEN_SEMAPHORE(上限6)が同時実行を絞るので枚数自体は安全。
const MAX_SHEET_CUTS: usize = 30;

const COMPOSITE_CUT_ID: &str = "character-sheet";
const COMPOSITE_ROLE: &str = "character-sheet";

/// 参照画像の上限。フロント側 MAX_CHARACTER_REFERENCE_IMAGES(6) と一致させる二重柵。
const MAX_CHARACTER_REFERENCE_IMAGES: usize = 6;

/// 「自分で作る」プロンプトの上限文字数。
/// フロント側 MAX_CUSTOM_SHEET_PROMPT_CHARS(8000) と一致させる二重柵。
const MAX_CUSTOM_SHEET_PROMPT_CHARS: usize = 8000;

/// 参照 1 枚のときの composite プロンプト冒頭。
/// 旧 COMPOSITE_CHARACTER_SHEET_PROMPT の第 1 段落そのまま(1 枚時のバイト一致を守る)。
const COMPOSITE_SHEET_PROMPT_INTRO_SINGLE: &str = r#"役割:
あなたはプロのキャラクターデザイナー兼コンセプトアーティストです。添付した参考画像1枚のキャラクターを、商業作品で使用できる品質のキャラクターシートに再構築してください。原画の造形・配色・衣装・小物・世界観のディテールは一切変えず、忠実に保持してください。"#;

/// 参照 2 枚以上のときの composite プロンプト冒頭。
/// 2026-08-03 STΛCK実機フィードバックで改訂: 旧文言「2枚目以降は補助資料としてのみ使う・
/// 食い違いは常に1枚目優先」だとモデルがサブ参照をほぼ無視した(2枚付けてもサブの要素が
/// 全く入らない実測)。同一性の基準(顔・体格)は1枚目に固定しつつ、サブの特徴的要素は
/// 「必ず取り込む」と能動的に指示する。
const COMPOSITE_SHEET_PROMPT_INTRO_MULTI: &str = r#"役割:
あなたはプロのキャラクターデザイナー兼コンセプトアーティストです。添付した複数枚の参考画像はすべて同一キャラクターです。このキャラクターを、商業作品で使用できる品質のキャラクターシートに再構築してください。原画の造形・配色・衣装・小物・世界観のディテールは一切変えず、忠実に保持してください。

参考画像の扱い(全枚数を必ず反映):
・1枚目がキャラクター同一性の基準。顔立ち・体格・画風は必ず1枚目に合わせる。
・2枚目以降の参考画像も必ず反映する。各画像から特徴的な要素(衣装・小物・装備・髪型・配色・模様・質感など)を読み取り、三面図本体やディテールインセットに取り込む。
・同じ部位の描写が食い違う場合、顔立ち・体格は1枚目を優先し、衣装・小物・装備はその要素が最も詳しく描かれている参考画像を採用する。
・どの参考画像の要素も無視しない。取り込んだ要素がどの画像由来か分かる必要はないが、全画像の情報がシートに現れていること。"#;

/// intro の後に続く共通本文の前半。旧定数の「出力スタイル:」から
/// 上段見出し行(改行含む)まで。この直後に背景行を差し込む。
const COMPOSITE_SHEET_PROMPT_BODY_BEFORE_BG: &str = r#"出力スタイル:添付した写真通り

出力構成
1枚の縦長レイアウト(アスペクト比 3:4)で、上下2段構成にしてください。
上段:リファレンスシート(全身三面図+アセット詳細)
"#;

/// 既定シートの背景行(4択)。Auto は旧実装の 1 行とバイト一致であること
/// (composite_prompt_single_auto_is_byte_identical_to_legacy が固定する)。
const COMPOSITE_SHEET_BG_LINE_AUTO: &str =
    "・背景はニュートラルなオフホワイト(淡いベージュ系)で統一";
const COMPOSITE_SHEET_BG_LINE_WHITE: &str = "・背景は完全な純白の無地で統一 (plain solid uniform pure white background, exact #FFFFFF / RGB 255,255,255, no gradation, no texture, no shadows cast on the background)。「追加の見た目指定」に別の背景指定があってもこの背景色を優先する";
const COMPOSITE_SHEET_BG_LINE_GREEN: &str = "・背景はクロマキー合成用の均一なグリーンバックで統一 (solid uniform chroma key green background, exact #00FF00 / RGB 0,255,0, evenly lit, no gradation, no shadows cast on the background)。「追加の見た目指定」に別の背景指定があってもこの背景色を優先する";
const COMPOSITE_SHEET_BG_LINE_BLUE: &str = "・背景はクロマキー合成用の均一なブルーバックで統一 (solid uniform chroma key blue background, exact #0000FF / RGB 0,0,255, evenly lit, no gradation, no shadows cast on the background)。「追加の見た目指定」に別の背景指定があってもこの背景色を優先する";

/// 背景行の直後〜下段見出しの直前まで (上段の中身)。
/// 旧定数の「・全身の三面図を…」から「・各インセットには…」までそのまま。
const COMPOSITE_SHEET_PROMPT_BODY_UPPER: &str = r#"・全身の三面図を等身を揃え、共通の地平線で水平に整列配置
└ Front View(正面・全身)
└ Side Profile (L)(左側面・全身)
└ Back View(背面・全身)
・各ビューの下に英語ラベルを小さく入れる
・三面図と重ならない上部中央またはサイドの余白に、以下2つのインセットボックスを配置
└ Head Detail:頭部のクローズアップ(別状態・別表情のバリエーションを含む)
└ Costume / Pattern Detail:衣装の柄・テクスチャ・ロゴの拡大
・右下隅にカラーパレットのスウォッチ(主要色を5〜7色、四角いタイル状に小さく並べる)
・各インセットには英語の小見出しと簡潔な説明文を1〜2行添える"#;

/// 下段ブロック (Auto)。環境シーン前提の従来文言。
/// Auto 選択時は旧実装とバイト一致すること
/// (composite_prompt_single_auto_is_byte_identical_to_legacy が固定する)。
const COMPOSITE_SHEET_LOWER_AUTO: &str = r#"下段:シーンショット(シネマティック・横並び2カット)
キャラクターを原画の世界観に沿った環境内に配置し、劇場映画のキービジュアル風にドラマティックな光と影で演出してください。横並びの2カット構成です。
左カット:顔(または頭部)のエクストリーム・クローズアップ
・キャラクターの最も象徴的な顔・頭部の特徴をフレームいっぱいに切り取る
・表情・造形ディテール・素材感を強調
・背景は最小限、または暗めにフェードさせて顔を主役にする
右カット:背景が写っている全身ショット
・立位または座位で、キャラクターの世界観・空気感が伝わる背景込みの構図
・ロケーションが読み取れるだけの引き(全身がフレームに収まる)
・小物や環境ディテールも一緒に映り込ませる
・2カットでカメラアングルに変化をつける(クローズアップは正面・アイレベル寄り、全身は俯瞰/ローアングル/横位置など)"#;

/// 下段ブロック (白/Green/Blue 選択時)。
///
/// 2026-08-03 STΛCK実機フィードバック (B6): 背景色を選んでも上段しか
/// 差し替わらず、下段が環境シーンのまま残っていた。「背景を白にする」と
/// 言われて画像の半分が環境のままなのは仕様の取り違え。**指定色は画像全体に
/// 適用する**のが正しい。下段も同じソリッド背景の 2 カットに置き換える。
///
/// シネマティック演出 (環境・演出光・映り込み) は明示的に禁止する。
/// 文言に「シネマティック」を残すとモデルが環境を描き足すため、語自体を落とす
/// (composite_prompt_non_auto_lower_has_no_cinematic が固定する)。
const COMPOSITE_SHEET_LOWER_SOLID: &str = r#"下段:キャラクターカット(横並び2カット・背景は上段と同じ指定色のソリッド背景)
左カット:顔(または頭部)のクローズアップ。表情・造形ディテール・素材感を強調する。背景は指定色のソリッドのみで、環境・小物・演出光の映り込みは禁止。
右カット:全身の立ち絵。キャラクター全身がフレームに収まるニュートラルな立ちポーズ。背景は指定色のソリッドのみで、地面の影・環境・小物の映り込みは禁止。
・2カットとも背景は上段と完全に同じ指定色で統一すること"#;

/// 下段ブロックの後の共通本文 (「ビジュアル原則」の 1 行目を除く)。
const COMPOSITE_SHEET_PROMPT_BODY_TAIL_HEAD: &str = "ビジュアル原則\n";

/// 「ビジュアル原則」1 行目 (Auto)。下段が環境シーンである前提の文言。
const COMPOSITE_SHEET_PRINCIPLE_LOWER_AUTO: &str =
    "・上段は資料的で整然とした構図、下段はシネマティックでドラマティックな構図";
/// 「ビジュアル原則」1 行目 (非 Auto)。下段もソリッド背景であることと矛盾させない。
const COMPOSITE_SHEET_PRINCIPLE_LOWER_SOLID: &str =
    "・上段・下段とも資料的で整然とした構図で、背景は全カット指定色のソリッドに統一する";

/// 「変更してよい要素」の背景行 (Auto)。世界観の範囲で背景を変えてよい。
const COMPOSITE_SHEET_MUTABLE_BG_AUTO: &str = "・背景の細部(世界観の範囲内で)";
/// 「変更してよい要素」の背景行 (非 Auto)。背景は変更対象から外す。
const COMPOSITE_SHEET_MUTABLE_BG_SOLID: &str =
    "・(背景は変更不可。上下段とも指定色のソリッドで統一する)";

/// 「ビジュアル原則」2 行目以降〜末尾の共通本文。
/// 背景行 (変更してよい要素) だけは Auto / 非 Auto で差し替えるため、
/// その直前までを HEAD、直後を TAIL に分ける。
const COMPOSITE_SHEET_PROMPT_BODY_TAIL_BEFORE_MUTABLE_BG: &str = r#"・上段と下段は「スタイル指定」で書いた1つのスタイルで全体を統一すること(混在禁止)
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
"#;

const COMPOSITE_SHEET_PROMPT_BODY_TAIL_AFTER_MUTABLE_BG: &str = r#"禁止事項
・原画にない衣装や装飾の追加
・体型・年齢・人種の改変
・「スタイル指定」で記入したスタイル以外の描画方式が混入すること
・参考画像と異なる配色への置き換え
・ロゴ・シンボル・固有モチーフの省略や改変"#;

/// 「自分で作る」モードの背景行。ユーザープロンプトより優先する旨を明記する。
///
/// 2026-08-03 (B6): 適用範囲が**画像全体**であることを明記した。
/// 既定シート側で下段まで指定色に統一した (COMPOSITE_SHEET_LOWER_SOLID) のと
/// 同じ意図で、custom 側でもユーザーが複数カットを指示したときに一部だけ
/// 環境背景で描かれるのを防ぐ。
///
/// 2026-08-03 r3 (B6): 「画像全体に適用する」だけでは、モデルが環境・小物・
/// 地面の影・演出光の映り込みを描き足した (指定色は守るが背景が汚れる)。
/// COMPOSITE_SHEET_LOWER_SOLID と同じ禁止句を 3 色すべてに明示する。
const CUSTOM_SHEET_BG_SOLID_SUFFIX: &str = "環境・小物・地面の影・演出光の映り込みは描かない。画像全体(下段のカットを含む)の背景をこの指定色のソリッドで統一する。";

const CUSTOM_SHEET_BG_LINE_WHITE: &str = "・背景は必ず純白の無地にする (plain solid uniform pure white background, exact #FFFFFF / RGB 255,255,255, no gradation, no texture)。上のプロンプトに別の背景指定があってもこの背景色を優先する。これはシーンショットを含む画像全体の背景に適用する。環境・小物・地面の影・演出光の映り込みは描かない。画像全体(下段のカットを含む)の背景をこの指定色のソリッドで統一する。";
const CUSTOM_SHEET_BG_LINE_GREEN: &str = "・背景は必ずクロマキー合成用の均一なグリーンバックにする (solid uniform chroma key green background, exact #00FF00 / RGB 0,255,0, evenly lit, no shadows cast on the background)。上のプロンプトに別の背景指定があってもこの背景色を優先する。これはシーンショットを含む画像全体の背景に適用する。環境・小物・地面の影・演出光の映り込みは描かない。画像全体(下段のカットを含む)の背景をこの指定色のソリッドで統一する。";
const CUSTOM_SHEET_BG_LINE_BLUE: &str = "・背景は必ずクロマキー合成用の均一なブルーバックにする (solid uniform chroma key blue background, exact #0000FF / RGB 0,0,255, evenly lit, no shadows cast on the background)。上のプロンプトに別の背景指定があってもこの背景色を優先する。これはシーンショットを含む画像全体の背景に適用する。環境・小物・地面の影・演出光の映り込みは描かない。画像全体(下段のカットを含む)の背景をこの指定色のソリッドで統一する。";

/// シート背景色 (STΛCK 2026-08-03 確定仕様の4択)。
/// Auto = 既定(背景句を差し替えない = 既定テンプレのオフホワイト / custom はプロンプト準拠)。
/// Green = グリーンバック #00FF00 / Blue = ブルーバック #0000FF (クロマキー標準値)。
#[derive(Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SheetBackground {
    #[default]
    Auto,
    White,
    Green,
    Blue,
}

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
    /// 参照画像 (メイン 1 枚)。character_images が空のときのフォールバック元。
    pub character_image: String,
    /// 参照画像の全量。[0] がメイン(同一性の正)。
    /// 空なら character_image 1 枚にフォールバックする(後方互換: 旧フロント・
    /// 表情差分・regenerate_cut は従来どおり単数だけを送ってくる)。
    #[serde(default)]
    pub character_images: Vec<String>,
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
    /// シート背景色。composite 経路でのみ使用。省略時 Auto(従来挙動)。
    #[serde(default)]
    pub sheet_background: SheetBackground,
    /// 自分で作るモードのプロンプト全文。trim 後非空なら既定テンプレの代わりに使う。
    /// multi-cut 経路(表情差分)・regenerate_cut では読まない。
    #[serde(default)]
    pub custom_prompt: String,
    /// 選択式テンプレートの任意プロンプト上書き。未指定なら従来経路をそのまま使う。
    #[serde(default)]
    pub sheet_prompt_override: Option<String>,
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
    // 同じIDを明示再利用した場合、前回のキャンセル印を新runへ持ち越さない
    // (他の run 統括コマンドと同じ扱い。ここだけ抜けていたため、一度中止すると
    // 印が TTL 24時間残り、同じ run_id の再生成が即「キャンセルされました」で死んでいた)。
    gen_queue::clear_cancelled(&run_id);
    // 実行中 run 台帳への登録。invoke が返った瞬間からフロントは run_id を知るので、
    // spawn より前に登録する。guard は task へ move し、orchestrator 終了時に外れる。
    let active_run = gen_queue::ActiveRunGuard::begin(&run_id);
    let task_run_id = run_id.clone();

    let fail_run_id = run_id.clone();
    let fail_cut_id = match params.generation_mode {
        CharacterSheetGenerationMode::Composite => COMPOSITE_CUT_ID,
        CharacterSheetGenerationMode::MultiCut => "unknown",
    };
    // 2026-07-27: 常駐 app-server 経路 (gen_worker) へ渡すため state を複製する
    let task_state = state.inner_clone();
    tokio::spawn(async move {
        // guard を task 内へ move する。この async ブロックが終わる時点で Drop され、
        // 実行中 run 台帳から外れる。
        let _active_run = active_run;
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

/// `character_sheet_regenerate_cut` の composite 迂回ガード。
///
/// 本体が `AppHandle`/`State` を要求してユニットテストから呼べないため、判定だけを
/// 純関数に切り出す（テストが判定式のコピーでなく実物を検査できるようにする）。
fn reject_composite_regenerate(params: &CharacterSheetParams) -> Result<(), String> {
    if matches!(
        params.generation_mode,
        CharacterSheetGenerationMode::Composite
    ) {
        return Err(
            "1枚シート(composite)の再生成はこの経路では行えません。シート生成をやり直してください。"
                .to_string(),
        );
    }
    Ok(())
}

/// 単一カット再生成。検品で落ちた/破綻したカットだけ再度1枚生成して再emitする。
///
/// composite（1枚シート）は対象外。composite の作り直しは通常オーケストレーター
/// (`character_sheet_generate`) を通り、そこで受領時の規格正規化ゲートを通過する。
/// この関数にはそのゲートが無いため、composite を受けると**正規化を迂回した
/// 未検査シート**が出てしまう。「フロントが呼ばない」という散文でなく、
/// 公開コマンドの入口で構造的に拒否する。
#[tauri::command]
pub async fn character_sheet_regenerate_cut(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    cut_id: String,
    params: CharacterSheetParams,
) -> Result<String, String> {
    reject_composite_regenerate(&params)?;

    let codex_home_orig = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;

    let codex_bin =
        resolve_codex_cli_binary().map_err(|e| format!("Codex CLI の解決に失敗: {e}"))?;

    // 再生成は元 run と同じ run_id を使い回す。登録しないと「再生成中に中止 →
    // found:false の嘘」になるので、元 run と同じく実行中 run 台帳へ載せる。
    // 新しい生成意図は古い中止を上書きする。
    gen_queue::clear_cancelled(&run_id);
    let active_run = gen_queue::ActiveRunGuard::begin(&run_id);

    // run 本体と同じ解決規則を使う(表情差分は単数だけ送ってくるので挙動不変)。
    let reference_paths: Vec<PathBuf> = resolve_reference_images(&params)
        .into_iter()
        .map(PathBuf::from)
        .collect();
    if reference_paths.len() > MAX_CHARACTER_REFERENCE_IMAGES {
        return Err(format!(
            "参照画像は最大{MAX_CHARACTER_REFERENCE_IMAGES}枚までです ({} 枚指定されています)",
            reference_paths.len()
        ));
    }
    for path in &reference_paths {
        if !path.is_file() {
            return Err(format!("参照画像が見つかりません: {}", path.display()));
        }
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
    // 1カット再生成も本体と同じ背景色で焼く。ここが Auto 固定だと、
    // クロマキー運用で「作り直した1枚だけグレー背景」になり抜けなくなる。
    let sheet_background = params.sheet_background;
    let event_run_id = run_id.clone();

    tokio::spawn(async move {
        // guard を task へ move する。この 1 カット再生成が終わるまでを
        // 「実行中 run」とみなす (中止ボタンが効く窓と一致させる)。
        let _active_run = active_run;
        let prompt = build_sheet_prompt(&cut, &aspect_ratio, &attributes, sheet_background);
        // 生成/複数カットと同じく、枠 (セマフォ) を取った直後に emit する。
        // 1カット再生成も枠を奪い合う経路なので、ここだけ枠取得前に emit すると
        // 「作り直し中」が枠待ちの間ずっと嘘になる。
        let emit_app = task_app.clone();
        let emit_run_id = event_run_id.clone();
        let emit_cut_id = cut.cut_id.clone();
        let emit_role = cut.role.clone();
        let slot_hook_fn = move || {
            let _ = emit_app.emit(
                EVENT_CHARACTER_SHEET,
                CharacterSheetEvent::CutStarted {
                    run_id: emit_run_id.clone(),
                    cut_id: emit_cut_id.clone(),
                    role: emit_role.clone(),
                    index: 0,
                },
            );
        };
        let slot_hook = SlotHook::new(&slot_hook_fn);
        match generate_one_cut_for_run_with_slot_hook(
            &task_app,
            &task_state,
            &codex_bin,
            &codex_home_orig,
            &prompt,
            &reference_paths,
            &out_dir,
            &cut.cut_id,
            cwd,
            Some(event_run_id.as_str()),
            &slot_hook,
        )
        .await
        {
            Ok(image_path) => {
                // S1b: 受領時の軽量検品。単一カット再生成もオーケストレーターと同じく
                // 生成側の fs::copy をそのまま信じていたので、同じゲートを通す。
                match crate::images::receipt_check::ensure_decodable(&image_path) {
                    Ok(()) => {
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
                    Err(reason) => {
                        tracing::warn!(
                            target: "codex.character_sheet",
                            "regenerate_cut receipt check failed: {reason}"
                        );
                        let _ = task_app.emit(
                            EVENT_CHARACTER_SHEET,
                            CharacterSheetEvent::CutFailed {
                                run_id: event_run_id,
                                cut_id: cut.cut_id,
                                reason,
                            },
                        );
                    }
                }
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

    // 解決済みの参照画像全量。[0] がメイン(同一性の正)。
    let reference_paths: Vec<PathBuf> = resolve_reference_images(&params)
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let aspect_ratio = params.aspect_ratio.clone();
    let attributes = params.attributes.clone();
    let cwd = params.cwd.clone();

    match params.generation_mode {
        CharacterSheetGenerationMode::Composite => {
            // CutStarted は「このカットが本当に動き始めた」通知にする。
            //
            // 枠取得 (セマフォ) は generate_one_cut_for_run の内側で起きるため、
            // ここで枠を先取りして順序を作ることはできない (外で1枚・内で1枚の
            // 二重取得になり、上限ぶん外側で埋めた瞬間に内側が誰も取れず全停止する)。
            // そこで permit を取る側から SlotHook で折り返してもらい、**枠を取った
            // 直後**にこの emit を走らせる。枠待ちのカットが「生成中」に見えていた
            // のを塞ぐ (Sol 評価: 枠取得前 emit)。
            let emit_app = app.clone();
            let emit_run_id = run_id.clone();
            let slot_hook_fn = move || {
                let _ = emit_app.emit(
                    EVENT_CHARACTER_SHEET,
                    CharacterSheetEvent::CutStarted {
                        run_id: emit_run_id.clone(),
                        cut_id: COMPOSITE_CUT_ID.into(),
                        role: COMPOSITE_ROLE.into(),
                        index: 0,
                    },
                );
            };
            let slot_hook = SlotHook::new(&slot_hook_fn);
            // 選択式テンプレートの override を最優先し、無ければ従来の custom_prompt、
            // どちらも空なら規定シートにする。正規化ゲートも同じ判定を使う。
            let prompt_override = params
                .sheet_prompt_override
                .as_deref()
                .filter(|prompt| !prompt.trim().is_empty());
            let is_default_template =
                prompt_override.is_none() && params.custom_prompt.trim().is_empty();
            let prompt = match prompt_override {
                Some(override_prompt) => {
                    build_custom_character_sheet_prompt(override_prompt, params.sheet_background)
                }
                None if is_default_template => build_composite_character_sheet_prompt(
                    &attributes,
                    reference_paths.len(),
                    params.sheet_background,
                ),
                None => {
                    build_custom_character_sheet_prompt(&params.custom_prompt, params.sheet_background)
                }
            };
            match generate_one_cut_for_run_with_slot_hook(
                &app,
                &state,
                &codex_bin,
                &codex_home_orig,
                &prompt,
                &reference_paths,
                &out_dir,
                COMPOSITE_CUT_ID,
                cwd,
                Some(run_id.as_str()),
                &slot_hook,
            )
            .await
            {
                Ok(image_path) => {
                    // 受領時正規化。既定テンプレは 3:4 固定契約なので規格 1080×1440 へ
                    // contain 正規化する。custom は「アスペクト比の指定があればそれに従い」
                    // という契約でユーザーが別比率を明示できるため素通しする。
                    let normalized: Result<(), String> = if is_default_template {
                        crate::images::sheet_normalize::normalize_sheet_or_salvage(&image_path)
                    } else {
                        Ok(())
                    };
                    match normalized {
                        Ok(()) => {
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
                        Err(reason) => {
                            tracing::warn!(
                                target: "codex.character_sheet",
                                "composite sheet normalize failed: {reason}"
                            );
                            let _ = app.emit(
                                EVENT_CHARACTER_SHEET,
                                CharacterSheetEvent::CutFailed {
                                    run_id: run_id.clone(),
                                    cut_id: COMPOSITE_CUT_ID.into(),
                                    reason,
                                },
                            );
                        }
                    }
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
                    let reference_paths = reference_paths.clone();
                    let out_dir = out_dir.clone();
                    let aspect_ratio = aspect_ratio.clone();
                    let attributes = attributes.clone();
                    let cwd = cwd.clone();
                    let cut = cut.clone();
                    // 背景色は Copy なのでクローン不要だが、aspect_ratio / attributes と
                    // 同じくクロージャへ move する (S0: マルチカットに背景色を届ける)。
                    let sheet_background = params.sheet_background;
                    let event_run_id = run_id.clone();
                    // 2026-07-27: 各カットのクロージャへ渡すため複製する
                    let state = state.inner_clone();
                    async move {
                        // composite 側と同じく、枠 (セマフォ) を取った直後に折り返して
                        // もらってから emit する。複数カットは並列で走るので、枠待ちの
                        // カットまで先に「生成中」と言うと k/N が実態から最も離れる。
                        let emit_app = app.clone();
                        let emit_run_id = event_run_id.clone();
                        let emit_cut_id = cut.cut_id.clone();
                        let emit_role = cut.role.clone();
                        let slot_hook_fn = move || {
                            let _ = emit_app.emit(
                                EVENT_CHARACTER_SHEET,
                                CharacterSheetEvent::CutStarted {
                                    run_id: emit_run_id.clone(),
                                    cut_id: emit_cut_id.clone(),
                                    role: emit_role.clone(),
                                    index: index as u32,
                                },
                            );
                        };
                        let slot_hook = SlotHook::new(&slot_hook_fn);
                        let prompt =
                            build_sheet_prompt(&cut, &aspect_ratio, &attributes, sheet_background);
                        match generate_one_cut_for_run_with_slot_hook(
                            &app,
                            &state,
                            &codex_bin,
                            &codex_home_orig,
                            &prompt,
                            &reference_paths,
                            &out_dir,
                            &cut.cut_id,
                            cwd,
                            Some(event_run_id.as_str()),
                            &slot_hook,
                        )
                        .await
                        {
                            Ok(image_path) => {
                                // S1b: 受領時の軽量検品。生成側は fs::copy でパスを
                                // 返すだけで中身を一度もデコードしないため、0バイト・
                                // 切り詰めでも「成功」で UI へ出てしまう。壊れていないか
                                // だけを見る（規格への正規化はしない: 設計 §1.8）。
                                match crate::images::receipt_check::ensure_decodable(&image_path) {
                                    Ok(()) => {
                                        let _ = app.emit(
                                            EVENT_CHARACTER_SHEET,
                                            CharacterSheetEvent::CutCompleted {
                                                run_id: event_run_id.clone(),
                                                cut_id: cut.cut_id.clone(),
                                                role: cut.role.clone(),
                                                image_path: image_path
                                                    .to_string_lossy()
                                                    .into_owned(),
                                            },
                                        );
                                    }
                                    Err(reason) => {
                                        tracing::warn!(
                                            target: "codex.character_sheet",
                                            "cut {} receipt check failed: {reason}",
                                            cut.cut_id
                                        );
                                        let _ = app.emit(
                                            EVENT_CHARACTER_SHEET,
                                            CharacterSheetEvent::CutFailed {
                                                run_id: event_run_id.clone(),
                                                cut_id: cut.cut_id.clone(),
                                                reason,
                                            },
                                        );
                                    }
                                }
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

/// 実際に codex へ渡す参照画像リストを決める。
/// character_images が非空ならそれを、空なら character_image 1 枚を使う。
fn resolve_reference_images(params: &CharacterSheetParams) -> Vec<String> {
    if !params.character_images.is_empty() {
        return params.character_images.clone();
    }
    vec![params.character_image.clone()]
}

fn validate_params(params: &CharacterSheetParams) -> Result<(), String> {
    let references = resolve_reference_images(params);
    if references.is_empty() || references.iter().all(|p| p.trim().is_empty()) {
        return Err("characterImage must not be empty".into());
    }
    if references.len() > MAX_CHARACTER_REFERENCE_IMAGES {
        return Err(format!(
            "参照画像は最大{MAX_CHARACTER_REFERENCE_IMAGES}枚までです ({} 枚指定されています)",
            references.len()
        ));
    }
    for path in &references {
        if path.trim().is_empty() {
            return Err("characterImage must not be empty".into());
        }
        if !Path::new(path).is_file() {
            return Err(format!("参照画像が見つかりません: {path}"));
        }
    }
    // multi-cut 経路では custom_prompt は常に空なので、経路を問わず一律で検査してよい。
    if params.custom_prompt.chars().count() > MAX_CUSTOM_SHEET_PROMPT_CHARS {
        return Err(format!(
            "自分で作るプロンプトが長すぎます (上限{MAX_CUSTOM_SHEET_PROMPT_CHARS}文字、現在 {} 文字)",
            params.custom_prompt.chars().count()
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

/// composite プロンプトを組み立てる。
/// ref_count <= 1 かつ background=Auto のときは旧 COMPOSITE_CHARACTER_SHEET_PROMPT と
/// バイト一致する (単体テスト composite_prompt_single_auto_is_byte_identical_to_legacy で固定)。
fn build_composite_character_sheet_prompt(
    attributes: &str,
    ref_count: usize,
    background: SheetBackground,
) -> String {
    let intro = if ref_count <= 1 {
        COMPOSITE_SHEET_PROMPT_INTRO_SINGLE
    } else {
        COMPOSITE_SHEET_PROMPT_INTRO_MULTI
    };
    let bg_line = match background {
        SheetBackground::Auto => COMPOSITE_SHEET_BG_LINE_AUTO,
        SheetBackground::White => COMPOSITE_SHEET_BG_LINE_WHITE,
        SheetBackground::Green => COMPOSITE_SHEET_BG_LINE_GREEN,
        SheetBackground::Blue => COMPOSITE_SHEET_BG_LINE_BLUE,
    };
    // 背景色を明示指定したときは **下段 (シーンショット) も同じソリッド背景**に
    // 差し替える (B6 2026-08-03 STΛCK実機フィードバック)。上段だけ差し替えると
    // 「白背景にしたのに画像の下半分が環境シーンのまま」になる。
    // Auto は従来どおり環境シーンで、旧実装とバイト一致を保つ。
    let is_auto = background == SheetBackground::Auto;
    let (lower, principle_lower, mutable_bg) = if is_auto {
        (
            COMPOSITE_SHEET_LOWER_AUTO,
            COMPOSITE_SHEET_PRINCIPLE_LOWER_AUTO,
            COMPOSITE_SHEET_MUTABLE_BG_AUTO,
        )
    } else {
        (
            COMPOSITE_SHEET_LOWER_SOLID,
            COMPOSITE_SHEET_PRINCIPLE_LOWER_SOLID,
            COMPOSITE_SHEET_MUTABLE_BG_SOLID,
        )
    };
    let base = format!(
        "{intro}\n\n{COMPOSITE_SHEET_PROMPT_BODY_BEFORE_BG}{bg_line}\n\
         {COMPOSITE_SHEET_PROMPT_BODY_UPPER}\n\
         {lower}\n\
         {COMPOSITE_SHEET_PROMPT_BODY_TAIL_HEAD}\
         {principle_lower}\n\
         {COMPOSITE_SHEET_PROMPT_BODY_TAIL_BEFORE_MUTABLE_BG}\
         {mutable_bg}\n\
         {COMPOSITE_SHEET_PROMPT_BODY_TAIL_AFTER_MUTABLE_BG}"
    );
    if attributes.trim().is_empty() {
        return base;
    }
    format!("{base}\n\n追加の見た目指定: {}", attributes.trim())
}

/// 「自分で作る」モードのプロンプトを組み立てる。
/// ユーザープロンプトが本文(先頭)で、システムはパイプライン成立に必要な最小の
/// 制作条件だけを末尾に足す。テンプレート(INTRO/BODY/属性)は一切使わない。
fn build_custom_character_sheet_prompt(custom_prompt: &str, background: SheetBackground) -> String {
    let bg_line = match background {
        SheetBackground::Auto => None,
        SheetBackground::White => Some(CUSTOM_SHEET_BG_LINE_WHITE),
        SheetBackground::Green => Some(CUSTOM_SHEET_BG_LINE_GREEN),
        SheetBackground::Blue => Some(CUSTOM_SHEET_BG_LINE_BLUE),
    };
    let base = format!(
        "{}\n\n制作条件(システム指定):\n\
         ・添付した参考画像を必ず参照する。\n\
         ・image_gen ツールを1回だけ呼び出し、画像を1枚だけ生成する。上のプロンプトに枚数の指定があっても1枚だけにする。high quality で生成する。\n\
         ・上のプロンプトにアスペクト比の指定があればそれに従い、無ければ縦長 3:4 で生成する。",
        custom_prompt.trim()
    );
    match bg_line {
        Some(line) => format!("{base}\n{line}"),
        None => base,
    }
}

/// マルチカット経路の厳守事項4 (背景指定)。Auto は旧実装の 1 行とバイト一致であること
/// (sheet_prompt_auto_keeps_legacy_background_line が固定する)。
///
/// 背景色を明示指定したときは composite 側の定型句 (COMPOSITE_SHEET_BG_LINE_*) を
/// そのまま流用する。マルチカットは 1 カット 1 枚なので「上段/下段」の区別が無く、
/// composite の背景句がそのまま意味を持つ。
const SHEET_BG_LINE_AUTO: &str = "背景は無地の淡いグレー、フラットで均一なライティングに揃える。背景・光も参照画像と同じ画風で描き、実写のスタジオ写真風にしない。シートとして並べたときに背景・光が一貫するようにする。";

/// シートカット用のプロンプトを組み立てる。build_multiangle_prompt とは主眼が違い、
/// (1) 全カット共通で不変の見た目属性を焼き込む (2) 表情カットでもアングルを大胆に変えず
/// 顔の同一性を最優先にする。3面図と表情シートの両方を1つのビルダで扱う。
///
/// `background` は生成時の背景色指定 (4択)。スタンプ等のクロマキー抜きは
/// 「Green で生成 → 決定論で #00FF00 を抜く」経路なので、ここで背景色が
/// 焼けないと後段のクロマキーが 1 枚も抜けない。Auto のときの出力文字列は
/// 旧実装と 1 バイトも変えない (既存3スキルの挙動を不変に保つ)。
fn build_sheet_prompt(
    cut: &SheetCutSpec,
    aspect_ratio: &str,
    attributes: &str,
    background: SheetBackground,
) -> String {
    let attributes_line = if attributes.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n- 不変の見た目 (全カット共通で厳守): {}\n",
            attributes.trim()
        )
    };
    // Auto は旧文言そのまま。明示指定時は composite と同じ背景定型句へ差し替える。
    // 先頭の "・" は composite 側の箇条書き記法なので、番号付きリストのここでは剥がす。
    let background_line = match background {
        SheetBackground::Auto => SHEET_BG_LINE_AUTO.to_string(),
        SheetBackground::White => COMPOSITE_SHEET_BG_LINE_WHITE
            .trim_start_matches('・')
            .to_string(),
        SheetBackground::Green => COMPOSITE_SHEET_BG_LINE_GREEN
            .trim_start_matches('・')
            .to_string(),
        SheetBackground::Blue => COMPOSITE_SHEET_BG_LINE_BLUE
            .trim_start_matches('・')
            .to_string(),
    };
    format!(
        "添付したキャラクター参照画像を使い、同一人物のリファレンスシート用に次の1枚を生成してください。\n\n\
         ## この画像の役割\n\
         - 指定 (英語): {prompt_fragment}\n{attributes_line}\n\
         ## 厳守事項\n\
         1. 参照画像の顔・骨格・髪・肌・体型・服を厳密に保持する。別人にしない。同一人物のリファレンスシートである。\n\
         1b. 参照画像の画風 (アートスタイル) も厳密に保持する。線・塗り・質感・頭身・デフォルメ度を参照画像と同じにする (same art style as the reference, keep the original drawing style)。アニメ調はアニメ調のまま、イラストはイラストのまま。実写化・写実化・別画風化しない (do not photorealize, do not change the art style)。\n\
         2. 上記「指定 (英語)」のショット距離・向き・表情を正確に反映する。表情を変える指定でも、顔の造作は変えず表情の筋肉だけを動かす (same face, change only the expression muscles)。\n\
         3. 顔ディテール等の寄り指定では、寄るだけで別人化しない (same identity, zoom in only)。\n\
         4. {background_line}\n\
         5. image_gen ツールを1回だけ呼び出す。\n\
         6. アスペクト比は必ず {aspect_ratio} にする (縦長指定なら縦長で。勝手に 16:9 にしない)。high quality で生成する。\n\
         7. 画面内テキスト、ロゴ、透かし、グリッド、コラージュ、複数パネルは禁止。1枚の単独画像にする。\n\
         8. 出力先指定や画像変換は不要です。生成画像は $CODEX_HOME/generated_images/<session>/ig_*.png に保存されます。\n\n\
         最終メッセージは OK または NG <理由> の1行のみ。",
        prompt_fragment = cut.prompt_fragment,
        attributes_line = attributes_line,
        background_line = background_line,
        aspect_ratio = aspect_ratio,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 複数参照対応(2026-08-03)より前の composite プロンプト全文。
    /// 実装側の定数を参照せずテスト側に固定で持つ。ここを実装から import すると
    /// 「実装を変えたらテストも一緒に変わる」自己言及になり、回帰検知の牙が抜ける。
    const LEGACY_COMPOSITE_PROMPT: &str = r#"役割:
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

    fn params_with(character_image: &str, character_images: &[&str]) -> CharacterSheetParams {
        CharacterSheetParams {
            character_image: character_image.to_string(),
            character_images: character_images.iter().map(|s| s.to_string()).collect(),
            attributes: String::new(),
            aspect_ratio: "3:4".into(),
            generation_mode: CharacterSheetGenerationMode::Composite,
            cut_specs: Vec::new(),
            cwd: None,
            run_id: None,
            sheet_background: SheetBackground::Auto,
            custom_prompt: String::new(),
            sheet_prompt_override: None,
        }
    }

    /// 旧実装の背景行。テスト側に固定で持ち、置換結果の照合に使う。
    const LEGACY_BG_LINE: &str = "・背景はニュートラルなオフホワイト(淡いベージュ系)で統一";

    /// 1 枚 × Auto のプロンプトが旧実装とバイト一致すること(後方互換の機械証明)。
    #[test]
    fn composite_prompt_single_auto_is_byte_identical_to_legacy() {
        assert_eq!(
            build_composite_character_sheet_prompt("", 1, SheetBackground::Auto),
            LEGACY_COMPOSITE_PROMPT
        );
        // 参照 0 枚(理論上の境界)も単数扱いで同じ文字列になる。
        assert_eq!(
            build_composite_character_sheet_prompt("", 0, SheetBackground::Auto),
            LEGACY_COMPOSITE_PROMPT
        );
        // attributes 追記のロジックも旧実装と同じ形を保つ。
        assert_eq!(
            build_composite_character_sheet_prompt("黒髪ロング", 1, SheetBackground::Auto),
            format!("{LEGACY_COMPOSITE_PROMPT}\n\n追加の見た目指定: 黒髪ロング")
        );
    }

    /// 白選択時は上段の背景行が置換され、下段もソリッド背景に差し替わること (B6)。
    #[test]
    fn composite_prompt_white_swaps_background_line() {
        let prompt = build_composite_character_sheet_prompt("", 1, SheetBackground::White);
        assert!(prompt.contains(COMPOSITE_SHEET_BG_LINE_WHITE));
        assert!(!prompt.contains(LEGACY_BG_LINE));
        assert!(prompt.contains("exact #FFFFFF"));
        // 上段の構成 (三面図・インセット・スウォッチ) は従来どおり残る。
        assert!(prompt.contains("・全身の三面図を等身を揃え、共通の地平線で水平に整列配置"));
        assert!(prompt.contains("└ Costume / Pattern Detail:衣装の柄・テクスチャ・ロゴの拡大"));
    }

    /// 参照複数 × グリーンバックで、INTRO_MULTI と GREEN 行が共存すること。
    #[test]
    fn composite_prompt_multi_green_keeps_intro_and_swaps_bg() {
        let prompt = build_composite_character_sheet_prompt("", 2, SheetBackground::Green);
        assert!(prompt.contains("1枚目がキャラクター同一性の基準"));
        assert!(prompt.contains(COMPOSITE_SHEET_BG_LINE_GREEN));
        assert!(prompt.contains("exact #00FF00"));
        assert!(!prompt.contains(LEGACY_BG_LINE));
    }

    /// 既定シート × ブルーバックで BODY に exact #0000FF が入り、オフホワイト行が消えること。
    #[test]
    fn composite_prompt_blue_contains_exact_hex() {
        let prompt = build_composite_character_sheet_prompt("", 1, SheetBackground::Blue);
        assert!(prompt.contains("exact #0000FF"));
        assert!(!prompt.contains(LEGACY_BG_LINE));
    }

    // ── B6 (2026-08-03 STΛCK実機FB): 非 Auto は下段も指定色のソリッド背景 ──

    /// 非 Auto では下段指示から「シネマティック」の語が消えること。
    /// 語が残るとモデルが環境・演出光を描き足し、下段だけ環境シーンに戻る。
    #[test]
    fn composite_prompt_non_auto_lower_has_no_cinematic() {
        for background in [
            SheetBackground::White,
            SheetBackground::Green,
            SheetBackground::Blue,
        ] {
            let prompt = build_composite_character_sheet_prompt("", 1, background);
            assert!(
                !prompt.contains("シネマティック"),
                "非 Auto の下段に「シネマティック」が残っている"
            );
            // 環境シーン前提の旧文言も残っていないこと。
            assert!(!prompt.contains("下段:シーンショット"));
            assert!(!prompt.contains("右カット:背景が写っている全身ショット"));
            assert!(!prompt.contains("・小物や環境ディテールも一緒に映り込ませる"));
            assert!(!prompt.contains(COMPOSITE_SHEET_MUTABLE_BG_AUTO));
        }
    }

    /// 非 Auto では下段が「上段と同じ指定色のソリッド背景」の 2 カットになること。
    #[test]
    fn composite_prompt_non_auto_lower_is_solid_background() {
        let prompt = build_composite_character_sheet_prompt("", 1, SheetBackground::Green);
        assert!(prompt.contains(COMPOSITE_SHEET_LOWER_SOLID));
        assert!(prompt.contains("・2カットとも背景は上段と完全に同じ指定色で統一すること"));
        // ビジュアル原則・変更してよい要素も矛盾しない文言に差し替わる。
        assert!(prompt.contains(COMPOSITE_SHEET_PRINCIPLE_LOWER_SOLID));
        assert!(prompt.contains(COMPOSITE_SHEET_MUTABLE_BG_SOLID));
        assert!(!prompt.contains(COMPOSITE_SHEET_PRINCIPLE_LOWER_AUTO));
    }

    /// Auto では下段が従来の環境シーンのままであること (バイト一致は別テストが固定)。
    #[test]
    fn composite_prompt_auto_lower_keeps_scene_shot() {
        let prompt = build_composite_character_sheet_prompt("", 1, SheetBackground::Auto);
        assert!(prompt.contains(COMPOSITE_SHEET_LOWER_AUTO));
        assert!(prompt.contains("下段:シーンショット(シネマティック・横並び2カット)"));
        assert!(prompt.contains(COMPOSITE_SHEET_PRINCIPLE_LOWER_AUTO));
        assert!(prompt.contains(COMPOSITE_SHEET_MUTABLE_BG_AUTO));
        assert!(!prompt.contains(COMPOSITE_SHEET_LOWER_SOLID));
    }

    /// 自分で作るモードはユーザープロンプトで始まり、テンプレを一切含まないこと。
    #[test]
    fn custom_prompt_is_verbatim_head() {
        let user = "  添付画像のキャラを横向きで1枚描いて  ";
        let prompt = build_custom_character_sheet_prompt(user, SheetBackground::Auto);
        assert!(prompt.starts_with("添付画像のキャラを横向きで1枚描いて"));
        assert!(!prompt.contains("役割:"));
        assert!(!prompt.contains("出力スタイル:添付した写真通り"));
        assert!(!prompt.contains("追加の見た目指定"));
        assert!(prompt.contains("制作条件(システム指定):"));
    }

    /// 自分で作る × 既定 では背景行を一切足さないこと(プロンプト完全準拠)。
    #[test]
    fn custom_prompt_auto_has_no_background_line() {
        let prompt = build_custom_character_sheet_prompt("好きに描いて", SheetBackground::Auto);
        assert!(!prompt.contains("背景は必ず"));
    }

    /// 自分で作る × ブルーバックで、優先句付きの背景行が末尾に付くこと。
    #[test]
    fn custom_prompt_blue_appends_priority_line() {
        let prompt = build_custom_character_sheet_prompt("好きに描いて", SheetBackground::Blue);
        assert!(prompt.ends_with(CUSTOM_SHEET_BG_LINE_BLUE));
        assert!(prompt.contains("exact #0000FF"));
        assert!(prompt.contains("上のプロンプトに別の背景指定があってもこの背景色を優先する。"));
        // B6: 適用範囲が画像全体であることを明記する。
        assert!(prompt.contains("これはシーンショットを含む画像全体の背景に適用する。"));
        // B6 r3: 環境・小物・影・演出光の禁止を明示する。
        assert!(prompt.contains(CUSTOM_SHEET_BG_SOLID_SUFFIX));
    }

    /// 自分で作る × 白で、優先句付きの背景行が末尾に付くこと (B5)。
    /// 設計書が求める 2 モード × 4 背景の全 8 通りを埋めるための 1 本。
    #[test]
    fn custom_prompt_white_appends_priority_line() {
        let prompt = build_custom_character_sheet_prompt("好きに描いて", SheetBackground::White);
        assert!(prompt.ends_with(CUSTOM_SHEET_BG_LINE_WHITE));
        assert!(prompt.contains("exact #FFFFFF"));
        assert!(prompt.contains("RGB 255,255,255"));
        assert!(prompt.contains("上のプロンプトに別の背景指定があってもこの背景色を優先する。"));
        assert!(prompt.contains("これはシーンショットを含む画像全体の背景に適用する。"));
        assert!(prompt.contains(CUSTOM_SHEET_BG_SOLID_SUFFIX));
        // 他色の背景行が混ざらないこと。
        assert!(!prompt.contains("exact #00FF00"));
        assert!(!prompt.contains("exact #0000FF"));
    }

    /// 自分で作る × グリーンバックで、優先句付きの背景行が末尾に付くこと (B5)。
    #[test]
    fn custom_prompt_green_appends_priority_line() {
        let prompt = build_custom_character_sheet_prompt("好きに描いて", SheetBackground::Green);
        assert!(prompt.ends_with(CUSTOM_SHEET_BG_LINE_GREEN));
        assert!(prompt.contains("exact #00FF00"));
        assert!(prompt.contains("RGB 0,255,0"));
        assert!(prompt.contains("上のプロンプトに別の背景指定があってもこの背景色を優先する。"));
        assert!(prompt.contains("これはシーンショットを含む画像全体の背景に適用する。"));
        assert!(prompt.contains(CUSTOM_SHEET_BG_SOLID_SUFFIX));
        assert!(!prompt.contains("exact #FFFFFF"));
        assert!(!prompt.contains("exact #0000FF"));
    }

    /// B6 r3: 3色すべてが同一の禁止句で終わること (文言が片側だけ腐るのを防ぐ)。
    /// 定数を分けて書いているため、片方だけ直すと静かに乖離しうる。
    #[test]
    fn custom_prompt_all_colors_share_solid_suffix() {
        for bg in [
            SheetBackground::White,
            SheetBackground::Green,
            SheetBackground::Blue,
        ] {
            let prompt = build_custom_character_sheet_prompt("好きに描いて", bg);
            assert!(
                prompt.ends_with(CUSTOM_SHEET_BG_SOLID_SUFFIX),
                "custom 背景行は禁止句で終わること"
            );
        }
        // Auto では付かない (プロンプト完全準拠)。
        let auto = build_custom_character_sheet_prompt("好きに描いて", SheetBackground::Auto);
        assert!(!auto.contains(CUSTOM_SHEET_BG_SOLID_SUFFIX));
    }

    /// validate が参照存在検査を通る実在パス。この .rs 自身を参照画像に見立てる
    /// (validate は拡張子を見ないので、存在しさえすればプロンプト長検査まで到達する)。
    fn existing_file_path() -> String {
        format!(
            "{}/src/commands/character_sheet.rs",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// 上限超過の custom プロンプトは validate で弾く。
    #[test]
    fn validate_rejects_overlong_custom_prompt() {
        let existing = existing_file_path();
        let mut params = params_with(&existing, &[]);
        params.custom_prompt = "あ".repeat(MAX_CUSTOM_SHEET_PROMPT_CHARS + 1);
        let err = validate_params(&params).expect_err("8001 文字は拒否されるべき");
        assert!(
            err.contains("自分で作るプロンプトが長すぎます"),
            "unexpected error: {err}"
        );
        assert!(err.contains("上限8000文字"), "unexpected error: {err}");
        assert!(err.contains("8001 文字"), "unexpected error: {err}");
    }

    /// 上限ちょうど(8000文字)は通ること(境界そのものを固定する)。
    #[test]
    fn validate_accepts_custom_prompt_at_limit() {
        let existing = existing_file_path();
        let mut params = params_with(&existing, &[]);
        params.custom_prompt = "あ".repeat(MAX_CUSTOM_SHEET_PROMPT_CHARS);
        validate_params(&params).expect("8000 文字ちょうどは通るべき");
    }

    /// 2 枚以上のときだけ優先順位の指示が入ること。
    #[test]
    fn composite_prompt_multi_contains_priority_rules() {
        let prompt = build_composite_character_sheet_prompt("", 3, SheetBackground::Auto);
        assert!(prompt.contains("1枚目がキャラクター同一性の基準"));
        assert!(prompt.contains("2枚目以降の参考画像も必ず反映する"));
        // 本文(出力構成以降)は単数と同じものを共有する。
        assert!(prompt.contains("出力スタイル:添付した写真通り"));
        assert_ne!(prompt, LEGACY_COMPOSITE_PROMPT);
    }

    /// 上限 6 枚を超えたら validate で弾く。
    #[test]
    fn validate_rejects_more_than_six_references() {
        let seven = ["a", "b", "c", "d", "e", "f", "g"];
        let params = params_with("a", &seven);
        let err = validate_params(&params).expect_err("7 枚は拒否されるべき");
        assert!(
            err.contains("参照画像は最大6枚までです"),
            "unexpected error: {err}"
        );
        assert!(err.contains("7 枚"), "unexpected error: {err}");
    }

    /// 存在しないファイルを含む場合は validate で弾く。
    #[test]
    fn validate_rejects_missing_reference_file() {
        let params = params_with(
            "/definitely/not/found/main.png",
            &["/definitely/not/found/main.png"],
        );
        let err = validate_params(&params).expect_err("存在しないパスは拒否されるべき");
        assert!(
            err.contains("参照画像が見つかりません"),
            "unexpected error: {err}"
        );
    }

    /// character_images が空なら character_image 1 枚へフォールバックする(後方互換)。
    #[test]
    fn resolve_falls_back_to_single_character_image() {
        let params = params_with("/tmp/main.png", &[]);
        assert_eq!(resolve_reference_images(&params), vec!["/tmp/main.png"]);

        let multi = params_with("/tmp/main.png", &["/tmp/a.png", "/tmp/b.png"]);
        assert_eq!(
            resolve_reference_images(&multi),
            vec!["/tmp/a.png", "/tmp/b.png"]
        );
    }

    /// composite を regenerate_cut へ渡すと拒否される。
    /// この経路には受領時の規格正規化ゲートが無いため、通すと未検査シートが
    /// 正規化を迂回して出てしまう。「フロントが呼ばない」でなく構造で塞ぐ。
    #[test]
    fn regenerate_cut_rejects_composite_to_close_the_normalize_bypass() {
        let mut params = params_with("/tmp/main.png", &["/tmp/main.png"]);
        params.generation_mode = CharacterSheetGenerationMode::Composite;

        let err = reject_composite_regenerate(&params)
            .expect_err("composite は正規化を迂回するので拒否されるべき");
        assert!(
            err.contains("composite"),
            "どの入力が拒否されたか分かる文言: {err}"
        );

        // multi-cut（表情差分などの通常経路）は従来どおり素通しする。
        params.generation_mode = CharacterSheetGenerationMode::MultiCut;
        assert!(
            reject_composite_regenerate(&params).is_ok(),
            "multi-cut の再生成は従来どおり通る"
        );
    }

    // ---- S0: build_sheet_prompt の背景色対応 ----

    /// S0 以前の厳守事項4の全文。実装側の定数を参照せずテスト側に固定で持つ
    /// (LEGACY_COMPOSITE_PROMPT と同じ理由: 実装から import すると
    /// 「実装を変えたらテストも一緒に変わる」自己言及になり回帰検知の牙が抜ける)。
    const LEGACY_SHEET_BG_LINE: &str = "4. 背景は無地の淡いグレー、フラットで均一なライティングに揃える。背景・光も参照画像と同じ画風で描き、実写のスタジオ写真風にしない。シートとして並べたときに背景・光が一貫するようにする。";

    fn sheet_cut() -> SheetCutSpec {
        SheetCutSpec {
            cut_id: "front".into(),
            role: "front".into(),
            prompt_fragment: "full body front view".into(),
        }
    }

    /// Auto は S0 以前と 1 バイトも変わらないこと。
    /// expressionSet / multiAngle / characterRegister の既存挙動を固定する。
    #[test]
    fn sheet_prompt_auto_keeps_legacy_background_line() {
        let prompt = build_sheet_prompt(&sheet_cut(), "3:4", "", SheetBackground::Auto);
        assert!(
            prompt.contains(LEGACY_SHEET_BG_LINE),
            "Auto の厳守事項4が旧文言と一致しない:\n{prompt}"
        );
        // 旧文言のままなので、クロマキー用の色指定は入らない。
        assert!(!prompt.contains("#00FF00"));
        assert!(!prompt.contains("#FFFFFF"));
        assert!(!prompt.contains("#0000FF"));
    }

    /// Green を渡すとクロマキー用のグリーンバック指定が焼かれること。
    /// **これが S0 の本丸**: ここが通らないと後段のクロマキーは 1 枚も抜けない。
    #[test]
    fn sheet_prompt_green_bakes_chroma_key_line() {
        let prompt = build_sheet_prompt(&sheet_cut(), "3:4", "", SheetBackground::Green);
        assert!(prompt.contains("#00FF00"), "グリーン指定が無い:\n{prompt}");
        assert!(prompt.contains("RGB 0,255,0"));
        // 淡いグレー固定文は消えていること (残っていると指示が矛盾する)。
        assert!(
            !prompt.contains("背景は無地の淡いグレー"),
            "旧グレー固定文が残っている:\n{prompt}"
        );
        // 番号付きリストの体裁を壊さない (箇条書きの "・" を持ち込まない)。
        assert!(!prompt.contains("4. ・"), "箇条書き記号が混入:\n{prompt}");
    }

    /// White / Blue も同じ経路で焼かれること。
    #[test]
    fn sheet_prompt_white_and_blue_bake_their_colors() {
        let white = build_sheet_prompt(&sheet_cut(), "3:4", "", SheetBackground::White);
        assert!(white.contains("#FFFFFF"), "白指定が無い:\n{white}");
        assert!(!white.contains("背景は無地の淡いグレー"));

        let blue = build_sheet_prompt(&sheet_cut(), "3:4", "", SheetBackground::Blue);
        assert!(blue.contains("#0000FF"), "青指定が無い:\n{blue}");
        assert!(!blue.contains("背景は無地の淡いグレー"));
    }

    /// 4 択すべてで背景行が互いに異なること (取り違え・コピペ事故の検出)。
    #[test]
    fn sheet_prompt_all_backgrounds_differ() {
        let prompts: Vec<String> = [
            SheetBackground::Auto,
            SheetBackground::White,
            SheetBackground::Green,
            SheetBackground::Blue,
        ]
        .iter()
        .map(|bg| build_sheet_prompt(&sheet_cut(), "3:4", "", *bg))
        .collect();
        for i in 0..prompts.len() {
            for j in (i + 1)..prompts.len() {
                assert_ne!(prompts[i], prompts[j], "背景 {i} と {j} のプロンプトが同一");
            }
        }
    }

    /// 背景色を変えても、背景行以外 (同一性保持・アスペクト比・属性) は不変であること。
    /// 背景対応がプロンプト全体を書き換えていないことの固定。
    #[test]
    fn sheet_prompt_background_does_not_disturb_other_rules() {
        for bg in [
            SheetBackground::Auto,
            SheetBackground::White,
            SheetBackground::Green,
            SheetBackground::Blue,
        ] {
            let prompt = build_sheet_prompt(&sheet_cut(), "9:16", "黒髪ロング", bg);
            assert!(prompt.contains("full body front view"));
            assert!(prompt.contains("不変の見た目 (全カット共通で厳守): 黒髪ロング"));
            assert!(prompt.contains("アスペクト比は必ず 9:16 にする"));
            assert!(prompt.contains("別人にしない"));
            assert!(prompt.contains("image_gen ツールを1回だけ呼び出す"));
        }
    }
}
