# Processing Staging Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one manual GitHub Actions workflow whose build and deploy modes preserve the offline evidence-signing boundary and safely bootstrap Cloudflare processing at zero public rollout.

**Architecture:** Build mode creates a source-bound candidate without Cloudflare credentials. A trusted workstation signs the content-free evidence. Deploy mode verifies the immutable finalized release before selecting the `processing-staging` environment, then reuses the existing candidate, resource, Wrangler, digest, attestation, and smoke scripts.

**Tech Stack:** GitHub Actions, Node.js 24, pnpm 11.11.0, Docker Buildx, Wrangler 4.111.0, Vitest, Cloudflare Workers/Containers/D1/R2/Queues.

## Global Constraints

- Public server processing stays at `0`; both Queues stay paused.
- The Ed25519 private key never enters GitHub Actions, Cloudflare, the repository, this development container, command arguments, or artifacts.
- Build mode must not select `processing-staging` or reference Cloudflare secrets.
- Deploy mode verifies release identity and signed evidence before passing secrets to a command.
- Container deployment uses an immutable same-account SHA-256 digest, never a mutable tag.
- Add no npm dependency; reuse repository scripts and Node.js standard library.
- Never log file contents, filenames, thumbnails, presigned URLs, user payloads, or secret values.
- Run Trivy `0.69.3` only from the reviewed GHCR linux/amd64 manifest digest
  `sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689`;
  do not use `trivy-action`, `setup-trivy`, mutable scanner tags, or `latest`.
- Resolve `ghcr.io/aquasecurity/trivy-db:2` once to an immutable digest, populate one private cache
  from that digest, then run all five scans sequentially with DB updates disabled and bind the digest
  into the candidate and vulnerability gate.
- Stage or retag each scan target as `hereisit-<scope>:sha256-<artifact-sha256>`, run all scans and
  gate verification in the same credential-free job, and finish verification within the gate's
  30-minute report-freshness window. Trivy JSON does not carry the DB OCI digest, so the single-job,
  single-cache command sequence is the reviewed DB provenance boundary.
- Generate SBOMs with Syft `1.44.0` only from the reviewed GHCR linux/amd64 manifest digest
  `sha256:2baa4d24d90599840c0100a8d30deaa533821fcd99f405ce6f90e3d225bd836d`;
  do not use a mutable Syft tag or an SBOM action wrapper.

---

### Task 1: Expose the existing evidence signer as a fail-closed CLI

**Files:**
- Modify: `scripts/processing-evidence-signature.mjs`
- Modify: `tests/processing-evidence-signature.test.ts`

**Interfaces:**
- Consumes: canonical `hereisit-processing-evidence@1` JSON, a detached 64-byte signature, and an Ed25519 PEM key.
- Produces: `runProcessingEvidenceSignatureCli(argv, stdout)` and canonical JSON containing `bundleSha256` and `signatureSha256`.

- [ ] **Step 1: Write the failing CLI test**

Add this focused test using the existing `fixture()` helper:

```ts
it("signs and verifies through explicit CLI modes", async () => {
  const value = await fixture();
  let output = "";
  await runProcessingEvidenceSignatureCli(
    ["--mode", "sign", "--bundle", value.bundlePath, "--signature", value.signaturePath, "--private-key", value.privateKeyPath, "--repository-root", resolve(".")],
    { write: (text: string) => (output += text) },
  );
  expect(JSON.parse(output).signatureSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(output).not.toContain("PRIVATE KEY");

  output = "";
  await runProcessingEvidenceSignatureCli(
    ["--mode", "verify", "--bundle", value.bundlePath, "--signature", value.signaturePath, "--public-key", value.publicKeyPath],
    { write: (text: string) => (output += text) },
  );
  expect(JSON.parse(output).bundleSha256).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Confirm the missing export**

Run: `pnpm exec vitest run tests/processing-evidence-signature.test.ts`

Expected: FAIL because `runProcessingEvidenceSignatureCli` is not exported.

- [ ] **Step 3: Add the minimum dispatcher**

Import `assertExactKeys`, `canonicalJson`, and `parseCliArguments` from `image-lab-common.mjs`, then add:

```js
export async function runProcessingEvidenceSignatureCli(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  let result;
  if (args.mode === "sign") {
    assertExactKeys(args, ["mode", "bundle", "signature", "private-key", "repository-root"], "evidence signing arguments");
    result = await signCanonicalProcessingEvidence({
      bundlePath: args.bundle,
      signaturePath: args.signature,
      privateKeyPath: args["private-key"],
      repositoryRoot: args["repository-root"],
    });
  } else if (args.mode === "verify") {
    assertExactKeys(args, ["mode", "bundle", "signature", "public-key"], "evidence verification arguments");
    result = await verifyCanonicalProcessingEvidenceSignature({
      bundlePath: args.bundle,
      signaturePath: args.signature,
      publicKeyPath: args["public-key"],
    });
  } else {
    throw new TypeError("evidence signature mode must be sign or verify");
  }
  stdout.write(canonicalJson(result));
}
```

Add the existing direct-execution guard pattern so failures expose only the error message and exit code `1`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run tests/processing-evidence-signature.test.ts`

Expected: PASS.

```bash
git add scripts/processing-evidence-signature.mjs tests/processing-evidence-signature.test.ts
git commit -m "feat(deploy): expose processing evidence signature CLI"
```

### Task 2: Lock the workflow security contract

**Files:**
- Create: `tests/processing-staging-workflow.test.ts`

**Interfaces:**
- Consumes: `.github/workflows/processing-staging.yml` as UTF-8 text.
- Produces: regression checks for mode isolation, signed release verification, immutable images, rollout zero, paused Queues, and sanitized artifacts.

- [ ] **Step 1: Add the failing workflow test**

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const path = ".github/workflows/processing-staging.yml";

describe("processing staging workflow", () => {
  it("is manual, main-only, and isolates build credentials", () => {
    expect(existsSync(path)).toBe(true);
    const workflow = readFileSync(path, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("options: [build, deploy]");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  verify-release:"));
    expect(build).not.toContain("environment: processing-staging");
    expect(build).not.toContain("secrets.CLOUDFLARE");
  });

  it("verifies before mutation and never resumes queues", () => {
    const workflow = readFileSync(path, "utf8");
    const candidate = workflow.indexOf("--required-state finalized");
    const signature = workflow.indexOf("--mode verify");
    const provision = workflow.indexOf("ensure-cloudflare-processing-resources.mjs");
    expect(candidate).toBeGreaterThan(0);
    expect(signature).toBeGreaterThan(candidate);
    expect(provision).toBeGreaterThan(signature);
    expect(workflow).toContain("--rollout-percent 0");
    expect(workflow).toContain("resolve-cloudflare-image-digest.mjs");
    expect(workflow).not.toContain("queues resume-delivery");
  });

  it("uploads only sanitized seven-day evidence", () => {
    const workflow = readFileSync(path, "utf8");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).not.toContain(".artifacts/candidate/**");
  });
});
```

- [ ] **Step 2: Confirm absence and commit the contract**

Run: `pnpm exec vitest run tests/processing-staging-workflow.test.ts`

Expected: FAIL at `existsSync(path)`.

```bash
git add tests/processing-staging-workflow.test.ts
git commit -m "test(deploy): define staging workflow security contract"
```

### Task 3: Add the two-mode workflow and operator sequence

**Files:**
- Create: `.github/workflows/processing-staging.yml`
- Modify: `docs/deployment/processing-staging-bootstrap.md`

**Interfaces:**
- Build consumes: exact `main` SHA, checked-in immutable release inputs, and repository source.
- Build produces: `processing-built-candidate-<sha>` with built candidate and content-free review inputs.
- Deploy consumes: immutable annotated release tag, exact finalized asset set, committed public key, and `processing-staging` environment values.
- Deploy produces: rollout-zero Worker deployment plus sanitized candidate, digest, Worker version, gate, and smoke evidence.

- [ ] **Step 1: Create the workflow header and isolated jobs**

```yaml
name: Processing staging

on:
  workflow_dispatch:
    inputs:
      mode:
        required: true
        type: choice
        options: [build, deploy]
      release_tag:
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: processing-staging-${{ inputs.mode }}
  cancel-in-progress: false
```

Create `build`, `verify-release`, and `deploy` jobs. Use Ubuntu 24.04 and the same pinned checkout, pnpm, Node 24, artifact upload, and artifact download action SHAs already used by repository workflows. Set `persist-credentials: false`.

- [ ] **Step 2: Implement build mode with existing producers**

The job condition is `inputs.mode == 'build' && github.repository == 'liorium/hereisit' && github.ref == 'refs/heads/main'`. It does not declare an environment.

Run, in order:

```text
install locked dependencies -> unit and Worker integration tests -> one linux/amd64 Buildx solve with OCI and Docker exporters -> build-scope license gate -> pinned vulnerability scan -> no-bundle Worker build -> separate staging/production web builds -> deterministic web archives -> release-input verification -> live-cost-model creation -> create-processing-candidate.mjs -> verify-processing-candidate.mjs with state built
```

The candidate producer receives only its defined files and exact CLI fields. Upload `.artifacts/built-candidate` and content-free review JSON with `compression-level: 0`, `if-no-files-found: error`, and `retention-days: 7`.

- [ ] **Step 3: Implement uncredentialed release verification**

`verify-release` runs only for deploy mode and does not select a GitHub environment. It uses `resolve-github-release-assets.mjs`, then runs:

```bash
node scripts/verify-processing-candidate.mjs --manifest .artifacts/candidate/processing-candidate.json --root .artifacts/candidate --required-state finalized --expected-git-sha "$GITHUB_SHA"
node scripts/processing-evidence-signature.mjs --mode verify --bundle ".artifacts/candidate/evidence-v1--$RELEASE_ID--processing-evidence.json" --signature ".artifacts/candidate/evidence-v1--$RELEASE_ID--processing-evidence.sig" --public-key docs/deployment/processing-evidence-ed25519-public.pem
```

Upload the verified candidate with an exact artifact name and digest. The deploy job downloads it through `download-and-verify-github-artifact.mjs`, binding repository, source run, artifact ID, artifact digest, and head SHA before extraction.

- [ ] **Step 4: Implement credentialed rollout-zero deployment**

`deploy` needs `verify-release` and declares `environment: processing-staging`. Pass each secret only to the step that consumes it. Execute the canonical runbook sequence:

```text
sealed environment verification -> candidate verification -> Docker archive load -> immutable git-tag push -> authenticated registry inspection and digest resolution -> convergent resource provisioning -> bootstrap Wrangler config at rollout 0 -> dry-run -> D1 migrations -> bootstrap deployment -> Container application resolution -> active Wrangler config at rollout 0 -> Worker secrets through stdin -> active deployment with paused Queues -> version-chain attestation -> maintainer-authenticated smoke
```

Use existing scripts for every transformation. Do not invoke Queue resume. Parse Wrangler output only with `read-wrangler-output.mjs`. Upload only:

```yaml
path: |
  .artifacts/deployment/processing-candidate-identity.json
  .artifacts/deployment/cloudflare-image-digest.txt
  .artifacts/deployment/worker-version.json
  .artifacts/deployment/gate-results.json
  .artifacts/deployment/smoke-result.json
if-no-files-found: error
retention-days: 7
```

- [ ] **Step 5: Update the runbook**

Document this exact operator sequence at the top of `processing-staging-bootstrap.md`:

```text
1. Dispatch mode=build with the immutable release tag.
2. Verify the built artifact on the trusted workstation.
3. Review and sign content-free evidence using the documented key ceremony.
4. Publish the finalized exact asset set under the annotated release tag.
5. Dispatch mode=deploy with the same release tag.
6. Confirm rollout 0, paused Queues, and a passing maintainer smoke.
```

State that port `8976` is not used; it was only the Wrangler OAuth callback port.

- [ ] **Step 6: Run focused verification**

```bash
pnpm exec vitest run tests/processing-staging-workflow.test.ts tests/processing-staging-preflight-workflow.test.ts tests/processing-evidence-signature.test.ts tests/verify-processing-candidate.test.ts tests/ensure-cloudflare-processing-resources.test.ts tests/generate-processing-wrangler.test.ts tests/resolve-cloudflare-image-digest.test.ts
pnpm verify
```

Expected: all focused tests and repository verification PASS.

- [ ] **Step 7: Commit the workflow**

```bash
git add .github/workflows/processing-staging.yml docs/deployment/processing-staging-bootstrap.md
git commit -m "feat(deploy): automate processing staging bootstrap"
```

### Task 4: Publish and exercise build mode

**Files:**
- No repository file changes expected.

**Interfaces:**
- Consumes: reviewed branch and passing checks.
- Produces: merged workflow and one source-bound built-candidate artifact; no Cloudflare mutation.

- [ ] **Step 1: Push, open a pull request, and wait for checks**

Run `git push -u origin feat/processing-staging-workflow`, create the pull request with `gh pr create`, then run `gh pr checks --watch`.

Expected: CI, browser, and Cloudflare Pages checks PASS before merge.

- [ ] **Step 2: Dispatch build mode from merged main**

Run: `gh workflow run processing-staging.yml --ref main -f mode=build -f release_tag="processing-release-$RELEASE_ID"`

Expected: `processing-built-candidate-<main-sha>` is published and Cloudflare resources are unchanged.

The trusted-workstation key ceremony and deploy dispatch begin only after the artifact passes review. This plan never generates or transfers the private key.
