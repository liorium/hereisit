import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  expectKoreanTextLayout,
  expectNoDocumentOverflow,
  expectUnbrokenPhrase,
  seedToolPreferences,
} from "./support/korean-typography";

const primaryWidths = [
  320, 360, 390, 430, 600, 601, 800, 801, 900, 901, 1024, 1040, 1041, 1280, 1440,
] as const;
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

test("keeps home Korean copy on word boundaries across responsive widths", async ({ page }) => {
  await seedToolPreferences(page);
  await page.goto("/");

  for (const width of primaryWidths) {
    await page.setViewportSize({ width, height: 1000 });
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
