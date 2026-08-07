# PDF to image workbench simplification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense PDF-to-image dashboard with a local-only, five-stage flow that makes the recommended conversion and explicit download immediately clear.

**Architecture:** Keep `PdfToImageWorkbench` as the sole state owner and derive `select`, `inspecting`, `setup`, `processing`, and `result` from its existing state. Reuse the inspection and conversion Workers, `pdf.to-images@1`, preflight planning, analytics, and download lifecycle; change only route-specific markup, styles, and browser expectations.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, CSS Modules, Vitest 4, Playwright 1.61, existing PDF.js browser runtime.

## Global Constraints

- Files stay in the browser; never log or transmit file contents, filenames, result bytes, thumbnails, or object URLs.
- Preserve `모든 페이지 · JPG · 150DPI · 품질 85`, current output bytes, naming, ZIP order, resource limits, and `pdf.to-images@1`.
- One page downloads as an image; multiple pages download as one ZIP only after an explicit button press.
- Use one primary action per stage, native controls, 44px touch targets, 16px inputs, and no horizontal overflow at 320px.
- Add no dependency, server path, global state, generic phase component, thumbnail, preview, share action, or automatic download.

---

### Task 1: Lock the stage-specific interaction contract

**Files:**
- Modify: `tests/e2e/pdf-to-images.spec.ts`

**Interfaces:**
- Consumes: route `/pdf/to-image`, existing PDF fixtures, `openReadyPdfToImages(page)`.
- Produces: browser expectations for the five visible stages and the exact primary actions used by later tasks.

- [ ] **Step 1: Add the failing stage-flow test**

Add a test near the first conversion case:

```ts
test("shows only the current PDF-to-image stage", async ({ page }) => {
  await openReadyPdfToImages(page);
  await expect(page.getByRole("heading", { name: "PDF를 JPG·PNG로 변환" })).toBeVisible();
  await expect(page.getByText("결과가 여기에 준비돼요")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "출력 형식" })).toHaveCount(0);

  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([{ width: 72, height: 72 }]),
  });
  await expect(page.getByRole("heading", { name: "변환 설정" })).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  await expect(page.getByRole("radio", { name: "JPG" })).toBeChecked();
  await expect(page.getByText("JPG · 150DPI")).toBeVisible();
  await expect(page.getByText("결과가 여기에 준비돼요")).toHaveCount(0);

  await page.getByRole("button", { name: "1페이지 이미지로 변환" }).click();
  await expect(page.getByRole("heading", { name: "변환 완료" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("PDF 1페이지 → 1개 JPG")).toBeVisible();
  await expect(page.getByRole("button", { name: "JPG 다운로드 ↓" })).toBeVisible();
  await expect(page.getByRole("button", { name: "같은 설정으로 다시 실행" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the test and confirm the old dashboard fails it**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts \
  --project=chromium --grep "shows only the current PDF-to-image stage"
```

Expected: FAIL because the initial page exposes the old empty result/dashboard and the new stage headings do not exist.

- [ ] **Step 3: Add a settings helper and update exact action names in existing tests**

Add:

```ts
async function openPdfToImageSettings(page: Page): Promise<void> {
  const settings = page.locator("details").filter({ hasText: "페이지·화질 설정" });
  if (!(await settings.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await settings.locator("summary").click();
  }
}
```

Use the helper before tests change page scope, DPI, or quality. Change expected buttons to:

```ts
page.getByRole("button", { name: /\d+페이지 이미지로 변환/ });
page.getByRole("button", { name: "JPG 다운로드 ↓" });
page.getByRole("button", { name: "PNG 다운로드 ↓" });
page.getByRole("button", { name: "다른 PDF 변환" });
```

Do not weaken MIME, dimensions, ZIP order, privacy, cancellation, progress, or object URL assertions.

- [ ] **Step 4: Commit the red browser contract**

```bash
git add tests/e2e/pdf-to-images.spec.ts
git commit -m "test: define simple PDF image conversion flow"
```

---

### Task 2: Render one stage and one primary action at a time

**Files:**
- Modify: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Create: `apps/web/src/components/pdf-to-image-workbench.module.css`
- Modify: `apps/web/src/components/pdf-workbench.module.css`

**Interfaces:**
- Consumes: existing `file`, `inspection`, `inspecting`, `processing`, `progress`, `result`, `resultUrl`, preflight, cancellation, reset, and download functions.
- Produces: route-local staged markup with the exact accessible names defined in Task 1.

- [ ] **Step 1: Derive the current stage without adding state**

Inside `PdfToImageWorkbench`, derive:

```ts
const screen =
  result !== undefined
    ? "result"
    : processing
      ? "processing"
      : inspecting
        ? "inspecting"
        : file !== undefined && inspection !== undefined
          ? "setup"
          : "select";
```

Import the new route-local module:

```ts
import styles from "./pdf-to-image-workbench.module.css";
```

- [ ] **Step 2: Replace the dashboard with five exclusive sections**

Render exactly one of these headings and primary actions:

```tsx
screen === "select"      // PDF를 JPG·PNG로 변환 / PDF 선택
screen === "inspecting" // 페이지 확인 중 / 중단
screen === "setup"      // 변환 설정 / {n}페이지 이미지로 변환
screen === "processing" // 이미지로 변환하는 중 / 중단
screen === "result"     // 변환 완료 / JPG|PNG|ZIP 다운로드 ↓
```

Keep the native file input mounted and visually hidden so pending-file handoff, replacement, and E2E input selection continue to work. Remove the old English eyebrow, panel numbers, `LOCAL`, file-limit repetition, empty result panel, sticky action bar, duration output, three caveat paragraphs, and rerun button.

- [ ] **Step 3: Keep format visible and move optional controls into native details**

The setup section contains visible `JPG` and `PNG` radios plus:

```tsx
<details className={styles.settings} open={selectionMode === "extract" || dpi !== 150 || quality !== 85}>
  <summary>페이지·화질 설정 · {selectionSummary} · {dpi}DPI</summary>
  {/* existing page scope, range, DPI, and conditional JPG quality controls */}
</details>
```

Do not duplicate the settings state or preflight. PNG hides the quality control. The recommended summary is `JPG · 150DPI`, and the run label has no decorative arrow.

- [ ] **Step 4: Make result copy derive from the existing result**

Use:

```ts
const outputLabel = result?.format === "png" ? "PNG" : "JPG";
const downloadLabel =
  result?.mime === "application/zip" ? "ZIP 다운로드 ↓" : `${outputLabel} 다운로드 ↓`;
```

The result section shows `PDF {sourcePageCount}페이지 → {outputFileCount}개 {outputLabel}`,
`formatBytes(result.byteLength)`, one rasterization warning, the download button, and `다른 PDF 변환`.

- [ ] **Step 5: Add the smallest dedicated responsive styles**

The new CSS module defines only selectors used by the new markup. Use one centered column, native grid/flex layout, existing design tokens, and these hard requirements:

```css
.stage { width: min(100%, 48rem); margin-inline: auto; }
.primaryButton, .secondaryButton, .settings summary { min-height: 2.75rem; }
.rangeField input { min-width: 0; width: 100%; font-size: 1rem; }
@media (max-width: 40rem) { .actions { grid-template-columns: 1fr; } }
```

Delete only selectors proven exclusive to the old PDF-to-image markup from `pdf-workbench.module.css`: `.toImageSettings`, `.twoColumnSegment`, `.qualityGroup`, `.resultCaveats`, and `.toImageActionButtons`. Leave shared PDF selectors untouched.

- [ ] **Step 6: Run the focused test and fix only contract mismatches**

```bash
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts \
  --project=chromium --grep "shows only the current PDF-to-image stage"
```

Expected: PASS.

- [ ] **Step 7: Run formatting, type, and focused unit checks**

```bash
pnpm exec biome check \
  apps/web/src/components/pdf-to-image-workbench.tsx \
  apps/web/src/components/pdf-to-image-workbench.module.css \
  apps/web/src/components/pdf-workbench.module.css \
  tests/e2e/pdf-to-images.spec.ts
pnpm --filter @hereisit/web typecheck
pnpm exec vitest run apps/web/src/lib/tool-implementations.test.ts \
  tests/tool-route-import-boundary.test.ts --testTimeout=15000
```

Expected: all commands exit 0 and 28 focused unit tests pass.

- [ ] **Step 8: Commit the staged workbench**

```bash
git add apps/web/src/components/pdf-to-image-workbench.tsx \
  apps/web/src/components/pdf-to-image-workbench.module.css \
  apps/web/src/components/pdf-workbench.module.css \
  tests/e2e/pdf-to-images.spec.ts
git commit -m "feat: simplify PDF image conversion flow"
```

---

### Task 3: Preserve conversion, lifecycle, privacy, and mobile behavior

**Files:**
- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify if required by a demonstrated failure: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify if required by a demonstrated failure: `apps/web/src/components/pdf-to-image-workbench.module.css`

**Interfaces:**
- Consumes: staged UI from Task 2 and all existing conversion/runtime behavior.
- Produces: full browser evidence that the UI refactor did not change bytes, privacy, cleanup, or accessibility.

- [ ] **Step 1: Update lifecycle tests for the removed rerun action**

Replace the old result-screen settings/rerun sequence with `다른 PDF 변환`, then select the same file again. Preserve exact created/revoked object URL counts at each reset, replacement, rerun-through-new-selection, and unmount boundary.

- [ ] **Step 2: Add a 320px no-overflow assertion**

Add:

```ts
test("keeps the PDF-to-image flow usable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openReadyPdfToImages(page);
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator("input[type=file]").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: await createVectorPdf([{ width: 72, height: 72 }]),
  });
  await expect(page.getByRole("heading", { name: "변환 설정" })).toBeVisible({
    timeout: PDF_INSPECTION_TIMEOUT_MS,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "1페이지 이미지로 변환" })).toHaveCSS(
    "min-height",
    "44px",
  );
});
```

- [ ] **Step 3: Run the full route suite in Chromium**

```bash
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts --project=chromium
```

Expected: all PDF-to-image cases pass with no upload/write request, no Web Share call, correct MIME/dimensions/ZIP order, honest progress, cancellation, download retry, and object URL cleanup.

- [ ] **Step 4: Run the route suite across desktop and mobile engines**

```bash
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts \
  --project=firefox --project=webkit \
  --project=mobile-chromium --project=mobile-firefox --project=mobile-webkit
```

Expected: all supported projects pass; browser codec assertions use signatures, dimensions, and tolerances rather than byte identity.

- [ ] **Step 5: Commit browser and mobile hardening**

```bash
git add tests/e2e/pdf-to-images.spec.ts \
  apps/web/src/components/pdf-to-image-workbench.tsx \
  apps/web/src/components/pdf-to-image-workbench.module.css
git commit -m "test: verify simple PDF image conversion UI"
```

---

### Task 4: Verify and publish the complete change

**Files:**
- Modify only for documented expectation drift: `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: all prior commits.
- Produces: a clean branch, complete repository verification, reviewable PR, and deployment evidence.

- [ ] **Step 1: Check documentation truthfulness**

```bash
rg -n "PDF를 JPG|PDF 이미지|150DPI|100페이지|ZIP" README.md docs/architecture.md
```

Only edit statements made false by the UI change. Do not add a feature tour.

- [ ] **Step 2: Run repository verification**

```bash
pnpm verify
pnpm verify:all
git diff --check
git status --short
```

Expected: lint, types, 2,500+ unit tests, production builds, and all browser projects pass; the tree contains only intentional tracked changes.

- [ ] **Step 3: Commit any required documentation correction**

```bash
git add README.md docs/architecture.md
git diff --cached --quiet || git commit -m "docs: align PDF image conversion flow"
```

- [ ] **Step 4: Push and open a ready-for-review PR**

```bash
git push -u origin docs/pdf-to-image-simplification
gh pr create --base main --head docs/pdf-to-image-simplification \
  --title "Simplify PDF image conversion" \
  --body-file /tmp/hereisit-pdf-to-image-pr.md
```

The PR body must summarize the staged UI, preserved local/runtime behavior, exact test commands, and any environment-only limitation.

- [ ] **Step 5: Finish the authorized release**

Wait for GitHub CI and Cloudflare preview checks. Address only demonstrated failures, squash-merge after all checks pass, verify the `main` CI and Pages deployment, then approve and verify the processing staging and production canary workflows if they are triggered for the same merge commit.
