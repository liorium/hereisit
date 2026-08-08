# PDF Merge and Split Engine Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move PDF merge and split file reads into the Worker and make merge consume one input at a time without changing output behavior.

**Architecture:** Add a versioned `run-files` Worker request for merge and split. Both ArrayBuffer and File paths reuse one lazy merge core; split keeps its sequential writer and drops one redundant ZIP chunk copy.

**Tech Stack:** TypeScript 6, Web Workers, structured-cloneable `File`, `@cantoo/pdf-lib`, fflate, Vitest, Playwright

## Global Constraints

- Files stay on the device; add no network request or server fallback.
- Add no dependency and keep PDF tool and Worker protocol versions at `1`.
- Keep all current input, page, memory and output limits.
- Keep result names, MIME types, warnings and direct-download behavior unchanged.
- Never log file contents, filenames, thumbnails, buffers or object URLs.
- Keep merge page copying sequential and preserve one `copyPages` call per source document.

---

### Task 1: Lazy file pipeline

**Files:**
- Modify: `packages/browser-runtime/src/pdf-pipeline.test.ts`
- Modify: `packages/browser-runtime/src/pdf-pipeline.ts`

**Interfaces:**
- Produces: `PdfPipelineFileInput` with `name`, `mimeHint`, `byteLength`, and `readBytes(): Promise<ArrayBuffer>`.
- Produces: `runPdfFilePipeline(inputs, rawSpec, options): Promise<PdfPipelineResult>` for merge and split.
- Keeps: `runPdfPipeline(inputs, rawSpec, options)` and all existing output contracts.

- [ ] **Step 1: Write the failing merge sequencing test**

Create two real PDFs. Spy on the real `PDFDocument.prototype.copyPages`; the second input's
`readBytes` must throw unless the first copy has completed. Call `runPdfFilePipeline` and assert the
output page widths are in file order.

```ts
let firstCopied = false;
const originalCopyPages = PDFDocument.prototype.copyPages;
const copyPages = vi.spyOn(PDFDocument.prototype, "copyPages").mockImplementation(async function (
  source,
  indices,
) {
  const pages = await originalCopyPages.call(this, source, indices);
  if (!firstCopied) firstCopied = true;
  return pages;
});
const result = await runPdfFilePipeline([
  fileInput("first.pdf", first, async () => first),
  fileInput("second.pdf", second, async () => {
    expect(firstCopied).toBe(true);
    return second;
  }),
], { version: 1, operation: "merge" });
expect((await PDFDocument.load(result.bytes)).getPages().map((page) => page.getWidth()))
  .toEqual([100, 200]);
copyPages.mockRestore();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @hereisit/browser-runtime test -- pdf-pipeline.test.ts
```

Expected: FAIL because `runPdfFilePipeline` and `PdfPipelineFileInput` do not exist.

- [ ] **Step 3: Implement the lazy merge core and file pipeline**

In `pdf-pipeline.ts`:

```ts
export interface PdfPipelineFileInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  readBytes(): Promise<ArrayBuffer>;
}

export async function runPdfFilePipeline(
  inputs: readonly PdfPipelineFileInput[],
  rawSpec: unknown,
  options: PdfPipelineOptions = {},
): Promise<PdfPipelineResult>;
```

Extract merge's existing loop into a core that receives lazy inputs. Validate declared metadata before
reading, validate each returned buffer length, load and copy that source, then advance to the next input.
Make existing ArrayBuffer merge inputs call the same core with `readBytes: async () => input.bytes`.
For split, read the single input in the Worker path and call the existing split implementation with the
same timing, progress and error mapping.

- [ ] **Step 4: Add real split-file and invalid-length tests**

Assert a file-based every-page split opens as a valid ZIP with the existing entry names and one-page
PDFs. Assert a declared/read byte mismatch rejects with the existing `CORRUPT_PDF` read failure.

- [ ] **Step 5: Run focused pipeline tests and verify GREEN**

Run:

```bash
pnpm --filter @hereisit/browser-runtime test -- pdf-pipeline.test.ts
```

Expected: all `pdf-pipeline.test.ts` tests pass with no warnings.

- [ ] **Step 6: Commit the lazy pipeline**

```bash
git add packages/browser-runtime/src/pdf-pipeline.ts packages/browser-runtime/src/pdf-pipeline.test.ts
git commit -m "perf: process PDF inputs incrementally"
```

### Task 2: File-based Worker request

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/browser-runtime/src/run-pdf-job.test.ts`
- Modify: `packages/browser-runtime/src/run-pdf-job.ts`
- Modify: `packages/browser-runtime/src/pdf.worker.ts`

**Interfaces:**
- Consumes: `runPdfFilePipeline` from Task 1.
- Produces: `PdfFileRunRequest` with `type: "run-files"`, merge/split tool and spec, and structured-cloneable file inputs.
- Extends: `PdfWorkerRequest` with `PdfFileRunRequest`; protocol and tool versions remain `1`.

- [ ] **Step 1: Write failing main-thread file-read tests**

Add one merge case and one split case to `run-pdf-job.test.ts`. Use `vi.fn()` for every
`File.arrayBuffer`, invoke `runPdfJob`, and assert:

```ts
expect(arrayBuffer).not.toHaveBeenCalled();
expect(worker.messages).toContainEqual(expect.objectContaining({
  protocol: 1,
  type: "run-files",
  tool: expectedTool,
  inputs: [expect.objectContaining({ file })],
}));
```

The production change caught by these tests is a regression to eager main-thread byte reads.

- [ ] **Step 2: Run the focused job test and verify RED**

Run:

```bash
pnpm --filter @hereisit/browser-runtime test -- run-pdf-job.test.ts
```

Expected: FAIL because merge and split still call `File.arrayBuffer()` and post `type: "run"`.

- [ ] **Step 3: Add the request type and main-thread routing**

Define `PdfFileRunRequest` in tool contracts with only merge/split tool and spec combinations. Extend
`PdfWorkerRequest`. In `runPdfJob`, post `run-files` immediately for merge/split, including matching
file metadata and the `File`; keep the current byte-reading `run` path for the remaining operations.

- [ ] **Step 4: Handle file requests in the Worker**

In `pdf.worker.ts`, reject a `run-files` request unless its tool/spec pair is merge or split. Validate
that every cloned `File` matches the declared name, type and size, wrap it as `PdfPipelineFileInput`,
and call `runPdfFilePipeline`. Preserve the existing progress, cancellation, completion transfer and
error mapping paths.

- [ ] **Step 5: Run contracts and Worker job tests and verify GREEN**

Run:

```bash
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/browser-runtime test -- run-pdf-job.test.ts pdf-pipeline.test.ts
```

Expected: typecheck and all focused tests pass.

- [ ] **Step 6: Commit Worker routing**

```bash
git add packages/tool-contracts/src/index.ts packages/browser-runtime/src/run-pdf-job.ts packages/browser-runtime/src/run-pdf-job.test.ts packages/browser-runtime/src/pdf.worker.ts
git commit -m "perf: read merge and split files in the worker"
```

### Task 3: Remove the redundant split ZIP chunk copy

**Files:**
- Modify: `packages/browser-runtime/src/pdf-pipeline.ts`
- Test: `packages/browser-runtime/src/pdf-pipeline.test.ts`

**Interfaces:**
- Keeps the existing `PdfPipelineResult.bytes: ArrayBuffer` and ZIP entry contract.

- [ ] **Step 1: Apply the one-line ownership fix**

Replace `chunks.push(chunk.slice())` with `chunks.push(chunk)`. fflate emits owned output chunks and
the existing final join remains the single required contiguous result copy.

- [ ] **Step 2: Verify real ZIP behavior**

Run:

```bash
pnpm --filter @hereisit/browser-runtime test -- pdf-pipeline.test.ts
```

Expected: the existing real ZIP extraction test and new file-based split test pass. This trivial
ownership change adds no implementation-only test.

- [ ] **Step 3: Commit the ZIP copy reduction**

```bash
git add packages/browser-runtime/src/pdf-pipeline.ts
git commit -m "perf: retain split ZIP chunks without copying"
```

### Task 4: Full verification and publication

**Files:**
- Test: `tests/e2e/pdf-tools.spec.ts`
- Test: `tests/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes the existing merge and split UI; no selector or visible-copy change is expected.

- [ ] **Step 1: Run formatting, types, units and production builds**

Run:

```bash
pnpm verify
```

Expected: lint, typecheck, all unit tests and production builds pass.

- [ ] **Step 2: Run the complete browser suite**

Run:

```bash
pnpm verify:all
```

Expected: Chromium, Firefox, WebKit and mobile projects pass merge and split through the real Worker.

- [ ] **Step 3: Inspect the final diff and dependency state**

Run:

```bash
git diff origin/main...HEAD --check
git status --short
git diff origin/main...HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml
```

Expected: no whitespace errors, clean worktree, and no dependency changes.

- [ ] **Step 4: Push, open a ready PR and wait for required checks**

Push `perf/pdf-merge-split-engine`, create a PR against `main`, and require CI plus Cloudflare Pages
preview success. The user has authorized integration for this selected task.

- [ ] **Step 5: Squash merge and verify production**

After required checks pass, squash merge without deleting the checked-out branch. Confirm the
Cloudflare Pages check targets the merge commit, then verify:

```bash
curl -fsSIL https://hereisit.pages.dev/pdf/merge
curl -fsSIL https://hereisit.pages.dev/pdf/split
```

Expected: HTTP 200 with the existing security headers on both routes.
