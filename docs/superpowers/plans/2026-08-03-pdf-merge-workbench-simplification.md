# PDF Merge Workbench Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing local PDF merge tool into a focused select-and-order, processing, and result flow with per-file page counts and direct download.

**Architecture:** Keep `PdfWorkbench` and the existing PDF Workers authoritative. Add merge-only inspection state to each existing work item and let one React effect inspect the first pending PDF; render merge-only stage views while all other PDF intents continue through the current markup.

**Tech Stack:** React 19, Next.js 16, TypeScript 6, CSS Modules, `@cantoo/pdf-lib`, existing browser Web Workers, Playwright 1.61

## Global Constraints

- Files remain on the device; the merge path must make no network request containing file data.
- Keep the existing black, ivory, yellow, and neutral HereIsIt visual language; introduce no blue-led redesign.
- Add no dependency and change no PDF processing contract.
- Keep every interactive target at least 44 CSS pixels on touch screens.
- Do not redesign any non-merge PDF route in this change.
- Do not add compression, page previews, drag sorting, sharing, or server processing.

---

## File map

- Modify `apps/web/src/components/pdf-workbench.tsx`: merge inspection receipts, readiness, stage rendering, cancellation, and result actions.
- Modify `apps/web/src/components/pdf-workbench.module.css`: centered setup, processing, result, ordered rows, and mobile rules.
- Modify `tests/e2e/pdf-tools.spec.ts`: existing merge ordering, privacy, download, and retry tests.
- Modify `tests/e2e/mobile.spec.ts`: existing responsive test suite with PDF merge controls.

No new runtime module, component, dependency, or test file is needed.

### Task 1: Merge inspection and selected-file setup

**Files:**
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Test: `tests/e2e/pdf-tools.spec.ts`

**Interfaces:**
- Consumes: `inspectPdfFile(file: File): PdfInspectionHandle`, existing `PdfWorkItem[]`, and its ordering handlers.
- Produces: `PdfInputInspection` receipts on merge items and `mergeInputsReady: boolean` for the run action.

- [ ] **Step 1: Make the existing merge test demand the simplified inspected setup**

In `tests/e2e/pdf-tools.spec.ts`, update `merges PDFs in the chosen order without external uploads` so
its two fixtures contain one and two pages. Before reordering, assert:

```ts
const selected = page.getByRole("region", { name: "합칠 PDF 순서" });
await expect(selected.getByText("first.pdf", { exact: true })).toBeVisible();
await expect(selected.getByText("1페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
await expect(selected.getByText("second.pdf", { exact: true })).toBeVisible();
await expect(selected.getByText("2페이지", { exact: true })).toBeVisible({ timeout: 20_000 });
await expect(page.getByRole("button", { name: "PDF 합치기" })).toBeEnabled();
await expect(page.getByText("설정", { exact: true })).toHaveCount(0);

await page.getByRole("button", { name: "second.pdf 위로 이동" }).click();
await expect(selected.locator("article").first()).toContainText("second.pdf");
```

Change its fixtures to `createPdf([100])` and `createPdf([200, 200])`. Keep the existing request,
page-error, download-count, output-order, Web Share, and privacy assertions.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm build
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "merges PDFs"
```

Expected: FAIL because the selected-order region, page-count labels, and simplified button label do not
exist.

- [ ] **Step 3: Add merge-only inspection receipts**

In `pdf-workbench.tsx`, extend the existing item without changing non-merge behavior:

```ts
type PdfInputInspection =
  | { status: "pending" }
  | { status: "ready"; pageCount: number }
  | { status: "failed"; message: string };

interface PdfWorkItem {
  id: string;
  file: File;
  inspection?: PdfInputInspection;
}
```

When `addFiles` accepts a merge input, assign `inspection: { status: "pending" }`. Add one effect that
inspects only `items.find(item => item.inspection?.status === "pending")`. It calls `inspectPdfFile`,
replaces only the matching ID's receipt with `ready` or `failed`, updates `itemsRef.current`, and calls
`handle.cancel()` in cleanup. Guard the receipt with a local `active` flag so a removed or reordered
item cannot receive a stale result.

Use the exact state update shape:

```ts
if (outcome.status === "fulfilled") {
  return { ...item, inspection: { status: "ready", pageCount: outcome.value.pageCount } };
}
if (outcome.status === "rejected") {
  return { ...item, inspection: { status: "failed", message: outcome.error.message } };
}
```

Derive readiness rather than adding another state source:

```ts
const mergeInputsReady =
  intent !== "merge" ||
  (items.length >= minFiles &&
    items.every((item) => item.inspection?.status === "ready"));
```

Include `mergeInputsReady` in `canRun`.

- [ ] **Step 4: Render only the merge setup before processing**

Inside the existing `<section className={styles.shell}>`, keep the hidden native file input and add an
`intent === "merge"` branch before the current generic branch.

For zero items, reuse the existing drop handlers but show only `합칠 PDF 선택`,
`PDF · 파일당 50MB · 최대 20개`, and `파일은 업로드하지 않고 이 기기에서 처리해요.`

For selected items, render a region labelled `합칠 PDF 순서` with:

```tsx
<header className={styles.mergeSetupHeader}>
  <div>
    <h2 id="pdf-workbench-title">합칠 PDF 순서</h2>
    <p>{items.length}개 PDF · {formatBytes(totalBytes)}</p>
  </div>
  <div className={styles.mergeHeaderActions}>
    <button type="button" onClick={() => inputRef.current?.click()}>PDF 추가</button>
    <button type="button" onClick={reset}>전체 삭제</button>
  </div>
</header>
```

Each ordered row shows its position, full filename in `title`, byte size, and exactly one inspection
label: `페이지 확인 중`, `N페이지`, or the failure message. Reuse `moveItem` and `removeItem` with buttons
named `${filename} 위로 이동`, `${filename} 아래로 이동`, and `${filename} 제거`.

Finish setup with the local-processing notice and:

```tsx
<button
  className={styles.mergePrimaryAction}
  type="button"
  disabled={!canRun}
  onClick={() => void startProcessing()}
>
  PDF 합치기
</button>
```

- [ ] **Step 5: Add only merge-prefixed setup CSS**

In `pdf-workbench.module.css`, add one centered work area, black primary action, neutral ordered rows,
yellow accent, and 44px square move/remove controls. At `max-width: 640px`, put filename copy on its own
line and controls in a three-column row; do not add horizontal scrolling or sticky actions. Leave every
existing class used by split, organize, watermark, and image-to-PDF unchanged.

- [ ] **Step 6: Verify setup and commit**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "merges PDFs"
pnpm biome check apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
pnpm --filter @hereisit/web typecheck
```

Expected: all commands PASS.

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "Simplify PDF merge setup"
```

### Task 2: Processing, result, and direct download

**Files:**
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Test: `tests/e2e/pdf-tools.spec.ts`

**Interfaces:**
- Consumes: Task 1's inspected ordered items, `runPdfJob`, `PdfPipelineResult`, `downloadUrl`, and existing object URL cleanup.
- Produces: mutually exclusive `PDF 합치는 중` and `PDF 합치기 완료` stages.

- [ ] **Step 1: Update existing result and retry assertions to the approved copy**

In the first merge test, replace the old run/result/download labels with:

```ts
await page.getByRole("button", { name: "PDF 합치기" }).click();
await expect(page.getByRole("heading", { name: "PDF 합치기 완료" })).toBeVisible({ timeout: 20_000 });
await expect(page.getByText("2개 PDF · 3페이지", { exact: true })).toBeVisible();
await expect(page.getByText(/\d+(?:\.\d+)?(?:KB|B) → \d+(?:\.\d+)?(?:KB|B)/)).toBeVisible();
expect(downloadCount).toBe(0);
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.getByRole("button", { name: "결과 PDF 다운로드 ↓" }).click(),
]);
```

Assert the downloaded document has three pages and preserves the reordered widths `[200, 200, 100]`.
Then click `다른 PDF 합치기` and assert `합칠 PDF 선택` returns.

Update `keeps a prepared PDF result retryable when download activation fails` to use `PDF 합치기`,
`PDF 합치기 완료`, and `결과 PDF 다운로드 ↓`. Preserve its blocked activation, visible result,
message, and successful retry assertions.

Add one test for a corrupt selected PDF:

```ts
test("keeps a failed inspection removable and blocks merge", async ({ page }) => {
  await page.goto("/pdf/merge");
  await page.locator("input[type=file]").setInputFiles([
    { name: "valid.pdf", mimeType: "application/pdf", buffer: await createPdf([100]) },
    { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
  ]);
  const selected = page.getByRole("region", { name: "합칠 PDF 순서" });
  await expect(selected).toContainText("broken.pdf");
  await expect(page.getByRole("button", { name: "PDF 합치기" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "broken.pdf 제거" })).toBeEnabled();
});
```

- [ ] **Step 2: Run the result tests and verify they fail on missing stages**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "merges PDFs|retryable|failed inspection"
```

Expected: FAIL on the missing merge-specific processing/result copy while the corrupt-file behavior
reaches its explicit disabled state after Task 1.

- [ ] **Step 3: Render measured processing only**

When `intent === "merge" && processing`, replace setup with a centered section containing:

```tsx
<h2 id="pdf-workbench-title">PDF 합치는 중</h2>
<p>{phaseLabel(phase)}</p>
<div role="progressbar" aria-label="PDF 합치기 진행률" aria-valuemin={0}
  aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
  <span style={{ width: `${Math.round(progress * 100)}%` }} />
</div>
<button type="button" onClick={cancelProcessing}>중단</button>
```

Use only the existing Worker progress. Do not add timers or estimated percentages. Cancellation returns
to setup because it retains `items` and their inspection receipts.

- [ ] **Step 4: Render the result and keep download retryable**

When `intent === "merge" && result !== undefined`, render:

```tsx
<h2 id="pdf-workbench-title">PDF 합치기 완료</h2>
<p>{items.length}개 PDF · {result.outputPageCount}페이지</p>
<strong className={styles.mergeSizeComparison}>
  {formatBytes(totalBytes)} → {formatBytes(result.byteLength)}
</strong>
```

Show the existing signature warning when present. Add one black `결과 PDF 다운로드 ↓` button bound
to `downloadResult`, a nearby live-status line bound to `message`, and a low-emphasis
`다른 PDF 합치기` button bound to `reset`. Do not calculate or display a saving percentage because
merging is not compression. A thrown `downloadUrl` must leave `result` and `resultUrl` intact.

- [ ] **Step 5: Add merge-prefixed processing/result CSS and verify**

Use the same centered column and existing palette. Format byte/page counts with tabular numerals, keep
both actions at least 44px high, and keep the restart action in normal document flow.

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "merges PDFs|retryable|failed inspection"
pnpm exec vitest run packages/browser-runtime/src/run-pdf-inspection-job.test.ts packages/browser-runtime/src/run-pdf-job.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
pnpm biome check apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
pnpm --filter @hereisit/web typecheck
```

Expected: all commands PASS.

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "Focus PDF merge result flow"
```

### Task 3: Mobile and regression verification

**Files:**
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `apps/web/src/components/pdf-workbench.module.css` only if the test finds a concrete merge defect.

**Interfaces:**
- Consumes: Tasks 1 and 2's accessible labels and merge-prefixed responsive rules.
- Produces: an existing-suite guard for target size and horizontal overflow.

- [ ] **Step 1: Add one merge case to the existing mobile suite**

Append this test to `tests/e2e/mobile.spec.ts`, reusing its `PDFDocument` import:

```ts
test("keeps PDF merge controls usable in a narrow viewport", async ({ page }) => {
  const first = await PDFDocument.create();
  first.addPage([200, 300]);
  const second = await PDFDocument.create();
  second.addPage([200, 300]);
  second.addPage([200, 300]);

  await page.goto("/pdf/merge");
  const input = page.locator("input[type=file]");
  await expect(input).toBeEnabled({ timeout: 60_000 });
  await input.setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: Buffer.from(await first.save()) },
    { name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from(await second.save()) },
  ]);
  await expect(page.getByRole("button", { name: "PDF 합치기" })).toBeEnabled({ timeout: 20_000 });

  for (const name of ["second.pdf 위로 이동", "second.pdf 아래로 이동", "second.pdf 제거", "PDF 합치기"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});
```

- [ ] **Step 2: Run mobile verification and fix only observed merge CSS defects**

Run:

```bash
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF merge controls"
```

Expected: PASS. If it fails, change only merge-prefixed rules under `@media (max-width: 640px)`.

- [ ] **Step 3: Run final verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF merge controls"
pnpm exec playwright test tests/e2e/tool-detail-shells.spec.ts --project=chromium
```

Expected: every command PASS and the shell test confirms non-merge PDF pages still render.

- [ ] **Step 4: Preview and commit**

Retain or start the web development server on port 63388:

```bash
pnpm --filter @hereisit/web dev -- --hostname 0.0.0.0 --port 63388
```

Verify `/pdf/merge` at desktop and 390px widths, then commit:

```bash
git add tests/e2e/mobile.spec.ts apps/web/src/components/pdf-workbench.module.css
git commit -m "Verify PDF merge mobile flow"
```
