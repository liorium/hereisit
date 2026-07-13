import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL = "https://hereisit.pages.dev";
const ROUTE_PATH = "/image/watermark";

function normalizeBaseUrl(value) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "The smoke base URL must use HTTP(S).");
  return url.origin;
}

function parseContentSecurityPolicy(value) {
  return new Map(
    value
      .split(";")
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/);
        return [name, sources];
      }),
  );
}

function assertSecurityHeaders(headers) {
  const contentSecurityPolicy = headers["content-security-policy"] ?? "";
  const directives = parseContentSecurityPolicy(contentSecurityPolicy);

  for (const [name, requiredSources] of [
    ["default-src", ["'self'"]],
    ["connect-src", ["'self'"]],
    ["worker-src", ["'self'", "blob:"]],
  ]) {
    const sources = directives.get(name) ?? [];
    for (const requiredSource of requiredSources) {
      assert.ok(
        sources.includes(requiredSource),
        `The Content Security Policy is missing ${name} ${requiredSource}.`,
      );
    }
  }

  assert.ok(
    !contentSecurityPolicy.includes("'unsafe-eval'"),
    "The Content Security Policy must not allow JavaScript evaluation.",
  );
  assert.ok(
    !contentSecurityPolicy.includes("'wasm-unsafe-eval'"),
    "The Content Security Policy must not allow WebAssembly evaluation.",
  );
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
}

async function createLocalPng(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Smoke canvas unavailable");

    context.fillStyle = "#f5f5f4";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value === null) reject(new Error("Smoke PNG encoding failed"));
        else resolve(value);
      }, "image/png");
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

async function readDownload(download) {
  const downloadPath = await download.path();
  assert.ok(downloadPath !== null, "The browser did not retain the smoke download.");
  return new Uint8Array(await readFile(downloadPath));
}

function assertPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.ok(
    signature.every((value, index) => bytes[index] === value),
    "The watermark result did not have a PNG signature.",
  );
  assert.ok(bytes.length >= 24, "The watermark PNG result was incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(
    { width: view.getUint32(16), height: view.getUint32(20) },
    { width: 320, height: 180 },
  );
}

async function assertDefaultSettings(page) {
  assert.ok(await page.getByRole("radio", { name: "문구", exact: true }).isChecked());
  assert.equal(await page.getByLabel("워터마크 문구").inputValue(), "© HereIsIt");
  assert.ok(await page.getByRole("radio", { name: "오른쪽 아래", exact: true }).isChecked());
  assert.equal(await page.getByRole("slider", { name: /문구 크기/ }).inputValue(), "12");
  assert.equal(await page.getByRole("slider", { name: /여백/ }).inputValue(), "3");
  assert.equal(await page.getByRole("slider", { name: /불투명도/ }).inputValue(), "55");
  assert.equal(await page.getByLabel("문구 색상").inputValue(), "#111827");
  assert.equal(await page.getByLabel("출력 형식").inputValue(), "source");
  assert.equal(await page.getByRole("slider", { name: /품질/ }).inputValue(), "90");
}

const baseUrl = normalizeBaseUrl(process.argv[2] ?? DEFAULT_BASE_URL);
const routeUrl = `${baseUrl}${ROUTE_PATH}`;
const browser = await chromium.launch({ headless: true });
let context;

try {
  context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });

  const directResponse = await context.request.get(routeUrl, { maxRedirects: 0 });
  assert.equal(directResponse.status(), 200, "The image watermark route did not return 200.");
  assert.equal(directResponse.url(), routeUrl, "The image watermark route redirected.");
  assertSecurityHeaders(directResponse.headers());

  const violations = [];
  let failedRequests = 0;
  context.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== baseUrl) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postData() !== null) violations.push("request-body");
    if (request.redirectedFrom() !== null) violations.push("redirect");
  });
  context.on("requestfailed", () => {
    failedRequests += 1;
  });

  const page = await context.newPage();
  let downloads = 0;
  let pageErrors = 0;
  page.on("download", () => {
    downloads += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  const routeResponse = await page.goto(routeUrl);
  assert.ok(routeResponse !== null, "The browser did not receive the image watermark route.");
  assert.equal(routeResponse.status(), 200, "The browser route request did not return 200.");
  assert.equal(routeResponse.url(), routeUrl, "The browser route request redirected.");
  assertSecurityHeaders(routeResponse.headers());
  await page
    .getByRole("button", { name: "이미지 선택" })
    .waitFor({ state: "visible", timeout: 60_000 });

  const source = await createLocalPng(page);
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });
  assert.equal(downloads, 0, "Selecting a source image started an automatic download.");
  await assertDefaultSettings(page);

  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "1개 이미지 워터마크 처리를 완료했어요." })
    .waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(downloads, 0, "Completing the watermark started an automatic download.");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 저장·공유 ↓" }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "source-watermarked-hereisit.png");
  assertPng(await readDownload(download));
  assert.equal(downloads, 1, "The explicit save did not download exactly once.");

  assert.equal(violations.length, 0, "The page made a prohibited network request.");
  assert.equal(failedRequests, 0, "A page request failed during the smoke.");
  assert.equal(pageErrors, 0, "The page raised an unhandled error during the smoke.");
} finally {
  await context?.close();
  await browser.close();
}

console.log("Image watermark smoke passed.");
