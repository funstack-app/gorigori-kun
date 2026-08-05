import "./App.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { switchActiveProject } from "./components/ActiveProjectSelector";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { AuthGate } from "./components/AuthGate";
import { FirstRunStorageNotice } from "./components/FirstRunStorageNotice";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ErrorLogPanel } from "./components/ErrorLogPanel";
import { buildGalleryItemMenu, deleteGalleryImages } from "./components/galleryItemMenu";
import { RegisterPresetDialog } from "./components/RegisterPresetDialog";
import { ImagePreviewModal } from "./components/ImagePreviewModal";
import { LibraryAutoRenameButton } from "./components/LibraryAutoRenameButton";
import { LibraryBatchSaveButton } from "./components/LibraryBatchSaveButton";
import { MaskEditorModal } from "./components/MaskEditorModal";
import { PresetsDrawer } from "./components/PresetsDrawer";
import { SnsExportModal } from "./components/SnsExportModal";
import { PromptComposer } from "./components/PromptComposer";
import { SafeImage } from "./components/SafeImage";
import { ProjectGallery } from "./components/ProjectGallery";
import { SettingsWorkspace } from "./components/SettingsWorkspace";
import { SkillsWorkspace } from "./components/SkillsWorkspace";
import { SkillWorkspaceRouter } from "./components/SkillWorkspaceRouter";
import { Toaster } from "./components/Toaster";
import { GenerationStatusPanel } from "./components/GenerationStatusPanel";
import { Badge, Button, EmptyState, SegmentedTabs } from "./components/ui";
import { attachWindowDragDrop } from "./lib/dragDrop";
import { humanizeError } from "./lib/humanizeError";
import {
  type AuthAccount,
  images as imagesIpc,
  onGenPhase,
  onImageBatch,
  onImageGenerated,
} from "./lib/ipc";
import { ensureMultiAngleEventListener } from "./lib/multiangle/events";
import { applyRelinkResult } from "./lib/relinkApply";
import { restoreUnrecoveredAdoptions } from "./lib/restoreAdoptions";
import { useAccounts } from "./lib/store/accounts";
import { useActiveProject } from "./lib/store/activeProject";
import { useAuth } from "./lib/store/auth";
import { type BatchWorker, useBatches } from "./lib/store/batches";
import { useCloudSupabase } from "./lib/store/cloudSupabase";
import {
  type FrameAspect,
  type Reference,
  type ReferenceRole,
  useComposer,
} from "./lib/store/composer";
import { routeDirectRunBatchEvent } from "./lib/store/directRun";
import { useDragHover } from "./lib/store/dragHover";
import { useImagePreview } from "./lib/store/imagePreview";
import { type GalleryItem, useImages } from "./lib/store/images";
import { useLibrarySelection } from "./lib/store/librarySelection";
import { useMultiAngleRun } from "./lib/store/multiAngleRun";
import { usePlanChat } from "./lib/store/planChat";
import { usePresets } from "./lib/store/presets";
import { exportProjectCsv, type Project, useProjects } from "./lib/store/projects";
import { initializeScene3d } from "./lib/store/scene3d";
import { initializeGeneratedMotions } from "./lib/scene3d/motionStore";
import { useReferenceRoles } from "./lib/store/referenceRoles";
import { usePromptHistory } from "./lib/store/promptHistory";
import { useSavedPrompts } from "./lib/store/savedPrompts";
import { useWorldContexts } from "./lib/store/worldContexts";
import { useUnsavedPlanChats } from "./lib/store/unsavedPlanChats";
import { useSceneStore } from "./lib/store/scene";
import { type Session, useSessions } from "./lib/store/sessions";
import { useSettings } from "./lib/store/settings";
import { useSkillMode } from "./lib/store/skillMode";
import { setDrawerOpen, type FocusSkillDetail } from "./lib/store/generationStatus";
import { useSnsExport } from "./lib/store/snsExport";
import { useStoryboardRun } from "./lib/store/storyboardRun";
import { useThreads } from "./lib/store/threads";
import { useErrorLog } from "./lib/store/errorLog";
import { useToasts } from "./lib/store/toasts";
import {
  type ImageMode,
  type LayerKind,
  type PrimaryMode,
  useWorkflow,
  type VideoMode,
} from "./lib/store/workflow";
import { useWorkspace } from "./lib/store/workspace";
import { ensureStoryboardEventListener } from "./lib/storyboard/events";

type DrawerKind =
  | "assets"
  | "references"
  | "history"
  | "presets"
  | "skills"
  | "export"
  | "settings"
  | null;
type SignedInAccount = AuthAccount;
type GuidedPurpose =
  | "ad"
  | "product"
  | "thumbnail"
  | "story"
  | "multiAngle"
  | "removeBg"
  | "layers"
  | "export";

const PURPOSES: Array<{
  id: GuidedPurpose;
  label: string;
  description: string;
  prompt: string;
  workflow: { primary: "image" | "video"; image?: ImageMode; video?: VideoMode };
  /** α版でまだ触らせない目的。UIには残すが選択不可にする。 */
  comingSoon?: boolean;
}> = [
  {
    id: "ad",
    label: "広告画像",
    description: "LPカルーセル広告は近日公開",
    prompt: "広告画像として使える完成度で、商品の魅力が一目で伝わる構図にしてください。",
    workflow: { primary: "image", image: "generate" },
    comingSoon: true,
  },
  {
    id: "product",
    label: "商品カット",
    description: "質感・形状を崩さず見せる",
    prompt:
      "商品カットとして、形状、素材感、光の反射、背景との分離が美しく見えるようにしてください。",
    workflow: { primary: "image", image: "generate" },
  },
  {
    id: "thumbnail",
    label: "サムネ",
    description: "視認性と余白を優先",
    prompt: "サムネイル用途として、主役が強く見え、後から文字を置ける余白を残してください。",
    workflow: { primary: "image", image: "generate" },
  },
  {
    id: "story",
    label: "動画カット",
    description: "連続するストーリー素材",
    prompt:
      "動画用のストーリーカットとして、同じ世界観と被写体を保ちながら次の使えるカットを作ってください。",
    workflow: { primary: "video", video: "story" },
  },
  {
    id: "multiAngle",
    label: "別角度",
    description: "環境固定でカメラだけ動かす",
    prompt:
      "マルチアングル用に、被写体、環境、位置関係、光を固定し、カメラだけを動かした別角度を作ってください。",
    workflow: { primary: "video", video: "multiAngle" },
    comingSoon: true,
  },
  {
    id: "removeBg",
    label: "背景を直す",
    description: "背景変更・削除・差し替え",
    prompt: "背景だけを整理し、主役は保ったまま、使いやすい背景に変更してください。",
    workflow: { primary: "image", image: "edit" },
    comingSoon: true,
  },
  {
    id: "layers",
    label: "レイヤー分け",
    description: "背景/人物/商品/文字を分ける前提",
    prompt: "後から編集しやすいように、背景、人物、商品、文字を分けて扱える構図にしてください。",
    workflow: { primary: "image", image: "layers" },
    comingSoon: true,
  },
  {
    id: "export",
    label: "書き出し",
    description: "採用素材を納品用にまとめる",
    prompt: "採用素材を用途別に整理し、書き出しやすい状態にしてください。",
    workflow: { primary: "image", image: "generate" },
    comingSoon: true,
  },
];

const USE_CASES = [
  "Instagram縦",
  "YouTubeサムネ",
  "LPキービジュアル",
  "広告バナー",
  "商品詳細",
  "ショート動画",
] as const;

const KEEP_OPTIONS: Array<{ label: string; role: ReferenceRole; phrase: string }> = [
  { label: "被写体", role: "subject", phrase: "参照画像の被写体/商品を固定してください。" },
  {
    label: "雰囲気",
    role: "look",
    phrase: "参照画像の光、色、レンズ感、質感を引き継いでください。",
  },
  { label: "背景", role: "background", phrase: "参照画像の背景と空間構造を引き継いでください。" },
  {
    label: "ポーズ",
    role: "pose",
    phrase: "参照画像のポーズやカメラとの関係を引き継いでください。",
  },
];

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function basename(p: string) {
  return p.split("/").pop() ?? p;
}

async function droppedFileToReference(file: File): Promise<Reference | null> {
  const maybePath = (file as unknown as { path?: string }).path;
  if (maybePath) {
    return {
      path: maybePath,
      name: file.name || basename(maybePath),
      source: "upload" as const,
      role: "subject" as const,
    };
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.type.startsWith("image/") && !IMAGE_EXTS.includes(ext)) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  const path = await imagesIpc.writeUpload(file.name || `drop-${Date.now()}.png`, buf);
  return {
    path,
    name: file.name || basename(path),
    source: "upload" as const,
    role: "subject" as const,
  };
}

function App() {
  return (
    <main className="h-screen overflow-hidden bg-[#0b0b0c] text-neutral-100">
      <AuthGate>
        <SignedInScaffold />
      </AuthGate>
      <ApprovalDialog />
      <ImagePreviewModal />
      <MaskEditorModal />
      <SnsExportModalMount />
      <Toaster />
      <ErrorLogPanelMount />
      <GenerationStatusPanel />
      <FirstRunStorageNotice />
    </main>
  );
}

/**
 * エラーログパネルの常設マウント。
 * 開閉は useErrorLog の panelOpen が持つ (サイドバーのボタンから開く)。
 * 起動時に1回だけディスクの過去ログを読み込む。
 */
function ErrorLogPanelMount() {
  const open = useErrorLog((s) => s.panelOpen);
  const closePanel = useErrorLog((s) => s.closePanel);
  const load = useErrorLog((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return <ErrorLogPanel open={open} onClose={closePanel} />;
}

/**
 * W2-2: SNS リサイズ書き出しモーダルの常設マウント。
 * useSnsExport store の paths が設定されたときだけ描画する
 * (MaskEditorModal / ImagePreviewModal と同じく store 駆動の単一マウント)。
 */
function SnsExportModalMount() {
  const paths = useSnsExport((s) => s.paths);
  const close = useSnsExport((s) => s.close);
  if (!paths) return null;
  return <SnsExportModal paths={paths} onClose={close} />;
}

function SignedInScaffold() {
  const { account, logout } = useAuth();
  const settings = useSettings();
  const threads = useThreads();
  const sessionsStore = useSessions();
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const navCollapseManualOverrideRef = useRef(false);

  // 960px 未満ではサイドバーを自動 collapse。ユーザー操作後は手動状態を優先する。
  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    const syncNavCollapsed = () => {
      if (!navCollapseManualOverrideRef.current) {
        setNavCollapsed(media.matches);
      }
    };
    syncNavCollapsed();
    media.addEventListener("change", syncNavCollapsed);
    return () => media.removeEventListener("change", syncNavCollapsed);
  }, []);

  const handleSetNavCollapsed = (collapsed: boolean) => {
    navCollapseManualOverrideRef.current = true;
    setNavCollapsed(collapsed);
  };

  // ConstructedPromptPanel の「スキル」ボタンからスキルページを開けるようにする
  useEffect(() => {
    const onOpenSkills = () => setDrawer("skills");
    window.addEventListener("gori:open-skills", onOpenSkills);
    return () => window.removeEventListener("gori:open-skills", onOpenSkills);
  }, []);

  // GenerationStatusPanel の stuck 案内から設定画面 (アカウント再ログイン) を開く
  useEffect(() => {
    const onOpenSettings = () => setDrawer("settings");
    window.addEventListener("gori:open-settings", onOpenSettings);
    return () => window.removeEventListener("gori:open-settings", onOpenSettings);
  }, []);

  /*
    走っているジョブから、そのスキル画面へ移動する (cne / 2026-08-04)。

    GenerationStatusPanel のジョブ行クリックと、完了トーストの「開く」が
    ここへ届く。移動先で作業が生きているのは S1/S2 の keep-alive の効果で、
    ここがやるのは「見えている画面を切り替える」ことだけ。

    skillId が null は作品モードの生成 (画像生成/動画/AI編集)。この場合は
    スキルを抜けて作品モードへ戻す。

    揃えるゲートは3つ (openSession と同じ考え方):
      1. スキル (skillMode → skillUiMode)
      2. タブ —— 目的の結果が映る枠。**ジョブの種類で変わる** (Sol 評価 blocking#5)。
         専用スキル画面は「画像生成」タブの中だが、AI 編集は「編集」タブ、
         動画は「動画生成」タブが定位置。ここを generate 決め打ちにしていたため、
         AI 編集のジョブ行を押すと画像生成タブが開いて「押したのに何も起きない」
         ように見えていた。行き先の判断は種類の対応表を持つ generationStatus 側に置き、
         ここは受け取った値へ揃えるだけにする。
      3. drawer を閉じる (ライブラリ等が被さっていると隠れたままになる)
    どれか1つでも欠けると「押したのに何も起きない」ように見える。
  */
  useEffect(() => {
    const onFocusSkill = (event: Event) => {
      const detail = (event as CustomEvent<FocusSkillDetail>).detail;
      const skillId = detail?.skillId ?? null;
      const skill = useSkillMode.getState();
      if (skillId) {
        skill.setEnabled(true);
        skill.setSelectedSkillId(skillId);
      } else if (skill.enabled) {
        skill.setEnabled(false);
      }
      // ゲート2: そのジョブの結果が映るタブへ揃える。
      useWorkspace.getState().setActiveTab(detail?.tab ?? "generate");
      // ゲート3: 隠れているスキル画面を表に出す (drawer を閉じる)。
      setDrawer(null);
    };
    window.addEventListener("gori:focus-skill", onFocusSkill);
    return () => window.removeEventListener("gori:focus-skill", onFocusSkill);
  }, []);

  /*
    drawer の開閉を generationStatus へ伝える (cne / 2026-08-04)。

    完了トーストを「裏で終わったときだけ」出すための判定材料。drawer を開いて
    いる間はスキル画面が隠れている (S1 の keep-alive でマウントは維持されるが
    見えていない) ので、そこで終わった生成は通知する価値がある。
    drawer の正本はこの useState のままにし、写しだけを渡す。
  */
  useEffect(() => {
    setDrawerOpen(drawer !== null);
  }, [drawer]);

  const activeSessionId = useSessions((s) => s.activeSessionId);
  const displayedSession = useSessions((s) => s.displayedSession);
  const sessions = useSessions((s) => s.sessions);
  const items = useImages((s) => s.items);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  // ヘッダー左上は「制作」固定 (session 名で動的に変えない方針)。
  // セッション名はチャット履歴 / ヘッダー右側のプロジェクトタグで識別する。
  void activeSession;
  void displayedSession;
  const currentTitle = "制作";

  // 「+ 新規制作」ボタン押下時の名前入力モーダル
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState("");

  const startProject = async (title = "制作") => {
    useBatches.setState({ batches: [] });
    await useSessions.getState().createNew(title);
    useSessions.setState({
      pendingBatchDbTurnIds: [],
      batchToDbTurn: new Map(),
      codexTurnToDbTurn: new Map(),
    });
    setDrawer(null);
  };

  /**
   * スキル生成の走行中に黙ってスキルを終了しない。走行中判定は
   * storyboardRun.markCancelled と同じ基準 (status + cut単位の running)。
   * 続行してよいなら true。openSession と openUnsavedChat が共用する。
   */
  const confirmLeaveSkillIfRunning = async (): Promise<boolean> => {
    const skill = useSkillMode.getState();
    if (!skill.enabled) return true;
    const sb = useStoryboardRun.getState();
    const storyboardActive =
      sb.status === "running" ||
      Array.from(sb.cuts.values()).some((c) => c.status === "running") ||
      Array.from(sb.sketchCuts.values()).some((c) => c.status === "running");
    const multiAngleActive = useMultiAngleRun.getState().status === "running";
    if (!storyboardActive && !multiAngleActive) return true;
    const message =
      "スキルの生成が進行中です。過去のチャットを開くとスキル画面を終了します(生成は裏で続きますが、スキルに入り直すと進行状況の表示は最初からになります)。開きますか?";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "過去のチャットを開く", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    return ok;
  };

  const openSession = async (id: string) => {
    // 件1修正 (2026-07-30): 「開く→」が sessions store (frozen化) しか更新せず、
    // frozen ビュー表示の残り2ゲート (skillUiMode=default / activeTab=generate) を
    // 揃えないため、押しても画面が元のタブ/スキルのままだった。ここで3ゲートを揃える。
    if (!(await confirmLeaveSkillIfRunning())) return;
    await useSessions.getState().switchTo(id);
    // switchTo 失敗時 (トーストは sessions.ts 側で表示) は画面を動かさない。
    const st = useSessions.getState();
    const opened =
      id === st.activeSessionId
        ? !st.isFrozen
        : st.isFrozen && st.displayedSession?.session.id === id;
    if (!opened) return;
    // ゲート1+3: スキルUIモード解除 (skillMode.setEnabled(false) → syncUiMode →
    // skillUiMode.exitSkill() まで伝搬。run データは触らない)。
    // await 中にスキルON された場合に旧スナップショット (skill) が false のままで
    // 解除が空振りするため、最新状態を取り直す (Codex検分 2026-07-30)。
    const skillNow = useSkillMode.getState();
    if (skillNow.enabled) skillNow.setEnabled(false);
    // ゲート2: frozen ビュー (Timeline) を持つ生成タブへ復帰。
    useWorkspace.getState().setActiveTab("generate");
    setDrawer(null);
  };

  /**
   * 未保存の企画チャット (29z 2026-08-03) を企画タブへ復元して開く。
   * 復元後は「（保存しない）」状態に戻すので、続きの会話も同じ台帳エントリへ
   * 退避され続ける。
   */
  const openUnsavedChat = async (id: string) => {
    const entry = useUnsavedPlanChats.getState().items.find((it) => it.id === id);
    if (!entry) {
      useToasts.getState().push({
        kind: "error",
        text: "このチャットは削除されたか、保存期限が切れています。",
        ttlMs: 5000,
      });
      return;
    }
    if (!(await confirmLeaveSkillIfRunning())) return;
    // 現プロジェクトの会話を退避してから「（保存しない）」へ戻す
    // (未保存チャットはプロジェクト未選択の状態でしか成立しないため)。
    const current = useActiveProject.getState().activeProjectId;
    if (current !== null) {
      usePlanChat.getState().switchToProject(current, null);
      useActiveProject.getState().setActive(null);
    }
    usePlanChat.getState().restoreUnsaved(entry);
    const skillNow = useSkillMode.getState();
    if (skillNow.enabled) skillNow.setEnabled(false);
    useWorkspace.getState().setActiveTab("plan");
    setDrawer(null);
  };

  /**
   * 案件（プロジェクト）に保存済みの企画チャットを開く (xwl)。
   * 切替の正規手順 switchActiveProject（未保存破棄ガード込み）を再利用する。
   */
  const openProjectPlanChat = async (projectId: string) => {
    if (!(await confirmLeaveSkillIfRunning())) return;
    const { activeProjectId, setActive } = useActiveProject.getState();
    if (activeProjectId !== projectId) {
      await switchActiveProject(setActive, projectId, activeProjectId);
      // ガード（未保存チャット破棄の確認）でキャンセルされたら画面を動かさない
      if (useActiveProject.getState().activeProjectId !== projectId) return;
    }
    const skillNow = useSkillMode.getState();
    if (skillNow.enabled) skillNow.setEnabled(false);
    useWorkspace.getState().setActiveTab("plan");
    setDrawer(null);
  };

  useEffect(() => {
    settings.load().then(() => {
      const s = useSettings.getState().settings;
      if (s.defaultModel) threads.setSelectedModel(s.defaultModel);
      if (s.defaultEffort) threads.setSelectedEffort(s.defaultEffort);
      if (s.defaultCwd) threads.setCwd(s.defaultCwd);
    });

    threads.attachListeners();
    threads.loadModels();
    threads.ensureThread().catch((err) => console.error("ensureThread failed", err));
    sessionsStore.load();
    usePromptHistory.getState().load();
    useSavedPrompts.getState().load();
    useWorldContexts.getState().load();
    // 未保存の企画チャット台帳 (29z 2026-08-03)。チャット履歴ページで復元できる。
    void useUnsavedPlanChats.getState().load();
    useImages.getState().attachListeners();
    useImages.getState().startWatcher();
    // 判定 (採用/ボツ) とお気に入りを起動時にロードして、ライブラリ
    // (AssetsWorkspace) でも右クリックメニューとバッジが正しい現在値を出せる
    // ようにする。
    // B-01: fire-and-forget をやめ、Promise を捕まえて下の relink バリアへ入れる。
    // 読込が relink より遅れて完了すると、ファイル上の旧パスで state を丸ごと
    // 上書きし、張り替え済みのお気に入り・採否が旧パスへ巻き戻ってしまう。
    const favoritesInit = useImages
      .getState()
      .loadFavorites()
      .catch((err) => {
        console.warn("favorites load failed", err);
      });
    const judgementsInit = useImages
      .getState()
      .loadJudgements()
      .catch((err) => {
        console.warn("judgements load failed", err);
      });
    // スキル生成イベント listener を起動時に張る (待機中 0/N 固着バグ修正 2026-06-06)。
    // 各 Workspace の useEffect で張ると listen() の解決前に生成を開始した場合に
    // cutStarted/cutCompleted を取りこぼす。idempotent singleton なので二重登録はされない。
    void ensureMultiAngleEventListener();
    void ensureStoryboardEventListener().catch(() => undefined);
    useAccounts.getState().refresh();
    // v0.6.9: プロジェクトをファイル保存に移行。起動時にファイルから読み出し、
    // 旧 localStorage データがあればファイルへマイグレーション。
    // 初期化が終わってから、記録パスと実体のズレを再リンクで解消する。
    // α版→β版で画像の保存先が変わり、history.db / projects.json の旧パスに
    // 実体が無くて「画像が見えない」症状を直す (非破壊・冪等)。
    // 2026-07-30: プリセット(キャラ含む)もファイル正本へ移行。localStorage は
    // WebView ビルドID (app.codexframefactory / .dev / .capture) ごとに別領域で、
    // ビルドを跨ぐと空に見える + 終了タイミングで失われるため、再起動消失の根治。
    // rr2: relink 結果は presets にも適用するようになったため、fire-and-forget を
    // やめて Promise を捕まえる。initialize (ファイル読込) が relink 適用より後に
    // 完了すると、読み込んだ内容で張り替え済みの state が上書きされて消える
    // (presets には referenceRoles の mutatedPaths のような合流機構が無い)。
    // reject しても他面の適用は続けたいので、ここで catch して握り潰す
    // (エラー自体は各 initialize が console に出す)。
    const presetsInit = usePresets
      .getState()
      .initialize()
      .catch((err) => {
        console.warn("presets.initialize failed", err);
      });
    // r9c: 参照ロール割当 (これはキャラ/これはスタイル) も localStorage 単独だった。
    // plugin-store (reference-roles.json) へ移行する。favorites/judgements と同型。
    const rolesInit = useReferenceRoles
      .getState()
      .initialize()
      .catch((err) => {
        console.warn("referenceRoles.initialize failed", err);
      });
    // 3Dシーンも presets と同型の時限爆弾 (localStorage 単独) だったためファイル正本へ。
    // 初期表示は localStorage の同期読み込みで成立しており、ファイルからの上書きは
    // 非同期で追いつけばよい (sceneInitializeToken が古い結果の上書きを防ぐ)。
    void initializeScene3d();
    // gj7: 3Dモーション仕様 (AI生成/動画取り込み) も localStorage 単独だった。
    // 参照元の scene3d.json と同じファイル正本へ揃え、シーンだけ残って
    // モーション実体が消える (clipId が宙に浮く) 状態を無くす。
    void initializeGeneratedMotions();
    // rr2: relink の実行は presets / referenceRoles / projects の初期化が全部
    // 終わってから。適用先の store がまだファイルを読んでいる最中だと、
    // 張り替えが読込結果で上書きされて失われる。
    // B-01: favorites / judgements も同じ理由でバリアに含める (6 面すべて対称)。
    // なお images.ts 側にも累積 pathMap のリプレイを入れてあるので、
    // ImageGallery 等からの後発ロードでも巻き戻らない (二重の防御)。
    Promise.all([
      presetsInit,
      rolesInit,
      favoritesInit,
      judgementsInit,
      useProjects.getState().initialize(),
    ])
      .then(() => imagesIpc.relinkMissing())
      .then((result) => {
        // projects / presets / favorites / judgements / referenceRoles の
        // 5 面へ一括適用する (history.db は Rust が張り替え済み)。
        applyRelinkResult(result);
        // rr2: 絵コンテ生成中にアプリが落ちて、採用したカットがプロジェクトへ
        // 未回収のままなら復元する。relink 後に呼ぶことで、採用時に焼いた
        // 画像パスが移動していても張り替えた上で復元できる。
        void restoreUnrecoveredAdoptions(result.pathMap);
      })
      .catch((err) => {
        console.error("projects.initialize / relink failed", err);
      });

    let cancelled = false;
    const armed: Array<() => void> = [];
    const arm = <T extends () => void>(p: Promise<T>) => {
      p.then((unlisten) => {
        if (cancelled) unlisten();
        else armed.push(unlisten);
      });
    };

    arm(
      attachWindowDragDrop({
        onHoverChange: (active) => useDragHover.getState().setActive(active),
      }),
    );
    // 生成フェーズ (順番待ち→AI準備中→描画中→完成)。既に app-server が
    // 送っていたのに受信者がいなかった通知を、ここで初めて拾う (設計書 S1)。
    arm(
      onGenPhase((e) => {
        useBatches.getState().applyPhase(e);
      }),
    );
    arm(
      onImageBatch((e) => {
        // direct-run（漫画など）の子 batch はレジストリが親ジョブへ橋渡しし、
        // カード/幽霊ジョブを作らない（消費したら applyEvent に渡さない）。
        const consumed = routeDirectRunBatchEvent(e);
        if (!consumed) useBatches.getState().applyEvent(e);
        const sess = useSessions.getState();
        if (e.kind === "started") sess.bindBatch(e.batchId);
        if (e.kind === "workerCompleted") {
          const dbTurnId = sess.getBatchDbTurnId(e.batchId);
          if (dbTurnId) {
            sess.recordImage({
              turnId: dbTurnId,
              path: e.path,
              mtimeMs: Date.now(),
              size: 0,
              kind: "created",
            });
          }
          // ユーザー要望: アクティブプロジェクトに自動で画像を追加する。
          // 「採用→生成→アーカイブ」の流れを 1 操作にまとめる。
          // 採用プロンプトが分かるよう、batch.prompt を一緒に保存。
          const activeProjectId = useActiveProject.getState().activeProjectId;
          if (activeProjectId && e.path) {
            const batch = useBatches.getState().batches.find((b) => b.batchId === e.batchId);
            useProjects.getState().addItem(activeProjectId, {
              imagePath: e.path,
              prompt: batch?.prompt,
            });
          }
        }
        if (e.kind === "completed") sess.unbindBatch(e.batchId);
      }),
    );
    arm(
      onImageGenerated((ev) => {
        if (ev.kind !== "created") return;
        const { codexTurnToDbTurn, recordImage } = useSessions.getState();
        const activeTurns = useImages.getState().activeTurns;
        const codexTurnId = activeTurns[activeTurns.length - 1];
        if (!codexTurnId) return;
        const dbTurnId = codexTurnToDbTurn.get(codexTurnId);
        if (!dbTurnId) return;
        recordImage({
          turnId: dbTurnId,
          path: ev.path,
          mtimeMs: ev.mtime_ms,
          size: ev.size,
          kind: ev.kind,
        });
      }),
    );

    return () => {
      cancelled = true;
      armed.forEach((u) => u());
    };
  }, []);

  const submitCreate = async () => {
    const name = createDraft.trim() || "新規制作";
    setCreateModalOpen(false);
    setCreateDraft("");
    // 新規制作 = 新しいプロジェクトを作って active にする。
    //   - サイドバーの「作成」ボタンの本来の意図は「新しい制作の箱を作る」
    //   - session ではなく projects レコードを作る (ヘッダー左上は固定で「制作」のまま)
    //   - active プロジェクトが切り替わるとタイムラインの「過去の生成」は
    //     projectImagePaths フィルタで自動的に空になる
    //   - 参照画像 (シーン構築) 横のプロジェクト名タグがこの新プロジェクト名に切り替わる
    //   - useProjects は zustand store なので、ActiveProjectSelector (プルダウン)
    //     と ProjectsWorkspace (プロジェクトページ) も自動で同期する
    const prevProjectId = useActiveProject.getState().activeProjectId;
    const created = useProjects.getState().createProject(name);
    // 新規プロジェクト作成も「別案件を始める」切替なので、前案件のシーン構築値を
    // クリアする (#5/R-2 残留対策 2026-06-07)。override は ActiveProjectSelector の
    // switchActiveProject と同じく消さない (動画 i2v を巻き込まないため)。
    useSceneStore.getState().resetScene();
    // 未保存チャット引き継ぎ (2026-07-30): プロジェクト未選択 (保存しない) のまま
    // 進めた企画チャットは、新規作成 = 「この会話を残したい」の意思表示なので、
    // switchToProject が走る前に新プロジェクトへ全量保存する (ActiveProjectSelector
    // の handleCreate と同じ根治。先に書いておけば切替時のロードで読み戻される)。
    const carried =
      prevProjectId === null
        ? usePlanChat.getState().carryOverToProject(created.id)
        : 0;
    // FB#A6 (2026-06-08): 企画チャットもプロジェクトに紐づける。旧プロジェクトへ
    // 現在の会話を保存してから、新規プロジェクト (planChat 空) をロード = ゼロスタート。
    usePlanChat.getState().switchToProject(prevProjectId, created.id);
    useActiveProject.getState().setActive(created.id);
    setDrawer(null);
    // 作成完了の視覚フィードバック (画面のどこを見ても変化があるか分かりにくいため)
    useToasts.getState().push({
      kind: "success",
      text: `プロジェクト「${created.name}」を作成 / 切替`,
      ttlMs: 2400,
    });
    if (carried > 0) {
      useToasts.getState().push({
        kind: "success",
        text: `企画チャットを「${created.name}」へ引き継ぎました`,
        ttlMs: 3000,
      });
    }
  };

  return (
    <>
      <Workspace
        title={currentTitle}
        drawer={drawer}
        setDrawer={setDrawer}
        onCreate={startProject}
        onOpenNewModal={() => {
          setCreateDraft("");
          setCreateModalOpen(true);
        }}
        onOpen={openSession}
        onOpenUnsaved={openUnsavedChat}
        onOpenProjectChat={openProjectPlanChat}
        account={account}
        onLogout={logout}
        assetCount={items.length}
        navCollapsed={navCollapsed}
        onSetNavCollapsed={handleSetNavCollapsed}
      />
      {createModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setCreateModalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-[#2a2a2a] bg-[#161616] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-semibold text-white">新規制作</h3>
            <p className="mb-4 text-[11px] text-neutral-500">
              制作の名前を入力してください。後から変更できます。
            </p>
            <input
              type="text"
              autoFocus
              value={createDraft}
              onChange={(e) => setCreateDraft(e.target.value)}
              onKeyDown={(e) => {
                const isComposing =
                  (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
                if (e.key === "Enter" && !isComposing) {
                  e.preventDefault();
                  void submitCreate();
                } else if (e.key === "Escape") {
                  setCreateModalOpen(false);
                }
              }}
              placeholder="例: 〇〇商品 LP 用素材 / 新規案件"
              className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="h-8 rounded-md border border-[#343434] bg-[#101010] px-3 text-[11px] font-medium text-neutral-300 hover:border-[#444] hover:text-white"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void submitCreate()}
                className="h-8 rounded-md bg-pink-500 px-4 text-[11px] font-semibold text-white hover:bg-pink-600"
              >
                作成
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function HomeScreen({
  sessions,
  onCreate,
  onOpen,
}: {
  sessions: Session[];
  onCreate: (title?: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
}) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#0b0b0c] px-8 py-8 text-neutral-100">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-pink-400">開始</p>
            <h1 className="mt-2 text-4xl font-black tracking-normal text-white">
              何をゴリゴリ作りますか？
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-400">
              案件を選ぶか、目的ボタンから開始します。プロンプトをゼロから書かなくても、選択内容から制作フローを組み立てます。
            </p>
          </div>
          <Button tone="primary" size="md" onClick={() => void onCreate("新規案件")}>
            空の案件を作る
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          {PURPOSES.slice(0, 4).map((purpose) => (
            <button
              key={purpose.id}
              type="button"
              disabled={purpose.comingSoon}
              onClick={() => {
                if (purpose.comingSoon) return;
                useComposer.getState().setText(purpose.prompt);
                applyPurposeWorkflow(purpose);
                void onCreate(purpose.label);
              }}
              className={`rounded-2xl border p-4 text-left shadow-sm transition ${
                purpose.comingSoon
                  ? "cursor-not-allowed border-[#222] bg-[#111] opacity-55"
                  : "border-[#2a2a2a] bg-[#181818] hover:-translate-y-0.5 hover:border-pink-400 hover:shadow-md"
              }`}
            >
              <span className="text-lg font-black text-white">{purpose.label}</span>
              {purpose.comingSoon && (
                <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-black text-neutral-500">
                  近日公開
                </span>
              )}
              <span className="mt-2 block text-xs leading-relaxed text-neutral-400">
                {purpose.description}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="rounded-3xl border border-[#2a2a2a] bg-[#151515] p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black text-white">最近の案件</h2>
                <p className="text-xs text-neutral-500">ChatGPTの履歴のように制作へ戻ります。</p>
              </div>
              <Badge>{sessions.length} 件</Badge>
            </div>
            {sessions.length === 0 ? (
              <EmptyState
                title="まだ案件がありません"
                description="目的ボタンか新規案件から始めます。"
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {sessions.slice(0, 8).map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    onOpen={() => void onOpen(session.id)}
                  />
                ))}
              </div>
            )}
          </div>
          <div
            className="rounded-3xl border border-dashed border-[#3a3a3a] bg-[#181818] p-5"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={async (e) => {
              e.preventDefault();
              const refs = (
                await Promise.all(
                  Array.from(e.dataTransfer.files ?? []).map(droppedFileToReference),
                )
              ).filter((ref): ref is Reference => !!ref);
              if (refs.length === 0) return;
              useComposer.getState().addReferences(refs);
              useComposer
                .getState()
                .setText("この参照画像をもとに、用途に合わせて制作してください。");
              await onCreate("参照画像から開始");
            }}
          >
            <p className="text-lg font-black text-white">画像をドロップして開始</p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">
              参照画像から案件を開始し、被写体固定・ルック参照・動画カット化へ進めます。
            </p>
            <div className="mt-5 rounded-2xl border border-dashed border-pink-400/50 bg-[#111] px-4 py-10 text-center text-sm font-bold text-pink-300">
              参照画像をここにドロップ
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Workspace({
  title,
  drawer,
  setDrawer,
  onCreate,
  onOpenNewModal,
  onOpen,
  onOpenUnsaved,
  onOpenProjectChat,
  account,
  onLogout,
  assetCount,
  navCollapsed,
  onSetNavCollapsed,
}: {
  title: string;
  drawer: DrawerKind;
  setDrawer: (drawer: DrawerKind) => void;
  onCreate: (title?: string) => Promise<void>;
  onOpenNewModal: () => void;
  onOpen: (id: string) => Promise<void>;
  onOpenUnsaved: (id: string) => Promise<void>;
  onOpenProjectChat: (projectId: string) => Promise<void>;
  account: SignedInAccount;
  onLogout: () => void;
  assetCount: number;
  navCollapsed: boolean;
  onSetNavCollapsed: (collapsed: boolean) => void;
}) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[#0b0b0c] text-neutral-100">
      <DarkGlobalNav
        drawer={drawer}
        setDrawer={setDrawer}
        onCreate={onCreate}
        onOpenNewModal={onOpenNewModal}
        account={account}
        onLogout={onLogout}
        assetCount={assetCount}
        collapsed={navCollapsed}
        onCollapsedChange={onSetNavCollapsed}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#121212]">
        <BoardHeader title={title} activePage={drawer} />
        {/*
         * STΛCK 指示 (2026-08-04 / bd 2ak): スキル画面 (SkillWorkspaceRouter) は
         * drawer ページ (ライブラリ等) へ移動しても **unmount しない**。
         * 従来は WorkspacePage の switch が drawer ページを「代わりに」返していたため
         * スキル側のサブツリーごと破棄され、
         *   - ComicFlow 等の useState (phase / あらすじ / 生成結果) が全損
         *   - 生成司令塔の async クロージャが孤児化し setState が no-op になり結果が UI に戻らない
         * という「完成品画面が消えて戻れない」が起きていた。
         * SkillWorkspaceRouter 内のタブ切替 (SkillWorkspaceRouter.tsx:95) と同じ
         * display: contents / none の keep-alive を drawer 遷移レベルへ移植する。
         * display:contents はラッパー自身をレイアウトから消すので、親 flex 列の
         * 見た目は従来 (子の <section> が直下にあった状態) と同一。
         */}
        <div style={{ display: drawer === null ? "contents" : "none" }}>
          {/*
           * 隠していることを Router へも伝える (Sol 評価 2周目 blocking#1)。
           * display:none だけだとマウントは生きたままなので、スキル側の
           * useSkillVisible が true のままになり、ライブラリを開いている間も
           * 3D の Space / 矢印 / Cmd+Z が見えない画面へ届いていた。
           */}
          <SkillWorkspaceRouter hiddenByDrawer={drawer !== null} />
        </div>
        {drawer !== null && (
          <WorkspacePage
            page={drawer}
            setDrawer={setDrawer}
            onCreate={onCreate}
            onOpen={onOpen}
            onOpenUnsaved={onOpenUnsaved}
            onOpenProjectChat={onOpenProjectChat}
          />
        )}
      </div>
    </div>
  );
}

function WorkspacePage({
  page,
  setDrawer,
  onCreate,
  onOpen,
  onOpenUnsaved,
  onOpenProjectChat,
}: {
  // スキル画面は Workspace 側で常時マウントされる (keep-alive) ため、
  // ここは drawer ページ専用。null は呼び出し側で弾く。
  page: Exclude<DrawerKind, null>;
  setDrawer: (drawer: DrawerKind) => void;
  onCreate: (title?: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onOpenUnsaved: (id: string) => Promise<void>;
  onOpenProjectChat: (projectId: string) => Promise<void>;
}) {
  // onCreate は将来 ProjectsWorkspace 内の「セッション同時作成」フローで使う想定
  // 現時点では使っていないが、呼び出し側との型契約は維持する。
  void onCreate;
  switch (page) {
    case "assets":
      return <AssetsWorkspace />;
    case "references":
      return <ReferencesWorkspace />;
    case "history":
      return <ProjectsWorkspace />;
    case "presets":
      return <PresetsWorkspace onNavigateToSkill={() => setDrawer(null)} />;
    case "skills":
      return <SkillsWorkspace onUseSkill={() => setDrawer(null)} />;
    case "export":
      return (
        <ChatHistoryWorkspace
          onOpen={onOpen}
          onOpenUnsaved={onOpenUnsaved}
          onOpenProjectChat={onOpenProjectChat}
        />
      );
    case "settings":
      return <SettingsWorkspace />;
    default:
      return null;
  }
}

function PresetsWorkspace({ onNavigateToSkill }: { onNavigateToSkill?: () => void }) {
  // BoardHeader が画面上に「プリセット」タイトルを既に出すので、ここでは
  // PageIntro を使わず本体だけ描画する（重複表示を避ける）。
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <PresetsDrawer fullPage onNavigateToSkill={onNavigateToSkill} />
      </div>
    </section>
  );
}

const retainedWorkspaceParts = [CreationPanel, CreativeBoard];
void retainedWorkspaceParts;

/*
 * サイドバー用ナビアイコン (Lucide / Heroicons 系のラインアイコン)
 * 全て 16x16 viewBox、1.5px stroke、currentColor で色は親から継承する。
 *
 * 意味:
 *  - 制作: ハンマー (=ものづくり)
 *  - ライブラリ: 写真を重ねたカード (=画像コレクション)
 *  - プロジェクト: フォルダ (=アーカイブ箱)
 *  - プリセット: ブックマーク (=保存済みテンプレート)
 *  - チャット履歴: 吹き出し + 履歴の線 (=過去の会話)
 */
function NavIconCreate() {
  // ペン (鉛筆): クリエイティブ制作の象徴
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M12 2L14 4L5.5 12.5L3 13L3.5 10.5L12 2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 3L13 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function NavIconLibrary() {
  // 写真スタック: 画像コレクション
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.5" y="4.5" width="9" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="5.5" cy="7.5" r="0.9" fill="currentColor" />
      <path
        d="M2.5 11.5L5.5 8.5L8 11L9.5 10L11.5 12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function NavIconProjects() {
  // フォルダ: アーカイブ箱
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 5V11.5C2 12.3 2.7 13 3.5 13H12.5C13.3 13 14 12.3 14 11.5V6.5C14 5.7 13.3 5 12.5 5H8L6.5 3.5H3.5C2.7 3.5 2 4.2 2 5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function NavIconPresets() {
  // ブックマーク: 保存済みテンプレ
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 2.5H12V13.5L8 10.5L4 13.5V2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavIconSkills() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.8L9.15 5.3L12.8 6.1L9.95 8.45L10.35 12.1L8 10.15L5.65 12.1L6.05 8.45L3.2 6.1L6.85 5.3L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M13 2.5V4.5M12 3.5H14M2.5 10.5V12.5M1.5 11.5H3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function NavIconChat() {
  // 吹き出し + 履歴を示す内部の線
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H12.5C13.05 2.5 13.5 2.95 13.5 3.5V9.5C13.5 10.05 13.05 10.5 12.5 10.5H6L3.5 13V10.5C2.95 10.5 2.5 10.05 2.5 9.5V3.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <line
        x1="5"
        y1="5.5"
        x2="11"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <line
        x1="5"
        y1="7.5"
        x2="9"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
function NavIconErrorLog() {
  // 三角の警告 + 履歴を示す下線 (エラーが残るログ)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.5L14 12.5H2L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5V9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10.8" r="0.7" fill="currentColor" />
    </svg>
  );
}

/**
 * サイドバーの「エラーログ」項目。
 * ドロワー (drawer) ではなくモーダルパネルを開くので nav() とは別実装にする。
 * 未読があればピンクの件数バッジを出す。
 */
function NavErrorLogButton({ collapsed }: { collapsed: boolean }) {
  const unreadCount = useErrorLog((s) => s.unreadCount);
  const openPanel = useErrorLog((s) => s.openPanel);
  const badge = unreadCount > 99 ? "99+" : String(unreadCount);
  return (
    <button
      type="button"
      onClick={openPanel}
      title="エラーログ"
      className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-neutral-300 transition hover:bg-[#242424] hover:text-white"
    >
      <span className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
        <NavIconErrorLog />
        {collapsed && unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-pink-500 px-1 text-[9px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <>
          <span className="whitespace-nowrap">エラーログ</span>
          {unreadCount > 0 && (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-pink-500 px-1.5 text-[10px] font-bold leading-none text-white">
              {badge}
            </span>
          )}
        </>
      )}
    </button>
  );
}

function NavIconSettings() {
  // 標準的な歯車アイコン (8歯、中央に円)
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DarkGlobalNav({
  drawer,
  setDrawer,
  onCreate,
  onOpenNewModal,
  account,
  onLogout,
  assetCount,
  collapsed,
  onCollapsedChange,
}: {
  drawer: DrawerKind;
  setDrawer: (drawer: DrawerKind) => void;
  onCreate: (title?: string) => Promise<void>;
  onOpenNewModal: () => void;
  account: SignedInAccount;
  onLogout: () => void;
  assetCount: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  // onCreate は新モーダル経由で使うので保持。
  void onCreate;
  const nextCollapsed = !collapsed;
  const nav = (kind: DrawerKind, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onPointerDown={() => setDrawer(kind)}
      onClick={() => setDrawer(kind)}
      title={label}
      className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition ${
        drawer === kind
          ? "bg-[#303030] text-white"
          : "text-neutral-300 hover:bg-[#242424] hover:text-white"
      }`}
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">{icon}</span>
      {!collapsed && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );

  return (
    <aside
      className={`flex h-full min-h-0 flex-shrink-0 flex-col border-r border-[#242424] bg-[#151515] px-3 py-4 transition-[width] ${collapsed ? "w-[64px]" : "w-[200px]"}`}
    >
      {/*
        ヘッダー: GORI GORI タイプロゴ + 右端にサイドバー開閉アイコン
        (Magnific 公式 UI と同じ並び: ロゴ … 開閉ボタン)
      */}
      <div
        className={`mb-5 flex items-center gap-2 ${
          collapsed ? "justify-center" : "justify-between"
        }`}
      >
        <button
          type="button"
          onClick={() => setDrawer(null)}
          className={`flex items-baseline ${
            collapsed ? "justify-center" : "min-w-0 flex-1 text-left"
          }`}
          title="制作"
        >
          {/*
            ロゴフォント: Facon。Geist 本文との対比のため少し大きめにする。
            ただしサイドバー幅 (w-[200px]) から開閉ボタン (~28px) と
            gap を引いた範囲に収まる必要がある。22px に抑えて、
            右端ボタンが押し出されないようにする。
          */}
          {collapsed ? (
            <span className="logo-font text-[22px] leading-none text-white">GG</span>
          ) : (
            <span className="logo-font truncate text-[22px] leading-none text-white">
              GORI GORI
            </span>
          )}
        </button>
        {!collapsed && (
          <button
            type="button"
            onClick={() => onCollapsedChange(nextCollapsed)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-[#1f1f1f] hover:text-white"
            title="サイドバーを閉じる"
            aria-label="サイドバーを閉じる"
          >
            {/* Magnific 風サイドバートグルアイコン (SVG) */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden
            >
              <rect
                x="1.5"
                y="2.5"
                width="13"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={() => onCollapsedChange(nextCollapsed)}
          className="mb-3 flex h-7 w-full items-center justify-center rounded-md text-neutral-400 hover:bg-[#1f1f1f] hover:text-white"
          title="サイドバーを開く"
          aria-label="サイドバーを開く"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      )}
      {/*
        作成ボタン (Magnific 風): ピンクの角丸四角アイコン + 「作成」テキスト。
        押すと制作名入力モーダルが開く。
      */}
      <button
        type="button"
        onClick={onOpenNewModal}
        title="新しい制作を始める"
        className={`mb-4 flex items-center gap-2.5 text-left text-sm font-medium text-white transition hover:text-pink-200 ${
          collapsed ? "justify-center" : ""
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-500 text-white shadow-sm transition hover:bg-pink-600">
          <PlusIcon />
        </span>
        {!collapsed && <span>作成</span>}
      </button>
      <div className="space-y-1">
        <button
          type="button"
          onPointerDown={() => setDrawer(null)}
          onClick={() => setDrawer(null)}
          title="制作"
          className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-bold transition ${
            drawer === null
              ? "bg-[#303030] text-white"
              : "text-neutral-300 hover:bg-[#242424] hover:text-white"
          }`}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <NavIconCreate />
          </span>
          {!collapsed && <span className="whitespace-nowrap">制作</span>}
        </button>
        {nav("assets", "ライブラリ", <NavIconLibrary />)}
        {nav("history", "プロジェクト", <NavIconProjects />)}
        {nav("presets", "プリセット", <NavIconPresets />)}
        {nav("skills", "スキル", <NavIconSkills />)}
      </div>
      <NavAccountFooter
        account={account}
        assetCount={assetCount}
        onLogout={onLogout}
        collapsed={collapsed}
        chatNav={nav("export", "チャット履歴", <NavIconChat />)}
        settingsNav={nav("settings", "設定", <NavIconSettings />)}
      />
    </aside>
  );
}

function NavAccountFooter({
  account,
  assetCount,
  onLogout,
  collapsed,
  chatNav,
  settingsNav,
}: {
  account: SignedInAccount;
  assetCount: number;
  onLogout: () => void;
  collapsed: boolean;
  chatNav?: React.ReactNode;
  settingsNav?: React.ReactNode;
}) {
  return (
    <div className="mt-auto space-y-2 border-t border-[#242424] pt-3">
      {/* チャット履歴・エラーログ・設定はサイドバー最下部、フッター情報の上に配置 */}
      <div className="space-y-1">
        {chatNav}
        <NavErrorLogButton collapsed={collapsed} />
        {settingsNav}
      </div>
      {!collapsed && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-bold text-neutral-500">素材</span>
            <span className="text-sm font-black text-white">{assetCount}</span>
          </div>
        </div>
      )}
      {!collapsed && <StorageIndicator />}
      {!collapsed && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5">
          <p className="truncate text-[11px] font-black text-neutral-200">
            {account?.type === "apiKey" ? "API キー" : "ChatGPT"}
            {account?.planType ? ` · ${account.planType}` : ""}
          </p>
          <p className="text-[10px] text-neutral-500">ユーザー認証で生成</p>
        </div>
      )}
      {!collapsed && (
        <button
          type="button"
          onClick={onLogout}
          className="h-7 w-full rounded-lg border border-[#343434] bg-[#1e1e1e] text-[11px] font-bold text-neutral-300 hover:border-rose-400 hover:text-rose-200"
        >
          ログアウト
        </button>
      )}
      {/*
        クレジット表示 (改変防止 Lv1, 2026-05-15):
        無料配布版でも「Powered by STΛCK」を残すことで、
        改変版が出回ったときにブランドの希釈を防ぐ。
        小さく控えめなので一般ユーザーの体験は損なわない。
      */}
      {!collapsed && (
        <p className="pt-2 text-center text-[9px] font-bold tracking-wider text-neutral-600">
          Powered by STΛCK
        </p>
      )}
    </div>
  );
}

/**
 * サイドバー左下のローカル保存先使用容量表示。
 * 5GB超で警告色（黄）、10GB超で赤。
 * 30秒ごとに自動更新。
 */
function StorageIndicator() {
  const [stats, setStats] = useState<import("./lib/ipc").StorageUsageStats | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const cloudUsage = useCloudSupabase((s) => s.usage);
  // v0.6.13 STΛCK 指示: クラウドストレージ連携はβ以降のため、
  // 起動時/定期の自動接続テストを停止する。
  // (Supabase RLS 403 エラーが30秒ごとにトースト表示される問題)

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const { storage } = await import("./lib/ipc");
        const [s, h] = await Promise.all([storage.usageStats(), storage.homeDir()]);
        setStats(s);
        setHome(h);
      } catch {
        /* noop */
      }
    };
    void fetchAll();
    const handle = setInterval(() => void fetchAll(), 30_000);
    return () => clearInterval(handle);
  }, []);

  if (!stats) return null;

  const gb = stats.totalBytes / (1024 * 1024 * 1024);
  const mb = stats.totalBytes / (1024 * 1024);
  const display = gb >= 1 ? `${gb.toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  const tone = gb >= 10 ? "text-rose-300" : gb >= 5 ? "text-amber-300" : "text-neutral-300";
  const cloudTone =
    cloudUsage && cloudUsage.limitBytes > 0 && cloudUsage.usedBytes / cloudUsage.limitBytes > 0.8
      ? "text-amber-300"
      : "text-sky-300";
  // ホームディレクトリを ~/ に短縮表示。Rust 側で解決した home を使う。
  let shortPath = stats.storageRoot;
  if (home && shortPath.startsWith(home)) {
    shortPath = "~" + shortPath.slice(home.length);
  }
  shortPath = shortPath.replace(
    /~\/Library\/Mobile Documents\/com~apple~CloudDocs/,
    "~/iCloud Drive",
  );

  return (
    <div className="space-y-1 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-500">ローカル</span>
          <span className={`text-[11px] font-black tabular-nums ${tone}`}>{display}</span>
        </div>
        <p
          className="mt-1 truncate font-mono text-[9px] text-neutral-500"
          title={stats.storageRoot}
        >
          {shortPath}
        </p>
        <p className="mt-0.5 text-[9px] tabular-nums text-neutral-600">
          {stats.fileCount} ファイル
        </p>
      </div>
      {cloudUsage && (
        <div className="border-t border-[#242424] pt-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1 text-[10px] font-bold text-neutral-500">
              <CloudIcon />
              Supabase
            </span>
            <span className={`text-[11px] font-black tabular-nums ${cloudTone}`}>
              {formatSidebarBytes(cloudUsage.usedBytes)} /{" "}
              {formatSidebarBytes(cloudUsage.limitBytes)}
            </span>
          </div>
          {cloudUsage.limitBytes > 0 && cloudUsage.usedBytes / cloudUsage.limitBytes > 0.8 && (
            <p className="mt-0.5 flex items-center gap-1 text-[9px] text-amber-300">
              <WarnTriangleIcon />
              残り少なめ
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function formatSidebarBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}

function CreationPanel() {
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const setPrimaryMode = useWorkflow((s) => s.setPrimaryMode);
  const imageMode = useWorkflow((s) => s.imageMode);
  const setImageMode = useWorkflow((s) => s.setImageMode);
  const videoMode = useWorkflow((s) => s.videoMode);
  const setVideoMode = useWorkflow((s) => s.setVideoMode);
  const references = useComposer((s) => s.references);
  const setText = useComposer((s) => s.setText);
  const addReferences = useComposer((s) => s.addReferences);
  const pushToast = useToasts((s) => s.push);
  const selectedPurpose = purposeLabel(primaryMode, imageMode, videoMode);
  const appendReferenceInstruction = (phrase: string) => {
    const current = useComposer.getState().text.trim();
    setText(current ? `${current}\n${phrase}` : phrase);
  };
  const pickReferenceFiles = async (role: ReferenceRole, phrase: string) => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const refs = paths
        .filter((p): p is string => typeof p === "string")
        .map((path) => ({
          path,
          name: basename(path),
          source: "upload" as const,
          role,
        }));
      addReferences(refs);
      if (refs.length > 0) {
        appendReferenceInstruction(phrase);
        pushToast({ kind: "success", text: `${refs.length} 枚を参照に追加しました`, ttlMs: 2400 });
      }
    } catch (err) {
      pushToast({ kind: "error", text: `画像選択に失敗しました。${humanizeError(err)}`, ttlMs: 4000 });
    }
  };

  return (
    <aside className="flex h-full min-h-0 w-[360px] flex-shrink-0 flex-col border-r border-[#242424] bg-[#181818]">
      <div className="border-b border-[#242424] px-4 py-4">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-neutral-500">
          制作モード
        </p>
        <h2 className="mt-2 truncate text-base font-black text-white">{selectedPurpose}</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-4 grid grid-cols-4 gap-1 rounded-xl bg-[#111] p-1">
          {(["image", "video"] as PrimaryMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setPrimaryMode(mode)}
              className={`col-span-2 h-8 rounded-lg text-xs font-black ${
                primaryMode === mode
                  ? "bg-[#2a2a2a] text-white"
                  : "text-neutral-500 hover:text-white"
              }`}
            >
              {mode === "image" ? "画像" : "動画"}
            </button>
          ))}
        </div>

        <DarkSection title="モード別UI">
          {primaryMode === "image" ? (
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-[#111] p-1">
              {(
                [
                  ["generate", "生成"],
                  ["edit", "編集"],
                  ["layers", "レイヤー"],
                ] as Array<[ImageMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setImageMode(mode)}
                  className={`h-8 rounded-lg text-[11px] font-black ${
                    imageMode === mode
                      ? "bg-[#2a2a2a] text-white"
                      : "text-neutral-500 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#111] p-1">
              {(
                [
                  ["story", "ストーリー"],
                  ["multiAngle", "別角度"],
                ] as Array<[VideoMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setVideoMode(mode)}
                  className={`h-8 rounded-lg text-[11px] font-black ${
                    videoMode === mode
                      ? "bg-[#2a2a2a] text-white"
                      : "text-neutral-500 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </DarkSection>

        <DarkSection title="作業ツール">
          <div className="rounded-xl bg-[#222631] p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-black text-white">
                  {primaryMode === "video"
                    ? videoMode === "multiAngle"
                      ? "マルチアングル生成"
                      : "ストーリーカット生成"
                    : imageMode === "edit"
                      ? "画像編集"
                      : imageMode === "layers"
                        ? "レイヤー編集"
                        : "画像生成"}
                </p>
                <p className="mt-1 text-[11px] text-neutral-400">選択して指示を組み立てる</p>
              </div>
              <button
                type="button"
                onClick={() => setText(PURPOSES[0].prompt)}
                className="rounded-lg bg-[#2f3442] px-2 py-2 text-[10px] font-black text-neutral-300 hover:text-white"
              >
                詳細
              </button>
            </div>
          </div>
        </DarkSection>

        <DarkSection title="生成エンジン">
          <select className="h-10 w-full rounded-lg border border-[#303030] bg-[#222] px-3 text-sm font-bold text-neutral-100 outline-none">
            <option>GPT Image 2</option>
            <option disabled>認証済みモデルのみ表示</option>
          </select>
        </DarkSection>

        <DarkSection title={`参照 ${references.length}/8`}>
          <div className="grid grid-cols-3 gap-2">
            {[
              {
                label: "人物・商品",
                role: "subject" as const,
                phrase: "この参照画像の人物・商品を固定してください。",
              },
              {
                label: "画風",
                role: "look" as const,
                phrase: "この参照画像の光、色、質感、画風を引き継いでください。",
              },
              {
                label: "背景",
                role: "background" as const,
                phrase: "この参照画像の背景と空間構造を固定してください。",
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => void pickReferenceFiles(item.role, item.phrase)}
                className="flex h-14 flex-col items-center justify-center rounded-lg border border-dashed border-[#3a3a3a] bg-[#202020] text-[11px] font-bold text-neutral-400 hover:border-pink-400 hover:text-white"
              >
                <span className="text-base">+</span>
                {item.label}
              </button>
            ))}
          </div>
        </DarkSection>

        <DarkSection title="プロンプト">
          <PromptComposer embedded dark />
        </DarkSection>
      </div>
    </aside>
  );
}

function DarkSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <p className="mb-2 text-[11px] font-black text-neutral-500">{title}</p>
      {children}
    </section>
  );
}

function purposeLabel(primaryMode: PrimaryMode, imageMode: ImageMode, videoMode: VideoMode) {
  if (primaryMode === "video")
    return videoMode === "multiAngle" ? "マルチアングル" : "ストーリーカット";
  if (imageMode === "edit") return "画像編集";
  if (imageMode === "layers") return "レイヤー編集";
  return "画像生成";
}

function Rail({
  drawer,
  setDrawer,
  onHome,
}: {
  drawer: DrawerKind;
  setDrawer: (drawer: DrawerKind) => void;
  onHome: () => void;
}) {
  const button = (kind: DrawerKind, label: string, short: string) => (
    <button
      type="button"
      onClick={() => setDrawer(drawer === kind ? null : kind)}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-xl border text-[11px] font-black transition ${
        drawer === kind
          ? "border-neutral-950 bg-neutral-950 text-white"
          : "border-transparent text-neutral-500 hover:border-neutral-200 hover:bg-white hover:text-neutral-950"
      }`}
    >
      {short}
    </button>
  );
  return (
    <nav className="flex w-[52px] flex-col items-center gap-1.5 border-r border-neutral-200 bg-[#fbfbfc] px-2 py-3">
      <button
        type="button"
        onClick={onHome}
        title="ホーム"
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#111827,#2563eb)] text-[11px] font-black text-white shadow-sm"
      >
        ホ
      </button>
      {button(null, "制作ボード", "盤")}
      <div className="my-2 h-px w-7 bg-neutral-200" />
      {button("assets", "素材", "素")}
      {button("references", "参照", "参")}
      {button("history", "履歴", "履")}
      <div className="mt-auto">{button("export", "書き出し", "出")}</div>
    </nav>
  );
}

function BoardHeader({ title, activePage }: { title: string; activePage: DrawerKind }) {
  const batches = useBatches((s) => s.batches);
  // 制作タブ (バッチ生成) だけでなく、スキルモード (絵コンテ / マルチアングルの
  // カット並列生成) の生成中も右上バッジに反映する。いずれかが running なら「生成中」。
  const storyboardRunning = useStoryboardRun((s) => s.status === "running");
  const multiAngleRunning = useMultiAngleRun((s) => s.status === "running");
  const running =
    batches.some((b) => b.status === "running") || storyboardRunning || multiAngleRunning;
  // 制作タブ (activePage === null) のときは、内部の WorkspaceTabs で
  // 「企画 / 生成 / 編集」のいずれかが選ばれている。タイトルもそれに追従する。
  const activeTab = useWorkspace((s) => s.activeTab);
  const liveTabLabel = activeTab === "plan" ? "企画" : activeTab === "edit" ? "編集" : title;
  const pageTitle =
    activePage === "assets"
      ? "ライブラリ"
      : activePage === "references"
        ? "固定する要素"
        : activePage === "history"
          ? "プロジェクト"
          : activePage === "presets"
            ? "プリセット"
            : activePage === "skills"
              ? "スキル"
              : activePage === "export"
                ? "チャット履歴"
                : activePage === "settings"
                  ? "設定"
                  : liveTabLabel;
  // サブタイトルは UI スマート化のため廃止 (2026-05-14 STΛCK 指示)
  return (
    <div className="border-b border-[#242424] bg-[#121212] px-5 py-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-black tracking-normal text-white">{pageTitle}</h2>
        <div className="flex items-center gap-3">
          <UsageGauges />
          <Badge tone={running ? "blue" : "neutral"}>{running ? "生成中" : "生成準備OK"}</Badge>
        </div>
      </div>
    </div>
  );
}

/**
 * 使用量ゲージ (右上ヘッダー)
 *
 * 基本方針:
 * - Codex (ChatGPT) は公式に残量 API がない → 「直近 N 時間の生成回数」を
 *   ローカルで集計して目安として出す。Codex の rate limit は時間窓制なので、
 *   これが**実態に最も近い**目安になる。
 *   バッジクリックで ChatGPT アカウントページ (chatgpt.com) を開けるようにする
 *   (正確な残量はそちらで確認)。
 *
 * - Higgsfield は credits が正確に取れる (ブースト用)。認証済みのときだけ
 *   バー + 残数を表示する。未認証なら何も出さない。
 */
function UsageGauges() {
  // 2026-05-14: STΛCK 指示で Codex 残ゲージは表示廃止。
  // OpenAI 公式に正確な上限値が無いため「目安バー」がユーザー混乱を招いていた。
  // 代わりに、連携済みの外部サービスのクレジット数だけをリアルタイムで表示する。
  const hfCredits = useAccounts((s) => s.higgsfield.credits);
  const hfAuthed = useAccounts((s) => s.higgsfield.authenticated);
  // Magnific オプショナル拡張 (2026-06-08)。接続済みならバッジを出す(degrade)。
  const magnificAuthed = useAccounts((s) => s.magnific.authenticated);

  // Higgsfield credits を取得 (認証済みのときだけ)。起動時 + 5 分ごとに refresh。
  // Magnific の接続状態も同タイミングで refresh する。
  useEffect(() => {
    let cancelled = false;
    const fetchCredits = async () => {
      if (cancelled) return;
      await useAccounts
        .getState()
        .refreshHiggsfield()
        .catch(() => undefined);
      await useAccounts
        .getState()
        .refreshMagnific()
        .catch(() => undefined);
    };
    void fetchCredits();
    const id = setInterval(fetchCredits, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const showHf = hfAuthed && hfCredits !== undefined;
  // どちらの拡張も未接続なら何も表示しない (コアだけの素の状態)。
  if (!showHf && !magnificAuthed) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      {showHf && (
        <div
          className="flex items-center gap-1.5 rounded-md border border-pink-400/40 bg-pink-500/10 px-2.5 py-1 text-[11px] font-bold text-pink-100"
          title={`HiggsField credits: ${Math.round(hfCredits)}`}
        >
          <span className="flex items-center gap-1 text-pink-300">
            <BoltIcon />
            HiggsField
          </span>
          <span className="tabular-nums text-white">{Math.round(hfCredits)}</span>
        </div>
      )}
      {magnificAuthed && (
        <div
          className="flex items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/10 px-2.5 py-1 text-[11px] font-bold text-violet-100"
          title="Magnific 接続済み"
        >
          <span className="flex items-center gap-1 text-violet-300">
            <BoltIcon />
            Magnific
          </span>
        </div>
      )}
    </div>
  );
}

function CreativeBoard() {
  const items = useImages((s) => s.items);
  const batches = useBatches((s) => s.batches);
  const selectedPath = useImages((s) => s.selectedPath);
  const setSelected = useImages((s) => s.setSelected);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [tileSize, setTileSize] = useState(180);
  const recent = useMemo(() => items.slice(0, 24), [items]);
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#121212] px-4 py-4">
      {batches.length === 0 && recent.length === 0 ? (
        <BoardEmptyState />
      ) : (
        <div className="space-y-5">
          <BoardWorkBar
            total={recent.length}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            tileSize={tileSize}
            onTileSizeChange={setTileSize}
          />
          {batches.map((batch) => (
            <BatchBoardRow key={batch.batchId} batchId={batch.batchId} />
          ))}
          {viewMode === "grid" ? (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}
            >
              {recent.map((item) => (
                <BoardImageCard
                  key={item.path}
                  item={item}
                  active={selectedPath === item.path}
                  onSelect={() => setSelected(item.path)}
                  tileSize={tileSize}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {recent.map((item) => (
                <BoardListItem
                  key={item.path}
                  item={item}
                  active={selectedPath === item.path}
                  onSelect={() => setSelected(item.path)}
                  thumbnailSize={Math.max(76, Math.round(tileSize * 0.48))}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AssetsWorkspace() {
  const items = useImages((s) => s.items);
  const addReference = useComposer((s) => s.addReference);
  const selectionMode = useLibrarySelection((s) => s.selectionMode);
  const selected = useLibrarySelection((s) => s.selected);
  // ライブラリ表示モード + タイルサイズ (localStorage 永続化)
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    try {
      const v = localStorage.getItem("library.viewMode");
      return v === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [tileSize, setTileSize] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("library.tileSize"));
      return Number.isFinite(v) && v >= 80 && v <= 320 ? v : 160;
    } catch {
      return 160;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("library.viewMode", viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);
  useEffect(() => {
    try {
      localStorage.setItem("library.tileSize", String(tileSize));
    } catch {
      /* ignore */
    }
  }, [tileSize]);
  const enterMode = useLibrarySelection((s) => s.enterMode);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const toggle = useLibrarySelection((s) => s.toggle);
  const selectAll = useLibrarySelection((s) => s.selectAll);
  const clear = useLibrarySelection((s) => s.clear);

  // 右クリックメニュー (FB#1: f_matsu106 さん。ライブラリで画像を右クリックしても
  // プリセット登録等が出ず WebView 標準メニューが出ていた。実ライブラリ=この
  // AssetsWorkspace のタイルに onContextMenu が無かったのが原因。プレビューモーダルと
  // 同じ buildGalleryItemMenu + ContextMenu をここにも配線する 2026-06-07)。
  const favorites = useImages((s) => s.favorites);
  const toggleFavorite = useImages((s) => s.toggleFavorite);
  const judgements = useImages((s) => s.judgements);
  const setJudgement = useImages((s) => s.setJudgement);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: GalleryItem;
  } | null>(null);
  const [presetTarget, setPresetTarget] = useState<GalleryItem | null>(null);

  const allSelected = items.length > 0 && selected.size === items.length;
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#121212] px-4 py-4">
      {/* ヘッダーの「ライブラリ」見出しと重複していたので PageIntro を撤去。
          description はヘッダー側で持つ。 */}

      {/* ツールバー: 選択モード切替 + ビュー切替 + サイズ調整 + 一括操作 */}
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 py-2">
        <div className="flex items-center gap-3 text-[11px] text-neutral-400">
          <span>{items.length} 件</span>
          {selectionMode && (
            <>
              <span className="text-neutral-600">/</span>
              <span className="font-bold text-pink-300">{selected.size} 選択中</span>
            </>
          )}
          {/* ビュー切替 (grid / list) */}
          <div className="ml-2 flex items-center gap-0.5 rounded-md border border-[#343434] bg-[#0b0b0b] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              title="グリッド表示"
              className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition ${
                viewMode === "grid" ? "bg-pink-500 text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              <GridViewIcon />
              グリッド
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              title="リスト表示"
              className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition ${
                viewMode === "list" ? "bg-pink-500 text-white" : "text-neutral-400 hover:text-white"
              }`}
            >
              <ListViewIcon />
              リスト
            </button>
          </div>
          {/* グリッド時のみタイルサイズスライダー */}
          {viewMode === "grid" && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-500">サイズ</span>
              <input
                type="range"
                min={100}
                max={320}
                step={20}
                value={tileSize}
                onChange={(e) => setTileSize(Number(e.target.value))}
                className="h-1 w-24 cursor-pointer accent-pink-500"
              />
              <span className="w-8 text-[10px] tabular-nums text-neutral-500">{tileSize}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {selectionMode ? (
            <>
              <button
                type="button"
                onClick={() => (allSelected ? clear() : selectAll(items.map((it) => it.path)))}
                className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                {allSelected ? "全解除" : "全選択"}
              </button>
              <LibraryAutoRenameButton />
              <LibraryAddToProjectButton />
              <LibraryBatchSaveButton />
              <LibraryDeleteButton />
              <button
                type="button"
                onClick={exitMode}
                className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                選択解除
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={enterMode}
              className="flex h-7 items-center gap-1.5 rounded-md bg-pink-500 px-3 text-[11px] font-bold text-white hover:bg-pink-400"
              disabled={items.length === 0}
            >
              <CheckSquareIcon />
              選択モード
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <DarkEmpty
          title="素材がありません"
          description="画像を生成またはアップロードするとここに並びます。"
        />
      ) : viewMode === "grid" ? (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))`,
          }}
        >
          {items.map((item) => {
            const isSelected = selected.has(item.path);
            const judgement = judgements.get(item.path);
            return (
              <div
                key={item.path}
                className={[
                  "group relative overflow-hidden rounded-xl border bg-[#1a1a1a] text-left transition",
                  isSelected
                    ? "border-pink-400 ring-2 ring-pink-500/40"
                    : "border-[#2a2a2a] hover:border-pink-400",
                ].join(" ")}
              >
                <button
                  type="button"
                  onDoubleClick={() => useImagePreview.getState().open(item.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, item });
                  }}
                  onClick={() => {
                    if (selectionMode) {
                      toggle(item.path);
                    } else {
                      addReference({
                        path: item.path,
                        name: item.name,
                        source: "gallery",
                        role: "subject",
                      });
                    }
                  }}
                  className="block w-full text-left"
                >
                  <SafeImage
                    path={item.path}
                    alt=""
                    className="aspect-[16/9] w-full object-cover"
                  />
                  <div className="p-2">
                    <p className="truncate text-[11px] font-bold text-neutral-200">{item.name}</p>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      {selectionMode
                        ? isSelected
                          ? "選択中（クリックで外す）"
                          : "クリックで選択"
                        : "クリックで参照 / ダブルクリックで拡大"}
                    </p>
                  </div>
                </button>
                {selectionMode && (
                  <div
                    className={[
                      "pointer-events-none absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border-2",
                      isSelected
                        ? "border-pink-400 bg-pink-500 text-white"
                        : "border-white/70 bg-black/60 text-transparent",
                    ].join(" ")}
                  >
                    <CheckIcon />
                  </div>
                )}
                {judgement && (
                  <span
                    className={[
                      "pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold text-white shadow",
                      judgement === "adopted"
                        ? "bg-pink-500/90"
                        : "bg-neutral-600/90",
                    ].join(" ")}
                  >
                    {judgement === "adopted" ? "採用" : "ボツ"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* リスト表示: 横長 1 列、サムネイル小 + ファイル名/操作 */
        <div className="flex flex-col gap-1">
          {items.map((item) => {
            const isSelected = selected.has(item.path);
            const judgement = judgements.get(item.path);
            return (
              <button
                key={item.path}
                type="button"
                onDoubleClick={() => useImagePreview.getState().open(item.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                onClick={() => {
                  if (selectionMode) {
                    toggle(item.path);
                  } else {
                    addReference({
                      path: item.path,
                      name: item.name,
                      source: "gallery",
                      role: "subject",
                    });
                  }
                }}
                className={[
                  "flex items-center gap-3 rounded-md border bg-[#1a1a1a] px-2 py-1.5 text-left transition",
                  isSelected
                    ? "border-pink-400 ring-1 ring-pink-500/40"
                    : "border-[#2a2a2a] hover:border-pink-400",
                ].join(" ")}
              >
                <SafeImage
                  path={item.path}
                  alt=""
                  className="h-10 w-16 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-neutral-200">{item.name}</p>
                  <p className="truncate text-[10px] text-neutral-500">
                    {selectionMode
                      ? isSelected
                        ? "選択中（クリックで外す）"
                        : "クリックで選択"
                      : "クリックで参照 / ダブルクリックで拡大"}
                  </p>
                </div>
                {judgement && (
                  <span
                    className={[
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white",
                      judgement === "adopted"
                        ? "bg-pink-500/90"
                        : "bg-neutral-600/90",
                    ].join(" ")}
                  >
                    {judgement === "adopted" ? "採用" : "ボツ"}
                  </span>
                )}
                {selectionMode && isSelected && (
                  <span className="shrink-0 text-pink-400" aria-hidden>
                    <CheckIcon />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={
            buildGalleryItemMenu(contextMenu.item, {
              favorites,
              onToggleFavorite: (path) => void toggleFavorite(path),
              onRegisterPreset: () => setPresetTarget(contextMenu.item),
              judgement: judgements.get(contextMenu.item.path),
              onSetJudgement: (path, value) => void setJudgement(path, value),
            }) satisfies ContextMenuItem[]
          }
          onClose={() => setContextMenu(null)}
        />
      )}
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget.path}
          defaultName={presetTarget.name}
          onClose={() => setPresetTarget(null)}
        />
      )}
    </section>
  );
}

/**
 * ライブラリで選択中の没作品を一括削除するボタン。
 * 押すと件数を明示した確認ダイアログ → ファイル実体 + history.db 行を削除。
 * 破壊的操作なので danger スタイル。削除後は選択モードを抜ける。
 */
function LibraryDeleteButton() {
  const selected = useLibrarySelection((s) => s.selected);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const [running, setRunning] = useState(false);

  const disabled = selected.size === 0 || running;

  const handleClick = async () => {
    if (disabled) return;
    setRunning(true);
    try {
      const deleted = await deleteGalleryImages(Array.from(selected));
      // 1 枚でも消えたら選択モードを抜ける (残った失敗分を再選択させない)。
      if (deleted > 0) exitMode();
    } finally {
      setRunning(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={[
        "flex h-7 items-center gap-1.5 rounded-md px-3 text-[11px] font-bold transition",
        disabled
          ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
          : "bg-rose-600 text-white hover:bg-rose-500",
      ].join(" ")}
    >
      {running ? (
        "削除中…"
      ) : (
        <>
          <TrashIcon />
          <span>削除{selected.size > 0 ? ` (${selected.size})` : ""}</span>
        </>
      )}
    </button>
  );
}

/**
 * ライブラリの選択画像をプロジェクトに一括追加するボタン。
 * 押すとポップオーバーで「既存プロジェクト一覧 / 新規プロジェクト作成」が出る。
 */
function LibraryAddToProjectButton() {
  const selected = useLibrarySelection((s) => s.selected);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const addItem = useProjects((s) => s.addItem);
  const pushToast = useToasts((s) => s.push);
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const handleAdd = (projectId: string, projectName: string) => {
    let added = 0;
    selected.forEach((path) => {
      const r = addItem(projectId, { imagePath: path });
      if (r) added += 1;
    });
    pushToast({
      kind: "success",
      text: `${projectName} に ${added} 件追加しました`,
      ttlMs: 2400,
    });
    exitMode();
    setOpen(false);
  };

  const handleCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    handleAdd(created.id, created.name);
    setDraftName("");
  };

  const disabled = selected.size === 0;
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        className={[
          "flex h-7 items-center gap-1.5 rounded-md px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
            : open
              ? "bg-pink-400 text-white"
              : "bg-pink-500 text-white hover:bg-pink-400",
        ].join(" ")}
        title="選択中の画像をプロジェクトに追加"
      >
        <FolderAddIcon />
        <span className="tabular-nums">{selected.size} 件をプロジェクトへ</span>
        <CaretDownIcon />
      </button>
      {open && !disabled && (
        <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-[#2a2a2a] bg-[#161616] shadow-2xl">
          <div className="border-b border-[#242424] px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            既存プロジェクトに追加
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {projects.length === 0 ? (
              <p className="px-3 py-3 text-center text-[11px] text-neutral-500">
                まだプロジェクトがありません
              </p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleAdd(project.id, project.name)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[#1f1f1f]"
                >
                  <span className="truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {project.items.length} 件
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[#242424] p-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              新規プロジェクトに追加
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  const isComposing =
                    (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
                  if (event.key === "Enter" && !isComposing) {
                    event.preventDefault();
                    handleCreate();
                  } else if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="プロジェクト名"
                className="h-7 flex-1 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                作成して追加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReferencesWorkspace() {
  const refs = useComposer((s) => s.references);
  const remove = useComposer((s) => s.removeReference);
  const setReferenceRole = useComposer((s) => s.setReferenceRole);
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#121212] px-4 py-4">
      <PageIntro
        title="固定する要素"
        description="人物・商品・画風・背景など、次の生成で絶対に引き継ぐ要素を管理します。"
      />
      {refs.length === 0 ? (
        <DarkEmpty
          title="参照がありません"
          description="素材庫または作品カードから参照に追加してください。"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {refs.map((ref) => (
            <div key={ref.path} className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3">
              <div className="flex gap-3">
                <SafeImage
                  path={ref.path}
                  alt=""
                  className="h-20 w-20 rounded-lg object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-white">{ref.name}</p>
                  <p className="mt-1 text-[11px] text-neutral-500">
                    現在: {referenceRoleLabel(ref.role)}
                  </p>
                  <button
                    type="button"
                    onClick={() => remove(ref.path)}
                    className="mt-2 text-[11px] font-bold text-rose-300 hover:text-rose-200"
                  >
                    外す
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {KEEP_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setReferenceRole(ref.path, option.role)}
                    className={`h-8 rounded-lg text-[11px] font-black ${
                      ref.role === option.role
                        ? "bg-pink-500 text-white"
                        : "bg-[#242424] text-neutral-300 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * プロジェクト管理ワークスペース。
 *
 * 制作画面で作った画像を「プロジェクト」というアーカイブ箱にまとめて保管する。
 * セッション (チャット履歴) とは別軸で、用途別 / 案件別 / テーマ別の整理に使う。
 *
 * - 上部: 「+ 新規プロジェクト」ボタン + 説明
 * - 一覧: プロジェクトカード (名前 / 件数 / プレビュー画像 4 枚 / 開く)
 * - カードクリックで詳細パネル展開: 中身の画像グリッド + 個別削除
 */
function ProjectsWorkspace() {
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const renameProject = useProjects((s) => s.renameProject);
  const removeProject = useProjects((s) => s.removeProject);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const opened = openId ? (projects.find((p) => p.id === openId) ?? null) : null;

  const handleCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    setOpenId(created.id);
    setDraftName("");
  };

  // プロジェクトを開いている間はカード一覧を隠して詳細を全面表示する。
  // 仮想グリッドに確定高さを与えるため (ページスクロールとの二重スクロール回避)。
  if (opened) {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212] px-4 py-4">
        <ProjectDetailPanel project={opened} onClose={() => setOpenId(null)} />
      </section>
    );
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#121212] px-4 py-4">
      {/* ヘッダーの「プロジェクト」見出しと重複していたので PageIntro を撤去。 */}

      {/* 新規プロジェクト作成フォーム */}
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#181818] p-3">
        <input
          type="text"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            // IME 確定の Enter で勝手に作成されないように isComposing チェック
            const isComposing =
              (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
            if (event.key === "Enter" && !isComposing) {
              event.preventDefault();
              handleCreate();
            }
          }}
          placeholder="新しいプロジェクト名（例: 〇〇商品 LP 用素材）"
          className="h-9 flex-1 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={!draftName.trim()}
          className="flex h-9 items-center gap-1.5 rounded-md bg-pink-500 px-4 text-xs font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          <PlusIcon size={12} />
          作成
        </button>
      </div>

      {projects.length === 0 ? (
        <DarkEmpty
          title="まだプロジェクトがありません"
          description="新規プロジェクトを作って、制作画面の画像を「プロジェクトに保存」で箱に入れていけます。"
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={() => setOpenId(project.id)}
              onRename={(name) => renameProject(project.id, name)}
              onRemove={() => {
                void (async () => {
                  const message = `プロジェクト「${project.name}」を削除しますか? 中身の画像はライブラリには残ります。`;
                  let ok = false;
                  try {
                    const { ask } = await import("@tauri-apps/plugin-dialog");
                    ok = await ask(message, { title: "プロジェクトの削除", kind: "warning" });
                  } catch {
                    ok = window.confirm(message);
                  }
                  if (!ok) return;
                  if (openId === project.id) setOpenId(null);
                  removeProject(project.id);
                })();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * プロジェクト詳細。Notion 風に
 *  - 上: 企画チャットのログ（user / assistant のバブル）
 *  - 下: 採用→生成された画像のグリッド
 * の 2 段構成で、1 案件のドキュメントとして見られるようにする。
 *
 * チャットログが空ならその枠は出さず、画像だけ並べる。
 */
function ProjectDetailPanel({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const chat = project.planChat ?? [];
  const stockCreditCount = project.stockCredits?.length ?? 0;
  const pushToast = useToasts((s) => s.push);
  // 全面ビューでは画像グリッドに高さを譲るため、企画チャットは初期閉じ。
  const [chatOpen, setChatOpen] = useState(false);
  const [exportingLog, setExportingLog] = useState(false);

  /**
   * プロジェクト記録 CSV の書き出し。「どの画像をどのプロンプトで生成したか」の
   * ログを、企画チャットも含めて 1 枚のシートに束ねる。
   * 保存ダイアログのキャンセル (戻り値 false) ではトーストを出さない。
   */
  const exportLogCsv = async () => {
    setExportingLog(true);
    try {
      const saved = await exportProjectCsv(project.id);
      if (saved) {
        pushToast({
          kind: "success",
          text: `プロジェクト記録 CSV を保存しました (画像 ${project.items.length} 件・チャット ${(project.planChat ?? []).length} 通)`,
          ttlMs: 4000,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `プロジェクト記録 CSV の保存に失敗しました。${humanizeError(err)}`,
      });
    } finally {
      setExportingLog(false);
    }
  };

  /**
   * 法務対応 (2026-05-21): プロジェクトで使った Pexels 素材のクレジットを
   * CSV ファイルとして書き出す。商用案件で出典トレースを求められた時の
   * 証跡として使う。
   *
   * 動作:
   *   1. プロジェクトの stockCredits を CSV 文字列に組み立てる
   *   2. plugin-dialog.save で保存先をユーザーに選んでもらう
   *   3. plugin-fs.writeTextFile で書き込む
   *
   * 失敗時はトーストで通知する。クレジットゼロでもヘッダ行は出すので、
   * 空 CSV にはならない (常にエクスポート可能)。
   */
  const exportCreditsCsv = async () => {
    try {
      const csv = useProjects.getState().buildCreditsCsv(project.id);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_") || "project";
      // 保存先のデフォルトを「書類」フォルダにする。fs:scope で許可済みの場所
      // (書類 / デスクトップ / ダウンロード) に着地させることで、保存ダイアログ
      // 直後の writeTextFile が権限エラーで失敗しないようにする。
      let defaultPath = `${safeName}-credits.csv`;
      try {
        const { documentDir, join } = await import("@tauri-apps/api/path");
        defaultPath = await join(await documentDir(), `${safeName}-credits.csv`);
      } catch {
        // 書類フォルダの解決に失敗してもファイル名だけで続行する。
      }
      const dest = await save({
        defaultPath,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!dest) {
        // ユーザーがキャンセル
        return;
      }
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      // Excel 日本語環境の文字化け対策で UTF-8 BOM を先頭に付ける。
      // BOM 付きでも Numbers / Sheets / Notepad は問題なく読める。
      await writeTextFile(dest, `﻿${csv}`);
      pushToast({
        kind: "success",
        text: `クレジット CSV を保存しました (${stockCreditCount} 件)`,
        ttlMs: 4000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `クレジット CSV の保存に失敗しました。${humanizeError(err)}`,
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between rounded-xl border border-[#2a2a2a] bg-[#181818] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-xs text-neutral-400 hover:text-white"
          >
            ← プロジェクト一覧へ
          </button>
          <div className="min-w-0">
            <h4 className="truncate text-sm font-black text-white">{project.name}</h4>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              企画ログ {chat.length} 通 ・ 画像 {project.items.length} 件
              {stockCreditCount > 0 && ` ・ 素材 ${stockCreditCount} 件`}・ 更新{" "}
              {relativeTimeJa(project.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exportingLog}
            onClick={() => void exportLogCsv()}
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            title="画像・プロンプト・企画チャットの記録を CSV で書き出す（どの画像をどのプロンプトで生成したかのログ）"
          >
            {exportingLog ? "書き出し中..." : "記録 CSV"}
          </button>
          <button
            type="button"
            onClick={() => void exportCreditsCsv()}
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            title="使った Pexels 素材の一覧を CSV で書き出す (商用案件の出典トレース用)"
          >
            クレジット CSV
          </button>
        </div>
      </div>

      {chat.length > 0 && (
        <div className="shrink-0 rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <span className="text-[10px] text-neutral-500">
              {chatOpen ? "▾" : "▸"}
            </span>
            <span className="text-[10px] font-black uppercase tracking-wide text-pink-300">
              企画チャット ({chat.length} 通)
            </span>
            <span className="text-[10px] text-neutral-500">
              （企画タブで対話したログのスナップショット）
            </span>
          </button>
          {chatOpen && (
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
              {chat.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={[
                      "max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed",
                      msg.role === "user"
                        ? "bg-pink-500/10 text-pink-50 ring-1 ring-pink-500/30"
                        : "bg-[#1f1f1f] text-neutral-200 ring-1 ring-[#2a2a2a]",
                    ].join(" ")}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {project.items.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <div className="mb-3 flex shrink-0 items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wide text-pink-300">
              生成画像
            </span>
            <span className="text-[10px] text-neutral-500">
              （採用→生成で自動的にここに入ります）
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ProjectGallery project={project} />
          </div>
        </div>
      ) : (
        <DarkEmpty
          title={chat.length > 0 ? "まだ画像がありません" : `${project.name} はまだ空です`}
          description={
            chat.length > 0
              ? "企画タブの「採用」ボタンでプロンプトを生成タブに渡して画像を作ると、自動でここに並びます。"
              : "上部の「作業中プロジェクト」でこのプロジェクトを選び、企画タブで会話 → 採用すると、ログと画像がここに集まります。"
          }
        />
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onRename,
  onRemove,
}: {
  project: Project;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const previewItems = project.items.slice(0, 4);
  return (
    <div className="group rounded-xl border border-[#2a2a2a] bg-[#181818] p-3 transition hover:border-pink-400/60">
      <div className="grid grid-cols-2 gap-1">
        {previewItems.length === 0 ? (
          <div className="col-span-2 flex aspect-[16/9] items-center justify-center rounded-md bg-[linear-gradient(135deg,#242424_0%,#171717_100%)] text-[10px] font-bold uppercase tracking-wide text-neutral-600">
            Empty
          </div>
        ) : (
          previewItems.map((item, index) => (
            <SafeImage
              key={item.id}
              path={item.imagePath}
              alt=""
              className={`aspect-square w-full rounded-md object-cover ${
                previewItems.length === 1 ? "col-span-2 aspect-[16/9]" : ""
              }`}
              loading={index < 2 ? "eager" : "lazy"}
            />
          ))
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              const isComposing =
                (event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229;
              if (event.key === "Enter" && !isComposing) {
                event.preventDefault();
                onRename(draft);
                setEditing(false);
              } else if (event.key === "Escape") {
                setDraft(project.name);
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (draft.trim() && draft.trim() !== project.name) onRename(draft);
              setEditing(false);
            }}
            className="h-7 flex-1 rounded border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-sm font-bold text-neutral-100 hover:text-pink-300"
          >
            {project.name}
          </button>
        )}
        <span className="shrink-0 text-[10px] font-bold text-neutral-500">
          {project.items.length} 件
        </span>
      </div>
      <p className="mt-1 text-[10px] text-neutral-500">{relativeTimeJa(project.updatedAt)}</p>
      <div className="mt-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={onOpen}
          className="h-7 flex-1 rounded-md border border-[#343434] bg-[#0b0b0b] text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          開く
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(project.name);
            setEditing(true);
          }}
          className="flex h-7 items-center justify-center rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-neutral-400 hover:text-white"
          title="名前を編集"
          aria-label="名前を編集"
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="flex h-7 items-center justify-center rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-neutral-400 hover:text-red-400"
          title="削除"
          aria-label="削除"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * サイドドロワー版プロジェクト一覧。簡易表示。
 */
function ProjectsDrawer() {
  const projects = useProjects((s) => s.projects);
  if (projects.length === 0) {
    return (
      <EmptyState
        title="プロジェクトがありません"
        description="左ナビ「プロジェクト」を開いて新規作成してください。"
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {projects.map((project) => (
        <div key={project.id} className="rounded-xl border border-neutral-200 bg-white p-2">
          <p className="truncate text-xs font-bold text-neutral-950">{project.name}</p>
          <p className="mt-0.5 text-[10px] text-neutral-500">
            {project.items.length} 件 · {relativeTimeJa(project.updatedAt)}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * 旧 ExportWorkspace を撤去し、最近のクリエイティブのやり取り（既存 sessions）を
 * ChatGPT のチャット履歴のように縦リストで一覧する画面に置き換えた。
 *
 * - 各セッションをクリックで開く（switchTo 経由、左ナビの onOpen と同じ）
 * - サムネ + タイトル + 経過時間
 * - アクティブ / 表示中のバッジを表示
 *
 * 書き出しワークフローは制作画面側で完結する方針のため、納品書き出し UI は撤去。
 */
/**
 * 未保存の企画チャット (29z 2026-08-03)。プロジェクト未選択のまま進めた企画
 * チャットを最新5件・7日だけ退避してあるので、ここから開き直せるようにする。
 * 0 件なら何も描画しない。
 */
/**
 * xwl: 履歴検索のフィルタ規則（3セクション共通の正本）。
 * 親（ChatHistoryWorkspace）は空表示の判定にこれらの件数を集計するので、
 * セクション側と親で条件が食い違わないよう module 直下に切り出してある。
 */
function filterUnsavedPlanChats<T extends { title: string; messages: { text: string }[] }>(
  items: T[],
  query: string,
): T[] {
  if (!query) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(query) ||
      it.messages.some((m) => m.text.toLowerCase().includes(query)),
  );
}

/** xwl: planChat を持つプロジェクトだけを検索クエリで絞り、更新の新しい順に並べる。 */
function filterProjectPlanChats(projects: Project[], query: string): Project[] {
  const withChat = projects.filter((p) => (p.planChat?.length ?? 0) > 0);
  const matched = query
    ? withChat.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          (p.planChat ?? []).some((m) => m.text.toLowerCase().includes(query)),
      )
    : withChat;
  return [...matched].sort((a, b) => b.updatedAt - a.updatedAt);
}

function UnsavedPlanChatSection({
  onOpenUnsaved,
  query,
}: {
  onOpenUnsaved: (id: string) => Promise<void>;
  /** xwl: 履歴検索の正規化済みクエリ (trim + toLowerCase)。空文字なら絞り込みなし。 */
  query: string;
}) {
  const items = useUnsavedPlanChats((s) => s.items);
  const removeUnsaved = useUnsavedPlanChats((s) => s.remove);
  const filtered = filterUnsavedPlanChats(items, query);
  if (filtered.length === 0) return null;

  const handleDelete = async (id: string) => {
    const message = "この未保存の企画チャットを削除しますか？元に戻せません。";
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "未保存チャットの削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    await removeUnsaved(id);
  };

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-black text-neutral-200">未保存の企画チャット</h3>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          プロジェクトに保存していない企画の会話です。最新5件を7日間残します。
        </p>
      </div>
      <ul className="space-y-1.5">
        {filtered.map((entry) => (
          <li key={entry.id}>
            <div className="group flex w-full items-center gap-3 rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 py-2.5 text-left transition hover:border-pink-400/60 hover:bg-[#1f1f1f]">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => void onOpenUnsaved(entry.id)}
                  className="block w-full truncate text-left text-sm font-medium text-neutral-100 hover:text-white"
                >
                  {entry.title}
                </button>
                <p className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                  <span>{relativeTimeJa(entry.updatedAt)}</span>
                  <span>{entry.messages.length}通</span>
                  <span className="rounded bg-yellow-500/15 px-1.5 py-px text-[10px] font-medium text-yellow-200">
                    未保存
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(entry.id)}
                className="shrink-0 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-medium text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                削除
              </button>
              <button
                type="button"
                onClick={() => void onOpenUnsaved(entry.id)}
                className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-white"
              >
                開く
                <ArrowRightIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 案件（プロジェクト）に保存済みの企画チャット一覧 (xwl 2026-08-03)。
 * planChat を持つプロジェクトだけを更新の新しい順に並べる。0 件なら描画しない。
 * 削除は付けない（プロジェクト正本への破壊操作はプロジェクト画面の責務）。
 */
function ProjectPlanChatSection({
  onOpenProjectChat,
  query,
}: {
  onOpenProjectChat: (projectId: string) => Promise<void>;
  /** xwl: 履歴検索の正規化済みクエリ (trim + toLowerCase)。空文字なら絞り込みなし。 */
  query: string;
}) {
  const projects = useProjects((s) => s.projects);
  const filtered = useMemo(() => filterProjectPlanChats(projects, query), [projects, query]);
  if (filtered.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="mb-2">
        <h3 className="text-xs font-black text-neutral-200">案件の企画チャット</h3>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          プロジェクトに保存した企画の会話です。開くと企画タブでそのプロジェクトに切り替わります。
        </p>
      </div>
      <ul className="space-y-1.5">
        {filtered.map((project) => (
          <li key={project.id}>
            <div className="group flex w-full items-center gap-3 rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 py-2.5 text-left transition hover:border-pink-400/60 hover:bg-[#1f1f1f]">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => void onOpenProjectChat(project.id)}
                  className="block w-full truncate text-left text-sm font-medium text-neutral-100 hover:text-white"
                >
                  {project.name}
                </button>
                <p className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                  <span>{relativeTimeJa(project.updatedAt)}</span>
                  <span>{project.planChat?.length ?? 0}通</span>
                  <span className="rounded bg-sky-500/15 px-1.5 py-px text-[10px] font-medium text-sky-200">
                    案件
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onOpenProjectChat(project.id)}
                className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-white"
              >
                開く
                <ArrowRightIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatHistoryWorkspace({
  onOpen,
  onOpenUnsaved,
  onOpenProjectChat,
}: {
  onOpen: (id: string) => Promise<void>;
  onOpenUnsaved: (id: string) => Promise<void>;
  onOpenProjectChat: (projectId: string) => Promise<void>;
}) {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const displayedSession = useSessions((s) => s.displayedSession);
  const isFrozen = useSessions((s) => s.isFrozen);
  const renameSession = useSessions((s) => s.rename);
  // 編集中のセッション id + ドラフトタイトル
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // xwl: 履歴検索（client-side の決定論フィルタ。セッションはタイトルのみ対象）
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  // xwl / C-1: 空表示は 3 セクション（未保存・案件・制作）の一致状態で判定する。
  // 制作チャットだけを見ると、案件チャットが一致していても「一致なし」が併記される。
  const unsavedItems = useUnsavedPlanChats((s) => s.items);
  const projectsForCount = useProjects((s) => s.projects);
  const unsavedMatchCount = useMemo(
    () => filterUnsavedPlanChats(unsavedItems, q).length,
    [unsavedItems, q],
  );
  const projectMatchCount = useMemo(
    () => filterProjectPlanChats(projectsForCount, q).length,
    [projectsForCount, q],
  );
  const totalMatchCount = filtered.length + unsavedMatchCount + projectMatchCount;
  /**
   * 全セクションが素で 0 件（＝そもそも履歴が無い）。
   *
   * この案内を出すのは **検索していないとき（q 空）だけ**。全履歴 0 件の状態で
   * 検索窓に何か打った場合、ユーザーが知りたいのは「その語に一致するものが無い」で
   * あって初回案内ではない（Sol 指摘 C-1）。したがって描画側は
   * 「検索中の 0 件」→「素の 0 件」の順で分岐する。
   */
  const hasNoHistoryAtAll =
    sessions.length === 0 &&
    unsavedItems.length === 0 &&
    projectsForCount.every((p) => (p.planChat?.length ?? 0) === 0);

  /**
   * チャット履歴（制作チャット）を削除する (xwl)。DB 行のみを消し、生成済みの
   * 画像ファイルは残す（ライブラリはファイル実体ベースなので影響しない）。
   */
  const handleDeleteSession = async (id: string, title: string) => {
    const message = `チャット履歴「${title}」を削除しますか？会話とプロンプトの記録が消えます（生成済みの画像ファイルは削除されません）。元に戻せません。`;
    let ok = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, { title: "チャット履歴の削除", kind: "warning" });
    } catch {
      ok = window.confirm(message);
    }
    if (!ok) return;
    try {
      await useSessions.getState().remove(id);
    } catch (err) {
      console.error("[ChatHistoryWorkspace] delete failed:", err);
      useToasts.getState().push({
        kind: "error",
        text: "削除に失敗しました。もう一度お試しください。",
        ttlMs: 5000,
      });
    }
  };

  const startEdit = (id: string, current: string) => {
    setEditingId(id);
    setEditDraft(current);
  };
  const commitEdit = async () => {
    if (!editingId) return;
    const trimmed = editDraft.trim();
    const id = editingId;
    setEditingId(null);
    setEditDraft("");
    if (!trimmed) return;
    try {
      await renameSession(id, trimmed);
    } catch (err) {
      console.error("[ChatHistoryWorkspace] rename failed:", err);
    }
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft("");
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#121212] px-4 py-4">
      {/* ヘッダーの「チャット履歴」見出しと重複していたので PageIntro 撤去。 */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="履歴を検索（タイトル・企画チャット本文）"
        className="mb-4 h-9 w-full rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-pink-500"
      />
      <UnsavedPlanChatSection onOpenUnsaved={onOpenUnsaved} query={q} />
      <ProjectPlanChatSection onOpenProjectChat={onOpenProjectChat} query={q} />
      {/*
        分岐順は「検索中の 0 件」→「素の 0 件」。逆順にすると、全履歴 0 件のまま
        検索したときに初回案内が勝ってしまい、「一致する履歴はありません」が
        永久に出ない（Sol 指摘 C-1）。
      */}
      {q && totalMatchCount === 0 ? (
        <DarkEmpty
          title={`「${query}」に一致する履歴はありません`}
          description="別の言葉で検索してください。"
        />
      ) : hasNoHistoryAtAll ? (
        <DarkEmpty
          title="まだチャット履歴がありません"
          description="制作画面で生成すると、ここに最近のチャットが並びます。"
        />
      ) : (
        <div className="mb-4">
          {/*
            見出しは filtered.length の分岐の外（設計 design-history-models.md 手順5）。
            制作チャットが 0 件でも見出しは出し、リスト部だけが空になる。
            他 2 セクションが一致しているのに制作だけ 0 件、という状態で
            「制作チャットという区画がある」ことを消さないため。
          */}
          <div className="mb-2">
            <h3 className="text-xs font-black text-neutral-200">制作チャット</h3>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              画像・動画の生成チャットです。開くと当時の生成結果ごと表示します。
            </p>
          </div>
          <ul className="space-y-1.5">
            {filtered.map((session) => {
            const active = !isFrozen && session.id === activeSessionId;
            const viewing = isFrozen && displayedSession?.session.id === session.id;
            const selected = active || viewing;
            const isEditing = editingId === session.id;
            return (
              <li key={session.id}>
                <div
                  className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                    selected
                      ? "border-pink-400 bg-pink-500/10 ring-1 ring-pink-400/40"
                      : "border-[#2a2a2a] bg-[#181818] hover:border-pink-400/60 hover:bg-[#1f1f1f]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!isEditing) void onOpen(session.id);
                    }}
                    className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-[#242424] bg-[#101010]"
                    aria-label="セッションを開く"
                  >
                    {session.lastImagePath ? (
                      <SafeImage
                        path={session.lastImagePath}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[10px] font-black text-neutral-500">
                        GG
                      </span>
                    )}
                  </button>
                  <div
                    className="min-w-0 flex-1"
                    onDoubleClick={() => startEdit(session.id, session.title)}
                  >
                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          const isComposing =
                            (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
                          if (e.key === "Enter" && !isComposing) {
                            e.preventDefault();
                            void commitEdit();
                          } else if (e.key === "Escape") {
                            cancelEdit();
                          }
                        }}
                        onBlur={() => void commitEdit()}
                        onClick={(e) => e.stopPropagation()}
                        className="h-7 w-full rounded-md border border-pink-400 bg-[#0b0b0b] px-2 text-sm text-neutral-100 outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => void onOpen(session.id)}
                        className="block w-full truncate text-left text-sm font-medium text-neutral-100 hover:text-white"
                      >
                        {session.title}
                      </button>
                    )}
                    <p className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
                      <span>{relativeTimeJa(session.lastUsedAt)}</span>
                      {active && (
                        <span className="rounded bg-pink-500/20 px-1.5 py-px text-[10px] font-medium text-pink-200">
                          作業中
                        </span>
                      )}
                      {viewing && (
                        <span className="rounded bg-pink-500/20 px-1.5 py-px text-[10px] font-medium text-pink-200">
                          表示中
                        </span>
                      )}
                    </p>
                  </div>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => startEdit(session.id, session.title)}
                      title="名前を変更"
                      className="opacity-0 transition group-hover:opacity-100 shrink-0 flex items-center gap-1 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-medium text-neutral-300 hover:border-pink-400 hover:text-white"
                    >
                      <PencilIcon />
                      名前
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteSession(session.id, session.title)}
                      title="このチャット履歴を削除"
                      className="opacity-0 transition group-hover:opacity-100 shrink-0 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-medium text-neutral-300 hover:border-pink-400 hover:text-white"
                    >
                      削除
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => void onOpen(session.id)}
                      className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-white"
                    >
                      開く
                      <ArrowRightIcon />
                    </button>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function relativeTimeJa(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "たった今";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}日前`;
  return new Date(ms).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4 rounded-xl border border-[#242424] bg-[#181818] px-4 py-3">
      <h3 className="text-base font-black text-white">{title}</h3>
      <p className="mt-1 text-xs text-neutral-500">{description}</p>
    </div>
  );
}

function DarkEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#343434] bg-[#181818] px-4 py-10 text-center">
      <p className="text-sm font-black text-white">{title}</p>
      <p className="mt-1 text-xs text-neutral-500">{description}</p>
    </div>
  );
}

function referenceRoleLabel(role?: ReferenceRole) {
  switch (role) {
    case "look":
      return "雰囲気";
    case "background":
      return "背景";
    case "pose":
      return "ポーズ";
    case "product":
      return "商品";
    case "negative":
      return "NG";
    case "subject":
    default:
      return "被写体";
  }
}

function BoardWorkBar({
  total,
  viewMode,
  onViewModeChange,
  tileSize,
  onTileSizeChange,
}: {
  total: number;
  viewMode: "grid" | "list";
  onViewModeChange: (viewMode: "grid" | "list") => void;
  tileSize: number;
  onTileSizeChange: (tileSize: number) => void;
}) {
  return (
    <div className="sticky top-0 z-10 -mx-1 flex items-center justify-between rounded-2xl border border-[#242424] bg-[#181818]/95 px-3 py-2 shadow-sm backdrop-blur">
      <div>
        <p className="text-sm font-black text-white">最近の生成</p>
        <p className="text-[11px] text-neutral-500">
          使う画像を選んで、参照・修正・コピーへ進めます。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Badge>{total} 件表示</Badge>
        <div className="grid grid-cols-2 rounded-md border border-[#303030] bg-[#0f0f0f] p-0.5">
          <button
            type="button"
            onPointerDown={() => onViewModeChange("grid")}
            onClick={() => onViewModeChange("grid")}
            className={`h-7 rounded px-2 text-[11px] font-bold ${
              viewMode === "grid" ? "bg-[#2a2a2a] text-white shadow-sm" : "text-neutral-500"
            }`}
          >
            グリッド
          </button>
          <button
            type="button"
            onPointerDown={() => onViewModeChange("list")}
            onClick={() => onViewModeChange("list")}
            className={`h-7 rounded px-2 text-[11px] font-bold ${
              viewMode === "list" ? "bg-[#2a2a2a] text-white shadow-sm" : "text-neutral-500"
            }`}
          >
            リスト
          </button>
        </div>
        <label className="flex items-center gap-2 whitespace-nowrap text-[11px] font-bold text-neutral-400">
          サイズ
          <input
            type="range"
            min={140}
            max={300}
            step={10}
            value={tileSize}
            onChange={(e) => onTileSizeChange(Number(e.target.value))}
            className="w-28 accent-pink-500"
          />
        </label>
      </div>
    </div>
  );
}

function BoardEmptyState() {
  const references = useComposer((s) => s.references);
  const count = useComposer((s) => s.count);
  const aspect = useComposer((s) => s.aspect);
  const setText = useComposer((s) => s.setText);
  const addReferences = useComposer((s) => s.addReferences);
  const push = useToasts((s) => s.push);
  const openFilePicker = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const refs = paths
        .filter((p): p is string => typeof p === "string")
        .map((path) => ({
          path,
          name: basename(path),
          source: "upload" as const,
          role: "subject" as const,
        }));
      addReferences(refs);
      if (refs.length > 0) {
        push({ kind: "success", text: `${refs.length} 枚を参照に追加しました`, ttlMs: 2400 });
      }
    } catch (err) {
      push({ kind: "error", text: `画像選択に失敗しました。${humanizeError(err)}`, ttlMs: 4000 });
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.15fr)_360px]">
      <div className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              まずここから
            </p>
            <h3 className="mt-2 text-3xl font-black tracking-normal text-neutral-950">
              作りたいものを選ぶ
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-neutral-600">
              ボタンを選ぶだけで、下のCommand Dockに指示が組み上がります。
            </p>
          </div>
          <Badge tone={references.length > 0 ? "blue" : "neutral"}>
            参照 {references.length} / {aspect} / {count}枚
          </Badge>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {PURPOSES.slice(0, 6).map((purpose) => (
            <PurposeActionCard key={purpose.id} purpose={purpose} />
          ))}
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <FlowStepButton
            index="1"
            title="目的"
            body="商品、サムネ、動画カットから選ぶ"
            onClick={() => setText(PURPOSES.find((p) => p.id === "product")?.prompt ?? "")}
          />
          <FlowStepButton
            index="2"
            title="参照"
            body="画像を入れて、固定する要素を決める"
            onClick={openFilePicker}
          />
          <FlowStepButton
            index="3"
            title="生成"
            body="下の生成ボタンでまず1案出す"
            onClick={() => {
              if (!useComposer.getState().text.trim()) {
                setText(PURPOSES.find((p) => p.id === "product")?.prompt ?? "");
              }
            }}
          />
        </div>
      </div>

      <div
        className="flex min-h-[420px] flex-col justify-between rounded-3xl border border-dashed border-blue-300 bg-blue-50/70 p-5"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={async (e) => {
          e.preventDefault();
          const refs = (
            await Promise.all(Array.from(e.dataTransfer.files ?? []).map(droppedFileToReference))
          ).filter((ref): ref is Reference => !!ref);
          if (refs.length === 0) return;
          addReferences(refs);
          setText("この参照画像をもとに、用途に合わせて制作してください。");
          push({ kind: "success", text: `${refs.length} 枚を参照に追加しました`, ttlMs: 2400 });
        }}
      >
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
            参照画像
          </p>
          <h3 className="mt-2 text-2xl font-black text-neutral-950">画像を入れる</h3>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600">
            被写体、商品、雰囲気、背景をここから固定します。
          </p>
        </div>
        <button
          type="button"
          onClick={openFilePicker}
          className="rounded-2xl border border-blue-300 bg-white px-4 py-10 text-center text-sm font-black text-blue-700 shadow-sm hover:border-blue-500"
        >
          クリックまたはドロップで追加
        </button>
        <div className="grid grid-cols-2 gap-2 text-xs font-bold text-neutral-600">
          <span className="rounded-xl bg-white/80 px-3 py-2">被写体固定</span>
          <span className="rounded-xl bg-white/80 px-3 py-2">ルック参照</span>
          <span className="rounded-xl bg-white/80 px-3 py-2">背景固定</span>
          <span className="rounded-xl bg-white/80 px-3 py-2">別角度化</span>
        </div>
      </div>
    </div>
  );
}

function PurposeActionCard({ purpose }: { purpose: (typeof PURPOSES)[number] }) {
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const imageMode = useWorkflow((s) => s.imageMode);
  const videoMode = useWorkflow((s) => s.videoMode);
  const active =
    primaryMode === purpose.workflow.primary &&
    (!purpose.workflow.image || imageMode === purpose.workflow.image) &&
    (!purpose.workflow.video || videoMode === purpose.workflow.video);
  return (
    <button
      type="button"
      disabled={purpose.comingSoon}
      onClick={() => {
        if (purpose.comingSoon) return;
        applyPurposeWorkflow(purpose);
        useComposer.getState().setText(purpose.prompt);
      }}
      className={`rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${
        purpose.comingSoon
          ? "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400 opacity-65"
          : active
            ? "border-neutral-950 bg-neutral-950 text-white"
            : "border-neutral-200 bg-neutral-50 text-neutral-950 hover:border-blue-300 hover:bg-blue-50"
      }`}
    >
      <span className="flex items-center gap-2 text-base font-black">
        {purpose.label}
        {purpose.comingSoon && (
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-black text-neutral-500">
            近日公開
          </span>
        )}
      </span>
      <span
        className={`mt-1 block text-xs leading-relaxed ${active ? "text-neutral-300" : "text-neutral-500"}`}
      >
        {purpose.description}
      </span>
    </button>
  );
}

function FlowStepButton({
  index,
  title,
  body,
  onClick,
}: {
  index: string;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-neutral-200 bg-white p-3 text-left hover:border-blue-300 hover:bg-blue-50"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">
        {index}
      </span>
      <span className="mt-2 block text-sm font-black text-neutral-950">{title}</span>
      <span className="mt-1 block text-[11px] leading-relaxed text-neutral-500">{body}</span>
    </button>
  );
}

function BatchBoardRow({ batchId }: { batchId: string }) {
  const batch = useBatches((s) => s.batches.find((b) => b.batchId === batchId));
  if (!batch) return null;
  const done = batch.workers.filter((w) => w.status === "completed").length;
  return (
    <div className="rounded-3xl border border-blue-200 bg-blue-50/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-black text-neutral-950">生成バッチ</p>
          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">
            {batch.prompt || "生成中..."}
          </p>
        </div>
        <Badge tone="blue">
          {done}/{batch.count} 完了
        </Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {batch.workers.map((worker) => (
          <BatchWorkerTile key={worker.idx} worker={worker} />
        ))}
      </div>
    </div>
  );
}

function BatchWorkerTile({ worker }: { worker: BatchWorker }) {
  if (worker.status !== "completed") {
    return (
      <div className="flex aspect-square items-center justify-center rounded-2xl border border-blue-200 bg-white text-xs font-bold text-blue-700">
        {worker.status === "failed" ? "失敗" : "生成中"}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => useImagePreview.getState().open(worker.path)}
      className="aspect-square overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm hover:border-blue-400"
    >
      <SafeImage path={worker.path} alt="" className="h-full w-full object-cover" />
    </button>
  );
}

function BoardImageCard({
  item,
  active,
  onSelect,
  tileSize,
}: {
  item: GalleryItem;
  active: boolean;
  onSelect: () => void;
  tileSize: number;
}) {
  const addReference = useComposer((s) => s.addReference);
  const setText = useComposer((s) => s.setText);
  const push = useToasts((s) => s.push);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(item.path);
      push({ kind: "success", text: "画像パスをコピーしました", ttlMs: 2000 });
    } catch {
      push({ kind: "error", text: "コピーに失敗しました", ttlMs: 2500 });
    }
  };
  return (
    <article
      className={`group overflow-hidden rounded-xl border bg-[#1a1a1a] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
        active ? "border-pink-400 ring-2 ring-pink-500/20" : "border-[#2a2a2a]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => useImagePreview.getState().open(item.path)}
        className="block aspect-[16/9] w-full bg-[#0f0f0f]"
      >
        <SafeImage
          path={item.path}
          alt={item.name}
          className="h-full w-full object-cover"
        />
      </button>
      <div className={tileSize < 210 ? "p-2" : "p-3"}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="truncate text-[11px] font-bold text-neutral-200" title={item.name}>
            {item.name}
          </p>
          {active ? (
            <Badge tone="blue">選択中</Badge>
          ) : tileSize >= 240 ? (
            <Badge>候補</Badge>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={onSelect}
            className="h-7 rounded-md bg-white text-[11px] font-black text-black hover:bg-neutral-200"
          >
            採用
          </button>
          <Button
            size="xs"
            onClick={() =>
              addReference({ path: item.path, name: item.name, role: "subject", source: "gallery" })
            }
            className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            参照
          </Button>
          <Button
            size="xs"
            className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
            onClick={() => setText("この画像をベースに、さらに完成度を上げてください。")}
          >
            修正へ
          </Button>
          <Button
            size="xs"
            className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
            onClick={copyPath}
          >
            コピー
          </Button>
        </div>
      </div>
    </article>
  );
}

function BoardListItem({
  item,
  active,
  onSelect,
  thumbnailSize,
}: {
  item: GalleryItem;
  active: boolean;
  onSelect: () => void;
  thumbnailSize: number;
}) {
  const addReference = useComposer((s) => s.addReference);
  const setText = useComposer((s) => s.setText);
  const push = useToasts((s) => s.push);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(item.path);
      push({ kind: "success", text: "画像パスをコピーしました", ttlMs: 2000 });
    } catch {
      push({ kind: "error", text: "コピーに失敗しました", ttlMs: 2500 });
    }
  };
  return (
    <article
      className={`flex items-center gap-3 rounded-xl border bg-[#1a1a1a] p-2 transition hover:border-pink-400 ${
        active ? "border-pink-400 ring-2 ring-pink-500/20" : "border-[#2a2a2a]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => useImagePreview.getState().open(item.path)}
        className="flex-shrink-0 overflow-hidden rounded-lg bg-[#0f0f0f]"
        style={{ width: thumbnailSize, height: Math.round(thumbnailSize * 0.62) }}
      >
        <SafeImage
          path={item.path}
          alt={item.name}
          className="h-full w-full object-cover"
        />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black text-white" title={item.name}>
          {item.name}
        </p>
        <p className="mt-1 truncate text-[11px] text-neutral-500">{item.path}</p>
      </div>
      <div className="grid w-[220px] grid-cols-4 gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          className="h-8 rounded-md bg-white text-[11px] font-black text-black hover:bg-neutral-200"
        >
          採用
        </button>
        <Button
          size="xs"
          onClick={() =>
            addReference({ path: item.path, name: item.name, role: "subject", source: "gallery" })
          }
          className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          参照
        </Button>
        <Button
          size="xs"
          className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
          onClick={() => setText("この画像をベースに、さらに完成度を上げてください。")}
        >
          修正
        </Button>
        <Button
          size="xs"
          className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
          onClick={copyPath}
        >
          コピー
        </Button>
      </div>
    </article>
  );
}

function GuidedCommandDock() {
  const text = useComposer((s) => s.text);
  const references = useComposer((s) => s.references);
  const primaryMode = useWorkflow((s) => s.primaryMode);
  return (
    <div className="border-t border-neutral-200 bg-[#eef2f7] px-5 pb-4 pt-2.5">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_16px_45px_rgba(15,23,42,0.12)]">
        <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              Command Dock
            </p>
            <h3 className="mt-0.5 text-sm font-black text-neutral-950">選ぶほど指示が組み上がる</h3>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={primaryMode === "video" ? "blue" : "neutral"}>
              {primaryMode === "video" ? "動画" : "画像"}
            </Badge>
            <Badge tone={references.length > 0 ? "blue" : "neutral"}>
              参照 {references.length}
            </Badge>
            <Badge tone={text.trim() ? "amber" : "neutral"}>
              {text.trim() ? "指示あり" : "未入力"}
            </Badge>
          </div>
        </div>
        <GuidedActions />
        <PromptComposer embedded />
      </div>
    </div>
  );
}

function GuidedActions() {
  const [selectedPurpose, setSelectedPurpose] = useState<GuidedPurpose>("product");
  const setText = useComposer((s) => s.setText);
  const setCount = useComposer((s) => s.setCount);
  const setAspect = useComposer((s) => s.setAspect);
  const setReferenceRole = useComposer((s) => s.setReferenceRole);
  const references = useComposer((s) => s.references);
  const append = (phrase: string) => {
    const current = useComposer.getState().text.trim();
    setText(current ? `${current}\n${phrase}` : phrase);
  };

  return (
    <div className="border-b border-neutral-100 px-4 py-2.5">
      <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr_0.8fr]">
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.16em] text-blue-700">
            何を作る？
          </p>
          <div className="flex flex-wrap gap-1">
            {PURPOSES.map((purpose) => (
              <button
                key={purpose.id}
                type="button"
                disabled={purpose.comingSoon}
                onClick={() => {
                  if (purpose.comingSoon) return;
                  setSelectedPurpose(purpose.id);
                  applyPurposeWorkflow(purpose);
                  setText(purpose.prompt);
                }}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                  purpose.comingSoon
                    ? "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-400"
                    : selectedPurpose === purpose.id
                      ? "border-neutral-950 bg-neutral-950 text-white"
                      : "border-neutral-200 bg-neutral-50 text-neutral-700 hover:border-blue-300 hover:bg-blue-50"
                }`}
              >
                {purpose.label}
                {purpose.comingSoon ? " / 近日公開" : ""}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.16em] text-blue-700">
            何に使う？
          </p>
          <div className="flex flex-wrap gap-1">
            {USE_CASES.map((useCase) => (
              <button
                key={useCase}
                type="button"
                onClick={() => {
                  append(`${useCase}用途に最適化してください。`);
                  if (useCase.includes("縦") || useCase.includes("ショート")) setAspect("9:16");
                  if (useCase.includes("YouTube")) setAspect("16:9");
                }}
                className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] font-bold text-neutral-700 hover:border-blue-300 hover:bg-blue-50"
              >
                {useCase}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.16em] text-blue-700">
            何を固定？
          </p>
          <div className="flex flex-wrap gap-1">
            {KEEP_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  append(option.phrase);
                  references.forEach((ref) => setReferenceRole(ref.path, option.role));
                }}
                className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] font-bold text-neutral-700 hover:border-blue-300 hover:bg-blue-50"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button size="xs" onClick={() => setCount(4)}>
              4案
            </Button>
            <Button size="xs" onClick={() => setCount(9)}>
              9カット
            </Button>
            <Button size="xs" onClick={() => setAspect("9:16" as FrameAspect)}>
              9:16
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InspectorPanel() {
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const videoMode = useWorkflow((s) => s.videoMode);
  const imageMode = useWorkflow((s) => s.imageMode);
  const setPrimaryMode = useWorkflow((s) => s.setPrimaryMode);
  const setVideoMode = useWorkflow((s) => s.setVideoMode);
  const setImageMode = useWorkflow((s) => s.setImageMode);
  const lockReference = useWorkflow((s) => s.lockReference);
  const lockedReference = useWorkflow((s) => s.lockedReference);
  const layers = useWorkflow((s) => s.layers);
  const addLayer = useWorkflow((s) => s.addLayer);
  const toggleLayer = useWorkflow((s) => s.toggleLayer);
  const setLayerOpacity = useWorkflow((s) => s.setLayerOpacity);
  const references = useComposer((s) => s.references);
  const setReferenceRole = useComposer((s) => s.setReferenceRole);
  const selectedPath = useImages((s) => s.selectedPath);
  const selectedItem = useImages((s) => s.items.find((item) => item.path === selectedPath));
  return (
    <aside className="min-h-0 overflow-y-auto border-l border-neutral-200 bg-[#fbfbfc] p-3">
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">制作設定</p>
      <h3 className="mt-0.5 text-base font-black text-neutral-950">
        {primaryMode === "video"
          ? "動画カット"
          : imageMode === "edit"
            ? "修正"
            : imageMode === "layers"
              ? "レイヤー"
              : "生成"}
      </h3>
      <div className="mt-3 space-y-2.5">
        <InfoPanel title="モード">
          <SegmentedTabs<PrimaryMode>
            value={primaryMode}
            options={[
              ["image", "画像"],
              ["video", "動画"],
            ]}
            onChange={setPrimaryMode}
          />
          {primaryMode === "image" ? (
            <div className="mt-2">
              <SegmentedTabs<ImageMode>
                value={imageMode}
                options={[
                  ["generate", "生成"],
                  ["edit", "編集"],
                  ["layers", "レイヤー"],
                ]}
                onChange={setImageMode}
              />
            </div>
          ) : (
            <div className="mt-2">
              <SegmentedTabs<VideoMode>
                value={videoMode}
                options={[
                  ["story", "ストーリー"],
                  ["multiAngle", "別角度"],
                ]}
                onChange={setVideoMode}
              />
            </div>
          )}
        </InfoPanel>
        <InfoPanel title="参照メモリ">
          {references.length === 0 ? (
            <p>画像をドロップするか、素材から参照に追加します。</p>
          ) : (
            <div className="space-y-2">
              {references.map((ref) => (
                <div
                  key={ref.path}
                  className="rounded-xl border border-neutral-200 bg-neutral-50 p-2"
                >
                  <p className="truncate font-bold text-neutral-950" title={ref.path}>
                    {ref.name}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    {KEEP_OPTIONS.map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() => setReferenceRole(ref.path, option.role)}
                        className={`rounded-md border px-2 py-1 text-[10px] font-bold ${
                          ref.role === option.role
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-neutral-200 bg-white text-neutral-600 hover:border-blue-300"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </InfoPanel>
        {primaryMode === "video" && (
          <InfoPanel title="動画設定">
            <div className="grid gap-2">
              <Button
                size="xs"
                disabled={!selectedItem}
                onClick={() => {
                  if (!selectedItem) return;
                  lockReference({ path: selectedItem.path, name: selectedItem.name });
                }}
              >
                選択画像を基準に固定
              </Button>
              <p className="truncate" title={lockedReference?.path}>
                基準: {lockedReference?.name ?? "未設定"}
              </p>
              <Button
                size="xs"
                onClick={() => {
                  setPrimaryMode("video");
                  setVideoMode("story");
                  useComposer
                    .getState()
                    .setText("同じ被写体と世界観を保って、次のストーリーカットを作ってください。");
                }}
              >
                次カットを作る
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  setPrimaryMode("video");
                  setVideoMode("multiAngle");
                  useComposer
                    .getState()
                    .setText(
                      "位置関係と環境を固定し、カメラだけを動かした別角度を作ってください。",
                    );
                }}
              >
                別角度を作る
              </Button>
            </div>
          </InfoPanel>
        )}
        {primaryMode === "image" && imageMode === "layers" && (
          <InfoPanel title="レイヤー">
            <div className="mb-2 grid grid-cols-2 gap-1">
              {(["text", "person", "background", "object"] as LayerKind[]).map((kind) => (
                <Button key={kind} size="xs" onClick={() => addLayer(kind)}>
                  {layerKindLabel(kind)}
                </Button>
              ))}
            </div>
            <div className="space-y-2">
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className="rounded-xl border border-neutral-200 bg-neutral-50 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => toggleLayer(layer.id)}
                      className="font-bold text-neutral-950"
                    >
                      {layer.visible ? "表示" : "非表示"} / {layer.name}
                    </button>
                    <span className="text-[10px] text-neutral-500">{layer.opacity}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={layer.opacity}
                    onChange={(e) => setLayerOpacity(layer.id, Number(e.target.value))}
                    className="mt-2 w-full"
                  />
                </div>
              ))}
            </div>
          </InfoPanel>
        )}
        <InfoPanel title="選択画像">
          <p className="truncate" title={selectedPath}>
            {selectedItem?.name ?? "未選択"}
          </p>
          <div className="mt-2 grid gap-1.5">
            <Button
              size="xs"
              disabled={!selectedItem}
              onClick={() =>
                useComposer.getState().setText("この画像をさらに高品質に修正してください。")
              }
            >
              修正へ
            </Button>
            <Button
              size="xs"
              disabled={!selectedItem}
              onClick={() =>
                useComposer.getState().setText("この画像を動画用の次カットにしてください。")
              }
            >
              動画化
            </Button>
            <Button
              size="xs"
              disabled={!selectedItem}
              onClick={() =>
                useComposer.getState().setText("この画像をレイヤー分けしやすい構成にしてください。")
              }
            >
              レイヤー分け
            </Button>
          </div>
        </InfoPanel>
      </div>
    </aside>
  );
}

function layerKindLabel(kind: LayerKind) {
  switch (kind) {
    case "text":
      return "文字";
    case "person":
      return "人物";
    case "background":
      return "背景";
    case "object":
      return "素材";
    case "adjustment":
      return "色調";
  }
}

function InfoPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-2.5 text-[11px] text-neutral-600 shadow-sm">
      <p className="mb-2 text-xs font-black text-neutral-950">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SideDrawer({
  drawer,
  onClose,
  onCreate,
  onOpen,
}: {
  drawer: Exclude<DrawerKind, null>;
  onClose: () => void;
  onCreate: (title?: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
}) {
  // onCreate は将来「ドロワー内から新規セッション作成」を再導入する時のための型予約
  void onCreate;
  return (
    <div className="absolute inset-y-0 left-0 z-30 w-[360px] border-r border-neutral-200 bg-white shadow-2xl">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-700">
              パネル
            </p>
            <h3 className="text-lg font-black text-neutral-950">{drawerTitle(drawer)}</h3>
          </div>
          <Button size="xs" onClick={onClose}>
            閉じる
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {drawer === "assets" && <AssetsDrawer />}
          {drawer === "references" && <ReferencesDrawer />}
          {drawer === "history" && <ProjectsDrawer />}
          {drawer === "presets" && <PresetsDrawer onNavigateToSkill={onClose} />}
          {drawer === "skills" && <SkillsWorkspace onUseSkill={onClose} />}
          {drawer === "export" && <ChatHistoryDrawer onOpen={onOpen} />}
        </div>
      </div>
    </div>
  );
}

function drawerTitle(drawer: Exclude<DrawerKind, null>) {
  switch (drawer) {
    case "assets":
      return "ライブラリ";
    case "references":
      return "参照メモリ";
    case "history":
      return "プロジェクト";
    case "presets":
      return "プリセット";
    case "skills":
      return "スキル";
    case "settings":
      return "設定";
    case "export":
      return "チャット履歴";
  }
}

function AssetsDrawer() {
  // 不安定セレクタ修正 (2026-07-30): slice はセレクタ内で呼ばない。
  // zustand v5 はセレクタ結果をキャッシュしないため、毎回新配列を返すと
  // 同期コミット無限ループになる (React "Maximum update depth exceeded")。
  const all = useImages((s) => s.items);
  const items = useMemo(() => all.slice(0, 80), [all]);
  const addReference = useComposer((s) => s.addReference);
  if (items.length === 0) {
    return (
      <EmptyState
        title="素材がありません"
        description="生成またはアップロードするとここに表示されます。"
      />
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() =>
            addReference({ path: item.path, name: item.name, source: "gallery", role: "subject" })
          }
          className="overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left hover:border-blue-400"
        >
          <SafeImage
            path={item.path}
            alt=""
            className="aspect-square w-full object-cover"
          />
          <p className="truncate px-2 py-1.5 text-[10px] font-bold text-neutral-600">{item.name}</p>
        </button>
      ))}
    </div>
  );
}

function ReferencesDrawer() {
  const refs = useComposer((s) => s.references);
  const remove = useComposer((s) => s.removeReference);
  if (refs.length === 0) {
    return <EmptyState title="参照がありません" description="素材や生成結果を参照に追加します。" />;
  }
  return (
    <div className="space-y-2">
      {refs.map((ref) => (
        <div
          key={ref.path}
          className="flex gap-2 rounded-2xl border border-neutral-200 bg-white p-2"
        >
          <SafeImage
            path={ref.path}
            alt=""
            className="h-14 w-14 rounded-xl object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-neutral-950">{ref.name}</p>
            <p className="mt-1 text-[11px] text-neutral-500">{ref.role ?? "subject"}</p>
          </div>
          <Button size="xs" tone="danger" onClick={() => remove(ref.path)}>
            外す
          </Button>
        </div>
      ))}
    </div>
  );
}

// HistoryDrawer / HistoryWorkspace は ProjectsDrawer / ProjectsWorkspace に
// 置き換えたため削除。チャット履歴は ChatHistoryWorkspace 側で扱う。

/**
 * チャット履歴ドロワー: ChatGPT 風の縦リスト表示。
 * クリックで該当セッションを開く。納品書き出し UI は廃止し、ここに転用。
 */
function ChatHistoryDrawer({ onOpen }: { onOpen: (id: string) => Promise<void> }) {
  const sessions = useSessions((s) => s.sessions);
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="チャット履歴がありません"
        description="制作画面で生成すると、ここに最近のチャットが並びます。"
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => void onOpen(session.id)}
          className="flex w-full items-center gap-2 rounded-xl border border-neutral-200 bg-white p-2 text-left hover:border-pink-400"
        >
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100">
            {session.lastImagePath ? (
              <SafeImage
                path={session.lastImagePath}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] font-black text-neutral-400">
                GG
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-neutral-950">{session.title}</p>
            <p className="mt-0.5 text-[10px] text-neutral-500">
              {relativeTimeJa(session.lastUsedAt)}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}

function SessionCard({
  session,
  onOpen,
  compact,
}: {
  session: Session;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full gap-3 rounded-2xl border border-[#2a2a2a] bg-[#1a1a1a] p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-pink-400 hover:shadow-md ${
        compact ? "items-center" : ""
      }`}
    >
      <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-xl border border-[#333] bg-[#111]">
        {session.lastImagePath ? (
          <SafeImage
            path={session.lastImagePath}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs font-black text-neutral-500">
            GG
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-black text-white">{session.title}</p>
        <p className="mt-1 text-xs text-neutral-500">{timeAgo(session.lastUsedAt)}</p>
      </div>
    </button>
  );
}

function applyPurposeWorkflow(purpose: (typeof PURPOSES)[number]) {
  const workflow = useWorkflow.getState();
  workflow.setPrimaryMode(purpose.workflow.primary);
  if (purpose.workflow.image) workflow.setImageMode(purpose.workflow.image);
  if (purpose.workflow.video) workflow.setVideoMode(purpose.workflow.video);
}

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "たった今";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}日前`;
  return new Date(ms).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

/* --- フラットアイコン (絵文字廃止) --- */

const APP_SVG = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** クラウド (Supabase 使用量ラベル)。 */
function CloudIcon() {
  return (
    <svg {...APP_SVG} width={11} height={11} className="shrink-0" aria-hidden>
      <path d="M7 18h10a4 4 0 000-8 6 6 0 00-11.6 2A3.5 3.5 0 006 18z" />
    </svg>
  );
}

/** 警告 (三角 + ビックリ)。 */
function WarnTriangleIcon() {
  return (
    <svg {...APP_SVG} width={10} height={10} className="shrink-0" aria-hidden>
      <path d="M12 3.5L22 20H2z" />
      <path d="M12 9.5v4.5M12 16.9v.3" />
    </svg>
  );
}

/** 稲妻 (拡張接続バッジ)。 */
function BoltIcon() {
  return (
    <svg {...APP_SVG} width={11} height={11} className="shrink-0" aria-hidden>
      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
    </svg>
  );
}

/** グリッド表示。 */
function GridViewIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={1.8} className="shrink-0" aria-hidden>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
    </svg>
  );
}

/** リスト表示。 */
function ListViewIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} className="shrink-0" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

/** チェック済みの四角 (選択モード開始)。 */
function CheckSquareIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={1.8} className="shrink-0" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M7.5 12.2l3 3 6-6.4" />
    </svg>
  );
}

/** チェック (選択中バッジ)。 */
function CheckIcon() {
  return (
    <svg {...APP_SVG} width={13} height={13} strokeWidth={2.8} className="shrink-0" aria-hidden>
      <path d="M4 12.5l5.5 5.5L20 6" />
    </svg>
  );
}

/** ゴミ箱 (削除)。 */
function TrashIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={1.8} className="shrink-0" aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

/** フォルダ + プラス (プロジェクトへ追加)。 */
function FolderAddIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={1.8} className="shrink-0" aria-hidden>
      <path d="M3 7.5a1.5 1.5 0 011.5-1.5h4l2 2.5h8A1.5 1.5 0 0120 10v8a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013 18z" />
      <path d="M11.5 14h4M13.5 12v4" />
    </svg>
  );
}

/** プラス (新規作成)。size で見出し脇 / 本文内を切り替える。 */
function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...APP_SVG} width={size} height={size} strokeWidth={2.4} className="shrink-0" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 下向き山カッコ (ポップオーバー開閉)。 */
function CaretDownIcon() {
  return (
    <svg {...APP_SVG} width={10} height={10} strokeWidth={2.4} className="shrink-0" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** ペン (名前を編集)。 */
function PencilIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={1.8} className="shrink-0" aria-hidden>
      <path d="M4 20h4l11-11-4-4L4 16v4z" />
      <path d="M13.5 5.5l4 4" />
    </svg>
  );
}

/** × (閉じる / 削除)。 */
function CloseIcon() {
  return (
    <svg {...APP_SVG} width={12} height={12} strokeWidth={2.2} className="shrink-0" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 右矢印 (開く)。 */
function ArrowRightIcon() {
  return (
    <svg {...APP_SVG} width={11} height={11} strokeWidth={2.2} className="shrink-0" aria-hidden>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

// 既存のライトUI部品は段階移行中のため保持。次の整理フェーズで削除する。
const legacyUiKeepAlive = [HomeScreen, Rail, GuidedCommandDock, InspectorPanel, SideDrawer];
void legacyUiKeepAlive;

export default App;
