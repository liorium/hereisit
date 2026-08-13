import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  expectWebShareUnused,
  installAvailableWebShare,
  installDownloadActivationController,
  setDownloadActivationBlocked,
} from "./support/result-download";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: analytics requires the explicit build fixture.
const analyticsBuildEnabled = process.env.HEREISIT_E2E_PRODUCT_ANALYTICS === "1";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

async function createPhotoLikeJpeg(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable");
    const image = context.createImageData(canvas.width, canvas.height);
    let seed = 123_456_789;
    for (let index = 0; index < image.data.length; index += 4) {
      seed = (1_664_525 * seed + 1_013_904_223) >>> 0;
      image.data[index] = seed & 255;
      image.data[index + 1] = (seed >>> 8) & 255;
      image.data[index + 2] = (seed >>> 16) & 255;
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value === null) reject(new Error("JPEG encoding failed"));
          else resolve(value);
        },
        "image/jpeg",
        0.78,
      );
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

async function captureProductEvents(page: Page): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  await page.route("**/v1/analytics/events", async (route) => {
    events.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 204 });
  });
  return events;
}

function expectOnlyProductFields(events: readonly Record<string, unknown>[]): void {
  const allowed = new Set(["schema", "toolId", "event", "duration", "failure"]);
  expect(events.every((event) => Object.keys(event).every((key) => allowed.has(key)))).toBe(true);
}

async function installHeldTransformingWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type RunRequest = {
      type: "run";
      jobId: string;
      input: { name: string; mimeHint: string; byteLength: number; file: File };
    };
    type TestWindow = Window & { __hereisitCompleteImageTransform?: () => boolean };

    let pending: { request: RunRequest; worker: ControlledImageWorker } | undefined;

    const complete = () => {
      if (pending === undefined) return false;
      const { request, worker } = pending;
      pending = undefined;
      const bytes = new ArrayBuffer(request.input.byteLength);
      worker.emit({
        protocol: 1,
        type: "complete",
        jobId: request.jobId,
        result: {
          bytes,
          suggestedName: "progress-hereisit.png",
          mime: "image/png",
          width: 1,
          height: 1,
          byteLength: bytes.byteLength,
          warnings: [],
          timing: {
            inspectMs: 0,
            decodeMs: 0,
            transformMs: 0,
            encodeMs: 0,
            totalMs: 0,
            encodeAttempts: 1,
          },
        },
      });
      return true;
    };

    class ControlledImageWorker {
      private readonly workerName: string | undefined;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_scriptURL: string | URL, options?: WorkerOptions) {
        this.workerName = options?.name;
      }

      postMessage(message: unknown): void {
        const request = message as {
          protocol?: unknown;
          type?: string;
          jobId?: unknown;
          input?: { name?: unknown; mimeHint?: unknown; byteLength?: unknown; file?: unknown };
        };
        if (
          this.workerName === "hereisit-image-optimize-worker" &&
          (request.type === "inspect" || request.type === "lossless")
        ) {
          const input = request.input;
          if (
            request.protocol !== 1 ||
            typeof request.jobId !== "string" ||
            input === undefined ||
            Object.keys(input).length !== 4 ||
            typeof input.name !== "string" ||
            typeof input.mimeHint !== "string" ||
            !Number.isSafeInteger(input.byteLength) ||
            !(input.file instanceof File) ||
            input.file.name !== input.name ||
            input.file.type !== input.mimeHint ||
            input.file.size !== input.byteLength
          ) {
            throw new TypeError("Unexpected image optimize Worker request.");
          }
          queueMicrotask(() => {
            if (request.type === "lossless") {
              const bytes = new ArrayBuffer(input.byteLength);
              this.emit({
                protocol: 1,
                type: "progress",
                jobId: request.jobId,
                sequence: 0,
                phase: "optimizing",
                fraction: null,
              });
              this.emit({
                protocol: 1,
                type: "complete",
                jobId: request.jobId,
                result: {
                  bytes,
                  byteLength: bytes.byteLength,
                  mime: "image/png",
                  width: 1,
                  height: 1,
                  warnings: [],
                },
              });
              return;
            }
            this.emit({
              protocol: 1,
              type: "inspected",
              jobId: request.jobId,
              result: { mime: "image/png", width: 1, height: 1, animated: false },
            });
          });
          return;
        }
        if (
          this.workerName !== "hereisit-image-worker" ||
          request.type !== "run" ||
          typeof request.jobId !== "string" ||
          request.input === undefined ||
          Object.keys(request.input).length !== 4 ||
          typeof request.input.name !== "string" ||
          typeof request.input.mimeHint !== "string" ||
          !Number.isSafeInteger(request.input.byteLength) ||
          !(request.input.file instanceof File) ||
          request.input.file.name !== request.input.name ||
          request.input.file.type !== request.input.mimeHint ||
          request.input.file.size !== request.input.byteLength
        ) {
          throw new TypeError("Unexpected image Worker request.");
        }
        const run = request as RunRequest;
        pending = { request: run, worker: this };
        queueMicrotask(() => {
          this.emit({
            protocol: 1,
            type: "progress",
            jobId: run.jobId,
            sequence: 0,
            phase: "transforming",
            fraction: 0.5,
          });
        });
      }

      emit(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent<unknown>);
      }

      terminate(): void {}
    }

    (window as TestWindow).__hereisitCompleteImageTransform = complete;
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: ControlledImageWorker,
    });
  });
}

async function completeHeldImageTransform(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hereisitCompleteImageTransform?: () => boolean;
            }
          ).__hereisitCompleteImageTransform?.() ?? false,
      ),
    )
    .toBe(true);
}

async function installInterleavedCompletionWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type RunRequest = {
      type: "run";
      jobId: string;
      input: { name: string; mimeHint: string; byteLength: number; file: File };
    };

    let firstRun: { request: RunRequest; worker: ControlledImageWorker } | undefined;
    let runCount = 0;

    const complete = (worker: ControlledImageWorker, request: RunRequest, ordinal: number) => {
      const bytes = new ArrayBuffer(request.input.byteLength);
      worker.emit({
        protocol: 1,
        type: "complete",
        jobId: request.jobId,
        result: {
          bytes,
          suggestedName: `result-${ordinal}.png`,
          mime: "image/png",
          width: 1,
          height: 1,
          byteLength: bytes.byteLength,
          warnings: [],
          timing: {
            inspectMs: 0,
            decodeMs: 0,
            transformMs: 0,
            encodeMs: 0,
            totalMs: 0,
            encodeAttempts: 1,
          },
        },
      });
    };

    class ControlledImageWorker {
      private readonly workerName: string | undefined;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_scriptURL: string | URL, options?: WorkerOptions) {
        this.workerName = options?.name;
      }

      postMessage(message: unknown): void {
        const request = message as {
          protocol?: unknown;
          type?: string;
          jobId?: unknown;
          input?: { name?: unknown; mimeHint?: unknown; byteLength?: unknown; file?: unknown };
        };
        if (
          this.workerName === "hereisit-image-optimize-worker" &&
          (request.type === "inspect" || request.type === "lossless")
        ) {
          const input = request.input;
          if (
            request.protocol !== 1 ||
            typeof request.jobId !== "string" ||
            input === undefined ||
            Object.keys(input).length !== 4 ||
            typeof input.name !== "string" ||
            typeof input.mimeHint !== "string" ||
            !Number.isSafeInteger(input.byteLength) ||
            !(input.file instanceof File) ||
            input.file.name !== input.name ||
            input.file.type !== input.mimeHint ||
            input.file.size !== input.byteLength
          ) {
            throw new TypeError("Unexpected image optimize Worker request.");
          }
          queueMicrotask(() => {
            if (request.type === "lossless") {
              const bytes = new ArrayBuffer(input.byteLength);
              this.emit({
                protocol: 1,
                type: "progress",
                jobId: request.jobId,
                sequence: 0,
                phase: "optimizing",
                fraction: null,
              });
              this.emit({
                protocol: 1,
                type: "complete",
                jobId: request.jobId,
                result: {
                  bytes,
                  byteLength: bytes.byteLength,
                  mime: "image/png",
                  width: 1,
                  height: 1,
                  warnings: [],
                },
              });
              return;
            }
            this.emit({
              protocol: 1,
              type: "inspected",
              jobId: request.jobId,
              result: { mime: "image/png", width: 1, height: 1, animated: false },
            });
          });
          return;
        }
        if (
          this.workerName !== "hereisit-image-worker" ||
          request.type !== "run" ||
          typeof request.jobId !== "string" ||
          request.input === undefined ||
          Object.keys(request.input).length !== 4 ||
          typeof request.input.name !== "string" ||
          typeof request.input.mimeHint !== "string" ||
          !Number.isSafeInteger(request.input.byteLength) ||
          !(request.input.file instanceof File) ||
          request.input.file.name !== request.input.name ||
          request.input.file.type !== request.input.mimeHint ||
          request.input.file.size !== request.input.byteLength
        ) {
          throw new TypeError("Unexpected image Worker request.");
        }

        const run = request as RunRequest;
        runCount += 1;
        if (runCount === 1) {
          firstRun = { request: run, worker: this };
          queueMicrotask(() => {
            this.emit({
              protocol: 1,
              type: "progress",
              jobId: run.jobId,
              sequence: 0,
              phase: "finalizing",
              fraction: 0.98,
            });
          });
          return;
        }

        setTimeout(() => complete(this, run, runCount), 0);
      }

      emit(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent<unknown>);
      }

      terminate(): void {}
    }

    const observer = new MutationObserver(() => {
      const pending = firstRun;
      if (
        pending === undefined ||
        document.querySelector('[role="progressbar"][aria-valuenow="98"]') === null
      ) {
        return;
      }
      firstRun = undefined;
      complete(pending.worker, pending.request, 1);
    });
    observer.observe(document, {
      attributes: true,
      attributeFilter: ["aria-valuenow"],
      childList: true,
      subtree: true,
    });

    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: ControlledImageWorker,
    });
  });
}

test("processes and downloads an image without external uploads", async ({ page }) => {
  const response = await page.goto("/image/convert");
  expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self'");
  await expect(page.getByRole("heading", { name: "이미지 형식 변환" })).toBeVisible();
  const uploadButton = page.getByRole("button", { name: "변환할 이미지 선택" });
  const fileInput = page.locator("input[type=file]");
  await expect(uploadButton).toBeEnabled();
  await expect(fileInput).toBeEnabled();

  const unexpectedRequests: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  const requestedPaths: string[] = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    const pageUrl = new URL(page.url());
    if (requestUrl.origin === pageUrl.origin) {
      requestedPaths.push(requestUrl.pathname);
    }
    if (
      requestUrl.origin !== pageUrl.origin ||
      !["GET", "HEAD"].includes(request.method()) ||
      request.postData() !== null
    ) {
      unexpectedRequests.push(request.url());
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      [request.url(), request.failure()?.errorText ?? "unknown request failure"].join(": "),
    );
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await fileInput.setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await expect(page.getByText("sample.png")).toBeVisible();
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();

  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("1×1", { exact: true })).toBeVisible();

  const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe("sample-hereisit.webp");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const output = new Uint8Array(await readFile(downloadPath as string));
  expect(new TextDecoder().decode(output.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(output.subarray(8, 12))).toBe("WEBP");

  await page.getByLabel("출력 형식").selectOption("png");
  await expect(downloadButton).toBeHidden();
  await expect(page.getByRole("button", { name: "1개 이미지 형식 변환 →" })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(
    requestedPaths.some(
      (path) => path.startsWith("/_next/static/chunks/turbopack-worker-") && path.endsWith(".js"),
    ),
  ).toBe(true);
  expect(requestedPaths.some((path) => path.endsWith(".ts"))).toBe(false);
});

test("product analytics records one image run and download", async ({ page }) => {
  test.skip(!analyticsBuildEnabled, "requires a build with product analytics enabled");
  const events = await captureProductEvents(page);
  await page.goto("/image/compress");
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "analytics.jpg",
    mimeType: "image/jpeg",
    buffer: input,
  });

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "압축 완료" })).toBeVisible({ timeout: 20_000 });
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);

  await expect.poll(() => events.length).toBe(3);
  expect(events.map(({ event }) => event)).toEqual([
    "processing-started",
    "processing-succeeded",
    "download-requested",
  ]);
  expect(events.every(({ toolId }) => toolId === "image.compress")).toBe(true);
  expectOnlyProductFields(events);
});

test("product analytics settles a cancelled image run once", async ({ page }) => {
  test.skip(!analyticsBuildEnabled, "requires a build with product analytics enabled");
  await installHeldTransformingWorker(page);
  const events = await captureProductEvents(page);
  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "cancel.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("button", { name: "중단" })).toBeVisible();
  await page.getByRole("button", { name: "중단" }).click();

  await expect.poll(() => events.length).toBe(2);
  expect(events.map(({ event }) => event)).toEqual(["processing-started", "processing-failed"]);
  expect(events[1]).toMatchObject({ failure: "cancelled", toolId: "image.compress" });
  expectOnlyProductFields(events);
});

test("reaches the upload action through the real tab order", async ({ page }) => {
  await page.goto("/image/convert");
  const homeLink = page.getByRole("link", { name: "HereIsIt 홈" });
  const uploadButton = page.getByRole("button", { name: "변환할 이미지 선택" });
  await expect(uploadButton).toBeEnabled();

  await page.keyboard.press("Tab");
  await expect(homeLink).toBeFocused();
  let reachedUpload = false;
  for (let index = 0; index < 12 && !reachedUpload; index += 1) {
    await page.keyboard.press("Tab");
    reachedUpload = await uploadButton.evaluate((element) => document.activeElement === element);
  }
  expect(reachedUpload).toBe(true);
});

test("makes a photo-like JPEG smaller while preserving its format", async ({ page }) => {
  await page.goto("/image/compress");
  await expect(page.getByRole("heading", { name: "이미지 용량 줄이기", exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole("region", { name: "압축 설정" })).toBeVisible();
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: input,
  });

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "압축 완료" })).toBeVisible({
    timeout: 20_000,
  });
  const result = page.getByRole("region", { name: "압축 완료" });
  await expect(result.getByRole("status")).toHaveAttribute("aria-live", "polite");
  await expect(result.getByText(formatByteSize(input.byteLength), { exact: true })).toBeVisible();
  await expect(result.getByText("원본", { exact: true })).toBeVisible();
  await expect(result.getByText("결과", { exact: true })).toBeVisible();
  await expect(result.getByText("→", { exact: true })).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText(/% 줄였어요$/)).toBeVisible();
  const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
  await expect(downloadButton).toBeVisible();
  await expect(page.getByText("압축 설정 · 추천")).toHaveCount(0);
  expect(
    await result.evaluate((section) => {
      const heading = section.querySelector("h2");
      const sizeComparison = section.querySelector('[data-result="true"]')?.parentElement;
      const download = [...section.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("결과 다운로드"),
      );
      return (
        heading !== null &&
        sizeComparison !== null &&
        sizeComparison !== undefined &&
        download !== undefined &&
        Boolean(
          heading.compareDocumentPosition(sizeComparison) & Node.DOCUMENT_POSITION_FOLLOWING,
        ) &&
        Boolean(sizeComparison.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    }),
  ).toBe(true);

  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe("photo-hereisit.jpg");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const output = new Uint8Array(await readFile(downloadPath as string));
  expect(output.byteLength).toBeLessThan(input.byteLength);
  await expect(result.getByText(formatByteSize(output.byteLength), { exact: true })).toBeVisible();
  expect(Array.from(output.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);

  await page.getByRole("button", { name: "다른 이미지 압축" }).click();
  await expect(page.getByRole("button", { name: "이미지 선택" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /압축 완료|원본 유지/ })).toHaveCount(0);
});

test("keeps a local compression result retryable when download activation throws", async ({
  page,
}) => {
  await installDownloadActivationController(page);
  await page.goto("/image/compress");
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "retry.jpg",
    mimeType: "image/jpeg",
    buffer: input,
  });
  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "압축 완료" })).toBeVisible();

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 다운로드 ↓" }).click();
  await expect(page.getByText("다운로드를 시작하지 못했어요. 다시 시도해 주세요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();
});

test("downloads two local compression results together and individually", async ({ page }) => {
  await installAvailableWebShare(page);
  await installDownloadActivationController(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/compress");
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.jpg", mimeType: "image/jpeg", buffer: input },
    { name: "second.jpg", mimeType: "image/jpeg", buffer: input },
  ]);

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2개 이미지 압축 완료" })).toBeVisible({
    timeout: 20_000,
  });
  const result = page.getByRole("region", { name: "2개 이미지 압축 완료" });
  await expect(result.getByText("원본", { exact: true })).toBeVisible();
  await expect(result.getByText("결과", { exact: true })).toBeVisible();
  await expect(result.getByText("→", { exact: true })).toHaveAttribute("aria-hidden", "true");
  const archiveButton = page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" });
  await expect(archiveButton).toBeVisible();
  await expect(page.getByRole("button", { name: /개별 다운로드/ })).toHaveCount(0);

  await page.getByText("파일별 결과 보기").click();
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(2);

  await setDownloadActivationBlocked(page, true);
  await archiveButton.click();
  await expect(page.getByTestId("image-workbench-status")).toHaveText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  expect(downloadCount).toBe(0);
  await expect(archiveButton).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([page.waitForEvent("download"), archiveButton.click()]);
  expect(download.suggestedFilename()).toBe("hereisit-images.zip");
  const zipPath = await download.path();
  expect(zipPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
  expect(Object.keys(archive).sort()).toEqual(["first-hereisit.jpg", "second-hereisit.jpg"]);
  expect(downloadCount).toBe(1);
  await page.getByText("파일별 결과 보기").click();
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(2);
  await expectWebShareUnused(page);
});

test("retains and downloads the original when compression cannot make it smaller", async ({
  page,
}) => {
  await page.goto("/image/compress");
  const fileInput = page.locator("input[type=file]");
  await fileInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "원본 유지" })).toBeVisible();
  await expect(page.getByRole("region", { name: "원본 유지" }).getByText("68B")).toHaveCount(2);
  await expect(page.getByText("이미 충분히 작아 원본을 유지했어요", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "원본 다운로드 ↓" })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "원본 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("tiny-hereisit.png");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath as string)).toEqual(onePixelPng);
});

test("uses compression progress copy during local source-preserving work", async ({ page }) => {
  await installHeldTransformingWorker(page);
  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "progress.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "이미지 압축 중" })).toBeVisible();
  const liveStatus = page.getByRole("status").filter({ hasText: "용량 최적화 중" });
  await expect(liveStatus).toBeVisible();
  await expect(liveStatus).toHaveAttribute("aria-live", "polite");
  await expect(page.getByRole("button", { name: "중단" })).toBeVisible();
  await expect(page.getByText(/크기 조절 중/)).toHaveCount(0);
  await completeHeldImageTransform(page);
  await expect(page.getByTestId("image-workbench-status")).toHaveText(
    "처리가 끝났어요. 결과를 바로 다운로드할 수 있어요.",
  );
});

test("runs local lossless compression through the optimize Worker", async ({ page }) => {
  await installHeldTransformingWorker(page);
  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "lossless.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await expect(page.getByText(/lossless\.png ·/)).toBeVisible();
  await page.getByText("압축 설정 · 추천", { exact: true }).click();
  await page.getByRole("radio", { name: "무손실" }).check();
  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "압축 완료" })).toBeVisible();
});

test("keeps populated setup, processing, and result actions visible at narrow widths", async ({
  page,
}) => {
  await installHeldTransformingWorker(page);
  const expectStateWithinViewport = async (action: Locator) => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    const viewportWidth = page.viewportSize()?.width ?? 0;
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? viewportWidth) + (box?.width ?? 1)).toBeLessThanOrEqual(viewportWidth);
  };

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/image/compress");
    await page.locator("input[type=file]").setInputFiles({
      name: `narrow-${width}.png`,
      mimeType: "image/png",
      buffer: onePixelPng,
    });

    await expectStateWithinViewport(page.getByRole("button", { name: "용량 줄이기", exact: true }));
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expectStateWithinViewport(page.getByRole("button", { name: "중단" }));

    await completeHeldImageTransform(page);
    await expect(page.getByRole("heading", { name: /압축 완료|원본 유지/ })).toBeVisible();
    await expectStateWithinViewport(
      page.getByRole("button", { name: /원본 다운로드|결과 다운로드/ }),
    );
  }
});

test("keeps the ready selection while a replacement inspection is held", async ({ page }) => {
  await page.addInitScript(() => {
    let release: (() => void) | undefined;
    let commonWorkerStarts = 0;
    (
      window as Window & { __hereisitReleaseFileInspection?: () => void }
    ).__hereisitReleaseFileInspection = () => release?.();
    (
      window as Window & { __hereisitCommonWorkerStarts?: () => number }
    ).__hereisitCommonWorkerStarts = () => commonWorkerStarts;
    File.prototype.arrayBuffer = async function uiRealmArrayBufferTripwire() {
      throw new Error("The UI realm must not read image files.");
    };
    class HeldReplacementInspectionWorker {
      private readonly workerName: string | undefined;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_scriptURL: string | URL, options?: WorkerOptions) {
        this.workerName = options?.name;
      }

      postMessage(message: unknown): void {
        if (this.workerName === "hereisit-image-worker") {
          commonWorkerStarts += 1;
          return;
        }
        const request = message as {
          protocol?: unknown;
          type?: unknown;
          jobId?: unknown;
          input?: { name?: unknown; mimeHint?: unknown; byteLength?: unknown; file?: unknown };
        };
        if (request.type === "cancel") return;
        const input = request.input;
        if (
          this.workerName !== "hereisit-image-optimize-worker" ||
          request.protocol !== 1 ||
          request.type !== "inspect" ||
          typeof request.jobId !== "string" ||
          input === undefined ||
          Object.keys(input).length !== 4 ||
          typeof input.name !== "string" ||
          typeof input.mimeHint !== "string" ||
          !Number.isSafeInteger(input.byteLength) ||
          !(input.file instanceof File) ||
          input.file.name !== input.name ||
          input.file.type !== input.mimeHint ||
          input.file.size !== input.byteLength
        ) {
          throw new TypeError("Unexpected image optimize inspection request.");
        }
        const inspected = () =>
          this.onmessage?.({
            data: {
              protocol: 1,
              type: "inspected",
              jobId: request.jobId,
              result: { mime: "image/png", width: 1, height: 1, animated: false },
            },
          } as MessageEvent<unknown>);
        if (input.name === "replacement-first.png") {
          release = inspected;
        } else {
          queueMicrotask(inspected);
        }
      }
      terminate(): void {}
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: HeldReplacementInspectionWorker,
    });
  });
  await page.goto("/image/compress");
  const fileInput = page.locator("input[type=file]");
  await fileInput.setInputFiles({
    name: "ready.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.getByText(/ready\.png ·/)).toBeVisible();

  await fileInput.setInputFiles([
    { name: "replacement-first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "replacement-second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);

  await expect(page.getByTestId("image-workbench-status")).toHaveText("1/2 이미지 확인 중");
  await expect(page.getByText(/ready\.png ·/)).toBeVisible();
  await expect(page.getByRole("button", { name: "이미지 다시 선택" })).toBeEnabled();
  const run = page.getByRole("button", { name: "용량 줄이기", exact: true });
  await expect(run).toBeDisabled();
  await run.evaluate((button) => {
    button.removeAttribute("disabled");
    button.click();
  });
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & { __hereisitCommonWorkerStarts?: () => number }
        ).__hereisitCommonWorkerStarts?.() ?? -1,
    ),
  ).toBe(0);
  await expect(page.getByText(/ready\.png ·/)).toBeVisible();

  await page.evaluate(() =>
    (
      window as Window & { __hereisitReleaseFileInspection?: () => void }
    ).__hereisitReleaseFileInspection?.(),
  );
  await expect(page.getByTestId("image-workbench-status")).toHaveText("2개 이미지를 확인했어요.");
  await expect(page.getByText(/2개 이미지 ·/)).toBeVisible();
  await expect(page.getByText(/ready\.png ·/)).toHaveCount(0);
});

test("limits inspection to the first 20 files while counting invalid and overflow files", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const inspectedNames: string[] = [];
    class InspectionWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_scriptURL: string | URL, options?: WorkerOptions) {
        if (options?.name !== "hereisit-image-optimize-worker")
          throw new Error("Unexpected common image Worker.");
      }

      postMessage(message: unknown): void {
        const request = message as {
          protocol?: unknown;
          type?: unknown;
          jobId?: unknown;
          input?: { name?: unknown; mimeHint?: unknown; byteLength?: unknown; file?: unknown };
        };
        const input = request.input;
        if (
          request.protocol !== 1 ||
          request.type !== "inspect" ||
          typeof request.jobId !== "string" ||
          input === undefined ||
          Object.keys(input).length !== 4 ||
          typeof input.name !== "string" ||
          typeof input.mimeHint !== "string" ||
          !Number.isSafeInteger(input.byteLength) ||
          !(input.file instanceof File) ||
          input.file.name !== input.name ||
          input.file.type !== input.mimeHint ||
          input.file.size !== input.byteLength
        ) {
          throw new TypeError("Unexpected image optimize inspection request.");
        }
        inspectedNames.push(input.name);
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              protocol: 1,
              type: "inspected",
              jobId: request.jobId,
              result: { mime: "image/png", width: 1, height: 1, animated: false },
            },
          } as MessageEvent<unknown>),
        );
      }

      terminate(): void {}
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: InspectionWorker });
    (
      window as Window & { __hereisitInspectedNames?: () => readonly string[] }
    ).__hereisitInspectedNames = () => inspectedNames;
  });
  await page.goto("/image/compress");
  await expect(page.getByTestId("image-workbench-status")).not.toHaveText(
    "처리 방식을 확인하고 있어요.",
  );
  await page.getByRole("button", { name: "이미지 선택" }).evaluate((picker) => {
    const transfer = new DataTransfer();
    for (let index = 0; index < 20; index += 1) {
      transfer.items.add(
        new File([Uint8Array.of(index)], `accepted-${index}.png`, { type: "image/png" }),
      );
    }
    transfer.items.add(new File([Uint8Array.of(1)], "overflow.png", { type: "image/png" }));
    picker.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect(page.getByTestId("image-workbench-status")).toHaveText(
    "20개 이미지를 확인했어요. 지원 조건에 맞지 않는 1개를 제외했어요. JPG, PNG, WebP 정지 이미지만 지원하며 파일당 30MB까지 처리할 수 있어요.",
  );
  await expect(page.getByText("20개 이미지 · 20B", { exact: true })).toBeVisible();
  await expect(page.getByText("overflow.png", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & { __hereisitInspectedNames?: () => readonly string[] }
        ).__hereisitInspectedNames?.() ?? [],
    ),
  ).toEqual(Array.from({ length: 20 }, (_, index) => `accepted-${index}.png`));

  await page.getByRole("button", { name: "이미지 다시 선택" }).evaluate((picker) => {
    const transfer = new DataTransfer();
    for (let index = 0; index < 18; index += 1) {
      transfer.items.add(
        new File([Uint8Array.of(index)], `valid-${index}.png`, { type: "image/png" }),
      );
    }
    transfer.items.add(new File([], "empty.png", { type: "image/png" }));
    const tooLarge = new File([Uint8Array.of(1)], "large.png", { type: "image/png" });
    Object.defineProperty(tooLarge, "size", { value: 30 * 1024 * 1024 + 1 });
    transfer.items.add(tooLarge);
    picker.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await expect(page.getByTestId("image-workbench-status")).toHaveText(
    "18개 이미지를 확인했어요. 지원 조건에 맞지 않는 2개를 제외했어요. JPG, PNG, WebP 정지 이미지만 지원하며 파일당 30MB까지 처리할 수 있어요.",
  );
  await expect(page.getByText("empty.png", { exact: true })).toHaveCount(0);
  await expect(page.getByText("large.png", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & { __hereisitInspectedNames?: () => readonly string[] }
        ).__hereisitInspectedNames?.() ?? [],
    ),
  ).toEqual([
    ...Array.from({ length: 20 }, (_, index) => `accepted-${index}.png`),
    ...Array.from({ length: 18 }, (_, index) => `valid-${index}.png`),
  ]);
});

test("cancels an active inspection when the workbench unmounts", async ({ page }) => {
  let terminations = 0;
  await page.exposeBinding("__hereisitRecordInspectionTermination", () => {
    terminations += 1;
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class HeldInspectionWorker {
      private readonly native: Worker;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        this.native = new NativeWorker(scriptURL, options);
        this.native.onmessage = (event) => {
          if (
            options?.name === "hereisit-image-optimize-worker" &&
            (event.data as { type?: unknown } | null)?.type === "inspected"
          ) {
            (window as Window & { __hereisitInspectionHeld?: boolean }).__hereisitInspectionHeld =
              true;
            return;
          }
          this.onmessage?.(event);
        };
        this.native.onmessageerror = (event) => this.onmessageerror?.(event);
        this.native.onerror = (event) => this.onerror?.(event);
      }

      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (transfer === undefined) this.native.postMessage(message);
        else this.native.postMessage(message, transfer);
      }

      terminate(): void {
        void (
          window as Window & { __hereisitRecordInspectionTermination?: () => Promise<void> }
        ).__hereisitRecordInspectionTermination?.();
        this.native.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: HeldInspectionWorker });
  });
  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "held.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __hereisitInspectionHeld?: boolean }).__hereisitInspectionHeld ===
          true,
      ),
    )
    .toBe(true);

  await page.locator('a[href="/image/convert"]').first().click();
  await expect.poll(() => terminations).toBeGreaterThanOrEqual(1);
});

test("explains why HEIC cannot be compressed while preserving its format", async ({ page }) => {
  await page.goto("/image/compress");
  const heic = await readFile("tests/fixtures/rainbow-451x461.heic");
  await page.locator("input[type=file]").setInputFiles({
    name: "disguised.jpg",
    mimeType: "image/jpeg",
    buffer: heic,
  });

  await expect(
    page
      .getByRole("status")
      .getByText(
        "지원되는 이미지를 찾지 못했어요. HEIC·HEIF는 같은 형식으로 압축할 수 없어요. 이미지 형식 변환 도구를 이용해 주세요.",
        { exact: true },
      ),
  ).toBeVisible();
  await expect(page.getByText("disguised.jpg", { exact: true })).toHaveCount(0);
});

test("uses detected bytes for same-format PNG guidance", async ({ page }) => {
  await page.goto("/image/compress");
  const jpeg = await createPhotoLikeJpeg(page);
  const fileInput = page.locator("input[type=file]");

  await fileInput.setInputFiles({
    name: "misleading.png",
    mimeType: "image/png",
    buffer: jpeg,
  });
  await expect(page.getByText(/misleading\.png · /)).toBeVisible();
  await expect(page.getByText(/PNG 스마트 모드/)).toHaveCount(0);

  await fileInput.setInputFiles({
    name: "actual.png",
    mimeType: "application/octet-stream",
    buffer: onePixelPng,
  });
  await page.getByText("압축 설정 · 추천", { exact: true }).click();
  await expect(
    page.getByText("PNG 스마트 모드는 색상 수를 줄일 수 있는 시각적 압축입니다.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("downloads one image without consulting available Web Share APIs", async ({ page }) => {
  await installAvailableWebShare(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles({
    name: "share.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("share-hereisit.webp");
  expect(downloadCount).toBe(1);
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await expectWebShareUnused(page);
  await expect(page.getByRole("button", { name: /공유|저장·공유/ })).toHaveCount(0);
});

test("keeps an image result retryable when download activation throws", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles({
    name: "retry.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible({
    timeout: 20_000,
  });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("retry-hereisit.webp");
});

test("keeps image ZIP results retryable when download activation throws", async ({ page }) => {
  await installDownloadActivationController(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click();
  await expect(
    page
      .getByRole("status")
      .getByText("다운로드를 시작하지 못했어요. 다시 시도해 주세요.", { exact: true }),
  ).toBeVisible();
  expect(downloadCount).toBe(0);
  await expect(page.getByRole("button", { name: "이 이미지 다운로드 ↓" })).toBeVisible();
  await expect(page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("hereisit-images.zip");
  const zipPath = await download.path();
  expect(zipPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
  expect(Object.keys(archive).sort()).toEqual(["first-hereisit.webp", "second-hereisit.webp"]);
  expect(downloadCount).toBe(1);
});

test("downloads a selected image and its batch ZIP without Web Share", async ({ page }) => {
  await installAvailableWebShare(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloadCount).toBe(0);

  const selectedAction = page.getByRole("button", { name: "이 이미지 다운로드 ↓" });
  const selectedBox = await selectedAction.boundingBox();
  expect(selectedBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const [selectedDownload] = await Promise.all([
    page.waitForEvent("download"),
    selectedAction.click(),
  ]);
  expect(selectedDownload.suggestedFilename()).toBe("first-hereisit.webp");
  const selectedPath = await selectedDownload.path();
  expect(selectedPath).not.toBeNull();
  const selectedBytes = new Uint8Array(await readFile(selectedPath as string));
  expect(new TextDecoder().decode(selectedBytes.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(selectedBytes.subarray(8, 12))).toBe("WEBP");
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");

  const [zipDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click(),
  ]);
  expect(zipDownload.suggestedFilename()).toBe("hereisit-images.zip");
  const zipPath = await zipDownload.path();
  expect(zipPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
  expect(Object.keys(archive).sort()).toEqual(["first-hereisit.webp", "second-hereisit.webp"]);
  expect(downloadCount).toBe(2);
  await expect(page.getByRole("status")).toContainText("ZIP 다운로드를 시작했어요.");
  await expectWebShareUnused(page);
});

test("preserves every completed result across an interleaved finalizing render", async ({
  page,
}) => {
  await installInterleavedCompletionWorker(page);
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);

  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();

  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByLabel("선택한 이미지").locator("small").filter({ hasText: "→" }),
  ).toHaveCount(2);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "이 이미지 다운로드 ↓" })).toBeVisible();
  await expect(page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" })).toBeVisible();
});

test("accepts a real HEIC file without uploading it", async ({ page, browserName }) => {
  await page.goto("/image/convert");
  const origin = new URL(page.url()).origin;
  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== origin ||
      !["GET", "HEAD"].includes(request.method()) ||
      request.postData() !== null
    ) {
      unexpectedRequests.push(request.url());
    }
  });

  const heic = await readFile("tests/fixtures/rainbow-451x461.heic");
  await page.locator("input[type=file]").setInputFiles({
    name: "rainbow-451x461.HEIC",
    mimeType: "",
    buffer: heic,
  });
  await expect(page.getByText("rainbow-451x461.HEIC")).toBeVisible();
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();

  const completed = page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." });
  const unsupported = page.getByRole("alert").filter({ hasText: "HEIC 디코딩을 지원하지 않아요" });
  if (browserName === "webkit") {
    await expect(completed.or(unsupported)).toBeVisible({ timeout: 20_000 });
    if (await completed.isVisible()) {
      await expect(page.getByText("451×461", { exact: true })).toBeVisible();
    }
  } else {
    await expect(unsupported).toBeVisible({ timeout: 20_000 });
  }
  expect(unexpectedRequests).toEqual([]);
});
