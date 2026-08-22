import { useEffect, useRef } from "react";
import { useSkillVisible } from "./SkillWorkspaceRouter";
import { useWorkspace, type WorkspaceTab } from "../lib/store/workspace";
import { useSkillMode } from "../lib/store/skillMode";
import { getGoriSkill } from "../lib/skills/catalog";
import { useToasts } from "../lib/store/toasts";

type Tab = {
  id: WorkspaceTab;
  label: string;
  /** 「近日公開」ラベル + 触れない状態 */
  comingSoon?: boolean;
  disabled?: boolean;
};

const TABS: Tab[] = [
  { id: "plan", label: "企画" },
  { id: "generate", label: "画像生成" },
  { id: "video", label: "動画生成" },
  // 編集タブは正式開放 (STΛCK 決定 2026-07-02、正式版スコープ)。
  { id: "edit", label: "編集" },
];

/** 触れる (=disabled でない) タブだけを順序つきで取り出す。 */
const NAVIGABLE_TABS: WorkspaceTab[] = TABS.filter((t) => !t.disabled).map((t) => t.id);

export function WorkspaceTabs() {
  const activeTab = useWorkspace((s) => s.activeTab);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);

  /*
   * 実行中スキルの表示と停止導線 (STΛCK指示 2026-07-25)。
   *
   * なぜここに置くか: 従来は停止ボタンがスキル一覧のカード内にしかなく、
   * スキルを起動すると画面がスキル画面へ切り替わるため、止めるには
   * 「スキル一覧まで戻る」必要があった。それが分かりにくく、STΛCK が
   * 「解除ボタンが出ない」と踏んだ (実際には一覧に戻れば出る)。
   * タブ列は常に見える場所なので、ここに出せば迷わない。
   */
  const skillEnabled = useSkillMode((s) => s.enabled);
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);
  const activeSkill = skillEnabled && selectedSkillId ? getGoriSkill(selectedSkillId) : undefined;

  const stopActiveSkill = () => {
    if (!activeSkill) return;
    setSkillEnabled(false);
    setSelectedSkillId(null);
    useWorkspace.getState().setPurpose("artwork");
    useToasts.getState().push({
      kind: "info",
      text: `${activeSkill.name} を停止しました。作品モードに戻ります。`,
      ttlMs: 3000,
    });
  };

  /**
   * FB#15: タブのスワイプ / トラックパッドジェスチャ移動 (最小実装)。
   *
   * - 横方向のホイール / 2 本指トラックパッドスワイプ (deltaX) で
   *   企画 ↔ 画像生成 ↔ 動画生成 を行き来する。
   * - 縦スクロールを誤検知しないよう、横成分が縦成分を明確に上回る時だけ反応。
   * - 連続したスワイプで一気に飛ばないよう、発火後はクールダウンを置く。
   * - disabled タブ (編集) はスキップ。
   *
   * window 全体に listen するとモーダルや左右パネルのスクロールと干渉するため、
   * 反応対象は「制作ワークスペース本体」に限定する。GenerationWorkspace の
   * 直近の親 (`<section>` 相当) を closest で辿って、その中での横スワイプだけ拾う。
   */
  const cooldownRef = useRef(0);
  const stripRef = useRef<HTMLDivElement | null>(null);

  /**
   * FB#15: スワイプ反応領域 (制作ワークスペース本体) に目印を付ける。
   * GenerationWorkspace 側は別担当のため編集せず、ここから DOM を辿って
   * 最も近い <section>（ワークスペースのルート）に data 属性を立てる。
   * 見つからなければタブ列自身を対象にフォールバックする。
   */
  useEffect(() => {
    const root =
      stripRef.current?.closest("section") ?? stripRef.current?.parentElement ?? null;
    if (root) {
      root.setAttribute("data-workspace-swipe", "");
      return () => root.removeAttribute("data-workspace-swipe");
    }
    return undefined;
  }, []);

  /*
   * 非表示中はホイール監視を張らない (Sol 評価 blocking#2 / 2026-08-04)。
   *
   * WorkspaceTabs は各スキル画面が1つずつ描画する (13箇所)。S2 の mount-pool 化で
   * 訪問済みスキルが unmount されなくなったため、**訪問数と同じ数のインスタンスが
   * 同時に window の wheel を監視する**状態になっていた。1回の横スワイプで
   * cycle() が同時に N 回走り、タブが一気に N 段飛ぶ。
   *
   * cooldownRef はインスタンスごとに別なので多重発火を止められない (各自が
   * 「自分は初回」と判断する)。可視インスタンスだけが監視する形にすれば、
   * 常に1つしか登録されないので1スワイプ=1段に戻る。
   */
  const visible = useSkillVisible();
  useEffect(() => {
    if (!visible) return;
    const cycle = (dir: 1 | -1) => {
      const idx = NAVIGABLE_TABS.indexOf(useWorkspace.getState().activeTab);
      // 現在が disabled タブ等で見つからない場合は先頭にフォールバック。
      const base = idx < 0 ? 0 : idx;
      const nextIdx = base + dir;
      if (nextIdx < 0 || nextIdx >= NAVIGABLE_TABS.length) return; // 端ではループしない
      setActiveTab(NAVIGABLE_TABS[nextIdx]);
    };

    const onWheel = (event: WheelEvent) => {
      // 制作ワークスペース内のジェスチャだけを対象にする。
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.("[data-workspace-swipe]")) return;
      const { deltaX, deltaY } = event;
      // 横移動が縦移動より明確に大きい時だけタブ移動とみなす。
      if (Math.abs(deltaX) < 30 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;
      const now = Date.now();
      if (now < cooldownRef.current) return;
      cooldownRef.current = now + 450;
      cycle(deltaX > 0 ? 1 : -1);
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [visible, setActiveTab]);

  return (
    <div className="flex items-center gap-2">
    <div
      ref={stripRef}
      data-tour="workspace-tabs"
      className="grid w-full grid-cols-4 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] p-1 sm:w-[420px]"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const isDisabled = tab.disabled;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              if (isDisabled) return;
              setActiveTab(tab.id);
            }}
            disabled={isDisabled}
            aria-pressed={isActive}
            aria-disabled={isDisabled}
            title={isDisabled ? "近日公開予定" : undefined}
            className={`relative h-9 rounded-md text-sm font-black transition ${
              isDisabled
                ? "cursor-not-allowed text-neutral-700"
                : isActive
                  ? "bg-pink-500 text-white"
                  : "text-neutral-500 hover:bg-[#1f1f1f] hover:text-white"
            }`}
          >
            <span className="align-middle">{tab.label}</span>
            {tab.comingSoon && (
              <span
                className={`ml-1.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide align-middle ${
                  isDisabled
                    ? "bg-neutral-800 text-neutral-500"
                    : "bg-purple-500/20 text-purple-200"
                }`}
              >
                近日公開
              </span>
            )}
          </button>
        );
      })}
    </div>

      {/* 実行中スキル: 名前と停止ボタンを常に見える場所に出す */}
      {activeSkill && (
        <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-pink-500/40 bg-pink-500/10 pl-2.5 pr-1 py-1">
          <span className="text-[11px] font-black text-pink-100">{activeSkill.shortName}</span>
          <button
            type="button"
            onClick={stopActiveSkill}
            title={`${activeSkill.name} を停止して作品モードに戻る`}
            className="flex h-6 w-6 items-center justify-center rounded text-pink-200 transition hover:bg-pink-500/25 hover:text-white"
            aria-label={`${activeSkill.name} を停止`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
