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
