# Apply Worker version attestations

For the complete first-deployment order, including resource convergence, rollout-zero Container
bootstrap, provider-scope discovery, and Queue resume verification, follow
[`processing-staging-bootstrap.md`](processing-staging-bootstrap.md).

Apply the D1 migrations before recording a deployment. The application command verifies that
`0002_worker_version_attestations.sql` is present in the remote `d1_migrations` table and stops before
all writes when it is absent.

Provide the narrowly scoped D1 write token through a masked environment variable. Never pass it as a
command-line argument.

```bash
export CLOUDFLARE_D1_API_TOKEN="${MASKED_DEPLOYMENT_SECRET}"

node scripts/apply-worker-version-attestations.mjs \
  --attestation .artifacts/staging-worker-version-attestations.json \
  --account-id "${CLOUDFLARE_ACCOUNT_ID}" \
  --database-id "${STAGING_D1_DATABASE_ID}"
```

The command accepts a versioned attestation file of at most 64 KiB, validates it before contacting
Cloudflare, applies one D1 batch, and then reads the persisted state and artifact hashes back from the
primary. A successful run prints only a content-free summary:

```json
{"applied":true,"statements":6,"verificationQueries":2}
```

The statement count is seven when an earlier active Worker version is retired. Do not retry a failed
write automatically; inspect the generic error, query the attestation state, and rerun the same sealed
attestation only after the failure mode is understood.

## Reusable staging gate

`.github/workflows/apply-processing-staging-attestation.yml` is the protected staging entry point. It
accepts artifacts only from a `main` workflow in `liorium/hereisit`, requires approval through the
`processing-staging` GitHub environment, verifies the reviewed attestation and Wrangler-config hashes,
applies remote migrations, and only then records the Worker attestation.

The downloaded artifact must contain these fixed deployment inputs at its root:

- `worker-version-attestation.json`
- `wrangler.staging.jsonc`

Call the gate from the trusted staging workflow after uploading those sealed files:

```yaml
jobs:
  apply-staging-attestation:
    uses: ./.github/workflows/apply-processing-staging-attestation.yml
    with:
      artifact_name: processing-staging-attestation
      attestation_sha256: ${{ needs.deploy.outputs.attestation_sha256 }}
      wrangler_config_sha256: ${{ needs.deploy.outputs.wrangler_config_sha256 }}
      database_name: hereisit-processing-staging
      database_id: ${{ needs.provision.outputs.database_id }}
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_D1_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}
```

Set the non-secret `CLOUDFLARE_ACCOUNT_ID` once as a `processing-staging` environment variable. The
workflow reads it from `vars` and keeps only authentication material in GitHub environment secrets.
Keep the Wrangler token limited to the permissions required for remote D1 migrations. Keep the direct
D1 token limited to D1 read/write for the single deployment account; neither token is accepted through
command-line input.
