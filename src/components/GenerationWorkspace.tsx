import { useEffect, useMemo, useRef, useState } from "react";
import { SafeImage, SafeVideo } from "./SafeImage";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { SceneBuilder, VideoSceneBuilder } from "./scene";
import { ConstructedPromptPanel } from "./ConstructedPromptPanel";
import { PageHelp } from "./PageHelp";
import { useSceneGeneration } from "../lib/scene/useSceneGeneration";
import { AdAgentPanel } from "./agents";
import { EditWorkspace } from "./EditWorkspace";
import { PlanWorkspace } from "./PlanWorkspace";
import { VideoGenerationWorkspace } from "./VideoGenerationWorkspace";
import { useBatches, type BatchWorker } from "../lib/store/batches";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages, type GalleryItem } from "../lib/store/images";
import {
  TIMELINE_SIZE_MAX,
  TIMELINE_SIZE_MIN,
  useWorkspace,
  type TimelineSize,
} from "../lib/store/workspace";
import { useVideoGen } from "../lib/store/videoGen";
import { history, type SessionFull, type TurnWithImages } from "../lib/ipc";
import { useActiveProject } from "../lib/store/activeProject";
import { useProjects } from "../lib/store/projects";
import { useSessions } from "../lib/store/sessions";
import { ActiveProjectSelector } from "./ActiveProjectSelector";
import { ensureStoryboardEventListener } from "../lib/storyboard/events";
import { storyboard } from "../lib/ipc";
import { useAuth } from "../lib/store/auth";
import { usePlanChat } from "../lib/store/planChat";
import { useScenePromptOverride } from "../lib/store/scenePrompt";
import { useSkillMode } from "../lib/store/skillMode";
import { useStoryboardRun } from "../lib/store/storyboardRun";
import {
  hasDiskSnapshot,
  hydratePastRunsFromDisk,
  startRunSnapshotWriter,
} from "../lib/store/storyboardRunSnapshot";
import { PastRunViewer } from "./PastRunViewer";
import { useToasts } from "../lib/store/toasts";
import { StoryboardCutCard } from "./StoryboardCutCard";
import { SkillRunActions } from "./SkillRunActions";
import { extractDropped, isImageDrop, setDragRef } from "../lib/dragRef";
import { sendImageToPlanForRediscuss } from "../lib/sendToPlan";
import { GenerationGauge, type GenerationGaugeMode } from "./GenerationGauge";

export function GenerationWorkspace() {
  const activeTab = useWorkspace((s) => s.activeTab);

  useEffect(() => {
    void ensureStoryboardEventListener();
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      {/*
        STΛCK 指示 (2026-05-20): 「用途」セレクタは削除。
        制作画面は 1 つに統一し、スキルを ON にすることで UI が
        そのスキルに最適化されたモードに切り替わる仕様に変更する。
      */}
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        {/*
          S2a (2026-08-04): 「CSVで書き出し」をタブ列から撤去した。
          重複導線 (プロジェクト詳細シートに同機能あり) かつ低頻度機能が
          一等地を常時占有していたため (ui-placement-grammar §1 / §5)。
          機能自体は残す — ProjectCsvExportButton の実装とプロジェクト詳細側の
          導線は無変更で、書き出しはそちらから行う。
        */}
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        {activeTab === "plan" && <PlanWorkspace />}
        {activeTab === "generate" && <GenerateTab />}
        {activeTab === "video" && <VideoGenerationWorkspace timeline={<Timeline />} />}
        {activeTab === "edit" && <EditWorkspace />}
      </div>
    </section>
  );
}

function GenerateTab() {
  const purpose = useWorkspace((s) => s.purpose);
  const skillModeEnabled = useSkillMode((s) => s.enabled);
  const showStoryboardRun = purpose === "videoStory" && skillModeEnabled;

  // 左パネルは旧 380-520px → 320-360px に縮小（約 2/3）。
  // スキルモード中だけ右側を実行進捗に差し替え、旧「実行」タブを生成タブへ内包する。
  return (
    <div className="grid h-full min-h-0 gap-4 md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <LeftPanel purpose={purpose} />
      {showStoryboardRun ? <StoryboardRunPanel /> : <Timeline />}
    </div>
  );
}

function LeftPanel({ purpose }: { purpose: "artwork" | "ad" | "videoStory" }) {
  const skillModeEnabled = useSkillMode((s) => s.enabled);
  const title = purpose === "artwork" ? "シーン構築" : purpose === "ad" ? "広告構築" : "ストーリーカット構築";

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      <div className="shrink-0 border-b border-[#242424] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-black text-white">{title}</h3>
          <PageHelp
            what="左の要素を選ぶかプロンプトを書くと、その内容で画像を生成します。参照画像・プリセット・スキルで狙いを固定できます。"
            first="まずは左でシーンの要素を選ぶか、下の入力欄に作りたい絵を書いてください。"
            note="鉛筆アイコンから、自分で描いたスケッチを参照や3Dシーンにできます。"
          />
        </div>
      </div>

      {purpose === "artwork" && (
        <>
          <div className="shrink-0 p-3">
            <SceneBuilder />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[#242424] bg-[#181818]">
            <ConstructedPromptPanel />
          </div>
        </>
      )}

      {purpose === "ad" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <AdAgentPanel />
        </div>
      )}

      {purpose === "videoStory" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {skillModeEnabled && (
            <div className="shrink-0 space-y-3 border-b border-[#242424] p-3">
              <SkillSettingsPanel />
            </div>
          )}
          {!skillModeEnabled && (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <VideoSceneBuilder />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ストーリーモードの動画タブでも同じタイムライン (過去生成物) を出すため export する。
// StoryboardWorkspace が VideoGenerationWorkspace に timeline prop として渡す (#27 表示消失修正)。
export function Timeline() {
  const batches = useBatches((s) => s.batches);
  const items = useImages((s) => s.items);
  const timelineSize = useWorkspace((s) => s.timelineSize);

  // ユーザー要望: チャット履歴で「開く」を押したら、そのセッションの
  // 生成タイムラインだけを表示する。
  // useSessions.isFrozen が立っているとき = displayedSession の中身を出す。
  const isFrozen = useSessions((s) => s.isFrozen);
  const displayedSession = useSessions((s) => s.displayedSession);
  const switchToLive = useSessions((s) => s.switchToLive);

  // ユーザー要望: activeProject 連動。
  // プロジェクトが選ばれていれば、その箱に入っている画像だけを
  // タイムラインに表示する。未選択なら従来通り全件。
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const activeProject = useProjects((s) =>
    activeProjectId ? s.projects.find((p) => p.id === activeProjectId) ?? null : null,
  );
  const projectImagePaths = useMemo(() => {
    if (!activeProject) return null;
    return new Set(activeProject.items.map((it) => it.imagePath));
  }, [activeProject]);

  // Sort batches newest-first.
  const orderedBatchesRaw = [...batches].sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );

  // プロジェクト指定時の batches フィルタ。
  //
  // ユーザー指摘 (継続): プロジェクトを選択すると、新規生成中バッチの
  // 「生成中」ペンディングは出るのにグリッドが出てこない。
  //
  // 原因:
  //   生成走り始めの workers は status='running' / 'pending' で path が無く、
  //   activeProject に画像が紐付くのは workerCompleted の瞬間。
  //   「全 worker が completed && in project」を要件にすると、走り始め直後は
  //   まだ project に未登録 → バッチごと隠してしまっていた。
  //
  // 対応:
  //   - **進行中バッチ (= 1 件でも完了していない worker がある) は常に表示**
  //     完了画像は workerCompleted で activeProject に自動追加されるので、
  //     完了した瞬間からそのバッチも「絞り込み対象として正しく」見える。
  //   - 全 worker が完了済みのバッチだけ projectImagePaths でフィルタを適用
  //     (= 過去のバッチ。プロジェクト外なら隠す)
  //   - workers レベルのフィルタも、進行中バッチではしない
  //     (生成中グリッドのプレースホルダが消えるのを防ぐ)
  const orderedBatches = projectImagePaths
    ? orderedBatchesRaw.filter((b) => {
        const allDone = b.workers.every((w) => w.status !== "running" && w.status !== "pending");
        if (!allDone) return true; // 進行中は常に表示
        // 完了済バッチは「1 件でも project に入ってる」なら表示
        return b.workers.some(
          (w) =>
            w.status === "completed" &&
            w.path &&
            projectImagePaths.has(w.path),
        );
      })
    : orderedBatchesRaw;

  // 「過去の生成」: 全セッション横断の turn 履歴（バッチ単位）を時系列降順で表示。
  // ユーザー指摘:
  //   - 制作タブに移動するとタイムラインがリセットされて見える
  //   - 過去の生成は「ログごとに」リスト表示してほしい
  // → useImages.items を一括グリッドにせず、履歴と画像パスを一括取得して
  //   バッチ単位に分けて表示する。
  const [pastBatches, setPastBatches] = useState<TurnWithImages[]>([]);
  const [pastLoading, setPastLoading] = useState(false);

  // 画像 watcher の1枚ごとの通知ではなく、既存 batch state の完了/中止を合図にする。
  // ライブラリスキャンの画像数に比例せず、新しい生成が終わった時だけ自動反映する。
  const completedBatchesSignal = batches
    .filter((batch) => batch.status === "completed" || batch.status === "cancelled")
    .map((batch) => `${batch.startedAt}:${batch.status}`)
    .join("|");
  // リネーム時も、行ごとの再取得ではなく履歴全体を1回だけ取り直す。
  const renameNonce = useImages((s) => s.renameNonce);
  useEffect(() => {
    let cancelled = false;
    setPastLoading(true);
    history
      .recentWithImages(60)
      .then((rows) => {
        if (!cancelled) setPastBatches(rows);
      })
      .catch((err) => console.error("recentWithImages failed", err))
      .finally(() => {
        if (!cancelled) setPastLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [completedBatchesSignal, renameNonce]);

  // 現在 batches に出ている turn id は除外（重複表示防止）。
  // 現状 batches 側は dbTurnId を直接持たないので、最近 5 件分はラフに除外する。
  const recentlyShownPrompts = new Set(
    orderedBatches.map((b) => b.prompt ?? "").filter(Boolean),
  );
  const pastFiltered = pastBatches.filter(
    (row) => !recentlyShownPrompts.has(row.prompt),
  );

  const showPastSection = pastFiltered.length > 0;
  const isEmpty = orderedBatches.length === 0 && pastFiltered.length === 0 && !pastLoading;

  // frozen mode: チャット履歴で「開く」を押した状態。
  // displayedSession.turns をバッチブロック化して表示し、ライブ batches や
  // 過去履歴は出さない（過去セッションを閲覧する文脈に集中）。
  if (isFrozen && displayedSession) {
    return (
      <FrozenSessionTimeline
        session={displayedSession}
        size={timelineSize}
        onLeave={switchToLive}
      />
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]"
      /*
        STΛCK 指示 (2026-05-19): 生成タイムラインを drop target 化。
        画像を投げ込むと「企画タブで再検討」を起動 (お気に入りをベースに
        プロンプトを練り直す導線)。
      */
      onDragOver={(event) => {
        if (isImageDrop(event.dataTransfer)) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const { refs } = extractDropped(event.dataTransfer);
        const target = refs[0]?.path;
        if (target) {
          void sendImageToPlanForRediscuss(target);
        }
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-black text-white">生成タイムライン</h3>
          <span className="rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-500">
            {activeProject ? activeProject.items.length : items.length}
          </span>
          {activeProject && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-pink-500/15 px-2 py-0.5 text-[10px] font-bold text-pink-200 ring-1 ring-pink-500/30"
              title="プロジェクト内のみ表示中"
            >
              <ProjectFilterIcon />
              <span>{activeProject.name}</span>
            </span>
          )}
        </div>
        <TimelineSizeToggle />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isEmpty ? (
          <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs font-medium text-neutral-500">
            生成すると、ここに新しいバッチが上に追加されます
          </div>
        ) : (
          <div className="space-y-6">
            {orderedBatches.length > 0 && (
              <div className="space-y-4">
                {orderedBatches.map((batch) => (
                  <BatchBlock
                    key={`${batch.startedAt}-${batch.count}`}
                    workers={batch.workers}
                    count={batch.count}
                    startedAt={batch.startedAt}
                    prompt={batch.prompt}
                    size={timelineSize}
                    provider={batch.provider}
                    modelDisplayName={batch.modelDisplayName}
                    compareMode={batch.compareMode}
                    batchStatus={batch.status}
                  />
                ))}
              </div>
            )}
            {pastLoading && pastFiltered.length === 0 && (
              <p className="rounded-lg border border-dashed border-[#343434] bg-[#101010] p-4 text-center text-[11px] text-neutral-500">
                過去の生成を読み込み中...
              </p>
            )}
            {showPastSection && (
              <PastBatchList
                rows={pastFiltered}
                size={timelineSize}
                projectImagePaths={projectImagePaths}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * チャット履歴で「開く」を押した時に表示する、frozen セッションのタイムライン。
 *
 * displayedSession.turns を時系列降順でバッチブロック化。各 turn の images は
 * すでに SessionFull に含まれているので追加 fetch なし。
 *
 * 上部にバナー: 「(履歴アイコン) [セッション名] を表示中・ライブに戻る」
 * ライブに戻るボタン → useSessions.switchToLive で通常タイムラインに復帰
 */
function FrozenSessionTimeline({
  session,
  size,
  onLeave,
}: {
  session: SessionFull;
  size: TimelineSize;
  onLeave: () => void;
}) {
  const orderedTurns = useMemo(
    () =>
      [...session.turns].sort((a, b) => b.createdAt - a.createdAt),
    [session.turns],
  );
  const totalImages = useMemo(
    () => orderedTurns.reduce((acc, t) => acc + t.images.length, 0),
    [orderedTurns],
  );
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-pink-400/40 bg-[#181818]">
      <div className="flex items-center justify-between gap-3 border-b border-pink-400/30 bg-pink-500/5 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-pink-500/20 px-2 py-0.5 text-[10px] font-bold text-pink-200 ring-1 ring-pink-400/40">
            <HistoryIcon />
            <span>セッション表示</span>
          </span>
          <h3 className="truncate text-sm font-black text-white">
            {session.session.title}
          </h3>
          <span className="shrink-0 rounded border border-[#343434] bg-[#101010] px-2 py-0.5 text-[10px] font-bold text-neutral-400">
            {orderedTurns.length} ログ / {totalImages} 枚
          </span>
        </div>
        <div className="flex items-center gap-2">
          <TimelineSizeToggle />
          <button
            type="button"
            onClick={onLeave}
            className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-3 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            title="現在のライブセッションに戻る"
          >
            ライブに戻る
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {orderedTurns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs text-neutral-500">
            このセッションには生成記録がありません
          </div>
        ) : (
          <div className="space-y-4">
            {orderedTurns.map((turn) => (
              <FrozenTurnBlock key={turn.id} turn={turn} size={size} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function FrozenTurnBlock({
  turn,
  size,
}: {
  turn: TurnWithImages;
  size: TimelineSize;
}) {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#101010]">
      <div className="border-b border-[#242424] p-3">
        <p className="line-clamp-2 text-[11px] text-neutral-300">
          {turn.prompt || "(プロンプトなし)"}
        </p>
        <p className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
          <span>{formatDateTime(turn.createdAt)}</span>
          <span className="rounded bg-[#1f1f1f] px-1.5 py-px text-[9px] font-bold text-neutral-300">
            {turn.images.length} 枚
          </span>
          <ModelTagPill
            provider={turn.provider}
            modelDisplayName={turn.modelDisplayName}
          />
          {turn.model && (
            <span className="text-[9px] text-neutral-600">{turn.model}</span>
          )}
        </p>
      </div>
      <div className="p-3">
        {turn.images.length === 0 ? (
          <p className="text-[11px] text-neutral-500">
            画像はまだ記録されていません。
          </p>
        ) : (
          <div className={`grid gap-2 ${gridColsClass(size)}`}>
            {turn.images.map((img) => (
              <button
                key={img.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  setDragRef(e.dataTransfer, {
                    path: img.path,
                    name: img.path.split(/[\\/]/).pop() ?? "generated.png",
                    source: "gallery",
                    role: "subject",
                  });
                }}
                onClick={() =>
                  useImagePreview
                    .getState()
                    .open(
                      img.path,
                      turn.images.map((i) => i.path),
                    )
                }
                className="aspect-square overflow-hidden rounded border border-[#343434] bg-[#0f0f0f] hover:border-pink-400"
              >
                <SafeImage
                  path={img.path}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 過去の生成バッチをログ単位（TurnWithImages = turn）でリスト表示する。
 * 画像は親で一括取得済みなので、行ごとのDB取得は行わない。
 *
 * BatchBlock との違い:
 * - 進行中 / 失敗の status はない（過去ログなので全件成功扱い）
 * - 画像は最近の履歴と一緒に一括ロードする
 */
function PastBatchList({
  rows,
  size,
  projectImagePaths,
}: {
  rows: TurnWithImages[];
  size: TimelineSize;
  /** activeProject が選ばれていれば、その画像 path セット。null なら全件表示。 */
  projectImagePaths: Set<string> | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-bold text-neutral-300">
          過去の生成{projectImagePaths ? "（プロジェクト内のみ）" : `（${rows.length} 件）`}
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <PastBatchRow
            key={row.id}
            row={row}
            size={size}
            projectImagePaths={projectImagePaths}
          />
        ))}
      </div>
    </div>
  );
}

function PastBatchRow({
  row,
  size,
  projectImagePaths,
}: {
  row: TurnWithImages;
  size: TimelineSize;
  projectImagePaths: Set<string> | null;
}) {
  // ユーザー指摘: 「折りたたみ式だとサイズスライダーが効いている実感がない」
  // → 各バッチを最初から展開し、画像グリッドが常に見える状態にする。
  // プロジェクト指定時は images をフィルタ。ヒット 0 件なら行ごと隠す。
  const visibleImages = projectImagePaths
    ? row.images.filter((img) => projectImagePaths.has(img.path))
    : row.images;
  // プロジェクト絞り込み時 + 該当画像 0 → このバッチは
  // プロジェクト外なので行ごと描画しない (空のカードを増やさない)。
  if (projectImagePaths && visibleImages.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#101010]">
      <div className="flex items-center gap-3 border-b border-[#242424] p-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[11px] text-neutral-300">
            {row.prompt || "(プロンプトなし)"}
          </p>
          <p className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
            <span>{formatDateTime(row.createdAt)}</span>
            <span className="rounded bg-[#1f1f1f] px-1.5 py-px text-[9px] font-bold text-neutral-300">
              {projectImagePaths
                ? `${visibleImages.length} 枚 (元 ${row.count})`
                : `${row.count} 枚`}
            </span>
            <span className="text-[9px] text-neutral-600">{row.kind}</span>
            <ModelTagPill
              provider={row.provider}
              modelDisplayName={row.modelDisplayName}
            />
          </p>
        </div>
      </div>
      <div className="p-3">
        {visibleImages.length > 0 && (
          <div className={`grid gap-2 ${gridColsClass(size)}`}>
            {visibleImages.map((img) => (
              <button
                key={img.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  setDragRef(e.dataTransfer, {
                    path: img.path,
                    name: img.path.split(/[\\/]/).pop() ?? "generated.png",
                    source: "gallery",
                    role: "subject",
                  });
                }}
                onClick={() =>
                  // STΛCK 指示 (2026-05-17): 矢印キーで他バッチに飛ばない。
                  // siblings = このバッチ内の画像のみ。
                  useImagePreview
                    .getState()
                    .open(img.path, visibleImages.map((i) => i.path))
                }
                className="aspect-square overflow-hidden rounded border border-[#343434] bg-[#0f0f0f] hover:border-pink-400"
              >
                <SafeImage
                  path={img.path}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
        {visibleImages.length === 0 && !projectImagePaths && (
          <p className="text-[11px] text-neutral-500">
            画像はまだ記録されていません。
          </p>
        )}
      </div>
    </div>
  );
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `今日 ${hh}:${mm}`;
  const M = d.getMonth() + 1;
  const D = d.getDate();
  return `${M}/${D} ${hh}:${mm}`;
}

/**
 * サムネ密度のスライダー。値はそのままグリッド列数（少ない = サムネ大）。
 * range input で連続調整できる。Tailwind grid-cols-N は静的解析のため
 * gridColsClass で数値→クラス文字列にマップする。
 */
function TimelineSizeToggle() {
  const timelineSize = useWorkspace((s) => s.timelineSize);
  const setTimelineSize = useWorkspace((s) => s.setTimelineSize);
  return (
    <label
      className="inline-flex items-center gap-2 rounded-md border border-[#343434] bg-[#101010] px-2 py-1"
      title="サムネを大きく ⇔ 小さく"
    >
      <span className="text-[10px] font-bold text-neutral-500">大</span>
      <input
        type="range"
        min={TIMELINE_SIZE_MIN}
        max={TIMELINE_SIZE_MAX}
        step={1}
        value={timelineSize}
        onChange={(event) => setTimelineSize(Number(event.target.value))}
        className="h-1 w-24 cursor-pointer accent-pink-500"
        aria-label="タイムラインのサムネサイズ"
      />
      <span className="text-[10px] font-bold text-neutral-500">小</span>
      <span className="ml-1 w-5 text-center text-[10px] font-black tabular-nums text-neutral-300">
        {timelineSize}
      </span>
    </label>
  );
}

/**
 * 数値サイズからグリッドの Tailwind クラスへ。
 * Tailwind は文字列を静的に解析するため、grid-cols-N は事前に書き出しておく。
 *
 * - 小さい size = 列数少 = サムネ大（widest）
 * - 大きい size = 列数多 = サムネ小（denser）
 *
 * sm/lg ブレークポイントは size を基準に +1〜+2 列、画面が広いほど詰める。
 */
const COL_BASE: Record<number, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-5 lg:grid-cols-6",
  7: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-7",
  8: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-8",
};

function gridColsClass(size: TimelineSize): string {
  return COL_BASE[size] ?? COL_BASE[4];
}

function BatchBlock({
  workers,
  count,
  startedAt,
  prompt,
  size,
  provider,
  modelDisplayName,
  compareMode,
  batchStatus,
}: {
  workers: BatchWorker[];
  count: number;
  startedAt?: number;
  prompt?: string;
  size: TimelineSize;
  provider?: string;
  modelDisplayName?: string;
  compareMode?: boolean;
  batchStatus: "running" | "completed" | "cancelling" | "cancelled";
}) {
  const completed = workers.filter((w) => w.status === "completed").length;
  const failed = workers.filter((w) => w.status === "failed").length;
  const total = count;

  let status: string;
  // credits は外部 provider の語彙。中止できるのは codex 経路だけなので、
  // ここで credits に言及すると codex 経路にだけ嘘をつくことになる (2026-07-28)。
  if (batchStatus === "cancelled") status = "中止しました";
  else if (batchStatus === "cancelling") status = "中止中...";
  else if (completed === total) status = `完了 ${completed}枚`;
  else if (failed > 0 && completed + failed === total)
    status = `${completed}枚成功 / ${failed}件失敗`;
  else status = `生成中 ${completed}/${total}`;

  return (
    <div className="rounded-lg border border-[#303030] bg-[#101010] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-bold text-neutral-300">{status}</span>
          <ModelTagPill
            provider={provider}
            modelDisplayName={modelDisplayName}
            compareMode={compareMode}
            count={count}
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/*
            2026-07-28: higgsfield 限定の中止ボタン (credits 消費を断り書きしていた) を削除した。
            外部 provider の生成は止められないのに押せてしまい、押すとカードが
            cancelled になった後で完了表示に復活する実害があった (batches.ts の
            cancelBatch コメント参照)。パネル側の決定 (isStoppableProvider の
            allow-list で外部 provider には中止を出さない) と揃える。
            「もう見たくない」用途はパネルの × (dismissJob) が既に担っている。
          */}
          {batchStatus === "cancelling" && (
            <span className="text-[10px] font-bold text-red-400">中止中...</span>
          )}
          {batchStatus === "cancelled" && (
            <span className="text-[10px] font-bold text-red-400">
              中止しました
            </span>
          )}
          {startedAt && (
            <span className="text-[10px] font-medium text-neutral-500">
              {formatTime(startedAt)}
            </span>
          )}
        </div>
      </div>
      {prompt && (
        <p className="mb-2 line-clamp-2 text-[10px] text-neutral-500">
          {prompt}
        </p>
      )}
      <div className={`grid gap-2 ${gridColsClass(size)}`}>
        {workers.map((worker) => (
          <WorkerTile
            // Bug修正 (2026-05-28): local→real batchId の差し替えでタイルを再マウントさせない。
            key={worker.idx}
            worker={worker}
            compareMode={compareMode}
            provider={provider}
            batchCancelled={batchStatus === "cancelled" || batchStatus === "cancelling"}
            siblings={workers
              .filter(
                (w): w is Extract<BatchWorker, { status: "completed" }> =>
                  w.status === "completed",
              )
              .map((w) => w.path)}
          />
        ))}
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
  const providerLabel =
    provider === "magnific"
      ? "Magnific"
      : provider === "higgsfield"
        ? "Higgsfield"
        : "Codex";
  const label =
    compareMode && (provider === "higgsfield" || provider === "magnific")
      ? `${providerLabel} · ${count ?? 0} models compared`
      : modelDisplayName
        ? `${providerLabel} · ${modelDisplayName}`
        : null;
  if (!label) return null;
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded bg-pink-500/20 px-1.5 text-[9px] font-bold text-pink-200">
      {label}
    </span>
  );
}

/**
 * 生成中タイルの経過秒を 1 秒ごとに更新する。
 * DEV-PLAYBOOK §6 C (2026-06-16): gpt-image-2 は p95 で 280 秒かかるため、
 * 「生成中」テキストだけだと 20 分止まって見える (ユーザーが固まったと誤解する)。
 * 経過秒 + スピナーで「動いている」ことを可視化する。
 * worker が生成中でないときは null を返し、interval も張らない。
 */
function useElapsedSeconds(active: boolean, startedAt?: number): number | null {
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

function WorkerTile({
  worker,
  siblings,
  compareMode,
  batchCancelled,
  provider,
}: {
  worker: BatchWorker;
  siblings?: string[];
  /**
   * このバッチの provider (2026-07-28 追加)。ゲージの学習バケット選択にのみ使う。
   * 外部 provider は codex 経路と所要時間の桁が違うため、同じバケットで学習させると
   * 推定の前提が崩れる。
   */
  provider?: string;
  /** 比較モード (各モデル1枚) のバッチか。再生成ボタンの出し分けに使う。 */
  compareMode?: boolean;
  /**
   * バッチ全体が中止されたか (2026-07-27 追加)。
   *
   * ## なぜ要るか (実機で踏んだ不具合)
   * 「やめる」でバッチを中止しても、タイルは worker.status しか見ていないため
   * **「生成中 14秒」のまま秒数が増え続けていた**。バッチのヘッダーには
   * 中止した旨が出ているのに、その下のタイルが動いて見える、
   * という食い違いが起きる。
   *
   * worker 個別の status は Rust からのイベントで更新されるが、中止時は
   * そのイベントが来ないまま止まるので、**バッチ側の状態で上書きする**必要がある。
   */
  batchCancelled?: boolean;
}) {
  const caption = worker.modelDisplayName;
  const canSendToVideo = worker.mediaType !== "video";
  // worker 個別の開始時刻 (semaphore permit を取った瞬間) を優先する。
  // まだ pending (semaphore 待ち) の worker は runningAt が無いので、
  // バッチ開始時刻を使わず経過秒を出さない (待機中は「待機中」表示)。
  const workerStartedAt =
    worker.status === "running" || worker.status === "pending"
      ? worker.runningAt
      : undefined;
  // 中止されたバッチのタイルは、Rust から完了イベントが来ないまま止まるので
  // running のまま残る。バッチ側の中止状態で上書きし、秒数の進行を止める。
  const isRunning =
    !batchCancelled && worker.status === "running" && workerStartedAt != null;
  // ゲージの学習バケット。外部 provider は codex 経路と所要時間の桁が違うため
  // 分離する (2026-07-28)。Higgsfield は画像と動画でさらに桁が違うので別バケット。
  const gaugeMode: GenerationGaugeMode =
    provider === "magnific"
      ? "magnific"
      : provider === "higgsfield"
        ? worker.mediaType === "video"
          ? "higgsfield-video"
          : "higgsfield"
        : "batch";

  const elapsed = useElapsedSeconds(isRunning, workerStartedAt);
  if (worker.status === "completed") {
    return (
      <div className="min-w-0">
        {/*
          STΛCK 指示 (2026-05-19): 生成タイムラインのバッチサムネを drag source 化。
          ライブラリや参照ラック等の他 drop ターゲットへ直接ドラッグで移動できる。
        */}
        <div className="group relative aspect-square w-full overflow-hidden rounded border border-[#343434] bg-[#0f0f0f] hover:border-pink-400">
          <button
            type="button"
            draggable
            onDragStart={(e) => {
              setDragRef(e.dataTransfer, {
                path: worker.path,
                name: worker.path.split(/[\\/]/).pop() ?? "generated.png",
                source: "gallery",
                role: "subject",
              });
            }}
            onClick={() =>
              useImagePreview.getState().open(worker.path, siblings)
            }
            className="h-full w-full overflow-hidden"
          >
            {worker.mediaType === "video" ? (
              <SafeVideo
                path={worker.path}
                hoverPlay
                className="h-full w-full object-cover"
              />
            ) : (
              <SafeImage
                path={worker.path}
                className="h-full w-full object-cover"
              />
            )}
          </button>
          {canSendToVideo && (
            <button
              type="button"
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                useVideoGen.getState().setSourceImage(worker.path);
                useWorkspace.getState().setActiveTab("video");
                useToasts.getState().push({
                  kind: "success",
                  text: "動画タブに画像をセットしました",
                  ttlMs: 3000,
                });
              }}
              className="absolute bottom-1.5 right-1.5 rounded-md border border-pink-300/50 bg-pink-500 px-2 py-1 text-[10px] font-black text-white opacity-0 shadow-lg transition hover:bg-pink-400 focus:opacity-100 group-hover:opacity-100"
              title="この画像を動画生成タブの元画像に使う"
            >
              動画化
            </button>
          )}
        </div>
        {/*
          STΛCK 指示 (2026-05-19): サムネ下の「プロジェクトに保存」ボタンは削除。
          Magnific 風プレビューの右ペインから保存できるため冗長 (4 枚並ぶと UI
          がうるさかった)。caption のみ残す。
        */}
        {caption && (
          <p className="mt-1 truncate text-[10px] font-medium text-neutral-400">
            {caption}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div
        className={[
          "flex aspect-square flex-col items-center justify-center gap-1.5 rounded border text-[10px] font-bold",
          worker.status === "failed"
            ? "border-red-500/50 bg-red-950/30 text-red-400"
            : "border-[#343434] bg-[#181818] text-neutral-400",
        ].join(" ")}
      >
        {worker.status === "failed" ? (
          <>
            <span>失敗</span>
            {/* DEV-PLAYBOOK §6 B: 失敗ワーカーの再生成。現在の設定 (プロンプト/モデル) で
                1 枚だけ生成し直す。比較モード (各モデル1枚で index 対応) では枚数を
                変えられないため再生成ボタンは出さない。 */}
            {!compareMode && <RegenerateOneButton />}
          </>
        ) : (
          <>
            {/* 中止済みは動いていないのでスピナーを回さない (動いて見せない) */}
            {!batchCancelled && <Spinner />}
            {/* semaphore 待ち (pending) の worker は「待機中」、実際に走り出した
                (running) worker は「生成中」+ 経過秒。MAX_CONCURRENT=3 で 4 枚目
                以降は順番待ちなので、待機中に経過秒を出すと誤解を招く。
                中止されたバッチは「中止」と出す (待機中だと再開すると誤解される)。 */}
            <span>{batchCancelled ? "中止" : isRunning ? "生成中" : "待機中"}</span>
            {isRunning && elapsed !== null && (
              <>
                <span className="font-mono text-[9px] font-medium text-neutral-500">
                  {formatElapsed(elapsed)}
                </span>
                <div className="mt-1 w-3/4">
                  <GenerationGauge startedAt={workerStartedAt} mode={gaugeMode} />
                </div>
              </>
            )}
          </>
        )}
      </div>
      {caption && (
        <p className="mt-1 truncate text-[10px] font-bold text-pink-300">
          {caption}
        </p>
      )}
    </div>
  );
}

/*
  フラットアイコン群 (絵文字を使わずインライン SVG で表現)。
  stroke="currentColor" なので親の text-* をそのまま継承する。
*/

/** プロジェクト絞り込みバッジ用。フォルダ + フィルタ。 */
function ProjectFilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M8 12h8l-3 3.5V19l-2-1v-2.5z" />
    </svg>
  );
}

/** frozen セッション表示バナー用。時計を巻き戻す = 過去ログ。 */
function HistoryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

/** 連続カット生成 (動画寄りの工程) 用。カチンコ。 */
function ClapperIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3.5 10 2.8 6.4a1 1 0 0 1 .8-1.2l14.7-2.6a1 1 0 0 1 1.2.8L20 7z" />
      <path d="m8.4 3.9 1 4.8M13.4 3 14.4 7.8" />
    </svg>
  );
}

/** デバッグログの読み込みボタン用。クリップボード。 */
function ClipboardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

/** スキル実行ボタン用。再生三角。 */
function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

/** 軽量な CSS スピナー (生成中タイル用)。 */
function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-pink-400"
      aria-hidden
    />
  );
}

/**
 * 失敗ワーカーの再生成ボタン (DEV-PLAYBOOK §6 B)。
 * 現在のシーン設定 (プロンプト/モデル/参照画像) で 1 枚だけ生成し直す。
 * 元バッチの完全再現ではなく「今の設定でもう 1 枚」なので、ツールチップで明示する。
 * 生成キューが満杯 or 生成不可状態のときは無効化する。
 */
function RegenerateOneButton() {
  const { generate, disabled, isQueueFull } = useSceneGeneration();
  const blocked = disabled || isQueueFull;
  return (
    <button
      type="button"
      disabled={blocked}
      onClick={(e) => {
        e.stopPropagation();
        void generate({ countOverride: 1 }).catch(console.error);
      }}
      className="mt-0.5 rounded border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-[9px] font-bold text-red-200 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40"
      title={
        blocked
          ? "生成キューが空くまで待ってください"
          : "今の設定 (プロンプト/モデル) で 1 枚だけ生成し直します"
      }
    >
      再生成
    </button>
  );
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Suppress unused warnings while keeping the import for legacy gallery item type.
export type { GalleryItem };

function StoryboardRunPanel() {
  const run = useStoryboardRun();
  const usedPercent = useAuth((s) => s.rateLimits?.primary?.usedPercent ?? 0);
  const pushToast = useToasts((s) => s.push);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLogContent, setDebugLogContent] = useState<string | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const completedToastRunId = useRef<string | null>(null);
  // owt: 読み取り専用の過去 run ビューで開いている runId。null = 閉じている。
  const [pastRunViewerId, setPastRunViewerId] = useState<string | null>(null);

  // owt: run 状態の永続化を開始し、ディスク上の過去 run を一覧へハイドレートする。
  // どちらも内部で二重実行を防ぐため、マウント時 1 回でよい。
  useEffect(() => {
    startRunSnapshotWriter();
    void hydratePastRunsFromDisk();
  }, []);

  // 完了済み run の debug-log.json を読み込む。構造化プロンプト履歴をUIで確認するため。
  const loadDebugLog = async () => {
    if (!run.activeRunId) return;
    setDebugLoading(true);
    try {
      const content = await storyboard.readDebugLog(run.activeRunId);
      setDebugLogContent(content);
    } catch (err) {
      setDebugLogContent(
        `デバッグログ読み込み失敗: ${String(err)}\n\n` +
          `(まだ run が完了していない場合は、完了後に再度試してください。\n` +
          ` 完了済みの run でも、~/.codex/generated_images/gori-storyboard-{runId}/debug-log.json が存在しない場合は表示できません。)`,
      );
    } finally {
      setDebugLoading(false);
    }
  };

  useEffect(() => {
    if (run.status !== "completed") return;
    if (!run.activeRunId || completedToastRunId.current === run.activeRunId)
      return;
    completedToastRunId.current = run.activeRunId;
    const r = run.projectAddResult;
    if (!r) return; // ラフ run: プロジェクト追加は無いので、この文言のトーストは出さない
    if (r.noProject) {
      pushToast({
        kind: "info",
        text: "連続カット生成が完了しました。プロジェクト未選択のため、採用カットはプロジェクトへ追加されていません。",
        ttlMs: 6000,
      });
    } else if (r.total > 0 && r.added === r.total) {
      pushToast({
        kind: "success",
        text: `連続カット生成が完了しました。採用カット ${r.added} 件をプロジェクトへ追加しました。`,
        ttlMs: 4200,
      });
    } else if (r.total > 0 && r.added < r.total) {
      pushToast({
        kind: "warn",
        text: `連続カット生成が完了しました。採用カット ${r.added} / ${r.total} 件をプロジェクトへ追加しました。`,
        ttlMs: 6000,
      });
    } else {
      pushToast({
        kind: "success",
        text: "連続カット生成が完了しました。",
        ttlMs: 4200,
      });
    }
  }, [run.status, run.activeRunId, run.projectAddResult, pushToast]);

  const cuts = useMemo(() => {
    const items = Array.from(run.cuts.values());
    if (run.params?.sceneConstruction) {
      return run.params.sceneConstruction.cuts.map((sceneCut) => {
        const existing = run.cuts.get(sceneCut.cut_id);
        return existing
          ? { ...existing, description: sceneCut.description }
          : {
              cutId: sceneCut.cut_id,
              description: sceneCut.description,
              status: "pending" as const,
              takes: [],
              selectedTakeId: null,
            };
      });
    }
    return items;
  }, [run.cuts, run.params]);

  const totalCuts = run.totalCuts || run.params?.sceneConstruction?.total_cuts || cuts.length;
  const done = cuts.filter((cut) => cut.status === "confirmed").length;
  const progress = totalCuts > 0 ? Math.round((done / totalCuts) * 100) : 0;

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      {/* S3 (2026-07-28): 方向性チェックのダイアログは撤去 (停止区間が消えたため) */}

      <div className="border-b border-[#242424] bg-[#161616] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            {/*
              S2b (2026-08-04): 開発者語彙 (run ID / manifest) をヘッダーの常時表示から
              撤去し、下部「デバッグログ表示」の展開内へ退避した
              (ui-placement-grammar §6)。run ID は展開内の既存表示で、manifest は
              同展開内の保存状態行で確認できる。
              「レート使用率」はユーザー価値がある実利用情報のため常時表示のまま残す。
            */}
            <h3 className="flex items-center gap-1.5 text-sm font-black text-white">
              <ClapperIcon />
              <span>連続カット生成 - {statusLabel(run.status)}</span>
            </h3>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-bold">
            <span className="rounded border border-[#343434] bg-[#101010] px-2 py-1 text-neutral-300">レート使用率: {Math.round(usedPercent)}%</span>
          </div>
        </div>
      </div>

      <div className="border-b border-[#242424] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-black text-white">進捗: {done}/{totalCuts} カット</span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[#2a2a2a]">
            <div className="h-full bg-pink-500" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-10 text-right text-xs font-black tabular-nums text-neutral-300">{progress}%</span>
        </div>
        {run.lastError && <p className="mt-2 text-[11px] font-bold text-red-200">{run.lastError}</p>}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {run.status === "completed" && <SkillRunActions cuts={cuts} />}
        {cuts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs text-neutral-500">
            実行すると、ここにカット進捗が表示されます。
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {cuts.map((cut) => <StoryboardCutCard key={cut.cutId} cut={cut} />)}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[#242424] bg-[#161616] px-4 py-3">
        <div className="flex gap-2">
          <button type="button" onClick={() => run.setStatus("paused")} className="rounded border border-[#343434] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:text-white">一時停止</button>
          <button type="button" onClick={run.reset} className="rounded border border-red-400/40 px-3 py-1.5 text-xs font-bold text-red-200 hover:bg-red-500/10">中断</button>
        </div>
        <button type="button" onClick={() => setDebugOpen(!debugOpen)} className="rounded border border-[#343434] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:text-white">デバッグログ表示</button>
      </div>

      {debugOpen && (
        <div className="max-h-96 overflow-auto border-t border-[#242424] bg-[#0b0b0b] p-3">
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={loadDebugLog}
              disabled={!run.activeRunId || debugLoading}
              className="flex items-center gap-1.5 rounded border border-[#343434] px-3 py-1 text-[11px] font-bold text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              title="完了済み run の構造化プロンプト履歴を読み込む"
            >
              <ClipboardIcon />
              <span>
                {debugLoading ? "読み込み中..." : "構造化プロンプト履歴を読み込む"}
              </span>
            </button>
            {/*
              S2b (2026-08-04): ヘッダーから退避した開発者語彙の受け皿。
              run ID は既存表示をそのまま使い、manifest の保存状態をここに追加した。
            */}
            <span className="text-[10px] text-neutral-500">
              {run.activeRunId ? `run: ${run.activeRunId}` : "run なし"}
            </span>
            {run.manifestPath && (
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
                manifest 保存済み
              </span>
            )}
          </div>
          {debugLogContent ? (
            <details open className="mb-2 rounded border border-[#242424] bg-[#0f0f0f] p-2">
              <summary className="cursor-pointer text-[11px] font-bold text-pink-300">
                構造化プロンプト履歴 (debug-log.json)
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-neutral-200">
                {debugLogContent}
              </pre>
            </details>
          ) : null}
          <details open className="rounded border border-[#242424] bg-[#0f0f0f] p-2">
            <summary className="cursor-pointer text-[11px] font-bold text-neutral-400">
              入力パラメータ + イベント履歴
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-neutral-300">
              {JSON.stringify({ params: run.params, events: run.debugLog }, null, 2)}
            </pre>
          </details>
          {/*
            STΛCK 指示 (2026-05-15): UI 操作ログ(採用/再生成/スキップ等)も
            デバッグログに表示する。失敗カットとエラーを別枠で強調。
          */}
          <details open className="mt-2 rounded border border-[#242424] bg-[#0f0f0f] p-2">
            <summary className="cursor-pointer text-[11px] font-bold text-amber-300">
              UI 操作ログ (採用/再生成/スキップ/復旧)
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-neutral-300">
              {run.uiDebugLog.length === 0
                ? "(まだ UI 操作なし)"
                : run.uiDebugLog
                    .map(
                      (l) =>
                        `[${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()}: ${l.message}`,
                    )
                    .join("\n")}
            </pre>
          </details>
          {(() => {
            const failedCuts = Array.from(run.cuts.values()).filter(
              (c) => c.status === "failed",
            );
            if (failedCuts.length === 0) return null;
            return (
              <details open className="mt-2 rounded border border-red-500/40 bg-red-500/5 p-2">
                <summary className="cursor-pointer text-[11px] font-bold text-red-200">
                  失敗カット ({failedCuts.length}件)
                </summary>
                <ul className="mt-2 space-y-1 text-[11px] text-red-100">
                  {failedCuts.map((c) => (
                    <li key={c.cutId}>
                      <span className="font-mono">{c.cutId}</span>: {c.error ?? "原因不明"}
                    </li>
                  ))}
                </ul>
              </details>
            );
          })()}
          {run.pastRuns.length > 0 && (
            <details className="mt-2 rounded border border-[#242424] bg-[#0f0f0f] p-2">
              <summary className="cursor-pointer text-[11px] font-bold text-sky-300">
                過去 run ({run.pastRuns.length}件)
              </summary>
              <ul className="mt-2 space-y-1 text-[11px] text-neutral-300">
                {run.pastRuns.map((p) => {
                  // owt: ディスクにスナップショットがある run だけ読み取り専用ビューを
                  // 開ける。無い run (このセッション内で退避されただけ) は従来表示のまま。
                  const openable = hasDiskSnapshot(p.runId);
                  return (
                    <li
                      key={p.runId}
                      className={`rounded bg-[#0b0b0b] p-1.5 ${
                        openable ? "cursor-pointer hover:bg-[#151515]" : ""
                      }`}
                      onClick={
                        openable ? () => setPastRunViewerId(p.runId) : undefined
                      }
                    >
                      <p className="font-mono text-[10px] text-neutral-500">
                        {p.runId}
                      </p>
                      <p>
                        {p.confirmedCuts} / {p.totalCuts} カット採用 · {p.status}
                      </p>
                      <p className="mt-0.5 text-[10px] text-neutral-400">
                        {p.storyDigest}
                      </p>
                      {openable && (
                        <p className="mt-0.5 text-[10px] text-sky-400">
                          クリックで内容を表示（読み取り専用）
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      )}
      {pastRunViewerId && (
        <PastRunViewer
          runId={pastRunViewerId}
          onClose={() => setPastRunViewerId(null)}
        />
      )}
    </section>
  );
}

function statusLabel(status: ReturnType<typeof useStoryboardRun.getState>["status"]): string {
  if (status === "running") return "実行中";
  if (status === "paused") return "一時停止";
  if (status === "completed") return "完了";
  if (status === "failed") return "失敗";
  if (status === "cancelled") return "中止";
  return "待機中";
}

function SkillSettingsPanel() {
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const candidatesPerCut = useSkillMode((s) => s.candidatesPerCut);
  const setCandidatesPerCut = useSkillMode((s) => s.setCandidatesPerCut);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const storyboardParams = usePlanChat((s) => s.storyboardParams);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);
  const scenePromptOverride = useScenePromptOverride((s) => s.value);
  const messages = usePlanChat((s) => s.messages);
  const beginRun = useStoryboardRun((s) => s.beginRun);
  const usedPercent = useAuth((s) => s.rateLimits?.primary?.usedPercent ?? 0);
  const pushToast = useToasts((s) => s.push);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (usedPercent > 90 && candidatesPerCut !== 1) {
      setCandidatesPerCut(1);
      pushToast({ kind: "info", text: "レート使用率が90%を超えたため、直列1案に切り替えました。", ttlMs: 3600 });
    } else if (usedPercent > 80) {
      pushToast({ kind: "info", text: "レート使用率が高めです。", ttlMs: 2800 });
    }
  }, [usedPercent, candidatesPerCut, setCandidatesPerCut, pushToast]);

  useEffect(() => {
    if (!selectedSkillId) setSelectedSkillId("gori-storyboard");
  }, [selectedSkillId, setSelectedSkillId]);

  const latestAssistant = [...messages].reverse().find((msg) => msg.role === "assistant")?.text;
  const storyPrompt = (scenePromptOverride || latestAssistant || "ストーリーカット").replace(/\n?\[STORYBOARD_PARAMS\][\s\S]*$/g, "").trim();
  // キャラ参照画像は任意 (2026-06-08 参照任意化)。無ければテキストのみで本生成する。
  // 必須はシーン構成 (企画の確定) だけ。
  const canRun = selectedSkillId === "gori-storyboard" && Boolean(sceneConstruction);

  const runSkill = async () => {
    if (!storyboardParams || !sceneConstruction) {
      pushToast({ kind: "error", text: "企画タブで動画パラメータとシーン構成を確定してください。", ttlMs: 3600 });
      return;
    }
    setStarting(true);
    const runId = crypto.randomUUID();
    try {
      const params = {
        runId,
        storyPrompt,
        // キャラ参照は任意 (2026-06-08)。未設定なら空文字で渡し、Rust側でテキスト生成にフォールバック。
        characterReferenceImage: storyboardParams.character_reference_path ?? "",
        styleReferenceImage: storyboardParams.style_reference_path,
        // FB#3 (2026-06-06): 複数キャラ/スタイル参照 (後方互換: 単数も維持)。
        characterReferenceImages: storyboardParams.character_reference_paths,
        styleReferenceImages: storyboardParams.style_reference_paths,
        aspectRatio: storyboardParams.aspect_ratio,
        durationSeconds: storyboardParams.duration_seconds,
        tempo: storyboardParams.tempo,
        candidatesPerCut,
        cwd: undefined,
        sceneConstruction,
      };
      beginRun(runId, params);
      await storyboard.run(params);
      pushToast({ kind: "success", text: "gori-storyboard を起動しました。", ttlMs: 2400 });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      const run = useStoryboardRun.getState();
      if (run.activeRunId === runId) {
        useStoryboardRun.setState({
          activeRunId: null,
          status: "failed",
          lastError: message,
        });
      }
      pushToast({ kind: "error", text: `スキル起動に失敗しました: ${message}`, ttlMs: 6000 });
    } finally {
      setStarting(false);
    }
  };

  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <div className="space-y-3 rounded-lg border border-[#343434] bg-[#101010] p-3 text-xs">
      {selectedSkillId === "gori-storyboard" && (
        <>
          {/*
            「現在の構成」サマリー = コンパクト固定表示。
            詳細(全カット一覧)はモーダルで開く。
            STΛCK 指示 (2026-05-15): 縦伸ばし廃止、レイアウト元に戻す。
          */}
          <div className="rounded border border-[#2a2a2a] bg-[#0b0b0b] p-2 text-[11px] text-neutral-300">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-black text-neutral-100">現在の構成</p>
              <button
                type="button"
                onClick={() => setDetailOpen(true)}
                disabled={!storyboardParams && !sceneConstruction}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                詳細を見る
              </button>
            </div>
            <p className="mt-1">
              尺 {storyboardParams?.duration_seconds ?? "—"}秒 /
              {" "}アスペクト {storyboardParams?.aspect_ratio ?? "—"} /
              {" "}カット {sceneConstruction?.total_cuts ?? "—"}
            </p>
            <p className="mt-1">レート使用率: {Math.round(usedPercent)}%</p>
            {usedPercent > 90 && (
              <p className="mt-1 font-bold text-yellow-200">
                90%超過のため直列1案のみ実行します。
              </p>
            )}
          </div>

          {/* 区切り線 + 小見出しで「設定のかたまり」を視覚的に分ける (文字だけの羅列を防ぐ)。 */}
          <div className="space-y-1.5 border-t border-[#242424] pt-3">
            <p className="text-[12px] font-bold text-neutral-200">候補数モード</p>
            <label className="flex items-center gap-2 rounded border border-[#2a2a2a] px-2 py-1.5 text-[11px] text-neutral-400">
              <input
                type="radio"
                checked={candidatesPerCut === 3}
                disabled={usedPercent > 90}
                onChange={() => setCandidatesPerCut(3)}
              />
              <span>並列3案（高品質、レート消費大）</span>
            </label>
            <label className="flex items-center gap-2 rounded border border-[#2a2a2a] px-2 py-1.5 text-[11px] text-neutral-400">
              <input
                type="radio"
                checked={candidatesPerCut === 1}
                onChange={() => setCandidatesPerCut(1)}
              />
              <span>直列1案（標準、レート消費小、再生成2回まで）</span>
            </label>
          </div>

          <div className="space-y-1.5 border-t border-[#242424] pt-3">
            <p className="text-[12px] font-bold text-neutral-200">参照画像</p>
            <ReferenceSummary
              label="キャラ参照画像"
              path={storyboardParams?.character_reference_path}
            />
            <ReferenceSummary
              label="スタイル参照画像"
              path={storyboardParams?.style_reference_path}
            />
          </div>

          <button
            type="button"
            onClick={runSkill}
            disabled={!canRun || starting}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-pink-500 px-3 py-2 text-sm font-black text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {starting ? (
              <span>起動中...</span>
            ) : (
              <>
                <PlayIcon />
                <span>実行</span>
              </>
            )}
          </button>

          {detailOpen && (
            <StoryboardDetailModal
              params={storyboardParams}
              construction={sceneConstruction}
              onClose={() => setDetailOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * 「詳細を見る」モーダル。カット数が多くてもスクロールで全件確認可能。
 */
function StoryboardDetailModal({
  params,
  construction,
  onClose,
}: {
  params: ReturnType<typeof usePlanChat.getState>["storyboardParams"];
  construction: ReturnType<typeof usePlanChat.getState>["sceneConstruction"];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-[#343434] bg-[#1a1a1a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[#2a2a2a] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-white">現在の構成</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              尺 {params?.duration_seconds ?? "—"}秒 /
              {" "}アスペクト {params?.aspect_ratio ?? "—"} /
              {" "}テンポ {params?.tempo ?? "—"} /
              {" "}カット {construction?.total_cuts ?? "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-xs font-bold text-neutral-400 hover:border-pink-400 hover:text-white"
          >
            閉じる
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">
          <StoryboardConfigDetail params={params} construction={construction} />
        </div>
      </div>
    </div>
  );
}

/**
 * 「現在の構成」エリアに表示する詳細。
 * storyboardParams と sceneConstruction の中身を読みやすく整形して全カット見せる。
 */
function StoryboardConfigDetail({
  params,
  construction,
}: {
  params: ReturnType<typeof usePlanChat.getState>["storyboardParams"];
  construction: ReturnType<typeof usePlanChat.getState>["sceneConstruction"];
}) {
  if (!params && !construction) {
    return (
      <p className="text-neutral-500">
        企画タブでストーリーを確定すると、決まった内容がここに表示されます。
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {(params as Record<string, unknown> | null)?.story_prompt ? (
        <section>
          <p className="text-[10px] font-black uppercase tracking-wider text-pink-300">
            ストーリー
          </p>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-neutral-200">
            {String((params as Record<string, unknown>).story_prompt)}
          </p>
        </section>
      ) : null}
      {params && (params as Record<string, unknown>).intent ? (
        <section>
          <p className="text-[10px] font-black uppercase tracking-wider text-pink-300">
            ねらい (伝えたいこと)
          </p>
          <p className="mt-1 leading-relaxed text-neutral-200">
            {String((params as Record<string, unknown>).intent)}
          </p>
        </section>
      ) : null}
      {construction?.cuts && construction.cuts.length > 0 && (
        <section>
          <p className="text-[10px] font-black uppercase tracking-wider text-pink-300">
            カット構成 ({construction.cuts.length} カット)
          </p>
          <ol className="mt-1 space-y-1.5">
            {construction.cuts.map((cut, idx) => (
              <li
                key={cut.cut_id || idx}
                className="rounded border border-[#2a2a2a] bg-[#101010] px-2 py-1.5"
              >
                <p className="text-[10px] font-bold text-neutral-400">
                  #{idx + 1} · {cut.duration_seconds ?? "?"}秒
                </p>
                <p className="mt-0.5 leading-relaxed text-neutral-200">
                  {cut.description ?? "—"}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function ReferenceSummary({ label, path }: { label: string; path?: string }) {
  return (
    <div className="rounded border border-[#2a2a2a] bg-[#0b0b0b] p-2">
      <p className="text-[11px] font-bold text-neutral-300">{label}</p>
      <p className="mt-1 truncate font-mono text-[10px] tabular-nums text-neutral-500">
        {path || "未設定"}
      </p>
    </div>
  );
}
