/**
 * スタンプスキルの**配線**の回帰（設計書 v3 S8）。
 *
 * ## なぜ配線を検査するか
 *
 * S8 が繋ぐのは「スキル一覧のカード → UiMode → Workspace → Rust コマンド」の4点で、
 * **どれか1つが欠けるとスキルが画面から消える／押しても何も起きない**。しかも
 * TypeScript は大半を通してしまう:
 *
 * - `SKILL_UI_MODE_MAP` に登録し忘れる → `resolveUiMode` が `"default"` を返し、
 *   カードを押すと**作品モードが開く**（型エラーは出ない。Record のキーは string）
 * - `renderSkillWorkspace` の case を書き忘れる → 画面が空になる
 * - `invoke_handler` への登録漏れ → 実行時に "command not found"（`cargo check` は通る）
 *
 * これらは「静かに壊れる」型なので、決定論の検査で止める価値が高い
 * （`skill-design-principles` の階段モデル: 再発する罠は Gotchas に留めず機械化する）。
 *
 * ブラウザも Tauri ランタイムも使わない。**ソースを文字列として読んで突き合わせる**
 * だけなので、CI のどの環境でも必ず走る。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";

import { GORI_SKILLS, type GoriSkillId } from "../src/lib/skills/catalog";
import { SKILL_UI_MODE_MAP, resolveUiMode } from "../src/lib/store/skillUiMode";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

const STICKER_SKILL_ID: GoriSkillId = "gori-sticker";

// ── スキル一覧への登録（工程の入口）──

test("スキル一覧に LINEスタンプのカードがあり、アプリ内から使える", () => {
  const entry = GORI_SKILLS.find((s) => s.id === STICKER_SKILL_ID);
  expect(entry, "GORI_SKILLS に gori-sticker が無い（一覧に出ない）").toBeTruthy();
  expect(entry?.availableInApp).toBe(true);
  expect(entry?.comingSoon ?? false).toBe(false);
});

test("カードは表情差分の隣に置かれる（用途が最も近いものが並ぶ）", () => {
  const ids = GORI_SKILLS.map((s) => s.id);
  const expressionAt = ids.indexOf("gori-expression-set");
  const stickerAt = ids.indexOf(STICKER_SKILL_ID);
  expect(expressionAt).toBeGreaterThanOrEqual(0);
  expect(stickerAt).toBe(expressionAt + 1);
});

/**
 * 説明文が「審査に通る」と約束していないこと（設計書 §0.4 / §6.5）。
 *
 * 機械が保証できるのは**画像規格**まで。承認可否は LINE の裁量なので、
 * 一覧の説明文にも保証表現を置かない。ここが緩むと、ユーザーは
 * 「このアプリを通せば通る」と読む。
 */
test("スキルの説明文が審査の合格を約束していない", () => {
  const entry = GORI_SKILLS.find((s) => s.id === STICKER_SKILL_ID);
  const text = `${entry?.name ?? ""} ${entry?.description ?? ""} ${entry?.launchHint ?? ""}`;

  // 「審査に通る」を単純な部分一致で禁じると、**免責の文**（「審査に通るかどうかは
  // LINEの判断になります」）まで巻き込む。禁じたいのは断定であって、言及ではない。
  // 断定の言い切り（〜ます/〜る。/文末）だけを拾い、「〜かどうか」「〜とは限らない」は通す。
  const promises = [
    /審査に通ります/,
    /審査に通る(?!か)/,
    /審査を通過(します|できます)/,
    /承認されます/,
    /(問題ありません|安全です)/,
    // 層Aが言ってよいのは「画像規格」まで。「LINEの規格」は審査基準全体に読める。
    /LINEの規格を満たして/,
  ];
  for (const pattern of promises) {
    expect(text, `保証表現 ${pattern} が説明文にある`).not.toMatch(pattern);
  }

  // 「審査」に言及するなら、LINEの判断であることとセットで書く。
  if (text.includes("審査")) {
    expect(text, "審査に言及しているのに、判断主体がLINEであることを書いていない").toMatch(
      /LINE(の判断|の審査|が判断)/,
    );
  }
});

// ── UiMode 解決（押したときに開く画面）──

test("gori-sticker が sticker モードへ解決される（作品モードに落ちない）", () => {
  expect(SKILL_UI_MODE_MAP[STICKER_SKILL_ID]).toBe("sticker");
  // 登録漏れは "default" へ落ちる。型では防げないのでここで止める。
  expect(resolveUiMode(STICKER_SKILL_ID)).toBe("sticker");
  expect(resolveUiMode(STICKER_SKILL_ID)).not.toBe("default");
});

test("アプリ内で使える全スキルが UiMode を持つ（sticker だけの問題にしない）", () => {
  for (const skill of GORI_SKILLS) {
    if (!skill.availableInApp) continue;
    expect(
      resolveUiMode(skill.id),
      `${skill.id} が UiMode 未登録。押すと作品モードが開く`,
    ).not.toBe("default");
  }
});

// ── Router への接続（画面が実際に描かれるか）──

test("Router が sticker の case を持ち、StickerWorkspace を描く", () => {
  const router = read("src/components/SkillWorkspaceRouter.tsx");
  expect(router).toContain('case "sticker":');
  expect(router).toContain("<StickerWorkspace />");
  expect(router).toContain(
    'import { StickerWorkspace } from "./skills/sticker/StickerWorkspace"',
  );
});

// ── Rust コマンドの登録（押しても何も起きない事故の防止）──

/**
 * `invoke_handler` への登録漏れは **`cargo check` を通る**。コマンド関数は
 * 定義されていて、登録だけが無い状態がコンパイルできてしまうため。
 * フロントから呼んだ瞬間に初めて "command not found" になる。
 */
test("スタンプの Tauri コマンドが3本とも invoke_handler に登録されている", () => {
  const lib = read("src-tauri/src/lib.rs");
  for (const command of ["sticker_chroma_key", "sticker_inspect", "sticker_export"]) {
    expect(lib, `${command} が invoke_handler に無い`).toContain(
      `commands::sticker::${command}`,
    );
  }
});

test("登録されたコマンド名と Rust 側の #[tauri::command] 実体が一致する", () => {
  const source = read("src-tauri/src/commands/sticker.rs");
  for (const command of ["sticker_chroma_key", "sticker_inspect", "sticker_export"]) {
    expect(source, `${command} の実体が sticker.rs に無い`).toMatch(
      new RegExp(`pub async fn ${command}\\s*\\(`),
    );
  }
});

test("フロントの ipc ラッパが3コマンドとも同じ名前で invoke している", () => {
  const ipc = read("src/lib/ipc.ts");
  for (const command of ["sticker_chroma_key", "sticker_inspect", "sticker_export"]) {
    expect(ipc, `ipc.ts が ${command} を呼んでいない`).toContain(`"${command}"`);
  }
});

// ── 工程の通し（採否ゲートを飛ばす導線が生えていないこと）──

/**
 * 採否（工程④）は**必須ゲート**（設計書 §1.6 / §6.3）。公式リジェクト 1.10
 * 「似た絵柄の多用」はセット全体を並べて見ないと原理的に検出できないため、
 * ここを飛ばす導線を作らない。「全部使う」ボタンは置くが、それは**採否画面の中**の
 * 1クリックであって、画面自体のスキップではない。
 */
test("Workspace が採否フェーズを経ずに書き出しへ入る導線を持たない", () => {
  const workspace = read("src/components/skills/sticker/StickerWorkspace.tsx");
  // 生成フェーズから直接 export へ飛ぶ遷移が無いこと。
  expect(workspace).toContain('setPhase("pick")');
  expect(workspace).toContain('onGoPick');
  // GeneratePanel が export へ直行する遷移を持っていたら設計違反。
  const generatePanel = workspace.slice(
    workspace.indexOf("function GeneratePanel"),
    workspace.indexOf("function ExportPanel"),
  );
  expect(generatePanel.length).toBeGreaterThan(0);
  expect(
    generatePanel,
    "生成画面から書き出しへ直行できてしまう（採否ゲートの迂回）",
  ).not.toContain('setPhase("export")');
});

/**
 * 生成物は緑背景で出てくるので、採否リストへ載せる前に必ず透過へ抜く（設計書 §1.4）。
 *
 * これを飛ばすと、層Aの `no-alpha` が**全枚数をブロック**して1枚も完走しない。
 * 「コマンドは登録したが呼んでいない」は cargo/tsc の両方を通るので、ここで止める
 * （実装時に実際に踏んだ抜け）。
 */
test("生成完了時に背景抜きを通してから採否リストへ載せる", () => {
  // 2026-08-05 J4: 抜きの実装は Workspace 直書きから lib/sticker/cutout.ts の
  // cutOutBackground（AI抜き優先・クロマキー保険）へ移動した。契約は同じ:
  // 「緑背景のまま採否へ流さない」。
  const workspace = read("src/components/skills/sticker/StickerWorkspace.tsx");
  expect(workspace, "背景抜きを一度も呼んでいない（緑背景のまま採否へ流れる）").toContain(
    "cutOutBackground(",
  );
  // 保険のクロマキー経路が cutout.ts 側に現存すること。
  const cutout = read("src/lib/sticker/cutout.ts");
  expect(cutout, "クロマキー保険経路が消えている").toContain("sticker.chromaKey(");
  // 2026-08-22 タブ切替耐性の移設で、cutCompleted の処理は Workspace から
  // stickerRun.ts（モジュール常駐ストア）へ移った。契約は不変:
  // 「cutCompleted で必ず抜き（cutOutHandler）を通してから決着させる」。
  const runStore = read("src/lib/store/stickerRun.ts");
  const completedAt = runStore.indexOf('event.kind === "cutCompleted"');
  expect(completedAt, "cutCompleted の処理がストアに無い").toBeGreaterThan(0);
  const completedBlock = runStore.slice(completedAt, completedAt + 800);
  expect(completedBlock, "cutCompleted から抜きが呼ばれていない").toContain("cutOutHandler(");
  // Workspace 側は実抜き関数（cutOutBackground を包む cutOut）をストアへ登録していること。
  expect(
    workspace,
    "抜き関数がストアのリスナーへ登録されていない（イベントが来ても抜けない）",
  ).toContain("ensureStickerRunEventListener(cutOut)");
});

test("クロマキーに失敗しても生成物を捨てない（元パスへ退避する）", () => {
  // J4 移動先の cutout.ts で同じ契約を検査する。
  const cutout = read("src/lib/sticker/cutout.ts");
  // 1画素も抜けなかった時は元パスを返す（欠落を消さない）。
  expect(cutout).toContain("res.cleared > 0 ? res.output : imagePath");
  // 例外時も生成物を失わせず、notCleared: true で可視化して返す。
  expect(cutout).toMatch(/catch\s*\{[\s\S]*notCleared:\s*true/);
});

test("Workspace が層Aと層Bを別セクションとして描く（事実と意見の隔離）", () => {
  const workspace = read("src/components/skills/sticker/StickerWorkspace.tsx");
  expect(workspace).toContain("画像規格チェック");
  expect(workspace).toContain("審査セルフチェック");
  // 層Aの合格表示は「画像規格」に限定する（「LINEの規格」と書くと審査基準全体に読める）。
  expect(workspace).toContain("画像規格を満たしています");
  expect(workspace).not.toContain("LINEの規格を満たして");
});

test("Workspace に ?ヘルプ が設置されている（説明を本文へ常駐させない）", () => {
  const workspace = read("src/components/skills/sticker/StickerWorkspace.tsx");
  expect(workspace).toContain("<PageHelp");
  expect(workspace).toContain("PageHelp");
});
