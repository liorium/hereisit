# Image Watermark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a local-only `/image/watermark` tool that applies one text or reusable logo watermark to up to 100 images with nine positions, bounded resources, explicit saving, and production deployment proof.

**Architecture:** Add an independent `image.watermark@1` contract and a dedicated Worker/batch runner. Keep placement, fitting, output resolution, and naming pure in `@hereisit/image-tool`; keep decoding, composition, encoding, logo caching, and resource limits in `@hereisit/browser-runtime`; expose the workflow through a dedicated React workbench that follows the current HereIsIt image-tool layout.

**Tech Stack:** TypeScript 6, Zod 4, React 19, Next.js 16 static export, Web Workers, `OffscreenCanvas`, Vitest 4, Playwright 1.61, fflate, Cloudflare Pages, GitHub Actions.

## Global Constraints

- Display the brand exactly as `HereIsIt`; keep lowercase `hereisit` only in repository, package, domain, internal marker, and filename contexts.
- Source and logo bytes, filenames, previews, results, and object URLs never leave the browser tab or its Workers and are never logged.
- Do not modify `image.pipeline@1`, `image.worker.ts`, or `runImageBatch()` public behavior.
- Accept 1–100 source images, 1 byte–50MiB each, at most 250MiB combined input.
- Limit each output to 16,384px per side and 25,000,000 pixels; enforce before and after decode.
- Accept one JPG, PNG, or WebP logo, 1 byte–10MiB, at most 8,192px per side and 16,000,000 pixels; reject animation.
- Use at most two Workers and one when device memory is unknown or at most 4GiB.
- Limit each result to 100MiB, retained batch results to 500MiB, and an active item to 180 seconds.
- Preserve displayed source dimensions and orientation; strip metadata through canvas reconstruction.
- Default `source` output to JPG→JPG, PNG→PNG, WebP→WebP, and HEIC/HEIF→JPG at quality 90.
- Text is one trimmed NFC line, 1–80 code points, without control or bidi-override characters.
- Text size is 4–30% of the shorter side; logo width is 5–50% of source width; margin is 0–10% of the shorter side; opacity is 0.05–1.0; lossy quality is 40–95.
- Do not add tiled watermarks, drag positioning, live canvas preview, custom fonts, SVG/HEIC logos, resizing, server fallback, or automatic downloads.
- Every production behavior change follows RED → GREEN → REFACTOR and ends with focused tests plus a commit.

---

## File map

### New files

- `packages/image-tool/src/watermark-layout.ts` — pure nine-anchor placement and proportional fitting.
- `packages/image-tool/src/watermark-layout.test.ts` — exact geometry and invalid-input coverage.
- `packages/image-tool/src/watermark-output.ts` — source-format resolution and watermark result/archive naming.
- `packages/image-tool/src/watermark-output.test.ts` — format and collision-safe naming coverage.
- `packages/browser-runtime/src/image-watermark-pipeline.ts` — bounded source/logo decode, composition, encode, and output postconditions.
- `packages/browser-runtime/src/image-watermark-pipeline.test.ts` — mocked canvas pipeline behavior and cleanup.
- `packages/browser-runtime/src/image-watermark.worker.ts` — strict capability, logo-configuration, run, cancel, and terminal-event Worker.
- `packages/browser-runtime/src/image-watermark.worker.test.ts` — Worker readiness, validation, caching, settlement, and cleanup.
- `packages/browser-runtime/src/run-image-watermark-batch.ts` — public batch lifecycle, reusable Worker slots, budgets, watchdog, and cancellation.
- `packages/browser-runtime/src/run-image-watermark-batch.test.ts` — public runner lifecycle and hostile-event coverage.
- `apps/web/src/components/image-watermark-workbench.tsx` — dedicated watermark workflow and object-URL lifecycle.
- `apps/web/src/app/image/watermark/page.tsx` — static route and metadata.
- `tests/e2e/image-watermark.spec.ts` — real text/logo/batch/privacy/lifecycle/browser coverage.
- `scripts/smoke-image-watermark.mjs` — local Pages and production functional/privacy smoke.

### Modified files

- `packages/tool-contracts/src/index.ts` and `index.test.ts` — `image.watermark@1` public schemas, types, protocol, and result events.
- `packages/image-tool/src/index.ts` and `naming.ts` — export new helpers and reuse safe base-name behavior.
- `packages/browser-runtime/package.json` and `src/index.ts` — publish `./image-watermark` and root exports.
- `apps/web/src/lib/site.ts` and `site.test.ts` — watermark intent, copy, route, home description, and list coverage.
- `apps/web/src/components/image-tool-page.tsx` — select the dedicated workbench for the watermark intent.
- `apps/web/src/components/image-workbench.module.css` — shared layout plus watermark-specific position/logo controls and mobile states.
- `tests/e2e/tool-pages.spec.ts` and `mobile.spec.ts` — route metadata and mobile regression coverage.
- `scripts/verify-static-export.mjs` — exported route, Worker marker, and bundle-isolation assertions.
- `README.md`, `docs/architecture.md`, and `docs/deployment.md` — public capability, limits, privacy, smoke, and release evidence.

---

### Task 1: Publish the `image.watermark@1` contract

**Files:**
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/src/index.test.ts`

**Interfaces:**
- Produces: `IMAGE_WATERMARK_TOOL_ID`, `IMAGE_WATERMARK_TOOL_VERSION`, `imageWatermarkSpecSchema`, `ImageWatermarkSpecV1`, `ParsedImageWatermarkSpecV1`, `ImageWatermarkPosition`, `ImageWatermarkInput`, `ImageWatermarkLogoInput`, `ImageWatermarkResult`, `ImageWatermarkErrorPayload`, `ImageWatermarkWorkerRequest`, `ImageWatermarkWorkerEvent`, `ImageWatermarkBatchItem`, `ImageWatermarkBatchItemResult`, `ImageWatermarkRuntimeEvent`, and `ImageWatermarkBatchHandle`.
- Consumes: `WORKER_PROTOCOL_VERSION = 1` and the existing safe-text character policy.

- [ ] **Step 1: Write failing identity and schema tests**

Append a `describe("imageWatermarkSpecSchema", ...)` block that asserts the exact identity and defaults:

~~~ts
expect(IMAGE_WATERMARK_TOOL_ID).toBe("image.watermark");
expect(IMAGE_WATERMARK_TOOL_VERSION).toBe(1);
expect(
  imageWatermarkSpecSchema.parse({
    version: 1,
    watermark: { kind: "text", text: "  © HereIsIt  ", color: "#111827", sizePercent: 12 },
    position: "bottom-right",
    marginPercent: 3,
    opacity: 0.55,
    output: { format: "source", quality: 90 },
    autoOrient: true,
    metadata: "strip",
  }),
).toMatchObject({ watermark: { text: "© HereIsIt" } });
~~~

Use table tests to accept all nine positions and both watermark branches, then reject version 0/2, empty or 81-code-point text, newlines, `\u202e`, invalid colors, text sizes 3/31, logo widths 4/51, margins -1/11, opacity 0.049/1.001, qualities 39/96, extra output fields, and any caller-controlled metadata/orientation value.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm test packages/tool-contracts/src/index.test.ts --run`

Expected: FAIL because `IMAGE_WATERMARK_TOOL_ID` and `imageWatermarkSpecSchema` are not exported.

- [ ] **Step 3: Add the strict schema and public types**

Add the independent constants and use `.strict()` on nested public objects so an input such as `{ format: "png", quality: 80 }` is rejected. Define the spec with these exact branches:

~~~ts
export const imageWatermarkSpecSchema = z
  .object({
    version: z.literal(1),
    watermark: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        text: safeWatermarkTextSchema,
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        sizePercent: z.number().int().min(4).max(30),
      }).strict(),
      z.object({
        kind: z.literal("logo"),
        widthPercent: z.number().int().min(5).max(50),
      }).strict(),
    ]),
    position: z.enum([
      "top-left", "top-center", "top-right",
      "middle-left", "center", "middle-right",
      "bottom-left", "bottom-center", "bottom-right",
    ]),
    marginPercent: z.number().int().min(0).max(10),
    opacity: z.number().min(0.05).max(1),
    output: z.discriminatedUnion("format", [
      z.object({ format: z.literal("source"), quality: z.number().int().min(40).max(95) }).strict(),
      z.object({ format: z.literal("jpeg"), quality: z.number().int().min(40).max(95), matte: z.literal("#ffffff") }).strict(),
      z.object({ format: z.literal("webp"), quality: z.number().int().min(40).max(95) }).strict(),
      z.object({ format: z.literal("png") }).strict(),
    ]),
    autoOrient: z.literal(true),
    metadata: z.literal("strip"),
  })
  .strict();
~~~

Extract the existing PDF watermark text refinement into a shared `safeWatermarkTextSchema` without changing `pdfWatermarkSchema` output. Enforce the 80-code-point ceiling with `Array.from(value).length <= 80` rather than UTF-16 `.max(80)`. Add dedicated request/event types with `configure-logo`, `run`, and `cancel` requests; `ready`, `logo-ready`, `logo-failed`, `progress`, `complete`, and `failed` events. Use `assetId` for logo configuration and `jobId` for item events. Keep error codes dedicated to the image-watermark result union.

Use these exact shared payload shapes so later tasks do not invent parallel contracts:

~~~ts
export interface ImageWatermarkInput {
  name: string;
  mimeHint: string;
  byteLength: number;
  bytes: ArrayBuffer;
}

export type ImageWatermarkLogoInput = ImageWatermarkInput;
export type ImageWatermarkPhase =
  | "validating" | "decoding" | "compositing" | "encoding" | "finalizing";
export type ImageWatermarkWarning = "SOURCE_FORMAT_CONVERTED" | "COLOR_PROFILE_NORMALIZED";

export interface ImageWatermarkResult {
  bytes: ArrayBuffer;
  suggestedName: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  sourceByteLength: number;
  byteLength: number;
  format: "jpeg" | "png" | "webp";
  warnings: ImageWatermarkWarning[];
  timing: {
    inspectMs: number;
    decodeMs: number;
    compositeMs: number;
    encodeMs: number;
    totalMs: number;
  };
}

export type ImageWatermarkErrorCode =
  | "INVALID_SPEC" | "UNSUPPORTED_INPUT" | "ANIMATED_INPUT" | "CORRUPT_INPUT"
  | "DIMENSION_LIMIT" | "MEMORY_LIMIT" | "DECODE_FAILED" | "ENCODE_FAILED"
  | "LOGO_REQUIRED" | "CANCELLED" | "WORKER_CRASH";
export interface ImageWatermarkErrorPayload {
  code: ImageWatermarkErrorCode;
  message: string;
  retryable: boolean;
}

export interface ImageWatermarkBatchItem {
  itemId: string;
  file: File;
  spec: ImageWatermarkSpecV1;
}
export type ImageWatermarkBatchItemResult =
  | { itemId: string; status: "fulfilled"; value: ImageWatermarkResult }
  | { itemId: string; status: "rejected"; error: ImageWatermarkErrorPayload }
  | { itemId: string; status: "cancelled" };
export type ImageWatermarkRuntimeEvent =
  | { type: "item-progress"; itemId: string; phase: ImageWatermarkPhase; fraction: number }
  | { type: "item-complete"; itemId: string; result: ImageWatermarkBatchItemResult }
  | { type: "batch-progress"; completed: number; total: number };
export interface ImageWatermarkBatchHandle {
  result: Promise<readonly ImageWatermarkBatchItemResult[]>;
  cancel(): void;
}
~~~

The configure request carries `{ assetId, tool, toolVersion, input }`; the run request carries `{ jobId, tool, toolVersion, input, spec, logoAssetId? }`; cancel carries `{ jobId }`. Progress carries `{ jobId, sequence, phase, fraction }`; logo terminal events carry `assetId`; item terminal events carry `jobId`.

- [ ] **Step 4: Run contract and type tests and verify GREEN**

Run: `pnpm test packages/tool-contracts/src/index.test.ts --run && pnpm --filter @hereisit/tool-contracts typecheck`

Expected: PASS with all existing PDF watermark parsing unchanged.

- [ ] **Step 5: Commit the public boundary**

~~~bash
git add packages/tool-contracts/src/index.ts packages/tool-contracts/src/index.test.ts
git commit -m "feat: define image watermark contract"
~~~

### Task 2: Add pure placement, fitting, output, and naming helpers

**Files:**
- Create: `packages/image-tool/src/watermark-layout.ts`
- Create: `packages/image-tool/src/watermark-layout.test.ts`
- Create: `packages/image-tool/src/watermark-output.ts`
- Create: `packages/image-tool/src/watermark-output.test.ts`
- Modify: `packages/image-tool/src/naming.ts`
- Modify: `packages/image-tool/src/index.ts`

**Interfaces:**
- Consumes: `ImageWatermarkPosition` and `ImageWatermarkSpecV1["output"]`.
- Produces: `fitWatermarkSize()`, `computeWatermarkRect()`, `resolveImageWatermarkOutput()`, `suggestWatermarkedImageName()`, and `dedupeArchiveNames()`.

Use these exact signatures:

~~~ts
export interface WatermarkSize { width: number; height: number }
export interface WatermarkRect extends WatermarkSize { x: number; y: number }
export function fitWatermarkSize(
  contentWidth: number,
  contentHeight: number,
  maximumWidth: number,
  maximumHeight: number,
): WatermarkSize;
export function computeWatermarkRect(input: {
  canvasWidth: number;
  canvasHeight: number;
  watermarkWidth: number;
  watermarkHeight: number;
  position: ImageWatermarkPosition;
  marginPercent: number;
}): WatermarkRect;
export function resolveImageWatermarkOutput(
  sourceFormat: SupportedImageFormat,
  output: ImageWatermarkSpecV1["output"],
): {
  format: "jpeg" | "png" | "webp";
  mime: "image/jpeg" | "image/png" | "image/webp";
  quality?: number;
  matte?: "#ffffff";
  sourceFormatConverted: boolean;
};
export function suggestWatermarkedImageName(
  inputName: string,
  format: "jpeg" | "png" | "webp",
): string;
export function dedupeArchiveNames(names: readonly string[]): string[];
~~~

- [ ] **Step 1: Write the nine-anchor and proportional-fit tests**

Create table-driven tests for a `1000×800` canvas, `200×100` watermark, and `5%` margin. The 40px margin must yield these exact rectangles:

~~~ts
[
  ["top-left", { x: 40, y: 40 }],
  ["top-center", { x: 400, y: 40 }],
  ["top-right", { x: 760, y: 40 }],
  ["middle-left", { x: 40, y: 350 }],
  ["center", { x: 400, y: 350 }],
  ["middle-right", { x: 760, y: 350 }],
  ["bottom-left", { x: 40, y: 660 }],
  ["bottom-center", { x: 400, y: 660 }],
  ["bottom-right", { x: 760, y: 660 }],
]
~~~

Also assert `fitWatermarkSize(800, 400, 300, 300)` returns `300×150`, never upscales `100×50` into `300×300`, and rejects non-finite, zero, negative, or impossible dimensions before returning a rectangle.

- [ ] **Step 2: Write output-resolution and filename tests**

Assert `source` maps actual `jpeg/png/webp/heic` formats to `jpeg/png/webp/jpeg`, carries quality only for lossy results, sets white matte for JPG, and reports HEIC conversion. Assert:

~~~ts
expect(suggestWatermarkedImageName("holiday.photo.PNG", "webp"))
  .toBe("holiday.photo-watermarked-hereisit.webp");
expect(dedupeArchiveNames(["a.png", "a.png", "a-2.png", "a.png"]))
  .toEqual(["a.png", "a-2.png", "a-2-2.png", "a-3.png"]);
~~~

Include path stripping, control characters, dot-only fallback, 120-code-point stem truncation, case-insensitive collision handling, and names without extensions.

- [ ] **Step 3: Run helper tests and verify RED**

Run: `pnpm test packages/image-tool/src/watermark-layout.test.ts packages/image-tool/src/watermark-output.test.ts --run`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement the minimal pure helpers**

Use a single horizontal/vertical anchor map. Convert the relative margin once with `Math.round(Math.min(canvasWidth, canvasHeight) * marginPercent / 100)`, clamp available width/height to at least one pixel, fit while preserving aspect ratio, and return finite non-negative coordinates wholly inside the canvas. Center ignores margin.

Move the private safe base-name logic in `naming.ts` into an exported `safeImageBaseName()` used by both old and new naming functions without changing `suggestOutputName()` output. `dedupeArchiveNames()` must reserve prior generated names and insert the numeric suffix before the final extension.

- [ ] **Step 5: Run helper, existing geometry, and naming suites and verify GREEN**

Run: `pnpm test packages/image-tool/src/watermark-layout.test.ts packages/image-tool/src/watermark-output.test.ts packages/image-tool/src/geometry.test.ts packages/image-tool/src/naming.test.ts --run && pnpm --filter @hereisit/image-tool typecheck`

Expected: PASS; existing `*-hereisit.*` names remain byte-for-byte unchanged.

- [ ] **Step 6: Commit the pure domain layer**

~~~bash
git add packages/image-tool/src
git commit -m "feat: plan image watermark placement"
~~~

### Task 3: Implement the bounded watermark pipeline

**Files:**
- Create: `packages/browser-runtime/src/image-watermark-pipeline.ts`
- Create: `packages/browser-runtime/src/image-watermark-pipeline.test.ts`

**Interfaces:**
- Consumes: `imageWatermarkSpecSchema`, `inspectImageHeader()`, `computeWatermarkRect()`, `fitWatermarkSize()`, `resolveImageWatermarkOutput()`, and `suggestWatermarkedImageName()`.
- Produces: `PreparedImageWatermarkLogo`, `prepareImageWatermarkLogo(input, signal)`, `closePreparedImageWatermarkLogo(logo)`, `processImageWatermarkPipeline(input, rawSpec, logo, report, signal)`, `ImageWatermarkPipelineError`, and `toImageWatermarkErrorPayload(error)`.

Use these exact signatures:

~~~ts
export interface PreparedImageWatermarkLogo {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}
export type ImageWatermarkProgressReporter =
  (phase: ImageWatermarkPhase, fraction: number) => void;
export function prepareImageWatermarkLogo(
  input: ImageWatermarkLogoInput,
  signal: AbortSignal,
): Promise<PreparedImageWatermarkLogo>;
export function closePreparedImageWatermarkLogo(
  logo: PreparedImageWatermarkLogo | undefined,
): void;
export function processImageWatermarkPipeline(
  input: ImageWatermarkInput,
  rawSpec: unknown,
  logo: PreparedImageWatermarkLogo | undefined,
  report: ImageWatermarkProgressReporter,
  signal: AbortSignal,
): Promise<ImageWatermarkResult>;
~~~

- [ ] **Step 1: Write failing source and composition tests**

Create a deterministic `OffscreenCanvas` double that records calls and returns structurally valid 1×1 PNG, JPEG, and WebP headers. Assert that a text job:

- structurally inspects before calling `createImageBitmap`;
- decodes with `{ imageOrientation: "from-image" }`;
- creates an output canvas with the decoded width and height;
- fills white before source draw for JPG and does not fill for PNG/WebP;
- draws the source before text;
- uses `save()`, `globalAlpha = spec.opacity`, one `fillText()`, and `restore()`;
- reports monotonic validating/decoding/compositing/encoding/finalizing fractions;
- returns the exact width, height, MIME, source/output byte lengths, name, warnings, and timing;
- closes the source bitmap and zeros canvas width/height in `finally`.

- [ ] **Step 2: Write failing logo, limit, and postcondition tests**

Assert `prepareImageWatermarkLogo()` accepts bounded static PNG, rejects animation/HEIC/oversize/corrupt inputs before decode, checks decoded size again, and closes on post-decode failure. Assert a logo job requires a prepared logo, calls `drawImage(logo.bitmap, x, y, width, height)` exactly once, and does not close the cached logo after the item.

Add cases for invalid spec, actual byte-length mismatch, 0/50MiB+1 source, 16,385px side, 25,000,001 pixels, decoder failure, null 2D context, wrong `convertToBlob()` MIME, invalid output signature, 100MiB+1 output, already-aborted signal, and abort during composition. Put a private metadata sentinel in a valid source and assert it is absent from the encoded result. Every failure must close source resources and expose no bytes.

- [ ] **Step 3: Run pipeline tests and verify RED**

Run: `pnpm test packages/browser-runtime/src/image-watermark-pipeline.test.ts --run`

Expected: FAIL because `processImageWatermarkPipeline` is missing.

- [ ] **Step 4: Implement validation, logo preparation, and composition**

Use exact constants from Global Constraints. Inspect actual bytes, ignore MIME hints for format decisions, reject animated sources, decode once, validate displayed bitmap geometry, and create one same-size canvas. For text, set a deterministic bold sans-serif font from the requested shorter-side percentage, measure once, use `fitWatermarkSize()` to shrink to the available rectangle, update the font to the fitted size, and place through `computeWatermarkRect()`. For logo, use its intrinsic ratio and requested source-width percentage, then fit and anchor it through the same helpers.

Wrap every `ImageBitmap` and canvas in `try/finally`. Call `signal.throwIfAborted()` before decode, before canvas allocation, before watermark draw, and before/after encode. Convert aborts to `{ code: "CANCELLED", retryable: false }`; classify platform decode, encode, dimension, memory, and spec errors exactly.

- [ ] **Step 5: Implement encode and result postconditions**

Resolve output from the inspected source format. Pass `quality / 100` only for JPG/WebP. Verify Blob MIME exactly, cap bytes before `arrayBuffer()`, inspect the encoded signature and dimensions, and reject any mismatch. Add `SOURCE_FORMAT_CONVERTED` only for source-mode HEIC/HEIF→JPG and always add `COLOR_PROFILE_NORMALIZED`.

- [ ] **Step 6: Run pipeline and existing image suites and verify GREEN**

Run: `pnpm test packages/browser-runtime/src/image-watermark-pipeline.test.ts packages/browser-runtime/src/image-pipeline.test.ts packages/image-tool/src/file-format.test.ts --run && pnpm --filter @hereisit/browser-runtime typecheck`

Expected: PASS with no change to existing compression/resize/convert results.

- [ ] **Step 7: Commit the pipeline**

~~~bash
git add packages/browser-runtime/src/image-watermark-pipeline.ts packages/browser-runtime/src/image-watermark-pipeline.test.ts
git commit -m "feat: compose image watermarks locally"
~~~

### Task 4: Add the strict dedicated Worker

**Files:**
- Create: `packages/browser-runtime/src/image-watermark.worker.ts`
- Create: `packages/browser-runtime/src/image-watermark.worker.test.ts`

**Interfaces:**
- Consumes: Task 1 Worker protocol and Task 3 pipeline/close/error helpers.
- Produces: a module Worker named `hereisit-image-watermark-worker` that advertises capabilities, caches one logo by `assetId`, runs one active item, and settles each request at most once.

- [ ] **Step 1: Write failing readiness and hostile-request tests**

Use the existing `StubWorkerScope` pattern. On module import, assert one ready event only after a real 1×1 `OffscreenCanvas` probe with a non-null 2D context and callable `convertToBlob()`, and assert the probe canvas is zeroed. Missing primitives, null context, missing encoder, or thrown probe must advertise `offscreenCanvas: false` without throwing.

Dispatch nulls, wrong protocol, empty IDs, mismatched byte lengths, oversize logo input, wrong tool/version/spec, a second active run, stale cancel, malformed configure, and logo-mode run without the matching configured `assetId`. Assert malformed envelopes are ignored, semantic tool/spec errors receive one non-retryable failure, and the pipeline is not called.

- [ ] **Step 2: Write failing logo-cache and terminal tests**

Mock Task 3 helpers. Configure `asset-1`, assert one `prepareImageWatermarkLogo()` call and `logo-ready`; run two sequential logo jobs and assert the same prepared object reaches both pipeline calls. Configure `asset-2` while idle and assert the old logo closes exactly once. Assert failed replacement keeps no stale asset.

For run success, progress, thrown pipeline error, transfer failure, duplicate/stale completion, active cancel, and logo replacement, assert exactly one terminal event per job, monotonic sequence numbers, final ArrayBuffer transfer, controller abort, and cached-logo close on Worker-controlled cleanup. Public runner cancellation additionally terminates the Worker realm so its cached bitmap cannot survive cancellation.

- [ ] **Step 3: Run Worker tests and verify RED**

Run: `pnpm test packages/browser-runtime/src/image-watermark.worker.test.ts --run`

Expected: FAIL because the Worker module does not exist.

- [ ] **Step 4: Implement Worker parsing and lifecycle**

Manually parse top-level envelopes before using Zod so hostile prototypes or getters cannot crash the Worker. Require exact protocol/tool/version, exact byte-length identity, and safe non-empty IDs. Hold:

~~~ts
let activeJob: { jobId: string; controller: AbortController } | undefined;
let configuredLogo: { assetId: string; prepared: PreparedImageWatermarkLogo } | undefined;
~~~

Accept logo replacement only while idle. Close a replaced logo before publishing `logo-ready`. A logo job must name the configured `assetId`; text jobs ignore cached assets. Gate progress and terminal posts on active object identity, catch `postMessage` transfer failure, and clear the active job in `finally`.

- [ ] **Step 5: Run Worker and pipeline suites and verify GREEN**

Run: `pnpm test packages/browser-runtime/src/image-watermark.worker.test.ts packages/browser-runtime/src/image-watermark-pipeline.test.ts --run && pnpm --filter @hereisit/browser-runtime typecheck`

Expected: PASS with one cached logo per Worker and exactly-once settlement.

- [ ] **Step 6: Commit the Worker**

~~~bash
git add packages/browser-runtime/src/image-watermark.worker.ts packages/browser-runtime/src/image-watermark.worker.test.ts
git commit -m "feat: isolate image watermark jobs"
~~~

### Task 5: Add the reusable-Worker batch runner

**Files:**
- Create: `packages/browser-runtime/src/run-image-watermark-batch.ts`
- Create: `packages/browser-runtime/src/run-image-watermark-batch.test.ts`
- Modify: `packages/browser-runtime/package.json`
- Modify: `packages/browser-runtime/src/index.ts`

**Interfaces:**
- Consumes: Task 1 batch types and Task 4 Worker events.
- Produces: `supportsBrowserImageWatermarkRuntime()` and `runImageWatermarkBatch(items, { logoFile, concurrency, onEvent })` from `@hereisit/browser-runtime/image-watermark`.

Publish this exact option boundary:

~~~ts
export interface RunImageWatermarkBatchOptions {
  logoFile?: File;
  concurrency?: number | "auto";
  onEvent?: (event: ImageWatermarkRuntimeEvent) => void;
}
export function supportsBrowserImageWatermarkRuntime(): boolean;
export function runImageWatermarkBatch(
  items: readonly ImageWatermarkBatchItem[],
  options?: RunImageWatermarkBatchOptions,
): ImageWatermarkBatchHandle;
~~~

- [ ] **Step 1: Write failing support, readiness, and privacy tests**

Assert support requires `Worker`, `File`, `OffscreenCanvas`, non-null 2D context, and callable `convertToBlob()`, and always zeros the probe. Assert the runner rejects empty/101-item, invalid per-file/total-byte, logo-required, and invalid-logo-size batches before Worker construction or file reads.

Construct two slots and assert no source or logo `arrayBuffer()` call occurs before ready capabilities. In logo mode, assert the logo is read once only after readiness, copied once per active slot, transferred in one `configure-logo` event per slot, and no source is read until that slot publishes matching `logo-ready`. Text mode must never read or configure the retained UI logo.

- [ ] **Step 2: Write failing lifecycle, budget, and cancellation tests**

Cover automatic concurrency for unknown/4GiB/8GiB memory, explicit NaN/0/99 concurrency, Worker constructor failure, unsupported capability, malformed/foreign/stale events, sequence regression, observer exceptions, file read failure, logo configuration failure, per-item watchdog, Worker error/messageerror, 100MiB item result, 500MiB aggregate result, partial success, slot replacement, and completion ordering by input item.

Cancel before ready, during logo read, during source read, and during active processing. Every case must terminate each Worker once, stop new reads, resolve every item as cancelled or preserve already fulfilled items, and ignore all late events.

- [ ] **Step 3: Run runner tests and verify RED**

Run: `pnpm test packages/browser-runtime/src/run-image-watermark-batch.test.ts --run`

Expected: FAIL because `runImageWatermarkBatch` is missing.

- [ ] **Step 4: Implement bounded slots and strict event decoding**

Follow `run-image-batch.ts` generation/slot patterns without changing that file. Keep results in input order, emit guarded item/batch events, and settle all items. Use at most two slots, name each Worker `hereisit-image-watermark-worker`, arm a fresh 180-second timer only after assigning an item, and replace a crashed slot only while queued work remains.

Read the logo once into a retained immutable `Uint8Array`; create one `.slice().buffer` per slot for transfer and release the retained copy after every active slot acknowledges configuration. Do not put logo bytes in item specs or events.

- [ ] **Step 5: Export the runner and verify GREEN**

Add `"./image-watermark": "./src/run-image-watermark-batch.ts"` and the root export. Run:

`pnpm test packages/browser-runtime/src/run-image-watermark-batch.test.ts packages/browser-runtime/src/image-watermark.worker.test.ts --run && pnpm --filter @hereisit/browser-runtime typecheck`

Expected: PASS with all handles settling and no pre-read before capability readiness.

- [ ] **Step 6: Commit the runner**

~~~bash
git add packages/browser-runtime/package.json packages/browser-runtime/src/index.ts packages/browser-runtime/src/run-image-watermark-batch.ts packages/browser-runtime/src/run-image-watermark-batch.test.ts
git commit -m "feat: run image watermark batches"
~~~

### Task 6: Publish the static route and registry entry

**Files:**
- Modify: `apps/web/src/lib/site.ts`
- Modify: `apps/web/src/lib/site.test.ts`
- Modify: `apps/web/src/components/image-tool-page.tsx`
- Create: `apps/web/src/app/image/watermark/page.tsx`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `scripts/verify-static-export.mjs`

**Interfaces:**
- Consumes: `ImageWatermarkWorkbench` from Task 7 through a direct component import; during this task add a minimal typed shell that is replaced in Task 7.
- Produces: `imageTools.watermark`, `/image/watermark`, unique SEO metadata, sitemap inclusion, related cards, and route-class Worker isolation expectations.

- [ ] **Step 1: Write failing registry and exported-route tests**

Extend site unit tests to require four unique image intents/paths and this exact record:

~~~ts
expect(imageTools.watermark).toMatchObject({
  intent: "watermark",
  path: "/image/watermark",
  navLabel: "이미지 워터마크",
  title: "이미지에 워터마크 넣기",
});
~~~

Add the route to the metadata E2E table and `toolPages` in the export verifier with description prefix `사진과 이미지에 문구 또는 로고를 넣으세요.`. Add `IMAGE_WATERMARK_WORKER_MARKER = "hereisit-image-watermark-worker"`; the watermark route closure must contain it and existing image/PDF closures must not.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test apps/web/src/lib/site.test.ts --run && pnpm build`

Expected: site test fails because `watermark` is not a valid image intent; after only the test is added, static export lacks `/image/watermark`.

- [ ] **Step 3: Add exact copy, route, and dedicated-workbench dispatch**

Extend `ImageToolIntent` with `watermark`, add the approved title/description/default summary/three steps, and update `HOME_DESCRIPTION` without disturbing PDF copy. In `ImageToolPage`, render `<ImageWatermarkWorkbench />` for `watermark`; keep `<ImageWorkbench intent={tool.intent} />` for the three established intents using a narrowing branch.

Create the page with the same metadata pattern as other image routes. Add a temporary accessible workbench shell that imports `supportsBrowserImageWatermarkRuntime()` so the emitted closure contains only the dedicated Worker marker; Task 7 replaces its markup without changing route copy.

- [ ] **Step 4: Run registry, build, export, and metadata tests and verify GREEN**

Run: `pnpm test apps/web/src/lib/site.test.ts --run && pnpm build && pnpm verify:export && pnpm test:e2e --project=chromium --grep "publishes every image route"`

Expected: four image routes export with unique titles/canonicals; only `/image/watermark` loads the watermark Worker closure.

- [ ] **Step 5: Commit the public route**

~~~bash
git add apps/web/src/lib apps/web/src/components/image-tool-page.tsx apps/web/src/components/image-watermark-workbench.tsx apps/web/src/app/image/watermark tests/e2e/tool-pages.spec.ts scripts/verify-static-export.mjs
git commit -m "feat: publish image watermark route"
~~~

### Task 7: Build the complete watermark workbench

**Files:**
- Modify: `apps/web/src/components/image-watermark-workbench.tsx`
- Modify: `apps/web/src/components/image-workbench.module.css`
- Create: `tests/e2e/image-watermark.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `runImageWatermarkBatch()`, `supportsBrowserImageWatermarkRuntime()`, `ImageWatermarkSpecV1`, `ImageWatermarkRuntimeEvent`, existing `createZipArchive()`, `downloadUrl()`, byte/time formatting, and shared image workbench CSS anatomy.
- Produces: source/optional-logo selection, settings validation, batch run/cancel, result previews, explicit single save/share, collision-safe ZIP save, and complete object-URL cleanup.

- [ ] **Step 1: Write the failing default text-flow browser test**

Create a solid 320×180 PNG in the browser, set it on the source input, and assert the approved defaults: `© HereIsIt`, bottom-right selected, size 12%, margin 3%, opacity 55%, color `#111827`, source format, quality 90. Assert no result URL or download occurs before clicking `1개 이미지에 워터마크 넣기 →`.

After completion, save explicitly and assert `source-watermarked-hereisit.png`, PNG signature, `320×180`, result preview, metadata-removal/re-encoding notice, and no external/write/body request during processing.

- [ ] **Step 2: Run the text-flow test and verify RED**

Run: `pnpm test:e2e --project=chromium tests/e2e/image-watermark.spec.ts --grep "text watermark"`

Expected: FAIL because the temporary shell has no controls or processing flow.

- [ ] **Step 3: Implement state, validation, and source lifecycle**

Model each source item with `id`, `file`, `previewUrl`, optional `result/resultUrl/error`, status, phase, and progress. Keep refs for the current items, owned URLs, active run generation, input elements, and batch handle. Accept extensions only when MIME is empty; enforce source count/size/total limits before creating URLs.

Add exact default spec and controls. Use one accessible radio group for mode, one labeled text field/color input or logo selector, one nine-radio grid with Korean accessible names, and labeled range inputs with numeric values. Keep the logo object URL while switching to text but pass no logo file to text jobs. Any setting/logo/source change revokes old result URLs, preserves source preview URLs, and returns non-processing items to ready.

- [ ] **Step 4: Implement run, event, cancel, and result lifecycle**

Clone one validated spec per item. Guard every event and promise continuation with the active run generation. On fulfilled results, create one owned URL and preserve partial successes. On cancel, terminate the handle, preserve fulfilled results, mark unfinished items cancelled, and expose only completed results.

Single save prefers Web Share only when `navigator.canShare({ files })` succeeds; otherwise use explicit anchor download. Batch save passes `dedupeArchiveNames()` output to `createZipArchive()` and downloads `hereisit-watermarked-images.zip`. Handle delayed share resolve/reject after reset by checking generation before message/download fallback. Revoke all source/logo/result/archive URLs on replace, rerun, reset, unmount, and completed archive timeout.

- [ ] **Step 5: Implement result preview and responsive controls**

Reuse the existing desktop grid and action-bar vocabulary. Add only focused classes for the three-by-three position grid, selected position, logo picker/thumbnail, range-value row, and compact mode tabs. At widths covered by `mobile.spec.ts`, order source list → settings → preview/result → safe-area action bar, keep controls at least 44px, avoid horizontal overflow, and retain keyboard focus rings and reduced-motion behavior.

- [ ] **Step 6: Add logo, batch, invalidation, and cancellation browser tests**

Add real cases for:

- a 64×32 red PNG logo at top-left on a white source, verifying decoded result pixels inside and outside the overlay;
- two sources with identical names producing collision-free ZIP entries and no automatic download;
- missing/animated/oversize logo correction messages;
- setting and logo replacement revoking old result URLs and disabling stale save actions;
- cancel and rerun with late Worker/share events ignored;
- unsupported runtime before any file read;
- keyboard navigation through all nine positions;
- mobile viewport with zero horizontal overflow and reachable primary action.

- [ ] **Step 7: Run browser and component-adjacent checks and verify GREEN**

Run: `pnpm build && pnpm test:e2e --project=chromium tests/e2e/image-watermark.spec.ts tests/e2e/mobile.spec.ts && pnpm lint && pnpm typecheck`

Expected: every watermark workflow passes in Chromium with no page error, failed request, external request, write method, request body, stale result, or leaked active URL.

- [ ] **Step 8: Commit the workbench**

~~~bash
git add apps/web/src/components/image-watermark-workbench.tsx apps/web/src/components/image-workbench.module.css tests/e2e/image-watermark.spec.ts tests/e2e/mobile.spec.ts
git commit -m "feat: add image watermark workbench"
~~~

### Task 8: Lock release-browser, static isolation, and production smoke coverage

**Files:**
- Modify: `tests/e2e/image-watermark.spec.ts`
- Modify: `scripts/verify-static-export.mjs`
- Create: `scripts/smoke-image-watermark.mjs`

**Interfaces:**
- Consumes: completed public route and controls.
- Produces: cross-browser proof for text/logo processing, exact bundle isolation, security headers, explicit download behavior, and same-origin production execution.

- [ ] **Step 1: Add release-browser and closure regressions**

Make browser assertions codec-tolerant: compare MIME signatures, exact dimensions, anchor-region pixel tolerances, warnings, and cleanup rather than bytes. Run the essential text flow under configured Chromium, Firefox, WebKit, mobile Chromium, and mobile WebKit. Assert the route's actually loaded same-origin JavaScript URLs contain `hereisit-image-watermark-worker` only when fetched with `Accept-Encoding: identity`, exact 200 identity, zero redirects, and fail-closed parsing.

In `verify-static-export.mjs`, assert all 11 tool pages, `/image/watermark` sitemap/canonical metadata, watermark marker presence in its route closure, and marker absence from `/`, the three established image routes, and every PDF route.

- [ ] **Step 2: Run release-browser/static checks and verify RED if any browser assumption leaks**

Run: `pnpm build && pnpm verify:export && pnpm test:e2e tests/e2e/image-watermark.spec.ts`

Expected before browser-specific fixes: any unsupported MIME/pixel/timing assumption fails with the exact affected project; no test may be skipped to obtain GREEN.

- [ ] **Step 3: Add the tracked Pages smoke**

Implement `scripts/smoke-image-watermark.mjs` with `https://hereisit.pages.dev` default and optional HTTP(S) origin argument. It must:

1. open `/image/watermark` and assert 200 plus CSP `default-src 'self'`, `connect-src 'self'`, `worker-src 'self' blob:`, no eval/wasm-eval, `nosniff`, `DENY`, and `no-referrer`;
2. create a 320×180 local PNG without requesting a fixture;
3. run default text watermark and wait for success;
4. assert no cross-origin request, non-GET/HEAD method, request body, failed request, or page error;
5. explicitly save and assert `source-watermarked-hereisit.png`, PNG signature, and `320×180` dimensions;
6. print exactly `Image watermark smoke passed.`.

- [ ] **Step 4: Run local Pages proof and verify GREEN**

Run the static preview in one terminal:

`pnpm --filter @hereisit/web preview:test`

Then run:

`node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173`

Expected: `Image watermark smoke passed.` with zero request/privacy/security violations.

- [ ] **Step 5: Commit release proof**

~~~bash
git add tests/e2e/image-watermark.spec.ts scripts/verify-static-export.mjs scripts/smoke-image-watermark.mjs
git commit -m "test: prove image watermark release"
~~~

### Task 9: Document, review, verify, publish, and prove the exact deployment

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: every prior task and the approved design.
- Produces: public documentation, clean full verification, reviewed commits, synchronized `main`, exact-SHA CI/Cloudflare proof, and production smoke evidence.

- [ ] **Step 1: Update exact capability and limit documentation**

Add image watermarking to README capabilities and browser-suite coverage. Document `image.watermark@1`, nine anchors, source-format resolution, metadata stripping, no size-reduction guarantee, source/logo/result/concurrency/time limits, cached-logo lifecycle, explicit-only saving, and local-only privacy in architecture/current limits. Add the local and production smoke commands to deployment docs:

~~~bash
node scripts/smoke-image-watermark.mjs http://127.0.0.1:4173
node scripts/smoke-image-watermark.mjs
~~~

- [ ] **Step 2: Run documentation/diff checks**

Run: `git diff --check && ! rg -n "Hereisit|HereIsit" README.md docs/architecture.md docs/deployment.md apps packages tests scripts`

Expected: both commands are silent; intentional lowercase/uppercase internal markers remain unchanged.

- [ ] **Step 3: Run the full repository verification**

Run: `pnpm verify:all`

Expected: Biome, all workspace typechecks, all Vitest tests, 16 static pages including home, export verification, and every configured desktop/mobile browser project pass with zero retries or flakes.

- [ ] **Step 4: Run two-stage whole-branch review and fix findings with TDD**

Compare `git diff c21a923...HEAD` against the approved design and this plan. First review spec compliance, then review code quality/security/privacy/resource lifecycle. For every Important or Critical finding, add a reproducing failing test, verify RED, implement the smallest fix, rerun focused and full verification, and commit with a precise `fix:` message. Do not publish with unresolved Important/Critical findings.

- [ ] **Step 5: Commit documentation and verify a clean tree**

~~~bash
git add README.md docs/architecture.md docs/deployment.md
git commit -m "docs: explain local image watermarks"
git status -sb
~~~

Expected: `main` is ahead of `origin/main` only by intentional image-watermark commits and the worktree is otherwise clean.

- [ ] **Step 6: Push non-force and wait for exact-SHA GitHub checks**

~~~bash
SHA=$(git rev-parse HEAD)
git push origin main
RUN_ID=$(gh run list --branch main --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId')
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
gh api "repos/liorium/hereisit/commits/$SHA/check-runs" --jq '.check_runs[] | [.name,.status,.conclusion,.details_url] | @tsv'
~~~

Expected: `verify`, `browser`, and Cloudflare Pages checks all complete with `success`; browser logs show zero failed or retried tests across Chromium, Firefox, WebKit, mobile Chromium, and mobile WebKit.

- [ ] **Step 7: Prove the exact Cloudflare deployment and production behavior**

Confirm the successful Cloudflare Pages check belongs to `$SHA`, then run:

~~~bash
node scripts/smoke-image-watermark.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-compress.mjs https://hereisit.pages.dev
node scripts/smoke-pdf-to-images.mjs https://hereisit.pages.dev
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git status -sb
~~~

Expected: all three production smokes pass; local HEAD equals `origin/main`; the final tree is clean and synchronized.

- [ ] **Step 8: Report the release and recommend the next feature**

Provide the production route `https://hereisit.pages.dev/image/watermark`, exact commit, GitHub Actions links, Cloudflare deployment link, test totals by browser, local/production smoke outcomes, privacy/output caveats, and any accepted non-blocking residual risks. Reassess the next roadmap item; default recommendation is PDF page numbers unless measured usage or review evidence favors PDF crop or an OCR prototype.
