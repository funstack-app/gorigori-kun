import { useEffect, useMemo, useRef, useState } from "react";

import { images } from "../../../lib/ipc";
import {
  ComicTextTurnTimeoutError,
  runComicTextTurn,
} from "../../../lib/comic/codexText";
import {
  buildFullPagePrompt,
  buildStoryPrompt,
  isValidStory,
  MAX_STORY_PAGES,
  parseComicStory,
} from "../../../lib/comic/prompts";
import type {
  ComicCharacter,
  ComicColorMode,
  ComicImageCharacter,
  ComicPageResult,
  ComicPanel,
  ComicPhase,
  ComicSaveFormat,
  ComicStoryPage,
  PageCountChoice,
} from "../../../lib/comic/types";
import {
  COMIC_LAYOUT_TEMPLATES,
  COMIC_PAGE_ASPECT,
  getComicTemplate,
  type ComicLayoutTemplate,
} from "../../../lib/comic/layoutTemplates";
import { savePageAs, savePagesBulk } from "../../../lib/comic/savePage";
import { COMIC_TEMPLATE_THUMBNAILS } from "./templateThumbnails";
import { ComicPhaseRail } from "./ComicPhaseRail";
import { BalloonEditor, SfxEditor } from "./BalloonEditor";
import { presetKind, usePresets } from "../../../lib/store/presets";
import { selectCharacterReferences } from "../../../lib/presets/character";
import { useToasts } from "../../../lib/store/toasts";
import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { GenerationGauge } from "../../GenerationGauge";
import { ReferenceLibraryModal } from "../../ReferenceLibraryModal";
import { SafeImage } from "../../SafeImage";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { SkillIntro } from "../SkillIntro";
import { beginDirectRun } from "../../../lib/store/generationStatus";
import {
  registerDirectRunParent,
  releaseDirectRunParent,
} from "../../../lib/store/directRun";
import {
  collectUnboundCastNames,
  resolvePageCast,
} from "../../../lib/comic/references";

/** PC から画像を添付するときの拡張子フィルタ（GoalChatPanel と同値）。 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/**
 * 「おまかせ（AI最適化）」タイルの ID。テンプレ定義側には持たせない
 * （layoutTemplates.ts は実在するコマ割りだけを持つ正本のまま）。
 */
const AUTO_TEMPLATE_ID = "auto";

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
  /** コマ絵の画風（白黒/カラー/キャラ忠実）。生成プロンプトのベース句・画風句に効く。 */
  const [colorMode, setColorMode] = useState<ComicColorMode>("mono");

  /** 構成フェーズが確定させたページ割り。plan/pages 工程の正本。 */
  const [storyPages, setStoryPages] = useState<ComicStoryPage[]>([]);
  /** ページ単位の生成結果（コマ別の results のページ版）。 */
  const [pageResults, setPageResults] = useState<ComicPageResult[]>([]);
  const [generatingStory, setGeneratingStory] = useState(false);
  /** 構成生成の開始時刻（推定進捗ゲージの基準）。 */
  const [storyStartedAt, setStoryStartedAt] = useState<number | undefined>(undefined);
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

  useEffect(
    () => () => {
      // アンマウント時は構成生成・全ページ一括・ページ単体をすべて無効化する。
      storyTokenRef.current += 1;
      pagesRunTokenRef.current += 1;
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
    if (!synopsis.trim()) {
      pushToast({ kind: "error", text: "話（あらすじ）を入力してください", ttlMs: 4000 });
      return;
    }
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
    setGeneratingStory(true);
    try {
      const template =
        templateId === AUTO_TEMPLATE_ID ? undefined : getComicTemplate(templateId);
      // 「おまかせ」は AI がページ数を決める（undefined を渡す）。数値指定なら厳密一致を要求する。
      const pageCount = pageCountChoice === "auto" ? undefined : pageCountChoice;
      const prompt = buildStoryPrompt(synopsis, characters, { pageCount, template });
      // 20ページ×最大8コマの JSON は既定 90 秒では不足するため 300 秒を渡す。
      // 第3引数はエラー文言用のラベル（既定「ネーム」のままだと構成の
      // タイムアウトが「ネーム生成がタイムアウト」と出る / 2026-07-28 修正）。
      const raw = await runComicTextTurn(prompt, 300_000, "構成");
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
      if (storyTokenRef.current === runToken) setGeneratingStory(false);
    }
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
    if (batchToken === undefined && generatingPages) return false;
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
      const template = storyTemplateId ? getComicTemplate(storyTemplateId) : null;
      // このページの cast だけを参照・属性・限定句の基準にする（PageCastRow と同じ判定）。
      const resolution = resolvePageCast(page, characters);
      const refPaths = resolution.refPaths;
      // 前後ページのあらすじは構成 state から引く（隣接ページのみ）。
      const idx = storyPages.findIndex((p) => p.page === page.page);
      const prompt = buildFullPagePrompt(
        page.panels,
        template,
        resolution.castCharacters,
        colorMode,
        refPaths.length > 0,
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
            ? { ...r, generating: false, imagePath, startedAt: undefined }
            : r,
        ),
      );
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
    if (generatingPages || pageResults.some((result) => result.generating)) return false;
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
    setPhase("pages");
    void generateAllStoryPages();
  };

  return (
    <>
      <ComicPhaseRail
        phase={phase}
        setPhase={setPhase}
        hasStory={storyPages.length > 0}
        generating={generatingPages || pageResults.some((r) => r.generating)}
        completed={pageResults.filter((r) => r.imagePath).length}
        total={storyPages.length}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 text-neutral-200">
          <SkillIntro
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
              onGenerate={generateStory}
            />
          )}

          {phase === "plan" && (
            <PlanPhase
              storyPages={storyPages}
              characters={characters}
              storyTemplateId={storyTemplateId}
              updateStoryPage={updateStoryPage}
              updateStoryPanel={updateStoryPanel}
              onAssignCast={assignCastName}
              onGeneratePages={generatePagesFromPlan}
              onRegenerateStory={() => void generateStory()}
              generatingStory={generatingStory}
              generatingPages={generatingPages}
            />
          )}

          {phase === "pages" && (
            <PagesPhase
              storyPages={storyPages}
              pageResults={pageResults}
              saveFormat={saveFormat}
              setSaveFormat={setSaveFormat}
              onGeneratePage={generateStoryPage}
              generatingPages={generatingPages}
            />
          )}

        </div>
      </div>
      <ReferenceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(path) => addImageCharacters([path], "library")}
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
  onGenerate,
}: {
  synopsis: string;
  setSynopsis: (v: string) => void;
  templateId: string;
  setTemplateId: (v: string) => void;
  colorMode: ComicColorMode;
  setColorMode: (v: ComicColorMode) => void;
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
  onGenerate: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          話（あらすじ）
        </label>
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
            <span className="text-[12px] font-bold text-pink-300">生成中…</span>
            {storyStartedAt ? (
              <div className="w-full max-w-xs">
                <GenerationGauge startedAt={storyStartedAt} mode="batch" />
              </div>
            ) : null}
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
  onAssignCast,
}: {
  page: ComicStoryPage;
  characters: ComicCharacter[];
  /** 未紐付け名 fromName を登録キャラ toName へ割り当てる（構成全体で置換） */
  onAssignCast: (fromName: string, toName: string) => void;
}) {
  const resolution = resolvePageCast(page, characters);
  // キャラ未選択のときは何も出さない（約束していないことを表示しない）。
  if (characters.length === 0) return null;

  const matchedSet = new Set(resolution.matchedNames.map((n) => n.trim()));
  const statusText =
    resolution.mode === "matched"
      ? `参照画像 ${resolution.refPaths.length}枚を添付`
      : resolution.mode === "fallback"
        ? "参照: 選択キャラ全員（登場キャラ名が登録キャラと一致しないため）"
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
 * 構成の確認（主経路の工程の要）。
 *
 * ページ単位のあらすじ・コマ割り方針と、
 * 各コマの構図・演技・セリフ・擬音・生成プロンプトを直せる。
 * コマ数・ページ数はここでは変えられない（変えると isValidStory を通った
 * 構造が UI で壊れる。構造を変えたいときは「構成をやり直す」）。
 */
function PlanPhase({
  storyPages,
  characters,
  storyTemplateId,
  updateStoryPage,
  updateStoryPanel,
  onAssignCast,
  onGeneratePages,
  onRegenerateStory,
  generatingStory,
  generatingPages,
}: {
  storyPages: ComicStoryPage[];
  characters: ComicCharacter[];
  /** 構成生成が使ったテンプレ（null=おまかせ）。非 null ならコマ割り方針は出さない。 */
  storyTemplateId: string | null;
  updateStoryPage: (pageNo: number, patch: Partial<ComicStoryPage>) => void;
  updateStoryPanel: (
    pageNo: number,
    panelIndex: number,
    patch: Partial<ComicPanel>,
  ) => void;
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
              onAssignCast={onAssignCast}
            />
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
            <div
              key={panel.index}
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
          ))}
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
  storyPages,
  pageResults,
  saveFormat,
  setSaveFormat,
  onGeneratePage,
  generatingPages,
}: {
  storyPages: ComicStoryPage[];
  pageResults: ComicPageResult[];
  saveFormat: ComicSaveFormat;
  setSaveFormat: (v: ComicSaveFormat) => void;
  onGeneratePage: (page: ComicStoryPage) => void;
  generatingPages: boolean;
}) {
  const pushToast = useToasts((s) => s.push);

  async function savePage(imagePath: string | undefined, pageNo: number) {
    if (!imagePath) return;
    try {
      const saved = await savePageAs(imagePath, pageNo, saveFormat);
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
            onClick={() => void saveAllPages()}
            disabled={completedCount === 0 || generatingPages}
            className="rounded-md bg-pink-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            全ページを一括保存
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {storyPages.map((page) => {
          const result = pageResults.find((r) => r.page === page.page);
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
                  disabled={generatingPages || result?.generating}
                  className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-neutral-300 transition hover:border-pink-500/40 disabled:opacity-40"
                >
                  再生成
                </button>
              </div>
              <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded bg-[#0f0f0f]">
                {result?.generating ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4">
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
                    <span className="text-[12px] font-bold text-pink-300">生成中…</span>
                    {result.startedAt ? (
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
                disabled={!result?.imagePath}
                className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                保存
              </button>
            </div>
          );
        })}
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
