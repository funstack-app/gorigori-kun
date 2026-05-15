import { useState } from "react";
import { useAuth } from "../lib/store/auth";

type Tab = "chatgpt" | "apiKey";

export function LoginPanel() {
  const [tab, setTab] = useState<Tab>("chatgpt");
  const { loginWithApiKey, loginWithChatGPT, loginInProgress, error } = useAuth();
  const [apiKey, setApiKey] = useState("");

  return (
    <div className="mx-auto w-full max-w-md rounded-md border border-neutral-200 bg-white p-6 shadow-xl">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-950 text-xs font-black text-lime-300">
          GG
        </div>
        <div>
          <h2 className="text-lg font-semibold text-neutral-950">GORI GORI KUN</h2>
          <p className="text-xs text-neutral-500">Codex 認証</p>
        </div>
      </div>
      <p className="mb-4 text-xs text-neutral-600">
        ChatGPT サブスクリプション、または OpenAI API キーで認証します。
      </p>

      <div className="mb-4 flex rounded-md border border-neutral-200 bg-stone-100 p-1 text-xs">
        <button
          className={`flex-1 rounded-md px-2 py-1.5 transition ${
            tab === "chatgpt"
              ? "bg-white text-neutral-950 shadow-sm"
              : "text-neutral-500 hover:text-neutral-950"
          }`}
          onClick={() => setTab("chatgpt")}
        >
          ChatGPT で続ける
        </button>
        <button
          className={`flex-1 rounded-md px-2 py-1.5 transition ${
            tab === "apiKey"
              ? "bg-white text-neutral-950 shadow-sm"
              : "text-neutral-500 hover:text-neutral-950"
          }`}
          onClick={() => setTab("apiKey")}
        >
          API キーを使う
        </button>
      </div>

      {tab === "chatgpt" ? (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-neutral-600">
            ボタンを押すとブラウザが開き、ChatGPT へのサインインが始まります。
            完了すると自動でこの画面が更新されます。
          </p>
          <button
            disabled={loginInProgress !== "none"}
            onClick={() => {
              loginWithChatGPT().catch(() => {});
            }}
            className="w-full rounded-md bg-neutral-950 px-3 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {loginInProgress === "chatgpt" ? "ブラウザでサインインを完了..." : "ブラウザを開いて認証"}
          </button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim().length === 0) return;
            loginWithApiKey(apiKey.trim()).catch(() => {});
          }}
        >
          <label className="block text-xs text-neutral-600">
            <span className="flex items-center justify-between">
              <span>OpenAI API キー</span>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-lime-700 hover:text-lime-800"
              >
                キーを取得 →
              </a>
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs text-neutral-950 outline-none focus:border-lime-500 focus:ring-2 focus:ring-lime-200"
            />
          </label>
          <button
            type="submit"
            disabled={loginInProgress !== "none" || apiKey.trim().length === 0}
            className="w-full rounded-md bg-neutral-950 px-3 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {loginInProgress === "apiKey" ? "ログイン中..." : "ログイン"}
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
