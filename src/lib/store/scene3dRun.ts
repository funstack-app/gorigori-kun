import { create } from "zustand";

type StateUpdate<T> = T | ((previous: T) => T);

function resolveUpdate<T>(previous: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

type Scene3dRunState = {
  sceneImagePath: string | null;
  motionLibraryOpen: boolean;
  captureBusy: string | null;
  captureError: string | null;
  captureStartedAt: number | null;
  motionGenerating: boolean;
  motionGenerationError: string | null;
  motionGenerationStartedAt: number | null;
  directorBusy: boolean;
  directorError: string | null;
  directorNote: string | null;
  directorProgress: string | null;
  directorStartedAt: number | null;
  setSceneImagePath: (update: StateUpdate<string | null>) => void;
  setMotionLibraryOpen: (update: StateUpdate<boolean>) => void;
  setCaptureBusy: (update: StateUpdate<string | null>) => void;
  setCaptureError: (update: StateUpdate<string | null>) => void;
  setCaptureStartedAt: (update: StateUpdate<number | null>) => void;
  setMotionGenerating: (update: StateUpdate<boolean>) => void;
  setMotionGenerationError: (update: StateUpdate<string | null>) => void;
  setMotionGenerationStartedAt: (update: StateUpdate<number | null>) => void;
  setDirectorBusy: (update: StateUpdate<boolean>) => void;
  setDirectorError: (update: StateUpdate<string | null>) => void;
  setDirectorNote: (update: StateUpdate<string | null>) => void;
  setDirectorProgress: (update: StateUpdate<string | null>) => void;
  setDirectorStartedAt: (update: StateUpdate<number | null>) => void;
};

export const useScene3dRun = create<Scene3dRunState>((set) => ({
  sceneImagePath: null,
  motionLibraryOpen: false,
  captureBusy: null,
  captureError: null,
  captureStartedAt: null,
  motionGenerating: false,
  motionGenerationError: null,
  motionGenerationStartedAt: null,
  directorBusy: false,
  directorError: null,
  directorNote: null,
  directorProgress: null,
  directorStartedAt: null,
  setSceneImagePath: (update) =>
    set((state) => ({ sceneImagePath: resolveUpdate(state.sceneImagePath, update) })),
  setMotionLibraryOpen: (update) =>
    set((state) => ({ motionLibraryOpen: resolveUpdate(state.motionLibraryOpen, update) })),
  setCaptureBusy: (update) =>
    set((state) => ({ captureBusy: resolveUpdate(state.captureBusy, update) })),
  setCaptureError: (update) =>
    set((state) => ({ captureError: resolveUpdate(state.captureError, update) })),
  setCaptureStartedAt: (update) =>
    set((state) => ({ captureStartedAt: resolveUpdate(state.captureStartedAt, update) })),
  setMotionGenerating: (update) =>
    set((state) => ({ motionGenerating: resolveUpdate(state.motionGenerating, update) })),
  setMotionGenerationError: (update) =>
    set((state) => ({
      motionGenerationError: resolveUpdate(state.motionGenerationError, update),
    })),
  setMotionGenerationStartedAt: (update) =>
    set((state) => ({
      motionGenerationStartedAt: resolveUpdate(state.motionGenerationStartedAt, update),
    })),
  setDirectorBusy: (update) =>
    set((state) => ({ directorBusy: resolveUpdate(state.directorBusy, update) })),
  setDirectorError: (update) =>
    set((state) => ({ directorError: resolveUpdate(state.directorError, update) })),
  setDirectorNote: (update) =>
    set((state) => ({ directorNote: resolveUpdate(state.directorNote, update) })),
  setDirectorProgress: (update) =>
    set((state) => ({ directorProgress: resolveUpdate(state.directorProgress, update) })),
  setDirectorStartedAt: (update) =>
    set((state) => ({ directorStartedAt: resolveUpdate(state.directorStartedAt, update) })),
}));
