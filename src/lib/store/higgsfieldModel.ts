import { create } from "zustand";

export type SelectedModel = {
  jobSetType: string;
  displayName: string;
};

/**
 * 制作タブで「Higgsfield モデルを使う」場合の選択状態。
 * - selectedModels: [] = codex 標準、1件 = 従来単一モデル、2-4件 = 比較生成
 * - selectedJobSetType / selectedDisplayName は後方互換用の先頭モデル値
 *
 * 永続化は localStorage (再起動後も同じモデル選択を継続)
 */
type HiggsfieldModelState = {
  selectedModels: SelectedModel[];
  selectedJobSetType: string | null;
  selectedDisplayName: string | null;
  setSelectedModels: (models: SelectedModel[]) => void;
  setSelected: (jobSetType: string | null, displayName?: string | null) => void;
};

const LS_KEY = "higgsfield.selectedModels";
const LEGACY_LS_KEY = "higgsfield.selectedJobSetType";

function normalizeSelectedModels(models: SelectedModel[]): SelectedModel[] {
  const seen = new Set<string>();
  const next: SelectedModel[] = [];
  for (const model of models) {
    const jobSetType = model.jobSetType.trim();
    if (!jobSetType || seen.has(jobSetType)) continue;
    seen.add(jobSetType);
    next.push({
      jobSetType,
      displayName: model.displayName.trim() || jobSetType,
    });
    if (next.length >= 4) break;
  }
  return next;
}

function readLegacySelected(): SelectedModel[] {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw || !raw.trim()) return [];
    if (raw.trim().startsWith("{")) {
      const parsed = JSON.parse(raw) as {
        jobSetType?: unknown;
        displayName?: unknown;
      };
      if (typeof parsed.jobSetType !== "string" || !parsed.jobSetType.trim()) {
        return [];
      }
      return [
        {
          jobSetType: parsed.jobSetType.trim(),
          displayName:
            typeof parsed.displayName === "string" && parsed.displayName.trim()
              ? parsed.displayName.trim()
              : parsed.jobSetType.trim(),
        },
      ];
    }
    return [{ jobSetType: raw.trim(), displayName: raw.trim() }];
  } catch {
    return [];
  }
}

function readSelectedModels(): SelectedModel[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw || !raw.trim()) return readLegacySelected();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return readLegacySelected();
    return normalizeSelectedModels(
      parsed.map((item) => {
        const record = item as { jobSetType?: unknown; displayName?: unknown };
        const jobSetType =
          typeof record.jobSetType === "string" ? record.jobSetType : "";
        return {
          jobSetType,
          displayName:
            typeof record.displayName === "string"
              ? record.displayName
              : jobSetType,
        };
      }),
    );
  } catch {
    return readLegacySelected();
  }
}

function persistSelectedModels(models: SelectedModel[]) {
  try {
    localStorage.removeItem(LEGACY_LS_KEY);
    if (models.length > 0) {
      localStorage.setItem(LS_KEY, JSON.stringify(models));
    } else {
      localStorage.removeItem(LS_KEY);
    }
  } catch {
    /* private mode / quota exhausted: non-fatal */
  }
}

function stateFromModels(models: SelectedModel[]) {
  const first = models[0] ?? null;
  return {
    selectedModels: models,
    selectedJobSetType: first?.jobSetType ?? null,
    selectedDisplayName: first?.displayName ?? null,
  };
}

const initialSelectedModels = readSelectedModels();

export const useHiggsfieldModel = create<HiggsfieldModelState>((set) => ({
  ...stateFromModels(initialSelectedModels),
  setSelectedModels: (models) => {
    const normalized = normalizeSelectedModels(models);
    persistSelectedModels(normalized);
    set(stateFromModels(normalized));
  },
  setSelected: (jobSetType, displayName = null) => {
    const next =
      jobSetType && jobSetType.trim()
        ? [
            {
              jobSetType: jobSetType.trim(),
              displayName: displayName?.trim() || jobSetType.trim(),
            },
          ]
        : [];
    persistSelectedModels(next);
    set(stateFromModels(next));
  },
}));
