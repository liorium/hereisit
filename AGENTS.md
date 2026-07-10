# HereItIs engineering guide

## Product principles

- Prefer local browser processing. A file must not leave the device unless the UI explicitly says so.
- Optimize for time-to-first-feedback, bounded memory, and honest progress reporting.
- Keep every tool behind a versioned contract so browser and server implementations can coexist.
- Do not add a new dependency when a small, tested platform implementation is sufficient.

## Commands

- `pnpm dev` — start development servers.
- `pnpm verify` — run lint, types, unit tests, and production builds.
- `pnpm verify:all` — also run the browser end-to-end suite.
- `pnpm lint:fix` — apply Biome formatting and safe fixes.

## Verification

- Add pure unit tests for geometry, naming, validation, and pipeline planning.
- Browser codecs are not byte-stable. Assert dimensions, MIME signatures, warnings, and tolerances.
- Never log file contents, filenames, thumbnails, or presigned URLs.
