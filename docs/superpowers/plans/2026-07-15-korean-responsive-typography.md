# Responsive Korean Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Korean headings, descriptions, planned cards, and shared tool cards wrap naturally from 320px mobile screens through 1440px desktops without changing product meaning or behavior.

**Architecture:** Apply language-aware wrapping only inside the five affected CSS modules, with one semantic inline phrase in the home heading. Add a focused Playwright geometry helper that flattens nested text nodes, segments Korean words, ignores clipped line-clamp content, and verifies real browser layout across desktop and mobile projects.

**Tech Stack:** Next.js 16, React 19, CSS Modules, TypeScript 6, Playwright 1.61, pnpm 11, Cloudflare Pages Git integration.

## Global Constraints

- Preserve local browser processing; this work must not upload, persist, inspect, or log user files.
- Preserve all current visible Korean copy, accessible names, routes, catalog state, favorites, recent tools, and processing contracts.
- Do not add dependencies, fonts, global typography rules, fixed `<br>` elements, non-breaking-space characters, or duplicated accessibility copy.
- Limit product changes to `/`, `/tools`, shared `ToolCard` presentation, and the regression-only `/my-tools` and related-tool surfaces.
- Use `word-break: keep-all` plus `overflow-wrap: break-word`; use `text-wrap: balance` for headings and `text-wrap: pretty` for descriptions.
- Keep `여기서 끝.` together with one inline `white-space: nowrap` exception whose width must fit its parent at 320px.
- At widths up to 800px, move only shared-card layout and favorite-button positioning; keep font sizes, compact spacing, and two-line clamps limited to widths up to 600px.
- Preserve 44px favorite-button targets, link-then-button keyboard order, `aria-pressed`, accessible favorite names, and inert planned cards.
- Required primary widths are 320, 360, 390, 430, 600, 601, 800, 801, 900, 901, 1024, 1040, 1041, 1280, and 1440px.
- Do not assert exact full line strings, total line counts, or screenshot pixels across engines; assert semantic phrases, unbroken fitting words, visible geometry, and overflow with a 1px line-position tolerance.

## File Map

- Create `tests/e2e/support/korean-typography.ts`: shared Range, Segmenter, overflow, phrase, and card-geometry assertions.
- Create `tests/e2e/korean-typography.spec.ts`: full responsive-width coverage in Chromium, Firefox, and CI WebKit.
- Create `tests/e2e/korean-typography-mobile.spec.ts`: 320px and 390px coverage in mobile Chromium, mobile Firefox, and CI mobile WebKit.
- Modify `apps/web/src/components/home-discovery.tsx`: wrap only `여기서 끝.` in a semantic inline span.
- Modify `apps/web/src/components/home-discovery.module.css`: home hero heading, lead, and kept phrase.
- Modify `apps/web/src/components/home-file-launcher.module.css`: file-launcher heading and lead.
- Modify `apps/web/src/components/domain-tool-tabs.module.css`: discovery heading, panel heading, and panel description.
- Modify `apps/web/src/components/tool-catalog-browser.module.css`: catalog, result, planned-card, fallback, and empty-state typography.
- Modify `apps/web/src/components/tool-card.module.css`: shared card text wrapping and the isolated 600/800px layout boundary.

---

### Task 1: Browser Geometry Helper and Home Typography

**Files:**
- Create: `tests/e2e/support/korean-typography.ts`
- Create: `tests/e2e/korean-typography.spec.ts`
- Create: `tests/e2e/korean-typography-mobile.spec.ts`
- Modify: `apps/web/src/components/home-discovery.tsx:17-22`
- Modify: `apps/web/src/components/home-discovery.module.css:11-25`
- Modify: `apps/web/src/components/home-file-launcher.module.css:12-23`
- Modify: `apps/web/src/components/domain-tool-tabs.module.css:11-17,72-82`

**Interfaces:**
- Produces: `expectKoreanTextLayout(locator, options)`, `expectUnbrokenPhrase(locator, text)`, `expectNoDocumentOverflow(page)`, `expectCardTextClearOfFavorite(article, options)`, and `seedToolPreferences(page, favorites, recent)` for Tasks 2 and 3.
- Consumes: existing semantic ids `home-title`, `file-launcher-title`, `home-tools-title`, and `home-domain-panel`.

- [ ] **Step 1: Create the shared Playwright geometry helper**

Create `tests/e2e/support/korean-typography.ts` with this complete implementation:

```ts
import { expect, type Locator, type Page } from "@playwright/test";

type WrapStyle = "balance" | "pretty";

type KoreanLayoutOptions = {
  forbiddenLastLines?: readonly string[];
  textWrap: WrapStyle;
};

export async function seedToolPreferences(
  page: Page,
  favorites: readonly string[] = [],
  recent: readonly string[] = [],
): Promise<void> {
  await page.addInitScript(
    ({ favoriteIds, recentIds }) => {
      window.localStorage.setItem("hereisit.favorite-tools.v1", JSON.stringify(favoriteIds));
      window.localStorage.setItem("hereisit.recent-tools.v1", JSON.stringify(recentIds));
    },
    { favoriteIds: favorites, recentIds: recent },
  );
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function expectKoreanTextLayout(
  locator: Locator,
  options: KoreanLayoutOptions,
): Promise<void> {
  await expect(locator).toHaveCount(1);
  const report = await locator.evaluate((element, expectedWrap) => {
    const root = element as HTMLElement;
    const style = getComputedStyle(root);
    const rootRect = root.getBoundingClientRect();
    const runs: Array<{ end: number; node: Text; start: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let fullText = "";
    let current = walker.nextNode();
    while (current !== null) {
      const node = current as Text;
      const parent = node.parentElement;
      if (parent !== null) {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.display !== "none" && parentStyle.visibility !== "hidden") {
          const start = fullText.length;
          fullText += node.data;
          runs.push({ end: fullText.length, node, start });
        }
      }
      current = walker.nextNode();
    }

    function boundaryAt(offset: number): { node: Text; offset: number } | null {
      const run = runs.find(({ end, start }) => offset >= start && offset <= end);
      if (run === undefined) return null;
      return { node: run.node, offset: Math.min(offset - run.start, run.node.data.length) };
    }

    function rangeFor(start: number, end: number): Range | null {
      const first = boundaryAt(start);
      const last = boundaryAt(end);
      if (first === null || last === null) return null;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset);
      return range;
    }

    function visibleRects(range: Range): DOMRect[] {
      return Array.from(range.getClientRects()).filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > rootRect.top + 0.5 &&
          rect.top < rootRect.bottom - 0.5 &&
          rect.right > rootRect.left + 0.5 &&
          rect.left < rootRect.right - 0.5,
      );
    }

    function lineTops(rects: readonly DOMRect[]): number[] {
      const tops: number[] = [];
      for (const rect of [...rects].sort((left, right) => left.top - right.top)) {
        if (!tops.some((top) => Math.abs(top - rect.top) <= 1)) tops.push(rect.top);
      }
      return tops;
    }

    function intrinsicWidth(text: string): number {
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      probe.style.font = style.font;
      probe.style.letterSpacing = style.letterSpacing;
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    }

    const splitWords: string[] = [];
    const wordSegments = new Intl.Segmenter("ko", { granularity: "word" }).segment(fullText);
    for (const part of wordSegments) {
      if (!part.isWordLike || !/[가-힣]/u.test(part.segment)) continue;
      const range = rangeFor(part.index, part.index + part.segment.length);
      if (range === null) continue;
      const lines = lineTops(visibleRects(range));
      if (
        lines.length > 1 &&
        intrinsicWidth(part.segment) <= root.clientWidth + 1
      ) {
        splitWords.push(part.segment);
      }
    }

    const visualLines: Array<{ text: string; top: number }> = [];
    const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(fullText);
    for (const part of graphemes) {
      const range = rangeFor(part.index, part.index + part.segment.length);
      if (range === null) continue;
      const rect = visibleRects(range)[0];
      if (rect === undefined) continue;
      let line = visualLines.find(({ top }) => Math.abs(top - rect.top) <= 1);
      if (line === undefined) {
        line = { text: "", top: rect.top };
        visualLines.push(line);
      }
      line.text += part.segment;
    }
    visualLines.sort((left, right) => left.top - right.top);

    return {
      clientWidth: root.clientWidth,
      lastLine: visualLines.at(-1)?.text.trim() ?? "",
      overflowWrap: style.overflowWrap,
      scrollWidth: root.scrollWidth,
      splitWords,
      supportsTextWrap:
        CSS.supports("text-wrap", expectedWrap) ||
        CSS.supports("text-wrap-style", expectedWrap),
      textWrap: [
        style.getPropertyValue("text-wrap"),
        style.getPropertyValue("text-wrap-style"),
      ].join(" "),
      wordBreak: style.wordBreak,
    };
  }, options.textWrap);

  expect(report.wordBreak).toBe("keep-all");
  expect(report.overflowWrap).toBe("break-word");
  if (report.supportsTextWrap) expect(report.textWrap).toContain(options.textWrap);
  expect(report.splitWords).toEqual([]);
  expect(options.forbiddenLastLines ?? []).not.toContain(report.lastLine);
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth + 1);
}

export async function expectUnbrokenPhrase(locator: Locator, text: string): Promise<void> {
  await expect(locator).toHaveText(text);
  const report = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops: number[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (!tops.some((top) => Math.abs(top - rect.top) <= 1)) tops.push(rect.top);
    }
    const parent = element.parentElement as HTMLElement | null;
    const parentStyle = parent === null ? null : getComputedStyle(parent);
    const parentWidth =
      parent === null || parentStyle === null
        ? 0
        : parent.clientWidth -
          Number.parseFloat(parentStyle.paddingLeft) -
          Number.parseFloat(parentStyle.paddingRight);
    return {
      lineCount: tops.length,
      parentWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
      width: element.getBoundingClientRect().width,
    };
  });
  expect(report.whiteSpace).toBe("nowrap");
  expect(report.lineCount).toBe(1);
  expect(report.width).toBeLessThanOrEqual(report.parentWidth + 1);
}

export async function expectCardTextClearOfFavorite(
  article: Locator,
  options: { absoluteFavorite: boolean; clamped: boolean },
): Promise<void> {
  await article.scrollIntoViewIfNeeded();
  const report = await article.evaluate((element) => {
    const card = element as HTMLElement;
    const link = card.querySelector(":scope > a") as HTMLElement | null;
    const button = card.querySelector(":scope > button") as HTMLElement | null;
    const description = link?.querySelector("span:nth-child(2)") as HTMLElement | null;
    if (link === null || button === null || description === null) return null;
    const buttonRect = button.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const textRects = Array.from(link.querySelectorAll("span:nth-child(-n+2)")).flatMap(
      (span) => {
        const range = document.createRange();
        range.selectNodeContents(span);
        return Array.from(range.getClientRects());
      },
    );
    const intersects = textRects.some(
      (rect) =>
        rect.right > buttonRect.left + 0.5 &&
        rect.left < buttonRect.right - 0.5 &&
        rect.bottom > buttonRect.top + 0.5 &&
        rect.top < buttonRect.bottom - 0.5,
    );
    const center = document.elementFromPoint(
      buttonRect.left + buttonRect.width / 2,
      buttonRect.top + buttonRect.height / 2,
    );
    const descriptionStyle = getComputedStyle(description);
    return {
      buttonHeight: buttonRect.height,
      buttonPosition: getComputedStyle(button).position,
      buttonWidth: buttonRect.width,
      centerHitsButton: center !== null && button.contains(center),
      descriptionClamp: descriptionStyle.webkitLineClamp,
      linkFillsCard:
        Math.abs(linkRect.left - cardRect.left) <= 2 &&
        Math.abs(linkRect.right - cardRect.right) <= 2,
      textIntersectsButton: intersects,
    };
  });

  expect(report).not.toBeNull();
  expect(report?.buttonWidth ?? 0).toBeGreaterThanOrEqual(44);
  expect(report?.buttonHeight ?? 0).toBeGreaterThanOrEqual(44);
  expect(report?.centerHitsButton).toBe(true);
  expect(report?.textIntersectsButton).toBe(false);
  expect(report?.buttonPosition).toBe(options.absoluteFavorite ? "absolute" : "static");
  expect(report?.descriptionClamp === "2").toBe(options.clamped);
  if (options.absoluteFavorite) expect(report?.linkFillsCard).toBe(true);
}
```

- [ ] **Step 2: Write failing home typography tests**

Create `tests/e2e/korean-typography.spec.ts` with the desktop/full-width test:

```ts
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
```

Create `tests/e2e/korean-typography-mobile.spec.ts` with the mobile-engine test:

```ts
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
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --grep "home Korean"
```

Expected: FAIL because `#home-title span` does not exist and the target elements compute to `word-break: normal`.

- [ ] **Step 4: Implement the minimal home markup and CSS**

Replace the heading in `apps/web/src/components/home-discovery.tsx` with:

```tsx
<h1 id="home-title">
  파일 작업, <span className={styles.closingPhrase}>여기서 끝.</span>
</h1>
```

Add these declarations to the existing selectors in `home-discovery.module.css`:

```css
.heroCopy h1 {
  overflow-wrap: break-word;
  text-wrap: balance;
  word-break: keep-all;
}

.closingPhrase {
  white-space: nowrap;
}

.heroCopy > p:last-child {
  overflow-wrap: break-word;
  text-wrap: pretty;
  word-break: keep-all;
}
```

Add these declarations to `home-file-launcher.module.css`:

```css
.heading h2 {
  overflow-wrap: break-word;
  text-wrap: balance;
  word-break: keep-all;
}

.heading > p:last-child {
  overflow-wrap: break-word;
  text-wrap: pretty;
  word-break: keep-all;
}
```

Add these declarations to `domain-tool-tabs.module.css`:

```css
.heading h2,
.panelHeading h3 {
  overflow-wrap: break-word;
  text-wrap: balance;
  word-break: keep-all;
}

.panelHeading p {
  overflow-wrap: break-word;
  text-wrap: pretty;
  word-break: keep-all;
}
```

Merge the declarations into the existing selector blocks instead of duplicating selectors when applying the patch.

- [ ] **Step 5: Build and verify GREEN in desktop and mobile engines**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --project=firefox --grep "home Korean"
pnpm exec playwright test tests/e2e/korean-typography-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "home Korean"
```

Expected: all four project runs PASS; the heading accessible name remains `파일 작업, 여기서 끝.` and every width has no document overflow.

- [ ] **Step 6: Commit the home deliverable**

```bash
git add tests/e2e/support/korean-typography.ts tests/e2e/korean-typography.spec.ts tests/e2e/korean-typography-mobile.spec.ts apps/web/src/components/home-discovery.tsx apps/web/src/components/home-discovery.module.css apps/web/src/components/home-file-launcher.module.css apps/web/src/components/domain-tool-tabs.module.css
git commit -m "fix(home): improve Korean responsive wrapping"
```

---

### Task 2: Tool Catalog and Planned-Card Typography

**Files:**
- Modify: `tests/e2e/korean-typography.spec.ts`
- Modify: `tests/e2e/korean-typography-mobile.spec.ts`
- Modify: `apps/web/src/components/tool-catalog-browser.module.css:15-28,82-96,183-218,230-259,267-271`

**Interfaces:**
- Consumes: `expectKoreanTextLayout` and `expectNoDocumentOverflow` from Task 1.
- Produces: consistent catalog heading and description contracts for ordinary, planned, fallback, and empty states.

- [ ] **Step 1: Add failing catalog typography tests**

Append this test to `tests/e2e/korean-typography.spec.ts`:

```ts
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
```

Append this test to `tests/e2e/korean-typography-mobile.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --grep "catalog and planned-card"
```

Expected: FAIL because catalog headings and descriptions compute to `word-break: normal`, and `.plannedCard h3` computes to `overflow-wrap: anywhere`.

- [ ] **Step 3: Implement catalog-local wrapping rules**

Add these grouped policies to `tool-catalog-browser.module.css`:

```css
.hero h1,
.fallback h1,
.panelHeading h2,
.resultHeading h2,
.plannedCard h3 {
  overflow-wrap: break-word;
  text-wrap: balance;
  word-break: keep-all;
}

.hero > div > p:last-child,
.panelHeading p,
.plannedCard p,
.noAvailable,
.empty p {
  overflow-wrap: break-word;
  text-wrap: pretty;
  word-break: keep-all;
}
```

Remove the later `overflow-wrap: anywhere;` declaration from `.plannedCard h3`; keep its existing margin, font size, and letter spacing unchanged.

- [ ] **Step 4: Build and verify GREEN**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --project=firefox --grep "catalog and planned-card"
pnpm exec playwright test tests/e2e/korean-typography-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "catalog and planned-card"
```

Expected: all four project runs PASS, planned cards remain inert, and all primary widths remain bounded.

- [ ] **Step 5: Commit the catalog deliverable**

```bash
git add tests/e2e/korean-typography.spec.ts tests/e2e/korean-typography-mobile.spec.ts apps/web/src/components/tool-catalog-browser.module.css
git commit -m "fix(catalog): improve Korean responsive wrapping"
```

---

### Task 3: Shared Tool Cards and the 600/800px Boundary

**Files:**
- Modify: `tests/e2e/korean-typography.spec.ts`
- Modify: `tests/e2e/korean-typography-mobile.spec.ts`
- Modify: `apps/web/src/components/tool-card.module.css:30-57,120-166`

**Interfaces:**
- Consumes: all Task 1 helper exports and the existing `ToolCard` DOM order `article > a + button`.
- Produces: shared card wrapping across home, catalog, personal tools, and related tools while preserving the 600px line-clamp and 800px favorite-layout contracts.

- [ ] **Step 1: Add failing shared-card boundary and route tests**

Append these tests to `tests/e2e/korean-typography.spec.ts`:

```ts
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
    { path: "/tools", card: () => page.getByTestId("available-tool-grid").locator("article").first() },
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
```

Add `expectCardTextClearOfFavorite` to the helper imports at the top of `tests/e2e/korean-typography.spec.ts`.

Append this mobile-engine test to `tests/e2e/korean-typography-mobile.spec.ts` and add the same helper import:

```ts
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
```

- [ ] **Step 2: Run the 800px boundary test and verify RED**

Run:

```bash
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --grep "600/800 pixel boundaries"
```

Expected: FAIL at 601, 768, and 800px because the favorite button is still in the grid's separate static column; shared card descriptions also do not compute to `text-wrap: pretty`.

- [ ] **Step 3: Implement shared card text and isolated layout rules**

Replace the current shared declaration in `tool-card.module.css` with:

```css
.name,
.description {
  min-width: 0;
  overflow-wrap: break-word;
  word-break: keep-all;
}

.execution {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
```

Add the wrapping modes to the existing blocks:

```css
.name {
  text-wrap: balance;
}

.description {
  text-wrap: pretty;
}
```

Insert this media query before the existing `@media (max-width: 420px)` query:

```css
@media (max-width: 800px) {
  .card {
    display: block;
  }

  .link {
    padding-right: 68px;
  }

  .card > .favoriteButton {
    position: absolute;
    z-index: 2;
    top: 12px;
    right: 12px;
    margin: 0;
  }
}
```

In the existing `@media (max-width: 600px)` query, remove only these declarations because the new 800px query owns them:

```css
.card {
  display: block;
}

.card > .favoriteButton {
  position: absolute;
  z-index: 2;
  top: 12px;
  right: 12px;
  margin: 0;
}
```

Keep the existing 600px `.link` block with `min-height`, `gap`, and `padding: 18px 68px 18px 18px`, and keep both two-line clamps and compact font sizes unchanged.

- [ ] **Step 4: Build and verify GREEN across shared surfaces**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/korean-typography.spec.ts --project=chromium --project=firefox --grep "shared-card"
pnpm exec playwright test tests/e2e/korean-typography-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "shared-card"
```

Expected: all runs PASS; 600px remains clamped, 601-800px uses an absolute favorite button without clamping, 801px restores the static grid column, and every tested favorite button remains a reachable 44px target.

- [ ] **Step 5: Commit the shared-card deliverable**

```bash
git add tests/e2e/korean-typography.spec.ts tests/e2e/korean-typography-mobile.spec.ts apps/web/src/components/tool-card.module.css
git commit -m "fix(cards): preserve Korean copy space on tablets"
```

---

### Task 4: Integrated Verification, Review, and Cloudflare Preview

**Files:**
- Verify: all files changed in Tasks 1-3
- Create ignored evidence only: `.superpowers/sdd/korean-typography-preview/`

**Interfaces:**
- Consumes: the completed branch, focused test files, GitHub CI, and Cloudflare Pages commit checks.
- Produces: review approval, full local verification evidence, immutable-preview evidence, and the merge gate.

- [ ] **Step 1: Run formatting, static verification, and the focused engine matrix**

Run:

```bash
pnpm lint:fix
git diff --check
pnpm verify
pnpm build
pnpm exec playwright test tests/e2e/korean-typography.spec.ts tests/e2e/korean-typography-mobile.spec.ts --project=chromium --project=firefox --project=mobile-chromium --project=mobile-firefox
```

Expected: Biome makes no unexpected edits, 984 or more unit tests pass, 19 static routes build, and every focused Chromium/Firefox test passes.

- [ ] **Step 2: Run the complete local browser regression suite**

Run:

```bash
pnpm verify:all
```

Expected: all locally configured Chromium, Firefox, mobile Chromium, and mobile Firefox tests pass with zero failures.

- [ ] **Step 3: Request independent code review**

Review the range from `e8bbef3d8c75f46527cad6ad7a753ec1acd116b4` to the branch HEAD against the approved design. Treat any Critical or Important finding as blocking, fix it with a new failing regression test where applicable, rerun Steps 1-2, and request a fresh review. Minor findings may be recorded only when they do not affect wrapping, overflow, accessibility, responsive boundaries, or privacy.

- [ ] **Step 4: Push the branch and require GitHub checks**

Run:

```bash
git status --short
git push -u origin fix/korean-responsive-typography
gh pr create --draft --base main --head fix/korean-responsive-typography --title "fix: improve responsive Korean typography" --body "## Summary

- keep Korean headings and descriptions on natural word boundaries across mobile and desktop
- preserve the home closing phrase and shared-card copy space
- add multi-engine responsive typography and card-geometry regression coverage

## Validation

- pnpm verify
- pnpm verify:all
- focused Chromium, Firefox, mobile Chromium, and mobile Firefox typography matrix

## Privacy

- local-first file processing and processing contracts are unchanged"
HEAD_SHA=$(git rev-parse HEAD)
PR_NUMBER=$(gh pr view --json number --jq .number)
gh pr checks "$PR_NUMBER" --watch --interval 10
```

Expected: the worktree is clean before push; GitHub `verify`, `browser`, and `Cloudflare Pages` checks all conclude successfully. The CI browser job installs and runs Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, and mobile WebKit.

- [ ] **Step 5: Resolve and validate the immutable Cloudflare preview**

Run after the Cloudflare Pages check succeeds:

```bash
HEAD_SHA=$(git rev-parse HEAD)
PREVIEW_URL=$(gh api "repos/liorium/hereisit/commits/$HEAD_SHA/check-runs" --jq '.check_runs[] | select(.name == "Cloudflare Pages" and .conclusion == "success") | .output.summary' | rg -o 'https://[0-9a-f]+\.hereisit\.pages\.dev' | head -n 1)
test -n "$PREVIEW_URL"
printf '%s\n' "$PREVIEW_URL"
```

Expected: the URL contains the Cloudflare deployment hash, not the branch alias, and the check summary names the exact `HEAD_SHA` commit.

Use Playwright against that immutable URL to inspect `/`, `/tools?planned=1`, `/my-tools`, and `/image/compress` at 320x568, 390x844, and 1280x900. Seed `hereisit.favorite-tools.v1` with `["image.compress"]` and `hereisit.recent-tools.v1` with `["pdf.watermark"]` before navigation. Record screenshots under `.superpowers/sdd/korean-typography-preview/` and require all of the following:

- every response is HTTP 200;
- console errors, page errors, and framework overlays are zero;
- document and target-element horizontal overflow are zero;
- `여기서 끝.` stays on one line inside its parent;
- planned cards remain inert;
- shared card text never intersects the favorite button;
- each favorite button remains at least 44x44px and its center hit-test resolves to the button.

- [ ] **Step 6: Merge only after the immutable preview and CI are green**

Use a squash merge with Conventional Commit title:

```text
fix: improve responsive Korean typography
```

After merge, wait for the Cloudflare Pages check on the new `main` commit, then rerun the same 12-route/viewport smoke matrix against `https://hereisit.pages.dev`. The task is complete only when the production check names the merged commit and all smoke assertions pass.
