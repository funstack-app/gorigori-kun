import { create } from "zustand";

import { storyboard } from "../ipc";
import type {
  SceneGroup,
  ScoreBundle,
  StoryboardChatMessage,
  StoryboardEvent,
  StoryboardGoal,
  StoryboardPhase,
  StoryboardRunParams,
  StoryboardSketchVersion,
} from "../storyboard/types";
import { useActiveProject } from "./activeProject";
import { useProjects } from "./projects";

export type Take = {
  takeId: string;
  imagePath: string;
  scores: ScoreBundle;
};

export type CutState = {
  cutId: string;
  sceneGroupId?: string;
  description?: string;
  status: "pending" | "running" | "review" | "confirmed" | "failed";
  takes: Take[];
  selectedTakeId: string | null;
  error?: string;
  takeCount?: number;
};

type StoryboardRunStatus = "idle" | "running" | "paused" | "completed" | "failed";

/**
 * 完了した過去 run のスナップショット。新しい run を始めても消さず保持する。
 * STΛCK 指示 (2026-05-15): 「前のが消えるのを防ぐ」
 */
export type PastRunSummary = {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: StoryboardRunStatus;
  totalCuts: number;
  confirmedCuts: number;
  manifestPath: string | null;
  storyDigest: string;
};

type StoryboardRunState = {
  activeRunId: string | null;
  /**
   * P19a (2026-05-21 STΛCK指示): 絵コンテと本生成を完全分離。
   * cuts は **本生成 run 専用** の Map。絵コンテのイベントは sketchCuts に
   * 振り分けられる。これで Phase 2/3 の混線を物理的に排除する。
   */
  cuts: Map<string, CutState>;
  /** 絵コンテ run 専用の cuts Map (P19a)。Phase 2 が購読する。 */
  sketchCuts: Map<string, CutState>;
  sceneGroups: SceneGroup[];
  status: StoryboardRunStatus;
  totalCuts: number;
  manifestPath: string | null;
  checkpointCutId: string | null;
  lastError: string | null;
  params: StoryboardRunParams | null;
  debugLog: StoryboardEvent[];
  /** 完了した過去 run のサマリー一覧。新しい run を始めても消えない。 */
  pastRuns: PastRunSummary[];

  // ===== β版 4-Phase ワークフロー =====
  /** 現在の Phase (goal / sketch / generation / review)。 */
  phase: StoryboardPhase;
  /** Phase 1: ユーザーと AI の対話ログ。 */
  chatMessages: StoryboardChatMessage[];
  /** Phase 1 終了時に確定したゴール。Phase 2 入力になる。 */
  goal: StoryboardGoal | null;
  /** Phase 2: 提示したスケッチ案のバージョン履歴 (再生成で増える)。 */
  sketchVersions: StoryboardSketchVersion[];
  /** 現在表示中のスケッチ versionId。null なら最新を使う。 */
  activeSketchVersionId: string | null;

  beginRun: (runId: string, params: StoryboardRunParams) => void;
  applyEvent: (e: StoryboardEvent) => void;
  setStatus: (status: StoryboardRunStatus) => void;
  dismissCheckpoint: () => void;
  /** run 関連だけリセット (phase/goal/sketchVersions/chatMessages は保持) */
  reset: () => void;
  /** Phase ワークフロー (phase/goal/sketchVersions/chatMessages) もリセット */
  resetPhases: () => void;

  // ===== Phase 操作 =====
  setPhase: (phase: StoryboardPhase) => void;
  appendChatMessage: (msg: Omit<StoryboardChatMessage, "id" | "ts"> & { id?: string; ts?: number }) => void;
  clearChat: () => void;
  setGoal: (goal: StoryboardGoal | null) => void;
  pushSketchVersion: (version: StoryboardSketchVersion) => void;
  setActiveSketchVersion: (versionId: string | null) => void;
  /**
   * P19b: 絵コンテバージョンを「確定」状態にする。
   * confirmed=true の sketchVersion からのみ Phase 3 が参照画像を取り出す。
   */
  confirmSketchVersion: (versionId: string) => void;
  /** スケッチ内の特定カットを部分更新する (自由記述上書き等)。activeSketchVersionId 対象。 */
  updateSketchCut: (
    cutId: string,
    patch: Partial<{
      intent: string;
      cameraNote: string;
      visualLayout: string;
      userOverride: string;
      durationSeconds: number;
      sketchImagePath: string | undefined;
      sketchStatus: "pending" | "generating" | "done" | "failed";
    }>,
  ) => void;

  // ===== 各 Phase の起動済みフラグ (Phase 間往復で消えないようストア管理) =====
  // P1 修正 (2026-05-20): SketchReviewPanel / GenerationProgressPanel が
  // ローカル useState で起動済み判定をしていたため、Phase 切替でアンマウント
  // → 再マウント時に false に戻り重複 run が起動するバグがあった。
  sketchRunStartedAt: number | null;
  generationRunStartedAt: number | null;
  setSketchRunStartedAt: (ts: number | null) => void;
  setGenerationRunStartedAt: (ts: number | null) => void;

  // ===== P3b: ユーザーが D&D で並べ替えた表示順 =====
  // null なら sceneConstruction.cuts の元順序を使う。
  // cutIds 配列で順序を表現 (重複/欠落はクライアント側でガード)。
  cutDisplayOrder: string[] | null;
  setCutDisplayOrder: (order: string[] | null) => void;

  // ===== P10: 同時生成枚数 (1カットあたりの take 数) =====
  // 絵コンテ生成と本番生成で別々に保持する。
  // (絵コンテは速度優先で 1 デフォルト、本番は選択肢から 3 デフォルト)
  sketchCandidatesPerCut: 1 | 2 | 3;
  generationCandidatesPerCut: 1 | 2 | 3;
  setSketchCandidatesPerCut: (n: 1 | 2 | 3) => void;
  setGenerationCandidatesPerCut: (n: 1 | 2 | 3) => void;

  // ===== レビュー UI 操作系 (採用確認待ち時) =====
  /** 表示中の take をユーザー意思で確定 (採用ボタン) */
  adoptTake: (cutId: string, takeId?: string) => void;
  /** 採用済みカットを review に戻して別 take を選ばせる (戻る) */
  revertCut: (cutId: string) => void;
  /** review 状態の take を切り替え (左右ボタンで比較) */
  selectTake: (cutId: string, takeId: string) => void;
  /** 再生成リクエスト (まだバックエンド未対応、status を running に戻すだけ) */
  regenerateCut: (cutId: string) => void;
  /** スキップして次へ進む (このカットは confirmed 扱いで次に行く) */
  skipCut: (cutId: string) => void;

  // ===== デバッグログ拡充 =====
  /** UI から任意のメモログを追加 (パラメータ・エラー文脈などを保存) */
  appendDebug: (entry: { ts: number; level: "info" | "warn" | "error"; message: string; data?: unknown }) => void;
  uiDebugLog: Array<{ ts: number; level: "info" | "warn" | "error"; message: string; data?: unknown }>;
};

/**
 * STΛCK 報告 (2026-05-20): emptyState で phase/goal/sketchVersions/chatMessages
 * まで巻き戻していたため、beginRun() が走ると Phase 2 から Phase 1 に
 * 強制的に戻されてしまうバグがあった。
 *
 * これを修正するため、emptyState を 2 つに分割する:
 *
 *  - runEmptyState  : run (生成) に関する状態だけ。beginRun/reset で初期化される
 *  - phaseEmptyState: Phase ワークフロー (goal/sketch等) の状態。
 *                     ユーザー意思によるリセット (resetAll) でだけ初期化される
 *
 * これにより「Phase 1 で確定 → Phase 2 で run 起動 → Phase 2 にとどまる」が
 * 成立する。
 */
const runEmptyState = {
  activeRunId: null,
  cuts: new Map<string, CutState>(),
  sketchCuts: new Map<string, CutState>(),
  sceneGroups: [],
  status: "idle" as const,
  totalCuts: 0,
  manifestPath: null,
  checkpointCutId: null,
  lastError: null,
  params: null,
  debugLog: [],
};

const phaseEmptyState = {
  phase: "goal" as StoryboardPhase,
  chatMessages: [] as StoryboardChatMessage[],
  goal: null as StoryboardGoal | null,
  sketchVersions: [] as StoryboardSketchVersion[],
  activeSketchVersionId: null as string | null,
  sketchRunStartedAt: null as number | null,
  generationRunStartedAt: null as number | null,
  cutDisplayOrder: null as string[] | null,
};

const emptyState = {
  ...runEmptyState,
  ...phaseEmptyState,
};

function ensureCut(cuts: Map<string, CutState>, cutId: string): CutState {
  const existing = cuts.get(cutId);
  if (existing) return existing;
  const created: CutState = {
    cutId,
    status: "pending",
    takes: [],
    selectedTakeId: null,
  };
  cuts.set(cutId, created);
  return created;
}

export const useStoryboardRun = create<StoryboardRunState>((set) => ({
  ...emptyState,
  pastRuns: [],
  // P10: 同時生成枚数 (デフォルト)
  sketchCandidatesPerCut: 1 as 1 | 2 | 3,
  generationCandidatesPerCut: 3 as 1 | 2 | 3,

  beginRun: (runId, params) =>
    set((s) => {
      // 既存の run があれば pastRuns に退避してから新 run を開始する
      const archived: PastRunSummary[] =
        s.activeRunId && s.cuts.size > 0
          ? [
              ...s.pastRuns,
              {
                runId: s.activeRunId,
                startedAt: Date.now(),
                finishedAt: Date.now(),
                status: s.status,
                totalCuts: s.totalCuts,
                confirmedCuts: Array.from(s.cuts.values()).filter(
                  (c) => c.status === "confirmed",
                ).length,
                manifestPath: s.manifestPath,
                storyDigest:
                  (s.params?.storyPrompt ?? "").slice(0, 80) +
                  ((s.params?.storyPrompt?.length ?? 0) > 80 ? "…" : ""),
              },
            ]
          : s.pastRuns;
      // run 関連だけリセット。phase/goal/sketchVersions/chatMessages は保持する。
      // P19a: sketch_mode の run が始まる場合は sketchCuts を、本生成なら cuts を新規 Map に。
      // どちらの run でも「もう片方の Map」は既存値を保持する。
      const isSketch = params.sketchMode === true;
      return {
        ...runEmptyState,
        cuts: isSketch ? s.cuts : new Map<string, CutState>(),
        sketchCuts: isSketch ? new Map<string, CutState>() : s.sketchCuts,
        pastRuns: archived,
        activeRunId: runId,
        params,
        status: "running" as const,
      };
    }),

  applyEvent: (e) => {
    set((s) => {
      const debugLog = [...s.debugLog, e];
      // P19a: 現在の run の sketch_mode に応じて、どちらの Map を更新するか決める。
      // params が null の場合は started イベントを待っているので cuts (本生成) 側を仮で使う。
      const isSketch = s.params?.sketchMode === true;
      const sourceMap = isSketch ? s.sketchCuts : s.cuts;
      const targetMap = new Map(sourceMap);

      // 共通の patch ヘルパー: どちらの Map に書き込んだかを反映する
      const applyMap = <T extends object>(patch: T) =>
        isSketch
          ? ({ ...s, sketchCuts: targetMap, debugLog, ...patch } as typeof s)
          : ({ ...s, cuts: targetMap, debugLog, ...patch } as typeof s);

      if (e.kind === "started") {
        return {
          ...s,
          activeRunId: e.runId,
          totalCuts: e.totalCuts,
          sceneGroups: e.sceneGroups,
          status: "running",
          debugLog,
        };
      }

      if (e.kind === "cutStarted") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, {
          ...cut,
          sceneGroupId: e.sceneGroupId,
          status: "running",
          error: undefined,
          takeCount: e.takeCount,
        });
        return applyMap({ status: "running" as const });
      }

      if (e.kind === "takeCompleted") {
        const cut = ensureCut(targetMap, e.cutId);
        const takes = [
          ...cut.takes.filter((take) => take.takeId !== e.takeId),
          { takeId: e.takeId, imagePath: e.imagePath, scores: e.scores },
        ];
        targetMap.set(e.cutId, { ...cut, status: "review", takes });
        return applyMap({ status: "running" as const });
      }

      if (e.kind === "cutCheckpoint") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, {
          ...cut,
          status: cut.status === "pending" ? "review" : cut.status,
        });
        return applyMap({ checkpointCutId: e.cutId, status: "paused" as const });
      }

      if (e.kind === "cutConfirmed") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, {
          ...cut,
          status: "confirmed",
          selectedTakeId: e.selectedTakeId,
        });
        return applyMap({ status: "running" as const });
      }

      if (e.kind === "cutFailed") {
        const cut = ensureCut(targetMap, e.cutId);
        targetMap.set(e.cutId, { ...cut, status: "failed", error: e.reason });
        return applyMap({ status: "failed" as const, lastError: e.reason });
      }

      if (e.kind === "completed") {
        // 本生成 (sketch_mode=false) の完了時のみ採用画像をプロジェクトへ
        if (!isSketch) {
          const activeProjectId = useActiveProject.getState().activeProjectId;
          if (activeProjectId) {
            targetMap.forEach((cut) => {
              const take =
                cut.takes.find((item) => item.takeId === cut.selectedTakeId) ??
                cut.takes[0];
              if (take) {
                useProjects.getState().addItem(activeProjectId, {
                  imagePath: take.imagePath,
                  prompt: s.params?.storyPrompt,
                  note: `storyboard ${cut.cutId}`,
                });
              }
            });
          }
        }
        return {
          ...s,
          activeRunId: e.runId,
          status: "completed",
          manifestPath: e.manifestPath,
          debugLog,
        };
      }

      return { ...s, debugLog };
    });
  },

  setStatus: (status) => set({ status }),
  dismissCheckpoint: () => set({ checkpointCutId: null, status: "running" }),

  // ===== Phase 操作 =====
  setPhase: (phase) =>
    set((s) => ({
      phase,
      uiDebugLog: [
        ...s.uiDebugLog,
        { ts: Date.now(), level: "info" as const, message: `setPhase: ${phase}` },
      ].slice(-500),
    })),

  appendChatMessage: (msg) =>
    set((s) => {
      const finalized: StoryboardChatMessage = {
        id: msg.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: msg.role,
        text: msg.text,
        ts: msg.ts ?? Date.now(),
        probing: msg.probing,
      };
      return { chatMessages: [...s.chatMessages, finalized] };
    }),

  clearChat: () => set({ chatMessages: [] }),

  setGoal: (goal) => set({ goal }),

  pushSketchVersion: (version) =>
    set((s) => ({
      sketchVersions: [...s.sketchVersions, version],
      activeSketchVersionId: version.versionId,
    })),

  setActiveSketchVersion: (versionId) => set({ activeSketchVersionId: versionId }),

  // P19b: 絵コンテ確定
  confirmSketchVersion: (versionId) =>
    set((s) => ({
      sketchVersions: s.sketchVersions.map((v) =>
        v.versionId === versionId
          ? { ...v, confirmed: true, confirmedAt: Date.now() }
          : v,
      ),
    })),

  updateSketchCut: (cutId, patch) =>
    set((s) => {
      if (s.sketchVersions.length === 0) return s;
      const targetVersionId = s.activeSketchVersionId ?? s.sketchVersions[s.sketchVersions.length - 1].versionId;
      const nextVersions = s.sketchVersions.map((v) => {
        if (v.versionId !== targetVersionId) return v;
        return {
          ...v,
          cuts: v.cuts.map((c) => (c.cutId === cutId ? { ...c, ...patch } : c)),
        };
      });
      return { ...s, sketchVersions: nextVersions };
    }),

  // run 関連だけリセット。phase/goal/sketchVersions/chatMessages は保持する。
  // Phase の状態まで完全初期化したい場合は storyboard/resetAll.ts を使う。
  reset: () =>
    set((s) => ({
      ...runEmptyState,
      cuts: new Map<string, CutState>(),
      sketchCuts: new Map<string, CutState>(),
      debugLog: [],
      uiDebugLog: [],
      pastRuns: s.pastRuns, // 過去 run のサマリーは保持
    })),

  resetPhases: () =>
    set({ ...phaseEmptyState }),

  setSketchRunStartedAt: (ts) => set({ sketchRunStartedAt: ts }),
  setGenerationRunStartedAt: (ts) => set({ generationRunStartedAt: ts }),
  setCutDisplayOrder: (order) => set({ cutDisplayOrder: order }),
  setSketchCandidatesPerCut: (n) => set({ sketchCandidatesPerCut: n }),
  setGenerationCandidatesPerCut: (n) => set({ generationCandidatesPerCut: n }),

  uiDebugLog: [],
  appendDebug: (entry) =>
    set((s) => ({ uiDebugLog: [...s.uiDebugLog, entry].slice(-500) })),

  adoptTake: (cutId, takeId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      const finalTakeId =
        takeId ?? cut.selectedTakeId ?? cut.takes[0]?.takeId ?? null;
      next.set(cutId, {
        ...cut,
        status: "confirmed",
        selectedTakeId: finalTakeId,
      });
      const log = [
        ...s.uiDebugLog,
        {
          ts: Date.now(),
          level: "info" as const,
          message: `adoptTake: ${cutId} → ${finalTakeId ?? "(none)"}`,
        },
      ];
      // P2.5 (2026-05-20): 採用結果をサイドカー JSON に永続化 (fire-and-forget)。
      // アプリ再起動後も storyboard.readAdoptions で復元できる。
      if (s.activeRunId && finalTakeId) {
        void storyboard
          .persistAdoption(s.activeRunId, cutId, finalTakeId)
          .catch((err) => {
            console.warn("[storyboardRun] persistAdoption failed:", err);
          });
      }
      return { ...s, cuts: next, uiDebugLog: log.slice(-500) };
    }),

  revertCut: (cutId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, status: "review" });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `revertCut: ${cutId} (confirmed → review)`,
          },
        ].slice(-500),
      };
    }),

  selectTake: (cutId, takeId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, selectedTakeId: takeId });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `selectTake: ${cutId} → ${takeId}`,
          },
        ].slice(-500),
      };
    }),

  regenerateCut: (cutId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, status: "running", takes: [], error: undefined });
      // 実際のバックエンド再実行はまだ未対応。
      // status を running に戻すことで UI 上「やり直し中」を表現するのみ。
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "warn" as const,
            message: `regenerateCut: ${cutId} (バックエンド再生成は未実装。UI 状態のみリセット)`,
          },
        ].slice(-500),
      };
    }),

  skipCut: (cutId) =>
    set((s) => {
      const cut = s.cuts.get(cutId);
      if (!cut) return s;
      const next = new Map(s.cuts);
      next.set(cutId, { ...cut, status: "confirmed" });
      return {
        ...s,
        cuts: next,
        uiDebugLog: [
          ...s.uiDebugLog,
          {
            ts: Date.now(),
            level: "info" as const,
            message: `skipCut: ${cutId} (スキップして次へ)`,
          },
        ].slice(-500),
      };
    }),
}));
