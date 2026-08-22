/**
 * LINEスタンプ制作 Workspace（設計書 v3 §6.3 / S8）。
 *
 * ## 工程（設計書 §6.3 の①〜⑦をそのまま画面にしたもの）
 *
 * ```
 * ① 素材を選ぶ    登録キャラ / 手持ち画像
 * ② 枚数と内容    8 / 16(既定) / 24 / 32 / 40 ＋ 中身の方向4種
 * ③ 生成          k / N の通し番号で進捗（波の概念は出さない）
 * ④ 採否 ★必須    N枚を一覧で並べる。ここを飛ばす導線は作らない
 * ⑤ 個別に直す    気になる1枚だけ塗って再生成（任意）
 * ⑥ 検査          層A(画像規格・決定論) / 層B(審査セルフチェック・AI)
 * ⑦ 出口          [このまま使う] / [申請用に書き出す]
 * ```
 *
 * ## 流れは1本、出口だけ2択（STΛCK決定1）
 *
 * 冒頭で「自分用か申請用か」を聞かない。**同じ手順で作り、最後の書き出しだけ分岐する**。
 * 作り始めた時点では、その人が申請するかどうか本人にも決まっていないことが多い。
 * モード選択を前に出すと、決まっていない判断を先に強制することになる。
 *
 * ## なぜ characterSheetRun ストアに相乗りしないか
 *
 * 表情差分は `useCharacterSheetRun` を使うが、あのストアの `jobMode` は
 * `"character" | "expression"` の閉じた union で、`enterMode` は**自分と違う mode の
 * ジョブを台帳から外す**。3つ目の mode を足すと、キャラ登録・表情差分の
 * 入退場の挙動まで変わる（S8 の書き込み許可外であり、既存2スキルの回帰リスクを負う）。
 *
 * ここは生成の粒度が違う（最大40枚・2波直列）ので、**この画面のローカル状態**で持ち、
 * イベントは `onCharacterSheetEvent` を runId で絞って直接購読する。
 * 生成の同時実行制御は `gen_queue.rs` の既存セマフォに乗るので、
 * **sticker 側で独自の並列制御は作らない**（設計書 §1.2 末尾）。
 *
 * ## 波の概念をUIに出さない（設計書 §1.2）
 *
 * 32/40枚は `MAX_SHEET_CUTS`(30) を超えるため2バッチへ分けるが、**波は生成の都合であって
 * 工程ではない**。進捗は常に通し番号「k / N枚」で見せ、「波1」「波2」とは書かない。
 * 波をまたぐロールバックを作らないので、状態管理は単純なまま
 * （各カットは独立。失敗は「足りない分だけ再生成」で回収する）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { GenerationGauge } from "../../GenerationGauge";
import { PageHelp } from "../../PageHelp";
import { SafeImage } from "../../SafeImage";
import { CharacterIcon } from "../../SkillIcon";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { onCharacterSheetEvent } from "../../../lib/character/events";
import type { CharacterSheetParams, SheetCutSpec } from "../../../lib/character/types";
import { humanizeError } from "../../../lib/humanizeError";
import {
  sticker as stickerIpc,
  type StickerChromaSample,
  type StickerIssue,
} from "../../../lib/ipc";
import {
  DEFAULT_STICKER_TONE,
  pickEntries,
  STICKER_CATALOGS,
  type StickerEntry,
  type StickerToneId,
} from "../../../lib/sticker/catalog";
import {
  formatReviewAsText,
  reviewStickerSet,
  type StickerReviewReport,
} from "../../../lib/sticker/check";
import { formatStickerError, REVIEW_GUIDELINE_URL } from "../../../lib/sticker/reviewRules";
import { cutOutBackground, type CutoutOutcome } from "../../../lib/sticker/cutout";
import {
  inspectWithProgress,
  type InspectProgress,
} from "../../../lib/sticker/inspectProgress";
import {
  buildStickerPrompt,
  DEFAULT_PROMPT_STYLE,
} from "../../../lib/sticker/promptStyles";
import {
  DEFAULT_STICKER_COUNT,
  isValidStickerCount,
  NORMAL_STICKER_SPEC,
  splitIntoBatches,
  STICKER_COUNTS,
  type StickerCount,
} from "../../../lib/sticker/spec";
import { applyStickerTextToFile } from "../../../lib/sticker/text";
import {
  pickExportFolderName,
  joinExportPath,
} from "../../../lib/sticker/exportDir";
import { usePresets, presetKind, type Preset } from "../../../lib/store/presets";
import { useToasts } from "../../../lib/store/toasts";
import { StickerPickPanel, type StickerPickItem } from "./StickerPickPanel";
import { StickerReeditModal } from "./StickerReeditModal";
import { StickerTextPanel, defaultStickerTextStyle } from "./StickerTextPanel";

/** 画面の工程。④採否を飛ばす導線は作らない（設計書 §1.6 / K6）。 */
type Phase = "setup" | "generate" | "pick" | "export";

/** 生成中の1カット。 */
type CutState = {
  /** 通し番号（1始まり）。波の概念を出さないので常に通し番号。 */
  index: number;
  entry: StickerEntry;
  status: "pending" | "running" | "cuttingOut" | "completed" | "failed";
  imagePath?: string;
  reason?: string;
};

/** 1バッチ内で、透過処理まで決着したカットと失敗したカットを数える台帳。 */
type WaveProgress = {
  expectedCutIds: Set<string>;
  settledCutIds: Set<string>;
  failedCutIds: Set<string>;
};

type EventSubscriptionStatus = "connecting" | "ready" | "failed";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"];

/** キャラの参照画像を解決する（表情差分と同じ規則）。 */
function resolveCharacterSource(preset: Preset): string | undefined {
  return preset.characterMeta?.sourceImage ?? preset.attachedImages?.[0]?.path;
}

/**
 * フォルダ直下の名前一覧（L6 の連番回避に使う）。
 *
 * 読めなければ**空集合**を返す。ここで失敗しても書き出しは続けるべきで、
 * 最悪の結果は「同じ分に2回書き出したとき同名フォルダになる」だけ。その場合も
 * `sticker_export` の既存の重複検査が書く前に止めるので、黙って上書きはされない。
 */
async function listDirNames(dir: string): Promise<Set<string>> {
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    return new Set((await readDir(dir)).map((e) => e.name));
  } catch {
    return new Set();
  }
}

export function StickerWorkspace() {
  return (
    <section
      data-tour="sticker-workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]"
    >
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>
      <StickerBody />
    </section>
  );
}

function StickerBody() {
  const pushToast = useToasts((s) => s.push);
  const presets = usePresets((s) => s.presets);
  const characters = useMemo(
    () => presets.filter((p) => presetKind(p) === "character"),
    [presets],
  );

  // ① 素材
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [attributes, setAttributes] = useState<string>("");

  // ② 枚数と内容
  const [count, setCount] = useState<StickerCount>(DEFAULT_STICKER_COUNT);
  const [tone, setTone] = useState<StickerToneId>(DEFAULT_STICKER_TONE);

  // ③④ 生成・採否
  const [phase, setPhase] = useState<Phase>("setup");
  const [cuts, setCuts] = useState<CutState[]>([]);
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set());
  const [running, setRunning] = useState(false);
  const [eventSubscriptionStatus, setEventSubscriptionStatus] =
    useState<EventSubscriptionStatus>("connecting");
  /**
   * 生成を開始した時刻。`GenerationGauge` に渡す。
   *
   * スタンプは実測 k/N を渡すのでゲージの幅計算には使われないが、
   * 他スキルと同じ props で呼ぶために持つ（将来 progress を外しても壊れない）。
   */
  const [generationStartedAt, setGenerationStartedAt] = useState(() => Date.now());
  /**
   * 直前に書き出したファイル（申請モードなら ZIP、それ以外は1枚目の画像）。
   * 「保存先を開く」で Finder / エクスプローラーを開くために持つ。
   */
  const [exportedDir, setExportedDir] = useState<string | null>(null);
  const [reeditTarget, setReeditTarget] = useState<StickerPickItem | null>(null);

  /**
   * ⑤ 文字入れ（L1 / 2026-08-05 STΛCK実機FB「文字を入れたい」）。
   *
   * 入力中の文字は index で持つ（パスで持つと、個別再生成で差し替わった瞬間に
   * 入力が迷子になる）。焼き込みは押したときにまとめて行う。
   */
  const [texts, setTexts] = useState<Readonly<Record<number, string>>>({});
  const [textStyle, setTextStyle] = useState(() => defaultStickerTextStyle());
  const [applyingText, setApplyingText] = useState(false);
  /**
   * 文字を焼く前の元画像（index → パス）。
   *
   * **焼き直しは必ずここから行う**。文字入り画像へさらに焼くと前の文字が残って
   * 重なる（`text.ts` の `renderStickerText` が記録している呼び出し側の責務）。
   * 「後から直せる」という要件は、この控えを持つことでしか満たせない。
   */
  const textBaseRef = useRef<Map<number, string>>(new Map());

  // ⑥ 検査
  const [inspectIssues, setInspectIssues] = useState<
    { path: string; issues: StickerIssue[] }[] | null
  >(null);
  const [setIssues, setSetIssues] = useState<StickerIssue[]>([]);
  const [inspecting, setInspecting] = useState(false);
  /**
   * 確認中の進捗（実測 k/N・I3）。確認していない間は `null`。
   *
   * STΛCK実機FB「確認中にゲージが出ない」（2026-08-05）。生成中（工程③）には
   * `GenerationGauge` があるのに、確認（層A）の実行中だけ「確認中…」の文字しか
   * 出ておらず、押したあと何も動いていないように見えていた。
   *
   * 検査は**枚数が分かっている**ので、生成と同じく実測を渡せる（推定にしない）。
   */
  const [inspectProgress, setInspectProgress] = useState<InspectProgress | null>(null);
  /** 確認を始めた時刻。`GenerationGauge` に渡す（実測を渡すので幅計算には使われない）。 */
  const [inspectStartedAt, setInspectStartedAt] = useState(() => Date.now());
  const [review, setReview] = useState<StickerReviewReport | null>(null);
  const [reviewing, setReviewing] = useState(false);
  /**
   * 層Bが実際に検査した対象（B3）。何を見て何を見ていないかを画面に出すために持つ。
   * 「検査しました」だけだと、tab を除いたことが利用者に伝わらない。
   */
  const [reviewTargets, setReviewTargets] = useState<{
    paths: string[];
    excludedTab: string | null;
  } | null>(null);
  /**
   * メイン画像（240×240）／タブ画像（96×74）に使う1枚。`null` なら採用済みの1枚目。
   *
   * 常に1枚目固定だと「看板にしたい絵」を選べない（Sol 指摘の未遵守項目）。
   */
  const [mainPath, setMainPath] = useState<string | null>(null);

  // 生成中の run を追う。イベントは runId で絞る（他スキルの run が混ざらない）。
  const runIdsRef = useRef<Set<string>>(new Set());
  /**
   * 波の完了待ち（B4）。`character_sheet_run` は `tokio::spawn` して**即座に** runId を
   * 返すので、`await invoke()` は「起動できた」までしか待たない。そのまま次の波を
   * 投げると32/40枚が一斉に走り、直列2波にならない（設計書 §1.2 の前提が崩れる）。
   *
   * 生成イベントと、その後の `cutOut` の両方が決着した時点を完了とするため、
   * runId ごとに resolver を置いてカット単位の台帳から解決する。
   * **失敗しても解決する**（1枚も完成しなくても次の波は投げる。波をまたぐ
   * ロールバックは作らない設計なので、止めると残りが永久に来ない）。
   */
  const waveWaitersRef = useRef<Map<string, () => void>>(new Map());
  /** 全カットの生成・透過処理の決着で待ちを解けるよう、runごとに数える。 */
  const waveProgressRef = useRef<Map<string, WaveProgress>>(new Map());
  /**
   * クロマキーで抜いたときの統計（抜いた結果のパス → 統計）。
   *
   * 縁の品質（`fringe` / `edge-aliased`）は**抜いた瞬間にしか測れない**。
   * 層Aの `inspect_rgba` は抜きの統計を引数で受け取る設計だが、**本番の呼び出しが
   * 両方とも `None` を渡しており、縁の検査が実運用で一度も動いていなかった**（A5）。
   *
   * 測った側（ここ）が覚えておき、点検・書き出しの両方へ**同じ材料**として渡す。
   * 同じ材料を渡すのは「確認画面では出た警告が書き出しでは消える」を作らないため。
   *
   * 個別編集で差し替わったパスには、`adoptReedit` が**その差し替えで測り直した統計**を
   * 登録する（前の絵の統計は引き継がない。測っていない画像の縁の品質を語らない）。
   */
  const chromaStatsRef = useRef<Map<string, StickerChromaSample>>(new Map());
  /** 抜いた時点で「縁のにじみが多い」と判定された画像（点検画面に並べて出す用）。 */
  const fringeWarnPathsRef = useRef<Set<string>>(new Set());
  /**
   * どの経路で背景を抜いたか（I2）。パス → `"ai" | "chroma" | "none"`。
   *
   * 「抜けなかった」の説明文が経路で変わる。クロマキー経路なら「緑が抜けなかった」
   * だが、AI経路が落ちてクロマキーも駄目だったなら「どちらでも抜けなかった」。
   * 経路を覚えていないと、片方の説明を全部に当てることになる（測っていない
   * 経路の話をしない）。
   */
  const cutoutMethodRef = useRef<Map<string, "ai" | "chroma" | "none">>(new Map());
  /**
   * 「緑が1画素も抜けなかった」画像（R5）。採否一覧のバッジで可視化する。
   *
   * `cleared === 0` は救済（元画像で先へ進める）するが、**黙って進めない**。
   * 設計原則 第5条は「失敗させるより、救済して可視化する」であって、
   * 救済だけでは半分しか満たさない。規格としての判定は層Aの
   * `chroma-not-cleared` が行い、ここは採否の段階で気づけるようにするだけ。
   */
  const [notClearedPaths, setNotClearedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 「生成枠の連打ガード」。既存スキルと同じ同期 CAS（setState の非同期を待たない）。
  const startingRef = useRef(false);

  const entries = useMemo(() => pickEntries(tone, count), [tone, count]);
  // カタログが枚数に足りない場合、**黙って埋めない**（欠落は可視化する）。
  const shortfall = count - entries.length;

  /**
   * 生成直後のカットの背景を抜く（設計書 §1.4 / §9 J4 / S2）。
   *
   * ## 既定はAI抜き、クロマキーは保険（I2 / 2026-08-05 J4発動）
   *
   * STΛCK実機FB「切り抜きにばらつきがある」を受けて、設計書 §9 J4 に用意されていた
   * 分岐を引いた。**Mac=Vision / Windows通常版=BiRefNet が既定**で、
   * 互換版（`edit-ai` 無効ビルド）と失敗時だけクロマキーへ落ちる。
   * 経路の実装は `cutout.ts`（個別再生成と共有する。同じ経路には同じ関所）。
   *
   * **抜けなかった場合も元のパスを返して先へ進める**。理由は2つ:
   *
   * 1. ここで止めると、抜けなかった1枚のせいでそのカットが採否リストから
   *    消える。**欠落を欠落のまま可視化する**なら、絵は見せて「透過されていない」
   *    という判定は層A（`no-alpha` / `chroma-not-cleared`）に任せるのが筋
   *    （判断を2箇所に置かない）
   * 2. 抜きは何度でもやり直せる。元の緑背景が残っていれば復帰できる
   *
   * ## 統計はクロマキー経路のときだけ登録する（R2 の維持 + I2）
   *
   * `cleared === 0` でも統計を登録するのは R2 の修正どおり（「抜きを試みて 0 だった」
   * という事実を層Aへ運ぶ）。ただし**AI抜き経路では統計を作らない** —
   * クロマキーを通していないのだから `cleared` も `fringe` も存在しない。
   * 偽の統計を置くと、層Aの縁の検査が測っていない値で動く（測ったふりをしない）。
   */
  const cutOut = useCallback(
    async (imagePath: string): Promise<string> => {
      const outcome = await cutOutBackground(imagePath);

      // 抜きの統計は**クロマキー経路にしか存在しない**（A5 / I2）。
      // 縁の品質は抜いた瞬間にしか測れないので、測った側が覚えておいて
      // 点検・書き出しの両方へ同じ材料として渡す。
      if (outcome.chroma) {
        chromaStatsRef.current.set(outcome.path, {
          path: outcome.path,
          cleared: outcome.chroma.cleared,
          semiTransparent: outcome.chroma.semiTransparent,
          opaque: outcome.chroma.opaque,
          despilled: outcome.chroma.despilled,
        });
        // 縁の品質は抜けた画像に対してだけ語れる（`chroma.fringeWarn` は
        // `cleared === 0` のとき常に false になっている）。
        if (outcome.chroma.fringeWarn) fringeWarnPathsRef.current.add(outcome.path);
      }

      // どの経路で抜いたかを覚えておく（採否画面のバッジの文言を出し分ける）。
      cutoutMethodRef.current.set(outcome.path, outcome.method);

      if (outcome.notCleared) {
        // 救済した事実を画面へ出す（R5）。黙って進めない。
        setNotClearedPaths((prev) => {
          const next = new Set(prev);
          next.add(outcome.path);
          return next;
        });
      }
      return outcome.path;
    },
    [],
  );

  // ── イベント購読。自分が投げた run のカットだけを反映する ──
  //
  // ## なぜ `visible` に連動させないか（F1 / 2026-08-05）
  //
  // 旧実装は `if (!visible) return;` で購読を張っていた。だが `visible`
  // （`useSkillVisible`）は「ライブラリ/設定 drawer を開いた」「他スキルへ切り替えた」
  // 「生成タブ以外を開いた」で false になる。生成中に画面を離れるだけで購読が外れ、
  // `cutCompleted` / `completed` を取りこぼす。取りこぼすと採否リストに画像が載らず、
  // 波待ち（`waveWaitersRef`）も cleanup で強制解放されるので**生成ループが崩れる**。
  //
  // S2 の mount-pool 化（`SkillWorkspaceRouter`）で、この Workspace は非アクティブでも
  // unmount されず `display:none` で残り続ける。つまり購読を可視性へ結ぶ理由が無い。
  // 重い RAF 描画ループ（scene3d）と違い、ここはイベントを受けて setState するだけなので
  // 裏で回り続けても負荷にならない。**マウントしている間は常駐**させる。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    /** 待ちを1回だけ解放し、失敗があれば件数を必ず知らせる。 */
    const releaseWave = (runId: string) => {
      const resolve = waveWaitersRef.current.get(runId);
      if (!resolve) return;

      const progress = waveProgressRef.current.get(runId);
      waveWaitersRef.current.delete(runId);
      waveProgressRef.current.delete(runId);
      if (progress && progress.failedCutIds.size > 0) {
        pushToast({
          kind: "error",
          text: `${progress.failedCutIds.size}枚の生成に失敗しました。もう一度お試しください`,
          ttlMs: 6000,
        });
      }
      resolve();
    };

    /** 透過成功・処理失敗を数え、全カットが決着したら次へ進める。 */
    const settleWaveCut = (runId: string, cutId: string, failed: boolean) => {
      const progress = waveProgressRef.current.get(runId);
      if (!progress) return;

      if (progress.expectedCutIds.has(cutId)) {
        progress.settledCutIds.add(cutId);
        if (failed) progress.failedCutIds.add(cutId);
      } else if (failed) {
        // validate_params などのrun全体エラーは、個別cutIdへ対応しない場合がある。
        // その場合はこのバッチ全体を失敗として決着させ、永久待ちを防ぐ。
        for (const expectedCutId of progress.expectedCutIds) {
          progress.settledCutIds.add(expectedCutId);
          progress.failedCutIds.add(expectedCutId);
        }
      }

      if (progress.settledCutIds.size >= progress.expectedCutIds.size) {
        releaseWave(runId);
      }
    };

    const handleEvent: Parameters<typeof onCharacterSheetEvent>[0] = (event) => {
      if (!runIdsRef.current.has(event.runId)) return;
      if (event.kind === "cutStarted") {
        setCuts((prev) =>
          prev.map((c) =>
            c.entry.id === event.cutId ? { ...c, status: "running" } : c,
          ),
        );
      } else if (event.kind === "cutCompleted") {
        // 生成物は**まだ緑背景**。透過に抜いてから採否リストへ載せる（設計書 §1.4）。
        // 抜かずに出すと層Aの `no-alpha` が全枚数をブロックし、1枚も完走しない。
        const cutId = event.cutId;
        setCuts((prev) =>
          prev.map((c) =>
            c.entry.id === cutId ? { ...c, status: "cuttingOut" } : c,
          ),
        );
        void cutOut(event.imagePath)
          .then((cutPath) => {
            setCuts((prev) =>
              prev.map((c) =>
                c.entry.id === cutId
                  ? { ...c, status: "completed", imagePath: cutPath }
                  : c,
              ),
            );
            // W24: 波待ちは、生成画像が届いた時点ではなく透過処理の決着後に進める。
            settleWaveCut(event.runId, cutId, false);
          })
          .catch((err) => {
            const reason = humanizeError(err);
            setCuts((prev) =>
              prev.map((c) =>
                c.entry.id === cutId
                  ? { ...c, status: "failed", reason: `背景の切り抜き失敗: ${reason}` }
                  : c,
              ),
            );
            // 透過失敗も決着として数え、失敗時に波が永久待ちになる防御は維持する。
            settleWaveCut(event.runId, cutId, true);
            pushToast({
              kind: "error",
              text: `背景の切り抜きに失敗しました。理由: ${reason}。この1枚をもう一度お試しください。`,
              ttlMs: 6000,
            });
          });
      } else if (event.kind === "cutFailed") {
        const progress = waveProgressRef.current.get(event.runId);
        const failedCutIds =
          progress && !progress.expectedCutIds.has(event.cutId)
            ? progress.expectedCutIds
            : new Set([event.cutId]);
        setCuts((prev) =>
          prev.map((c) =>
            failedCutIds.has(c.entry.id)
              ? { ...c, status: "failed", reason: event.reason }
              : c,
          ),
        );
        settleWaveCut(event.runId, event.cutId, true);
      } else if (event.kind === "completed") {
        // 生成側の完了通知だけでは、非同期の透過処理はまだ終わっていない。
        // 次の波は各カットの settleWaveCut がすべて揃った時だけ解放する。
        return;
      }
    };

    const subscribeWithRetry = async () => {
      let lastError: unknown = null;
      // 初回 + 自動リトライ1回。2回とも失敗した時だけ生成を止めて案内する。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const fn = await onCharacterSheetEvent(handleEvent);
          if (cancelled) {
            fn();
            return;
          }
          unlisten = fn;
          setEventSubscriptionStatus("ready");
          return;
        } catch (err) {
          lastError = err;
        }
      }

      if (cancelled) return;
      setEventSubscriptionStatus("failed");
      // 生エラーを直に連結しない（B4）。
      pushToast({
        kind: "error",
        text: `進捗を受け取れない状態です。アプリを再起動してください。（詳しい内容: ${humanizeError(lastError)}）`,
        ttlMs: 6000,
      });
    };

    void subscribeWithRetry();

    return () => {
      cancelled = true;
      unlisten?.();
      // 購読が外れると completed を受け取れない。待っている波を解放しないと
      // 生成ループが永久に止まり、連打ガードも解除されない（押せないまま固まる）。
      //
      // この cleanup は**アンマウント時にだけ**走る（`visible` を依存から外したため）。
      // 画面切替では走らないので、生成中に離席しても波は解放されず、戻ってくれば
      // 続きがそのまま反映される。
      const waiters = waveWaitersRef.current;
      for (const resolve of waiters.values()) resolve();
      waiters.clear();
      waveProgressRef.current.clear();
    };
  }, [pushToast, cutOut]);

  const doneCount = cuts.filter((c) => c.status === "completed").length;

  /** 採否リストに出せる完成カット（工程④の材料）。 */
  const pickItems: StickerPickItem[] = useMemo(
    () =>
      cuts
        .filter((c) => c.status === "completed" && c.imagePath)
        .map((c) => ({
          index: c.index,
          imagePath: c.imagePath as string,
          label: c.entry.label,
        })),
    [cuts],
  );

  const keptIndexes = useMemo(
    () => new Set(pickItems.map((i) => i.index).filter((i) => !dropped.has(i))),
    [pickItems, dropped],
  );

  const keptPaths = useMemo(
    () => pickItems.filter((i) => keptIndexes.has(i.index)).map((i) => i.imagePath),
    [pickItems, keptIndexes],
  );

  /** 素材を手持ち画像から選ぶ。 */
  async function pickLocalImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r || typeof r !== "string") return;
      setSourceImage(r);
      setSourceLabel(r.split(/[\\/]/).pop() ?? "手持ち画像");
      setAttributes("");
    } catch (err) {
      // 生エラーを直に連結しない（B4）。
      pushToast({
        kind: "error",
        text: `画像を選べませんでした。もう一度お試しください。（詳しい内容: ${humanizeError(err)}）`,
        ttlMs: 5000,
      });
    }
  }

  /**
   * ③ 生成。指定枚数を `STICKER_BATCH_MAX_CUTS` 以下のバッチへ割り、**直列で**投げる。
   *
   * 直列にするのは、波をまたぐ状態管理を作らないため（設計書 §1.2）。
   * カットは独立しているので、途中で失敗しても成功分はそのまま採否リストに乗る。
   */
  const startGeneration = useCallback(
    async (targets: StickerEntry[], startIndex: number) => {
      if (eventSubscriptionStatus !== "ready") {
        pushToast({
          kind: eventSubscriptionStatus === "failed" ? "error" : "info",
          text:
            eventSubscriptionStatus === "failed"
              ? "進捗を受け取れない状態です。アプリを再起動してください"
              : "進捗の受信を準備しています。少し待ってからお試しください。",
          ttlMs: 5000,
        });
        return;
      }
      if (!sourceImage) {
        pushToast({ kind: "info", text: "先に素材を選んでください。", ttlMs: 3000 });
        return;
      }
      if (targets.length === 0) return;
      // 連打ガード。setState は非同期なので ref で同期的に取る。
      if (startingRef.current) return;
      startingRef.current = true;
      setRunning(true);

      try {
        const batches = splitIntoBatches(targets.length);
        let offset = 0;
        for (const size of batches) {
          const slice = targets.slice(offset, offset + size);
          offset += size;

          const runId = crypto.randomUUID();
          runIdsRef.current.add(runId);

          const cutSpecs: SheetCutSpec[] = slice.map((entry) => ({
            cutId: entry.id,
            role: entry.role,
            // プロンプトの書き味は差し替え可能なデータとして持つ（設計書 §1.7）。
            // 文言はすべて promptStyles.ts の中だけに存在する。
            //
            // 属性（`attributes`）はここに混ぜない（C1 / 2026-08-05）。下の
            // `params.attributes` として渡せば Rust 側 `build_sheet_prompt` の
            // 「不変の見た目 (全カット共通で厳守)」行に載る。両方に入れると
            // 同じ文字列が1回のプロンプトに2箇所現れる（詳細は promptStyles.ts）。
            promptFragment: buildStickerPrompt(DEFAULT_PROMPT_STYLE, {
              promptFragment: entry.promptFragment,
              // 参照支配句を足す条件（I4 / 2026-08-05 STΛCK実機FB
              // 「アニメっぽくなる枚がある」）。素材画像は必ず参照として渡って
              // いる（下の `params.characterImage`）ので、ここは常に true になる。
              // 真偽で渡すのは、参照が無い経路が将来できたときに黙って
              // 「参照に一致させろ」と書き続けないため。
              hasReference: Boolean(sourceImage),
            }),
          }));

          const params: CharacterSheetParams = {
            characterImage: sourceImage,
            attributes,
            aspectRatio: "1:1",
            cutSpecs,
            runId,
            // 白キャラ問題の解（設計書 §1.4）。背景を先に緑へ固定してから
            // 決定論のクロマキーで抜く。前景が純白でも抜ける。
            sheetBackground: "green",
          };

          // この波の完了を待つ約束を**投げる前に**置く。invoke より後だと、
          // 短い波が completed を先に出したときに取りこぼす（待ちが永久に解けない）。
          const finished = new Promise<void>((resolve) => {
            waveWaitersRef.current.set(runId, resolve);
          });
          waveProgressRef.current.set(runId, {
            expectedCutIds: new Set(slice.map((entry) => entry.id)),
            settledCutIds: new Set(),
            failedCutIds: new Set(),
          });

          try {
            await invoke<string>("character_sheet_run", { params });
          } catch (err) {
            // 起動に失敗した波の待ちは自分で外す（誰も completed を出さないため）。
            waveWaitersRef.current.delete(runId);
            waveProgressRef.current.delete(runId);
            throw err;
          }

          // `await invoke()` は「起動できた」までしか待たない（Rust 側は
          // tokio::spawn して即 return する）。生成だけでなく、全カットの透過処理が
          // 決着するまで待ち、第2波を早く走らせない（W24）。
          await finished;
        }
        pushToast({
          kind: "success",
          text: `${targets.length} 枚の生成と透過処理が終わりました。`,
          ttlMs: 3000,
        });
      } catch (err) {
        // 起動できなかった対象も失敗として決着させ、全体待ちと再試行導線を止めない。
        const targetIds = new Set(targets.map((entry) => entry.id));
        setCuts((prev) =>
          prev.map((cut) =>
            targetIds.has(cut.entry.id) &&
            (cut.status === "pending" || cut.status === "running")
              ? { ...cut, status: "failed", reason: "生成を始められませんでした" }
              : cut,
          ),
        );
        pushToast({
          kind: "error",
          text: formatStickerError(
            "生成を始められませんでした。",
            err,
            "少し待ってから、もう一度お試しください。",
            { dataSafe: "できあがっている分はそのまま残っています。" },
          ),
          ttlMs: 6000,
        });
      } finally {
        // 連打ガードは**生成と透過処理の完了まで**効かせる（invoke が返るまでではない）。
        // ここが finally なので、失敗しても必ず解除される（押せないまま固まらない）。
        startingRef.current = false;
        setRunning(false);
      }
      void startIndex;
    },
    [sourceImage, attributes, pushToast, eventSubscriptionStatus],
  );

  /** ② → ③。生成対象を確定して投入する。 */
  async function runAll() {
    if (entries.length === 0) return;
    setCuts(
      entries.map((entry, i) => ({
        index: i + 1,
        entry,
        status: "pending" as const,
      })),
    );
    setDropped(new Set());
    setInspectIssues(null);
    setReview(null);
    setGenerationStartedAt(Date.now());
    setPhase("generate");
    await startGeneration(entries, 1);
  }

  /** ④ 「使わない N枚を作り直す」。失敗したカットIDだけを再投入する。 */
  async function regenerate(indexes: number[]) {
    const targets = cuts.filter((c) => indexes.includes(c.index));
    if (targets.length === 0) return;
    setCuts((prev) =>
      prev.map((c) =>
        indexes.includes(c.index)
          ? { ...c, status: "pending", imagePath: undefined, reason: undefined }
          : c,
      ),
    );
    setDropped((prev) => {
      const next = new Set(prev);
      for (const i of indexes) next.delete(i);
      return next;
    });
    await startGeneration(
      targets.map((c) => c.entry),
      targets[0]?.index ?? 1,
    );
  }

  /**
   * ⑤ 個別編集の採用。差し替え後のパスを正本にする。
   *
   * ## クロマキーはここではなく合成の前で通す（A1・2026-08-05 移設）
   *
   * 個別編集のプロンプトは緑背景を要求する（`reedit.ts`）ので、生成物には緑が入る。
   * 合成はマスクの内側を生成物のまま採るため、抜かずに合成すると塗った範囲に
   * 緑が残る。**抜きは合成の前**（`StickerReeditModal` の
   * `chromaKeyBeforeComposite`）でなければ意味がない — 合成後に抜くと、
   * 既に透過済みの周囲まで巻き込んで無駄な走査をするうえ、
   * 「緑を含んだまま合成された画像」がいったん成立してしまう。
   *
   * ここでは**受け取ったパスをそのまま正本にする**。層Aの規格判定は
   * 点検・書き出しで通るので、判断を2箇所に置かない。
   *
   * ## 抜きの統計は捨てず、測り直した値を登録する（R2 / 2026-08-05 修正）
   *
   * 旧実装は `chromaStatsRef.current.delete(newImagePath)` だけを呼んでいた。
   * 「前の絵の統計を引き継がない」という意図は正しいが、**新しく測った統計も
   * 登録されない**ため、個別再生成で差し替えた1枚だけが層Aの材料を失っていた
   * （本流の `cutOut` は登録している）。同じ経路には同じ材料を流す。
   *
   * 渡ってくる `cutout` は、この差し替えで実際に抜いたときの結果
   * （`StickerReeditModal` の `cutOutBeforeComposite` の戻り）。
   * 前の絵の値ではないので、引き継ぎにはならない。
   *
   * AI抜き経路では `cutout.chroma === null`。**そのときは統計を登録しない**
   * （I2。クロマキーを通していないので `cleared` も `fringe` も存在しない）。
   * 前の絵の統計が残ると「測っていない画像の縁の品質を語る」ことになるので、
   * その場合は明示的に削除する。
   */
  const adoptReedit = useCallback(
    (index: number, newImagePath: string, cutout: CutoutOutcome) => {
      // 差し替えたら検査結果は古くなる。黙って残さない。
      setInspectIssues(null);
      setReview(null);

      if (cutout.chroma) {
        // 今回測った統計を、差し替え後のパスに紐づけて登録する。
        chromaStatsRef.current.set(newImagePath, {
          path: newImagePath,
          cleared: cutout.chroma.cleared,
          semiTransparent: cutout.chroma.semiTransparent,
          opaque: cutout.chroma.opaque,
          despilled: cutout.chroma.despilled,
        });
        // 縁の品質は抜けた画像に対してだけ語れる（`cutOut` と同じ規則）。
        if (cutout.chroma.fringeWarn) fringeWarnPathsRef.current.add(newImagePath);
        else fringeWarnPathsRef.current.delete(newImagePath);
      } else {
        // AI経路（または全経路失敗）。統計は存在しない。前の絵の値を残さない。
        chromaStatsRef.current.delete(newImagePath);
        fringeWarnPathsRef.current.delete(newImagePath);
      }

      cutoutMethodRef.current.set(newImagePath, cutout.method);

      setNotClearedPaths((prev) => {
        if (cutout.notCleared) {
          const next = new Set(prev);
          next.add(newImagePath);
          return next;
        }
        if (!prev.has(newImagePath)) return prev;
        const next = new Set(prev);
        next.delete(newImagePath);
        return next;
      });

      setCuts((prev) =>
        prev.map((c) => (c.index === index ? { ...c, imagePath: newImagePath } : c)),
      );

      // 個別再生成で絵が変われば、文字の下敷きも新しい絵になる。古い控えを残すと
      // 「差し替えたのに文字を消したら前の絵に戻る」という事故になる。
      textBaseRef.current.delete(index);
    },
    [],
  );

  /**
   * ⑤ 文字入れを実行する（L1）。
   *
   * ## 常に「文字なしの絵」から焼く
   *
   * 文字入り画像へさらに焼くと前の文字が残って重なる。`textBaseRef` に
   * 文字を入れる前のパスを控え、焼き直しのたびにそこから作る。
   * これが「後から直せる」という要件の実体（`text.ts` のコメントと対）。
   *
   * ## 抜きの統計を焼き直し後のパスへ引き継ぐ
   *
   * 文字を焼いた画像は**別ファイル**になるので、層Aへ渡す統計のキー（パス）が変わる。
   * 引き継がないと、文字を入れた瞬間に縁の検査の材料が消える（測ったものを捨てる）。
   * 文字を焼いても背景の透過・縁は変わらない（合成しているのは文字だけ）ので、
   * **同じ統計をそのまま使うのが事実に合う**。
   */
  async function applyTexts() {
    const targets = pickItems.filter(
      (i) => (texts[i.index] ?? "").trim().length > 0,
    );
    if (targets.length === 0) return;

    setApplyingText(true);
    try {
      const results: { index: number; path: string }[] = [];
      const failures: number[] = [];

      for (const item of targets) {
        // 控えが無ければ今のパスが「文字なしの絵」。あるならそれを下敷きにする。
        const base = textBaseRef.current.get(item.index) ?? item.imagePath;
        try {
          const out = await applyStickerTextToFile(base, {
            ...textStyle,
            text: texts[item.index] ?? "",
          });
          textBaseRef.current.set(item.index, base);
          results.push({ index: item.index, path: out });

          // 縁の統計を新しいパスへ引き継ぐ（文字は縁を変えない）。
          const sample = chromaStatsRef.current.get(base);
          if (sample) chromaStatsRef.current.set(out, { ...sample, path: out });
          if (fringeWarnPathsRef.current.has(base)) fringeWarnPathsRef.current.add(out);
          const method = cutoutMethodRef.current.get(base);
          if (method) cutoutMethodRef.current.set(out, method);
        } catch {
          // 1枚失敗しても他は焼く（全部止めない）。失敗は下でまとめて出す。
          failures.push(item.index);
        }
      }

      if (results.length > 0) {
        const byIndex = new Map(results.map((r) => [r.index, r.path]));
        setCuts((prev) =>
          prev.map((c) =>
            byIndex.has(c.index) ? { ...c, imagePath: byIndex.get(c.index) } : c,
          ),
        );
        // 絵が変わったら検査結果は古い。黙って残さない（`adoptReedit` と同じ規則）。
        setInspectIssues(null);
        setReview(null);
      }

      if (failures.length > 0) {
        pushToast({
          kind: "warn",
          text: `${results.length} 枚に文字を入れました。${failures.length} 枚は入れられませんでした。`,
          ttlMs: 7000,
        });
      } else {
        pushToast({
          kind: "success",
          text: `${results.length} 枚に文字を入れました。`,
          ttlMs: 4000,
        });
      }
    } finally {
      setApplyingText(false);
    }
  }

  /**
   * 焼いた文字を取り消して文字なしの絵へ戻す（L1）。
   *
   * 控えているのは**パス**なので、戻すのは参照の付け替えだけ。文字入りファイルは
   * 消さない（消すと戻したあとに「やっぱり戻す」ができない。生成物を失わせない）。
   */
  function resetTexts() {
    const base = textBaseRef.current;
    if (base.size === 0) return;
    setCuts((prev) =>
      prev.map((c) => (base.has(c.index) ? { ...c, imagePath: base.get(c.index) } : c)),
    );
    base.clear();
    setInspectIssues(null);
    setReview(null);
  }

  /**
   * 検査・書き出しへ渡す抜きの統計（A5）。
   *
   * **両方へ同じ配列を渡す**。片方だけに渡すと「確認画面では出た警告が
   * 書き出しでは消える」というズレになる。
   */
  const chromaSamplesFor = useCallback(
    (paths: readonly string[]): StickerChromaSample[] =>
      paths
        .map((p) => chromaStatsRef.current.get(p))
        .filter((s): s is StickerChromaSample => s !== undefined),
    [],
  );

  /**
   * ⑥ 層A: 画像規格チェック（決定論・即座・確実）。
   *
   * ## 進捗を実測で出す（I3 / 2026-08-05 STΛCK実機FB「確認中にゲージが出ない」）
   *
   * 検査は枚数が分かっているので、生成と同じ横ゲージに**実測 k/N** を渡せる。
   * 分割実行とセット判定の扱いは `inspectProgress.ts`（分割の都合が
   * `count-invalid` の判定に化けないよう、セットの所見は全件の1回から採る）。
   */
  async function runInspect(mode: "personal" | "submission") {
    if (keptPaths.length === 0) return;
    setInspecting(true);
    setInspectStartedAt(Date.now());
    setInspectProgress({ done: 0, total: keptPaths.length });
    try {
      const res = await inspectWithProgress(
        keptPaths,
        mode,
        chromaSamplesFor(keptPaths),
        stickerIpc.inspect,
        setInspectProgress,
      );
      setInspectIssues(res.items.map((i) => ({ path: i.path, issues: i.issues })));
      setSetIssues(res.setIssues);
    } catch (err) {
      // 生エラーを直に連結しない（B4）。
      pushToast({
        kind: "error",
        text: `画像規格チェックができませんでした。作った画像はそのまま残っています。もう一度お試しください。（詳しい内容: ${humanizeError(err)}）`,
        ttlMs: 6000,
      });
    } finally {
      setInspecting(false);
      // ゲージは確認が終わったら畳む（残すと「まだ動いている」に見える）。
      setInspectProgress(null);
    }
  }

  /**
   * ⑥ 層B: 審査セルフチェック（AI・参考情報）。
   *
   * ## 何を検査するか（B3）
   *
   * **申請用に書き出した最終PNG**を検査する。編集前の作業画像ではない。
   * 理由: 世に出るのは書き出した物であって、途中の絵ではない。矯正（縮小・余白付与）で
   * 見え方が変わるので、途中の絵を見て「問題なし」と言っても最終物の話にならない。
   *
   * - **main.png を含める** — メイン画像も審査対象（設計書 §1.1）
   * - **tab.png を除く** — 96×74 に潰れた絵に表現の judgment を求めても意味がない。
   *   除いた事実は画面に出す（黙って外さない）
   * - **submission 経路でのみ呼ぶ**（設計書 §1.1 / A6）。自分用に使う人にAI検査の
   *   コストを払わせない。単独ボタンを置くと personal の人も押せてしまうため、
   *   **書き出しの中からしか呼ばない**（呼び出し口を1つにして構造で守る）
   */
  const runReview = useCallback(
    async (finalPaths: string[]) => {
      if (finalPaths.length === 0) return;
      setReviewing(true);
      try {
        setReview(await reviewStickerSet(finalPaths));
      } catch (err) {
        pushToast({
          kind: "error",
          text: formatStickerError(
            "審査セルフチェックができませんでした。",
            err,
            "これはAIの参考情報なので、書き出した画像はそのまま使えます。気になる場合はもう一度書き出してください。",
            { dataSafe: "書き出した画像は残っています。" },
          ),
          ttlMs: 6000,
        });
      } finally {
        setReviewing(false);
      }
    },
    [pushToast],
  );

  /** ⑦ 出口。personal = このまま使う / submission = 申請用に書き出す。 */
  async function runExport(mode: "personal" | "submission") {
    if (keptPaths.length === 0) return;
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title:
          mode === "submission"
            ? "申請用の書き出し先フォルダを選択"
            : "画像の保存先フォルダを選択",
      });
      if (typeof dir !== "string") return;

      // ── L6: 選んだフォルダの直下へバラ撒かず、専用のサブフォルダへ集める ──
      //
      // 2026-08-05 STΛCK実機FB「ZIPが見つからない」。ZIP は作れていたが、
      // 個別PNG 26枚と横並びで置かれてダウンロードフォルダに埋もれていた。
      // 直すのは生成側ではなく**置き場所**（作られていないのではなく見つからない）。
      //
      // personal も同じ扱いにする。「このまま使う」でも枚数分のPNGが出るので、
      // 埋もれる問題は同じ。出口ごとに置き方が違うほうが説明が増える。
      const outputDir = joinExportPath(
        dir,
        pickExportFolderName(new Date(), await listDirNames(dir)),
      );

      // 選んだ絵が採否で外れていたら1枚目へ戻す（使わないと決めた絵を看板にしない）。
      const mainSource =
        mainPath && keptPaths.includes(mainPath) ? mainPath : keptPaths[0];

      const res = await stickerIpc.export({
        paths: keptPaths,
        outputDir,
        mode,
        // メイン/タブに使う1枚は人が選ぶ（既定は1枚目）。選んだ絵が採否で外れていたら
        // 1枚目へ戻す — 使わないと決めた絵を看板にしない。
        mainSource: mainSource,
        tabSource: mainSource,
        // どの書き味で作ったかを控えに残す（あとで追えないと再現できない）。
        promptStyle: DEFAULT_PROMPT_STYLE,
        // 縁の統計は `inspect` と**同じ材料**を渡す（A5）。
        chromaSamples: chromaSamplesFor(keptPaths),
      });

      // 所見は握り潰さない。書き出し後の結果もそのまま画面へ戻す。
      setSetIssues(res.setIssues);
      setInspectIssues(res.items.map((i) => ({ path: i.output, issues: i.issues })));

      // ── A4: personal はブロッカーがあっても止めないが、**成功表示に隠さない** ──
      //
      // `sticker_export` の personal は規格違反でも書き出す設計で、それ自体は正しい
      //（設計原則 第5条「失敗させるより、救済して可視化する」）。だが「書き出しました」
      // だけを出すと、**救済したことも規格違反があることも伝わらない**。可視化が
      // 抜けると第5条は半分しか満たさない（救済のみで可視化なし）。
      //
      // 止める判断は変えず、**件数と次の一手をトーストへ出す**。詳細（どの画像の
      // 何が引っかかったか）は上の `setInspectIssues` で画像規格チェック欄に並ぶ。
      const exportBlockerCount =
        res.items.reduce(
          (sum, item) => sum + item.issues.filter((i) => i.severity === "blocker").length,
          0,
        ) + res.setIssues.filter((i) => i.severity === "blocker").length;

      if (res.failed.length > 0) {
        pushToast({
          kind: "warn",
          text: `${res.items.length} 枚を書き出しました。${res.failed.length} 枚は失敗しています。`,
          ttlMs: 7000,
        });
      } else if (exportBlockerCount > 0) {
        // personal でしか起きない（submission はブロッカーがあれば Rust 側で止まる）。
        pushToast({
          kind: "warn",
          text: `${res.items.length} 枚を書き出しました。ただし画像規格を満たしていない点が ${exportBlockerCount} 件あります（このまま自分で使うぶんには問題ありません）。申請に出すなら、上の「画像規格チェック」の赤い行を直してから「申請用に書き出す」を実行してください。`,
          ttlMs: 10000,
        });
      } else {
        pushToast({
          kind: "success",
          // ZIP を作ったことは伝える。作ったのに気づかれないと、結局
          // 手で ZIP 化する作業が残る（この改修の目的そのものが消える）。
          text: res.zipPath
            ? `${res.items.length} 枚を書き出し、提出用のZIPも作りました。`
            : `${res.items.length} 枚を書き出しました。`,
          ttlMs: 4000,
        });
      }

      // 書き出し先を開けるようにする（他スキルの `revealItemInDir` と同じ流儀）。
      // 出したものの置き場所が分からないと、書き出せても次に進めない。
      //
      // **ZIP を最優先で指す**（L6）。`revealItemInDir` は渡したファイルを
      // **選択状態にして**親フォルダを開くので、ZIP を渡せば申請に出すファイルが
      // 開いた瞬間に反転表示される。フォルダを渡すと中身が並ぶだけで、
      // どれが提出物かは人が探すことになる（実機FBで埋もれた状況の再現）。
      setExportedDir(res.zipPath ?? res.items[0]?.output ?? null);

      // 層Bは**申請経路の、書き出した最終PNGに対してだけ**走らせる（B3）。
      // tab.png は除く（96×74 に潰れた絵に表現の judgment を求めても意味がない）。
      // 除いた事実は画面の「検査したもの」に出す（黙って外さない）。
      if (mode === "submission") {
        const finalPaths = [
          ...res.items.map((i) => i.output),
          ...(res.mainImage ? [res.mainImage] : []),
        ];
        setReviewTargets({ paths: finalPaths, excludedTab: res.tabImage ?? null });
        await runReview(finalPaths);
      }
    } catch (err) {
      pushToast({
        kind: "error",
        // Rust の生エラーはそのまま出さず、日本語の文脈を添える（設計書 §6.6）。
        text: formatStickerError(
          "書き出せませんでした。",
          err,
          "画像規格チェックの赤い行を直すか、別の保存先を選んでもう一度お試しください。",
        ),
        ttlMs: 8000,
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <StepIndicator phase={phase} />

      <div className="px-4 pt-3">
        {/*
          note は各1文にそろえる（B3・他スキルの PageHelp と同じ形）。4項目を詰め込むと
          「できないことを正直に伝える」枠が読み飛ばされる。ここに残すのは
          **この機能が原理的にできないこと**の1点だけにし、手順の説明や
          常時表示から逃がした文（クロマキー・採否・重複判定）は下の3行へ分けて置く。
        */}
        <PageHelp
          what="キャラや画像を1枚選ぶと、挨拶や返事のスタンプをまとめて作ります。背景はクロマキー用のグリーンで作ってから機械で透過に抜くので、白いキャラクターでも抜けます。全部を並べて見ながら使うものを選び、気になる1枚だけ塗って直せます。「ありがとう」などのセリフ文字は入れずに絵だけを作ります（AIに日本語を描かせると崩れるため）。文字を入れたいときは、書き出したあとの画像を編集タブで開くと、文字を置く道具で自分で入れられます。"
          first="まずは下から、スタンプにしたいキャラか画像を選んでください。次に枚数と中身の方向を決めます。"
          note="点検できるのは画像の規格（サイズ・透過・余白・容量）までで、審査に通るかどうかはLINEの判断になります。過去に作ったセットとの重複も自動では判定できません。AIで作ったことの申告は、LINE Creators Market の申請フォームで行ってください。"
        />
        {/*
          規約URLは文字列で置くと読み上げても押せない。既存の `openUrl` 流儀
          （UpdateChecker.tsx / SettingsCloudSection.tsx と同じ）でリンクにする。
        */}
        <button
          type="button"
          onClick={() => {
            void import("@tauri-apps/plugin-opener")
              .then(({ openUrl }) => openUrl(REVIEW_GUIDELINE_URL))
              .catch(() =>
                pushToast({
                  kind: "error",
                  text: "ブラウザを開けませんでした。ガイドラインは LINE Creators Market のサイトで確認できます。",
                  ttlMs: 6000,
                }),
              );
          }}
          className="mt-1.5 text-[11px] text-pink-300 underline underline-offset-2 transition hover:text-pink-200"
        >
          審査で落ちやすい項目（公式ガイドライン）を開く
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {phase === "setup" && (
          <SetupPanel
            characters={characters}
            sourceImage={sourceImage}
            sourceLabel={sourceLabel}
            attributes={attributes}
            count={count}
            tone={tone}
            shortfall={shortfall}
            running={running}
            eventSubscriptionStatus={eventSubscriptionStatus}
            onPickCharacter={(c) => {
              const src = resolveCharacterSource(c);
              if (!src) {
                pushToast({
                  kind: "error",
                  text: "このキャラには参照画像がありません。別のキャラを選ぶか、登録し直してください。",
                  ttlMs: 6000,
                });
                return;
              }
              setSourceImage(src);
              setSourceLabel(c.name);
              setAttributes(c.characterMeta?.attributes ?? "");
            }}
            onPickLocal={() => void pickLocalImage()}
            onCount={setCount}
            onTone={setTone}
            onRun={() => void runAll()}
          />
        )}

        {phase === "generate" && (
          <GeneratePanel
            cuts={cuts}
            doneCount={doneCount}
            busy={running}
            startedAt={generationStartedAt}
            onGoPick={() => setPhase("pick")}
            onRetry={(indexes) => void regenerate(indexes)}
          />
        )}

        {phase === "pick" && (
          <div data-tour="sticker-pick" className="flex h-full min-h-0 flex-col">
            <StickerPickPanel
              items={pickItems}
              keptIndexes={keptIndexes}
              busy={running}
              onToggle={(index) =>
                setDropped((prev) => {
                  const next = new Set(prev);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
              onKeepAll={() => setDropped(new Set())}
              onReedit={(item) => setReeditTarget(item)}
              onRegenerate={(indexes) => void regenerate(indexes)}
              notClearedPaths={notClearedPaths}
            />
            {/*
              ⑤ 文字入れ（L1）。採否一覧の**下**に置く。一等地（タイル）には
              「使う / 直す」しか置かない配置文法どおりで、文字入れは採否のあとの
              1セクションとして、使うと決めた絵に対して行う。
            */}
            {pickItems.length > 0 && (
              <div className="shrink-0 overflow-y-auto border-t border-[#242424] px-4 py-3">
                <StickerTextPanel
                  items={pickItems.filter((i) => keptIndexes.has(i.index))}
                  texts={texts}
                  onText={(index, text) =>
                    setTexts((prev) => ({ ...prev, [index]: text }))
                  }
                  style={textStyle}
                  onStyle={setTextStyle}
                  onApply={() => void applyTexts()}
                  onReset={resetTexts}
                  busy={applyingText || running}
                  applied={textBaseRef.current.size > 0}
                />
              </div>
            )}
            <div className="flex items-center gap-3 border-t border-[#242424] px-4 py-3">
              <button
                type="button"
                onClick={() => setPhase("generate")}
                className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e]"
              >
                ← 生成の状況に戻る
              </button>
              <button
                type="button"
                onClick={() => setPhase("export")}
                disabled={keptPaths.length === 0}
                className="ml-auto rounded bg-[#2a2a2a] px-4 py-2 text-[12px] font-bold text-neutral-100 transition hover:bg-[#333] disabled:opacity-40"
              >
                {keptPaths.length} 枚で次へ（点検と書き出し）
              </button>
            </div>
          </div>
        )}

        {phase === "export" && (
          <ExportPanel
            keptItems={pickItems.filter((i) => keptIndexes.has(i.index))}
            keptCount={keptPaths.length}
            mainPath={mainPath ?? keptPaths[0] ?? null}
            onMainPath={setMainPath}
            inspectIssues={inspectIssues}
            setIssues={setIssues}
            inspecting={inspecting}
            inspectProgress={inspectProgress}
            inspectStartedAt={inspectStartedAt}
            review={review}
            reviewing={reviewing}
            reviewTargets={reviewTargets}
            fringeWarnPaths={fringeWarnPathsRef.current}
            exportedPath={exportedDir}
            onBack={() => setPhase("pick")}
            onInspect={(mode) => void runInspect(mode)}
            onExport={(mode) => void runExport(mode)}
          />
        )}
      </div>

      {reeditTarget && (
        <StickerReeditModal
          item={reeditTarget}
          referencePaths={sourceImage ? [sourceImage] : []}
          onAdopted={adoptReedit}
          onClose={() => setReeditTarget(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 工程の進捗表示
// ─────────────────────────────────────────────────────────────────────────────

const PHASE_LABELS: { phase: Phase; label: string }[] = [
  { phase: "setup", label: "1. 素材と枚数" },
  { phase: "generate", label: "2. 生成" },
  { phase: "pick", label: "3. 使うものを選ぶ" },
  { phase: "export", label: "4. 点検と書き出し" },
];

function StepIndicator({ phase }: { phase: Phase }) {
  const currentIndex = PHASE_LABELS.findIndex((p) => p.phase === phase);
  return (
    /*
      狭幅対応（B1）。4ステップは合わせて約 340px 必要で、280px 級のパネル幅では
      必ずはみ出す。**固定幅だけ直して非折返しを残すと再発する**ので、
      ここも同時に直す:
        - `flex-wrap` で 2行へ折り返す（横スクロールを作らない。工程表示は
          「いまどこか」を見るものなので、隠れる/スクロールが要るのは目的に反する）
        - `min-w-0` + `gap-1.5` で詰め、ラベルは `whitespace-nowrap` で
          単語途中の改行を防ぐ
    */
    <div
      data-tour="sticker-phases"
      className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-[#242424] px-4 py-2"
    >
      {PHASE_LABELS.map((p, i) => (
        <div
          key={p.phase}
          className={
            "whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black " +
            (i === currentIndex
              ? "bg-pink-500 text-white"
              : i < currentIndex
                ? "bg-[#1c2a20] text-emerald-300"
                : "bg-[#1a1a1a] text-neutral-500")
          }
        >
          {p.label}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ①② 素材・枚数・中身の方向
// ─────────────────────────────────────────────────────────────────────────────

function SetupPanel({
  characters,
  sourceImage,
  sourceLabel,
  attributes,
  count,
  tone,
  shortfall,
  running,
  eventSubscriptionStatus,
  onPickCharacter,
  onPickLocal,
  onCount,
  onTone,
  onRun,
}: {
  characters: Preset[];
  sourceImage: string | null;
  sourceLabel: string;
  /** 選んだキャラの属性。生成に効くので画面に出す（C2）。手持ち画像なら空。 */
  attributes: string;
  count: StickerCount;
  tone: StickerToneId;
  shortfall: number;
  running: boolean;
  eventSubscriptionStatus: EventSubscriptionStatus;
  onPickCharacter: (preset: Preset) => void;
  onPickLocal: () => void;
  onCount: (count: StickerCount) => void;
  onTone: (tone: StickerToneId) => void;
  onRun: () => void;
}) {
  const canRun =
    Boolean(sourceImage) && !running && eventSubscriptionStatus === "ready";

  return (
    <div data-tour="sticker-setup" className="flex h-full min-h-0">
      {/*
        狭幅対応（B1）。旧実装は `w-96 shrink-0`（固定 384px）だったため、
        パネル自体が 280px しか無い状況で 384px を要求し、確実にはみ出していた。
        `w-full max-w-96` + `shrink` にして、**足りないときは自分から縮む**ようにする。
        `min-w-0` は overflow-y-auto の子が親の幅を押し広げるのを防ぐ。
      */}
      <aside className="flex w-full min-w-0 max-w-96 flex-col gap-5 overflow-y-auto border-r border-[#242424] bg-[#141414] px-4 py-4">
        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            素材を選ぶ
          </div>
          {characters.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#3a3a3a] bg-[#0d0d0d] px-3 py-3 text-center text-[12px] text-neutral-500">
              登録済みのキャラがありません。
              <br />
              手持ちの画像からでも始められます。
            </div>
          ) : (
            // 固定4列だと 280px 幅で1タイル約 56px になり名前が読めない（B1）。
            // auto-fill + minmax にして、入る数だけ並べる（狭ければ3列・2列へ落ちる）。
            <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
              {characters.map((c) => {
                const thumb =
                  c.thumbnail ??
                  (resolveCharacterSource(c) ? undefined : undefined);
                const selected = sourceLabel === c.name;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onPickCharacter(c)}
                    title={c.name}
                    className={
                      "flex flex-col overflow-hidden rounded-lg border text-left transition " +
                      (selected
                        ? "border-pink-400 ring-1 ring-pink-400/50"
                        : "border-[#2a2a2a] hover:border-neutral-500")
                    }
                  >
                    <div className="aspect-square w-full bg-[#0d0d0d]">
                      {thumb ? (
                        <img src={thumb} alt={c.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-neutral-600">
                          <CharacterIcon className="h-5 w-5" />
                        </div>
                      )}
                    </div>
                    <span className="truncate px-1 py-1 text-[10px] font-bold text-neutral-300">
                      {c.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={onPickLocal}
            className="mt-2 w-full rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e]"
          >
            手持ちの画像から選ぶ
          </button>
          {sourceImage && (
            <p className="mt-2 truncate text-[11px] text-neutral-500" title={sourceImage}>
              素材: <span className="text-neutral-300">{sourceLabel}</span>
            </p>
          )}
          {/*
            登録キャラの属性を画面に出す（C2 / 2026-08-05）。

            この文字列は選んだキャラから読み込まれ、`params.attributes` として
            生成プロンプトの「不変の見た目 (全カット共通で厳守)」に載る。
            **効いているのに画面のどこにも出ていなかった**ので、利用者からは
            「キャラの画像を選んだ」だけに見えていた。絵が思ったものと違ったとき、
            原因が登録時に書いた属性文にあると気づけない。

            表示は表情差分（`ExpressionSetWorkspace`）と同じ流儀に揃える:
            読み取り専用の1行で、編集はキャラ登録画面へ戻って行う。
            ここを編集可能にすると「このスキルでだけ属性が違う」状態を作れてしまい、
            キャラ登録が属性の正本でなくなる（同じキャラで生成するたびに
            見た目が変わる原因になる）。一等地にボタンも増やさない。
          */}
          {attributes && (
            <p className="mt-1 truncate text-[11px] text-neutral-600" title={attributes}>
              属性: {attributes}
            </p>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            枚数
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STICKER_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onCount(n)}
                className={
                  "rounded px-3 py-1.5 text-[12px] font-bold transition " +
                  (n === count
                    ? "bg-pink-500 text-white"
                    : "border border-[#2f2f2f] text-neutral-400 hover:bg-[#1a1a1a]")
                }
              >
                {n}
              </button>
            ))}
          </div>
          {/*
            取り返しがつかない情報なので ?ヘルプ だけに置かず、枚数の隣にも出す
            （設計書 §6.7）。
          */}
          <p className="mt-2 text-[11px] text-amber-300/80">
            枚数は審査リクエストのあとで変更できません。
          </p>
          {shortfall > 0 && (
            <p className="mt-1 text-[11px] text-amber-300/80">
              この方向のカタログは {count - shortfall} 件までです。足りない {shortfall} 件は
              作られません（不足分は勝手に埋めません）。
            </p>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
            中身の方向
          </div>
          <div className="space-y-1.5">
            {STICKER_CATALOGS.map((c) => {
              const selected = c.id === tone;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onTone(c.id)}
                  className={
                    "w-full rounded-lg border px-3 py-2 text-left transition " +
                    (selected
                      ? "border-pink-400/60 bg-[#1c1418]"
                      : "border-[#2a2a2a] bg-[#0d0d0d] hover:border-neutral-500")
                  }
                >
                  <div className="text-[12px] font-bold text-neutral-200">{c.label}</div>
                  <div className="mt-0.5 text-[11px] text-neutral-500">{c.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          className={`mt-auto w-full rounded-xl px-4 py-3 text-[14px] font-black transition ${
            canRun
              ? "bg-pink-500 text-white hover:bg-pink-400"
              : "cursor-not-allowed bg-[#242424] text-neutral-600"
          }`}
        >
          {/* 枚数とコストを隠さない（設計書 §1.2）。 */}
          {count} 枚を生成します
        </button>
        {eventSubscriptionStatus === "failed" && (
          <p role="alert" className="text-[11px] leading-relaxed text-red-300">
            進捗を受け取れない状態です。アプリを再起動してください
          </p>
        )}
      </aside>

      {/*
        クロマキーの説明は PageHelp の what へ移した（B2 / ui-placement-grammar §4）。
        ここに残すのは「次に何をすればいいか」の1行だけ。
      */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-neutral-500">
        <p className="text-[13px] font-bold text-neutral-300">
          スタンプにする素材を選んでください
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 生成（進捗は通し番号 k / N。波の概念は出さない）
// ─────────────────────────────────────────────────────────────────────────────

function GeneratePanel({
  cuts,
  doneCount,
  busy,
  startedAt,
  onGoPick,
  onRetry,
}: {
  cuts: CutState[];
  doneCount: number;
  busy: boolean;
  startedAt: number;
  onGoPick: () => void;
  onRetry: (indexes: number[]) => void;
}) {
  // 失敗したカットは採否一覧（工程④）に載らない（imagePath が無いため）。
  // ここで拾えないと**二度と作り直せない**ので、この画面に再試行を置く（B6）。
  const failedCuts = cuts.filter((c) => c.status === "failed");
  const failed = failedCuts.length;
  // 進捗は「決着した枚数 / 全体」。失敗も**決着**なので分子に入れる。
  // 成功だけを数えると、失敗が出た瞬間にゲージが最後まで進まず止まって見える。
  const settled = doneCount + failed;
  const total = cuts.length;
  const allSettled = total > 0 && settled >= total;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-[#242424] px-4 py-3">
        <span className="text-[12px] font-bold text-neutral-300">
          {doneCount} / {total} 枚
        </span>
        {failed > 0 && (
          <>
            <span className="text-[11px] text-amber-300/80">{failed} 枚は失敗しました</span>
            <button
              type="button"
              onClick={() => onRetry(failedCuts.map((c) => c.index))}
              disabled={busy}
              className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
            >
              失敗した {failed} 枚をもう一度作る
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onGoPick}
          disabled={busy || !allSettled || doneCount === 0}
          className="ml-auto rounded bg-[#2a2a2a] px-4 py-2 text-[12px] font-bold text-neutral-100 transition hover:bg-[#333] disabled:opacity-40"
        >
          使うものを選ぶ →
        </button>
      </div>
      {/*
        他スキル（キャラ登録・商品セット・絵コンテ・マルチアングル）と同じ
        `GenerationGauge` を使う。見た目が違うと「動いているのか分からない」
        （STΛCK指摘 2026-08-05）。
        スタンプは実際の完了枚数が取れるので `progress` に実測を渡す。
        上の「k / N 枚」の数字は残す — ゲージは進み具合、数字は正確な枚数で役割が違う。
      */}
      <div className="px-4 pt-2">
        <GenerationGauge
          startedAt={startedAt}
          mode="batch"
          progress={total > 0 ? settled / total : 0}
          done={allSettled}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {cuts.map((c) => (
            <li
              key={c.entry.id}
              className="flex flex-col overflow-hidden rounded-lg border border-[#242424] bg-[#141414]"
            >
              <div className="flex aspect-[37/32] w-full items-center justify-center bg-[#0d0d0d] text-[11px]">
                {c.status === "completed" && c.imagePath ? (
                  <SafeImage
                    path={c.imagePath}
                    alt={c.entry.label}
                    className="h-full w-full object-contain"
                  />
                ) : c.status === "failed" ? (
                  <div className="flex flex-col items-center gap-1.5 px-2 text-center">
                    <span className="text-red-300">
                      {c.reason?.startsWith("背景の切り抜き失敗")
                        ? "透過処理に失敗しました"
                        : "生成に失敗しました"}
                    </span>
                    {/* 1枚だけ作り直せるようにする（B6）。全部やり直す必要はない。 */}
                    <button
                      type="button"
                      onClick={() => onRetry([c.index])}
                      disabled={busy}
                      className="rounded border border-[#2f2f2f] px-2 py-0.5 text-[10px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
                    >
                      この1枚を作り直す
                    </button>
                  </div>
                ) : c.status === "cuttingOut" ? (
                  <div className="flex flex-col items-center gap-2 text-neutral-300">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                    <span>透過処理中…</span>
                  </div>
                ) : c.status === "running" ? (
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                ) : (
                  <span className="text-neutral-600">待機中</span>
                )}
              </div>
              <span className="truncate px-2 py-1.5 text-[11px] text-neutral-300">
                {String(c.index).padStart(2, "0")} {c.entry.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥⑦ 点検と書き出し
// ─────────────────────────────────────────────────────────────────────────────

function ExportPanel({
  keptItems,
  keptCount,
  mainPath,
  onMainPath,
  inspectIssues,
  setIssues,
  inspecting,
  inspectProgress,
  inspectStartedAt,
  review,
  reviewing,
  reviewTargets,
  fringeWarnPaths,
  exportedPath,
  onBack,
  onInspect,
  onExport,
}: {
  keptItems: StickerPickItem[];
  keptCount: number;
  mainPath: string | null;
  onMainPath: (path: string) => void;
  inspectIssues: { path: string; issues: StickerIssue[] }[] | null;
  setIssues: StickerIssue[];
  inspecting: boolean;
  /** 確認中の実測 k/N（I3）。確認していない間は null。 */
  inspectProgress: InspectProgress | null;
  /** 確認を始めた時刻（`GenerationGauge` の props を揃えるために持つ）。 */
  inspectStartedAt: number;
  review: StickerReviewReport | null;
  reviewing: boolean;
  reviewTargets: { paths: string[]; excludedTab: string | null } | null;
  fringeWarnPaths: ReadonlySet<string>;
  /** 直前に書き出したファイル（ZIP 優先）。未書き出しなら null。 */
  exportedPath: string | null;
  onBack: () => void;
  onInspect: (mode: "personal" | "submission") => void;
  onExport: (mode: "personal" | "submission") => void;
}) {
  const pushToast = useToasts((s) => s.push);
  const countValid = isValidStickerCount(keptCount);
  const blockers =
    inspectIssues?.flatMap((i) => i.issues.filter((x) => x.severity === "blocker")) ?? [];
  const setBlockers = setIssues.filter((x) => x.severity === "blocker");

  return (
    <div
      data-tour="sticker-export"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <div className="flex items-center gap-3 border-b border-[#242424] px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e]"
        >
          ← 選び直す
        </button>
        <span className="text-[12px] font-bold text-neutral-300">{keptCount} 枚</span>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {/*
          層A と層B を視覚的に分ける（設計書 §6.4「事実と意見の隔離」）。
          決定論の結果とAIの意見を同じリストに混ぜると、意見が事実として扱われる。
        */}
        <section className="rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
          <div className="flex items-center gap-3">
            <h3 className="text-[12px] font-black text-neutral-200">画像規格チェック</h3>
            <span className="text-[11px] text-neutral-500">
              機械が測ります（サイズ・透過・余白・容量）
            </span>
            <button
              type="button"
              onClick={() => onInspect("submission")}
              disabled={inspecting || keptCount === 0}
              className="ml-auto rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
            >
              {inspecting ? "確認中…" : "確認する"}
            </button>
          </div>

          {/*
            確認中のゲージ（I3 / 2026-08-05 STΛCK実機FB「確認中にゲージが出ない」）。
            生成中（工程③の `GeneratePanel`）と**同じ部品・同じ並べ方**にする
            — 見出しの行のすぐ下にゲージ、数字は別に併記。見た目が違うと
            「動いているのか分からない」（同FB）。
            確認は枚数が分かるので `progress` に実測を渡す（推定にしない）。
            置き場所を確認パネルの中にしたのは、生成タブの右側タイムラインが
            この画面には無いため（工程④以降は一覧を持たない縦積みのパネル）。
            押したボタンのすぐ下に出るほうが、押下と反応が結びつく。
          */}
          {inspectProgress && (
            <div className="mt-3">
              <GenerationGauge
                startedAt={inspectStartedAt}
                mode="batch"
                progress={
                  inspectProgress.total > 0
                    ? inspectProgress.done / inspectProgress.total
                    : 0
                }
                done={
                  inspectProgress.total > 0 &&
                  inspectProgress.done >= inspectProgress.total
                }
              />
              <p className="mt-1.5 text-[11px] text-neutral-400">
                {inspectProgress.done} / {inspectProgress.total}枚 確認中
              </p>
            </div>
          )}

          {inspectIssues && (
            <div className="mt-3 space-y-1.5 text-[11px]">
              {blockers.length === 0 && setBlockers.length === 0 ? (
                <p className="text-emerald-300">
                  画像規格を満たしています（サイズ・透過・余白・容量）。
                </p>
              ) : (
                <>
                  {setBlockers.map((issue, i) => (
                    <p key={`set-${i}`} className="text-red-300">
                      {issue.message}
                    </p>
                  ))}
                  {inspectIssues.map((item) =>
                    item.issues.map((issue, i) => (
                      <p
                        key={`${item.path}-${i}`}
                        className={
                          issue.severity === "blocker" ? "text-red-300" : "text-amber-300/80"
                        }
                      >
                        {item.path.split(/[\\/]/).pop()}: {issue.message}
                      </p>
                    )),
                  )}
                </>
              )}
            </div>
          )}

          {/*
            縁のにじみは**抜いた瞬間にしか測れない**ので、層Aの検査結果とは別に出す
            （層Aは抜きの統計を持たないので判定していない。持っていないものを
            判定しないのが正しい設計）。事実の出どころが違うので混ぜない。
          */}
          {fringeWarnPaths.size > 0 && (
            <div className="mt-3 space-y-1 text-[11px]">
              {keptItems
                .filter((i) => fringeWarnPaths.has(i.imagePath))
                .map((i) => (
                  <p key={i.index} className="text-amber-300/80">
                    {String(i.index).padStart(2, "0")} {i.label}:
                    背景の抜け残り（輪郭のにじみ）が多いかもしれません。
                    気になる場合は個別に直してください。
                  </p>
                ))}
            </div>
          )}

          {!countValid && (
            <p className="mt-2 text-[11px] text-amber-300/80">
              申請用に書き出すときは {NORMAL_STICKER_SPEC.counts.join(" / ")} 枚のいずれかに
              する必要があります。いまは {keptCount} 枚です。
            </p>
          )}
        </section>

        {/*
          メイン画像（240×240）とタブ画像（96×74）に使う1枚を選ぶ。
          常に1枚目固定にしない（看板を選べないのは不便）。
        */}
        <section className="rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
          <div className="flex items-center gap-3">
            <h3 className="text-[12px] font-black text-neutral-200">メイン画像に使う1枚</h3>
            <span className="text-[11px] text-neutral-500">
              申請用のときだけ使います（タブ画像にも同じ絵を使います）
            </span>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2">
            {keptItems.map((item) => {
              const selected = item.imagePath === mainPath;
              return (
                <li key={item.index}>
                  <button
                    type="button"
                    onClick={() => onMainPath(item.imagePath)}
                    title={item.label}
                    className={
                      "block overflow-hidden rounded-lg border transition " +
                      (selected
                        ? "border-pink-400 ring-1 ring-pink-400/50"
                        : "border-[#2a2a2a] hover:border-neutral-500")
                    }
                  >
                    <SafeImage
                      path={item.imagePath}
                      alt={item.label}
                      className="h-16 w-16 bg-[#0d0d0d] object-contain"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
          <div className="flex items-center gap-3">
            <h3 className="text-[12px] font-black text-neutral-200">審査セルフチェック</h3>
            <span className="text-[11px] text-neutral-500">AIによる参考情報です</span>
            {reviewing && (
              <span className="ml-auto text-[11px] text-neutral-400">確認中…</span>
            )}
          </div>
          {/*
            単独の「確認する」ボタンは置かない（B3）。層Bは申請用の書き出しの中から、
            書き出した最終PNGに対してだけ走る。ボタンを置くと (a) 自分用の人も押せる
            (b) 編集前の絵を検査してしまう の2つが同時に起きる。
          */}
          {!review && !reviewing && (
            <p className="mt-2 text-[11px] text-neutral-500">
              「申請用に書き出す」を実行すると、書き出した画像をAIが確認して、
              気になる点があればここに出します。
            </p>
          )}

          {reviewTargets && (
            <p className="mt-2 text-[11px] text-neutral-500">
              検査したもの: 書き出した {reviewTargets.paths.length} 点
              （メイン画像を含みます）。
              {reviewTargets.excludedTab
                ? "タブ画像（96×74）は小さすぎるため検査していません。"
                : ""}
            </p>
          )}

          {review && (
            <div className="mt-3 space-y-2 text-[11px]">
              {review.results.map((r) => (
                <div key={r.imagePath}>
                  <span className="text-neutral-400">
                    {r.imagePath.split(/[\\/]/).pop()}
                  </span>
                  {r.error ? (
                    <p className="text-amber-300/80">検査エラー: {r.error}</p>
                  ) : r.issues.length === 0 && r.undetermined.length === 0 ? (
                    /*
                      「問題なし」と言い切ってよいのは、**全項目を判定できたとき
                      だけ**（R3）。決定論ルールは uncertain を指摘しない設計なので、
                      指摘が0件でも「見えていなかった」可能性がある。
                      材料が壊れて捨てられた項目も同じ扱いにする。
                    */
                    <p className="text-neutral-500">気になる点は見つかりませんでした</p>
                  ) : (
                    <>
                      {r.issues.map((issue, i) => (
                        <p key={i} className="text-amber-300/80">
                          {issue.message}
                          {issue.evidence ? `（根拠: ${issue.evidence}）` : ""}
                        </p>
                      ))}
                      {r.undetermined.length > 0 && (
                        <p className="text-amber-300/80">
                          一部を判定できませんでした（{r.undetermined.join(" / ")}）。
                          目視で確認してください。
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
              {/* 黙って外さない（設計書 §1.9 / §6.4）。 */}
              {review.excluded.map((e) => (
                <p key={e.imagePath} className="text-neutral-500">
                  {e.imagePath.split(/[\\/]/).pop()}: {e.reason}
                </p>
              ))}
              <p className="border-t border-[#242424] pt-2 text-neutral-500">
                {review.disclaimer}
              </p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(formatReviewAsText(review))
                    .then(() =>
                      pushToast({
                        kind: "success",
                        text: "検査結果をコピーしました。",
                        ttlMs: 2500,
                      }),
                    )
                    .catch(() =>
                      pushToast({
                        kind: "error",
                        text: "コピーできませんでした。",
                        ttlMs: 4000,
                      }),
                    );
                }}
                className="rounded border border-[#2f2f2f] px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e]"
              >
                結果をコピー
              </button>
            </div>
          )}
          {/* 重複を自動判定できない旨は PageHelp の note へ移した（B2）。 */}
        </section>

        {/* ⑦ 出口。ここで初めて2択になる（それまでの手順は1本）。 */}
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
          <button
            type="button"
            onClick={() => onExport("personal")}
            disabled={keptCount === 0}
            className="rounded border border-[#2f2f2f] px-4 py-2 text-[12px] font-bold text-neutral-200 transition hover:bg-[#1e1e1e] disabled:opacity-40"
          >
            このまま使う（画像として保存）
          </button>
          <button
            type="button"
            onClick={() => onExport("submission")}
            disabled={keptCount === 0}
            className="rounded bg-[#2a2a2a] px-4 py-2 text-[12px] font-bold text-neutral-100 transition hover:bg-[#333] disabled:opacity-40"
          >
            申請用に書き出す（一式）
          </button>
          {/*
            書き出したあとにだけ出す。まだ何も出していない段階で置いても押せない
            （一等地に押せないボタンを増やさない・配置文法）。
          */}
          {exportedPath && (
            <button
              type="button"
              onClick={() => {
                void import("@tauri-apps/plugin-opener")
                  .then(({ revealItemInDir }) => revealItemInDir(exportedPath))
                  .catch(() =>
                    pushToast({
                      kind: "error",
                      text: "保存先を開けませんでした。書き出し先のフォルダを直接開いてください。",
                      ttlMs: 5000,
                    }),
                  );
              }}
              className="rounded border border-[#2f2f2f] px-4 py-2 text-[12px] text-neutral-300 transition hover:bg-[#1e1e1e]"
            >
              保存先を開く
            </button>
          )}
          <p className="w-full text-[11px] text-neutral-500">
            申請用は、規格を満たさないものが1件でもあると書き出しを中止します。
            メイン画像（240×240）とタブ画像（96×74）も一緒に出します。
            提出用のZIPも1つ作ります（個別の画像もそのまま残ります）。
          </p>
        </section>
      </div>
    </div>
  );
}
