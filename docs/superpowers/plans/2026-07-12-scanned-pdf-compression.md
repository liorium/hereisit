# Scanned PDF Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready, local-only `/pdf/compress` tool that reconstructs scan-like PDFs with fixed JPEG presets, offers only results at least 1% smaller than the source, deploys through the existing GitHub/Cloudflare gates, and then performs a fresh next-feature priority review.

**Architecture:** Add an independent `pdf.compress-scanned@1` contract, shared pure raster-allocation helpers, and a neutral PDF.js raster runtime extracted from the existing PDF-to-image pipeline. A dedicated compression Worker performs an authoritative PDF.js viewport planning pass, renders exactly one page at a time, embeds each fixed-quality JPEG into a same-visible-size `@cantoo/pdf-lib` page, serializes one candidate, and returns it only after the strict smaller-only postcondition passes. A route-owned React workbench uses existing advisory inspection but keeps the compression Worker, result Blob, and object URL isolated to `/pdf/compress`.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, Zod 4, Vitest 4, Playwright 1.61, PDF.js `6.1.200`, `@cantoo/pdf-lib` `2.7.1`, Cloudflare Pages, GitHub Actions.

## File Structure

- `packages/tool-contracts/src/index.ts` — the independent public spec/result/error/progress/Worker protocol; no implementation.
- `packages/pdf-tool/src/raster-plan.ts` — shared point-to-integer-pixel allocation plus existing PDF-to-image planning compatibility.
- `packages/pdf-tool/src/compress-scanned-plan.ts` — fixed preset resolution, authoritative whole-job page plan, and exact smaller-only target.
- `packages/pdf-tool/src/file-format.ts` — bounded PDF header and terminal EOF envelope checks.
- `packages/pdf-tool/src/naming.ts` — source-relative safe compressed PDF name.
- `packages/browser-runtime/src/pdf-raster-runtime.ts` — internal PDF.js/parser Worker/session/canvas ownership shared by raster consumers.
- `packages/browser-runtime/src/pdf-to-images-pipeline.ts` — existing image/ZIP-specific behavior layered on the shared raster runtime.
- `packages/browser-runtime/src/pdf-compress-scanned-pipeline.ts` — compression validation, planning, render/encode/embed/serialize flow, and error mapping.
- `packages/browser-runtime/src/pdf-compress-scanned.worker.ts` — one active job, capability readiness, untrusted request parsing, progress and transfer.
- `packages/browser-runtime/src/run-pdf-compress-scanned-job.ts` — public File read, hostile event decoder, watchdog, cancellation, and result validation.
- `apps/web/src/components/pdf-compress-workbench.tsx` — route-owned React state, advisory inspection, preset controls, progress, result and save/share lifecycle.
- `apps/web/src/app/pdf/compress/page.tsx` and `apps/web/src/lib/site.ts` — route, metadata, navigation, related tools, and explicit intent classification.
- `tests/e2e/pdf-compression.spec.ts` — actual browser codec/output, smaller-only, privacy, lifecycle, and no-reduction proof.
- `scripts/verify-static-export.mjs` — explicit route closure and Worker/PDF.js isolation proof.
- `scripts/smoke-pdf-compress.mjs` — local/production balanced, minimum, no-reduction, asset/header, geometry, and privacy proof.
- `README.md`, `docs/architecture.md`, and `docs/deployment.md` — truthful scope, loss, limits, and release operation.

Each new production module has a same-directory Vitest file. Existing PDF-to-image tests stay in place as
the refactor regression gate; route/mobile/static tests remain in their established shared files.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-07-12-scanned-pdf-compression-design.md`; implementation tasks must not modify that file.
- Accept any supported PDF without scan detection, but name the tool **스캔 PDF 용량 줄이기** and show the destructive rasterization warning before and after processing.
- Keep source bytes and filenames inside the tab and its Workers. Never log filenames, bytes, page text, thumbnails, internal PDF objects, object URLs, or asset URLs.
- Do not add a dependency, CDN, network URL input, server fallback, main-thread renderer, WASM decoder, OCR, thumbnail, adaptive quality search, selected-page mode, automatic preset fallback, partial result, or automatic download.
- Keep `pdf.pipeline@1`, `pdf.to-images@1`, existing PDF editing behavior, and existing image tools unchanged except for the explicit shared-raster refactor and readiness stabilization covered by regression tests.
- Fixed presets are exactly `balanced = 150DPI/JPEG quality 72/#ffffff` and `minimum = 96DPI/JPEG quality 55/#ffffff`; callers cannot override resolved settings.
- Input is exactly one PDF from 1 byte through 50MiB. Every page is included, with 1–100 source/output pages.
- Enforce 8,192px per side, 16,000,000 pixels and 64,000,000 RGBA bytes per page, 100,000,000 job pixels, a 128MiB HereIsIt-managed active canvas budget, cumulative JPEG bytes no larger than the smaller-only target, and a 180-second public watchdog.
- The authoritative visible page geometry is the rotated scale-1 PDF.js viewport, including CropBox and UserUnit. Preserve those point dimensions exactly; round only raster canvas pixels upward.
- The existing pdf-lib inspection dimensions are advisory and must never hard-reject compression geometry. The compression Worker builds and validates the authoritative whole-document plan before its first canvas allocation.
- The exact smaller-only formula is `requiredSaving = max(1, ceil(sourceBytes / 100))` and `targetBytes = sourceBytes - requiredSaving`. A fulfilled candidate must be `<= targetBytes`; otherwise return non-retryable `NO_SIZE_REDUCTION` with no Blob or download action.
- Render concurrency is exactly one. Every page, canvas, render task, parser Worker, loading task, PDF document, JPEG reference, candidate buffer, public Worker, result URL, and pending share action needs an explicit success/failure/cancel cleanup path.
- PDF.js API, parser Worker, CMaps, and standard fonts stay pinned to `6.1.200` and same-origin. Keep `useWasm: false`, parser OffscreenCanvas/ImageDecoder disabled, the per-image 16MP parser gate, and CSP without `unsafe-eval` or `wasm-unsafe-eval`.
- Be explicit that PDF.js parser arrays and pdf-lib/JS overhead are outside the managed 128MiB canvas budget; do not claim a hard whole-process RSS ceiling.
- Release browsers are current Chromium, Firefox, desktop WebKit, mobile Chromium, and mobile WebKit. The exact release SHA must pass without a Playwright `flaky` retry before publication is called complete.
- Use red-green-refactor for production behavior, keep local task checkpoints unpublished, and squash them with the approved design/plan commits into one final release commit from baseline `51acfda`.

**User-approved brand correction (2026-07-12):** The exact display brand is `HereIsIt`; this pre-release
correction fixes the previously transposed display token across UI, metadata, tests, and documentation. The
lowercase `hereisit` repository, domain, package, download, Worker, test, file, branch, and worktree identifiers
remain unchanged, as does the `hereisit.pages.dev` origin. The internal canvas-memory marker is `HEREISIT`.
The approved design may differ from commit `70fd61d` only by the same exact display-token correction in its
three occurrences; Task 11 constructs that corrected reference from the committed original and compares bytes.

## Execution Precondition

This planning turn must track and commit this exact file before Task 1 begins:

```bash
git add docs/superpowers/plans/2026-07-12-scanned-pdf-compression.md
git diff --cached --check
git commit -m "docs: plan scanned PDF compression"
git ls-files --error-unmatch docs/superpowers/plans/2026-07-12-scanned-pdf-compression.md
```

Task 1 must not start from an untracked or merely staged plan. The plan checkpoint stays local until Task
11 squashes it with the approved design and implementation into the single release commit.

---

### Task 1: Stabilize PDF inspection readiness and the prior WebKit race

**Files:**
- Modify: `packages/browser-runtime/src/run-pdf-job.test.ts`
- Modify: `packages/browser-runtime/src/run-pdf-job.ts`
- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `scripts/smoke-pdf-to-images.mjs`

**Interfaces:**
- Keeps `inspectPdfFile(file: File): PdfInspectionHandle` unchanged.
- Changes its lifecycle so `file.arrayBuffer()` starts once, only after the existing inspection Worker emits a valid protocol-1 `ready` event.
- Adds a browser-test helper that waits for the enabled `PDF 선택` control before programmatic file selection.

- [ ] **Step 1: Write failing inspection readiness tests**

Import `inspectPdfFile` and add an inspection result fixture in `run-pdf-job.test.ts`:

```ts
function inspectionResult() {
  return {
    pageCount: 1,
    pages: [{ sourcePage: 1, width: 72, height: 72, rotation: 0 }],
  };
}

it("waits for inspection Worker readiness before reading the file", async () => {
  installWorker();
  const arrayBuffer = vi.fn(async () => Uint8Array.of(1).buffer);
  const handle = inspectPdfFile({
    name: "report.pdf",
    type: "application/pdf",
    size: 1,
    arrayBuffer,
  } as unknown as File);
  const worker = SilentWorker.latest as SilentWorker;

  await Promise.resolve();
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(worker.messages).toEqual([]);

  worker.emit({
    protocol: 1,
    type: "ready",
    capabilities: {
      operations: ["pdf.merge", "pdf.split", "pdf.images-to-pdf", "pdf.organize", "pdf.watermark"],
    },
  });
  await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
  const request = worker.messages.find((message) => message.type === "inspect");
  expect(request).toBeDefined();

  worker.emit({
    protocol: 1,
    type: "inspected",
    jobId: request?.jobId ?? "missing",
    result: inspectionResult(),
  });
  await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: inspectionResult() });
});

it("cancels inspection before readiness without reading the file", async () => {
  installWorker();
  const arrayBuffer = vi.fn(async () => Uint8Array.of(1).buffer);
  const handle = inspectPdfFile({
    name: "report.pdf",
    type: "application/pdf",
    size: 1,
    arrayBuffer,
  } as unknown as File);
  const worker = SilentWorker.latest as SilentWorker;

  handle.cancel();
  worker.emit({
    protocol: 1,
    type: "ready",
    capabilities: {
      operations: ["pdf.merge", "pdf.split", "pdf.images-to-pdf", "pdf.organize", "pdf.watermark"],
    },
  });

  await expect(handle.result).resolves.toEqual({ status: "cancelled" });
  expect(arrayBuffer).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused unit test and verify red**

```bash
pnpm test packages/browser-runtime/src/run-pdf-job.test.ts
```

Expected: the first test fails because inspection currently reads immediately, before `ready`.

- [ ] **Step 3: Gate inspection file reading on the Worker ready event**

In `inspectPdfFile`, introduce a once-only reader and call it only from the ready branch:

```ts
let readStarted = false;

const beginFileRead = () => {
  if (readStarted || settled || cancelled || worker === undefined) return;
  readStarted = true;
  void (async () => {
    try {
      const bytes = await file.arrayBuffer();
      if (cancelled || settled) return;
      const input: PdfInspectRequest["input"] = {
        name: file.name,
        mimeHint: file.type,
        byteLength: file.size,
        bytes,
      };
      const request: PdfInspectRequest = {
        protocol: WORKER_PROTOCOL_VERSION,
        type: "inspect",
        jobId,
        input,
      };
      worker?.postMessage(request, [bytes]);
    } catch {
      reject({
        code: "CORRUPT_PDF",
        message: "선택한 PDF 파일을 읽지 못했어요.",
        retryable: true,
      });
    }
  })();
};
```

Handle `event.type === "ready"` with `beginFileRead(); return;`, remove the old immediate read IIFE, and keep the watchdog starting from public handle creation.

- [ ] **Step 4: Synchronize browser uploads with the real enabled control**

Add and use this helper before every PDF-to-image `setInputFiles()` call:

```ts
async function openReadyPdfToImages(page: Page): Promise<void> {
  await page.goto(PDF_TO_IMAGES_ROUTE);
  await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled({
    timeout: 60_000,
  });
}
```

Make `prepareSinglePageResult()` call the helper instead of a bare `page.goto()`. Replace the suite's 20-second inspection waits with a named `PDF_INSPECTION_TIMEOUT_MS = 60_000`. Apply the same 60-second inspection timeout to `waitForInspection()` in the tracked smoke script. Do not add Playwright retries or sleeps.

- [ ] **Step 5: Run regression tests**

```bash
pnpm test packages/browser-runtime/src/run-pdf-job.test.ts
pnpm build
pnpm exec playwright test tests/e2e/pdf-to-images.spec.ts --project=chromium --grep "ignores a fulfilled share"
```

Expected: unit tests pass; the focused share/reset test passes without retry. If local WebKit dependencies exist, also run the exact previous failure ten times with `--repeat-each=10 --retries=0`; otherwise record the environment limitation and require the final exact-SHA CI proof.

- [ ] **Step 6: Commit the independently reviewed stabilization**

```bash
git add packages/browser-runtime/src/run-pdf-job.ts packages/browser-runtime/src/run-pdf-job.test.ts tests/e2e/pdf-to-images.spec.ts scripts/smoke-pdf-to-images.mjs
git commit -m "fix: stabilize PDF inspection readiness"
```

---

### Task 2: Add the independent `pdf.compress-scanned@1` contract

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/src/index.test.ts`

**Interfaces:**
- Produces `PDF_COMPRESS_SCANNED_TOOL_ID`, `PDF_COMPRESS_SCANNED_TOOL_VERSION`, `pdfCompressScannedSpecSchema`, fixed preset/result/error/progress types, and dedicated run/cancel/Worker/job types.
- Does not widen `PdfToolId`, `pdfPipelineSpecSchema`, `PdfWorkerRequest`, `PdfPipelineResult`, or any existing PDF protocol.

- [ ] **Step 1: Write failing strict-contract tests**

Add a `describe("pdfCompressScannedSpecSchema", ...)` block:

```ts
it("publishes the independent scanned compression identity", () => {
  expect(PDF_COMPRESS_SCANNED_TOOL_ID).toBe("pdf.compress-scanned");
  expect(PDF_COMPRESS_SCANNED_TOOL_VERSION).toBe(1);
});

it.each(["balanced", "minimum"])("accepts the %s preset", (preset) => {
  expect(pdfCompressScannedSpecSchema.safeParse({ version: 1, preset }).success).toBe(true);
});

it.each([
  {},
  { version: 0, preset: "balanced" },
  { version: 2, preset: "balanced" },
  { version: 1 },
  { version: 1, preset: "adaptive" },
  { version: 1, preset: 96 },
  { version: 1, preset: "balanced", dpi: 96 },
  { version: 1, preset: "balanced", quality: 20 },
  { version: 1, preset: "balanced", background: "#000000" },
])("rejects caller-controlled or invalid settings %#", (value) => {
  expect(pdfCompressScannedSpecSchema.safeParse(value).success).toBe(false);
});
```

- [ ] **Step 2: Run the focused contract test and verify red**

```bash
pnpm test packages/tool-contracts/src/index.test.ts
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the strict schema and exact protocol surface**

Add:

```ts
export const PDF_COMPRESS_SCANNED_TOOL_ID = "pdf.compress-scanned" as const;
export const PDF_COMPRESS_SCANNED_TOOL_VERSION = 1 as const;

export const pdfCompressScannedSpecSchema = z
  .object({
    version: z.literal(1),
    preset: z.enum(["balanced", "minimum"]),
  })
  .strict();

export type PdfCompressScannedPreset = "balanced" | "minimum";
export type PdfCompressScannedSpecV1 = z.input<typeof pdfCompressScannedSpecSchema>;
export type ParsedPdfCompressScannedSpecV1 = z.output<typeof pdfCompressScannedSpecSchema>;
```

Add the full result, warning, error, progress, and lifecycle surface:

```ts
export type PdfCompressScannedWarning =
  | "PDF_PAGES_RASTERIZED"
  | "SEARCHABLE_CONTENT_REMOVED"
  | "INTERACTIVE_CONTENT_REMOVED"
  | "SIGNATURES_INVALIDATED"
  | "COLOR_PROFILE_NORMALIZED";

export interface PdfCompressScannedResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "application/pdf";
  sourceByteLength: number;
  byteLength: number;
  pageCount: number;
  preset: PdfCompressScannedPreset;
  dpi: 96 | 150;
  quality: 55 | 72;
  warnings: PdfCompressScannedWarning[];
  timing: {
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    assembleMs: number;
    serializeMs: number;
    totalMs: number;
  };
}

export type PdfCompressScannedErrorCode =
  | "INVALID_SPEC"
  | "UNSUPPORTED_BROWSER"
  | "UNSUPPORTED_INPUT"
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "PAGE_LIMIT"
  | "MEMORY_LIMIT"
  | "RENDER_FAILED"
  | "ENCODE_FAILED"
  | "ASSEMBLY_FAILED"
  | "NO_SIZE_REDUCTION"
  | "WORKER_CRASH";

export interface PdfCompressScannedErrorPayload {
  code: PdfCompressScannedErrorCode;
  message: string;
  retryable: boolean;
}

export type PdfCompressScannedProgress =
  | {
      phase: "rendering" | "encoding" | "assembling";
      fraction: number;
      completedPages: number;
      totalPages: number;
    }
  | {
      phase: "validating" | "loading" | "serializing" | "finalizing";
      fraction: number;
    };

export interface PdfCompressScannedRunRequest {
  protocol: 1;
  type: "run";
  jobId: string;
  tool: "pdf.compress-scanned";
  toolVersion: 1;
  input: {
    name: string;
    mimeHint: string;
    byteLength: number;
    bytes: ArrayBuffer;
  };
  spec: PdfCompressScannedSpecV1;
}

export interface PdfCompressScannedCancelRequest {
  protocol: 1;
  type: "cancel";
  jobId: string;
}

export type PdfCompressScannedWorkerRequest =
  | PdfCompressScannedRunRequest
  | PdfCompressScannedCancelRequest;

export type PdfCompressScannedWorkerEvent =
  | {
      protocol: 1;
      type: "ready";
      capabilities: {
        offscreenCanvas: boolean;
        jpegEncoder: boolean;
        pdfjsWorker: boolean;
        pdfAssembly: boolean;
      };
      error: PdfCompressScannedErrorPayload | null;
    }
  | (PdfCompressScannedProgress & {
      protocol: 1;
      type: "progress";
      jobId: string;
      sequence: number;
    })
  | {
      protocol: 1;
      type: "complete";
      jobId: string;
      result: PdfCompressScannedResult;
    }
  | {
      protocol: 1;
      type: "failed";
      jobId: string;
      error: PdfCompressScannedErrorPayload;
    };

export type PdfCompressScannedJobOutcome =
  | { status: "fulfilled"; value: PdfCompressScannedResult }
  | { status: "rejected"; error: PdfCompressScannedErrorPayload }
  | { status: "cancelled" };

export interface PdfCompressScannedJobHandle {
  result: Promise<PdfCompressScannedJobOutcome>;
  cancel(): void;
}
```

Successful readiness requires all four booleans `true` and `error: null`. A missing browser capability
uses a non-retryable `UNSUPPORTED_BROWSER` payload; parser/PDF.js or assembly probe failure uses a
retryable `WORKER_CRASH` payload. This lets the public job reject accurately before reading the file.

`NO_SIZE_REDUCTION` remains a non-retryable rejected outcome, while cancellation remains
`{ status: "cancelled" }`.

- [ ] **Step 4: Format, test, and typecheck the contract**

```bash
pnpm exec biome check --write packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts
pnpm test packages/tool-contracts/src/index.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 5: Commit the contract checkpoint**

```bash
git add packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts
git commit -m "feat: add scanned PDF compression contract"
```

---

### Task 3: Extract shared PDF raster allocation without changing PDF-to-image behavior

**Files:**
- Modify: `packages/pdf-tool/src/raster-plan.ts`
- Modify: `packages/pdf-tool/src/raster-plan.test.ts`

**Interfaces:**
- Produces `PdfRasterVisibleSize`, `PdfRasterAllocation`, `PdfRasterAllocationError`, `calculatePdfRasterDimensions()`, and `calculatePdfRasterAllocation()`.
- Keeps every current `MAX_PDF_TO_IMAGE_*`, `calculatePdfToImage*`, and `planPdfToImagesRasterization()` export and behavior compatible.

- [ ] **Step 1: Write failing shared-allocation tests**

```ts
expect(calculatePdfRasterDimensions({ widthPoints: 6_144, heightPoints: 72 }, 96))
  .toEqual({ width: 8_192, height: 96 });
expect(() =>
  calculatePdfRasterAllocation({ widthPoints: 6_144.75, heightPoints: 72 }, 96),
).toThrowError(PdfRasterAllocationError);

expect(calculatePdfRasterAllocation({ widthPoints: 3_000, heightPoints: 3_000 }, 96))
  .toMatchObject({ width: 4_000, height: 4_000, pixels: 16_000_000, rgbaBytes: 64_000_000 });
expect(() =>
  calculatePdfRasterAllocation({ widthPoints: 3_000, heightPoints: 3_000.75 }, 96),
).toThrowError(PdfRasterAllocationError);
```

Also reject NaN, Infinity, zero/negative points, fractional/zero/negative DPI, and preserve all existing quarter-turn, fractional-point, 100MP, page-order, and inspection-consistency tests.

- [ ] **Step 2: Run the raster test and verify red**

```bash
pnpm test packages/pdf-tool/src/raster-plan.test.ts
```

Expected: FAIL because the generic allocation exports do not exist.

- [ ] **Step 3: Implement the common allocation surface and delegate existing helpers to it**

Add:

```ts
export const MAX_PDF_RASTER_DIMENSION = 8_192;
export const MAX_PDF_RASTER_PAGE_PIXELS = 16_000_000;
export const PDF_RASTER_RGBA_BYTES_PER_PIXEL = 4;

export interface PdfRasterVisibleSize {
  widthPoints: number;
  heightPoints: number;
}

export interface PdfRasterAllocation {
  width: number;
  height: number;
  pixels: number;
  rgbaBytes: number;
}

export class PdfRasterAllocationError extends Error {
  constructor(
    readonly reason: "INVALID_GEOMETRY" | "SIDE_LIMIT" | "PAGE_PIXEL_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "PdfRasterAllocationError";
  }
}
```

`calculatePdfRasterDimensions()` must use `Math.ceil((points * dpi) / 72)` after finite/positive/integer-DPI validation. `calculatePdfRasterAllocation()` must enforce the side and 16MP limits and return exact RGBA bytes. Keep existing constants as aliases and map `PdfRasterAllocationError` back to the current Korean `PdfToImagesPlanError` messages so no existing caller or test changes semantics.

- [ ] **Step 4: Run focused and package verification**

```bash
pnpm test packages/pdf-tool/src/raster-plan.test.ts
pnpm --filter @hereisit/pdf-tool typecheck
```

Expected: new allocation tests and all PDF-to-image planning regressions pass.

- [ ] **Step 5: Commit the behavior-preserving extraction**

```bash
git add packages/pdf-tool/src/raster-plan.ts packages/pdf-tool/src/raster-plan.test.ts
git commit -m "refactor: share PDF raster allocation"
```

---

### Task 4: Add the pure scanned-compression plan, name, and PDF envelope checks

**Files:**
- Create: `packages/pdf-tool/src/compress-scanned-plan.ts`
- Create: `packages/pdf-tool/src/compress-scanned-plan.test.ts`
- Modify: `packages/pdf-tool/src/naming.ts`
- Modify: `packages/pdf-tool/src/naming.test.ts`
- Modify: `packages/pdf-tool/src/file-format.ts`
- Modify: `packages/pdf-tool/src/file-format.test.ts`
- Modify: `packages/pdf-tool/src/index.ts`

**Interfaces:**
- Produces exact preset resolution, authoritative visible-page plans, the 100MP whole-job gate, strict source-relative target calculation, `compressedPdfName()`, and `hasCompletePdfEnvelope()`.
- Consumes the shared allocation API from Task 3 and `PdfCompressScannedPreset` from Task 2.

- [ ] **Step 1: Write failing preset, plan, target, name, and envelope tests**

Lock these examples:

```ts
expect(resolvePdfCompressScannedPreset("balanced")).toEqual({
  preset: "balanced", dpi: 150, quality: 72, background: "#ffffff",
});
expect(resolvePdfCompressScannedPreset("minimum")).toEqual({
  preset: "minimum", dpi: 96, quality: 55, background: "#ffffff",
});

const rotated = planPdfCompressScannedRasterization(
  [{ widthPoints: 792, heightPoints: 612 }],
  "balanced",
);
expect(rotated.pages[0]).toMatchObject({
  sourcePage: 1,
  widthPoints: 792,
  heightPoints: 612,
  width: 1_650,
  height: 1_275,
});

const fractional = planPdfCompressScannedRasterization(
  [{ widthPoints: 144.25, heightPoints: 72.5 }],
  "balanced",
);
expect(fractional.pages[0]).toMatchObject({
  widthPoints: 144.25,
  heightPoints: 72.5,
  width: 301,
  height: 152,
});

expect(calculatePdfCompressScannedTarget(101)).toEqual({
  requiredSaving: 2,
  targetBytes: 99,
});
expect(compressedPdfName("../report.pdf")).toBe("report-compressed-hereisit.pdf");
```

Test 0/101 pages, exact 100MP vs one pixel above, A4 100-page balanced rejection vs minimum acceptance, source sizes `1, 99, 100, 101, 50MiB`, invalid `0`, fractional, and `50MiB + 1`, C0/C1/bidi filename removal, and fallback naming. For the envelope, accept a `%PDF-` header within the first 1,024 bytes plus terminal `%%EOF` followed only by bytes `00 09 0a 0c 0d 20`; reject truncated/embedded EOF, arbitrary trailing bytes, and a header beyond 1,024 bytes.

- [ ] **Step 2: Run focused domain tests and verify red**

```bash
pnpm test packages/pdf-tool/src/compress-scanned-plan.test.ts packages/pdf-tool/src/naming.test.ts packages/pdf-tool/src/file-format.test.ts
```

Expected: FAIL because the compression plan/name/envelope exports do not exist.

- [ ] **Step 3: Implement exact preset and byte-target resolution**

Create the approved discriminated preset constants and:

```ts
export function calculatePdfCompressScannedTarget(
  sourceByteLength: number,
): PdfCompressScannedByteTarget {
  if (
    !Number.isSafeInteger(sourceByteLength) ||
    sourceByteLength < 1 ||
    sourceByteLength > MAX_PDF_COMPRESS_SCANNED_INPUT_BYTES
  ) {
    throw new PdfCompressScannedPlanError("MEMORY_LIMIT", "PDF 파일 크기를 확인할 수 없어요.");
  }
  const requiredSaving = Math.max(1, Math.ceil(sourceByteLength / 100));
  return { requiredSaving, targetBytes: sourceByteLength - requiredSaving };
}
```

`planPdfCompressScannedRasterization()` accepts already-rotated visible point dimensions only; it must never accept or apply a rotation field. Retain exact point sizes in every page plan, allocate pixels through `calculatePdfRasterAllocation()`, enforce 1–100 pages and cumulative 100MP, and produce sequential one-based `sourcePage` values.

- [ ] **Step 4: Implement naming and complete PDF envelope validation**

```ts
export function compressedPdfName(filename: string): string {
  return `${safeStem(filename, "document")}-compressed-hereisit.pdf`;
}

export function hasCompletePdfEnvelope(buffer: ArrayBuffer): boolean {
  return hasPdfSignature(buffer) && hasPdfEofMarker(buffer);
}
```

`hasPdfEofMarker()` scans backward across only PDF whitespace and then requires the exact five ASCII bytes `%%EOF`. Export the compression plan from `packages/pdf-tool/src/index.ts`.

- [ ] **Step 5: Run focused tests and PDF tool typecheck**

```bash
pnpm test packages/pdf-tool/src/compress-scanned-plan.test.ts packages/pdf-tool/src/raster-plan.test.ts packages/pdf-tool/src/naming.test.ts packages/pdf-tool/src/file-format.test.ts
pnpm --filter @hereisit/pdf-tool typecheck
```

Expected: all domain and existing PDF-to-image tests pass.

- [ ] **Step 6: Commit the pure domain checkpoint**

```bash
git add packages/pdf-tool/src/compress-scanned-plan.ts packages/pdf-tool/src/compress-scanned-plan.test.ts packages/pdf-tool/src/naming.ts packages/pdf-tool/src/naming.test.ts packages/pdf-tool/src/file-format.ts packages/pdf-tool/src/file-format.test.ts packages/pdf-tool/src/index.ts
git commit -m "feat: plan scanned PDF compression"
```

---
### Task 5: Extract a neutral PDF.js raster runtime and preserve PDF-to-image behavior

**Files:**
- Create: `packages/browser-runtime/src/pdf-raster-runtime.ts`
- Create: `packages/browser-runtime/src/pdf-raster-runtime.test.ts`
- Modify: `packages/browser-runtime/src/pdf-to-images-pipeline.ts`
- Modify: `packages/browser-runtime/src/pdf-to-images-pipeline.test.ts`

**Interfaces:**
- Produces internal-only PDF.js adapter/session, parser-failure race, active canvas budget/factory, viewport/page interfaces, and a nested parser Worker readiness probe.
- Keeps `runPdfToImagesPipeline()` and every public `pdf.to-images@1` type/result unchanged.
- Is not added as a package export; only the two dedicated Worker pipelines import it.

- [ ] **Step 1: Write failing common-runtime characterization tests**

Move the existing `WorkerCanvasBudget and Worker factories` and `default PDF.js adapter parser failures`
coverage into the new test file, importing from `./pdf-raster-runtime`. Add an idempotent session cleanup
test that locks the ownership boundary:

```ts
it("owns one page and canvas at a time and closes every renderer resource once", async () => {
  const fixture = createRasterAdapterFixture();
  const session = await openPdfRasterSession(
    { bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d).buffer },
    { adapter: fixture.adapter },
  );

  await session.withPage(1, async (page) => {
    const viewport = page.getViewport({ scale: 1 });
    await session.withCanvas(100, 200, async (canvas) => {
      await session.render(page, canvas, viewport, "#ffffff");
    });
  });
  await session.close();
  await session.close();

  expect(fixture.maximumOpenPages).toBe(1);
  expect(fixture.maximumOpenCanvases).toBe(1);
  expect(fixture.counters).toMatchObject({
    pageCleanup: 1,
    canvasDestroy: 1,
    documentCleanup: 1,
    loadingTaskDestroy: 1,
    pdfWorkerDestroy: 1,
    parserPortTerminate: 1,
    parserFailureListenerRemove: 1,
  });
});
```

Retain tests for exact PDF.js version/asset URLs/options, parser `error` and `messageerror`, abort during
load/getPage/render, both canvas axes reset to zero, peak-safe reset, duplicate reserve/reset failure, and
the 128MiB combined output/display-layer budget.

- [ ] **Step 2: Run the new and existing suites and verify red**

```bash
pnpm test packages/browser-runtime/src/pdf-raster-runtime.test.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
```

Expected: FAIL because the neutral runtime module does not exist.

- [ ] **Step 3: Define neutral renderer types and errors**

Create the internal surface:

```ts
export type PdfRasterRuntimeErrorCode =
  | "PASSWORD_PROTECTED"
  | "CORRUPT_PDF"
  | "MEMORY_LIMIT"
  | "RENDER_FAILED"
  | "WORKER_CRASH";

export class PdfRasterRuntimeError extends Error {
  constructor(
    readonly code: PdfRasterRuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PdfRasterRuntimeError";
  }
}

export interface PdfRasterViewport { width: number; height: number }
export interface PdfRasterRenderTask { promise: Promise<void>; cancel(): void }
export interface PdfRasterRendererPage {
  readonly rotate: number;
  getViewport(options: { scale: number; rotation?: number }): PdfRasterViewport;
  render(options: {
    canvas: PdfRasterCanvasSurface;
    viewport: PdfRasterViewport;
    background: "#ffffff";
  }): PdfRasterRenderTask;
  cleanup(): unknown;
}

export interface PdfRasterRendererDocument {
  readonly numPages: number;
  getPage(sourcePage: number): Promise<PdfRasterRendererPage>;
  cleanup(): Promise<unknown> | unknown;
}

export interface PdfRasterLoadingTask {
  readonly promise: Promise<PdfRasterRendererDocument>;
  destroy(): Promise<unknown> | unknown;
}

export interface PdfRasterRendererResources {
  readonly loadingTask: PdfRasterLoadingTask;
  readonly pdfWorker: { destroy(): Promise<unknown> | unknown };
  readonly parserPort: { terminate(): void };
  readonly parserFailure: Promise<never>;
  removeParserFailureListeners(): void;
  classifyError(error: unknown): "PASSWORD_PROTECTED" | "CORRUPT_PDF" | undefined;
}

export interface PdfRasterCanvasSurface {
  width: number;
  height: number;
  convertToBlob(options: { type: string; quality?: number }): Promise<Blob>;
}

export interface PdfRasterCanvasResource {
  readonly canvas: PdfRasterCanvasSurface;
  readonly context: {
    fillStyle: unknown;
    fillRect(x: number, y: number, width: number, height: number): void;
  };
  destroy(): void;
}

export interface PdfRasterRendererAdapter {
  open(input: { bytes: ArrayBuffer }, budget: WorkerCanvasBudget): Promise<PdfRasterRendererResources>;
  createCanvas(width: number, height: number, budget: WorkerCanvasBudget): PdfRasterCanvasResource;
}
```

Move `WorkerCanvasBudget`, `WorkerCanvasFactory`, `WorkerFilterFactory`, neutral canvas/resource types,
PDF.js secure setup, parser failure listeners/race, and memory marker handling from the image pipeline.
Keep the same 128MiB active budget and error messages internally; each consumer maps neutral codes into
its own public contract. `PdfRasterRendererAdapter.open()` owns every partially constructed resource until
it fulfills and must tear those resources down itself if it rejects. After fulfillment,
`openPdfRasterSession()` owns the loading task, loaded document, PDFWorker, parser port, and parser-failure
listeners until `close()`; `withPage()` and `withCanvas()` exclusively own their callback-scoped resources.

- [ ] **Step 4: Implement the session ownership API and parser readiness probe**

Expose:

```ts
export interface PdfRasterSession {
  readonly pageCount: number;
  withPage<T>(
    sourcePage: number,
    use: (page: PdfRasterRendererPage) => Promise<T> | T,
  ): Promise<T>;
  withCanvas<T>(
    width: number,
    height: number,
    use: (canvas: PdfRasterCanvasResource) => Promise<T> | T,
  ): Promise<T>;
  render(
    page: PdfRasterRendererPage,
    canvas: PdfRasterCanvasResource,
    viewport: PdfRasterViewport,
    background: "#ffffff",
  ): Promise<void>;
  close(): Promise<void>;
}

export async function openPdfRasterSession(
  input: { bytes: ArrayBuffer },
  options: { adapter?: PdfRasterRendererAdapter; signal?: AbortSignal } = {},
): Promise<PdfRasterSession>;

export async function probePdfRasterParserWorker(): Promise<void>;
```

`withPage()` races parser failure while acquiring the page and always calls `page.cleanup()`. `render()`
races parser failure and cancels the active render on abort. `withCanvas()` creates through the shared
budget and always destroys. `close()` is idempotent and independently attempts listener removal, document
cleanup, loading-task destroy, PDFWorker destroy, and parser-port termination even if an earlier cleanup
throws. If `openPdfRasterSession()` rejects before ownership transfers to a returned session, it performs
the same best-effort teardown itself.

Do **not** treat a caller-supplied port's `PDFWorker.promise` as readiness: in PDF.js 6.1.200 it can resolve
when the main-side message handler is attached, before `pdf.worker.min.mjs` has loaded. The probe uses a
module-owned immutable byte array for a minimal valid one-page PDF, creates a fresh adapter/session with
the exact pinned same-origin production options, awaits the actual `getDocument()` load, acquires page 1,
validates a finite positive scale-1 viewport, and then closes every resource before resolving. It never
reads the user's source file. Add tests where the parser asset errors or sends `messageerror` after
`PDFWorker.promise` but before the probe document loads; both probes must reject and the public compression
Worker must not be allowed to emit successful readiness.

- [ ] **Step 5: Rewire PDF-to-images to the neutral runtime without changing results**

Keep the image-specific archive adapter separate:

```ts
export interface PdfToImagesRendererAdapter extends PdfRasterRendererAdapter {
  createArchive?: (onData: PdfToImagesArchiveOnData) => PdfToImagesArchive;
}
```

Use `openPdfRasterSession()`, `session.withPage()`, `session.withCanvas()`, and `session.render()` for the
existing planning/render loop. Map neutral errors back to the existing `PdfToImagesPipelineError`. Do not
race JPEG/PNG `convertToBlob()` or final ZIP completion against a parser failure after the last successful
render; preserve the approved behavior where a valid final local result wins. A parser failure before a
later `getPage()` must still fail that job.

- [ ] **Step 6: Run the full raster and PDF-to-image regression surface**

```bash
pnpm test packages/browser-runtime/src/pdf-raster-runtime.test.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts packages/browser-runtime/src/pdf-to-images.worker.test.ts packages/browser-runtime/src/run-pdf-to-images-job.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: all common runtime and existing PDF-to-image tests pass with identical result/progress semantics.

- [ ] **Step 7: Commit the behavior-preserving runtime extraction**

```bash
git add packages/browser-runtime/src/pdf-raster-runtime.ts packages/browser-runtime/src/pdf-raster-runtime.test.ts packages/browser-runtime/src/pdf-to-images-pipeline.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
git commit -m "refactor: share PDF raster runtime"
```

---

### Task 6: Build the bounded scanned-PDF reconstruction pipeline

**Files:**
- Create: `packages/browser-runtime/src/pdf-compress-scanned-pipeline.ts`
- Create: `packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts`

**Interfaces:**
- Consumes the Task 2 contract, Task 4 plan/name/envelope helpers, and Task 5 raster session.
- Produces `runPdfCompressScannedPipeline()`, injected assembler interfaces, default pdf-lib assembly, and `toPdfCompressScannedErrorPayload()` for the Worker.

- [ ] **Step 1: Write all failing pipeline, geometry, failure, and cleanup tests**

Define injected adapters and lock the main surface:

```ts
export interface PdfCompressScannedAssembler {
  readonly pageCount: number;
  addJpegPage(input: {
    bytes: ArrayBuffer;
    widthPoints: number;
    heightPoints: number;
  }): Promise<void>;
  serialize(): Promise<ArrayBuffer>;
  destroy(): void;
}

export interface PdfCompressScannedAssemblerFactory {
  create(): Promise<PdfCompressScannedAssembler>;
}

export interface PdfCompressScannedPipelineOptions {
  rasterAdapter?: PdfRasterRendererAdapter;
  assemblerFactory?: PdfCompressScannedAssemblerFactory;
  onProgress?: (progress: PdfCompressScannedProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}
```

Create a source input whose byte length gives a known target and an injected assembler that returns a
strict `%PDF-...%%EOF` buffer. Assert:

```ts
const result = await runPdfCompressScannedPipeline(input({ byteLength: 10_000 }), {
  version: 1,
  preset: "balanced",
}, { rasterAdapter, assemblerFactory });

expect(result).toMatchObject({
  mime: "application/pdf",
  sourceByteLength: 10_000,
  pageCount: 2,
  preset: "balanced",
  dpi: 150,
  quality: 72,
  warnings: [
    "PDF_PAGES_RASTERIZED",
    "SEARCHABLE_CONTENT_REMOVED",
    "INTERACTIVE_CONTENT_REMOVED",
    "SIGNATURES_INVALIDATED",
    "COLOR_PROFILE_NORMALIZED",
  ],
});
expect(result.byteLength).toBeLessThanOrEqual(9_900);
```

Add target-boundary cases where exactly `targetBytes` succeeds and `targetBytes + 1` rejects with
`NO_SIZE_REDUCTION` and `retryable: false`.

Before writing production code, also add the focused real-assembler test and every terminal-path test:
CropBox/UserUnit-equivalent scale-1 viewport sizes, 90/270-degree visible orientation, fractional points
without physical drift, balanced/minimum quality arguments, the complete planning pass before the first
canvas, maximum open page/canvas/encode concurrency of one, invalid final signature/EOF, metadata rules,
and exact mapping for password, corrupt, page, memory, render, encode, assembly, no-reduction, parser
crash, and cancellation. The real-assembler fixture uses a valid small JPEG and asserts page count, fixed
creator/producer, no copied source title/author, rotation 0, and exact fractional point dimensions.

Add cleanup assertions for every success/failure/cancel path: `session.close()` and
`assembler.destroy()` exactly once, current page/canvas cleanup, no later-page work after failure, no
partial result, and input/candidate/current-JPEG references cleared in `finally`. Finally, use an injected
Blob whose `size` is one byte larger than the remaining target and whose `arrayBuffer` is a spy; require
`NO_SIZE_REDUCTION` while that spy remains uncalled. A separate hostile Blob with an allowed advertised
size but a mismatched materialized byte length must be rejected after reading.

- [ ] **Step 2: Run the new pipeline suite and verify red**

```bash
pnpm test packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts
```

Expected: FAIL because the pipeline module does not exist.

- [ ] **Step 3: Implement the default pdf-lib assembler**

Use a fresh document and no source-document copy:

```ts
async function createDefaultAssembler(): Promise<PdfCompressScannedAssembler> {
  let document: PDFDocument | undefined = await PDFDocument.create({ updateMetadata: false });
  document.setCreator("HereIsIt");
  document.setProducer("HereIsIt");
  return {
    get pageCount() {
      return document?.getPageCount() ?? 0;
    },
    async addJpegPage({ bytes, widthPoints, heightPoints }) {
      if (document === undefined) throw new Error("ASSEMBLER_DESTROYED");
      const image = await document.embedJpg(new Uint8Array(bytes));
      const page = document.addPage([widthPoints, heightPoints]);
      page.drawImage(image, { x: 0, y: 0, width: widthPoints, height: heightPoints });
    },
    async serialize() {
      if (document === undefined) throw new Error("ASSEMBLER_DESTROYED");
      const saved = await document.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50,
        updateFieldAppearances: false,
      });
      if (
        !(saved.buffer instanceof ArrayBuffer) ||
        saved.byteOffset !== 0 ||
        saved.byteLength !== saved.buffer.byteLength
      ) {
        throw new Error("NON_EXACT_SERIALIZATION_BUFFER");
      }
      return saved.buffer;
    },
    destroy() {
      document = undefined;
    },
  };
}
```

Type the local `document` as `PDFDocument | undefined`. Reuse the exact full-span `ArrayBuffer` owned by
the `Uint8Array` returned from `document.save()`; never use `Uint8Array.from()` or an unconditional
`slice()` that copies a result approaching 50MiB. Treat an unexpected shared or partial-span buffer as
`ASSEMBLY_FAILED`. Add a focused real-assembler test with a valid small JPEG by making the already-red
real-assembler test from Step 1 pass; do not add behavior without a prewritten assertion.

- [ ] **Step 4: Implement validation, authoritative planning, and sequential processing**

**User-approved Task 6 amendment (2026-07-12):** PDF.js may return a DPI viewport with a positive
floating-point overshoot even when its physical geometry matches the authoritative plan (for example,
Letter at 150 DPI can be `1275 x 1650.0000000000002` for a `1275 x 1650` plan). Replace the original
exact-ceil defensive comparison with the bounded per-axis ULP-normalized comparison below. This
amendment does not change the approved design spec, planned integer canvas dimensions, or rejection of
meaningful viewport drift.

The exported surface is:

```ts
export async function runPdfCompressScannedPipeline(
  transferredInput: PdfCompressScannedRunRequest["input"],
  rawSpec: unknown,
  options: PdfCompressScannedPipelineOptions = {},
): Promise<PdfCompressScannedResult>;

export function toPdfCompressScannedErrorPayload(
  error: unknown,
): PdfCompressScannedErrorPayload;
```

Perform these operations in order:

1. Check abort, emit `validating: 0`, strict-parse the spec, validate byte length, MIME/extension hint, and `%PDF-` signature.
2. Calculate the exact smaller-only target and open one raster session from the transferred bytes.
3. Reject page counts outside 1–100.
4. Planning pass: for every source page call `getViewport({ scale: 1 })`, collect only finite positive visible point width/height, clean each page, then call `planPdfCompressScannedRasterization()` before any canvas exists.
5. Create one assembler.
6. For each planned page, reacquire the page and get the DPI viewport. Independently for each finite,
   positive axis `actual` and planned integer `planned`, accept when `Math.ceil(actual) === planned`;
   otherwise accept only when `actual > planned` and
   `actual - planned <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(planned)) * 8`. Reject
   every other drift before canvas allocation. Allocate/fill one opaque white canvas using the exact
   planned integer dimensions, render, and release the render task.
7. Encode with exactly `{ type: "image/jpeg", quality: plan.quality / 100 }` and verify MIME. Before
   allocating an ArrayBuffer, require `blob.size <= targetBytes - cumulativeJpegBytes`; otherwise reject
   immediately with `NO_SIZE_REDUCTION`. Only then read one ArrayBuffer, verify its actual byte length,
   safe cumulative sum, and JPEG signature.
8. Recheck the materialized cumulative JPEG bytes against `targetBytes`; reject before embedding or
   touching any later page if the advertised Blob size was inconsistent or the strict target is exceeded.
9. Embed with the authoritative `widthPoints`/`heightPoints`, never `pixels * 72 / dpi`; then release the local JPEG reference, canvas, and page.
10. Serialize after all pages, verify assembler page count, complete PDF envelope, and `candidate.byteLength <= targetBytes`.
11. Emit `finalizing: 1` only after the postcondition, then return the exact result/timing/warnings.

Use monotonic fractions with page counts for render/encode/assemble. Observer exceptions must never alter
the job outcome.

- [ ] **Step 5: Implement failure mapping and cleanup against the prewritten tests**

Complete the bounded public-error mapping and one `finally` ownership path until every Step 1 failure,
geometry, early-Blob-size, sequencing, and cleanup assertion is green. Do not weaken hostile fixture or
cleanup expectations to accommodate the implementation.

- [ ] **Step 6: Run focused runtime verification**

```bash
pnpm test packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts packages/browser-runtime/src/pdf-raster-runtime.test.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: compression pipeline, common runtime, and PDF-to-image regressions all pass.

- [ ] **Step 7: Commit the pipeline checkpoint**

```bash
git add packages/browser-runtime/src/pdf-compress-scanned-pipeline.ts packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts
git commit -m "feat: reconstruct scanned PDFs locally"
```

---

### Task 7: Add the dedicated compression Worker and hostile public job boundary

**Files:**
- Create: `packages/browser-runtime/src/pdf-compress-scanned.worker.ts`
- Create: `packages/browser-runtime/src/pdf-compress-scanned.worker.test.ts`
- Create: `packages/browser-runtime/src/run-pdf-compress-scanned-job.ts`
- Create: `packages/browser-runtime/src/run-pdf-compress-scanned-job.test.ts`
- Modify: `packages/browser-runtime/package.json`
- Modify: `packages/browser-runtime/src/index.ts`

**Interfaces:**
- Produces the `@hereisit/browser-runtime/pdf-compress-scanned` package subpath, capability check, public job handle, strict event/result decoder, 180-second watchdog, and immediate cancellation.
- Consumes `expectedPageCount` from advisory inspection only to cross-check terminal page count; it never trusts advisory geometry.

- [ ] **Step 1: Write failing Worker protocol and capability tests**

Mock the pipeline, raster parser probe, OffscreenCanvas JPEG probe, and pdf-lib assembly probe. Assert the
Worker does not post `ready` until all asynchronous probes settle and emits:

```ts
{
  protocol: 1,
  type: "ready",
  capabilities: {
    offscreenCanvas: true,
    jpegEncoder: true,
    pdfjsWorker: true,
    pdfAssembly: true,
  },
  error: null,
}
```

Assert a missing canvas/JPEG capability yields non-retryable `UNSUPPORTED_BROWSER`, while parser or
assembly probe failure yields retryable `WORKER_CRASH`. Cover wrong protocol/tool/version/spec, duplicate
run, concurrent run, cancel, monotonic sequence, transferable result, and no terminal event after abort.

- [ ] **Step 2: Write failing public-job lifecycle and decoder tests**

Define the public surface:

```ts
export interface RunPdfCompressScannedJobOptions {
  expectedPageCount: number;
  onProgress?: (progress: PdfCompressScannedProgress) => void;
}

export function supportsBrowserPdfCompressScannedRuntime(): boolean;

export function runPdfCompressScannedJob(
  file: File,
  spec: PdfCompressScannedSpecV1,
  options: RunPdfCompressScannedJobOptions,
): PdfCompressScannedJobHandle;
```

Test that file reading is zero before successful ready, then exactly once. Test invalid file/spec/page
count before read, ready error mapping, read failure, byte-length mismatch, postMessage failure, Worker
construction/error/messageerror, timeout, immediate cancel before/while/after read, wrong job IDs,
out-of-order progress, duplicate terminals, and late events.

Include a readiness regression where the main-side PDF.js `PDFWorker.promise` resolves but the nested
parser script then errors before the immutable probe PDF finishes loading. The top-level Worker must emit
retryable `WORKER_CRASH` readiness, the public wrapper must settle rejected, and `file.arrayBuffer()` plus
the run message must both remain untouched. Add the equivalent parser `messageerror` case.

Before implementation, send syntactically valid hostile `run` envelopes directly to the Worker while its
probe is pending and after its probe has failed. Assert a bounded matching-job retryable `WORKER_CRASH`,
zero pipeline calls/progress/completion, and no retained active job in both states.

Create hostile complete events that mutate one field at a time. The decoder must reject mismatched source
size, buffer length, 1% target, PDF signature/EOF, MIME, exact safe name, page count, preset/DPI/quality
pair, five exact warnings, finite nonnegative timing, control/C1/bidi text, and completion before a valid
`finalizing: 1` event. A malformed event for the matching job becomes an immediate retryable protocol
`WORKER_CRASH`, not a three-minute silent hang.

- [ ] **Step 3: Run both new suites and verify red**

```bash
pnpm test packages/browser-runtime/src/pdf-compress-scanned.worker.test.ts packages/browser-runtime/src/run-pdf-compress-scanned-job.test.ts
```

Expected: FAIL because the Worker and public job modules do not exist.

- [ ] **Step 4: Implement async Worker readiness and one active job**

The Worker installs its untrusted-message handler first, performs a 1×1 canvas/2D/JPEG encode probe,
resets both canvas axes, awaits `probePdfRasterParserWorker()`, creates/serializes/destroys an empty
pdf-lib probe, then posts the exact ready event. It queues no input itself; the public wrapper cannot post a
run before successful ready.

Track readiness explicitly as `"pending" | "ready" | "failed"`, beginning at `pending`, transitioning to
`ready` only after every async probe succeeds, and permanently transitioning to `failed` on probe error.
A syntactically valid hostile `run` received while `pending` or after `failed` must not call the pipeline;
respond once with a bounded matching-job retryable `WORKER_CRASH` and retain the readiness state. Use
explicit guards to make the prewritten Step 2 pre-ready/post-failure assertions green. Only `ready` may
transition the separate active job state from idle to running.

Strict-parse run envelopes, allow one active job, forward progress with increasing sequence numbers, pass
an AbortSignal to `runPdfCompressScannedPipeline()`, transfer only `result.bytes`, and map every terminal
error through `toPdfCompressScannedErrorPayload()`.

- [ ] **Step 5: Implement the strict public wrapper and result decoder**

Follow `runPdfToImagesJob()` lifecycle guards but use the independent contract. Validate the file before
Worker creation, start the watchdog at handle creation, construct
`hereisit-pdf-compress-scanned-worker`, wait for all four true capabilities plus `error: null`, then read
and transfer the source once.

Track progress sequence and `sawFinalizingOne`. Decode a result only if:

```ts
value.sourceByteLength === file.size &&
value.byteLength === value.bytes.byteLength &&
value.byteLength <= calculatePdfCompressScannedTarget(file.size).targetBytes &&
hasCompletePdfEnvelope(value.bytes) &&
value.mime === "application/pdf" &&
value.suggestedName === compressedPdfName(file.name) &&
value.pageCount === options.expectedPageCount
```

Also require the exact preset pair (`balanced/150/72` or `minimum/96/55`), exact warning order, bounded
public strings, finite timings, and a valid finalization event. Settle and terminate once on every path.

- [ ] **Step 6: Add the package export and run focused verification**

Add:

```json
"./pdf-compress-scanned": "./src/run-pdf-compress-scanned-job.ts"
```

Re-export public types from that module and the package index without exporting the internal raster core.
Then run:

```bash
pnpm test packages/browser-runtime/src/pdf-compress-scanned.worker.test.ts packages/browser-runtime/src/run-pdf-compress-scanned-job.test.ts packages/browser-runtime/src/pdf-compress-scanned-pipeline.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: every Worker/public/pipeline test passes.

- [ ] **Step 7: Commit the Worker boundary checkpoint**

```bash
git add packages/browser-runtime/src/pdf-compress-scanned.worker.ts packages/browser-runtime/src/pdf-compress-scanned.worker.test.ts packages/browser-runtime/src/run-pdf-compress-scanned-job.ts packages/browser-runtime/src/run-pdf-compress-scanned-job.test.ts packages/browser-runtime/package.json packages/browser-runtime/src/index.ts
git commit -m "feat: add scanned PDF compression worker"
```

---

### Task 8: Add the isolated `/pdf/compress` route and workbench

**Files:**
- Create: `apps/web/src/app/pdf/compress/page.tsx`
- Create: `apps/web/src/components/pdf-compress-workbench.tsx`
- Create: `apps/web/src/lib/site.test.ts`
- Create: `tests/e2e/pdf-compression.spec.ts`
- Modify: `apps/web/src/lib/site.ts`
- Modify: `apps/web/src/components/pdf-tool-page.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Modify: `scripts/verify-static-export.mjs`

**Interfaces:**
- Consumes `inspectPdfFile()` for advisory page count and the Task 7 compression package subpath for the authoritative run.
- Produces a custom `compress` intent classified separately from editing and PDF-to-image, with explicit preset/result/cancel/save lifecycle.
- Does not modify `packages/tool-registry`; that package remains image-preset-only.

- [ ] **Step 1: Write failing registry/classification tests**

Add exact route/copy and intent-class assertions:

```ts
expect(pdfTools.compress).toMatchObject({
  intent: "compress",
  intentClass: "pdf-compress-scanned",
  path: "/pdf/compress",
  navLabel: "PDF 용량 줄이기",
  title: "스캔 PDF 용량 줄이기",
});

expect(pdfToolList.filter((tool) => tool.intentClass === "pdf-compress-scanned"))
  .toEqual([pdfTools.compress]);
expect(isPdfEditingIntent("compress")).toBe(false);
expect(isPdfEditingIntent("to-image")).toBe(false);
expect(isPdfEditingIntent("merge")).toBe(true);
```

Define `PdfToolIntentClass = "editing" | "pdf-to-images" | "pdf-compress-scanned"` and require every
registry entry to carry one. This explicit class later replaces static-export array slicing.

- [ ] **Step 2: Write failing route-shell, workbench, and lifecycle browser tests**

Create the new test file and its deterministic local scan/vector fixture helpers before creating the
route. The first test visits `/pdf/compress` and requires:

```ts
await expect(page.getByRole("heading", { level: 1, name: "스캔 PDF 용량 줄이기" }))
  .toBeVisible();
await expect(page.getByRole("button", { name: "PDF 선택" })).toBeEnabled();
await expect(page.getByRole("radio", { name: /균형 150DPI/ })).toBeChecked();
await expect(page.getByRole("radio", { name: /최소 용량 96DPI/ })).not.toBeChecked();
await expect(page.getByText(/텍스트 검색·복사/)).toBeVisible();
await expect(page.getByText(/원본보다 1% 이상 작을 때만/)).toBeVisible();
await expect(page.getByText("PDF 1개 · 1바이트~50MB · 최대 100페이지 · 파일은 이 기기에서만 처리돼요."))
  .toBeVisible();
await expect(page.getByText(/작은 글자가 흐려질 수 있어요/)).toBeVisible();
```

Before any UI production implementation, write browser tests that upload a known-page-count scan, require
the exact `N페이지 PDF 용량 줄이기 →` action, run the default preset, and assert the result shows `균형
150DPI`, source/output bytes, whole-number savings, elapsed time, and the full destructive warning. Require
no automatic download and one explicit save. Add both exact `NO_SIZE_REDUCTION` messages, preset-change
result invalidation, rerun/replacement/reset URL revocation, immediate cancel with no partial result, and
late share fulfillment/rejection generation guards. These tests may initially fail at navigation; keep all
assertions in place so Steps 5–8 are driven by the red behavior rather than adding them afterward.

- [ ] **Step 3: Write the failing explicit static-export classification before route wiring**

Add `routeClass` to every `toolPages` item, including `/pdf/compress`, and define
`PDF_COMPRESS_SCANNED_WORKER_MARKER = "hereisit-pdf-compress-scanned-worker"`. Replace positional
`slice(0, 3)`, `slice(3, -1)`, and `at(-1)` classification with exact route-class filtering. Assert the
global inventory and each route closure with these relationships:

- image: image Worker only; no PDF editing, to-images, compression Worker, or PDF.js;
- PDF editing: inspection/editing Worker only; neither raster Worker nor PDF.js;
- PDF-to-images: inspection plus to-images Worker/PDF.js; no compression Worker;
- PDF compression: inspection plus compression Worker/PDF.js; no to-images Worker.

Preserve the exact CMap/font file-set, license, same-origin URL, and CSP checks. This verifier is written
now, while the route and compression closure are still absent, so the first export run must be red.

- [ ] **Step 4: Run focused tests and verify red**

```bash
pnpm test apps/web/src/lib/site.test.ts
pnpm build
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium
pnpm verify:export
```

Expected: registry/route/workbench assertions fail and the static verifier rejects the missing compression
HTML/Worker closure. Do not proceed unless the new assertions—not an unrelated environment failure—are red.

- [ ] **Step 5: Add the explicit site entry and custom route**

Extend `PdfToolIntent` with `compress`, exclude both custom intents from `PdfEditingIntent`, add
`isPdfEditingIntent()`, and attach `intentClass` to every PDF config. The new entry is:

```ts
compress: {
  intent: "compress",
  intentClass: "pdf-compress-scanned",
  path: "/pdf/compress",
  navLabel: "PDF 용량 줄이기",
  eyebrow: "PDF COMPRESSOR",
  title: "스캔 PDF 용량 줄이기",
  description:
    "스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로 전송되지 않습니다.",
  defaultSummary:
    "기본값은 모든 페이지를 추천 150DPI로 다시 만들고, 원본보다 1% 이상 작을 때만 새 PDF를 제공해요.",
  warning:
    "모든 페이지가 이미지로 바뀝니다. 검색·복사 가능한 텍스트와 OCR, 링크·양식·주석·북마크·첨부파일·레이어가 제거되거나 평면화되고 전자서명은 무효가 됩니다. 스캔 문서에 적합하며 원본 파일은 수정하지 않아요.",
  steps: [
    { title: "PDF 선택", description: "용량을 줄일 PDF 한 개를 선택하세요." },
    { title: "압축 수준 선택", description: "균형 150DPI 또는 최소 용량 96DPI를 골라요." },
    { title: "새 PDF 저장", description: "원본보다 최소 1% 작을 때만 새 PDF를 저장해요." },
  ],
},
```

Update `HOME_DESCRIPTION`. Make `PdfToolPage` render its fallback only when
`tool.intentClass === "editing" && isPdfEditingIntent(tool.intent)`; custom routes without an explicit
workbench render no accidental `PdfWorkbench`. Add the route:

```tsx
const tool = pdfTools.compress;
export const metadata = createToolMetadata(tool);

export default function PdfCompressPage() {
  return <PdfToolPage tool={tool} workbench={<PdfCompressWorkbench />} />;
}
```

- [ ] **Step 6: Implement the workbench state machine and preflight**

Use these imports and state types:

```ts
import { inspectPdfFile } from "@hereisit/browser-runtime/pdf";
import {
  type PdfCompressScannedJobHandle,
  type PdfCompressScannedProgress,
  type PdfCompressScannedResult,
  type PdfCompressScannedSpecV1,
  runPdfCompressScannedJob,
  supportsBrowserPdfCompressScannedRuntime,
} from "@hereisit/browser-runtime/pdf-compress-scanned";

type Preset = PdfCompressScannedSpecV1["preset"];
```

Mirror the proven PDF-to-image generation guards: one file, inspection handle, compression handle,
`runRef`, `saveOperationRef`, `savingRef`, one result Blob ref, and one result URL ref. On hydration probe
runtime support. Accept only one PDF of 1–50MiB. Advisory inspection may hard-reject invalid input and
page counts outside 1–100, but it must not call the MediaBox-based raster planner or reject geometry.
Before selection, show exactly `PDF 1개 · 1바이트~50MB · 최대 100페이지 · 파일은 이 기기에서만
처리돼요.` The preset cards show `균형 150DPI`/`추천` with `글자 가독성과 용량의 균형을 맞춰요.`
and `최소 용량 96DPI`/`작게` with `용량을 더 줄이지만 작은 글자가 흐려질 수 있어요.` Show the
full `warning` string from Step 5 as persistent copy before running and verbatim in the successful result;
do not add an acknowledgment checkbox because the source is never modified and the result requires an
explicit save.

Changing preset, rerunning, replacement, reset, and unmount call one `invalidateActiveWork()` path that
cancels handles, increments generations, clears saving state, drops the Blob reference, and revokes the
old URL.

- [ ] **Step 7: Implement run, progress, no-reduction, and save/share behavior**

Map progress without timers:

```ts
function progressLabel(progress: PdfCompressScannedProgress | undefined): string {
  if (progress === undefined) return "압축 준비됨";
  if (progress.phase === "validating") return "압축 설정 확인 중";
  if (progress.phase === "loading") return "PDF 페이지 읽는 중";
  if (progress.phase === "rendering" || progress.phase === "encoding" || progress.phase === "assembling") {
    return `${progress.completedPages}/${progress.totalPages}페이지 다시 만드는 중`;
  }
  if (progress.phase === "serializing") return "새 PDF 만드는 중";
  return "결과 마무리 중";
}
```

Start with:

```ts
const handle = runPdfCompressScannedJob(
  file,
  { version: 1, preset },
  { expectedPageCount: inspection.pageCount, onProgress: setProgress },
);
```

On fulfillment create exactly one `Blob([result.bytes], { type: "application/pdf" })`, then one object
URL. Show source/output bytes, `Math.round(((source - output) / source) * 100)` savings, elapsed time, the
selected preset as exactly `균형 150DPI` or `최소 용량 96DPI`, and the complete warning covering image
rasterization, searchable/copyable text and OCR, links, forms, annotations, bookmarks, attachments,
layers, flattened appearance, and invalid signatures. Never auto-download.

Render `NO_SIZE_REDUCTION` informationally with exact messages:

```ts
const noReductionMessage =
  preset === "balanced"
    ? "균형 150DPI 설정으로는 파일 용량을 1% 이상 줄이지 못했어요. 최소 용량 96DPI를 시도해 보세요."
    : "사용 가능한 설정으로는 파일 용량을 줄이지 못했어요. 원본을 그대로 사용하는 것을 권장해요.";
```

All other rejected outcomes use their bounded public message. The save/share button uses the existing
guarded share-then-download behavior; a late share success/failure after invalidation cannot download a
revoked result.

- [ ] **Step 8: Add accessible preset/result/mobile styling**

Reuse the existing workbench grid, source/settings/result cards, file picker, progressbar, sticky action
bar, and safe-area rules. Add only compression-specific classes for two large radio cards, preset tags,
savings summary, and destructive-result notes. Keep every interactive target at least 44px and form text
at least 16px on mobile. DOM order must remain source, settings, result.

- [ ] **Step 9: Run route, type, static, and focused browser verification**

```bash
pnpm exec biome check --write apps/web/src/app/pdf/compress/page.tsx apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/pdf-tool-page.tsx apps/web/src/components/pdf-workbench.module.css apps/web/src/lib/site.ts apps/web/src/lib/site.test.ts tests/e2e/pdf-compression.spec.ts
pnpm test apps/web/src/lib/site.test.ts
pnpm --filter @hereisit/web typecheck
pnpm build
pnpm verify:export
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=chromium
```

Expected: route shell, all prewritten UX/lifecycle behavior, registry classification, typecheck, build,
and explicit route-closure verification pass.

- [ ] **Step 10: Commit the workbench checkpoint**

```bash
git add apps/web/src/app/pdf/compress/page.tsx apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/pdf-tool-page.tsx apps/web/src/components/pdf-workbench.module.css apps/web/src/lib/site.ts apps/web/src/lib/site.test.ts tests/e2e/pdf-compression.spec.ts scripts/verify-static-export.mjs
git commit -m "feat: add scanned PDF compression workbench"
```

---

### Task 9: Prove real output, privacy, lifecycle, route isolation, and mobile behavior

**Files:**
- Expand: `tests/e2e/pdf-compression.spec.ts`
- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**
- Produces release-browser evidence using actual PDF.js rendering and actual pdf-lib output, without byte-stability assertions.
- Locks dimensions, PDF envelope, page geometry, smaller-only result, no-result state, privacy, URL/share races, route isolation, and mobile accessibility.

- [ ] **Step 1: Harden the prewritten deterministic scan fixture and output inspector**

Use the Step 8 browser fixture that was written red before the workbench. Generate a photo-like
high-quality JPEG in the test browser, then embed it into one or two **US Letter 612×792pt** PDF pages
with pdf-lib. Use deterministic pixel math rather than random state:

```ts
const jpegBase64 = await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1_275;
  canvas.height = 1_650;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas unavailable");
  const image = context.createImageData(canvas.width, canvas.height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const pixel = offset / 4;
    image.data[offset] = (pixel * 17) % 256;
    image.data[offset + 1] = (pixel * 31 + Math.floor(pixel / canvas.width)) % 256;
    image.data[offset + 2] = (pixel * 47) % 256;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/jpeg", 1).split(",")[1] ?? "";
});
```

Embed that source JPEG at full page size. For output inspection, load the downloaded PDF, require page
count/point dimensions/rotation 0, and inspect the first image XObject Width/Height rather than comparing
codec bytes. Assert 150DPI Letter is `1275×1650` and 96DPI Letter is `816×1056`. Do not label these
dimensions A4; an A4 fixture would instead have different rounded pixel dimensions.

- [ ] **Step 2: Write real balanced/minimum and no-reduction tests**

For each preset, upload the actual scan, wait for advisory inspection, click the explicit run button, and
assert no download occurs until the user activates save. Then assert:

- suggested name is `report-compressed-hereisit.pdf`;
- output starts `%PDF-` and has terminal EOF;
- output is at or below the exact source target;
- page count/order/displayed point size/orientation are preserved;
- creator and producer are `HereIsIt`, source title/author are absent;
- the embedded JPEG dimensions match the preset;
- minimum output is smaller than balanced for the same fixture.
- the result names the selected preset and repeats the full OCR/text/link/form/annotation/bookmark/
  attachment/layer/signature loss warning.

Upload a tiny vector PDF for both presets and require the exact informational copy, no result URL, no save
button, and zero automatic downloads.

- [ ] **Step 3: Add progress, cancel, URL, and share-race tests**

Lock real count-based rendering/encoding/assembling progress, immediate cancellation without partial PDF,
and result URL revocation on preset change, rerun, replacement, reset, and unmount. Port the proven pending
share fulfillment/rejection harness from PDF-to-image and require generation invalidation to prevent a
late fallback download.

- [ ] **Step 4: Add privacy and route-isolation tests**

Use a sentinel filename and instrument requests, console, downloads, failed requests, and page errors.
Require same-origin GET/HEAD only, no request body, no source filename/text in URLs or console, and no
failed/page errors. Add the compression Worker marker to the unrelated-route test matrix:

- image and editing routes load neither raster Worker nor PDF.js;
- `/pdf/to-image` loads inspection + to-images Worker, never compression Worker;
- `/pdf/compress` loads inspection + compression Worker, never to-images Worker;
- both raster routes may request only pinned same-origin PDF.js assets.

- [ ] **Step 5: Extend metadata, sitemap, PDF route, and mobile matrices**

Add `/pdf/compress` and its unique title/description/canonical to `tool-pages.spec.ts` and
`pdf-tools.spec.ts`. Add it to every dedicated mobile route list and assert source/settings/result ordering,
both preset controls, 44px run/cancel/save targets, sticky safe-area actions, keyboard reachability, and no
horizontal overflow on the iPhone profile. Keep assertions for the pre-selection 1-byte–50MB/100-page/
local-only copy, the `최소 용량 96DPI` small-text-blur warning, and the exact full destructive warning both
before execution and after success.

- [ ] **Step 6: Run focused real-browser suites**

```bash
pnpm build
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/pdf-tools.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/mobile.spec.ts --project=mobile-chromium
pnpm exec playwright test tests/e2e/pdf-compression.spec.ts --project=firefox
```

Expected: actual compression/no-reduction/privacy/lifecycle/mobile checks pass. If local WebKit is
available, run desktop/mobile WebKit with `--retries=0`; otherwise leave final WebKit proof to exact-SHA CI
and report the local dependency limitation.

- [ ] **Step 7: Commit the browser proof checkpoint**

```bash
git add tests/e2e/pdf-compression.spec.ts tests/e2e/pdf-to-images.spec.ts tests/e2e/pdf-tools.spec.ts tests/e2e/tool-pages.spec.ts tests/e2e/mobile.spec.ts
git commit -m "test: verify scanned PDF compression in browsers"
```

---

### Task 10: Make static export, production smoke, and documentation truthful

**Files:**
- Create: `scripts/smoke-pdf-compress.mjs`
- Modify: `scripts/verify-static-export.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Produces explicit route-class closure verification and a tracked local/production smoke for balanced, minimum, and no-reduction outcomes.
- Keeps Cloudflare Pages Git integration; does not add a deploy workflow or direct-upload command.

- [ ] **Step 1: Audit the prewritten static-export classification against the final closure**

Task 8 deliberately wrote the route-class verifier before route wiring and made it green with the first
workbench integration. Re-audit it now that all browser tests and assets exist: every `toolPages` entry has
an explicit class; no positional `slice()`/`at()` grouping remains; the global inventory contains both
raster Worker markers and pinned PDF.js; each route closure has only its allowed Workers; and exact CMap,
standard-font, license, same-origin URL, and CSP assertions remain intact. Add a focused assertion first if
Task 9 exposed any new asset or route-isolation behavior; never weaken the already-green closure rules.

- [ ] **Step 2: Run build/export verification on the final closure**

```bash
pnpm build
pnpm verify:export
```

Expected: PASS for the explicit compression HTML/marker/classification and every existing asset/security
assertion. The red proof for this behavior is recorded in Task 8 Step 4.

- [ ] **Step 3: Implement the tracked compression smoke**

Model the script after `smoke-pdf-to-images.mjs` but keep it independent. It must:

1. Normalize an HTTP(S) base origin and reject redirects/cross-origin requests.
2. GET `/pdf/compress`, the pinned parser Worker, one packed CMap, and one standard font; assert HTTP 200,
   immutable asset caching, CSP, `nosniff`, frame denial, no-referrer, and permissions policy.
3. Generate the deterministic scan fixture in the browser, create a PDF in memory, and run balanced.
4. Require no automatic download, explicitly save once, parse the PDF, calculate
   `requiredSaving = max(1, ceil(sourceBytes / 100))` and `targetBytes = sourceBytes - requiredSaving`,
   and require `candidateBytes <= targetBytes` (at least 1% smaller, not exactly equal), plus page geometry,
   rotation 0, and 150DPI embedded image dimensions.
5. Reset, run minimum on the same source, verify 96DPI dimensions and a smaller result than balanced.
6. Reset, run a tiny vector PDF, require `NO_SIZE_REDUCTION` guidance and no save/download.
7. Require no external origin, write method, body, failed request, page error, or sentinel console leak.
8. Close context/browser in `finally` and print only `Scanned PDF compression smoke passed.`.

- [ ] **Step 4: Update product and operational documentation**

Update all three documents to distinguish **scan-oriented raster compression provided** from
**structure-preserving general PDF compression not provided**. Record exact presets, the 1% guarantee,
all destructive losses, 50MiB/100-page/8,192px/16MP/100MP/128MiB/180-second limits, authoritative
CropBox/rotation/UserUnit visible geometry, parser arrays outside the managed budget, sequential
processing, no upload, and both smoke commands. Add `/pdf/compress` to the deployment checklist without
changing the Git-integrated Cloudflare configuration.

- [ ] **Step 5: Run static, local Pages, and both regression smokes**

Start the preview in a separate process, then run:

```bash
pnpm verify
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:4173
```

Expected: static route/assets/closures, balanced/minimum/no-reduction compression, existing PNG/JPG-ZIP,
privacy, and headers all pass.

- [ ] **Step 6: Commit release evidence and truthful docs**

```bash
git add scripts/smoke-pdf-compress.mjs scripts/verify-static-export.mjs README.md docs/architecture.md docs/deployment.md
git commit -m "docs: verify scanned PDF compression release"
```

---

### Task 11: Review, verify, publish one release commit, prove production, and reassess the next feature

**Files:**
- Review every file changed by Tasks 1–10.
- Do not create a deployment workflow; Cloudflare remains connected to GitHub `main`.
- Do not modify the approved design during implementation review except for the user-approved exact display-token correction.

**Interfaces:**
- Produces one intentional release commit on `main`, exact-SHA GitHub/Cloudflare evidence, two live smokes, a clean synchronized repository, and a separate evidence-based next-feature recommendation.

- [ ] **Step 1: Run two-track implementation review and fix findings with tests first**

Invoke `superpowers:requesting-code-review`. One reviewer focuses on runtime/security/resource accounting,
parser/Worker/cancel cleanup, hostile decoders, exact byte target, CropBox/UserUnit geometry, and no egress.
A second reviewer focuses on product truthfulness, preset UX, no-reduction guidance, accessibility, route
isolation, static/smoke fidelity, and spec coverage. Fix every Critical/Important finding with a failing
test first and rerun the focused suite. Record any accepted Minor issue explicitly.

- [ ] **Step 2: Run final local verification from the exact feature tree**

```bash
pnpm verify:all
```

Expected: lint, six workspace typechecks, every unit test, production build, explicit static export, and
configured local browser projects pass. Also run focused compression and existing PDF-to-image smokes on a
local Pages preview. Attempt desktop/mobile WebKit if the environment supports its system dependencies;
do not install host packages or silently treat a missing runtime as proof.

- [ ] **Step 3: Audit scope, spec immutability, and unpublished checkpoints**

```bash
git status --short
git diff --check 51acfda..HEAD
git diff --name-status 51acfda..HEAD
git ls-files --error-unmatch docs/superpowers/plans/2026-07-12-scanned-pdf-compression.md
DESIGN=docs/superpowers/specs/2026-07-12-scanned-pdf-compression-design.md
EXPECTED_DESIGN="$(mktemp)"
OLD_BRAND="$(printf '%s%s' Here ItIs)"
git show "70fd61d:$DESIGN" | sed "s/${OLD_BRAND}/HereIsIt/g" > "$EXPECTED_DESIGN"
cmp "$EXPECTED_DESIGN" "$DESIGN"
rm -f "$EXPECTED_DESIGN"
git log --oneline 51acfda..HEAD
```

Expected: only approved readiness, contract/domain, shared runtime, compression pipeline/Worker, route/UI,
tests, static/smoke, docs, spec, and plan files changed; the approved spec differs from `70fd61d` only by
the exact user-approved display-token correction; the implementation plan is tracked by its pre-execution
plan commit; all checkpoints are local.

- [ ] **Step 4: Squash to one release commit without changing the tree**

```bash
BASELINE=51acfda
BEFORE_TREE="$(git rev-parse HEAD^{tree})"
git reset --soft "$BASELINE"
git diff --cached --check
git diff --cached --name-only | rg -x 'docs/superpowers/specs/2026-07-12-scanned-pdf-compression-design.md'
git diff --cached --name-only | rg -x 'docs/superpowers/plans/2026-07-12-scanned-pdf-compression.md'
git commit -m "feat: compress scanned PDFs locally"
test "$BEFORE_TREE" = "$(git rev-parse HEAD^{tree})"
test "$(git rev-list --count "$BASELINE"..HEAD)" -eq 1
```

Expected: one unpublished release commit contains the approved spec, plan, implementation, tests, and
docs. Because both docs were tracked before the soft reset, they are part of the staged tree; do not
reconstruct or omit either file. Do not force-push or publish task checkpoints.

- [ ] **Step 5: Confirm remote baseline, fast-forward local main, and verify the merged result**

```bash
git fetch origin main
test "$(git rev-parse origin/main)" = "$(git rev-parse 51acfda)"
git switch main
git merge --ff-only feat/scanned-pdf-compression
pnpm verify
```

Start local Pages preview and run both smoke scripts again. If `origin/main` moved, do not force; inspect
and integrate the remote change safely before continuing.

- [ ] **Step 6: Publish through the authorized GitHub flow**

Load the GitHub publish skill, confirm `gh` version/auth, clean intended scope, SSH remote
`liorium/hereisit`, and then:

```bash
git push origin main
git rev-list --left-right --count main...origin/main
```

Expected: `0 0`, with no force push and no unrelated files.

- [ ] **Step 7: Require exact-SHA GitHub success with zero flaky retries**

```bash
SHA="$(git rev-parse HEAD)"
RUN_ID=""
for attempt in {1..30}; do
  RUN_ID="$(gh run list --workflow ci.yml --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  test -n "$RUN_ID" && break
  sleep 2
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

Get the browser job log and reject Playwright retry evidence:

```bash
BROWSER_JOB_ID="$(gh run view "$RUN_ID" --json jobs --jq '.jobs[] | select(.name == "browser") | .databaseId')"
LOG_FILE="$(mktemp)"
gh run view "$RUN_ID" --job "$BROWSER_JOB_ID" --log > "$LOG_FILE"
! rg -n '[0-9]+ flaky|##\[notice\].*flaky' "$LOG_FILE"
rm -f "$LOG_FILE"
```

Expected: `verify` plus all five Chromium/Firefox/WebKit/mobile projects succeed for this SHA with no
flaky retry. Preserve the CI URL.

- [ ] **Step 8: Require exact-SHA Cloudflare success and both live smokes**

Poll the commit check-runs until `Cloudflare Pages` is `completed/success`, record its details URL, then:

```bash
node scripts/smoke-pdf-compress.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
```

Expected: the live route, same-origin assets, headers, balanced/minimum/no-reduction compression,
existing PNG/JPG-ZIP conversion, geometry, exact savings, privacy, and no page errors all pass.

- [ ] **Step 9: Confirm final repository state**

```bash
git fetch origin main
git status --short --branch
git rev-list --left-right --count main...origin/main
git log -4 --oneline --decorate
```

Expected: clean `main...origin/main`, `0 0`, and the single release commit at both refs.

- [ ] **Step 10: Perform the requested next-feature product review**

After deployment—not before—inspect current HereIsIt coverage and the current public feature menus of
major browser file-tool competitors. Compare user workflow adjacency, local-first fit, speed, reuse of
the new raster/runtime layers, destructive-risk clarity, implementation cost, SEO/discovery value, and
operational burden. Produce 2–3 candidates with trade-offs and one recommendation; do not start the next
implementation without a fresh brainstorming/spec approval cycle.

- [ ] **Step 11: Report the completed release and recommendation**

Report the live URL, release SHA, local unit/E2E/static counts, exact GitHub run URL, zero-flaky five-browser
evidence, Cloudflare status/details, both production-smoke results, clean repository state, any accepted
Minor issue, and the next-feature comparison/recommendation.

---
