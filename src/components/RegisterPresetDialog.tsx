import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  history,
  sessions as sessionsApi,
  type PromptHistoryRow,
  type TurnWithImages,
} from "../lib/ipc";
import { usePresets } from "../lib/store/presets";
import { useToasts } from "../lib/store/toasts";
import { SafeImage } from "./SafeImage";

/**
 * 画像 path から 256x256 のサムネ JPEG (base64 data URL) を生成する。
 *
 * STΛCK 報告 (2026-05-19): プリセット一覧で「NO THUMBNAIL」と表示される
 * 問題対策。旧版は thumbnail を未設定で保存していた (MVP 段階のコメント残り)。
 * Canvas で aspect-cover (中央クロップ) リサイズして data URL 化する。
 * 1 枚あたり ~30-80KB 程度 (quality 0.85)。
 *
 * 失敗時は null を返す (登録は続行、サムネだけ無しになる)。
 */
async function generateThumbnailDataUrl(imagePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const SIZE = 256;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        // aspect-cover: 短辺をフィットさせて中央クロップ
        const ratio = img.naturalWidth / img.naturalHeight;
        let drawW: number;
        let drawH: number;
        let drawX: number;
        let drawY: number;
        if (ratio >= 1) {
          // 横長 → 高さを SIZE にして、幅を中央クロップ
          drawH = SIZE;
          drawW = SIZE * ratio;
          drawX = (SIZE - drawW) / 2;
          drawY = 0;
        } else {
          drawW = SIZE;
          drawH = SIZE / ratio;
          drawX = 0;
          drawY = (SIZE - drawH) / 2;
        }
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl);
      } catch (err) {
        console.warn("[generateThumbnailDataUrl] canvas 処理失敗:", err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = convertFileSrc(imagePath);
  });
}

/**
 * 画像をプリセットとして登録する小モーダル。
 *
 * F-#1 修正 (2026-05-19): 画像の右クリックメニューから「プリセット登録」を選んだ時に
 * 開く。生成プロンプトの逆引き (history.recent → getTurn) と、プリセット名/カテゴリの
 * 入力 UI をワンモーダルにまとめる。
 *
 * - prompt は逆引きで取得した値をデフォルト表示するが、ユーザーが編集できる
 * - thumbnail は image_path 本体を data URL 化する処理が必要だが、MVP として
 *   未設定で登録 (後で usePresets.updatePreset で thumbnail を埋められる)。
 *   将来的にはここで <canvas> 経由で 1024px JPEG を作る。
 *
 * 画像にプロンプトが見つからない (古い、ライブラリ流入等) ケースでは空文字を
 * 初期値にして手入力できる。
 */
type Props = {
  imagePath: string;
  defaultName?: string;
  onClose: () => void;
};

export function RegisterPresetDialog({ imagePath, defaultName, onClose }: Props) {
  const categories = usePresets((s) => s.categories);
  const addPreset = usePresets((s) => s.addPreset);
  const pushToast = useToasts((s) => s.push);

  const [name, setName] = useState(defaultName ?? deriveDefaultName(imagePath));
  const [prompt, setPrompt] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * F-#7 (2026-05-19): プリセットに紐づくキャラ添付画像。
   * imagePath を初期値として入れておく (= 「この画像から作ったプリセットには
   * その画像をキャラとして紐付け」がデフォルト)。ユーザーは削除も追加もできる。
   */
  const [attachedImages, setAttachedImages] = useState<string[]>([imagePath]);

  // 画像 → プロンプト逆引き (ImageMetaPanel と同じ手法)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const rows = await history.recent(120);
        if (cancelled) return;
        let matched: { turn: TurnWithImages; row: PromptHistoryRow } | null = null;
        for (const row of rows) {
          if (cancelled) return;
          try {
            const turn = await sessionsApi.getTurn(row.id);
            if (cancelled) return;
            if (turn.images.some((img) => img.path === imagePath)) {
              matched = { turn, row };
              break;
            }
          } catch {
            // 単発の失敗は無視
          }
        }
        if (cancelled) return;
        if (matched) {
          setPrompt(matched.row.prompt);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imagePath]);

  const canSave = useMemo(
    () => name.trim().length > 0 && prompt.trim().length > 0 && !saving,
    [name, prompt, saving],
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // STΛCK 報告 (2026-05-19): プリセット一覧で「NO THUMBNAIL」と表示される
      // 問題対策。登録元画像から 256x256 中央クロップ JPEG を生成して thumbnail
      // フィールドに保存する。失敗してもプリセット登録自体は続行。
      const thumbnail = await generateThumbnailDataUrl(imagePath);
      addPreset({
        name: name.trim(),
        prompt: prompt.trim(),
        categoryId,
        thumbnail: thumbnail ?? undefined,
        attachedImages:
          attachedImages.length > 0
            ? attachedImages.map((path) => ({ path, role: "subject" }))
            : undefined,
      });
      pushToast({
        kind: "success",
        text: `プリセット「${name.trim()}」を登録しました`,
        ttlMs: 3000,
      });
      onClose();
    } catch (err) {
      pushToast({ kind: "error", text: `プリセット登録に失敗: ${String(err)}` });
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {/*
        STΛCK 指示 (2026-05-19): ポップアップサイズを OptionPickerModal と統一。
        ヘッダ(固定) + 本体(スクロール、2列レイアウト) + フッター(固定) 構成。
        5xl 幅をフル活用して、左に画像プレビュー+メタ情報、右にフォームを並べる。
      */}
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="flex items-center justify-between border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              SELECT
            </p>
            <h3 className="text-sm font-black text-white">プリセットに登録</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            × 閉じる
          </button>
        </div>

        {/* 本体: 2列レイアウト */}
        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto p-6 md:grid-cols-[280px_1fr]">
          {/* 左カラム: 画像プレビュー + キャラ添付画像 */}
          <div className="flex flex-col gap-4">
            <div className="aspect-square w-full overflow-hidden rounded-lg border border-[#343434] bg-black">
              <SafeImage path={imagePath} className="h-full w-full object-cover" />
            </div>
            <div className="text-[11px] text-neutral-400">
              {loading ? (
                "プロンプトを読み込み中…"
              ) : error ? (
                <span className="text-red-400">プロンプト取得に失敗: {error}</span>
              ) : prompt ? (
                "生成時のプロンプトを取得しました (右側で編集可)"
              ) : (
                "プロンプトが見つからなかったので、右側に手入力してください"
              )}
            </div>

            {/* キャラ添付画像 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold text-neutral-300">
                キャラ添付画像 ({attachedImages.length} 枚)
              </span>
              <p className="text-[10px] text-neutral-500">
                プリセット呼び出し時に、この画像も自動で参照に追加されます。
              </p>
              <div className="flex flex-wrap gap-2">
                {attachedImages.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setAttachedImages([imagePath])}
                    className="rounded border border-dashed border-[#444] px-3 py-2 text-[11px] font-bold text-neutral-400 hover:border-pink-400 hover:text-pink-300"
                  >
                    + 登録元の画像を添付
                  </button>
                ) : (
                  attachedImages.map((path) => (
                    <div
                      key={path}
                      className="group relative h-16 w-16 overflow-hidden rounded border border-[#343434] bg-black"
                      title={path}
                    >
                      <SafeImage path={path} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() =>
                          setAttachedImages((prev) => prev.filter((p) => p !== path))
                        }
                        className="absolute right-0 top-0 hidden h-5 w-5 items-center justify-center bg-black/80 text-[11px] text-white group-hover:flex hover:text-rose-300"
                        title="この画像をプリセットから外す"
                        aria-label="画像を外す"
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 右カラム: 入力フォーム */}
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs font-bold text-neutral-300">
              名前
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-10 rounded-md border border-[#343434] bg-[#101010] px-3 text-sm text-neutral-100 outline-none focus:border-pink-400"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-bold text-neutral-300">
              カテゴリ
              <select
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value || null)}
                className="h-10 rounded-md border border-[#343434] bg-[#101010] px-3 text-sm text-neutral-100 outline-none focus:border-pink-400"
              >
                <option value="">未分類</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-xs font-bold text-neutral-300">
              プロンプト
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={12}
                className="min-h-[240px] flex-1 resize-none rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-pink-400"
                placeholder="プリセットとして登録するプロンプト本文"
              />
            </label>
          </div>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-4 text-xs font-bold text-neutral-300 hover:border-[#555] hover:text-white"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className="h-9 rounded-md bg-pink-500 px-4 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {saving ? "登録中…" : "登録"}
          </button>
        </div>
      </div>
    </div>
  );
}

function deriveDefaultName(imagePath: string): string {
  const base = imagePath.split(/[\\/]/).pop() ?? imagePath;
  return base.replace(/\.[^.]+$/, "");
}
