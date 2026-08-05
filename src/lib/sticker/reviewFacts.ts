/**
 * 審査観点の事実列挙（`codex_review_facts`）の**関所**（A2 / 設計原則 第3条）。
 *
 * ## なぜこのファイルが要るのか
 *
 * `codexVision.reviewFacts()` の契約は「**未検証の生 JSON 文字列**を返す。パースと検証は
 * 呼び出し側が行う」（`ipc.ts` / `codex_vision.rs` の両方に明記）。ところが呼び出し側の
 * `check.ts` は生の文字列をそのまま次のAIのプロンプトへ載せていた。つまり
 * **「呼び出し側が検証する」と書かれた検証が、どこにも実装されていなかった**。
 *
 * 結果として、壊れたJSON・前置きだけの文章・空文字が判定材料として次段へ流れ、
 * 「材料はあったが該当が無かった」と「材料の取得に失敗した」が区別できなくなる。
 * 検査が静かに空振りする（`regulationCheck/check.ts` 冒頭が記録している事故と同型）。
 *
 * ## 同型の前例に揃える
 *
 * `regulationCheck/textBlocks.ts` の `parseTextBlocks` が同じ問題を既に解いている:
 * 前置き付き出力を最初の `{` と最後の `}` で切り出し、**形が違えば黙って空で埋めず
 * throw する**（no-silent-gap-filling）。ここも同じ規則で書く。同じプロンプト系統の
 * 出力を食う経路で解釈がズレないようにするため。
 *
 * ## 何を検証し、何を検証しないか
 *
 * - 検証する: JSON として読めるか / オブジェクトか / **必須キーが揃っているか** /
 *   各キーの型（配列 or present-flag 形）
 * - 検証しない: 中身の真偽（ブランド名が実在するか等）。それは AI の判断であって
 *   関所の仕事ではない
 *
 * ## `uncertain` を型で持つ
 *
 * Rust 側プロンプト（`codex_vision.rs` の `review_facts_prompt`）は「確信が持てない
 * 場合は present の代わりに文字列 `"uncertain"` を書く」と指示している。
 * ここを `boolean` へ潰すと **「分からない」が「該当なし」に化ける**（推測で埋める）。
 * 3値（true / false / "uncertain"）のまま持ち、下流のルール照合が
 * 「uncertain は指摘しない」を判断できるようにする。
 */

/** present-flag 形の1項目。`"uncertain"` は「判別できない」であって false ではない。 */
export type ReviewFlag = {
  /** true = 該当あり / false = 該当なし / "uncertain" = 判別できない。 */
  present: boolean | "uncertain";
  /** 日本語の理由。該当なしなら空文字。 */
  reason: string;
};

/**
 * 検証済みの審査観点の事実。
 *
 * キーは `codex_vision.rs::review_facts_prompt()` が出力を要求する10キーと1対1。
 * 片方だけ増減すると `reviewFacts.test.ts` の突き合わせが落ちる。
 */
export type ReviewFacts = {
  /** 識別できた実在の企業ロゴ・商標・製品意匠の名称。 */
  brandMarks: string[];
  realPersons: ReviewFlag;
  /** 既存の商用キャラクター・作品由来と識別できたものの名称。 */
  knownCharacters: string[];
  /** 画像内の文字（URL・電話番号を含む）。 */
  textStrings: string[];
  /** 文字以外の絵の要素が描かれているか。 */
  hasPictorialContent: boolean | "uncertain";
  skinExposure: ReviewFlag;
  violence: ReviewFlag;
  politicalReligious: ReviewFlag;
  discrimination: ReviewFlag;
  gambling: ReviewFlag;
  /**
   * **判定できなかった項目**の識別子（R3 / 2026-08-05）。空なら全項目を判定できた。
   *
   * ## なぜこの欄が要るのか
   *
   * トップ階層のキー検証は throw で守られているが、**内部の値**は静かに落ちていた:
   *
   * - `toStringList` は配列内の非文字列要素を捨てる（`[{"name":"Nike"}]` → `[]`）
   * - `toTriState` は不正な `present` を `"uncertain"` へ倒す（キー欠落も同じ扱い）
   *
   * どちらも「1要素の型ミスで画像1枚を丸ごと落とすのは過剰」という判断から来ており、
   * その判断自体は維持する。だが**捨てた事実まで消える**と、
   * `{"brandMarks":[{"name":"Nike"}], "realPersons":{"reason":"人物が見える"}}`
   * のような壊れ方が「該当なし」として通り、UIが「気になる点は見つかりませんでした」
   * と表示できてしまう。**黙って捨てない・黙って埋めない**（no-silent-gap-filling）。
   *
   * 中身は `"brandMarks[0]"` `"realPersons.present"` のような人が読める識別子。
   * throw にしない理由は上の「画像1枚を落とさない」との整合で、代わりに
   * **未判定として下流へ運び、UIとプロンプトの両方に明示する**。
   */
  unparsed: string[];
};

/** 配列で来るべきキー。プロンプトの形と1対1に保つ。 */
export const REVIEW_FACT_LIST_KEYS = [
  "brandMarks",
  "knownCharacters",
  "textStrings",
] as const;

/** present-flag 形で来るべきキー。 */
export const REVIEW_FACT_FLAG_KEYS = [
  "realPersons",
  "skinExposure",
  "violence",
  "politicalReligious",
  "discrimination",
  "gambling",
] as const;

/**
 * 文字列を「非空・トリム済み」へ整えた配列にする。
 *
 * **要素の型が違うものは捨てるが、捨てた事実を `unparsed` へ記録する**（R3）。
 * 1要素の型ミスで画像1枚の検査を丸ごと落とすのは過剰、という判断は維持する。
 * だが黙って捨てると `[{"name":"Nike"}]` が「該当なし」に化ける。
 * 配列でないことは throw で拾う（そちらは形そのものが違う）。
 *
 * 空文字・空白だけの要素は**記録しない** — 「該当なし」を空文字で表す出力揺れは
 * 実際にあり、これを未判定にすると全件が未判定になってノイズしか残らない。
 * 記録するのは**型が違う要素**（文字列でないもの）だけにする。
 */
function toStringList(value: unknown, key: string, unparsed: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`審査観点の事実列挙の ${key} が配列ではありません`);
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string") {
      unparsed.push(`${key}[${i}]`);
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * true / false / "uncertain" の3値へ落とす。それ以外は "uncertain" 扱い。
 *
 * 倒したときは `unparsed` へ記録する（R3）。`"uncertain"` と明示された値と、
 * **AIが何も書かなかった／壊れた値を書いた**のは別の事実であり、
 * 前者だけを残すと「材料が壊れていた」という情報が消える。
 */
function toTriState(value: unknown, key: string, unparsed: string[]): boolean | "uncertain" {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim().toLowerCase() === "uncertain") {
    return "uncertain";
  }
  // 想定外の値を false（該当なし）へ倒すと、**分からないものを安全だと言う**ことになる。
  // 分からないものは分からないままにする（no-silent-gap-filling）。
  unparsed.push(key);
  return "uncertain";
}

/** `{present, reason}` 形へ落とす。キーごと欠けていたら throw（材料不足の可視化）。 */
function toFlag(value: unknown, key: string, unparsed: string[]): ReviewFlag {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`審査観点の事実列挙の ${key} の形式が不正です`);
  }
  const rec = value as Record<string, unknown>;
  return {
    present: toTriState(rec.present, `${key}.present`, unparsed),
    reason: typeof rec.reason === "string" ? rec.reason.trim() : "",
  };
}

/**
 * `codexVision.reviewFacts()` の生出力を検証済みの構造へ変換する。
 *
 * 壊れていれば **throw する**。呼び出し側（`reviewStickerImage`）の try/catch が
 * その画像を `error` に落とすので、影響は画像1枚に閉じる（部分失敗・A4）。
 * 空の結果（＝問題なし）で握り潰すと、検査が動いていないことを誰も知らないまま
 * 「気になる点は見つかりませんでした」と表示される。それが最悪の失敗。
 */
export function parseReviewFacts(raw: string): ReviewFacts {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  // 前置き付きで返ることがある前提で切り出す（parseTextBlocks / parse_object_words と同規則）。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("審査観点の事実列挙の応答に JSON が含まれていませんでした");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error("審査観点の事実列挙の応答が JSON として読めませんでした");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("審査観点の事実列挙の応答の形式が不正です");
  }
  const rec = parsed as Record<string, unknown>;

  // **キーの欠落を許さない**。プロンプトは「該当が無い項目は空配列、または
  // present: false にする。省略しない」と明示している。省略されたということは
  // 指示が守られていない＝この応答全体の信頼度が無い、と判断する。
  // ここを「無ければ空配列で補う」にすると、材料が取れていない画像を
  // 「該当なし」として通してしまう（この関所の存在理由そのものが消える）。
  for (const key of [...REVIEW_FACT_LIST_KEYS, ...REVIEW_FACT_FLAG_KEYS]) {
    if (!(key in rec)) {
      throw new Error(`審査観点の事実列挙に ${key} がありません`);
    }
  }
  if (!("hasPictorialContent" in rec)) {
    throw new Error("審査観点の事実列挙に hasPictorialContent がありません");
  }

  // 落とした値・倒した値をここへ溜める（R3）。空でなければ「未判定あり」。
  const unparsed: string[] = [];

  return {
    brandMarks: toStringList(rec.brandMarks, "brandMarks", unparsed),
    realPersons: toFlag(rec.realPersons, "realPersons", unparsed),
    knownCharacters: toStringList(rec.knownCharacters, "knownCharacters", unparsed),
    textStrings: toStringList(rec.textStrings, "textStrings", unparsed),
    hasPictorialContent: toTriState(rec.hasPictorialContent, "hasPictorialContent", unparsed),
    skinExposure: toFlag(rec.skinExposure, "skinExposure", unparsed),
    violence: toFlag(rec.violence, "violence", unparsed),
    politicalReligious: toFlag(rec.politicalReligious, "politicalReligious", unparsed),
    discrimination: toFlag(rec.discrimination, "discrimination", unparsed),
    gambling: toFlag(rec.gambling, "gambling", unparsed),
    unparsed,
  };
}

/**
 * 「この画像は一部を判定できなかった」項目の一覧（R3）。
 *
 * `unparsed`（材料が壊れていた）に加え、**`"uncertain"` と申告された項目**も含める。
 * どちらも「該当なし」ではなく「分からない」であり、UIが「問題なし」と
 * 言い切ってよい状態ではない。決定論ルール（`isPresent`）は uncertain を
 * 指摘しない設計なので、指摘が0件でも安全とは限らない — その差をここで埋める。
 *
 * 戻りは人が読めるラベル。UI にそのまま並べられる粒度にする。
 */
export function undeterminedFactLabels(facts: ReviewFacts): string[] {
  const labels: string[] = [];
  const flagLabels: [ReviewFlag, string][] = [
    [facts.realPersons, "実在人物の肖像"],
    [facts.skinExposure, "肌の露出・性的表現"],
    [facts.violence, "暴力・犯罪"],
    [facts.politicalReligious, "政治・宗教"],
    [facts.discrimination, "差別的表現"],
    [facts.gambling, "ギャンブル"],
  ];
  for (const [flag, label] of flagLabels) {
    if (flag.present === "uncertain") labels.push(label);
  }
  if (facts.hasPictorialContent === "uncertain") labels.push("文字以外の絵の要素");
  // 材料が壊れていた項目は、生の識別子ではなく「材料が壊れていた」と分かる形で出す。
  for (const key of facts.unparsed) {
    labels.push(`${key}（材料が読めませんでした）`);
  }
  // 同じ項目が uncertain と unparsed の両方で挙がることがある（present が壊れて
  // uncertain へ倒れた場合）。重複は畳む — 同じ事実で2回言わない。
  return [...new Set(labels)];
}

/**
 * 検証済みの事実を、AIに読ませるプロンプト断片へ整形する。
 *
 * 生JSONをそのまま貼らないのは、**関所を通した証拠を形として残す**ため。
 * 整形済みの文面しか下流へ渡らない構造にすると、検証を飛ばす経路が作れない。
 */
export function formatReviewFactsForPrompt(facts: ReviewFacts): string {
  const flag = (label: string, f: ReviewFlag): string => {
    const state =
      f.present === true ? "該当あり" : f.present === false ? "該当なし" : "uncertain（判別できない）";
    return `- ${label}: ${state}${f.reason ? `（${f.reason}）` : ""}`;
  };
  const list = (label: string, values: string[]): string =>
    `- ${label}: ${values.length === 0 ? "該当なし" : values.join(" / ")}`;

  const lines = [
    list("実在の企業ロゴ・商標・製品意匠", facts.brandMarks),
    list("既存の商用キャラクター・作品由来", facts.knownCharacters),
    list("画像内の文字", facts.textStrings),
    `- 文字以外の絵の要素: ${
      facts.hasPictorialContent === true
        ? "あり"
        : facts.hasPictorialContent === false
          ? "なし"
          : "uncertain（判別できない）"
    }`,
    flag("実在人物の肖像", facts.realPersons),
    flag("肌の露出・性的表現", facts.skinExposure),
    flag("暴力・犯罪", facts.violence),
    flag("政治・宗教", facts.politicalReligious),
    flag("差別的表現", facts.discrimination),
    flag("ギャンブル", facts.gambling),
  ];

  // 材料が壊れていた項目を明示する（R3）。**「該当なし」と読ませない。**
  // ここを黙って落とすと、下流のAIは「全部の材料が揃っていて該当が無かった」と
  // 解釈する（材料の欠落と該当なしが区別できなくなる）。
  if (facts.unparsed.length > 0) {
    lines.push(
      `- ⚠️ 材料が壊れていて読み取れなかった項目: ${facts.unparsed.join(" / ")}（該当なしという意味ではありません）`,
    );
  }

  return lines.join("\n");
}
