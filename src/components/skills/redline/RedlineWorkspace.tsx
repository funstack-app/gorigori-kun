import { useRef, type ChangeEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { images } from "../../../lib/ipc";
import { useRedline } from "../../../lib/redline/store";
import {
  REDLINE_FIX_KIND_LABEL,
  type RedlineInstruction,
} from "../../../lib/redline/types";
import { useEditLayers } from "../../../lib/store/editLayers";
import { useEditTab } from "../../../lib/store/editTab";
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
 *  - 直す: 各カードの「編集タブで開く」で 元画像 + 指示テキストを編集タブへ受け渡す
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

/**
 * 元画像 + 指示テキストを編集タブへ受け渡して開く。
 * SkillRunActions.openImageInEditTab と同じ導線に、赤入れの指示テキスト付与を足したもの。
 */
function openInEditTab(imagePath: string, instruction: string) {
  useWorkspace.getState().setActiveTab("edit");
  const editTab = useEditTab.getState();
  editTab.setSelectedImagePath(imagePath);
  editTab.setInstruction(instruction);
  const editLayers = useEditLayers.getState();
  editLayers.setSource(imagePath);
  editLayers.setLayers([]);
  useToasts.getState().push({
    kind: "success",
    text: "編集タブで開きました。指示テキストを入力欄に入れています。",
    ttlMs: 2800,
  });
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
            className="rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white shadow hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            title="赤入れを読み取って修正指示リストを作る"
          >
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
}: {
  instruction: RedlineInstruction;
  editTarget: string | null;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(instruction.instruction);
      useToasts.getState().push({ kind: "success", text: "指示をコピーしました", ttlMs: 1800 });
    } catch {
      useToasts.getState().push({
        kind: "error",
        text: "コピーに失敗しました。もう一度お試しください。",
        ttlMs: 4000,
      });
    }
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
          onClick={copy}
          className="rounded-md border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
        >
          指示をコピー
        </button>
        <button
          type="button"
          onClick={() => {
            if (!editTarget) {
              useToasts.getState().push({
                kind: "error",
                text: "編集タブへ渡す画像がありません。",
                ttlMs: 2800,
              });
              return;
            }
            openInEditTab(editTarget, instruction.instruction);
          }}
          disabled={!editTarget}
          className="rounded-md bg-pink-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          title="この修正を編集タブで開く（元画像 + 指示テキストを渡す）"
        >
          編集タブで開く
        </button>
      </div>
    </div>
  );
}
