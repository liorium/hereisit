import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";

const LOCAL_PAGES_ORIGIN = "http://127.0.0.1:4173";
const IMAGE_WATERMARK_WORKER_MARKER = "hereisit-image-watermark-worker";

type SourceFilePayload = {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
};

async function setSourceFiles(
  page: Page,
  files: SourceFilePayload | readonly SourceFilePayload[],
): Promise<void> {
  const input = page.locator('input[type="file"][multiple]');
  await expect(input).toBeEnabled();
  await input.setInputFiles(files);
}

async function createSolidPng(
  page: Page,
  width: number,
  height: number,
  color: string,
): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ color: fill, height: imageHeight, width: imageWidth }) => {
      const canvas = document.createElement("canvas");
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("2D canvas is unavailable");
      context.fillStyle = fill;
      context.fillRect(0, 0, imageWidth, imageHeight);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value === null) reject(new Error("PNG encoding failed"));
          else resolve(value);
        }, "image/png");
      });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { color, height, width },
  );
  return Buffer.from(bytes);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function markPngAnimated(png: Buffer): Buffer {
  const type = Buffer.from("acTL");
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2, 0);
  data.writeUInt32BE(0, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const animationChunk = Buffer.concat([length, type, data, checksum]);
  return Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]);
}

async function waitForCompleted(page: Page, count: number): Promise<void> {
  await expect(
    page.getByRole("status").filter({
      hasText: `${count}개 이미지 워터마크 처리를 완료했어요.`,
    }),
  ).toBeVisible({ timeout: 20_000 });
}

async function scanLoadedJavaScriptMarkers(
  page: Page,
  requestUrls: readonly string[],
  markers: readonly string[],
): Promise<Set<string>> {
  if (requestUrls.length === 0) throw new Error("Loaded JavaScript isolation scan failed");
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
        new URL(response.url()).origin !== LOCAL_PAGES_ORIGIN ||
        ![undefined, "identity"].includes(response.headers()["content-encoding"])
      ) {
        throw new Error("Unexpected JavaScript refetch response");
      }
      const body = await response.text();
      if (body.length === 0) throw new Error("Unexpected empty JavaScript response");
      for (const marker of markers) {
        if (body.includes(marker)) found.add(marker);
      }
    } catch {
      throw new Error("Loaded JavaScript isolation scan failed");
    }
  }
  return found;
}

async function samplePixels(
  page: Page,
  bytes: Uint8Array,
  points: readonly { x: number; y: number }[],
): Promise<number[][]> {
  return page.evaluate(
    async ({ encoded, samplePoints }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(encoded)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("2D canvas is unavailable");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return samplePoints.map(({ x, y }) => Array.from(context.getImageData(x, y, 1, 1).data));
    },
    { encoded: Array.from(bytes), samplePoints: points },
  );
}

function expectPixelNear(
  actual: readonly number[] | undefined,
  expected: readonly number[],
  tolerance = 12,
): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, expectedChannel] of expected.entries()) {
    expect(Math.abs((actual?.[index] ?? Number.NaN) - expectedChannel)).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

test("text watermark uses the approved defaults and saves only on request", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  const requestViolations: string[] = [];
  let failedRequests = 0;
  const pageErrors: string[] = [];
  let downloads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== LOCAL_PAGES_ORIGIN) requestViolations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) requestViolations.push("write-method");
    if (request.postData() !== null) requestViolations.push("request-body");
  });
  page.on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("download", () => {
    downloads += 1;
  });

  await page.goto("/image/watermark");

  const source = await createSolidPng(page, 320, 180, "#f5f5f4");
  await setSourceFiles(page, {
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });

  await expect(page.getByRole("radio", { name: "문구", exact: true })).toBeChecked();
  await expect(page.getByLabel("워터마크 문구")).toHaveValue("© HereIsIt");
  await expect(page.getByRole("radio", { name: "오른쪽 아래", exact: true })).toBeChecked();
  await expect(page.getByRole("slider", { name: /문구 크기/ })).toHaveValue("12");
  await expect(page.getByRole("slider", { name: /여백/ })).toHaveValue("3");
  await expect(page.getByRole("slider", { name: /불투명도/ })).toHaveValue("55");
  await expect(page.getByLabel("문구 색상")).toHaveValue("#111827");
  await expect(page.getByLabel("출력 형식")).toHaveValue("source");
  await expect(page.getByRole("slider", { name: /품질/ })).toHaveValue("90");
  await expect(page.getByRole("button", { name: /결과 저장|저장·공유|ZIP/ })).toHaveCount(0);
  await expect(page.locator('img[alt*="워터마크 결과"]')).toHaveCount(0);
  expect(downloads).toBe(0);

  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await expect(page.getByRole("status").getByText(/1개.*완료/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toBeVisible();
  await expect(page.getByText("원본 320×180", { exact: true })).toBeVisible();
  await expect(page.getByText("결과 320×180", { exact: true })).toBeVisible();
  await expect(page.getByText(/메타데이터.*제거/)).toBeVisible();
  await expect(page.getByText(/다시 인코딩|재인코딩/)).toBeVisible();
  expect(downloads).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("source-watermarked-hereisit.png");
  const path = await download.path();
  expect(path).not.toBeNull();
  const output = new Uint8Array(await readFile(path as string));
  expect(Array.from(output.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(pngDimensions(output)).toEqual({ width: 320, height: 180 });
  expect(downloads).toBe(1);
  expect(requestViolations).toEqual([]);
  expect(failedRequests).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("loads only the dedicated image watermark Worker marker", async ({ page }) => {
  const loadedJavaScriptUrls = new Set<string>();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith(".js")) loadedJavaScriptUrls.add(response.url());
  });

  await page.goto("/image/watermark");
  await expect(
    page.getByRole("heading", { level: 1, name: "이미지에 워터마크 넣기" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(loadedJavaScriptUrls.size).toBeGreaterThan(0);

  const forbiddenMarkers = [
    "hereisit-image-worker",
    "hereisit-pdf-worker",
    "hereisit-pdf-inspection-worker",
    "hereisit-pdf-to-images-worker",
    "hereisit-pdf-compress-scanned-worker",
  ] as const;
  const markers = await scanLoadedJavaScriptMarkers(
    page,
    [...loadedJavaScriptUrls],
    [IMAGE_WATERMARK_WORKER_MARKER, ...forbiddenMarkers],
  );
  expect(markers.has(IMAGE_WATERMARK_WORKER_MARKER)).toBe(true);
  for (const marker of forbiddenMarkers) expect(markers.has(marker)).toBe(false);
});

test("places a real logo at the top-left and preserves pixels outside it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 320, 180, "#ffffff");
  const logo = await createSolidPng(page, 64, 32, "#ff0000");
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });

  await setSourceFiles(page, {
    name: "white.png",
    mimeType: "image/png",
    buffer: source,
  });
  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  await page.locator('input[type="file"]:not([multiple])').setInputFiles({
    name: "red-logo.png",
    mimeType: "image/png",
    buffer: logo,
  });
  await page.getByRole("radio", { name: "왼쪽 위", exact: true }).check();
  await page.getByRole("slider", { name: /로고 크기/ }).fill("20");
  await page.getByRole("slider", { name: /여백/ }).fill("0");
  await page.getByRole("slider", { name: /불투명도/ }).fill("100");
  await page.getByLabel("출력 형식").selectOption("png");

  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await waitForCompleted(page, 1);
  expect(downloads).toBe(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 저장·공유 ↓" }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const output = new Uint8Array(await readFile(path as string));
  expect(pngDimensions(output)).toEqual({ width: 320, height: 180 });
  const [insideA, insideB, outsideA, outsideB] = await samplePixels(page, output, [
    { x: 10, y: 10 },
    { x: 40, y: 20 },
    { x: 120, y: 100 },
    { x: 300, y: 170 },
  ]);
  for (const inside of [insideA, insideB]) expectPixelNear(inside, [255, 0, 0, 255]);
  for (const outside of [outsideA, outsideB]) expectPixelNear(outside, [255, 255, 255, 255]);
});

test("accepts a structurally valid logo with an empty MIME hint", async ({ page }) => {
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 120, 80, "#ffffff");
  const logo = await createSolidPng(page, 32, 16, "#ff0000");
  await setSourceFiles(page, {
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });
  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  const logoInput = page.locator('input[type="file"]:not([multiple])');
  const selectedLogoType = await logoInput.evaluate((element, bytes) => {
    const input = element as HTMLInputElement;
    const transfer = new DataTransfer();
    const file = new File([Uint8Array.from(bytes)], "logo.png", { type: "" });
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return file.type;
  }, Array.from(logo));
  expect(selectedLogoType).toBe("");

  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await waitForCompleted(page, 1);
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toBeVisible();
});

test("creates a collision-safe ZIP for duplicate source names only on request", async ({
  page,
}) => {
  await page.goto("/image/watermark");
  const origin = new URL(page.url()).origin;
  const requestViolations: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) requestViolations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) requestViolations.push("write-method");
    if (request.postData() !== null) requestViolations.push("request-body");
  });
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  const first = await createSolidPng(page, 80, 50, "#ffffff");
  const second = await createSolidPng(page, 80, 50, "#dbeafe");
  await setSourceFiles(page, [
    { name: "duplicate.png", mimeType: "image/png", buffer: first },
    { name: "duplicate.png", mimeType: "image/png", buffer: second },
  ]);

  await page.getByRole("button", { name: "2개 이미지에 워터마크 넣기 →" }).click();
  await waitForCompleted(page, 2);
  expect(downloads).toBe(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("hereisit-watermarked-images.zip");
  const path = await download.path();
  expect(path).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(path as string)));
  expect(Object.keys(archive).sort()).toEqual([
    "duplicate-watermarked-hereisit-2.png",
    "duplicate-watermarked-hereisit.png",
  ]);
  expect(downloads).toBe(1);
  expect(requestViolations).toEqual([]);
});

test("releases an archive URL when ZIP download initiation throws", async ({ page }) => {
  await page.addInitScript(() => {
    const trackedWindow = window as Window & {
      __archiveUrl?: string;
      __archiveUrlRevoked?: boolean;
    };
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectUrl(object);
      if (object instanceof Blob && object.type === "application/zip") {
        trackedWindow.__archiveUrl = url;
        trackedWindow.__archiveUrlRevoked = false;
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (url === trackedWindow.__archiveUrl) trackedWindow.__archiveUrlRevoked = true;
      nativeRevokeObjectUrl(url);
    };
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download === "hereisit-watermarked-images.zip") {
        throw new Error("download initiation failed");
      }
      nativeClick.call(this);
    };
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 80, 50, "#ffffff");
  await setSourceFiles(page, [
    { name: "first.png", mimeType: "image/png", buffer: source },
    { name: "second.png", mimeType: "image/png", buffer: source },
  ]);
  await page.getByRole("button", { name: "2개 이미지에 워터마크 넣기 →" }).click();
  await waitForCompleted(page, 2);
  await page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" }).click();
  await expect(page.getByRole("status")).toContainText("ZIP 파일을 만들지 못했어요.");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __archiveUrlRevoked?: boolean }).__archiveUrlRevoked ?? false,
      ),
    )
    .toBe(true);
});

test("releases completed archive URLs on invalidation and rerun", async ({ page }) => {
  await page.addInitScript(() => {
    const trackedWindow = window as Window & {
      __archiveUrls?: string[];
      __revokedArchiveUrls?: string[];
    };
    trackedWindow.__archiveUrls = [];
    trackedWindow.__revokedArchiveUrls = [];
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectUrl(object);
      if (object instanceof Blob && object.type === "application/zip") {
        trackedWindow.__archiveUrls?.push(url);
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (trackedWindow.__archiveUrls?.includes(url)) {
        trackedWindow.__revokedArchiveUrls?.push(url);
      }
      nativeRevokeObjectUrl(url);
    };
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 80, 50, "#ffffff");
  await setSourceFiles(page, [
    { name: "first.png", mimeType: "image/png", buffer: source },
    { name: "second.png", mimeType: "image/png", buffer: source },
  ]);
  const run = page.getByRole("button", { name: "2개 이미지에 워터마크 넣기 →" });
  const saveArchive = page.getByRole("button", { name: "결과 2개 ZIP으로 받기 ↓" });

  await run.click();
  await waitForCompleted(page, 2);
  await Promise.all([page.waitForEvent("download"), saveArchive.click()]);
  const firstArchiveUrl = await page.evaluate(() =>
    (window as Window & { __archiveUrls?: string[] }).__archiveUrls?.at(-1),
  );
  expect(firstArchiveUrl).toBeTruthy();

  const opacity = page.getByRole("slider", { name: /불투명도/ });
  await opacity.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          (window as Window & { __revokedArchiveUrls?: string[] }).__revokedArchiveUrls?.includes(
            url,
          ) ?? false,
        firstArchiveUrl as string,
      ),
    )
    .toBe(true);

  await run.click();
  await waitForCompleted(page, 2);
  await Promise.all([page.waitForEvent("download"), saveArchive.click()]);
  const secondArchiveUrl = await page.evaluate(() =>
    (window as Window & { __archiveUrls?: string[] }).__archiveUrls?.at(-1),
  );
  expect(secondArchiveUrl).toBeTruthy();
  expect(secondArchiveUrl).not.toBe(firstArchiveUrl);

  await run.click();
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          (window as Window & { __revokedArchiveUrls?: string[] }).__revokedArchiveUrls?.includes(
            url,
          ) ?? false,
        secondArchiveUrl as string,
      ),
    )
    .toBe(true);
  await waitForCompleted(page, 2);
});

test("shows corrections for missing, oversize, and animated logos", async ({ page }) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    const trackedWindow = window as Window & { __watermarkFileReads?: number };
    trackedWindow.__watermarkFileReads = 0;
    File.prototype.arrayBuffer = function arrayBuffer() {
      trackedWindow.__watermarkFileReads = (trackedWindow.__watermarkFileReads ?? 0) + 1;
      return original.call(this);
    };
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 120, 80, "#ffffff");
  await setSourceFiles(page, {
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });
  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  const run = page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" });
  await expect(page.getByText(/JPG, PNG 또는 WebP 로고를 선택/)).toBeVisible();
  await expect(run).toBeDisabled();

  await page.locator('input[type="file"]:not([multiple])').setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/10MB 이하/)).toBeVisible();
  await expect(run).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as Window & { __watermarkFileReads?: number }).__watermarkFileReads,
    ),
  ).toBe(0);

  const logo = markPngAnimated(await createSolidPng(page, 64, 32, "#ff0000"));
  await page.locator('input[type="file"]:not([multiple])').setInputFiles({
    name: "animated.png",
    mimeType: "image/png",
    buffer: logo,
  });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole("alert").filter({ hasText: /애니메이션|움직이는/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "결과 저장·공유 ↓" })).toHaveCount(0);
});

test("setting and logo changes revoke stale result URLs and disable saving", async ({ page }) => {
  await page.addInitScript(() => {
    const original = URL.revokeObjectURL.bind(URL);
    const trackedWindow = window as Window & { __revokedWatermarkUrls?: string[] };
    trackedWindow.__revokedWatermarkUrls = [];
    URL.revokeObjectURL = (url) => {
      trackedWindow.__revokedWatermarkUrls?.push(url);
      original(url);
    };
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 160, 100, "#ffffff");
  const firstLogo = await createSolidPng(page, 64, 32, "#ff0000");
  const secondLogo = await createSolidPng(page, 64, 32, "#0000ff");
  await setSourceFiles(page, {
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });
  const run = page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" });
  await run.click();
  await waitForCompleted(page, 1);
  const textResultUrl = await page
    .locator('img[alt="source.png 워터마크 결과"]')
    .getAttribute("src");
  expect(textResultUrl).not.toBeNull();
  await expect
    .poll(() =>
      page
        .locator('img[alt="source.png 워터마크 결과"]')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  const opacity = page.getByRole("slider", { name: /불투명도/ });
  await opacity.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "결과 저장·공유 ↓" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (url) =>
          (
            window as Window & { __revokedWatermarkUrls?: string[] }
          ).__revokedWatermarkUrls?.includes(url) ?? false,
        textResultUrl as string,
      ),
    )
    .toBe(true);

  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  const logoInput = page.locator('input[type="file"]:not([multiple])');
  await logoInput.setInputFiles({
    name: "first.png",
    mimeType: "image/png",
    buffer: firstLogo,
  });
  const logoPreviewUrl = await page.getByAltText("선택한 워터마크 로고").getAttribute("src");
  expect(logoPreviewUrl).not.toBeNull();
  await page.getByRole("radio", { name: "문구", exact: true }).check();
  expect(
    await page.evaluate(
      (url) =>
        (window as Window & { __revokedWatermarkUrls?: string[] }).__revokedWatermarkUrls?.includes(
          url,
        ) ?? false,
      logoPreviewUrl as string,
    ),
  ).toBe(false);
  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  await run.click();
  await waitForCompleted(page, 1);
  const logoResultUrl = await page
    .locator('img[alt="source.png 워터마크 결과"]')
    .getAttribute("src");
  expect(logoResultUrl).not.toBeNull();

  await logoInput.setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: secondLogo,
  });
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "결과 저장·공유 ↓" })).toHaveCount(0);
  for (const staleUrl of [logoResultUrl as string, logoPreviewUrl as string]) {
    await expect
      .poll(() =>
        page.evaluate(
          (url) =>
            (
              window as Window & { __revokedWatermarkUrls?: string[] }
            ).__revokedWatermarkUrls?.includes(url) ?? false,
          staleUrl,
        ),
      )
      .toBe(true);
  }
});

test("cancel ignores a delayed Worker completion and reruns cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const trackedWindow = window as Window & { __delayedWorkerTypes?: string[] };
    trackedWindow.__delayedWorkerTypes = [];
    class DelayedWorker {
      private readonly native: Worker;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        this.native = new NativeWorker(scriptURL, options);
        this.native.onmessage = (event) => {
          const type = (event.data as { type?: unknown } | null)?.type;
          if (typeof type === "string") trackedWindow.__delayedWorkerTypes?.push(type);
          setTimeout(() => this.onmessage?.(event), 1_500);
        };
        this.native.onmessageerror = (event) => {
          setTimeout(() => this.onmessageerror?.(event), 1_500);
        };
        this.native.onerror = (event) => {
          setTimeout(() => this.onerror?.(event), 1_500);
        };
      }

      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (transfer === undefined) this.native.postMessage(message);
        else this.native.postMessage(message, transfer);
      }

      terminate(): void {
        this.native.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: DelayedWorker });
  });
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 320, 180, "#ffffff");
  await setSourceFiles(page, {
    name: "source.png",
    mimeType: "image/png",
    buffer: source,
  });
  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __delayedWorkerTypes?: string[] }).__delayedWorkerTypes?.filter(
            (type) => type === "complete",
          ).length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "작업 중단" }).click();
  await expect(page.getByRole("status")).toContainText("작업을 중단했어요.");
  await page.waitForTimeout(1_650);
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toHaveCount(0);

  const previousCompletes = await page.evaluate(
    () =>
      (window as Window & { __delayedWorkerTypes?: string[] }).__delayedWorkerTypes?.filter(
        (type) => type === "complete",
      ).length ?? 0,
  );
  await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __delayedWorkerTypes?: string[] }).__delayedWorkerTypes?.filter(
            (type) => type === "complete",
          ).length ?? 0,
      ),
    )
    .toBeGreaterThan(previousCompletes);
  await waitForCompleted(page, 1);
  await expect(page.locator('img[alt="source.png 워터마크 결과"]')).toHaveCount(1);
});

for (const shareOutcome of ["resolve", "reject"] as const) {
  test(`a delayed share ${shareOutcome} cannot save or message after invalidation`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const trackedWindow = window as Window & {
        __sharePending?: boolean;
        __settleShare?: (reject: boolean) => void;
      };
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: (data: ShareData) => data.files?.length === 1,
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: () =>
          new Promise<void>((resolve, reject) => {
            trackedWindow.__sharePending = true;
            trackedWindow.__settleShare = (shouldReject) => {
              if (shouldReject) reject(new Error("delayed share failure"));
              else resolve();
            };
          }),
      });
    });
    await page.goto("/image/watermark");
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    const source = await createSolidPng(page, 100, 60, "#ffffff");
    await setSourceFiles(page, {
      name: "share.png",
      mimeType: "image/png",
      buffer: source,
    });
    await page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" }).click();
    await waitForCompleted(page, 1);
    await page.getByRole("button", { name: "결과 저장·공유 ↓" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __sharePending?: boolean }).__sharePending ?? false,
        ),
      )
      .toBe(true);

    const opacity = page.getByRole("slider", { name: /불투명도/ });
    await opacity.focus();
    await page.keyboard.press("ArrowRight");
    await page.evaluate((shouldReject) => {
      (window as Window & { __settleShare?: (reject: boolean) => void }).__settleShare?.(
        shouldReject,
      );
    }, shareOutcome === "reject");
    await page.waitForTimeout(100);
    expect(downloads).toBe(0);
    await expect(page.getByRole("status")).toContainText("설정이 바뀌었어요.");
    await expect(page.getByRole("status")).not.toContainText("결과를 공유 메뉴로 보냈어요.");
  });
}

test("reports an unsupported runtime before reading a selected file", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "OffscreenCanvas", { configurable: true, value: undefined });
    const original = File.prototype.arrayBuffer;
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const trackedWindow = window as Window & {
      __watermarkFileReads?: number;
      __watermarkObjectUrls?: number;
    };
    trackedWindow.__watermarkFileReads = 0;
    trackedWindow.__watermarkObjectUrls = 0;
    File.prototype.arrayBuffer = function arrayBuffer() {
      trackedWindow.__watermarkFileReads = (trackedWindow.__watermarkFileReads ?? 0) + 1;
      return original.call(this);
    };
    URL.createObjectURL = (object) => {
      trackedWindow.__watermarkObjectUrls = (trackedWindow.__watermarkObjectUrls ?? 0) + 1;
      return nativeCreateObjectUrl(object);
    };
  });
  await page.goto("/image/watermark");
  await expect(page.getByRole("button", { name: "이미지 선택" })).toBeDisabled();
  const source = await createSolidPng(page, 40, 30, "#ffffff");
  const dataTransfer = await page.evaluateHandle(
    ({ bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(bytes)], "unread.png", { type: "image/png" }));
      return transfer;
    },
    { bytes: Array.from(source) },
  );
  await page
    .getByRole("heading", { name: "워터마크를 넣을 이미지를 선택하세요" })
    .locator("../..")
    .dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByText(/최신 Safari, Chrome, Firefox 또는 Edge/).first()).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __watermarkFileReads?: number }).__watermarkFileReads,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __watermarkObjectUrls?: number }).__watermarkObjectUrls,
    ),
  ).toBe(0);
  await expect(page.locator('img[alt="unread.png 미리보기"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /이미지에 워터마크 넣기/ })).toHaveCount(0);
});

test("moves through all nine watermark positions with the keyboard", async ({ page }) => {
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 40, 30, "#ffffff");
  await setSourceFiles(page, {
    name: "keyboard.png",
    mimeType: "image/png",
    buffer: source,
  });
  const positions = page.getByRole("group", { name: "위치" }).getByRole("radio");
  await expect(positions).toHaveCount(9);
  await positions.nth(0).focus();
  await page.keyboard.press("Space");
  await expect(positions.nth(0)).toBeChecked();
  for (let index = 1; index < 9; index += 1) {
    await page.keyboard.press("ArrowRight");
    await expect(positions.nth(index)).toBeFocused();
    await expect(positions.nth(index)).toBeChecked();
  }
});

test("keeps text length and mode-specific size controls inside the contract", async ({ page }) => {
  await page.goto("/image/watermark");
  const source = await createSolidPng(page, 40, 30, "#ffffff");
  await setSourceFiles(page, {
    name: "contract.png",
    mimeType: "image/png",
    buffer: source,
  });

  const textInput = page.getByLabel("워터마크 문구");
  const run = page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" });
  await textInput.fill("😀".repeat(80));
  await expect(textInput).toHaveValue("😀".repeat(80));
  await expect(run).toBeEnabled();
  await textInput.fill("😀".repeat(81));
  await expect(run).toBeDisabled();
  await textInput.fill(`  ${"😀".repeat(80)}  `);
  await expect(run).toBeEnabled();
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    await textInput.fill(`Here${separator}IsIt`);
    await expect(run).toBeDisabled();
  }

  await textInput.fill("© HereIsIt");
  const textSize = page.getByRole("slider", { name: /문구 크기/ });
  await textSize.fill("4");
  await page.getByRole("radio", { name: "로고 이미지", exact: true }).check();
  const logoSize = page.getByRole("slider", { name: /로고 크기/ });
  await expect(logoSize).toHaveValue("5");
  await logoSize.fill("50");
  await page.getByRole("radio", { name: "문구", exact: true }).check();
  await expect(page.getByRole("slider", { name: /문구 크기/ })).toHaveValue("30");

  await page.getByRole("button", { name: "처음부터" }).click();
  await setSourceFiles(page, {
    name: "reset.png",
    mimeType: "image/png",
    buffer: source,
  });
  await expect(page.getByLabel("워터마크 문구")).toHaveValue("© HereIsIt");
  await expect(page.getByRole("radio", { name: "오른쪽 아래", exact: true })).toBeChecked();
  await expect(page.getByRole("slider", { name: /문구 크기/ })).toHaveValue("12");
  await expect(page.getByRole("slider", { name: /여백/ })).toHaveValue("3");
  await expect(page.getByRole("slider", { name: /불투명도/ })).toHaveValue("55");
  await expect(page.getByLabel("출력 형식")).toHaveValue("source");
  await expect(page.getByRole("slider", { name: /품질/ })).toHaveValue("90");
});
