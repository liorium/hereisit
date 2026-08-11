# Server-native PDF compression design

**Status:** Approved by the user's recommendation authorization on 2026-08-11

## Goal

Upgrade the existing PDF compression tool without weakening its local-first behavior. HereIsIt keeps the
current zero-upload structural rewrite and bounded scan rasterizer, then offers an explicitly chosen
server-native qpdf pass only when a structured or mixed PDF cannot be reduced locally. A result is exposed
only when it is valid, smaller, and preserves the document semantics required by its preset.

This is the first production native PDF engine, not a claim that every PDF can be reduced. qpdf cannot
resample oversized images. HereIsIt will measure that remaining gap before licensing MuPDF or building a
PDFium image-rewrite engine.

## Approaches considered

1. **Dedicated qpdf container behind the existing processing platform — selected.** Apache-2.0 licensing,
   mature content-preserving transformation, bounded native execution, and no new browser bundle.
2. **Project-built qpdf or PDFium WebAssembly.** Keeps every file local, but qpdf has no supported official
   browser artifact and PDFium would make HereIsIt own a large build, optimizer, memory, and security surface.
3. **MuPDF or Ghostscript.** Stronger image downsampling, but their AGPL/commercial terms do not fit the
   current no-license-fee commercial plan. They remain excluded unless a commercial agreement is approved.

The evidence and primary sources are recorded in
`docs/research/2026-08-11-general-pdf-compression-engine-options.md`.

## User flow

1. Selection, inspection, presets, and the first compression attempt remain on the device.
2. A successful local result is shown immediately; the server is never contacted.
3. If a structured or mixed PDF returns `NO_SIZE_REDUCTION`, the result area explains that the browser
   could not safely reduce it and offers one action: `처리 서버에서 더 압축`.
4. Beside that action, plain Korean copy states that the PDF is uploaded to HereIsIt's processing server
   and that input and result objects are automatically deleted within the existing retention window.
5. Only the explicit button press starts the upload. There is no remembered consent and no automatic retry
   to the server.
6. The server result shows only the source size, result size, reduction percentage, one mode note, and
   `PDF 다운로드`. Share actions, advanced logs, candidate lists, and engine terminology stay hidden.
7. Cancellation, navigation, replacement selection, and unmount delete or abandon the authenticated job
   through the existing lifecycle. The original local file remains the fallback.

## Public contract

Add `pdf.optimize@1` as a second versioned server tool contract. Its request accepts exactly one PDF:

```ts
type PdfOptimizeSpecV1 = {
  version: 1;
  preset: "balanced" | "minimum";
};
```

Limits remain 1 byte to 50 MiB and 1 to 100 pages. The public status result is one of:

- `download`: a smaller `application/pdf` with source/output byte counts, page count, profile,
  engine build identity, and warnings;
- `original-retained`: qpdf produced no candidate meeting the product threshold.

`balanced` permits qpdf's controlled image optimization at JPEG quality 82. `minimum` uses JPEG quality 65.
Both preserve PDF page objects rather than rasterizing whole pages. A lossless structural candidate is also
generated, and the smallest candidate that passes the relevant validation is selected. No result may exceed
`sourceBytes - max(1, ceil(sourceBytes / 100))`.

Warnings are exact and mode-bound: every rewritten document reports signature invalidation; a selected
image-optimized candidate additionally reports that embedded image quality changed. Filenames, PDF contents,
object keys, presigned URLs, extracted text, thumbnails, and rendered pixels never enter logs or analytics.

## Native engine

Create a dedicated `apps/pdf-engine` OCI image with qpdf 12.4.0 pinned to the official source archive
SHA-256 `2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529`. Build qpdf
from the official release source, retain Apache-2.0 and NOTICE material, emit an SBOM, and include the image in
the existing vulnerability and license gates. Do not install Python, Ghostscript, MuPDF, pdfcpu, Poppler, or
community WASM wrappers.

The engine uses an unprivileged user, no network, private per-job directories, exact-length input writes,
bounded diagnostics, and process-group termination. It runs one job at a time with fixed CPU, RSS, wall-time,
temporary-disk, and output-size limits. Arguments are fixed by the validated preset; user filenames and values
never become command-line arguments.

For each candidate the engine runs qpdf's structural check and obtains the page count from qpdf. It rejects
encryption changes, page-count changes, malformed envelopes, partial files, outputs above the byte limit, and
outputs that miss the 1% threshold. Atomic rename publishes only a fully validated candidate. The source and
all candidates are removed when the job settles.

## Processing platform

Reuse authentication, random R2 keys, exact-length upload, idempotency, D1 retention, rate limits, direct
download acknowledgement, cost accounting, sweeps, and privacy-safe telemetry. Generalize the shared job
record by its contract discriminator instead of creating a parallel API.

Add a separate `PDF_JOBS` queue, DLQ, `PdfEngineContainer` binding, and immutable PDF engine image. PDF parser
failures and resource exhaustion therefore cannot share a process, workspace, or queue slot with the image
engine. The existing image contract, queue, container, database rows, rollout, and public behavior must remain
unchanged.

The policy response advertises PDF server processing only for `pdf.optimize@1`. It starts at maintainer-only
canary, then becomes public after the exact release passes staging, browser canary, deletion, cost, and rollback
gates. Because the UI invokes the policy only after a local no-reduction result, existing successful local jobs
create no server cost.

## Browser result verification

The browser does not trust downloaded native output solely because qpdf exited successfully. A dedicated PDF
verification Worker compares source and result before creating the download URL:

- exact PDF envelope, output byte count, and 1% smaller-only threshold;
- unchanged page count, visible page boxes, rotations, non-whitespace text-item counts, annotation counts,
  and conservative operator classes for every page;
- for image-optimized results, 96 DPI renders of at most five deterministic pages (first, last, and evenly
  spaced interior pages) must stay within a fixed pixel-error tolerance;
- for structural-only results, no canvas work is required.

The verifier is bounded by the existing 50 MiB input, 100-page, canvas, timeout, and cancellation ceilings.
Failure discards the result, requests remote deletion, and gives a sanitized retry/local-original message.

## Error handling and recovery

- Unsupported, encrypted, corrupt, oversized, timed-out, or resource-exhausting inputs fail with bounded
  public codes and no provider or parser detail.
- A retryable server or network failure returns to the local no-reduction state; it never loops automatically.
- `original-retained` is a valid outcome, not an error.
- Queue redelivery, duplicate create/run, stale status events, late Worker events, and repeated cancellation are
  idempotent.
- Circuit breaker and cost ceilings can force PDF policy back to local without affecting image processing.
- Deployment rollback restores the previous Worker and both immutable container digests as one release pair.

## Verification and release gates

- Pure contract and planning tests cover strict envelopes, presets, size thresholds, error mapping, and the
  image/PDF discriminator.
- Engine tests use generated, repository-owned fixtures for text, vectors, links, annotations, forms, outlines,
  attachments, layers, scans, mixed pages, encryption, corruption, expansion, and decompression bombs.
- A deterministic benchmark records ratio, warm/cold duration, peak RSS, candidate count, and semantic/visual
  verdict by document class. It must prove a repeatable win over the local structural pass before public rollout.
- API integration tests cover both queues and prove existing image invariants are unchanged.
- Browser tests cover local success with zero network, explicit server disclosure, upload, progress, verified
  direct download, cancellation, fallback, deletion, mobile layout, and Chromium/Firefox/WebKit behavior.
- `pnpm verify` is the local non-browser gate. Protected GitHub CI owns the full Playwright matrix and immutable
  container builds. Staging smoke precedes production canary, public admission, and final production smoke.

## Deliberate exclusions

- no automatic upload;
- no third-party compression API;
- no AGPL engine;
- no OCR, PDF repair, linearization UI, PDF/A conversion, password removal, or new PDF tool;
- no custom PDFium optimizer before benchmark evidence;
- no claim that qpdf matches DPI-aware commercial image downsampling.
