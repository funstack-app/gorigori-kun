/**
 * 品質回帰ハーネスの fixture ローダ。
 *
 * fixture 構造 (tests-quality/fixtures/<name>/):
 * - image.png          … リポジトリ内の既存素材から選定した固定画像 (6枚)。
 *                        将来の実モデルE2E (SAM3/OCR/LaMa) の入力として使う固定資産。
 * - decomposition.json … その画像型に対する分解出力の契約 (recorded-contract)。
 *                        ジャンル分類・レイヤーツリー構造の回帰はこの契約を駆動源にする。
 *
 * なぜ契約駆動か: 実モデル分解は数GBのモデルDLが必須で CI では回せない
 * (src-tauri の E2E probe 10本が ignored なのと同じ制約)。構造ロジック
 * (分類器・ツリー化・メタ変換) は決定論なので、契約 fixture だけで毎回検査できる。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LayerGenreName = "person" | "text" | "background" | "prop";

export type FixtureObject = {
  /** SAM3 プロンプト (英語)。codexVision.listObjects の en と同形。 */
  en: string;
  /** レイヤー名 (日本語)。 */
  ja: string;
  /** Codex vision が返す大ジャンル。無い場合は決定論分類器のフォールバックを検査する。 */
  category?: LayerGenreName;
  /** この物体が最終的に入るべき大ジャンル (契約)。 */
  expectedGenre: LayerGenreName;
};

export type DecompositionFixture = {
  fixture: string;
  dodCase: string;
  source: string;
  kind: "recorded-contract";
  note?: string;
  image: { file: string };
  objects: FixtureObject[];
  textLayerCount: number;
  hasBackground: boolean;
  expectedGenreCounts: Record<LayerGenreName, number>;
};

// package.json が "type": "module" のため __dirname は使えない (ESM)。
export const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

/** gap-audit §4 で確定したテスト画像セットの枚数。fixture の増減は契約変更 = 明示コミットで行う。 */
export const EXPECTED_FIXTURE_COUNT = 6;

export function listFixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function fixturePath(name: string, file: string): string {
  return path.join(FIXTURES_DIR, name, file);
}

export function loadFixture(name: string): DecompositionFixture {
  const raw = fs.readFileSync(fixturePath(name, "decomposition.json"), "utf-8");
  return JSON.parse(raw) as DecompositionFixture;
}

export function loadAllFixtures(): DecompositionFixture[] {
  return listFixtureNames().map(loadFixture);
}

/** PNG シグネチャ (先頭8バイト)。画像 fixture の破損検知に使う。 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readFixtureImage(name: string, file: string): Buffer {
  return fs.readFileSync(fixturePath(name, file));
}
