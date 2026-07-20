# Processing staging workflow design

## Purpose

Create a repeatable GitHub Actions path that builds and validates the processing container, publishes it by immutable digest, and deploys the Cloudflare processing stack to staging without depending on local disk or Docker.

Success means a maintainer can manually start one workflow from `main` and receive either:

- a verified, maintainer-only staging deployment with non-secret evidence; or
- a failed run that leaves public rollout at zero and queues paused.

## Scope

The workflow will:

1. Validate the selected source revision and deployment inputs.
2. Build, test, license-check, and vulnerability-scan the image engine.
3. Push the image to Cloudflare and resolve its immutable SHA-256 digest.
4. Create and finalize a verified release candidate with the existing release scripts.
5. Convergently provision the required D1, R2, Queue, and Worker resources.
6. Deploy with public server processing disabled and queues paused.
7. Run an authenticated maintainer smoke test.
8. Upload non-secret deployment evidence as a GitHub Actions artifact.

This design does not enable public server processing, resume queues, deploy production, or add a separate build service.

## Architecture

The workflow is a manually dispatched GitHub Actions workflow restricted to `main` and protected by the existing `processing-staging` GitHub environment. It runs as one sequential job in a fresh Ubuntu runner so build outputs and verified candidate inputs never cross an untrusted artifact boundary.

The repository's existing candidate, resource, Wrangler generation, image-digest, and verification scripts remain the source of truth. The workflow only orchestrates them and supplies sealed inputs through environment variables or standard input.

The local development machine is used only for authentication and status inspection. Container compilation, scanning, publication, and staging deployment happen on the ephemeral GitHub runner.

## Workflow sequence

1. Check out the exact `main` commit selected by the manual dispatch and reject a revision that is not reachable from `origin/main`.
2. Install the repository's pinned Node and pnpm versions, restore safe dependency caches, and install locked dependencies.
3. Run the processing server unit and integration checks, dependency-license validation, and container build.
4. Scan the built image with the repository's pinned scanner and policy. Any reportable vulnerability or policy failure stops the run before publication.
5. Authenticate to Cloudflare using GitHub environment secrets, publish the image, and resolve the registry result to a SHA-256 digest. Deployment configuration must reference that digest, never a mutable tag.
6. Assemble the required candidate assets and call the existing candidate creation, verification, and finalization scripts.
7. Provision or reconcile Cloudflare resources with the existing resource script. Existing correctly configured resources are reused.
8. Generate Wrangler configuration from the finalized candidate and deploy with public rollout set to zero and queues paused.
9. Run the maintainer-authenticated staging smoke test against the deployed Worker.
10. Upload the candidate manifest, deployment version, scan summary, and smoke result as a non-secret evidence artifact.

## Safety and failure behavior

Every step fails closed. A failure stops subsequent steps, keeps public server processing disabled, and leaves queues paused. The workflow does not automatically delete D1, R2, Queue, registry, or Worker resources because deletion can destroy diagnostic state or retained data.

Resource provisioning and deployment commands must be convergent so a rerun can safely reuse completed state. A runner interruption after resource creation is therefore recovered by rerunning the same workflow.

Secrets are read only from the `processing-staging` environment and passed through masked environment variables or standard input. Secret values, file contents, filenames, thumbnails, presigned URLs, and user payloads must never appear in logs or artifacts.

The staging Worker accepts server-processing traffic only from the configured maintainer session. Public users continue to use browser-local processing because rollout remains at zero.

## Verification and evidence

Pre-deployment gates are:

- sealed input and source-revision validation;
- server unit and integration tests;
- dependency-license policy validation;
- container vulnerability scanning;
- candidate asset and identity verification;
- immutable image digest resolution.

Post-deployment verification is one authenticated maintainer smoke path that proves request admission, queue submission, processing completion, and result retrieval without exposing payload data in evidence.

The workflow artifact contains only machine-readable, non-secret evidence needed to reproduce the release decision: source commit, candidate identity, container digest, deployment version, gate outcomes, and sanitized smoke status.

## Operational decision

A single workflow is preferred over separate build and deploy workflows. It avoids transporting unsigned intermediate artifacts, reduces configuration and retention surface, and keeps the candidate's build-to-deploy identity in one runner lifecycle.

Local container builds are deliberately excluded because the development machine has insufficient disk capacity. Automatic rollback by resource deletion is also excluded; safe retry through convergent provisioning preserves evidence and data while maintaining zero public exposure.
