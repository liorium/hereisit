# Cloudflare Pages deployment

HereIsIt is deployed as a static Next.js export through Cloudflare Pages Git integration. Image
processing, image text/logo watermarking, PDF page organization, rasterized PDF text watermarking, and
PDF-page-to-image rendering remain in the browser; Pages serves only versioned static assets.
Scan-oriented PDF compression starts locally: it rebuilds each page as JPEG and is intentionally
destructive. A structured or mixed local no-reduction result may expose one explicit qpdf server action;
the upload never starts automatically. The PDF raster paths use
self-hosted PDF.js 6.2.108 parser Worker, CMap, and standard-font files, with no CDN, WASM, upload, or
server fallback except that explicit compression action.

The qpdf 12.4.0 Apache-2.0 container is separate from the image engine and has its own queue and DLQ.
It accepts 1 byte–50MiB and 1–100 pages, runs at most two candidates within 45 seconds, 768MiB RSS,
256MiB workspace, and a 50MiB output ceiling, then returns only an at-least-1%-smaller verified result.
qpdf does not provide DPI-aware page downsampling. Its eligible embedded-image optimization produced an
`image-optimized` result in all three local benchmark repeats, with PDF.js semantic and pixel verification.
The generated benchmark gate and sanitized evidence are `pdf-quality-benchmark.yml` and
`docs/deployment/pdf-engine-benchmark.json`; public admission still waits for exact-SHA Chromium, Firefox,
and WebKit evidence plus the immutable canary, deletion, cost, rollback, and signed release gates.

The official production web origin is `https://hereisit.app`; `https://www.hereisit.app` redirects to
the apex, and `https://api.hereisit.app` is the production processing API. The legacy Pages and
`workers.dev` origins remain available only for migration compatibility and recovery.

The compressor's fixed presets are balanced 150DPI/JPEG quality 72/white and minimum 96DPI/JPEG quality
55/white. It accepts one 1-byte–50MiB PDF with 1–100 pages and offers a result only when the final PDF is
at most `sourceBytes - max(1, ceil(sourceBytes / 100))`. It plans CropBox/rotation/UserUnit-aware visible
geometry, then renders sequentially with limits of 8,192px per side, 16 megapixels/64,000,000 RGBA bytes
per page, 100 megapixels per job, a 128MiB active managed canvas budget, and 180 seconds. PDF.js parser
arrays and PDF-library/JavaScript overhead are outside that managed budget. Searchable/copyable text and
OCR, vectors, links, forms, annotations, bookmarks, attachments, layers, source metadata, and other
interactive structure are removed or flattened; signatures become invalid and colors may be normalized.

## Important choice

The production project is Git-integration-only: connect the GitHub repository from the Cloudflare
dashboard and publish only reviewed Git commits. Never create or use a Direct Upload project for
production, and never run `wrangler pages project create` or `wrangler pages deploy` for it.

## Local checks

Requirements: Node.js 24 LTS and pnpm 11.11.0.

~~~bash
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:all
pnpm cloudflare:preview
~~~

The GitHub Actions `browser` job is the authoritative browser release gate for the pull-request merge candidate.
It runs desktop and mobile Chromium, Firefox, and WebKit; routine local verification does not install or run
Playwright browsers.

The developer server (`pnpm dev`) and developer-facing Pages preview (`pnpm cloudflare:preview`) use
http://127.0.0.1:3000, one at a time. The Pages preview serves `apps/web/out` through the same Wrangler
runtime used for deployment and does not require a Cloudflare login.

After the developer-facing preview starts, all four tracked release smokes can target it explicitly:

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:3000
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:3000
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:3000
~~~

Without an argument, each command targets https://hereisit.app. The navigation smoke checks six
release routes, exact security headers, catalog/header/search behavior, representative detail shells, and
read-only same-origin traffic. The image-watermark smoke creates a local 320×180 PNG, verifies the default
text settings and security headers, proves that processing starts no download or upload, then explicitly
downloads the exact PNG result. The compression smoke checks the route and same-origin assets, then proves
balanced 150DPI/JPEG quality 72, minimum 96DPI/JPEG quality 55, the exact 1% smaller-only guarantee,
output geometry/rotation/metadata/image dimensions, explicit-only downloads, and no-reduction guidance. The
PDF-to-image smoke checks its route and pinned parser assets, then performs one rotated-page PNG/96DPI
direct download and one two-page default JPG/150DPI ordered ZIP. The smokes reject redirects,
cross-origin, write-method, request-body, failed-request, and page-error activity; the PDF smokes also
reject private sentinel console/request activity.

The release-verification script uses the separate non-interactive `preview:test` command on port 4173;
do not confuse it with the developer-facing `cloudflare:preview` default on port 3000:

~~~bash
pnpm --filter @hereisit/web preview:test
node scripts/smoke-navigation.mjs http://127.0.0.1:4173
node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-compress.mjs http://127.0.0.1:4173
node scripts/smoke-pdf-to-images.mjs http://127.0.0.1:4173
~~~

For a pull request, wait for Cloudflare's immutable preview for the exact HEAD SHA and repeat all four
commands against that HTTPS origin:

~~~bash
CLOUDFLARE_PREVIEW_ORIGIN="https://<immutable-preview>.pages.dev"
node scripts/smoke-navigation.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-image-watermark.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-pdf-compress.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
node scripts/smoke-pdf-to-images.mjs "$CLOUDFLARE_PREVIEW_ORIGIN"
~~~

## Release evidence record

For the local release preview, immutable Cloudflare preview, and production deployment, record the target
origin, exact Git SHA, full command, and exit code for every smoke. Record manual VoiceOver/Safari and
NVDA/Firefox-or-Chrome results from the
[discovery accessibility checklist](testing/discovery-accessibility-checklist.md) separately. When the
required platform or assistive technology is unavailable, write `not run` and the reason; automated tests
are not manual-pass evidence. Never include selected filenames, file contents, thumbnails, object URLs,
preference values, or other file-derived data in release evidence.

Server-processing staging deploys automatically after a successful `main` CI push. See the
[processing staging deployment guide](deployment/processing-staging-bootstrap.md). Production uses the
same push-based path with a protected GitHub environment approval after its resources are provisioned.

Optional account commands:

~~~bash
pnpm cloudflare:whoami
pnpm cloudflare:login
~~~

The login command opens Cloudflare OAuth. It is not required for dashboard Git deployment.

## Create the project

1. Open https://dash.cloudflare.com/ and select Workers & Pages.
2. Choose Create application, Pages, then Connect to Git.
3. Authorize the GitHub application for liorium/hereisit. Repository-only access is preferred.
4. Select liorium/hereisit and use these build settings:

| Field | Value |
| --- | --- |
| Project name | hereisit |
| Production branch | main |
| Framework preset | Next.js (Static HTML Export) |
| Root directory | leave blank |
| Build command | pnpm --filter @hereisit/web build |
| Build output directory | apps/web/out |
| Build system version | 3 |

Add the following variables to both Production and Preview builds:

| Variable | Value |
| --- | --- |
| NODE_VERSION | 24.13.0 |
| PNPM_VERSION | 11.11.0 |
| NEXT_TELEMETRY_DISABLED | 1 |

Enable build cache, save the project, and start the first deployment. No API token, account ID,
GitHub Actions deploy workflow, or server runtime is required.

## First-deploy checks

- The generated pages.dev URL loads over HTTPS.
- The response includes the security headers from apps/web/public/_headers.
- A sample image converts to WebP and downloads as a ZIP.
- `/image/watermark` returns HTTP 200 and loads its dedicated Worker without any established image or PDF
  Worker bundle. A local 320×180 PNG receives the default `© HereIsIt` bottom-right watermark without an
  upload or automatic download, then downloads as `source-watermarked-hereisit.png` only on request. A
  JPG/PNG/WebP logo can also be selected once, reused across a multi-image batch, and downloaded only on
  request.
- Two sample PDFs merge in order, a PDF splits into a ZIP, and JPG/PNG images download as one PDF.
- A three-page PDF can be reordered, quarter-turned, and reduced to selected pages in one organized PDF.
- A PDF text watermark can be placed locally and the downloaded result opens with the same page count.
- `/pdf/to-image` and the versioned PDF.js parser Worker, packed CMaps, and standard fonts return HTTP 200
  from the same origin with the current CSP and other security headers.
- `/pdf/compress` returns HTTP 200 and loads only its inspection/compression Workers plus pinned,
  same-origin PDF.js assets; image, PDF editing, and PDF-to-image Worker bundles remain isolated.
- A compressible scan produces a balanced 150DPI/JPEG quality 72 PDF only after an explicit download, at least
  1% smaller than the source, with displayed page geometry preserved and output rotation normalized to 0.
- The same scan produces a smaller minimum 96DPI/JPEG quality 55 PDF, while a tiny vector PDF shows
  no-reduction guidance and exposes no download action.
- A two-page PDF with a rotated second page can select page 2 and download a 1056×816 PNG at 96DPI.
- A two-page 612×792pt PDF downloads an ordered two-entry JPG ZIP whose images are 1275×1650 at the default
  150DPI and quality 85.
- Browser network activity contains no external upload or write request.
- A pull request receives its own preview URL and deployment status check.

The Pages project must list `hereisit.app` as an active custom domain before a production release. The
production Worker must likewise retain the active `api.hereisit.app` custom domain; do not replace either
with a proxy or disable the legacy compatibility origins in the same release.

For a production release, run all four tracked smokes only after the current GitHub CI and Cloudflare
Pages production deployment have succeeded for the exact merge SHA:

The canonical PDF benchmark records three local PDF.js visual measurements and therefore derives
`publicAdmissionReady: true` for the benchmark itself. Production remains fail-closed until hosted
Chromium, Firefox, and WebKit each verify all three native results and the separate signed rollout receipts
authorize the exact release.

~~~bash
node scripts/smoke-navigation.mjs https://hereisit.app
node scripts/smoke-image-watermark.mjs https://hereisit.app
node scripts/smoke-pdf-compress.mjs https://hereisit.app
node scripts/smoke-pdf-to-images.mjs https://hereisit.app
~~~
