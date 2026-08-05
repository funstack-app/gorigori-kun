/**
 * バックアップの健全性まわりの共有ヘルパー (2026-08-06 新設)。
 *
 * なぜ ipc.ts でなくここか: ipc.ts は「Tauri invoke の薄ラッパ」に徹しており、
 * 失敗を握り潰す/型を畳むといった**方針を持つ**コードは置かない場所。
 * ここは方針 (失敗しても本流を止めない / 取得失敗と0件を区別する) を持つ層。
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * 保護対象データ (presets / projects / scene3d / motions) について、
 * 最新バックアップが24時間より古ければ1世代作る。
 *
 * **失敗しても投げない**。バックアップは付帯機能であり、これが理由で起動や
 * 移行を止める意味がないため (呼び出し側は `void` で撃ちっぱなしにできる)。
 *
 * 返り値: 実際に作られた世代数。失敗時は 0。
 */
export async function ensureDailyBackupsSafe(): Promise<number> {
  try {
    return await invoke<number>("storage_ensure_daily_backups");
  } catch (err) {
    console.error("[backup] デイリーバックアップに失敗 (継続):", err);
    return 0;
  }
}

/**
 * 一覧取得の結果。**「取得できなかった」と「0件だった」を型で区別する**。
 *
 * なぜ要るか (2026-08-06 実害): 従来は listBackups が catch → `[]` を返しており、
 * 保存先が読めない (外付け未接続 / 権限エラー / クラウド同期の不達) ときにも
 * 「まだバックアップがありません」と表示していた。**復元がいちばん必要な
 * 故障時に、原因が見えないどころか「無い」と誤って断言していた**。
 */
export type BackupListResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; error: string };

/**
 * バックアップ一覧取得を BackupListResult に畳む共通ラッパ。
 * 各ストアの listBackups が同じ失敗の扱いになるよう1箇所に集約する。
 */
export async function toBackupListResult<T>(
  load: () => Promise<T[]>,
  logLabel: string,
): Promise<BackupListResult<T>> {
  try {
    return { ok: true, items: await load() };
  } catch (err) {
    console.error(`[${logLabel}] listBackups 失敗:`, err);
    return { ok: false, error: String(err) };
  }
}

/** バックアップ健全性の要約。設定画面の「守られているか」表示に使う。 */
export type BackupHealth = {
  /** 世代数。取得失敗時は null。 */
  generations: number | null;
  /** 最新バックアップの epoch ミリ秒。1つも無ければ null。 */
  latestAt: number | null;
  /** 一覧を取得できなかったか。 */
  failed: boolean;
};

/**
 * バックアップ一覧 (新しい順) から健全性要約を作る。
 * `at` は epoch ミリ秒。空配列なら latestAt は null。
 */
export function summarizeBackupHealth<T extends { at: number }>(
  result: BackupListResult<T>,
): BackupHealth {
  if (!result.ok) {
    return { generations: null, latestAt: null, failed: true };
  }
  const latest = result.items.reduce<number | null>(
    (max, b) => (max === null || b.at > max ? b.at : max),
    null,
  );
  return { generations: result.items.length, latestAt: latest, failed: false };
}

/**
 * 「N時間前」「N日前」の人間向け表記。`now` は差し替え可能 (テストのため
 * 実行時刻をハードコードしない)。
 */
export function formatRelativeAge(at: number, now: number): string {
  const diffMs = Math.max(0, now - at);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}
