import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  expectCardTextClearOfFavorite,
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

test("keeps catalog and planned-card Korean copy readable across responsive widths", async ({
  page,
}) => {
  await seedToolPreferences(page);
  await page.goto("/tools?planned=1");

  for (const width of primaryWidths) {
    await page.setViewportSize({ width, height: 1000 });
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
    await expect(page.getByRole("checkbox", { name: "준비 중인 도구 포함" })).toBeChecked();
    await expect(page.getByTestId("planned-tool-grid").locator("a, button")).toHaveCount(0);
    await expectNoDocumentOverflow(page);
  }
});

test("preserves shared-card text space and the 600/800 pixel boundaries", async ({ page }) => {
  await seedToolPreferences(page);
  await page.goto("/tools");
  const card = page
    .getByTestId("available-tool-grid")
    .locator("article")
    .filter({ hasText: "이미지 용량 줄이기" });
  const link = card.locator(":scope > a");
  const favorite = card.locator(":scope > button");

  for (const width of [600, 601, 768, 800, 801, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectKoreanTextLayout(link.locator("span").nth(0), {
      forbiddenLastLines,
      textWrap: "balance",
    });
    await expectKoreanTextLayout(link.locator("span").nth(1), {
      forbiddenLastLines,
      textWrap: "pretty",
    });
    await expectCardTextClearOfFavorite(card, {
      absoluteFavorite: width <= 800,
      clamped: width <= 600,
    });
    await link.focus();
    await page.keyboard.press("Tab");
    await expect(favorite).toBeFocused();
    await expect(favorite).toHaveAccessibleName("이미지 용량 줄이기 즐겨찾기 추가");
    await expect(favorite).toHaveAttribute("aria-pressed", "false");
    await expectNoDocumentOverflow(page);
  }
});

test("keeps every shared-card surface readable without changing behavior", async ({ page }) => {
  await seedToolPreferences(page, ["image.compress"], ["pdf.watermark"]);
  const surfaces = [
    { path: "/", card: () => page.getByTestId("home-tool-grid").locator("article").first() },
    {
      path: "/tools",
      card: () => page.getByTestId("available-tool-grid").locator("article").first(),
    },
    {
      path: "/my-tools",
      card: () => page.getByRole("region", { name: "즐겨찾는 도구" }).locator("article").first(),
    },
    {
      path: "/image/compress",
      card: () => page.getByRole("region", { name: "다음 작업" }).locator("article").first(),
    },
  ] as const;

  for (const width of [320, 390, 800, 801, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const surface of surfaces) {
      await page.goto(surface.path);
      const card = surface.card();
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
        absoluteFavorite: width <= 800,
        clamped: width <= 600,
      });
      await expectNoDocumentOverflow(page);
    }
  }
});
