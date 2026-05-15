import { useWorkspace, type WorkspaceTab } from "../lib/store/workspace";

type Tab = { id: WorkspaceTab; label: string; beta?: boolean; disabled?: boolean };

const TABS: Tab[] = [
  { id: "plan", label: "企画" },
  { id: "generate", label: "生成" },
  // 編集タブは β 版 + 一部機能が Mac 専用 (背景除去 Vision API / Python segmentation)
  // のため、配布前は触れない状態にする。
  // STΛCK 指示 (2026-05-15): クリック不可、押せないように。
  { id: "edit", label: "編集", beta: true, disabled: true },
];

export function WorkspaceTabs() {
  const activeTab = useWorkspace((s) => s.activeTab);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);

  return (
    <div className="grid w-full grid-cols-3 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-1 sm:w-[320px]">
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
            title={
              isDisabled
                ? "β版機能 (近日公開予定、現在は利用できません)"
                : tab.beta
                  ? "β版機能 (開発中、動作が不安定な場合があります)"
                  : undefined
            }
            className={`relative h-9 rounded-md text-sm font-black transition ${
              isDisabled
                ? "cursor-not-allowed text-neutral-700"
                : isActive
                  ? "bg-white text-black"
                  : "text-neutral-500 hover:bg-[#1f1f1f] hover:text-white"
            }`}
          >
            <span className="align-middle">{tab.label}</span>
            {tab.beta && (
              <span
                className={`ml-1.5 inline-block rounded px-1 py-0.5 text-[9px] font-black tracking-wider align-middle ${
                  isDisabled
                    ? "bg-neutral-700 text-neutral-500"
                    : isActive
                      ? "bg-pink-500 text-white"
                      : "bg-pink-500/20 text-pink-300"
                }`}
              >
                β
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
