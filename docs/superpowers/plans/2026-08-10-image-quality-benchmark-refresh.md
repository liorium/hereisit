# Image Quality Benchmark Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-measure the current production image engine, publish its real successful-job resource measurements, and make the reduced quality gate enforce the existing processing-time and memory limits.

**Architecture:** Reuse the existing owned corpus, native engine image, metric binaries, manual GitHub workflow, and release thresholds. Establish an exact-SHA baseline first, add only deterministic PR checks that the current report can prove, then rerun the benchmark on the final merged SHA; codec behavior changes only if the measurements expose a reproducible failure.

**Tech Stack:** Node.js 24, pnpm 11, Vitest, Docker Buildx, mozjpeg, libwebp, libvips, oxipng, SSIMULACRA2, Butteraugli, GitHub Actions, Cloudflare Pages.

## Global Constraints

- Follow `AGENTS.md`: do not log file contents, filenames, thumbnails, or presigned URLs.
- Use only the existing HereIsIt-owned or CC0 corpus committed under `tests/image-corpus`; do not scrape competitors or download a new corpus.
- Add no dependency, codec, UI, product feature, rollout change, or new configuration file.
- Keep the current `pr` benchmark at the existing maximum of 20 images and the `smart/balanced` variant.
- Reuse the release limits verbatim: JPEG/WebP p95 at most 3,000 ms, PNG p95 at most 8,000 ms, and ordinary peak memory at most 512 MiB.
- Do not invent human-review or authorized-competitor data and do not weaken the full release evaluator.
- Do not tune encoder settings unless a current-head benchmark reproduces a failed existing limit.
- A successful engine job must contain a positive measured peak memory value; a missing resource observation fails closed instead of publishing zero as a real measurement.
- Retain benchmark artifacts only while this task is active. Remove task worktrees, containers, images, downloaded reports, and task-only Docker cache after final verification.

## File Map

- `scripts/verify-image-quality.mjs` — validate reduced benchmark measurements and enforce the existing p95 time and peak-memory limits.
- `tests/image-quality-gates.test.ts` — prove passing boundaries, independent failures, invalid measurements, and unsuccessful-sample exclusion.
- `apps/image-engine/src/job/runner-supervisor.ts` — immediately sample resources and merge accepted Linux observations into terminal job measurements.
- `apps/image-engine/src/job/runner-supervisor.test.ts` — prove immediate sampling, successful measurement publication, and fail-closed missing observations.
- `apps/image-engine/src/server.ts` — retain the latest valid observation and finalize the runner terminal status with it.
- `.github/workflows/image-quality-benchmark.yml` — build and benchmark the exact selected Git revision without the removed Buildx `install` input.
- `.github/workflows/processing-staging.yml` — remove the same ignored Buildx input from the engine deployment path.
- `tests/image-corpus/manifest.json` and `tests/image-corpus/public/**` — reused without modification as the licensed deterministic input set.
- `.artifacts/image-benchmark-pr.json` — ephemeral GitHub artifact, downloaded under `/tmp` for inspection and never committed.

---

### Task 1: Capture the current-main benchmark baseline

**Files:**
- Reuse: `.github/workflows/image-quality-benchmark.yml`
- Inspect: `/tmp/hereisit-image-quality-baseline-<run-id>/image-benchmark-pr.json`

**Interfaces:**
- Consumes: exact `origin/main` SHA and workflow `image-quality-benchmark.yml`.
- Produces: a passing exact-SHA report with `records[].processingMs`, `records[].peakMemoryBytes`, output-size, quality, and cost measurements.

- [ ] **Step 1: Record the immutable baseline revision**

Run:

```bash
git fetch origin main
BASE_SHA="$(git rev-parse origin/main)"
test "$BASE_SHA" = "$(git -C /home/ubuntu/workspace/projects/hereisit rev-parse HEAD)"
printf '%s\n' "$BASE_SHA"
```

Expected: the clean primary checkout and `origin/main` print the same 40-character SHA.

- [ ] **Step 2: Dispatch the existing benchmark on main**

Run:

```bash
gh workflow run image-quality-benchmark.yml --repo liorium/hereisit --ref main
```

Capture the newest workflow-dispatch run whose `headSha` equals `$BASE_SHA`; do not reuse an older run.

- [ ] **Step 3: Wait for the benchmark and download its report**

Run:

```bash
gh run watch "$RUN_ID" --repo liorium/hereisit --exit-status
mkdir -p "/tmp/hereisit-image-quality-baseline-$RUN_ID"
gh run download "$RUN_ID" --repo liorium/hereisit \
  --dir "/tmp/hereisit-image-quality-baseline-$RUN_ID"
```

Expected: workflow conclusion `success`; the artifact contains `image-benchmark-pr.json` and `live-cost-model-pr.json`.

- [ ] **Step 4: Verify identity and summarize measured limits**

Run the repository verifier against the downloaded report, then use a read-only Node command to print per-format successful sample count, p95 processing time, maximum memory, median effective-output ratio, SSIMULACRA2/Butteraugli ranges, and total estimated cost.

```bash
node scripts/verify-image-quality.mjs \
  --report "/tmp/hereisit-image-quality-baseline-$RUN_ID/image-benchmark-pr.json" \
  --scope pr
node --input-type=module - \
  "/tmp/hereisit-image-quality-baseline-$RUN_ID/image-benchmark-pr.json" <<'NODE'
import { readFile } from "node:fs/promises";
const report = JSON.parse(await readFile(process.argv[2], "utf8"));
const p95 = (values) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const range = (values) =>
  values.length === 0 ? null : [Math.min(...values), Math.max(...values)];
for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
  const records = report.records.filter(
    (record) => record.inputMime === mime && record.outcome !== "rejected",
  );
  const ratios = records
    .map((record) => record.effectiveDeliveredBytes / record.inputBytes)
    .toSorted((a, b) => a - b);
  const scores = (key) => records.map((record) => record[key]).filter(Number.isFinite);
  console.log({
    mime,
    samples: records.length,
    processingP95Ms: p95(records.map((record) => record.processingMs)),
    peakMemoryBytes: Math.max(...records.map((record) => record.peakMemoryBytes)),
    medianOutputRatio: ratios[Math.floor(ratios.length / 2)],
    ssimulacra2Range: range(scores("ssimulacra2")),
    butteraugliRange: range(scores("butteraugli")),
  });
}
console.log({ totalCostUsd: report.summary.totalCostUsd, identity: report.identity });
NODE
```

Expected: `passed: true`; engine image digest is `sha256:<64 hex>` and source-lock, corpus, and live-cost-model hashes are each 64 lowercase hex characters. Stop before code changes if the existing gate or any approved limit fails; reproduce the failing record and fix only that root cause.

### Task 2: Publish successful-job CPU and memory observations

**Files:**
- Modify: `apps/image-engine/src/job/runner-supervisor.ts`
- Modify: `apps/image-engine/src/job/runner-supervisor.test.ts`
- Modify: `apps/image-engine/src/server.ts`

**Interfaces:**
- Consumes: runner terminal `EngineJobStatus` and the latest accepted `LinuxResourceObservation`.
- Produces: `finalizeRunnerStatus(request, status, observation)` with observed CPU, memory-time, peak memory, and elapsed time while preserving processed bytes, pixels, candidates, result, and inspection.

- [ ] **Step 1: Add focused failing supervisor tests**

Add one test proving `startResourceSupervisor()` calls its sampler immediately without waiting for the first 250ms interval. Add table-driven tests for a wished-for `finalizeRunnerStatus()`:

```ts
expect(
  finalizeRunnerStatus(request, succeededStatus, observation(null)),
).toMatchObject({
  state: "succeeded",
  measurements: {
    processedInputBytes: 3,
    processedPixels: 4_096,
    testedCandidates: 2,
    cpuMs: 4,
    memoryByteMilliseconds: 5_000,
    peakMemoryBytes: 20,
    processingMs: 250,
  },
});

expect(finalizeRunnerStatus(request, succeededStatus, null)).toMatchObject({
  state: "failed",
  sequence: succeededStatus.sequence + 1,
  error: { code: "ENGINE_CRASH", retryable: false },
});
```

The first test must fail if observed values are not merged; the second must fail if an unmeasured success can escape as zero-valued telemetry.

- [ ] **Step 2: Run focused tests and record RED**

Run:

```bash
pnpm exec vitest run apps/image-engine/src/job/runner-supervisor.test.ts
```

Expected: immediate-sampling and finalization tests fail because the current supervisor waits 250ms and no finalizer exists.

- [ ] **Step 3: Implement the minimum finalization path**

Call the supervisor's existing `tick()` once immediately after registering its interval. Add `finalizeRunnerStatus()` beside `resourceFailureStatus()`:

- `null` or a non-null `observation.exceeded` returns `resourceFailureStatus()` after the runner's terminal sequence;
- a valid observation preserves runner-owned counts and result fields;
- it replaces only `cpuMs`, `memoryByteMilliseconds`, and `peakMemoryBytes` with rounded observed values;
- `processingMs` becomes the larger of runner processing time and observed elapsed time.

In `server.ts`, retain only the latest observation whose `exceeded` value is `null`, including a sample that began before the runner emitted its terminal line. Pass the terminal status through `finalizeRunnerStatus()` before resolving completion. Do not add logs.

- [ ] **Step 4: Run focused GREEN and engine checks**

Run:

```bash
pnpm exec vitest run \
  apps/image-engine/src/job/runner-supervisor.test.ts \
  apps/image-engine/src/job/resource-monitor.test.ts \
  apps/image-engine/src/job/job-controller.test.ts
pnpm --filter @hereisit/image-engine typecheck
pnpm lint
git diff --check
```

Expected: all checks pass; mutation of the merge back to zero fails the finalization test and removal of immediate `tick()` fails the immediate-sampling test.

- [ ] **Step 5: Commit the engine measurement fix**

```bash
git add apps/image-engine/src/job/runner-supervisor.ts \
  apps/image-engine/src/job/runner-supervisor.test.ts apps/image-engine/src/server.ts
git commit -m "fix: publish image engine resource measurements"
```

### Task 3: Enforce existing time and memory limits in the reduced gate

**Files:**
- Modify: `scripts/verify-image-quality.mjs`
- Modify: `tests/image-quality-gates.test.ts`

**Interfaces:**
- Consumes: benchmark records with `inputMime`, `outcome`, `processingMs`, and `peakMemoryBytes`.
- Produces: `evaluatePrImageQualityReport(report): { passed: boolean; failures: string[] }` with additional deterministic codes `PR_INVALID_MEASUREMENT`, `PR_WARM_JPEG_WEBP_P95`, `PR_STANDARD_PNG_P95`, and `PR_PEAK_MEMORY`.

- [ ] **Step 1: Add focused failing PR-gate tests**

Import `evaluatePrImageQualityReport` and define one 12-record report fixture: four JPEG, four PNG, and four WebP `original-retained` records with valid identity hashes, `processingMs: 100`, `peakMemoryBytes: 1024`, and matching `effectiveDeliveredBytes`.

Add independent assertions:

```ts
const prRecord = (inputMime: string, corpusId: string) => ({
  corpusId,
  inputMime,
  outcome: "original-retained",
  inputBytes: 100,
  outputBytes: null,
  effectiveDeliveredBytes: 100,
  alphaChecksPassed: true,
  processingMs: 100,
  peakMemoryBytes: 1024,
});

const prReport = () => ({
  scope: "pr",
  identity: {
    engineImageDigest: `sha256:${"a".repeat(64)}`,
    sourceLockSha256: "b".repeat(64),
    corpusManifestSha256: "c".repeat(64),
    liveCostModelSha256: "d".repeat(64),
  },
  records: ["image/jpeg", "image/png", "image/webp"].flatMap((inputMime, mimeIndex) =>
    Array.from({ length: 4 }, (_, index) => prRecord(inputMime, `${mimeIndex}-${index}`)),
  ),
});

const failuresFor = (overrides: Partial<ReturnType<typeof prRecord>>) => {
  const report = prReport();
  report.records[0] = { ...report.records[0], ...overrides };
  return evaluatePrImageQualityReport(report).failures;
};

expect(evaluatePrImageQualityReport(prReport()).passed).toBe(true);
expect(failuresFor({ inputMime: "image/jpeg", processingMs: 3001 })).toContain(
  "PR_WARM_JPEG_WEBP_P95",
);
expect(failuresFor({ inputMime: "image/png", processingMs: 8001 })).toContain(
  "PR_STANDARD_PNG_P95",
);
expect(failuresFor({ peakMemoryBytes: 512 * 1024 * 1024 + 1 })).toContain("PR_PEAK_MEMORY");
expect(failuresFor({ processingMs: Number.NaN })).toContain("PR_INVALID_MEASUREMENT");
```

Also prove rejected records do not make performance p95 appear faster and boundary values 3,000 ms, 8,000 ms, and 512 MiB pass.

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
pnpm exec vitest run tests/image-quality-gates.test.ts
```

Expected: only the new PR time/memory assertions fail because the current evaluator ignores those measurements.

- [ ] **Step 3: Implement the smallest deterministic checks**

In `scripts/verify-image-quality.mjs`, define the three existing limits once and reuse them in the release and PR evaluators. Add a local nearest-rank p95 helper:

```js
function percentile95(values) {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}
```

For non-rejected records, require finite non-negative `processingMs` and `peakMemoryBytes`. Calculate JPEG/WebP p95 together, PNG p95 separately, and maximum peak memory. Append exactly the four failure codes defined above. Keep SSIMULACRA2, Butteraugli, cost, human review, and competitor comparisons report-only because this reduced report has no approved absolute threshold or human/competitor evidence.

- [ ] **Step 4: Run focused GREEN and static checks**

Run:

```bash
pnpm exec vitest run tests/image-quality-gates.test.ts
pnpm lint
pnpm typecheck
git diff --check
```

Expected: all commands pass and only the verifier plus its test changed after the design/plan commits.

- [ ] **Step 5: Review and commit the gate**

Review all callers of `evaluatePrImageQualityReport`, confirm no report field or filename is logged, and commit:

```bash
git add scripts/verify-image-quality.mjs tests/image-quality-gates.test.ts
git commit -m "test: enforce image benchmark resource limits"
```

### Task 4: Verify the branch and benchmark the changed gate

**Files:**
- Verify: all committed Task 2 files
- Reuse: `.github/workflows/ci.yml`, `.github/workflows/image-quality-benchmark.yml`

**Interfaces:**
- Consumes: committed reduced-gate implementation.
- Produces: green repository verification, protected PR CI, Pages preview, and an exact branch-head quality report.

- [ ] **Step 1: Run the complete local non-browser gate**

Run:

```bash
pnpm verify
```

Expected: audit, lint, 11 package typechecks, all Vitest suites, Worker integration, image-engine fuzz, builds, and static export checks pass.

- [ ] **Step 2: Push the isolated branch and dispatch its benchmark**

Before pushing, delete the obsolete `install: true` input from the pinned `docker/setup-buildx-action` steps in both `.github/workflows/image-quality-benchmark.yml` and `.github/workflows/processing-staging.yml`. The pinned v4 action declares no `install` input and defaults `use: true`, so this deletion preserves the selected builder while removing the warning. Commit the two-line deletion as `ci: remove obsolete Buildx inputs`.

If the exact branch run reports GitHub's Node 20 deprecation for the pinned artifact uploader, resolve the current official `actions/upload-artifact` release to its immutable commit and verify its declared inputs before replacing the four existing workflow pins together. The confirmed v7.0.1 commit is `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`; it uses Node 24 and retains `name`, `path`, `if-no-files-found`, `retention-days`, and `include-hidden-files`.

Run:

```bash
git push -u origin perf/image-quality-benchmark-refresh
BRANCH_SHA="$(git rev-parse HEAD)"
gh workflow run image-quality-benchmark.yml --repo liorium/hereisit \
  --ref perf/image-quality-benchmark-refresh
```

Capture only the new run whose `headSha` equals `$BRANCH_SHA`, wait with `--exit-status`, download its artifact under `/tmp`, and rerun `verify-image-quality.mjs --scope pr` locally. Expected: all original gates plus the new time/memory gates pass.

- [ ] **Step 3: Open the PR and wait for protected checks**

Create a PR containing the design, plan, tests, and minimal verifier change. Wait for `verify`, the protected six-project Playwright matrix with analytics, and Cloudflare Pages preview. Do not merge while any required check is pending or failed.

- [ ] **Step 4: Fix only branch-caused failures**

For a failure, inspect the first failing boundary, reproduce it with the smallest focused test, record RED, fix the shared root cause, rerun focused checks plus `pnpm verify`, push once, and rewatch. Do not change codec settings to silence a verifier failure.

### Task 5: Merge, prove the final SHA, and clean up

**Files:**
- No additional product files expected.
- Remove: `/tmp/hereisit-image-quality-baseline-*`, `/tmp/hereisit-image-quality-final-*`, and the task worktree after verification.

**Interfaces:**
- Consumes: approved green PR.
- Produces: merged `main`, final exact-SHA benchmark evidence, clean primary checkout, and no retained task resources.

- [ ] **Step 1: Merge and synchronize main**

Merge using the repository's allowed method after all required checks pass. Record the merge SHA, fast-forward the primary checkout non-destructively, and verify:

```bash
test "$(git -C /home/ubuntu/workspace/projects/hereisit rev-parse HEAD)" = \
  "$(git -C /home/ubuntu/workspace/projects/hereisit rev-parse origin/main)"
```

- [ ] **Step 2: Verify main CI and final exact-SHA benchmark**

Wait for main `verify` and Pages production deployment. Dispatch `image-quality-benchmark.yml` on `main`, require its `headSha` to equal the recorded merge SHA, wait for success, download the report, and run the changed verifier locally. Record per-format p95, maximum memory, output ratios, quality metrics, and estimated cost.

The engine measurement path changed, so require the existing processing-staging deployment and authenticated smoke before completion.

- [ ] **Step 3: Final scope and cleanliness audit**

Confirm the final diff contains only the approved docs, verifier, engine measurement path, workflows, and tests; primary `main` equals `origin/main`; no unrelated worktree changed; no task container is running; and no task artifact is staged or committed.

- [ ] **Step 4: Remove task resources**

Remove the feature worktree and local branch after merge, delete downloaded benchmark directories, remove task-created engine/metric Docker images and stopped containers, and prune only build cache created for this task. Verify free space and `git worktree list` afterward.
