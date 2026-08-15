import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postD1Query } from "./apply-worker-version-attestations.mjs";
import { parseCliArguments } from "./image-lab-common.mjs";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const DATABASE_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EPOCH_PATTERN = /^[0-9a-f]{32}$/;
const HOUR_MILLISECONDS = 3_600_000;
const PUBLIC_ADMISSION_REARM_MODE = "public-admission-rearm";

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireRow(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("staging accounting epoch verification row is invalid");
  }
  return value;
}

function readChanges(result) {
  const changes = result?.meta?.changes;
  if (!Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
    throw new TypeError("staging accounting epoch write count is invalid");
  }
  return changes;
}

export async function rotateStagingAccountingEpoch({
  accountId,
  databaseId,
  apiToken,
  releaseReportSha256,
  mode = "release",
  now = Date.now(),
  fetchImpl = fetch,
}) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (typeof databaseId !== "string" || !DATABASE_ID_PATTERN.test(databaseId)) {
    throw new TypeError("Cloudflare D1 database ID is invalid");
  }
  if (typeof apiToken !== "string" || apiToken.length === 0) {
    throw new TypeError("Cloudflare D1 API token is required");
  }
  if (typeof releaseReportSha256 !== "string" || !SHA256_PATTERN.test(releaseReportSha256)) {
    throw new TypeError("release report SHA-256 is invalid");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (mode !== "release" && mode !== PUBLIC_ADMISSION_REARM_MODE) {
    throw new TypeError("cost accounting epoch rotation mode is invalid");
  }
  requireInteger(now, "rotation time");
  const accountingStartedAt = (Math.floor(now / HOUR_MILLISECONDS) + 1) * HOUR_MILLISECONDS;
  const staleCutoff = Math.max(0, now - 2 * HOUR_MILLISECONDS);
  requireInteger(accountingStartedAt, "accounting start time");
  requireInteger(staleCutoff, "stale accounting cutoff");
  const accountingEpoch = randomBytes(16).toString("hex");
  const markerTask =
    mode === PUBLIC_ADMISSION_REARM_MODE
      ? "cost-accounting-public-admission"
      : "cost-accounting-release";
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const statements = [
    {
      sql: `UPDATE rollout_control
SET cost_accounting_epoch = ?,
    cost_accounting_started_at = ?,
    first_admitted_at = NULL,
    last_sealed_hour_key = NULL,
    last_cost_evaluated_hour_key = NULL,
    last_cost_window_complete = 0,
    cost_breach_count = 0,
    cost_breach_window_started_at = NULL,
    last_cost_per_1000_microusd = NULL,
    last_projected_monthly_cost_microusd = NULL,
    circuit_open = 0,
    reason = NULL,
    opened_at = NULL,
    manual_reset_at = ?
WHERE id = 1
  AND deletion_overdue_count = 0
  ${mode === PUBLIC_ADMISSION_REARM_MODE ? "AND last_sealed_hour_key IS NULL\n  AND cost_accounting_started_at <= ?" : ""}
  AND (circuit_open = 0 OR reason IN (
    'COST_ACCOUNTING_INCOMPLETE',
    'COST_ACCOUNTING_HASH_MISMATCH',
    'PROVIDER_USAGE_UNATTESTED_VERSION',
    'OPERATOR_DISABLED'
  ))
  AND NOT EXISTS (
    SELECT 1 FROM jobs
    WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')
  )
  AND EXISTS (
    SELECT 1 FROM worker_version_attestations
    WHERE kind = 'active' AND release_report_sha256 = ?
  )
  AND NOT EXISTS (
    SELECT 1 FROM maintenance_cursors
    WHERE task = ? AND cursor = ?
  )`,
      params: [
        accountingEpoch,
        accountingStartedAt,
        now,
        ...(mode === PUBLIC_ADMISSION_REARM_MODE ? [staleCutoff] : []),
        releaseReportSha256,
        markerTask,
        releaseReportSha256,
      ],
    },
    {
      sql: `INSERT INTO maintenance_cursors (task, cursor, updated_at)
SELECT ?, ?, ?
WHERE changes() = 1
ON CONFLICT(task) DO UPDATE SET
  cursor = excluded.cursor,
  updated_at = excluded.updated_at`,
      params: [markerTask, releaseReportSha256, now],
    },
  ];
  const writes = await postD1Query({
    url,
    apiToken,
    body: { batch: statements },
    expectedCount: statements.length,
    fetchImpl,
  });
  const rotated = readChanges(writes[0]) === 1;
  const markerChanged = readChanges(writes[1]) === 1;
  if (rotated !== markerChanged) {
    throw new Error("staging accounting epoch marker did not converge");
  }

  const verificationSql = `SELECT
  control.cost_accounting_epoch AS accountingEpoch,
  control.cost_accounting_started_at AS accountingStartedAt,
  control.circuit_open AS circuitOpen,
  control.reason AS reason,
  control.opened_at AS openedAt,
  control.manual_reset_at AS manualResetAt,
  control.last_sealed_hour_key AS lastSealedHourKey,
  marker.cursor AS releaseMarker,
  (
    SELECT COUNT(*) FROM worker_version_attestations
    WHERE kind = 'active' AND release_report_sha256 = ?
  ) AS activeReleaseCount,
  (
    SELECT COUNT(*) FROM jobs
    WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')
  ) AS nonterminalJobCount,
  control.deletion_overdue_count AS deletionOverdueCount
FROM rollout_control AS control
LEFT JOIN maintenance_cursors AS marker ON marker.task = ?
WHERE control.id = 1`;
  const [verification] = await postD1Query({
    url,
    apiToken,
    body: { sql: verificationSql, params: [releaseReportSha256, markerTask] },
    expectedCount: 1,
    fetchImpl,
  });
  const row = requireRow(verification.results[0]);
  const lastSealedHourKeyValid =
    row.lastSealedHourKey === null ||
    (Number.isSafeInteger(row.lastSealedHourKey) && row.lastSealedHourKey >= 0);
  const staleUnsealed = row.lastSealedHourKey === null && row.accountingStartedAt <= staleCutoff;
  const markerConverged =
    mode === PUBLIC_ADMISSION_REARM_MODE
      ? !staleUnsealed
      : row.releaseMarker === releaseReportSha256;
  const commonConverged =
    EPOCH_PATTERN.test(row.accountingEpoch) &&
    Number.isSafeInteger(row.accountingStartedAt) &&
    lastSealedHourKeyValid &&
    markerConverged &&
    row.activeReleaseCount === 1 &&
    row.nonterminalJobCount === 0 &&
    row.deletionOverdueCount === 0;
  const rotationConverged =
    !rotated ||
    (row.accountingEpoch === accountingEpoch &&
      row.accountingStartedAt === accountingStartedAt &&
      row.circuitOpen === 0 &&
      row.reason === null &&
      row.openedAt === null &&
      row.manualResetAt === now);
  if (!commonConverged || !rotationConverged) {
    throw new Error("staging accounting epoch guard did not converge");
  }
  return {
    rotated,
    accountingEpoch: row.accountingEpoch,
    accountingStartedAt: row.accountingStartedAt,
    circuitOpen: row.circuitOpen === 1,
  };
}

export async function runRotateStagingAccountingEpochCli(argv, { env = process.env } = {}) {
  const args = parseCliArguments(argv);
  const required = new Set(["account-id", "database-id", "release-report-sha256"]);
  const allowed = new Set([...required, "mode"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError("unknown staging accounting epoch argument");
  }
  for (const name of required) {
    if (args[name] === undefined) throw new TypeError(`--${name} is required`);
  }
  if (typeof env.CLOUDFLARE_D1_API_TOKEN !== "string" || env.CLOUDFLARE_D1_API_TOKEN.length === 0) {
    throw new TypeError("CLOUDFLARE_D1_API_TOKEN environment variable is required");
  }
  return rotateStagingAccountingEpoch({
    accountId: args["account-id"],
    databaseId: args["database-id"],
    apiToken: env.CLOUDFLARE_D1_API_TOKEN,
    releaseReportSha256: args["release-report-sha256"],
    mode: args.mode ?? "release",
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await runRotateStagingAccountingEpochCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "staging accounting epoch rotation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
