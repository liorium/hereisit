# Application-Scoped Processing Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Worker and web-only changes without rebuilding or re-approving unchanged image/PDF engines, while preserving exact engine identity, cost accounting, rollback, and fail-closed PDF admission.

**Architecture:** Add a signed application-release manifest for current Worker/web artifacts. Deployment combines that manifest with the already-active D1/Cloudflare attestation, requires both engine digests and all resource identities to remain unchanged, rotates the accounting epoch for the new Worker version, and mutates only Worker and Pages.

**Tech Stack:** Node.js 24 scripts, canonical JSON and existing Ed25519 signing helpers, GitHub Actions, Wrangler, Cloudflare Workers/D1/Pages, Vitest source-contract tests.

## Global Constraints

- Application scope cannot change either engine digest, D1 schema, Queue topology, limits, cost ceilings, or PDF public admission.
- Missing or mismatched active attestation blocks deployment; never infer or fabricate prior authority.
- The exact monthly estimated-cost ceiling remains `5,000,000µUSD`.
- Sign only bounded canonical manifests and keep private keys under `$RUNNER_TEMP` with mode `0600`.
- Rollback restores the prior Worker version, Pages deployment, accounting state, circuit, and four queue states before reopening processing.
- No file data, filenames, URLs, secrets, provider response bodies, or signed download locations may enter artifacts.
- No new dependency and no local Playwright.

---

### Task 1: Define a strict application-release manifest

**Files:**
- Create: `scripts/processing-application-release.mjs`
- Create: `docs/deployment/processing-application-release.schema.json`
- Test: `tests/processing-application-release.test.ts`

**Interfaces:**
- Produces: `createProcessingApplicationRelease(input): ProcessingApplicationRelease`
- Produces: `validateProcessingApplicationRelease(value): ProcessingApplicationRelease`
- Manifest fields: `schema`, `version`, `gitSha`, `baseReleaseReportSha256`, `worker`, `web`, `security`, `createdAt`, `expiresAt`, `verificationSha256`

- [ ] **Step 1: Write RED strict-schema tests**

Test canonical hashes, exact keys, 40-character Git SHA, one base report SHA, bounded future expiry, Worker
module hash, staging/production web archive/tree hashes, and SBOM/Trivy hashes for `worker`, `web-staging`,
`web-production`, and `lockfile`. Reject engine assets, engine digests, PDF quality fields, extra keys, path
traversal, URLs, and a flipped verification hash.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run tests/processing-application-release.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement with existing canonical helpers**

Reuse `assertExactKeys`, `assertSha256`, `canonicalJson`, `sha256Canonical`, bounded regular-file readers,
and atomic canonical writer from `scripts/image-lab-common.mjs`. Do not add a general schema framework.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm exec vitest run tests/processing-application-release.test.ts
git add scripts/processing-application-release.mjs docs/deployment/processing-application-release.schema.json tests/processing-application-release.test.ts
git commit -m "feat: define application processing releases"
```

### Task 2: Bind application authority to active processing state

**Files:**
- Create: `scripts/verify-processing-application-authority.mjs`
- Test: `tests/verify-processing-application-authority.test.ts`
- Reuse: `scripts/processing-evidence-signature.mjs`
- Reuse: active attestation readers used by `scripts/verify-worker-version-chain.mjs`

**Interfaces:**
- Produces: `verifyProcessingApplicationAuthority({ manifest, signature, publicKey, activeAttestation, actualResources, now })`
- Returns: canonical projection containing current Git SHA, prior/new Worker identity, inherited engine digests, base report SHA, resource/config hashes, and `passed: true`

- [ ] **Step 1: Write RED identity tests**

Accept only when the signature is valid and the active attestation's release report, image engine digest,
PDF engine digest, generated-config identity, cost model, limits, D1/R2/Queue IDs, and PDF admission state all
match actual Cloudflare state. Reject any changed engine, open-ended missing field, expired manifest, non-active
Worker, or PDF admission transition.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run tests/verify-processing-application-authority.test.ts`

- [ ] **Step 3: Implement one fail-closed verifier**

Import the existing signature verifier and attestation parsers. Return only the sanitized projection; never
return raw provider documents.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm exec vitest run tests/processing-application-release.test.ts tests/verify-processing-application-authority.test.ts
git add scripts/verify-processing-application-authority.mjs tests/verify-processing-application-authority.test.ts
git commit -m "feat: verify application release authority"
```

### Task 3: Produce exact-SHA application authority in CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/processing-pdf-release-workflows.test.ts`
- Create: `tests/processing-application-release-workflow.test.ts`

**Interfaces:**
- Consumes: successful `verify` and protected six-project `browser` jobs
- Produces artifact: `processing-application-authority-${{ github.sha }}`

- [ ] **Step 1: Write RED workflow-source tests**

Require a main-only `application-release-authority` job that runs regardless of
`PROCESSING_HOSTED_REVIEWS_READY`, builds only Worker plus staging/production web archives, scans those four
application scopes, reads the active base report SHA and engine identities through the existing bounded read-only
D1/Cloudflare attestation queries in the protected `processing-release-authority` environment, signs under
`$RUNNER_TEMP`, verifies the signature, and uploads a seven-day exact-SHA artifact. The query output is reduced to
the strict sanitized identity projection before it enters the artifact.

Assert the job contains no engine build, container push, PDF benchmark, hosted human review, or Cloudflare
mutation command.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run tests/processing-application-release-workflow.test.ts tests/processing-pdf-release-workflows.test.ts`

- [ ] **Step 3: Add the minimal CI job**

Reuse the existing deterministic Worker/web build, archive, Syft/Trivy normalization, private-key handling,
and artifact upload commands. Keep the full dual-engine `release-authority` job unchanged for engine changes.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm exec vitest run tests/processing-application-release-workflow.test.ts tests/processing-pdf-release-workflows.test.ts
git add .github/workflows/ci.yml tests/processing-application-release-workflow.test.ts tests/processing-pdf-release-workflows.test.ts
git commit -m "ci: seal application-only processing releases"
```

### Task 4: Deploy application scope without engine mutation

**Files:**
- Create: `.github/workflows/processing-application-staging.yml`
- Create: `.github/workflows/processing-application-production.yml`
- Test: `tests/processing-application-deployment-workflows.test.ts`
- Reuse: existing mutation-state capture, queue-state restore, Worker attestation, smoke, Pages, and rollback scripts

**Interfaces:**
- Staging consumes: `processing-application-authority-<sha>`
- Production consumes: successful exact-SHA application staging artifact
- Both produce sanitized deployment receipt with manifest SHA, prior/new Worker version, inherited engine digests, Pages deployment ID, smoke result, accounting epoch, and restored queue states

- [ ] **Step 1: Write RED mutation-boundary tests**

Require both workflows to verify authority and capture prior Worker, Pages, circuit, epoch, D1 attestation,
both engine digests, PDF admission, and all four queue states before mutation. Require commands for Worker/Pages
only and explicitly forbid container push, D1 migrations, resource provisioning, and PDF admission changes.

Require queues paused before Worker transition, a new attestation and accounting epoch for the new Worker,
image canary success, PDF policy remaining unchanged, exact prior queue restoration, and independent fail-closed
rollback on failure or cancellation.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run tests/processing-application-deployment-workflows.test.ts`

- [ ] **Step 3: Implement staging then production workflows**

Reuse existing scripts and exact shell fragments; do not copy container or migration phases. Production starts
only from the successful staging artifact at the same SHA. A rollback prerequisite failure keeps all queues
paused and the circuit open.

- [ ] **Step 4: Run workflow gates and commit**

```bash
pnpm exec vitest run tests/processing-application-deployment-workflows.test.ts tests/processing-staging-workflow.test.ts tests/processing-production-workflow.test.ts tests/processing-pdf-release-workflows.test.ts
git add .github/workflows/processing-application-staging.yml .github/workflows/processing-application-production.yml tests/processing-application-deployment-workflows.test.ts
git commit -m "ci: deploy processing application releases"
```

### Task 5: Verify release isolation and repository health

**Files:**
- Verify only

- [ ] **Step 1: Run release-focused tests**

Run all processing candidate, authority, workflow, attestation, accounting, queue, smoke, and PDF-admission
tests. Expected: application scope leaves both engine identities and PDF admission byte-for-byte unchanged.

- [ ] **Step 2: Run full verification**

Run: `pnpm verify`

- [ ] **Step 3: Review and clean**

Run `git diff --check origin/main...HEAD`, inspect every workflow mutation boundary, and remove generated
build/test/Docker artifacts. Do not run Playwright locally.

- [ ] **Step 4: Commit any verification-only fixture correction separately**

Only if a branch-caused fixture is stale, add the smallest test-only correction with its own commit. Do not
weaken current dual-engine release gates.
