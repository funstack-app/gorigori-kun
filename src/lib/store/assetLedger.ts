import { create } from "zustand";

import {
  assetLedger,
  type AssetLedgerEntry,
  type AssetLedgerFile,
  type AssetLedgerType,
} from "../ipc";
import type { AssetType, FilmAsset } from "../film/types";
import { presetKind, usePresets, type Preset } from "./presets";

export type AssetLedgerState = {
  assets: AssetLedgerEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  upsert: (asset: AssetLedgerEntry) => Promise<AssetLedgerEntry>;
  upsertFilmAsset: (
    filmProjectId: string,
    asset: FilmAsset,
  ) => Promise<AssetLedgerEntry>;
  delete: (id: string) => Promise<void>;
};

const FILM_ASSET_TYPE_TO_LEDGER_TYPE: Record<AssetType, AssetLedgerType> = {
  character: "character",
  location: "scene",
  prop: "prop",
  text: "custom",
};

/** 作品と素材の元IDを残し、再採用でも同じ台帳行を更新する。 */
export function filmAssetLedgerId(
  filmProjectId: string,
  filmAssetId: string,
): string {
  return `al-film-${encodeURIComponent(filmProjectId)}-${encodeURIComponent(filmAssetId)}`;
}

/** AIフィルムで採用した1件を、共通のアセット台帳形式へ変換する。 */
export function filmAssetToLedgerAsset(
  filmProjectId: string,
  filmAsset: FilmAsset,
  existing: AssetLedgerEntry | undefined,
  now = new Date(),
): AssetLedgerEntry {
  if (!filmAsset.canonicalImagePath?.trim()) {
    throw new Error("採用画像がないため台帳へ登録できません");
  }
  const id = filmAssetLedgerId(filmProjectId, filmAsset.id);
  const timestamp = now.toISOString();
  return {
    id,
    type: FILM_ASSET_TYPE_TO_LEDGER_TYPE[filmAsset.type],
    name: filmAsset.name.trim(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    primaryImagePath: filmAsset.canonicalImagePath,
    imagePaths: [],
    prompt: filmAsset.promptDraft,
    negativePrompt: existing?.negativePrompt ?? null,
    source: "film",
    locked: filmAsset.locked,
    tags: [...(existing?.tags ?? [])],
  };
}

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

  upsertFilmAsset: async (filmProjectId, filmAsset) => {
    // 採用画面から先に来ても、正本を読んで既存の作成日時や他の素材を保つ。
    if (!get().loaded) await get().load();
    const id = filmAssetLedgerId(filmProjectId, filmAsset.id);
    const existing = get().assets.find((asset) => asset.id === id);
    return get().upsert(
      filmAssetToLedgerAsset(filmProjectId, filmAsset, existing),
    );
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
