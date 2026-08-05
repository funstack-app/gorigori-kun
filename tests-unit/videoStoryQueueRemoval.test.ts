/**
 * 動画キューの「消せない」を閉じる (A1 / A2 / A3 / A4, 2026-08-05)。
 *
 * ## この検査が守っているもの
 *
 * STΛCK 実機報告:「ストーリーカットで生成したやつをそのまま動画化するのはいいんだけど、
 * それがシーンから消せないでずっと残ってしまう」。
 *
 * 共通原因は「渡した先に消す手段が無い」。4つの穴を塞いだので、それぞれが
 * 埋め戻されないよう固定する:
 *
 *  - A1: cutId で 1 カットだけ外せる (旧: 全消しか全生成の二択しかない)
 *  - A2: どの runStatus でもキューから出られる (旧: 実行中/failedPartial で
 *        「キューを空にする」ボタンごと消えていた)
 *  - A3: 絵コンテの明示リセットがキューにも波及する (旧: 元データを捨てても
 *        キューが残り、絵コンテ側からは消せなくなる)
 *  - A4: 生成済みの成果があるとき、積み直しが黙って捨てない
 *
 * ## 検査の方式
 *
 * ストア (A1/A3/A4) は実物を呼んで状態遷移を見る。UI の描画分岐 (A2) は
 * 部品を単体で呼んでも「全 runStatus で出るか」を確かめられないので、
 * stickerNotCleared.test.ts と同じくソースを読んで固定する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

async function readSrc(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return readFile(resolve(process.cwd(), relative), "utf8");
}

type SeedCut = {
  cutId: string;
  order: number;
  imagePath: string;
  prompt: string;
  requestedSeconds: number;
};

function seed(n: number): SeedCut[] {
  return Array.from({ length: n }, (_, i) => ({
    cutId: `cut-${i + 1}`,
    order: i + 1,
    imagePath: `/tmp/cut-${i + 1}.png`,
    prompt: `prompt ${i + 1}`,
    requestedSeconds: 5,
  }));
}

/** 毎テストで新品のストアを掴む (setup.ts の resetModules 前提)。 */
async function freshStore() {
  return await import("../src/lib/store/videoStory");
}

describe("A1: キューから 1 カットだけ外せる", () => {
  it("cutId を指定した 1 件だけが消え、他は残る", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(3));

    const removed = useVideoStory.getState().removeCut("cut-2");

    expect(removed, "removeCut が false を返した（外せていない）").toBe(true);
    const ids = useVideoStory.getState().cuts.map((c) => c.cutId);
    expect(ids, "指定した 1 件だけが消えていない").toEqual(["cut-1", "cut-3"]);
  });

  it("抜いた後に order が 1 始まりの連番へ振り直される", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(3));

    useVideoStory.getState().removeCut("cut-1");

    // 飛び番のまま残すと画面が「Cut 2, Cut 3」になり、結合順の正としても嘘になる。
    expect(useVideoStory.getState().cuts.map((c) => c.order)).toEqual([1, 2]);
  });

  it("生成中のカットは外せない（走行中の有料ジョブの置き場を消さない）", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(2));
    useVideoStory.getState().updateCut("cut-1", { status: "generating" });

    const removed = useVideoStory.getState().removeCut("cut-1");

    expect(removed, "生成中のカットが外せてしまった").toBe(false);
    expect(useVideoStory.getState().cuts).toHaveLength(2);
  });

  it("存在しない cutId では false を返し、キューを壊さない", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(2));

    expect(useVideoStory.getState().removeCut("no-such-cut")).toBe(false);
    expect(useVideoStory.getState().cuts).toHaveLength(2);
  });

  it("最後の 1 件を抜くとランの残骸（完成表示・結合パス）も畳まれる", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(1));
    useVideoStory.getState().updateCut("cut-1", { status: "done", videoPath: "/tmp/a.mp4" });
    useVideoStory.getState().setFinalVideoPath("/tmp/final.mp4");
    useVideoStory.getState().setRunStatus("done");

    useVideoStory.getState().removeCut("cut-1");

    const s = useVideoStory.getState();
    expect(s.cuts).toHaveLength(0);
    expect(s.runStatus, "空になったのに done のまま").toBe("idle");
    expect(s.finalVideoPath, "存在しないカット列の結合動画が残っている").toBeNull();
  });

  it("完成後に 1 カット抜くと「完成」表示が降りる（結合動画はもう一致しない）", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(3));
    for (const id of ["cut-1", "cut-2", "cut-3"]) {
      useVideoStory.getState().updateCut(id, { status: "done", videoPath: `/tmp/${id}.mp4` });
    }
    useVideoStory.getState().setFinalVideoPath("/tmp/final.mp4");
    useVideoStory.getState().setRunStatus("done");

    useVideoStory.getState().removeCut("cut-2");

    const s = useVideoStory.getState();
    expect(s.finalVideoPath, "構成が変わったのに古い結合動画が残っている").toBeNull();
    // idle にすると「全カットを有料で再生成」のボタンが出てしまう。
    // 残りは生成済みなので、出すべき導線は「1本につなげる」だけ。
    expect(s.runStatus, "全体ラン（有料再生成）の導線が出る状態に落ちている").toBe(
      "concatFailed",
    );
  });
});

describe("A2: どの runStatus でもキューから出られる", () => {
  it("abortAndClear は全 runStatus からキューを空にする", async () => {
    const { useVideoStory } = await freshStore();
    const ALL_STATUSES = [
      "idle",
      "starting",
      "running",
      "concatenating",
      "done",
      "failedPartial",
      "concatFailed",
    ] as const;

    for (const status of ALL_STATUSES) {
      useVideoStory.getState().setQueue(seed(2));
      useVideoStory.getState().setRunStatus(status);

      useVideoStory.getState().abortAndClear();

      const s = useVideoStory.getState();
      expect(s.cuts, `runStatus=${status} から抜け出せない`).toHaveLength(0);
      expect(s.runStatus, `runStatus=${status} の後始末が idle でない`).toBe("idle");
      expect(s.finalVideoPath).toBeNull();
    }
  });

  it("実行中に空にしたらワーカーの次の投入を止める印が立つ", async () => {
    const { useVideoStory } = await freshStore();
    useVideoStory.getState().setQueue(seed(3));
    useVideoStory.getState().setRunStatus("running");

    useVideoStory.getState().abortAndClear();

    // 走行中の MCP コールは中断できないが、次の投入は止める。
    expect(useVideoStory.getState().cancelRequested).toBe(true);
  });

  it("UI がキュー退出ボタンを runStatus 分岐の外に置いている", async () => {
    const src = await readSrc("src/components/VideoStoryQueuePanel.tsx");

    // 旧実装は `runStatus === "idle" && (...)` と `runStatus === "done" && (...)`
    // の中にそれぞれ退出ボタンがあり、running/failedPartial では消えていた。
    // 退出ボタンは 1 個だけ・分岐の外、が直すべき形。
    //
    // ラベルの文字列は confirm 文にも出るので、JSX のラベル行だけを数える
    // (busy かどうかで文言を変える三項なので 1 行に 2 回出る)。
    const labelLines = src
      .split("\n")
      .filter((l) => l.includes("キューを空にする") && l.includes("isStoryRunBusy"));
    expect(
      labelLines.length,
      "退出ボタンのラベル行が 1 つでない（status 分岐の中に戻っている疑い）",
    ).toBe(1);

    // その 1 箇所が abortAndClear を呼んでいる（clear だと実行中に押せない）。
    expect(src, "退出ボタンが abortAndClear を呼んでいない").toContain("abortAndClear()");

    // 分岐の中に埋まっていないことを、JSX の括弧の釣り合いで確かめる。
    //
    // 操作列 (`<div className="mt-2 flex flex-wrap...">`) の開始から退出ボタンの
    // 開きタグまでを切り出し、`(` と `)` を数える。`runStatus === "..." && (` の
    // 内側にいるなら開き括弧が余る (差 > 0)。分岐の外に並んでいるなら釣り合う。
    // 文字列の数え上げより、ネストそのものを見るほうが再発検知として正しい。
    const barAt = src.indexOf('<div className="mt-2 flex flex-wrap');
    expect(barAt, "操作列の div が見つからない（構造が変わった）").toBeGreaterThan(-1);

    const labelAt = src.indexOf(labelLines[0]);
    // ラベル行から遡って、この退出ボタン自身の開きタグを見つける。
    const btnAt = src.lastIndexOf("<button", labelAt);
    const between = src.slice(barAt, btnAt);
    const depth =
      (between.split("(").length - 1) - (between.split(")").length - 1);
    expect(
      depth,
      `退出ボタンが runStatus 分岐の内側に戻っている（A2 の再発 / ネスト深さ ${depth}）`,
    ).toBe(0);
  });

  it("一等地にボタンを増やしていない（配置文法）", async () => {
    const src = await readSrc("src/components/VideoStoryQueuePanel.tsx");
    // 行内: このカットを再生成 / 外す。操作列: 全体ラン(idle) / 中止 /
    // 1本につなげる / Finder で表示 / 全体ラン(allFailed) / キューを空にする。
    const buttons = src.split("<button").length - 1;
    expect(buttons, `button が増えている（${buttons} 個）`).toBe(8);
  });
});

describe("A3: 絵コンテの明示リセットがキューにも波及する", () => {
  it("resetStoryboardSession が videoStory キューを畳む", async () => {
    const { useVideoStory } = await freshStore();
    const { resetStoryboardSession } = await import("../src/lib/storyboard/resetAll");

    useVideoStory.getState().setQueue(seed(3));
    useVideoStory.getState().setFinalVideoPath("/tmp/final.mp4");

    resetStoryboardSession();

    const s = useVideoStory.getState();
    expect(s.cuts, "元データを捨てたのにキューが残っている（A3 の再発）").toHaveLength(0);
    expect(s.finalVideoPath).toBeNull();
  });
});

describe("A4: 生成済みの成果があるとき黙って捨てない", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("hasGeneratedWork が done / videoPath / 結合済みを拾う", async () => {
    const { hasGeneratedWork } = await freshStore();
    const base = { cutId: "c", order: 1, imagePath: "/a.png", prompt: "p", requestedSeconds: 5 };

    expect(
      hasGeneratedWork({ cuts: [{ ...base, status: "queued" }], finalVideoPath: null }),
      "未生成を成果ありと誤判定している",
    ).toBe(false);
    expect(
      hasGeneratedWork({ cuts: [{ ...base, status: "done" }], finalVideoPath: null }),
    ).toBe(true);
    expect(
      hasGeneratedWork({
        cuts: [{ ...base, status: "failed", videoPath: "/v.mp4" }],
        finalVideoPath: null,
      }),
      "動画パスが残っているのに成果なし扱い",
    ).toBe(true);
    expect(
      hasGeneratedWork({ cuts: [], finalVideoPath: "/final.mp4" }),
      "結合済み動画があるのに成果なし扱い",
    ).toBe(true);
  });

  it("生成済みがあるとき、取り消せば既存キューがそのまま残る", async () => {
    const { useVideoStory } = await freshStore();
    const { sendCutsBatchToVideoTab } = await import("../src/lib/storyboard/sendCutToVideo");

    useVideoStory.getState().setQueue(seed(3));
    for (const id of ["cut-1", "cut-2", "cut-3"]) {
      useVideoStory.getState().updateCut(id, { status: "done", videoPath: `/tmp/${id}.mp4` });
    }
    useVideoStory.getState().setFinalVideoPath("/tmp/final.mp4");

    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    const pushed = await sendCutsBatchToVideoTab({
      cuts: [
        {
          cutId: "new-1",
          imagePath: "/tmp/new.png",
          prompt: "p",
          label: "Cut 1",
          durationSeconds: 5,
        },
      ],
    });

    expect(confirmSpy, "確認なしで積み直そうとしている（A4 の再発）").toHaveBeenCalled();
    expect(pushed, "取り消したのに積んだ数を返している").toBe(0);
    const s = useVideoStory.getState();
    expect(
      s.cuts.map((c) => c.cutId),
      "取り消したのに既存キューが消えた",
    ).toEqual(["cut-1", "cut-2", "cut-3"]);
    expect(s.finalVideoPath, "取り消したのに結合済み動画が消えた").toBe("/tmp/final.mp4");
  });

  it("承諾すれば積み直せる", async () => {
    const { useVideoStory } = await freshStore();
    const { sendCutsBatchToVideoTab } = await import("../src/lib/storyboard/sendCutToVideo");

    useVideoStory.getState().setQueue(seed(2));
    useVideoStory.getState().updateCut("cut-1", { status: "done", videoPath: "/tmp/a.mp4" });

    vi.stubGlobal("confirm", vi.fn(() => true));

    const pushed = await sendCutsBatchToVideoTab({
      cuts: [
        {
          cutId: "new-1",
          imagePath: "/tmp/n1.png",
          prompt: "p",
          label: "Cut 1",
          durationSeconds: 5,
        },
      ],
    });

    expect(pushed).toBe(1);
    expect(useVideoStory.getState().cuts.map((c) => c.cutId)).toEqual(["new-1"]);
  });

  it("生成済みが無いときは確認を挟まない（余計な確認を増やさない）", async () => {
    const { useVideoStory } = await freshStore();
    const { sendCutsBatchToVideoTab } = await import("../src/lib/storyboard/sendCutToVideo");

    useVideoStory.getState().setQueue(seed(2)); // 全 queued
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);

    const pushed = await sendCutsBatchToVideoTab({
      cuts: [
        {
          cutId: "new-1",
          imagePath: "/tmp/n1.png",
          prompt: "p",
          label: "Cut 1",
          durationSeconds: 5,
        },
      ],
    });

    expect(confirmSpy, "捨てるものが無いのに確認を出している").not.toHaveBeenCalled();
    expect(pushed).toBe(1);
  });
});
