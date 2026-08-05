use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::images::watcher::{
    generated_images_dir, legacy_generated_images_dir, scan_existing, start_watcher,
};
use crate::state::AppState;

const SERVICE_DIR: &str = "Library/Application Support/app.codexframefactory";
const SETTINGS_FILE: &str = "storage-settings.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageSettings {
    #[serde(default = "default_storage_root_string")]
    pub storage_root: String,
    #[serde(default = "default_project_subfolder")]
    pub project_subfolder: bool,
    /// プロジェクトデータ (projects.json) を保存するフォルダ。
    /// 未指定 (None) なら従来どおり OS 標準のアプリデータディレクトリ
    /// (~/Library/Application Support/app.codexframefactory 等) に保存する。
    /// Google Drive 等のローカル同期フォルダを指定すると、作品データを
    /// クラウド同期できる (Drive API は使わず、同期フォルダのパス指定方式)。
    #[serde(default)]
    pub projects_data_root: Option<String>,
    #[serde(default)]
    pub cloud_supabase_enabled: bool,
    #[serde(default)]
    pub supabase_project_url: Option<String>,
    #[serde(default)]
    pub supabase_bucket_name: Option<String>,
    /// 過去に使っていた画像保存先の履歴 (新しい順、**無上限**)。
    ///
    /// なぜ持つか (2026-07-30): 保存先を変えても既存画像は移動しない
    /// (巨大で失敗リスクが高い)。代わりに旧 root を **読み続ける** ことで
    /// 「保存先を変えた瞬間に過去画像が全部見えなくなる」を構造的に無くす。
    /// watcher_dirs がこの履歴を候補ディレクトリに含める。
    ///
    /// なぜ無上限か (2026-08-03 l99 / 4-1): 以前は 5 世代で truncate していたが、
    /// 6 回目の保存先変更で最古 root が履歴から落ちた瞬間、その root にある画像が
    /// 次回起動の relink (allow_prune=true) で history.db から**消される**時限爆弾に
    /// なっていた (prune ガード第 2 段 images.rs は「settings に載っている旧 root が
    /// 読めない間は消さない」であり、載っていない root は保護できない)。
    /// 増えるのは「ユーザーが保存先を明示的に変えた回数」だけで現実には高々十数件、
    /// かつ watcher_dirs は存在しないパスを push しないため、上限撤廃の副作用は小さい。
    #[serde(default)]
    pub previous_storage_roots: Vec<String>,
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            storage_root: default_storage_root_string(),
            project_subfolder: true,
            projects_data_root: None,
            cloud_supabase_enabled: false,
            supabase_project_url: None,
            supabase_bucket_name: None,
            previous_storage_roots: Vec::new(),
        }
    }
}

/// tmp 名のプロセス内ユニーク化カウンタ (settings / 汎用 atomic write 用)。
static ATOMIC_WRITE_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// settings 書き込みの直列化 (projects の PROJECTS_WRITE_LOCK と同思想)。
/// save() は同期 fn で await を挟まないため std::sync::Mutex でよい。
static SETTINGS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `path` へ `content` をアトミックに書く (ユニーク tmp → rename、失敗時 tmp 掃除)。
/// projects_write と同じ手順の汎用化。tmp は必ず同一ディレクトリに作る
/// (rename の同一ファイルシステム保証)。
///
/// なぜ要るか (4vv): 従来 storage-settings.json は fs::write 直書きで、書き込み中の
/// 電源断でファイルが壊れると起動時に .broken へ退避 + 既定値フォールバックが走り、
/// 保存先指定と previous_storage_roots を同時に失っていた。
/// owt (2026-08-03): storyboard の run-state.json も同じ手順で書くため crate 公開。
pub(crate) fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = ATOMIC_WRITE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    fs::write(&tmp_path, content)
        .map_err(|err| format!("一時書込失敗 ({}): {err}", tmp_path.display()))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("リネーム失敗 ({}): {err}", path.display()));
    }
    Ok(())
}

impl StorageSettings {
    pub fn load() -> Result<Self, String> {
        let path = settings_path()?;
        // 新パスに無ければ旧パス (macOS 決め打ちだった場所) から拾う。
        // Windows で旧実装が書いた設定を引き継ぐため (2026-07-26)。
        // 読むだけで、書き戻しは save() が新パスへ行う。
        let source = if path.exists() {
            Some(path.clone())
        } else {
            match legacy_settings_path() {
                Some(legacy) if legacy.exists() && legacy != path => {
                    tracing::info!(
                        target: "codex.storage",
                        "旧パスの保存先設定を引き継ぎます: {}",
                        legacy.display()
                    );
                    Some(legacy)
                }
                _ => None,
            }
        };
        let settings = match source {
            Some(src) => {
                let text = fs::read_to_string(&src)
                    .map_err(|e| format!("保存先設定の読み込みに失敗 ({}): {e}", src.display()))?;
                if text.trim().is_empty() {
                    Self::default()
                } else {
                    serde_json::from_str::<Self>(&text)
                        .map_err(|e| format!("保存先設定の解析に失敗 ({}): {e}", src.display()))?
                }
            }
            None => Self::default(),
        };
        // ここで ensure_root() を呼ばない (2026-07-26 監査)。
        //
        // なぜ: 以前は呼んでいたため、**設定ファイルは完全に健全なのに
        // 保存先の外付けドライブが未接続なだけ**で load() が Err になった。
        // 起動時の呼び出し元はその Err を「設定が壊れている」と解釈して
        // 健全な設定を .broken へ退避し、既定値で上書きしてしまう。
        // ドライブを挿し直しても保存先が戻らない、という設定喪失になる。
        //
        // 「読めたか」と「その保存先が今使えるか」は別の問いなので分ける。
        // ディレクトリの作成が要る場面 (save / 実際の書き出し) で個別に行う。
        Ok(settings)
    }

    pub fn save(&self) -> Result<(), String> {
        self.ensure_root()?;
        let path = settings_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("保存先設定ディレクトリの作成に失敗: {e}"))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("保存先設定のJSON化に失敗: {e}"))?;
        let _guard = SETTINGS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        atomic_write_text(&path, &text)
            .map_err(|e| format!("保存先設定の保存に失敗 ({}): {e}", path.display()))
    }

    pub fn ensure_root(&self) -> Result<(), String> {
        fs::create_dir_all(&self.storage_root).map_err(|e| {
            format!(
                "保存先ディレクトリの作成に失敗 ({}): {e}",
                self.storage_root
            )
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub copied_count: u32,
    pub failed_count: u32,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySummary {
    pub exists: bool,
    pub file_count: u32,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    /// 現在のローカル保存先のパス（絶対パス）
    pub storage_root: String,
    /// ローカル保存先配下の全ファイル数（再帰）
    pub file_count: u32,
    /// ローカル保存先配下の合計バイト数
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn storage_get_settings(state: State<'_, AppState>) -> Result<StorageSettings, String> {
    let settings = StorageSettings::load()?;
    state.set_storage_settings(settings.clone()).await;
    Ok(settings)
}

/// 旧保存先を履歴の先頭へ積む (新しい順)。
///
/// - 同じパスの重複は落とす (先頭に積んだ `previous` が正)
/// - 新しい現行 root (`current_root`) は履歴に残さない (現行と重複するため)
/// - **件数の上限は無い** (4-1)。上限があると、履歴から落ちた root の画像が
///   次回起動の relink で prune される時限爆弾になる (StorageSettings のコメント参照)
fn push_previous_root(existing: &[String], previous: &str, current_root: &str) -> Vec<String> {
    std::iter::once(previous.to_string())
        .chain(existing.iter().filter(|r| r.as_str() != previous).cloned())
        .filter(|r| r != current_root)
        .collect()
}

#[tauri::command]
pub async fn storage_set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: StorageSettings,
) -> Result<Option<crate::commands::images::RelinkResult>, String> {
    // F4: 保存先 (storage_root) を変えると、history.db / projects.json に絶対パスで
    // 記録済みの既存画像が「その場所に無い」状態になり、まとめて見えなくなる。
    // 変更前の値を先に控え、実際に変わったときだけ再リンクを走らせる。
    // (毎回走らせると全画像の再帰走査が発生して設定保存が重くなるため、変化検知で絞る)
    let previous_root = match state.storage_settings().await {
        Some(previous) => Some(previous.storage_root),
        // state に無ければディスクの現行値を読む (起動直後の初回保存でも比較できるように)。
        None => StorageSettings::load().ok().map(|s| s.storage_root),
    };
    let root_changed = previous_root
        .as_deref()
        .is_some_and(|previous| previous != settings.storage_root);

    // 保存先が変わったら、旧 root を履歴の先頭に積む。
    // 画像実体は動かさないので、旧 root を読み続けられるようにするのが目的。
    // (2026-07-30 全ユーザーデータ生存監査 §3)
    let mut settings = settings;
    if root_changed {
        if let Some(previous) = previous_root.as_deref() {
            settings.previous_storage_roots = push_previous_root(
                &settings.previous_storage_roots,
                previous,
                &settings.storage_root,
            );
        }
    }

    settings.save()?;
    state.set_storage_settings(settings).await;
    restart_image_watcher(&app, &state).await;

    if root_changed {
        // 既存の再リンク実装をそのまま呼ぶ (パスの保存形式は変えない)。
        // 削除なし版を使う理由は relink_missing_after_root_change のコメント参照。
        // 失敗しても設定変更自体は成功させる: 保存先の切り替えを再リンクの都合で
        // 巻き戻すと、ユーザーは「保存先が変えられない」ほうの詰まりに遭う。
        // 手動の「画像パスを修復する」ボタンで後追いできる。
        match crate::commands::images::relink_missing_after_root_change(&app, &state).await {
            Ok(result) => {
                tracing::info!(
                    target: "codex.storage",
                    db_updated = result.db_updated,
                    db_unresolved = result.db_unresolved,
                    "storage_set_settings: 保存先変更を検知して画像パスを再リンクした"
                );
                // 4-2: 張り替えマップをフロントへ返す。ここを返さないと
                // projects / presets / favorites / judgements / referenceRoles が
                // 次回起動まで旧パスを握ったままになる (セッション中ずっと stale)。
                // 呼び出し側 (SettingsWorkspace) が applyRelinkResult に流す。
                return Ok(Some(result));
            }
            Err(err) => {
                tracing::warn!(target: "codex.storage", "保存先変更後の再リンクに失敗 (設定変更は成功): {err}");
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn storage_migrate_from_codex_home(
    state: State<'_, AppState>,
) -> Result<MigrationResult, String> {
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    // 「旧保存先から移行」コマンド。対象は旧 ~/.codex/generated_images に残る
    // 過去画像。FB#19 で generated_images_dir() が GORI 専用 HOME を指すように
    // なったため、ここは明示的にレガシーディレクトリを参照する (移行漏れ防止)。
    // コピーのみ・元は消さないので非破壊。
    let legacy = legacy_generated_images_dir()
        .ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    if !legacy.exists() {
        return Ok(MigrationResult {
            copied_count: 0,
            failed_count: 0,
            total_bytes: 0,
        });
    }

    let dest_root = PathBuf::from(&settings.storage_root);
    fs::create_dir_all(&dest_root).map_err(|e| format!("移行先の作成に失敗: {e}"))?;

    let mut result = MigrationResult {
        copied_count: 0,
        failed_count: 0,
        total_bytes: 0,
    };

    let entries = fs::read_dir(&legacy)
        .map_err(|e| format!("旧保存先の読み込みに失敗 ({}): {e}", legacy.display()))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            result.failed_count += 1;
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_migratable_legacy_dir(&name) {
            continue;
        }
        copy_dir_contents(&entry.path(), &dest_root.join(&name), &mut result);
    }

    Ok(result)
}

/// ユーザーのホームディレクトリパスを返す。UI で推奨パスを組み立てる時に使う。
/// 「~/ 短縮表示」と「絶対パス」を正しく対応付けるため、UI 側が逆算するのではなく
/// このコマンドで取得する。
#[tauri::command]
pub async fn storage_home_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "ホームディレクトリの解決に失敗".to_string())?;
    Ok(home.to_string_lossy().into_owned())
}

/// 現在のローカル保存先の容量を集計する。サイドバーのストレージインジケータで表示。
#[tauri::command]
pub async fn storage_usage_stats(state: State<'_, AppState>) -> Result<UsageStats, String> {
    let settings = match state.storage_settings().await {
        Some(s) => s,
        None => StorageSettings::load()?,
    };
    let root = PathBuf::from(&settings.storage_root);
    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    if root.exists() {
        summarize_files(&root, &mut file_count, &mut total_bytes);
    }
    Ok(UsageStats {
        storage_root: settings.storage_root,
        file_count,
        total_bytes,
    })
}

#[tauri::command]
pub async fn storage_legacy_summary() -> Result<LegacySummary, String> {
    // 「旧保存先のサマリー」も移行 UI 用なので旧 ~/.codex/generated_images を参照。
    let Some(legacy) = legacy_generated_images_dir() else {
        return Ok(LegacySummary {
            exists: false,
            file_count: 0,
            total_bytes: 0,
        });
    };
    if !legacy.exists() {
        return Ok(LegacySummary {
            exists: false,
            file_count: 0,
            total_bytes: 0,
        });
    }

    let mut file_count = 0u32;
    let mut total_bytes = 0u64;
    summarize_files(&legacy, &mut file_count, &mut total_bytes);
    Ok(LegacySummary {
        exists: true,
        file_count,
        total_bytes,
    })
}

/// 保存先設定ファイルのパス。**OS ごとの正しい場所を使う。**
///
/// ## なぜ直したか (2026-07-26 監査で発見)
///
/// 以前は `home.join("Library/Application Support/app.codexframefactory")` と
/// **macOS のパスを決め打ち**していた。Windows には
/// `Library/Application Support` が存在しないため:
///   1. 読み込みが必ず失敗し、load() が既定値を返す（エラーにならないので気づけない）
///   2. 保存先を外付けSSDやクラウド同期フォルダに変えても
///      **再起動のたびに ~/Pictures/GORI GORI に戻る**
///   3. save() は create_dir_all するので、ホームに
///      `Library\Application Support\` という異物フォルダが作られる
///
/// 同じファイルの `default_projects_file_path()` は正しく `dirs::data_dir()` を
/// 使い、コメントに「Win: %APPDATA%」と明記していた。
/// **projects.json だけが移行済みで、storage-settings.json が取り残されていた**
/// （矛盾として明示した上で、取り残された側を直す）。
pub fn settings_path() -> Result<PathBuf, String> {
    let data_dir =
        dirs::data_dir().ok_or_else(|| "アプリ設定ディレクトリの解決に失敗".to_string())?;
    Ok(settings_path_in(&data_dir))
}

/// `settings_path()` のうち、OS に問い合わせない純粋な組み立て部分。
///
/// なぜ分けたか: これを分けないと、テストが実行中のマシンの `data_dir()` に
/// 依存してしまう。macOS では `data_dir()` が `~/Library/Application Support`
/// なので、**修正前の macOS 決め打ち実装でもテストが緑になり**、
/// 「Windows で設定が永続しない」という守りたい退行を検出できない。
/// 引数で Windows 相当のパスを渡せる形にして、macOS 上でも牙を持たせる。
fn settings_path_in(data_dir: &Path) -> PathBuf {
    data_dir
        .join(crate::secrets::SERVICE_NAME)
        .join(SETTINGS_FILE)
}

/// 旧パス（macOS 決め打ち）。**移行元として読むだけで、書き込みはしない。**
///
/// macOS では `dirs::data_dir()` が `~/Library/Application Support` を返すため
/// 新旧が同じ場所になり移行は起きない。Windows では旧パスに実ファイルが
/// 存在しうる（save() が create_dir_all で作っていたため）ので、
/// そこに設定を書いていた人の保存先を引き継ぐために読む。
fn legacy_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(SERVICE_DIR).join(SETTINGS_FILE))
}

pub fn resolve_output_dir(
    settings: &StorageSettings,
    project_name: Option<&str>,
    leaf_dir: &str,
) -> PathBuf {
    let mut base = PathBuf::from(&settings.storage_root);
    if settings.project_subfolder {
        if let Some(name) = project_name.map(str::trim).filter(|name| !name.is_empty()) {
            let sanitized = sanitize_filename(name);
            if !sanitized.trim_matches('_').is_empty() {
                base = base.join(sanitized);
            }
        }
    }
    base.join(leaf_dir)
}

pub fn project_name_from_cwd(cwd: Option<&str>) -> Option<String> {
    let cwd = cwd.map(str::trim).filter(|cwd| !cwd.is_empty())?;
    Path::new(cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect()
}

/// 起動時のストレージ初期化。**失敗しても Err を返さない。**
///
/// ## なぜ絶対に失敗させてはいけないか (2026-07-26 監査で発見)
///
/// この関数は lib.rs の Tauri `setup` から `?` で呼ばれていた。つまり Err を
/// 返すと **ウィンドウが生成される前にアプリが終了する**。エラー画面もトーストも
/// 出ないので、ユーザーには「ダブルクリックしても何も起きない」としか見えない。
///
/// 実際に詰む経路が2つあった:
///   1. 保存先を外付けSSD / クラウド同期フォルダにした人が、それを外して起動
///      → ensure_root() の create_dir_all が失敗 → 起動しない
///      → 設定画面に到達できないので保存先を戻せない = 完全な詰み
///   2. 生成中に電源が落ちて storage-settings.json が途中書きで壊れた
///      → serde_json::from_str が失敗 → 起動しない
///      (空文字だけは default に落ちるが、途中で切れた JSON は救われなかった)
///
/// 設定の読み込み失敗より「アプリが開くこと」が優先される。開けば設定画面から
/// 保存先を直せるし、壊れた JSON も上書きできる。開けなければ何もできない。
///
/// 同ファイル :152 付近には「保存先の切り替えを巻き戻すとユーザーは詰まる」と
/// 書いて設定変更を優先する設計判断が記録されているのに、起動経路だけが逆に
/// 詰ませる側になっていた。**矛盾**として明示した上で、起動側を直す。
pub async fn initialize_storage(state: &AppState) -> StorageSettings {
    // ① 設定を読む。壊れていたら既定値で続ける (捨てずに退避する)。
    let settings = match StorageSettings::load() {
        Ok(settings) => settings,
        Err(err) => {
            tracing::error!(
                target: "codex.storage",
                "保存先設定を読めませんでした。既定値で起動します: {err}"
            );
            quarantine_broken_settings();
            StorageSettings::default()
        }
    };

    // ② 保存先が使えるか確かめる。使えなければ既定の保存先で起動する。
    //    ここで return せず、必ず「使えるどこか」を state に入れて起動を通す。
    let usable = settings.ensure_root().is_ok();
    let settings = if usable {
        settings
    } else {
        let fallback = StorageSettings::default();
        tracing::error!(
            target: "codex.storage",
            "保存先 {} が今は使えません (外付けドライブ未接続など)。\
             このセッションは既定の保存先で動きます: {}。\
             設定ファイルは書き換えないので、元の場所が戻れば次回そのまま復帰します。",
            settings.storage_root,
            fallback.storage_root
        );
        // 既定側も作れないなら、それでも起動は通す (state には入れる)。
        // 生成時に個別のエラーとして出るほうが、起動しないより救いがある。
        let _ = fallback.ensure_root();
        fallback
    };

    // ③ 保存する。ただし ② でフォールバックしたときは書かない。
    //
    //    なぜ書かないか (2026-07-26 監査): 外付けSSDを外して1度起動しただけで
    //    ユーザーが設定した保存先が既定値に上書きされると、SSD を挿し直しても
    //    元に戻らない。「今このセッションで使う場所」と「ユーザーが設定した場所」
    //    は別物で、後者をディスクから消してよい理由がない。
    //
    //    保存自体の失敗は握り潰して続行する。書けないことは起動を止める理由にならない。
    if usable {
        if let Err(err) = settings.save() {
            tracing::warn!(target: "codex.storage", "保存先設定の保存に失敗 (続行): {err}");
        }
    }

    state.set_storage_settings(settings.clone()).await;
    settings
}

/// 壊れた storage-settings.json を消さずに退避する。
///
/// なぜ消さないか: 中に「ユーザーが設定した保存先のパス」が入っている。
/// 壊れていても人が読めば復元できる情報なので、上書きで消してはいけない
/// (欠落は埋めずに可視化する / 資産は残す)。
///
/// なぜ退避先を固定名にしないか: 壊れる事象は繰り返し起きうる (電源断が続く等)。
/// 固定名だと2回目の退避が1回目を上書きし、**ユーザーの保存先パスが残る唯一の
/// 記録を消してしまう**。空いている番号を探して衝突を避ける。
fn quarantine_broken_settings() {
    let Ok(path) = settings_path() else { return };
    if !path.exists() {
        return;
    }
    let backup = next_free_backup_path(&path);
    match fs::rename(&path, &backup) {
        Ok(()) => tracing::warn!(
            target: "codex.storage",
            "壊れた設定を {} に退避しました (中の保存先パスは人が読めば復元できます)",
            backup.display()
        ),
        Err(err) => tracing::warn!(
            target: "codex.storage",
            "壊れた設定の退避に失敗 (続行): {err}"
        ),
    }
}

/// 既存の退避ファイルを潰さない退避先を返す。
///
/// `foo.json` → `foo.json.broken` → 埋まっていれば `foo.json.broken.2`,
/// `.broken.3` … と空きを探す。上限まで全部埋まっていたら最後の名前を返す
/// (その1件だけは上書きされるが、無限ループやディスク圧迫よりは軽い被害)。
fn next_free_backup_path(path: &Path) -> PathBuf {
    let first = path.with_extension("json.broken");
    if !first.exists() {
        return first;
    }
    for n in 2..=50 {
        let candidate = path.with_extension(format!("json.broken.{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.with_extension("json.broken.50")
}

async fn restart_image_watcher(app: &AppHandle, state: &AppState) {
    let settings = state.storage_settings().await;
    let dirs = watcher_dirs(settings.as_ref());
    for dir in &dirs {
        scan_existing(app, dir);
    }
    match start_watcher(app.clone(), dirs.clone()) {
        Ok(watcher) => state.set_image_watcher(watcher).await,
        Err(err) => {
            tracing::warn!(target: "codex.watcher", "storage watcher restart failed: {err}")
        }
    }
}

pub fn watcher_dirs(settings: Option<&StorageSettings>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    // 現行の image_gen 出力先 (GORI 専用 CODEX_HOME/generated_images)。
    if let Some(active) = generated_images_dir() {
        dirs.push(active);
    }
    // FB#19 で CODEX_HOME を切り替える前に生成された過去画像が残る旧
    // ~/.codex/generated_images も読み取り専用で監視に含める (退行防止・消さない)。
    // 専用 HOME に統一した結果、active とは別パスなので重複しない限り追加する。
    if let Some(legacy) = crate::images::watcher::legacy_generated_images_dir() {
        if !dirs.iter().any(|dir| dir == &legacy) {
            dirs.push(legacy);
        }
    }
    if let Some(settings) = settings {
        let storage = PathBuf::from(&settings.storage_root);
        if !dirs.iter().any(|dir| dir == &storage) {
            dirs.push(storage);
        }
        // 過去の保存先も読み取り対象に含める (2026-07-30)。
        //
        // なぜ: 保存先を変えても既存画像は移動しない (巨大で失敗リスクが高い) ため、
        // 旧 root を候補から外すと「変えた瞬間に過去画像が全部見えなくなる」。
        // ここに足すだけで watcher / relink / 索引の3経路すべてに同時に効く
        // (restart_image_watcher と relink_missing_inner が同じ関数を使うため)。
        //
        // 存在しないパス (外付けHDD未接続・フォルダ削除済み) は push しない。
        // 索引作成側は読めないディレクトリを黙って飛ばすが、
        // 「候補に入っているのに読めない」状態を作らないほうが挙動が読みやすい。
        for previous in &settings.previous_storage_roots {
            let p = PathBuf::from(previous);
            if !p.exists() {
                continue;
            }
            if !dirs.iter().any(|dir| dir == &p) {
                dirs.push(p);
            }
        }
    }
    dirs
}

fn default_storage_root_string() -> String {
    // panic させない (2026-07-26 監査)。
    //
    // なぜ: この関数は `#[serde(default = ...)]` から呼ばれるため、
    // **JSON デシリアライズの途中で実行される**。以前は `.expect("home dir")`
    // だったので、HOME が解決できない環境ではエラーではなく即クラッシュした。
    // 同じリポジトリの codex/home.rs は同種の処理を Option で返しており、
    // ここだけ流儀が違っていた（矛盾）。
    //
    // HOME が無い環境では一時ディレクトリへ退避する。保存先として理想では
    // ないが、クラッシュして何も保存できないより良い。
    //
    // picture_dir() は `~/Pictures` 自体を返すので、ここで `Pictures` を
    // 足し直すと `~/Pictures/Pictures` になる。段の付け方が home_dir とは
    // 違うため、分岐ごとに「GORI GORI の親になるディレクトリ」まで解決する。
    default_storage_root_from(dirs::home_dir(), dirs::picture_dir())
}

/// `default_storage_root_string()` のうち、OS に問い合わせない純粋な部分。
///
/// なぜ分けたか: home が無い分岐 (picture_dir 側) は macOS/Linux では
/// **絶対に実行されない**ため、そこにデグレを入れてもテストが緑のまま通る。
/// 引数で `home = None` を渡せる形にして、両分岐を明示的に検査できるようにする。
fn default_storage_root_from(home: Option<PathBuf>, pictures: Option<PathBuf>) -> String {
    let parent = match home {
        Some(home) => home.join("Pictures"),
        // picture_dir() は `~/Pictures` 自体。ここで Pictures を足さない。
        None => pictures.unwrap_or_else(std::env::temp_dir),
    };
    parent.join("GORI GORI").to_string_lossy().into_owned()
}

fn default_project_subfolder() -> bool {
    true
}

fn is_migratable_legacy_dir(name: &str) -> bool {
    name.starts_with("batch-") || name.starts_with("hfc-") || name.starts_with("gori-storyboard-")
}

fn copy_dir_contents(src: &Path, dest: &Path, result: &mut MigrationResult) {
    if let Err(err) = fs::create_dir_all(dest) {
        tracing::warn!(target: "codex.storage", "create dir failed {}: {err}", dest.display());
        result.failed_count += 1;
        return;
    }
    let Ok(entries) = fs::read_dir(src) else {
        result.failed_count += 1;
        return;
    };
    for entry in entries.flatten() {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            result.failed_count += 1;
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_dir_contents(&src_path, &dest_path, result);
        } else if file_type.is_file() {
            match fs::copy(&src_path, &dest_path) {
                Ok(bytes) => {
                    result.copied_count += 1;
                    result.total_bytes += bytes;
                }
                Err(err) => {
                    tracing::warn!(target: "codex.storage", "copy failed {} -> {}: {err}", src_path.display(), dest_path.display());
                    result.failed_count += 1;
                }
            }
        }
    }
}

fn summarize_files(dir: &Path, file_count: &mut u32, total_bytes: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            summarize_files(&path, file_count, total_bytes);
        } else if file_type.is_file() {
            *file_count = file_count.saturating_add(1);
            if let Ok(meta) = entry.metadata() {
                *total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// プロジェクト永続化 (v0.6.9)
//
// 旧設計: localStorage に projects.projects キーで保存
//   → WebView ごとに別、dev版↔配布版でデータが共有されない問題
//
// 新設計: アプリデータディレクトリの projects.json に保存
//   - Mac:   ~/Library/Application Support/app.codexframefactory/projects.json
//   - Win:   %APPDATA%/app.codexframefactory/projects.json
//   - Linux: ~/.local/share/app.codexframefactory/projects.json
//   dirs crate の data_dir() で自動解決、クロスプラットフォーム対応。
//
// 起動時に旧 localStorage データがあれば、フロント側で自動的に
// これらのコマンドを呼んでマイグレーションする。

/// OS 標準のアプリデータディレクトリ配下の projects.json パスを返す。
/// projectsDataRoot が未指定のときのデフォルト保存先 (従来挙動)。
fn default_projects_file_path() -> Result<PathBuf, String> {
    // dirs::data_dir() は OS 標準のアプリデータディレクトリを返す。
    //   Mac:   ~/Library/Application Support
    //   Win:   %APPDATA% (= C:\Users\<user>\AppData\Roaming)
    //   Linux: ~/.local/share
    let data_dir =
        dirs::data_dir().ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
    let app_dir = data_dir.join("app.codexframefactory");
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
    }
    Ok(app_dir.join("projects.json"))
}

/// projects.json の実際の保存パスを解決する。
///
/// - StorageSettings.projects_data_root が指定されていれば、その配下の
///   projects.json を使う (Google Drive 等の同期フォルダを指せる)。
/// - 未指定なら従来どおり OS 標準のアプリデータディレクトリを使う (後方互換)。
///
/// 指定フォルダが存在しない場合は作成する。
fn projects_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    projects_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) からファイルパスを組み立てる。
/// None なら default_projects_file_path() に委譲する。
fn projects_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!(
                        "プロジェクトデータ保存先の作成に失敗 ({}): {err}",
                        dir.display()
                    )
                })?;
            }
            Ok(dir.join("projects.json"))
        }
        None => default_projects_file_path(),
    }
}

/// projects.json を読み出す。存在しなければ空配列文字列を返す。
/// フロント側で JSON.parse して useProjects.projects に代入する。
#[tauri::command]
pub async fn projects_read() -> Result<String, String> {
    let path = projects_file_path()?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|err| format!("projects.json 読込失敗: {err}"))
}

/// 2層保持 (2026-08-06 新設) の「直近層」に残す世代数。
///
/// 直前の状態へ戻すための層。連続保存するとここは数分間隔で埋まる。
const BACKUP_KEEP_RECENT: usize = 5;

/// 2層保持の「日次層」に残す世代数 (日付が互いに異なるもの)。
///
/// なぜ要るか (実害): 従来は「新しい順に10世代」だけだったため、連続保存すると
/// 全世代が直近数分に偏り、**事故の前のスナップショットが押し出されて消えた**。
/// 「壊れたことに翌日気づく」型の事故では直近層は全部壊れた後の状態なので、
/// 日付の違う世代を別枠で確保しないと復元先が1つも残らない。
const BACKUP_KEEP_DAILY: usize = 5;

/// 1日のミリ秒。epoch ミリ秒 → 「epoch からの日数」への換算に使う。
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// バックアップのファイル名からタイムスタンプ (epoch ミリ秒) を取り出す。
///
/// `<file_name>.bak-<epochミリ秒>` 以外の形なら None。数値でないもの
/// (旧 `.bak-YYYYMMDD-HHMMSS` 形式の残骸等) を巻き込まないための関門でもある。
fn backup_stamp(name: &str, prefix: &str) -> Option<u64> {
    name.strip_prefix(prefix)?.parse::<u64>().ok()
}

/// epoch ミリ秒を「epoch からの通算日」に落とす (UTC 基準)。
///
/// ローカルタイムゾーンを使わないのは、chrono 非依存を保つため。日次層の目的は
/// 「別の日のスナップショットを1つ確保する」ことなので、日境界が UTC でも
/// 目的は達せられる (最大数時間ずれるだけで、層が消えることはない)。
fn day_index(stamp_ms: u64) -> u64 {
    stamp_ms / DAY_MS
}

/// 2層保持の選別: 残すべきバックアップの stamp 集合を返す。
///
/// - 直近層: 新しい順に BACKUP_KEEP_RECENT 件
/// - 日次層: 直近層に入らなかったもののうち、**日付が互いに異なる**世代を
///   新しい順に BACKUP_KEEP_DAILY 件 (同じ日なら、その日で最も新しいものを残す)
///
/// 判定だけを純関数にしているのは**テストのため** (実 I/O なしで固定できる)。
/// 引数は (stamp) の一覧。順不同で渡してよい。
fn backups_to_keep(stamps: &[u64]) -> std::collections::HashSet<u64> {
    let mut sorted: Vec<u64> = stamps.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a)); // 新しい順
    let mut keep: std::collections::HashSet<u64> = std::collections::HashSet::new();

    // 直近層。
    for stamp in sorted.iter().take(BACKUP_KEEP_RECENT) {
        keep.insert(*stamp);
    }

    // 日次層。直近層で既に確保した日は「その日は埋まっている」とみなさない
    // (直近層が今日ばかりでも、日次層は昨日以前を BACKUP_KEEP_DAILY 日分取る)。
    let recent_days: std::collections::HashSet<u64> = sorted
        .iter()
        .take(BACKUP_KEEP_RECENT)
        .map(|s| day_index(*s))
        .collect();
    let mut daily_days: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for stamp in sorted.iter().skip(BACKUP_KEEP_RECENT) {
        if daily_days.len() >= BACKUP_KEEP_DAILY {
            break;
        }
        let day = day_index(*stamp);
        if recent_days.contains(&day) || daily_days.contains(&day) {
            continue; // その日は既に代表が居る
        }
        daily_days.insert(day);
        keep.insert(*stamp);
    }

    keep
}

/// JSON 文字列に含まれるプロジェクト件数 (トップレベル配列の要素数) を数える。
/// パースできない/配列でないときは None。空上書きガードと件数比較に使う。
fn count_projects(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Array(arr)) => Some(arr.len()),
        _ => None,
    }
}

/// 同一ミリ秒でも世代が潰れない `.bak` パスを決める (2026-08-06 DL-03)。
///
/// なぜ要るか: stamp は epoch ミリ秒なので、1ミリ秒以内に 2 回バックアップが走ると
/// (空上書きガードで backup → 直後の本書き込みで backup 等、実際に連続する経路がある)
/// `fs::copy` が **同名を黙って上書き**し、直前の世代が消える。連番サフィックスを
/// 足して衝突を避ける。
///
/// 命名は `<file_name>.bak-<stamp>` (初回) と `<file_name>.bak-<stamp>-<n>` (衝突時)。
/// `backup_stamp` は `-` を含む残りを数値パースできないため後者を stamp として拾わないが、
/// **prune の対象外 = 消されない**だけで実害はない (知らないものを消さない方針とも整合)。
/// 衝突は 1 ミリ秒以内の連続保存でしか起きないので、残骸が積み上がる経路にはならない。
fn next_free_backup_path_for(dir: &Path, file_name: &str, stamp: u128) -> PathBuf {
    let base = dir.join(format!("{file_name}.bak-{stamp}"));
    if !base.exists() {
        return base;
    }
    for n in 1..1000u32 {
        let candidate = dir.join(format!("{file_name}.bak-{stamp}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

/// projects.json を世代付きバックアップする。`path` が存在しなければ何もしない。
/// `<path>.bak-<epochミリ秒>` を作り、2層保持 (直近5 + 日次5) から漏れた世代を削除。
///
/// **戻り値: バックアップを取れたか** (2026-08-06 DL-03)。`path` が存在しない場合は
/// 「守るものが無い＝取れた扱い」で true。存在するのにコピーに失敗したときだけ false。
/// 呼び出し側 (破壊的書き込みの直前) は false なら書き込みを中止し、正本を守る。
#[must_use]
fn backup_projects_file(path: &Path) -> bool {
    if !path.exists() {
        // 守る対象が無い = 失うものが無い。書き込みを止める理由にしない。
        return true;
    }
    let file_name = match path.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return false,
    };
    let dir = match path.parent() {
        Some(d) => d,
        None => return false,
    };
    // タイムスタンプ (epochミリ秒)。chrono 非依存で SystemTime から組む。
    // 秒だと同一秒内の連続保存でバックアップ名が衝突し世代が潰れるため、ミリ秒にする。
    // ミリ秒は13桁で当面桁揃いなので、文字列 sort = 数値 sort が成り立つ。
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let bak = next_free_backup_path_for(dir, file_name, stamp);
    if let Err(err) = fs::copy(path, &bak) {
        eprintln!("[projects] バックアップ作成失敗: {err}");
        return false;
    }
    // 古い世代を掃除する (2層保持)。`<file_name>.bak-` 始まりを集め、
    // backups_to_keep が返した stamp 集合に無いものだけ消す。
    // 「新しい順に10件」ではないので、連続保存しても日次層は押し出されない。
    let prefix = format!("{file_name}.bak-");
    prune_backups(dir, &prefix);
    true
}

/// 破壊的書き込みの直前に世代バックアップを取り、失敗したら書き込みを中止させる
/// (2026-08-06 DL-03)。
///
/// なぜ要るか: 従来はバックアップ失敗を「ログして継続」していたため、
/// **戻せない状態のまま正本を上書き**していた。ディスク満杯・権限エラー・
/// クラウド同期の一時ロックなど、バックアップが取れない状況は正本の書き込みも
/// 危ういので、安全側 (書かない) に倒す。
fn backup_before_write(path: &Path, label: &str) -> Result<(), String> {
    if backup_projects_file(path) {
        return Ok(());
    }
    Err(format!(
        "{label}のバックアップを作成できなかったため、保存を中止しました (データ保護)。\
         元のデータはそのまま残っています。ディスクの空き容量と保存先フォルダの書き込み権限を確認してください。"
    ))
}

/// `dir` 内の `<prefix><epochミリ秒>` 形式のバックアップを 2層保持で間引く。
///
/// backups_to_keep の判定に載らないものだけを削除する。stamp が数値でない
/// ファイル (想定外の命名) は**触らない** (知らないものを消さない)。
fn prune_backups(dir: &Path, prefix: &str) {
    let mut entries: Vec<(u64, PathBuf)> = Vec::new();
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(stamp) = backup_stamp(name, prefix) else {
            continue;
        };
        entries.push((stamp, p));
    }
    let stamps: Vec<u64> = entries.iter().map(|(s, _)| *s).collect();
    let keep = backups_to_keep(&stamps);
    for (stamp, path) in entries {
        if !keep.contains(&stamp) {
            let _ = fs::remove_file(path);
        }
    }
}

/// デイリーバックアップの間隔 (ミリ秒)。最新の .bak がこれより古ければ1世代作る。
const DAILY_BACKUP_INTERVAL_MS: u64 = DAY_MS;

/// `path` の最新バックアップの stamp (epoch ミリ秒) を返す。1つも無ければ None。
fn latest_backup_stamp(path: &Path) -> Option<u64> {
    let file_name = path.file_name().and_then(|s| s.to_str())?;
    let dir = path.parent()?;
    let prefix = format!("{file_name}.bak-");
    let rd = fs::read_dir(dir).ok()?;
    rd.filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str())?.to_string();
            backup_stamp(&name, &prefix)
        })
        .max()
}

/// 「いま1世代バックアップを取るべきか」を判定する純関数。
///
/// 取るべき条件:
///   - 対象ファイルが存在し、かつ**非空** (0バイトや空配列を守っても意味がない)
///   - 最新の .bak が1つも無い、または `interval_ms` より古い
///
/// なぜ純関数に切り出すか: 実 I/O と時刻に依存させるとテストで固定できないため
/// (projects_decrease_rejected と同じ理由)。`now_ms` / `latest` を引数で受ける。
fn daily_backup_due(exists_nonempty: bool, latest: Option<u64>, now_ms: u64, interval_ms: u64) -> bool {
    if !exists_nonempty {
        return false;
    }
    match latest {
        None => true, // 1つも無い = 移行したきり触っていないユーザー。ここが本命
        Some(stamp) => now_ms.saturating_sub(stamp) >= interval_ms,
    }
}

/// 対象ファイルが「存在して非空か」を返す。読めない場合は false (触らない)。
///
/// 非空の判定にファイルサイズを使うのは、JSON パースまでせずに済ませるため。
/// 中身が壊れていてもバックアップする価値はある (壊れた正本より前の世代が要る)。
fn file_exists_nonempty(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false)
}

/// 1ファイル分のデイリーバックアップ。**実際に取れたら** true。
///
/// 2026-08-06 (DL-03): 以前は `backup_projects_file` の結果を捨てて常に true を返して
/// いたため、コピーが失敗しても「N ファイルを1世代保存しました」と数えられていた。
/// 取れていないバックアップを取れたと報告するのは、無いより悪い (安心して失う)。
fn ensure_daily_backup_for(path: &Path, now_ms: u64) -> bool {
    let due = daily_backup_due(
        file_exists_nonempty(path),
        latest_backup_stamp(path),
        now_ms,
        DAILY_BACKUP_INTERVAL_MS,
    );
    if !due {
        return false;
    }
    backup_projects_file(path)
}

/// 保護対象4ファイルのパスを解決する (presets / projects / scene3d / motions)。
///
/// 解決に失敗したもの (保存先が今使えない等) は**黙って飛ばす**。
/// バックアップは付帯機能であり、ここで起動やユーザー操作を止める理由がない。
fn protected_data_files() -> Vec<PathBuf> {
    [
        presets_file_path(),
        projects_file_path(),
        scene3d_file_path(),
        motions_file_path(),
    ]
    .into_iter()
    .filter_map(|r| r.ok())
    .collect()
}

/// 保護対象ファイルに対し、必要ならデイリーバックアップを1世代作る。
///
/// なぜ要るか (2026-08-06 実害): バックアップは従来 `backup_projects_file` が
/// 「保存の直前」にしか作らず、しかも**ファイルが既に存在するときだけ**作っていた
/// (`!path.exists()` で即 return)。つまり
///   - 初回移行でファイルを作った回は .bak が作られない
///   - 以後そのデータを一度も保存し直していないユーザーは .bak が**1つも無い**
/// という状態が普通に成立し、「バックアップがありません」と表示されていた。
///
/// 起動のたびにここを通すことで、**触っていないユーザーにも必ず1世代**行き渡る。
/// 24時間より新しい .bak があるときは何もしないので、起動を繰り返しても増えない。
///
/// 返り値: 実際にバックアップを作ったファイル数。
#[tauri::command]
pub async fn storage_ensure_daily_backups() -> Result<usize, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let created = protected_data_files()
        .iter()
        .filter(|path| ensure_daily_backup_for(path, now_ms))
        .count();
    if created > 0 {
        tracing::info!(
            target: "codex.storage",
            "起動時デイリーバックアップ: {created} ファイルを1世代保存しました"
        );
    }
    Ok(created)
}

/// 大幅減少ガードの閾値。既存がこれ未満なら発火しない (小規模データの誤爆防止)。
const DECREASE_GUARD_MIN_EXISTING: usize = 3;

/// presets / scene3d / motions の大幅減少ガードの閾値 (2026-08-06 新設)。
///
/// projects より高い (10件) 理由: プリセットは 1〜2 件ずつ整理する運用が普通で、
/// 少数時の減少は正当な操作である可能性が高い。「30体が1件になる」級の事故
/// (2026-08-06 実ユーザー被害) を止めることに絞る。
const SHRINK_GUARD_MIN_EXISTING: usize = 10;

/// tmp ファイルへ書き、**rename 前に fsync する** (2026-08-06 新設)。
///
/// なぜ要るか: `fs::write` はページキャッシュに載せるだけで、rename が先にディスクへ
/// 到達すると「中身が空/途中の新ファイル」が正本の位置に居座り得る (電源断・強制終了)。
/// アトミック rename は「旧か新か」を保証するが、**新の中身が完全であることは
/// 保証しない**。sync_all を挟むと、rename 時点で中身が確実にディスクにある。
fn write_file_synced(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::File::create(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// 上書きガードのために既存ファイルを読む (2026-08-06 DL-01)。
///
/// **なぜ Result を返すか**: 従来は `if let Ok(existing) = fs::read_to_string(&path)`
/// と書いていたため、**既存ファイルが存在するのに読めないと比較そのものが省略され、
/// 空上書きガードも激減ガードも素通りして書き込みが通っていた**。
/// 権限エラー (Google Drive の os error 13 等) や一時的な I/O 障害のときに、
/// 「読めない＝守るべき中身が分からない」正本を上書きできてしまう。
///
/// 返り値:
///   - `Ok(None)`  — ファイルが存在しない (守る対象が無い。ガードは非適用でよい)
///   - `Ok(Some(s))` — 読めた。ガード判定に使う
///   - `Err(msg)`  — **存在するのに読めない**。呼び出し側は書き込みを中止する
fn read_existing_for_guard(path: &Path, label: &str) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(err) => Err(format!(
            "既存の{label}を読み取れなかったため、保存を中止しました (データ保護)。\
             上書きすると失われる可能性があるため書き込みませんでした。\
             元のデータはそのまま残っています。保存先フォルダの権限とクラウド同期の状態を確認してください ({}): {err}",
            path.display()
        )),
    }
}

/// 「既存 N 件 (N >= min) → 今回 M 件 (M >= 1)」が半分未満への激減なら Some((N, M))。
///
/// 0 件は空上書きガードの担当なのでここでは見ない (incoming_count == 0 は None)。
/// count 関数を引数に取ることで presets / scene3d / motions で共有する
/// (それぞれ数える対象の配列名が違うだけで判定式は同一)。
fn shrink_rejected(
    existing: &str,
    incoming: &str,
    count: impl Fn(&str) -> Option<usize>,
) -> Option<(usize, usize)> {
    let existing_count = count(existing).unwrap_or(0);
    let incoming_count = count(incoming).unwrap_or(0);
    if existing_count >= SHRINK_GUARD_MIN_EXISTING
        && incoming_count >= 1
        && incoming_count * 2 < existing_count
    {
        Some((existing_count, incoming_count))
    } else {
        None
    }
}

/// 「既存 N 件 → 今回 M 件 (M>=1)」が半分未満への大幅減少なら Some((N, M))。
/// 0 件は空上書きガードの担当なのでここでは見ない (incoming_count == 0 は None)。
///
/// なぜ要るか (ywf): クラウド同期フォルダで巻き戻った古いコピーを読み込んだ
/// セッション (in-memory 1 件) が、同期で届いた新しい正本 (disk 10 件) を全量
/// 後勝ち上書きする経路を、書き込み時に disk 側件数と比較して止める。
///
/// 判定だけを別関数にしているのは**テストのため** (motions_empty_overwrite_rejected
/// と同じ理由。本体は実パス解決を伴い単体テストから叩けない)。
fn projects_decrease_rejected(existing: &str, incoming: &str) -> Option<(usize, usize)> {
    let existing_count = count_projects(existing).unwrap_or(0);
    let incoming_count = count_projects(incoming).unwrap_or(0);
    if existing_count >= DECREASE_GUARD_MIN_EXISTING
        && incoming_count >= 1
        && incoming_count * 2 < existing_count
    {
        Some((existing_count, incoming_count))
    } else {
        None
    }
}

/// projects_write の直列化ロック (2026-07-30)。
/// 並列生成改修 (2026-07-28) で保存の並行度が上がり、固定 tmp 名 + 並行 rename で
/// 「projects.json リネーム失敗: No such file or directory」が実機多発した
/// (2026-07-29 23:08〜23:37 ×6回)。書き込み全体 (空上書きガード→バックアップ→
/// tmp書込→rename) を 1 クリティカルセクションにし、内容の後勝ち逆転も防ぐ。
static PROJECTS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// tmp 名のプロセス内ユニーク化カウンタ (epochナノ秒と併用)。
static PROJECTS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// projects.json に書き込む (上書き)。
/// フロント側で JSON.stringify した文字列をそのまま渡す。
///
/// データ消失を構造的に防ぐため、以下を行う:
///   1. 書き込み前に既存ファイルを世代バックアップ (`.bak-<epochミリ秒>`、最大10世代)。
///      → 何が起きても直前の状態に戻せる (配布ユーザーが自力復旧できる土台)。
///   2. 「既存はN件(N>0)あるのに、今回0件で上書き」する場合は、`allow_empty` が
///      false のとき **拒否** する。
///      → 起動直後の読込失敗や誤操作で全プロジェクトが空書き潰しされる事故を防ぐ。
///      → ただしユーザーが**意図的に全削除した**ときはフロントが `allow_empty=true` を
///        渡すので、その場合は空書き込みを許可する (「消せない」退行を防ぐ)。
///   3. tmp 経由でアトミックに rename (書き込み中断でも旧ファイルが壊れない)。
///
/// `allow_empty`: 0件での上書きを許可するか。通常の保存は false (事故防止)。
///   ユーザー操作による明示的な全削除のときだけ true を渡す。
/// `allow_decrease`: 大幅減少 (半分未満) での上書きを許可するか。通常は false。
///   フロントが確認ダイアログで「このまま上書きする」を選ばせたときだけ true を渡す。
#[tauri::command]
pub async fn projects_write(
    content: String,
    allow_empty: Option<bool>,
    allow_decrease: Option<bool>,
) -> Result<(), String> {
    // 直列化: ガード読取→バックアップ→tmp→rename の全工程を1トランザクションに。
    let _guard = PROJECTS_WRITE_LOCK.lock().await;
    let path = projects_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    // 既存を1回だけ読む。**存在するのに読めないなら書き込みを中止**する (DL-01)。
    // 従来は読めないとガード自体が省略され、素通りで上書きされていた。
    let existing = read_existing_for_guard(&path, "プロジェクトデータ")?;

    // 空上書きガード: 既存が非空で今回が0件、かつ明示許可でないなら拒否 (事故防止)。
    if !allow_empty {
        if let Some(existing) = existing.as_deref() {
            let existing_count = count_projects(existing).unwrap_or(0);
            let incoming_count = count_projects(&content).unwrap_or(0);
            if existing_count > 0 && incoming_count == 0 {
                // 念のためバックアップは取った上で、上書きは行わない。
                // (ここは書き込まない経路なので、バックアップ失敗でも元のエラーを優先する)
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "空のプロジェクトデータで {existing_count} 件を上書きしようとしたため中止しました (データ保護)。意図的な全削除なら allow_empty を指定してください。"
                ));
            }
        }
    }

    // 大幅減少ガード (ywf): disk 側が多いのに今回が半分未満なら中止する。
    // クラウド同期で巻き戻った古いコピーによる全量後勝ち上書きを止める。
    // エラー先頭の [DECREASE_GUARD ...] はフロントの機械判定マーカー (形式を変えない)。
    if !allow_decrease.unwrap_or(false) {
        if let Some(existing) = existing.as_deref() {
            if let Some((e, i)) = projects_decrease_rejected(existing, &content) {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "[DECREASE_GUARD existing={e} incoming={i}] 保存内容 ({i} 件) がディスク上のプロジェクトデータ ({e} 件) より大幅に少ないため中止しました (データ保護)。"
                ));
            }
        }
    }

    // 書き込み前に世代バックアップ。**取れなければ書かない** (DL-03)。
    backup_before_write(&path, "プロジェクトデータ")?;

    // tmp 名はユニーク化する (直列化に加えた二重防御。別ウィンドウ/将来の別経路が
    // 同じ固定 tmp を触ってもレースしない)。
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = PROJECTS_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    // DL-02: projects だけ素の `fs::write` で fsync が無く、電源断で「空/途中の新ファイル」が
    // 正本の位置に居座り得た。他3正本と同じ write_file_synced に揃える。
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("projects.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        // 失敗した tmp は残骸として残さない (掃除失敗は握り潰してよい)。
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("projects.json リネーム失敗: {err}"));
    }
    Ok(())
}

/// projects.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epoch秒, プロジェクト件数)。
/// 設定画面の「バックアップから復元」UI が使う。
#[tauri::command]
pub async fn projects_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "projects.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = format!("{file_name}.bak-");
    let mut out: Vec<(String, u64, usize)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            let stamp: u64 = name[prefix.len()..].parse().unwrap_or(0);
            let count = fs::read_to_string(&p)
                .ok()
                .and_then(|c| count_projects(&c))
                .unwrap_or(0);
            // 0件のバックアップは復元候補に出さない (空で復元しても意味がなく、
            // 空上書きガードに弾かれて無言で失敗するため。evaluator 指摘)。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1)); // 新しい順
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// 復元前のプレビュー、または復元適用にフロントが使う。
/// パスは projects_list_backups が返したものに限定 (prefix 一致で検証)。
#[tauri::command]
pub async fn projects_read_backup(backup_path: String) -> Result<String, String> {
    let path = projects_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "projects.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "projects.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    // 任意パス読み出しを防ぐ: 既定のバックアップ命名にマッチするものだけ許可。
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// projects.json ファイルのプロジェクト件数を返す。
///   - 存在しない → Ok(0)
///   - 存在して読めて配列 → Ok(件数)
///   - 存在して読めるが壊れたJSON → Ok(0) (中身が無効＝0件相当)
///   - **存在するが read 失敗 (Google Drive の os error 13 等)** → Err
///
/// read 失敗を 0 と混同すると、旧側が読めないときに「0件＝引き継ぎ不要」と誤判定して
/// 旧データを取りこぼす (今回の事故の読み取り側変種)。Err で区別し、呼び出し側が中止できるようにする。
fn projects_count_at(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    match fs::read_to_string(path) {
        Ok(c) => Ok(count_projects(&c).unwrap_or(0)),
        Err(err) => Err(format!(
            "プロジェクトデータの読み取りに失敗 ({}): {err}",
            path.display()
        )),
    }
}

/// プロジェクトデータ保存先 (projects_data_root) を変更する。
///
/// **データ消失を構造的に防ぐ移行ポリシー (2026-06-09 改修)**:
///   - 旧 = 新 のときは何もしない。
///   - 旧側の件数 >= 新側の件数 のとき、旧側を新側へコピーして引き継ぐ。
///     新側を上書きする前に世代バックアップを取る。
///     → 「8件の保存先から、空/古い保存先へ切り替えたら消えた」事故を防ぐ
///       (件数の多い/同等な方を必ず勝たせる。古い方を黙って正にしない)。
///   - 新側の方が件数が多いときは新側を尊重しコピーしない。
///   - **コピーに失敗 (Google Drive の os error 13 等) したら、設定変更を中止して
///     元の保存先のままにする**。データは旧側にそのまま残るので消えない。
///
/// `new_root` が空文字列または null なら、デフォルト (アプリデータ
/// ディレクトリ) に戻す。
#[tauri::command]
/// 戻り値: **新しい保存先へコピーできなかった世代バックアップの件数** (0 なら完全成功)。
/// 移行そのものの失敗は Err で返す (この戻り値は「移行は成功したが付随物が残った」警告)。
pub async fn projects_set_data_root(
    state: State<'_, AppState>,
    new_root: Option<String>,
) -> Result<usize, String> {
    let mut settings = StorageSettings::load()?;

    let normalized = new_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(ToOwned::to_owned);

    let old_path = projects_file_path_for(settings.projects_data_root.as_deref())?;
    let new_path = projects_file_path_for(normalized.as_deref())?;

    if old_path != new_path {
        // 旧側が「存在するのに読めない」(os error 13 等) ときは、引き継ぎ可否を
        // 判断できないまま保存先を切り替えると旧データを取りこぼす。中止して保持する。
        let old_count = projects_count_at(&old_path).map_err(|err| {
            format!("保存先の変更を中止しました (データは元の場所に保持されています)。{err}")
        })?;
        // 新側が「存在するのに読めない」ときは中止する (DL-04)。
        // 従来は unwrap_or(0) で **0件とみなして旧側で上書き**していたため、新側に
        // 実データがあって一時的に読めないだけの場合に、その未読データを潰していた。
        // ファイルが存在しない (=新規フォルダ) なら Ok(0) が返るので、切り替えは通る。
        let new_count = projects_count_at(&new_path).map_err(|err| {
            format!(
                "保存先の変更を中止しました (データは元の場所に保持されています)。\
                 切り替え先のプロジェクトデータを読み取れないため、上書きすると失われる可能性があります。{err}"
            )
        })?;

        // 旧側が新側と同等以上の件数を持つときだけ、旧→新へ引き継ぐ。
        // (新側が多いなら新側のデータを尊重して触らない)
        if old_count > 0 && old_count >= new_count {
            if let Some(parent) = new_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("プロジェクトデータ保存先の作成に失敗: {err}"))?;
            }
            // 新側に既存データがあるなら上書き前にバックアップ (戻せるように)。
            // **取れなければ移行を中止**する (DL-03/DL-04: 戻せないまま上書きしない)。
            backup_before_write(&new_path, "切り替え先のプロジェクトデータ")?;
            // コピー失敗時は設定を変更しない = 元の保存先のままデータを保持する。
            fs::copy(&old_path, &new_path).map_err(|err| {
                format!(
                    "保存先の変更を中止しました (データは元の場所に保持されています)。移行に失敗 ({} -> {}): {err}",
                    old_path.display(),
                    new_path.display()
                )
            })?;
        }
    }

    // presets.json も同じ保存先に置かれるため、projects.json と同じポリシーで引き継ぐ。
    // ここを抜くと「保存先を変えたらキャラクター/プリセットが消えた(ように見える)」が
    // 再発する。旧ファイルは残るので不可逆ではないが、参照が外れる時点で実害。
    // (2026-07-30 評価者指摘。projects 側と同じ「件数の多い/同等な方を勝たせる」判定)
    let old_presets = presets_file_path_for(settings.projects_data_root.as_deref())?;
    let new_presets = presets_file_path_for(normalized.as_deref())?;
    if old_presets != new_presets {
        let old_count = presets_count_at(&old_presets).map_err(|err| {
            format!("保存先の変更を中止しました (データは元の場所に保持されています)。{err}")
        })?;
        // 新側が「存在するのに読めない」なら中止 (DL-04。projects 側と同じ理由)。
        let new_count = presets_count_at(&new_presets).map_err(|err| {
            format!(
                "保存先の変更を中止しました (データは元の場所に保持されています)。\
                 切り替え先のプリセットデータを読み取れないため、上書きすると失われる可能性があります。{err}"
            )
        })?;
        if old_count > 0 && old_count >= new_count {
            if let Some(parent) = new_presets.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("プリセット保存先の作成に失敗: {err}"))?;
            }
            backup_before_write(&new_presets, "切り替え先のプリセットデータ")?;
            fs::copy(&old_presets, &new_presets).map_err(|err| {
                format!(
                    "保存先の変更を中止しました (データは元の場所に保持されています)。プリセットの移行に失敗 ({} -> {}): {err}",
                    old_presets.display(),
                    new_presets.display()
                )
            })?;
        }
    }

    // scene3d.json も同じ保存先に置かれるため、projects/presets と同じポリシーで引き継ぐ。
    // (2026-07-30 全ユーザーデータ生存監査 §4: 3Dシーンは presets と同型の時限爆弾)
    let old_scene = scene3d_file_path_for(settings.projects_data_root.as_deref())?;
    let new_scene = scene3d_file_path_for(normalized.as_deref())?;
    if old_scene != new_scene {
        let old_count = scene3d_count_at(&old_scene).map_err(|err| {
            format!("保存先の変更を中止しました (データは元の場所に保持されています)。{err}")
        })?;
        // 新側が「存在するのに読めない」なら中止 (DL-04。projects 側と同じ理由)。
        let new_count = scene3d_count_at(&new_scene).map_err(|err| {
            format!(
                "保存先の変更を中止しました (データは元の場所に保持されています)。\
                 切り替え先の3Dシーンデータを読み取れないため、上書きすると失われる可能性があります。{err}"
            )
        })?;
        if old_count > 0 && old_count >= new_count {
            if let Some(parent) = new_scene.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("3Dシーン保存先の作成に失敗: {err}"))?;
            }
            backup_before_write(&new_scene, "切り替え先の3Dシーンデータ")?;
            fs::copy(&old_scene, &new_scene).map_err(|err| {
                format!(
                    "保存先の変更を中止しました (データは元の場所に保持されています)。3Dシーンの移行に失敗 ({} -> {}): {err}",
                    old_scene.display(),
                    new_scene.display()
                )
            })?;
        }
    }

    // motions.json も同じ保存先に置かれるため、projects/presets/scene3d と同じ
    // ポリシーで引き継ぐ (2026-08-03 gj7)。ここを欠くと「保存先を変えたら
    // 3Dモーションだけ消えた」という新しい取り残しが生まれる。
    // モーションの参照元 (scene3d.json) は上のブロックで移行済みなので、
    // 片方だけ移ると clipId が宙に浮く = gj7 の再発になる。
    let old_motions = motions_file_path_for(settings.projects_data_root.as_deref())?;
    let new_motions = motions_file_path_for(normalized.as_deref())?;
    if old_motions != new_motions {
        let old_count = motions_count_at(&old_motions).map_err(|err| {
            format!("保存先の変更を中止しました (データは元の場所に保持されています)。{err}")
        })?;
        // 新側が「存在するのに読めない」なら中止 (DL-04。projects 側と同じ理由)。
        let new_count = motions_count_at(&new_motions).map_err(|err| {
            format!(
                "保存先の変更を中止しました (データは元の場所に保持されています)。\
                 切り替え先のモーションデータを読み取れないため、上書きすると失われる可能性があります。{err}"
            )
        })?;
        if old_count > 0 && old_count >= new_count {
            if let Some(parent) = new_motions.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("モーション保存先の作成に失敗: {err}"))?;
            }
            backup_before_write(&new_motions, "切り替え先のモーションデータ")?;
            fs::copy(&old_motions, &new_motions).map_err(|err| {
                format!(
                    "保存先の変更を中止しました (データは元の場所に保持されています)。モーションの移行に失敗 ({} -> {}): {err}",
                    old_motions.display(),
                    new_motions.display()
                )
            })?;
        }
    }

    // 4-3 (2026-08-03 l99): 世代バックアップ (*.json.bak-<epoch>) も新側へ運ぶ。
    // 「バックアップから復元」UI (listBackups) は現行 projects_file_path の親だけを
    // 走査するため、ここを欠くと保存先を変えた瞬間に過去世代が UI から消える
    // (ファイル自体は旧側に残るが、ユーザーには到達手段が無い)。
    // 本体 4 ファイルは既にコピー済みなので、ここでの失敗は移行を巻き戻す理由にならない
    // (巻き戻す方がデータを危険にさらす)。ただし**黙って捨てない**: 失敗件数を数え、
    // 設定保存後に警告として返す (DL-04: 世代バックアップの移行失敗も結果として返す)。
    let mut backup_copy_failures = 0usize;
    for (old_file, new_file) in [
        (&old_path, &new_path),
        (&old_presets, &new_presets),
        (&old_scene, &new_scene),
        (&old_motions, &new_motions),
    ] {
        if old_file != new_file {
            backup_copy_failures += copy_generation_backups(old_file, new_file);
        }
    }

    settings.projects_data_root = normalized;
    settings.save()?;
    state.set_storage_settings(settings).await;

    // 世代バックアップのコピー失敗は **Err にしない** (DL-04 の設計判断)。
    // ここで Err を返すと、呼び出し側 (SettingsWorkspace) が catch へ落ちて
    // store の読み直し (initialize 群) をスキップし、「保存先の変更に失敗」と表示する。
    // 実際には移行は完了しているので、UI だけ旧 root を握った偽の失敗になり、
    // 直そうとしている事故より悪い。件数を返り値で報せ、フロントが警告表示する。
    Ok(backup_copy_failures)
}

/// 世代バックアップ (`<file_name>.bak-<epoch>`) を旧側ディレクトリから新側へコピーする。
///
/// - 新側に同名が既にあればスキップ (上書きしない。新側の世代を壊さない)
/// - 個別の失敗は warn した上で**件数を数えて返す** (2026-08-06 DL-04)。
///   移行自体は成功扱いのままだが、黙って捨てずに呼び出し側へ報せる
/// - `old_file` / `new_file` は本体ファイルのパス。その親ディレクトリを走査する
///
/// 戻り値: コピーに失敗した世代バックアップの件数。
#[must_use]
fn copy_generation_backups(old_file: &Path, new_file: &Path) -> usize {
    let file_name = match old_file.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return 0,
    };
    let (old_dir, new_dir) = match (old_file.parent(), new_file.parent()) {
        (Some(o), Some(n)) => (o, n),
        _ => return 0,
    };
    if old_dir == new_dir {
        return 0;
    }
    let prefix = format!("{file_name}.bak-");
    let entries = match fs::read_dir(old_dir) {
        Ok(rd) => rd,
        // 旧側が読めないのは「バックアップが無い」と同じ扱いでよい (best-effort)。
        Err(_) => return 0,
    };
    let mut failures = 0usize;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.starts_with(&prefix) || !path.is_file() {
            continue;
        }
        let dest = new_dir.join(&name);
        if dest.exists() {
            continue; // 既にある世代は上書きしない
        }
        if let Err(err) = fs::copy(&path, &dest) {
            failures += 1;
            tracing::warn!(
                target: "codex.storage",
                "世代バックアップのコピーに失敗 (移行は継続): {} -> {}: {err}",
                path.display(),
                dest.display()
            );
        }
    }
    failures
}

/// presets.json の件数。projects_count_at と同型:
/// 未作成 → Ok(0) / 壊れたJSON → Ok(0) / 存在するが read 失敗 → Err。
/// read 失敗を 0 と混同すると「0件＝引き継ぎ不要」と誤判定して旧データを取りこぼす。
fn presets_count_at(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    match fs::read_to_string(path) {
        Ok(c) => Ok(count_presets(&c).unwrap_or(0)),
        Err(err) => Err(format!(
            "プリセットデータの読み取りに失敗 ({}): {err}",
            path.display()
        )),
    }
}

// ---------------------------------------------------------------------------
// presets.json (プリセット = プロンプト + 登録キャラ) のファイル永続化
// 2026-07-30: プリセットは localStorage のみに保存されていたため、WebView の
// ビルドID (app.codexframefactory / .dev / .capture) ごとに別領域になり、
// ビルドを跨ぐと空に見える + 終了タイミングで失われる。再起動でキャラ/プリセットが
// 消える最重大バグの根治として、projects.json と同じファイル正本方式へ移行する。
//
// 形は projects.json (トップレベル配列) と違い object ({version, categories, presets})。
// 「配列 = projects / object = presets」で取り違えを機械的に検出できるようにするため。
// ---------------------------------------------------------------------------

/// presets.json の保存パス。projects.json と同じ解決規則
/// (StorageSettings.projects_data_root 指定があればその配下、無ければ OS 標準
/// アプリデータディレクトリ)。
fn presets_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    presets_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) から presets.json パスを組み立てる。
///
/// projects 版 (projects_file_path_for) と同型の**意図的な重複**。
/// projects 側は本番稼働中の消失バグ修正経路であり、共通化リファクタの差分リスクが
/// 20 行の重複コストを上回るため、あえて共通化しない。
fn presets_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!(
                        "プリセットデータ保存先の作成に失敗 ({}): {err}",
                        dir.display()
                    )
                })?;
            }
            Ok(dir.join("presets.json"))
        }
        None => {
            let data_dir = dirs::data_dir()
                .ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
            let app_dir = data_dir.join("app.codexframefactory");
            if !app_dir.exists() {
                fs::create_dir_all(&app_dir)
                    .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
            }
            Ok(app_dir.join("presets.json"))
        }
    }
}

/// presets.json (object 形) の `presets` 配列の要素数。object でない/欠落は None。
/// categories は既定値が常に入るため、空上書きガードの分母にしない。
fn count_presets(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => map
            .get("presets")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        _ => None,
    }
}

/// presets_write の直列化ロック。PROJECTS_WRITE_LOCK と同型だが**別 static**。
/// 共有すると projects の保存と presets の保存が互いを待たされる
/// (無関係なファイルへの書き込みで直列化の範囲を広げない)。
static PRESETS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// tmp 名のプロセス内ユニーク化カウンタ (presets 専用、epochナノ秒と併用)。
static PRESETS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// presets.json を読み出す。存在しなければ**空文字列**を返す。
/// 空文字列 = 「ファイル未作成」をフロントが判別して localStorage 移行に入る。
/// (projects_read の "[]" と違い、「未作成」と「空データ」を区別するため空文字を使う)
#[tauri::command]
pub async fn presets_read() -> Result<String, String> {
    let path = presets_file_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("presets.json 読込失敗: {err}"))
}

/// presets.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epochミリ秒, プリセット件数)。
/// 設定画面の「プリセット・キャラクターのバックアップ」UI が使う。
///
/// projects 版 (projects_list_backups) と同型の**意図的な重複**。
/// presets_file_path_for がそうしているのと同じ理由 (共通化リファクタの差分リスクを
/// 取らない)。
#[tauri::command]
pub async fn presets_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = presets_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "presets.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "presets.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = format!("{file_name}.bak-");
    let mut out: Vec<(String, u64, usize)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            let stamp: u64 = name[prefix.len()..].parse().unwrap_or(0);
            let count = fs::read_to_string(&p)
                .ok()
                .and_then(|c| count_presets(&c))
                .unwrap_or(0);
            // 0件のバックアップは復元候補に出さない (projects 版と同じ防御)。
            // 空で復元しても意味がなく、presets_write の空上書きガードに弾かれて
            // 無言で失敗するため。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1)); // 新しい順
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// パスは presets_list_backups が返したものに限定 (prefix 一致で検証)。
/// 任意ファイル読み出しにしない (projects_read_backup と同じ検証方針)。
#[tauri::command]
pub async fn presets_read_backup(backup_path: String) -> Result<String, String> {
    let path = presets_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "presets.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "presets.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    // 任意パス読み出しを防ぐ: 既定のバックアップ命名にマッチするものだけ許可。
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// scene3d.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epochミリ秒, shot(カット)数)。
/// 設定画面の「3Dシーンのバックアップ」UI が使う。
///
/// presets 版 (presets_list_backups) と同型の**意図的な重複**。
/// scene3d_file_path_for がそうしているのと同じ理由 (共通化リファクタの差分リスクを
/// 取らない)。
///
/// 第3要素が presets の「件数」でなく shot 数なのは、3D シーンは単一プロジェクトで
/// 「件数」の概念がないため。復元候補を選ぶとき「何カットのときの状態か」が
/// ユーザーにとって最も分かりやすい手がかりになる。
#[tauri::command]
pub async fn scene3d_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = scene3d_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "scene3d.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "scene3d.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = format!("{file_name}.bak-");
    let mut out: Vec<(String, u64, usize)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with(&prefix) {
                continue;
            }
            let stamp: u64 = name[prefix.len()..].parse().unwrap_or(0);
            let count = fs::read_to_string(&p)
                .ok()
                .and_then(|c| count_scene3d(&c))
                .unwrap_or(0);
            // shot 0 のバックアップは復元候補に出さない (presets 版と同じ防御)。
            // 空で復元しても意味がなく、scene3d_write の空上書きガードに弾かれて
            // 無言で失敗するため。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1)); // 新しい順
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// パスは scene3d_list_backups が返したものに限定 (prefix 一致で検証)。
/// 任意ファイル読み出しにしない (presets_read_backup と同じ検証方針)。
#[tauri::command]
pub async fn scene3d_read_backup(backup_path: String) -> Result<String, String> {
    let path = scene3d_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "scene3d.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "scene3d.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    // 任意パス読み出しを防ぐ: 既定のバックアップ命名にマッチするものだけ許可。
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// presets.json に書き込む (上書き)。projects_write と同型:
/// 直列化 → 空上書きガード → 世代バックアップ → ユニーク tmp → rename (失敗時 tmp 掃除)。
///
/// `backup_projects_file` はパス汎用実装 (ファイル名 prefix を引数パスから導出する) なので、
/// presets.json を渡せばそのまま `presets.json.bak-<epochミリ秒>` の世代管理になり、
/// projects のバックアップとは独立に 2層保持 (直近5 + 日次5) が保たれる。
///
/// `allow_empty`: 0件での上書きを許可するか。通常の保存は false (事故防止)。
///   ユーザー操作による明示的な全削除のときだけ true を渡す。
#[tauri::command]
pub async fn presets_write(content: String, allow_empty: Option<bool>) -> Result<(), String> {
    // 直列化: ガード読取→バックアップ→tmp→rename の全工程を1トランザクションに。
    let _guard = PRESETS_WRITE_LOCK.lock().await;
    let path = presets_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    // 空上書きガード: 既存が非空で今回が0件、かつ明示許可でないなら拒否 (事故防止)。
    // incoming が None (壊れたJSON / object でない) は 0 扱い = 拒否側に倒す
    // (壊れた内容で正本を潰さない)。既存側の None も 0 扱いなので、壊れた既存は
    // 上書きで回復できる (直前に世代バックアップが取られる)。
    // 既存を1回だけ読む。**存在するのに読めないなら書き込みを中止**する (DL-01)。
    let existing = read_existing_for_guard(&path, "プリセットデータ")?;

    if !allow_empty {
        if let Some(existing) = existing.as_deref() {
            let existing_count = count_presets(existing).unwrap_or(0);
            let incoming_count = count_presets(&content).unwrap_or(0);
            if existing_count > 0 && incoming_count == 0 {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "空のプリセットデータで {existing_count} 件を上書きしようとしたため中止しました (データ保護)。意図的な全削除なら allow_empty を指定してください。"
                ));
            }
            // 激減ガード (2026-08-06): 30件 → 1件のような半減以下の上書きを止める。
            // 空上書きガード (0件) だけでは 30→1 が素通りしていた (実ユーザー被害)。
            if let Some((e, i)) = shrink_rejected(existing, &content, count_presets) {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "[SHRINK_GUARD existing={e} incoming={i}] 保存内容 ({i} 件) がディスク上のプリセット ({e} 件) より大幅に少ないため中止しました (データ保護)。意図的な整理なら allow_empty を指定してください。"
                ));
            }
        }
    }

    // 書き込み前に世代バックアップ (presets.json.bak-<epochミリ秒>、最大10世代)。
    // **取れなければ書かない** (DL-03)。
    backup_before_write(&path, "プリセットデータ")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = PRESETS_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("presets.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        // 失敗した tmp は残骸として残さない (掃除失敗は握り潰してよい)。
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("presets.json リネーム失敗: {err}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// scene3d.json (3D シーン = オブジェクト配置・タイムライン・カメラ) のファイル永続化
// 2026-07-30: 3D シーンは localStorage のみに保存されていたため、WebView の
// ビルドID (app.codexframefactory / .dev / .capture) ごとに別領域になり、
// ビルドを跨ぐと空に見える。presets と完全に同型の時限爆弾なので、同じタイミングで
// ファイル正本方式へ移行する。
//
// 形は presets.json と同じ object だが、空上書きガードの分母は `shots` 配列
// (フロント側 scene3d.ts の有効性判定と同じ基準)。
// ---------------------------------------------------------------------------

/// scene3d.json の保存パス。presets.json と同じ解決規則
/// (StorageSettings.projects_data_root 指定があればその配下、無ければ OS 標準
/// アプリデータディレクトリ)。
fn scene3d_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    scene3d_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) から scene3d.json パスを組み立てる。
///
/// presets 版 (presets_file_path_for) と同型の**意図的な重複**。
/// 共通化リファクタの差分リスクを 20 行の重複コストより重く見る方針
/// (presets_file_path_for のコメント参照)。
fn scene3d_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!("3Dシーン保存先の作成に失敗 ({}): {err}", dir.display())
                })?;
            }
            Ok(dir.join("scene3d.json"))
        }
        None => {
            let data_dir = dirs::data_dir()
                .ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
            let app_dir = data_dir.join("app.codexframefactory");
            if !app_dir.exists() {
                fs::create_dir_all(&app_dir)
                    .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
            }
            Ok(app_dir.join("scene3d.json"))
        }
    }
}

/// scene3d.json の「中身の量」。空上書きガードの分母に使う。
/// SceneProject は object で、shots 配列を持つ (scene3d.ts の有効性判定と同じ形)。
/// object でない / shots が無い場合は None (= 壊れているので 0 扱い)。
fn count_scene3d(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => {
            map.get("shots").and_then(|v| v.as_array()).map(|a| a.len())
        }
        _ => None,
    }
}

/// scene3d.json の件数。presets_count_at と同型:
/// 未作成 → Ok(0) / 壊れたJSON → Ok(0) / 存在するが read 失敗 → Err。
/// read 失敗を 0 と混同すると「0件＝引き継ぎ不要」と誤判定して旧データを取りこぼす。
fn scene3d_count_at(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    match fs::read_to_string(path) {
        Ok(c) => Ok(count_scene3d(&c).unwrap_or(0)),
        Err(err) => Err(format!(
            "3Dシーンデータの読み取りに失敗 ({}): {err}",
            path.display()
        )),
    }
}

/// scene3d_write の直列化ロック。PRESETS_WRITE_LOCK と同型だが**別 static**。
/// 共有すると無関係なファイルへの書き込みで直列化の範囲が広がる。
static SCENE3D_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// tmp 名のプロセス内ユニーク化カウンタ (scene3d 専用、epochナノ秒と併用)。
static SCENE3D_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// scene3d.json を読み出す。存在しなければ**空文字列**を返す。
/// 空文字列 = 「ファイル未作成」をフロントが判別して localStorage 移行に入る
/// (presets_read と同じ規約)。
#[tauri::command]
pub async fn scene3d_read() -> Result<String, String> {
    let path = scene3d_file_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("scene3d.json 読込失敗: {err}"))
}

/// scene3d.json に書き込む (上書き)。presets_write と同型:
/// 直列化 → 空上書きガード → 世代バックアップ → ユニーク tmp → rename (失敗時 tmp 掃除)。
///
/// `backup_projects_file` はパス汎用実装なので、scene3d.json を渡せばそのまま
/// `scene3d.json.bak-<epochミリ秒>` の世代管理になる。
///
/// `allow_empty`: shots 0 件での上書きを許可するか。通常の保存は false (事故防止)。
#[tauri::command]
pub async fn scene3d_write(content: String, allow_empty: Option<bool>) -> Result<(), String> {
    // 直列化: ガード読取→バックアップ→tmp→rename の全工程を1トランザクションに。
    let _guard = SCENE3D_WRITE_LOCK.lock().await;
    let path = scene3d_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    // 空上書きガード: 既存が非空で今回が0件、かつ明示許可でないなら拒否 (事故防止)。
    // incoming が None (壊れたJSON / object でない) は 0 扱い = 拒否側に倒す。
    // 既存を1回だけ読む。**存在するのに読めないなら書き込みを中止**する (DL-01)。
    let existing = read_existing_for_guard(&path, "3Dシーンデータ")?;

    if !allow_empty {
        if let Some(existing) = existing.as_deref() {
            let existing_count = count_scene3d(existing).unwrap_or(0);
            let incoming_count = count_scene3d(&content).unwrap_or(0);
            if existing_count > 0 && incoming_count == 0 {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "空の3Dシーンデータで {existing_count} 件のカットを上書きしようとしたため中止しました (データ保護)。"
                ));
            }
            // 激減ガード (2026-08-06): presets と同基準。半減以下の上書きを止める。
            if let Some((e, i)) = shrink_rejected(existing, &content, count_scene3d) {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "[SHRINK_GUARD existing={e} incoming={i}] 保存内容 ({i} 件) がディスク上の3Dシーン ({e} 件) より大幅に少ないため中止しました (データ保護)。"
                ));
            }
        }
    }

    // 書き込み前に世代バックアップ (scene3d.json.bak-<epochミリ秒>、最大10世代)。
    // **取れなければ書かない** (DL-03)。
    backup_before_write(&path, "3Dシーンデータ")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SCENE3D_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("scene3d.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        // 失敗した tmp は残骸として残さない (掃除失敗は握り潰してよい)。
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("scene3d.json リネーム失敗: {err}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// motions.json (3D モーション = AI生成/動画取り込みのキーフレーム仕様) のファイル永続化
// 2026-08-03 (gj7): モーション仕様は localStorage のみに保存されていたため、WebView の
// ビルドID (app.codexframefactory / .dev / .capture) ごとに別領域になり、ビルドを
// 跨ぐと空に見える + WebView データ消去で全損する。scene3d.json に残ったシーン側の
// clipId だけが宙に浮き「シーンは残るのにモーションだけ消える」状態になるため、
// 参照元 (scene3d.json) と同じ保存 regime へ揃えて生死を構造的に一致させる。
//
// scene3d.json への同居にしないのは、動画取り込みモーションが 24fps サンプリングで
// MB 級になり、scene3d 側の「シーンJSONは数KB」前提 (毎 project 変更での同期
// stringify + 10世代バックアップ) を壊すため。
//
// 形は presets/scene3d と同じ object ({version, motions})。
// 「配列 = projects / object = それ以外」で取り違えを機械的に検出できるようにする。
// ---------------------------------------------------------------------------

/// motions.json の保存パス。presets.json と同じ解決規則
/// (StorageSettings.projects_data_root 指定があればその配下、無ければ OS 標準
/// アプリデータディレクトリ)。
fn motions_file_path() -> Result<PathBuf, String> {
    let settings = StorageSettings::load()?;
    motions_file_path_for(settings.projects_data_root.as_deref())
}

/// projectsDataRoot (Option) から motions.json パスを組み立てる。
///
/// presets 版 (presets_file_path_for) と同型の**意図的な重複**
/// (共通化リファクタの差分リスクを 20 行の重複コストより重く見る方針)。
fn motions_file_path_for(projects_data_root: Option<&str>) -> Result<PathBuf, String> {
    let root = projects_data_root.map(str::trim).filter(|r| !r.is_empty());
    match root {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.exists() {
                fs::create_dir_all(&dir).map_err(|err| {
                    format!(
                        "モーションデータ保存先の作成に失敗 ({}): {err}",
                        dir.display()
                    )
                })?;
            }
            Ok(dir.join("motions.json"))
        }
        None => {
            let data_dir = dirs::data_dir()
                .ok_or_else(|| "アプリデータディレクトリの解決に失敗".to_string())?;
            let app_dir = data_dir.join("app.codexframefactory");
            if !app_dir.exists() {
                fs::create_dir_all(&app_dir)
                    .map_err(|err| format!("アプリディレクトリ作成失敗: {err}"))?;
            }
            Ok(app_dir.join("motions.json"))
        }
    }
}

/// motions.json (object 形) の `motions` 配列の要素数。object でない/欠落は None。
/// 空上書きガードの分母に使う。
fn count_motions(content: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(serde_json::Value::Object(map)) => map
            .get("motions")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        _ => None,
    }
}

/// motions.json の件数。presets_count_at と同型:
/// 未作成 → Ok(0) / 壊れたJSON → Ok(0) / 存在するが read 失敗 → Err。
/// read 失敗を 0 と混同すると「0件＝引き継ぎ不要」と誤判定して旧データを取りこぼす。
fn motions_count_at(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    match fs::read_to_string(path) {
        Ok(c) => Ok(count_motions(&c).unwrap_or(0)),
        Err(err) => Err(format!(
            "モーションデータの読み取りに失敗 ({}): {err}",
            path.display()
        )),
    }
}

/// motions_write の直列化ロック。PRESETS_WRITE_LOCK と同型だが**別 static**。
/// 共有すると無関係なファイルへの書き込みで直列化の範囲が広がる。
static MOTIONS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// tmp 名のプロセス内ユニーク化カウンタ (motions 専用、epochナノ秒と併用)。
static MOTIONS_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// motions.json を読み出す。存在しなければ**空文字列**を返す。
/// 空文字列 = 「ファイル未作成」をフロントが判別して localStorage 移行に入る
/// (presets_read / scene3d_read と同じ規約)。
#[tauri::command]
pub async fn motions_read() -> Result<String, String> {
    let path = motions_file_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("motions.json 読込失敗: {err}"))
}

/// motions.json の世代バックアップ一覧を返す (新しい順)。
/// 各要素は (バックアップ絶対パス, epochミリ秒, モーション件数)。
///
/// presets 版 (presets_list_backups) と同型の**意図的な重複**
/// (共通化リファクタの差分リスクを取らない、既存3実装と同じ方針)。
///
/// 2026-08-06 新設: motions だけバックアップは作られていたのに一覧コマンドが
/// 無く、**到達導線ゼロ**だった (scene3d が 2026-07-30 に塞いだのと同じ穴)。
#[tauri::command]
pub async fn motions_list_backups() -> Result<Vec<(String, u64, usize)>, String> {
    let path = motions_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "motions.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "motions.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = format!("{file_name}.bak-");
    let mut out: Vec<(String, u64, usize)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let stamp = match backup_stamp(&name, &prefix) {
                Some(s) => s,
                None => continue,
            };
            let count = fs::read_to_string(&p)
                .ok()
                .and_then(|c| count_motions(&c))
                .unwrap_or(0);
            // 0件のバックアップは復元候補に出さない (他3実装と同じ防御)。
            if count == 0 {
                continue;
            }
            out.push((p.to_string_lossy().into_owned(), stamp, count));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1)); // 新しい順
    Ok(out)
}

/// 指定したバックアップファイルの中身 (JSON文字列) を返す。
/// パスは motions_list_backups が返したものに限定 (prefix 一致で検証)。
/// 任意ファイル読み出しにしない (presets_read_backup と同じ検証方針)。
#[tauri::command]
pub async fn motions_read_backup(backup_path: String) -> Result<String, String> {
    let path = motions_file_path()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "motions.json パス解決失敗".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "motions.json 親ディレクトリ解決失敗".to_string())?;
    let prefix = dir.join(format!("{file_name}.bak-"));
    let bak = PathBuf::from(&backup_path);
    if !backup_path.starts_with(&*prefix.to_string_lossy()) || !bak.exists() {
        return Err("不正なバックアップパスです".to_string());
    }
    fs::read_to_string(&bak).map_err(|err| format!("バックアップ読込失敗: {err}"))
}

/// motions.json に書き込む (上書き)。presets_write と同型:
/// 直列化 → 空上書きガード → 世代バックアップ → ユニーク tmp → rename (失敗時 tmp 掃除)。
///
/// `backup_projects_file` はパス汎用実装なので、motions.json を渡せばそのまま
/// `motions.json.bak-<epochミリ秒>` の世代管理になる。
///
/// 空上書きガードの判定本体。「既存が非空 かつ 今回が0件」なら拒否 (Some(既存件数))。
///
/// motions_write から切り出しているのは**テストのため**。motions_write 本体は
/// StorageSettings 経由で実パスを解決するので単体テストから叩けず、判定だけを
/// 別関数にしないとガードが本当に効くかを機械検査できない
/// (テストが本体と別実装になると「自分と同じ誤りで一致する」型の無力な検査になる)。
fn motions_empty_overwrite_rejected(existing: &str, incoming: &str) -> Option<usize> {
    let existing_count = count_motions(existing).unwrap_or(0);
    let incoming_count = count_motions(incoming).unwrap_or(0);
    if existing_count > 0 && incoming_count == 0 {
        Some(existing_count)
    } else {
        None
    }
}

/// `allow_empty`: motions 0 件での上書きを許可するか。通常の保存は false (事故防止)。
///   ユーザー操作で最後の 1 件を削除したときだけ true を渡す。
#[tauri::command]
pub async fn motions_write(content: String, allow_empty: Option<bool>) -> Result<(), String> {
    // 直列化: ガード読取→バックアップ→tmp→rename の全工程を1トランザクションに。
    let _guard = MOTIONS_WRITE_LOCK.lock().await;
    let path = motions_file_path()?;
    let allow_empty = allow_empty.unwrap_or(false);

    // 空上書きガード: 既存が非空で今回が0件、かつ明示許可でないなら拒否 (事故防止)。
    // incoming が None (壊れたJSON / object でない) は 0 扱い = 拒否側に倒す。
    // 既存を1回だけ読む。**存在するのに読めないなら書き込みを中止**する (DL-01)。
    let existing = read_existing_for_guard(&path, "モーションデータ")?;

    if !allow_empty {
        if let Some(existing) = existing.as_deref() {
            if let Some(existing_count) = motions_empty_overwrite_rejected(existing, &content) {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "空のモーションデータで {existing_count} 件を上書きしようとしたため中止しました (データ保護)。意図的な全削除なら allow_empty を指定してください。"
                ));
            }
            // 激減ガード (2026-08-06): presets と同基準。半減以下の上書きを止める。
            if let Some((e, i)) = shrink_rejected(existing, &content, count_motions) {
                let _ = backup_projects_file(&path);
                return Err(format!(
                    "[SHRINK_GUARD existing={e} incoming={i}] 保存内容 ({i} 件) がディスク上のモーション ({e} 件) より大幅に少ないため中止しました (データ保護)。意図的な整理なら allow_empty を指定してください。"
                ));
            }
        }
    }

    // 書き込み前に世代バックアップ (motions.json.bak-<epochミリ秒>、最大10世代)。
    // **取れなければ書かない** (DL-03)。
    backup_before_write(&path, "モーションデータ")?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = MOTIONS_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_extension(format!("json.tmp-{nanos}-{seq}"));
    write_file_synced(&tmp_path, &content)
        .map_err(|err| format!("motions.json 一時書込失敗: {err}"))?;
    if let Err(err) = fs::rename(&tmp_path, &path) {
        // 失敗した tmp は残骸として残さない (掃除失敗は握り潰してよい)。
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("motions.json リネーム失敗: {err}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// atomic_write_text が (a) 新規書き込み (b) 上書き (c) tmp 残骸ゼロ を満たすこと (4vv)。
    ///
    /// なぜ要るか: storage-settings.json は保存先指定と previous_storage_roots を持つ
    /// 単一障害点で、書き込み中断で壊れると .broken 退避 + 既定値フォールバックにより
    /// 両方を同時に失う。tmp → rename が本当に効いているかを機械検査する。
    #[test]
    fn atomic_write_text_writes_overwrites_and_leaves_no_tmp() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("gori-atomic-write-test-{nanos}"));
        fs::create_dir_all(&dir).expect("テスト用ディレクトリ作成");
        let path = dir.join("storage-settings.json");

        // (a) 新規パスに書けて内容が一致する
        atomic_write_text(&path, "{\"a\":1}").expect("新規書き込み");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        // (b) 既存ファイルへの上書きで内容が置き換わる
        atomic_write_text(&path, "{\"b\":2}").expect("上書き");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"b\":2}");

        // (c) 書き込み後に *.json.tmp-* の残骸が無い
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("ディレクトリ走査")
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.contains(".json.tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp 残骸が残っている: {leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 大幅減少ガードの判定が閾値どおりに効くこと (ywf)。
    ///
    /// なぜ要るか: クラウド同期で巻き戻った古いコピー (1 件) が新しい正本 (10 件) を
    /// 後勝ち上書きする経路を止めるのが目的。同時に、1 件ずつの通常削除
    /// (N → N-1) や小規模データで誤爆しないことが実用上の必須条件。
    #[test]
    fn projects_decrease_guard_rejects_only_large_drops() {
        let make = |n: usize| {
            let items: Vec<String> = (0..n).map(|i| format!("{{\"id\":\"p{i}\"}}")).collect();
            format!("[{}]", items.join(","))
        };

        // 10 件 → 1 件: 半分未満なので拒否
        assert_eq!(
            projects_decrease_rejected(&make(10), &make(1)),
            Some((10, 1))
        );
        // 10 件 → 5 件: ちょうど半分は通す (5*2 < 10 は偽)
        assert_eq!(projects_decrease_rejected(&make(10), &make(5)), None);
        // 3 件 → 1 件: 閾値ちょうどで発火する
        assert_eq!(projects_decrease_rejected(&make(3), &make(1)), Some((3, 1)));
        // 2 件 → 1 件: 既存が閾値未満なので発火しない (小規模データの誤爆防止)
        assert_eq!(projects_decrease_rejected(&make(2), &make(1)), None);
        // 10 件 → 0 件: 空上書きガードの担当なのでここでは見ない
        assert_eq!(projects_decrease_rejected(&make(10), &make(0)), None);
        // 壊れた JSON の incoming は 0 扱い = このガードの対象外 (空ガードが拒否する)
        assert_eq!(projects_decrease_rejected(&make(10), "not json"), None);
    }

    /// S4 の牙: presets の激減ガードが 30 → 1 を拒否すること (2026-08-06 実被害)。
    ///
    /// なぜ要るか: 実ユーザーのプリセット 30 体消失では、空上書きガード (0件) だけが
    /// あり「30件 → 1件」が素通りしていた。0 は特別な値ではなく、少数への激減も
    /// 同じ事故なので、閾値付きで止める。
    ///
    /// 壊し方の実証 (2026-08-06 実施): shrink_rejected の `incoming_count * 2 <
    /// existing_count` を `incoming_count == 0` に変えると、30→1 のケースが
    /// `Some((30, 1))` を返さなくなり本テストは落ちる。
    #[test]
    fn presets_shrink_guard_rejects_only_large_drops() {
        let make = |n: usize| {
            let items: Vec<String> = (0..n).map(|i| format!("{{\"id\":\"x{i}\"}}")).collect();
            format!(r#"{{"version":1,"categories":[],"presets":[{}]}}"#, items.join(","))
        };

        // 30 件 → 1 件: 実被害と同じ形。必ず拒否する
        assert_eq!(
            shrink_rejected(&make(30), &make(1), count_presets),
            Some((30, 1))
        );
        // 10 件 → 4 件: 半分未満なので拒否 (閾値ちょうどの既存件数で発火する)
        assert_eq!(
            shrink_rejected(&make(10), &make(4), count_presets),
            Some((10, 4))
        );
        // 10 件 → 5 件: ちょうど半分は通す (正当な整理を妨げない)
        assert_eq!(shrink_rejected(&make(10), &make(5), count_presets), None);
        // 9 件 → 1 件: 既存が閾値 (10) 未満なので発火しない。
        // プリセットは少数時に 1〜2 件ずつ整理する運用が普通で、誤爆コストが高い
        assert_eq!(shrink_rejected(&make(9), &make(1), count_presets), None);
        // 30 件 → 29 件: 通常の 1 件削除は当然通す
        assert_eq!(shrink_rejected(&make(30), &make(29), count_presets), None);
        // 30 件 → 0 件: 空上書きガードの担当なのでここでは見ない (二重拒否しない)
        assert_eq!(shrink_rejected(&make(30), &make(0), count_presets), None);
    }

    /// S4 の牙 (同型展開): scene3d / motions でも同じ判定が効くこと。
    ///
    /// なぜ同じテストを分けるか: count 関数が違う (shots / motions) ため、
    /// 数える対象を取り違えると presets だけ守られて他が素通りする。
    #[test]
    fn scene3d_and_motions_shrink_guards_use_their_own_counters() {
        let shots = |n: usize| {
            let items: Vec<String> = (0..n).map(|i| format!("{{\"id\":\"s{i}\"}}")).collect();
            format!(r#"{{"shots":[{}]}}"#, items.join(","))
        };
        let motions = |n: usize| {
            let items: Vec<String> = (0..n).map(|i| format!("{{\"id\":\"m{i}\"}}")).collect();
            format!(r#"{{"version":1,"motions":[{}]}}"#, items.join(","))
        };

        assert_eq!(
            shrink_rejected(&shots(30), &shots(1), count_scene3d),
            Some((30, 1))
        );
        assert_eq!(shrink_rejected(&shots(30), &shots(29), count_scene3d), None);

        assert_eq!(
            shrink_rejected(&motions(30), &motions(1), count_motions),
            Some((30, 1))
        );
        assert_eq!(
            shrink_rejected(&motions(30), &motions(29), count_motions),
            None
        );
    }

    /// S5 の牙: write_file_synced が中身を確実に書けること。
    ///
    /// fsync 自体は単体テストで観測できない (OS がキャッシュを返すため) が、
    /// 「書けている・上書きできる」という最低条件は固定する。sync_all を消しても
    /// このテストは通るので、fsync の有無は本テストではなくコードレビューで担保する
    /// (指標より目的: 観測できないものを観測したと偽らない)。
    #[test]
    fn write_file_synced_writes_and_overwrites() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("gori-synced-write-test-{nanos}"));
        fs::create_dir_all(&dir).expect("テスト用ディレクトリ作成");
        let path = dir.join("presets.json");

        write_file_synced(&path, r#"{"a":1}"#).expect("新規書き込み");
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);

        write_file_synced(&path, r#"{"b":2}"#).expect("上書き");
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"b":2}"#);

        let _ = fs::remove_dir_all(&dir);
    }

    /// motions.json の空上書きガードが本当に効くこと (gj7 DoD-4)。
    ///
    /// なぜ要るか: モーションは AI 生成トークン / 動画取り込み作業の成果物で
    /// 再生成コストが高い。初期化前の空 state が誤ってファイルへ流れると
    /// 全損するので、「非空 → 0件」だけを機械的に拒否できているかを検査する。
    #[test]
    fn motions_empty_overwrite_guard_rejects_only_nonempty_to_zero() {
        let two = r#"{"version":1,"motions":[{"id":"a"},{"id":"b"}]}"#;
        let zero = r#"{"version":1,"motions":[]}"#;

        // 非空 → 0件: 拒否する (件数を返す)
        assert_eq!(motions_empty_overwrite_rejected(two, zero), Some(2));
        // 壊れたJSON / object でない incoming も 0 扱い = 拒否側に倒す
        assert_eq!(motions_empty_overwrite_rejected(two, "not json"), Some(2));
        assert_eq!(motions_empty_overwrite_rejected(two, "[]"), Some(2));

        // 通常の保存 (非空 → 非空) は通す
        assert_eq!(motions_empty_overwrite_rejected(two, two), None);
        // 既存が空 / 未作成相当なら 0件を書いてよい (ガードの対象外)
        assert_eq!(motions_empty_overwrite_rejected(zero, zero), None);
        assert_eq!(motions_empty_overwrite_rejected("", zero), None);
    }

    /// count_motions が「motions 配列長」だけを見ること。
    /// projects.json (トップレベル配列) を誤って渡しても None = 0 扱いになり、
    /// 取り違えたファイルの件数でガードが誤作動しない。
    #[test]
    fn count_motions_counts_only_object_motions_array() {
        assert_eq!(
            count_motions(r#"{"version":1,"motions":[{"id":"a"}]}"#),
            Some(1)
        );
        assert_eq!(count_motions(r#"{"version":1,"motions":[]}"#), Some(0));
        // トップレベル配列 (projects.json の形) は None
        assert_eq!(count_motions(r#"[{"id":"a"}]"#), None);
        // motions キー欠落 (presets.json 等を取り違え) も None
        assert_eq!(
            count_motions(r#"{"version":1,"presets":[{"id":"a"}]}"#),
            None
        );
        assert_eq!(count_motions("broken"), None);
    }

    /// 4-1 (l99): 保存先を 6 回以上変えても旧 root が 1 件も落ちないこと。
    ///
    /// なぜこのテストが要るか: 以前は 5 世代で truncate していた。6 回目の変更で
    /// 最古 root が履歴から落ちると、prune ガード第 2 段 (images.rs「settings に
    /// 載っている旧 root が読めない間は消さない」) の保護外になり、その root の
    /// 画像が次回起動の relink (allow_prune=true) で history.db から削除される。
    /// 上限がある限り同型の時限爆弾が残るので、上限そのものが無いことを固定する。
    #[test]
    fn previous_roots_keep_all_generations_without_truncation() {
        let mut history: Vec<String> = Vec::new();
        // /root0 → /root1 → ... → /root7 と 7 回変更する。
        for i in 0..7 {
            let previous = format!("/root{i}");
            let current = format!("/root{}", i + 1);
            history = push_previous_root(&history, &previous, &current);
        }
        // 旧 root は全 7 件が新しい順で残る (KEEP=5 時代なら 5 件で落ちていた)。
        assert_eq!(
            history.len(),
            7,
            "旧 root が truncate されている: {history:?}"
        );
        assert_eq!(
            history,
            vec!["/root6", "/root5", "/root4", "/root3", "/root2", "/root1", "/root0",]
        );
    }

    /// 重複排除と「現行 root は履歴に残さない」フィルタは無上限化後も維持されること。
    #[test]
    fn previous_roots_dedupe_and_exclude_current() {
        // 同じ root へ戻ったケース: /a → /b → /a。履歴に /a が 2 つ並ばない。
        let history = push_previous_root(&["/a".to_string()], "/b", "/a");
        // 現行 root (/a) は履歴から除かれ、/b だけが残る。
        assert_eq!(history, vec!["/b"]);

        // 既に履歴にある root を再び previous として積んでも重複しない。
        let history = push_previous_root(&["/x".to_string(), "/y".to_string()], "/y", "/z");
        assert_eq!(history, vec!["/y", "/x"]);
    }

    /// 4-3 (l99): 世代バックアップが新しい保存先へコピーされること。
    /// 新側に同名が既にあれば上書きしないこと (新側の世代を壊さない)。
    #[test]
    fn generation_backups_are_copied_without_clobbering() {
        let old_dir = tempfile::tempdir().unwrap();
        let new_dir = tempfile::tempdir().unwrap();
        let old_file = old_dir.path().join("projects.json");
        let new_file = new_dir.path().join("projects.json");

        // 旧側: 本体 + 世代バックアップ 2 件 + 無関係ファイル
        fs::write(&old_file, b"[]").unwrap();
        fs::write(old_dir.path().join("projects.json.bak-123"), b"old-123").unwrap();
        fs::write(old_dir.path().join("projects.json.bak-456"), b"old-456").unwrap();
        // 別ファイルのバックアップは対象外 (prefix が違う)
        fs::write(old_dir.path().join("presets.json.bak-999"), b"presets").unwrap();

        // 新側: bak-456 が既にある (中身が違う = 上書きされたら判る)
        fs::write(&new_file, b"[]").unwrap();
        fs::write(new_dir.path().join("projects.json.bak-456"), b"new-456").unwrap();

        copy_generation_backups(&old_file, &new_file);

        // 新側に無かった bak-123 はコピーされる
        assert_eq!(
            fs::read_to_string(new_dir.path().join("projects.json.bak-123")).unwrap(),
            "old-123"
        );
        // 既にあった bak-456 は上書きされない
        assert_eq!(
            fs::read_to_string(new_dir.path().join("projects.json.bak-456")).unwrap(),
            "new-456"
        );
        // 別ファイルのバックアップは運ばれない
        assert!(!new_dir.path().join("presets.json.bak-999").exists());
    }

    /// 同一ディレクトリ (保存先が実質変わっていない) なら何もしないこと。
    #[test]
    fn generation_backups_skip_when_same_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("projects.json");
        fs::write(&file, b"[]").unwrap();
        fs::write(dir.path().join("projects.json.bak-1"), b"x").unwrap();

        copy_generation_backups(&file, &file);

        // 自分自身へのコピーで内容が壊れていないこと
        assert_eq!(
            fs::read_to_string(dir.path().join("projects.json.bak-1")).unwrap(),
            "x"
        );
    }

    /// 壊れた設定が2回続けて出ても、1回目の退避を潰さないこと。
    ///
    /// なぜこのテストが要るか: 退避先が固定名だと、2回目の電源断で
    /// 「ユーザーが設定した保存先パスが残る唯一の記録」が消える。
    #[test]
    fn quarantine_does_not_clobber_previous_backup() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("storage-settings.json");

        let first = next_free_backup_path(&settings);
        assert_eq!(first.file_name().unwrap(), "storage-settings.json.broken");
        fs::write(&first, b"1st").unwrap();

        let second = next_free_backup_path(&settings);
        assert_eq!(
            second.file_name().unwrap(),
            "storage-settings.json.broken.2"
        );
        fs::write(&second, b"2nd").unwrap();

        let third = next_free_backup_path(&settings);
        assert_eq!(third.file_name().unwrap(), "storage-settings.json.broken.3");

        // 先に退避した中身が生きていること (上書きされていない)
        assert_eq!(fs::read_to_string(&first).unwrap(), "1st");
        assert_eq!(fs::read_to_string(&second).unwrap(), "2nd");
    }

    /// 既定の保存先が `Pictures` を二重に重ねないこと。**両分岐を叩く。**
    ///
    /// なぜ引数渡しにするか: home がある分岐しか macOS/Linux では実行されない
    /// ため、`default_storage_root_string()` をそのまま呼ぶテストでは
    /// picture_dir 側のデグレ (Pictures 二重) を検出できない。
    #[test]
    fn default_storage_root_has_no_duplicated_pictures_segment() {
        // home がある場合: ~/Pictures/GORI GORI
        let with_home = default_storage_root_from(
            Some(PathBuf::from("/home/taro")),
            Some(PathBuf::from("/home/taro/Pictures")),
        );
        assert_eq!(with_home, "/home/taro/Pictures/GORI GORI");

        // home が無い場合: picture_dir はすでに Pictures を含むので足さない
        let without_home =
            default_storage_root_from(None, Some(PathBuf::from("/home/taro/Pictures")));
        assert_eq!(
            without_home, "/home/taro/Pictures/GORI GORI",
            "picture_dir 分岐で Pictures が二重になっている"
        );

        // 実環境の値でも二重にならないこと
        let actual = default_storage_root_string();
        assert!(
            !actual.contains("Pictures/Pictures") && !actual.contains("Pictures\\Pictures"),
            "既定の保存先で Pictures が二重になっている: {actual}"
        );
        assert!(actual.ends_with("GORI GORI"));
    }

    /// 設定ファイルのパスに macOS 固有の `Library/Application Support` を
    /// 焼き込まないこと。**Windows 相当のパスを渡して検査する。**
    ///
    /// なぜ実環境の data_dir() と比較しないか: macOS では data_dir() が
    /// `~/Library/Application Support` を返すため、**修正前の macOS 決め打ち
    /// 実装でもそのテストは緑になる**。守りたい退行 (Windows で設定が
    /// 永続しない) をまったく検出しないので、検査として無意味だった。
    #[test]
    fn settings_path_does_not_hardcode_macos_layout() {
        let win_data_dir = PathBuf::from(r"C:\Users\taro\AppData\Roaming");
        let path = settings_path_in(&win_data_dir);

        assert!(
            path.starts_with(&win_data_dir),
            "渡した data_dir の下に無い: {}",
            path.display()
        );
        let shown = path.to_string_lossy();
        assert!(
            !shown.contains("Library"),
            "macOS 固有の Library が混入している: {shown}"
        );
        assert!(path.ends_with(SETTINGS_FILE));

        // 実環境でも data_dir 起点であること
        assert!(settings_path().unwrap().ends_with(SETTINGS_FILE));
    }

    /// 旧パス(移行元)は macOS レイアウトのままであること。
    ///
    /// なぜ検査するか: ここを「直そう」として data_dir 起点に変えると、
    /// 新パスと同一になって**移行元を見失う**（Windows ユーザーの保存先が
    /// 引き継がれなくなる）。意図的に古い形を保つ場所だと明示する。
    #[test]
    fn legacy_path_keeps_macos_layout_on_purpose() {
        let legacy = legacy_settings_path().expect("home dir");
        let shown = legacy.to_string_lossy();
        assert!(
            shown.contains("Library/Application Support"),
            "移行元の旧パスが macOS レイアウトでない: {shown}"
        );
        assert!(legacy.ends_with(SETTINGS_FILE));
    }

    // -----------------------------------------------------------------------
    // U1 / U2: バックアップ形式のロジック (2026-08-06)
    // -----------------------------------------------------------------------

    /// テスト用の一時ディレクトリ。テスト名でユニーク化する
    /// (`Date.now()` 的な実行時値をアサートに使わない = 規律3)。
    fn temp_dir_for(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("gori-backup-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("テスト用ディレクトリ作成");
        dir
    }

    /// **U1 受入基準2**: .bak が 0 件 + 対象ファイルが存在する状態で
    /// 起動相当の処理を通すと、1 世代できること。
    ///
    /// これが今回の実害の本命。従来は `backup_projects_file` が保存の直前しか
    /// 走らず、移行したきり保存していないユーザーは .bak が 1 つも無いまま
    /// 「バックアップがありません」と表示されていた。
    #[test]
    fn daily_backup_creates_first_generation_when_none_exists() {
        let dir = temp_dir_for("first-gen");
        let path = dir.join("presets.json");
        fs::write(&path, r#"{"version":1,"presets":[{"id":"a"}]}"#).expect("正本作成");

        // 前提: .bak は 1 つも無い
        assert_eq!(latest_backup_stamp(&path), None, "前提: .bak が無いこと");

        let now_ms = 1_700_000_000_000u64; // 固定値 (実行時刻に依存させない)
        let created = ensure_daily_backup_for(&path, now_ms);

        assert!(created, "0件の状態からは必ず1世代作られること");
        let baks: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("presets.json.bak-")
            })
            .collect();
        assert_eq!(baks.len(), 1, "ちょうど1世代できること");

        // 中身が正本と一致する (空ファイルを作って満足しない)
        let content = fs::read_to_string(baks[0].path()).unwrap();
        assert!(content.contains("\"id\":\"a\""), "バックアップ中身が正本と一致");

        let _ = fs::remove_dir_all(&dir);
    }

    /// **U1 の牙**: 判定ロジックが本当に条件を見ているか。
    ///
    /// わざと条件を崩したケースで false になることを確認する
    /// (常に true を返す実装では通らない)。
    #[test]
    fn daily_backup_due_respects_each_condition() {
        let now = 1_700_000_000_000u64;
        let interval = DAILY_BACKUP_INTERVAL_MS;

        // .bak が無く、ファイルが非空 → 取る (本命ケース)
        assert!(daily_backup_due(true, None, now, interval));

        // ファイルが存在しない/空 → 取らない (空を守っても意味がない)
        assert!(
            !daily_backup_due(false, None, now, interval),
            "空ファイルはバックアップしない"
        );

        // 直近 (1時間前) に .bak がある → 取らない (起動のたびに増やさない)
        assert!(
            !daily_backup_due(true, Some(now - 3_600_000), now, interval),
            "24時間以内に .bak があれば作らない"
        );

        // 25時間前が最新 → 取る
        assert!(
            daily_backup_due(true, Some(now - 25 * 3_600_000), now, interval),
            "24時間より古ければ作る"
        );

        // ちょうど境界 (24時間丁度) は取る側
        assert!(daily_backup_due(true, Some(now - interval), now, interval));
    }

    /// **U1 の牙 (2)**: 24時間以内に .bak があるとき、実際に増えないこと。
    /// 起動を繰り返してもバックアップが無限に増えない保証。
    #[test]
    fn daily_backup_is_noop_when_recent_backup_exists() {
        let dir = temp_dir_for("noop");
        let path = dir.join("presets.json");
        fs::write(&path, r#"{"version":1,"presets":[{"id":"a"}]}"#).expect("正本作成");

        let now_ms = 1_700_000_000_000u64;
        // 1時間前の .bak を仕込む
        fs::write(dir.join(format!("presets.json.bak-{}", now_ms - 3_600_000)), "{}")
            .expect(".bak 仕込み");

        let created = ensure_daily_backup_for(&path, now_ms);
        assert!(!created, "直近に .bak があれば作らない");

        let count = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("presets.json.bak-")
            })
            .count();
        assert_eq!(count, 1, "世代が増えていないこと");

        let _ = fs::remove_dir_all(&dir);
    }

    /// **U2 受入基準3**: 連続12回保存しても、日付の異なる世代が残ること。
    ///
    /// 従来の「新しい順に10件」だと、連続保存で全世代が直近数分に偏り、
    /// **事故前のスナップショットが押し出されて消えた**。2層保持
    /// (直近5 + 日次5) がそれを防ぐことを固定する。
    #[test]
    fn consecutive_saves_do_not_evict_older_days() {
        let day = DAY_MS;
        let base = 1_700_000_000_000u64;
        // 4日前・3日前・2日前・1日前に1世代ずつ (過去の日次スナップショット)
        let mut stamps: Vec<u64> = vec![
            base - 4 * day,
            base - 3 * day,
            base - 2 * day,
            base - day,
        ];
        // 今日、連続で12回保存 (1分間隔)
        for i in 0..12 {
            stamps.push(base + i * 60_000);
        }

        let keep = backups_to_keep(&stamps);

        // 過去4日分がすべて生き残っていること (これが本命)
        for (i, old) in [base - 4 * day, base - 3 * day, base - 2 * day, base - day]
            .iter()
            .enumerate()
        {
            assert!(
                keep.contains(old),
                "{i} 日前のスナップショットが連続保存で押し出された: {old}"
            );
        }

        // 直近層として今日の最新5世代も残っていること
        for i in 7..12 {
            assert!(
                keep.contains(&(base + i * 60_000)),
                "直近層が保持されていない: {i}"
            );
        }

        // 今日の古い方 (直近5に入らない分) は間引かれていること
        // = 無制限に貯め込む実装では通らない
        assert!(
            !keep.contains(&base),
            "今日の最古の世代は直近層から押し出されるはず (無制限保持になっている)"
        );
    }

    /// **U2 の牙**: 同じ日の世代を日次層が重複して抱えないこと。
    /// (日付判定をしていない実装 = 「単に15件残す」では通らない)
    #[test]
    fn daily_tier_keeps_one_per_distinct_day() {
        let day = DAY_MS;
        let base = 1_700_000_000_000u64;
        let mut stamps: Vec<u64> = Vec::new();
        // 今日 6 世代 (直近層が埋まる)
        for i in 0..6 {
            stamps.push(base + i * 60_000);
        }
        // 昨日 5 世代 (日次層は 1 つだけ拾うべき)
        for i in 0..5 {
            stamps.push(base - day + i * 60_000);
        }

        let keep = backups_to_keep(&stamps);
        let yesterday_kept = stamps
            .iter()
            .filter(|s| day_index(**s) == day_index(base - day) && keep.contains(s))
            .count();

        assert_eq!(
            yesterday_kept, 1,
            "同じ日からは1世代だけ残すこと (日付判定が効いていない)"
        );
        // 昨日の中で残るのは最も新しいもの
        assert!(
            keep.contains(&(base - day + 4 * 60_000)),
            "その日の最新世代が残ること"
        );
    }

    /// **U2 の牙 (2)**: prune_backups が実ファイルを本当に消すこと、かつ
    /// **想定外の命名のファイルは消さないこと** (知らないものを消さない)。
    #[test]
    fn prune_backups_removes_only_known_naming() {
        let dir = temp_dir_for("prune");
        let prefix = "presets.json.bak-";
        let base = 1_700_000_000_000u64;

        // 同日 12 世代 → 直近5だけ残るはず (同日なので日次層は増えない)
        for i in 0..12 {
            fs::write(dir.join(format!("{prefix}{}", base + i * 60_000)), "{}").unwrap();
        }
        // 想定外の命名 (旧形式の残骸 / 無関係ファイル)
        fs::write(dir.join("presets.json.bak-20260806-120000"), "{}").unwrap();
        fs::write(dir.join("presets.json"), "{}").unwrap();

        prune_backups(&dir, prefix);

        let numbered = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| backup_stamp(&e.file_name().to_string_lossy(), prefix).is_some())
            .count();
        assert_eq!(numbered, 5, "同日連投は直近層の5世代まで間引かれること");

        // 知らない形式は残す
        assert!(
            dir.join("presets.json.bak-20260806-120000").exists(),
            "数値でない stamp のファイルを消してはいけない"
        );
        assert!(dir.join("presets.json").exists(), "正本を消してはいけない");

        let _ = fs::remove_dir_all(&dir);
    }

    // ===================================================================
    // 2026-08-06 第2波 (Sol監査 DL-01〜04) の牙
    // ===================================================================

    /// **V1 の牙**: `read_existing_for_guard` が「存在するのに読めない」を Err にすること。
    ///
    /// なぜ要るか (DL-01): 従来は `if let Ok(existing) = fs::read_to_string(&path)` で、
    /// 読めないと**ガードごと省略されて書き込みが通っていた**。権限エラー時に
    /// 「守るべき中身が分からない正本」を上書きできる経路そのもの。
    ///
    /// 3状態を区別できることを固定する: 無い→Ok(None) / 読める→Ok(Some) / 読めない→Err。
    #[test]
    fn read_existing_for_guard_distinguishes_missing_from_unreadable() {
        let dir = temp_dir_for("guard-read");

        // (a) 存在しない → Ok(None) (ガード非適用でよい。新規保存を妨げない)
        let missing = dir.join("presets.json");
        assert!(
            matches!(read_existing_for_guard(&missing, "テスト"), Ok(None)),
            "未作成は Ok(None) であること"
        );

        // (b) 存在して読める → Ok(Some(中身))
        fs::write(&missing, r#"{"presets":[{"id":"a"}]}"#).unwrap();
        let got = read_existing_for_guard(&missing, "テスト").expect("読めるはず");
        assert_eq!(got.as_deref(), Some(r#"{"presets":[{"id":"a"}]}"#));

        // (c) 存在するが読めない → Err (書き込みを中止させる)
        //     ディレクトリを渡すと read_to_string が失敗する (権限操作より移植性が高い)。
        let unreadable = dir.join("as-dir.json");
        fs::create_dir_all(&unreadable).unwrap();
        let err = read_existing_for_guard(&unreadable, "テスト")
            .expect_err("存在するのに読めない場合は Err であること");
        assert!(
            err.contains("保存を中止"),
            "中止したことが伝わる文言であること: {err}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// **V3 の牙 (1)**: バックアップ失敗が `false` として伝わること。
    ///
    /// なぜ要るか (DL-03): 従来は失敗しても eprintln して継続し、
    /// **戻せないまま正本を上書き**していた。呼び出し側が中止判断できる形かを固定する。
    #[test]
    fn backup_projects_file_reports_failure() {
        let dir = temp_dir_for("backup-fail");

        // (a) 対象が存在しない → true (守るものが無い。書き込みを止める理由にしない)
        assert!(
            backup_projects_file(&dir.join("nope.json")),
            "未作成は true (書き込みを妨げない)"
        );

        // (b) 正常にコピーできる → true
        let path = dir.join("projects.json");
        fs::write(&path, "[]").unwrap();
        assert!(backup_projects_file(&path), "通常はバックアップできる");

        // (c) コピーできない → false。
        //     ディレクトリを「正本」に見せかけると fs::copy が失敗する。
        let as_dir = dir.join("weird.json");
        fs::create_dir_all(&as_dir).unwrap();
        assert!(
            !backup_projects_file(&as_dir),
            "コピー失敗は false を返すこと (成功と報告しない)"
        );

        // (d) backup_before_write はその false を Err に変換して書き込みを止める
        let err = backup_before_write(&as_dir, "テストデータ")
            .expect_err("バックアップ失敗なら Err であること");
        assert!(
            err.contains("保存を中止"),
            "書き込みを中止したことが伝わること: {err}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// **V3 の牙 (2)**: 同一ミリ秒でも `.bak` が上書きされず世代が残ること。
    ///
    /// なぜ要るか (DL-03): stamp は epoch ミリ秒なので、1ミリ秒以内に 2 回
    /// バックアップが走ると `fs::copy` が同名を黙って上書きし、直前の世代が消える。
    /// 時刻に依存させないため、stamp を固定して純関数を直接叩く。
    #[test]
    fn backup_path_does_not_collide_within_same_millisecond() {
        let dir = temp_dir_for("bak-collision");
        let stamp = 1_700_000_000_000u128;

        let first = next_free_backup_path_for(&dir, "projects.json", stamp);
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            format!("projects.json.bak-{stamp}")
        );
        fs::write(&first, "gen1").unwrap();

        // 同一ミリ秒の 2 回目は別名になること (= 1世代目を潰さない)
        let second = next_free_backup_path_for(&dir, "projects.json", stamp);
        assert_ne!(first, second, "同一ミリ秒で同じパスを返してはいけない");
        fs::write(&second, "gen2").unwrap();

        assert_eq!(
            fs::read_to_string(&first).unwrap(),
            "gen1",
            "先の世代が上書きされていないこと"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// **V2 の牙**: 4 正本すべてが `write_file_synced` 経由で書かれること (DL-02)。
    ///
    /// なぜこの形か: fsync が効いているかは単体テストからは観測できない
    /// (電源断を再現できない)。観測できるのは「素の書き込みに戻っていないか」なので、
    /// **projects だけ `fs::write` だった**という今回の欠落そのものを検査する。
    /// 誰かが再び素の書き込みへ戻したらここが落ちる。
    #[test]
    fn all_four_stores_write_through_fsync_helper() {
        let src = include_str!("storage.rs");

        // (a) helper が sync_all を呼んでいること (中身が空洞化していない)
        let helper_start = src
            .find("fn write_file_synced")
            .expect("write_file_synced が存在すること");
        let helper_body = &src[helper_start..helper_start + 400];
        assert!(
            helper_body.contains("sync_all"),
            "write_file_synced が sync_all を呼ばなくなっている"
        );

        // (b) 4 正本の一時書込がすべて helper 経由であること。
        //     各 write 関数の本体から「一時書込失敗」の直前を見る。
        for store in ["projects", "presets", "scene3d", "motions"] {
            let marker = format!("{store}.json 一時書込失敗");
            let at = src
                .find(&marker)
                .unwrap_or_else(|| panic!("{store} の一時書込が見つからない"));
            // 直前 200 バイトに write_file_synced があること (fs::write ではない)
            let before = &src[at.saturating_sub(200)..at];
            assert!(
                before.contains("write_file_synced"),
                "{store} が write_file_synced を経由していない (素の書き込みに戻っている)"
            );
        }
    }

    /// **V4 の牙**: 移行先が「存在するのに読めない」を 0 件と混同しないこと。
    ///
    /// なぜ要るか (DL-04): 従来は `*_count_at(...).unwrap_or(0)` で新側を 0 件とみなし、
    /// 旧側で上書きしていた。新側に実データがあって一時的に読めないだけの場合に
    /// その未読データを潰す経路そのもの。4 ストアが同じ判定関数を共有していることを固定する。
    #[test]
    fn count_at_helpers_error_when_existing_target_is_unreadable() {
        let dir = temp_dir_for("migrate-unreadable");

        // 存在しない → Ok(0)。新規フォルダへの切り替えは通す必要がある。
        assert_eq!(projects_count_at(&dir.join("none.json")), Ok(0));
        assert_eq!(presets_count_at(&dir.join("none.json")), Ok(0));
        assert_eq!(scene3d_count_at(&dir.join("none.json")), Ok(0));
        assert_eq!(motions_count_at(&dir.join("none.json")), Ok(0));

        // 存在するが読めない → Err。4ストアすべてで同じ扱いであること。
        let unreadable = dir.join("as-dir.json");
        fs::create_dir_all(&unreadable).unwrap();
        assert!(
            projects_count_at(&unreadable).is_err(),
            "projects: 読めない移行先を0件扱いしてはいけない"
        );
        assert!(
            presets_count_at(&unreadable).is_err(),
            "presets: 読めない移行先を0件扱いしてはいけない"
        );
        assert!(
            scene3d_count_at(&unreadable).is_err(),
            "scene3d: 読めない移行先を0件扱いしてはいけない"
        );
        assert!(
            motions_count_at(&unreadable).is_err(),
            "motions: 読めない移行先を0件扱いしてはいけない"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// **V4 の牙 (2)**: 世代バックアップのコピー失敗が件数として返ること
    /// (黙って捨てない)。
    #[test]
    fn copy_generation_backups_counts_failures() {
        let root = temp_dir_for("bak-migrate");
        let old_dir = root.join("old");
        let new_dir = root.join("new");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&new_dir).unwrap();

        let old_file = old_dir.join("projects.json");
        let new_file = new_dir.join("projects.json");
        fs::write(&old_file, "[]").unwrap();
        fs::write(old_dir.join("projects.json.bak-1700000000000"), "gen1").unwrap();
        fs::write(old_dir.join("projects.json.bak-1700000001000"), "gen2").unwrap();

        // 正常時は失敗 0 件で、両世代が新側へ渡る。
        assert_eq!(copy_generation_backups(&old_file, &new_file), 0);
        assert!(new_dir.join("projects.json.bak-1700000000000").exists());
        assert!(new_dir.join("projects.json.bak-1700000001000").exists());

        // コピーできない世代があれば件数に計上されること。
        // 「読めない通常ファイル」を作る (パーミッション 000)。ディレクトリでは
        // is_file() で先に弾かれてしまい、copy 失敗経路に到達しない。
        let root2 = temp_dir_for("bak-migrate-fail");
        let old2 = root2.join("old");
        let new2 = root2.join("new");
        fs::create_dir_all(&old2).unwrap();
        fs::create_dir_all(&new2).unwrap();
        fs::write(old2.join("projects.json"), "[]").unwrap();
        let bad = old2.join("projects.json.bak-1700000002000");
        fs::write(&bad, "gen").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bad, fs::Permissions::from_mode(0o000)).unwrap();
        }

        // 前提確認: この環境で 000 が本当に読み取りを阻むか (root で走ると阻まない)。
        // 阻まないなら失敗を再現できないので、検査を飛ばす代わりに理由を明示する。
        let perm_blocks_read = fs::read_to_string(&bad).is_err();

        let failures =
            copy_generation_backups(&old2.join("projects.json"), &new2.join("projects.json"));
        if perm_blocks_read {
            assert_eq!(
                failures, 1,
                "コピーできなかった世代は件数として返すこと (黙って捨てない)"
            );
        } else {
            eprintln!(
                "[skip] このユーザーは 0o000 のファイルを読めるため (root 等)、\
                 コピー失敗を再現できなかった"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 後始末できるよう戻す
            let _ = fs::set_permissions(&bad, fs::Permissions::from_mode(0o644));
        }

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }
}
