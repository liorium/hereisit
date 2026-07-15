import { expect, test } from "@playwright/test";
import { expectCardTextClearOfFavorite, expectKoreanTextLayout } from "./support/korean-typography";

const prettyKorean = { textWrap: "pretty" } as const;

test.describe("typography helper geometry regressions", () => {
  test("rejects hidden typography targets", async ({ page }) => {
    await page.setContent(`
      <style>
        #target {
          display: none;
          overflow-wrap: break-word;
          text-wrap: pretty;
          word-break: keep-all;
        }
      </style>
      <p id="target">숨겨진 문장입니다.</p>
    `);

    await expect(expectKoreanTextLayout(page.locator("#target"), prettyKorean)).rejects.toThrow();
  });

  test("rejects visible targets without rendered text", async ({ page }) => {
    await page.setContent(`
      <style>
        #target {
          width: 200px;
          height: 24px;
          overflow-wrap: break-word;
          text-wrap: pretty;
          word-break: keep-all;
        }

        #target span {
          display: none;
        }
      </style>
      <p id="target"><span>렌더링되지 않는 문장입니다.</span></p>
    `);

    await expect(expectKoreanTextLayout(page.locator("#target"), prettyKorean)).rejects.toThrow();
  });

  test("ignores line-clamped text rectangles outside visible bounds", async ({ page }) => {
    await page.setContent(`
      <style>
        article {
          position: relative;
          width: 240px;
          min-height: 140px;
          font: 16px / 20px Arial, sans-serif;
        }

        a {
          display: block;
          width: 100%;
          color: black;
          text-decoration: none;
        }

        a span {
          display: block;
          width: 220px;
        }

        a span:nth-child(2) {
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          word-break: break-all;
        }

        button {
          position: absolute;
          z-index: 2;
          top: 70px;
          right: 0;
          width: 44px;
          height: 44px;
          padding: 0;
        }
      </style>
      <article>
        <a href="#target">
          <span>도구 이름</span>
          <span>가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차카타파하</span>
        </a>
        <button type="button">즐겨찾기</button>
      </article>
    `);

    await expectCardTextClearOfFavorite(page.locator("article"), {
      absoluteFavorite: true,
      clamped: true,
    });
  });

  test("allows emergency wrapping for a word wider than its styled content box", async ({
    page,
  }) => {
    await page.setContent(`
      <div
        id="target"
        style="width: 80px; padding: 0 80px; font: 10px / 12px Arial, sans-serif; overflow-wrap: break-word; text-wrap: pretty; word-break: keep-all;"
      >
        <span style="display: block; width: 80px; font: 32px / 34px Arial, sans-serif;">가나다라마바사아자차카타파하</span>
      </div>
    `);

    await expectKoreanTextLayout(page.locator("#target"), prettyKorean);
  });

  test("detects a fitting Korean word split across styled text nodes", async ({ page }) => {
    await page.setContent(`
      <div
        id="target"
        style="width: 180px; font: 64px / 64px Arial, sans-serif; overflow-wrap: break-word; text-wrap: pretty; word-break: keep-all;"
      >
        <span style="display: block; width: 180px; font: 16px / 20px Arial, sans-serif;">반갑</span><span style="display: block; width: 180px; font: 16px / 20px Arial, sans-serif;">습니다</span>
      </div>
    `);

    await expect(expectKoreanTextLayout(page.locator("#target"), prettyKorean)).rejects.toThrow(
      /반갑습니다/u,
    );
  });
});
