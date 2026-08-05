import { create } from "zustand";

/**
 * ストーリー動画キュー (uy6 Wave 3)。
 *
 * 絵コンテ (ストーリーモード Phase 4) で確定したカット列を積み、動画タブで
 * カットごとに i2v 生成 → ffmpeg で 1 本に結合するまでの進行状態を持つ。
 *
 * 永続化しない (メモリのみ)。カット動画自体は generated_images と履歴に残るので、
 * アプリ再起動でキューが消えても生成物は失われない (design-video-story.md §1-B)。
 */

export type StoryCutJob = {
  cutId: string;
  /** 1 始まり。結合順の正 */
  order: number;
  /** i2v 元画像 (確定カット) の絶対パス */
  imagePath: string;
  /** buildI2vPrompt 由来の i2v プロンプト */
  prompt: string;
  /** 絵コンテの尺 (丸め前)。モデル制約への丸めは実行時に行う */
  requestedSeconds: number;
  status: "queued" | "generating" | "done" | "failed";
  videoPath?: string;
  error?: string;
};

export type StoryRunStatus =
  | "idle"
  /** 認証確認中。ボタンを押した瞬間にここへ入り、二重起動を弾く */
  | "starting"
  | "running"
  | "concatenating"
  | "done"
  | "failedPartial"
  | "concatFailed";

/** 実行中（＝新しい全体ランを始めてはいけない）とみなす状態。 */
export function isStoryRunBusy(status: StoryRunStatus): boolean {
  return status === "starting" || status === "running" || status === "concatenating";
}

type VideoStoryStore = {
  cuts: StoryCutJob[];
  runStatus: StoryRunStatus;
  finalVideoPath: string | null;
  cancelRequested: boolean;
  /** キューを丸ごと置き換える (全 status="queued")。 */
  setQueue: (cuts: Omit<StoryCutJob, "status">[]) => void;
  /**
   * カット 1 件だけをキューから外す。
   *
   * 「全消し (clear) か全生成か」の二択しかなく、1 カットだけ要らなくなっても
   * 外せなかった (STΛCK 実機報告 2026-08-05「シーンから消せないでずっと残る」)。
   *
   * 生成中 (`status: "generating"`) のカットは外さない。有料の MCP コールが
   * 実行中で、外しても走行中ジョブは止まらず、戻ってきた結果の置き場だけが
   * 消えて有料枠を捨てることになる。中止したいなら全体の「中止」を使う。
   *
   * @returns 外せたら true。生成中 / 見つからない場合は false。
   */
  removeCut: (cutId: string) => boolean;
  updateCut: (cutId: string, patch: Partial<StoryCutJob>) => void;
  /**
   * 画像の移動 / relink (旧→新パス) をキューの `imagePath` へ追従させる (S3)。
   *
   * ここが無いと「プロジェクトへ移動」した瞬間にキューの元画像が旧パスのままになり、
   * サムネが割れたうえ、生成に投げても届かない。
   *
   * 走行中 (`isStoryRunBusy`) は書き換えない。走行中ジョブの置き場を動かさないため
   * (`removeCut` が「生成中は外さない」としているのと同じ思想)。
   *
   * ヒットが 1 件も無ければ state を変えない (無駄な再描画を出さない)。
   */
  relinkPaths: (pathMap: Record<string, string>) => void;
  setRunStatus: (s: StoryRunStatus) => void;
  setFinalVideoPath: (p: string | null) => void;
  requestCancel: () => void;
  /**
   * 全体ランの開始ロックを取る。既に実行中なら false を返し、呼び出し側は中止する。
   *
   * 認証確認 (await) より前にこれを呼ぶこと。await を挟んでから running にすると、
   * 待っている間の二重クリックで有料生成が丸ごと二重に走る。
   * 同時に `cancelRequested` を落とす（中止後の再実行がワーカー即終了で
   * 何も起きない事故を防ぐ）。
   */
  tryBeginRun: () => boolean;
  clear: () => void;
  /**
   * どの runStatus からでもキューを空にする (中止 → 空にする)。
   *
   * `clear` だけでは実行中に押せる導線が無く、`failedPartial` /
   * `concatenating` ではキュー全体すら消せなかった (閉じ込め)。
   * 走行中の MCP コールは中断できないので、`cancelRequested` を立てて
   * ワーカーの次の投入を止めたうえで捨てる。
   */
  abortAndClear: () => void;
};

/**
 * 捨てると失われる生成物 (カット動画 / 結合済み動画) を持っているか。
 *
 * キューの積み直し (setQueue) は全置換なので、これが true のまま黙って
 * 積み直すと生成済みの動画パスが確認なしで state から消える。有料枠を
 * 再消費させないため、呼び出し側はこれを見て確認を挟む。
 */
export function hasGeneratedWork(state: {
  cuts: StoryCutJob[];
  finalVideoPath: string | null;
}): boolean {
  if (state.finalVideoPath) return true;
  return state.cuts.some((c) => c.status === "done" || Boolean(c.videoPath));
}

export const useVideoStory = create<VideoStoryStore>((set) => ({
  cuts: [],
  runStatus: "idle",
  finalVideoPath: null,
  cancelRequested: false,

  setQueue: (cuts) =>
    set({
      cuts: cuts.map((c) => ({ ...c, status: "queued" as const })),
      runStatus: "idle",
      finalVideoPath: null,
      cancelRequested: false,
    }),

  removeCut: (cutId) => {
    let removed = false;
    set((s) => {
      const target = s.cuts.find((c) => c.cutId === cutId);
      // 生成中は外さない (走行中の有料ジョブの置き場を消さない)。
      if (!target || target.status === "generating") return s;
      removed = true;
      // order は 1 始まりの連番として画面と結合順の正になっているので、
      // 抜いた後に振り直す。飛び番のまま残すと「Cut 1, Cut 3」と表示される。
      const cuts = s.cuts
        .filter((c) => c.cutId !== cutId)
        .map((c, i) => ({ ...c, order: i + 1 }));
      // 最後の 1 件を抜いたらランの残骸 (完成表示・結合パス) も一緒に畳む。
      if (cuts.length === 0) {
        return { ...s, cuts, runStatus: "idle" as const, finalVideoPath: null };
      }
      // 結合済みの「完成」表示は、構成が変わった時点で嘘になる
      // (その動画はもう画面のカット列と一致しない)。done から降ろす。
      //
      // 行き先を idle でなく concatFailed にするのは、idle が全体ラン
      // (= 全カットの有料再生成) のボタンを出すため。残ったカットは生成済みなので、
      // 出すべき導線は「1本につなげる」だけ。concatFailed + 全 done は
      // canConcatOnly を満たし、結合のやり直しだけが提示される。
      if (s.runStatus === "done") {
        return { ...s, cuts, runStatus: "concatFailed" as const, finalVideoPath: null };
      }
      return { ...s, cuts };
    });
    return removed;
  },

  updateCut: (cutId, patch) =>
    set((s) => ({
      cuts: s.cuts.map((c) => (c.cutId === cutId ? { ...c, ...patch } : c)),
    })),

  relinkPaths: (pathMap) => {
    const map = new Map(
      Object.entries(pathMap).filter(
        ([oldPath, newPath]) => oldPath && newPath && oldPath !== newPath,
      ),
    );
    if (map.size === 0) return;
    set((s) => {
      // 走行中は触らない (走行中ジョブの置き場を動かさない)。
      if (isStoryRunBusy(s.runStatus)) return s;
      let hit = false;
      const cuts = s.cuts.map((c) => {
        const next = map.get(c.imagePath);
        if (!next) return c;
        hit = true;
        return { ...c, imagePath: next };
      });
      if (!hit) return s;
      return { ...s, cuts };
    });
  },

  setRunStatus: (runStatus) => set({ runStatus }),
  setFinalVideoPath: (finalVideoPath) => set({ finalVideoPath }),
  requestCancel: () => set({ cancelRequested: true }),

  tryBeginRun: () => {
    // set(fn) は同期に走るため、同一イベントループ内の二重クリックでも
    // 2 回目は既に "starting" を読む（compare-and-set と同じ効果）。
    let acquired = false;
    set((s) => {
      if (isStoryRunBusy(s.runStatus)) return s;
      acquired = true;
      return { ...s, runStatus: "starting" as const, cancelRequested: false };
    });
    return acquired;
  },

  clear: () =>
    set({
      cuts: [],
      runStatus: "idle",
      finalVideoPath: null,
      cancelRequested: false,
    }),

  abortAndClear: () =>
    // cancelRequested を true のまま残す必要はない: cuts が空になるので
    // ワーカーは次の投入で cuts.length を超えて自然に終わる。ただし走行中の
    // ワーカーが「投入前に cancelRequested を確認する」経路を確実に通るよう、
    // 空にするのと同じ set で立てておく (次のランは tryBeginRun が落とす)。
    set({
      cuts: [],
      runStatus: "idle",
      finalVideoPath: null,
      cancelRequested: true,
    }),
}));

// dev-only: expose store for Playwright UI tests / inspection (videoGen.ts と同型)
if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __stores?: Record<string, unknown> }).__stores ??= {};
  (window as unknown as { __stores: Record<string, unknown> }).__stores.videoStory = useVideoStory;
}
