import type { EditPlatformInfo } from "../ipc";
import type { EditModelCategory, EditModeId } from "./types";

export type { EditModeId };

/**
 * 編集タブのレイヤー分解モード定義。
 *
 * 設計思想 (STΛCK 指示 2026-06-17):
 * - 全員に重いモデルを最初から配らない。標準は軽量、欲しい人だけ追加DL。
 * - 「高速・スタンダード」= 軽量スタック (OCR/切り抜き/背景補完)。
 * - 「人物パーツ分解」= SCHP human parsing。画像から髪・服など人物の部位を
 *   自動認識してレイヤー化する別用途 (標準モードより低速)。標準とは
 *   「速い/精密」の上下関係ではなく用途が違う。
 * - 対応環境 (2026-08-02 更新): どちらのモードも ort (ONNX Runtime) に依存するため
 *   **Windows 通常版でのみ動く**。Mac (ort が Windows 限定依存) と Windows 互換版
 *   (旧CPU向け・ort 抜きビルド) では利用できない。可否判定は os ではなく
 *   platform.editAiAvailable で行う (EditModeSelector)。
 *   Mac の背景透過は Vision (removebg.swift) 経由で ort とは無関係に動く。
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
    tagline: "Windows 通常版のみ。背景・人物・文字を素早く自動分解",
    // 軽量ONNXスタック。ort が Windows 限定依存になったため、Mac と
    // Windows 互換版 (旧CPU向け・ort 抜き) では動かない (2026-08-02)。
    requiredCategories: ["ocr", "segment", "inpaint", "samClick"],
    requirements: [
      "Windows 通常版のみ (Mac / Windows 互換版では利用不可)",
      "Mac の背景透過は編集タブの Vision 機能をご利用ください",
      "GPU 不要 (CPU 推論)",
      "追加 DL: 約 0.6 GB (初回のみ)",
    ],
    approxDownloadMb: 600,
    availability: () => ({ ok: true }),
  },
  {
    id: "highQuality",
    label: "人物パーツ分解",
    tagline: "画像から髪・顔・上衣・パンツなど人物の部位を自動認識してレイヤー化",
    // SCHP human parsing。画像を入れるだけで全部位を1回で認識する (テキスト指定不要)。
    // CPU ONNX 推論だが ort に依存するため、Mac と Windows 互換版では動かない
    // (2026-08-02。ort を Windows 限定依存へ格下げ + compat は ort 抜きビルド)。
    requiredCategories: ["humanParse"],
    requirements: [
      "Windows 通常版のみ (Mac / Windows 互換版では利用不可)",
      "人物が写った画像向け",
      "追加 DL: 約 0.07 GB (初回のみ)",
      "標準モードより低速。人物の部位を細かく分解",
    ],
    approxDownloadMb: 70,
    // ort 有無による可否は EditModeSelector が platform.editAiAvailable で
    // 一括判定する (どのモードにも効くため、ここで重複して弾かない)。
    // 人物画像以外では結果が出ない点は実行時に Rust 側が日本語エラーで案内する。
    availability: () => ({ ok: true }),
  },
];

export function findEditMode(id: EditModeId): EditMode {
  const mode = EDIT_MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`unknown edit mode: ${id}`);
  return mode;
}
