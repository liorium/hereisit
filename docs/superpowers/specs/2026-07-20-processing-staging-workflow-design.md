# Processing staging workflow design

## Purpose

Create a repeatable GitHub Actions path that builds and validates the processing container, publishes it by immutable digest, and deploys the Cloudflare processing stack to staging without depending on local disk or Docker.

Success means a maintainer can use one workflow file from `main` in two explicit modes and receive either:

- a verified, maintainer-only staging deployment with non-secret evidence; or
- a failed run that leaves public rollout at zero and queues paused.

## Scope

The workflow will:

1. Validate the selected source revision and deployment inputs.
2. Build, test, license-check, and vulnerability-scan the image engine.
3. Produce a built candidate artifact for offline evidence review and signing.
4. Accept only an externally signed, finalized release candidate in deploy mode.
5. Push the verified image to Cloudflare and resolve its immutable SHA-256 digest.
6. Convergently provision the required D1, R2, Queue, and Worker resources.
7. Deploy with public server processing disabled and queues paused.
8. Run an authenticated maintainer smoke test.
9. Upload non-secret deployment evidence as a GitHub Actions artifact.

This design does not enable public server processing, resume queues, deploy production, or add a separate build service.

## Architecture

The workflow is manually dispatched and restricted to `main`. A required `mode` input selects `build` or `deploy`; only deploy mode selects the existing `processing-staging` GitHub environment. Each mode runs sequentially in a fresh Ubuntu runner.

Build mode creates the container and content-free candidate evidence, then publishes a built-candidate artifact bound to the source commit. The maintainer reviews and signs only the small evidence document on a trusted workstation. The private Ed25519 key never enters the repository, GitHub Actions, Cloudflare, this development container, a command argument, or an artifact.

Deploy mode downloads the finalized candidate and detached signature from the immutable release assets, verifies their source revision, hashes, signature, and candidate state before accessing Cloudflare credentials, and then performs the staging deployment. The two modes share one workflow file but are separate runs because the offline signing boundary cannot exist inside an Actions runner.

The repository's existing candidate, resource, Wrangler generation, image-digest, and verification scripts remain the source of truth. The workflow only orchestrates them and supplies sealed inputs through environment variables or standard input.

The local development machine is used for authentication, status inspection, and signing the content-free evidence document only. Container compilation, scanning, publication, and staging deployment happen on ephemeral GitHub runners.

## Workflow sequence

### Build mode

1. Check out the exact `main` commit selected by the manual dispatch and reject a revision that is not reachable from `origin/main`.
2. Install the repository's pinned Node and pnpm versions, restore safe dependency caches, and install locked dependencies.
3. Run the processing server unit and integration checks, dependency-license validation, and container build.
4. Scan the built image with the repository's pinned scanner and policy. Any reportable vulnerability or policy failure stops the run.
5. Assemble the required candidate assets and call the existing built-candidate creation and verification scripts.
6. Upload the built candidate and content-free review inputs as a source-commit-bound artifact.

### Offline signing boundary

1. Download and verify the built artifact on the trusted maintainer workstation.
2. Review the content-free evidence, sign it with the external mode-0600 Ed25519 key, and finalize the candidate.
3. Publish the exact finalized candidate asset set under an immutable annotated release tag.

### Deploy mode

1. Verify and download the finalized release assets before selecting the GitHub environment or exposing Cloudflare credentials.
2. Verify the detached signature, candidate state, exact source commit, and every asset hash.
3. Authenticate to Cloudflare, load and publish the verified image, and resolve the registry result to a SHA-256 digest. Deployment configuration references that digest, never a mutable tag.
4. Provision or reconcile Cloudflare resources with the existing resource script. Existing correctly configured resources are reused.
5. Generate Wrangler configuration from the finalized candidate and deploy with public rollout set to zero and queues paused.
6. Run the maintainer-authenticated staging smoke test against the deployed Worker.
7. Upload the candidate identity, deployment version, scan summary, and sanitized smoke result as a non-secret evidence artifact.

## Safety and failure behavior

Every step fails closed. A failure stops subsequent steps, keeps public server processing disabled, and leaves queues paused. The workflow does not automatically delete D1, R2, Queue, registry, or Worker resources because deletion can destroy diagnostic state or retained data.

Resource provisioning and deployment commands must be convergent so a rerun can safely reuse completed state. A runner interruption after resource creation is therefore recovered by rerunning the same workflow.

Cloudflare secrets are read only in deploy mode from the `processing-staging` environment and passed through masked environment variables or standard input. Secret values, file contents, filenames, thumbnails, presigned URLs, and user payloads must never appear in logs or artifacts.

The staging Worker accepts server-processing traffic only from the configured maintainer session. Public users continue to use browser-local processing because rollout remains at zero.

## Verification and evidence

Pre-deployment gates are:

- sealed input and source-revision validation;
- server unit and integration tests;
- dependency-license policy validation;
- container vulnerability scanning;
- candidate asset, detached-signature, and identity verification;
- immutable image digest resolution.

Post-deployment verification is one authenticated maintainer smoke path that proves request admission, queue submission, processing completion, and result retrieval without exposing payload data in evidence.

The workflow artifact contains only machine-readable, non-secret evidence needed to reproduce the release decision: source commit, candidate identity, container digest, deployment version, gate outcomes, and sanitized smoke status.

## Operational decision

A single workflow file with explicit build and deploy modes is preferred over duplicated workflows. It keeps shared pins and validation in one reviewed location while preserving the mandatory offline signing boundary between runs.

Local container builds are deliberately excluded because the development machine has insufficient disk capacity. Automatic rollback by resource deletion is also excluded; safe retry through convergent provisioning preserves evidence and data while maintaining zero public exposure.
