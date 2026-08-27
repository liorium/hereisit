# Architecture

## Execution policy

HereIsIt chooses the narrowest execution target that can produce a correct result:

1. Browser Worker for supported local transformations.
2. Browser Worker plus a lazily loaded WASM codec when the platform codec is insufficient.
3. A separately deployed server worker for same-format production compression that cannot be matched by
   the browser's built-in codecs. PDF server processing starts only after a local structured no-reduction
   result and one explicit upload click.

The web application never proxies file bodies through Next.js. Server jobs stream to an authenticated
Worker route, persist temporary random-key objects, and exchange only opaque job IDs and progress events
with the browser. Source filenames never cross the boundary.

## Tool boundary

Every tool has a stable ID, an integer version, validated inputs, a declared execution target, bounded
resource limits, structured progress, and structured errors. Executable functions never cross a Worker
or network boundary.

### Catalog, discovery, and detail ownership

`packages/tool-registry` owns user-facing identity and discovery metadata: availability, canonical route,
search aliases, domains, purposes, launcher input, output kinds, experience, execution, contract version,
rank, and the ordered three related tool IDs. The keyed `toolImplementationConfig` in the web app owns
runtime-facing intent, bundle profile, source limits, eyebrow, summary, and notices. Its keys match every
available catalog ID exactly; discovery code does not duplicate implementation data and implementation
code does not redefine catalog identity.

The discovery routes `/`, `/tools`, `/my-tools`, and `/workflows` may import catalog/discovery UI but no
processor, codec, Worker, browser runtime, image tool, PDF tool, or tool-contract implementation. The
export verifier enforces that processor-free import boundary. Each processor route directly imports only
its assigned workbench and passes that route-owned node to the shared detail shell; there is no central
workbench switch or dynamic processor registry. The shell selects `빠른 작업 영역` for `quick` tools,
`파일 작업 영역` for `file` tools, and `편집 작업 공간` for `workspace` tools, renders the
browser-execution disclosure, and reads its exactly three next actions from the catalog. The current
inventory is ten `file` tools, one `workspace` tool (`/pdf/organize`), and one `quick` tool
(`/data/json`). There is no generic quick-workbench registry.

Home file recommendation reads at most the first 64 KiB of each selected file, accepts at most 100 files,
and schedules at most two prefix reads concurrently. Every prefix lease is released after detection. A
chosen recommendation transfers the selected `File` references through module-scoped memory only: the
handoff is bound to one target tool ID, consumed once, and expires after exactly 60 seconds. Expiry,
target mismatch, consumption, and reload clear the file references; the handoff is never written to
`localStorage` or `sessionStorage`.

Favorites and recent tools persist only validated available tool IDs under
`hereisit.favorite-tools.v1` and `hereisit.recent-tools.v1`. Each list is de-duplicated and capped at 12.
Malformed or unreadable browser storage starts with empty in-memory preferences. If a later write is
denied, the normalized changed IDs remain available in memory while persistence switches to `memory`, so
discovery remains usable without persisting filenames or file contents as preference data.

Discovery JavaScript is checked after every production export. Each discovery route may own at most
76,800 gzip bytes and the discovery-shared layer at most 122,880 gzip bytes. Relative to the checked-in
baseline, each route and the shared layer may grow by only the smaller of 10% or 10 KiB. These size gates
run alongside the processor-marker and route-import isolation checks.

`json.format@1` is the first non-file quick contract. It accepts pasted UTF-8 JSON up to 1MiB and 100
nesting levels and emits at most 4MiB. Native `JSON.parse()` validates syntax only; its parsed value is
discarded. Separate bounded linear scans change JSON whitespace and structural spacing while copying
string, number, literal, escape and duplicate-key tokens exactly, so large integers and lexical number
forms are not rounded or normalized. The input and result remain in component memory, and clipboard or
download output occurs only after the corresponding explicit button. It has no file input, Worker,
network request, storage, JSON5 recovery, schema validation or key sorting.

The initial `image.pipeline@1` tool guarantees one decode and one raster draw per item. Quality-based
output performs one encode; target-byte mode may encode repeatedly against the already-rendered canvas.

`image.pipeline@2` retains the v1 specification parser for explicit JPG, PNG, and WebP jobs and adds a
v2 `source` output policy. The current catalog and Worker handshake advertise tool version 2, so an old
v1 Worker cannot be mistaken for a processor that understands source-preserving compression. The
runtime resolves `source` from inspected bytes, then validates the encoded result's signature, MIME,
dimensions, and animation state before assigning its download name.

The source-relative `smaller-only` goal is a hard postcondition. The runtime adaptively encodes against
the input byte length and returns a result only when it is at least 1% smaller. An item that cannot meet
the target is reported as already optimized; a larger generated file is never offered for download.

The server `image.optimize@1` path keeps the same-format output and uses MozJPEG/WebP/OxiPNG candidates.
Its `smallest` JPEG plan tries a photographic 4:4:4 quality-74 fallback with a bounded relaxed visual
gate; screenshot and graphic classes retain the quality-80 fallback and stricter text gate.

- 파일 선택 검사와 로컬 무손실 메타데이터 작업은 전용 optimize Worker가 네이티브 `File`을 읽어 수행한다.
- 스마트 로컬 압축은 공통 이미지 Worker에서 원본을 읽고 인코드한다.
- UI는 네이티브 `File` 참조와 검증된 메타데이터·결과만 보관한다.
- 네이티브 `File` 구조화 복제의 브라우저 내부 복사 동작은 보장하지 않는다.

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
once. A result is exposed in tab-owned memory and downloaded only after an explicit single-result or
batch-ZIP action.

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
Workers around shared raster internals. They import pinned PDF.js 6.2.108 and render exactly one page at a
time. The parser Worker, packed CMaps, and standard fonts are versioned, copied from the same pinned
package, and served from the Pages origin. Each renderer receives PDF bytes as a transferred typed array;
it never passes an input URL to PDF.js. Existing image and PDF-edit routes import neither renderer.

PDF-to-image has no upload, CDN dependency, WebAssembly decoder, server renderer, or server fallback. PDF.js
6.2.108 does not expose the `isEvalSupported` option, so the runtime intentionally does not pass it. The deployed
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

`pdf.optimize@1` keeps this local compressor first. Only a structured or mixed `NO_SIZE_REDUCTION`
result reveals the plain upload/deletion disclosure and `처리 서버에서 더 압축`. The server path accepts
one 1-byte–50MiB PDF with 1–100 pages, creates at most two sequential candidates, and exposes a direct
download only after qpdf and browser semantic verification. It uses a dedicated PDF queue, DLQ, and
container, isolated from the image queue and container. Input and result use opaque keys and are deleted
after acknowledgement or the retention sweep. Rewriting invalidates electronic signatures.

The native engine is qpdf 12.4.0 under Apache-2.0. It can recompress streams, generate object streams,
remove unreferenced resources, and optimize eligible JPEG objects, but it does not perform DPI-aware
image downsampling and does not always reduce a PDF. The generated 17-stratum gate measured seven
structured wins, three safe hostile rejections, and three local PDF.js visual passes for one
image-optimized profile; exact sanitized evidence is in `docs/deployment/pdf-engine-benchmark.json`.
Public rollout remains disabled until exact-SHA hosted browser, signed release, canary, deletion, cost,
and rollback gates pass.

## Resource policy

`image.pipeline@2` dimensions are parsed from PNG, JPEG, WebP, and supported HEIC structure before decode. Its runtime
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
batch is rejected. The runner structured-clones each validated source/logo `File` to an active Worker without reading or
retaining its full bytes in the UI realm. During watermark processing, each Worker validates the envelope against the
native `File`, reads and length-checks the full file, decodes one reusable logo bitmap, and closes that bitmap when the
Worker is replaced, cancelled, fails, or finishes. The supported home launcher may separately read at most the first
64KiB of a selected source for format detection before handing its `File` to image watermarking.

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
- Generated image, PDF, and ZIP results never use Web Share; an explicit download-labelled action activates the tab-owned Blob URL.
- Image-watermark source/logo `File` handles move to dedicated Workers, where full-file reads for watermark
  processing occur. The supported home launcher may first read at most a 64KiB source prefix for format detection;
  apart from that bounded detection read, source and logo `File` objects never receive object URLs or are decoded by
  the main-thread UI. Filename, size, and Worker-validated dimensions are shown as metadata instead. No remote
  decoder, upload, CDN, WebAssembly, or server fallback exists.
- Only Worker-validated, newly encoded image results and generated ZIP archives receive image-watermark
  object URLs. They are excluded from network and analytics payloads and remain in tab-owned memory.
- Image-watermark result/archive object URLs are revoked on replacement, rerun, reset, removal, unmount,
  archive failure, and archive timeout. No download begins until the user explicitly requests one.
- Server-mode tools must display the upload boundary and deletion policy before a file leaves the device.
- The PDF server fallback never sends a file before the explicit click, never logs content or filenames,
  verifies the downloaded result in a dedicated Worker, and deletes temporary server artifacts
  automatically. It records only bounded numeric measurements and fixed identifiers.
- `image.optimize@1` keeps the source `File` in the tab, checks policy twice, uploads sequentially, and
  retains only lazy authenticated download handles. Interrupted downloads stay retryable; MIME or byte
  mismatches are rejected before a browser download begins.

## Release proof

The official production web origin is `https://hereisit.app`, and production server processing uses
`https://api.hereisit.app`. The legacy Pages and `workers.dev` origins remain temporary compatibility
and recovery endpoints; new production web builds do not use the legacy API origin.

After serving `apps/web/out` through the local Pages runtime, four tracked browser smokes prove scalable
navigation, image watermarking, and both PDF raster paths without uploading fixtures:

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:3000
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:3000
~~~

Without a base URL, all four scripts target the production Pages origin. The navigation smoke verifies
the seven release routes, canonical security headers, approved header/search behavior, home tabs and local
launcher, the complete and planned catalog states, non-indexed personal/workflow pages, representative
file/workspace shells, exact next actions, and read-only same-origin browser traffic.
The image-watermark smoke also proves the security headers, approved defaults, synthetic 320×180 PNG
result, explicit-only download, same dimensions and PNG signature, and absence of external or write
requests.
