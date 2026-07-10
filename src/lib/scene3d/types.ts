/**
 * scene3d コアデータモデル
 *
 * 3Dビューポート(R3F)から独立した純TypeScript。プレビューも動画書き出しも
 * 必ず同じ evaluateScene / evaluateCamera を通す(決定性: 同一入力→同一出力)。
 *
 * 設計判断:
 *   - 時間は小数秒ではなく整数フレーム(24fps固定)で保存する
 *     → プレビューと書き出しのタイミングずれを構造的に防ぐ
 *   - カメラの動きはキーフレーム列ではなく「プリセット+開始/終了+パラメータ」
 *     → ユーザーにキーフレームを見せない(D&Dとボタンだけで動きが付く)
 */

export const SCENE_FPS = 24 as const;

export type Vec3 = [number, number, number];

export type SceneEntityKind = "mannequin" | "sphere" | "box";

export type SceneEntity = {
  id: string;
  kind: SceneEntityKind;
  label: string;
  /** 床面上の配置位置(yは接地オフセット込みの原点) */
  position: Vec3;
  /** 床上回転(ラジアン)。スパイク段階ではY軸回転のみ */
  rotationY: number;
  scale: number;
};

export type CameraPresetId =
  | "fixed"
  | "pushIn"
  | "pullOut"
  | "track"
  | "pan"
  | "orbit"
  | "crane"
  | "handheld";

export type CameraEasing = "linear" | "easeInOut";

export type CameraMove = {
  preset: CameraPresetId;
  /** 注視対象のエンティティID。null なら原点を見る */
  targetEntityId: string | null;
  startPos: Vec3;
  /** orbit 以外で使用。orbit は orbitDegrees から終了位置を導出する */
  endPos: Vec3;
  /** orbit 専用: 対象を中心に回り込む角度(度)。正=時計回り */
  orbitDegrees: number;
  /** フルサイズ換算の焦点距離(mm)。fovに変換される */
  lensMm: number;
  easing: CameraEasing;
};

export type SceneAspectRatio = "16:9" | "9:16" | "1:1";

export type SceneProject = {
  schemaVersion: 1;
  fps: typeof SCENE_FPS;
  durationFrames: number;
  aspectRatio: SceneAspectRatio;
  entities: SceneEntity[];
  camera: CameraMove;
};

/** 1フレーム分のカメラ姿勢(評価結果) */
export type CameraPose = {
  position: Vec3;
  lookAt: Vec3;
  /** 垂直画角(度) */
  fovDeg: number;
};

export const LENS_PRESETS_MM = [18, 24, 35, 50, 85, 135] as const;

export const CAMERA_PRESET_LABELS: Record<CameraPresetId, string> = {
  fixed: "固定",
  pushIn: "プッシュイン",
  pullOut: "プルアウト",
  track: "トラック",
  pan: "パン",
  orbit: "オービット",
  crane: "クレーン",
  handheld: "ハンドヘルド",
};

export function createDefaultProject(): SceneProject {
  return {
    schemaVersion: 1,
    fps: SCENE_FPS,
    durationFrames: SCENE_FPS * 6, // 6秒
    aspectRatio: "16:9",
    entities: [
      {
        id: "actor-1",
        kind: "mannequin",
        label: "人物1",
        position: [0, 0, 0],
        rotationY: 0,
        scale: 1,
      },
    ],
    camera: {
      preset: "orbit",
      targetEntityId: "actor-1",
      startPos: [0, 1.4, 4],
      endPos: [0, 1.4, 4],
      orbitDegrees: 120,
      lensMm: 35,
      easing: "easeInOut",
    },
  };
}
