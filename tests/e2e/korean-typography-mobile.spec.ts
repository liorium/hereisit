import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  expectKoreanTextLayout,
  expectNoDocumentOverflow,
  expectUnbrokenPhrase,
  seedToolPreferences,
} from "./support/korean-typography";

const forbiddenLastLines = ["끝.", "요.", "다."] as const;

function homeTypography(page: Page): Array<[Locator, "balance" | "pretty"]> {
  return [
    [page.locator("#home-title"), "balance"],
    [page.locator("#home-title + p"), "pretty"],
    [page.locator("#file-launcher-title"), "balance"],
    [page.locator("#file-launcher-title + p"), "pretty"],
    [page.locator("#home-tools-title"), "balance"],
    [page.locator("#home-domain-panel h3"), "balance"],
    [page.locator("#home-domain-panel h3 + p"), "pretty"],
  ];
}

test("keeps home Korean copy readable in mobile browser engines", async ({ page }) => {
  await seedToolPreferences(page);
  await page.goto("/");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [locator, textWrap] of homeTypography(page)) {
      await expectKoreanTextLayout(locator, { forbiddenLastLines, textWrap });
    }
    const heading = page.getByRole("heading", {
      exact: true,
      level: 1,
      name: "파일 작업, 여기서 끝.",
    });
    await expect(heading).toBeVisible();
    await expectUnbrokenPhrase(heading.locator("span"), "여기서 끝.");
    await expectNoDocumentOverflow(page);
  }
});

test("keeps catalog and planned-card Korean copy readable in mobile browser engines", async ({
  page,
}) => {
  await seedToolPreferences(page);
  await page.goto("/tools?planned=1");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const samples: Array<[Locator, "balance" | "pretty"]> = [
      [page.locator("#tools-title"), "balance"],
      [page.locator("#tools-title + p"), "pretty"],
      [page.locator("#catalog-domain-panel h2").first(), "balance"],
      [page.locator("#catalog-domain-panel h2 + p").first(), "pretty"],
      [page.locator("#available-tools-title"), "balance"],
      [page.locator("#planned-tools-title"), "balance"],
      [page.getByTestId("planned-tool-grid").locator("article h3").first(), "balance"],
      [page.getByTestId("planned-tool-grid").locator("article p").first(), "pretty"],
    ];
    for (const [locator, textWrap] of samples) {
      await expectKoreanTextLayout(locator, { forbiddenLastLines, textWrap });
    }
    await expect(page.getByTestId("planned-tool-grid").locator("a, button")).toHaveCount(0);
    await expectNoDocumentOverflow(page);
  }
});
