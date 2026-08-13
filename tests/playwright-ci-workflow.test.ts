import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const config = readFileSync("playwright.config.ts", "utf8");

describe("Playwright CI workflow", () => {
  it("runs all browser projects on the hosted runner without Docker", () => {
    expect(manifest.scripts["test:e2e:ci"]).toBe("playwright test");
    expect(manifest.scripts["verify:all"]).toBe("pnpm verify && pnpm test:processing-stack");
    expect(manifest.scripts).not.toHaveProperty("test:e2e");
    expect(manifest.scripts).not.toHaveProperty("test:e2e:ui");
    expect(manifest.scripts).not.toHaveProperty("test:e2e:webkit");

    expect(workflow).toContain("pnpm exec playwright install --with-deps chromium firefox webkit");
    for (const project of [
      "chromium",
      "firefox",
      "mobile-chromium",
      "mobile-firefox",
      "webkit",
      "mobile-webkit",
    ]) {
      expect(workflow).toContain(`--project=${project}`);
    }
    expect(workflow).toContain("--workers=1");
    expect(workflow).toContain("--output=test-results/primary");
    expect(workflow).toContain("--output=test-results/webkit");
    expect(workflow).toContain("PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/primary");
    expect(workflow).toContain("PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/webkit");
    expect(workflow).not.toContain("pnpm test:e2e:webkit");
    expect(workflow).not.toContain("test-playwright-webkit-container");
    expect(existsSync("scripts/test-playwright-webkit-container.mjs")).toBe(false);
  });

  it("builds the browser fixture with its intercepted processing origin", () => {
    expect(workflow).toContain(`- run: pnpm --filter @hereisit/web build
        env:
          ALLOW_LOCAL_PROCESSING_ORIGINS: "1"
          NEXT_PUBLIC_PROCESSING_API_ORIGIN: http://127.0.0.1:4173
      - run: pnpm exec playwright install`);
  });

  it("attempts WebKit after the first browser group and combines both statuses", () => {
    const firstGroup = workflow.indexOf("--project=mobile-firefox");
    const firstStatus = workflow.indexOf("primary_status=$?", firstGroup);
    const webkitGroup = workflow.indexOf("--project=webkit", firstStatus);
    const webkitStatus = workflow.indexOf("webkit_status=$?", webkitGroup);
    const combinedExit = workflow.indexOf(
      "if (( primary_status != 0 || webkit_status != 0 )); then",
      webkitStatus,
    );

    expect(workflow).toContain("set +e");
    expect(firstGroup).toBeGreaterThan(-1);
    expect(firstStatus).toBeGreaterThan(firstGroup);
    expect(webkitGroup).toBeGreaterThan(firstStatus);
    expect(webkitStatus).toBeGreaterThan(webkitGroup);
    expect(combinedExit).toBeGreaterThan(webkitStatus);
  });

  it("retains privacy-safe failure artifacts for each retry attempt", () => {
    expect(workflow).toContain("if: failure()");
    expect(workflow).toContain("name: playwright-failure-$" + "{{ github.run_attempt }}");
    expect(workflow).toContain("test-results/");
    expect(workflow).toContain("playwright-report/");
    expect(workflow).toContain("retention-days: 7");
  });

  it("forwards project and grep options to Playwright", () => {
    expect(workflow).not.toMatch(/pnpm test:e2e:ci --(?:\s|$)/);
  });

  it("includes WebKit only in CI and uses the normal preview server", () => {
    expect(config).toContain("const includeWebKit = isCI;");
    expect(config).not.toContain("PLAYWRIGHT_WEBKIT");
    expect(config).not.toContain("PLAYWRIGHT_CONTAINER");
    expect(config).toContain('command: "pnpm --filter @hereisit/web preview:test"');
    expect(config).toContain('["html", { open: "never" }]');
  });

  it("documents Playwright as CI-only routine verification", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const deployment = readFileSync("docs/deployment.md", "utf8");
    const productAnalytics = readFileSync("docs/deployment/product-analytics.md", "utf8");
    const checklist = readFileSync("docs/testing/discovery-accessibility-checklist.md", "utf8");

    expect(agents).toContain("Automated Playwright E2E runs in GitHub Actions only.");
    expect(agents).toContain(
      "`pnpm verify:all` — run core verification and the local processing-stack test.",
    );
    for (const document of [readme, deployment, productAnalytics, checklist]) {
      expect(document).toContain("GitHub Actions `browser` job");
      expect(document).not.toContain("PLAYWRIGHT_WEBKIT=1");
    }
    expect(productAnalytics).not.toContain("pnpm exec playwright test");
    expect(readme).not.toContain("pnpm exec playwright install --with-deps");
    expect(deployment).not.toContain("pnpm exec playwright install --with-deps");
  });
});
