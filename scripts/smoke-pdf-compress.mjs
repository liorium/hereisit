import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, rgb } from "@cantoo/pdf-lib";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL = "https://hereisit.pages.dev";
const ROUTE_PATH = "/pdf/compress";
const REQUIRED_ASSET_PATHS = [
  "/pdfjs/6.1.200/pdf.worker.min.mjs",
  "/pdfjs/6.1.200/cmaps/Adobe-Japan1-UCS2.bcmap",
  "/pdfjs/6.1.200/standard_fonts/LiberationSans-Regular.ttf",
];
const SOURCE_METADATA = {
  author: "PRIVATE_COMPRESSION_SMOKE_AUTHOR",
  creationDate: "2020-01-02T03:04:05.000Z",
  keywords: "PRIVATE_COMPRESSION_KEYWORD_ONE PRIVATE_COMPRESSION_KEYWORD_TWO",
  language: "x-private-compression-smoke",
  modificationDate: "2021-02-03T04:05:06.000Z",
  subject: "PRIVATE_COMPRESSION_SMOKE_SUBJECT",
  title: "PRIVATE_COMPRESSION_SMOKE_TITLE",
};
const SENTINELS = [
  "PRIVATE_COMPRESSION_SMOKE_SENTINEL",
  SOURCE_METADATA.title,
  SOURCE_METADATA.author,
  SOURCE_METADATA.subject,
  ...SOURCE_METADATA.keywords.split(" "),
  SOURCE_METADATA.language,
];
const BALANCED_NO_REDUCTION_MESSAGE =
  "균형 150DPI 설정으로는 파일 용량을 1% 이상 줄이지 못했어요. 최소 용량 96DPI를 시도해 보세요.";
const EXPECTED_CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; manifest-src 'self'";
const EXPECTED_PERMISSIONS_POLICY = "camera=(), geolocation=(), microphone=(), payment=(), usb=()";
const EXPECTED_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CANONICAL_SECURITY_HEADERS = {
  "content-security-policy": EXPECTED_CONTENT_SECURITY_POLICY,
  "permissions-policy": EXPECTED_PERMISSIONS_POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function normalizeBaseUrl(value) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "The smoke base URL must use HTTP(S).");
  return url.origin;
}

function assertSecurityHeaders(headers) {
  assert.equal(
    headers["content-security-policy"],
    EXPECTED_CONTENT_SECURITY_POLICY,
    "The Content Security Policy must exactly match the canonical Pages policy.",
  );
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(
    headers["permissions-policy"],
    EXPECTED_PERMISSIONS_POLICY,
    "The Permissions Policy must exactly match the canonical Pages policy.",
  );
}

function assertImmutableAssetCaching(cacheControl) {
  assert.equal(
    cacheControl,
    EXPECTED_IMMUTABLE_CACHE_CONTROL,
    "A versioned PDF.js asset must use only the canonical immutable cache policy.",
  );
}

function assertHeaderAssertionsRejectMutations() {
  const relaxedCsp = {
    ...CANONICAL_SECURITY_HEADERS,
    "content-security-policy": EXPECTED_CONTENT_SECURITY_POLICY.replace(
      "connect-src 'self'",
      "connect-src 'self' https://evil.example",
    ),
  };
  assert.throws(
    () => assertSecurityHeaders(relaxedCsp),
    "The security assertion must reject an appended CSP source.",
  );

  const extendedPermissionsPolicy = {
    ...CANONICAL_SECURITY_HEADERS,
    "permissions-policy": `${EXPECTED_PERMISSIONS_POLICY}, fullscreen=(self)`,
  };
  assert.throws(
    () => assertSecurityHeaders(extendedPermissionsPolicy),
    "The security assertion must reject an extra permissions directive.",
  );

  const changedPermissionsPolicy = {
    ...CANONICAL_SECURITY_HEADERS,
    "permissions-policy": EXPECTED_PERMISSIONS_POLICY.replace("camera=()", "camera=(self)"),
  };
  assert.throws(
    () => assertSecurityHeaders(changedPermissionsPolicy),
    "The security assertion must reject a changed permissions directive.",
  );

  assert.throws(
    () =>
      assertImmutableAssetCaching(`${EXPECTED_IMMUTABLE_CACHE_CONTROL}, stale-while-revalidate=60`),
    "The cache assertion must reject appended cache directives.",
  );
}

async function createScannedPdf(page) {
  const encodedJpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1_275;
    canvas.height = 1_650;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Smoke canvas unavailable");

    const image = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const pixel = offset / 4;
      image.data[offset] = (pixel * 17) % 256;
      image.data[offset + 1] = (pixel * 31 + Math.floor(pixel / canvas.width)) % 256;
      image.data[offset + 2] = (pixel * 47) % 256;
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/jpeg", 1).split(",")[1] ?? "";
  });

  const document = await PDFDocument.create();
  document.setTitle(SOURCE_METADATA.title);
  document.setAuthor(SOURCE_METADATA.author);
  document.setSubject(SOURCE_METADATA.subject);
  document.setKeywords(SOURCE_METADATA.keywords.split(" "));
  document.setLanguage(SOURCE_METADATA.language);
  document.setCreationDate(new Date(SOURCE_METADATA.creationDate));
  document.setModificationDate(new Date(SOURCE_METADATA.modificationDate));
  const scan = await document.embedJpg(Buffer.from(encodedJpeg, "base64"));
  for (let index = 0; index < 2; index += 1) {
    const outputPage = document.addPage([612, 792]);
    outputPage.drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });
    outputPage.drawRectangle({
      x: 0,
      y: 0,
      width: 612,
      height: 72,
      color: index === 0 ? rgb(0.9, 0.08, 0.08) : rgb(0.08, 0.12, 0.9),
    });
  }
  return Buffer.from(await document.save());
}

async function createTinyVectorPdf() {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  page.drawRectangle({ x: 72, y: 72, width: 144, height: 144, color: rgb(0.15, 0.35, 0.8) });
  return Buffer.from(await document.save());
}

async function uploadPdf(page, name, buffer, pageCount) {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer,
  });
  await page.getByText(`${pageCount}페이지 PDF를 불러왔어요.`).first().waitFor({ timeout: 60_000 });
}

function exactCompressionTarget(sourceByteLength) {
  const requiredSaving = Math.max(1, Math.ceil(sourceByteLength / 100));
  return sourceByteLength - requiredSaving;
}

function assertCompletePdfEnvelope(bytes) {
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
  let end = bytes.length - 1;
  while ([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[end] ?? -1)) end -= 1;
  assert.equal(new TextDecoder().decode(bytes.subarray(end - 4, end + 1)), "%%EOF");
}

function assertSourceSentinelsAbsent(bytes) {
  const renderedBytes = Buffer.from(bytes).toString("latin1");
  for (const sentinel of SENTINELS) {
    assert.ok(
      !renderedBytes.includes(sentinel),
      "A source metadata sentinel entered the output PDF.",
    );
  }
}

async function readDownload(download) {
  const downloadPath = await download.path();
  assert.ok(downloadPath !== null, "The browser did not retain the smoke download.");
  return new Uint8Array(await readFile(downloadPath));
}

function inspectStandardMetadata(document) {
  return {
    author: document.getAuthor(),
    creationDate: document.getCreationDate()?.toISOString(),
    creator: document.getCreator(),
    keywords: document.getKeywords(),
    language: document.getLanguage(),
    modificationDate: document.getModificationDate()?.toISOString(),
    producer: document.getProducer(),
    subject: document.getSubject(),
    title: document.getTitle(),
  };
}

async function inspectSourceMetadata(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return inspectStandardMetadata(document);
}

async function inspectPdfOutput(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const imageDimensions = document.getPages().map((page) => {
    const resources = page.node.Resources();
    assert.ok(resources !== undefined, "An output page lacked resources.");
    const xObjects = resources.lookup(PDFName.XObject, PDFDict);
    const images = xObjects.keys().flatMap((key) => {
      const object = xObjects.lookup(key);
      if (!(object instanceof PDFRawStream)) return [];
      const subtype = object.dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
      if (subtype?.toString() !== "/Image") return [];
      return [object];
    });
    assert.equal(images.length, 1, "Each output page must own exactly one image XObject.");
    const image = images[0];
    assert.ok(image !== undefined, "An output page image was unavailable.");
    return {
      width: image.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber(),
      height: image.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber(),
    };
  });

  return {
    ...inspectStandardMetadata(document),
    imageDimensions,
    pageGeometry: document.getPages().map((page) => ({
      width: page.getWidth(),
      height: page.getHeight(),
      rotation: page.getRotation().angle,
    })),
  };
}

async function inspectPageMarkerColors(page, bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const encodedImages = document.getPages().map((outputPage) => {
    const resources = outputPage.node.Resources();
    assert.ok(resources !== undefined, "An output page lacked resources.");
    const xObjects = resources.lookup(PDFName.XObject, PDFDict);
    const imageKey = xObjects.keys()[0];
    assert.ok(imageKey !== undefined, "An output page image was unavailable.");
    const image = xObjects.lookup(imageKey, PDFRawStream);
    return Buffer.from(image.getContents()).toString("base64");
  });

  return page.evaluate(async (images) => {
    const colors = [];
    for (const encoded of images) {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Marker canvas unavailable");
      context.drawImage(
        image,
        Math.floor(image.naturalWidth / 2),
        Math.floor(image.naturalHeight * 0.95),
        1,
        1,
        0,
        0,
        1,
        1,
      );
      const pixel = context.getImageData(0, 0, 1, 1).data;
      colors.push({ red: pixel[0] ?? 0, green: pixel[1] ?? 0, blue: pixel[2] ?? 0 });
    }
    return colors;
  }, encodedImages);
}

function assertPageMarkerOrder(colors) {
  assert.equal(colors.length, 2);
  assert.ok((colors[0]?.red ?? 0) - (colors[0]?.blue ?? 0) > 100);
  assert.ok((colors[1]?.blue ?? 0) - (colors[1]?.red ?? 0) > 100);
}

async function createdObjectUrlCount(page) {
  return page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedUrls") ?? "0"));
}

async function saveResult(page, expectedDownloadCount, downloadCount) {
  assert.equal(downloadCount(), expectedDownloadCount - 1, "A result downloaded automatically.");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  assert.equal(
    downloadCount(),
    expectedDownloadCount,
    "An explicit save did not download exactly once.",
  );
  return readDownload(download);
}

function assertCompressionResult(source, candidate, expectedImageDimensions) {
  assertCompletePdfEnvelope(candidate);
  assertSourceSentinelsAbsent(candidate);
  assert.ok(
    candidate.byteLength <= exactCompressionTarget(source.byteLength),
    "The result did not satisfy the exact source-relative 1% target.",
  );
  assert.notEqual(
    candidate.byteLength,
    source.byteLength,
    "The result must not equal the source size.",
  );
  return inspectPdfOutput(candidate).then((inspection) => {
    assert.deepEqual(inspection, {
      author: undefined,
      creationDate: undefined,
      creator: "HereIsIt",
      imageDimensions: [expectedImageDimensions, expectedImageDimensions],
      keywords: undefined,
      language: undefined,
      modificationDate: undefined,
      pageGeometry: [
        { width: 612, height: 792, rotation: 0 },
        { width: 612, height: 792, rotation: 0 },
      ],
      producer: "HereIsIt",
      subject: undefined,
      title: undefined,
    });
  });
}

const baseUrl = normalizeBaseUrl(process.argv[2] ?? DEFAULT_BASE_URL);
assertHeaderAssertionsRejectMutations();
const browser = await chromium.launch({ headless: true });
let context;

try {
  context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    sessionStorage.setItem("__hereisitCreatedUrls", "0");
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () => {
        throw new Error("navigator.share must not be called");
      },
    });
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const count = Number(sessionStorage.getItem("__hereisitCreatedUrls") ?? "0");
      sessionStorage.setItem("__hereisitCreatedUrls", String(count + 1));
      return originalCreateObjectUrl(object);
    };
  });

  for (const resourcePath of [ROUTE_PATH, ...REQUIRED_ASSET_PATHS]) {
    const expectedUrl = `${baseUrl}${resourcePath}`;
    const response = await context.request.get(expectedUrl, { maxRedirects: 0 });
    assert.equal(response.status(), 200, `A required public resource failed: ${resourcePath}`);
    assert.equal(response.url(), expectedUrl, "A required resource redirected or changed origin.");
    assertSecurityHeaders(response.headers());
    if (resourcePath !== ROUTE_PATH) {
      assertImmutableAssetCaching(response.headers()["cache-control"] ?? "");
    }
  }

  const violations = [];
  let consoleMessages = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  context.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== baseUrl) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postData() !== null) violations.push("request-body");
    if (request.redirectedFrom() !== null) violations.push("redirect");
    if (target.pathname.startsWith("/pdfjs/") && !target.pathname.startsWith("/pdfjs/6.1.200/")) {
      violations.push("unpinned-pdfjs");
    }
    if (SENTINELS.some((sentinel) => decodeURIComponent(request.url()).includes(sentinel))) {
      violations.push("sentinel-request");
    }
  });
  context.on("console", () => {
    consoleMessages += 1;
  });
  context.on("requestfailed", () => {
    failedRequests += 1;
  });

  const page = await context.newPage();
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  const routeResponse = await page.goto(`${baseUrl}${ROUTE_PATH}`);
  assert.ok(
    routeResponse !== null && routeResponse.status() === 200,
    "The smoke route did not load.",
  );
  assert.equal(routeResponse.url(), `${baseUrl}${ROUTE_PATH}`, "The smoke route redirected.");
  assertSecurityHeaders(routeResponse.headers());
  await page
    .getByRole("button", { name: "PDF 선택" })
    .waitFor({ state: "visible", timeout: 60_000 });
  assert.ok(await page.getByRole("button", { name: "PDF 선택" }).isEnabled());

  const source = await createScannedPdf(page);
  assert.deepEqual(await inspectSourceMetadata(source), {
    ...SOURCE_METADATA,
    creator: "pdf-lib (https://github.com/Hopding/pdf-lib)",
    producer: "pdf-lib (https://github.com/Hopding/pdf-lib)",
  });
  await uploadPdf(page, `${SENTINELS[0]}.pdf`, source, 2);
  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await page.getByText("압축 PDF 준비 완료").waitFor({ timeout: 60_000 });
  assert.equal(await createdObjectUrlCount(page), 1);
  const balanced = await saveResult(page, 1, () => downloads);
  await assertCompressionResult(source, balanced, { width: 1_275, height: 1_650 });
  assertPageMarkerOrder(await inspectPageMarkerColors(page, balanced));

  await page.getByRole("button", { name: "새 작업" }).click();
  await uploadPdf(page, `${SENTINELS[0]}.pdf`, source, 2);
  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await page.getByText("압축 PDF 준비 완료").waitFor({ timeout: 60_000 });
  assert.equal(await createdObjectUrlCount(page), 2);
  const minimum = await saveResult(page, 2, () => downloads);
  await assertCompressionResult(source, minimum, { width: 816, height: 1_056 });
  assertPageMarkerOrder(await inspectPageMarkerColors(page, minimum));
  assert.ok(minimum.byteLength < balanced.byteLength, "Minimum must be smaller than balanced.");

  await page.getByRole("button", { name: "새 작업" }).click();
  await uploadPdf(page, `${SENTINELS[0]}.pdf`, await createTinyVectorPdf(), 1);
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await page.getByText(BALANCED_NO_REDUCTION_MESSAGE).first().waitFor({ timeout: 60_000 });
  assert.equal(await page.getByRole("button", { name: "PDF 다운로드 ↓" }).count(), 0);
  assert.equal(await createdObjectUrlCount(page), 2, "No-reduction must not create a result URL.");
  assert.equal(downloads, 2, "The no-reduction result must not download.");

  assert.deepEqual(violations, []);
  assert.equal(consoleMessages, 0, "The page wrote to the console during the smoke.");
  assert.equal(failedRequests, 0);
  assert.equal(pageErrors, 0);
} finally {
  await context?.close();
  await browser.close();
}

console.log("Scanned PDF compression smoke passed.");
