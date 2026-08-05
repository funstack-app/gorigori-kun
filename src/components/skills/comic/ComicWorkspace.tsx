import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { images } from "../../../lib/ipc";
import {
  ComicTextTurnAbortedError,
  ComicTextTurnTimeoutError,
  runComicTextTurn,
  type ComicTextTurnProgress,
} from "../../../lib/comic/codexText";
import {
  buildFullPagePrompt,
  buildPanelImagePrompt,
  buildStoryPrompt,
  isValidStory,
  MAX_PANELS_PER_PAGE,
  MAX_STORY_PAGES,
  parseComicStory,
} from "../../../lib/comic/prompts";
import type {
  ComicCharacter,
  ComicColorMode,
  ComicEnvReference,
  ComicFrameStyle,
  ComicGutterStyle,
  ComicImageCharacter,
  ComicPageResult,
  ComicPanel,
  ComicPhase,
  ComicReadingDirection,
  ComicSaveFormat,
  ComicStoryPage,
  PageCountChoice,
} from "../../../lib/comic/types";
import {
  COMIC_LAYOUT_TEMPLATES,
  COMIC_PAGE_ASPECT,
  getComicTemplate,
  type ComicLayoutTemplate,
  type ComicPanelSlot,
} from "../../../lib/comic/layoutTemplates";
import {
  materializeExportPage,
  savePageAs,
  savePagesBulk,
} from "../../../lib/comic/savePage";
import { COMIC_TEMPLATE_THUMBNAILS } from "./templateThumbnails";
import { ComicPhaseRail } from "./ComicPhaseRail";
import { BalloonEditor, SfxEditor } from "./BalloonEditor";
import { presetKind, usePresets } from "../../../lib/store/presets";
import { selectCharacterReferences } from "../../../lib/presets/character";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useComicStoryHistory } from "../../../lib/store/comicStoryHistory";
import { useProjects } from "../../../lib/store/projects";
import { useToasts } from "../../../lib/store/toasts";
import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { GenerationGauge } from "../../GenerationGauge";
import { ReferenceLibraryModal } from "../../ReferenceLibraryModal";
import { SafeImage } from "../../SafeImage";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { PageHelp } from "../../PageHelp";
import { ComicSpreadPreviewModal } from "./ComicSpreadPreviewModal";
import { beginDirectRun } from "../../../lib/store/generationStatus";
import {
  registerDirectRunParent,
  releaseDirectRunParent,
} from "../../../lib/store/directRun";
import {
  collectUnboundCastNames,
  MAX_ENV_REFERENCES,
  resolvePageCast,
} from "../../../lib/comic/references";
import { REFERENCE_ROLE_META } from "../../../lib/store/referenceRoles";
import {
  buildPanelReeditGenerationRequest,
  compositePanelImages,
  createPanelMaskPng,
  detectPanelInterior,
  isCurrentPanelReeditRun,
  panelGuidePoints,
  resolvePanelReeditReferences,
  readPanelImageData,
  validatePanelPolygon,
  type PanelDetection,
  type PanelReeditPoint,
} from "../../../lib/comic/panelReedit";
import { recoverPanelSlots } from "../../../lib/comic/panelSlotRecovery";
import {
  adjacentSlotIndices,
  applyPanelMergeToImage,
  applyPanelSplitToImage,
  mergeStoryPage,
  mergedSlot,
  splitSlotQuads,
  splitStoryPage,
  type SplitDirection,
} from "../../../lib/comic/panelLayoutOps";

/** PC から画像を添付するときの拡張子フィルタ（GoalChatPanel と同値）。 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/**
 * 「おまかせ（AI最適化）」タイルの ID。テンプレ定義側には持たせない
 * （layoutTemplates.ts は実在するコマ割りだけを持つ正本のまま）。
 */
const AUTO_TEMPLATE_ID = "auto";

/**
 * 絵柄のクイック選択チップ（qvs 2026-08-03）。
 * クリックでテキスト欄へ確定英語句をセットするだけの決定論UI（トグルではなく上書き）。
 * プロンプト定数だが UI 専属なので comic/prompts.ts へは置かない。
 */
const COMIC_STYLE_CHIPS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "少年漫画",
    text: "shonen manga style, dynamic bold ink lines, high-energy action shading",
  },
  {
    label: "少女漫画",
    text: "shojo manga style, delicate thin lines, sparkling decorative screentones, expressive large eyes",
  },
  {
    label: "劇画",
    text: "gekiga style, heavy dramatic ink shading, realistic proportions, gritty texture",
  },
  {
    label: "ゆるコメディ",
    text: "loose comedy manga style, simple rounded lines, minimal shading",
  },
  {
    label: "アメコミ",
    text: "american comic book style, bold outlines, dramatic shadows, halftone dots",
  },
  {
    label: "水彩",
    text: "soft watercolor illustration style, gentle color bleeding, hand-painted texture",
  },
];

type PanelReeditHistoryEntry = {
  page: number;
  /** 差し替え前のページ画像（ファイルは消さないので常に復元可能）。 */
  imagePath: string;
  /** 差し替え前のページ構成の丸ごとスナップショット（panels / slotsOverride 含む）。
   *  state 更新は常に新オブジェクト生成（Immutability 規約）なので参照保持で安全。 */
  pageSnapshot: ComicStoryPage;
};

type PanelReeditOutcome =
  | { adopted: true }
  | { adopted: false; error: string };

/**
 * コマ割り認識（recoverAndAdoptSlots）の結果。
 * `silent` は「ページが認識中に差し替わったので黙って捨てた」ケース（D-2）。
 * ユーザーは再生成の結果を見ている最中なので、失敗トーストを出さない。
 */
type SlotRecoveryOutcome =
  | { adopted: true }
  | { adopted: false; error: string; silent?: boolean };

/**
 * 漫画制作 Workspace（スキル一覧v2.1 #9）
 *
 * 経路は1本（おまかせ一括）。ページ丸ごと1枚を生成する。吹き出し・擬音も絵として描かれる。
 *   1. input — あらすじ + ページ数 + 参考テンプレ(任意) + 登場キャラを入力
 *   2. plan  — AI がページ構成を JSON 生成。ページ/コマ単位で人が直す（工程の要）
 *   3. pages — ページごとに1枚を並列生成。ページ単位で再生成・保存
 *
 * 旧「詳細編集（コマ別）」経路（ネーム → コマ生成 → CSS合成ページ確認）は
 * 2026-07-28 に撤去した（STΛCK指示）。つくり方の選択自体を無くしている。
 *
 * SkillWorkspaceRouter が activeUiMode === "comic" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function ComicWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>
      {/* Phase レール (現フェーズを左側に縦表示。クリックで戻れる) は ComicFlow が返す。 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ComicFlow />
      </div>
    </section>
  );
}

function ComicFlow() {
  const presets = usePresets((s) => s.presets);
  const pushToast = useToasts((s) => s.push);

  const characterPresets = useMemo(
    () => presets.filter((p) => presetKind(p) === "character"),
    [presets],
  );

  const [phase, setPhase] = useState<ComicPhase>("input");
  const [synopsis, setSynopsis] = useState("");
  /** 話とキャラ画面で選んでいるコマ割りテンプレ。既定は「おまかせ（AI最適化）」。 */
  const [templateId, setTemplateId] = useState<string>(AUTO_TEMPLATE_ID);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 画像から追加した登場キャラ（セッション内のみ。ディスク保存しない）。 */
  const [imageCharacters, setImageCharacters] = useState<ComicImageCharacter[]>([]);
  /** 「キャラN」連番。削除しても番号を再利用しない（生成済みネームとの名前衝突防止）。 */
  const nextImageCharNoRef = useRef(1);
  /** ライブラリから選ぶモーダルの開閉。 */
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** 背景・小物の環境参照（3ir。セッション内のみ・ディスク保存しない）。 */
  const [envReferences, setEnvReferences] = useState<ComicEnvReference[]>([]);
  /** 「背景N」連番。削除しても再利用しない（imageCharacters と同じ規律）。 */
  const nextEnvRefNoRef = useRef(1);
  /** 環境参照用ライブラリモーダルの開閉（キャラ用 libraryOpen とは別）。 */
  const [envLibraryOpen, setEnvLibraryOpen] = useState(false);
  /** コマ絵の画風（白黒/カラー/キャラ忠実）。生成プロンプトのベース句・画風句に効く。 */
  const [colorMode, setColorMode] = useState<ComicColorMode>("mono");
  /** 絵柄テキスト（qvs）。空=従来どおり。faithful では生成に渡さない（UIも無効化）。 */
  const [styleText, setStyleText] = useState("");
  /** コマの読み方向 (B-1)。既定は右→左 (日本式)。プロンプトの空間指示に効く。 */
  const [readingDirection, setReadingDirection] = useState<ComicReadingDirection>("rtl");
  /** 枠線の太さ (B-4b)。プロンプト近似・保証なし。 */
  const [frameStyle, setFrameStyle] = useState<ComicFrameStyle>("standard");
  /** コマ間隔 (B-4b)。プロンプト近似・保証なし。 */
  const [gutterStyle, setGutterStyle] = useState<ComicGutterStyle>("standard");

  /** 構成フェーズが確定させたページ割り。plan/pages 工程の正本。 */
  const [storyPages, setStoryPages] = useState<ComicStoryPage[]>([]);
  /** ページ単位の生成結果（コマ別の results のページ版）。 */
  const [pageResults, setPageResults] = useState<ComicPageResult[]>([]);
  /**
   * D-2: コマ割り認識（recoverAndAdoptSlots）は画像読み込みで await が入るため、
   * その間にページ再生成が走ると「旧画像から求めた座標」を新画像へ書き戻し得る。
   * 採用直前に最新値と再照合するための ref ミラー（レンダー中は読まない）。
   */
  const storyPagesRef = useRef<ComicStoryPage[]>([]);
  const pageResultsRef = useRef<ComicPageResult[]>([]);
  useEffect(() => {
    storyPagesRef.current = storyPages;
  }, [storyPages]);
  useEffect(() => {
    pageResultsRef.current = pageResults;
  }, [pageResults]);
  const [generatingStory, setGeneratingStory] = useState(false);
  /** 構成生成の開始時刻（推定進捗ゲージの基準）。 */
  const [storyStartedAt, setStoryStartedAt] = useState<number | undefined>(undefined);
  /**
   * 構成生成の「いま何が起きているか」(9qm 2026-08-04)。
   * 待ちの実態を正直に出すために使う。undefined は開始直後（まだ通知ゼロ）。
   */
  const [storyProgress, setStoryProgress] = useState<ComicTextTurnProgress | undefined>(
    undefined,
  );
  /**
   * 構成生成の中止ハンドル（実装契約M 2026-08-05）。
   *
   * 活動を観測した turn は自動で切らなくなったので、**やめる判断はユーザーがする**。
   * その手を用意するのがこれ。ref で持つのは、飛行中の generateStory の
   * クロージャからも同じハンドルを掴めるようにするため。
   */
  const storyAbortRef = useRef<AbortController | null>(null);
  const [generatingPages, setGeneratingPages] = useState(false);
  /** ページ保存の形式（セッション内のみ）。 */
  const [saveFormat, setSaveFormat] = useState<ComicSaveFormat>("png");
  /** 構成生成が使ったテンプレ（null=おまかせ）。選択だけ変えて戻っても構成と食い違わないよう凍結する。 */
  const [storyTemplateId, setStoryTemplateId] = useState<string | null>(null);
  /** ページ数の指定。"auto" = AI が決める（目安 MAX_STORY_PAGES）／数値は上限なし。 */
  const [pageCountChoice, setPageCountChoice] = useState<PageCountChoice>("auto");
  /** 全ページ一括の走行トークン。 */
  const pagesRunTokenRef = useRef(0);
  /** ページ単位の中止トークン（単体の中止を押したページだけに効かせる）。 */
  const pageTokensRef = useRef(new Map<number, number>());
  /** 構成生成の走行トークン。 */
  const storyTokenRef = useRef(0);
  /** 1コマ再編集はページ生成と競合させない。 */
  const panelReeditTokenRef = useRef(0);
  const panelReeditActiveRef = useRef(false);
  const [panelReeditRunningPage, setPanelReeditRunningPage] = useState<number | null>(null);
  const [panelReeditHistory, setPanelReeditHistory] = useState<PanelReeditHistoryEntry[]>([]);

  /** 1コマ再編集中は工程移動も止め、旧runが別構成へ書き込む競合を防ぐ。 */
  const requestPhaseChange = (next: ComicPhase) => {
    if (panelReeditActiveRef.current) {
      pushToast({
        kind: "info",
        text: "1コマ再生成中は工程を移動できません。完了または中止後に操作してください。",
        ttlMs: 4000,
      });
      return;
    }
    setPhase(next);
  };

  useEffect(
    () => () => {
      // アンマウント時は構成生成・全ページ一括・ページ単体をすべて無効化する。
      storyTokenRef.current += 1;
      pagesRunTokenRef.current += 1;
      panelReeditTokenRef.current += 1;
      panelReeditActiveRef.current = false;
      const pageTokens = pageTokensRef.current;
      for (const [page, token] of pageTokens) pageTokens.set(page, token + 1);
    },
    [],
  );

  // 選択されたキャラプリセット + 画像から追加したキャラを ComicCharacter に合流
  const characters = useMemo<ComicCharacter[]>(() => {
    const fromPresets = selectedIds
      .map((id) => characterPresets.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({
        presetId: p.id,
        name: p.name,
        attributes: p.characterMeta?.attributes,
        // キャラ参照は速度対策で既定3枚に絞る (selectCharacterReferences)。
        referenceImagePaths: selectCharacterReferences(p).map((r) => r.path),
      }));
    // 画像キャラ: 属性テキストなし・参照1枚。名前だけがネーム/参照解決へ流れる。
    const fromImages = imageCharacters.map((c) => ({
      name: c.name,
      referenceImagePaths: [c.imagePath],
    }));
    return [...fromPresets, ...fromImages];
  }, [selectedIds, characterPresets, imageCharacters]);

  const toggleCharacter = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  /** 画像パスを画像キャラとして追加する（重複パスはスキップ+info トースト）。 */
  const addImageCharacters = (paths: string[], source: "file" | "library") => {
    setImageCharacters((prev) => {
      const existing = new Set(prev.map((c) => c.imagePath));
      const added: ComicImageCharacter[] = [];
      for (const p of paths) {
        if (existing.has(p)) continue;
        existing.add(p);
        added.push({
          id: crypto.randomUUID(),
          name: `キャラ${nextImageCharNoRef.current++}`,
          imagePath: p,
          source,
        });
      }
      if (added.length < paths.length) {
        pushToast({ kind: "info", text: "追加済みの画像はスキップしました", ttlMs: 3000 });
      }
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  };

  const renameImageCharacter = (id: string, name: string) => {
    setImageCharacters((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  };

  /**
   * 空名を既定名へ戻す（フォーカスアウト時）。
   * 空名はネーム配役・参照解決を壊すため、新しい連番を採番して埋める。
   */
  const restoreImageCharName = (id: string) => {
    setImageCharacters((prev) =>
      prev.map((c) =>
        c.id === id && !c.name.trim()
          ? { ...c, name: `キャラ${nextImageCharNoRef.current++}` }
          : c,
      ),
    );
  };

  const removeImageCharacter = (id: string) => {
    setImageCharacters((prev) => prev.filter((c) => c.id !== id));
  };

  /**
   * 環境参照（背景・小物）を追加する（3ir）。重複パスはスキップ+info トースト。
   * 上限超過は黙って切り捨てず、追加時点でブロックして info トーストで知らせる。
   */
  const addEnvReferences = (paths: string[], source: "file" | "library") => {
    setEnvReferences((prev) => {
      if (prev.length >= MAX_ENV_REFERENCES) {
        pushToast({
          kind: "info",
          text: `背景・小物の参照は ${MAX_ENV_REFERENCES} 枚までです`,
          ttlMs: 4000,
        });
        return prev;
      }
      const existing = new Set(prev.map((r) => r.imagePath));
      const added: ComicEnvReference[] = [];
      let blocked = false;
      for (const p of paths) {
        if (existing.has(p)) continue;
        if (prev.length + added.length >= MAX_ENV_REFERENCES) {
          blocked = true;
          break;
        }
        existing.add(p);
        added.push({
          id: crypto.randomUUID(),
          name: `背景${nextEnvRefNoRef.current++}`,
          kind: "location",
          imagePath: p,
          source,
        });
      }
      if (blocked) {
        pushToast({
          kind: "info",
          text: `背景・小物の参照は ${MAX_ENV_REFERENCES} 枚までです`,
          ttlMs: 4000,
        });
      } else if (added.length < paths.length) {
        pushToast({ kind: "info", text: "追加済みの画像はスキップしました", ttlMs: 3000 });
      }
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  };

  const renameEnvReference = (id: string, name: string) => {
    setEnvReferences((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  };

  /** 空名を既定名へ戻す（フォーカスアウト時）。空名はプロンプトの参照名を壊す。 */
  const restoreEnvRefName = (id: string) => {
    setEnvReferences((prev) =>
      prev.map((r) =>
        r.id === id && !r.name.trim()
          ? { ...r, name: `背景${nextEnvRefNoRef.current++}` }
          : r,
      ),
    );
  };

  const toggleEnvRefKind = (id: string) => {
    setEnvReferences((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, kind: r.kind === "location" ? "item" : "location" } : r,
      ),
    );
  };

  const removeEnvReference = (id: string) => {
    setEnvReferences((prev) => prev.filter((r) => r.id !== id));
  };

  /** PC から画像を選んで環境参照に追加する（pickImageFiles の env 版）。 */
  const pickEnvImageFiles = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = (Array.isArray(r) ? r : [r]).filter(
        (p): p is string => typeof p === "string",
      );
      if (paths.length > 0) addEnvReferences(paths, "file");
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  };

  /** PC から画像を選んで画像キャラに追加する（GoalChatPanel と同一パターン）。 */
  const pickImageFiles = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = (Array.isArray(r) ? r : [r]).filter(
        (p): p is string => typeof p === "string",
      );
      if (paths.length > 0) addImageCharacters(paths, "file");
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  };

  /**
   * ページ構成（ページ割り＋コマ割り＋セリフ）を AI に JSON で作らせる。
   *
   * テンプレは「おまかせ」なら渡さず、AI にコマ割りを最適化させる。
   * パース不能・条件不一致は**生成に入る前に**止める（課金前に停止・黙って切り捨てない）。
   */
  const generateStory = async () => {
    if (panelReeditActiveRef.current) {
      pushToast({
        kind: "info",
        text: "1コマ再生成中は構成をやり直せません。完了または中止後に操作してください。",
        ttlMs: 4000,
      });
      return;
    }
    // 中止済みでも非同期処理が遅れて返る可能性があるため、新しい構成開始時に
    // 既存の1コマrunを必ず失効させる。
    panelReeditTokenRef.current += 1;
    if (!synopsis.trim()) {
      pushToast({ kind: "error", text: "話（あらすじ）を入力してください", ttlMs: 4000 });
      return;
    }
    // B-3 (2026-07-30): 構成生成に入った話を自動で履歴へ積む (fire-and-forget)。
    void useComicStoryHistory.getState().add(synopsis);
    const runToken = storyTokenRef.current + 1;
    storyTokenRef.current = runToken;
    // 飛行中のページ生成を**実際に**無効化する (2026-07-28)。
    //
    // 以前は setGeneratingPages(false) とタイル解除で「表示だけ」止めていた。
    // ページ単体の再生成中に構成をやり直すと（そのボタンの disabled は
    // generatingStory||generatingPages だけなので押せる）、飛行中の
    // generateStoryPage が stillMine を通過し、**旧構成の画像を新構成の
    // 同番号ページへ書き込む**（表示と実態の食い違い）。
    // アンマウントクリーンアップ effect と同じ写経でトークンを bump し、
    // 構成やり直しの開始時点で全飛行中ページ生成を無効化する。
    pagesRunTokenRef.current += 1;
    const pageTokens = pageTokensRef.current;
    for (const [page, token] of pageTokens) pageTokens.set(page, token + 1);
    setGeneratingPages(false);
    setPageResults((prev) =>
      prev.map((result) => ({ ...result, generating: false, startedAt: undefined })),
    );
    setStoryStartedAt(Date.now());
    setStoryProgress(undefined);
    // 前回の中止ハンドルは捨てて、この走行専用のものを立てる。
    const abort = new AbortController();
    storyAbortRef.current = abort;
    setGeneratingStory(true);
    try {
      const template =
        templateId === AUTO_TEMPLATE_ID ? undefined : getComicTemplate(templateId);
      // 「おまかせ」は AI がページ数を決める（undefined を渡す）。数値指定なら厳密一致を要求する。
      const pageCount = pageCountChoice === "auto" ? undefined : pageCountChoice;
      const prompt = buildStoryPrompt(synopsis, characters, {
        pageCount,
        template,
        readingDirection,
        envNames: envReferences.map((r) => r.name),
      });
      // 実装契約M (2026-08-05): 「時間がかかると勝手に切れる」をやめた。
      //
      // - 120 秒は「1文字も来ないまま」のときだけ打ち切りに使う（サーバー死の疑い）
      // - 一度でも動いた turn は無応答でも切らず、"応答が止まっています" と可視化する
      // - 天井は暴走の最後の壁として残すが 15分 → 30分 へ広げた。
      //   受信が続いている正常な長話を殺さない値にする（切る側の自動天井はここだけ）
      // - やめる判断はユーザーがする（下の中止ボタン → abort.signal）
      const raw = await runComicTextTurn(prompt, {
        idleTimeoutMs: 120_000,
        totalTimeoutMs: 30 * 60_000,
        label: "構成",
        signal: abort.signal,
        onProgress: (p) => {
          // 遅れて届いた進捗で新しい実行の表示を汚さない
          if (storyTokenRef.current !== runToken) return;
          setStoryProgress(p);
        },
      });
      if (storyTokenRef.current !== runToken) return;
      const parsed = parseComicStory(raw);
      if (!parsed) {
        pushToast({
          kind: "error",
          text: "構成の JSON を取得できませんでした。もう一度お試しください。",
          ttlMs: 6000,
        });
        return;
      }
      if (
        !isValidStory(parsed, {
          expectedPages: pageCount,
          templatePanelCount: template?.panelCount,
        })
      ) {
        pushToast({
          kind: "error",
          text: "構成がページ数・コマ数の条件と合いませんでした。もう一度お試しください。",
          ttlMs: 6000,
        });
        return;
      }
      setStoryPages(parsed);
      setPageResults(parsed.map((p) => ({ page: p.page, generating: false })));
      // 別構成のコマ編集履歴を持ち越さない (Codex検分 2026-07-30)。
      // 持ち越すと「戻す」が前の構成のページを復元し、別作品の絵が混入する。
      setPanelReeditHistory([]);
      // この構成がどのテンプレで作られたかを確定させる（以降の工程はこれを使う）。
      setStoryTemplateId(templateId === AUTO_TEMPLATE_ID ? null : templateId);
      // 登録キャラと一致しない cast 名は「割り当て直し」で直せる。1回だけ案内する
      // （ページ数分のトーストは出さない）。生成自体は fallback で成立するのでブロックしない。
      const unbound = collectUnboundCastNames(parsed, characters);
      if (unbound.length > 0) {
        pushToast({
          kind: "info",
          text: `登録キャラと一致しない名前があります: ${unbound.join("、")}。構成確認の黄色いチップから割り当てできます`,
          ttlMs: 6000,
        });
      }
      setPhase("plan");
    } catch (err) {
      if (storyTokenRef.current !== runToken) return;
      // 中止は失敗ではない。ユーザーが自分で押した操作を赤いエラーで責めない
      // （コマ再生成の中止と同じ流儀）。
      if (err instanceof ComicTextTurnAbortedError) {
        pushToast({ kind: "info", text: err.message, ttlMs: 3000 });
        return;
      }
      pushToast({
        kind: "error",
        // タイムアウトは文言が完結しているのでくるまない
        // （くるむと「構成の生成に失敗しました: 構成の生成がタイムアウト…」と二重になる）。
        text:
          err instanceof ComicTextTurnTimeoutError
            ? err.message
            : `構成の生成に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      if (storyTokenRef.current === runToken) {
        setGeneratingStory(false);
        setStoryProgress(undefined);
      }
      // このハンドルが今もカレントなら外す（新しい走行のものは消さない）。
      if (storyAbortRef.current === abort) storyAbortRef.current = null;
    }
  };

  /** 構成生成をやめる。押した時点で飛行中のものだけに効く。 */
  const cancelStoryGeneration = () => {
    storyAbortRef.current?.abort();
  };

  /** 構成のページ属性（あらすじ・コマ割り方針）を直す。 */
  const updateStoryPage = (pageNo: number, patch: Partial<ComicStoryPage>) => {
    setStoryPages((prev) =>
      prev.map((p) => (p.page === pageNo ? { ...p, ...patch } : p)),
    );
  };

  /** 構成のコマを直す（ページ内 index 指定）。 */
  const updateStoryPanel = (
    pageNo: number,
    panelIndex: number,
    patch: Partial<ComicPanel>,
  ) => {
    setStoryPages((prev) =>
      prev.map((p) =>
        p.page === pageNo
          ? {
              ...p,
              panels: p.panels.map((panel) =>
                panel.index === panelIndex ? { ...panel, ...patch } : panel,
              ),
            }
          : p,
      ),
    );
  };

  /**
   * e57 + r83 (2026-08-03): 構成確認での位置指定コマ挿入。
   * B-4 の末尾追記 (addStoryPanel) を afterPosition 指定へ一般化したもの。
   *
   * afterPosition は 0..panels.length（0 = ページ先頭、panels.length = 末尾）。
   * 挿入後は index を 1..N へ振り直す。panelCount と panels.length の同時更新を
   * 守る (ズレると buildFullPagePrompt の "${panels.length} panels" 句と食い違う)。
   * 上限は MAX_PANELS_PER_PAGE。
   *
   * preset="transition" は場面転換（間）のプリセット内容が入った通常コマ。
   * 専用フラグは持たせない（下流に特別扱いを増やさず、普通のコマとして育て直せる）。
   */
  const insertStoryPanel = (
    pageNo: number,
    afterPosition: number,
    preset: "blank" | "transition",
  ) => {
    setStoryPages((prev) =>
      prev.map((p) => {
        if (p.page !== pageNo || p.panels.length >= MAX_PANELS_PER_PAGE) return p;
        const newPanel: ComicPanel =
          preset === "transition"
            ? {
                index: 0, // 直後の renumber で 1..N へ振り直す
                composition: "場面転換（間）",
                characters: [],
                acting: "",
                balloons: [],
                sfx: [],
                prompt:
                  "scene transition panel: scenery or background only, no characters, no dialogue — a quiet pause that shows time passing or a change of location",
              }
            : {
                index: 0,
                composition: "",
                characters: [],
                acting: "",
                balloons: [],
                sfx: [],
                prompt: "",
              };
        const at = Math.max(0, Math.min(afterPosition, p.panels.length));
        const panels = [
          ...p.panels.slice(0, at),
          newPanel,
          ...p.panels.slice(at),
        ].map((panel, i) => ({ ...panel, index: i + 1 }));
        return { ...p, panelCount: panels.length, panels };
      }),
    );
  };

  /** B-4: コマ削除。最低1コマは残す。index は 1..N に振り直す。 */
  const removeStoryPanel = (pageNo: number, panelIndex: number) => {
    setStoryPages((prev) =>
      prev.map((p) => {
        if (p.page !== pageNo || p.panels.length <= 1) return p;
        const panels = p.panels
          .filter((panel) => panel.index !== panelIndex)
          .map((panel, i) => ({ ...panel, index: i + 1 }));
        return { ...p, panelCount: panels.length, panels };
      }),
    );
  };

  /**
   * 未紐付けの cast 名 fromName を、登録キャラ名 toName へ割り当てる。
   *
   * 同じ誤名は複数ページに出るため、**構成全体**（全ページの cast・コマの
   * characters・吹き出しの speaker）を1回の操作で置き換える。
   */
  const assignCastName = (fromName: string, toName: string) => {
    /** 初出順維持の完全一致 dedupe。 */
    const dedupe = (names: string[]): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
      return out;
    };
    setStoryPages((prev) =>
      prev.map((p) => ({
        ...p,
        cast: dedupe(p.cast.map((n) => (n === fromName ? toName : n))),
        panels: p.panels.map((panel) => ({
          ...panel,
          characters: dedupe(
            panel.characters.map((n) => (n.trim() === fromName ? toName : n)),
          ),
          // speaker は表示専用（生成プロンプトに入らない）だが、旧名残置は編集 UI を混乱させるので揃える
          balloons: panel.balloons.map((b) =>
            b.speaker.trim() === fromName ? { ...b, speaker: toName } : b,
          ),
        })),
      })),
    );
  };

  /**
   * 完成ページの一部だけを再生成する。AI返却画像はそのまま採用せず、
   * 確定マスクの白領域だけを元ページへ合成できたときだけ正本を更新する。
   */
  const regeneratePanel = async (
    page: ComicStoryPage,
    draftPanel: ComicPanel,
    points: PanelReeditPoint[],
  ): Promise<PanelReeditOutcome> => {
    const currentResult = pageResults.find((result) => result.page === page.page);
    const originalPath = currentResult?.imagePath;
    if (
      !originalPath ||
      panelReeditActiveRef.current ||
      generatingStory ||
      generatingPages ||
      pageResults.some((result) => result.generating)
    ) {
      return { adopted: false, error: "今は1コマ再生成を始められません。ほかの生成が終わってから、もう一度お試しください。" };
    }

    const currentPage = storyPages.find((item) => item.page === page.page);
    const originalPanel = currentPage?.panels.find((panel) => panel.index === draftPanel.index);
    if (!currentPage || !originalPanel) {
      return { adopted: false, error: "編集元のページ情報を確認できません。モーダルを閉じて、ページを開き直してください。" };
    }

    // スロットの正は「テンプレ」ではなく「このページの実効スロット」。
    // 分割/統合したページは slotsOverride が正で、テンプレ座標は実描画と無関係になる。
    const effectiveSlots = currentPage.slotsOverride
      ?? (storyTemplateId ? getComicTemplate(storyTemplateId).slots : null);
    if (!effectiveSlots || currentPage.panels.length !== effectiveSlots.length) {
      return { adopted: false, error: "コマ割りの情報とコマ数が一致しないため、このページは編集できません。" };
    }
    // buildPanelImagePrompt は型で faithful を拒否する。mono 句で代替するとページ内の
    // 1コマだけ画風が割れるため、変換せず未対応として正直に止める（入口ゲートと二重防御）。
    const pageColorMode = currentResult?.colorMode ?? colorMode;
    if (pageColorMode === "faithful") {
      return { adopted: false, error: "「キャラ忠実」で生成したページは1コマ再生成に未対応です。" };
    }
    // qvs: そのページを生成した時の絵柄。faithful ページは上のゲートで弾かれるため
    // ここへ来る記録値は常に非 faithful。
    const pageStyleText = currentResult?.styleText ?? "";

    const runToken = panelReeditTokenRef.current + 1;
    panelReeditTokenRef.current = runToken;
    panelReeditActiveRef.current = true;
    setPanelReeditRunningPage(page.page);
    const track = beginDirectRun("comic", 1);
    registerDirectRunParent(track.id, {
      onCancel: () => {
        panelReeditTokenRef.current += 1;
        panelReeditActiveRef.current = false;
        setPanelReeditRunningPage(null);
      },
      onLateCancelError: (error) => {
        pushToast({
          kind: "error",
          text: `コマ ${draftPanel.index} の中止に失敗しました（${(error as Error)?.message ?? error}）`,
          ttlMs: 6000,
        });
      },
    });
    const stillMine = () => isCurrentPanelReeditRun(runToken, panelReeditTokenRef.current);

    try {
      // 元画像を基準にマスクを作るので、マスクの寸法は元ページと必ず一致する。
      const constraints = { selectedSlotIndex: draftPanel.index - 1, slots: effectiveSlots };
      const mask = await createPanelMaskPng(originalPath, points, 6, constraints);
      if (!stillMine()) return { adopted: false, error: "再生成は中止されました。元ページは変更していません。必要なら範囲を確認して再実行してください。" };
      // providerへ渡すPNGと、採用時に使うRGBAはcreatePanelMaskPngの同じ結果から取る。
      const maskPath = await images.writeMask(originalPath, mask.pngBytes);
      if (!stillMine()) return { adopted: false, error: "再生成は中止されました。元ページは変更していません。必要なら範囲を確認して再実行してください。" };

      const resolution = resolvePanelReeditReferences(draftPanel, characters);
      const prompt = [
        buildPanelImagePrompt(
          draftPanel,
          resolution.characters,
          pageColorMode,
          resolution.refPaths.length > 0,
          // qvs: 入力欄の現在値ではなく「そのページを生成した時の記録値」を使う
          // （ページと再編集コマの絵柄割れを防ぐ）。
          pageStyleText,
        ),
        `Edit only panel ${draftPanel.index} of this existing manga page. Page context: ${currentPage.synopsis}. Keep every pixel outside the supplied white mask unchanged. The visible panel border and gutter are protected and must remain unchanged.`,
      ].join(" ");
      const generated = await images.generateBatch(buildPanelReeditGenerationRequest(
        prompt,
        originalPath,
        maskPath,
        resolution.refPaths,
        track.id,
      ));
      if (!stillMine()) {
        return { adopted: false, error: "再生成は中止されました。元ページは変更していません。必要なら範囲を確認して再実行してください。" };
      }
      if (generated.cancelled) {
        return { adopted: false, error: "AIによる再生成が中止されました。元ページは変更していません。範囲と指示を確認して、もう一度お試しください。" };
      }
      const generatedPath = generated.generatedPaths[0];
      if (!generatedPath || generated.failedCount > 0) {
        throw new Error(generated.errors[0] ?? "コマの再生成画像を取得できませんでした。");
      }

      const composite = await compositePanelImages(originalPath, generatedPath, mask.raster);
      if (!stillMine()) return { adopted: false, error: "再生成は中止されました。元ページは変更していません。必要なら範囲を確認して再実行してください。" };
      if (composite.outsideDifferences !== 0) {
        throw new Error("マスク外の画素が変化したため採用しませんでした。");
      }
      const compositePath = await images.writeUpload(
        `comic-panel-reedit-p${page.page}-c${draftPanel.index}-${Date.now()}.png`,
        composite.bytes,
      );
      if (!stillMine()) return { adopted: false, error: "再生成は中止されました。元ページは変更していません。必要なら範囲を確認して再実行してください。" };

      // 成功したこの瞬間だけ、画像とページ構成を同じ履歴単位で差し替える。
      const historyEntry: PanelReeditHistoryEntry = {
        page: page.page,
        imagePath: originalPath,
        pageSnapshot: currentPage,
      };
      setStoryPages((previous) =>
        previous.map((item) =>
          item.page === page.page
            ? {
                ...item,
                panels: item.panels.map((panel) =>
                  panel.index === draftPanel.index ? draftPanel : panel,
                ),
              }
            : item,
        ),
      );
      setPageResults((previous) =>
        previous.map((result) =>
          result.page === page.page ? { ...result, imagePath: compositePath, error: undefined } : result,
        ),
      );
      setPanelReeditHistory((previous) => [...previous, historyEntry]);
      pushToast({
        kind: "success",
        text: `ページ ${page.page} のコマ ${draftPanel.index} だけを差し替えました。`,
        ttlMs: 4000,
      });
      return { adopted: true };
    } catch (error) {
      if (stillMine()) {
        pushToast({
          kind: "error",
          text: `コマ ${draftPanel.index} は変更せずに停止しました: ${(error as Error)?.message ?? error}`,
          ttlMs: 6500,
        });
      }
      return {
        adopted: false,
        error: `採用できませんでした: ${String((error as Error)?.message ?? error).replace(/。+$/, "")}。元ページは変更していません。範囲・指示・画像サイズを確認して、もう一度お試しください。`,
      };
    } finally {
      if (stillMine()) {
        panelReeditActiveRef.current = false;
        setPanelReeditRunningPage(null);
      }
      track.done();
      releaseDirectRunParent(track.id);
    }
  };

  /** 最後に成功した再編集だけを、画像とページ構成を揃えて戻す。 */
  const undoPanelReedit = (pageNo: number) => {
    if (panelReeditActiveRef.current) return;
    const historyIndex = panelReeditHistory.map((entry) => entry.page).lastIndexOf(pageNo);
    if (historyIndex < 0) return;
    const entry = panelReeditHistory[historyIndex];
    setStoryPages((previous) =>
      previous.map((page) => (page.page === entry.page ? entry.pageSnapshot : page)),
    );
    setPageResults((previous) =>
      previous.map((result) =>
        result.page === entry.page ? { ...result, imagePath: entry.imagePath, error: undefined } : result,
      ),
    );
    setPanelReeditHistory((previous) => previous.filter((_, index) => index !== historyIndex));
    pushToast({ kind: "info", text: `ページ ${pageNo} の直前のコマ編集を戻しました。`, ttlMs: 3500 });
  };

  /**
   * レイアウト操作（分割/統合）共通の入口ガード。
   *
   * AI 生成を伴わないが、書き込み中の多重操作・保存・ページ生成を再編集と同じ柵で塞ぐ。
   * beginDirectRun は使わない（中止対象の外部プロセスが無く、キャンセル UI に出すと
   * 「中止できる」という嘘になる）。
   */
  const prepareLayoutOp = (
    page: ComicStoryPage,
  ):
    | { ok: true; currentPage: ComicStoryPage; imagePath: string; slots: ComicPanelSlot[] }
    | { ok: false; error: string } => {
    const currentResult = pageResults.find((result) => result.page === page.page);
    const imagePath = currentResult?.imagePath;
    if (
      !imagePath ||
      panelReeditActiveRef.current ||
      generatingStory ||
      generatingPages ||
      pageResults.some((result) => result.generating)
    ) {
      return { ok: false, error: "今は1コマ再生成を始められません。ほかの生成が終わってから、もう一度お試しください。" };
    }
    const currentPage = storyPages.find((item) => item.page === page.page);
    if (!currentPage) {
      return { ok: false, error: "編集元のページ情報を確認できません。モーダルを閉じて、ページを開き直してください。" };
    }
    const slots = currentPage.slotsOverride
      ?? (storyTemplateId ? getComicTemplate(storyTemplateId).slots : null);
    if (!slots || currentPage.panels.length !== slots.length) {
      return { ok: false, error: "コマ割りの情報とコマ数が一致しないため、このページは編集できません。" };
    }
    return { ok: true, currentPage, imagePath, slots };
  };

  /**
   * 非テンプレページ（おまかせ / コマ追加後 / 1-2コマ構成）のコマ割りを、
   * 完成画像の線から復元して slotsOverride に採用する。
   *
   * slotsOverride は「このページの実枠の正」として全下流に配線済みなので、
   * 採用に成功した瞬間からテンプレページと同じコードパス（1コマ再生成・分割/統合・undo）に乗る。
   *
   * 呼ぶのは「1コマずつ直す」を押した瞬間のオンデマンド1回だけ（ページ生成時の常時実行はしない）。
   * 不採用時は storyPages を一切変更しない（元ページ・構成データ不変）。
   */
  const recoverAndAdoptSlots = async (page: ComicStoryPage): Promise<SlotRecoveryOutcome> => {
    const currentResult = pageResults.find((result) => result.page === page.page);
    const imagePath = currentResult?.imagePath;
    if (
      !imagePath ||
      panelReeditActiveRef.current ||
      generatingStory ||
      generatingPages ||
      pageResults.some((result) => result.generating)
    ) {
      return { adopted: false, error: "今は1コマ再生成を始められません。ほかの生成が終わってから、もう一度お試しください。" };
    }
    const currentPage = storyPages.find((item) => item.page === page.page);
    if (!currentPage) {
      return { adopted: false, error: "編集元のページ情報を確認できません。モーダルを閉じて、ページを開き直してください。" };
    }
    // 既に実枠が確定しているページは復元しない（分割/統合の結果を上書きしない）。
    if (currentPage.slotsOverride) return { adopted: true };

    const imageData = await readPanelImageData(imagePath);
    const recovery = recoverPanelSlots(imageData);
    if (!recovery.ok) {
      if (recovery.failureCode === "too-many-panels") {
        return {
          adopted: false,
          error: `画像から${recovery.detectedCount ?? 0}コマを認識しましたが、1ページの上限（${MAX_PANELS_PER_PAGE}コマ）を超えるため編集できません。元のページは変更していません。`,
        };
      }
      return {
        adopted: false,
        error: "このページのコマ割りを自動認識できませんでした（白いコマ間隔を見つけられませんでした）。ページを再生成すると認識しやすいコマ割りになることがあります。元のページは変更していません。",
      };
    }
    if (recovery.slots.length !== currentPage.panels.length) {
      return {
        adopted: false,
        error: `コマ割りを認識しましたが、コマ数が構成と合いません（画像から${recovery.slots.length}コマ・構成は${currentPage.panels.length}コマ）。ページを再生成するか、構成のコマ数を合わせてから編集できます。元のページは変更していません。`,
      };
    }
    // D-2: await の間にページ再生成が完了していると、新しい画像へ旧画像の座標を
    // 書き戻してしまう。認識開始時と同じ画像・同じ構成のままかを採用直前に再照合し、
    // 変わっていたら黙って不採用にする（エラーではない。ユーザーは再生成の結果を見ている）。
    const latestResult = pageResultsRef.current.find((result) => result.page === page.page);
    const latestPage = storyPagesRef.current.find((item) => item.page === page.page);
    const stale =
      !latestPage ||
      latestResult?.imagePath !== imagePath ||
      latestResult?.generating === true ||
      latestPage.panels.length !== currentPage.panels.length ||
      latestPage.slotsOverride != null;
    if (stale) return { adopted: false, error: "", silent: true };
    setStoryPages((previous) =>
      previous.map((item) => (item.page === page.page ? { ...item, slotsOverride: recovery.slots } : item)),
    );
    return { adopted: true };
  };

  /**
   * コマを2分割する。読み順で後ろ側が空白コマになり、その中身は
   * 「確定した1コマを再生成」で埋められる（枠はコード描画＝決定論）。
   */
  const splitStoryPanelOnImage = async (
    page: ComicStoryPage,
    panelIndex: number,
    direction: SplitDirection,
  ): Promise<PanelReeditOutcome> => {
    const prepared = prepareLayoutOp(page);
    if (!prepared.ok) return { adopted: false, error: prepared.error };
    const { currentPage, imagePath, slots } = prepared;
    if (currentPage.panels.length >= MAX_PANELS_PER_PAGE) {
      return {
        adopted: false,
        error: `1ページのコマ数が上限（${MAX_PANELS_PER_PAGE}）のため、これ以上分割できません。`,
      };
    }
    const targetSlot = slots[panelIndex - 1];
    if (!targetSlot) {
      return { adopted: false, error: "編集元のページ情報を確認できません。モーダルを閉じて、ページを開き直してください。" };
    }

    panelReeditActiveRef.current = true;
    setPanelReeditRunningPage(page.page);
    try {
      const { first, second } = splitSlotQuads(targetSlot, direction);
      const nextPage = splitStoryPage(currentPage, panelIndex, first, second, slots);
      const nextSlots = nextPage.slotsOverride ?? [];
      // 新しいスロット集合の中で、両方が隣接制約を満たすことを画像へ書く前に確認する。
      validatePanelPolygon(panelGuidePoints(first), {
        selectedSlotIndex: panelIndex - 1,
        slots: nextSlots,
      });
      validatePanelPolygon(panelGuidePoints(second), {
        selectedSlotIndex: panelIndex,
        slots: nextSlots,
      });
      const bytes = await applyPanelSplitToImage(
        imagePath,
        panelGuidePoints(targetSlot),
        panelGuidePoints(first),
        panelGuidePoints(second),
        direction,
      );
      const nextImagePath = await images.writeUpload(
        `comic-panel-split-p${page.page}-${Date.now()}.png`,
        bytes,
      );
      const historyEntry: PanelReeditHistoryEntry = {
        page: page.page,
        imagePath,
        pageSnapshot: currentPage,
      };
      setStoryPages((previous) =>
        previous.map((item) => (item.page === page.page ? nextPage : item)),
      );
      setPageResults((previous) =>
        previous.map((result) =>
          result.page === page.page
            ? { ...result, imagePath: nextImagePath, error: undefined }
            : result,
        ),
      );
      setPanelReeditHistory((previous) => [...previous, historyEntry]);
      pushToast({
        kind: "success",
        text: `ページ ${page.page} のコマ ${panelIndex} を2つに分割しました。空白になったコマ ${panelIndex + 1} は「確定した1コマを再生成」で中身を作れます。`,
        ttlMs: 6000,
      });
      return { adopted: true };
    } catch (error) {
      return {
        adopted: false,
        error: `コマ割りを変更できませんでした: ${(error as Error)?.message ?? error}。元ページは変更していません。`,
      };
    } finally {
      panelReeditActiveRef.current = false;
      setPanelReeditRunningPage(null);
    }
  };

  /**
   * 隣り合う2コマを統合する（= 枠線ごと消して1つのコマにする＝「コマを消す」の実体）。
   * 絵は消さず、間の帯（旧ガター + 旧枠線）だけを白へ戻す。
   */
  const mergeStoryPanelsOnImage = async (
    page: ComicStoryPage,
    panelIndex: number,
    neighborIndex: number,
  ): Promise<PanelReeditOutcome> => {
    const prepared = prepareLayoutOp(page);
    if (!prepared.ok) return { adopted: false, error: prepared.error };
    const { currentPage, imagePath, slots } = prepared;
    if (!adjacentSlotIndices(slots, panelIndex - 1).includes(neighborIndex - 1)) {
      return { adopted: false, error: "このコマに隣り合うコマがないため統合できません。" };
    }
    const slotA = slots[panelIndex - 1];
    const slotB = slots[neighborIndex - 1];
    if (!slotA || !slotB) {
      return { adopted: false, error: "編集元のページ情報を確認できません。モーダルを閉じて、ページを開き直してください。" };
    }

    panelReeditActiveRef.current = true;
    setPanelReeditRunningPage(page.page);
    try {
      const merged = mergedSlot(slotA, slotB);
      const nextPage = mergeStoryPage(currentPage, panelIndex, neighborIndex, merged.slot, slots);
      const nextSlots = nextPage.slotsOverride ?? [];
      // 統合後の残るコマの index（読み順で先のコマが残る）。
      const keptIndex = Math.min(panelIndex, neighborIndex);
      validatePanelPolygon(panelGuidePoints(merged.slot), {
        selectedSlotIndex: keptIndex - 1,
        slots: nextSlots,
      });
      const bytes = await applyPanelMergeToImage(
        imagePath,
        panelGuidePoints(merged.slot),
        panelGuidePoints(slotA),
        panelGuidePoints(slotB),
        merged.axis,
      );
      const nextImagePath = await images.writeUpload(
        `comic-panel-merge-p${page.page}-${Date.now()}.png`,
        bytes,
      );
      const historyEntry: PanelReeditHistoryEntry = {
        page: page.page,
        imagePath,
        pageSnapshot: currentPage,
      };
      setStoryPages((previous) =>
        previous.map((item) => (item.page === page.page ? nextPage : item)),
      );
      setPageResults((previous) =>
        previous.map((result) =>
          result.page === page.page
            ? { ...result, imagePath: nextImagePath, error: undefined }
            : result,
        ),
      );
      setPanelReeditHistory((previous) => [...previous, historyEntry]);
      pushToast({
        kind: "success",
        text: `ページ ${page.page} のコマ ${panelIndex} と ${neighborIndex} を統合しました。境目が気になる場合は、統合したコマを再生成してください。`,
        ttlMs: 6000,
      });
      return { adopted: true };
    } catch (error) {
      return {
        adopted: false,
        error: `コマ割りを変更できませんでした: ${(error as Error)?.message ?? error}。元ページは変更していません。`,
      };
    } finally {
      panelReeditActiveRef.current = false;
      setPanelReeditRunningPage(null);
    }
  };

  /**
   * 1ページ分（ページ丸ごと1枚）を生成する。
   *
   * トークン設計（stillMine / resetTile / onCancel の分離）は
   * 実測でソフトロックを潰した構造なので、簡略化しない。
   * 参照画像は resolvePageCast（そのページの cast のみ・上限 MAX_PAGE_REFERENCES）で
   * 決める。構成確認の PageCastRow と同じ判定を使うので、表示と実際の添付がズレない。
   *
   * 戻り値は「このページが画像まで到達したか」。
   */
  const generateStoryPage = async (
    page: ComicStoryPage,
    batchToken?: number,
    sourceTag?: string,
  ): Promise<boolean> => {
    if (panelReeditActiveRef.current || (batchToken === undefined && generatingPages)) return false;
    const runToken = batchToken ?? pagesRunTokenRef.current;
    if (pagesRunTokenRef.current !== runToken) return false;

    // このページだけの中止トークン。単体生成の中止は「押したページ」にしか効かない。
    const pageTokens = pageTokensRef.current;
    const pageToken = (pageTokens.get(page.page) ?? 0) + 1;
    pageTokens.set(page.page, pageToken);

    /** このページのタイルを未生成へ戻す（冪等）。 */
    const resetPageTile = () => {
      setPageResults((prev) =>
        prev.map((r) =>
          r.page === page.page ? { ...r, generating: false, startedAt: undefined } : r,
        ),
      );
    };

    /** 自分の走行がまだ有効か。無効ならタイルを未生成へ戻してから抜ける。 */
    const stillMine = (): boolean => {
      if (
        pagesRunTokenRef.current === runToken &&
        pageTokens.get(page.page) === pageToken
      ) {
        return true;
      }
      resetPageTile();
      return false;
    };

    // 単体生成のときは自前で親 run を立てる。
    let soloTrack: ReturnType<typeof beginDirectRun> | null = null;
    if (!sourceTag) {
      soloTrack = beginDirectRun("comic", 1);
      registerDirectRunParent(soloTrack.id, {
        onCancel: () => {
          // 全ページ一括の pagesRunTokenRef は触らない（他ページの走行を殺さない）。
          pageTokens.set(page.page, pageToken + 1);
          resetPageTile();
        },
        onLateCancelError: (error) => {
          pushToast({
            kind: "error",
            text: `ページ ${page.page} の中止に失敗しました（${(error as Error)?.message ?? error}）`,
            ttlMs: 6000,
          });
        },
      });
    }
    const tag = sourceTag ?? soloTrack?.id;

    const startedAt = Date.now();
    setPageResults((prev) =>
      prev.map((r) =>
        r.page === page.page ? { ...r, generating: true, error: undefined, startedAt } : r,
      ),
    );
    try {
      const storyTemplate = storyTemplateId ? getComicTemplate(storyTemplateId) : null;
      // B-4 (2026-07-30): コマ追加/削除でテンプレとコマ数がズレたページは、テンプレの
      // 段組み記述・位置語が実態と矛盾するため「おまかせ」扱い (template=null) で生成する。
      const template =
        storyTemplate && storyTemplate.panelCount === page.panels.length
          ? storyTemplate
          : null;
      // このページの cast だけを参照・属性・限定句の基準にする（PageCastRow と同じ判定）。
      const resolution = resolvePageCast(page, characters, envReferences);
      const refPaths = resolution.refPaths;
      // 前後ページのあらすじは構成 state から引く（隣接ページのみ）。
      const idx = storyPages.findIndex((p) => p.page === page.page);
      const prompt = buildFullPagePrompt(
        page.panels,
        template,
        resolution.castCharacters,
        colorMode,
        // 3ir: identity/pose 句はキャラ参照があるときだけ（環境参照だけのとき、
        // ドアを「manga character として描き直せ」と言わない）。
        resolution.charRefCount > 0,
        {
          pageNumber: page.page,
          totalPages: storyPages.length,
          prevSynopsis: idx > 0 ? storyPages[idx - 1].synopsis : undefined,
          currentSynopsis: page.synopsis,
          nextSynopsis:
            idx >= 0 && idx < storyPages.length - 1
              ? storyPages[idx + 1].synopsis
              : undefined,
          layoutHint: page.layoutHint,
          // fallback は誰が正か不明なので限定句を出さない。none は cast 自体が無い。
          castNames:
            resolution.mode === "matched" ? resolution.matchedNames : undefined,
          readingDirection,
          frameStyle,
          gutterStyle,
          envReferences: resolution.envReferences.map(({ name, kind }) => ({
            name,
            kind,
          })),
          charRefCount: resolution.charRefCount,
          styleText: colorMode === "faithful" ? undefined : styleText,
        },
      );
      const res = await images.generateBatch({
        prompt,
        count: 1,
        refImagePaths: refPaths.length > 0 ? refPaths : undefined,
        // ページは縦。値はテンプレの pageAspect から導出する（決め打ちしない）。
        aspect: COMIC_PAGE_ASPECT,
        sourceTag: tag,
      });
      if (!stillMine()) return false;
      // 中止は失敗ではない。エラー表示にせず未生成へ戻す。
      if (res.cancelled) {
        resetPageTile();
        return false;
      }
      const imagePath = res.generatedPaths[0];
      if (!imagePath) {
        throw new Error(res.errors[0] ?? "画像が生成されませんでした");
      }
      setPageResults((prev) =>
        prev.map((r) =>
          r.page === page.page
            ? {
                ...r,
                generating: false,
                imagePath,
                startedAt: undefined,
                // この画像が実際にどの条件で作られたかを記録する（1コマ再編集の対応判定の正）。
                direction: readingDirection,
                colorMode,
                styleText:
                  colorMode === "faithful" ? undefined : styleText.trim() || undefined,
              }
            : r,
        ),
      );
      // ページ丸ごと再生成した画像は分割/統合前のレイアウトへ戻る（フリーフォーム含む）ため、
      // 旧画像に紐づくスロット上書きは新画像の正にならない。黙って古い座標で編集させない。
      setStoryPages((prev) =>
        prev.map((p) => (p.page === page.page && p.slotsOverride ? { ...p, slotsOverride: undefined } : p)),
      );
      // このページのコマ編集履歴も無効化する (Codex検分 2026-07-30)。
      // 残すと「戻す」が再生成前の画像とスロットを復元し、いま画面にある新しい絵を
      // 古い状態へ巻き戻してしまう（別レイアウトの混入）。
      setPanelReeditHistory((prev) => prev.filter((entry) => entry.page !== page.page));
      return true;
    } catch (err) {
      if (!stillMine()) return false;
      const message = (err as Error)?.message ?? String(err);
      setPageResults((prev) =>
        prev.map((r) =>
          r.page === page.page
            ? { ...r, generating: false, error: message, startedAt: undefined }
            : r,
        ),
      );
      pushToast({
        kind: "error",
        text: `ページ ${page.page} の生成に失敗しました`,
        ttlMs: 5000,
      });
      return false;
    } finally {
      if (soloTrack) {
        soloTrack.done();
        releaseDirectRunParent(soloTrack.id);
      }
    }
  };

  /**
   * 全ページを並列生成する。
   * 絞りは Rust の GLOBAL_GEN_SEMAPHORE 一本（フロントに上限を作らない）。
   */
  const generateAllStoryPages = async (): Promise<boolean> => {
    if (
      panelReeditActiveRef.current ||
      generatingPages ||
      pageResults.some((result) => result.generating)
    ) return false;
    const runToken = pagesRunTokenRef.current;
    setGeneratingPages(true);
    const track = beginDirectRun("comic", storyPages.length);
    registerDirectRunParent(track.id, {
      onCancel: () => {
        pagesRunTokenRef.current += 1;
        setGeneratingPages(false);
        setPageResults((prev) =>
          prev.map((r) =>
            r.generating ? { ...r, generating: false, startedAt: undefined } : r,
          ),
        );
      },
      onLateCancelError: (error) => {
        pushToast({
          kind: "error",
          text: `中止に失敗したページがあります（${(error as Error)?.message ?? error}）`,
          ttlMs: 6000,
        });
      },
    });
    try {
      const settled = await Promise.allSettled(
        storyPages.map((page) => generateStoryPage(page, runToken, track.id)),
      );
      if (pagesRunTokenRef.current !== runToken) return false;
      return (
        storyPages.length > 0 &&
        settled.every((r) => r.status === "fulfilled" && r.value === true)
      );
    } finally {
      track.done();
      releaseDirectRunParent(track.id);
      if (pagesRunTokenRef.current === runToken) setGeneratingPages(false);
    }
  };

  /**
   * 構成確認からの一括生成。**先にページ一覧へ移ってから**生成を始める。
   * 全ページ完了を待たずに、1ページずつカードのゲージへ進捗が届く。
   */
  const generatePagesFromPlan = () => {
    if (panelReeditActiveRef.current) return;
    setPhase("pages");
    void generateAllStoryPages();
  };

  return (
    <>
      <ComicPhaseRail
        phase={phase}
        setPhase={requestPhaseChange}
        hasStory={storyPages.length > 0}
        generating={panelReeditActiveRef.current || generatingPages || pageResults.some((r) => r.generating)}
        completed={pageResults.filter((r) => r.imagePath).length}
        total={storyPages.length}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 text-neutral-200">
          <PageHelp
            what="話を渡すと、AI がページ構成からコマ割り・セリフまで設計し、吹き出しや擬音も絵として描いた漫画ページを一気に生成します。複数ページの連続ストーリーも作れます。"
            first="まずは下の「話（あらすじ）」に、どんな話にしたいかを書いてください。"
            note="セリフの文字は絵として描かれるため、まれに崩れることがあります。"
          />

          {phase === "input" && (
            <InputPhase
              synopsis={synopsis}
              setSynopsis={setSynopsis}
              templateId={templateId}
              setTemplateId={setTemplateId}
              colorMode={colorMode}
              setColorMode={setColorMode}
              styleText={styleText}
              setStyleText={setStyleText}
              envReferences={envReferences}
              onPickEnvFiles={() => void pickEnvImageFiles()}
              onOpenEnvLibrary={() => setEnvLibraryOpen(true)}
              onRenameEnvRef={renameEnvReference}
              onRestoreEnvRefName={restoreEnvRefName}
              onToggleEnvRefKind={toggleEnvRefKind}
              onRemoveEnvRef={removeEnvReference}
              readingDirection={readingDirection}
              setReadingDirection={setReadingDirection}
              frameStyle={frameStyle}
              setFrameStyle={setFrameStyle}
              gutterStyle={gutterStyle}
              setGutterStyle={setGutterStyle}
              pageCountChoice={pageCountChoice}
              setPageCountChoice={setPageCountChoice}
              characterPresets={characterPresets}
              selectedIds={selectedIds}
              toggleCharacter={toggleCharacter}
              imageCharacters={imageCharacters}
              onPickFiles={() => void pickImageFiles()}
              onOpenLibrary={() => setLibraryOpen(true)}
              onRenameImageChar={renameImageCharacter}
              onRestoreImageCharName={restoreImageCharName}
              onRemoveImageChar={removeImageCharacter}
              generatingStory={generatingStory}
              storyStartedAt={storyStartedAt}
              storyProgress={storyProgress}
              onGenerate={generateStory}
              onCancelGenerate={cancelStoryGeneration}
            />
          )}

          {phase === "plan" && (
            <PlanPhase
              storyPages={storyPages}
              characters={characters}
              envReferences={envReferences}
              storyTemplateId={storyTemplateId}
              updateStoryPage={updateStoryPage}
              updateStoryPanel={updateStoryPanel}
              onInsertPanel={insertStoryPanel}
              onRemovePanel={removeStoryPanel}
              onAssignCast={assignCastName}
              onGeneratePages={generatePagesFromPlan}
              onRegenerateStory={() => void generateStory()}
              generatingStory={generatingStory}
              generatingPages={generatingPages}
            />
          )}

          {phase === "pages" && (
            <PagesPhase
              theme={synopsis}
              storyPages={storyPages}
              pageResults={pageResults}
              saveFormat={saveFormat}
              setSaveFormat={setSaveFormat}
              onGeneratePage={generateStoryPage}
              generatingPages={generatingPages}
              storyTemplateId={storyTemplateId}
              readingDirection={readingDirection}
              colorMode={colorMode}
              panelReeditRunningPage={panelReeditRunningPage}
              panelReeditBlocked={generatingStory || generatingPages || pageResults.some((r) => r.generating)}
              onRegeneratePanel={regeneratePanel}
              onUndoPanelReedit={undoPanelReedit}
              canUndoPanelReedit={(pageNo) => panelReeditHistory.some((entry) => entry.page === pageNo)}
              onSplitPanel={splitStoryPanelOnImage}
              onMergePanels={mergeStoryPanelsOnImage}
              onRecoverSlots={recoverAndAdoptSlots}
            />
          )}

        </div>
      </div>
      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(path) => addImageCharacters([path], "library")}
      />
      {/* 3ir: 環境参照用は別インスタンス。roleMode は使わない
          （グローバル referenceRoles ストアへ書く経路。漫画の env はセッション state が正）。 */}
      <ReferenceLibraryModal
        open={envLibraryOpen}
        onClose={() => setEnvLibraryOpen(false)}
        onPick={(path) => addEnvReferences([path], "library")}
      />
    </>
  );
}

/**
 * 多角形コマの枠線・塗りを描く SVG オーバーレイ。
 * ページ/サムネの percent 座標系 (0-100) を preserveAspectRatio="none" で
 * コンテナへ引き伸ばし、div の percent 配置と完全に一致させる。
 * vectorEffect="non-scaling-stroke" で線幅は表示pxで一定（縮小オフセット計算は不要）。
 */
function PolygonFrameOverlay({
  template,
  stroke,
  strokeWidth,
  fill = "none",
}: {
  template: ComicLayoutTemplate;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}) {
  const polys = template.slots.filter((s) => s.points);
  if (polys.length === 0) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {polys.map((slot, i) => (
        <polygon
          key={i}
          points={(slot.points ?? []).map((p) => p.join(",")).join(" ")}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/**
 * コマ割りテンプレのミニプレビュー。
 *
 * マンガ01〜12 は STΛCK 提供の参照画像を12分割したサムネ画像を出す
 * (COMIC_TEMPLATE_THUMBNAILS。STΛCK 指示 2026-07-28)。
 * それ以外はスロット定義（percent 座標）だけから CSS で描くので、画像アセットを
 * 持たずテンプレを足せば自動で絵が付く（配布時のリソース漏れも起きない）。
 */
function TemplateMiniPreview({
  template,
  selected,
}: {
  template: ComicLayoutTemplate;
  selected: boolean;
}) {
  const thumbnail = COMIC_TEMPLATE_THUMBNAILS[template.id];
  return (
    <div
      className={`relative w-full max-h-[72px] overflow-hidden rounded-sm border ${
        selected ? "border-pink-400 bg-white/90" : "border-[#3a3a3a] bg-[#0f0f0f]"
      }`}
      style={{ aspectRatio: `${template.pageAspect.w} / ${template.pageAspect.h}` }}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          className={`h-full w-full object-contain ${selected ? "" : "opacity-70 invert"}`}
        />
      ) : (
        <>
          {template.slots.map((slot, i) =>
            slot.points ? null : (
              <div
                key={i}
                className={`absolute border ${
                  selected ? "border-pink-600 bg-pink-500/20" : "border-neutral-600 bg-[#1c1c1c]"
                }`}
                style={{
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  width: `${slot.w}%`,
                  height: `${slot.h}%`,
                }}
              />
            ),
          )}
          <PolygonFrameOverlay
            template={template}
            stroke={selected ? "#db2777" : "#525252"}
            strokeWidth={1}
            fill={selected ? "rgba(236,72,153,0.2)" : "#1c1c1c"}
          />
        </>
      )}
    </div>
  );
}

function InputPhase({
  synopsis,
  setSynopsis,
  templateId,
  setTemplateId,
  colorMode,
  setColorMode,
  styleText,
  setStyleText,
  envReferences,
  onPickEnvFiles,
  onOpenEnvLibrary,
  onRenameEnvRef,
  onRestoreEnvRefName,
  onToggleEnvRefKind,
  onRemoveEnvRef,
  readingDirection,
  setReadingDirection,
  frameStyle,
  setFrameStyle,
  gutterStyle,
  setGutterStyle,
  pageCountChoice,
  setPageCountChoice,
  characterPresets,
  selectedIds,
  toggleCharacter,
  imageCharacters,
  onPickFiles,
  onOpenLibrary,
  onRenameImageChar,
  onRestoreImageCharName,
  onRemoveImageChar,
  generatingStory,
  storyStartedAt,
  storyProgress,
  onGenerate,
  onCancelGenerate,
}: {
  synopsis: string;
  setSynopsis: (v: string) => void;
  templateId: string;
  setTemplateId: (v: string) => void;
  colorMode: ComicColorMode;
  setColorMode: (v: ComicColorMode) => void;
  styleText: string;
  setStyleText: (v: string) => void;
  envReferences: ComicEnvReference[];
  onPickEnvFiles: () => void;
  onOpenEnvLibrary: () => void;
  onRenameEnvRef: (id: string, name: string) => void;
  onRestoreEnvRefName: (id: string) => void;
  onToggleEnvRefKind: (id: string) => void;
  onRemoveEnvRef: (id: string) => void;
  readingDirection: ComicReadingDirection;
  setReadingDirection: (v: ComicReadingDirection) => void;
  frameStyle: ComicFrameStyle;
  setFrameStyle: (v: ComicFrameStyle) => void;
  gutterStyle: ComicGutterStyle;
  setGutterStyle: (v: ComicGutterStyle) => void;
  pageCountChoice: PageCountChoice;
  setPageCountChoice: (v: PageCountChoice) => void;
  characterPresets: ReturnType<typeof usePresets.getState>["presets"];
  selectedIds: string[];
  toggleCharacter: (id: string) => void;
  imageCharacters: ComicImageCharacter[];
  onPickFiles: () => void;
  onOpenLibrary: () => void;
  onRenameImageChar: (id: string, name: string) => void;
  onRestoreImageCharName: (id: string) => void;
  onRemoveImageChar: (id: string) => void;
  generatingStory: boolean;
  storyStartedAt?: number;
  storyProgress?: ComicTextTurnProgress;
  onGenerate: () => void;
  onCancelGenerate: () => void;
}) {
  // B-3: あらすじ履歴。マウント時に読み込む (load は loaded ガード付きで冪等)。
  const historyItems = useComicStoryHistory((s) => s.items);
  const loadHistory = useComicStoryHistory((s) => s.load);
  const removeHistory = useComicStoryHistory((s) => s.remove);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="block text-xs font-medium text-neutral-400">
            話（あらすじ）
          </label>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-neutral-400 transition hover:border-pink-500/40 hover:text-pink-200"
          >
            履歴
          </button>
        </div>
        {historyOpen && (
          <div className="mb-2 max-h-48 overflow-y-auto rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
            {historyItems.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-neutral-500">
                履歴はまだありません。構成を生成すると自動で保存されます。
              </p>
            ) : (
              historyItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[#1f1f1f]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSynopsis(item.text);
                      setHistoryOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                    title={item.text}
                  >
                    <span className="block truncate text-[11px] text-neutral-200">
                      {item.text}
                    </span>
                    <span className="block text-[10px] text-neutral-600">
                      {new Date(item.createdAt).toLocaleString("ja-JP", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeHistory(item.id)}
                    className="rounded px-1 text-neutral-600 transition hover:text-rose-400"
                    aria-label="この履歴を削除"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}
        <textarea
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
          rows={5}
          placeholder="どんな話にする？ ざっくりでOK（例: 遅刻しそうな主人公が近道でトラブルに巻き込まれる）"
          className="w-full resize-y rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-pink-500/50 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          コマ割りの参考（任意）
        </label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {(() => {
            const selected = templateId === AUTO_TEMPLATE_ID;
            return (
              <button
                type="button"
                onClick={() => setTemplateId(AUTO_TEMPLATE_ID)}
                className={`flex w-full flex-col items-center gap-2 rounded-md border px-2 py-2 text-[11px] font-medium transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <div
                  className={`flex w-full max-h-[72px] items-center justify-center overflow-hidden rounded-sm border ${
                    selected
                      ? "border-pink-400 bg-pink-500/10"
                      : "border-[#3a3a3a] bg-[#0f0f0f]"
                  }`}
                  style={{ aspectRatio: "3 / 4" }}
                >
                  <span className="text-[11px]">AIが最適化</span>
                </div>
                <span className="flex flex-col items-center gap-0.5 leading-tight">
                  <span className="text-center">おまかせ</span>
                </span>
              </button>
            );
          })()}
          {COMIC_LAYOUT_TEMPLATES.map((t) => {
            const selected = templateId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplateId(t.id)}
                className={`flex w-full flex-col items-center gap-2 rounded-md border px-2 py-2 text-[11px] font-medium transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <TemplateMiniPreview template={t} selected={selected} />
                <span className="flex flex-col items-center gap-0.5 leading-tight">
                  <span className="text-center">{t.label}</span>
                  <span className="text-center text-[11px] font-normal text-neutral-400">
                    {t.panelCount}コマ
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          画風
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "mono", label: "白黒（標準）" },
              { value: "color", label: "カラー" },
              { value: "faithful", label: "キャラ忠実" },
            ] as const
          ).map((option) => {
            const selected = colorMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setColorMode(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {/* faithful のときだけ、何が起きるかを1行で説明する（他の画風には出さない）。 */}
        {colorMode === "faithful" && (
          <p className="mt-1 text-[11px] text-neutral-500">
            リファレンス画像の画風・質感をそのまま保って作ります（漫画調への変換をしません）。
          </p>
        )}
      </div>

      {/* qvs (2026-08-03): 絵柄をキャラ参照と分離したテキスト項目で指定する。
          faithful は参照画像が絵柄の供給源なので構造的に排他＝無効化する。 */}
      <div>
        <label
          className="mb-1.5 block text-xs font-medium text-neutral-400"
          htmlFor="comic-style-text"
        >
          絵柄の指定（任意）
        </label>
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {COMIC_STYLE_CHIPS.map((chip) => {
            const selected = styleText === chip.text;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => setStyleText(chip.text)}
                disabled={colorMode === "faithful"}
                aria-pressed={selected}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? "border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-500/40 hover:text-white"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        <input
          id="comic-style-text"
          value={styleText}
          onChange={(e) => setStyleText(e.target.value)}
          disabled={colorMode === "faithful"}
          placeholder="例: 劇画タッチ、太い主線、リアルな陰影"
          aria-label="絵柄の指定"
          className="w-full rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-pink-500/50 focus:outline-none disabled:opacity-40"
        />
        <p className="mt-1 text-[11px] text-neutral-500">
          {colorMode === "faithful"
            ? "「キャラ忠実」ではリファレンス画像の画風を使うため、絵柄の指定は無効になります。"
            : "白黒／カラーの選択が優先されます。絵柄はその中でのタッチの指定です（毎回同じ見た目になる保証はありません）。"}
        </p>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          読み方向
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "rtl", label: "右→左（日本式・標準）" },
              { value: "ltr", label: "左→右" },
            ] as const
          ).map((option) => {
            const selected = readingDirection === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setReadingDirection(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          枠線の太さ
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "thin", label: "細い" },
              { value: "standard", label: "標準" },
              { value: "bold", label: "太い" },
            ] as const
          ).map((option) => {
            const selected = frameStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setFrameStyle(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          コマの間隔
        </label>
        <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
          {(
            [
              { value: "narrow", label: "狭い" },
              { value: "standard", label: "標準" },
              { value: "wide", label: "広い" },
            ] as const
          ).map((option) => {
            const selected = gutterStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setGutterStyle(option.value)}
                aria-pressed={selected}
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                  selected
                    ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                    : "border border-transparent text-neutral-400 hover:text-pink-200"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          読み方向・枠線・コマ間隔・吹き出しの種類はAIへの指示で近づけます。毎回同じ見た目になる保証はありません。
        </p>
      </div>

      <div>
        <label
          className="mb-1.5 block text-xs font-medium text-neutral-400"
          htmlFor="comic-page-count"
        >
          ページ数
        </label>
        {/*
          ページ数の上限は撤廃（2026-07-28 STΛCK指示）。ページ生成は並列で発行し、
          Rust の GLOBAL_GEN_SEMAPHORE が順番に消化するため、枚数の安全弁は
          そちらが持つ。ここでは 1 以上であることだけを守る。
        */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={pageCountChoice === "auto"}
              onChange={(e) =>
                setPageCountChoice(e.target.checked ? "auto" : MAX_STORY_PAGES)
              }
              className="h-3.5 w-3.5 accent-pink-500"
            />
            おまかせ
          </label>
          <input
            id="comic-page-count"
            type="number"
            min={1}
            step={1}
            disabled={pageCountChoice === "auto"}
            value={pageCountChoice === "auto" ? "" : String(pageCountChoice)}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (!Number.isFinite(n) || n < 1) return;
              setPageCountChoice(n);
            }}
            className="w-20 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          登場キャラ（登録キャラ・画像から追加）
        </label>
        {characterPresets.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-3 text-xs text-neutral-500">
            登録キャラがありません。キャラを登録すると、同一キャラでコマを生成できます（キャラなしでも話は作れます）。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {characterPresets.map((p) => {
              const selected = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggleCharacter(p.id)}
                  className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${
                    selected
                      ? "border-pink-500 bg-pink-500/10 text-pink-100"
                      : "border-[#2a2a2a] bg-[#1a1a1a] text-neutral-300 hover:border-[#3a3a3a]"
                  }`}
                >
                  {p.thumbnail && (
                    <img src={p.thumbnail} alt="" className="h-6 w-6 rounded object-cover" />
                  )}
                  {p.name}
                </button>
              );
            })}
          </div>
        )}

        {imageCharacters.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {imageCharacters.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded">
                  <SafeImage
                    path={c.imagePath}
                    alt={c.name}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <input
                    value={c.name}
                    onChange={(e) => onRenameImageChar(c.id, e.target.value)}
                    // 空名はネーム配役・参照解決を壊すため、既定名へ戻す（黙って壊さない）。
                    onBlur={() => onRestoreImageCharName(c.id)}
                    className="w-24 rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                    aria-label="キャラ名"
                  />
                  <span className="text-[10px] text-neutral-500">
                    {c.source === "file" ? "添付" : "ライブラリ"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveImageChar(c.id)}
                  className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
                  title={`${c.name} を削除`}
                  aria-label={`${c.name} を削除`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onPickFiles}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            画像を追加
          </button>
          <button
            type="button"
            onClick={onOpenLibrary}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            ライブラリから選ぶ
          </button>
        </div>
      </div>

      {/* 3ir (2026-08-03): 背景・小物の環境参照。全ページに一律添付して
          「ドアのデザインがページ間で変わる」問題を直接解消する。 */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          背景・小物（ページ間でデザイン固定・任意）
        </label>
        {envReferences.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#2a2a2a] bg-[#1a1a1a] px-3 py-3 text-xs text-neutral-500">
            ドア・部屋・持ち物などの画像を追加すると、全ページで同じデザインに固定されやすくなります。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {envReferences.map((ref) => (
              <div
                key={ref.id}
                className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded">
                  <SafeImage
                    path={ref.imagePath}
                    alt={ref.name}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <input
                    value={ref.name}
                    onChange={(e) => onRenameEnvRef(ref.id, e.target.value)}
                    // 空名はプロンプトの参照名を壊すため、既定名へ戻す。
                    onBlur={() => onRestoreEnvRefName(ref.id)}
                    className="w-24 rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                    aria-label="参照の名前"
                  />
                  <button
                    type="button"
                    onClick={() => onToggleEnvRefKind(ref.id)}
                    title={REFERENCE_ROLE_META[ref.kind].description}
                    className="rounded border border-[#2a2a2a] bg-[#121212] px-1.5 py-0.5 text-[10px] text-neutral-300 transition hover:border-pink-500/40 hover:text-pink-200"
                  >
                    {REFERENCE_ROLE_META[ref.kind].label}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveEnvRef(ref.id)}
                  className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
                  title={`${ref.name} を削除`}
                  aria-label={`${ref.name} を削除`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onPickEnvFiles}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            画像を追加
          </button>
          <button
            type="button"
            onClick={onOpenEnvLibrary}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            ライブラリから選ぶ
          </button>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          背景・小物はAIへの指示と参照画像で近づけます。毎回完全に同じになる保証はありません。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onGenerate}
          disabled={generatingStory || !synopsis.trim()}
          className="flex items-center justify-center gap-2 rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generatingStory && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
          )}
          {generatingStory ? "構成を生成中…" : "構成を生成"}
        </button>
        {/* 通常の画像生成と同じ「ぐるぐる＋推定ゲージ」に揃える (2026-07-27 STΛCK指示)。 */}
        {generatingStory && (
          <div className="flex w-full flex-col items-center justify-center gap-3 rounded-md border border-[#2a2a2a] bg-[#181818] px-8 py-5">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
            {/*
              9qm (2026-08-04): 「生成中…」の一言だけだと、応答待ちで止まって
              いるのか書き出し中なのか分からず、5分待たされた末に打ち切られる
              体験になっていた。実態をそのまま出す。

              実装契約M (2026-08-05): 止まっても勝手に打ち切らなくなったので、
              "応答が止まっています" は**予告ではなく状況説明**。文言で
              「もうすぐ切れます」と読ませない（切らないので嘘になる）。
            */}
            <span
              className={`text-[12px] font-bold ${
                storyProgress?.phase === "stalled" ? "text-amber-300" : "text-pink-300"
              }`}
            >
              {storyProgress?.phase === "stalled"
                ? "応答が止まっています"
                : storyProgress?.phase === "streaming"
                  ? "構成を書き出し中…"
                  : "生成中…"}
            </span>
            <span className="text-[11px] text-neutral-400">
              {storyProgress?.phase === "stalled"
                ? `${Math.round((storyProgress.idleMs ?? 0) / 1000)} 秒ぶん応答がありません（${storyProgress.receivedChars.toLocaleString()} 文字を受信済み・待てば続くことがあります）`
                : storyProgress?.phase === "streaming"
                  ? `${storyProgress.receivedChars.toLocaleString()} 文字を受信`
                  : "AI の応答を待っています"}
            </span>
            {storyStartedAt ? (
              <div className="w-full max-w-xs">
                <GenerationGauge startedAt={storyStartedAt} mode="batch" />
              </div>
            ) : null}
            {/*
              やめる判断はユーザーがする（自動で切らなくなったため）。
              一等地に新ボタンを増やさず、進捗表示の中の控えめな導線に置く。
            */}
            <button
              type="button"
              onClick={onCancelGenerate}
              className="rounded-md border border-[#343434] px-3 py-1 text-[11px] font-bold text-neutral-300 transition hover:bg-[#242424] hover:text-white"
            >
              やめる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * このページの cast（登場キャラ）と、実際に添付される参照枚数を見せる行。
 *
 * 判定は resolvePageCast そのものを使うので、
 * ここに出るチップ＝実際にそのページの生成へ渡る参照、で一致する。
 * 未紐付け名（登録キャラと一致しない名前）は黄チップ自体がセレクトになっており、
 * 選ぶと構成全体でその名前を置き換える。
 */
function PageCastRow({
  page,
  characters,
  envReferences,
  onAssignCast,
}: {
  page: ComicStoryPage;
  characters: ComicCharacter[];
  /** 環境参照（3ir）。実添付と表示を同じ判定関数から出すため resolvePageCast へ渡す。 */
  envReferences: ComicEnvReference[];
  /** 未紐付け名 fromName を登録キャラ toName へ割り当てる（構成全体で置換） */
  onAssignCast: (fromName: string, toName: string) => void;
}) {
  const resolution = resolvePageCast(page, characters, envReferences);
  const envCount = envReferences.length;
  // キャラ未選択かつ環境参照も無いときは何も出さない（約束していないことを表示しない）。
  if (characters.length === 0 && envCount === 0) return null;

  const matchedSet = new Set(resolution.matchedNames.map((n) => n.trim()));
  const envCountText = resolution.envReferences.length;
  const statusText =
    resolution.mode === "matched"
      ? envCount > 0
        ? `参照画像 ${resolution.refPaths.length}枚を添付（キャラ${resolution.charRefCount}枚・背景小物${envCountText}枚）`
        : `参照画像 ${resolution.refPaths.length}枚を添付`
      : resolution.mode === "fallback"
        ? envCount > 0
          ? `参照: 選択キャラ全員（登場キャラ名が登録キャラと一致しないため）＋背景小物${envCountText}枚`
          : "参照: 選択キャラ全員（登場キャラ名が登録キャラと一致しないため）"
        : envCount > 0
          ? `参照: 背景・小物 ${envCountText}枚を添付（このページにキャラ登場なし）`
          : "参照なし（このページにキャラ登場なし）";
  const statusClass =
    resolution.mode === "fallback" ? "text-amber-200" : "text-neutral-500";

  return (
    <>
      {resolution.castNames.map((name) =>
        matchedSet.has(name) ? (
          <span
            key={name}
            className="rounded bg-pink-500/10 px-2 py-0.5 text-[11px] text-pink-200"
          >
            {name}
          </span>
        ) : (
          <select
            key={name}
            value=""
            title="登録キャラと名前が一致しないため、このページの参照画像に使われません。割り当てると構成全体でこの名前を置き換えます"
            onChange={(e) => {
              if (e.target.value) onAssignCast(name, e.target.value);
            }}
            className="cursor-pointer rounded border border-amber-500/40 bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200"
          >
            <option value="">⚠ {name}（未紐付け）</option>
            {characters.map((c) => (
              <option key={c.name} value={c.name}>
                → {c.name} に割り当てる
              </option>
            ))}
          </select>
        ),
      )}
      <span className={`text-[11px] ${statusClass}`}>{statusText}</span>
    </>
  );
}

/**
 * コマ境界の挿入バー（e57 + r83 2026-08-03）。
 *
 * 各コマカードの間（ページ先頭と末尾を含む、コマ数+1箇所）に常時表示し、
 * 「そこに挿す」を位置の数値入力なしで直感的に伝える。
 * 場面転換コマは専用フラグを持たない「プリセット内容入りの通常コマ」。
 */
function PanelInsertBar({
  full,
  onInsert,
}: {
  /** コマ数が上限に達しているか（両ボタンを disabled にする）。 */
  full: boolean;
  onInsert: (preset: "blank" | "transition") => void;
}) {
  const buttonClass =
    "rounded border border-dashed border-[#2a2a2a] bg-[#141414] px-2 py-1 text-[11px] text-neutral-400 transition hover:border-pink-500/40 hover:text-pink-200 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <span className="h-px flex-1 bg-[#242424]" />
      <button
        type="button"
        onClick={() => onInsert("blank")}
        disabled={full}
        title={full ? "1ページは最大8コマです" : "この位置にコマを挿入"}
        className={buttonClass}
      >
        ＋コマを追加
      </button>
      <button
        type="button"
        onClick={() => onInsert("transition")}
        disabled={full}
        title={full ? "1ページは最大8コマです" : "この位置に間・場面転換の空白コマを挿入"}
        className={buttonClass}
      >
        ＋場面転換コマ
      </button>
      <span className="h-px flex-1 bg-[#242424]" />
    </div>
  );
}

/**
 * 構成の確認（主経路の工程の要）。
 *
 * ページ単位のあらすじ・コマ割り方針と、
 * 各コマの構図・演技・セリフ・擬音・生成プロンプトを直せる。
 * ページ数はここでは変えられない。コマ数は追加/削除できる（テンプレとズレた
 * ページはおまかせレイアウトで生成）。
 */
function PlanPhase({
  storyPages,
  characters,
  envReferences,
  storyTemplateId,
  updateStoryPage,
  updateStoryPanel,
  onInsertPanel,
  onRemovePanel,
  onAssignCast,
  onGeneratePages,
  onRegenerateStory,
  generatingStory,
  generatingPages,
}: {
  storyPages: ComicStoryPage[];
  characters: ComicCharacter[];
  /** 環境参照（3ir）。PageCastRow の枚数表示と実添付を一致させるために渡す。 */
  envReferences: ComicEnvReference[];
  /** 構成生成が使ったテンプレ（null=おまかせ）。非 null ならコマ割り方針は出さない。 */
  storyTemplateId: string | null;
  updateStoryPage: (pageNo: number, patch: Partial<ComicStoryPage>) => void;
  updateStoryPanel: (
    pageNo: number,
    panelIndex: number,
    patch: Partial<ComicPanel>,
  ) => void;
  onInsertPanel: (
    pageNo: number,
    afterPosition: number,
    preset: "blank" | "transition",
  ) => void;
  onRemovePanel: (pageNo: number, panelIndex: number) => void;
  /** 未紐付けの cast 名を登録キャラへ割り当てる（構成全体で置換）。 */
  onAssignCast: (fromName: string, toName: string) => void;
  onGeneratePages: () => void;
  onRegenerateStory: () => void;
  generatingStory: boolean;
  generatingPages: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500">
        ページごとに、あらすじ・コマ割り方針・各コマの構図やセリフを直せます。ここで直した内容がページ生成に使われます。ページ横のキャラチップが、そのページの生成に使う参照画像の紐付けです。
      </p>
      {storyPages.map((page) => (
        <div
          key={page.page}
          className="flex flex-col gap-2 rounded-md border border-[#2a2a2a] bg-[#181818] p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-pink-500/10 px-2 py-0.5 text-xs font-semibold text-pink-200">
              ページ {page.page}
            </span>
            <span className="text-xs text-neutral-500">{page.panelCount}コマ</span>
            <PageCastRow
              page={page}
              characters={characters}
              envReferences={envReferences}
              onAssignCast={onAssignCast}
            />
            {storyTemplateId !== null &&
              page.panels.length !== getComicTemplate(storyTemplateId).panelCount && (
                <span className="text-[11px] text-amber-200">
                  コマ数がテンプレと違うため、このページはおまかせレイアウトで生成されます
                </span>
              )}
          </div>

          <Field label="このページで起きること">
            <input
              value={page.synopsis}
              onChange={(e) => updateStoryPage(page.page, { synopsis: e.target.value })}
              className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
            />
          </Field>

          {/* テンプレを選んでいるときはテンプレがレイアウトの正なので出さない。 */}
          {storyTemplateId === null && (
            <Field label="コマ割り方針（英語）">
              <input
                value={page.layoutHint}
                onChange={(e) =>
                  updateStoryPage(page.page, { layoutHint: e.target.value })
                }
                className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
              />
            </Field>
          )}

          {page.panels.map((panel) => (
            <div key={panel.index} className="flex flex-col gap-2">
              {/* e57 + r83: このコマの直前にコマ/場面転換コマを挿入するバー。 */}
              <PanelInsertBar
                full={page.panels.length >= MAX_PANELS_PER_PAGE}
                onInsert={(preset) => onInsertPanel(page.page, panel.index - 1, preset)}
              />
              <div
                className="rounded-md border border-[#2a2a2a] bg-[#141414] p-3"
              >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded bg-pink-500/10 px-2 py-0.5 text-xs font-semibold text-pink-200">
                  コマ {panel.index}
                </span>
                {panel.characters.length > 0 && (
                  <span className="text-xs text-neutral-500">
                    登場: {panel.characters.join("、")}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemovePanel(page.page, panel.index)}
                  disabled={page.panels.length <= 1}
                  className="ml-auto rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-neutral-400 transition hover:border-rose-500/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
                  title="このコマを削除"
                >
                  コマを削除
                </button>
                {/* per-panel の参照バッジは撤去（2026-07-28）。story 経路の添付は
                    ページ一括なので、コマ単位の表示は実態と乖離していた。
                    紐付けの正はページヘッダの PageCastRow。 */}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="構図・カメラ">
                  <input
                    value={panel.composition}
                    onChange={(e) =>
                      updateStoryPanel(page.page, panel.index, {
                        composition: e.target.value,
                      })
                    }
                    className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                  />
                </Field>
                <Field label="演技・表情">
                  <input
                    value={panel.acting}
                    onChange={(e) =>
                      updateStoryPanel(page.page, panel.index, { acting: e.target.value })
                    }
                    className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                  />
                </Field>
              </div>

              <div className="mt-2 flex flex-col gap-2">
                <BalloonEditor
                  balloons={panel.balloons}
                  onChange={(balloons) =>
                    updateStoryPanel(page.page, panel.index, { balloons })
                  }
                />
                <SfxEditor
                  sfx={panel.sfx}
                  onChange={(sfx) => updateStoryPanel(page.page, panel.index, { sfx })}
                />
              </div>

              <Field label="生成プロンプト" className="mt-2">
                <textarea
                  value={panel.prompt}
                  onChange={(e) =>
                    updateStoryPanel(page.page, panel.index, { prompt: e.target.value })
                  }
                  rows={2}
                  className="w-full resize-y rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                />
              </Field>
              </div>
            </div>
          ))}

          {/* 末尾の挿入バー（合計 panels.length + 1 本）。旧・単独の
              「＋ コマを追加」ボタンはこのバーが代替する（導線の重複を作らない）。 */}
          <PanelInsertBar
            full={page.panels.length >= MAX_PANELS_PER_PAGE}
            onInsert={(preset) => onInsertPanel(page.page, page.panels.length, preset)}
          />
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {/* 枠消費の可視化はこのラベル1箇所（確認ダイアログは出さない）。 */}
        <button
          type="button"
          onClick={onGeneratePages}
          disabled={generatingStory || generatingPages || storyPages.length === 0}
          className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          全ページを一括生成（画像{storyPages.length}枚）
        </button>
        <button
          type="button"
          onClick={onRegenerateStory}
          disabled={generatingStory || generatingPages}
          className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-2 text-sm font-medium text-neutral-200 transition hover:border-[#3a3a3a] disabled:cursor-not-allowed disabled:opacity-40"
        >
          構成をやり直す
        </button>
      </div>
    </div>
  );
}

/**
 * ページ一覧（主経路の出口）。
 *
 * ページ番号昇順・左→右に並べ、
 * カード内のゲージで1ページずつ進捗が届く。中止は右上の既存 directRun パネルから。
 */
function PagesPhase({
  theme,
  storyPages,
  pageResults,
  saveFormat,
  setSaveFormat,
  onGeneratePage,
  generatingPages,
  storyTemplateId,
  readingDirection,
  colorMode,
  panelReeditRunningPage,
  panelReeditBlocked,
  onRegeneratePanel,
  onUndoPanelReedit,
  canUndoPanelReedit,
  onSplitPanel,
  onMergePanels,
  onRecoverSlots,
}: {
  /**
   * 作品のテーマ（＝入力されたあらすじ）。保存ファイル名の先頭に載せる
   * （実装契約O。空なら savePage 側が従来の連番へフォールバックする）。
   */
  theme: string;
  storyPages: ComicStoryPage[];
  pageResults: ComicPageResult[];
  saveFormat: ComicSaveFormat;
  setSaveFormat: (v: ComicSaveFormat) => void;
  onGeneratePage: (page: ComicStoryPage) => void;
  generatingPages: boolean;
  storyTemplateId: string | null;
  readingDirection: ComicReadingDirection;
  colorMode: ComicColorMode;
  panelReeditRunningPage: number | null;
  panelReeditBlocked: boolean;
  onRegeneratePanel: (
    page: ComicStoryPage,
    panel: ComicPanel,
    points: PanelReeditPoint[],
  ) => Promise<PanelReeditOutcome>;
  onUndoPanelReedit: (pageNo: number) => void;
  canUndoPanelReedit: (pageNo: number) => boolean;
  onSplitPanel: (
    page: ComicStoryPage,
    panelIndex: number,
    direction: SplitDirection,
  ) => Promise<PanelReeditOutcome>;
  onMergePanels: (
    page: ComicStoryPage,
    panelIndex: number,
    neighborIndex: number,
  ) => Promise<PanelReeditOutcome>;
  onRecoverSlots: (page: ComicStoryPage) => Promise<SlotRecoveryOutcome>;
}) {
  const pushToast = useToasts((s) => s.push);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  /** Kindle 風・見開きプレビュー（読み取り専用）の開閉。常に1ページ目から開く。 */
  const [previewOpen, setPreviewOpen] = useState(false);
  /**
   * コマ割り認識中のページ番号。読み取り専用処理なのでグローバルの
   * panelReeditActiveRef は取らず、二重クリックだけをここで防ぐ。
   */
  const [recoveringPage, setRecoveringPage] = useState<number | null>(null);
  /**
   * 認識中フラグの**同期版**。多重起動を防ぐ実体はこちらで、`recoveringPage`(state) は
   * 表示専用（ボタン文言・disabled）。
   *
   * state だけで塞ぐと失敗トーストが1クリックで複数個出る（実測: 4連発）。
   * 理由は state 更新が非同期だから:
   *   click → `recoveringPage` は null のまま関数に入る
   *        → `setRecoveringPage` は**次のレンダーまで反映されない**
   *        → `await onRecoverSlots` で制御を手放す（画像読み込みで数百ms）
   *        → 再レンダー前の追加クリックが全て `recoveringPage === null` を見て素通り
   * ボタンの `disabled` も再レンダー後にしか効かないので、この隙間を塞げない。
   * ref なら代入即時なので、同一 tick 内の2回目以降を確実に弾ける。
   *
   * トースト側での重複除去（dedupe）にはしない。それでは「認識処理自体が複数回走る」
   * 実害（画像を何度も読み直す）が残り、通知だけを隠すことになるため。
   */
  const recoveringRef = useRef(false);

  /**
   * 「1コマずつ直す」の入口。スロット未確定ページはここで初めて線認識を走らせ、
   * 採用できたらモーダルを開く。失敗時はトーストで理由を出し、ページには触れない。
   */
  const openPanelReedit = async (page: ComicStoryPage) => {
    if (recoveringRef.current) return;
    // D-1: テンプレ選択中でも、テンプレのコマ数と実際の構成コマ数がずれたページは
    // テンプレ座標をそのまま使えない。その場合は線認識へ進める（ゲートで塞がない）。
    const templateSlotCount = storyTemplateId ? getComicTemplate(storyTemplateId).slots.length : null;
    const templateUsable = templateSlotCount !== null && templateSlotCount === page.panels.length;
    if (page.slotsOverride || templateUsable) {
      setEditingPage(page.page);
      return;
    }
    recoveringRef.current = true;
    setRecoveringPage(page.page);
    try {
      const outcome = await onRecoverSlots(page);
      if (outcome.adopted) setEditingPage(page.page);
      else if (!outcome.silent) pushToast({ kind: "info", text: outcome.error, ttlMs: 9000 });
    } catch (error) {
      pushToast({
        kind: "info",
        text: `コマ割りの認識に失敗しました: ${(error as Error)?.message ?? error}。元のページは変更していません。`,
        ttlMs: 9000,
      });
    } finally {
      recoveringRef.current = false;
      setRecoveringPage(null);
    }
  };

  // A-4 (2026-07-30): プロジェクト保存導線の復活。7/28 の one-shot 全面書き換えで
  // 消えた退行 (旧実装は f4aebc1)。ExpressionSetWorkspace 443-531 と同型。
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  /**
   * 実装契約O (2026-08-05): プロジェクト（ギャラリー）へ登録する実体を 4:5 に揃える。
   *
   * ここが「出力サイズが統一されていない」の穴だった。保存ボタン経路だけが
   * 正規化されていて、この経路は**生成直後の生のページ**（モデル出力が 2:3 / 3:4 に
   * 揺れる）をそのままギャラリーへ登録していた。以降のギャラリー側の書き出し・
   * 共有はその未正規化の実体を掴むため、作品内でページの形が揃わない。
   *
   * 正規化に失敗しても登録自体は諦めない（元パスで登録して続行する）。
   * ここで throw すると「保存できない」に化けるが、ユーザーの要求は保存であって
   * 揃えることは手段だから。ただし黙って落とさず、揃わなかったことは伝える。
   */
  async function registerExportPage(imagePath: string, pageNo: number): Promise<string> {
    try {
      return await materializeExportPage(imagePath, pageNo, saveFormat);
    } catch {
      pushToast({
        kind: "info",
        text: `ページ ${pageNo} は出力サイズ（4:5）に揃えられなかったため、元のサイズで保存しました。`,
        ttlMs: 5000,
      });
      return imagePath;
    }
  }

  async function savePageToProject(page: ComicStoryPage) {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    const imagePath = pageResults.find((r) => r.page === page.page)?.imagePath;
    if (!imagePath) return;
    addItem(activeProjectId, {
      imagePath: await registerExportPage(imagePath, page.page),
      prompt: page.synopsis || undefined,
      note: `漫画 ページ${page.page}`,
    });
    pushToast({
      kind: "success",
      text: `ページ ${page.page} を ${activeProject?.name ?? "プロジェクト"} に保存しました。`,
      ttlMs: 2500,
    });
  }

  async function saveAllPagesToProject() {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    let saved = 0;
    for (const page of storyPages) {
      const imagePath = pageResults.find((r) => r.page === page.page)?.imagePath;
      if (!imagePath) continue;
      addItem(activeProjectId, {
        // 単ページ保存と同じ関所を通す（4:5 に揃った実体を登録する）。
        imagePath: await registerExportPage(imagePath, page.page),
        prompt: page.synopsis || undefined,
        note: `漫画 ページ${page.page}`,
      });
      saved += 1;
    }
    pushToast({
      kind: saved > 0 ? "success" : "info",
      text:
        saved > 0
          ? `漫画 ${saved} ページを ${activeProject?.name ?? "プロジェクト"} に保存しました。`
          : "保存できる完成ページがまだありません。",
      ttlMs: 3000,
    });
  }

  async function savePage(imagePath: string | undefined, pageNo: number) {
    if (!imagePath) return;
    try {
      const saved = await savePageAs(imagePath, pageNo, saveFormat, {
        theme,
        totalPages: storyPages.length,
      });
      if (!saved) return;
      pushToast({
        kind: "success",
        text: `ページ ${pageNo} を保存しました。`,
        ttlMs: 2500,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  /**
   * 全ページ一括保存。フォルダを選ばせて manga_C001... の連番で書き出す。
   * 未生成ページは skipped として数え、黙って落とさずトーストで可視化する。
   */
  async function saveAllPages() {
    try {
      const outcome = await savePagesBulk(
        // 表示順（ページ番号昇順）のまま渡す。連番と一覧順を一致させる。
        storyPages.map((page) => ({
          page: page.page,
          imagePath: pageResults.find((r) => r.page === page.page)?.imagePath,
        })),
        saveFormat,
        { theme },
      );
      // フォルダ選択のキャンセルは失敗ではない（トーストを出さない）。
      if (!outcome) return;
      // 内訳は「保存 / 失敗 / 未生成スキップ」の3つ。0 件のものは書かない。
      // 失敗が1件でもあれば error 扱いにする（成功トーストに紛れさせない）。
      const notes = [
        outcome.failed > 0 ? `${outcome.failed} ページは失敗` : null,
        outcome.skipped > 0 ? `${outcome.skipped} ページは未生成のためスキップ` : null,
      ].filter((n): n is string => n !== null);
      pushToast({
        kind: outcome.failed > 0 ? "error" : "info",
        text:
          notes.length > 0
            ? `保存 ${outcome.saved} 件（${notes.join(" / ")}）。`
            : `${outcome.saved} ページを保存しました。`,
        ttlMs: outcome.failed > 0 ? 6000 : 4000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  const completedCount = pageResults.filter((r) => r.imagePath).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          ページ一覧（全{storyPages.length}ページ）
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-400">保存形式</span>
          <div className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] p-1">
            {(
              [
                { value: "png", label: "PNG（標準）" },
                { value: "jpeg", label: "JPEG" },
              ] as const
            ).map((option) => {
              const selected = saveFormat === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSaveFormat(option.value)}
                  aria-pressed={selected}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                    selected
                      ? "border border-pink-500 bg-pink-500/10 text-pink-200"
                      : "border border-transparent text-neutral-400 hover:text-pink-200"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            // 読み取り専用なので生成中でも開ける（完成したページから順に画像が入る）。
            disabled={completedCount === 0}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            プレビュー（見開き）
          </button>
          <button
            type="button"
            onClick={() => void saveAllPagesToProject()}
            disabled={completedCount === 0 || generatingPages || panelReeditRunningPage !== null}
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            全ページをプロジェクトに保存
          </button>
          <button
            type="button"
            onClick={() => void saveAllPages()}
            disabled={completedCount === 0 || generatingPages || panelReeditRunningPage !== null}
            className="rounded-md bg-pink-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            全ページを一括保存
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {storyPages.map((page) => {
          const result = pageResults.find((r) => r.page === page.page);
          const isPanelReediting = panelReeditRunningPage === page.page;
          const pageDirection = result?.direction ?? readingDirection;
          const pageColorMode = result?.colorMode ?? colorMode;
          // スロット未確定（おまかせ・コマ追加後）でも入口は閉じない。押した時点で
          // 線認識を走らせて slotsOverride を復元する（失敗はそこで理由を出す）。
          // コマ数不一致も同様に、認識結果と突き合わせてから判定する。
          const gateReason: string | null = pageDirection === "ltr"
            ? "今は右→左（日本式）のページのみ対応しています"
            : pageColorMode === "faithful"
              ? "「キャラ忠実」で生成したページは1コマ再生成に未対応です"
              : !result?.imagePath
                ? "ページ画像を生成してから編集できます"
                : null;
          const canOpenPanelReedit = gateReason === null;
          return (
            <div
              key={page.page}
              className="flex flex-col gap-1.5 rounded-md border border-[#2a2a2a] bg-[#181818] p-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-pink-200">
                  ページ {page.page}
                </span>
                <button
                  type="button"
                  onClick={() => onGeneratePage(page)}
                  // D-2: コマ割り認識中に同じページを再生成すると、認識が返ったときに
                  // 旧画像の座標を新画像へ書き戻す競合が起きうる。認識中は押させない。
                  disabled={
                    generatingPages ||
                    result?.generating ||
                    panelReeditRunningPage !== null ||
                    recoveringPage === page.page
                  }
                  className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-neutral-300 transition hover:border-pink-500/40 disabled:opacity-40"
                >
                  再生成
                </button>
              </div>
              <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded bg-[#0f0f0f]">
                {result?.generating || isPanelReediting ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4">
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                    <span className="text-[12px] font-bold text-pink-300">
                      {isPanelReediting ? "このコマだけ再生成中…" : "生成中…"}
                    </span>
                    {result?.startedAt ? (
                      <div className="w-full max-w-xs">
                        <GenerationGauge startedAt={result.startedAt} mode="batch" />
                      </div>
                    ) : null}
                  </div>
                ) : result?.imagePath ? (
                  <SafeImage
                    path={result.imagePath}
                    alt={`ページ ${page.page}`}
                    className="h-full w-full object-contain"
                  />
                ) : result?.error ? (
                  <span className="px-1 text-center text-[11px] text-rose-400">失敗</span>
                ) : (
                  <span className="text-[11px] text-neutral-600">未生成</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void savePage(result?.imagePath, page.page)}
                disabled={!result?.imagePath || panelReeditRunningPage !== null}
                className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => void savePageToProject(page)}
                disabled={!result?.imagePath || panelReeditRunningPage !== null}
                className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                プロジェクトに保存
              </button>
              <button
                type="button"
                onClick={() => void openPanelReedit(page)}
                disabled={!canOpenPanelReedit || panelReeditBlocked || recoveringPage !== null}
                title={gateReason ?? undefined}
                className="rounded border border-pink-500/50 bg-pink-500/10 px-2 py-1 text-[11px] font-medium text-pink-100 transition hover:border-pink-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {recoveringPage === page.page ? "コマ割りを認識中…" : "1コマずつ直す"}
              </button>
              {gateReason !== null && gateReason !== "ページ画像を生成してから編集できます" ? (
                <p className="text-[10px] text-amber-200">{gateReason}</p>
              ) : null}
              <button
                type="button"
                onClick={() => onUndoPanelReedit(page.page)}
                disabled={!canUndoPanelReedit(page.page) || panelReeditRunningPage !== null}
                title="元に戻せるのはこのアプリを開いている間だけです（閉じると復元ボタンの履歴は消えます。差し替え前の画像ファイル自体は残っています）"
                className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                直前のコマ編集を戻す
              </button>
            </div>
          );
        })}
      </div>
      {previewOpen ? (
        <ComicSpreadPreviewModal
          pages={storyPages}
          results={pageResults}
          direction={readingDirection}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
      {editingPage !== null ? (() => {
        const page = storyPages.find((item) => item.page === editingPage);
        const result = pageResults.find((item) => item.page === editingPage);
        const slots = page?.slotsOverride
          ?? (storyTemplateId ? getComicTemplate(storyTemplateId).slots : null);
        if (!page || !result?.imagePath || !slots) return null;
        return (
          <PanelReeditModal
            // 分割/統合の成功後は同ページでもモーダル内部 state を作り直させ、
            // 古い drafts / points を持ち越さない。
            key={`${page.page}:${result.imagePath}`}
            page={page}
            imagePath={result.imagePath}
            slots={slots}
            busy={panelReeditRunningPage !== null}
            recoveredLayout={!storyTemplateId && Boolean(page.slotsOverride)}
            onClose={() => setEditingPage(null)}
            onRegenerate={onRegeneratePanel}
            onSplitPanel={onSplitPanel}
            onMergePanels={onMergePanels}
          />
        );
      })() : null}
    </div>
  );
}

/** 完成画像の上で頂点を調整し、確定前には生成できない1コマ編集モーダル。 */
/**
 * コマ番号 1..8 の確定配色。白地・モノクロ漫画の上で判別できる Tailwind 400系。
 * 選択中のコマはこの色に関係なくピンク（既存の「編集対象=ピンク」の言語を維持）。
 */
const PANEL_OVERLAY_COLORS = [
  "#38bdf8", // 1 sky
  "#a78bfa", // 2 violet
  "#34d399", // 3 emerald
  "#fbbf24", // 4 amber
  "#f87171", // 5 red
  "#22d3ee", // 6 cyan
  "#fb923c", // 7 orange
  "#e879f9", // 8 fuchsia
];

function PanelReeditModal({
  page,
  imagePath,
  slots,
  busy,
  recoveredLayout,
  onClose,
  onRegenerate,
  onSplitPanel,
  onMergePanels,
}: {
  page: ComicStoryPage;
  imagePath: string;
  /** このページの実効スロット（テンプレ or slotsOverride）。テンプレ直参照はしない。 */
  slots: ComicPanelSlot[];
  busy: boolean;
  /** 線認識で復元したコマ割りのページか（副題の出し分けだけに使う）。 */
  recoveredLayout: boolean;
  onClose: () => void;
  onRegenerate: (
    page: ComicStoryPage,
    panel: ComicPanel,
    points: PanelReeditPoint[],
  ) => Promise<PanelReeditOutcome>;
  onSplitPanel: (
    page: ComicStoryPage,
    panelIndex: number,
    direction: SplitDirection,
  ) => Promise<PanelReeditOutcome>;
  onMergePanels: (
    page: ComicStoryPage,
    panelIndex: number,
    neighborIndex: number,
  ) => Promise<PanelReeditOutcome>;
}) {
  const guideForPanel = (index: number) => {
    const slot = slots[index - 1];
    return slot ? panelGuidePoints(slot) : [];
  };
  const [selectedIndex, setSelectedIndex] = useState(page.panels[0]?.index ?? 1);
  const [drafts, setDrafts] = useState<ComicPanel[]>(() =>
    page.panels.map((panel) => ({
      ...panel,
      balloons: panel.balloons.map((balloon) => ({ ...balloon })),
      sfx: panel.sfx.map((sfx) => ({ ...sfx })),
    })),
  );
  const [points, setPoints] = useState<PanelReeditPoint[]>(() =>
    guideForPanel(page.panels[0]?.index ?? 1),
  );
  const [detection, setDetection] = useState<PanelDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [manualAdjust, setManualAdjust] = useState(false);
  const [manualValidated, setManualValidated] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [reeditError, setReeditError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** モーダル内の進行ゲージの基準時刻（カードのゲージと同じ mode="batch"）。 */
  const [submitStartedAt, setSubmitStartedAt] = useState<number | undefined>(undefined);
  const [draggingPoint, setDraggingPoint] = useState<number | null>(null);
  /** 統合の相手コマ（未選択は null。候補が1つのときはその1つを即使う）。 */
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const detectionTokenRef = useRef(0);
  const locked = busy || submitting;
  const generationAllowed = manualAdjust
    ? manualValidated
    : Boolean(detection && !detection.generationDisabled);

  const selectedPanel = drafts.find((panel) => panel.index === selectedIndex);
  const mergeCandidates = adjacentSlotIndices(slots, selectedIndex - 1).map((i) => i + 1);
  const effectiveMergeTarget =
    mergeTarget !== null && mergeCandidates.includes(mergeTarget)
      ? mergeTarget
      : mergeCandidates.length === 1
        ? mergeCandidates[0]
        : null;
  const selectPanel = (index: number) => {
    if (locked) return;
    setSelectedIndex(index);
    setDetection(null);
    setManualAdjust(false);
    setManualValidated(false);
    setRangeError(null);
    setReeditError(null);
    setMergeTarget(null);
  };
  const updatePanel = (patch: Partial<ComicPanel>) => {
    if (locked) return;
    setDrafts((previous) =>
      previous.map((panel) => (panel.index === selectedIndex ? { ...panel, ...patch } : panel)),
    );
  };
  const updateFirstBalloon = (text: string) => {
    if (!selectedPanel) return;
    const balloons = selectedPanel.balloons.length > 0
      ? selectedPanel.balloons.map((balloon, index) =>
          index === 0 ? { ...balloon, text } : balloon,
        )
      : text.trim()
        ? [{ id: crypto.randomUUID(), speaker: "", text, kind: "normal" as const, pos: null, visible: true }]
        : [];
    updatePanel({ balloons });
  };
  const updateFirstSfx = (text: string) => {
    if (!selectedPanel) return;
    const sfx = selectedPanel.sfx.length > 0
      ? selectedPanel.sfx.map((item, index) => (index === 0 ? { ...item, text } : item))
      : text.trim()
        ? [{ id: crypto.randomUUID(), text, intent: "impact" as const, pos: null, rotation: 0, scale: 1, visible: true }]
        : [];
    updatePanel({ sfx });
  };
  const pointFromEvent = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  };
  const movePoint = (event: React.PointerEvent<SVGSVGElement>) => {
    if (locked || !manualAdjust || draggingPoint === null) return;
    const point = pointFromEvent(event);
    setPoints((previous) => previous.map((item, index) => (index === draggingPoint ? point : item)));
    setManualValidated(false);
    setRangeError(null);
    setReeditError(null);
  };
  const confirmRange = () => {
    if (locked) return;
    try {
      validatePanelPolygon(points, { selectedSlotIndex: selectedIndex - 1, slots });
      setManualValidated(true);
      setRangeError(null);
      setReeditError(null);
    } catch (error) {
      setManualValidated(false);
      setRangeError((error as Error)?.message ?? "編集範囲を確認できませんでした。");
    }
  };
  const regenerate = async () => {
    if (!selectedPanel || !generationAllowed || locked) return;
    setSubmitting(true);
    setSubmitStartedAt(Date.now());
    setReeditError(null);
    try {
      const outcome = await onRegenerate(page, selectedPanel, points);
      if (outcome.adopted) {
        onClose();
        return;
      }
      setReeditError(outcome.error);
    } catch (error) {
      setReeditError(`再生成を開始できませんでした: ${(error as Error)?.message ?? error}。元ページは変更していません。もう一度お試しください。`);
    } finally {
      setSubmitting(false);
      setSubmitStartedAt(undefined);
    }
  };
  /** 分割/統合はどちらも「成功したら閉じる」。親の key 差し替えで新スロットが正になる。 */
  const runLayoutOp = async (operation: () => Promise<PanelReeditOutcome>) => {
    if (locked) return;
    setSubmitting(true);
    setReeditError(null);
    try {
      const outcome = await operation();
      if (outcome.adopted) {
        onClose();
        return;
      }
      setReeditError(outcome.error);
    } catch (error) {
      setReeditError(`コマ割りを変更できませんでした: ${(error as Error)?.message ?? error}。元ページは変更していません。`);
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    const token = detectionTokenRef.current + 1;
    detectionTokenRef.current = token;
    setDetecting(true);
    setDetection(null);
    setManualAdjust(false);
    setManualValidated(false);
    void readPanelImageData(imagePath)
      .then((imageData) => {
        if (detectionTokenRef.current !== token) return;
        const result = detectPanelInterior(imageData, selectedIndex - 1, slots);
        setPoints(result.points);
        setDetection(result);
        if (result.generationDisabled) {
          // 検出に失敗したら、自分で「範囲を微調整」を探させずに手動調整へ自動移行する。
          // ドラッグ可能な頂点が出るので「次に何をするか」が画面上で自明になる。
          setManualAdjust(true);
          setReeditError("自動で枠の内側を特定できなかったため、手動調整モードにしました。頂点をドラッグして枠に合わせ、「調整した範囲を確認」を押してください。");
        } else {
          setReeditError(null);
        }
      })
      .catch((error) => {
        if (detectionTokenRef.current !== token) return;
        setDetection(null);
        setReeditError(`自動選択に失敗しました: ${(error as Error)?.message ?? error}。ページを開き直して、もう一度お試しください。`);
      })
      .finally(() => {
        if (detectionTokenRef.current === token) setDetecting(false);
      });
  }, [imagePath, selectedIndex, slots]);
  const polygon = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`ページ ${page.page} の1コマ編集`}>
      <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-[#444] bg-[#151515] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#303030] px-4 py-3">
          <div>
            <h3 className="text-sm font-bold text-white">ページ {page.page}：1コマずつ直す</h3>
            <p className="text-[11px] text-neutral-400">
              {recoveredLayout
                ? "画像から認識したコマ割りです。色分けされたコマをクリックして選び、内容を直して再生成します。"
                : "色分けされたコマをクリックして選び、内容を直して再生成します。頂点を微調整してから確定することもできます。"}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={locked} aria-label="1コマ編集を閉じる" className="rounded px-2 py-1 text-neutral-300 hover:bg-white/10 disabled:opacity-40">×</button>
        </div>
        <div className="grid min-h-0 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 overflow-auto rounded border border-[#303030] bg-black p-2 text-center">
            <div className="relative inline-block max-w-full">
              <img src={convertFileSrc(imagePath)} alt={`編集するページ ${page.page}`} className="block max-h-[66vh] max-w-full object-contain" />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full touch-none"
                onPointerMove={movePoint}
                onPointerUp={() => setDraggingPoint(null)}
                onPointerCancel={() => setDraggingPoint(null)}
              >
                {/*
                  非選択コマも全部描く。どこが何番のコマかが一目で分かり、クリックで選べる。
                  手動調整中はクリック切替を無効にする（ドラッグ中の誤タップで調整が飛ぶため。
                  切替は右の「コマN」ボタンで可能なまま）。
                  aria-hidden なのは、アクセシブルな選択経路を既存の「コマN」ボタンが担うため。
                */}
                {drafts.map((panel) => {
                  if (panel.index === selectedIndex) return null;
                  const slot = slots[panel.index - 1];
                  if (!slot) return null;
                  const color = PANEL_OVERLAY_COLORS[(panel.index - 1) % PANEL_OVERLAY_COLORS.length];
                  const guide = panelGuidePoints(slot);
                  const centroid = guide.reduce(
                    (sum, point) => ({ x: sum.x + point.x / guide.length, y: sum.y + point.y / guide.length }),
                    { x: 0, y: 0 },
                  );
                  return (
                    <g key={panel.index} aria-hidden="true">
                      <polygon
                        points={guide.map((point) => `${point.x},${point.y}`).join(" ")}
                        fill={color}
                        fillOpacity={0.14}
                        stroke={color}
                        strokeWidth="0.6"
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: locked || manualAdjust ? "default" : "pointer" }}
                        onClick={locked || manualAdjust ? undefined : () => selectPanel(panel.index)}
                      />
                      <text
                        x={centroid.x}
                        y={centroid.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize="4"
                        fontWeight="bold"
                        fill={color}
                        stroke="#ffffff"
                        strokeWidth="0.9"
                        paintOrder="stroke"
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      >
                        {panel.index}
                      </text>
                    </g>
                  );
                })}
                <polygon points={polygon} fill="rgba(236,72,153,0.28)" stroke="#f9a8d4" strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
                {points.length > 0 ? (() => {
                  const centroid = points.reduce(
                    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
                    { x: 0, y: 0 },
                  );
                  return (
                    <text
                      x={centroid.x}
                      y={centroid.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="4"
                      fontWeight="bold"
                      fill="#f9a8d4"
                      stroke="#ffffff"
                      strokeWidth="0.9"
                      paintOrder="stroke"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                      aria-hidden="true"
                    >
                      {selectedIndex}
                    </text>
                  );
                })() : null}
                {manualAdjust ? points.map((point, index) => (
                  <circle
                    key={index}
                    cx={point.x}
                    cy={point.y}
                    r="1.35"
                    fill="#fdf2f8"
                    stroke="#db2777"
                    strokeWidth="0.55"
                    vectorEffect="non-scaling-stroke"
                    onPointerDown={locked ? undefined : (event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDraggingPoint(index);
                    }}
                    aria-label={`頂点 ${index + 1}`}
                  />
                )) : null}
              </svg>
            </div>
            <p className={`mt-2 text-xs ${generationAllowed ? "text-emerald-200" : "text-amber-200"}`}>
              {detecting
                ? "実際の枠線を自動で探しています…"
                : generationAllowed
                  ? `自動選択済み（信頼度 ${Math.round((detection?.confidence ?? 0) * 100)}%）。この範囲だけを再生成します。`
                  : "自動選択を安全に確定できませんでした。必要なら範囲を微調整してください。"}
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="編集するコマ">
              {drafts.map((panel) => {
                const selected = panel.index === selectedIndex;
                return (
                  <button
                    key={panel.index}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectPanel(panel.index)}
                    disabled={locked}
                    className={`rounded border px-2 py-1.5 text-xs font-semibold ${selected ? "border-pink-400 bg-pink-500/20 text-pink-100" : "border-[#3a3a3a] text-neutral-300"}`}
                  >
                    コマ {panel.index}
                  </button>
                );
              })}
            </div>
            {selectedPanel ? (
              <>
                <Field label="構図">
                  <input disabled={locked} value={selectedPanel.composition} onChange={(event) => updatePanel({ composition: event.target.value })} className="w-full rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40" />
                </Field>
                <Field label="演技・表情">
                  <input disabled={locked} value={selectedPanel.acting} onChange={(event) => updatePanel({ acting: event.target.value })} className="w-full rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40" />
                </Field>
                <Field label="セリフ（先頭の吹き出し）">
                  <input disabled={locked} value={selectedPanel.balloons[0]?.text ?? ""} onChange={(event) => updateFirstBalloon(event.target.value)} className="w-full rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40" />
                </Field>
                <Field label="擬音（先頭）">
                  <input disabled={locked} value={selectedPanel.sfx[0]?.text ?? ""} onChange={(event) => updateFirstSfx(event.target.value)} className="w-full rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40" />
                </Field>
                <Field label="生成指示">
                  <textarea disabled={locked} value={selectedPanel.prompt} onChange={(event) => updatePanel({ prompt: event.target.value })} rows={4} className="w-full resize-y rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40" />
                </Field>
              </>
            ) : null}
            <button type="button" onClick={() => { if (!locked) { setManualAdjust(true); setManualValidated(false); } }} disabled={locked || detecting} className="rounded border border-amber-300/60 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-40">
              範囲を微調整
            </button>
            {manualAdjust ? (
              <button type="button" onClick={confirmRange} disabled={locked} className="rounded border border-amber-300/60 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-40">
                調整した範囲を確認
              </button>
            ) : null}
            {rangeError ? <p role="alert" className="text-xs text-rose-200">{rangeError}</p> : null}
            {reeditError ? <p role="alert" className="rounded border border-rose-400/40 bg-rose-500/10 px-2 py-2 text-xs leading-relaxed text-rose-100">{reeditError}</p> : null}
            <button type="button" onClick={() => void regenerate()} disabled={!generationAllowed || locked || detecting} className="rounded bg-pink-500 px-3 py-2 text-xs font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40">
              {locked ? "このコマだけ再生成中…" : "確定した1コマを再生成"}
            </button>
            {submitting && submitStartedAt ? (
              <div className="flex w-full flex-col items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#181818] px-4 py-3">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                <span className="text-[11px] font-bold text-pink-300">このコマだけ再生成中…</span>
                <div className="w-full max-w-xs">
                  <GenerationGauge startedAt={submitStartedAt} mode="batch" />
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 rounded-md border border-[#303030] bg-[#111] px-3 py-3">
              <span className="text-[11px] font-bold text-neutral-300">コマ割りを変える（このページだけ）</span>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => void runLayoutOp(() => onSplitPanel(page, selectedIndex, "vertical"))}
                  disabled={locked || detecting || drafts.length >= MAX_PANELS_PER_PAGE}
                  title={drafts.length >= MAX_PANELS_PER_PAGE ? `1ページのコマ数が上限（${MAX_PANELS_PER_PAGE}）のため、これ以上分割できません。` : undefined}
                  className="rounded border border-sky-400/50 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  縦線で2分割（左右）
                </button>
                <button
                  type="button"
                  onClick={() => void runLayoutOp(() => onSplitPanel(page, selectedIndex, "horizontal"))}
                  disabled={locked || detecting || drafts.length >= MAX_PANELS_PER_PAGE}
                  title={drafts.length >= MAX_PANELS_PER_PAGE ? `1ページのコマ数が上限（${MAX_PANELS_PER_PAGE}）のため、これ以上分割できません。` : undefined}
                  className="rounded border border-sky-400/50 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  横線で2分割（上下）
                </button>
                <p className="text-[10px] leading-relaxed text-neutral-500">読み順で後ろ側の半分が空白コマになります。分割後にその空白コマを選んで再生成すると、AIが中身を描きます。</p>
              </div>
              <div className="flex flex-col gap-1.5">
                {mergeCandidates.length > 1 ? (
                  <Field label="統合する相手">
                    <select
                      disabled={locked || detecting}
                      value={effectiveMergeTarget ?? ""}
                      onChange={(event) => setMergeTarget(event.target.value ? Number(event.target.value) : null)}
                      className="w-full rounded border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-xs text-white disabled:opacity-40"
                    >
                      <option value="">選んでください</option>
                      {mergeCandidates.map((candidate) => (
                        <option key={candidate} value={candidate}>{`コマ ${candidate}`}</option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (effectiveMergeTarget === null) return;
                    void runLayoutOp(() => onMergePanels(page, selectedIndex, effectiveMergeTarget));
                  }}
                  disabled={locked || detecting || effectiveMergeTarget === null}
                  title={mergeCandidates.length === 0 ? "このコマに隣り合うコマがないため統合できません。" : undefined}
                  className="rounded border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  隣のコマと統合（コマを消す）
                </button>
                <p className="text-[10px] leading-relaxed text-neutral-500">間の枠線を消して1つのコマにします。絵はそのまま残るため、境目が気になる場合は統合後にこのコマを再生成してください。</p>
              </div>
              <p className="text-[10px] leading-relaxed text-neutral-500">コマ割りの変更はこのページの画像と構成に反映されます。「直前のコマ編集を戻す」で1段ずつ戻せます。</p>
            </div>
            <p className="text-[10px] leading-relaxed text-neutral-500">他のコマと枠線は、AI画像をそのまま使わず、白いマスク内だけを元ページへ合成して守ります。</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <span className="mb-1 block text-[11px] font-medium text-neutral-500">{label}</span>
      {children}
    </div>
  );
}
