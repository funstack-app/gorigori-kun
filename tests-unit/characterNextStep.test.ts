/**
 * H1 (2026-08-05): キャラ登録の完了 → 次工程への導線。
 *
 * 事故: キャラシートを登録した直後が**完全な行き止まり**だった。
 * 登録成功と同時に Step1 (入力画面) へ戻していたため、「登録できた」という
 * 手応えも「次に何ができるか」も画面から消えていた。アンケート自由記述の
 * 最頻出「キャラシートの使い道がわからない」(同型3件) の主因。
 *
 * ここで固定するのは 4 つ:
 *   1. 展開先が 4 つ (表情差分 / マルチアングル / スタンプ / 漫画) 揃っていること
 *      = 導線を消すとここが落ちる (牙)
 *   2. 各展開先が実在し、アプリ内で使えるスキルであること
 *   3. 押すと実際にそのスキルが開くこと (skillMode + 生成タブ)。新ストアは介さない
 *   4. 受け取り側 4 スキルが登録キャラを拾える前提 (presetKind === "character")
 *      が保たれていること = 送る側の改修だけで成立する根拠そのもの
 */
import { beforeEach, describe, expect, it } from "vitest";

type NextStepModule = typeof import("../src/lib/character/openSkillWithCharacter");
type CatalogModule = typeof import("../src/lib/skills/catalog");
type SkillModeModule = typeof import("../src/lib/store/skillMode");
type WorkspaceModule = typeof import("../src/lib/store/workspace");
type PresetsModule = typeof import("../src/lib/store/presets");

describe("キャラ登録の完了 → 次工程の導線 (H1)", () => {
  let nextStep: NextStepModule;
  let catalog: CatalogModule;

  beforeEach(async () => {
    nextStep = await import("../src/lib/character/openSkillWithCharacter");
    catalog = await import("../src/lib/skills/catalog");
  });

  it("T-H1-1: 展開先が4つ揃っている (牙: 導線を消すと落ちる)", () => {
    // 件数を数える。導線を1つでも削るとここで落ちる。
    expect(nextStep.CHARACTER_NEXT_STEP_SKILL_IDS).toHaveLength(4);
    // 中身も固定する。別スキルに差し替わっても気づけるようにする。
    expect([...nextStep.CHARACTER_NEXT_STEP_SKILL_IDS]).toEqual([
      "gori-expression-set",
      "gori-multi-angle",
      "gori-sticker",
      "gori-comic",
    ]);
  });

  it("T-H1-2: 展開先はすべて実在し、アプリ内で使えるスキル", () => {
    for (const id of nextStep.CHARACTER_NEXT_STEP_SKILL_IDS) {
      const skill = catalog.GORI_SKILLS.find((s) => s.id === id);
      // catalog から消えたスキルを案内していないこと (押しても開けない導線を作らない)。
      expect(skill, `${id} が catalog に無い`).toBeDefined();
      // 「後続接続」状態のスキルへ案内しないこと。
      expect(skill?.availableInApp, `${id} がアプリ内で使えない`).toBe(true);
      // ボタンラベルに使う name が空でないこと。
      expect(skill?.name?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("T-H1-3: 押すとそのスキルが開く (生成タブ + skillMode 切替)", async () => {
    const skillMode: SkillModeModule = await import("../src/lib/store/skillMode");
    const workspace: WorkspaceModule = await import("../src/lib/store/workspace");

    // 別スキル・別タブにいる状態から始める (切替が実際に起きたと言えるように)。
    workspace.useWorkspace.getState().setActiveTab("plan");
    skillMode.useSkillMode.getState().setSelectedSkillId("gori-character-register");

    nextStep.openSkillWithCharacter("gori-sticker", "テスト太郎");

    expect(skillMode.useSkillMode.getState().selectedSkillId).toBe("gori-sticker");
    expect(skillMode.useSkillMode.getState().enabled).toBe(true);
    // 受け取り側の画面は生成タブに描かれるので、ここが plan のままだと
    // 「切り替えたのに何も見えない」になる。
    expect(workspace.useWorkspace.getState().activeTab).toBe("generate");
  });

  it("T-H1-4: 4つとも実際に開ける (1つだけ通って残りが死んでいないこと)", async () => {
    const skillMode: SkillModeModule = await import("../src/lib/store/skillMode");

    for (const id of nextStep.CHARACTER_NEXT_STEP_SKILL_IDS) {
      nextStep.openSkillWithCharacter(id);
      expect(skillMode.useSkillMode.getState().selectedSkillId).toBe(id);
    }
  });

  it("T-H1-5: 受け取り側は登録キャラを presets から拾える (送る側だけで成立する根拠)", async () => {
    const presets: PresetsModule = await import("../src/lib/store/presets");

    // 登録された形 (registerCharacter が addPreset に渡す kind) を再現する。
    presets.usePresets.getState().addPreset({
      name: "テスト太郎",
      prompt: "",
      kind: "character",
      characterMeta: { attributes: "黒髪 / 制服" },
      categoryId: presets.CHARACTER_CATEGORY_ID,
    });

    // 受け取り側 4 スキルはどれもこの式で絞っている
    // (ExpressionSetWorkspace:179 / StickerWorkspace:129 / ComicWorkspace:193 /
    //  CharacterPresetPickerModal:37)。ここが壊れると 4 スキルが同時に拾えなくなる。
    const characters = presets.usePresets
      .getState()
      .presets.filter((p) => presets.presetKind(p) === "character");

    expect(characters.some((p) => p.name === "テスト太郎")).toBe(true);
  });
});
