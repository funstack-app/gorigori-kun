export type EditLayer = {
  id: string;
  name: string;
  imagePath: string;
  visible: boolean;
  selected: boolean;
  createdAt: number;
};

export type RegenerateLayerArgs = {
  /** 編集対象として選ばれたレイヤー。alpha チャンネルからマスクを生成する。 */
  layer: EditLayer;
  /** 元画像 (レイヤー分解前の sourceImagePath)。これを編集対象としてマスクと一緒に渡す。 */
  sourceImagePath: string;
  prompt: string;
  /** 同じ画像から派生した全レイヤー。harmonize=true のとき、selected 以外の visible レイヤーを追加参照に渡す。 */
  allLayers: EditLayer[];
  /** true のとき、他の visible レイヤーを参照画像として渡す（光・色・スケールの調和を期待）。 */
  harmonize: boolean;
  cwd?: string;
  model?: string;
  effort?: string;
  aspect?: string;
};

export type EditModelCategory =
  | "ocr"
  | "inpaint"
  | "segment"
  | "samClick"
  | "humanParse";

/**
 * レイヤー分解モード ID。Rust の edit_magic_run(mode) と一致させること。
 * ここ (依存の葉ノードである types.ts) に置く理由: ipc.ts と edit/modes.ts の
 * 両方が参照するため、modes.ts に置くと ipc → modes → ipc の循環依存になる。
 */
export type EditModeId = "standard" | "highQuality";

export type ModelStatus = {
  id: string;
  displayName: string;
  category: EditModelCategory;
  sizeBytes: number;
  downloaded: boolean;
  localPath: string | null;
};

export type EditModelProgress =
  | { kind: "started"; modelId: string; totalBytes: number }
  | {
      kind: "progress";
      modelId: string;
      downloadedBytes: number;
      totalBytes: number;
    }
  | { kind: "completed"; modelId: string; filePath: string }
  | { kind: "failed"; modelId: string; reason: string };

export type SegmentResult = {
  width: number;
  height: number;
  foregroundPath: string;
  backgroundPath: string;
  maskPath: string;
};

export type MaskPayload = {
  maskBase64: string;
  width: number;
  height: number;
};

/**
 * マジックグラブ (Canva Magic Grab 相当) の結果。Rust edit_grab_object と一致 (camelCase)。
 * - objectPng: マスク bbox にクロップした掴めるオブジェクトの透過 PNG。
 * - bbox: 元画像ピクセル座標の [x, y, width, height]。この位置に objectPng を置く。
 * - filledBackground: 掴んだ跡地を LaMa で補完した背景画像。背景レイヤーをこれに差し替える。
 */
export type GrabResult = {
  objectPng: string;
  bbox: [number, number, number, number];
  filledBackground: string;
  width: number;
  height: number;
};

export type TextRegion = {
  id: string;
  bbox: [number, number, number, number];
  polygon: Array<[number, number]>;
  text: string;
  confidence: number;
  language?: string | null;
};

export type InpaintRequest = {
  inputPath: string;
  maskPath: string;
  projectName?: string | null;
};

export type TextLayerSpec = {
  id?: string;
  name?: string;
  text: string;
  font?: string;
  size?: number;
  color?: string;
  x?: number;
  y?: number;
  opacity?: number;
  visible?: boolean;
  rotation?: number;
  /** @phase4 Phase 4 で追加: テキスト再描画用の詳細フィールド */
  bbox?: [number, number, number, number];
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  align?: "left" | "center" | "right";
};

export type FontInfo = {
  family: string;
  displayName: string;
  style: string;
  languageTags: string[];
};

/** 高精度モードで認識した人物パーツ 1 件 = キャンバス上の 1 レイヤー。 */
export type PartLayerSpec = {
  classId: number;
  label: string;
  imagePath: string;
  pixelCount: number;
};

/**
 * 標準モードで SAM2 自動分解した「人物・テキスト以外の主要物体」1 件 = 1 レイヤー。
 * grab と同じ形式 (bbox クロップ透過 PNG)。Rust ObjectLayerSpec と一致 (camelCase)。
 */
export type ObjectLayerSpec = {
  /** マスク bbox にクロップした透過 PNG のパス。 */
  imagePath: string;
  /** 元画像ピクセル座標での [x, y, width, height]。この位置に置く。 */
  bbox: [number, number, number, number];
  /** 表示名 ("物体 1"…)。日本語・絵文字なし。 */
  label: string;
};

export type MagicLayerResult = {
  backgroundPath: string;
  foregroundPath: string;
  maskPath: string;
  textLayers: TextLayerSpec[];
  /** 高精度モードで認識した人物パーツ群。標準モードでは空配列。 */
  partLayers: PartLayerSpec[];
  /** 標準モードで SAM2 自動分解した主要物体レイヤー群。物体分解 OFF / 高精度では空配列。 */
  objectLayers: ObjectLayerSpec[];
  width: number;
  height: number;
  runDir: string;
};

export type MagicLayerProgressKind =
  | "started"
  | "detectingText"
  | "removingText"
  | "segmenting"
  | "segmentingObjects"
  | "inpaintingBackground"
  | "buildingTextLayers"
  | "completed"
  | "failed";

export type MagicLayerProgress =
  | { kind: Exclude<MagicLayerProgressKind, "failed"> }
  | { kind: "failed"; reason: string };

export type ClickMaskLayer = {
  id?: string;
  name?: string;
  imagePath?: string;
  path?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  visible?: boolean;
  rotation?: number;
};

export type PsdLayerSpec =
  | {
      kind: "image";
      name: string;
      path: string;
      x: number;
      y: number;
      opacity: number;
      width?: number;
      height?: number;
    }
  | {
      kind: "text";
      name: string;
      text: string;
      font: string;
      size: number;
      color: string;
      x: number;
      y: number;
    };

export type PsdComposition = {
  width: number;
  height: number;
  layers: PsdLayerSpec[];
};
