import { useMemo, useState } from "react";

import { groupLayersByGenre, type LayerGenre } from "../../lib/edit/genre";
import { useEditor, type EditorLayerMeta } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";
import {
  getObjectById,
  groupSelectionState,
  layerMetasFromCanvas,
  personGroupSummary,
  removeObjectById,
  reorderObject,
  selectLayersByIds,
  selectObjectById,
  setLayersVisibleByIds,
  setLocked,
  setObjectName,
  setObjectVisible,
} from "./editor/layerHelpers";

export function EditorLayerList() {
  const canvas = useEditor((state) => state.canvas);
  const selectedLayerId = useEditor((state) => state.selectedLayerId);
  const revision = useEditor((state) => state.revision);
  const setSelectedLayerId = useEditor((state) => state.setSelectedLayerId);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // 「人」グループを畳んで1つのまとまり (人=1レイヤー) として見せるか。既定は畳む。
  const [personCollapsed, setPersonCollapsed] = useState(true);

  const { groupSelection, ungroupSelection } = useEditorActions();

  const layers = useMemo(() => layerMetasFromCanvas(canvas), [canvas, revision]);
  // グループ操作バーの出し分け。選択が変わる (= revision が動く) たびに再計算する。
  const groupState = useMemo(() => groupSelectionState(canvas), [canvas, revision]);
  // 大ジャンル (人/テキスト/背景/小物) の見出し付きツリー。空ジャンルの見出しは出さない。
  const groups = useMemo(() => groupLayersByGenre(layers), [layers]);
  // 人=1レイヤー (gap-audit G2): 人ジャンルのパーツ群をまとめ操作するためのサマリ。
  const personGroup = useMemo(() => personGroupSummary(layers), [layers]);
  // 並び替え (dropOn) は「一覧全体の上からの位置」基準なので、ツリー表示でも
  // 各レイヤーのフラット index を引けるようにしておく。
  const flatIndexById = useMemo(
    () => new Map(layers.map((layer, index) => [layer.id, index])),
    [layers],
  );

  const select = (id: string) => {
    setSelectedLayerId(id);
    selectObjectById(canvas, id);
    bumpRevision();
  };

  const toggleVisible = (id: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setObjectVisible(object, object.visible === false);
    (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };

  const toggleLock = (id: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setLocked(object, object.get?.("locked") !== true);
    (canvas as { requestRenderAll?: () => void } | null)?.requestRenderAll?.();
    bumpRevision();
    pushHistory();
  };

  const rename = (id: string, name: string) => {
    const object = getObjectById(canvas, id);
    if (!object) return;
    setObjectName(object, name);
    bumpRevision();
    // 履歴はキーストロークごとではなく確定時 (onBlur) に積む (連打で埋めない)。
  };

  const remove = (id: string) => {
    removeObjectById(canvas, id);
    if (selectedLayerId === id) setSelectedLayerId(null);
    bumpRevision();
    pushHistory();
  };

  const dropOn = (targetIndex: number) => {
    if (!draggingId) return;
    reorderObject(canvas, draggingId, targetIndex);
    setDraggingId(null);
    bumpRevision();
    pushHistory();
  };

  // ── 人=1レイヤー: まとめ操作 (gap-audit G2) ──────────────────
  // 人ジャンルのパーツ群を1つのまとまりとして選択・表示切替する。

  const selectPersonGroup = async () => {
    if (!personGroup) return;
    const selected = await selectLayersByIds(canvas, personGroup.ids);
    // ActiveSelection は単一 id と対応しないので、選択ハイライトは代表 (先頭) に寄せる。
    setSelectedLayerId(selected > 0 ? personGroup.ids[0] : null);
    bumpRevision();
  };

  const togglePersonVisible = () => {
    if (!personGroup) return;
    // mixed / all は「全非表示」へ、none は「全表示」へ揃える (安全側に方向固定)。
    const nextVisible = personGroup.visibleState === "none";
    setLayersVisibleByIds(canvas, personGroup.ids, nextVisible);
    bumpRevision();
    pushHistory();
  };

  return (
    <section className="min-h-0 flex-1 overflow-hidden border-b border-[#2a2a2a]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-2">
        <h3 className="text-xs font-black text-white">レイヤー</h3>
        <span className="rounded border border-[#343434] bg-[#101010] px-2 py-0.5 text-[10px] font-bold text-neutral-500">
          {layers.length}
        </span>
      </div>
      {/* グループ操作バー (Canva「グループ化/解除」相当・差4)。選択状態で出し分ける。 */}
      {groupState.kind !== "none" && (
        <div className="border-b border-[#2a2a2a] px-3 py-1.5">
          {groupState.kind === "multi" ? (
            <button
              type="button"
              onClick={() => void groupSelection()}
              className="w-full rounded border border-[#3a3a3a] bg-[#161616] px-2 py-1 text-[11px] font-bold text-neutral-200 hover:border-[#4a4a4a] hover:text-white"
              title={`選択中の${groupState.count}レイヤーを1つにまとめる`}
            >
              🔗 {groupState.count}個をグループ化
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void ungroupSelection(groupState.id)}
              className="w-full rounded border border-[#3a3a3a] bg-[#161616] px-2 py-1 text-[11px] font-bold text-neutral-200 hover:border-[#4a4a4a] hover:text-white"
              title="グループを解除して個別レイヤーに戻す"
            >
              ⛓️‍💥 グループを解除
            </button>
          )}
        </div>
      )}
      <div className="h-full overflow-y-auto p-2 pb-12">
        {layers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-8 text-center text-xs font-bold text-neutral-600">
            レイヤーなし
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => {
              // 「人」ジャンルだけは、パーツ群を1つのまとまり (人=1レイヤー) として
              // 畳める見出しにする。畳むと1行サマリ、開くと個別パーツ (gap-audit G2)。
              const isPerson = group.genre === "person" && personGroup !== null;
              const collapsed = isPerson && personCollapsed;
              return (
                <div key={group.genre}>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    {isPerson ? (
                      <button
                        type="button"
                        onClick={() => setPersonCollapsed((value) => !value)}
                        className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300"
                        title={collapsed ? "人パーツを展開" : "人を1つにまとめる"}
                        aria-expanded={!collapsed}
                      >
                        <ChevronIcon open={!collapsed} />
                        <GenreDot genre={group.genre} />
                      </button>
                    ) : (
                      <GenreDot genre={group.genre} />
                    )}
                    <span className="text-[10px] font-black tracking-wider text-neutral-400">
                      {group.label}
                    </span>
                    <span className="text-[10px] font-bold text-neutral-600">
                      {group.layers.length}
                    </span>
                    {isPerson && personGroup && (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void selectPersonGroup()}
                          className="rounded border border-[#343434] bg-[#101010] px-1.5 py-0.5 text-[9px] font-black text-neutral-300 hover:border-pink-400/70 hover:text-white"
                          title="人ぜんぶをまとめて選択 (一緒に動かせる)"
                        >
                          まとめて選択
                        </button>
                        <button
                          type="button"
                          onClick={togglePersonVisible}
                          className="flex h-5 w-5 items-center justify-center text-neutral-400 hover:text-white"
                          title={
                            personGroup.visibleState === "none"
                              ? "人をまとめて表示"
                              : "人をまとめて非表示"
                          }
                        >
                          {personGroup.visibleState === "none" ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </div>
                    )}
                  </div>
                  {collapsed && personGroup ? (
                    <button
                      type="button"
                      onClick={() => void selectPersonGroup()}
                      className="grid w-full cursor-pointer grid-cols-[42px_minmax(0,1fr)_16px] items-center gap-2 rounded-lg border border-[#303030] bg-[#101010] p-2 text-left transition hover:border-pink-400/70"
                      title="クリックで人ぜんぶを選択。左の三角で個別パーツを展開"
                    >
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-[#343434] bg-[#181818] text-neutral-500">
                        {group.layers[0]?.thumbnail ? (
                          <img
                            src={group.layers[0].thumbnail ?? undefined}
                            alt=""
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <LayerImageIcon />
                        )}
                      </div>
                      <span className="min-w-0 truncate text-xs font-bold text-neutral-100">
                        {personGroup.collapsedLabel}
                      </span>
                      <ChevronIcon open={false} />
                    </button>
                  ) : (
                    <div className="space-y-2">
                      {group.layers.map((layer) => (
                        <LayerRow
                          key={layer.id}
                          layer={layer}
                          selected={selectedLayerId === layer.id}
                          onDragStart={() => setDraggingId(layer.id)}
                          onDrop={() => dropOn(flatIndexById.get(layer.id) ?? 0)}
                          onSelect={() => select(layer.id)}
                          onToggleVisible={() => toggleVisible(layer.id)}
                          onToggleLock={() => toggleLock(layer.id)}
                          onRename={(name) => rename(layer.id, name)}
                          onRenameCommit={() => pushHistory()}
                          onRemove={() => remove(layer.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** レイヤー1行 (表示切替 / サムネ / リネーム / ロック / 削除)。ジャンルを問わず共通。 */
function LayerRow({
  layer,
  selected,
  onDragStart,
  onDrop,
  onSelect,
  onToggleVisible,
  onToggleLock,
  onRename,
  onRenameCommit,
  onRemove,
}: {
  layer: EditorLayerMeta;
  selected: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onSelect: () => void;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  onRename: (name: string) => void;
  onRenameCommit: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onClick={onSelect}
      className={`group grid cursor-pointer grid-cols-[26px_42px_minmax(0,1fr)_26px_26px] items-center gap-2 rounded-lg border bg-[#101010] p-2 transition ${
        selected
          ? "border-pink-500 shadow-[0_0_0_1px_rgba(236,72,153,.35)]"
          : "border-[#303030] hover:border-pink-400/70"
      }`}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleVisible();
        }}
        className="flex h-5 w-5 items-center justify-center text-neutral-400 hover:text-white"
        title={layer.visible ? "非表示" : "表示"}
      >
        {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-[#343434] bg-[#181818] text-neutral-500">
        {layer.thumbnail ? (
          <img src={layer.thumbnail} alt="" className="h-full w-full object-contain" />
        ) : layer.kind === "text" ? (
          <LayerTextIcon />
        ) : (
          <LayerImageIcon />
        )}
      </div>
      <input
        value={layer.name}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onRename(event.target.value)}
        onBlur={onRenameCommit}
        className="min-w-0 rounded border border-transparent bg-transparent px-1 py-1 text-xs font-bold text-neutral-100 outline-none focus:border-pink-400 focus:bg-[#181818]"
      />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleLock();
        }}
        className="flex h-5 w-5 items-center justify-center text-neutral-400 opacity-70 hover:text-white hover:opacity-100"
        title={layer.locked ? "ロック解除" : "ロック"}
      >
        {layer.locked ? <LockIcon /> : <LockOpenIcon />}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="flex h-5 w-5 items-center justify-center text-neutral-400 opacity-60 hover:text-red-300 hover:opacity-100"
        title="削除"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** 折りたたみ三角 (open=展開中で下向き, 閉=右向き)。 */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      {...LAYER_SVG}
      width={12}
      height={12}
      className={`transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** ジャンル見出しの色ドット (人=ピンク / テキスト=シアン / 小物=アンバー / 背景=グレー)。 */
function GenreDot({ genre }: { genre: LayerGenre }) {
  const color =
    genre === "person"
      ? "bg-pink-400"
      : genre === "text"
        ? "bg-cyan-400"
        : genre === "prop"
          ? "bg-amber-400"
          : "bg-neutral-500";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />;
}

/* --- フラットアイコン (絵文字廃止) --- */

const LAYER_SVG = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function EyeIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 004.2 4.2" />
      <path d="M9.3 5.3A9.5 9.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 3.9M6 6.6A17 17 0 002 12s3.5 7 10 7a9.3 9.3 0 003-.5" />
    </svg>
  );
}

function LayerTextIcon() {
  return (
    <svg {...LAYER_SVG} width={18} height={18} aria-hidden>
      <path d="M5 6h14M5 6V4.5h14V6M12 6v13M9 19h6" />
    </svg>
  );
}

function LayerImageIcon() {
  return (
    <svg {...LAYER_SVG} width={18} height={18} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="M3 16l5-4 4 3 3-2 6 5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...LAYER_SVG} aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...LAYER_SVG} width={14} height={14} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  );
}

function LockOpenIcon() {
  return (
    <svg {...LAYER_SVG} width={14} height={14} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 017.5-2" />
    </svg>
  );
}
