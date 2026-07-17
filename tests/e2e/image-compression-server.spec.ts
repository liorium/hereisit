import { expect, test } from "@playwright/test";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const jobId = "123e4567-e89b-42d3-a456-426614174001";
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
  await expect(page.getByText("업로드 없음 · 내 기기에서 처리")).toBeVisible();
  await expect(page.getByText("내 기기에서만 처리")).toHaveCount(0);
  const picker = page.getByRole("button", { name: "압축할 이미지 선택" });
  await expect(picker).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.getByText("sample.png")).toBeVisible();
  await page.getByRole("button", { name: "이미지 1개 압축하기" }).click();
  const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
  await expect(downloadButton).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  expect(download.suggestedFilename()).toBe("sample-hereisit.png");
  expect(jobRequests).toEqual([]);
});

test("keeps the mobile workbench in one column without horizontal overflow", async ({ page }) => {
  test.skip(serverModeEnabled, "requires the default local-only build");
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/image/compress");
  await expect(page.getByText("업로드 없음 · 내 기기에서 처리")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const action = page.getByRole("button", { name: "이미지 0개 압축하기" });
  await expect(action).toBeVisible();
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    (await page.getByRole("button", { name: "압축할 이미지 선택" }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(44);
});

test.describe("configured processing server", () => {
  test.skip(!serverModeEnabled, "requires a build with NEXT_PUBLIC_PROCESSING_API_ORIGIN");

  test("discloses upload before selection and downloads a verified same-format result", async ({
    page,
  }) => {
    const calls: string[] = [];
    const requestBodies: string[] = [];
    await page.addInitScript(() => {
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
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        });
      } else if (path.endsWith("/result")) {
        await route.fulfill({
          status: 200,
          body: onePixelPng,
          headers: {
            "content-type": "image/png",
            "content-length": String(onePixelPng.byteLength),
            "x-download-lease": "a".repeat(43),
          },
        });
      } else {
        await route.fulfill({ status: 204 });
      }
    });

    await page.goto("/image/compress");
    await expect(page.locator('[data-policy="checking"] strong')).toHaveText(
      "처리 방식을 확인하고 있어요.",
    );
    await expect(page.getByRole("button", { name: "압축할 이미지 선택" })).toBeDisabled();
    await expect(page.getByText(/선택한 이미지는 HereIsIt 처리 서버로 전송/)).toBeVisible();
    const picker = page.getByRole("button", { name: "압축할 이미지 선택" });
    await expect(picker).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({
      name: "server.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "이미지 1개 압축하기" }).click();
    const downloadButton = page.getByRole("button", { name: "결과 다운로드 ↓" });
    await expect(downloadButton).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
    expect(download.suggestedFilename()).toBe("server-hereisit.png");
    await expect(page.getByText(/기본 브라우저에서 열어 다시 다운로드해 주세요/)).toBeVisible();
    expect(requestBodies.every((body) => !body.includes("server.png"))).toBe(true);
    expect(calls.some((call) => call.includes("/downloaded"))).toBe(false);
    await page.getByRole("radio", { name: /최소 용량/ }).check();
    await expect(downloadButton).toHaveCount(0);
    await expect.poll(() => calls.includes(`DELETE /v1/jobs/${jobId}`)).toBe(true);
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
    await expect(page.getByText("서버 연결 실패 · 업로드 없이 내 기기에서 처리")).toBeVisible();
    await expect(page.getByRole("button", { name: "압축할 이미지 선택" })).toBeEnabled();
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
    await expect(page.getByText(/선택한 이미지는 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "lossless.webp",
      mimeType: "image/webp",
      buffer: structuralWebp(),
    });
    await page.getByRole("radio", { name: /무손실/ }).check();
    await page.getByRole("button", { name: "이미지 1개 압축하기" }).click();
    await expect(page.getByText("사용량 보호 · 업로드 없이 내 기기에서 처리")).toBeVisible();
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
    await expect(page.getByText(/선택한 이미지는 HereIsIt 처리 서버로 전송/)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "quota.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "이미지 1개 압축하기" }).click();
    await expect(page.getByText("사용량 보호 · 업로드 없이 내 기기에서 처리")).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 다운로드 ↓" })).toBeVisible();
    expect(uploadCalls).toBe(0);
  });
});
