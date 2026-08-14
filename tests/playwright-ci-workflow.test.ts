import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const pdfQualityWorkflow = readFileSync(".github/workflows/pdf-quality-benchmark.yml", "utf8");
const config = readFileSync("playwright.config.ts", "utf8");
const pdfVisualSpec = readFileSync("tests/e2e/pdf-compression-visual-evidence.spec.ts", "utf8");

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
          NEXT_PUBLIC_PRODUCT_ANALYTICS_DISABLED: "1"
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

  it("runs native PDF visual evidence only on hosted desktop browsers and removes raw inputs", () => {
    for (const source of [workflow, pdfQualityWorkflow]) {
      expect(source).toContain("tests/e2e/pdf-compression-visual-evidence.spec.ts");
      expect(source).toContain("--visual-output .artifacts/pdf-visual-private");
      expect(source).toContain("create-pdf-visual-browser-evidence.mjs");
      expect(source).toContain("Remove private PDF visual inputs");
      expect(source).toContain("if: always()");
      expect(source).toContain("label=hereisit.pdf-benchmark=true");
      expect(source).not.toMatch(/upload-artifact[\s\S]{0,500}pdf-visual-private/u);
    }
    expect(workflow).toContain("create-pdf-visual-hosted-reports.mjs");
    expect(workflow).toContain("--benchmark .artifacts/pdf-visual-benchmark.json");
    expect(workflow).toContain("--gate .artifacts/pdf-visual-benchmark-gate.json");
    expect(pdfQualityWorkflow).not.toContain("create-pdf-visual-hosted-reports.mjs");
    expect(pdfQualityWorkflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(pdfQualityWorkflow).not.toContain("fullCorpusBenchmark.json");
    expect(pdfQualityWorkflow).not.toContain("deviceMatrix.json");
    const sanitizedUpload = workflow.indexOf("Upload sanitized PDF visual evidence");
    const protectedSeal = workflow.indexOf("Seal genuine exact-main hosted review receipts");
    const sanitizedReports = workflow.indexOf("Create sanitized PDF visual hosted reports");
    expect(sanitizedUpload).toBeGreaterThan(-1);
    expect(workflow.slice(sanitizedReports, sanitizedUpload)).toContain(
      "if: github.ref == 'refs/heads/main'",
    );
    expect(workflow.slice(sanitizedUpload, protectedSeal)).toContain(
      "if: github.ref == 'refs/heads/main'",
    );
    expect(protectedSeal).toBeGreaterThan(sanitizedUpload);
    expect(workflow.slice(sanitizedUpload, protectedSeal)).not.toContain(
      "PROCESSING_HOSTED_REVIEWS_READY",
    );
    expect(workflow.slice(protectedSeal)).toContain(
      "cp .artifacts/pdf-visual-benchmark.json .artifacts/hosted-check/pdf-engine-benchmark.json",
    );
    expect(workflow.slice(protectedSeal)).toContain(
      "cp .artifacts/pdf-visual-benchmark-gate.json .artifacts/hosted-check/pdf-engine-release-gate.json",
    );
    for (const project of ["chromium", "firefox", "webkit"])
      expect(pdfQualityWorkflow).toContain(`--project=${project}`);
    for (const variable of [
      "HEREISIT_PDF_VISUAL_INPUT",
      "HEREISIT_PDF_VISUAL_RECEIPTS",
      "HEREISIT_PDF_VISUAL_GIT_SHA",
      "HEREISIT_PDF_VISUAL_SOURCE_SHA256",
      "HEREISIT_PDF_VISUAL_CHECK_RUN_ID",
    ])
      expect(workflow).toContain(variable);
  });

  it("loads ESM release helpers without Playwright transpiling them as CommonJS", () => {
    expect(pdfVisualSpec).not.toMatch(/^import .*\.\.\/\.\.\/scripts\/.*\.mjs["'];$/mu);
    expect(pdfVisualSpec).toContain("import(scriptUrl(");
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
