/**
 * 書き出し先のフォルダ名を決める（L6 / 2026-08-05 STΛCK実機FB「ZIPが見つからない」）。
 *
 * ## 何が起きていたか
 *
 * 申請用の書き出しは ZIP を**作っていた**（`sticker_export` の `zipPath`）。
 * だが選んだフォルダ（例: `~/Downloads`）の直下へ、個別PNG 26枚・`main.png`・
 * `tab.png`・`作成条件.txt` と**横並びで**置かれる。ダウンロードフォルダのように
 * 既にファイルがある場所だと、ZIP 1個が 30 個のファイルに埋もれて見つからない。
 *
 * 作られていないのではなく**見つからない**。だから直すのは生成側ではなく置き場所。
 *
 * ## 直し方: 専用のサブフォルダを1枚かませる
 *
 * 選んだフォルダの下に `LINEスタンプ_<日付_時刻>` を作り、書き出し物を全部そこへ入れる。
 * 「どこへ出したか」がフォルダ名で分かり、複数回書き出しても混ざらない。
 *
 * ## 既存の関所を壊さない（最重要）
 *
 * `sticker_export` は書き出し前に `existing_sequence_files` で既存の連番PNGを
 * 検出して**書く前に止める**（D11 / T11 の連番の完全性）。毎回新しい空フォルダを
 * 作るので、この検査は「衝突なし」で素通りする。**検査を消したのではなく、
 * 衝突する状況を作らなくなった**。上書き確認の分岐（`overwrite`）もそのまま残す —
 * 同じ分に2回書き出すと同名フォルダになりうるので、その時は連番を足して避ける。
 *
 * 60MB 検査・枚数の再検査など層Aの数値は**一切触らない**（規格の判定は別の話）。
 */

/** 書き出しフォルダの接頭辞。人が見て何のフォルダか分かる日本語にする。 */
export const EXPORT_FOLDER_PREFIX = "LINEスタンプ";

/**
 * `YYYY-MM-DD_HHmm` の文字列にする（**ローカル時刻**）。
 *
 * UTC にすると日本の深夜作業で日付が前日にずれ、人が探すときに混乱する。
 * ここは機械の識別子ではなく**人が読むラベル**なので現地時間で作る。
 */
export function formatExportStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `_${p(at.getHours())}${p(at.getMinutes())}`
  );
}

/**
 * 書き出し先フォルダの**名前**を決める（パスの連結はしない）。
 *
 * 同じ分に2回書き出すと同名になるので、`taken` に含まれる間は `-2`, `-3` と足す。
 * 分単位で刻んでいるのは、秒まで入れると名前が長く読みにくいため。衝突は連番で解く。
 *
 * @param at 書き出し時刻。**呼び出し側が渡す**（`Date.now()` を内部で呼ぶと
 *           テストが時計に依存して固定できない。規律3「実行時点の値を焼かない」）。
 * @param taken 既にその親フォルダに存在する名前の集合。
 */
export function pickExportFolderName(at: Date, taken: ReadonlySet<string> = new Set()): string {
  const base = `${EXPORT_FOLDER_PREFIX}_${formatExportStamp(at)}`;
  if (!taken.has(base)) return base;
  // 2 から始める（「_2」が2回目という読み方になる。`-1` は作らない）。
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 1000 個も同じ分に作れない。ここへ来たら名前で解決するのを諦め、
  // 呼び出し側が上書き確認へ落ちるほうが安全（黙って上書きしない）。
  return `${base}_${1000}`;
}

/**
 * 親フォルダとフォルダ名を連結する。
 *
 * `path.join` は使えない（フロントは Node ではない）。区切りは
 * **親のパスに現れている区切り**へ合わせる — Windows の `C:\Users\...` に
 * `/` を足すと、Rust 側で作られるフォルダ名がおかしくなる。
 */
export function joinExportPath(parentDir: string, folderName: string): string {
  const sep = parentDir.includes("\\") && !parentDir.includes("/") ? "\\" : "/";
  const trimmed = parentDir.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${folderName}`;
}
