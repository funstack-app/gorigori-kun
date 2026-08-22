import { create } from "zustand";

const LS_KEY = "gori.guidePreference.v1";

function readStoredEnabled(): boolean {
  try {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(LS_KEY) !== "false";
  } catch {
    return true;
  }
}

type GuidePreferenceState = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

export const useGuidePreference = create<GuidePreferenceState>((set) => ({
  enabled: readStoredEnabled(),
  setEnabled: (enabled) => {
    try {
      window.localStorage.setItem(LS_KEY, String(enabled));
    } catch {
      // localStorage が使えなくても、そのセッション中は反映される
    }
    set({ enabled });
  },
}));
