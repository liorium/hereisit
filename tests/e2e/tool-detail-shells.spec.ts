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
  workAreaLabel: "빠른 작업 영역" | "파일 작업 영역" | "편집 작업 공간",
  execution: "local" | "automatic" = "local",
): Promise<void> {
  const breadcrumb = page.getByRole("navigation", { name: "현재 위치" });
  await expect(breadcrumb).toBeVisible();
  for (const link of await breadcrumb.getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const heading = page.getByRole("heading", { level: 1, name: title });
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").getByRole("button", { name: /즐겨찾기/ })).toBeVisible();
  const disclosure = page.getByRole("region", { name: "처리 방식" });
  if (execution === "local") {
    await expect(disclosure.getByText("이 기기에서 처리", { exact: true })).toBeVisible();
    await expect(disclosure).toContainText(
      workAreaLabel === "빠른 작업 영역"
        ? "입력한 내용은 업로드되지 않으며 복사와 다운로드는 버튼을 눌러 직접 시작해요."
        : "파일은 업로드되지 않으며 다운로드는 버튼을 눌러 직접 시작해요.",
    );
    expect(
      await disclosure.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(12);
  } else {
    await expect(disclosure).toHaveCount(0);
  }
  await expect(page.getByRole("region", { name: workAreaLabel })).toBeVisible();

  for (const copy of oldStepsCopy) {
    await expect(page.getByText(copy, { exact: true })).toHaveCount(0);
  }
}

test("renders JSON formatting in the catalog-driven quick shell", async ({ page }) => {
  await page.goto("/data/json");

  await expectCatalogShell(page, "JSON 정리·검사", "빠른 작업 영역");
  await expectRelatedLinks(page, ["/image/convert", "/image/html-to-image", "/image/editor"]);
});

test("renders the image compressor in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/compress");

  await expectCatalogShell(page, "이미지 용량 줄이기", "파일 작업 영역", "automatic");
  await expectRelatedLinks(page, ["/image/resize", "/image/convert", "/image/watermark"]);
});

test("renders image resize in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/resize");

  await expectCatalogShell(page, "이미지 크기 조절", "파일 작업 영역");
  await expectRelatedLinks(page, ["/image/compress", "/image/convert", "/image/watermark"]);
});

test("renders image cropping in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/crop");

  await expectCatalogShell(page, "이미지 자르기", "파일 작업 영역");
  await expectRelatedLinks(page, ["/image/resize", "/image/rotate", "/image/compress"]);
});

test("renders image conversion in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/convert");

  await expectCatalogShell(page, "이미지 형식 변환", "파일 작업 영역");
  await expect(
    page.getByText("HEIC 변환은 Safari 17 이상에서 지원해요.", { exact: true }),
  ).toBeVisible();
  await expectRelatedLinks(page, ["/image/compress", "/image/resize", "/image/watermark"]);
});

test("renders image rotation in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/rotate");

  await expectCatalogShell(page, "이미지 회전", "파일 작업 영역");
  await expectRelatedLinks(page, ["/image/crop", "/image/resize", "/image/convert"]);
});

test("renders image watermarking in the catalog-driven file shell", async ({ page }) => {
  await page.goto("/image/watermark");

  await expectCatalogShell(page, "이미지에 워터마크 넣기", "파일 작업 영역");
  await expect(
    page.getByText("HEIC 워터마크는 Safari 17 이상에서 지원해요.", { exact: true }),
  ).toBeVisible();
  await expectRelatedLinks(page, ["/image/compress", "/image/resize", "/image/editor"]);
});
