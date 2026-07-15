import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  expectWebShareUnused,
  installAvailableWebShare,
  installDownloadActivationController,
  setDownloadActivationBlocked,
} from "./support/result-download";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

test("makes a photo-like JPEG smaller in the size-only flow", async ({ page }) => {
  await page.goto("/image/compress");
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: input,
  });

  await page.getByRole("button", { name: /용량만 줄이기/ }).click();
  await page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const output = new Uint8Array(await readFile(downloadPath as string));
  expect(output.byteLength).toBeLessThan(input.byteLength);
  expect(new TextDecoder().decode(output.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(output.subarray(8, 12))).toBe("WEBP");
});

test("does not produce a larger result in the size-only flow", async ({ page }) => {
  await page.goto("/image/compress");
  const fileInput = page.locator("input[type=file]");
  await fileInput.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await page.getByRole("button", { name: /용량만 줄이기/ }).click();
  await page.getByLabel("출력 형식").selectOption("png");
  await expect(page.getByLabel("원본보다 작을 때만 완료")).toBeChecked();
  await expect(page.getByText("PNG 무손실은 용량이 커질 수 있어요.")).toBeVisible();
  await page.getByLabel("출력 형식").selectOption("webp");
  await expect(page.locator("input[type=range]")).toHaveValue("82");
  await page.getByLabel("출력 형식").selectOption("png");

  await page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" }).click();
  await expect(
    page.getByRole("status").getByText("이미 충분히 작아 더 줄이지 못했어요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("이미 최적화됨", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /ZIP으로 받기/ })).toBeHidden();
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

  const [selectedDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "이 이미지 다운로드 ↓" }).click(),
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

test("does not download a pending image ZIP after the workbench unmounts", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
    const tracked = window as Window & {
      __heldZipMicrotasks?: VoidFunction[];
      __holdZipMicrotasks?: boolean;
      __releaseZipMicrotasks?: () => Promise<void>;
      __zipMicrotasksToHold?: number;
      __zipMicrotasksToPassThrough?: number;
    };
    tracked.__heldZipMicrotasks = [];
    globalThis.queueMicrotask = (callback) => {
      if (!tracked.__holdZipMicrotasks) {
        nativeQueueMicrotask(callback);
        return;
      }
      if ((tracked.__zipMicrotasksToPassThrough ?? 0) > 0) {
        tracked.__zipMicrotasksToPassThrough = (tracked.__zipMicrotasksToPassThrough ?? 0) - 1;
        nativeQueueMicrotask(callback);
        return;
      }
      if ((tracked.__heldZipMicrotasks?.length ?? 0) < (tracked.__zipMicrotasksToHold ?? 0)) {
        tracked.__heldZipMicrotasks?.push(callback);
        return;
      }
      nativeQueueMicrotask(callback);
    };
    tracked.__releaseZipMicrotasks = async () => {
      for (const callback of tracked.__heldZipMicrotasks ?? []) nativeQueueMicrotask(callback);
      tracked.__heldZipMicrotasks = [];
      await new Promise<void>((resolve) => nativeQueueMicrotask(resolve));
    };
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

  let downloads = 0;
  const pageErrors: string[] = [];
  page.on("download", () => {
    downloads += 1;
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluate(() => {
    const tracked = window as Window & {
      __holdZipMicrotasks?: boolean;
      __zipMicrotasksToHold?: number;
      __zipMicrotasksToPassThrough?: number;
    };
    tracked.__holdZipMicrotasks = true;
    tracked.__zipMicrotasksToHold = 2;
    tracked.__zipMicrotasksToPassThrough = 1;
  });
  await page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }).click();
  const archiveAction = page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" });
  await expect(archiveAction).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("ZIP 파일을 만들고 있어요.");
  await archiveAction.evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __heldZipMicrotasks?: VoidFunction[] }).__heldZipMicrotasks
            ?.length ?? 0,
      ),
    )
    .toBe(2);
  await page.evaluate(() => {
    (window as Window & { __holdZipMicrotasks?: boolean }).__holdZipMicrotasks = false;
  });
  await page.getByRole("link", { name: "HereIsIt 홈" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "파일 작업, 여기서 끝." })).toBeVisible();
  await page.evaluate(async () => {
    await (
      window as Window & { __releaseZipMicrotasks?: () => Promise<void> }
    ).__releaseZipMicrotasks?.();
  });

  expect(downloads).toBe(0);
  expect(pageErrors).toEqual([]);
  await expect(page.getByText("ZIP 다운로드를 시작했어요.", { exact: true })).toHaveCount(0);
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
