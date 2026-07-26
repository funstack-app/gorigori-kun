import { useRef, type ChangeEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { useEditorActions } from "../../edit/editor/useEditor";
import { images } from "../../../lib/ipc";
import { useRedline } from "../../../lib/redline/store";
import {
  REDLINE_FIX_KIND_LABEL,
  type RedlineInstruction,
} from "../../../lib/redline/types";
import { useToasts } from "../../../lib/store/toasts";
import { useWorkspace } from "../../../lib/store/workspace";

/**
 * 赤入れ反映 Workspace（スキル一覧v2.1 #10）
 *
 * クライアントの赤入れ（注釈付き画像）を読み取り、「どこを・何と・どう直すか」の
 * 構造化リストにして、部分修正（編集タブ）へ繋ぐ。
 * 設計参考: _work/gori-skill-design/ai-image-video-taxonomy.md
 *   「赤入れ反映スキルへの示唆」— 読む→指す→直す→検品 の4段。
 *
 * MVP 実装範囲:
 *  - 読む / 指す: 元画像 + 赤入れ画像を AI に渡し、修正指示リスト（JSON）を得る
 *  - 直す: bbox があれば指定範囲だけを修正し、無ければ元画像 + コピー済み指示を編集タブへ渡す
 *  - 検品: 未実装（後続で実ブラウザ検証相当を組む）
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function isImageFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/**
 * ブラウザ File を Tauri 側のファイルパスへ落とす。
 * PlanWorkspace.fileToImagePath と同じ流儀。webview から直接パスが取れない環境では
 * images.writeUpload で ~/.codex/generated_images/ へ書き出してパスを得る。
 */
async function fileToImagePath(file: File): Promise<string | null> {
  const directPath = (file as unknown as { path?: string }).path;
  if (directPath) return directPath;
  if (!file.type.startsWith("image/") && !isImageFileName(file.name)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return images.writeUpload(file.name || `redline-${Date.now()}.png`, bytes);
}

export function RedlineWorkspace() {
  const originalPath = useRedline((s) => s.originalPath);
  const redlinePath = useRedline((s) => s.redlinePath);
  const running = useRedline((s) => s.running);
  const result = useRedline((s) => s.result);
  const error = useRedline((s) => s.error);
  const setOriginalPath = useRedline((s) => s.setOriginalPath);
  const setRedlinePath = useRedline((s) => s.setRedlinePath);
  const interpret = useRedline((s) => s.interpret);
  const reset = useRedline((s) => s.reset);
  const pushToast = useToasts((s) => s.push);

  const pickImage = async (
    files: FileList | File[],
    setPath: (path: string | null) => void,
  ) => {
    const file = Array.from(files)[0];
    if (!file) return;
    try {
      const path = await fileToImagePath(file);
      if (!path) {
        pushToast({ kind: "error", text: "画像ファイルを選んでください。", ttlMs: 3000 });
        return;
      }
      setPath(path);
    } catch {
      pushToast({
        kind: "error",
        text: "画像の読み込みに失敗しました。別の画像でお試しください。",
        ttlMs: 5000,
      });
    }
  };

  const canInterpret = Boolean(redlinePath) && !running;

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* 入力エリア: 元画像 + 赤入れ画像 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ImageDropSlot
            label="元画像（任意）"
            hint="修正前のデザイン"
            path={originalPath}
            onPick={(files) => pickImage(files, setOriginalPath)}
            onClear={() => setOriginalPath(null)}
          />
          <ImageDropSlot
            label="赤入れ画像（必須）"
            hint="注釈・書き込みが入った画像"
            path={redlinePath}
            required
            onPick={(files) => pickImage(files, setRedlinePath)}
            onClear={() => setRedlinePath(null)}
          />
        </div>

        {/* PDF の案内（MVP は画像のみ） */}
        <p className="rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
          赤入れが PDF の場合は、ページを画像（PNG / JPG）に書き出してから投入してください。
          現バージョンは画像のみ対応です。
        </p>

        {/* アクション */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void interpret()}
            disabled={!canInterpret}
            className="flex items-center justify-center gap-2 rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white shadow hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            title="赤入れを読み取って修正指示リストを作る"
          >
            {running && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
            )}
            {running ? "解釈中…" : "赤入れを読み取る"}
          </button>
          {(result || error || originalPath || redlinePath) && (
            <button
              type="button"
              onClick={reset}
              disabled={running}
              className="rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              リセット
            </button>
          )}
        </div>

        {/* エラー表示 */}
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-200">
            {error}
          </div>
        )}

        {/* 結果: 修正指示カード一覧 */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-black text-neutral-300">
                修正指示 {result.instructions.length} 件
              </p>
              {result.instructions.some((i) => i.ambiguous) && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                  要確認あり（推測で埋めていません）
                </span>
              )}
            </div>

            {result.overallNote && (
              <p className="rounded-lg border border-[#2a2a2a] bg-[#181818] px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
                {result.overallNote}
              </p>
            )}

            {result.instructions.length === 0 ? (
              <p className="text-[12px] text-neutral-500">
                読み取れる修正指示が見つかりませんでした。赤入れがはっきり写っているか確認してください。
              </p>
            ) : (
              <div className="space-y-2">
                {result.instructions.map((ins) => (
                  <RedlineCard
                    key={ins.number}
                    instruction={ins}
                    editTarget={originalPath ?? redlinePath}
                    applyTarget={originalPath}
                  />
                ))}
              </div>
            )}

            {/* 検品段は未実装（4段のうち最後） */}
            <p className="rounded-lg border border-dashed border-[#2a2a2a] px-3 py-2 text-[11px] text-neutral-600">
              検品（修正後に赤入れ通り直っているかの自動チェック）は今後のバージョンで対応します。
            </p>
          </div>
        )}

        {!result && !error && !running && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-neutral-500">
            <p className="text-sm font-medium text-neutral-300">赤入れ反映</p>
            <p className="max-w-md text-xs leading-relaxed">
              赤入れ画像（必要なら元画像も）をセットして「赤入れを読み取る」を押すと、
              どこを何と直すかの指示リストにします。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** 画像 1 枚分のドロップ / 選択スロット。 */
function ImageDropSlot({
  label,
  hint,
  path,
  required,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  path: string | null;
  required?: boolean;
  onPick: (files: FileList | File[]) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (files && files.length > 0) onPick(files);
    event.currentTarget.value = "";
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-neutral-300">{label}</span>
        {required && <span className="text-[10px] font-bold text-pink-300">*</span>}
        <span className="text-[10px] text-neutral-500">{hint}</span>
      </div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length > 0) onPick(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className="relative flex min-h-[140px] cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-[#343434] bg-[#0b0b0b] hover:border-pink-400"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={onChange}
          className="hidden"
        />
        {path ? (
          <>
            <img
              src={convertFileSrc(path)}
              alt={basename(path)}
              className="max-h-[220px] w-full object-contain"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="absolute right-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-black text-neutral-200 hover:text-white"
              aria-label={`${label} を外す`}
            >
              ×
            </button>
          </>
        ) : (
          <span className="px-4 text-center text-[11px] text-neutral-500">
            クリックまたはドロップで画像を選ぶ
          </span>
        )}
      </div>
    </div>
  );
}

/** 修正指示 1 件分のカード。 */
function RedlineCard({
  instruction,
  editTarget,
  applyTarget,
}: {
  instruction: RedlineInstruction;
  /** 「編集タブで開く」フォールバック用。手動レイヤー分解の起点にすぎないため赤入れ画像でも可。 */
  editTarget: string | null;
  /**
   * 「この範囲だけ直す」用。赤入れの書き込み（丸・矢印・手書き文字）が写り込んだ画像を
   * そのままAIへ渡すと、修正結果に書き込みが焼き付く。必ず元画像（書き込みなし）を要求し、
   * 元画像が無ければボタンごと無効化する（no-silent-gap-filling: 不確かな入力で実行しない）。
   */
  applyTarget: string | null;
}) {
  const { applyRedlineFix, openImageForEditing } = useEditorActions();

  const copyInstruction = async (showSuccess = true): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(instruction.instruction);
      if (showSuccess) {
        useToasts.getState().push({
          kind: "success",
          text: "指示をコピーしました",
          ttlMs: 1800,
        });
      }
      return true;
    } catch {
      useToasts.getState().push({
        kind: "error",
        text: "コピーに失敗しました。もう一度お試しください。",
        ttlMs: 4000,
      });
      return false;
    }
  };

  const applyOnlyThisArea = async () => {
    if (!applyTarget || !instruction.bbox) return;
    useWorkspace.getState().setActiveTab("edit");
    const applied = await applyRedlineFix(
      applyTarget,
      instruction.bbox,
      instruction.instruction,
    );
    if (applied) {
      useToasts.getState().push({
        kind: "success",
        text: "指定範囲だけを修正しました。マスク外の画素には触れていません。",
        ttlMs: 5000,
      });
    }
  };

  const openFallbackInEditTab = async () => {
    if (!editTarget) return;
    const copied = await copyInstruction(false);
    useWorkspace.getState().setActiveTab("edit");
    const opened = await openImageForEditing(editTarget);
    if (!opened) return;
    // 2026-07-26: 編集タブから分解系の道具を全て外し「ことばで直す」だけにしたため、
    // 「ことばで分離」「レイヤーを選ぶ」を案内すると実在しない操作を指してしまう。
    useToasts.getState().push({
      kind: copied ? "success" : "warn",
      text: copied
        ? "編集タブで開き、指示をコピーしました。右の入力欄に貼り付けて「AIで直す」を押してください。"
        : "編集タブで開きました。指示のコピーに失敗したため、右の入力欄に直したい内容を書いてください。",
      ttlMs: 6000,
    });
  };

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-pink-500/20 text-[11px] font-black text-pink-200">
          {instruction.number}
        </span>
        <span className="rounded bg-[#242424] px-2 py-0.5 text-[10px] font-bold text-neutral-300">
          {REDLINE_FIX_KIND_LABEL[instruction.fixKind]}
        </span>
        {instruction.ambiguous && (
          <span
            className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-200"
            title={instruction.ambiguityReason ?? "指示の意図が確信できません"}
          >
            要確認
          </span>
        )}
      </div>
      <p className="text-[12px] font-bold leading-relaxed text-neutral-100">
        {instruction.instruction}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
        対象領域: {instruction.areaDescription}
      </p>
      {instruction.ambiguous && instruction.ambiguityReason && (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
          ※ {instruction.ambiguityReason}
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => void copyInstruction()}
          className="rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          指示をコピー
        </button>
        {instruction.bbox ? (
          <button
            type="button"
            onClick={() => void applyOnlyThisArea()}
            disabled={!applyTarget}
            className="rounded-md bg-pink-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            title={
              applyTarget
                ? "赤入れで示された範囲だけを修正する"
                : "元画像（書き込みなし）が無いため使えません。元画像をセットしてください。"
            }
          >
            この範囲だけ直す
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void openFallbackInEditTab()}
            disabled={!editTarget}
            className="rounded-md bg-pink-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            title="範囲を特定できないため、元画像を実エディターで開いて指示をコピーする"
          >
            編集タブで開く
          </button>
        )}
      </div>
    </div>
  );
}
