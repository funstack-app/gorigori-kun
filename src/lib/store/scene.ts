import { create } from "zustand";
import { NO_SELECT, referenceSlotIds } from "../scene/catalog";
import type {
  CameraField,
  LightingMoodField,
  ReferenceSlotId,
  SceneState,
  StyleField,
  SubjectFramingField,
} from "../scene/types";

type SceneStore = SceneState & {
  setSubjectFramingField: <K extends SubjectFramingField>(field: K, value: SceneState["subjectFraming"][K]) => void;
  setLightingMoodField: <K extends LightingMoodField>(field: K, value: SceneState["lightingMood"][K]) => void;
  setCameraField: <K extends CameraField>(field: K, value: SceneState["camera"][K]) => void;
  setStyleField: <K extends StyleField>(field: K, value: SceneState["style"][K]) => void;
  setReferenceSlot: (id: ReferenceSlotId, patch: Partial<SceneState["reference"]["slots"][number]>) => void;
  clearReferenceSlot: (id: ReferenceSlotId) => void;
  resetScene: () => void;
};

const initialSceneState: SceneState = {
  subjectFraming: {
    subject: "",
    composition: NO_SELECT,
    cameraAngle: NO_SELECT,
    framing: NO_SELECT,
    aspectRatio: "16:9",
    environment: "",
  },
  lightingMood: {
    lightSource: NO_SELECT,
    mood: "",
  },
  camera: {
    equipment: NO_SELECT,
    focalLength: NO_SELECT,
    lens: NO_SELECT,
    film: NO_SELECT,
  },
  style: {
    freedom: 50,
    photographerStyle: NO_SELECT,
    cinematicLook: NO_SELECT,
    filter: NO_SELECT,
  },
  reference: {
    slots: referenceSlotIds.map((id) => ({
      id,
      enabled: false,
      label: "",
      note: "",
    })),
  },
};

function createInitialSceneState(): SceneState {
  return {
    ...initialSceneState,
    subjectFraming: { ...initialSceneState.subjectFraming },
    lightingMood: { ...initialSceneState.lightingMood },
    camera: { ...initialSceneState.camera },
    style: { ...initialSceneState.style },
    reference: {
      slots: initialSceneState.reference.slots.map((slot) => ({ ...slot })),
    },
  };
}

export const useSceneStore = create<SceneStore>((set) => ({
  ...createInitialSceneState(),
  setSubjectFramingField: (field, value) =>
    set((state) => ({
      subjectFraming: {
        ...state.subjectFraming,
        [field]: value,
      },
    })),
  setLightingMoodField: (field, value) =>
    set((state) => ({
      lightingMood: {
        ...state.lightingMood,
        [field]: value,
      },
    })),
  setCameraField: (field, value) =>
    set((state) => ({
      camera: {
        ...state.camera,
        [field]: value,
      },
    })),
  setStyleField: (field, value) =>
    set((state) => ({
      style: {
        ...state.style,
        [field]: value,
      },
    })),
  setReferenceSlot: (id, patch) =>
    set((state) => ({
      reference: {
        slots: state.reference.slots.map((slot) =>
          slot.id === id ? { ...slot, ...patch, id } : slot,
        ),
      },
    })),
  clearReferenceSlot: (id) =>
    set((state) => ({
      reference: {
        slots: state.reference.slots.map((slot) =>
          slot.id === id
            ? {
                ...slot,
                enabled: false,
                label: "",
                note: "",
              }
            : slot,
        ),
      },
    })),
  resetScene: () => set(createInitialSceneState()),
}));

if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __stores?: Record<string, unknown> }).__stores ??= {};
  (window as unknown as { __stores: Record<string, unknown> }).__stores.scene = useSceneStore;
}

