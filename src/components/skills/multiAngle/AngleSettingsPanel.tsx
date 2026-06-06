import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { getAngleCut, MAX_CUTS } from "../../../lib/multiangle/angles";
import type { MultiAngleParams } from "../../../lib/multiangle/types";
import { useMultiAngleRun } from "../../../lib/store/multiAngleRun";
import { useToasts } from "../../../lib/store/toasts";
import { AnglePickerModal } from "./AnglePickerModal";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const ASPECT_RATIOS = ["1:1", "9:16", "16:9", "4:5"] as const;

/**
 * マルチアングル設定パネル（左サイドバー）
 *
 * 画像生成タブの左パネルに相当。
 *   被写体参照1枚 → 環境固定 → アスペクト比 → 構図を選ぶ → 一気に生成
 *
 * 「構図を選ぶ」で AnglePickerModal（中央ポップアップ）を開く。
 * 枚数を常時表示し、プラスプランのリミット刺さりを可視化で防ぐ。
 */
export function AngleSettingsPanel() {
  const characterImagePath = useMultiAngleRun((s) => s.characterImagePath);
  const setCharacterImage = useMultiAngleRun((s) => s.setCharacterImage);
  const environmentDescription = useMultiAngleRun((s) => s.environmentDescription);
  const setEnvironment = useMultiAngleRun((s) => s.setEnvironment);
  const aspectRatio = useMultiAngleRun((s) => s.aspectRatio);
  const setAspectRatio = useMultiAngleRun((s) => s.setAspectRatio);
  const selectedCutIds = useMultiAngleRun((s) => s.selectedCutIds);
  const status = useMultiAngleRun((s) => s.status);
  const beginRun = useMultiAngleRun((s) => s.beginRun);
  const setRunId = useMultiAngleRun((s) => s.setRunId);

  const pushToast = useToasts((s) => s.push);
  const [pickerOpen, setPickerOpen] = useState(false);

  const count = selectedCutIds.length;
  const running = status === "running";
  const canRun = Boolean(characterImagePath) && count > 0 && !running;

  async function pickCharacterImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r || typeof r !== "string") return;
      setCharacterImage(r);
      pushToast({ kind: "success", text: "被写体の参照画像を設定しました。", ttlMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function runGeneration() {
    if (!characterImagePath) {
      pushToast({ kind: "info", text: "先に被写体の参照画像を選んでください。", ttlMs: 3000 });
      return;
    }
    if (count === 0) {
      pushToast({ kind: "info", text: "「構図を選ぶ」から1つ以上選んでください。", ttlMs: 3000 });
      return;
    }

    const cutPrompts = selectedCutIds
      .map((id) => {
        const cut = getAngleCut(id);
        if (!cut) return null;
        return { cutId: cut.id, label: cut.label, promptFragment: cut.promptFragment };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const params: MultiAngleParams = {
      characterImage: characterImagePath,
      environmentDescription,
      aspectRatio,
      cutIds: selectedCutIds,
      cutPrompts,
    };

    // 先に pending スケルトンを建てて listener を確実に間に合わせる。
    // バックエンドは invoke 直後に spawn して cutStarted/cutCompleted を emit する。
    // skeleton を invoke の前に建てておけば、先行到着したイベントも取りこぼさない。
    beginRun(
      null,
      cutPrompts.map((c) => ({ cutId: c.cutId, label: c.label })),
    );

    try {
      const runId = await invoke<string>("multiangle_run", { params });
      setRunId(runId);
      pushToast({
        kind: "success",
        text: `${count} カットの生成を開始しました。`,
        ttlMs: 3000,
      });
    } catch (err) {
      // 起動失敗時は skeleton を片付けて待機表示を残さない。
      useMultiAngleRun.getState().reset();
      pushToast({
        kind: "error",
        text: `生成の開始に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#242424] bg-[#141414] px-4 py-4">
      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          被写体の参照画像
        </div>
        {characterImagePath ? (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-xl border border-[#2a2a2a]">
              <img
                src={convertFileSrc(characterImagePath)}
                alt="被写体参照"
                className="aspect-square w-full object-cover"
              />
            </div>
            <button
              type="button"
              onClick={pickCharacterImage}
              className="w-full rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              画像を変更
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={pickCharacterImage}
            className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500 hover:border-pink-400/60 hover:text-neutral-300"
          >
            <span className="text-2xl">＋</span>
            <span className="text-[12px] font-bold">参照画像を選ぶ</span>
          </button>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          環境・背景（固定）
        </div>
        <textarea
          value={environmentDescription}
          onChange={(e) => setEnvironment(e.target.value)}
          placeholder="例: 白いスタジオ背景、柔らかい自然光"
          rows={3}
          className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
        />
        <p className="mt-1 text-[10px] text-neutral-600">
          全カット共通の環境。空欄なら参照画像の環境を踏襲します。
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          アスペクト比
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {ASPECT_RATIOS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setAspectRatio(r)}
              className={`rounded-lg border px-2 py-1.5 text-[11px] font-bold transition ${
                aspectRatio === r
                  ? "border-pink-400 bg-pink-500/20 text-pink-100"
                  : "border-[#2a2a2a] text-neutral-400 hover:border-pink-400/40"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-[#242424] pt-4">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="w-full rounded-xl border border-[#343434] bg-[#101010] px-3 py-2.5 text-[13px] font-black text-neutral-200 hover:border-pink-400 hover:text-white"
        >
          構図を選ぶ
        </button>
        <div className="mt-2 text-center text-[12px] font-bold text-neutral-400">
          選択中:{" "}
          <span className={count > 0 ? "text-pink-300" : "text-neutral-500"}>{count} カット</span>
          <span className="text-neutral-600"> / 最大 {MAX_CUTS}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={runGeneration}
        disabled={!canRun}
        className={`mt-auto w-full rounded-xl px-4 py-3 text-[14px] font-black transition ${
          canRun
            ? "bg-pink-500 text-white hover:bg-pink-400"
            : "cursor-not-allowed bg-[#242424] text-neutral-600"
        }`}
      >
        {running ? "生成中…" : count > 0 ? `${count} カットを一気に生成` : "一気に生成"}
      </button>

      {pickerOpen && <AnglePickerModal onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}
