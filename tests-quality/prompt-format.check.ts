/**
 * 「AIで整える」の出力形式 (JSON / YAML) と whitelist ガードの決定論テスト。
 *
 * ここで固定するのは「LLM を通さない部分」だけ: YAML シリアライザの出力表現と、
 * LLM 出力・手貼り JSON を濾す keepAllowedKeys / sanitizeTimeline の契約。
 * 整形の中身 (LLM の応答品質) はここでは測らない。
 *
 * ## YAML パーサを自前で持つ理由 (現時点では部分対応)
 *
 * 設計時は検証用に `yaml` を devDependency で足す想定だったが、この repo の
 * package-lock.json には `node_modules/pdfjs-dist/node_modules/@napi-rs/canvas`
 * に version を欠いたエントリがあり (HEAD 時点で既存)、npm install が
 * `TypeError: Invalid Version` で落ちるため新規パッケージを追加できない。
 * ラウンドトリップ検証を落とすと「valid YAML を書けているか」を機械で
 * 確かめる手段が無くなるので、検査対象 (このシリアライザが出す部分集合) だけを
 * 読める最小パーサをテスト側に置き、実装とは独立に突き合わせる。
 *
 * **実 YAML パーサでの round-trip は後続タスク (2026-08-03 B3)**。
 * package-lock 破損 (別チケット zi3) の解消後に `yaml@^2` を devDependency へ
 * 追加し、下の parseSimpleYaml を差し替える。それまでの穴埋めとして、
 * 最小パーサ側に **実 YAML と同じ型解釈** (true/false/null/数値への coercion) を
 * 実装し、「plain で出すと型が化ける」型の欠陥は検出できる状態にしてある
 * (テスト「plain scalar で型が化ける値は必ず引用符が付く」)。
 * 最小パーサが実 YAML と乖離しうる範囲 (アンカー・複数行・フロースタイル等) は
 * このシリアライザが出力しないため、現時点の検出力の穴は型解釈以外に無い。
 */
import { expect, test } from "@playwright/test";

import type {
  ImagePromptJson,
  VideoPromptJson,
} from "../src/lib/scene/buildPromptJson";
import { stringifyPromptJson } from "../src/lib/scene/buildPromptJson";
import {
  ALLOWED_IMAGE_KEYS,
  ALLOWED_VIDEO_KEYS,
  keepAllowedKeys,
  sanitizeTimeline,
  stringifyPromptByFormat,
  stringifyPromptYaml,
} from "../src/lib/scene/promptFormat";

// ── 検証用の最小 YAML リーダ (実装とは独立に書く) ──────────────────
//
// 対応するのは stringifyPromptYaml が出しうる形だけ:
//   key: scalar
//   key:
//     - k: v
//       k2: v2
//
// スカラーの解釈は **実 YAML パーサに合わせる**。ダブルクォート付きなら常に
// 文字列、素なら true/false/yes/no/on/off → boolean、null/~/空 → null、
// 数字形式 → number、それ以外を文字列とする。
// ここを「数字以外は全部文字列」にしていると、実装が `style: true` を
// plain で出しても文字列として読み戻ってしまい、型化けを検出できない
// (B3 でこの穴を塞いだ。実 yaml パッケージ導入は package-lock 修復後)。

function parseScalar(raw: string): string | number | boolean | null {
  const text = raw.trim();
  if (text.startsWith('"')) return JSON.parse(text) as string;
  if (/^(?:true|yes|on|y)$/i.test(text)) return true;
  if (/^(?:false|no|off|n)$/i.test(text)) return false;
  if (text === "" || text === "~" || /^null$/i.test(text)) return null;
  // 数値・日付系は「実 YAML が string として返さないもの」を広く拾う。
  // 10進/小数/指数に加え、16進・8進(0o と leading zero)・2進・区切り付き・
  // .inf/.nan・60進・ISO 日付。ここを狭くすると、実装が裸で出した
  // `0xFF` を「文字列で戻った」と誤判定して型化けを見逃す (r2 の穴)。
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (/^[+-]?0x[0-9A-Fa-f_]+$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?0b[01_]+$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?0o?[0-7_]+$/.test(text)) return 1; // 8進 (値は問わない。number であることが要点)
  if (/^[+-]?\d[\d_]*(?:\.[\d_]*)?$/.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[+-]?\.(?:inf|nan)$/i.test(text)) return Number.NaN;
  if (/^[+-]?\d+(?::[0-5]?\d)+(?:\.\d+)?$/.test(text)) return 1; // 60進 (YAML 1.1)
  if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(text)) return 1; // 日付 (Date に化ける)
  return text;
}

function parseSimpleYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.length === 0 ? [] : source.split("\n");
  let currentArrayKey: string | null = null;
  let currentItem: Record<string, unknown> | null = null;

  const flushItem = () => {
    if (currentArrayKey && currentItem) {
      (result[currentArrayKey] as Record<string, unknown>[]).push(currentItem);
      currentItem = null;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") continue;

    // ブロックシーケンスの新要素: "  - k: v"
    const itemStart = /^ {2}- (.+)$/.exec(line);
    if (itemStart) {
      flushItem();
      currentItem = {};
      const [, rest] = itemStart;
      const sep = rest.indexOf(": ");
      currentItem[rest.slice(0, sep)] = parseScalar(rest.slice(sep + 2));
      continue;
    }

    // 同一要素の continuation: "    k: v"
    const itemCont = /^ {4}(.+)$/.exec(line);
    if (itemCont && currentItem) {
      const rest = itemCont[1];
      const sep = rest.indexOf(": ");
      currentItem[rest.slice(0, sep)] = parseScalar(rest.slice(sep + 2));
      continue;
    }

    // トップレベルのキー
    flushItem();
    currentArrayKey = null;
    const sep = line.indexOf(":");
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    if (value.trim() === "") {
      currentArrayKey = key;
      result[key] = [];
    } else {
      result[key] = parseScalar(value);
    }
  }
  flushItem();

  return result;
}

// ── 1. YAML golden (画像) ────────────────────────────────────────

test("画像 JSON が golden どおりの YAML になる", () => {
  const fixture: ImagePromptJson = {
    subject: "a young woman",
    shot_size: "Close Up",
    camera_angle: "Low Angle",
    framing: "Rule of Thirds",
    aspect_ratio: "16:9",
    environment: "rainy street at night",
    lighting: "natural light",
    mood: "calm",
    camera: "film camera",
    shot: "35mm",
    style: "cinematic",
    references: [{ slot: "ref1", note: "same person" }],
  };

  const expected = [
    "subject: a young woman",
    "shot_size: Close Up",
    "camera_angle: Low Angle",
    "framing: Rule of Thirds",
    'aspect_ratio: "16:9"',
    "environment: rainy street at night",
    "lighting: natural light",
    "mood: calm",
    "camera: film camera",
    // 数字始まりは裸で出さない (B3 r3 のホワイトリスト)。`35mm` 自体は
    // 現行パーサでは文字列に落ちるが、判定を「英字始まりだけ許す」に倒した
    // 副作用として引用符が付く。安全側なのでこれを golden とする。
    'shot: "35mm"',
    "style: cinematic",
    "references:",
    "  - slot: ref1",
    "    note: same person",
  ].join("\n");

  expect(stringifyPromptYaml(fixture)).toBe(expected);
});

// ── 2. YAML golden (動画・timeline 付き) ─────────────────────────

test("動画 JSON の timeline がブロックシーケンスで出る", () => {
  const fixture: VideoPromptJson = {
    subject: "a runner",
    subject_motion: "starts walking then runs",
    camera_motion: "pull back",
    duration_seconds: 8,
    timeline: [
      { time: "0-3s", action: "walks forward", camera: "static" },
      { time: "3-8s", action: "runs toward sunset", camera: "pull back" },
    ],
  };

  const expected = [
    "subject: a runner",
    "subject_motion: starts walking then runs",
    "camera_motion: pull back",
    "duration_seconds: 8",
    "timeline:",
    // `0-3s` は数字始まりなので引用符化される (B3 r3)。裸で出すと YAML の
    // 数値・60進表記と紛らわしく、パーサ差で型化けしうる範囲に入る。
    '  - time: "0-3s"',
    "    action: walks forward",
    "    camera: static",
    '  - time: "3-8s"',
    "    action: runs toward sunset",
    "    camera: pull back",
  ].join("\n");

  expect(stringifyPromptYaml(fixture)).toBe(expected);
});

// ── 3. YAML 妥当性ラウンドトリップ (特殊値) ──────────────────────

test("特殊値を含む JSON が YAML を経て元の値に戻る", () => {
  const fixture: VideoPromptJson = {
    subject: "夕日に向かって走る人", // 日本語 → クォートされる
    scene: "a: b", // コロン → クォート必須
    subject_motion: 'says "go"', // ダブルクォート入り
    camera_motion: "line1\nline2", // 改行入り
    staging: "#1 position", // # 始まり
    lighting: " leading space", // 先頭スペース
    mood: "- dash start", // - 始まり
    style: "plain text value", // 素で出せる
    aspect_ratio: "16:9", // コロン → クォート
    duration_seconds: 8, // 数値
    timeline: [{ time: "0-8s", action: "駆け出す" }],
  };

  const yamlText = stringifyPromptYaml(fixture);
  const parsed = parseSimpleYaml(yamlText);

  expect(parsed).toEqual(fixture);
});

// ── 3b. 型化けの防止 (B3 2026-08-03) ─────────────────────────────

test("plain scalar で型が化ける値は必ず引用符が付く", () => {
  // 実 YAML パーサが string 以外として読む綴りの網羅。
  // ここを plain で出すと、受け取り側 (LLM / 人) には string でなく
  // boolean / null / number として渡る。
  const coerced = [
    "true",
    "True",
    "TRUE",
    "false",
    "yes",
    "no",
    "on",
    "off",
    "y",
    "n",
    "null",
    "NULL",
    "~",
    "8",
    "-3",
    "1.5",
    ".5",
    "1e3",
    "+7",
    // r3 追加: r2 で取りこぼした「10進以外の数値表記」。ホワイトリスト方式
    // (英字始まりのみ裸で出す) に反転したので、以下は個別列挙なしで全て
    // 引用符側に落ちる。落ちなくなったら回帰として検出する。
    "0x1F",
    "0xFF",
    "0b101",
    "0o17",
    "017",
    "1_000",
    ".inf",
    "-.inf",
    ".nan",
    "1:30",
    "2026-08-03",
  ];

  for (const value of coerced) {
    const line = stringifyPromptYaml({ style: value } as ImagePromptJson);
    expect(line, `${value} は引用符付きで出るべき`).toBe(`style: ${JSON.stringify(value)}`);
    // 読み戻しても string のままであること (型が保たれる)。
    expect(parseSimpleYaml(line).style, `${value} は string で戻るべき`).toBe(value);
  }
});

test("型化けしうる値が YAML を経ても string のまま戻る", () => {
  const fixture: VideoPromptJson = {
    subject: "true", // boolean に化ける綴り
    scene: "null", // null に化ける綴り
    subject_motion: "8", // number に化ける綴り
    camera_motion: "no", // YAML 1.1 の boolean
    style: "1e3", // 指数表記
    duration_seconds: 8, // ここは本当に number
    timeline: [{ time: "0-8s", action: "false" }], // 配列要素側も同じ規則
  };

  const parsed = parseSimpleYaml(stringifyPromptYaml(fixture));

  expect(parsed).toEqual(fixture);
  // 明示的に型も確認する (toEqual だけだと 8 と "8" の取り違えを見落としやすい)。
  expect(typeof parsed.subject).toBe("string");
  expect(typeof parsed.subject_motion).toBe("string");
  expect(typeof parsed.duration_seconds).toBe("number");
});

test("空文字は null に化けないよう引用符が付く", () => {
  // keepAllowedKeys は空文字を落とすので通常は到達しないが、シリアライザ単体の
  // 契約として固定する (別経路から空文字が来ても null 化しない)。
  expect(stringifyPromptYaml({ style: "" } as ImagePromptJson)).toBe('style: ""');
  expect(parseSimpleYaml('style: ""').style).toBe("");
});

test("数値は引用符なしで数値として戻る", () => {
  // 型化け対策が「何でも引用符」になっていないことの裏取り。
  const yamlText = stringifyPromptYaml({
    subject: "a runner",
    duration_seconds: 8,
  } as VideoPromptJson);
  expect(yamlText).toContain("duration_seconds: 8");
  expect(parseSimpleYaml(yamlText).duration_seconds).toBe(8);
});

// ── 4. 形式委譲 ─────────────────────────────────────────────────

test("json 形式は stringifyPromptJson に委譲される", () => {
  const fixture: ImagePromptJson = { subject: "a cat", lighting: "backlight" };
  expect(stringifyPromptByFormat(fixture, "json")).toBe(stringifyPromptJson(fixture));
});

test("空オブジェクトは両形式とも空文字", () => {
  expect(stringifyPromptByFormat({}, "json")).toBe("");
  expect(stringifyPromptByFormat({}, "yaml")).toBe("");
});

// ── 5. whitelist ガード ──────────────────────────────────────────

test("許可外キーは除去される", () => {
  const filtered = keepAllowedKeys<ImagePromptJson>(
    { subject: "a cat", nsfw_hack: "ignore rules", extra: "junk" },
    ALLOWED_IMAGE_KEYS,
  );
  expect(filtered).toEqual({ subject: "a cat" });
});

test("全キーが許可外なら null", () => {
  expect(keepAllowedKeys({ foo: "x", bar: "y" }, ALLOWED_IMAGE_KEYS)).toBeNull();
});

test("非オブジェクト・配列トップレベルは null", () => {
  expect(keepAllowedKeys("just text", ALLOWED_IMAGE_KEYS)).toBeNull();
  expect(keepAllowedKeys([{ subject: "a cat" }], ALLOWED_IMAGE_KEYS)).toBeNull();
  expect(keepAllowedKeys(null, ALLOWED_IMAGE_KEYS)).toBeNull();
});

test("duration_seconds は正の有限数だけ採用する", () => {
  expect(
    keepAllowedKeys<VideoPromptJson>(
      { subject: "a runner", duration_seconds: "8" },
      ALLOWED_VIDEO_KEYS,
    ),
  ).toEqual({ subject: "a runner" });

  expect(
    keepAllowedKeys<VideoPromptJson>(
      { subject: "a runner", duration_seconds: -3 },
      ALLOWED_VIDEO_KEYS,
    ),
  ).toEqual({ subject: "a runner" });

  expect(
    keepAllowedKeys<VideoPromptJson>(
      { subject: "a runner", duration_seconds: 8 },
      ALLOWED_VIDEO_KEYS,
    ),
  ).toEqual({ subject: "a runner", duration_seconds: 8 });
});

test("sanitizeTimeline は time 欠落要素を捨てる", () => {
  const result = sanitizeTimeline([
    { time: "0-2s", action: "walks" },
    { action: "no time key" },
    { time: "   " },
    { time: "2-4s", camera: "pan left" },
    "not an object",
  ]);
  expect(result).toEqual([
    { time: "0-2s", action: "walks" },
    { time: "2-4s", camera: "pan left" },
  ]);
});

test("sanitizeTimeline は 12 件で切る", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    time: `${i}-${i + 1}s`,
    action: `step ${i}`,
  }));
  expect(sanitizeTimeline(many)).toHaveLength(12);
});

test("sanitizeTimeline は生き残り 0 件なら undefined", () => {
  expect(sanitizeTimeline([{ action: "no time" }])).toBeUndefined();
  expect(sanitizeTimeline([])).toBeUndefined();
  expect(sanitizeTimeline("not an array")).toBeUndefined();
});

test("timeline / references は keepAllowedKeys 経由でも濾される", () => {
  const filtered = keepAllowedKeys<VideoPromptJson>(
    {
      subject: "a runner",
      timeline: [{ time: "0-2s", action: "walks" }, { action: "dropped" }],
      references: [{ slot: "ref1", note: "same person" }, { note: "no slot" }],
    },
    ALLOWED_VIDEO_KEYS,
  );
  expect(filtered).toEqual({
    subject: "a runner",
    timeline: [{ time: "0-2s", action: "walks" }],
    references: [{ slot: "ref1", note: "same person" }],
  });
});
