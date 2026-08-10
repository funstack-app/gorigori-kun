/**
 * 実装契約O (2026-08-05) の牙: O2「出力サイズの統一」/ O3「テーマ入りファイル名」。
 *
 * ## 何を守っているか
 *
 * O2: **どの出口から出しても 3:4（2160×2880）になる**こと。
 *     壊れ方は「新しい出口を足したのに正規化を通し忘れる」。実際 2026-08-05 まで
 *     プロジェクト（ギャラリー）登録の経路が素通りで、作品内でページの形が
 *     揃わない実感の原因になっていた。出口の一覧をテストで固定する。
 *
 * O3: テーマがあれば `<テーマ>_p03of08.png`、無ければ従来の連番へ落ちること。
 *     壊れ方は「日本語を安全化で全部消してしまう」。既存の toSafeSegment は
 *     日本語を必ず空文字にするため、そちらを使うと全ページが同名になる。
 */
import { describe, expect, it } from "vitest";

import {
  buildComicPageFileName,
  containRect,
  COMIC_EXPORT_TARGET,
  toThemeSegment,
} from "../src/lib/comic/exportSize";

describe("O2: 出力サイズ 3:4 の統一", () => {
  it("T-O2-1: 規格は 3:4・contain・白帯（比率を変えない）", () => {
    // 2026-08-07 コミット95f5ea0 で 3:4(2160×2880) へ変更確定（旧決定 4:5 を上書き）。
    // 作業寸法1080×1440と同じ比率へ揃え、縦横2倍の高解像度で書き出す。
    expect(COMIC_EXPORT_TARGET.width / COMIC_EXPORT_TARGET.height).toBeCloseTo(3 / 4, 10);
    expect(COMIC_EXPORT_TARGET.mode).toBe("contain");
  });

  it("T-O2-2: モデル出力が揺れても canvas の比率は常に 3:4 に収まる", () => {
    // 実測で揺れる代表寸法（2:3 と 3:4）と、正方形・横長も混ぜる。
    const inputs = [
      [1024, 1536], // 2:3
      [1024, 1365], // 3:4 相当
      [1080, 1350], // 4:5（旧規格）
      [1200, 1200], // 正方形
      [1920, 1080], // 横長
    ];
    for (const [w, h] of inputs) {
      const r = containRect(w, h, COMIC_EXPORT_TARGET.width, COMIC_EXPORT_TARGET.height);
      // 出力面（canvas）は常に規格どおり = 揃う
      expect(COMIC_EXPORT_TARGET.width).toBe(2160);
      expect(COMIC_EXPORT_TARGET.height).toBe(2880);
      // 中身は切られない（contain: 枠内に完全に収まる）
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.width);
      expect(r.y + r.h).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.height);
      // 元の比率が保たれる（歪ませない）
      expect(r.w / r.h).toBeCloseTo(w / h, 2);
    }
  });

  it("T-O2-3: 作業ページは白帯なしで2倍に拡大され、別比率は中央配置になる", () => {
    // 3:4の作業ページ(1080×1440)は出力全面へ拡大される = 白帯が出ない
    const page = containRect(1080, 1440, COMIC_EXPORT_TARGET.width, COMIC_EXPORT_TARGET.height);
    expect(page).toEqual({ x: 0, y: 0, w: 2160, h: 2880 });

    // 別比率(4:5)は縦横比を保ったまま中央へ。切られず、帯は上下に均等
    const other = containRect(540, 675, COMIC_EXPORT_TARGET.width, COMIC_EXPORT_TARGET.height);
    expect(other.w / other.h).toBeCloseTo(540 / 675, 2);
    expect(other.x).toBe((COMIC_EXPORT_TARGET.width - other.w) / 2);
    expect(other.y).toBe((COMIC_EXPORT_TARGET.height - other.h) / 2);
    expect(other.w).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.width);
    expect(other.h).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.height);
  });
});

describe("O3: テーマ＋ページ数のファイル名", () => {
  it("T-O3-1: 日本語テーマがファイル名に残る（連番だけにしない）", () => {
    const theme = toThemeSegment("勇者の朝");
    expect(theme).toBe("勇者の朝");
    expect(
      buildComicPageFileName({ theme: theme!, page: 3, total: 8, ext: "png" }),
    ).toBe("勇者の朝_p03of8.png");
  });

  it("T-O3-2: ページ番号は総数に応じてゼロ埋めされる（一覧順を保つ）", () => {
    const names = [1, 10, 100].map((page) =>
      buildComicPageFileName({ theme: "話", page, total: 100, ext: "png" }),
    );
    expect(names).toEqual(["話_p001of100.png", "話_p010of100.png", "話_p100of100.png"]);
    // ソートしても生成順のまま = ゼロ埋めが効いている
    expect([...names].sort()).toEqual(names);
  });

  it("T-O3-3: OS 禁止文字・改行は落ちる（壊れたパスを作らない）", () => {
    const theme = toThemeSegment('ある朝\n"転生"/した:話');
    expect(theme).not.toBeNull();
    expect(theme!).not.toMatch(/[\\/:*?"<>|\n\r\t]/);
  });

  it("T-O3-4: 長いあらすじは切り詰められる（パス長で壊さない）", () => {
    const theme = toThemeSegment("あ".repeat(200));
    expect(theme).not.toBeNull();
    expect(theme!.length).toBeLessThanOrEqual(20);
  });

  it("T-O3-5: テーマが空・記号だけなら null（推測で埋めない＝連番へ落とす）", () => {
    expect(toThemeSegment("")).toBeNull();
    expect(toThemeSegment("   ")).toBeNull();
    expect(toThemeSegment("///:::")).toBeNull();
  });
});
