# PDF Public Visual Admission Implementation Plan

> **Execution:** Follow this plan with `superpowers:test-driven-development` in an isolated worktree. Do not run local Playwright; browser steps run in GitHub Actions only.

**Goal:** Produce genuine, exact-SHA browser visual evidence for qpdf `image-optimized` output and admit anonymous PDF server processing only after the existing deletion, cost, rollback, and release-authority gates all pass.

**Architecture:** Reuse the generated PDF corpus, native benchmark, existing browser verifier Worker, hosted review receipts, and public-admission state. The benchmark may write a private transient source/result bundle only when explicitly requested by CI; Playwright verifies that bundle through the real product Worker in Chromium, Firefox, and WebKit, then a strict aggregator emits sanitized hashes and verdicts. Raw PDFs and renders are deleted and never uploaded. The existing exact-main signed `@2` authority remains mandatory, so absent genuine human/commercial hosted reports still blocks deployment.

**Stack:** Node 24, Vitest, Playwright in GitHub Actions, TypeScript, pdf-lib, existing sharp workspace dependency, qpdf container, GitHub Actions, Cloudflare deployment workflows.

---

## Task 1: Make one existing corpus stratum genuinely image-optimizable

**Files:**

- Modify: `scripts/create-pdf-compression-corpus.mjs`
- Modify: `tests/create-pdf-compression-corpus.test.ts`

### Step 1: Write the failing corpus tests

Add assertions for the existing `jpeg-heavy` stratum:

- its probe identifies a JPEG image with realistic dimensions rather than the current tiny image;
- generation is byte-for-byte deterministic across two runs;
- its bytes and total corpus remain inside the existing ceilings;
- a mutation of the embedded image dimensions or content changes the probe or fails closed.

Run:

```bash
pnpm exec vitest run tests/create-pdf-compression-corpus.test.ts
```

Expected: FAIL because `jpeg-heavy` still uses the 2x1 embedded fixture.

### Step 2: Implement the smallest deterministic fixture

Reuse the already-installed `sharp` from `apps/image-engine` through its package boundary to generate one deterministic, repository-owned JPEG in memory. Draw a fixed synthetic gradient/line pattern; do not add a dependency or store a binary fixture. Embed it in the existing `jpeg-heavy` PDF and retain all current probe and safety fields.

### Step 3: Verify GREEN

Run the focused test again and confirm every existing stratum still passes.

### Step 4: Commit

```bash
git add scripts/create-pdf-compression-corpus.mjs tests/create-pdf-compression-corpus.test.ts
git commit -m "test: add visual PDF benchmark fixture"
```

## Task 2: Export only transient native visual inputs

**Files:**

- Modify: `scripts/benchmark-pdf-engine.mjs`
- Modify: `tests/benchmark-pdf-engine.test.ts`
- Add: `docs/deployment/pdf-visual-input.schema.json`

### Step 1: Write RED tests for the private export contract

Add a strict manifest test requiring:

- schema/version, exact corpus hash, exact engine image digest, stratum and three ordered repeats;
- `profile: "image-optimized"`, source/result SHA-256, exact sizes, page count and relative safe basenames;
- no absolute paths, URLs, filenames from users, unknown keys, duplicate repeats or non-PDF envelopes;
- export failure unless all three native repeats selected `image-optimized` and passed semantic and Node visual checks.

Add a test that normal benchmark execution writes no raw files when the option is absent.

Run:

```bash
pnpm exec vitest run tests/benchmark-pdf-engine.test.ts
```

Expected: FAIL because no transient visual bundle contract exists.

### Step 2: Implement opt-in export

Extend `benchmarkPdfEngine` and its CLI with one optional `--visual-output` directory. Reuse the in-memory native outputs already produced by the benchmark. Write one generated source and the three passing native results with mode `0600`, plus a canonical strict manifest. Refuse overwrite and remove a partial directory on failure.

Do not add raw paths or hashes to the checked-in benchmark report beyond fields already allowed. Normal CI verification stays unchanged when the option is omitted.

### Step 3: Verify schema and cleanup behavior

Run:

```bash
pnpm exec vitest run tests/benchmark-pdf-engine.test.ts tests/create-pdf-compression-corpus.test.ts
node scripts/validate-pdf-benchmark-evidence.mjs \
  --report docs/deployment/pdf-engine-benchmark.json \
  --gate docs/deployment/pdf-engine-release-gate.json \
  --benchmark-schema docs/deployment/pdf-engine-benchmark.schema.json \
  --gate-schema docs/deployment/pdf-engine-release-gate.schema.json
```

### Step 4: Commit

```bash
git add scripts/benchmark-pdf-engine.mjs tests/benchmark-pdf-engine.test.ts docs/deployment/pdf-visual-input.schema.json
git commit -m "test: export bounded PDF visual inputs"
```

## Task 3: Verify real engine results with the existing browser Worker

**Files:**

- Add: `tests/e2e/pdf-compression-visual-evidence.spec.ts`
- Modify: `tests/e2e/pdf-compression.spec.ts` only if a small shared helper must be exported
- Add: `scripts/create-pdf-visual-browser-evidence.mjs`
- Add: `tests/create-pdf-visual-browser-evidence.test.ts`
- Add: `docs/deployment/pdf-browser-visual-evidence.schema.json`

### Step 1: Write RED unit tests for browser receipts

Define strict per-project receipts and one aggregate:

- exactly `chromium`, `firefox`, and `webkit`, once each;
- exact source manifest hash, engine digest, three ordered repeat result hashes;
- all repetitions verified by the real `hereisit-pdf-optimize-verifier` Worker;
- page/semantic/visual verdicts are fixed passed values;
- reject missing/duplicate projects, hash drift, unknown keys, absolute paths, URLs and private diagnostics.

Run:

```bash
pnpm exec vitest run tests/create-pdf-visual-browser-evidence.test.ts
```

Expected: FAIL because the aggregator does not exist.

### Step 2: Add the hosted-only Playwright case

Create a test that skips unless `HEREISIT_PDF_VISUAL_INPUT` points to Task 2's manifest. For each of its three result files:

- force only the local compression Worker to return structured no-reduction;
- use the existing intercepted server lifecycle but return the real native `image-optimized` result;
- do not replace the optimize verifier Worker;
- assert no download URL exists before verification, then assert the real Worker completes and exposes a PDF;
- write one sanitized project receipt after all three results pass.

The test must never include PDF bytes, rendered pixels, filenames, paths or request URLs in its receipt.

Do not run this Playwright test locally.

### Step 3: Implement the strict aggregator

Use existing canonical JSON, bounded file reads, exact-key and SHA helpers. Validate the input manifest and three project receipts, then emit one sanitized aggregate and validate it against the checked-in schema.

### Step 4: Run non-browser GREEN checks

```bash
pnpm exec vitest run tests/create-pdf-visual-browser-evidence.test.ts \
  packages/browser-runtime/src/pdf-optimize-verify.worker.test.ts \
  packages/browser-runtime/src/run-pdf-optimize-verification.test.ts
pnpm --filter @hereisit/browser-runtime typecheck
pnpm --filter @hereisit/web typecheck
```

### Step 5: Commit

```bash
git add tests/e2e/pdf-compression-visual-evidence.spec.ts tests/e2e/pdf-compression.spec.ts \
  scripts/create-pdf-visual-browser-evidence.mjs tests/create-pdf-visual-browser-evidence.test.ts \
  docs/deployment/pdf-browser-visual-evidence.schema.json
git commit -m "test: verify native PDF visuals in browsers"
```

## Task 4: Bind browser visual evidence into the existing release authority

**Files:**

- Modify: `scripts/create-processing-hosted-check.mjs`
- Modify: `scripts/prepare-processing-ci-evidence.mjs`
- Modify: `tests/create-processing-hosted-check.test.ts`
- Modify: `tests/prepare-processing-ci-evidence.test.ts`
- Modify: `tests/processing-pdf-release-workflows.test.ts`

### Step 1: Write RED binding tests

Extend only the existing `fullCorpusBenchmark` and `deviceMatrix` hosted documents:

- full corpus review binds benchmark hash, gate hash, engine digest and positive visual profile count;
- device matrix binds the browser visual aggregate hash and exact desktop project set;
- both bind exact git SHA, source archive SHA and check run ID as before;
- release evidence rejects an old report missing these fields or any cross-SHA/cross-engine receipt.

Keep competitor, blinded-human, commercial and privacy reviews unchanged and mandatory. Do not fabricate them.

Run:

```bash
pnpm exec vitest run tests/create-processing-hosted-check.test.ts \
  tests/prepare-processing-ci-evidence.test.ts \
  tests/processing-pdf-release-workflows.test.ts
```

Expected: FAIL because the hosted review schemas do not bind browser visual evidence.

### Step 2: Implement strict existing-schema extensions

Add only the required fixed fields to the two review validators. Reuse the aggregate validator from Task 3. Keep exact-source receipt creation and the signed `@2` release path unchanged.

### Step 3: Verify GREEN and fail-closed legacy behavior

Confirm missing genuine external reports still prevents authority creation; a passing visual artifact alone must not authorize deployment.

### Step 4: Commit

```bash
git add scripts/create-processing-hosted-check.mjs scripts/prepare-processing-ci-evidence.mjs \
  tests/create-processing-hosted-check.test.ts tests/prepare-processing-ci-evidence.test.ts \
  tests/processing-pdf-release-workflows.test.ts
git commit -m "ci: bind PDF browser quality evidence"
```

## Task 5: Run the quality gate on hosted browsers without retaining PDFs

**Files:**

- Modify: `.github/workflows/pdf-quality-benchmark.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/playwright-ci-workflow.test.ts`
- Modify: `tests/processing-pdf-release-workflows.test.ts`

### Step 1: Write RED workflow source-contract tests

Require the hosted flow to:

- build the exact pinned PDF engine and generate the transient visual bundle;
- install and run Chromium, Firefox and WebKit only in GitHub Actions;
- aggregate exact-project receipts before generating hosted review inputs;
- upload only benchmark/gate/browser sanitized JSON;
- delete the corpus, transient source/results, Playwright output and engine container on success, failure and cancellation;
- keep the release-authority job dependent on genuine exact-main receipts and fail closed if the four external hosted reports are absent.

Run:

```bash
pnpm exec vitest run tests/playwright-ci-workflow.test.ts tests/processing-pdf-release-workflows.test.ts
```

Expected: FAIL because the quality workflow does not run browser verification.

### Step 2: Extend the existing workflow

Add the Task 2 export, Task 3 desktop browser test and aggregate step to `pdf-quality-benchmark.yml`. Keep the manual trigger for diagnosis and add a reusable exact-SHA path consumed by main CI only if it can reuse the existing artifact identity without weakening source binding. Prefer calling existing scripts over YAML duplication.

Wire the sanitized full-corpus and device-matrix documents into `.artifacts/hosted-reports`. Do not synthesize competitor, human, commercial or privacy approvals; release authority remains fail closed until their protected producers supply exact-source documents.

### Step 3: Verify workflow contracts

Run the source-contract tests, `pnpm lint`, and `git diff --check`. Do not run Playwright locally.

### Step 4: Commit

```bash
git add .github/workflows/pdf-quality-benchmark.yml .github/workflows/ci.yml \
  tests/playwright-ci-workflow.test.ts tests/processing-pdf-release-workflows.test.ts
git commit -m "ci: collect PDF visual admission evidence"
```

## Task 6: Regenerate canonical structural evidence and document the honest state

**Files:**

- Modify: `docs/deployment/pdf-engine-benchmark.json`
- Modify: `docs/deployment/pdf-engine-release-gate.json`
- Modify: `docs/deployment.md`
- Modify: `docs/deployment/processing.md`

### Step 1: Build and run the bounded real benchmark

Build the exact PDF engine image, generate the corpus, run all three repeats and validate both schemas. Require `jpeg-heavy` to be `image-optimized` in all three native samples with semantic/Node visual pass and nonzero resource measurements.

This local non-browser run may update canonical evidence, but it does not count as Chromium/Firefox/WebKit evidence and cannot by itself authorize public admission.

### Step 2: Update truthful documentation

Record the new canonical hashes and measured counts. State separately:

- structural/native benchmark result;
- hosted browser visual result, if CI has produced it;
- remaining genuine hosted reviews;
- whether public admission is currently enabled.

Never set `publicAdmissionReady` true in checked-in evidence unless its current derivation and actual measurement support it.

### Step 3: Verify and commit

```bash
node scripts/validate-pdf-benchmark-evidence.mjs \
  --report docs/deployment/pdf-engine-benchmark.json \
  --gate docs/deployment/pdf-engine-release-gate.json \
  --benchmark-schema docs/deployment/pdf-engine-benchmark.schema.json \
  --gate-schema docs/deployment/pdf-engine-release-gate.schema.json
pnpm exec vitest run tests/create-pdf-compression-corpus.test.ts tests/benchmark-pdf-engine.test.ts
git add docs/deployment.md docs/deployment/processing.md docs/deployment/pdf-engine-benchmark.json \
  docs/deployment/pdf-engine-release-gate.json
git commit -m "docs: record PDF visual admission evidence"
```

## Task 7: Full verification, review, and hosted release

### Step 1: Run fresh local gates

```bash
pnpm verify
git diff --check origin/main...HEAD
git status --short
```

Confirm no generated corpus, PDF, rendered image, Playwright output, stopped container/network or temporary image remains except an explicitly retained exact benchmark image needed for reproducibility.

### Step 2: Review the exact branch

Review for trust-boundary validation, raw-file leakage, stale/cross-SHA evidence, false-positive workflow source tests, cancellation cleanup, image/PDF isolation, and unnecessary abstractions. Fix findings with RED→GREEN tests and rerun `pnpm verify`.

### Step 3: Push and open the PR

Push only after the branch is clean and locally green. Wait for protected verify, full browser matrix and Pages preview. Do not merge on red or pending checks.

### Step 4: Evaluate hosted visual evidence

On exact main SHA, require:

- qpdf image-optimized selection 3/3;
- Chromium, Firefox and WebKit real Worker verification 3/3 each;
- only sanitized artifacts uploaded;
- exact hashes match release input.

If this fails, stop with PDF public admission disabled.

### Step 5: Promote only with complete genuine authority

If all six genuine hosted reports and the signed `@2` authority exist, run staging, administrator PDF canary, deletion, cost-at-$5-cap and rollback gates, then the protected admission workflow and anonymous production smoke. Otherwise stop safely and record the missing external evidence; do not create placeholder approvals.

### Step 6: Close out

Verify live policy and cleanup only if promotion occurred. Remove the remote feature branch, disposable worktree and transient artifacts after completion, preserving only canonical sanitized evidence and reports required for audit.
