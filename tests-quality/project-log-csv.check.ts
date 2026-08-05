/**
 * プロジェクト記録 CSV (buildProjectLogCsv) の回帰テスト。
 *
 * 「どの画像をどのプロンプトで生成したか」のログを Excel で開ける形で出す
 * 契約を検査する。列数 16・BOM・CRLF・エスケープ・時系列インターリーブ・
 * 通し番号が退行したらここで止まる。
 *
 * クレジット CSV は **本体と同じ純関数 buildCreditsCsv を呼んで**出力バイト列を
 * 固定する (B4 2026-08-03。以前はテスト側の再現実装で照合しており、実装が
 * 壊れてもテストが壊れなかった)。
 */
import { expect, test } from "@playwright/test";

import {
  buildCreditsCsv,
  buildProjectLogCsv,
  CREDITS_CSV_HEADER,
  PROJECT_LOG_CSV_HEADER,
} from "../src/lib/projectLogCsv";
import type { GenerationInfo } from "../src/lib/ipc";
import type { Project, ProjectItem, StockCredit } from "../src/lib/store/projects";

const BOM = "﻿";
const EMPTY_MAP = new Map<string, GenerationInfo | undefined>();

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj-1",
    name: "テスト案件",
    items: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: "item-1",
    imagePath: "/tmp/gori/out.png",
    addedAt: Date.parse("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * 素朴な RFC4180 パーサ。CSV 本文をレコード配列 (各レコード = セル配列) に戻す。
 * セル内改行・""" エスケープを解いて原文を復元できるかの検査に使う。
 */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  return records;
}

const FULL_GENERATION: GenerationInfo = {
  prompt: "夕焼けの海辺に立つ少女",
  model: "gpt-image-1",
  modelDisplayName: "GPT Image 1",
  effort: "high",
  provider: "codex",
  kind: "image",
  refImagePaths: ["/refs/a.png", "/refs/b.png"],
  generatedAt: Date.parse("2026-08-02T10:00:00.000Z"),
};

// ── a. 実データ列検証 ───────────────────────────────────────────

test("a. generation 完備の画像が全列に反映され、動画パスは種別=生成動画になる", () => {
  const project = makeProject({
    items: [
      makeItem({ id: "img", imagePath: "/tmp/gori/out.png", generation: FULL_GENERATION, note: "メモA" }),
      makeItem({
        id: "vid",
        imagePath: "/tmp/gori/clip.MP4",
        addedAt: Date.parse("2026-08-03T00:00:00.000Z"),
      }),
    ],
  });

  const records = parseCsv(buildProjectLogCsv(project, EMPTY_MAP));
  expect(records[0].join(",")).toBe(PROJECT_LOG_CSV_HEADER);

  const image = records[1];
  expect(image[0]).toBe("生成画像");
  expect(image[2]).toBe("2026-08-02T10:00:00.000Z");
  expect(image[3]).toBe("");
  expect(image[4]).toBe("夕焼けの海辺に立つ少女");
  expect(image[5]).toBe("out.png");
  expect(image[6]).toBe("/tmp/gori/out.png");
  expect(image[7]).toBe("GPT Image 1");
  expect(image[8]).toBe("high");
  expect(image[9]).toBe("codex");
  expect(image[10]).toBe("image");
  expect(image[11]).toBe("/refs/a.png\n/refs/b.png");
  expect(image[12]).toBe("2026-08-01T00:00:00.000Z");
  expect(image[13]).toBe("メモA");
  expect(image[14]).toBe("テスト案件");
  expect(image[15]).toBe("prj-1");

  // 拡張子の大小は無視して動画判定する。
  expect(records[2][0]).toBe("生成動画");
});

test("a-2. modelDisplayName が無ければ model にフォールバックする", () => {
  const project = makeProject({
    items: [
      makeItem({
        generation: { ...FULL_GENERATION, modelDisplayName: undefined },
      }),
    ],
  });
  expect(parseCsv(buildProjectLogCsv(project, EMPTY_MAP))[1][7]).toBe("gpt-image-1");
});

test("a-3. generationByItemId の後追い解決結果が使われる", () => {
  const project = makeProject({ items: [makeItem({ id: "late" })] });
  const map = new Map<string, GenerationInfo | undefined>([["late", FULL_GENERATION]]);
  expect(parseCsv(buildProjectLogCsv(project, map))[1][4]).toBe("夕焼けの海辺に立つ少女");
});

// ── b. 空プロジェクト ────────────────────────────────────────────

test("b. items も planChat も空なら BOM + ヘッダ + CRLF のみ", () => {
  const csv = buildProjectLogCsv(makeProject(), EMPTY_MAP);
  expect(csv).toBe(`${BOM}${PROJECT_LOG_CSV_HEADER}\r\n`);
});

// ── c. プロンプト欠落画像 ────────────────────────────────────────

test("c. generation 欠落時も行は落とさず、prompt/日時がフォールバックする", () => {
  const project = makeProject({
    items: [
      // c-1: generation なし・item.prompt なし → 内容列は空欄
      makeItem({ id: "a", addedAt: Date.parse("2026-08-01T00:00:00.000Z") }),
      // c-2: generation なし・item.prompt あり → 内容列は item.prompt
      makeItem({
        id: "b",
        prompt: "取り込み画像の控えプロンプト",
        addedAt: Date.parse("2026-08-01T01:00:00.000Z"),
      }),
    ],
  });

  const records = parseCsv(buildProjectLogCsv(project, EMPTY_MAP));
  expect(records.length).toBe(3); // ヘッダ + 2 行 (行は落ちない)
  expect(records[1][4]).toBe("");
  expect(records[2][4]).toBe("取り込み画像の控えプロンプト");
  // c-3: 日時列は addedAt へフォールバック
  expect(records[1][2]).toBe("2026-08-01T00:00:00.000Z");
  expect(records[2][2]).toBe("2026-08-01T01:00:00.000Z");
});

// ── d. 特殊文字エスケープ ────────────────────────────────────────

test("d. カンマ・引用符・改行・先頭= を含むセルが壊れず往復する", () => {
  const nastyPrompt = 'a,b "quoted"\n二行目 =SUM(1,2)';
  const nastyChat = '返信: "はい, そうです"\n続き';
  const project = makeProject({
    items: [
      makeItem({
        generation: { ...FULL_GENERATION, prompt: nastyPrompt },
      }),
    ],
    planChat: [
      {
        id: "m1",
        role: "assistant",
        text: nastyChat,
        createdAt: Date.parse("2026-08-02T11:00:00.000Z"),
      },
    ],
  });

  const csv = buildProjectLogCsv(project, EMPTY_MAP);

  // d-1: 該当セルは "" 囲み + 内部 "" 化
  expect(csv).toContain('"a,b ""quoted""\n二行目 =SUM(1,2)"');
  // 先頭 = は無害化せず原文のまま出す (証跡性優先)。
  expect(csv).not.toContain("'=SUM");

  // d-2: \r\n で split した論理行数がレコード数 + 1 (セル内改行で割れない)
  const logicalLines = csv.split("\r\n").filter((l) => l !== "");
  expect(logicalLines.length).toBe(3); // ヘッダ + 画像1 + チャット1

  // d-3: パース逆変換で原文が完全復元される
  const records = parseCsv(csv);
  expect(records.length).toBe(3);
  const contents = records.slice(1).map((r) => r[4]);
  expect(contents).toContain(nastyPrompt);
  expect(contents).toContain(nastyChat);
});

// ── e. 企画チャット統合 ──────────────────────────────────────────

test("e. チャットと画像が日時昇順にインターリーブされ、専用列は空欄", () => {
  const project = makeProject({
    items: [
      makeItem({
        id: "img",
        generation: { ...FULL_GENERATION, generatedAt: Date.parse("2026-08-02T10:00:00.000Z") },
      }),
    ],
    planChat: [
      {
        id: "m2",
        role: "assistant",
        text: "こういう構図はどうでしょう",
        createdAt: Date.parse("2026-08-02T11:00:00.000Z"),
      },
      {
        id: "m1",
        role: "user",
        text: "夕焼けの絵がほしい",
        attachedImages: ["/refs/mood.png"],
        createdAt: Date.parse("2026-08-02T09:00:00.000Z"),
      },
    ],
  });

  const records = parseCsv(buildProjectLogCsv(project, EMPTY_MAP));
  expect(records.slice(1).map((r) => r[0])).toEqual([
    "企画チャット",
    "生成画像",
    "企画チャット",
  ]);
  expect(records.slice(1).map((r) => r[2])).toEqual([
    "2026-08-02T09:00:00.000Z",
    "2026-08-02T10:00:00.000Z",
    "2026-08-02T11:00:00.000Z",
  ]);

  const userRow = records[1];
  expect(userRow[3]).toBe("ユーザー");
  expect(userRow[4]).toBe("夕焼けの絵がほしい");
  expect(userRow[11]).toBe("/refs/mood.png"); // 添付画像は参照列を共用
  // 画像専用列 (ファイル名 5 〜 生成種別 10、追加日時 12、メモ 13) は空欄
  for (const col of [5, 6, 7, 8, 9, 10, 12, 13]) {
    expect(userRow[col], `col ${col}`).toBe("");
  }
  expect(records[3][3]).toBe("AI");
});

test("e-2. 同時刻タイは企画チャット行が生成行より先に来る", () => {
  const at = Date.parse("2026-08-02T10:00:00.000Z");
  const project = makeProject({
    items: [makeItem({ generation: { ...FULL_GENERATION, generatedAt: at } })],
    planChat: [{ id: "m", role: "user", text: "同時刻", createdAt: at }],
  });
  const records = parseCsv(buildProjectLogCsv(project, EMPTY_MAP));
  expect(records[1][0]).toBe("企画チャット");
  expect(records[2][0]).toBe("生成画像");
});

// ── f. 通し番号 ─────────────────────────────────────────────────

test("f. 番号列がソート後の並びで 1..N の連番になる", () => {
  const project = makeProject({
    items: [
      makeItem({ id: "a", addedAt: Date.parse("2026-08-02T03:00:00.000Z") }),
      makeItem({ id: "b", addedAt: Date.parse("2026-08-02T01:00:00.000Z") }),
    ],
    planChat: [
      { id: "m", role: "user", text: "hi", createdAt: Date.parse("2026-08-02T02:00:00.000Z") },
    ],
  });
  const records = parseCsv(buildProjectLogCsv(project, EMPTY_MAP));
  expect(records.slice(1).map((r) => r[1])).toEqual(["1", "2", "3"]);
});

// ── DoD 3. Excel で開ける形式の機械検証 ──────────────────────────

test("3. 先頭 BOM・全行 CRLF・全行 16 列が保たれる", () => {
  const project = makeProject({
    items: [
      makeItem({ generation: { ...FULL_GENERATION, prompt: 'カンマ, と "引用"\n改行' } }),
      makeItem({ id: "v", imagePath: "/tmp/a.mp4" }),
    ],
    planChat: [
      { id: "m", role: "user", text: "改行\nあり", createdAt: Date.parse("2026-08-02T00:00:00.000Z") },
    ],
  });
  const csv = buildProjectLogCsv(project, EMPTY_MAP);

  expect(csv.startsWith(BOM)).toBe(true);
  // 行区切りはすべて CRLF (裸の \n はセル内改行としてクォート内にしか無い)。
  expect(csv.endsWith("\r\n")).toBe(true);
  expect(csv.replace(/\r\n/g, "")).not.toContain("\r");

  const records = parseCsv(csv);
  expect(records.length).toBe(4);
  for (const [i, record] of records.entries()) {
    expect(record.length, `record ${i} の列数`).toBe(16);
  }
  expect(PROJECT_LOG_CSV_HEADER.split(",").length).toBe(16);
});

// ── DoD 4. クレジット CSV の出力バイト列が不変 ───────────────────

test("4. クレジット CSV の組み立て結果が既知の期待文字列と一致する", () => {
  // B4 (2026-08-03): 以前はストア内メソッドを直接呼べないという理由で、
  // テスト側が同じ組み立てを再実装して照合していた。それでは実装が壊れても
  // テストは壊れず、回帰検知の牙が無い。組み立てを純関数 buildCreditsCsv
  // (projectLogCsv.ts) へ切り出し、**store 本体とテストが同じ関数を呼ぶ**。
  const credits: StockCredit[] = [
    {
      provider: "pexels",
      photoId: "12345",
      author: 'Jane Doe, Jr. "JD"',
      sourceUrl: "https://example.com/p/12345",
      localPath: "/tmp/stock/12345.jpg",
      addedAt: Date.parse("2026-08-02T10:00:00.000Z"),
    },
    {
      provider: "pexels",
      photoId: "67890",
      author: "山田 太郎",
      addedAt: Date.parse("2026-08-02T11:00:00.000Z"),
    },
  ];

  const csv = buildCreditsCsv(credits, { id: "prj-1", name: "テスト案件" });

  // 出力バイト列を固定する (切り出し前の実装と 1 バイトも変わらないこと)。
  expect(csv).toBe(
    "provider,photo_id,author,source_url,local_path,added_at_iso,project_id,project_name\n" +
      'pexels,12345,"Jane Doe, Jr. ""JD""",https://example.com/p/12345,/tmp/stock/12345.jpg,2026-08-02T10:00:00.000Z,prj-1,テスト案件\n' +
      "pexels,67890,山田 太郎,,,2026-08-02T11:00:00.000Z,prj-1,テスト案件\n",
  );
  // BOM は付けない (呼び出し側 App.tsx が保存時に付与する) 契約も固定。
  expect(csv.startsWith(BOM)).toBe(false);
  // ヘッダ定数と実出力の先頭行が一致する (定数だけ直す退行を止める)。
  expect(csv.split("\n")[0]).toBe(CREDITS_CSV_HEADER);
});

test("4b. クレジットが 0 件・未定義でもヘッダ行だけは出る", () => {
  const empty = buildCreditsCsv([], { id: "prj-1", name: "テスト案件" });
  expect(empty).toBe(`${CREDITS_CSV_HEADER}\n`);
  // stockCredits 未設定 (旧データ) も同じ扱い。
  expect(buildCreditsCsv(undefined, { id: "prj-1", name: "テスト案件" })).toBe(
    `${CREDITS_CSV_HEADER}\n`,
  );
});

test("4c. プロジェクト名のカンマ・引用符・改行がエスケープされる", () => {
  // csvEscape を通っていることを、純関数の出力で直に確かめる
  // (テスト側で csvEscape を再実装しない)。
  const csv = buildCreditsCsv(
    [
      {
        provider: "pexels",
        photoId: "1",
        author: "A",
        addedAt: Date.parse("2026-08-02T10:00:00.000Z"),
      },
    ],
    { id: "prj,1", name: '案件 "X"\n改行' },
  );
  const dataRow = csv.split("\n").slice(1).join("\n");
  expect(dataRow).toContain('"prj,1"');
  expect(dataRow).toContain('"案件 ""X""\n改行"');
});
