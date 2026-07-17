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
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
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
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const extracted = await PDFDocument.load(output);
  expect(extracted.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([200, 300]);
});

test("reorders, rotates, and deletes PDF pages without external uploads", async ({ page }) => {
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
  await expect(page.getByText("3페이지를 불러왔어요.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "3페이지 위로 이동" }).click();
  await page.getByRole("button", { name: "3페이지 위로 이동" }).click();
  await page.getByRole("button", { name: "3페이지 시계 방향으로 회전" }).click();
  await page.getByRole("button", { name: "2페이지 삭제" }).click();
  await page.getByRole("button", { name: "2페이지 정리하기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

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
  await page.getByLabel("워터마크 텍스트").fill("검토용");
  await page.getByRole("group", { name: "배치" }).getByLabel("반복 타일").check();
  await page.getByRole("button", { name: "워터마크 넣기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

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

test("watermarks only selected pages and revokes the previous result", async ({ page }) => {
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

  await page.getByRole("button", { name: "PDF에 워터마크 넣기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(1);

  await page
    .getByRole("group", { name: "적용 페이지" })
    .getByRole("radio", {
      name: /지정 페이지/,
    })
    .check();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(1);

  const range = page.getByLabel("페이지 범위", { exact: true });
  const runButton = page.getByRole("button", { name: "PDF에 워터마크 넣기 →" });
  await range.fill("3-");
  await expect(runButton).toBeDisabled();
  await expect(page.getByText("예: 1-3, 5, 8-10 형식으로 입력해 주세요.")).toBeVisible();

  await range.fill("3");
  await runButton.click();
  await expect(page.getByText("이 PDF는 2페이지까지 있어요.")).toBeVisible({ timeout: 20_000 });

  await range.fill("2");
  await runButton.click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(2);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PDF 다운로드 ↓" }).click(),
  ]);
  const output = await downloadedBytes(await download.path());
  const document = await PDFDocument.load(output);
  expect(document.getPage(0).node.Contents()).toBeUndefined();
  expect(document.getPage(1).node.Contents()).toBeDefined();

  await range.fill("1");
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(2);
  await runButton.click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))), {
      timeout: 20_000,
    })
    .toBe(3);

  await page.getByRole("button", { name: "같은 설정으로 다시 실행" }).click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))), {
      timeout: 20_000,
    })
    .toBe(4);
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(3);

  await page.getByRole("button", { name: "새 작업" }).click();
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitRevokedCount"))))
    .toBe(4);

  await page.locator("input[type=file]").setInputFiles({
    name: "selected-again.pdf",
    mimeType: "application/pdf",
    buffer: await createPdf([100, 200]),
  });
  await page.getByRole("button", { name: "PDF에 워터마크 넣기 →" }).click();
  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => Number(sessionStorage.getItem("__hereisitCreatedCount"))))
    .toBe(5);
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
    .toBe(5);

  expect(unexpectedRequests).toEqual([]);
});

test("publishes every PDF route with unique metadata", async ({ page, request }) => {
  const tools = [
    ["/pdf/merge", "PDF 합치기", "PDF 파일 선택"],
    ["/pdf/split", "PDF 페이지 분할", "PDF 선택"],
    ["/pdf/to-image", "PDF를 JPG·PNG로 변환", "PDF 선택"],
    ["/pdf/image-to-pdf", "이미지를 PDF로 변환", "JPG·PNG 이미지 선택"],
    ["/pdf/organize", "PDF 페이지 정리", "정리할 PDF 선택"],
    ["/pdf/watermark", "PDF 워터마크 넣기", "워터마크를 넣을 PDF 선택"],
    ["/pdf/compress", "스캔 PDF 용량 줄이기", "PDF 선택"],
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
    if (path === "/pdf/compress") {
      await expect(page).toHaveTitle("스캔 PDF 용량 줄이기 | HereIsIt");
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
      );
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        "https://hereisit.pages.dev/pdf/compress",
      );
    }
  }

  await page.goto("/pdf/split");
  const pdfCategoryLink = page.getByRole("link", { name: "PDF", exact: true });
  await expect(pdfCategoryLink).toHaveAttribute("data-active", "true");
  await expect(pdfCategoryLink).not.toHaveAttribute("aria-current");

  const response = await request.get("/sitemap.xml");
  const sitemap = await response.text();
  for (const [path] of tools) expect(sitemap).toContain(path);
});
