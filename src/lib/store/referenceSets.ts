import { create } from "zustand";
import type { Reference } from "./composer";

/**
 * リファレンスセット = 参照画像 + そのときのプロンプト を 1 まとまりで保存する箱。
 *
 * F-#6 修正 (2026-05-19): Ta4low さん要望。「同じテイストで何度も生成したい」時に
 * 参照画像 + プロンプトを手動でセットし直すのが面倒。セットとして保存して、
 * 後でワンクリックで呼び出せるようにする。
 *
 * usePresets (= プロンプトのみ) との違い:
 * - リファレンス画像 (path + role) も同時に保存
 * - 任意のラベル/メモ付き
 * - localStorage に永続化 (presets と同じ MVP 方針)
 */

export type ReferenceSet = {
  id: string;
  name: string;
  description?: string;
  /** 保存した参照画像。path / role / maskPath をそのまま保持。 */
  references: Reference[];
  /** 保存時のプロンプト本文。空でもよい。 */
  prompt: string;
  createdAt: number;
  updatedAt: number;
};

const LS_KEY = "referenceSets.sets";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPersisted(): ReferenceSet[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReferenceSet[]) : [];
  } catch {
    return [];
  }
}

function persist(value: ReferenceSet[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

type State = {
  sets: ReferenceSet[];

  /** 現在のリファレンスとプロンプトをセットとして登録する */
  addSet: (data: Omit<ReferenceSet, "id" | "createdAt" | "updatedAt">) => ReferenceSet;
  /** 名前/説明/プロンプト等を編集する */
  updateSet: (id: string, updates: Partial<Omit<ReferenceSet, "id" | "createdAt">>) => void;
  removeSet: (id: string) => void;
};

export const useReferenceSets = create<State>((set, get) => ({
  sets: readPersisted(),

  addSet: (data) => {
    const now = Date.now();
    const next: ReferenceSet = {
      id: generateId(),
      name: data.name.trim() || "無題のセット",
      description: data.description?.trim() || undefined,
      references: data.references,
      prompt: data.prompt,
      createdAt: now,
      updatedAt: now,
    };
    const all = [next, ...get().sets];
    persist(all);
    set({ sets: all });
    return next;
  },

  updateSet: (id, updates) => {
    const all = get().sets.map((s) =>
      s.id === id
        ? {
            ...s,
            ...updates,
            id: s.id,
            createdAt: s.createdAt,
            updatedAt: Date.now(),
          }
        : s,
    );
    persist(all);
    set({ sets: all });
  },

  removeSet: (id) => {
    const all = get().sets.filter((s) => s.id !== id);
    persist(all);
    set({ sets: all });
  },
}));
