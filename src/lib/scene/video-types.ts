// 動画タブ i2v シーン構築の状態型。
//
// 設計 (2026-05-29 i2v再設計): t2iタグ型をやめ、i2v映像文脈型へ。
// first frame で確定する静的情報 (構図/開始位置/時間帯) は持たない。
// 「動き・カメラ・環境変化」に振り切り、4軸に集約する:
//   01 主役  / 02 動き(+強度) / 03 カメラ(+速度) / 04 演出(光/天候/環境/スタイル)

export type VideoSubjectState = {
  /** 主役の参照ラベル。外見の詳細説明ではなく "the girl" 程度を想定 */
  text: string;
};

export type VideoMotionState = {
  /** 被写体の動き (歩く/振り返る等) */
  verb: string;
  /** 動きの強度 (ゆっくり/繊細に/力強く等)。旧テンポの置換 */
  intensity: string;
  /** UI表示用カテゴリ。プロンプトには出さない */
  category: string;
};

export type VideoCameraState = {
  /** カメラの動き (ドリーイン/オービット等) */
  motion: string;
  /** カメラ速度 */
  speed: string;
};

export type VideoStagingState = {
  /** ライティング (動的変化として扱う) */
  lighting: string;
  /** 天候 (雨/雪/霧 — 環境の動き) */
  weather: string;
  /** 環境の動き (煙/反射/風で揺れる草など) */
  environment: string;
  /** スタイル (末尾に短く) */
  style: string;
};

export type VideoSceneState = {
  subject: VideoSubjectState;
  motion: VideoMotionState;
  camera: VideoCameraState;
  staging: VideoStagingState;
};

export type VideoSubjectField = keyof VideoSubjectState;
export type VideoMotionField = keyof VideoMotionState;
export type VideoCameraField = keyof VideoCameraState;
export type VideoStagingField = keyof VideoStagingState;
