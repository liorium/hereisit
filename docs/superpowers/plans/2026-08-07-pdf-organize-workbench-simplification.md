# Visual PDF Organizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PDF organizer's three-panel workbench with a staged, local-only thumbnail grid for reordering, rotating, deleting, producing, and downloading a PDF.

**Architecture:** Keep `pdf.organize@1`, the existing page-plan functions, and the final PDF Worker unchanged. Add a small `pdf.thumbnail@1` Worker contract that reuses the installed PDF raster runtime, opens one PDF once, renders one 160px thumbnail at a time, and enforces a 48MiB aggregate thumbnail budget. Move organizer UI out of the shared `PdfWorkbench` into a focused staged component and delete the old organizer branches.

**Tech Stack:** TypeScript 6, React 19, Next.js 16, Web Workers, PDF.js 6.2.108, native `OffscreenCanvas`, Vitest, Playwright, CSS Modules.

## Global Constraints

- Files remain on the device; no source bytes, filenames, thumbnails, or object URLs may be logged or sent over the network.
- Use `pdf.thumbnail@1`; keep the final `pdf.organize@1` output contract and filename behavior unchanged.
- Render thumbnails sequentially with one canvas, a maximum long edge of 160px, and an aggregate encoded-byte ceiling of 48MiB.
- A thumbnail failure degrades only that card to its page-number placeholder; final PDF organization remains usable.
- Show only one of `select`, `inspecting`, `editing`, `processing`, or `result` at a time.
- Keep native buttons and inputs, 44px minimum targets, keyboard alternatives to drag, one `aria-live` region, and a two-column 320px mobile grid without horizontal overflow.
- Do not add dependencies, server APIs, auto-download, sharing, page duplication, crop, undo history, or changes to other PDF tools.
- Browser codec output is not byte-stable; assert dimensions, MIME signatures, warnings, page identity, and tolerances.

---

### Task 1: Bound thumbnail geometry and byte accounting

**Files:**
- Create: `packages/pdf-tool/src/thumbnail-plan.ts`
- Create: `packages/pdf-tool/src/thumbnail-plan.test.ts`
- Modify: `packages/pdf-tool/src/index.ts`

**Interfaces:**
- Produces: `PDF_THUMBNAIL_LONG_EDGE`, `MAX_PDF_THUMBNAIL_TOTAL_BYTES`, `planPdfThumbnailRaster(width, height)`, and `acceptPdfThumbnailBytes(usedBytes, encodedBytes, pageRawByteLimit)`.
- `planPdfThumbnailRaster` returns `{ scale, width, height, rawByteLimit }` and never upscales a source page.
- `acceptPdfThumbnailBytes` returns the new total or `undefined` when a single encoded item exceeds its raw RGBA limit or the aggregate exceeds 48MiB.

- [ ] **Step 1: Write failing geometry and budget tests**

```ts
import { describe, expect, it } from "vitest";
import {
  acceptPdfThumbnailBytes,
  MAX_PDF_THUMBNAIL_TOTAL_BYTES,
  planPdfThumbnailRaster,
} from "./thumbnail-plan";

describe("PDF thumbnail planning", () => {
  it("fits the long edge to 160px without upscaling", () => {
    expect(planPdfThumbnailRaster(612, 792)).toEqual({
      scale: 160 / 792,
      width: 124,
      height: 160,
      rawByteLimit: 124 * 160 * 4,
    });
    expect(planPdfThumbnailRaster(80, 40)).toEqual({
      scale: 1,
      width: 80,
      height: 40,
      rawByteLimit: 80 * 40 * 4,
    });
  });

  it("rejects invalid dimensions and encoded or aggregate overflow", () => {
    expect(() => planPdfThumbnailRaster(0, 10)).toThrow(RangeError);
    expect(acceptPdfThumbnailBytes(0, 101, 100)).toBeUndefined();
    expect(
      acceptPdfThumbnailBytes(MAX_PDF_THUMBNAIL_TOTAL_BYTES - 10, 11, 100),
    ).toBeUndefined();
    expect(acceptPdfThumbnailBytes(10, 20, 100)).toBe(30);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `pnpm exec vitest run packages/pdf-tool/src/thumbnail-plan.test.ts`

Expected: FAIL because `./thumbnail-plan` does not exist.

- [ ] **Step 3: Implement the bounded pure planner**

```ts
export const PDF_THUMBNAIL_LONG_EDGE = 160;
export const MAX_PDF_THUMBNAIL_TOTAL_BYTES = 48 * 1024 * 1024;

export function planPdfThumbnailRaster(width: number, height: number) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("PDF 썸네일 크기는 양수여야 합니다.");
  }
  const scale = Math.min(1, PDF_THUMBNAIL_LONG_EDGE / Math.max(width, height));
  const plannedWidth = Math.max(1, Math.ceil(width * scale));
  const plannedHeight = Math.max(1, Math.ceil(height * scale));
  return {
    scale,
    width: plannedWidth,
    height: plannedHeight,
    rawByteLimit: plannedWidth * plannedHeight * 4,
  } as const;
}

export function acceptPdfThumbnailBytes(
  usedBytes: number,
  encodedBytes: number,
  pageRawByteLimit: number,
): number | undefined {
  if (
    ![usedBytes, encodedBytes, pageRawByteLimit].every(Number.isSafeInteger) ||
    usedBytes < 0 ||
    encodedBytes < 1 ||
    encodedBytes > pageRawByteLimit
  ) return undefined;
  const total = usedBytes + encodedBytes;
  return Number.isSafeInteger(total) && total <= MAX_PDF_THUMBNAIL_TOTAL_BYTES
    ? total
    : undefined;
}
```

Export the module from `packages/pdf-tool/src/index.ts`.

- [ ] **Step 4: Run the focused test and package typecheck**

Run: `pnpm exec vitest run packages/pdf-tool/src/thumbnail-plan.test.ts && pnpm --filter @hereisit/pdf-tool typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the planner**

```bash
git add packages/pdf-tool/src/thumbnail-plan.ts packages/pdf-tool/src/thumbnail-plan.test.ts packages/pdf-tool/src/index.ts
git commit -m "feat: bound PDF thumbnail planning"
```

---

### Task 2: Define the versioned thumbnail Worker contract

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Create: `packages/browser-runtime/src/pdf-thumbnail-contract.test.ts`

**Interfaces:**
- Produces: `PDF_THUMBNAIL_TOOL_ID = "pdf.thumbnail"`, `PDF_THUMBNAIL_TOOL_VERSION = 1`, `PdfThumbnailRunRequest`, `PdfThumbnailUpdate`, `PdfThumbnailProgress`, `PdfThumbnailResult`, `PdfThumbnailWorkerEvent`, `PdfThumbnailJobOutcome`, and `PdfThumbnailJobHandle`.
- A ready update carries only `sourcePage`, dimensions, `image/webp`, and transferable bytes; a failed update carries only `sourcePage`.

- [ ] **Step 1: Write a compile-time and runtime fixture test**

```ts
import { describe, expect, it } from "vitest";
import {
  PDF_THUMBNAIL_TOOL_ID,
  PDF_THUMBNAIL_TOOL_VERSION,
  type PdfThumbnailWorkerEvent,
} from "@hereisit/tool-contracts";

describe("PDF thumbnail contract", () => {
  it("keeps thumbnail payloads free of file identity and URLs", () => {
    const event = {
      protocol: 1,
      type: "thumbnail",
      jobId: "job-1",
      sequence: 0,
      update: {
        status: "ready",
        sourcePage: 1,
        width: 124,
        height: 160,
        mime: "image/webp",
        bytes: new ArrayBuffer(12),
      },
    } satisfies PdfThumbnailWorkerEvent;
    expect(PDF_THUMBNAIL_TOOL_ID).toBe("pdf.thumbnail");
    expect(PDF_THUMBNAIL_TOOL_VERSION).toBe(1);
    expect(event.update).not.toHaveProperty("name");
    expect(event.update).not.toHaveProperty("url");
  });
});
```

- [ ] **Step 2: Run the fixture and confirm missing exports**

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail-contract.test.ts`

Expected: FAIL because the thumbnail contract exports do not exist.

- [ ] **Step 3: Add exact protocol-1 types**

```ts
export const PDF_THUMBNAIL_TOOL_ID = "pdf.thumbnail" as const;
export const PDF_THUMBNAIL_TOOL_VERSION = 1 as const;

export type PdfThumbnailUpdate =
  | {
      status: "ready";
      sourcePage: number;
      width: number;
      height: number;
      mime: "image/webp";
      bytes: ArrayBuffer;
    }
  | { status: "failed"; sourcePage: number };

export interface PdfThumbnailProgress {
  completedPages: number;
  totalPages: number;
  fraction: number;
}

export interface PdfThumbnailResult {
  pageCount: number;
  renderedPageCount: number;
  failedPageCount: number;
  omittedPageCount: number;
}
```

Add a run request with the existing `{ name, mimeHint, byteLength, bytes }` input shape; ready, progress, thumbnail, complete, and failed Worker events; and fulfilled/rejected/cancelled outcome plus `cancel()` handle. Reuse `PdfToolErrorPayload` for terminal failures so existing safe messages and analytics error codes remain valid.

- [ ] **Step 4: Run the contract fixture and typecheck**

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail-contract.test.ts && pnpm --filter @hereisit/tool-contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/tool-contracts/src/index.ts packages/browser-runtime/src/pdf-thumbnail-contract.test.ts
git commit -m "feat: define PDF thumbnail contract"
```

---

### Task 3: Render one bounded thumbnail at a time

**Files:**
- Create: `packages/browser-runtime/src/pdf-thumbnail-pipeline.ts`
- Create: `packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 planning functions and Task 2 thumbnail contract.
- Produces: `runPdfThumbnailPipeline(input, options): Promise<PdfThumbnailResult>` and `toPdfThumbnailErrorPayload(error)`.
- Options are `{ adapter?, signal?, onThumbnail?, onProgress? }`; callbacks cannot change the pipeline outcome.

- [ ] **Step 1: Write failing pipeline tests with the existing fake raster adapter pattern**

Cover these assertions in `pdf-thumbnail-pipeline.test.ts`:

```ts
expect(adapter.openCalls).toBe(1);
expect(adapter.maxActiveCanvases).toBe(1);
expect(updates.map((item) => item.sourcePage)).toEqual([1, 2, 3]);
expect(updates.every((item) => item.status !== "ready" || item.mime === "image/webp")).toBe(true);
expect(result).toEqual({ pageCount: 3, renderedPageCount: 3, failedPageCount: 0, omittedPageCount: 0 });
expect(adapter.closed).toBe(true);
```

Also test a page-level render failure continuing to page 3, budget exhaustion returning omitted pages without another canvas, invalid PDF input rejection, abort closing the session, and callback exceptions being ignored.

- [ ] **Step 2: Run the pipeline tests and confirm the missing module failure**

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts`

Expected: FAIL because `pdf-thumbnail-pipeline.ts` does not exist.

- [ ] **Step 3: Implement sequential rendering on the shared raster session**

The core loop must have this shape:

```ts
const session = await openPdfRasterSession({ bytes: input.bytes }, options);
try {
  for (let sourcePage = 1; sourcePage <= session.pageCount; sourcePage += 1) {
    throwIfAborted(options.signal);
    try {
      const update = await session.withPage(sourcePage, async (page) => {
        const base = page.getViewport({ scale: 1 });
        const plan = planPdfThumbnailRaster(base.width, base.height);
        const viewport = page.getViewport({ scale: plan.scale });
        return await session.withCanvas(plan.width, plan.height, async (canvas) => {
          await session.render(page, canvas, viewport, "#ffffff");
          const blob = await canvas.canvas.convertToBlob({ type: "image/webp", quality: 0.72 });
          const bytes = await blob.arrayBuffer();
          return { plan, bytes };
        });
      });
      // Validate WebP signature, page raw-byte limit, and aggregate budget before emitting.
    } catch (error) {
      // Continue only for a page-local RENDER_FAILED or encode failure.
    }
  }
} finally {
  await session.close();
}
```

Validate `%PDF-` input signature and the existing 1-byte–50MiB limit before opening. Treat password, corrupt input, Worker crash, and cancellation as terminal; convert only page-local render/encode failures to `{ status: "failed", sourcePage }`. Stop cleanly with `omittedPageCount` when `acceptPdfThumbnailBytes` returns `undefined`.

- [ ] **Step 4: Run pipeline, shared raster, and type tests**

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts packages/browser-runtime/src/pdf-raster-runtime.test.ts && pnpm --filter @hereisit/browser-runtime typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the pipeline**

```bash
git add packages/browser-runtime/src/pdf-thumbnail-pipeline.ts packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts
git commit -m "feat: render bounded PDF thumbnails"
```

---

### Task 4: Isolate and validate thumbnail Worker messages

**Files:**
- Create: `packages/browser-runtime/src/pdf-thumbnail.worker.ts`
- Create: `packages/browser-runtime/src/pdf-thumbnail.worker.test.ts`
- Create: `packages/browser-runtime/src/run-pdf-thumbnail-job.ts`
- Create: `packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts`
- Modify: `packages/browser-runtime/src/index.ts`
- Modify: `packages/browser-runtime/package.json`

**Interfaces:**
- Consumes: `runPdfThumbnailPipeline` and Task 2 events.
- Produces: `supportsBrowserPdfThumbnailRuntime()` and `runPdfThumbnailJob(file, { onThumbnail, onProgress }): PdfThumbnailJobHandle` from package export `@hereisit/browser-runtime/pdf-thumbnail`.

- [ ] **Step 1: Write failing Worker boundary tests**

Test that the Worker posts `ready`, rejects the wrong tool/version or malformed input without opening a document, streams monotonically sequenced thumbnail events with transferred buffers, posts one completion, and cancels its controller. Test that the main-thread wrapper ignores wrong protocol/job IDs, duplicate or out-of-order pages, dimensions over 160px, non-WebP bytes, oversized per-page bytes, and cumulative bytes over 48MiB.

Use this successful wrapper assertion:

```ts
const updates: PdfThumbnailUpdate[] = [];
const handle = runPdfThumbnailJob(file, { onThumbnail: (update) => updates.push(update) });
worker.emit(readyEvent);
worker.emit(validPageOneEvent);
worker.emit(validCompleteEvent);
await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: validResult });
expect(updates).toHaveLength(1);
```

- [ ] **Step 2: Run boundary tests and confirm missing modules**

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail.worker.test.ts packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts`

Expected: FAIL because the Worker and wrapper do not exist.

- [ ] **Step 3: Implement the Worker and main-thread decoder**

The Worker must transfer each ready update buffer and never echo its input:

```ts
post(
  { protocol: 1, type: "thumbnail", jobId, sequence, update },
  update.status === "ready" ? [update.bytes] : [],
);
```

The wrapper must read the `File` only after the Worker announces readiness, transfer the source `ArrayBuffer`, validate every untrusted event before invoking callbacks, terminate on completion/failure/cancel/timeout, and use the existing three-minute PDF job timeout. Callback errors must not fail the job.

- [ ] **Step 4: Export and run all thumbnail boundary tests**

Add `"./pdf-thumbnail": "./src/run-pdf-thumbnail-job.ts"` to package exports and export the wrapper from `src/index.ts`.

Run: `pnpm exec vitest run packages/browser-runtime/src/pdf-thumbnail*.test.ts packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts && pnpm --filter @hereisit/browser-runtime typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the Worker boundary**

```bash
git add packages/browser-runtime/src/pdf-thumbnail.worker.ts packages/browser-runtime/src/pdf-thumbnail.worker.test.ts packages/browser-runtime/src/run-pdf-thumbnail-job.ts packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts packages/browser-runtime/src/index.ts packages/browser-runtime/package.json
git commit -m "feat: stream PDF thumbnails safely"
```

---

### Task 5: Replace the organizer with a staged visual workbench

**Files:**
- Create: `apps/web/src/components/pdf-organize-workbench.tsx`
- Create: `apps/web/src/components/pdf-organize-workbench.module.css`
- Modify: `apps/web/src/app/pdf/organize/page.tsx`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Modify: `apps/web/src/lib/tool-implementations.ts`
- Modify: `apps/web/src/lib/tool-implementations.test.ts`
- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `tests/e2e/tool-detail-shells.spec.ts`

**Interfaces:**
- Consumes: `inspectPdfFile`, `runPdfThumbnailJob`, `runPdfJob`, existing page-plan functions, analytics, `downloadUrl`, and `formatBytes`.
- Produces: `<PdfOrganizeWorkbench toolId="pdf.organize" />` with derived stages `select | inspecting | editing | processing | result`.
- Owns and revokes every thumbnail and result object URL; `PdfWorkbench` no longer accepts or renders organizer state.

- [ ] **Step 1: Rewrite organizer E2E expectations first**

In `pdf-tools.spec.ts`, keep the existing no-network and output-byte assertions, but require:

```ts
await expect(page.getByRole("heading", { name: "페이지 순서 정리" })).toBeFocused();
const grid = page.getByRole("list", { name: "PDF 페이지 순서" });
await expect(grid.locator("img")).toHaveCount(3);
const previewSize = await grid.locator("img").first().evaluate((image) => ({
  width: (image as HTMLImageElement).naturalWidth,
  height: (image as HTMLImageElement).naturalHeight,
}));
expect(Math.min(previewSize.width, previewSize.height)).toBeGreaterThan(0);
expect(Math.max(previewSize.width, previewSize.height)).toBeLessThanOrEqual(160);
await page.getByRole("button", { name: "원본 3페이지 위로 이동" }).click();
await page.getByRole("button", { name: "원본 3페이지 시계 방향으로 회전" }).click();
await page.getByRole("button", { name: "원본 2페이지 삭제" }).click();
await page.getByRole("button", { name: "2페이지로 PDF 만들기" }).click();
await expect(page.getByRole("heading", { name: "페이지 정리 완료" })).toBeVisible();
await expect(page.getByText("원본 3페이지 → 결과 2페이지", { exact: true })).toBeVisible();
```

In `mobile.spec.ts`, require two card columns at 320px, 44px controls, no horizontal overflow, keyboard buttons, drag equivalence where supported, processing cancellation returning to editing, and one result download button without a sticky action bar. Update `tool-detail-shells.spec.ts` only for new visible copy while retaining the `편집 작업 공간` region.

- [ ] **Step 2: Run focused E2E and confirm old UI failures**

Run: `pnpm exec playwright test tests/e2e/pdf-tools.spec.ts --project=chromium --grep "reorders, rotates" && pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF organizer"`

Expected: FAIL on missing staged heading, thumbnails, or new result copy.

- [ ] **Step 3: Implement the focused component and lifecycle cleanup**

Use existing state primitives, not a new state library:

```ts
const stage = result
  ? "result"
  : processing
    ? "processing"
    : inspecting
      ? "inspecting"
      : file && pagePlan.length > 0
        ? "editing"
        : "select";
```

After inspection succeeds, set the identity page plan immediately and start the thumbnail job. Store thumbnail records by `sourcePage`; create URLs only for validated ready updates. Centralize cleanup in `clearThumbnails()` and call it from file replacement, reset, inspection cancellation, thumbnail replacement, and unmount. Keep thumbnail failure or budget omission as a one-time non-blocking editing message.

Render only the active stage. In editing, use a native list/grid with cards whose accessible names include result position, source page, and rotation. Apply `transform: rotate(...)` to the image only; page-plan text remains upright. Implement native pointer drag events as a second input path to the same `movePdfPage` update and retain explicit up/down buttons.

For processing, call the unchanged final job:

```ts
runPdfJob([file], {
  version: 1,
  operation: "organize",
  pages: pagePlan.map((page) => ({ ...page })),
}, { onProgress });
```

On success, keep only the byte-free result metadata plus an owned result URL. Report the same accepted/succeeded/failed/cancelled/download analytics events without adding filename, page, size, or thumbnail properties.

- [ ] **Step 4: Delete the old organizer branches**

Point `apps/web/src/app/pdf/organize/page.tsx` to the new component. Remove organizer config, state, inspection, page-plan actions, build-spec branch, render branch, and organizer-only CSS from `PdfWorkbench`; narrow its prop to `Exclude<PdfEditingIntent, "organize">`. Update the organizer default summary to say thumbnails are generated locally instead of describing a page-number list.

- [ ] **Step 5: Style the staged grid and accessibility states**

Use CSS Grid with `grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))` on wide screens and `repeat(2, minmax(0, 1fr))` at 480px and below. Keep 44px native buttons, visible focus, stable thumbnail aspect boxes, `object-fit: contain`, status text independent of color, and no sticky footer. At 320px, assert `document.documentElement.scrollWidth === 320`.

- [ ] **Step 6: Run focused desktop and mobile E2E**

Run: `pnpm exec playwright test tests/e2e/pdf-tools.spec.ts tests/e2e/tool-detail-shells.spec.ts --project=chromium --grep "organize|organizer" && pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --grep "PDF organizer"`

Expected: PASS.

- [ ] **Step 7: Commit the staged workbench**

```bash
git add apps/web/src/app/pdf/organize/page.tsx apps/web/src/components/pdf-organize-workbench.tsx apps/web/src/components/pdf-organize-workbench.module.css apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css apps/web/src/lib/tool-implementations.ts apps/web/src/lib/tool-implementations.test.ts tests/e2e/pdf-tools.spec.ts tests/e2e/mobile.spec.ts tests/e2e/tool-detail-shells.spec.ts
git commit -m "feat: simplify visual PDF organization"
```

---

### Task 6: Verify cross-browser behavior and repository invariants

**Files:**
- Modify only files that fail a required check; do not add abstractions or unrelated cleanup.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a clean branch whose unit, Worker, browser, privacy, accessibility, build, and export checks pass.

- [ ] **Step 1: Run formatting, types, and focused unit tests**

Run:

```bash
pnpm exec biome check packages/pdf-tool/src/thumbnail-plan.ts packages/pdf-tool/src/thumbnail-plan.test.ts packages/tool-contracts/src/index.ts packages/browser-runtime/src/pdf-thumbnail-pipeline.ts packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts packages/browser-runtime/src/pdf-thumbnail.worker.ts packages/browser-runtime/src/pdf-thumbnail.worker.test.ts packages/browser-runtime/src/run-pdf-thumbnail-job.ts packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts apps/web/src/components/pdf-organize-workbench.tsx apps/web/src/components/pdf-organize-workbench.module.css
pnpm typecheck
pnpm exec vitest run packages/pdf-tool/src/thumbnail-plan.test.ts packages/browser-runtime/src/pdf-thumbnail-contract.test.ts packages/browser-runtime/src/pdf-thumbnail-pipeline.test.ts packages/browser-runtime/src/pdf-thumbnail.worker.test.ts packages/browser-runtime/src/run-pdf-thumbnail-job.test.ts packages/browser-runtime/src/pdf-pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all PDF organizer browser profiles**

Run:

```bash
pnpm exec playwright test tests/e2e/pdf-tools.spec.ts tests/e2e/tool-detail-shells.spec.ts --project=chromium --project=firefox --grep "organize|organizer"
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium --project=mobile-firefox --grep "PDF organizer"
PLAYWRIGHT_WEBKIT=1 pnpm exec playwright test tests/e2e/pdf-tools.spec.ts tests/e2e/mobile.spec.ts --project=webkit --project=mobile-webkit --grep "organize|organizer"
```

Expected: PASS in Chromium, Firefox, WebKit, and mobile profiles.

- [ ] **Step 3: Run repository verification**

Run: `pnpm verify:all`

Expected: PASS, including lint, types, unit tests, Worker integration, builds, static export, processing stack, and full browser suite. If the known local container-image storage limit prevents only the image-engine fuzz build, record the exact failure and rely on the same locked CI job; do not weaken or skip the repository check in code.

- [ ] **Step 4: Inspect privacy and diff boundaries**

Run:

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
rg -n "console\.|fetch\(|sendBeacon|filename|thumbnail.*url" apps/web/src/components/pdf-organize-workbench.tsx packages/browser-runtime/src/pdf-thumbnail* packages/browser-runtime/src/run-pdf-thumbnail-job.ts
```

Expected: no logging or network transmission of file identity, bytes, thumbnails, or object URLs; only intentional local object URL handling remains.

- [ ] **Step 5: Commit only verification fixes if needed**

```bash
git add -u
git commit -m "test: verify visual PDF organizer"
```

Skip this commit when all checks already pass and the worktree is clean.
