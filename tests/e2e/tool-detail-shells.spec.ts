import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, test } from "@playwright/test";

const oldStepsCopy = ["3 STEPS", "선택하고, 처리하고, 저장하세요."] as const;

async function expectRelatedLinks(
  page: import("@playwright/test").Page,
  expectedHrefs: readonly string[],
): Promise<void> {
  const related = page.getByRole("region", { name: "다음 작업" });
  await expect(related).toBeVisible();

  const links = related.getByRole("link");
  await expect(links).toHaveCount(expectedHrefs.length);
  for (const [index, href] of expectedHrefs.entries()) {
    await expect(links.nth(index)).toHaveAttribute("href", href);
  }
}

async function expectCatalogShell(
  page: import("@playwright/test").Page,
  title: string,
  workAreaLabel: "파일 작업 영역" | "편집 작업 공간",
): Promise<void> {
  await expect(page.getByRole("navigation", { name: "현재 위치" })).toBeVisible();
  const heading = page.getByRole("heading", { level: 1, name: title });
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").getByRole("button", { name: /즐겨찾기/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "처리 방식" }).getByText("이 기기에서 처리", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: workAreaLabel })).toBeVisible();

  for (const copy of oldStepsCopy) {
    await expect(page.getByText(copy, { exact: true })).toHaveCount(0);
  }
}

test("renders the image compressor in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/compress");

  await expectCatalogShell(page, "이미지 용량 줄이기", "파일 작업 영역");
  await expectRelatedLinks(page, ["/image/resize", "/image/convert", "/image/watermark"]);
});

test("renders image resize in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/resize");

  await expectCatalogShell(page, "이미지 크기 조절", "파일 작업 영역");
  await expectRelatedLinks(page, ["/image/compress", "/image/convert", "/image/watermark"]);
});

test("renders image conversion in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/convert");

  await expectCatalogShell(page, "이미지 형식 변환", "파일 작업 영역");
  await expect(
    page.getByText("HEIC 변환은 Safari 17 이상에서 지원해요.", { exact: true }),
  ).toBeVisible();
  await expectRelatedLinks(page, ["/image/compress", "/image/resize", "/pdf/image-to-pdf"]);
});

test("renders image watermarking in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/watermark");

  await expectCatalogShell(page, "이미지에 워터마크 넣기", "파일 작업 영역");
  await expect(
    page.getByText("HEIC 워터마크는 Safari 17 이상에서 지원해요.", { exact: true }),
  ).toBeVisible();
  await expectRelatedLinks(page, ["/image/compress", "/image/resize", "/pdf/watermark"]);
});

test("renders the PDF organizer in the catalog-driven workspace shell", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([100, 200]);
  document.addPage([200, 100]);

  await page.goto("/pdf/organize");

  await expectCatalogShell(page, "PDF 페이지 정리", "편집 작업 공간");
  await expect(page.getByRole("region", { name: "파일 작업 영역" })).toHaveCount(0);
  await expectRelatedLinks(page, ["/pdf/merge", "/pdf/split", "/pdf/watermark"]);

  const input = page.locator("input[type=file]");
  await expect(input).toBeEnabled({ timeout: 60_000 });
  await input.setInputFiles({
    name: "organize.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  });
  await expect(page.getByText("2페이지를 불러왔어요.")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole("button", { name: "2페이지 위로 이동" })).toBeVisible();
  await expect(page.getByRole("button", { name: "2페이지 아래로 이동" })).toBeVisible();
  await page.getByRole("button", { name: "2페이지 시계 방향으로 회전" }).click();
  await page.getByRole("button", { name: "2페이지 삭제" }).click();
  await page.getByRole("button", { name: "페이지 순서 초기화" }).click();
  await page.getByRole("button", { name: "2페이지 정리하기 →" }).click();

  await expect(page.getByText("2페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "PDF 저장·공유 ↓" })).toBeVisible();
});
