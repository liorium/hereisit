import { readFile } from "node:fs/promises";
import { expect, type Locator, test } from "@playwright/test";
import { installPrivacyObserver } from "./support/privacy-observer";

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

const RESPONSIVE_RESULT_WIDTHS = [320, 390, 600, 601, 800, 801, 1280] as const;

async function expectResponsiveResultActions(
  page: import("@playwright/test").Page,
  actions: readonly Locator[],
): Promise<void> {
  for (const width of RESPONSIVE_RESULT_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const action of actions) {
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  }
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
  await expect(page.getByRole("tablist", { name: "도구 분야" }).getByRole("tab")).toHaveCount(7);
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

test("shows representative image selectors in the initial 390 by 844 viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, label] of [["/image/compress", "이미지 선택"]] as const) {
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
    ["/data/json", "빠른 작업 영역"],
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
  await expect(page.getByRole("radio", { name: /고성능 서버 압축/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /내 기기에서 처리/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect(page.getByRole("button", { name: "용량 줄이기", exact: true })).toBeEnabled();

  await page.getByText("압축 설정 · 추천", { exact: true }).click();
  const preset = page.getByRole("radio", { name: /추천/ }).locator("..");
  await expectFunctionalTextFloor([
    { label: "compression preset name", locator: preset.locator("strong") },
    { label: "compression preset description", locator: preset.locator("span") },
  ]);
});

test("keeps mixed HEIC compression guidance visible across narrow responsive widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/image/compress");
  const heic = await readFile("tests/fixtures/rainbow-451x461.heic");
  const guidance =
    "1개 이미지를 확인했어요. HEIC·HEIF는 같은 형식으로 압축할 수 없어 1개를 제외했어요. 이미지 형식 변환 도구를 이용해 주세요.";

  await page.locator('input[type="file"][multiple]').setInputFiles([
    { name: "sample.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "disguised.jpg", mimeType: "image/jpeg", buffer: heic },
  ]);

  await expect(page.getByRole("status")).toHaveText(guidance);
  const visualStatus = page.getByTestId("image-workbench-status");
  await expect(visualStatus).toHaveText(guidance);
  expect(
    await visualStatus.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ).toMatchObject({ whiteSpace: "normal" });
  const widths = await visualStatus.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);

  await page.setViewportSize({ width: 900, height: 844 });
  await expect(visualStatus).toHaveCSS("white-space", "normal");
  const narrowDesktopWidths = await visualStatus.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(narrowDesktopWidths.scrollWidth).toBeLessThanOrEqual(narrowDesktopWidths.clientWidth + 1);
  await expect(page.getByText("disguised.jpg", { exact: true })).toHaveCount(0);
});

test("keeps general image result actions touch-safe at every responsive boundary", async ({
  page,
}) => {
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.goto("/image/convert");
  await page.locator("input[type=file]").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: onePixelPng },
    { name: "second.png", mimeType: "image/png", buffer: onePixelPng },
  ]);
  await page.getByRole("button", { name: "2개 이미지 형식 변환 →" }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "2개 이미지 변환 작업을 완료했어요." }),
  ).toBeVisible({ timeout: 20_000 });
  expect(downloads).toBe(0);
  await expectResponsiveResultActions(page, [
    page.getByRole("button", { name: "이 이미지 다운로드 ↓" }),
    page.getByRole("button", { name: "결과 2개 ZIP 다운로드 ↓" }),
  ]);
  expect(downloads).toBe(0);
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
    {
      label: "resize keep action",
      locator: page.getByRole("button", { name: "유지", exact: true }),
    },
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

test("keeps representative image error feedback reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/image/compress");
  await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();
  await page.locator("input[type=file]").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("status")).toContainText("JPG, PNG, WebP 정지 이미지");
  const imageStatus = page.getByTestId("image-workbench-status").filter({ hasText: "파일당 30MB" });
  await imageStatus.scrollIntoViewIfNeeded();
  await expect(imageStatus).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
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
  await expectResponsiveResultActions(page, [
    page.getByRole("button", { name: "선택 파일 다운로드 ↓" }),
    page.getByRole("button", { name: "결과 다운로드 ↓" }),
  ]);
  const observation = await privacy.read();
  expect(observation.externalRequests).toEqual([]);
  expect(observation.writeRequests).toEqual([]);
  expect(observation.consoleMessages.filter((type) => ["error", "assert"].includes(type))).toEqual(
    [],
  );
  await privacy.assertClean(0);
});
