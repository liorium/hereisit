# Image processing deployment

Releases contain one native image engine, the Worker, and the staging and production web archives.
Candidate, release-report, and release-asset contracts are version 3. Exact archive identities, signed
review evidence, application licenses, Trivy and native Grype scans, cost accounting, staging canaries,
rollback verification, and the separate image admission gate remain required.

PDF processing is retired. New image releases must not build a PDF engine, create PDF queues, or request
PDF benchmark/browser evidence. Canary deployment report version 2 cannot authorize public admission;
image admission remains a separate verified operation.

## Existing deployment retirement

Before deploying across the retirement boundary, pause the old PDF primary queue and DLQ and reject new
PDF admissions. Confirm existing jobs are terminal and input/output objects have been deleted through
the bounded cleanup path. Preserve historical usage and billing reconciliation through their retention
window. Inventory exact queue/container IDs before deletion; never delete shared image resources.
Retain Durable Object migration history; apply the explicit retired-class migration only after drain.
Repository changes and image resource provisioning do not delete existing remote resources.

## Release reviews

Human ratings and manual review counts are not release requirements. Automated visual quality
measurements remain required. The legacy `blindedHumanReview` evidence key is retained for contract
compatibility, but its payload is `hereisit-automated-visual-review@2`: automated measurements, not a
human approval step.

The six image-applicable review checks remain fail closed. Removed PDF review outputs are not image
evidence. Until genuine exact-source image review receipts exist, report the missing evidence and do not
publish a release authority or fabricate passes.
