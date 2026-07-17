import { create } from "zustand";

import { MAX_CUTS } from "../multiangle/angles";
import type { CutState, MultiAngleEvent } from "../multiangle/types";

type MultiAngleRunStatus = "idle" | "running" | "completed" | "failed";

type MultiAngleRunState = {
  // ===== run 状態 =====
  status: MultiAngleRunStatus;
  runId: string | null;
  /** cutId → 実行状態。storyboard 同様 immutable に clone して更新する。 */
  cuts: Record<string, CutState>;
  /** 表示順 (beginRun で選択順に確定)。 */
  cutOrder: string[];
  /** cutId → 実際に生成を開始した時刻 (epoch ms)。 */
  cutStartedAt: Record<string, number>;

  // ===== 設定 (run を跨いで保持) =====
  characterImagePath: string | null;
  environmentDescription: string;
  aspectRatio: string;
  /** ユーザーが選択中の構図 cutId 群 (最大 MAX_CUTS)。生成前の「どのアングルを出すか」。 */
  selectedCutIds: string[];
  /**
   * 出力後に選択中の完成カット cutId 群。生成前の selectedCutIds とは別物で、
   * 「出てきたカットのうちどれをローカル保存するか」を表す。ライブラリの
   * librarySelection と同じ役割をマルチアングル専用に持つ。
   */
  selectedOutputCutIds: string[];

  // ===== 設定アクション =====
  setCharacterImage: (path: string | null) => void;
  setEnvironment: (text: string) => void;
  setAspectRatio: (ratio: string) => void;
  /** cutId を選択トグル。MAX_CUTS 超過の追加は無視する。 */
  toggleCut: (cutId: string) => void;
  /** プリセット適用。MAX_CUTS でクランプして置換する。 */
  applyPreset: (cutIds: string[]) => void;
  clearSelection: () => void;

  // ===== 出力カット選択アクション (ローカル保存用) =====
  /** 出力カットの選択トグル。 */
  toggleOutputCut: (cutId: string) => void;
  /** 完成している全カットを選択する。 */
  selectAllCompletedOutputs: () => void;
  /** 出力カットの選択をクリアする。 */
  clearOutputSelection: () => void;

  // ===== run アクション =====
  /**
   * 生成 run を開始する。pending スケルトンを作って status=running にする。
   *
   * 重要 (待機中 0/N 固着バグ修正 2026-06-06):
   *   runId は **invoke の前** に呼んで skeleton を先に建てるため null 許容。
   *   バックエンドの run_id が返ったら setRunId で後付けする。
   *   こうしないと Rust 側が invoke 直後に spawn して cutStarted/cutCompleted を
   *   先に emit するため、後から走る beginRun がそれらを pending で上書きしてしまう。
   */
  beginRun: (runId: string | null, selectedCutIds: { cutId: string; label: string }[]) => void;
  /** beginRun(null, ...) の後でバックエンドの run_id を後付けする。 */
  setRunId: (runId: string) => void;
  applyEvent: (e: MultiAngleEvent) => void;
  /** run 状態だけ初期化 (設定は保持)。 */
  reset: () => void;
};

const runEmptyState = {
  status: "idle" as MultiAngleRunStatus,
  runId: null as string | null,
  cuts: {} as Record<string, CutState>,
  cutOrder: [] as string[],
  cutStartedAt: {} as Record<string, number>,
};

export const useMultiAngleRun = create<MultiAngleRunState>((set) => ({
  ...runEmptyState,

  // 設定の初期値
  characterImagePath: null,
  environmentDescription: "",
  aspectRatio: "1:1",
  selectedCutIds: [],
  selectedOutputCutIds: [],

  setCharacterImage: (path) => set({ characterImagePath: path }),
  setEnvironment: (text) => set({ environmentDescription: text }),
  setAspectRatio: (ratio) => set({ aspectRatio: ratio }),

  toggleCut: (cutId) =>
    set((s) => {
      const exists = s.selectedCutIds.includes(cutId);
      if (exists) {
        return { selectedCutIds: s.selectedCutIds.filter((id) => id !== cutId) };
      }
      // 上限超過の追加は無視 (無意識の大量消費防止)
      if (s.selectedCutIds.length >= MAX_CUTS) return s;
      return { selectedCutIds: [...s.selectedCutIds, cutId] };
    }),

  applyPreset: (cutIds) =>
    set(() => {
      // 重複除去しつつ MAX_CUTS でクランプして置換
      const unique: string[] = [];
      for (const id of cutIds) {
        if (unique.length >= MAX_CUTS) break;
        if (!unique.includes(id)) unique.push(id);
      }
      return { selectedCutIds: unique };
    }),

  clearSelection: () => set({ selectedCutIds: [] }),

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

  beginRun: (runId, selectedCutIds) =>
    set((s) => {
      const cuts: Record<string, CutState> = {};
      const cutOrder: string[] = [];
      const cutStartedAt: Record<string, number> = {};
      for (const { cutId, label } of selectedCutIds) {
        // 既にイベントで進んだカット (running/completed/failed) があれば、その状態を
        // 維持する。pending で上書きすると先行到着した cutCompleted が消える。
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
      return {
        status: "running" as const,
        runId: runId ?? s.runId,
        cuts,
        cutOrder,
        cutStartedAt,
        // 新しい生成を始めたら、前 run の出力選択(緑✓)は持ち越さない。
        // 残すと前カットが選択済み表示で残り、全選択/一括保存の枚数が実態とズレる
        // (evaluator 指摘 2026-06-09)。新カット群に対して選び直す。
        selectedOutputCutIds: [],
      };
    }),

  setRunId: (runId) => set({ runId }),

  applyEvent: (e) =>
    set((s) => {
      switch (e.kind) {
        case "started":
          return { status: "running" as const, runId: e.runId };

        case "cutStarted": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: e.label,
            status: "pending" as const,
          };
          return {
            cuts: { ...s.cuts, [e.cutId]: { ...prev, label: e.label, status: "running" as const } },
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
          return { status: "completed" as const, runId: e.runId };

        default:
          return s;
      }
    }),

  reset: () => set({ ...runEmptyState, selectedOutputCutIds: [] }),
}));
