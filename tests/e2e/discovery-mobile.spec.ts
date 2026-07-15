import { expect, type Locator, type Page, test } from "@playwright/test";

async function pressTabUntilFocused(page: Page, target: Locator, maximumTabs = 16): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach the requested control within ${maximumTabs} tabs`);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hereisit.favorite-tools.v1", "[]");
    window.localStorage.setItem(
      "hereisit.recent-tools.v1",
      JSON.stringify(["pdf.watermark", "pdf.organize", "image.watermark", "pdf.split"]),
    );
  });
});

test("keeps catalog filters and two-column cards inside the mobile viewport", async ({ page }) => {
  await page.goto("/tools?planned=1");

  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  await expect(tablist.getByRole("tab")).toHaveCount(8);
  expect(
    await tablist.evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
    ),
  ).toHaveLength(2);

  const cards = page.getByTestId("available-tool-grid").locator("article");
  expect(await cards.count()).toBeGreaterThan(1);
  const firstCard = await cards.nth(0).boundingBox();
  const secondCard = await cards.nth(1).boundingBox();
  expect(Math.abs((firstCard?.y ?? 0) - (secondCard?.y ?? 0))).toBeLessThan(2);
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toMatchObject({ clientWidth: 393, scrollWidth: 393 });

  await page.setViewportSize({ width: 340, height: 844 });
  const narrowFirst = await cards.nth(0).boundingBox();
  const narrowSecond = await cards.nth(1).boundingBox();
  expect((narrowSecond?.y ?? 0) - (narrowFirst?.y ?? 0)).toBeGreaterThan(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(340);
});

test("keeps the home launcher, two-column tabs, and cards inside the mobile viewport", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "파일 선택" })).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "도구 분야" }).getByRole("tab");
  await expect(tabs).toHaveCount(8);
  const columns = await page
    .getByRole("tablist", { name: "도구 분야" })
    .evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
    );
  expect(columns).toHaveLength(2);
  expect(
    await tabs.evaluateAll(
      (elements) =>
        new Set(elements.map((element) => Math.round(element.getBoundingClientRect().top))).size,
    ),
  ).toBe(4);

  const panel = page.getByRole("tabpanel");
  await expect(panel).toBeAttached();
  const cards = panel.locator("article");
  expect(await cards.count()).toBeGreaterThan(1);
  const firstCard = await cards.nth(0).boundingBox();
  const secondCard = await cards.nth(1).boundingBox();
  expect(Math.abs((firstCard?.y ?? 0) - (secondCard?.y ?? 0))).toBeLessThan(2);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("opens one modal mobile drawer with trapped focus and inert background", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "메뉴 열기", exact: true });
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const drawer = page.getByRole("dialog", { name: "전체 메뉴" });
  const close = drawer.getByRole("button", { name: "메뉴 닫기", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveJSProperty("open", true);
  await expect(close).toBeFocused();

  const domainGrid = drawer.getByTestId("mobile-domain-grid");
  await expect(domainGrid.getByRole("link")).toHaveCount(7);
  const columns = await domainGrid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
  );
  expect(columns).toHaveLength(2);

  const backgroundState = await page.evaluate(() => ({
    inert: (document.querySelector("main > section") as HTMLElement | null)?.inert ?? false,
    overflow: document.body.style.overflow,
  }));
  expect(backgroundState.inert).toBe(true);
  expect(backgroundState.overflow).toBe("hidden");

  await page.keyboard.press("Shift+Tab");
  expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press("Tab");
    expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(() => ({
      inert: (document.querySelector("main > section") as HTMLElement | null)?.inert ?? false,
      overflow: document.body.style.overflow,
    })),
  ).toEqual({ inert: false, overflow: "" });
});

test("closes the drawer control and restores its single mobile trigger", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "메뉴 열기", exact: true });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "전체 메뉴" });
  await expect(drawer.getByRole("link", { name: "홈", exact: true })).toHaveAttribute("href", "/");
  await expect(drawer.getByRole("link", { name: "모든 도구", exact: true })).toHaveAttribute(
    "href",
    "/tools",
  );
  await expect(drawer.getByRole("link", { name: "워크플로", exact: true })).toHaveAttribute(
    "href",
    "/workflows",
  );
  await expect(drawer.getByRole("link", { name: "내 도구", exact: true })).toHaveAttribute(
    "href",
    "/my-tools",
  );
  expect(await drawer.locator('[data-tool-section="recent"] [data-tool-link]').count()).toBe(4);

  await drawer.getByRole("button", { name: "메뉴 닫기", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator("dialog")).toHaveCount(1);
});

test("supports touch selection from local drawer search", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).tap();

  const drawer = page.getByRole("dialog", { name: "전체 메뉴" });
  const input = drawer.getByRole("combobox", { name: "도구 검색" });
  await input.fill("워터마크");
  const option = drawer.getByRole("option", { name: /이미지에 워터마크 넣기/ });
  await expect(option).toBeVisible();
  await option.tap();
  await expect(page).toHaveURL(/\/image\/watermark\/?$/);
});

test("supports a keyboard-only mobile menu with exact focus return", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "메뉴 열기", exact: true });
  await pressTabUntilFocused(page, trigger);
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "전체 메뉴" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "메뉴 닫기", exact: true })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keeps enlarged mobile text readable without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  const fileSelect = page.getByRole("button", { name: "파일 선택" });
  await expect(fileSelect).toBeVisible();
  await expect(page.getByRole("tablist", { name: "도구 분야" })).toBeVisible();
  const baselineFontSize = await fileSelect.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const enlargedElementCount = await page.evaluate(() => {
    const renderedTextElements = Array.from(document.body.querySelectorAll("*"))
      .filter((element) =>
        Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        ),
      )
      .map((element) => ({
        element,
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        style: getComputedStyle(element),
      }))
      .filter(
        ({ fontSize, style }) =>
          Number.isFinite(fontSize) &&
          fontSize > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden",
      );

    for (const { element, fontSize } of renderedTextElements) {
      if (element instanceof HTMLElement) {
        element.style.setProperty("font-size", `${fontSize * 2}px`, "important");
      }
    }
    return renderedTextElements.length;
  });

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  const enlargedFontSize = await fileSelect.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(enlargedElementCount).toBeGreaterThan(0);
  expect(enlargedFontSize).toBeCloseTo(baselineFontSize * 2, 5);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});
