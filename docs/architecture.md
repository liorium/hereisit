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

The `pdf.merge@1`, `pdf.split@1`, and `pdf.images-to-pdf@1` tools copy or embed content in a dedicated
one-job Worker. They do not rasterize PDF pages. New documents can invalidate electronic signatures and
may not retain bookmarks or forms, so that limitation is shown before and after relevant operations.

## Resource policy

Image dimensions are parsed from PNG, JPEG, and WebP structure before decode. The runtime then keeps a
defensive post-decode check, limits automatic concurrency to two Workers (one on low-memory devices),
and enforces per-file, pixel, output, batch-input, and retained-result budgets. Worker creation errors,
message decode failures, and a three-minute job watchdog settle into structured failures instead of
leaving a batch pending.

PDF inputs are structurally checked before parsing and bounded by file size, page count, decoded stream
bytes, object and cross-reference counts, filter depth, output size, and a three-minute watchdog. PNGs
embedded into PDF are gated by an estimate of compressed-input copies, raw scanlines, RGBA conversion,
and PDF embedding buffers before decode begins.

## Privacy

- File contents and filenames are excluded from analytics and logs.
- Browser results live in object URLs and memory owned by the current tab.
- Server-mode tools must display the upload boundary and deletion policy before a file leaves the device.
