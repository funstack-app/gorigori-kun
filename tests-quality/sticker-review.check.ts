/**
 * LINEスタンプ 審査セルフチェック（層B・S7）の回帰。
 * Codex を実際には呼ばない純ロジック検査（3材料の取得口を deps で差し替える）。
 *
 * 検査の芯は5つ:
 *  1) 3材料すべてがプロンプトに展開されること（A1）— 材料2が欠けると権利判定が空振りする
 *  2) AI が担当するルールが展開されること（A2）
 *  3) 壊れ出力・未知 ruleId を握り潰さないこと（A3）— 「問題なし」と取り違えない
 *  4) 未確認事項（url-in-image）が high へ昇格しないこと — 設計判断をコードで守る
 *  5) main.png は検査対象・tab.png は明示的に除外されること（A5）— 黙って外さない
 *
 * ## 2026-08-05 更新（決定論／AIの分割・A2/A6）
 *
 * 判定が2つの側へ分かれた。この回帰も新しい境界に合わせて書き換えている:
 *
 * - `reviewFacts` は**構造化されて検証される**ようになった（`parseReviewFacts`）。
 *   よって fixture も**必須10キーを揃えた正しい形**でなければならない。
 *   キーが欠けた fixture は「検査失敗」になるのが**正しい挙動**（旧 fixture は
 *   2キーだけの JSON で通っていたが、それは関所が無かったから）。
 * - 一意に決まるルール（brand-mark / url-in-image / gambling など）は**AIを通らない**。
 *   よって「AI が申告した severity を切り下げる」検査の対象は AI 担当の
 *   `commercial-ad` / `low-visibility` に移る。切り下げの牙自体は残す。
 *
 * **緩めた検査は無い。** 境界が動いたぶん、検査する場所を動かしている。
 */
import { expect, test } from "@playwright/test";

import {
  formatReviewAsText,
  reviewStickerImage,
  reviewStickerSet,
  unassignedRuleIds,
  type StickerReviewDeps,
} from "../src/lib/sticker/check";
import {
  AI_JUDGED_RULE_IDS,
  DETERMINISTIC_RULE_IDS,
} from "../src/lib/sticker/deterministicRules";
import {
  LINE_STICKER_REVIEW,
  REVIEW_DISCLAIMER,
  REVIEW_GUIDELINE_URL,
} from "../src/lib/sticker/reviewRules";

/* ---------------------------------------------------------------- *
 * テスト用 deps
 * ---------------------------------------------------------------- */

type Harness = {
  deps: StickerReviewDeps;
  calls: { prompt: string; systemPrompt: string }[];
  counts: { describe: number; text: number; facts: number };
};

/**
 * `codex_review_facts` の**正しい形**の応答（必須10キーが揃っている）。
 *
 * 関所（`parseReviewFacts`）はキーの欠落を許さない。プロンプトが
 * 「該当が無い項目は空配列、または present: false にする。省略しない」と
 * 明示しているため、省略＝指示が守られていない＝応答全体が信頼できない、と判断する。
 * fixture もその契約に合わせる（合わせないと「関所が効いている」ことしか測れない）。
 */
function factsJson(over: Record<string, unknown> = {}): string {
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
    ...over,
  });
}

function makeHarness(opts?: {
  parsedJson?: unknown;
  facts?: string;
  onQuery?: (n: number) => { parsedJson: unknown };
}): Harness {
  const calls: { prompt: string; systemPrompt: string }[] = [];
  const counts = { describe: 0, text: 0, facts: 0 };
  let n = 0;
  return {
    calls,
    counts,
    deps: {
      describeImage: async () => {
        counts.describe += 1;
        return "MARKER_DESCRIPTION a cartoon bear waving";
      },
      extractText: async () => {
        counts.text += 1;
        // 面積比は数値でも返す（A6: text-only-image のしきい値比較を機械側で行うため）。
        return { prompt: "MARKER_TEXTINFO 文字は検出されませんでした", textAreaRatio: 0 };
      },
      reviewFacts: async () => {
        counts.facts += 1;
        return opts?.facts ?? factsJson();
      },
      query: async ({ prompt, systemPrompt }) => {
        calls.push({ prompt, systemPrompt });
        n += 1;
        if (opts?.onQuery) return opts.onQuery(n);
        // `??` を使わないこと: parsedJson: null（JSON抽出失敗）を明示的に渡すテストが
        // あり、`??` だと既定値へ吸われて null の経路を1度も踏まないまま緑になる。
        return {
          parsedJson:
            opts && "parsedJson" in opts ? opts.parsedJson : { issues: [] },
        };
      },
    },
  };
}

/** issue 1件だけを返す harness の短縮形。 */
function withIssue(ruleId: string, severity: string): Harness {
  return makeHarness({
    parsedJson: {
      issues: [{ ruleId, severity, message: "テスト指摘", evidence: "テスト根拠" }],
    },
  });
}

/* ---------------------------------------------------------------- *
 * 1. 3材料の展開（A1）
 * ---------------------------------------------------------------- */

test("A1: 3材料すべてがプロンプトに展開される", async () => {
  const h = makeHarness({
    facts: factsJson({ brandMarks: ["MARKER_FACTS_BRAND"] }),
  });
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);

  expect(h.calls).toHaveLength(1);
  const { prompt } = h.calls[0];
  // 3セクションの見出しが揃っていること
  expect(prompt).toContain("# 材料1: 画像から抽出した文字情報");
  expect(prompt).toContain("# 材料2: 審査観点の事実列挙");
  expect(prompt).toContain("# 材料3: 画像の見た目の概要");
  // 各材料の中身が実際に載っていること（見出しだけ書いて中身を渡さない事故の検知）
  expect(prompt).toContain("MARKER_TEXTINFO");
  expect(prompt).toContain("MARKER_FACTS_BRAND");
  expect(prompt).toContain("MARKER_DESCRIPTION");
});

test("A1: 3材料の取得元がそれぞれ1回ずつ呼ばれる（材料2の呼び忘れ検知）", async () => {
  const h = makeHarness();
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(h.counts).toEqual({ describe: 1, text: 1, facts: 1 });
});

test("材料3を権利判定の根拠にしない旨がプロンプトに明記される", async () => {
  const h = makeHarness();
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(h.calls[0].prompt).toContain("必ず「材料2」を根拠にする");
});

test("uncertain を指摘しない指示がプロンプトに含まれる（推測で断定しない）", async () => {
  const h = makeHarness();
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(h.calls[0].prompt).toContain('"uncertain"');
  expect(h.calls[0].prompt).toContain("指摘しない");
});

test("合否を判定させない指示がプロンプトに含まれる", async () => {
  const h = makeHarness();
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(h.calls[0].prompt).toContain("審査に通るかどうかは書かないでください");
  expect(h.calls[0].systemPrompt).toContain("審査の合否は判定しません");
});

/* ---------------------------------------------------------------- *
 * 2. 12ルールの展開（A2）
 * ---------------------------------------------------------------- */

test("A2: AI が担当するルールがプロンプトに展開される", async () => {
  // 12ルールのうち、意味の解釈が要るものだけが AI へ渡る（A6）。
  // 決定論側のルールを渡すと、同じ事実で二重に指摘され、食い違ったときに
  // どちらが正か決まらなくなる。
  const h = makeHarness();
  await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  const { prompt } = h.calls[0];
  expect(LINE_STICKER_REVIEW).toHaveLength(12);
  for (const id of AI_JUDGED_RULE_IDS) {
    expect(prompt, `AI 担当の ${id} が渡っていない`).toContain(`ruleId="${id}"`);
  }
  for (const id of DETERMINISTIC_RULE_IDS) {
    expect(prompt, `決定論で判定済みの ${id} が AI にも渡っている（二重指摘）`).not.toContain(
      `ruleId="${id}"`,
    );
  }
});

test("A6: 12ルール全てが決定論かAIのどちらかに割り当てられている（取りこぼしゼロ）", () => {
  // 判定を2側へ分けた結果、どちらにも入らないルールは**黙って検査されなくなる**。
  expect(unassignedRuleIds(LINE_STICKER_REVIEW)).toEqual([]);
});

test("ルールIDが重複していない（逆引きが壊れない）", () => {
  const ids = LINE_STICKER_REVIEW.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("AI固有のルールを1つも持たない（AI生成でも審査は通るため）", () => {
  for (const rule of LINE_STICKER_REVIEW) {
    expect(rule.id).not.toContain("ai-");
    expect(`${rule.name}${rule.description}${rule.criteria}`).not.toContain("AI生成");
  }
});

/* ---------------------------------------------------------------- *
 * 3. 壊れ出力を握り潰さない（A3）
 * ---------------------------------------------------------------- */

test("A3: issues キーが無い JSON は「問題なし」にせず error に落ちる", async () => {
  const h = makeHarness({ parsedJson: {} });
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).toContain("issues");
  expect(r.issues).toHaveLength(0);
});

test("A3: issues が配列でない場合も error に落ちる", async () => {
  const h = makeHarness({ parsedJson: { issues: "wrong" } });
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).not.toBeNull();
});

test("A3: parsedJson が null（JSON抽出失敗）は error に落ちる", async () => {
  const h = makeHarness({ parsedJson: null });
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).not.toBeNull();
});

test("A3: 未知の ruleId を握り潰さず error に落ちる", async () => {
  const h = withIssue("totally-made-up", "high");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).not.toBeNull();
  expect(r.issues).toHaveLength(0);
});

test("A3: 不正な severity を握り潰さず error に落ちる", async () => {
  const h = withIssue("commercial-ad", "critical");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).not.toBeNull();
});

test("正常な issue は通る（上の error 群が「常に落ちるだけ」でないことの対照）", async () => {
  const h = withIssue("commercial-ad", "mid");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).toBeNull();
  expect(r.issues).toHaveLength(1);
  expect(r.issues[0].ruleId).toBe("commercial-ad");
  expect(r.issues[0].imagePath).toBe("/tmp/01.png");
});

test("A2の関所: 壊れた reviewFacts は次のAIへ渡る前に止まる", async () => {
  // 生の文字列を次のAIへ流していた穴の回帰。**AIを1度も呼ばない**ことまで見る。
  for (const broken of ["解析できませんでした", '{"brandMarks":[]}', ""]) {
    const h = makeHarness({ facts: broken });
    const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
    expect(r.error, `壊れた facts が握り潰された: ${broken}`).toBeTruthy();
    expect(h.calls, "壊れた材料で判定AIが呼ばれた").toHaveLength(0);
  }
});

/* ---------------------------------------------------------------- *
 * 4. severity の頭打ち（未確認事項を high に昇格させない）
 * ---------------------------------------------------------------- */

test("commercial-ad が high で返っても mid へ切り下げられる", async () => {
  // 切り下げの牙は AI 担当ルールへ移った（決定論側は severity を自分で決めるため、
  // 切り下げる相手がいない）。**牙そのものは残っている。**
  const h = withIssue("commercial-ad", "high");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).toBeNull();
  expect(r.issues[0].severity).toBe("mid");
});

test("low-visibility が high で返っても mid へ切り下げられる", async () => {
  const h = withIssue("low-visibility", "high");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.issues[0].severity).toBe("mid");
});

test("maxSeverity 以下の申告は切り上げない（commercial-ad の low は low のまま）", async () => {
  const h = withIssue("commercial-ad", "low");
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.issues[0].severity).toBe("low");
});

test("決定論側の severity はルール表の値になる（AI の申告に左右されない・A6）", async () => {
  // AI が「何も無い」と返しても、事実が挙がっていれば決定論側が指摘する。
  const h = makeHarness({ facts: factsJson({ brandMarks: ["Nike"] }) });
  const r = await reviewStickerImage("/tmp/01.png", LINE_STICKER_REVIEW, undefined, h.deps);
  expect(r.error).toBeNull();
  const brand = r.issues.find((i) => i.ruleId === "brand-mark");
  expect(brand, "決定論の判定が実経路に入っていない").toBeTruthy();
  expect(brand?.severity).toBe("high");
});

test("未確認事項のルールは maxSeverity が high でない（設計判断の固定）", () => {
  const byId = new Map(LINE_STICKER_REVIEW.map((r) => [r.id, r]));
  expect(byId.get("url-in-image")?.maxSeverity).toBe("mid");
  expect(byId.get("gambling")?.maxSeverity).toBe("mid");
  expect(byId.get("low-visibility")?.maxSeverity).toBe("mid");
  expect(byId.get("commercial-ad")?.maxSeverity).toBe("mid");
});

test("電話番号・QRコードはルール化されていない（推測で埋めない）", () => {
  const all = LINE_STICKER_REVIEW.map((r) => `${r.id}${r.name}${r.description}`).join(" ");
  expect(all).not.toContain("電話番号");
  expect(all).not.toContain("QR");
});

/* ---------------------------------------------------------------- *
 * 5. 検査対象の範囲（A5）と部分成功（A4）
 * ---------------------------------------------------------------- */

test("A5: main.png は検査対象に含まれる", async () => {
  const h = makeHarness();
  const report = await reviewStickerSet(
    ["/out/main.png", "/out/01.png"],
    LINE_STICKER_REVIEW,
    undefined,
    h.deps,
  );
  expect(report.results.map((r) => r.imagePath)).toEqual(["/out/main.png", "/out/01.png"]);
  expect(report.excluded).toHaveLength(0);
});

test("A5: tab.png は対象外だが、理由付きで excluded に残る（黙って外さない）", async () => {
  const h = makeHarness();
  const report = await reviewStickerSet(
    ["/out/main.png", "/out/tab.png", "/out/01.png"],
    LINE_STICKER_REVIEW,
    undefined,
    h.deps,
  );
  expect(report.results.map((r) => r.imagePath)).toEqual(["/out/main.png", "/out/01.png"]);
  expect(report.excluded).toHaveLength(1);
  expect(report.excluded[0].imagePath).toBe("/out/tab.png");
  expect(report.excluded[0].reason).toContain("対象外");
});

test("A4: 1枚が失敗しても残りは続行する（部分成功）", async () => {
  const h = makeHarness({
    onQuery: (n) => {
      if (n === 2) throw new Error("boom");
      return { parsedJson: { issues: [] } };
    },
  });
  const report = await reviewStickerSet(
    ["/out/01.png", "/out/02.png", "/out/03.png"],
    LINE_STICKER_REVIEW,
    undefined,
    h.deps,
  );
  expect(report.results).toHaveLength(3);
  expect(report.results[0].error).toBeNull();
  expect(report.results[1].error).toContain("boom");
  expect(report.results[2].error).toBeNull();
});

/* ---------------------------------------------------------------- *
 * 6. 但し書き（「審査に通る」と言わない）
 * ---------------------------------------------------------------- */

test("レポートには常に但し書きが付く", async () => {
  const h = makeHarness();
  const report = await reviewStickerSet(["/out/01.png"], LINE_STICKER_REVIEW, undefined, h.deps);
  expect(report.disclaimer).toBe(REVIEW_DISCLAIMER);
  expect(report.disclaimer).toContain("審査結果を保証するものではありません");
});

test("整形テキストは「問題なし」でなく「気になる点は見つかりませんでした」と書く", async () => {
  const h = makeHarness();
  const report = await reviewStickerSet(["/out/01.png"], LINE_STICKER_REVIEW, undefined, h.deps);
  const text = formatReviewAsText(report);
  expect(text).toContain("気になる点は見つかりませんでした");
  expect(text).not.toContain("問題なし");
  expect(text).toContain(REVIEW_DISCLAIMER);
});

test("整形テキストに除外ファイルの理由が出る", async () => {
  const h = makeHarness();
  const report = await reviewStickerSet(
    ["/out/01.png", "/out/tab.png"],
    LINE_STICKER_REVIEW,
    undefined,
    h.deps,
  );
  const text = formatReviewAsText(report);
  expect(text).toContain("tab.png");
  expect(text).toContain("対象外");
});

test("規約への参照リンクを持つ（判断基準はLINEの裁量で変わりうるため）", () => {
  expect(REVIEW_GUIDELINE_URL).toContain("creator.line.me");
});
