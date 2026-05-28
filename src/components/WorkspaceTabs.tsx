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

export function WorkspaceTabs() {
  const activeTab = useWorkspace((s) => s.activeTab);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);

  return (
    <div className="grid w-full grid-cols-4 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-1 sm:w-[420px]">
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
                  ? "bg-white text-black"
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
