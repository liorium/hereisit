import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { encodeAnimatedGif } from "../../packages/browser-runtime/src/gif";
import { inspectImageHeader } from "../../packages/image-tool/src/file-format";

function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), body]);
    const result = Buffer.alloc(body.length + 12);
    result.writeUInt32BE(body.length, 0);
    payload.copy(result, 4);
    result.writeUInt32BE(crc32(payload), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const smallPng = png(100, 100);
async function selectImage(page: Page, buffer = smallPng) {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "sample.png", mimeType: "image/png", buffer });
  await expect(page.getByText("1개 이미지를 준비했어요.", { exact: true })).toBeVisible();
}

for (const mode of ["missing", "failure"] as const) {
  test(`upscale downloads exact dimensions with ${mode} bitmap decoder`, async ({ page }) => {
    await page.addInitScript((decoderMode) => {
      Object.defineProperty(window, "createImageBitmap", {
        configurable: true,
        value:
          decoderMode === "missing"
            ? undefined
            : () => Promise.reject(new Error("decoder unavailable")),
      });
    }, mode);
    await page.goto("/image/upscale");
    await selectImage(page);
    await page.getByLabel("확대", { exact: true }).selectOption("4");
    await page.getByRole("button", { name: "PNG 만들기", exact: true }).click();
    await expect(page.getByText("400×400", { exact: false })).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "결과 다운로드", exact: true }).click();
    const download = await pending;
    const path = await download.path();
    if (path === null) throw new Error("Download was not saved.");
    const bytes = await readFile(path);
    expect(inspectImageHeader(Uint8Array.from(bytes).buffer)).toMatchObject({
      width: 400,
      height: 400,
      mime: "image/png",
    });
  });
}

test("rejects 192MP output before bitmap allocation and shows the corrective action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { bitmapCalls: number };
    state.bitmapCalls = 0;
    window.createImageBitmap = (() => {
      state.bitmapCalls++;
      throw new Error("must not decode");
    }) as typeof createImageBitmap;
  });
  await page.goto("/image/upscale");
  await selectImage(page, png(4000, 3000));
  await page.getByLabel("확대", { exact: true }).selectOption("4");
  await page.getByRole("button", { name: "PNG 만들기", exact: true }).click();
  await expect(page.getByText(/더 작은 이미지나 낮은 확대 배율/)).toBeVisible();
  await expect(page.getByRole("button", { name: "결과 다운로드", exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { bitmapCalls: number }).bitmapCalls),
  ).toBe(0);
});

test("rejects oversized input before creating a preview URL", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { previewCalls: number };
    state.previewCalls = 0;
    const nativeUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof File) state.previewCalls++;
      return nativeUrl(blob);
    };
    Object.defineProperty(File.prototype, "size", { get: () => 21 * 1024 * 1024 });
  });
  await page.goto("/image/upscale");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "large.png", mimeType: "image/png", buffer: smallPng });
  await expect(page.getByText(/파일 하나는 최대 20MB/)).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { previewCalls: number }).previewCalls),
  ).toBe(0);
  await expect(page.getByRole("list", { name: "선택한 이미지" })).toHaveCount(0);
});

test("bounds ZIP URLs and releases source and result URLs when replacing files", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { imageUrls: Set<string> };
    state.imageUrls = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (
        blob instanceof Blob &&
        (blob.type.startsWith("image/") || blob.type === "application/zip")
      )
        state.imageUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      state.imageUrls.delete(url);
      revoke(url);
    };
  });
  await page.goto("/image/upscale");
  for (let index = 0; index < 3; index++) {
    await page.locator('input[type="file"]').setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: smallPng },
      { name: "two.png", mimeType: "image/png", buffer: smallPng },
    ]);
    await expect(page.getByText("2개 이미지를 준비했어요.", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { imageUrls: Set<string> }).imageUrls.size),
      )
      .toBe(2);
    await page.getByRole("button", { name: "PNG 만들기", exact: true }).click();
    await expect(page.getByText("2개 결과를 만들었어요.", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { imageUrls: Set<string> }).imageUrls.size),
      )
      .toBe(4);
    for (let downloadIndex = 0; downloadIndex < 2; downloadIndex++) {
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "결과 다운로드", exact: true }).click();
      await pending;
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { imageUrls: Set<string> }).imageUrls.size),
        )
        .toBe(5);
    }
  }
});

test("finishes manual blur with keyboard controls when automatic detection is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "FaceDetector", { configurable: true, value: undefined }),
  );
  await page.goto("/image/blur-face");
  await selectImage(page);
  await page.getByRole("button", { name: "영역 추가", exact: true }).focus();
  await page.keyboard.press("Enter");
  const horizontal = page.getByRole("spinbutton", { name: "가로 위치 (%)", exact: true });
  await horizontal.focus();
  await page.keyboard.press("ArrowUp");
  await expect(horizontal).toHaveValue("26");
  await page.getByRole("button", { name: "PNG 만들기", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("1개 결과를 만들었어요.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "결과 다운로드", exact: true }).focus();
  const pending = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const path = await (await pending).path();
  if (path === null) throw new Error("Download was not saved.");
  const bytes = await readFile(path);
  expect(inspectImageHeader(Uint8Array.from(bytes).buffer)).toMatchObject({
    width: 100,
    height: 100,
    mime: "image/png",
  });
});

test("converts animated GIF first frame without an animated source preview", async ({ page }) => {
  const gif = encodeAnimatedGif(
    [
      { width: 1, height: 1, pixels: new Uint8ClampedArray([255, 0, 0, 255]) },
      { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 255, 255]) },
    ],
    { delayMs: 80, loop: true },
  );
  await page.goto("/image/convert-to-jpg");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "animated.gif", mimeType: "image/gif", buffer: Buffer.from(gif) });
  await expect(page.getByText("1개 이미지를 준비했어요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "선택한 이미지" }).locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "JPG 만들기", exact: true }).click();
  await expect(page.getByText("1개 결과를 만들었어요.", { exact: true })).toBeVisible();
  const result = page.getByRole("img", { name: "animated.gif 결과", exact: true });
  const pixel = await result.evaluate(async (image) => {
    const decoded = image as HTMLImageElement;
    await decoded.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No canvas context");
    context.drawImage(decoded, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(240);
  expect(pixel[2]).toBeLessThan(20);
});
