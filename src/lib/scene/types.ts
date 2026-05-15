export type SceneAspectRatio = "16:9" | "1:1" | "9:16" | "4:3";

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

