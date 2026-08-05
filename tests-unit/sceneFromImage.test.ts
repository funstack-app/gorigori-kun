/**
 * Slice D (共通ブリッジ + シーン反映) の機械検証。
 *
 * r3 追補5「品質ゲートの数値化」に従い、**生成を伴わない fixture** だけで
 * 次の4点を先に固める (実生成の品質確認は STΛCK 承認後に別途):
 *   1. 初期未編集シーンなら置換 / 編集済みなら追記 (既存エンティティを消さない)
 *   2. 連打・別入口同時でも run は1件 (同期 CAS ロック)
 *   3. ポーズ両段失敗時は T字 clip が**明示的に**登録される (motion 無しにしない)
 *   4. 検証で捨てた/降格した件数が結果に載る (黙って捨てない)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneLayoutDraft } from "../src/lib/scene3d/layoutAnalysis";

function draftOf(over: Partial<SceneLayoutDraft> = {}): SceneLayoutDraft {
  return {
    person: { floorX: 0.5, floorZ: -1, rotationYDeg: 90 },
    objects: [
      {
        kind: "table",
        label: "机",
        floorX: 1.2,
        floorZ: -0.5,
        rotationYDeg: 30,
        width: 1.4,
        height: 0.8,
        depth: 0.7,
      },
    ],
    camera: { azimuthDeg: 15, distanceM: 4, heightM: 1.5, lensMm: 35 },
    dropped: 0,
    demoted: 0,
    ...over,
  };
}

describe("applyImageScene — 置換 / 追記の分岐", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("初期未編集シーン (既定 actor-1 のみ・motion 無し) では置換する", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    // 既定プロジェクトのまま
    expect(useScene3d.getState().project.entities).toHaveLength(1);

    const res = useScene3d.getState().applyImageScene(draftOf(), "gen-test-1");

    expect(res.mode).toBe("replace");
    const { entities, cameras, shots } = useScene3d.getState().project;
    // 既定の actor-1 は消え、解析結果の人物 + 小物だけになる
    expect(entities.map((e) => e.id)).not.toContain("actor-1");
    expect(entities).toHaveLength(2);
    expect(cameras).toHaveLength(1);
    expect(shots).toHaveLength(1);
  });

  it("編集済みシーンでは追記し、既存エンティティを消さない", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    // ユーザーが手を入れた状態を作る (箱を1つ足す = 既定シーンではなくなる)
    useScene3d.getState().addEntity("box");
    const before = useScene3d.getState().project;
    const beforeIds = before.entities.map((e) => e.id);
    expect(beforeIds).toContain("actor-1");

    const res = useScene3d.getState().applyImageScene(draftOf(), "gen-test-2");

    expect(res.mode).toBe("append");
    const after = useScene3d.getState().project;
    // 既存 ID が全部残っている
    for (const id of beforeIds) expect(after.entities.map((e) => e.id)).toContain(id);
    expect(after.entities).toHaveLength(beforeIds.length + 2);
    expect(after.cameras).toHaveLength(before.cameras.length + 1);
    expect(after.shots).toHaveLength(before.shots.length + 1);
  });

  it("人物には静的ポーズ clip (speed/path 無し) が付き、小物は床接地で置かれる", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    const res = useScene3d.getState().applyImageScene(draftOf(), "gen-test-3");

    const person = useScene3d
      .getState()
      .project.entities.find((e) => e.id === res.personEntityId);
    expect(person?.kind).toBe("mannequin");
    expect(person?.motion).toEqual({ type: "clip", clipId: "gen-test-3" });
    // 位置は解析結果どおり・床に接地 (y=0)
    expect(person?.position).toEqual([0.5, 0, -1]);
    expect(person?.rotationY).toBeCloseTo(Math.PI / 2, 6);

    const table = useScene3d.getState().project.entities.find((e) => e.kind === "table");
    expect(table?.position).toEqual([1.2, 0, -0.5]);
    expect(table?.params).toEqual({ width: 1.4, height: 0.8, depth: 0.7 });

    // カメラは解析した画角の fixed カメラで、人物を追う
    const cam = useScene3d.getState().project.cameras.find((c) => c.id === res.cameraId);
    expect(cam?.move.preset).toBe("fixed");
    expect(cam?.move.lensMm).toBe(35);
    expect(cam?.move.targetEntityId).toBe(res.personEntityId);
    // azimuth 15° / 距離 4m / 高さ 1.5m の極座標変換
    expect(cam?.move.startPos[1]).toBe(1.5);
    expect(cam?.move.startPos[2]).toBeCloseTo(Math.cos((15 * Math.PI) / 180) * 4, 6);
  });

  /**
   * Sol 評価 blocking B-3: 「初期状態」の判定が甘いと、ユーザーが回転・カメラ・
   * ショットを編集した後でも既定シーンと誤認して**置換が走り編集を消す**。
   * 判定を既定シーンとの深い等価に変えたので、下の3ケースは全て追記になる。
   */
  it("回転・カメラ・ショットのどれか1つでも編集済みなら置換しない (追記に倒す)", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");

    const cases: { name: string; edit: () => void }[] = [
      {
        name: "人物を回転しただけ",
        edit: () => useScene3d.getState().rotateEntity("actor-1", Math.PI / 4),
      },
      {
        name: "人物を拡大しただけ",
        edit: () => useScene3d.getState().scaleEntityBy("actor-1", 0.5),
      },
      {
        name: "カメラのレンズを変えただけ",
        edit: () => useScene3d.getState().setLens(85),
      },
      {
        name: "ショットの尺を変えただけ",
        edit: () => useScene3d.getState().setShotDurationFrames("shot-1", 90),
      },
    ];

    for (const c of cases) {
      // 各ケースを既定シーンから始める
      useScene3d.getState().resetProject();
      expect(useScene3d.getState().project.entities.map((e) => e.id)).toEqual(["actor-1"]);

      c.edit();
      const before = useScene3d.getState().project;

      const res = useScene3d.getState().applyImageScene(draftOf(), `gen-b3-${c.name}`);

      expect(res.mode, `${c.name}: 置換が走ってはいけない`).toBe("append");
      const after = useScene3d.getState().project;
      // 編集した actor-1 が生き残っている (= ユーザーの手が消えていない)
      expect(after.entities.map((e) => e.id), c.name).toContain("actor-1");
      expect(after.cameras.length, c.name).toBe(before.cameras.length + 1);
      expect(after.shots.length, c.name).toBe(before.shots.length + 1);
    }
  });

  it("画面比率だけ変えた場合も置換しない", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    useScene3d.getState().resetProject();
    useScene3d.getState().setAspectRatio("9:16");

    const res = useScene3d.getState().applyImageScene(draftOf(), "gen-b3-aspect");

    expect(res.mode).toBe("append");
    expect(useScene3d.getState().project.entities.map((e) => e.id)).toContain("actor-1");
  });

  it("既定のままリセット直後は従来どおり置換する (追記に倒しすぎない)", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    useScene3d.getState().resetProject();

    const res = useScene3d.getState().applyImageScene(draftOf(), "gen-b3-pristine");

    expect(res.mode).toBe("replace");
    expect(useScene3d.getState().project.entities.map((e) => e.id)).not.toContain("actor-1");
  });

  it("固定ジオメトリの小物は uniform scale で寸法が実表示へ届く (r3 追補4)", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    const { parseSceneLayout } = await import("../src/lib/scene3d/layoutAnalysis");
    useScene3d.getState().resetProject();

    // 基準 [1.4, 0.77, 0.8] の table を 2 倍相当の寸法で要求する。
    const draft = parseSceneLayout(
      JSON.stringify({
        person: { floorX: 0, floorZ: 0, rotationYDeg: 0 },
        objects: [
          { kind: "table", label: "大きい机", floorX: 0, floorZ: 0, width: 2.8, height: 1.54, depth: 1.6 },
        ],
      }),
    )!;
    expect(draft.objects[0].scale).toBeCloseTo(2, 6);

    useScene3d.getState().applyImageScene(draft, null);
    const table = useScene3d.getState().project.entities.find((e) => e.kind === "table");
    // Scene3dViewport は table の params を読まない (固定ジオメトリ)。
    // scale が entity に載っていないと寸法は表示に一切反映されない。
    expect(table?.scale).toBeCloseTo(2, 6);
  });

  it("入力画像のアスペクトをカメラ枠の比率へ反映する (r3 追補)", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    useScene3d.getState().resetProject();
    expect(useScene3d.getState().project.aspectRatio).toBe("16:9");

    // 縦長画像 (1080x1920 = 0.5625) → 9:16 へ丸める
    useScene3d.getState().applyImageScene(draftOf(), null, 1080 / 1920);
    expect(useScene3d.getState().project.aspectRatio).toBe("9:16");

    // 測れなかった場合 (null) は既存の比率を維持する (推測で埋めない)
    useScene3d.getState().applyImageScene(draftOf(), null, null);
    expect(useScene3d.getState().project.aspectRatio).toBe("9:16");
  });

  it("人物が居なければマネキンを置かず、カメラは固定注視点を見る", async () => {
    const { useScene3d } = await import("../src/lib/store/scene3d");
    const res = useScene3d.getState().applyImageScene(draftOf({ person: null }), null);

    expect(res.personEntityId).toBeNull();
    expect(
      useScene3d.getState().project.entities.filter((e) => e.kind === "mannequin"),
    ).toHaveLength(0);
    const cam = useScene3d.getState().project.cameras.find((c) => c.id === res.cameraId);
    expect(cam?.move.targetEntityId).toBeNull();
    expect(cam?.move.lookAtPos).toEqual([0, 1, 0]);
  });
});

describe("buildTPoseSpec — 検出失敗時のフォールバック (r3 追補3)", () => {
  it("Mixamo 全主要ボーンを差分ゼロ (= T字) で持つ静止 spec を作る", async () => {
    const { buildTPoseSpec } = await import("../src/lib/store/sceneFromImage");
    const { MIXAMO_BONES } = await import("../src/lib/scene3d/motionGen");

    const spec = buildTPoseSpec("ポーズ(未検出・T字)");
    expect(spec.rig).toBe("mixamo");
    expect(spec.loop).toBe(false);
    expect(spec.moveSpeed).toBe(0);
    // 2フレーム同一 = 静止。1フレームだと再生側が扱えない
    expect(spec.keyframes).toHaveLength(2);
    // 「bones が空」ではなく主要ボーンを明示的に 0 で置く (前のポーズが残らない)
    for (const bone of MIXAMO_BONES) {
      expect(spec.keyframes[0].bones[bone]).toEqual([0, 0, 0]);
    }
  });
});

describe("useSceneFromImage.run — 同時1ジョブ (r3 追補2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("連打しても run は1件だけ通り、2本目以降は即座に落ちる", async () => {
    // ① ブロックアウト生成を「解決しない Promise」にして run を進行中で止める
    let releaseGeneration: (() => void) | null = null;
    const generateBatch = vi.fn(
      () =>
        new Promise<{ generatedPaths: string[] }>((resolve) => {
          releaseGeneration = () => resolve({ generatedPaths: [] });
        }),
    );
    // 解析結果は「人物1人」の最小有効 JSON。`{}` は B-5 以降 null (=ジョブ失敗)
    // になるため、ここでは成功経路まで到達させるために有効な値を返す。
    vi.doMock("../src/lib/ipc", () => ({
      images: { generateBatch },
      codexVision: {
        analyzeSceneLayout: vi.fn(async () =>
          JSON.stringify({ person: { floorX: 0, floorZ: 0, rotationYDeg: 0 }, objects: [] }),
        ),
      },
    }));
    vi.doMock("../src/lib/scene3d/imageToPose", () => ({
      capturePoseFromImage: vi.fn(async () => null),
      registerPoseClip: vi.fn(async () => ({ id: "gen-x", name: "x" })),
    }));

    const { useSceneFromImage } = await import("../src/lib/store/sceneFromImage");

    // 10連打
    const runs = Array.from({ length: 10 }, () =>
      useSceneFromImage.getState().run("/tmp/a.png"),
    );

    // ロックを取れた1本だけがブロックアウト生成へ進んでいる
    expect(generateBatch).toHaveBeenCalledTimes(1);
    expect(useSceneFromImage.getState().job).not.toBeNull();

    releaseGeneration?.();
    await Promise.all(runs);

    // 反映まで到達し、run は解放される
    expect(generateBatch).toHaveBeenCalledTimes(1);
    expect(useSceneFromImage.getState().job).toBeNull();

    // 解放後は次の run が通る (ロックが残らない = try/finally が効いている)
    await useSceneFromImage.getState().run("/tmp/b.png", { skipBlockout: true });
    expect(useSceneFromImage.getState().job).toBeNull();
    expect(useSceneFromImage.getState().result?.ok).toBe(true);
  });

  /**
   * Sol 評価 blocking B-2: Slice A (スケッチ単独のブロックアウト生成) と
   * Slice D (3Dシーン化) が別々のロックだと、両方が同時に走って生成が2本になる。
   * 共通の排他ジョブロックを通しているので、A 実行中は D が弾かれる。
   */
  it("Slice A のブロックアウト生成中は Slice D の3Dシーン化が弾かれる", async () => {
    const generateBatch = vi.fn(async () => ({ generatedPaths: ["/tmp/blockout.png"] }));
    vi.doMock("../src/lib/ipc", () => ({
      images: { generateBatch },
      codexVision: { analyzeSceneLayout: vi.fn() },
    }));
    vi.doMock("../src/lib/scene3d/imageToPose", () => ({
      capturePoseFromImage: vi.fn(async () => null),
      registerPoseClip: vi.fn(async () => ({ id: "gen-x", name: "x" })),
    }));

    const { useSceneFromImage, tryBeginExclusiveJob, endExclusiveJob, activeExclusiveJobKind } =
      await import("../src/lib/store/sceneFromImage");

    // Slice A (SketchPadModal の onGenerateBlockout) がロックを取った状態を作る。
    const sketchRunId = tryBeginExclusiveJob("sketch-blockout");
    expect(sketchRunId).not.toBeNull();
    expect(activeExclusiveJobKind()).toBe("sketch-blockout");

    // その最中に Slice D を起こしても、ジョブは始まらず生成も走らない。
    await useSceneFromImage.getState().run("/tmp/d.png");
    expect(useSceneFromImage.getState().job).toBeNull();
    expect(generateBatch).not.toHaveBeenCalled();

    // 逆向き: D が走っている間は A がロックを取れない。
    endExclusiveJob(sketchRunId!);
    const dRunId = tryBeginExclusiveJob("scene-from-image");
    expect(dRunId).not.toBeNull();
    expect(tryBeginExclusiveJob("sketch-blockout")).toBeNull();

    // 解放後は A が取れる (try/finally でロックが残らない)。
    endExclusiveJob(dRunId!);
    const again = tryBeginExclusiveJob("sketch-blockout");
    expect(again).not.toBeNull();
    endExclusiveJob(again!);
    expect(activeExclusiveJobKind()).toBeNull();
  });

  it("捨てた件数・降格件数を結果に載せる (黙って捨てない)", async () => {
    vi.doMock("../src/lib/ipc", () => ({
      images: { generateBatch: vi.fn() },
      codexVision: {
        analyzeSceneLayout: vi.fn(async () =>
          JSON.stringify({
            person: null,
            // kind 不明 = box へ降格 / kind 欠落 = 破棄
            objects: [{ kind: "spaceship", floorX: 1 }, { label: "謎" }],
            camera: { azimuthDeg: 0, distanceM: 4, heightM: 1.5, lensMm: 35 },
          }),
        ),
      },
    }));
    vi.doMock("../src/lib/scene3d/imageToPose", () => ({
      capturePoseFromImage: vi.fn(async () => null),
      registerPoseClip: vi.fn(async () => ({ id: "gen-x", name: "x" })),
    }));

    const { useSceneFromImage } = await import("../src/lib/store/sceneFromImage");
    await useSceneFromImage.getState().run("/tmp/c.png", { skipBlockout: true });

    const result = useSceneFromImage.getState().result;
    expect(result?.ok).toBe(true);
    expect(result?.demoted).toBe(1);
    expect(result?.dropped).toBe(1);
  });
});
