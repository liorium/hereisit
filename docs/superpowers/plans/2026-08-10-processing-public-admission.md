# Image Processing Public Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the exact successful production image-compression canary from zero to 100 percent public server admission, retain the five-dollar projected monthly cost ceiling, and provide fail-closed automatic and operator recovery to local processing.

**Architecture:** Keep the existing staging and production canary workflows unchanged at rollout zero. Add one protected production-admission workflow that reuses the exact canary SHA, immutable engine digest, generated Worker, cost model, limits, D1 attestation path, and browser smoke; its only allowed promotion config difference is rollout `0` to `100`. Use the existing D1 circuit breaker for immediate effective-zero disable, and independently restore the prior attested rollout-zero Worker version during a failed promotion.

**Tech Stack:** Node.js 24, TypeScript 6, Vitest 4, pnpm 11, GitHub Actions, Wrangler 4, Cloudflare Workers/Containers/D1/R2/Queues/Analytics Engine, Playwright 1.62.

## Global Constraints

- Public image-compression server rollout has exactly two states: `0` and `100`; no arbitrary percentage input.
- `MAX_PROJECTED_MONTHLY_COST_MICROUSD` remains exactly `5000000` (USD 5).
- `MAX_LIVE_COST_PER_1000_MICROUSD` remains exactly `500000` (USD 0.50).
- Preserve the current production weighted-unit limits, pending limits `10`/`3`, maximum queued age `600`, and all rate-limit namespace IDs.
- Preserve local fallback whenever policy, quota, circuit, Queue, D1, or server processing is unavailable.
- A file leaves the browser only after the existing server-upload disclosure is visible.
- Never log or retain file contents, filenames, thumbnails, presigned URLs, credentials, or unbounded provider responses.
- Do not add a dependency, codec, UI screen, public API, authentication, billing, or PDF server processing.
- Use the protected `processing-production` GitHub environment and the same non-cancelling production concurrency group for deploy, promotion, and disable operations.
- Run the full Playwright browser matrix, including WebKit, only in the existing hosted GitHub Actions path.
- Remove temporary outputs, Docker resources, and the task branch/worktree after verified production completion unless a concrete audit artifact is still required.

---

### Task 1: Verify and persist a one-version admission transition

**Files:**
- Modify: `scripts/verify-worker-version-chain.mjs`
- Modify: `scripts/apply-worker-version-attestations.mjs`
- Modify: `tests/verify-worker-version-chain.test.ts`
- Modify: `tests/apply-worker-version-attestations.test.ts`
- Modify: `tests/apply-worker-version-attestations-cli.test.ts`

**Interfaces:**
- Consumes: existing strict Worker version snapshots, Wrangler deployment output, rollout-zero canary attestation, exact Worker module bytes, generated current/next Wrangler JSON, and source report bytes.
- Produces: `verifyWorkerAdmissionTransition(input): WorkerAdmissionTransition`, `createWorkerAdmissionAttestationBatch(attestation): D1Batch`, and CLI mode `finalize-admission` in `verify-worker-version-chain.mjs`.
- Produces schema: `hereisit-worker-admission-transition@1` with exact keys `version`, `verifiedAt`, `fromVersionId`, `activeVersionId`, `fromPublicAdmissionPercent`, `publicAdmissionPercent`, `workerModuleSha256`, `previousConfigSha256`, `generatedConfigSha256`, `releaseReportSha256`, and `versions`.

- [ ] **Step 1: Write failing transition-verifier tests**

Add fixtures for a current rollout-zero config and a next rollout-100 config whose only semantic difference is `vars.IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT`:

```ts
const currentConfig = processingConfig("0");
const publicConfig = processingConfig("100");

expect(
  verifyWorkerAdmissionTransition({
    before: [versions.canary],
    after: [versions.canary, versions.public],
    deployment: { version_id: ids.public },
    currentAttestation: rolloutZeroAttestation(),
    workerModule,
    currentConfig,
    nextConfig: publicConfig,
    releaseReport,
    fromPublicAdmissionPercent: 0,
    publicAdmissionPercent: 100,
    verifiedAt: "2026-08-10T00:00:00.000Z",
  }),
).toMatchObject({
  schema: "hereisit-worker-admission-transition@1",
  fromVersionId: ids.canary,
  activeVersionId: ids.public,
  fromPublicAdmissionPercent: 0,
  publicAdmissionPercent: 100,
  versions: [{ versionId: ids.public, state: "active", publicAdmissionPercent: 100 }],
});
```

Add table cases that reject `0 → 5`, `100 → 100`, an extra Worker version, a non-Wrangler trigger, a deployment/version mismatch, a changed module/release hash, a current-config hash not present in the canary attestation, and any non-rollout config change including limits, engine digest, origin, bindings, or maintainer hashes.

- [ ] **Step 2: Run the focused tests and record RED**

Run:

```bash
pnpm exec vitest run tests/verify-worker-version-chain.test.ts
```

Expected: FAIL because `verifyWorkerAdmissionTransition` and admission schema support do not exist.

- [ ] **Step 3: Implement the strict config and version transition**

Add one narrow helper that parses both configs, requires the exact requested rollout values, replaces only the rollout value with a sentinel, and compares the remaining canonical JSON:

```js
function verifyAdmissionConfigPair(currentText, nextText, fromPercent, toPercent) {
  const current = parseGeneratedConfig(currentText, "current");
  const next = parseGeneratedConfig(nextText, "next");
  const key = "IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT";
  if (current.vars[key] !== String(fromPercent) || next.vars[key] !== String(toPercent)) {
    throw new RangeError("Worker admission rollout transition does not match");
  }
  current.vars[key] = "<rollout>";
  next.vars[key] = "<rollout>";
  if (sha256Canonical(current) !== sha256Canonical(next)) {
    throw new Error("Worker admission config changed outside rollout");
  }
}
```

`verifyWorkerAdmissionTransition` must accept only `0 → 100`, verify one new upload transition with `verifyTransition`, bind the exact deployment version, compare the current module/config/release hashes to the existing canary attestation, and return only bounded identifiers and hashes.

- [ ] **Step 4: Write failing D1-batch and CLI tests**

Assert the admission batch retires exactly the former active version and upserts exactly the new active version:

```ts
expect(createWorkerAdmissionAttestationBatch(attestation).statements).toEqual([
  expect.objectContaining({ params: ["retired", expect.any(Number), ids.canary] }),
  expect.objectContaining({
    params: [
      ids.public,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "active",
      1,
      expect.any(Number),
      null,
    ],
  }),
]);
```

Add a CLI test that passes exact bounded files to `--mode finalize-admission`, refuses overwrite, rejects unknown/reordered arguments, and writes a mode-0600 canonical JSON file. Add apply-CLI tests for both the existing six-version schema and the new one-version admission schema.

- [ ] **Step 5: Run the expanded focused tests and record RED**

Run:

```bash
pnpm exec vitest run \
  tests/verify-worker-version-chain.test.ts \
  tests/apply-worker-version-attestations.test.ts \
  tests/apply-worker-version-attestations-cli.test.ts
```

Expected: FAIL on the missing admission batch and CLI dispatch.

- [ ] **Step 6: Implement the admission D1 batch and CLI dispatch**

Keep `createWorkerVersionAttestationBatch()` unchanged for canary deploys. Add `createWorkerAdmissionAttestationBatch()` for exactly one transition version, then dispatch by the strict schema in the existing apply CLI:

```js
const batch =
  attestation?.schema === "hereisit-worker-admission-transition@1"
    ? createWorkerAdmissionAttestationBatch(attestation)
    : createWorkerVersionAttestationBatch(attestation);
```

Both schemas must pass through the existing bounded file reader, allowlisted SQL validator, primary-D1 write, and exact post-write verification. The new batch may contain only the existing retirement update and existing attestation upsert SQL forms.

- [ ] **Step 7: Verify Task 1 and commit**

Run:

```bash
pnpm exec vitest run \
  tests/verify-worker-version-chain.test.ts \
  tests/apply-worker-version-attestations.test.ts \
  tests/apply-worker-version-attestations-cli.test.ts
pnpm lint
pnpm typecheck
git diff --check
git add scripts/verify-worker-version-chain.mjs \
  scripts/apply-worker-version-attestations.mjs \
  tests/verify-worker-version-chain.test.ts \
  tests/apply-worker-version-attestations.test.ts \
  tests/apply-worker-version-attestations-cli.test.ts
git commit -m "feat: attest processing admission transitions"
```

Expected: all checks PASS; the commit contains only the five listed files.

---

### Task 2: Gate promotion on current primary D1 operational state

**Files:**
- Create: `scripts/verify-processing-admission-state.mjs`
- Create: `tests/verify-processing-admission-state.test.ts`

**Interfaces:**
- Consumes: Cloudflare account ID, production D1 database ID, `CLOUDFLARE_D1_API_TOKEN`, expected active Worker version ID, and expected cost-accounting release SHA-256.
- Produces: `verifyProcessingAdmissionState({ rows, expectedVersionId, expectedReleaseReportSha256 }): { ready: true; activeVersionId: string; costAccountingEpoch: string }`, `readProcessingAdmissionStateFromD1(input)`, and guarded `disableProcessingAdmissionInD1(input)`.

- [ ] **Step 1: Write failing pure-state tests**

Use an exact one-row fixture:

```ts
const ready = {
  circuitOpen: 0,
  circuitReason: null,
  deletionOverdueCount: 0,
  activeJobs: 0,
  unsentOutbox: 0,
  activeAttestationCount: 1,
  activeVersionId,
  publicAdmissionAllowed: 1,
  costAccountingEpoch: "release-epoch",
  releaseReportSha256,
};

expect(
  verifyProcessingAdmissionState({
    rows: [ready],
    expectedVersionId: activeVersionId,
    expectedReleaseReportSha256: releaseReportSha256,
  }),
).toEqual({ ready: true, activeVersionId, costAccountingEpoch: "release-epoch" });
```

Reject an open circuit, any deletion overdue count, active `created/uploaded/queued/running` job, unsent outbox row, zero or multiple active attestations, wrong active version, inadmissible active version, `uninitialized` epoch, wrong release hash, missing row, extra key, unsafe integer, or non-primary D1 response.

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
pnpm exec vitest run tests/verify-processing-admission-state.test.ts
```

Expected: FAIL because the verifier module does not exist.

- [ ] **Step 3: Implement the pure verifier and primary-D1 reader**

Reuse `postD1Query()` and its 30-second timeout, bounded response, exact envelope, and `served_by_primary` requirement. Use one constant parameter-free SELECT that returns only aggregate counts and the active attestation:

```sql
SELECT
  control.circuit_open AS circuitOpen,
  control.reason AS circuitReason,
  control.deletion_overdue_count AS deletionOverdueCount,
  (SELECT COUNT(*) FROM jobs WHERE status IN ('created','uploaded','queued','running')) AS activeJobs,
  (SELECT COUNT(*) FROM job_outbox WHERE sent_at IS NULL) AS unsentOutbox,
  (SELECT COUNT(*) FROM worker_version_attestations WHERE kind = 'active') AS activeAttestationCount,
  active.version_id AS activeVersionId,
  active.public_admission_allowed AS publicAdmissionAllowed,
  control.cost_accounting_epoch AS costAccountingEpoch,
  active.release_report_sha256 AS releaseReportSha256
FROM rollout_control AS control
LEFT JOIN worker_version_attestations AS active ON active.kind = 'active'
WHERE control.id = 1
```

Do not require a completed historical live-cost window before the first public job; the signed cost model and exact five-dollar ceiling are the pre-admission gate, while the existing hourly sealer opens the circuit after live observations exist.

- [ ] **Step 4: Add the guarded existing-circuit disable**

Reuse `postD1Query()` to issue one parameterized primary-D1 update. Preserve an existing circuit reason and set a
bounded operator reason only when the circuit was closed:

```sql
UPDATE rollout_control
SET circuit_open = 1,
    reason = CASE WHEN circuit_open = 1 THEN reason ELSE 'OPERATOR_DISABLED' END,
    opened_at = CASE WHEN circuit_open = 1 THEN opened_at ELSE ? END,
    last_evaluated_at = ?
WHERE id = 1
```

Immediately re-read the strict state row and require `circuitOpen = 1`. Tests prove that the query is parameterized,
served by primary D1, idempotent for an already-open circuit, never resets a reason, and never prints response bodies
or credentials.

- [ ] **Step 5: Add and verify the strict CLI**

The CLI accepts only:

```text
--account-id <32 hex>
--database-id <uuid>
--expected-version-id <uuid>
--expected-release-report-sha256 <64 hex>
```

Add exact `--mode verify` and `--mode disable` forms. Both read the D1 token only from
`CLOUDFLARE_D1_API_TOKEN`, print one canonical sanitized JSON object, and collapse network/provider failures without
printing the token or response body. Disable additionally requires a canonical `--now` timestamp supplied by the
workflow and prints only `{ disabled: true, circuitOpen: true }`.

- [ ] **Step 6: Verify Task 2 and commit**

Run:

```bash
pnpm exec vitest run tests/verify-processing-admission-state.test.ts
pnpm lint
pnpm typecheck
git diff --check
git add scripts/verify-processing-admission-state.mjs \
  tests/verify-processing-admission-state.test.ts
git commit -m "feat: gate processing public admission"
```

Expected: all checks PASS.

---

### Task 3: Reuse the browser smoke for an anonymous public server job

**Files:**
- Modify: `scripts/smoke-image-compress-server.mjs`
- Modify: `scripts/support/processing-staging-smoke-runtime.mjs`
- Modify: `tests/processing-staging-smoke.test.ts`

**Interfaces:**
- Consumes: fixed production Pages origin and no maintainer session for public mode.
- Produces: `runProcessingPublicSmokeCli({ argv }): ProcessingPublicSmokeResult` and schema `hereisit-processing-production-public-smoke@1`.

- [ ] **Step 1: Write failing public-smoke tests**

Add a public result fixture and assert the CLI accepts only the fixed production origin and output path:

```ts
const publicResult = {
  schema: "hereisit-processing-production-public-smoke@1",
  version: 1,
  passed: true,
  rolloutPercent: 100,
  nonMaintainerServer: true,
  directDownload: true,
  downloadAcknowledged: true,
  exactLengthUpload: true,
  sourceFilenameLeak: false,
};

await expect(
  runProcessingPublicSmokeCli({
    argv: ["--page-origin", PROCESSING_PRODUCTION_ORIGIN, "--output", output],
  }),
).resolves.toEqual(publicResult);
```

Assert no session environment variable is read, policy is `maintainer: false`, `execution: server`, `reason: null`, disclosure upload is true, exactly one input PUT and one successful download acknowledgement occur, and filenames/private failures never enter output or stderr.

- [ ] **Step 2: Run the focused test and record RED**

Run:

```bash
pnpm exec vitest run tests/processing-staging-smoke.test.ts
```

Expected: FAIL because the public CLI/result does not exist.

- [ ] **Step 3: Extract the existing server-job browser path without duplicating it**

Rename the maintainer-specific browser helper to accept an expected identity and stage prefix while preserving one implementation of file selection, compression, direct download, acknowledgement, request counting, and source-leak checks. The identity-dependent portion becomes:

```js
await runSmokeStage(`${stagePrefix}-context`, () =>
  injectSession(context, pageOrigin, sessionId),
);
await assertPolicies(state, {
  maintainer: expectedMaintainer,
  execution: "server",
  reason: null,
});
await runSmokeStage(`${stagePrefix}-ui`, () =>
  page.locator('[data-policy="server"]').waitFor({ timeout: timeoutMs }),
);
```

Canary mode still runs public-local plus maintainer-server. Public mode injects the existing deterministic non-maintainer session and runs the same server job once. Do not add a second compression flow.

- [ ] **Step 4: Implement the exact public CLI and result**

`runProcessingPublicSmokeCli` accepts the same two ordered flags as the canary CLI, but only
`https://hereisit.pages.dev`, does not read a session secret, writes a mode-0600 canonical result with
`refuseOverwrite: true`, and preserves only allowlisted stage names.

- [ ] **Step 5: Verify Task 3 and commit**

Run:

```bash
pnpm exec vitest run tests/processing-staging-smoke.test.ts
pnpm lint
pnpm typecheck
git diff --check
git add scripts/smoke-image-compress-server.mjs \
  scripts/support/processing-staging-smoke-runtime.mjs \
  tests/processing-staging-smoke.test.ts
git commit -m "test: add public processing smoke"
```

Expected: existing staging/production canary behavior and new public behavior all PASS.

---

### Task 4: Add the protected promotion and disable workflow

**Files:**
- Create: `.github/workflows/processing-production-admission.yml`
- Create: `tests/processing-production-admission-workflow.test.ts`
- Modify: `tests/processing-production-workflow.test.ts`
- Modify: `docs/deployment/processing-staging-bootstrap.md`

**Interfaces:**
- Consumes for promotion: successful `Processing production` workflow-run ID, exact head SHA, and artifact `processing-production-canary-<sha>`.
- Consumes for disable: current primary D1 circuit state; no arbitrary SHA, version, percentage, price, or limit input.
- Produces: sanitized artifact `processing-production-admission-<sha>` containing only source SHA, engine digest, transition attestation, gate result, policy result, public smoke result, and recovery result.

- [ ] **Step 1: Write failing workflow source-contract tests**

Create tests that require:

```ts
expect(workflow).toContain('workflows: ["Processing production"]');
expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
expect(workflow).toContain("environment: processing-production");
expect(workflow).toContain("group: processing-production");
expect(workflow).toContain("--rollout-percent 100");
expect(workflow).toContain("--max-projected-monthly-cost-microusd 5000000");
expect(workflow).toContain("--max-live-cost-per-1000-microusd 500000");
expect(workflow).not.toMatch(/rollout.*\$\{\{\s*inputs\./u);
```

Also require exact run/SHA artifact binding, canary result validation, same engine digest, all existing quotas/rate namespace IDs, primary Queue pause before mutation, DLQ never resumed, state preflight, transition verification/application before policy success, public anonymous smoke after primary resume, and `if: failure()` cleanup that attempts Queue pause, D1 circuit opening, and canary-version restoration independently.

Update the current production-workflow test to require that its public policy remains local and its artifact remains the sole promotion input; do not change the canary workflow to rollout 100.

- [ ] **Step 2: Run workflow tests and record RED**

Run:

```bash
pnpm exec vitest run \
  tests/processing-production-workflow.test.ts \
  tests/processing-production-admission-workflow.test.ts
```

Expected: FAIL because the admission workflow is absent.

- [ ] **Step 3: Implement exact canary binding and credential-free checks**

Add a `workflow_run` promotion job guarded to the canonical repository, successful main production run,
and matching head repository. Before Cloudflare credentials:

```bash
test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD_SHA"
test "$(cat .artifacts/canary/source-sha.txt)" = "$EXPECTED_HEAD_SHA"
node --input-type=module - <<'NODE'
// Require canary passed, rolloutPercent === 0, maintainerServer === true,
// and gate-results verified === true; reject extra/malformed documents.
NODE
```

Rebuild only the Worker bundle, web tree, and canonical cost model from the locked exact SHA. Do not build
or push a Container image. Compare the Worker module hash, release report hash, current generated rollout-zero
config hash, and engine digest to the canary attestation before mutation.

- [ ] **Step 4: Implement protected promotion**

Under `environment: processing-production` and `concurrency.group: processing-production`:

1. Discover and verify existing production resources and immutable engine digest.
2. Resolve the current active canary Worker from D1 and the pre-deploy Cloudflare version snapshot.
3. Call `verify-processing-admission-state.mjs`.
4. Generate canonical rollout-zero and rollout-100 configs with the same existing values.
5. Pause primary Queue and verify both primary and DLQ paused.
6. Deploy the rollout-100 Worker with `--no-bundle --containers-rollout none`.
7. Finalize and apply the admission transition attestation.
8. Poll `/v1/policy` for a deterministic anonymous session until it returns server/upload disclosure.
9. Resume only primary Queue and run `runProcessingPublicSmokeCli`.
10. Verify primary resumed, DLQ paused, no active job/outbox/deletion residue, and publish only allowlisted artifacts.

Do not rotate the cost epoch: promotion belongs to the already attested release and continues its canary epoch.

- [ ] **Step 5: Implement fail-closed recovery and manual disable**

Before promotion, record the canary version ID and confirm it is rollout zero. If any step after mutation fails,
run all three safety layers even when an earlier layer fails:

```bash
set +e
pnpm exec wrangler queues pause-delivery "$QUEUE_NAME"
QUEUE_RECOVERY=$?
node scripts/verify-processing-admission-state.mjs \
  --mode disable --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --database-id "$PRODUCTION_D1_DATABASE_ID" --now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
CIRCUIT_RECOVERY=$?
pnpm exec wrangler versions deploy "$CANARY_VERSION_ID@100%" --config "$WRANGLER_CONFIG" --yes
VERSION_RECOVERY=$?
set -e
node --input-type=module - <<'NODE'
const response = await fetch(`${process.env.PRODUCTION_API_ORIGIN}/v1/policy`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: process.env.PRODUCTION_PAGES_ORIGIN },
  body: JSON.stringify({
    contract: "tool-job@1",
    toolContract: "image.optimize@1",
    anonymousSessionId: "018f47a2-65d4-7f31-a377-5afbb8f53f27",
  }),
});
const body = await response.json();
if (response.status !== 200 || body.execution !== "local" || body.disclosure?.upload !== false) {
  process.exit(1);
}
NODE
test "$QUEUE_RECOVERY" -eq 0
test "$CIRCUIT_RECOVERY" -eq 0
test "$VERSION_RECOVERY" -eq 0
exit 1
```

Use independent steps or an equivalent trap so Queue pause, circuit opening, and provider-version restoration cannot
skip one another. The circuit is the authoritative immediate disable even if provider restoration fails. Preserve the
original workflow failure after recovery evidence is written.

The same workflow's protected `workflow_dispatch` exposes one choice only, `disable`. It pauses both Queues, opens the
existing D1 circuit, verifies local/upload-false policy, and leaves both Queues paused. It refuses a dispatch from a
non-main ref. The next ordinary production release installs an attested rollout-zero canary before any later public
promotion; manual disable does not reset the circuit automatically.

- [ ] **Step 6: Update deployment documentation**

Document this exact operator flow:

```text
main CI → Processing staging → protected Processing production canary (0%)
→ protected Processing production admission (100%)
→ automatic circuit local fallback or protected disable (effective 0%)
```

State that the five-dollar value is an application admission ceiling, not a Cloudflare billing hard cap; circuit
opening is automatic and reset is not automatic.

- [ ] **Step 7: Verify Task 4 and commit**

Run:

```bash
pnpm exec vitest run \
  tests/processing-production-workflow.test.ts \
  tests/processing-production-admission-workflow.test.ts \
  tests/verify-worker-version-chain.test.ts \
  tests/verify-processing-admission-state.test.ts \
  tests/processing-staging-smoke.test.ts
pnpm lint
pnpm typecheck
git diff --check
git add .github/workflows/processing-production-admission.yml \
  tests/processing-production-admission-workflow.test.ts \
  tests/processing-production-workflow.test.ts \
  docs/deployment/processing-staging-bootstrap.md
git commit -m "feat: promote public image processing"
```

Expected: all focused checks PASS and action references are pinned to full reviewed commit SHAs.

---

### Task 5: Full verification, review, release, and cleanup

**Files:**
- Modify only if review exposes a branch-caused defect in Tasks 1–4.
- Do not commit `.artifacts/`, Playwright output, credentials, local Wrangler files, or generated production config.

**Interfaces:**
- Consumes: completed commits from Tasks 1–4.
- Produces: reviewed pull request, protected CI evidence, exact-SHA staging/canary/admission evidence, public production policy and browser smoke evidence, synchronized clean `main`, and no disposable local resources.

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm verify
git diff origin/main...HEAD --check
git status --short
```

Expected: audit, Biome, all package typechecks, Vitest, Worker integration, image-engine fuzz, builds, static export, discovery imports, and bundle budgets PASS; only intentional branch commits differ from `origin/main`.

- [ ] **Step 2: Review the exact branch diff**

Read every changed file and verify:

```text
no secrets or file metadata in logs/artifacts
no non-rollout production config difference
no arbitrary percentage or cost input
all mutations serialized and protected
all failure paths return local/upload-false and pause primary Queue
no new dependency or unrelated UI/codec change
```

Fix only confirmed branch defects with a failing focused test first, then rerun `pnpm verify`.

- [ ] **Step 3: Publish and wait for protected PR checks**

Push the branch, create the PR, and wait for:

```text
verify
browser matrix: Chromium, Firefox, WebKit, mobile Chromium, mobile Firefox, mobile WebKit
product analytics
Cloudflare Pages preview
```

Do not merge while any required check is pending, skipped unexpectedly, or failed.

- [ ] **Step 4: Merge and verify the exact main SHA**

After green protected checks, merge through GitHub, capture the exact merge SHA, and wait for successful main CI,
Processing staging, and protected Processing production canary at that same SHA. Confirm the canary remains rollout
zero and its anonymous policy remains local before approving public admission.

- [ ] **Step 5: Approve and verify 100-percent production admission**

Approve the protected admission job. Require:

```text
policy: maintainer=false, execution=server, reason=null, disclosure.upload=true
rolloutPercent=100
public browser compression and direct download passed
download acknowledgement passed
input/output deletion and zero active/orphan jobs passed
primary Queue resumed; DLQ paused
MAX_PROJECTED_MONTHLY_COST_MICROUSD=5000000
```

If admission fails, require the workflow's local-policy and paused-Queue recovery evidence before any retry.

- [ ] **Step 6: Synchronize and clean local resources**

Run read-only inventory first, then remove only task-owned resources:

```bash
git fetch origin
git switch main
git pull --ff-only
git branch -d agent/processing-public-admission
docker ps -a --filter label=com.hereisit.task=processing-public-admission
docker images --filter label=com.hereisit.task=processing-public-admission
git status --short --branch
```

Delete task-owned temporary artifacts, stopped development servers, Docker containers/images/volumes/build cache,
and any disposable task worktree. Do not touch unrelated existing worktrees. Final state: clean
`main == origin/main`, no task branch/worktree, and only GitHub's sanitized seven-day operational evidence retained.
