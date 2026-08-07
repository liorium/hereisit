# PDF Compression Engine Research

**Date:** 2026-08-07

## Decision

Ship a conservative browser-first optimizer before adding another runtime:

1. Rewrite the PDF with the already-installed MIT-licensed `@cantoo/pdf-lib`, object streams enabled,
   and metadata updates disabled. Offer this candidate only when it is at least 1% smaller.
2. If that candidate is not smaller, use the existing PDF.js raster path only when every page is
   confidently image-only: no visible text, no annotations, at least one image paint operation, and no
   vector, form, shading, or text paint operation.
3. Preserve the existing source-relative 1% postcondition. An ambiguous, general, or mixed document
   that cannot be reduced without rasterization returns an honest no-reduction result instead of losing
   searchable content.

This increment adds no dependency, upload, server cost, or copyleft obligation.

## Primary-source findings

- PDF.js exposes `getTextContent()`, `getAnnotations()`, and `getOperatorList()` on `PDFPageProxy`, so
  the installed parser can provide conservative page signals without rendering a second copy.
  Source: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html
- PDF.js is Apache-2.0 licensed. Source: https://github.com/mozilla/pdf.js
- qpdf is Apache-2.0 and describes itself as a content-preserving PDF transformer. Its optimizer can
  generate object streams, recompress Flate streams, and optionally convert supported non-JPEG images
  to JPEG, but it does not resample images. Source: https://github.com/qpdf/qpdf and
  https://qpdf.readthedocs.io/en/stable/cli.html#optimizing-file-size
- The browser qpdf package found during evaluation (`@lafraise/qpdf`) is AGPL-3.0-or-later rather than
  a first-party qpdf browser distribution. It is not suitable for this commercial browser bundle.
  Source: https://www.npmjs.com/package/@lafraise/qpdf
- pdfcpu is Apache-2.0 and can remove duplicate page resources, fonts, and images, but its supported
  product surface is a Go library/CLI rather than an official browser package. Source:
  https://github.com/pdfcpu/pdfcpu
- Ghostscript is offered under AGPL or a commercial license, and Artifex states that commercial SaaS
  or closed distribution must either comply with AGPL or buy a commercial license. Source:
  https://ghostscript.com/faq/index.html
- MuPDF likewise states that embedding under its open-source distribution uses AGPL and otherwise
  requires a commercial license. Source: https://mupdf.com/releases

## Deferred production tier

When real usage proves that browser structural rewriting leaves material savings on the table, add an
explicitly disclosed server tier using a project-built, pinned qpdf or pdfcpu binary. Benchmark it on a
licensed corpus before rollout. Do not adopt a third-party WASM wrapper merely to avoid that deployment:
the current wrappers do not meet the project's provenance, license, and maintenance bar.

