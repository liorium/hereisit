# Processing staging deployment

`.github/workflows/processing-staging.yml` is the canonical staging build and deployment procedure.
Run it only from `liorium/hereisit` on `main`. The workflow keeps public admission at zero and leaves
the DLQ paused.

## One-time Cloudflare and GitHub setup

Create the protected GitHub environment `processing-staging`. Add these environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `ALERT_DESTINATION_ADDRESS`

Add these environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_API_TOKEN`
- `CLOUDFLARE_LOGPUSH_API_TOKEN`
- `LOGPUSH_R2_ACCESS_KEY_ID`
- `LOGPUSH_R2_SECRET_ACCESS_KEY`
- `STAGING_ANALYTICS_READ_TOKEN`
- `STAGING_LOGPUSH_STATUS_TOKEN`
- `STAGING_ABUSE_HMAC_SECRET_CURRENT`
- `STAGING_ABUSE_HMAC_SECRET_PREVIOUS`
- `STAGING_MAINTAINER_SESSION_ID`
- `STAGING_MAINTAINER_HASHES_JSON`

Use least-privilege tokens for their named products. The maintainer session ID must be a canonical UUID
v4, and its SHA-256 must appear in the JSON hash allowlist. The two abuse secrets must each be canonical
32-byte base64url values. The deployment validator checks all values without printing them.

In the existing `hereisit` Pages project, disable automatic production deployments and set preview
branch deployments to `None`. This prevents a Git-integrated build from replacing the reviewed Pages
artifact. The workflow owns the `processing-staging` preview alias.

Port `8976` is used only for an interactive Wrangler OAuth callback when a developer logs in locally.
GitHub Actions uses API tokens and does not open, forward, or depend on port `8976`.

## Release and deploy

1. Create the committed processing release-input document and its immutable annotated tag. The release
   commit must have exactly one parent and change only
   `docs/deployment/releases/<release-id>/processing-release-inputs.json`.
   `baseSourceSha256` is SHA-256 of that sole parent commit's lowercase 40-character Git SHA bytes with
   no trailing newline.
2. Dispatch build mode:

   ```bash
   gh workflow run processing-staging.yml \
     --ref main \
     -f mode=build \
     -f release_tag=processing-release-YYYY-MM-DD.N
   ```

3. Review the content-free evidence, sign it outside GitHub Actions, finalize the exact built candidate,
   and publish the complete finalized asset namespace under the annotated release tag. Do not rebuild
   any artifact while finalizing.
4. Dispatch deploy mode with the same tag:

   ```bash
   gh workflow run processing-staging.yml \
     --ref main \
     -f mode=deploy \
     -f release_tag=processing-release-YYYY-MM-DD.N
   ```

The `verify-release` job has no Cloudflare environment. It resolves the immutable release namespace,
hashes every release asset, verifies the finalized candidate and report, verifies the detached Ed25519
signature, and publishes a digest-bound same-run handoff.

The protected `deploy` job then performs this order:

1. Download the exact artifact ID with the pinned native action into an unused directory. Independently
   query and download that same ID through the GitHub API, binding repository, current run, head SHA,
   name, artifact ID, and SHA-256 before safe extraction.
2. Install the frozen lockfile, validate the sealed deployment environment, and reverify the finalized
   candidate. Read only allowlisted candidate fields. Read all five operating ceilings through the
   hash-bound release-input reader.
3. Load the verified Docker archive, tag and push that exact image through Wrangler, inspect the remote
   manifest, and resolve the immutable same-account `registry.cloudflare.com/...@sha256:...` identity.
4. Converge private D1, R2, Analytics Engine, Logpush, primary Queue, and DLQ resources. Both queues are
   paused by the provision contract.
5. Generate a bootstrap Wrangler config with the all-zero Container application ID, bootstrap cost
   accounting, and rollout zero. Dry-run it, apply D1 migrations, and capture the pre-deploy Worker
   version list.
6. Query D1 primary state for the previous active Worker version. An empty attestation table is the only
   first-deploy case. Otherwise exactly one active, publicly admissible, non-retired UUID must exist in
   the pre-deploy version list. There is no operator-supplied previous-version variable.
7. Deploy the bootstrap Worker, resolve the one healthy Container application, regenerate the active
   rollout-zero config, and capture its byte witness before changing any Worker secret.
8. Put the four Worker secrets over standard input, verify the secret list, perform the explicit final
   deployment, validate the six-version transition, and apply its attestation to D1 primary state.
9. Safely extract the signed staging Pages archive, deploy it to branch `processing-staging`, verify the
   structured Wrangler result, verify the stable Pages alias, and verify the final Worker target equals
   the signed staging API origin.
10. Verify the attestation and final config bytes, then install Chromium while queues remain paused.
11. Resume only `hereisit-image-jobs-staging`; verify it is resumed and
    `hereisit-image-jobs-dlq-staging` is still paused. Run the authenticated browser compression smoke.

If any step after primary delivery resumes fails, cleanup pauses the primary Queue again and verifies
both queues are paused. The DLQ is never resumed by this workflow.

## Outputs and success criteria

A successful deployment uploads only these sanitized files for seven days:

- `.artifacts/deployment/processing-candidate-identity.json`
- `.artifacts/deployment/cloudflare-image-digest.txt`
- `.artifacts/deployment/worker-version.json`
- `.artifacts/deployment/gate-results.json`
- `.artifacts/deployment/smoke-result.json`

Success means the Worker and Pages bytes match the signed candidate, public rollout remains zero, the
Worker version attestation is persisted, the primary Queue is resumed, the DLQ remains paused, the
stable Pages alias points at the new deployment, and the authenticated direct-download smoke passes.
