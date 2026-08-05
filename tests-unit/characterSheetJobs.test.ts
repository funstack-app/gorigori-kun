/**
 * SQ1 (bd 1wu / 2026-08-04): characterSheetRun のジョブ台帳化。
 *
 * 「キャラシートの生成が走っている間に、次のキャラの入力を始められる」を成立させるための
 * ロジック層を、UI を描画せずにストア単体で検査する。守りたい性質は 2 つ:
 *
 *   1. **イベントの逆引き** — 走行中の 2 本のジョブそれぞれのイベントが、
 *      互いを汚さずに正しいジョブへ届く。旧実装は「現在の runId と一致しないイベントは捨てる」
 *      だったので、2 本目を始めた瞬間に 1 本目の完了通知が落ちていた。
 *   2. **入力の凍結** — 確定後に下書きを書き換えても、走っているジョブの登録内容は変わらない。
 *      旧実装は登録時にストアの現在値を読んでいたため、「A のシートが B の名前で登録される」
 *      事故が構造的に成立していた。
 *
 * あわせて台帳の後始末 (中止・登録完了・再生成・モード切替) が、
 * **後着イベントの行き先を必ず消す**ことも検査する。ここが漏れると B1 混線が再発する。
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { CharacterSheetEvent } from "../src/lib/character/types";

type StoreModule = typeof import("../src/lib/store/characterSheetRun");

const CUT = { cutId: "character-sheet", label: "キャラクターシート", role: "character-sheet" };

function cutCompleted(runId: string, imagePath: string): CharacterSheetEvent {
  return { kind: "cutCompleted", runId, cutId: CUT.cutId, role: CUT.role, imagePath };
}

function cutStarted(runId: string): CharacterSheetEvent {
  return { kind: "cutStarted", runId, cutId: CUT.cutId, role: CUT.role, index: 0 };
}

function completed(runId: string): CharacterSheetEvent {
  return { kind: "completed", runId, outputDir: "/tmp" };
}

describe("キャラシート ジョブ台帳 (SQ1)", () => {
  let mod: StoreModule;

  beforeEach(async () => {
    mod = await import("../src/lib/store/characterSheetRun");
  });

  /** 生成状況パネル(右上)がその run に付けた行名。undefined なら種別名で出る。 */
  async function statusJobLabelOf(runId: string): Promise<string | undefined> {
    const status = await import("../src/lib/store/generationStatus");
    return status.useGenerationStatus.getState().jobs[runId]?.label;
  }

  /** 生成状況パネル(右上)がその run に持っている行そのもの (running / finished を見る)。 */
  async function statusJobOf(runId: string) {
    const status = await import("../src/lib/store/generationStatus");
    return status.useGenerationStatus.getState().jobs[runId];
  }

  /** 下書きに 1 キャラ分を入れて確定し、jobId を返す。 */
  function submitCharacter(name: string, image: string, runId: string): string {
    const run = mod.useCharacterSheetRun.getState();
    run.setCharacterName(name);
    run.setCharacterImages([image]);
    run.setAttributes(`${name} の属性`);
    return mod.useCharacterSheetRun.getState().beginRun("character", runId, [CUT]);
  }

  it("T-1: 走行中のジョブ A・B のイベントが両方それぞれのジョブへ届く", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const jobB = submitCharacter("ボブ", "/img/b.png", "run-b");
    expect(jobA).not.toBe(jobB);

    const apply = (e: CharacterSheetEvent) =>
      mod.useCharacterSheetRun.getState().applyEvent(e);

    // A と B のイベントを交互に流す (実機で並走したときの届き方)。
    apply(cutStarted("run-a"));
    apply(cutStarted("run-b"));
    apply(cutCompleted("run-b", "/out/b-sheet.png"));
    apply(completed("run-b"));
    apply(cutCompleted("run-a", "/out/a-sheet.png"));
    apply(completed("run-a"));

    const s = mod.useCharacterSheetRun.getState();
    // 両方が完了し、かつ**互いの画像を取り違えていない**こと。
    expect(s.jobs[jobA].status).toBe("completed");
    expect(s.jobs[jobB].status).toBe("completed");
    expect(s.jobs[jobA].cuts[CUT.cutId].imagePath).toBe("/out/a-sheet.png");
    expect(s.jobs[jobB].cuts[CUT.cutId].imagePath).toBe("/out/b-sheet.png");
    // 仕込み順は保たれる (レール表示の順序の正本)。
    expect(s.jobOrder).toEqual([jobA, jobB]);
  });

  it("T-2: 確定後に下書きを書き換えても、そのジョブの登録内容は変わらない", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");

    // A の生成中に、次のキャラ B を仕込み始める (下書きだけを書き換える)。
    const run = mod.useCharacterSheetRun.getState();
    run.setCharacterName("ボブ");
    run.setCharacterImages(["/img/b.png"]);
    run.setAttributes("ボブ の属性");
    run.setSheetBackground("green");

    const s = mod.useCharacterSheetRun.getState();
    // 凍結済みのジョブ A は A のまま。
    expect(s.jobs[jobA].input.characterName).toBe("アリス");
    expect(s.jobs[jobA].input.characterImagePaths).toEqual(["/img/a.png"]);
    expect(s.jobs[jobA].input.attributes).toBe("アリス の属性");
    expect(s.jobs[jobA].input.sheetBackground).toBe("auto");
    // 下書き側は新しい入力を保持している (仕込みは進められる)。
    expect(s.characterName).toBe("ボブ");
    expect(s.sheetBackground).toBe("green");
  });

  it("T-3: 凍結入力は下書き配列の後からの変更に引きずられない (参照の共有をしない)", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    // 下書きの参照画像を増やす。凍結側の配列が同じ参照だと、ここで一緒に伸びてしまう。
    mod.useCharacterSheetRun.getState().addCharacterImages(["/img/a2.png"]);

    expect(mod.useCharacterSheetRun.getState().jobs[jobA].input.characterImagePaths).toEqual([
      "/img/a.png",
    ]);
    expect(mod.useCharacterSheetRun.getState().characterImagePaths).toEqual([
      "/img/a.png",
      "/img/a2.png",
    ]);
  });

  it("T-4: 台帳に無い runId のイベントは捨てる (後着通知が他ジョブを汚さない)", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");

    // 存在しない run からの後着通知。
    mod.useCharacterSheetRun
      .getState()
      .applyEvent(cutCompleted("run-ghost", "/out/ghost.png"));

    const s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA].cuts[CUT.cutId].status).toBe("pending");
    expect(s.jobs[jobA].cuts[CUT.cutId].imagePath).toBeUndefined();
    expect(Object.keys(s.jobs)).toHaveLength(1);
  });

  it("T-5: dismissJob はジョブと逆引きを外し、以後その run のイベントを落とす", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const jobB = submitCharacter("ボブ", "/img/b.png", "run-b");

    mod.useCharacterSheetRun.getState().dismissJob(jobA);

    let s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA]).toBeUndefined();
    expect(s.jobOrder).toEqual([jobB]);
    expect(s.runIndex["run-a"]).toBeUndefined();
    // 外した後に届いた A のイベントは行き先が無いので何も起こさない。
    mod.useCharacterSheetRun.getState().applyEvent(cutCompleted("run-a", "/out/a.png"));
    s = mod.useCharacterSheetRun.getState();
    expect(Object.keys(s.jobs)).toEqual([jobB]);
    // B は無傷。
    expect(s.jobs[jobB].cuts[CUT.cutId].status).toBe("pending");
  });

  it("T-6: completeJob はジョブだけ外し、仕込み中の下書きを消さない", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    // A の生成中に C を仕込みかけている状態。
    const run = mod.useCharacterSheetRun.getState();
    run.setCharacterName("チャーリー");
    run.setCharacterImages(["/img/c.png"]);

    mod.useCharacterSheetRun.getState().completeJob(jobA);

    const s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA]).toBeUndefined();
    expect(s.focusedJobId).toBeNull();
    // 下書きは残る。これが「登録しても次のキャラの入力が消えない」の実体。
    expect(s.characterName).toBe("チャーリー");
    expect(s.characterImagePaths).toEqual(["/img/c.png"]);
  });

  it("T-7: replaceJobRun は jobId を保ったまま run を張り替え、旧 run の後着を落とす", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    mod.useCharacterSheetRun.getState().applyEvent(cutCompleted("run-a", "/out/old.png"));

    mod.useCharacterSheetRun.getState().replaceJobRun(jobA, "run-a2", [CUT]);

    let s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA].activeRunId).toBe("run-a2");
    expect(s.jobs[jobA].status).toBe("running");
    // 前回の結果は引き継がない (別 run の完了画像を新しい run の結果に見せない)。
    expect(s.jobs[jobA].cuts[CUT.cutId].status).toBe("pending");
    expect(s.runIndex["run-a"]).toBeUndefined();
    expect(s.runIndex["run-a2"]).toBe(jobA);
    // 入力は凍結されたまま (同一入力での作り直し)。
    expect(s.jobs[jobA].input.characterName).toBe("アリス");

    // 旧 run の後着イベントは新しい run の状態を汚さない。
    mod.useCharacterSheetRun.getState().applyEvent(cutCompleted("run-a", "/out/stale.png"));
    s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA].cuts[CUT.cutId].imagePath).toBeUndefined();
  });

  it("T-8: 上限判定に使う未決ジョブ数が仕込むたびに増える", () => {
    for (let i = 0; i < 3; i += 1) {
      submitCharacter(`キャラ${i}`, `/img/${i}.png`, `run-${i}`);
    }
    const s = mod.useCharacterSheetRun.getState();
    expect(mod.selectModeJobs(s)).toHaveLength(3);
    expect(mod.MAX_OUTSTANDING_SHEET_JOBS).toBe(10);
  });

  it("T-9: enterMode は他モードのジョブだけ外し、自モードのジョブは残す", () => {
    const jobChar = submitCharacter("アリス", "/img/a.png", "run-a");
    // 表情差分へ入る = キャラ登録のジョブは画面から外れる (生成自体は裏で続く)。
    mod.useCharacterSheetRun.getState().enterMode("expression");

    let s = mod.useCharacterSheetRun.getState();
    expect(s.mode).toBe("expression");
    expect(s.jobs[jobChar]).toBeUndefined();
    expect(s.runIndex["run-a"]).toBeUndefined();
    expect(s.step).toBe(1);

    // 表情差分のジョブを 1 本作り、同じ mode で再入場しても消えないこと。
    const jobExpr = mod.useCharacterSheetRun
      .getState()
      .beginRun("expression", "run-e", [CUT]);
    mod.useCharacterSheetRun.getState().enterMode("expression");
    s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobExpr]).toBeDefined();
    expect(s.runIndex["run-e"]).toBe(jobExpr);
  });

  it("T-10: reset は表示だけ戻し、走行中ジョブを台帳から消さない", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");

    mod.useCharacterSheetRun.getState().reset();

    const s = mod.useCharacterSheetRun.getState();
    expect(s.step).toBe(1);
    expect(s.focusedJobId).toBeNull();
    // 裏の生成は追跡し続ける (連携の持ち込み防止で画面を戻しただけ)。
    expect(s.jobs[jobA]).toBeDefined();
    expect(s.runIndex["run-a"]).toBe(jobA);
  });

  it("T-11: 1カットのキャラジョブは、そのカットが失敗したら failed になる", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    mod.useCharacterSheetRun.getState().applyEvent({
      kind: "cutFailed",
      runId: "run-a",
      cutId: CUT.cutId,
      reason: "codex exec failed",
    });
    mod.useCharacterSheetRun.getState().applyEvent(completed("run-a"));

    const s = mod.useCharacterSheetRun.getState();
    expect(s.jobs[jobA].status).toBe("failed");
    expect(s.jobs[jobA].cuts[CUT.cutId].reason).toBe("codex exec failed");
  });

  it("T-12: focus 中ジョブが無いとき、派生セレクタは走行中扱いにならない", () => {
    // 初期状態 = 何も仕込んでいない。ここが "running" だと生成ボタンが永久に死ぬ。
    expect(mod.getFocusedSheetJob().status).not.toBe("running");
    expect(mod.getFocusedSheetJob().cutOrder).toEqual([]);

    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    expect(mod.getFocusedSheetJob().jobId).toBe(jobA);
    expect(mod.getFocusedSheetJob().status).toBe("running");
  });

  /*
   * SQ2 (bd 1wu / 2026-08-04): ジョブレールが出す状態と、連続仕込みの下書き操作。
   * レールのカードは UI だが、「何と表示するか」の判断は store 側の純関数に置いたので
   * ここで React を描かずに検査できる。
   */

  it("T-13: 枠待ちのジョブは『生成中』でなく『順番待ち』になる", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const job = () => mod.useCharacterSheetRun.getState().jobs[jobA];

    // invoke 済みだが、まだカットが始まっていない = Rust のセマフォ待ち。
    // ここを「生成中」と出すと、動いていないものを動いていることにしてしまう。
    expect(job().status).toBe("running");
    expect(mod.sheetJobPhase(job())).toBe("waiting");

    // 実イベントが来て初めて「生成中」。
    mod.useCharacterSheetRun.getState().applyEvent(cutStarted("run-a"));
    expect(mod.sheetJobPhase(job())).toBe("running");

    mod.useCharacterSheetRun.getState().applyEvent(cutCompleted("run-a", "/out/a.png"));
    mod.useCharacterSheetRun.getState().applyEvent(completed("run-a"));
    // 完成したジョブはレールに「完成・登録待ち」で残る (これが成果の受け皿)。
    expect(mod.sheetJobPhase(job())).toBe("completed");
  });

  it("T-14: 失敗したジョブはレールに『失敗』として残る", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    mod.useCharacterSheetRun.getState().applyEvent({
      kind: "cutFailed",
      runId: "run-a",
      cutId: CUT.cutId,
      reason: "codex exec failed",
    });
    mod.useCharacterSheetRun.getState().applyEvent(completed("run-a"));

    const s = mod.useCharacterSheetRun.getState();
    expect(mod.sheetJobPhase(s.jobs[jobA])).toBe("failed");
    // 失敗しても台帳には残る (クリックして理由を読み、再生成 or 破棄を選べる)。
    expect(mod.selectModeJobs(s)).toHaveLength(1);
  });

  it("T-15: prepareNextCharacter はキャラ個別の下書きだけ消し、シート設定を残す", () => {
    const run = mod.useCharacterSheetRun.getState();
    run.setSheetPromptMode("custom");
    run.setCustomSheetPrompt("三面図でお願いします");
    run.setSheetBackground("green");
    run.setRegenerateTarget("preset-alice");
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");

    mod.useCharacterSheetRun.getState().prepareNextCharacter();

    const s = mod.useCharacterSheetRun.getState();
    // 前キャラの混入がそのまま誤登録になるフィールドは消える。
    expect(s.characterName).toBe("");
    expect(s.characterImagePaths).toEqual([]);
    expect(s.attributes).toBe("");
    expect(s.regenerateTargetPresetId).toBeNull();
    // シートの作り方・背景は残る (連続登録で毎回選び直させない)。
    expect(s.sheetPromptMode).toBe("custom");
    expect(s.customSheetPrompt).toBe("三面図でお願いします");
    expect(s.sheetBackground).toBe("green");
    // 入力画面へ戻り、走行中のジョブは台帳に残ったまま。
    expect(s.step).toBe(1);
    expect(s.focusedJobId).toBeNull();
    expect(s.jobs[jobA]).toBeDefined();
    expect(s.jobs[jobA].input.characterName).toBe("アリス");
  });

  it("T-16: 同一プリセットの作り直しが未決かどうかを、仕込む前に判定できる", () => {
    const run = mod.useCharacterSheetRun.getState();
    run.setRegenerateTarget("preset-alice");
    submitCharacter("アリス", "/img/a.png", "run-a");

    // StepInput の二重確定ガードが見るのと同じ導出。
    const outstanding = mod.selectModeJobs(mod.useCharacterSheetRun.getState());
    expect(
      outstanding.some((job) => job.input.regenerateTargetPresetId === "preset-alice"),
    ).toBe(true);
    expect(
      outstanding.some((job) => job.input.regenerateTargetPresetId === "preset-bob"),
    ).toBe(false);
  });

  /*
   * Sol 評価の blocking 修正 (2026-08-04)。ここから下は「直したことを、
   * 旧挙動へ戻せば必ず落ちる形」で固定するためのテスト。
   */

  it("T-18: 枠待ち (gen-phase queued) なら、cutStarted が来ていても『順番待ち』", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const job = () => mod.useCharacterSheetRun.getState().jobs[jobA];
    const run = () => mod.useCharacterSheetRun.getState();

    // Rust は生成枠を取る前に cutStarted を出す。これだけを見ていた頃は、
    // 枠が埋まっていても「生成中」と表示されていた。
    run().applyEvent(cutStarted("run-a"));
    run().noteSlotPhase("run-a", "queued");
    expect(mod.sheetJobPhase(job())).toBe("waiting");

    // 枠を取って動き出したら「生成中」。
    run().noteSlotPhase("run-a", "thinking");
    expect(mod.sheetJobPhase(job())).toBe("running");

    // 複数カットの run で 2 枚目が枠待ちに入っても、走行中の表示へ戻さない。
    run().noteSlotPhase("run-a", "queued");
    expect(mod.sheetJobPhase(job())).toBe("running");
  });

  it("T-19: gen-phase が来ない経路では、従来どおり cutStarted で『生成中』", () => {
    // Windows / codex exec フォールバックは gen-phase を出さない。
    // ここで waiting のまま固まると、動いているのに順番待ちという別の嘘になる。
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const job = () => mod.useCharacterSheetRun.getState().jobs[jobA];

    expect(mod.sheetJobPhase(job())).toBe("waiting");
    mod.useCharacterSheetRun.getState().applyEvent(cutStarted("run-a"));
    expect(mod.sheetJobPhase(job())).toBe("running");
  });

  it("T-20: 台帳に無い run のフェーズ通知は捨てる", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    // 他機能 (バッチ生成など) の gen-phase がキャラシートの状態を触らないこと。
    mod.useCharacterSheetRun.getState().noteSlotPhase("run-other", "queued");
    expect(mod.useCharacterSheetRun.getState().jobs[jobA].slotPhase).toBe("unknown");
  });

  it("T-21: 完了したジョブは、遅れて届いた started で走行中に戻らない", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const run = () => mod.useCharacterSheetRun.getState();

    run().applyEvent(cutCompleted("run-a", "/out/a.png"));
    run().applyEvent(completed("run-a"));
    expect(run().jobs[jobA].status).toBe("completed");

    // 完了直後に届いた started。runId は再生成で使い回すため逆引き表には残っている。
    run().applyEvent({ kind: "started", runId: "run-a", total: 1 });
    expect(run().jobs[jobA].status).toBe("completed");
    expect(mod.sheetJobPhase(run().jobs[jobA])).toBe("completed");
  });

  it("T-25: 完了したジョブは、遅れて届いた cutStarted でカット・右上表示とも走行中に戻らない", async () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const run = () => mod.useCharacterSheetRun.getState();

    run().applyEvent(cutCompleted("run-a", "/out/a.png"));
    run().applyEvent(completed("run-a"));
    expect(run().jobs[jobA].status).toBe("completed");
    expect(run().jobs[jobA].cuts[CUT.cutId].status).toBe("completed");

    // 決着後に遅れて届いた cutStarted。runId は再生成で使い回すため逆引き表に残る。
    // 塞がないとカットだけ running へ巻き戻り、cutCompleted はもう来ないので
    // 「完成・登録待ち」のカードが登録不能のまま固まる。
    // 右上の生成状況パネルも決着済み。遅着の前後でこの値が動かないことを見る。
    const statusBefore = await statusJobOf("run-a");
    expect(statusBefore?.finished).toBe(true);
    expect(statusBefore?.running).toBe(0);

    run().applyEvent(cutStarted("run-a"));
    expect(run().jobs[jobA].cuts[CUT.cutId].status).toBe("completed");
    expect(run().jobs[jobA].cuts[CUT.cutId].imagePath).toBe("/out/a.png");
    expect(run().jobs[jobA].status).toBe("completed");
    expect(mod.sheetJobPhase(run().jobs[jobA])).toBe("completed");

    // 右上カウンターが running 0→1 に巻き戻らないこと。
    // 決着判定が syncGenerationStatus より後ろにあると、カードは守れても
    // ここだけ `finished: true` のまま `running: 1` という矛盾状態になる
    // (Sol 評価 / 2026-08-04)。値が遅着の前後で不変であることまで見る。
    const statusAfter = await statusJobOf("run-a");
    expect(statusAfter?.finished).toBe(true);
    expect(statusAfter?.running).toBe(0);
    expect(statusAfter?.running).toBe(statusBefore?.running);
    expect(statusAfter?.completed).toBe(statusBefore?.completed);
  });

  it("T-25 牙: 決着判定を右上通知より後ろに置くと、遅着 cutStarted で running が巻き戻る", async () => {
    // 上の T-25 が「順序」を守っていることの証明。判定を syncGenerationStatus の
    // **後ろ**に置いた旧構造を再現し、同じ遅着イベントで右上が壊れることを示す。
    // これが落ちなくなったら T-25 は牙を失っている (順序以外の何かが守っている)。
    const status = await import("../src/lib/store/generationStatus");
    submitCharacter("アリス", "/img/a.png", "run-fang");
    const run = () => mod.useCharacterSheetRun.getState();

    run().applyEvent(cutCompleted("run-fang", "/out/a.png"));
    run().applyEvent(completed("run-fang"));
    expect(status.useGenerationStatus.getState().jobs["run-fang"]?.running).toBe(0);

    // 旧順序の再現: 決着済みかどうかを見ずに、先に右上へ橋渡しする。
    const job = run().jobs[run().runIndex["run-fang"]];
    status.syncCutRunStatus("characterSheet", job.cuts, job.cutOrder.length, cutStarted("run-fang"));

    const broken = status.useGenerationStatus.getState().jobs["run-fang"];
    expect(broken?.finished).toBe(true);
    expect(broken?.running).toBe(1); // ← 矛盾状態。現行の順序ならこうならない。
  });

  it("T-22: モード切替でも『完成・登録待ち』のジョブは残り、戻れば登録できる", () => {
    // 完成したキャラ A (登録待ち) と、まだ走っている B。
    const jobDone = submitCharacter("アリス", "/img/a.png", "run-a");
    const run = () => mod.useCharacterSheetRun.getState();
    run().applyEvent(cutCompleted("run-a", "/out/a.png"));
    run().applyEvent(completed("run-a"));
    const jobRunning = submitCharacter("ボブ", "/img/b.png", "run-b");

    // 表情差分へ移動する。
    run().enterMode("expression");

    let s = mod.useCharacterSheetRun.getState();
    // 完成カードは唯一の成果受け皿なので消さない (登録文脈ごと失われるため)。
    expect(s.jobs[jobDone]).toBeDefined();
    expect(s.jobs[jobDone].input.characterName).toBe("アリス");
    expect(s.jobs[jobDone].cuts[CUT.cutId].imagePath).toBe("/out/a.png");
    // 走行中のものは従来どおり進捗表示を終了する (裏では走り続ける)。
    expect(s.jobs[jobRunning]).toBeUndefined();
    expect(s.runIndex["run-b"]).toBeUndefined();
    // 他モードのジョブに focus は残さない (表情差分の画面が別スキルのジョブを映さない)。
    expect(s.focusedJobId).toBeNull();
    // 表情差分のレールには出ない。
    expect(mod.selectModeJobs(s)).toHaveLength(0);

    // キャラ登録へ戻ると、完成カードがそのまま登録待ちで見える。
    run().enterMode("character");
    s = mod.useCharacterSheetRun.getState();
    expect(mod.selectModeJobs(s).map((j) => j.jobId)).toEqual([jobDone]);
    expect(mod.sheetJobPhase(s.jobs[jobDone])).toBe("completed");
  });

  it("T-24: 登録に使う作り直し対象は凍結側から読め、下書きと独立している", () => {
    // A は「作り直しでない新規登録」として確定する。
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    expect(
      mod.useCharacterSheetRun.getState().jobs[jobA].input.regenerateTargetPresetId,
    ).toBeNull();

    // A の生成中に、次の下書きとして既存キャラ B の「シート作り直し」を開く。
    mod.useCharacterSheetRun.getState().setRegenerateTarget("preset-bob");

    // A の登録 = completeJob。下書きには触らないので B の作り直し対象は生き残る。
    // (旧実装はここで setRegenerateTarget(null) していたため、A の登録が B を壊した)
    mod.useCharacterSheetRun.getState().completeJob(jobA);

    const s = mod.useCharacterSheetRun.getState();
    expect(s.regenerateTargetPresetId).toBe("preset-bob");
    // 逆向きも成立: 下書きが B になっても、A の登録内容は A 確定時のまま。
    expect(s.jobs[jobA]).toBeUndefined();
  });

  it("T-23: 失敗ジョブはモード切替で消える (成果が無いので持ち越さない)", () => {
    const jobA = submitCharacter("アリス", "/img/a.png", "run-a");
    const run = () => mod.useCharacterSheetRun.getState();
    run().applyEvent({
      kind: "cutFailed",
      runId: "run-a",
      cutId: CUT.cutId,
      reason: "codex exec failed",
    });
    run().applyEvent(completed("run-a"));
    expect(run().jobs[jobA].status).toBe("failed");

    run().enterMode("expression");
    expect(mod.useCharacterSheetRun.getState().jobs[jobA]).toBeUndefined();
  });

  it("T-17: 生成状況パネルの行名に、凍結済みのキャラ名が入る", async () => {
    submitCharacter("アリス", "/img/a.png", "run-a");
    // 同じ種別の行が並ぶので、種別名だけだとどれがどのキャラか分からなくなる。
    expect(await statusJobLabelOf("run-a")).toBe("キャラクターシート: アリス");

    // 名前未入力は種別名のまま (「: (名前未入力)」より素の種別名のほうが読める)。
    const run = mod.useCharacterSheetRun.getState();
    run.setCharacterName("");
    run.setCharacterImages(["/img/b.png"]);
    mod.useCharacterSheetRun.getState().beginRun("character", "run-b", [CUT]);
    expect(await statusJobLabelOf("run-b")).toBeUndefined();
  });
});
