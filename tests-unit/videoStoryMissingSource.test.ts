/**
 * S2: 消えた元画像で有料の動画生成を走らせない (2026-08-05)。
 *
 * ## この検査が守っているもの
 *
 * `cut.imagePath` は絵コンテ確定時のスナップショットで、キューはメモリ上に残る。
 * ライブラリでのリネーム・削除・移動のあと動画化を押すと、**存在しないパス**が
 * そのまま Higgsfield MCP へ渡っていた。MCP は必ず失敗するが、その失敗は
 * **有料枠を消費したうえで**返ってくる (投げた時点で課金される)。
 *
 * 直したのは 1 点だけ: 投入前に実在を確認し、**消えたカットだけを failed にして
 * MCP へ投げない**。他のカットは通常どおり走る (1 枚欠けても全体を止めない)。
 *
 * ## 検査の方式
 *
 * `mockIPC` で Tauri の invoke を差し替え、
 *   - `images_file_sizes` … 実在判定の答え (size: null = 見つからない)
 *   - `higgsfield_mcp_generate_batch` … **呼ばれたら記録する**有料コール
 * を観測する。本命は「generate_batch が呼ばれていないこと」。
 * 成功したかどうかではなく、**課金経路に到達していないこと**が守るべき性質。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

/** 実在する扱いにするパス。ここに無いパスは size: null (= 見つからない) を返す。 */
const EXISTING = new Set<string>();

type GenCall = { refImagePaths: string[]; prompt: string };

let genCalls: GenCall[] = [];
let fileSizeCalls: string[][] = [];

/**
 * invoke モック。
 *
 * `images_file_sizes` は Rust 実装 (std::fs::metadata) と同じ形で返す:
 * 読めないパスは size: null。0 バイトの実在ファイルは size: 0 なので、
 * 「truthy かどうか」で判定していると実在ファイルを欠落と誤判定する。
 * その退行を検知できるよう、実在側の size は **0 を返す**。
 */
function installIpcMock(): void {
  genCalls = [];
  fileSizeCalls = [];
  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "auth_read":
        return { account: { email: "t@example.com", type: "chatgpt" } };
      case "images_file_sizes": {
        const paths = (a.paths as string[]) ?? [];
        fileSizeCalls.push(paths);
        return paths.map((p) => ({ path: p, size: EXISTING.has(p) ? 0 : null }));
      }
      case "higgsfield_mcp_generate_batch": {
        const gen = (a.args ?? {}) as { refImagePaths?: string[]; prompt?: string };
        genCalls.push({
          refImagePaths: gen.refImagePaths ?? [],
          prompt: gen.prompt ?? "",
        });
        return { generatedPaths: ["/tmp/out.mp4"], failedCount: 0, errors: [] };
      }
      case "video_concat_story":
        return "/tmp/final.mp4";
      default:
        return undefined;
    }
  });
}

type SeedCut = {
  cutId: string;
  order: number;
  imagePath: string;
  prompt: string;
  requestedSeconds: number;
};

function cut(n: number): SeedCut {
  return {
    cutId: `cut-${n}`,
    order: n,
    imagePath: `/tmp/cut-${n}.png`,
    prompt: `prompt ${n}`,
    requestedSeconds: 5,
  };
}

async function loadModules() {
  const store = await import("../src/lib/store/videoStory");
  const runner = await import("../src/lib/videoStory/runStoryVideo");
  return { ...store, ...runner };
}

beforeEach(() => {
  EXISTING.clear();
  localStorage.clear();
  installIpcMock();
});

describe("S2: 生成前ゲート (全体ラン)", () => {
  it("元画像が全て消えていたら MCP を 1 回も呼ばない（本命）", async () => {
    const { useVideoStory, runStoryVideo } = await loadModules();
    useVideoStory.getState().setQueue([cut(1), cut(2)]);
    // EXISTING は空 = 2 枚とも見つからない。

    await runStoryVideo();

    expect(
      genCalls.length,
      "存在しない画像で有料の動画生成が走った（S2 の再発）",
    ).toBe(0);
  });

  it("全滅時は全カットが failed になり、失敗理由が出る", async () => {
    const { useVideoStory, runStoryVideo, MISSING_SOURCE_IMAGE_ERROR } = await loadModules();
    useVideoStory.getState().setQueue([cut(1), cut(2)]);

    await runStoryVideo();

    const s = useVideoStory.getState();
    expect(s.cuts.map((c) => c.status)).toEqual(["failed", "failed"]);
    for (const c of s.cuts) {
      expect(c.error, "失敗理由が空（ユーザーが原因に辿り着けない）").toBe(
        MISSING_SOURCE_IMAGE_ERROR,
      );
    }
    // 既存の failed 表示・再試行導線に乗せる（新しい状態を増やさない）。
    expect(s.runStatus).toBe("failedPartial");
  });

  it("1 カットだけ消えているとき、生きたカットは走る（全体を止めない）", async () => {
    const { useVideoStory, runStoryVideo, MISSING_SOURCE_IMAGE_ERROR } = await loadModules();
    useVideoStory.getState().setQueue([cut(1), cut(2), cut(3)]);
    EXISTING.add("/tmp/cut-1.png");
    EXISTING.add("/tmp/cut-3.png");

    await runStoryVideo();

    // 生きた 2 件だけが投入される。
    expect(genCalls.length, "投入数が生存カット数と一致しない").toBe(2);
    const sent = genCalls.flatMap((c) => c.refImagePaths).sort();
    expect(sent, "消えた画像が MCP へ渡っている").toEqual([
      "/tmp/cut-1.png",
      "/tmp/cut-3.png",
    ]);

    const byId = new Map(useVideoStory.getState().cuts.map((c) => [c.cutId, c]));
    expect(byId.get("cut-1")?.status, "生きたカットが走っていない").toBe("done");
    expect(byId.get("cut-3")?.status, "生きたカットが走っていない").toBe("done");
    expect(byId.get("cut-2")?.status).toBe("failed");
    expect(byId.get("cut-2")?.error).toBe(MISSING_SOURCE_IMAGE_ERROR);
  });

  it("0 バイトの実在ファイルを欠落と誤判定しない（size:0 は実在）", async () => {
    const { useVideoStory, runStoryVideo } = await loadModules();
    useVideoStory.getState().setQueue([cut(1)]);
    EXISTING.add("/tmp/cut-1.png"); // モックは size: 0 を返す

    await runStoryVideo();

    expect(genCalls.length, "0 バイトの実在ファイルを欠落扱いしている").toBe(1);
  });

  it("実在確認はランごとに 1 回にまとめる（カットごとに IPC を打たない）", async () => {
    const { useVideoStory, runStoryVideo } = await loadModules();
    useVideoStory.getState().setQueue([cut(1), cut(2), cut(3)]);
    EXISTING.add("/tmp/cut-1.png");
    EXISTING.add("/tmp/cut-2.png");
    EXISTING.add("/tmp/cut-3.png");

    await runStoryVideo();

    expect(fileSizeCalls.length, "実在確認がカットごとに走っている").toBe(1);
    expect(fileSizeCalls[0]).toEqual([
      "/tmp/cut-1.png",
      "/tmp/cut-2.png",
      "/tmp/cut-3.png",
    ]);
  });

  it("検査基盤が壊れているときは生成を止めない（fail-open）", async () => {
    const { useVideoStory, runStoryVideo } = await loadModules();
    useVideoStory.getState().setQueue([cut(1)]);
    // images_file_sizes だけを失敗させる。
    mockIPC(async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === "auth_read") return { account: { email: "t@example.com" } };
      if (cmd === "images_file_sizes") throw new Error("ipc broken");
      if (cmd === "higgsfield_mcp_generate_batch") {
        const gen = (a.args ?? {}) as { refImagePaths?: string[]; prompt?: string };
        genCalls.push({ refImagePaths: gen.refImagePaths ?? [], prompt: gen.prompt ?? "" });
        return { generatedPaths: ["/tmp/out.mp4"], failedCount: 0, errors: [] };
      }
      if (cmd === "video_concat_story") return "/tmp/final.mp4";
      return undefined;
    });

    await runStoryVideo();

    // 検査の故障で操作を止めるのは、従来より悪い体験になる。
    expect(genCalls.length, "検査の故障で生成が止まっている（fail-open 違反）").toBe(1);
  });
});

describe("S2: 生成前ゲート (個別再生成)", () => {
  it("元画像が消えたカットの再生成は MCP を呼ばない（本命）", async () => {
    const { useVideoStory, retryCut, MISSING_SOURCE_IMAGE_ERROR } = await loadModules();
    useVideoStory.getState().setQueue([cut(1)]);
    useVideoStory.getState().updateCut("cut-1", { status: "failed", error: "前回の失敗" });

    await retryCut("cut-1");

    expect(
      genCalls.length,
      "存在しない画像で有料の再生成が走った（再生成ボタンは何度でも押せる）",
    ).toBe(0);
    const c = useVideoStory.getState().cuts[0];
    expect(c.status).toBe("failed");
    expect(c.error).toBe(MISSING_SOURCE_IMAGE_ERROR);
  });

  it("元画像が実在すれば従来どおり再生成できる", async () => {
    const { useVideoStory, retryCut } = await loadModules();
    useVideoStory.getState().setQueue([cut(1)]);
    useVideoStory.getState().updateCut("cut-1", { status: "failed", error: "前回の失敗" });
    EXISTING.add("/tmp/cut-1.png");

    await retryCut("cut-1");

    expect(genCalls.length, "実在するのに再生成が塞がれている").toBe(1);
    expect(useVideoStory.getState().cuts[0].status).toBe("done");
  });
});
