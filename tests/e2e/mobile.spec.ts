import { expect, test } from "@playwright/test";

test("keeps the primary upload flow inside an iPhone viewport", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "이미지 작업, 여기서 끝." })).toBeVisible();
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
