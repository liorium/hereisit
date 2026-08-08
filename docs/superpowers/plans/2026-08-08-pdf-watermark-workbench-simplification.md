# PDF Watermark Workbench Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing local PDF watermark tool simpler to operate and eliminate its unnecessary full-document copy.

**Architecture:** Keep the versioned contract, Worker boundary, and shared `PdfWorkbench` state. Optimize only the watermark pipeline by editing the loaded document in place, then add watermark-specific stage branches before the existing generic workbench so other PDF tools remain unchanged.

**Tech Stack:** TypeScript 6, React 19, Next.js 16, CSS Modules, `@cantoo/pdf-lib`, Vitest, Playwright

## Global Constraints

- Files remain in the browser and no file content, filename, thumbnail, or object URL is logged.
- No new dependency, server route, protocol version, or watermark output setting.
- Preserve input, memory, page, output, error, cancellation, and download boundaries.
- Keep native form semantics, 44px controls, 16px inputs, keyboard focus, live status, reduced motion, and 320px support.
- Browser codec checks assert behavior and signatures, not byte identity.

---

### Task 1: Remove full-document copying from the watermark pipeline

**Files:**
- Modify: `packages/browser-runtime/src/pdf-pipeline.ts`
- Test: `packages/browser-runtime/src/pdf-pipeline.test.ts`

**Interfaces:**
- Consumes: existing `runPdfPipeline(inputs, spec, options)` and watermark contract
- Produces: the same `PdfPipelineResult`, without calling `PDFDocument.copyPages` for watermark operations

- [ ] **Step 1: Write the failing engine regression test**

Add a real two-page PDF with title `Quarterly report`, spy on `PDFDocument.prototype.copyPages`, run a selected-page watermark with the existing one-pixel renderer, and assert:

```ts
expect(copyPages).not.toHaveBeenCalled();
expect(output.getTitle()).toBe("Quarterly report");
expect(output.getPageCount()).toBe(2);
expect(output.getPage(0).node.Contents()).toBeUndefined();
expect(output.getPage(1).node.Contents()).toBeDefined();
```

- [ ] **Step 2: Run the focused test and confirm the old copy path fails**

Run: `pnpm vitest run packages/browser-runtime/src/pdf-pipeline.test.ts`

Expected: FAIL because `copyPages` is called and the new output document does not retain the source title.

- [ ] **Step 3: Implement the minimum in-place pipeline change**

In `watermarkPdf`, replace the new output document and copied page list with the loaded source and its existing pages:

```ts
const output = source;
const pages = output.getPages();
```

Embed the bitmap in `output`, loop over `pages`, remove `output.addPage(page)`, and retain all existing validation, placement, progress, embedding, save, limit, naming, and warning behavior.

- [ ] **Step 4: Run the engine and geometry tests**

Run: `pnpm vitest run packages/browser-runtime/src/pdf-pipeline.test.ts packages/pdf-tool/src/watermark-layout.test.ts`

Expected: PASS with no `copyPages` call and unchanged placement behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/browser-runtime/src/pdf-pipeline.ts packages/browser-runtime/src/pdf-pipeline.test.ts
git commit -m "perf: avoid copying PDFs for watermarks"
```

### Task 2: Replace the generic three-panel watermark screen with four focused stages

**Files:**
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Test: `tests/e2e/pdf-tools.spec.ts`

**Interfaces:**
- Consumes: existing watermark settings, `startProcessing`, `cancelProcessing`, `downloadResult`, `reset`, range parser, Worker progress, and object URL lifecycle
- Produces: watermark-only select, setup, processing, and result markup while other intents continue through their existing branches

- [ ] **Step 1: Update the browser test to describe the focused user flow**

Change the watermark E2E expectations so they require:

```ts
await expect(page.getByRole("heading", { name: "워터마크 설정" })).toBeVisible();
await expect(page.getByLabel("모양 미리보기")).toContainText("검토용");
await expect(page.getByText("글자 모양 설정")).toBeVisible();
await page.getByRole("button", { name: "워터마크 넣기" }).click();
await expect(page.getByRole("heading", { name: "워터마크 완료" })).toBeVisible();
await expect(page.getByText("전체 2페이지에 적용" )).toBeVisible();
```

Retain output MIME/page assertions, external/write request assertions, selected-page validation, download, and object URL cleanup checks. Update old result and reset labels to `PDF 다운로드 ↓` and `다른 PDF에 넣기`.

- [ ] **Step 2: Run the focused Chromium test and confirm it fails against the generic UI**

Run: `pnpm playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "watermark"`

Expected: FAIL because the focused heading, preview, and result copy do not exist yet.

- [ ] **Step 3: Add the minimum watermark-only render branches**

Derive `watermarkScreen` from existing state and focus a watermark stage heading whenever it changes. Before the generic empty/setup branches, render:

- a compact select card for an empty watermark input;
- a setup card with file summary, text input, placement, page scope, schematic preview, native `details` appearance controls, privacy line, status, and one `워터마크 넣기` button;
- a processing card with phase, honest progress, and `중단`;
- a result card with applied page summary, byte comparison, required warnings, `PDF 다운로드 ↓`, status, and `다른 PDF에 넣기`.

Reuse the current state setters and `clearResult`; do not add a new component, state machine, PDF preview Worker, or dependency.

- [ ] **Step 4: Add responsive and accessible CSS only for the watermark branches**

Use existing ink, panel, line, yellow, muted, and red variables. Keep a two-column setup only when it fits; stack at 800px and below. Hide radio inputs visually only when their labels preserve focus-visible outlines. Use `transform`, `color`, and `opacity` for the schematic watermark preview and disable motion under `prefers-reduced-motion`.

- [ ] **Step 5: Run focused browser tests**

Run: `pnpm playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "watermark"`

Expected: PASS for output, selected-page validation, direct download, object URL cleanup, and no external/write requests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts
git commit -m "refactor: simplify PDF watermark workflow"
```

### Task 3: Verify the release and publish it

**Files:**
- Modify only if formatting reports a safe mechanical change to files already in scope

**Interfaces:**
- Consumes: repository verification commands and existing GitHub/Cloudflare deployment workflow
- Produces: a reviewed, merged, production-verified change

- [ ] **Step 1: Apply repository formatting and inspect the diff**

Run: `pnpm lint:fix`

Then run: `git diff --check && git diff --stat && git status --short`

- [ ] **Step 2: Run focused and full local verification**

Run the engine and watermark browser tests first, then `pnpm verify`. Run `pnpm verify:all` only when local disk and browser prerequisites permit; otherwise use the required CI matrix as authoritative and record the local environmental limit.

- [ ] **Step 3: Commit any in-scope formatting change**

```bash
git add apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css tests/e2e/pdf-tools.spec.ts packages/browser-runtime/src/pdf-pipeline.ts packages/browser-runtime/src/pdf-pipeline.test.ts
git diff --cached --quiet || git commit -m "chore: format PDF watermark changes"
```

- [ ] **Step 4: Push, open a pull request, and wait for required checks**

Push `feat/pdf-watermark-simplification`, open a PR describing the in-place engine optimization and focused UI, monitor all required checks, and fix only reproducible in-scope failures.

- [ ] **Step 5: Merge and verify production**

Merge after required checks pass, confirm the Cloudflare Pages production deployment points to the merge commit, and verify `/pdf/watermark` returns HTTP 200 with the expected title and security headers.
