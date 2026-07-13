import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This local-only flag does not affect Turbo task outputs.
const includeWebKit = isCI || process.env.PLAYWRIGHT_WEBKIT === "1";
const imageWatermarkSpec = /image-watermark\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 15"], browserName: "chromium" },
      testMatch: [/mobile\.spec\.ts/, imageWatermarkSpec],
    },
    ...(includeWebKit
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
            testIgnore: /mobile\.spec\.ts/,
          },
          {
            name: "mobile-webkit",
            use: { ...devices["iPhone 15"] },
            testMatch: [/mobile\.spec\.ts/, imageWatermarkSpec],
          },
        ]
      : []),
  ],
  webServer: {
    command: "pnpm --filter @hereisit/web preview:test",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
