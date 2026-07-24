import { useEffect, useMemo, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import { presetKind, usePresets, type Preset } from "../../../lib/store/presets";

/**
 * キャラクター登録済みプリセットから、マルチアングルの被写体参照画像を選ぶモーダル。
 *
 * 参照するのは characterMeta.sourceImage（書き込み・注釈の無い正本の元画像）。
 * 赤入れ部分修正の実装で「注釈が写り込んだ画像をAI入力に使うと結果に焼き付く」
 * 教訓を得た（RedlineWorkspace.tsx applyTarget）のと同じ理由で、統合キャラシート
 * （attachedImages）ではなく sourceImage を優先する。sourceImage が無い旧データは
 * attachedImages の先頭にフォールバックする。
 *
 * 画像を解決できないキャラも一覧からは消さず、選択不可として理由付きで出す
 * （no-silent-gap-filling: 「なぜ自分のキャラが出てこないか」を無言で隠さない）。
 */

type Props = {
  onClose: () => void;
  /** 選ばれた参照パスを返す。呼び出し側で setCharacterImage 等へ渡す。 */
  onPick: (imagePath: string) => void;
};

function resolveCharacterImage(preset: Preset): string | null {
  return preset.characterMeta?.sourceImage ?? preset.attachedImages?.[0]?.path ?? null;
}

export function CharacterPresetPickerModal({ onClose, onPick }: Props) {
  const presets = usePresets((s) => s.presets);
  const [brokenPaths, setBrokenPaths] = useState<Set<string>>(new Set());

  const characterPresets = useMemo(
    () =>
      presets
        .filter((p) => presetKind(p) === "character")
        .map((p) => ({ preset: p, imagePath: resolveCharacterImage(p) })),
    [presets],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-white">登録キャラから選ぶ</h2>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              キャラクター登録済みのプリセットから、被写体の元画像を参照として使います。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            閉じる
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {characterPresets.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-neutral-500">
              登録済みのキャラクターがありません。先に「キャラクター登録」で作成してください。
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {characterPresets.map(({ preset, imagePath }) => {
                const broken = imagePath !== null && brokenPaths.has(imagePath);
                const usable = imagePath !== null && !broken;
                const reason = !imagePath
                  ? "画像が登録されていません"
                  : broken
                    ? "画像ファイルが見つかりません"
                    : null;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={!usable}
                    onClick={() => {
                      if (!usable || !imagePath) return;
                      onPick(imagePath);
                      onClose();
                    }}
                    className={`group flex flex-col gap-1.5 rounded-xl border p-2 text-left transition ${
                      usable
                        ? "border-[#2a2a2a] bg-[#101010] hover:border-pink-400"
                        : "cursor-not-allowed border-[#242424] bg-[#0d0d0d] opacity-50"
                    }`}
                    title={reason ? `${preset.name}（${reason}）` : preset.name}
                  >
                    <div className="aspect-square overflow-hidden rounded-lg bg-[#0a0a0a]">
                      {imagePath && !broken ? (
                        <img
                          src={convertFileSrc(imagePath)}
                          alt={preset.name}
                          onError={() =>
                            setBrokenPaths((prev) => new Set(prev).add(imagePath))
                          }
                          className="h-full w-full object-cover transition group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-neutral-600">
                          {reason}
                        </div>
                      )}
                    </div>
                    <span className="truncate text-[11px] font-bold text-neutral-200">
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
