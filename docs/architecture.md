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

The watermark tool renders the validated text once with a bounded `OffscreenCanvas`, embeds that raster
PNG, and reuses it as a centered or tiled overlay on the selected pages. PDF pages are not rasterized, but
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

## Privacy

- File contents and filenames are excluded from analytics and logs.
- Browser results live in object URLs and memory owned by the current tab.
- Server-mode tools must display the upload boundary and deletion policy before a file leaves the device.
