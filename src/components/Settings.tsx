export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#343434] bg-[#1e1e1e] text-base font-bold text-neutral-300 shadow-sm hover:border-neutral-500 hover:text-white"
      aria-label="設定"
      title="設定"
    >
      ⚙
    </button>
  );
}
