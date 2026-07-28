import type {
  CandidatesPerCut,
  SceneConstruction,
  StoryboardGoal,
  StoryboardRunParams,
  StoryboardSketchCut,
  StoryboardSketchVersion,
} from "./types";

/**
 * S3 (2026-07-28): 本生成 params の組み立てを一箇所に集約する。
 *
 * ## なぜ切り出したか
 * 以前は GenerationProgressPanel の startGeneration の中だけにこの手順があり、
 * 採用ゲート式の本生成 (startProductionForCuts) は「直前の一括本生成 run の
 * params」を流用するしか手が無かった。そのため「一括を先に一度走らせないと
 * 採用ゲートが使えない」= 枠を節約するという設計目的と正面から矛盾していた。
 *
 * 組み立て手順そのものは移設のみで変更していない (確定ラフの捕捉条件・
 * キービジュアルのフォールバック・D&D 並び順の反映)。唯一の追加は
 * confirmedSketchReferences (keyVisual フォールバックを含まない確定ラフだけの map)。
 */

export type ProductionParamsBuild = {
  params: StoryboardRunParams;
  /** B1' 補完: Phase 4 の i2v プロンプトが参照する確定絵コンテメタ。 */
  cutSketchMeta: Record<string, StoryboardSketchCut>;
};

/**
 * buildProductionParams が storyboardRun ストアから読む値。
 *
 * ストアを直接 import しないのは循環参照 (storyboardRun → productionParams →
 * storyboardRun) を避けるため。呼び出し側が getState() の結果をそのまま渡せる
 * 形にしてある。
 */
export type ProductionParamsRunState = {
  sketchVersions: StoryboardSketchVersion[];
  activeSketchVersionId: string | null;
  keyVisualPath: string | null;
  cutDisplayOrder: string[] | null;
  generationCandidatesPerCut: CandidatesPerCut;
};

/**
 * 本生成 params を goal + 確定ラフから組み立てる。
 *
 * 副作用は持たない (ストアの reset / スナップショット格納は呼び出し側の責務)。
 * runId は呼び出し側が発行して渡す。
 */
export function buildProductionParams(input: {
  runId: string;
  goal: StoryboardGoal;
  sceneConstruction: SceneConstruction;
  run: ProductionParamsRunState;
  /** 省略時は run.generationCandidatesPerCut を使う。 */
  candidatesPerCut?: CandidatesPerCut;
  /** 採用ゲート式のとき、本生成する cutId を絞る。省略時は全カット。 */
  productionScope?: string[];
}): ProductionParamsBuild {
  const { runId, goal, sceneConstruction, run, productionScope } = input;

  // === B1 (2026-06-06): 絵コンテ混在の根絶 ===
  // 本生成で参照する絵コンテは「(a) 確定 (confirmed===true) かつ
  // (b) 今の goal に紐づくもの」だけに厳格化する。条件を満たさなければ
  // sketchReferences は空のまま = プロンプトのみで普通に生成する。
  const sketchVersions = run.sketchVersions;
  const activeSketchVersionId = run.activeSketchVersionId;
  const candidate =
    sketchVersions.find((v) => v.versionId === activeSketchVersionId) ??
    sketchVersions[sketchVersions.length - 1] ??
    null;
  // (b) goal バインディング検査: 絵コンテ生成時の goal 要約と現在の goal 要約の
  //     先頭が一致するときだけ採用する。前ストーリーの確定絵コンテが
  //     activeSketchVersionId 経由で残っていても、goal が変わっていれば弾く。
  const currentGoalKey = (goal.summary ?? "").slice(0, 200);
  const sketchBelongsToCurrentGoal =
    candidate != null && candidate.fromGoalSummary === currentGoalKey;
  const activeSketch =
    candidate?.confirmed === true && sketchBelongsToCurrentGoal ? candidate : null;

  const sketchReferences: Record<string, string> = {};
  // S3 issue-5 (2026-07-28): 確定ラフ**だけ**の map。keyVisual フォールバックを
  // 含めない。backend の previous_cut_sketch (前カットの鉛筆ラフ) ロールは
  // こちらだけを見るため、「キービジュアルが前カットのラフとして渡る」役割詐称を
  // 構造的に防ぐ。sketchReferences (フォールバック込み) はそのカット自身の構図
  // 参照として従来どおり使う。
  const confirmedSketchReferences: Record<string, string> = {};
  if (activeSketch) {
    for (const c of activeSketch.cuts) {
      // 確定済みかつ実際に done で画像が出ているカットのみ参照する。
      // 未生成 (sketchImagePath なし) のカットは混ぜない。
      if (c.sketchImagePath && c.sketchStatus === "done") {
        sketchReferences[c.cutId] = c.sketchImagePath;
        confirmedSketchReferences[c.cutId] = c.sketchImagePath;
      }
    }
  }

  // === B2: キービジュアル固定参照 (NOCTURNE @img1 移植) ===
  // キービジュアルが設定されていれば、確定絵コンテ参照を持たない全カットに
  // 共通の基準画像を固定で渡す。確定絵コンテがあるカットはその絵コンテを優先。
  const keyVisualPath = run.keyVisualPath;
  if (keyVisualPath) {
    for (const c of sceneConstruction.cuts) {
      if (!sketchReferences[c.cut_id]) {
        sketchReferences[c.cut_id] = keyVisualPath;
      }
    }
  }

  // B1' 補完: Phase 4 の i2v プロンプトがカメラワーク等のスケッチメタを
  // 失わないよう、確定絵コンテのメタを run スナップショットへ渡す。
  const cutSketchMeta: Record<string, StoryboardSketchCut> = {};
  if (activeSketch) {
    for (const c of activeSketch.cuts) {
      cutSketchMeta[c.cutId] = c;
    }
  }

  // P3b: ユーザーが D&D で並べ替えていた場合は sceneConstruction.cuts を
  // その順序にして本番に渡す。
  const displayOrder = run.cutDisplayOrder;
  const orderedScene = (() => {
    if (!displayOrder || displayOrder.length === 0) return sceneConstruction;
    const byCutId = new Map(sceneConstruction.cuts.map((c) => [c.cut_id, c]));
    const reordered = displayOrder
      .map((id) => byCutId.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (reordered.length !== sceneConstruction.cuts.length) {
      return sceneConstruction;
    }
    return { ...sceneConstruction, cuts: reordered };
  })();

  const params: StoryboardRunParams = {
    runId,
    storyPrompt: goal.summary || "ストーリーカット",
    characterReferenceImage: goal.characterReferencePath,
    styleReferenceImage: goal.styleReferencePath,
    // FB#3 (2026-06-06): 複数キャラ/スタイル参照 (後方互換: 単数も維持)。
    characterReferenceImages: goal.characterReferencePaths,
    styleReferenceImages: goal.styleReferencePaths,
    aspectRatio: goal.aspectRatio,
    durationSeconds: goal.durationSeconds,
    tempo: goal.tempo,
    candidatesPerCut: input.candidatesPerCut ?? run.generationCandidatesPerCut,
    cwd: undefined,
    sceneConstruction: orderedScene,
    sketchMode: false,
    manualSelection: true,
    sketchReferences,
    confirmedSketchReferences,
    ...(productionScope && productionScope.length > 0
      ? { productionScope }
      : {}),
  };

  return { params, cutSketchMeta };
}
