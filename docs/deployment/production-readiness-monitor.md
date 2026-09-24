# Production readiness monitor

`Production readiness monitor` runs on `main` hourly (minute 17) and can be started manually
from GitHub Actions. Scheduled runs may be delayed by GitHub; this is not a real-time uptime SLA.
It uses no Cloudflare credentials and does not deploy, upload files, create processing jobs,
change admission, or apply security exceptions. No new dependency is installed in the product.

The check requests the home page, image compression page, `/health?requireJobs=1`, and the
anonymous `image.optimize@1` policy. A healthy API alone is insufficient: public server
admission must also be available with the existing upload/deletion disclosure contract.
Responses are bounded by a 10-second timeout and JSON bodies by 64 KiB. Logs contain only
fixed check names, HTTP statuses, and validated reason codes, not raw bodies or request IDs.

Run locally with the existing workspace dependencies:

```sh
node scripts/check-production-health.mjs
```

Exit 0 means all four checks passed; exit 1 means at least one failed. GitHub Actions records
a failed run and a per-check summary. Email or mobile notifications depend on the repository
watch and Actions notification settings of the operator; this workflow does not configure them.

| Result | Next action |
| --- | --- |
| `REQUEST_FAILED` or `HTTP_ERROR` | Check DNS/network, Cloudflare status, and the exact failed endpoint. |
| `INVALID_RESPONSE` | Check stalled/truncated bodies, routing/content type, and contract drift; do not log the raw response. |
| `JOBS_UNAVAILABLE` | Inspect the deployed Worker configuration and release state. |
| `SERVER_PROCESSING_DISABLED` or `LOCAL_FALLBACK_REQUIRED` | Inspect public admission, circuit-breaker/accounting evidence, and the release security check. Do not bypass them. |
| `UNEXPECTED_MAINTAINER_POLICY` | Investigate why a fresh anonymous caller was classified as a maintainer. |

A deliberate server shutdown still produces a failed readiness run: it must not look like a
working server compression service. Other local-browser tools may remain operational.
This monitor does **not** prove compression quality, queue delivery, cost reconciliation,
input/result deletion, browser interaction, or authorization to deploy. Existing CI browser
tests, release evidence, and hosted processing smoke checks remain responsible for those.
