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

/** 人物のモーション(タイムライン全体で再生。決定論プロシージャル歩行) */
export type EntityMotionType = "walk" | "run";
export type EntityMotion =
  | {
      type: EntityMotionType;
      /** 経由点(開始位置は entity.position)。最後の点が到着点。到着後は立ち止まる */
      path: Vec3[];
    }
  | {
      /** インポートしたモーションクリップ(Mixamo等)を再生 */
      type: "clip";
      clipId: string;
      /**
       * 移動速度(m/s)。移動系クリップ(歩く/走る等)は割り当て時に
       * resolveClipSpeed の値を焼き込む。0/未指定 = その場再生
       */
      speed?: number;
      /** 経由点(speed>0のとき使用)。最後の点が到着点。到着後は待機に切替 */
      path?: Vec3[];
    };

export type SceneEntityKind =
  | "mannequin"
  | "sphere"
  | "box"
  | "wall"
  | "column"
  | "stairs"
  | "building"
  | "table"
  | "chair"
  | "sofa"
  | "bed"
  | "shelf"
  | "pedestal"
  | "car"
  | "tree"
  | "streetlight";

export type SceneEntity = {
  id: string;
  kind: SceneEntityKind;
  label: string;
  /** 床面上の配置位置(yは接地オフセット込みの原点) */
  position: Vec3;
  /** 床上回転(ラジアン)。Y軸回転のみ */
  rotationY: number;
  scale: number;
  /** 人物のモーション(mannequinのみ)。null/未指定=立ち */
  motion?: EntityMotion | null;
  /** プロシージャル形状のパラメータ。kindごとに解釈(未指定はkind既定値) */
  params?: {
    /** building: 階数 */
    floors?: number;
    /** wall/box: 横幅(m) */
    width?: number;
    /** wall/box: 高さ(m) */
    height?: number;
    /** box: 奥行(m) */
    depth?: number;
  };
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
  /** 注視対象のエンティティID。null なら lookAtPos(固定の注視点)を見る=被写体を追わない */
  targetEntityId: string | null;
  /** 被写体を追わないときの固定注視点 */
  lookAtPos?: Vec3;
  startPos: Vec3;
  /** orbit 以外で使用。orbit は orbitDegrees から終了位置を導出する */
  endPos: Vec3;
  /** orbit 専用: 対象を中心に回り込む角度(度)。正=時計回り */
  orbitDegrees: number;
  /** 軌道の中間点(直線プリセットを曲げる)。null/未指定なら直線 */
  midPos?: Vec3 | null;
  /** フルサイズ換算の焦点距離(mm)。fovに変換される */
  lensMm: number;
  easing: CameraEasing;
};

export type SceneAspectRatio = "16:9" | "9:16" | "1:1";

/**
 * カメラ = シーンに置かれた独立した機材(マルチカム)。
 * 複数のカットから同じカメラを使い回せる
 */
export type SceneCamera = {
  id: string;
  label: string;
  move: CameraMove;
};

/**
 * ショット = 1カット。「どのカメラで何秒撮るか」の箱。
 * shots を並べた順がそのままカット割になり、書き出しでは
 * 全ショットが連結された1本のモーションガイド動画になる。
 * カメラの動きはカットの尺の中で再生される(同じカメラを別カットで使うと同じ動きを再演)
 */
export type SceneShot = {
  id: string;
  label: string;
  durationFrames: number;
  cameraId: string;
  /**
   * カメラの動きのうち使う区間(0-1の窓)。未指定は[0,1](全区間)。
   * ハサミ分割はこの窓を割ることで、動きの続きを正確に引き継ぐ
   */
  moveWindow?: [number, number];
};

export type SceneProject = {
  schemaVersion: 3;
  fps: typeof SCENE_FPS;
  aspectRatio: SceneAspectRatio;
  entities: SceneEntity[];
  /** シーンのカメラ台数分(マルチカム)。最低1台 */
  cameras: SceneCamera[];
  /** カット割。最低1本 */
  shots: SceneShot[];
};

/** カメラ識別色(タイムラインのクリップ・3Dのタリーランプ共通) */
export const CAMERA_ID_COLORS = [
  "#ec4899", // カメラ1: ピンク
  "#38bdf8", // カメラ2: 空色
  "#22c55e", // カメラ3: 緑
  "#f59e0b", // カメラ4: 琥珀
  "#a78bfa", // カメラ5: 紫
  "#f87171", // カメラ6: 赤
] as const;

export function cameraColor(project: SceneProject, cameraId: string): string {
  const idx = project.cameras.findIndex((c) => c.id === cameraId);
  return CAMERA_ID_COLORS[Math.max(0, idx) % CAMERA_ID_COLORS.length];
}

/** Seedance 1回の生成上限(秒)。合計がこれを超えたら章分割が必要 */
export const SEEDANCE_MAX_SECONDS = 15;

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

export function createDefaultCameraMove(): CameraMove {
  return {
    preset: "orbit",
    targetEntityId: "actor-1",
    startPos: [0, 1.4, 4],
    endPos: [0, 1.4, 4],
    orbitDegrees: 120,
    lensMm: 35,
    easing: "easeInOut",
    midPos: null,
  };
}

export function createDefaultShot(id: string, label: string, cameraId: string): SceneShot {
  return {
    id,
    label,
    durationFrames: SCENE_FPS * 4, // 4秒
    cameraId,
  };
}

export function createDefaultProject(): SceneProject {
  return {
    schemaVersion: 3,
    fps: SCENE_FPS,
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
    cameras: [{ id: "camera-1", label: "カメラ1", move: createDefaultCameraMove() }],
    shots: [createDefaultShot("shot-1", "カット1", "camera-1")],
  };
}
