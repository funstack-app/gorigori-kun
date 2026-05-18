import { useEffect, useMemo, useState } from "react";
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

  const handleSave = () => {
    if (!canSave) return;
    setSaving(true);
    try {
      addPreset({
        name: name.trim(),
        prompt: prompt.trim(),
        categoryId,
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
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-black text-white">プリセットに登録</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-neutral-400 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="flex items-start gap-3">
          <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded border border-[#343434] bg-black">
            <SafeImage path={imagePath} className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1 text-[11px] text-neutral-400">
            {loading ? (
              "プロンプトを読み込み中…"
            ) : error ? (
              <span className="text-red-400">プロンプト取得に失敗: {error}</span>
            ) : prompt ? (
              "生成時のプロンプトを取得しました (編集できます)"
            ) : (
              "プロンプトが見つからなかったので、手入力してください"
            )}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-[11px] font-bold text-neutral-300">
          名前
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-bold text-neutral-300">
          カテゴリ
          <select
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value || null)}
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
          >
            <option value="">未分類</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-bold text-neutral-300">
          プロンプト
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
            placeholder="プリセットとして登録するプロンプト本文"
          />
        </label>

        {/*
          F-#7 (2026-05-19): キャラ添付画像セクション。
          初期値は登録元の画像 1 枚。チェックボックスで除外/再追加 (= 0 枚にも
          できる)。MVP として「いまそこにある画像から選ぶ」UI までは作らず、
          初期画像 + 「+ 他の画像も追加…」は後追いとする。
        */}
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

        <div className="flex items-center justify-end gap-2 pt-1">
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
            onClick={handleSave}
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
