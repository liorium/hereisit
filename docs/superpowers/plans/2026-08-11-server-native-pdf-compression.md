# Server-native PDF compression implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly chosen qpdf server fallback that reduces structured PDFs the browser cannot safely shrink, verifies every result, and preserves the existing local and image-processing behavior.

**Architecture:** Keep the current browser compressor first. Add `pdf.optimize@1`, a separate PDF queue and qpdf container behind the existing authenticated job platform, then verify downloaded results in a dedicated browser Worker before exposing a direct download. Generalize only the shared contract-discriminated control-plane seams required by the second tool; image behavior remains unchanged.

**Tech Stack:** TypeScript 6, Zod, React 19, Next.js 16, PDF.js 6.2.108, qpdf 12.4.0, Node.js 24, Cloudflare Workers/Queues/R2/D1/Containers, Vitest 4, Playwright 1.62

## Global Constraints

- Keep the current local structural rewrite and image-only raster path first; no successful local job contacts the server.
- Server upload starts only after the user presses `처리 서버에서 더 압축` beside an explicit deletion notice.
- Accept one 1-byte–50 MiB PDF with 1–100 pages and return only `application/pdf` at least 1% smaller.
- Pin qpdf 12.4.0 source SHA-256 to `2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529`.
- Add no browser dependency and ship no AGPL, Ghostscript, MuPDF, pdfcpu, Poppler, or community WASM code.
- Never log filenames, file contents, extracted text, thumbnails, rendered pixels, object keys, presigned URLs, or job tokens.
- Keep image processing contracts, queue, database rows, container, rollout, and public behavior unchanged.
- Use exact-length I/O, random object keys, bounded memory/time/disk, smaller-only candidates, direct download, deletion acknowledgement, and sanitized public errors.
- All new behavior follows RED → GREEN TDD; browser codecs are validated by dimensions, signatures, semantics, and tolerances rather than byte equality.

---

### Task 1: Versioned PDF server contract and processing manifest

**Files:**
- Create: `packages/tool-contracts/src/pdf-optimize.ts`
- Create: `packages/tool-contracts/src/pdf-optimize.test.ts`
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/package.json`
- Modify: `packages/tool-registry/src/processing.ts`
- Modify: `packages/tool-registry/src/processing.test.ts`
- Modify: `packages/server-contracts/src/index.ts`
- Modify: `packages/server-contracts/src/index.test.ts`

**Interfaces:**
- Produces: `PDF_OPTIMIZE_CONTRACT_ID = "pdf.optimize@1"`, `PdfOptimizeSpecV1`, strict create/policy/status schemas, and `PdfOptimizeWarningCode`.
- Produces: `pdfCompressionProcessingManifest` with one PDF, 50 MiB, 100 pages, `pdf-standard-v1`, `browser.pdf-compress-scanned` fallback, and `pdf-compress-server` rollout.
- Extends: engine request/status schemas as a strict discriminated union while retaining every current image branch.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(pdfOptimizeSpecV1Schema.parse({ version: 1, preset: "balanced" })).toEqual({
  version: 1,
  preset: "balanced",
});
expect(() => pdfOptimizeSpecV1Schema.parse({ version: 1, preset: "fast" })).toThrow();
expect(
  pdfOptimizeCreateRequestSchema.parse({
    contract: "tool-job@1",
    toolContract: "pdf.optimize@1",
    clientRequestId: crypto.randomUUID(),
    anonymousSessionId: "a".repeat(43),
    spec: { version: 1, preset: "minimum" },
    input: { byteLength: 1_000, mime: "application/pdf", pageCount: 3 },
  }),
).toMatchObject({ toolContract: "pdf.optimize@1" });
```

Also assert exact warning/profile combinations, smaller-only result metadata, 50 MiB/100-page bounds, strict unknown-key rejection, and that all existing image fixtures still parse unchanged.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/tool-contracts/src/pdf-optimize.test.ts packages/tool-registry/src/processing.test.ts packages/server-contracts/src/index.test.ts
```

Expected: failures identify missing PDF modules, manifest, and server union branches; existing image assertions remain green.

- [ ] **Step 3: Implement the minimum strict schemas and manifest**

Use discriminators rather than optional cross-tool fields. The public result union is:

```ts
type PdfOptimizeResult =
  | {
      kind: "download";
      mime: "application/pdf";
      sourceByteLength: number;
      byteLength: number;
      pageCount: number;
      profile: "structural" | "image-optimized";
      engineBuildId: string;
      warnings: readonly PdfOptimizeWarningCode[];
    }
  | {
      kind: "original-retained";
      sourceByteLength: number;
      pageCount: number;
      engineBuildId: string;
      warnings: readonly ["ORIGINAL_RETAINED_UNMODIFIED"];
    };
```

Require `SIGNATURES_INVALIDATED` for downloads and additionally `EMBEDDED_IMAGE_QUALITY_CHANGED` only for `image-optimized`.

- [ ] **Step 4: Run focused tests and package typechecks for GREEN**

```bash
pnpm exec vitest run packages/tool-contracts/src/pdf-optimize.test.ts packages/tool-registry/src/processing.test.ts packages/server-contracts/src/index.test.ts
pnpm --filter @hereisit/tool-contracts typecheck
pnpm --filter @hereisit/tool-registry typecheck
pnpm --filter @hereisit/server-contracts typecheck
```

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/tool-contracts packages/tool-registry/src/processing.ts packages/tool-registry/src/processing.test.ts packages/server-contracts
git commit -m "feat: define PDF optimization contracts"
```

### Task 2: Contract-discriminated job storage and resource planning

**Files:**
- Create: `apps/api-worker/migrations/0008_pdf_processing_jobs.sql`
- Modify: `apps/api-worker/src/d1-job-repository.ts`
- Modify: `apps/api-worker/src/d1-job-repository.test.ts`
- Modify: `packages/server-job/src/resource-estimate.ts`
- Modify: `packages/server-job/src/resource-estimate.test.ts`
- Modify: `packages/server-job/src/quota.ts`
- Modify: `packages/server-job/src/quota.test.ts`
- Modify: `apps/api-worker/src/r2-artifacts.ts`
- Modify: `apps/api-worker/src/r2-artifacts.test.ts`
- Modify: `packages/server-runtime/src/download.ts`
- Modify: `packages/server-runtime/src/download.test.ts`

**Interfaces:**
- Consumes: strict image/PDF create and result unions from Task 1.
- Produces: one job repository whose image rows require dimensions/pixels and whose PDF rows require page count; cross-tool field combinations are rejected.
- Preserves: current image resource reservations and retention timestamps exactly.

- [ ] **Step 1: Write failing repository and estimate tests**

Add a PDF fixture and assert:

```ts
expect(await repository.create(pdfCreate)).toMatchObject({
  contractId: "pdf.optimize@1",
  declaredMime: "application/pdf",
  declaredPageCount: 3,
  resourceClass: "pdf-standard-v1",
});
expect(() => estimateResources({ ...pdfCreate, declaredPageCount: 101 })).toThrow();
expect(() => parseStoredJob({ ...pdfRow, declared_width: 1 })).toThrow();
```

Retain the full image fixture matrix and add migration tests proving existing rows copy byte-for-byte except for newly nullable/tool-specific columns.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm exec vitest run apps/api-worker/src/d1-job-repository.test.ts packages/server-job/src/resource-estimate.test.ts packages/server-job/src/quota.test.ts apps/api-worker/src/r2-artifacts.test.ts packages/server-runtime/src/download.test.ts
```

Expected: PDF rows/specs are rejected because storage and estimates are image-only.

- [ ] **Step 3: Add the safe D1 migration and discriminated parsing**

Rebuild `jobs` once in migration `0008`: copy all columns, make `declared_width`, `declared_height`, verified image fields, and output dimensions nullable, and add nullable `declared_page_count`, `output_page_count`, and `pdf_profile`. Add CHECK constraints keyed by `contract_id`:

```sql
CHECK (
  (contract_id = 'image.optimize@1' AND declared_width IS NOT NULL AND declared_height IS NOT NULL AND declared_page_count IS NULL)
  OR
  (contract_id = 'pdf.optimize@1' AND declared_width IS NULL AND declared_height IS NULL AND declared_page_count BETWEEN 1 AND 100)
)
```

Recreate all existing indexes and triggers from migrations 0001–0007. Parse database rows through contract-specific strict schemas before returning domain objects.

- [ ] **Step 4: Generalize byte/object handling without weakening image limits**

Choose max bytes and output MIME from the job discriminator. PDF R2 objects use the same opaque `inputs/<uuid>` and `outputs/<uuid>` forms, `application/pdf`, exact ETags, and retention lifecycle. Do not add filenames or a second bucket.

- [ ] **Step 5: Run migration/integration-focused tests for GREEN**

```bash
pnpm exec vitest run apps/api-worker/src/d1-job-repository.test.ts packages/server-job/src/resource-estimate.test.ts packages/server-job/src/quota.test.ts apps/api-worker/src/r2-artifacts.test.ts packages/server-runtime/src/download.test.ts
pnpm --filter @hereisit/api-worker typecheck
```

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/api-worker/migrations/0008_pdf_processing_jobs.sql apps/api-worker/src/d1-job-repository* apps/api-worker/src/r2-artifacts* packages/server-job/src packages/server-runtime/src/download*
git commit -m "feat: store PDF processing jobs"
```

### Task 3: Dedicated qpdf engine and supply-chain gate

**Files:**
- Create: `apps/pdf-engine/package.json`
- Create: `apps/pdf-engine/tsconfig.json`
- Create: `apps/pdf-engine/Dockerfile`
- Create: `apps/pdf-engine/Dockerfile.dockerignore`
- Create: `apps/pdf-engine/native/sources.lock.json`
- Create: `apps/pdf-engine/native/build-qpdf.sh`
- Create: `apps/pdf-engine/licenses/policy.json`
- Create: `apps/pdf-engine/src/config.ts`
- Create: `apps/pdf-engine/src/config.test.ts`
- Create: `apps/pdf-engine/src/job/workspace.ts`
- Create: `apps/pdf-engine/src/job/workspace.test.ts`
- Create: `apps/pdf-engine/src/job/qpdf-command.ts`
- Create: `apps/pdf-engine/src/job/qpdf-command.test.ts`
- Create: `apps/pdf-engine/src/job/job-runner.ts`
- Create: `apps/pdf-engine/src/job/job-runner.test.ts`
- Create: `apps/pdf-engine/src/http/router.ts`
- Create: `apps/pdf-engine/src/http/router.test.ts`
- Create: `apps/pdf-engine/src/server.ts`
- Create: `apps/pdf-engine/src/self-test.ts`
- Create: `apps/pdf-engine/src/self-test.test.ts`
- Create: `apps/pdf-engine/licenses/qpdf-12.4.0-Apache-2.0.txt`
- Create: `scripts/verify-pdf-engine-licenses.mjs`
- Create: `tests/pdf-engine-license-policy.test.ts`
- Modify: `package.json`
- Modify: `scripts/application-supply-chain.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `EngineCreatePdfJobRequest` and PDF engine terminal status from Task 1.
- Produces: the same authenticated internal `/v1/jobs` lifecycle shape used by the container client, with PDF-only strict schemas.
- Produces: deterministic `qpdfArgs(preset, source, candidate)`; no user-controlled argument reaches the process.

- [ ] **Step 1: Write RED tests for fixed commands and hostile inputs**

```ts
expect(qpdfArgs("balanced", "/job/input.bin", "/job/candidate.pdf")).toEqual([
  "--object-streams=generate",
  "--compress-streams=y",
  "--decode-level=generalized",
  "--recompress-flate",
  "--compression-level=9",
  "--remove-unreferenced-resources=yes",
  "--optimize-images",
  "--jpeg-quality=82",
  "--",
  "/job/input.bin",
  "/job/candidate.pdf",
]);
expect(() => qpdfArgs("balanced", "-unsafe", "/job/out.pdf")).toThrow();
```

Add cases for `minimum` quality 65, structural candidate, corrupt/encrypted/oversized files, wrong page count, expansion, timeout, OOM mapping, cancellation, late child processes, output symlinks, truncated output, diagnostic bounds, and cleanup after every terminal state.

- [ ] **Step 2: Run new engine tests and confirm RED**

```bash
pnpm exec vitest run apps/pdf-engine/src tests/pdf-engine-license-policy.test.ts
```

Expected: missing package/modules and policy gate.

- [ ] **Step 3: Pin and build qpdf**

`sources.lock.json` contains the official URL, version, and SHA-256. `build-qpdf.sh` downloads only that URL, verifies the hash before extraction, builds the CLI without docs/tests/static libraries, strips it, and copies it into the runtime stage. The runtime image contains Node 24, qpdf and required shared libraries, CA certificates only if the base requires them, license/NOTICE files, and the compiled engine. Run as UID 10001 with no writable path outside `/tmp/hereisit-pdf-engine`.

- [ ] **Step 4: Implement the bounded two-candidate runner**

Generate structural and preset image-optimized candidates sequentially. For each: run fixed qpdf args in its own process group, run `qpdf --check`, obtain `--show-npages`, validate PDF header/EOF, exact size, page count, and 1% target, then choose the smallest valid candidate. Publish via atomic rename. Return `original-retained` when none qualify. Record only numeric measurements and fixed engine/profile identifiers.

- [ ] **Step 5: Run engine and supply-chain GREEN checks**

```bash
pnpm exec vitest run apps/pdf-engine/src tests/pdf-engine-license-policy.test.ts
pnpm --filter @hereisit/pdf-engine typecheck
node scripts/verify-pdf-engine-licenses.mjs --root apps/pdf-engine
docker build --file apps/pdf-engine/Dockerfile --tag hereisit-pdf-engine:test apps/pdf-engine
docker run --rm hereisit-pdf-engine:test node /app/dist/self-test.mjs
```

Remove the test container after the checks; keep the image only until the benchmark task consumes it.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/pdf-engine scripts/verify-pdf-engine-licenses.mjs tests/pdf-engine-license-policy.test.ts scripts/application-supply-chain.mjs package.json pnpm-lock.yaml .github/workflows/ci.yml
git commit -m "feat: add the native PDF engine"
```

### Task 4: PDF queue, container routing, and public API

**Files:**
- Modify: `apps/api-worker/src/env.ts`
- Modify: `apps/api-worker/src/container-client.ts`
- Modify: `apps/api-worker/src/container-client.test.ts`
- Modify: `apps/api-worker/src/routes/policy.ts`
- Modify: `apps/api-worker/src/routes/policy.test.ts`
- Modify: `apps/api-worker/src/routes/jobs.ts`
- Modify: `apps/api-worker/src/routes/jobs.test.ts`
- Modify: `apps/api-worker/src/queue-consumer.ts`
- Modify: `apps/api-worker/src/queue-consumer.test.ts`
- Modify: `apps/api-worker/src/router.ts`
- Modify: `apps/api-worker/src/index.ts`
- Modify: `apps/api-worker/src/sweeper.ts`
- Modify: `apps/api-worker/src/sweeper.test.ts`
- Modify: `apps/api-worker/src/circuit-breaker.ts`
- Modify: `apps/api-worker/src/circuit-breaker.test.ts`
- Modify: `apps/api-worker/src/telemetry.ts`
- Modify: `apps/api-worker/src/telemetry.test.ts`
- Modify: `apps/api-worker/src/cost-accounting-runtime.ts`
- Modify: `apps/api-worker/src/cost-accounting-runtime.test.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`

**Interfaces:**
- Produces: policy/create/upload/status/download/delete API behavior for `pdf.optimize@1` through the existing `/v1` routes.
- Produces: `PdfEngineContainer`, `PDF_ENGINE`, `PDF_JOBS`, and contract-routed queue consumption.
- Preserves: image queue messages always route to `IMAGE_ENGINE`; PDF messages never do.

- [ ] **Step 1: Write failing API/queue tests**

Test exact policy behavior, a complete PDF create→upload→queue→engine→download→acknowledge→delete lifecycle, queue redelivery, DLQ, cancellation, sweep, circuit-open fallback, cost ceiling, and these isolation assertions:

```ts
expect(imageEngine.create).toHaveBeenCalledTimes(0);
expect(pdfEngine.create).toHaveBeenCalledWith(expect.objectContaining({ tool: "pdf.optimize" }));
expect(pdfQueue.send).toHaveBeenCalledWith(expect.objectContaining({ contractId: "pdf.optimize@1" }));
```

Re-run all current image policy/job/queue fixtures unchanged in the same suites.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm exec vitest run apps/api-worker/src/routes/policy.test.ts apps/api-worker/src/routes/jobs.test.ts apps/api-worker/src/container-client.test.ts apps/api-worker/src/queue-consumer.test.ts apps/api-worker/src/sweeper.test.ts apps/api-worker/src/circuit-breaker.test.ts apps/api-worker/src/telemetry.test.ts apps/api-worker/src/cost-accounting-runtime.test.ts
```

- [ ] **Step 3: Implement contract routing once at shared boundaries**

Parse policy/create/message/status unions at entry points, then select manifest, queue, engine client, limits, and public projector by `toolContract`. Do not spread `if (pdf)` checks through repositories. The route returns the contract-specific strict schema and generic sanitized error shape.

- [ ] **Step 4: Add the separate queue/container configuration**

Local config binds `PDF_JOBS` and its DLQ at batch size/concurrency 1, plus `PdfEngineContainer` from `apps/pdf-engine/Dockerfile`. The PDF container has `enableInternet = false`, `sleepAfter = "60s"`, one deterministic instance name, and an immutable image identity validator distinct from the image engine.

- [ ] **Step 5: Run focused and API integration GREEN checks**

```bash
pnpm exec vitest run apps/api-worker/src/routes/policy.test.ts apps/api-worker/src/routes/jobs.test.ts apps/api-worker/src/container-client.test.ts apps/api-worker/src/queue-consumer.test.ts apps/api-worker/src/sweeper.test.ts apps/api-worker/src/circuit-breaker.test.ts apps/api-worker/src/telemetry.test.ts apps/api-worker/src/cost-accounting-runtime.test.ts
pnpm --filter @hereisit/api-worker test:integration
pnpm --filter @hereisit/api-worker typecheck
```

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/api-worker
git commit -m "feat: route PDF processing jobs"
```

### Task 5: Browser PDF server client and result verifier

**Files:**
- Create: `packages/server-runtime/src/run-pdf-optimize-job.ts`
- Create: `packages/server-runtime/src/run-pdf-optimize-job.test.ts`
- Modify: `packages/server-runtime/src/api-client.ts`
- Modify: `packages/server-runtime/src/api-client.test.ts`
- Modify: `packages/server-runtime/src/upload.ts`
- Modify: `packages/server-runtime/src/upload.test.ts`
- Modify: `packages/server-runtime/src/index.ts`
- Create: `packages/browser-runtime/src/pdf-optimize-verify.worker.ts`
- Create: `packages/browser-runtime/src/pdf-optimize-verify.worker.test.ts`
- Create: `packages/browser-runtime/src/run-pdf-optimize-verification.ts`
- Create: `packages/browser-runtime/src/run-pdf-optimize-verification.test.ts`
- Modify: `packages/browser-runtime/package.json`

**Interfaces:**
- Produces: `runPdfOptimizeJob(file, spec, options)` using the existing credential/upload/status/download/delete lifecycle.
- Produces: `verifyPdfOptimizeResult(sourceFile, resultFile, descriptor, options)` with cancellation and bounded progress.
- Consumes: PDF.js page inspection/raster helpers already present in browser-runtime; adds no dependency.

- [ ] **Step 1: Write RED server-client tests**

Cover exact create body, `application/pdf` upload, monotonic status sequence, original-retained, download length/MIME/digest, cancellation/deletion, expired URLs, retries, late responses, and no filename in any request. Assert image client fixtures remain unchanged.

- [ ] **Step 2: Write RED verification Worker tests**

Use generated PDFs and controlled PDF.js adapters to prove page-count/box/rotation/text/annotation/operator mismatches reject, structural profiles create no canvas, image profiles sample at most five deterministic pages, pixel tolerance accepts bounded JPEG change and rejects blank/missing content, output size/envelope are exact, cancellation terminates both parser Workers, and private errors are sanitized.

- [ ] **Step 3: Run both suites and confirm RED**

```bash
pnpm exec vitest run packages/server-runtime/src/run-pdf-optimize-job.test.ts packages/server-runtime/src/api-client.test.ts packages/server-runtime/src/upload.test.ts packages/browser-runtime/src/pdf-optimize-verify.worker.test.ts packages/browser-runtime/src/run-pdf-optimize-verification.test.ts
```

- [ ] **Step 4: Implement the minimum generic client seams and Worker**

Parameterize the existing API client with the contract-specific strict schemas rather than duplicating fetch/token/error logic. The verifier reads both native `File` objects inside its Worker, compares every page's semantic summary, then renders only deterministic sample pages for `image-optimized`. It returns a result descriptor and Blob; it never posts source bytes, extracted text, or pixels to React.

- [ ] **Step 5: Run focused GREEN checks**

```bash
pnpm exec vitest run packages/server-runtime/src/run-pdf-optimize-job.test.ts packages/server-runtime/src/api-client.test.ts packages/server-runtime/src/upload.test.ts packages/browser-runtime/src/pdf-optimize-verify.worker.test.ts packages/browser-runtime/src/run-pdf-optimize-verification.test.ts
pnpm --filter @hereisit/server-runtime typecheck
pnpm --filter @hereisit/browser-runtime typecheck
```

- [ ] **Step 6: Commit Task 5**

```bash
git add packages/server-runtime packages/browser-runtime
git commit -m "feat: verify native PDF results"
```

### Task 6: Minimal PDF compression UI integration

**Files:**
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.module.css`
- Modify: `apps/web/src/lib/tool-implementations.ts`
- Modify: `apps/web/src/lib/tool-implementations.test.ts`
- Modify: `apps/web/src/lib/site.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `tests/e2e/support/privacy-observer.ts`
- Modify: `scripts/smoke-pdf-compress.mjs`
- Modify: `scripts/verify-static-export.mjs`

**Interfaces:**
- Consumes: local `NO_SIZE_REDUCTION`, PDF policy/job client, and verification Worker from Task 5.
- Produces: explicit server fallback state and the same direct-download-only result UI.
- Preserves: successful local compression layout, preset behavior, analytics events, keyboard/focus behavior, and zero-server local flow.

- [ ] **Step 1: Update browser tests first**

Add intercepted-server tests for:

```ts
await expect(page.getByRole("button", { name: "처리 서버에서 더 압축" })).toBeVisible();
await expect(page.getByText(/PDF를 HereIsIt 처리 서버로 보내며/)).toBeVisible();
await expect(page.getByText(/자동으로 삭제/)).toBeVisible();
```

Assert no `/v1/policy`, create, upload, or status request before the explicit click; successful local jobs never show the server action; verified server results show only size summary, mode note, and `PDF 다운로드`; verification failure deletes the job and shows a sanitized retry state. Cover replacement, cancel, unmount, reload, direct download, 320px mobile layout, keyboard focus, and all existing privacy-observer invariants.

- [ ] **Step 2: Implement the minimal staged UI**

Keep one visible stage. Start the local job exactly as now. On structured `NO_SIZE_REDUCTION`, retain the selected file/inspection/preset and render the disclosure plus one server button. After explicit click, obtain policy, create/upload/run/poll/download, verify in the Worker, then create the Blob URL. Revoke URLs and cancel/delete all handles on reset, replacement, navigation, and unmount. Existing product analytics remain the four aggregate events and receive no filename/mode/page data.

- [ ] **Step 3: Run non-browser verification**

```bash
pnpm exec vitest run apps/web/src/lib/tool-implementations.test.ts packages/server-runtime/src/run-pdf-optimize-job.test.ts packages/browser-runtime/src/run-pdf-optimize-verification.test.ts
pnpm --filter @hereisit/web typecheck
pnpm lint
```

Do not run `smoke-pdf-compress.mjs` or local Playwright; the protected browser job owns Chromium, Firefox,
WebKit, mobile projects, and the browser smoke source changed by this task.

- [ ] **Step 4: Commit Task 6**

```bash
git add apps/web/src/components/pdf-compress-workbench.tsx apps/web/src/components/pdf-workbench.module.css apps/web/src/lib/tool-implementations* apps/web/src/lib/site.ts tests/e2e/pdf-compression.spec.ts tests/e2e/mobile.spec.ts tests/e2e/support/privacy-observer.ts scripts/smoke-pdf-compress.mjs scripts/verify-static-export.mjs
git commit -m "feat: add explicit native PDF compression"
```

### Task 7: Deterministic PDF corpus, benchmark, and documentation

**Files:**
- Create: `scripts/create-pdf-compression-corpus.mjs`
- Create: `scripts/benchmark-pdf-engine.mjs`
- Create: `tests/create-pdf-compression-corpus.test.ts`
- Create: `tests/benchmark-pdf-engine.test.ts`
- Create: `docs/deployment/pdf-engine-benchmark.schema.json`
- Create: `docs/deployment/pdf-engine-release-gate.schema.json`
- Create: `.github/workflows/pdf-quality-benchmark.yml`
- Modify: `docs/architecture.md`
- Modify: `docs/privacy.md`
- Modify: `docs/deployment/processing-staging-cost-input.json`
- Modify: `docs/deployment/processing.md`

**Interfaces:**
- Produces: generated repository-owned corpus manifest and deterministic JSON benchmark report.
- Produces: release gate requiring valid semantics, zero expansion, bounded resources, and a measured win over the local structural baseline.

- [ ] **Step 1: Write RED corpus and benchmark parser tests**

The generated corpus contains deterministic text/vector, link, annotation, form, outline, attachment, layer, duplicate-resource, Flate-heavy, JPEG-heavy, non-JPEG-image, scan, mixed, encrypted, corrupt, expansion, and decompression-bomb strata. Tests assert fixture hashes, no external downloads, manifest completeness, bounded total bytes, sanitized JSON, and rejection of missing/duplicate/unsafe strata.

- [ ] **Step 2: Run and confirm RED**

```bash
pnpm exec vitest run tests/create-pdf-compression-corpus.test.ts tests/benchmark-pdf-engine.test.ts
```

- [ ] **Step 3: Implement deterministic generation and benchmarking**

Use only installed `@cantoo/pdf-lib`, fixed seeds, and embedded tiny generated image bytes. Benchmark the local structural pass and the PDF container for ratio, cold/warm duration, peak RSS, candidate count, semantic verdict, and sampled visual verdict. Store no original filenames or text in the report. The release gate fails on any semantic failure, any returned expansion, limit escape, or when qpdf shows no repeatable reduction advantage in at least one structured corpus stratum.

- [ ] **Step 4: Run benchmark and schema validation**

```bash
node scripts/create-pdf-compression-corpus.mjs --output .artifacts/pdf-corpus
node scripts/benchmark-pdf-engine.mjs --engine-image hereisit-pdf-engine:test --corpus .artifacts/pdf-corpus/manifest.json --output .artifacts/pdf-benchmark.json
pnpm exec vitest run tests/create-pdf-compression-corpus.test.ts tests/benchmark-pdf-engine.test.ts
```

Delete `.artifacts/pdf-corpus` after recording only the bounded benchmark JSON required for the release gate.

- [ ] **Step 5: Update truthful docs**

Document local-first/server-fallback flow, exact qpdf limitation, upload/deletion boundary, two isolated containers/queues, limits, warnings, license inventory, cost model, rollback, and the fact that DPI-aware image resampling remains unsupported.

- [ ] **Step 6: Commit Task 7**

```bash
git add scripts/create-pdf-compression-corpus.mjs scripts/benchmark-pdf-engine.mjs tests/create-pdf-compression-corpus.test.ts tests/benchmark-pdf-engine.test.ts docs .github/workflows/pdf-quality-benchmark.yml
git commit -m "test: gate native PDF compression quality"
```

### Task 8: Immutable deployment, canary, admission, and cleanup

**Files:**
- Modify: `scripts/create-processing-candidate.mjs`
- Modify: `scripts/verify-processing-candidate.mjs`
- Modify: `scripts/create-processing-release-report.mjs`
- Modify: `scripts/resolve-github-release-assets.mjs`
- Modify: `scripts/resolve-cloudflare-container-application.mjs`
- Modify: `scripts/generate-wrangler-config.mjs`
- Modify: `scripts/provision-processing-resources.mjs`
- Modify: `scripts/verify-processing-deployment-environment.mjs`
- Create: `scripts/smoke-pdf-compress-server.mjs`
- Create: `tests/create-processing-candidate.test.ts`
- Create: `tests/generate-wrangler-config.test.ts`
- Create: `tests/provision-processing-resources.test.ts`
- Create: `tests/smoke-pdf-compress-server.test.ts`
- Modify: `.github/workflows/processing-staging.yml`
- Modify: `.github/workflows/processing-staging-smoke.yml`
- Modify: `.github/workflows/processing-production.yml`
- Modify: `.github/workflows/processing-production-admission.yml`
- Modify: `.github/workflows/processing-production-preflight.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: one release report binding exact source SHA, Worker artifact, image engine digest, PDF engine digest, both license/vulnerability gates, benchmark report, and cost model.
- Produces: staging and production resources for PDF queue/DLQ/container plus authenticated and anonymous PDF smokes.
- Preserves: existing image candidate, canary, admission, rollback, and public smoke evidence.

- [ ] **Step 1: Write workflow/script contract tests before edits**

Add source-contract tests that require two immutable engine digests, exact-SHA artifact binding, qpdf license/benchmark gates, PDF resource IDs, paused-before-deploy queues, canary-only first deployment, public admission only after successful canary/deletion/cost evidence, and rollback of Worker plus both engines. Existing image-only tamper fixtures must still fail for the same reasons.

- [ ] **Step 2: Run workflow/script tests and confirm RED**

```bash
pnpm exec vitest run tests/create-processing-candidate.test.ts tests/verify-processing-candidate.test.ts tests/create-processing-release-report.test.ts tests/resolve-github-release-assets.test.ts tests/resolve-cloudflare-container-application.test.ts tests/generate-wrangler-config.test.ts tests/provision-processing-resources.test.ts tests/verify-processing-deployment-environment.test.ts tests/smoke-pdf-compress-server.test.ts
```

- [ ] **Step 3: Extend the immutable release pair to an immutable release triple**

Build and scan `hereisit-pdf-engine`, publish by digest, bind both engine digests into generated Wrangler config and release report, provision the separate PDF queue/DLQ/container application, and validate all IDs against the selected account/environment. Staging runs the generated corpus smoke, exact upload, progress, verified download, delete acknowledgement, sweep, queue pause/resume, and rollback drill.

- [ ] **Step 4: Run full local non-browser verification**

```bash
pnpm verify
git diff --check origin/main...HEAD
git status --short
```

Expected: audit, lint, 11+ package typechecks, all Vitest and Worker integration suites, fuzz, builds, static export, discovery imports, and bundle budgets pass. No local Playwright is run.

- [ ] **Step 5: Request independent code review and fix only validated findings**

Review exact `origin/main...HEAD` for contract trust boundaries, PDF semantics, command injection, resource cleanup, cancellation races, D1 migration safety, privacy, licensing, deployment rollback, and unnecessary abstractions. Any production correction must repeat RED → GREEN focused verification and `pnpm verify`.

- [ ] **Step 6: Publish and watch protected CI**

Push `feat/pdf-native-compression`, open the PR, and wait for `verify`, the six-project Playwright matrix, product analytics checks, image benchmark, PDF benchmark, vulnerability/license gates, and Pages preview. Do not merge on pending, skipped-required, or failing evidence.

- [ ] **Step 7: Merge and complete staged rollout**

After green PR checks, merge the reviewed exact head. Wait for main verify, exact-SHA processing staging, authenticated PDF smoke, production maintainer canary, deletion/cost/rollback evidence, public admission, anonymous production PDF smoke, and production Pages. If the production benchmark or cost ceiling fails, keep PDF policy local and preserve image production.

- [ ] **Step 8: Clean finished artifacts**

Remove benchmark corpora, downloaded CI artifacts without audit value, stopped servers, PDF test containers/images/volumes, and `/tmp/hereisit-pdf-native-compression` after the primary checkout is fast-forwarded clean to `origin/main`. Retain only sealed release reports and required audit evidence; do not touch unrelated worktrees.
