import { readFile } from "node:fs/promises";
import { degrees, PDFDocument, rgb } from "@cantoo/pdf-lib";
import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";

const PDF_TO_IMAGES_ROUTE = "/pdf/to-image";
const PDF_INSPECTION_TIMEOUT_MS = 60_000;
const LOCAL_PAGES_ORIGIN = "http://127.0.0.1:4173";

async function scanLoadedJavaScriptMarkers(
  page: Page,
  requestUrls: readonly string[],
  markers: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const requestUrl of requestUrls) {
    try {
      const requested = new URL(requestUrl);
      if (requested.origin !== LOCAL_PAGES_ORIGIN || !requested.pathname.endsWith(".js")) {
        throw new Error("Unexpected JavaScript response identity");
      }
      const response = await page.context().request.get(requestUrl, {
        headers: { "Accept-Encoding": "identity" },
        maxRedirects: 0,
      });
      if (
        response.status() !== 200 ||
        response.url() !== requestUrl ||
        new URL(response.url()).origin !== LOCAL_PAGES_ORIGIN
      ) {
        throw new Error("Unexpected JavaScript refetch response");
      }
      const body = await response.text();
      for (const marker of markers) {
        if (body.includes(marker)) found.add(marker);
      }
    } catch {
      throw new Error("Loaded JavaScript isolation scan failed");
    }
  }
  return found;
}

async function openReadyPdfToImages(page: Page): Promise<void> {
  await page.goto(PDF_TO_IMAGES_ROUTE);
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({
    timeout: 60_000,
  });
}

async function createVectorPdf(
  pages: readonly { width: number; height: number; rotation?: 90 }[],
): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (const [index, pageSpec] of pages.entries()) {
    const page = document.addPage([pageSpec.width, pageSpec.height]);
    if (pageSpec.rotation === 90) page.setRotation(degrees(90));
    page.drawRectangle({
      x: 36 + index,
      y: 36 + index,
      width: Math.max(1, pageSpec.width - 72),
      height: Math.max(1, pageSpec.height - 72),
      color: rgb(index === 0 ? 0.15 : 0.75, 0.35, index === 0 ? 0.8 : 0.2),
    });
  }
  return Buffer.from(await document.save());
}

async function createBlankPdf(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([72, 72]);
  return Buffer.from(await document.save());
}

async function createMultiImagePdf(page: Page): Promise<Buffer> {
  const encodedImages = await page.evaluate(async () => {
    const encode = async (fillStyle: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 2_048;
      canvas.height = 2_048;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Test canvas unavailable");
      context.fillStyle = fillStyle;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (value) => (value === null ? reject(new Error("JPEG encode failed")) : resolve(value)),
          "image/jpeg",
          0.85,
        );
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    return await Promise.all([encode("#2855d9"), encode("#f4c542")]);
  });

  const document = await PDFDocument.create();
  const outputPage = document.addPage([612, 792]);
  const top = await document.embedJpg(Buffer.from(encodedImages[0] ?? "", "base64"));
  const bottom = await document.embedJpg(Buffer.from(encodedImages[1] ?? "", "base64"));
  outputPage.drawImage(top, { x: 0, y: 396, width: 612, height: 396 });
  outputPage.drawImage(bottom, { x: 0, y: 0, width: 612, height: 396 });
  return Buffer.from(await document.save());
}

async function downloadedBytes(downloadPath: string | null): Promise<Uint8Array> {
  expect(downloadPath).not.toBeNull();
  return new Uint8Array(await readFile(downloadPath as string));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

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

    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      return {
        height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
        width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
      };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions were not found");
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect(signature.every((byte, index) => bytes[index] === byte)).toBe(true);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function forceDownloadFallback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  });
}

async function observePrivateConversion(page: Page) {
  const origin = new URL(page.url()).origin;
  const violations: string[] = [];
  let parserWorkerRequests = 0;
  let failedRequests = 0;
  let pageErrors = 0;

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postData() !== null) violations.push("request-body");
    if (url.pathname.startsWith("/pdfjs/") && !url.pathname.startsWith("/pdfjs/6.1.200/")) {
      violations.push("unpinned-pdfjs");
    }
    if (url.pathname === "/pdfjs/6.1.200/pdf.worker.min.mjs") parserWorkerRequests += 1;
    await route.continue();
  });
  page.context().on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  return {
    assertClean(requireParserWorker = true) {
      expect(violations).toEqual([]);
      expect(failedRequests).toBe(0);
      expect(pageErrors).toBe(0);
      if (requireParserWorker) expect(parserWorkerRequests).toBeGreaterThan(0);
    },
  };
}

async function installPendingShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const controlledWindow = window as Window & {
      __hereisitResolveShare?: () => void;
      __hereisitRejectShare?: () => void;
    };
    sessionStorage.setItem("__hereisitDownloadClicks", "0");
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: () =>
        new Promise<void>((resolve, reject) => {
          controlledWindow.__hereisitResolveShare = resolve;
          controlledWindow.__hereisitRejectShare = () => reject(new Error("share failed"));
        }),
    });

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download.length > 0) {
        const count = Number(sessionStorage.getItem("__hereisitDownloadClicks") ?? "0");
        sessionStorage.setItem("__hereisitDownloadClicks", String(count + 1));
        return;
      }
      originalClick.call(this);
    };
  });
}

async function installObjectUrlCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem("__hereisitCreatedUrls", "0");
    sessionStorage.setItem("__hereisitRevokedUrls", "0");
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const count = Number(sessionStorage.getItem("__hereisitCreatedUrls") ?? "0");
      sessionStorage.setItem("__hereisitCreatedUrls", String(count + 1));
      return originalCreate(object);
    };
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      const count = Number(sessionStorage.getItem("__hereisitRevokedUrls") ?? "0");
      sessionStorage.setItem("__hereisitRevokedUrls", String(count + 1));
      originalRevoke(url);
    };
  });
}

async function objectUrlCounts(page: Page): Promise<{ created: number; revoked: number }> {
  return page.evaluate(() => ({
    created: Number(sessionStorage.getItem("__hereisitCreatedUrls") ?? "0"),
    revoked: Number(sessionStorage.getItem("__hereisitRevokedUrls") ?? "0"),
  }));
}

async function prepareSinglePageResult(page: Page) {
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([{ width: 72, height: 72 }]),
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible({ timeout: 60_000 });
  return privacy;
}

async function settleRenderedState(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("converts two vector pages to an ordered default JPG ZIP without uploads", async ({
  browserName,
  page,
}) => {
  await forceDownloadFallback(page);
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const pdf = await createVectorPdf([
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ]);

  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(page.getByText("2페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "2페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 2개 ZIP 준비 완료")).toBeVisible({ timeout: 60_000 });
  await settleRenderedState(page);
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" }).click(),
  ]);
  expect(download.suggestedFilename() === "report-images-hereisit.zip").toBe(true);
  const archive = unzipSync(await downloadedBytes(await download.path()));
  expect(
    JSON.stringify(Object.keys(archive)) ===
      JSON.stringify(["report-page-001.jpg", "report-page-002.jpg"]),
  ).toBe(true);
  for (const name of ["report-page-001.jpg", "report-page-002.jpg"] as const) {
    const image = archive[name];
    expect(image).toBeDefined();
    expect(image?.[0]).toBe(0xff);
    expect(image?.[1]).toBe(0xd8);
    expect(jpegDimensions(image as Uint8Array)).toEqual({ width: 1275, height: 1650 });
  }
  privacy.assertClean(browserName !== "firefox");
});

test("keeps explicitly selected pages in source selection order inside the ZIP", async ({
  page,
}) => {
  await forceDownloadFallback(page);
  await openReadyPdfToImages(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([
      { width: 72, height: 72 },
      { width: 72, height: 72 },
    ]),
  });
  await expect(page.getByText("2페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page
    .getByRole("group", { name: "변환할 페이지" })
    .getByRole("radio", { name: /지정 페이지/ })
    .check();
  await page.getByLabel("페이지 범위").fill("2, 1");
  await page.getByRole("button", { name: "2페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 2개 ZIP 준비 완료")).toBeVisible({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" }).click(),
  ]);
  const archive = unzipSync(await downloadedBytes(await download.path()));
  expect(Object.keys(archive)).toEqual(["report-page-002.jpg", "report-page-001.jpg"]);
});

test("renders a page containing multiple embedded image XObjects", async ({
  browserName,
  page,
}) => {
  const pdf = await createMultiImagePdf(page);
  await forceDownloadFallback(page);
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.getByRole("group", { name: "출력 형식" }).getByRole("radio", { name: "PNG" }).check();
  await page.getByRole("group", { name: "해상도" }).getByRole("radio", { name: "96DPI" }).check();
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이미지 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("report-page-001.png");
  const imageBytes = await downloadedBytes(await download.path());
  expect(pngDimensions(imageBytes)).toEqual({
    width: 816,
    height: 1056,
  });
  const [topPixel, bottomPixel] = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Result sampling canvas unavailable");
      context.drawImage(image, 0, 0);
      const sample = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
      return [
        sample(Math.floor(canvas.width / 2), Math.floor(canvas.height / 4)),
        sample(Math.floor(canvas.width / 2), Math.floor((canvas.height * 3) / 4)),
      ];
    } finally {
      URL.revokeObjectURL(url);
    }
  }, Array.from(imageBytes));
  expect((topPixel?.[2] ?? 0) - (topPixel?.[0] ?? 0)).toBeGreaterThan(80);
  expect((topPixel?.[2] ?? 0) - (topPixel?.[1] ?? 0)).toBeGreaterThan(60);
  expect((bottomPixel?.[0] ?? 0) - (bottomPixel?.[2] ?? 0)).toBeGreaterThan(100);
  expect((bottomPixel?.[1] ?? 0) - (bottomPixel?.[2] ?? 0)).toBeGreaterThan(70);
  privacy.assertClean(browserName !== "firefox");
});

test("converts only a rotated second page to a direct 96DPI PNG", async ({ browserName, page }) => {
  await forceDownloadFallback(page);
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const pdf = await createVectorPdf([
    { width: 612, height: 792 },
    { width: 612, height: 792, rotation: 90 },
  ]);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(page.getByText("2페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });

  const quality = page.getByRole("slider", { name: "JPG 품질 85" });
  await expect(quality).toBeVisible();
  await expect(quality).toHaveAttribute("min", "40");
  await expect(quality).toHaveAttribute("max", "95");
  await expect(quality).toHaveAttribute("step", "1");
  await page.getByRole("group", { name: "출력 형식" }).getByRole("radio", { name: "PNG" }).check();
  await expect(page.getByRole("group", { name: /JPG 품질/ })).toHaveCount(0);
  await page.getByRole("group", { name: "해상도" }).getByRole("radio", { name: "96DPI" }).check();
  await page
    .getByRole("group", { name: "변환할 페이지" })
    .getByRole("radio", { name: /지정 페이지/ })
    .check();

  const range = page.getByLabel("페이지 범위");
  const run = page.getByRole("button", { name: "PDF를 이미지로 변환하기 →" });
  await range.fill("2-");
  await expect(run).toBeDisabled();
  await expect(page.getByText("예: 1-3, 5, 8-10 형식으로 입력해 주세요.").first()).toBeVisible();
  await range.fill("3");
  await expect(run).toBeDisabled();
  await expect(page.getByText("이 PDF는 2페이지까지 있어요.").first()).toBeVisible();
  await range.fill("2");
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible({ timeout: 60_000 });
  await settleRenderedState(page);
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이미지 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename() === "report-page-002.png").toBe(true);
  const image = await downloadedBytes(await download.path());
  expect(pngDimensions(image)).toEqual({ width: 1056, height: 816 });
  privacy.assertClean(browserName !== "firefox");
});

test("blocks every-page and extracted outputs above the 100-page cap", async ({ page }) => {
  await openReadyPdfToImages(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createBlankPdf(101),
  });
  await expect(page.getByText("101페이지 · 썸네일 없이 크기만 확인했어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  const correctiveCopy = "한 번에 최대 100페이지까지 이미지로 변환할 수 있어요.";
  await expect(page.getByText(correctiveCopy).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF를 이미지로 변환하기 →" })).toBeDisabled();

  await page
    .getByRole("group", { name: "변환할 페이지" })
    .getByRole("radio", { name: /지정 페이지/ })
    .check();
  await page.getByLabel("페이지 범위").fill("1-101");
  await expect(page.getByText(correctiveCopy).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF를 이미지로 변환하기 →" })).toBeDisabled();
});

test("reports count-based rendering and encoding progress", async ({ browserName, page }) => {
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]),
  });
  await expect(page.getByText("2페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.evaluate(() => {
    const progress = document.querySelector('[role="progressbar"]');
    const observedWindow = window as Window & { __hereisitProgressLabels?: string[] };
    observedWindow.__hereisitProgressLabels = [];
    if (progress === null) throw new Error("Progress element unavailable");
    const record = () => {
      const label = progress.getAttribute("aria-valuetext");
      if (label !== null) observedWindow.__hereisitProgressLabels?.push(label);
    };
    new MutationObserver(record).observe(progress, {
      attributes: true,
      attributeFilter: ["aria-valuetext"],
    });
    record();
  });

  await page.getByRole("button", { name: "2페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 2개 ZIP 준비 완료")).toBeVisible({ timeout: 60_000 });
  const labels = await page.evaluate(
    () =>
      (window as Window & { __hereisitProgressLabels?: string[] }).__hereisitProgressLabels ?? [],
  );
  expect(labels).toContain("1/2페이지 렌더링 중");
  expect(labels).toContain("1/2페이지 인코딩 중");
  privacy.assertClean(browserName !== "firefox");
});

test("cancels before a result or download is offered", async ({ page }) => {
  await openReadyPdfToImages(page);
  const privacy = await observePrivateConversion(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]),
  });
  await expect(page.getByText("2페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.evaluate(() => {
    const originalAnimationFrame = window.requestAnimationFrame.bind(window);
    const pendingFrames: FrameRequestCallback[] = [];
    const controlledWindow = window as Window & { __hereisitReleaseFrames?: () => void };
    window.requestAnimationFrame = (callback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    };
    controlledWindow.__hereisitReleaseFrames = () => {
      window.requestAnimationFrame = originalAnimationFrame;
      for (const callback of pendingFrames) originalAnimationFrame(callback);
      pendingFrames.length = 0;
    };
  });
  await page.getByRole("button", { name: "2페이지 이미지로 변환하기 →" }).click();
  await page.getByRole("button", { name: "작업 중단" }).click();
  await page.evaluate(() => {
    (window as Window & { __hereisitReleaseFrames?: () => void }).__hereisitReleaseFrames?.();
  });
  await settleRenderedState(page);
  await expect(page.getByText("이미지 변환을 중단했어요.").first()).toBeVisible();
  await expect(page.getByText(/이미지 \d+개.*준비 완료/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /저장·공유|ZIP으로 받기/ })).toHaveCount(0);
  expect(downloadCount).toBe(0);
  privacy.assertClean(false);
});

test("revokes result object URLs on settings, rerun, replacement, reset, and unmount", async ({
  browserName,
  page,
}) => {
  await installObjectUrlCounters(page);
  const privacy = await prepareSinglePageResult(page);
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });

  await page.getByRole("group", { name: "해상도" }).getByRole("radio", { name: "96DPI" }).check();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 2, revoked: 1 });

  await page.getByRole("button", { name: "같은 설정으로 다시 실행" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 3, revoked: 2 });
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible();

  await page.locator("input[type=file]").setInputFiles({
    name: "replacement.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([{ width: 72, height: 72 }]),
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 3, revoked: 3 });
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 4, revoked: 3 });

  await page.getByRole("button", { name: "새 작업" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 4, revoked: 4 });
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([{ width: 72, height: 72 }]),
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.")).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 5, revoked: 4 });

  await page.evaluate(() => {
    const nextWindow = window as Window & {
      next?: { router?: { push: (path: string) => void } };
    };
    const router = nextWindow.next?.router;
    if (router === undefined) throw new Error("Next router unavailable");
    router.push("/pdf/merge");
  });
  await expect(page.getByRole("heading", { level: 1, name: "PDF 합치기" })).toBeVisible();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 5, revoked: 5 });
  privacy.assertClean(browserName !== "firefox");
});

test("keeps PDF.js and both raster runtimes off image and PDF editing routes", async ({ page }) => {
  const routes = [
    ["/image/compress", "이미지 용량 줄이기"],
    ["/image/resize", "이미지 크기 조절"],
    ["/image/convert", "이미지 형식 변환"],
    ["/pdf/merge", "PDF 합치기"],
    ["/pdf/split", "PDF 페이지 분할"],
    ["/pdf/image-to-pdf", "이미지를 PDF로 변환"],
    ["/pdf/organize", "PDF 페이지 정리"],
    ["/pdf/watermark", "PDF 워터마크 넣기"],
  ] as const;
  let pdfjsRequests = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  const loadedJavaScriptUrls = new Set<string>();
  const scannedJavaScriptUrls = new Set<string>();
  const forbiddenMarkers = [
    "hereisit-pdf-to-images-worker",
    "hereisit-pdf-compress-scanned-worker",
  ] as const;
  const loadedForbiddenMarkers = new Set<string>();

  page.context().on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/pdfjs/")) pdfjsRequests += 1;
  });
  page.context().on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== LOCAL_PAGES_ORIGIN || !url.pathname.endsWith(".js")) return;
    loadedJavaScriptUrls.add(response.url());
  });
  page.context().on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  for (const [path, title] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await settleRenderedState(page);
    const newJavaScriptUrls = [...loadedJavaScriptUrls].filter(
      (requestUrl) => !scannedJavaScriptUrls.has(requestUrl),
    );
    const routeMarkers = await scanLoadedJavaScriptMarkers(
      page,
      newJavaScriptUrls,
      forbiddenMarkers,
    );
    for (const marker of routeMarkers) loadedForbiddenMarkers.add(marker);
    for (const requestUrl of newJavaScriptUrls) scannedJavaScriptUrls.add(requestUrl);
  }
  expect(pdfjsRequests).toBe(0);
  expect([...loadedForbiddenMarkers]).toEqual([]);
  expect(failedRequests).toBe(0);
  expect(pageErrors).toBe(0);
});

test("loads only each raster route's inspection and dedicated Worker markers", async ({ page }) => {
  const routes = [
    {
      path: "/pdf/to-image",
      title: "PDF를 JPG·PNG로 변환",
      required: ["hereisit-pdf-inspection-worker", "hereisit-pdf-to-images-worker"],
      forbidden: ["hereisit-pdf-worker", "hereisit-pdf-compress-scanned-worker"],
    },
    {
      path: "/pdf/compress",
      title: "스캔 PDF 용량 줄이기",
      required: ["hereisit-pdf-inspection-worker", "hereisit-pdf-compress-scanned-worker"],
      forbidden: ["hereisit-pdf-worker", "hereisit-pdf-to-images-worker"],
    },
  ] as const;

  for (const route of routes) {
    const loadedJavaScriptUrls = new Set<string>();
    const pdfjsRequests: string[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      if (new URL(request.url()).pathname.startsWith("/pdfjs/")) pdfjsRequests.push(request.url());
    };
    const onResponse = (response: import("@playwright/test").Response) => {
      const url = new URL(response.url());
      if (url.origin !== LOCAL_PAGES_ORIGIN || !url.pathname.endsWith(".js")) return;
      loadedJavaScriptUrls.add(response.url());
    };
    page.on("request", onRequest);
    page.on("response", onResponse);

    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1, name: route.title })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await settleRenderedState(page);
    const routeMarkers = await scanLoadedJavaScriptMarkers(
      page,
      [...loadedJavaScriptUrls],
      [...route.required, ...route.forbidden],
    );
    for (const marker of route.required) expect(routeMarkers.has(marker)).toBe(true);
    for (const marker of route.forbidden) expect(routeMarkers.has(marker)).toBe(false);
    for (const requestUrl of pdfjsRequests) {
      const url = new URL(requestUrl);
      expect(url.origin).toBe(LOCAL_PAGES_ORIGIN);
      expect(url.pathname.startsWith("/pdfjs/6.1.200/")).toBe(true);
    }

    page.off("request", onRequest);
    page.off("response", onResponse);
  }
});

test("ignores a fulfilled share after reset invalidates its result URL", async ({
  browserName,
  page,
}) => {
  await installPendingShare(page);
  const privacy = await prepareSinglePageResult(page);

  await page.getByRole("button", { name: "이미지 저장·공유 ↓" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as Window & { __hereisitResolveShare?: () => void })
            .__hereisitResolveShare === "function",
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "새 작업" }).click();
  await page.evaluate(() => {
    (window as Window & { __hereisitResolveShare?: () => void }).__hereisitResolveShare?.();
  });
  await settleRenderedState(page);

  await expect(page.getByRole("status")).toHaveText("파일을 선택하면 페이지를 확인할게요.");
  expect(await page.evaluate(() => sessionStorage.getItem("__hereisitDownloadClicks"))).toBe("0");
  privacy.assertClean(browserName !== "firefox");
});

test("does not download a revoked result when a pending share rejects after reset", async ({
  browserName,
  page,
}) => {
  await installPendingShare(page);
  const privacy = await prepareSinglePageResult(page);

  await page.getByRole("button", { name: "이미지 저장·공유 ↓" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as Window & { __hereisitRejectShare?: () => void })
            .__hereisitRejectShare === "function",
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "새 작업" }).click();
  await page.evaluate(() => {
    (window as Window & { __hereisitRejectShare?: () => void }).__hereisitRejectShare?.();
  });
  await settleRenderedState(page);

  await expect(page.getByRole("status")).toHaveText("파일을 선택하면 페이지를 확인할게요.");
  expect(await page.evaluate(() => sessionStorage.getItem("__hereisitDownloadClicks"))).toBe("0");
  privacy.assertClean(browserName !== "firefox");
});
