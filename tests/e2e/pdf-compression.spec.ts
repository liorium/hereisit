import { readFile } from "node:fs/promises";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, rgb } from "@cantoo/pdf-lib";
import {
  type ConsoleMessage,
  expect,
  type JSHandle,
  type Page,
  type Route,
  test,
} from "@playwright/test";

const PDF_COMPRESSION_ROUTE = "/pdf/compress";
const PDF_INSPECTION_TIMEOUT_MS = 60_000;
const DESTRUCTIVE_WARNING =
  "모든 페이지가 이미지로 바뀝니다. 검색·복사 가능한 텍스트와 OCR, 링크·양식·주석·북마크·첨부파일·레이어가 제거되거나 평면화되고 전자서명은 무효가 됩니다. 스캔 문서에 적합하며 원본 파일은 수정하지 않아요.";
const UNSUPPORTED_BROWSER_MESSAGE = "이 브라우저는 로컬 스캔 PDF 압축을 지원하지 않아요.";
const SOURCE_TITLE = "ORIGINAL_SOURCE_TITLE";
const SOURCE_AUTHOR = "ORIGINAL_SOURCE_AUTHOR";

interface InspectedPdfOutput {
  author: string | undefined;
  creator: string | undefined;
  imageDimensions: Array<{ height: number; width: number }>;
  pageGeometry: Array<{ height: number; rotation: number; width: number }>;
  producer: string | undefined;
  title: string | undefined;
}

async function openReadyPdfCompression(page: Page): Promise<void> {
  await page.goto(PDF_COMPRESSION_ROUTE);
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({ timeout: 60_000 });
}

async function createVectorPdf(
  pageCount: number,
  size: { width: number; height: number } = { width: 72, height: 72 },
): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([size.width, size.height]);
    page.drawRectangle({
      x: Math.min(8, size.width / 4),
      y: Math.min(8, size.height / 4),
      width: Math.max(1, size.width - Math.min(16, size.width / 2)),
      height: Math.max(1, size.height - Math.min(16, size.height / 2)),
      color: rgb(0.15, 0.35, 0.8),
    });
  }
  return Buffer.from(await document.save());
}

async function createScannedPdf(page: Page, pageCount = 1): Promise<Buffer> {
  const encodedJpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1_275;
    canvas.height = 1_650;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Test canvas unavailable");

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
  document.setTitle(SOURCE_TITLE);
  document.setAuthor(SOURCE_AUTHOR);
  const scan = await document.embedJpg(Buffer.from(encodedJpeg, "base64"));
  for (let index = 0; index < pageCount; index += 1) {
    const outputPage = document.addPage([612, 792]);
    outputPage.drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });
    outputPage.drawRectangle({
      x: 0,
      y: 0,
      width: 612,
      height: 72,
      color: index % 2 === 0 ? rgb(0.9, 0.08, 0.08) : rgb(0.08, 0.12, 0.9),
    });
  }
  return Buffer.from(await document.save());
}

async function inspectPageMarkerColors(
  page: Page,
  bytes: Uint8Array,
): Promise<Array<{ blue: number; green: number; red: number }>> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const encodedImages = document.getPages().map((outputPage) => {
    const resources = outputPage.node.Resources();
    if (resources === undefined) throw new Error("Output page resources unavailable");
    const xObjects = resources.lookup(PDFName.XObject, PDFDict);
    const imageKey = xObjects.keys()[0];
    if (imageKey === undefined) throw new Error("Output page image unavailable");
    const image = xObjects.lookup(imageKey, PDFRawStream);
    return Buffer.from(image.getContents()).toString("base64");
  });

  return page.evaluate(async (images) => {
    const colors: Array<{ blue: number; green: number; red: number }> = [];
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

function expectPreservedPageMarkerOrder(
  colors: Array<{ blue: number; green: number; red: number }>,
): void {
  expect(colors).toHaveLength(2);
  expect((colors[0]?.red ?? 0) - (colors[0]?.blue ?? 0)).toBeGreaterThan(100);
  expect((colors[1]?.blue ?? 0) - (colors[1]?.red ?? 0)).toBeGreaterThan(100);
}

async function inspectPdfOutput(bytes: Uint8Array): Promise<InspectedPdfOutput> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const imageDimensions = document.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    const subtype = object.dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
    if (subtype?.toString() !== "/Image") return [];
    const width = object.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
    const height = object.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
    return [{ width, height }];
  });

  return {
    author: document.getAuthor(),
    creator: document.getCreator(),
    imageDimensions,
    pageGeometry: document.getPages().map((outputPage) => ({
      width: outputPage.getWidth(),
      height: outputPage.getHeight(),
      rotation: outputPage.getRotation().angle,
    })),
    producer: document.getProducer(),
    title: document.getTitle(),
  };
}

function expectCompletePdfEnvelope(bytes: Uint8Array): void {
  expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
  let end = bytes.length - 1;
  while ([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[end] ?? -1)) end -= 1;
  expect(new TextDecoder().decode(bytes.subarray(end - 4, end + 1))).toBe("%%EOF");
}

function exactCompressionTarget(sourceByteLength: number): number {
  return sourceByteLength - Math.max(1, Math.ceil(sourceByteLength / 100));
}

async function downloadedBytes(downloadPath: string | null): Promise<Uint8Array> {
  expect(downloadPath).not.toBeNull();
  return new Uint8Array(await readFile(downloadPath as string));
}

async function forceDownloadFallback(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  });
}

interface ConsolePrivacyObserverOptions {
  disposeConsoleArgument?: (argument: JSHandle) => Promise<void>;
}

async function observePrivateCompression(
  page: Page,
  sentinels: readonly string[] = [],
  options: ConsolePrivacyObserverOptions = {},
) {
  const origin = "http://127.0.0.1:4173";
  const violations: string[] = [];
  const leaks: string[] = [];
  const pendingConsoleInspections = new Set<Promise<void>>();
  const context = page.context();
  let parserWorkerRequests = 0;
  let downloads = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  let stopped = false;
  const disposeConsoleArgument =
    options.disposeConsoleArgument ?? ((argument: JSHandle) => argument.dispose());

  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postData() !== null) violations.push("request-body");
    if (url.pathname.startsWith("/pdfjs/") && !url.pathname.startsWith("/pdfjs/6.1.200/")) {
      violations.push("unpinned-pdfjs");
    }
    if (sentinels.some((sentinel) => decodeURIComponent(request.url()).includes(sentinel))) {
      leaks.push("request-url");
    }
    if (url.pathname === "/pdfjs/6.1.200/pdf.worker.min.mjs") parserWorkerRequests += 1;
    await route.continue();
  };
  const inspectConsoleArguments = async (message: ConsoleMessage): Promise<void> => {
    if (sentinels.length === 0) return;
    let arguments_: ReturnType<ConsoleMessage["args"]> = [];
    try {
      arguments_ = message.args();
      for (const argument of arguments_) {
        const found = await argument.evaluate((root, expectedSentinels) => {
          const maximumInspectedValues = 10_000;
          const stack: unknown[] = [];
          const visited = new WeakSet<object>();
          let reservedValues = 0;
          const reserve = (count: number) => {
            if (
              !Number.isSafeInteger(count) ||
              count < 0 ||
              count > maximumInspectedValues - reservedValues
            ) {
              throw new Error("Console argument exceeded the privacy inspection limit");
            }
            reservedValues += count;
          };
          const enqueue = (...values: unknown[]) => {
            reserve(values.length);
            stack.push(...values);
          };
          enqueue(root);

          while (stack.length > 0) {
            const value = stack.pop();
            if (typeof value === "string") {
              if (expectedSentinels.some((sentinel) => value.includes(sentinel))) return true;
              continue;
            }
            if (value === null || (typeof value !== "object" && typeof value !== "function")) {
              continue;
            }

            const objectValue = value as object;
            if (visited.has(objectValue)) continue;
            visited.add(objectValue);

            if (
              typeof File !== "undefined" &&
              objectValue instanceof File &&
              expectedSentinels.some((sentinel) => objectValue.name.includes(sentinel))
            ) {
              return true;
            }

            if (
              (typeof Blob !== "undefined" && objectValue instanceof Blob) ||
              (typeof ArrayBuffer !== "undefined" &&
                (objectValue instanceof ArrayBuffer || ArrayBuffer.isView(objectValue))) ||
              (typeof SharedArrayBuffer !== "undefined" && objectValue instanceof SharedArrayBuffer)
            ) {
              throw new Error("Console argument contains an uninspectable byte container");
            }

            if (Array.isArray(objectValue)) {
              const lengthDescriptor = Reflect.getOwnPropertyDescriptor(objectValue, "length");
              if (
                lengthDescriptor === undefined ||
                !("value" in lengthDescriptor) ||
                typeof lengthDescriptor.value !== "number"
              ) {
                throw new Error("Console array length became unreadable");
              }
              reserve(lengthDescriptor.value);
            }

            if (objectValue instanceof Map) {
              const sizeGetter = Reflect.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
              if (sizeGetter === undefined) throw new Error("Console map size became unreadable");
              const size = Reflect.apply(sizeGetter, objectValue, []);
              if (!Number.isSafeInteger(size) || size < 0) {
                throw new Error("Console map size is invalid");
              }
              if (size > Math.floor((maximumInspectedValues - reservedValues) / 2)) {
                throw new Error("Console map exceeded the privacy inspection limit");
              }
              Map.prototype.forEach.call(objectValue, (mapValue: unknown, mapKey: unknown) => {
                enqueue(mapKey, mapValue);
              });
            } else if (objectValue instanceof Set) {
              const sizeGetter = Reflect.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
              if (sizeGetter === undefined) throw new Error("Console set size became unreadable");
              const size = Reflect.apply(sizeGetter, objectValue, []);
              if (!Number.isSafeInteger(size) || size < 0) {
                throw new Error("Console set size is invalid");
              }
              if (size > maximumInspectedValues - reservedValues) {
                throw new Error("Console set exceeded the privacy inspection limit");
              }
              Set.prototype.forEach.call(objectValue, (setValue: unknown) => {
                enqueue(setValue);
              });
            }

            const ownKeys = Reflect.ownKeys(objectValue);
            reserve(ownKeys.length);
            for (const key of ownKeys) {
              const renderedKey = typeof key === "symbol" ? key.description : key;
              if (
                renderedKey !== undefined &&
                expectedSentinels.some((sentinel) => renderedKey.includes(sentinel))
              ) {
                return true;
              }
              const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);
              if (descriptor === undefined) {
                throw new Error("Console argument property became unreadable");
              }
              if ("value" in descriptor) {
                enqueue(descriptor.value);
              } else {
                throw new Error("Console argument contains an uninspectable accessor");
              }
            }
          }
          return false;
        }, sentinels);
        if (found) {
          leaks.push("console-argument");
          return;
        }
      }
    } catch {
      leaks.push("console-inspection-failed");
    } finally {
      const cleanupResults = await Promise.allSettled(
        arguments_.map((argument) => disposeConsoleArgument(argument)),
      );
      if (cleanupResults.some((result) => result.status === "rejected")) {
        leaks.push("console-cleanup-failed");
      }
    }
  };
  const consoleHandler = (message: ConsoleMessage) => {
    try {
      if (sentinels.some((sentinel) => message.text().includes(sentinel))) leaks.push("console");
    } catch {
      leaks.push("console-inspection-failed");
    }
    if (sentinels.length === 0) return;
    const inspection = inspectConsoleArguments(message);
    pendingConsoleInspections.add(inspection);
    void inspection.then(
      () => pendingConsoleInspections.delete(inspection),
      () => pendingConsoleInspections.delete(inspection),
    );
  };
  const downloadHandler = () => {
    downloads += 1;
  };
  const failedRequestHandler = () => {
    failedRequests += 1;
  };
  const pageErrorHandler = () => {
    pageErrors += 1;
  };

  await context.route("**/*", routeHandler);
  page.on("console", consoleHandler);
  page.on("download", downloadHandler);
  context.on("requestfailed", failedRequestHandler);
  page.on("pageerror", pageErrorHandler);

  const stopObserving = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    page.off("console", consoleHandler);
    page.off("download", downloadHandler);
    context.off("requestfailed", failedRequestHandler);
    page.off("pageerror", pageErrorHandler);
    try {
      await context.unroute("**/*", routeHandler);
    } catch {
      violations.push("observer-cleanup-failed");
    }
  };

  const flushConsoleEvents = async (): Promise<void> => {
    try {
      await page.evaluate(() => undefined);
    } catch {
      leaks.push("console-inspection-sync-failed");
    }
  };

  const drainConsoleInspections = async (): Promise<void> => {
    while (pendingConsoleInspections.size > 0) {
      await Promise.allSettled([...pendingConsoleInspections]);
    }
  };

  return {
    async assertClean(expectedDownloads = 0, requireParserWorker = true) {
      await flushConsoleEvents();
      await stopObserving();
      await drainConsoleInspections();
      expect(violations).toEqual([]);
      expect(leaks).toEqual([]);
      expect(downloads).toBe(expectedDownloads);
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
      if (object instanceof Blob) sessionStorage.setItem("__hereisitResultMime", object.type);
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

async function resultObjectUrlMime(page: Page): Promise<string | null> {
  return page.evaluate(() => sessionStorage.getItem("__hereisitResultMime"));
}

async function objectUrlCounts(page: Page): Promise<{ created: number; revoked: number }> {
  return page.evaluate(() => ({
    created: Number(sessionStorage.getItem("__hereisitCreatedUrls") ?? "0"),
    revoked: Number(sessionStorage.getItem("__hereisitRevokedUrls") ?? "0"),
  }));
}

async function uploadPdf(
  page: Page,
  name: string,
  buffer: Buffer,
  pageCount: number,
): Promise<void> {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "application/pdf",
    buffer,
  });
  await expect(page.getByText(`${pageCount}페이지 PDF를 불러왔어요.`).first()).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
}

async function prepareCompressedResult(
  page: Page,
): Promise<ReturnType<typeof observePrivateCompression>> {
  const privacy = await observePrivateCompression(page);
  await openReadyPdfCompression(page);
  await uploadPdf(page, "scan.pdf", await createScannedPdf(page), 1);
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
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

test("detects a sentinel filename hidden in a structured console argument", async ({ page }) => {
  const sentinelFilename = "PRIVATE_STRUCTURED_CONSOLE_SENTINEL.pdf";
  const privacy = await observePrivateCompression(page, [sentinelFilename]);
  await openReadyPdfCompression(page);

  await page.evaluate((name) => {
    console.log({ nested: { source: new File(["synthetic fixture"], name) } });
  }, sentinelFilename);

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  expect(String(detectionError)).toContain("console");
});

test("rejects a wide console container before enumerating it in the privacy harness", async ({
  page,
}) => {
  const privacy = await observePrivateCompression(page, ["PRIVATE_WIDE_CONTAINER_SENTINEL"]);
  await openReadyPdfCompression(page);

  await page.evaluate(() => {
    const trackedWindow = window as Window & { __hereisitWideOwnKeysCalls?: number };
    trackedWindow.__hereisitWideOwnKeysCalls = 0;
    const wideArray = new Proxy(new Array(100_001), {
      ownKeys(target) {
        trackedWindow.__hereisitWideOwnKeysCalls =
          (trackedWindow.__hereisitWideOwnKeysCalls ?? 0) + 1;
        return Reflect.ownKeys(target);
      },
    });
    console.log({ nested: wideArray });
  });

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  expect.soft(String(detectionError)).toContain("console");
  expect(
    await page.evaluate(
      () => (window as Window & { __hereisitWideOwnKeysCalls?: number }).__hereisitWideOwnKeysCalls,
    ),
  ).toBe(0);
});

test("records a rejected console handle cleanup in the privacy harness", async ({ page }) => {
  const privacy = await observePrivateCompression(page, ["PRIVATE_CLEANUP_SENTINEL"], {
    disposeConsoleArgument: async () => {
      throw new Error("Synthetic cleanup rejection");
    },
  });
  await openReadyPdfCompression(page);

  await page.evaluate(() => {
    console.log({ nested: "synthetic fixture" });
  });

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  expect(String(detectionError)).toContain("console-cleanup-failed");
});

test("publishes the isolated compression shell with exact default copy and preset", async ({
  page,
}) => {
  await page.goto(PDF_COMPRESSION_ROUTE);
  await expect(page.getByRole("heading", { level: 1, name: "스캔 PDF 용량 줄이기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: /균형 150DPI/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /최소 용량 96DPI/ })).not.toBeChecked();
  await expect(page.getByText(DESTRUCTIVE_WARNING, { exact: true })).toHaveCount(2);
  await expect(page.getByText(/원본보다 1% 이상 작을 때만/).first()).toBeVisible();
  await expect(
    page.getByText("PDF 1개 · 1바이트~50MB · 최대 100페이지 · 파일은 이 기기에서만 처리돼요."),
  ).toBeVisible();
  await expect(page.getByText(/작은 글자가 흐려질 수 있어요/)).toBeVisible();
  await expect(page.locator('[aria-label="PDF 압축 작업 공간"] > *')).toHaveCount(3);
  await expect(page.locator('[aria-label="PDF 압축 작업 공간"] > *').nth(0)).toHaveAttribute(
    "aria-label",
    "원본 PDF",
  );
  await expect(page.locator('[aria-label="PDF 압축 작업 공간"] > *').nth(1)).toHaveAttribute(
    "aria-label",
    "PDF 압축 설정",
  );
  await expect(page.locator('[aria-label="PDF 압축 작업 공간"] > *').nth(2)).toHaveAttribute(
    "aria-label",
    "PDF 압축 결과",
  );
});

test("explains an unsupported browser before selection without starting local work", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("__hereisitUnsupportedWorkerStarts", "0");
    sessionStorage.setItem("__hereisitUnsupportedFileReads", "0");
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: undefined,
    });

    const NativeWorker = Worker;
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, argumentsList) {
          const count = Number(sessionStorage.getItem("__hereisitUnsupportedWorkerStarts") ?? "0");
          sessionStorage.setItem("__hereisitUnsupportedWorkerStarts", String(count + 1));
          return Reflect.construct(Target, argumentsList) as Worker;
        },
      }),
    });

    const originalArrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function arrayBuffer() {
      const count = Number(sessionStorage.getItem("__hereisitUnsupportedFileReads") ?? "0");
      sessionStorage.setItem("__hereisitUnsupportedFileReads", String(count + 1));
      return Reflect.apply(originalArrayBuffer, this, []);
    };
  });

  await page.goto(PDF_COMPRESSION_ROUTE);

  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText(UNSUPPORTED_BROWSER_MESSAGE);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        fileReads: Number(sessionStorage.getItem("__hereisitUnsupportedFileReads") ?? "0"),
        workerStarts: Number(sessionStorage.getItem("__hereisitUnsupportedWorkerStarts") ?? "0"),
      })),
    )
    .toEqual({ fileReads: 0, workerStarts: 0 });
});

test("compresses a known scan with the default preset and downloads only after one explicit save", async ({
  browserName,
  page,
}) => {
  await forceDownloadFallback(page);
  await installObjectUrlCounters(page);
  const privacySentinel = "PRIVATE_SCAN_SENTINEL";
  const privacy = await observePrivateCompression(page, [
    privacySentinel,
    SOURCE_TITLE,
    SOURCE_AUTHOR,
  ]);
  await openReadyPdfCompression(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const source = await createScannedPdf(page, 2);
  await uploadPdf(page, `${privacySentinel}.pdf`, source, 2);
  await expect(page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" })).toBeEnabled();
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  const details = page.getByLabel("압축 결과 상세");
  const detailRows = details.locator("div");
  await expect(details.getByText("균형 150DPI", { exact: true })).toBeVisible();
  await expect(detailRows.filter({ hasText: /^원본\d+(?:\.\d+)?(?:B|KB|MB)$/ })).toHaveCount(1);
  await expect(detailRows.filter({ hasText: /^결과\d+(?:\.\d+)?(?:B|KB|MB)$/ })).toHaveCount(1);
  await expect(detailRows.filter({ hasText: /^절약\d+%$/ })).toHaveCount(1);
  await expect(detailRows.filter({ hasText: /^처리 시간(?:\d+ms|\d+(?:\.\d+)?초)$/ })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("region", { name: "PDF 압축 결과" }).getByText(DESTRUCTIVE_WARNING, {
      exact: true,
    }),
  ).toBeVisible();
  await settleRenderedState(page);
  expect(downloadCount).toBe(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });
  expect(await resultObjectUrlMime(page)).toBe("application/pdf");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("PRIVATE_SCAN_SENTINEL-compressed-hereisit.pdf");
  expect(downloadCount).toBe(1);
  const output = await downloadedBytes(await download.path());
  expectCompletePdfEnvelope(output);
  expect(output.byteLength).toBeLessThanOrEqual(exactCompressionTarget(source.byteLength));
  expect(await inspectPdfOutput(output)).toEqual({
    author: undefined,
    creator: "HereIsIt",
    imageDimensions: [
      { width: 1_275, height: 1_650 },
      { width: 1_275, height: 1_650 },
    ],
    pageGeometry: [
      { width: 612, height: 792, rotation: 0 },
      { width: 612, height: 792, rotation: 0 },
    ],
    producer: "HereIsIt",
    title: undefined,
  });
  expectPreservedPageMarkerOrder(await inspectPageMarkerColors(page, output));
  await privacy.assertClean(1, browserName !== "firefox");
});

test("makes the same Letter scan smaller with the minimum preset and preserves output structure", async ({
  page,
}) => {
  await forceDownloadFallback(page);
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  const source = await createScannedPdf(page, 2);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await uploadPdf(page, "report.pdf", source, 2);

  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  expect(downloadCount).toBe(0);
  const [balancedDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  expect(balancedDownload.suggestedFilename()).toBe("report-compressed-hereisit.pdf");
  const balanced = await downloadedBytes(await balancedDownload.path());

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await expect(page.getByText("압축 PDF 준비 완료")).toHaveCount(0);
  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByLabel("압축 결과 상세").getByText("최소 용량 96DPI", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "PDF 압축 결과" }).getByText(DESTRUCTIVE_WARNING, {
      exact: true,
    }),
  ).toBeVisible();
  expect(downloadCount).toBe(1);
  expect(await resultObjectUrlMime(page)).toBe("application/pdf");

  const [minimumDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  expect(minimumDownload.suggestedFilename()).toBe("report-compressed-hereisit.pdf");
  expect(downloadCount).toBe(2);
  const minimum = await downloadedBytes(await minimumDownload.path());
  expectCompletePdfEnvelope(minimum);
  expect(minimum.byteLength).toBeLessThanOrEqual(exactCompressionTarget(source.byteLength));
  expect(minimum.byteLength).toBeLessThan(balanced.byteLength);
  expect(await inspectPdfOutput(minimum)).toEqual({
    author: undefined,
    creator: "HereIsIt",
    imageDimensions: [
      { width: 816, height: 1_056 },
      { width: 816, height: 1_056 },
    ],
    pageGeometry: [
      { width: 612, height: 792, rotation: 0 },
      { width: 612, height: 792, rotation: 0 },
    ],
    producer: "HereIsIt",
    title: undefined,
  });
  expectPreservedPageMarkerOrder(await inspectPageMarkerColors(page, minimum));
});

test("shows both preset-specific no-reduction messages without creating a result URL", async ({
  page,
}) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await uploadPdf(page, "vector.pdf", await createVectorPdf(1, { width: 612, height: 792 }), 1);

  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(
    page
      .getByText(
        "균형 150DPI 설정으로는 파일 용량을 1% 이상 줄이지 못했어요. 최소 용량 96DPI를 시도해 보세요.",
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  expect(downloadCount).toBe(0);

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(
    page
      .getByText(
        "사용 가능한 설정으로는 파일 용량을 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.",
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  expect(downloadCount).toBe(0);
});

test("gives preset-specific guidance when a valid oversized page is unsafe at minimum 96DPI", async ({
  page,
}) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  await uploadPdf(
    page,
    "oversized-page.pdf",
    await createVectorPdf(1, { width: 4_000, height: 4_000 }),
    1,
  );

  const resultRegion = page.getByRole("region", { name: "PDF 압축 결과" });
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(
    resultRegion.getByText(
      "균형 150DPI에서는 페이지가 너무 커요. 최소 용량 96DPI로 낮춰 다시 시도해 주세요.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 60_000 });

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();

  await expect(
    resultRegion.getByText(
      "사용 가능한 최소 96DPI에서도 이 PDF를 안전하게 처리할 수 없어요. 원본을 그대로 사용하거나 페이지 크기나 페이지 수를 줄인 PDF를 다시 준비해 주세요.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expect(resultRegion.getByText(/더 낮은 해상도/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
});

test("reports count-based rendering, encoding, and assembling progress", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("__hereisitCompressionWorkerProgress", "[]");
    const NativeWorker = Worker;
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, argumentsList) {
          const worker = Reflect.construct(Target, argumentsList) as Worker;
          worker.addEventListener("message", (event) => {
            const value = event.data as {
              completedPages?: unknown;
              phase?: unknown;
              totalPages?: unknown;
              type?: unknown;
            };
            if (
              value.type !== "progress" ||
              !["rendering", "encoding", "assembling"].includes(String(value.phase))
            ) {
              return;
            }
            const progress = JSON.parse(
              sessionStorage.getItem("__hereisitCompressionWorkerProgress") ?? "[]",
            ) as unknown[];
            progress.push({
              phase: value.phase,
              completedPages: value.completedPages,
              totalPages: value.totalPages,
            });
            sessionStorage.setItem("__hereisitCompressionWorkerProgress", JSON.stringify(progress));
          });
          return worker;
        },
      }),
    });
  });
  await openReadyPdfCompression(page);
  await uploadPdf(page, "progress.pdf", await createScannedPdf(page, 2), 2);
  await page.evaluate(() => {
    const progress = document.querySelector('[role="progressbar"][aria-label="PDF 압축 진행률"]');
    const observedWindow = window as Window & {
      __hereisitCompressionProgress?: Array<{ label: string | null; value: string | null }>;
    };
    observedWindow.__hereisitCompressionProgress = [];
    if (progress === null) throw new Error("Compression progress element unavailable");
    const record = () => {
      observedWindow.__hereisitCompressionProgress?.push({
        label: progress.getAttribute("aria-valuetext"),
        value: progress.getAttribute("aria-valuenow"),
      });
    };
    new MutationObserver(record).observe(progress, {
      attributes: true,
      attributeFilter: ["aria-valuenow", "aria-valuetext"],
    });
    record();
  });

  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  const states = await page.evaluate(
    () =>
      (
        window as Window & {
          __hereisitCompressionProgress?: Array<{ label: string | null; value: string | null }>;
        }
      ).__hereisitCompressionProgress ?? [],
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("__hereisitCompressionWorkerProgress") ?? "[]"),
    ),
  ).toEqual([
    { phase: "rendering", completedPages: 1, totalPages: 2 },
    { phase: "encoding", completedPages: 1, totalPages: 2 },
    { phase: "assembling", completedPages: 1, totalPages: 2 },
    { phase: "rendering", completedPages: 2, totalPages: 2 },
    { phase: "encoding", completedPages: 2, totalPages: 2 },
    { phase: "assembling", completedPages: 2, totalPages: 2 },
  ]);
  expect(states.some(({ label }) => label === "1/2페이지 다시 만드는 중")).toBe(true);
  expect(states.some(({ label }) => label === "2/2페이지 다시 만드는 중")).toBe(true);
  const numericValues = states.map(({ value }) => Number(value)).filter(Number.isFinite);
  expect(numericValues).toEqual([...numericValues].sort((left, right) => left - right));
  expect(states.at(-1)).toEqual({ label: "압축 완료", value: "100" });
});

test("hard-rejects page counts outside the advisory limit without preflighting MediaBox geometry", async ({
  page,
}) => {
  await openReadyPdfCompression(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "too-many.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf(101),
  });
  await expect(
    page.getByText("PDF는 1페이지부터 100페이지까지 압축할 수 있어요.").first(),
  ).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await expect(page.getByRole("button", { name: "PDF 용량 줄이기 →" })).toBeDisabled();

  await uploadPdf(
    page,
    "unusual-media-box.pdf",
    await createVectorPdf(1, { width: 3_933.6, height: 72 }),
    1,
  );
  await expect(page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" })).toBeEnabled();
});

test("invalidates and revokes results on preset change, rerun, replacement, reset, and unmount", async ({
  page,
}) => {
  await installObjectUrlCounters(page);
  await prepareCompressedResult(page);
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await expect(page.getByText("압축 PDF 준비 완료")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toHaveCount(0);
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 2, revoked: 1 });

  await page.getByRole("button", { name: "같은 설정으로 다시 실행" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 3, revoked: 2 });

  const replacement = await createScannedPdf(page);
  await uploadPdf(page, "replacement.pdf", replacement, 1);
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 3, revoked: 3 });
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 4, revoked: 3 });

  await page.getByRole("button", { name: "새 작업" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 4, revoked: 4 });
  await uploadPdf(page, "unmount.pdf", replacement, 1);
  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
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
});

test("cancels immediately without exposing a partial result or download", async ({ page }) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await uploadPdf(page, "scan.pdf", await createScannedPdf(page, 2), 2);
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

  await page.getByRole("button", { name: "2페이지 PDF 용량 줄이기 →" }).click();
  await page.getByRole("button", { name: "작업 중단" }).click();
  await page.evaluate(() => {
    (window as Window & { __hereisitReleaseFrames?: () => void }).__hereisitReleaseFrames?.();
  });
  await settleRenderedState(page);
  await expect(page.getByText("PDF 압축을 중단했어요.").first()).toBeVisible();
  await expect(page.getByText("압축 PDF 준비 완료")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toHaveCount(0);
  expect(downloadCount).toBe(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
});

test("ignores a fulfilled share after reset invalidates its result URL", async ({ page }) => {
  await installPendingShare(page);
  await prepareCompressedResult(page);

  await page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click();
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

  await expect(page.getByText("파일을 선택하면 페이지를 확인할게요.").first()).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("__hereisitDownloadClicks"))).toBe("0");
});

test("does not download a revoked result when a pending share rejects after reset", async ({
  page,
}) => {
  await installPendingShare(page);
  await prepareCompressedResult(page);

  await page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click();
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

  await expect(page.getByText("파일을 선택하면 페이지를 확인할게요.").first()).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("__hereisitDownloadClicks"))).toBe("0");
});
