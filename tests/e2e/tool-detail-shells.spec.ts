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
      "파일은 업로드되지 않으며 다운로드는 버튼을 눌러 직접 시작해요.",
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
  await expect(page.getByRole("button", { name: "PDF 다운로드 ↓" })).toBeVisible();
});

const remainingPdfShells = [
  {
    path: "/pdf/merge",
    title: "PDF 합치기",
    notice:
      "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
    related: ["/pdf/split", "/pdf/organize", "/pdf/image-to-pdf"],
  },
  {
    path: "/pdf/split",
    title: "PDF 페이지 분할",
    notice:
      "암호로 잠긴 PDF는 지원하지 않아요. 기존 전자서명은 새 PDF에서 무효화되고, 북마크·양식은 유지되지 않을 수 있어요.",
    related: ["/pdf/merge", "/pdf/organize", "/pdf/to-image"],
  },
  {
    path: "/pdf/watermark",
    title: "PDF 워터마크 넣기",
    notice:
      "워터마크 문구는 호환성을 위해 이미지로 그려져 검색하거나 선택할 수 없어요. 기존 전자서명도 새 PDF에서 무효화됩니다.",
    related: ["/pdf/organize", "/pdf/merge", "/image/watermark"],
  },
  {
    path: "/pdf/image-to-pdf",
    title: "이미지를 PDF로 변환",
    notice: "광색역·16비트 이미지는 PDF에서 색감이나 정밀도가 달라질 수 있어요.",
    related: ["/pdf/to-image", "/pdf/merge", "/image/convert"],
  },
  {
    path: "/pdf/to-image",
    title: "PDF를 JPG·PNG로 변환",
    notice:
      "결과는 래스터 이미지라 텍스트를 검색하거나 선택할 수 없고, 주석·양식 모양은 평면화되며 색상 프로필이 달라질 수 있어요.",
    related: ["/pdf/image-to-pdf", "/pdf/split", "/image/convert"],
  },
  {
    path: "/pdf/compress",
    title: "스캔 PDF 용량 줄이기",
    notice:
      "모든 페이지가 이미지로 바뀝니다. 검색·복사 가능한 텍스트와 OCR, 링크·양식·주석·북마크·첨부파일·레이어가 제거되거나 평면화되고 전자서명은 무효가 됩니다. 스캔 문서에 적합하며 원본 파일은 수정하지 않아요.",
    related: ["/pdf/merge", "/pdf/split", "/pdf/to-image"],
  },
] as const;

for (const tool of remainingPdfShells) {
  test(`renders ${tool.path} in its catalog-driven file shell`, async ({ page }) => {
    await page.goto(tool.path);

    await expectCatalogShell(page, tool.title, "파일 작업 영역");
    const shellHeader = page
      .getByRole("heading", { level: 1, name: tool.title })
      .locator("xpath=ancestor::header");
    await expect(shellHeader.getByText(tool.notice, { exact: true })).toBeVisible();
    await expectRelatedLinks(page, tool.related);
  });
}
