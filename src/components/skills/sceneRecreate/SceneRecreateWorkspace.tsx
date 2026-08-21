import { useEffect, useMemo, useRef, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { PageHelp } from "../../PageHelp";
import { SafeImage } from "../../SafeImage";
import { GenerationGauge } from "../../GenerationGauge";
import { ClapperIcon, FilmIcon } from "../../SkillIcon";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useToasts } from "../../../lib/store/toasts";
import { usePresets, presetKind, type Preset } from "../../../lib/store/presets";
import { composePresetPrompt } from "../../../lib/presets/character";
import { analyzeScene } from "../../../lib/sceneRecreate/analyze";
import { sendShotsToScene3d } from "../../../lib/sceneRecreate/toScene3dCameras";
import {
  MAX_KEYFRAMES,
  MAX_VIDEO_SECONDS,
  extractKeyframes,
} from "../../../lib/sceneRecreate/videoFrameExtract";
import {
  buildRecreateShotPrompt,
} from "../../../lib/sceneRecreate/prompts";
import {
  CAMERA_ANGLE_LABELS,
  CAMERA_WORK_LABELS,
  SHOT_SIZE_LABELS,
  type AnalyzeStatus,
  type Keyframe,
  type RecreateShotPrompt,
  type SceneAnalysis,
} from "../../../lib/sceneRecreate/types";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const VIDEO_EXTS = ["mp4", "mov", "webm"];

let keyframeSeq = 0;
function nextKeyframeId(): string {
  keyframeSeq += 1;
  return `kf-${Date.now()}-${keyframeSeq}`;
}

function fileTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

function formatAnalysisAsMarkdown(
  analysis: SceneAnalysis,
  recreatePrompts: readonly RecreateShotPrompt[],
): string {
  const textOrFallback = (value: string) => value.trim() || "(記述なし)";
  const lines = [
    "# シーン再現 分析結果",
    "",
    "## シーン全体の演出構造",
    "",
    textOrFallback(analysis.overallStructure),
    "",
    "## 180度ルール / 視線誘導",
    "",
    textOrFallback(analysis.continuityAndEyeline),
    "",
    `## ショット割り（${analysis.shots.length}件）`,
  ];

  for (const shot of analysis.shots) {
    lines.push(
      "",
      `### ショット ${shot.shotNumber}`,
      "",
      `- ショットサイズ: ${SHOT_SIZE_LABELS[shot.shotSize]}`,
      `- アングル: ${CAMERA_ANGLE_LABELS[shot.angle]}`,
      `- カメラワーク: ${CAMERA_WORK_LABELS[shot.cameraWork]}`,
      `- 被写体の動き: ${textOrFallback(shot.subjectMotion)}`,
      `- カットの動機: ${textOrFallback(shot.cutMotivation)}`,
      `- 演出意図: ${textOrFallback(shot.directorialIntent)}`,
    );
  }

  lines.push("", "## 再現プロンプト");
  for (const item of recreatePrompts) {
    lines.push(
      "",
      `### ショット ${item.shotNumber}`,
      "",
      "```text",
      item.prompt,
      "```",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * シーン再現 Workspace(映像分析 MVP・スキル一覧v2.1 #8)
 *
 * 参考動画のキーフレーム(時系列順スクショ)を映像文法(ショット割り・カメラワーク・
 * 180度ルール・視線誘導)で分析し、演出意図を言語化して、自分のキャラ・商品で
 * 再現するプロンプトを出力する。
 *
 * MVP の割り切り: codex は動画を直接見られないため「時系列キーフレームを投入する」
 * 方式で成立させる(将来: 自動フレーム抽出)。分析後のショット割りは Scene 3D の
 * カメラ初期配置として書き出せる。
 *
 * SkillWorkspaceRouter が activeUiMode === "sceneRecreate" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function SceneRecreateWorkspace() {
  const openPreview = useImagePreview((s) => s.open);
  const pushToast = useToasts((s) => s.push);

  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [userNote, setUserNote] = useState("");
  const [status, setStatus] = useState<AnalyzeStatus>("idle");
  const [describeDone, setDescribeDone] = useState(0);
  const [analysis, setAnalysis] = useState<SceneAnalysis | null>(null);
  // 2026-07-27: 解析中ゲージ用の開始時刻。本スキルは専用ストアを持たない
  // (解析はこのコンポーネントのローカル state で完結する) ため、
  // 分析開始時に Date.now() をここへ入れる。
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // 動画取り込みの進捗（null = 取り込んでいない）。分析中ゲージとは別軸。
  const [extractMsg, setExtractMsg] = useState<string | null>(null);
  // 動画の選択は Tauri ダイアログ（パスを返す）でなく input[type=file] を使う。
  // ダイアログのパスを readFile するには fs スコープに全ドライブの許可が要り、
  // ユーザーが任意の場所に置いた動画で失敗する。Scene 3D の動画取り込みも
  // 同じ理由で input[type=file] を使っており、そちらは配布実績がある。
  const videoInputRef = useRef<HTMLInputElement>(null);
  const runTokenRef = useRef(0);

  useEffect(
    () => () => {
      runTokenRef.current += 1;
    },
    [],
  );

  const extracting = extractMsg !== null;
  const running = status === "describing" || status === "analyzing" || extracting;
  const allPaths = useMemo(() => keyframes.map((k) => k.path), [keyframes]);

  async function pickKeyframes() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = Array.isArray(r) ? r : [r];
      setKeyframes((prev) => [
        ...prev,
        ...paths.map((path) => ({ id: nextKeyframeId(), path })),
      ]);
      pushToast({
        kind: "success",
        text: `${paths.length} 枚をキーフレームに追加しました。`,
        ttlMs: 2400,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  /**
   * ローカル動画ファイルからキーフレームを自動抽出して列へ合流させる。
   *
   * URL 直接入力は持たない（設計 §2.1: 外部バイナリ同梱が配布ブロッカー）。
   * ユーザーには PageHelp の note で「いったんファイルとして保存してから」と案内する。
   */
  async function importFromVideo(file: File) {
    try {
      setExtractMsg("動画を読み込み中…");
      const runId = `${fileTimestamp()}-${Date.now()}`;
      const result = await extractKeyframes(file, runId, (message) => {
        setExtractMsg(message);
      });

      if (result.keyframes.length === 0) {
        pushToast({
          kind: "error",
          text: "この動画からキーフレームを取り出せませんでした。",
          ttlMs: 5000,
        });
        return;
      }

      setKeyframes((prev) => [
        ...prev,
        ...result.keyframes.map((kf) => ({
          id: nextKeyframeId(),
          path: kf.path,
          timeSec: kf.timeSec,
          shotIndex: kf.shotIndex,
        })),
      ]);
      pushToast({
        kind: "success",
        text: `${result.shotCount} ショットを検出し、${result.keyframes.length} 枚のキーフレームを取り込みました。`,
        ttlMs: 4000,
      });

      // クランプは黙って行わない。何を切ったかを別トーストで明示する
      // （no-silent-gap-filling）。
      const clampNotes: string[] = [];
      if (result.durationClamped) {
        clampNotes.push(
          `動画が ${Math.round(result.durationSec)} 秒あるため、先頭 ${MAX_VIDEO_SECONDS} 秒だけを取り込みました`,
        );
      }
      if (result.frameClamped) {
        clampNotes.push(
          `キーフレームが上限 ${MAX_KEYFRAMES} 枚を超えたため、尺の長いショットを優先して間引きました`,
        );
      }
      if (clampNotes.length > 0) {
        pushToast({ kind: "warn", text: `${clampNotes.join("。")}。`, ttlMs: 7000 });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `動画の取り込みに失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      setExtractMsg(null);
    }
  }

  function removeKeyframe(id: string) {
    setKeyframes((prev) => prev.filter((k) => k.id !== id));
  }

  function moveKeyframe(id: string, dir: -1 | 1) {
    setKeyframes((prev) => {
      const idx = prev.findIndex((k) => k.id === id);
      if (idx < 0) return prev;
      const swap = idx + dir;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  async function runAnalysis() {
    if (keyframes.length === 0) {
      pushToast({ kind: "info", text: "先にキーフレームを投入してください。", ttlMs: 3000 });
      return;
    }
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    const targetKeyframes = [...keyframes];
    const targetNote = userNote;
    setAnalysis(null);
    setDescribeDone(0);
    setStartedAt(Date.now());
    setStatus("describing");
    try {
      const result = await analyzeScene(targetKeyframes, targetNote, {
        onDescribeProgress: (done, total) => {
          if (runTokenRef.current !== runToken) return;
          setDescribeDone(done);
          if (done === total) setStatus("analyzing");
        },
        onDescribePartialFailure: (failed, total) => {
          if (runTokenRef.current !== runToken) return;
          pushToast({
            kind: "warn",
            text: `${failed}/${total}枚の解析に失敗しました。成功した画像だけで続けます。`,
            ttlMs: 5000,
          });
        },
      });
      if (runTokenRef.current !== runToken) return;
      setAnalysis(result);
      setStatus("done");
      pushToast({
        kind: "success",
        text: `${result.shots.length} ショットに分析しました。`,
        ttlMs: 3000,
      });
    } catch (err) {
      if (runTokenRef.current !== runToken) return;
      setStatus("error");
      pushToast({
        kind: "error",
        text: `分析に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左: 入力 */}
        <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#242424] bg-[#141414] px-4 py-4">
          <PageHelp
            what="気になった映像のスクショを数枚渡すと、構図・光・被写体の置き方を読み解いて言葉にし、自分のキャラや商品で同じ画作りをするための指示文を出します。"
            first="まずは下から、真似したい場面のスクショを時系列の順に数枚選んでください。動画ファイルがあれば「動画から取り込む」で自動的に切り出せます。"
            note="YouTube等のURLは直接読み込めません。いったん動画ファイルとしてPCに保存してから「動画から取り込む」を使ってください。"
          />

          <input
            ref={videoInputRef}
            type="file"
            accept={VIDEO_EXTS.map((ext) => `.${ext}`).join(",")}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // 同じファイルを続けて選び直せるよう value を空にする。
              e.target.value = "";
              if (file) void importFromVideo(file);
            }}
          />

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
                キーフレーム({keyframes.length})
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  disabled={running}
                  className="rounded-md border border-[#343434] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                >
                  ＋ 動画から取り込む
                </button>
                <button
                  type="button"
                  onClick={() => void pickKeyframes()}
                  disabled={running}
                  className="rounded-md border border-[#343434] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                >
                  ＋ 画像を追加
                </button>
              </div>
            </div>

            {extractMsg && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-pink-400/30 bg-[#1a1214] px-3 py-2">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                <span className="text-[11px] font-bold text-pink-200">{extractMsg}</span>
              </div>
            )}

            {keyframes.length === 0 ? (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500">
                <ClapperIcon className="h-6 w-6" />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => videoInputRef.current?.click()}
                    disabled={running}
                    className="rounded-md bg-pink-500 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-pink-400 disabled:opacity-40"
                  >
                    動画から取り込む
                  </button>
                  <button
                    type="button"
                    onClick={() => void pickKeyframes()}
                    disabled={running}
                    className="rounded-md border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                  >
                    画像を選ぶ
                  </button>
                </div>
              </div>
            ) : (
              <ul className="space-y-2">
                {keyframes.map((kf, i) => (
                  <li
                    key={kf.id}
                    className="flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-1.5"
                  >
                    <span className="w-5 shrink-0 text-center text-[11px] font-black text-pink-300">
                      {i + 1}
                    </span>
                    <SafeImage
                      path={kf.path}
                      alt={`キーフレーム${i + 1}`}
                      className="h-12 w-16 shrink-0 cursor-pointer rounded object-cover"
                      onClick={() => openPreview(kf.path, allPaths)}
                    />
                    {/* 時刻バッジは動画取り込み由来のみ。手動投入では時刻が
                        存在しないので出さない（推測で埋めない）。 */}
                    {kf.timeSec !== undefined && (
                      <span className="shrink-0 rounded bg-[#1f1f1f] px-1.5 py-0.5 font-mono text-[10px] font-bold text-neutral-400">
                        t={kf.timeSec.toFixed(1)}s
                      </span>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveKeyframe(kf.id, -1)}
                        disabled={i === 0 || running}
                        className="rounded border border-[#343434] px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-white disabled:opacity-30"
                        aria-label="上へ"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveKeyframe(kf.id, 1)}
                        disabled={i === keyframes.length - 1 || running}
                        className="rounded border border-[#343434] px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-white disabled:opacity-30"
                        aria-label="下へ"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeKeyframe(kf.id)}
                        disabled={running}
                        className="rounded border border-[#343434] px-1.5 py-0.5 text-[11px] font-black text-neutral-500 hover:text-white disabled:opacity-30"
                        aria-label="削除"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
              参考動画の補足(任意)
            </div>
            <textarea
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder="参考URL / 何が良いと感じたか(例: カメラの寄りとテンポが好き)"
              rows={4}
              className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={running || keyframes.length === 0}
            className={`mt-auto flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-black transition ${
              running || keyframes.length === 0
                ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                : "bg-pink-500 text-white hover:bg-pink-400"
            }`}
          >
            {running && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
            )}
            {extracting
              ? "動画を取り込み中…"
              : status === "describing"
                ? `フレーム解析中… (${describeDone}/${keyframes.length})`
                : status === "analyzing"
                  ? "ショット割りを分析中…"
                  : "映像文法で分析する"}
          </button>
        </aside>

        {/* 右: 結果 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {analysis ? (
            <AnalysisResult analysis={analysis} canSendToScene3d={status === "done"} />
          ) : status === "describing" || status === "analyzing" ? (
            /*
              2026-07-27: 解析中の待ち表示を、通常の画像生成と同じ
              「ぐるぐる + 進捗ゲージ」に揃えた (STΛCK 要望)。
              以前は右ペインが説明文のままで、ボタンの小さなスピナーしか
              動いておらず、待っている間に進んでいるのか固まったのか
              分からなかった。
            */
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
              <span className="text-[12px] font-bold text-pink-300">
                {status === "describing"
                  ? `フレーム解析中… (${describeDone}/${keyframes.length})`
                  : "ショット割りを分析中…"}
              </span>
              {startedAt ? (
                <div className="w-full max-w-xs">
                  <GenerationGauge startedAt={startedAt} mode="batch" />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-500">
              <FilmIcon className="h-9 w-9 text-neutral-500" />
              <p className="text-[13px] font-bold text-neutral-300">
                映像を「読む」ワークスペース
              </p>
              <p className="max-w-sm text-[12px]">
                キーフレームを投入して分析すると、ショットごとのカメラワーク・
                カットの動機・演出意図を言語化し、あなたのキャラで再現する
                プロンプトを出します。
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 分析結果 + 再現出力
// ─────────────────────────────────────────────────────────────────────────────

function AnalysisResult({
  analysis,
  canSendToScene3d,
}: {
  analysis: SceneAnalysis;
  canSendToScene3d: boolean;
}) {
  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* 全体の演出構造 */}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#161616] p-4">
        <h3 className="mb-2 text-[12px] font-black text-pink-300">
          シーン全体の演出構造
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-200">
          {analysis.overallStructure || "(記述なし)"}
        </p>
        {analysis.continuityAndEyeline && (
          <div className="mt-3 border-t border-[#242424] pt-3">
            <div className="mb-1 text-[11px] font-black uppercase tracking-wider text-neutral-500">
              180度ルール / 視線誘導
            </div>
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-300">
              {analysis.continuityAndEyeline}
            </p>
          </div>
        )}
      </div>

      {/* ショット別カード */}
      <div>
        <h3 className="mb-2 text-[12px] font-black text-neutral-300">
          ショット割り({analysis.shots.length})
        </h3>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {analysis.shots.map((shot) => (
            <div
              key={shot.shotNumber}
              className="rounded-xl border border-[#2a2a2a] bg-[#141414] p-3.5"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-pink-500 text-[11px] font-black text-white">
                  {shot.shotNumber}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <Chip>{SHOT_SIZE_LABELS[shot.shotSize]}</Chip>
                  <Chip>{CAMERA_ANGLE_LABELS[shot.angle]}</Chip>
                  <Chip>{CAMERA_WORK_LABELS[shot.cameraWork]}</Chip>
                </div>
              </div>
              <Field label="被写体の動き" value={shot.subjectMotion} />
              <Field label="カットの動機" value={shot.cutMotivation} />
              <Field label="演出意図" value={shot.directorialIntent} />
            </div>
          ))}
        </div>
      </div>

      {/* 再現出力 */}
      <RecreatePanel analysis={analysis} canSendToScene3d={canSendToScene3d} />
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[#1f1f1f] px-2 py-0.5 text-[10px] font-bold text-neutral-300 ring-1 ring-[#2a2a2a]">
      {children}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="mt-1.5">
      <span className="text-[10px] font-black uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <p className="text-[12px] leading-relaxed text-neutral-200">{value}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 「自分のキャラで再現」
// ─────────────────────────────────────────────────────────────────────────────

function RecreatePanel({
  analysis,
  canSendToScene3d,
}: {
  analysis: SceneAnalysis;
  canSendToScene3d: boolean;
}) {
  const pushToast = useToasts((s) => s.push);
  const presets = usePresets((s) => s.presets);
  const characterPresets = useMemo(
    () => presets.filter((p) => presetKind(p) === "character"),
    [presets],
  );
  const [selectedId, setSelectedId] = useState<string>("");

  const selected: Preset | undefined = useMemo(
    () => characterPresets.find((p) => p.id === selectedId),
    [characterPresets, selectedId],
  );

  const subjectPrompt = selected ? composePresetPrompt(selected, " / ") : "";

  const recreatePrompts: RecreateShotPrompt[] = useMemo(
    () =>
      analysis.shots.map((shot) => ({
        shotNumber: shot.shotNumber,
        shotSizeLabel: SHOT_SIZE_LABELS[shot.shotSize],
        cameraLabel: CAMERA_WORK_LABELS[shot.cameraWork],
        prompt: buildRecreateShotPrompt({ shot, subjectPrompt }),
      })),
    [analysis.shots, subjectPrompt],
  );

  async function saveAnalysis() {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({
        defaultPath: `scene-analysis-${fileTimestamp()}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!destination) return;

      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(
        destination,
        formatAnalysisAsMarkdown(analysis, recreatePrompts),
      );
      pushToast({
        kind: "success",
        text: "分析結果をファイルに保存しました。",
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#161616] p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-black text-pink-300">
          自分のキャラで再現
        </h3>
        <button
          type="button"
          onClick={() => void saveAnalysis()}
          className="shrink-0 rounded-md border border-[#343434] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          結果をファイルに保存
        </button>
      </div>
      <p className="mb-3 text-[11px] text-neutral-500">
        キャラ型プリセットを選ぶと、上のショット割りをそのまま再現する
        プロンプトをショットごとに生成します。
      </p>

      <div className="mb-3">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[13px] text-neutral-200 focus:border-pink-400/60 focus:outline-none"
        >
          <option value="">被写体プリセットを選ぶ(任意)</option>
          {characterPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {characterPresets.length === 0 && (
          <p className="mt-1 text-[10px] text-neutral-600">
            キャラ型プリセットがまだありません。未選択でも汎用の再現プロンプトを出せます。
          </p>
        )}
      </div>

      <div className="space-y-2">
        {recreatePrompts.map((rp) => (
          <RecreatePromptRow key={rp.shotNumber} item={rp} />
        ))}
      </div>

      {canSendToScene3d && analysis.shots.length > 0 && (
        <div className="mt-4 rounded-lg border border-pink-400/30 bg-[#0d0d0d] px-3 py-3">
          <button
            type="button"
            onClick={() => void sendShotsToScene3d(analysis.shots)}
            className="w-full rounded-lg bg-pink-500 px-3 py-2 text-[12px] font-black text-white hover:bg-pink-400"
          >
            ショット割りを 3D カメラとして書き出す
          </button>
          <p className="mt-2 text-[11px] text-neutral-500">
            配置は目安です。Scene 3D 側で調整できます
          </p>
        </div>
      )}
    </div>
  );
}

function RecreatePromptRow({ item }: { item: RecreateShotPrompt }) {
  const pushToast = useToasts((s) => s.push);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      pushToast({ kind: "success", text: "コピーしました。", ttlMs: 1800 });
    } catch {
      pushToast({ kind: "error", text: "コピーに失敗しました。", ttlMs: 2500 });
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#0d0d0d]">
      <div className="flex items-center justify-between border-b border-[#242424] bg-[#141414] px-3 py-1.5">
        <span className="text-[11px] font-black text-neutral-300">
          ショット {item.shotNumber}
          <span className="ml-2 font-medium text-neutral-500">
            {item.shotSizeLabel} / {item.cameraLabel}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-md border border-[#343434] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          コピー
        </button>
      </div>
      <pre className="m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-100">
        {item.prompt}
      </pre>
    </div>
  );
}
