# HereIsIt

HereIsIt is a fast, privacy-first toolbox for everyday file work. It provides local image resize, crop,
conversion and text/logo watermarking plus server-capable same-format image compression, PDF merge, split, page extraction,
page organization, text watermarking, PDF-page-to-JPG/PNG conversion, scan-oriented PDF raster
compression, and JPG/PNG-to-PDF tools. Every route discloses whether it stays in the browser or uses the
temporary HereIsIt processing service before file selection.

## Development

Requirements:

- Node.js 24 LTS (>=24 <25)
- pnpm 11.11.0

~~~bash
pnpm install --frozen-lockfile
pnpm dev
~~~

Core verification runs formatting/lint checks, TypeScript, unit tests, and a production build:

~~~bash
pnpm verify
~~~

The browser suite additionally verifies image and PDF conversion, real image text/logo watermark results,
all nine keyboard-accessible anchors, cancellation and settings invalidation, explicit single/ZIP saving,
PDF-page rasterization, page organization, PDF text watermarking, downloaded artifacts, mobile layouts,
Worker isolation, and that processing makes no external, write, or request-body traffic:

~~~bash
pnpm exec playwright install --with-deps chromium firefox
pnpm build
pnpm test:e2e
# or run core and browser checks together
pnpm verify:all
~~~

The default local suite covers desktop Chromium and Firefox plus mobile Chromium. To include the same
desktop and mobile WebKit projects used by CI:

~~~bash
pnpm exec playwright install --with-deps webkit
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e
~~~

Build and preview the exact Cloudflare Pages output locally:

~~~bash
pnpm build
pnpm cloudflare:preview
~~~

The static site is written to apps/web/out.

With that preview running on its default port, exercise the image-watermark and PDF raster smokes:

~~~bash
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:3000
~~~

Omitting the base URL targets the production Pages origin.

## Deployment

Production deployment uses Cloudflare Pages Git integration with the GitHub main branch. Every push to
main produces a production deployment, while pull requests and other branches receive preview URLs.
See [docs/deployment.md](docs/deployment.md) for the dashboard fields, CLI helpers, and first-deploy
checklist.

## Current limits

- The size-only preset returns files only when they are at least 1% smaller than the source. Files that
  cannot meet the target are returned as the unchanged original with an explicit metadata warning.
- Dedicated same-format compression accepts up to 20 JPEG/PNG/WebP files of 30MiB and 40 megapixels each.
  A server policy is checked before selection and immediately before processing. Local-only disclosure
  means no upload; server disclosure means temporary authenticated processing with lifecycle cleanup.
- CI release browsers: current Chromium, Firefox, WebKit, and mobile Chromium/WebKit profiles.
- `image.pipeline@1` accepts up to 100 files, 50MiB per file, and 250MiB total input per batch.
- `image.pipeline@1` allows up to 50 megapixels per input and 25 megapixels per output.
- `image.pipeline@1` allows up to 100MiB per result and 500MiB of retained results per batch.
- Animated PNG and WebP files are rejected rather than silently flattening a frame.
- `image.watermark@1` adds one text string or one reusable JPG/PNG/WebP logo at any of nine anchors
  (top/middle/bottom × left/center/right) without changing the source's displayed dimensions.
  Source-format output is resolved from inspected bytes: JPG stays JPG, PNG stays lossless PNG, WebP stays
  WebP, and a supported HEIC/HEIF source becomes JPG. JPG uses a white matte while PNG/WebP retain alpha.
  Every result is newly canvas-encoded with metadata removed, so color profiles and byte size can change;
  there is no size-reduction guarantee and no automatic download. Source and logo files appear as
  metadata placeholders and never receive object URLs or main-thread image decodes; only the newly encoded
  result is rendered as an image.
- Image-watermark batches accept 1–100 sources of 1 byte–50MiB each and 250MiB combined. A source is
  limited to 16,384px per side and 25,000,000 displayed pixels. The optional logo is 1 byte–10MiB,
  8,192px per side, and 16,000,000 pixels. Results are limited to 100MiB each and 500MiB retained per
  batch. Processing uses at most two Workers (one when device memory is unknown or at most 4GiB) with a
  180-second watchdog for Worker setup and each active item.
- PDF jobs accept up to 100MB total input and 500 pages; page-by-page split creates at most 200 files.
- `pdf.to-images@1` accepts one PDF up to 50MiB and at most 500 source pages. It converts all pages by
  default to JPG quality 85 at 150DPI; 96, 150, and 300DPI plus JPG quality 40–95 or PNG are available.
  One selected page is returned directly, while 2–100 selected pages are returned in one ordered ZIP.
- PDF-to-image rendering is sequential and allows at most 8,192px on either side, 16 megapixels or
  64,000,000 RGBA bytes per output canvas/image, 100 megapixels across the selection, 128MiB across
  HereIsIt-managed output and display-layer scratch canvases, and a 100MiB final image or ZIP. PDF.js
  parser image buffers have the same 16-megapixel per-image gate but are not counted in that 128MiB canvas
  budget, so image-heavy pages can still hit browser memory limits and fail without partial output.
- PDF-to-image output is raster data: text is no longer searchable or selectable. Rendered annotations
  and form appearances are flattened, and browser canvas conversion can normalize color profiles.
- `pdf.compress-scanned@1` rebuilds every page of one 1-byte–50MiB, 1–100-page PDF as JPEG. Its fixed
  presets are exactly balanced 150DPI/JPEG quality 72 and minimum 96DPI/JPEG quality 55, both on white.
  A result is offered only when its final PDF is at most
  `sourceBytes - max(1, ceil(sourceBytes / 100))`, guaranteeing at least 1% savings.
- Scanned-PDF compression is destructive: searchable/copyable text and OCR, vector graphics, links,
  forms, annotations, bookmarks, attachments, layers, source metadata, and other interactive structure
  are removed or flattened; electronic signatures become invalid and color profiles may be normalized.
  It preserves every page's displayed physical size and orientation from the authoritative PDF.js
  CropBox/rotation/UserUnit-aware viewport, while output pages normalize rotation to 0.
- Compression renders strictly one page at a time and allows at most 8,192px per side, 16 megapixels and
  64,000,000 RGBA bytes per page, 100 megapixels per job, 128MiB of active HereIsIt-managed output and
  display-layer canvas storage, and 180 seconds. PDF.js parser-decoded arrays and PDF-library/JavaScript
  overhead are outside that managed budget, so image-heavy documents can still exhaust browser memory
  without producing a partial result.
- Page organization works on one PDF at a time and can reorder, quarter-turn, or omit pages locally.
- Watermark text is rasterized locally into a bounded PNG before it is placed on every page or the
  selected pages. It is not searchable or selectable text, and its exact glyph appearance can vary with
  the device font.
- Organizing pages and adding a watermark create a new PDF. Existing electronic signatures become
  invalid, and advanced document features such as bookmarks or forms may change.
- Structure-preserving general PDF compression and internal-image-only optimization are not provided.
  The scan-oriented compressor above intentionally rasterizes whole pages; other PDF editing can make an
  output larger than its source.
- JPG/PNG-to-PDF uses a format-aware 128MB estimated decode-memory ceiling for each PNG.
- Local-tool files and filenames stay in the current tab or its Worker. Server compression never sends
  source filenames; only file bytes and bounded structural metadata cross the disclosed upload boundary.

## Repository layout

- apps/web — Next.js application and local image/PDF workbenches.
- packages/tool-contracts — versioned tool and Worker protocol.
- packages/image-tool — structural image validation, geometry, and naming.
- packages/pdf-tool — PDF page-range, page-plan, watermark-layout, signature, and naming helpers.
- packages/browser-runtime — bounded image/PDF Worker execution runtime.
- packages/server-runtime — browser-safe policy, upload, polling, cancellation, and download coordinator.
- packages/tool-registry — user-facing tool and preset metadata.

See docs/architecture.md for execution and privacy boundaries.
