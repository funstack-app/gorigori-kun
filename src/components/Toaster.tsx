import { useToasts, type ToastKind } from "../lib/store/toasts";

const kindStyles: Record<ToastKind, { ring: string; bar: string; icon: string }> = {
  info: { ring: "ring-sky-700/60", bar: "bg-sky-500", icon: "ℹ︎" },
  success: { ring: "ring-emerald-700/60", bar: "bg-emerald-500", icon: "✓" },
  warn: { ring: "ring-amber-700/60", bar: "bg-amber-500", icon: "⚠︎" },
  error: { ring: "ring-rose-700/60", bar: "bg-rose-500", icon: "✕" },
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-40 flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const s = kindStyles[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg bg-neutral-900/90 p-3 text-sm text-neutral-100 shadow-lg ring-1 ${s.ring} backdrop-blur`}
          >
            <span className={`mt-0.5 inline-block h-4 w-4 flex-shrink-0 rounded-full text-center text-xs leading-4 text-neutral-900 ${s.bar}`}>
              {s.icon}
            </span>
            <span className="flex-1 whitespace-pre-wrap text-xs leading-relaxed">{t.text}</span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(t.text);
                } catch {
                  // navigator.clipboard が利用できない環境は無視
                }
              }}
              className="text-neutral-500 hover:text-neutral-200"
              aria-label="コピー"
              title="コピー"
            >
              ⧉
            </button>
            <button
              onClick={() => dismiss(t.id)}
              className="text-neutral-500 hover:text-neutral-200"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
