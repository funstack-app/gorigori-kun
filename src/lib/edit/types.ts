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

export type EditModelCategory = "ocr" | "inpaint" | "segment" | "samClick";

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

export type MagicLayerResult = {
  backgroundPath: string;
  foregroundPath: string;
  maskPath: string;
  textLayers: TextLayerSpec[];
  width: number;
  height: number;
  runDir: string;
};

export type MagicLayerProgressKind =
  | "started"
  | "detectingText"
  | "removingText"
  | "segmenting"
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
