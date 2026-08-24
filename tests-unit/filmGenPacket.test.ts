import { beforeEach, describe, expect, it } from "vitest";

import {
  filmGenRunKey,
  getFilmGenerationDisabledReason,
  isPacketService,
  useFilmGenRun,
  type FilmGenBlockRun,
  type FilmGenConnectionStatus,
  type FilmGenReference,
} from "../src/lib/store/filmGenRun";

function makeRun(update: Partial<FilmGenBlockRun> = {}): FilmGenBlockRun {
  return {
    projectId: "film-1",
    blockId: "B1",
    promptDraft: "保存済みプロンプト",
    savedPrompt: "保存済みプロンプト",
    references: [],
    status: "idle",
    progress: 0,
    progressLabel: "未生成",
    resultPath: null,
    error: null,
    lastNgReason: "",
    ...update,
  };
}

function disabledReason(
  run: FilmGenBlockRun,
  serviceId: string,
  connectionStatus: FilmGenConnectionStatus,
  durationSeconds = 10,
) {
  return getFilmGenerationDisabledReason({
    run,
    serviceId,
    durationSeconds,
    connectionStatus,
  });
}

describe("フィルム生成のパケットモード", () => {
  beforeEach(() => {
    useFilmGenRun.setState({
      runs: {},
      connectionStatus: "unchecked",
      connectionReason: null,
    });
  });

  it("モデルIDがnullのサービスだけをパケットサービスとして判定する", () => {
    expect(isPacketService("seedance-2.5")).toBe(true);
    expect(isPacketService("minimax-h3")).toBe(true);
    expect(isPacketService("flux3")).toBe(true);
    expect(isPacketService("seedance-2.0")).toBe(false);
    expect(isPacketService("kling-3.0")).toBe(false);
    expect(isPacketService("veo-3.1")).toBe(false);
    expect(isPacketService("unknown-service")).toBe(false);
  });

  it("パケットサービスはモデルとHiggsfield接続を理由に止めない", () => {
    expect(disabledReason(makeRun(), "seedance-2.5", "disconnected")).toBeNull();
    expect(disabledReason(makeRun(), "seedance-2.5", "error")).toBeNull();
  });

  it("パケットサービスでも未保存と未反映の既存警告を返す", () => {
    expect(
      disabledReason(makeRun({ savedPrompt: "" }), "seedance-2.5", "disconnected"),
    ).toBe("合成プロンプトを保存してください。");
    expect(
      disabledReason(
        makeRun({ promptDraft: "変更後", savedPrompt: "変更前" }),
        "seedance-2.5",
        "disconnected",
      ),
    ).toBe("合成プロンプトに未保存の変更があります。");
  });

  it("パケットサービスでもブロック尺と参照上限を検証する", () => {
    expect(disabledReason(makeRun(), "seedance-2.5", "disconnected", 26)).toBe(
      "Seedance 2.5は1ブロック25秒までです。現在は26秒です。",
    );

    const references: FilmGenReference[] = Array.from({ length: 31 }, (_, index) => ({
      id: `ref-${index}`,
      path: `/tmp/ref-${index}.png`,
      name: `ref-${index}.png`,
      source: "local",
    }));
    expect(
      disabledReason(makeRun({ references }), "seedance-2.5", "disconnected"),
    ).toBe("Seedance 2.5は参照画像30枚までです。現在31枚です。");
  });

  it("アプリ内生成サービスは従来どおり接続と保存状態を検証する", () => {
    expect(disabledReason(makeRun(), "seedance-2.0", "unchecked")).toBe(
      "Higgsfieldの接続を確認しています。",
    );
    expect(disabledReason(makeRun(), "seedance-2.0", "disconnected")).toBe(
      "Higgsfieldが未接続です。設定 > 接続先から接続してください。",
    );
    expect(disabledReason(makeRun({ savedPrompt: "" }), "seedance-2.0", "ready")).toBe(
      "合成プロンプトを保存してください。",
    );
  });

  it("取り込んだ動画を既存の確認待ち経路へ載せる", () => {
    const key = filmGenRunKey("film-1", "B1");
    useFilmGenRun.setState({
      runs: {
        [key]: makeRun({
          status: "error",
          progress: 0.75,
          progressLabel: "失敗",
          error: "前回の失敗",
          lastNgReason: "前回の理由",
        }),
      },
    });

    useFilmGenRun.getState().setImportedResult("film-1", "B1", " /tmp/film.mp4 ");

    expect(useFilmGenRun.getState().runs[key]).toMatchObject({
      status: "review",
      progress: 0,
      progressLabel: "",
      resultPath: "/tmp/film.mp4",
      error: null,
      lastNgReason: "",
    });
  });
});
