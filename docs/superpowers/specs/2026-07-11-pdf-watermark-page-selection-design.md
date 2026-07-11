# PDF Watermark Page Selection Design

**Status:** Approved on 2026-07-11

## Summary

Add an explicit `모든 페이지 / 지정 페이지` choice to the existing local PDF watermark tool. The
versioned contract and browser pipeline already support selected pages, so this release is intentionally
limited to UI wiring, validation copy, and lifecycle regression coverage. It introduces no dependency and
does not change the PDF transformation algorithm.

## Goals

- Let a user apply one text watermark to every page or to a validated page list such as `1-3, 5`.
- Preserve the current browser-only privacy boundary and result format.
- Keep invalid range syntax from starting a job.
- Report a page number beyond the source document as a clear range error.
- Add regression evidence for cancellation, stale Worker events, and result object URL cleanup.

## Non-goals

- Page thumbnails or a visual page picker.
- A different watermark per page.
- Image watermarks.
- Password-protected PDFs.
- Retaining electronic signatures or every advanced PDF document feature.
- Changing the watermark bitmap, placement, color, rotation, opacity, or font-size implementation.

## User experience

The settings panel gains a `적용 페이지` radio group after the existing watermark appearance controls.
Its default is `모든 페이지`, preserving current behavior. Selecting `지정 페이지` reveals a text input
labelled `페이지 범위` with the same grammar as PDF extraction: comma-separated pages and inclusive
ranges, for example `1-3, 5`.

The UI parses the range as the user types and displays either the number of selected pages or the existing
Korean parser error. The run button is disabled while the syntax is invalid. Changing the scope or range
clears any previous result and revokes its object URL.

The watermark screen does not pre-inspect the PDF. Pre-inspection would read and parse the complete file in
an additional Worker solely to improve an error that the transformation Worker already validates. A range
that is syntactically valid but exceeds the real page count starts the job and settles with
`PAGE_RANGE_INVALID` and a clear Korean message.

## Architecture and data flow

The existing `pdfPageSelectionSchema` remains the single contract for page selection. No protocol version
or tool version changes.

`PdfWorkbench` adds these UI-only states:

- `watermarkScope: "every-page" | "selected-pages"`, default `"every-page"`.
- `watermarkPageRange: string`, default `"1"`.
- A memoized `parsePageSelection(watermarkPageRange)` result.

`buildSpec()` maps UI language to the existing contract:

```ts
selection:
  watermarkScope === "every-page"
    ? { mode: "every-page" }
    : { mode: "extract", pages: [...parsedWatermarkPages] }
```

The internal word `extract` is not shown in the watermark UI. The existing Worker pipeline creates a set of
selected one-based page numbers and draws the watermark only on matching pages. The output remains one PDF
with the same page count and order as the source.

## Errors and limits

- The existing PDF input limit remains one file of 1 byte through 50MB.
- The existing document limit remains 500 pages.
- A selected page list contains 1 through 500 unique one-based page numbers.
- Empty, reversed, zero, negative, and out-of-contract ranges never start a job.
- Repeated page numbers are normalized to one sorted page entry by the existing range parser before the
  contract is built.
- A syntactically valid page above the source count maps to `PAGE_RANGE_INVALID`.
- Cancellation settles once with `cancelled`, terminates the Worker, and ignores later events.
- A failed or cancelled operation does not expose a partial PDF.

## Lifecycle hardening

The release adds tests around the current runtime rather than changing working lifecycle code speculatively.
Production lifecycle code changes only when a failing regression test demonstrates a defect.

Coverage includes:

- Cancel before file reading completes.
- Cancel after the Worker has received a request.
- Ignore progress and completion messages after cancellation or settlement.
- Terminate each Worker exactly once.
- Settle a three-minute timeout as a retryable Worker failure.
- Revoke the previous PDF result URL on settings change, reset, rerun, and unmount.

## Testing

### Unit and runtime

- The watermark contract accepts `every-page` and valid selected pages.
- The direct contract rejects empty, duplicate, zero, negative, and more-than-500 page arrays; the UI parser
  normalizes repeated range input before it reaches that contract.
- `runPdfJob` lifecycle tests cover cancel, timeout, stale events, and Worker creation failure.
- Existing pipeline coverage continues to prove that an unselected page is unchanged while a selected page
  receives watermark content.

### Browser

- Convert a two-page PDF after choosing only page 2.
- Load the output and verify page 1 has no new content while page 2 does.
- Verify the operation sends no external request and no write request.
- Verify range controls and the run/save controls are touch-safe on an iPhone viewport.
- Verify settings changes revoke the previous object URL.
- Run Chromium, Firefox, desktop WebKit, mobile Chromium, and mobile WebKit in CI.

## Acceptance criteria

- The default all-page flow behaves exactly as before.
- A valid selected-page flow changes only the requested pages.
- Invalid syntax prevents execution and explains the correction.
- An out-of-bounds page produces `PAGE_RANGE_INVALID`, not a generic write failure.
- All core and browser verification passes without adding a dependency.
- Cloudflare Pages serves the updated route with the existing security headers.
- User-facing route copy, README limits, and architecture documentation say that every page or selected
  pages can receive the watermark.

## Rollout

Ship this change as the first independent release. Verify GitHub CI, Cloudflare deployment, and one live
all-page and selected-page flow before starting the PDF-to-images release.
