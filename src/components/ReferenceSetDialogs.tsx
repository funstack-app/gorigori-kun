import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useComposer, type Reference } from "../lib/store/composer";
import { useReferenceSets, type ReferenceSet } from "../lib/store/referenceSets";
import { useToasts } from "../lib/store/toasts";
import { SafeImage } from "./SafeImage";

/**
 * F-#6 (2026-05-19): 「現在の参照画像 + プロンプトをセットとして保存」ダイアログ。
 * ConstructedPromptPanel の「+ セット保存」ボタンから開く。
 */
export function SaveReferenceSetDialog({
  references,
  prompt,
  onClose,
}: {
  references: Reference[];
  prompt: string;
  onClose: () => void;
}) {
  const addSet = useReferenceSets((s) => s.addSet);
  const pushToast = useToasts((s) => s.push);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      addSet({
        name: name.trim(),
        description: description.trim() || undefined,
        references,
        prompt,
      });
      pushToast({
        kind: "success",
        text: `リファレンスセット「${name.trim()}」を保存しました`,
        ttlMs: 3000,
      });
      onClose();
    } catch (err) {
      pushToast({ kind: "error", text: `保存に失敗: ${String(err)}` });
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {/* STΛCK 指示 (2026-05-19): OptionPickerModal と統一サイズ */}
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              SAVE
            </p>
            <h3 className="text-sm font-black text-white">リファレンスセットを保存</h3>
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">

        <div className="rounded-lg border border-[#262626] bg-[#101010] p-2">
          <p className="mb-1.5 text-[10px] font-bold text-neutral-500">
            含まれる参照画像 ({references.length} 枚)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {references.length === 0 ? (
              <p className="text-[11px] text-neutral-500">参照画像なし — プロンプトのみのセットになります</p>
            ) : (
              references.map((ref) => (
                <div
                  key={ref.path}
                  className="h-10 w-10 overflow-hidden rounded border border-[#343434] bg-black"
                  title={ref.name}
                >
                  <SafeImage path={ref.path} className="h-full w-full object-cover" />
                </div>
              ))
            )}
          </div>
        </div>

        <label className="flex flex-col gap-1 text-[11px] font-bold text-neutral-300">
          名前
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: ブランド A の青系トーン"
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] font-bold text-neutral-300">
          メモ (任意)
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="使いどころのメモ"
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        </label>

        <div className="rounded-md border border-[#262626] bg-[#101010] p-3">
          <p className="mb-1 text-[10px] font-bold text-neutral-500">プロンプト</p>
          <p className="line-clamp-3 font-mono text-[11px] text-neutral-300">
            {prompt || "(空)"}
          </p>
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
            disabled={!name.trim() || saving}
            onClick={handleSave}
            className="h-9 rounded-md bg-pink-500 px-4 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * F-#6: リファレンスセット一覧モーダル。クリックで現在のリファレンス+プロンプトを
 * そのセットの内容で置き換える (呼び出し)。
 */
export function ReferenceSetsPickerModal({
  onClose,
  onApply,
}: {
  onClose: () => void;
  /** 呼び出した時の挙動。デフォルトでは composer に流し、prompt を override に流す */
  onApply: (set: ReferenceSet) => void;
}) {
  const sets = useReferenceSets((s) => s.sets);
  const removeSet = useReferenceSets((s) => s.removeSet);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {/* STΛCK 指示 (2026-05-19): OptionPickerModal と統一サイズ */}
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              SELECT
            </p>
            <h3 className="text-sm font-black text-white">リファレンスセット</h3>
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

        <div className="flex-1 overflow-y-auto p-3">
          {sets.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-neutral-500">
              まだセットがありません。<br />
              参照画像を追加してプロンプトを書いた状態で「+ セット保存」を押すと、ここに保存されます。
            </p>
          ) : (
            <ul className="space-y-2">
              {sets.map((set) => (
                <li
                  key={set.id}
                  className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-white">{set.name}</p>
                      {set.description && (
                        <p className="mt-0.5 truncate text-[10px] text-neutral-500">
                          {set.description}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-[10px] text-neutral-500">
                      {new Date(set.updatedAt).toLocaleDateString("ja-JP")}
                    </div>
                  </div>

                  {set.references.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {set.references.slice(0, 6).map((ref) => (
                        <div
                          key={ref.path}
                          className="h-8 w-8 overflow-hidden rounded border border-[#343434] bg-black"
                          title={ref.name}
                        >
                          <img
                            src={convertFileSrc(ref.path)}
                            alt=""
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        </div>
                      ))}
                      {set.references.length > 6 && (
                        <div className="flex h-8 w-8 items-center justify-center rounded border border-[#343434] bg-black text-[10px] text-neutral-500">
                          +{set.references.length - 6}
                        </div>
                      )}
                    </div>
                  )}

                  {set.prompt && (
                    <p className="mt-2 line-clamp-2 font-mono text-[10px] text-neutral-400">
                      {set.prompt}
                    </p>
                  )}

                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    {confirmRemoveId === set.id ? (
                      <>
                        <span className="text-[10px] text-rose-300">削除しますか?</span>
                        <button
                          type="button"
                          onClick={() => {
                            removeSet(set.id);
                            setConfirmRemoveId(null);
                          }}
                          className="rounded border border-rose-500 bg-rose-500/15 px-2 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/30"
                        >
                          削除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(null)}
                          className="rounded border border-[#343434] px-2 py-1 text-[10px] text-neutral-400 hover:text-white"
                        >
                          キャンセル
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveId(set.id)}
                          className="rounded border border-[#343434] px-2 py-1 text-[10px] text-neutral-400 hover:border-rose-500 hover:text-rose-300"
                        >
                          削除
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onApply(set);
                            onClose();
                          }}
                          className="rounded bg-pink-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-pink-600"
                        >
                          このセットを呼び出す
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ConstructedPromptPanel から呼び出す統合フック。
 * composer の references を ReferenceSet.references で置き換え、prompt は
 * 呼び出し元 (setPromptOverride) に渡す。
 */
export function applyReferenceSet(
  set: ReferenceSet,
  setPromptOverride: (next: string | null) => void,
) {
  const composer = useComposer.getState();
  // 現在の参照を全削除 → セットの参照を追加 (順序維持)
  composer.references.forEach((r) => composer.removeReference(r.path));
  composer.addReferences(set.references);
  setPromptOverride(set.prompt || null);
}
