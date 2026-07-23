# Push-based Cloudflare Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the exact successful `main` CI commit to Cloudflare staging without release tags, offline keys, or manual workflow dispatch.

**Architecture:** GitHub `workflow_run` starts one protected staging job only after the repository CI succeeds for a `main` push. The job checks out the reported head SHA, builds directly from the locked repository, reuses the existing resource/configuration validators, deploys at rollout zero, and keeps queue cleanup and authenticated smoke checks.

**Tech Stack:** GitHub Actions, pnpm 11, Node.js 24, Wrangler 4, Cloudflare Workers/Containers/Pages/D1/R2/Queues.

## Global Constraints

- Pull requests and non-`main` pushes must never receive Cloudflare environment secrets.
- The deployment source must equal `github.event.workflow_run.head_sha` from a successful `CI` push run.
- Staging public rollout remains zero; only the primary queue may resume and failure cleanup re-pauses it.
- No offline signing key, release tag, GitHub Release candidate, or new dependency.

---

### Task 1: Version the staging cost input

**Files:**
- Move: `tests/fixtures/live-cost-model-pr-input.json` → `docs/deployment/processing-staging-cost-input.json`
- Modify: `tests/live-cost-model.test.ts`

**Interfaces:**
- Consumes: `scripts/create-live-cost-model.mjs --input <path> --schema <path> --output <path>`
- Produces: a checked-in, schema-validated staging cost input used by tests and deployment.

- [ ] **Step 1: Change the fixture path in the test**

```ts
const fixturePath = "docs/deployment/processing-staging-cost-input.json";
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/live-cost-model.test.ts`

Expected: FAIL because the new path does not exist.

- [ ] **Step 3: Move the existing validated JSON**

```bash
mv tests/fixtures/live-cost-model-pr-input.json docs/deployment/processing-staging-cost-input.json
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/live-cost-model.test.ts`

Expected: all tests pass.

### Task 2: Replace the manual signed workflow

**Files:**
- Modify: `tests/processing-staging-workflow.test.ts`
- Delete: `tests/processing-staging-workflow-phase-a.test.ts`
- Replace: `.github/workflows/processing-staging.yml`

**Interfaces:**
- Consumes: successful `CI` `workflow_run`, `processing-staging` variables/secrets, existing deployment scripts.
- Produces: automatic rollout-zero Worker/Container/Pages staging deployment and sanitized evidence artifacts.

- [ ] **Step 1: Replace the workflow contract test first**

The test must require these literal contracts:

```ts
expect(workflow).toContain("workflow_run:");
expect(workflow).toContain('workflows: ["CI"]');
expect(workflow).toContain("types: [completed]");
expect(workflow).not.toContain("workflow_dispatch:");
expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
expect(workflow).toContain("github.event.workflow_run.event == 'push'");
expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
expect(workflow).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
expect(workflow).not.toMatch(/processing-evidence|release_tag|PRIVATE(?:_|-)KEY/);
```

Retain assertions for environment isolation, immutable container digest resolution, rollout zero,
secret-list verification, Pages alias verification, primary/DLQ state checks, authenticated smoke, and
failure cleanup.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/processing-staging-workflow.test.ts`

Expected: FAIL because the workflow is still manual and signed-release based.

- [ ] **Step 3: Replace the workflow with the direct deployment flow**

The workflow header and trust gate must be exactly:

```yaml
name: Processing staging

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions:
  contents: read

jobs:
  deploy:
    if: >-
      github.repository == 'liorium/hereisit' &&
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == 'main' &&
      github.event.workflow_run.head_repository.full_name == github.repository
    environment: processing-staging
```

The job must check out `${{ github.event.workflow_run.head_sha }}`, assert `git rev-parse HEAD` matches
it, install the frozen lockfile, validate the sealed environment, build the engine/Worker/staging web,
generate and hash the live cost model, push and resolve the immutable Container digest, provision
resources, generate bootstrap/active Wrangler configs, apply migrations, deploy Worker secrets and the
final Worker, deploy Pages, verify both queue states, run authenticated compression smoke, upload only
sanitized outputs, and re-pause the primary queue on any post-resume failure.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/processing-staging-workflow.test.ts tests/live-cost-model.test.ts`

Expected: all tests pass.

### Task 3: Document and publish

**Files:**
- Modify: `docs/deployment/processing-staging-bootstrap.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Produces: one-time setup and push-based operating instructions matching the workflow.

- [ ] **Step 1: Replace manual release instructions**

Document that merging to `main` starts deployment after CI success, no key or release tag is required,
and production later adds only a protected GitHub environment approval.

- [ ] **Step 2: Run repository checks**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm vitest run tests/processing-staging-workflow.test.ts tests/live-cost-model.test.ts
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/processing-staging.yml \
  docs/deployment.md docs/deployment/processing-staging-bootstrap.md \
  docs/deployment/processing-staging-cost-input.json \
  tests/live-cost-model.test.ts tests/processing-staging-workflow.test.ts \
  tests/processing-staging-workflow-phase-a.test.ts
git commit -m "ci: deploy processing staging after main CI"
git push origin feat/processing-staging-workflow
```

- [ ] **Step 4: Monitor the pull-request checks**

Run: `gh pr checks 20 --watch --interval 30`

Expected: `verify`, `browser`, and Cloudflare Pages pass. The staging deploy must not run on the pull
request branch; it starts only after the reviewed branch reaches `main` and CI succeeds.
