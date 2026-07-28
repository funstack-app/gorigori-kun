import { create } from "zustand";
import { useErrorLog } from "./errorLog";
import { useWorkspace } from "./workspace";

export type ToastKind = "info" | "success" | "warn" | "error";

/** サイドバーのエラーログに出す発生元ラベル (制作タブ名)。 */
const TAB_LABELS: Record<string, string> = {
  plan: "企画",
  generate: "画像生成",
  video: "動画生成",
  edit: "編集",
};

/**
 * エラーの発生元を推定する。
 * workspace のアクティブタブが取れなければ "app"。
 * ここで例外を投げるとトースト自体が出なくなるので必ず握る。
 */
function currentSource(): string {
  try {
    return TAB_LABELS[useWorkspace.getState().activeTab] ?? "app";
  } catch {
    return "app";
  }
}

export type Toast = {
  id: string;
  kind: ToastKind;
  text: string;
  /** Auto-dismiss delay in ms. 0 / undefined = sticky. */
  ttlMs?: number;
};

type ToastsState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export const useToasts = create<ToastsState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = t.id ?? crypto.randomUUID();
    // error は手動で閉じるまで残す (sticky)。配布版で原因調査するときに
    // 一瞬で消えるとユーザーが文言を読めず、デバッグ手がかりが取れない。
    const defaultTtl = t.kind === "error" ? 0 : 5000;
    const item: Toast = { ...t, id, ttlMs: t.ttlMs ?? defaultTtl };
    // エラーはトーストが消えても残るよう、サイドバーのエラーログへ同時に積む。
    // ここ1点で UI 上の全エラー表示が集約される (呼び出し側の変更は不要)。
    if (item.kind === "error") {
      try {
        useErrorLog.getState().log({ source: currentSource(), message: item.text });
      } catch (err) {
        // ログ記録の失敗でトースト表示を巻き込まない。
        console.warn("[toasts] エラーログへの記録に失敗しました", err);
      }
    }
    set((s) => ({ toasts: [...s.toasts, item] }));
    if (item.ttlMs && item.ttlMs > 0) {
      setTimeout(() => get().dismiss(id), item.ttlMs);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
