import { create } from "zustand";

import { getSheetCut } from "../character/sheetCuts";
import type {
  CharacterSheetEvent,
  SheetBackground,
  SheetCutState,
  SheetPromptMode,
} from "../character/types";
import type { SkillJob, SkillJobLedger } from "../skillJobs";
import { syncCutRunStatus, useGenerationStatus } from "./generationStatus";
import { useToasts } from "./toasts";

/**
 * キャラクター登録パイプラインの run ストア。
 *
 * ## 構造 (SQ1 / 2026-08-04 でジョブ台帳へ再構成)
 *
 * かつては「実行中の run が 1 本だけ」のシングルトン構造だった。そのため
 * キャラ 1 体の生成が終わるまで次の 1 体に着手できず、さらに登録時にストアの
 * **現在値**を読んでいたため「生成中に入力を書き換えると登録内容が変わる」潜在バグがあった。
 *
 * いまは 2 つの寿命を分けている:
 *
 * - **下書き (draft)**: characterName / characterImagePaths / attributes / シート設定。
 *   常に 1 つで、いつでも編集できる。走行中でも触ってよい。
 * - **ジョブ (jobs)**: 「生成する」を押した瞬間に下書きを凍結コピー (`SheetJobInput`) して生まれる。
 *   以後その入力は不変。だから走行中に下書きを書き換えても、走っているジョブの登録内容は変わらない。
 *
 * イベントは runId しか持たないので `runIndex` (runId → jobId) で引く。
 * ここに無い runId は必ず捨てる —— 終了・再生成・モード切替で外した run の後着通知が
 * 別ジョブの状態を上書きする事故 (B1 混線) を、条件分岐ではなく**表からの除外**で防ぐ。
 *
 * 並走数はフロントで制御しない。確定＝即 invoke で、順番待ちは Rust のセマフォに任せる
 * (フロントに待機キューを作ると、完了イベントの取りこぼしでキューが永久停止する)。
 */

/**
 * この run を所有しているスキル。キャラ登録と表情差分は同じストアを共有するため、
 * 画面往復で他スキルの結果・ステップを引き継ぐのを防ぐ判別子として使う。
 * null = まだどちらの run も開始していない。
 */
export type CharacterSheetRunMode = "character" | "expression" | null;

/** ジョブの実行状態。台帳に載っている間だけ意味を持つ。 */
export type SheetJobStatus = "running" | "completed" | "failed";

/** 登録ウィザードのステップ。1=入力 / 2=生成中・結果 / 3=確認して登録。 */
export type RegisterStep = 1 | 2 | 3;

/**
 * キャラ登録の参照画像の上限。
 *
 * 生成時の 3 枚制限 (presets/character.ts の DEFAULT_CHARACTER_REFERENCE_LIMIT) とは
 * 別軸。あちらは「登録済みキャラを通常生成へ適用するとき、並列生成が多発する経路」の
 * 速度対策。登録時のシート生成は run 全体で codex exec 1 回しか使わないので、同じ 3 枚に
 * 縛る理由がない。一方で無制限にもしない (参照が増えるほど 1 回の入力が肥大し、
 * 「正」の同一性が補助資料に薄まる)。
 */
export const MAX_CHARACTER_REFERENCE_IMAGES = 6;

/**
 * 「自分で作る」モードのシート生成プロンプトの上限文字数。
 * Rust 側 MAX_CUSTOM_SHEET_PROMPT_CHARS と一致させる二重柵。
 */
export const MAX_CUSTOM_SHEET_PROMPT_CHARS = 8000;

/**
 * 台帳に載せられる未決ジョブ数の上限。
 *
 * **スループット制御ではない**。実際の並走数は Rust のセマフォ (通常9/降格6) が決めるので、
 * ここを増減しても速くも遅くもならない。これはレール表示とメモリの健全性のための UI 上限で、
 * 10 という数字自体は恣意的 (セマフォ値のミラーではない)。
 */
export const MAX_OUTSTANDING_SHEET_JOBS = 10;

/** addCharacterImages の結果内訳。toast 文言の組み立てに使う。 */
export type AddCharacterImagesResult = {
  /** 実際に追加できた枚数。 */
  added: number;
  /** 上限に達していて追加できなかった枚数。 */
  rejected: number;
  /** 既に参照に入っていてスキップした枚数。 */
  duplicates: number;
};

/**
 * 確定 (生成ボタン押下) の瞬間に凍結される入力。以後不変。
 *
 * Step 2 / Step 3 の表示・登録・再生成はすべてこれを読む。ストアの現在値は読まない
 * —— 読んでしまうと「生成中に次のキャラを仕込むと、前のキャラが後のキャラの名前で登録される」
 * ことになる。凍結はその経路を構造的に塞ぐためにある。
 */
export type SheetJobInput = {
  characterName: string;
  characterImagePaths: string[];
  attributes: string;
  aspectRatio: string;
  sheetPromptMode: SheetPromptMode;
  customSheetPrompt: string;
  sheetBackground: SheetBackground;
  regenerateTargetPresetId: string | null;
};

/**
 * 生成枠 (Rust の GLOBAL_GEN_SEMAPHORE) から見た、この run の状態。
 *
 * - `unknown`: 枠の情報が一度も届いていない。gen-phase を出さない経路
 *   (Windows / codex exec フォールバック) はここに留まる。
 * - `queued`: 枠の空き待ち。まだ 1 枚も描き始めていない。
 * - `active`: 少なくとも 1 枚が枠を取って動き出した。**一度立ったら戻さない**
 *   (複数カットの run では 1 枚目が走り出した時点で「生成中」が正しく、
 *   残りが枠待ちでも「順番待ち」へ引き戻すのは実態と食い違う)。
 */
export type SheetSlotPhase = "unknown" | "queued" | "active";

/** 台帳に載る 1 本のジョブ。共通契約 SkillJob を SheetCutState / SheetJobInput で具体化したもの。 */
export type SheetJob = SkillJob<SheetJobInput, SheetCutState> & {
  jobMode: Exclude<CharacterSheetRunMode, null>;
  status: SheetJobStatus;
  slotPhase: SheetSlotPhase;
};

/** ジョブが 1 本も無いときに Step 2/3 が読む既定値 (undefined 分岐を消すための空ジョブ)。 */
const IDLE_JOB: SheetJob = {
  jobId: "",
  jobMode: "character",
  activeRunId: "",
  input: {
    characterName: "",
    characterImagePaths: [],
    attributes: "",
    aspectRatio: "1:1",
    sheetPromptMode: "default",
    customSheetPrompt: "",
    sheetBackground: "auto",
    regenerateTargetPresetId: null,
  },
  cuts: {},
  cutOrder: [],
  cutStartedAt: {},
  status: "completed",
  slotPhase: "unknown",
  createdAt: 0,
};

type CharacterSheetRunState = SkillJobLedger<SheetJob> & {
  // ===== 所有スキル判別 =====
  /** この画面を所有するスキル(character/expression)。混線防止の判別子。 */
  mode: CharacterSheetRunMode;

  // ===== ウィザード =====
  step: RegisterStep;
  setStep: (step: RegisterStep) => void;
  /** キャラ登録の属性自動抽出。タブ移動中も二重起動を防ぐ。 */
  attributeExtracting: boolean;
  setAttributeExtracting: (extracting: boolean) => void;
  /** character_sheet_run の起動要求中だけ立つ同期ガード。 */
  characterSubmitting: boolean;
  setCharacterSubmitting: (submitting: boolean) => void;

  // ===== 下書き(ジョブを跨いで保持・常に編集可) =====
  characterName: string;
  /**
   * 参照画像の全量。[0] がメイン(キャラクター同一性の正)、2枚目以降は補助資料。
   * 単数の characterImagePath は廃止し、この配列を唯一の正とする(正が2箇所あると
   * リセット・enterMode・連携セットで片方だけ更新される drift 事故になる)。
   */
  characterImagePaths: string[];
  attributes: string;
  aspectRatio: string;
  /**
   * シートの作り方 (2026-08-03)。default=既定シートテンプレ /
   * custom=customSheetPrompt をそのまま生成指示にする。
   */
  sheetPromptMode: SheetPromptMode;
  /** 自分で作るモードのプロンプト全文。上限 MAX_CUSTOM_SHEET_PROMPT_CHARS 文字。 */
  customSheetPrompt: string;
  /** シート背景色 (4択)。auto = 従来挙動 (背景句を差し替えない)。 */
  sheetBackground: SheetBackground;
  /**
   * シート作り直しの上書き対象プリセット ID (B-5 2026-07-30)。null = 通常の新規登録。
   * 下書き側のフィールドなので enterMode / reset では消えない。
   *
   * クリア地点は (1) 「＋ 次のキャラを仕込む」= prepareNextCharacter
   * (2) 新規登録連携 sendImageToCharacterRegister
   * (3) StepInput バナーの「新規キャラとして登録する」。
   * 放置すると無関係な新キャラ登録が旧プリセットを上書きする事故になるため、
   * クリア地点を増減させない。
   *
   * **登録成功はクリア地点ではない** (Sol 評価 blocking#3 / 2026-08-04)。
   * 多重化後は「A を登録する瞬間に、下書きは既に B の作り直しを開いている」状態が
   * 普通に起きる。そこで下書きを触ると、A の登録が B の作り直し対象を消してしまう。
   * 登録内容は凍結済みの `job.input.regenerateTargetPresetId` から読むので、
   * 下書きをクリアしなくても A が誤って別プリセットを上書きすることはない。
   */
  regenerateTargetPresetId: string | null;
  setRegenerateTarget: (presetId: string | null) => void;

  // ===== 設定アクション =====
  setCharacterName: (name: string) => void;
  /** 参照画像を全置換する。重複は先勝ちで除去し、上限 6 枚で切る。 */
  setCharacterImages: (paths: string[]) => void;
  /** 参照画像を追加する。既存重複はスキップ、空き枠を超えた分は却下する。 */
  addCharacterImages: (paths: string[]) => AddCharacterImagesResult;
  /** 指定パスの参照画像を外す。 */
  removeCharacterImage: (path: string) => void;
  /** 指定パスを配列先頭へ移動する(メイン昇格)。 */
  promoteCharacterImage: (path: string) => void;
  /**
   * 1 枚だけセットする互換ラッパ。表情差分・マルチアングル連携・シート作り直しなど
   * 単数で送り込む既存の呼び出し元を無修正のまま保つために残す。
   */
  setCharacterImage: (path: string | null) => void;
  setAttributes: (text: string) => void;
  setAspectRatio: (ratio: string) => void;
  setSheetPromptMode: (mode: SheetPromptMode) => void;
  /** 上限を超える入力は切り詰めて保持する (フロント側の一次柵)。 */
  setCustomSheetPrompt: (text: string) => void;
  setSheetBackground: (background: SheetBackground) => void;

  // ===== ジョブ アクション =====
  /**
   * 下書きを凍結してジョブを 1 本作り、focus して step=2 にする。
   * invoke 前に呼ぶこと (pending スケルトンが先に建つので、開始直後のイベントも取りこぼさない)。
   *
   * 呼び出し側の形は旧 `beginRun(mode, runId, cuts)` のまま。返り値に jobId を足しただけなので、
   * 戻り値を使わない既存の呼び出し (表情差分) はそのまま動く。
   */
  beginRun: (
    mode: Exclude<CharacterSheetRunMode, null>,
    runId: string,
    cuts: { cutId: string; label: string; role: string }[],
  ) => string;
  applyEvent: (e: CharacterSheetEvent) => void;
  /**
   * `codex://gen-phase` を受けて、その run の生成枠の状態を記録する。
   *
   * これが「順番待ち」と「生成中」を分ける唯一の実データ。CharacterSheetEvent の
   * cutStarted は Rust 側で **枠を取る前** に飛ぶので、それだけでは枠待ちを見分けられない
   * (Sol 評価 blocking#1 / 2026-08-04)。
   *
   * 台帳に無い runId は捨てる (applyEvent と同じ墓標化の規則)。
   */
  noteSlotPhase: (runId: string, phase: "queued" | "thinking" | "drawing" | "done") => void;
  /** 画面が見るジョブを切り替える。存在しない jobId は無視する。 */
  focusJob: (jobId: string) => void;
  /**
   * ジョブを台帳から外す (中止・破棄)。run は runIndex から外して墓標化するので、
   * 以後そのジョブ宛の後着イベントは行き先を失って落ちる。
   * 生成状況パネルの行も「中止」として片付ける (「完成しました」と嘘をつかない)。
   */
  dismissJob: (jobId: string) => void;
  /**
   * 登録が完了したジョブを台帳から外す。**下書きには触らない**
   * (仕込み途中の次のキャラが消えないことが、交錯対策の本体)。
   */
  completeJob: (jobId: string) => void;
  /**
   * 同一入力で run を張り直す (Step 2 の再生成)。旧 runId を runIndex から外し、
   * パネルの旧行を片付けて新行を建てる。jobId は変わらない。
   */
  replaceJobRun: (
    jobId: string,
    newRunId: string,
    cuts: { cutId: string; label: string; role: string }[],
  ) => void;
  /**
   * 次のキャラを仕込む: キャラ個別の下書き(名前・参照画像・属性・作り直し対象)だけを
   * クリアして Step 1 へ戻す。シート設定(作り方・カスタムプロンプト・背景色)は**残す**
   * —— 連続登録では作り方を揃えるのが普通で、毎回選び直させるほうが事故に近い。
   * 逆に個別フィールドは前キャラの混入がそのまま誤登録になるので必ず消す。
   */
  prepareNextCharacter: () => void;
  /**
   * 表示状態だけ初期化する (focus を外して step=1)。**ジョブ台帳は触らない**。
   * 走行中の生成を画面から消したいだけの経路 (連携の持ち込み防止) で使う。
   */
  reset: () => void;
  /**
   * 入場したスキルの mode に合わせて状態を確定する。mode が異なる(他スキルの
   * 結果を引き継いでいる)場合だけ、他モードのジョブを台帳から外して step を初期化する。
   * 自分の mode のジョブは消さない。CharacterRegister/ExpressionSet のマウント時に呼ぶ。
   */
  enterMode: (mode: Exclude<CharacterSheetRunMode, null>) => void;
};

/**
 * run のイベントを右上の生成状況パネルへ橋渡しする。
 *
 * 実イベント (cutStarted / cutCompleted / cutFailed) を数えるので、
 * 経過時間からの推定ではなく **実際の並列稼働数と完了数** が表示される。
 * これが「動いているのに固まって見える」問題への対処の本体。
 *
 * kind は**ジョブ自身の jobMode** から決める。ストアの現在モードを見ると、
 * モード切替の直後に届いた後着イベントで種別を取り違える (多重化して初めて現実になる経路)。
 */
function syncGenerationStatus(job: SheetJob, e: CharacterSheetEvent) {
  syncCutRunStatus(
    job.jobMode === "expression" ? "expressionSet" : "characterSheet",
    job.cuts,
    job.cutOrder.length,
    e,
  );
}

/** 重複を先勝ちで除去し、上限まで切り詰める。 */
function dedupeReferences(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_CHARACTER_REFERENCE_IMAGES) break;
  }
  return out;
}

/**
 * 生成状況パネル(右上)の行名を作る。
 *
 * 多重化すると同じ種別の行が並ぶので、種別名だけでは「どれがどのキャラか」が
 * 分からなくなる (SQ2 / 2026-08-04)。凍結済みの名前を添えて区別できるようにする。
 * 名前未入力のジョブは種別名のまま (undefined を返す) —— 「: (名前未入力)」と
 * 出すより、素の種別名のほうが読みやすい。
 */
function buildStatusLabel(
  jobMode: Exclude<CharacterSheetRunMode, null>,
  characterName: string,
): string | undefined {
  const name = characterName.trim();
  if (!name) return undefined;
  return `${jobMode === "expression" ? "表情差分" : "キャラクターシート"}: ${name}`;
}

/** cuts 配列から pending スケルトンを建てる。別 run の完了画像・失敗状態は引き継がない。 */
function buildPendingCuts(cuts: { cutId: string; label: string; role: string }[]): {
  cuts: Record<string, SheetCutState>;
  cutOrder: string[];
} {
  const nextCuts: Record<string, SheetCutState> = {};
  const cutOrder: string[] = [];
  for (const { cutId, label, role } of cuts) {
    nextCuts[cutId] = { cutId, label, role, status: "pending" };
    cutOrder.push(cutId);
  }
  return { cuts: nextCuts, cutOrder };
}

/** 台帳・逆引き表・順序・focus から 1 本のジョブを取り除いた次状態を作る。 */
function removeJob(
  s: Pick<CharacterSheetRunState, "jobs" | "jobOrder" | "runIndex" | "focusedJobId">,
  jobId: string,
): Pick<CharacterSheetRunState, "jobs" | "jobOrder" | "runIndex" | "focusedJobId"> {
  const { [jobId]: _removed, ...restJobs } = s.jobs;
  const runIndex: Record<string, string> = {};
  for (const [runId, owner] of Object.entries(s.runIndex)) {
    // このジョブの run は表から外す = 後着イベントは行き先を失って落ちる (墓標化)。
    if (owner !== jobId) runIndex[runId] = owner;
  }
  return {
    jobs: restJobs,
    jobOrder: s.jobOrder.filter((id) => id !== jobId),
    runIndex,
    focusedJobId: s.focusedJobId === jobId ? null : s.focusedJobId,
  };
}

/** 既存ジョブを差し替えた jobs レコードを作る (immutable)。 */
function withJob(
  jobs: Record<string, SheetJob>,
  jobId: string,
  patch: Partial<SheetJob>,
): Record<string, SheetJob> {
  const prev = jobs[jobId];
  if (!prev) return jobs;
  return { ...jobs, [jobId]: { ...prev, ...patch } };
}

export const useCharacterSheetRun = create<CharacterSheetRunState>((set, get) => ({
  mode: null,

  step: 1,
  setStep: (step) => set({ step }),
  attributeExtracting: false,
  setAttributeExtracting: (attributeExtracting) => set({ attributeExtracting }),
  characterSubmitting: false,
  setCharacterSubmitting: (characterSubmitting) => set({ characterSubmitting }),

  jobs: {},
  jobOrder: [],
  runIndex: {},
  focusedJobId: null,

  characterName: "",
  characterImagePaths: [],
  attributes: "",
  aspectRatio: "1:1",
  sheetPromptMode: "default",
  customSheetPrompt: "",
  sheetBackground: "auto",

  setCharacterName: (name) => set({ characterName: name }),

  setCharacterImages: (paths) =>
    set({ characterImagePaths: dedupeReferences(paths) }),

  addCharacterImages: (paths) => {
    const current = get().characterImagePaths;
    const existing = new Set(current);
    let duplicates = 0;
    // 追加候補内の重複も 1 件として扱う (同じ画像を 2 回ドロップしたときに
    // duplicates が二重計上されないよう、判定用 Set を進めながら数える)。
    const fresh: string[] = [];
    for (const path of paths) {
      if (!path) continue;
      if (existing.has(path)) {
        duplicates += 1;
        continue;
      }
      existing.add(path);
      fresh.push(path);
    }
    const space = MAX_CHARACTER_REFERENCE_IMAGES - current.length;
    const accepted = fresh.slice(0, Math.max(0, space));
    const rejected = fresh.length - accepted.length;
    if (accepted.length > 0) {
      set({ characterImagePaths: [...current, ...accepted] });
    }
    return { added: accepted.length, rejected, duplicates };
  },

  removeCharacterImage: (path) =>
    set((s) => ({
      characterImagePaths: s.characterImagePaths.filter((p) => p !== path),
    })),

  promoteCharacterImage: (path) =>
    set((s) => {
      if (!s.characterImagePaths.includes(path)) return s;
      return {
        characterImagePaths: [
          path,
          ...s.characterImagePaths.filter((p) => p !== path),
        ],
      };
    }),

  setCharacterImage: (path) =>
    set({ characterImagePaths: path ? [path] : [] }),

  setAttributes: (text) => set({ attributes: text }),
  setAspectRatio: (ratio) => set({ aspectRatio: ratio }),

  setSheetPromptMode: (mode) => set({ sheetPromptMode: mode }),
  setCustomSheetPrompt: (text) =>
    set({ customSheetPrompt: text.slice(0, MAX_CUSTOM_SHEET_PROMPT_CHARS) }),
  setSheetBackground: (background) => set({ sheetBackground: background }),

  regenerateTargetPresetId: null,
  setRegenerateTarget: (presetId) => set({ regenerateTargetPresetId: presetId }),

  beginRun: (mode, runId, cuts) => {
    const jobId = crypto.randomUUID();
    set((s) => {
      const { cuts: nextCuts, cutOrder } = buildPendingCuts(cuts);
      // ここが「凍結」。以後このジョブは下書きの変化から完全に切り離される。
      const input: SheetJobInput = {
        characterName: s.characterName,
        characterImagePaths: [...s.characterImagePaths],
        attributes: s.attributes,
        aspectRatio: s.aspectRatio,
        sheetPromptMode: s.sheetPromptMode,
        customSheetPrompt: s.customSheetPrompt,
        sheetBackground: s.sheetBackground,
        regenerateTargetPresetId: s.regenerateTargetPresetId,
      };
      const job: SheetJob = {
        jobId,
        jobMode: mode,
        activeRunId: runId,
        input,
        cuts: nextCuts,
        cutOrder,
        cutStartedAt: {},
        status: "running",
        // 枠の情報はまだ届いていない。gen-phase が来ない経路 (Windows /
        // codex exec フォールバック) ではここに留まり、cutStarted だけで判定する。
        slotPhase: "unknown",
        createdAt: Date.now(),
      };
      // 生成状況パネルへ即座に登録する。started イベントを待たないのは、
      // 「押した直後から何か見えている」ことがフリーズ誤認を防ぐ要点だから。
      useGenerationStatus.getState().start({
        id: runId,
        kind: mode === "expression" ? "expressionSet" : "characterSheet",
        total: cutOrder.length || undefined,
        label: buildStatusLabel(mode, input.characterName),
      });
      return {
        mode,
        jobs: { ...s.jobs, [jobId]: job },
        jobOrder: [...s.jobOrder, jobId],
        runIndex: { ...s.runIndex, [runId]: jobId },
        focusedJobId: jobId,
        step: 2 as RegisterStep,
      };
    });
    return jobId;
  },

  applyEvent: (e) =>
    set((s) => {
      // 後着通知混線対策(B1): runIndex に載っている run のイベントだけを、その run を
      // 持つジョブへ適用する。終了・再生成・モード切替で表から外した run の通知は
      // 行き先が無いので、ここで必ず落ちる (旧実装の lastEndedRunId 墓標の一般化)。
      const jobId = s.runIndex[e.runId];
      if (!jobId) return s;
      const job = s.jobs[jobId];
      if (!job) return s;

      // 決着済み (completed / failed) のジョブを走行中へ戻す種別は、ここで捨てる。
      //
      // **この判定は syncGenerationStatus より前でなければならない。**
      // run_id は再生成 (character_sheet_regenerate_cut) で使い回されるので、
      // 決着後に遅れて started / cutStarted が届く経路が実在する。
      // カード側 (下の switch) だけで塞ぐと、右上の生成状況パネルには先に
      // 通知が届いてしまい、`finished: true` のまま running が 0→1 に戻る
      // 矛盾状態になる (Sol 評価 / 2026-08-04 プローブで再現)。
      //
      // 巻き戻す種別だけを対象にする: cutCompleted / cutFailed / completed は
      // 決着済みジョブに遅れて届いても走行中へは戻さず、`completed` は
      // 右上の finish に必要なので落としてはいけない。
      // 完了 runId を逆引き表から外す手もあるが、それをすると同じ runId を使う
      // カット再生成のイベントまで落ちるので、ここは status 側で塞ぐ。
      if ((e.kind === "started" || e.kind === "cutStarted") && job.status !== "running") {
        return s;
      }

      // 生成状況パネル(右上)へ橋渡しする。2026-07-25 STΛCK指示:
      // 「並列で何枚動いているか・進まない原因」を常時見せ、フリーズに見せない。
      // store 側で1回だけ繋ぐ (各コンポーネントに散らすと繋ぎ忘れが出る)。
      syncGenerationStatus(job, e);

      switch (e.kind) {
        case "started":
          return { jobs: withJob(s.jobs, jobId, { status: "running" }) };

        case "cutStarted": {
          const prev = job.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.role,
            status: "pending" as const,
          };
          return {
            jobs: withJob(s.jobs, jobId, {
              cuts: {
                ...job.cuts,
                [e.cutId]: { ...prev, role: e.role, status: "running" as const },
              },
              cutStartedAt: { ...job.cutStartedAt, [e.cutId]: Date.now() },
            }),
          };
        }

        case "cutCompleted": {
          const prev = job.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.role,
            status: "pending" as const,
          };
          return {
            jobs: withJob(s.jobs, jobId, {
              cuts: {
                ...job.cuts,
                [e.cutId]: {
                  ...prev,
                  role: e.role,
                  status: "completed" as const,
                  imagePath: e.imagePath,
                },
              },
            }),
          };
        }

        case "cutFailed": {
          const prev = job.cuts[e.cutId] ?? {
            cutId: e.cutId,
            label: getSheetCut(e.cutId)?.label ?? e.cutId,
            role: e.cutId,
            status: "pending" as const,
          };
          return {
            jobs: withJob(s.jobs, jobId, {
              // キャラ登録は 1 run = 1 カットなので、その 1 枚が失敗した時点で
              // ジョブ全体が失敗。表情差分は一部失敗でも他が生きるので status は動かさない。
              status:
                job.jobMode === "character" &&
                job.cutOrder.length === 1 &&
                job.cutOrder[0] === e.cutId
                  ? ("failed" as const)
                  : job.status,
              cuts: {
                ...job.cuts,
                [e.cutId]: { ...prev, status: "failed" as const, reason: e.reason },
              },
            }),
          };
        }

        case "completed":
          return {
            jobs: withJob(s.jobs, jobId, {
              status:
                job.jobMode === "character" &&
                job.cutOrder.length === 1 &&
                job.cuts[job.cutOrder[0]]?.status === "failed"
                  ? ("failed" as const)
                  : ("completed" as const),
            }),
          };

        default:
          return s;
      }
    }),

  noteSlotPhase: (runId, phase) =>
    set((s) => {
      const jobId = s.runIndex[runId];
      if (!jobId) return s;
      const job = s.jobs[jobId];
      if (!job) return s;
      // 一度でも枠を取ったら active のまま。queued へ引き戻さない
      // (複数カットの run で 2 枚目の枠待ちが 1 枚目の実走を打ち消さないように)。
      if (job.slotPhase === "active") return s;
      const next: SheetSlotPhase = phase === "queued" ? "queued" : "active";
      if (job.slotPhase === next) return s;
      return { jobs: withJob(s.jobs, jobId, { slotPhase: next }) };
    }),

  focusJob: (jobId) =>
    set((s) => (s.jobs[jobId] ? { focusedJobId: jobId } : s)),

  dismissJob: (jobId) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return s;
      // 止めたのに「完成しました」と出さない (表示と実態の食い違いを作らない)。
      useGenerationStatus.getState().finish(job.activeRunId, "cancelled");
      useGenerationStatus.getState().clear(job.activeRunId);
      return removeJob(s, jobId);
    }),

  completeJob: (jobId) =>
    set((s) => (s.jobs[jobId] ? removeJob(s, jobId) : s)),

  replaceJobRun: (jobId, newRunId, cuts) =>
    set((s) => {
      const job = s.jobs[jobId];
      if (!job) return s;
      const { cuts: nextCuts, cutOrder } = buildPendingCuts(cuts);
      const oldRunId = job.activeRunId;

      // 旧 run はパネルからも表からも外す。以後の後着イベントは落ちる。
      useGenerationStatus.getState().finish(oldRunId, "cancelled");
      useGenerationStatus.getState().clear(oldRunId);
      useGenerationStatus.getState().start({
        id: newRunId,
        kind: job.jobMode === "expression" ? "expressionSet" : "characterSheet",
        total: cutOrder.length || undefined,
        // 再生成でも同じ名前を出す。凍結済み入力から取るので、下書きを書き換えていても
        // このジョブの行名は変わらない。
        label: buildStatusLabel(job.jobMode, job.input.characterName),
      });

      const runIndex: Record<string, string> = {};
      for (const [runId, owner] of Object.entries(s.runIndex)) {
        if (runId !== oldRunId) runIndex[runId] = owner;
      }
      runIndex[newRunId] = jobId;

      return {
        jobs: withJob(s.jobs, jobId, {
          activeRunId: newRunId,
          cuts: nextCuts,
          cutOrder,
          cutStartedAt: {},
          status: "running",
          // 新しい run は枠を取り直すところから。前 run の枠状態を持ち越すと、
          // 作り直した直後から「生成中」と出てしまう。
          slotPhase: "unknown",
        }),
        runIndex,
        focusedJobId: jobId,
        step: 2 as RegisterStep,
      };
    }),

  prepareNextCharacter: () =>
    set({
      characterName: "",
      characterImagePaths: [],
      attributes: "",
      regenerateTargetPresetId: null,
      focusedJobId: null,
      step: 1 as RegisterStep,
    }),

  reset: () => set({ focusedJobId: null, step: 1 as RegisterStep }),

  enterMode: (mode) =>
    set((s) => {
      // 既に自分の mode なら触らない(実行中/結果を保持)。
      if (s.mode === mode) return s;

      /*
        並走できない組み合わせを黙って捨てない (cne / 2026-08-04)。

        キャラ登録と表情差分はこのストアを共有しているため、片方に入ると
        もう片方の**走行中**ジョブの進捗表示は破棄される (v1 の既知の制限。
        ストア分離は別件)。以前は入場時に黙って消えていたが、右上パネルの
        ジョブ行クリックでスキル間を1クリックで行き来できるようになり、
        **走行中の生成の表示が黙って消える**経路が現実的になった。

        生成そのものは裏で走り続ける (画像はライブラリに残る) が、
        進捗と結果はこの画面から追えなくなる。消える前にその事実を伝える。
        止めはしない —— 破棄するかどうかはユーザーの操作の結果であって、
        こちらが勝手に決めることではない。

        多重化後は「1件」ではなく件数を数えて伝える (2件消えたのに1件と言わない)。

        **完成・登録待ちのジョブだけは持ち越す** (Sol 評価 blocking#4 / 2026-08-04)。
        完成カードは「未登録の成果」と「凍結入力 (名前・属性・元画像・作り直し対象)」を
        結び付ける唯一の場所で、消えると登録文脈が復元できない —— 画像がライブラリに
        残るのは代替にならない (誰の何のシートだったかが失われる)。走行中と違って
        こちらは裏で進行するものが無く、保持しても後着イベントで壊れる余地がない。
        戻ってくればレールに再び現れ、そのまま登録できる。
      */
      const outgoing = s.jobOrder
        .map((id) => s.jobs[id])
        .filter((job): job is SheetJob => Boolean(job) && job.jobMode !== mode);
      const runningCount = outgoing.filter((job) => job.status === "running").length;
      const keptOtherCount = outgoing.filter((job) => job.status === "completed").length;

      if (runningCount > 0) {
        const lost = mode === "expression" ? "キャラクター登録" : "表情差分";
        const entered = mode === "expression" ? "表情差分" : "キャラクター登録";
        const kept =
          keptOtherCount > 0
            ? `完成した${keptOtherCount}件は${lost}に戻れば登録できます。`
            : "";
        useToasts.getState().push({
          kind: "warn",
          text: `${lost}の生成${runningCount}件は裏で続きますが、${entered}と同時には表示できないため進捗表示を終了しました。生成された画像はライブラリに残ります。${kept}`,
          ttlMs: 8000,
        });
      }

      // 自モードのジョブと、他モードの「完成・登録待ち」だけを残す。
      // 外したジョブの run は逆引き表からも外れ、後着通知は落ちる。
      const keptOrder = s.jobOrder.filter((id) => {
        const job = s.jobs[id];
        if (!job) return false;
        return job.jobMode === mode || job.status === "completed";
      });
      const jobs: Record<string, SheetJob> = {};
      for (const id of keptOrder) {
        const job = s.jobs[id];
        if (job) jobs[id] = job;
      }
      const runIndex: Record<string, string> = {};
      for (const [runId, owner] of Object.entries(s.runIndex)) {
        if (jobs[owner]) runIndex[runId] = owner;
      }

      return {
        mode,
        jobs,
        jobOrder: keptOrder,
        runIndex,
        // 他モードの完成ジョブを台帳には残すが、focus は必ず外す。
        // 入場先の Step 2/3 が別スキルのジョブを表示してしまうため
        // (レールには selectModeJobs が mode で絞るので出ない)。
        focusedJobId:
          s.focusedJobId && jobs[s.focusedJobId]?.jobMode === mode
            ? s.focusedJobId
            : null,
        step: 1 as RegisterStep,
      };
    }),
}));

let slotPhaseListener: Promise<() => void> | null = null;

/**
 * `codex://gen-phase` の購読を 1 本だけ張る (Sol 評価 blocking#1 / 2026-08-04)。
 *
 * `ensureCharacterSheetEventListener` と同じ「張りっぱなし・失敗はキャッシュしない」形。
 * ipc を**動的 import** するのは、このストアがブラウザ非依存のままでいるため
 * (ユニットテストは Tauri API を持たない環境でこのファイルを読む)。
 *
 * 受け口は runIndex 経由なので、台帳に無い run のフェーズ通知は落ちる
 * (バッチ生成など他機能の gen-phase がキャラシートの状態を触ることはない)。
 */
export function ensureSheetSlotPhaseListener(): Promise<() => void> {
  if (!slotPhaseListener) {
    const pending = import("../ipc").then(({ onGenPhase }) =>
      onGenPhase((e) => {
        useCharacterSheetRun.getState().noteSlotPhase(e.runId, e.phase);
      }),
    );
    slotPhaseListener = pending;
    // 登録失敗をキャッシュし続けず、次回の画面入場で再試行できるようにする。
    void pending.catch(() => {
      if (slotPhaseListener === pending) slotPhaseListener = null;
    });
  }
  return slotPhaseListener;
}

/** ジョブレールのカードが出す状態 (SQ2 / 2026-08-04)。 */
export type SheetJobPhase = "waiting" | "running" | "completed" | "failed";

/**
 * ジョブの状態を、レールに出す 1 つの語へ畳む。
 *
 * `status === "running"` を一律「生成中」と出さないのが要点。生成枠 (Rust のセマフォ) が
 * 埋まっていると、invoke 済みでもカットは始まらない。そこを「生成中」と言うのは、
 * 動いていないものを動いていることにする嘘になる。
 *
 * 枠の実態は 2 系統から取る:
 *
 * 1. `slotPhase` (`codex://gen-phase` 由来) —— **こちらが正**。queued の間は
 *    枠待ちだと確定できる。cutStarted は Rust 側で枠を取る前に飛ぶので、
 *    それだけを見ていると枠待ちが「生成中」に見えた (Sol 評価 blocking#1)。
 * 2. `cuts` の状態 —— gen-phase が届かない経路 (Windows / codex exec
 *    フォールバック) の従来判定。slotPhase が `unknown` のときだけ効く。
 *    ここを消すと、それらの経路が永久に「順番待ち」表示になる (別の嘘になる)。
 */
export function sheetJobPhase(job: SheetJob): SheetJobPhase {
  if (job.status === "failed") return "failed";
  if (job.status === "completed") return "completed";
  // 枠を取ったと分かっているなら、カットイベントの到着を待たずに「生成中」。
  if (job.slotPhase === "active") return "running";
  // 枠待ちだと分かっているなら、cutStarted が来ていても「順番待ち」。
  if (job.slotPhase === "queued") return "waiting";
  const started = job.cutOrder.some((id) => {
    const cut = job.cuts[id];
    return cut?.status === "running" || cut?.status === "completed";
  });
  return started ? "running" : "waiting";
}

/**
 * 画面が見ているジョブを返す派生セレクタ。
 *
 * focus が無いときは空ジョブ (IDLE_JOB) を返すので、消費側は毎回 null 分岐を書かなくてよい。
 * **同一参照を返す**ので、focus 無しの間に再描画ループを起こさない。
 */
export function useFocusedSheetJob(): SheetJob {
  return useCharacterSheetRun((s) =>
    s.focusedJobId ? (s.jobs[s.focusedJobId] ?? IDLE_JOB) : IDLE_JOB,
  );
}

/** React 外から focus 中ジョブを読む (getState() 経路用)。 */
export function getFocusedSheetJob(): SheetJob {
  const s = useCharacterSheetRun.getState();
  return s.focusedJobId ? (s.jobs[s.focusedJobId] ?? IDLE_JOB) : IDLE_JOB;
}

/**
 * 現在のモードのジョブを仕込み順で返す (レール表示用)。
 *
 * 引数は台帳の 3 つの原子だけを要求する。ストア全体を受け取る形にすると、
 * 呼び出し側が `useCharacterSheetRun(selectModeJobs)` と書きたくなるが、
 * zustand v5 は返り値を Object.is で比較するので**毎回新しい配列を返すセレクタは
 * 無限再描画になる**。原子を個別に購読して useMemo で畳む使い方を型で促す。
 */
export function selectModeJobs(s: {
  jobs: Record<string, SheetJob>;
  jobOrder: string[];
  mode: CharacterSheetRunMode;
}): SheetJob[] {
  return s.jobOrder
    .map((id) => s.jobs[id])
    .filter((job): job is SheetJob => Boolean(job) && job.jobMode === s.mode);
}
