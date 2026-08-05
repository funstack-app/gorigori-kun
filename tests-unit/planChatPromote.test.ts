/**
 * g8t (2026-08-04): 未保存企画チャットの案件昇格 promoteToProject のロックテスト。
 *
 * 守っている挙動:
 *   1. **順序**: createProject → carryOverToProject (会話コピー) → confirmProject →
 *      setActive。コピーが台帳 remove より先に走ることを carryOverToProject 内部が
 *      保証しており、昇格の途中で throw しても会話が消える窓が無い。
 *      → T-g8t-5 でこの順序を直接固定する (setActive をコピーより先に出すと
 *        carryOverToProject が「未保存でない」文脈で走り、台帳掃除の前提が崩れる)。
 *   2. **非破壊**: switchToProject を通らないので messages / pendingImages /
 *      pendingAudio / threadId が昇格前後で変化しない (同一会話の継続だから)。
 *   3. **ガード**: 案件選択中・会話ゼロでは何もせず null (空箱を作らない)。
 *
 * mockIPC で projects_read/write を握る。projects.persist は非同期の invoke に
 * 落ちるが、ストア状態の更新は同期なので判定は全て getState() で行える。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

import type { ProjectChatMessage } from "../src/lib/store/projects";

type PlanChatModule = typeof import("../src/lib/store/planChat");
type ProjectsModule = typeof import("../src/lib/store/projects");
type ActiveProjectModule = typeof import("../src/lib/store/activeProject");
type UnsavedModule = typeof import("../src/lib/store/unsavedPlanChats");

type Stores = {
  planChat: PlanChatModule;
  projects: ProjectsModule;
  activeProject: ActiveProjectModule;
  unsaved: UnsavedModule;
};

/**
 * plugin-store / projects_read を落とさないための IPC モック。
 *
 * g8t 追補 (2026-08-04): 「ディスクに何が載ったか」を観測できるようにした。
 * `writes` に projects_write の内容 (planChat 件数) を到着順で積むので、
 * 「台帳を消した時点で会話がディスクにあったか」を順序で検査できる。
 * `failWrites` を立てると projects_write だけが失敗する (保存失敗の再現)。
 */
type IpcMock = {
  calls: string[];
  /** projects_write で実際にディスクへ載った内容 (到着順)。 */
  writes: { planChatLens: number[] }[];
  /** true のあいだ projects_write が throw する。 */
  failWrites: boolean;
  /**
   * 内容を見て「この書き込みだけ失敗させる」述語 (g8t 2周目 2026-08-04)。
   * 「会話入りの保存だけ失敗し、他の保存は成功する」競合を再現するのに使う。
   * 一括 fail (failWrites) だけでは「失敗した待機者に別保存の成功が漏れる」穴を
   * 検出できない (全部失敗すると誤報の材料そのものが無いため)。
   */
  failWhen?: (parsed: { planChat?: unknown[] }[]) => boolean;
  /**
   * failWhen で失敗させた書き込みの直後に呼ばれるフック (g8t 2周目)。
   * 「失敗した保存の後に別の保存が成功する」順序を、await 回数に頼らず
   * 決定論的に作るために使う。
   */
  onFailedWrite?: () => void;
  /**
   * failWhen で弾くときに投げるエラー文言 (g8t 2周目)。
   * 既定は一般の書き込み失敗。Rust 側の大幅減少ガード
   * `[DECREASE_GUARD existing=N incoming=M]` を再現したいときに差し替える。
   */
  failMessage?: string;
  /**
   * projects_read を保留させるための Promise (g8t 2周目)。
   * 解決するまで読み直しが終わらないので、「読み直し中」の窓を
   * 決定論的に開けられる (await 回数調整に頼らない)。
   */
  holdRead?: Promise<void>;
  /**
   * projects_read が呼ばれた瞬間に鳴るフック (g8t 3周目)。
   * 「読み直しが始まった = reloadInProgress が立った」を await 回数の決め打ちでなく
   * 実イベントで捕まえるために使う。
   */
  onReadStart?: () => void;
  /**
   * 減少ガードの確認ダイアログ (plugin-dialog の ask) が返す答え (g8t 3周目)。
   *
   * ask() は内部で `plugin:dialog|message` を呼び、**戻り値が okLabel と一致するか**
   * で true/false を決める (`=== okLabel`)。したがってモックは真偽値ではなく
   * **押されたボタンのラベル文字列**を返す必要がある。
   * 既定 (未設定) は undefined = okLabel と一致しない = 「中止」。
   */
  askAnswer?: string;
  /** ask が呼ばれた瞬間に鳴るフック (ダイアログ表示中の窓を作るのに使う)。 */
  onAsk?: () => void;
  /**
   * **最初の1回だけ** projects_write を保留させる Promise (g8t 3周目)。
   * 1本目の書き込みが in-flight のあいだに後続要求を積ませ、最後勝ちキューの
   * 上書きスキップ (中間要求が飛ばされる) を決定論的に再現するのに使う。
   */
  holdWriteOnce?: Promise<void>;
};

function installIpcMock(): IpcMock {
  const mock: IpcMock = { calls: [], writes: [], failWrites: false };
  mockIPC(async (cmd, args) => {
    mock.calls.push(cmd);
    // plugin-dialog の ask (減少ガードの確認)。
    // ask() は内部で `plugin:dialog|message` を呼ぶ (askCommand の実体)。
    if (cmd === "plugin:dialog|message") {
      mock.onAsk?.();
      return mock.askAnswer;
    }
    if (cmd === "projects_read") {
      mock.onReadStart?.();
      if (mock.holdRead) await mock.holdRead;
      return "[]";
    }
    if (cmd === "projects_write") {
      // 1本目だけ保留する (2本目以降は素通り)。
      if (mock.holdWriteOnce) {
        const held = mock.holdWriteOnce;
        mock.holdWriteOnce = undefined;
        await held;
      }
      if (mock.failWrites) throw new Error("disk full (test)");
      const content = (args as { content?: string } | undefined)?.content ?? "[]";
      const parsed = JSON.parse(content) as { planChat?: unknown[] }[];
      if (mock.failWhen?.(parsed)) {
        mock.onFailedWrite?.();
        throw new Error(mock.failMessage ?? "disk full for this snapshot (test)");
      }
      mock.writes.push({
        planChatLens: parsed.map((p) => p.planChat?.length ?? 0),
      });
    }
    return undefined;
  });
  return mock;
}

/** 未保存台帳に会話が1件ある状態を作る。 */
function seedLedger(unsaved: UnsavedModule, id = "u_entry_1"): void {
  unsaved.useUnsavedPlanChats.setState({
    loaded: true,
    items: [
      {
        id,
        title: "夏祭りのポスターを作りたい",
        messages: planMessages(),
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
  });
}

/** mockIPC 登録後に各ストアを新規 import する (setup.ts の resetModules 前提)。 */
async function loadStores(): Promise<Stores> {
  return {
    planChat: await import("../src/lib/store/planChat"),
    projects: await import("../src/lib/store/projects"),
    activeProject: await import("../src/lib/store/activeProject"),
    unsaved: await import("../src/lib/store/unsavedPlanChats"),
  };
}

/**
 * 待機者が「解決されない (永久待ち)」ことを検出するためのヘルパ (g8t 2周目)。
 * 解決されなければ kind:"timeout" が返るので、テストが赤くなる。
 */
async function withTimeout(
  p: Promise<boolean>,
  ms = 1000,
): Promise<{ kind: "settled"; ok: boolean } | { kind: "timeout" }> {
  return Promise.race([
    p.then((ok) => ({ kind: "settled" as const, ok })),
    new Promise<{ kind: "timeout" }>((r) => setTimeout(() => r({ kind: "timeout" }), ms)),
  ]);
}

function planMessages(): ProjectChatMessage[] {
  return [
    { id: "m1", role: "user", text: "夏祭りのポスターを作りたい", createdAt: 1000 },
    { id: "m2", role: "assistant", text: "了解です。構図はどうしますか", createdAt: 2000 },
  ];
}

/**
 * planMessages() と **同じ件数だが中身が違う** 別会話 (g8t 4周目)。
 * 「件数だけを見る検証」を素通りさせるための材料。
 */
function otherPlanMessages(): ProjectChatMessage[] {
  return [
    { id: "x1", role: "user", text: "全然ちがう話をしています", createdAt: 5000 },
    { id: "x2", role: "assistant", text: "承知しました", createdAt: 6000 },
  ];
}

beforeEach(() => {
  localStorage.clear();
});

describe("planChat.promoteToProject (g8t)", () => {
  it("T-g8t-1: 正常昇格 — active 案件が出来て会話が移り、pending/thread は非破壊", async () => {
    installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    // 未保存 (activeProjectId === null) のまま会話が進んだ状態を作る。
    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
      pendingImages: ["/tmp/ref-a.png"],
      threadId: "thread_abc",
    });
    // 台帳側にも同じエントリが居る状態にする (昇格で消えることを見る)。
    seedLedger(unsaved);

    const before = planChat.usePlanChat.getState();
    const beforeMessages = before.messages;
    const beforePending = before.pendingImages;
    const beforeThreadId = before.threadId;

    const result = await planChat.usePlanChat.getState().promoteToProject("夏祭りポスター案件");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.carried).toBe(2);
    expect(result.projectName).toBe("夏祭りポスター案件");

    // (a) 案件が status "active" で出来て、planChat が全量入っている。
    const created = projects.useProjects
      .getState()
      .projects.find((p) => p.id === result.projectId);
    expect(created).toBeDefined();
    expect(created?.status).toBe("active");
    expect(created?.planChat).toHaveLength(2);
    expect(created?.planChat?.[0]?.text).toBe("夏祭りのポスターを作りたい");

    // (b) 以後の turn/completed が案件へ入るよう activeProjectId が立つ。
    expect(activeProject.useActiveProject.getState().activeProjectId).toBe(
      result.projectId,
    );

    // (c) 台帳エントリは削除される (履歴に「未保存」として二重に出さない)。
    //     promoteToProject の await 完了時点で削除済み (保存 → 削除の順)。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeUndefined();
    expect(planChat.usePlanChat.getState().unsavedChatId).toBeUndefined();

    // (d) 非破壊: switchToProject を通らないので画面の会話・未送信添付・
    //     AI スレッド文脈は一切変わらない (同一会話の継続だから)。
    const after = planChat.usePlanChat.getState();
    expect(after.messages).toBe(beforeMessages);
    expect(after.pendingImages).toBe(beforePending);
    expect(after.threadId).toBe(beforeThreadId);
  });

  it("T-g8t-2: ガード — 会話ゼロなら guard 返却で、案件は作られない", async () => {
    installIpcMock();
    const { planChat, projects, activeProject } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({ messages: [] });
    const countBefore = projects.useProjects.getState().projects.length;

    const result = await planChat.usePlanChat.getState().promoteToProject("空の案件");

    expect(result).toEqual({ ok: false, reason: "guard" });
    expect(projects.useProjects.getState().projects).toHaveLength(countBefore);
    expect(activeProject.useActiveProject.getState().activeProjectId).toBeNull();
  });

  it("T-g8t-3: ガード — 案件選択中なら guard 返却で、案件は作られない", async () => {
    installIpcMock();
    const { planChat, projects, activeProject } = await loadStores();

    const existing = projects.useProjects.getState().createProject("既存案件");
    activeProject.useActiveProject.getState().setActive(existing.id);
    planChat.usePlanChat.setState({ messages: planMessages() });
    const countBefore = projects.useProjects.getState().projects.length;

    const result = await planChat.usePlanChat.getState().promoteToProject("重複案件");

    expect(result).toEqual({ ok: false, reason: "guard" });
    expect(projects.useProjects.getState().projects).toHaveLength(countBefore);
    // 選択中の案件は差し替わらない。
    expect(activeProject.useActiveProject.getState().activeProjectId).toBe(existing.id);
  });

  it("T-g8t-4: deriveTitle は export 後も既存挙動 (先頭 user 40字 / 空は既定文言)", async () => {
    installIpcMock();
    const { unsaved } = await loadStores();

    expect(unsaved.deriveTitle(planMessages())).toBe("夏祭りのポスターを作りたい");
    expect(unsaved.deriveTitle([])).toBe("（企画チャット）");
    // assistant しか無い場合も既定文言 (user 発話がタイトルの正)。
    expect(
      unsaved.deriveTitle([
        { id: "a1", role: "assistant", text: "こんにちは", createdAt: 1 },
      ]),
    ).toBe("（企画チャット）");
    // 40字で切る。
    const long = "あ".repeat(60);
    expect(
      unsaved.deriveTitle([{ id: "u1", role: "user", text: long, createdAt: 1 }]),
    ).toBe("あ".repeat(40));
  });

  it("T-g8t-5: 順序ロック — 会話がディスクに載る前に未保存台帳を消さない", async () => {
    // 牙 (最重要): 保存完了を待たずに台帳を消す旧実装に戻すと、このテストが落ちる。
    // 「remove が呼ばれた瞬間、ディスクには会話入りの案件が既に載っているか」を
    // 直接固定する。載っていない状態で台帳を消せば、その瞬間にクラッシュすると
    // 会話がどこにも無くなる (Sol指摘 B-1 のデータ消失窓)。
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    // remove が呼ばれた時点のディスク状態 (= それまでに載った書き込み) を捕まえる。
    let diskAtRemove: { planChatLens: number[] }[] = [];
    const realRemove = unsaved.useUnsavedPlanChats.getState().remove;
    unsaved.useUnsavedPlanChats.setState({
      remove: async (id: string) => {
        diskAtRemove = ipc.writes.map((w) => ({ planChatLens: [...w.planChatLens] }));
        return realRemove(id);
      },
    });

    const result = await planChat.usePlanChat.getState().promoteToProject("順序テスト案件");
    expect(result.ok).toBe(true);

    // 台帳削除の時点で、会話 2 件入りの案件が既にディスクへ載っている。
    expect(diskAtRemove.length).toBeGreaterThan(0);
    expect(diskAtRemove.some((w) => w.planChatLens.includes(2))).toBe(true);

    // 事後: 台帳は空、案件側に会話が残っている (= 会話は常にどちらかに存在した)。
    expect(unsaved.useUnsavedPlanChats.getState().items).toHaveLength(0);
    const created = projects.useProjects
      .getState()
      .projects.find((p) => result.ok && p.id === result.projectId);
    expect(created?.planChat).toHaveLength(2);
  });

  it("T-g8t-6: 保存失敗 — 台帳を残したまま save-failed を返し、空箱も作らない", async () => {
    // 保存が失敗したのに成功扱いで台帳を消すと、会話がどこにも無くなる。
    // 失敗時は「台帳に残っている」ことを構造で保証する (Sol指摘 B-2)。
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);
    ipc.failWrites = true;

    const result = await planChat.usePlanChat.getState().promoteToProject("失敗する案件");

    expect(result).toEqual({ ok: false, reason: "save-failed" });
    // (a) 会話は未保存台帳に残っている = 消失していない。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeDefined();
    // (b) 画面側の紐づけも維持される (次の自動退避が同じエントリを更新できる)。
    expect(planChat.usePlanChat.getState().unsavedChatId).toBe("u_entry_1");
    // (c) 中途半端な空案件を残さない。
    expect(projects.useProjects.getState().projects).toHaveLength(0);
    // (d) active にしない (保存できていない案件へ以後の会話を書き込ませない)。
    expect(activeProject.useActiveProject.getState().activeProjectId).toBeNull();
    // (e) 画面の会話はそのまま (ユーザーは再試行できる)。
    expect(planChat.usePlanChat.getState().messages).toHaveLength(2);
  });

  it("T-g8t-7: 二重連打 — 同時に2回呼んでも案件は1つだけ", async () => {
    // 保存を await するあいだ activeProjectId はまだ null なので、既存ガードでは
    // 2 回目を止められない。promoting フラグで塞いでいることを固定する。
    installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    const promote = planChat.usePlanChat.getState().promoteToProject;
    const [first, second] = await Promise.all([
      promote("連打案件"),
      promote("連打案件"),
    ]);

    // 片方だけ成功し、もう片方はガードで弾かれる。
    const oks = [first, second].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([first, second].filter((r) => !r.ok && r.reason === "guard")).toHaveLength(1);
    // 案件は 1 つだけ (空箱も重複も作らない)。
    expect(projects.useProjects.getState().projects).toHaveLength(1);
    expect(projects.useProjects.getState().projects[0]?.planChat).toHaveLength(2);
  });

  // ==========================================================================
  // g8t 2周目 (2026-08-04): 保存リビジョン単位の完了判定 (Sol指摘の残存2件)。
  //
  // 旧実装は「ループが 1 周終わった時点の成否」を **全待機者へ同じ値で** 配って
  // いた。保存キューは最後勝ちで中間状態をスキップするため、
  //   - 会話保存が捨てられた/失敗した後に、別の保存 (削除・reload 後の書き込み)
  //     が成功すると、会話側の待機者にも true が返る
  // という誤報が起き、promoteToProject が「保存できた」と誤認して未保存台帳を
  // 消し、消失窓が再発していた。
  //
  // 下の 3 本は、待機者が **自分の rev を含む保存の結末だけ** で解決されることを
  // 固定する。牙: settleWaitersUpTo(job.rev, ...) を単一 ok の一括配布へ戻すと
  // T-g8t-9 / T-g8t-10 が落ちる (実証済み)。
  // ==========================================================================

  it("T-g8t-8: 会話保存中の削除競合 — 会話が載っていないなら昇格は成功にならない", async () => {
    // Sol の再現した conversation-then-delete。
    // 会話入りのスナップショットだけが書けない状況で昇格すると、旧実装では
    // 「後続の別保存の成功」が会話側の待機者へ漏れて promoted=true になり、
    // 会話がディスクに無いのに未保存台帳を消していた。
    //
    // ここでは promoteToProject の公開経路で「会話入り保存が1度も成立しない」
    // ことと「それでも昇格が成功扱いにならない」ことを固定する。
    // 待機者の汚染そのものの牙は T-g8t-10 が持つ (writeToFile 層で直接検査)。
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    // 会話 (planChat 2件) を含む書き込みだけを失敗させ、それ以外は成功させる。
    // = 「会話はディスクに載らなかったが、他の保存は載った」状態。
    ipc.failWhen = (parsed) => parsed.some((p) => (p.planChat?.length ?? 0) === 2);

    const result = await planChat.usePlanChat.getState().promoteToProject("競合案件");

    // 会話が載っていない以上、昇格は失敗でなければならない。
    expect(result).toEqual({ ok: false, reason: "save-failed" });
    // 台帳は残る (会話はどこにも消えていない)。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeDefined();
    expect(planChat.usePlanChat.getState().unsavedChatId).toBe("u_entry_1");
    // 会話入りの書き込みは 1 つもディスクに載っていない (前提の確認)。
    expect(ipc.writes.some((w) => w.planChatLens.includes(2))).toBe(false);
    // 会話を含まない保存は成功している = 「全部失敗したから false だった」のでは
    // ないことを示す (この行が無いと本テストは穴を検出できない)。
    expect(ipc.writes.length).toBeGreaterThan(0);
    // 空箱も残さない。
    expect(projects.useProjects.getState().projects).toHaveLength(0);
  });

  it("T-g8t-9: reloadInProgress 中に積まれた保存は、後続の成功に汚染されず false", async () => {
    // E-1 (読み直し中に積まれた保存は staleFromReload で破棄される) の直後に、
    // 正当な新規保存が成功する状況。
    //
    // 旧実装は「ループが1周終わった時点の ok を全待機者へ一括配布」していたため、
    // **破棄された保存の待機者にも、後続の別保存の成功が true として届いた**。
    // 会話がディスクに無いのに promoteToProject が成功扱いになり、未保存台帳を
    // 消す = 消失窓。ここではその汚染が起きないことを固定する。
    //
    // g8t 3周目の書き直し: 旧版は initialize() の projects_read を保留していたが、
    // **initialize() は readFromFile() を通るので reloadInProgress を立てない**
    // (立てるのは reloadFromDiskIntoStore だけ)。つまり旧版は stale 経路を一度も
    // 踏んでおらず、false になっていたのは別の理由だった = 守りたい挙動を
    // 守れていなかった。ここでは実際に reloadInProgress を立てる唯一の経路
    // = 減少ガードで「中止してディスクから読み直す」を選ぶ、を通す。
    const ipc = installIpcMock();
    const { projects } = await loadStores();

    // 対象プロジェクトを実在させる (保存内容の検証が通る前提を作る)。
    projects.useProjects.setState({
      projects: [
        { id: "p1", name: "A", status: "active", items: [], createdAt: 1, updatedAt: 1 },
        { id: "p2", name: "B", status: "active", items: [], createdAt: 1, updatedAt: 1 },
      ] as never,
    });

    // 減少ガードを踏ませる → ask=false = 「中止して読み直す」
    // → reloadFromDiskIntoStore() が走り reloadInProgress が立つ。
    // その読み直しを holdRead で保留し、窓を開けたままにする。
    let releaseRead: (() => void) | undefined;
    ipc.holdRead = new Promise<void>((r) => {
      releaseRead = r;
    });
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((r) => {
      signalReadStarted = r;
    });
    ipc.onReadStart = () => signalReadStarted?.();
    // askAnswer 未設定 = okLabel と一致しない = 「中止してディスクから読み直す」
    {
      let guardArmed = true;
      ipc.failWhen = () => {
        if (!guardArmed) return false;
        guardArmed = false;
        return true;
      };
      ipc.failMessage = "[DECREASE_GUARD existing=10 incoming=2]";

      // ガードに当たる保存 (これ自体は書かれない)。
      const guarded = projects.useProjects.getState().setPlanChat("p1", planMessages());

      // 読み直しが **実際に始まる** まで待つ (await 回数の決め打ちをしない)。
      // projects_read が呼ばれた = reloadFromDiskIntoStore に入り
      // reloadInProgress が立った、の確実な合図。
      await readStarted;

      // 読み直し中に積まれる保存 = staleFromReload で破棄される側。
      const duringReload = projects.useProjects
        .getState()
        .setPlanChat("p2", planMessages());

      // 読み直しを完了させ、フラグを下ろす。
      // guarded / duringReload の解決まで待ってから次に進む (読み直しが終わって
      // reloadInProgress が下りたことを、待機者の解決で確認する)。
      releaseRead?.();
      const guardedResult = await withTimeout(guarded);
      const during = await withTimeout(duringReload);

      // 読み直しで store はディスク側の正本 ([] = 空) に揃っている。
      // 読み直し後にユーザーが行う正当な新操作を再現する。
      ipc.failWhen = undefined;
      projects.useProjects.setState({
        projects: [
          { id: "p2", name: "B", status: "active", items: [], createdAt: 1, updatedAt: 1 },
        ] as never,
      });
      const after = await withTimeout(
        projects.useProjects.getState().setPlanChat("p2", planMessages()),
      );

      // 全員必ず解決される (永久待ちにしない)。
      expect(guardedResult.kind).toBe("settled");
      expect(during.kind).toBe("settled");
      expect(after.kind).toBe("settled");

      // 読み直し中に積まれた保存は書かれていないので false。
      // 後続 (afterReload) の成功に汚染されないことがこのテストの主眼。

      if (during.kind === "settled") expect(during.ok).toBe(false);
      // 中止を選んだガード側も書かれていないので false。
      if (guardedResult.kind === "settled") expect(guardedResult.ok).toBe(false);
      // 読み直し後の正当な保存は実際に載るので true。
      if (after.kind === "settled") expect(after.ok).toBe(true);
      expect(ipc.writes.some((w) => w.planChatLens.includes(2))).toBe(true);
    }
  });

  it("T-g8t-10: 失敗保存の待機者が後続の成功に汚染されない", async () => {
    // 牙の中心。保存Aが失敗 → 保存Bが成功、のとき A の待機者が true を拾わないこと。
    // 旧実装 (最後の ok を全員へ) では A も true になり、これが消失窓の直接原因だった。
    const ipc = installIpcMock();
    const { projects } = await loadStores();

    // 両方のプロジェクトを実在させる (不在で false になる別経路と混同しないため)。
    projects.useProjects.setState({
      projects: [
        { id: "proj-a", name: "A", status: "active", items: [], createdAt: 1, updatedAt: 1 },
        { id: "proj-b", name: "B", status: "active", items: [], createdAt: 1, updatedAt: 1 },
      ] as never,
    });
    const store = projects.useProjects.getState();

    // まず失敗する保存 A を投げる。
    ipc.failWrites = true;
    const failing = store.setPlanChat("proj-a", planMessages());

    // A の invoke が始まってから、成功する保存 B を積む
    // (= キューに載り、A の完了後に同じループの次周回で書かれる)。
    await Promise.resolve();
    ipc.failWrites = false;
    const succeeding = store.setPlanChat("proj-b", planMessages());

    const [aOk, bOk] = await Promise.all([failing, succeeding]);

    // A は失敗のまま。B の成功に汚染されない。
    expect(aOk).toBe(false);
    // B は実際に書けているので true。
    expect(bOk).toBe(true);
    // 書き込みは B の分だけディスクに載っている。
    expect(ipc.writes.length).toBeGreaterThan(0);
  });

  // ==========================================================================
  // g8t 3周目 (2026-08-04): 昇格成功の **内容検証** (Sol 最終確認の残存)。
  //
  // rev 判定だけでは「自分より後のスナップショットが載れば自分の内容も載る」が
  // 前提になるが、最後勝ちキューは中間要求を上書きスキップするため、昇格中に
  // 同じプロジェクトの削除が割り込むと前提が崩れる:
  //   rev1 createProject(空) → rev2 confirm(スキップ) → rev3 会話入り(スキップ)
  //   → rev4 削除(成功・0件)
  // rev4 の成功が rev3 の待機者へ true として届き、**ディスクの会話は0件なのに**
  // 昇格が成功扱いになって未保存台帳を消す = 会話がどこにも無くなる。
  //
  // 牙: setPlanChat の verify (載った内容に対象プロジェクトと会話が在るか) を
  // 外すと T-g8t-11 が落ちる (実証済み: 外した状態で ok=true / ledger=[] になる)。
  // ==========================================================================

  it("T-g8t-11: 昇格中に同プロジェクト削除が割り込む — promoted=false で台帳が残る", async () => {
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    // 1本目 (createProject の空スナップショット) の書き込みを保留し、その間に
    // confirm / 会話保存 / 削除 を積ませる。最後勝ちで中間はスキップされ、
    // ディスクに最後に載るのは「削除後 = 0件」になる。
    let releaseFirst: (() => void) | undefined;
    ipc.holdWriteOnce = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const promoting = planChat.usePlanChat.getState().promoteToProject("競合案件");

    // 保存が in-flight で止まっているあいだに削除を割り込ませる。
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const created = projects.useProjects.getState().projects[0];
    expect(created).toBeDefined();
    projects.useProjects.getState().removeProject(created.id);

    releaseFirst?.();
    const result = await promoting;

    // ディスクに会話は載っていない。
    expect(ipc.writes.some((w) => w.planChatLens.includes(2))).toBe(false);
    // なので昇格は成功にならない。
    expect(result).toEqual({ ok: false, reason: "save-failed" });
    // 台帳は残る = 会話はどこにも消えていない (これが守りたい実体)。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeDefined();
    expect(planChat.usePlanChat.getState().unsavedChatId).toBe("u_entry_1");
    // 「全部失敗したから false」ではないことの確認 (削除の保存は成功している)。
    expect(ipc.writes.length).toBeGreaterThan(0);
  });

  it("T-g8t-12: 非退行 — 割り込みが無ければ昇格は従来どおり成功する", async () => {
    // T-g8t-11 の内容検証が「常に false」になっていないことを固定する
    // (検証を厳しくしすぎて正常系まで殺す退行の検出)。
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    const result = await planChat.usePlanChat.getState().promoteToProject("通常案件");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.carried).toBe(2);
    // 会話がディスクに載っている。
    expect(ipc.writes.some((w) => w.planChatLens.includes(2))).toBe(true);
    // 台帳は消える (会話は案件側の正本へ移った)。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeUndefined();
    expect(projects.useProjects.getState().projects).toHaveLength(1);
    expect(projects.useProjects.getState().projects[0]?.planChat).toHaveLength(2);
  });

  it("T-g8t-13: 減少ガードで上書きを選んだ再投入は、ダイアログ中の保存も一緒に解決する", async () => {
    // 減少ガードの「このまま上書きする」は、**その時点の最新スナップショット**を
    // 書き直す。つまりダイアログ表示中に積まれた保存の内容も一緒にディスクへ載る。
    //
    // 2周目までは再投入に元の rev (guardedRev) を引き継いでいたため、
    // guardedRev より後に積まれた待機者が置き去りになった: 内容は実際に書かれるのに
    // rev が古いままなので settleWaitersUpTo(guardedRev, ...) では刈られず、
    // ループ末尾の安全網で false にされる = **保存できているのに「失敗」と誤報**する。
    // 昇格がこれを踏むと、会話がディスクに在るのに save-failed になる。
    //
    // 牙: 再投入の rev を `++writeRevSeq` から `guardedRev` に戻すと、
    // dialogSave が false になり本テストが落ちる。
    //
    // 「ダイアログ表示中の保存」は、confirm スタブの中から積むことで決定論的に作る
    // (confirm は同期 API なので、この瞬間が handleDecreaseGuard の内側だと確定できる)。
    const ipc = installIpcMock();
    const { projects } = await loadStores();

    projects.useProjects.setState({
      projects: [
        { id: "p1", name: "A", status: "active", items: [], createdAt: 1, updatedAt: 1 },
        { id: "p2", name: "B", status: "active", items: [], createdAt: 1, updatedAt: 1 },
      ] as never,
    });

    let dialogSave: Promise<boolean> | undefined;
    ipc.askAnswer = "このまま上書きする"; // ok ボタンのラベル = 上書きを選ぶ
    ipc.onAsk = () => {
      // ガード処理の内側 = 再投入が積まれる直前に、別の保存を積む。
      dialogSave = projects.useProjects.getState().setPlanChat("p2", planMessages());
    };
    {
      let guardArmed = true;
      ipc.failWhen = () => {
        if (!guardArmed) return false;
        guardArmed = false;
        return true;
      };
      ipc.failMessage = "[DECREASE_GUARD existing=10 incoming=2]";

      // ガードに当たる保存 (p1)。
      const guarded = projects.useProjects.getState().setPlanChat("p1", planMessages());

      const guardedResult = await withTimeout(guarded);
      expect(dialogSave).toBeDefined();
      const dialogResult = await withTimeout(dialogSave as Promise<boolean>);

      // 永久待ちにしない。
      expect(guardedResult.kind).toBe("settled");
      expect(dialogResult.kind).toBe("settled");

      // 再投入で両方の会話が実際にディスクへ載っている (前提の確認)。
      const landed = ipc.writes.at(-1);
      expect(landed).toBeDefined();
      expect(landed?.planChatLens.filter((n) => n === 2).length).toBe(2);

      // 載っているのだから、どちらの待機者も true でなければならない。
      // (rev を引き継ぐ旧実装では dialogSave が false になる = 誤報)
      if (guardedResult.kind === "settled") expect(guardedResult.ok).toBe(true);
      if (dialogResult.kind === "settled") expect(dialogResult.ok).toBe(true);
    }
  });

  // ==========================================================================
  // g8t 4周目 (2026-08-04): 検証の正本を「実際に書いた文字列」にする (Sol 残存2件)。
  //
  // 3周目の verify は「対象プロジェクトが在り planChat が expected 件以上」しか
  // 見ていなかった。ここに 2 つの穴が残っていた:
  //
  //   (1) 別会話置換レース: 同じプロジェクトへ **別の会話** の後続保存が成功すると、
  //       スキップされた元会話の待機者にも true が返る (件数だけは満たされるため)。
  //       元会話はディスクに無いのに昇格が成功扱いになり、未保存台帳を消す = 消失。
  //   (2) 可変参照レース: verify に渡していたのが可変オブジェクト参照だったため、
  //       待機中の store 側の変更が判定を動かしうる (「ディスクに載ったのは変更前 /
  //       verify が見るのは変更後」がすり抜ける)。
  //
  // 対策は 1 つ: invoke へ渡した **JSON 文字列** を検証の正本にし、全メッセージを
  // id 単位で照合する。文字列はディスクへ載った瞬間に凍結されるので、
  // (2) はそもそも起こりえなくなる。
  // ==========================================================================

  it("T-g8t-14: 別会話置換レース — 別の会話が載っても、元会話の昇格は成功にならない", async () => {
    // 牙: verify を旧実装 (プロジェクト存在 + planChat.length >= expected) に戻すと
    // 落ちる。別会話も 2 件なので件数条件を満たしてしまい ok=true になる。
    const ipc = installIpcMock();
    const { planChat, projects, activeProject, unsaved } = await loadStores();

    activeProject.useActiveProject.getState().setActive(null);
    planChat.usePlanChat.setState({
      messages: planMessages(),
      unsavedChatId: "u_entry_1",
    });
    seedLedger(unsaved);

    // 1本目 (createProject の空スナップショット) を保留し、その間に
    // confirm / 会話保存 / **別会話での上書き** を積ませる。最後勝ちキューにより
    // 中間はスキップされ、ディスクに最後に載るのは「別会話 2 件」になる。
    let releaseFirst: (() => void) | undefined;
    ipc.holdWriteOnce = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const promoting = planChat.usePlanChat.getState().promoteToProject("置換される案件");

    // 保存が in-flight で止まっているあいだに、同じプロジェクトへ別会話を保存する。
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    const created = projects.useProjects.getState().projects[0];
    expect(created).toBeDefined();
    void projects.useProjects
      .getState()
      .setPlanChat(created.id, otherPlanMessages());

    releaseFirst?.();
    const result = await withTimeout(
      promoting.then((r) => r.ok) as Promise<boolean>,
    );
    expect(result.kind).toBe("settled"); // 永久待ちにしない

    const promoted = await promoting;

    // 前提: ディスクには「2 件入り」が載っている (件数条件は満たされている)。
    expect(ipc.writes.some((w) => w.planChatLens.includes(2))).toBe(true);
    // だが載ったのは **別会話** なので、元会話の昇格は成功にならない。
    expect(promoted).toEqual({ ok: false, reason: "save-failed" });
    // 台帳は残る = 元会話はどこにも消えていない (これが守りたい実体)。
    expect(
      unsaved.useUnsavedPlanChats.getState().items.find((i) => i.id === "u_entry_1"),
    ).toBeDefined();
    expect(planChat.usePlanChat.getState().unsavedChatId).toBe("u_entry_1");
  });

  it("T-g8t-15: 可変参照レース — メモリ上の書き換えは保存完了判定を動かさない", async () => {
    // 判定の正本が「実際にディスクへ書いた文字列」であることを直接示す。
    // 書き込みを保留しているあいだに、保存要求へ渡った **メモリ上のオブジェクト**
    // を書き換えても、既にシリアライズ済みの内容で判定されるので結果は変わらない。
    //
    // 牙: verify の引数をメモリ上の Project[] 参照へ戻すと、下の
    // 「書き換えても true のまま」が false になって落ちる (verify が変更後の
    // text を見てしまい、期待値と食い違うため)。
    const ipc = installIpcMock();
    const { projects } = await loadStores();

    projects.useProjects.setState({
      projects: [
        { id: "p1", name: "A", status: "active", items: [], createdAt: 1, updatedAt: 1 },
      ] as never,
    });

    // シリアライズは `await invoke` の **前** に済んでいる。したがって
    // holdWriteOnce (IPC ハンドラ内で待つ) が解ける前にミューテートすれば、
    // 「ディスクへ渡した文字列は変更前 / メモリは変更後」の状態を確実に作れる。
    let releaseFirst: (() => void) | undefined;
    ipc.holdWriteOnce = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const messages = planMessages();
    const saving = projects.useProjects.getState().setPlanChat("p1", messages);

    // 書き込みが保留 (= 既にシリアライズ済み) になるまで待つ。
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
    const live = projects.useProjects
      .getState()
      .projects.find((p) => p.id === "p1");
    expect(live?.planChat).toBeDefined();
    // 同一参照であること = このミューテーションが「verify が参照を見ていたら
    // 判定を動かせる」位置にあることの確認 (テストが的を外していない証拠)。
    expect(live?.planChat).toBe(messages);
    const mutatedTarget = (live?.planChat ?? [])[0];
    expect(mutatedTarget).toBeDefined();
    mutatedTarget.text = "あとから書き換えた本文";
    // Sol指摘 (2026-08-04): ここで push (件数を増やす) と、旧実装の件数判定でも
    // 条件を満たしてしまい、このテストが回帰を検出できない (実測で確認)。
    // **件数を減らす** ミューテーションにすることで、判定の正本がメモリなら
    // 「1 < 2」で false になり、書いた文字列を正本にしていれば true のまま——と
    // 両実装で結果が割れる。危険方向 (誤って true) ではないが、
    // 「メモリを見ていない」ことを回帰として固定できる。
    (live?.planChat ?? []).pop();
    expect(live?.planChat).toHaveLength(1);

    releaseFirst?.();
    const settled = await withTimeout(saving);
    expect(settled.kind).toBe("settled");

    // 実際にディスクへ載ったのは「書き換え前」の内容。
    const landed = ipc.writes.at(-1);
    expect(landed).toBeDefined();
    // 載ったのは pop 前の 2 件 (メモリ側の削除はシリアライズ後なので届かない)。
    expect(landed?.planChatLens).toContain(2);

    // 判定はその載った内容だけで決まるので、メモリ側の書き換えに影響されず true。
    if (settled.kind === "settled") expect(settled.ok).toBe(true);

  });

});
