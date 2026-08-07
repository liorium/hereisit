# Smart Local PDF Compression Design

**Status:** Approved by the user's standing recommendation authorization on 2026-08-07

## Summary

Extend the existing local PDF compression worker with a safe automatic first pass. It first attempts a
structure-preserving rewrite. If that cannot save at least 1%, it rasterizes only documents for which
every page is confidently image-only. General and mixed PDFs remain searchable and interactive; when the
browser cannot reduce them safely, the tool says so instead of silently flattening them.

## Approaches considered

1. **Browser smart gate — selected.** Reuse `@cantoo/pdf-lib` and PDF.js, add no dependency, keep files on
   device, and improve both general and scanned PDFs while defaulting to preservation under uncertainty.
2. **Third-party qpdf WASM.** Potentially stronger structural compression, but the available package is
   not a first-party build and the evaluated wrapper is AGPL. Rejected for provenance and licensing.
3. **Server qpdf/pdfcpu.** Strongest long-term optimizer surface and permissive upstream licenses, but it
   adds upload disclosure, container work, cost, and a larger security boundary. Deferred until corpus
   benchmarks justify it.

## Contract

The existing `pdf.compress-scanned@1` request and result remain available for compatibility. The web
application moves to `pdf.compress-scanned@2`; its fulfilled result adds a required `mode`
discriminator:

```ts
type PdfCompressScannedSpecV2 = { version: 2; preset: "balanced" | "minimum" };
type PdfCompressMode = "structure-preserving" | "rasterized";
```

`structure-preserving` results keep the source document objects while rewriting serialization with
object streams. Their `warnings` contain only `SIGNATURES_INVALIDATED`; any byte rewrite necessarily
invalidates existing digital signatures. `rasterized` results retain the existing five destructive
warnings and fixed preset metadata.

The public wrapper validates the mode, its exact warning set, the 1% size postcondition, page count,
PDF envelope, timing bounds, and preset metadata before exposing bytes to React.

## Compression flow

1. Validate the transferred input and calculate the exact 1% target.
2. Load once with `@cantoo/pdf-lib`, save with `useObjectStreams: true`, `updateMetadata: false`, and
   `updateFieldAppearances: false`, then validate the PDF envelope and page count.
3. If the structural candidate meets the target, return immediately without starting PDF.js or creating
   a canvas.
4. Otherwise open the existing bounded PDF.js session. During the existing page-planning pass, collect
   text, annotation, and operator-list signals for each page.
5. Rasterization is allowed only when every page has no non-whitespace text, no annotation, at least one
   image paint operation, and no vector path, form, shading, raw path, or text paint operation.
6. If any page is ambiguous, reject with `NO_SIZE_REDUCTION` and preservation-focused Korean copy.
7. A confidently scanned document continues through the existing one-page-at-a-time JPEG pipeline and
   receives the existing raster warnings.

## Safety and ceilings

- Input remains local and capped at 50MB and 100 pages.
- Classification is intentionally one-sided: false negatives only reduce compression opportunities;
  uncertainty never authorizes destructive conversion.
- PDFs with OCR text are treated as structured documents and are not flattened automatically.
- Mixed documents receive only structural compression in this increment. Selective page replacement is
  deferred because copying pages can lose document-level outlines, forms, attachments, and signatures.
- Password-protected, corrupt, oversized, timed-out, and cancelled jobs keep existing behavior.
- The structural rewrite is not claimed to optimize embedded image codecs. A server-native optimizer is
  the upgrade path when measured demand justifies upload and operations.

## UI

Keep the current stage-by-stage interface and preset controls. Replace scan-only promises with plain
Korean copy explaining that text and links are kept whenever possible, while image-only scans may be
rebuilt for stronger savings. The result note derives from `mode`: either `텍스트와 링크를 유지했어요.`
or `스캔 페이지를 가볍게 다시 만들었어요.` No new setting, modal, or consent step is added.

## Verification

- Pure tests prove the conservative classification matrix.
- Pipeline tests prove early structural success never opens PDF.js, general/mixed ambiguity never
  rasterizes, and image-only documents retain the current bounded raster path.
- Contract-wrapper tests reject mismatched mode/warning combinations.
- Component and browser tests assert the two result messages and direct download behavior.
- `pnpm verify` is the local gate. The known disk-bound image-engine container build is left to CI.
