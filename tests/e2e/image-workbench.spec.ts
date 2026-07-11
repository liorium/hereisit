import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

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
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self'");
  await expect(page.getByRole("heading", { name: "파일 작업, 여기서 끝." })).toBeVisible();
  const uploadButton = page.getByRole("button", { name: "이미지 선택" });
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
  await page.getByRole("button", { name: "1개 이미지 변환 →" }).click();

  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("1×1", { exact: true })).toBeVisible();

  const saveButton = page.getByRole("button", { name: "결과 저장·공유 ↓" });
  const [download] = await Promise.all([page.waitForEvent("download"), saveButton.click()]);
  expect(download.suggestedFilename()).toBe("sample-hereisit.webp");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const output = new Uint8Array(await readFile(downloadPath as string));
  expect(new TextDecoder().decode(output.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(output.subarray(8, 12))).toBe("WEBP");

  await page.getByLabel("출력 형식").selectOption("png");
  await expect(saveButton).toBeHidden();
  await expect(page.getByRole("button", { name: "1개 이미지 변환 →" })).toBeVisible();
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
  await page.goto("/");
  const homeLink = page.getByRole("link", { name: "HereItIs 홈" });
  const uploadButton = page.getByRole("button", { name: "이미지 선택" });
  await expect(uploadButton).toBeEnabled();

  await page.keyboard.press("Tab");
  await expect(homeLink).toBeFocused();
  for (const name of ["이미지", "PDF"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name, exact: true })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(uploadButton).toBeFocused();
});

test("makes a photo-like JPEG smaller in the size-only flow", async ({ page }) => {
  await page.goto("/");
  const input = await createPhotoLikeJpeg(page);
  await page.locator("input[type=file]").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: input,
  });

  await page.getByRole("button", { name: /용량만 줄이기/ }).click();
  await page.getByRole("button", { name: "1개 이미지 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 저장·공유 ↓" }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const output = new Uint8Array(await readFile(downloadPath as string));
  expect(output.byteLength).toBeLessThan(input.byteLength);
  expect(new TextDecoder().decode(output.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(output.subarray(8, 12))).toBe("WEBP");
});

test("does not produce a larger result in the size-only flow", async ({ page }) => {
  await page.goto("/");
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

  await page.getByRole("button", { name: "1개 이미지 변환 →" }).click();
  await expect(
    page.getByRole("status").getByText("이미 충분히 작아 더 줄이지 못했어요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("이미 최적화됨", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /ZIP으로 받기/ })).toBeHidden();
});

test("uses the device share sheet for one result when files are supported", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: (data: ShareData) => data.files?.length === 1,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        const file = data.files?.[0];
        if (file === undefined) throw new Error("Expected one shared file");
        (
          window as Window & { sharedResult?: { name: string; type: string; size: number } }
        ).sharedResult = {
          name: file.name,
          type: file.type,
          size: file.size,
        };
      },
    });
  });
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "share.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환을 완료했어요." }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "결과 저장·공유 ↓" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "결과를 공유 메뉴로 보냈어요." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { sharedResult?: { name: string; type: string; size: number } })
            .sharedResult,
      ),
    )
    .toMatchObject({ name: "share-hereisit.webp", type: "image/webp" });
});

test("accepts a real HEIC file without uploading it", async ({ page, browserName }) => {
  await page.goto("/");
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
  await page.getByRole("button", { name: "1개 이미지 변환 →" }).click();

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
