import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { degrees, PDFDocument, rgb } from "@cantoo/pdf-lib";
import { chromium } from "@playwright/test";
import { unzipSync } from "fflate";

const DEFAULT_BASE_URL = "https://hereisit.pages.dev";
const ROUTE_PATH = "/pdf/to-image";
const REQUIRED_ASSET_PATHS = [
  "/pdfjs/6.1.200/pdf.worker.min.mjs",
  "/pdfjs/6.1.200/cmaps/Adobe-Japan1-UCS2.bcmap",
  "/pdfjs/6.1.200/standard_fonts/LiberationSans-Regular.ttf",
];

function normalizeBaseUrl(value) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "The smoke base URL must use HTTP(S).");
  return url.origin;
}

async function createVectorPdf(pages) {
  const document = await PDFDocument.create();
  for (const [index, pageSpec] of pages.entries()) {
    const page = document.addPage([pageSpec.width, pageSpec.height]);
    if (pageSpec.rotation === 90) page.setRotation(degrees(90));
    page.drawRectangle({
      x: 36,
      y: 36,
      width: pageSpec.width - 72,
      height: pageSpec.height - 72,
      color: rgb(index === 0 ? 0.15 : 0.75, 0.35, index === 0 ? 0.8 : 0.2),
    });
  }
  return Buffer.from(await document.save());
}

async function readDownload(download) {
  const downloadPath = await download.path();
  assert.ok(downloadPath !== null, "The browser did not retain the smoke download.");
  return new Uint8Array(await readFile(downloadPath));
}

function readPngDimensions(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.ok(
    signature.every((value, index) => bytes[index] === value),
    "The direct result did not have a PNG signature.",
  );
  assert.ok(bytes.length >= 24, "The direct PNG result was incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes) {
  assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8, "A ZIP entry lacked a JPEG signature.");
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += segmentLength;
  }
  assert.fail("JPEG dimensions were not found in a ZIP entry.");
}

function assertSecurityHeaders(headers) {
  const contentSecurityPolicy = headers["content-security-policy"] ?? "";
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  assert.match(contentSecurityPolicy, /connect-src 'self'/);
  assert.match(contentSecurityPolicy, /worker-src 'self' blob:/);
  assert.ok(
    !contentSecurityPolicy.includes("'unsafe-eval'") &&
      !contentSecurityPolicy.includes("'wasm-unsafe-eval'"),
    "The security policy must not allow JavaScript or WebAssembly evaluation.",
  );
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
  const permissionsPolicy = headers["permissions-policy"] ?? "";
  for (const directive of ["camera=()", "geolocation=()", "microphone=()", "payment=()", "usb=()"])
    assert.ok(permissionsPolicy.includes(directive), "A required permissions policy is missing.");
}

async function waitForInspection(page) {
  await page.getByText("2페이지 PDF를 불러왔어요.").waitFor({ timeout: 60_000 });
}

async function runDirectPngSmoke(page) {
  const source = await createVectorPdf([
    { width: 612, height: 792 },
    { width: 612, height: 792, rotation: 90 },
  ]);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: source,
  });
  await waitForInspection(page);

  await page
    .getByRole("group", { name: "변환할 페이지" })
    .getByRole("radio", { name: /지정 페이지/ })
    .check();
  await page.getByLabel("페이지 범위", { exact: true }).fill("2");
  await page.getByRole("group", { name: "출력 형식" }).getByRole("radio", { name: "PNG" }).check();
  await page.getByRole("group", { name: "해상도" }).getByRole("radio", { name: "96DPI" }).check();
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await page.getByText("이미지 1개 준비 완료").waitFor({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이미지 다운로드 ↓" }).click(),
  ]);
  assert.ok(
    download.suggestedFilename() === "report-page-002.png",
    "The direct PNG download name was incorrect.",
  );
  assert.deepEqual(readPngDimensions(await readDownload(download)), { width: 1056, height: 816 });
}

async function runDefaultJpegZipSmoke(page) {
  await page.getByRole("button", { name: "새 작업" }).click();
  const source = await createVectorPdf([
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ]);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: source,
  });
  await waitForInspection(page);
  await page.getByRole("button", { name: "2페이지 이미지로 변환하기 →" }).click();
  await page.getByText("이미지 2개 ZIP 준비 완료").waitFor({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" }).click(),
  ]);
  assert.ok(
    download.suggestedFilename() === "report-images-hereisit.zip",
    "The multi-page ZIP download name was incorrect.",
  );

  const archive = unzipSync(await readDownload(download));
  const expectedNames = ["report-page-001.jpg", "report-page-002.jpg"];
  assert.ok(
    JSON.stringify(Object.keys(archive)) === JSON.stringify(expectedNames),
    "The ZIP entry order or names were incorrect.",
  );
  for (const expectedName of expectedNames) {
    const image = archive[expectedName];
    assert.ok(image !== undefined, "An expected JPEG ZIP entry was missing.");
    assert.deepEqual(readJpegDimensions(image), { width: 1275, height: 1650 });
  }
}

const baseUrl = normalizeBaseUrl(process.argv[2] ?? DEFAULT_BASE_URL);
const browser = await chromium.launch({ headless: true });
let context;

try {
  context = await browser.newContext({ acceptDownloads: true });
  for (const assetPath of REQUIRED_ASSET_PATHS) {
    const expectedUrl = `${baseUrl}${assetPath}`;
    const response = await context.request.get(expectedUrl, { maxRedirects: 0 });
    assert.ok(response.status() === 200, `Required public asset failed: ${assetPath}`);
    assert.equal(
      response.url(),
      expectedUrl,
      "A required asset must remain on the selected origin.",
    );
    assertSecurityHeaders(response.headers());
    assert.match(
      response.headers()["cache-control"] ?? "",
      /(?:^|,)\s*public\s*,.*max-age=31536000.*immutable/i,
      "A versioned PDF.js asset must have immutable caching.",
    );
  }

  const page = await context.newPage();
  const violations = [];
  let failedRequests = 0;
  let pageErrors = 0;
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== baseUrl) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postData() !== null) violations.push("request-body");
  });
  page.on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  const routeResponse = await page.goto(`${baseUrl}${ROUTE_PATH}`);
  assert.ok(
    routeResponse !== null && routeResponse.status() === 200,
    "The smoke route did not load.",
  );
  assertSecurityHeaders(routeResponse.headers());

  await runDirectPngSmoke(page);
  await runDefaultJpegZipSmoke(page);

  assert.deepEqual(violations, []);
  assert.equal(failedRequests, 0);
  assert.equal(pageErrors, 0);
} finally {
  await context?.close();
  await browser.close();
}

console.log("PDF-to-images smoke passed.");
