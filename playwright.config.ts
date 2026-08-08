import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This local-only flag does not affect Turbo task outputs.
const includeWebKit = process.env.PLAYWRIGHT_WEBKIT === "1";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This flag only selects the container-safe preview command.
const isContainer = process.env.PLAYWRIGHT_CONTAINER === "1";
const imageWatermarkSpec = /image-watermark\.spec\.ts/;
const imageCompressionServerSpec = /image-compression-server\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/e2e",
  failOnFlakyTests: isCI,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Two workers fit the 4-vCPU hosted runner while keeping the six-project matrix deterministic.
  workers: isCI ? 2 : undefined,
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
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
      testMatch: [/mobile\.spec\.ts/, imageWatermarkSpec, imageCompressionServerSpec],
    },
    {
      name: "mobile-firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 390, height: 844 },
        screen: { width: 390, height: 844 },
        hasTouch: true,
      },
      testMatch: /mobile\.spec\.ts/,
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
            testMatch: [/mobile\.spec\.ts/, imageWatermarkSpec, imageCompressionServerSpec],
          },
        ]
      : []),
  ],
  webServer: {
    command: isContainer
      ? "node ../../node_modules/wrangler/bin/wrangler.js pages dev out --ip 127.0.0.1 --port 4173 --compatibility-date=2026-07-10 --log-level warn --show-interactive-dev-session=false"
      : "pnpm --filter @hereisit/web preview:test",
    ...(isContainer ? { cwd: "apps/web" } : {}),
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
