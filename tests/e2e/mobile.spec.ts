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
    ["/pdf/to-image", "PDF를 JPG·PNG로 변환", "PDF 선택"],
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

test("keeps PDF image conversion ordered, sticky, and touch-safe", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  const pdf = Buffer.from(await document.save());

  await page.goto("/pdf/to-image");
  const origin = new URL(page.url()).origin;
  const requestViolations: string[] = [];
  let parserWorkerRequests = 0;
  let failedRequests = 0;
  let pageErrors = 0;
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) requestViolations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) requestViolations.push("write-method");
    if (request.postData() !== null) requestViolations.push("request-body");
    if (url.pathname === "/pdfjs/6.1.200/pdf.worker.min.mjs") parserWorkerRequests += 1;
    await route.continue();
  });
  page.context().on("requestfailed", () => {
    failedRequests += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  await page.locator("input[type=file]").setInputFiles({
    name: "mobile.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.")).toBeVisible({ timeout: 20_000 });

  const files = page.getByLabel("선택한 PDF");
  const settings = page.getByLabel("PDF 이미지 변환 설정");
  const result = page.getByLabel("PDF 이미지 변환 결과");
  const [filesBox, settingsBox, resultBox] = await Promise.all([
    files.boundingBox(),
    settings.boundingBox(),
    result.boundingBox(),
  ]);
  expect(filesBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  expect(filesBox?.y ?? 0).toBeLessThan(settingsBox?.y ?? 0);
  expect(settingsBox?.y ?? 0).toBeLessThan(resultBox?.y ?? 0);

  await page
    .getByRole("group", { name: "변환할 페이지" })
    .getByRole("radio", { name: /지정 페이지/ })
    .check();
  const pageRange = page.getByLabel("페이지 범위");
  await pageRange.fill("1");
  expect(
    await pageRange.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);

  const quality = page.getByRole("slider", { name: "JPG 품질 85" });
  const run = page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" });
  const controls = [
    page.getByRole("group", { name: "변환할 페이지" }),
    page.getByRole("group", { name: "출력 형식" }),
    page.getByRole("group", { name: "해상도" }),
    page.getByRole("group", { name: "JPG 품질 85" }),
    quality,
    pageRange,
    run,
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const actionBar = run.locator("..").locator("..");
  const viewportHeight = page.viewportSize()?.height ?? 0;
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 900);
  });
  const stickyBox = await actionBar.boundingBox();
  expect(await actionBar.evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
  expect(stickyBox).not.toBeNull();
  expect(
    Math.abs((stickyBox?.y ?? 0) + (stickyBox?.height ?? 0) - viewportHeight),
  ).toBeLessThanOrEqual(2);

  await page.evaluate(() => {
    const originalAnimationFrame = window.requestAnimationFrame.bind(window);
    const pendingFrames: FrameRequestCallback[] = [];
    const controlledWindow = window as Window & { __hereisitReleaseFrames?: () => void };
    window.requestAnimationFrame = (callback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    };
    controlledWindow.__hereisitReleaseFrames = () => {
      window.requestAnimationFrame = originalAnimationFrame;
      for (const callback of pendingFrames) originalAnimationFrame(callback);
      pendingFrames.length = 0;
    };
  });
  await run.click();
  const cancel = page.getByRole("button", { name: "작업 중단" });
  await expect(cancel).toBeVisible();
  const cancelBox = await cancel.boundingBox();
  expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await cancel.click();
  await page.evaluate(() => {
    (window as Window & { __hereisitReleaseFrames?: () => void }).__hereisitReleaseFrames?.();
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText("이미지 변환을 중단했어요.").first()).toBeVisible();

  await page.getByRole("button", { name: "1페이지 이미지로 변환하기 →" }).click();
  await expect(page.getByText("이미지 1개 준비 완료")).toBeVisible({ timeout: 60_000 });
  const save = page.getByRole("button", { name: "이미지 저장·공유 ↓" });
  const saveBox = await save.boundingBox();
  expect(saveBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(requestViolations).toEqual([]);
  expect(parserWorkerRequests).toBeGreaterThan(0);
  expect(failedRequests).toBe(0);
  expect(pageErrors).toBe(0);
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
