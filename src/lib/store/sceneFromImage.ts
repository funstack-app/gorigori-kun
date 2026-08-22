/**
 * 画像→3Dシーン再構成の共通ブリッジ (Slice D / bd a6q・2wm)。
 *
 * 3つの入口 (スケッチパッド / ギャラリー右クリック / scene3d のファイル選択) が
 * すべてこの1本を通る。処理は設計書 §2 Slice D-1 の4フェーズ:
 *
 *   ① ブロックアウト正規化 i2i (codex 生成。スキップ可。スケッチ入口では強制ON)
 *   ② ポーズ推定  = 決定論 (MediaPipe。元画像 → ブロックアウト → T字 の連鎖)
 *   ③ 配置解析    = AI (codex vision) → 決定論バリデータ
 *   ④ シーン反映  = 決定論 (useScene3d.applyImageScene)
 *
 * 拘束 (r3 追補):
 *   - 同時1ジョブ。同期 CAS ロック + runId 照合で、連打・別入口同時でも run は1件 (追補2)
 *   - ブロックアウトは 1操作 = 最大1生成。自動リトライに乗せない (追補1)
 *   - ②③のフォールバックは「リトライ」ではなく段の移行。同じことを2回試さない
 *   - ポーズ両段失敗時は T字 clip を**明示的に登録**する (追補3。motion 無し = T字 ではない)
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import { images as imagesIpc, codexVision } from "../ipc";
import { capturePoseFromImage, registerPoseClip } from "../scene3d/imageToPose";
import { parseSceneLayout, type SceneLayoutDraft } from "../scene3d/layoutAnalysis";
import { MIXAMO_BONES, type GeneratedMotionSpec } from "../scene3d/motionGen";
import { BLOCKOUT_PRESET_PROMPT } from "../sketch/presets";
import { useScene3d, type ImageSceneApplyResult } from "./scene3d";
import { useSkillMode } from "./skillMode";
import { useThreads } from "./threads";
import { useToasts } from "./toasts";

/** 進行中フェーズ。UI の進行表示と 1:1 で対応する。 */
export type SceneFromImagePhase = "blockout" | "pose" | "layout" | "apply";

export type SceneFromImageJob = {
  runId: string;
  phase: SceneFromImagePhase;
  startedAt: number;
  /** 入力画像 (元画像)。PIP 表示にも使う */
  sourcePath: string;
  /** ① で生成したブロックアウト画像。スキップ時・失敗時は null */
  blockoutPath: string | null;
  /** ブロックアウトをスキップする指定だったか (UI の説明用) */
  skipBlockout: boolean;
};

/** 完了結果。ダイアログが「何が起きたか」を正直に出すための材料。 */
export type SceneFromImageResult = {
  ok: boolean;
  /** 失敗時のみ。ユーザー向けの日本語 */
  error?: string;
  /** ポーズをどう決めたか。UI が「位置のみ反映」の告知を出す判断に使う */
  poseSource?: "source" | "blockout" | "tpose";
  applied?: ImageSceneApplyResult;
  /** 検証で捨てた・降格した件数 (レイアウト解析由来) */
  dropped?: number;
  demoted?: number;
  /** ① が失敗して元画像で続行した場合に立つ */
  blockoutFailed?: boolean;
};

type SceneFromImageState = {
  job: SceneFromImageJob | null;
  /** 直近の完了結果 (次の run 開始でクリア) */
  result: SceneFromImageResult | null;
  run: (imagePath: string, opts?: { skipBlockout?: boolean }) => Promise<void>;
  /** ダイアログを閉じるとき等に結果表示だけ消す (実行中の job は消さない) */
  clearResult: () => void;
};

/**
 * 生成を伴う排他ジョブの種別。UI が「今なにが走っているか」を告知するために使う。
 * - `sketch-blockout`: スケッチ単独のブロックアウト生成 (Slice A)
 * - `scene-from-image`: 画像→3Dシーン化ジョブ (Slice D)
 */
export type ExclusiveJobKind = "sketch-blockout" | "scene-from-image";

/**
 * 生成を伴う排他ジョブの共通 CAS ロック (r3 追補2)。
 *
 * zustand の set は同期だが、実行本体は async なので「await をまたいだ間に
 * 別入口がジョブを起こす」を state / React ref だけでは止められない。モジュール
 * スコープの変数を同期的に読み書きする CAS にして、勝った1本だけが run を持つ。
 * 解除は必ず try/finally (例外でロックが残ると以降ずっと起動できなくなる)。
 *
 * **Slice A と Slice D は同じこのロックを共有する。** 片方だけを守る別ロックに
 * すると「スケッチのブロックアウト生成中に3Dシーン化が走る」= 生成が同時2本に
 * なり、追補1 (1操作=最大1生成) が入口単位でしか成立しなくなる。
 */
let runLock: { runId: string; kind: ExclusiveJobKind } | null = null;

/**
 * 排他ジョブの取得を試みる。取れたら runId、既に別ジョブが走っていたら null。
 * 呼び出し元は null のときユーザーへ告知し、必ず try/finally で `endExclusiveJob`
 * を呼ぶこと。
 */
export function tryBeginExclusiveJob(kind: ExclusiveJobKind): string | null {
  if (runLock !== null) return null;
  const runId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  runLock = { runId, kind };
  return runId;
}

/** 現在走っている排他ジョブの種別 (走っていなければ null)。告知文の出し分けに使う。 */
export function activeExclusiveJobKind(): ExclusiveJobKind | null {
  return runLock?.kind ?? null;
}

export function endExclusiveJob(runId: string): void {
  // runId 照合: 自分が取ったロックだけを外す (取り違えで他 run を解放しない)。
  if (runLock?.runId === runId) runLock = null;
}

/** 実行中ジョブに応じた告知文 (どちらが走っていても「待って」と正直に出す)。 */
export function exclusiveJobBusyMessage(): string {
  return activeExclusiveJobKind() === "sketch-blockout"
    ? "ブロックアウトを生成中です。完了までお待ちください"
    : "3Dシーン化を実行中です。完了までお待ちください";
}

/** T字 clip に載せるボーン。motionGen の MIXAMO_BONES と同じ語彙。 */
const MIXAMO_TPOSE_BONES = MIXAMO_BONES;

/**
 * Y Bot (Mixamo規格) の T字ポーズ spec (r3 追補3)。
 *
 * Mixamo のレストポーズがそのまま T字 (直立・両腕を真横に水平。motionGen.ts:119
 * の実測コメント) なので、**全ボーンの差分回転ゼロ = T字**になる。
 * bones を空にせず主要ボーンを明示的に 0 で置くのは、buildGeneratedClip が
 * 「spec に出てくるボーンだけ」トラックを作るため — 空だと clip が実質空になり、
 * 前のモーションの残りが見える余地を残す。
 *
 * solveFramesToSpec と同じ形 (rig:"mixamo" / loop:false / moveSpeed:0) に揃える。
 */
export function buildTPoseSpec(name: string): GeneratedMotionSpec {
  const bones: Record<string, [number, number, number]> = {};
  for (const bone of MIXAMO_TPOSE_BONES) bones[bone] = [0, 0, 0];
  return {
    rig: "mixamo",
    name,
    duration: 0.5,
    loop: false,
    moveSpeed: 0,
    keyframes: [
      { time: 0, bones },
      { time: 0.5, bones },
    ],
  };
}

/** ①: ブロックアウト正規化。失敗しても null を返して元画像で続行する (ここで止めない)。 */
async function generateBlockout(sourcePath: string): Promise<string | null> {
  const t = useThreads.getState();
  // r3 追補1: 1操作 = 最大1生成。count:1 は「成果物1枚」でしかないため、
  // maxAttempts:1 でバックエンドの自動リトライ (既定3回) も同時に止める。
  const result = await imagesIpc.generateBatch({
    prompt: BLOCKOUT_PRESET_PROMPT,
    count: 1,
    maxAttempts: 1,
    cwd: t.cwd,
    refImagePaths: [sourcePath],
    model: t.selectedModel,
    effort: t.selectedEffort,
  });
  return result.generatedPaths[0] ?? null;
}

/**
 * ②: ポーズ推定のフォールバック連鎖 (設計書 §1 論点2-4)。
 * 元画像 → ブロックアウト画像 の順に1回ずつ試す。どちらも1回だけ (リトライではない)。
 */
async function resolvePose(
  sourcePath: string,
  blockoutPath: string | null,
): Promise<{ spec: GeneratedMotionSpec; from: "source" | "blockout" } | null> {
  try {
    const spec = await capturePoseFromImage(sourcePath);
    if (spec) return { spec, from: "source" };
  } catch (err) {
    console.warn("sceneFromImage: pose from source failed", err);
  }
  if (blockoutPath) {
    try {
      const spec = await capturePoseFromImage(blockoutPath);
      if (spec) return { spec, from: "blockout" };
    } catch (err) {
      console.warn("sceneFromImage: pose from blockout failed", err);
    }
  }
  return null;
}

/**
 * 入力画像のアスペクト (幅/高さ) を測る。カメラ枠の比率へ反映するため (r3 追補)。
 *
 * 測れなければ null。**推測で埋めない** — null なら既存の比率のまま維持する。
 * ここで失敗してもジョブ全体は止めない (比率は本質でなく、位置・ポーズが本体)。
 */
async function measureSourceAspect(path: string): Promise<number | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(path);
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("画像を読み込めませんでした"));
    });
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return img.naturalWidth / img.naturalHeight;
  } catch (err) {
    console.warn("sceneFromImage: aspect measurement failed", err);
    return null;
  }
}

/**
 * ③: 配置解析。壊れた JSON は**1回だけ**再問い合わせする (設計書 §2 D-1)。
 * それでも読めなければ null (ジョブ失敗)。
 */
async function resolveLayout(imagePath: string): Promise<SceneLayoutDraft | null> {
  const first = await codexVision.analyzeSceneLayout(imagePath);
  const parsed = parseSceneLayout(first);
  if (parsed) return parsed;
  // 再問い合わせは1回まで。2回目も壊れていたら諦める (無限に投げ続けない)。
  const second = await codexVision.analyzeSceneLayout(imagePath);
  return parseSceneLayout(second);
}

export const useSceneFromImage = create<SceneFromImageState>((set) => ({
  job: null,
  result: null,

  clearResult: () => set({ result: null }),

  run: async (imagePath, opts) => {
    const runId = tryBeginExclusiveJob("scene-from-image");
    // 連打・別入口同時起動・Slice A のブロックアウト生成中は、ここで落ちる
    // (生成を伴うジョブは全体で常に1件)。
    if (!runId) {
      useToasts.getState().push({
        kind: "warn",
        text: exclusiveJobBusyMessage(),
        ttlMs: 3000,
      });
      return;
    }

    const skipBlockout = opts?.skipBlockout === true;
    const startedAt = Date.now();
    set({
      job: {
        runId,
        phase: skipBlockout ? "pose" : "blockout",
        startedAt,
        sourcePath: imagePath,
        blockoutPath: null,
        skipBlockout,
      },
      result: null,
    });

    const setPhase = (phase: SceneFromImagePhase, patch?: Partial<SceneFromImageJob>) =>
      set((s) => (s.job && s.job.runId === runId ? { job: { ...s.job, phase, ...patch } } : s));

    const fail = (error: string) => {
      set({ job: null, result: { ok: false, error } });
      useToasts.getState().push({ kind: "error", text: error, ttlMs: 7000 });
    };

    try {
      // ── ① ブロックアウト正規化 ────────────────────────────────
      let blockoutPath: string | null = null;
      let blockoutFailed = false;
      if (!skipBlockout) {
        try {
          blockoutPath = await generateBlockout(imagePath);
        } catch (err) {
          console.error("sceneFromImage: blockout generation failed", err);
        }
        if (!blockoutPath) {
          // 正規化できなくても元画像で続行する (ここで止めるとユーザーの手が完全に止まる)。
          // 起きたことは結果に残して正直に告知する。
          blockoutFailed = true;
        }
      }
      setPhase("pose", { blockoutPath });

      // ── ② ポーズ推定 (決定論・完全ローカル) ──────────────────
      const pose = await resolvePose(imagePath, blockoutPath);

      // ── ③ 配置・カメラ解析 (AI + 決定論バリデータ) ────────────
      setPhase("layout");
      const analyzeTarget = blockoutPath ?? imagePath;
      let draft: SceneLayoutDraft | null = null;
      try {
        draft = await resolveLayout(analyzeTarget);
      } catch (err) {
        console.error("sceneFromImage: layout analysis failed", err);
        fail(`シーンの解析に失敗しました: ${String(err)}`);
        return;
      }
      if (!draft) {
        fail("シーンの解析結果を読み取れませんでした。別の画像で試してください");
        return;
      }

      // ── ④ シーン反映 (決定論) ────────────────────────────────
      setPhase("apply");

      // ポーズ clip の登録。両段失敗時は T字 clip を明示的に作って登録する
      // (r3 追補3: 「motion 無し = T字」は実装と違うため、必ず clip を持たせる)。
      let poseClipId: string | null = null;
      let poseSource: "source" | "blockout" | "tpose" = "tpose";
      if (draft.person) {
        const spec = pose?.spec ?? buildTPoseSpec("ポーズ(未検出・T字)");
        poseSource = pose?.from ?? "tpose";
        try {
          const entry = await registerPoseClip(
            spec,
            useScene3d.getState().registerImportedMotions,
          );
          poseClipId = entry.id;
        } catch (err) {
          // clip 登録の失敗で配置まで捨てない (位置は反映する)。
          console.error("sceneFromImage: pose clip registration failed", err);
          poseClipId = null;
        }
      }

      // カメラ枠の比率は**元画像**に合わせる (ブロックアウトは正規化で比率が変わりうる)。
      const sourceAspect = await measureSourceAspect(imagePath);
      const applied = useScene3d.getState().applyImageScene(draft, poseClipId, sourceAspect);

      // scene3d スキルへ遷移 (追加したカメラのビューは applyImageScene が開いている)。
      // selectedSkillId を先に置くことで、続く enabled=true の同期が正しいスキルIDを見る。
      useSkillMode.getState().setSelectedSkillId("gori-scene-3d");
      useSkillMode.getState().setEnabled(true);

      set({
        job: null,
        result: {
          ok: true,
          poseSource,
          applied,
          dropped: draft.dropped,
          demoted: draft.demoted,
          blockoutFailed,
        },
      });

      // 正直な告知 (黙って劣化しない)。
      const notes: string[] = [];
      if (applied.mode === "append") notes.push("既存のシーンに追加しました");
      if (draft.person && poseSource === "tpose") {
        notes.push("ポーズは読み取れなかったので位置のみ反映しました");
      }
      // 隠れていて読み取れず、自然な立ちポーズで**推定して埋めた**部位の告知。
      // 埋めないとその部位だけTポーズで残るので埋めるが、埋めた事実は隠さない
      // (no-silent-gap-filling: 推測で埋めるなら必ず推定と明示する)
      if (pose?.spec.estimatedParts?.length) {
        notes.push(`${pose.spec.estimatedParts.join("・")}は読み取れなかったので推定しました`);
      }
      if (!draft.person) notes.push("人物は見つかりませんでした");
      if (draft.dropped > 0) notes.push(`${draft.dropped}件は読み取れませんでした`);
      if (draft.demoted > 0) notes.push(`${draft.demoted}件は近似形状にしました`);
      if (blockoutFailed) notes.push("ブロックアウト生成に失敗したため元画像から解析しました");

      useToasts.getState().push({
        kind: draft.person && poseSource === "tpose" ? "warn" : "success",
        text: `3Dシーンに反映しました (物体${applied.objectCount}件)${
          notes.length > 0 ? ` — ${notes.join(" / ")}` : ""
        }`,
        ttlMs: 8000,
      });
    } catch (err) {
      console.error("sceneFromImage: run failed", err);
      fail(`3Dシーン化に失敗しました: ${String(err)}`);
    } finally {
      endExclusiveJob(runId);
    }
  },
}));
