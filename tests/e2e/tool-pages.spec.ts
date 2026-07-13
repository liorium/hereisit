import { expect, test } from "@playwright/test";

const tools = [
  {
    path: "/image/compress",
    title: "이미지 용량 줄이기",
    selectLabel: "압축할 이미지 선택",
    preset: /용량만 줄이기/,
    runLabel: "1개 이미지 용량 줄이기 →",
  },
  {
    path: "/image/resize",
    title: "이미지 크기 조절",
    selectLabel: "크기를 바꿀 이미지 선택",
    preset: /웹용 이미지/,
    runLabel: "1개 이미지 크기 조절 →",
  },
  {
    path: "/image/convert",
    title: "이미지 형식 변환",
    selectLabel: "변환할 이미지 선택",
    preset: /형식만 바꾸기/,
    runLabel: "1개 이미지 형식 변환 →",
  },
] as const;

const pdfToImageTool = {
  path: "/pdf/to-image",
  title: "PDF를 JPG·PNG로 변환",
  selectLabel: "PDF 선택",
} as const;

const pdfCompressionTool = {
  path: "/pdf/compress",
  title: "스캔 PDF 용량 줄이기",
  selectLabel: "PDF 선택",
  description:
    "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
} as const;

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("links to dedicated image tools and initializes each intent", async ({ page }) => {
  await page.goto("/");
  for (const tool of tools) {
    await expect(page.getByRole("link", { name: tool.title }).first()).toHaveAttribute(
      "href",
      tool.path,
    );
  }

  for (const tool of tools) {
    const response = await page.goto(tool.path);
    expect(response?.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: tool.title })).toBeVisible();
    await expect(page.getByRole("button", { name: tool.selectLabel })).toBeEnabled();
    await page.locator("input[type=file]").setInputFiles({
      name: "sample.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await expect(page.getByRole("button", { name: tool.preset })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: tool.runLabel })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${tool.path.replaceAll("/", "\\/")}\\/?$`),
    );
  }
});

test("publishes dedicated routes in the sitemap", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBe(true);
  const sitemap = await response.text();
  for (const tool of tools) expect(sitemap).toContain(tool.path);
  expect(sitemap).toContain(pdfToImageTool.path);
  expect(sitemap).toContain(pdfCompressionTool.path);
});

test("publishes and links the scanned PDF compression tool", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: pdfCompressionTool.title }).first()).toHaveAttribute(
    "href",
    pdfCompressionTool.path,
  );

  const response = await page.goto(pdfCompressionTool.path);
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle(`${pdfCompressionTool.title} | HereIsIt`);
  await expect(
    page.getByRole("heading", { level: 1, name: pdfCompressionTool.title }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: pdfCompressionTool.selectLabel })).toBeEnabled();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    pdfCompressionTool.description,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hereisit.pages.dev/pdf/compress",
  );

  await page.goto("/pdf/merge");
  await expect(page.locator(`.related-tool-card[href="${pdfCompressionTool.path}"]`)).toBeVisible();
});

test("publishes and links the PDF to image tool", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: pdfToImageTool.title }).first()).toHaveAttribute(
    "href",
    pdfToImageTool.path,
  );

  const response = await page.goto(pdfToImageTool.path);
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: pdfToImageTool.title })).toBeVisible();
  await expect(page.getByRole("button", { name: pdfToImageTool.selectLabel })).toBeEnabled();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    new RegExp(`${pdfToImageTool.path.replaceAll("/", "\\/")}\\/?$`),
  );

  await page.goto("/pdf/merge");
  await expect(page.locator(`.related-tool-card[href="${pdfToImageTool.path}"]`)).toBeVisible();
});
