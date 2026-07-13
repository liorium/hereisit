# Architecture

## Execution policy

HereIsIt chooses the narrowest execution target that can produce a correct result:

1. Browser Worker for supported local transformations.
2. Browser Worker plus a lazily loaded WASM codec when the platform codec is insufficient.
3. A separately deployed server worker only for operations that cannot safely or efficiently run locally.

The web application never proxies large file bodies. Future server jobs will upload directly to object
storage with a short-lived signed URL, then exchange only artifact IDs and progress events with the
control plane.

## Tool boundary

Every tool has a stable ID, an integer version, validated inputs, a declared execution target, bounded
resource limits, structured progress, and structured errors. Executable functions never cross a Worker
or network boundary.

The initial `image.pipeline@1` tool guarantees one decode and one raster draw per item. Quality-based
output performs one encode; target-byte mode may encode repeatedly against the already-rendered canvas.

The source-relative `smaller-only` goal is a hard postcondition. The runtime adaptively encodes against
the input byte length and returns a result only when it is at least 1% smaller. An item that cannot meet
the target is reported as already optimized; a larger generated file is never offered for download.

`image.watermark@1` is a separate contract and Worker path. It adds one validated text string or one
JPG/PNG/WebP logo at a top/middle/bottom × left/center/right anchor, preserving the source's displayed
dimensions and orientation. Text size is relative to the shorter side; logo width is relative to source
width; both fit inside the selected relative margin. The output choice is JPG, PNG, WebP, or `source`.
`source` is resolved from structurally inspected bytes: JPG stays JPG, PNG stays lossless PNG, WebP stays
WebP, and a decodable HEIC/HEIF source becomes white-matted JPG. It never trusts a filename or MIME hint
to select the encoder. Text is one safe, normalized 1–80-code-point line sized at 4–30%; logo width is
5–50%; margin is 0–10%; opacity is 5–100%; and lossy quality is 40–95. Every JPG uses a white matte,
while PNG and WebP retain alpha.

Every image-watermark result is reconstructed through an output-sized `OffscreenCanvas`. This removes
EXIF, GPS, camera, and container metadata and may normalize color profiles. It is a new encode rather than
a byte-preserving edit, so its size may increase even when `source` is selected; this contract has no
smaller-only postcondition. The Worker draws the auto-oriented source once and the selected watermark
once. A result is exposed in tab-owned memory and saved only after an explicit single-result or batch-ZIP
action.

The `pdf.merge@1`, `pdf.split@1`, `pdf.images-to-pdf@1`, `pdf.organize@1`, and `pdf.watermark@1` tools
copy or embed content in a dedicated one-job Worker. The organizer creates a new document from a validated
page plan: order controls output order, quarter-turns are added to the source rotation, and omitted pages
are deleted from the result. It copies page content instead of rendering whole pages.

`pdf.to-images@1` is an independent contract because its result is an image or archive rather than a PDF.
It defaults to all pages as JPG quality 85 at 150DPI and also accepts 96/150/300DPI, PNG, and an ordered
validated page selection. One output page returns a JPG or PNG directly; multiple pages return an ordered
ZIP whose filenames retain their source page numbers.

`pdf.compress-scanned@1` is the scan-oriented raster-compression contract. Its only presets resolve to
balanced 150DPI/JPEG quality 72/white or minimum 96DPI/JPEG quality 55/white. It renders and immediately
embeds every page, then offers the final PDF only when it is at most
`sourceBytes - max(1, ceil(sourceBytes / 100))`. This is at least 1% smaller and never an automatic
download. It is not structure-preserving general PDF compression or internal-image-only optimization.

After a bounded local inspection, the PDF-to-image and scanned-compression paths use separate dedicated
Workers around shared raster internals. They import pinned PDF.js 6.1.200 and render exactly one page at a
time. The parser Worker, packed CMaps, and standard fonts are versioned, copied from the same pinned
package, and served from the Pages origin. Each renderer receives PDF bytes as a transferred typed array;
it never passes an input URL to PDF.js. Existing image and PDF-edit routes import neither renderer.

These paths have no upload, CDN dependency, WebAssembly decoder, server renderer, or server fallback. PDF.js
6.1.200 removed the `isEvalSupported` option, so the runtime intentionally does not pass it. The deployed
Content Security Policy, which does not grant `unsafe-eval` or `wasm-unsafe-eval`, remains the evaluation
boundary. A browser that cannot provide the Worker and `OffscreenCanvas` chain receives an unsupported
browser result instead of a main-thread fallback.

PDF-to-image output is raster data, so text cannot remain searchable or selectable. Annotations and form
appearances are flattened as PDF.js renders them, and the browser canvas can normalize source color
profiles. This is page rendering, not embedded-image extraction or OCR.

Scanned-PDF compression removes or flattens searchable/copyable text and OCR, vector graphics, links,
forms, annotations, bookmarks, attachments, layers, source metadata, and other interactive structure.
Electronic signatures become invalid and browser JPEG conversion may normalize color profiles. Each
output page uses the authoritative rotated scale-1 PDF.js viewport, so the visible CropBox, source
rotation, and UserUnit determine its preserved displayed physical width, height, and orientation. Raster
pixel dimensions are rounded up separately; the new page normalizes rotation to 0. The Worker plans the
whole document first, then renders, encodes, embeds, and cleans one page before starting the next. It
retains no public intermediate image or partial PDF.

The `pdf.watermark@1` tool renders the validated text once with a bounded `OffscreenCanvas`, embeds that
raster PNG, and reuses it as a centered or tiled overlay on every page or the selected pages.
PDF pages are not rasterized, but
the watermark itself is an image rather than searchable or selectable text. Placement uses each page's
visible CropBox offset, and compensates for the page rotation so the chosen angle stays visually
consistent. Its glyph shape can reflect the sans-serif font available on the user's device.

All of these edits create a new PDF. They can invalidate electronic signatures and may not retain every
bookmark, form, attachment, or other advanced document feature, so that limitation is shown before and
after relevant operations. Structure-preserving general PDF compression and internal-image-only
optimization are not provided. The scan-oriented raster compressor has a hard smaller-only postcondition
and never offers a larger result. Only other PDF edits can make an output larger than its source.

## Resource policy

`image.pipeline@1` dimensions are parsed from PNG, JPEG, and WebP structure before decode. Its runtime
then keeps a defensive post-decode check, limits automatic concurrency to two Workers (one on low-memory
devices), and enforces per-file, pixel, output, batch-input, and retained-result budgets. Worker creation
errors, message decode failures, and a three-minute job watchdog settle into structured failures instead
of leaving a batch pending.

The image-watermark path accepts 1–100 source files of 1 byte–50MiB each and at most 250MiB combined.
Each source is limited to 16,384px per side and 25,000,000 displayed pixels. Its optional logo is one
1-byte–10MiB JPG, PNG, or WebP limited to 8,192px per side and 16,000,000 pixels; animated sources and
logos are rejected instead of flattened. Results are limited to 100MiB each and 500MiB retained per
batch. It uses at most two dedicated Workers, falling back to one when reported device memory is unknown
or at most 4GiB, with a 180-second watchdog for each startup/logo-configuration phase and active item.
A setup timeout fails terminally; other repeated setup faults are bounded to one replacement before the
batch is rejected. The runner reads the logo once, copies and decodes it once per active Worker, reuses
that bitmap across the Worker's jobs, and closes it when the Worker is replaced, cancelled, fails, or
finishes. The runner zeroes its retained logo-byte copy and any untransferred setup copy on terminal paths.

PDF inputs are structurally checked before parsing and bounded by file size, page count, decoded stream
bytes, object and cross-reference counts, filter depth, output size, and a three-minute watchdog. PNGs
embedded into PDF are gated by an estimate of compressed-input copies, raw scanlines, RGBA conversion,
and PDF embedding buffers before decode begins. Watermark rendering is capped at 2,048×512 pixels,
1,048,576 total pixels, and a 2MB encoded PNG before it can be embedded.

PDF-to-image jobs accept one 1-byte–50MiB PDF with at most 500 source pages and 1–100 output pages. Each
rendered side is at most 8,192px; a page is limited to 16,000,000 pixels/64,000,000 RGBA bytes, and a
selected job to 100,000,000 rendered pixels. Rendering is sequential, and the HereIsIt-owned output canvas
plus custom display-layer `CanvasFactory` scratch storage share a 128MiB active budget. The nested parser
Worker has its own `OffscreenCanvas` and `ImageDecoder` paths disabled, its canvas area fixed at 64,000,000
bytes to prevent capability probes, and `maxImageSize` limits each decoded image to 16,000,000 pixels.
Parser-decoded image arrays are not included in the managed 128MiB canvas budget, so an image-heavy page
can still reach browser memory limits; the dedicated Worker then fails without returning partial output.
The final direct image or ZIP is limited to 100MiB, and the job has the same three-minute watchdog. Limits
are checked before allocation when dimensions are known and again against the PDF.js viewport.

Scanned-PDF compression accepts exactly one 1-byte–50MiB PDF and includes all 1–100 pages. Each rendered
side is limited to 8,192px, each page to 16,000,000 pixels/64,000,000 RGBA bytes, and the job to
100,000,000 pixels. It shares the 128MiB active HereIsIt-managed output/display-layer canvas budget and
has a 180-second public watchdog. Cumulative JPEG bytes and the final PDF cannot exceed the exact
smaller-only target. Processing is strictly sequential. PDF.js parser-decoded arrays and
PDF-library/JavaScript overhead are outside the managed canvas budget, so it is not a whole-process RSS
ceiling; an image-heavy document can still exhaust browser memory and fails without partial output.

## Privacy

- File contents and filenames are excluded from analytics and logs.
- Browser results live in object URLs and memory owned by the current tab.
- Image-watermark source/logo bytes move only as transferred local buffers between the tab and its
  dedicated Workers; no decoder receives an input URL and no upload, CDN, WebAssembly, or server fallback
  exists.
- Image-watermark filenames, previews, results, and object URLs are likewise excluded from network and
  analytics payloads and remain in tab/Worker-owned memory.
- Image-watermark object URLs are revoked on replacement, rerun, reset, and unmount, and no save begins
  until the user explicitly requests one.
- Server-mode tools must display the upload boundary and deletion policy before a file leaves the device.

## Release proof

After serving `apps/web/out` through the local Pages runtime, the tracked browser smokes prove the image
watermark and both PDF raster paths without uploading fixtures:

~~~bash
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:3000
~~~

Without a base URL, all three scripts target the production Pages origin.
The image-watermark smoke also proves the security headers, approved defaults, synthetic 320×180 PNG
result, explicit-only save, same dimensions and PNG signature, and absence of external or write requests.
