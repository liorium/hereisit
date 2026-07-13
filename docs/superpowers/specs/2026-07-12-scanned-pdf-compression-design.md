# Scanned PDF Compression Design

**Status:** Approved on 2026-07-12

## Summary

Add a local-only `/pdf/compress` tool named **스캔 PDF 용량 줄이기**. It renders every visible PDF
page to a bounded JPEG and immediately embeds that image into a new PDF page with the same displayed
physical size and orientation. The tool offers fixed `균형 150DPI` and `최소 용량 96DPI` presets and
returns a result only when the serialized PDF is at least 1% smaller than the source.

This is raster reconstruction for scan-like documents, not structure-preserving general PDF
optimization. The UI accepts any supported PDF without attempting to classify whether it is scanned,
but it warns before and after processing that searchable text, links, forms, signatures, bookmarks,
attachments, layers, and other interactive structure are not preserved.

## Goals

- Reduce scan-like PDF file size without uploading bytes or filenames.
- Provide two predictable presets rather than an opaque quality search.
- Guarantee that every offered result is at least 1% smaller than its source.
- Preserve page count, order, displayed orientation, and displayed physical page dimensions.
- Render exactly one page at a time with bounded canvas, encoded-image, output, input, and elapsed-time
  resources.
- Show honest page-count progress, immediate cancellation, and explicit destructive-conversion warnings.
- Reuse the proven PDF.js renderer and PDF creation behavior behind a new versioned contract.
- Keep the existing PDF-to-image and PDF editing routes behaviorally and bundle-isolated.

## Non-goals

- Detecting whether a PDF is scanned, image-only, text-based, or a good compression candidate.
- Preserving searchable text, OCR layers, vector graphics, links, annotations, forms, signatures,
  bookmarks, attachments, layers, metadata, or original page-box structure.
- Recompressing only internal image XObjects while preserving other PDF objects.
- Lossless compression, JBIG2/JPX/CCITT rewriting, OCR, password entry, or encrypted PDF support.
- Arbitrary DPI or JPEG quality controls, 300DPI output, adaptive per-page quality, or automatic preset
  fallback.
- Selected-page compression, partial PDF results, automatic downloads, server processing, or upload
  fallback.
- A hard whole-process RSS guarantee. PDF.js parser arrays and library overhead cannot be fully metered
  by browser JavaScript.

## Approach decision

Version 1 uses fixed-preset full-page raster reconstruction:

| Preset | Render resolution | JPEG quality | Product intent |
| --- | ---: | ---: | --- |
| `balanced` | 150DPI | 72 | Recommended balance of legibility and size |
| `minimum` | 96DPI | 55 | Smaller output with an explicit small-text warning |

The dedicated Worker opens the source once with pinned, same-origin PDF.js 6.1.200. It renders each page
onto an opaque white canvas, encodes one JPEG, embeds that JPEG into a new `@cantoo/pdf-lib` document,
cleans the page and canvas, and continues sequentially. No intermediate image ZIP, Blob URL collection,
or public PDF-to-image job is created.

Two alternatives are intentionally deferred:

1. Adaptive JPEG quality could improve success rates, but it requires several browser-dependent encodes
   per page, increases CPU and temporary memory, and can produce inconsistent page quality.
2. Internal Image XObject rewriting could preserve text and links, but the current libraries cannot
   safely decode and rewrite the full DCT, JPX, JBIG2, CCITT, mask, color-space, inline-image, and shared
   object surface. A separately evaluated PDF engine would be required.

Loading and saving a PDF without raster reconstruction is not presented as compression because it often
does not recompress scan streams and can make the document larger.

## Versioned contract

The feature has an independent contract rather than widening `pdf.pipeline@1` or `pdf.to-images@1`:

~~~ts
const PDF_COMPRESS_SCANNED_TOOL_ID = "pdf.compress-scanned";
const PDF_COMPRESS_SCANNED_TOOL_VERSION = 1;

type PdfCompressScannedSpecV1 = {
  version: 1;
  preset: "balanced" | "minimum";
};
~~~

The runtime, not the caller, resolves each preset to its fixed DPI, JPEG quality, and white background.
The contract has no page selection because all pages must appear in the result.

The fulfilled result is:

~~~ts
type PdfCompressScannedResult = {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "application/pdf";
  sourceByteLength: number;
  byteLength: number;
  pageCount: number;
  preset: "balanced" | "minimum";
  dpi: 96 | 150;
  quality: 55 | 72;
  warnings: (
    | "PDF_PAGES_RASTERIZED"
    | "SEARCHABLE_CONTENT_REMOVED"
    | "INTERACTIVE_CONTENT_REMOVED"
    | "SIGNATURES_INVALIDATED"
    | "COLOR_PROFILE_NORMALIZED"
  )[];
  timing: {
    loadMs: number;
    renderMs: number;
    encodeMs: number;
    assembleMs: number;
    serializeMs: number;
    totalMs: number;
  };
};
~~~

The caller calculates saved bytes and display percentage from the two validated byte lengths. The public
job result is fulfilled, rejected, or cancelled and settles exactly once. `NO_SIZE_REDUCTION` is an
expected non-retryable rejection rendered as informational product feedback rather than a crash.

Progress phases are `validating`, `loading`, `rendering`, `encoding`, `assembling`, `serializing`, and
`finalizing`. Page phases include `completedPages` and `totalPages`. Fractions and counts are monotonic and
cannot claim completion before a result passes the size postcondition.

## Components and boundaries

### Domain helpers

`@hereisit/pdf-tool` owns pure, browser-independent behavior for:

- Resolving the two preset names to exact DPI and JPEG quality.
- Planning integer raster allocation dimensions from authoritative visible PDF point sizes.
- Enforcing side, page-pixel, total-pixel, and page-count limits before allocation.
- Calculating the exact source-relative 1% target.
- Creating a safe `report-compressed-hereisit.pdf` style name.

The existing point-to-pixel helpers remain the single raster-allocation implementation. Compression gets
its own plan because it always processes every page and has different result semantics from PDF-to-image.
The pure helpers do not decide which source page box is visible; the compression Worker supplies
authoritative scale-1 PDF.js viewport width and height, including CropBox, rotation, and UserUnit effects.

### Shared raster runtime

Refactor the proven PDF-to-image internals into a focused internal raster module that owns:

- PDF.js API and nested parser Worker setup with pinned same-origin assets.
- Secure `getDocument()` options and input from transferred bytes only.
- Parser capability failure classification.
- The 128MiB managed canvas budget and custom display-layer CanvasFactory.
- Page viewport validation, opaque white rendering, cleanup, and cancellation.
- Parser Worker, loading task, document, page, render task, and canvas teardown.

The module does not know about ZIP files, filenames, React, or PDF assembly. `pdf.to-images@1` keeps its
existing image/ZIP layer, while `pdf.compress-scanned@1` adds a PDF assembly layer. Existing routes must
not import or initialize either dedicated Worker.

### Compression pipeline and Worker

The compression pipeline combines the shared raster module with `@cantoo/pdf-lib` inside one dedicated
module Worker. Before rendering, it performs a page-planning pass: it opens each page one at a time,
captures the rotated scale-1 PDF.js viewport as the authoritative visible point dimensions, validates the
whole plan, cleans the page, and proceeds. This accounts for CropBox, rotation, and UserUnit without
retaining page objects or canvases.

It then creates an output document without copying source metadata, sets only fixed `HereIsIt`
creator/producer values, embeds each encoded JPEG, and adds one page using those authoritative visible
point dimensions. Integer canvas width and height are separately rounded up from the DPI-scaled viewport;
they never determine the output PDF's point dimensions. The JPEG is drawn to fill the exact point-size
page, avoiding a physical-size drift from pixel rounding.

The new page normalizes source rotation and page boxes while preserving the visible page's orientation and
physical displayed width and height. Tests assert displayed geometry rather than raw source rotation,
MediaBox, CropBox, or metadata equality.

The Worker validates the request again, posts a capability-ready event before the UI reads the file,
forwards strictly validated progress, transfers the final ArrayBuffer, and terminates after settlement.
The public job wrapper follows the existing ready handshake, generation guard, three-minute watchdog,
strict event decoder, immediate cancel, and stale-event rejection patterns.

### Web application

Add a separate `PdfCompressWorkbench` and `/pdf/compress` route. The general `PdfWorkbench` remains for
content-copying PDF operations; both `compress` and `to-image` are custom intents with explicit
workbenches. Site metadata, navigation, sitemap, related tools, and static-export route groups derive from
explicit intent classes rather than array position.

The compression route lazily loads its dedicated Worker only after hydration and capability validation.
It owns one source file, bounded local inspection, one preset, progress, cancellation, result Blob and
object URL, save/share lifecycle, and reset. It never stores page canvases or JPEG buffers in React state.

The existing inspection Worker supplies page count and advisory MediaBox-based dimensions for immediate
UI feedback. Those dimensions are not authoritative for CropBox or UserUnit documents and therefore do
not hard-reject compression geometry. The dedicated compression Worker rereads the local file only after
its complete PDF.js capability chain reports ready, builds the authoritative viewport plan, and performs
all hard geometry and total-pixel checks before allocating the first canvas.

## User experience

The route presents:

- Navigation label: `PDF 용량 줄이기`.
- Title: `스캔 PDF 용량 줄이기`.
- Description: `스캔한 PDF 페이지를 가볍게 다시 만들어 용량을 줄이세요. 파일은 서버로
  전송되지 않습니다.`
- Default summary: every page is rebuilt with the recommended 150DPI preset, and a PDF is offered only
  when it is at least 1% smaller.

Before file selection, the drop area states one PDF, 1 byte through 50MB, at most 100 pages, and local-only
processing. Inspection returns only page count, advisory point dimensions, and rotation. It can reject
invalid input and page count, but the run Worker owns exact visible-geometry limits. The UI does not create
thumbnails or classify the document.

Two large preset controls replace quality sliders:

- `균형 150DPI`, tagged `추천`, explains that it balances legibility and size.
- `최소 용량 96DPI`, tagged `작게`, warns that small text may blur.

The warning is visible before execution and after success: pages become images, searchable/copyable text
and OCR layers disappear, interactive links and forms are removed, visible appearances may be flattened,
signatures become invalid, and the tool is intended for scan-like documents. The original file is never
modified, so version 1 does not add a separate acknowledgment checkbox.

The action says `N페이지 PDF 용량 줄이기 →`. Progress uses messages such as
`12/40페이지 다시 만드는 중`, followed by PDF assembly and finalization labels. Cancellation is always
available while the Worker runs.

Successful output shows source bytes, output bytes, whole-number saved percentage, elapsed time, preset,
and the destructive-conversion warnings. It creates one PDF Blob and one object URL only after the strict
result decoder accepts the Worker event. It does not download automatically.

If the balanced preset misses the target, the UI says that this setting could not reduce the file by 1%
and recommends trying 96DPI. If the minimum preset misses the target, it says the file could not be made
smaller with the available setting and recommends keeping the original. It does not claim that every such
PDF is already optimized.

Changing a preset, rerunning, replacing the file, resetting, or unmounting revokes the old result URL.
Generation guards prevent late share fulfillment or rejection from downloading or exposing a revoked
result. Mobile ordering is source, settings, result; actions stay touch-safe and use the existing sticky
safe-area behavior.

## Sequential data flow

~~~text
File
  -> bounded advisory local inspection
  -> validated preset
  -> ready dedicated Worker
  -> one transferred source ArrayBuffer
  -> PDF.js document from Uint8Array
  -> scale-1 visible viewport planning pass for every page
  -> authoritative whole-document raster plan
  -> one page and bounded opaque canvas
  -> one fixed-quality JPEG
  -> immediate embed into one same-size output PDF page
  -> page and canvas cleanup
  -> repeat for every page
  -> serialize one candidate PDF
  -> validate PDF signature, page count, geometry, and byte target
  -> transferable result only when at least 1% smaller
  -> one UI Blob and one object URL
~~~

No public image output, ZIP, network URL, server request, CDN request, WASM decoder, or main-thread render
fallback is part of the flow.

## Smaller-only postcondition

For an input of `sourceBytes`, calculate:

~~~text
requiredSaving = max(1, ceil(sourceBytes * 0.01))
targetBytes = sourceBytes - requiredSaving
~~~

A result is fulfilled only when `candidateBytes <= targetBytes`. The check uses the final serialized PDF,
not the sum of page JPEG sizes. If cumulative embedded JPEG bytes exceed `targetBytes`, the pipeline can
stop early because PDF overhead cannot restore the postcondition. It discards the candidate and returns
`NO_SIZE_REDUCTION`; it never returns the original file as a generated result.

The UI and main-thread decoder independently validate `sourceByteLength`, final byte length, the strict
1% relationship, `%PDF-` signature, a final `%%EOF` marker followed only by optional PDF whitespace,
expected page count, MIME, warnings, timing, safe suggested name, and the exact allowed
preset/DPI/quality pair before creating a Blob.

## Resource limits

- Input: exactly one PDF, 1 byte through 50MiB.
- Source and output: 1 through 100 pages; every source page is included.
- Rendered side: at most 8,192px.
- Rendered page: at most 16,000,000 pixels and 64,000,000 RGBA bytes.
- Job total: at most 100,000,000 rendered pixels.
- HereIsIt-managed output and display-layer canvas storage: 128MiB active budget.
- Cumulative embedded JPEG bytes: no more than the strict smaller-only target.
- Final serialized result: no more than the strict smaller-only target and therefore below 50MiB.
- Rendering concurrency: exactly one page.
- Job watchdog: 180 seconds from public handle creation.

After loading, the compression Worker builds the authoritative plan from each actual scale-1 PDF.js
viewport and checks page dimensions and total pixels before the first canvas allocation. It validates each
render viewport again defensively. A typical A4 document at 150DPI reaches the 100MP total near 45 pages,
while 96DPI can fit roughly 100 pages. The run reports the exact limit violation and the UI suggests 96DPI;
it never silently downgrades the preset or omits pages. Advisory inspection dimensions never cause a hard
geometry rejection.

The active canvas limit does not include PDF.js parser-decoded arrays. PDF assembly retains embedded JPEG
bytes until serialization and serialization can create another result buffer. Documentation therefore
describes the limits precisely and warns that image-heavy documents can still reach browser memory limits,
especially on mobile. Failure produces no partial output.

## Privacy and security

- Source bytes and filenames stay in the current tab and its dedicated Worker.
- The compression run's source read begins only after its complete PDF.js Worker capability chain reports
  ready. The earlier advisory inspection is a separate existing local Worker lifecycle and does not claim
  this PDF.js readiness guarantee.
- PDF.js receives a transferred Uint8Array, never a source URL.
- PDF.js API, parser Worker, CMaps, and standard fonts remain pinned and same-origin.
- No CDN, remote font, upload, analytics payload, server render, or third-party fallback is added.
- CSP remains without `unsafe-eval` and `wasm-unsafe-eval`.
- File contents, filenames, page text, thumbnails, object data, and generated URLs never enter logs.
- Worker messages are treated as hostile and decoded with bounded fields, exact enums, signatures, counts,
  and source/result relationships.
- Errors never include the filename, PDF text, internal object details, or asset URL.

## Cleanup and cancellation

The public handle settles exactly once. `cancel()` terminates the top-level Worker, clears the watchdog,
and returns a cancelled outcome. Stale job IDs and post-settlement messages are ignored.

Pipeline cleanup covers success, failure, and cooperative abort where applicable:

- Cancel the active PDF.js render task.
- Clean each PDF.js page after use.
- Reset both canvas axes to zero before the next allocation and at final cleanup.
- Release the pipeline's current encoded-JPEG reference after embedding; the output document necessarily
  retains its encoded bytes until serialization.
- Drop the incomplete output document and accumulated JPEG references after failure.
- Clean and destroy the PDF.js document and loading task.
- Terminate the nested parser Worker.
- Release source and candidate typed-array references.

The UI revokes result URLs on every invalidating transition and unmount. No partial or previous result is
offered after cancellation, failure, settings change, replacement, or reset.

## Error model

The dedicated runtime distinguishes:

- `INVALID_SPEC`: contract or preset validation failed.
- `UNSUPPORTED_BROWSER`: the required Worker, OffscreenCanvas, or encoder chain is unavailable.
- `UNSUPPORTED_INPUT`: bytes are not a supported PDF or required local decode is unavailable.
- `PASSWORD_PROTECTED`: the PDF requests a password; version 1 never prompts.
- `CORRUPT_PDF`: strict loading failed on malformed data.
- `PAGE_LIMIT`: source page count is outside 1 through 100.
- `MEMORY_LIMIT`: input, dimensions, pixels, canvas budget, JPEG bytes, or serialization exceeded a gate.
- `RENDER_FAILED`: PDF.js could not render a page.
- `ENCODE_FAILED`: the canvas could not produce the preset JPEG.
- `ASSEMBLY_FAILED`: the JPEG could not be embedded or the output PDF could not be serialized.
- `NO_SIZE_REDUCTION`: the final candidate could not satisfy the strict 1% target.
- `WORKER_CRASH`: Worker construction, protocol, watchdog, asset load, or unexpected termination failed.

Capability absence is non-retryable. An asset or transient Worker failure may be retryable, but the UI does
not loop automatically. Any page failure fails the entire job. Public Korean messages are fixed, bounded,
and free of source-derived values other than validated page and byte counts shown by the UI.

## Testing strategy

All implementation behavior follows red-green-refactor.

### Contract and domain tests

- Accept only version 1 and the two exact presets.
- Resolve exact DPI, quality, and background without caller overrides.
- Verify rotated dimensions, fractional point sizes, CropBox/UserUnit inputs, displayed physical page
  sizes, and safe output names.
- Verify the exact 1% formula at tiny, boundary, and 50MiB inputs.
- Reject zero, more-than-100 pages, 8,193px sides, more-than-16MP pages, and more-than-100MP jobs.
- Prove that balanced plans can reject a long A4 document while the explicit minimum preset can pass.

### Pipeline tests

Use injected raster and PDF assembly adapters for deterministic cleanup and budget coverage, plus real
PDF.js and pdf-lib in browser tests.

- Preserve source page count, order, visible orientation, and authoritative displayed physical dimensions,
  including CropBox, UserUnit, and fractional point cases without pixel-rounding drift.
- Use the exact preset DPI and JPEG quality for every page.
- Render, encode, embed, and clean pages strictly sequentially.
- Fulfill only at or below the exact target and reject one byte above it.
- Stop early when cumulative JPEG bytes already make the target impossible.
- Return a valid PDF signature/EOF, copy no source metadata, and set only fixed HereIsIt creator/producer
  values.
- Map password, corrupt, page, memory, render, encode, assembly, no-reduction, and Worker failures exactly.
- Prove page, canvas, document, parser Worker, source buffer, JPEG, and candidate cleanup on success,
  failure, cancellation, and watchdog timeout.

### Worker and public job tests

- Refuse the compression run's second file read before its Worker reports full PDF.js capability readiness;
  keep the advisory inspection lifecycle explicitly separate.
- Validate hostile messages, byte lengths, MIME, names, enums, counts, warnings, timing, and size relations.
- Ignore wrong job IDs, duplicate terminals, stale events, late events, and post-cancel messages.
- Settle once for creation failure, ready failure, file-read failure, runtime error, timeout, and cancel.
- Distinguish unsupported capability from retryable transient Worker failure.

### Browser end-to-end tests

- Compress a deliberately oversized scan fixture and verify page count, dimensions, orientation, PDF
  signature, and at least 1% savings.
- Exercise both presets and prove the fixed settings affect output dimensions and size.
- Reject a small vector PDF with no result and the correct balanced/minimum guidance.
- Verify count-based progress, immediate cancellation, no partial result, no automatic download, and one
  explicit saved PDF.
- Verify result URL revocation and pending share fulfillment/rejection races across settings, rerun,
  replacement, reset, and unmount.
- Verify no external origin, write method, request body, failed request, page error, filename log, or source
  byte leak.
- Keep PDF.js and the compression runtime off unrelated image and PDF routes.
- Verify unique metadata, canonical URL, sitemap entry, keyboard flow, 44px touch targets, sticky actions,
  and no mobile horizontal overflow.
- Stabilize the existing WebKit file-readiness scenario before treating a release run as final.

CI runs current Chromium, Firefox, WebKit, mobile Chromium, and mobile WebKit. Release evidence records any
retry rather than hiding it; a new deterministic regression must pass without relying on an unrelated
retry.

### Static export and production smoke

The static verifier checks the new route, exact Worker closure, same-origin PDF.js assets, licenses, route
isolation, and security headers. A tracked smoke script targets local Pages preview and production. It
performs one compressible balanced job, one minimum job, and one no-reduction job; validates output PDF
geometry and strict savings; and rejects redirects, cross-origin requests, write methods, bodies, failed
requests, and page errors.

## Documentation and release

Update the README, architecture, and deployment docs to say that structure-preserving general PDF
compression is still not provided, while scan-oriented raster compression is available with explicit
loss. Document the two presets, smaller-only guarantee, resource limits, browser memory caveat, and local
privacy boundary.

Before release:

1. Stabilize the previously observed WebKit readiness timeout.
2. Run focused red-green tests for every implementation slice.
3. Run `pnpm verify:all` from the final tree.
4. Review the complete diff for runtime safety, product truthfulness, and route isolation.
5. Publish an intentional release commit to `main` without force push.
6. Require exact-SHA GitHub verify and five-project browser jobs to succeed.
7. Require the exact-SHA Cloudflare Pages check to succeed.
8. Run the tracked smoke against `https://hereisit.pages.dev` and confirm a clean, synchronized repository.

After this release, inspect product coverage, user workflow gaps, implementation reuse, search demand, and
operational risk before choosing the next feature. That review is a separate decision; this design does not
preselect its outcome.
