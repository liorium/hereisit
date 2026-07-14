import { expect, test } from "@playwright/test";

const domains = [
  ["이미지", "/tools?domain=image"],
  ["PDF·문서", "/tools?domain=document"],
  ["영상·오디오", "/tools?domain=media"],
  ["데이터·변환", "/tools?domain=data"],
  ["텍스트·AI", "/tools?domain=text-ai"],
  ["웹·개발", "/tools?domain=web-dev"],
  ["생활·계산", "/tools?domain=everyday"],
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
  await page.locator(".hero-section").dispatchEvent("pointerdown", { pointerType: "mouse" });
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
  await page.getByRole("combobox", { name: "도구 검색" }).fill("이미지");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("desktop-search")).toBeHidden();
  await expect(searchTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(searchTrigger).toBeFocused();
});
