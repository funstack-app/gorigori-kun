import type {
  AssetLedgerEntry,
  FilmAsset,
  FilmAssetStressRound,
  FilmAssetStressTest,
  FilmAssetStressVerdict,
} from "./types";

export const REQUIRED_STRESS_CONDITIONS = [
  "真顔",
  "完全な横顔",
  "他の人物と同フレーム",
] as const;

export const DEFAULT_STRESS_CONDITIONS = [
  ...REQUIRED_STRESS_CONDITIONS,
  "逆光",
  "しゃがみ",
];

export const ASSET_CANDIDATE_COUNTS = [1, 2, 3] as const;
export type AssetCandidateCount = (typeof ASSET_CANDIDATE_COUNTS)[number];
export const DEFAULT_ASSET_CANDIDATE_COUNT: AssetCandidateCount = 1;

export type AssetTaskPoolResult<TItem, TValue> =
  | { item: TItem; status: "fulfilled"; value: TValue }
  | { item: TItem; status: "rejected"; reason: unknown };

/**
 * 順番待ちの仕事を最大 concurrency 件ずつ動かす、小さな並列プール。
 * 1件が失敗しても別の仕事は続け、shouldStop が true なら未着手分を開始しない。
 */
export async function runAssetTaskPool<TItem, TValue>(
  items: readonly TItem[],
  worker: (item: TItem, index: number) => Promise<TValue>,
  concurrency = 3,
  shouldStop: () => boolean = () => false,
): Promise<Array<AssetTaskPoolResult<TItem, TValue>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("並列数は1以上の整数で指定してください");
  }

  const results: Array<AssetTaskPoolResult<TItem, TValue> | undefined> = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (!shouldStop()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = { item, status: "fulfilled", value: await worker(item, index) };
      } catch (reason) {
        results[index] = { item, status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );
  return results.filter(
    (result): result is AssetTaskPoolResult<TItem, TValue> => result !== undefined,
  );
}

/**
 * 素材IDごとの実行権を1回だけ取る。同じ集合にある実行中・順番待ち素材は拒否する。
 * 下書き用と画像生成用で別の Set を渡し、処理完了時に releaseAssetRunRight で戻す。
 */
export function acquireAssetRunRight(claimedAssetIds: Set<string>, assetId: string): boolean {
  if (claimedAssetIds.has(assetId)) return false;
  claimedAssetIds.add(assetId);
  return true;
}

export function releaseAssetRunRight(claimedAssetIds: Set<string>, assetId: string): void {
  claimedAssetIds.delete(assetId);
}

/** 一括下書きの中止が、後から始まった個別下書きに上書きされないための小さな管理役。 */
export function createAssetDraftAbortRegistry() {
  let batchController: AbortController | null = null;
  const individualControllers = new Map<string, AbortController>();

  return {
    startBatch(): AbortController | null {
      if (batchController) return null;
      batchController = new AbortController();
      return batchController;
    },
    finishBatch(controller: AbortController): void {
      if (batchController === controller) batchController = null;
    },
    startIndividual(assetId: string): AbortController | null {
      if (individualControllers.has(assetId)) return null;
      const controller = new AbortController();
      individualControllers.set(assetId, controller);
      return controller;
    },
    finishIndividual(assetId: string, controller: AbortController): void {
      if (individualControllers.get(assetId) === controller) {
        individualControllers.delete(assetId);
      }
    },
    hasBatch(): boolean {
      return batchController !== null;
    },
    abortBatch(): void {
      batchController?.abort();
    },
    abortIndividuals(): void {
      for (const controller of individualControllers.values()) controller.abort();
    },
    abortAll(): void {
      batchController?.abort();
      for (const controller of individualControllers.values()) controller.abort();
    },
  };
}

/** 0枚だけを失敗にし、希望枚数未満でも完成分は候補として返す。 */
export function inspectGeneratedAssetCandidates(
  generatedPaths: string[],
  requestedCount: AssetCandidateCount,
): { paths: string[]; missingCount: number; isPartial: boolean } {
  if (!ASSET_CANDIDATE_COUNTS.includes(requestedCount)) {
    throw new Error("候補枚数は1〜3枚で指定してください");
  }
  const paths = generatedPaths.filter(Boolean);
  if (paths.length === 0) throw new Error("候補画像が1枚も完成しませんでした");
  const missingCount = Math.max(0, requestedCount - paths.length);
  return { paths, missingCount, isPartial: missingCount > 0 };
}

function emptyStressRound(): FilmAssetStressRound {
  return { status: "idle", imagePaths: [], verdicts: [] };
}

export function createDefaultStressTest(): FilmAssetStressTest {
  return {
    conditions: [...DEFAULT_STRESS_CONDITIONS],
    primaryRound: emptyStressRound(),
    extraRound: null,
    needsPromptRevision: false,
    extraRoundOffered: false,
    extraRoundDecision: null,
  };
}

function normalizeStressRound(
  round: FilmAssetStressRound | null | undefined,
): FilmAssetStressRound {
  if (!round) return emptyStressRound();
  return {
    status: round.status ?? "idle",
    imagePaths: Array.isArray(round.imagePaths) ? round.imagePaths.filter(Boolean) : [],
    verdicts: Array.isArray(round.verdicts) ? round.verdicts : [],
  };
}

function normalizeStressTest(
  stressTest: FilmAssetStressTest | null | undefined,
): FilmAssetStressTest {
  if (!stressTest) return createDefaultStressTest();
  const custom = Array.isArray(stressTest.conditions)
    ? stressTest.conditions.slice(3, 5).map((condition) => condition?.trim()).filter(Boolean)
    : [];
  return {
    conditions: [
      ...REQUIRED_STRESS_CONDITIONS,
      custom[0] ?? DEFAULT_STRESS_CONDITIONS[3],
      custom[1] ?? DEFAULT_STRESS_CONDITIONS[4],
    ],
    primaryRound: normalizeStressRound(stressTest.primaryRound),
    extraRound: stressTest.extraRound ? normalizeStressRound(stressTest.extraRound) : null,
    needsPromptRevision: Boolean(stressTest.needsPromptRevision),
    extraRoundOffered: Boolean(stressTest.extraRoundOffered),
    extraRoundDecision: stressTest.extraRoundDecision ?? null,
  };
}

/** S1〜S3で保存済みの台帳にも、S4の初期値を安全に補う。 */
export function normalizeFilmAsset(asset: AssetLedgerEntry): FilmAsset {
  const locked = asset.locked ?? asset.status === "locked";
  return {
    ...asset,
    status: locked ? "locked" : (asset.status ?? "unplanned"),
    pairKey: asset.pairKey ?? null,
    pairSide: asset.pairSide ?? null,
    promptDraft: asset.promptDraft ?? "",
    generatedImagePaths: Array.isArray(asset.generatedImagePaths)
      ? asset.generatedImagePaths.filter(Boolean)
      : [],
    lastGeneratedPrompt: asset.lastGeneratedPrompt ?? null,
    canonicalImagePath: asset.canonicalImagePath ?? null,
    ngNotes: Array.isArray(asset.ngNotes) ? asset.ngNotes.filter(Boolean) : [],
    stressTest:
      asset.type === "character" ? normalizeStressTest(asset.stressTest) : null,
    locked,
  };
}

/**
 * アプリ終了で応答を受け取れなかった走行中状態だけを、再実行できる状態へ戻す。
 * 通常の normalizeFilmAsset へ混ぜると実行直後にも中断扱いになるため、hydrate 専用。
 */
export function recoverInterruptedFilmAsset(source: AssetLedgerEntry): FilmAsset {
  const asset = normalizeFilmAsset(source);
  const interruptedStatus =
    asset.status === "generating" && asset.generatedImagePaths.length === 0
      ? "interrupted"
      : asset.status;
  if (!asset.stressTest) return { ...asset, status: interruptedStatus };

  const primaryRound = asset.stressTest.primaryRound.status === "generating"
    ? { ...asset.stressTest.primaryRound, status: "interrupted" as const }
    : asset.stressTest.primaryRound;
  const extraRound = asset.stressTest.extraRound?.status === "generating"
    ? { ...asset.stressTest.extraRound, status: "interrupted" as const }
    : asset.stressTest.extraRound;
  return {
    ...asset,
    status: interruptedStatus,
    stressTest: { ...asset.stressTest, primaryRound, extraRound },
  };
}

function isFailedStressTest(asset: FilmAsset): boolean {
  return asset.stressTest?.primaryRound.status === "failed"
    || asset.stressTest?.extraRound?.status === "failed";
}

/**
 * 起草文を保存する。ストレステストNG後だけは採用シートを残し、言葉を直して
 * 5枚をやり直せるようにする。それ以外の生成済み状態は古くなるため戻す。
 */
export function saveAssetPromptDraft(
  source: AssetLedgerEntry,
  promptDraft: string,
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (asset.locked) return asset;
  const nextPrompt = promptDraft.trim();
  if (nextPrompt === asset.promptDraft) return asset;

  if (asset.type === "character" && asset.canonicalImagePath && isFailedStressTest(asset)) {
    const stressTest = normalizeStressTest(asset.stressTest);
    const failedExtra = stressTest.extraRound?.status === "failed";
    return {
      ...asset,
      promptDraft: nextPrompt,
      status: "reviewed",
      stressTest: {
        ...stressTest,
        primaryRound: failedExtra ? stressTest.primaryRound : emptyStressRound(),
        extraRound: failedExtra ? emptyStressRound() : null,
        needsPromptRevision: false,
      },
    };
  }

  return {
    ...asset,
    promptDraft: nextPrompt,
    status: nextPrompt ? "planned" : "unplanned",
    generatedImagePaths: [],
    canonicalImagePath: null,
    stressTest: asset.type === "character" ? createDefaultStressTest() : null,
    locked: false,
  };
}

export function areAllAssetPromptsDrafted(assets: AssetLedgerEntry[]): boolean {
  return assets.length > 0
    && assets.every((asset) => Boolean(normalizeFilmAsset(asset).promptDraft.trim()));
}

export function needsPromptRevisionBeforeRegeneration(source: AssetLedgerEntry): boolean {
  const asset = normalizeFilmAsset(source);
  return Boolean(
    asset.ngNotes.length > 0
      && asset.lastGeneratedPrompt
      && asset.promptDraft.trim() === asset.lastGeneratedPrompt.trim()
      && !asset.canonicalImagePath,
  );
}

export function beginAssetGeneration(source: AssetLedgerEntry): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (asset.locked) throw new Error("ロック済みのアセットは生成し直せません");
  if (!asset.promptDraft.trim()) throw new Error("先にプロンプトを起草してください");
  if (needsPromptRevisionBeforeRegeneration(asset)) {
    throw new Error("NG理由を反映してプロンプトを直してから再生成してください");
  }
  return {
    ...asset,
    status: "generating",
    generatedImagePaths: [],
    canonicalImagePath: null,
    lastGeneratedPrompt: asset.promptDraft,
    stressTest: asset.type === "character" ? createDefaultStressTest() : null,
    locked: false,
  };
}

export function completeAssetGeneration(
  source: AssetLedgerEntry,
  generatedImagePaths: string[],
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  const paths = generatedImagePaths.filter(Boolean);
  if (asset.status !== "generating") throw new Error("生成開始前のアセットです");
  if (paths.length === 0) throw new Error("検品できる画像がありません");
  return { ...asset, status: "generating", generatedImagePaths: paths };
}

export function failAssetGeneration(source: AssetLedgerEntry): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (asset.status !== "generating") return asset;
  return { ...asset, status: "planned", generatedImagePaths: [] };
}

export function adoptAssetCandidate(
  source: AssetLedgerEntry,
  canonicalImagePath: string,
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!asset.generatedImagePaths.includes(canonicalImagePath)) {
    throw new Error("生成候補にない画像は採用できません");
  }
  if (asset.type === "character") {
    return {
      ...asset,
      status: "reviewed",
      canonicalImagePath,
      stressTest: createDefaultStressTest(),
      locked: false,
    };
  }
  return {
    ...asset,
    status: "locked",
    canonicalImagePath,
    stressTest: null,
    locked: true,
  };
}

export function rejectAssetCandidates(
  source: AssetLedgerEntry,
  note: string,
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  const trimmedNote = note.trim();
  if (!trimmedNote) throw new Error("全部NGの理由を一言入力してください");
  return {
    ...asset,
    status: "planned",
    canonicalImagePath: null,
    ngNotes: [...asset.ngNotes, trimmedNote],
    locked: false,
  };
}

export function updateStressConditions(
  source: AssetLedgerEntry,
  workConditions: [string, string],
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (asset.locked || asset.type !== "character" || !asset.stressTest) return asset;
  if (asset.stressTest.primaryRound.status !== "idle") return asset;
  const first = workConditions[0].trim() || DEFAULT_STRESS_CONDITIONS[3];
  const second = workConditions[1].trim() || DEFAULT_STRESS_CONDITIONS[4];
  return {
    ...asset,
    stressTest: {
      ...asset.stressTest,
      conditions: [...REQUIRED_STRESS_CONDITIONS, first, second],
    },
  };
}

export function canStartStressTest(
  source: AssetLedgerEntry,
  round: "primary" | "extra" = "primary",
): boolean {
  const asset = normalizeFilmAsset(source);
  if (
    asset.locked
    || asset.type !== "character"
    || !asset.canonicalImagePath
    || !asset.promptDraft.trim()
    || !asset.stressTest
    || asset.stressTest.needsPromptRevision
  ) {
    return false;
  }
  if (round === "primary") {
    return asset.stressTest.primaryRound.status === "idle"
      || asset.stressTest.primaryRound.status === "interrupted";
  }
  return asset.stressTest.primaryRound.status === "passed"
    && asset.stressTest.extraRoundDecision === "run"
    && (asset.stressTest.extraRound?.status === "idle"
      || asset.stressTest.extraRound?.status === "interrupted");
}

export function beginStressTest(
  source: AssetLedgerEntry,
  round: "primary" | "extra" = "primary",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!canStartStressTest(asset, round)) {
    throw new Error("ストレステストを開始できる状態ではありません");
  }
  if (!asset.stressTest) throw new Error("人物以外はストレステスト不要です");
  return {
    ...asset,
    stressTest: round === "primary"
      ? { ...asset.stressTest, primaryRound: { ...emptyStressRound(), status: "generating" } }
      : { ...asset.stressTest, extraRound: { ...emptyStressRound(), status: "generating" } },
  };
}

export function completeStressTestGeneration(
  source: AssetLedgerEntry,
  imagePaths: string[],
  round: "primary" | "extra" = "primary",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!asset.stressTest) throw new Error("人物以外はストレステスト不要です");
  const paths = imagePaths.filter(Boolean);
  if (paths.length !== 5) throw new Error("ストレステストは5枚そろってから検品します");
  const completed: FilmAssetStressRound = {
    status: "review",
    imagePaths: paths,
    verdicts: Array<FilmAssetStressVerdict>(5).fill(null),
  };
  return {
    ...asset,
    stressTest: round === "primary"
      ? { ...asset.stressTest, primaryRound: completed }
      : { ...asset.stressTest, extraRound: completed },
  };
}

export function failStressTestGeneration(
  source: AssetLedgerEntry,
  round: "primary" | "extra" = "primary",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!asset.stressTest) return asset;
  return {
    ...asset,
    stressTest: round === "primary"
      ? { ...asset.stressTest, primaryRound: emptyStressRound() }
      : { ...asset.stressTest, extraRound: emptyStressRound() },
  };
}

export function setStressTestVerdict(
  source: AssetLedgerEntry,
  index: number,
  verdict: Exclude<FilmAssetStressVerdict, null>,
  round: "primary" | "extra" = "primary",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!asset.stressTest) throw new Error("人物以外はストレステスト不要です");
  const current = round === "primary" ? asset.stressTest.primaryRound : asset.stressTest.extraRound;
  if (!current || current.status !== "review" || index < 0 || index >= current.imagePaths.length) {
    throw new Error("検品中の画像を選んでください");
  }
  const verdicts = [...current.verdicts];
  verdicts[index] = verdict;
  const nextRound = { ...current, verdicts };
  return {
    ...asset,
    stressTest: round === "primary"
      ? { ...asset.stressTest, primaryRound: nextRound }
      : { ...asset.stressTest, extraRound: nextRound },
  };
}

export function evaluateStressTest(
  source: AssetLedgerEntry,
  round: "primary" | "extra" = "primary",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (!asset.stressTest) throw new Error("人物以外はストレステスト不要です");
  const current = round === "primary" ? asset.stressTest.primaryRound : asset.stressTest.extraRound;
  if (!current || current.status !== "review" || current.verdicts.length !== 5) {
    throw new Error("5枚すべてを合否判定してください");
  }
  if (current.verdicts.some((verdict) => verdict === null)) {
    throw new Error("5枚すべてを合否判定してください");
  }
  const passed = current.verdicts.every((verdict) => verdict === "pass");
  const evaluatedRound: FilmAssetStressRound = {
    ...current,
    status: passed ? "passed" : "failed",
  };
  const stressTest: FilmAssetStressTest = round === "primary"
    ? {
        ...asset.stressTest,
        primaryRound: evaluatedRound,
        needsPromptRevision: !passed,
      }
    : {
        ...asset.stressTest,
        extraRound: evaluatedRound,
        needsPromptRevision: !passed,
      };

  if (!passed) return { ...asset, status: "reviewed", stressTest, locked: false };
  if (round === "extra" || asset.importance !== "primary") {
    return { ...asset, status: "locked", stressTest, locked: true };
  }
  return { ...asset, status: "reviewed", stressTest, locked: false };
}

export function chooseExtraStressRound(
  source: AssetLedgerEntry,
  decision: "run" | "skip",
): FilmAsset {
  const asset = normalizeFilmAsset(source);
  if (
    asset.type !== "character"
    || asset.importance !== "primary"
    || !asset.stressTest
    || asset.stressTest.primaryRound.status !== "passed"
    || asset.stressTest.extraRoundOffered
  ) {
    throw new Error("追加5枚を選べる状態ではありません");
  }
  const stressTest: FilmAssetStressTest = {
    ...asset.stressTest,
    extraRoundOffered: true,
    extraRoundDecision: decision,
    extraRound: decision === "run" ? emptyStressRound() : null,
  };
  return decision === "skip"
    ? { ...asset, status: "locked", stressTest, locked: true }
    : { ...asset, status: "reviewed", stressTest, locked: false };
}

export type AssetFactoryGateState = {
  canProceed: boolean;
  undraftedAssetIds: string[];
  unlockedPrimaryAssetIds: string[];
  unlockedOptionalAssetIds: string[];
};

export function getAssetFactoryGateState(
  sourceAssets: AssetLedgerEntry[],
): AssetFactoryGateState {
  const assets = sourceAssets.map(normalizeFilmAsset);
  const undraftedAssetIds = assets
    .filter((asset) => !asset.promptDraft.trim())
    .map((asset) => asset.id);
  const unlockedPrimaryAssetIds = assets
    .filter((asset) => asset.importance === "primary" && !asset.locked)
    .map((asset) => asset.id);
  const unlockedOptionalAssetIds = assets
    .filter((asset) => asset.importance !== "primary" && !asset.locked)
    .map((asset) => asset.id);
  return {
    canProceed:
      assets.length > 0
      && undraftedAssetIds.length === 0
      && unlockedPrimaryAssetIds.length === 0,
    undraftedAssetIds,
    unlockedPrimaryAssetIds,
    unlockedOptionalAssetIds,
  };
}

/** 正典の作業順。台帳自体のIDや保存順は変えず、表示だけ並べ替える。 */
export function sortAssetsForFactory(assets: AssetLedgerEntry[]): FilmAsset[] {
  const rank = (asset: AssetLedgerEntry): number => {
    if (asset.type === "character" && asset.importance === "primary") return 0;
    if (asset.type === "location" && asset.importance === "primary") return 1;
    if (asset.type === "text") return 2;
    if (asset.type === "prop") return 3;
    if (asset.type === "character") return 4;
    return 5;
  };
  return assets
    .map((asset, index) => ({ asset: normalizeFilmAsset(asset), index }))
    .sort((left, right) => rank(left.asset) - rank(right.asset) || left.index - right.index)
    .map(({ asset }) => asset);
}

/** 昼/夜など同じ組のうち、先に採用された正典画像を参照にする。 */
export function findLocationPairReferencePath(
  source: AssetLedgerEntry,
  allAssets: AssetLedgerEntry[],
): string | null {
  const asset = normalizeFilmAsset(source);
  const pairKey = asset.pairKey?.trim();
  if (asset.type !== "location" || !pairKey) return null;
  for (const candidateSource of allAssets) {
    const candidate = normalizeFilmAsset(candidateSource);
    if (
      candidate.id !== asset.id
      && candidate.type === "location"
      && candidate.pairKey?.trim() === pairKey
      && candidate.canonicalImagePath
    ) {
      return candidate.canonicalImagePath;
    }
  }
  return null;
}
