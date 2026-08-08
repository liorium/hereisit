import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  expectCardTextClearOfFavorite,
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

test("keeps shared-card text clear of favorite controls in mobile browser engines", async ({
  page,
}) => {
  await seedToolPreferences(page, ["image.compress"], ["pdf.watermark"]);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/tools", "/my-tools", "/image/compress"] as const) {
      await page.goto(path);
      const card =
        path === "/tools"
          ? page.getByTestId("available-tool-grid").locator("article").first()
          : path === "/my-tools"
            ? page.getByRole("region", { name: "즐겨찾는 도구" }).locator("article").first()
            : page.getByRole("region", { name: "다음 작업" }).locator("article").first();
      await expect(card).toBeVisible();
      await expectKoreanTextLayout(card.locator(":scope > a > span").nth(0), {
        forbiddenLastLines,
        textWrap: "balance",
      });
      await expectKoreanTextLayout(card.locator(":scope > a > span").nth(1), {
        forbiddenLastLines,
        textWrap: "pretty",
      });
      await expectCardTextClearOfFavorite(card, {
        absoluteFavorite: true,
        clamped: true,
      });
      await expectNoDocumentOverflow(page);
    }
  }
});

test("keeps tool-detail Korean titles intact on narrow screens", async ({ page }) => {
  await seedToolPreferences(page);
  await page.goto("/pdf/to-image");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectKoreanTextLayout(
      page.getByRole("heading", { level: 1, name: "PDF를 JPG·PNG로 변환" }),
      { forbiddenLastLines: ["환"], textWrap: "balance" },
    );
    await expectNoDocumentOverflow(page);
  }
});
