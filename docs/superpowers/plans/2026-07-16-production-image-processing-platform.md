# Production Image Processing Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, privacy-safe server job platform and a production-grade same-format JPG, PNG, and WebP optimizer, then make `/image/compress` use it by default behind a reversible rollout policy.

**Architecture:** A static Next.js web client creates versioned jobs through one Cloudflare Worker, streams each authenticated exact-length upload through that Worker into temporary R2 storage, and observes D1-backed Queue jobs processed by one portable native image container. Public tool/job contracts, internal server contracts, pure job policy, browser orchestration, control-plane bindings, and native codecs remain separate packages so later image and PDF engines can reuse the platform. The server returns only verified outputs that are smaller than the source; otherwise the browser retains and downloads its original local file.

**Tech Stack:** Node.js 24.13.0, pnpm 11.11.0, TypeScript 6.0.3, React 19.2.7, Next.js 16.2.10 static export, Zod 4.4.3, Wrangler 4.110.0, Cloudflare Workers/Queues/D1/R2/Containers/Analytics Engine/Workers Logpush, `@cloudflare/containers` 0.3.7, `@cloudflare/vitest-pool-workers` 0.18.5, Sharp 0.35.3, libvips 8.18.4, MozJPEG 4.1.1, OxiPNG 10.1.1, Quantizr 1.4.3, libwebp 1.6.0, esbuild 0.28.1, Vitest 4.1.10, and Playwright 1.61.1.

## Global Constraints

- Complete every task with RED → GREEN → REFACTOR and the focused Conventional Commit shown in that task.
- Preserve the existing static Pages web deployment; the new API Worker and image container are separately deployed services.
- Do not migrate PDF, resize, convert, crop, rotate, or watermark processing in this plan.
- Server compression accepts only structurally valid JPEG, PNG, and WebP and always emits the same format.
- Animated GIF, animated WebP, APNG, HEIC/HEVC, AVIF output, JPEG XL output, AI processing, accounts, payments, and a public API remain excluded.
- The browser must state the active execution location before file selection. A file never leaves the device unless the visible picker disclosure says it will be uploaded and automatically deleted.
- Server limits are exactly 20 files per task, 30 MiB per file, 40 megapixels per file, and one active native job per anonymous session.
- A production deployment has no implicit free-compute allowance. `ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT` missing or equal to `0` disables new server jobs; `ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT` separately bounds one anonymous session.
- The initial Queue uses `max_batch_size: 1` and `max_concurrency: 1`; the initial container binding uses `max_instances: 1` and fixed instance name `image-slot-0`.
- A normal production job creates one fast codec candidate and at most two refinements.
- Transient infrastructure failures retry the same idempotent job at most twice. A pre-decode
  working-set upgrade or qualifying native OOM may move exactly once from the standard to large resource
  class.
- Inputs are deleted on every terminal path. Result deletion becomes due after confirmed download or at
  30 minutes; under healthy operation the five-minute sweeper has a 35-minute application SLO, not a hard
  maximum. Platform outages can delay deletion, so a one-day R2 expiration rule is an additional
  last-resort safety net and every SLO miss opens the circuit and alerts the operator.
- Never log file bytes, filenames, thumbnails, extracted metadata values, source text, object credentials, job bearer tokens, upload routes, or user-provided content.
- Object keys are random and opaque. Neither original nor suggested filenames enter D1, R2 keys, Queue messages, container requests, telemetry, or server logs.
- Job creation is protected by session and network Cloudflare Rate Limiting bindings plus authoritative
  D1 quotas. The raw client IP is canonicalized only in memory to an IPv4 `/24` or IPv6 `/56`, HMACed
  with the current/previous secret pair and UTC day, then discarded. Only the current rotating network
  hash has a 48-hour active-table retention target and is structurally decoupled from long-running
  artifact cleanup; the privacy disclosure still allows exceptional maintenance delay. The
  authoritative pending check sums current and previous UTC-day hashes, so midnight cannot
  double the ceiling. One network may hold at most three pre-terminal jobs and has an explicit daily weighted-unit
  ceiling, so rotating anonymous session IDs cannot starve all pending slots or consume the entire
  account allowance. Policy and all job API routes have separate network-keyed edge limits before JSON
  parsing or D1/R2 access; per-job read and result-start limits remain additional fences.
- Direct result actions download only. Do not call `navigator.share`, open a preview-first result window, or add a share action.
- The Worker streams R2 input to the container and container output to R2 without `arrayBuffer()` or whole-file buffering.
- The container runs non-root as UID 10001, with `umask 077`, no outbound internet, no shell interpolation, and a fresh job directory. `image-standard-v1` allows a 60-second wall limit, 1 GiB workspace, and 768 MiB native-memory delta; one preflight upgrade or qualifying OOM retry may use `image-large-v1` with 90 seconds, 2 GiB workspace, and 1,536 MiB native-memory delta on the same fixed `standard-2` container.
- The first production JPEG encoder is MozJPEG. jpegli remains benchmark-only until its patent notice receives written review and it passes the complete corpus.
- Beyond the digest-pinned Node/Debian base, the production image contains only MozJPEG, OxiPNG, the
  Quantizr wrapper, libwebp, minimal libvips, Sharp, their required runtime libraries, and required
  license/relinking materials.
- pngquant and libimagequant are prohibited from the production image. GPL or AGPL in the
  application/Node/custom-native graph fails the license gate; digest-pinned Debian base packages are
  separately inventoried with their distro notices and source-retrieval obligations.
- A larger output is never stored or returned. `NO_SIZE_REDUCTION` is the successful `original-retained` outcome.
- Lossless PNG/WebP and orientation-1, grayscale, or 4:4:4 JPEG outputs must have identical normalized
  decoded pixels. A perfect subsampled JPEG coefficient transform is verified in the DCT/MCU domain
  because chroma upsampling and rotation do not commute; alpha is independently checked over black,
  white, and checkerboard backgrounds.
- Release gates are: supported-file success at least 99%; zero severe color/orientation/alpha regressions; no more than 1.0 SSIMULACRA2 point below the pinned reference at the compared size tier; no more than 0.1 worse on the pinned Butteraugli scale; at least 90% of the reproduced false-`NO_SIZE_REDUCTION` corpus achieves 5% savings or proves no accepted candidate can; representative median size no more than 5% larger than the authorized iLoveIMG baseline at comparable quality; 12 MP warm JPEG/WebP p95 at most 3 seconds; 12 MP standard PNG p95 at most 8 seconds; ordinary jobs at most 512 MiB peak native memory; active cancellation observed within 1 second.
- Benchmark-only libjxl is pinned to v0.11.2 commit `332feb17d17311c748445f7ee75c4fb55cc38530` and supplies both `ssimulacra2` and `butteraugli_main`; scores from another implementation cannot be mixed into the release series.
- Work in an isolated worktree created with `superpowers:using-git-worktrees` when execution begins. Preserve unrelated user changes.

---

## File Map

### Public contracts and declarative registry

- `packages/tool-contracts/src/tool-job.ts` and `.test.ts` — public transport, lifecycle, error, progress, usage, and result schemas for `tool-job@1`.
- `packages/tool-contracts/src/image-optimize.ts` and `.test.ts` — same-format `image.optimize@1` request and verified-result schemas.
- `packages/tool-contracts/src/index.ts` and `package.json` — retain existing contracts and re-export the two focused modules through explicit subpaths.
- `packages/tool-registry/src/processing.ts` and `.test.ts` — declarative execution, limits, retention, fallback, verifier, and rollout metadata for image compression.
- `packages/tool-registry/src/index.ts` and `package.json` — export the processing manifest without changing existing image presets.

### Internal contracts and pure job policy

- `packages/server-contracts/src/index.ts` and `.test.ts` — D1 row, Queue message, Worker-to-container protocol, engine status, and usage settlement types. Web code must never import this package.
- `packages/server-job/src/state-machine.ts` and `.test.ts` — legal lifecycle transitions and terminal-state protection.
- `packages/server-job/src/resource-estimate.ts` and `.test.ts` — deterministic weighted-unit estimate and resource-class selection.
- `packages/server-job/src/retention.ts` and `.test.ts` — upload/result expiry and deletion decisions.
- `packages/server-job/src/quota.ts` and `.test.ts` — one-active-job and daily-weighted-unit admission.
- `packages/server-job/src/index.ts`, `package.json`, and `tsconfig.json` — focused public exports and package configuration.

### Browser-side remote runtime

- `packages/server-runtime/src/api-client.ts` and `.test.ts` — typed policy/create/upload/status/cancel/delete calls and token-safe error mapping.
- `packages/server-runtime/src/upload.ts` and `.test.ts` — authenticated XHR byte-progress uploads to the fixed Worker job route.
- `packages/server-runtime/src/download.ts` and `.test.ts` — authenticated result fetch, progress, direct download, acknowledgement, and deletion.
- `packages/server-runtime/src/run-image-optimize-batch.ts` and `.test.ts` — one-at-a-time remote batch orchestration with per-item completion and cancellation.
- `packages/server-runtime/src/index.ts`, `package.json`, and `tsconfig.json` — browser-safe package boundary.

### Cloudflare control plane

- `apps/api-worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.local.jsonc`, and `.dev.vars.example` — one Worker for fetch, Queue, and scheduled events.
- `apps/api-worker/migrations/0001_processing_jobs.sql` — account/session/network quota, jobs, usage
  ledger, transactional outbox, and minimal artifact-cleanup tombstones.
- `apps/api-worker/migrations/0002_rollout_control.sql` — circuit, deletion audit, privacy-safe live-cost
  counters, and alert state.
- `apps/api-worker/src/env.ts` — exact bindings and mandatory operational configuration parsing.
- `apps/api-worker/src/index.ts` and `router.ts` — fetch, Queue, scheduled entry points and small URL router.
- `apps/api-worker/src/auth.ts` and `.test.ts` — opaque session IDs, random job tokens, SHA-256 token
  hashes, timing-safe checks, canonical network prefixes, rotating HMAC abuse keys, and raw-IP disposal.
- `apps/api-worker/src/bounded-json.ts` and `.test.ts` — content-encoding rejection and streaming
  16 KiB caps before JSON parsing.
- `apps/api-worker/src/routes/policy.ts` and `.test.ts` — deterministic rollout and honest execution disclosure.
- `apps/api-worker/src/routes/jobs.ts` and `.test.ts` — create, status, cancel, and explicit delete.
- `apps/api-worker/src/routes/uploads.ts` and `.test.ts` — exact-length authenticated streaming upload,
  stored-object verification, outbox creation, and dispatch.
- `apps/api-worker/src/routes/results.ts` and `.test.ts` — authenticated attachment streaming, download acknowledgement, and result deletion.
- `apps/api-worker/src/d1-job-repository.ts` and `.test.ts` — atomic claims, leases, state changes, quota reservation, and exactly-once settlement.
- `apps/api-worker/src/r2-artifacts.ts` and `.test.ts` — opaque keys, metadata checks, stream writes, and explicit deletion.
- `apps/api-worker/src/outbox.ts` and `.test.ts` — reliable D1-to-Queue dispatch.
- `apps/api-worker/src/queue-consumer.ts` and `.test.ts` — duplicate-safe execution, retry classification, streaming, and settlement.
- `apps/api-worker/src/container-client.ts` and `.test.ts` — fixed-slot engine lifecycle and cancellation.
- `apps/api-worker/src/sweeper.ts` and `.test.ts` — five-minute expiry recovery and orphan deletion.
- `apps/api-worker/src/circuit-breaker.ts` and `.test.ts` — D1-backed automatic effective-rollout zero
  on verified health, latency, queue, and deletion thresholds.
- `apps/api-worker/src/operational-alerts.ts` and `.test.ts` — destination-restricted, throttled,
  content-free incident and recovery email.
- `apps/api-worker/src/live-cost.ts` and `.test.ts` — signed-price-model rolling cost accounting including
  Trace Events CPU, Container billing usage, sparse Container/Durable Object tails, and fail-closed
  budget gates.
- `apps/api-worker/src/usage-analytics.ts` and `.test.ts` — identifier-free Analytics Engine coverage
  points plus bounded private Logpush/provider-usage import.
- `apps/api-worker/src/telemetry.ts` and `.test.ts` — allowlisted, privacy-safe structured events.
- `apps/api-worker/test/worker.integration.test.ts` — local D1/R2/Queue integration with a fake engine.

### Portable native image engine

- `apps/image-engine/package.json`, `tsconfig.json`, `Dockerfile`, and `.dockerignore` — Node orchestrator, esbuild outputs, native build stages, and minimal non-root runtime.
- `apps/image-engine/src/server.ts`, `contract.ts`, `config.ts`, and `http/router.ts` — internal HTTP v1 service.
- `apps/image-engine/src/job/job-controller.ts`, `job-runner.ts`, `workspace.ts`, and `resource-monitor.ts` — idempotent lifecycle, detached runner, process-group cancellation, cleanup, and resource enforcement.
- `apps/image-engine/src/pipeline/inspect.ts`, `normalize.ts`, `classify.ts`, `plan.ts`, `optimize.ts`, and `verify.ts` — bounded inspect/normalize/classify/candidate/independent-verification pipeline.
- `apps/image-engine/src/codecs/command.ts`, `jpeg.ts`, `jpeg-coeff-verify.ts`, `png.ts`, and `webp.ts` —
  argument-array native adapters, coefficient-domain JPEG verification, and normalized results.
- `apps/image-engine/src/observability/safe-log.ts` and `.test.ts` — content-free engine logging.
- `apps/image-engine/base-images.lock.json` and `native/sources.lock.json` — digest-pinned base images plus
  audited source repository, exact revision, license, build role, and production inclusion.
- `apps/image-engine/native/build-mozjpeg.sh`, `build-oxipng.sh`, `build-libwebp.sh`, `build-libvips.sh`, `build-jpegli.sh`, and `build-libjxl-metrics.sh` — exact deterministic build entry points.
- `apps/image-engine/native/png-smart/Cargo.toml`, `Cargo.lock`, and `src/main.rs` — Quantizr RGBA-to-indexed-PNG wrapper.
- `apps/image-engine/licenses/policy.json` — production allowlist, LGPL review entry, benchmark-only components, and prohibited licenses.
- `apps/image-engine/licenses/commercial-review.schema.json` and `.example.json` — external immutable
  commercial license/patent review contract; the example never grants approval.

### Web integration

- `apps/web/src/lib/processing-config.ts` and `.test.ts` — API origin, anonymous session ID, policy caching, and server/local selection.
- `apps/web/src/lib/remote-image-archive.ts` and `.test.ts` — bounded incremental ZIP assembly for direct
  multi-result download on desktop and constrained mobile browsers.
- `apps/web/src/lib/legal-policy.ts`, `/privacy`, `/terms`, and `docs/legal/` — reviewed-policy rendering
  and immutable Korean legal-review contract.
- `apps/web/src/components/image-compress-workbench.tsx` and `.module.css` — dedicated same-format compression UI with upload/queue/native phases, immediate per-item download, direct download only, and local fallback.
- `apps/web/src/app/image/compress/page.tsx`, `apps/web/src/components/image-tool-page.tsx`, `apps/web/src/lib/site.ts`, and `.test.ts` — dedicated route wiring and truthful server/deletion copy.
- `apps/web/src/app/page.tsx`, `README.md`, and `docs/architecture.md` — remove global claims that every HereIsIt tool is browser-only while preserving local disclosures for local tools.
- Existing image/PDF workbenches and their tests/smokes — remove every share-sheet branch and use direct download-only labels and behavior site-wide.
- `scripts/generate-web-headers.mjs` and `.test.ts` — generate the exact CSP from the explicit processing API origin.
- `apps/web/public/_headers` — delete this tracked generated artifact; builds recreate it and `.gitignore` excludes it.
- `apps/web/package.json`, `next.config.ts`, and `.gitignore` — add the remote runtime and header generation.
- `scripts/verify-static-export.mjs` — classify `/image/compress` as server-capable and prove it imports neither PDF nor unrelated local image workers.

### Quality, security, deployment, and operations

- `tests/image-corpus/manifest.json` — provenance, SHA-256, dimensions, bit depth, alpha, orientation, profile, animation, and assertions.
- `scripts/create-image-corpus.mjs` — deterministic HereIsIt-owned public fixtures.
- `scripts/benchmark-image-engine.mjs` — codec, quality, size, latency, memory, and weighted-cost runner.
- `scripts/create-live-cost-model.mjs` — canonical strict price/resource model with conservative regional
  egress and steady/bursty/sparse projections.
- `scripts/verify-image-quality.mjs` — fixed release thresholds and metric-version consistency.
- `scripts/record-human-review.mjs` — blinded authorized strategic-fixture review artifact.
- `scripts/verify-image-engine-licenses.mjs` — SBOM/license/patent/production-content gate.
- `scripts/generate-processing-wrangler.mjs` and `.test.ts` — validated staging/production Wrangler config generation without committed account IDs or resource IDs.
- `scripts/resolve-cloudflare-image-digest.mjs`, `read-wrangler-output.mjs`,
  `record-processing-deployment.mjs`, `promote-processing-rollout.mjs`,
  `rollback-processing.mjs`, `rollback-web.mjs`, and `inspect-processing-job.mjs` — immutable deploy
  resolution/provenance, staged admission, independent Worker/Pages rollback, and content-free DLQ
  diagnosis.
- `scripts/create-processing-evidence-bundle.mjs`, `verify-processing-evidence-bundle.mjs`,
  `create-processing-candidate.mjs`, `finalize-processing-candidate.mjs`,
  `create-processing-release-report.mjs`, `create-processing-release-request.mjs`,
  `verify-processing-candidate.mjs`, `verify-processing-release-request.mjs`, and
  `reconcile-restored-processing-db.mjs` — offline-signed private evidence, build-once artifact
  verification, bounded release inputs, and generation-fenced D1 restore recovery.
- `scripts/create-deterministic-tree-archive.mjs` and
  `verify-and-extract-tree-archive.mjs` — portable Pages release assets with archive/tree identity and
  safe rollback extraction.
- `scripts/verify-web-licenses.mjs`, `verify-vulnerability-results.mjs`,
  `apps/web/public/THIRD_PARTY_NOTICES.txt`, and `security/` — Pages/Worker/lockfile SBOM, license, and
  pinned vulnerability gates in addition to the native-image gate.
- `scripts/smoke-image-compress-server.mjs` — real create/upload/process/download/delete smoke.
- `scripts/fuzz-image-engine.mjs` — deterministic mutation, parser-bound, crash, and timeout fuzz smoke for PR and nightly jobs.
- `tests/e2e/image-compression-server.spec.ts` — desktop/mobile remote flow, original-retained, direct download, retry, cancel, and local fallback.
- `tests/e2e/image-workbench.spec.ts` and `tests/e2e/tool-pages.spec.ts` — move compression assertions to the dedicated server suite and keep resize/convert local.
- `.github/workflows/ci.yml` and new `.github/workflows/image-engine.yml` — ordinary PR gates, public
  nightly tests, signed-local-evidence preparation, manual staging, and manual production release gates.
- `docs/deployment.md` and new `docs/runbooks/image-processing.md` — provisioning, budget enablement,
  deletion/tombstone audit, canary, Worker/Pages rollback, D1 Time Travel reconciliation, DLQ, and
  incident steps.

### Task 1: Define `tool-job@1` and `image.optimize@1`

**Files:**
- Create: `packages/tool-contracts/src/tool-job.ts`
- Create: `packages/tool-contracts/src/tool-job.test.ts`
- Create: `packages/tool-contracts/src/image-optimize.ts`
- Create: `packages/tool-contracts/src/image-optimize.test.ts`
- Modify: `packages/tool-contracts/src/index.ts`
- Modify: `packages/tool-contracts/package.json`

**Interfaces:**
- Consumes: Zod 4.4.3 and the repository's existing `ToolErrorPayload` naming conventions.
- Produces:

~~~ts
export const TOOL_JOB_CONTRACT_ID = "tool-job@1" as const;
export const IMAGE_OPTIMIZE_CONTRACT_ID = "image.optimize@1" as const;
export type ToolJobState =
  | "created"
  | "uploading"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
export type ToolJobErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_INPUT"
  | "UNSUPPORTED_FEATURE"
  | "INPUT_LIMIT_EXCEEDED"
  | "PIXEL_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "SERVER_PROCESSING_DISABLED"
  | "LOCAL_FALLBACK_REQUIRED"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_MISMATCH"
  | "QUEUE_UNAVAILABLE"
  | "ENGINE_TIMEOUT"
  | "ENGINE_OOM"
  | "ENGINE_CRASH"
  | "STORAGE_FAILURE"
  | "VERIFICATION_FAILED"
  | "CANCELLED"
  | "EXPIRED";
export interface ToolJobErrorPayload {
  code: ToolJobErrorCode;
  message: string;
  retryable: boolean;
  guidance?: "TRY_BALANCED_PRESET";
}
export type ImageOptimizeWarningCode =
  | "COLOR_PROFILE_NORMALIZED"
  | "SMART_PNG_FELL_BACK_TO_LOSSLESS"
  | "ORIGINAL_RETAINED_UNMODIFIED";
export interface ToolJobUploadDescriptor {
  kind: "worker-stream-put";
  method: "PUT";
  path: `/v1/jobs/${string}/input`;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  expiresAt: string;
}
export type ToolJobCreateResponse =
  | {
      contract: "tool-job@1";
      mode: "upload-required";
      jobId: string;
      upload: ToolJobUploadDescriptor;
      reservedWeightedUnits: number;
    }
  | {
      contract: "tool-job@1";
      mode: "existing-job";
      jobId: string;
      state: Exclude<ToolJobState, "created" | "uploading">;
      reservedWeightedUnits: number;
    };
export interface ToolJobMutationAcknowledgement {
  contract: "tool-job@1";
  jobId: string;
  action: "uploaded" | "cancelled" | "downloaded" | "deleted";
  acknowledged: true;
}
export interface ToolJobErrorResponse {
  contract: "tool-job@1";
  error: ToolJobErrorPayload;
}
export interface ToolJobStatusEnvelope<Phase extends string, Result> {
  contract: "tool-job@1";
  jobId: string;
  state: ToolJobState;
  phase: Phase;
  phaseFraction: number | null;
  sequence: number;
  attempt: number;
  result?: Result;
  error?: ToolJobErrorPayload;
  actualWeightedUnits?: number;
  updatedAt: string;
}
export type ImageOptimizePhase =
  | "uploading"
  | "queued"
  | "validating"
  | "inspecting"
  | "normalizing"
  | "optimizing"
  | "verifying"
  | "preparing-output"
  | "completed";
export type ImageOptimizeResultDescriptor =
  | {
      kind: "download";
      mime: "image/jpeg" | "image/png" | "image/webp";
      byteLength: number;
      width: number;
      height: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ImageOptimizeWarningCode[];
      timing: { queueMs: number; processingMs: number; totalMs: number };
      expiresAt: string;
    }
  | {
      kind: "original-retained";
      reason: "NO_SIZE_REDUCTION";
      testedCandidates: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ["ORIGINAL_RETAINED_UNMODIFIED", ...ImageOptimizeWarningCode[]];
      timing: { queueMs: number; processingMs: number; totalMs: number };
    };
export type ImageOptimizeStatusResponseV1 = ToolJobStatusEnvelope<
  ImageOptimizePhase,
  ImageOptimizeResultDescriptor
>;
export interface ImageOptimizeSpecV1 {
  version: 1;
  mode: "lossless" | "smart";
  preset: "balanced" | "smallest";
  output: "same-format";
  metadata: "strip";
  orientation: "apply";
  colorSpace: "srgb";
  minimumSavingsPercent: number;
}
export interface ImageOptimizeCreateRequestV1 {
  jobContract: "tool-job@1";
  toolContract: "image.optimize@1";
  anonymousSessionId: string;
  clientRequestId: string;
  jobToken: string;
  input: {
    byteLength: number;
    mimeHint: "image/jpeg" | "image/png" | "image/webp";
    width: number;
    height: number;
  };
  spec: ImageOptimizeSpecV1;
}
export interface ImageOptimizePolicyRequestV1 {
  contract: "tool-job@1";
  toolContract: "image.optimize@1";
  anonymousSessionId: string;
}
export interface ImageOptimizePolicyResponseV1 {
  contract: "tool-job@1";
  toolContract: "image.optimize@1";
  execution: "server" | "local";
  reason: "SERVER_PROCESSING_DISABLED" | "LOCAL_FALLBACK_REQUIRED" | null;
  maintainer: boolean;
  disclosure: {
    upload: boolean;
    inputDeletion: "terminal" | "not-uploaded";
    resultDeletion:
      | {
          mode: "server-temporary";
          acknowledged: "immediate-delete-attempt";
          unacknowledgedDueSeconds: 1800;
          applicationSloSeconds: 2100;
          lifecycleExpirationDays: 1;
          exceptionalDelayPossible: true;
        }
      | { mode: "not-uploaded" };
  };
  limits: {
    maxFiles: 20;
    maxBytesPerFile: 31_457_280;
    maxPixelsPerFile: 40_000_000;
  };
}
~~~

- [ ] **Step 1: Write failing public-schema tests**

~~~ts
import { describe, expect, it } from "vitest";
import {
  imageOptimizeCreateRequestSchema,
  imageOptimizeSpecV1Schema,
  imageOptimizeStatusResponseSchema,
} from "./image-optimize";

describe("image.optimize@1", () => {
  it("accepts a same-format smart request without a filename", () => {
    const parsed = imageOptimizeCreateRequestSchema.parse({
      jobContract: "tool-job@1",
      toolContract: "image.optimize@1",
      anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
      clientRequestId: "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe",
      jobToken: "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA",
      input: {
        byteLength: 4_000_000,
        mimeHint: "image/png",
        width: 2000,
        height: 1500,
      },
      spec: {
        version: 1,
        mode: "smart",
        preset: "balanced",
        output: "same-format",
        metadata: "strip",
        orientation: "apply",
        colorSpace: "srgb",
        minimumSavingsPercent: 1,
      },
    });

    expect(parsed.toolContract).toBe("image.optimize@1");
    expect("name" in parsed.input).toBe(false);
  });

  it("rejects HEIC, excessive dimensions, and unknown keys", () => {
    expect(() =>
      imageOptimizeCreateRequestSchema.parse({
        jobContract: "tool-job@1",
        toolContract: "image.optimize@1",
        anonymousSessionId: crypto.randomUUID(),
        clientRequestId: crypto.randomUUID(),
        jobToken: "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA",
        input: {
          byteLength: 31 * 1024 * 1024,
          mimeHint: "image/heic",
          width: 50_000,
          height: 50_000,
          name: "private.heic",
        },
        spec: imageOptimizeSpecV1Schema.parse({
          version: 1,
          mode: "smart",
          preset: "balanced",
          output: "same-format",
          metadata: "strip",
          orientation: "apply",
          colorSpace: "srgb",
          minimumSavingsPercent: 1,
        }),
      }),
    ).toThrow();
  });
});

describe("tool-job@1", () => {
  it("models no-size-reduction as a successful terminal result", () => {
    const parsed = imageOptimizeStatusResponseSchema.parse({
      contract: "tool-job@1",
      jobId: crypto.randomUUID(),
      state: "succeeded",
      phase: "completed",
      phaseFraction: 1,
      sequence: 8,
      attempt: 1,
      result: {
        kind: "original-retained",
        reason: "NO_SIZE_REDUCTION",
        testedCandidates: 3,
        engineBuildId: "engine-test",
        codecBuildId: "mozjpeg-4.1.1",
        warnings: ["ORIGINAL_RETAINED_UNMODIFIED"],
        timing: { queueMs: 10, processingMs: 20, totalMs: 30 },
      },
      actualWeightedUnits: 12_000,
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(parsed.result?.kind).toBe("original-retained");
  });
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test packages/tool-contracts/src/tool-job.test.ts packages/tool-contracts/src/image-optimize.test.ts --run`

Expected: FAIL because both focused modules are missing.

- [ ] **Step 3: Add strict Zod schemas and exported inferred types**

Implement every interface above as a `.strict()` Zod schema. Enforce:

~~~ts
export const IMAGE_OPTIMIZE_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const IMAGE_OPTIMIZE_MAX_PIXELS = 40_000_000;
export const IMAGE_OPTIMIZE_MAX_DIMENSION = 32_768;
export const IMAGE_OPTIMIZE_MAX_FILES = 20;

const imageInputSchema = z
  .object({
    byteLength: z.number().int().min(1).max(IMAGE_OPTIMIZE_MAX_FILE_BYTES),
    mimeHint: z.enum(["image/jpeg", "image/png", "image/webp"]),
    width: z.number().int().min(1).max(IMAGE_OPTIMIZE_MAX_DIMENSION),
    height: z.number().int().min(1).max(IMAGE_OPTIMIZE_MAX_DIMENSION),
  })
  .strict()
  .refine(({ width, height }) => width * height <= IMAGE_OPTIMIZE_MAX_PIXELS, {
    message: "이미지는 4천만 픽셀을 초과할 수 없습니다.",
  });

export const imageOptimizeSpecV1Schema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["lossless", "smart"]),
    preset: z.enum(["balanced", "smallest"]),
    output: z.literal("same-format"),
    metadata: z.literal("strip"),
    orientation: z.literal("apply"),
    colorSpace: z.literal("srgb"),
    minimumSavingsPercent: z.number().int().min(0).max(50).default(1),
  })
  .strict();
~~~

Keep `tool-job.ts` generic: it exports create/upload/mutation/error transport schemas, the status
envelope, and a schema factory that accepts a
tool-specific phase schema and result schema. Put all image MIME, dimension, codec, warning, timing, and
original-retained fields in `image-optimize.ts`. Add strict policy request/response schemas. Use
`z.uuid()` for `anonymousSessionId`,
`clientRequestId`, and `jobId`; validate `jobToken` as exactly 32 bytes of unpadded base64url. Constrain
`phaseFraction` to `0..1`,
`sequence` and `attempt` to non-negative integers, all usage/timing fields to non-negative finite
numbers, and ISO timestamps to offset datetimes. Add a discriminated refinement: `succeeded` requires
an image result, `failed` requires a non-cancellation error, `cancelled` requires error code `CANCELLED`,
`expired` requires error code `EXPIRED`, and non-terminal states expose neither result nor error.
Add `./tool-job` and `./image-optimize` package
exports and re-export both modules from the existing root without moving unrelated contracts.

- [ ] **Step 4: Verify GREEN and package type safety**

Run: `pnpm test packages/tool-contracts/src/tool-job.test.ts packages/tool-contracts/src/image-optimize.test.ts --run && pnpm --filter @hereisit/tool-contracts typecheck`

Expected: PASS; unknown keys and unsupported MIME values are rejected.

- [ ] **Step 5: Commit**

~~~bash
git add packages/tool-contracts
git commit -m "feat: define server image optimization contracts"
~~~

### Task 2: Register the server-capable compression manifest

**Files:**
- Create: `packages/tool-registry/src/processing.ts`
- Create: `packages/tool-registry/src/processing.test.ts`
- Modify: `packages/tool-registry/src/index.ts`
- Modify: `packages/tool-registry/package.json`

**Interfaces:**
- Consumes: `IMAGE_OPTIMIZE_CONTRACT_ID`, `IMAGE_OPTIMIZE_MAX_FILE_BYTES`, `IMAGE_OPTIMIZE_MAX_FILES`, and `IMAGE_OPTIMIZE_MAX_PIXELS`.
- Produces:

~~~ts
export interface ProcessingManifest {
  toolId: "image.compress";
  contractId: "image.optimize@1";
  accepts: readonly ["image/jpeg", "image/png", "image/webp"];
  emits: "same-format";
  locations: readonly ["server-native", "browser"];
  limits: {
    maxFiles: 20;
    maxBytesPerFile: 31_457_280;
    maxPixelsPerFile: 40_000_000;
    maxConcurrentPerAnonymousSession: 1;
  };
  resourceClass: "image-standard-v1";
  retention: {
    uploadDeadlineSeconds: 600;
    resultDeadlineSeconds: 1800;
    sweepSeconds: 300;
    resultDeletionSloSeconds: 2100;
    lifecycleExpirationDays: 1;
    hardMaximum: false;
  };
  verifier: "image.optimize@1";
  safeFallback: "browser.same-format";
  rolloutFlag: "image-compress-server";
}
export const imageCompressionProcessingManifest: ProcessingManifest;
~~~

- [ ] **Step 1: Write the failing declarative-boundary test**

~~~ts
import { describe, expect, it } from "vitest";
import { imageCompressionProcessingManifest } from "./processing";

describe("image compression processing manifest", () => {
  it("declares exact limits, retention, execution, and fallback", () => {
    expect(imageCompressionProcessingManifest).toEqual({
      toolId: "image.compress",
      contractId: "image.optimize@1",
      accepts: ["image/jpeg", "image/png", "image/webp"],
      emits: "same-format",
      locations: ["server-native", "browser"],
      limits: {
        maxFiles: 20,
        maxBytesPerFile: 30 * 1024 * 1024,
        maxPixelsPerFile: 40_000_000,
        maxConcurrentPerAnonymousSession: 1,
      },
      resourceClass: "image-standard-v1",
      retention: {
        uploadDeadlineSeconds: 600,
        resultDeadlineSeconds: 1800,
        sweepSeconds: 300,
        resultDeletionSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        hardMaximum: false,
      },
      verifier: "image.optimize@1",
      safeFallback: "browser.same-format",
      rolloutFlag: "image-compress-server",
    });
  });

  it("contains metadata only", () => {
    const serialized = JSON.stringify(imageCompressionProcessingManifest);
    expect(serialized).not.toMatch(/import\(|function|class|worker|credential|filename/i);
  });
});
~~~

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm test packages/tool-registry/src/processing.test.ts --run`

Expected: FAIL because `processing.ts` does not exist.

- [ ] **Step 3: Add the frozen manifest**

~~~ts
import {
  IMAGE_OPTIMIZE_CONTRACT_ID,
  IMAGE_OPTIMIZE_MAX_FILE_BYTES,
  IMAGE_OPTIMIZE_MAX_FILES,
  IMAGE_OPTIMIZE_MAX_PIXELS,
} from "@hereisit/tool-contracts/image-optimize";

export const imageCompressionProcessingManifest = Object.freeze({
  toolId: "image.compress",
  contractId: IMAGE_OPTIMIZE_CONTRACT_ID,
  accepts: Object.freeze(["image/jpeg", "image/png", "image/webp"] as const),
  emits: "same-format",
  locations: Object.freeze(["server-native", "browser"] as const),
  limits: Object.freeze({
    maxFiles: IMAGE_OPTIMIZE_MAX_FILES,
    maxBytesPerFile: IMAGE_OPTIMIZE_MAX_FILE_BYTES,
    maxPixelsPerFile: IMAGE_OPTIMIZE_MAX_PIXELS,
    maxConcurrentPerAnonymousSession: 1,
  }),
  resourceClass: "image-standard-v1",
  retention: Object.freeze({
    uploadDeadlineSeconds: 600,
    resultDeadlineSeconds: 1800,
    sweepSeconds: 300,
    resultDeletionSloSeconds: 2100,
    lifecycleExpirationDays: 1,
    hardMaximum: false,
  }),
  verifier: IMAGE_OPTIMIZE_CONTRACT_ID,
  safeFallback: "browser.same-format",
  rolloutFlag: "image-compress-server",
} as const satisfies ProcessingManifest);
~~~

Export it from `@hereisit/tool-registry/processing` and the root package. Do not change the existing `balanced` browser preset in this task.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm test packages/tool-registry/src/processing.test.ts --run && pnpm --filter @hereisit/tool-registry typecheck`

Expected: PASS with no executable value in the serialized manifest.

~~~bash
git add packages/tool-registry
git commit -m "feat: register image compression processing policy"
~~~

### Task 3: Add internal server contracts and pure job policy

**Files:**
- Create: `packages/server-contracts/package.json`
- Create: `packages/server-contracts/tsconfig.json`
- Create: `packages/server-contracts/src/index.ts`
- Create: `packages/server-contracts/src/index.test.ts`
- Create: `packages/server-job/package.json`
- Create: `packages/server-job/tsconfig.json`
- Create: `packages/server-job/src/state-machine.ts`
- Create: `packages/server-job/src/state-machine.test.ts`
- Create: `packages/server-job/src/resource-estimate.ts`
- Create: `packages/server-job/src/resource-estimate.test.ts`
- Create: `packages/server-job/src/retention.ts`
- Create: `packages/server-job/src/retention.test.ts`
- Create: `packages/server-job/src/quota.ts`
- Create: `packages/server-job/src/quota.test.ts`
- Create: `packages/server-job/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: parsed `ImageOptimizeCreateRequestV1`, `ImageOptimizeSpecV1`, and public job states.
- Produces:

~~~ts
export interface ImageJobMessage {
  jobId: string;
  contractId: "image.optimize@1";
  specHash: string;
  inputKey: string;
  inputEtag: string;
  outputKey: string;
  resourceClass: "image-standard-v1" | "image-large-v1";
  attempt: 1 | 2 | 3;
  queueEpoch: string;
  queueGeneration: number;
}
export interface EngineCreateJobRequest {
  protocol: 1;
  jobId: string;
  attempt: 1 | 2 | 3;
  tool: "image.optimize";
  toolVersion: 1;
  spec: ImageOptimizeSpecV1;
  specHash: string;
  input: {
    byteLength: number;
    etag: string;
    mimeHint: "image/jpeg" | "image/png" | "image/webp";
  };
  resourceClass: "image-standard-v1" | "image-large-v1";
}
export type EngineState =
  | "created"
  | "uploading"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type EnginePhase =
  | "validating"
  | "inspecting"
  | "normalizing"
  | "optimizing"
  | "verifying"
  | "preparing-output";
export interface EngineMeasurements {
  processedInputBytes: number;
  processedPixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  peakMemoryBytes: number;
  testedCandidates: number;
  processingMs: number;
}
export interface EngineInspectionSummary {
  verifiedInputMime: "image/jpeg" | "image/png" | "image/webp";
  inputHasAlpha: boolean;
  contentClass: ImageContentClass;
}
export type EngineResult =
  | {
      kind: "download";
      mime: "image/jpeg" | "image/png" | "image/webp";
      byteLength: number;
      width: number;
      height: number;
      testedCandidates: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ImageOptimizeWarningCode[];
    }
  | {
      kind: "original-retained";
      testedCandidates: number;
      engineBuildId: string;
      codecBuildId: string;
      warnings: readonly ["ORIGINAL_RETAINED_UNMODIFIED", ...ImageOptimizeWarningCode[]];
    };
export type EngineJobStatus =
  | {
      protocol: 1;
      jobId: string;
      state: "created" | "uploading" | "ready";
      phase: null;
      fraction: null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "running";
      phase: EnginePhase;
      fraction: number | null;
      sequence: number;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "succeeded";
      phase: "preparing-output";
      fraction: 1;
      sequence: number;
      result: EngineResult;
      inspection: EngineInspectionSummary;
      measurements: EngineMeasurements;
    }
  | {
      protocol: 1;
      jobId: string;
      state: "failed";
      phase: EnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: EngineMeasurements;
      inspection: EngineInspectionSummary | null;
      error: {
        code:
          | "UNSUPPORTED_INPUT"
          | "UNSUPPORTED_FEATURE"
          | "INPUT_LIMIT_EXCEEDED"
          | "PIXEL_LIMIT_EXCEEDED"
          | "RESOURCE_CLASS_UPGRADE"
          | "ENGINE_TIMEOUT"
          | "ENGINE_OOM"
          | "ENGINE_CRASH"
          | "VERIFICATION_FAILED";
        retryable: boolean;
        guidance?: "TRY_BALANCED_PRESET";
      };
    }
  | {
      protocol: 1;
      jobId: string;
      state: "cancelled";
      phase: EnginePhase | null;
      fraction: number | null;
      sequence: number;
      measurements: EngineMeasurements;
      inspection: EngineInspectionSummary | null;
      error: {
        code: "CANCELLED";
        retryable: false;
      };
    };
export interface ResourceEstimate {
  resourceClass: "image-standard-v1";
  reservedWeightedUnits: number;
  inputBytes: number;
  reservationPixelCeiling: 40_000_000;
}
export interface ActualUsageSample {
  inputBytes: number;
  outputBytes: number | null;
  pixels: number;
  cpuMs: number;
  memoryByteMilliseconds: number;
  testedCandidates: number;
  mime: "image/jpeg" | "image/png" | "image/webp";
}
export const PROCESSING_UNIT_COEFFICIENT_VERSION = 1 as const;
export function calculateActualWeightedUnits(sample: ActualUsageSample): number;
export function estimateAttemptReservation(input: {
  inputBytes: number;
  resourceClass: "image-standard-v1" | "image-large-v1";
}): number;
export function transitionJobState(current: ToolJobState, next: ToolJobState): ToolJobState;
export function estimateImageOptimizeUnits(
  request: ImageOptimizeCreateRequestV1,
): ResourceEstimate;
export function decideAdmission(input: {
  accountDailyLimit: number;
  accountReservedToday: number;
  accountSettledToday: number;
  anonymousDailyLimit: number;
  anonymousReservedToday: number;
  anonymousSettledToday: number;
  networkDailyLimit: number;
  networkReservedToday: number;
  networkSettledToday: number;
  activeJobs: number;
  networkPendingJobs: number;
  networkPendingJobLimit: number;
  accountPendingJobs: number;
  accountPendingJobLimit: number;
  oldestQueuedAgeSeconds: number;
  maximumQueuedAgeSeconds: number;
  requestedUnits: number;
}): { allowed: true } | {
  allowed: false;
  code: "SERVER_PROCESSING_DISABLED" | "QUOTA_EXCEEDED" | "QUEUE_UNAVAILABLE";
};
export function retentionDecision(input: {
  state: ToolJobState;
  resultKind: "download" | "original-retained" | null;
  uploadExpiresAt: number;
  resultExpiresAt: number | null;
  terminalRecordExpiresAt: number | null;
  now: number;
  downloadAcknowledgedAt: number | null;
}): {
  deleteInput: boolean;
  deleteOutput: boolean;
  expireJob: boolean;
  deleteRecord: boolean;
};
~~~

- [ ] **Step 1: Write failing transition, estimate, quota, retention, and protocol tests**

~~~ts
expect(transitionJobState("created", "uploading")).toBe("uploading");
expect(transitionJobState("queued", "running")).toBe("running");
expect(transitionJobState("running", "queued")).toBe("queued");
expect(() => transitionJobState("succeeded", "running")).toThrow("terminal");

expect(
  estimateImageOptimizeUnits({
    jobContract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
    clientRequestId: "cf8ae9ec-aaaf-48c6-a657-480e5f85dbfe",
    jobToken: "s0vWWq8hQzU8tX4JjM1tZp9aW3cY6bN2fR7kL5dE1gA",
    input: { byteLength: 1_000_000, mimeHint: "image/jpeg", width: 4000, height: 3000 },
    spec: {
      version: 1,
      mode: "smart",
      preset: "balanced",
      output: "same-format",
      metadata: "strip",
      orientation: "apply",
      colorSpace: "srgb",
      minimumSavingsPercent: 1,
    },
  }),
).toEqual({
  resourceClass: "image-standard-v1",
  reservedWeightedUnits: 2_439_579_999,
  inputBytes: 1_000_000,
  reservationPixelCeiling: 40_000_000,
});

expect(
  decideAdmission({
    accountDailyLimit: 0,
    accountReservedToday: 0,
    accountSettledToday: 0,
    anonymousDailyLimit: 100,
    anonymousReservedToday: 0,
    anonymousSettledToday: 0,
    networkDailyLimit: 300,
    networkReservedToday: 0,
    networkSettledToday: 0,
    activeJobs: 0,
    networkPendingJobs: 0,
    networkPendingJobLimit: 3,
    accountPendingJobs: 0,
    accountPendingJobLimit: 10,
    oldestQueuedAgeSeconds: 0,
    maximumQueuedAgeSeconds: 600,
    requestedUnits: 1,
  }),
).toEqual({ allowed: false, code: "SERVER_PROCESSING_DISABLED" });

expect(
  decideAdmission({
    ...otherwiseAllowedAdmission,
    networkPendingJobs: 3,
    networkPendingJobLimit: 3,
  }),
).toEqual({ allowed: false, code: "QUOTA_EXCEEDED" });

expect(
  decideAdmission({
    ...otherwiseAllowedAdmission,
    networkReservedToday: 2_999,
    networkSettledToday: 0,
    networkDailyLimit: 3_000,
    requestedUnits: 2,
  }),
).toEqual({ allowed: false, code: "QUOTA_EXCEEDED" });

expect(
  decideAdmission({
    accountDailyLimit: 1000,
    accountReservedToday: 0,
    accountSettledToday: 0,
    anonymousDailyLimit: 1000,
    anonymousReservedToday: 0,
    anonymousSettledToday: 0,
    networkDailyLimit: 3000,
    networkReservedToday: 0,
    networkSettledToday: 0,
    activeJobs: 0,
    networkPendingJobs: 0,
    networkPendingJobLimit: 3,
    accountPendingJobs: 10,
    accountPendingJobLimit: 10,
    oldestQueuedAgeSeconds: 601,
    maximumQueuedAgeSeconds: 600,
    requestedUnits: 1,
  }),
).toEqual({ allowed: false, code: "QUEUE_UNAVAILABLE" });

expect(
  calculateActualWeightedUnits({
    inputBytes: 1_000_000,
    outputBytes: 600_000,
    pixels: 12_000_000,
    cpuMs: 1000,
    memoryByteMilliseconds: 512 * 1024 * 1024 * 1000,
    testedCandidates: 2,
    mime: "image/jpeg",
  }),
).toBe(97_112_000);
expect(
  estimateAttemptReservation({
    inputBytes: 1_000_000,
    resourceClass: "image-large-v1",
  }),
).toBe(4_031_739_999);

expect(
  retentionDecision({
    state: "succeeded",
    resultKind: "download",
    uploadExpiresAt: 1_000,
    resultExpiresAt: 2_000,
    terminalRecordExpiresAt: 86_400_000,
    now: 1_500,
    downloadAcknowledgedAt: 1_400,
  }),
).toEqual({
  deleteInput: true,
  deleteOutput: true,
  expireJob: false,
  deleteRecord: false,
});
~~~

Validate `EngineCreateJobRequest`, `EngineJobStatus`, and `ImageJobMessage` with strict Zod schemas; reject
filenames, URL fields, token fields, resource classes outside `image-standard-v1|image-large-v1`, attempt
`0`, attempt `4`, and phase sequences that are negative or non-integral. On success require
`result.testedCandidates === measurements.testedCandidates`; on failure require all measurements even
when their value is zero.

- [ ] **Step 2: Run the new package tests and verify RED**

Run: `pnpm test packages/server-contracts/src/index.test.ts packages/server-job/src/*.test.ts --run`

Expected: FAIL because both packages are absent.

- [ ] **Step 3: Implement exact state, unit, quota, and expiry rules**

Use this state graph:

~~~ts
const legalTransitions: Readonly<Record<ToolJobState, ReadonlySet<ToolJobState>>> = {
  created: new Set(["uploading", "cancelled", "expired"]),
  uploading: new Set(["queued", "cancelled", "failed", "expired"]),
  queued: new Set(["running", "cancelled", "failed", "expired"]),
  running: new Set(["queued", "succeeded", "failed", "cancelled", "expired"]),
  succeeded: new Set(["expired"]),
  failed: new Set(["expired"]),
  cancelled: new Set(["expired"]),
  expired: new Set(),
};
~~~

The browser's width, height, and MIME are untrusted hints and must never make an account-spend
reservation smaller. Reserve a conservative maximum for each admitted native attempt:

~~~ts
const contentCoefficient = {
  "image/jpeg": 2,
  "image/png": 3,
  "image/webp": 2,
} as const;

const attemptCaps = {
  "image-standard-v1": {
    cpuMs: 45_000,
    wallMs: 60_000,
    memoryDeltaMiB: 768,
    testedCandidates: 3,
  },
  "image-large-v1": {
    cpuMs: 75_000,
    wallMs: 90_000,
    memoryDeltaMiB: 1536,
    testedCandidates: 3,
  },
} as const;
const CONTROL_PLANE_BUDGET_UNITS = 20_000_000;

reservedWeightedUnits =
  inputBytes +
  Math.max(0, inputBytes - 1) +
  IMAGE_OPTIMIZE_MAX_PIXELS * Math.max(...Object.values(contentCoefficient)) +
  caps.cpuMs * 50_000 +
  caps.memoryDeltaMiB * caps.wallMs +
  caps.testedCandidates * 500_000 +
  CONTROL_PLANE_BUDGET_UNITS;
~~~

This bound uses the exact upload byte count, the 40 MP hard limit, worst supported format coefficient,
resource CPU/wall/memory ceilings, the smaller-output invariant, and three candidates. Therefore measured
usage for one attempt cannot exceed its reservation even when a hostile client lies about dimensions or
MIME. Every same-class infrastructure retry reserves another standard attempt maximum; the qualifying
working-set/OOM upgrade reserves one full large-attempt maximum in the same atomic retry transaction. A retry is denied
before enqueue if account, anonymous-session, or network quota cannot cover that additional maximum.
The Worker rejects an engine measurement outside these caps as `VERIFICATION_FAILED` and opens the
circuit; a bomb/header rejection records only actually processed bounded pixels, never an attacker-
declared dimension.

Actual v1 units are computed only in the Worker:

~~~ts
actualWeightedUnits =
  inputBytes +
  (outputBytes ?? 0) +
  pixels * contentCoefficient[mime] +
  cpuMs * 50_000 +
  Math.ceil(memoryByteMilliseconds / (1024 * 1024)) +
  testedCandidates * 500_000 +
  CONTROL_PLANE_BUDGET_UNITS;
~~~

The fixed control-plane budget conservatively covers the bounded create/upload/Queue/DO polling/status/
download/delete request envelope. Adaptive polling plus network, per-job read, and result-start rate
limits must keep one job below that envelope; the release cost lab converts the same maximum operations
to current Cloudflare prices. Requests rejected before job authentication remain bounded by the
dedicated edge Rate Limit bindings and account billing alert.

The engine never receives monetary coefficients and never returns weighted units. It returns raw
measurements so a future coefficient version can change without rebuilding the portable engine.
For a retried job, `inputBytes`, decoded `pixels`, CPU, memory-byte-milliseconds, and tested candidates
are cumulative across native attempts; `outputBytes` is the final accepted output or zero. Persist each
failed attempt's raw measurements before requeue so final settlement reflects retry cost.
All accepted attempts settle at least `FAILED_ATTEMPT_MINIMUM_UNITS = 2_000_000`; attempts with engine
measurements settle the larger measured amount. Infrastructure failure, timeout, crash, cancellation, or
storage failure releases only the unused reservation and still adds its measured/floor platform cost to
account, anonymous-session, and rotating network settled totals. This prevents repeated failures or
session rotation from becoming free compute.
Pre-upload cancellation and expiry settle only the fixed request/operation floor. The usage ledger keeps
the public outcome separately from the charged platform units.

Admission is denied when any account/anonymous/network daily limit is non-positive,
`activeJobs >= 1`, `networkPendingJobs >= networkPendingJobLimit`,
`accountPendingJobs >= accountPendingJobLimit`, `oldestQueuedAgeSeconds > maximumQueuedAgeSeconds`, or
reserved plus settled plus requested units exceed the account, anonymous-session, or rotating-network
limit. The one working-set/OOM escalation changes only
the internal resource class and reserves one full large-attempt maximum exactly once. Upload expiry applies
only to `created|uploading`; once upload completion queues the job, the historical upload deadline cannot expire a queued,
running, or succeeded job. Result deletion applies only to a succeeded download result and is true after
download acknowledgement or at `resultExpiresAt`. Input deletion is true for every terminal state or an
expired incomplete upload. `expireJob` follows the deadline applicable to the current state and
result kind; a succeeded original-retained job has no output deadline and becomes expired only after its
terminal record-retention deadline. `deleteRecord` becomes true only when
`terminalRecordExpiresAt <= now` and both object-deletion decisions are already satisfied; the sweeper
then removes the job, ledger, and quarantine row while daily aggregate usage remains.

- [ ] **Step 4: Verify GREEN and workspace typing**

Run: `pnpm install && pnpm test packages/server-contracts/src/index.test.ts packages/server-job/src/*.test.ts --run && pnpm --filter @hereisit/server-contracts typecheck && pnpm --filter @hereisit/server-job typecheck`

Expected: PASS; all internal schemas reject secret or filename fields.

- [ ] **Step 5: Commit**

~~~bash
git add packages/server-contracts packages/server-job pnpm-lock.yaml
git commit -m "feat: add pure server job policy"
~~~

### Task 4: Scaffold the Cloudflare Worker, migration, and rollout policy

**Files:**
- Create: `apps/api-worker/package.json`
- Create: `apps/api-worker/tsconfig.json`
- Create: `apps/api-worker/vitest.config.ts`
- Create: `apps/api-worker/wrangler.local.jsonc`
- Create: `apps/api-worker/.dev.vars.example`
- Create: `apps/api-worker/migrations/0001_processing_jobs.sql`
- Create: `apps/api-worker/src/worker-configuration.d.ts` (generated)
- Create: `apps/api-worker/src/env.ts`
- Create: `apps/api-worker/src/index.ts`
- Create: `apps/api-worker/src/router.ts`
- Create: `apps/api-worker/src/auth.ts`
- Create: `apps/api-worker/src/auth.test.ts`
- Create: `apps/api-worker/src/bounded-json.ts`
- Create: `apps/api-worker/src/bounded-json.test.ts`
- Create: `apps/api-worker/src/routes/policy.ts`
- Create: `apps/api-worker/src/routes/policy.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ProcessingManifest`, `decideAdmission()`, Cloudflare `D1Database`, `R2Bucket`,
  `Queue<ImageJobMessage>`, `DurableObjectNamespace`, and `RateLimit`.
- Produces:

~~~ts
// This is the end-state non-secret shape generated as `Cloudflare.Env` by
// `wrangler types`; do not hand-maintain a second binding list in source.
export interface WranglerGeneratedEnv {
  DB: D1Database;
  JOB_OBJECTS: R2Bucket;
  USAGE_LOGS: R2Bucket;
  IMAGE_JOBS: Queue<ImageJobMessage>;
  IMAGE_ENGINE: DurableObjectNamespace;
  SESSION_JOB_RATE_LIMITER: RateLimit;
  NETWORK_JOB_RATE_LIMITER: RateLimit;
  POLICY_RATE_LIMITER: RateLimit;
  JOB_API_NETWORK_RATE_LIMITER: RateLimit;
  JOB_READ_RATE_LIMITER: RateLimit;
  RESULT_DOWNLOAD_RATE_LIMITER: RateLimit;
  USAGE_ANALYTICS: AnalyticsEngineDataset;
  WORKER_VERSION: WorkerVersionMetadata;
  ALERT_EMAIL: SendEmail;
  ENVIRONMENT: "local" | "staging" | "production";
  CLOUDFLARE_ACCOUNT_ID: string;
  APP_ORIGINS: string;
  R2_BUCKET_NAME: string;
  USAGE_LOG_BUCKET_NAME: string;
  USAGE_ANALYTICS_DATASET_NAME: string;
  ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: string;
  ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: string;
  NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: string;
  ACCOUNT_PENDING_JOB_LIMIT: string;
  NETWORK_PENDING_JOB_LIMIT: string;
  MAX_QUEUED_AGE_SECONDS: string;
  MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: string;
  MAX_LIVE_P95_WEIGHTED_UNITS: string;
  MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: string;
  MAX_LIVE_COST_PER_1000_MICROUSD: string;
  MAX_PROJECTED_MONTHLY_COST_MICROUSD: string;
  LIVE_COST_MODEL_JSON: string;
  LIVE_COST_MODEL_SHA256: string;
  PROVIDER_USAGE_SCHEMA_SHA256: string;
  RELEASE_REPORT_SHA256: string;
  IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: string;
  MAINTAINER_SESSION_HASHES: string;
  ENGINE_INSTANCE_NAME: "image-slot-0";
  ENGINE_IMAGE_DIGEST: string;
  IMAGE_JOBS_QUEUE_NAME: string;
  IMAGE_JOBS_DLQ_NAME: string;
}
// Wrangler config intentionally cannot serialize the encrypted value.
export type Env = Cloudflare.Env & {
  readonly ABUSE_HMAC_SECRET_CURRENT: string;
  readonly ABUSE_HMAC_SECRET_PREVIOUS: string;
  readonly ANALYTICS_READ_TOKEN: string;
  readonly LOGPUSH_STATUS_TOKEN: string;
};
export interface LiveCostModelV1 {
  version: 1;
  containerVcpuSecondMicrousd: number;
  containerGibSecondMicrousd: number;
  containerDiskGbSecondMicrousd: number;
  containerEgressGbMicrousd: number;
  containerEgressRegionPricesMicrousd: Readonly<Record<string, number>>;
  containerEgressRegionPricesSha256: string;
  containerInstanceVcpu: number;
  containerInstanceMemoryGib: number;
  containerInstanceDiskGb: number;
  containerSleepAfterSeconds: 60;
  workersMillionRequestsMicrousd: number;
  workersMillionCpuMsMicrousd: number;
  durableObjectMillionRequestsMicrousd: number;
  durableObjectGibSecondMicrousd: number;
  durableObjectStorageGbMonthMicrousd: number;
  r2StorageGbMonthMicrousd: number;
  r2ClassAMillionMicrousd: number;
  r2ClassBMillionMicrousd: number;
  queueMillionOperationsMicrousd: number;
  d1MillionRowsReadMicrousd: number;
  d1MillionRowsWrittenMicrousd: number;
  d1StorageGbMonthMicrousd: number;
  observabilityMillionLogEventsMicrousd: number;
  workersLogpushMillionEventsMicrousd: number;
  analyticsEngineMillionDataPointsMicrousd: number;
  analyticsEngineMillionReadQueriesMicrousd: number;
  monthlyFixedMicrousd: number;
  routeCpuBenchmarkSha256: string;
  routeCpuEnvelopeMs: {
    policy: number;
    create: number;
    upload: number;
    read: number;
    result: number;
    maintenance: number;
    queue: number;
  };
  arrivalProjection: {
    algorithm: "arrival-union-tail-v1";
    steadyHourlyJobs: readonly number[];
    burstyHourlyJobs: readonly number[];
    sparseHourlyJobs: readonly number[];
    scenariosSha256: string;
  };
}
export interface OperationalConfig {
  environment: "local" | "staging" | "production";
  appOrigins: readonly URL[];
  accountDailyWeightedUnitLimit: number;
  anonymousDailyWeightedUnitLimit: number;
  networkDailyWeightedUnitLimit: number;
  accountPendingJobLimit: number;
  networkPendingJobLimit: number;
  maximumQueuedAgeSeconds: number;
  maximumLiveMedianOutputRatioBasisPoints: number;
  maximumLiveP95WeightedUnits: number;
  maximumLiveOriginalRetainedRateBasisPoints: number;
  maximumLiveCostPer1000Microusd: number;
  maximumProjectedMonthlyCostMicrousd: number;
  liveCostModel: LiveCostModelV1;
  liveCostModelSha256: string;
  providerUsageSchemaSha256: string;
  releaseReportSha256: string;
  rolloutPercent: number;
  maintainerSessionHashes: ReadonlySet<string>;
  engineInstanceName: "image-slot-0";
  engineImageDigest: string;
}
export function parseOperationalConfig(env: Env): OperationalConfig;
export function hashAnonymousSessionId(sessionId: string): Promise<string>;
export function hashJobToken(token: string): Promise<string>;
export function jobTokenMatches(token: string, expectedHash: string): Promise<boolean>;
export function hashNetworkBuckets(input: {
  ip: string;
  utcDay: string;
  currentSecret: string;
  previousSecret: string;
}): Promise<{
  writeHash: string;
  dailyQuotaHashes: readonly string[];
  pendingHashes: readonly string[];
}>;
export function sessionRolloutBucket(sessionId: string): Promise<number>;
export function readBoundedJson(
  request: Request,
  maximumBytes?: number,
): Promise<unknown>;
~~~

- [ ] **Step 1: Write failing configuration, auth, and policy tests**

~~~ts
it("keeps production processing disabled when the budget is absent", () => {
  expect(
    parseOperationalConfig({
      ...fakeBindings,
      ENVIRONMENT: "production",
      APP_ORIGINS: '["https://hereisit.pages.dev"]',
      ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: "",
      ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: "1000000",
      NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: "3000000",
      ACCOUNT_PENDING_JOB_LIMIT: "10",
      NETWORK_PENDING_JOB_LIMIT: "3",
      MAX_QUEUED_AGE_SECONDS: "600",
      MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: "10000",
      MAX_LIVE_P95_WEIGHTED_UNITS: "1000000000",
      MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: "10000",
      MAX_LIVE_COST_PER_1000_MICROUSD: "1000000000",
      MAX_PROJECTED_MONTHLY_COST_MICROUSD: "1000000000",
      LIVE_COST_MODEL_JSON: JSON.stringify(validLiveCostModel),
      LIVE_COST_MODEL_SHA256: "a".repeat(64),
      RELEASE_REPORT_SHA256: "b".repeat(64),
      IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "100",
      MAINTAINER_SESSION_HASHES: "[]",
      ENGINE_INSTANCE_NAME: "image-slot-0",
      ENGINE_IMAGE_DIGEST: "local-dockerfile",
    }),
  ).toMatchObject({ accountDailyWeightedUnitLimit: 0 });
});

it("returns one deterministic execution policy per session", async () => {
  const request = new Request(
    "https://api.example/v1/policy",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract: "tool-job@1",
        toolContract: "image.optimize@1",
        anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
      }),
    },
  );
  const response = await getPolicy(request, {
    rolloutPercent: 100,
    accountDailyWeightedUnitLimit: 10_000_000,
    anonymousDailyWeightedUnitLimit: 1_000_000,
    networkDailyWeightedUnitLimit: 3_000_000,
  });
  await expect(response.json()).resolves.toMatchObject({
    execution: "server",
    disclosure: {
      inputDeletion: "terminal",
      resultDeletion: {
        mode: "server-temporary",
        acknowledged: "immediate-delete-attempt",
        unacknowledgedDueSeconds: 1800,
        applicationSloSeconds: 2100,
        lifecycleExpirationDays: 1,
        exceptionalDelayPossible: true,
      },
    },
  });
});
~~~

Also prove a valid 32-byte base64url token hashes to SHA-256, equal hashes compare timing-safely, malformed
tokens are rejected before D1 access, and telemetry helpers never receive the raw token. Token generation
belongs to the browser runtime in Task 8 so a lost create response can be retried idempotently.
Table-test IPv4 `/24` and compressed/expanded IPv6 `/56` canonicalization, current/previous UTC-day plus
current/previous secret overlap, deduplication when both secrets match, determinism, secret rejection,
and immediate raw-value disposal. `writeHash` uses current-secret/current-day;
`dailyQuotaHashes` covers both secrets for the current day; `pendingHashes` covers both secrets across
current and previous days. The only stored value is a 64-character lowercase write hash; neither IP nor
canonical prefix may reach a repository or logger.

`bounded-json.test.ts` sends oversized declared, oversized chunked, compressed, malformed, and valid JSON
bodies. Route tests prove the network Rate Limit binding runs before the helper.
`readBoundedJson()` rejects a non-identity `Content-Encoding`, validates `Content-Length` when present,
otherwise stream-counts at most 16 KiB, and never calls `request.json()` or `arrayBuffer()`.
Also reject malformed JSON arrays, duplicate origins/hashes, origin entries containing credentials,
paths, queries, or fragments, any maintainer hash that is not 64 lowercase hexadecimal characters, and
any production origin that is not HTTPS. A non-zero server rollout also fails closed when either live
cost ceiling is absent/non-positive, `LIVE_COST_MODEL_JSON` has an unknown/missing coefficient, or the
signed model hash differs from the release config. Its three arrival arrays must each contain exactly 24
bounded non-negative hourly job counts, use only `arrival-union-tail-v1`, and recompute to
`scenariosSha256`; runtime projections and offline gates use those same arrays.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test apps/api-worker/src/auth.test.ts apps/api-worker/src/bounded-json.test.ts apps/api-worker/src/routes/policy.test.ts --run`

Expected: FAIL because the Worker app is absent.

- [ ] **Step 3: Add package and local Worker configuration**

Use:

~~~json
{
  "name": "@hereisit/api-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev -c wrangler.local.jsonc --persist-to .wrangler/state",
    "build": "wrangler deploy -c wrangler.local.jsonc --dry-run --outdir dist",
    "typecheck": "tsc --noEmit",
    "test:integration": "vitest run -c vitest.config.ts",
    "types": "wrangler types -c wrangler.local.jsonc src/worker-configuration.d.ts --strict-vars=false",
    "types:check": "wrangler types -c wrangler.local.jsonc src/worker-configuration.d.ts --strict-vars=false --check"
  },
  "dependencies": {
    "@cloudflare/containers": "0.3.7",
    "@hereisit/server-contracts": "workspace:*",
    "@hereisit/server-job": "workspace:*",
    "@hereisit/tool-contracts": "workspace:*",
    "@hereisit/tool-registry": "workspace:*",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.18.5",
    "typescript": "6.0.3",
    "vitest": "4.1.10",
    "wrangler": "4.110.0"
  }
}
~~~

`wrangler.local.jsonc` initially contains the Worker entry, local R2, a deterministic local D1 ID
`00000000-0000-0000-0000-000000000001`, a session Rate Limiting binding with namespace ID `1001`,
limit `20`/60 seconds, and a create-network binding with namespace ID `1002`, limit `10`/60 seconds.
Add a per-job read binding `1003` at `90`/60, result-start binding `1004` at `3`/60, pre-parse policy
network binding `1005` at `60`/60, and pre-D1 job-API network binding `1006` at `180`/60. The latter
covers upload, status, result, cancel, acknowledgement, and delete even when an attacker rotates random
job IDs.
Queue, cron, Durable Object, Container, the local `USAGE_ANALYTICS` dataset, and the private
`USAGE_LOGS` R2 binding are added by the tasks
that implement those handlers, so every intermediate dry build is valid. Local vars allow
`http://127.0.0.1:3000,http://127.0.0.1:4173,http://localhost:4173`, set rollout to `100`, account units
to `80000000000`, anonymous units to `8000000000`, pending jobs to `10`, maximum queued age to `600`,
network units to `24000000000`, network pending jobs to `3`,
live output-ratio ceiling
to `10000` basis points, live p95 units to `1000000000`, live original-retained ceiling to `10000`
basis points, live cost-per-1,000 and projected-month ceilings to explicit high test values, and
`LIVE_COST_MODEL_JSON` to a strict synthetic v1 model with every monetary coefficient explicitly
present, plus exact synthetic model/provider-usage-schema/release-report SHA-256 values. No
staging/production coefficient or hash has a fallback or inferred default. Set maintainer hashes to an
empty JSON array, `ENGINE_IMAGE_DIGEST` to `local-dockerfile`, Queue/DLQ names to their local
deterministic names. Every environment uses the authenticated Worker streaming upload route.
`APP_ORIGINS` and `MAINTAINER_SESSION_HASHES` are JSON arrays, not comma-split strings.

Configure `vitest.config.ts` with the Cloudflare pool and
`test.include = ["test/**/*.test.ts"]`; ordinary `src/**/*.test.ts` files continue to run in the root
Vitest process. After every Wrangler binding change, run
`pnpm --filter @hereisit/api-worker types` and commit the regenerated
`src/worker-configuration.d.ts`. `src/env.ts` imports that generated `Cloudflare.Env` shape and adds only
parsed runtime configuration types, never a handwritten duplicate binding list.
`.dev.vars.example` documents non-working `ABUSE_HMAC_SECRET_CURRENT` and
`ABUSE_HMAC_SECRET_PREVIOUS` placeholders and their 32-byte base64url format plus a non-working
account-scoped, read-only `ANALYTICS_READ_TOKEN`; the real local `.dev.vars`
and a non-working `LOGPUSH_STATUS_TOKEN` placeholder remain ignored. Missing/malformed abuse secrets make
policy return local and job mutations fail closed; Task 18 treats either provider token as incomplete
cost accounting before public admission. No browser-facing R2 credential exists in local, staging, or
production configuration.

The initial Worker default export is:

~~~ts
export default {
  fetch: routeRequest,
} satisfies ExportedHandler<Env>;
~~~

- [ ] **Step 4: Add the complete initial D1 schema**

~~~sql
PRAGMA foreign_keys = ON;

CREATE TABLE account_usage (
  day_key TEXT PRIMARY KEY,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  pending_jobs INTEGER NOT NULL DEFAULT 0 CHECK (pending_jobs >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE anonymous_usage (
  session_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  active_jobs INTEGER NOT NULL DEFAULT 0 CHECK (active_jobs BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_hash, day_key)
);

CREATE TABLE network_usage (
  network_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units INTEGER NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  pending_jobs INTEGER NOT NULL DEFAULT 0 CHECK (pending_jobs >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (network_hash, day_key)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  network_hash TEXT,
  network_hash_expires_at INTEGER,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  phase_fraction REAL,
  phase_sequence INTEGER NOT NULL DEFAULT 0,
  contract_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,
  declared_mime TEXT NOT NULL,
  declared_width INTEGER NOT NULL,
  declared_height INTEGER NOT NULL,
  verified_input_mime TEXT,
  input_has_alpha INTEGER CHECK (input_has_alpha IN (0, 1)),
  content_class TEXT,
  input_key TEXT NOT NULL UNIQUE,
  input_etag TEXT,
  upload_version INTEGER NOT NULL DEFAULT 0,
  output_key TEXT UNIQUE,
  output_bytes INTEGER,
  output_mime TEXT,
  output_width INTEGER,
  output_height INTEGER,
  result_kind TEXT,
  reserved_units INTEGER NOT NULL,
  actual_units INTEGER,
  unit_coefficient_version INTEGER NOT NULL DEFAULT 1,
  cpu_ms INTEGER,
  memory_byte_milliseconds INTEGER,
  peak_memory_bytes INTEGER,
  processed_input_bytes INTEGER NOT NULL DEFAULT 0,
  processed_pixels INTEGER NOT NULL DEFAULT 0,
  resource_class TEXT NOT NULL,
  settlement_state TEXT NOT NULL DEFAULT 'reserved',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
  queue_epoch TEXT NOT NULL,
  queue_generation INTEGER NOT NULL DEFAULT 1,
  lease_token TEXT,
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  cold_start INTEGER CHECK (cold_start IN (0, 1)),
  container_ready_ms INTEGER,
  upload_expires_at INTEGER NOT NULL,
  processing_deadline_at INTEGER,
  result_expires_at INTEGER,
  terminal_record_expires_at INTEGER,
  download_acknowledged_at INTEGER,
  download_lease_hash TEXT,
  download_lease_expires_at INTEGER,
  engine_build_id TEXT,
  codec_build_id TEXT,
  warnings_json TEXT,
  tested_candidates INTEGER,
  error_code TEXT,
  error_guidance TEXT CHECK (
    error_guidance IS NULL OR error_guidance = 'TRY_BALANCED_PRESET'
  ),
  queued_at INTEGER,
  started_at INTEGER,
  engine_contact_started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_hash, day_key)
    REFERENCES anonymous_usage(session_hash, day_key)
);

CREATE TABLE usage_ledger (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  network_hash TEXT,
  day_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL,
  actual_units INTEGER,
  outcome TEXT,
  settled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE job_outbox (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE maintenance_cursors (
  task TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rollout_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  circuit_open INTEGER NOT NULL DEFAULT 0 CHECK (circuit_open IN (0, 1)),
  reason TEXT,
  opened_at INTEGER,
  cost_accounting_epoch TEXT NOT NULL DEFAULT 'uninitialized'
);
INSERT INTO rollout_control (id) VALUES (1);

CREATE TABLE job_quarantine (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  queue_name TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  inspected_at INTEGER
);

CREATE TABLE artifact_cleanup_tombstones (
  id TEXT PRIMARY KEY,
  input_key TEXT UNIQUE,
  output_key TEXT UNIQUE,
  input_exists INTEGER NOT NULL CHECK (input_exists IN (0, 1)),
  output_exists INTEGER NOT NULL CHECK (output_exists IN (0, 1)),
  first_failed_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);

CREATE INDEX jobs_expiry_idx
  ON jobs(status, upload_expires_at, result_expires_at);
CREATE INDEX jobs_terminal_record_idx
  ON jobs(terminal_record_expires_at);
CREATE INDEX jobs_lease_idx
  ON jobs(status, lease_expires_at);
CREATE INDEX jobs_network_status_idx
  ON jobs(network_hash, status);
CREATE INDEX jobs_network_hash_expiry_idx
  ON jobs(network_hash_expires_at);
CREATE UNIQUE INDEX jobs_client_request_idx
  ON jobs(session_hash, client_request_id);
CREATE INDEX outbox_pending_idx
  ON job_outbox(sent_at, next_attempt_at);
CREATE INDEX cleanup_tombstones_retry_idx
  ON artifact_cleanup_tombstones(next_attempt_at);
~~~

- [ ] **Step 5: Implement deterministic policy disclosure**

`POST /v1/policy` derives the rotating network HMAC and calls `POLICY_RATE_LIMITER` before reading any
body or D1 state. It then uses `readBoundedJson(request, 16_384)` and parses
`ImageOptimizePolicyRequestV1`. A per-isolate two-second cache may retain only the content-free global
circuit/config result, never session/cohort decisions; D1 error, timeout, missing abuse secret, or
malformed body returns an explicit local policy. A high-cardinality random-session flood test proves no
more than 60 requests per network/minute reach JSON parsing or D1. After the global circuit read, a
bounded primary read checks the circuit, account and anonymous-session rows, current
rotating network rows, queue-age/pending state, and quota headroom; an exhausted account/session/network,
three-pending network, or unavailable queue returns local policy without exposing the quota values. The
route returns:

~~~ts
{
  contract: "tool-job@1",
  toolContract: "image.optimize@1",
  maintainer: maintainerSessionHashes.has(sessionHash),
  execution:
    accountDailyWeightedUnitLimit > 0 &&
    anonymousDailyWeightedUnitLimit > 0 &&
    networkDailyWeightedUnitLimit > 0 &&
    circuitClosed &&
    accountQuotaAvailable &&
    anonymousQuotaAvailable &&
    networkQuotaAvailable &&
    queueCapacityAvailable &&
    (maintainerSessionHashes.has(sessionHash) || bucket < rolloutPercent)
      ? "server"
      : "local",
  reason:
    accountDailyWeightedUnitLimit <= 0 ||
    anonymousDailyWeightedUnitLimit <= 0 ||
    networkDailyWeightedUnitLimit <= 0 ||
    !circuitClosed
      ? "SERVER_PROCESSING_DISABLED"
      : !accountQuotaAvailable ||
          !anonymousQuotaAvailable ||
          !networkQuotaAvailable ||
          !queueCapacityAvailable ||
          (!maintainerSessionHashes.has(sessionHash) && bucket >= rolloutPercent)
        ? "LOCAL_FALLBACK_REQUIRED"
        : null,
  disclosure: {
    upload: execution === "server",
    inputDeletion: execution === "server" ? "terminal" : "not-uploaded",
    resultDeletion:
      execution === "server"
        ? {
            mode: "server-temporary",
            acknowledged: "immediate-delete-attempt",
            unacknowledgedDueSeconds: 1800,
            applicationSloSeconds: 2100,
            lifecycleExpirationDays: 1,
            exceptionalDelayPossible: true,
          }
        : { mode: "not-uploaded" },
  },
  limits: imageCompressionProcessingManifest.limits,
}
~~~

Never accept the session ID in a URL query or path; Workers invocation logs can retain request URLs.
Set CORS only for an exact origin parsed from `APP_ORIGINS`, allow `GET, POST, PUT, DELETE, OPTIONS`, allow
`authorization, content-type, x-download-lease`, expose
`content-length, content-type, etag, retry-after, x-download-lease`, and add
`Vary: Origin`. Reject every other Origin with `403`.

- [ ] **Step 6: Verify GREEN, migration, and dry build**

Run:

~~~bash
pnpm install
pnpm --filter @hereisit/api-worker types
pnpm test \
  apps/api-worker/src/auth.test.ts \
  apps/api-worker/src/bounded-json.test.ts \
  apps/api-worker/src/routes/policy.test.ts \
  --run
pnpm --filter @hereisit/api-worker typecheck
pnpm exec wrangler d1 migrations apply hereisit-processing-local \
  -c apps/api-worker/wrangler.local.jsonc --local --persist-to apps/api-worker/.wrangler/state
pnpm --filter @hereisit/api-worker build
~~~

Expected: tests and typecheck PASS; migration applies once; Wrangler dry-run emits the Worker bundle
without deploying.

- [ ] **Step 7: Commit**

~~~bash
git add apps/api-worker pnpm-lock.yaml
git commit -m "feat: scaffold image processing control plane"
~~~

### Task 5: Create jobs, stream exact uploads, and dispatch an outbox

**Files:**
- Create: `apps/api-worker/src/d1-job-repository.ts`
- Create: `apps/api-worker/src/d1-job-repository.test.ts`
- Create: `apps/api-worker/src/r2-artifacts.ts`
- Create: `apps/api-worker/src/r2-artifacts.test.ts`
- Create: `apps/api-worker/src/outbox.ts`
- Create: `apps/api-worker/src/outbox.test.ts`
- Create: `apps/api-worker/src/routes/jobs.ts`
- Create: `apps/api-worker/src/routes/jobs.test.ts`
- Create: `apps/api-worker/src/routes/uploads.ts`
- Create: `apps/api-worker/src/routes/uploads.test.ts`
- Modify: `apps/api-worker/src/router.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Modify: `apps/api-worker/src/worker-configuration.d.ts` (generated)

**Interfaces:**
- Consumes: `estimateImageOptimizeUnits()`, `decideAdmission()`, job-token helpers, D1/R2/Queue bindings, and strict public/internal schemas.
- Produces:

~~~ts
export interface JobRepository {
  reserveAndCreate(input: {
    jobId: string;
    clientRequestId: string;
    tokenHash: string;
    sessionHash: string;
    networkHash: string;
    networkDailyQuotaHashes: readonly string[];
    networkPendingHashes: readonly string[];
    dayKey: string;
    request: ImageOptimizeCreateRequestV1;
    specJson: string;
    specHash: string;
    inputKey: string;
    outputKey: string;
    queueEpoch: string;
    estimate: ResourceEstimate;
    uploadExpiresAt: number;
    now: number;
    accountDailyLimit: number;
    anonymousDailyLimit: number;
    networkDailyLimit: number;
    accountPendingJobLimit: number;
    networkPendingJobLimit: number;
    maximumQueuedAgeSeconds: number;
  }): Promise<
    | "created"
    | "replayed"
    | "quota-exceeded"
    | "active-job-exists"
    | "queue-unavailable"
  >;
  commitStoredInput(input: {
    jobId: string;
    uploadVersion: number;
    inputEtag: string;
    queuePayload: ImageJobMessage;
    now: number;
  }): Promise<
    | { kind: "queued" }
    | {
        kind: "already-queued-same-etag";
        state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
      }
    | {
        kind: "delete-unowned-object";
        reason: "cancelled" | "expired" | "upload-version-changed" | "no-owner";
      }
    | { kind: "conflicting-owned-etag" }
  >;
}
export function createOpaqueObjectKey(
  kind: "inputs" | "outputs",
  randomId: string,
): string;
export async function dispatchPendingOutbox(
  env: Pick<Env, "DB" | "IMAGE_JOBS">,
  now: number,
  limit?: number,
): Promise<number>;
~~~

- [ ] **Step 1: Write failing repository and object-key tests**

Prove one transaction:

~~~ts
await expect(
  repository.reserveAndCreate(validCreate),
).resolves.toBe("created");
await expect(
  repository.reserveAndCreate({ ...validCreate, jobId: crypto.randomUUID() }),
).resolves.toBe("replayed");
await expect(
  repository.reserveAndCreate({
    ...validCreate,
    jobId: crypto.randomUUID(),
    clientRequestId: crypto.randomUUID(),
  }),
).resolves.toBe("active-job-exists");

expect(createOpaqueObjectKey("inputs", "bc4a0d7e")).toBe("inputs/bc4a0d7e");
expect(() => createOpaqueObjectKey("inputs", "../private.jpg")).toThrow();
expect(JSON.stringify(await readStoredJob(jobId))).not.toContain("private.jpg");
~~~

Add cases for exhausted account units, exhausted anonymous units, rollback after a failed insert, a
duplicate create ID, one active job, exhausted network units, three network-pending jobs under different
session IDs, a UTC-midnight attack with three pending under the previous hash, and token hash storage
without token plaintext. Replaying the same
session/client-request ID, canonical request hash, and token hash returns the existing job without
reserving units again; a changed request or token returns `409`. Only `created|uploading` may receive a
refreshed descriptor for the same fixed Worker upload route and create-only object key. A queued, running,
or terminal replay returns `mode: "existing-job"` with no upload descriptor, preventing overwrite of an
input under processing. The reservation
transaction inserts or updates `account_usage`, `anonymous_usage`, and `network_usage`; checks all three
daily ceilings; increments all reserved totals; increments account and network `pending_jobs`; sets
anonymous `active_jobs` to one; creates the job; and creates the usage-ledger row atomically.
Cancellation and upload-expiry settlement decrement all counters exactly once through the same
settlement CAS used by processed jobs.

Do not perform `SELECT` in JavaScript followed by unconditional writes. In one `session.batch()`:

1. `INSERT OR IGNORE` the account, session, and rotating-network day rows;
2. `INSERT INTO jobs (...) SELECT ... FROM account_usage, anonymous_usage, network_usage WHERE` all unit
   ceilings, account pending, the sum across deduplicated current/previous-secret current-day network
   quota aliases, the sum across both secret/day pending aliases below the network ceiling, anonymous
   active count, circuit guard, and client-request uniqueness pass;
3. update account/anonymous/network counters only
   `WHERE EXISTS (SELECT 1 FROM jobs WHERE id = :jobId)`;
4. insert the usage ledger only from that same existence check.

Create `const session = env.DB.withSession("first-primary")`, prepare the whole batch from that session,
and read the job through the same session afterward so D1 read-after-write consistency does not depend on
a replica. After the batch, read the job ID to distinguish created, replayed,
account/anonymous/network denial, queue backpressure, and active-job denial. A concurrent two-create test
must prove only one reservation wins.

- [ ] **Step 2: Write failing exact-length streaming upload tests**

Assert job creation returns no arbitrary origin or header map:

~~~ts
expect(upload).toEqual({
  kind: "worker-stream-put",
  method: "PUT",
  path: `/v1/jobs/${jobId}/input`,
  contentType: "image/png",
  byteLength: 3,
  expiresAt: "2026-07-16T00:10:00.000Z",
});
~~~

The authenticated `PUT /v1/jobs/:jobId/input` tests use bodies whose `arrayBuffer()` throws. Require
`Content-Length` to equal the reserved request byte count and `Content-Type` to equal the declared MIME;
reject a missing/invalid/over-limit length or non-identity `Content-Encoding` before reading, an expired
route, foreign token, short body, extra byte, MIME mismatch, and cross-job object. The successful path
counts every streamed byte, performs
one fixed-length create-only R2 put with bounded opaque storage metadata, verifies the returned head, atomically
changes `uploading → queued` with `attempt = 1`, and inserts one outbox payload.
Add a slow stream that begins just before expiry and crosses the absolute upload deadline; the route must
abort the pipe/R2 put, leave no object or outbox row, and settle the fixed floor exactly once.

Add barriers for cancellation before the R2 put, after the put but before D1 commit, and concurrently
with a response-loss replay. Starting the first accepted PUT CASes `created → uploading` and increments
`upload_version`; retries reuse the current version. `commitStoredInput()` must match
`status = uploading`, that version, null cancellation, and null `input_etag`. The result is
state/ETag-aware: if another identical request already committed the same ETag, return
`already-queued-same-etag` and never delete the shared object; if cancellation/expiry/version change won
and D1 owns no matching ETag, return `delete-unowned-object`; a different D1-owned ETag is an invariant
failure that opens the circuit and is not deleted by the losing request. Every race ends with one owned
input or zero orphan objects and one settlement.

Simulate both response-loss windows before the browser receives `204`. If R2 committed but D1 still says
`uploading`, a replay must never overwrite the object: an existing head with the same key, storage metadata,
size, and MIME completes the idempotent D1/outbox transition. If D1 already stores `input_etag` and the
job is queued, running, or terminal, the authenticated replay returns the same upload acknowledgement
without reading the repeated request body or mutating R2/D1. Any object mismatch deletes the object,
returns `UPLOAD_MISMATCH`, settles the attempt floor once, and never enqueues. The stored opaque ETag
version-fences the Queue consumer.

Add an explicit two-request barrier where both same-version uploads observe the same create-only R2 head
before either D1 commit. One wins `queued`; the loser must receive `already-queued-same-etag`, leave the
object present, reserve/settle only once, and produce exactly one outbox row. Separate cancelled,
expired, upload-version-changed, and different-owned-ETag cases prove only the unowned-object result may
delete.

- [ ] **Step 3: Run all focused tests and verify RED**

Run:

~~~bash
pnpm test \
  apps/api-worker/src/d1-job-repository.test.ts \
  apps/api-worker/src/r2-artifacts.test.ts \
  apps/api-worker/src/outbox.test.ts \
  apps/api-worker/src/routes/jobs.test.ts \
  apps/api-worker/src/routes/uploads.test.ts \
  --run
~~~

Expected: FAIL because the repository, streaming storage, outbox, and routes are missing.

- [ ] **Step 4: Implement canonical request hashing and job creation**

Canonicalize the parsed spec by serializing keys in schema order, then hash with SHA-256. Create:

~~~ts
const jobId = crypto.randomUUID();
const tokenHash = await hashJobToken(parsedRequest.jobToken);
const inputKey = createOpaqueObjectKey("inputs", crypto.randomUUID());
const outputKey = createOpaqueObjectKey("outputs", crypto.randomUUID());
const queueEpoch = crypto.randomUUID();
const estimate = estimateImageOptimizeUnits(parsedRequest);
const uploadExpiresAt = now + 10 * 60_000;
~~~

`POST /v1/jobs` first recomputes the rollout policy and returns
`LOCAL_FALLBACK_REQUIRED` or `SERVER_PROCESSING_DISABLED` before reserving units. On success it returns a
`worker-stream-put` descriptor at `/v1/jobs/:jobId/input` with the parsed MIME, exact byte length, and
ten-minute deadline. It never returns another origin, a caller-controlled URL, or arbitrary headers.
The response has `Cache-Control: no-store` and the logger
receives only job ID, contract ID, byte count, pixel count, resource class, and reserved units.
The server never generates or returns a job token. The browser keeps the client-generated token and can
retry the same `clientRequestId` safely if the create response is lost.

Before reading the JSON body, derive the rotating network HMAC from `CF-Connecting-IP` and apply the
10/minute create-network binding. A missing/invalid IP outside local test mode or missing HMAC secret
fails server processing closed. Then stream-count at most 16 KiB, parse the schema, derive the session
hash, and apply the 20/minute session binding:

~~~ts
const networkBuckets = await hashNetworkBuckets({
  ip: requireConnectingIp(request),
  utcDay: dayKey(now),
  currentSecret: env.ABUSE_HMAC_SECRET_CURRENT,
  previousSecret: env.ABUSE_HMAC_SECRET_PREVIOUS,
});
const networkRate = await env.NETWORK_JOB_RATE_LIMITER.limit({
  key: networkBuckets.writeHash,
});
if (!networkRate.success) return rateLimitedResponse();

const parsedRequest = imageOptimizeCreateRequestSchema.parse(
  await readBoundedJson(request, 16_384),
);
const sessionKey = await hashAnonymousSessionId(parsedRequest.anonymousSessionId);
const sessionRate = await env.SESSION_JOB_RATE_LIMITER.limit({ key: sessionKey });
if (!sessionRate.success) {
  return toolErrorResponse(429, {
    code: "RATE_LIMITED",
    message: "잠시 후 다시 시도해 주세요.",
    retryable: true,
  });
}
~~~

Persist only `networkBuckets.writeHash` and its UTC day in the short-lived abuse ledger; pass the
deduplicated daily/pending alias arrays only to atomic quota predicates. Never persist/log the raw IP
or canonical prefix, and do not log the full session hash. The D1 reservation includes the explicit
network daily units and three-pending ceiling so 10 different session IDs from one source cannot fill all
10 account slots. An advisory read may reject obvious account/network-pending or queue-age overload
early, but the authoritative ceilings remain predicates inside the same D1 reservation batch so
concurrent creates cannot pass a stale read. Extend `wrangler.local.jsonc` with the Queue producer
binding only; the consumer section is added in Task 6.

- [ ] **Step 5: Implement exact-length upload plus transactional outbox**

`PUT /v1/jobs/:jobId/input` is the only upload path in every environment. Apply
`JOB_API_NETWORK_RATE_LIMITER` before D1, authenticate the Bearer job token, then require an allowed
`Origin`, exact declared `Content-Type`, no `Content-Encoding` other than
`identity`, and an integer `Content-Length` equal to the reserved byte count before consuming
`request.body`. Reject absent, chunked, encoded, mismatched, or over-limit requests. After those
content-free checks, a job with a committed `input_etag` returns the idempotent `uploaded`
acknowledgement without consuming a repeated body. Otherwise require `created|uploading` and an unexpired
deadline, then start a create-only R2 put with
`onlyIf: new Headers({ "if-none-match": "*" })`, pipe the request through
`FixedLengthStream(job.declaredBytes)` under an `AbortSignal.timeout()` capped to the absolute remaining
upload deadline, and await both sides so a short, extra, or slow-over-deadline body fails without
buffering. Store:

~~~ts
{
  httpMetadata: { contentType: job.declaredMime },
  customMetadata: {
    kind: "input",
    uploadVersion: String(job.uploadVersion),
  },
}
~~~

If the conditional put returns `null`, read the existing head and accept it only for an idempotent replay
with the same random object key, upload version, exact size, and exact MIME; otherwise delete it and fail
closed. Object keys and custom metadata contain no job ID, session/network identifier, filename, or
caller-supplied value. After a successful
put or accepted replay, verify the same head invariants and persist the binding's opaque `head.etag` as
the immutable input version through `commitStoredInput()`, fenced by the current `upload_version`,
`status = uploading`, and no cancellation. If the fence loses, branch only on the discriminated result:
acknowledge same-ETag queued/running/terminal replay without R2 mutation; delete only
`delete-unowned-object`; fail closed and alert on `conflicting-owned-etag`. Never delete merely because
the update count was zero. Use one `DB.batch()` for
`uploading → queued`, `attempt = 1`,
`queued_at = now`, `processing_deadline_at = now + 20 * 60_000`, and the outbox insert. There is no
second browser completion call. The outbox payload copies the row's random `queue_epoch` and current
`queue_generation`; every retry/recovery reads both rather than manufacturing a message from stale
request state.

Attempt immediate Queue send; mark `sent_at` only after
`IMAGE_JOBS.send(payload, { contentType: "json" })` resolves.
`dispatchPendingOutbox()` retries rows where
`sent_at IS NULL` and `next_attempt_at <= now`, with delays `10s`, `30s`, and `120s`.

- [ ] **Step 6: Verify GREEN and the create-to-Queue boundary**

Run the Task 5 test command again, then:

~~~bash
pnpm --filter @hereisit/api-worker types
pnpm --filter @hereisit/api-worker typecheck
pnpm --filter @hereisit/api-worker build
~~~

Expected: PASS; a simulated send failure leaves one retryable outbox row and a duplicate dispatch sends
an identical idempotent message.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/api-worker/src \
  apps/api-worker/wrangler.local.jsonc
git commit -m "feat: create and upload image processing jobs"
~~~

### Task 6: Claim Queue jobs and stream them through the fixed image-engine slot

**Files:**
- Create: `apps/api-worker/src/container-client.ts`
- Create: `apps/api-worker/src/container-client.test.ts`
- Create: `apps/api-worker/src/pending-container-binding.ts`
- Create: `apps/api-worker/src/queue-consumer.ts`
- Create: `apps/api-worker/src/queue-consumer.test.ts`
- Create: `apps/api-worker/src/telemetry.ts`
- Create: `apps/api-worker/src/telemetry.test.ts`
- Modify: `apps/api-worker/src/d1-job-repository.ts`
- Modify: `apps/api-worker/src/index.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Modify: `apps/api-worker/src/worker-configuration.d.ts` (generated)

**Interfaces:**
- Consumes: `ImageJobMessage`, `EngineCreateJobRequest`, `EngineState`, R2 streams, and D1 job leases.
- Produces:

~~~ts
export interface EngineClient {
  create(request: EngineCreateJobRequest): Promise<{
    coldStart: boolean;
    containerReadyMs: number;
  }>;
  upload(jobId: string, body: ReadableStream, byteLength: number, contentType: string): Promise<void>;
  run(jobId: string): Promise<void>;
  status(jobId: string): Promise<EngineJobStatus>;
  output(jobId: string): Promise<Response>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
}
export interface JobLease {
  jobId: string;
  leaseToken: string;
  attempt: 1 | 2 | 3;
  leaseExpiresAt: number;
}
export function claimQueuedJob(
  db: D1Database,
  jobId: string,
  now: number,
): Promise<JobLease | null>;
export async function consumeImageJob(
  message: ImageJobMessage,
  env: QueueEnv,
  dependencies?: { engine?: EngineClient; now?: () => number },
): Promise<"completed" | "retry-scheduled" | "duplicate">;
~~~

Until Task 11 can point Wrangler at the real Dockerfile, define only this temporary compile-time
extension in `pending-container-binding.ts`:

~~~ts
export type QueueEnv = Env & {
  IMAGE_ENGINE: DurableObjectNamespace;
};
~~~

It contains no resource ID or runtime value. Task 11 adds the real generated binding, changes all
signatures back to `Env`, and deletes this file; its sole purpose is to keep Task 6 independently
typecheckable without an invalid intermediate Container config.

- [ ] **Step 1: Write failing lease and duplicate-delivery tests**

~~~ts
const [first, second] = await Promise.all([
  claimQueuedJob(db, jobId, now),
  claimQueuedJob(db, jobId, now),
]);
expect([first, second].filter(Boolean)).toHaveLength(1);

await expect(consumeImageJob(message, env, { engine: fakeEngine })).resolves.toBe("completed");
await expect(consumeImageJob(message, env, { engine: fakeEngine })).resolves.toBe("duplicate");
expect(fakeEngine.run).toHaveBeenCalledTimes(1);
expect(await env.JOB_OBJECTS.get(inputKey)).toBeNull();
~~~

Cover stale lease recovery, mismatched spec hash/ETag, stale `queueEpoch`/`queueGeneration` pairs after
D1 restore—including a pre-restore future-generation message whose integer collides with the restored
row—
already-terminal jobs, a cancellation request before
engine start, a duplicate message after output storage, and a DLQ delivery that writes only normalized
metadata to `job_quarantine`, terminally releases unused reservation while settling measured/floor
platform units, deletes both objects/workspace, and acknowledges without replay.

- [ ] **Step 2: Write failing streaming and retry-classification tests**

Use streams whose `arrayBuffer()` method throws and assert success, proving the Worker never calls it.
Cover engine timeout, OOM, crash, invalid input, output larger than source, output MIME mismatch, and R2
write failure. Expected behavior:

~~~ts
expect(classifyQueueFailure(new EngineTimeoutError())).toEqual({
  retry: true,
  delaySeconds: 10,
  nextResourceClass: "image-standard-v1",
});
expect(classifyQueueFailure(new CodecCandidateTimeoutError())).toEqual({
  retry: false,
  publicCode: "ENGINE_TIMEOUT",
  publicGuidance: "TRY_BALANCED_PRESET",
});
expect(classifyQueueFailure(new EngineOomError(), { attempt: 1 })).toEqual({
  retry: true,
  delaySeconds: 10,
  nextResourceClass: "image-large-v1",
});
expect(classifyQueueFailure(new ResourceClassUpgradeError(), { attempt: 1 })).toEqual({
  retry: true,
  delaySeconds: 0,
  nextResourceClass: "image-large-v1",
});
expect(classifyQueueFailure(new UnsupportedInputError())).toEqual({
  retry: false,
  publicCode: "UNSUPPORTED_INPUT",
});
~~~

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm test apps/api-worker/src/container-client.test.ts apps/api-worker/src/queue-consumer.test.ts apps/api-worker/src/telemetry.test.ts --run`

Expected: FAIL because the engine client and consumer are absent.

- [ ] **Step 4: Implement the fixed-slot container client**

~~~ts
export class ImageEngineContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  pingEndpoint = "/healthz";
  sleepAfter = "60s";
  enableInternet = false;
}

export function createContainerEngineClient(env: QueueEnv): EngineClient {
  const stub = getContainer(env.IMAGE_ENGINE, env.ENGINE_INSTANCE_NAME);
  return {
    create: async (body) => {
      const before = await stub.getState();
      const startedAt = performance.now();
      await expectOk(await stub.fetch("http://image-engine/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      return {
        coldStart: before.status !== "running" && before.status !== "healthy",
        containerReadyMs: Math.ceil(performance.now() - startedAt),
      };
    },
    upload: async (jobId, body, byteLength, contentType) =>
      expectOk(await stub.fetch(`http://image-engine/v1/jobs/${jobId}/input`, {
        method: "PUT",
        headers: {
          "content-length": String(byteLength),
          "content-type": contentType,
        },
        body,
      })),
    run: async (jobId) =>
      expectOk(await stub.fetch(`http://image-engine/v1/jobs/${jobId}/run`, { method: "POST" })),
    status: async (jobId) =>
      parseEngineStatus(await stub.fetch(`http://image-engine/v1/jobs/${jobId}`)),
    output: async (jobId) =>
      stub.fetch(`http://image-engine/v1/jobs/${jobId}/output`),
    cancel: async (jobId) =>
      expectOk(await stub.fetch(`http://image-engine/v1/jobs/${jobId}`, { method: "DELETE" })),
    remove: async (jobId) =>
      expectOk(await stub.fetch(`http://image-engine/v1/jobs/${jobId}`, { method: "DELETE" })),
  };
}
~~~

Override `onError` and `onStop` only to emit normalized container state, exit code, and deployment ID;
never serialize the platform `Error` object or container stderr.

Test a sleeping instance: the first `fetch()` must auto-start the container, wait for port 8080 and the
`/healthz` ping, then deliver the create request; a startup/ping failure is classified as transient
`ENGINE_CRASH` without exposing the platform error text.

Update `src/index.ts` at the same time:

~~~ts
export { ImageEngineContainer } from "./container-client";

export default {
  fetch: routeRequest,
  queue: consumeImageQueue,
} satisfies ExportedHandler<QueueEnv, ImageJobMessage>;
~~~

`consumeImageQueue()` routes `batch.queue === env.IMAGE_JOBS_DLQ_NAME` to the quarantine path; the primary
queue path never samples file content for diagnostics. Even with batch size one, wrap every message in
`try/catch` and explicitly call `message.ack()` for completed, duplicate, permanent, and quarantined
outcomes or `message.retry({ delaySeconds })` for a platform transient; no branch leaves a message
unhandled.

- [ ] **Step 5: Implement claim, stream, poll, verify, settle**

Claim through a `first-primary` D1 session with one conditional update where status is `queued` or a
prior running lease has expired, create a 30-second fenced lease, set `started_at` exactly once at that
winning Queue claim, then read it through the same session. `queueMs = started_at - queued_at`. Immediately
before the first `EngineClient.create()` fetch, CAS `engine_contact_started_at` from null to `now`; this
timestamp is the cost interval start and is not reused as queue latency.
Start a renewal loop immediately after claim and renew every five seconds across R2 input fetch,
container cold start, engine upload/run/poll, output transfer, and settlement. Any renewal CAS failure
aborts the engine and prevents every subsequent write by the stale owner. The
consumer:

1. validates message identity against D1;
2. rejects a Queue message unless both its random `queueEpoch` and `queueGeneration` equal the current
   job row, then gets the exact
   completed-upload R2 version with
   `JOB_OBJECTS.get(inputKey, { onlyIf: { etagMatches: inputEtag } })`;
3. creates the engine job;
4. streams the R2 body to `EngineClient.upload`;
5. starts the runner;
6. polls every 250 ms while the independent lease loop continues;
7. mirrors only a changed, increasing phase sequence, phase, and phase fraction to D1;
8. checks cancellation between polls;
9. validates the terminal engine metadata, MIME, and `outputBytes < declaredBytes` before requesting
   output bytes;
10. creates `FixedLengthStream(outputBytes)` plus `crypto.DigestStream("SHA-256")`, then pumps each engine
    chunk with backpressure to both writers while the R2 create-only put consumes the fixed stream;
    compares the streaming digest with the engine `Digest` header, verifies final R2 metadata, and
    deletes the object before state publication on any mismatch;
11. atomically settles actual units against account, anonymous-session, and network ledgers once;
12. deletes the engine workspace in `finally`;
13. deletes the R2 input only after success, original-retained, non-retryable failure, exhausted retry,
    or cancellation.

Treat both a missing conditional `get()` result and a returned object without `body` as
`UPLOAD_MISMATCH`; R2 can return metadata without a body when a condition fails.

Persist `cold_start` and `container_ready_ms` from the first engine create response; retries record their
own attempt measurements while the job-level cold flag remains true if any attempt started a stopped
container. Persist structurally verified input MIME, alpha presence, and the deterministic v1 content
class from the engine inspection; live health queries never stratify on the client MIME hint. For
`original-retained`, store no output object and settle the successful result. For retryable failures,
persist and accumulate the attempt's CPU, memory, peak, decoded-pixel, input-byte, and candidate
measurements, keep the R2 input, clear the lease, transition `running → queued`, increment the attempt,
and UPSERT a new
outbox payload with the new attempt and resource class. Recheck all three quota ceilings and reserve one full
`estimateAttemptReservation({ inputBytes, resourceClass: nextResourceClass })` before every retry,
including same-class retries. Attempt an immediate delayed Queue send
using the new payload and `delaySeconds` 10, 30, or 120; mark its outbox row sent and acknowledge the
current message only after the send resolves. If that send fails, retain the outbox and retry the current
message with the same delay. On redelivery, the D1 attempt/resource class is authoritative and an older
message body is only an identity hint. An unexpected consumer crash before the retry transaction uses
Cloudflare automatic redelivery. Attempt three is terminal. Add the Queue consumer section to
`wrangler.local.jsonc` with batch size/concurrency one and
two platform retries, but defer the container/DO section until the Dockerfile exists in Task 11.
Map both engine success result kinds to public D1 `status = 'succeeded'`; preserve
`result_kind = 'original-retained'` for the no-output branch, and publish public
`phase = 'completed'`, `phase_fraction = 1`, with one final increasing sequence. A per-candidate codec deadline is not an
infrastructure retry: when the engine reports `guidance = 'TRY_BALANCED_PRESET'`, publish a non-retryable
`ENGINE_TIMEOUT`, persist `error_guidance = 'TRY_BALANCED_PRESET'`, and expose the Korean faster-preset
suggestion. Only whole-engine wall/CPU timeout, crash, or
transient storage/container failure follows Queue retry policy.
Telemetry accepts this closed shape only:

~~~ts
interface SafeProcessingEvent {
  event: "job-phase" | "job-terminal" | "deletion" | "queue-retry";
  jobId: string;
  sessionHashPrefix: string;
  contractId: "image.optimize@1";
  engineBuildId?: string;
  inputBytes: number;
  outputBytes?: number;
  pixels: number;
  phase?: string;
  queueMs?: number;
  processingMs?: number;
  peakMemoryBytes?: number;
  reservedUnits: number;
  actualUnits?: number;
  warningCode?: ImageOptimizeWarningCode;
  errorCode?: ToolJobErrorCode;
}
~~~

`sessionHashPrefix` is exactly the first 12 lowercase hexadecimal characters of the SHA-256 session hash;
the event schema rejects the full hash and any other length.

Exactly-once settlement is one `DB.batch()` guarded by
`jobs.settlement_state = 'reserved' AND jobs.lease_token = :leaseToken`:

~~~text
account_usage.reserved_units -= jobs.reserved_units
account_usage.settled_units += actualWeightedUnits
account_usage.pending_jobs -= 1
anonymous_usage.reserved_units -= jobs.reserved_units
anonymous_usage.settled_units += actualWeightedUnits
anonymous_usage.active_jobs -= 1
network_usage.reserved_units -= jobs.reserved_units
network_usage.settled_units += actualWeightedUnits
network_usage.pending_jobs -= 1
usage_ledger.actual_units = actualWeightedUnits
usage_ledger.outcome = terminalOutcome
jobs.actual_units = actualWeightedUnits
jobs.processed_input_bytes = cumulativeProcessedInputBytes
jobs.processed_pixels = cumulativeProcessedPixels
jobs.settlement_state = settled
~~~

Every terminal settlement sets `terminal_record_expires_at = terminalNow + 24 * 60 * 60_000` and
`network_hash_expires_at = min(createdAt + 48 * 60 * 60_000, terminal_record_expires_at)`. A
successful download result also sets `result_expires_at = terminalNow + 30 * 60_000`;
original-retained, failed, cancelled, and expired jobs keep `result_expires_at = NULL`.

Every terminal path releases unused reservation but adds measured or fixed-floor platform units to the
account, anonymous-session, and network settled totals, including infrastructure failure and
cancellation. A second settlement changes zero rows and is treated as a duplicate.

Every phase/final update is a CAS on the active `lease_token` and
`cancel_requested_at IS NULL`. If cancellation wins after output storage but before settlement, delete
the output and settle cancellation. If the consumer crashes after a verified output put but before D1
settlement, redelivery verifies the existing create-only object metadata/digest and resumes settlement
without re-encoding.

- [ ] **Step 6: Verify GREEN and commit**

Run:

~~~bash
pnpm test apps/api-worker/src/container-client.test.ts apps/api-worker/src/queue-consumer.test.ts apps/api-worker/src/telemetry.test.ts --run
pnpm --filter @hereisit/api-worker types
pnpm --filter @hereisit/api-worker typecheck
~~~

Expected: PASS; duplicate deliveries run once, streams are not buffered, and telemetry rejects extra
properties.

~~~bash
git add \
  apps/api-worker/src \
  apps/api-worker/wrangler.local.jsonc
git commit -m "feat: stream queued jobs through image engine"
~~~

### Task 7: Complete status, cancellation, download, deletion, and sweep recovery

**Files:**
- Create: `apps/api-worker/src/routes/results.ts`
- Create: `apps/api-worker/src/routes/results.test.ts`
- Create: `apps/api-worker/src/sweeper.ts`
- Create: `apps/api-worker/src/sweeper.test.ts`
- Modify: `apps/api-worker/src/routes/jobs.ts`
- Modify: `apps/api-worker/src/routes/jobs.test.ts`
- Modify: `apps/api-worker/src/router.ts`
- Modify: `apps/api-worker/src/d1-job-repository.ts`
- Modify: `apps/api-worker/src/index.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Modify: `apps/api-worker/src/worker-configuration.d.ts` (generated)

**Interfaces:**
- Consumes: job-token authentication, `retentionDecision()`, `EngineClient.cancel()`, D1 job rows, and R2 object streams.
- Produces these authenticated routes:

~~~text
GET    /v1/jobs/:jobId
POST   /v1/jobs/:jobId/cancel
GET    /v1/jobs/:jobId/result
POST   /v1/jobs/:jobId/downloaded
DELETE /v1/jobs/:jobId
GET    /health
~~~

- [ ] **Step 1: Write failing status and cancellation race tests**

Cover queued cancellation, active cancellation, cancellation after success, duplicate cancellation, and
expired tokens:

~~~ts
expect(await cancelJob(queuedRequest, env)).toMatchObject({ status: 202 });
expect(await readJob(jobId)).toMatchObject({ status: "cancelled" });
expect(await env.JOB_OBJECTS.get(inputKey)).toBeNull();

expect(await cancelJob(runningRequest, env, { engine: fakeEngine })).toMatchObject({
  status: 202,
});
expect(fakeEngine.cancel).toHaveBeenCalledWith(jobId);
expect(await readJob(jobId)).toMatchObject({
  status: "running",
  cancel_requested_at: expect.any(Number),
});
await settleCancelledLeaseOwner(jobId, activeLeaseToken);
expect(await readUsage(jobId)).toMatchObject({
  outcome: "cancelled",
  settled_at: expect.any(Number),
});
~~~

For a queued job, the route owns an atomic `queued → cancelled` CAS, removes any unsent outbox row,
settles the fixed platform floor once, and deletes input. For a running job, the route only sets
`cancel_requested_at` and sends a best-effort engine `DELETE`; the current lease owner remains solely
responsible for terminal settlement and object deletion. A repeated request is idempotent. Cancellation
after success returns `409` and directs the caller to result deletion. If the lease owner disappears, the
sweeper acquires a new fenced recovery lease before settling the cancellation.

- [ ] **Step 2: Write failing attachment and deletion tests**

For a succeeded job:

~~~ts
expect(response.headers.get("content-disposition")).toBe(
  'attachment; filename="hereisit-compressed.jpg"',
);
expect(response.headers.get("cache-control")).toBe("private, no-store");
expect(response.body).not.toBeNull();
~~~

The API uses a generic same-format filename because the server never knows the source name. The browser
overrides it with its locally generated filename after fetching. Prove the route streams, refuses
cross-job tokens, returns `409` for `original-retained`, deletes after `/downloaded`, and deletes an
interrupted result after `resultExpiresAt` in the healthy sweeper path.

Add a cancel→immediate-`DELETE` race table for every state. `created|uploading|queued` may be
CAS-cancelled, settled, and cleaned by the route. `running` may only record cancellation and signal the
engine; repeated `DELETE` returns `202` until the fenced lease owner or recovery sweeper reaches a
terminal state. `succeeded` may delete the result, while failed/cancelled/expired deletion is
idempotent. Prove a running delete cannot remove R2 input/output, erase the engine workspace, or settle
usage underneath the active lease.

Before any job D1 read, upload/status/result/cancel/downloaded/delete routes apply
`JOB_API_NETWORK_RATE_LIMITER` keyed by the rotating network HMAC. Status/result/cancel/delete then apply
`JOB_READ_RATE_LIMITER` keyed by opaque job ID. Legitimate one-Hz polling stays below the explicit
180 network and 90 per-job requests/minute ceilings; random-ID rotation cannot bypass the network fence.
Excess returns `429` with `Retry-After` and performs no D1/R2/container work. Add
`RESULT_DOWNLOAD_RATE_LIMITER` at three starts/minute per job. Result-download tests prove a fenced
two-minute lease rejects concurrent streams, an interrupted lease expires for retry, a wrong lease
cannot acknowledge, and rate-limit rejection never deletes the object.

- [ ] **Step 3: Write failing sweeper recovery tests**

Seed:

- one expired upload;
- one failed job with an input object;
- one acknowledged result;
- one result older than 30 minutes;
- one result whose download lease began just before 30 minutes and remains active across that sweep;
- one active unexpired job;
- one running job with an expired lease but an unexpired processing deadline;
- one queued job whose sent outbox message is older than 60 seconds with no lease;
- one stale job past `processing_deadline_at`;
- one pending outbox row;
- one fully deleted terminal record past 24 hours and one aggregate-usage row past 35 days;
- one rotating network-usage row past 48 hours and one still inside retention;
- one terminal job whose R2 deletion has failed continuously for 31 days;
- 201 orphan objects so cursor pagination crosses three 100-object sweeps.

Assert the first four eligible objects and orphan are deleted, the active job and leased result remain,
the leased stream completes and acknowledges without being invalidated, the next post-lease sweep
deletes an unacknowledged leased result, the outbox is dispatched, jobs become `expired` where required,
the recoverable stale jobs are re-enqueued, the past-deadline job is
terminally settled/deleted with unused reservation released, engine cleanup is requested, quota is
settled once across account/session/network ledgers, the saved R2 cursor advances through all pages,
expired metadata/aggregate/network rows are removed, and a fourth sweep is a no-op. For the 31-day
deletion failure, assert the full job, ledger, quarantine, and token/session/network/spec fields
disappeared at the 24-hour terminal-record boundary. Task 18 separately proves its later
artifact-presence audit FK cascades with that deletion. Only a minimal cleanup
tombstone containing random object keys, existence booleans, retry timing/count, and a normalized error
code remains. Assert the rotating network hash and aggregate disappear independently by 48 hours, then
make R2 deletion recover and prove the tombstone is removed without resurrecting the job.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test apps/api-worker/src/routes/jobs.test.ts apps/api-worker/src/routes/results.test.ts apps/api-worker/src/sweeper.test.ts --run`

Expected: FAIL because result and sweep paths are absent.

- [ ] **Step 5: Implement terminal cleanup and direct attachment streaming**

Every route authenticates before disclosing job existence. `/result` returns the R2 `ReadableStream`,
exact MIME, `Content-Length`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and
the object's quoted `httpEtag` as `ETag`, plus `Cache-Control: private, no-store`; it never returns an R2
URL. Before streaming, atomically claim `download_lease_hash` and
`download_lease_expires_at = now + 2 minutes`; return the raw random lease only in
`X-Download-Lease`. `/downloaded` requires that lease in the request header, timing-safely verifies its
hash, records acknowledgement, deletes output, clears the lease, then returns `204`. A disconnected
response leaves the object and expiring lease for retry. `DELETE` is state-aware and idempotent:

- `created|uploading|queued`: atomically cancel, remove unsent outbox state, settle the fixed/measured
  floor once, then delete input/output and any inactive workspace;
- `running`: set `cancel_requested_at`, send best-effort engine cancellation, and return `202`; only the
  current fenced lease owner, or a sweeper that acquires a recovery lease, settles and deletes;
- `succeeded`: delete the result and mark its terminal deletion state without altering settled usage;
- `failed|cancelled|expired`: retry missing artifact/workspace cleanup and return `204` once absent.

The route never changes an active running lease token or performs destructive cleanup concurrently with
its owner.
Status maps the persisted `error_guidance` field without collapsing a codec-candidate timeout into a
whole-engine timeout.

`scheduled()` runs:

~~~ts
await dispatchPendingOutbox(env, now, 100);
await recoverStaleLeasesAndLostQueueMessages(env, now, 100);
await sweepExpiredJobs(env, now, 100);
await sweepOrphanArtifactsFromSavedCursor(env, now - 10 * 60_000, 100);
~~~

Deletion failures before `terminal_record_expires_at` retain the D1 row and emit a normalized `deletion`
event so the next five-minute sweep retries. At the 24-hour terminal-record boundary, a D1 batch inserts
or updates `artifact_cleanup_tombstones` for any still-present random input/output keys and deletes the
full job, ledger, quarantine, outbox, and artifact-audit rows regardless of R2 availability. The
tombstone has no job ID, token/session/network hash, request/spec, file-derived metadata, MIME, size,
dimension, timing, or content-class field. Subsequent sweeps retry R2 deletion from that tombstone and
delete it after both heads are absent. R2 lifecycle remains an independent backstop.
`/health` returns `200` with build ID and configuration readiness, but returns `503` for
`serverJobsEnabled: false` only when the caller includes `?requireJobs=1`.
Recovery requeues a stale lease only before `processing_deadline_at`; otherwise it cancels any engine
workspace, deletes objects, settles measured/floor platform units, and releases only unused reservation.
A sent outbox row with no lease is eligible for one
idempotent reconciliation enqueue after 60 seconds. R2 listing cursors live in `maintenance_cursors`, so
a busy prefix cannot starve later orphan objects. Pagination advances only from `listed.truncated` and
the returned cursor; never infer completion from page length.
At terminal settlement set `network_hash_expires_at = min(created_at + 48 hours,
terminal_record_expires_at)` on the nullable job/ledger network fields. The sweeper irreversibly nulls
those fields at that deadline; `network_usage` has no foreign key from retained incident metadata and is
deleted independently after 48 hours. At `terminal_record_expires_at`, delete the full job family after
creating the minimal tombstone when needed, rather than allowing an R2 outage to extend application
metadata retention. Daily account/session aggregate usage rows remain for 35 days, then a separate
bounded SQL cleanup deletes them. These are active-table retention schedules under healthy maintenance,
not provider-backup erasure promises: paid-plan D1 Time Travel is always on and can restore history for
up to 30 days. The privacy policy and deletion responses distinguish active rows, minimal cleanup
tombstones, exceptional maintenance delay, and provider backup history.

The sweeper never deletes output while `download_lease_expires_at > now`, even when
`result_expires_at <= now`; it retries after lease expiry and still targets the next five-minute
healthy-operation sweep. `/result` refuses a new lease at or after `resultExpiresAt`, but a lease claimed
immediately before it remains valid for its full two minutes.

Add the five-minute cron to `wrangler.local.jsonc` and update the Worker entry without removing the Queue
handler:

~~~ts
export default {
  fetch: routeRequest,
  queue: consumeImageQueue,
  scheduled: runScheduledMaintenance,
} satisfies ExportedHandler<QueueEnv, ImageJobMessage>;
~~~

- [ ] **Step 6: Verify GREEN and Worker integration**

Run:

~~~bash
pnpm test apps/api-worker/src/routes/jobs.test.ts apps/api-worker/src/routes/results.test.ts apps/api-worker/src/sweeper.test.ts --run
pnpm --filter @hereisit/api-worker types
pnpm --filter @hereisit/api-worker typecheck
pnpm --filter @hereisit/api-worker build
~~~

Expected: PASS; every terminal path has a deletion assertion and repeated cleanup stays idempotent.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/api-worker/src \
  apps/api-worker/wrangler.local.jsonc
git commit -m "feat: complete job lifecycle and retention"
~~~

### Task 8: Add the browser remote runtime

**Files:**
- Create: `packages/server-runtime/package.json`
- Create: `packages/server-runtime/tsconfig.json`
- Create: `packages/server-runtime/src/api-client.ts`
- Create: `packages/server-runtime/src/api-client.test.ts`
- Create: `packages/server-runtime/src/upload.ts`
- Create: `packages/server-runtime/src/upload.test.ts`
- Create: `packages/server-runtime/src/download.ts`
- Create: `packages/server-runtime/src/download.test.ts`
- Create: `packages/server-runtime/src/run-image-optimize-batch.ts`
- Create: `packages/server-runtime/src/run-image-optimize-batch.test.ts`
- Create: `packages/server-runtime/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: public job and optimizer contracts only; this package must not import `server-contracts`, Cloudflare packages, React, Next.js, or codecs.
- Produces:

~~~ts
export type ProcessingPolicy = ImageOptimizePolicyResponseV1;
export interface ClientJobCredentials {
  clientRequestId: string;
  jobToken: string;
}
export function createClientJobCredentials(): ClientJobCredentials;
export interface RemoteImageOptimizeItem {
  itemId: string;
  file: File;
  width: number;
  height: number;
  spec: ImageOptimizeSpecV1;
}
export type RemoteImageOptimizeEvent =
  | {
      type: "item-progress";
      itemId: string;
      phase: ImageOptimizePhase;
      fraction: number | null;
      sequence: number;
    }
  | { type: "item-complete"; itemId: string; result: RemoteImageOptimizeItemResult }
  | { type: "batch-progress"; completed: number; total: number };
export interface RemoteDownloadHandle {
  descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "download" }>;
  download(input: {
    filename: string;
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  fetchForArchive(input: {
    remainingByteBudget: number;
    signal?: AbortSignal;
  }): Promise<RemoteArchivePart>;
  dispose(): Promise<void>;
}
export interface RemoteArchivePart {
  byteLength: number;
  stream: ReadableStream<Uint8Array>;
  acknowledge(): Promise<void>;
  cancelStream(): Promise<void>;
}
export type RemoteImageOptimizeItemResult =
  | {
      status: "fulfilled";
      itemId: string;
      value: RemoteDownloadHandle;
    }
  | {
      status: "original-retained";
      itemId: string;
      descriptor: Extract<ImageOptimizeResultDescriptor, { kind: "original-retained" }>;
    }
  | { status: "rejected"; itemId: string; error: ToolJobErrorPayload }
  | { status: "cancelled"; itemId: string };
export interface RemoteImageOptimizeBatchHandle {
  result: Promise<readonly RemoteImageOptimizeItemResult[]>;
  cancel(): void;
}
export function getProcessingPolicy(input: {
  apiOrigin: string;
  anonymousSessionId: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<ProcessingPolicy>;
export function runRemoteImageOptimizeBatch(
  items: readonly RemoteImageOptimizeItem[],
  options: {
    apiOrigin: string;
    anonymousSessionId: string;
    onEvent?: (event: RemoteImageOptimizeEvent) => void;
  },
): RemoteImageOptimizeBatchHandle;
~~~

- [ ] **Step 1: Write failing API/token-redaction tests**

~~~ts
const fetchMock = vi.fn().mockResolvedValue(
  Response.json(
    {
      contract: "tool-job@1",
      error: {
        code: "QUEUE_UNAVAILABLE",
        message: "잠시 후 다시 시도해 주세요.",
        retryable: true,
      },
    },
    { status: 503 },
  ),
);
await expect(
  createImageOptimizeJob(validRequest, {
    apiOrigin: "https://processing.example",
    fetch: fetchMock,
  }),
).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE", retryable: true });
expect(String(fetchMock.mock.calls)).not.toContain("private.jpg");
expect(() => JSON.stringify(lastError)).not.toThrow();
expect(JSON.stringify(lastError)).not.toContain("Bearer");
~~~

Prove `createClientJobCredentials()` returns a UUID plus 32-byte base64url token; a lost create response
retries with the same credentials; malformed JSON maps to `INVALID_REQUEST`; abort maps to `CANCELLED`;
and status/result calls always send the token only in the `Authorization` header with
`cache: "no-store"`.

- [ ] **Step 2: Write failing upload and direct-download tests**

Use a fake `XMLHttpRequest` to emit exact `loaded/total` progress. Assert the runtime accepts only
`kind: "worker-stream-put"`, resolves the descriptor's exact job-relative path against the configured API
origin, supplies the Bearer job token and descriptor MIME itself, and sends the original `File` body. It
must reject another origin, credentials in the URL, path traversal, a different job ID, an arbitrary
header map, or a descriptor byte count/MIME that differs from the local file. Cover non-2xx, abort,
network failure, and timeout.

For download, inject `fetch`, `URL.createObjectURL`, and an anchor factory:

~~~ts
await downloadRemoteResult({
  apiOrigin: "https://processing.example",
  jobId,
  jobToken,
  filename: "photo-hereisit.jpg",
  fetch: async () =>
    new Response(new Blob([Uint8Array.of(0xff, 0xd8, 0xff)]), {
      headers: { "content-type": "image/jpeg", "content-length": "3" },
    }),
  createObjectURL,
  clickAnchor,
  revokeObjectURL,
});
expect(clickAnchor).toHaveBeenCalledWith({
  href: "blob:result",
  download: "photo-hereisit.jpg",
});
expect(navigatorShareSpy).not.toHaveBeenCalled();
~~~

- [ ] **Step 3: Write failing batch orchestration tests**

Assert:

- items run sequentially;
- each completed result emits immediately;
- upload byte progress maps to `uploading`;
- status polling preserves null fractions for opaque native phases;
- `original-retained` never fetches a result;
- a fulfilled batch result is a lazy download handle and retains no Blob;
- successful download acknowledgement occurs only after the user invokes the handle and the full response
  is read;
- archive fetch rejects before reading when the caller's device-class byte budget would be exceeded;
- archive streaming never retains more than one response chunk plus the final ZIP output chunks;
- archive fetch or anchor click alone does not acknowledge; acknowledgement occurs only after the
  capability-specific handoff callback proven by the real-device matrix;
- cancellation aborts upload/poll/download and calls server cancel;
- a server-start/upload fallback performs authenticated cancellation, polls until the server job is
  terminal, then performs state-safe deletion before returning control to the local executor;
- policy/create `429`, network/session quota denial, or abuse-secret fail-closed maps to disclosed local
  execution only when `runLocalImageOptimizeFallback()` supports that exact spec. A server-required
  lossless case remains unuploaded and returns a precise `LOSSLESS_SERVER_REQUIRED` UI condition instead
  of looping generic retries;
- observer exceptions do not strand the batch;
- no filename enters create, upload-route, status, or cancel payloads.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test packages/server-runtime/src/*.test.ts --run`

Expected: FAIL because the package is absent.

- [ ] **Step 5: Implement browser-safe orchestration**

Use XHR only for upload progress; use `fetch` for JSON/status/result routes. Poll queued jobs with
exponential backoff from two to ten seconds and ±10% jitter under a 20-minute queue watchdog; poll
running jobs every one second under a 180-second active watchdog. Honor `Retry-After` and stop on `429`.
Ignore
status sequences lower than the latest observed value. Do not synthesize numeric progress when
`phaseFraction` is null. The batch keeps each source `File` in the browser, never sends its name, and
keeps the same client credentials across create retries. Policy lookup is a JSON `POST`; no raw session
ID, job token, or object identity enters a query string. Policy lookup has a two-second hard timeout and
falls back to the explicit local disclosure; create/upload mutations have a ten-second response timeout
after the body finishes, while the XHR body is governed by the upload deadline. These timeouts do not
change the overall queue/running watchdogs. Deduplicate concurrent policy requests and
cache a successful response in memory for at most five seconds, keyed by API origin and session ID;
never persist it, and do not cache failures. `forceRefresh: true` bypasses the cache immediately before
a batch starts.

A fulfilled result retains only IDs, bearer token, descriptor metadata, and closures. On user download,
`downloadRemoteResult()` fetches one result, enforces the advertised 30 MiB maximum, creates a Blob URL,
appends and clicks one hidden anchor with `download`, removes the anchor, revokes the URL on the next
macrotask so the browser has accepted the download. Acknowledge and delete immediately only on browser
paths proven by the real-device release matrix to provide a reliable handoff signal. On other paths,
retain the authenticated server result until its deadline, show `다운로드 다시 시도`, and do not claim
immediate deletion. `fetchForArchive()` is explicit and sequential. It rejects before fetching when the
remaining device-class byte budget is too small, then returns a response-backed `RemoteArchivePart`
whose counted `ReadableStream` is consumed once; it never materializes an input Blob. The web archive
builder feeds each chunk into `fflate` 0.8.3 `Zip`/`ZipPassThrough` with level-zero storage, finalizes that
entry, releases its reader, and only then fetches the next result. It retains the final ZIP output chunks
plus acknowledgement closures, not all input results. Callers acknowledge every part only after the
browser-class handoff callback has been proven; `anchor.click()` by itself never acknowledges. If ZIP
creation or handoff fails, the current stream is cancelled, local ZIP
chunks are released, server results remain available for individual retry, and the healthy-path
35-minute application SLO plus one-day expiration lifecycle remain fallbacks. Neither the runtime nor UI
describes 35 minutes as a hard maximum. It never references `navigator.share`.
It never calls `window.open`, changes location, or creates a preview tab.
Both paths require response MIME and `Content-Length` to match the public descriptor and count streamed
bytes exactly; a mismatch aborts, best-effort deletes the server result, and never clicks an anchor.
Capture `X-Download-Lease` only in the download closure, never log or persist it, and include it only in
the `/downloaded` acknowledgement header. A retry after interruption waits for the advertised
`Retry-After`/lease expiry rather than starting concurrent result streams.

- [ ] **Step 6: Verify GREEN and import boundaries**

Run:

~~~bash
pnpm install
pnpm test packages/server-runtime/src/*.test.ts --run
pnpm --filter @hereisit/server-runtime typecheck
rg -n "@hereisit/server-contracts|cloudflare|wrangler|react|next/" packages/server-runtime/src
~~~

Expected: tests and typecheck PASS; `rg` returns no matches.

- [ ] **Step 7: Commit**

~~~bash
git add packages/server-runtime pnpm-lock.yaml
git commit -m "feat: orchestrate remote image optimization"
~~~

### Task 9: Replace `/image/compress` with an honest dedicated workbench

**Files:**
- Create: `apps/web/src/lib/processing-config.ts`
- Create: `apps/web/src/lib/processing-config.test.ts`
- Create: `apps/web/src/lib/local-image-optimize-fallback.ts`
- Create: `apps/web/src/lib/local-image-optimize-fallback.test.ts`
- Create: `apps/web/src/lib/remote-image-archive.ts`
- Create: `apps/web/src/lib/remote-image-archive.test.ts`
- Create: `apps/web/src/lib/legal-policy.ts`
- Create: `apps/web/src/lib/legal-policy.test.ts`
- Create: `apps/web/src/app/privacy/page.tsx`
- Create: `apps/web/src/app/terms/page.tsx`
- Create: `docs/legal/privacy-review.schema.json`
- Create: `docs/legal/privacy-review.example.json`
- Create: `apps/web/src/components/image-compress-workbench.tsx`
- Create: `apps/web/src/components/image-compress-workbench.module.css`
- Create: `scripts/generate-web-headers.mjs`
- Create: `tests/generate-web-headers.test.ts`
- Create: `tests/e2e/image-compression-server.spec.ts`
- Modify: `packages/image-tool/src/naming.ts`
- Modify: `packages/image-tool/src/naming.test.ts`
- Modify: `apps/web/src/app/image/compress/page.tsx`
- Modify: `apps/web/src/components/image-tool-page.tsx`
- Modify: `apps/web/src/components/image-workbench.tsx`
- Modify: `apps/web/src/components/image-watermark-workbench.tsx`
- Modify: `apps/web/src/components/pdf-workbench.tsx`
- Modify: `apps/web/src/components/pdf-compress-workbench.tsx`
- Modify: `apps/web/src/components/pdf-to-image-workbench.tsx`
- Modify: `apps/web/src/lib/site.ts`
- Modify: `apps/web/src/lib/site.test.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/site-header.tsx`
- Modify: `apps/web/src/components/site-footer.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/next.config.ts`
- Modify: `pnpm-lock.yaml`
- Delete: `apps/web/public/_headers`
- Modify: `.gitignore`
- Modify: `scripts/verify-static-export.mjs`
- Modify: `scripts/smoke-image-watermark.mjs`
- Modify: `scripts/smoke-pdf-compress.mjs`
- Modify: `scripts/smoke-pdf-to-images.mjs`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `tests/e2e/image-watermark.spec.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts`
- Modify: `tests/e2e/pdf-to-images.spec.ts`
- Modify: `tests/e2e/pdf-tools.spec.ts`
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `getProcessingPolicy()`, `runRemoteImageOptimizeBatch()`, a lazily imported browser
  `runImageBatch()`, structural `inspectImageHeader()`, metadata-strip helpers, image naming helpers, and
  the processing manifest.
- Produces:

~~~ts
export interface ProcessingClientConfig {
  apiOrigin: string | null;
}
export function readProcessingClientConfig(): ProcessingClientConfig;
export function getOrCreateAnonymousSessionId(storage?: Storage): string;
export function suggestSameFormatOptimizedName(
  inputName: string,
  mime: "image/jpeg" | "image/png" | "image/webp",
): string;
export const REMOTE_ARCHIVE_DESKTOP_MAX_BYTES = 128 * 1024 * 1024;
export const REMOTE_ARCHIVE_CONSTRAINED_MAX_BYTES = 32 * 1024 * 1024;
export function remoteArchiveByteBudget(input: {
  deviceMemoryGiB: number | null;
  coarsePointer: boolean;
}): number;
export function buildRemoteImageArchive(input: {
  entries: readonly {
    filename: string;
    handle: RemoteDownloadHandle;
  }[];
  byteBudget: number;
  signal?: AbortSignal;
}): Promise<{
  blob: Blob;
  acknowledgeAfterHandoff(): Promise<void>;
  dispose(): void;
}>;
export interface ReviewedLegalPolicy {
  version: string;
  effectiveAt: string;
  privacyDocumentSha256: string;
  termsDocumentSha256: string;
  reviewArtifactSha256: string;
}
export const reviewedLegalPolicy: ReviewedLegalPolicy;
~~~

- [ ] **Step 1: Write failing config, session, naming, and copy tests**

~~~ts
expect(readProcessingClientConfig()).toEqual({
  apiOrigin: null,
});

const first = getOrCreateAnonymousSessionId(fakeStorage);
const second = getOrCreateAnonymousSessionId(fakeStorage);
expect(second).toBe(first);
expect(first).toMatch(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

expect(suggestSameFormatOptimizedName("휴가.JPG", "image/jpeg")).toBe(
  "휴가-hereisit.jpg",
);
expect(suggestSameFormatOptimizedName("../private.png", "image/png")).toBe(
  "private-hereisit.png",
);

expect(imageTools.compress.description).toContain("HereIsIt 처리 서버");
expect(imageTools.compress.description).toContain("자동 삭제");
expect(imageTools.resize.description).toContain("업로드 없이");
~~~

In `local-image-optimize-fallback.test.ts`, prove lossless fallback never invokes Canvas:

~~~ts
await expect(runLocalImageOptimizeFallback(jpegOrientation1, losslessSpec)).resolves.toMatchObject({
  status: "fulfilled",
  mime: "image/jpeg",
  warnings: [],
});
await expect(runLocalImageOptimizeFallback(webp, losslessSpec)).resolves.toMatchObject({
  status: "unsupported",
  reason: "LOSSLESS_SERVER_REQUIRED",
});
expect(canvasEncoder).not.toHaveBeenCalled();
~~~

JPEG lossless local fallback may only strip metadata when orientation is one; PNG may only use the pure
metadata-strip path; WebP lossless and oriented/profile-normalizing lossless cases require the server.
Smart local fallback may lazily import Canvas, preserves the source MIME, and marks PNG
`SMART_PNG_FELL_BACK_TO_LOSSLESS`.

In `remote-image-archive.test.ts`, use counted chunk streams and prove coarse-pointer or
`deviceMemory <= 4` environments receive the 32 MiB cap, desktop receives 128 MiB, an over-budget archive
is refused before any fetch, and `ZipPassThrough` completes one entry before the next fetch begins. Track
live input chunks and assert the high-water mark is one chunk rather than the sum of all result files.
The final ZIP must preserve order and collision-safe names, acknowledge only after the explicit handoff
callback, and release all chunks on error or cancellation.

Before generating legal pages, run the pinned Apache-2.0 `korean-privacy-terms` interview during
execution and obtain the operator's actual jurisdiction, business/operator name, address, contact/CPO,
target age range, supported countries, analytics/advertising choices, and Korean-only versus bilingual
output. Do not infer or commit placeholder identities. The generated draft is not legal advice and
cannot enable public server processing until Korean counsel supplies an immutable review artifact bound
to the exact document hashes and policy version.

`legal-policy.test.ts` validates that `/privacy` and `/terms` expose the reviewed version and footer links,
and that the privacy inventory explicitly covers:

- uploaded file contents; anonymous session/job metadata; verified MIME, size band, dimensions, alpha
  boolean, coarse v1 content class, timings, resource measurements, content-free error state, and
  identifier-free hourly operational-cost counters retained for 35 days;
- transient IP use for edge rate limiting plus the rotating pseudonymous network HMAC bucket, its purpose,
  exact retention, and the fact that raw IP is never stored by HereIsIt application code;
- processing purpose and counsel-approved legal basis, input/result/job/aggregate/network retention,
  healthy 35-minute deletion SLO, exceptional-delay possibility, and non-exact one-day R2 expiration
  backstop; if object deletion is still failing at the 24-hour terminal-record boundary, the full job
  family is erased and only random object keys plus content-free retry state remain in a minimal cleanup
  tombstone until deletion succeeds;
- active D1 row deletion versus Cloudflare D1 Time Travel's always-on, up-to-30-day paid-plan restorable
  history, plus seven-day Workers/Container log retention for the allowlisted job ID/session-prefix and
  operational fields;
- identifier-free Analytics Engine route points and their provider retention, plus the separate private
  usage-log bucket's healthy explicit-delete target after cost sealing, three-day expiration backstop,
  and exceptional-delay possibility without a hard maximum. The latter contains only `CPUTimeMs`,
  `Entrypoint`, `EventTimestampMs`, `EventType`, `Outcome`, `ScriptName`, and `ScriptVersion`; request `Event`, URL,
  headers, console `Logs`, and `Exceptions` are excluded at the Logpush source. Its content-free
  object-key/ETag/set-digest import ledger is retained seven days for exactly-once accounting and never
  contains a job/session/network/file identifier. Provider Container billing aggregates contain only
  hourly application/instance resource totals;
- Cloudflare processing/subprocessor and any overseas processing/transfer country, timing, method,
  recipient/purpose, retention, refusal consequences, and counsel-approved basis;
- data-subject rights, request method, responsible contact, policy change history, and under-14 handling.

The schema rejects a generic `approved: true`: it requires reviewer/organization, jurisdiction, review
date/expiry, exact privacy/terms hashes, Cloudflare transfer analysis, conditions, and approval reference.
No generic consent checkbox is added by default. The intentional file-selection action follows a visible
summary and policy link, but public rollout remains disabled unless counsel approves the actual legal
basis; if separate consent is required, that becomes a blocking product change rather than an invented
assumption.

- [ ] **Step 2: Write failing header-generation tests**

~~~ts
const headers = generateHeaders({
  processingApiOrigin: "https://processing.example.com",
});
expect(headers).toContain(
  "connect-src 'self' https://processing.example.com",
);
expect(() =>
  generateHeaders({
    processingApiOrigin: "javascript:alert(1)",
  }),
).toThrow("origin");
~~~

When the API origin is absent, the generated CSP must retain `connect-src 'self'`. Only an exact `https:`
origin is accepted, except `http://127.0.0.1` and `http://localhost` when
`ALLOW_LOCAL_PROCESSING_ORIGINS=1`.

- [ ] **Step 3: Run tests and verify RED**

Run:

~~~bash
pnpm install
pnpm test \
  apps/web/src/lib/processing-config.test.ts \
  apps/web/src/lib/local-image-optimize-fallback.test.ts \
  apps/web/src/lib/remote-image-archive.test.ts \
  apps/web/src/lib/legal-policy.test.ts \
  packages/image-tool/src/naming.test.ts \
  apps/web/src/lib/site.test.ts \
  tests/generate-web-headers.test.ts \
  --run
~~~

Expected: FAIL because the config, same-format name, new copy, and generator are absent.

- [ ] **Step 4: Implement exact config and CSP generation**

`readProcessingClientConfig()` reads only:

~~~ts
const apiOrigin = normalizePublicOrigin(
  process.env.NEXT_PUBLIC_PROCESSING_API_ORIGIN,
);
~~~

An absent API origin means local execution. Store one random UUID in local storage under
`hereisit.processing-session.v1`; if storage throws, retain one module-scoped ID. Persist no file-derived
value.

`generate-web-headers.mjs` writes `apps/web/public/_headers` before `dev` and `build`. Delete the tracked
artifact and add `/apps/web/public/_headers` to `.gitignore`. Preserve every existing security directive
and add only the validated processing API `connect-src` origin. Update web scripts:

~~~json
{
  "dev": "node ../../scripts/generate-web-headers.mjs && node ../../scripts/sync-pdfjs-assets.mjs && next dev",
  "build": "node ../../scripts/generate-web-headers.mjs && node ../../scripts/sync-pdfjs-assets.mjs && next build"
}
~~~

- [ ] **Step 5: Write failing workbench component tests through Playwright**

Add initial cases to `tests/e2e/image-compression-server.spec.ts` using a request-intercepted fake API:

~~~ts
await page.goto("/image/compress");
await expect(page.getByText("처리 방식을 확인하고 있어요.")).toBeVisible();
await expect(page.getByRole("button", { name: "압축할 이미지 선택" })).toBeDisabled();

await installServerPolicy(page);
await page.reload();
await expect(
  page.getByText(/선택한 이미지는 HereIsIt 처리 서버로 전송/),
).toBeVisible();
await expect(page.getByRole("button", { name: "압축할 이미지 선택" })).toBeEnabled();
~~~

Add a local-policy case that shows `업로드 없음 · 내 기기에서 처리`, never calls `/v1/jobs`, and still
preserves JPEG as JPEG.
Add a policy-network-failure case that resolves to
`서버 연결 실패 · 업로드 없이 내 기기에서 처리`, enables the picker only after that disclosure is
visible, and never attempts an upload.
Add shared-NAT/session-rotation cases where policy or create is denied by the network quota/rate fence:
smart mode switches to `사용량 보호 · 업로드 없이 내 기기에서 처리`, while a server-required lossless
case stays local/unuploaded and explains that lossless server processing is temporarily unavailable.
Add a download-handoff capability case that keeps the result and shows
`기본 브라우저에서 열어 다시 다운로드해 주세요` for an unproven in-app browser; no share API,
preview window, or acknowledgement request may occur.

Add a `mobile-chromium` Playwright project before invoking it: use the repository's Chromium device
settings with a 390-by-844 viewport, touch enabled, mobile mode enabled, and
`testMatch: /image-compression-server\.spec\.ts/`. Keep the existing desktop projects unchanged.

- [ ] **Step 6: Implement the dedicated same-format workbench**

The workbench:

- accepts at most 20 JPEG/PNG/WebP files and 30 MiB each;
- structurally inspects each source before enabling processing;
- rejects animation and files over 40 MP;
- exposes `추천`, `최소 용량`, and `무손실` controls mapped to the exact optimizer spec; PNG smart
  controls visibly say `색상 수를 줄일 수 있는 시각적 압축`;
- renders policy disclosure before the picker;
- revalidates policy when the user starts a batch so a just-opened circuit prevents upload;
- treats policy timeout/malformed response as local-only with explicit server-unavailable copy; it never
  guesses server mode;
- shows real phases with indeterminate UI when fraction is null;
- processes remote items sequentially and exposes each result immediately;
- retains lazy remote download handles rather than result Blobs;
- preserves the source MIME and extension;
- maps `original-retained` to the local source `File`;
- shows `원본 파일을 그대로 내려받습니다 · 메타데이터도 그대로일 수 있어요` whenever
  `ORIGINAL_RETAINED_UNMODIFIED` is present, so metadata stripping is never falsely promised;
- uses the local browser runtime only when policy says local or a retryable server-start failure maps to
  `LOCAL_FALLBACK_REQUIRED`; if a server job or upload already exists, it first requests authenticated
  cancellation, waits for terminal status within the existing watchdog, then performs state-safe delete.
  A running job that has not terminalized never races into local processing of the same item;
- offers `결과 다운로드 ↓` per item; offers `결과 N개 ZIP으로 받기 ↓` only when advertised aggregate
  output fits the 128 MiB desktop or 32 MiB constrained-device budget. The explicit action streams one
  remote result at a time through `ZipPassThrough`, releases each input stream before the next fetch,
  retains only final ZIP chunks, and acknowledges server results after a proven download handoff.
  Over-budget mobile batches show `용량이 커서 개별 다운로드만 지원해요` instead of attempting a risky
  archive;
- never imports or calls `navigator.share`.

Local smart fallback maps each file independently and is loaded only inside
`runLocalImageOptimizeFallback()`:

~~~ts
async function runSmartCanvasFallback(
  mime: "image/jpeg" | "image/png" | "image/webp",
  optimize: ImageOptimizeSpecV1,
): Promise<ImagePipelineSpecV1> {
  await import("@hereisit/browser-runtime/image");
  if (mime === "image/png") {
    return {
      version: 1,
      resize: { kind: "none" },
      output: { format: "png", compression: { mode: "lossless" } },
      sizeGoal: {
        mode: "smaller-only",
        minSavingsPercent: optimize.minimumSavingsPercent,
        minQuality: 35,
        maxAttempts: 1,
      },
      autoOrient: true,
      metadata: "strip",
    };
  }
  if (mime === "image/jpeg") {
    return {
      version: 1,
      resize: { kind: "none" },
      output: {
        format: "jpeg",
        compression: {
          mode: "quality",
          quality: optimize.preset === "smallest" ? 72 : 82,
        },
        matte: "#ffffff",
      },
      sizeGoal: {
        mode: "smaller-only",
        minSavingsPercent: optimize.minimumSavingsPercent,
        minQuality: 35,
        maxAttempts: 3,
      },
      autoOrient: true,
      metadata: "strip",
    };
  }
  return {
    version: 1,
    resize: { kind: "none" },
    output: {
      format: "webp",
      compression: {
        mode: "quality",
        quality: optimize.preset === "smallest" ? 72 : 82,
      },
    },
    sizeGoal: {
      mode: "smaller-only",
      minSavingsPercent: optimize.minimumSavingsPercent,
      minQuality: 35,
      maxAttempts: 3,
    },
    autoOrient: true,
    metadata: "strip",
  };
}
~~~

For `mode: "lossless"`, call only `stripJpegMetadata()` or `stripPngMetadata()` under the eligibility
rules tested in Step 1. Never route a lossless request through Canvas.

`runLocalImageOptimizeFallback()` accepts the same item ID, spec, abort signal, and event callback shape
as the remote coordinator and emits the shared `inspecting|optimizing|verifying|completed` phases. The
workbench selects this explicit executor only after a local policy or completed best-effort remote
cleanup; there is no implicit catch-all branch.

Use a one-column mobile layout below 800 px, sticky bottom primary action with safe-area padding, 44 px
minimum controls, no horizontal scrolling at 320 px, and the file/settings/result regions in document
order. Desktop uses a three-region grid without copying the existing 1,000-line workbench.

- [ ] **Step 7: Wire the route and truthful global copy**

`/image/compress` renders `ImageCompressWorkbench`; resize and convert continue to render
`ImageWorkbench`. Update compression copy to:

~~~text
JPG, PNG, WebP 이미지를 원본 형식 그대로 압축하세요. 서버 처리 대상이면 선택한 파일을
HereIsIt 처리 서버로 전송합니다. 입력은 작업 종료 시, 결과는 다운로드 확인 시 바로 삭제를
시도합니다. 확인되지 않은 결과는 일반적으로 35분 안에 삭제하지만 서비스 장애 시 늦어질 수
있으며, 1일 만료 규칙을 추가 안전망으로 사용합니다.
~~~

Remove only global home/README claims that every HereIsIt operation is upload-free. Keep each local tool's
specific local-processing disclosure.
Replace the global `site-header.tsx` badge `내 기기에서만 처리` with neutral copy such as
`개인정보를 먼저 생각하는 파일 도구`; route-specific disclosure remains the source of truth. Add an E2E
assertion that no global browser-only claim is visible on `/image/compress` before file selection.
Add always-visible `개인정보처리방침` and `이용약관` links to the footer and a concise privacy-policy link
inside the server-upload picker disclosure. The public pages render only reviewed operator data and the
hash-bound policy version; example review JSON never counts as approval.

Remove every `navigator.share`/`navigator.canShare` branch from the five existing image/PDF workbenches,
remove now-unused `isAbortError` imports, rename `결과 저장·공유 ↓` to `결과 다운로드 ↓`, and update the
listed E2E/smoke assertions. Add a regression test that stubs `navigator.share` to throw if called and
still observes a Playwright download for each single-result workbench.

Update `verify-static-export.mjs` so `/image/compress` is route class `image-compression-server`; it must
contain the server-runtime marker, lack PDF workers, and not require the established generic image Worker
unless the local fallback chunk is lazily requested.

- [ ] **Step 8: Verify GREEN, responsive layout, and direct-download copy**

Run:

~~~bash
pnpm test \
  apps/web/src/lib/processing-config.test.ts \
  apps/web/src/lib/local-image-optimize-fallback.test.ts \
  apps/web/src/lib/remote-image-archive.test.ts \
  apps/web/src/lib/legal-policy.test.ts \
  packages/image-tool/src/naming.test.ts \
  apps/web/src/lib/site.test.ts \
  tests/generate-web-headers.test.ts \
  --run
pnpm --filter @hereisit/web typecheck
pnpm --filter @hereisit/web build
pnpm verify:export
pnpm exec playwright test tests/e2e/image-compression-server.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/image-compression-server.spec.ts --project=mobile-chromium
if rg -n "navigator\\.(canShare|share)|저장·공유" apps/web/src/components; then exit 1; fi
~~~

Expected: unit, type, build, export, desktop, and mobile checks PASS; the final `rg` returns no matches.

- [ ] **Step 9: Commit**

~~~bash
git add \
  packages/image-tool \
  apps/web \
  scripts/generate-web-headers.mjs \
  scripts/smoke-image-watermark.mjs \
  scripts/smoke-pdf-compress.mjs \
  scripts/smoke-pdf-to-images.mjs \
  tests/generate-web-headers.test.ts \
  tests/e2e \
  playwright.config.ts \
  scripts/verify-static-export.mjs \
  .gitignore \
  pnpm-lock.yaml \
  README.md \
  docs/architecture.md \
  docs/legal
git commit -m "feat: add server-capable image compression workbench"
~~~

### Task 10: Build the image-engine HTTP lifecycle and isolated runner

**Files:**
- Create: `apps/image-engine/package.json`
- Create: `apps/image-engine/tsconfig.json`
- Create: `apps/image-engine/.dockerignore`
- Create: `apps/image-engine/src/contract.ts`
- Create: `apps/image-engine/src/config.ts`
- Create: `apps/image-engine/src/server.ts`
- Create: `apps/image-engine/src/http/router.ts`
- Create: `apps/image-engine/src/http/router.test.ts`
- Create: `apps/image-engine/src/job/job-controller.ts`
- Create: `apps/image-engine/src/job/job-controller.test.ts`
- Create: `apps/image-engine/src/job/job-runner.ts`
- Create: `apps/image-engine/src/job/workspace.ts`
- Create: `apps/image-engine/src/job/workspace.test.ts`
- Create: `apps/image-engine/src/job/resource-monitor.ts`
- Create: `apps/image-engine/src/job/resource-monitor.test.ts`
- Create: `apps/image-engine/src/observability/safe-log.ts`
- Create: `apps/image-engine/src/observability/safe-log.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `EngineCreateJobRequest`, `EngineJobStatus`, and strict internal engine schemas from
  `@hereisit/server-contracts`; do not redeclare them in the engine package.
- Produces:

~~~text
GET    /healthz                       → 204
GET    /v1/build                      → EngineBuildInfo
POST   /v1/jobs                       → 201; identical replay 200; identity mismatch 409
PUT    /v1/jobs/:jobId/input          → 204 after exact length and streamed SHA-256 recording
POST   /v1/jobs/:jobId/run            → 202; idempotent
GET    /v1/jobs/:jobId                → EngineJobStatus
GET    /v1/jobs/:jobId/output         → verified bytes and bounded metadata headers
DELETE /v1/jobs/:jobId                → cancel process group, erase workspace, 204
~~~

~~~ts
export interface EngineBuildInfo {
  protocol: 1;
  engineBuildId: string;
  codecs: {
    jpeg: string;
    png: string;
    webp: string;
    transform: string;
  };
}
~~~

- [ ] **Step 1: Write failing HTTP idempotency and stream tests**

Create a controller with an injected fake runner:

~~~ts
expect((await request("POST", "/v1/jobs", createBody)).status).toBe(201);
expect((await request("POST", "/v1/jobs", createBody)).status).toBe(200);
expect(
  (
    await request("POST", "/v1/jobs", {
      ...createBody,
      specHash: "different",
    })
  ).status,
).toBe(409);

expect(
  (
    await request("PUT", `/v1/jobs/${jobId}/input`, inputStream, {
      "content-length": "3",
      "content-type": "image/jpeg",
    })
  ).status,
).toBe(204);
~~~

Reject chunked input without `Content-Length`, length mismatch, MIME mismatch, unknown jobs, path
traversal IDs, output before success, and a second different input. The engine treats the R2 ETag as an
opaque version identity, not a content hash; it computes and records its own input SHA-256 during upload
for same-attempt idempotency and never claims to validate SHA-256 against the ETag.

- [ ] **Step 2: Write failing cancellation and cleanup tests**

Use a fake detached runner that spawns its own detached codec group and a stubborn detached grandchild.
Assert the controller discovers and registers every active descendant PGID, sends `SIGTERM` to codec
groups before the runner group, enumerates again, sends `SIGKILL` after 500 ms to every surviving group,
and leaves no descendant. Also assert workspace deletion on failure/cancel and after explicit remove,
successful `output.bin` retention until the Worker has streamed it, `0700` directory mode, no
world-readable files, and no source name in any path. Seed an orphan job directory before server restart;
`/healthz` must remain unavailable until startup scrub removes it, and scrub failure must terminate the
server rather than serving with residual user data.

- [ ] **Step 3: Write failing resource-monitor and safe-log tests**

At 250 ms samples, trigger each exact limit:

~~~ts
expect(await monitor.sample({ memoryBytes: 768 * 1024 * 1024 + 1 })).toEqual({
  exceeded: "memory",
});
expect(await monitor.sample({ workspaceBytes: 1024 * 1024 * 1024 + 1 })).toEqual({
  exceeded: "workspace",
});
expect(await monitor.sample({ elapsedMs: 60_001 })).toEqual({
  exceeded: "wall-time",
});
~~~

Also test standard/large CPU limits 45/75 seconds, output bytes never above source bytes, file descriptors
at most 64, child processes at most 8, and process count inspection failure as a terminal safety failure.
The exact resource table is:

~~~ts
export const resourcePolicies = {
  "image-standard-v1": {
    wallMs: 60_000,
    cpuMs: 45_000,
    workspaceBytes: 1024 ** 3,
    memoryDeltaBytes: 768 * 1024 ** 2,
    maxFileDescriptors: 64,
    maxProcesses: 8,
  },
  "image-large-v1": {
    wallMs: 90_000,
    cpuMs: 75_000,
    workspaceBytes: 2 * 1024 ** 3,
    memoryDeltaBytes: 1536 * 1024 ** 2,
    maxFileDescriptors: 64,
    maxProcesses: 8,
  },
} as const;
~~~

The monitor sets `process.umask(0o077)` before creating any workspace. On Linux it resolves the current
cgroup-v2 directory from `/proc/self/cgroup`, records the idle server baselines from `memory.current`,
`cpu.stat` (`usage_usec`), and `pids.current`, then enforces memory/CPU deltas. `pids.current` is a
thread-inclusive safety signal with a hard delta ceiling of 128.

Independently of cgroup availability, every 250 ms sample also walks the complete detached process-group
tree through `/proc/*/stat`, counts every descendant for `maxProcesses: 8`, and sums all descendant
`/proc/${pid}/fd` entries for `maxFileDescriptors: 64`. Thus cgroup success never disables the stricter
process and FD policies. When cgroup memory/CPU counters are unavailable, the same complete tree also
sums `smaps_rollup` RSS/PSS and per-process user/system ticks as the fallback measurement. Workspace
accounting walks the job directory without following symlinks and sums regular-file byte lengths every
250 ms. Failure to obtain the process/FD tree, or both the cgroup and full memory/CPU fallback, is a
terminal `ENGINE_CRASH`, because allowing native grandchildren to escape measurement is unsafe.
`memoryByteMilliseconds` is the sum of each 250 ms memory-delta sample multiplied
by its actual elapsed interval; CPU and memory baselines are recorded before the runner is spawned. Wall
time uses `process.hrtime.bigint()`. Any breach sends SIGTERM to the detached process group and SIGKILL
500 ms later. Memory maps to `ENGINE_OOM`; CPU or wall time maps to `ENGINE_TIMEOUT`; workspace, FD,
process/thread hard-cap, or measurement failure maps to non-retryable `ENGINE_CRASH`. Only a standard
class memory breach may request the single large-class retry; a large-class OOM is terminal.

Safe logging accepts only job ID, build IDs, phase, timings, byte counts, pixels, memory, candidate count,
and normalized codes. It rejects `filename`, `path`, `url`, `token`, `metadata`, `stderr`, and unknown
keys. Captured stderr is capped at 8 KiB and never leaves the process-local diagnostic file.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test apps/image-engine/src/**/*.test.ts --run`

Expected: FAIL because the engine app is absent.

- [ ] **Step 5: Implement the parent server and detached child boundary**

Use Node's `node:http`, no web framework. Build two entries:

~~~json
{
  "scripts": {
    "dev": "node --watch dist/server.mjs",
    "build": "esbuild src/server.ts src/job/job-runner.ts --bundle --platform=node --format=esm --target=node24 --outdir=dist --out-extension:.js=.mjs",
    "start": "node dist/server.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
~~~

`package.json` depends on `@hereisit/server-contracts` and Zod 4.4.3, with esbuild 0.28.1, TypeScript
6.0.3, Vitest 4.1.10, and Node types in dev dependencies. The GREEN step runs `pnpm install` after this
workspace manifest exists and commits the resulting lockfile change.

The parent never imports Sharp or codec adapters. `job-runner.mjs` owns native work and reports JSONL
phase events plus internal `process-group:add|remove` control records on stdout. Spawn with:

~~~ts
spawn(process.execPath, [runnerPath, "--workspace", workspacePath], {
  cwd: workspacePath,
  detached: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NODE_ENV: "production",
    HOME: workspaceHomePath,
    TMPDIR: workspaceTmpPath,
    TMP: workspaceTmpPath,
    TEMP: workspaceTmpPath,
  },
});
~~~

State files use write-then-rename. `output.bin` and `result.json` become visible only after the runner
passes verification. The controller allows one active job because Queue concurrency is one, but retains
job IDs and idempotent identity checks. On SIGTERM the server rejects new creates with `503`, lets the
current runner finish within the rollout grace, cancels and cleans it at grace expiry, then exits.
Before binding port 8080 or reporting health, the parent removes every stale child under `/work` without
following symlinks and fails closed if any entry remains. Each new job creates mode-`0700` `home/` and
`tmp/` subdirectories inside its accounted workspace; all temp/home environment variables point there,
so Sharp/libvips/native spill files are included in disk limits and deletion. Tests run a child that
writes only through `TMPDIR` and prove it cannot escape the job directory.
The controller tracks codec PGIDs from control records and independently re-enumerates the complete
runner descendant tree from `/proc/*/stat` before both TERM and KILL passes. Whole-job cancellation,
resource breach, and rollout shutdown terminate every distinct descendant group; a codec group cannot
escape merely because it was created with `detached: true`. Candidate timeout kills only the registered
current codec group, allowing the runner to return an earlier accepted candidate.
Every successful status reports raw `cpuMs`, `memoryByteMilliseconds`, `peakMemoryBytes`,
`testedCandidates`, codec/build identifiers, warning codes, and phase timings; only the Worker converts
those measurements into weighted units.

- [ ] **Step 6: Verify GREEN and commit**

Run:

~~~bash
pnpm install
pnpm test apps/image-engine/src/**/*.test.ts --run
pnpm --filter @hereisit/image-engine typecheck
pnpm --filter @hereisit/image-engine build
node apps/image-engine/dist/server.mjs &
ENGINE_PID=$!
curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz | rg '^204$'
kill "$ENGINE_PID"
~~~

Expected: tests/typecheck/build PASS and health returns 204.

~~~bash
git add apps/image-engine pnpm-lock.yaml
git commit -m "feat: add isolated image engine lifecycle"
~~~

### Task 11: Pin and build the native production supply chain

**Files:**
- Create: `apps/image-engine/Dockerfile`
- Create: `apps/image-engine/base-images.lock.json`
- Create: `apps/image-engine/native/sources.lock.json`
- Create: `apps/image-engine/native/build-common.sh`
- Create: `apps/image-engine/native/build-mozjpeg.sh`
- Create: `apps/image-engine/native/jpeg-coeff-verify.c`
- Create: `apps/image-engine/native/build-oxipng.sh`
- Create: `apps/image-engine/native/build-libwebp.sh`
- Create: `apps/image-engine/native/build-libvips.sh`
- Create: `apps/image-engine/native/build-jpegli.sh`
- Create: `apps/image-engine/native/build-libjxl-metrics.sh`
- Create: `apps/image-engine/native/png-smart/Cargo.toml`
- Create: `apps/image-engine/native/png-smart/Cargo.lock`
- Create: `apps/image-engine/native/png-smart/src/main.rs`
- Create: `apps/image-engine/licenses/policy.json`
- Create: `apps/image-engine/licenses/commercial-review.schema.json`
- Create: `apps/image-engine/licenses/commercial-review.example.json`
- Create: `apps/image-engine/security/vulnerability-exceptions.json`
- Create: `scripts/verify-image-engine-licenses.mjs`
- Create: `tests/image-engine-license-policy.test.ts`
- Modify: `apps/image-engine/package.json`
- Delete: `apps/api-worker/src/pending-container-binding.ts`
- Modify: `apps/api-worker/src/container-client.ts`
- Modify: `apps/api-worker/src/queue-consumer.ts`
- Modify: `apps/api-worker/src/index.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Modify: `apps/api-worker/src/worker-configuration.d.ts` (generated)
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: exact upstream source revisions and the engine runtime binary names.
- Produces runtime commands:

~~~text
/usr/local/bin/cjpeg
/usr/local/bin/djpeg
/usr/local/bin/jpegtran
/usr/local/bin/jpeg-coeff-verify
/usr/local/bin/oxipng
/usr/local/bin/png-smart
/usr/local/bin/cwebp
/usr/local/bin/dwebp
/usr/local/lib/libvips.so
/app/dist/server.mjs
/app/dist/job-runner.mjs
~~~

Benchmark target additionally contains:

~~~text
/opt/benchmark/jpegli/bin/cjpegli
/opt/benchmark/libjxl/bin/ssimulacra2
/opt/benchmark/libjxl/bin/butteraugli_main
~~~

- [ ] **Step 1: Write the failing lock and license-policy test**

~~~ts
expect(sourceLock.sources).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      name: "mozjpeg",
      version: "4.1.1",
      revision: "a2d2907ff023227e80c1e4efa809812410275a12",
      production: true,
      licenses: ["IJG", "BSD-3-Clause", "Zlib"],
      noticePaths: ["LICENSE.md", "README.ijg"],
      buildRole: "runtime-codec",
      artifactRecord: "/build-metadata/mozjpeg.json",
    }),
    expect.objectContaining({
      name: "jpegli",
      revision: "031a0077f5799a6041004267fc12b956c1f52a20",
      production: false,
      review: "patent-and-corpus",
    }),
  ]),
);
expect(policy.applicationAndNative.prohibited).toEqual(
  expect.arrayContaining(["GPL-2.0", "GPL-3.0", "AGPL-3.0"]),
);
expect(vulnerabilityExceptions).toEqual({
  schemaVersion: 1,
  exceptions: [],
});
~~~

The verifier test fails if any production source lacks repository, revision, non-empty licenses, notice paths,
build role, or artifact hash record; if a base image is not locked by both index and linux/amd64 manifest
digest; if jpegli/libjxl enters the runtime inventory; or if libimagequant or pngquant appears anywhere
in the runtime filesystem manifest. It also reconciles `cargo metadata --locked`, the pnpm lockfile,
runtime `ldd` edges, Debian packages, and the Syft SBOM so a transitive crate, Node package, or shared
library cannot bypass policy.
Parse SPDX expressions and license families fail-closed: handle `-only`, `-or-later`, `AND`, `OR`,
`WITH`, parentheses, `LicenseRef-*`, and `NOASSERTION`; an unknown expression or any GPL/AGPL branch in
the application/native graph fails unless the entire expression is conclusively allowed by policy.
Any future vulnerability exception must name the CVE, affected package/digest, exploitability evidence,
owner, approval reference, and an expiry no more than 30 days away; expired or incomplete entries fail
CI. The initial file is empty.

`commercial-review.schema.json` requires a separate immutable review record for every release-sensitive
component or notice, including libvips LGPL relinking/source-offer obligations and codec patent notices.
Each record includes component/revision, source-lock SHA-256, reviewed license and patent files,
reviewer/organization, review date, decision, conditions, approval reference, and optional re-review
date. `commercial-review.example.json` is explicitly `decision: "not-reviewed"` and can never satisfy a
commercial release. The real reviewed artifact remains outside the public repository and its SHA-256 is
embedded in the release report.

- [ ] **Step 2: Add exact source and base-image locks**

~~~json
{
  "schemaVersion": 1,
  "sources": [
    {
      "name": "mozjpeg",
      "version": "4.1.1",
      "repository": "https://github.com/mozilla/mozjpeg.git",
      "revision": "a2d2907ff023227e80c1e4efa809812410275a12",
      "licenses": ["IJG", "BSD-3-Clause", "Zlib"],
      "noticePaths": ["LICENSE.md", "README.ijg"],
      "buildRole": "runtime-codec",
      "artifactRecord": "/build-metadata/mozjpeg.json",
      "production": true,
      "complianceReview": "approved-runtime"
    },
    {
      "name": "oxipng",
      "version": "10.1.1",
      "repository": "https://github.com/oxipng/oxipng.git",
      "revision": "628e241e23f368097883807fa6e985ccf7c00357",
      "licenses": ["MIT"],
      "noticePaths": ["LICENSE"],
      "buildRole": "runtime-codec",
      "artifactRecord": "/build-metadata/oxipng.json",
      "production": true,
      "complianceReview": "approved-runtime"
    },
    {
      "name": "quantizr",
      "version": "1.4.3",
      "repository": "https://github.com/DarthSim/quantizr.git",
      "revision": "cfb26aaf3039ac1179d42a66cc7988c8c6feeba9",
      "licenses": ["MIT"],
      "noticePaths": ["LICENSE"],
      "buildRole": "runtime-library",
      "artifactRecord": "/build-metadata/png-smart.json",
      "production": true,
      "complianceReview": "approved-runtime"
    },
    {
      "name": "libwebp",
      "version": "1.6.0",
      "repository": "https://github.com/webmproject/libwebp.git",
      "revision": "4fa21912338357f89e4fd51cf2368325b59e9bd9",
      "licenses": ["BSD-3-Clause"],
      "noticePaths": ["COPYING", "PATENTS"],
      "buildRole": "runtime-codec",
      "artifactRecord": "/build-metadata/libwebp.json",
      "production": true,
      "complianceReview": "approved-runtime"
    },
    {
      "name": "libvips",
      "version": "8.18.4",
      "repository": "https://github.com/libvips/libvips.git",
      "revision": "e01a4797cabe77d457fdfa7d776b7a7e7ca6d6a7",
      "licenses": ["LGPL-2.1-or-later"],
      "noticePaths": ["LICENSE"],
      "buildRole": "runtime-dynamic-library",
      "artifactRecord": "/build-metadata/libvips.json",
      "production": true,
      "complianceReview": "approved-dynamic-link-with-source-and-relinking-materials"
    },
    {
      "name": "jpegli",
      "version": "benchmark-2026-07-16",
      "repository": "https://github.com/google/jpegli.git",
      "revision": "031a0077f5799a6041004267fc12b956c1f52a20",
      "licenses": ["BSD-3-Clause"],
      "noticePaths": ["LICENSE", "PATENTS"],
      "buildRole": "benchmark-candidate",
      "artifactRecord": "/build-metadata/jpegli.json",
      "production": false,
      "complianceReview": "blocked-pending-patent-and-corpus-review"
    },
    {
      "name": "libjxl-metrics",
      "version": "0.11.2",
      "repository": "https://github.com/libjxl/libjxl.git",
      "revision": "332feb17d17311c748445f7ee75c4fb55cc38530",
      "licenses": ["BSD-3-Clause"],
      "noticePaths": ["LICENSE", "PATENTS"],
      "buildRole": "benchmark-metrics",
      "artifactRecord": "/build-metadata/libjxl-metrics.json",
      "production": false,
      "complianceReview": "approved-benchmark-only"
    }
  ]
}
~~~

`base-images.lock.json` is:

~~~json
{
  "schemaVersion": 1,
  "platform": "linux/amd64",
  "images": [
    {
      "name": "rust-build",
      "reference": "rust:1.88.0-bookworm",
      "indexDigest": "sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0",
      "platformDigest": "sha256:4727898c104ecd2e22d780925832502faee9fe4e70581b8572af081370b315a0"
    },
    {
      "name": "node-build-runtime",
      "reference": "node:24.13.0-bookworm-slim",
      "indexDigest": "sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f",
      "platformDigest": "sha256:46feb5752989c05b8606e6323fbbc3db667d14ade1c24f5d0d44d9ca9909d607"
    }
  ]
}
~~~

- [ ] **Step 3: Implement deterministic source checkout, dependency install, and native builds**

`build-common.sh` initializes an empty repository, fetches exactly one revision, checks
`git rev-parse HEAD`, removes `.git`, and records source revision, compiler versions, flags, and installed
file SHA-256 values in `/opt/hereisit-build/${sourceName}.json`.

Build settings:

- MozJPEG: CMake release build, shared libraries off, SIMD on, Java off, `cjpeg`, `djpeg`, `jpegtran`,
  and the HereIsIt-owned `jpeg-coeff-verify` helper linked against the same pinned coefficient API.
- OxiPNG: `cargo build --release --locked`, default production invocation `-o 3 --strip safe`; zopfli is
  excluded from live presets.
- libwebp: static utilities plus shared runtime libraries, unnecessary examples disabled.
- libvips: shared library, modules disabled, introspection/docs/examples disabled, only JPEG/PNG/WebP,
  lcms2, and EXIF support enabled.
- Sharp 0.35.3: add exact `sharp: 0.35.3` and `node-addon-api: 8.9.0` dependencies plus
  `node-gyp: 12.4.0`, `esbuild: 0.28.1`, and `@esbuild/linux-x64: 0.28.1` as exact build dependencies.
  Node-gyp 13 is intentionally excluded because its engine range starts above the pinned Node 24.13.0
  runtime. The explicit non-optional `@esbuild/linux-x64` package is required because combining
  `--no-optional` with `--ignore-scripts` otherwise leaves esbuild with no platform binary. Install the
  workspace with `pnpm install --frozen-lockfile --no-optional --ignore-scripts`, require both esbuild
  packages to report `0.28.1`, invoke the actual bundler once, then run
  `SHARP_FORCE_GLOBAL_LIBVIPS=1 node apps/image-engine/node_modules/sharp/install/build.js`. Import Sharp
  in the build stage and require `sharp.versions.vips === "8.18.4"`; fail if any `@img/sharp-*` or
  `@img/sharp-libvips-*` optional package is installed.
- `png-smart`: locked Rust release build using Quantizr, accepting
  `--input-rgba`, `--width`, `--height`, `--colors`, and `--output`.
- jpegli and libjxl metrics: benchmark stage only and never copied to runtime.

`native/png-smart/Cargo.toml` pins `png = "=0.18.0"` and Quantizr with
`git = "https://github.com/DarthSim/quantizr.git"` plus
`rev = "cfb26aaf3039ac1179d42a66cc7988c8c6feeba9"`; `cargo build --locked` and the committed
`Cargo.lock` must resolve that exact revision.

- [ ] **Step 4: Add the minimal digest-pinned multi-stage Docker image**

Use the index digests from `base-images.lock.json` in every `FROM` and build only `linux/amd64`. Rewrite
Debian sources to the `20260716T000000Z` Debian snapshot, disable `Check-Valid-Until`, install with
`--no-install-recommends`, and export exact installed package versions plus
`/usr/share/doc/*/copyright` paths to `/build-metadata/debian-packages.json`. The final stage:

~~~dockerfile
RUN groupadd --gid 10001 hereisit \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin hereisit \
  && install -d -m 0700 -o 10001 -g 10001 /work
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
USER 10001:10001
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/server.mjs"]
~~~

Copy all required license, notice, patent, source-offer, relinking, build-metadata, and artifact-hash
files into `/licenses` and `/build-metadata`. The license policy treats application/Node/native-linked
components separately from Debian base packages: GPL or AGPL in the application/native dependency graph
is prohibited, while distro base packages are accepted only when locked to the snapshot, inventoried in
the SBOM, and shipped with their Debian copyright/source-retrieval notices. LGPL libvips remains
dynamic-only and requires the recorded compliance approval, exact source, build scripts, notices, and
relinking materials before a commercial release. The automated gate is engineering evidence, not a
substitute for the recorded LGPL and patent legal review required by the design.
For `--scope release`, `verify-image-engine-licenses.mjs` requires the external commercial-review
artifact, validates it against the schema and exact source-lock hash, rejects `not-reviewed`,
expired/conditional-unsatisfied decisions, and emits its artifact hash. A string such as
`complianceReview: "approved-runtime"` inside the source lock is classification metadata only and never
counts as legal approval.

The Node build stage runs `pnpm --filter @hereisit/image-engine build`, verifies
`apps/image-engine/node_modules/@esbuild/linux-x64/bin/esbuild --version` is `0.28.1`, and checks both expected `.mjs`
bundles before the runtime copy. A Docker build that never executes the real platform binary fails.

- [ ] **Step 5: Add the local Container and Durable Object binding**

Now that the Dockerfile exists, extend `apps/api-worker/wrangler.local.jsonc` with:

~~~json
{
  "containers": [
    {
      "class_name": "ImageEngineContainer",
      "image": "../image-engine/Dockerfile",
      "image_build_context": "../..",
      "instance_type": "standard-2",
      "max_instances": 1,
      "rollout_active_grace_period": 180,
      "rollout_step_percentage": [100]
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "IMAGE_ENGINE",
        "class_name": "ImageEngineContainer"
      }
    ]
  },
  "migrations": [
    {
      "tag": "image-engine-v1",
      "new_sqlite_classes": ["ImageEngineContainer"]
    }
  ]
}
~~~

`enableInternet = false` stays on the `ImageEngineContainer` class; it is not emitted as a Wrangler
configuration field. Regenerate `src/worker-configuration.d.ts` and verify the Docker build context is
the repository root. Delete `pending-container-binding.ts` and change the client, consumer, and default
export signatures from `QueueEnv` back to the generated `Env`; add a type assertion that
`Env["IMAGE_ENGINE"]` is a `DurableObjectNamespace<ImageEngineContainer>`.

- [ ] **Step 6: Run license tests and build both targets**

Run:

~~~bash
pnpm install --frozen-lockfile --no-optional --ignore-scripts
test "$(apps/image-engine/node_modules/@esbuild/linux-x64/bin/esbuild --version)" = "0.28.1"
pnpm --filter @hereisit/image-engine build
pnpm test tests/image-engine-license-policy.test.ts --run
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker build -f apps/image-engine/Dockerfile --target benchmark -t hereisit-image-engine:benchmark .
docker run --rm --network none --entrypoint node \
  hereisit-image-engine:test /app/dist/server.mjs --self-test
docker run --rm --entrypoint sh hereisit-image-engine:test -c \
  'test "$(id -u)" = 10001 && ! find / -xdev \( -iname "*pngquant*" -o -iname "*imagequant*" -o -iname "*jpegli*" -o -iname "*libjxl*" \) -print -quit | grep .'
node scripts/verify-image-engine-licenses.mjs \
  --scope pr \
  --image hereisit-image-engine:test \
  --lock apps/image-engine/native/sources.lock.json \
  --policy apps/image-engine/licenses/policy.json
pnpm --filter @hereisit/api-worker types
pnpm --filter @hereisit/api-worker build
~~~

Expected: policy test and both builds PASS; runtime self-test passes without network; runtime scan finds no
prohibited or benchmark-only component.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/image-engine \
  apps/api-worker/wrangler.local.jsonc \
  apps/api-worker/src \
  scripts/verify-image-engine-licenses.mjs \
  tests/image-engine-license-policy.test.ts \
  pnpm-lock.yaml
git commit -m "build: pin image engine native supply chain"
~~~

### Task 12: Inspect, normalize, classify, and plan bounded candidates

**Files:**
- Create: `apps/image-engine/src/pipeline/inspect.ts`
- Create: `apps/image-engine/src/pipeline/inspect.test.ts`
- Create: `apps/image-engine/src/pipeline/normalize.ts`
- Create: `apps/image-engine/src/pipeline/normalize.test.ts`
- Create: `apps/image-engine/src/pipeline/classify.ts`
- Create: `apps/image-engine/src/pipeline/classify.test.ts`
- Create: `apps/image-engine/src/pipeline/plan.ts`
- Create: `apps/image-engine/src/pipeline/plan.test.ts`
- Modify: `apps/image-engine/src/job/job-runner.ts`

**Interfaces:**
- Consumes: input file path, parsed optimizer spec, Sharp 0.35.3 with global libvips, and bounded workspace.
- Produces:

~~~ts
export type ImageContentClass =
  | "photo"
  | "screenshot-text"
  | "flat-graphic"
  | "transparent-graphic"
  | "noisy"
  | "already-optimized";
export interface ImageInspection {
  format: "jpeg" | "png" | "webp";
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  displayedWidth: number;
  displayedHeight: number;
  pixels: number;
  bitDepth: 8 | 16;
  hasAlpha: boolean;
  animated: boolean;
  orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  hasIccProfile: boolean;
  sourceColorModel:
    | "gray"
    | "rgb"
    | "ycbcr"
    | "cmyk"
    | "ycck"
    | "unknown";
  adobeTransform: 0 | 1 | 2 | null;
  iccProfileKind: "none" | "srgb-compatible" | "cmyk" | "other";
  wideGamut: boolean;
  metadataBytes: number;
}
export interface NormalizedImage {
  rawPath: string;
  width: number;
  height: number;
  channels: 3 | 4;
  sampleDepth: 8 | 16;
  rawEndian: "little";
  rawSha256: string;
  alphaSha256: string | null;
  normalizedColorSpace: "srgb";
}
export interface OptimizationCandidatePlan {
  id: string;
  codec: "mozjpeg" | "oxipng" | "quantizr-oxipng" | "libwebp";
  mode: string;
  quality?: number;
  chroma?: "420" | "444";
  effort: number;
}
export interface OptimizationPlan {
  contentClass: ImageContentClass;
  candidates: readonly [
    OptimizationCandidatePlan,
    ...OptimizationCandidatePlan[],
  ];
  normalizeColorWithLcms: boolean;
  requirePixelExact: boolean;
  requireAlphaExact: boolean;
  minimumSavingsPercent: number;
}
export type OptimizationPlanningResult =
  | { kind: "plan"; plan: OptimizationPlan }
  | {
      kind: "unsupported";
      code: "UNSUPPORTED_FEATURE";
      reason: "UNSAFE_SOURCE_COLOR_MODEL";
    };
~~~

Planner tests and runtime validation require `1 <= candidates.length <= 3`. An unsafe/ambiguous source
color model is a normalized `UNSUPPORTED_FEATURE` failure, not `original-retained`; that success outcome
is reserved strictly for a fully processed file for which no verified smaller candidate exists.

- [ ] **Step 1: Write failing structural-inspection tests**

Use generated minimal JPEG/PNG/WebP fixtures and assert magic wins over extension/MIME. Reject:

- truncated structures;
- dimensions above 32,768;
- more than 40,000,000 pixels;
- metadata over 4 MiB;
- APNG and animated WebP;
- decoded expansion that exceeds either exact safety bound below.

For JPEG, parse SOF component IDs/count/sampling, JFIF, APP14 Adobe transform, and reassembled bounded ICC
chunks into the explicit color-model fields above before Sharp. Add real gray, YCbCr/JFIF, RGB Adobe-0,
CMYK Adobe-0, YCCK Adobe-2, malformed/absent ICC, and conflicting-marker fixtures. No three- or
four-component JPEG may default to sRGB merely because Sharp can decode it.

~~~ts
await expect(inspectImage(disguisedPngPath, "image/jpeg")).resolves.toMatchObject({
  format: "png",
  mime: "image/png",
});
await expect(inspectImage(animatedWebpPath, "image/webp")).rejects.toMatchObject({
  code: "UNSUPPORTED_FEATURE",
});
~~~

- [ ] **Step 2: Write failing normalization and classification tests**

Assert EXIF orientation six swaps displayed dimensions exactly once, output orientation becomes one,
embedded profiles normalize to sRGB, metadata is absent from the raw working image, and alpha hashes are
stable.

Use deterministic sampled fixtures:

~~~ts
expect(classifyImage(koreanTextFeatures)).toBe("screenshot-text");
expect(classifyImage(photoFeatures)).toBe("photo");
expect(classifyImage(transparentLogoFeatures)).toBe("transparent-graphic");
expect(classifyImage(noiseFeatures)).toBe("noisy");
~~~

The test fixtures provide the exact v1 feature vector:

~~~ts
export interface ImageFeaturesV1 {
  alphaCoverage: number;
  uniqueColorRatio: number;
  edgeDensity: number;
  highContrastEdgeRatio: number;
  flatRegionRatio: number;
  lumaEntropyBits: number;
  noiseResidual: number;
  encodedToRawRatio: number;
}
~~~

Build it from a deterministic at-most-256-by-256 regular grid over normalized linear-sRGB pixels. Quantize
RGB to five bits per channel for `uniqueColorRatio`; use 64 luma bins for entropy; use Sobel magnitude
thresholds `0.12` and `0.25` for the two edge ratios; define a flat pixel as gradient below `0.01`; and
define `noiseResidual` as mean absolute luma difference from a separable `[1, 2, 1] / 4` blur. Apply this
ordered classifier. `encodedToRawRatio` is `encodedBytes / decodedBytes`:

~~~ts
if (alphaCoverage > 0) return "transparent-graphic";
if (encodedToRawRatio <= 0.08 && flatRegionRatio < 0.20) return "already-optimized";
if (
  edgeDensity >= 0.12 &&
  highContrastEdgeRatio >= 0.06 &&
  uniqueColorRatio <= 0.20 &&
  flatRegionRatio >= 0.35
) return "screenshot-text";
if (uniqueColorRatio <= 0.08 && flatRegionRatio >= 0.60) return "flat-graphic";
if (lumaEntropyBits >= 5.8 && flatRegionRatio < 0.08 && noiseResidual >= 0.08) return "noisy";
return "photo";
~~~

- [ ] **Step 3: Write failing planner tests**

Assert:

~~~ts
expect(planOptimization(jpegScreenshot, smartBalanced)).toMatchObject({
  kind: "plan",
  plan: {
    contentClass: "screenshot-text",
    candidates: [
      expect.objectContaining({ codec: "mozjpeg", chroma: "444" }),
    ],
  },
});
expect(planOptimization(jpegPhoto, smartBalanced)).toMatchObject({
  kind: "plan",
  plan: {
    candidates: [
      expect.objectContaining({ codec: "mozjpeg", chroma: "420" }),
    ],
  },
});
expect(planOptimization(cmykJpegWithProfile, smartBalanced)).toMatchObject({
  kind: "plan",
  plan: {
    normalizeColorWithLcms: true,
    candidates: [expect.objectContaining({ codec: "mozjpeg" })],
  },
});
expect(planOptimization(ycckJpegWithoutTrustedInterpretation, losslessBalanced)).toEqual({
  kind: "unsupported",
  code: "UNSUPPORTED_FEATURE",
  reason: "UNSAFE_SOURCE_COLOR_MODEL",
});
expect(planOptimization(png16Bit, smartBalanced)).toMatchObject({
  kind: "plan",
  plan: {
    candidates: [expect.objectContaining({ codec: "oxipng" })],
    requirePixelExact: true,
  },
});
expect(planOptimization(webpLossless, losslessBalanced)).toMatchObject({
  kind: "plan",
  plan: { candidates: [expect.any(Object)] },
});
const smallestPlan = planOptimization(jpegPhoto, smartSmallest);
expect(smallestPlan.kind).toBe("plan");
if (smallestPlan.kind === "plan") {
  expect(smallestPlan.plan.candidates.length).toBeLessThanOrEqual(3);
}
~~~

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test apps/image-engine/src/pipeline/{inspect,normalize,classify,plan}.test.ts --run`

Expected: FAIL because the pipeline modules are absent.

- [ ] **Step 5: Implement bounded inspection and one normalization**

Inspect signatures and bounded headers before Sharp decode. Recheck Sharp metadata against the structural
parser. Before decode calculate:

~~~ts
const decodedBytes =
  inspection.width *
  inspection.height *
  (inspection.hasAlpha ? 4 : 3) *
  (inspection.bitDepth / 8);
const expansionRatio = Math.ceil(decodedBytes / encodedBytes);
const estimatedWorkingSet = decodedBytes * 3 + encodedBytes * 2;
~~~

Reject a decompression bomb when
`expansionRatio > 512 && decodedBytes > 64 * 1024 * 1024`. Compare the working set against both immutable
resource profiles before decode. If a standard attempt exceeds the standard 75% workspace threshold but
fits the large threshold, return internal retryable `RESOURCE_CLASS_UPGRADE` without opening Sharp,
persist the inspection measurement, and let the Queue consumer atomically reserve the one large attempt.
If it exceeds the large threshold, or a large attempt still exceeds its threshold, return terminal
`ENGINE_OOM`; never allocate first and hope the cgroup catches a predictable breach. Add exact boundary
tests for 8-bit and 16-bit RGB/RGBA immediately below/above both thresholds and prove the upgrade is
available once only. Otherwise normalize exactly once with a Sharp stream: `.rotate()`,
`.toColourspace(bitDepth === 16 ? "rgb16" : "srgb")`, call `.removeAlpha()`
only when the source has no alpha, and emit
`.raw({ depth: bitDepth === 16 ? "ushort" : "uchar" })` into a `createWriteStream(rawPath, { mode: 0o600 })`.
Canonicalize 16-bit samples to little-endian while streaming if the host output differs. Hash normalized
raw pixels and the independent alpha plane during that same stream, and feed the fixed sampling grid to
the feature extractor without retaining another full RGBA copy.

- [ ] **Step 6: Implement calibrated v1 planning**

Production rules:

- JPEG lossless: `jpegtran` structural candidate only for proven gray or sRGB-compatible YCbCr inputs
  whose rendering does not depend on a stripped Adobe/ICC marker. RGB, CMYK, YCCK, conflicting, or
  unknown color interpretation returns terminal `UNSUPPORTED_FEATURE` before normalization rather than
  risking a color shift; the browser keeps the unchanged local source.
- JPEG smart balanced: MozJPEG quality 82; refinement qualities 78 and 86 only when the first candidate
  misses size or quality bounds.
- JPEG smart smallest: qualities 74, 68, and 80.
- Screenshot/text JPEG: 4:4:4; photo/noisy JPEG: 4:2:0; flat graphics: 4:4:4.
- Supported CMYK/YCCK smart input is transformed through the pinned lcms/libvips path into normalized
  sRGB exactly once before MozJPEG. A valid CMYK profile or unambiguous Adobe transform is mandatory;
  ambiguous/no-profile color models return terminal `UNSUPPORTED_FEATURE` before normalization.
- PNG lossless or excluded smart cases: OxiPNG `-o 3 --strip safe`.
- Eligible 8-bit sRGB PNG smart: Quantizr RGBA at 255 colors, then 128, then OxiPNG. Opaque and
  alpha-bearing static inputs may enter the bounded candidate path. An alpha candidate is accepted only
  when the decoded alpha-plane hash is exact and black/white/checkerboard composite gates pass; otherwise
  it falls back to the depth-preserving normalized lossless path with
  `SMART_PNG_FELL_BACK_TO_LOSSLESS`. Animated, 16-bit, and wide-gamut cases never enter Quantizr.
- WebP lossless: one `-lossless -m 4` candidate.
- WebP smart balanced: for `flat-graphic|screenshot-text`, near-lossless `80` with method 4, then lossy
  quality 82; for other classes, lossy quality 82 then 76.
- WebP smart smallest: for `flat-graphic|screenshot-text`, near-lossless `60` with method 5, then lossy
  qualities 72 and 66; for other classes, lossy qualities 72, 66, and 78.

The runner emits `validating`, `inspecting`, and `normalizing` JSONL events and persists the plan before
calling a codec.

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~bash
pnpm test apps/image-engine/src/pipeline/{inspect,normalize,classify,plan}.test.ts --run
pnpm --filter @hereisit/image-engine typecheck
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker run --rm --network none --entrypoint node \
  hereisit-image-engine:test /app/dist/job-runner.mjs --self-test-planner
~~~

Expected: all tests PASS, candidate count never exceeds three, and self-test makes no network request.

~~~bash
git add apps/image-engine/src/pipeline apps/image-engine/src/job/job-runner.ts
git commit -m "feat: plan bounded image optimization candidates"
~~~

### Task 13: Implement MozJPEG candidates and the JPEG promotion bakeoff

**Files:**
- Create: `apps/image-engine/src/codecs/command.ts`
- Create: `apps/image-engine/src/codecs/command.test.ts`
- Create: `apps/image-engine/src/codecs/jpeg.ts`
- Create: `apps/image-engine/src/codecs/jpeg.test.ts`
- Create: `apps/image-engine/src/codecs/jpeg-coeff-verify.ts`
- Create: `apps/image-engine/src/codecs/jpeg-coeff-verify.test.ts`
- Create: `apps/image-engine/src/pipeline/optimize.ts`
- Create: `apps/image-engine/src/pipeline/optimize.test.ts`
- Create: `scripts/benchmark-jpeg-encoders.mjs`
- Create: `tests/jpeg-encoder-promotion.test.ts`
- Modify: `apps/image-engine/src/job/job-runner.ts`

**Interfaces:**
- Consumes: normalized RGB path, original JPEG path, orientation, `OptimizationPlan`, and pinned binaries.
- Produces:

~~~ts
export interface CodecCandidate {
  id: string;
  path: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  encodeMs: number;
  codecBuildId: string;
  mode: string;
}
export interface CommandResult {
  exitCode: number;
  elapsedMs: number;
  stderrTail: string;
}
export function runBoundedCommand(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxStderrBytes?: number;
  signal: AbortSignal;
  onProcessGroup?: (event: { action: "add" | "remove"; pgid: number }) => void;
}): Promise<CommandResult>;
export function encodeJpegCandidate(input: {
  sourcePath: string;
  normalizedRgbPath: string;
  width: number;
  height: number;
  orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  candidate: OptimizationCandidatePlan;
  outputPath: string;
  signal: AbortSignal;
}): Promise<CodecCandidate>;
export function verifyJpegCoefficientTransform(input: {
  sourcePath: string;
  candidatePath: string;
  transform: "identity" | "flip-h" | "rotate-180" | "flip-v" | "transpose" | "rotate-90" | "transverse" | "rotate-270";
  signal: AbortSignal;
}): Promise<{
  exact: boolean;
  sourceSampling: string;
  candidateSampling: string;
  sourceBlocks: number;
  candidateBlocks: number;
}>;
~~~

- [ ] **Step 1: Write failing safe-command tests**

Assert `shell: false`, argument-array preservation for names containing spaces/semicolons, a distinct
detached codec PGID registered immediately after spawn and removed after reap, timeout process-group
termination, AbortSignal cancellation, stubborn-grandchild cleanup, 8 KiB stderr truncation, and no
command line in the public error:

~~~ts
await expect(
  runBoundedCommand({
    command: fixtureCommand,
    args: ["--literal", "; touch forbidden"],
    cwd,
    timeoutMs: 1000,
    signal: new AbortController().signal,
  }),
).resolves.toMatchObject({ exitCode: 0 });
expect(await pathExists(join(cwd, "forbidden"))).toBe(false);
~~~

- [ ] **Step 2: Write failing real JPEG adapter tests**

Run against the Docker runtime and assert:

- lossless mode uses `jpegtran -copy none -optimize -progressive` and adds `-perfect` for any orientation transform;
- EXIF orientations map exactly to `-flip horizontal`, `-rotate 180`, `-flip vertical`, `-transpose`,
  `-rotate 90`, `-transverse`, and `-rotate 270`;
- smart screenshot uses `-sample 1x1`; photo uses `-sample 2x2`;
- smart output is progressive, strips metadata, decodes, preserves displayed dimensions, and has JPEG
  SOI/EOI;
- gray and proven sRGB-compatible YCbCr lossless inputs preserve their rendering while stripping
  nonessential metadata;
- RGB/CMYK/YCCK/conflicting/unknown lossless input returns terminal `UNSUPPORTED_FEATURE`, leaving the
  browser's local source untouched rather than deleting a color-defining ICC/Adobe marker;
- profiled CMYK and unambiguous YCCK smart inputs normalize through lcms to sRGB and pass the zero
  severe-color gate, while ambiguous no-profile fixtures return `UNSUPPORTED_FEATURE`.

Lossless orientation transforms add `-perfect`; a non-MCU-perfect source returns
terminal `UNSUPPORTED_FEATURE` and leaves the local source untouched rather than trimming an edge. For
orientation 1, grayscale, and
4:4:4 sources, decoded normalized pixels remain exact. For subsampled rotated/flipped JPEGs, extract
quantized DCT coefficients and sampling factors before/after and assert the exact block
permutation/sign transform, displayed dimensions, orientation reset, and metadata removal. Do not require
an exact RGB hash in that case because decoder chroma upsampling can differ by a few values despite a
perfect coefficient transform.

`jpeg-coeff-verify` is a small HereIsIt-owned C helper built against the exact MozJPEG/libjpeg headers.
It uses `jpeg_read_coefficients`, validates dimensions/components/sampling/quantization/restart metadata,
maps every block position and DCT sign under the requested transform, and emits one strict bounded JSON
record—never coefficient values or paths. The TypeScript adapter accepts only the closed transform enum,
argument arrays, and normalized JSON. Real progressive, baseline, grayscale, 4:4:4, 4:2:2, 4:2:0,
restart-marker, odd-MCU, truncated, and malformed fixtures prove correct accept/reject behavior; the
fuzzer exercises the helper under the same resource limits.

~~~ts
expect(buildMozJpegArgs({ quality: 82, chroma: "444", outputPath, ppmPath })).toEqual([
  "-quality", "82",
  "-sample", "1x1",
  "-progressive",
  "-optimize",
  "-outfile", outputPath,
  ppmPath,
]);
~~~

- [ ] **Step 3: Write the failing encoder-promotion gate**

`benchmark-jpeg-encoders.mjs` runs MozJPEG and benchmark-only jpegli over the same authorized corpus and
emits canonical JSON. `jpeg-encoder-promotion.test.ts` asserts production config remains:

~~~ts
expect(productionJpegEncoder).toBe("mozjpeg");
expect(runtimeInventory).not.toContain("jpegli");
expect(promotionReport.candidate).toBe("jpegli");
expect(promotionReport.patentReview).toBe("not-approved");
~~~

The test fails if jpegli becomes production without `patentReview: "approved"`, complete corpus results,
and every release threshold passing.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

~~~bash
pnpm test \
  apps/image-engine/src/codecs/command.test.ts \
  apps/image-engine/src/codecs/jpeg.test.ts \
  apps/image-engine/src/codecs/jpeg-coeff-verify.test.ts \
  apps/image-engine/src/pipeline/optimize.test.ts \
  tests/jpeg-encoder-promotion.test.ts \
  --run
~~~

Expected: FAIL because command, JPEG, optimizer, and promotion modules are absent.

- [ ] **Step 5: Implement JPEG command paths**

For smart candidates, stream a P6 PPM header plus normalized RGB bytes into a workspace file without a
second full-image allocation:

~~~ts
await writev(output, [
  Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"),
  normalizedRgbChunk,
]);
~~~

For lossless structural candidates, operate on the source JPEG and use the exact orientation transform.
Reject crops caused by non-perfect MCU transforms; do not add `-trim`. Every native command has a
15-second codec deadline inside the job's 60-second wall limit.

`optimizeCandidates()` runs the first plan entry, calls the verifier from Task 15 through an injected
`CandidateVerifier` interface, stops early when the size target and quality margin pass, and never runs
more than three. Task 13 tests inject a deterministic verifier stub; Task 15 replaces it with the real
independent verifier. If a later candidate reaches its 15-second codec deadline after an accepted
candidate exists, stop and return the smallest accepted candidate. If the first candidate times out
before any accepted result exists, return non-retryable `ENGINE_TIMEOUT` with
`guidance: "TRY_BALANCED_PRESET"`; do not repeat the same expensive preset through Queue retry.

- [ ] **Step 6: Verify GREEN with real binaries**

Run:

~~~bash
pnpm test \
  apps/image-engine/src/codecs/command.test.ts \
  apps/image-engine/src/codecs/jpeg.test.ts \
  apps/image-engine/src/codecs/jpeg-coeff-verify.test.ts \
  apps/image-engine/src/pipeline/optimize.test.ts \
  tests/jpeg-encoder-promotion.test.ts \
  --run
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker run --rm --network none --entrypoint node \
  hereisit-image-engine:test /app/dist/job-runner.mjs --self-test-jpeg
~~~

Expected: PASS; JPEG fixture dimensions/orientation are correct and jpegli is absent from runtime.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/image-engine/src/codecs \
  apps/image-engine/src/pipeline/optimize.ts \
  apps/image-engine/src/pipeline/optimize.test.ts \
  apps/image-engine/src/job/job-runner.ts \
  scripts/benchmark-jpeg-encoders.mjs \
  tests/jpeg-encoder-promotion.test.ts
git commit -m "feat: optimize JPEG with promoted MozJPEG"
~~~

### Task 14: Implement lossless and smart PNG optimization

**Files:**
- Create: `apps/image-engine/src/codecs/png.ts`
- Create: `apps/image-engine/src/codecs/png.test.ts`
- Create: `apps/image-engine/src/pipeline/png-policy.test.ts`
- Modify: `apps/image-engine/native/png-smart/src/main.rs`
- Modify: `apps/image-engine/src/pipeline/optimize.ts`
- Modify: `apps/image-engine/src/job/job-runner.ts`

**Interfaces:**
- Consumes: normalized RGBA/RGB workspace files, `ImageInspection`, PNG candidate plans, OxiPNG, and
  `png-smart`.
- Produces:

~~~ts
export function encodePngCandidate(input: {
  normalizedPath: string;
  width: number;
  height: number;
  channels: 3 | 4;
  sampleDepth: 8 | 16;
  candidate: OptimizationCandidatePlan;
  outputPath: string;
  signal: AbortSignal;
}): Promise<CodecCandidate>;
export function isSmartPngEligible(inspection: ImageInspection): boolean;
~~~

- [ ] **Step 1: Write failing lossless PNG tests**

Generate 8-bit RGB, transparent RGBA, 16-bit, wide-gamut, and metadata-heavy PNGs. Assert lossless output:

~~~ts
expect(await normalizedPixelHash(outputPath)).toBe(
  await normalizedPixelHash(inputPath),
);
expect(await normalizedAlphaHash(outputPath)).toBe(
  await normalizedAlphaHash(inputPath),
);
expect(await listPngAncillaryChunks(outputPath)).not.toEqual(
  expect.arrayContaining(["eXIf", "iTXt", "tEXt", "zTXt"]),
);
~~~

OxiPNG command must be exactly:

~~~ts
["-o", "3", "--strip", "safe", "--out", outputPath, normalizedPngPath]
~~~

and must not use zopfli in a live request.

- [ ] **Step 2: Write failing smart-policy and Quantizr tests**

~~~ts
expect(isSmartPngEligible(rgb8Screenshot)).toBe(true);
expect(isSmartPngEligible(alphaPng)).toBe(true);
expect(isSmartPngEligible(bit16Png)).toBe(false);
expect(isSmartPngEligible(wideGamutPng)).toBe(false);
expect(isSmartPngEligible(animatedPng)).toBe(false);
~~~

Run `png-smart` on deterministic RGBA input and assert valid indexed PNG, palette size at most requested
colors, dimensions unchanged, PLTE plus a canonical tRNS chunk when any palette alpha is non-255, and
repeated runs are byte-identical. An opaque fixture must decode to alpha 255 everywhere. A limited-color
transparent logo must preserve the exact alpha-plane hash; a gradient-alpha fixture that Quantizr cannot
represent exactly must be rejected as a smart candidate. Add an RGB fixture whose chunks split in the
middle of a pixel and prove the adapter expands every RGB triplet to RGBA with alpha 255 and writes
exactly `width * height * 4` bytes before invoking the wrapper.

- [ ] **Step 3: Write failing candidate-selection tests**

For an eligible screenshot, assert 255-color output is tested first, 128-color output only when the first
misses the size target, OxiPNG follows palette encoding, and a candidate failing the live quality gate is
discarded. An exactly representable transparent logo may select the indexed candidate only after the
independent alpha/composite verifier passes. Gradient-alpha inputs whose alpha plane changes, plus all
16-bit or wide-gamut smart requests, must use the normalized lossless path and return
`SMART_PNG_FELL_BACK_TO_LOSSLESS`.
Use the same injected verifier stub introduced in Task 13; Task 15 supplies the production verifier.
Also prove a second-candidate codec timeout returns the already accepted first candidate, while a
first-candidate timeout returns `TRY_BALANCED_PRESET`.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test apps/image-engine/src/codecs/png.test.ts apps/image-engine/src/pipeline/png-policy.test.ts --run`

Expected: FAIL because the PNG adapter and completed wrapper are absent.

- [ ] **Step 5: Implement PNG adapters**

Encode a normalized base PNG by streaming the raw file into Sharp rather than passing a raw file path as
an encoded image:

~~~ts
const encoder = sharp({
  raw: {
    width,
    height,
    channels,
    depth: sampleDepth === 16 ? "ushort" : "uchar",
  },
});
if (sampleDepth === 16) encoder.toColourspace("rgb16");
encoder.png({ compressionLevel: 6, adaptiveFiltering: true, palette: false });
await pipeline(
  createReadStream(normalizedPath),
  encoder,
  createWriteStream(normalizedPngPath, { mode: 0o600 }),
);
~~~

Lossless mode runs OxiPNG on that file and verifies the decoded 8- or 16-bit sample hash before promotion.
Smart mode is available only for static 8-bit sRGB input and invokes:

~~~text
png-smart --input-rgba normalized.rgba --width W --height H \
  --colors 255 --output candidate.png
oxipng -o 3 --strip safe --out candidate-optimized.png candidate.png
~~~

For the eligible three-channel RGB path, first stream through a bounded stateful transform that carries
at most two trailing bytes between chunks and expands `RGB → RGBA(255)` into a mode-`0600`
`normalized.rgba`; verify its final length is exactly `width * height * 4`. Four-channel input streams
directly into the same wrapper. The wrapper serializes indexed PNG deterministically with PLTE and the
shortest canonical tRNS table needed for palette alpha. Before promotion, decode the candidate, require
the exact normalized alpha-plane hash, and run black/white/checkerboard perceptual gates. Failure discards
the candidate and selects the normalized OxiPNG result.

The Rust wrapper uses Quantizr 1.4.3 through the locked Cargo graph and its RGBA palette entries, writes
no metadata, and exits non-zero on dimension/length/palette serialization mismatch. It never invents or
flattens alpha. Its stderr contains normalized codes only.

- [ ] **Step 6: Verify GREEN with real PNG binaries**

Run:

~~~bash
pnpm test apps/image-engine/src/codecs/png.test.ts apps/image-engine/src/pipeline/png-policy.test.ts --run
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker run --rm --network none --entrypoint node \
  hereisit-image-engine:test /app/dist/job-runner.mjs --self-test-png
~~~

Expected: PASS; lossless hashes are exact, smart palette output is deterministic, accepted alpha
candidates preserve exact alpha, and non-representable alpha falls back to lossless.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/image-engine/src/codecs/png.ts \
  apps/image-engine/src/codecs/png.test.ts \
  apps/image-engine/src/pipeline/png-policy.test.ts \
  apps/image-engine/src/pipeline/optimize.ts \
  apps/image-engine/src/job/job-runner.ts \
  apps/image-engine/native/png-smart
git commit -m "feat: optimize PNG with lossless and smart paths"
~~~

### Task 15: Implement WebP and the independent final verifier

**Files:**
- Create: `apps/image-engine/src/codecs/webp.ts`
- Create: `apps/image-engine/src/codecs/webp.test.ts`
- Create: `apps/image-engine/src/pipeline/verify.ts`
- Create: `apps/image-engine/src/pipeline/verify.test.ts`
- Modify: `apps/image-engine/src/pipeline/optimize.ts`
- Modify: `apps/image-engine/src/job/job-runner.ts`
- Modify: `apps/image-engine/src/http/router.ts`

**Interfaces:**
- Consumes: original inspection, normalized pixel/alpha hashes, codec candidates, minimum savings, and
  pinned decode tools.
- Produces:

~~~ts
export interface CandidateVerification {
  accepted: boolean;
  reason:
    | "accepted"
    | "not-smaller"
    | "insufficient-savings"
    | "signature"
    | "decode"
    | "dimensions"
    | "orientation"
    | "color"
    | "alpha"
    | "pixel-hash"
    | "coefficient-transform"
    | "quality";
  liveQuality: {
    metricVersion: "hereisit-live-quality-v1";
    worstSsim: number;
    worstMeanChannelDelta: number;
    worstEdgeLoss: number;
  } | null;
}
export type VerifiedOptimizationResult =
  | {
      kind: "download";
      selected: CodecCandidate;
      testedCandidates: number;
      width: number;
      height: number;
      mime: "image/jpeg" | "image/png" | "image/webp";
    }
  | {
      kind: "original-retained";
      testedCandidates: number;
      width: number;
      height: number;
      mime: "image/jpeg" | "image/png" | "image/webp";
    };
export function encodeWebpCandidate(input: {
  normalizedPath: string;
  width: number;
  height: number;
  channels: 3 | 4;
  candidate: OptimizationCandidatePlan;
  outputPath: string;
  signal: AbortSignal;
}): Promise<CodecCandidate>;
export function verifyCandidate(input: {
  candidate: CodecCandidate;
  sourceBytes: number;
  minimumSavingsPercent: number;
  inspection: ImageInspection;
  normalized: NormalizedImage;
  mode: "lossless" | "smart";
  preset: "balanced" | "smallest";
  contentClass: ImageContentClass;
}): Promise<CandidateVerification>;
~~~

- [ ] **Step 1: Write failing WebP adapter tests**

Assert exact command policies:

~~~ts
expect(buildWebpArgs(losslessCandidate)).toEqual([
  "-lossless", "-m", "4", "-exact", "-metadata", "none",
  normalizedPngPath, "-o", outputPath,
]);
expect(buildWebpArgs(smartBalancedPhoto)).toEqual([
  "-q", "82", "-m", "4", "-exact", "-metadata", "none",
  normalizedPngPath, "-o", outputPath,
]);
expect(buildWebpArgs(smartBalancedGraphicNearLossless)).toEqual([
  "-near_lossless", "80", "-m", "4", "-exact", "-metadata", "none",
  normalizedPngPath, "-o", outputPath,
]);
~~~

Real tests verify RIFF/WEBP signatures, unchanged dimensions, exact alpha in lossless and smart
transparent cases, stripped metadata, deterministic lossless decode, distinct strict-lossless,
near-lossless, and lossy plans, and no animated output. `-near_lossless` is not combined with `-q`;
libwebp activates its lossless bitstream automatically.

- [ ] **Step 2: Write failing verifier matrix tests**

Test every reason code. The verifier must:

- parse signature and dimensions independently from the encoder result;
- decode with `djpeg`, Sharp/libvips, or `dwebp` according to format;
- compare lossless normalized pixel hash for PNG/WebP and orientation-1, grayscale, or 4:4:4 JPEG;
- for a subsampled JPEG orientation transform, independently parse quantized DCT blocks/sampling factors
  and verify the exact perfect coefficient permutation/sign mapping instead of decoded RGB equality;
- compare required alpha hash and three composited black/white/checkerboard quality metrics;
- verify orientation one and sRGB output policy;
- require `candidate.byteLength < sourceBytes`;
- require `floor(sourceBytes * minimumSavingsPercent / 100)` savings;
- compute the exact bounded 512 px linear-RGB live metric below.

Exact live gates:

~~~ts
const liveQualityFloor = {
  balanced: {
    defaultSsim: 0.97,
    screenshotTextSsim: 0.985,
    maxMeanChannelDelta: 2 / 255,
    maxEdgeLoss: 0.02,
  },
  smallest: {
    defaultSsim: 0.94,
    screenshotTextSsim: 0.97,
    maxMeanChannelDelta: 3 / 255,
    maxEdgeLoss: 0.04,
  },
} as const;
~~~

Lossless paths do not use a perceptual tolerance: they require exact normalized hashes or, for the
explicit perfect subsampled JPEG orientation case, exact coefficient-domain verification.

The live verifier is versioned as `hereisit-live-quality-v1` and is covered by golden scalar fixtures.
Decode source and candidate independently, composite transparent inputs over `#000000`, `#ffffff`, and
an 8-pixel `#d0d0d0/#303030` checkerboard, then reduce each image so its longest side is at most 512
pixels using separable Lanczos3 with support 3, reflected edges, and double-precision accumulation.
Convert sRGB channels to linear light with the IEC 61966-2-1 piecewise transfer function and compute:

- SSIM over linear luminance `0.2126R + 0.7152G + 0.0722B` using an 11-by-11 normalized Gaussian window,
  sigma `1.5`, reflected edges, `C1 = 0.01²`, and `C2 = 0.03²`;
- mean channel delta as the mean absolute difference across all linear RGB samples;
- edge loss as
  `sum(max(0, sourceSobelMagnitude - candidateSobelMagnitude)) /
   max(sum(sourceSobelMagnitude), 1e-12)`,
  using the standard 3-by-3 Sobel kernels and magnitude clamped to `0..1`.

For opaque images, apply the gate once. For transparent smart WebP, require an exact alpha-plane hash and
apply every threshold to all three composites, taking the worst score/delta. For strict lossless, require
the format-specific exact verifier and exact alpha hashes; do not use SSIM tolerance.

- [ ] **Step 3: Write failing original-retained and output-contract tests**

~~~ts
expect(
  await selectVerifiedResult({
    candidates: [larger, qualityFailure],
    sourceBytes: 10_000,
    minimumSavingsPercent: 1,
  }),
).toEqual({
  kind: "original-retained",
  testedCandidates: 2,
  width: 100,
  height: 100,
  mime: "image/webp",
});
~~~

Prove the runner writes no `output.bin` for original-retained, successful output metadata exactly matches
the file, and engine status includes `ORIGINAL_RETAINED_UNMODIFIED`. The HTTP output route exposes only:

~~~text
Content-Type
Content-Length
Digest
X-HereIsIt-Engine-Build
X-HereIsIt-Tested-Candidates
~~~

`Digest` uses `sha-256=<base64-standard-with-padding>` and is computed while the final file is written;
the Worker recomputes it while streaming to R2.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `pnpm test apps/image-engine/src/codecs/webp.test.ts apps/image-engine/src/pipeline/verify.test.ts --run`

Expected: FAIL because WebP and the final verifier are absent.

- [ ] **Step 5: Implement WebP, live verification, and final selection**

Create a normalized PNG input once for WebP. Invoke libwebp with argument arrays and a 15-second candidate
deadline. The verifier reads candidates independently, performs bounded downsampling and metric
calculation, and deletes every rejected candidate immediately.

Select the smallest accepted candidate, not the last candidate. If none pass, emit successful
`original-retained`. On success, atomically rename the selected file to `output.bin`, write `result.json`,
and delete all other candidate files. A later codec timeout returns the smallest already accepted
candidate. A timeout before any accepted candidate returns `ENGINE_TIMEOUT` with
`guidance: "TRY_BALANCED_PRESET"`; quality rejection without a timeout remains successful
`original-retained`.

- [ ] **Step 6: Verify GREEN across all three formats**

Run:

~~~bash
pnpm test apps/image-engine/src/codecs/webp.test.ts apps/image-engine/src/pipeline/verify.test.ts --run
pnpm --filter @hereisit/image-engine typecheck
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker run --rm --network none --entrypoint node \
  hereisit-image-engine:test /app/dist/job-runner.mjs --self-test-all-formats
~~~

Expected: PASS; the self-test returns smaller verified JPG/PNG/WebP fixtures and original-retained for a
tiny already-optimized fixture.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/image-engine/src/codecs/webp.ts \
  apps/image-engine/src/codecs/webp.test.ts \
  apps/image-engine/src/pipeline/verify.ts \
  apps/image-engine/src/pipeline/verify.test.ts \
  apps/image-engine/src/pipeline/optimize.ts \
  apps/image-engine/src/job/job-runner.ts \
  apps/image-engine/src/http/router.ts
git commit -m "feat: verify and select production image results"
~~~

### Task 16: Establish the reproducible quality, performance, and cost lab

**Files:**
- Create: `tests/image-corpus/manifest.json`
- Create: `tests/image-corpus/glyphs/korean-basic.json`
- Create: `tests/image-corpus/competitor-baseline.schema.json`
- Create: `tests/image-corpus/human-review.schema.json`
- Create: `scripts/create-image-corpus.mjs`
- Create: `scripts/record-competitor-baseline.mjs`
- Create: `scripts/record-human-review.mjs`
- Create: `scripts/benchmark-image-engine.mjs`
- Create: `scripts/create-live-cost-model.mjs`
- Create: `scripts/create-processing-release-inputs.mjs`
- Create: `scripts/verify-image-quality.mjs`
- Create: `tests/image-quality-gates.test.ts`
- Create: `tests/live-cost-model.test.ts`
- Create: `tests/processing-release-inputs.test.ts`
- Create: `tests/fixtures/live-cost-model-pr-input.json`
- Create: `docs/deployment/live-cost-model.schema.json`
- Create: `docs/deployment/processing-release-inputs.schema.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: runtime and benchmark Docker images, generated/authorized corpus files, libjxl 0.11.2 metrics,
  engine status measurements, and explicitly supplied infrastructure prices.
- Produces:

~~~ts
export interface CorpusEntry {
  id: string;
  relativePath: string;
  sha256: string;
  provenance: {
    owner: string;
    license: string;
    sourceUrl: string | null;
  };
  expected: {
    format: "jpeg" | "png" | "webp";
    width: number;
    height: number;
    bitDepth: 8 | 16;
    alpha: boolean;
    orientation: number;
    profile: "none" | "srgb" | "wide-gamut";
    animated: boolean;
    class: ImageContentClass;
  };
  strategicTags: readonly (
    | "korean-text"
    | "ui"
    | "code"
    | "logo"
    | "flat-graphic"
  )[];
  assertions: readonly string[];
}
export interface BenchmarkRecord {
  corpusId: string;
  inputMime: "image/jpeg" | "image/png" | "image/webp";
  outputMime: "image/jpeg" | "image/png" | "image/webp" | null;
  sizeBand: "tiny" | "small" | "medium" | "large";
  alpha: boolean;
  contentClass: ImageContentClass;
  strategicTags: CorpusEntry["strategicTags"];
  outcome: "download" | "original-retained" | "rejected";
  errorCode: ToolJobErrorCode | null;
  engineBuildId: string;
  codecBuildId: string;
  mode: "lossless" | "smart";
  preset: "balanced" | "smallest";
  inputBytes: number;
  outputBytes: number | null;
  effectiveDeliveredBytes: number | null;
  queueMs: number;
  coldStart: boolean;
  timeToFirstFeedbackMs: number;
  processingMs: number;
  peakMemoryBytes: number;
  weightedUnits: number;
  ssimulacra2: number | null;
  butteraugli: number | null;
  normalizedPixelMatch: boolean | null;
  losslessVerification:
    | "pixel-exact"
    | "jpeg-coefficient-exact"
    | null;
  alphaChecksPassed: boolean;
  reproducedFalseNoSizeReductionCase: boolean;
  cancellationObservedMs: number | null;
  inputDeletionLagMs: number | null;
  resultDeletionLagMs: number | null;
  costUsd: {
    compute: number;
    storage: number;
    operations: number;
    total: number;
  } | null;
}
export interface HumanReviewRecord {
  corpusId: string;
  reviewerIdHash: string;
  presentationSeed: string;
  hereisitSide: "left" | "right";
  preference: "hereisit" | "baseline" | "tie";
  severeDefect: boolean;
  defect:
    | "none"
    | "text"
    | "edge"
    | "banding"
    | "color"
    | "alpha"
    | "blocking"
    | "other";
}
export interface CompetitorBaselineRecord {
  vendor: string;
  tool: string;
  toolVersionOrObservedBuild: string;
  observedAt: string;
  settings: Readonly<Record<string, string | number | boolean>>;
  authorization: {
    owner: string;
    basis: "owned-input" | "written-permission";
    referenceHash: string;
  };
  corpusId: string;
  inputSha256: string;
  outputSha256: string;
  outputMime: "image/jpeg" | "image/png" | "image/webp";
  outputBytes: number;
  width: number;
  height: number;
  metricBuildIds: { ssimulacra2: string; butteraugli: string };
  ssimulacra2: number | null;
  butteraugli: number | null;
  normalizedPixelMatch: boolean | null;
}
~~~

- [ ] **Step 1: Write the failing manifest and gate tests**

Assert every file hash and metadata field, unique IDs, permitted fixture licenses, and required classes:
ordinary/photo-like, portrait, night/noisy, Korean text, UI, code, logo, illustration, gradient, flat
graphic, transparent, semi-transparent, already-optimized, orientation, profile, odd/large dimensions,
malformed, truncated, and decompression-bomb regression.

Gate tests load a fixed report and prove each exact threshold from Global Constraints fails independently,
including the false-`NO_SIZE_REDUCTION` 90% gate, cold-start/first-feedback gates, human review, measured
cost ceiling, and strategic-class advantage. Every required strategic tag must have at least three
authorized fixtures and at least one human-reviewed fixture; a missing group fails rather than silently
dropping from aggregation. The release manifest declares required strata with a minimum of three
successful samples for each relevant MIME × input-size band × alpha/opaque × content-class combination.
Size bands are `<100 KiB`, `100 KiB–1 MiB`, `>1–10 MiB`, and `>10–30 MiB`. JPEG declares only opaque
strata; PNG/WebP declare both where the corpus class supports alpha. The global gate and every declared
stratum gate must pass independently; no weighted aggregate may hide a failing PNG, WebP, alpha, or
large-file segment.

`live-cost-model.test.ts` rejects a missing/negative coefficient, unknown field, decimal precision loss,
obsolete trace-span price, incomplete 24-element arrival scenario, scenario-hash mismatch, or regional
Container egress coefficient below the maximum signed region rate. It proves canonical JSON and SHA-256
are identical across host locale/order and across explicit flags, raw model-input JSON, and the verified
production release-input document; the latter must bind the same route benchmark/module hash and cannot
override a model field.

`processing-release-inputs.test.ts` creates one strict non-secret release input document from the
reviewed price/resource JSON, quality/cost ceilings, and an immutable Worker route benchmark. It requires
measured `policy|create|upload|read|result|maintenance|queue` CPU envelopes with benchmark artifact
SHA-256 and margin rule, exact release ID/base-source SHA, rejects a
default/placeholder/secret/path/unknown field, and proves the document hash is stable and cannot be
overwritten.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test tests/image-quality-gates.test.ts tests/live-cost-model.test.ts tests/processing-release-inputs.test.ts --run`

Expected: FAIL because the manifest, generator, and gate evaluator are absent.

- [ ] **Step 3: Generate an owned public PR corpus**

`create-image-corpus.mjs` deterministically creates and hashes at least 24 HereIsIt-owned fixtures:

- seeded RGB photographs/noise fields with portrait and night lighting;
- Korean text, UI controls, and code using the committed HereIsIt-owned vector glyph table
  `tests/image-corpus/glyphs/korean-basic.json`; do not call an OS font renderer;
- logos, gradients, flat colors, odd dimensions, transparency, and semi-transparent fringes;
- EXIF orientation and sRGB/wide-gamut profile cases;
- real JPEG gray/YCbCr/RGB/CMYK/YCCK marker/profile combinations, including CMYK/YCCK with and without
  valid ICC data and conflicting Adobe transforms;
- already-optimized output produced by the pinned runtime;
- malformed, truncated, oversized-header, and bomb-declaration samples that never allocate the declared
  pixels.

Write generated binaries under `tests/image-corpus/public/` and commit them with the manifest. Add
`tests/image-corpus/private/` and `tests/image-corpus/competitor-output/` to `.gitignore`; release runs may
include only operator-authorized files from those directories.

- [ ] **Step 4: Implement benchmark and competitor-baseline ingestion**

`benchmark-image-engine.mjs`:

1. verifies each input SHA-256;
2. runs the runtime container with CPU/memory measurement;
3. invokes benchmark-container `ssimulacra2` and `butteraugli_main` with version/build ID recorded;
4. writes canonical JSON sorted by corpus ID/mode/preset;
5. accepts only a schema-verified `--live-cost-model <path>` plus projected arrival inputs for a cost
   report.

`--scope release` always produces the cost report and therefore refuses a missing model, model/release
input hash mismatch, or absent/non-24-element embedded steady/bursty/sparse arrival scenarios.

`create-live-cost-model.mjs` is the sole canonical producer of that file. It accepts either every
mandatory flag below, one schema-validated `--input` JSON containing exactly the same fields, or the
model section plus bound route benchmark in a verified `--release-inputs` document; mixed, partial, or
unknown input is rejected and tests prove all three forms produce identical bytes. Production release
builds permit only `--release-inputs`. It converts
decimal USD to checked integer microusd, writes
`live-cost-model.schema.json` canonical JSON atomically, and prints its SHA-256:

~~~text
--container-vcpu-second-usd
--container-gib-second-usd
--container-disk-gb-second-usd
--container-egress-region-prices-json
--container-instance-vcpu
--container-instance-memory-gib
--container-instance-disk-gb
--workers-million-requests-usd
--workers-million-cpu-ms-usd
--do-million-requests-usd
--do-gib-second-usd
--do-storage-gb-month-usd
--r2-gb-month-usd
--r2-class-a-million-usd
--r2-class-b-million-usd
--queue-million-ops-usd
--d1-million-rows-read-usd
--d1-million-rows-written-usd
--d1-storage-gb-month-usd
--observability-million-log-events-usd
--workers-logpush-million-events-usd
--analytics-engine-million-data-points-usd
--analytics-engine-million-read-queries-usd
--route-cpu-benchmark-json
--monthly-fixed-usd
--projected-monthly-jobs
--arrival-trace-steady
--arrival-trace-bursty
--arrival-trace-sparse
~~~

No price or infrastructure size has a non-zero default. The model stores
`containerEgressGbMicrousd` as the maximum value in the signed regional price map, records that map's
SHA-256, and never assumes a placement region; observed Container usage may group by region for
diagnostics but the admission circuit always prices transmitted bytes at that conservative maximum.
The route benchmark input must contain all seven Worker route/event classes from the exact no-bundle
module and toolchain; the producer applies the reviewed p99-plus-margin rule and records both benchmark
hash and resulting `routeCpuEnvelopeMs`. No route envelope is hardcoded or defaulted.
Arrival traces are immutable JSON timestamp
series that model steady traffic, bursts, and sparse one-off jobs. The calculator includes the configured
60-second `sleepAfter` active tail, cold starts, vCPU, memory, disk, Worker/D1/Queue/R2 operations, and
regional container egress. It also counts SQLite-backed Durable Object requests and duration for
container start, every 250 ms engine poll, status/output/remove calls, and DO storage. D1 storage is
estimated from measured row plus index bytes under the 24-hour job/ledger/quarantine retention and
35-day aggregate-usage retention, then priced with `--d1-storage-gb-month-usd`; it cannot disappear into
the fixed-cost term. Sampled allowlisted Worker logs and normalized Container stdout/stderr are counted
as observability log events with included quotas and `--observability-million-log-events-usd`.
Production automatic traces remain disabled and no trace-span coefficient exists. Workers Trace Events
Logpush and Analytics Engine coefficients are mandatory because the production accounting path uses
them. The release fails
if any arrival scenario exceeds the approved monthly or
per-1,000-job ceiling. `record-competitor-baseline.mjs` accepts manually downloaded outputs from
HereIsIt-owned or explicitly authorized fixtures, checks hashes and format, runs the same metrics, and
writes the exact `CompetitorBaselineRecord` without automating third-party uploads.

The comparable-quality algorithm joins only identical `corpusId` and input hash, same output format and
dimensions, and the pinned metric build IDs. Lossless pairs require normalized pixel equality. Lossy
pairs are comparable only when HereIsIt is no more than 1.0 SSIMULACRA2 point below the baseline and no
more than 0.1 worse on the pinned Butteraugli scale. Size ratios are computed only inside those matched
pairs, then evaluated globally and inside every declared stratum and strategic tag; unmatched, missing,
mixed-version, resized, format-converted, or unauthorized records fail the release instead of being
omitted. `outputBytes` is non-null only for a verified download. `effectiveDeliveredBytes` equals that
output for `download`, equals `inputBytes` for `original-retained`, and is null for `rejected`; all
fleet-level savings/ratio calculations use the effective value so original-retained outcomes cannot
make compression look artificially better. Rejections count against success and required-stratum sample
coverage.

`record-human-review.mjs` creates a double-blind local review sheet for at least 20 authorized strategic
fixtures, randomizes left/right with a stored seed, shows source/HereIsIt/baseline at 100% and 400%, and
writes only the schema above. It never uploads competitor files. The release gate requires zero
`severeDefect`, at least 80% `hereisit|tie`, and `hereisit` preferences greater than or equal to baseline
preferences. Strategic classes are `screenshot-text`, Korean text, UI, code, logo, and flat graphic; their
median HereIsIt output must be at least 5% smaller than the authorized baseline while staying within the
offline metric tolerances, and no strategic class may be more than 5% larger.

- [ ] **Step 5: Implement immutable release gates**

`verify-image-quality.mjs` rejects:

- mixed metric versions/build IDs;
- missing authorized competitor measurements;
- larger selected output;
- lossless mismatch under the required pixel-exact or JPEG coefficient-exact verifier;
- alpha/composite mismatch;
- any severe color/orientation failure;
- success below 99%;
- metric, savings, competitor, strategic-class, timing, memory, cancellation, deletion, or measured-cost
  threshold failures.

The exact additional operational gates are: policy response p95 at most 500 ms; local UI feedback after
create/upload progress at most 100 ms; a 30 MiB Worker upload uses streaming with no whole-body
allocation and p95 Worker CPU at most 100 ms excluding network transfer; 12 MP cold end-to-end p95 at
most 20 seconds; first native phase
after a cold create p95 at most 8 seconds; input deletion p99 at most 60 seconds after terminal state;
acknowledged result deletion p99 at most 10 seconds; healthy application-sweeper result deletion p99 at
most 35 minutes, with every miss treated as an SLO incident rather than hidden by lifecycle cleanup; and
cost per 1,000 representative jobs no greater than the mandatory
`--max-cost-per-1000-jobs-usd` release input. No cost ceiling has a default.

The output includes the engine image digest, source lock hash, corpus manifest hash, metric build IDs, and
the exact configuration. Codec promotion is a reviewed config change; benchmark results never mutate
production config automatically.

- [ ] **Step 6: Run the public lab and verify GREEN**

Run:

~~~bash
docker build -f apps/image-engine/Dockerfile --target runtime -t hereisit-image-engine:test .
docker build -f apps/image-engine/Dockerfile --target benchmark -t hereisit-image-engine:benchmark .
node scripts/create-image-corpus.mjs \
  --verify-clean \
  --runtime-image hereisit-image-engine:test
node scripts/create-live-cost-model.mjs \
  --input tests/fixtures/live-cost-model-pr-input.json \
  --schema docs/deployment/live-cost-model.schema.json \
  --output .artifacts/live-cost-model-pr.json
pnpm test tests/image-quality-gates.test.ts tests/live-cost-model.test.ts --run
node scripts/benchmark-image-engine.mjs \
  --engine-image hereisit-image-engine:test \
  --metric-image hereisit-image-engine:benchmark \
  --manifest tests/image-corpus/manifest.json \
  --live-cost-model .artifacts/live-cost-model-pr.json \
  --scope pr \
  --output .artifacts/image-benchmark-pr.json
node scripts/verify-image-quality.mjs \
  --report .artifacts/image-benchmark-pr.json \
  --scope pr
~~~

Expected: generator reports no drift; tests and the reduced PR gate PASS. The release gate remains
separate and requires the authorized full corpus, competitor baseline, staging performance, and explicit
production price inputs in a canonical signed live-cost model.

- [ ] **Step 7: Commit**

~~~bash
git add \
  tests/image-corpus \
  scripts/create-image-corpus.mjs \
  scripts/record-competitor-baseline.mjs \
  scripts/record-human-review.mjs \
  scripts/benchmark-image-engine.mjs \
  scripts/create-live-cost-model.mjs \
  scripts/create-processing-release-inputs.mjs \
  scripts/verify-image-quality.mjs \
  tests/image-quality-gates.test.ts \
  tests/live-cost-model.test.ts \
  tests/processing-release-inputs.test.ts \
  tests/fixtures/live-cost-model-pr-input.json \
  docs/deployment/live-cost-model.schema.json \
  docs/deployment/processing-release-inputs.schema.json \
  .gitignore
git commit -m "test: establish image optimization quality lab"
~~~

### Task 17: Prove the full stack under duplicate, failure, deletion, and browser flows

**Files:**
- Create: `apps/api-worker/test/worker.integration.test.ts`
- Create: `scripts/test-processing-stack.mjs`
- Create: `scripts/smoke-image-compress-server.mjs`
- Create: `scripts/fuzz-image-engine.mjs`
- Modify: `tests/e2e/image-compression-server.spec.ts`
- Modify: `tests/e2e/image-workbench.spec.ts`
- Modify: `tests/e2e/tool-pages.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: local Worker bindings, real Docker engine, the same authenticated Worker streaming upload in
  local/staging/production, static web build, and all public routes.
- Produces root verification commands:

~~~json
{
  "test:worker": "pnpm --filter @hereisit/api-worker test:integration",
  "test:processing-stack": "node scripts/test-processing-stack.mjs",
  "test:image-engine:fuzz:pr": "node scripts/fuzz-image-engine.mjs --duration-seconds 60 --seed 20260716",
  "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm test:worker && pnpm test:image-engine:fuzz:pr && pnpm build && pnpm verify:export",
  "verify:all": "pnpm verify && pnpm test:processing-stack && pnpm test:e2e"
}
~~~

- [ ] **Step 1: Write failing Worker integration scenarios**

Using `@cloudflare/vitest-pool-workers`, local D1/R2/Queue, fixed time, and a fake EngineClient, cover:

1. policy → create → exact-length upload → outbox → Queue → download → acknowledgement;
2. replayed upload completion and duplicate Queue delivery;
3. queue send failure followed by scheduled outbox recovery;
4. active cancellation race;
5. whole-engine wall timeout retry twice then terminal release of unused reservation while settling
   measured cost, while a codec-candidate timeout is
   non-retryable and returns faster-preset guidance;
6. standard OOM one permitted large-class retry and large-class OOM terminal measured-cost settlement;
7. storage write failure;
8. original-retained with no output object;
9. cross-job token/object confusion;
10. every deletion path and a second idempotent sweep;
11. logs containing no token, filename, URL, object credential, or file bytes.

- [ ] **Step 2: Write failing real local-stack scenarios**

`test-processing-stack.mjs` starts the engine container, local Wrangler Worker, and static Pages preview on
available ports, waits for both health endpoints, then tests real stream transfer with JPEG/PNG/WebP,
cancellation, malformed input, a declared bomb, larger-candidate rejection, and result deletion. It
prints the chosen ports at startup and kills every child in `finally`.

`fuzz-image-engine.mjs` deterministically mutates JPEG/PNG/WebP headers, chunk lengths, metadata lengths,
dimensions, truncation points, and byte flips from the owned corpus. It runs each case with the same
resource limits, records only seed/case ID/normalized outcome, fails on crash, hang, resource escape, or
unclassified error, exercises both the main inspector and `jpeg-coeff-verify`, and writes a minimized
reproducer under `.artifacts/fuzz/` without logging bytes.
PRs run 60 seconds with seed `20260716`; nightly CI runs 1,800 seconds with a date-derived seed and uploads
reproducers only to the private workflow artifact.

- [ ] **Step 3: Complete browser E2E cases**

Use the same local Worker streaming upload for deterministic CI. Assert desktop Chromium, mobile Chromium, Firefox, and CI
WebKit behavior:

- disclosure appears before file selection;
- upload byte progress increases;
- queue/native phase labels are honest;
- same-format result downloads directly with the local source-derived name;
- no share API is called even when mocked;
- one batch item is downloadable while a later item runs;
- original-retained downloads the original local file and does not request `/result`;
- original-retained visibly warns that the unmodified local original may retain metadata;
- retry guidance and local fallback are distinguishable;
- cancel reaches the API and clears temporary UI state;
- 320 px mobile has no horizontal overflow and the bottom action respects safe area;
- no console or network record contains source filename except the browser-local DOM and download event.

Move old `/image/compress` assertions out of generic `image-workbench.spec.ts`. Keep home, resize, and
convert local tests. Replace the current share-sheet test with a direct-download test.

Before production, run and attach a manual real-device matrix on current iOS Safari, Android Chrome,
Samsung Internet, and the current KakaoTalk, Naver, and Instagram in-app browsers. Record exact
device/OS/browser or app version, user agent, single-download and ZIP handoff result, retry after
interrupted fetch, background/foreground transition, low storage, filename preservation, and whether the
tab reloads under the 32 MiB archive corpus. For inspectable iOS Safari/Android Chrome/Samsung Internet,
record renderer/JS-memory delta and require no more than 96 MiB for that corpus; a regression or crash
disables mobile ZIP rather than raising the cap. A browser class that cannot prove direct handoff keeps
the server result and shows `기본 브라우저에서 열어 다시 다운로드해 주세요` plus retry instructions;
it never invokes share. It may not acknowledge/delete merely because `anchor.click()` returned.

- [ ] **Step 4: Run tests and verify RED**

Run:

~~~bash
pnpm test:worker
pnpm test:image-engine:fuzz:pr
pnpm test:processing-stack
pnpm exec playwright test tests/e2e/image-compression-server.spec.ts --project=chromium
~~~

Expected: FAIL until the integration harness, stack script, and complete E2E routes exist.

- [ ] **Step 5: Implement integration harnesses and root scripts**

Use random loopback ports discovered by binding port zero, never fixed sleeps. Forward each child stdout
through a redactor that removes Authorization values and job upload paths before test output. The staging
smoke launches from `https://processing-staging.hereisit.pages.dev` and uses a real browser Worker PUT so
the browser, not a synthetic Node `Origin` header, enforces API CORS. It proves missing/short/over-limit
`Content-Length` paths are rejected, the accepted body is streamed without whole-file buffering, and
cross-origin JavaScript can read `Retry-After` and `X-Download-Lease` from the exact exposed-header list.

- [ ] **Step 6: Verify GREEN across unit, Worker, stack, and browser**

Run:

~~~bash
pnpm test:worker
pnpm test:image-engine:fuzz:pr
pnpm test:processing-stack
pnpm build
pnpm exec playwright test tests/e2e/image-compression-server.spec.ts
pnpm verify
git diff --check
~~~

Expected: all checks PASS; the local stack reports zero orphan objects after its final sweep.

- [ ] **Step 7: Commit**

~~~bash
git add \
  apps/api-worker/test \
  scripts/test-processing-stack.mjs \
  scripts/smoke-image-compress-server.mjs \
  scripts/fuzz-image-engine.mjs \
  tests/e2e \
  playwright.config.ts \
  package.json \
  pnpm-lock.yaml
git commit -m "test: verify production image processing stack"
~~~

### Task 18: Add CI, Cloudflare provisioning, canary rollout, and rollback operations

**Files:**
- Create: `scripts/generate-processing-wrangler.mjs`
- Create: `tests/generate-processing-wrangler.test.ts`
- Create: `scripts/rollback-processing.mjs`
- Create: `tests/rollback-processing.test.ts`
- Create: `scripts/rollback-web.mjs`
- Create: `tests/rollback-web.test.ts`
- Create: `scripts/promote-processing-rollout.mjs`
- Create: `tests/promote-processing-rollout.test.ts`
- Create: `scripts/record-processing-deployment.mjs`
- Create: `tests/record-processing-deployment.test.ts`
- Create: `scripts/inspect-processing-job.mjs`
- Create: `tests/inspect-processing-job.test.ts`
- Create: `scripts/resolve-cloudflare-image-digest.mjs`
- Create: `tests/resolve-cloudflare-image-digest.test.ts`
- Create: `scripts/read-wrangler-output.mjs`
- Create: `tests/read-wrangler-output.test.ts`
- Create: `scripts/download-and-verify-github-artifact.mjs`
- Create: `tests/download-and-verify-github-artifact.test.ts`
- Create: `scripts/resolve-github-release-assets.mjs`
- Create: `tests/resolve-github-release-assets.test.ts`
- Create: `scripts/read-processing-release-assets.mjs`
- Create: `tests/read-processing-release-assets.test.ts`
- Create: `docs/deployment/processing-release-assets.schema.json`
- Create: `scripts/create-deterministic-tree-archive.mjs`
- Create: `tests/create-deterministic-tree-archive.test.ts`
- Create: `scripts/verify-and-extract-tree-archive.mjs`
- Create: `tests/verify-and-extract-tree-archive.test.ts`
- Create: `scripts/ensure-cloudflare-processing-resources.mjs`
- Create: `tests/ensure-cloudflare-processing-resources.test.ts`
- Create: `scripts/read-resource-manifest.mjs`
- Create: `tests/read-resource-manifest.test.ts`
- Create: `scripts/verify-worker-secret-list.mjs`
- Create: `tests/verify-worker-secret-list.test.ts`
- Create: `scripts/verify-worker-version-chain.mjs`
- Create: `tests/verify-worker-version-chain.test.ts`
- Create: `docs/deployment/worker-version-attestations.schema.json`
- Create: `scripts/verify-pages-alias.mjs`
- Create: `tests/verify-pages-alias.test.ts`
- Create: `scripts/verify-privacy-review.mjs`
- Create: `tests/verify-privacy-review.test.ts`
- Create: `scripts/verify-web-licenses.mjs`
- Create: `tests/verify-web-licenses.test.ts`
- Create: `scripts/verify-vulnerability-results.mjs`
- Create: `tests/verify-vulnerability-results.test.ts`
- Create: `scripts/verify-processing-release-request.mjs`
- Create: `tests/verify-processing-release-request.test.ts`
- Create: `scripts/read-processing-release-request.mjs`
- Create: `tests/read-processing-release-request.test.ts`
- Create: `scripts/create-processing-release-request.mjs`
- Create: `tests/create-processing-release-request.test.ts`
- Create: `docs/deployment/processing-release-request.schema.json`
- Create: `scripts/create-processing-release-report.mjs`
- Create: `tests/create-processing-release-report.test.ts`
- Create: `scripts/verify-processing-release-report.mjs`
- Create: `tests/verify-processing-release-report.test.ts`
- Create: `docs/deployment/processing-release-report.schema.json`
- Create: `scripts/verify-processing-candidate.mjs`
- Create: `tests/verify-processing-candidate.test.ts`
- Create: `scripts/create-processing-candidate.mjs`
- Create: `tests/create-processing-candidate.test.ts`
- Create: `scripts/finalize-processing-candidate.mjs`
- Create: `tests/finalize-processing-candidate.test.ts`
- Create: `scripts/read-processing-candidate.mjs`
- Create: `tests/read-processing-candidate.test.ts`
- Create: `docs/deployment/processing-candidate.schema.json`
- Create: `docs/deployment/processing-deployment.schema.json`
- Create: `docs/deployment/cloudflare-provider-usage.schema.json`
- Create: `tests/processing-release-chain.test.ts`
- Create: `scripts/create-processing-evidence-bundle.mjs`
- Create: `tests/create-processing-evidence-bundle.test.ts`
- Create: `scripts/verify-processing-evidence-bundle.mjs`
- Create: `tests/verify-processing-evidence-bundle.test.ts`
- Create: `docs/deployment/processing-evidence.schema.json`
- Create: `docs/deployment/processing-evidence-ed25519-public.pem`
- Create: `scripts/reconcile-restored-processing-db.mjs`
- Create: `tests/reconcile-restored-processing-db.test.ts`
- Create: `scripts/verify-queue-delivery-state.mjs`
- Create: `tests/verify-queue-delivery-state.test.ts`
- Create: `security/application-vulnerability-exceptions.json`
- Create: `security/application-license-policy.json`
- Create: `apps/web/public/THIRD_PARTY_NOTICES.txt` (generated)
- Create: `.github/workflows/image-engine.yml`
- Create: `tests/image-engine-workflow.test.ts`
- Create: `docs/runbooks/image-processing.md`
- Create: `apps/api-worker/migrations/0002_rollout_control.sql`
- Create: `apps/api-worker/src/circuit-breaker.ts`
- Create: `apps/api-worker/src/circuit-breaker.test.ts`
- Create: `apps/api-worker/src/operational-alerts.ts`
- Create: `apps/api-worker/src/operational-alerts.test.ts`
- Create: `apps/api-worker/src/live-cost.ts`
- Create: `apps/api-worker/src/live-cost.test.ts`
- Create: `apps/api-worker/src/usage-analytics.ts`
- Create: `apps/api-worker/src/usage-analytics.test.ts`
- Modify: `apps/api-worker/src/d1-job-repository.ts`
- Modify: `apps/api-worker/src/d1-job-repository.test.ts`
- Modify: `apps/api-worker/src/routes/jobs.ts`
- Modify: `apps/api-worker/src/routes/jobs.test.ts`
- Modify: `apps/api-worker/src/routes/uploads.ts`
- Modify: `apps/api-worker/src/routes/uploads.test.ts`
- Modify: `apps/api-worker/src/routes/results.ts`
- Modify: `apps/api-worker/src/routes/results.test.ts`
- Modify: `apps/api-worker/src/routes/policy.ts`
- Modify: `apps/api-worker/src/routes/policy.test.ts`
- Modify: `apps/api-worker/src/outbox.ts`
- Modify: `apps/api-worker/src/outbox.test.ts`
- Modify: `apps/api-worker/src/queue-consumer.ts`
- Modify: `apps/api-worker/src/queue-consumer.test.ts`
- Modify: `apps/api-worker/src/container-client.ts`
- Modify: `apps/api-worker/src/container-client.test.ts`
- Modify: `apps/api-worker/src/r2-artifacts.ts`
- Modify: `apps/api-worker/src/r2-artifacts.test.ts`
- Modify: `apps/api-worker/src/telemetry.ts`
- Modify: `apps/api-worker/src/telemetry.test.ts`
- Modify: `apps/api-worker/src/env.ts`
- Modify: `apps/api-worker/src/sweeper.ts`
- Modify: `apps/api-worker/src/sweeper.test.ts`
- Modify: `apps/api-worker/src/index.ts`
- Modify: `apps/api-worker/test/worker.integration.test.ts`
- Modify: `apps/api-worker/wrangler.local.jsonc`
- Modify: `apps/api-worker/src/worker-configuration.d.ts` (generated)
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/deployment.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Cloudflare account login, resource IDs returned by Wrangler, explicit budget, immutable
  benchmark/human/legal review artifacts, and immutable image digest.
- Produces:

~~~text
.wrangler/generated/wrangler.staging.jsonc
.wrangler/generated/wrangler.production.jsonc
.artifacts/candidate/processing-candidate.json
.artifacts/processing-release-request.json
.artifacts/deployments/processing-production-<version-id>.json
~~~

with no committed account ID, D1 ID, secret, or custom hostname.

- [ ] **Step 1: Write failing config-generator and deployment-helper tests**

~~~ts
expect(
  generateProcessingWrangler({
    environment: "staging",
    accountId: "0123456789abcdef0123456789abcdef",
    databaseId: "11111111-2222-3333-4444-555555555555",
    appOrigins: [
      "http://127.0.0.1:4173",
      "http://localhost:4173",
      "https://processing-staging.hereisit.pages.dev",
    ],
    bucketName: "hereisit-processing-staging",
    usageLogBucketName: "hereisit-processing-usage-staging",
    usageAnalyticsDatasetName: "hereisit_processing_usage_staging",
    queueName: "hereisit-image-jobs-staging",
    dlqName: "hereisit-image-jobs-dlq-staging",
    engineImage:
      "registry.cloudflare.com/0123456789abcdef0123456789abcdef/hereisit-image-engine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    accountDailyWeightedUnitLimit: 80_000_000_000,
    anonymousDailyWeightedUnitLimit: 8_000_000_000,
    networkDailyWeightedUnitLimit: 24_000_000_000,
    accountPendingJobLimit: 10,
    networkPendingJobLimit: 3,
    maximumQueuedAgeSeconds: 600,
    maximumLiveMedianOutputRatioBasisPoints: 8500,
    maximumLiveP95WeightedUnits: 150_000_000,
    maximumLiveOriginalRetainedRateBasisPoints: 7000,
    maximumLiveCostPer1000Microusd: 500_000,
    maximumProjectedMonthlyCostMicrousd: 100_000_000,
    liveCostModel: validLiveCostModel,
    liveCostModelSha256: "c".repeat(64),
    providerUsageSchemaSha256: "e".repeat(64),
    releaseReportSha256: "d".repeat(64),
    rolloutPercent: 0,
    maintainerSessionHashes: ["b".repeat(64)],
    sessionRateLimitNamespaceId: "21001",
    networkRateLimitNamespaceId: "21002",
    jobReadRateLimitNamespaceId: "21003",
    resultDownloadRateLimitNamespaceId: "21004",
    policyRateLimitNamespaceId: "21005",
    jobApiNetworkRateLimitNamespaceId: "21006",
    alertDestinationAddress: "operator@example.com",
  }),
).toMatchObject({
  name: "hereisit-processing-staging",
  main: "../../apps/api-worker/src/index.ts",
  compatibility_date: "2026-07-16",
  workers_dev: true,
  logpush: true,
  vars: {
    ENVIRONMENT: "staging",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    APP_ORIGINS: JSON.stringify([
      "http://127.0.0.1:4173",
      "http://localhost:4173",
      "https://processing-staging.hereisit.pages.dev",
    ]),
    R2_BUCKET_NAME: "hereisit-processing-staging",
    USAGE_LOG_BUCKET_NAME: "hereisit-processing-usage-staging",
    USAGE_ANALYTICS_DATASET_NAME: "hereisit_processing_usage_staging",
    ACCOUNT_DAILY_WEIGHTED_UNIT_LIMIT: "80000000000",
    ANONYMOUS_DAILY_WEIGHTED_UNIT_LIMIT: "8000000000",
    NETWORK_DAILY_WEIGHTED_UNIT_LIMIT: "24000000000",
    ACCOUNT_PENDING_JOB_LIMIT: "10",
    NETWORK_PENDING_JOB_LIMIT: "3",
    MAX_QUEUED_AGE_SECONDS: "600",
    MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS: "8500",
    MAX_LIVE_P95_WEIGHTED_UNITS: "150000000",
    MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS: "7000",
    MAX_LIVE_COST_PER_1000_MICROUSD: "500000",
    MAX_PROJECTED_MONTHLY_COST_MICROUSD: "100000000",
    LIVE_COST_MODEL_JSON: JSON.stringify(validLiveCostModel),
    LIVE_COST_MODEL_SHA256: "c".repeat(64),
    PROVIDER_USAGE_SCHEMA_SHA256: "e".repeat(64),
    RELEASE_REPORT_SHA256: "d".repeat(64),
    IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT: "0",
    MAINTAINER_SESSION_HASHES: JSON.stringify(["b".repeat(64)]),
    ENGINE_INSTANCE_NAME: "image-slot-0",
    IMAGE_JOBS_QUEUE_NAME: "hereisit-image-jobs-staging",
    IMAGE_JOBS_DLQ_NAME: "hereisit-image-jobs-dlq-staging",
    ENGINE_IMAGE_DIGEST:
      "registry.cloudflare.com/0123456789abcdef0123456789abcdef/hereisit-image-engine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  r2_buckets: [
    {
      binding: "JOB_OBJECTS",
      bucket_name: "hereisit-processing-staging",
    },
    {
      binding: "USAGE_LOGS",
      bucket_name: "hereisit-processing-usage-staging",
    },
  ],
  analytics_engine_datasets: [
    {
      binding: "USAGE_ANALYTICS",
      dataset: "hereisit_processing_usage_staging",
    },
  ],
  version_metadata: {
    binding: "WORKER_VERSION",
  },
  queues: {
    consumers: [
      expect.objectContaining({
        queue: "hereisit-image-jobs-staging",
        max_batch_size: 1,
        max_concurrency: 1,
        max_retries: 2,
        dead_letter_queue: "hereisit-image-jobs-dlq-staging",
      }),
      expect.objectContaining({
        queue: "hereisit-image-jobs-dlq-staging",
        max_batch_size: 1,
        max_concurrency: 1,
        max_retries: 0,
      }),
    ],
  },
  containers: [
    expect.objectContaining({
      class_name: "ImageEngineContainer",
      image:
        "registry.cloudflare.com/0123456789abcdef0123456789abcdef/hereisit-image-engine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      instance_type: "standard-2",
      max_instances: 1,
    }),
  ],
  migrations: [
    {
      tag: "image-engine-v1",
      new_sqlite_classes: ["ImageEngineContainer"],
    },
  ],
  ratelimits: [
    {
      name: "SESSION_JOB_RATE_LIMITER",
      namespace_id: "21001",
      simple: { limit: 20, period: 60 },
    },
    {
      name: "NETWORK_JOB_RATE_LIMITER",
      namespace_id: "21002",
      simple: { limit: 10, period: 60 },
    },
    {
      name: "JOB_READ_RATE_LIMITER",
      namespace_id: "21003",
      simple: { limit: 90, period: 60 },
    },
    {
      name: "RESULT_DOWNLOAD_RATE_LIMITER",
      namespace_id: "21004",
      simple: { limit: 3, period: 60 },
    },
    {
      name: "POLICY_RATE_LIMITER",
      namespace_id: "21005",
      simple: { limit: 60, period: 60 },
    },
    {
      name: "JOB_API_NETWORK_RATE_LIMITER",
      namespace_id: "21006",
      simple: { limit: 180, period: 60 },
    },
  ],
  send_email: [
    {
      name: "ALERT_EMAIL",
      destination_address: "operator@example.com",
    },
  ],
});
~~~

Reject negative limits, rollout outside 0–100, duplicate or non-integer Rate Limit namespaces,
non-HTTPS production origins, invalid or cross-environment usage dataset/bucket names, unknown resource
names, missing IDs, a mutable image tag, or a digest whose
account ID differs from the supplied account. Production account, anonymous, and network limits of `0`
are valid and keep jobs disabled. Any non-zero rollout or non-empty maintainer allowlist requires all
three limits to cover at least one maximum standard attempt, positive live/per-month cost ceilings, and
every strict live-cost coefficient; otherwise generation fails before deploy. Staging requires
rollout `0`, at least one maintainer hash, no production origin, and a verified alert destination.
Assert all generated paths are correct relative to `.wrangler/generated/`, the
D1 binding uses `migrations_dir: "../../apps/api-worker/migrations"`, both private R2 bindings, the
environment-specific Analytics Engine dataset, Version Metadata, and Durable Object bindings are
present, all six Rate Limit bindings include the exact `simple` limits above, and no secret or public R2
upload origin is serialized.

Add table tests for the other deployment helpers before implementing them:

- `resolve-cloudflare-image-digest.test.ts` accepts a single manifest and an array containing exactly one
  linux/amd64 image plus unknown-platform attestations; it rejects zero or multiple linux/amd64 images,
  a non-Cloudflare registry, account/repository/`Ref` mismatch, a mutable tag output, or a non-SHA-256
  digest. It also requires the registry image config and ordered layer digests to match the finalized
  candidate identity while allowing a different top-level registry manifest/media type.
- `read-wrangler-output.test.ts` reads newline-delimited Wrangler records. For Workers it selects exactly
  one `{ type: "deploy", version: 1 }`; for Pages it accepts the exact Wrangler 4.110
  `{ type: "pages-deploy", version: 1, pages_project, deployment_id, url }`, cross-checks the paired
  detailed record/project/branch when requested, and never mistakes `pages-deploy-detailed` for the
  primary record. It rejects `command-failed`, malformed lines, missing/duplicate deploys, wrong
  project/branch, non-HTTPS targets, and arbitrary field traversal.
- `download-and-verify-github-artifact.test.ts` resolves an artifact only by repository, run ID,
  source-run head SHA, exact name, artifact ID, size, and GitHub-reported digest; downloads the original
  ZIP bytes through the authenticated API, verifies SHA-256 before extraction, rejects expired/deleted or
  duplicate artifacts, zip-slip/symlink/extra-root entries, and atomically extracts only after every
  check. Local `gh run download` extraction is never treated as digest proof.
- `resolve-github-release-assets.test.ts` queries one private release by repository and immutable tag,
  requires the exact non-duplicate `candidate-v1--<release-id>--*` asset names, IDs, sizes, and download
  URLs, downloads every candidate asset through authenticated GitHub API bytes, recomputes SHA-256,
  verifies Pages archives against
  their candidate tree hashes, and emits canonical
  `processing-release-assets.json`. It permits only separately namespaced, unique
  `evidence-v1--<release-id>--processing-evidence.{json,sig}` roots already bound into the finalized
  candidate and
  `control-v1--<monotonic-sequence>--<record-type>--<sha256>.json` assets added later and ignores them for
  candidate-set equality; an unknown asset, candidate-prefix extra, control record with invalid
  name/schema/predecessor, missing/overwritten asset, wrong tag target/source SHA, unauthenticated
  redirect, or candidate/asset mismatch fails. The manifest intentionally excludes itself to avoid a
  self-referential asset ID. In `--control-asset` mode it downloads exactly one
  name/ID/size/SHA-selected control record, validates its schema, monotonic sequence, and predecessor
  chain, and never requires the corresponding Actions artifact to remain available.
- `read-processing-release-assets.test.ts` reads only schema-allowlisted scalars such as
  `web.staging.assetId` or `worker.assetId` from a freshly resolved and candidate-bound asset manifest;
  arbitrary traversal, stale tag/source SHA, array/object output, or an unverified manifest fails.
- `create-deterministic-tree-archive.test.ts` writes a dependency-free USTAR archive from a sorted,
  allowlisted regular-file tree with fixed uid/gid/mtime, normalized portable modes, zeroed padding, and
  no symlink, hardlink, device, socket, path escape, absolute path, duplicate path, or oversized
  file/tree. Repeated creation from different host mtimes and owners is byte-identical.
- `verify-and-extract-tree-archive.test.ts` verifies the expected archive SHA-256 before parsing,
  revalidates every canonical USTAR header/path/order/size/padding invariant, extracts atomically without
  following links, and recomputes the expected unpacked tree SHA-256. A valid archive with a wrong tree,
  trailing member, non-zero padding, or metadata drift fails before the destination changes.
- `record-processing-deployment.test.ts` binds the exact generated-config SHA-256, Worker `version_id`,
  engine digest, release report hash, git SHA, rollout, quotas, web artifact hash, generated
  `_headers`/API-origin hash, Pages deployment ID/URL, live-cost-model/ceiling hashes, application and
  engine SBOM/scan identities, usage Analytics/bucket names, provider-usage schema hash, Logpush
  job/config identity, complete Worker-version-attestation chain, and deployment time into one immutable
  record. A model/schema/release hash change is valid only with rollout zero and a newly recorded
  accounting epoch; the helper never rewrites prior hourly rows. The record is validated against
  `processing-deployment.schema.json`; schema/version mismatch or overwrite fails.
- `promote-processing-rollout.test.ts` accepts only the next legal
  `0-maintainer → 5 → 25 → 100` stage from the last successful deployment record, preserves the image
  digest and every unrelated field, refuses an open/unknown circuit, and invokes
  `--containers-rollout=none`. Stage `5` or higher additionally requires
  `costAccountingReady = 1`, `last_cost_window_complete = 1`, exactly 24 sequential sealed hourly rows
  under the current live-cost-model/provider-schema/release hashes, both live ceilings below their
  reviewed maximums, and no missing provider source; maintainer bootstrap alone cannot satisfy it.
- `rollback-processing.test.ts` requires the last successful deployment record and matching config hash.
  A failed D1 circuit-open still attempts the independent rollout-zero deploy; a failed deploy leaves the
  circuit open. It reports the two safety results separately and exits non-zero unless config admission
  is proven disabled.
- `rollback-web.test.ts` accepts only the exact prior artifact ID/hash and Pages project from a successful
  combined deployment record, redeploys the downloaded immutable directory without rebuilding, verifies
  that the allowlisted stable Pages branch alias now resolves to the returned deployment ID, smokes that
  stable alias, and rejects a stale alias or CSP/API-origin/hash mismatch. The unique deployment URL is
  recorded for provenance but is never used as the browser smoke origin because it is intentionally
  absent from CORS.
- `inspect-processing-job.test.ts` allows only a UUID, approved normalized D1 columns, quarantine state,
  and the sweeper's last content-free artifact-presence audit; snapshots must contain no token/hash, URL,
  credential, object bytes, custom metadata values, object key, or filename.
- `ensure-cloudflare-processing-resources.test.ts` replays empty, partially-created, and complete
  inventories across two explicit phases. `provision` creates only missing resources and validates the
  future Analytics Engine binding/name without claiming the dataset already exists; `verify-telemetry`
  runs only after a rollout-zero Worker writes a canary point, proves that exact dataset/query contract,
  and seals the resource manifest. Both phases verify account/name/location, Queue/DLQ roles,
  one-day job-object lifecycle, three-day usage-log lifecycle, two distinct private R2 buckets with
  `r2.dev`/custom domains disabled and no CORS, the exact environment Analytics Engine dataset name, and
  one enabled account `workers_trace_events` Logpush job filtered to the exact Worker script. Its field
  allowlist is exactly `CPUTimeMs`, `Entrypoint`, `EventTimestampMs`, `EventType`, `Outcome`, `ScriptName`, and
  `ScriptVersion`; `Event`, `Logs`, `Exceptions`, request URLs, and sampling are prohibited. It refuses
  every mismatch instead of rebinding an arbitrary existing resource. The second phase also runs
  authenticated GraphQL discovery against the account and requires the exact checked-in
  `cloudflare-provider-usage.schema.json` node/field/scalar/pagination limits for
  `containersUsageAdaptiveGroups`; its first unsampled Analytics point must contain the attested active
  `WORKER_VERSION.id`. The canonical schema hash enters the resource manifest and release record. No
  Logpush destination or Analytics-read credential is written into the manifest or command output.
- `read-resource-manifest.test.ts` accepts only the versioned ensure-helper schema and an allowlisted
  scalar field such as `d1.databaseId` or `logpush.jobId`; arbitrary traversal, secret/destination
  credential fields, duplicate environments, or malformed IDs fail.
- `verify-worker-secret-list.test.ts` accepts exactly the Wrangler JSON name/type inventory, proves
  `ABUSE_HMAC_SECRET_CURRENT`, `ABUSE_HMAC_SECRET_PREVIOUS`, `ANALYTICS_READ_TOKEN`, and
  `LOGPUSH_STATUS_TOKEN` are present without reading values, and rejects a missing/duplicate/fifth name
  or any unexpected plaintext field.
- `verify-worker-version-chain.test.ts` compares strict `wrangler versions list --json` snapshots from
  before bootstrap, after bootstrap, after the exact ordered four-secret sequence, and after the final
  deploy with the bootstrap/final deployment outputs. It emits only version IDs plus the exact Worker
  module/generated-config/release hashes into
  `worker-version-attestations.schema.json`, classifies secret-created versions as rollout-zero
  `secret-intermediate`, marks exactly one final version `active`, and rejects an unexplained version,
  mutable module/config hash, missing final deployment Version Metadata ID, or any intermediate version with public
  admission. It retires the prior active version with a ten-minute in-flight event grace rather than
  deleting its row. Applying this attestation batch to D1 is required before the telemetry canary, whose
  first Analytics point must then report the same active `WORKER_VERSION.id`.
- `verify-pages-alias.test.ts` binds the unique Pages deployment ID/URL to the expected stable branch
  alias through the authenticated Pages API. A stale alias, wrong project/branch, or eventual-consistency
  timeout fails; CORS is never broadened to the unique preview hostname.
- `verify-privacy-review.test.ts` binds the reviewed Korean privacy/terms hashes and operator/Cloudflare
  transfer analysis; example, expired, conditional-unsatisfied, or mismatched reviews fail.
- `verify-web-licenses.test.ts` deterministically generates/compares notices before either build, then
  scans both complete staging and production Pages trees plus the Worker/runtime lockfile graph, rejects
  unknown or prohibited/copyleft expressions under the reviewed policy, emits CycloneDX plus
  `THIRD_PARTY_NOTICES.txt`, and verifies both deployed copies/hashes without treating the engine-only
  SBOM as coverage.
- `verify-vulnerability-results.test.ts` accepts the pinned-DB Trivy JSON for engine, staging Pages,
  production Pages, Worker, and production lockfile scopes; it rejects every high/critical result not matched by an exact, reviewed,
  unexpired exception and also rejects stale/wildcard/unused exceptions, scope or artifact-hash
  mismatches, and a scan produced by a different Trivy/DB identity.
- `verify-processing-release-request.test.ts` validates one immutable manifest containing every resource
  ID, URL, digest, artifact reference/hash, both private R2 buckets/lifecycles, Analytics dataset,
  Logpush job/config hash, quota, pending/queue limit, six Rate Limit namespaces,
  maintainer hashes, alert destination, every infrastructure price, per-1,000/monthly cost ceiling,
  cost-model/provider-usage-schema hashes, tool/Trivy-DB identity, policy hash, and confirmation ID.
  Deployment-discovered IDs/URLs must match the authenticated resource/deployment records; every
  operator-selected policy, limit, price, hash, and artifact identity must already be bound into the
  release report. Missing/default/unknown fields or an attempted override fails.
- `read-processing-release-request.test.ts` emits only schema-allowlisted scalars from an already
  verified request, including `engine.cloudflareRegistryImage`,
  `releaseAssets.web.production.assetId`, and the source finalized-candidate artifact ID. It rejects
  mutable tags, non-registry engine references, arbitrary traversal, or a request/root whose verification
  stamp is absent or stale.
- `create-processing-release-report.test.ts` aggregates only schema-validated outputs from image-quality,
  performance/cost, legal/commercial review, engine and application license/SBOM/vulnerability gates,
  tool/action/Trivy-DB provenance, the checked-in provider-usage schema/hash, signed local evidence,
  source git SHA, and exact deployment artifact hashes. It writes canonical JSON atomically and cannot
  accept ad hoc inline fields or overwrite a
  report.
- `verify-processing-release-report.test.ts` validates
  `processing-release-report.schema.json`, recomputes every referenced hash, requires all gates to pass,
  and rejects an expired review, missing stratum/device result, mutable tool identity, absent price,
  unsealed cost input, or report outside the verified candidate root.
- `create-processing-release-request.test.ts` consumes only a verified candidate manifest plus the exact
  private-Release asset manifest and staging Worker/Pages/resource/smoke records, copies the entire
  finalized candidate root byte-for-byte
  (including both engine archives, both Pages trees/USTAR assets, Worker module, reviews, reports,
  policies, and SBOM/scan results) into a new immutable artifact,
  and emits the strict release-request manifest. It refuses an ambient root-level report, source rebuild,
  missing candidate file, or value override.
- `verify-processing-candidate.test.ts` validates the candidate manifest and every exact artifact hash:
  linux/amd64 canonical OCI archive plus loadable Docker archive with identical config digest and
  ordered rootfs DiffIDs; OCI distribution-layer digests are recorded separately,
  no-bundle Worker module, staging and production Pages directories plus their deterministic USTAR
  release assets, and the distinct validated API origins that the later evidence signs. It recomputes
  each archive SHA-256 and unpacked tree SHA-256, plus the provider-usage schema,
  SBOM/Trivy/license reports, source git SHA, tool identities, and—when `state = "finalized"`—the signed
  local-evidence and release-report roots. A
  missing file, extra executable, path escape, origin/hash mismatch, state downgrade, or rebuilt artifact
  fails.
- `create-processing-candidate.test.ts` deterministically builds a `state = "built"` manifest from an allowlisted root
  containing the engine archive/export records, Worker module, both Pages directories, notices,
  their deterministic USTAR assets, the two validated API origins, live-cost model, public
  provider-usage schema, immutable processing-release-input document, and build/SBOM/scan reports. It
  hashes before move, fsyncs/renames
  atomically, refuses symlinks/extra files/path escapes, and cannot overwrite an existing candidate.
- `finalize-processing-candidate.test.ts` consumes one verified built candidate, the signed evidence
  bundle plus detached signature bound to its exact manifest/artifact digest, and the canonical release
  report. It creates a new `state = "finalized"` directory without rebuilding or mutating the built
  candidate, preserves both evidence files, includes only the allowlisted signed evidence,
  schema-validated review documents, and reports, and rejects any
  candidate/evidence/signature/source/tool/hash mismatch.
- `read-processing-candidate.test.ts` reads only schema-allowlisted scalar fields such as
  `engine.loadedImage`; arbitrary traversal, arrays/objects, absolute paths, malformed image names, or an
  unverified manifest fails.
- `create-processing-evidence-bundle.test.ts` validates and canonicalizes only bounded JSON reports from
  the trusted local full-corpus benchmark, competitor comparison, blinded human review, commercial
  review, Korean privacy review, and device matrix. It rejects any corpus/output bytes, image/video
  MIME, absolute/file path, filename, secret, unapproved network-fetch URL, or report over its
  schema/size cap; only explicitly schema-allowlisted source/approval references may be URLs. It signs
  the canonical bytes with an offline Ed25519 key read only from a mode-0600 file outside the repository.
- `verify-processing-evidence-bundle.test.ts` verifies the canonical bundle and detached signature
  against the committed public key, every embedded schema and SHA-256, engine/web/Worker/git identities,
  both API origins and archive/tree identities, expiry, and unique release ID. Mutation, unsigned data,
  unexpected report kind, or reused release ID fails. Its optional `--extract-reviews` writes only the
  schema-allowlisted bounded review JSON files atomically after full signature verification; paths,
  binaries, URLs outside the approval schema, and pre-existing destinations fail.
- `reconcile-restored-processing-db.test.ts` begins with admission at rollout zero, an open circuit, and
  verified paused Queue delivery,
  simulates D1 Time Travel restoring a pre-current migration plus expired/active jobs and stale outbox
  rows while old Queue messages remain, requires current migrations before reconciliation, increments
  every recoverable job's `queue_generation`, assigns a fresh cryptographically random `queue_epoch`,
  immediately nulls/deletes restored >48-hour network identifiers, >7-day usage-log ledgers, and
  >35-day aggregates, rebuilds only valid outbox entries,
  atomically advances a random cost-accounting epoch at the next UTC-hour boundary, clears cost
  evaluation/breach CAS state without rewriting prior sealed rows, and requires a fresh 24-hour
  maintainer window because the three-day usage-log backstop cannot reconstruct arbitrary restored
  history, then reconstructs the exact current/retired Worker-version attestations from the fresh signed
  rollout-zero rollback control record created immediately before restore and chained to the prior
  successful deployment before any consumer resumes,
  converts expired deletion failures to minimal tombstones, reconciles R2 heads, settles missing inputs,
  and proves an old-generation message cannot process. A race fixture demonstrates that an unpaused
  consumer could run between restore and epoch rotation; the tool therefore refuses to run unless pause
  evidence is current and admission is zero.
- `verify-queue-delivery-state.test.ts` parses only strict authenticated Queue API/Wrangler JSON and
  proves the exact primary and DLQ queues are paused or resumed in the expected account. Wrong queue/account,
  ambiguous/missing state, human-table output, or a stale observation fails.
- `processing-release-chain.test.ts` runs candidate creation/verification → staging-evidence
  release-request creation/verification → deployment-record creation/verification over fixtures. It
  proves every deployed byte and config value descends from one signed evidence root and catches a
  swapped report, source drift, Pages origin/archive/tree variant, Worker module, engine digest,
  provider-usage schema, or manifest version.
- `image-engine-workflow.test.ts` uses a narrow tested indentation/state scanner over the workflow text
  while pinned actionlint validates YAML syntax, then asserts the exact
  build/finalize/staging/production/promotion/rollback/restore/secret-rotation modes and inputs, immutable tag checkout,
  source-run `head_sha`
  binding, strict required `staging_api_origin`/`production_api_origin` validation and candidate
  propagation, committed processing-release-input verification with no dispatch price/ceiling override,
  secret-free/no-environment verifier jobs, deploy jobs that `needs` them and reverify artifacts,
  a single separate contents-write publisher job, canonical private-Release asset resolution, no
  ambient engine/web asset IDs, Version Metadata snapshots around bootstrap, the ordered secret
  sequence, and the final deploy plus attestation before admission, no build/package-manager command
  in finalize/staging/production, no-bundle Worker deploy, Docker-archive path, both Pages scans, pinned
  actions/tools, least permissions, hidden-file artifact settings, and non-overwritable release assets.
  It also requires one release-tag-independent `hereisit-production-mutation` workflow concurrency group
  with `cancel-in-progress: false` for production deploy, promotion, rollback, restore, and production
  secret/destination-key rotation. The lock remains held through control-record publication; after any
  queue wait and before credentials or mutation, the verifier re-resolves the private-Release control
  tip plus current Cloudflare deployment and rejects a stale supplied predecessor.
  For rollback it additionally asserts a `finally`/trap-sealed record, record upload with `if: always()`,
  a publisher condition based on validated record presence rather than executor success, and restoration
  of the original non-zero incident result only after publication is attempted.

Run these tests now and record RED because the helpers do not exist:

~~~bash
pnpm test \
  tests/generate-processing-wrangler.test.ts \
  tests/resolve-cloudflare-image-digest.test.ts \
  tests/read-wrangler-output.test.ts \
  tests/download-and-verify-github-artifact.test.ts \
  tests/resolve-github-release-assets.test.ts \
  tests/read-processing-release-assets.test.ts \
  tests/create-deterministic-tree-archive.test.ts \
  tests/verify-and-extract-tree-archive.test.ts \
  tests/record-processing-deployment.test.ts \
  tests/promote-processing-rollout.test.ts \
  tests/rollback-processing.test.ts \
  tests/rollback-web.test.ts \
  tests/inspect-processing-job.test.ts \
  tests/ensure-cloudflare-processing-resources.test.ts \
  tests/read-resource-manifest.test.ts \
  tests/verify-worker-secret-list.test.ts \
  tests/verify-worker-version-chain.test.ts \
  tests/verify-pages-alias.test.ts \
  tests/verify-privacy-review.test.ts \
  tests/verify-web-licenses.test.ts \
  tests/verify-vulnerability-results.test.ts \
  tests/verify-processing-release-request.test.ts \
  tests/read-processing-release-request.test.ts \
  tests/create-processing-release-request.test.ts \
  tests/create-processing-release-report.test.ts \
  tests/verify-processing-release-report.test.ts \
  tests/verify-processing-candidate.test.ts \
  tests/create-processing-candidate.test.ts \
  tests/finalize-processing-candidate.test.ts \
  tests/read-processing-candidate.test.ts \
  tests/create-processing-evidence-bundle.test.ts \
  tests/verify-processing-evidence-bundle.test.ts \
  tests/reconcile-restored-processing-db.test.ts \
  tests/verify-queue-delivery-state.test.ts \
  tests/processing-release-chain.test.ts \
  tests/image-engine-workflow.test.ts \
  --run
~~~

- [ ] **Step 2: Prove the browser cannot bypass the Worker upload boundary**

Generator and web-header tests must prove there is no R2 S3 origin, R2 CORS policy, signing credential,
presigned URL code, or browser-to-R2 `connect-src` in any staging/production artifact. The only
browser-visible upload target is the exact processing Worker origin. R2 remains a private binding, and
the one-day object lifecycle is provisioned separately as a last-resort cleanup rule.

Add a static regression gate:

~~~bash
if rg -n "r2\\.cloudflarestorage\\.com|aws4fetch|presigned|R2_SIGNING|LOGPUSH_R2" \
  apps/web packages/server-runtime .artifacts/build/web-staging .artifacts/build/web-production; then
  exit 1
fi
~~~

Expected: no browser source or Pages deployment artifact contains a direct-upload path or Logpush
credential. Server-only provisioning code is separately allowlisted and tested never to serialize its
bucket-scoped Logpush destination credentials.

- [ ] **Step 3: Implement generated Wrangler configuration**

The generator emits:

- Worker fetch/Queue/scheduled entry and explicit `workers_dev: true`;
- separate private `JOB_OBJECTS` and `USAGE_LOGS` R2 bindings, the environment-specific
  `USAGE_ANALYTICS` dataset, D1 with the repository-relative migrations directory, primary Queue
  producer, primary and DLQ consumers, Container, Durable Object with `new_sqlite_classes`, cron, six
  exact Rate Limit bindings, and one destination-restricted `ALERT_EMAIL` binding;
- `logpush: true` plus the exact account ID, usage-dataset name, and usage-log bucket name needed by the
  bounded provider-usage importer, and a `WORKER_VERSION` Version Metadata binding used to attest every
  Trace Events `ScriptVersion`;
  observability and a 30,000 ms Worker CPU limit; staging samples allowlisted custom logs at `1.0` and
  production at `0.10`, while both set `observability.traces = { enabled: false, persist: false }` and
  `observability.logs.invocation_logs = false` so platform URL logs cannot bypass the structured-log
  allowlist. Real-file staging/production never enable automatic traces because URL/binding attributes
  can contain job paths, object keys, or custom metadata; synthetic-only benchmark Workers may opt in
  under a separate config;
- `standard-2`, one instance, immutable registry digest, `image-slot-0`, and 180-second rollout grace;
- upload deadline 600 seconds, result deadline 1,800 seconds, sweep 300 seconds, a disclosed 2,100-second
  healthy-operation deletion SLO, one-day lifecycle expiration, and explicit exceptional-delay flag;
- JSON-encoded application origins, account/anonymous/network daily limits, account/network pending-job
  ceilings, maximum queue age, approved immutable-release live output-ratio, p95 weighted-unit, and original-retained-rate
  guardrails, maximum live cost per 1,000 jobs, projected monthly-cost ceiling, strict v1 price model,
  exact live-cost-model/provider-usage-schema/release-report SHA-256 values, maintainer session-hash
  allowlist, immutable image digest, exact Queue/DLQ/bucket names, environment, alert destination, and
  rollout percentage;
- no serialized secret or browser-visible R2 origin. `ABUSE_HMAC_SECRET_CURRENT`,
  `ABUSE_HMAC_SECRET_PREVIOUS`, and the account-scoped read-only `ANALYTICS_READ_TOKEN` are encrypted
  Worker secrets provisioned separately while admission is zero. `LOGPUSH_STATUS_TOKEN` is a distinct
  account token with only the minimum permission Cloudflare currently requires to GET the exact Logpush
  job/status; application code hard-rejects non-GET use and it has no Workers, R2, D1, or Analytics
  permission.

`enableInternet = false` remains on the Container class. The generator does not invent an unsupported
Wrangler field for it. Production/staging image references never include `image_build_context`; only the
local Dockerfile config from Task 11 does. Write only under `.wrangler/generated/`, which remains ignored,
and fail generation rather than writing a partial file.
Update `wrangler.local.jsonc` with the local Analytics Engine dataset, private usage-log bucket, Version
Metadata binding, `1003`–`1006` read/result/policy/job-API limits, and a test-only email binding, then regenerate
`src/worker-configuration.d.ts`; local alerts are captured by tests rather than delivered.

- [ ] **Step 4: Implement the application-level automatic circuit breaker**

Migration `0002_rollout_control.sql` extends the minimal Task 4 singleton and adds operational tables:

~~~sql
ALTER TABLE rollout_control ADD COLUMN last_evaluated_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_sample_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN traffic_breach_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN traffic_breach_reason TEXT;
ALTER TABLE rollout_control ADD COLUMN traffic_breach_window_started_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN cost_breach_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN cost_breach_window_started_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_cost_per_1000_microusd INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_projected_monthly_cost_microusd INTEGER;
ALTER TABLE rollout_control ADD COLUMN cost_accounting_started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN first_admitted_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_sealed_hour_key INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_cost_evaluated_hour_key INTEGER;
ALTER TABLE rollout_control ADD COLUMN last_cost_window_complete INTEGER NOT NULL DEFAULT 0
  CHECK (last_cost_window_complete IN (0, 1));
ALTER TABLE rollout_control ADD COLUMN deletion_overdue_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_started_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN deletion_sweep_completed_at INTEGER;
ALTER TABLE rollout_control ADD COLUMN manual_reset_at INTEGER;
UPDATE rollout_control
SET cost_accounting_epoch = lower(hex(randomblob(16))),
    cost_accounting_started_at = unixepoch() * 1000
WHERE id = 1;
CREATE TABLE operational_alert_state (
  kind TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  last_sent_at INTEGER,
  recovered_at INTEGER
);
CREATE TABLE operational_cost_hourly (
  hour_key INTEGER NOT NULL,
  accounting_epoch TEXT NOT NULL,
  live_cost_model_sha256 TEXT NOT NULL,
  provider_usage_schema_sha256 TEXT NOT NULL,
  release_report_sha256 TEXT NOT NULL,
  admitted_jobs INTEGER NOT NULL DEFAULT 0,
  provider_worker_requests INTEGER NOT NULL DEFAULT 0,
  provider_worker_cpu_ms INTEGER NOT NULL DEFAULT 0,
  provider_worker_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_worker_usage_complete IN (0, 1)),
  provider_container_cpu_microseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_allocated_memory_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_allocated_disk_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  provider_container_tx_bytes INTEGER NOT NULL DEFAULT 0,
  provider_container_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_container_usage_complete IN (0, 1)),
  analytics_engine_data_points INTEGER NOT NULL DEFAULT 0,
  analytics_engine_read_queries INTEGER NOT NULL DEFAULT 0,
  analytics_engine_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (analytics_engine_usage_complete IN (0, 1)),
  workers_logpush_events INTEGER NOT NULL DEFAULT 0,
  usage_log_objects INTEGER NOT NULL DEFAULT 0,
  usage_log_bytes INTEGER NOT NULL DEFAULT 0,
  provider_usage_complete INTEGER NOT NULL DEFAULT 0
    CHECK (provider_usage_complete IN (0, 1)),
  container_active_milliseconds INTEGER NOT NULL DEFAULT 0,
  durable_object_active_milliseconds INTEGER NOT NULL DEFAULT 0,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  worker_cpu_ms INTEGER NOT NULL DEFAULT 0,
  durable_object_requests INTEGER NOT NULL DEFAULT 0,
  durable_object_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  queue_operations INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  d1_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  r2_class_a_operations INTEGER NOT NULL DEFAULT 0,
  r2_class_b_operations INTEGER NOT NULL DEFAULT 0,
  r2_storage_byte_milliseconds INTEGER NOT NULL DEFAULT 0,
  container_egress_bytes INTEGER NOT NULL DEFAULT 0,
  observability_log_events INTEGER NOT NULL DEFAULT 0,
  worker_cost_microusd INTEGER NOT NULL DEFAULT 0,
  container_cost_microusd INTEGER NOT NULL DEFAULT 0,
  durable_object_cost_microusd INTEGER NOT NULL DEFAULT 0,
  queue_cost_microusd INTEGER NOT NULL DEFAULT 0,
  d1_cost_microusd INTEGER NOT NULL DEFAULT 0,
  r2_cost_microusd INTEGER NOT NULL DEFAULT 0,
  analytics_engine_cost_microusd INTEGER NOT NULL DEFAULT 0,
  observability_cost_microusd INTEGER NOT NULL DEFAULT 0,
  fixed_cost_microusd INTEGER NOT NULL DEFAULT 0,
  total_cost_microusd INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (accounting_epoch, hour_key)
);
CREATE TABLE usage_log_objects (
  object_key TEXT PRIMARY KEY,
  etag TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stable_observation_count INTEGER NOT NULL DEFAULT 1,
  parsed_sha256 TEXT,
  first_hour_key INTEGER,
  last_hour_key INTEGER,
  state TEXT NOT NULL DEFAULT 'observed'
    CHECK (state IN ('observed', 'parsed', 'sealed', 'delete-pending', 'deleted')),
  deleted_at INTEGER
);
CREATE TABLE usage_log_object_hours (
  object_key TEXT NOT NULL REFERENCES usage_log_objects(object_key) ON DELETE CASCADE,
  hour_key INTEGER NOT NULL,
  invocation_count INTEGER NOT NULL,
  worker_cpu_ms INTEGER NOT NULL,
  subset_invocation_count INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (object_key, hour_key)
);
CREATE INDEX usage_log_object_hours_hour_idx
  ON usage_log_object_hours(hour_key, object_key);
CREATE TABLE usage_log_hour_observations (
  accounting_epoch TEXT NOT NULL,
  hour_key INTEGER NOT NULL,
  object_set_sha256 TEXT NOT NULL,
  object_count INTEGER NOT NULL,
  object_bytes INTEGER NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  matching_observation_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (accounting_epoch, hour_key)
);
CREATE INDEX usage_log_objects_state_seen_idx
  ON usage_log_objects(state, last_seen_at);
CREATE TABLE worker_version_attestations (
  version_id TEXT PRIMARY KEY,
  worker_module_sha256 TEXT NOT NULL,
  generated_config_sha256 TEXT NOT NULL,
  release_report_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'secret-intermediate', 'active', 'retired')),
  public_admission_allowed INTEGER NOT NULL DEFAULT 0
    CHECK (public_admission_allowed IN (0, 1)),
  observed_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE TABLE container_activity_segments (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  billed_until_at INTEGER NOT NULL,
  CHECK (billed_until_at >= started_at)
);
CREATE INDEX container_activity_segments_time_idx
  ON container_activity_segments(started_at, billed_until_at);
CREATE TABLE artifact_presence_audit (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  input_exists INTEGER NOT NULL CHECK (input_exists IN (0, 1)),
  output_exists INTEGER NOT NULL CHECK (output_exists IN (0, 1)),
  checked_at INTEGER NOT NULL
);
CREATE INDEX jobs_health_window_idx
  ON jobs(finished_at, status, error_code, verified_input_mime, input_has_alpha, declared_bytes);
~~~

`POST /v1/policy` and `POST /v1/jobs` read the row; `circuit_open = 1` forces effective rollout to zero for
maintainers and public cohorts without changing the reviewed environment value. Read it through a
`first-primary` D1 session so an opened circuit is not hidden by a stale replica. The scheduled handler
runs `evaluateLiveCost()` and `evaluateCircuitBreaker()` after cleanup.

`usage-analytics.ts` writes exactly one identifier-free Workers Analytics Engine point for every fetch,
Queue, and scheduled invocation in a `finally` boundary, including CORS, rate-limit, malformed-body, and
other pre-D1 rejection paths. Each handler captures `eventStartedAtMs` and
`eventHourKey = floor(eventStartedAtMs / 3_600_000)` before its first await and writes that explicit key;
SQL groups by it rather than the Analytics Engine ingestion timestamp so an invocation crossing an hour
boundary matches Trace Events `EventTimestampMs`. Fields are limited to environment, coarse route/event
class, status class, attested `WORKER_VERSION.id`, entrypoint class, and release hash—never
IP/network/session/job/object/file data. After an hour ends, the scheduled handler
waits a conservative 30-minute provider-delivery
allowance and then streams only the dedicated private `USAGE_LOGS` objects produced by one unsampled
account `workers_trace_events` Logpush job. Its exact field allowlist is `CPUTimeMs`, `Entrypoint`,
`EventTimestampMs`, `EventType`, `Outcome`, `ScriptName`, and `ScriptVersion`; `Event`, `Logs`,
`Exceptions`, request URLs, headers, and custom log bodies are never exported. The Logpush filter accepts
only the exact environment Worker script, and provisioning fails if the job is disabled, sampled, has a
different destination/prefix, or contains an extra field.

The importer uses a bounded streaming gzip/NDJSON parser, rejects a line over 4 KiB or malformed
timestamp/version/outcome, groups exact invocation count and integer `CPUTimeMs` by UTC hour, and never
loads an object or hour into memory as a whole. In one D1 transaction it first claims the exact
object-key/ETag/size, stores the parsed payload hash and one `usage_log_object_hours` row per covered UTC
hour, and advances the canonical `usage_log_hour_observations` set digest. Repeated cron parses no object
twice; the same key with a changed ETag/size, duplicate record digest, or changed second-pass set opens
the circuit. An object spanning multiple hours is retained until every referenced hour seals, then
explicitly deleted and marked deleted; the object ledger is removed after seven days and its key never
enters logs, alerts, or release records. Logpush delivery and usage-bucket R2 operations/storage enter
the hourly counters. The three-day private R2 lifecycle is a last-resort cleanup rule, not a hard
maximum. `provider_worker_usage_complete` becomes `1` only when the authenticated Logpush
configuration/status GET made with `LOGPUSH_STATUS_TOKEN` shows the exact job enabled and no delivery
error and a strict `last_complete` watermark at or beyond the hour end, the same closed-hour object set is observed on
two scheduled passes at least ten minutes apart after the 30-minute allowance, and the unsampled
Analytics Engine route-point count matches the Trace Events subset whose `EventType` is
`fetch|queue|scheduled` and whose `Entrypoint` is one of the versioned Worker handler entrypoints.
`alarm`, `worker_rpc`, and future explicitly allowlisted non-handler events are still priced and checked
for Logpush delivery but are not falsely compared with an Analytics point the application cannot emit.
Every Trace `ScriptVersion` ID and Analytics point's `WORKER_VERSION.id` must match a current D1
`worker_version_attestations` row with the same module/config/release hashes. Bootstrap and
secret-intermediate versions are priced but can never own an admitted job; only the final active version
may, while a retired version is accepted only when the event timestamp falls within its recorded
in-flight grace. An unknown version or event/entrypoint pair fails until reviewed. Any `_sample_interval != 1` in v1,
late/missing/duplicate object,
count mismatch, or unknown ScriptVersion fails closed rather than inventing usage.

Using a dedicated account-scoped token with only `Account Analytics Read`, the same handler queries the
Analytics Engine SQL API for that identifier-free cross-check and the exact
`containersUsageAdaptiveGroups` GraphQL fields `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, and
`txBytes`, grouped by hour and the allowlisted Container application/instance. The latter is the
provider usage dataset intended to match Container dashboard billing estimates. The checked-in
node/field/scalar/pagination contract is canonicalized at release time, and the runtime refuses a
response unless its hash equals `PROVIDER_USAGE_SCHEMA_SHA256`. Decimal responses are
parsed into checked integer fixed-point units without JavaScript floating-point arithmetic. GraphQL is
not used for Worker `CPUTimeMs`; the per-invocation Trace Events field is authoritative for the
real-time Worker CPU guardrail. Missing/expired token, API error including a GraphQL `errors` member,
schema drift, pagination gap, provider lateness, or an application/provider envelope mismatch leaves the
corresponding source incomplete. `provider_usage_complete = 1` requires Worker Logpush, Analytics
Engine, and Container usage to be complete together. The Analytics Engine dataset's provider retention
and the usage-log field list, explicit deletion behavior, three-day lifecycle backstop, and possible
exceptional delay are disclosed separately in the privacy inventory.

`live-cost.ts` increments content-free operation counters in the same D1 batches that create, poll,
settle, download, and sweep jobs; an operation cannot be treated as measured if its counter batch is
unknown. After the 30-minute provider-delivery allowance, the scheduler begins completeness checks and
seals an elapsed hour—including an explicit zero row—as `complete = 1` only after every provider source
passes; the two-pass Logpush rule means no hour seals before 40 minutes. A fresh deployment/current hour
is not an accounting failure, but any due hour at or after `cost_accounting_started_at` still incomplete
60 minutes after hour end fails admission closed and opens the circuit. Seal strictly in hour-key order,
advance `last_sealed_hour_key` with the row in one batch, and never skip an hour. Set
`first_admitted_at` in the first successful reservation. A cost evaluation CASes
`last_cost_evaluated_hour_key`, so repeated cron delivery for the same sealed hour cannot increment the
breach count twice. Every sealed row stores its accounting epoch, live-cost-model/provider-schema/release
hashes, per-service microusd breakdown, and total; rolling windows sum those sealed totals and never
reprice old raw counters. A deployment or rollback that changes any of those hashes must keep rollout
zero, start a fresh random epoch at a UTC-hour boundary, and repeat the maintainer 24-hour bootstrap.
Coefficient decreases cannot mutate or lower an old hour. For each available rolling window up
to 24 hours, use `container_activity_segments`: the first engine fetch opens
`[engine_contact_started_at, engine_contact_started_at + 60s]`, every later engine interaction/terminal
cleanup extends `billed_until_at = max(existing, now + 60s)`, and adjacent/overlapping segments for the
single fixed instance merge transactionally. The hourly sealer intersects those segments with each UTC
hour and stores exact union milliseconds in both `container_active_milliseconds` and
`durable_object_active_milliseconds`, so burst traffic shares the tail while sparse jobs pay it
separately. Segments and sealed hourly totals survive terminal-job deletion and are retained for 35 days;
the cost window never depends on a job row that expires at 24 hours.
For observed cost, price the provider-sealed Container CPU, allocated-memory byte-time, allocated-disk
byte-time, and transmitted bytes from `containersUsageAdaptiveGroups`; the merged activity segments
remain an independent upper-bound cross-check and the basis for steady/bursty/sparse forward
projections. Price every Trace Events record conservatively as both a Worker request and a Workers
Logpush event, its exact `CPUTimeMs`, the corresponding 128 MiB Durable Object duration and measured DO
request/storage counters, Worker/Queue/D1/R2 operations and storage byte-time including the dedicated
usage bucket, Analytics Engine writes/queries, allowlisted custom logs, and the prorated fixed monthly
amount using the exact signed
`LiveCostModelV1`. The engine continues to emit only raw measurements; monetary coefficients live in the
Worker config/release report. Compute both effective cost per 1,000 admitted jobs and projected monthly
cost for steady, bursty, and sparse arrival shapes. A missing coefficient, unsealed hour, counter
underflow, or unavailable cost query fails server admission closed and alerts rather than reporting a
cheap estimate. Later invoice/dashboard reconciliation may raise coefficients or ceilings but never
lowers a real-time measured hour. Hourly cost rows contain no job/session/network/object identifier and
are deleted after 35 days. Segment rows contain only interval UUID/timestamps and follow the same
retention.

Bootstrap cannot deadlock the first maintainer job: before any hourly row is due, server admission is
allowed only for the maintainer allowlist, only when rollout is zero, all three quotas are explicit, and
the runtime `LIVE_COST_MODEL_SHA256`/`RELEASE_REPORT_SHA256` match the signed candidate that passed the
offline steady/bursty/sparse cost gates. The first due hour must seal on time or the circuit opens.
Promotion to 5% is forbidden until a complete 24-hour maintainer cost window (including zero hours)
passes both live ceilings; the bootstrap exception never applies to a public cohort.
Task 18 extends both the advisory policy expression and atomic `reserveAndCreate()` predicate with this
`costAccountingReady`/bootstrap decision plus a matching active
`worker_version_attestations` row for `WORKER_VERSION.id` before any staging or production admission.

The circuit opens atomically and never auto-closes when
any of these conditions holds:

- any `VERIFICATION_FAILED` terminal job in the last 15 minutes;
- a qualified traffic window has at least 100 terminal jobs, 20 distinct rotating network hashes, and 40
  distinct sessions, and success is below 95% for two consecutive non-overlapping windows;
- the same qualified traffic window has OOM rate at least 3%, whole-engine timeout rate at least 5%, or
  engine-crash/storage-failure rate at least 5%;
- at least 40 warm (`cold_start = 0`) jobs from 10 networks and 20 sessions in a verified
  MIME/size/alpha and relevant content-class stratum and p95 above 6 seconds for JPEG/WebP or 16 seconds
  for PNG in two consecutive windows;
- at least 100 successful download jobs from the qualified traffic window and median
  `floor(output_bytes * 10_000 / declared_bytes)` above
  `MAX_LIVE_MEDIAN_OUTPUT_RATIO_BPS`;
- at least 100 settled native jobs from the qualified traffic window and p95 `actual_units` above
  `MAX_LIVE_P95_WEIGHTED_UNITS`, whose release value is derived from the approved infrastructure prices
  and maximum cost per 1,000 jobs;
- two consecutive hourly evaluations over the available complete-hour window (capped at 24 hours) exceed either
  `MAX_LIVE_COST_PER_1000_MICROUSD` or `MAX_PROJECTED_MONTHLY_COST_MICROUSD`; require at least 20 admitted
  jobs or a full 24 hours since the first admitted job so sparse traffic is evaluated instead of hidden,
  and calculate the sparse-tail scenario even when observed traffic is bursty;
- at least 100 succeeded jobs from 10 networks and 20 sessions in a verified
  MIME/size/alpha/content-class stratum and
  original-retained rate above the immutable
  release baseline plus 500 basis points or above `MAX_LIVE_ORIGINAL_RETAINED_RATE_BPS`;
- oldest queued age exceeds `MAX_QUEUED_AGE_SECONDS`;
- any input/result/tombstone deletion remains overdue by more than five minutes, or a complete orphan
  cursor cycle finds an object past its grace period.

For quality/latency traffic-derived gates, deterministically cap contribution at three jobs per session and five per
rotating network in each window before computing rates/percentiles. A single actor or shared NAT cannot
satisfy the distinct-cohort minimum or poison the global circuit. The first qualified breach records and
alerts; only the same breach in the next non-overlapping 15-minute window opens the circuit. Hard
invariant verification failures, deletion overdue, queue-age failures, and incomplete live-cost
accounting still open immediately. Cost thresholds use actual bounded resource counters rather than
per-actor sampling because the account pays the full cost; network/session quotas remain the abuse fence.
Calculate p95 from at most the newest 1,000 terminal rows using `finished_at - started_at`. The health
query allowlist contains only coarse derived verified MIME, size band, alpha boolean, and v1 content
class; filenames, object identity, bytes, text, metadata values, and unbounded features never enter the
query or event. Health-rate denominators include only jobs that reached native
`running`; user cancellation, input/feature/size rejection, upload expiry, and policy/quota denial are
excluded. The sweeper sets `deletion_overdue_count` after checking D1 and R2 and
clears it only after a complete cursor cycle records a new generation and
`deletion_sweep_completed_at`; tombstone retries and orphan pages participate in the same generation,
partial pages accumulate counts, and they can never claim zero. The content-free
`artifact_presence_audit` stores only job ID, input/output existence booleans, and check time. Migration
and sweeper tests prove it cascades when a 24-hour terminal job becomes a cleanup tombstone.

If the circuit read exceeds 250 ms, D1 is unavailable, or the migration row is absent, `/v1/policy` fails
closed to a contract-valid local response with `SERVER_PROCESSING_DISABLED`, and `/v1/jobs` denies before
upload reservation. The authoritative `reserveAndCreate()` SQL joins `rollout_control` with
`circuit_open = 0` in the same batch as quota predicates, eliminating the policy-read/reservation race.
Tests open the circuit between the advisory policy read and reservation and prove no job is created.

`operational-alerts.ts` sends destination-restricted, content-free email on circuit-open, deletion
overdue, live-cost/accounting breach, oldest-queue/DLQ backlog, and engine-health failure, plus one recovery message. D1 state
deduplicates each active condition to at most once per hour. Messages contain only condition, counts,
environment, build ID, and the runbook URL—never job IDs or file-derived data. Tests cover alert,
throttle, recovery, and email failure without changing circuit state.

Tests prove every hard threshold opens once, traffic thresholds require two qualified windows, repeated
evaluation is idempotent, one network submitting hundreds of incompressible or pathological-but-valid
files cannot trip success/latency/original-retained cohort gates beyond its quota, a healthy window does not auto-close or
silently clear a recorded breach, D1 outage returns local, and policy immediately reflects an opened
circuit. Cost tests compare a burst of overlapping jobs with sparse one-off jobs, include the 60-second
container/DO tail and all DO request/storage coefficients, reconcile provider Container usage against
the segment upper bound, and include Workers Logpush plus usage-bucket R2 cost. They reject a missing or
expired Analytics/Logpush-status token, any non-GET Logpush API attempt, GraphQL errors, sampled
Analytics Engine results, stale/malformed `last_complete`, late/duplicate Trace Events, changed ETags, wrong Logpush fields/filter,
unknown Worker version, and any incomplete hour. Fixtures prove repeated cron is exactly once, a
multi-hour object is split without double count and is not deleted until all hours seal, and
allowlisted `alarm`/`worker_rpc` records are priced without poisoning the handler-only AE equality, then
an invocation starting before but finishing after UTC hour rollover still matches the same explicit
hour, then open after two
over-budget evaluations. They also prove zero-traffic hours seal sequentially and repeated evaluation of
one hour cannot count as two breaches; a model/schema/release change creates a new epoch and cannot
reprice or lower a prior sealed breakdown. Manual reset is allowed only after the cause is corrected,
rollout-zero deployment is independently proven, a complete deletion sweep generation finished with zero
overdue objects, and staging gates pass.

- [ ] **Step 5: Add CI and release workflows**

Ordinary `ci.yml` runs root `pnpm verify`, Worker integration, Docker runtime build/self-test, reduced
public corpus, 60-second deterministic fuzzing, license policy, Syft SBOM, and Trivy high/critical scan.
It also runs `pnpm --filter @hereisit/api-worker types:check` so committed bindings cannot drift from
`wrangler.local.jsonc`. Every job uses Node `24.13.0`, pnpm `11.11.0`, and
`pnpm install --frozen-lockfile`.
Generate `THIRD_PARTY_NOTICES.txt` deterministically from the production lock graph first and require it
to byte-match the committed file. Then make clean isolated staging and production Pages builds, so both
deployed trees contain that exact notice, and create the Wrangler dry-run Worker bundle. Generate
separate CycloneDX SBOMs for the native image, staging Pages, production Pages, Worker bundle, and
production pnpm lockfile graph. Scan all five with the same pinned Trivy DB digest. Trivy fails every high/critical
finding unless it matches a still-valid, exact package/version/CVE/scope entry in either
`apps/image-engine/security/vulnerability-exceptions.json` or
`security/application-vulnerability-exceptions.json`; expired, wildcard, unreviewed, or unused
exceptions fail. `verify-web-licenses.mjs` enforces `security/application-license-policy.json` over the
complete two-variant Pages/Worker production graph and verifies the prebuilt application notices/SBOM
hashes. The release report binds all five artifact hashes, SBOM hashes, vulnerability-exception hashes,
license-policy hashes, and
scan results; scanning only the engine is never sufficient.

`image-engine.yml` has:

- nightly public-corpus benchmark;
- nightly 1,800-second fuzz run;
- `build-candidate`, which runs only from a new immutable release tag, builds/scans a `state = "built"`
  candidate without Cloudflare credentials or private evidence. It requires the immutable staging and
  production processing API origins as typed non-secret inputs, validates them before any build, records
  them in the candidate, and uploads the exact artifact/digest;
- `finalize-release`, which accepts only the build run ID, built-candidate artifact name/SHA-256,
  private evidence-release tag, and confirmation ID. It verifies the offline Ed25519 evidence is bound
  to that exact candidate manifest and runs the private quality/legal/cost gates against the already
  built bytes, then emits a `state = "finalized"` candidate without rebuilding;
- `deploy-staging`, which accepts only the finalize run ID, finalized-candidate artifact name/SHA-256,
  environment, and confirmation ID, deploys the exact candidate with staging credentials, and emits one
  schema-validated `processing-release-request.json` containing the staging Worker/Pages evidence and all
  signed quota/pending/queue/rate, maintainer, alert, infrastructure-price, and cost-ceiling values. Its
  immutable artifact also carries the exact no-bundle Worker module and prepared production Pages
  directory; the engine is referenced only by the authenticated Cloudflare registry digest proven in
  staging;
- `deploy-production`, which accepts only the prior staging run ID, release-request artifact
  name/SHA-256, environment, and confirmation ID, revalidates it before reading production credentials,
  and deploys the exact previously scanned engine/web/Worker identities;
- `promote-production`, which accepts the current successful deployment-record coordinates from either
  a live Actions artifact or its private-Release asset,
  exact next stage, release tag, and confirmation ID, runs the guarded promotion under production
  credentials, and emits the next immutable record;
- `rollback-production`, which accepts current/prior successful-record coordinates from either source,
  reviewed scope, reason,
  release tag, and confirmation ID, runs the independent Worker/D1 and optional Pages rollback, and emits
  a rollback record even when one safety layer fails;
- `restore-production`, which accepts the current deployment record from either source, reviewed D1 bookmark/timestamp,
  release tag, and confirmation ID, executes the pause/drain/restore/migrate/reconcile/resume sequence
  while rollout remains zero, and emits the schema-validated restore record;
- `rotate-environment-secrets`, which accepts an environment, current record from either source,
  allowlisted secret/destination-key kind, and confirmation ID, forces rollout zero, performs the
  version/resource attestation sequence above, and emits a rotation record before revoking predecessors;
- immutable reports uploaded as artifacts;
- a production deploy job gated by every quality/deletion/security/license/performance/cost assertion;
- no automatic codec promotion.

Every successful or partially successful operational mode feeds the same isolated
`publish-release-assets` job, whose only write capability is uploading its unique, predecessor-chained
control record to the private Release. Promotion, rollback, and restore are never run as unrecorded local
mutations in production; secret and destination-key rotations follow the same rule.

All production mutations—initial production deploy, promotion/reset, rollback, restore, and production
secret or Logpush-destination-key rotation—share one workflow-level, release-tag-independent
`hereisit-production-mutation` concurrency group with `cancel-in-progress: false`. The workflow holds
that lock until the publisher has either appended the validated control record or durably recorded the
publication failure. After acquiring the lock, and again immediately before reading production
credentials, the verifier resolves the latest private-Release control-chain tip and authenticated
Cloudflare deployment. The supplied current/predecessor record must still be that tip and match live
state; a queued stale dispatch fails before mutation and must be re-dispatched from the newly published
record. Tests start promotion and rollback concurrently, then production deploy and restore, and prove
only one mutates at a time and the second cannot reuse the first operation's predecessor.

The rollback executor seals its content-free record in a `finally` path before returning the incident
exit code. Its record upload runs with `if: always()`, and the publisher runs whenever that uploaded
record validates—even if one rollback safety layer failed. After publication is attempted, the workflow
restores the original non-zero rollback result, so evidence persistence never masks an unsafe outcome.

For every control-record input, the dispatch schema requires exactly one source: either
`actions_run_id + artifact_name + artifact_id + size + sha256 + head_sha`, or
`release_tag + release_asset_id + size + sha256 + predecessor_sha256`. The verifier prefers the
365-day private-Release copy once published and uses the Actions tuple only while it is still live;
expiry of an Actions artifact can never block promotion or recovery.

Pin every action to these reviewed commits:

~~~text
actions/checkout                      9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
actions/setup-node                    820762786026740c76f36085b0efc47a31fe5020
pnpm/action-setup                     0ebf47130e4866e96fce0953f49152a61190b271
docker/setup-buildx-action            bb05f3f5519dd87d3ba754cc423b652a5edd6d2c
docker/build-push-action              53b7df96c91f9c12dcc8a07bcb9ccacbed38856a
anchore/sbom-action                   e22c389904149dbc22b58101806040fa8d37a610
aquasecurity/trivy-action             ed142fd0673e97e23eac54620cfb913e5ce36c25
actions/upload-artifact               043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
~~~

Set top-level workflow permissions to `{ contents: read }`, add only the environment-specific deployment
permissions/secrets to the manual job that needs them, and configure checkout with
`persist-credentials: false`. Fork/PR jobs have no Cloudflare, signing, evidence-release write, or
deployment credentials.

Pin the tools downloaded by those actions as well as the actions themselves:

~~~text
Syft                    1.44.0
Trivy                   0.72.0
Docker Buildx           0.34.1
BuildKit                0.30.0
actionlint              1.7.12
ShellCheck              0.11.0
BuildKit index digest   sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f
BuildKit linux/amd64    sha256:57269d1784e49b46228c45a1a1b870fbe40e0a639ab60b37b032d83af5bccdfc
~~~

The workflow verifies Syft/Trivy/actionlint/ShellCheck official release checksums and available
attestations, configures
`docker/setup-buildx-action` with exactly Buildx `v0.34.1` and the BuildKit image-by-index-digest above,
and checks the selected linux/amd64 manifest. At preparation start it resolves
`aquasec/trivy-db:2` to one immutable OCI digest; every engine, web, Worker, and lockfile scan uses that
same digest. The release report records tool versions, binary hashes, attestation identities, BuildKit
index/platform digests, Trivy DB digest/metadata timestamp, and action SHAs. A mutable tool or DB tag
cannot reach a release gate.

`workflow_dispatch` cannot upload local files, so use a two-stage candidate flow that benchmarks the
exact bytes that will deploy. First create and push one immutable annotated source tag, then run the
credential-free public build:

~~~bash
node scripts/create-processing-release-inputs.mjs \
  --base-source-sha "$(git rev-parse HEAD)" \
  --price-input "$REVIEWED_INFRASTRUCTURE_PRICE_INPUT" \
  --route-cpu-benchmark "$REVIEWED_WORKER_ROUTE_CPU_BENCHMARK" \
  --quality-cost-ceilings "$REVIEWED_QUALITY_COST_CEILINGS" \
  --schema docs/deployment/processing-release-inputs.schema.json \
  --output "docs/deployment/releases/$RELEASE_ID/processing-release-inputs.json"
git add "docs/deployment/releases/$RELEASE_ID/processing-release-inputs.json"
git commit -m "chore: lock processing release inputs $RELEASE_ID"
export RELEASE_SHA="$(git rev-parse HEAD)"
export RELEASE_TAG="processing-release-$RELEASE_ID"
git tag -a "$RELEASE_TAG" "$RELEASE_SHA" -m "HereIsIt processing release $RELEASE_ID"
git push origin "refs/tags/$RELEASE_TAG"
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=build-candidate \
  -f staging_api_origin="$STAGING_PROCESSING_API_ORIGIN" \
  -f production_api_origin="$PRODUCTION_PROCESSING_API_ORIGIN" \
  -f confirmation_id="$BUILD_CONFIRMATION_ID"
~~~

Both origins are exact HTTPS origins with no credentials, path other than `/`, query, fragment, wildcard,
or trailing-dot ambiguity. They must be distinct, must match the reviewed
`hereisit-processing-{staging,production}.<workers-subdomain>.workers.dev` script names, and must not be
a Pages, R2, preview, or caller-controlled hostname. `build-candidate` treats them as validated immutable
build inputs; the later offline evidence signs their values and both generated Pages tree hashes. Staging
and production then prove the actual deployed Worker target equals the corresponding signed value before
deploying Pages.

After `build-candidate` succeeds, download its exact artifact to the trusted maintainer workstation,
verify `state = "built"`, load the Docker archive, and run the private corpus, authorized competitor
comparison, blinded human review, device matrix, commercial review, and Korean legal review against that
loaded image and those exact Worker/Pages hashes—never a local rebuild:

~~~bash
node scripts/download-and-verify-github-artifact.mjs \
  --repo liorium/hereisit \
  --run-id "$BUILD_RUN_ID" \
  --expected-head-sha "$RELEASE_SHA" \
  --name processing-built-candidate \
  --expected-sha256 "$BUILT_CANDIDATE_ARTIFACT_SHA256" \
  --output-dir .artifacts/built-candidate-download
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/built-candidate-download/processing-candidate.json \
  --root .artifacts/built-candidate-download \
  --required-state built \
  --expected-git-sha "$RELEASE_SHA"
docker load \
  --input .artifacts/built-candidate-download/image-engine-linux-amd64.docker.tar
node scripts/benchmark-image-engine.mjs \
  --engine-image "$(
    node scripts/read-processing-candidate.mjs \
      --manifest .artifacts/built-candidate-download/processing-candidate.json \
      --field engine.loadedImage
  )" \
  --manifest tests/image-corpus/private/manifest.json \
  --live-cost-model .artifacts/built-candidate-download/live-cost-model.json \
  --require-embedded-arrival-scenarios \
  --scope release \
  --output .artifacts/local-private-benchmark.json
~~~

`create-processing-evidence-bundle.mjs` validates and embeds only bounded, content-free JSON
reports—metrics and input/output SHA-256 values, not input/output bytes, filenames, paths, thumbnails, or
reproducer files—together with the operator's explicit release limits. It binds the built-candidate
manifest SHA-256, Actions artifact digest, git SHA, engine config digest, OCI distribution-layer
digests, ordered rootfs DiffIDs, Worker hash, and both
validated API origins, Pages archive hashes, and unpacked tree hashes, then creates a detached Ed25519
signature using a mode-0600 private key outside the repository. During implementation, generate that key
once under `umask 077` with OpenSSL Ed25519, store
the private key in the maintainer's encrypted secret backup, export only its public half to
`docs/deployment/processing-evidence-ed25519-public.pem`, and require a reviewed dual-key transition for
rotation. `HEREISIT_RELEASE_EVIDENCE_PRIVATE_KEY_FILE` points to the external private-key path and is
never placed in GitHub secrets.

Create a private GitHub Release on the already-existing source tag and upload the signed JSON only:

~~~bash
export HEREISIT_RELEASE_EVIDENCE_PRIVATE_KEY_FILE="$HOME/.config/hereisit/release-evidence-ed25519.pem"
node scripts/create-processing-evidence-bundle.mjs \
  --request .artifacts/local-release-inputs.json \
  --candidate-manifest .artifacts/built-candidate-download/processing-candidate.json \
  --candidate-artifact-sha256 "$BUILT_CANDIDATE_ARTIFACT_SHA256" \
  --output ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.json" \
  --signature ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.sig"
node scripts/verify-processing-evidence-bundle.mjs \
  --bundle ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.json" \
  --signature ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.sig" \
  --candidate-root .artifacts/built-candidate-download
if gh release view "$RELEASE_TAG" --repo liorium/hereisit; then
  exit 1
fi
gh release create "$RELEASE_TAG" \
  --repo liorium/hereisit \
  --verify-tag \
  --title "Processing release $RELEASE_ID" \
  --notes "Signed evidence and immutable deployment assets"
gh release upload "$RELEASE_TAG" \
  ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.json" \
  ".artifacts/evidence-v1--$RELEASE_ID--processing-evidence.sig" \
  --repo liorium/hereisit
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=finalize-release \
  -f source_run_id="$BUILD_RUN_ID" \
  -f artifact_name=processing-built-candidate \
  -f artifact_sha256="$BUILT_CANDIDATE_ARTIFACT_SHA256" \
  -f evidence_release_tag="$RELEASE_TAG" \
  -f confirmation_id="$FINALIZE_CONFIRMATION_ID"
~~~

`finalize-release` has no Cloudflare credentials and performs no build. It verifies the exact built
candidate, signed evidence, private gates, release report, and finalized manifest, then uploads
`processing-finalized-candidate` as an Actions artifact. A separate `publish-release-assets` job—not a
step in the verifier job—has the workflow's only `contents: write` permission. It uses no third-party
build/scan action, re-downloads the finalized artifact, re-verifies artifact digest, schema, signature,
candidate state, and tag/SHA, then uploads the finalized manifest/report, canonical OCI archive,
loadable Docker archive, no-bundle Worker module, and both deterministic Pages USTAR files as
non-overwritable file assets on the same private release. The candidate and deployment schemas bind each
Pages archive SHA-256 to its unpacked tree SHA-256. Rollback verifies the archive before parsing,
safe-extracts it atomically, and recomputes the tree hash before `wrangler pages deploy`; a directory is
never passed directly to `gh release upload`. The
deployment record binds the release tag, asset IDs, sizes, and SHA-256 values. Keep the current and prior
successful release assets for at least 365 days after supersession; deletion requires a newer proven
rollback source. Raw private corpus and competitor output binaries never enter Actions or release assets
and follow the maintainer's separate encrypted backup/deletion policy.

The finalizer derives the two evidence asset names only from the validated release tag/ID and rejects
generic `processing-evidence.*`, duplicate, or caller-selected asset names.

After uploading the candidate assets, the publisher runs
`resolve-github-release-assets.mjs` against the private Release and finalized candidate, then uploads the
resulting immutable `processing-release-assets.json` last. The manifest covers the deployable assets but
not itself, so there is no self-reference. Every staging/production/rollback verifier independently
resolves the Release again and byte-compares the canonical manifest before credentials; an asset ID from
an environment variable or human copy/paste is never trusted.

Signed local evidence uses the exact `evidence-v1--<release-id>--*` pair; candidate files and their
manifest use the immutable `candidate-v1--<release-id>--*` namespace. Later staging, production,
promotion, rollback, restore, and rotation
records use only
`control-v1--<monotonic-sequence>--<record-type>--<sha256>.json`; they are append-only and predecessor
chained. Candidate resolution ignores only schema-valid control records in that namespace and rejects
all other extras, so operations can append history without weakening the exact candidate asset set.

The same least-privilege publisher pattern runs after each successful staging, production, promotion,
web rollback, Worker rollback, D1 restore, and secret/destination-key rotation. It uploads the
schema-verified release request and versioned deployment/rollback/restore/rotation records as unique
non-clobber assets on `RELEASE_TAG`, chaining
each record to its predecessor and finalized candidate asset IDs/hashes. Actions-artifact expiry can
therefore never erase the trust root for `LAST_SUCCESSFUL_DEPLOYMENT_RECORD`; current and prior successful
control records follow the same minimum 365-day retention.

Every
`upload-artifact` step that targets `.artifacts/` sets `include-hidden-files: true`,
`if-no-files-found: error`, and a strict allowlisted path with explicit exclusions for corpus bytes,
secrets, `.dev.vars`, and credentials.

The repository is private, so do not assume environment required-reviewer protection is available on the
current GitHub plan. Verify plan eligibility explicitly. If protected environments with required
reviewers are unavailable, the four explicit initial-release dispatches are the solo-compatible control:
credential-free build → exact-artifact local evidence/signing → credential-free finalize → manual
staging → manual production. Later promotion/rollback/restore remain separate confirmation-gated manual
operation modes with immutable predecessor records.
Staging and production use separate least-privilege Cloudflare secrets. No push, nightly job, local
benchmark, or codec result deploys automatically.

The operator advances only by immutable artifact coordinates:

~~~bash
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=deploy-staging \
  -f source_run_id="$FINALIZE_RUN_ID" \
  -f artifact_name=processing-finalized-candidate \
  -f artifact_sha256="$FINALIZED_CANDIDATE_ARTIFACT_SHA256" \
  -f environment=staging \
  -f confirmation_id="$STAGING_CONFIRMATION_ID"
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=deploy-production \
  -f source_run_id="$STAGING_RUN_ID" \
  -f artifact_name=processing-release-request \
  -f artifact_sha256="$RELEASE_REQUEST_ARTIFACT_SHA256" \
  -f environment=production \
  -f confirmation_id="$PRODUCTION_CONFIRMATION_ID"
~~~

The schema permits exactly the fields for the selected mode and rejects arbitrary URLs or independent
overrides. Each environment dispatch is split into two jobs. `verify-staging-input` and
`verify-production-input` have no `environment`, no Cloudflare secret reference, and only `contents:
read`; they download and validate artifact digest, evidence signature, git/tag/source-run identity,
engine/web/Worker hashes, schema, and confirmation. The corresponding `deploy-*` job declares the
environment and secrets only through `needs: verify-*-input`, then independently downloads the same
artifact and repeats digest/manifest verification before its first Cloudflare command. GitHub
environment secrets are never assumed to become available midway through a job. The staging artifact
rehydrates its verified Worker module, production Pages directory, and reports under the same
`.artifacts/candidate/` paths used by the commands below; it never contains Cloudflare secrets or the
private corpus.
Promotion, rollback, restore, and rotation use the same secret-free verifier → environment-bound
executor split, including an independent second artifact/record-chain verification before the first
Cloudflare command.
Every local or workflow artifact hop uses `download-and-verify-github-artifact.mjs`; an extracted
directory, artifact name, or caller-supplied digest without GitHub run/artifact/head-SHA binding is
insufficient.

Every dispatch uses the immutable source/release tag `--ref "$RELEASE_TAG"` created at `RELEASE_SHA`;
`gh workflow run --ref` is never given a moving branch. Immediately after checkout, before environment selection or
secret access, the workflow requires `github.sha` to equal the built candidate git SHA in
`build-candidate`, the built-candidate and signed-evidence git SHA in `finalize-release`, the finalized
candidate git SHA in `deploy-staging`, and both finalized-candidate/release-request git SHAs in
`deploy-production`; it also checks each source run's `head_sha` and release tag target.
A branch tip, workflow file, verifier, or source checkout at another SHA fails; staging/production never
use the caller's ambient checkout identity.

`build-candidate` performs one BuildKit solve with two exporters: a canonical linux/amd64 OCI archive for
SBOM/digest provenance and a Docker archive for `docker load`. It verifies both exports have the same
image config digest and ordered rootfs DiffIDs, records OCI distribution-layer digests separately,
bundles the Worker once, and
builds two exact static Pages directories from the validated immutable staging and production API-origin
inputs. It creates dependency-free deterministic USTAR files for both Pages trees, hashes/scans those
deployment artifacts, and stores their archive hashes plus unpacked tree hashes with a strict
`state = "built"`
`processing-candidate.json` in `processing-built-candidate`. `finalize-release` adds only verified signed
evidence and the canonical report to a new `state = "finalized"` candidate. `deploy-staging` first runs
`verify-processing-candidate.mjs --required-state finalized`, loads the verified Docker archive instead
of rebuilding, deploys the stored
Worker module with Wrangler `--no-bundle`, and deploys the stored staging Pages directory. It pushes the
same loaded
image with `wrangler containers push`, immediately inspects that exact authenticated registry tag with
`docker manifest inspect -v`. Registry media-type normalization may change the top-level manifest digest,
so the resolver compares platform, image config digest, and ordered layer digests with the finalized
candidate/release report; any content mismatch fails. The first authenticated Cloudflare registry
manifest digest is then recorded in the staging deployment/release request, and production reuses that
exact registry digest. `wrangler containers images list --json` is tag inventory only and
must never be treated as a digest source. Production reuses the recorded registry digest, the same
Worker module, and the separately prepared production Pages directory carried through the staging
release request; it never runs a source build. Staging must prove its actual Worker target equals the
signed staging API origin, and production must prove the equivalent production origin, before either
Pages deploy.
The build job runs the engine license gate with `--scope build`. After local evidence arrives,
`finalize-release` runs the commercial release gates only after it has verified and loaded the exact
built candidate; the executable order is shown in the finalization sequence below.

Before the build gates, generate and verify notices, build the two Pages variants into isolated
`.artifacts/build/web-{staging,production}` directories, run Wrangler `deploy --dry-run` into
`.artifacts/build/api-worker-bundle`, create
`.artifacts/build/web-{staging,production}.tar` with
`create-deterministic-tree-archive.mjs`, verify each archive/tree pair with
`verify-and-extract-tree-archive.mjs`, hash every deployment file/tree, generate the five Syft
SBOMs, and produce the five Trivy JSON reports with the pinned DB digest.

The release tag must contain the non-example, non-overwritable
`docs/deployment/releases/<release-id>/processing-release-inputs.json` created immediately before
tagging. `build-candidate`
accepts no price, route-envelope, or ceiling override from `workflow_dispatch`; it verifies that file and
uses the sole canonical producer:

The workflow derives `RELEASE_ID` only from the validated `processing-release-<release-id>` tag and
requires the document's `releaseId` and relative path to match. Its `baseSourceSha` must equal the tagged
commit's sole parent, and that final commit may change only this versioned release-input file; a caller
cannot select another file or hide source changes in the release-lock commit.

~~~bash
export RELEASE_INPUTS="docs/deployment/releases/$RELEASE_ID/processing-release-inputs.json"
node scripts/create-processing-release-inputs.mjs \
  --verify-only "$RELEASE_INPUTS" \
  --schema docs/deployment/processing-release-inputs.schema.json
node scripts/create-live-cost-model.mjs \
  --release-inputs "$RELEASE_INPUTS" \
  --schema docs/deployment/live-cost-model.schema.json \
  --output .artifacts/build/live-cost-model.json
~~~

The built candidate binds both the release-input document SHA-256 and generated live-cost-model SHA-256.

At the end of `build-candidate`, create only the immutable built root:

~~~bash
node scripts/create-processing-candidate.mjs \
  --source-root .artifacts/build \
  --output-root .artifacts/built-candidate \
  --release-id "$RELEASE_ID" \
  --git-sha "$RELEASE_SHA" \
  --staging-processing-api-origin "$STAGING_PROCESSING_API_ORIGIN" \
  --production-processing-api-origin "$PRODUCTION_PROCESSING_API_ORIGIN" \
  --staging-web-tree-sha256 "$STAGING_WEB_TREE_SHA256" \
  --production-web-tree-sha256 "$PRODUCTION_WEB_TREE_SHA256" \
  --trivy-db-digest "$TRIVY_DB_DIGEST" \
  --provider-usage-schema docs/deployment/provider-usage-schema.v1.json
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/built-candidate/processing-candidate.json \
  --root .artifacts/built-candidate \
  --required-state built \
  --expected-git-sha "$RELEASE_SHA"
~~~

After the exact built candidate passes local private review, `finalize-release` verifies the evidence
binding and creates the report/finalized root with tested producers rather than workflow-inline JSON:

~~~bash
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/built-candidate/processing-candidate.json \
  --root .artifacts/built-candidate \
  --required-state built \
  --expected-git-sha "$RELEASE_SHA"
docker load \
  --input .artifacts/built-candidate/image-engine-linux-amd64.docker.tar
export BUILT_ENGINE_IMAGE="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/built-candidate/processing-candidate.json \
    --field engine.loadedImage
)"
node scripts/verify-processing-evidence-bundle.mjs \
  --bundle .artifacts/evidence/processing-evidence.json \
  --signature .artifacts/evidence/processing-evidence.sig \
  --candidate-root .artifacts/built-candidate \
  --extract-reviews .artifacts/evidence/reviews
node scripts/verify-image-engine-licenses.mjs \
  --scope release \
  --image "$BUILT_ENGINE_IMAGE" \
  --lock apps/image-engine/native/sources.lock.json \
  --policy apps/image-engine/licenses/policy.json \
  --commercial-review .artifacts/evidence/reviews/commercial-review.json
node scripts/verify-web-licenses.mjs \
  --web-out-staging .artifacts/built-candidate/web-staging \
  --web-out-production .artifacts/built-candidate/web-production \
  --worker-bundle .artifacts/built-candidate/api-worker \
  --lockfile pnpm-lock.yaml \
  --policy security/application-license-policy.json \
  --notices .artifacts/built-candidate/notices/THIRD_PARTY_NOTICES.txt
export TRIVY_DB_DIGEST="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/built-candidate/processing-candidate.json \
    --field security.trivyDbDigest
)"
node scripts/verify-vulnerability-results.mjs \
  --engine .artifacts/built-candidate/security/trivy-engine.json \
  --web-staging .artifacts/built-candidate/security/trivy-web-staging.json \
  --web-production .artifacts/built-candidate/security/trivy-web-production.json \
  --worker .artifacts/built-candidate/security/trivy-worker.json \
  --lockfile .artifacts/built-candidate/security/trivy-lockfile.json \
  --engine-exceptions apps/image-engine/security/vulnerability-exceptions.json \
  --application-exceptions security/application-vulnerability-exceptions.json \
  --trivy-version 0.72.0 \
  --trivy-db-digest "$TRIVY_DB_DIGEST"
node scripts/create-processing-release-report.mjs \
  --build-inputs .artifacts/built-candidate/reports \
  --review-inputs .artifacts/evidence/reviews \
  --built-candidate .artifacts/built-candidate/processing-candidate.json \
  --evidence .artifacts/evidence/processing-evidence.json \
  --schema docs/deployment/processing-release-report.schema.json \
  --output .artifacts/finalize/reports/release-report.json
node scripts/verify-processing-release-report.mjs \
  --report .artifacts/finalize/reports/release-report.json \
  --built-candidate-root .artifacts/built-candidate \
  --evidence-root .artifacts/evidence
node scripts/finalize-processing-candidate.mjs \
  --built-root .artifacts/built-candidate \
  --release-report .artifacts/finalize/reports/release-report.json \
  --evidence .artifacts/evidence/processing-evidence.json \
  --evidence-signature .artifacts/evidence/processing-evidence.sig \
  --output .artifacts/candidate
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/candidate/processing-candidate.json \
  --root .artifacts/candidate \
  --required-state finalized \
  --expected-git-sha "$RELEASE_SHA"
~~~

Neither candidate producer invokes a compiler, package manager, Docker build, or network.
Every later staging/production/rollback command reads the report only from
`.artifacts/candidate/reports/release-report.json`, whose hash is in the candidate manifest.

- [ ] **Step 6: Document and execute staging provisioning**

> Operational note: this section records the original implementation plan. Use
> [`docs/deployment/processing-staging-bootstrap.md`](../../deployment/processing-staging-bootstrap.md)
> as the canonical executable first-deployment sequence; it includes the sealed provision manifest,
> bootstrap-to-active Container application ID transition, and Queue resume verification added during
> implementation.

Before creating resources, verify `wrangler whoami`, an active Workers paid plan that supports
Containers, Workers Trace Events Logpush, Analytics Engine, the required GraphQL usage fields, and at
least 30 MiB request bodies; a registered Workers.dev subdomain; Docker `linux/amd64`; Email Routing with the alert
destination verified, and a Cloudflare monthly billing alert no higher than the approved one-person
operating budget. Record current Container availability/status for the account in the release artifact;
local fallback and the circuit breaker remain mandatory while the product has no Container SLA.
Download the verified `processing-finalized-candidate`, validate its manifest before credentials, then load and
push the exact release image:

~~~bash
mkdir -p .artifacts
export RELEASE_SHA="$(git rev-parse HEAD)"
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/candidate/processing-candidate.json \
  --root .artifacts/candidate \
  --required-state finalized \
  --expected-git-sha "$RELEASE_SHA"
node scripts/resolve-github-release-assets.mjs \
  --repo liorium/hereisit \
  --release-tag "$RELEASE_TAG" \
  --candidate-root .artifacts/candidate \
  --output .artifacts/processing-release-assets.json
export STAGING_WEB_RELEASE_ASSET_ID="$(
  node scripts/read-processing-release-assets.mjs \
    --manifest .artifacts/processing-release-assets.json \
    --candidate-root .artifacts/candidate \
    --field web.staging.assetId
)"
docker load --input .artifacts/candidate/image-engine-linux-amd64.docker.tar
docker tag "$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field engine.loadedImage
)" "hereisit-image-engine:$RELEASE_SHA"
pnpm exec wrangler containers push "hereisit-image-engine:$RELEASE_SHA"
export REGISTRY_TAG="registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/hereisit-image-engine:$RELEASE_SHA"
docker manifest inspect -v "$REGISTRY_TAG" \
  > .artifacts/cloudflare-container-manifest.json
node scripts/resolve-cloudflare-image-digest.mjs \
  --manifest .artifacts/cloudflare-container-manifest.json \
  --candidate-manifest .artifacts/candidate/processing-candidate.json \
  --image-ref "$REGISTRY_TAG" \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --output .artifacts/engine-image.txt
export ENGINE_IMAGE="$(cat .artifacts/engine-image.txt)"
~~~

`resolve-cloudflare-image-digest.mjs` accepts only the exact `docker manifest inspect -v` response for
the requested authenticated registry tag. It accepts a single descriptor or a descriptor array, selects
exactly one `linux/amd64` image descriptor while ignoring non-runnable attestation descriptors, requires
a `sha256:` digest, verifies the registry account ID, selected `Ref`, and finalized candidate
config/ordered-layer identity, and emits only the same
`registry.cloudflare.com` repository with `@sha256:`. Zero or multiple linux/amd64 images, mutable
output, repository mismatch, or a malformed descriptor fails. Then idempotently ensure staging resources:

~~~bash
export ENVIRONMENT=staging
export BUCKET_NAME=hereisit-processing-staging
export USAGE_LOG_BUCKET_NAME=hereisit-processing-usage-staging
export USAGE_ANALYTICS_DATASET_NAME=hereisit_processing_usage_staging
export WORKER_SCRIPT_NAME=hereisit-processing-staging
export D1_NAME=hereisit-processing-staging
export QUEUE_NAME=hereisit-image-jobs-staging
export DLQ_NAME=hereisit-image-jobs-dlq-staging

node scripts/ensure-cloudflare-processing-resources.mjs \
  --phase provision \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --environment "$ENVIRONMENT" \
  --location apac \
  --bucket-name "$BUCKET_NAME" \
  --usage-log-bucket-name "$USAGE_LOG_BUCKET_NAME" \
  --usage-analytics-dataset-name "$USAGE_ANALYTICS_DATASET_NAME" \
  --worker-script-name "$WORKER_SCRIPT_NAME" \
  --database-name "$D1_NAME" \
  --queue-name "$QUEUE_NAME" \
  --dlq-name "$DLQ_NAME" \
  --output .artifacts/resources-staging.json
export STAGING_D1_DATABASE_ID="$(
  node scripts/read-resource-manifest.mjs \
    --file .artifacts/resources-staging.json \
    --field d1.databaseId
)"
~~~

The ensure helper uses strict JSON from Wrangler/Cloudflare APIs, never human table parsing. On every run
it re-reads and verifies the exact account, names, APAC location hint, Queue versus DLQ identity, one-day
job-object and three-day usage-log lifecycles, no lock/Sippy/notification surprises, empty CORS,
disabled `r2.dev`, zero custom domains, the Analytics Engine dataset name, and the exact unsampled
Workers Trace Events Logpush field/filter/destination contract. The deploy environment supplies a
separate Logs Edit token plus bucket-scoped Logpush R2 access-key ID/secret only through masked
`CLOUDFLARE_LOGPUSH_API_TOKEN`, `LOGPUSH_R2_ACCESS_KEY_ID`, and
`LOGPUSH_R2_SECRET_ACCESS_KEY` environment variables, plus the same read-only
`ANALYTICS_READ_TOKEN` used for schema discovery; the helper never accepts them on the command line
or serializes them. A partial
create followed by rerun converges; a duplicate name, wrong ID/location, public bucket, or policy
mismatch fails without mutating the unexpected resource. Read the staging D1 ID only from its immutable
resource manifest, then run the generator with explicit flags and inspect the resulting file before
deployment:

~~~bash
node scripts/generate-processing-wrangler.mjs \
  --environment staging \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$STAGING_D1_DATABASE_ID" \
  --app-origin http://127.0.0.1:4173 \
  --app-origin http://localhost:4173 \
  --app-origin https://processing-staging.hereisit.pages.dev \
  --bucket-name "$BUCKET_NAME" \
  --usage-log-bucket-name "$USAGE_LOG_BUCKET_NAME" \
  --usage-analytics-dataset-name "$USAGE_ANALYTICS_DATASET_NAME" \
  --queue-name "$QUEUE_NAME" \
  --dlq-name "$DLQ_NAME" \
  --engine-image "$ENGINE_IMAGE" \
  --account-daily-weighted-unit-limit 80000000000 \
  --anonymous-daily-weighted-unit-limit 8000000000 \
  --network-daily-weighted-unit-limit 24000000000 \
  --account-pending-job-limit 10 \
  --network-pending-job-limit 3 \
  --maximum-queued-age-seconds 600 \
  --max-live-median-output-ratio-bps "$CANDIDATE_MAX_MEDIAN_OUTPUT_RATIO_BPS" \
  --max-live-p95-weighted-units "$CANDIDATE_MAX_P95_WEIGHTED_UNITS" \
  --max-live-original-retained-rate-bps "$CANDIDATE_MAX_ORIGINAL_RETAINED_RATE_BPS" \
  --max-live-cost-per-1000-microusd "$CANDIDATE_MAX_COST_PER_1000_MICROUSD" \
  --max-projected-monthly-cost-microusd "$CANDIDATE_MAX_PROJECTED_MONTHLY_COST_MICROUSD" \
  --live-cost-model .artifacts/candidate/live-cost-model.json \
  --live-cost-model-sha256 "$CANDIDATE_LIVE_COST_MODEL_SHA256" \
  --provider-usage-schema-sha256 "$CANDIDATE_PROVIDER_USAGE_SCHEMA_SHA256" \
  --release-report-sha256 "$CANDIDATE_RELEASE_REPORT_SHA256" \
  --session-rate-limit-namespace-id 21001 \
  --network-rate-limit-namespace-id 21002 \
  --job-read-rate-limit-namespace-id 21003 \
  --result-download-rate-limit-namespace-id 21004 \
  --policy-rate-limit-namespace-id 21005 \
  --job-api-network-rate-limit-namespace-id 21006 \
  --alert-destination-address "$ALERT_DESTINATION_ADDRESS" \
  --maintainer-session-hashes-json "$STAGING_MAINTAINER_HASHES_JSON" \
  --rollout-percent 0
~~~

The five candidate guardrails and strict live-cost model come from the immutable signed
release-candidate report and must be positive/complete; broad placeholder ceilings, omitted price
coefficients, an unmeasured monthly ceiling, or a model/provider-schema/release-report hash mismatch is
rejected. Read
the candidate guardrails and hashes only through the allowlisted candidate reader. The staging
maintainer hash list must be non-empty.
Then:

~~~bash
export WORKER_MODULE=.artifacts/candidate/api-worker/worker.mjs
pnpm exec wrangler d1 migrations apply "$D1_NAME" \
  -c .wrangler/generated/wrangler.staging.jsonc --remote
pnpm exec wrangler types \
  -c .wrangler/generated/wrangler.staging.jsonc \
  .wrangler/generated/worker-configuration.staging.d.ts \
  --strict-vars=false
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --no-bundle \
  --dry-run
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --json > .artifacts/wrangler-staging-versions-before.json
: > .artifacts/wrangler-staging-bootstrap.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-staging-bootstrap.ndjson \
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --no-bundle \
  --containers-rollout=immediate
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --json > .artifacts/wrangler-staging-versions-after-bootstrap.json

printf '%s' "$STAGING_ABUSE_HMAC_SECRET_PREVIOUS" |
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_PREVIOUS \
    -c .wrangler/generated/wrangler.staging.jsonc
printf '%s' "$STAGING_ABUSE_HMAC_SECRET_CURRENT" |
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_CURRENT \
    -c .wrangler/generated/wrangler.staging.jsonc
printf '%s' "$STAGING_ANALYTICS_READ_TOKEN" |
  pnpm exec wrangler secret put ANALYTICS_READ_TOKEN \
    -c .wrangler/generated/wrangler.staging.jsonc
printf '%s' "$STAGING_LOGPUSH_STATUS_TOKEN" |
  pnpm exec wrangler secret put LOGPUSH_STATUS_TOKEN \
    -c .wrangler/generated/wrangler.staging.jsonc
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --json > .artifacts/wrangler-staging-versions-after-secrets.json
pnpm exec wrangler secret list \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --format json > .artifacts/wrangler-staging-secrets.json
node scripts/verify-worker-secret-list.mjs \
  --file .artifacts/wrangler-staging-secrets.json

: > .artifacts/wrangler-staging.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-staging.ndjson \
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --no-bundle \
  --containers-rollout=none
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.staging.jsonc \
  --json > .artifacts/wrangler-staging-versions-after-final.json
~~~

Wrangler appends structured command records, so the workflow truncates its dedicated output file before
deploy and uses the exact `WRANGLER_OUTPUT_FILE_PATH` variable. Both HMAC inputs must decode to 32 bytes
of base64url; the Analytics token must be an account-scoped, read-only, non-expired token that can query
the named Analytics Engine dataset and Container usage schema. The separate Logpush-status token has
only the account Logs permission Cloudflare requires for job/status GET and no other product
permissions. All four are masked CI secrets passed only over stdin and never printed. `secret put`
creates an immediate intermediate deployment, so it runs only after the reviewed rollout-zero Worker is
live. The final explicit deploy is the recorded version. On first provisioning, previous and current may
be the same secret. Rotation first deploys quota/rollout zero, copies the old current value into previous,
sets a new current value, waits at least 48 hours while quota reads include both secret/day aliases, then
re-canaries; no rotation occurs under public admission. Analytics-token rotation also requires rollout
zero, puts the replacement, proves both provider queries and one complete hour, then re-canaries; a
missing/expired token never receives a bootstrap exception for public traffic. Rotate it at least every
90 days and immediately after any suspected exposure. Rotate the bucket-scoped Logpush destination key
under rollout zero by updating and verifying the job, observing a complete hour on the new destination,
and only then revoking the old key. Rotate the Logpush-status token on the same cadence, prove the
GET-only status check, and revoke the predecessor before public admission resumes.
Every Worker-secret rotation repeats the before/bootstrap-or-current/after-secret/final Version snapshot
chain, performs one explicit final rollout-zero deploy, runs `verify-worker-version-chain.mjs --apply-remote`,
and proves the new active ID in the telemetry canary before any maintainer/public admission. Direct
production `wrangler secret put` outside this recorded rotation workflow is prohibited. Rotating only
the external Logpush destination key does not create a Worker version, but its resource/control record
must still be published before the old key is revoked.

Capture the deployed Worker origin and prove it equals the signed candidate origin. Before the first
workflow-owned Pages deploy, use the existing project's
`Settings → Builds → Branch control` once to disable automatic production deployments and set preview
branch deployments to `None`; otherwise a Git-integrated build without the reviewed public origins could
overwrite the workflow artifact. Then create the staging Pages preview from the already built/scanned
directory.

~~~bash
export STAGING_API_ORIGIN="$(
  node scripts/read-wrangler-output.mjs \
    --file .artifacts/wrangler-staging.ndjson \
    --event deploy \
    --field targets.0
)"
export EXPECTED_STAGING_API_ORIGIN="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.staging.processingApiOrigin
)"
test "$STAGING_API_ORIGIN" = "$EXPECTED_STAGING_API_ORIGIN"
node scripts/verify-worker-version-chain.mjs \
  --before .artifacts/wrangler-staging-versions-before.json \
  --after-bootstrap .artifacts/wrangler-staging-versions-after-bootstrap.json \
  --after-secrets .artifacts/wrangler-staging-versions-after-secrets.json \
  --after-final .artifacts/wrangler-staging-versions-after-final.json \
  --bootstrap-output .artifacts/wrangler-staging-bootstrap.ndjson \
  --final-output .artifacts/wrangler-staging.ndjson \
  --worker-module "$WORKER_MODULE" \
  --config .wrangler/generated/wrangler.staging.jsonc \
  --release-report .artifacts/candidate/reports/release-report.json \
  --database-name "$D1_NAME" \
  --apply-remote \
  --output .artifacts/staging-worker-version-attestations.json
node scripts/smoke-image-compress-server.mjs \
  --api-origin "$STAGING_API_ORIGIN" \
  --telemetry-canary-only
node scripts/ensure-cloudflare-processing-resources.mjs \
  --phase verify-telemetry \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --environment staging \
  --worker-script-name hereisit-processing-staging \
  --usage-analytics-dataset-name "$USAGE_ANALYTICS_DATASET_NAME" \
  --provider-usage-schema docs/deployment/cloudflare-provider-usage.schema.json \
  --worker-version-attestations .artifacts/staging-worker-version-attestations.json \
  --manifest .artifacts/resources-staging.json
export STAGING_PROVIDER_USAGE_SCHEMA_SHA256="$(
  node scripts/read-resource-manifest.mjs \
    --file .artifacts/resources-staging.json \
    --field providerUsage.schemaSha256
)"
test "$STAGING_PROVIDER_USAGE_SCHEMA_SHA256" = "$CANDIDATE_PROVIDER_USAGE_SCHEMA_SHA256"
export STAGING_WEB_OUT=.artifacts/candidate/web-staging
: > .artifacts/wrangler-pages-staging.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-pages-staging.ndjson \
pnpm exec wrangler pages deploy "$STAGING_WEB_OUT" \
  --project-name hereisit \
  --branch processing-staging
export STAGING_PAGES_DEPLOYMENT_URL="$(
  node scripts/read-wrangler-output.mjs \
    --file .artifacts/wrangler-pages-staging.ndjson \
    --event pages-deploy \
    --expected-pages-project hereisit \
    --expected-branch processing-staging \
    --field url
)"
export STAGING_PAGES_URL=https://processing-staging.hereisit.pages.dev
node scripts/verify-pages-alias.mjs \
  --pages-output .artifacts/wrangler-pages-staging.ndjson \
  --project hereisit \
  --branch processing-staging \
  --stable-url "$STAGING_PAGES_URL"
~~~

`--telemetry-canary-only` calls only the public policy route with a fresh anonymous session and requires
the rollout-zero/local response; it never needs maintainer authentication, creates no job/upload, and
exists solely to emit the first attested Analytics point. The same probe therefore works for initial
production where the maintainer allowlist is intentionally empty.

`read-wrangler-output.mjs` parses exactly one matching NDJSON event and rejects missing, duplicate, or
non-HTTPS targets. Wait until `wrangler containers list`
reports ready. The unique `STAGING_PAGES_DEPLOYMENT_URL` is recorded, but the authenticated Pages API
must first prove the allowed stable alias points to the same deployment ID. Run the Playwright staging
smoke from `https://processing-staging.hereisit.pages.dev` with the allowlisted maintainer session. It must perform
an actual browser OPTIONS preflight and authenticated exact-length Worker PUT, complete
Queue/container/download/lease acknowledgement, and prove immediate acknowledgement deletion plus
healthy-path unacknowledged deletion within the 35-minute SLO before creating production resources. It
also injects a missed-sweep condition and proves the circuit/alert fires while the disclosure still
reports exceptional delay as possible. A random non-maintainer session must receive local policy and
create no upload. After that exact `STAGING_PAGES_URL` passes, write a combined staging evidence record
with the Worker version/config hash, deterministic web directory and `_headers` hashes, Pages deployment
ID/URL, engine/release/privacy/license/application-SBOM/vulnerability/live-cost-model hashes, and smoke
artifact, plus the discovered provider-usage schema and Logpush configuration hashes. Production
provisioning consumes that
record rather than a branch name.

~~~bash
export STAGING_DEPLOYMENT_RECORD="$(
  node scripts/record-processing-deployment.mjs \
  --environment staging \
  --config .wrangler/generated/wrangler.staging.jsonc \
  --wrangler-output .artifacts/wrangler-staging.ndjson \
  --worker-version-attestations .artifacts/staging-worker-version-attestations.json \
  --release-report .artifacts/candidate/reports/release-report.json \
  --web-out "$STAGING_WEB_OUT" \
  --web-artifact-id "$STAGING_WEB_RELEASE_ASSET_ID" \
  --pages-output .artifacts/wrangler-pages-staging.ndjson \
  --smoked-pages-url "$STAGING_PAGES_URL" \
  --output-dir .artifacts/deployments
)"
node scripts/create-processing-release-request.mjs \
  --candidate-root .artifacts/candidate \
  --candidate-manifest .artifacts/candidate/processing-candidate.json \
  --release-assets .artifacts/processing-release-assets.json \
  --staging-deployment "$STAGING_DEPLOYMENT_RECORD" \
  --schema docs/deployment/processing-release-request.schema.json \
  --output-root .artifacts/release
node scripts/verify-processing-release-request.mjs \
  --request .artifacts/release/processing-release-request.json \
  --root .artifacts/release
~~~

The record helper writes content-free diagnostics to stderr and exactly one created path to stdout so
shell capture is unambiguous. Upload only `.artifacts/release/` as
`processing-release-request`; its allowlisted `candidate/` subtree contains the exact Worker module,
both engine archives, both Pages directories and deterministic archives, reviews, reports, policies,
SBOM/scan results, and candidate manifest required by the full production verifier. Production deploys
the authenticated registry digest recorded by staging rather than pushing the archive again, but the
unchanged full candidate remains present for end-to-end identity verification and long-term rollback.

- [ ] **Step 7: Provision production disabled, deploy Pages, then canary by reviewed config**

Create deterministic production resource names as above. Generate production config first with
all three weighted-unit limits `0`, rollout `0`, six production Rate Limit namespaces `22001`–`22006`, the
production origin, verified alert destination, and exact reviewed `ENGINE_IMAGE`. Apply the one-day
lifecycle policy, both migrations, dry-run, deploy once, wait for Container readiness, and verify health.
This safely deploys the platform while `POST /v1/jobs` remains disabled.
Export the three quality/resource guardrails plus `RELEASE_MAX_COST_PER_1000_MICROUSD`,
`RELEASE_MAX_PROJECTED_MONTHLY_COST_MICROUSD`, `RELEASE_LIVE_COST_MODEL_SHA256`, and
`RELEASE_PROVIDER_USAGE_SCHEMA_SHA256` and `RELEASE_REPORT_SHA256` from the verified
release-request/candidate manifests; the workflow rejects
unset, non-positive, or mismatched values.

~~~bash
node scripts/verify-processing-release-request.mjs \
  --request .artifacts/processing-release-request.json \
  --root .artifacts
export ENGINE_IMAGE="$(
  node scripts/read-processing-release-request.mjs \
    --request .artifacts/processing-release-request.json \
    --root .artifacts \
    --field engine.cloudflareRegistryImage
)"
export PRODUCTION_WEB_RELEASE_ASSET_ID="$(
  node scripts/read-processing-release-request.mjs \
    --request .artifacts/processing-release-request.json \
    --root .artifacts \
    --field releaseAssets.web.production.assetId
)"
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/candidate/processing-candidate.json \
  --root .artifacts/candidate \
  --required-state finalized \
  --expected-git-sha "$RELEASE_SHA"
export PRODUCTION_BUCKET_NAME=hereisit-processing-production
export PRODUCTION_USAGE_LOG_BUCKET_NAME=hereisit-processing-usage-production
export PRODUCTION_USAGE_ANALYTICS_DATASET_NAME=hereisit_processing_usage_production
export PRODUCTION_D1_NAME=hereisit-processing-production
export PRODUCTION_QUEUE_NAME=hereisit-image-jobs-production
export PRODUCTION_DLQ_NAME=hereisit-image-jobs-dlq-production

node scripts/ensure-cloudflare-processing-resources.mjs \
  --phase provision \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --environment production \
  --location apac \
  --bucket-name "$PRODUCTION_BUCKET_NAME" \
  --usage-log-bucket-name "$PRODUCTION_USAGE_LOG_BUCKET_NAME" \
  --usage-analytics-dataset-name "$PRODUCTION_USAGE_ANALYTICS_DATASET_NAME" \
  --worker-script-name hereisit-processing-production \
  --database-name "$PRODUCTION_D1_NAME" \
  --queue-name "$PRODUCTION_QUEUE_NAME" \
  --dlq-name "$PRODUCTION_DLQ_NAME" \
  --output .artifacts/resources-production.json
export PRODUCTION_D1_DATABASE_ID="$(
  node scripts/read-resource-manifest.mjs \
    --file .artifacts/resources-production.json \
    --field d1.databaseId
)"
~~~

Never reuse a staging ID, dataset, usage bucket, Logpush job, or access credential. The same
private-bucket/lifecycle/dataset/filter/location/role checks apply on every production rerun.

~~~bash
node scripts/generate-processing-wrangler.mjs \
  --environment production \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$PRODUCTION_D1_DATABASE_ID" \
  --app-origin https://hereisit.pages.dev \
  --bucket-name "$PRODUCTION_BUCKET_NAME" \
  --usage-log-bucket-name "$PRODUCTION_USAGE_LOG_BUCKET_NAME" \
  --usage-analytics-dataset-name "$PRODUCTION_USAGE_ANALYTICS_DATASET_NAME" \
  --queue-name "$PRODUCTION_QUEUE_NAME" \
  --dlq-name "$PRODUCTION_DLQ_NAME" \
  --engine-image "$ENGINE_IMAGE" \
  --account-daily-weighted-unit-limit 0 \
  --anonymous-daily-weighted-unit-limit 0 \
  --network-daily-weighted-unit-limit 0 \
  --account-pending-job-limit 10 \
  --network-pending-job-limit 3 \
  --maximum-queued-age-seconds 600 \
  --max-live-median-output-ratio-bps "$RELEASE_MAX_MEDIAN_OUTPUT_RATIO_BPS" \
  --max-live-p95-weighted-units "$RELEASE_MAX_P95_WEIGHTED_UNITS" \
  --max-live-original-retained-rate-bps "$RELEASE_MAX_ORIGINAL_RETAINED_RATE_BPS" \
  --max-live-cost-per-1000-microusd "$RELEASE_MAX_COST_PER_1000_MICROUSD" \
  --max-projected-monthly-cost-microusd "$RELEASE_MAX_PROJECTED_MONTHLY_COST_MICROUSD" \
  --live-cost-model .artifacts/candidate/live-cost-model.json \
  --live-cost-model-sha256 "$RELEASE_LIVE_COST_MODEL_SHA256" \
  --provider-usage-schema-sha256 "$RELEASE_PROVIDER_USAGE_SCHEMA_SHA256" \
  --release-report-sha256 "$RELEASE_REPORT_SHA256" \
  --session-rate-limit-namespace-id 22001 \
  --network-rate-limit-namespace-id 22002 \
  --job-read-rate-limit-namespace-id 22003 \
  --result-download-rate-limit-namespace-id 22004 \
  --policy-rate-limit-namespace-id 22005 \
  --job-api-network-rate-limit-namespace-id 22006 \
  --alert-destination-address "$ALERT_DESTINATION_ADDRESS" \
  --maintainer-session-hashes-json '[]' \
  --rollout-percent 0
~~~

~~~bash
export WORKER_MODULE=.artifacts/candidate/api-worker/worker.mjs
pnpm exec wrangler d1 migrations apply "$PRODUCTION_D1_NAME" \
  -c .wrangler/generated/wrangler.production.jsonc --remote
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.production.jsonc \
  --no-bundle \
  --dry-run
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.production.jsonc \
  --json > .artifacts/wrangler-production-versions-before.json
: > .artifacts/wrangler-production-bootstrap.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-production-bootstrap.ndjson \
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.production.jsonc \
  --no-bundle \
  --containers-rollout=immediate
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.production.jsonc \
  --json > .artifacts/wrangler-production-versions-after-bootstrap.json

printf '%s' "$PRODUCTION_ABUSE_HMAC_SECRET_PREVIOUS" |
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_PREVIOUS \
    -c .wrangler/generated/wrangler.production.jsonc
printf '%s' "$PRODUCTION_ABUSE_HMAC_SECRET_CURRENT" |
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_CURRENT \
    -c .wrangler/generated/wrangler.production.jsonc
printf '%s' "$PRODUCTION_ANALYTICS_READ_TOKEN" |
  pnpm exec wrangler secret put ANALYTICS_READ_TOKEN \
    -c .wrangler/generated/wrangler.production.jsonc
printf '%s' "$PRODUCTION_LOGPUSH_STATUS_TOKEN" |
  pnpm exec wrangler secret put LOGPUSH_STATUS_TOKEN \
    -c .wrangler/generated/wrangler.production.jsonc
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.production.jsonc \
  --json > .artifacts/wrangler-production-versions-after-secrets.json
pnpm exec wrangler secret list \
  -c .wrangler/generated/wrangler.production.jsonc \
  --format json > .artifacts/wrangler-production-secrets.json
node scripts/verify-worker-secret-list.mjs \
  --file .artifacts/wrangler-production-secrets.json

: > .artifacts/wrangler-production.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-production.ndjson \
pnpm exec wrangler deploy "$WORKER_MODULE" \
  -c .wrangler/generated/wrangler.production.jsonc \
  --no-bundle \
  --containers-rollout=none
pnpm exec wrangler versions list \
  -c .wrangler/generated/wrangler.production.jsonc \
  --json > .artifacts/wrangler-production-versions-after-final.json
~~~

Deploy the already built/scanned production static site, capturing the exact Pages deployment:

~~~bash
export PRODUCTION_API_ORIGIN="$(
  node scripts/read-wrangler-output.mjs \
    --file .artifacts/wrangler-production.ndjson \
    --event deploy \
    --field targets.0
)"
export EXPECTED_PRODUCTION_API_ORIGIN="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.production.processingApiOrigin
)"
test "$PRODUCTION_API_ORIGIN" = "$EXPECTED_PRODUCTION_API_ORIGIN"
node scripts/verify-worker-version-chain.mjs \
  --before .artifacts/wrangler-production-versions-before.json \
  --after-bootstrap .artifacts/wrangler-production-versions-after-bootstrap.json \
  --after-secrets .artifacts/wrangler-production-versions-after-secrets.json \
  --after-final .artifacts/wrangler-production-versions-after-final.json \
  --bootstrap-output .artifacts/wrangler-production-bootstrap.ndjson \
  --final-output .artifacts/wrangler-production.ndjson \
  --worker-module "$WORKER_MODULE" \
  --config .wrangler/generated/wrangler.production.jsonc \
  --release-report .artifacts/candidate/reports/release-report.json \
  --database-name "$PRODUCTION_D1_NAME" \
  --apply-remote \
  --output .artifacts/production-worker-version-attestations.json
node scripts/smoke-image-compress-server.mjs \
  --api-origin "$PRODUCTION_API_ORIGIN" \
  --telemetry-canary-only
node scripts/ensure-cloudflare-processing-resources.mjs \
  --phase verify-telemetry \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --environment production \
  --worker-script-name hereisit-processing-production \
  --usage-analytics-dataset-name "$PRODUCTION_USAGE_ANALYTICS_DATASET_NAME" \
  --provider-usage-schema docs/deployment/cloudflare-provider-usage.schema.json \
  --worker-version-attestations .artifacts/production-worker-version-attestations.json \
  --manifest .artifacts/resources-production.json
export PRODUCTION_PROVIDER_USAGE_SCHEMA_SHA256="$(
  node scripts/read-resource-manifest.mjs \
    --file .artifacts/resources-production.json \
    --field providerUsage.schemaSha256
)"
test "$PRODUCTION_PROVIDER_USAGE_SCHEMA_SHA256" = "$RELEASE_PROVIDER_USAGE_SCHEMA_SHA256"
export PRODUCTION_WEB_OUT=.artifacts/candidate/web-production
: > .artifacts/wrangler-pages-production.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-pages-production.ndjson \
pnpm exec wrangler pages deploy "$PRODUCTION_WEB_OUT" \
  --project-name hereisit \
  --branch main
export PRODUCTION_PAGES_DEPLOYMENT_URL="$(
  node scripts/read-wrangler-output.mjs \
    --file .artifacts/wrangler-pages-production.ndjson \
    --event pages-deploy \
    --expected-pages-project hereisit \
    --expected-branch main \
    --field url
)"
export PRODUCTION_PAGES_URL=https://hereisit.pages.dev
node scripts/verify-pages-alias.mjs \
  --pages-output .artifacts/wrangler-pages-production.ndjson \
  --project hereisit \
  --branch main \
  --stable-url "$PRODUCTION_PAGES_URL"
node scripts/smoke-image-compress-server.mjs \
  --pages-url "$PRODUCTION_PAGES_URL" \
  --expect-policy local
node scripts/record-processing-deployment.mjs \
  --environment production \
  --config .wrangler/generated/wrangler.production.jsonc \
  --wrangler-output .artifacts/wrangler-production.ndjson \
  --worker-version-attestations .artifacts/production-worker-version-attestations.json \
  --release-report .artifacts/candidate/reports/release-report.json \
  --web-out "$PRODUCTION_WEB_OUT" \
  --web-artifact-id "$PRODUCTION_WEB_RELEASE_ASSET_ID" \
  --pages-output .artifacts/wrangler-pages-production.ndjson \
  --smoked-pages-url "$PRODUCTION_PAGES_URL" \
  --output-dir .artifacts/deployments
~~~

The production deploy command writes `.artifacts/wrangler-production.ndjson` through
`WRANGLER_OUTPUT_FILE_PATH` before this build. `record-processing-deployment.mjs` runs only after the
stable allowed alias is proven to target the captured unique deployment ID and passes smoke. It
deterministically hashes every static file, binds the generated
`_headers` and processing API origin, Pages deployment ID/URL, immutable workflow artifact ID, Worker
version/config, engine/release/web/Worker-SBOM, vulnerability, live-cost-model, and privacy-review
hashes, and refuses overwrite. Verify the
production Pages policy returns local while limits are zero and no upload starts.

After the full release report passes and the operator selects a non-zero daily allowance within the
approved monthly budget, promote only from the last successful deployment record:

~~~text
disabled → maintainer session allowlist → 5% → 25% → 100%
~~~

~~~bash
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=promote-production \
  -f record_source=release \
  -f record_release_asset_id="$LAST_PRODUCTION_RECORD_RELEASE_ASSET_ID" \
  -f record_size="$LAST_PRODUCTION_RECORD_SIZE" \
  -f record_sha256="$LAST_PRODUCTION_RECORD_SHA256" \
  -f record_predecessor_sha256="$LAST_PRODUCTION_RECORD_PREDECESSOR_SHA256" \
  -f stage=maintainer \
  -f account_daily_weighted_unit_limit="$APPROVED_ACCOUNT_DAILY_UNITS" \
  -f anonymous_daily_weighted_unit_limit="$APPROVED_ANONYMOUS_DAILY_UNITS" \
  -f network_daily_weighted_unit_limit="$APPROVED_NETWORK_DAILY_UNITS" \
  -f confirmation_id="$PROMOTION_CONFIRMATION_ID"

# After the hold/gates pass, rerun with --stage 5, then 25, then 100.
~~~

The manual production job downloads/verifies the record artifact before credentials, then invokes
`promote-processing-rollout.mjs`. The script verifies the current Cloudflare deployment with
`wrangler deployments status --json`, the prior record's Worker version/config hash/release hash, the
same immutable engine digest, the still-current smoked Pages deployment/web artifact/`_headers` hash, a
closed circuit, a complete zero-overdue deletion sweep, and the next legal stage. Before stage 5 or
higher it also CAS-verifies the current accounting epoch, model/schema/release hashes, 24 sequential
sealed provider-complete hours, both live ceilings, and `last_cost_window_complete = 1`. It changes only
reviewed quota/maintainer/rollout values, deploys with
the recorded no-bundle Worker module plus `--no-bundle --containers-rollout=none`, captures
`WRANGLER_OUTPUT_FILE_PATH`, snapshots/attests the new Version Metadata ID before telemetry sealing,
runs policy/health smoke, and writes
the next immutable successful combined deployment record while carrying web identity unchanged. Any
failed smoke leaves the prior record authoritative
and triggers rollback. Its new deployment record is uploaded as an Actions artifact and the isolated
publisher appends the same record to the private Release before the workflow can report success.

Hold each public stage long enough to evaluate at least 1,000 valid jobs or 24 hours, whichever comes
later. The runbook defines dashboard queries for success, verifier failure, p95 time, OOM, timeout, output
size, original-retained rate, cost per 1,000 jobs, deletion failures, orphan count, alerts, and circuit
state. At every stage the
application circuit breaker can reduce effective rollout to zero immediately; a subsequent config deploy
never silently clears it.

- [ ] **Step 8: Define one-command rollback, manual reset, and DLQ inspection**

`rollback-processing.mjs` requires the last successful deployment record, verifies its config hash,
release hash, current Worker version, and immutable engine digest locally, then prepares a rollout-zero
config atomically. After those provenance checks it attempts both safety layers independently: open the
D1 circuit, and deploy rollout zero with no Container change. A D1 outage cannot block the config
kill-switch, and a deploy outage cannot close an already-open circuit. If the incident involves the
frontend/CSP/API origin, it also invokes `rollback-web.mjs` with the previously downloaded immutable web
artifact from that same combined record; it never rebuilds from source:

If the artifact is not already local, the rollback command downloads the exact Worker/Pages/record
assets by private release tag and recorded GitHub asset IDs, verifies size/SHA-256/schema/signature and
predecessor chain, then proceeds. It never depends on an expiring Actions artifact or a branch checkout.

~~~bash
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=rollback-production \
  -f current_record_source=release \
  -f current_record_release_asset_id="$CURRENT_RECORD_RELEASE_ASSET_ID" \
  -f current_record_size="$CURRENT_RECORD_SIZE" \
  -f current_record_sha256="$CURRENT_RECORD_SHA256" \
  -f current_record_predecessor_sha256="$CURRENT_RECORD_PREDECESSOR_SHA256" \
  -f prior_record_release_asset_id="$PRIOR_RECORD_RELEASE_ASSET_ID" \
  -f prior_record_size="$PRIOR_RECORD_SIZE" \
  -f prior_record_sha256="$PRIOR_RECORD_SHA256" \
  -f scope="$ROLLBACK_SCOPE" \
  -f reason=manual-rollback \
  -f confirmation_id="$ROLLBACK_CONFIRMATION_ID"
~~~

The manual job verifies both record chains and private Release assets before production credentials,
then runs `rollback-processing.mjs`. The internal deploy uses the recorded Worker module with
`wrangler deploy <module> --no-bundle --containers-rollout=none`. Its hash and the unchanged immutable
engine digest are verified before deployment, and `none` deliberately updates only Worker admission
without building or rolling the Container. The resulting Version Metadata ID is attested as the sole
active rollback version before telemetry resumes. The runbook verifies policy returns local, active jobs drain or cancel,
inputs/results sweep, Pages local fallback remains functional, and reports `circuit_open` and
`rollout_zero_deployed` separately. `rollback-web.mjs` verifies the recorded artifact hash, redeploys it
to the same Pages project/branch, captures the new Pages deployment ID/URL, waits for
`verify-pages-alias.mjs` to prove the allowlisted stable branch alias points to that exact deployment ID,
then smokes the stable alias and recorded `_headers`/API origin. It never uses the unique deployment URL
as the browser smoke origin. It writes an immutable rollback record and reports Worker and Pages
safety independently and exits non-zero unless config admission is proven disabled; a requested web
rollback must also be proven healthy even when the circuit update succeeded.

Manual reset is performed only by `promote-processing-rollout.mjs --stage maintainer --reset-circuit`
after it proves the currently deployed successful record has rollout zero, the cause is fixed, fresh
staging evidence passes, and a complete deletion-sweep generation finished with zero overdue objects.
The guarded statement is:

~~~sql
UPDATE rollout_control
SET circuit_open = 0,
    reason = NULL,
    opened_at = NULL,
    manual_reset_at = unixepoch() * 1000
WHERE id = 1
  AND circuit_open = 1
  AND deletion_overdue_count = 0
  AND deletion_sweep_generation = :expectedDeletionSweepGeneration
  AND deletion_sweep_completed_at = :expectedDeletionSweepCompletedAt
  AND opened_at IS NOT NULL
  AND deletion_sweep_completed_at > opened_at;
~~~

Reset always returns to maintainer-only; the operator must repeat 5% → 25% → 100%. It can never restore
the pre-incident percentage directly. The script reads and records the expected generation/completion
pair after staging passes, then uses the single CAS above; a new circuit event, partial/new sweep, stale
zero, or concurrent reset changes zero rows and aborts.

`inspect-processing-job.mjs` requires a job UUID, successful deployment record, and database name. It
reads only normalized D1 fields, quarantine state, and the sweeper's last artifact-presence audit; it
prints state, attempt, lease timestamps, cancellation, stored size/content type, audit booleans,
quarantine code, and settlement—never object keys/bytes, token hashes, URLs, credentials, or metadata
values. Task 6 deletes inputs on DLQ terminalization, so v1 never replays a DLQ message. After inspection
the operator marks the quarantine row inspected and the user starts a fresh job; this avoids reviving a
settled or deleted attempt.

The D1 Time Travel runbook treats restore as a destructive incident operation, not ordinary rollback:

~~~bash
gh workflow run image-engine.yml \
  --ref "$RELEASE_TAG" \
  -f mode=restore-production \
  -f record_source=release \
  -f record_release_asset_id="$CURRENT_RECORD_RELEASE_ASSET_ID" \
  -f record_size="$CURRENT_RECORD_SIZE" \
  -f record_sha256="$CURRENT_RECORD_SHA256" \
  -f record_predecessor_sha256="$CURRENT_RECORD_PREDECESSOR_SHA256" \
  -f restore_bookmark="$REVIEWED_RESTORE_BOOKMARK" \
  -f confirmation_id="$RESTORE_CONFIRMATION_ID"
~~~

The following commands are the guarded steps inside that environment-protected manual workflow; they
are not an unrecorded operator-side mutation:

1. Invoke `rollback-processing.mjs` and prove the deployed config has rollout zero. Open the current D1
   circuit and stop promotions. Pause primary Queue delivery before touching D1:

   ~~~bash
   pnpm exec wrangler queues pause-delivery hereisit-image-jobs-production
   pnpm exec wrangler queues pause-delivery hereisit-image-jobs-dlq-production
   node scripts/verify-queue-delivery-state.mjs \
     --queue hereisit-image-jobs-production \
     --expected paused \
     --account-id "$CLOUDFLARE_ACCOUNT_ID"
   node scripts/verify-queue-delivery-state.mjs \
     --queue hereisit-image-jobs-dlq-production \
     --expected paused \
     --account-id "$CLOUDFLARE_ACCOUNT_ID"
   ~~~

   Pausing stops new push/pull delivery but does not cancel in-flight work. Wait until D1 shows no
   unexpired running lease and the engine has no active workspace, or fenced-cancel/drain those jobs.
   Capture the current bookmark with
   `wrangler d1 time-travel info hereisit-processing-production --json` only after the pause/drain proof.
2. Restore only from the reviewed RFC3339 timestamp/bookmark with pinned Wrangler:

   ~~~bash
   pnpm exec wrangler d1 time-travel restore \
     hereisit-processing-production \
     --bookmark "$REVIEWED_RESTORE_BOOKMARK" \
     --config .wrangler/generated/wrangler.production.jsonc
   ~~~

   Capture the returned previous bookmark so the destructive in-place restore can itself be undone.
3. Because the restored database may predate the current migration or `rollout_control` state, keep the
   independently deployed rollout-zero config authoritative, inspect the restored migration ledger, and
   apply the exact current forward migrations before any job route is enabled. Immediately create/reopen
   the current circuit row, then run `reconcile-restored-processing-db.mjs` with the fresh signed
   rollout-zero rollback control record produced in step 1, its predecessor successful deployment
   record, restore timestamp, and current R2 bucket. A migration failure stops recovery and leaves config
   admission at zero.
4. In one bounded, restartable reconciliation, first scrub every restored job/ledger network hash and
   `network_usage` row already past 48 hours, usage-log ledger row past seven days, and aggregate row past
   35 days, then compare remaining jobs with current time and R2 heads. Expired terminal rows become
   minimal cleanup tombstones and lose
   all linkable metadata;
   missing-input jobs settle and expire; valid recoverable queued/running jobs have leases cleared,
   `queue_generation` incremented, a new random `queue_epoch` assigned, and exactly one fresh outbox
   message rebuilt; output rows are retained
   only when both verification state and current result deadline permit it. Delete or quarantine
   impossible state instead of guessing. In the same guarded transaction, create a fresh random
   cost-accounting epoch beginning at the next UTC-hour boundary, clear `first_admitted_at`, sealed/eval
   cursors, cost breach windows, and `last_cost_window_complete`, and leave all old epoch rows immutable.
   This avoids demanding Trace Events objects already removed by the usage-log cleanup path. Replace any
   restored Worker-version rows with the exact active/retired attestation chain in the fresh signed
   rollout-zero rollback control record from step 1—not the pre-rollback successful record—before
   delivery resumes.
5. A Queue consumer must compare both the message epoch and generation with the current job before any
   R2/container work. The new random epoch prevents a pre-restore future-generation message from
   colliding with an incremented restored integer, so every old Queue message acknowledges as a stale
   duplicate. While delivery remains paused, dispatch only the newly rebuilt epoch/generation, run
   complete artifact/tombstone/orphan and deletion-audit sweeps, and require zero overdue objects and an
   empty stale outbox.
6. Resume delivery only after the reconciliation/audit record is sealed:

   ~~~bash
   pnpm exec wrangler queues resume-delivery hereisit-image-jobs-production
   pnpm exec wrangler queues resume-delivery hereisit-image-jobs-dlq-production
   node scripts/verify-queue-delivery-state.mjs \
     --queue hereisit-image-jobs-production \
     --expected resumed \
     --account-id "$CLOUDFLARE_ACCOUNT_ID"
   node scripts/verify-queue-delivery-state.mjs \
     --queue hereisit-image-jobs-dlq-production \
     --expected resumed \
     --account-id "$CLOUDFLARE_ACCOUNT_ID"
   ~~~

   Observe the backlog until old messages acknowledge as stale and only new-epoch messages may contact
   R2/Container. Record pause/drain/restore/migration/reconcile/resume timestamps and Queue backlog in the
   incident artifact.
7. Re-run staging evidence against the restored schema/state, then reset only to maintainer canary.
   Collect 24 new sequential provider-complete hours in the new accounting epoch before public 5%.
   Public 5% → 25% → 100% promotion starts over; a restore never resumes the previous rollout directly.

The reconciliation report records reviewed/previous/result bookmarks, restored timestamp, counts by
normalized action (including expired-network/aggregate scrubs), Queue pause/drain/resume evidence, R2
audit generation, stale-message proof, and final circuit/rollout state—never object keys, tokens,
session/network hashes, or file-derived metadata. The workflow uploads that record as an Actions
artifact and the isolated publisher appends it to the private Release before restore success is
reported.

- [ ] **Step 9: Run final repository verification**

Run:

~~~bash
pnpm test \
  tests/generate-processing-wrangler.test.ts \
  tests/resolve-cloudflare-image-digest.test.ts \
  tests/read-wrangler-output.test.ts \
  tests/download-and-verify-github-artifact.test.ts \
  tests/resolve-github-release-assets.test.ts \
  tests/read-processing-release-assets.test.ts \
  tests/create-deterministic-tree-archive.test.ts \
  tests/verify-and-extract-tree-archive.test.ts \
  tests/record-processing-deployment.test.ts \
  tests/promote-processing-rollout.test.ts \
  tests/rollback-processing.test.ts \
  tests/rollback-web.test.ts \
  tests/inspect-processing-job.test.ts \
  tests/ensure-cloudflare-processing-resources.test.ts \
  tests/read-resource-manifest.test.ts \
  tests/verify-worker-secret-list.test.ts \
  tests/verify-worker-version-chain.test.ts \
  tests/verify-pages-alias.test.ts \
  tests/verify-privacy-review.test.ts \
  tests/verify-web-licenses.test.ts \
  tests/verify-vulnerability-results.test.ts \
  tests/verify-processing-release-request.test.ts \
  tests/read-processing-release-request.test.ts \
  tests/create-processing-release-request.test.ts \
  tests/create-processing-release-report.test.ts \
  tests/verify-processing-release-report.test.ts \
  tests/verify-processing-candidate.test.ts \
  tests/create-processing-candidate.test.ts \
  tests/finalize-processing-candidate.test.ts \
  tests/read-processing-candidate.test.ts \
  tests/create-processing-evidence-bundle.test.ts \
  tests/verify-processing-evidence-bundle.test.ts \
  tests/reconcile-restored-processing-db.test.ts \
  tests/verify-queue-delivery-state.test.ts \
  tests/processing-release-chain.test.ts \
  tests/image-engine-workflow.test.ts \
  apps/api-worker/src/circuit-breaker.test.ts \
  apps/api-worker/src/operational-alerts.test.ts \
  apps/api-worker/src/live-cost.test.ts \
  apps/api-worker/src/usage-analytics.test.ts \
  apps/api-worker/src/d1-job-repository.test.ts \
  apps/api-worker/src/outbox.test.ts \
  apps/api-worker/src/queue-consumer.test.ts \
  apps/api-worker/src/container-client.test.ts \
  apps/api-worker/src/r2-artifacts.test.ts \
  apps/api-worker/src/telemetry.test.ts \
  apps/api-worker/src/sweeper.test.ts \
  apps/api-worker/src/routes/jobs.test.ts \
  apps/api-worker/src/routes/uploads.test.ts \
  apps/api-worker/src/routes/results.test.ts \
  apps/api-worker/src/routes/policy.test.ts \
  apps/api-worker/test/worker.integration.test.ts \
  --run
pnpm verify:all
.artifacts/tools/actionlint \
  -shellcheck=.artifacts/tools/shellcheck \
  .github/workflows/*.yml
node scripts/verify-processing-candidate.mjs \
  --manifest .artifacts/candidate/processing-candidate.json \
  --root .artifacts/candidate \
  --required-state finalized \
  --expected-git-sha "$(git rev-parse HEAD)"
node scripts/verify-processing-release-report.mjs \
  --report .artifacts/candidate/reports/release-report.json \
  --built-candidate-root .artifacts/candidate \
  --evidence-root .artifacts/candidate/evidence
export STAGING_WEB_ARCHIVE_SHA256="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.staging.archiveSha256
)"
export STAGING_WEB_TREE_SHA256="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.staging.treeSha256
)"
export PRODUCTION_WEB_ARCHIVE_SHA256="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.production.archiveSha256
)"
export PRODUCTION_WEB_TREE_SHA256="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field web.production.treeSha256
)"
node scripts/verify-and-extract-tree-archive.mjs \
  --archive .artifacts/candidate/web-staging.tar \
  --expected-archive-sha256 "$STAGING_WEB_ARCHIVE_SHA256" \
  --expected-tree-sha256 "$STAGING_WEB_TREE_SHA256" \
  --output .artifacts/final-verification/web-staging
node scripts/verify-and-extract-tree-archive.mjs \
  --archive .artifacts/candidate/web-production.tar \
  --expected-archive-sha256 "$PRODUCTION_WEB_ARCHIVE_SHA256" \
  --expected-tree-sha256 "$PRODUCTION_WEB_TREE_SHA256" \
  --output .artifacts/final-verification/web-production
docker load \
  --input .artifacts/candidate/image-engine-linux-amd64.docker.tar
export VERIFIED_ENGINE_IMAGE="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field engine.loadedImage
)"
node scripts/verify-image-engine-licenses.mjs \
  --scope release \
  --image "$VERIFIED_ENGINE_IMAGE" \
  --lock apps/image-engine/native/sources.lock.json \
  --policy apps/image-engine/licenses/policy.json \
  --commercial-review .artifacts/candidate/reviews/commercial-review.json
node scripts/verify-web-licenses.mjs \
  --web-out-staging .artifacts/final-verification/web-staging \
  --web-out-production .artifacts/final-verification/web-production \
  --worker-bundle .artifacts/candidate/api-worker \
  --lockfile pnpm-lock.yaml \
  --policy security/application-license-policy.json \
  --notices apps/web/public/THIRD_PARTY_NOTICES.txt
export TRIVY_DB_DIGEST="$(
  node scripts/read-processing-candidate.mjs \
    --manifest .artifacts/candidate/processing-candidate.json \
    --field security.trivyDbDigest
)"
node scripts/verify-vulnerability-results.mjs \
  --engine .artifacts/candidate/security/trivy-engine.json \
  --web-staging .artifacts/candidate/security/trivy-web-staging.json \
  --web-production .artifacts/candidate/security/trivy-web-production.json \
  --worker .artifacts/candidate/security/trivy-worker.json \
  --lockfile .artifacts/candidate/security/trivy-lockfile.json \
  --engine-exceptions apps/image-engine/security/vulnerability-exceptions.json \
  --application-exceptions security/application-vulnerability-exceptions.json \
  --trivy-version 0.72.0 \
  --trivy-db-digest "$TRIVY_DB_DIGEST"
git diff --check
git status --short
~~~

Expected: every automated gate PASS, the candidate/report hashes match the artifacts actually scanned,
the loaded engine config/ordered layers and both extracted Pages tree hashes match the finalized
candidate, no release artifact is rebuilt from source in this step, and `git status --short` shows only
the intended Task 18 files.

- [ ] **Step 10: Commit**

~~~bash
git add \
  scripts/generate-processing-wrangler.mjs \
  scripts/rollback-processing.mjs \
  scripts/rollback-web.mjs \
  scripts/promote-processing-rollout.mjs \
  scripts/record-processing-deployment.mjs \
  scripts/inspect-processing-job.mjs \
  scripts/resolve-cloudflare-image-digest.mjs \
  scripts/read-wrangler-output.mjs \
  scripts/download-and-verify-github-artifact.mjs \
  scripts/resolve-github-release-assets.mjs \
  scripts/read-processing-release-assets.mjs \
  scripts/create-deterministic-tree-archive.mjs \
  scripts/verify-and-extract-tree-archive.mjs \
  scripts/ensure-cloudflare-processing-resources.mjs \
  scripts/read-resource-manifest.mjs \
  scripts/verify-worker-secret-list.mjs \
  scripts/verify-worker-version-chain.mjs \
  scripts/verify-pages-alias.mjs \
  scripts/verify-privacy-review.mjs \
  scripts/verify-web-licenses.mjs \
  scripts/verify-vulnerability-results.mjs \
  scripts/verify-processing-release-request.mjs \
  scripts/read-processing-release-request.mjs \
  scripts/create-processing-release-request.mjs \
  scripts/create-processing-release-report.mjs \
  scripts/verify-processing-release-report.mjs \
  scripts/verify-processing-candidate.mjs \
  scripts/create-processing-candidate.mjs \
  scripts/finalize-processing-candidate.mjs \
  scripts/read-processing-candidate.mjs \
  scripts/create-processing-evidence-bundle.mjs \
  scripts/verify-processing-evidence-bundle.mjs \
  scripts/reconcile-restored-processing-db.mjs \
  scripts/verify-queue-delivery-state.mjs \
  tests/generate-processing-wrangler.test.ts \
  tests/rollback-processing.test.ts \
  tests/rollback-web.test.ts \
  tests/promote-processing-rollout.test.ts \
  tests/record-processing-deployment.test.ts \
  tests/inspect-processing-job.test.ts \
  tests/resolve-cloudflare-image-digest.test.ts \
  tests/read-wrangler-output.test.ts \
  tests/download-and-verify-github-artifact.test.ts \
  tests/resolve-github-release-assets.test.ts \
  tests/read-processing-release-assets.test.ts \
  tests/create-deterministic-tree-archive.test.ts \
  tests/verify-and-extract-tree-archive.test.ts \
  tests/ensure-cloudflare-processing-resources.test.ts \
  tests/read-resource-manifest.test.ts \
  tests/verify-worker-secret-list.test.ts \
  tests/verify-worker-version-chain.test.ts \
  tests/verify-pages-alias.test.ts \
  tests/verify-privacy-review.test.ts \
  tests/verify-web-licenses.test.ts \
  tests/verify-vulnerability-results.test.ts \
  tests/verify-processing-release-request.test.ts \
  tests/read-processing-release-request.test.ts \
  tests/create-processing-release-request.test.ts \
  tests/create-processing-release-report.test.ts \
  tests/verify-processing-release-report.test.ts \
  tests/verify-processing-candidate.test.ts \
  tests/create-processing-candidate.test.ts \
  tests/finalize-processing-candidate.test.ts \
  tests/read-processing-candidate.test.ts \
  tests/create-processing-evidence-bundle.test.ts \
  tests/verify-processing-evidence-bundle.test.ts \
  tests/reconcile-restored-processing-db.test.ts \
  tests/verify-queue-delivery-state.test.ts \
  tests/processing-release-chain.test.ts \
  tests/image-engine-workflow.test.ts \
  apps/api-worker/migrations/0002_rollout_control.sql \
  apps/api-worker/src/circuit-breaker.ts \
  apps/api-worker/src/circuit-breaker.test.ts \
  apps/api-worker/src/operational-alerts.ts \
  apps/api-worker/src/operational-alerts.test.ts \
  apps/api-worker/src/live-cost.ts \
  apps/api-worker/src/live-cost.test.ts \
  apps/api-worker/src/usage-analytics.ts \
  apps/api-worker/src/usage-analytics.test.ts \
  apps/api-worker/src/d1-job-repository.ts \
  apps/api-worker/src/d1-job-repository.test.ts \
  apps/api-worker/src/routes/jobs.ts \
  apps/api-worker/src/routes/jobs.test.ts \
  apps/api-worker/src/routes/uploads.ts \
  apps/api-worker/src/routes/uploads.test.ts \
  apps/api-worker/src/routes/results.ts \
  apps/api-worker/src/routes/results.test.ts \
  apps/api-worker/src/routes/policy.ts \
  apps/api-worker/src/routes/policy.test.ts \
  apps/api-worker/src/outbox.ts \
  apps/api-worker/src/outbox.test.ts \
  apps/api-worker/src/queue-consumer.ts \
  apps/api-worker/src/queue-consumer.test.ts \
  apps/api-worker/src/container-client.ts \
  apps/api-worker/src/container-client.test.ts \
  apps/api-worker/src/r2-artifacts.ts \
  apps/api-worker/src/r2-artifacts.test.ts \
  apps/api-worker/src/telemetry.ts \
  apps/api-worker/src/telemetry.test.ts \
  apps/api-worker/src/sweeper.ts \
  apps/api-worker/src/sweeper.test.ts \
  apps/api-worker/src/env.ts \
  apps/api-worker/src/index.ts \
  apps/api-worker/test/worker.integration.test.ts \
  apps/api-worker/wrangler.local.jsonc \
  apps/api-worker/src/worker-configuration.d.ts \
  .github/workflows/image-engine.yml \
  .github/workflows/ci.yml \
  docs/deployment/processing-release-request.schema.json \
  docs/deployment/processing-release-assets.schema.json \
  docs/deployment/processing-release-report.schema.json \
  docs/deployment/processing-candidate.schema.json \
  docs/deployment/processing-deployment.schema.json \
  docs/deployment/cloudflare-provider-usage.schema.json \
  docs/deployment/worker-version-attestations.schema.json \
  docs/deployment/processing-evidence.schema.json \
  docs/deployment/processing-evidence-ed25519-public.pem \
  docs/deployment.md \
  docs/architecture.md \
  docs/runbooks/image-processing.md \
  apps/web/public/THIRD_PARTY_NOTICES.txt \
  security/application-vulnerability-exceptions.json \
  security/application-license-policy.json \
  README.md \
  .gitignore
git commit -m "docs: operationalize image processing rollout"
~~~

## Final Acceptance Sequence

After all task commits:

1. Run `pnpm verify:all`.
2. From a clean checkout and exact validated staging/production API-origin inputs, build the linux/amd64
   engine OCI/Docker archives, no-bundle Worker module, distinct Pages trees, and deterministic Pages
   USTAR assets once; verify every archive/tree hash in the candidate before any deployment.
3. With pinned Syft 1.44.0, Trivy 0.72.0, Buildx 0.34.1, BuildKit 0.30.0, and one Trivy DB digest, verify
   engine/staging-Pages/production-Pages/Worker/lockfile SBOMs, license policies/notices, commercial
   review, prohibited-component absence, and exact vulnerability exceptions.
4. Run the public PR corpus locally.
5. Run the authorized full corpus and competitor baseline only on the trusted workstation, create the
   bounded signed evidence bundle, and verify its private-release acquisition path without uploading
   corpus or result bytes.
6. Run local duplicate/cancel/crash/OOM/storage/deletion chaos, including month-long object-deletion
   failure, tombstone recovery, upload/cancel races, and stale Queue generation after simulated D1
   restore, including future-generation collision blocked by the fresh random epoch.
7. Bind reviewed Korean privacy/terms hashes and counsel approval to the release; drafts or examples
   cannot enable server admission.
8. Deploy maintainer-only staging and run real exact-length Worker-upload/CORS/Queue/container/download/
   deletion smokes plus Safari iOS, Chrome Android, Samsung Internet, Kakao/Naver/Instagram in-app
   browser, constrained-memory ZIP, and desktop/mobile direct-download checks.
9. Run staging 12 MP performance, quality-stratum, and measured-cost gates; prove a complete 24-hour
   maintainer window using unsampled Trace Events CPU, identifier-free Analytics Engine counts, and
   Container billing-usage aggregates before public 5%.
10. Deploy production Worker and Pages with account, anonymous, and network weighted-unit limits `0` and
   rollout `0`; attest bootstrap/secret/final Worker versions and complete post-deploy telemetry
   verification before any maintainer job.
11. Prove config kill-switch, D1 circuit, immutable Worker rollback, stable-alias Pages rollback,
    deletion sweeps, alerting, and the rollout-zero → reconcile → maintainer-only Time Travel restore
    drill.
12. Record explicit account, anonymous, and network daily limits, account/network pending and queue
    ceilings, exact price model, maximum cost per 1,000 jobs, and projected monthly-cost ceiling within
    the billing alert.
13. Roll out maintainer-only, 5%, 25%, then 100% from immutable successful deployment records; verify the
    D1 circuit, config rollback, alerts, and reset-to-maintainer behavior before advancing.

The project is complete only when every release gate passes, production uses a non-zero reviewed budget,
the server path is the default cohort behavior, local fallback remains available, and the deletion audit
reports zero overdue input, result, tombstone, or orphan objects.
