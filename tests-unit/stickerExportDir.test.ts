/**
 * L6: 書き出しが**専用フォルダへ集まる**ことと、**ZIP が選択状態で開く**ことの検査。
 *
 * ## 何が起きていたか（2026-08-05 STΛCK実機FB）
 *
 * ZIP は作られていた（`~/Downloads/line-stickers.zip`）。だが選んだフォルダの直下へ
 * 個別PNG 26枚・main.png・tab.png・作成条件.txt と横並びで置かれ、
 * ダウンロードフォルダの既存ファイルに埋もれて**見つからなかった**。
 *
 * 「作られていない」のではなく「見つからない」。だから直すのは生成側ではなく置き場所。
 */
import { describe, expect, it } from "vitest";

import {
  EXPORT_FOLDER_PREFIX,
  formatExportStamp,
  joinExportPath,
  pickExportFolderName,
} from "../src/lib/sticker/exportDir";

describe("L6: フォルダ名は人が読んで分かる形", () => {
  it("接頭辞 + 日付_時刻（ローカル時刻）になる", () => {
    // 時計に依存させない（規律3: 実行時点の値を焼かない）。呼び出し側が Date を渡す。
    const at = new Date(2026, 7, 5, 21, 39);
    expect(formatExportStamp(at)).toBe("2026-08-05_2139");
    expect(pickExportFolderName(at)).toBe(`${EXPORT_FOLDER_PREFIX}_2026-08-05_2139`);
  });

  it("1桁の月日・時分がゼロ埋めされる（並び順が崩れない）", () => {
    expect(formatExportStamp(new Date(2026, 0, 3, 4, 5))).toBe("2026-01-03_0405");
  });

  it("UTC でなくローカル時刻を使う（深夜の日付ズレを避ける）", () => {
    // 日本時間の 00:30 を UTC で解釈すると前日になる。人が探すラベルなので現地時間。
    const at = new Date(2026, 7, 5, 0, 30);
    expect(formatExportStamp(at).startsWith("2026-08-05")).toBe(true);
  });
});

describe("L6: 同じ分に2回書き出しても混ざらない", () => {
  it("同名が既にあれば連番を足す", () => {
    const at = new Date(2026, 7, 5, 21, 39);
    const base = `${EXPORT_FOLDER_PREFIX}_2026-08-05_2139`;

    expect(pickExportFolderName(at, new Set([base]))).toBe(`${base}_2`);
    expect(pickExportFolderName(at, new Set([base, `${base}_2`]))).toBe(`${base}_3`);
  });

  it("牙: 衝突を無視して同じ名前を返さない", () => {
    const at = new Date(2026, 7, 5, 21, 39);
    const base = `${EXPORT_FOLDER_PREFIX}_2026-08-05_2139`;
    const taken = new Set([base]);

    const picked = pickExportFolderName(at, taken);

    expect(
      taken.has(picked),
      "既存のフォルダ名をそのまま返している（前回の書き出しに混ざる）",
    ).toBe(false);
  });

  it("無関係な名前が入っていても素の名前を使う", () => {
    const at = new Date(2026, 7, 5, 21, 39);
    const picked = pickExportFolderName(at, new Set(["memo.txt", "画像"]));
    expect(picked).toBe(`${EXPORT_FOLDER_PREFIX}_2026-08-05_2139`);
  });
});

describe("L6: パスの連結は OS の区切りに合わせる", () => {
  it("mac / Linux は /", () => {
    expect(joinExportPath("/Users/x/Downloads", "A")).toBe("/Users/x/Downloads/A");
  });

  it("Windows は \\（/ を混ぜない）", () => {
    expect(joinExportPath("C:\\Users\\x\\Downloads", "A")).toBe(
      "C:\\Users\\x\\Downloads\\A",
    );
  });

  it("末尾の区切りが重複しない", () => {
    expect(joinExportPath("/Users/x/Downloads/", "A")).toBe("/Users/x/Downloads/A");
  });
});

describe("L6: 呼び出し側が実際にサブフォルダへ出している", () => {
  async function readSrc(relative: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    return readFile(resolve(process.cwd(), relative), "utf8");
  }

  it("選んだフォルダ直下でなく、作ったサブフォルダを outputDir に渡している", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");

    expect(src, "サブフォルダを作っていない（直下にバラ撒かれる・L6 の再発）").toContain(
      "pickExportFolderName(",
    );
    // 選択したパス（dir）をそのまま渡していたら、この改修は効いていない。
    expect(
      src,
      "選んだフォルダを直接 outputDir にしている（L6 の再発）",
    ).not.toContain("outputDir: dir,");
    expect(src, "組み立てたパスを渡していない").toContain("outputDir,");
  });

  it("「保存先を開く」が ZIP を選択状態で開く", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");

    // revealItemInDir は渡したファイルを選択状態にして親フォルダを開く。
    // フォルダを渡すと中身が並ぶだけで、どれが提出物か人が探すことになる。
    expect(src, "ZIP を優先して指していない（提出物が埋もれる・L6 の再発）").toContain(
      "res.zipPath ?? res.items[0]?.output",
    );
    expect(src, "revealItemInDir を使っていない").toContain("revealItemInDir(");
  });

  it("既存の関所（重複検査・層Aの数値）を触っていない", async () => {
    const rust = await readSrc("src-tauri/src/commands/sticker.rs");
    // 連番の完全性（D11 / T11）を守る検査が残っていること。
    expect(rust, "既存ファイルの検査が消えている").toContain("existing_sequence_files");
    // 60MB の判定はそのまま（規格の数値は今回の対象外）。
    expect(rust, "ZIP のサイズ判定が消えている").toContain("SUBMISSION_ZIP_NAME");
  });
});
