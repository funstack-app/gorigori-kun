import { create } from "zustand";

import { MAX_CUTS } from "../multiangle/angles";
import type { CutState, MultiAngleEvent } from "../multiangle/types";
import { syncCutRunStatus, useGenerationStatus } from "./generationStatus";

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
   * runId はフロントで先に採番し、invoke 前に skeleton と一緒に記録する。
   * これにより、先行イベントを取りこぼさず、共有チャンネル上の別スキルの
   * イベントも runId の不一致で除外できる。
   */
  beginRun: (runId: string, selectedCutIds: { cutId: string; label: string }[]) => void;
  applyEvent: (e: MultiAngleEvent) => void;
  /** run 状態だけ初期化 (設定は保持)。 */
  reset: () => void;
  /**
   * 「新規開始」= run も設定もまとめてゼロスタート (Sol 評価 blocking#6 / 2026-08-04)。
   *
   * reset() との違い: reset() は生成の失敗・受信準備エラーの後始末用で、
   * 被写体参照・環境・アスペクト比・構図選択は **わざと残す** (同じ設定で
   * 撮り直すため)。一方こちらはユーザーが明示的に「別の被写体で最初から」と
   * 言ったときの操作なので、設定まで初期値へ戻す。
   *
   * S2 の mount-pool 化で、スキルを行き来しても状態が残るようになった。
   * その代償として「前の作業を消す手段」が画面から無くなるため、設計書 §4 DoD 7
   * (ゼロスタート導線) が各スキルに明示操作を要求している。
   */
  startNewRun: () => void;
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
      // 押した直後から右上に表示する (started イベントを待たない)
      useGenerationStatus.getState().start({
        id: runId,
        kind: "multiangle",
        total: cutOrder.length || undefined,
      });
      return {
        status: "running" as const,
        runId,
        cuts,
        cutOrder,
        cutStartedAt,
        // 新しい生成を始めたら、前 run の出力選択(緑✓)は持ち越さない。
        // 残すと前カットが選択済み表示で残り、全選択/一括保存の枚数が実態とズレる
        // (evaluator 指摘 2026-06-09)。新カット群に対して選び直す。
        selectedOutputCutIds: [],
      };
    }),

  applyEvent: (e) =>
    set((s) => {
      if (!s.runId || e.runId !== s.runId) return s;

      // 右上の生成状況パネルへ橋渡し (2026-07-25 STΛCK指示: 並列稼働数と原因を常時表示)
      syncCutRunStatus("multiangle", s.cuts, s.cutOrder.length, e);

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
          return { status: "completed" as const };

        default:
          return s;
      }
    }),

  reset: () => set({ ...runEmptyState, selectedOutputCutIds: [] }),

  startNewRun: () =>
    set({
      ...runEmptyState,
      selectedOutputCutIds: [],
      // 設定も初期値へ (reset() との違い。型定義側のコメント参照)。
      characterImagePath: null,
      environmentDescription: "",
      aspectRatio: "1:1",
      selectedCutIds: [],
    }),
}));
