# Image processing deployment

Releases contain one native image engine, the Worker, and the staging and production web archives.
Candidate, release-report, and release-asset contracts are version 3. Exact archive identities, signed
review evidence, application licenses, Trivy and native Grype scans, cost accounting, staging canaries,
rollback verification, and the separate image admission gate remain required.

PDF processing is retired. New image releases must not build a PDF engine, create PDF queues, or request
PDF benchmark/browser evidence. Canary deployment report version 2 cannot authorize public admission;
image admission remains a separate verified operation.

## Runtime cost accounting

Worker request counts, CPU time, and handler version provenance come from immutable, complete Logpush
objects, not sampled Analytics Engine points. No minimum customer traffic is required: a complete empty
hour is valid. Missing logs or version provenance remain incomplete, not zero usage. Migration 0010
allows legacy provenance to be backfilled only by replaying an identical original object.

The runtime no longer queries Analytics Engine for accounting. It budgets at most two analytics writes
per handler invocation (usage plus optional product telemetry); this is a conservative cost bound, not
an exact analytics-write count. Historical cost snapshots are not rewritten. Attested versions with the
same module and release can contribute to a canary/public transition hour without resetting accounting.
Attestation observation and retirement timestamps are not invocation validity intervals.
Deploy through the normal release workflow, which starts a release-bound accounting epoch. Do not
hot-patch an old epoch: its verified Analytics-based snapshots use different write/read accounting.

Configured cost ceilings constrain release estimates and admission configuration. They are not a
Cloudflare invoice cap: a live budget-overrun evaluator is not currently wired into the runtime.

## Existing deployment retirement

Before deploying across the retirement boundary, pause the old PDF primary queue and DLQ and reject new
PDF admissions. Confirm existing jobs are terminal and input/output objects have been deleted through
the bounded cleanup path. Preserve historical usage and billing reconciliation through their retention
window. Inventory exact queue/container IDs before deletion; never delete shared image resources.
Retain Durable Object migration history; apply the explicit retired-class migration only after drain.
Repository changes and image resource provisioning do not delete existing remote resources.

## Release reviews

CI produces image receipts from the full native corpus and actual Playwright JSON results in the
same run, bound to the source archive and production engine digest. Downloaded outputs are decoded
and checked again using the existing live quality, alpha, dimension and lossless policies. Pinned
SSIMULACRA2 and Butteraugli measurements are retained for performance comparisons; no competitor
parity is claimed. A reduced PR benchmark cannot authorize a release. Native cost estimates are not
provider usage receipts: live cost accounting and the separate public-admission checks still apply.

Human ratings and manual review counts are not release requirements. Automated visual quality
measurements remain required. The legacy `blindedHumanReview` evidence key is retained for contract
compatibility, but its payload is `hereisit-automated-visual-review@2`: automated measurements, not a
human approval step.

Five image-applicable review checks remain required and fail closed: full native corpus quality,
automated visual quality, commercial licenses, privacy, and the browser/device matrix. iLoveIMG and
other competitor comparisons are separate performance metrics, not deployment requirements. The
`competitorComparison` evidence entry and `--competitor-comparison` bundle argument are optional;
when supplied, their strict validation and hash bindings still apply. Existing six-report evidence
remains accepted. No comparison receipt is fabricated when it is absent.

Removed PDF review outputs are not image evidence. Until genuine exact-source image review receipts
exist for every required check, report the missing evidence and do not publish a release authority or
fabricate passes. Native quality, automated visual quality, licenses, privacy, device coverage,
security, and cost accounting remain required.
