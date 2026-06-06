/**
 * マルチアングル生成の構図カタログ（30構図 = 選択上限）
 *
 * GORI GORI KUN は一度に最大30カット生成できるため、構図リストも30が上限。
 * ユーザーはこの30の中から好きなものを複数選択し、選んだカットだけを並列生成する。
 *
 * 各構図は「ショット距離 × 垂直アングル × 水平方向」の3軸、または特殊ショット。
 * promptFragment は実画像生成プロンプトに焼き込む英語表現（被写体は参照画像で固定）。
 * mannequinPrompt は選択UIに出す「マネキン見本画像」を生成するためのプロンプト。
 *
 * 語彙の正典: ~/.codex/skills/gori-multi-angle/references/angle-dictionary.md
 * Rust 側（multiangle.rs）はこの id 配列と同じ順序を前提にする。
 */

export type AngleCut = {
  /** 一意ID。Rust 側・見本ファイル名・store のキーに使う */
  id: string;
  /** UI 表示名（日本語） */
  label: string;
  /** 分類タグ（UIのグルーピング用） */
  group: "full" | "medium" | "closeup" | "special";
  /** 実画像生成プロンプトに焼き込む構図の英語表現 */
  promptFragment: string;
  /** 選択UIに出すマネキン見本画像の生成プロンプト */
  mannequinPrompt: string;
};

/** マネキン見本に共通で付ける固定句（人体模型・無地背景・統一スタイル） */
export const MANNEQUIN_STYLE =
  "neutral gray wooden artist mannequin (drawing figure model), plain light gray studio background, " +
  "soft even lighting, full clean silhouette, no text, no props, minimalist reference pose, consistent style across all images";

/** 実生成時に全カット共通で付ける固定句（被写体同一性・環境固定） */
export const IDENTITY_LOCK =
  "keep the exact same character identity, face, body and outfit from the reference image. " +
  "Keep the same environment and lighting. Only the camera position/angle/distance changes, " +
  "as if the camera moved around the subject. No text, no watermark, no collage, single image.";

/** 選択上限（GORI GORI KUN の一度の生成上限と一致） */
export const MAX_CUTS = 30;

/**
 * 30構図カタログ。preset_30（全方位リファレンス）= このリスト全体。
 * group 順（full → medium → closeup → special）に並べる。
 */
export const ANGLE_CUTS: AngleCut[] = [
  // ── フルショット系（全身） ──
  { id: "fs_birdseye", label: "全身・鳥瞰", group: "full",
    promptFragment: "full body shot, bird's eye view, top-down view, looking straight down",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, photographed from directly above, bird's eye top-down view` },
  { id: "fs_high_front", label: "全身・俯瞰・正面", group: "full",
    promptFragment: "full body shot, high angle, front view, camera looking down",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, high angle looking down, front facing` },
  { id: "fs_eye_front", label: "全身・正面", group: "full",
    promptFragment: "full body shot, eye level, front view, straight-on",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, eye level, front view straight on` },
  { id: "fs_eye_front_r34", label: "全身・右斜め前", group: "full",
    promptFragment: "full body shot, eye level, front right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, eye level, front right three-quarter 3/4 view` },
  { id: "fs_eye_side", label: "全身・右サイド", group: "full",
    promptFragment: "full body shot, eye level, right side profile view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, eye level, right side profile lateral view` },
  { id: "fs_eye_rear_r34", label: "全身・右斜め後ろ", group: "full",
    promptFragment: "full body shot, eye level, rear right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, eye level, rear right three-quarter back 3/4 view` },
  { id: "fs_eye_back", label: "全身・背面", group: "full",
    promptFragment: "full body shot, eye level, back view, from behind",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, eye level, back rear view from behind` },
  { id: "fs_low_front", label: "全身・煽り・正面", group: "full",
    promptFragment: "full body shot, low angle, front view, heroic perspective looking up",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, low angle looking up, front facing` },
  { id: "fs_wormseye", label: "全身・虫瞰", group: "full",
    promptFragment: "full body shot, worm's eye view, extreme low angle looking straight up",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, extreme low worm's eye view looking up` },
  { id: "fs_dutch_r34", label: "全身・傾き", group: "full",
    promptFragment: "full body shot, dutch angle, canted tilted camera, front right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, dutch tilted canted angle, 3/4 view` },

  // ── ミディアム系（腰上） ──
  { id: "ms_high_front", label: "ミディアム・俯瞰・正面", group: "medium",
    promptFragment: "medium shot, waist up, high angle, front view, looking down",
    mannequinPrompt: `${MANNEQUIN_STYLE}, waist up medium shot, high angle, front view` },
  { id: "ms_eye_front", label: "ミディアム・正面", group: "medium",
    promptFragment: "medium shot, waist up, eye level, front view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, waist up medium shot, eye level, front view` },
  { id: "ms_eye_front_r34", label: "ミディアム・右斜め前", group: "medium",
    promptFragment: "medium shot, waist up, eye level, front right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, waist up medium shot, eye level, 3/4 view` },
  { id: "ms_eye_side", label: "ミディアム・右サイド", group: "medium",
    promptFragment: "medium shot, waist up, eye level, right side profile view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, waist up medium shot, eye level, side profile` },
  { id: "ms_low_front", label: "ミディアム・煽り・正面", group: "medium",
    promptFragment: "medium shot, waist up, low angle, front view, heroic",
    mannequinPrompt: `${MANNEQUIN_STYLE}, waist up medium shot, low angle looking up, front` },
  { id: "mcu_eye_front", label: "バストアップ・正面", group: "medium",
    promptFragment: "medium close-up, chest up, bust shot, eye level, front view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, chest up bust shot, eye level, front view` },
  { id: "mcu_eye_front_r34", label: "バストアップ・右斜め前", group: "medium",
    promptFragment: "medium close-up, chest up, eye level, front right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, chest up bust shot, eye level, 3/4 view` },
  { id: "mcu_eye_side", label: "バストアップ・右サイド", group: "medium",
    promptFragment: "medium close-up, chest up, eye level, right side profile view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, chest up bust shot, eye level, side profile` },

  // ── クローズアップ系（顔） ──
  { id: "cu_high_front", label: "顔アップ・俯瞰", group: "closeup",
    promptFragment: "close-up shot, face, high angle, front view, looking down",
    mannequinPrompt: `${MANNEQUIN_STYLE}, head close-up, high angle, front view` },
  { id: "cu_eye_front", label: "顔アップ・正面", group: "closeup",
    promptFragment: "close-up shot, face portrait, eye level, front view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, head close-up portrait, eye level, front view` },
  { id: "cu_eye_front_r34", label: "顔アップ・右斜め前", group: "closeup",
    promptFragment: "close-up shot, face, eye level, front right three-quarter view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, head close-up, eye level, 3/4 face view` },
  { id: "cu_eye_side", label: "顔アップ・横顔", group: "closeup",
    promptFragment: "close-up shot, face, eye level, right side profile view",
    mannequinPrompt: `${MANNEQUIN_STYLE}, head close-up, eye level, side profile face` },
  { id: "cu_low_front", label: "顔アップ・煽り", group: "closeup",
    promptFragment: "close-up shot, face, low angle, front view, looking up intense",
    mannequinPrompt: `${MANNEQUIN_STYLE}, head close-up, low angle looking up, front` },

  // ── 特殊ショット（3軸に乗らない単体カット） ──
  { id: "sp_eyes_ecu", label: "目のドアップ", group: "special",
    promptFragment: "extreme close-up of the eyes, eye detail, Italian shot",
    mannequinPrompt: `${MANNEQUIN_STYLE}, extreme close-up of the head's eye area` },
  { id: "sp_hands_ecu", label: "手のドアップ", group: "special",
    promptFragment: "extreme close-up of the hands, hand detail shot",
    mannequinPrompt: `${MANNEQUIN_STYLE}, extreme close-up of the articulated wooden hand` },
  { id: "sp_hero_low", label: "ヒーローショット", group: "special",
    promptFragment: "low-angle hero shot, powerful confident stance, dramatic looking up",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, dramatic low-angle hero pose, powerful stance` },
  { id: "sp_ots", label: "肩越しショット", group: "special",
    promptFragment: "over-the-shoulder shot, OTS, third person perspective behind the subject",
    mannequinPrompt: `${MANNEQUIN_STYLE}, over-the-shoulder framing, view past one shoulder` },
  { id: "sp_pov", label: "主観ショット", group: "special",
    promptFragment: "POV shot, first-person point of view as if seen through the subject's eyes",
    mannequinPrompt: `${MANNEQUIN_STYLE}, first-person POV framing of hands reaching forward` },
  { id: "sp_aerial", label: "ドローン視点", group: "special",
    promptFragment: "aerial drone shot, high altitude view looking down from far above",
    mannequinPrompt: `${MANNEQUIN_STYLE}, tiny figure seen from very high aerial drone view` },
  { id: "sp_isometric", label: "アイソメ視点", group: "special",
    promptFragment: "isometric view, isometric perspective, 3D game style diagonal angle",
    mannequinPrompt: `${MANNEQUIN_STYLE}, full body, isometric 3D game diagonal perspective` },
];

/** id → AngleCut の逆引き */
export function getAngleCut(id: string): AngleCut | undefined {
  return ANGLE_CUTS.find((c) => c.id === id);
}

/**
 * プリセット（30の中から代表をプリセレクトするショートカット）。
 * 全部自分で選ぶのが面倒な人向け。選んだ後に個別増減できる。
 */
export const ANGLE_PRESETS: { id: string; label: string; cutIds: string[] }[] = [
  {
    id: "preset_8",
    label: "最小8カット（キャラ確認）",
    cutIds: [
      "fs_eye_front", "fs_eye_side", "fs_eye_back", "fs_eye_front_r34",
      "cu_eye_front", "cu_eye_front_r34", "ms_low_front", "ms_high_front",
    ],
  },
  {
    id: "preset_16",
    label: "標準16カット（映像/コミック）",
    cutIds: [
      "fs_eye_front", "fs_eye_front_r34", "fs_eye_side", "fs_eye_back",
      "ms_eye_front", "ms_eye_front_r34", "ms_low_front", "ms_high_front",
      "mcu_eye_front", "mcu_eye_front_r34", "cu_eye_front", "cu_eye_front_r34",
      "cu_low_front", "sp_eyes_ecu", "fs_dutch_r34", "sp_hero_low",
    ],
  },
  {
    id: "preset_30",
    label: "網羅30カット（全方位リファレンス）",
    cutIds: ANGLE_CUTS.map((c) => c.id),
  },
];
