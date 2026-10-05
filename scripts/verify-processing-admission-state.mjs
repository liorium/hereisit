import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postD1Query } from "./apply-worker-version-attestations.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
} from "./image-lab-common.mjs";

const accountIdPattern = /^[0-9a-f]{32}$/;
const databaseIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const versionIdPattern = databaseIdPattern;
const epochPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export const processingAdmissionStateSql = `WITH target AS (
  SELECT control.*,
         CASE
           WHEN control.last_sealed_hour_key IS NULL
             THEN CAST((control.cost_accounting_started_at + 3599999) / 3600000 AS INTEGER)
           ELSE control.last_sealed_hour_key + 1
         END AS target_hour_key
  FROM rollout_control AS control
  WHERE control.id = 1
)
SELECT
  EXISTS (
    SELECT 1 FROM operational_alert_state
    WHERE kind IN ('accounting-degraded','accounting-recovered') AND active = 1
      AND (last_sent_at IS NULL OR (kind = 'accounting-degraded' AND last_sent_at <= ? - 86400000))
  ) AS alertPending,
  control.safety_generation AS safetyGeneration,
  health.epoch AS accountingHealthEpoch,
  health.status AS accountingStatus,
  health.reason AS accountingReason,
  health.evaluated_at AS accountingEvaluatedAt,
  health.pending_hour_key AS pendingHourKey,
  health.unresolved_since_hour_key AS unresolvedSinceHourKey,
  control.circuit_open AS circuitOpen,
  control.reason AS circuitReason,
  control.deletion_overdue_count AS deletionOverdueCount,
  (SELECT COUNT(*) FROM jobs WHERE status IN ('created','uploaded','queued','running')) AS activeJobs,
  (SELECT COUNT(*) FROM job_outbox WHERE sent_at IS NULL) AS unsentOutbox,
  (SELECT COUNT(*) FROM worker_version_attestations WHERE kind = 'active') AS activeAttestationCount,
  active.version_id AS activeVersionId,
  active.public_admission_allowed AS publicAdmissionAllowed,
  control.cost_accounting_epoch AS costAccountingEpoch,
  control.cost_accounting_started_at AS costAccountingStartedAt,
  control.last_sealed_hour_key AS lastSealedHourKey,
  control.target_hour_key AS targetHourKey,
  CASE WHEN cost.hour_key IS NULL THEN 0 ELSE 1 END AS targetCostRowPresent,
  COALESCE(cost.provider_worker_usage_complete, 0) AS targetProviderWorkerUsageComplete,
  COALESCE(cost.provider_container_usage_complete, 0) AS targetProviderContainerUsageComplete,
  COALESCE(cost.analytics_engine_usage_complete, 0) AS targetAnalyticsUsageComplete,
  COALESCE(cost.provider_usage_complete, 0) AS targetProviderUsageComplete,
  COALESCE(cost.complete, 0) AS targetComplete,
  CASE WHEN observation.hour_key IS NULL THEN 0 ELSE 1 END AS targetUsageObservationCount,
  COALESCE(observation.matching_observation_count, 0) AS targetUsageObservationMatches,
  active.release_report_sha256 AS releaseReportSha256
FROM target AS control
LEFT JOIN accounting_health AS health ON health.id = 1
LEFT JOIN worker_version_attestations AS active ON active.kind = 'active'
LEFT JOIN operational_cost_hourly AS cost
  ON cost.accounting_epoch = control.cost_accounting_epoch
 AND cost.hour_key = control.target_hour_key
LEFT JOIN usage_log_hour_observations AS observation
  ON observation.accounting_epoch = control.cost_accounting_epoch
 AND observation.hour_key = control.target_hour_key`;

const disableSql = `UPDATE rollout_control
SET circuit_open = 1,
    reason = CASE WHEN circuit_open = 1 AND reason <> 'COST_ACCOUNTING_INCOMPLETE' THEN reason ELSE 'OPERATOR_DISABLED' END,
    opened_at = CASE WHEN circuit_open = 1 AND reason <> 'COST_ACCOUNTING_INCOMPLETE' THEN opened_at ELSE ? END,
    safety_generation = safety_generation + 1,
    last_evaluated_at = ?
WHERE id = 1
  AND EXISTS (
    SELECT 1 FROM worker_version_attestations
    WHERE kind = 'active'
      AND version_id = ?
      AND release_report_sha256 = ?
      AND public_admission_allowed = 1
  )`;

function validateCoordinates({ accountId, databaseId, apiToken, fetchImpl }) {
  if (typeof accountId !== "string" || !accountIdPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (typeof databaseId !== "string" || !databaseIdPattern.test(databaseId)) {
    throw new TypeError("Cloudflare D1 database ID is invalid");
  }
  if (typeof apiToken !== "string" || apiToken.length === 0) {
    throw new TypeError("Cloudflare D1 API token is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
}

function validateStateRow(value) {
  const row = assertObject(value, "processing admission state");
  assertExactKeys(
    row,
    [
      "alertPending",
      "safetyGeneration",
      "accountingHealthEpoch",
      "accountingStatus",
      "accountingReason",
      "accountingEvaluatedAt",
      "pendingHourKey",
      "unresolvedSinceHourKey",
      "circuitOpen",
      "circuitReason",
      "deletionOverdueCount",
      "activeJobs",
      "unsentOutbox",
      "activeAttestationCount",
      "activeVersionId",
      "publicAdmissionAllowed",
      "costAccountingEpoch",
      "costAccountingStartedAt",
      "lastSealedHourKey",
      "targetHourKey",
      "targetCostRowPresent",
      "targetProviderWorkerUsageComplete",
      "targetProviderContainerUsageComplete",
      "targetAnalyticsUsageComplete",
      "targetProviderUsageComplete",
      "targetComplete",
      "targetUsageObservationCount",
      "targetUsageObservationMatches",
      "releaseReportSha256",
    ],
    "processing admission state",
  );
  for (const name of [
    "safetyGeneration",
    "accountingEvaluatedAt",
    "circuitOpen",
    "deletionOverdueCount",
    "activeJobs",
    "unsentOutbox",
    "activeAttestationCount",
    "publicAdmissionAllowed",
    "targetCostRowPresent",
    "targetProviderWorkerUsageComplete",
    "targetProviderContainerUsageComplete",
    "targetAnalyticsUsageComplete",
    "targetProviderUsageComplete",
    "targetComplete",
  ]) {
    if (!Number.isSafeInteger(row[name]) || row[name] < 0) {
      throw new TypeError(`processing admission ${name} is invalid`);
    }
  }
  for (const name of [
    "alertPending",
    "circuitOpen",
    "publicAdmissionAllowed",
    "targetCostRowPresent",
    "targetProviderWorkerUsageComplete",
    "targetProviderContainerUsageComplete",
    "targetAnalyticsUsageComplete",
    "targetProviderUsageComplete",
    "targetComplete",
  ]) {
    if (![0, 1].includes(row[name])) {
      throw new TypeError("processing admission boolean state is invalid");
    }
  }
  for (const name of [
    "costAccountingStartedAt",
    "targetHourKey",
    "targetUsageObservationCount",
    "targetUsageObservationMatches",
  ]) {
    if (!Number.isSafeInteger(row[name]) || row[name] < 0) {
      throw new TypeError(`processing admission ${name} is invalid`);
    }
  }
  if (
    row.lastSealedHourKey !== null &&
    (!Number.isSafeInteger(row.lastSealedHourKey) || row.lastSealedHourKey < 0)
  ) {
    throw new TypeError("processing admission lastSealedHourKey is invalid");
  }
  if (
    !["unknown", "degraded", "healthy"].includes(row.accountingStatus) ||
    typeof row.accountingHealthEpoch !== "string" ||
    !epochPattern.test(row.accountingHealthEpoch) ||
    (row.accountingReason !== null &&
      ![
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_SAMPLED",
        "ACCOUNTING_DELAY",
        "HISTORICAL_GAP",
        "SAFETY_CONFLICT",
      ].includes(row.accountingReason))
  ) {
    throw new TypeError("processing accounting health is invalid");
  }
  for (const name of ["pendingHourKey", "unresolvedSinceHourKey"]) {
    if (row[name] !== null && (!Number.isSafeInteger(row[name]) || row[name] < 0)) {
      throw new TypeError("processing accounting gap is invalid");
    }
  }
  if (
    row.accountingStatus === "healthy" &&
    (row.accountingReason !== null ||
      row.pendingHourKey !== null ||
      row.unresolvedSinceHourKey !== null)
  ) {
    throw new TypeError("processing accounting health is inconsistent");
  }
  const firstHourKey = Math.ceil(row.costAccountingStartedAt / 3_600_000);
  if (
    row.targetHourKey !==
    (row.lastSealedHourKey === null ? firstHourKey : row.lastSealedHourKey + 1)
  ) {
    throw new TypeError("processing admission target hour is inconsistent");
  }
  if (row.targetUsageObservationCount > 1) {
    throw new TypeError("processing admission boolean state is invalid");
  }
  if (
    row.circuitReason !== null &&
    (typeof row.circuitReason !== "string" ||
      row.circuitReason.length < 1 ||
      row.circuitReason.length > 128)
  ) {
    throw new TypeError("processing admission circuit reason is invalid");
  }
  if (typeof row.activeVersionId !== "string" || !versionIdPattern.test(row.activeVersionId)) {
    throw new TypeError("processing admission active version is invalid");
  }
  if (typeof row.costAccountingEpoch !== "string" || !epochPattern.test(row.costAccountingEpoch)) {
    throw new TypeError("processing admission cost accounting epoch is invalid");
  }
  assertSha256(row.releaseReportSha256, "processing admission release report hash");
  return row;
}

function requireSingleStateRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new TypeError("processing admission query must return exactly one row");
  }
  return validateStateRow(rows[0]);
}

function verifyExpectedRelease(row, expectedVersionId, expectedReleaseReportSha256) {
  if (row.activeAttestationCount !== 1 || row.activeVersionId !== expectedVersionId) {
    throw new TypeError("processing admission active Worker version does not match");
  }
  if (row.publicAdmissionAllowed !== 1) {
    throw new TypeError("processing admission active Worker version is not admissible");
  }
  if (row.releaseReportSha256 !== expectedReleaseReportSha256) {
    throw new TypeError("processing admission release report hash does not match");
  }
}

function validateExpectedRelease(expectedVersionId, expectedReleaseReportSha256) {
  if (typeof expectedVersionId !== "string" || !versionIdPattern.test(expectedVersionId)) {
    throw new TypeError("expected active Worker version ID is invalid");
  }
  assertSha256(expectedReleaseReportSha256, "expected release report hash");
}

export function verifyProcessingAdmissionState({
  rows,
  expectedVersionId,
  expectedReleaseReportSha256,
}) {
  validateExpectedRelease(expectedVersionId, expectedReleaseReportSha256);
  const row = requireSingleStateRow(rows);
  verifyExpectedRelease(row, expectedVersionId, expectedReleaseReportSha256);
  if (row.circuitOpen !== 0 || row.circuitReason !== null) {
    throw new Error("processing admission circuit is open");
  }
  if (row.deletionOverdueCount !== 0 || row.activeJobs !== 0 || row.unsentOutbox !== 0) {
    throw new Error("processing admission has unfinished operational work");
  }
  if (row.costAccountingEpoch === "uninitialized") {
    throw new Error("processing admission cost accounting epoch is uninitialized");
  }
  return {
    ready: true,
    activeVersionId: row.activeVersionId,
    costAccountingEpoch: row.costAccountingEpoch,
  };
}

function d1Url(accountId, databaseId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

function parseCanonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new TypeError("processing admission --now must be a canonical timestamp");
  }
  return Date.parse(value);
}

async function readStateRows({ accountId, databaseId, apiToken, fetchImpl, now = Date.now() }) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new TypeError("processing admission inspection time is invalid");
  let result;
  try {
    [result] = await postD1Query({
      url: d1Url(accountId, databaseId),
      apiToken,
      body: { sql: processingAdmissionStateSql, params: [now] },
      expectedCount: 1,
      fetchImpl,
    });
  } catch {
    throw new Error(
      "processing admission inspection unavailable; verify migration 0011_accounting_health.sql and primary D1 access",
    );
  }
  return result.results;
}

export async function inspectCurrentProcessingAdmissionInD1(input) {
  const values = { fetchImpl: fetch, now: Date.now(), ...input };
  validateCoordinates(values);
  const row = requireSingleStateRow(await readStateRows(values));
  return {
    admissionAvailable: row.circuitOpen === 0 && row.publicAdmissionAllowed === 1,
    accountingHealthy:
      row.accountingStatus === "healthy" &&
      row.accountingHealthEpoch === row.costAccountingEpoch &&
      row.accountingEvaluatedAt >= values.now - 15 * 60_000 &&
      row.accountingEvaluatedAt <= values.now,
    alertPending: row.alertPending === 1,
    safetyGeneration: row.safetyGeneration,
    accountingStatus: row.accountingStatus,
    accountingReason: row.accountingReason,
    accountingEvaluatedAt: row.accountingEvaluatedAt,
    pendingHourKey: row.pendingHourKey,
    unresolvedSinceHourKey: row.unresolvedSinceHourKey,
    circuitOpen: row.circuitOpen === 1,
    circuitReason: row.circuitReason,
    deletionOverdueCount: row.deletionOverdueCount,
    activeJobs: row.activeJobs,
    unsentOutbox: row.unsentOutbox,
    activeVersionId: row.activeVersionId,
    publicAdmissionAllowed: row.publicAdmissionAllowed === 1,
    costAccountingEpoch: row.costAccountingEpoch,
    costAccountingStartedAt: row.costAccountingStartedAt,
    lastSealedHourKey: row.lastSealedHourKey,
    targetHourKey: row.targetHourKey,
    targetCostRowPresent: row.targetCostRowPresent === 1,
    targetProviderWorkerUsageComplete: row.targetProviderWorkerUsageComplete === 1,
    targetProviderContainerUsageComplete: row.targetProviderContainerUsageComplete === 1,
    targetAnalyticsUsageComplete: row.targetAnalyticsUsageComplete === 1,
    targetProviderUsageComplete: row.targetProviderUsageComplete === 1,
    targetComplete: row.targetComplete === 1,
    targetUsageObservationCount: row.targetUsageObservationCount,
    targetUsageObservationMatches: row.targetUsageObservationMatches,
    releaseReportSha256: row.releaseReportSha256,
  };
}

export async function readProcessingAdmissionStateFromD1(input) {
  const values = { fetchImpl: fetch, ...input };
  validateCoordinates(values);
  return verifyProcessingAdmissionState({
    rows: await readStateRows(values),
    expectedVersionId: values.expectedVersionId,
    expectedReleaseReportSha256: values.expectedReleaseReportSha256,
  });
}

export async function disableProcessingAdmissionInD1(input) {
  const values = { fetchImpl: fetch, ...input };
  validateCoordinates(values);
  if (!Number.isSafeInteger(values.now) || values.now < 0) {
    throw new TypeError("processing admission disable time is invalid");
  }
  validateExpectedRelease(values.expectedVersionId, values.expectedReleaseReportSha256);
  verifyExpectedRelease(
    requireSingleStateRow(await readStateRows(values)),
    values.expectedVersionId,
    values.expectedReleaseReportSha256,
  );
  const [update] = await postD1Query({
    url: d1Url(values.accountId, values.databaseId),
    apiToken: values.apiToken,
    body: {
      sql: disableSql,
      params: [
        values.now,
        values.now,
        values.expectedVersionId,
        values.expectedReleaseReportSha256,
      ],
    },
    expectedCount: 1,
    fetchImpl: values.fetchImpl,
  });
  const row = requireSingleStateRow(await readStateRows(values));
  verifyExpectedRelease(row, values.expectedVersionId, values.expectedReleaseReportSha256);
  if (
    ![1, 2].includes(update.meta.changes) ||
    row.circuitOpen !== 1 ||
    row.circuitReason === null
  ) {
    throw new Error("processing admission circuit did not open over a valid active release");
  }
  return { disabled: true, circuitOpen: true };
}

// The caller must hold the protected deployment lock with public admission closed.
// A pre-migration reason alone is not proof that no hard incident was hidden behind it.
export async function rearmAccountingOnlyCircuitInD1(input) {
  const values = { fetchImpl: fetch, ...input };
  validateCoordinates(values);
  validateExpectedRelease(values.expectedVersionId, values.expectedReleaseReportSha256);
  if (!epochPattern.test(values.expectedEpoch ?? "") || values.expectedEpoch === "uninitialized") {
    throw new TypeError("expected accounting epoch is invalid");
  }
  for (const name of ["expectedSafetyGeneration", "now"]) {
    if (!Number.isSafeInteger(values[name]) || values[name] < 0) {
      throw new TypeError(`processing admission ${name} is invalid`);
    }
  }
  const statements = [
    {
      sql: `WITH expected(version, report, epoch, generation, now, fresh) AS (VALUES (?, ?, ?, ?, ?, ?))
UPDATE rollout_control AS control
SET circuit_open = 0, reason = NULL, opened_at = NULL, manual_reset_at = (SELECT now FROM expected)
WHERE id = 1
  AND circuit_open = 1 AND reason = 'COST_ACCOUNTING_INCOMPLETE'
  AND cost_accounting_epoch = (SELECT epoch FROM expected)
  AND safety_generation = (SELECT generation FROM expected)
  AND opened_at IS NOT NULL AND opened_at <= (SELECT now FROM expected)
  AND safety_history_started_at > 0 AND safety_history_started_at <= opened_at
  AND (SELECT COUNT(*) FROM safety_incidents) = safety_generation
  AND NOT EXISTS (SELECT 1 FROM safety_incidents WHERE recorded_at >= control.opened_at)
  AND deletion_overdue_count = 0
  AND deletion_sweep_started_at IS NOT NULL
  AND deletion_sweep_completed_at >= deletion_sweep_started_at
  AND deletion_sweep_completed_at BETWEEN (SELECT fresh FROM expected) AND (SELECT now FROM expected)
  AND (SELECT COUNT(*) FROM worker_version_attestations WHERE kind = 'active') = 1
  AND EXISTS (
    SELECT 1 FROM worker_version_attestations
    WHERE kind = 'active' AND public_admission_allowed = 1
      AND version_id = (SELECT version FROM expected)
      AND release_report_sha256 = (SELECT report FROM expected)
  )
  AND EXISTS (
    SELECT 1 FROM accounting_health
    WHERE id = 1 AND epoch = control.cost_accounting_epoch
      AND (reason IS NULL OR reason IN ('PROVIDER_UNAVAILABLE','PROVIDER_SAMPLED','ACCOUNTING_DELAY','HISTORICAL_GAP'))
  )
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE status NOT IN ('succeeded','failed','cancelled','expired'))
  AND NOT EXISTS (SELECT 1 FROM job_outbox WHERE sent_at IS NULL OR sent_at < 0 OR sent_at > (SELECT now FROM expected))
  AND NOT EXISTS (SELECT 1 FROM job_quarantine WHERE inspected_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM artifact_cleanup_tombstones)
  AND NOT EXISTS (SELECT 1 FROM jobs WHERE error_code = 'VERIFICATION_FAILED')
  AND NOT EXISTS (
    SELECT 1 FROM jobs
    WHERE (queued_at IS NOT NULL AND (queued_at < created_at OR queued_at > finished_at OR queued_at > (SELECT now FROM expected)))
      OR (started_at IS NOT NULL AND (queued_at IS NULL OR started_at < queued_at OR started_at > finished_at))
      OR finished_at IS NULL OR finished_at < created_at OR finished_at > (SELECT now FROM expected)
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs AS job LEFT JOIN usage_ledger AS ledger ON ledger.job_id = job.id
    WHERE ledger.job_id IS NULL OR job.settlement_state <> 'settled'
      OR ledger.settled_at IS NULL OR ledger.actual_units IS NULL OR job.actual_units IS NULL
      OR ledger.actual_units <> job.actual_units OR ledger.actual_units < 0
      OR ledger.reserved_units <> job.reserved_units OR ledger.session_hash <> job.session_hash
      OR ledger.day_key <> job.day_key OR ledger.outcome IS NOT job.status
      OR ledger.network_hash IS NOT job.network_hash
  )
  AND NOT EXISTS (SELECT 1 FROM account_usage WHERE pending_jobs <> 0 OR reserved_units <> 0)
  AND NOT EXISTS (SELECT 1 FROM anonymous_usage WHERE active_jobs <> 0 OR reserved_units <> 0)
  AND NOT EXISTS (SELECT 1 FROM network_usage WHERE pending_jobs <> 0 OR reserved_units <> 0)`,
      params: [
        values.expectedVersionId,
        values.expectedReleaseReportSha256,
        values.expectedEpoch,
        values.expectedSafetyGeneration,
        values.now,
        Math.max(0, values.now - 15 * 60_000),
      ],
    },
    {
      sql: `INSERT INTO maintenance_cursors (task, cursor, updated_at)
SELECT 'accounting-only-rearm', ?, ? WHERE changes() = 1
ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      params: [
        canonicalJson({
          versionId: values.expectedVersionId,
          releaseReportSha256: values.expectedReleaseReportSha256,
          epoch: values.expectedEpoch,
          safetyGeneration: values.expectedSafetyGeneration,
        }),
        values.now,
      ],
    },
  ];
  const results = await postD1Query({
    url: d1Url(values.accountId, values.databaseId),
    apiToken: values.apiToken,
    body: { batch: statements },
    expectedCount: statements.length,
    fetchImpl: values.fetchImpl,
  });
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("accounting-only rearm prerequisite or historical safety proof is missing");
  }
  const row = requireSingleStateRow(await readStateRows(values));
  verifyExpectedRelease(row, values.expectedVersionId, values.expectedReleaseReportSha256);
  if (
    row.circuitOpen !== 0 ||
    row.circuitReason !== null ||
    row.costAccountingEpoch !== values.expectedEpoch ||
    row.safetyGeneration !== values.expectedSafetyGeneration
  ) {
    throw new Error("accounting-only rearm state changed after guarded transition");
  }
  return { rearmed: true };
}

export async function disableCurrentProcessingAdmissionInD1(input) {
  const values = { fetchImpl: fetch, ...input };
  validateCoordinates(values);
  const row = requireSingleStateRow(await readStateRows(values));
  if (row.activeAttestationCount !== 1 || row.publicAdmissionAllowed !== 1) {
    throw new Error("processing admission current release is not admissible");
  }
  return disableProcessingAdmissionInD1({
    ...values,
    expectedVersionId: row.activeVersionId,
    expectedReleaseReportSha256: row.releaseReportSha256,
  });
}

export async function runProcessingAdmissionStateCli(
  argv,
  { env = process.env, fetchImpl = fetch, stdout = process.stdout } = {},
) {
  const args = parseCliArguments(argv);
  if (!["verify", "inspect-current", "disable", "disable-current"].includes(args.mode)) {
    throw new TypeError(
      "processing admission --mode must be verify, inspect-current, disable, or disable-current",
    );
  }
  const base = ["mode", "account-id", "database-id"];
  const expectedRelease = ["expected-version-id", "expected-release-report-sha256"];
  const expected =
    args.mode === "verify"
      ? [...base, ...expectedRelease]
      : args.mode === "inspect-current"
        ? base
        : args.mode === "disable"
          ? [...base, ...expectedRelease, "now"]
          : [...base, "now"];
  assertExactKeys(args, expected, "processing admission arguments");
  if (!env.CLOUDFLARE_D1_API_TOKEN) {
    throw new TypeError("CLOUDFLARE_D1_API_TOKEN environment variable is required");
  }
  const input = {
    accountId: args["account-id"],
    databaseId: args["database-id"],
    apiToken: env.CLOUDFLARE_D1_API_TOKEN,
    expectedVersionId: args["expected-version-id"],
    expectedReleaseReportSha256: args["expected-release-report-sha256"],
    fetchImpl,
  };
  const result =
    args.mode === "verify"
      ? await readProcessingAdmissionStateFromD1(input)
      : args.mode === "inspect-current"
        ? await inspectCurrentProcessingAdmissionInD1({
            accountId: input.accountId,
            databaseId: input.databaseId,
            apiToken: input.apiToken,
            fetchImpl,
          })
        : args.mode === "disable"
          ? await disableProcessingAdmissionInD1({
              ...input,
              now: parseCanonicalTimestamp(args.now),
            })
          : await disableCurrentProcessingAdmissionInD1({
              accountId: input.accountId,
              databaseId: input.databaseId,
              apiToken: input.apiToken,
              fetchImpl,
              now: parseCanonicalTimestamp(args.now),
            });
  stdout.write(canonicalJson(result));
  return result;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingAdmissionStateCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "processing admission state command failed"}\n`,
    );
    process.exitCode = 1;
  }
}
