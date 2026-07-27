import { create } from "zustand";

import { DEFAULT_SELECTED_CUT_IDS } from "./catalog";
import type { CutState, MultiAngleEvent } from "../multiangle/types";
import { syncCutRunStatus, useGenerationStatus } from "../store/generationStatus";

/**
 * EC納品セットの run 状態ストア。
 *
 * 生成は既存の Rust コマンド（multiangle_run / multiangle_regenerate_cut）を再利用し、
 * イベントも同じ EVENT_MULTIANGLE（codex://multiangle）で受ける。マルチアングルと
 * 状態構造は同型（cutId → CutState）だが、設定項目（商品説明・シーン指定）が異なるため
 * ストアは分離する。マルチアングルの store の「skeleton を invoke 前に建てる」バグ対策も
 * そのまま踏襲する（2026-06-06 の 0/N 固着修正）。
 */

type ProductSetRunStatus = "idle" | "running" | "completed" | "failed";

type ProductSetRunState = {
  // ===== run 状態 =====
  status: ProductSetRunStatus;
  runId: string | null;
  cuts: Record<string, CutState>;
  cutOrder: string[];
  cutStartedAt: Record<string, number>;

  // ===== 設定（run を跨いで保持） =====
  productImagePath: string | null;
  productDescription: string;
  /** ライフスタイルシーン指定（例:「木目のテーブル」「屋外」）。任意。 */
  sceneHint: string;
  /**
   * 商品の品番 (SKU)。書き出しファイル名の接頭辞に使う。任意。
   *
   * 2026-07-27: EC実務の診断で「日本語ファイル名はモールに弾かれる」「SKU が
   * 名前に無いと数十〜数百点を捌けない」が判明したため追加。生成内容には影響せず、
   * 書き出し時の命名だけに使う。
   */
  sku: string;
  aspectRatio: string;
  /** 生成対象として選択中の納品カット cutId 群。 */
  selectedCutIds: string[];
  /** 出力後にローカル一括保存対象として選択中の完成カット cutId 群。 */
  selectedOutputCutIds: string[];

  // ===== 設定アクション =====
  setProductImage: (path: string | null) => void;
  setProductDescription: (text: string) => void;
  setSceneHint: (text: string) => void;
  setSku: (sku: string) => void;
  setAspectRatio: (ratio: string) => void;
  toggleCut: (cutId: string) => void;
  clearSelection: () => void;
  selectAllCuts: () => void;

  // ===== 出力カット選択アクション（ローカル保存用） =====
  toggleOutputCut: (cutId: string) => void;
  selectAllCompletedOutputs: () => void;
  clearOutputSelection: () => void;

  // ===== run アクション =====
  beginRun: (runId: string, selectedCuts: { cutId: string; label: string }[]) => void;
  applyEvent: (e: MultiAngleEvent) => void;
  reset: () => void;
};

const runEmptyState = {
  status: "idle" as ProductSetRunStatus,
  runId: null as string | null,
  cuts: {} as Record<string, CutState>,
  cutOrder: [] as string[],
  cutStartedAt: {} as Record<string, number>,
};

export const useProductSetRun = create<ProductSetRunState>((set) => ({
  ...runEmptyState,

  productImagePath: null,
  productDescription: "",
  sceneHint: "",
  sku: "",
  aspectRatio: "1:1",
  selectedCutIds: [...DEFAULT_SELECTED_CUT_IDS],
  selectedOutputCutIds: [],

  setProductImage: (path) => set({ productImagePath: path }),
  setProductDescription: (text) => set({ productDescription: text }),
  setSceneHint: (text) => set({ sceneHint: text }),
  setSku: (sku) => set({ sku }),
  setAspectRatio: (ratio) => set({ aspectRatio: ratio }),

  toggleCut: (cutId) =>
    set((s) => {
      const exists = s.selectedCutIds.includes(cutId);
      return {
        selectedCutIds: exists
          ? s.selectedCutIds.filter((id) => id !== cutId)
          : [...s.selectedCutIds, cutId],
      };
    }),

  clearSelection: () => set({ selectedCutIds: [] }),

  selectAllCuts: () => set({ selectedCutIds: [...DEFAULT_SELECTED_CUT_IDS] }),

  toggleOutputCut: (cutId) =>
    set((s) => {
      const exists = s.selectedOutputCutIds.includes(cutId);
      return {
        selectedOutputCutIds: exists
          ? s.selectedOutputCutIds.filter((id) => id !== cutId)
          : [...s.selectedOutputCutIds, cutId],
      };
    }),

  selectAllCompletedOutputs: () =>
    set((s) => ({
      selectedOutputCutIds: s.cutOrder.filter((id) => {
        const c = s.cuts[id];
        return c?.status === "completed" && Boolean(c.imagePath);
      }),
    })),

  clearOutputSelection: () => set({ selectedOutputCutIds: [] }),

  beginRun: (runId, selectedCuts) =>
    set((s) => {
      const cuts: Record<string, CutState> = {};
      const cutOrder: string[] = [];
      const cutStartedAt: Record<string, number> = {};
      for (const { cutId, label } of selectedCuts) {
        // イベントで先行したカット（running/completed/failed）は状態を維持する。
        const prev = s.cuts[cutId];
        cuts[cutId] =
          prev && prev.status !== "pending"
            ? { ...prev, label }
            : { cutId, label, status: "pending" };
        if (prev?.status === "running" && s.cutStartedAt[cutId]) {
          cutStartedAt[cutId] = s.cutStartedAt[cutId];
        }
        cutOrder.push(cutId);
      }
      // 押した直後から右上に表示する
      useGenerationStatus.getState().start({
        id: runId,
        kind: "productSet",
        total: cutOrder.length || undefined,
      });
      return {
        status: "running" as const,
        runId,
        cuts,
        cutOrder,
        cutStartedAt,
        selectedOutputCutIds: [],
      };
    }),

  applyEvent: (e) =>
    set((s) => {
      if (!s.runId || e.runId !== s.runId) return s;

      // 右上の生成状況パネルへ橋渡し (2026-07-25 STΛCK指示)
      syncCutRunStatus("productSet", s.cuts, s.cutOrder.length, e);

      switch (e.kind) {
        case "started":
          return { status: "running" as const };

        case "cutStarted": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: e.label,
            status: "pending" as const,
          };
          return {
            cuts: {
              ...s.cuts,
              [e.cutId]: { ...prev, label: e.label, status: "running" as const },
            },
            cutStartedAt: { ...s.cutStartedAt, [e.cutId]: Date.now() },
          };
        }

        case "cutCompleted": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: e.label,
            status: "pending" as const,
          };
          return {
            cuts: {
              ...s.cuts,
              [e.cutId]: {
                ...prev,
                label: e.label,
                status: "completed" as const,
                imagePath: e.imagePath,
              },
            },
          };
        }

        case "cutFailed": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: e.cutId,
            status: "pending" as const,
          };
          return {
            cuts: {
              ...s.cuts,
              [e.cutId]: { ...prev, status: "failed" as const, reason: e.reason },
            },
          };
        }

        case "completed":
          return { status: "completed" as const };

        default:
          return s;
      }
    }),

  reset: () => set({ ...runEmptyState, selectedOutputCutIds: [] }),
}));
