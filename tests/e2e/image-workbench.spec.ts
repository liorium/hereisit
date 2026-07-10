import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("processes and downloads an image without external uploads", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self'");
  await expect(page.getByRole("heading", { name: "이미지 작업, 여기서 끝." })).toBeVisible();
  const uploadButton = page.getByRole("button", { name: "이미지 선택" });
  const fileInput = page.locator("input[type=file]");
  await expect(uploadButton).toBeEnabled();
  await expect(fileInput).toBeEnabled();

  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    const pageUrl = new URL(page.url());
    if (
      requestUrl.origin !== pageUrl.origin ||
      !["GET", "HEAD"].includes(request.method()) ||
      request.postData() !== null
    ) {
      unexpectedRequests.push(request.url());
    }
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

  const zipButton = page.getByRole("button", { name: "결과 1개 ZIP으로 받기 ↓" });
  const [download] = await Promise.all([page.waitForEvent("download"), zipButton.click()]);
  expect(download.suggestedFilename()).toBe("hereisit-images.zip");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(downloadPath as string)));
  expect(Object.keys(archive)).toEqual(["sample-hereisit.webp"]);
  const output = archive["sample-hereisit.webp"];
  expect(output).toBeDefined();
  expect(new TextDecoder().decode(output?.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(output?.subarray(8, 12))).toBe("WEBP");

  await page.getByLabel("출력 형식").selectOption("png");
  await expect(zipButton).toBeHidden();
  await expect(page.getByRole("button", { name: "1개 이미지 변환 →" })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("reaches the upload action through the real tab order", async ({ page }) => {
  await page.goto("/");
  const homeLink = page.getByRole("link", { name: "HereItIs 홈" });
  const uploadButton = page.getByRole("button", { name: "이미지 선택" });
  await expect(uploadButton).toBeEnabled();

  await page.keyboard.press("Tab");
  await expect(homeLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(uploadButton).toBeFocused();
});
