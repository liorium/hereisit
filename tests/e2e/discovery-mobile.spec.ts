import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hereisit.favorite-tools.v1", "[]");
    window.localStorage.setItem(
      "hereisit.recent-tools.v1",
      JSON.stringify(["pdf.watermark", "pdf.organize", "image.watermark", "pdf.split"]),
    );
  });
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
