/**
 * D2 (2026-08-05): マルチアングル被写体参照の「外す」。
 *
 * 事故: 「登録キャラから選ぶ」「参照画像を選ぶ」で被写体をセットしたあと、
 * **被写体なしの状態に戻せなかった**。差し替えしかできず、空に戻すには
 * 右上の「新規開始」で環境文・比率・カット選択・生成結果まで全部捨てるしかない。
 *
 * 真因は UI 側だけにあった。ストアの setCharacterImage(null) は最初から
 * 実装済みで (multiAngleRun.ts)、**UI から呼ぶ導線が無かった**。
 *
 * ここで固定するのは 2 つ:
 *   1. setCharacterImage(null) が被写体だけを空にし、他の入力を巻き込まない
 *      (= 「外す」が「新規開始」に化けない。これが D2 の要求そのもの)
 *   2. 外したあと canRun が false に落ち、再セットで true に戻る
 *      (AngleSettingsPanel の活性判定と同じ式で評価する)
 */
import { beforeEach, describe, expect, it } from "vitest";

type MultiAngleModule = typeof import("../src/lib/store/multiAngleRun");

/**
 * AngleSettingsPanel の canRun と同じ式。
 * 実装を変えたらここも落ちるので、判定のズレに気づける。
 */
function canRun(s: {
  characterImagePath: string | null;
  selectedCutIds: string[];
  status: string;
}): boolean {
  return Boolean(s.characterImagePath) && s.selectedCutIds.length > 0 && s.status !== "running";
}

describe("multiAngle 被写体参照を外す (D2)", () => {
  let mod: MultiAngleModule;

  beforeEach(async () => {
    mod = await import("../src/lib/store/multiAngleRun");
  });

  it("T-D2-1: 外しても環境文・比率・カット選択を巻き込まない", async () => {
    const run = mod.useMultiAngleRun.getState();
    run.setCharacterImage("/tmp/chara.png");
    run.setEnvironment("夕暮れの教室");
    run.setAspectRatio("16:9");
    run.toggleCut("front");

    // 「外す」= 被写体だけ null に戻す。
    mod.useMultiAngleRun.getState().setCharacterImage(null);

    const after = mod.useMultiAngleRun.getState();
    expect(after.characterImagePath).toBeNull();
    // 巻き込まれていないこと (= 新規開始との差)。
    expect(after.environmentDescription).toBe("夕暮れの教室");
    expect(after.aspectRatio).toBe("16:9");
    expect(after.selectedCutIds).toEqual(["front"]);
  });

  it("T-D2-2: 外すと生成ボタンが落ち、再セットで戻る", async () => {
    const run = mod.useMultiAngleRun.getState();
    run.setCharacterImage("/tmp/chara.png");
    run.toggleCut("front");
    expect(canRun(mod.useMultiAngleRun.getState())).toBe(true);

    mod.useMultiAngleRun.getState().setCharacterImage(null);
    expect(canRun(mod.useMultiAngleRun.getState())).toBe(false);

    mod.useMultiAngleRun.getState().setCharacterImage("/tmp/other.png");
    expect(canRun(mod.useMultiAngleRun.getState())).toBe(true);
  });

  it("T-D2-3: 「新規開始」との差 — あちらは全入力を捨てる", async () => {
    const run = mod.useMultiAngleRun.getState();
    run.setCharacterImage("/tmp/chara.png");
    run.setEnvironment("夕暮れの教室");
    run.setAspectRatio("16:9");

    mod.useMultiAngleRun.getState().startNewRun();

    const after = mod.useMultiAngleRun.getState();
    expect(after.characterImagePath).toBeNull();
    // 外す(T-D2-1) と違い、こちらは環境文・比率まで初期化される。
    expect(after.environmentDescription).toBe("");
    expect(after.aspectRatio).toBe("1:1");
  });
});
