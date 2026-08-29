import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, type Page, test } from "@playwright/test";
import { installPrivacyObserver } from "./support/privacy-observer";

const PRODUCT_ANALYTICS_ORIGIN = "http://127.0.0.1:4173";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this suite requires the explicit analytics build fixture.
const analyticsBuildEnabled = process.env.HEREISIT_E2E_PRODUCT_ANALYTICS === "1";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function runImageConversion(page: Page, filename: string, download = true): Promise<void> {
  await page.goto("/image/convert");
  await convertSelectedImage(page, filename, download);
}

async function convertSelectedImage(page: Page, filename: string, download = true): Promise<void> {
  await page.locator("input[type=file]").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await page.getByRole("button", { name: "1개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "1개 이미지 변환 작업을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  if (!download) return;
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 다운로드 ↓" }).click(),
  ]);
}

async function createPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  return Buffer.from(await document.save());
}

test.skip(!analyticsBuildEnabled, "requires a build with product analytics enabled");

test("image analytics excludes file data and records only the aggregate funnel", async ({
  page,
}) => {
  const sentinel = "PRIVATE-IMAGE-NAME";
  const privacy = await installPrivacyObserver(page, {
    productAnalyticsOrigin: PRODUCT_ANALYTICS_ORIGIN,
    sentinels: [sentinel],
  });

  await runImageConversion(page, `${sentinel}.png`);

  expect((await privacy.read()).productEvents).toEqual([
    "processing-started",
    "processing-succeeded",
    "download-requested",
  ]);
  await privacy.assertClean(1, false);
});

test("PDF analytics records the aggregate funnel without file data", async ({ page }) => {
  const sentinel = "PRIVATE-PDF-NAME";
  const privacy = await installPrivacyObserver(page, {
    productAnalyticsOrigin: PRODUCT_ANALYTICS_ORIGIN,
    sentinels: [sentinel],
  });
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: `${sentinel}-1.pdf`, mimeType: "application/pdf", buffer: await createPdf() },
    { name: `${sentinel}-2.pdf`, mimeType: "application/pdf", buffer: await createPdf() },
  ]);
  await page.getByRole("button", { name: "PDF 합치기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible({
    timeout: 20_000,
  });
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click(),
  ]);

  expect((await privacy.read()).productEvents).toEqual([
    "processing-started",
    "processing-succeeded",
    "download-requested",
  ]);
  await privacy.assertClean(1, false);
});

test("a pending analytics request cannot delay a result or download", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/analytics/events", async (route) => {
    await gate;
    await route.fulfill({ status: 204 });
  });
  const privacy = await installPrivacyObserver(page, {
    productAnalyticsOrigin: PRODUCT_ANALYTICS_ORIGIN,
  });

  try {
    await runImageConversion(page, "pending.png");
    await privacy.assertClean(1, false);
  } finally {
    release();
  }
});

test("an aborted analytics request cannot fail a tool action", async ({ page }) => {
  await page.route("**/v1/analytics/events", (route) => route.abort("failed"));
  const privacy = await installPrivacyObserver(page, {
    productAnalyticsOrigin: PRODUCT_ANALYTICS_ORIGIN,
  });

  await runImageConversion(page, "aborted.png", false);

  await privacy.assertClean(0, false);
});

test("analytics creates no browser identity storage", async ({ page, context }) => {
  const privacy = await installPrivacyObserver(page, {
    productAnalyticsOrigin: PRODUCT_ANALYTICS_ORIGIN,
  });

  await page.goto("/image/convert");
  await expect.poll(async () => (await privacy.read()).storageWrites.length).toBeGreaterThan(0);
  await privacy.clear();
  await convertSelectedImage(page, "no-storage.png", false);

  expect((await privacy.read()).storageWrites).toEqual([]);
  expect(await context.cookies()).toEqual([]);
  await privacy.assertClean(0, false);
});
