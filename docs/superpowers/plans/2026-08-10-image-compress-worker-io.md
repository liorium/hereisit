# Image Compression Worker File I/O Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Remove the image-compression route's remaining full source-file reads and lossless metadata work from the UI realm without changing visible behavior, codecs, server policy, or download results.

**Architecture:** Add one dedicated protocol-1 image-optimize Worker and one sequential browser-runtime runner for header inspection and lossless metadata stripping. Smart compression reuses the existing `image.pipeline@2` batch Worker with its `source` output policy, while the React workbench only coordinates validated item results and UI state.

**Tech Stack:** TypeScript 6, React 19, Next.js 16, native Web Workers/File/ArrayBuffer, Vitest, Playwright, pnpm, GitHub Actions, Cloudflare Pages/Workers.

---

## Global constraints

- Follow `AGENTS.md`: local files stay local unless the existing server disclosure is active; never log file contents, filenames, thumbnails, object URLs, or presigned URLs.
- Preserve `image.optimize@1`, all Korean copy, result/download UI, server policy refresh, retryable server-to-local fallback, analytics, 20-file/30MiB/40MP limits, and current JPG/PNG/WebP/HEIC/animation behavior.
- Use the existing native `{ name, mimeHint, byteLength, file }` envelope and Worker protocol version `1`; add no dependency and no codec.
- A malformed envelope is `INVALID_SPEC`; a metadata-matching zero/over-30MiB file is `MEMORY_LIMIT`; read failures and changed read lengths are sanitized. Unknown exception text never crosses the Worker boundary.
- `inspect` returns structurally detected metadata; the workbench retains the existing HEIC, animation, accepted-MIME, and 40MP selection decisions and messages.
- `lossless` enforces the same supported-format/animation/40MP rules and preserves `LOSSLESS_SERVER_REQUIRED` for WebP, non-upright JPEG EXIF, JPEG ICC, and PNG iCCP.
- One optimize Worker processes one item at a time and one batch uses one Worker. Cancel/new selection/unmount terminates it, ignores late events, and settles each item once.
- Smart compression uses the existing `runImageBatch()` with `concurrency: 1`, a version-2 `source` output, and the unchanged smaller-only/quality policy. Its Worker performs authoritative input inspection.
- Do not run local Playwright. The protected GitHub browser job owns Chromium, Firefox, WebKit, and their three mobile projects.
- Do not commit generated builds, logs, screenshots, traces, dependency trees, SDD reports, or temporary fixtures.

## File map

- `packages/tool-contracts/src/image-optimize.ts` — internal optimize Worker request/event/result types alongside the existing versioned tool contract.
- `packages/tool-contracts/src/image-optimize.test.ts` — exact protocol shape and constant-limit tests.
- `packages/browser-runtime/src/image-optimize.worker.ts` — native `File` validation/read, inspection, lossless policy, metadata stripping, cancellation, and sanitized events.
- `packages/browser-runtime/src/image-optimize.worker.test.ts` — direct Worker trust-boundary and outcome tests.
- `packages/browser-runtime/src/run-image-optimize-batch.ts` — one-Worker sequential inspect/lossless handles plus strict event/result validation.
- `packages/browser-runtime/src/run-image-optimize-batch.test.ts` — runner ordering, cancellation, malformed-event, timeout, and result-limit tests.
- `packages/browser-runtime/package.json`, `packages/browser-runtime/src/index.ts` — explicit `./image-optimize` export.
- `apps/web/src/lib/local-image-optimize-fallback.ts` — byte-free smart/lossless batch orchestration and result mapping; delete old main-thread byte helpers.
- `apps/web/src/lib/local-image-optimize-fallback.test.ts` — orchestration and no-UI-read regressions.
- `apps/web/src/components/image-compress-workbench.tsx` — selection inspection handle, batch local processing, lifecycle cancellation, unchanged presentation.
- `tests/e2e/image-workbench.spec.ts`, `tests/e2e/image-compression-server.spec.ts`, `tests/e2e/mobile.spec.ts` — controlled Worker doubles and real-browser expectations for the new Worker route.
- `docs/architecture.md` — truthful final Worker-owned compression I/O boundary.

### Task 1: Add the dedicated optimize Worker contract, Worker, and sequential runner

**Files:**
- Modify: `packages/tool-contracts/src/image-optimize.ts`
- Modify: `packages/tool-contracts/src/image-optimize.test.ts`
- Create: `packages/browser-runtime/src/image-optimize.worker.ts`
- Create: `packages/browser-runtime/src/image-optimize.worker.test.ts`
- Create: `packages/browser-runtime/src/run-image-optimize-batch.ts`
- Create: `packages/browser-runtime/src/run-image-optimize-batch.test.ts`
- Modify: `packages/browser-runtime/package.json`
- Modify: `packages/browser-runtime/src/index.ts`

- [ ] **Step 1: Write failing contract and Worker tests**

Add protocol-1 types with exact discriminants:

```ts
export type ImageOptimizeWorkerRequest =
  | { protocol: 1; type: "inspect"; jobId: string; input: ImageOptimizeWorkerFileInput }
  | { protocol: 1; type: "lossless"; jobId: string; input: ImageOptimizeWorkerFileInput }
  | { protocol: 1; type: "cancel"; jobId: string };

export type ImageOptimizeWorkerEvent =
  | { protocol: 1; type: "inspected"; jobId: string; result: ImageOptimizeInspection }
  | { protocol: 1; type: "progress"; jobId: string; sequence: number; phase: "inspecting" | "optimizing" | "verifying"; fraction: null }
  | { protocol: 1; type: "complete"; jobId: string; result: ImageOptimizeLosslessResult }
  | { protocol: 1; type: "unsupported"; jobId: string; reason: "LOSSLESS_SERVER_REQUIRED" }
  | { protocol: 1; type: "failed"; jobId: string; error: ImageOptimizeWorkerError };
```

Reuse the existing shared Worker file-input shape rather than defining another structural copy. Inspection includes detected MIME (`image/jpeg | image/png | image/webp | image/heic`), dimensions, and animation. Lossless completion includes an ordinary transferred `ArrayBuffer`, exact byte length, detected JPG/PNG MIME, dimensions, and empty warnings.

Tests must fail before production code and cover:

- exact request keys/protocol/job ID/native `File`/name/MIME/size consistency;
- matching 0-byte and >30MiB files map to `MEMORY_LIMIT`, while forged metadata maps to `INVALID_SPEC`;
- `File.arrayBuffer()` is called inside the Worker and ordinary-buffer/actual-length checks reject hostile reads;
- valid PNG/JPEG inspection, HEIC detection, animation metadata, 40MP lossless rejection;
- eligible JPEG/PNG metadata stripping and transferred result buffer;
- WebP, rotated JPEG, JPEG ICC, and PNG iCCP yield `LOSSLESS_SERVER_REQUIRED`;
- private read/parser/strip exceptions produce bounded Korean errors without the private text;
- concurrent run rejection, cancel during read, no late completion, and active ownership release.

Run and record RED:

```bash
pnpm exec vitest run packages/tool-contracts/src/image-optimize.test.ts packages/browser-runtime/src/image-optimize.worker.test.ts
```

Expected: new imports/modules or assertions fail for the intended missing behavior.

- [ ] **Step 2: Implement the smallest Worker boundary**

Use existing `inspectImageHeader`, `readJpegExifOrientation`, `stripJpegMetadata`, and `stripPngMetadata`. Keep the small existing ASCII marker scan local to the Worker. Validate exact own enumerable keys before property use, use the native `ArrayBuffer.prototype.byteLength` getter, and transfer only a successful lossless output buffer. Use one `AbortController` for the active job and clear it in `finally`.

Do not require `OffscreenCanvas`: inspection and lossless metadata stripping need only `Worker` and `File`.

- [ ] **Step 3: Write failing runner tests**

The runner exports:

```ts
export function supportsBrowserImageOptimizeRuntime(): boolean;
export function inspectImageOptimizeFiles(
  items: readonly { itemId: string; file: File }[],
  options?: { onProgress?: (completed: number, total: number) => void },
): ImageOptimizeInspectionBatchHandle;
export function runLosslessImageOptimizeBatch(
  items: readonly { itemId: string; file: File }[],
  options?: { onEvent?: (event: LocalImageOptimizeRuntimeEvent) => void },
): LocalImageOptimizeBatchHandle;
```

Use a controllable fake `Worker`. Assert one Worker for multiple inputs, strict input order, exact file envelope, progress/order preservation, ordinary result validation, the existing 30MiB per-item and 20-item bounds (which inherently cap retained lossless output at 600MiB), a 180-second watchdog, observer isolation, crash/message-error handling, and cancel settling all pending entries once while terminating the Worker.

Run and record RED:

```bash
pnpm exec vitest run packages/browser-runtime/src/run-image-optimize-batch.test.ts
```

- [ ] **Step 4: Implement the sequential runner and exports**

Reuse validation idioms from `run-image-batch.ts`; do not extract a cross-runtime framework. Create `new Worker(new URL("./image-optimize.worker.ts", import.meta.url), { type: "module", name: "hereisit-image-optimize-worker" })` once per non-empty batch. Post the next request only after the previous terminal event validates. Termination is the single cleanup path.

Expose only `./image-optimize`; preserve existing exports. Run GREEN:

```bash
pnpm exec vitest run packages/tool-contracts/src/image-optimize.test.ts packages/browser-runtime/src/image-optimize.worker.test.ts packages/browser-runtime/src/run-image-optimize-batch.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/browser-runtime typecheck
pnpm lint
git diff --check
```

- [ ] **Step 5: Review and commit Task 1**

Search every new request/event consumer, verify no filename/content logging, and confirm no UI or codec files changed. Commit:

```bash
git add packages/tool-contracts/src/image-optimize.ts packages/tool-contracts/src/image-optimize.test.ts packages/browser-runtime/src/image-optimize.worker.ts packages/browser-runtime/src/image-optimize.worker.test.ts packages/browser-runtime/src/run-image-optimize-batch.ts packages/browser-runtime/src/run-image-optimize-batch.test.ts packages/browser-runtime/package.json packages/browser-runtime/src/index.ts
git commit -m "perf: move image compression metadata work to Worker"
```

### Task 2: Integrate Worker-owned selection and local compression

**Files:**
- Modify: `apps/web/src/lib/local-image-optimize-fallback.ts`
- Modify: `apps/web/src/lib/local-image-optimize-fallback.test.ts`
- Modify: `apps/web/src/components/image-compress-workbench.tsx`
- Modify as required by real consumers: `tests/e2e/image-workbench.spec.ts`
- Modify as required by real consumers: `tests/e2e/image-compression-server.spec.ts`
- Modify as required by real consumers: `tests/e2e/mobile.spec.ts`

- [ ] **Step 1: Write failing web orchestration tests**

Replace per-file byte-processing expectations with batch dependencies injected into the existing local helper. Assert:

- neither selection orchestration nor local compression invokes `File.arrayBuffer()` in the UI realm;
- smart mode calls `runImageBatch()` once for the batch with `concurrency: 1` and a version-2 `{ format: "source", compression: { mode: "quality", quality: 82 | 72 } }` spec;
- smart `NO_SIZE_REDUCTION`, rejection, cancellation, fulfilled results, and PNG fallback warning preserve current `LocalImageOptimizeResult` meanings;
- lossless mode calls the dedicated lossless batch once and preserves its outcomes/events;
- abort cancels the active common or optimize handle exactly once.

Run and record RED:

```bash
pnpm exec vitest run apps/web/src/lib/local-image-optimize-fallback.test.ts
```

- [ ] **Step 2: Make local orchestration byte-free and batched**

Change the helper to accept all source items, including their Worker-validated detected MIME for the PNG warning only. Use the common image Worker as the authoritative smart processor; do not use detected MIME to choose the encoder. Delete `inspectImageHeader`, EXIF/ICC scanning, metadata stripping, and direct `file.arrayBuffer()` from the web helper.

Keep React item/result mapping outside the runtime. Preserve item order and existing phase labels. A thrown observer never owns processing.

- [ ] **Step 3: Write failing workbench selection/lifecycle tests**

Mock the new inspector at the module boundary for unit coverage or use focused source-contract assertions where the component is not directly unit-mounted. Cover:

- one inspection batch receives at most 20 size-valid files;
- inspection progress keeps `1/N`, `2/N`, … feedback;
- HEIC, animation, unsupported MIME, 40MP, invalid, and >30MiB counts/copy remain identical;
- a replacement selection cancels the prior inspection and ignores its late result;
- processing cancel/unmount cancels the local batch;
- server mode still uses inspected width/height and does not invoke local processing unless fallback is needed.

Update controlled browser Worker doubles to distinguish `hereisit-image-optimize-worker` from `hereisit-image-worker`, accept the exact native `File` envelope, and emit valid optimize inspection/lossless events. Replace the old `Blob.prototype.arrayBuffer` UI-delay test with a Worker-delay test that proves progress and also installs an UI-realm `File.arrayBuffer` tripwire.

Run and record RED with focused non-browser tests only:

```bash
pnpm exec vitest run apps/web/src/lib/local-image-optimize-fallback.test.ts tests/result-download-policy.test.ts tests/tool-route-import-boundary.test.ts
```

- [ ] **Step 4: Integrate the inspection handle and batch local run**

Import `supportsBrowserImageOptimizeRuntime` and the inspector from `@hereisit/browser-runtime/image-optimize`. Track the active inspection handle in a ref; cancel it before a new selection and on unmount. Apply a monotonically increasing selection generation or handle identity check before mutating items.

Do not make server availability depend on `OffscreenCanvas`: selection needs only the optimize inspection runtime. Local smart execution still respects `supportsBrowserImageRuntime()`; local lossless can use the optimize runtime. Preserve the current simple UI and all copy.

Change `runLocal()` to submit the whole batch once, then apply its item-progress/item-complete events with functional `setItems`. Keep server fallback batching.

- [ ] **Step 5: Verify integration and commit Task 2**

```bash
pnpm exec vitest run apps/web/src/lib/local-image-optimize-fallback.test.ts packages/browser-runtime/src/run-image-optimize-batch.test.ts packages/browser-runtime/src/image-optimize.worker.test.ts
pnpm --filter @hereisit/web typecheck
pnpm lint
git diff --check
rg -n "file\.arrayBuffer\(\)|inspectImageHeader\(await file\.arrayBuffer" apps/web/src/components/image-compress-workbench.tsx apps/web/src/lib/local-image-optimize-fallback.ts
```

Expected: tests/typecheck/lint pass and the final search is empty.

```bash
git add apps/web/src/lib/local-image-optimize-fallback.ts apps/web/src/lib/local-image-optimize-fallback.test.ts apps/web/src/components/image-compress-workbench.tsx tests/e2e/image-workbench.spec.ts tests/e2e/image-compression-server.spec.ts tests/e2e/mobile.spec.ts
git commit -m "perf: keep image compression source reads off UI thread"
```

### Task 3: Document the final boundary and verify the whole repository

**Files:**
- Modify: `docs/architecture.md`
- Modify only if verified expectations require it: `README.md`

- [ ] **Step 1: Update architecture truthfully**

Replace the compression exception bullets with:

- selection inspection and local lossless metadata work read native `File`s in the dedicated optimize Worker;
- smart local compression reads and encodes in the common image Worker;
- the UI keeps only native `File` references and validated metadata/results;
- native structured-clone copy behavior is not guaranteed.

Do not claim zero-copy or a total browser-process memory ceiling.

- [ ] **Step 2: Audit scope and run full non-browser verification**

```bash
git diff --check
rg -n "file\.arrayBuffer\(\)|inspectImageHeader\(await file\.arrayBuffer" apps/web/src/components/image-compress-workbench.tsx apps/web/src/lib/local-image-optimize-fallback.ts
rg -n "console\.|logger\.|filename|presigned|objectURL" packages/browser-runtime/src/image-optimize.worker.ts packages/browser-runtime/src/run-image-optimize-batch.ts
pnpm verify
git status --short
git diff --stat origin/main...HEAD
```

Expected: searches find no forbidden UI reads/logging, `pnpm verify` passes, and only approved source/docs/test files are present.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/architecture.md README.md
git commit -m "docs: record image compression Worker ownership"
```

Stage `README.md` only if it actually changed.

### Task 4: Final review, GitHub release, deployment, and cleanup

- [ ] **Step 1: Run one whole-branch review**

Review `git diff origin/main...HEAD` against the approved design and this plan. Focus on trust-boundary validation, stale Worker doubles, cancellation races, OffscreenCanvas capability separation, batch memory bounds, result transfer, server fallback, UI copy, privacy, and scope. Fix every Critical/Important issue with a failing regression test first, then run one scoped re-review of only the fix diff.

- [ ] **Step 2: Publish a ready PR and wait for protected checks**

Use the repository's GitHub release workflow. The PR must describe only the approved performance change and its verification. Require:

- `verify` success;
- protected `browser` success with Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, and mobile WebKit;
- product analytics success;
- Cloudflare Pages preview success.

Do not merge while any required check is pending, skipped unexpectedly, or failed.

- [ ] **Step 3: Merge and verify production/staging**

Squash merge the reviewed head. Verify exact merge SHA on `main`, main `verify`, production Pages, and the push-triggered processing staging deployment/smoke. Main browser may skip only if that is the documented workflow behavior after the already-passed PR matrix.

- [ ] **Step 4: Clean task resources after release review**

After an independent read-only release review passes:

- update the primary checkout so clean `main == origin/main == merge SHA`;
- delete the remote and local feature branch;
- remove `/tmp/hereisit-image-compress-worker-io` and its nested SDD workspace;
- remove only Docker images/containers/volumes/build cache created by this task;
- verify no matching dev/test process remains;
- do not touch unrelated retained worktrees or their artifacts.

Final evidence must include PR, reviewed head, merge SHA, protected browser results, Pages/staging results, clean primary Git state, and zero task-owned temporary resources.
