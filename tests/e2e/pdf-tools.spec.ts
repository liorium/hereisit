import { readFile } from "node:fs/promises";
import { PDFDocument } from "@cantoo/pdf-lib";
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

async function createPdf(widths: readonly number[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (const width of widths) document.addPage([width, 100]);
  return Buffer.from(await document.save());
}

async function downloadedBytes(downloadPath: string | null): Promise<Uint8Array> {
  expect(downloadPath).not.toBeNull();
  return new Uint8Array(await readFile(downloadPath as string));
}

async function revealCatalogTool(page: Page, route: string): Promise<Locator> {
  const link = page.locator(`[data-testid="available-tool-grid"] a[href="${route}"]`);
  await expect(page.getByTestId("available-tool-grid")).toBeVisible();
  while ((await link.count()) === 0) {
    const moreButton = page.getByRole("button", { name: "더 보기" });
    await expect(link.or(moreButton).first()).toBeVisible();
    if ((await link.count()) > 0) break;
    await moreButton.click();
  }
  return link;
}

test("product analytics records one PDF merge and download", async ({ page }) => {
  test.skip(!analyticsBuildEnabled, "requires a build with product analytics enabled");
  const events: Record<string, unknown>[] = [];
  await page.route("**/v1/analytics/events", async (route) => {
    events.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 204 });
  });
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "second.pdf", mimeType: "application/pdf", buffer: await createPdf([200]) },
  ]);

  const merge = page.getByRole("button", { name: "PDF 합치기", exact: true });
  await expect(merge).toBeEnabled({ timeout: 20_000 });
  await merge.click();
  await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click(),
  ]);

  await expect.poll(() => events.length).toBe(3);
  expect(events.map(({ event }) => event)).toEqual([
    "processing-started",
    "processing-succeeded",
    "download-requested",
  ]);
  expect(events.every(({ toolId }) => toolId === "pdf.merge")).toBe(true);
  const allowed = new Set(["schema", "toolId", "event", "duration", "failure"]);
  expect(events.every((event) => Object.keys(event).every((key) => allowed.has(key)))).toBe(true);
});

test("merges PDFs in the chosen order without external uploads", async ({ page }) => {
  await installAvailableWebShare(page);
  await page.goto("/pdf/merge");
  const unexpectedRequests: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
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
    { name: "second.pdf", mimeType: "application/pdf", buffer: await createPdf([200, 200]) },
  ]);
  const selected = page.getByRole("region", { name: "합칠 PDF 순서" });
  await expect(selected.getByText("first.pdf", { exact: true })).toBeVisible();
  await expect(selected.getByText("1페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(selected.getByText("second.pdf", { exact: true })).toBeVisible();
  await expect(selected.getByText("2페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 합치기", exact: true })).toBeEnabled();
  await expect(page.getByText("설정", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "second.pdf 위로 이동" }).click();
  await expect(selected.locator("article").first()).toContainText("second.pdf");
  await page.getByRole("button", { name: "PDF 합치기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("2개 PDF · 3페이지", { exact: true })).toBeVisible();
  await expect(page.getByText(/\d+(?:\.\d+)?(?:KB|B) → \d+(?:\.\d+)?(?:KB|B)/)).toBeVisible();
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("merged-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  const merged = await PDFDocument.load(output);
  expect(merged.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([200, 200, 100]);
  expect(downloadCount).toBe(1);
  await expect(page.getByRole("status")).toContainText("다운로드를 시작했어요.");
  await page.getByRole("button", { name: "다른 PDF 합치기" }).click();
  await expect(page.getByRole("button", { name: "합칠 PDF 선택" })).toBeVisible();
  await expectWebShareUnused(page);
  expect(unexpectedRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("keeps a prepared PDF result retryable when download activation fails", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "second.pdf", mimeType: "application/pdf", buffer: await createPdf([200]) },
  ]);
  const merge = page.getByRole("button", { name: "PDF 합치기", exact: true });
  await expect(merge).toBeEnabled({ timeout: 20_000 });
  await merge.click();
  await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible({
    timeout: 20_000,
  });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("merged-hereisit.pdf");
});

test("keeps a split result retryable when download activation fails", async ({ page }) => {
  await installDownloadActivationController(page);
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "retry.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  const run = page.getByRole("button", { name: "PDF 페이지별로 나누기" });
  await expect(run).toBeEnabled({ timeout: 20_000 });
  await run.click();
  await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible({
    timeout: 20_000,
  });

  await setDownloadActivationBlocked(page, true);
  await page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click();
  await expect(page.getByRole("status")).toContainText(
    "다운로드를 시작하지 못했어요. 다시 시도해 주세요.",
  );
  await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible();

  await setDownloadActivationBlocked(page, false);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("retry-pages-hereisit.zip");
});

test("keeps a failed inspection removable and blocks merge", async ({ page }) => {
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: "valid.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
  ]);
  const selected = page.getByRole("region", { name: "합칠 PDF 순서" });
  await expect(selected).toContainText("broken.pdf");
  await expect(page.getByRole("button", { name: "PDF 합치기", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "broken.pdf 제거" })).toBeEnabled();
});

test("inspects a split PDF and rejects a page above its real page count", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });

  const setup = page.getByRole("region", { name: "PDF 나누기 설정" });
  await expect(setup.getByText("report.pdf", { exact: true })).toBeVisible();
  await expect(setup.getByText("3페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 페이지별로 나누기" })).toBeEnabled();

  await setup.getByRole("radio", { name: /페이지 추출/ }).check();
  const range = setup.getByLabel("페이지 범위");
  await expect(range).toHaveValue("");
  await expect(range).toHaveAttribute("placeholder", "예: 1-3, 5");
  await range.fill("4");
  await expect(setup.getByText("이 PDF는 3페이지까지 있어요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "선택 페이지 추출하기" })).toBeDisabled();
});

test("keeps a failed split inspection replaceable", async ({ page }) => {
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a pdf"),
  });

  const setup = page.getByRole("region", { name: "PDF 나누기 설정" });
  await expect(setup.getByRole("status")).toContainText(/확인할 수 없|다시 시도/, {
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "PDF 페이지별로 나누기" })).toBeDisabled();
  const replace = page.getByRole("button", { name: "PDF 교체" });
  await expect(replace).toBeEnabled();
  const fileChooser = page.waitForEvent("filechooser");
  await replace.click();
  await (await fileChooser).setFiles({
    name: "replacement.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });
  await expect(setup.getByText("replacement.pdf", { exact: true })).toBeVisible();
  await expect(setup.getByText("3페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 페이지별로 나누기" })).toBeEnabled();
});

test("splits every PDF page into a ZIP", async ({ page }) => {
  await installAvailableWebShare(page);
  await page.goto("/pdf/split");
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });
  await page.getByRole("button", { name: "PDF 페이지별로 나누기" }).click();
  await expect(page.getByRole("heading", { name: "나누기 완료" })).toBeVisible({
    timeout: 20_000,
  });
  const result = page.getByRole("region", { name: "PDF 나누기 결과" });
  await expect(result.getByText("3페이지 → PDF 3개", { exact: true })).toBeVisible();
  await expect(result.getByText(/\d+(?:\.\d+)?(?:KB|B) → \d+(?:\.\d+)?(?:KB|B)/)).toBeVisible();
  await expect(page.getByLabel("PDF 설정")).toHaveCount(0);
  expect(downloadCount).toBe(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click(),
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
  expect(downloadCount).toBe(1);
  await expect(page.getByRole("status")).toContainText("ZIP 다운로드를 시작했어요.");
  await expectWebShareUnused(page);
  await page.getByRole("button", { name: "다른 PDF 나누기" }).click();
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
});

test("downloads a one-page split result as a ZIP", async ({ page }) => {
  await installAvailableWebShare(page);
  let downloadCount = 0;
  page.on("download", () => {
    downloadCount += 1;
  });
  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100]),
  });
  await page.getByRole("button", { name: "PDF 페이지별로 나누기" }).click();
  await expect(page.getByText("1페이지 → PDF 1개", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  expect(downloadCount).toBe(0);
  await expect(page.getByRole("button", { name: "ZIP 다운로드 ↓" })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "ZIP 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("report-pages-hereisit.zip");
  const archive = unzipSync(await downloadedBytes(await download.path()));
  expect(Object.keys(archive)).toEqual(["report-page-001.pdf"]);
  const first = archive["report-page-001.pdf"];
  expect(first).toBeDefined();
  expect(new TextDecoder().decode((first as Uint8Array).subarray(0, 5))).toBe("%PDF-");
  const firstDocument = await PDFDocument.load(first as Uint8Array);
  expect(firstDocument.getPageCount()).toBe(1);
  expect(firstDocument.getPage(0).getWidth()).toBe(100);
  expect(downloadCount).toBe(1);
  await expect(
    page.getByRole("status").getByText("ZIP 다운로드를 시작했어요.", { exact: true }),
  ).toBeVisible();
  await expectWebShareUnused(page);
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
  await page.getByRole("button", { name: "선택 페이지 추출하기" }).click();
  await expect(page.getByRole("heading", { name: "추출 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("3페이지 → 2페이지", { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const extracted = await PDFDocument.load(output);
  expect(extracted.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([200, 300]);
});

test("reorders, rotates, and deletes PDF pages without external uploads", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("__hereisitOrganizerUiThreadPdfReads", "0");
    const originalArrayBuffer = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function arrayBuffer() {
      const count = Number(sessionStorage.getItem("__hereisitOrganizerUiThreadPdfReads") ?? "0");
      sessionStorage.setItem("__hereisitOrganizerUiThreadPdfReads", String(count + 1));
      return Reflect.apply(originalArrayBuffer, this, []);
    };
  });
  await page.goto("/pdf/organize");
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

  await page.locator("input[type=file]").setInputFiles({
    name: "handout.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200, 300]),
  });
  await expect(page.getByRole("heading", { name: "페이지 순서 정리" })).toBeFocused({
    timeout: 20_000,
  });
  const grid = page.getByRole("list", { name: "PDF 페이지 순서" });
  await expect(page.getByRole("status")).toHaveText(
    /페이지 미리보기를 준비했어요\.|미리보기 없이 페이지 번호로 정리할 수 있어요\./,
    { timeout: 20_000 },
  );
  const previews = grid.locator("img");
  const previewCount = await previews.count();
  expect([0, 3]).toContain(previewCount);
  if (previewCount === 3) {
    const previewSize = await previews.first().evaluate((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    expect(Math.min(previewSize.width, previewSize.height)).toBeGreaterThan(0);
    expect(Math.max(previewSize.width, previewSize.height)).toBeLessThanOrEqual(160);
  } else {
    await expect(page.getByRole("status")).toHaveText(
      "미리보기 없이 페이지 번호로 정리할 수 있어요.",
    );
  }

  const cards = grid.getByRole("listitem");
  await cards.nth(2).dragTo(cards.nth(0));
  await expect(cards.first()).toContainText("원본 3페이지");
  await page.getByRole("button", { name: "원본 3페이지 시계 방향으로 회전" }).click();
  await page.getByRole("button", { name: "원본 2페이지 삭제" }).click();
  await page.getByRole("button", { name: "2페이지로 PDF 만들기" }).click();
  await expect(page.getByRole("heading", { name: "페이지 정리 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("원본 3페이지 → 결과 2페이지", { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("handout-organized-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  const organized = await PDFDocument.load(output);
  expect(organized.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([300, 100]);
  expect(organized.getPages().map((pdfPage) => pdfPage.getRotation().angle)).toEqual([90, 0]);
  expect(unexpectedRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(
    await page.evaluate(() => sessionStorage.getItem("__hereisitOrganizerUiThreadPdfReads")),
  ).toBe("0");
});

test("creates one PDF page per image", async ({ page }) => {
  await page.goto("/pdf/image-to-pdf");
  await page.locator("input[type=file]").setInputFiles([
    { name: "one.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "two.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await expect(page.getByRole("heading", { name: "이미지 순서" })).toBeVisible();
  await page.getByRole("button", { name: "2장으로 PDF 만들기" }).click();
  await expect(page.getByRole("heading", { name: "PDF 만들기 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("이미지 2장 → PDF 2페이지", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "이미지 추가" })).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("images-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  expect(new TextDecoder().decode(output.subarray(0, 5))).toBe("%PDF-");
  const document = await PDFDocument.load(output);
  expect(document.getPageCount()).toBe(2);
});

test("adds a rasterized text watermark without external or write requests", async ({ page }) => {
  await page.goto("/pdf/watermark");
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

  await page.locator("input[type=file]").setInputFiles({
    name: "proposal.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  await expect(page.getByRole("heading", { name: "워터마크 설정" })).toBeVisible();
  await page.getByLabel("워터마크 텍스트").fill("검토용");
  await expect(page.getByLabel("모양 미리보기")).toContainText("검토용");
  await expect(page.getByText("글자 모양 설정")).toBeVisible();
  await page.getByRole("group", { name: "배치" }).getByLabel("반복").check();
  await page.getByRole("button", { name: "워터마크 넣기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "워터마크 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("전체 2페이지에 적용")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("proposal-watermarked-hereisit.pdf");
  const output = await downloadedBytes(await download.path());
  expect(new TextDecoder().decode(output.subarray(0, 5))).toBe("%PDF-");
  const watermarked = await PDFDocument.load(output);
  expect(watermarked.getPageCount()).toBe(2);
  expect(watermarked.getPages().every((pdfPage) => pdfPage.node.Contents() !== undefined)).toBe(
    true,
  );
  expect(unexpectedRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("watermarks only selected pages and revokes completed results", async ({ page }) => {
  await page.addInitScript(() => {
    const createdKey = "__hereisitCreatedCount";
    const revokedKey = "__hereisitRevokedCount";
    if (sessionStorage.getItem(createdKey) === null) sessionStorage.setItem(createdKey, "0");
    if (sessionStorage.getItem(revokedKey) === null) sessionStorage.setItem(revokedKey, "0");
    const originalCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const count = Number(sessionStorage.getItem(createdKey) ?? "0");
      sessionStorage.setItem(createdKey, String(count + 1));
      return originalCreate(object);
    };
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      const count = Number(sessionStorage.getItem(revokedKey) ?? "0");
      sessionStorage.setItem(revokedKey, String(count + 1));
      originalRevoke(url);
    };
  });
  await page.goto("/pdf/watermark");

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

  await page.locator("input[type=file]").setInputFiles({
    name: "selected.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });

  await page
    .getByRole("group", { name: "적용 페이지" })
    .getByRole("radio", {
      name: /지정 페이지/,
    })
    .check();

  const range = page.getByLabel("페이지 범위", { exact: true });
  const runButton = page.getByRole("button", { name: "워터마크 넣기", exact: true });
  await range.fill("3-");
  await expect(runButton).toBeDisabled();
  await expect(page.getByText("예: 1-3, 5, 8-10 형식으로 입력해 주세요.")).toBeVisible();

  await range.fill("3");
  await runButton.click();
  await expect(page.getByText("이 PDF는 2페이지까지 있어요.")).toBeVisible({ timeout: 20_000 });

  await range.fill("2");
  await runButton.click();
  await expect(page.getByRole("heading", { name: "워터마크 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("선택 1페이지에 적용")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const document = await PDFDocument.load(output);
  expect(document.getPage(0).node.Contents()).toBeUndefined();
  expect(document.getPage(1).node.Contents()).toBeDefined();

  await page.getByRole("button", { name: "다른 PDF에 넣기" }).click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(1);

  await page.locator("input[type=file]").setInputFiles({
    name: "selected-again.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  await page.getByRole("button", { name: "워터마크 넣기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "워터마크 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(2);
  await page.evaluate(() => {
    const nextWindow = window as Window & {
      next?: { router?: { push: (path: string) => void } };
    };
    const router = nextWindow.next?.router;
    if (router === undefined) throw new Error("Next router unavailable");
    router.push("/pdf/merge");
  });
  await expect(page.getByRole("heading", { level: 1, name: "PDF 합치기" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(2);

  expect(unexpectedRequests).toEqual([]);
});

test("publishes every PDF route with unique metadata", async ({ page, request }) => {
  const tools = [
    ["/pdf/merge", "PDF 합치기", "합칠 PDF 선택"],
    ["/pdf/split", "PDF 페이지 분할", "PDF 선택"],
    ["/pdf/to-image", "PDF를 JPG·PNG로 변환", "PDF 선택"],
    ["/pdf/image-to-pdf", "이미지를 PDF로 변환", "JPG·PNG 이미지 선택"],
    ["/pdf/organize", "PDF 페이지 정리", "정리할 PDF 선택"],
    ["/pdf/watermark", "PDF 워터마크 넣기", "워터마크를 넣을 PDF 선택"],
    ["/pdf/compress", "PDF 용량 줄이기", "PDF 선택"],
  ] as const;

  await page.goto("/tools");
  for (const [path] of tools) {
    const link = await revealCatalogTool(page, path);
    await expect(link).toHaveAttribute("href", path);
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
    if (path === "/pdf/compress") {
      await expect(page).toHaveTitle("PDF 용량 줄이기 | HereIsIt");
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        "텍스트와 링크를 유지하며 PDF 용량을 줄이세요. 기본은 임시 서버에서 처리하며 완료 후 자동 삭제합니다.",
      );
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        "https://hereisit.app/pdf/compress",
      );
    }
  }

  await page.goto("/pdf/split");
  const toolsMenuButton = page.getByRole("button", { name: "모든 도구", exact: true });
  await expect(toolsMenuButton).toHaveAttribute("data-active", "true");
  await expect(toolsMenuButton).not.toHaveAttribute("aria-current");

  const response = await request.get("/sitemap.xml");
  const sitemap = await response.text();
  for (const [path] of tools) expect(sitemap).toContain(path);
});
