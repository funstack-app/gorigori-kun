/**
 * 画像→3Dシーン再構成: codex vision が返すレイアウト JSON の決定論バリデータ。
 *
 * Rust 側 (`codex_analyze_scene_layout`) は生 JSON 文字列を返すだけで検証しない
 * (未信頼入力の検証を呼び出し側1箇所に集約する方針)。この関数がその1箇所。
 *
 * 方針:
 * - kind は `SceneEntityKind` のホワイトリスト照合。載っていない値は box へ降格 (寸法で表現できるため)。
 *   ただし kind そのものが欠落・非文字列のエントリは破棄する (何を置くべきか判断材料が無い)。
 * - 数値は clamp。座標 ±20m / 寸法 0.1〜30m / カメラ距離・高さも同様に有限化する。
 * - lensMm は `LENS_PRESETS_MM` へ最近傍丸め (プロンプトで指示済みだが AI 出力は信用しない)。
 * - 捨てた件数・降格した件数を返す。黙って捨てず UI で件数を告知するため
 *   (no-silent-gap-filling)。
 */
import { LENS_PRESETS_MM, type SceneEntityKind } from "./types";

/** 解析 JSON が使ってよい kind。`SceneEntityKind` の部分集合 (stairs は1枚絵から推定困難なので出さない)。 */
const ALLOWED_KINDS = [
  "box",
  "wall",
  "column",
  "table",
  "chair",
  "sofa",
  "bed",
  "shelf",
  "pedestal",
  "car",
  "tree",
  "streetlight",
  "building",
  "sphere",
] as const satisfies readonly SceneEntityKind[];

/**
 * 種類ごとの基準寸法 [幅, 高さ, 奥行] (m) — r3 追補4。
 *
 * 値は Scene3dViewport.tsx の各コンポーネントが実際に描くジオメトリの実測。
 * ビューポートは `box` / `wall` / `building` 以外の kind で `params` を読まず、
 * 固定ジオメトリを `<group scale={entity.scale}>` で包むだけなので、
 * **解析寸法を表示へ届ける唯一の経路が uniform scale** になる。
 * 基準寸法 × scale ≒ 解析寸法 となる scale をここから逆算する。
 *
 * `box` / `wall` は params 経由で寸法をそのまま反映できるため、この表を持たない
 * (scale は 1 のままで、width/height/depth が直接効く)。
 */
const BASE_SIZE_M: Partial<Record<SceneEntityKind, readonly [number, number, number]>> = {
  // Table: 天板 1.4 x 0.05 x 0.8、脚で総高 0.77
  table: [1.4, 0.77, 0.8],
  // Chair: 座面 0.45角、背もたれ天端 1.05
  chair: [0.45, 1.05, 0.45],
  // Sofa: 本体 1.8 x 0.45 x 0.85、背もたれ天端 0.87
  sofa: [1.8, 0.87, 0.85],
  // Bed: マット 1.1 x 0.4 x 2.0、ヘッドボード天端 0.9
  bed: [1.1, 0.9, 2.0],
  // Shelf: 側板 1.8 高・棚板 0.9 幅・奥行 0.35
  shelf: [0.92, 1.8, 0.35],
  // Pedestal: 円柱 r=0.36 / 高さ 1.0
  pedestal: [0.72, 1.0, 0.72],
  // Car: 車体 1.8 x 4.2、ルーフ天端 1.2
  car: [1.8, 1.2, 4.2],
  // Column: 円柱 r=0.26 / 高さ 3
  column: [0.52, 3.0, 0.52],
  // Tree: 樹冠を含めた外形 (幹 1.8 + 樹冠 中心 2.2 / r=0.85 → 天端 ~3.05)
  tree: [1.9, 3.05, 1.9],
  // Streetlight: 支柱 4.4、アーム先端まで含めた外形
  streetlight: [0.9, 4.65, 0.9],
  // Sphere: r=0.5 の球 (中心 y=0.5)
  sphere: [1.0, 1.0, 1.0],
};

/** uniform scale の下限・上限。極端な倍率は1枚絵の推定として信用しない。 */
const SCALE_MIN = 0.2;
const SCALE_MAX = 5;

/**
 * 解析寸法 ÷ 基準寸法 から uniform scale を求める。
 *
 * 3軸の比の**中央値**を採る。1枚絵の推定では奥行きが特に外れやすく、平均だと
 * その1軸に引きずられるため。基準寸法表に無い kind は null (呼び出し元が box へ降格する)。
 */
function uniformScaleFor(
  kind: SceneEntityKind,
  width: number,
  height: number,
  depth: number,
): number | null {
  const base = BASE_SIZE_M[kind];
  if (!base) return null;
  const ratios = [width / base[0], height / base[1], depth / base[2]]
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return null;
  const median =
    ratios.length % 2 === 1
      ? ratios[(ratios.length - 1) / 2]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
  if (!Number.isFinite(median) || median <= 0) return null;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, median));
}

/** 床平面座標の上限 (m)。これを超える配置は 1枚絵の推定として信用しない。 */
const FLOOR_LIMIT_M = 20;
/** プリミティブ寸法の下限・上限 (m)。 */
const SIZE_MIN_M = 0.1;
const SIZE_MAX_M = 30;
/** objects の最大件数 (プロンプトの指示と同値。超過分は破棄してカウントする)。 */
const MAX_OBJECTS = 12;

export type SceneLayoutPerson = {
  floorX: number;
  floorZ: number;
  rotationYDeg: number;
};

export type SceneLayoutObject = {
  kind: SceneEntityKind;
  label: string;
  floorX: number;
  floorZ: number;
  rotationYDeg: number;
  width: number;
  height: number;
  depth: number;
  /**
   * 解析寸法を実表示へ届けるための uniform scale (r3 追補4)。
   *
   * `box` / `wall` は params(width/height/depth) がそのまま描画に効くので 1。
   * それ以外の kind は固定ジオメトリなので、基準寸法からの倍率をここに載せる。
   */
  scale: number;
};

export type SceneLayoutCamera = {
  azimuthDeg: number;
  distanceM: number;
  heightM: number;
  lensMm: number;
};

export type SceneLayoutDraft = {
  person: SceneLayoutPerson | null;
  objects: SceneLayoutObject[];
  camera: SceneLayoutCamera;
  /** 検証で破棄したエントリ数 (UI で「N件は読み取れませんでした」と告知する)。 */
  dropped: number;
  /** kind が未知で box に降格したエントリ数 (UI で「N件は近似形状にしました」と告知する)。 */
  demoted: number;
};

/** カメラの既定値。camera が壊れていても配置だけは活かせるようにする。 */
const DEFAULT_CAMERA: SceneLayoutCamera = {
  azimuthDeg: 0,
  distanceM: 4,
  heightM: 1.5,
  lensMm: 35,
};

/** 寸法の既定値 (kind 非依存の汎用ブロック)。欠落時はこれで置く。 */
const DEFAULT_SIZE_M = 1;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 角度は clamp ではなく (-180, 180] へ正規化する (回転は循環量なので端で潰すと意味が変わる)。 */
function normalizeDegrees(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** lensMm を LENS_PRESETS_MM の最近傍へ丸める。同距離なら短い方 (広角側) を採る。 */
function snapLens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CAMERA.lensMm;
  let best = LENS_PRESETS_MM[0] as number;
  let bestDelta = Math.abs(value - best);
  for (const preset of LENS_PRESETS_MM) {
    const delta = Math.abs(value - preset);
    if (delta < bestDelta) {
      best = preset;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * コードフェンス・前置き・後置きを剥がして JSON 本体を取り出す。
 * Codex はフォーマット指示をしても ```json フェンスや前置きを混ぜることがある
 * (`parse_object_words` が同じ理由で最初の '[' 〜 最後の ']' を読んでいる)。
 */
function extractJsonObject(raw: string): string | null {
  const withoutFence = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return withoutFence.slice(start, end + 1);
}

function parsePerson(value: unknown): SceneLayoutPerson | null {
  if (!value || typeof value !== "object") return null;
  const src = value as Record<string, unknown>;
  return {
    floorX: clampNumber(src.floorX, -FLOOR_LIMIT_M, FLOOR_LIMIT_M, 0),
    floorZ: clampNumber(src.floorZ, -FLOOR_LIMIT_M, FLOOR_LIMIT_M, 0),
    rotationYDeg: normalizeDegrees(src.rotationYDeg),
  };
}

function parseCamera(value: unknown): SceneLayoutCamera {
  if (!value || typeof value !== "object") return { ...DEFAULT_CAMERA };
  const src = value as Record<string, unknown>;
  return {
    azimuthDeg: normalizeDegrees(src.azimuthDeg),
    // 距離0は「カメラが被写体の中にいる」状態で描画が破綻するので下限を持たせる。
    distanceM: clampNumber(src.distanceM, 0.5, FLOOR_LIMIT_M * 2, DEFAULT_CAMERA.distanceM),
    // 地面より下・高すぎるクレーンは1枚絵の推定として信用しない。
    heightM: clampNumber(src.heightM, 0, SIZE_MAX_M, DEFAULT_CAMERA.heightM),
    lensMm: snapLens(src.lensMm),
  };
}

/**
 * codex vision の生出力を検証済みのレイアウト草案へ変換する。
 * JSON として読めない・オブジェクトでない場合のみ null を返す (推測で埋めない)。
 */
export function parseSceneLayout(raw: string): SceneLayoutDraft | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;

  let dropped = 0;
  let demoted = 0;

  const rawObjects = Array.isArray(root.objects) ? root.objects : [];
  const objects: SceneLayoutObject[] = [];
  for (const entry of rawObjects) {
    if (objects.length >= MAX_OBJECTS) {
      // 上限超過も「捨てた」として数える (黙って切り捨てない)。
      dropped += 1;
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }
    const src = entry as Record<string, unknown>;
    const rawKind = typeof src.kind === "string" ? src.kind.trim().toLowerCase() : "";
    if (rawKind === "") {
      // kind が無いエントリは何を置くべきか決められないので破棄する。
      dropped += 1;
      continue;
    }
    let kind: SceneEntityKind;
    if ((ALLOWED_KINDS as readonly string[]).includes(rawKind)) {
      kind = rawKind as SceneEntityKind;
    } else {
      // 未知の種類は box へ降格 (寸法で表現できる)。件数は UI へ告知する。
      kind = "box";
      demoted += 1;
    }
    const label = typeof src.label === "string" && src.label.trim() !== "" ? src.label.trim() : kind;
    const width = clampNumber(src.width, SIZE_MIN_M, SIZE_MAX_M, DEFAULT_SIZE_M);
    const height = clampNumber(src.height, SIZE_MIN_M, SIZE_MAX_M, DEFAULT_SIZE_M);
    const depth = clampNumber(src.depth, SIZE_MIN_M, SIZE_MAX_M, DEFAULT_SIZE_M);

    // r3 追補4: 解析寸法を実表示へ届ける。
    // - box / wall は params が直接描画に効くので scale=1 のまま
    // - 基準寸法表にある kind は uniform scale へ変換
    // - どちらでもない kind は寸法が表示へ届かないので box へ降格し、件数を計上する
    //   (黙って寸法を捨てない。no-silent-gap-filling)
    let scale = 1;
    if (kind !== "box" && kind !== "wall") {
      const computed = uniformScaleFor(kind, width, height, depth);
      if (computed === null) {
        kind = "box";
        demoted += 1;
      } else {
        scale = computed;
      }
    }

    objects.push({
      kind,
      label,
      floorX: clampNumber(src.floorX, -FLOOR_LIMIT_M, FLOOR_LIMIT_M, 0),
      floorZ: clampNumber(src.floorZ, -FLOOR_LIMIT_M, FLOOR_LIMIT_M, 0),
      rotationYDeg: normalizeDegrees(src.rotationYDeg),
      width,
      height,
      depth,
      scale,
    });
  }

  const person = parsePerson(root.person);

  // 人物も物体も1件も無い結果は「解析できた」とみなさない (Sol 評価 blocking B-5)。
  // `{}` や person/objects を丸ごと落とした出力を成功として通すと、初期シーンで
  // 置換が走って**人物が消えた空シーン**が「成功」として着地する。
  // 呼び出し元 (sceneFromImage) は null を受けて1回だけ再問い合わせし、
  // それでも空ならジョブ失敗として正直に出す。
  if (!person && objects.length === 0) return null;

  return {
    person,
    objects,
    camera: parseCamera(root.camera),
    dropped,
    demoted,
  };
}
