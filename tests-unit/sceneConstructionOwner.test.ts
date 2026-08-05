/**
 * Sol 評価 2周目 blocking#2 (2026-08-04): storyboard の生成入力に別スキルの構成が
 * 混ざる経路のロックテスト。
 *
 * 再現していた事故:
 *   1. storyboard で目標確定 (planChat と storyboard 専用控えの両方に構成が入る)
 *   2. 別スキル (漫画等) へ移動し、そこで planChat に別の構成ができる
 *   3. storyboard へ戻る。skillReset は storyboardDirty なら planChat を保護するので、
 *      **別スキルの構成を抱えた planChat が生き残る**
 *   4. 読み手が planChat を無条件優先 → 別スキルの構成で storyboard が生成される
 *
 * Sol の Node プローブはここで `mixingReproduced: true` を出していた。
 *
 * 修正は「書き手が出所を名乗る」(planChat.sceneConstructionOwner = 書いた時点の
 * activeSkillId)。読み手は storyboard 由来のときだけ共有ストアを優先し、
 * それ以外は storyboard 専用の控えへ落ちる。
 *
 * ここで固定したいのは 3 つ:
 *   - 混入しない (T-1)
 *   - 同一スキル内の作り直しは即時反映される = 過剰に塞いでいない (T-2)
 *   - planChat が消えていても専用控えで生成できる (blocking#3 の退行防止 / T-3)
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { SceneConstruction } from "../src/lib/storyboard/types";

type PlanChatModule = typeof import("../src/lib/store/planChat");
type StoryboardRunModule = typeof import("../src/lib/store/storyboardRun");
type SkillUiModeModule = typeof import("../src/lib/store/skillUiMode");
type SceneConstructionModule =
  typeof import("../src/lib/storyboard/useSceneConstruction");

type Stores = {
  planChat: PlanChatModule;
  storyboardRun: StoryboardRunModule;
  skillUiMode: SkillUiModeModule;
  sceneConstruction: SceneConstructionModule;
};

/** 出所を description に書いた最小の SceneConstruction。 */
function sceneFrom(tag: string): SceneConstruction {
  return { cuts: [{ id: "c1", description: tag }] } as unknown as SceneConstruction;
}

/** 解決結果がどのスキル由来かを取り出す。 */
function ownerOf(scene: SceneConstruction | null): string | null {
  return (scene?.cuts?.[0] as { description?: string } | undefined)?.description ?? null;
}

async function loadStores(): Promise<Stores> {
  const [planChat, storyboardRun, skillUiMode, sceneConstruction] = await Promise.all([
    import("../src/lib/store/planChat"),
    import("../src/lib/store/storyboardRun"),
    import("../src/lib/store/skillUiMode"),
    import("../src/lib/storyboard/useSceneConstruction"),
  ]);
  return { planChat, storyboardRun, skillUiMode, sceneConstruction };
}

describe("storyboard 生成入力の所有元", () => {
  let s: Stores;

  beforeEach(async () => {
    s = await loadStores();
  });

  it("T-1: 別スキルで作られた構成は storyboard の入力に採用されない", () => {
    // 1. storyboard で目標確定。GoalChatPanel と同じく専用控えへも写す。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("storyboard"));
    s.storyboardRun.useStoryboardRun
      .getState()
      .setSceneConstruction(sceneFrom("storyboard"));

    // 2. 別スキルへ移動し、そこで planChat に別の構成ができる。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-comic", "comic");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("other-skill"));

    // 3. storyboard へ戻る。planChat は保護されて other-skill の構成のまま残る。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    expect(ownerOf(s.planChat.usePlanChat.getState().sceneConstruction)).toBe(
      "other-skill",
    );
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBe("gori-comic");

    // 4. 読み手は出所を見るので、専用控え (storyboard 自身の構成) を選ぶ。
    expect(ownerOf(s.sceneConstruction.getSceneConstruction())).toBe("storyboard");
  });

  it("T-2: 同一スキル内で構成を作り直したら共有ストアが即時反映される", () => {
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.storyboardRun.useStoryboardRun
      .getState()
      .setSceneConstruction(sceneFrom("old-draft"));
    // storyboard にいるまま会話を続けて新しい構成が返ってきた状態。
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("new-draft"));

    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBe(
      "gori-storyboard",
    );
    expect(ownerOf(s.sceneConstruction.getSceneConstruction())).toBe("new-draft");
  });

  it("T-3: planChat が破棄されていても専用控えから読める (blocking#3 の退行防止)", () => {
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.storyboardRun.useStoryboardRun
      .getState()
      .setSceneConstruction(sceneFrom("storyboard"));
    // 別スキルへの出入りで共有ストアが resetThread される状況。
    s.planChat.usePlanChat.getState().setSceneConstruction(null);

    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBeNull();
    expect(ownerOf(s.sceneConstruction.getSceneConstruction())).toBe("storyboard");
  });

  it("T-5: 別スキルの構成だけが残っている storyboard 入場では planChat を保護しない", async () => {
    // Sol 3周目の残存: skillReset は「sceneConstruction があるか」だけを見ていたため、
    // 別スキルで作られた構成でも storyboard 入場時に保護されて共有ストアに居座っていた。
    // 保護判定も所有者を見るようにしたので、他人の構成しか無いならゼロスタートする。
    const { resetSkillScopedState } = await import("../src/lib/store/skillReset");

    // storyboard 側に作業痕跡は無い (dirty 保護が効かない状態を作る)。
    s.storyboardRun.useStoryboardRun.getState().resetPhases();

    // 別スキルで構成ができた状態。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-comic", "comic");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("other-skill"));
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBe("gori-comic");

    // storyboard へ入る。
    resetSkillScopedState("gori-storyboard");

    // 他人の構成は保護されず破棄される (FB#A7 のゼロスタート)。
    expect(s.planChat.usePlanChat.getState().sceneConstruction).toBeNull();
    expect(s.sceneConstruction.getSceneConstruction()).toBeNull();
  });

  it("T-8: storyboard に途中作業があっても、他スキル所有の planChat は保護しない", async () => {
    // Sol 4周目の残存: 保護条件が (所有者一致 || storyboardDirty) の **OR** だったため、
    // storyboard に途中作業があると他スキル所有・所有者なしの planChat まで生き残った。
    // 生成入力は読み手の所有者ゲートが弾くが、**会話履歴は GoalChatPanel がそのまま
    // 表示する**ので、storyboard に戻ると漫画の会話が出る (FB#A7 のゼロスタート破れ)。
    // 保護は所有者一致のみで判定するようにしたので、dirty でも破棄される。
    const { resetSkillScopedState } = await import("../src/lib/store/skillReset");
    const run = s.storyboardRun.useStoryboardRun.getState();

    // storyboard 側に作業痕跡を作る (旧 OR 条件なら storyboardDirty=true になる状態)。
    run.resetPhases();
    run.pushSketchVersion({
      versionId: "v1",
      createdAt: 1,
      fromGoalSummary: "storyboard の途中作業",
      cuts: [],
      directorNotes: "",
    });
    expect(
      s.storyboardRun.useStoryboardRun.getState().sketchVersions.length,
    ).toBeGreaterThan(0);

    // 別スキルで構成と会話ができた状態。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-comic", "comic");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("other-skill"));
    s.planChat.usePlanChat.setState({
      messages: [
        { id: "m1", role: "user", text: "漫画の会話", createdAt: 1 },
      ] as never,
    });

    // storyboard へ戻る。
    resetSkillScopedState("gori-storyboard");

    // 他人の構成も他人の会話も残らない。
    expect(s.planChat.usePlanChat.getState().sceneConstruction).toBeNull();
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBeNull();
    expect(s.planChat.usePlanChat.getState().messages).toHaveLength(0);

    // storyboard 自身の作業痕跡は消さない (保護対象が別物であることの確認)。
    expect(
      s.storyboardRun.useStoryboardRun.getState().sketchVersions.length,
    ).toBeGreaterThan(0);
  });

  it("T-9: 所有者なしの planChat も dirty で保護しない", async () => {
    // Sol のプローブが再現していたもう一方 (owner:null)。制作モードで企画チャットを
    // した状態から storyboard へ入る経路がこれにあたる。
    const { resetSkillScopedState } = await import("../src/lib/store/skillReset");
    const run = s.storyboardRun.useStoryboardRun.getState();

    run.resetPhases();
    run.pushSketchVersion({
      versionId: "v1",
      createdAt: 1,
      fromGoalSummary: "storyboard の途中作業",
      cuts: [],
      directorNotes: "",
    });

    // 所有者が付かない会話 (スキルに入っていない = activeSkillId が null)。
    s.skillUiMode.useSkillUiMode.getState().exitSkill();
    s.planChat.usePlanChat.setState({
      messages: [
        { id: "m1", role: "user", text: "制作モードの会話", createdAt: 1 },
      ] as never,
    });
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBeNull();

    resetSkillScopedState("gori-storyboard");

    expect(s.planChat.usePlanChat.getState().messages).toHaveLength(0);
  });

  it("T-6: 自分の構成が残っている storyboard 入場では従来どおり保護する", async () => {
    // T-5 の裏。所有者を見るようにしたことで、守るべきケースまで壊していないこと。
    const { resetSkillScopedState } = await import("../src/lib/store/skillReset");

    s.storyboardRun.useStoryboardRun.getState().resetPhases();
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("storyboard"));

    resetSkillScopedState("gori-storyboard");

    expect(ownerOf(s.planChat.usePlanChat.getState().sceneConstruction)).toBe(
      "storyboard",
    );
    expect(ownerOf(s.sceneConstruction.getSceneConstruction())).toBe("storyboard");
  });

  it("T-7: 目標確定の入力 (params + 構成) も別スキル由来なら組ごと採らない", () => {
    // GoalChatPanel が共有ストアを直読みしていた経路。params だけ他人のものを掴む
    // 食い違いが起きないよう、組で所有者判定する。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-comic", "comic");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("other-skill"));
    s.planChat.usePlanChat.getState().setStoryboardParams({
      duration_seconds: 10,
      aspect_ratio: "16:9",
      tempo: "normal",
    } as never);

    // 別スキル由来なので、確定ボタンの前提 (params && scene) が成立しない。
    const foreign = s.sceneConstruction.getStoryboardFinalizeInput();
    expect(foreign.params).toBeNull();
    expect(foreign.scene).toBeNull();

    // storyboard 自身が作ったものなら従来どおり両方読める。
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("storyboard"));
    const ours = s.sceneConstruction.getStoryboardFinalizeInput();
    expect(ownerOf(ours.scene)).toBe("storyboard");
    expect(ours.params).not.toBeNull();
  });

  it("T-4: 構成を捨てると出所も一緒に落ちる (前の持ち主が次の構成に付かない)", () => {
    s.skillUiMode.useSkillUiMode.getState().enterSkill("gori-storyboard", "storyboard");
    s.planChat.usePlanChat.getState().setSceneConstruction(sceneFrom("storyboard"));
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBe(
      "gori-storyboard",
    );

    s.planChat.usePlanChat.getState().resetThread();
    expect(s.planChat.usePlanChat.getState().sceneConstructionOwner).toBeNull();
  });
});
