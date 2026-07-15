import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, type Locator, test } from "@playwright/test";
import { installPrivacyObserver } from "./support/privacy-observer";

const PDF_COMPRESSION_WARNING =
  "모든 페이지가 이미지로 바뀝니다. 검색·복사 가능한 텍스트와 OCR, 링크·양식·주석·북마크·첨부파일·레이어가 제거되거나 평면화되고 전자서명은 무효가 됩니다. 스캔 문서에 적합하며 원본 파일은 수정하지 않아요.";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function expectFunctionalTextFloor(
  samples: readonly { label: string; locator: Locator }[],
): Promise<void> {
  const readings: { label: string; fontSize: number }[] = [];
  for (const sample of samples) {
    await expect(sample.locator, sample.label).toBeVisible();
    readings.push({
      label: sample.label,
      fontSize: await sample.locator.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
    });
  }
  const belowFloor = readings.filter(({ fontSize }) => fontSize < 12);
  expect(
    belowFloor,
    `Computed functional font sizes: ${readings
      .map(({ label, fontSize }) => `${label}=${fontSize}px`)
      .join(", ")}`,
  ).toEqual([]);
}

async function holdTerminalWorkerEvents(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const releaseCallbacks: Array<() => void> = [];
    let released = false;
    class HeldTerminalWorker {
      private readonly native: Worker;
      private readonly pending: MessageEvent<unknown>[] = [];
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        this.native = new NativeWorker(scriptURL, options);
        this.native.onmessage = (event) => {
          const type = (event.data as { type?: unknown } | null)?.type;
          if ((type === "complete" || type === "failed") && !released) this.pending.push(event);
          else this.onmessage?.(event);
        };
        this.native.onmessageerror = (event) => this.onmessageerror?.(event);
        this.native.onerror = (event) => this.onerror?.(event);
        releaseCallbacks.push(() => {
          for (const event of this.pending.splice(0)) this.onmessage?.(event);
        });
      }

      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (transfer === undefined) this.native.postMessage(message);
        else this.native.postMessage(message, transfer);
      }

      terminate(): void {
        this.native.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: HeldTerminalWorker });
    (window as Window & { __releaseHeldWorkerEvents?: () => void }).__releaseHeldWorkerEvents =
      () => {
        released = true;
        for (const release of releaseCallbacks) release();
      };
  });
}

async function createMobilePng(page: import("@playwright/test").Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas unavailable");
    context.fillStyle = "#f5f5f4";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value === null) reject(new Error("PNG encoding failed"));
        else resolve(value);
      }, "image/png");
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function addPngTextChunk(png: Buffer, text: string): Buffer {
  const type = Buffer.from("tEXt");
  const data = Buffer.from(`Comment\0${text}`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([length, type, data, checksum]);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

async function createMobileScannedPdf(page: import("@playwright/test").Page): Promise<Buffer> {
  const jpegBase64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1_275;
    canvas.height = 1_650;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas unavailable");
    const image = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const pixel = offset / 4;
      image.data[offset] = (pixel * 17) % 256;
      image.data[offset + 1] = (pixel * 31 + Math.floor(pixel / canvas.width)) % 256;
      image.data[offset + 2] = (pixel * 47) % 256;
      image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/jpeg", 1).split(",")[1] ?? "";
  });
  const document = await PDFDocument.create();
  const image = await document.embedJpg(Buffer.from(jpegBase64, "base64"));
  const outputPage = document.addPage([612, 792]);
  outputPage.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return Buffer.from(await document.save());
}

test("keeps the home discovery flow inside an iPhone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "파일 작업, 여기서 끝." })).toBeVisible();
  const fileSelect = page.getByRole("button", { name: "파일 선택" });
  await expect(fileSelect).toBeEnabled();
  const fileSelectBox = await fileSelect.boundingBox();
  expect(fileSelectBox).not.toBeNull();
  expect(fileSelectBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((fileSelectBox?.y ?? 0) + (fileSelectBox?.height ?? 569)).toBeLessThanOrEqual(568);
  await expect(page.getByRole("tablist", { name: "도구 분야" }).getByRole("tab")).toHaveCount(8);
  await expect(page.getByRole("tabpanel")).toBeAttached();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(viewport?.width).toBeLessThan(viewport?.height ?? 0);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("shows representative image and PDF selectors in the initial 390 by 844 viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, label] of [
    ["/image/compress", "압축할 이미지 선택"],
    ["/pdf/organize", "정리할 PDF 선택"],
  ] as const) {
    await page.goto(path);
    const selector = page.getByRole("button", { name: label, exact: true });
    await expect(selector).toBeEnabled({ timeout: 60_000 });
    const box = await selector.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 845)).toBeLessThanOrEqual(844);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  }
});

test("starts each representative work area inside a 320 by 568 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  for (const [path, regionName] of [
    ["/image/compress", "파일 작업 영역"],
    ["/pdf/organize", "편집 작업 공간"],
  ] as const) {
    await page.goto(path);
    const box = await page.getByRole("region", { name: regionName }).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? 569).toBeLessThan(568);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
});

test("keeps image compression preset text readable after selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/image/compress");
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" })).toBeEnabled();

  const preset = page.getByRole("button", { name: /용량만 줄이기/ });
  await expectFunctionalTextFloor([
    { label: "compression preset name", locator: preset.locator("strong") },
    { label: "compression preset description", locator: preset.locator("small") },
    { label: "compression preset badge", locator: preset.locator("em") },
  ]);
});

test("keeps scanned PDF compression ordered, keyboard-reachable, sticky, and touch-safe", async ({
  page,
}) => {
  await page.goto("/pdf/compress");
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({ timeout: 60_000 });
  await expect(
    page.getByText("PDF 1개 · 1바이트~50MB · 최대 100페이지 · 파일은 이 기기에서만 처리돼요."),
  ).toBeVisible();
  await expect(page.getByText(PDF_COMPRESSION_WARNING, { exact: true })).toHaveCount(2);
  await expect(
    page.getByText("용량을 더 줄이지만 작은 글자가 흐려질 수 있어요.", { exact: true }),
  ).toBeVisible();

  const balanced = page.getByRole("radio", { name: /균형 150DPI/ });
  const minimum = page.getByRole("radio", { name: /최소 용량 96DPI/ });
  await expect(balanced).toBeChecked();
  await expect(minimum).not.toBeChecked();
  for (const preset of [balanced, minimum]) {
    const box = await preset.locator("..").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.locator("input[type=file]").setInputFiles({
    name: "mobile-scan.pdf",
    mimeType: "application/pdf",
    buffer: await createMobileScannedPdf(page),
  });
  await expect(page.getByText("1페이지 PDF를 불러왔어요.").first()).toBeVisible({
    timeout: 60_000,
  });

  const source = page.getByLabel("원본 PDF");
  const settings = page.getByLabel("PDF 압축 설정");
  const result = page.getByLabel("PDF 압축 결과");
  const [sourceBox, settingsBox, resultBox] = await Promise.all([
    source.boundingBox(),
    settings.boundingBox(),
    result.boundingBox(),
  ]);
  expect(sourceBox?.y ?? 0).toBeLessThan(settingsBox?.y ?? 0);
  expect(settingsBox?.y ?? 0).toBeLessThan(resultBox?.y ?? 0);

  const sourceStatus = source.getByText("1페이지 · 페이지 수만 압축 준비에 사용해요.", {
    exact: true,
  });
  await expectFunctionalTextFloor([
    { label: "PDF compression panel state", locator: settings.getByText("LOCAL", { exact: true }) },
    { label: "PDF compression file order", locator: source.getByText("01", { exact: true }) },
    { label: "PDF compression file name", locator: source.locator("article strong") },
    { label: "PDF compression inspection status", locator: sourceStatus },
    {
      label: "PDF compression control help",
      locator: settings.getByText("글자 가독성과 용량의 균형을 맞춰요.", { exact: true }),
    },
    {
      label: "PDF compression action status",
      locator: page.getByRole("status").getByText(/1페이지 PDF ·/),
    },
  ]);

  const run = page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" });
  const runBox = await run.boundingBox();
  expect(runBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(runBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const actionBar = run.locator("..").locator("..");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  let reachedBalanced = false;
  for (let index = 0; index < 30 && !reachedBalanced; index += 1) {
    await page.keyboard.press("Tab");
    reachedBalanced = await balanced.evaluate((element) => document.activeElement === element);
  }
  expect(reachedBalanced).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(minimum).toBeChecked();

  let reachedRun = false;
  for (let index = 0; index < 12 && !reachedRun; index += 1) {
    await page.keyboard.press("Tab");
    reachedRun = await run.evaluate((element) => document.activeElement === element);
  }
  expect(reachedRun).toBe(true);

  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 1_200);
  });
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const stickyBox = await actionBar.boundingBox();
  expect(await actionBar.evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
  const actionBarClass = await actionBar.evaluate((element) => element.classList.item(0));
  expect(actionBarClass).not.toBeNull();
  expect(
    await page.evaluate((runtimeClass) => {
      const containsSafeAreaActionRule = (rules: CSSRuleList): boolean =>
        Array.from(rules).some((rule) => {
          if (
            runtimeClass !== null &&
            rule.cssText.includes(`.${runtimeClass}`) &&
            rule.cssText.includes("env(safe-area-inset-bottom)")
          ) {
            return true;
          }
          const nestedRules = (rule as CSSMediaRule).cssRules;
          return nestedRules === undefined ? false : containsSafeAreaActionRule(nestedRules);
        });
      return Array.from(document.styleSheets).some((styleSheet) =>
        containsSafeAreaActionRule(styleSheet.cssRules),
      );
    }, actionBarClass),
  ).toBe(true);
  expect(
    await actionBar.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    ),
  ).toBeGreaterThanOrEqual(14);
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
  await page.keyboard.press("Enter");
  const cancel = page.getByRole("button", { name: "작업 중단" });
  await expect(cancel).toBeVisible();
  const cancelBox = await cancel.boundingBox();
  expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await cancel.click();
  await page.evaluate(() => {
    (window as Window & { __hereisitReleaseFrames?: () => void }).__hereisitReleaseFrames?.();
  });
  await expect(page.getByText("PDF 압축을 중단했어요.").first()).toBeVisible();

  await page.getByRole("button", { name: "1페이지 PDF 용량 줄이기 →" }).click();
  await expect(page.getByText("압축 PDF 준비 완료")).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("region", { name: "PDF 압축 결과" }).getByText(PDF_COMPRESSION_WARNING, {
      exact: true,
    }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "PDF 다운로드 ↓" });
  const saveBox = await save.boundingBox();
  expect(saveBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("keeps PDF image conversion ordered, sticky, and touch-safe", async ({
  browserName,
  page,
}) => {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  const pdf = Buffer.from(await document.save());

  const sentinelFilename = "PRIVATE_MOBILE_PDF_SENTINEL.pdf";
  const privacy = await installPrivacyObserver(page, {
    sentinels: [sentinelFilename, "PRIVATE_MOBILE_PDF_BYTES"],
  });
  await page.goto("/pdf/to-image");
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({ timeout: 60_000 });
  await privacy.clear();
  await page.locator("input[type=file]").setInputFiles({
    name: sentinelFilename,
    mimeType: "application/pdf",
    buffer: Buffer.concat([pdf, Buffer.from("\n% PRIVATE_MOBILE_PDF_BYTES")]),
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
  const save = page.getByRole("button", { name: "이미지 다운로드 ↓" });
  const saveBox = await save.boundingBox();
  expect(saveBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  const selectedPages = settings.getByRole("radio", { name: /지정 페이지/ }).locator("..");
  await expectFunctionalTextFloor([
    {
      label: "PDF to-image option legend",
      locator: settings.getByText("변환할 페이지", { exact: true }),
    },
    { label: "PDF to-image option label", locator: selectedPages.locator("strong") },
    { label: "PDF to-image option help", locator: selectedPages.locator("small") },
    {
      label: "PDF to-image range label",
      locator: settings.getByText("페이지 범위", { exact: true }),
    },
    {
      label: "PDF to-image range status",
      locator: settings.getByText("1페이지를 선택했어요.", { exact: true }),
    },
    {
      label: "PDF to-image format legend",
      locator: settings.getByText("출력 형식", { exact: true }),
    },
    {
      label: "PDF to-image format control",
      locator: settings.getByRole("radio", { name: "JPG", exact: true }).locator(".."),
    },
    {
      label: "PDF to-image result limitation",
      locator: result.getByText("텍스트는 더 이상 검색하거나 선택할 수 없어요.", {
        exact: true,
      }),
    },
    {
      label: "PDF to-image action status",
      locator: page.getByRole("status").getByText(/1페이지 PDF ·/),
    },
  ]);
  const observation = await privacy.read();
  expect(observation.externalRequests).toEqual([]);
  expect(observation.writeRequests).toEqual([]);
  expect(observation.consoleMessages.filter((type) => ["error", "assert"].includes(type))).toEqual(
    [],
  );
  await privacy.assertClean(0, browserName !== "firefox");
});

test("keeps representative image and PDF error feedback reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });

  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  const imageStatus = page.getByRole("status").filter({ hasText: "형식·파일당 50MB" });
  await imageStatus.scrollIntoViewIfNeeded();
  await expect(imageStatus).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await page.goto("/pdf/organize");
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a pdf"),
  });
  const pdfStatus = page.getByRole("status").filter({ hasText: /확인할 수 없|다시 시도/ });
  await pdfStatus.scrollIntoViewIfNeeded();
  await expect(pdfStatus).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("keeps PDF settings and controls touch-safe", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([200, 300]);
  document.addPage([300, 200]);
  const pdf = Buffer.from(await document.save());

  await page.goto("/pdf/split");
  const splitInput = page.locator("input[type=file]");
  await expect(splitInput).toBeEnabled({ timeout: 60_000 });
  await splitInput.setInputFiles({
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

  const splitSettings = page.getByLabel("PDF 설정");
  const extractOption = splitSettings.getByRole("radio", { name: /페이지 추출/ }).locator("..");
  await expectFunctionalTextFloor([
    {
      label: "PDF option legend",
      locator: splitSettings.getByText("나눌 방식", { exact: true }),
    },
    { label: "PDF option label", locator: extractOption.locator("strong") },
    { label: "PDF option help", locator: extractOption.locator("small") },
    {
      label: "PDF range control label",
      locator: splitSettings.getByText("페이지 범위", { exact: true }),
    },
    {
      label: "PDF range control help",
      locator: range.locator("..").locator("small"),
    },
  ]);

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
  const organizeInput = page.locator("input[type=file]");
  await expect(organizeInput).toBeEnabled({ timeout: 60_000 });
  await organizeInput.setInputFiles({
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
    page.getByRole("button", { name: "페이지 순서 초기화" }),
    page.getByRole("button", { name: "3페이지 정리하기 →" }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "2페이지 시계 방향으로 회전" }).click();
  await page.getByRole("button", { name: "2페이지 삭제" }).click();
  await page.getByRole("button", { name: "페이지 순서 초기화" }).click();
  await page.getByRole("button", { name: "3페이지 정리하기 →" }).click();
  await expect(page.getByText("3페이지 PDF 준비 완료")).toBeVisible({ timeout: 20_000 });

  const save = page.getByRole("button", { name: "PDF 다운로드 ↓" });
  await expect(save).toBeVisible();
  const saveBox = await save.boundingBox();
  expect(saveBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const actionBar = save.locator("..").locator("..");
  expect(await actionBar.evaluate((element) => getComputedStyle(element).position)).toBe("sticky");

  const viewportHeight = page.viewportSize()?.height ?? 0;
  const workArea = page.getByRole("region", { name: "편집 작업 공간" });
  await workArea.evaluate((element) => {
    document.documentElement.style.scrollBehavior = "auto";
    const bounds = element.getBoundingClientRect();
    window.scrollTo(0, window.scrollY + bounds.top + 16);
  });
  const stickyBox = await actionBar.boundingBox();
  expect(stickyBox).not.toBeNull();
  expect(
    Math.abs((stickyBox?.y ?? 0) + (stickyBox?.height ?? 0) - viewportHeight),
  ).toBeLessThanOrEqual(2);

  await expectFunctionalTextFloor([
    {
      label: "PDF organizer reset action",
      locator: page.getByRole("button", { name: "페이지 순서 초기화" }),
    },
    {
      label: "PDF organizer help",
      locator: page.getByText("왼쪽 목록을 위아래로 옮기고, 90도씩 돌리거나 결과에서 빼세요.", {
        exact: true,
      }),
    },
    {
      label: "PDF organizer page order",
      locator: page.getByRole("region", { name: "PDF 페이지 순서" }).getByText("01", {
        exact: true,
      }),
    },
    {
      label: "PDF organizer page label",
      locator: page.getByRole("region", { name: "PDF 페이지 순서" }).getByText("원본 1페이지", {
        exact: true,
      }),
    },
    {
      label: "PDF organizer rotation state",
      locator: page
        .getByRole("region", { name: "PDF 페이지 순서" })
        .getByText("회전 0°", {
          exact: true,
        })
        .first(),
    },
  ]);
  const orderPanelTitle = page.getByText("페이지 순서", { exact: true }).locator("..");
  expect(await orderPanelTitle.evaluate((element) => element.getBoundingClientRect().height)).toBe(
    44,
  );

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
  const watermarkInput = page.locator("input[type=file]");
  await expect(watermarkInput).toBeEnabled({ timeout: 60_000 });
  await watermarkInput.setInputFiles({
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
    page.getByRole("button", { name: "PDF 다운로드 ↓" }),
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
  const resizeInput = page.locator("input[type=file]");
  await expect(resizeInput).toBeEnabled({ timeout: 60_000 });
  await resizeInput.setInputFiles({
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

  const resizePreset = page.getByRole("button", { name: /웹용 이미지/ });
  await expectFunctionalTextFloor([
    { label: "resize preset name", locator: resizePreset.locator("strong") },
    { label: "resize preset description", locator: resizePreset.locator("small") },
    { label: "resize preset badge", locator: resizePreset.locator("em") },
    { label: "resize keep action", locator: page.getByRole("button", { name: "유지" }) },
    {
      label: "resize maximum action",
      locator: page.getByRole("button", { name: "최대 크기" }),
    },
    {
      label: "resize crop action",
      locator: page.getByRole("button", { name: "정사각 자르기" }),
    },
  ]);

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

test("keeps image watermark controls ordered, reachable, and inside an iPhone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await holdTerminalWorkerEvents(page);
  const sentinelFilename = "PRIVATE_MOBILE_IMAGE_SENTINEL.png";
  const sentinelBytes = "PRIVATE_MOBILE_IMAGE_BYTES";
  const privacy = await installPrivacyObserver(page, {
    sentinels: [sentinelFilename, sentinelBytes],
  });
  await page.goto("/image/watermark");
  await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();
  await privacy.clear();
  const source = addPngTextChunk(await createMobilePng(page), sentinelBytes);
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: sentinelFilename,
    mimeType: "image/png",
    buffer: source,
  });

  const files = page.getByLabel("선택한 이미지");
  const settings = page.getByLabel("워터마크 설정");
  const preview = page.getByLabel("원본 정보와 워터마크 결과");
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

  const positions = page.getByRole("group", { name: "위치" }).getByRole("radio");
  await expect(positions).toHaveCount(9);
  for (let index = 0; index < 9; index += 1) {
    const box = await positions.nth(index).locator("..").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const run = page.getByRole("button", { name: "1개 이미지에 워터마크 넣기 →" });
  await run.scrollIntoViewIfNeeded();
  await expect(run).toBeInViewport();
  const runBox = await run.boundingBox();
  expect(runBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(runBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(
    await run
      .locator("..")
      .locator("..")
      .evaluate((element) => getComputedStyle(element).position),
  ).toBe("sticky");

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);

  await run.click();
  const cancel = page.getByRole("button", { name: "작업 중단" });
  await expect(cancel).toBeVisible();
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.evaluate(() => {
    (window as Window & { __releaseHeldWorkerEvents?: () => void }).__releaseHeldWorkerEvents?.();
  });
  await expect(page.getByText("1개 이미지 워터마크 처리를 완료했어요.")).toBeVisible({
    timeout: 20_000,
  });
  const resultDownload = page.getByRole("button", { name: "결과 다운로드 ↓" });
  const selectedDownload = page.getByRole("button", { name: "선택 파일 다운로드 ↓" });
  await resultDownload.scrollIntoViewIfNeeded();
  await expect(resultDownload).toBeInViewport();
  for (const target of [resultDownload, selectedDownload]) {
    const box = await target.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const watermarkSettings = page.getByLabel("워터마크 설정");
  await expectFunctionalTextFloor([
    {
      label: "watermark mode control",
      locator: watermarkSettings.getByRole("radio", { name: "문구", exact: true }).locator(".."),
    },
    {
      label: "watermark position control",
      locator: watermarkSettings
        .getByRole("radio", { name: "정가운데", exact: true })
        .locator(".."),
    },
    {
      label: "watermark text field label",
      locator: watermarkSettings.getByText("워터마크 문구", { exact: true }),
    },
    {
      label: "watermark color field label",
      locator: watermarkSettings.getByText("문구 색상", { exact: true }),
    },
    {
      label: "watermark range label",
      locator: watermarkSettings.getByText("문구 크기", { exact: true }),
    },
    {
      label: "watermark range value",
      locator: watermarkSettings.getByText("12%", { exact: true }),
    },
    {
      label: "watermark output control label",
      locator: watermarkSettings.getByText("출력 형식", { exact: true }),
    },
    {
      label: "watermark contract state",
      locator: watermarkSettings.getByText("image.watermark@1", { exact: true }),
    },
    {
      label: "watermark file status",
      locator: files.locator("small").first(),
    },
    {
      label: "watermark source limitation",
      locator: page.getByText("원본 파일은 메인 화면에서 디코드하지 않아요.", { exact: true }),
    },
  ]);
  const observation = await privacy.read();
  expect(observation.externalRequests).toEqual([]);
  expect(observation.writeRequests).toEqual([]);
  expect(observation.consoleMessages.filter((type) => ["error", "assert"].includes(type))).toEqual(
    [],
  );
  await privacy.assertClean(0, false);
});
