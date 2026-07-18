import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import {
  PRODUCT_CUTS,
  buildCutPromptFragment,
  getProductCut,
  type ProductCutGroup,
} from "../../../lib/productSet/catalog";
import { useProductSetRun } from "../../../lib/productSet/store";
import type { MultiAngleParams } from "../../../lib/multiangle/types";
import { useToasts } from "../../../lib/store/toasts";
import {
  ASPECT_RATIO_HINTS,
  ASPECT_RATIO_PICKER_OPTIONS,
} from "../../../lib/scene/aspectRatioPicker";
import type { SceneAspectRatio } from "../../../lib/scene/types";
import { OptionPickerModal } from "../../scene/OptionPickerModal";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

const GROUP_LABELS: Record<ProductCutGroup, string> = {
  white: "白背景",
  lifestyle: "ライフスタイルシーン",
  detail: "ディテール寄り",
};

const GROUP_ORDER: ProductCutGroup[] = ["white", "lifestyle", "detail"];

/**
 * EC納品セット 設定パネル（左サイドバー）
 *
 * 商品写真1枚 → 商品説明(任意) → シーン指定(任意) → アスペクト比 → 納品カット選択 →
 * 一気に生成。マルチアングルの AngleSettingsPanel と同じ2ペイン思想だが、6カットの
 * カタログはインラインのチェックリストで取捨選択する（構図数が少ないためモーダル不要）。
 */
export function ProductSetSettingsPanel() {
  const productImagePath = useProductSetRun((s) => s.productImagePath);
  const setProductImage = useProductSetRun((s) => s.setProductImage);
  const productDescription = useProductSetRun((s) => s.productDescription);
  const setProductDescription = useProductSetRun((s) => s.setProductDescription);
  const sceneHint = useProductSetRun((s) => s.sceneHint);
  const setSceneHint = useProductSetRun((s) => s.setSceneHint);
  const aspectRatio = useProductSetRun((s) => s.aspectRatio);
  const setAspectRatio = useProductSetRun((s) => s.setAspectRatio);
  const selectedCutIds = useProductSetRun((s) => s.selectedCutIds);
  const toggleCut = useProductSetRun((s) => s.toggleCut);
  const selectAllCuts = useProductSetRun((s) => s.selectAllCuts);
  const clearSelection = useProductSetRun((s) => s.clearSelection);
  const status = useProductSetRun((s) => s.status);
  const beginRun = useProductSetRun((s) => s.beginRun);
  const setRunId = useProductSetRun((s) => s.setRunId);

  const pushToast = useToasts((s) => s.push);
  const [aspectPickerOpen, setAspectPickerOpen] = useState(false);

  const count = selectedCutIds.length;
  const running = status === "running";
  const canRun = Boolean(productImagePath) && count > 0 && !running;
  const allSelected = count >= PRODUCT_CUTS.length;

  async function pickProductImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r || typeof r !== "string") return;
      setProductImage(r);
      pushToast({ kind: "success", text: "商品写真を設定しました。", ttlMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function runGeneration() {
    if (!productImagePath) {
      pushToast({ kind: "info", text: "先に商品写真を選んでください。", ttlMs: 3000 });
      return;
    }
    if (count === 0) {
      pushToast({ kind: "info", text: "納品カットを1つ以上選んでください。", ttlMs: 3000 });
      return;
    }

    // 選択カットを CutPromptSpec に変換。promptFragment に商品説明・同一性ロック・
    // シーン指定を焼き込む（Rust は promptFragment をそのまま構図句として使う）。
    const cutPrompts = selectedCutIds
      .map((id) => {
        const cut = getProductCut(id);
        if (!cut) return null;
        return {
          cutId: cut.id,
          label: cut.label,
          promptFragment: buildCutPromptFragment(cut, productDescription, sceneHint),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const params: MultiAngleParams = {
      characterImage: productImagePath,
      // 環境固定句はシーン指定を優先。空なら白背景系のため空文字のまま。
      environmentDescription: sceneHint,
      aspectRatio,
      cutIds: selectedCutIds,
      cutPrompts,
      // 商品の同一性維持句(形状/色/ラベル/ロゴ)へ切り替える。人物向けの「ロゴ禁止」が
      // ラベル維持と衝突しないよう Rust 側でプロンプトを分岐させる。
      subjectKind: "product",
    };

    // skeleton を invoke 前に建てて、先行到着イベントを取りこぼさない
    // （マルチアングルの 0/N 固着修正と同じ順序）。
    beginRun(
      null,
      cutPrompts.map((c) => ({ cutId: c.cutId, label: c.label })),
    );

    try {
      const runId = await invoke<string>("multiangle_run", { params });
      setRunId(runId);
      pushToast({
        kind: "success",
        text: `${count} カットの納品セット生成を開始しました。`,
        ttlMs: 3000,
      });
    } catch (err) {
      useProductSetRun.getState().reset();
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
          商品写真
        </div>
        {productImagePath ? (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-xl border border-[#2a2a2a]">
              <img
                src={convertFileSrc(productImagePath)}
                alt="商品写真"
                className="aspect-square w-full object-cover"
              />
            </div>
            <button
              type="button"
              onClick={pickProductImage}
              className="w-full rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              画像を変更
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={pickProductImage}
            className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#3a3a3a] bg-[#0d0d0d] text-neutral-500 hover:border-pink-400/60 hover:text-neutral-300"
          >
            <span className="text-2xl">＋</span>
            <span className="text-[12px] font-bold">商品写真を選ぶ</span>
          </button>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          商品説明（任意）
        </div>
        <textarea
          value={productDescription}
          onChange={(e) => setProductDescription(e.target.value)}
          placeholder="例: 白い陶器のマグカップ、艶あり"
          rows={2}
          className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
        />
        <p className="mt-1 text-[10px] text-neutral-600">
          商品名・素材を書くと同一性維持が安定します。
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          シーン指定（任意）
        </div>
        <input
          type="text"
          value={sceneHint}
          onChange={(e) => setSceneHint(e.target.value)}
          placeholder="例: 木目のテーブル、屋外"
          className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
        />
        <p className="mt-1 text-[10px] text-neutral-600">
          ライフスタイルシーンのカットに反映されます。
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-black uppercase tracking-wider text-neutral-500">
          アスペクト比
        </div>
        <button
          type="button"
          onClick={() => setAspectPickerOpen(true)}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-left text-[13px] font-semibold text-neutral-100 transition hover:border-pink-400 hover:bg-[#151515]"
          title="アスペクト比を選ぶ"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-bold text-neutral-100">{aspectRatio}</span>
            <span className="truncate text-[11px] font-medium text-neutral-500">
              {ASPECT_RATIO_HINTS[aspectRatio as SceneAspectRatio] ?? ""}
            </span>
          </span>
          <span className="shrink-0 text-[11px] text-neutral-500" aria-hidden>
            ▾
          </span>
        </button>
      </div>

      <div className="border-t border-[#242424] pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-black uppercase tracking-wider text-neutral-500">
            納品カット
          </span>
          <button
            type="button"
            onClick={() => (allSelected ? clearSelection() : selectAllCuts())}
            className="text-[11px] font-bold text-neutral-400 hover:text-pink-300"
          >
            {allSelected ? "全解除" : "全選択"}
          </button>
        </div>

        <div className="space-y-3">
          {GROUP_ORDER.map((group) => {
            const cutsInGroup = PRODUCT_CUTS.filter((c) => c.group === group);
            if (cutsInGroup.length === 0) return null;
            return (
              <div key={group}>
                <div className="mb-1 text-[10px] font-bold text-neutral-600">
                  {GROUP_LABELS[group]}
                </div>
                <div className="space-y-1.5">
                  {cutsInGroup.map((cut) => {
                    const selected = selectedCutIds.includes(cut.id);
                    return (
                      <button
                        key={cut.id}
                        type="button"
                        onClick={() => toggleCut(cut.id)}
                        className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
                          selected
                            ? "border-pink-400/70 bg-pink-500/10"
                            : "border-[#2a2a2a] bg-[#0d0d0d] hover:border-[#3a3a3a]"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-black ${
                            selected
                              ? "border-pink-400 bg-pink-500 text-white"
                              : "border-[#3a3a3a] text-transparent"
                          }`}
                          aria-hidden
                        >
                          ✓
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] font-bold text-neutral-200">
                            {cut.label}
                          </span>
                          <span className="block truncate text-[10px] text-neutral-500">
                            {cut.hint}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2 text-center text-[12px] font-bold text-neutral-400">
          選択中:{" "}
          <span className={count > 0 ? "text-pink-300" : "text-neutral-500"}>
            {count} カット
          </span>
          <span className="text-neutral-600"> / {PRODUCT_CUTS.length}</span>
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
        {running ? "生成中…" : count > 0 ? `${count} カットの納品セットを生成` : "納品セットを生成"}
      </button>

      <OptionPickerModal
        open={aspectPickerOpen}
        title="アスペクト比を選ぶ"
        options={ASPECT_RATIO_PICKER_OPTIONS}
        selectedValue={aspectRatio}
        onPick={(value) => setAspectRatio(value)}
        onClose={() => setAspectPickerOpen(false)}
      />
    </aside>
  );
}
