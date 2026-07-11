# PDF to Images Design

**Status:** Approved on 2026-07-11

## Summary

Add a new local-only `/pdf/to-image` tool that rasterizes selected PDF pages into JPG or PNG files. One
selected page downloads directly as an image; multiple selected pages download in one ZIP. Rendering runs
sequentially in a dedicated browser Worker so existing PDF editing routes do not load the renderer and the
UI thread stays responsive.

## Goals

- Convert one local PDF into JPG or PNG without uploading its bytes or filename.
- Default to JPG quality 85 at 150DPI, with PNG and 96/150/300DPI choices.
- Support every page or a validated range, with at most 100 output pages.
- Produce honest page-count progress and an immediate cancel action.
- Bound canvas, total pixel, output, input, page-count, and elapsed-time resources.
- Keep the rendering engine replaceable behind `pdf.to-images@1`.

## Non-goals

- OCR, searchable output, or preservation of vector text.
- Page thumbnails or a visual page picker.
- Password entry or password-protected PDF conversion.
- Server rendering or a file-upload fallback.
- PDF compression, embedded-image extraction, or lossless recovery of original page images.
- Arbitrary DPI values, automatic DPI reduction, or partial results after a failed page.
- PDFium or MuPDF in version 1.
- PDF.js WebAssembly decoders in version 1.

## Approach decision

Version 1 uses Mozilla PDF.js `6.1.200`, pinned exactly and self-hosted. PDF.js is Apache-2.0 and provides
the required `getDocument()`, `getPage()`, `getViewport()`, and canvas render flow. The renderer is isolated
from the existing `@cantoo/pdf-lib` editing pipeline because that library can copy and edit PDF objects but
does not rasterize pages.

PDFium WASM remains a future engine behind the same contract if representative browser benchmarks or
rendering fixtures show PDF.js is insufficient. MuPDF is excluded because its AGPL/commercial licensing
does not fit this release. Server rendering is excluded because it violates the product's explicit local
processing boundary.

References:

- https://github.com/mozilla/pdf.js/releases/tag/v6.1.200
- https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
- https://github.com/mozilla/pdf.js/wiki/frequently-asked-questions
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas

## Versioned contract

Add an independent contract instead of widening `PdfPipelineResult`, whose existing semantics describe PDF
documents and PDF archives.

```ts
const PDF_TO_IMAGES_TOOL_ID = "pdf.to-images";
const PDF_TO_IMAGES_TOOL_VERSION = 1;

type PdfToImagesSpecV1 = {
  version: 1;
  selection:
    | { mode: "every-page" }
    | { mode: "extract"; pages: number[] };
  output:
    | { format: "jpeg"; quality: number; background: "#ffffff" }
    | { format: "png"; background: "#ffffff" };
  dpi: 96 | 150 | 300;
};
```

JPEG quality is an integer from 40 through 95 and defaults to 85. Selected page numbers are unique,
one-based integers from 1 through 500. The `extract` branch accepts at most 100 pages. The runtime applies
the same 100-page output limit to `every-page` after it learns the source document page count.

The dedicated result is:

```ts
type PdfToImagesResult = {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "application/zip";
  byteLength: number;
  sourcePageCount: number;
  outputPageCount: number;
  outputFileCount: number;
  format: "jpeg" | "png";
  warnings: ("PDF_PAGE_RASTERIZED" | "COLOR_PROFILE_NORMALIZED")[];
  timing: {
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    archiveMs: number;
    totalMs: number;
  };
};
```

Worker progress phases are `validating`, `loading`, `rendering`, `encoding`, `archiving`, and
`finalizing`. Rendering and encoding events include `completedPages` and `totalPages` so the UI can say
`12/40페이지 렌더링 중` rather than infer work from a timer.

## Components and boundaries

### Domain helpers

`@hereisit/pdf-tool` owns pure functions for:

- Converting PDF points and rotation into integer output width and height at an allowed DPI.
- Calculating per-page pixels, RGBA bytes, and total selected pixels before execution.
- Naming `report-page-001.jpg`, `report-page-001.png`, and `report-images-hereisit.zip` safely.
- Normalizing selected pages without reading PDF bytes.

These helpers have no PDF.js or browser dependency.

### Browser runtime

The renderer uses three focused modules:

- `pdf-to-images-pipeline.ts`: PDF.js adapter, resource gates, sequential render/encode/archive flow.
- `pdf-to-images.worker.ts`: protocol validation, progress forwarding, cancellation, and transferable result.
- `run-pdf-to-images-job.ts`: File reading, Worker lifecycle, three-minute watchdog, and stale-event guard.

The implementation imports PDF.js only from this renderer path. Other image and PDF routes must not include
or initialize PDF.js.

### Web application

`PdfToImageWorkbench` is separate from the existing `PdfWorkbench`, which already coordinates five PDF
editing intents. It owns one file, page inspection, format/DPI/quality/range settings, result Blob and object
URL, progress, cancel, save/share, and reset.

The route intent is `to-image`, with path `/pdf/to-image`, title `PDF를 JPG·PNG로 변환`, and one new card in
the existing PDF tool list. Sitemap and related-tool lists continue to derive from that registry.

## PDF.js loading and security

- Pin `pdfjs-dist` to exactly `6.1.200` in the browser runtime package and lockfile.
- Bundle the API and worker from the same package version to prevent API/worker mismatch.
- Self-host required packed CMaps and standard-font data on the same Cloudflare Pages origin.
- Load the PDF only as a transferred `Uint8Array`; never pass a URL to `getDocument()`.
- Set `isEvalSupported: false`, `useWasm: false`, `enableXfa: false`, and `stopAtErrors: true`.
- Set packed CMap and standard-font URLs to versioned same-origin assets.
- Do not add `wasm-unsafe-eval` to the current CSP in version 1.
- Do not use a CDN or runtime third-party connection.

The top-level renderer is a dedicated module Worker. PDF.js may use its pinned self-hosted parser Worker
inside that boundary. A release browser that cannot initialize the complete Worker chain receives a
non-retryable unsupported-browser error; the implementation does not move page rendering onto the UI
thread as a silent fallback.

## User experience

After one PDF is selected, the existing bounded inspection Worker returns only page count, point dimensions,
and rotation. The UI does not create thumbnails. Inspection allows the UI to validate page count and estimate
the selected pixel budget before starting the larger renderer.

Settings are:

- `모든 페이지 / 지정 페이지`, using the existing `1-3, 5` grammar.
- `JPG / PNG`, default JPG.
- `96 / 150 / 300DPI`, default 150DPI.
- JPEG quality 40 through 95, default 85; hidden when PNG is selected.

The run button is disabled for invalid syntax, no selected pages, more than 100 selected pages, a page beyond
the inspected document, or a known dimension/pixel budget violation. The UI explains the exact corrective
action and never silently lowers DPI or drops pages.

The feature is enabled only when module Workers, `OffscreenCanvas`, a 2D context, and
`OffscreenCanvas.convertToBlob()` are available. An unsupported release browser receives a stable Korean
compatibility message before a file is read.

One output page returns `image/jpeg` or `image/png` directly. Two or more output pages return a streaming ZIP
whose entries follow selected page order while filenames retain source page numbers. JPG and PNG both use an
opaque white page background, matching ordinary PDF viewer presentation.

The result panel states that output pages are raster images: text is no longer searchable or selectable,
annotations and form appearances are flattened where PDF.js renders them, and color profiles may normalize
to the browser canvas color space.

## Sequential data flow

```text
File
  -> bounded local inspection
  -> validated PdfToImagesSpecV1
  -> transferred ArrayBuffer
  -> dedicated renderer Worker
  -> PDF.js document from Uint8Array
  -> one selected page
  -> rotated viewport at selected DPI
  -> bounded OffscreenCanvas
  -> render to opaque white canvas
  -> convertToBlob(JPG or PNG)
  -> direct result or one streaming ZIP entry
  -> page cleanup and canvas reset
  -> repeat
  -> transferable final ArrayBuffer
  -> one UI Blob and one object URL
```

No page bitmap, image Blob, or object URL collection is retained in React state. A multi-page archive retains
only bounded ZIP output chunks; each encoded page buffer becomes eligible for collection after its archive
entry is accepted.

## Resource limits

- Input: exactly one PDF, 1 byte through 50MB.
- Source document: at most 500 pages.
- Output selection: 1 through 100 pages.
- Output canvas: each dimension at most 8,192px.
- Per-page canvas: at most 16,000,000 pixels, equivalent to at most 64MB of RGBA pixels.
- Selected job total: at most 100,000,000 rendered pixels.
- Final image or ZIP: at most 100MB.
- Rendering concurrency: exactly one page.
- Job watchdog: 180 seconds from handle creation.

Every limit is checked before allocation when dimensions are known and checked again after PDF.js creates the
viewport. ZIP output bytes are counted while chunks arrive; reaching the limit aborts the archive and fails
the job. A 300DPI request that exceeds a limit is rejected with a corrective message rather than downscaled.

## Cleanup and cancellation

The public handle settles exactly once. `cancel()` terminates the top-level Worker immediately, clears the
watchdog, and returns a cancelled outcome. Events with another job ID or events received after settlement are
ignored.

Inside the pipeline, `try/finally` performs all applicable cleanup:

- Cancel the active PDF.js render task.
- Call page cleanup after each encoded page.
- Set OffscreenCanvas width and height to zero after each page.
- Terminate a partial ZIP operation.
- Call document cleanup and destroy the loading task.
- Release references to the input typed array and current encoded page.

The UI revokes its result object URL on setting change, rerun, reset, file replacement, and unmount.

## Error model

The renderer distinguishes:

- `INVALID_SPEC`: contract parsing failed.
- `UNSUPPORTED_INPUT`: the bytes are not a supported PDF or required local decoding is unavailable.
- `PASSWORD_PROTECTED`: the document requests a password; version 1 never prompts for one.
- `CORRUPT_PDF`: strict PDF.js loading failed on malformed data.
- `PAGE_RANGE_INVALID`: a selected page is outside the document.
- `PAGE_LIMIT`: source or output page count exceeded its exact limit.
- `MEMORY_LIMIT`: dimensions, pixels, output bytes, or input bytes exceeded a resource gate.
- `RENDER_FAILED`: PDF.js could not render a page.
- `ENCODE_FAILED`: the canvas could not create the requested JPG or PNG.
- `WORKER_CRASH`: Worker creation, protocol, watchdog, or unexpected termination failed.

Any page failure fails the whole job. No partial direct image or ZIP is offered. Error messages do not include
the source filename, PDF text, object data, or asset URL.

## Testing strategy

All production behavior follows red-green-refactor.

### Contract and domain unit tests

- Accept the exact supported format, quality, DPI, and page-selection combinations.
- Reject duplicate, empty, zero, negative, out-of-contract, and more-than-100 selected pages.
- Verify rotated 96/150/300DPI dimensions and integer rounding.
- Reject an 8,193px side, 16MP-plus page, and 100MP-plus selection.
- Verify safe source-relative names for direct JPG, direct PNG, and ZIP entries.

### Pipeline tests

Use an injected renderer adapter for deterministic unit coverage and actual PDF.js in browser tests.

- Preserve selected page order and source page numbers in names.
- Return a direct image for one page and a ZIP for multiple pages.
- Verify JPEG and PNG signatures, archive entries, progress sequence, and timing fields.
- Fail before canvas allocation for known budgets and after viewport creation for defensive budgets.
- Abort ZIP generation when cumulative bytes exceed 100MB.
- Map password, corrupt, page-range, render, and encode failures to exact codes.
- Prove page, canvas, archive, document, and loading-task cleanup on success, failure, and cancel.

### Runtime lifecycle tests

- Worker construction failure and message decoding failure settle once.
- Cancel before and after File reading does not post a late run request.
- Cancel after request posting terminates the Worker exactly once.
- A 180-second watchdog returns a retryable Worker failure.
- Wrong-job, stale-progress, stale-complete, and duplicate terminal events are ignored.
- Transferred input and result buffers use transfer lists.

### Browser end-to-end tests

- Convert a two-page vector PDF to JPG at 150DPI and verify ZIP names, signatures, and dimensions.
- Convert one rotated selected page to a direct PNG and verify its signature and rotated dimensions.
- Verify page-range validation, JPEG quality visibility, progress copy, cancel, reset, and download name.
- Assert no external request, no non-GET/HEAD request, no request body, and no page error.
- Verify 44px controls, 16px text inputs, sticky actions, and no horizontal overflow on an iPhone viewport.
- Run current Chromium, Firefox, desktop WebKit, mobile Chromium, and mobile WebKit in CI.

### Build and deployment tests

- Verify the static export contains `/pdf/to-image`, the renderer Worker, and every required self-hosted
  PDF.js asset.
- Verify existing image and PDF routes do not eagerly request PDF.js assets.
- Verify Cloudflare serves the route and assets with the current CSP and security headers.
- Treat any release-browser Worker or OffscreenCanvas failure as a release blocker; do not publish a
  main-thread rendering fallback.

## Acceptance criteria

- Default JPG 85 at 150DPI produces the expected page dimensions and names.
- PNG, every-page, selected-page, direct-image, and multi-page ZIP flows work locally.
- Progress reports actual completed and total pages and cancellation is immediate.
- The UI publishes a progress state before transferring the complete input to the renderer, and rendering
  never allocates more than one page canvas at a time.
- All stated resource gates fail with their exact corrective error.
- PDF bytes and filenames never leave the tab or appear in logs.
- PDF.js loads only on the new route and only from the same origin.
- Core verification and all release-browser E2E projects pass before deployment.
- The live Cloudflare route and required static assets return HTTP 200 with the existing CSP.

## Rollout

Begin only after the watermark page-selection release is live and verified. Implement and review the
contract/domain layer, renderer/runtime layer, and web layer as separate testable tasks. Push one release
commit only after local verification; then require GitHub core CI, all five browser projects, Cloudflare
deployment, and a live JPG/PNG smoke check before declaring completion.
