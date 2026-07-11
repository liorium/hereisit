import { readFile } from "node:fs/promises";
import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function createPdf(widths: readonly number[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (const width of widths) document.addPage([width, 100]);
  return Buffer.from(await document.save());
}

async function downloadedBytes(downloadPath: string | null): Promise<Uint8Array> {
  expect(downloadPath).not.toBeNull();
  return new Uint8Array(await readFile(downloadPath as string));
}

test("merges PDFs in the chosen order without external uploads", async ({ page }) => {
  await page.goto("/pdf/merge");
  const unexpectedRequests: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
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
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "second.pdf", mimeType: "application/pdf", buffer: await createPdf([200]) },
  ]);
  await page.getByRole("button", { name: "second.pdf 위로 이동" }).click();
  await page.getByRole("button", { name: "2개 PDF 합치기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("merged-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  const merged = await PDFDocument.load(output);
  expect(merged.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([200, 100]);
  expect(unexpectedRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("splits every PDF page into a ZIP", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });
  await page.getByRole("button", { name: "PDF 페이지별로 나누기 →" }).click();
  await expect(page.getByText("3개 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 3개 ZIP으로 받기 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("report-pages-hereisit.zip");
  const archive = unzipSync(await downloadedBytes(await download.path()));
  expect(Object.keys(archive)).toEqual([
    "report-page-001.pdf",
    "report-page-002.pdf",
    "report-page-003.pdf",
  ]);
  const second = archive["report-page-002.pdf"];
  expect(second).toBeDefined();
  const secondDocument = await PDFDocument.load(second as Uint8Array);
  expect(secondDocument.getPage(0).getWidth()).toBe(200);
});

test("extracts a validated page range into one PDF", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });
  await page.getByText("페이지 추출", { exact: true }).click();
  await page.getByLabel("페이지 범위").fill("2-3");
  await expect(page.getByText("2페이지를 선택했어요.")).toBeVisible();
  await page.getByRole("button", { name: "선택 페이지 추출하기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const extracted = await PDFDocument.load(output);
  expect(extracted.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([200, 300]);
});

test("creates one PDF page per image", async ({ page }) => {
  await page.goto("/pdf/image-to-pdf");
  await page.locator("input[type=file]").setInputFiles([
    { name: "one.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "two.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지로 PDF 만들기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("images-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  expect(new TextDecoder().decode(output.subarray(0, 5))).toBe("%PDF-");
  const document = await PDFDocument.load(output);
  expect(document.getPageCount()).toBe(2);
});

test("publishes every PDF route with unique metadata", async ({ page, request }) => {
  const tools = [
    ["/pdf/merge", "PDF 합치기", "PDF 파일 선택"],
    ["/pdf/split", "PDF 페이지 분할", "PDF 선택"],
    ["/pdf/image-to-pdf", "이미지를 PDF로 변환", "JPG·PNG 이미지 선택"],
  ] as const;

  await page.goto("/");
  for (const [path, title] of tools) {
    await expect(page.getByRole("link", { name: title }).first()).toHaveAttribute("href", path);
  }

  for (const [path, title, selectLabel] of tools) {
    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("button", { name: selectLabel })).toBeEnabled();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${path.replaceAll("/", "\\/")}\\/?$`),
    );
  }

  await page.goto("/pdf/split");
  const pdfCategoryLink = page.getByRole("link", { name: "PDF", exact: true });
  await expect(pdfCategoryLink).toHaveAttribute("data-active", "true");
  await expect(pdfCategoryLink).not.toHaveAttribute("aria-current");

  const response = await request.get("/sitemap.xml");
  const sitemap = await response.text();
  for (const [path] of tools) expect(sitemap).toContain(path);
});
