// GPT Image 2 でサポートする主要アスペクト比 (2026-05-17 拡充)。
// 横長: 21:9 (シネスコ), 16:9 (動画/YouTube), 3:2 (写真), 4:3 (旧TV)
// 正方: 1:1 (SNS / Instagram)
// 縦長: 4:5 (Instagram投稿), 2:3 (ポスター), 9:16 (Reels/TikTok/Stories)
export type SceneAspectRatio =
  | "21:9"
  | "16:9"
  | "3:2"
  | "4:3"
  | "1:1"
  | "4:5"
  | "2:3"
  | "9:16";

export type ReferenceSlotId = "@img1" | "@img2" | "@img3" | "@img4" | "@img5";

export type SubjectFramingState = {
  subject: string;
  composition: string;
  aspectRatio: SceneAspectRatio;
  environment: string;
};

export type LightingMoodState = {
  lightSource: string;
  mood: string;
};

export type CameraState = {
  equipment: string;
  focalLength: string;
  lens: string;
  film: string;
};

export type StyleState = {
  freedom: number;
  photographerStyle: string;
  cinematicLook: string;
  filter: string;
};

export type SceneReferenceSlot = {
  id: ReferenceSlotId;
  enabled: boolean;
  label: string;
  note: string;
};

export type ReferenceSectionState = {
  slots: SceneReferenceSlot[];
};

export type SceneState = {
  subjectFraming: SubjectFramingState;
  lightingMood: LightingMoodState;
  camera: CameraState;
  style: StyleState;
  reference: ReferenceSectionState;
};

export type SubjectFramingField = keyof SubjectFramingState;
export type LightingMoodField = keyof LightingMoodState;
export type CameraField = keyof CameraState;
export type StyleField = keyof StyleState;

