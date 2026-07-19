# Processing staging bootstrap

This runbook is the canonical first-deployment sequence for the server image-compression stack. It
keeps public admission at zero, creates private resources with paused Queue delivery, discovers the
Cloudflare Container application created by the first Worker deployment, and only then enables active
provider cost accounting.

Run it only from a protected `processing-staging` deployment environment at a reviewed commit. Keep all
tokens and secrets in masked environment variables; none of them belong in command-line arguments,
artifacts, logs, or the repository.

## Required environment

The deployment environment must provide:

- `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` for Workers, Containers, D1,
  R2, Queues, and Pages;
- `CLOUDFLARE_LOGPUSH_API_TOKEN`, limited to Logs configuration;
- `LOGPUSH_R2_ACCESS_KEY_ID` and `LOGPUSH_R2_SECRET_ACCESS_KEY`, limited to the staging usage bucket;
- `STAGING_ANALYTICS_READ_TOKEN` and `STAGING_LOGPUSH_STATUS_TOKEN`, both read-only and
  product-scoped;
- `STAGING_ABUSE_HMAC_SECRET_CURRENT` and `STAGING_ABUSE_HMAC_SECRET_PREVIOUS`, each a 32-byte
  base64url secret;
- `STAGING_MAINTAINER_HASHES_JSON`, a non-empty JSON array of SHA-256 session hashes;
- `ALERT_DESTINATION_ADDRESS`, already verified in Cloudflare Email Routing.

The finalized release-candidate job must also have restored `.artifacts/candidate`, set `ENGINE_IMAGE`
to the immutable same-account `registry.cloudflare.com/...@sha256:...` image, and exported the signed
candidate limits and hashes used below.

## 1. Provision and seal provider resources

Use a fresh output path. The provisioner deliberately refuses to overwrite an earlier sealed manifest.

```bash
set -euo pipefail
umask 077

export ENVIRONMENT=staging
export WORKER_SCRIPT_NAME=hereisit-processing-staging
export D1_NAME=hereisit-processing-staging
export BUCKET_NAME=hereisit-processing-staging
export USAGE_LOG_BUCKET_NAME=hereisit-processing-usage-staging
export USAGE_ANALYTICS_DATASET_NAME=hereisit_processing_usage_staging
export QUEUE_NAME=hereisit-image-jobs-staging
export DLQ_NAME=hereisit-image-jobs-dlq-staging
export PROVISION_MANIFEST=.artifacts/resources-provision-staging.json

test ! -e "$PROVISION_MANIFEST"
node scripts/ensure-cloudflare-processing-resources.mjs \
  --phase provision \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --environment "$ENVIRONMENT" \
  --location apac \
  --bucket-name "$BUCKET_NAME" \
  --usage-log-bucket-name "$USAGE_LOG_BUCKET_NAME" \
  --usage-analytics-dataset-name "$USAGE_ANALYTICS_DATASET_NAME" \
  --worker-script-name "$WORKER_SCRIPT_NAME" \
  --database-name "$D1_NAME" \
  --queue-name "$QUEUE_NAME" \
  --dlq-name "$DLQ_NAME" \
  --output "$PROVISION_MANIFEST"

export STAGING_D1_DATABASE_ID="$(node scripts/read-processing-provision-manifest.mjs \
  --file "$PROVISION_MANIFEST" --field d1.databaseId)"
export STAGING_LOGPUSH_JOB_ID="$(node scripts/read-processing-provision-manifest.mjs \
  --file "$PROVISION_MANIFEST" --field logpush.jobId)"
```

This step converges and then re-reads the exact account-scoped D1, private R2 lifecycle policies,
paused primary/DLQ Queues, Analytics Engine dataset name, and unsampled Workers Trace Events Logpush
job. A name collision or policy mismatch stops the deployment.

## 2. Generate the rollout-zero bootstrap config

The all-zero UUID is accepted only with `bootstrap` cost accounting and rollout zero. It is not a
provider identifier and cannot be used by an active config.

```bash
export BOOTSTRAP_CONTAINER_APPLICATION_ID=00000000-0000-4000-8000-000000000000

generate_staging_config() {
  node scripts/generate-processing-wrangler.mjs \
    --environment staging \
    --account-id "$CLOUDFLARE_ACCOUNT_ID" \
    --database-id "$STAGING_D1_DATABASE_ID" \
    --app-origin http://127.0.0.1:4173 \
    --app-origin http://localhost:4173 \
    --app-origin https://processing-staging.hereisit.pages.dev \
    --bucket-name "$BUCKET_NAME" \
    --usage-log-bucket-name "$USAGE_LOG_BUCKET_NAME" \
    --usage-analytics-dataset-name "$USAGE_ANALYTICS_DATASET_NAME" \
    --cost-accounting-mode "$1" \
    --logpush-job-id "$STAGING_LOGPUSH_JOB_ID" \
    --container-application-id "$2" \
    --queue-name "$QUEUE_NAME" \
    --dlq-name "$DLQ_NAME" \
    --engine-image "$ENGINE_IMAGE" \
    --account-daily-weighted-unit-limit 80000000000 \
    --anonymous-daily-weighted-unit-limit 8000000000 \
    --network-daily-weighted-unit-limit 24000000000 \
    --account-pending-job-limit 10 \
    --network-pending-job-limit 3 \
    --maximum-queued-age-seconds 600 \
    --max-live-median-output-ratio-bps "$CANDIDATE_MAX_MEDIAN_OUTPUT_RATIO_BPS" \
    --max-live-p95-weighted-units "$CANDIDATE_MAX_P95_WEIGHTED_UNITS" \
    --max-live-original-retained-rate-bps "$CANDIDATE_MAX_ORIGINAL_RETAINED_RATE_BPS" \
    --max-live-cost-per-1000-microusd "$CANDIDATE_MAX_COST_PER_1000_MICROUSD" \
    --max-projected-monthly-cost-microusd "$CANDIDATE_MAX_PROJECTED_MONTHLY_COST_MICROUSD" \
    --live-cost-model .artifacts/candidate/live-cost-model.json \
    --live-cost-model-sha256 "$CANDIDATE_LIVE_COST_MODEL_SHA256" \
    --provider-usage-schema-sha256 "$CANDIDATE_PROVIDER_USAGE_SCHEMA_SHA256" \
    --release-report-sha256 "$CANDIDATE_RELEASE_REPORT_SHA256" \
    --session-rate-limit-namespace-id 21001 \
    --network-rate-limit-namespace-id 21002 \
    --job-read-rate-limit-namespace-id 21003 \
    --result-download-rate-limit-namespace-id 21004 \
    --policy-rate-limit-namespace-id 21005 \
    --job-api-network-rate-limit-namespace-id 21006 \
    --alert-destination-address "$ALERT_DESTINATION_ADDRESS" \
    --maintainer-session-hashes-json "$STAGING_MAINTAINER_HASHES_JSON" \
    --rollout-percent 0
}

generate_staging_config bootstrap "$BOOTSTRAP_CONTAINER_APPLICATION_ID"
```

## 3. Deploy once and resolve the Container provider scope

The first deployment creates the Cloudflare Container application. Queue delivery remains paused.

```bash
export WRANGLER_CONFIG=.wrangler/generated/wrangler.staging.jsonc
export WORKER_MODULE=.artifacts/candidate/api-worker/worker.mjs

pnpm exec wrangler d1 migrations apply "$D1_NAME" \
  --config "$WRANGLER_CONFIG" --remote
pnpm exec wrangler deploy "$WORKER_MODULE" \
  --config "$WRANGLER_CONFIG" --no-bundle --dry-run
pnpm exec wrangler deploy "$WORKER_MODULE" \
  --config "$WRANGLER_CONFIG" --no-bundle --containers-rollout=immediate

pnpm exec wrangler containers list --json \
  > .artifacts/cloudflare-containers-staging.json
export STAGING_CONTAINER_APPLICATION_ID="$(node \
  scripts/resolve-cloudflare-container-application.mjs \
  --input .artifacts/cloudflare-containers-staging.json \
  --output .artifacts/container-provider-scope-staging.json \
  --environment staging \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --worker-script-name "$WORKER_SCRIPT_NAME" \
  --engine-image "$ENGINE_IMAGE" \
  --observed-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)")"

generate_staging_config active "$STAGING_CONTAINER_APPLICATION_ID"
```

The resolver accepts exactly one expected application, the immutable release image, and a healthy
provider state. The regenerated config rejects the bootstrap UUID in `active` mode.

## 4. Install Worker secrets and record the active config

Supply every value through standard input. The final explicit deployment is the one used for version
attestation and smoke evidence.

```bash
printf '%s' "$STAGING_ABUSE_HMAC_SECRET_PREVIOUS" | \
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_PREVIOUS --config "$WRANGLER_CONFIG"
printf '%s' "$STAGING_ABUSE_HMAC_SECRET_CURRENT" | \
  pnpm exec wrangler secret put ABUSE_HMAC_SECRET_CURRENT --config "$WRANGLER_CONFIG"
printf '%s' "$STAGING_ANALYTICS_READ_TOKEN" | \
  pnpm exec wrangler secret put ANALYTICS_READ_TOKEN --config "$WRANGLER_CONFIG"
printf '%s' "$STAGING_LOGPUSH_STATUS_TOKEN" | \
  pnpm exec wrangler secret put LOGPUSH_STATUS_TOKEN --config "$WRANGLER_CONFIG"

pnpm exec wrangler secret list --config "$WRANGLER_CONFIG" --format json \
  > .artifacts/wrangler-staging-secrets.json
node scripts/verify-worker-secret-list.mjs \
  --file .artifacts/wrangler-staging-secrets.json

: > .artifacts/wrangler-staging.ndjson
WRANGLER_OUTPUT_FILE_PATH=.artifacts/wrangler-staging.ndjson \
pnpm exec wrangler deploy "$WORKER_MODULE" \
  --config "$WRANGLER_CONFIG" --no-bundle --containers-rollout=none
```

Run the version-chain verifier and protected D1 attestation gate described in
`apply-worker-version-attestations.md` before allowing a job to leave the browser.

## 5. Resume and verify Queue delivery

Resume only after migrations, the active cost-accounting config, all secrets, and the Worker version
attestation have succeeded. A failure before this point leaves both Queues safely paused.

```bash
pnpm exec wrangler queues resume-delivery "$QUEUE_NAME"
pnpm exec wrangler queues resume-delivery "$DLQ_NAME"

node scripts/verify-queue-delivery-state.mjs \
  --queue "$QUEUE_NAME" --expected resumed --account-id "$CLOUDFLARE_ACCOUNT_ID"
node scripts/verify-queue-delivery-state.mjs \
  --queue "$DLQ_NAME" --expected resumed --account-id "$CLOUDFLARE_ACCOUNT_ID"
```

Now run the telemetry-only probe, authenticated staging end-to-end smoke, retention sweeps, hourly
provider reconciliation, and the 24-hour observation gate. Public rollout remains zero throughout
staging. Any provider mismatch, stale cost hour, circuit opening, retention miss, or smoke failure pauses
both Queues again and prevents production promotion.
