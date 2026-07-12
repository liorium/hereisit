# PDF to Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready, local-only `/pdf/to-image` tool that converts one PDF into a direct JPG/PNG or an ordered ZIP, then verify and deploy it through the existing GitHub and Cloudflare Pages release gates.

**Architecture:** Add an independent `pdf.to-images@1` contract, pure raster-planning helpers, and a dedicated browser Worker path that is never imported by existing PDF editing routes. The renderer owns a pinned PDF.js API plus an explicit same-origin parser Worker, uses Worker-safe `OffscreenCanvas` factories, renders exactly one page at a time, streams multi-page output into ZIP entries, and enforces every resource limit before and after PDF.js viewport creation. A route-owned React workbench reuses the existing local PDF inspection Worker but loads the renderer only on `/pdf/to-image`.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 static export, Zod, Vitest 4, Playwright 1.61, PDF.js `6.1.200`, `fflate` `0.8.3`, Cloudflare Pages, GitHub Actions.

## Global Constraints

- Source bytes and filenames stay inside the tab and its dedicated Workers; never log filenames, bytes, thumbnails, document text, or asset URLs.
- Pin `pdfjs-dist` exactly at `6.1.200`; keep API, parser Worker, CMaps, and standard fonts from that package version and same origin.
- Do not add a CDN, network URL input, server fallback, main-thread renderer, WebAssembly decoder, `wasm-unsafe-eval`, thumbnail, OCR, or partial output.
- Keep existing `pdf.*@1` editing contracts and `PdfWorkbench` behavior unchanged; the new result, errors, Worker protocol types, and workbench are siblings.
- Defaults are every page, JPG quality 85, opaque white background, and 150DPI; PNG hides quality.
- Input is one PDF from 1 byte through 50 MiB; source maximum is 500 pages; output maximum is 100 pages.
- Enforce 8,192px per side, 16,000,000 pixels and 64,000,000 RGBA bytes per managed canvas/page, a 128 MiB simultaneous budget for HereItIs output and custom display-layer `CanvasFactory` canvases, 100,000,000 selected pixels, 100 MiB final output, sequential concurrency of one, and a 180-second watchdog. Disable nested parser `OffscreenCanvas`/`ImageDecoder`; its decoded image arrays retain the per-image 16MP gate but are outside the managed canvas budget.
- Preserve explicit extracted-page order while filenames retain source page numbers. One page returns an image; two or more return a streaming ZIP.
- Rendering and encoding progress must carry actual `completedPages` and `totalPages`; cancellation terminates the top-level Worker immediately and settles once.
- Every canvas, page, render task, archive, PDF document/loading task, parser Worker, result URL, and transferred buffer must have an explicit cleanup path.
- PDF.js `6.1.200` removed the historical `isEvalSupported` document option. Do not pass a no-op property. Preserve the existing CSP without eval permissions, keep `useWasm: false`, and record this version-specific reconciliation in architecture documentation.
- Use MiB (`1024 * 1024`) consistently with existing runtime limits.
- Release browsers are current Chromium, Firefox, desktop WebKit, mobile Chromium, and mobile WebKit. A Worker-chain or OffscreenCanvas failure in any release project blocks publication.
- Follow red-green-refactor for every production behavior and create only one release commit after local verification, as required by the approved rollout.

---

### Task 1: Add the independent `pdf.to-images@1` contract

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/src/index.test.ts`

**Interfaces:**
- Produces `PDF_TO_IMAGES_TOOL_ID`, `PDF_TO_IMAGES_TOOL_VERSION`, `pdfToImagesSpecSchema`, result/error/progress types, and dedicated run/cancel/Worker/job types.
- Does not modify `PdfToolId`, `PdfPipelineSpecV1`, `PdfPipelineResult`, or existing PDF Worker unions.

- [ ] **Step 1: Write failing contract boundary tests**

Add a `describe("pdfToImagesSpecSchema", ...)` block that imports the new constants/schema and covers this exact table:

```ts
const basePdfToImagesSpec = {
  version: 1 as const,
  selection: { mode: "every-page" as const },
  output: { format: "jpeg" as const, quality: 85, background: "#ffffff" as const },
  dpi: 150 as const,
};

it("publishes the independent tool identity", () => {
  expect(PDF_TO_IMAGES_TOOL_ID).toBe("pdf.to-images");
  expect(PDF_TO_IMAGES_TOOL_VERSION).toBe(1);
});

it.each([40, 85, 95])("accepts JPEG quality %i", (quality) => {
  expect(pdfToImagesSpecSchema.safeParse({
    ...basePdfToImagesSpec,
    output: { format: "jpeg", quality, background: "#ffffff" },
  }).success).toBe(true);
});

it.each([39, 40.5, 96])("rejects JPEG quality %s", (quality) => {
  expect(pdfToImagesSpecSchema.safeParse({
    ...basePdfToImagesSpec,
    output: { format: "jpeg", quality, background: "#ffffff" },
  }).success).toBe(false);
});

it.each([96, 150, 300])("accepts %iDPI", (dpi) => {
  expect(pdfToImagesSpecSchema.safeParse({ ...basePdfToImagesSpec, dpi }).success).toBe(true);
});
```

Also assert PNG succeeds without quality; JPEG without quality, WebP, non-white backgrounds, DPI `72`, string DPI, version `2`, empty extraction, duplicate pages, 0, negative, fractional, page 501, and 101 unique pages fail. Assert extraction `[3, 1, 2]` succeeds without sorting.

- [ ] **Step 2: Run the focused test and verify red**

```bash
pnpm test packages/tool-contracts/src/index.test.ts
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the exact schema and protocol surface**

Add the constants and schema:

```ts
export const PDF_TO_IMAGES_TOOL_ID = "pdf.to-images" as const;
export const PDF_TO_IMAGES_TOOL_VERSION = 1 as const;

const pdfToImagesPageNumbersSchema = z
  .array(z.number().int().min(1).max(500))
  .min(1)
  .max(100)
  .refine((pages) => new Set(pages).size === pages.length, {
    message: "페이지 번호는 중복될 수 없습니다.",
  });

export const pdfToImagesSpecSchema = z.object({
  version: z.literal(1),
  selection: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("every-page") }),
    z.object({ mode: z.literal("extract"), pages: pdfToImagesPageNumbersSchema }),
  ]),
  output: z.discriminatedUnion("format", [
    z.object({
      format: z.literal("jpeg"),
      quality: z.number().int().min(40).max(95),
      background: z.literal("#ffffff"),
    }),
    z.object({ format: z.literal("png"), background: z.literal("#ffffff") }),
  ]),
  dpi: z.union([z.literal(96), z.literal(150), z.literal(300)]),
});
```

Add `PdfToImagesSpecV1`, `ParsedPdfToImagesSpecV1`, the approved `PdfToImagesResult`, warning and error unions, and a progress discriminated union in which only `rendering` and `encoding` require `completedPages` and `totalPages`:

```ts
export type PdfToImagesProgress =
  | {
      phase: "rendering" | "encoding";
      fraction: number;
      completedPages: number;
      totalPages: number;
    }
  | {
      phase: "validating" | "loading" | "archiving" | "finalizing";
      fraction: number;
    };
```

Define singular-input `PdfToImagesRunRequest`, `PdfToImagesCancelRequest`, `PdfToImagesWorkerRequest`, `PdfToImagesWorkerEvent`, `PdfToImagesJobOutcome`, and `PdfToImagesJobHandle`. Retain protocol `1`, sequence numbers, transferable input/result `ArrayBuffer`s, and exact tool/version literals. Ready capabilities report `{ offscreenCanvas: boolean; formats: readonly ["jpeg", "png"] }`.

The dedicated error codes are exactly `INVALID_SPEC`, `UNSUPPORTED_INPUT`, `PASSWORD_PROTECTED`, `CORRUPT_PDF`, `PAGE_RANGE_INVALID`, `PAGE_LIMIT`, `MEMORY_LIMIT`, `RENDER_FAILED`, `ENCODE_FAILED`, and `WORKER_CRASH`. Unsupported-browser preflight uses non-retryable `WORKER_CRASH` because the approved error list has no separate browser code.

- [ ] **Step 4: Run schema tests and typecheck**

```bash
pnpm exec biome check --write packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts
pnpm test packages/tool-contracts/src/index.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
```

Expected: all contract tests and typecheck pass.

---

### Task 2: Add pure raster planning and source-relative naming

**Files:**
- Create: `packages/pdf-tool/src/raster-plan.ts`
- Create: `packages/pdf-tool/src/raster-plan.test.ts`
- Modify: `packages/pdf-tool/src/naming.ts`
- Modify: `packages/pdf-tool/src/naming.test.ts`
- Modify: `packages/pdf-tool/src/index.ts`
- Modify: `packages/pdf-tool/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces conservative integer dimensions, page/job resource plans, selection normalization, direct image names, and ZIP names without importing PDF.js or browser APIs.

- [ ] **Step 1: Write failing raster-planning and naming tests**

Test these exact cases:

```ts
expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: 0 }, 96))
  .toEqual({ width: 816, height: 1056 });
expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: 90 }, 150))
  .toEqual({ width: 1650, height: 1275 });
expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: 180 }, 300))
  .toEqual({ width: 2550, height: 3300 });
expect(calculatePdfToImageDimensions({ width: 612, height: 792, rotation: 270 }, 150))
  .toEqual({ width: 1650, height: 1275 });
```

Lock `Math.ceil` with a fractional-point case. Prove an 8,192px side passes and 8,193 fails; 4,000×4,000 pixels/64,000,000 RGBA bytes passes and 4,000×4,001 fails; exactly 100,000,000 selected pixels passes and one pixel more fails. Prove every-page succeeds for 100 and fails for 101, extraction `[3, 1]` stays `[3, 1]`, and invalid geometry, non-quarter rotation, inconsistent inspection indices, and an out-of-range page fail before allocation.

Extend naming expectations:

```ts
expect(pdfToImagePageName("../report.pdf", 1, "jpeg")).toBe("report-page-001.jpg");
expect(pdfToImagePageName("folder/report.pdf", 500, "png")).toBe("report-page-500.png");
expect(pdfToImagesArchiveName("../report.pdf")).toBe("report-images-hereisit.zip");
```

Also test reserved/control characters and the `document` fallback.

- [ ] **Step 2: Run the focused tests and verify red**

```bash
pnpm test packages/pdf-tool/src/raster-plan.test.ts packages/pdf-tool/src/naming.test.ts
```

Expected: FAIL because the helper module and naming exports do not exist.

- [ ] **Step 3: Implement conservative pure planning**

Add `@hereisit/tool-contracts: "workspace:*"` to PDF tool dependencies and use the shared inspection/spec types. Export these constants and shapes:

```ts
export const MAX_PDF_TO_IMAGE_DIMENSION = 8_192;
export const MAX_PDF_TO_IMAGE_PAGE_PIXELS = 16_000_000;
export const MAX_PDF_TO_IMAGES_TOTAL_PIXELS = 100_000_000;
export const MAX_PDF_TO_IMAGES_OUTPUT_PAGES = 100;
export const PDF_TO_IMAGE_RGBA_BYTES_PER_PIXEL = 4;

export interface PdfToImagePagePlan {
  sourcePage: number;
  width: number;
  height: number;
  pixels: number;
  rgbaBytes: number;
}

export interface PdfToImagesRasterPlan {
  pages: readonly PdfToImagePagePlan[];
  totalPixels: number;
}
```

Implement `calculatePdfToImageDimensions`, `calculatePdfToImagePagePlan`, `normalizePdfToImagesPages`, and `planPdfToImagesRasterization`. Normalize rotation modulo 360, allow only quarter turns, swap width/height for 90/270, and use `Math.ceil(points * dpi / 72)`. Preserve extraction order. Validate safe finite arithmetic and throw a typed `PdfToImagesPlanError` carrying `PAGE_RANGE_INVALID`, `PAGE_LIMIT`, or `MEMORY_LIMIT` plus stable Korean corrective copy. Check the cumulative pixel total as pages are planned.

Extend the existing private `safeStem` naming path; always use three page digits because source pages are capped at 500:

```ts
export function pdfToImagePageName(
  filename: string,
  sourcePage: number,
  format: "jpeg" | "png",
): string {
  const extension = format === "jpeg" ? "jpg" : "png";
  return `${safeStem(filename, "document")}-page-${String(sourcePage).padStart(3, "0")}.${extension}`;
}

export function pdfToImagesArchiveName(filename: string): string {
  return `${safeStem(filename, "document")}-images-hereisit.zip`;
}
```

Export `raster-plan` from `packages/pdf-tool/src/index.ts`, then update the lockfile with `pnpm install --lockfile-only`.

- [ ] **Step 4: Format and verify domain boundaries**

```bash
pnpm exec biome check --write packages/pdf-tool packages/pdf-tool/package.json pnpm-lock.yaml
pnpm test packages/pdf-tool/src/raster-plan.test.ts packages/pdf-tool/src/naming.test.ts
pnpm --filter @hereisit/pdf-tool typecheck
```

Expected: domain tests pass with no browser or PDF.js import in `packages/pdf-tool`.

---

### Task 3: Pin and self-host the PDF.js runtime assets

**Files:**
- Modify: `packages/browser-runtime/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/sync-pdfjs-assets.mjs`
- Modify: `apps/web/package.json`
- Modify: `.gitignore`
- Modify: `apps/web/public/_headers`

**Interfaces:**
- Produces deterministic `/pdfjs/6.1.200/pdf.worker.min.mjs`, `/cmaps/*`, and `/standard_fonts/*` files before each web build without committing generated package contents.

- [ ] **Step 1: Add a failing asset-sync/static precondition test**

Create the sync script initially with assertions only, or add an exported `syncPdfjsAssets()` invoked under a direct-run guard. The testable requirements are:

- resolve `packages/browser-runtime/node_modules/pdfjs-dist/package.json`;
- require version exactly `6.1.200`;
- require `build/pdf.worker.min.mjs`, `cmaps/LICENSE`, and `standard_fonts/LICENSE_FOXIT` (or the package's actual license filename);
- remove and recreate only `apps/web/public/pdfjs/6.1.200`;
- copy the parser Worker, complete `cmaps`, and complete `standard_fonts` trees;
- never copy `wasm`.

Run before installing the dependency:

```bash
node scripts/sync-pdfjs-assets.mjs
```

Expected: FAIL with a stable missing/pinned-package assertion.

- [ ] **Step 2: Pin the dependency and implement deterministic copying**

Add exact `"pdfjs-dist": "6.1.200"` under browser-runtime dependencies and update the lockfile. Implement the Node script using `node:fs/promises` `rm`, `mkdir`, `cp`, `readFile`, and `access`; never shell out. Replace the existing web `dev`/`build` commands so asset sync is part of the command itself and cannot be skipped by Turbo lifecycle/cache behavior:

```json
{
  "scripts": {
    "dev": "node ../../scripts/sync-pdfjs-assets.mjs && next dev",
    "build": "node ../../scripts/sync-pdfjs-assets.mjs && next build"
  }
}
```

to `apps/web/package.json`, add `apps/web/public/pdfjs/` to `.gitignore`, and add immutable caching without weakening security headers:

```text
/pdfjs/6.1.200/*
  Cache-Control: public, max-age=31536000, immutable
```

Preserve `worker-src 'self' blob:` and do not add any eval or WASM CSP capability.

- [ ] **Step 3: Verify package version, licenses, assets, and no WASM**

```bash
pnpm install --frozen-lockfile
node scripts/sync-pdfjs-assets.mjs
test -f apps/web/public/pdfjs/6.1.200/pdf.worker.min.mjs
test -f apps/web/public/pdfjs/6.1.200/cmaps/Adobe-Japan1-UCS2.bcmap
test -d apps/web/public/pdfjs/6.1.200/standard_fonts
test ! -e apps/web/public/pdfjs/6.1.200/wasm
node -e 'const p=require("./packages/browser-runtime/node_modules/pdfjs-dist/package.json"); if(p.version!=="6.1.200") process.exit(1)'
```

Expected: all commands pass and `git status --short` does not list generated PDF.js files.

---

### Task 4: Build the sequential PDF.js renderer pipeline

**Files:**
- Create: `packages/browser-runtime/src/pdf-to-images-pipeline.ts`
- Create: `packages/browser-runtime/src/pdf-to-images-pipeline.test.ts`

**Interfaces:**
- Consumes one transferred input, parsed `pdf.to-images@1` spec, and an injectable renderer adapter.
- Produces direct image or ZIP bytes, honest progress, deterministic errors, and cleanup evidence without public Worker lifecycle concerns.

- [ ] **Step 1: Write a deterministic fake-adapter test suite first**

Define fake loading task, document, page, render task, canvas, Blob encoder, and archive hooks with counters. Cover:

- one selected page returns direct JPEG/PNG MIME, signature, source-relative name, counts, warnings, and all timing fields;
- two or more pages stream an ordered ZIP whose entry names keep selection order and source numbers;
- progress phase order begins `validating`, `loading`, then repeats `rendering`/`encoding` with exact page counts, optionally `archiving`, and ends `finalizing`;
- known inspection/resource budgets fail before `createCanvas`;
- a PDF.js viewport beyond 8,192/16MP fails before render;
- final direct output and cumulative ZIP output fail above 100 MiB;
- password, corrupt, page range, render, and encode failures map to exact error codes;
- success, failure, and `AbortController.abort()` cancellation cancel an active render when applicable, call `page.cleanup()`, zero canvases, terminate an unfinished ZIP, call `document.cleanup()`, destroy loading task, destroy `PDFWorker`, terminate its supplied parser port, and drop page/input references;
- custom display-layer PDF.js scratch-canvas create/reset rejects an over-8,192 side, over-16MP canvas, and simultaneous HereItIs-managed canvas usage above 128 MiB, then releases the budget on destroy;
- maximum active canvas/render count is exactly one.

Run:

```bash
pnpm test packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
```

Expected: FAIL because the pipeline does not exist.

- [ ] **Step 2: Implement typed errors, injected seams, and preflight gates**

Export `PdfToImagesPipelineError`, `toPdfToImagesErrorPayload`, `PdfToImagesRendererAdapter`, and `runPdfToImagesPipeline`. Parse with `pdfToImagesSpecSchema`, validate MIME hint/extension plus `%PDF-` signature, 1..50 MiB, source <=500, selection <=100, and the pure raster plan before canvas allocation.

Use these pipeline options:

```ts
export interface PdfToImagesPipelineOptions {
  adapter?: PdfToImagesRendererAdapter;
  onProgress?: (progress: PdfToImagesProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}
```

Register one abort listener that immediately cancels the active render task, terminates an unfinished archive, and makes the pipeline throw a private cancellation error. Remove the listener in `finally`; the Worker suppresses that private error after its controller is aborted. Never expose partial bytes.

- [ ] **Step 3: Implement the Worker-safe PDF.js adapter**

Dynamically import `getDocument`, `PDFWorker`, password/error classes, `VerbosityLevel`, and version from the published `pdfjs-dist` package root only in the default adapter. Its `main` resolves to `build/pdf.mjs` while retaining the package's published declarations; do not deep-import the untyped build path. Assert `version === "6.1.200"` before loading.

Explicitly create and own the parser port and wrapper:

```ts
const parserPort = new Worker(
  new URL("/pdfjs/6.1.200/pdf.worker.min.mjs", self.location.origin),
  { type: "module", name: "hereisit-pdfjs-parser-worker" },
);
const pdfWorker = new PDFWorker({ port: parserPort });
```

Never allow PDF.js to call its default `window.location` Worker initializer or fake-worker fallback. The adapter's finally path destroys `pdfWorker` and explicitly terminates `parserPort` because a caller-supplied port is not terminated by `PDFWorker.destroy()`.

Provide constructor-compatible Worker factories:

- `WorkerCanvasFactory` creates `OffscreenCanvas`, obtains a non-null 2D context with `willReadFrequently`, resets dimensions only after zeroing the old backing store, and destroys by setting width/height to zero and clearing the holder. It owns a shared `WorkerCanvasBudget` that validates every output and custom display-layer scratch canvas against 8,192px/16MP, accounts reset deltas, caps all simultaneously live HereItIs-managed canvas RGBA allocations at 128 MiB, and releases each holder exactly once. A budget exception must survive PDF.js wrapping and map to `MEMORY_LIMIT`, not generic `RENDER_FAILED`.
- `WorkerFilterFactory` implements PDF.js's filter-factory surface with `"none"` results and no DOM access.

Use `disableFontFace: true` and `useSystemFonts: false` so font rendering stays Worker-safe, but supply versioned `standardFontDataUrl`. Set `useWorkerFetch: true` so the nested parser Worker loads packed CMaps/fonts directly from the same origin. Call only:

```ts
getDocument({
  data: new Uint8Array(input.bytes),
  worker: pdfWorker,
  cMapUrl: `${assetBase}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}standard_fonts/`,
  useWorkerFetch: true,
  useWasm: false,
  enableXfa: false,
  stopAtErrors: true,
  disableFontFace: true,
  useSystemFonts: false,
  maxImageSize: MAX_PDF_TO_IMAGE_PAGE_PIXELS,
  canvasMaxAreaInBytes: MAX_PDF_TO_IMAGE_PAGE_PIXELS * PDF_TO_IMAGE_RGBA_BYTES_PER_PIXEL,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  verbosity: VerbosityLevel.ERRORS,
  CanvasFactory: WorkerCanvasFactory,
  FilterFactory: WorkerFilterFactory,
});
```

Do not pass a URL for the PDF and do not pass removed `isEvalSupported`. Use the existing CSP as the effective eval prohibition. Disabling the nested parser's canvas/decoder paths prevents its untracked maximum-canvas probe; `maxImageSize` still limits each parser-decoded image, but those decoded arrays are not part of `WorkerCanvasBudget`, so document this boundary rather than claiming a total-process 128 MiB cap.

- [ ] **Step 4: Render, encode, and archive exactly one page at a time**

For each selected source page:

1. get the page and viewport at `scale = dpi / 72`;
2. ceil viewport dimensions and repeat every per-page/job resource gate;
3. allocate one OffscreenCanvas and fill opaque white;
4. render with the page viewport and white background, retaining the cancellable render task;
5. encode using `convertToBlob({ type, quality: quality / 100 })` for JPEG or `{ type: "image/png" }`;
6. check encoded/cumulative output bytes before accepting results;
7. direct-return one page or push one `ZipPassThrough` entry into a level-0 `fflate.Zip` archive;
8. release encoded bytes, clean page, and zero canvas before advancing.

ZIP `ondata` counts chunks before retaining them, aborts above 100 MiB, and only concatenates after successful `final: true`. Preserve selected order. Both result kinds always include `PDF_PAGE_RASTERIZED` and `COLOR_PROFILE_NORMALIZED` once each.

- [ ] **Step 5: Verify pipeline behavior and types**

```bash
pnpm exec biome check --write packages/browser-runtime/src/pdf-to-images-pipeline.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
pnpm test packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: all deterministic pipeline tests pass and Node tests never instantiate real PDF.js browser APIs.

---

### Task 5: Add the dedicated Worker and public job lifecycle

**Files:**
- Create: `packages/browser-runtime/src/pdf-to-images.worker.ts`
- Create: `packages/browser-runtime/src/pdf-to-images.worker.test.ts`
- Create: `packages/browser-runtime/src/run-pdf-to-images-job.ts`
- Create: `packages/browser-runtime/src/run-pdf-to-images-job.test.ts`
- Modify: `packages/browser-runtime/src/index.ts`
- Modify: `packages/browser-runtime/package.json`

**Interfaces:**
- Exposes `supportsBrowserPdfToImagesRuntime()` and `runPdfToImagesJob(file, spec, options)` from `@hereisit/browser-runtime/pdf-to-images`.

- [ ] **Step 1: Write lifecycle tests before implementation**

Use a stub Worker like `run-pdf-job.test.ts` and cover:

- support requires `Worker`, `File`, `OffscreenCanvas`, a non-null 2D context, and `convertToBlob`;
- unsupported runtime returns a non-retryable `WORKER_CRASH` before calling `file.arrayBuffer()`;
- invalid 0-byte/>50MiB files reject before Worker construction/read;
- construction error and message-decoding failure settle once;
- cancel before read resolution posts no run request;
- cancel after posting sends one cancel, terminates exactly once, and ignores late events;
- 180-second watchdog rejects retryably and terminates once;
- wrong-job, wrong-protocol, stale progress, stale complete, duplicate terminal, and callback exceptions do not change the settled outcome;
- input `postMessage` and complete result use the exact transfer list.

Run and verify red:

```bash
pnpm test packages/browser-runtime/src/run-pdf-to-images-job.test.ts
```

- [ ] **Step 2: Implement support probing and the public handle**

Probe support without allocating a large canvas: create `new OffscreenCanvas(1, 1)`, require a 2D context and callable `convertToBlob`, then zero it. The public handle must set `settled`/`cancelled` guards before inspecting events, start its watchdog at handle creation, publish an initial validating callback before asynchronously calling `file.arrayBuffer()`, transfer the input buffer, and terminate the Worker in the single `settle()` path.

Construct only:

```ts
new Worker(new URL("./pdf-to-images.worker.ts", import.meta.url), {
  type: "module",
  name: "hereisit-pdf-to-images-worker",
});
```

Never fall back to `runPdfJob` or main-thread code.

- [ ] **Step 3: Implement Worker validation, progress, cancel, and transfer**

The Worker accepts only protocol 1 plus exact tool/version and only one active job. It owns an `AbortController` for that job, passes `controller.signal` into the pipeline, forwards progress with monotonic sequence values, suppresses output after cancel, maps all errors through `toPdfToImagesErrorPayload`, and transfers `result.bytes` on completion. Its ready event advertises current capabilities without reading any file.

On cancel, call `controller.abort()` immediately. The public handle also terminates the top-level Worker immediately, so the Worker cleanup path is best effort and never delays the cancelled outcome.

Test the Worker module with a stub scope/pipeline: malformed protocol and mismatched tool/version never run; only one active job is accepted; cancel reaches the active abort signal; progress sequence numbers increase; structured failure contains no raw exception/source data; and completion passes `[result.bytes]` as its transfer list.

- [ ] **Step 4: Export the isolated entry point and verify lifecycle**

Add:

```json
"./pdf-to-images": "./src/run-pdf-to-images-job.ts"
```

and export the public functions/types from `src/index.ts` only if that does not make shared imports eager; route code must import the explicit subpath.

```bash
pnpm exec biome check --write packages/browser-runtime/src/pdf-to-images.worker.ts packages/browser-runtime/src/pdf-to-images.worker.test.ts packages/browser-runtime/src/run-pdf-to-images-job.ts packages/browser-runtime/src/run-pdf-to-images-job.test.ts packages/browser-runtime/src/index.ts packages/browser-runtime/package.json
pnpm test packages/browser-runtime/src/run-pdf-to-images-job.test.ts packages/browser-runtime/src/pdf-to-images.worker.test.ts packages/browser-runtime/src/pdf-to-images-pipeline.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
```

Expected: lifecycle and pipeline suites pass; `rg "pdfjs-dist" packages/browser-runtime/src/run-pdf-job.ts packages/browser-runtime/src/pdf.worker.ts` returns no match.

---

### Task 6: Add the isolated `/pdf/to-image` workbench

**Files:**
- Create: `apps/web/src/app/pdf/to-image/page.tsx`
- Create: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify: `apps/web/src/components/pdf-tool-page.tsx`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Modify: `apps/web/src/lib/site.ts`
- Modify: `tests/e2e/tool-pages.spec.ts` (route/card/canonical/sitemap RED/GREEN only)
- Modify: `tests/e2e/pdf-tools.spec.ts` (PDF route registry RED/GREEN only)

**Interfaces:**
- Reuses `inspectPdfFile()` for bounded dimensions/page count and calls the dedicated runtime only after UI preflight.
- Keeps `PdfToImageWorkbench` imported by the new route, not by shared route/page modules.

- [ ] **Step 1: Add route/registry and render-isolation tests first**

Extend existing site/tool tests or E2E route matrices so `/pdf/to-image`, its title, canonical link, home card, related cards, and sitemap are expected. Run the narrow route test and verify red:

```bash
pnpm build
pnpm test:e2e --project=chromium tests/e2e/tool-pages.spec.ts
```

Expected: FAIL because the route/card does not exist.

- [ ] **Step 2: Register the tool and preserve editor typing**

Extend `PdfToolIntent` with `"to-image"` and add:

```ts
"to-image": {
  intent: "to-image",
  path: "/pdf/to-image",
  navLabel: "PDF→이미지",
  eyebrow: "PDF TO IMAGE",
  title: "PDF를 JPG·PNG로 변환",
  description:
    "PDF 페이지를 JPG 또는 PNG 이미지로 변환하세요. 업로드 없이 브라우저에서 처리합니다.",
  defaultSummary:
    "기본값은 모든 페이지를 150DPI JPG(품질 85)로 만들고, 한 장은 이미지로 여러 장은 ZIP으로 저장해요.",
  warning:
    "결과는 래스터 이미지라 텍스트를 검색하거나 선택할 수 없고, 주석·양식 모양은 평면화되며 색상 프로필이 달라질 수 있어요.",
  steps: [
    { title: "PDF 선택", description: "변환할 PDF 한 개를 기기에서 선택하세요." },
    { title: "변환 설정", description: "페이지·JPG/PNG·해상도와 JPG 품질을 정하세요." },
    { title: "이미지 저장", description: "한 장은 이미지로, 여러 장은 ZIP으로 저장해요." },
  ],
},
```

Update the home description. Introduce `PdfEditingIntent = Exclude<PdfToolIntent, "to-image">` and type `PdfWorkbench` plus `INTENT_CONFIG` with it; do not add a renderer branch to the existing editor.

Change `PdfToolPage` to accept optional `workbench?: ReactNode` and render `workbench` when supplied; otherwise render `<PdfWorkbench intent={tool.intent} />` only inside an explicit `tool.intent !== "to-image"` branch so TypeScript narrows to `PdfEditingIntent`. The new route imports `PdfToImageWorkbench` and passes it. No shared component may statically import the new workbench.

- [ ] **Step 3: Implement the dedicated state machine and validation**

State defaults:

```ts
selectionMode = "every-page";
pageRange = "1-3, 5";
format = "jpeg";
dpi = 150;
quality = 85;
```

Own one file, inspection/result, inspecting/processing flags, message, progress, and refs for file input, inspection/job handles, monotonic run ID, Blob, and object URL. On file replacement, every setting change, rerun, reset, and unmount, revoke the previous URL and cancel stale handles. Never put page bitmaps/Blobs or a thumbnail array in React state.

Before file read, reject unsupported runtime with:

```text
이 브라우저에서는 PDF를 이미지로 변환할 수 없어요. 최신 Safari, Chrome, Firefox 또는 Edge를 사용해 주세요.
```

Accept exactly one PDF from 1 byte through 50 MiB. Inspect it with `inspectPdfFile`; derive extraction with `parsePageSelection(pageRange, inspection.pageCount)` and run `planPdfToImagesRasterization` for both modes. Disable the run button and show exact corrective copy for invalid syntax, empty/out-of-document extraction, >100 outputs, and known dimension/pixel violations. Never lower DPI or remove pages automatically.

Before constructing `runPdfToImagesJob`, set processing/validating UI and await one `requestAnimationFrame` so the busy state paints before full input transfer.

- [ ] **Step 4: Implement accessible controls, honest progress, result, and cleanup**

Render semantic groups for:

- `변환할 페이지`: `모든 페이지` / `지정 페이지`, with text input label `페이지 범위`;
- `출력 형식`: JPG / PNG;
- `해상도`: 96 / 150 / 300DPI;
- conditional range `JPG 품질 85`, min 40/max 95.

Use progress event counts for `12/40페이지 렌더링 중` and encoding equivalents; other phases use stable labels. Add `role="progressbar"`, `aria-valuenow`, and count-based `aria-valuetext`. Keep an immediate `작업 중단` action.

One result uses `이미지 저장·공유 ↓`; multi-page output uses `결과 N개 ZIP으로 받기 ↓`. The result panel repeats that text is no longer searchable/selectable, annotations/forms are flattened as rendered, and canvas color profiles may normalize. Reuse share-then-download behavior and never auto-download.

Extend the existing module CSS only for required settings/progress/result semantics. Preserve the desktop three-column layout, <=800px stacking, >=44px controls, >=16px mobile text input, safe-area sticky action bar, reduced motion, and no horizontal overflow.

- [ ] **Step 5: Verify route types and existing editor regressions**

```bash
pnpm exec biome check --write apps/web/src/app/pdf/to-image/page.tsx apps/web/src/components/pdf-to-image-workbench.tsx apps/web/src/components/pdf-tool-page.tsx apps/web/src/components/pdf-workbench.tsx apps/web/src/components/pdf-workbench.module.css apps/web/src/lib/site.ts
pnpm --filter @hereisit/web typecheck
pnpm build
pnpm test:e2e --project=chromium tests/e2e/tool-pages.spec.ts tests/e2e/pdf-tools.spec.ts
```

Expected: route metadata/navigation pass and all existing PDF editing E2E remain green.

---

### Task 7: Lock browser output, privacy, mobile layout, and static isolation

**Files:**
- Create: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `scripts/verify-static-export.mjs`
- Create: `scripts/smoke-pdf-to-images.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Proves real PDF.js rendering in every release engine and proves old routes do not load renderer/parser assets.

- [ ] **Step 1: Add real browser conversion tests**

Create vector PDFs with `@cantoo/pdf-lib`; do not commit binary fixtures. Add helpers that parse JPEG SOF dimensions and PNG IHDR dimensions, and use `unzipSync` for archives. Never assert codec byte equality.

Primary tests:

1. Two 612×792pt vector pages, default JPG 85/150DPI -> `report-images-hereisit.zip`, entries `report-page-001.jpg`, `report-page-002.jpg`, valid `FFD8` signatures, 1275×1650 dimensions.
2. A two-page document whose second 612×792pt page is rotated 90°, extraction `2`, PNG/96DPI -> direct `report-page-002.png`, valid PNG signature, 1056×816 dimensions.
3. Invalid grammar, page above document, and >100 every-page/extraction disable run with corrective copy; quality is visible for JPG and absent for PNG.
4. Mutation-observed progress contains count-based rendering/encoding copy; cancel settles without a result; rerun/reset/download naming and object URL revocation are correct.

For each conversion, listen before upload and assert no external request, no method outside GET/HEAD, no request body, no failed request, and no `pageerror`. Same-origin GETs for versioned parser/CMap/font assets are allowed.

- [ ] **Step 2: Add route and mobile regression coverage**

Add `/pdf/to-image` to route/title/select-button matrices. Add a mobile test that proves file/settings/result DOM order; fieldsets, range input, run/cancel/save controls are >=44px; text input is >=16px; action bar remains viewport-sticky; and document scroll width does not exceed client width.

- [ ] **Step 3: Harden static-export verification against eager loading**

Add route metadata and assert exported existence of:

- `pdf/to-image.html`;
- renderer Worker marker `hereisit-pdf-to-images-worker`;
- parser Worker `pdfjs/6.1.200/pdf.worker.min.mjs`;
- every packed CMap and standard-font file present in the pinned package, plus their licenses (enumerate source and output trees and compare relative-file sets).

Read scripts referenced by three separate page groups. For each group, recursively follow literal `/_next/*.js` chunk references reachable from the HTML scripts; also use the complete emitted-JavaScript inventory to locate Worker/PDF.js markers and fail if a marker cannot be assigned to the expected route closure:

- image routes: contain image Worker, no existing PDF Worker, no PDF-to-images/PDF.js marker;
- existing PDF edit routes: contain existing PDF Worker, no PDF-to-images/PDF.js marker;
- `/pdf/to-image`: contains existing inspection Worker plus the PDF-to-images Worker; PDF.js may live in the Worker or a dynamic child chunk and must be present in the global inventory without appearing in either old-route closure.

Also scan exported HTML/scripts for CDN PDF.js URLs and reject them. Because Turbopack can encode a transitive chunk through runtime IDs rather than a literal URL, add browser request assertions as the authoritative lazy-load gate: visiting each old image/PDF route must request no `/pdfjs/` asset and no PDF-to-images Worker, while an actual conversion on the new route must request the same-origin parser Worker. Do not require CMaps/fonts to be eagerly requested for PDFs that do not use them.

- [ ] **Step 4: Update truthful architecture and release documentation**

Document `pdf.to-images@1`, exact defaults/limits, sequential local rasterization, pinned/self-hosted PDF.js assets, no WASM/CDN/server fallback, direct-vs-ZIP behavior, raster/search/color caveat, and the PDF.js 6.1.200 removal of `isEvalSupported` with CSP retained as the eval boundary. Update deployment smoke steps for one direct PNG and one multi-page JPG ZIP.

Create `scripts/smoke-pdf-to-images.mjs` as a repeatable Playwright smoke command. It accepts the base URL as its first argument (default `https://hereisit.pages.dev`), generates its PDF inputs in memory, checks `/pdf/to-image`, `/pdfjs/6.1.200/pdf.worker.min.mjs`, `/pdfjs/6.1.200/cmaps/Adobe-Japan1-UCS2.bcmap`, and `/pdfjs/6.1.200/standard_fonts/LiberationSans-Regular.ttf`, verifies security headers, performs the direct rotated PNG and two-page JPG ZIP flows, parses signatures/dimensions/names, rejects external/write/body requests and page errors, closes the browser in `finally`, and prints only a generic success line.

- [ ] **Step 5: Run focused browser and export verification**

```bash
pnpm build
pnpm verify:export
pnpm test:e2e --project=chromium tests/e2e/pdf-to-images.spec.ts tests/e2e/mobile.spec.ts tests/e2e/tool-pages.spec.ts
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e --project=webkit tests/e2e/pdf-to-images.spec.ts
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e --project=mobile-webkit tests/e2e/mobile.spec.ts
```

Expected: real output signatures/dimensions, mobile, privacy, and lazy-loading checks pass. If a parser Worker/CMap is requested only for a relevant fixture, the privacy assertion permits that same-origin GET.

---

### Task 8: Review, verify, squash task checkpoints, publish, and prove production

**Files:**
- Review all files changed by Tasks 1–7.
- Do not create a new deployment workflow; Cloudflare remains Git-integrated.

- [ ] **Step 1: Run automated implementation review and address findings**

Use `superpowers:requesting-code-review` with the approved spec and this plan. Require reviewers to inspect contract drift, Worker/port cleanup, memory limits, no partial ZIP, lazy imports, filename/privacy logging, object URL revocation, all-browser assumptions, and test fidelity. Fix High/Medium findings with new failing tests first and rerun focused suites.

- [ ] **Step 2: Run complete local verification**

```bash
pnpm verify:all
```

Expected: lint, every workspace typecheck, all unit tests, production build, static export checks, and configured local browser projects pass. Then run WebKit explicitly if local default omitted it:

```bash
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e
```

- [ ] **Step 3: Audit scope and squash local task checkpoints into the single release commit**

```bash
git status --short
git diff --check
git diff --stat
git diff --name-status
git diff -- docs/superpowers/specs/2026-07-11-pdf-to-images-design.md
```

Expected: only approved plan, contract/domain, pinned assets/build wiring, renderer/runtime, route/workbench, tests, and truthful docs changed; the approved spec itself remains unchanged.

Subagent-driven development may create local checkpoint commits so each task can be reviewed by an exact diff. After all reviews and verification pass, squash those unpublished checkpoints back to the recorded baseline and create the one commit that will be pushed:

```bash
BASELINE=6cebb03
git reset --soft "$BASELINE"
git add .gitignore README.md apps docs packages scripts tests package.json pnpm-lock.yaml
git commit -m "feat: convert PDF pages to images locally"
test "$(git rev-list --count "$BASELINE"..HEAD)" -eq 1
```

Expected: one release commit contains the complete approved feature; no task checkpoint is pushed to `main`.

- [ ] **Step 4: Synchronize and push `main`**

```bash
git fetch origin main
git rev-list --left-right --count HEAD...origin/main
git push origin main
```

Expected before push: remote-right count `0`; after push: release SHA is on `origin/main`.

- [ ] **Step 5: Require current-SHA GitHub and Cloudflare success**

```bash
set -euo pipefail
SHA="$(git rev-parse HEAD)"
RUN_ID=""
for attempt in {1..30}; do
  RUN_ID="$(gh run list --workflow ci.yml --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json url --jq '.url'

for attempt in {1..60}; do
  IFS=$'\t' read -r STATUS CONCLUSION DETAILS <<< "$(
    gh api "repos/liorium/hereisit/commits/$SHA/check-runs" \
      --jq '[.check_runs[] | select(.name == "Cloudflare Pages")][0] | [(.status // ""), (.conclusion // ""), (.details_url // "")] | @tsv'
  )"
  if [[ "$STATUS" == "completed" ]]; then
    test "$CONCLUSION" = "success"
    printf '%s\n' "$DETAILS"
    break
  fi
  sleep 5
done
test "$STATUS" = "completed"
test "$CONCLUSION" = "success"
```

Expected: `verify` plus all five browser projects pass for the exact SHA, and the Cloudflare Pages check is `completed/success`.

- [ ] **Step 6: Run live route/asset and JPG/PNG smoke tests**

```bash
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
```

The tracked smoke command asserts:

- route, parser Worker, `Adobe-Japan1-UCS2.bcmap`, and `LiberationSans-Regular.ttf` return HTTP 200;
- the route response retains CSP, `nosniff`, frame denial, no-referrer, and permissions policy;
- one rotated selected page downloads a correctly named/dimensioned PNG;
- two pages download an ordered, correctly named JPG ZIP at 150DPI;
- no external/write/body request and no page error occurs.

The smoke script generates PDFs in memory, relies on Playwright-managed temporary downloads, closes the browser in `finally`, and never prints filenames or PDF contents.

- [ ] **Step 7: Record the release and next product step**

```bash
git status --short --branch
git log -4 --oneline --decorate
```

Expected: clean `main...origin/main`. Report the live URL, release SHA, local unit/E2E counts, GitHub run URL, Cloudflare result, live JPG/PNG evidence, and the next recommended feature after this deployment.
