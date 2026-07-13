# Image Watermark Design

**Status:** Approved on 2026-07-13

## Summary

Add a local-only `/image/watermark` tool that places either text or one reusable logo image on up to
100 source images. The tool offers nine anchored positions plus bounded size, margin, opacity, text
color, and output controls. Source images and the optional logo stay in dedicated browser Workers and
are never uploaded.

The feature has an independent `image.watermark@1` contract and workbench. It shares focused image
inspection, safe naming, and canvas-encoding internals where appropriate, but it does not widen or change
the established `image.pipeline@1` behavior used by compression, resizing, and conversion.

## Goals

- Add text or a JPG, PNG, or WebP logo watermark to one through 100 images in one run.
- Keep source pixels, filenames, the logo, and results in the current browser tab and its Workers.
- Provide predictable placement with nine anchors, relative sizing, relative margins, and opacity.
- Preserve source dimensions and orientation while stripping private metadata through a full canvas draw.
- Default to the source format for JPG, PNG, and WebP; convert HEIC sources to JPG explicitly.
- Reuse one decoded logo per active Worker instead of decoding it again for every source image.
- Keep UI work responsive with bounded concurrency, immediate cancellation, honest per-item progress,
  partial-batch success, and explicit result saving.
- Keep the existing image and PDF tools behaviorally and bundle-isolated.

## Non-goals

- Tiled, repeated, diagonal, curved, multi-line, rich-text, or per-image watermark settings.
- Multiple logos, custom font uploads, font-family selection, text outlines, shadows, or blend modes.
- Dragging the watermark directly on a canvas or providing a continuously rendered live preview.
- Cropping, resizing, rotation, compression-to-target, animation preservation, or EXIF retention.
- HEIC logos, SVG logos, video, PDF pages, server processing, upload fallback, or cloud result storage.
- Guaranteeing that the result is smaller than the source. Adding and re-encoding a watermark can
  increase file size.

## Approach decision

Version 1 uses a dedicated `image.watermark@1` contract, Worker, batch runner, and workbench. Low-level
header inspection, geometry primitives, metadata-free canvas encoding, result validation, and naming can
be shared as focused internal helpers. This keeps the public contract narrow and prevents watermark asset
lifecycle or UI state from complicating `image.pipeline@1`.

Two alternatives are rejected:

1. Adding an optional watermark field to `image.pipeline@1` would be quicker initially, but it would
   change an established versioned contract and force existing compression, resizing, and conversion
   jobs to understand a second input asset.
2. Drawing on a main-thread canvas would avoid a Worker protocol, but it would duplicate safety checks,
   make large batches less responsive, and weaken cancellation and memory isolation.

## Versioned contract

The dedicated public contract is:

~~~ts
const IMAGE_WATERMARK_TOOL_ID = "image.watermark";
const IMAGE_WATERMARK_TOOL_VERSION = 1;

type ImageWatermarkPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

type ImageWatermarkSpecV1 = {
  version: 1;
  watermark:
    | {
        kind: "text";
        text: string;
        color: `#${string}`;
        sizePercent: number;
      }
    | {
        kind: "logo";
        widthPercent: number;
      };
  position: ImageWatermarkPosition;
  marginPercent: number;
  opacity: number;
  output:
    | { format: "source"; quality: number }
    | { format: "jpeg"; quality: number; matte: "#ffffff" }
    | { format: "webp"; quality: number }
    | { format: "png" };
  autoOrient: true;
  metadata: "strip";
};
~~~

Validation rules are:

- Text is trimmed, NFC-normalized, one line, 1–80 Unicode code points, and rejects control and
  bidirectional-override characters using the existing safe-text policy.
- Text `sizePercent` is an integer from 4 through 30 and means font size relative to the source image's
  shorter displayed side. The runtime shrinks overlong text to the available width rather than clipping
  it.
- Logo `widthPercent` is an integer from 5 through 50 and means rendered logo width relative to the
  source image width. Aspect ratio is preserved, and the runtime shrinks the logo further when required
  to fit the available height.
- `marginPercent` is an integer from 0 through 10 and is measured from the source image's shorter side.
  It does not change the centered anchor.
- `opacity` is from 0.05 through 1.0.
- Text color is exactly six-digit hexadecimal RGB.
- Lossy quality is an integer from 40 through 95.

The Worker request carries one source image input. A logo-mode Worker is configured once with a separate
bounded logo input before it accepts jobs; individual jobs reference that configured asset rather than
embedding its bytes in every spec. Text mode requires no secondary input. The logo configuration and job
messages are strict discriminated protocol events and settle at most once.

The fulfilled result contains output bytes, suggested name, MIME, width, height, source byte length,
output byte length, resolved output format, warnings, and inspect/decode/composite/encode/total timing.
Warnings can report HEIC-to-JPG conversion and browser color-profile normalization. Progress phases are
`validating`, `decoding`, `compositing`, `encoding`, and `finalizing`.

## Output behavior

`source` output resolves from the structurally inspected source MIME, never from the extension or MIME
hint:

| Source | Resolved output | Transparency |
| --- | --- | --- |
| JPG | JPG at selected quality | flattened on white |
| PNG | lossless PNG | retained |
| WebP | WebP at selected quality | retained |
| HEIC/HEIF | JPG at selected quality | flattened on white |

Explicit JPG always fills opaque white before drawing the source. Explicit PNG and WebP retain alpha.
Canvas reconstruction removes EXIF, GPS, camera, and source container metadata. The UI says clearly that
source-format output is a newly encoded file, not a byte-preserving edit, and that its size can increase.

Suggested names follow `photo-watermarked-hereisit.jpg`. ZIP creation resolves duplicate suggested names
deterministically with `-2`, `-3`, and later suffixes and produces `hereisit-watermarked-images.zip`.
Nothing downloads automatically; the user saves one result or explicitly creates the batch ZIP.

## Geometry and rendering

`@hereisit/image-tool` owns pure geometry and naming helpers. Given the displayed source dimensions,
watermark rectangle, relative margin, and anchor, it returns a finite in-bounds draw rectangle. All nine
positions share one anchor table so horizontal and vertical behavior cannot drift between text and logo
modes.

The Worker decodes the auto-oriented source, creates one output-sized `OffscreenCanvas`, fills the JPG
matte when required, and draws the source once. Text mode measures a bold system sans-serif string and
uses the requested shorter-side-relative size, shrinking only enough to fit the available width. Logo
mode uses the already decoded per-Worker logo bitmap and scales it proportionally. The Worker saves the
canvas state, applies `globalAlpha`, draws the watermark once, restores state, and encodes the final
canvas.

The pipeline validates decoded dimensions again after `createImageBitmap()` and validates the output
MIME and structural signature after encoding. It closes each source `ImageBitmap` after its job; a cached
logo `ImageBitmap` closes when its Worker is replaced, cancelled, failed, or finished. It does not retain
source canvases, previews, or result Blob URLs inside the Worker.

## Components and boundaries

### Domain helpers

`@hereisit/image-tool` owns browser-independent behavior for:

- validating and computing all nine anchored draw rectangles;
- fitting text and proportional logos without clipping;
- resolving `source` output format from an inspected format;
- generating safe output and collision-free archive names.

### Browser runtime

The runtime adds focused modules:

- `image-watermark-pipeline.ts` for validation, decode, composition, encode, and result postconditions;
- `image-watermark.worker.ts` for strict logo configuration, job execution, cancellation, and transfers;
- `run-image-watermark-batch.ts` for file reading, at most two reusable Workers, per-slot logo caching,
  result budgets, timeouts, progress, partial success, and termination.

Where existing image-pipeline helpers are extracted, their behavior remains covered by the existing
tests. The existing `image.worker.ts` and `runImageBatch()` request/response contracts do not change.

### Web application

Add `ImageWatermarkWorkbench`, `ImageToolPage` support for the `watermark` intent, and the static
`/image/watermark` route. Site metadata, sitemap, navigation, home cards, and related-image tools continue
to derive from the central site registry.

The dedicated workbench owns source files, optional logo file, settings, object URLs, result state,
batch handle, and save/share/ZIP lifecycle. It follows the existing three-column desktop anatomy and
mobile order: source list, settings, selected original/result preview, then sticky actions. It does not
add a new visual system or change existing tool pages.

## User experience

The route presents:

- Navigation label: `이미지 워터마크`.
- Title: `이미지에 워터마크 넣기`.
- Description: `사진과 이미지에 문구 또는 로고를 넣으세요. 파일은 서버로 전송되지
  않습니다.`
- Default summary: text watermark, `© HereIsIt`, bottom-right, 12% size, 3% margin, 55% opacity,
  `#111827`, and source-format output at quality 90.

The empty state accepts JPG, PNG, WebP, HEIC, or HEIF sources under the watermark limits below. After
selection, the settings panel provides:

- `문구 / 로고 이미지` mode;
- text and color controls, or a required JPG/PNG/WebP logo selector;
- an accessible three-by-three position radio grid;
- size, opacity, and margin controls with visible numeric values;
- `원본 형식 / JPG / PNG / WebP` output and lossy quality when applicable.

Changing any setting invalidates prior results and revokes their object URLs. Switching away from logo
mode retains the selected logo for convenience but does not send or decode it for text jobs. Removing or
replacing the logo revokes its preview and invalidates results. The action says `N개 이미지에 워터마크
넣기 →` and is disabled for invalid text, a missing/invalid logo, unsupported runtime, or an empty batch.

Processing shows per-item phase and overall completed count. Cancellation immediately terminates active
Workers; already completed results remain explicitly savable and unfinished items become cancelled.
Successful items show source and output dimensions, byte size, elapsed time, and the generated preview.
Failed items show their own corrective error without discarding other successes.

Before and after processing, the UI states that files stay on the device, metadata is removed, the
source is unchanged, and re-encoding can change size or color profile. Results are released when reset,
replaced, rerun, or unmounted.

## Resource and failure policy

- Source batch: 1–100 files, 1 byte–50MiB each, 250MiB combined input.
- Source geometry: at most 16,384px per side and 25,000,000 displayed output pixels per item. The source
  is decoded only after structural inspection and checked again after orientation is applied.
- Logo: one JPG, PNG, or WebP, 1 byte–10MiB, at most 8,192px per side and 16,000,000 pixels. Animated
  logos are rejected rather than flattened silently.
- Concurrency: at most two Workers and one Worker when reported device memory is unknown or 4GiB or less.
- Logo caching: the file is read once by the batch runner, copied at most once per active Worker, decoded
  once per Worker, reused across its jobs, and closed on replacement, cancellation, failure, or finish.
- Result: at most 100MiB per item and 500MiB retained across the batch.
- Watchdog: 180 seconds per active item; a timed-out Worker is terminated and replaced for remaining
  queued items.

Expected failures use structured codes for invalid settings, unsupported/animated/corrupt inputs,
dimension or memory limits, decode/encode failures, a missing or invalid logo, cancellation, timeout, and
Worker crashes. Worker configuration or message-decode failure cannot leave a batch pending. No partial
bytes from a failed item are exposed.

## Privacy and security

- Source and logo bytes are read only after the dedicated Worker reports supported capabilities.
- No input URL is passed to a decoder; Workers receive transferred local `ArrayBuffer` values.
- No request, upload, CDN, analytics payload, or server fallback carries bytes, filenames, previews, or
  object URLs.
- Filenames and file contents are not logged.
- Existing CSP remains unchanged; the feature needs no evaluation, WebAssembly, remote script, or extra
  network origin.
- Object URLs are owned by the workbench and revoked on every replace, rerun, reset, and unmount path.

## Testing and release proof

Pure unit tests cover contract boundaries, unsafe text, all nine anchor rectangles, margins, text fitting,
proportional logo fitting, source-output resolution, safe output naming, and duplicate ZIP names.

Runtime tests cover source inspection before decode, post-decode limits, source draw before watermark
draw, JPG matte, PNG/WebP alpha, opacity state restoration, one logo decode per Worker, result signatures,
exact dimensions, metadata removal, output budgets, cancellation, timeout, stale events, malformed Worker
events, partial success, and all cleanup paths. Existing image-pipeline suites must remain unchanged and
green.

Browser tests cover unique route metadata, keyboard-accessible settings, real text and logo results,
single-file save, multi-file ZIP names, settings invalidation, unsupported input, cancel/rerun, mobile
layout, no automatic download, and no external or write requests during processing. Tests assert image
MIME signatures and dimensions rather than codec-byte equality.

A tracked production smoke opens `/image/watermark`, creates a synthetic local source without a network
fixture, applies a text watermark, validates the downloaded MIME signature and dimensions, and confirms
that no external request or upload occurred. Release requires `pnpm verify:all`, the local Pages smoke,
the exact GitHub commit's CI checks including WebKit/mobile WebKit, the exact Cloudflare deployment check,
and the same smoke against `https://hereisit.pages.dev`.

## Sequential data flow

~~~text
Source files + optional logo
  -> validated UI settings
  -> ready dedicated Worker slots
  -> logo bytes copied once per slot and decoded once when logo mode is active
  -> one transferred source ArrayBuffer per job
  -> structural source inspection
  -> auto-oriented source decode
  -> bounded same-size OffscreenCanvas
  -> optional opaque JPG matte
  -> one source draw
  -> pure nine-anchor watermark geometry
  -> one text or cached-logo draw with opacity
  -> JPG, PNG, or WebP encode
  -> MIME signature, dimensions, and byte-budget postconditions
  -> transferable result
  -> one UI Blob/object URL per successful item
  -> explicit single save or collision-safe ZIP creation
~~~
