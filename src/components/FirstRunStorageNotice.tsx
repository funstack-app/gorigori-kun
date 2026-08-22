import { useEffect, useState } from "react";

const STORAGE_KEY = "gori_gori_kun.first_run_storage_notice_v1";

/**
 * フラットラインアイコン (STΛCK 指示 2026-07-25: 絵文字を全廃し SVG へ)。
 * SkillIcon.tsx と同じ流儀: 24x24 viewBox / stroke=currentColor。
 */
function LockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function RecycleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M20 12a8 8 0 0 1-13.7 5.6" />
      <path d="M4 12a8 8 0 0 1 13.7-5.6" />
      <path d="M17.7 3.4v3.4h-3.4" />
      <path d="M6.3 20.6v-3.4h3.4" />
    </svg>
  );
}

function DotMark() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden
      className="mt-[5px] shrink-0 text-neutral-600"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * 初回起動時に1度だけ表示するストレージ運用説明ダイアログ。
 *
 * - ユーザーの作品データ(画像/プリセット/スキル)は絶対に自動削除しない
 * - Codex の作業履歴だけ24時間で自動整理する
 *
 * 「わかった」を押した時点で LocalStorage にフラグを保存、以降表示しない。
 */
export function FirstRunStorageNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const seen = window.localStorage.getItem(STORAGE_KEY);
      if (!seen) {
        setVisible(true);
      }
    } catch {
      // localStorage 利用不可なら表示しない
    }
  }, []);

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // ignore
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="mx-4 max-w-md rounded-2xl border border-[#343434] bg-[#1a1a1a] p-6 shadow-2xl">
        <h2 className="text-[19px] font-black tracking-tight text-pink-300">
          GORI GORI KUN へようこそ
        </h2>
        <p className="mt-2 border-b border-[#2f2f2f] pb-3 text-[11px] text-neutral-400">
          このアプリは以下のルールで動きます
        </p>

        <div className="mt-4 space-y-3">
          <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <h3 className="flex items-center gap-2 text-[13px] font-black text-emerald-300">
              <LockIcon />
              <span>大切なデータは自動削除しません</span>
            </h3>
            <ul className="mt-2.5 space-y-1 border-t border-emerald-500/15 pt-2.5 text-[11px] text-neutral-300">
              <li className="flex gap-1.5">
                <DotMark />
                <span>生成した画像</span>
              </li>
              <li className="flex gap-1.5">
                <DotMark />
                <span>登録したプリセット</span>
              </li>
              <li className="flex gap-1.5">
                <DotMark />
                <span>作成したスキル</span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
            <h3 className="flex items-center gap-2 text-[13px] font-black text-sky-300">
              <RecycleIcon />
              <span>一時データだけ裏で自動整理します</span>
            </h3>
            <ul className="mt-2.5 space-y-1 border-t border-sky-500/15 pt-2.5 text-[11px] text-neutral-300">
              <li className="flex gap-1.5">
                <DotMark />
                <span>Codex の作業履歴(24時間以上前)</span>
              </li>
              <li className="flex gap-1.5">
                <DotMark />
                <span>古いシステムログ</span>
              </li>
            </ul>
            <p className="mt-2 text-[10px] text-neutral-500">
              ※ そうしないとお使いの PC が重くなってしまうためです
            </p>
          </section>

          <p className="text-[10px] text-neutral-500">
            設定 →「保存先」タブでいつでも詳細確認・無効化できます
          </p>
        </div>

        <button
          type="button"
          onClick={dismiss}
          className="mt-5 w-full rounded-lg bg-pink-500 px-4 py-3 text-sm font-black text-white shadow hover:bg-pink-600"
        >
          わかりました - 始める
        </button>
      </div>
    </div>
  );
}
