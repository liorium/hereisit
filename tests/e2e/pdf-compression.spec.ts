import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  degrees,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  rgb,
} from "@cantoo/pdf-lib";
import { expect, type Page, test } from "@playwright/test";
import { installPrivacyObserver } from "./support/privacy-observer";
import {
  expectWebShareUnused,
  installAvailableWebShare,
  installDownloadActivationController,
  setDownloadActivationBlocked,
} from "./support/result-download";

const PDF_COMPRESSION_ROUTE = "/pdf/compress";
const PDF_INSPECTION_TIMEOUT_MS = 60_000;
const SMART_COMPRESSION_NOTICE =
  "텍스트와 링크는 유지하고, 이미지로만 된 스캔 PDF는 선택한 압축 수준으로 다시 만들어요. 전자서명은 무효가 될 수 있으며 원본 파일은 수정하지 않아요.";
const UNSUPPORTED_BROWSER_MESSAGE = "이 브라우저는 로컬 PDF 압축을 지원하지 않아요.";
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

async function createCompressibleStructuredPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < 12; index += 1) {
    const page = document.addPage([612, 792]);
    for (let row = 0; row < 20; row += 1) {
      page.drawRectangle({
        x: 24,
        y: 24 + row * 32,
        width: 564,
        height: 16,
        color: rgb(0.15, 0.35, 0.8),
      });
    }
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function structurallyRewritePdf(source: Buffer): Promise<Buffer> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  return Buffer.from(
    await document.save({ useObjectStreams: true, updateFieldAppearances: false }),
  );
}

async function forceLocalNoReduction(
  page: Page,
  reason: "STRUCTURED_OR_MIXED" | "IMAGE_ONLY_NO_SAVINGS" = "STRUCTURED_OR_MIXED",
): Promise<void> {
  await page.addInitScript((noReductionReason) => {
    const NativeWorker = Worker;
    class NoReductionWorker extends EventTarget {
      onerror: ((event: ErrorEvent) => unknown) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;

      constructor() {
        super();
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "ready",
                capabilities: {
                  offscreenCanvas: true,
                  jpegEncoder: true,
                  pdfjsWorker: true,
                  pdfAssembly: true,
                },
                error: null,
              },
            }),
          );
        });
      }

      postMessage(value: unknown) {
        const request = value as { jobId?: unknown; type?: unknown };
        if (request.type !== "run" || typeof request.jobId !== "string") return;
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "failed",
                jobId: request.jobId,
                error: {
                  code: "NO_SIZE_REDUCTION",
                  message: "PDF 용량을 1% 이상 줄이지 못했어요.",
                  reason: noReductionReason,
                  retryable: false,
                },
              },
            }),
          );
        });
      }

      terminate() {}
    }

    class FailedVerificationWorker extends EventTarget {
      onerror: ((event: ErrorEvent) => unknown) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;

      constructor() {
        super();
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: { protocol: 1, type: "ready" },
            }),
          );
        });
      }

      postMessage(value: unknown) {
        const request = value as { jobId?: unknown; type?: unknown };
        if (request.type !== "verify" || typeof request.jobId !== "string") return;
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "failed",
                jobId: request.jobId,
                error: { code: "VERIFICATION_FAILED" },
              },
            }),
          );
        });
      }

      terminate() {}
    }

    class LateVerificationWorker extends EventTarget {
      onerror: ((event: ErrorEvent) => unknown) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null = null;
      private verification: { descriptor: unknown; jobId: string; result: File } | undefined;

      constructor() {
        super();
        queueMicrotask(() => {
          this.onmessage?.(new MessageEvent("message", { data: { protocol: 1, type: "ready" } }));
        });
      }

      postMessage(value: unknown) {
        const request = value as {
          descriptor?: unknown;
          jobId?: unknown;
          result?: unknown;
          type?: unknown;
        };
        if (
          request.type === "verify" &&
          typeof request.jobId === "string" &&
          request.result instanceof File
        ) {
          this.verification = {
            descriptor: request.descriptor,
            jobId: request.jobId,
            result: request.result,
          };
          sessionStorage.setItem("__hereisitPdfVerificationPosted", "1");
          return;
        }
        if (request.type !== "cancel" || this.verification === undefined) return;
        const verification = this.verification;
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: { protocol: 1, type: "cancelled", jobId: verification.jobId },
            }),
          );
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                protocol: 1,
                type: "complete",
                jobId: verification.jobId,
                descriptor: verification.descriptor,
                blob: verification.result,
              },
            }),
          );
        });
      }

      terminate() {}
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, argumentsList) {
          const options = argumentsList[1] as WorkerOptions | undefined;
          const names = JSON.parse(
            sessionStorage.getItem("__hereisitPdfWorkerNames") ?? "[]",
          ) as string[];
          names.push(options?.name ?? "unnamed");
          sessionStorage.setItem("__hereisitPdfWorkerNames", JSON.stringify(names));
          if (options?.name === "hereisit-pdf-compress-scanned-worker") {
            return new NoReductionWorker() as unknown as Worker;
          }
          if (
            options?.name === "hereisit-pdf-optimize-verifier" &&
            sessionStorage.getItem("__hereisitFailPdfVerification") === "1"
          ) {
            return new FailedVerificationWorker() as unknown as Worker;
          }
          if (
            options?.name === "hereisit-pdf-optimize-verifier" &&
            sessionStorage.getItem("__hereisitLatePdfVerification") === "1"
          ) {
            return new LateVerificationWorker() as unknown as Worker;
          }
          return Reflect.construct(Target, argumentsList);
        },
      }),
    });
  }, reason);
}

async function createScannedPdf(
  page: Page,
  pageCount = 1,
  pageSize: { width: number; height: number } = { width: 612, height: 792 },
): Promise<Buffer> {
  const encodedJpeg = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 800;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Test canvas unavailable");

    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#f4efe6");
    gradient.addColorStop(1, "#9aa8bd");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#24364f";
    for (let row = 0; row < 50; row += 1) {
      context.beginPath();
      context.moveTo(20, 170 + row * 10);
      context.lineTo(canvas.width - 20, 170 + row * 10);
      context.stroke();
    }
    context.fillStyle = "#141fe6";
    context.fillRect(0, 0, canvas.width, 80);
    context.fillStyle = "#e61414";
    context.fillRect(0, canvas.height - 80, canvas.width, 80);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1] ?? "";
  });

  const document = await PDFDocument.create();
  document.setTitle(SOURCE_TITLE);
  document.setAuthor(SOURCE_AUTHOR);
  const scan = await document.embedJpg(Buffer.from(encodedJpeg, "base64"));
  for (let index = 0; index < 8; index += 1) {
    await document.embedJpg(Buffer.from(encodedJpeg, "base64"));
  }
  for (let index = 0; index < pageCount; index += 1) {
    const outputPage = document.addPage([pageSize.width, pageSize.height]);
    outputPage.drawImage(
      scan,
      index % 2 === 0
        ? { x: 0, y: 0, width: pageSize.width, height: pageSize.height }
        : {
            x: pageSize.width,
            y: pageSize.height,
            width: pageSize.width,
            height: pageSize.height,
            rotate: degrees(180),
          },
    );
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

type PdfServerScenario = "download" | "original-retained" | "pending";

async function installPdfServerDouble(
  page: Page,
  input: {
    acknowledgement?: "hold" | "reject" | "succeed";
    source: Buffer;
    output: Buffer;
    scenario?: PdfServerScenario;
  },
): Promise<{
  acknowledgementOutcomes: Array<"rejected" | "succeeded">;
  calls: string[];
  jobId: string;
  releaseAcknowledgement(): void;
  releaseStatus(): void;
  statusDelivered: Promise<void>;
}> {
  const jobId = "123e4567-e89b-42d3-a456-426614174101";
  const lease = "a".repeat(43);
  const digest = createHash("sha256").update(input.output).digest("base64");
  const acknowledgementOutcomes: Array<"rejected" | "succeeded"> = [];
  const calls: string[] = [];
  let releaseStatus = () => undefined;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let markStatusDelivered = () => undefined;
  const statusDelivered = new Promise<void>((resolve) => {
    markStatusDelivered = resolve;
  });
  let releaseAcknowledgement = () => undefined;
  const acknowledgementGate = new Promise<void>((resolve) => {
    releaseAcknowledgement = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    if (path === "/v1/analytics/events") {
      await route.fulfill({ status: 204 });
      return;
    }
    calls.push(call);
    if (call === "POST /v1/policy") {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          toolContract: "pdf.optimize@1",
          execution: "server",
          reason: null,
          maintainer: true,
          disclosure: {
            upload: true,
            inputDeletion: "terminal",
            resultDeletion: {
              mode: "server-temporary",
              acknowledged: "immediate-delete-attempt",
              unacknowledgedDueSeconds: 1800,
              applicationSloSeconds: 2100,
              lifecycleExpirationDays: 1,
              exceptionalDelayPossible: true,
            },
          },
          limits: {
            maxFiles: 1,
            maxBytesPerFile: 50 * 1024 * 1024,
            maxPagesPerFile: 100,
          },
        },
      });
      return;
    }
    if (call === "POST /v1/jobs") {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          mode: "upload-required",
          jobId,
          upload: {
            kind: "worker-stream-put",
            method: "PUT",
            path: `/v1/jobs/${jobId}/input`,
            contentType: "application/pdf",
            byteLength: input.source.byteLength,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          reservedWeightedUnits: 1,
        },
      });
      return;
    }
    if (call === `PUT /v1/jobs/${jobId}/input`) {
      await route.fulfill({ status: 204 });
      return;
    }
    if (call === `GET /v1/jobs/${jobId}`) {
      if (input.scenario === "pending") await statusGate;
      const result =
        input.scenario === "original-retained"
          ? {
              kind: "original-retained",
              sourceByteLength: input.source.byteLength,
              pageCount: 12,
              engineBuildId: "test-qpdf-12.4.0",
              warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
            }
          : {
              kind: "download",
              mime: "application/pdf",
              sourceByteLength: input.source.byteLength,
              byteLength: input.output.byteLength,
              pageCount: 12,
              profile: "structural",
              engineBuildId: "test-qpdf-12.4.0",
              warnings: ["SIGNATURES_INVALIDATED"],
            };
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          jobId,
          state: "succeeded",
          phase: "completed",
          phaseFraction: 1,
          sequence: 1,
          attempt: 1,
          updatedAt: "2026-08-12T00:00:00.000Z",
          result,
        },
      });
      markStatusDelivered();
      return;
    }
    if (call === `GET /v1/jobs/${jobId}/result`) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-length": String(input.output.byteLength),
          "content-type": "application/pdf",
          digest: `sha-256=${digest}`,
          "x-download-lease": lease,
        },
        body: input.output,
      });
      return;
    }
    if (call === `POST /v1/jobs/${jobId}/downloaded`) {
      await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible();
      await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
      if (input.acknowledgement === "hold") await acknowledgementGate;
      await route.fulfill({
        status: input.acknowledgement === "reject" ? 503 : 200,
        contentType: "text/plain",
        body: "ok",
      });
      acknowledgementOutcomes.push(input.acknowledgement === "reject" ? "rejected" : "succeeded");
      return;
    }
    if (call === `POST /v1/jobs/${jobId}/cancel` || call === `DELETE /v1/jobs/${jobId}`) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    await route.abort("blockedbyclient");
  });

  return {
    acknowledgementOutcomes,
    calls,
    jobId,
    releaseAcknowledgement,
    releaseStatus,
    statusDelivered,
  };
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
): Promise<Awaited<ReturnType<typeof installPrivacyObserver>>> {
  const privacy = await installPrivacyObserver(page);
  await openReadyPdfCompression(page);
  await uploadPdf(page, "scan.pdf", await createScannedPdf(page), 1);
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
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

async function expectMobileCompressionStage(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const buttons = page.getByRole("region", { name: "파일 작업 영역" }).locator("button");
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    if (box !== null) expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

test("detects a sentinel filename hidden in a structured console argument", async ({ page }) => {
  const sentinelFilename = "PRIVATE_STRUCTURED_CONSOLE_SENTINEL.pdf";
  const privacy = await installPrivacyObserver(page, { sentinels: [sentinelFilename] });
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
  const privacy = await installPrivacyObserver(page, {
    sentinels: ["PRIVATE_WIDE_CONTAINER_SENTINEL"],
  });
  await openReadyPdfCompression(page);

  await page.evaluate(() => {
    const trackedWindow = window as Window & { __hereisitWideOwnKeysCalls?: number };
    trackedWindow.__hereisitWideOwnKeysCalls = 0;
    const wideArray = new Proxy(
      Array.from({ length: 100_001 }, () => null),
      {
        ownKeys(target) {
          trackedWindow.__hereisitWideOwnKeysCalls =
            (trackedWindow.__hereisitWideOwnKeysCalls ?? 0) + 1;
          return Reflect.ownKeys(target);
        },
      },
    );
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

test("keeps console inspection fail-closed for accessors", async ({ page }) => {
  const sentinel = "PRIVATE_ACCESSOR_SENTINEL";
  const privacy = await installPrivacyObserver(page, { sentinels: [sentinel] });
  await openReadyPdfCompression(page);

  await page.evaluate((privateValue) => {
    const nested = Object.defineProperty({}, "privateValue", {
      configurable: true,
      get: () => privateValue,
    });
    console.log({ nested });
  }, sentinel);

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  const diagnostics = String(detectionError);
  expect(diagnostics).toContain("console-inspection-failed");
  expect(diagnostics).not.toContain(sentinel);
});

test("observes deliberate privacy probes without exposing their raw values", async ({ page }) => {
  const sentinelFilename = "PRIVATE_OBSERVER_FILENAME_SENTINEL.pdf";
  const sentinelValue = "PRIVATE_OBSERVER_VALUE_SENTINEL";
  const privacy = await installPrivacyObserver(page, {
    fulfillProbePathPrefix: "/privacy-observer-",
    origin: "http://localhost:4173",
    sentinels: [sentinelFilename, sentinelValue],
  });
  await openReadyPdfCompression(page);
  await privacy.clear();

  const probeResults = await page.evaluate(
    async ({ filename, value }) => {
      console.log({ filename, value });
      window.localStorage.setItem(filename, value);
      const objectUrl = URL.createObjectURL(new File([value], filename));
      URL.revokeObjectURL(objectUrl);

      const fetchResponse = await fetch("/privacy-observer-fetch-probe", {
        method: "POST",
        body: value,
      });
      const xhrStatus = await new Promise<number>((resolve) => {
        const request = new XMLHttpRequest();
        request.addEventListener("loadend", () => resolve(request.status), { once: true });
        request.open("PUT", "/privacy-observer-xhr-probe");
        request.send(value);
      });
      const beaconAccepted = navigator.sendBeacon("/privacy-observer-beacon-probe", value);
      const externalResponse = await fetch("/privacy-observer-external-probe");
      return {
        beaconAccepted,
        externalStatus: externalResponse.status,
        fetchStatus: fetchResponse.status,
        xhrStatus,
      };
    },
    { filename: sentinelFilename, value: sentinelValue },
  );
  expect(probeResults).toEqual({
    beaconAccepted: true,
    externalStatus: 204,
    fetchStatus: 204,
    xhrStatus: 204,
  });

  await expect
    .poll(async () => (await privacy.read()).writeRequests.length)
    .toBeGreaterThanOrEqual(3);
  const observation = await privacy.read();
  expect(observation.externalRequests).toContain("GET cross-origin");
  expect(observation.writeRequests).toHaveLength(3);
  expect(
    observation.writeRequests.filter((request) => request === "POST cross-origin"),
  ).toHaveLength(2);
  expect(
    observation.writeRequests.filter((request) => request === "PUT cross-origin"),
  ).toHaveLength(1);
  expect(observation.consoleMessages).toContain("log");
  expect(observation.storageWrites).toContain("localStorage:set");
  expect(observation.objectUrls).toContain("blob-url-created");

  const diagnostics = JSON.stringify(observation);
  for (const privateValue of [
    sentinelFilename,
    sentinelValue,
    "privacy-observer-fetch-probe",
    "privacy-observer-xhr-probe",
    "privacy-observer-beacon-probe",
    "blob:",
  ]) {
    expect(diagnostics).not.toContain(privateValue);
  }

  await page.evaluate((key) => window.localStorage.removeItem(key), sentinelFilename);
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), sentinelFilename),
  ).toBeNull();
  await privacy.clear();
  expect(await privacy.read()).toEqual({
    requestCount: 0,
    externalRequests: [],
    writeRequests: [],
    consoleMessages: [],
    storageWrites: [],
    objectUrls: [],
    productEvents: [],
  });
  await privacy.assertClean(0, false);
});

test("assertClean rejects a deliberate network violation and detaches its hooks", async ({
  page,
}) => {
  const privacy = await installPrivacyObserver(page, { origin: "http://localhost:4173" });
  await openReadyPdfCompression(page);
  await privacy.clear();

  await page.evaluate(() => fetch("/privacy-observer-assert-probe"));
  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  expect(String(detectionError)).toContain("cross-origin");

  const observedBeforeCleanupCheck = (await privacy.read()).requestCount;
  await page.evaluate(() => fetch("/privacy-observer-after-cleanup"));
  await page.waitForTimeout(50);
  expect((await privacy.read()).requestCount).toBe(observedBeforeCleanupCheck);
});

test("detects an encoded history sentinel without exposing it in diagnostics", async ({ page }) => {
  const sentinel = "PRIVATE ENCODED HISTORY SENTINEL";
  const privacy = await installPrivacyObserver(page, { sentinels: [sentinel] });
  await openReadyPdfCompression(page);
  await privacy.clear();

  await page.evaluate((privateValue) => {
    history.pushState({ privateValue }, "", "/pdf/compress?malformed=%E0%A4%A");
    history.replaceState(
      { privateValue: encodeURIComponent(privateValue) },
      "",
      `/pdf/compress?private=${encodeURIComponent(privateValue)}`,
    );
  }, sentinel);

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  const diagnostics = String(detectionError);
  expect(diagnostics).toContain("history-url");
  expect(diagnostics).toContain("history-state");
  expect(diagnostics).not.toContain(sentinel);
  expect(diagnostics).not.toContain(encodeURIComponent(sentinel));
});

test("bounds a wide history state before enumerating its values", async ({ page }) => {
  const privacy = await installPrivacyObserver(page);
  await openReadyPdfCompression(page);
  await privacy.clear();

  await page.evaluate(() => {
    const trackedWindow = window as Window & { __hereisitHistoryOwnKeysCalls?: number };
    trackedWindow.__hereisitHistoryOwnKeysCalls = 0;
    const wideArray = new Proxy(new Array(100_001), {
      ownKeys(target) {
        trackedWindow.__hereisitHistoryOwnKeysCalls =
          (trackedWindow.__hereisitHistoryOwnKeysCalls ?? 0) + 1;
        return Reflect.ownKeys(target);
      },
    });
    try {
      history.pushState({ nested: wideArray }, "", "/pdf/compress?wide-history-state=1");
    } catch {
      // Proxies are intentionally not structured-cloneable; the observer must bound first.
    }
  });

  let detectionError: unknown;
  try {
    await privacy.assertClean(0, false);
  } catch (error) {
    detectionError = error;
  }
  expect(String(detectionError)).toContain("history-state-inspection-failed");
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __hereisitHistoryOwnKeysCalls?: number })
          .__hereisitHistoryOwnKeysCalls,
    ),
  ).toBe(0);
});

test("shows only the file-selection step before a PDF is ready", async ({ page }) => {
  await openReadyPdfCompression(page);
  await expect(page.getByRole("heading", { level: 2, name: "PDF 용량 줄이기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "PDF 압축 결과" })).toHaveCount(0);
  await expect(
    page.getByText("PDF 1개 · 최대 50MB · 최대 100페이지", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("파일은 이 기기에서만 처리돼요.", { exact: true })).toBeVisible();
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

test("keeps full PDF reads off the UI thread during inspection and compression", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("__hereisitUiThreadPdfReads", "0");
    const originalArrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function arrayBuffer() {
      const count = Number(sessionStorage.getItem("__hereisitUiThreadPdfReads") ?? "0");
      sessionStorage.setItem("__hereisitUiThreadPdfReads", String(count + 1));
      return Reflect.apply(originalArrayBuffer, this, []);
    };
  });
  await openReadyPdfCompression(page);
  await uploadPdf(page, "scan.pdf", await createScannedPdf(page), 1);

  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });

  expect(await page.evaluate(() => sessionStorage.getItem("__hereisitUiThreadPdfReads"))).toBe("0");
});

test("compresses a known scan with the default preset and downloads only after one explicit download", async ({
  browserName,
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 720 });
  await installAvailableWebShare(page);
  await installObjectUrlCounters(page);
  const privacySentinel = "PRIVATE_SCAN_SENTINEL";
  const privacy = await installPrivacyObserver(page, {
    sentinels: [privacySentinel, SOURCE_TITLE, SOURCE_AUTHOR],
  });
  await openReadyPdfCompression(page);
  await expectMobileCompressionStage(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  const source = await createScannedPdf(page, 2);
  await uploadPdf(page, `${privacySentinel}.pdf`, source, 2);
  const setup = page.getByRole("region", { name: "PDF 압축 설정" });
  await expect(setup).toBeVisible();
  await expectMobileCompressionStage(page);
  await expect(setup.getByRole("radio", { name: /균형 150DPI/ })).toBeChecked();
  await expect(setup.getByText(SMART_COMPRESSION_NOTICE, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "2페이지 용량 줄이기" })).toBeEnabled();
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText(/^\d+(?:\.\d+)?(?:B|KB|MB) → \d+(?:\.\d+)?(?:B|KB|MB)$/),
  ).toBeVisible();
  await expect(page.getByText(/^\d+% 줄었어요$/)).toBeVisible();
  await expect(page.getByText("스캔 페이지를 가볍게 다시 만들었어요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "다른 PDF 압축" })).toBeVisible();
  await expect(page.getByText("처리 시간", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "같은 설정으로 다시 실행" })).toHaveCount(0);
  await expectMobileCompressionStage(page);
  await settleRenderedState(page);
  expect(downloadCount).toBe(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });
  expect(await resultObjectUrlMime(page)).toBe("application/pdf");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("PRIVATE_SCAN_SENTINEL-compressed-hereisit.pdf");
  expect(downloadCount).toBe(1);
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await expectWebShareUnused(page);
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

test("preserves a structured PDF and explains the result before download", async ({ page }) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  const source = await createCompressibleStructuredPdf();
  await uploadPdf(page, "structured.pdf", source, 12);

  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("텍스트와 링크를 유지했어요.")).toBeVisible();
  expect(await objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  expectCompletePdfEnvelope(output);
  expect(output.byteLength).toBeLessThanOrEqual(exactCompressionTarget(source.byteLength));
  expect((await inspectPdfOutput(output)).imageDimensions).toEqual([]);
});

test("makes the same Letter scan smaller with the minimum preset and preserves output structure", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await installAvailableWebShare(page);
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  const source = await createScannedPdf(page, 2);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await uploadPdf(page, "report.pdf", source, 2);

  await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  expect(downloadCount).toBe(0);
  const [balancedDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(balancedDownload.suggestedFilename()).toBe("report-compressed-hereisit.pdf");
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await expectWebShareUnused(page);
  const balanced = await downloadedBytes(await balancedDownload.path());

  await page.getByRole("button", { name: "다른 PDF 압축" }).click();
  await uploadPdf(page, "report.pdf", source, 2);
  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  expect(downloadCount).toBe(1);
  expect(await resultObjectUrlMime(page)).toBe("application/pdf");

  const [minimumDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(minimumDownload.suggestedFilename()).toBe("report-compressed-hereisit.pdf");
  expect(downloadCount).toBe(2);
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await expectWebShareUnused(page);
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

test("keeps a compressed PDF result retryable when download activation fails", async ({
  browserName,
  page,
}) => {
  test.setTimeout(90_000);
  await installDownloadActivationController(page);
  const privacy = await test.step("prepare compressed result", () => prepareCompressedResult(page));
  await test.step("keep the result after blocked activation", async () => {
    await setDownloadActivationBlocked(page, true);
    await page.getByRole("button", { name: "PDF 다운로드 ↓" }).click();
    await expect(page.getByRole("status")).toContainText(
      "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
    );
    await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
  });

  const download = await test.step(
    "activate the retry download",
    async () => {
      await setDownloadActivationBlocked(page, false);
      const [activatedDownload] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
      ]);
      expect(activatedDownload.suggestedFilename()).toBe("scan-compressed-hereisit.pdf");
      await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
      return activatedDownload;
    },
    { timeout: 20_000 },
  );
  await test.step(
    "read the completed retry download",
    async () => expectCompletePdfEnvelope(await downloadedBytes(await download.path())),
    { timeout: 20_000 },
  );
  await test.step(
    "verify retry privacy invariants",
    () => privacy.assertClean(1, browserName !== "firefox"),
    { timeout: 20_000 },
  );
});

test("keeps structure when neither preset can safely reduce the file", async ({ page }) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await uploadPdf(page, "vector.pdf", await createVectorPdf(1, { width: 612, height: 792 }), 1);

  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(
    page
      .getByText(
        "텍스트와 링크를 유지하면서는 용량을 1% 이상 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.",
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  expect(downloadCount).toBe(0);

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(
    page
      .getByText(
        "텍스트와 링크를 유지하면서는 용량을 1% 이상 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.",
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  expect(downloadCount).toBe(0);
});

test("contacts the PDF processing server only after the explicit fallback action", async ({
  page,
}) => {
  const serverRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/analytics/events") {
      await route.fulfill({ status: 204 });
      return;
    }
    serverRequests.push(`${request.method()} ${path}`);
    if (path === "/v1/policy") {
      await route.fulfill({
        status: 200,
        json: {
          contract: "tool-job@1",
          toolContract: "pdf.optimize@1",
          execution: "local",
          reason: "LOCAL_FALLBACK_REQUIRED",
          maintainer: false,
          disclosure: {
            upload: false,
            inputDeletion: "not-uploaded",
            resultDeletion: { mode: "not-uploaded" },
          },
          limits: {
            maxFiles: 1,
            maxBytesPerFile: 50 * 1024 * 1024,
            maxPagesPerFile: 100,
          },
        },
      });
      return;
    }
    await route.abort("blockedbyclient");
  });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "vector.pdf", await createVectorPdf(1, { width: 612, height: 792 }), 1);
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();

  const fallback = page.getByRole("button", { name: "처리 서버에서 더 압축" });
  await expect(fallback).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText("PDF를 HereIsIt 처리 서버로 보내며, 처리가 끝나면 자동으로 삭제해요."),
  ).toBeVisible();
  expect(serverRequests).toEqual([]);

  await fallback.click();
  await expect.poll(() => serverRequests).toEqual(["POST /v1/policy"]);
  await expect(
    page.getByText("현재 처리 서버를 사용할 수 없어요. 잠시 후 다시 시도해 주세요."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "처리 서버에서 더 압축" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
});

test("does not offer or contact the server for an image-only no-savings result", async ({
  page,
}) => {
  await forceLocalNoReduction(page, "IMAGE_ONLY_NO_SAVINGS");
  const serverRequests: string[] = [];
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/analytics/events") {
      await route.fulfill({ status: 204 });
      return;
    }
    serverRequests.push(`${route.request().method()} ${path}`);
    await route.abort("blockedbyclient");
  });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "scan.pdf", await createVectorPdf(1), 1);
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();

  await expect(
    page.getByText(
      "텍스트와 링크를 유지하면서는 용량을 1% 이상 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "처리 서버에서 더 압축" })).toHaveCount(0);
  expect(serverRequests).toEqual([]);
});

test("exposes a server PDF only after browser verification and direct download", async ({
  browserName,
  page,
}) => {
  test.setTimeout(90_000);
  const privacy = await installPrivacyObserver(page, {
    allowProcessingRequests: true,
    sentinels: ["server-source.pdf"],
  });
  await forceLocalNoReduction(page);
  await installObjectUrlCounters(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  expect(output.byteLength).toBeLessThanOrEqual(exactCompressionTarget(source.byteLength));
  const server = await installPdfServerDouble(page, { source, output });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "server-source.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  const fallback = page.getByRole("button", { name: "처리 서버에서 더 압축" });
  await expect(fallback).toBeVisible();
  expect(server.calls).toEqual([]);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("__hereisitPdfWorkerNames") ?? "[]"),
    ),
  ).not.toContain("hereisit-pdf-optimize-verifier");

  await fallback.click();
  await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("처리 서버에서 문서 구조를 유지하며 압축했어요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("__hereisitPdfWorkerNames") ?? "[]"),
    ),
  ).toContain("hereisit-pdf-optimize-verifier");
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });
  await expect.poll(() => server.calls).toContain(`POST /v1/jobs/${server.jobId}/downloaded`);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("server-source-compressed-hereisit.pdf");
  expectCompletePdfEnvelope(await downloadedBytes(await download.path()));

  await page.getByRole("button", { name: "다른 PDF 압축" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  await page.evaluate(() => sessionStorage.setItem("__hereisitFailPdfVerification", "1"));
  server.calls.length = 0;
  await uploadPdf(page, "server-source.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect(
    page.getByText("PDF 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요."),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "처리 서버에서 더 압축" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  await privacy.assertClean(1, browserName !== "firefox");
});

test("keeps original-retained mobile fallback keyboard-accessible and allows a new selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await forceLocalNoReduction(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, {
    source,
    output,
    scenario: "original-retained",
  });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "retained.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  const fallback = page.getByRole("button", { name: "처리 서버에서 더 압축" });
  await expect(fallback).toBeVisible();
  await fallback.focus();
  await expect(fallback).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("처리 서버에서도 더 줄이지 못해 원본을 그대로 유지해요."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  const chooserReady = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "PDF 교체" }).click();
  const chooser = await chooserReady;
  await chooser.setFiles({
    name: "replacement.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf(1),
  });
  await expect(page.getByText("replacement.pdf")).toBeVisible();
});

test("cancels and deletes a created server job while ignoring its late status", async ({
  page,
}) => {
  await forceLocalNoReduction(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, { source, output, scenario: "pending" });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "cancel.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect.poll(() => server.calls).toContain(`GET /v1/jobs/${server.jobId}`);
  await page.getByRole("button", { name: "중단" }).click();
  server.releaseStatus();

  await expect(page.getByText("PDF 압축을 중단했어요.")).toBeVisible();
  await expect.poll(() => server.calls).toContain(`POST /v1/jobs/${server.jobId}/cancel`);
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
});

test("replaces a pending remote job and ignores its late successful status", async ({ page }) => {
  await forceLocalNoReduction(page);
  await installObjectUrlCounters(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, { source, output, scenario: "pending" });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "pending-old.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect.poll(() => server.calls).toContain(`GET /v1/jobs/${server.jobId}`);

  await page.locator('input[type="file"]').setInputFiles({
    name: "replacement.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf(1),
  });
  await expect.poll(() => server.calls).toContain(`POST /v1/jobs/${server.jobId}/cancel`);
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  server.releaseStatus();
  await server.statusDelivered;
  await settleRenderedState(page);

  await expect(page.getByText("replacement.pdf")).toBeVisible();
  await expect(page.getByText("pending-old.pdf")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
});

test("ignores late verifier completion after cancellation and deletes the result", async ({
  page,
}) => {
  await forceLocalNoReduction(page);
  await installObjectUrlCounters(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, { source, output });

  await openReadyPdfCompression(page);
  await page.evaluate(() => sessionStorage.setItem("__hereisitLatePdfVerification", "1"));
  await uploadPdf(page, "late-verifier.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("__hereisitPdfVerificationPosted")))
    .toBe("1");
  await page.getByRole("button", { name: "중단" }).click();

  await expect(page.getByText("PDF 압축을 중단했어요.")).toBeVisible();
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  expect(server.calls).not.toContain(`POST /v1/jobs/${server.jobId}/downloaded`);
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
});

test("deletes an unacknowledged result when reload navigation unmounts after acknowledgement fails", async ({
  page,
}) => {
  await forceLocalNoReduction(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, {
    source,
    output,
    acknowledgement: "reject",
  });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "ack-race.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect.poll(() => server.calls).toContain(`POST /v1/jobs/${server.jobId}/downloaded`);
  await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
  await expect.poll(() => server.acknowledgementOutcomes).toEqual(["rejected"]);
  await settleRenderedState(page);

  const reload = page.reload();
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  await reload;
});

test("resets and deletes an unacknowledged result while acknowledgement is pending", async ({
  page,
}) => {
  await forceLocalNoReduction(page);
  const source = await createCompressibleStructuredPdf();
  const output = await structurallyRewritePdf(source);
  const server = await installPdfServerDouble(page, {
    source,
    output,
    acknowledgement: "hold",
  });

  await openReadyPdfCompression(page);
  await uploadPdf(page, "reset-race.pdf", source, 12);
  await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
  await expect.poll(() => server.calls).toContain(`POST /v1/jobs/${server.jobId}/downloaded`);
  await page.getByRole("button", { name: "다른 PDF 압축" }).click();

  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
  await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
  server.releaseAcknowledgement();
});

test.describe("rejected server-result acknowledgement cleanup", () => {
  for (const cleanup of ["reset", "navigation-unmount"] as const) {
    test(`deletes and revokes the result after ${cleanup}`, async ({ page }) => {
      await forceLocalNoReduction(page);
      await installObjectUrlCounters(page);
      const source = await createCompressibleStructuredPdf();
      const output = await structurallyRewritePdf(source);
      const server = await installPdfServerDouble(page, {
        acknowledgement: "reject",
        source,
        output,
      });

      await openReadyPdfCompression(page);
      await uploadPdf(page, "ack-reject.pdf", source, 12);
      await page.getByRole("button", { name: "12페이지 용량 줄이기" }).click();
      await page.getByRole("button", { name: "처리 서버에서 더 압축" }).click();
      await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toBeVisible();
      await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
      await expect.poll(() => server.acknowledgementOutcomes).toEqual(["rejected"]);
      await settleRenderedState(page);
      expect(await objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });

      if (cleanup === "reset") {
        await page.getByRole("button", { name: "다른 PDF 압축" }).click();
        await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
      } else {
        await page.locator('a[href="/"]').first().click();
        await expect(page).toHaveURL(/\/$/);
      }

      await expect.poll(() => server.calls).toContain(`DELETE /v1/jobs/${server.jobId}`);
      await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
      await expect(page.getByRole("heading", { name: "용량 줄이기 완료" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
    });
  }
});

test("gives preset-specific guidance when a valid oversized page is unsafe at minimum 96DPI", async ({
  page,
}) => {
  await installObjectUrlCounters(page);
  await openReadyPdfCompression(page);
  await uploadPdf(
    page,
    "oversized-page.pdf",
    await createScannedPdf(page, 1, { width: 4_000, height: 4_000 }),
    1,
  );

  const setup = page.getByRole("region", { name: "PDF 압축 설정" });
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(
    setup.getByText(
      "균형 150DPI에서는 페이지가 너무 커요. 최소 용량 96DPI로 낮춰 다시 시도해 주세요.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 60_000 });

  await page.getByRole("radio", { name: /최소 용량 96DPI/ }).check();
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();

  await expect(
    setup.getByText(
      "사용 가능한 최소 96DPI에서도 이 PDF를 안전하게 처리할 수 없어요. 원본을 그대로 사용하거나 페이지 크기나 페이지 수를 줄인 PDF를 다시 준비해 주세요.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText(/더 낮은 해상도/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
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
  await expect(page.getByRole("progressbar", { name: "PDF 압축 진행률" })).toHaveCount(0);
  await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
  await expect(page.getByRole("progressbar", { name: "PDF 압축 진행률" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
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
  await expect(page.getByRole("button", { name: /페이지 용량 줄이기/ })).toHaveCount(0);

  await uploadPdf(
    page,
    "unusual-media-box.pdf",
    await createVectorPdf(1, { width: 3_933.6, height: 72 }),
    1,
  );
  await expect(page.getByRole("button", { name: "1페이지 용량 줄이기" })).toBeEnabled();
});

test("revokes results when starting another PDF and leaving the tool", async ({ page }) => {
  test.setTimeout(90_000);
  await installObjectUrlCounters(page);
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await prepareCompressedResult(page);
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 0 });
  expect(downloads).toBe(0);

  await page.getByRole("button", { name: "다른 PDF 압축" }).click();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 1, revoked: 1 });
  expect(downloads).toBe(0);

  const replacement = await createScannedPdf(page);
  await uploadPdf(page, "replacement.pdf", replacement, 1);
  await page.getByRole("button", { name: "1페이지 용량 줄이기" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 2, revoked: 1 });
  expect(downloads).toBe(0);

  await page.evaluate(() => {
    const nextWindow = window as Window & {
      next?: { router?: { push: (path: string) => void } };
    };
    const router = nextWindow.next?.router;
    if (router === undefined) throw new Error("Next router unavailable");
    router.push("/pdf/merge");
  });
  await expect(page.getByRole("heading", { level: 1, name: "PDF 합치기" })).toBeVisible();
  await expect.poll(() => objectUrlCounts(page)).toEqual({ created: 2, revoked: 2 });
  expect(downloads).toBe(0);
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

  await page.getByRole("button", { name: "2페이지 용량 줄이기" }).click();
  await page.getByRole("button", { name: "중단" }).click();
  await page.evaluate(() => {
    (window as Window & { __hereisitReleaseFrames?: () => void }).__hereisitReleaseFrames?.();
  });
  await settleRenderedState(page);
  await expect(page.getByText("PDF 압축을 중단했어요.").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "PDF 압축 설정" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "용량 줄이기 완료" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toHaveCount(0);
  expect(downloadCount).toBe(0);
  expect(await objectUrlCounts(page)).toEqual({ created: 0, revoked: 0 });
});
