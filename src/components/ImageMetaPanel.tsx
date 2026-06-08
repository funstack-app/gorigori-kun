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
    /*
      STΛCK 指示 (2026-05-19): Magnific 風プレビュー右ペイン (360px) で
      使いやすいよう、全項目を「ラベル上・値下」の縦並びに変更。
      旧版の sm:grid-cols-[120px_1fr] だと値エリアが ~200px しかなく窮屈だった。
      情報メインなのでファイル名の編集ボタンも整理して目立たせない。

      さらに STΛCK 指示 (2026-05-19 2回目): プロンプト欄を残り高さで拡張するため
      ImageMetaPanel 自身も `flex h-full flex-col` で縦方向ストレッチ。
      順序は ファイル名 → モデルカード → プロンプト (flex-1) で、プロンプトが
      アクションボタン (border-t) の直前まで縦に広がる。
    */
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs text-neutral-300">
      <div className="flex flex-col gap-1.5">
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
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{fileName}</span>
            <button
              type="button"
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 hover:border-pink-400 hover:text-pink-300"
              onClick={startRename}
              title="ファイル名を編集"
            >
              編集
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
  );
}

function MetaRows({ meta }: { meta: Meta }) {
  const { turn, row } = meta;
  return (
    /*
      STΛCK 指示 (2026-05-19):
      順序は「モデルカード → プロンプト」。
      プロンプト欄は flex-1 + min-h-0 でこの行から下を全部使い、border-t
      (次のアクションエリア) の直前まで縦に拡張。長いプロンプトは内部スクロール。
    */
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* モデル / 生成日時 / 枚数 / 参照画像 を 1 まとまりカードで縦並び (上に固定) */}
      <div className="shrink-0 rounded-md border border-neutral-800 bg-neutral-950 p-3 text-[11px]">
        <dl className="grid grid-cols-[80px_1fr] gap-y-1.5 gap-x-3">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            モデル
          </dt>
          <dd className="text-neutral-200">
            {/*
              Higgsfield 経路で生成された turn は provider="higgsfield" +
              modelDisplayName ("Seedream V5 Lite" など) を保持している。
              Codex 経路の turn.model (例: "gpt-5.5") は Codex の制御モデル名で
              あって、画像生成モデル名ではない。provider に応じて表示を切り替える。
            */}
            {turn.provider === "magnific" && turn.modelDisplayName
              ? `Magnific · ${turn.modelDisplayName}`
              : turn.provider === "higgsfield" && turn.modelDisplayName
                ? `Higgsfield · ${turn.modelDisplayName}`
                : turn.provider === "codex" && turn.modelDisplayName
                  ? `Codex · ${turn.modelDisplayName}`
                  : (turn.model ?? "（未記録）")}
            {turn.provider !== "higgsfield" && turn.effort
              ? ` ・ effort: ${turn.effort}`
              : ""}
          </dd>
          <dt className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            生成日時
          </dt>
          <dd className="text-neutral-200">
            {new Date(turn.createdAt).toLocaleString("ja-JP")}
          </dd>
          <dt className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            枚数
          </dt>
          <dd className="text-neutral-200">
            {row.count} 枚 ({turn.kind})
          </dd>
          {turn.refImagePaths.length > 0 && (
            <>
              <dt className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                参照画像
              </dt>
              <dd className="text-neutral-200">{turn.refImagePaths.length} 件</dd>
            </>
          )}
        </dl>
      </div>

      {/* プロンプト (残り高さを使って拡張、内部スクロール) */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
          プロンプト
        </span>
        <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-[12px] leading-relaxed text-neutral-200">
          {row.prompt || "(プロンプトなし)"}
        </pre>
      </div>
    </div>
  );
}
