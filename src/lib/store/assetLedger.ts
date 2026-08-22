import { create } from "zustand";

import {
  assetLedger,
  type AssetLedgerEntry,
  type AssetLedgerFile,
} from "../ipc";
import { presetKind, usePresets, type Preset } from "./presets";

export type AssetLedgerState = {
  assets: AssetLedgerEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  upsert: (asset: AssetLedgerEntry) => Promise<AssetLedgerEntry>;
  delete: (id: string) => Promise<void>;
};

/**
 * 既存キャラの元IDを失わず、台帳IDへ決定的に読み替える。
 * source とこのIDの組で取込済みかを判定するため、再起動しても二重登録しない。
 */
export function characterRegisterAssetId(sourceId: string): string {
  return `al-character-register-${encodeURIComponent(sourceId)}`;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function toIsoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** presets.json の character 1件を、元データを変えず台帳形式へ読み替える。 */
export function characterPresetToLedgerAsset(preset: Preset): AssetLedgerEntry {
  const registeredImages = uniquePaths(
    preset.attachedImages?.map((image) => image.path) ?? [],
  );
  const sourceImages = uniquePaths([
    ...(preset.characterMeta?.sourceImages ?? []),
    preset.characterMeta?.sourceImage,
  ]);
  const allImages = uniquePaths([...registeredImages, ...sourceImages]);
  const primaryImagePath = registeredImages[0] ?? sourceImages[0] ?? null;

  return {
    id: characterRegisterAssetId(preset.id),
    type: "character",
    name: preset.name.trim(),
    createdAt: toIsoTime(preset.createdAt),
    updatedAt: toIsoTime(preset.updatedAt),
    primaryImagePath,
    imagePaths: allImages.filter((path) => path !== primaryImagePath),
    prompt: preset.prompt,
    negativePrompt: null,
    source: "character-register",
    locked: false,
    tags: [...(preset.tags ?? [])],
  };
}

/**
 * 未取込の既存キャラだけを返す。IDが他のsourceに使われている場合は、既存台帳を
 * 上書きしないため安全側でスキップする。
 */
export function findCharacterBridgeImports(
  assets: AssetLedgerEntry[],
  presets: Preset[],
): AssetLedgerEntry[] {
  const occupiedIds = new Set(assets.map((asset) => asset.id));
  const importedKeys = new Set(
    assets.map((asset) => `${asset.source}\u0000${asset.id}`),
  );
  const imports: AssetLedgerEntry[] = [];

  for (const preset of presets) {
    if (presetKind(preset) !== "character") continue;
    const asset = characterPresetToLedgerAsset(preset);
    const bridgeKey = `${asset.source}\u0000${asset.id}`;
    if (importedKeys.has(bridgeKey) || occupiedIds.has(asset.id)) continue;
    imports.push(asset);
    importedKeys.add(bridgeKey);
    occupiedIds.add(asset.id);
  }

  return imports;
}

function replaceOrAppend(
  assets: AssetLedgerEntry[],
  saved: AssetLedgerEntry,
): AssetLedgerEntry[] {
  const index = assets.findIndex((asset) => asset.id === saved.id);
  if (index < 0) return [...assets, saved];
  return assets.map((asset, currentIndex) =>
    currentIndex === index ? saved : asset,
  );
}

let loadInFlight: Promise<void> | null = null;

export const useAssetLedger = create<AssetLedgerState>((set, get) => ({
  assets: [],
  loading: false,
  loaded: false,
  error: null,

  load: () => {
    if (loadInFlight) return loadInFlight;
    const run = (async () => {
      set({ loading: true, error: null });
      try {
        const diskLedger = await assetLedger.read();

        // 既存キャラの正本 presets.json を先に読み切ってから、未取込分だけ追記する。
        await usePresets.getState().initialize();
        const imports = findCharacterBridgeImports(
          diskLedger.assets,
          usePresets.getState().presets,
        );
        for (const asset of imports) {
          await assetLedger.upsert(asset);
        }

        // 取込中に別経路から追加された分も落とさないよう、追記後は正本を再読込する。
        const current: AssetLedgerFile =
          imports.length > 0 ? await assetLedger.read() : diskLedger;
        set({
          assets: current.assets,
          loading: false,
          loaded: true,
          error: null,
        });
      } catch (error) {
        set({ loading: false, loaded: false, error: String(error) });
        throw error;
      }
    })();
    loadInFlight = run.finally(() => {
      loadInFlight = null;
    });
    return loadInFlight;
  },

  upsert: async (asset) => {
    set({ error: null });
    try {
      const saved = await assetLedger.upsert(asset);
      set({ assets: replaceOrAppend(get().assets, saved), error: null });
      return saved;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  delete: async (id) => {
    set({ error: null });
    try {
      await assetLedger.delete(id);
      set({
        assets: get().assets.filter((asset) => asset.id !== id),
        error: null,
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
}));
