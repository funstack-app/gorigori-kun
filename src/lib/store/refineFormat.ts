import { create } from "zustand";
import type { PromptFormat } from "../scene/promptFormat";

/**
 * 「AIで整える」の出力形式 (JSON / YAML) の記憶。
 *
 * 画像と動画で **独立** に持つ (2026-08-03 STΛCK指示 ④)。メディアごとに
 * ベストプラクティスが違うため、片方を YAML にしたらもう片方も変わるのは
 * 説明できない挙動になる。既定はどちらも json (現行挙動を変えない)。
 */

const IMAGE_LS_KEY = "gori:refine-format:image";
const VIDEO_LS_KEY = "gori:refine-format:video";

function readPersisted(key: string): PromptFormat {
  try {
    const raw = localStorage.getItem(key);
    return raw === "yaml" ? "yaml" : "json";
  } catch {
    return "json";
  }
}

function persist(key: string, format: PromptFormat) {
  try {
    localStorage.setItem(key, format);
  } catch {
    /* private mode / quota exhausted — non-fatal */
  }
}

type RefineFormatState = {
  image: PromptFormat;
  video: PromptFormat;
  setImage: (f: PromptFormat) => void;
  setVideo: (f: PromptFormat) => void;
};

export const useRefineFormat = create<RefineFormatState>((set) => ({
  image: readPersisted(IMAGE_LS_KEY),
  video: readPersisted(VIDEO_LS_KEY),
  setImage: (f) => {
    persist(IMAGE_LS_KEY, f);
    set({ image: f });
  },
  setVideo: (f) => {
    persist(VIDEO_LS_KEY, f);
    set({ video: f });
  },
}));
