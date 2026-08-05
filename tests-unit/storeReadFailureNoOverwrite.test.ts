/**
 * 各ストアの「読込失敗時に上書きしない」を固定する (W1 / 2026-08-06)。
 *
 * Sol 監査 DL-13/14/15 が指摘した病巣は全部同じ形だった:
 *   読込が失敗 → loaded:true かつ空 → 次の mutate がその空でディスクを上書き
 *
 * ここでは plugin-store をモックして「読めない正本」を作り、各ストアが
 * **1 バイトも書かない**ことを確かめる。牙 (この検査が本当に落ちるか) は
 * persistGuard.test.ts の「封鎖を外すと書けてしまう」で実証済み。
 *
 * 各テストは setup.ts の afterEach (resetModules) で隔離され、
 * **モックを仕込んでから動的 import** する。ストアは guard の解禁フラグを
 * モジュール変数で持つため、静的 import すると前テストの状態を引き継ぐ。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 1 ファイル分のフェイク plugin-store。読みの失敗モードを注入できる。 */
type FileMock = {
  /** get が投げる (I/O 障害)。 */
  getThrows?: boolean;
  /** get が返す生の値。undefined = キー未作成。 */
  value?: unknown;
};

type Recorder = {
  /** ファイル名 -> 書き込まれた [key, value] の列。 */
  writes: Record<string, Array<[string, unknown]>>;
  /** load() が呼ばれたファイル名。 */
  opened: string[];
};

/**
 * `@tauri-apps/plugin-store` をモックする。
 * ストア側は動的 import するので、vi.doMock で十分 (hoist 不要)。
 */
function mockPluginStore(files: Record<string, FileMock>): Recorder {
  const rec: Recorder = { writes: {}, opened: [] };
  vi.doMock("@tauri-apps/plugin-store", () => ({
    load: async (file: string) => {
      rec.opened.push(file);
      const conf = files[file] ?? {};
      return {
        get: async (_key: string) => {
          if (conf.getThrows) throw new Error(`EIO: ${file}`);
          return conf.value;
        },
        set: async (key: string, value: unknown) => {
          (rec.writes[file] ??= []).push([key, value]);
        },
        save: async () => {},
      };
    },
  }));
  return rec;
}

/** そのファイルへの書き込み件数 (未登録なら 0)。 */
function writeCount(rec: Recorder, file: string): number {
  return rec.writes[file]?.length ?? 0;
}

beforeEach(() => {
  localStorage.clear();
});

describe("savedPrompts: 読込失敗時に上書きしない (DL-13)", () => {
  it("I/O 失敗のあとの save はディスクを触らない", async () => {
    const rec = mockPluginStore({ "prompts.json": { getThrows: true } });
    const { useSavedPrompts } = await import("../src/lib/store/savedPrompts");

    await useSavedPrompts.getState().load();
    // 画面は空 (読めなかったので当然)。
    expect(useSavedPrompts.getState().items).toEqual([]);

    await useSavedPrompts.getState().save({
      title: "新規",
      body: "本文",
      tags: [],
      pinned: false,
      useCount: 0,
    });

    // ここが核心: 既存のプロンプト帳を空基準で上書きしていない。
    expect(writeCount(rec, "prompts.json")).toBe(0);
  });

  it("壊れた台帳 (invalid) でも上書きしない", async () => {
    const rec = mockPluginStore({
      // id を持たない要素が混じった = 手編集の事故。
      "prompts.json": { value: [{ title: "id が無い" }] },
    });
    const { useSavedPrompts } = await import("../src/lib/store/savedPrompts");

    await useSavedPrompts.getState().load();
    await useSavedPrompts.getState().remove("whatever");

    expect(writeCount(rec, "prompts.json")).toBe(0);
  });

  it("正常に読めたときは従来どおり保存できる (封鎖しすぎていない)", async () => {
    const rec = mockPluginStore({
      "prompts.json": {
        value: [
          {
            id: "p1",
            title: "既存",
            body: "b",
            tags: [],
            pinned: false,
            useCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const { useSavedPrompts } = await import("../src/lib/store/savedPrompts");

    await useSavedPrompts.getState().load();
    expect(useSavedPrompts.getState().items).toHaveLength(1);

    await useSavedPrompts.getState().save({
      title: "追加",
      body: "本文",
      tags: [],
      pinned: false,
      useCount: 0,
    });

    expect(writeCount(rec, "prompts.json")).toBe(1);
    const [, written] = rec.writes["prompts.json"][0];
    // 既存 1 件 + 追加 1 件。既存を落としていない。
    expect(written).toHaveLength(2);
  });
});

describe("worldContexts: 読込失敗時に上書きしない (DL-13)", () => {
  it("I/O 失敗のあとは、レガシー移行も通常保存も走らない", async () => {
    const rec = mockPluginStore({
      "world-contexts.json": { getThrows: true },
      // settings は読めるが worldContext は空 (移行の種は無い)。
      "settings.json": { value: {} },
    });
    const { useWorldContexts } = await import("../src/lib/store/worldContexts");

    await useWorldContexts.getState().load();
    await useWorldContexts.getState().create("新しい世界観");

    // 読めていないので 1 バイトも書かない。
    expect(writeCount(rec, "world-contexts.json")).toBe(0);
  });

  it("読込失敗のときレガシー移行を走らせない (既存の世界観を潰さない)", async () => {
    // これが DL-13 の最悪ケース: 読めない → 空 → 「未移行だ」と誤認して
    // settings のレガシー値で上書きする。
    const rec = mockPluginStore({
      "world-contexts.json": { getThrows: true },
      "settings.json": { value: { worldContext: "古い単一コンテキスト" } },
    });
    const { useWorldContexts } = await import("../src/lib/store/worldContexts");

    await useWorldContexts.getState().load();

    expect(writeCount(rec, "world-contexts.json")).toBe(0);
  });

  it("キー未作成 (absent) なら従来どおりレガシー移行が走る", async () => {
    const rec = mockPluginStore({
      "world-contexts.json": { value: undefined },
      "settings.json": { value: { worldContext: "古い単一コンテキスト" } },
    });
    const { useWorldContexts } = await import("../src/lib/store/worldContexts");

    await useWorldContexts.getState().load();

    // items + activeId の 2 キーが書かれる。
    expect(writeCount(rec, "world-contexts.json")).toBeGreaterThan(0);
    expect(useWorldContexts.getState().items).toHaveLength(1);
    expect(useWorldContexts.getState().items[0].content).toBe("古い単一コンテキスト");
  });
});

describe("comicStoryHistory: 読込失敗時に上書きしない (DL-14)", () => {
  it("I/O 失敗のあとの add はディスクを触らない", async () => {
    const rec = mockPluginStore({ "comic-stories.json": { getThrows: true } });
    const { useComicStoryHistory } = await import(
      "../src/lib/store/comicStoryHistory"
    );

    await useComicStoryHistory.getState().load();
    await useComicStoryHistory.getState().add("新しいあらすじ");

    expect(writeCount(rec, "comic-stories.json")).toBe(0);
  });

  it("正常に読めたときは追記できる", async () => {
    const rec = mockPluginStore({
      "comic-stories.json": {
        value: [{ id: "h1", text: "既存のあらすじ", createdAt: 1 }],
      },
    });
    const { useComicStoryHistory } = await import(
      "../src/lib/store/comicStoryHistory"
    );

    await useComicStoryHistory.getState().load();
    await useComicStoryHistory.getState().add("新しいあらすじ");

    expect(writeCount(rec, "comic-stories.json")).toBe(1);
    const [, written] = rec.writes["comic-stories.json"][0];
    expect(written).toHaveLength(2);
  });
});

describe("unsavedPlanChats: 読込失敗時に上書きしない (DL-14)", () => {
  it("I/O 失敗のあとの upsert はディスクを触らない", async () => {
    const rec = mockPluginStore({ "plan-chat-unsaved.json": { getThrows: true } });
    const { useUnsavedPlanChats } = await import(
      "../src/lib/store/unsavedPlanChats"
    );

    await useUnsavedPlanChats.getState().load();
    await useUnsavedPlanChats
      .getState()
      .upsert(undefined, [
        { id: "m1", role: "user", text: "こんにちは" },
      ] as never);

    expect(writeCount(rec, "plan-chat-unsaved.json")).toBe(0);
  });

  it("正常に読めたときは退避できる", async () => {
    const rec = mockPluginStore({ "plan-chat-unsaved.json": { value: [] } });
    const { useUnsavedPlanChats } = await import(
      "../src/lib/store/unsavedPlanChats"
    );

    await useUnsavedPlanChats.getState().load();
    const { created } = await useUnsavedPlanChats
      .getState()
      .upsert(undefined, [
        { id: "m1", role: "user", text: "こんにちは" },
      ] as never);

    expect(created).toBe(true);
    expect(writeCount(rec, "plan-chat-unsaved.json")).toBe(1);
  });
});

describe("settings: 読込失敗時に上書きしない (DL-14)", () => {
  it("I/O 失敗のあとの save はディスクを触らない", async () => {
    const rec = mockPluginStore({ "settings.json": { getThrows: true } });
    const { useSettings } = await import("../src/lib/store/settings");

    await useSettings.getState().load();
    await useSettings.getState().save({ defaultModel: "gpt-5.6" });

    // 画面 (メモリ) には反映されるが、ディスクの既存設定は守られる。
    expect(useSettings.getState().settings.defaultModel).toBe("gpt-5.6");
    expect(writeCount(rec, "settings.json")).toBe(0);
  });

  it("正常に読めたときは既存設定を保ったまま追記できる", async () => {
    const rec = mockPluginStore({
      "settings.json": { value: { codexBinaryPath: "/usr/bin/codex" } },
    });
    const { useSettings } = await import("../src/lib/store/settings");

    await useSettings.getState().load();
    await useSettings.getState().save({ defaultModel: "gpt-5.6" });

    expect(writeCount(rec, "settings.json")).toBe(1);
    const [, written] = rec.writes["settings.json"][0];
    // patch が既存キーを消していない。
    expect(written).toEqual({
      codexBinaryPath: "/usr/bin/codex",
      defaultModel: "gpt-5.6",
    });
  });
});

describe("errorLog: 読込失敗時に上書きしない (DL-14)", () => {
  it("I/O 失敗のあとの log はディスクを触らない", async () => {
    const rec = mockPluginStore({ "error-log.json": { getThrows: true } });
    const { useErrorLog } = await import("../src/lib/store/errorLog");

    await useErrorLog.getState().load();
    useErrorLog.getState().log({ message: "何かのエラー" });
    // log は fire-and-forget なのでマイクロタスクを流す。
    await new Promise((r) => setTimeout(r, 0));

    // 画面には出るが、過去ログを今回分だけで潰さない。
    expect(useErrorLog.getState().entries).toHaveLength(1);
    expect(writeCount(rec, "error-log.json")).toBe(0);
  });

  it("clear は明示操作なので、読込失敗中でも実行できる", async () => {
    // 「消したのに再起動で戻る」を避ける。ユーザーの意思は通す。
    const rec = mockPluginStore({ "error-log.json": { getThrows: true } });
    const { useErrorLog } = await import("../src/lib/store/errorLog");

    await useErrorLog.getState().load();
    await useErrorLog.getState().clear();

    expect(writeCount(rec, "error-log.json")).toBe(1);
    expect(rec.writes["error-log.json"][0][1]).toEqual([]);
  });
});

describe("images: favorites / judgements は読込失敗時に上書きしない (DL-15)", () => {
  it("favorites の I/O 失敗のあと toggle してもディスクを触らない", async () => {
    const rec = mockPluginStore({
      "favorites.json": { getThrows: true },
      "judgements.json": { value: {} },
    });
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().loadFavorites();
    await useImages.getState().toggleFavorite("/img/a.png");

    // 画面上はお気に入りが付くが、数百枚分の既存メタは守られる。
    expect(useImages.getState().favorites.has("/img/a.png")).toBe(true);
    expect(writeCount(rec, "favorites.json")).toBe(0);
  });

  it("judgements の I/O 失敗のあと setJudgement してもディスクを触らない", async () => {
    const rec = mockPluginStore({
      "favorites.json": { value: [] },
      "judgements.json": { getThrows: true },
    });
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().loadJudgements();
    await useImages.getState().setJudgement("/img/a.png", "adopted");

    expect(writeCount(rec, "judgements.json")).toBe(0);
  });

  it("正常に読めたときは従来どおり保存できる", async () => {
    const rec = mockPluginStore({
      "favorites.json": { value: ["/img/existing.png"] },
      "judgements.json": { value: { "/img/existing.png": "adopted" } },
    });
    const { useImages } = await import("../src/lib/store/images");

    await useImages.getState().loadFavorites();
    await useImages.getState().toggleFavorite("/img/new.png");
    await useImages.getState().loadJudgements();
    await useImages.getState().setJudgement("/img/new.png", "rejected");

    expect(writeCount(rec, "favorites.json")).toBe(1);
    // 既存を落としていない。
    expect(rec.writes["favorites.json"][0][1]).toEqual([
      "/img/existing.png",
      "/img/new.png",
    ]);
    expect(writeCount(rec, "judgements.json")).toBe(1);
    expect(rec.writes["judgements.json"][0][1]).toEqual({
      "/img/existing.png": "adopted",
      "/img/new.png": "rejected",
    });
  });
});

describe("referenceRoles: 移行失敗のあと書き込みを解禁しない (DL-12)", () => {
  it("初回移行の保存に失敗したら、以後もファイルへ書かない", async () => {
    // localStorage に既存のロールがある = 移行対象がある状態。
    localStorage.setItem(
      "referenceRoles.byPath",
      JSON.stringify({ "/img/a.png": "style" }),
    );
    // set は常に throw するので「書けた件数」では判定できない
    // (throw する mock で writeCount を見ると、封鎖の有無に関係なく 0 になり
    //  検査が空回りする)。**試行回数**を数えるのが正しい観測点。
    const attempts: Array<[string, unknown]> = [];
    vi.doMock("@tauri-apps/plugin-store", () => ({
      load: async () => ({
        // キー未作成 = 移行経路へ入る。
        get: async () => undefined,
        // 移行の書き込みが失敗する (ディスク満杯・権限など)。
        set: async (key: string, value: unknown) => {
          attempts.push([key, value]);
          throw new Error("ENOSPC");
        },
        save: async () => {},
      }),
    }));
    const { useReferenceRoles } = await import(
      "../src/lib/store/referenceRoles"
    );

    await useReferenceRoles.getState().initialize();
    // 移行の 1 回だけは試行される (これは正常。失敗を知るために必要)。
    expect(attempts).toHaveLength(1);

    // 移行に失敗したので、以後の mutate はファイルへ**試行すらしない**。
    useReferenceRoles.getState().setRole("/img/b.png", "item");
    // persist は同期関数で `void persistToStore()` する (fire-and-forget)。
    // ここで待たないと「まだ書かれていないだけ」を「書かなかった」と誤判定し、
    // 封鎖を外しても緑のままになる (牙が無くなる)。
    await new Promise((r) => setTimeout(r, 0));

    // 解禁されていれば 2 回目の試行が積まれる = 失敗を成功扱いした証拠。
    expect(attempts).toHaveLength(1);
    // localStorage 側には残る (唯一の実体として維持される)。
    expect(useReferenceRoles.getState().roles["/img/b.png"]).toBe("item");
  });

  it("認識できないロールを含むファイルでは書き込みを封鎖する", async () => {
    const rec = mockPluginStore({
      // 新バージョンが書いた未知のロール値を、古い自分が読んだ状況。
      "reference-roles.json": {
        value: { "/img/a.png": "character", "/img/b.png": "未知のロール" },
      },
    });
    const { useReferenceRoles } = await import(
      "../src/lib/store/referenceRoles"
    );

    await useReferenceRoles.getState().initialize();
    useReferenceRoles.getState().setRole("/img/c.png", "style");
    await new Promise((r) => setTimeout(r, 0)); // 上と同じ理由 (fire-and-forget)

    // 除外した状態を書き戻すと、新バージョンで付けたロールが恒久的に消える。
    expect(writeCount(rec, "reference-roles.json")).toBe(0);
  });

  it("正常なファイルなら従来どおり書き込める", async () => {
    const rec = mockPluginStore({
      "reference-roles.json": { value: { "/img/a.png": "character" } },
    });
    const { useReferenceRoles } = await import(
      "../src/lib/store/referenceRoles"
    );

    await useReferenceRoles.getState().initialize();
    useReferenceRoles.getState().setRole("/img/b.png", "style");
    await new Promise((r) => setTimeout(r, 0));

    expect(writeCount(rec, "reference-roles.json")).toBe(1);
  });
});
