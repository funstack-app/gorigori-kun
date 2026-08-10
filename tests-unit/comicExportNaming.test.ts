/**
 * 実装契約O (2026-08-05) の牙: O2「出力サイズの統一」/ O3「テーマ入りファイル名」。
 *
 * ## 何を守っているか
 *
 * O2: **どの出口から出してもページの比率が保たれ、幅2160の高解像度になる**こと。
 *     壊れ方は「新しい出口を足したのに正規化を通し忘れる」。実際 2026-08-05 まで
 *     プロジェクト（ギャラリー）登録の経路が素通りで、作品内でページの形が
 *     揃わない実感の原因になっていた。出口の一覧をテストで固定する。
 *
 *     **2026-08-10 STΛCK決定「書き出しは固定規格でなく*テンプレサイズにあわせる*」で
 *     3:4固定（2026-08-07 コミット95f5ea0）を上書きした。**「揃う」の意味が
 *     「全ページ同じ寸法」から「ページ比率どおり・幅2160で揃う」に変わっている。
 *     テンプレが 3:4 なら従来と同じ 2160×2880、4:5 なら 2160×2700。
 *
 * O3: テーマがあれば `<テーマ>_p03of08.png`、無ければ従来の連番へ落ちること。
 *     壊れ方は「日本語を安全化で全部消してしまう」。既存の toSafeSegment は
 *     日本語を必ず空文字にするため、そちらを使うと全ページが同名になる。
 */
import { describe, expect, it } from "vitest";

import {
  buildComicPageFileName,
  comicExportSize,
  containRect,
  COMIC_EXPORT_TARGET,
  toThemeSegment,
} from "../src/lib/comic/exportSize";

describe("O2: 書き出しサイズのテンプレ比率追従", () => {
  it("T-O2-1: 3:4ページは 2160×2880（従来の規格と同値）", () => {
    expect(comicExportSize(1080, 1440)).toEqual({ width: 2160, height: 2880 });
    // 既定値の定数は 3:4・contain・白帯のまま（pad/mode の参照元として維持）
    expect(COMIC_EXPORT_TARGET.width / COMIC_EXPORT_TARGET.height).toBeCloseTo(3 / 4, 10);
    expect(COMIC_EXPORT_TARGET.mode).toBe("contain");
  });

  it("T-O2-2: 4:5ページは 2160×2700（テンプレ比率に追従する）", () => {
    expect(comicExportSize(1080, 1350)).toEqual({ width: 2160, height: 2700 });
    // 友人テンプレ(user02)のPSD実寸 2160×2700 もそのまま同値へ落ちる
    expect(comicExportSize(2160, 2700)).toEqual({ width: 2160, height: 2700 });
  });

  it("T-O2-3: どの入力でも比率が保たれ、幅は必ず2160になる", () => {
    // 実測で揺れる代表寸法（2:3 と 3:4）と、4:5・正方形・横長も混ぜる。
    const inputs = [
      [1024, 1536], // 2:3
      [1024, 1365], // 3:4 相当
      [1080, 1350], // 4:5
      [1200, 1200], // 正方形
      [1920, 1080], // 横長
    ];
    for (const [w, h] of inputs) {
      const target = comicExportSize(w, h);
      expect(target.width).toBe(2160);
      // 比率が保たれる（歪ませない）
      expect(target.width / target.height).toBeCloseTo(w / h, 2);
    }
  });

  it("T-O2-4: 追従先の枠へは白帯なしで2倍に拡大される（切り落とさない）", () => {
    for (const [w, h] of [
      [1080, 1440], // 3:4
      [1080, 1350], // 4:5
    ]) {
      const target = comicExportSize(w, h);
      const rect = containRect(w, h, target.width, target.height);
      // 出力全面へ拡大される = 白帯が出ない
      expect(rect).toEqual({ x: 0, y: 0, w: target.width, h: target.height });
    }
  });

  it("T-O2-5: 比率の違う枠へ入れるときは中央配置で切られない", () => {
    // contain のふるまい自体は不変（想定外比率の保険）。帯は上下に均等
    const other = containRect(540, 675, COMIC_EXPORT_TARGET.width, COMIC_EXPORT_TARGET.height);
    expect(other.w / other.h).toBeCloseTo(540 / 675, 2);
    expect(other.x).toBe((COMIC_EXPORT_TARGET.width - other.w) / 2);
    expect(other.y).toBe((COMIC_EXPORT_TARGET.height - other.h) / 2);
    expect(other.x).toBeGreaterThanOrEqual(0);
    expect(other.y).toBeGreaterThanOrEqual(0);
    expect(other.x + other.w).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.width);
    expect(other.y + other.h).toBeLessThanOrEqual(COMIC_EXPORT_TARGET.height);
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
