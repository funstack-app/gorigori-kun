/**
 * 画像→3Dシーン再構成のレイアウト JSON バリデータ (決定論) の単体テスト。
 *
 * codex vision の出力は未信頼入力なので、正常系だけでなく
 * (a) kind 不正 (b) 数値逸脱 (c) 壊れ JSON の3系統で「推測で埋めない・黙って捨てない」を検証する。
 */
import { describe, expect, it } from "vitest";

import { parseSceneLayout } from "../src/lib/scene3d/layoutAnalysis";

describe("parseSceneLayout — 正常系", () => {
  it("設計書どおりの JSON を検証済み草案へ変換する", () => {
    const raw = JSON.stringify({
      person: { floorX: 0.5, floorZ: -1.2, rotationYDeg: 45 },
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
    });

    const draft = parseSceneLayout(raw);
    expect(draft).not.toBeNull();
    expect(draft!.person).toEqual({ floorX: 0.5, floorZ: -1.2, rotationYDeg: 45 });
    expect(draft!.objects).toHaveLength(1);
    expect(draft!.objects[0]).toEqual({
      kind: "table",
      label: "机",
      floorX: 1.2,
      floorZ: -0.5,
      rotationYDeg: 30,
      width: 1.4,
      height: 0.8,
      depth: 0.7,
      // r3 追補4: table は固定ジオメトリなので寸法は uniform scale で表示へ届く。
      // 基準 [1.4, 0.77, 0.8] に対する比は [1.0, 1.038…, 0.875] で、中央値は 1.0。
      scale: 1,
    });
    expect(draft!.camera).toEqual({ azimuthDeg: 15, distanceM: 4, heightM: 1.5, lensMm: 35 });
    expect(draft!.dropped).toBe(0);
    expect(draft!.demoted).toBe(0);
  });

  it("コードフェンス・前置き・後置き付きでも本体を取り出す", () => {
    const raw = [
      "解析しました。以下が結果です。",
      "```json",
      '{"person": {"floorX": 0, "floorZ": 0, "rotationYDeg": 0}, "objects": [],' +
        ' "camera": {"azimuthDeg": 0, "distanceM": 3, "heightM": 1.6, "lensMm": 50}}',
      "```",
      "以上です。",
    ].join("\n");

    const draft = parseSceneLayout(raw);
    expect(draft).not.toBeNull();
    expect(draft!.person).not.toBeNull();
    expect(draft!.camera.lensMm).toBe(50);
  });

  it("person が無い画像 (物だけ) でも objects とカメラは活きる", () => {
    const raw = '{"objects":[{"kind":"tree","label":"木","floorX":2,"floorZ":3}]}';
    const draft = parseSceneLayout(raw);
    expect(draft!.person).toBeNull();
    expect(draft!.objects[0].kind).toBe("tree");
    // 寸法欠落は既定 1m で置く (エントリごと捨てはしない)。
    expect(draft!.objects[0].width).toBe(1);
    // camera 欠落は既定値。配置だけでも使えるようにする。
    expect(draft!.camera).toEqual({ azimuthDeg: 0, distanceM: 4, heightM: 1.5, lensMm: 35 });
  });
});

describe("parseSceneLayout — kind 不正", () => {
  it("ホワイトリスト外の kind は box に降格し demoted で数える", () => {
    const raw = JSON.stringify({
      objects: [
        { kind: "spaceship", label: "宇宙船", floorX: 0, floorZ: 0 },
        { kind: "BOX", label: "箱", floorX: 1, floorZ: 1 },
        { kind: "chair", label: "椅子", floorX: 2, floorZ: 2 },
      ],
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.objects.map((o) => o.kind)).toEqual(["box", "box", "chair"]);
    // 大文字違いは降格ではなく正規化 (フォーマット揺れの吸収)。降格は spaceship の1件だけ。
    expect(draft.demoted).toBe(1);
    expect(draft.dropped).toBe(0);
    // label は保持する (「宇宙船」だったことが UI に残る)。
    expect(draft.objects[0].label).toBe("宇宙船");
  });

  it("kind 欠落・非オブジェクトのエントリは破棄して dropped で数える", () => {
    const raw = JSON.stringify({
      objects: [
        { label: "謎", floorX: 0, floorZ: 0 },
        "文字列",
        null,
        { kind: "sofa", label: "ソファ", floorX: 1, floorZ: 0 },
      ],
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].kind).toBe("sofa");
    expect(draft.dropped).toBe(3);
  });

  it("objects が 12 件を超えたら超過分を破棄して dropped で数える", () => {
    const objects = Array.from({ length: 15 }, (_, i) => ({
      kind: "box",
      label: `箱${i}`,
      floorX: 0,
      floorZ: 0,
    }));
    const draft = parseSceneLayout(JSON.stringify({ objects }))!;
    expect(draft.objects).toHaveLength(12);
    expect(draft.dropped).toBe(3);
  });

  it("kind に非文字列が来ても落ちずに破棄する", () => {
    // person を残すのは「全部空なら null」(B-5) に巻き込まれず、
    // kind 破棄そのものを検証するため。
    const draft = parseSceneLayout(
      '{"person":{"floorX":0,"floorZ":0,"rotationYDeg":0},' +
        '"objects":[{"kind":42,"floorX":0,"floorZ":0}]}',
    )!;
    expect(draft.objects).toHaveLength(0);
    expect(draft.dropped).toBe(1);
  });
});

describe("parseSceneLayout — プリミティブ寸法 (r3 追補4)", () => {
  const objOf = (over: Record<string, unknown>) =>
    parseSceneLayout(
      JSON.stringify({
        person: { floorX: 0, floorZ: 0, rotationYDeg: 0 },
        objects: [{ floorX: 0, floorZ: 0, ...over }],
      }),
    )!.objects[0];

  it("固定ジオメトリの kind は基準寸法比から uniform scale を出す", () => {
    // table の基準は [1.4, 0.77, 0.8]。ちょうど2倍の寸法なら scale=2。
    expect(objOf({ kind: "table", width: 2.8, height: 1.54, depth: 1.6 }).scale).toBeCloseTo(2, 6);
    // car の基準は [1.8, 1.2, 4.2]。等倍なら scale=1。
    expect(objOf({ kind: "car", width: 1.8, height: 1.2, depth: 4.2 }).scale).toBeCloseTo(1, 6);
  });

  it("軸ごとに比がばらつくときは中央値を採る (奥行きの外れ値に引きずられない)", () => {
    // 比は [2, 2, 0.25]。平均だと 1.4 台まで落ちるが、中央値は 2。
    const o = objOf({ kind: "chair", width: 0.9, height: 2.1, depth: 0.1125 });
    expect(o.scale).toBeCloseTo(2, 6);
  });

  it("box / wall は params が直接効くので scale は 1 のまま", () => {
    expect(objOf({ kind: "box", width: 3, height: 3, depth: 3 }).scale).toBe(1);
    expect(objOf({ kind: "wall", width: 6, height: 2.6, depth: 0.2 }).scale).toBe(1);
  });

  it("極端な倍率は clamp する (1枚絵の推定として信用しない)", () => {
    // 30m の椅子 (基準 0.45 幅) は 60 倍を要求するが、上限 5 で止める。
    expect(objOf({ kind: "chair", width: 30, height: 30, depth: 30 }).scale).toBe(5);
    // 逆に極小も下限 0.2 で止める。
    expect(objOf({ kind: "car", width: 0.1, height: 0.1, depth: 0.1 }).scale).toBe(0.2);
  });

  it("基準寸法表に無い kind は box へ降格して demoted に計上する (黙って捨てない)", () => {
    // building は params(floors) でしか表現できず、解析寸法を uniform scale へ
    // 落とし込めない。box へ降格させ、件数を UI へ告知できるようにする。
    const draft = parseSceneLayout(
      JSON.stringify({
        person: { floorX: 0, floorZ: 0, rotationYDeg: 0 },
        objects: [{ kind: "building", label: "ビル", floorX: 0, floorZ: 0, width: 5, height: 9, depth: 4 }],
      }),
    )!;
    expect(draft.objects[0].kind).toBe("box");
    expect(draft.objects[0].scale).toBe(1);
    // 寸法は box の params として生き残る (捨てていない)
    expect(draft.objects[0].width).toBe(5);
    expect(draft.objects[0].height).toBe(9);
    expect(draft.demoted).toBe(1);
  });
});

describe("parseSceneLayout — 数値逸脱", () => {
  it("床座標を ±20m に clamp する", () => {
    const raw = JSON.stringify({
      person: { floorX: 999, floorZ: -500, rotationYDeg: 0 },
      objects: [{ kind: "box", label: "遠い箱", floorX: -1e6, floorZ: 42 }],
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.person!.floorX).toBe(20);
    expect(draft.person!.floorZ).toBe(-20);
    expect(draft.objects[0].floorX).toBe(-20);
    expect(draft.objects[0].floorZ).toBe(20);
  });

  it("寸法を 0.1〜30m に clamp する", () => {
    const raw = JSON.stringify({
      objects: [{ kind: "box", label: "潰れた箱", width: 0, height: 1000, depth: -5 }],
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.objects[0].width).toBe(0.1);
    expect(draft.objects[0].height).toBe(30);
    expect(draft.objects[0].depth).toBe(0.1);
  });

  it("NaN / Infinity / 非数値は既定値に落とす (推測で埋めない)", () => {
    // JSON に NaN リテラルは書けないので、文字列と null で同じ経路を踏ませる。
    const raw = JSON.stringify({
      person: { floorX: "1.5", floorZ: null, rotationYDeg: "abc" },
      objects: [{ kind: "box", label: "箱", width: "big", height: null }],
      camera: { azimuthDeg: null, distanceM: "近い", heightM: {}, lensMm: [] },
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.person).toEqual({ floorX: 0, floorZ: 0, rotationYDeg: 0 });
    expect(draft.objects[0].width).toBe(1);
    expect(draft.objects[0].height).toBe(1);
    expect(draft.camera).toEqual({ azimuthDeg: 0, distanceM: 4, heightM: 1.5, lensMm: 35 });
  });

  it("回転角は clamp ではなく (-180, 180] へ正規化する", () => {
    const raw = JSON.stringify({
      person: { floorX: 0, floorZ: 0, rotationYDeg: 370 },
      objects: [
        { kind: "box", label: "a", rotationYDeg: -450 },
        { kind: "box", label: "b", rotationYDeg: 180 },
        { kind: "box", label: "c", rotationYDeg: 270 },
      ],
    });
    const draft = parseSceneLayout(raw)!;
    expect(draft.person!.rotationYDeg).toBe(10);
    expect(draft.objects[0].rotationYDeg).toBe(-90);
    expect(draft.objects[1].rotationYDeg).toBe(180);
    expect(draft.objects[2].rotationYDeg).toBe(-90);
  });

  it("lensMm を LENS_PRESETS_MM の最近傍へ丸める", () => {
    // person を添えるのは「全部空なら null」(B-5) を回避してレンズ丸めだけを見るため。
    const lensOf = (lensMm: unknown) =>
      parseSceneLayout(
        JSON.stringify({
          person: { floorX: 0, floorZ: 0, rotationYDeg: 0 },
          camera: { lensMm },
        }),
      )!.camera.lensMm;
    expect(lensOf(35)).toBe(35);
    expect(lensOf(28)).toBe(24);
    expect(lensOf(40)).toBe(35);
    expect(lensOf(200)).toBe(135);
    expect(lensOf(5)).toBe(18);
    // 24 と 35 の中点。同距離なら広角側 (短い方) を採る契約。
    expect(lensOf(29.5)).toBe(24);
  });

  it("カメラ距離・高さも有限範囲に clamp する", () => {
    const draft = parseSceneLayout(
      '{"person":{"floorX":0,"floorZ":0,"rotationYDeg":0},' +
        '"camera":{"azimuthDeg":0,"distanceM":0,"heightM":-3,"lensMm":35}}',
    )!;
    // 距離0はカメラが被写体に埋まるので下限 0.5m。
    expect(draft.camera.distanceM).toBe(0.5);
    // 地面より下は不採用 (0m へ)。
    expect(draft.camera.heightM).toBe(0);
  });
});

describe("parseSceneLayout — 壊れ JSON", () => {
  it("JSON として読めない応答は null を返す (推測で埋めない)", () => {
    expect(parseSceneLayout("画像を解析できませんでした")).toBeNull();
    expect(parseSceneLayout('{"person": {"floorX": 0,')).toBeNull();
    expect(parseSceneLayout("")).toBeNull();
    expect(parseSceneLayout("   ")).toBeNull();
  });

  it("JSON だがオブジェクトでないものは null を返す", () => {
    expect(parseSceneLayout("[1,2,3]")).toBeNull();
    // 数値・真偽値には '{' が無いので抽出段階で落ちる。
    expect(parseSceneLayout("42")).toBeNull();
  });

  it("人物も物体も無い結果は null を返す (空シーンを成功扱いしない)", () => {
    // Sol 評価 blocking B-5: `{}` を成功として通すと、初期シーンで置換が走って
    // 「人物が消えた空シーン」が成功として着地する。呼び出し側が再問い合わせ
    // → それでも空ならジョブ失敗に倒せるよう、ここは null にする。
    expect(parseSceneLayout("{}")).toBeNull();
    expect(parseSceneLayout('{"person":null,"objects":[]}')).toBeNull();
    // camera だけ返ってきても、置くものが無いなら解析成功とは言えない。
    expect(
      parseSceneLayout('{"camera":{"azimuthDeg":0,"distanceM":3,"heightM":1.6,"lensMm":50}}'),
    ).toBeNull();
  });

  it("objects が配列でない場合、人物が居れば空配置として活かす", () => {
    // objects の型崩れだけで人物まで捨てない (person があれば解析は成立)。
    const draft = parseSceneLayout(
      '{"person":{"floorX":1,"floorZ":2,"rotationYDeg":0},"objects":"机と椅子"}',
    )!;
    expect(draft.objects).toEqual([]);
    expect(draft.person).toEqual({ floorX: 1, floorZ: 2, rotationYDeg: 0 });

    // 人物も居なければ null (上の B-5 と同じ扱い)。
    expect(parseSceneLayout('{"objects":"机と椅子"}')).toBeNull();
  });
});
