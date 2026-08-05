/**
 * A2 + A6 の**実経路**での検査（`reviewStickerImage` 全体）。
 *
 * 個々の部品（`parseReviewFacts` / `evaluateDeterministicRules`）が正しくても、
 * 実経路が旧コードのままなら意味がない。ここでは差し替え可能な deps を使って
 * Codex を1度も呼ばずに、経路そのものを検査する。
 *
 * 見るのは3つ:
 *   1. 壊れた reviewFacts が**次のAIへ届く前に**止まるか（A2）
 *   2. 生の JSON 文字列がプロンプトへ載っていないか（A2 の本命）
 *   3. 決定論のルールがAIを呼ばずに判定されているか（A6）
 */
import { describe, expect, it, vi } from "vitest";

import {
  formatReviewAsText,
  reviewStickerImage,
  type StickerReviewDeps,
} from "../src/lib/sticker/check";
import { REVIEW_DISCLAIMER } from "../src/lib/sticker/reviewRules";

const IMG = "/tmp/01.png";

function rawFacts(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brandMarks: [],
    realPersons: { present: false, reason: "" },
    knownCharacters: [],
    textStrings: [],
    hasPictorialContent: true,
    skinExposure: { present: false, reason: "" },
    violence: { present: false, reason: "" },
    politicalReligious: { present: false, reason: "" },
    discrimination: { present: false, reason: "" },
    gambling: { present: false, reason: "" },
    ...overrides,
  });
}

function deps(over: Partial<StickerReviewDeps> = {}): StickerReviewDeps {
  return {
    describeImage: vi.fn().mockResolvedValue("a cartoon bear waving"),
    extractText: vi.fn().mockResolvedValue({ prompt: "文字なし", textAreaRatio: 0 }),
    reviewFacts: vi.fn().mockResolvedValue(rawFacts()),
    query: vi.fn().mockResolvedValue({ parsedJson: { issues: [] } }),
    ...over,
  };
}

describe("A2: 壊れた reviewFacts は関所で止まる", () => {
  const broken: [string, string][] = [
    ["JSON が無い", "解析できませんでした"],
    ["閉じていない", '{"brandMarks": ["A"'],
    ["空文字", ""],
    ["キーが足りない", '{"brandMarks": []}'],
    ["型が違う", '{"brandMarks": "Nike", "realPersons": {"present": false, "reason": ""}}'],
  ];

  for (const [label, raw] of broken) {
    it(`${label} → error に落ち、issues は空のまま「問題なし」と言わない`, async () => {
      const d = deps({ reviewFacts: vi.fn().mockResolvedValue(raw) });
      const res = await reviewStickerImage(IMG, undefined, undefined, d);

      // 検査が失敗したことが呼び出し側に伝わる。
      expect(res.error, `${label} が握り潰されている（A2 の再発）`).toBeTruthy();
      // **次のAIを呼んでいない**（壊れた材料で判定させない）。
      expect(d.query, `${label} なのに判定AIが呼ばれた`).not.toHaveBeenCalled();
      expect(res.issues).toEqual([]);
    });
  }

  it("正常な reviewFacts なら error にならない（関所が効きすぎていない）", async () => {
    const res = await reviewStickerImage(IMG, undefined, undefined, deps());
    expect(res.error).toBeNull();
  });
});

describe("A2: 生の JSON 文字列を次のAIへ渡さない", () => {
  it("プロンプトに生JSONの断片が載っていない（整形済みの文面だけが渡る）", async () => {
    const query = vi.fn().mockResolvedValue({ parsedJson: { issues: [] } });
    const raw = rawFacts({ brandMarks: ["Nike"] });
    await reviewStickerImage(IMG, undefined, undefined, deps({
      reviewFacts: vi.fn().mockResolvedValue(raw),
      query,
    }));

    const prompt = query.mock.calls[0][0].prompt as string;
    // 生JSONそのものが貼られていない（キー名がそのまま出ていないこと）。
    expect(prompt, "生の JSON がプロンプトへ載っている（A2 の再発）").not.toContain(
      '"hasPictorialContent"',
    );
    expect(prompt).not.toContain(raw);
  });
});

describe("A6: 決定論のルールはAIを呼ばずに判定される", () => {
  it("ブランド名が挙がっていれば、AIが空を返しても brand-mark が出る", async () => {
    // 判定AIは「何も無い」と返す。それでも決定論側が指摘する = 当てはめが機械側にある。
    const res = await reviewStickerImage(IMG, undefined, undefined, deps({
      reviewFacts: vi.fn().mockResolvedValue(rawFacts({ brandMarks: ["Nike"] })),
      query: vi.fn().mockResolvedValue({ parsedJson: { issues: [] } }),
    }));

    expect(res.error).toBeNull();
    expect(
      res.issues.map((i) => i.ruleId),
      "決定論の判定が実経路へ入っていない（A6 の再発）",
    ).toContain("brand-mark");
  });

  it("URL も同様（AI の応答に依存しない）", async () => {
    const res = await reviewStickerImage(IMG, undefined, undefined, deps({
      reviewFacts: vi
        .fn()
        .mockResolvedValue(rawFacts({ textStrings: ["https://example.com"] })),
    }));
    expect(res.issues.map((i) => i.ruleId)).toContain("url-in-image");
  });

  it("決定論で判定済みの ruleId は AI 側のプロンプトから外れている（二重指摘の防止）", async () => {
    const query = vi.fn().mockResolvedValue({ parsedJson: { issues: [] } });
    await reviewStickerImage(IMG, undefined, undefined, deps({ query }));

    const prompt = query.mock.calls[0][0].prompt as string;
    for (const id of ["brand-mark", "real-person", "url-in-image", "gambling"]) {
      expect(prompt, `${id} が AI 側にも残っている`).not.toContain(id);
    }
    // AI が担当するものは残っている。
    expect(prompt).toContain("commercial-ad");
    expect(prompt).toContain("low-visibility");
  });

  it("AI 側で ruleId を捏造されても弾く（既存 normalizeIssues の牙）", async () => {
    const res = await reviewStickerImage(IMG, undefined, undefined, deps({
      query: vi.fn().mockResolvedValue({
        parsedJson: {
          issues: [
            { ruleId: "made-up-rule", severity: "high", message: "m", evidence: "e" },
          ],
        },
      }),
    }));
    expect(res.error, "存在しない ruleId が通っている").toBeTruthy();
  });
});

/**
 * R3: 壊れた内部値が実経路で「問題なし」に化けない。
 *
 * 部品側（`stickerReviewFacts.test.ts`）は `undeterminedFactLabels` を直接見ているが、
 * ここでは**実経路**（`reviewStickerImage`）を通し、UI が「気になる点は
 * 見つかりませんでした」を出す条件そのものが偽になることを確かめる。
 */
describe("R3: 壊れた内部値は実経路でも未判定として残る", () => {
  /** 契約本文にある実物の壊れたJSON。**この入力そのもの**で検査する。 */
  const BROKEN = JSON.stringify({
    brandMarks: [{ name: "Nike" }],
    realPersons: { reason: "人物が見える" },
    knownCharacters: [],
    textStrings: [],
    hasPictorialContent: true,
    skinExposure: { present: false, reason: "" },
    violence: { present: false, reason: "" },
    politicalReligious: { present: false, reason: "" },
    discrimination: { present: false, reason: "" },
    gambling: { present: false, reason: "" },
  });

  it("指摘は0件のまま（＝この壊れ方は指摘では拾えない）", async () => {
    const res = await reviewStickerImage(
      IMG,
      undefined,
      undefined,
      deps({ reviewFacts: vi.fn().mockResolvedValue(BROKEN) }),
    );
    // 前提の確認。ここが0件でなくなったら、この穴は別の経路で塞がれている。
    expect(res.error).toBeNull();
    expect(res.issues).toEqual([]);
  });

  it("**UI の「問題なし」条件が偽になる**（R3 の本体）", async () => {
    const res = await reviewStickerImage(
      IMG,
      undefined,
      undefined,
      deps({ reviewFacts: vi.fn().mockResolvedValue(BROKEN) }),
    );

    // UI（StickerWorkspace）は `issues.length === 0 && undetermined.length === 0` の
    // ときだけ「気になる点は見つかりませんでした」を出す。その式をここで再現する。
    const showsNoIssues = res.issues.length === 0 && res.undetermined.length === 0;
    expect(
      showsNoIssues,
      "壊れたJSONで「気になる点は見つかりませんでした」と表示される（R3 の再発）",
    ).toBe(false);

    expect(res.undetermined.join(" / ")).toContain("実在人物の肖像");
  });

  it("コピーした控えにも未判定が残る（「問題なし」と書かない）", async () => {
    const res = await reviewStickerImage(
      IMG,
      undefined,
      undefined,
      deps({ reviewFacts: vi.fn().mockResolvedValue(BROKEN) }),
    );
    const text = formatReviewAsText({
      results: [res],
      disclaimer: REVIEW_DISCLAIMER,
      excluded: [],
    });
    expect(text).not.toContain("気になる点は見つかりませんでした");
    expect(text).toContain("一部を判定できませんでした");
  });

  it("正常な材料では従来どおり「問題なし」になる（牙が過剰に効いていない）", async () => {
    const res = await reviewStickerImage(IMG, undefined, undefined, deps());
    expect(res.error).toBeNull();
    expect(res.issues).toEqual([]);
    expect(res.undetermined).toEqual([]);

    const text = formatReviewAsText({
      results: [res],
      disclaimer: REVIEW_DISCLAIMER,
      excluded: [],
    });
    expect(text).toContain("気になる点は見つかりませんでした");
  });
});

/**
 * R3: UI 側の表示条件が実際にその式を使っていることの検査。
 *
 * 上のテストは式を**再現**しているだけなので、UI が古い条件
 * （`issues.length === 0` だけ）に戻っても気づけない。実ソースを読んで固定する。
 */
describe("R3: UI の表示条件が未判定を見ている", () => {
  it("StickerWorkspace が undetermined を条件に含めている", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(
      resolve(process.cwd(), "src/components/skills/sticker/StickerWorkspace.tsx"),
      "utf8",
    );

    const at = src.indexOf("気になる点は見つかりませんでした");
    expect(at, "「気になる点は…」の表示が見つからない").toBeGreaterThan(-1);
    // その直前の分岐条件に undetermined が入っていること。
    const condition = src.slice(Math.max(0, at - 600), at);
    expect(
      condition,
      "「問題なし」の表示条件が issues だけを見ている（R3 の再発）",
    ).toContain("r.undetermined.length === 0");
  });
});
