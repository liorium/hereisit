# HereItIs

HereItIs is a fast, private, local-first toolbox for everyday file work. The first milestone is a
browser-only batch image workbench: resize, crop, convert, and compress JPG, PNG, and WebP files in Web
Workers without uploading them.

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

The browser suite additionally verifies local conversion, a downloaded WebP inside ZIP, keyboard
navigation, and that conversion makes no external or write requests:

~~~bash
pnpm exec playwright install chromium
pnpm test:e2e
# or run both core and browser checks
pnpm verify:all
~~~

Run the production build locally with pnpm build followed by pnpm --filter @hereisit/web start. CI runs
the browser suite against that production server.

## Current limits

- Tested release browser: current Chromium (Chrome and Edge).
- Up to 100 files, 50MB per file, and 250MB total input per batch.
- Up to 50 megapixels per input and 25 megapixels per output.
- Up to 100MB per result and 500MB of retained results per batch.
- Animated PNG and WebP files are rejected rather than silently flattening a frame.
- Files and filenames stay in the current tab. Closing the tab releases in-memory results.

## Repository layout

- apps/web — Next.js application and local image workbench.
- packages/tool-contracts — versioned tool and Worker protocol.
- packages/image-tool — structural image validation, geometry, and naming.
- packages/browser-runtime — bounded Worker pool and browser execution runtime.
- packages/tool-registry — user-facing tool and preset metadata.

See docs/architecture.md for execution and privacy boundaries.
