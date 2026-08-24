import { create } from "zustand";

import {
  createPersistGuard,
  describeOutcome,
  type KeyValueStore,
} from "./persistGuard";

export const REGULATION_RULES_STORE_FILE = "regulation-rules.json";
export const REGULATION_RULES_STORE_KEY = "state";
export const REGULATION_RULES_DRAFT_DEBOUNCE_MS = 300;

export type SavedRegulationRule = {
  id: string;
  name: string;
  ruleSetId: string;
  customRule: string;
  updatedAt: number;
};

export type RegulationRuleDraft = {
  ruleSetId: string;
  customRule: string;
};

export type RegulationRulesFile = {
  version: 1;
  savedRules: SavedRegulationRule[];
  draft: RegulationRuleDraft | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDraft(value: unknown): RegulationRuleDraft | null {
  if (!isRecord(value)) return null;
  if (typeof value.ruleSetId !== "string" || !value.ruleSetId.trim()) return null;
  if (typeof value.customRule !== "string") return null;
  return {
    ruleSetId: value.ruleSetId,
    customRule: value.customRule,
  };
}

function parseSavedRule(value: unknown): SavedRegulationRule | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.name !== "string" || !value.name.trim()) return null;
  if (typeof value.ruleSetId !== "string" || !value.ruleSetId.trim()) return null;
  if (typeof value.customRule !== "string") return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
  return {
    id: value.id,
    name: value.name,
    ruleSetId: value.ruleSetId,
    customRule: value.customRule,
    updatedAt: value.updatedAt,
  };
}

export function parseRegulationRulesFile(
  raw: unknown,
): { ok: true; value: RegulationRulesFile } | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "規格ルールがオブジェクトではありません" };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: "規格ルールのバージョンが不正です" };
  }
  if (!Array.isArray(raw.savedRules)) {
    return { ok: false, reason: "保存済みルールが配列ではありません" };
  }
  const savedRules: SavedRegulationRule[] = [];
  for (const value of raw.savedRules) {
    const parsed = parseSavedRule(value);
    if (!parsed) {
      return { ok: false, reason: "保存済みルールに不正な項目があります" };
    }
    savedRules.push(parsed);
  }
  if (raw.draft !== null) {
    const draft = parseDraft(raw.draft);
    if (!draft) return { ok: false, reason: "規格ルールの下書きが不正です" };
    return { ok: true, value: { version: 1, savedRules, draft } };
  }
  return { ok: true, value: { version: 1, savedRules, draft: null } };
}

export function createRegulationRulesGuard(
  loadStore?: () => Promise<KeyValueStore | null>,
) {
  return createPersistGuard<RegulationRulesFile>({
    name: "regulationRules",
    file: REGULATION_RULES_STORE_FILE,
    key: REGULATION_RULES_STORE_KEY,
    parse: parseRegulationRulesFile,
    ...(loadStore ? { loadStore } : {}),
  });
}

export const regulationRulesGuard = createRegulationRulesGuard();

type RegulationRulesState = {
  savedRules: SavedRegulationRule[];
  draft: RegulationRuleDraft | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDraft: (ruleSetId: string, customRule: string) => void;
  saveRule: (name: string) => Promise<SavedRegulationRule | null>;
  applyRule: (id: string) => SavedRegulationRule | null;
  deleteRule: (id: string) => Promise<boolean>;
};

function snapshot(state: RegulationRulesState): RegulationRulesFile {
  return {
    version: 1,
    savedRules: state.savedRules.map((rule) => ({ ...rule })),
    draft: state.draft ? { ...state.draft } : null,
  };
}

let hydrateInFlight: Promise<void> | null = null;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
let draftRevision = 0;

function clearDraftSaveTimer(): void {
  if (draftSaveTimer === null) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
}

function scheduleDraftSave(get: () => RegulationRulesState): void {
  if (!get().hydrated) return;
  clearDraftSaveTimer();
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    void regulationRulesGuard.save(snapshot(get()));
  }, REGULATION_RULES_DRAFT_DEBOUNCE_MS);
}

export const useRegulationRules = create<RegulationRulesState>((set, get) => ({
  savedRules: [],
  draft: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydrateInFlight) return hydrateInFlight;

    hydrateInFlight = (async () => {
      try {
        const outcome = await regulationRulesGuard.load();
        if (outcome.status === "ok") {
          set((state) => ({
            savedRules: outcome.value.savedRules.map((rule) => ({ ...rule })),
            // 読込中に画面で編集された下書きは、保存値で上書きしない。
            draft: state.draft ?? (outcome.value.draft ? { ...outcome.value.draft } : null),
          }));
        } else if (outcome.status !== "absent") {
          console.warn(`[regulationRules] ${describeOutcome(outcome)}`);
        }
      } finally {
        set({ hydrated: true });
        // hydrate 前・途中の編集は通常の予約対象外なので、完了後に1回だけ拾う。
        if (draftRevision > 0) scheduleDraftSave(get);
      }
    })().finally(() => {
      hydrateInFlight = null;
    });
    return hydrateInFlight;
  },

  setDraft: (ruleSetId, customRule) => {
    draftRevision += 1;
    set({ draft: { ruleSetId, customRule } });
    scheduleDraftSave(get);
  },

  saveRule: async (name) => {
    const normalizedName = name.trim();
    const draft = get().draft;
    if (!normalizedName || !draft) return null;

    const existing = get().savedRules.find((rule) => rule.name === normalizedName);
    const savedRule: SavedRegulationRule = {
      id: existing?.id ?? crypto.randomUUID(),
      name: normalizedName,
      ruleSetId: draft.ruleSetId,
      customRule: draft.customRule,
      updatedAt: Date.now(),
    };
    const savedRules = existing
      ? get().savedRules.map((rule) => (rule.id === existing.id ? savedRule : rule))
      : [...get().savedRules, savedRule];

    clearDraftSaveTimer();
    const ok = await regulationRulesGuard.save({
      version: 1,
      savedRules,
      draft: { ...draft },
    });
    if (!ok) return null;
    set({ savedRules });
    return savedRule;
  },

  applyRule: (id) => {
    const savedRule = get().savedRules.find((rule) => rule.id === id);
    if (!savedRule) return null;
    get().setDraft(savedRule.ruleSetId, savedRule.customRule);
    return savedRule;
  },

  deleteRule: async (id) => {
    const current = get();
    if (!current.savedRules.some((rule) => rule.id === id)) return false;
    const savedRules = current.savedRules.filter((rule) => rule.id !== id);
    clearDraftSaveTimer();
    const ok = await regulationRulesGuard.save({
      version: 1,
      savedRules,
      draft: current.draft ? { ...current.draft } : null,
    });
    if (ok) set({ savedRules });
    return ok;
  },
}));

