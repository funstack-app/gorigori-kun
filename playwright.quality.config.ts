import { defineConfig } from "@playwright/test";

/**
 * 品質回帰ハーネス (編集タブの構造回帰) 用の Playwright 設定。
 *
 * tests-ui (webServer + 実ブラウザ) と分離する理由:
 * - このハーネスはブラウザを起動しない純ロジックテストなので、chromium 未
 *   インストール環境でも必ず走る (2026-07-06 に UIテスト26件がブラウザDL失敗で
 *   全滅した環境要因と切り離す)。
 * - dev サーバも不要。`npm run test:quality` 単発で数秒で終わることを保証する。
 */
export default defineConfig({
  testDir: "./tests-quality",
  // *.spec.ts / *.test.ts は AI から編集不可の保護対象 (vault settings の deny)。
  // 品質回帰ハーネスは AI が育てる資産なので *.check.ts 命名で分離する (保護柵は迂回しない)。
  testMatch: "**/*.check.ts",
  fullyParallel: false,
  reporter: [["list"]],
});
