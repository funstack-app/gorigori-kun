import { useEffect, useRef, useState } from "react";

import {
  images as imagesIpc,
  onNotification,
  rpcRequest,
  type RpcNotification,
} from "../lib/ipc";
import type { InputItem, ThreadStartResult } from "../lib/codex-types";
import { useImages } from "../lib/store/images";
import { useLibrarySelection } from "../lib/store/librarySelection";
import { useToasts } from "../lib/store/toasts";

const RENAME_MODEL = "gpt-5.5";
// 画像 vision で命名する場合、image エンコード + 推論で 1 枚あたり 5-15 秒。
// 並列実行するので全体は最大画像 1 枚分の時間で済む想定。少し余裕を持たせて 90 秒。
const AI_TIMEOUT_MS = 90_000;
// 命名は単純なキャプショニングタスクなので低い effort で応答を速くする。
const RENAME_EFFORT = "low";
// 同時に走らせる Vision 推論の最大並列数。サーバー負荷とレートを考慮して 4 程度。
const MAX_CONCURRENCY = 4;

function getThreadId(params: any): string | undefined {
  return params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId;
}

function extractTextDelta(params: any): string | undefined {
  if (typeof params?.delta === "string") return params.delta;
  if (typeof params?.textDelta === "string") return params.textDelta;
  return undefined;
}

/**
 * Vision 用のキャプション指示プロンプト。
 * GPT-5.5 に画像を 1 枚渡し、ファイル名にしやすい日本語の一文を返させる。
 */
const CAPTION_PROMPT = [
  "添付の画像を見て、その内容を日本語で「シンプルな一文」にまとめてください。",
  "ファイル名として使うので以下を厳守:",
  "- 一文だけ、句点や改行は入れない",
  "- 30 文字以内",
  "- スペースの代わりに半角ハイフン (-) で語を繋ぐ",
  "- ファイルシステムで使えない文字 (\\ / : * ? \" < > |) は使わない",
  "- 英語ではなく日本語で、被写体や状況がわかるように",
  "",
  "良い例:",
  "ダークな街を歩く探偵",
  "朝のキッチンに置かれたコーヒーカップ",
  "雨に濡れた赤いスポーツカー",
  "",
  "出力は説明や前置きを含めず、ファイル名にする一文だけを返してください。",
].join("\n");

/**
 * macOS / cross-platform で安全なファイル名にサニタイズする。
 * - 改行 / 句点 / 引用符 / パス区切りなどを除去
 * - ファイルシステム禁止文字 (\\/:*?"<>|) を除去
 * - 連続するハイフンを 1 つに正規化
 * - 30 文字以内に丸める
 */
function sanitizeJaName(raw: string): string {
  const noLines = raw.replace(/[\r\n]+/g, " ").trim();
  const stripped = noLines
    .replace(/^["「『'`]+|["」』'`]+$/g, "")
    .replace(/[。、，,.!?！？]/g, "")
    .replace(/[\\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stripped.slice(0, 30).replace(/-+$/g, "");
}

/**
 * 画像 1 枚を Codex (gpt-5.5) Vision に送って、説明的な日本語 1 文を取得する。
 *
 * 実装ポイント:
 *  - thread/start を画像ごとに 1 つ起こす (使い捨て、複数 turn は不要)
 *  - turn/start の input に { type: "text", text: CAPTION_PROMPT } と
 *    { type: "localImage", path: imagePath } の 2 要素を渡す
 *  - listener は thread ごとにローカルで持つ (並列実行のため、関数 ref で
 *    1 つだけ持つと衝突する)
 *  - finish 時に必ず unlisten + clearTimeout
 */
async function captionOneImage(imagePath: string): Promise<string> {
  const thread = await rpcRequest<ThreadStartResult>("thread/start", {
    model: RENAME_MODEL,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const threadId = thread.thread.id;

  return await new Promise<string>(async (resolve, reject) => {
    let assistantText = "";
    let settled = false;
    let unlisten: (() => void) | null = null;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      unlisten?.();
      unlisten = null;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error("timeout")));
    }, AI_TIMEOUT_MS);

    try {
      unlisten = await onNotification((n: RpcNotification) => {
        const params = n.params as any;
        if (getThreadId(params) !== threadId) return;

        if (n.method === "item/started") {
          const item = params?.item;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            assistantText += item.text;
          }
        } else if (n.method === "item/agentMessage/delta") {
          const delta = extractTextDelta(params);
          if (delta !== undefined) assistantText += delta;
        } else if (n.method === "item/completed") {
          const item = params?.item;
          if (
            item?.type === "agentMessage" &&
            typeof item.text === "string" &&
            item.text.length > 0
          ) {
            assistantText = item.text;
          }
        } else if (n.method === "turn/completed") {
          const status = params?.turn?.status;
          if (status === "failed") {
            const message =
              params?.turn?.error?.message ?? "AI 命名でエラーが発生しました";
            finish(() => reject(new Error(message)));
            return;
          }
          finish(() => resolve(assistantText));
        }
      });

      const input: InputItem[] = [
        { type: "text", text: CAPTION_PROMPT },
        { type: "localImage", path: imagePath },
      ];
      await rpcRequest("turn/start", {
        threadId,
        input,
        model: RENAME_MODEL,
        effort: RENAME_EFFORT,
      });
    } catch (err) {
      finish(() => reject(err));
    }
  });
}

/**
 * 並列度を制限して各 path を非同期処理する小さなランナー。
 * Promise.all で全部一気に起こすとレートに引っかかるので、MAX_CONCURRENCY を上限にする。
 */
async function runInBatches<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => next(),
  );
  await Promise.all(workers);
  return results;
}

export function LibraryAutoRenameButton() {
  const selected = useLibrarySelection((s) => s.selected);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const renameLocal = useImages((s) => s.renameLocal);
  const pushToast = useToasts((s) => s.push);
  const [running, setRunning] = useState(false);
  // 走行中の進捗カウンタ (toast 用、UI 表示)
  const progressRef = useRef({ done: 0, total: 0 });

  useEffect(() => {
    return () => {
      // 並列 listener は各 promise 内で局所的に張ってるため、unmount 時の
      // 個別 cleanup は不要 (各 promise が finish/timeout で自前で解放)
    };
  }, []);

  const handleClick = async () => {
    if (running || selected.size === 0) return;

    const selectedPaths = Array.from(selected);
    setRunning(true);
    progressRef.current = { done: 0, total: selectedPaths.length };

    try {
      pushToast({
        kind: "info",
        text: `AI が画像を分析中... (${selectedPaths.length} 件、最大 ${MAX_CONCURRENCY} 並列)`,
        ttlMs: 6000,
      });

      // 各画像 → caption 1 文 + sanitize → ファイル名候補
      type RenameJob = { path: string; name: string | null; error?: string };
      const jobs: RenameJob[] = await runInBatches(
        selectedPaths,
        MAX_CONCURRENCY,
        async (path) => {
          try {
            const raw = await captionOneImage(path);
            const name = sanitizeJaName(raw);
            // 進捗 toast (粒度: 1 枚ごと、ノイズ少なめに ttl 短く)
            progressRef.current.done += 1;
            const { done, total } = progressRef.current;
            pushToast({
              kind: "info",
              text: `分析 ${done}/${total}`,
              ttlMs: 1200,
            });
            return { path, name: name || null };
          } catch (err) {
            progressRef.current.done += 1;
            return { path, name: null, error: String(err) };
          }
        },
      );

      const okJobs = jobs.filter((j): j is RenameJob & { name: string } => !!j.name);
      const missingCount = jobs.length - okJobs.length;

      if (missingCount > 0) {
        pushToast({
          kind: "warn",
          text: `${missingCount} 件は名前を取得できずスキップします`,
          ttlMs: 5000,
        });
      }
      if (okJobs.length === 0) {
        pushToast({
          kind: "error",
          text: "リネーム可能な画像がありませんでした",
          ttlMs: 5000,
        });
        return;
      }

      // rename は API 単発 + ファイル衝突チェックがあるので逐次。短いので OK。
      let completed = 0;
      let failed = 0;
      for (const job of okJobs) {
        try {
          const newPath = await imagesIpc.rename(job.path, job.name);
          renameLocal(job.path, newPath);
          completed += 1;
        } catch (err) {
          failed += 1;
          console.warn("rename failed", {
            path: job.path,
            name: job.name,
            error: err,
          });
        }
      }

      if (failed > 0) {
        pushToast({
          kind: "warn",
          text: `${failed} 件はリネームできませんでした (同名衝突など)`,
          ttlMs: 5000,
        });
      }
      pushToast({
        kind: "success",
        text: `${completed} 件をリネームしました`,
        ttlMs: 3000,
      });
      exitMode();
    } catch (err) {
      pushToast({
        kind: "error",
        text: `AI 自動命名に失敗しました: ${String(err)}`,
        ttlMs: 6000,
      });
    } finally {
      setRunning(false);
    }
  };

  const renameByPattern = async (mode: "serial" | "pattern") => {
    if (running || selected.size === 0) return;
    const selectedPaths = Array.from(selected);
    const input =
      mode === "serial"
        ? window.prompt("連番の先頭文字を入力してください", "gori")
        : window.prompt("命名規則を入力してください。{n} が連番になります", "gori-{n}");
    const rawPattern = input?.trim();
    if (!rawPattern) return;

    setRunning(true);
    try {
      let completed = 0;
      let failed = 0;
      for (const [index, path] of selectedPaths.entries()) {
        const number = String(index + 1).padStart(3, "0");
        const stem =
          mode === "serial"
            ? `${rawPattern}-${number}`
            : rawPattern.replace(/\{n\}/g, number).replace(/\{index\}/g, number);
        try {
          const newPath = await imagesIpc.rename(path, sanitizeJaName(stem) || `image-${number}`);
          renameLocal(path, newPath);
          completed += 1;
        } catch (err) {
          failed += 1;
          console.warn("pattern rename failed", { path, stem, error: err });
        }
      }
      if (failed > 0) {
        pushToast({
          kind: "warn",
          text: `${failed} 件はリネームできませんでした`,
          ttlMs: 4000,
        });
      }
      pushToast({
        kind: "success",
        text: `${completed} 件を命名しました`,
        ttlMs: 3000,
      });
      exitMode();
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || selected.size === 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={[
          "h-7 rounded-md px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
            : "bg-pink-500 text-white hover:bg-pink-400",
        ].join(" ")}
        title="選択中の画像を AI が一括リネーム"
      >
        {`AI 自動命名 (${selected.size} 件)`}
      </button>
      <button
        type="button"
        onClick={() => void renameByPattern("serial")}
        disabled={disabled}
        className={[
          "h-7 rounded-md border px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed border-neutral-800 text-neutral-600"
            : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-950 hover:text-neutral-950",
        ].join(" ")}
      >
        連番
      </button>
      <button
        type="button"
        onClick={() => void renameByPattern("pattern")}
        disabled={disabled}
        className={[
          "h-7 rounded-md border px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed border-neutral-800 text-neutral-600"
            : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-950 hover:text-neutral-950",
        ].join(" ")}
      >
        規則指定
      </button>
    </div>
  );
}
