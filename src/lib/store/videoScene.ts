import { create } from "zustand";
import { NO_SELECT } from "../scene/catalog";
import type {
  VideoCameraMovementField,
  VideoLightingField,
  VideoMotionField,
  VideoPacingField,
  VideoSceneState,
  VideoStyleField,
  VideoSubjectField,
} from "../scene/video-types";

type VideoSceneStore = VideoSceneState & {
  setSubjectField: <K extends VideoSubjectField>(field: K, value: VideoSceneState["subject"][K]) => void;
  setCameraMovementField: <K extends VideoCameraMovementField>(field: K, value: VideoSceneState["cameraMovement"][K]) => void;
  setMotionField: <K extends VideoMotionField>(field: K, value: VideoSceneState["motion"][K]) => void;
  setLightingField: <K extends VideoLightingField>(field: K, value: VideoSceneState["lighting"][K]) => void;
  setStyleField: <K extends VideoStyleField>(field: K, value: VideoSceneState["style"][K]) => void;
  setPacingField: <K extends VideoPacingField>(field: K, value: VideoSceneState["pacing"][K]) => void;
  resetVideoScene: () => void;
};

const initialVideoSceneState: VideoSceneState = {
  subject: { text: "", composition: NO_SELECT },
  cameraMovement: { motion: NO_SELECT, speed: "標準", startPosition: "中央" },
  motion: { verb: NO_SELECT, category: "" },
  lighting: { source: NO_SELECT, timeOfDay: NO_SELECT, weather: NO_SELECT },
  style: { look: NO_SELECT },
  pacing: { tempo: "標準", targetDuration: 10, cutDuration: "auto" },
};

function createInitialVideoSceneState(): VideoSceneState {
  return {
    subject: { ...initialVideoSceneState.subject },
    cameraMovement: { ...initialVideoSceneState.cameraMovement },
    motion: { ...initialVideoSceneState.motion },
    lighting: { ...initialVideoSceneState.lighting },
    style: { ...initialVideoSceneState.style },
    pacing: { ...initialVideoSceneState.pacing },
  };
}

export const useVideoSceneStore = create<VideoSceneStore>((set) => ({
  ...createInitialVideoSceneState(),
  setSubjectField: (field, value) => set((state) => ({ subject: { ...state.subject, [field]: value } })),
  setCameraMovementField: (field, value) => set((state) => ({ cameraMovement: { ...state.cameraMovement, [field]: value } })),
  setMotionField: (field, value) => set((state) => ({ motion: { ...state.motion, [field]: value } })),
  setLightingField: (field, value) => set((state) => ({ lighting: { ...state.lighting, [field]: value } })),
  setStyleField: (field, value) => set((state) => ({ style: { ...state.style, [field]: value } })),
  setPacingField: (field, value) => set((state) => ({ pacing: { ...state.pacing, [field]: value } })),
  resetVideoScene: () => set(createInitialVideoSceneState()),
}));

if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __stores?: Record<string, unknown> }).__stores ??= {};
  (window as unknown as { __stores: Record<string, unknown> }).__stores.videoScene = useVideoSceneStore;
}
