# Proposed one-time recovery of a legacy accounting block

Status: **local policy-change proposal; not operator authorization**. No workflow
has been dispatched and no production circuit has been cleared by this change.
Automatic rearm still refuses missing historical safety evidence.

## Concrete operator decision

The protected staging and production deployment workflows now have an explicit
manual path. It requires an exact successful upstream run whose source SHA is
the current main workflow SHA, an
approval expiry no more than six hours ahead, and this typed acknowledgement:

`ACCEPT UNKNOWN LEGACY SAFETY COST AND STORAGE WRITES`

This authorizes one recovery of the exact legacy
`COST_ACCOUNTING_INCOMPLETE` circuit in that environment, **despite unknown past
safety incidents, unknown historical cost, and possible late legacy storage
writes**. It is an exception to the previous evidence-only recovery policy.
An operator must approve this concrete policy before any dispatch. A proposal,
audit result, or chat claiming an approval does not supply the authority.

Legacy writers could hide a later hard reason behind the accounting reason;
retained job records cannot reconstruct already-deleted history. A missing or
stale cost window remains unknown, never zero or proven below the limit.
An old upload or output write may still complete after the empty storage
snapshot. HTTP Worker requests have no general wall-duration limit, and the
local upload-source deadline does not prove that an R2 PUT already in progress
has settled. There is no claim of full quiescence or permanent deletion.

Every known retained hard incident, cost/traffic breach counter, stale known
above-limit cost estimate, active non-accounting alert or accounting integrity
conflict still blocks manual recovery. The acknowledgement does not authorize
clearing those signals, resetting quotas, erasing evidence, or public promotion.

## Smallest implemented audit

After ordinary job cleanup, orphan cleanup and circuit evaluation, the new
Worker audits only an **entirely empty stopped service**: no jobs, ledgers,
outbox, quarantine or cleanup tombstones; zero reservations/pending counts;
public rollout zero; its exact active Worker version and release attestation
observed at least fifteen minutes earlier. That interval uses the [documented scheduled and queue invocation limit](https://developers.cloudflare.com/workers/platform/limits/#duration);
it does not establish HTTP/R2 write quiescence.
An empty first R2 page with explicit end-of-list is a complete inventory of
objects visible at that moment. Nonempty storage or retained jobs leaves this
path blocked; ordinary retention and orphan cleanup continue.

A single guarded D1 batch records the observation timestamp, audit generation
and content-free release/epoch/safety-generation binding. It checks the same
empty D1 state again after the R2 read. New jobs, a changed release, epoch or
safety generation prevent recording the audit. The audit never clears the
circuit or claims historical safety. The timestamp is snapshot evidence only.

Late objects use the absent old job's keys; random new job IDs and ownership
checks are required to keep them out of new jobs and downloads. Existing
post-upload cleanup, orphan sweeps and storage lifecycle remain responsible for
late artifacts. Accepting this residual legacy risk is an explicit operator
choice, not a claim that an empty listing proves no future writes.

## Manual recovery and bootstrap order

1. Dispatch **Processing staging** on main with the exact successful push-triggered
   CI run and source SHA, expiry and acknowledgement. The workflow independently
   verifies the upstream run repository, event, branch, SHA, workflow path and
   success before using release credentials. It keeps the normal signed release
   and security gates, protected environment and deployment lock.
2. The normal release deployment leaves public rollout at zero. The new Worker
   produces the empty snapshot during scheduled maintenance. The manual path
   waits at most twenty-two minutes for matching fresh evidence; an absent audit
   fails without clearing admission. This wait is for evidence production, not
   an assertion that old requests have ended.
3. The separate recovery transaction rechecks the exact Worker/report, epoch,
   zero safety generation, original reason/opening time, audit generation and
   snapshot, empty D1 state, quota validity and all listed retained hard signals.
   A snapshot older than fifteen minutes is rejected. The transaction inserts
   one durable `legacy-accounting-recovery` receipt in `maintenance_cursors`;
   it never upserts that key. A second invocation is refused, including after
   a later canary failure. Normal maintenance does not remove this receipt.
4. Only the legacy circuit fields are cleared. Existing quotas, cost counters,
   historical costs, incident history and safety-history boundary remain intact.
   Accounting remains degraded with `HISTORICAL_GAP` and the earliest of its
   existing unresolved/pending hour and the original circuit's opening hour.
   The receipt records the actual GitHub run/attempt/actor, expiry and typed
   authority plus `historicalSafetyUnknown`, `historicalCostUnknown` and
   `legacyStorageWritesUnknown`.
5. Run the ordinary staging canary. Its successful artifact becomes the input
   for a separately acknowledged protected **Processing production** dispatch.
   Production repeats the same audit, guarded recovery and normal canary.
   Automatic production promotion does not accept manually triggered staging
   runs, so this recovery cannot silently cascade into a production exception.
6. Only the existing separate public promotion workflow and its public smoke can
   enable public server compression. Any canary failure uses the existing
   fail-closed rollback, preserving newer hard incidents. A successful recovery
   receipt remains consumed even if subsequent canary work fails.

The normal release epoch transition still happens before the snapshot. Recovery
itself neither rotates epochs nor changes limits; it cannot use that release
transition to claim that older costs disappeared. Known breach values and the
earliest unresolved gap survive the transition and remain recovery guards.

## Validation and limits

SQLite tests cover refused automatic/expired/missing authority, absent and stale
audits, wrong epochs, known expensive old cost estimates, safety conflicts,
unsettled quotas, new incident races, exact single-use receipt and preservation
of settled quotas and gaps. Worker integration tests exercise the audit against
real local D1 and R2, including nonempty storage and an incident during listing.
The scheduled order is checked before external provider reconciliation.

This is a reviewable implementation for a proposed exception, not a restoration
claim. Required operator approval must explicitly include the three uncertainties
above. If the operator declines, or any normal release gate or retained hard
signal fails, the service stays closed.
