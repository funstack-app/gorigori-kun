import { create } from "zustand";
import type {
  VideoCameraField,
  VideoMotionField,
  VideoSceneState,
  VideoStagingField,
  VideoSubjectField,
} from "../scene/video-types";

type VideoSceneStore = VideoSceneState & {
  setSubjectField: (field: VideoSubjectField, value: string) => void;
  setMotionField: (field: VideoMotionField, value: string) => void;
  setCameraField: (field: VideoCameraField, value: string) => void;
  setStagingField: (field: VideoStagingField, value: string) => void;
  reset: () => void;
};

const initialState: VideoSceneState = {
  subject: { text: "" },
  motion: { verb: "", intensity: "", category: "" },
  camera: { motion: "", speed: "" },
  staging: { lighting: "", weather: "", environment: "", style: "" },
};

export const useVideoSceneStore = create<VideoSceneStore>((set) => ({
  ...initialState,
  setSubjectField: (field, value) =>
    set((state) => ({ subject: { ...state.subject, [field]: value } })),
  setMotionField: (field, value) =>
    set((state) => ({ motion: { ...state.motion, [field]: value } })),
  setCameraField: (field, value) =>
    set((state) => ({ camera: { ...state.camera, [field]: value } })),
  setStagingField: (field, value) =>
    set((state) => ({ staging: { ...state.staging, [field]: value } })),
  reset: () => set(initialState),
}));
