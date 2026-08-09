# Image Worker File I/O final fix report

Fix commit: `6a315e82dd20fad9f623470389cce5d4586ccd1c`

## Findings fixed

1. `tests/e2e/image-workbench.spec.ts` had two controlled `image.pipeline` Worker doubles that required `input.bytes`. Both now require the exact native File envelope `{ name, mimeHint, byteLength, file }`, check its metadata against the native `File`, and produce the same synthetic complete result shape and byte length.
2. `packages/browser-runtime/src/image.worker.ts` classified matching empty and over-50MiB native Files as `INVALID_SPEC`. It now preserves `INVALID_SPEC` for malformed or metadata-mismatched envelopes, but returns non-retryable `MEMORY_LIMIT` before attempting a read for matching zero-byte or oversized Files.

## Files

- `packages/browser-runtime/src/image.worker.ts`
- `packages/browser-runtime/src/image.worker.test.ts`
- `tests/e2e/image-workbench.spec.ts`
- `docs/superpowers/plans/2026-08-09-image-pipeline-worker-file-io.md`

## RED to GREEN evidence

- RED: `pnpm exec vitest run packages/browser-runtime/src/image.worker.test.ts` failed 2 new tests: actual empty and `50MiB + 1` native Files returned `INVALID_SPEC` instead of `MEMORY_LIMIT`.
- GREEN: the same command passed all 21 tests after the smallest parser/result split.
- Focused regression: `pnpm exec vitest run packages/browser-runtime/src/image.worker.test.ts packages/browser-runtime/src/run-image-batch.test.ts packages/browser-runtime/src/image-pipeline.test.ts` passed 3 files and 50 tests.

## Checks

- `pnpm lint` passed.
- `pnpm typecheck` passed for all 11 packages.
- `git diff --check` passed.
- `pnpm verify` passed (production audit, lint, typecheck, tests, Worker tests, fuzz, builds, and export verification).
- No local Playwright was run. The two altered doubles retain the expected held/interleaved synthetic result behavior for protected six-project browser CI.

## Remaining request-byte search

`rg -n 'input\\.bytes|input: \\{ bytes: ArrayBuffer \\}' tests/e2e --glob '*.{ts,tsx}'` returned no results. Remaining `input.bytes` uses are byte-based image/PDF pipeline inputs and the image Worker's post-read pipeline assertion, not `image.pipeline` Worker request consumers.
