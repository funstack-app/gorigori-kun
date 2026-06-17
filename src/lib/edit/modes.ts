import type { EditPlatformInfo } from "../ipc";
import type { EditModelCategory, EditModeId } from "./types";

export type { EditModeId };

/**
 * 編集タブのレイヤー分解モード定義。
 *
 * 設計思想 (STΛCK 指示 2026-06-17):
 * - 全員に重いモデルを最初から配らない。標準は軽量・全OS、欲しい人だけ追加DL。
 * - 「高速・スタンダード」= 全OS・既定DL済みの軽量スタック。
 * - 「低速・高精度」= 対応環境のみ追加DL (例: SAM3 は Apple Silicon 限定)。
 * - 必要スペックを明記し「このスペックならこれが使える」を可視化する。
 *
 * モデル本体の DL/状態管理は既存の editModels (ModelStatus) を使う。ここは
 * 「モードという束ね方」と「対応条件・必要スペック表示」だけを宣言的に持つ。
 */

export type EditMode = {
  id: EditModeId;
  /** UI 表示名 */
  label: string;
  /** 1行サブ説明 */
  tagline: string;
  /** このモードが使う edit モデルのカテゴリ (DL要否の判定に使う) */
  requiredCategories: EditModelCategory[];
  /** 必要スペック・前提 (UI に箇条書き表示)。 */
  requirements: string[];
  /** 追加DLの目安サイズ (MB)。0 なら既定同梱想定。 */
  approxDownloadMb: number;
  /**
   * この実行環境でモードが使えるか判定する。
   * 使えない場合は理由 (reason) を返し、UI でボタンを無効化して理由を表示する。
   */
  availability: (platform: EditPlatformInfo) => { ok: boolean; reason?: string };
};

export const EDIT_MODES: EditMode[] = [
  {
    id: "standard",
    label: "高速・スタンダード",
    tagline: "全OS対応。背景・人物・文字を素早く自動分解",
    // 既存の軽量ONNXスタック (全OS・無料・DL済み想定)
    requiredCategories: ["ocr", "segment", "inpaint", "samClick"],
    requirements: [
      "Windows / Mac 両対応",
      "GPU 不要 (CPU 推論)",
      "追加 DL: 約 0.6 GB (初回のみ)",
    ],
    approxDownloadMb: 600,
    availability: () => ({ ok: true }),
  },
  {
    id: "highQuality",
    label: "低速・高精度",
    tagline: "画像から髪・顔・上衣・パンツなど人物パーツを自動認識してレイヤー化",
    // SCHP human parsing。画像を入れるだけで全部位を1回で認識する (テキスト指定不要)。
    requiredCategories: ["humanParse"],
    requirements: [
      "Apple Silicon (M1 以降) 専用",
      "追加 DL: 約 0.07 GB (初回のみ)",
      "標準モードより低速だが部位を細かく分解",
    ],
    approxDownloadMb: 70,
    availability: (platform) =>
      platform.isAppleSilicon
        ? { ok: true }
        : {
            ok: false,
            reason:
              "高精度モードは Apple Silicon (Mac) 専用です。お使いの環境では高速・スタンダードモードをご利用ください。",
          },
  },
];

export function findEditMode(id: EditModeId): EditMode {
  const mode = EDIT_MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`unknown edit mode: ${id}`);
  return mode;
}
