# HereItIs

HereItIs is a fast, private, local-first toolbox for everyday file work. It provides browser-only image
resize, crop, conversion, and compression plus PDF merge, split, page extraction, page organization,
text watermarking, PDF-page-to-JPG/PNG conversion, and JPG/PNG-to-PDF tools. File processing runs in Web
Workers without uploads.

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

The browser suite additionally verifies image and PDF conversion, PDF-page rasterization, page
organization, text watermarking, downloaded artifacts, keyboard and mobile layouts, Worker loading, and
that conversion makes no external or write requests:

~~~bash
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
# or run core and browser checks together
pnpm verify:all
~~~

Build and preview the exact Cloudflare Pages output locally:

~~~bash
pnpm build
pnpm cloudflare:preview
~~~

The static site is written to apps/web/out.

## Deployment

Production deployment uses Cloudflare Pages Git integration with the GitHub main branch. Every push to
main produces a production deployment, while pull requests and other branches receive preview URLs.
See [docs/deployment.md](docs/deployment.md) for the dashboard fields, CLI helpers, and first-deploy
checklist.

## Current limits

- The size-only preset returns files only when they are at least 1% smaller than the source. Files that
  cannot meet the target are marked as already optimized and are not added to downloads.
- CI release browsers: current Chromium, Firefox, WebKit, and mobile Chromium/WebKit profiles.
- Up to 100 files, 50MB per file, and 250MB total input per batch.
- Up to 50 megapixels per input and 25 megapixels per output.
- Up to 100MB per result and 500MB of retained results per batch.
- Animated PNG and WebP files are rejected rather than silently flattening a frame.
- PDF jobs accept up to 100MB total input and 500 pages; page-by-page split creates at most 200 files.
- `pdf.to-images@1` accepts one PDF up to 50MiB and at most 500 source pages. It converts all pages by
  default to JPG quality 85 at 150DPI; 96, 150, and 300DPI plus JPG quality 40–95 or PNG are available.
  One selected page is returned directly, while 2–100 selected pages are returned in one ordered ZIP.
- PDF-to-image rendering is sequential and allows at most 8,192px on either side, 16 megapixels or
  64,000,000 RGBA bytes per output canvas/image, 100 megapixels across the selection, 128MiB across
  HereItIs-managed output and display-layer scratch canvases, and a 100MiB final image or ZIP. PDF.js
  parser image buffers have the same 16-megapixel per-image gate but are not counted in that 128MiB canvas
  budget, so image-heavy pages can still hit browser memory limits and fail without partial output.
- PDF-to-image output is raster data: text is no longer searchable or selectable. Rendered annotations
  and form appearances are flattened, and browser canvas conversion can normalize color profiles.
- Page organization works on one PDF at a time and can reorder, quarter-turn, or omit pages locally.
- Watermark text is rasterized locally into a bounded PNG before it is placed on every page or the
  selected pages. It is not searchable or selectable text, and its exact glyph appearance can vary with
  the device font.
- Organizing pages and adding a watermark create a new PDF. Existing electronic signatures become
  invalid, and advanced document features such as bookmarks or forms may change.
- General PDF compression and image downsampling are not provided. PDF editing can make an output larger
  than its source.
- JPG/PNG-to-PDF uses a format-aware 128MB estimated decode-memory ceiling for each PNG.
- Files and filenames stay in the current tab or its Worker. Closing the tab releases in-memory results.

## Repository layout

- apps/web — Next.js application and local image/PDF workbenches.
- packages/tool-contracts — versioned tool and Worker protocol.
- packages/image-tool — structural image validation, geometry, and naming.
- packages/pdf-tool — PDF page-range, page-plan, watermark-layout, signature, and naming helpers.
- packages/browser-runtime — bounded image/PDF Worker execution runtime.
- packages/tool-registry — user-facing tool and preset metadata.

See docs/architecture.md for execution and privacy boundaries.
