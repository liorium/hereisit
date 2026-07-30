import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngChunk(type: string, body: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const result = Buffer.alloc(12 + body.byteLength);
  result.writeUInt32BE(body.byteLength, 0);
  payload.copy(result, 4);
  result.writeUInt32BE(crc32(payload), 8 + body.byteLength);
  return result;
}

function createProgressPng(): Buffer {
  const width = 1_024;
  const height = 1_024;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const progressPng = createProgressPng();
const resultHeaders = {
  "access-control-allow-origin": "http://127.0.0.1:4173",
  "access-control-expose-headers": "content-length, content-type, x-download-lease",
  "content-type": "image/png",
  "content-length": String(onePixelPng.byteLength),
  "x-download-lease": "a".repeat(43),
};

const jobId = "123e4567-e89b-42d3-a456-426614174001";
const secondJobId = "123e4567-e89b-42d3-a456-426614174002";
const policyLimits = {
  maxFiles: 20,
  maxBytesPerFile: 30 * 1024 * 1024,
  maxPixelsPerFile: 40_000_000,
};

function serverPolicy() {
  return {
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    execution: "server",
    reason: null,
    maintainer: false,
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
    limits: policyLimits,
  } as const;
}

function localPolicy(reason: "LOCAL_FALLBACK_REQUIRED" | "SERVER_PROCESSING_DISABLED") {
  return {
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    execution: "local",
    reason,
    maintainer: false,
    disclosure: {
      upload: false,
      inputDeletion: "not-uploaded",
      resultDeletion: { mode: "not-uploaded" },
    },
    limits: policyLimits,
  } as const;
}

function structuralWebp(): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8 ", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]).copy(bytes, 20);
  return bytes;
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: this opt-in selects a prebuilt E2E fixture.
const serverModeEnabled = process.env.HEREISIT_E2E_SERVER_MODE === "1";

test("discloses local processing before selection and preserves PNG", async ({ page }) => {
  test.skip(serverModeEnabled, "requires the default local-only build");
  const jobRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/v1/jobs")) jobRequests.push(request.url());
  });
  await page.goto("/image/compress");
  await expect(page.locator('[data-policy="local"]')).toHaveText(
    "파일은 업로드하지 않고 이 기기에서 처리해요.",
  );
  await expect(page.getByText("내 기기에서만 처리")).toHaveCount(0);
  const picker = page.getByRole("button", { name: "이미지 선택" });
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveCSS("border-top-style", "dashed");
  await expect(picker).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByText("압축 설정 · 추천")).toBeVisible();
  await expect(page.getByRole("radio", { name: /최소 용량/ })).not.toBeVisible();
  await page.getByText("압축 설정 · 추천").click();
  await expect(page.getByRole("radio", { name: /최소 용량/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "용량 줄이기", exact: true })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.getByText("sample.png")).toBeVisible();
  await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
  await page.getByText("파일별 결과 보기").click();
  const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
  await expect(downloadButton).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe("sample-hereisit.png");
  expect(jobRequests).toEqual([]);
});

test("keeps the mobile workbench in one column without horizontal overflow", async ({ page }) => {
  test.skip(serverModeEnabled, "requires the default local-only build");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/image/compress");
    await expect(page.locator('[data-policy="local"]')).toHaveText(
      "파일은 업로드하지 않고 이 기기에서 처리해요.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      (await page.getByRole("button", { name: "이미지 선택" }).boundingBox())?.height ?? 0,
    ).toBeGreaterThanOrEqual(44);
  }
});

test("supports keyboard setup with named compression presets", async ({ page }) => {
  test.skip(serverModeEnabled, "requires the default local-only build");
  await page.goto("/image/compress");
  const homeLink = page.getByRole("link", { name: "HereIsIt 홈" });
  const picker = page.getByRole("button", { name: "이미지 선택" });
  await expect(picker).toBeEnabled();

  await page.keyboard.press("Tab");
  await expect(homeLink).toBeFocused();
  for (
    let index = 0;
    index < 12 && !(await picker.evaluate((node) => node === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(picker).toBeFocused();

  const settings = page.getByText("압축 설정 · 추천");
  for (
    let index = 0;
    index < 12 && !(await settings.evaluate((node) => node === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(settings).toBeFocused();
  const settingsBox = await settings.boundingBox();
  expect(settingsBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(settingsBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: /추천.*품질과 용량의 균형/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /최소 용량.*더 강한 시각적 압축/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /무손실.*픽셀을 바꾸지 않고 정리/ })).toBeVisible();
});

test.describe("configured processing server", () => {
  test.skip(!serverModeEnabled, "requires a build with NEXT_PUBLIC_PROCESSING_API_ORIGIN");

  test("discloses upload before selection and downloads a verified same-format result", async ({
    page,
  }) => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    let statusCalls = 0;
    await page.addInitScript(() => {
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function sendWithDeterministicProgress(body) {
        const result = send.call(this, body);
        if (body instanceof Blob && body.size > 0) {
          setTimeout(() => {
            this.upload.dispatchEvent(
              new ProgressEvent("progress", {
                lengthComputable: true,
                loaded: Math.max(1, Math.floor(body.size / 2)),
                total: body.size,
              }),
            );
          }, 0);
        }
        return result;
      };
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 KAKAOTALK 11.0",
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: () => {
          throw new Error("navigator.share must not be called");
        },
      });
      window.open = () => {
        throw new Error("window.open must not be called");
      };
    });
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === "/v1/policy") {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        requestBodies.push(request.postData() ?? "");
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
              contentType: "image/png",
              byteLength: progressPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        statusCalls += 1;
        if (statusCalls === 1) {
          await route.fulfill({
            status: 200,
            json: {
              contract: "tool-job@1",
              jobId,
              state: "queued",
              phase: "queued",
              phaseFraction: 0,
              sequence: 1,
              attempt: 1,
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          });
          return;
        }
        if (statusCalls === 2) {
          await route.fulfill({
            status: 200,
            json: {
              contract: "tool-job@1",
              jobId,
              state: "running",
              phase: "optimizing",
              phaseFraction: 0.5,
              sequence: 2,
              attempt: 1,
              updatedAt: "2026-07-16T00:00:01.000Z",
            },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 3,
            attempt: 1,
            result: {
              kind: "download",
              mime: "image/png",
              byteLength: onePixelPng.byteLength,
              width: 1,
              height: 1,
              engineBuildId: "engine-test",
              codecBuildId: "codec-test",
              warnings: [],
              timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      } else if (path.endsWith("/result")) {
        await route.fulfill({
          status: 200,
          body: onePixelPng,
          headers: resultHeaders,
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await expect(page.getByTestId("image-workbench-status")).toHaveText(
      "처리 방식을 확인하고 있어요.",
    );
    await expect(page.getByRole("button", { name: "이미지 선택" })).toBeDisabled();
    await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
    const policyLinkBox = await page.getByRole("link", { name: "자세히" }).boundingBox();
    expect(policyLinkBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(policyLinkBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    const picker = page.getByRole("button", { name: "이미지 선택" });
    await expect(picker).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({
      name: "server.png",
      mimeType: "image/png",
      buffer: progressPng,
    });
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "이미지 압축 중" })).toBeVisible();
    await expect(page.getByRole("button", { name: "이미지 선택" })).toHaveCount(0);
    await expect(page.getByText("안전하게 업로드 중")).toBeVisible();
    await expect(page.getByRole("button", { name: "중단" })).toBeVisible();
    await expect(page.locator("progress")).toBeVisible();
    expect(
      await page.locator("progress").evaluate((element) => (element as HTMLProgressElement).value),
    ).toBeGreaterThan(0);
    await expect(page.getByText("처리 순서를 기다리는 중")).toBeVisible();
    await expect(page.getByText("용량 최적화 중")).toBeVisible();
    await page.getByText("파일별 결과 보기").click();
    const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
    await expect(downloadButton).toBeVisible();
    await expect(
      page
        .getByText("파일별 결과 보기")
        .locator("..")
        .getByText(new RegExp(`→ ${onePixelPng.byteLength}B$`)),
    ).toBeVisible();
    await expect(page.getByText("압축 설정 · 추천")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "중단" })).toHaveCount(0);
    await expect(page.locator("progress")).toHaveCount(0);
    expect(requestBodies.every((body) => !body.includes("server.png"))).toBe(true);
    await page.getByRole("button", { name: "다른 이미지 압축" }).click();
    await expect(page.getByRole("button", { name: "이미지 선택" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /압축 완료|원본 유지/ })).toHaveCount(0);
    await expect.poll(() => calls.includes(`DELETE /v1/jobs/${jobId}`)).toBe(true);
    expect(calls.some((call) => call.includes("/downloaded"))).toBe(false);
  });

  test("downloads an original-retained item locally without requesting a server result", async ({
    page,
  }) => {
    const calls: string[] = [];
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: () => {
          throw new Error("navigator.share must not be called");
        },
      });
    });
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 2,
            attempt: 1,
            result: {
              kind: "original-retained",
              reason: "NO_SIZE_REDUCTION",
              testedCandidates: 2,
              engineBuildId: "engine-test",
              codecBuildId: "none",
              warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
              timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "retained.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "1개 이미지 압축 완료" })).toBeVisible();
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByText("68B → 68B")).toBeVisible();
    await expect(page.getByText(/원본 파일을 그대로 내려받습니다/)).toBeVisible();
    const downloadButton = page.getByRole("button", { name: "원본 다운로드 ↓" });
    const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
    expect(download.suggestedFilename()).toBe("retained-hereisit.png");
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    expect(await readFile(downloadedPath as string)).toEqual(onePixelPng);
    expect(calls.some((call) => call.endsWith("/result"))).toBe(false);
  });

  test("cancels an active server job and clears its temporary progress state", async ({ page }) => {
    const calls: string[] = [];
    let cancelled = false;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
      } else if (path.endsWith("/cancel")) {
        cancelled = true;
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: cancelled
            ? {
                contract: "tool-job@1",
                jobId,
                state: "cancelled",
                phase: "optimizing",
                phaseFraction: 0.5,
                sequence: 3,
                attempt: 1,
                error: { code: "CANCELLED", message: "작업이 취소되었습니다.", retryable: false },
                updatedAt: "2026-07-16T00:00:01.000Z",
              }
            : {
                contract: "tool-job@1",
                jobId,
                state: "running",
                phase: "optimizing",
                phaseFraction: 0.5,
                sequence: 2,
                attempt: 1,
                updatedAt: "2026-07-16T00:00:00.000Z",
              },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await page.locator('input[type="file"]').setInputFiles({
      name: "cancel.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.getByText("용량 최적화 중")).toBeVisible();
    await page.getByRole("button", { name: "중단" }).click();
    await expect.poll(() => calls.includes(`POST /v1/jobs/${jobId}/cancel`)).toBe(true);
    await expect.poll(() => calls.includes(`DELETE /v1/jobs/${jobId}`)).toBe(true);
    await expect(page.getByText("작업을 중단했어요.")).toBeVisible();
    await expect(page.locator("progress")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "용량 줄이기", exact: true })).toBeVisible();
  });

  test("downloads two remote compression results as one acknowledged ZIP", async ({ page }) => {
    const ids = [jobId, secondJobId];
    const calls: string[] = [];
    let created = 0;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
        return;
      }
      if (path === "/v1/jobs" && request.method() === "POST") {
        const currentJobId = ids[created] as string;
        created += 1;
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId: currentJobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${currentJobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
        return;
      }
      if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
        return;
      }
      const statusJobId = ids.find((candidate) => path === `/v1/jobs/${candidate}`);
      if (statusJobId !== undefined && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId: statusJobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 3,
            attempt: 1,
            result: {
              kind: "download",
              mime: "image/png",
              byteLength: onePixelPng.byteLength,
              width: 1,
              height: 1,
              engineBuildId: "engine-test",
              codecBuildId: "codec-test",
              warnings: [],
              timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            updatedAt: "2026-07-16T00:00:01.000Z",
          },
        });
        return;
      }
      if (path.endsWith("/result")) {
        await route.fulfill({
          status: 200,
          body: onePixelPng,
          headers: resultHeaders,
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    await page.goto("/image/compress");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
      { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
    ]);
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "2개 이미지 압축 완료" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "2개 이미지 압축 완료" })
        .locator("p")
        .filter({ hasText: /136B.*→.*136B/ })
        .first(),
    ).toBeVisible();
    const archiveButton = page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" });
    await expect(archiveButton).toBeVisible();
    await expect(page.getByRole("button", { name: /개별 다운로드/ })).toHaveCount(0);
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(2);

    const [download] = await Promise.all([page.waitForEvent("download"), archiveButton.click()]);
    expect(download.suggestedFilename()).toBe("hereisit-images.zip");
    const zipPath = await download.path();
    expect(zipPath).not.toBeNull();
    const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
    expect(Object.keys(archive).sort()).toEqual(["first-hereisit.png", "second-hereisit.png"]);
    await expect.poll(() => calls.filter((call) => call.endsWith("/downloaded")).length).toBe(2);
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(0);
  });

  test("downloads mixed remote and local fallback results in one ZIP", async ({ page }) => {
    const calls: string[] = [];
    let createCalls = 0;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        createCalls += 1;
        if (createCalls === 2) {
          await route.fulfill({
            status: 429,
            json: {
              contract: "tool-job@1",
              error: {
                code: "QUOTA_EXCEEDED",
                message: "현재 네트워크의 처리 한도에 도달했어요.",
                retryable: true,
              },
            },
          });
          return;
        }
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 3,
            attempt: 1,
            result: {
              kind: "download",
              mime: "image/png",
              byteLength: onePixelPng.byteLength,
              width: 1,
              height: 1,
              engineBuildId: "engine-test",
              codecBuildId: "codec-test",
              warnings: [],
              timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            updatedAt: "2026-07-16T00:00:01.000Z",
          },
        });
      } else if (path.endsWith("/result")) {
        await route.fulfill({ status: 200, body: onePixelPng, headers: resultHeaders });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "remote.png", mimeType: "image/png", buffer: onePixelPng },
      { name: "local.png", mimeType: "image/png", buffer: onePixelPng },
    ]);
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "2개 이미지 압축 완료" })).toBeVisible();
    const archiveButton = page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" });
    const [download] = await Promise.all([page.waitForEvent("download"), archiveButton.click()]);
    const zipPath = await download.path();
    expect(zipPath).not.toBeNull();
    const archive = unzipSync(new Uint8Array(await readFile(zipPath as string)));
    expect(Object.keys(archive).sort()).toEqual(["local-hereisit.png", "remote-hereisit.png"]);
    await expect.poll(() => calls.filter((call) => call.endsWith("/downloaded")).length).toBe(1);
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByRole("button", { name: "원본 다운로드 ↓" })).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(0);
  });

  test("summarizes only downloadable items when part of a server batch fails", async ({ page }) => {
    const ids = [jobId, secondJobId];
    let created = 0;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        const currentJobId = ids[created] as string;
        created += 1;
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId: currentJobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${currentJobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId,
            state: "succeeded",
            phase: "completed",
            phaseFraction: 1,
            sequence: 3,
            attempt: 1,
            result: {
              kind: "download",
              mime: "image/png",
              byteLength: onePixelPng.byteLength,
              width: 1,
              height: 1,
              engineBuildId: "engine-test",
              codecBuildId: "codec-test",
              warnings: [],
              timing: { queueMs: 1, processingMs: 1, totalMs: 2 },
              expiresAt: "2099-01-01T00:00:01.000Z",
            },
            updatedAt: "2026-07-16T00:00:01.000Z",
          },
        });
      } else if (path === `/v1/jobs/${secondJobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId: secondJobId,
            state: "failed",
            phase: "optimizing",
            phaseFraction: 0.5,
            sequence: 3,
            attempt: 1,
            error: {
              code: "ENGINE_TIMEOUT",
              message: "처리 시간이 초과됐어요. 추천 설정으로 다시 시도해 주세요.",
              retryable: false,
              guidance: "TRY_BALANCED_PRESET",
            },
            updatedAt: "2026-07-16T00:00:01.000Z",
          },
        });
      } else if (path.endsWith("/result")) {
        await route.fulfill({ status: 200, body: onePixelPng, headers: resultHeaders });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "ready.png", mimeType: "image/png", buffer: onePixelPng },
      { name: "failed.png", mimeType: "image/png", buffer: onePixelPng },
    ]);
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();

    await expect(page.getByRole("heading", { name: "1개 이미지 압축 완료" })).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" })).toHaveCount(0);
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByText("failed.png", { exact: true })).toBeVisible();
    await expect(
      page.getByText("처리 시간이 초과됐어요. 추천 설정으로 다시 시도해 주세요.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();
  });

  test("shows retry guidance without presenting it as a local usage fallback", async ({ page }) => {
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        await route.fulfill({
          status: 201,
          json: {
            contract: "tool-job@1",
            mode: "upload-required",
            jobId,
            upload: {
              kind: "worker-stream-put",
              method: "PUT",
              path: `/v1/jobs/${jobId}/input`,
              contentType: "image/png",
              byteLength: onePixelPng.byteLength,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            reservedWeightedUnits: 1,
          },
        });
      } else if (path.endsWith("/input")) {
        await route.fulfill({ status: 204 });
      } else if (path === `/v1/jobs/${jobId}` && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          json: {
            contract: "tool-job@1",
            jobId,
            state: "failed",
            phase: "optimizing",
            phaseFraction: 0.5,
            sequence: 3,
            attempt: 1,
            error: {
              code: "ENGINE_TIMEOUT",
              message: "처리 시간이 초과됐어요. 추천 설정으로 다시 시도해 주세요.",
              retryable: false,
              guidance: "TRY_BALANCED_PRESET",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await page.locator('input[type="file"]').setInputFiles({
      name: "retry.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    const terminalError = page.getByTestId("image-workbench-status");
    await expect(terminalError).toHaveAttribute("role", "alert");
    await expect(terminalError).toHaveAttribute("aria-live", "assertive");
    await expect(terminalError).toContainText(
      "처리 시간이 초과됐어요. 추천 설정으로 다시 시도해 주세요.",
    );
    await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await expect(page.getByText(/사용량 보호/)).toHaveCount(0);
  });

  test("keeps the server workbench within narrow viewports", async ({ page }) => {
    await page.route("**/v1/policy", (route) =>
      route.fulfill({ status: 200, json: serverPolicy() }),
    );
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/image/compress");
      await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(
        (await page.getByRole("button", { name: "이미지 선택" }).boundingBox())?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  test("falls back locally after a policy network failure without creating a job", async ({
    page,
  }) => {
    const jobCalls: string[] = [];
    await page.route("**/v1/policy", (route) => route.abort("connectionfailed"));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/v1/jobs")) jobCalls.push(request.url());
    });
    await page.goto("/image/compress");
    await expect(page.getByText("서버에 연결하지 못해 로컬 처리로 전환했어요.")).toBeVisible();
    await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();
    expect(jobCalls).toEqual([]);
  });

  test("keeps a server-required lossless item local when usage protection activates", async ({
    page,
  }) => {
    let policyCalls = 0;
    const jobCalls: string[] = [];
    await page.route("**/v1/policy", async (route) => {
      policyCalls += 1;
      await route.fulfill({
        status: 200,
        json: policyCalls === 1 ? serverPolicy() : localPolicy("LOCAL_FALLBACK_REQUIRED"),
      });
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/v1/jobs")) jobCalls.push(request.url());
    });
    await page.goto("/image/compress");
    await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "lossless.webp",
      mimeType: "image/webp",
      buffer: structuralWebp(),
    });
    await page.getByText("압축 설정 · 추천").click();
    await page.getByRole("radio", { name: /무손실/ }).check();
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await expect(page.locator('[data-policy="local"]')).toHaveText(
      "파일은 업로드하지 않고 이 기기에서 처리해요.",
    );
    await expect(page.getByText(/무손실 서버 처리가 필요한 이미지/)).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toHaveCount(0);
    expect(jobCalls).toEqual([]);
  });

  test("falls back locally when job creation reaches the shared-network quota fence", async ({
    page,
  }) => {
    let uploadCalls = 0;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/policy") {
        await route.fulfill({ status: 200, json: serverPolicy() });
      } else if (path === "/v1/jobs" && request.method() === "POST") {
        await route.fulfill({
          status: 429,
          json: {
            contract: "tool-job@1",
            error: {
              code: "QUOTA_EXCEEDED",
              message: "현재 네트워크의 처리 한도에 도달했어요.",
              retryable: true,
            },
          },
        });
      } else if (path.endsWith("/input")) {
        uploadCalls += 1;
        await route.fulfill({ status: 204 });
      } else {
        await route.fulfill({ status: 204 });
      }
    });
    await page.goto("/image/compress");
    await expect(page.getByText(/파일은 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "quota.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "용량 줄이기", exact: true }).click();
    await page.getByText("파일별 결과 보기").click();
    await expect(page.getByRole("button", { name: /원본 다운로드|결과 다운로드/ })).toBeVisible();
    await page.getByRole("button", { name: "다른 이미지 압축" }).click();
    await expect(page.locator('[data-policy="local"]')).toHaveText(
      "파일은 업로드하지 않고 이 기기에서 처리해요.",
    );
    expect(uploadCalls).toBe(0);
  });
});
