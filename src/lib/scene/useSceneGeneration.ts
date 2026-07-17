import { useCallback, useMemo, useState } from "react";
import { buildPrompt } from "./buildPrompt";
import {
  generateFromScene,
  type SceneGenerationCount,
  type SceneGenerationResult,
} from "./generate";
import { classifyFailures } from "./retryClassify";
import type { SceneState } from "./types";
import { useActiveProject } from "../store/activeProject";
import { useAuth } from "../store/auth";
import { useBatches } from "../store/batches";
import { useComposer } from "../store/composer";
import { useProjects } from "../store/projects";
import { useHiggsfieldModel } from "../store/higgsfieldModel";
import { useMagnificModel } from "../store/magnificModel";
import { getMagnificModelName } from "../magnific/models";
import { useSceneStore } from "../store/scene";
import { useScenePromptOverride } from "../store/scenePrompt";
import { useSessions } from "../store/sessions";
import { useThreads } from "../store/threads";
import { useToasts } from "../store/toasts";

export type SceneGenerationStatus =
  | { kind: "idle" }
  | { kind: "running"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export type UseSceneGenerationReturn = {
  scene: SceneState;
  generatedPrompt: string;
  refImagePaths: string[];
  count: SceneGenerationCount;
  setCount: (value: SceneGenerationCount) => void;
  promptOverride: string | null;
  setPromptOverride: (value: string | null) => void;
  effectivePrompt: string;
  status: SceneGenerationStatus;
  hasRunningBatch: boolean;
  runningBatchCount: number;
  maxConcurrentBatches: number;
  isQueueFull: boolean;
  activeBatchSummary: string | null;
  disabled: boolean;
  generate: (
    opts?: { countOverride?: SceneGenerationCount },
  ) => Promise<SceneGenerationResult | null>;
};

const MAX_CONCURRENT_BATCHES = 3;
// FB#18 (2026-06-06): 一時的失敗を自動リトライする最大試行回数。
// 1 回目 + 自動リトライ 2 回 = 計 3 回。恒久的失敗 (NSFW/クレジット不足等) は
// classifyFailures が検出してリトライせず即停止する。
const MAX_EXTERNAL_PROVIDER_ATTEMPTS = 3;

/** 全件失敗だったか (1 枚も生成できなかった)。 */
function isTotalFailure(result: SceneGenerationResult): boolean {
  // Magnific 比較生成では generatedPaths に「失敗枠の空文字」が混じる
  // (モデル index 対応を保つため。generate.ts 参照)。空文字は成功に数えない。
  return result.generatedPaths.filter(Boolean).length === 0;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function useSceneSnapshot(): SceneState {
  const subjectFraming = useSceneStore((state) => state.subjectFraming);
  const lightingMood = useSceneStore((state) => state.lightingMood);
  const camera = useSceneStore((state) => state.camera);
  const style = useSceneStore((state) => state.style);
  const reference = useSceneStore((state) => state.reference);

  return useMemo(
    () => ({
      subjectFraming,
      lightingMood,
      camera,
      style,
      reference,
    }),
    [subjectFraming, lightingMood, camera, style, reference],
  );
}

export function useSceneGeneration(): UseSceneGenerationReturn {
  const scene = useSceneSnapshot();
  const generatedPrompt = useMemo(() => buildPrompt(scene), [scene]);
  // 参照画像は scene.reference（旧 §05 セクション）ではなく
  // useComposer.references（プロンプト欄上のラック）から取る。
  // §05 セクションは UI から廃止済み（Magnific 仕様に統一）。
  const composerReferences = useComposer((s) => s.references);
  const refImagePaths = useMemo(
    () => composerReferences.map((r) => r.path),
    [composerReferences],
  );

  const allBatches = useBatches((state) => state.batches);
  const runningBatches = useMemo(
    () => allBatches.filter((batch) => batch.status === "running"),
    [allBatches],
  );

  const selectedModel = useThreads((state) => state.selectedModel);
  const selectedEffort = useThreads((state) => state.selectedEffort);
  const cwd = useThreads((state) => state.cwd);
  const [count, setCount] = useState<SceneGenerationCount>(4);
  const selectedHiggsfieldModels = useHiggsfieldModel((state) => state.selectedModels);
  // Magnific オプショナル拡張 (2026-06-08)。選択中なら codex/higgsfield より優先する。
  // 配列対応(2026-06-08): 1件=単一生成、2件以上=比較生成。
  const selectedMagnificModels = useMagnificModel((state) => state.selectedModels);
  const magnificActive = selectedMagnificModels.length > 0;
  const magnificCompare = selectedMagnificModels.length >= 2;
  const selectedHiggsfield = useMemo(() => {
    const first = selectedHiggsfieldModels[0];
    if (!first) return null;
    return {
      jobSetType: first.jobSetType,
      displayName: first.displayName,
    };
  }, [selectedHiggsfieldModels]);
  const compareMode = selectedHiggsfieldModels.length >= 2;
  // Magnific選択時は枚数をモデル数に合わせる(比較生成)。単一なら通常のcount。
  const generationCount = magnificCompare
    ? selectedMagnificModels.length
    : compareMode
      ? selectedHiggsfieldModels.length
      : count;

  // promptOverride はグローバルストア (useScenePromptOverride) を使う。
  // 企画タブの「採用」ボタンから外部 set できるようにするため、useState から
  // Zustand に昇格させた。
  const promptOverride = useScenePromptOverride((s) => s.value);
  const setPromptOverride = useScenePromptOverride((s) => s.set);
  const [status, setStatus] = useState<SceneGenerationStatus>({ kind: "idle" });
  // generating: disabled 判定からは外したが、generate() 内で多重実行ガードに
  // 引き続き使う (preflight 直後に二重呼びされた場合の保護)。
  // 型エラー抑制のため _generating で受ける (未参照警告を黙らせる)。
  const [_generating, setGenerating] = useState(false);
  void _generating;

  const effectivePrompt =
    promptOverride !== null ? promptOverride : generatedPrompt;

  const runningBatchCount = runningBatches.length;
  const hasRunningBatch = runningBatchCount > 0;
  const isQueueFull = runningBatchCount >= MAX_CONCURRENT_BATCHES;
  // STΛCK 報告 (2026-05-17 v0.6.11): 生成ボタンを押すと画面がちらつく問題。
  // 原因: ローカル `generating` ステートと `runningBatches`(notification 経由)
  // が時間差で更新され、ボタンが disabled→enabled→disabled と細かく
  // 切り替わってレイアウト再計算が走っていた。
  // 修正: disabled 判定をキュー満杯チェックのみに変える。
  // generating 状態自体は status メッセージ等で引き続き使うが、
  // disabled 判定からは外して入力UIのちらつきを止める。
  const disabled = isQueueFull;

  const activeBatchSummary = useMemo(() => {
    const active = runningBatches[0];
    if (!active) return null;
    const completed = active.workers.filter(
      (worker) => worker.status === "completed",
    ).length;
    return `${completed}/${active.count}`;
  }, [runningBatches]);

  const generate = useCallback(async (
    opts?: { countOverride?: SceneGenerationCount },
  ): Promise<SceneGenerationResult | null> => {
    const prompt = effectivePrompt.trim();
    if (!prompt) {
      setStatus({ kind: "error", message: "プロンプトが空です" });
      return null;
    }
    // DEV-PLAYBOOK §6 B: 失敗ワーカーの「再生成」は countOverride=1 で 1 枚だけ
    // 投入する。比較モード (各モデル 1 枚で index 対応を保つ) では枚数を変えられない
    // ため、呼び出し側で単一生成時のみ countOverride を渡す。
    const effectiveCount: SceneGenerationCount =
      opts?.countOverride ?? generationCount;

    // STΛCK 報告 (2026-05-17 v0.6.7): 認証未完了で生成すると
    // 「アスペクト比エラー」と誤表示されて原因特定に30分かかった。
    // 生成開始前に Codex 認証を再チェックし、未認証なら明確な
    // メッセージで toast 表示して止める。
    const authState = useAuth.getState();
    // 最新の認証状態を取り直す（OAuth完了直後の refresh 遅延対策）
    // silent: 生成前の認証確認で AuthGate の Splash 差し替え(白フラッシュ)を
    // 起こさないため loading を立てない (Bug修正 2026-05-28)。
    await authState.refresh({ silent: true });
    if (!useAuth.getState().account) {
      const message =
        "ChatGPT にログインしていないため、生成できません。\n" +
        "左下の「ログイン」ボタンから ChatGPT にログインしてください。";
      setStatus({ kind: "error", message });
      useToasts.getState().push({
        kind: "error",
        text: message,
        ttlMs: 0,
      });
      return null;
    }

    setGenerating(true);
    setStatus({ kind: "running", message: "生成を開始しています..." });

    // ユーザーの生成意図は 1 回だけ DB へ記録する (リトライで重複させない)。
    // dbTurnId は後段(Magnific等のライブイベントを流さない経路)で生成画像を
    // history.db に手動 recordImage するためにも使うので、関数スコープで保持する。
    let batchDbTurnId: string | null = null;
    try {
      const sess = useSessions.getState();
      const dbTurnId = await sess.recordTurn({
        sessionId: sess.activeSessionId ?? "",
        prompt,
        model: selectedModel,
        effort: selectedEffort,
        provider: magnificActive
          ? "magnific"
          : selectedHiggsfield
            ? "higgsfield"
            : "codex",
        modelJobSetType: compareMode ? undefined : selectedHiggsfield?.jobSetType,
        modelDisplayName: magnificActive
          ? magnificCompare
            ? `${selectedMagnificModels.length} models compared`
            : getMagnificModelName(selectedMagnificModels[0])
          : compareMode
            ? `${selectedHiggsfieldModels.length} models compared`
            : (selectedHiggsfield?.displayName ?? "image_gen"),
        refImagePaths,
        count: effectiveCount,
        kind: "batch",
      });
      if (dbTurnId) {
        batchDbTurnId = dbTurnId;
        sess.enqueueBatchDbTurnId(dbTurnId);
      }
    } catch (recordError) {
      // turn 記録に失敗しても生成自体は続行する (履歴に残らないだけ)。
      console.error("[useSceneGeneration] recordTurn failed:", recordError);
    }

    // 1 回の生成試行を実行する。startBatch (楽観的カード) → generateFromScene。
    // 戻り値は SceneGenerationResult。IPC が reject した場合は呼び出し側へ throw する。
    const runOneAttempt = async (): Promise<{
      result: SceneGenerationResult;
      tempId: string;
    }> => {
      const tempId = `local-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      useBatches.getState().startBatch({
        batchId: tempId,
        prompt,
        references: refImagePaths.map((path) => ({
          path,
          name: basename(path),
        })),
        count: effectiveCount,
        provider: magnificActive
          ? "magnific"
          : selectedHiggsfield
            ? "higgsfield"
            : "codex",
        modelJobSetType: compareMode ? undefined : selectedHiggsfield?.jobSetType,
        modelDisplayName: magnificActive
          ? magnificCompare
            ? `${selectedMagnificModels.length} models compared`
            : getMagnificModelName(selectedMagnificModels[0])
          : compareMode
            ? undefined
            : (selectedHiggsfield?.displayName ?? "image_gen"),
        compareMode: compareMode || magnificCompare,
        // 比較生成時、各画像下にモデル名を出す(Higgsと同じ。STΛCK要望 2026-06-08)。
        // Magnific比較時は各Magnificモデル名を {jobSetType, displayName} 形に詰める。
        workerModels: magnificCompare
          ? selectedMagnificModels.map((id) => ({
              jobSetType: id,
              displayName: getMagnificModelName(id),
            }))
          : compareMode
            ? selectedHiggsfieldModels
            : undefined,
      });
      try {
        const result = await generateFromScene(scene, {
          count: effectiveCount,
          cwd,
          model: selectedModel,
          effort: selectedEffort,
          promptOverride: prompt,
          refImagePaths,
          maskPaths: refImagePaths.map(() => ""),
          // Magnific が選ばれていたら最優先 (higgsfield/codex は使わない)。
          // 1件=単一生成、2件以上=比較生成。
          magnific:
            magnificActive && !magnificCompare
              ? { model: selectedMagnificModels[0] }
              : undefined,
          magnificModels: magnificCompare ? selectedMagnificModels : undefined,
          higgsfield:
            magnificActive || compareMode
              ? undefined
              : (selectedHiggsfield ?? undefined),
          higgsfieldModels:
            magnificActive || !compareMode
              ? undefined
              : selectedHiggsfieldModels,
        });
        // Magnific と Higgsfield(MCP移行後) は同期的に結果が返る(コアのような生成中
        // イベントが無い)ため、完了を手動で applyEvent して生成カードを埋める。これが無いと
        // カードが「生成中」のまま固まる(2026-06-08 Magnific実機バグ / 2026-06-10 Higgsfield
        // MCP移行で CLI のライブイベントが無くなり同型になった)。
        const syncProvider = magnificActive
          ? ("magnific" as const)
          : selectedHiggsfield || compareMode
            ? ("higgsfield" as const)
            : null;
        if (syncProvider) {
          useBatches.getState().applyEvent({
            kind: "completed",
            batchId: tempId,
            generatedPaths: result.generatedPaths,
            failedCount: result.failedCount,
            provider: syncProvider,
          });
          // 同期 provider(Magnific / MCP移行後の Higgsfield)はフロントで completed を
          // 手動発火するだけで、コアのような workerCompleted イベントが流れない。
          // そのため App.tsx の workerCompleted→activeProject 自動追加(addItem)経路を通らず、
          // プロジェクト選択中は完了した瞬間にタイムラインのフィルタ
          // (GenerationWorkspace の projectImagePaths.has(path))で除外されて
          // カードが消えていた(2026-06-08 実機バグ。ライブラリには残るのに
          // タイムラインから消える)。ここで手動で activeProject に追加して
          // 他 provider と挙動を揃える。
          const activeProjectId = useActiveProject.getState().activeProjectId;
          if (activeProjectId) {
            for (const path of result.generatedPaths) {
              if (!path) continue; // 失敗枠の空文字はスキップ
              useProjects.getState().addItem(activeProjectId, {
                imagePath: path,
                prompt,
              });
            }
          }
          // 同期 provider(Magnific / MCP移行後の Higgsfield)は workerCompleted イベントを
          // 流さないため、App.tsx の workerCompleted→recordImage 経路を通らない。その結果
          // history.db の turn に生成画像が紐づかず、「過去の生成」で展開しても「画像はまだ
          // 記録されていません」になる(2026-06-08 実機バグ)。ここで手動で
          // recordImage して、コア(Codex)と同じく過去の生成に画像が残るようにする。
          if (batchDbTurnId) {
            const sess = useSessions.getState();
            for (const path of result.generatedPaths) {
              if (!path) continue; // 失敗枠の空文字はスキップ
              void sess.recordImage({
                turnId: batchDbTurnId,
                path,
                mtimeMs: Date.now(),
                size: 0,
                kind: "created",
              });
            }
          }
        }
        return { result, tempId };
      } catch (error) {
        // この試行の楽観的カードを除去してから throw する (再試行時に残骸を残さない)。
        useBatches.getState().removeBatch(tempId);
        throw error;
      }
    };

    // 全件失敗時のユーザー向けメッセージ (恒久的失敗の理由があれば併記)。
    const totalFailureMessage = (permanentReasons: string[]): string => {
      if (permanentReasons.length > 0) {
        return (
          `画像生成に失敗しました（${effectiveCount}件すべて失敗）。\n` +
          `理由:\n${permanentReasons.map((r) => `・${r}`).join("\n")}`
        );
      }
      // 理由が1件も取れなかったとき。原因を断定しない (2026-06-07 修正)。
      //
      // 旧文言は「多くの場合アスペクト比が原因」と断定していたが、これは誤り。
      // 実際の失敗理由(NSFW/認証切れ/タイムアウト/image_gen未呼び出し等)は
      // Rust(batch_gen.rs)が errors を返すようになり permanentReasons に載るので、
      // ここに来る=「理由が本当に取れなかった」ケースのみ。断定すると誤誘導になる。
      return (
        `画像生成に失敗しました（${effectiveCount}件すべて失敗）。\n` +
        `自動リトライしても改善しませんでした。原因を特定できませんでした。\n` +
        `次を順に確認してください:\n` +
        `・少し時間をおいて再試行する（一時的な混雑のことがあります）\n` +
        `・プロンプトを短く・シンプルにしてみる\n` +
        `・ログイン状態や接続（ChatGPT / Higgsfield）を見直す\n` +
        `・アスペクト比を 16:9 / 1:1 / 9:16 に変えてみる`
      );
    };

    setGenerating(false);

    let lastResult: SceneGenerationResult | null = null;
    let lastError: unknown = null;
    // Codex は Rust 側で画像ごとに最大 3 回試行するため、フロントでは再試行しない。
    // 外部 provider は従来どおりフロントで最大 3 回試行する。
    const maxAttempts =
      magnificActive || selectedHiggsfield || compareMode
        ? MAX_EXTERNAL_PROVIDER_ATTEMPTS
        : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt === 1) {
        setStatus({ kind: "running", message: "生成中..." });
      } else {
        // 例: 「再試行中 (2/3)...」。ConstructedPromptPanel は running の message を表示する。
        setStatus({
          kind: "running",
          message: `失敗したため再試行中 (${attempt}/${maxAttempts})...`,
        });
      }

      try {
        const { result } = await runOneAttempt();
        lastResult = result;
        lastError = null;

        // Magnific 比較生成は generatedPaths に失敗枠の空文字が混じるため、
        // 空文字を除いた実数で成功枚数を数える(嘘の枚数を出さない)。
        const okCount = result.generatedPaths.filter(Boolean).length;

        // 1 枚でも生成できた = 部分成功以上。リトライせず結果を返す。
        if (!isTotalFailure(result)) {
          setStatus({
            kind: result.failedCount === 0 ? "success" : "error",
            message:
              result.failedCount === 0
                ? `${okCount}枚を生成しました`
                : `${okCount}/${effectiveCount}枚を生成しました（${result.failedCount}件失敗）`,
          });
          return result;
        }

        // 全件失敗。一時的失敗ならリトライ、恒久的失敗 (NSFW等) なら即停止。
        const decision = classifyFailures(result.errors, true);
        const canRetryAgain = attempt < maxAttempts;

        if (decision.shouldRetry && canRetryAgain) {
          // 一時的失敗 → 次のループで再試行する。
          continue;
        }

        // 恒久的失敗のみ、またはリトライ上限に達した → エラー確定。
        const message = totalFailureMessage(decision.permanentReasons);
        setStatus({ kind: "error", message });
        useToasts.getState().push({
          kind: "error",
          text: message,
          ttlMs: 0, // 手動で閉じるまで残す
        });
        return result;
      } catch (error) {
        // IPC reject (ネットワーク/プロセス起動失敗等) は一時的失敗とみなしリトライ。
        lastError = error;
        console.error(
          `[useSceneGeneration] generate attempt ${attempt} threw:`,
          error,
        );
        if (attempt < maxAttempts) {
          continue;
        }
      }
    }

    // ここに来るのは「全試行で throw した」場合のみ。
    // (全件失敗の result ケースはループ内で return 済み)
    if (lastError !== null) {
      const errorMessage = String(lastError);
      const message = `画像生成に失敗しました: ${errorMessage}`;
      setStatus({ kind: "error", message });
      // STΛCK 報告 (2026-05-17): toast でも明示通知して原因認識を促す。
      useToasts.getState().push({
        kind: "error",
        text: `生成に失敗しました（自動リトライも失敗）\n${errorMessage}`,
        ttlMs: 12000,
      });
      return null;
    }

    return lastResult;
  }, [
    effectivePrompt,
    refImagePaths,
    count,
    scene,
    cwd,
    selectedModel,
    selectedEffort,
    selectedHiggsfield,
    selectedHiggsfieldModels,
    selectedMagnificModels,
    magnificActive,
    magnificCompare,
    compareMode,
    generationCount,
  ]);

  return {
    scene,
    generatedPrompt,
    refImagePaths,
    count,
    setCount,
    promptOverride,
    setPromptOverride,
    effectivePrompt,
    status,
    hasRunningBatch,
    runningBatchCount,
    maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
    isQueueFull,
    activeBatchSummary,
    disabled,
    generate,
  };
}
