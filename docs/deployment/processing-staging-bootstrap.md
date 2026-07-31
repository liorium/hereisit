# Processing staging deployment

`.github/workflows/processing-staging.yml` deploys the exact successful `main` CI commit. There is no
release tag, offline key, or manual build/deploy dispatch. Public processing rollout remains zero and
the DLQ remains paused.

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
v4 whose SHA-256 appears in the JSON hash allowlist. Both abuse secrets must be canonical 32-byte
base64url values. The workflow validates these values without printing them.

In the existing `hereisit` Pages project, disable automatic production deployments and set preview
branch deployments to `None`. The workflow owns the `processing-staging` preview alias.

Run `Processing staging preflight` once from `main` after changing any environment variable, secret, or
Cloudflare token. Port `8976` is only for local interactive Wrangler OAuth; GitHub Actions uses API
tokens and does not need port forwarding.

## Automatic deployment

1. Merge reviewed code to `main`.
2. GitHub runs `CI` for that push.
3. Only a successful `CI` push from `liorium/hereisit` starts `Processing staging`.
4. The deploy workflow checks out and verifies the exact successful CI SHA.
5. It validates the protected environment, builds the linux/amd64 engine, Worker, staging web, and
   versioned cost model.
6. It pushes the engine, checks the registry config digest, and resolves the immutable Cloudflare image
   digest.
7. It converges D1, R2, Analytics Engine, Logpush, Queue, and DLQ resources with both queues paused.
8. It deploys the rollout-zero bootstrap Worker, resolves the Container application, installs and
   verifies Worker secrets, deploys the final Worker, and records its D1 version attestation.
9. For a new attested release, it starts a fresh cost-accounting epoch at the next UTC hour while both
   Queues and public rollout remain closed. The guarded write refuses active jobs, overdue deletion, or
   a non-accounting circuit reason, and a same-release retry cannot reopen a later circuit.
10. It deploys and verifies the `processing-staging` Pages alias.
11. It resumes only the primary Queue, verifies the DLQ stayed paused, and runs the authenticated direct
    download compression smoke.

If any step after the primary Queue resume attempt fails, cleanup pauses it again and verifies both
queues are paused.

## Versioned cost policy

`processing-staging-cost-input.json` is the checked-in staging pricing and workload baseline. Changes to
it use the same pull-request and CI path as code. Staging rollout is zero; review current provider prices,
measured route CPU data, and production ceilings before enabling any production admission.

## Outputs

A successful deployment retains only these sanitized artifacts for seven days:

- `source-sha.txt`
- `cloudflare-image-digest.txt`
- `worker-version.json`
- `gate-results.json`
- `smoke-result.json`

Production will follow the same successful-push pattern after its separate Cloudflare resources and
GitHub environment exist. Before provisioning anything, configure `processing-production` with the same
common variables and secrets listed above, replace the six `STAGING_` secrets with matching
`PRODUCTION_` names, and run `Processing production preflight` from `main`. This check is read-only and
does not deploy or create billable resources. Keep GitHub environment approval as the only manual
production gate.
