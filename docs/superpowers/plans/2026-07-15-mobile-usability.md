# Mobile Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HereIsIt comfortable to discover and operate at 320–600 CSS pixels while preserving the existing desktop experience, local-only file processing, and public contracts.

**Architecture:** Keep the current shared React component tree and use a single `max-width: 600px` compact presentation layer. Add one tiny platform helper for keyboard-focused tab reveal, leave file processors and catalog state untouched, and prove the result with deterministic Playwright geometry, state, privacy, and cross-engine checks.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, CSS Modules, Vitest 4, Playwright 1.61, Cloudflare Pages Git integration.

## Global Constraints

- The compact presentation applies at `max-width: 600px`; the existing tablet presentation resumes at `601px`.
- Discovery cards use one column through 600px; tool names and descriptions show at most two visual lines, and the local-processing label remains visible.
- With clean local storage and 100-percent text scale, the home file selector is fully inside a `320×568` CSS viewport.
- With clean local storage and 100-percent text scale, the first catalog card link and primary image/PDF selectors are fully inside a `390×844` CSS viewport.
- Primary targets are at least `44×44` CSS pixels, search inputs remain at least `16px`, and functional action, state, progress, privacy, limitation, warning, and error text is at least `12px`.
- Domain and purpose controls remain semantic tabs/buttons in one locally scrollable row; they never create document-level horizontal overflow.
- ArrowLeft, ArrowRight, Home, and End preserve roving focus and reveal the selected tab without moving the document vertically.
- No selected file, filename, file bytes, thumbnail, presigned URL, or file-derived value may be logged, uploaded, or persisted.
- Do not add or update a dependency. Do not add a runtime viewport listener or user-agent branch.
- Browser processing contracts, Worker protocols, file limits, output bytes, routes, URL serialization, favorites, recents, and processor behavior remain unchanged.
- Desktop home, catalog, detail, menu, and workbench behavior remains unchanged at `1280px`.
- Deployment continues through Cloudflare Pages Git integration only; do not use Direct Upload or `wrangler pages deploy`.

## File Structure

- Create `apps/web/src/lib/focus-and-reveal-tab.ts` for the only new runtime behavior: focus without implicit page scrolling, then reveal the tab on the inline axis.
- Create `apps/web/src/lib/focus-and-reveal-tab.test.ts` for the helper's exact platform calls.
- Modify shared discovery components and their CSS Modules; do not create mobile-only React components.
- Modify `FavoriteToolButton` to accept the already-known canonical tool name; callers remain `ToolCard` and `ToolDetailPage` only.
- Keep file-selection and processing TSX files unchanged; compact their existing shells through `image-workbench.module.css` and `pdf-workbench.module.css`.
- Extend `tests/e2e/discovery-mobile.spec.ts`, `tests/e2e/discovery.spec.ts`, `tests/e2e/mobile.spec.ts`, and `tests/e2e/tool-detail-shells.spec.ts`; reuse `tests/e2e/support/privacy-observer.ts` without changing its privacy-safe reporting.
- Add a narrow Firefox Playwright project in `playwright.config.ts`; Firefox evidence covers responsive CSS, keyboard, and reflow, not iPhone browser emulation.

---

### Task 1: Horizontally scrollable domain tabs with deterministic focus reveal

**Files:**
- Create: `apps/web/src/lib/focus-and-reveal-tab.ts`
- Create: `apps/web/src/lib/focus-and-reveal-tab.test.ts`
- Modify: `apps/web/src/components/domain-tool-tabs.tsx:1-53`
- Modify: `apps/web/src/components/domain-tool-tabs.module.css:1-170`
- Modify: `apps/web/src/components/tool-catalog-browser.tsx:17-162`
- Modify: `apps/web/src/components/tool-catalog-browser.module.css:35-68,285-357`
- Modify: `tests/e2e/discovery-mobile.spec.ts:1-85`
- Modify: `playwright.config.ts:20-50`

**Interfaces:**
- Consumes: an `HTMLElement`-compatible target exposing `focus(options)` and `scrollIntoView(options)`.
- Produces: `focusAndRevealTab(tab: FocusAndRevealTarget | null): void`, used only after ArrowLeft, ArrowRight, Home, or End changes the selected tab.
- Preserves: `DomainToolTabs({ selected, onSelect, recentToolIds })` and `ToolCatalogBrowser(): ReactNode` public APIs.

- [ ] **Step 1: Write the failing platform-helper test**

Create `apps/web/src/lib/focus-and-reveal-tab.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  focusAndRevealTab,
  type FocusAndRevealTarget,
} from "./focus-and-reveal-tab";

describe("focusAndRevealTab", () => {
  it("focuses without implicit scrolling and reveals only the nearest inline area", () => {
    const order: string[] = [];
    const target: FocusAndRevealTarget = {
      focus: vi.fn((options) => {
        order.push("focus");
        expect(options).toEqual({ preventScroll: true });
      }),
      scrollIntoView: vi.fn((options) => {
        order.push("scroll");
        expect(options).toEqual({ behavior: "auto", block: "nearest", inline: "nearest" });
      }),
    };

    focusAndRevealTab(target);

    expect(order).toEqual(["focus", "scroll"]);
  });

  it("does nothing when the ref is not mounted", () => {
    expect(() => focusAndRevealTab(null)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the helper test and verify red**

Run:

```bash
pnpm test apps/web/src/lib/focus-and-reveal-tab.test.ts
```

Expected: FAIL because `focus-and-reveal-tab.ts` does not exist.

- [ ] **Step 3: Add the platform helper and connect both keyboard tablists**

Create `apps/web/src/lib/focus-and-reveal-tab.ts`:

```ts
export interface FocusAndRevealTarget {
  focus(options?: FocusOptions): void;
  scrollIntoView(options?: boolean | ScrollIntoViewOptions): void;
}

export function focusAndRevealTab(tab: FocusAndRevealTarget | null): void {
  if (tab === null) return;
  tab.focus({ preventScroll: true });
  tab.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
}
```

Import it in both tab components:

```ts
import { focusAndRevealTab } from "../lib/focus-and-reveal-tab";
```

Replace the final focus call in `DomainToolTabs.selectTab` with:

```ts
onSelect(definition.id);
focusAndRevealTab(tabRefs.current[index]);
```

Replace the final focus call in `ToolCatalogBrowser.handleDomainKeyDown` with:

```ts
selectDomain(definition.id);
focusAndRevealTab(tabRefs.current[nextIndex]);
```

- [ ] **Step 4: Run the helper test and verify green**

Run:

```bash
pnpm test apps/web/src/lib/focus-and-reveal-tab.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Replace the old two-column mobile-tab expectation with a failing one-row acceptance test**

Change the `discovery-mobile.spec.ts` setup to clean preference state for every new document:

```ts
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("hereisit.favorite-tools.v1", "[]");
    window.localStorage.setItem("hereisit.recent-tools.v1", "[]");
  });
});
```

Remove the drawer assertion that requires four seeded recent-tool links. Drawer destinations, domain
links, focus trapping, Escape, and focus restoration remain covered without contaminating first-viewport
geometry with stored recents.

Add this helper near the top of `tests/e2e/discovery-mobile.spec.ts`:

```ts
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
  ).toEqual(expect.objectContaining({
    clientWidth: expect.any(Number),
    scrollWidth: expect.any(Number),
  }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    (await page.evaluate(() => document.documentElement.clientWidth)) + 1,
  );
}
```

Replace the home mobile tab/card test with:

```ts
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

  await tablist.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const beforeY = await page.evaluate(() => window.scrollY);
  await tabs.first().focus();
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
```

Add a catalog row check in the same file:

```ts
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
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --grep "domain tabs"
```

Expected: FAIL because both tablists currently form four mobile rows and have no local inline overflow.

- [ ] **Step 6: Add the one-row CSS and the narrow Firefox project**

Append to `domain-tool-tabs.module.css` after the existing 420px rule:

```css
@media (max-width: 600px) {
  .section {
    width: calc(100% - 24px);
    padding: 28px 0 72px;
  }

  .heading {
    margin-bottom: 20px;
  }

  .heading h2 {
    font-size: 32px;
    line-height: 1.05;
  }

  .tablist {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
  }

  .tablist .tab {
    flex: 0 0 112px;
    min-height: 48px;
    border: 1px solid var(--line);
    border-radius: 10px 10px 0 0;
    scroll-snap-align: start;
  }

  .panel {
    padding: 18px 14px;
    border-radius: 0 0 14px 14px;
  }
}
```

Append the corresponding catalog rule to `tool-catalog-browser.module.css`:

```css
@media (max-width: 600px) {
  .tablist {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
  }

  .tablist .tab {
    flex: 0 0 112px;
    min-height: 48px;
    border-radius: 10px 10px 0 0;
    scroll-snap-align: start;
  }
}
```

Add `mobile-firefox` immediately after `mobile-chromium` in `playwright.config.ts`:

```ts
{
  name: "mobile-firefox",
  use: {
    ...devices["Desktop Firefox"],
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    hasTouch: true,
  },
  testMatch: /mobile\.spec\.ts/,
},
```

- [ ] **Step 7: Verify the focused tab behavior across the mobile engines**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "domain tabs"
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-webkit --grep "domain tabs"
```

Expected: the home and catalog tests pass in Chromium, Firefox, and WebKit; the selected final tab is horizontally visible and `window.scrollY` does not move.

- [ ] **Step 8: Commit the tab slice**

```bash
git add apps/web/src/lib/focus-and-reveal-tab.ts apps/web/src/lib/focus-and-reveal-tab.test.ts apps/web/src/components/domain-tool-tabs.tsx apps/web/src/components/domain-tool-tabs.module.css apps/web/src/components/tool-catalog-browser.tsx apps/web/src/components/tool-catalog-browser.module.css tests/e2e/discovery-mobile.spec.ts playwright.config.ts
git commit -m "feat: make mobile domain tabs horizontally scrollable"
```

---

### Task 2: Compact shared cards and tool-specific favorite controls

**Files:**
- Modify: `apps/web/src/components/favorite-tool-button.tsx:1-31`
- Modify: `apps/web/src/components/tool-card.tsx:7-30`
- Modify: `apps/web/src/components/tool-card.module.css:1-116`
- Modify: `apps/web/src/components/tool-detail-page.tsx:48-53`
- Modify: `apps/web/src/components/domain-tool-tabs.module.css:72-170`
- Modify: `apps/web/src/components/tool-catalog-browser.module.css:187-357`
- Modify: `apps/web/src/components/my-tools.module.css:69-171`
- Modify: `apps/web/src/components/tool-detail-page.module.css:155-217`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Modify: `tests/e2e/discovery.spec.ts:199-245,299-325`

**Interfaces:**
- Consumes: canonical `tool.id` and `tool.name` already available in `ToolCard` and `ToolDetailPage`.
- Produces: `FavoriteToolButton({ toolId, toolName }): ReactNode` with accessible names such as `이미지 용량 줄이기 즐겨찾기 추가`.
- Preserves: card DOM order `article > a + button`, full canonical link text, preference storage keys, and `ToolCard` props.

- [ ] **Step 1: Write the failing compact-card acceptance test**

Add this test to `tests/e2e/discovery-mobile.spec.ts`:

```ts
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
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
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
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --grep "compact one-column"
```

Expected: FAIL at 390–600px because the catalog uses two columns, the description is not clamped, and the favorite name is generic.

- [ ] **Step 2: Make the favorite name explicit at both call sites**

Change `FavoriteToolButton` to:

```tsx
export function FavoriteToolButton({
  toolId,
  toolName,
}: {
  toolId: AvailableToolId;
  toolName: string;
}): ReactNode {
  const { favorites } = useToolPreferences();
  const isFavorite = favorites.includes(toolId);
  const action = isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가";
  const label = `${toolName} ${action}`;

  function toggleFavorite(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    toolPreferencesStore.toggleFavorite(toolId);
  }

  return (
    <button
      aria-pressed={isFavorite}
      className={styles.favoriteButton}
      onClick={toggleFavorite}
      type="button"
    >
      <span className={styles.favoriteLabel}>{label}</span>
      <span aria-hidden="true" className={styles.favoriteIcon}>
        {isFavorite ? "★" : "☆"}
      </span>
    </button>
  );
}
```

Update the two callers exactly:

```tsx
<FavoriteToolButton toolId={catalogTool.id} toolName={catalogTool.name} />
```

```tsx
<FavoriteToolButton toolId={toolId} toolName={tool.name} />
```

Make favorite locators explicit in `discovery.spec.ts`:

```ts
compressCard.getByRole("button", { name: "이미지 용량 줄이기 즐겨찾기 추가", exact: true })
compressCard.getByRole("button", { name: "이미지 용량 줄이기 즐겨찾기 해제", exact: true })
```

For the recent PDF watermark card, use:

```ts
.getByRole("button", { name: "PDF 워터마크 넣기 즐겨찾기 추가", exact: true })
```

- [ ] **Step 3: Add the shared compact card rules**

Append this rule after the existing 420px rule in `tool-card.module.css`:

```css
@media (max-width: 600px) {
  .card {
    display: block;
  }

  .link {
    min-height: 44px;
    gap: 6px;
    padding: 18px 68px 18px 18px;
  }

  .name,
  .description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .name {
    font-size: 18px;
    line-height: 1.3;
  }

  .description {
    font-size: 14px;
    line-height: 1.5;
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

The `.card > .favoriteButton` selector is required so the same button class in a detail-page title row does not become absolute.

- [ ] **Step 4: Make every shared-card caller one column through 600px**

Append to `domain-tool-tabs.module.css`:

```css
@media (max-width: 600px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
```

Append to `tool-catalog-browser.module.css`:

```css
@media (max-width: 600px) {
  .cards,
  .plannedCards,
  .fallbackCards {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
```

Append to `my-tools.module.css`:

```css
@media (max-width: 600px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Change the existing detail breakpoint from `@media (max-width: 560px)` to `@media (max-width: 600px)` so `.relatedGrid` is also one column at the shared boundary.

- [ ] **Step 5: Verify card geometry and existing preference behavior**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "compact one-column"
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=chromium --grep "favorites|personal tools"
```

Expected: compact-card and preference tests pass; favorite IDs stored in local storage remain unchanged.

- [ ] **Step 6: Commit the card slice**

```bash
git add apps/web/src/components/favorite-tool-button.tsx apps/web/src/components/tool-card.tsx apps/web/src/components/tool-card.module.css apps/web/src/components/tool-detail-page.tsx apps/web/src/components/domain-tool-tabs.module.css apps/web/src/components/tool-catalog-browser.module.css apps/web/src/components/my-tools.module.css apps/web/src/components/tool-detail-page.module.css tests/e2e/discovery-mobile.spec.ts tests/e2e/discovery.spec.ts
git commit -m "feat: compact mobile tool cards"
```

---

### Task 3: Put the home file selector in the first 320×568 viewport

**Files:**
- Modify: `apps/web/src/components/home-discovery.module.css:1-45`
- Modify: `apps/web/src/components/home-file-launcher.module.css:1-239`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts:37-54`

**Interfaces:**
- Consumes: existing `HomeDiscovery` document order and `HomeFileLauncher` selectors.
- Produces: compact CSS only; `HomeFileLauncher` state, detection, recommendation, handoff, and reset functions remain byte-for-byte unchanged.

- [ ] **Step 1: Write the failing first-viewport test**

Add this helper to `discovery-mobile.spec.ts`:

```ts
async function expectFullyInsideViewport(locator: Locator, viewportHeight: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? viewportHeight + 1)).toBeLessThanOrEqual(viewportHeight);
}
```

Add the acceptance test:

```ts
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
  await expect(page.getByRole("status")).toContainText("기기 안에서 형식만 확인");
  await expectNoDocumentOverflow(page);
});
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --grep "initial 320"
```

Expected: FAIL because the file selector begins below the first viewport.

- [ ] **Step 2: Compact the mobile home hero**

Append to `home-discovery.module.css`:

```css
@media (max-width: 600px) {
  .hero {
    width: calc(100% - 24px);
    padding: 24px 0 12px;
    gap: 14px;
  }

  .heroCopy h1 {
    font-size: clamp(40px, 13vw, 52px);
    line-height: 0.98;
  }

  .heroCopy > p:last-child {
    margin-top: 12px;
    font-size: 14px;
    line-height: 1.45;
  }

  .search {
    padding-bottom: 0;
  }
}
```

- [ ] **Step 3: Compact the launcher without changing its behavior or copy**

Append to `home-file-launcher.module.css`:

```css
@media (max-width: 600px) {
  .section {
    width: calc(100% - 24px);
    padding: 8px 0 40px;
  }

  .heading {
    margin-bottom: 12px;
  }

  .heading h2 {
    font-size: 26px;
    line-height: 1.1;
  }

  .heading > p:last-child {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.45;
  }

  .dropzone {
    min-height: 104px;
    padding: 14px;
    gap: 8px;
    border-radius: 14px;
  }

  .dropzone > strong {
    display: none;
  }

  .dropzone > span {
    font-size: 12px;
  }

  .selectButton {
    width: 100%;
    min-height: 48px;
    order: -1;
    margin-top: 0;
  }

  .status,
  .correction {
    margin-top: 10px;
    font-size: 12px;
  }

  .results {
    margin-top: 16px;
    gap: 12px;
  }

  .group {
    padding: 16px;
  }
}
```

- [ ] **Step 4: Strengthen the existing mobile home smoke assertion**

In the first test of `tests/e2e/mobile.spec.ts`, set the approved viewport and add the same bounding-box requirement:

```ts
await page.setViewportSize({ width: 320, height: 568 });
await page.goto("/");
const fileSelect = page.getByRole("button", { name: "파일 선택" });
await expect(fileSelect).toBeEnabled();
const fileSelectBox = await fileSelect.boundingBox();
expect(fileSelectBox).not.toBeNull();
expect(fileSelectBox?.y ?? -1).toBeGreaterThanOrEqual(0);
expect((fileSelectBox?.y ?? 0) + (fileSelectBox?.height ?? 569)).toBeLessThanOrEqual(568);
```

- [ ] **Step 5: Verify the home first viewport in all mobile projects**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts tests/e2e/mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "home file selector|home discovery flow"
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts tests/e2e/mobile.spec.ts --project=mobile-webkit --grep "home file selector|home discovery flow"
```

Expected: the button is fully inside 320×568, at least 44px high, and the document does not overflow.

- [ ] **Step 6: Commit the home slice**

```bash
git add apps/web/src/components/home-discovery.module.css apps/web/src/components/home-file-launcher.module.css tests/e2e/discovery-mobile.spec.ts tests/e2e/mobile.spec.ts
git commit -m "feat: bring the mobile home action forward"
```

---

### Task 4: Compact catalog filters and expose the first result

**Files:**
- Modify: `apps/web/src/components/tool-catalog-browser.module.css:1-363`
- Modify: `tests/e2e/discovery-mobile.spec.ts`
- Modify: `tests/e2e/discovery.spec.ts:265-297`

**Interfaces:**
- Consumes: existing URL-backed `CatalogUrlState`, tab panel, purpose fieldset, planned toggle, and result grid.
- Produces: CSS-only compact catalog hierarchy and one local purpose row.
- Preserves: query replace semantics, explicit filter push semantics, browser history, planned filtering, pagination, and result ranking.

- [ ] **Step 1: Write the failing catalog first-viewport and purpose-row test**

Replace the first catalog mobile test in `discovery-mobile.spec.ts` with:

```ts
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
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --grep "catalog filter surface"
```

Expected: FAIL because purpose buttons wrap and the first card link starts below 844px.

- [ ] **Step 2: Compact the catalog hierarchy and purpose controls**

Append this single mobile rule to `tool-catalog-browser.module.css`, merging it with the Task 1 and Task 2 600px blocks during implementation so the file contains one coherent mobile section:

```css
@media (max-width: 600px) {
  .catalog,
  .fallback {
    width: calc(100% - 24px);
    padding: 24px 0 64px;
  }

  .hero {
    gap: 14px;
    margin-bottom: 18px;
  }

  .hero h1,
  .fallback h1 {
    font-size: 42px;
    line-height: 0.98;
  }

  .hero > div > p:last-child {
    margin-top: 10px;
    font-size: 14px;
    line-height: 1.5;
  }

  .panel {
    padding: 14px 12px;
  }

  .panelHeading {
    gap: 10px;
    margin-bottom: 12px;
  }

  .panelHeading h2 {
    font-size: 22px;
  }

  .panelHeading p {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.4;
  }

  .purposeControls {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 4px;
    overscroll-behavior-inline: contain;
  }

  .purposeControls button {
    flex: 0 0 auto;
  }

  .plannedToggle {
    margin-top: 8px;
  }

  .results,
  .plannedResults {
    padding-top: 16px;
  }

  .resultHeading {
    margin-bottom: 10px;
  }

  .plannedBadge {
    font-size: 12px;
  }
}
```

- [ ] **Step 3: Keep the desktop catalog regression focused on desktop behavior**

Replace the mobile wrapping portion of `discovery.spec.ts`'s catalog control test with 1280px and 900px assertions:

```ts
test("keeps desktop catalog controls bounded at desktop and tablet widths", async ({ page }) => {
  await page.goto("/tools");
  const tablist = page.getByRole("tablist", { name: "도구 분야" });
  const columnCount = () =>
    tablist.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
    );

  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await columnCount()).toBe(8);
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await columnCount()).toBe(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
});
```

The mobile one-row behavior remains owned by `discovery-mobile.spec.ts`.

- [ ] **Step 4: Verify URL behavior, first-viewport geometry, and the 601px boundary**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "catalog"
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=chromium --project=firefox --grep "catalog controls|shareable URL|explicit filters"
```

Expected: the 390px purpose surface is one local row, the first card link ends above 844px, URLs still serialize identically, and 601px retains the tablet grid.

- [ ] **Step 5: Commit the catalog slice**

```bash
git add apps/web/src/components/tool-catalog-browser.module.css tests/e2e/discovery-mobile.spec.ts tests/e2e/discovery.spec.ts
git commit -m "feat: compact mobile catalog filters"
```

---

### Task 5: Bring image and PDF selectors forward without removing trust content

**Files:**
- Modify: `apps/web/src/components/tool-detail-page.module.css:1-228`
- Modify: `apps/web/src/components/image-workbench.module.css:1-1315`
- Modify: `apps/web/src/components/pdf-workbench.module.css:1-1285`
- Modify: `apps/web/src/components/site-header.module.css:13-434`
- Modify: `tests/e2e/discovery-mobile.spec.ts:87-186`
- Modify: `tests/e2e/mobile.spec.ts:56-80`
- Modify: `tests/e2e/tool-detail-shells.spec.ts:20-160`

**Interfaces:**
- Consumes: current detail document order, `파일 작업 영역`/`편집 작업 공간` regions, shared image/PDF empty states, and existing chooser accessible names.
- Produces: compact CSS only; image/PDF Workbench props, Workers, validation, warnings, settings, sticky actions, and output logic remain unchanged.
- Preserves: notices before file selection, safe-area padding, focus order, and desktop workbench grids.

- [ ] **Step 1: Write the failing selector-visibility tests**

Replace the broad visibility loop in `mobile.spec.ts` with two geometry tests:

```ts
test("shows representative image and PDF selectors in the initial 390 by 844 viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, label] of [
    ["/image/compress", "압축할 이미지 선택"],
    ["/pdf/organize", "정리할 PDF 선택"],
  ] as const) {
    await page.goto(path);
    const selector = page.getByRole("button", { name: label, exact: true });
    await expect(selector).toBeEnabled({ timeout: 60_000 });
    const box = await selector.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 845)).toBeLessThanOrEqual(844);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("starts each representative work area inside a 320 by 568 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  for (const [path, regionName] of [
    ["/image/compress", "파일 작업 영역"],
    ["/pdf/organize", "편집 작업 공간"],
  ] as const) {
    await page.goto(path);
    const box = await page.getByRole("region", { name: regionName }).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? 569).toBeLessThan(568);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  }
});
```

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "representative image and PDF|representative work area"
```

Expected: FAIL because the current detail shell and 430/440px empty workbenches push the selectors below the viewport.

- [ ] **Step 2: Compact the shared detail shell at the 600px boundary**

Replace the old 560px rule in `tool-detail-page.module.css` with:

```css
@media (max-width: 600px) {
  .page {
    padding-block: 8px 48px;
  }

  .breadcrumbs,
  .hero,
  .related {
    width: calc(100% - 24px);
  }

  .hero {
    padding-block: 16px 14px;
  }

  .eyebrow {
    margin-bottom: 8px;
  }

  .titleRow {
    align-items: flex-start;
    gap: 8px;
  }

  .titleRow h1 {
    font-size: clamp(1.75rem, 9vw, 2.3rem);
    line-height: 1.08;
  }

  .description,
  .summary {
    margin-top: 10px;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .summary {
    margin-top: 6px;
  }

  .execution {
    margin-top: 14px;
    padding: 10px 12px;
    gap: 2px;
    border-radius: 12px;
    font-size: 0.8125rem;
  }

  .warning,
  .support {
    margin-top: 10px;
    padding-left: 24px;
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .warning::before,
  .support::before {
    font-size: 0.75rem;
  }

  .related {
    margin-top: 40px;
  }

  .relatedGrid {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

- [ ] **Step 3: Compact shared image empty states and keep functional copy readable**

Append to `image-workbench.module.css` after the 800px rule:

```css
@media (max-width: 600px) {
  .shell {
    width: calc(100% - 24px);
  }

  .emptyDropzone {
    min-height: 278px;
    padding: 18px 16px 46px;
    gap: 12px;
    box-shadow: 5px 5px 0 var(--yellow);
  }

  .emptyDropzone::before {
    display: none;
  }

  .dropIcon {
    width: 48px;
    height: 48px;
  }

  .dropIcon span {
    width: 30px;
    height: 30px;
    font-size: 19px;
  }

  .emptyDropzone h2 {
    font-size: 24px;
  }

  .emptyDropzone h2 + p {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.45;
  }

  .dropActions {
    gap: 8px;
  }

  .primaryButton {
    min-height: 48px;
  }

  .emptyStatus {
    min-height: 18px;
  }

  .localBadge {
    bottom: 12px;
  }

  .workbenchHeader {
    min-height: 72px;
    padding: 14px;
  }

  .workbenchHeader h2 {
    font-size: 24px;
  }

  .headerActions button {
    font-size: 12px;
  }

  .pasteHint,
  .emptyStatus,
  .previewMemoryNotice span,
  .qualityField strong,
  .formatWarning,
  .sizeGoalField strong,
  .sizeGoalField small,
  .privacyCopy,
  .privacyNotice strong,
  .actionBar span {
    font-size: 12px;
  }
}
```

- [ ] **Step 4: Compact shared PDF empty states and compression picker**

Append to `pdf-workbench.module.css` after the 800px rule:

```css
@media (max-width: 600px) {
  .shell {
    width: calc(100% - 24px);
  }

  .emptyDropzone {
    min-height: 286px;
    padding: 18px 16px 46px;
    gap: 12px;
    box-shadow: 5px 5px 0 var(--yellow);
  }

  .emptyDropzone::before {
    display: none;
  }

  .dropIcon {
    width: 48px;
    height: 48px;
  }

  .dropIcon span {
    width: 30px;
    height: 30px;
    font-size: 19px;
  }

  .dropCopy h2 {
    font-size: 24px;
  }

  .dropCopy > p:last-child {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.45;
  }

  .dropActions {
    gap: 8px;
  }

  .primaryButton {
    min-height: 48px;
  }

  .status {
    min-height: 18px;
  }

  .localBadge {
    bottom: 12px;
  }

  .workbenchHeader {
    min-height: 72px;
    padding: 14px;
  }

  .workbenchHeader h2 {
    font-size: 24px;
  }

  .headerActions button {
    font-size: 12px;
  }

  .panelTitle {
    height: 44px;
  }

  .compressionPicker {
    min-height: 220px;
    padding: 20px 16px;
    gap: 12px;
  }

  .compressionPickerIcon {
    width: 54px;
    height: 68px;
    font-size: 13px;
    box-shadow: 4px 4px 0 var(--yellow);
  }

  .status,
  .rasterNotice,
  .privacyNotice p,
  .privacyNotice strong,
  .resultCopy p,
  .statusCopy span,
  .qualityGroup legend,
  .qualityGroup > div,
  .validationNotice,
  .validationError,
  .compressionWarning,
  .compressionResultWarning,
  .compressionResultDetails dt,
  .compressionResultDetails dd {
    font-size: 12px;
  }
}
```

- [ ] **Step 5: Finish the small navigation target fixes**

Append to `site-header.module.css`:

```css
@media (max-width: 600px) {
  .brand,
  .drawerDomainGrid a {
    min-height: 44px;
  }

  .drawerDestinations span,
  .drawerFooter {
    font-size: 12px;
  }
}
```

The breadcrumb links already have `min-height: 44px`; retain that rule unchanged.

- [ ] **Step 6: Add trust-content and target-size regression assertions**

In `tool-detail-shells.spec.ts`, extend `expectCatalogShell`:

```ts
const breadcrumb = page.getByRole("navigation", { name: "현재 위치" });
for (const link of await breadcrumb.getByRole("link").all()) {
  const box = await link.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
const disclosure = page.getByRole("region", { name: "처리 방식" });
await expect(disclosure).toContainText("파일은 업로드되지 않으며 저장은 직접 선택해요.");
expect(
  await disclosure.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
).toBeGreaterThanOrEqual(12);
```

In the mobile drawer test, assert the brand and each drawer domain link are at least 44px high:

```ts
const brandBox = await page.getByRole("link", { name: "HereIsIt 홈" }).boundingBox();
expect(brandBox?.height ?? 0).toBeGreaterThanOrEqual(44);
for (const link of await drawer.getByTestId("mobile-domain-grid").getByRole("link").all()) {
  const box = await link.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
```

- [ ] **Step 7: Verify selector visibility, detail semantics, and desktop preservation**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "representative image and PDF|representative work area|modal mobile drawer"
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts --project=chromium --project=firefox
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-webkit --grep "representative image and PDF|representative work area"
```

Expected: selectors meet their first-viewport thresholds, work areas begin inside 320×568, warnings/disclosures remain visible, targets remain at least 44px, and desktop detail shells pass unchanged.

- [ ] **Step 8: Commit the detail/workbench slice**

```bash
git add apps/web/src/components/tool-detail-page.module.css apps/web/src/components/image-workbench.module.css apps/web/src/components/pdf-workbench.module.css apps/web/src/components/site-header.module.css tests/e2e/discovery-mobile.spec.ts tests/e2e/mobile.spec.ts tests/e2e/tool-detail-shells.spec.ts
git commit -m "feat: compact mobile tool workbenches"
```

---

### Task 6: Verify state feedback, privacy, text enlargement, and release readiness

**Files:**
- Modify: `tests/e2e/discovery-mobile.spec.ts:188-234`
- Modify: `tests/e2e/discovery.spec.ts:582-856`
- Modify: `tests/e2e/mobile.spec.ts:1-370,589-640`
- Verify unchanged: `tests/e2e/support/privacy-observer.ts`
- Verify unchanged: `scripts/verify-discovery-bundles.mjs`

**Interfaces:**
- Consumes: `installPrivacyObserver(page, { sentinels })`, whose failures contain classifications rather than raw URLs, filenames, bodies, blobs, or thumbnails.
- Produces: deterministic mobile evidence for detecting, processing, correction/error, and result states plus privacy-clean representative image and PDF flows.
- Preserves: browser codec tolerance rules; no byte-stability assertion is added.

- [ ] **Step 1: Replace the old per-element font mutation with the approved root-font reflow test**

Replace the enlarged-text test in `discovery-mobile.spec.ts` with:

```ts
test("keeps 200 percent root text enlargement reachable without document overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });

  expect(
    await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)),
  ).toBe(32);
  const select = page.getByRole("button", { name: "파일 선택" });
  const tabs = page.getByRole("tablist", { name: "도구 분야" });
  await select.scrollIntoViewIfNeeded();
  await expect(select).toBeInViewport();
  await tabs.scrollIntoViewIfNeeded();
  await expect(tabs).toBeInViewport();
  await expectNoDocumentOverflow(page);
});
```

Add a compact-width route matrix in the same file:

```ts
test("keeps key routes bounded across compact widths and the 601 pixel boundary", async ({
  page,
}) => {
  const routes = ["/", "/tools", "/my-tools", "/workflows", "/image/compress", "/pdf/organize"];
  for (const width of [320, 360, 390, 430, 600, 601]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
    }
  }
});
```

- [ ] **Step 2: Add mobile geometry to the existing deterministic home states**

At the beginning of `detects mixed files incrementally without network or private-data side effects`, set:

```ts
await page.setViewportSize({ width: 390, height: 844 });
```

After each `0/2`, `1/2`, and completed status assertion, add:

```ts
await launcher.getByRole("status").scrollIntoViewIfNeeded();
await expect(launcher.getByRole("status")).toBeInViewport();
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
```

At the beginning of `keeps an unknown-format correction beside the chooser`, set a 320×568 viewport, then add:

```ts
const correction = launcher.getByText(/지원하는 파일 형식을 찾지 못했어요/);
await correction.scrollIntoViewIfNeeded();
await expect(correction).toBeInViewport();
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
```

These existing tests already control prefix reads, verify the result state, and assert no request, console, storage, history, object-URL, or thumbnail leak.

Add representative rejected/invalid selection states to `mobile.spec.ts`:

```ts
test("keeps representative image and PDF error feedback reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });

  await page.goto("/image/compress");
  await page.locator("input[type=file]").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  const imageStatus = page.getByRole("status").filter({ hasText: "형식·파일당 50MB" });
  await imageStatus.scrollIntoViewIfNeeded();
  await expect(imageStatus).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await page.goto("/pdf/organize");
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a pdf"),
  });
  const pdfStatus = page.getByRole("status").filter({ hasText: /확인하지 못|다시 시도/ });
  await pdfStatus.scrollIntoViewIfNeeded();
  await expect(pdfStatus).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
```

- [ ] **Step 3: Add a deterministic held-terminal Worker helper for the representative image flow**

Add this function near the top of `mobile.spec.ts`:

```ts
async function holdTerminalWorkerEvents(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const releaseCallbacks: Array<() => void> = [];
    class HeldTerminalWorker {
      private readonly native: Worker;
      private readonly pending: MessageEvent<unknown>[] = [];
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        this.native = new NativeWorker(scriptURL, options);
        this.native.onmessage = (event) => {
          const type = (event.data as { type?: unknown } | null)?.type;
          if (type === "complete" || type === "failed") this.pending.push(event);
          else this.onmessage?.(event);
        };
        this.native.onmessageerror = (event) => this.onmessageerror?.(event);
        this.native.onerror = (event) => this.onerror?.(event);
        releaseCallbacks.push(() => {
          for (const event of this.pending.splice(0)) this.onmessage?.(event);
        });
      }

      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (transfer === undefined) this.native.postMessage(message);
        else this.native.postMessage(message, transfer);
      }

      terminate(): void {
        this.native.terminate();
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: HeldTerminalWorker });
    (window as Window & { __releaseHeldWorkerEvents?: () => void }).__releaseHeldWorkerEvents = () => {
      for (const release of releaseCallbacks) release();
    };
  });
}
```

- [ ] **Step 4: Extend the image mobile test with processing, result, and privacy assertions**

Import the observer:

```ts
import { installPrivacyObserver } from "./support/privacy-observer";
```

Before navigating in the image watermark mobile test:

```ts
await page.setViewportSize({ width: 390, height: 844 });
await holdTerminalWorkerEvents(page);
const sentinelFilename = "PRIVATE_MOBILE_IMAGE_SENTINEL.png";
const privacy = await installPrivacyObserver(page, {
  sentinels: [sentinelFilename, "PRIVATE_MOBILE_IMAGE_BYTES"],
});
await page.goto("/image/watermark");
await expect(page.getByRole("button", { name: "이미지 선택" })).toBeEnabled();
await privacy.clear();
```

Use the sentinel file:

```ts
await page.locator('input[type="file"][multiple]').setInputFiles({
  name: sentinelFilename,
  mimeType: "image/png",
  buffer: Buffer.concat([onePixelPng, Buffer.from("PRIVATE_MOBILE_IMAGE_BYTES")]),
});
```

After the existing control assertions, run and verify the held processing state, then release it:

```ts
await run.click();
const cancel = page.getByRole("button", { name: "작업 중단" });
await expect(cancel).toBeVisible();
await cancel.scrollIntoViewIfNeeded();
await expect(cancel).toBeInViewport();
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

await page.evaluate(() => {
  (window as Window & { __releaseHeldWorkerEvents?: () => void }).__releaseHeldWorkerEvents?.();
});
await expect(page.getByText("1개 이미지 변환을 완료했어요.")).toBeVisible({ timeout: 20_000 });
const save = page.getByRole("button", { name: "결과 저장·공유 ↓" });
await save.scrollIntoViewIfNeeded();
await expect(save).toBeInViewport();
const observation = await privacy.read();
expect(observation.externalRequests).toEqual([]);
expect(observation.writeRequests).toEqual([]);
expect(observation.consoleMessages.filter((type) => ["error", "assert"].includes(type))).toEqual([]);
await privacy.assertClean(0, false);
```

- [ ] **Step 5: Replace the PDF test's raw request arrays with the shared privacy observer**

In `keeps PDF image conversion ordered, sticky, and touch-safe`, include `browserName` in the test fixture and install the observer before navigation:

```ts
const sentinelFilename = "PRIVATE_MOBILE_PDF_SENTINEL.pdf";
const privacy = await installPrivacyObserver(page, {
  sentinels: [sentinelFilename, "PRIVATE_MOBILE_PDF_BYTES"],
});
await page.goto("/pdf/to-image");
await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({ timeout: 60_000 });
await privacy.clear();
```

Use the sentinel filename and append the sentinel bytes after a valid PDF comment:

```ts
await page.locator("input[type=file]").setInputFiles({
  name: sentinelFilename,
  mimeType: "application/pdf",
  buffer: Buffer.concat([pdf, Buffer.from("\n% PRIVATE_MOBILE_PDF_BYTES")]),
});
```

Keep the existing controlled processing/cancel/result geometry assertions. Replace `requestViolations`, `failedRequests`, `pageErrors`, and `parserWorkerRequests` checks with:

```ts
const observation = await privacy.read();
expect(observation.externalRequests).toEqual([]);
expect(observation.writeRequests).toEqual([]);
expect(observation.consoleMessages.filter((type) => ["error", "assert"].includes(type))).toEqual([]);
await privacy.assertClean(0, browserName !== "firefox");
```

- [ ] **Step 6: Run targeted state and privacy tests across engines**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/discovery.spec.ts --project=chromium --project=firefox --grep "mixed files incrementally|unknown-format correction"
pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "200 percent|key routes bounded"
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "error feedback|image watermark controls|PDF image conversion"
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/discovery-mobile.spec.ts tests/e2e/mobile.spec.ts --project=mobile-webkit --grep "200 percent|key routes bounded|error feedback|image watermark controls|PDF image conversion"
```

Expected: detecting, error/correction, processing, and result states stay reachable without overflow; privacy observations contain no external/write request or error/assert console classification.

- [ ] **Step 7: Commit the state and privacy coverage**

```bash
git add tests/e2e/discovery-mobile.spec.ts tests/e2e/discovery.spec.ts tests/e2e/mobile.spec.ts
git commit -m "test: cover mobile state and privacy regressions"
```

- [ ] **Step 8: Run the complete release gate**

Run:

```bash
pnpm verify
PLAYWRIGHT_WEBKIT=1 pnpm verify:all
```

Expected: Biome, TypeScript, all unit tests, production builds, static-export checks, discovery import/bundle budgets, and every Playwright project pass. No codec test adds a byte-stability assertion.

- [ ] **Step 9: Capture responsive evidence and verify the Git deployment path**

Start the local preview:

```bash
pnpm --filter @hereisit/web preview:test
```

Expected: `http://127.0.0.1:4173` serves the production static export. Capture first-viewport and full-page evidence for `/`, `/tools`, `/image/compress`, and `/pdf/organize` at `320×568`, `390×844`, and desktop `1280×900`; do not include a selected private file or filename in any capture.

Inspect those captures for single-character Korean final lines and clipped focus rings. When a physical
iOS device is available, manually check Safari safe-area insets, Dynamic Type, and browser text zoom;
record Linux Playwright WebKit as cross-engine evidence rather than claiming physical iOS validation.

After review, push the branch, open one focused pull request, and use only the immutable Cloudflare Git preview URL for pre-merge smoke checks. After merge, verify `/`, `/tools`, `/image/compress`, and `/pdf/organize` on `https://hereisit.pages.dev`; do not run a manual Wrangler deployment.
