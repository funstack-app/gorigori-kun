import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  read: vi.fn(),
  initializePresets: vi.fn(),
}));

vi.mock("../src/lib/ipc", () => ({
  assetLedger: {
    read: harness.read,
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../src/lib/store/presets", () => ({
  presetKind: vi.fn(),
  usePresets: {
    getState: () => ({
      presets: [],
      initialize: harness.initializePresets,
    }),
  },
}));

import { useAssetLedger } from "../src/lib/store/assetLedger";

describe("assetLedger load", () => {
  beforeEach(() => {
    harness.read.mockReset().mockResolvedValue({ version: 1, assets: [] });
    harness.initializePresets.mockReset().mockResolvedValue(undefined);
    useAssetLedger.setState({
      assets: [],
      loading: false,
      loaded: false,
      loadError: null,
      writeError: null,
      error: null,
    });
  });

  it("loaded 後の2回目は台帳とプリセットを再読込しない", async () => {
    await useAssetLedger.getState().load();
    await useAssetLedger.getState().load();

    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(harness.initializePresets).toHaveBeenCalledTimes(1);
    expect(useAssetLedger.getState()).toMatchObject({
      loading: false,
      loaded: true,
      loadError: null,
    });
  });
});
