import { create } from "zustand";

import {
  assetLedger,
  type AssetLedgerEntry,
  type AssetLedgerFile,
  type AssetLedgerType,
} from "../ipc";
import type { AssetType, FilmAsset } from "../film/types";
import { presetKind, usePresets, type Preset } from "./presets";

/** アセット種類の表示順と名前。登録・呼び出しの両画面で同じ一覧を使う。 */
export const ASSET_LEDGER_TYPE_OPTIONS: ReadonlyArray<{
  value: AssetLedgerType;
  label: string;
}> = [
  { value: "character", label: "キャラ" },
  { value: "scene", label: "シーン" },
  { value: "look", label: "ルック" },
  { value: "prop", label: "小物" },
  { value: "custom", label: "その他" },
];

export type AssetLedgerState = {
  assets: AssetLedgerEntry[];
  loading: boolean;
  loaded: boolean;
  loadError: string | null;
  writeError: string | null;
  /** 既存画面向けの互換値。読込エラーを優先し、無ければ書込エラーを返す。 */
  error: string | null;
  load: () => Promise<void>;
  upsert: (asset: AssetLedgerEntry) => Promise<AssetLedgerEntry>;
  upsertFilmAsset: (
    filmProjectId: string,
    asset: FilmAsset,
  ) => Promise<AssetLedgerEntry>;
  upsertCharacterRegisterOutput: (
    sourcePresetId: string,
    name: string,
    sheetImagePaths: string[],
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

/**
 * キャラ登録で確定した生成物だけを台帳へ写す。
 * 元プリセットIDから台帳IDを決めるため、再登録・作り直しでも同じ1件を更新する。
 */
export function characterRegisterOutputToLedgerAsset(
  sourcePresetId: string,
  name: string,
  sheetImagePaths: string[],
  existing: AssetLedgerEntry | undefined,
  now = new Date(),
): AssetLedgerEntry {
  const images = uniquePaths(sheetImagePaths);
  if (images.length === 0) {
    throw new Error("キャラクターシート画像がないため台帳へ登録できません");
  }
  const timestamp = now.toISOString();
  return {
    id: characterRegisterAssetId(sourcePresetId),
    type: "character",
    name: name.trim(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    primaryImagePath: images[0],
    imagePaths: images.slice(1),
    // §6訂正: キャラ登録からは生成指示や元画像を持ち込まず、確定シートだけを保存する。
    prompt: "",
    negativePrompt: null,
    source: "character-register",
    locked: false,
    tags: [],
  };
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
  loadError: null,
  writeError: null,
  error: null,

  load: () => {
    if (get().loaded) return Promise.resolve();
    if (loadInFlight) return loadInFlight;
    const run = (async () => {
      set({ loading: true, loadError: null, error: get().writeError });
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
          loadError: null,
          error: get().writeError,
        });
      } catch (error) {
        const loadError = String(error);
        set({ loading: false, loaded: false, loadError, error: loadError });
        throw error;
      }
    })();
    loadInFlight = run.finally(() => {
      loadInFlight = null;
    });
    return loadInFlight;
  },

  upsert: async (asset) => {
    set({ writeError: null, error: get().loadError });
    try {
      const saved = await assetLedger.upsert(asset);
      set({
        assets: replaceOrAppend(get().assets, saved),
        writeError: null,
        error: get().loadError,
      });
      return saved;
    } catch (error) {
      const writeError = String(error);
      set({ writeError, error: get().loadError ?? writeError });
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

  upsertCharacterRegisterOutput: async (sourcePresetId, name, sheetImagePaths) => {
    // キャラ登録が台帳画面より先でも、既存ブリッジを読み切ってから同じIDを更新する。
    if (!get().loaded) await get().load();
    const id = characterRegisterAssetId(sourcePresetId);
    const existing = get().assets.find((asset) => asset.id === id);
    return get().upsert(
      characterRegisterOutputToLedgerAsset(
        sourcePresetId,
        name,
        sheetImagePaths,
        existing,
      ),
    );
  },

  delete: async (id) => {
    set({ writeError: null, error: get().loadError });
    try {
      await assetLedger.delete(id);
      set({
        assets: get().assets.filter((asset) => asset.id !== id),
        writeError: null,
        error: get().loadError,
      });
    } catch (error) {
      const writeError = String(error);
      set({ writeError, error: get().loadError ?? writeError });
      throw error;
    }
  },
}));
