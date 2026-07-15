import { expect, type Locator, type Page, test } from "@playwright/test";

async function pressTabUntilFocused(page: Page, target: Locator, maximumTabs = 16): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach the requested control within ${maximumTabs} tabs`);
}

async function expectOneLocalRow(container: Locator): Promise<void> {
  const metrics = await container.evaluate((element) => ({
    clientWidth: element.clientWidth,
    rows: new Set(
      Array.from(element.children)
        .filter((child) => {
          const style = getComputedStyle(child);
          return style.display !== "none" && style.position !== "absolute";
        })
        .map((child) => Math.round((child as HTMLElement).getBoundingClientRect().top)),
    ).size,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.rows).toBe(1);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toEqual(
    expect.objectContaining({
      clientWidth: expect.any(Number),
      scrollWidth: expect.any(Number),
    }),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    (await page.evaluate(() => document.documentElement.clientWidth)) + 1,
  );
}

async function expectFullyInsideViewport(locator: Locator, viewportHeight: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? viewportHeight + 1)).toBeLessThanOrEqual(viewportHeight);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hereisit.favorite-tools.v1", "[]");
    window.localStorage.setItem("hereisit.recent-tools.v1", "[]");
  });
});

test("shows the home file selector in the initial 320 by 568 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const select = page.getByRole("button", { name: "파일 선택", exact: true });
  await expect(select).toBeVisible();
  await expectFullyInsideViewport(select, 568);
  const box = await select.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(
    page.getByRole("status").filter({ hasText: "기기 안에서 형식만 확인" }),
  ).toContainText("기기 안에서 형식만 확인");
  await expectNoDocumentOverflow(page);
});

test("shows a one-row catalog filter surface and the first result at 390 by 844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const purposes = page.getByRole("group", { name: "작업 목적" });
  await expectOneLocalRow(purposes);
  const firstLink = page.getByTestId("available-tool-grid").locator("article > a").first();
  await expectFullyInsideViewport(firstLink, 844);
  expect(
    await page
      .getByRole("combobox", { name: "도구 검색" })
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);

  await purposes.getByRole("button", { name: "변환", exact: true }).click();
  await expect(page).toHaveURL(/purpose=convert/);
  await expect(purposes.getByRole("button", { name: "변환", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectNoDocumentOverflow(page);
});

test("uses compact one-column cards through 600 pixels and restores tablet columns at 601", async ({
  page,
}) => {
  await page.goto("/tools");
  const grid = page.getByTestId("available-tool-grid");
  const compress = grid.locator("article").filter({ hasText: "이미지 용량 줄이기" });

  for (const width of [320, 360, 390, 430, 600]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await grid.evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
      ),
    ).toHaveLength(1);
    await expectNoDocumentOverflow(page);
  }

  const link = compress.locator(":scope > a");
  const favorite = compress.locator(":scope > button");
  await expect(link).toHaveCount(1);
  await expect(favorite).toHaveCount(1);
  await expect(favorite).toHaveAccessibleName("이미지 용량 줄이기 즐겨찾기 추가");
  await favorite.scrollIntoViewIfNeeded();
  const favoriteBox = await favorite.boundingBox();
  expect(favoriteBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(favoriteBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(
    await favorite.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    }),
  ).toBe(true);

  const description = compress.locator("a > span").nth(1);
  const clamp = await description.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
      overflow: style.overflow,
      webkitLineClamp: style.webkitLineClamp,
    };
  });
  expect(clamp.webkitLineClamp).toBe("2");
  expect(clamp.overflow).toBe("hidden");
  expect(clamp.clientHeight).toBeLessThanOrEqual(clamp.lineHeight * 2 + 1);

  await link.focus();
  await page.keyboard.press("Tab");
  await expect(favorite).toBeFocused();

  await page.setViewportSize({ width: 601, height: 844 });
  expect(
    await grid.evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
    ),
  ).toHaveLength(2);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 600, height: 844 });
  await page.goto("/");
  expect(
    await page
      .getByTestId("home-tool-grid")
      .evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
      ),
  ).toHaveLength(1);
  await page.goto("/image/compress");
  expect(
    await page
      .getByRole("region", { name: "다음 작업" })
      .locator("article")
      .first()
      .locator("..")
      .evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
      ),
  ).toHaveLength(1);
});

test("keeps home domain tabs in one local row and reveals keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(8);
  await expectOneLocalRow(tablist);
  expect(
    await tablist.evaluate((element) => element.nextElementSibling?.getAttribute("role")),
  ).toBe("tabpanel");

  await tablist.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "start" }),
  );
  await tabs.first().evaluate((element) => element.focus({ preventScroll: true }));
  const beforeY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  const bounds = await tablist.evaluate((element) => {
    const list = element.getBoundingClientRect();
    const selected = element.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
    return selected === undefined
      ? null
      : { left: selected.left, right: selected.right, listLeft: list.left, listRight: list.right };
  });
  expect(bounds).not.toBeNull();
  expect(bounds?.left ?? 0).toBeGreaterThanOrEqual((bounds?.listLeft ?? 0) - 1);
  expect(bounds?.right ?? 0).toBeLessThanOrEqual((bounds?.listRight ?? 0) + 1);
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(beforeY, 0);
  await expectNoDocumentOverflow(page);
});

test("keeps catalog domain tabs in one local row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools");
  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  await expectOneLocalRow(tablist);
  expect(
    await tablist.evaluate((element) => element.nextElementSibling?.getAttribute("role")),
  ).toBe("tabpanel");
  await expectNoDocumentOverflow(page);
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
