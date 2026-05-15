import { useEffect, useState } from "react";

const STORAGE_KEY = "gori_gori_kun.first_run_storage_notice_v1";

/**
 * 初回起動時に1度だけ表示するストレージ運用説明ダイアログ。
 *
 * - ユーザーの作品データ(画像/プリセット/スキル)は絶対に自動削除しない
 * - Codex の作業履歴だけ3日で自動整理する
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
        <h2 className="text-lg font-black text-pink-300">
          GORI GORI KUN へようこそ
        </h2>
        <p className="mt-3 text-xs text-neutral-400">
          このアプリは以下のルールで動きます:
        </p>

        <div className="mt-4 space-y-3">
          <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <h3 className="text-xs font-black text-emerald-300">
              🔒 あなたの大切なデータは絶対に自動削除しません
            </h3>
            <ul className="mt-2 space-y-0.5 text-[11px] text-neutral-300">
              <li>・生成した画像</li>
              <li>・登録したプリセット</li>
              <li>・作成したスキル</li>
            </ul>
          </section>

          <section className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
            <h3 className="text-xs font-black text-sky-300">
              🔄 アプリ動作上の一時データだけ、裏で自動整理します
            </h3>
            <ul className="mt-2 space-y-0.5 text-[11px] text-neutral-300">
              <li>・Codex の作業履歴(3日以上前)</li>
              <li>・古いシステムログ</li>
            </ul>
            <p className="mt-2 text-[10px] text-neutral-400">
              ※ そうしないとお使いの PC が重くなってしまうためです
            </p>
          </section>

          <p className="text-[11px] text-neutral-500">
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
