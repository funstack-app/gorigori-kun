import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useStoryboardRun, type CutState } from "../lib/store/storyboardRun";
import { ContextMenu } from "./ContextMenu";
import { buildGalleryItemMenu } from "./galleryItemMenu";
import { RegisterPresetDialog } from "./RegisterPresetDialog";
import { useImages } from "../lib/store/images";

/**
 * B-6: 生成中カットの経過秒を 1 秒ごとに更新する (通常生成 WorkerTile と同じ流儀)。
 * 起点は storyboardRun.lastEventAt (直近イベント受信時刻)。生成中でないときは
 * null を返し interval も張らない。gpt-image-2 は 1 カット数百秒かかるため、
 * 「生成中…」だけだと固まって見える対策。
 */
function useElapsedSeconds(active: boolean, startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!active || !startedAt) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

const STATUS_CLASS: Record<CutState["status"], string> = {
  pending: "border-[#343434] bg-[#101010] text-neutral-500",
  running: "border-blue-400/50 bg-blue-500/10 text-blue-100",
  review: "border-yellow-400/50 bg-yellow-500/10 text-yellow-100",
  confirmed: "border-emerald-400/50 bg-emerald-500/10 text-emerald-100",
  failed: "border-red-400/50 bg-red-500/10 text-red-100",
};

/* ---------- フラットラインアイコン (絵文字を使わない。STΛCK 指示 2026-07-25) ---------- */

function StatusIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

/** 待機中: 時計 */
const PendingIcon = () => (
  <StatusIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </StatusIcon>
);
/** 生成中: 回転矢印 */
const RunningIcon = () => (
  <StatusIcon>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4h-4" />
  </StatusIcon>
);
/** 採用待ち: 目 */
const ReviewIcon = () => (
  <StatusIcon>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </StatusIcon>
);
/** 採用済み: チェック */
const ConfirmedIcon = () => (
  <StatusIcon>
    <path d="M20 6L9 17l-5-5" />
  </StatusIcon>
);
/** 失敗: バツ印 */
const FailedIcon = () => (
  <StatusIcon>
    <path d="M18 6L6 18M6 6l12 12" />
  </StatusIcon>
);

/** 前の案: 左向き山括弧 */
const ChevronLeftIcon = () => (
  <StatusIcon>
    <path d="M15 18l-6-6 6-6" />
  </StatusIcon>
);
/** 次の案: 右向き山括弧 */
const ChevronRightIcon = () => (
  <StatusIcon>
    <path d="M9 18l6-6-6-6" />
  </StatusIcon>
);

/**
 * 状態ラベル (STΛCK 指示 2026-05-15):
 *  「確認待ち」が何を待ってるかが伝わるようにする。
 *  - review = 3案が出揃って AI が一番をベスト判定したあと、ユーザーが確定するのを待ってる状態
 *
 * 2026-07-25: 絵文字プレフィックスを廃止し、アイコン(icon)と語句(text)に分離した。
 * review だけは「何を待っているか」の補足(hint)を小さめの階層で出す。
 */
const STATUS_LABEL: Record<
  CutState["status"],
  { icon: () => ReactElement; text: string; hint?: string }
> = {
  pending: { icon: PendingIcon, text: "待機中" },
  running: { icon: RunningIcon, text: "生成中…" },
  review: { icon: ReviewIcon, text: "採用待ち", hint: "どれを使うか選んでください" },
  confirmed: { icon: ConfirmedIcon, text: "採用済み" },
  failed: { icon: FailedIcon, text: "失敗" },
};

export function StoryboardCutCard({ cut }: { cut: CutState }) {
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const revertCut = useStoryboardRun((s) => s.revertCut);
  const selectTake = useStoryboardRun((s) => s.selectTake);
  const regenerateCut = useStoryboardRun((s) => s.regenerateCut);
  const skipCut = useStoryboardRun((s) => s.skipCut);
  const lastEventAt = useStoryboardRun((s) => s.lastEventAt);

  // B-6: このカットが生成中のとき、直近イベントからの経過秒を表示する。
  const elapsed = useElapsedSeconds(cut.status === "running", lastEventAt);

  // その場で1枚だけ再生成する (2026-06-08 STΛCK指示「1枚生成＋気に入らなければその場で再生成」)。
  //
  // 2026-07-27: 実呼び出しをここに持たせるのをやめ、ストアの regenerateCut に集約した。
  // 以前はこのカードだけが自前で storyboard_regenerate_cut を呼び、ストア側は
  // 「未対応です」のトーストを出す空実装だったため、同じ「作り直す」でも
  // カードからは動き、チェックポイント画面からは動かないという分裂が起きていた。
  // 失敗時に review へ戻す処理もストア側に入っている。
  const handleRegenerate = () => {
    regenerateCut(cut.cutId);
  };

  /*
   * 右クリックメニュー (STΛCK指示 2026-07-25:
   * 「タイムライン上からもそのまま生成したものに関して保存の選択ができて、
   *  保存できるようにしてください」)。
   *
   * ライブラリ (VirtualGalleryGrid / MessageList) と同じ buildGalleryItemMenu を使う。
   * メニューを別に作らないのは、項目が増えたときに片方だけ古くなるのを防ぐため。
   * ギャラリーに登録済みの画像ならその実体を使う (savedTo / お気に入り等の
   * 判定が正しくなる)。無ければ最小の GalleryItem を組み立ててフォールバックする。
   */
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [presetTarget, setPresetTarget] = useState<string | null>(null);
  const galleryItems = useImages((s) => s.items);
  const favorites = useImages((s) => s.favorites);
  const toggleFavorite = useImages((s) => s.toggleFavorite);

  const selectedIndex = cut.takes.findIndex((t) => t.takeId === cut.selectedTakeId);
  const selected =
    cut.takes.find((take) => take.takeId === cut.selectedTakeId) ?? cut.takes[0];

  const showPrev = () => {
    if (cut.takes.length < 2) return;
    const idx = selectedIndex < 0 ? 0 : selectedIndex;
    const prev = cut.takes[(idx - 1 + cut.takes.length) % cut.takes.length];
    selectTake(cut.cutId, prev.takeId);
  };
  const showNext = () => {
    if (cut.takes.length < 2) return;
    const idx = selectedIndex < 0 ? 0 : selectedIndex;
    const nxt = cut.takes[(idx + 1) % cut.takes.length];
    selectTake(cut.cutId, nxt.takeId);
  };

  return (
    <article className={`rounded-xl border p-3 ${STATUS_CLASS[cut.status]}`}>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={!selected}
          onContextMenu={(e) => {
            if (!selected) return;
            e.preventDefault();
            setMenuPos({ x: e.clientX, y: e.clientY });
          }}
          title={selected ? "右クリックで保存・書き出しメニュー" : undefined}
          className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-black/30 bg-[#0b0b0b] disabled:cursor-default"
        >
          {selected ? (
            <img
              src={convertFileSrc(selected.imagePath)}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[10px] text-neutral-600">
              No image
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            {/* カット番号は最上位の見出し。数値なので等幅を維持する */}
            <h4 className="font-mono text-[13px] font-black tabular-nums text-white">
              {cut.cutId}
            </h4>
            <span className="flex flex-col items-end">
              <span className="flex items-center gap-1 text-[12px] font-bold">
                {(() => {
                  const Icon = STATUS_LABEL[cut.status].icon;
                  return <Icon />;
                })()}
                {STATUS_LABEL[cut.status].text}
                {cut.status === "running" && elapsed !== null && (
                  <span className="font-mono text-[10px] font-bold tabular-nums text-blue-200/80">
                    {formatElapsed(elapsed)}
                  </span>
                )}
              </span>
              {STATUS_LABEL[cut.status].hint && (
                <span className="text-[10px] font-normal opacity-70">
                  {STATUS_LABEL[cut.status].hint}
                </span>
              )}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-400">
            <span className="font-bold text-neutral-300">シーン</span>{" "}
            {cut.description ?? cut.sceneGroupId ?? "未設定"}
          </p>
          {selected && (
            <>
              {/* 採点は補足情報。見出し(10px 太字)+数値(10px 等幅)で層を分ける */}
              <p className="mt-2 text-[10px] font-bold tracking-wide text-neutral-500">
                自動採点
              </p>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] text-neutral-300">
              <Score label="Identity" value={selected.scores.identity} />
              <Score label="Outfit" value={selected.scores.outfit} />
              <Score label="Prop" value={selected.scores.prop} />
              <Score label="Face" value={selected.scores.face} />
              <Score label="Hand" value={selected.scores.hand} />
              <Score label="Bg" value={selected.scores.background} />
              </div>
            </>
          )}
          {cut.error && (
            <p className="mt-2 text-[11px] font-bold text-red-200">{cut.error}</p>
          )}

          {/* take 切替 (案A/B/Cを比較) */}
          {cut.takes.length > 1 && cut.status !== "running" && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-300">
              <button
                type="button"
                onClick={showPrev}
                className="flex items-center rounded border border-[#343434] bg-[#0b0b0b] px-1.5 py-1 hover:border-pink-400"
                aria-label="前の案"
              >
                <ChevronLeftIcon />
              </button>
              <span className="font-mono tabular-nums">
                案 {selectedIndex < 0 ? 1 : selectedIndex + 1} / {cut.takes.length}
              </span>
              <button
                type="button"
                onClick={showNext}
                className="flex items-center rounded border border-[#343434] bg-[#0b0b0b] px-1.5 py-1 hover:border-pink-400"
                aria-label="次の案"
              >
                <ChevronRightIcon />
              </button>
            </div>
          )}

          {/* review 状態: 操作ボタン群 */}
          {cut.status === "review" && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => adoptTake(cut.cutId)}
                className="rounded bg-emerald-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-emerald-400"
              >
                採用
              </button>
              <button
                type="button"
                onClick={handleRegenerate}
                className="rounded border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-100 hover:border-amber-400"
              >
                再生成
              </button>
              <button
                type="button"
                onClick={() => skipCut(cut.cutId)}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-200 hover:border-pink-400"
              >
                スキップ
              </button>
            </div>
          )}

          {/* confirmed 状態: 戻すボタン (取り消し対応) */}
          {cut.status === "confirmed" && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => revertCut(cut.cutId)}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-rose-400 hover:text-rose-200"
                title="このカットの採用を取り消して再選択する"
              >
                採用を取り消す
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 右クリックメニュー: ライブラリと同じ項目 (保存/プリセット登録/SNS書き出し等) */}
      {menuPos && selected && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={buildGalleryItemMenu(
            // ギャラリーに登録済みならその実体を使い、無ければ最小構成で組む
            galleryItems.find((it) => it.path === selected.imagePath) ?? {
              path: selected.imagePath,
              name: selected.imagePath.split("/").pop() ?? cut.cutId,
              bucket: "storyboard",
              mtimeMs: Date.now(),
              size: 0,
              kind: "created" as const,
            },
            {
              favorites,
              onToggleFavorite: toggleFavorite,
              onRegisterPreset: (path) => setPresetTarget(path),
            },
          )}
          onClose={() => setMenuPos(null)}
        />
      )}
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget}
          onClose={() => {
            setPresetTarget(null);
            setMenuPos(null);
          }}
        />
      )}
    </article>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline justify-between gap-1 rounded bg-black/20 px-1.5 py-1">
      <span className="text-[9px] text-neutral-500">{label}</span>
      <span className="font-mono text-[10px] font-bold tabular-nums">
        {Math.round(value)}
      </span>
    </span>
  );
}
