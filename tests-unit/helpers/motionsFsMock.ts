/**
 * motions.json の疑似 FS (u73 2026-08-03)。
 *
 * `mockIPC` に渡すハンドラを組み立てる。保存先 root を切り替えられるので、
 * 「切替前のジョブがどちらの root へ着地したか」を書き込みログで検証できる。
 *
 * ## 意図的にやらないこと: Rust 側ガードの再実装
 * storage.rs の空上書き拒否 (motions_empty_overwrite_rejected) をここに写経すると、
 * 「自分と同じ理解を自分で検査する」無力な検査になる。Rust ガードは cargo test 済み
 * (storage.rs の #[cfg(test)])。**フロントテストは「allowEmpty に何を渡したか」だけを
 * assert する**。ここは素直に書き込みを受け付ける。
 */
import { mockIPC } from "@tauri-apps/api/mocks";

/** motions_write 1 回分の記録。 */
export type WriteLogEntry = {
  /** 書き込みが着地した保存先 root。 */
  root: string;
  /** motions_write に渡された content (JSON 文字列)。 */
  content: string;
  /** motions_write に渡された allowEmpty。 */
  allowEmpty: boolean;
};

export type MotionsFsMock = {
  /** 現在の保存先 root。`setRoot()` で切り替える。 */
  currentRoot: string;
  /** root ごとのファイル内容。undefined = ファイル未作成 (motions_read は "" を返す)。 */
  files: Record<string, string | undefined>;
  /** motions_write の呼び出しログ (時系列)。 */
  writes: WriteLogEntry[];
  /** motions_read の呼び出しログ (読んだ root の時系列)。 */
  reads: string[];
  /** 保存先を切り替える (storage-settings の変更に相当)。 */
  setRoot: (root: string) => void;
  /**
   * 次回以降の `motions_read` を手動解決にする。null で通常動作へ戻す。
   * T4 (切替をまたいだ初期化の破棄) で「読み込み中に切替」を作るために使う。
   */
  deferNextRead: () => { resolve: (content: string) => void };
};

/**
 * インメモリ疑似 FS を作り、`mockIPC` に登録する。
 *
 * 未知の cmd (plugin:store|… 等) は undefined を返す。motionStore はファイル
 * 読み書きの失敗を catch 済みなので、undefined でも落ちない設計であることを
 * 前提にしている (motionStore.ts の bailOut / writeMotionsToFileNow の catch)。
 */
export function installMotionsFsMock(init?: {
  root?: string;
  files?: Record<string, string | undefined>;
}): MotionsFsMock {
  const state: MotionsFsMock = {
    currentRoot: init?.root ?? "rootA",
    files: { ...(init?.files ?? {}) },
    writes: [],
    reads: [],
    setRoot: (root: string) => {
      state.currentRoot = root;
    },
    deferNextRead: () => {
      let resolveFn: ((content: string) => void) | null = null;
      pendingRead = new Promise<string>((res) => {
        resolveFn = res;
      });
      return {
        resolve: (content: string) => {
          const fn = resolveFn;
          pendingRead = null;
          fn?.(content);
        },
      };
    },
  };

  /** deferNextRead() で仕込まれた「手動解決待ちの read」。 */
  let pendingRead: Promise<string> | null = null;

  mockIPC(async (cmd, args) => {
    if (cmd === "motions_read") {
      const root = state.currentRoot;
      state.reads.push(root);
      if (pendingRead) {
        const deferred = pendingRead;
        return await deferred;
      }
      return state.files[root] ?? "";
    }
    if (cmd === "motions_write") {
      const payload = (args ?? {}) as { content?: string; allowEmpty?: boolean };
      const root = state.currentRoot;
      state.writes.push({
        root,
        content: payload.content ?? "",
        allowEmpty: payload.allowEmpty === true,
      });
      state.files[root] = payload.content ?? "";
      return null;
    }
    return undefined;
  });

  return state;
}

/** motions.json の中身を組み立てる (motionStore の MOTIONS_FILE_VERSION = 1)。 */
export function motionsFileContent(ids: string[]): string {
  return JSON.stringify({
    version: 1,
    motions: ids.map((id) => ({ id, spec: { id, source: "test" } })),
  });
}

/** 書き込みログの content から motion id 一覧を取り出す。 */
export function idsInWrite(entry: WriteLogEntry): string[] {
  const parsed = JSON.parse(entry.content) as { motions?: { id: string }[] };
  return (parsed.motions ?? []).map((m) => m.id);
}
