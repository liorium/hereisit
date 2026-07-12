# Architecture

## Execution policy

HereItIs chooses the narrowest execution target that can produce a correct result:

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

The `pdf.merge@1`, `pdf.split@1`, `pdf.images-to-pdf@1`, `pdf.organize@1`, and `pdf.watermark@1` tools
copy or embed content in a dedicated one-job Worker. The organizer creates a new document from a validated
page plan: order controls output order, quarter-turns are added to the source rotation, and omitted pages
are deleted from the result. It copies page content instead of rendering whole pages.

`pdf.to-images@1` is an independent contract because its result is an image or archive rather than a PDF.
It defaults to all pages as JPG quality 85 at 150DPI and also accepts 96/150/300DPI, PNG, and an ordered
validated page selection. One output page returns a JPG or PNG directly; multiple pages return an ordered
ZIP whose filenames retain their source page numbers.

After a bounded local inspection, a dedicated renderer Worker imports pinned PDF.js 6.1.200 and renders
exactly one page at a time. Its parser Worker, packed CMaps, and standard fonts are versioned, copied from
the same pinned package, and served from the Pages origin. The renderer receives PDF bytes as a transferred
typed array; it never passes an input URL to PDF.js. Existing image and PDF-edit routes do not import this
renderer.

This path has no upload, CDN dependency, WebAssembly decoder, server renderer, or server fallback. PDF.js
6.1.200 removed the `isEvalSupported` option, so the runtime intentionally does not pass it. The deployed
Content Security Policy, which does not grant `unsafe-eval` or `wasm-unsafe-eval`, remains the evaluation
boundary. A browser that cannot provide the Worker and `OffscreenCanvas` chain receives an unsupported
browser result instead of a main-thread fallback.

PDF-to-image output is raster data, so text cannot remain searchable or selectable. Annotations and form
appearances are flattened as PDF.js renders them, and the browser canvas can normalize source color
profiles. This is page rendering, not embedded-image extraction or OCR.

The watermark tool renders the validated text once with a bounded `OffscreenCanvas`, embeds that raster
PNG, and reuses it as a centered or tiled overlay on every page or the selected pages.
PDF pages are not rasterized, but
the watermark itself is an image rather than searchable or selectable text. Placement uses each page's
visible CropBox offset, and compensates for the page rotation so the chosen angle stays visually
consistent. Its glyph shape can reflect the sans-serif font available on the user's device.

All of these edits create a new PDF. They can invalidate electronic signatures and may not retain every
bookmark, form, attachment, or other advanced document feature, so that limitation is shown before and
after relevant operations. HereItIs does not currently claim general PDF compression or image
downsampling; edited results can be larger than their sources.

## Resource policy

Image dimensions are parsed from PNG, JPEG, and WebP structure before decode. The runtime then keeps a
defensive post-decode check, limits automatic concurrency to two Workers (one on low-memory devices),
and enforces per-file, pixel, output, batch-input, and retained-result budgets. Worker creation errors,
message decode failures, and a three-minute job watchdog settle into structured failures instead of
leaving a batch pending.

PDF inputs are structurally checked before parsing and bounded by file size, page count, decoded stream
bytes, object and cross-reference counts, filter depth, output size, and a three-minute watchdog. PNGs
embedded into PDF are gated by an estimate of compressed-input copies, raw scanlines, RGBA conversion,
and PDF embedding buffers before decode begins. Watermark rendering is capped at 2,048×512 pixels,
1,048,576 total pixels, and a 2MB encoded PNG before it can be embedded.

PDF-to-image jobs accept one 1-byte–50MiB PDF with at most 500 source pages and 1–100 output pages. Each
rendered side is at most 8,192px; a page is limited to 16,000,000 pixels/64,000,000 RGBA bytes, and a
selected job to 100,000,000 rendered pixels. Rendering is sequential, and the HereItIs-owned output canvas
plus custom display-layer `CanvasFactory` scratch storage share a 128MiB active budget. The nested parser
Worker has its own `OffscreenCanvas` and `ImageDecoder` paths disabled, its canvas area fixed at 64,000,000
bytes to prevent capability probes, and `maxImageSize` limits each decoded image to 16,000,000 pixels.
Parser-decoded image arrays are not included in the managed 128MiB canvas budget, so an image-heavy page
can still reach browser memory limits; the dedicated Worker then fails without returning partial output.
The final direct image or ZIP is limited to 100MiB, and the job has the same three-minute watchdog. Limits
are checked before allocation when dimensions are known and again against the PDF.js viewport.

## Privacy

- File contents and filenames are excluded from analytics and logs.
- Browser results live in object URLs and memory owned by the current tab.
- Server-mode tools must display the upload boundary and deletion policy before a file leaves the device.
