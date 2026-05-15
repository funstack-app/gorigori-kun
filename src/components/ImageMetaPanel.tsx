import { useEffect, useState, type KeyboardEvent } from "react";

import {
  images,
  history,
  sessions as sessionsApi,
  type PromptHistoryRow,
  type TurnWithImages,
} from "../lib/ipc";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages } from "../lib/store/images";
import { useToasts } from "../lib/store/toasts";

/**
 * 画像のメタ情報パネル。ImagePreviewModal の下部に表示する。
 *
 * - プロンプト
 * - モデル / effort
 * - 生成日時
 * - 参照画像（あれば）
 * - ファイル名
 *
 * メタ情報の取得手順:
 *  1. history.recent(120) で最近の turn 一覧を取る
 *  2. その中から、対象 imagePath を含む turn を逆引き
 *     （turn ごとに getTurn を呼んで images に該当 path があるか確認）
 *  3. 見つかった turn の prompt / model / effort / refImagePaths を表示
 *
 * ヒットしなかった場合（古すぎる、ライブラリスキャンで拾った浮き画像 等）は
 * 「メタ情報なし」と表示する。
 */
type Meta = {
  turn: TurnWithImages;
  row: PromptHistoryRow;
};

export function ImageMetaPanel({ path }: { path: string }) {
  const item = useImages((s) => s.items.find((it) => it.path === path));
  const pushToast = useToasts((s) => s.push);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<"loading" | "found" | "not-found" | "error">(
    "loading",
  );
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMeta(null);

    (async () => {
      try {
        const rows = await history.recent(120);
        if (cancelled) return;
        // 直近順に turn を当たって、最初に画像 path を含む turn を採用
        for (const row of rows) {
          if (cancelled) return;
          try {
            const turn = await sessionsApi.getTurn(row.id);
            if (cancelled) return;
            if (turn.images.some((img) => img.path === path)) {
              setMeta({ turn, row });
              setStatus("found");
              return;
            }
          } catch {
            // 単発の getTurn 失敗は無視して次へ
          }
        }
        if (!cancelled) setStatus("not-found");
      } catch (err) {
        console.error("ImageMetaPanel history fetch failed", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  const fileName = item?.name ?? path.split(/[\\/]/).pop() ?? "";

  const startRename = () => {
    setDraftName(fileName);
    setRenaming(true);
  };

  const cancelRename = () => {
    setDraftName("");
    setRenaming(false);
  };

  const commitRename = async () => {
    const nextName = draftName.trim();
    if (!nextName) {
      pushToast({
        kind: "error",
        text: "ファイル名を入力してください",
        ttlMs: 5000,
      });
      return;
    }
    if (nextName === fileName) {
      cancelRename();
      return;
    }

    setSavingRename(true);
    try {
      const newPath = await images.rename(path, nextName);
      // ローカル items キャッシュと選択状態を即時更新する。
      // watcher の create/delete イベントが追いついても knownPaths で
      // 重複登録は防がれるが、古い path が残ったまま再 rename するとエラーになるため
      // ここで明示的に同期する。
      useImages.getState().renameLocal(path, newPath);
      // 画像プレビュー側も新 path に切替（古い path を握ったままだと
      // メタパネル再フェッチで「not-found」になる）
      useImagePreview.getState().open(newPath);
      setRenaming(false);
      setDraftName("");
      pushToast({
        kind: "success",
        text: `ファイル名を変更しました: ${newPath.split(/[\\/]/).pop() ?? nextName}`,
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `リネームに失敗: ${String(err)}`,
        ttlMs: 5000,
      });
    } finally {
      setSavingRename(false);
    }
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  return (
    <div className="border-t border-neutral-800 bg-neutral-900/70 px-4 py-3 text-xs text-neutral-300">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
          <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            ファイル名
          </span>
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                autoFocus
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-400"
                disabled={savingRename}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={handleRenameKeyDown}
              />
              <button
                type="button"
                className="rounded border border-neutral-700 px-2 py-1 text-[10px] font-bold text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={savingRename}
                onClick={() => void commitRename()}
              >
                保存
              </button>
              <button
                type="button"
                className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={savingRename}
                onClick={cancelRename}
              >
                キャンセル
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-[11px]">{fileName}</span>
              <button
                type="button"
                className="rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
                onClick={startRename}
              >
                ✎ 編集
              </button>
            </div>
          )}
        </div>

        {status === "loading" && (
          <p className="text-[11px] text-neutral-500">メタ情報を読み込み中...</p>
        )}
        {status === "error" && (
          <p className="text-[11px] text-red-400">メタ情報の取得に失敗しました</p>
        )}
        {status === "not-found" && (
          <p className="text-[11px] text-neutral-500">
            この画像はライブラリスキャンで取り込まれたか、履歴に紐付いていません。
          </p>
        )}
        {status === "found" && meta && <MetaRows meta={meta} />}
      </div>
    </div>
  );
}

function MetaRows({ meta }: { meta: Meta }) {
  const { turn, row } = meta;
  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
        <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
          プロンプト
        </span>
        <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] leading-relaxed text-neutral-200">
          {row.prompt || "(プロンプトなし)"}
        </pre>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
        <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
          モデル / effort
        </span>
        <span className="text-[11px]">
          {/*
            Higgsfield 経路で生成された turn は provider="higgsfield" +
            modelDisplayName ("Seedream V5 Lite" など) を保持している。
            Codex 経路の turn.model (例: "gpt-5.5") はあくまで Codex の制御
            モデル名であって、画像生成のモデル名ではない。
            Higgsfield 経路で turn.model を「実際の生成モデル」として表示すると
            嘘になるので、provider に応じて表示を切り替える。
          */}
          {turn.provider === "higgsfield" && turn.modelDisplayName
            ? `Higgsfield · ${turn.modelDisplayName}`
            : turn.provider === "codex" && turn.modelDisplayName
              ? `Codex · ${turn.modelDisplayName}`
              : (turn.model ?? "（未記録）")}
          {/* effort は Codex 経路のみ意味を持つ */}
          {turn.provider !== "higgsfield" && turn.effort
            ? ` ・ effort: ${turn.effort}`
            : ""}
          <span className="ml-2 text-[10px] text-neutral-500">({turn.kind})</span>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
        <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
          生成日時
        </span>
        <span className="text-[11px]">{new Date(turn.createdAt).toLocaleString("ja-JP")}</span>
      </div>
      {turn.refImagePaths.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
          <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            参照画像
          </span>
          <span className="font-mono text-[10px] text-neutral-400">
            {turn.refImagePaths.length} 件
          </span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
        <span className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
          バッチ枚数
        </span>
        <span className="text-[11px]">{row.count} 枚 (この生成バッチ全体)</span>
      </div>
    </>
  );
}
