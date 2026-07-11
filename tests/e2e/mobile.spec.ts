import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, test } from "@playwright/test";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("keeps the primary upload flow inside an iPhone viewport", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "파일 작업, 여기서 끝." })).toBeVisible();
  await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(viewport?.width).toBeLessThan(viewport?.height ?? 0);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("keeps every dedicated tool inside an iPhone viewport", async ({ page }) => {
  const tools = [
    ["/image/compress", "이미지 용량 줄이기", "압축할 이미지 선택"],
    ["/image/resize", "이미지 크기 조절", "크기를 바꿀 이미지 선택"],
    ["/image/convert", "이미지 형식 변환", "변환할 이미지 선택"],
    ["/pdf/merge", "PDF 합치기", "PDF 파일 선택"],
    ["/pdf/split", "PDF 페이지 분할", "PDF 선택"],
    ["/pdf/image-to-pdf", "이미지를 PDF로 변환", "JPG·PNG 이미지 선택"],
    ["/pdf/organize", "PDF 페이지 정리", "정리할 PDF 선택"],
    ["/pdf/watermark", "PDF 워터마크 넣기", "워터마크를 넣을 PDF 선택"],
  ] as const;

  for (const [path, title, selectLabel] of tools) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("button", { name: selectLabel })).toBeEnabled();
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  }
});

test("keeps PDF settings and controls touch-safe", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  document.addPage([300, 200]);
  const pdf = Buffer.from(await document.save());

  await page.goto("/pdf/split");
  await page.locator("input[type=file]").setInputFiles({
    name: "sample.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });

  const files = page.getByLabel("선택한 파일");
  const settings = page.getByLabel("PDF 설정");
  const result = page.getByLabel("PDF 결과 미리보기");
  const [filesBox, settingsBox, resultBox] = await Promise.all([
    files.boundingBox(),
    settings.boundingBox(),
    result.boundingBox(),
  ]);
  expect(filesBox?.y ?? 0).toBeLessThan(settingsBox?.y ?? 0);
  expect(settingsBox?.y ?? 0).toBeLessThan(resultBox?.y ?? 0);

  await page.getByText("페이지 추출", { exact: true }).click();
  const range = page.getByLabel("페이지 범위");
  const fontSize = await range.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(fontSize).toBeGreaterThanOrEqual(16);

  const remove = page.getByRole("button", { name: "sample.pdf 제거" });
  const removeBox = await remove.boundingBox();
  expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("keeps PDF organizer controls touch-safe without horizontal overflow", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([100, 200]);
  document.addPage([200, 100]);
  document.addPage([300, 100]);

  await page.goto("/pdf/organize");
  await page.locator("input[type=file]").setInputFiles({
    name: "organize.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  });
  await expect(page.getByText("3페이지를 불러왔어요.")).toBeVisible({ timeout: 20_000 });

  const controls = [
    page.getByRole("button", { name: "2페이지 위로 이동" }),
    page.getByRole("button", { name: "2페이지 아래로 이동" }),
    page.getByRole("button", { name: "2페이지 시계 방향으로 회전" }),
    page.getByRole("button", { name: "2페이지 삭제" }),
    page.getByRole("button", { name: "3페이지 정리하기 →" }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("runs the watermark Worker with touch-safe controls on an iPhone", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);

  await page.goto("/pdf/watermark");
  await page.locator("input[type=file]").setInputFiles({
    name: "mobile.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  });
  const text = page.getByLabel("워터마크 텍스트");
  await text.fill("대외비");
  const placement = page.getByRole("group", { name: "배치" }).getByLabel("반복 타일");
  await placement.check();
  const opacity = page.getByLabel(/불투명도/);
  const scope = page
    .getByRole("group", { name: "적용 페이지" })
    .getByRole("radio", { name: /지정 페이지/ });
  await scope.check();
  const range = page.getByLabel("페이지 범위", { exact: true });
  await range.fill("1");
  const rangeFontSize = await range.evaluate((element) => getComputedStyle(element).fontSize);
  expect(rangeFontSize).toBe("16px");
  const run = page.getByRole("button", { name: "워터마크 넣기 →" });

  for (const control of [text, placement.locator(".."), opacity, scope.locator(".."), range, run]) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await run.click();
  await expect(page.getByText("1페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });
  const resultActions = [
    page.getByRole("button", { name: "같은 설정으로 다시 실행" }),
    page.getByRole("button", { name: "PDF 저장·공유 ↓" }),
  ];
  for (const control of resultActions) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("puts settings before the preview with touch-safe controls", async ({ page }) => {
  await page.goto("/image/resize");
  await page.locator("input[type=file]").setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  const files = page.getByLabel("선택한 이미지");
  const settings = page.getByLabel("변환 설정");
  const preview = page.getByLabel("이미지 미리보기");
  const [filesBox, settingsBox, previewBox] = await Promise.all([
    files.boundingBox(),
    settings.boundingBox(),
    preview.boundingBox(),
  ]);
  expect(filesBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(filesBox?.y ?? 0).toBeLessThan(settingsBox?.y ?? 0);
  expect(settingsBox?.y ?? 0).toBeLessThan(previewBox?.y ?? 0);

  const outputFormat = page.getByLabel("출력 형식");
  const fontSize = await outputFormat.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(fontSize).toBeGreaterThanOrEqual(16);

  const removeButton = page.getByRole("button", { name: "sample.png 제거" });
  const removeBox = await removeButton.boundingBox();
  expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const runButton = page.getByRole("button", { name: "1개 이미지 크기 조절 →" });
  const actionBar = runButton.locator("..").locator("..");
  const viewportHeight = page.viewportSize()?.height ?? 0;
  await expect(runButton).toBeInViewport();
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 900);
  });
  const stickyBox = await actionBar.boundingBox();
  expect(stickyBox).not.toBeNull();
  expect(
    Math.abs((stickyBox?.y ?? 0) + (stickyBox?.height ?? 0) - viewportHeight),
  ).toBeLessThanOrEqual(2);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});
