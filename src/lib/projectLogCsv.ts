/**
 * プロジェクト記録 CSV の組み立て (純関数)。
 *
 * 「この画像はこのプロンプトで生成した」というログを、企画チャットも含めて
 * 1 プロジェクト = 1 枚のシートに束ねる。単一 CSV・統一スキーマ・種別列・
 * 時系列インターリーブの方式で、Excel / Numbers / スプレッドシートの
 * フィルタで「画像だけ」「チャットだけ」に絞れるようにする。
 *
 * 画像 ⇔ 企画メッセージの 1:1 リンクは現データモデルに存在しないため、
 * 行単位の対応付けは捏造せず、プロジェクト単位の紐付け + 時系列で表現する。
 *
 * このファイルは依存ゼロ (zustand / @tauri-apps を import しない)。型は
 * type-only import のみなので、Playwright quality check から直接 import して
 * 回帰検査できる。
 */
import type { GenerationInfo } from "./ipc";
import type { Project, ProjectChatMessage, ProjectItem } from "./store/projects";

/** プロジェクト記録 CSV のヘッダ行 (16 列)。 */
export const PROJECT_LOG_CSV_HEADER =
  "種別,番号,日時(ISO),発言者,内容(プロンプト・発言),ファイル名,画像パス,モデル,思考レベル,生成元(provider),生成種別(kind),参照・添付画像,プロジェクト追加日時(ISO),メモ,プロジェクト名,プロジェクトID";

/** 動画として扱う拡張子。種別列を「生成動画」に切り替える判定に使う。 */
const VIDEO_EXTENSION_RE = /\.(mp4|mov|webm|m4v)$/i;

/**
 * CSV の 1 セルをエスケープする。
 *  - カンマ / 改行 / ダブルクォートのいずれかが含まれていたら全体を "" で囲む
 *  - 内部のダブルクォートは "" にエスケープ
 *
 * 法務対応 (2026-05-21): credits.csv エクスポートで使用。
 *   著者名にカンマや日本語の括弧が入る可能性があるため、必須。
 */
export function csvEscape(value: string): string {
  if (value === "") return "";
  const needsQuote = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

export function imageFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** クレジット CSV のヘッダ行 (8 列)。 */
export const CREDITS_CSV_HEADER =
  "provider,photo_id,author,source_url,local_path,added_at_iso,project_id,project_name";

/**
 * buildCreditsCsv の入力 1 行分 (store の StockCredit の構造部分集合)。
 *
 * `StockCredit` 型そのものを import しないのは、projects.ts が本ファイルを
 * import しており循環参照になるため。構造だけを受け取れば CSV 組み立てには
 * 十分で、store 側は StockCredit をそのまま渡せる (構造的部分型)。
 */
export type CreditCsvRow = {
  provider: string;
  photoId: string;
  author: string;
  sourceUrl?: string;
  localPath?: string;
  /** epoch ミリ秒。ISO8601 に変換して出力する。 */
  addedAt: number;
};

/**
 * ストック素材クレジットの CSV を組み立てる (純関数)。
 *
 * 表計算ソフトとの互換重視で **UTF-8 BOM を付けない**素の CSV を返す。
 * BOM 付きが必要な呼び出し側 (Excel 日本語環境) はファイル保存時に
 * 先頭へ "﻿" を付ける。
 *
 * クレジットが 0 件でもヘッダ行だけは返す (「クレジット不要の素材しか
 * 使っていない」ことを示す証跡になるため、空ファイルにはしない)。
 *
 * store のメソッド (useProjects.buildCreditsCsv) から切り出した理由 (B4
 * 2026-08-03): zustand ストア内のメソッドはテストから直接呼べず、
 * テスト側が同じ組み立てを再実装して検査していた。それでは実装が壊れても
 * テストが一緒に壊れないため回帰検知の牙が無い。本体とテストが**同じ関数**を
 * 呼ぶようにして、出力バイト列を固定する。
 */
export function buildCreditsCsv(
  credits: readonly CreditCsvRow[] | undefined,
  project: { id: string; name: string },
): string {
  if (!credits || credits.length === 0) {
    return `${CREDITS_CSV_HEADER}\n`;
  }
  const rows = credits.map((c) =>
    [
      csvEscape(c.provider),
      csvEscape(c.photoId),
      csvEscape(c.author),
      csvEscape(c.sourceUrl ?? ""),
      csvEscape(c.localPath ?? ""),
      csvEscape(new Date(c.addedAt).toISOString()),
      csvEscape(project.id),
      csvEscape(project.name),
    ].join(","),
  );
  return `${CREDITS_CSV_HEADER}\n${rows.join("\n")}\n`;
}

export function toIsoOrEmpty(value: number | undefined): string {
  if (value == null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * ソート前の中間表現。epoch ミリ秒と種別の優先度を持ち、番号列だけは
 * ソート後に振る (通し番号は最終的な並び順で 1 起点の連番になる)。
 */
type LogRow = {
  /** ソートキー (epoch ミリ秒)。取得できない場合は 0 として先頭に置く。 */
  sortAt: number;
  /** 同時刻タイの優先度。企画チャット行 (0) が生成行 (1) より先。 */
  tieBreak: number;
  /** 番号列を除いた 15 セル (エスケープ前の生値)。番号は後から差し込む。 */
  cells: string[];
};

function buildItemRow(
  item: ProjectItem,
  generation: GenerationInfo | undefined,
  project: Project,
): LogRow {
  const kindLabel = VIDEO_EXTENSION_RE.test(item.imagePath) ? "生成動画" : "生成画像";
  // 日時は生成日時を優先し、無ければプロジェクト追加日時にフォールバックする
  // (ダブルクリック表示 ImageMetaPanel と同じ考え方)。
  const at = generation?.generatedAt ?? item.addedAt;
  return {
    sortAt: typeof at === "number" && Number.isFinite(at) ? at : 0,
    tieBreak: 1,
    cells: [
      kindLabel,
      toIsoOrEmpty(at),
      "",
      // プロンプトは generation → item.prompt → 空欄の順にフォールバックする。
      // 空欄でも行は落とさない (欠落を欠落のまま可視化する)。
      generation?.prompt ?? item.prompt ?? "",
      imageFileName(item.imagePath),
      item.imagePath,
      generation?.modelDisplayName ?? generation?.model ?? "",
      generation?.effort ?? "",
      generation?.provider ?? "",
      generation?.kind ?? "",
      generation?.refImagePaths?.join("\n") ?? "",
      toIsoOrEmpty(item.addedAt),
      item.note ?? "",
      project.name,
      project.id,
    ],
  };
}

function buildChatRow(message: ProjectChatMessage, project: Project): LogRow {
  const at = message.createdAt;
  return {
    sortAt: typeof at === "number" && Number.isFinite(at) ? at : 0,
    tieBreak: 0,
    cells: [
      "企画チャット",
      toIsoOrEmpty(at),
      message.role === "user" ? "ユーザー" : "AI",
      message.text,
      "",
      "",
      "",
      "",
      "",
      "",
      message.attachedImages?.join("\n") ?? "",
      "",
      "",
      project.name,
      project.id,
    ],
  };
}

/**
 * プロジェクトの全生成アイテム (画像・動画) と企画チャットを、
 * 1 枚の CSV (BOM 付き UTF-8 / CRLF) に束ねる。
 *
 * @param generationByItemId item.id → history.db から後追い解決した生成情報。
 *   `item.generation` が既にあればそちらを優先する。両方無ければ generation
 *   系列の列は空欄になり、内容列は `item.prompt` にフォールバックする。
 * @returns BOM + ヘッダ + 各行を CRLF で結合した完成 CSV 文字列。
 *   items も planChat も空なら「BOM + ヘッダ + CRLF」のみを返す
 *   (常にエクスポート可能。クレジット CSV と同方針)。
 */
export function buildProjectLogCsv(
  project: Project,
  generationByItemId: ReadonlyMap<string, GenerationInfo | undefined>,
): string {
  const rows: LogRow[] = [
    ...project.items.map((item) =>
      buildItemRow(item, item.generation ?? generationByItemId.get(item.id), project),
    ),
    ...(project.planChat ?? []).map((message) => buildChatRow(message, project)),
  ];

  // 日時昇順。同時刻タイは企画チャット行が先、同種内は元配列の並び順
  // (Array#sort は ES2019 以降で安定ソートが保証される)。
  rows.sort((a, b) => a.sortAt - b.sortAt || a.tieBreak - b.tieBreak);

  const lines = rows.map((row, index) => {
    const [kindLabel, ...rest] = row.cells;
    // 通し番号はソート後の並びで 1 起点の連番を振る。
    return [kindLabel, String(index + 1), ...rest].map(csvEscape).join(",");
  });

  const body = lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
  return `\uFEFF${PROJECT_LOG_CSV_HEADER}\r\n${body}`;
}
