# Apply Worker version attestations

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
