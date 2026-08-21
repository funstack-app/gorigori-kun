import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { UiMode } from "../lib/store/skillUiMode";
import { useSkillUiMode } from "../lib/store/skillUiMode";
import { useWorkspace } from "../lib/store/workspace";
import { ActiveProjectSelector } from "./ActiveProjectSelector";
import { EditWorkspace } from "./EditWorkspace";
import { GenerationWorkspace, Timeline } from "./GenerationWorkspace";
import { PlanWorkspace } from "./PlanWorkspace";
import { VideoGenerationWorkspace } from "./VideoGenerationWorkspace";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { StoryboardWorkspace } from "./skills/storyboard/StoryboardWorkspace";
import { MultiAngleWorkspace } from "./skills/multiAngle/MultiAngleWorkspace";
import { CharacterRegisterWorkspace } from "./skills/character/CharacterRegisterWorkspace";
import { ExpressionSetWorkspace } from "./skills/expressionSet/ExpressionSetWorkspace";
import { SceneRecreateWorkspace } from "./skills/sceneRecreate/SceneRecreateWorkspace";
import { ComicWorkspace } from "./skills/comic/ComicWorkspace";
import { RedlineWorkspace } from "./skills/redline/RedlineWorkspace";
import { RegulationCheckWorkspace } from "./skills/regulationCheck/RegulationCheckWorkspace";
import { ProductSetWorkspace } from "./skills/productSet/ProductSetWorkspace";
import { StickerWorkspace } from "./skills/sticker/StickerWorkspace";
import { FilmWorkspace } from "./skills/film/FilmWorkspace";

// three.js を含むためメインバンドルから分離(スキルに入った時だけロード)
const Scene3dWorkspace = lazy(() =>
  import("./skills/scene3d/Scene3dWorkspace").then((m) => ({
    default: m.Scene3dWorkspace,
  })),
);

/**
 * このスキル Workspace が今画面に見えているか。
 *
 * S2 の mount-pool 化 (設計書 §2 S2) で、非アクティブなスキルも unmount されず
 * `display:none` で残り続けるようになった。裏に回った Workspace が RAF 描画ループや
 * ポーリングを回し続けると無駄なので、重い処理を持つ Workspace はこの Context を
 * 購読して自分で停止する (例: scene3d の three.js 描画ループ)。
 *
 * 「見えているか」は 3 段の AND (Sol 評価 2周目 / 2026-08-04):
 *   1. そのスキルが今の activeUiMode か (mount-pool のスロット選択)
 *   2. 専用スキル画面が乗る「生成」タブを開いているか
 *   3. drawer (ライブラリ/設定/プロジェクト等) が被さっていないか
 * 3 を入れないと、ライブラリを開いている間も 3D の Space / 矢印 / Cmd+Z が
 * 見えない画面へ届く。キー/ホイールゲート・RAF 停止・enterMode 発火の
 * 全消費先が同じ 1 つの値を見るので、ここに足せば一貫して塞がる。
 * drawer を閉じれば visible=true へ戻り、作業は mount-pool のまま保持される。
 *
 * default (Context 無し) は true。作品モードや Router 外で使っても壊れないため。
 */
const SkillVisibilityContext = createContext<boolean>(true);

/** 自分のスキル Workspace が今表示されているかを返す。裏にいる間は false。 */
export function useSkillVisible(): boolean {
  return useContext(SkillVisibilityContext);
}

/**
 * Skill UI Router
 *
 * useSkillUiMode.activeUiMode を見て、適切な Workspace を表示する。
 *
 * 設計方針 (Codex クロスレビュー 2026-05-19):
 *   - default 時は既存の GenerationWorkspace をそのまま使う
 *     → α版の作品モード機能を完全保護
 *   - storyboard, multiAngle は β版で順次実装
 *     → 当面は default にフォールバック
 *
 * mount-pool 化 (2026-08-04 S2 / bd 2ak):
 *   一度マウントしたスキル Workspace はセッション中 unmount しない。非アクティブな
 *   ものは `display:none` で隠すだけにする。これで「漫画で構成を確定 → キャラ登録へ
 *   切替 → 漫画へ戻る」で漫画の useState (phase / あらすじ / storyPages / pageResults)
 *   が生き残り、生成司令塔クロージャの setState も no-op にならない。
 *   スキル内タブ (生成/企画/動画/編集) の keep-alive と同じパターンで、実績のある機構。
 *
 *   保持規則は「一度マウントしたら保持」の一択 (設計書 論点1)。dirty 判定での選別は
 *   しない。決定論的で初期化バグの再発リスクが最小になるため。ゼロスタートが要る場面は
 *   各スキルの明示操作 (「新規開始」/ Phase レールで input へ戻る) に委ねる。
 *
 * 新しいスキル専用UIを追加する手順:
 *   1. src/components/skills/<モード名>/Workspace.tsx を新規作成
 *   2. ここに import + renderSkillWorkspace の case 追加
 *   3. lib/store/skillUiMode.ts の SKILL_UI_MODE_MAP に登録
 *
 * 既存の GenerationWorkspace は触らない。スキル専用UIは別ファイル/別ディレクトリ。
 */
export function SkillWorkspaceRouter({
  /**
   * drawer (ライブラリ/設定等) がスキル画面に被さっているか。
   * App.tsx の `drawer !== null` をそのまま渡す。App 側は keep-alive のため
   * display:none で隠すだけなので、隠れていることをここへ伝えないと
   * 「見えないのに visible=true」になる (Sol 評価 2周目 blocking#1)。
   */
  hiddenByDrawer = false,
}: {
  hiddenByDrawer?: boolean;
} = {}) {
  const activeUiMode = useSkillUiMode((s) => s.activeUiMode);
  const activeTab = useWorkspace((s) => s.activeTab);

  // 一度でも表示した UiMode を覚えておく (mount-pool)。ここに入った Workspace は
  // 非アクティブになっても unmount せず display:none で保持する。
  const [mountedModes, setMountedModes] = useState<UiMode[]>(() => [
    activeUiMode,
  ]);
  useEffect(() => {
    setMountedModes((prev) =>
      prev.includes(activeUiMode) ? prev : [...prev, activeUiMode],
    );
  }, [activeUiMode]);

  // activeUiMode が pool に入るのは上の effect (コミット後) なので、切替直後の
  // 1レンダーだけ pool に載っていない。そのフレームで「どれも表示されない」空画面が
  // 出ないように、描画対象は pool ∪ {activeUiMode} で組む。
  const modesToRender = mountedModes.includes(activeUiMode)
    ? mountedModes
    : [...mountedModes, activeUiMode];

  // default (作品モード)、storyboard、film は自前でタブ構造を持つため、
  // 共通のスキル用タブ枠 (企画/動画/編集) を被せない。従来の早期 return と同じ扱い。
  const usesSharedTabs =
    activeUiMode !== "default" &&
    activeUiMode !== "storyboard" &&
    activeUiMode !== "film";

  return (
    <>
      {modesToRender.map((mode) => {
        // 「画面に見えているか」は 3 段で決まる (Sol 評価 blocking#1/#2 / 2026-08-04、
        // 3 は 2周目で追加)。
        //   1. そのスキルが今の activeUiMode か (mount-pool のスロット選択)
        //   2. 専用スキル画面は「生成」タブの中だけに描かれるので、企画/動画/編集
        //      タブを開いている間は display:none で隠れている
        //   3. drawer (ライブラリ等) が被さっていれば、どのタブであれ見えていない
        // 2 を Context に含めないと、企画タブを開いている間にスキル側の
        // WorkspaceTabs (隠れている) と共通枠の WorkspaceTabs (見えている) の
        // 両方が可視扱いになり、ホイール監視が二重に張られる。
        // 3 を含めないと、ライブラリを開いている間も 3D のキー監視が生き残る。
        const isActiveMode = mode === activeUiMode;
        const rendersOutsideGenerateTab =
          mode === "default" || mode === "storyboard" || mode === "film";
        const visible =
          !hiddenByDrawer &&
          isActiveMode &&
          (rendersOutsideGenerateTab || activeTab === "generate");
        return (
          <KeepAlive key={mode} visible={visible} mounted={isActiveMode}>
            {mode === "default" ? (
              <GenerationWorkspace />
            ) : mode === "storyboard" ? (
              <StoryboardWorkspace />
            ) : mode === "film" ? (
              <FilmWorkspace />
            ) : (
              <div
                style={{ display: activeTab === "generate" ? "contents" : "none" }}
              >
                {renderSkillWorkspace(mode)}
              </div>
            )}
          </KeepAlive>
        );
      })}

      {/* 企画/動画/編集タブは全スキル共通の1インスタンス。スキルごとに複製しない。 */}
      {usesSharedTabs && activeTab !== "generate" && (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
          <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
            <div className="flex items-center gap-3">
              <WorkspaceTabs />
              <ActiveProjectSelector />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
            {activeTab === "plan" && <PlanWorkspace />}
            {activeTab === "video" && (
              <VideoGenerationWorkspace timeline={<Timeline />} />
            )}
            {activeTab === "edit" && <EditWorkspace />}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * mount-pool の1スロット。非表示中は display:none で隠すだけで unmount しない。
 * 子には SkillVisibilityContext で可視状態を伝える。
 *
 * `mounted` と `visible` を分けている理由 (2026-08-04):
 *   mounted = このスキルが activeUiMode か。スロットの表示/非表示 (display) を決める。
 *   visible = 実際に目に映っているか。mounted に加えて「生成タブを開いているか」まで
 *             見る。企画/動画/編集タブへ切り替えると、スキル画面は共通枠に隠れるので
 *             mounted のまま visible=false になる。
 *   ここを1つの値にまとめると、タブ切替のたびにスロットごと display:none になって
 *   共通枠(企画/動画/編集)が出せなくなるか、逆に隠れた画面が可視扱いになって
 *   window リスナーが二重に張られるかのどちらかになる。
 */
function KeepAlive({
  visible,
  mounted,
  children,
}: {
  visible: boolean;
  mounted: boolean;
  children: ReactNode;
}) {
  // 一度も表示されていないスロットは中身をレンダーしない (先読みマウントの防止)。
  // pool に入る = 一度は mounted になった、なので実際には初回から true になる。
  const hasBeenMounted = useRef(mounted);
  if (mounted) hasBeenMounted.current = true;
  if (!hasBeenMounted.current) return null;

  return (
    <SkillVisibilityContext.Provider value={visible}>
      <div style={{ display: mounted ? "contents" : "none" }}>{children}</div>
    </SkillVisibilityContext.Provider>
  );
}

function renderSkillWorkspace(mode: UiMode): ReactNode {
  switch (mode) {
    case "multiAngle":
      return <MultiAngleWorkspace />;
    case "characterRegister":
      return <CharacterRegisterWorkspace />;
    case "expressionSet":
      return <ExpressionSetWorkspace />;
    case "sceneRecreate":
      return <SceneRecreateWorkspace />;
    case "comic":
      return <ComicWorkspace />;
    case "redline":
      return <RedlineWorkspace />;
    case "regulationCheck":
      return <RegulationCheckWorkspace />;
    case "productSet":
      return <ProductSetWorkspace />;
    case "sticker":
      return <StickerWorkspace />;
    case "scene3d":
      return (
        <Suspense
          fallback={
            <section className="flex min-h-0 flex-1 items-center justify-center bg-[#121212] text-sm text-neutral-500">
              3Dシーンを準備中…
            </section>
          }
        >
          <Scene3dWorkspace />
        </Suspense>
      );
    default:
      return null;
  }
}
