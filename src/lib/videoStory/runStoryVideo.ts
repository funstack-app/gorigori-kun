import { higgsfieldMcp, images, videoConcat } from "../ipc";
import { paramsToVideoArgs } from "../scene/useVideoSceneGeneration";
import { useActiveProject } from "../store/activeProject";
import { useAuth } from "../store/auth";
import { useBatches } from "../store/batches";
import { useProjects } from "../store/projects";
import { useToasts } from "../store/toasts";
import { useVideoGen } from "../store/videoGen";
import { isStoryRunBusy, useVideoStory, type StoryCutJob } from "../store/videoStory";
import {
  clampDurationForModel,
  findVideoModel,
  VIDEO_MODELS,
  type VideoModelDefinition,
} from "../videoModels";

/**
 * ストーリー動画ランナー (uy6 Wave 3)。
 *
 * 確定カット列をカットごとに i2v 生成し、全カット成功なら ffmpeg で 1 本へ結合する。
 *
 * 設計 (design-video-story.md §1-B):
 *   - モデル / 比率 / extraParams は **動画タブ (useVideoGen) の現在値** をそのまま使う。
 *     ユーザーが既に見て変更できる唯一の場所なので、真実の源を増やさない。
 *   - 同時実行は 2 固定。useVideoSceneGeneration の HIGGSFIELD_COMPARE_CONCURRENCY と
 *     同値・同理由 (codex exec→MCP の OAuth セッション競合回避)。
 *   - タイムラインへはカット動画 1 バッチ + 結合 1 本の別バッチで登録する。
 *     MCP は同期完結でライブイベントが流れないため、workerStarted / workerCompleted /
 *     workerFailed / completed をフロントで合成する (useVideoSceneGeneration と同型)。
 */

/** Higgsfield MCP の同時接続上限。useVideoSceneGeneration と同値・同理由。 */
const STORY_CONCURRENCY = 2;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function newRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 元画像が消えていたカットの失敗理由。3 経路で **同じ 1 定数** を使う
 * (言い換えを増やすと、同じ原因の失敗が画面で別物に見える)。
 */
export const MISSING_SOURCE_IMAGE_ERROR =
  "元画像が見つかりません（削除・移動された可能性があります）";

/**
 * 生成前ゲート: 元画像が実在するカットだけを通す。
 *
 * ## なぜ要るか
 *
 * `cut.imagePath` は絵コンテ確定時のスナップショットで、キューはメモリ上に
 * 残り続ける。ライブラリでのリネーム・削除・移動のあと動画化を押すと、
 * **存在しないパス**が MCP へ渡る。MCP 側は必ず失敗するが、その失敗は
 * 有料枠を消費したうえで返ってくる (投げた時点で課金される)。
 *
 * 「失敗させるより救済して可視化」が本経路の原則だが、**生成の入力だけは例外**。
 * 投げても必ず失敗するものに課金させないため、投入前に弾く。
 *
 * ## 方式
 *
 * 既存の `images.fileSizes` (Rust `images_file_sizes` = `std::fs::metadata`) が
 * 読めないパスに `size: null` を返すので、これを実在判定に使う。存在確認だけの
 * ための新コマンドは足さない。**1 ラン 1 回のバッチ呼び出し**にしてカットごとに
 * IPC を打たない。
 *
 * 0 バイトのファイルは `size: 0` (実在) なので、真偽値でなく `typeof` で見る。
 *
 * 検査基盤そのものが失敗したときは **fail-open**
 * (`imagePayloadGuard.guardImagePayloadForSend` と同じ判断)。存在確認ができない
 * ことを理由に生成を止めると、従来より悪い体験になる。
 *
 * @returns 元画像が見つからなかったカットの cutId 集合
 */
async function findMissingSourceCutIds(cuts: StoryCutJob[]): Promise<Set<string>> {
  const missing = new Set<string>();
  if (cuts.length === 0) return missing;
  try {
    // 同じ画像を複数カットが指すことがあるので、問い合わせは重複を畳む。
    const paths = [...new Set(cuts.map((c) => c.imagePath))];
    const entries = await images.fileSizes(paths);
    const missingPaths = new Set(
      entries.filter((e) => typeof e.size !== "number").map((e) => e.path),
    );
    // 応答に載らなかったパスは「判定できなかった」扱い (fail-open) で通す。
    for (const cut of cuts) {
      if (missingPaths.has(cut.imagePath)) missing.add(cut.cutId);
    }
  } catch (error) {
    // 検査の故障で生成を止めない。従来どおりの挙動 (MCP 側で失敗) に落ちるだけ。
    console.warn("[runStoryVideo] source image check failed; allowing generation", error);
    return new Set();
  }
  return missing;
}

/** 動画タブの現在設定から MCP 生成引数の共通部分を作る。 */
function currentVideoSettings(): {
  model: VideoModelDefinition;
  aspectRatio: string;
  mcpParams: ReturnType<typeof paramsToVideoArgs>;
} {
  const state = useVideoGen.getState();
  const model = findVideoModel(state.modelId) ?? VIDEO_MODELS[0];
  // quality / i2vInputField は MCP 側が使わないので落とす (単一生成経路と同じ)。
  const { quality: _q, i2vInputField: _i, ...mcpParams } = paramsToVideoArgs(
    model.extraParams,
    state.extraParamValues,
  );
  void _q;
  void _i;
  return { model, aspectRatio: state.aspectRatio, mcpParams };
}

/**
 * 生成前の認証ガード。未ログインなら文言を出して false を返す。
 * 文言は useVideoSceneGeneration と同一 (言い換えない)。
 */
async function ensureSignedIn(): Promise<boolean> {
  const authState = useAuth.getState();
  await authState.refresh({ silent: true });
  if (useAuth.getState().account) return true;
  const message =
    "ChatGPT にログインしていないため、生成できません。\n" +
    "左下の「ログイン」ボタンから ChatGPT にログインしてください。";
  useToasts.getState().push({ kind: "error", text: message, ttlMs: 0 });
  return false;
}

/** 1 カット分の i2v 生成。成功なら動画パス、失敗なら理由を返す。 */
async function generateOneCut(
  cut: StoryCutJob,
  settings: ReturnType<typeof currentVideoSettings>,
): Promise<{ path: string } | { error: string }> {
  const { model, aspectRatio, mcpParams } = settings;
  try {
    const r = await higgsfieldMcp.generateBatch({
      prompt: cut.prompt,
      model: model.jobSetType,
      count: 1,
      aspect: aspectRatio,
      refImagePaths: [cut.imagePath],
      mediaType: "video",
      duration: clampDurationForModel(model.id, Math.round(cut.requestedSeconds)),
      ...mcpParams,
    });
    const path = r.generatedPaths?.[0];
    if (path) return { path };
    return { error: r.errors?.[0] ?? "動画生成に失敗しました" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 生成できたカット動画をアクティブプロジェクトへ追加する (無ければ何もしない)。 */
function addToActiveProject(imagePath: string, prompt: string): void {
  const activeProjectId = useActiveProject.getState().activeProjectId;
  if (!activeProjectId) return;
  useProjects.getState().addItem(activeProjectId, { imagePath, prompt });
}

/**
 * 結合ステップ。成功なら結合動画をタイムライン + プロジェクトへ登録する。
 * ffmpeg 不在は degrade (info トースト) として扱い、エラー扱いしない。
 */
async function concatCuts(cuts: StoryCutJob[]): Promise<void> {
  const store = useVideoStory.getState();
  const ordered = [...cuts].sort((a, b) => a.order - b.order);
  const paths = ordered
    .map((c) => c.videoPath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  store.setRunStatus("concatenating");
  try {
    const finalPath = await videoConcat.story(paths);
    const batchId = `local-story-concat-${newRunId()}`;
    const { model } = currentVideoSettings();
    useBatches.getState().startBatch({
      batchId,
      prompt: ordered[0]?.prompt ?? "",
      references: ordered.map((c) => ({ path: c.imagePath, name: basename(c.imagePath) })),
      count: 1,
      provider: "higgsfield",
      modelJobSetType: model.jobSetType,
      modelDisplayName: "ストーリー結合",
      mediaType: "video",
    });
    useBatches.getState().applyEvent({
      kind: "completed",
      batchId,
      generatedPaths: [finalPath],
      failedCount: 0,
      provider: "higgsfield",
    });
    addToActiveProject(finalPath, ordered[0]?.prompt ?? "");
    useVideoStory.getState().setFinalVideoPath(finalPath);
    useVideoStory.getState().setRunStatus("done");
    useToasts.getState().push({
      kind: "success",
      text: "ストーリー動画が完成しました。タイムラインに追加されます。",
      ttlMs: 5000,
    });
  } catch (e) {
    // Tauri の invoke は Rust の Err(String) を **素の文字列** で reject する
    // (Error インスタンスではない)。e.message で読むと undefined になり degrade 分岐が
    // 死ぬため、既存の scene3d 経路 (Scene3dViewport.tsx) と同じ String(e)+includes で判定する。
    const message = String(e);
    useVideoStory.getState().setRunStatus("concatFailed");
    if (message.includes("ffmpeg-not-found")) {
      // 結合できないだけでカット動画は資産として残る。エラー扱いしない。
      useToasts.getState().push({
        kind: "info",
        text: "カットごとの動画は保存済みです。1本につなげるには ffmpeg のインストールが必要です。",
        ttlMs: 10000,
      });
    } else {
      useToasts.getState().push({
        kind: "error",
        text: "動画の結合に失敗しました。カットごとの動画は保存されています。",
        ttlMs: 10000,
      });
      console.error("[runStoryVideo] concat failed:", e);
    }
  }
}

/**
 * キューの全カットを i2v 生成し、全カット成功なら結合まで走る。
 */
export async function runStoryVideo(): Promise<void> {
  const store = useVideoStory.getState();
  const cuts = [...store.cuts].sort((a, b) => a.order - b.order);
  if (cuts.length === 0) {
    useToasts.getState().push({
      kind: "error",
      text: "動画化できる確定カットがありません。",
      ttlMs: 4000,
    });
    return;
  }

  // 開始ロックは **認証確認 (await) より前**。await を挟んでから running にすると、
  // 認証待ちの数百 ms のあいだの二重クリックで全カットが二重生成される（有料）。
  // tryBeginRun は cancelRequested も落とすので、中止後の再実行がワーカー即終了で
  // 空振りすることもない。
  const previousStatus = store.runStatus;
  if (!useVideoStory.getState().tryBeginRun()) return;

  // ロックを取った後の処理は**認証確認を含めて**すべて try/finally で囲う
  // (Sol指摘・非blocking risk 2026-08-03)。
  // 正常系の status 遷移は下のコードがこれまでどおり自分で行う。finally が触るのは
  // 「予期しない例外で starting/running のまま抜けた」場合だけで、その時だけ
  // failedPartial へ落として実行中ロックを解く（放置すると以後どのボタンも押せなくなる）。
  // `ensureSignedIn()` を try の外に置くと、その中の `authState.refresh()` が
  // 例外を投げた場合に starting のまま抜け、実行ボタンが永久に押せなくなる。
  try {
    if (!(await ensureSignedIn())) {
      // ロックを解放して元の状態に戻す（失敗表示や再実行ボタンを保つ）。
      useVideoStory.getState().setRunStatus(previousStatus === "starting" ? "idle" : previousStatus);
      return;
    }

    // 前回ランの結果を引きずらないよう、全カットを queued に戻してから始める。
    for (const cut of cuts) {
      useVideoStory.getState().updateCut(cut.cutId, {
        status: "queued",
        videoPath: undefined,
        error: undefined,
      });
    }
    useVideoStory.getState().setFinalVideoPath(null);
    useVideoStory.getState().setRunStatus("running");

    // 生成前ゲート: 元画像が消えたカットは MCP へ 1 件も投げない (有料枠の空焼き防止)。
    // 欠落したカットだけを failed にし、生きたカットは通常どおり走らせる。
    const missingCutIds = await findMissingSourceCutIds(cuts);
    for (const cutId of missingCutIds) {
      useVideoStory.getState().updateCut(cutId, {
        status: "failed",
        error: MISSING_SOURCE_IMAGE_ERROR,
      });
    }
    const liveCuts = cuts.filter((c) => !missingCutIds.has(c.cutId));
    if (liveCuts.length === 0) {
      // 全滅なら MCP を 1 回も呼ばず、バッチカードも作らずに畳む。
      // 失敗表示と「このカットを再生成」は既存の failedPartial 導線がそのまま担う。
      useVideoStory.getState().setRunStatus("failedPartial");
      useToasts.getState().push({
        kind: "error",
        text: `${MISSING_SOURCE_IMAGE_ERROR}。絵コンテからカットを送り直してください。`,
        ttlMs: 10000,
      });
      return;
    }

    const settings = currentVideoSettings();
    const batchId = `local-story-video-${newRunId()}`;
    useBatches.getState().startBatch({
      batchId,
      prompt: liveCuts[0].prompt,
      references: liveCuts.map((c) => ({ path: c.imagePath, name: basename(c.imagePath) })),
      count: liveCuts.length,
      provider: "higgsfield",
      modelJobSetType: settings.model.jobSetType,
      modelDisplayName: `${settings.model.label} ストーリー`,
      mediaType: "video",
    });

    const generatedPaths: string[] = liveCuts.map(() => "");
    let cancelled = false;

    // カーソル方式ワーカー (useVideoSceneGeneration の runWorker と同型)。
    let cursor = 0;
    const runWorker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= liveCuts.length) return;
        // 投入前に中止要求を確認する。実行中の MCP コールは中断しない
        // (Higgsfield 側の走行中ジョブは完走させる)。
        if (useVideoStory.getState().cancelRequested) {
          cancelled = true;
          return;
        }
        const cut = liveCuts[i];
        useVideoStory.getState().updateCut(cut.cutId, { status: "generating", error: undefined });
        useBatches.getState().applyEvent({ kind: "workerStarted", batchId, idx: cut.order });

        const result = await generateOneCut(cut, settings);
        if ("path" in result) {
          generatedPaths[i] = result.path;
          useVideoStory.getState().updateCut(cut.cutId, {
            status: "done",
            videoPath: result.path,
            error: undefined,
          });
          useBatches.getState().applyEvent({
            kind: "workerCompleted",
            batchId,
            idx: cut.order,
            path: result.path,
          });
          addToActiveProject(result.path, cut.prompt);
        } else {
          useVideoStory.getState().updateCut(cut.cutId, {
            status: "failed",
            error: result.error,
          });
          useBatches.getState().applyEvent({
            kind: "workerFailed",
            batchId,
            idx: cut.order,
            error: result.error,
          });
        }
      }
    };

    const concurrency = Math.min(STORY_CONCURRENCY, liveCuts.length);
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    const finished = useVideoStory.getState().cuts;
    // バッチカードの失敗数は **投入したカット (liveCuts) の範囲**で数える。
    // ゲートで弾いたカットはこのバッチに 1 枠も持っていないので、ここへ足すと
    // 「4枚中5枚失敗」のような嘘の数字になる。欠落は各カットの failed 表示が持つ。
    const liveCutIds = new Set(liveCuts.map((c) => c.cutId));
    const failedCount = finished.filter(
      (c) => liveCutIds.has(c.cutId) && c.status !== "done",
    ).length;
    useBatches.getState().applyEvent({
      kind: "completed",
      batchId,
      generatedPaths,
      failedCount,
      provider: "higgsfield",
    });

    const allDone = finished.every((c) => c.status === "done");
    if (cancelled || !allDone) {
      useVideoStory.getState().setRunStatus("failedPartial");
      return;
    }
    await concatCuts(finished);
  } finally {
    // 正常系はここに来る時点で done / failedPartial / concatFailed のいずれかに
    // 落ちているので、この if は素通りする。実行中のまま抜けたのは例外経路だけ。
    if (isStoryRunBusy(useVideoStory.getState().runStatus)) {
      useVideoStory.getState().setRunStatus("failedPartial");
    }
  }
}

/**
 * 個別再生成中のカット id (Sol指摘・非blocking risk 2026-08-03)。
 *
 * `runStatus` は全体ランのロックなので、個別「このカットを再生成」の二重起動は
 * 弾けない。カットの `status: "generating"` を見るだけでも足りない: それを書くのは
 * `ensureSignedIn()` の await より後なので、認証待ちの数百 ms のあいだの高速二重
 * クリックが両方とも素通りし、同じカットが有料で二重生成される
 * (`tryBeginRun` を await より前に置いたのと同じ理屈)。
 *
 * そこで await より前に、同期的に取れるモジュールローカルのロックを置く。
 */
const retryingCutIds = new Set<string>();

/** 失敗したカット 1 件だけを再生成する (count=1 の新規バッチカードになる)。 */
export async function retryCut(cutId: string): Promise<void> {
  const state = useVideoStory.getState();
  // 全体ランが走っている最中の個別再生成は、同じカットを二重生成しうる。
  if (isStoryRunBusy(state.runStatus)) return;
  const cut = state.cuts.find((c) => c.cutId === cutId);
  if (!cut) return;
  // 認証確認 (await) より前にロックを取る。Set への add/has は同期なので、
  // 同一イベントループ内の二重クリックでも 2 回目は必ず弾かれる。
  if (retryingCutIds.has(cutId)) return;
  retryingCutIds.add(cutId);
  try {
    if (!(await ensureSignedIn())) return;

    // 生成前ゲート (全体ランと同じ理由)。元画像が消えていたら MCP を呼ばずに落とす。
    // 再生成ボタンは失敗カードから何度でも押せるので、ここを塞がないと
    // 押すたびに有料枠を捨てることになる。
    if ((await findMissingSourceCutIds([cut])).has(cutId)) {
      useVideoStory.getState().updateCut(cutId, {
        status: "failed",
        error: MISSING_SOURCE_IMAGE_ERROR,
      });
      useToasts.getState().push({
        kind: "error",
        text: `${MISSING_SOURCE_IMAGE_ERROR}。絵コンテからカットを送り直してください。`,
        ttlMs: 10000,
      });
      return;
    }

    const settings = currentVideoSettings();
    const batchId = `local-story-retry-${newRunId()}`;
    useBatches.getState().startBatch({
      batchId,
      prompt: cut.prompt,
      references: [{ path: cut.imagePath, name: basename(cut.imagePath) }],
      count: 1,
      provider: "higgsfield",
      modelJobSetType: settings.model.jobSetType,
      modelDisplayName: `${settings.model.label} Cut ${cut.order}`,
      mediaType: "video",
    });

    useVideoStory.getState().updateCut(cutId, { status: "generating", error: undefined });
    useBatches.getState().applyEvent({ kind: "workerStarted", batchId, idx: 1 });

    const result = await generateOneCut(cut, settings);
    if ("path" in result) {
      useVideoStory.getState().updateCut(cutId, {
        status: "done",
        videoPath: result.path,
        error: undefined,
      });
      useBatches.getState().applyEvent({
        kind: "completed",
        batchId,
        generatedPaths: [result.path],
        failedCount: 0,
        provider: "higgsfield",
      });
      addToActiveProject(result.path, cut.prompt);
    } else {
      useVideoStory.getState().updateCut(cutId, { status: "failed", error: result.error });
      useBatches.getState().applyEvent({
        kind: "workerFailed",
        batchId,
        idx: 1,
        error: result.error,
      });
      useBatches.getState().applyEvent({
        kind: "completed",
        batchId,
        generatedPaths: [""],
        failedCount: 1,
        provider: "higgsfield",
      });
    }
  } finally {
    // 例外で抜けてもロックを残さない (残すとそのカットが二度と再生成できなくなる)。
    retryingCutIds.delete(cutId);
  }
}

/** 全カット done のとき、結合ステップだけを再実行する。 */
export async function concatOnly(): Promise<void> {
  const cuts = useVideoStory.getState().cuts;
  if (cuts.length === 0) return;
  if (!cuts.every((c) => c.status === "done")) {
    useToasts.getState().push({
      kind: "error",
      text: "すべてのカットが完成してから結合してください。",
      ttlMs: 4000,
    });
    return;
  }
  await concatCuts(cuts);
}
