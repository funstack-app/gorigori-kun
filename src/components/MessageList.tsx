import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageGenerationItem, Item, Turn } from "../lib/codex-types";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages } from "../lib/store/images";
import { useBatches, type Batch, type BatchWorker } from "../lib/store/batches";
import { ContextMenu } from "./ContextMenu";
import { buildGalleryItemMenu } from "./galleryItemMenu";
import { RegisterPresetDialog } from "./RegisterPresetDialog";

type TurnEntry = { kind: "turn"; turn: Turn; key: string; sortKey: number };
type BatchEntry = { kind: "batch"; batch: Batch; key: string; sortKey: number };
type Entry = TurnEntry | BatchEntry;

export function MessageList({
  turns,
  batches = [],
  emptyHint,
}: {
  turns: Turn[];
  batches?: Batch[];
  emptyHint?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Build a merged sorted list so batch pseudo-turns interleave correctly
  // with real turns by chronological order.
  const entries: Entry[] = [
    ...turns.map((turn) => ({
      kind: "turn" as const,
      turn,
      key: `turn-${turn.id}`,
      // turns don't carry a timestamp; preserve their relative order by
      // using their array index as the sort key (they already arrive in order).
      sortKey: turns.indexOf(turn),
    })),
    ...batches.map((batch) => ({
      kind: "batch" as const,
      batch,
      key: `batch-${batch.batchId}`,
      // Offset so batches sort after earlier turns but before later ones.
      // We use startedAt relative to the session start — turns will be ~0
      // indexed, batches will be large epoch ms values, so we just mix them
      // by treating turn index * 1e13 as a scale that guarantees turns come
      // first. Instead, a simpler approach: append batches that started
      // after all existing turns (they always appear at the bottom in
      // typical usage). For interleaving, we use startedAt directly and
      // turns get a large negative offset based on index.
      sortKey: batch.startedAt,
    })),
  ];

  // Sort: turns preserve their natural ordering (index * -1 gives negatives
  // before batches' large epoch-ms values). Use index-based negatives.
  const turnCount = turns.length;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind === "turn") {
      entries[i].sortKey = -(turnCount - entries[i].sortKey);
    }
  }
  entries.sort((a, b) => a.sortKey - b.sortKey);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, batches]);

  const isEmpty = turns.length === 0 && batches.length === 0;

  return (
    <div ref={ref} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
      {isEmpty &&
        (emptyHint ?? (
          <p className="text-center text-xs text-neutral-500">
            メッセージを入力して画像生成を始めましょう。例: 「夕焼けの東京タワーを 4 枚」
          </p>
        ))}
      {entries.map((entry) =>
        entry.kind === "turn" ? (
          <div key={entry.key} className="space-y-2">
            {groupItems(entry.turn.items).map((group) =>
              group.kind === "imageGenerationRun" ? (
                <ImageGenerationGroup
                  key={`igg-${group.items[0].id}`}
                  items={group.items}
                />
              ) : (
                <ItemView key={group.item.id} item={group.item} />
              ),
            )}
            {entry.turn.status === "inProgress" && (
              <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                <Spinner />
                <span>応答生成中...</span>
              </div>
            )}
            {entry.turn.status === "interrupted" && (
              <p className="text-[10px] uppercase tracking-wider text-amber-500">中断</p>
            )}
            {entry.turn.status === "failed" && (
              <p className="text-[10px] uppercase tracking-wider text-rose-500">失敗</p>
            )}
          </div>
        ) : (
          <BatchCard key={entry.key} batch={entry.batch} />
        ),
      )}
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.type) {
    case "userMessage": {
      const content = (item as any).content;
      const text =
        Array.isArray(content)
          ? content
              .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
              .filter(Boolean)
              .join("\n")
          : (item as any).text ?? "";
      return (
        <Bubble role="user">
          <pre className="whitespace-pre-wrap font-sans text-sm">{text}</pre>
        </Bubble>
      );
    }

    case "agentMessage":
      return (
        <Bubble role="assistant">
          <pre className="whitespace-pre-wrap font-sans text-sm">
            {(item as any).text ?? ""}
          </pre>
        </Bubble>
      );

    case "reasoning":
      return (
        <details className="rounded border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700">
          <summary className="cursor-pointer text-neutral-500">推論</summary>
          {(item as any).summary && (
            <p className="mt-1 text-neutral-600">{(item as any).summary}</p>
          )}
          {(item as any).content && (
            <pre className="mt-1 whitespace-pre-wrap text-neutral-500">
              {(item as any).content}
            </pre>
          )}
        </details>
      );

    case "commandExecution":
      return (
        <div className="rounded border border-neutral-200 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100">
          <p className="text-neutral-400">$ {((item as any).command ?? []).join(" ")}</p>
          {(item as any).output && (
            <pre className="mt-1 whitespace-pre-wrap text-neutral-300">
              {(item as any).output}
            </pre>
          )}
        </div>
      );

    case "fileChange":
      return (
        <div className="rounded border border-neutral-200 bg-white px-3 py-2 text-xs">
          <p className="font-medium text-neutral-800">ファイル変更</p>
          {(item as any).changes?.map((c: any, i: number) => (
            <p key={i} className="text-neutral-500">
              {c.kind} · {c.path}
            </p>
          ))}
        </div>
      );

    case "imageGeneration":
      // Normally wrapped in <ImageGenerationGroup> by the grouper; this
      // keeps direct rendering working as a fallback.
      return <ImageGenerationView item={item as ImageGenerationItem} />;

    case "dynamicToolCall":
    case "mcpToolCall": {
      const toolName = (item as any).tool ?? (item as any).server ?? "tool";
      const isImageGen = String(toolName).includes("image_gen");
      return (
        <div
          className={`rounded border px-3 py-2 text-xs ${
            isImageGen
              ? "border-blue-200 bg-blue-50"
              : "border-neutral-200 bg-white"
          }`}
        >
          <p className="font-medium text-neutral-800">
            {isImageGen ? "画像生成" : toolName}
            {item.status === "inProgress" && " · 実行中..."}
            {item.status === "completed" && " · 完了"}
            {item.status === "failed" && " · 失敗"}
          </p>
          {(item as any).arguments != null && (
            <details className="mt-1">
              <summary className="cursor-pointer text-neutral-500">引数</summary>
              <pre className="mt-1 whitespace-pre-wrap text-neutral-500">
                {JSON.stringify((item as any).arguments, null, 2)}
              </pre>
            </details>
          )}
        </div>
      );
    }

    case "webSearch":
      return (
        <div className="rounded border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500">
          Web 検索 · {(item as any).query ?? ""}
        </div>
      );

    case "imageView": {
      const path = (item as any).path as string | undefined;
      return (
        <div className="rounded-md border border-neutral-200 bg-white p-2 text-xs">
          <p className="mb-1 text-neutral-500">
            Codex が画像を参照
            {item.status === "inProgress" && " · 読み込み中..."}
          </p>
          {path && (
            <button
              type="button"
              onClick={() => useImagePreview.getState().open(path)}
              className="block overflow-hidden rounded ring-1 ring-neutral-200 hover:ring-blue-500"
              title="クリックで拡大"
            >
              <img
                src={convertFileSrc(path)}
                alt="reference"
                loading="lazy"
                decoding="async"
                className="block max-h-40 max-w-full object-contain"
              />
            </button>
          )}
        </div>
      );
    }

    default:
      return (
        <div className="rounded border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500">
          {item.type}
        </div>
      );
  }
}

type ItemGroup =
  | { kind: "single"; item: Item }
  | { kind: "imageGenerationRun"; items: ImageGenerationItem[] };

/**
 * Walk a turn's items left-to-right and coalesce runs of consecutive
 * imageGeneration items so we can render them as a single grid card.
 * Anything else passes through as a singleton group.
 *
 * Why this matters: when the user asks for "4 枚", codex emits four
 * imageGeneration items in a row. Rendered individually each takes
 * ~320px of vertical space (single column, max-h-80) — the user sees
 * one image and has to scroll. Grouped, they fit a 2×2 grid in the
 * height of one previous card.
 */
function groupItems(items: Item[]): ItemGroup[] {
  const out: ItemGroup[] = [];
  let run: ImageGenerationItem[] = [];
  const flush = () => {
    if (run.length > 0) {
      out.push({ kind: "imageGenerationRun", items: run });
      run = [];
    }
  };
  for (const item of items) {
    if (item.type === "imageGeneration") {
      run.push(item as ImageGenerationItem);
    } else {
      flush();
      out.push({ kind: "single", item });
    }
  }
  flush();
  return out;
}

function ImageGenerationGroup({ items }: { items: ImageGenerationItem[] }) {
  // Single-item path keeps the larger ImageGenerationView card and reuses
  // the same right-click menu via ImageGenerationCell when a savedPath
  // exists; for the legacy single-item layout fall through to the View.
  if (items.length === 1) {
    return <ImageGenerationView item={items[0]} />;
  }
  const completed = items.filter((it) => it.status === "completed").length;
  const inProgress = items.some((it) => it.status === "inProgress");
  // 1 枚: 単体カード (上の if で抜けてるので未到達). 2-4 枚: N 列 1 行.
  // 5+ 枚: 4 列で折り返し (codex の image_gen は max=10).
  const cols = Math.min(items.length, 4);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-3 text-xs shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden />
        <span className="font-medium text-neutral-900">
          画像生成 · {items.length} 枚
        </span>
        {inProgress ? (
          <span className="ml-auto flex items-center gap-1.5 text-neutral-500">
            <Spinner />
            <span>
              {completed}/{items.length} 生成中...
            </span>
          </span>
        ) : (
          <span className="ml-auto text-blue-700">
            完了 {items.length} 枚
          </span>
        )}
      </div>
      <div
        className={`grid gap-2`}
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {items.map((it) => (
          <ImageGenerationCell
            key={it.id}
            item={it}
            onContextMenu={(path, x, y) => setMenu({ path, x, y })}
          />
        ))}
      </div>
      {menu && <GalleryItemContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * Resolve the chat-side savedPath into a GalleryItem (it is the same file
 * in both views) and render the shared right-click menu. Falls back to
 * silently closing if the watcher hasn't registered the path yet.
 */
function GalleryItemContextMenu({
  menu,
  onClose,
}: {
  menu: { path: string; x: number; y: number };
  onClose: () => void;
}) {
  const item = useImages((s) => s.items.find((it) => it.path === menu.path));
  const favorites = useImages((s) => s.favorites);
  const toggleFavorite = useImages((s) => s.toggleFavorite);
  const [presetTarget, setPresetTarget] = useState<string | null>(null);
  if (!item) return null;
  return (
    <>
      <ContextMenu
        x={menu.x}
        y={menu.y}
        items={buildGalleryItemMenu(item, {
          favorites,
          onToggleFavorite: toggleFavorite,
          onRegisterPreset: (path) => setPresetTarget(path),
        })}
        onClose={onClose}
      />
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget}
          onClose={() => {
            setPresetTarget(null);
            onClose();
          }}
        />
      )}
    </>
  );
}

function ImageGenerationCell({
  item,
  onContextMenu,
}: {
  item: ImageGenerationItem;
  onContextMenu?: (path: string, x: number, y: number) => void;
}) {
  const inProgress = item.status === "inProgress";
  const failed = item.status === "failed";
  const savedPath = item.savedPath ?? null;
  const [imgKey, setImgKey] = useState(0);
  const retried = useRef(false);

  if (inProgress || (!savedPath && !failed)) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md bg-neutral-100 ring-1 ring-neutral-200">
        <Spinner silent />
      </div>
    );
  }

  if (failed || !savedPath) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md bg-rose-50 px-2 text-center text-[10px] text-rose-600 ring-1 ring-rose-200">
        失敗
      </div>
    );
  }

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        const payload = JSON.stringify({
          path: savedPath,
          name: savedPath.split("/").pop() ?? "generated.png",
          source: "gallery",
          role: "subject",
        });
        e.dataTransfer.setData("application/x-gori-reference", payload);
        e.dataTransfer.setData("application/json", payload);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => useImagePreview.getState().open(savedPath)}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(savedPath, e.clientX, e.clientY);
      }}
      className="relative block aspect-square overflow-hidden rounded-md bg-neutral-100 ring-1 ring-neutral-200 hover:ring-blue-500"
      title="クリックで拡大 / 右クリック=メニュー"
    >
      <img
        key={imgKey}
        src={convertFileSrc(savedPath)}
        alt="generated"
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
        onError={() => {
          if (retried.current) return;
          retried.current = true;
          setTimeout(() => setImgKey((k) => k + 1), 250);
        }}
      />
    </button>
  );
}

function Spinner({ silent }: { silent?: boolean } = {}) {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500"
      role={silent ? undefined : "status"}
      aria-label={silent ? undefined : "読み込み中"}
      aria-hidden={silent ? true : undefined}
    />
  );
}

/**
 * Codex emits item/completed the moment image_gen returns, but the PNG
 * write may not have flushed by the time the WebView fetches it. If the
 * <img> 404s, retry once after 250ms — long enough for any disk flush
 * to settle but short enough that users don't see a broken-image flicker.
 */
function ImageGenerationView({ item }: { item: ImageGenerationItem }) {
  const inProgress = item.status === "inProgress";
  const failed = item.status === "failed";
  const savedPath = item.savedPath ?? null;
  const [imgKey, setImgKey] = useState(0);
  const retried = useRef(false);

  return (
    <div
      className={`rounded-2xl border p-3 text-xs shadow-sm ${
        failed
          ? "border-rose-200 bg-rose-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden />
        <span className="font-medium text-neutral-900">画像生成</span>
        {inProgress ? (
          <span className="ml-auto flex items-center gap-1.5 text-neutral-500">
            <Spinner silent />
            <span>生成中...</span>
          </span>
        ) : failed ? (
          <span className="ml-auto text-rose-400">失敗</span>
        ) : (
          <span className="ml-auto text-blue-700">完了</span>
        )}
      </div>
      {savedPath && (
        <button
          type="button"
          onClick={() => useImagePreview.getState().open(savedPath)}
          className="mt-2 block w-full overflow-hidden rounded-md ring-1 ring-neutral-200 hover:ring-blue-500"
          title="クリックで拡大"
        >
          <img
            key={imgKey}
            src={convertFileSrc(savedPath)}
            alt="generated"
            loading="lazy"
            decoding="async"
            className="block max-h-80 w-full bg-neutral-100 object-contain"
            onError={() => {
              if (retried.current) return;
              retried.current = true;
              setTimeout(() => setImgKey((k) => k + 1), 250);
            }}
          />
        </button>
      )}
      {!savedPath && !inProgress && !failed && (
        <p className="mt-2 text-neutral-500">
          画像は生成されましたが、ファイルパスが返されませんでした。
        </p>
      )}
      {item.revisedPrompt && (
        <details className="mt-2 text-neutral-500">
          <summary className="cursor-pointer">
            Codex が解釈したプロンプト
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-neutral-600">
            {item.revisedPrompt}
          </p>
        </details>
      )}
    </div>
  );
}

/** Pseudo-turn that visualises an in-progress or completed batch. */
function BatchCard({ batch }: { batch: Batch }) {
  const cols = Math.min(batch.count, 4);
  const completed = batch.workers.filter((w) => w.status === "completed").length;
  const failed = batch.workers.filter((w) => w.status === "failed").length;
  const allFailed = failed === batch.count && batch.count > 0;
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(
    null,
  );

  const headerLabel = () => {
    if (batch.status === "cancelled") {
      return (
        <span className="ml-auto text-rose-400">
          中止 (credits 消費済)
        </span>
      );
    }
    if (batch.status === "cancelling") {
      return (
        <span className="ml-auto text-rose-400">
          中止中...
        </span>
      );
    }
    if (batch.status === "completed") {
      if (batch.failedCount === 0) {
        return (
          <span className="ml-auto text-blue-700">
            完了 {completed} 枚
          </span>
        );
      }
      return (
        <span className={`ml-auto ${allFailed ? "text-rose-400" : "text-amber-400"}`}>
          注意 {completed}/{batch.count} 枚完了 / {batch.failedCount} 件失敗
        </span>
      );
    }
    // Still running
    return (
      <span className="ml-auto flex items-center gap-1.5 text-neutral-500">
        <Spinner />
        <span>
          {completed}/{batch.count} 完了
        </span>
      </span>
    );
  };

  return (
    <div className="space-y-2" data-testid="batch-card">
      {/* User message portion */}
      {(batch.prompt || batch.references.length > 0) && (
        <Bubble role="user">
          {batch.references.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {batch.references.map((ref) => (
                <span
                  key={ref.path}
                  className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-800"
                  title={ref.path}
                >
                  {ref.name}
                </span>
              ))}
            </div>
          )}
          {batch.prompt && (
            <pre className="whitespace-pre-wrap font-sans text-sm">{batch.prompt}</pre>
          )}
        </Bubble>
      )}

      {/* Generation group card — mirrors ImageGenerationGroup styling */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-3 text-xs shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden />
          <span className="font-medium text-neutral-900">
            画像生成 · {batch.count} 枚 ·
          </span>
          <ModelTagPill
            provider={batch.provider}
            modelDisplayName={batch.modelDisplayName}
            compareMode={batch.compareMode}
            count={batch.count}
          />
          {headerLabel()}
          {batch.status === "running" && batch.provider === "higgsfield" && (
            <button
              type="button"
              onClick={() => {
                void useBatches.getState().cancelBatch(batch.batchId).catch(console.error);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-500 hover:bg-red-500/20"
              title="ローカル待機を中止します。サーバー側ジョブは完遂、credits は消費されます。"
            >
              中止 (credits 消費)
            </button>
          )}
        </div>
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {batch.workers.map((worker) => (
            <BatchWorkerCell
              key={worker.idx}
              worker={worker}
              onContextMenu={(path, x, y) => setMenu({ path, x, y })}
            />
          ))}
        </div>
        {menu && <GalleryItemContextMenu menu={menu} onClose={() => setMenu(null)} />}
      </div>
    </div>
  );
}

function ModelTagPill({
  provider,
  modelDisplayName,
  compareMode,
  count,
}: {
  provider?: string | null;
  modelDisplayName?: string | null;
  compareMode?: boolean;
  count?: number;
}) {
  if (!provider) return null;
  const providerLabel = provider === "higgsfield" ? "Higgsfield" : "Codex";
  const label =
    compareMode && provider === "higgsfield"
      ? `${providerLabel} · ${count ?? 0} models compared`
      : modelDisplayName
        ? `${providerLabel} · ${modelDisplayName}`
        : null;
  if (!label) return null;
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-pink-500/20 px-1.5 text-[9px] font-bold text-pink-700">
      {label}
    </span>
  );
}

function BatchWorkerCell({
  worker,
  onContextMenu,
}: {
  worker: BatchWorker;
  onContextMenu?: (path: string, x: number, y: number) => void;
}) {
  const [imgKey, setImgKey] = useState(0);
  const retried = useRef(false);
  const caption = worker.modelDisplayName;

  if (worker.status === "pending" || worker.status === "running") {
    return (
      <div className="min-w-0">
        <div className="flex aspect-square items-center justify-center rounded-md bg-neutral-100 ring-1 ring-neutral-200">
          <Spinner silent />
        </div>
        {caption && (
          <p className="mt-1 truncate text-[10px] font-bold text-pink-700">
            {caption}
          </p>
        )}
      </div>
    );
  }

  if (worker.status === "failed") {
    return (
      <div className="min-w-0">
        <div className="flex aspect-square items-center justify-center rounded-md bg-rose-50 px-2 text-center text-[10px] text-rose-600 ring-1 ring-rose-200">
          失敗
        </div>
        {caption && (
          <p className="mt-1 truncate text-[10px] font-bold text-pink-700">
            {caption}
          </p>
        )}
      </div>
    );
  }

  // completed — TypeScript needs an explicit status check to narrow the union
  if (worker.status !== "completed") return null;
  const { path } = worker;
  return (
    <div className="min-w-0">
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          const payload = JSON.stringify({
            path,
            name: path.split("/").pop() ?? "generated.png",
            source: "gallery",
            role: "subject",
          });
          e.dataTransfer.setData("application/x-gori-reference", payload);
          e.dataTransfer.setData("application/json", payload);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => useImagePreview.getState().open(path)}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          onContextMenu(path, e.clientX, e.clientY);
        }}
        className="relative block aspect-square w-full overflow-hidden rounded-md bg-neutral-100 ring-1 ring-neutral-200 hover:ring-blue-500"
        title="クリックで拡大 / 右クリック=メニュー"
      >
        <img
          key={imgKey}
          src={convertFileSrc(path)}
          alt="generated"
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => {
            if (retried.current) return;
            retried.current = true;
            setTimeout(() => setImgKey((k) => k + 1), 250);
          }}
        />
      </button>
      {caption && (
        <p className="mt-1 truncate text-[10px] font-bold text-pink-700">
          {caption}
        </p>
      )}
    </div>
  );
}

function Bubble({
  role,
  children,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
}) {
  const align = role === "user" ? "items-end" : "items-start";
  const bg =
    role === "user"
      ? "border border-blue-200 bg-blue-50 text-neutral-950"
      : "border border-neutral-200 bg-white text-neutral-800 shadow-sm";
  return (
    <div className={`flex flex-col ${align}`}>
      <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${bg}`}>{children}</div>
    </div>
  );
}
