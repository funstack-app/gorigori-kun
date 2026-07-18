/**
 * キャラクター登録 IPアセット化パイプラインの固定カタログ。
 *
 * 1枚の参照画像から「3面図 + 顔基準 + 表情セット + 顔ディテール」を並列生成する。
 * multiangle の ANGLE_CUTS が「カメラを大胆に変える構図カタログ」なのに対し、こちらは
 * 「同一人物のリファレンスシート」を作るためのカタログで、表情カットはアングルを固定し
 * 顔の同一性を最優先にする(設計書 §4-3)。
 *
 * promptFragment は Rust build_sheet_prompt に焼き込む英語表現(被写体は参照画像で固定)。
 * role は characterMeta.sheetRoles に入る役割値。
 */

export type SheetCut = {
  /** 一意ID。Rust 側の出力ファイル名・sheetRoles のキーに使う */
  cutId: string;
  /** UI 表示名(日本語) */
  label: string;
  /** 分類タグ(UIのグルーピング用) */
  group: "orthographic" | "face" | "expression" | "detail";
  /** characterMeta.sheetRoles に入る役割値 */
  role: string;
  /** 実画像生成プロンプトに焼き込む構図/表情の英語表現 */
  promptFragment: string;
};

/** カタログ上限(Rust MAX_SHEET_CUTS と一致)。セマフォ6で並列制御されるので枚数は安全。 */
export const MAX_SHEET_CUTS = 30;

/**
 * 14カット全カタログ。既定セット(DEFAULT_SHEET_CUT_IDS)は 3面図3+顔基準1+表情5+顔ディテール1 の10。
 * 4,12,13,14(三面図補強/目・手・服のディテール)は「詳しく」トグルで追加する。
 */
export const SHEET_CUTS: SheetCut[] = [
  // ── 3面図 ──
  {
    cutId: "front",
    label: "正面(全身)",
    group: "orthographic",
    role: "front",
    promptFragment:
      "full body, eye level, straight front view, A-pose, neutral expression, flat even lighting, plain light-gray studio background",
  },
  {
    cutId: "side",
    label: "横(全身)",
    group: "orthographic",
    role: "side",
    promptFragment:
      "full body, eye level, pure 90-degree right side profile, A-pose, same neutral expression, lighting and background",
  },
  {
    cutId: "back",
    label: "背面(全身)",
    group: "orthographic",
    role: "back",
    promptFragment:
      "full body, eye level, direct back view from behind, A-pose, same neutral lighting and background",
  },
  {
    cutId: "three-quarter",
    label: "斜め前(全身)",
    group: "orthographic",
    role: "three-quarter",
    promptFragment:
      "full body, eye level, front-right three-quarter 45-degree view, A-pose, same neutral expression, lighting and background",
  },
  // ── 顔基準 ──
  {
    cutId: "face-front",
    label: "顔・正面",
    group: "face",
    role: "face-front",
    promptFragment:
      "head-and-shoulders close-up, eye level, straight front, neutral expression, 85mm portrait, soft even light",
  },
  // ── 表情 ──
  {
    cutId: "expression-neutral",
    label: "表情・ニュートラル",
    group: "expression",
    role: "expression-neutral",
    promptFragment:
      "bust close-up, front, calm neutral expression, mouth closed, same face, change only the expression",
  },
  {
    cutId: "expression-smile",
    label: "表情・笑顔",
    group: "expression",
    role: "expression-smile",
    promptFragment:
      "bust close-up, front, natural warm smile, eyes slightly narrowed, same face, change only the expression",
  },
  {
    cutId: "expression-angry",
    label: "表情・怒り",
    group: "expression",
    role: "expression-angry",
    promptFragment:
      "bust close-up, front, angry expression, brows furrowed, mouth tense, same face, change only the expression",
  },
  {
    cutId: "expression-sad",
    label: "表情・悲しみ",
    group: "expression",
    role: "expression-sad",
    promptFragment:
      "bust close-up, front, sad expression, downturned mouth, soft eyes, same face, change only the expression",
  },
  {
    cutId: "expression-surprised",
    label: "表情・驚き",
    group: "expression",
    role: "expression-surprised",
    promptFragment:
      "bust close-up, front, surprised expression, wide eyes, open mouth, same face, change only the expression",
  },
  // ── ディテール ──
  {
    cutId: "face-detail",
    label: "顔ディテール",
    group: "detail",
    role: "face-detail",
    promptFragment:
      "extreme close-up of the face, macro skin, eye and hair texture detail, front, sharp focus, same identity zoom in only",
  },
  {
    cutId: "eyes-detail",
    label: "目のディテール",
    group: "detail",
    role: "eyes-detail",
    promptFragment:
      "extreme close-up of the eyes only, iris and eyelash texture, same identity zoom in only",
  },
  {
    cutId: "hands-detail",
    label: "手のディテール",
    group: "detail",
    role: "hands-detail",
    promptFragment:
      "close-up of both hands, macro finger and knuckle detail, same identity zoom in only",
  },
  {
    cutId: "outfit-detail",
    label: "服のディテール",
    group: "detail",
    role: "outfit-detail",
    promptFragment:
      "close-up of the outfit fabric and pattern, macro material texture, same identity zoom in only",
  },
];

/** 既定セット(10カット): 3面図3 + 顔基準1 + 表情5 + 顔ディテール1。 */
export const DEFAULT_SHEET_CUT_IDS: string[] = [
  "front",
  "side",
  "back",
  "face-front",
  "expression-neutral",
  "expression-smile",
  "expression-angry",
  "expression-sad",
  "expression-surprised",
  "face-detail",
];

/** 「詳しく」で追加される拡張カット(全14カット化)。 */
export const EXTENDED_SHEET_CUT_IDS: string[] = SHEET_CUTS.map((c) => c.cutId);

/** cutId → SheetCut の逆引き。 */
export function getSheetCut(cutId: string): SheetCut | undefined {
  return SHEET_CUTS.find((c) => c.cutId === cutId);
}

/** cutId 群を SHEET_CUTS の並び順で解決する(未知IDは捨てる)。 */
export function resolveSheetCuts(cutIds: string[]): SheetCut[] {
  return SHEET_CUTS.filter((c) => cutIds.includes(c.cutId));
}
