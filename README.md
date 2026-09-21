# HereIsIt

HereIsIt is a fast, private, local-first toolbox for everyday browser work. It provides browser-only JSON
validation and formatting, image resize, crop, conversion, compression, and text/logo watermarking.
Most file processing runs locally in the browser; image compression defaults to disclosed temporary
server processing with an explicit local option. Pasted JSON stays in the current tab.

## Discovery and local state

The home page searches the local tool catalog and can inspect a selected file's bounded signature prefix
to recommend compatible tools without uploading it or starting processing. `/tools` provides the complete
searchable and filterable catalog. Favorites and recent tools store only versioned tool IDs in this
browser, with an in-memory fallback when local storage is unavailable; file contents and filenames are
never preference data.

Every available tool has a catalog-driven detail page. `quick` shells expose a focused text action,
`file` shells expose a focused file work area, and `workspace` shells expose editing controls.
Each route imports only its own workbench, discloses its processing location, and
links to exactly three catalog-owned next actions.

## Development

Requirements:

- Node.js 24 LTS (>=24 <25)
- pnpm 11.11.0

~~~bash
pnpm install --frozen-lockfile
pnpm dev
~~~

The developer server is available at http://127.0.0.1:3000.

Core verification runs formatting/lint checks, TypeScript, unit tests, and a production build:

~~~bash
pnpm verify
~~~

The browser suite additionally verifies image conversion, real image text/logo watermark results,
all nine keyboard-accessible anchors, cancellation and settings invalidation, explicit single/ZIP saving,
downloaded artifacts and mobile layouts,
Worker isolation, and that processing makes no external, write, or request-body traffic:

The GitHub Actions `browser` job runs the complete automated Playwright matrix for every pull request:
desktop and mobile Chromium, Firefox, and WebKit. It installs browsers on the hosted runner, keeps WebKit
on one worker, and uploads screenshots, traces, and the HTML report only when the job fails. Routine local
verification is `pnpm verify`; use `pnpm verify:all` only when the local processing-stack test is also needed.

Build and preview the exact Cloudflare Pages output locally:

~~~bash
pnpm build
pnpm cloudflare:preview
~~~

The static site is written to apps/web/out.

With that preview running on its default port, exercise the tracked release smokes:

~~~bash
node scripts/smoke-navigation.mjs http://127.0.0.1:3000
node scripts/smoke-image-watermark.mjs http://127.0.0.1:3000
~~~

Omitting the base URL targets the production Pages origin. `pnpm smoke:navigation` is the shorthand for
the production navigation smoke.

## Deployment

Production deployment uses Cloudflare Pages Git integration with the GitHub main branch. Every push to
main produces a production deployment, while pull requests and other branches receive preview URLs.
See [docs/deployment.md](docs/deployment.md) for the dashboard fields, CLI helpers, and first-deploy
checklist.

## Current limits

- `json.format@1` accepts up to 1MiB of pasted UTF-8 JSON with at most 100 nesting levels and produces at
  most 4MiB. It validates syntax with the browser parser but preserves the original spelling of strings,
  numbers, literals and duplicate keys while changing only JSON whitespace. It does not accept JSON5,
  comments or trailing commas and does not repair malformed input, sort keys or save history.
- The size-only preset returns files only when they are at least 1% smaller than the source. Files that
  cannot meet the target are marked as already optimized and are not added to downloads.
- The size-only preset in `image.pipeline@2` keeps inspected JPG, PNG, and WebP formats and pixel
  dimensions. PNG is re-encoded losslessly; HEIC/HEIF must use the format-conversion tool.
- Dedicated `image.optimize@1` compression accepts up to 20 JPEG/PNG/WebP files of 30MiB and 40
  megapixels each. The page discloses local or temporary server processing before file selection;
  server results use bounded lifecycle cleanup and retain the original when no smaller output wins.
- CI release browsers: current Chromium, Firefox, WebKit, and mobile Chromium/WebKit profiles.
- `image.pipeline@2` accepts up to 100 files, 50MiB per file, and 250MiB total input per batch.
- `image.pipeline@2` allows up to 50 megapixels per input and 25 megapixels per output.
- `image.pipeline@2` allows up to 100MiB per result and 500MiB of retained results per batch.
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
- Local files and filenames stay in the current tab or its Worker. Closing the tab releases local results.
- Server image compression sends file bytes only after the disclosed processing action, excludes source
  filenames, and deletes temporary input and result artifacts through its bounded cleanup lifecycle.

## Repository layout

- apps/web — Next.js application and local image workbenches.
- packages/tool-contracts — versioned tool and Worker protocol.
- packages/image-tool — structural image validation, geometry, and naming.
- packages/browser-runtime — bounded image Worker execution runtime.
- packages/tool-registry — user-facing tool and preset metadata.

See docs/architecture.md for execution and privacy boundaries.
