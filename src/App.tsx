import "./App.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { AuthGate } from "./components/AuthGate";
import { FirstRunStorageNotice } from "./components/FirstRunStorageNotice";
import { GenerationWorkspace } from "./components/GenerationWorkspace";
import { ImagePreviewModal } from "./components/ImagePreviewModal";
import { MaskEditorModal } from "./components/MaskEditorModal";
import { PromptComposer } from "./components/PromptComposer";
import { SettingsWorkspace } from "./components/SettingsWorkspace";
import { SkillsWorkspace } from "./components/SkillsWorkspace";
import { Toaster } from "./components/Toaster";
import { Badge, Button, EmptyState, SegmentedTabs } from "./components/ui";
import { attachWindowDragDrop } from "./lib/dragDrop";
import { images as imagesIpc, onImageBatch, onImageGenerated, type AuthAccount } from "./lib/ipc";
import { useAuth } from "./lib/store/auth";
import { useBatches, type BatchWorker } from "./lib/store/batches";
import { useComposer, type FrameAspect, type Reference, type ReferenceRole } from "./lib/store/composer";
import { useDragHover } from "./lib/store/dragHover";
import { useImagePreview } from "./lib/store/imagePreview";
import { useImages, type GalleryItem } from "./lib/store/images";
import { usePromptHistory } from "./lib/store/promptHistory";
import { useSavedPrompts } from "./lib/store/savedPrompts";
import { useSessions, type Session } from "./lib/store/sessions";
import { useWorkspace } from "./lib/store/workspace";
import { useProjects, type Project } from "./lib/store/projects";
import { useActiveProject } from "./lib/store/activeProject";
import { useLibrarySelection } from "./lib/store/librarySelection";
import { LibraryAutoRenameButton } from "./components/LibraryAutoRenameButton";
import { useAccounts } from "./lib/store/accounts";
import { useSettings } from "./lib/store/settings";
import { useThreads } from "./lib/store/threads";
import { useToasts } from "./lib/store/toasts";
import { useCloudSupabase } from "./lib/store/cloudSupabase";
import { PresetsDrawer } from "./components/PresetsDrawer";
import {
  useWorkflow,
  type ImageMode,
  type LayerKind,
  type PrimaryMode,
  type VideoMode,
} from "./lib/store/workflow";

type DrawerKind = "assets" | "references" | "history" | "presets" | "skills" | "export" | "settings" | null;
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
    prompt: "商品カットとして、形状、素材感、光の反射、背景との分離が美しく見えるようにしてください。",
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
    prompt: "動画用のストーリーカットとして、同じ世界観と被写体を保ちながら次の使えるカットを作ってください。",
    workflow: { primary: "video", video: "story" },
  },
  {
    id: "multiAngle",
    label: "別角度",
    description: "環境固定でカメラだけ動かす",
    prompt: "マルチアングル用に、被写体、環境、位置関係、光を固定し、カメラだけを動かした別角度を作ってください。",
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
  { label: "雰囲気", role: "look", phrase: "参照画像の光、色、レンズ感、質感を引き継いでください。" },
  { label: "背景", role: "background", phrase: "参照画像の背景と空間構造を引き継いでください。" },
  { label: "ポーズ", role: "pose", phrase: "参照画像のポーズやカメラとの関係を引き継いでください。" },
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
      <Toaster />
      <FirstRunStorageNotice />
    </main>
  );
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

  const openSession = async (id: string) => {
    await useSessions.getState().switchTo(id);
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
    useImages.getState().attachListeners();
    useImages.getState().startWatcher();
    useAccounts.getState().refresh();
    // v0.6.9: プロジェクトをファイル保存に移行。起動時にファイルから読み出し、
    // 旧 localStorage データがあればファイルへマイグレーション。
    useProjects.getState().initialize().catch((err) => {
      console.error("projects.initialize failed", err);
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
    arm(
      onImageBatch((e) => {
        useBatches.getState().applyEvent(e);
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
            const batch = useBatches.getState().batches.find(
              (b) => b.batchId === e.batchId,
            );
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
    const created = useProjects.getState().createProject(name);
    useActiveProject.getState().setActive(created.id);
    setDrawer(null);
    // 作成完了の視覚フィードバック (画面のどこを見ても変化があるか分かりにくいため)
    useToasts.getState().push({
      kind: "success",
      text: `プロジェクト「${created.name}」を作成 / 切替`,
      ttlMs: 2400,
    });
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
                  (e.nativeEvent as KeyboardEvent).isComposing ||
                  e.keyCode === 229;
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
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-pink-400">
              開始
            </p>
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
              <EmptyState title="まだ案件がありません" description="目的ボタンか新規案件から始めます。" />
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
                await Promise.all(Array.from(e.dataTransfer.files ?? []).map(droppedFileToReference))
              ).filter((ref): ref is Reference => !!ref);
              if (refs.length === 0) return;
              useComposer.getState().addReferences(refs);
              useComposer.getState().setText("この参照画像をもとに、用途に合わせて制作してください。");
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
      <div className="relative flex min-h-0 flex-1 flex-col bg-[#121212]">
        <BoardHeader title={title} activePage={drawer} />
        <WorkspacePage page={drawer} setDrawer={setDrawer} onCreate={onCreate} onOpen={onOpen} />
      </div>
    </div>
  );
}

function WorkspacePage({
  page,
  setDrawer,
  onCreate,
  onOpen,
}: {
  page: DrawerKind;
  setDrawer: (drawer: DrawerKind) => void;
  onCreate: (title?: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
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
      return <PresetsWorkspace />;
    case "skills":
      return <SkillsWorkspace onUseSkill={() => setDrawer(null)} />;
    case "export":
      return <ChatHistoryWorkspace onOpen={onOpen} />;
    case "settings":
      return <SettingsWorkspace />;
    default:
      return <GenerationWorkspace />;
  }
}

function PresetsWorkspace() {
  // BoardHeader が画面上に「プリセット」タイトルを既に出すので、ここでは
  // PageIntro を使わず本体だけ描画する（重複表示を避ける）。
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <PresetsDrawer fullPage />
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
      <path
        d="M11 3L13 5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
function NavIconLibrary() {
  // 写真スタック: 画像コレクション
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2.5"
        y="4.5"
        width="9"
        height="9"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
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
      <path d="M13 2.5V4.5M12 3.5H14M2.5 10.5V12.5M1.5 11.5H3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
function NavIconSettings() {
  // 標準的な歯車アイコン (8歯、中央に円)
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {icon}
      </span>
      {!collapsed && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );

  return (
    <aside className={`flex h-full min-h-0 flex-shrink-0 flex-col border-r border-[#242424] bg-[#151515] px-3 py-4 transition-[width] ${collapsed ? "w-[64px]" : "w-[200px]"}`}>
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
            <span className="logo-font text-[22px] leading-none text-white">
              GG
            </span>
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
              <line
                x1="6"
                y1="3"
                x2="6"
                y2="13"
                stroke="currentColor"
                strokeWidth="1.4"
              />
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
            <line
              x1="6"
              y1="3"
              x2="6"
              y2="13"
              stroke="currentColor"
              strokeWidth="1.4"
            />
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
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-500 text-base font-semibold text-white shadow-sm transition hover:bg-pink-600">
          ＋
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
      {/* チャット履歴・設定はサイドバー最下部、フッター情報の上に配置 */}
      <div className="space-y-1">
        {chatNav}
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
  shortPath = shortPath.replace(/~\/Library\/Mobile Documents\/com~apple~CloudDocs/, "~/iCloud Drive");

  return (
    <div className="space-y-1 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-bold text-neutral-500">ローカル</span>
          <span className={`text-[11px] font-black ${tone}`}>{display}</span>
        </div>
        <p className="mt-1 truncate font-mono text-[9px] text-neutral-500" title={stats.storageRoot}>
          {shortPath}
        </p>
        <p className="mt-0.5 text-[9px] text-neutral-600">{stats.fileCount} ファイル</p>
      </div>
      {cloudUsage && (
        <div className="border-t border-[#242424] pt-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] font-bold text-neutral-500">☁️ Supabase</span>
            <span className={`text-[11px] font-black ${cloudTone}`}>
              {formatSidebarBytes(cloudUsage.usedBytes)} / {formatSidebarBytes(cloudUsage.limitBytes)}
            </span>
          </div>
          {cloudUsage.limitBytes > 0 && cloudUsage.usedBytes / cloudUsage.limitBytes > 0.8 && (
            <p className="mt-0.5 text-[9px] text-amber-300">⚠️ 残り少なめ</p>
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
      pushToast({ kind: "error", text: `画像選択に失敗: ${String(err)}`, ttlMs: 4000 });
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
              {([
                ["generate", "生成"],
                ["edit", "編集"],
                ["layers", "レイヤー"],
              ] as Array<[ImageMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setImageMode(mode)}
                  className={`h-8 rounded-lg text-[11px] font-black ${
                    imageMode === mode ? "bg-[#2a2a2a] text-white" : "text-neutral-500 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#111] p-1">
              {([
                ["story", "ストーリー"],
                ["multiAngle", "別角度"],
              ] as Array<[VideoMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setVideoMode(mode)}
                  className={`h-8 rounded-lg text-[11px] font-black ${
                    videoMode === mode ? "bg-[#2a2a2a] text-white" : "text-neutral-500 hover:text-white"
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
  if (primaryMode === "video") return videoMode === "multiAngle" ? "マルチアングル" : "ストーリーカット";
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
  const running = batches.some((b) => b.status === "running");
  // 制作タブ (activePage === null) のときは、内部の WorkspaceTabs で
  // 「企画 / 生成 / 編集」のいずれかが選ばれている。タイトルもそれに追従する。
  const activeTab = useWorkspace((s) => s.activeTab);
  const liveTabLabel =
    activeTab === "plan" ? "企画" : activeTab === "edit" ? "編集" : title;
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
        <h2 className="text-lg font-black tracking-normal text-white">
          {pageTitle}
        </h2>
        <div className="flex items-center gap-3">
          <UsageGauges />
          <Badge tone={running ? "blue" : "neutral"}>
            {running ? "生成中" : "生成準備OK"}
          </Badge>
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

  // Higgsfield credits を取得 (認証済みのときだけ)。起動時 + 5 分ごとに refresh。
  useEffect(() => {
    let cancelled = false;
    const fetchCredits = async () => {
      if (cancelled) return;
      await useAccounts.getState().refreshHiggsfield().catch(() => undefined);
    };
    void fetchCredits();
    const id = setInterval(fetchCredits, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Higgsfield 未認証なら何も表示しない (連携後にクレジット数だけ表示)
  if (!hfAuthed || hfCredits === undefined) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center gap-1.5 rounded-md border border-pink-400/40 bg-pink-500/10 px-2.5 py-1 text-[11px] font-bold text-pink-100"
        title={`HiggsField credits: ${Math.round(hfCredits)}`}
      >
        <span className="text-pink-300">⚡ HiggsField</span>
        <span className="tabular-nums text-white">{Math.round(hfCredits)}</span>
      </div>
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
              className={`h-6 px-2 rounded text-[11px] font-medium transition ${
                viewMode === "grid"
                  ? "bg-pink-500 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              ▦ グリッド
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              title="リスト表示"
              className={`h-6 px-2 rounded text-[11px] font-medium transition ${
                viewMode === "list"
                  ? "bg-pink-500 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              ☰ リスト
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
              <span className="w-8 text-[10px] tabular-nums text-neutral-500">
                {tileSize}
              </span>
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
              className="h-7 rounded-md bg-pink-500 px-3 text-[11px] font-bold text-white hover:bg-pink-400"
              disabled={items.length === 0}
            >
              ☑︎ 選択モード
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <DarkEmpty title="素材がありません" description="画像を生成またはアップロードするとここに並びます。" />
      ) : viewMode === "grid" ? (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))`,
          }}
        >
          {items.map((item) => {
            const isSelected = selected.has(item.path);
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
                  <img
                    src={convertFileSrc(item.path)}
                    alt=""
                    className="aspect-[16/9] w-full object-cover"
                  />
                  <div className="p-2">
                    <p className="truncate text-[11px] font-bold text-neutral-200">
                      {item.name}
                    </p>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      {selectionMode
                        ? isSelected
                          ? "✓ 選択中（クリックで外す）"
                          : "クリックで選択"
                        : "クリックで参照 / ダブルクリックで拡大"}
                    </p>
                  </div>
                </button>
                {selectionMode && (
                  <div
                    className={[
                      "pointer-events-none absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border-2 text-[12px] font-black",
                      isSelected
                        ? "border-pink-400 bg-pink-500 text-white"
                        : "border-white/70 bg-black/60 text-transparent",
                    ].join(" ")}
                  >
                    ✓
                  </div>
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
            return (
              <button
                key={item.path}
                type="button"
                onDoubleClick={() => useImagePreview.getState().open(item.path)}
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
                <img
                  src={convertFileSrc(item.path)}
                  alt=""
                  className="h-10 w-16 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-neutral-200">
                    {item.name}
                  </p>
                  <p className="truncate text-[10px] text-neutral-500">
                    {selectionMode
                      ? isSelected
                        ? "✓ 選択中（クリックで外す）"
                        : "クリックで選択"
                      : "クリックで参照 / ダブルクリックで拡大"}
                  </p>
                </div>
                {selectionMode && isSelected && (
                  <span className="text-[14px] font-black text-pink-400">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
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
          "h-7 rounded-md px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
            : open
              ? "bg-pink-400 text-white"
              : "bg-pink-500 text-white hover:bg-pink-400",
        ].join(" ")}
        title="選択中の画像をプロジェクトに追加"
      >
        ◱ {selected.size} 件をプロジェクトへ ▾
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
                    (event.nativeEvent as KeyboardEvent).isComposing ||
                    event.keyCode === 229;
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
      <PageIntro title="固定する要素" description="人物・商品・画風・背景など、次の生成で絶対に引き継ぐ要素を管理します。" />
      {refs.length === 0 ? (
        <DarkEmpty title="参照がありません" description="素材庫または作品カードから参照に追加してください。" />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {refs.map((ref) => (
            <div key={ref.path} className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3">
              <div className="flex gap-3">
                <img src={convertFileSrc(ref.path)} alt="" className="h-20 w-20 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-white">{ref.name}</p>
                  <p className="mt-1 text-[11px] text-neutral-500">現在: {referenceRoleLabel(ref.role)}</p>
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
  const removeItem = useProjects((s) => s.removeItem);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const opened = openId ? projects.find((p) => p.id === openId) ?? null : null;

  const handleCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    setOpenId(created.id);
    setDraftName("");
  };

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
          className="h-9 rounded-md bg-pink-500 px-4 text-xs font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          ＋ 作成
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
              active={project.id === openId}
              onOpen={() => setOpenId(project.id === openId ? null : project.id)}
              onRename={(name) => renameProject(project.id, name)}
              onRemove={() => {
                if (
                  window.confirm(
                    `プロジェクト「${project.name}」を削除しますか? 中身の画像はライブラリには残ります。`,
                  )
                ) {
                  if (openId === project.id) setOpenId(null);
                  removeProject(project.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {opened && (
        <ProjectDetailPanel
          project={opened}
          onClose={() => setOpenId(null)}
          onRemoveItem={(itemId) => removeItem(opened.id, itemId)}
        />
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
  onRemoveItem,
}: {
  project: Project;
  onClose: () => void;
  onRemoveItem: (itemId: string) => void;
}) {
  const chat = project.planChat ?? [];
  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-[#2a2a2a] bg-[#181818] px-4 py-3">
        <div>
          <h4 className="text-sm font-black text-white">{project.name}</h4>
          <p className="mt-0.5 text-[10px] text-neutral-500">
            企画ログ {chat.length} 通 ・ 画像 {project.items.length} 件 ・ 更新 {relativeTimeJa(project.updatedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-400 hover:text-white"
        >
          閉じる
        </button>
      </div>

      {chat.length > 0 && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wide text-pink-300">
              企画チャット
            </span>
            <span className="text-[10px] text-neutral-500">
              （企画タブで対話したログのスナップショット）
            </span>
          </div>
          <div className="space-y-2">
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
        </div>
      )}

      {project.items.length > 0 ? (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-wide text-pink-300">
              生成画像
            </span>
            <span className="text-[10px] text-neutral-500">
              （採用→生成で自動的にここに入ります）
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {project.items.map((item) => (
              <div
                key={item.id}
                className="group relative overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#101010]"
              >
                <button
                  type="button"
                  onClick={() => useImagePreview.getState().open(item.imagePath)}
                  className="block w-full"
                  title={item.prompt ?? ""}
                >
                  <img
                    src={convertFileSrc(item.imagePath)}
                    alt=""
                    className="aspect-square w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-black/85 text-xs font-black text-white shadow-lg group-hover:flex hover:bg-red-500"
                  title="このプロジェクトから外す"
                >
                  ×
                </button>
                {item.prompt && (
                  <p className="line-clamp-2 px-1.5 py-1 font-mono text-[9px] leading-tight text-neutral-500">
                    {item.prompt}
                  </p>
                )}
              </div>
            ))}
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
  active,
  onOpen,
  onRename,
  onRemove,
}: {
  project: Project;
  active: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const previewItems = project.items.slice(0, 4);
  return (
    <div
      className={`group rounded-xl border bg-[#181818] p-3 transition ${
        active ? "border-pink-400 ring-1 ring-pink-400/40" : "border-[#2a2a2a] hover:border-pink-400/60"
      }`}
    >
      <div className="grid grid-cols-2 gap-1">
        {previewItems.length === 0 ? (
          <div className="col-span-2 flex aspect-[16/9] items-center justify-center rounded-md bg-[linear-gradient(135deg,#242424_0%,#171717_100%)] text-[10px] font-bold uppercase tracking-wide text-neutral-600">
            Empty
          </div>
        ) : (
          previewItems.map((item, index) => (
            <img
              key={item.id}
              src={convertFileSrc(item.imagePath)}
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
          {active ? "閉じる" : "開く"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(project.name);
            setEditing(true);
          }}
          className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[10px] text-neutral-400 hover:text-white"
          title="名前を編集"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="h-7 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[10px] text-neutral-400 hover:text-red-400"
          title="削除"
        >
          ×
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
        <div
          key={project.id}
          className="rounded-xl border border-neutral-200 bg-white p-2"
        >
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
function ChatHistoryWorkspace({
  onOpen,
}: {
  onOpen: (id: string) => Promise<void>;
}) {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const displayedSession = useSessions((s) => s.displayedSession);
  const isFrozen = useSessions((s) => s.isFrozen);
  const renameSession = useSessions((s) => s.rename);
  // 編集中のセッション id + ドラフトタイトル
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

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
      {sessions.length === 0 ? (
        <DarkEmpty
          title="まだチャット履歴がありません"
          description="制作画面で生成すると、ここに最近のチャットが並びます。"
        />
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((session) => {
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
                      <img
                        src={convertFileSrc(session.lastImagePath)}
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
                            (e.nativeEvent as KeyboardEvent).isComposing ||
                            e.keyCode === 229;
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
                      className="opacity-0 transition group-hover:opacity-100 shrink-0 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-medium text-neutral-300 hover:border-pink-400 hover:text-white"
                    >
                      ✎ 名前
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => void onOpen(session.id)}
                      className="shrink-0 text-[11px] font-medium text-neutral-500 hover:text-white"
                    >
                      開く →
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
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
        <p className="text-[11px] text-neutral-500">使う画像を選んで、参照・修正・コピーへ進めます。</p>
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
      push({ kind: "error", text: `画像選択に失敗: ${String(err)}`, ttlMs: 4000 });
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
          <h3 className="mt-2 text-2xl font-black text-neutral-950">
            画像を入れる
          </h3>
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
      <span className={`mt-1 block text-xs leading-relaxed ${active ? "text-neutral-300" : "text-neutral-500"}`}>
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
          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">{batch.prompt || "生成中..."}</p>
        </div>
        <Badge tone="blue">{done}/{batch.count} 完了</Badge>
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
      <img src={convertFileSrc(worker.path)} alt="" className="h-full w-full object-cover" />
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
        <img src={convertFileSrc(item.path)} alt={item.name} className="h-full w-full object-cover" />
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
            onClick={() => addReference({ path: item.path, name: item.name, role: "subject", source: "gallery" })}
            className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            参照
          </Button>
          <Button size="xs" className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white" onClick={() => setText("この画像をベースに、さらに完成度を上げてください。")}>
            修正へ
          </Button>
          <Button size="xs" className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white" onClick={copyPath}>コピー</Button>
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
        <img src={convertFileSrc(item.path)} alt={item.name} className="h-full w-full object-cover" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black text-white" title={item.name}>{item.name}</p>
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
          onClick={() => addReference({ path: item.path, name: item.name, role: "subject", source: "gallery" })}
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
        <Button size="xs" className="border-[#333] bg-[#222] text-neutral-300 hover:border-pink-400 hover:text-white" onClick={copyPath}>
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
            <h3 className="mt-0.5 text-sm font-black text-neutral-950">
              選ぶほど指示が組み上がる
            </h3>
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
            <Button size="xs" onClick={() => setCount(4)}>4案</Button>
            <Button size="xs" onClick={() => setCount(9)}>9カット</Button>
            <Button size="xs" onClick={() => setAspect("9:16" as FrameAspect)}>9:16</Button>
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
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
        制作設定
      </p>
      <h3 className="mt-0.5 text-base font-black text-neutral-950">
        {primaryMode === "video" ? "動画カット" : imageMode === "edit" ? "修正" : imageMode === "layers" ? "レイヤー" : "生成"}
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
                <div key={ref.path} className="rounded-xl border border-neutral-200 bg-neutral-50 p-2">
                  <p className="truncate font-bold text-neutral-950" title={ref.path}>{ref.name}</p>
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
                  useComposer.getState().setText("同じ被写体と世界観を保って、次のストーリーカットを作ってください。");
                }}
              >
                次カットを作る
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  setPrimaryMode("video");
                  setVideoMode("multiAngle");
                  useComposer.getState().setText("位置関係と環境を固定し、カメラだけを動かした別角度を作ってください。");
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
                <div key={layer.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-2">
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
          <p className="truncate" title={selectedPath}>{selectedItem?.name ?? "未選択"}</p>
          <div className="mt-2 grid gap-1.5">
            <Button size="xs" disabled={!selectedItem} onClick={() => useComposer.getState().setText("この画像をさらに高品質に修正してください。")}>修正へ</Button>
            <Button size="xs" disabled={!selectedItem} onClick={() => useComposer.getState().setText("この画像を動画用の次カットにしてください。")}>動画化</Button>
            <Button size="xs" disabled={!selectedItem} onClick={() => useComposer.getState().setText("この画像をレイヤー分けしやすい構成にしてください。")}>レイヤー分け</Button>
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
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-blue-700">パネル</p>
            <h3 className="text-lg font-black text-neutral-950">{drawerTitle(drawer)}</h3>
          </div>
          <Button size="xs" onClick={onClose}>閉じる</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {drawer === "assets" && <AssetsDrawer />}
          {drawer === "references" && <ReferencesDrawer />}
          {drawer === "history" && <ProjectsDrawer />}
          {drawer === "presets" && <PresetsDrawer />}
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
  const items = useImages((s) => s.items.slice(0, 80));
  const addReference = useComposer((s) => s.addReference);
  if (items.length === 0) {
    return <EmptyState title="素材がありません" description="生成またはアップロードするとここに表示されます。" />;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() => addReference({ path: item.path, name: item.name, source: "gallery", role: "subject" })}
          className="overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left hover:border-blue-400"
        >
          <img src={convertFileSrc(item.path)} alt="" className="aspect-square w-full object-cover" />
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
        <div key={ref.path} className="flex gap-2 rounded-2xl border border-neutral-200 bg-white p-2">
          <img src={convertFileSrc(ref.path)} alt="" className="h-14 w-14 rounded-xl object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-neutral-950">{ref.name}</p>
            <p className="mt-1 text-[11px] text-neutral-500">{ref.role ?? "subject"}</p>
          </div>
          <Button size="xs" tone="danger" onClick={() => remove(ref.path)}>外す</Button>
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
              <img
                src={convertFileSrc(session.lastImagePath)}
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
            <p className="mt-0.5 text-[10px] text-neutral-500">{relativeTimeJa(session.lastUsedAt)}</p>
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
          <img src={convertFileSrc(session.lastImagePath)} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-xs font-black text-neutral-500">GG</span>
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

// 既存のライトUI部品は段階移行中のため保持。次の整理フェーズで削除する。
const legacyUiKeepAlive = [HomeScreen, Rail, GuidedCommandDock, InspectorPanel, SideDrawer];
void legacyUiKeepAlive;

export default App;
