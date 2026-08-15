# HereIsIt engineering guide

## Product principles

- Prefer local browser processing, except that `/image/compress` defaults to the disclosed native server
  engine and keeps local processing as an explicit option. A file must not leave the device unless the UI
  explicitly says so.
- Optimize for time-to-first-feedback, bounded memory, and honest progress reporting.
- Keep every tool behind a versioned contract so browser and server implementations can coexist.
- Do not add a new dependency when a small, tested platform implementation is sufficient.

## Commands

- `pnpm dev` — start development servers.
- `pnpm verify` — run lint, types, unit tests, and production builds.
- `pnpm verify:all` — run core verification and the local processing-stack test.
- `pnpm lint:fix` — apply Biome formatting and safe fixes.

## Verification

- Add pure unit tests for geometry, naming, validation, and pipeline planning.
- Browser codecs are not byte-stable. Assert dimensions, MIME signatures, warnings, and tolerances.
- Never log file contents, filenames, thumbnails, or presigned URLs.
- Automated Playwright E2E runs in GitHub Actions only. Do not install or run Playwright browsers locally for routine verification.
- Use local Playwright only for an explicitly requested one-off diagnosis, and remove its generated outputs afterward.
