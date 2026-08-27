import { availableToolEntries, plannedToolEntries } from "@hereisit/tool-registry/catalog";
import { expect, type Locator, type Page, test } from "@playwright/test";

const tools = [
  {
    path: "/image/compress",
    title: "이미지 용량 줄이기",
    selectLabel: "이미지 선택",
    preset: /추천/,
    visiblePresets: [/추천/, /최소 용량/, /무손실/],
    presetControl: "radio",
    runLabel: "용량 줄이기",
  },
  {
    path: "/image/resize",
    title: "이미지 크기 조절",
    selectLabel: "크기를 바꿀 이미지 선택",
    preset: /웹용 이미지/,
    visiblePresets: [/웹용 이미지/, /상품 정사각형/, /SNS 정사각형/],
    presetControl: "button",
    runLabel: "1개 이미지 크기 조절 →",
  },
  {
    path: "/image/crop",
    title: "이미지 자르기",
    selectLabel: "자를 이미지 선택",
    preset: /정사각형 자르기/,
    visiblePresets: [/정사각형 자르기/, /가로 3:2 자르기/, /세로 4:5 자르기/],
    presetControl: "button",
    runLabel: "1개 이미지 자르기 →",
  },
  {
    path: "/image/convert",
    title: "이미지 형식 변환",
    selectLabel: "변환할 이미지 선택",
    preset: /형식만 바꾸기/,
    visiblePresets: [/형식만 바꾸기/],
    presetControl: "button",
    runLabel: "1개 이미지 형식 변환 →",
  },
  {
    path: "/image/rotate",
    title: "이미지 회전",
    selectLabel: "회전할 이미지 선택",
    preset: /오른쪽으로 90°/,
    visiblePresets: [/오른쪽으로 90°/, /180° 뒤집기/, /왼쪽으로 90°/],
    presetControl: "button",
    runLabel: "1개 이미지 회전 →",
  },
] as const;

const imageRoutes = [
  {
    path: "/image/compress",
    title: "이미지 용량 줄이기",
    description: "JPG, PNG, WebP 이미지를 원본 형식 그대로 압축하세요.",
  },
  {
    path: "/image/resize",
    title: "이미지 크기 조절",
    description: "사진의 가로·세로 크기를 빠르게 바꾸세요.",
  },
  {
    path: "/image/crop",
    title: "이미지 자르기",
    description: "원하는 비율로 이미지의 필요한 부분만 잘라내세요.",
  },
  {
    path: "/image/convert",
    title: "이미지 형식 변환",
    description: "JPG, PNG, WebP, HEIC 이미지를 원하는 형식으로 변환하세요.",
  },
  {
    path: "/image/rotate",
    title: "이미지 회전",
    description: "이미지를 90도 단위로 빠르게 회전하세요.",
  },
  {
    path: "/image/watermark",
    title: "이미지에 워터마크 넣기",
    description: "사진과 이미지에 문구 또는 로고를 넣으세요.",
  },
] as const;

const pdfToImageTool = {
  path: "/pdf/to-image",
  title: "PDF를 JPG·PNG로 변환",
  selectLabel: "PDF 선택",
} as const;

const pdfCompressionTool = {
  path: "/pdf/compress",
  title: "PDF 용량 줄이기",
  selectLabel: "PDF 선택",
  description:
    "텍스트와 링크를 유지하며 PDF 용량을 줄이세요. 기본은 임시 서버에서 처리하며 완료 후 자동 삭제합니다.",
} as const;

const jsonFormatTool = {
  path: "/data/json",
  title: "JSON 정리·검사",
  description:
    "JSON 문법을 검사하고 읽기 좋게 정리하거나 공백을 줄이세요. 내용은 브라우저 밖으로 나가지 않습니다.",
} as const;

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function revealCatalogTool(page: Page, route: string): Promise<Locator> {
  const link = page.locator(`[data-testid="available-tool-grid"] a[href="${route}"]`);
  await expect(page.getByTestId("available-tool-grid")).toBeVisible();
  while ((await link.count()) === 0) {
    const moreButton = page.getByRole("button", { name: "더 보기" });
    await expect(link.or(moreButton).first()).toBeVisible();
    if ((await link.count()) > 0) break;
    await moreButton.click();
  }
  return link;
}

test("links to dedicated image tools and initializes each intent", async ({ page }) => {
  await page.goto("/tools");
  for (const tool of tools) {
    await revealCatalogTool(page, tool.path);
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
    if (tool.presetControl === "radio") {
      await page.getByText("압축 설정 · 추천", { exact: true }).click();
      const presetGroup = page.getByRole("radiogroup", { name: "압축 프리셋" });
      await expect(presetGroup.getByRole("radio", { name: tool.preset })).toBeChecked();
      await expect(presetGroup.getByRole("radio")).toHaveCount(tool.visiblePresets.length);
      for (const visiblePreset of tool.visiblePresets) {
        await expect(presetGroup.getByRole("radio", { name: visiblePreset })).toBeVisible();
      }
    } else {
      await expect(page.getByRole("button", { name: tool.preset })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const presetGroup = page.getByRole("group", { name: "빠른 프리셋" });
      await expect(presetGroup.getByRole("button")).toHaveCount(tool.visiblePresets.length);
      for (const visiblePreset of tool.visiblePresets) {
        await expect(presetGroup.getByRole("button", { name: visiblePreset })).toBeVisible();
      }
    }
    await expect(page.getByRole("button", { name: tool.runLabel, exact: true })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`${tool.path.replaceAll("/", "\\/")}\\/?$`),
    );
  }
});

test("publishes every image route with unique metadata", async ({ page }) => {
  expect(new Set(imageRoutes.map((tool) => tool.path)).size).toBe(6);
  expect(new Set(imageRoutes.map((tool) => tool.title)).size).toBe(6);

  await page.goto("/tools");
  for (const tool of imageRoutes) {
    await revealCatalogTool(page, tool.path);
    await expect(page.getByRole("link", { name: tool.title }).first()).toHaveAttribute(
      "href",
      tool.path,
    );
  }

  for (const tool of imageRoutes) {
    const response = await page.goto(tool.path);
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle(`${tool.title} | HereIsIt`);
    await expect(page.getByRole("heading", { level: 1, name: tool.title })).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      new RegExp(`^${tool.description}`),
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://hereisit.app${tool.path}`,
    );
  }
});

test("publishes dedicated routes in the sitemap", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBe(true);
  const sitemap = await response.text();
  expect(sitemap).toContain("/tools");
  for (const tool of availableToolEntries) expect(sitemap).toContain(tool.route);
  for (const tool of plannedToolEntries) {
    expect(sitemap).not.toContain(`/${tool.id.replaceAll(".", "/")}`);
  }
});

test("publishes and links the privacy disclosure", async ({ page, request }) => {
  const paths = ["/", "/tools", ...availableToolEntries.map((tool) => tool.route), "/privacy"];

  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.ok()).toBe(true);
    await expect(
      page.locator("footer").getByRole("link", { name: "개인정보 보호" }),
    ).toHaveAttribute("href", "/privacy");
  }

  await expect(page.getByRole("heading", { level: 1, name: "개인정보 보호" })).toBeVisible();
  expect(await (await request.get("/sitemap.xml")).text()).toContain(
    "https://hereisit.app/privacy",
  );
});

test("publishes the scanned PDF compression tool", async ({ page }) => {
  await page.goto("/tools");
  await revealCatalogTool(page, pdfCompressionTool.path);
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
    "https://hereisit.app/pdf/compress",
  );
});

test("publishes the PDF to image tool", async ({ page }) => {
  await page.goto("/tools");
  await revealCatalogTool(page, pdfToImageTool.path);
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
});

test("formats JSON locally without changing value tokens", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __hereisitCopiedJson?: string }).__hereisitCopiedJson = value;
        },
      },
    });
  });

  await page.goto("/tools");
  await expect(await revealCatalogTool(page, jsonFormatTool.path)).toBeVisible();
  const response = await page.goto(jsonFormatTool.path);
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle(`${jsonFormatTool.title} | HereIsIt`);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    jsonFormatTool.description,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hereisit.app/data/json",
  );

  const violations: string[] = [];
  const sentinel = "PRIVATE_JSON_SENTINEL";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url()).origin) violations.push("cross-origin");
    if (!["GET", "HEAD"].includes(request.method())) violations.push("write-method");
    if (request.postDataBuffer() !== null) violations.push("request-body");
    if (request.url().includes(sentinel)) violations.push("sentinel-url");
  });

  const source = `{"private":"${sentinel}","big":9007199254740993,"decimal":1.2300,"exponent":1e+09,"escaped":"\\u0061","dup":1,"dup":2}`;
  const pretty = `{\n  "private": "${sentinel}",\n  "big": 9007199254740993,\n  "decimal": 1.2300,\n  "exponent": 1e+09,\n  "escaped": "\\u0061",\n  "dup": 1,\n  "dup": 2\n}`;
  const compact = source;
  const input = page.getByRole("textbox", { name: "JSON 입력" });

  await input.fill(source);
  await page.getByRole("button", { name: "정리하기", exact: true }).click();
  const result = page.getByRole("textbox", { name: "결과" });
  await expect(result).toHaveValue(pretty);

  await page.getByRole("button", { name: "결과 복사", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __hereisitCopiedJson?: string }).__hereisitCopiedJson,
      ),
    )
    .toBe(pretty);

  await page.getByRole("button", { name: "공백 줄이기", exact: true }).click();
  await expect(result).toHaveValue(compact);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 다운로드", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("minified.json");
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  if (stream === null) throw new Error("JSON download stream was not created");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(compact);

  await input.fill("{");
  await page.getByRole("button", { name: "정리하기", exact: true }).click();
  const alert = page.locator("#json-format-feedback");
  await expect(alert).toHaveText(
    "올바른 JSON 형식이 아니에요. 괄호, 쉼표와 따옴표를 확인해 주세요.",
  );
  await expect(alert).toBeFocused();
  await page.getByRole("button", { name: "지우기", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(result).toHaveCount(0);
  expect(violations).toEqual([]);
});

test("publishes every available catalog route from the complete tools page", async ({
  page,
  request,
}) => {
  await page.goto("/tools");
  for (const tool of availableToolEntries) {
    await expect(await revealCatalogTool(page, tool.route)).toBeVisible();
  }
  for (const tool of plannedToolEntries) {
    await expect(page.getByText(tool.name, { exact: true })).toHaveCount(0);
  }

  for (const tool of availableToolEntries) {
    // This loop verifies static publication, while the focused browser tests above cover
    // hydration and interaction. Keeping the catalog-route sweep on the request context also avoids
    // treating a transient WebKit navigation-process disconnect as an application regression.
    const response = await request.get(tool.route);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`<h1>${tool.name}</h1>`);
    expect(html).toContain(`<link rel="canonical" href="https://hereisit.app${tool.route}"/>`);
  }
});
