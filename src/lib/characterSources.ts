import type { AssetLedgerEntry } from "./ipc";
import { characterRegisterAssetId } from "./store/assetLedger";
import { presetKind, type Preset } from "./store/presets";

export type CharacterSource = {
  id: string;
  name: string;
  imagePath: string | null;
  origin: "preset" | "ledger";
  originLabel: string;
  preset?: Preset;
  unavailableReason: string | null;
};

export type CharacterLedgerReadState = {
  loading: boolean;
  loaded: boolean;
  loadError: string | null;
};

const NO_IMAGE_REASON = "画像が登録されていません";

const LEDGER_ORIGIN_LABELS: Record<string, string> = {
  "character-register": "登録",
  film: "フィルム",
  import: "読込",
};

function ledgerOriginLabel(source: AssetLedgerEntry["source"]): string {
  return LEDGER_ORIGIN_LABELS[source] ?? "台帳";
}

/** 読込失敗または初回読込中だけ台帳を隠す。書込エラーは一覧へ影響させない。 */
export function selectCharacterLedgerAssets(
  ledgerAssets: AssetLedgerEntry[],
  state: CharacterLedgerReadState,
): AssetLedgerEntry[] {
  if (state.loadError || (state.loading && !state.loaded)) return [];
  return ledgerAssets;
}

export function collectCharacterSources(
  presets: Preset[],
  ledgerAssets: AssetLedgerEntry[],
): CharacterSource[] {
  const characterPresets = presets.filter(
    (preset) => presetKind(preset) === "character",
  );
  const livePresetLedgerIds = new Set(
    characterPresets.map((preset) => characterRegisterAssetId(preset.id)),
  );

  const presetSources = characterPresets.map<CharacterSource>((preset) => {
    const imagePath =
      preset.characterMeta?.sourceImage ??
      preset.attachedImages?.[0]?.path ??
      null;
    return {
      id: preset.id,
      name: preset.name,
      imagePath,
      origin: "preset",
      originLabel: "登録",
      preset,
      unavailableReason: imagePath ? null : NO_IMAGE_REASON,
    };
  });

  const ledgerSources = ledgerAssets
    .filter(
      (asset) =>
        asset.type === "character" && !livePresetLedgerIds.has(asset.id),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map<CharacterSource>((asset) => {
      const imagePath = asset.primaryImagePath ?? asset.imagePaths[0] ?? null;
      return {
        id: asset.id,
        name: asset.name,
        imagePath,
        origin: "ledger",
        originLabel: ledgerOriginLabel(asset.source),
        unavailableReason: imagePath ? null : NO_IMAGE_REASON,
      };
    });

  return [...presetSources, ...ledgerSources];
}
