import { useEffect, useRef } from "react";
import { useWorkspace, type WorkspaceTab } from "../lib/store/workspace";

type Tab = {
  id: WorkspaceTab;
  label: string;
  /** 「近日公開」ラベル + 触れない状態 */
  comingSoon?: boolean;
  disabled?: boolean;
};

const TABS: Tab[] = [
  { id: "plan", label: "企画" },
  { id: "generate", label: "画像生成" },
  { id: "video", label: "動画生成" },
  // 編集タブは現在クローズ。STΛCK 指示 (2026-05-17): β ではなく
  // 「近日公開」表示にしてワクワク感を演出。クリック不可。
  { id: "edit", label: "編集", comingSoon: true, disabled: true },
];

/** 触れる (=disabled でない) タブだけを順序つきで取り出す。 */
const NAVIGABLE_TABS: WorkspaceTab[] = TABS.filter((t) => !t.disabled).map((t) => t.id);

export function WorkspaceTabs() {
  const activeTab = useWorkspace((s) => s.activeTab);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);

  /**
   * FB#15: タブのスワイプ / トラックパッドジェスチャ移動 (最小実装)。
   *
   * - 横方向のホイール / 2 本指トラックパッドスワイプ (deltaX) で
   *   企画 ↔ 画像生成 ↔ 動画生成 を行き来する。
   * - 縦スクロールを誤検知しないよう、横成分が縦成分を明確に上回る時だけ反応。
   * - 連続したスワイプで一気に飛ばないよう、発火後はクールダウンを置く。
   * - disabled タブ (編集) はスキップ。
   *
   * window 全体に listen するとモーダルや左右パネルのスクロールと干渉するため、
   * 反応対象は「制作ワークスペース本体」に限定する。GenerationWorkspace の
   * 直近の親 (`<section>` 相当) を closest で辿って、その中での横スワイプだけ拾う。
   */
  const cooldownRef = useRef(0);
  const stripRef = useRef<HTMLDivElement | null>(null);

  /**
   * FB#15: スワイプ反応領域 (制作ワークスペース本体) に目印を付ける。
   * GenerationWorkspace 側は別担当のため編集せず、ここから DOM を辿って
   * 最も近い <section>（ワークスペースのルート）に data 属性を立てる。
   * 見つからなければタブ列自身を対象にフォールバックする。
   */
  useEffect(() => {
    const root =
      stripRef.current?.closest("section") ?? stripRef.current?.parentElement ?? null;
    if (root) {
      root.setAttribute("data-workspace-swipe", "");
      return () => root.removeAttribute("data-workspace-swipe");
    }
    return undefined;
  }, []);

  useEffect(() => {
    const cycle = (dir: 1 | -1) => {
      const idx = NAVIGABLE_TABS.indexOf(useWorkspace.getState().activeTab);
      // 現在が disabled タブ等で見つからない場合は先頭にフォールバック。
      const base = idx < 0 ? 0 : idx;
      const nextIdx = base + dir;
      if (nextIdx < 0 || nextIdx >= NAVIGABLE_TABS.length) return; // 端ではループしない
      setActiveTab(NAVIGABLE_TABS[nextIdx]);
    };

    const onWheel = (event: WheelEvent) => {
      // 制作ワークスペース内のジェスチャだけを対象にする。
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.("[data-workspace-swipe]")) return;
      const { deltaX, deltaY } = event;
      // 横移動が縦移動より明確に大きい時だけタブ移動とみなす。
      if (Math.abs(deltaX) < 30 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;
      const now = Date.now();
      if (now < cooldownRef.current) return;
      cooldownRef.current = now + 450;
      cycle(deltaX > 0 ? 1 : -1);
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [setActiveTab]);

  return (
    <div
      ref={stripRef}
      className="grid w-full grid-cols-4 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-1 sm:w-[420px]"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const isDisabled = tab.disabled;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              if (isDisabled) return;
              setActiveTab(tab.id);
            }}
            disabled={isDisabled}
            aria-pressed={isActive}
            aria-disabled={isDisabled}
            title={isDisabled ? "近日公開予定" : undefined}
            className={`relative h-9 rounded-md text-sm font-black transition ${
              isDisabled
                ? "cursor-not-allowed text-neutral-700"
                : isActive
                  ? "bg-pink-500 text-white"
                  : "text-neutral-500 hover:bg-[#1f1f1f] hover:text-white"
            }`}
          >
            <span className="align-middle">{tab.label}</span>
            {tab.comingSoon && (
              <span
                className={`ml-1.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide align-middle ${
                  isDisabled
                    ? "bg-neutral-800 text-neutral-500"
                    : "bg-purple-500/20 text-purple-200"
                }`}
              >
                近日公開
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
