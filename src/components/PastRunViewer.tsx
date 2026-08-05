/**
 * owt: 過去 run の読み取り専用ビュー。
 *
 * **操作系 UI を一切置かない。** backend の orchestrator は既に死んでおり、
 * 再生成・採用・スキップのボタンを出しても押せば失敗するだけになる。
 * 作り直しは「新しい生成」として始めてもらう (文言で誘導)。
 */
import { useEffect, useState } from "react";

import { SafeImage } from "./SafeImage";
import {
  readRunSnapshot,
  type RunSnapshotV1,
} from "../lib/store/storyboardRunSnapshot";
import type { CutState } from "../lib/store/storyboardRun";

type Props = {
  runId: string;
  onClose: () => void;
};

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

/** 表示順を決める。cutDisplayOrder があればそれを正とし、無ければ格納順。 */
function orderedCuts(snapshot: RunSnapshotV1): [string, CutState][] {
  const entries = snapshot.cuts?.length ? snapshot.cuts : (snapshot.sketchCuts ?? []);
  const order = snapshot.cutDisplayOrder;
  if (!order || order.length === 0) return entries;
  const byId = new Map(entries);
  const sorted: [string, CutState][] = [];
  for (const cutId of order) {
    const cut = byId.get(cutId);
    if (cut) {
      sorted.push([cutId, cut]);
      byId.delete(cutId);
    }
  }
  // 表示順に載っていないカットも落とさず末尾に付ける。
  for (const rest of byId.entries()) sorted.push(rest);
  return sorted;
}

/** 画像が読めない場合のプレースホルダ (保存先変更で移動した等)。 */
function MissingImage() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded bg-[#141414] p-2 text-center text-[10px] leading-tight text-neutral-500">
      画像が見つかりません（保存先変更などで移動した可能性があります）
    </div>
  );
}

function CutImage({ path }: { path: string }) {
  return (
    <SafeImage
      path={path}
      alt=""
      className="h-full w-full rounded object-contain"
      fallbackLabel="画像が見つかりません（保存先変更などで移動した可能性があります）"
    />
  );
}

export function PastRunViewer({ runId, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<RunSnapshotV1 | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readRunSnapshot(runId).then((s) => {
      if (cancelled) return;
      setSnapshot(s);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const cuts = snapshot ? orderedCuts(snapshot) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[#242424] bg-[#0b0b0b]">
        <header className="flex items-start justify-between gap-3 border-b border-[#242424] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-neutral-100">
              過去のrun（読み取り専用）
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-neutral-500">{runId}</p>
            {snapshot && (
              <p className="mt-1 text-[11px] text-neutral-400">
                {formatTime(snapshot.startedAt ?? snapshot.savedAt)} · 状態:{" "}
                {snapshot.status} · カット {cuts.length} / {snapshot.totalCuts}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-[#333] px-3 py-1 text-[11px] text-neutral-300 hover:bg-[#1a1a1a]"
          >
            閉じる
          </button>
        </header>

        <p className="border-b border-[#242424] bg-[#101010] px-4 py-2 text-[11px] text-amber-200">
          この run は終了済みのため操作できません。作り直す場合は、新しい生成として開始してください。
        </p>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <p className="text-[11px] text-neutral-500">読み込み中…</p>
          )}
          {!loading && !snapshot && (
            <p className="text-[11px] text-neutral-500">
              この run の記録は見つかりませんでした。
            </p>
          )}

          {snapshot && (
            <>
              {snapshot.goal?.summary && (
                <section className="mb-3 rounded border border-[#242424] bg-[#0f0f0f] p-2">
                  <h3 className="text-[11px] font-bold text-sky-300">ゴール</h3>
                  <p className="mt-1 text-[11px] text-neutral-300">
                    {snapshot.goal.summary}
                  </p>
                </section>
              )}

              <section className="mb-3">
                <h3 className="mb-1.5 text-[11px] font-bold text-sky-300">
                  カット（{cuts.length}件）
                </h3>
                {cuts.length === 0 ? (
                  <p className="text-[11px] text-neutral-500">カットの記録はありません。</p>
                ) : (
                  <ul className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {cuts.map(([cutId, cut]) => {
                      const adopted =
                        cut.takes?.find((t) => t.takeId === cut.selectedTakeId) ??
                        cut.takes?.[0];
                      return (
                        <li
                          key={cutId}
                          className="rounded border border-[#242424] bg-[#0f0f0f] p-1.5"
                        >
                          <div className="aspect-video w-full">
                            {adopted?.imagePath ? (
                              <CutImage path={adopted.imagePath} />
                            ) : (
                              <MissingImage />
                            )}
                          </div>
                          <p className="mt-1 truncate font-mono text-[10px] text-neutral-500">
                            {cutId}
                          </p>
                          <p className="text-[10px] text-neutral-400">
                            {cut.status} · テイク {cut.takes?.length ?? 0}件
                          </p>
                          {cut.description && (
                            <p className="mt-0.5 line-clamp-2 text-[10px] text-neutral-400">
                              {cut.description}
                            </p>
                          )}
                          {cut.error && (
                            <p className="mt-0.5 text-[10px] text-red-300">{cut.error}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {snapshot.sketchVersions?.length > 0 && (
                <section className="mb-3">
                  <h3 className="mb-1.5 text-[11px] font-bold text-sky-300">
                    スケッチ版（{snapshot.sketchVersions.length}件）
                  </h3>
                  <ul className="space-y-1">
                    {snapshot.sketchVersions.map((v) => (
                      <li
                        key={v.versionId}
                        className="rounded bg-[#0f0f0f] p-1.5 text-[10px] text-neutral-400"
                      >
                        <span className="font-mono text-neutral-500">{v.versionId}</span>
                        {" · "}
                        {formatTime(v.createdAt)} · カット {v.cuts?.length ?? 0}件
                        {v.confirmed ? " · 確定" : ""}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {snapshot.chatMessages?.length > 0 && (
                <section>
                  <h3 className="mb-1.5 text-[11px] font-bold text-sky-300">
                    チャットログ（{snapshot.chatMessages.length}件）
                  </h3>
                  <ul className="space-y-1">
                    {snapshot.chatMessages.map((m) => (
                      <li
                        key={m.id}
                        className="rounded bg-[#0f0f0f] p-1.5 text-[11px] text-neutral-300"
                      >
                        <span className="mr-1 text-[10px] text-neutral-500">
                          [{m.role}]
                        </span>
                        {m.text}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
