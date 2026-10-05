import { postD1Query } from "./apply-worker-version-attestations.mjs";
import { canonicalJson } from "./image-lab-common.mjs";
import { readProcessingAdmissionStateFromD1 } from "./verify-processing-admission-state.mjs";

export const legacyRecoveryAcknowledgement = "ACCEPT UNKNOWN LEGACY SAFETY COST AND STORAGE WRITES";
const receiptTask = "legacy-accounting-recovery";
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Called only by an explicitly acknowledged protected manual deployment; never by automatic rearm.
export async function recoverLegacyAccountingCircuitInD1(input) {
  const {
    accountId,
    databaseId,
    apiToken,
    expectedVersionId,
    expectedReleaseReportSha256,
    expectedEpoch,
    expectedSafetyGeneration,
    now,
    maximumLiveCostPer1000Microusd,
    maximumProjectedMonthlyCostMicrousd,
    authorization,
    fetchImpl = fetch,
  } = input;
  if (
    !/^[0-9a-f]{32}$/.test(accountId ?? "") ||
    !uuid.test(databaseId ?? "") ||
    !uuid.test(expectedVersionId ?? "") ||
    !hash.test(expectedReleaseReportSha256 ?? "") ||
    !/^[0-9a-f]{32}$/.test(expectedEpoch ?? "") ||
    typeof apiToken !== "string" ||
    !apiToken ||
    !integer(now) ||
    expectedSafetyGeneration !== 0 ||
    !integer(maximumLiveCostPer1000Microusd) ||
    maximumLiveCostPer1000Microusd === 0 ||
    !integer(maximumProjectedMonthlyCostMicrousd) ||
    maximumProjectedMonthlyCostMicrousd === 0
  )
    throw new TypeError("legacy recovery coordinates or safety limits are invalid");
  if (
    authorization?.acknowledgement !== legacyRecoveryAcknowledgement ||
    !Number.isSafeInteger(Date.parse(authorization.expiresAt ?? "")) ||
    Date.parse(authorization.expiresAt) <= now ||
    Date.parse(authorization.expiresAt) - now > 6 * 60 * 60_000 ||
    authorization.eventName !== "workflow_dispatch" ||
    authorization.repository !== "liorium/hereisit" ||
    !["processing-staging", "processing-production"].includes(authorization.environment) ||
    !/^[0-9a-f]{40}$/.test(authorization.sourceSha ?? "") ||
    !/^[1-9][0-9]*$/.test(authorization.runId ?? "") ||
    !/^[1-9][0-9]*$/.test(authorization.runAttempt ?? "") ||
    !/^[A-Za-z0-9-]{1,39}$/.test(authorization.actor ?? "")
  )
    throw new TypeError("explicit protected manual legacy recovery authorization is required");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const [snapshot] = await postD1Query({
    url,
    apiToken,
    fetchImpl,
    expectedCount: 1,
    body: {
      sql: `SELECT opened_at AS openedAt, deletion_sweep_generation AS auditGeneration,
      (SELECT cursor FROM maintenance_cursors WHERE task='empty-state-audit') AS audit
      FROM rollout_control WHERE id=1`,
      params: [],
    },
  });
  const before = snapshot.results[0];
  if (
    snapshot.results.length !== 1 ||
    !integer(before?.openedAt) ||
    !integer(before?.auditGeneration) ||
    typeof before?.audit !== "string"
  )
    throw new Error("fresh empty-state audit is required for legacy recovery");
  const audit = JSON.parse(before.audit);
  const receipt = canonicalJson({
    schema: "hereisit-legacy-accounting-recovery@1",
    authorization,
    versionId: expectedVersionId,
    releaseReportSha256: expectedReleaseReportSha256,
    epoch: expectedEpoch,
    safetyGeneration: expectedSafetyGeneration,
    originalReason: "COST_ACCOUNTING_INCOMPLETE",
    originalOpenedAt: before.openedAt,
    historicalSafetyUnknown: true,
    historicalCostUnknown: true,
    legacyStorageWritesUnknown: true,
    audit,
    recoveredAt: now,
  });
  const statements = [
    {
      sql: `WITH expected(version,report,epoch,generation,now,fresh,opened,auditGeneration,audit,maxUnitCost,maxMonthlyCost,expiresAt) AS (VALUES (?,?,?,?,?,?,?,?,?,?,?,?))
UPDATE rollout_control AS control
SET circuit_open=0, reason=NULL, opened_at=NULL, manual_reset_at=(SELECT now FROM expected)
WHERE id=1 AND circuit_open=1 AND reason='COST_ACCOUNTING_INCOMPLETE'
  AND unixepoch() * 1000 + 1000 < (SELECT expiresAt FROM expected)
  AND opened_at=(SELECT opened FROM expected) AND opened_at <= (SELECT now FROM expected)
  AND safety_generation=(SELECT generation FROM expected) AND safety_generation=0
  AND safety_history_started_at=0 AND NOT EXISTS (SELECT 1 FROM safety_incidents)
  AND cost_accounting_epoch=(SELECT epoch FROM expected)
  AND cost_breach_count=0 AND cost_breach_window_started_at IS NULL
  AND traffic_breach_count=0 AND traffic_breach_reason IS NULL AND traffic_breach_window_started_at IS NULL
  AND (last_cost_per_1000_microusd IS NULL OR last_cost_per_1000_microusd <= (SELECT maxUnitCost FROM expected))
  AND (last_projected_monthly_cost_microusd IS NULL OR last_projected_monthly_cost_microusd <= (SELECT maxMonthlyCost FROM expected))
  AND NOT EXISTS (SELECT 1 FROM operational_alert_state WHERE active=1 AND kind NOT IN ('accounting-degraded','accounting-recovered'))
  AND EXISTS (SELECT 1 FROM worker_version_attestations WHERE kind='active' AND public_admission_allowed=1
    AND version_id=(SELECT version FROM expected) AND release_report_sha256=(SELECT report FROM expected))
  AND EXISTS (SELECT 1 FROM accounting_health WHERE id=1 AND epoch=control.cost_accounting_epoch
    AND (reason IS NULL OR reason IN ('PROVIDER_UNAVAILABLE','PROVIDER_SAMPLED','ACCOUNTING_DELAY','HISTORICAL_GAP')))
  AND NOT EXISTS (SELECT 1 FROM jobs) AND NOT EXISTS (SELECT 1 FROM usage_ledger)
  AND NOT EXISTS (SELECT 1 FROM job_outbox) AND NOT EXISTS (SELECT 1 FROM job_quarantine)
  AND NOT EXISTS (SELECT 1 FROM artifact_cleanup_tombstones)
  AND NOT EXISTS (SELECT 1 FROM account_usage WHERE pending_jobs<>0 OR reserved_units<>0 OR typeof(settled_units)<>'integer' OR settled_units NOT BETWEEN 0 AND 9007199254740991)
  AND NOT EXISTS (SELECT 1 FROM anonymous_usage WHERE active_jobs<>0 OR reserved_units<>0 OR typeof(settled_units)<>'integer' OR settled_units NOT BETWEEN 0 AND 9007199254740991)
  AND NOT EXISTS (SELECT 1 FROM network_usage WHERE pending_jobs<>0 OR reserved_units<>0 OR typeof(settled_units)<>'integer' OR settled_units NOT BETWEEN 0 AND 9007199254740991)
  AND deletion_overdue_count=0 AND deletion_sweep_generation=(SELECT auditGeneration FROM expected)
  AND deletion_sweep_started_at BETWEEN (SELECT fresh FROM expected) AND (SELECT now FROM expected)
  AND deletion_sweep_completed_at BETWEEN deletion_sweep_started_at AND (SELECT now FROM expected)
  AND EXISTS (SELECT 1 FROM maintenance_cursors WHERE task='empty-state-audit' AND cursor=(SELECT audit FROM expected)
    AND json_extract(cursor,'$.versionId')=(SELECT version FROM expected)
    AND json_extract(cursor,'$.releaseReportSha256')=(SELECT report FROM expected)
    AND json_extract(cursor,'$.epoch')=(SELECT epoch FROM expected)
    AND json_extract(cursor,'$.safetyGeneration')=(SELECT generation FROM expected)
    AND json_extract(cursor,'$.auditGeneration')=control.deletion_sweep_generation
    AND json_extract(cursor,'$.startedAt')=control.deletion_sweep_started_at
    AND json_extract(cursor,'$.completedAt')=control.deletion_sweep_completed_at)
  AND NOT EXISTS (SELECT 1 FROM maintenance_cursors WHERE task='legacy-accounting-recovery')`,
      params: [
        expectedVersionId,
        expectedReleaseReportSha256,
        expectedEpoch,
        expectedSafetyGeneration,
        now,
        Math.max(0, now - 15 * 60_000),
        before.openedAt,
        before.auditGeneration,
        before.audit,
        maximumLiveCostPer1000Microusd,
        maximumProjectedMonthlyCostMicrousd,
        Date.parse(authorization.expiresAt),
      ],
    },
    {
      sql: `INSERT INTO maintenance_cursors(task,cursor,updated_at)
      SELECT ?,?,? WHERE changes()=1`,
      params: [receiptTask, receipt, now],
    },
    {
      sql: `UPDATE accounting_health SET status='degraded',
      reason='HISTORICAL_GAP',
      unresolved_since_hour_key=(SELECT MIN(hour) FROM (SELECT unresolved_since_hour_key AS hour UNION ALL SELECT pending_hour_key UNION ALL SELECT ?)),
      evaluated_at=MAX(evaluated_at,?) WHERE id=1 AND changes()=1`,
      params: [Math.floor(before.openedAt / 3_600_000), now],
    },
  ];
  const results = await postD1Query({
    url,
    apiToken,
    fetchImpl,
    expectedCount: statements.length,
    body: { batch: statements },
  });
  if (results.some((result) => result.meta.changes !== 1))
    throw new Error(
      "legacy recovery blocked by changed state, missing audit, retained hard signal or consumed authority",
    );
  await readProcessingAdmissionStateFromD1(input);
  return {
    recovered: true,
    historicalSafetyUnknown: true,
    historicalCostUnknown: true,
    legacyStorageWritesUnknown: true,
  };
}

// A committed recovery may outlive a failed post-write read or artifact upload.
// Bind cleanup to the durable receipt, not to a local success marker or a queue step.
export async function closeFailedLegacyRecoveryInD1({
  accountId,
  databaseId,
  apiToken,
  runId,
  runAttempt,
  now,
  fetchImpl = fetch,
}) {
  if (
    !/^[0-9a-f]{32}$/.test(accountId ?? "") ||
    !uuid.test(databaseId ?? "") ||
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !/^[1-9][0-9]*$/.test(runAttempt ?? "") ||
    !integer(now)
  )
    throw new TypeError("legacy recovery failure coordinates are invalid");
  const [result] = await postD1Query({
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    apiToken,
    fetchImpl,
    expectedCount: 1,
    body: {
      sql: `UPDATE rollout_control AS control
SET circuit_open=1,reason='OPERATOR_DISABLED',opened_at=?,safety_generation=safety_generation+1
WHERE id=1 AND circuit_open=0 AND EXISTS (
  SELECT 1 FROM maintenance_cursors AS receipt JOIN worker_version_attestations AS active
    ON active.kind='active' AND active.version_id=json_extract(receipt.cursor,'$.versionId')
    AND active.release_report_sha256=json_extract(receipt.cursor,'$.releaseReportSha256')
  WHERE receipt.task='legacy-accounting-recovery'
    AND json_extract(receipt.cursor,'$.authorization.runId')=?
    AND json_extract(receipt.cursor,'$.authorization.runAttempt')=?
    AND json_extract(receipt.cursor,'$.epoch')=control.cost_accounting_epoch
    AND json_extract(receipt.cursor,'$.safetyGeneration')=control.safety_generation
)`,
      params: [now, runId, runAttempt],
    },
  });
  return { closed: [1, 2].includes(result.meta.changes) };
}
