import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-ui",
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2, // crisp screenshots on macOS
  },
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
