/**
 * 画像パスの追従 S3 (2026-08-05)。
 *
 * ## この検査が守っているもの
 *
 * 共通原因は「渡すときは値 (絶対パス) をコピーする。渡した後、元が変わっても・
 * 消えても、コピー先は誰も直さない」。S3 は 3 つの穴を塞いだので、それぞれが
 * 埋め戻されないよう固定する:
 *
 *  - S3-1: `images.remove()` が favorites からも掃除する。掃除しないと
 *    favorites.json に死んだパスが残り、**再起動で復活する** (loadFavorites が
 *    ファイルから読み戻すため)。judgements だけ掃除していたのは非対称のバグ
 *  - S3-2: relink (旧→新パス) が videoStory の動画キューと
 *    scene3d.storyboardOrigins へも配られる (旧: この 2 面には届いていなかった)
 *  - S3-3: 走行中 (isStoryRunBusy) は videoStory を書き換えない
 *    (走行中ジョブの置き場を動かさない。removeCut と同じ思想)
 *
 * ## 検査の方式
 *
 * S3-1 は「保存 → 読み戻し」の往復を実際に通す。state を見るだけでは
 * 「再起動で復活する」という肝心の実害を検出できない (state からは消えているのに
 * ファイルには残る、が元の壊れ方だった)。plugin-store の IPC を疑似ファイルで
 * 握り、remove() が書いた内容を新品のストアが loadFavorites() で読み直す。
 */
import { describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

/**
 * plugin-store の疑似ファイル。path ごとに key→value を持つ。
 *
 * 返す `files` は mockIPC の外から参照できるので、「ディスクに何が残ったか」を
 * state と独立に観測できる (state だけ見ると S3-1 の実害を見逃す)。
 */
function installStoreMock(initial?: Record<string, Record<string, unknown>>) {
  const files: Record<string, Record<string, unknown>> = { ...(initial ?? {}) };
  const rids = new Map<number, string>();
  let nextRid = 1;

  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const rid = a.rid as number;
    const keyName = a["key"] as string;
    switch (cmd) {
      case "plugin:store|load": {
        const path = a.path as string;
        files[path] ??= {};
        const newRid = nextRid++;
        rids.set(newRid, path);
        return newRid;
      }
      case "plugin:store|get": {
        const path = rids.get(rid) as string;
        const bag = files[path] ?? {};
        return keyName in bag ? [bag[keyName], true] : [null, false];
      }
      case "plugin:store|set": {
        const path = rids.get(rid) as string;
        files[path] ??= {};
        files[path][keyName] = a.value;
        return null;
      }
      case "plugin:store|save":
        return null;
      default:
        return undefined;
    }
  });

  return { files };
}

const FAVORITES_FILE = "favorites.json";
const FAVORITES_KEY = "paths";

/** 疑似ファイル上の favorites 一覧 (= 再起動後に読まれる内容)。 */
function favoritesOnDisk(files: Record<string, Record<string, unknown>>): string[] {
  return (files[FAVORITES_FILE]?.[FAVORITES_KEY] as string[] | undefined) ?? [];
}

/**
 * persist (best-effort の非同期) がディスクへ着地するまで待つ。
 *
 * マイクロタスクを回すだけでは足りない: persistFavorites は plugin-store を
 * 動的 import してから load → set → save と進むので、実タスクを挟む必要がある。
 * 「N 回 await すれば足りる」と決め打ちすると環境差で偽陽性になるため、
 * 述語が満たされるまでポーリングする (満たされなければタイムアウトで落ちる)。
 */
async function settleUntil(cond: () => boolean, _label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  // 満たされなくても throw しない。呼び出し側の expect に判定を委ねる方が
  // 「何が期待と違ったか」が読める失敗になる (timeout の一行より診断しやすい)。
}

/** 条件を持たない待ち (「変わらないこと」を見るとき用)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

type SeedCut = {
  cutId: string;
  order: number;
  imagePath: string;
  prompt: string;
  requestedSeconds: number;
};

function cut(cutId: string, order: number, imagePath: string): SeedCut {
  return { cutId, order, imagePath, prompt: `p ${order}`, requestedSeconds: 5 };
}

describe("S3-1: 削除がお気に入りにも届く (再起動で復活しない)", () => {
  it("remove() したパスが state からも favorites.json からも消える", async () => {
    const { files } = installStoreMock({
      [FAVORITES_FILE]: { [FAVORITES_KEY]: ["/tmp/a.png", "/tmp/b.png"] },
    });
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().loadFavorites();
    expect(
      useImages.getState().favorites.has("/tmp/a.png"),
      "前提が崩れている: お気に入りが読み込めていない",
    ).toBe(true);

    useImages.getState().remove("/tmp/a.png");
    await settleUntil(
      () => !favoritesOnDisk(files).includes("/tmp/a.png"),
      "削除したパスが favorites.json から消えない (再起動で復活する)",
    );

    expect(
      useImages.getState().favorites.has("/tmp/a.png"),
      "削除したパスが state のお気に入りに残っている",
    ).toBe(false);
    expect(
      favoritesOnDisk(files),
      "削除したパスが favorites.json に残っている (再起動で復活する)",
    ).toEqual(["/tmp/b.png"]);
  });

  it("再起動相当の読み戻しで死んだパスが復活しない", async () => {
    const { files } = installStoreMock({
      [FAVORITES_FILE]: { [FAVORITES_KEY]: ["/tmp/a.png", "/tmp/b.png"] },
    });
    const first = await import("../src/lib/store/images");

    await first.useImages.getState().loadFavorites();
    first.useImages.getState().remove("/tmp/a.png");
    // 書き込みの着地を待たずに読み直すと、単に「まだ書かれていない」ものを
    // 読んで通ってしまう (掃除を外しても緑になる偽の検査になる)。
    await settleUntil(
      () => !favoritesOnDisk(files).includes("/tmp/a.png"),
      "削除が favorites.json へ着地しない",
    );
    expect(
      favoritesOnDisk(files),
      "削除が favorites.json へ着地していない (この時点で読み直しても意味が無い)",
    ).toEqual(["/tmp/b.png"]);

    // 再起動相当: モジュール state を捨てて新品のストアで読み直す。
    // 疑似ファイルは mockIPC 側に残るので、引き継がれるのは
    // 「ディスクに何が書かれたか」だけになる。
    vi.resetModules();
    const second = await import("../src/lib/store/images");
    expect(
      second.useImages,
      "前提が崩れている: 新品ストアを掴めていない (同一インスタンス)",
    ).not.toBe(first.useImages);
    expect(
      second.useImages.getState().favoritesLoaded,
      "前提が崩れている: 再起動相当なのに読み込み済みフラグが立っている",
    ).toBe(false);

    await second.useImages.getState().loadFavorites();

    expect(
      Array.from(second.useImages.getState().favorites),
      "再起動で削除済みパスがお気に入りに復活した",
    ).toEqual(["/tmp/b.png"]);
  });

  it("お気に入りでないパスの削除では favorites.json を書き換えない", async () => {
    const { files } = installStoreMock({
      [FAVORITES_FILE]: { [FAVORITES_KEY]: ["/tmp/b.png"] },
    });
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().loadFavorites();
    const before = favoritesOnDisk(files);

    useImages.getState().remove("/tmp/zzz.png");
    await settle();

    // ヒットが無いのに persist を撃つと、無関係な削除のたびにディスクを叩く。
    expect(favoritesOnDisk(files), "無関係な削除で内容が変わった").toBe(before);
  });

  it("judgements の掃除 (既存挙動) も一緒に効いている", async () => {
    installStoreMock();
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().setJudgement("/tmp/a.png", "adopted");
    useImages.getState().remove("/tmp/a.png");
    await settle();

    expect(useImages.getState().judgements.has("/tmp/a.png")).toBe(false);
  });
});

describe("S3-2: relink が videoStory / scene3d の由来記録まで届く", () => {
  it("動画キューの imagePath が新パスへ張り替わる", async () => {
    const { useVideoStory } = await import("../src/lib/store/videoStory");
    useVideoStory
      .getState()
      .setQueue([cut("cut-1", 1, "/old/a.png"), cut("cut-2", 2, "/old/b.png")]);

    useVideoStory.getState().relinkPaths({ "/old/a.png": "/new/a.png" });

    const paths = useVideoStory.getState().cuts.map((c) => c.imagePath);
    expect(paths, "動画キューが旧パスを握ったまま").toEqual([
      "/new/a.png",
      "/old/b.png",
    ]);
  });

  it("ヒットが無ければ cuts の同一性を保つ (無駄な再描画を出さない)", async () => {
    const { useVideoStory } = await import("../src/lib/store/videoStory");
    useVideoStory.getState().setQueue([cut("cut-1", 1, "/old/a.png")]);
    const before = useVideoStory.getState().cuts;

    useVideoStory.getState().relinkPaths({ "/other/x.png": "/new/x.png" });

    expect(useVideoStory.getState().cuts).toBe(before);
  });

  it("3D の由来記録 (storyboardOrigins) の imagePath が張り替わる", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    useScene3d.getState().importStoryboardCuts(
      [
        { cutId: "c1", durationSeconds: 3, imagePath: "/old/a.png", description: "d1" },
        { cutId: "c2", durationSeconds: 3, imagePath: "/old/b.png" },
      ],
      "replace",
    );
    expect(
      Object.keys(useScene3d.getState().storyboardOrigins).length,
      "前提が崩れている: 由来記録が積まれていない",
    ).toBe(2);

    useScene3d.getState().relinkStoryboardOrigins({ "/old/a.png": "/new/a.png" });

    const after = Object.values(useScene3d.getState().storyboardOrigins);
    expect(
      after.map((o) => o.imagePath).sort(),
      "3D の由来記録が旧パスを握ったまま",
    ).toEqual(["/new/a.png", "/old/b.png"]);
    // 張り替えるのは imagePath だけ。説明・カット ID は保持する。
    expect(after.find((o) => o.cutId === "c1")?.description).toBe("d1");
  });

  it("ヒットが無ければ storyboardOrigins の同一性を保つ", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    useScene3d
      .getState()
      .importStoryboardCuts(
        [{ cutId: "c1", durationSeconds: 3, imagePath: "/old/a.png" }],
        "replace",
      );
    const before = useScene3d.getState().storyboardOrigins;

    useScene3d.getState().relinkStoryboardOrigins({ "/other/x.png": "/new/x.png" });

    expect(useScene3d.getState().storyboardOrigins).toBe(before);
  });

  it("applyRelinkResult が 2 面へ配っている (配り先リストからの脱落を止める)", async () => {
    installStoreMock();
    const { useVideoStory } = await import("../src/lib/store/videoStory");
    const { useScene3d } = await import("../src/lib/store/scene3d");
    const { applyRelinkResult } = await import("../src/lib/relinkApply");

    useVideoStory.getState().setQueue([cut("cut-1", 1, "/old/a.png")]);
    useScene3d
      .getState()
      .importStoryboardCuts(
        [{ cutId: "c1", durationSeconds: 3, imagePath: "/old/a.png" }],
        "replace",
      );

    applyRelinkResult({
      pathMap: { "/old/a.png": "/new/a.png" },
      prunedPaths: [],
      dbUpdated: 1,
      dbPruned: 0,
      dbUnresolved: 0,
    });

    expect(
      useVideoStory.getState().cuts[0].imagePath,
      "applyRelinkResult の配り先から videoStory が落ちている",
    ).toBe("/new/a.png");
    expect(
      Object.values(useScene3d.getState().storyboardOrigins)[0].imagePath,
      "applyRelinkResult の配り先から scene3d が落ちている",
    ).toBe("/new/a.png");
  });
});

describe("S3-3: 走行中は videoStory のパスを書き換えない", () => {
  it("isStoryRunBusy が true の全 status で cuts が不変", async () => {
    const { useVideoStory, isStoryRunBusy } = await import(
      "../src/lib/store/videoStory"
    );
    const BUSY = ["starting", "running", "concatenating"] as const;

    for (const status of BUSY) {
      expect(isStoryRunBusy(status), `${status} が busy 判定でない`).toBe(true);

      useVideoStory.getState().setQueue([cut("cut-1", 1, "/old/a.png")]);
      useVideoStory.getState().setRunStatus(status);
      const before = useVideoStory.getState().cuts;

      useVideoStory.getState().relinkPaths({ "/old/a.png": "/new/a.png" });

      expect(
        useVideoStory.getState().cuts[0].imagePath,
        `走行中 (${status}) に走行中ジョブの置き場を動かした`,
      ).toBe("/old/a.png");
      expect(useVideoStory.getState().cuts).toBe(before);
    }
  });

  it("走行していない全 status では張り替わる (過剰に止めていない)", async () => {
    const { useVideoStory, isStoryRunBusy } = await import(
      "../src/lib/store/videoStory"
    );
    const IDLE = ["idle", "done", "failedPartial", "concatFailed"] as const;

    for (const status of IDLE) {
      expect(isStoryRunBusy(status), `${status} を busy と誤判定`).toBe(false);

      useVideoStory.getState().setQueue([cut("cut-1", 1, "/old/a.png")]);
      useVideoStory.getState().setRunStatus(status);

      useVideoStory.getState().relinkPaths({ "/old/a.png": "/new/a.png" });

      expect(
        useVideoStory.getState().cuts[0].imagePath,
        `${status} で張り替わっていない`,
      ).toBe("/new/a.png");
    }
  });
});
