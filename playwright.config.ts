import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 15_000,
  fullyParallel: false,
  use: {
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {})
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "node tests/e2e/server.mjs 4173",
      url: "http://127.0.0.1:4173/tests/e2e/fixtures/host.html",
      reuseExistingServer: true
    },
    {
      command: "node tests/e2e/server.mjs 4174",
      url: "http://127.0.0.1:4174/tests/e2e/fixtures/child.html",
      reuseExistingServer: true
    }
  ]
});
