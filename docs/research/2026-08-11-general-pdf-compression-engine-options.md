# General PDF Compression Engine Research

**Date:** 2026-08-11

**Scope:** commercially usable local-first and optional server-side PDF compression for HereIsIt

**Status:** engineering and license-screening recommendation, not legal advice

## Decision

Use a two-tier engine and add no new browser dependency:

1. Keep the installed `@cantoo/pdf-lib` + PDF.js browser path for the immediate structural rewrite,
   conservative document classification, and image-only scan rasterization.
2. Add one optional, explicitly disclosed server-native path using a pinned qpdf binary in a dedicated
   PDF container. Reuse the existing upload, queue, temporary-object, progress, download, and deletion
   platform.
3. Run qpdf in a structure-preserving profile first. Enable its lossy image optimization only in a named
   lossy preset and only when the result is smaller and passes semantic and visual validation.
4. Do not ship MuPDF, MuPDF.js, or Ghostscript unless HereIsIt later buys a commercial license or makes
   an intentional AGPL product decision.
5. Do not build a custom PDFium image-rewrite engine until a representative corpus proves that qpdf plus
   the existing scan path misses enough real documents to justify the much larger maintenance surface.

This is the smallest realistic architecture that improves general PDFs without flattening their text,
vectors, links, forms, or annotations. It does not pretend that qpdf can match a full commercial image
downsampling engine: qpdf does not resample images.

## Current HereIsIt baseline

The repository already pins `@cantoo/pdf-lib` 2.7.1 and `pdfjs-dist` 6.2.108 in the browser runtime
([package manifest](../../packages/browser-runtime/package.json)). The current compression worker:

- loads and reserializes the source with object streams;
- returns that structural candidate only when it beats the source-relative size target; and
- otherwise rasterizes only conservatively classified image-only documents, one page at a time
  ([pipeline](../../packages/browser-runtime/src/pdf-compress-scanned-pipeline.ts)).

That is a safe local baseline, but it is not a general optimizer. `@cantoo/pdf-lib` can create, modify,
and reserialize documents in browsers and is MIT licensed, but its documented product surface does not
include embedded-image resampling, font subsetting as an optimizer, or duplicate-resource optimization
([official repository](https://github.com/cantoo-scribe/pdf-lib),
[license](https://github.com/cantoo-scribe/pdf-lib/blob/master/LICENSE.md)). PDF.js is an Apache-2.0
parser, display, and rendering library, not a PDF writer or compression engine
([layers](https://mozilla.github.io/pdf.js/getting_started/),
[license](https://github.com/mozilla/pdf.js/blob/master/LICENSE)). A PDF.js canvas rebuild necessarily
turns page content into pixels, so it cannot preserve searchable text, vectors, links, forms, or the
original document structure.

## Primary-source comparison

| Engine | What it can reduce | Text/vector/link preservation | Browser/local-first status | License and commercial fit | Decision |
| --- | --- | --- | --- | --- | --- |
| `@cantoo/pdf-lib` | Reserialization and object streams can remove some serialization overhead. No documented general image-resampling or resource-dedup optimizer. | Intended to retain the loaded object graph when merely resaved, but every rewrite invalidates existing digital signatures and must be regression-tested on complex PDFs. | Already installed; works in browsers. | MIT ([license](https://github.com/cantoo-scribe/pdf-lib/blob/master/LICENSE.md)); compatible with a commercial product with notice retention. | Keep as the zero-upload fast path; do not call it a full compressor. |
| PDF.js / `pdfjs-dist` | Parses, inspects, extracts text/annotations/operator lists, and renders pages. It does not write optimized PDFs. | Inspection preserves nothing by itself; rasterize-and-rebuild loses searchable/interactive structure. | First-party browser build; already installed. | Apache-2.0 ([project](https://github.com/mozilla/pdf.js), [license](https://github.com/mozilla/pdf.js/blob/master/LICENSE)). | Keep for classification and bounded rasterization only. |
| qpdf | Generates object streams, compresses streams, recompresses Flate streams, removes unreachable objects, and can replace supported images with JPEG when smaller. Optional Zopfli yields slightly smaller Flate output at a very large speed cost. | qpdf describes itself as a content-preserving transformer. The lossless structural profile retains page content and document objects; the optional JPEG profile changes image data but does not rasterize whole pages. | C++ CLI/library. As of 2026-08-11 the official 12.4.0 release publishes native binaries/source but no browser/WASM artifact; its official source archive is SHA-256 `2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529` ([release](https://github.com/qpdf/qpdf/releases/tag/v12.4.0)). | Apache-2.0 ([repository and license](https://github.com/qpdf/qpdf)); compatible with a commercial service when Apache/NOTICE obligations are met. | **Selected server engine.** Best maturity/capability/license ratio with the fewest new layers. |
| pdfcpu | Removes redundant page resources such as duplicate fonts/images and can generate object/xref streams; its optimizer is resource-centric rather than an image-downsampling pipeline. | It edits PDF objects/resources instead of rendering pages, so its intended optimizer path keeps page semantics. Validate complex forms, annotations, outlines, and signatures on the corpus. | Go library/CLI. The official project presents CLI and Go APIs, not a supported browser compressor. | Apache-2.0 ([repository](https://github.com/pdfcpu/pdfcpu), [license](https://github.com/pdfcpu/pdfcpu/blob/master/LICENSE.txt)); commercially compatible. PDF 2.0 validation is described as basic and improving. | Credible benchmark challenger, not the first runtime: it overlaps qpdf and adds another parser/update stream. |
| pikepdf | Exposes qpdf stream/object-stream compression, resource cleanup, and qpdf's Job API through Python. Its own `remove_unreferenced_resources()` can purge unused page resources. | Same low-level, structure-preserving foundation as qpdf; no independent image-downsampling advantage. | Python extension backed by native qpdf; unsuitable for the browser. | MPL-2.0; the project states it may be combined with commercial closed-source work while modifications to pikepdf itself remain subject to MPL ([repository/license explanation](https://github.com/pikepdf/pikepdf)). | Reject for this path: direct qpdf avoids Python and provides the same core optimizer. |
| MuPDF / MuPDF.js | `mutool clean` can garbage-collect and deduplicate objects, compress streams/fonts/images, use object streams, subset fonts experimentally, and resample/recompress color, gray, and bitonal images by DPI and codec. | Structure-aware cleaning can retain text and vectors; selected write options may alter metadata, images, structure trees, annotations, or signatures and require profile-specific validation. | Official MuPDF.js wraps the C engine in WebAssembly and works in modern browsers ([official JS repository](https://github.com/ArtifexSoftware/mupdf.js)). | AGPL-3.0-or-later or commercial license, applying to the wrapper and WASM binary ([MuPDF.js license statement](https://github.com/ArtifexSoftware/mupdf.js#license), [MuPDF releases](https://mupdf.com/releases)). | Technically strongest single engine, but excluded from the proprietary/SaaS path without a commercial agreement. |
| Ghostscript `pdfwrite` | Strong image downsampling/recompression and PDF regeneration; presets trade quality for size. | It creates a new PDF from interpreted marking operations rather than preserving the original internals. Official docs warn that even PDF-to-PDF can lose non-marking data; some Link and Widget annotations are not preserved. | Native interpreter/output device; no first-party product-grade browser package identified. | AGPL or Artifex commercial license. Artifex explicitly directs proprietary and SaaS deployments to a commercial license ([FAQ](https://ghostscript.com/faq/index.html), [releases](https://ghostscript.com/releases/)). | Exclude without a commercial license; semantic loss also conflicts with the default preservation goal. |
| PDFium | Public APIs can enumerate/render image objects, read image metadata/data, replace an image bitmap/JPEG, and save a document copy. It has no one-call general compression policy. | A carefully built selective image rewriter can leave text/vectors/links in place, but HereIsIt would own traversal, shared-resource handling, DPI policy, codec choice, output regeneration, and validation. | Official source is a large Chromium-style C++ build. No official compression-focused browser/WASM distribution was identified. | PDFium source uses BSD-style terms and its main license includes additional component terms; a shipped build needs a complete third-party license inventory ([license](https://pdfium.googlesource.com/pdfium/+/main/LICENSE)). | Future custom-engine foundation only. The build/security/update burden is unjustified before corpus evidence. |

## What preserves document semantics

### Preserving by default

- `@cantoo/pdf-lib` structural reserialization, qpdf structural optimization, pdfcpu resource optimization,
  and pikepdf/qpdf rewriting operate on PDF objects rather than page pixels.
- qpdf is the strongest selected default because its official scope is content-preserving transformation,
  while its optimizer can still compress streams and objects
  ([qpdf overview](https://github.com/qpdf/qpdf),
  [file-size options](https://qpdf.readthedocs.io/en/latest/cli.html#optimizing-file-size)).
- These paths can preserve text, vector graphics, links, outlines, forms, annotations, attachments, and
  layers in principle, but HereIsIt must verify them across its corpus. A byte rewrite invalidates existing
  digital signatures even when the visible and semantic content is unchanged.

### Preserving content but changing images

qpdf's `--optimize-images` can convert supported non-JPEG images to JPEG when smaller; its current
`--jpeg-quality` option can also recompress existing JPEG data. This retains the surrounding PDF objects,
text, vectors, and links while making image pixels lossy. qpdf explicitly does **not** resample images, so
an oversized 600-DPI scan displayed at 150 DPI remains oversized in pixel dimensions
([official qpdf options](https://qpdf.readthedocs.io/en/latest/cli.html#optimizing-file-size)).

MuPDF has the missing DPI-aware image subsampling and codec-selection surface, including JPEG, JPEG 2000,
Fax, and JBIG2 choices, while keeping non-image page content as PDF objects
([`mutool clean`](https://mupdf.readthedocs.io/en/latest/tools/mutool-clean.html)). Its AGPL/commercial
license, not its technical ability, blocks selection for the current commercial architecture.

### Not preserving structure

- PDF.js-to-canvas plus a new PDF rasterizes the page. It is correct for image-only scans but removes
  searchable text, vectors, links, forms, annotations, bookmarks, attachments, layers, and signatures.
- Ghostscript `pdfwrite` is a high-level conversion device. It tries to reproduce appearance, but its own
  documentation says the new PDF does not have the same internals and calls out preservation gaps for
  non-marking information and annotation types
  ([high-level devices](https://ghostscript.readthedocs.io/en/latest/VectorDevices.html)).

## Smallest realistic HereIsIt architecture

```text
browser inspection
  ├─ structure candidate is >=1% smaller → local download
  ├─ confidently image-only scan         → existing bounded local raster path
  └─ structured/mixed and no local gain
       → explicit upload/deletion notice
       → existing Worker/R2/Queue job platform
       → one dedicated pdf-engine container with pinned qpdf
       → validate + smaller-only gate
       → authenticated download + scheduled deletion
```

### Browser tier

Keep the current dependencies and worker boundaries. Do not add qpdf/PDFium community WASM wrappers:
there is no first-party qpdf browser artifact in the current official release, PDFium would require a
project-owned build, and the only credible first-party full browser engine found is MuPDF.js with
AGPL/commercial terms.

The browser tier should remain responsible for:

- magic-byte, size, encryption, page-count, and bounded geometry checks;
- conservative PDF.js classification using text, annotations, and drawing operators;
- the current `@cantoo/pdf-lib` structural candidate;
- image-only scan rasterization with bounded canvas memory; and
- explicit disclosure before any server upload.

### Server tier

Reuse the existing control plane and add one portable `pdf-engine` OCI image, not a Python service or a
second orchestration system. The container should invoke one pinned qpdf binary with two measured profiles:

- **Preserve:** stream compression, Flate recompression, generated object streams, and unreachable-object
  removal. No lossy image conversion.
- **Balanced:** Preserve plus qpdf image optimization and a fixed JPEG-quality policy. This remains
  structure-preserving but is lossy for affected images.

Do not enable qpdf's optional Zopfli path by default. qpdf documents roughly 100× slower compression for
about 5% improvement over the strongest ordinary Deflate result; that is a poor latency/cost default
([Zopfli notes](https://qpdf.readthedocs.io/en/latest/cli.html#zopfli-compression-algorithm)).

Every server run must keep the existing platform's exact-length upload, random object keys, no-filename
boundary, CPU/RSS/time limits, idempotency, deletion, and no-content logging rules. Before release, pin the
qpdf source/version/digest, include its Apache license and NOTICE material, generate the existing SBOM, and
follow qpdf security releases.

### Result gate

Offer the server result only when all of these hold:

1. qpdf exits successfully and its structural check passes;
2. the output has a valid PDF envelope, unchanged page count, and sane page boxes/rotations;
3. required semantic fixtures retain text, links, annotations, forms, outlines, attachments, and layers;
4. rendered comparison stays within the preset's tolerance;
5. output size beats the source by the product threshold; and
6. a signed input was either rejected or shown with the existing signature-invalidated warning.

The source remains the fallback. Never return a larger or partially written candidate.

## Why not chain qpdf and pdfcpu

Both are permissively licensed and credible, but their structural optimizers overlap. Chaining them means
two untrusted-input parsers, two security/update streams, more cold-start bytes, more temporary I/O, and a
larger compatibility matrix. Start with qpdf because it is explicitly content-preserving, actively
maintained, and now includes controlled image-to-JPEG optimization. Benchmark pdfcpu as an offline
challenger; add it only if it produces a material, repeatable win on documents qpdf misses.

## Upgrade trigger, not speculative scope

qpdf plus the existing raster scan path will still miss structured PDFs dominated by oversized embedded
images that need DPI-aware resampling. Collect a licensed benchmark corpus and record compression ratio,
warm/cold latency, peak RSS, visual tolerance, and semantic preservation by document class. Only if that
gap is common and commercially material should HereIsIt choose between:

1. a paid MuPDF commercial license; or
2. a project-owned PDFium/native selective-image engine using the public image object and save APIs
   ([image APIs](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_edit.h),
   [save APIs](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_save.h)).

The second option is proprietary engine development, not a small dependency change. It requires effective
DPI calculation through transforms/forms, shared-image handling, masks, ICC/color-space policy, JPEG/JPEG
2000/JBIG2 decisions, font/subset policy, fuzzing, and continuous PDFium security updates. Do not build it
before the benchmark proves the need.

## Final recommendation

Implement the next PDF-compression contract version with the current local engine plus one optional qpdf
server implementation. This moves HereIsIt beyond MVP-level general compression while retaining text and
interactive structure, keeps licensing compatible with commercial operation, and reuses the platform that
already exists. It is not the theoretical maximum compression ratio; it is the smallest production-grade
step whose capability, privacy boundary, operational cost, and license obligations can all be stated
honestly.
