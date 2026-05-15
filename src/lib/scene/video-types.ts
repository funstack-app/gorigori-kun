export type VideoSubjectState = {
  text: string;
  composition: string;
};

export type VideoCameraMovementState = {
  motion: string;
  speed: string;
  startPosition: string;
};

export type VideoMotionState = {
  verb: string;
  category: string;
};

export type VideoLightingState = {
  source: string;
  timeOfDay: string;
  weather: string;
};

export type VideoStyleState = {
  look: string;
};

export type VideoPacingState = {
  tempo: string;
  targetDuration: number;
  cutDuration: number | "auto";
};

export type VideoSceneState = {
  subject: VideoSubjectState;
  cameraMovement: VideoCameraMovementState;
  motion: VideoMotionState;
  lighting: VideoLightingState;
  style: VideoStyleState;
  pacing: VideoPacingState;
};

export type VideoSubjectField = keyof VideoSubjectState;
export type VideoCameraMovementField = keyof VideoCameraMovementState;
export type VideoMotionField = keyof VideoMotionState;
export type VideoLightingField = keyof VideoLightingState;
export type VideoStyleField = keyof VideoStyleState;
export type VideoPacingField = keyof VideoPacingState;
