import { invoke } from "@tauri-apps/api/core";

/**
 * バイト列を Tauri コマンドへ **増幅せずに** 渡すための転送層 (2026-08-06)。
 *
 * ## なぜ要るか（実害）
 *
 * 2026-08-05、9 枚の画像を貼り付けた最中にアプリがクラッシュし、
 * プリセット 30 体消失の引き金になった。真因は転送方式にある。
 *
 * 従来は `invoke("cmd", { pngBytes: Array.from(bytes) })` としていた。これは
 *
 *   1. `Array.from(Uint8Array)` で 1 バイト → JS 数値 1 個（実測で約 8 倍 + 管理コスト）
 *   2. さらに invoke が引数を **JSON 文字列化** する（"255," 等で 1 バイトあたり最大 4 文字）
 *
 * と二段で膨らみ、**元サイズの 15〜20 倍の一時メモリスパイク**を生む。
 * 30MB の PNG 1 枚で 500MB 級。9 枚ならレンダラの OOM に十分届く。
 *
 * ## 対策
 *
 * Tauri 2 の raw payload を使う。`invoke` の第 2 引数に `ArrayBuffer` /
 * `Uint8Array` を直接渡すと、JSON を経由せず生バイトのまま Rust の
 * `tauri::ipc::Request` に届く（増幅ほぼゼロ）。Rust 側は `InvokeBody::Raw`
 * から `Vec<u8>` を取り出す。
 *
 * ## メタ情報はヘッダーで運ぶ
 *
 * raw payload は「バイト列 1 本」しか運べないため、`srcPath` / `fileName` の
 * ような同伴引数は **ヘッダー**に載せる。ヘッダー値は ASCII しか安全に通せない
 * ので、`encodeURIComponent` でエンコードして送り、Rust 側でデコードする。
 * 日本語ファイル名がそのまま壊れるのを防ぐため、この経路は必須。
 */

/** raw payload に同伴させるメタ情報を運ぶヘッダー名の接頭辞。 */
const HEADER_PREFIX = "x-gori-";

/**
 * ヘッダー値を安全な ASCII へ符号化する。
 *
 * ヘッダーは非 ASCII をそのまま運べない（日本語ファイル名が壊れる / 送信自体が
 * 失敗する）。`encodeURIComponent` は非 ASCII を %XX へ落とすので、Rust 側の
 * percent-decode と対で往復できる。
 */
export function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * バイト列を増幅せずに invoke する。
 *
 * @param command 呼び出す Tauri コマンド名
 * @param bytes   生バイト。**コピーも配列化もせずそのまま渡す**
 * @param meta    同伴させる文字列メタ（ヘッダー経由で運ばれる）
 */
export function invokeWithBytes<T>(
  command: string,
  bytes: Uint8Array,
  meta: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    headers[`${HEADER_PREFIX}${key}`] = encodeHeaderValue(value);
  }
  // bytes をそのまま渡すのが肝。Array.from も JSON.stringify も挟まない。
  return invoke<T>(command, bytes, { headers });
}
