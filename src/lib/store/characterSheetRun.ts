import { create } from "zustand";

import { getSheetCut } from "../character/sheetCuts";
import type { CharacterSheetEvent, SheetCutState } from "../character/types";

/**
 * キャラクター登録パイプラインの run ストア。
 *
 * multiAngleRun.ts の「pending スケルトン先建て → イベント適用」の仕組みを役割(role)ベースに
 * 複製したもの。イベント取りこぼし対策(先行到着した cutStarted/cutCompleted を pending で
 * 上書きしない)も踏襲する。加えて登録ウィザードの step を持つ。
 */

type CharacterSheetRunStatus = "idle" | "running" | "completed" | "failed";

/**
 * この run を所有しているスキル。キャラ登録と表情差分は同じストアを共有するため、
 * 画面往復で他スキルの結果・ステップを引き継ぐのを防ぐ判別子として使う。
 * null = まだどちらの run も開始していない。
 */
export type CharacterSheetRunMode = "character" | "expression" | null;

/** 登録ウィザードのステップ。1=入力 / 2=生成中・結果 / 3=確認して登録。 */
export type RegisterStep = 1 | 2 | 3;

type CharacterSheetRunState = {
  // ===== 所有スキル判別 =====
  /** この run を所有するスキル(character/expression)。混線防止の判別子。 */
  mode: CharacterSheetRunMode;

  // ===== ウィザード =====
  step: RegisterStep;
  setStep: (step: RegisterStep) => void;

  // ===== run 状態 =====
  status: CharacterSheetRunStatus;
  runId: string | null;
  /** cutId → 実行状態。immutable に clone して更新する。 */
  cuts: Record<string, SheetCutState>;
  /** 表示順(beginRun で確定)。 */
  cutOrder: string[];
  /** cutId → 実際に生成を開始した時刻(epoch ms)。 */
  cutStartedAt: Record<string, number>;

  // ===== 設定(run を跨いで保持) =====
  characterName: string;
  characterImagePath: string | null;
  attributes: string;
  aspectRatio: string;
  /** 「詳しく」トグル。true なら全14カット、false なら既定10カット。 */
  extended: boolean;

  // ===== 設定アクション =====
  setCharacterName: (name: string) => void;
  setCharacterImage: (path: string | null) => void;
  setAttributes: (text: string) => void;
  setAspectRatio: (ratio: string) => void;
  setExtended: (extended: boolean) => void;

  // ===== run アクション =====
  /**
   * 生成 run を開始する。pending スケルトンを作って status=running にする。
   * runId は invoke の前に呼んで skeleton を先に建てるため null 許容
   * (multiAngleRun と同じ「待機中固着バグ修正」思想)。
   */
  beginRun: (
    mode: Exclude<CharacterSheetRunMode, null>,
    runId: string | null,
    cuts: { cutId: string; label: string; role: string }[],
  ) => void;
  /** beginRun(null, ...) の後でバックエンドの run_id を後付けする。 */
  setRunId: (runId: string) => void;
  applyEvent: (e: CharacterSheetEvent) => void;
  /** run 状態だけ初期化(設定は保持)。所有スキル(mode)も null に戻す。 */
  reset: () => void;
  /**
   * 入場したスキルの mode に合わせて run を確定する。mode が異なる(他スキルの
   * 結果を引き継いでいる)場合だけ run 状態と step を初期化する。自分の mode の
   * 実行中 run は消さない。CharacterRegister/ExpressionSet のマウント時に呼ぶ。
   */
  enterMode: (mode: Exclude<CharacterSheetRunMode, null>) => void;
};

const runEmptyState = {
  status: "idle" as CharacterSheetRunStatus,
  runId: null as string | null,
  cuts: {} as Record<string, SheetCutState>,
  cutOrder: [] as string[],
  cutStartedAt: {} as Record<string, number>,
};

export const useCharacterSheetRun = create<CharacterSheetRunState>((set) => ({
  mode: null,

  step: 1,
  setStep: (step) => set({ step }),

  ...runEmptyState,

  characterName: "",
  characterImagePath: null,
  attributes: "",
  aspectRatio: "1:1",
  extended: false,

  setCharacterName: (name) => set({ characterName: name }),
  setCharacterImage: (path) => set({ characterImagePath: path }),
  setAttributes: (text) => set({ attributes: text }),
  setAspectRatio: (ratio) => set({ aspectRatio: ratio }),
  setExtended: (extended) => set({ extended }),

  beginRun: (mode, runId, cuts) =>
    set((s) => {
      const nextCuts: Record<string, SheetCutState> = {};
      const cutOrder: string[] = [];
      const cutStartedAt: Record<string, number> = {};
      for (const { cutId, label, role } of cuts) {
        // 既にイベントで進んだカット(running/completed/failed)があれば維持する。
        // pending で上書きすると先行到着した cutCompleted が消える。
        const prev = s.cuts[cutId];
        nextCuts[cutId] =
          prev && prev.status !== "pending"
            ? { ...prev, label, role }
            : { cutId, label, role, status: "pending" };
        if (prev?.status === "running" && s.cutStartedAt[cutId]) {
          cutStartedAt[cutId] = s.cutStartedAt[cutId];
        }
        cutOrder.push(cutId);
      }
      return {
        mode,
        status: "running" as const,
        runId: runId ?? s.runId,
        cuts: nextCuts,
        cutOrder,
        cutStartedAt,
        step: 2 as RegisterStep,
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
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.role,
            status: "pending" as const,
          };
          return {
            cuts: {
              ...s.cuts,
              [e.cutId]: { ...prev, role: e.role, status: "running" as const },
            },
            cutStartedAt: { ...s.cutStartedAt, [e.cutId]: Date.now() },
          };
        }

        case "cutCompleted": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.role,
            status: "pending" as const,
          };
          return {
            cuts: {
              ...s.cuts,
              [e.cutId]: {
                ...prev,
                role: e.role,
                status: "completed" as const,
                imagePath: e.imagePath,
              },
            },
          };
        }

        case "cutFailed": {
          const prev = s.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.cutId,
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

  reset: () => set({ ...runEmptyState, mode: null }),

  enterMode: (mode) =>
    set((s) => {
      // 既に自分の mode の run がある場合は触らない(実行中/結果を保持)。
      if (s.mode === mode) return s;
      // 他スキルの mode(または未確定)の状態を引き継がないよう初期化する。
      return { ...runEmptyState, mode, step: 1 as RegisterStep };
    }),
}));
