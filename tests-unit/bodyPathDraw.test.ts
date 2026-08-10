/**
 * 体のフリーハンド描画 (移動の道を手で描く) のストア契約テスト。
 *
 * 検証するのは2点:
 *   1. 一筆書きの結果が「経路の丸ごと置き換え」になる (足し算ではない)。
 *      移動しないモーション (立ち・その場再生クリップ) では何も起きない
 *   2. カメラの一筆書きと体の一筆書きが同時に活性にならない (相互排他)。
 *      両方が同じレイを取り合うと、どちらの道を描いているのか分からなくなる
 *
 * 各テストは setup.ts の afterEach (vi.resetModules) で隔離されるため、
 * ストアは毎回**動的 import** して新品を掴む (zustand の state はモジュール変数)。
 */
import { describe, expect, it } from "vitest";

import type { Vec3 } from "../src/lib/scene3d/types";

type Scene3dStore = typeof import("../src/lib/store/scene3d");

async function loadStore(): Promise<Scene3dStore> {
  return (await import("../src/lib/store/scene3d")) as Scene3dStore;
}

/** 一筆書きの結果 (経由点2つ + 到着点)。 */
const WAYPOINTS: Vec3[] = [
  [1, 0, 1],
  [2.5, 0, 0.5],
  [4, 0, -1],
];

describe("setMotionPathFromStroke — 描いた道で経路を置き換える", () => {
  it("walk の被写体: 経路が丸ごと置き換わり、最終点が到着点になる", async () => {
    const { useScene3d } = await loadStore();
    const id = useScene3d.getState().project.entities[0].id;

    // 既定経路 (向いている方向へ2.5m) を持つ walk にする
    useScene3d.getState().setEntityMotion(id, "walk");
    const before = useScene3d.getState().project.entities.find((e) => e.id === id);
    expect(before?.motion?.type).toBe("walk");

    useScene3d.getState().setMotionPathFromStroke(id, WAYPOINTS);

    const after = useScene3d.getState().project.entities.find((e) => e.id === id);
    expect(after?.motion?.type).toBe("walk");
    const path = after?.motion && after.motion.type === "walk" ? after.motion.path : null;
    // 足し算ではなく置き換え: 描いた点だけになる
    expect(path).toEqual(WAYPOINTS);
    // 最後の点が到着点
    expect(path?.[path.length - 1]).toEqual([4, 0, -1]);
  });

  it("clip (speed>0) の被写体でも同様に置き換わる", async () => {
    const { useScene3d } = await loadStore();
    const id = useScene3d.getState().project.entities[0].id;

    // builtin-Walk_Loop は同梱標準ライブラリの移動系クリップ (speed 1.4)
    useScene3d.getState().setEntityMotionClip(id, "builtin-Walk_Loop");
    const before = useScene3d.getState().project.entities.find((e) => e.id === id);
    expect(before?.motion?.type).toBe("clip");
    expect(
      before?.motion && before.motion.type === "clip" ? (before.motion.speed ?? 0) : 0,
    ).toBeGreaterThan(0);

    useScene3d.getState().setMotionPathFromStroke(id, WAYPOINTS);

    const after = useScene3d.getState().project.entities.find((e) => e.id === id);
    const motion = after?.motion;
    expect(motion?.type).toBe("clip");
    expect(motion && motion.type === "clip" ? motion.path : null).toEqual(WAYPOINTS);
    // クリップ本体の情報は保たれる (経路だけを差し替える)
    expect(motion && motion.type === "clip" ? motion.clipId : null).toBe("builtin-Walk_Loop");
  });

  it("モーションなしの被写体では no-op (経路が生えない・落ちない)", async () => {
    const { useScene3d } = await loadStore();
    const id = useScene3d.getState().project.entities[0].id;

    useScene3d.getState().setEntityMotion(id, null);
    expect(useScene3d.getState().project.entities.find((e) => e.id === id)?.motion).toBeNull();

    useScene3d.getState().setMotionPathFromStroke(id, WAYPOINTS);

    // motion が生えていないこと (道だけが先に生まれる状態を作らない)
    expect(useScene3d.getState().project.entities.find((e) => e.id === id)?.motion).toBeNull();
  });
});

describe("描画モードの相互排他 — カメラと体を同時に描かせない", () => {
  it("setBodyDrawEntityId(id) でカメラの pathDrawMode が下りる", async () => {
    const { useScene3d } = await loadStore();
    useScene3d.getState().setPathDrawMode(true);
    expect(useScene3d.getState().pathDrawMode).toBe(true);

    useScene3d.getState().setBodyDrawEntityId("x");

    expect(useScene3d.getState().bodyDrawEntityId).toBe("x");
    expect(useScene3d.getState().pathDrawMode).toBe(false);
  });

  it("setPathDrawMode(true) で bodyDrawEntityId が null になる", async () => {
    const { useScene3d } = await loadStore();
    useScene3d.getState().setBodyDrawEntityId("x");
    expect(useScene3d.getState().bodyDrawEntityId).toBe("x");

    useScene3d.getState().setPathDrawMode(true);

    expect(useScene3d.getState().pathDrawMode).toBe(true);
    expect(useScene3d.getState().bodyDrawEntityId).toBeNull();
  });
});
