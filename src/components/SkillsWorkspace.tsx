import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import { skills as skillsIpc, type InstalledSkill } from "../lib/ipc";
import {
  GORI_SKILLS,
  VISIBLE_GORI_SKILLS,
  type GoriSkill,
} from "../lib/skills/catalog";
import { useSkillMode } from "../lib/store/skillMode";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
import { activateSkill } from "./SkillBadge";
import { SkillDetailModal } from "./SkillDetailModal";
import { SkillIcon } from "./SkillIcon";

export function SkillsWorkspace({ onUseSkill }: { onUseSkill?: () => void }) {
  /** Rust が返したインストール済みスキル (id + 実パス)。 */
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 現在 ON になっているスキル ID を購読し、トグル表示の判定に使う
  const activeSkillId = useSkillMode((s) => s.selectedSkillId);
  const skillEnabled = useSkillMode((s) => s.enabled);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);

  // インストール実体の取得は Rust (skill_list_installed) に一本化する。
  //
  // なぜ (ygn 2026-08-03 STΛCK報告で修正):
  //   フロントは `~/.codex/skills` を前提にパスを組み立てていたが、インポートも
  //   codex 実行系 (app-server / codex exec) の読み先も専用 CODEX_HOME
  //   (%APPDATA%\app.codexframefactory\codex-home\skills 等) であり、両者が
  //   食い違っていた。そのため Windows ではインポート成功トースト直後から
  //   「未検出」になっていた。パス解決を二重実装しない (将来また食い違う)。
  //
  //   併せて、カスタムスキルは従来 **一覧に一度も出なかった** (GORI_SKILLS は
  //   静的配列で imported を立てるコードが存在しなかった)。listInstalled の
  //   結果と組み込み id の差集合をカスタムスキルとして描画する。
  useEffect(() => {
    let cancelled = false;
    skillsIpc
      .listInstalled()
      .then((list) => {
        if (!cancelled) setInstalled(list);
      })
      .catch((err) => {
        // 一覧取得の失敗はトーストを出さない (画面を開くたびに邪魔しない)。
        console.warn("skill_list_installed failed", err);
        if (!cancelled) setInstalled([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const builtinIds = useMemo(() => new Set(GORI_SKILLS.map((s) => s.id)), []);
  /**
   * 組み込みに無い id = ユーザーがインポートしたカスタムスキル。
   *
   * 2026-08-05 STΛCK 実機指示で **一覧に出さない**。`~/.codex/skills/` は
   * 開発用スキル置き場と共用のため、そこに置いた作業用スキル
   * (hatch-pet / migrate-to-codex 等) がそのまま配布版の画面に並んでいた。
   * ユーザーには意味が無く、パスに個人のホームディレクトリまで出る。
   *
   * 読み取り自体は残す (組み込みカードの実パス表示 `installedPathById` が
   * 同じ `installed` を使う)。消したのは表示だけ。
   */
  const customSkills = useMemo<InstalledSkill[]>(() => [], []);
  void builtinIds;
  /** 組み込みカードのパス表示用 (実在するものだけ実パスを出す)。 */
  const installedPathById = useMemo(
    () => new Map(installed.map((s) => [s.id, s.path])),
    [installed],
  );

  const useSkill = (skill: GoriSkill) => {
    activateSkill(skill);
    onUseSkill?.();
  };

  // スキルを「停止する」= 作品モード (default UI) に戻す。
  // STΛCK 指示 (2026-05-20):
  //  - チャット履歴 / 引き継ぎセクションは保持 (planChat.messages や
  //    storyboardRun.chatMessages はクリアしない)
  //  - skillMode を OFF にするだけで skillUiMode は自動的に default に戻る
  //    (skillMode.ts の syncUiMode → exitSkill)
  //  - workspace.purpose も "artwork" に戻して旧「ストーリーカット構築」UI が
  //    残らないようにする (activateSkill が videoStory に変えていたため)
  const stopSkill = (skill: GoriSkill) => {
    setSkillEnabled(false);
    setSelectedSkillId(null);
    useWorkspace.getState().setPurpose("artwork");
    useToasts.getState().push({
      kind: "info",
      text: `${skill.name} を停止しました。作品モードに戻ります。`,
      ttlMs: 3000,
    });
  };

  const toast = useToasts.getState();

  /**
   * SKILL.md ファイルをユーザーに選んでもらい、専用 CODEX_HOME の skills 配下に
   * 複製する。frontmatter の name: フィールドから保存先ディレクトリ名を決める。
   */
  const handleImport = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Skill (Markdown / zip)",
            extensions: ["md", "markdown", "zip"],
          },
        ],
      });
      if (!selected) return; // キャンセル
      const path = Array.isArray(selected) ? selected[0] : selected;
      // 拡張子で単一 Markdown / zip 一括インポートを呼び分ける。
      const isZip = path.toLowerCase().endsWith(".zip");
      const result = isZip
        ? await skillsIpc.importZip(path)
        : await skillsIpc.importMarkdown(path);
      toast.push({
        kind: "success",
        text: isZip
          ? `スキル「${result.name}」をインポートしました (${result.fileCount} ファイル)`
          : `スキル「${result.name}」をインポートしました`,
        ttlMs: 4000,
      });
      // 再読み込み (実在チェックを更新)
      setRefreshTick((n) => n + 1);
    } catch (err) {
      toast.push({
        kind: "error",
        text: `インポート失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    }
  };

  /** カスタムスキルを .gori-skill.zip として書き出す。 */
  const handleExport = async (skillId: string) => {
    try {
      const dest = await saveFileDialog({
        defaultPath: `${skillId}.gori-skill.zip`,
        filters: [{ name: "Skill zip", extensions: ["zip"] }],
      });
      if (!dest) return; // キャンセル
      await skillsIpc.exportZip(skillId, dest);
      toast.push({
        kind: "success",
        text: `スキル「${skillId}」を書き出しました`,
        ttlMs: 4000,
      });
    } catch (err) {
      toast.push({
        kind: "error",
        text: `書き出しに失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    }
  };

  const detailSkill = detailSkillId
    ? {
        id: detailSkillId,
        title: GORI_SKILLS.find((s) => s.id === detailSkillId)?.name ?? detailSkillId,
        description:
          GORI_SKILLS.find((s) => s.id === detailSkillId)?.description ??
          "インポートしたカスタムスキルです。生成AIがこの手順書を参照できます。",
        installedPath: installedPathById.get(detailSkillId) ?? null,
      }
    : null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      {/*
        ヘッダー右側にスキル import / export ツールバーを置く。
        外側 (App.tsx の BoardHeader) が「スキル」タイトルを出すので
        ここではタイトル文言は出さない。
      */}
      <div className="flex items-center justify-end gap-2 px-5 pt-4">
        <button
          type="button"
          onClick={handleImport}
          className="flex items-center gap-1.5 rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-pink-400 hover:text-white"
          title="SKILL.md ファイルを取り込んで、このアプリで使えるようにします"
        >
          <span>スキルをインポート</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {VISIBLE_GORI_SKILLS.map((skill) => {
            const isComingSoon = skill.comingSoon === true;
            const isLocked = !skill.availableInApp;
            const isActive = skillEnabled && activeSkillId === skill.id;
            return (
              <article
                key={skill.id}
                className={`flex min-h-[260px] flex-col rounded-2xl border bg-[#181818] p-4 shadow-sm transition ${
                  isLocked
                    ? "border-[#222] opacity-60"
                    : isActive
                      ? "border-pink-500 ring-1 ring-pink-500/40"
                      : "border-[#2a2a2a] hover:border-pink-400"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#101010] text-pink-300">
                    <SkillIcon id={skill.id} className="h-6 w-6" />
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                      isActive
                        ? "bg-pink-500/20 text-pink-100"
                        : isComingSoon
                          ? "bg-purple-500/15 text-purple-200"
                          : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {isActive ? "使用中" : isComingSoon ? "近日公開" : "接続済み"}
                  </span>
                </div>

                <h4 className="mt-4 text-sm font-black text-white">{skill.name}</h4>
                <p className="mt-2 min-h-[54px] text-xs leading-relaxed text-neutral-400">
                  {skill.description}
                </p>
                {/* 実パスの表示は STΛCK 指示 (2026-08-25) で撤去。ユーザーに
                    ローカルの絶対パスを見せる意味がなく、視覚ノイズになるため。 */}

                <div className="mt-auto space-y-2 pt-4">
                  <button
                    type="button"
                    disabled={isLocked}
                    onClick={() => {
                      if (isLocked) return;
                      if (isActive) {
                        stopSkill(skill);
                      } else {
                        useSkill(skill);
                      }
                    }}
                    className={`w-full rounded-lg px-3 py-2 text-xs font-black transition ${
                      isLocked
                        ? "cursor-not-allowed bg-neutral-700 text-neutral-400"
                        : isActive
                          ? "border border-pink-400 bg-pink-500/15 text-pink-100 hover:bg-pink-500/25"
                          : "bg-pink-500 text-white hover:bg-pink-400"
                    }`}
                    aria-disabled={isLocked}
                    aria-pressed={isActive}
                    title={
                      isLocked
                        ? "近日公開予定"
                        : isActive
                          ? "停止して作品モードに戻る"
                          : undefined
                    }
                  >
                    {isLocked
                      ? "近日公開"
                      : isActive
                        ? "停止する (作品モードへ)"
                        : "使う"}
                  </button>
                  {/* 「詳細を見る」「エクスポート」は STΛCK 指示 (2026-06-06) で撤去。
                      スキルカードは「使う」ボタンと一言説明だけに簡素化する。 */}
                  <p className="text-[10px] leading-relaxed text-neutral-500">
                    {skill.launchHint}
                  </p>
                </div>
              </article>
            );
          })}

          {/*
            ygn (2026-08-03): インポートしたカスタムスキル。組み込みカードの後に並べる。
            「使う」は出さない (カスタムスキルにアプリ内実行UIが無いため)。
          */}
          {customSkills.map((custom) => (
            <article
              key={custom.id}
              className="flex min-h-[260px] flex-col rounded-2xl border border-[#2a2a2a] bg-[#181818] p-4 shadow-sm transition hover:border-pink-400"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#101010] text-pink-300">
                  <SkillIcon id={custom.id} className="h-6 w-6" />
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-emerald-200">
                  インポート済み
                </span>
              </div>

              <h4 className="mt-4 text-sm font-black text-white">{custom.id}</h4>
              <p className="mt-2 min-h-[54px] text-xs leading-relaxed text-neutral-400">
                インポートしたカスタムスキルです。生成AIがこの手順書を参照できます。
              </p>
              <p className="mt-3 truncate rounded-lg border border-[#242424] bg-[#101010] px-2 py-1.5 font-mono text-[10px] text-neutral-500">
                {custom.path}
              </p>

              <div className="mt-auto space-y-2 pt-4">
                <button
                  type="button"
                  onClick={() => setDetailSkillId(custom.id)}
                  className="w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-2 text-xs font-black text-neutral-200 hover:border-pink-400 hover:text-white"
                >
                  詳細を見る
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport(custom.id)}
                  className="w-full rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-2 text-xs font-black text-neutral-200 hover:border-pink-400 hover:text-white"
                >
                  書き出す
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      {detailSkill && (
        <SkillDetailModal
          skillId={detailSkill.id}
          title={detailSkill.title}
          description={detailSkill.description}
          installedPath={detailSkill.installedPath}
          onClose={() => setDetailSkillId(null)}
        />
      )}
    </section>
  );
}
