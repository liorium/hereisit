import { availableToolEntries } from "@hereisit/tool-registry/catalog";
import { expect, test } from "@playwright/test";
import { installPrivacyObserver } from "./support/privacy-observer";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const domains = [
  ["이미지", "/tools?domain=image"],
  ["PDF·문서", "/tools?domain=document"],
  ["영상·오디오", "/tools?domain=media"],
  ["데이터·변환", "/tools?domain=data"],
  ["텍스트·AI", "/tools?domain=text-ai"],
  ["웹·개발", "/tools?domain=web-dev"],
  ["생활·계산", "/tools?domain=everyday"],
] as const;

const homeTabs = [
  "전체·추천",
  "이미지",
  "PDF·문서",
  "영상·오디오",
  "데이터·변환",
  "텍스트·AI",
  "웹·개발",
  "생활·계산",
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hereisit.favorite-tools.v1", "[]");
    window.localStorage.setItem(
      "hereisit.recent-tools.v1",
      JSON.stringify([
        "pdf.watermark",
        "pdf.organize",
        "image.watermark",
        "pdf.split",
        "pdf.merge",
      ]),
    );
  });
});

test("restores the complete tools catalog state from a shareable URL", async ({ page }) => {
  await page.goto("/tools?q=png&domain=image&purpose=convert&planned=1");

  await expect(page.getByRole("heading", { level: 1, name: "모든 도구" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "도구 검색" })).toHaveValue("png");
  await expect(
    page
      .getByRole("tablist", { name: "도구 분야" })
      .getByRole("tab", { name: "이미지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("group", { name: "작업 목적" }).getByRole("button", { name: "변환" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "준비 중인 도구 포함" })).toBeChecked();
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hereisit.pages.dev/tools",
  );
});

test("uses replace for catalog typing and pushed history for explicit filters", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const trackedWindow = window as Window & {
      __hereisitHistoryCalls?: { push: number; replace: number };
    };
    trackedWindow.__hereisitHistoryCalls = { push: 0, replace: 0 };
    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);
    window.history.pushState = (...args) => {
      if (trackedWindow.__hereisitHistoryCalls) trackedWindow.__hereisitHistoryCalls.push += 1;
      return originalPushState(...args);
    };
    window.history.replaceState = (...args) => {
      if (trackedWindow.__hereisitHistoryCalls) trackedWindow.__hereisitHistoryCalls.replace += 1;
      return originalReplaceState(...args);
    };
  });
  await page.goto("/tools");
  await page.evaluate(() => {
    const trackedWindow = window as Window & {
      __hereisitHistoryCalls?: { push: number; replace: number };
    };
    trackedWindow.__hereisitHistoryCalls = { push: 0, replace: 0 };
  });

  const input = page.getByRole("combobox", { name: "도구 검색" });
  await input.fill("png");
  await expect(page).toHaveURL(/\/tools\?q=png$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hereisitHistoryCalls?: { push: number; replace: number };
            }
          ).__hereisitHistoryCalls,
      ),
    )
    .toMatchObject({ push: 0, replace: 1 });

  await page
    .getByRole("tablist", { name: "도구 분야" })
    .getByRole("tab", { name: "이미지", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tools\?q=png&domain=image$/);
  await page
    .getByRole("group", { name: "작업 목적" })
    .getByRole("button", { name: "변환" })
    .click();
  await expect(page).toHaveURL(/\/tools\?q=png&domain=image&purpose=convert$/);
  await page.getByRole("checkbox", { name: "준비 중인 도구 포함" }).click();
  await expect(page).toHaveURL(/\/tools\?q=png&domain=image&purpose=convert&planned=1$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hereisitHistoryCalls?: { push: number; replace: number };
            }
          ).__hereisitHistoryCalls?.push,
      ),
    )
    .toBe(3);

  await page.goBack();
  await expect(page.getByRole("checkbox", { name: "준비 중인 도구 포함" })).not.toBeChecked();
  await expect(input).toHaveValue("png");
  await page.goBack();
  await expect(
    page.getByRole("group", { name: "작업 목적" }).getByRole("button", { name: "전체" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("tablist", { name: "도구 분야" })
      .getByRole("tab", { name: "이미지", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await page.goForward();
  await expect(
    page.getByRole("group", { name: "작업 목적" }).getByRole("button", { name: "변환" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("png");
});

test("recovers invalid catalog values and resets an empty AND-filtered result", async ({
  page,
}) => {
  await page.goto("/tools?q=%20%EB%B3%91%ED%95%A9%20&domain=bogus&purpose=convert&planned=true");

  await expect(page.getByRole("combobox", { name: "도구 검색" })).toHaveValue("병합");
  await expect(
    page
      .getByRole("tablist", { name: "도구 분야" })
      .getByRole("tab", { name: "전체·추천", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("group", { name: "작업 목적" }).getByRole("button", { name: "변환" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: "준비 중인 도구 포함" })).not.toBeChecked();
  await expect(page.getByText("검색 결과 0개", { exact: true })).toBeVisible();
  await expect(page.getByTestId("available-tool-grid")).toHaveCount(0);

  await page.getByRole("button", { name: "모든 필터 초기화" }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole("combobox", { name: "도구 검색" })).toHaveValue("");
  await expect(page.getByTestId("available-tool-grid").locator("article")).toHaveCount(11);
  await expect(page.getByText("검색 결과 11개", { exact: true })).toBeVisible();
});

test("keeps planned catalog results in a separate inert region", async ({ page }) => {
  await page.goto("/tools?domain=media&purpose=optimize&planned=1");

  const availableRegion = page.getByRole("region", { name: "사용 가능한 도구" });
  const plannedRegion = page.getByRole("region", { name: "준비 중인 도구" });
  await expect(availableRegion.locator("article")).toHaveCount(0);
  await expect(plannedRegion).toBeVisible();
  await expect(plannedRegion.locator("article")).toHaveCount(1);
  await expect(plannedRegion.getByRole("heading", { name: "동영상 용량 줄이기" })).toBeVisible();
  await expect(plannedRegion.getByText("준비 중", { exact: true })).toBeVisible();
  await expect(plannedRegion.locator("a, button")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "준비 중인 도구 포함" }).click();
  await expect(page).toHaveURL(/\/tools\?domain=media&purpose=optimize$/);
  await expect(page.getByRole("region", { name: "준비 중인 도구" })).toHaveCount(0);
});

test("wraps catalog domain and purpose controls without horizontal overflow", async ({ page }) => {
  await page.goto("/tools");
  const tablist = page.getByRole("tablist", { name: "도구 분야" });

  const columnCount = () =>
    tablist.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
    );
  expect(await columnCount()).toBe(8);
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await columnCount()).toBe(4);
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toMatchObject({ clientWidth: 900, scrollWidth: 900 });
  await page.setViewportSize({ width: 340, height: 900 });
  expect(await columnCount()).toBe(2);
  expect(
    await page
      .getByRole("group", { name: "작업 목적" })
      .evaluate(
        (element) =>
          new Set(
            Array.from(element.children, (child) =>
              Math.round((child as HTMLElement).getBoundingClientRect().top),
            ),
          ).size,
      ),
  ).toBeGreaterThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(340);
});

test("shows newest-first personal tools and updates favorites with ID-only storage", async ({
  page,
}) => {
  await page.goto("/my-tools");

  await expect(page.getByRole("heading", { level: 1, name: "내 도구" })).toBeVisible();
  const recentRegion = page.getByRole("region", { name: "최근 사용한 도구" });
  await expect(recentRegion.locator("article")).toHaveCount(5);
  await expect(recentRegion.locator("article").first()).toContainText("PDF 워터마크 넣기");

  await recentRegion
    .locator("article")
    .first()
    .getByRole("button", { name: "즐겨찾기 추가" })
    .click();
  const favoriteRegion = page.getByRole("region", { name: "즐겨찾는 도구" });
  await expect(favoriteRegion.locator("article")).toHaveCount(1);
  await expect(favoriteRegion.locator("article").first()).toContainText("PDF 워터마크 넣기");

  const stored = await page.evaluate(() => ({
    favorites: JSON.parse(window.localStorage.getItem("hereisit.favorite-tools.v1") ?? "null"),
    recent: JSON.parse(window.localStorage.getItem("hereisit.recent-tools.v1") ?? "null"),
  }));
  expect(stored).toEqual({
    favorites: ["pdf.watermark"],
    recent: ["pdf.watermark", "pdf.organize", "image.watermark", "pdf.split", "pdf.merge"],
  });
  expect([...stored.favorites, ...stored.recent]).toHaveLength(6);
  expect([...stored.favorites, ...stored.recent].every((value) => typeof value === "string")).toBe(
    true,
  );

  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hereisit.pages.dev/my-tools",
  );
});

test("keeps an empty personal page useful when browser storage is denied", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    });
  });
  await page.goto("/my-tools");

  await expect(page.getByRole("status")).toContainText("이 탭에서만 목록을 기억해요");
  await expect(page.getByRole("status")).toContainText("도구 검색과 파일 처리는 그대로");
  await expect(page.getByRole("heading", { name: "아직 모아 둔 도구가 없어요." })).toBeVisible();
  const emptyState = page.getByRole("region", { name: "아직 모아 둔 도구가 없어요." });
  expect(await emptyState.getByRole("link").count()).toBeGreaterThan(1);
  await expect(emptyState.getByRole("link", { name: "모든 도구 보기" })).toHaveAttribute(
    "href",
    "/tools",
  );
  await expect(page.getByRole("button", { name: "검색", exact: true })).toBeVisible();

  await emptyState.getByRole("link", { name: "이미지 용량 줄이기" }).click();
  await expect(page).toHaveURL(/\/image\/compress\/?$/);
  await expect(page.getByRole("button", { name: "압축할 이미지 선택" })).toBeEnabled();
});

test("presents workflows as honest preparation-only examples", async ({ page }) => {
  await page.goto("/workflows");

  const content = page.getByRole("region", { name: "워크플로" });
  await expect(content.getByRole("heading", { level: 1, name: "워크플로" })).toBeVisible();
  await expect(content.getByText(/파일을 직접 내려받고 다음 도구에서 다시 선택/)).toBeVisible();
  await expect(content.getByText(/명시적인 로컬 연결.*앞으로 제공/)).toBeVisible();

  const examples = content.locator('[data-testid="workflow-example"]');
  expect(await examples.count()).toBeGreaterThan(1);
  const availableRoutes = new Set(availableToolEntries.map((tool) => tool.route));
  for (const example of await examples.all()) {
    await expect(example.getByText("준비 중", { exact: true })).toBeVisible();
    expect(await example.locator("a").count()).toBeGreaterThan(0);
    for (const link of await example.locator("a").all()) {
      expect(availableRoutes.has((await link.getAttribute("href")) ?? "")).toBe(true);
    }
    await expect(
      example.locator("button, form, input, select, textarea, [role=button]"),
    ).toHaveCount(0);
    await expect(example.locator("[disabled]")).toHaveCount(0);
  }
  await expect(content.getByText(/바로 실행|한 번에 완료|자동으로 처리/)).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://hereisit.pages.dev/workflows",
  );
});

test("publishes only the indexable discovery route in the sitemap", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBe(true);
  const sitemap = await response.text();
  expect(sitemap).toContain("<loc>https://hereisit.pages.dev/tools</loc>");
  expect(sitemap).not.toContain("/my-tools");
  expect(sitemap).not.toContain("/workflows");
  expect(sitemap).not.toContain("/media/video-compress");
});

test("shows a processor-free discovery home with search, file launch, and attached tabs", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("combobox", { name: "도구 검색" })).toBeVisible();
  await expect(page.getByRole("button", { name: "파일 선택" })).toBeVisible();
  await expect(page.getByRole("button", { name: /이미지 선택/ })).toHaveCount(0);

  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  await expect(tablist.getByRole("tab")).toHaveCount(homeTabs.length);
  for (const label of homeTabs) {
    await expect(tablist.getByRole("tab", { name: label, exact: true })).toBeVisible();
  }

  const selectedTab = tablist.getByRole("tab", { selected: true });
  await expect(selectedTab).toHaveCount(1);
  const panel = page.getByRole("tabpanel");
  await expect(panel).toBeAttached();
  await expect(panel).toHaveAttribute("aria-labelledby", await selectedTab.getAttribute("id"));
  expect(await panel.locator("article").count()).toBeLessThanOrEqual(12);
});

test("keeps domain tabs roving, attached, bounded, and responsive", async ({ page }) => {
  await page.goto("/");

  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  const tabs = tablist.getByRole("tab");
  const panel = page.getByRole("tabpanel");
  const allTab = tablist.getByRole("tab", { name: "전체·추천", exact: true });
  const lastTab = tablist.getByRole("tab", { name: "생활·계산", exact: true });

  await allTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(lastTab).toBeFocused();
  await expect(lastTab).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeAttached();

  await page.keyboard.press("ArrowRight");
  await expect(allTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(lastTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(allTab).toBeFocused();

  for (const key of ["ArrowUp", "ArrowDown"]) {
    await page.keyboard.press(key);
    await expect(allTab).toBeFocused();
    await expect(allTab).toHaveAttribute("aria-selected", "true");
  }
  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  const allCount = await panel.locator("article").count();
  await expect(panel.getByRole("heading", { name: "전체·추천 도구" })).toBeVisible();
  await expect(panel.getByText(`${allCount}개`, { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "전체·추천 모두 보기" })).toHaveAttribute(
    "href",
    "/tools",
  );

  await tablist.getByRole("tab", { name: "이미지", exact: true }).click();
  await expect(panel.getByRole("link", { name: "이미지 모두 보기" })).toHaveAttribute(
    "href",
    "/tools?domain=image",
  );

  await allTab.click();
  const uniqueRowsAt = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    return tabs.evaluateAll(
      (elements) =>
        new Set(elements.map((element) => Math.round(element.getBoundingClientRect().top))).size,
    );
  };
  expect(await uniqueRowsAt(1280)).toBe(1);
  expect(await uniqueRowsAt(900)).toBe(2);

  const cards = panel.locator("article");
  expect(await cards.count()).toBeGreaterThan(1);
  const firstCard = await cards.nth(0).boundingBox();
  const secondCard = await cards.nth(1).boundingBox();
  expect(Math.abs((firstCard?.y ?? 0) - (secondCard?.y ?? 0))).toBeLessThan(2);
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toMatchObject({ clientWidth: 900, scrollWidth: 900 });
});

test("detects mixed files incrementally without network or private-data side effects", async ({
  page,
}) => {
  const sentinelFilename = "PRIVATE_HOME_FILENAME_SENTINEL.png";
  const sentinelBytes = "PRIVATE_HOME_BYTES_SENTINEL";
  await page.addInitScript(() => {
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    const pendingReads: Array<() => void> = [];
    (
      window as Window & {
        __hereisitPendingPrefixReads?: () => number;
        __hereisitReleasePrefixRead?: () => void;
      }
    ).__hereisitPendingPrefixReads = () => pendingReads.length;
    (
      window as Window & {
        __hereisitPendingPrefixReads?: () => number;
        __hereisitReleasePrefixRead?: () => void;
      }
    ).__hereisitReleasePrefixRead = () => pendingReads.shift()?.();
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        pendingReads.push(() => {
          void Reflect.apply(originalArrayBuffer, this, []).then(resolve, reject);
        });
      });
    };
  });
  const privacy = await installPrivacyObserver(page, {
    sentinels: [sentinelFilename, sentinelBytes],
  });
  await page.goto("/");
  const launcher = page.locator('section[aria-labelledby="file-launcher-title"]');
  await page.waitForTimeout(250);
  const beforeSelection = await privacy.read();

  await page.locator("#home-file-input").setInputFiles([
    {
      name: sentinelFilename,
      mimeType: "image/png",
      buffer: Buffer.concat([onePixelPng, Buffer.from(sentinelBytes)]),
    },
    {
      name: "local-document.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n%%EOF"),
    },
  ]);

  await expect(launcher.getByRole("status")).toHaveText("0/2개 형식 확인 중");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hereisitPendingPrefixReads?: () => number;
            }
          ).__hereisitPendingPrefixReads?.() ?? 0,
      ),
    )
    .toBe(2);
  await page.evaluate(() => {
    (
      window as Window & {
        __hereisitReleasePrefixRead?: () => void;
      }
    ).__hereisitReleasePrefixRead?.();
  });
  await expect(launcher.getByRole("status")).toHaveText("1/2개 형식 확인 중");
  await page.evaluate(() => {
    (
      window as Window & {
        __hereisitReleasePrefixRead?: () => void;
      }
    ).__hereisitReleasePrefixRead?.();
  });

  await expect(launcher.getByRole("status")).toHaveText("2개 파일 형식 확인 완료");
  await expect(page.getByRole("heading", { name: "PNG 이미지" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PDF 문서" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.getByRole("button", { name: /도구 선택/ }).count()).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "다른 파일 선택" })).toBeVisible();
  await expect(page.getByRole("link", { name: "파일 없이 도구 찾기" })).toHaveAttribute(
    "href",
    "/tools",
  );

  const afterSelection = await privacy.read();
  expect(afterSelection.requestCount).toBe(beforeSelection.requestCount);
  expect(afterSelection.externalRequests).toEqual([]);
  expect(afterSelection.writeRequests).toEqual([]);
  for (const value of [
    ...afterSelection.consoleMessages,
    ...afterSelection.storageWrites,
    ...afterSelection.objectUrls,
    page.url(),
  ]) {
    expect(value).not.toContain(sentinelFilename);
    expect(value).not.toContain(sentinelBytes);
  }
  expect(afterSelection.objectUrls).toEqual([]);
  await expect(launcher.locator("img, canvas")).toHaveCount(0);
  await privacy.assertClean(0, false);
});

test("invalidates an older detection generation when the selection changes", async ({ page }) => {
  await page.addInitScript(() => {
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    const pendingReads: Array<() => void> = [];
    const trackedWindow = window as Window & {
      __hereisitPendingGenerationReads?: () => number;
      __hereisitReleaseGenerationRead?: () => void;
    };
    trackedWindow.__hereisitPendingGenerationReads = () => pendingReads.length;
    trackedWindow.__hereisitReleaseGenerationRead = () => pendingReads.shift()?.();
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        pendingReads.push(() => {
          void Reflect.apply(originalArrayBuffer, this, []).then(resolve, reject);
        });
      });
    };
  });
  await page.goto("/");
  const input = page.locator("#home-file-input");
  const pendingReadCount = () =>
    page.evaluate(
      () =>
        (
          window as Window & {
            __hereisitPendingGenerationReads?: () => number;
          }
        ).__hereisitPendingGenerationReads?.() ?? 0,
    );
  const releaseRead = () =>
    page.evaluate(() => {
      (
        window as Window & {
          __hereisitReleaseGenerationRead?: () => void;
        }
      ).__hereisitReleaseGenerationRead?.();
    });

  await input.setInputFiles({
    name: "stale.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n%%EOF"),
  });
  await expect.poll(pendingReadCount).toBe(1);

  await input.setInputFiles({
    name: "current.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await expect.poll(pendingReadCount).toBe(2);
  await releaseRead();
  await expect(
    page.locator('section[aria-labelledby="file-launcher-title"]').getByRole("status"),
  ).toHaveText("0/1개 형식 확인 중");
  await releaseRead();

  await expect(page.getByRole("heading", { name: "PNG 이미지" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PDF 문서" })).toHaveCount(0);
});

test("keeps an unknown-format correction beside the chooser", async ({ page }) => {
  await page.goto("/");
  const launcher = page.locator('section[aria-labelledby="file-launcher-title"]');
  await page.locator("#home-file-input").setInputFiles({
    name: "unknown.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
  });

  await expect(launcher.getByText(/지원하는 파일 형식을 찾지 못했어요/)).toBeVisible();
  await expect(launcher.getByText(/1개 파일의 형식은 확인하지 못했어요/)).toBeVisible();
  await expect(launcher.getByRole("button", { name: /도구 선택/ })).toHaveCount(0);
});

test("rejects 101 launcher files before reading any bytes", async ({ page }) => {
  await page.addInitScript(() => {
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    (window as Window & { __hereisitLauncherReads?: number }).__hereisitLauncherReads = 0;
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      const trackedWindow = window as Window & { __hereisitLauncherReads?: number };
      trackedWindow.__hereisitLauncherReads = (trackedWindow.__hereisitLauncherReads ?? 0) + 1;
      return Reflect.apply(originalArrayBuffer, this, []);
    };
  });
  const privacy = await installPrivacyObserver(page);
  await page.goto("/");
  await page.waitForTimeout(250);
  const beforeSelection = await privacy.read();

  await page.locator("#home-file-input").setInputFiles(
    Array.from({ length: 101 }, (_, index) => ({
      name: `bounded-${index}.png`,
      mimeType: "image/png",
      buffer: onePixelPng,
    })),
  );

  const launcher = page.locator('section[aria-labelledby="file-launcher-title"]');
  await expect(launcher.getByRole("status")).toContainText("최대 100개");
  await expect(launcher.locator("p:not([role])").filter({ hasText: "최대 100개" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __hereisitLauncherReads?: number }).__hereisitLauncherReads,
    ),
  ).toBe(0);
  expect((await privacy.read()).requestCount).toBe(beforeSelection.requestCount);
  await expect(launcher.getByRole("button", { name: /도구 선택/ })).toHaveCount(0);
  await privacy.assertClean(0, false);
});

test("keeps ready and needs-more recommendations actionable while disabling too-many", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.locator("#home-file-input");
  const pdfFixture = (name: string) => ({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n%%EOF"),
  });

  await input.setInputFiles(pdfFixture("one.pdf"));
  const merge = page.getByRole("button", { name: "PDF 합치기 도구 선택" });
  const split = page.getByRole("button", { name: "PDF 페이지 분할 도구 선택" });
  await expect(merge).toBeEnabled();
  await expect(merge.locator("..")).toContainText("1개 파일을 더 선택");
  await expect(split).toBeEnabled();
  await expect(page).toHaveURL(/\/$/);

  await input.setInputFiles([pdfFixture("first.pdf"), pdfFixture("second.pdf")]);
  await expect(merge).toBeEnabled();
  await expect(split).toBeDisabled();
  await expect(split.locator("..")).toContainText("최대 1개");
  await expect(page).toHaveURL(/\/$/);
});

test("hands a chosen file to the canonical destination without auto-processing", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#home-file-input").setInputFiles({
    name: "handoff.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });

  await page.getByRole("button", { name: "이미지 용량 줄이기 도구 선택" }).click();
  await expect(page).toHaveURL(/\/image\/compress\/?$/);
  await expect(page.getByText("handoff.png", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1개 이미지 용량 줄이기 →" })).toBeEnabled();
  await expect(page.getByText(/이미지 변환을 완료했어요/)).toHaveCount(0);
});

test("hands a needs-more recommendation through destination validation", async ({ page }) => {
  await page.goto("/");
  await page.locator("#home-file-input").setInputFiles({
    name: "needs-another.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n%%EOF"),
  });

  await page.getByRole("button", { name: "PDF 합치기 도구 선택" }).click();
  await expect(page).toHaveURL(/\/pdf\/merge\/?$/);
  await expect(page.getByText("needs-another.pdf", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1개 PDF 합치기 →" })).toBeDisabled();
});

test("exposes the desktop destinations and a bounded navigation disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "HereIsIt 홈" })).toBeVisible();
  const allTools = page.getByRole("button", { name: "모든 도구", exact: true });
  await expect(allTools).toBeVisible();
  await expect(page.getByRole("link", { name: "워크플로", exact: true })).toBeVisible();
  await expect(page.getByText("준비 중", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "내 도구", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "검색", exact: true })).toBeVisible();
  await expect(allTools).toHaveAttribute("aria-expanded", "false");

  await allTools.click();
  await expect(allTools).toHaveAttribute("aria-expanded", "true");
  await expect(allTools).toBeFocused();

  const mega = page.getByTestId("desktop-mega");
  await expect(mega).toBeVisible();
  await expect(mega).not.toHaveAttribute("role", "menu");
  for (const [label, href] of domains) {
    await expect(mega.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "href",
      href,
    );
  }
  await expect(mega.getByRole("link", { name: "모든 도구 보기", exact: true })).toHaveAttribute(
    "href",
    "/tools",
  );
  await expect(mega.getByRole("link", { name: "워크플로 보기", exact: true })).toHaveAttribute(
    "href",
    "/workflows",
  );

  const featuredLinks = mega.locator('[data-tool-section="featured"] [data-tool-link]');
  const recentLinks = mega.locator('[data-tool-section="recent"] [data-tool-link]');
  expect(await featuredLinks.count()).toBeGreaterThan(0);
  expect(await featuredLinks.count()).toBeLessThanOrEqual(4);
  expect(await recentLinks.count()).toBe(4);

  await page.keyboard.press("Tab");
  await expect(mega.getByRole("link", { name: domains[0][0], exact: true })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(mega).toBeHidden();
  await expect(allTools).toHaveAttribute("aria-expanded", "false");
  await expect(allTools).toBeFocused();

  await allTools.click();
  await expect(mega).toBeVisible();
  await page
    .getByRole("heading", { name: "파일 작업, 여기서 끝." })
    .dispatchEvent("pointerdown", { pointerType: "mouse" });
  await expect(mega).toBeHidden();
  await expect(allTools).toBeFocused();
});

test("searches only local catalog metadata with bounded keyboard suggestions", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "검색", exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const search = page.getByTestId("desktop-search");
  const input = search.getByRole("combobox", { name: "도구 검색" });
  await expect(input).toBeFocused();
  await expect(search.getByRole("listbox")).toHaveCount(0);

  await input.fill("PDF");
  await page.waitForTimeout(100);
  await input.fill("PDF ");
  await expect(input).toHaveValue("PDF ");
  await page.waitForTimeout(100);
  expect(await search.getByRole("status").textContent()).toBe("");
  await page.waitForTimeout(100);

  const listbox = search.getByRole("listbox", { name: "도구 검색 결과" });
  await expect(listbox).toBeVisible();
  expect(await listbox.getByRole("option").count()).toBeLessThanOrEqual(5);
  await expect(search.getByRole("status")).toContainText(/검색 결과 \d+개/);

  await input.fill("  ");
  await expect(search.getByRole("listbox")).toHaveCount(0);

  await input.fill("병합");
  await page.keyboard.press("ArrowDown");
  const activeOptionId = await input.getAttribute("aria-activedescendant");
  expect(activeOptionId).toBeTruthy();
  await expect(page.locator(`#${activeOptionId}`)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pdf\/merge\/?$/);
});

test("replaces an open desktop overlay and returns search focus on Escape", async ({ page }) => {
  await page.goto("/");

  const allTools = page.getByRole("button", { name: "모든 도구", exact: true });
  const searchTrigger = page.getByRole("button", { name: "검색", exact: true });
  await allTools.click();
  await expect(page.getByTestId("desktop-mega")).toBeVisible();

  await searchTrigger.click();
  await expect(page.getByTestId("desktop-mega")).toBeHidden();
  await expect(page.getByTestId("desktop-search")).toBeVisible();
  await expect(searchTrigger).toHaveAttribute("aria-expanded", "true");

  await allTools.click();
  await expect(page.getByTestId("desktop-search")).toBeHidden();
  await expect(page.getByTestId("desktop-mega")).toBeVisible();
  await expect(allTools).toBeFocused();

  await searchTrigger.click();
  await expect(page.getByTestId("desktop-mega")).toBeHidden();
  await expect(page.getByTestId("desktop-search")).toBeVisible();
  await page
    .getByTestId("desktop-search")
    .getByRole("combobox", { name: "도구 검색" })
    .fill("이미지");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("desktop-search")).toBeHidden();
  await expect(searchTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(searchTrigger).toBeFocused();
});
