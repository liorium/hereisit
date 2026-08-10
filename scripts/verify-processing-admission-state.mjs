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

export const processingAdmissionStateSql = `SELECT
  control.circuit_open AS circuitOpen,
  control.reason AS circuitReason,
  control.deletion_overdue_count AS deletionOverdueCount,
  (SELECT COUNT(*) FROM jobs WHERE status IN ('created','uploaded','queued','running')) AS activeJobs,
  (SELECT COUNT(*) FROM job_outbox WHERE sent_at IS NULL) AS unsentOutbox,
  (SELECT COUNT(*) FROM worker_version_attestations WHERE kind = 'active') AS activeAttestationCount,
  active.version_id AS activeVersionId,
  active.public_admission_allowed AS publicAdmissionAllowed,
  control.cost_accounting_epoch AS costAccountingEpoch,
  active.release_report_sha256 AS releaseReportSha256
FROM rollout_control AS control
LEFT JOIN worker_version_attestations AS active ON active.kind = 'active'
WHERE control.id = 1`;

const disableSql = `UPDATE rollout_control
SET circuit_open = 1,
    reason = CASE WHEN circuit_open = 1 THEN reason ELSE 'OPERATOR_DISABLED' END,
    opened_at = CASE WHEN circuit_open = 1 THEN opened_at ELSE ? END,
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
      "circuitOpen",
      "circuitReason",
      "deletionOverdueCount",
      "activeJobs",
      "unsentOutbox",
      "activeAttestationCount",
      "activeVersionId",
      "publicAdmissionAllowed",
      "costAccountingEpoch",
      "releaseReportSha256",
    ],
    "processing admission state",
  );
  for (const name of [
    "circuitOpen",
    "deletionOverdueCount",
    "activeJobs",
    "unsentOutbox",
    "activeAttestationCount",
    "publicAdmissionAllowed",
  ]) {
    if (!Number.isSafeInteger(row[name]) || row[name] < 0) {
      throw new TypeError(`processing admission ${name} is invalid`);
    }
  }
  if (![0, 1].includes(row.circuitOpen) || ![0, 1].includes(row.publicAdmissionAllowed)) {
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

async function readStateRows({ accountId, databaseId, apiToken, fetchImpl }) {
  const [result] = await postD1Query({
    url: d1Url(accountId, databaseId),
    apiToken,
    body: { sql: processingAdmissionStateSql, params: [] },
    expectedCount: 1,
    fetchImpl,
  });
  return result.results;
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
  if (update.meta.changes !== 1 || row.circuitOpen !== 1 || row.circuitReason === null) {
    throw new Error("processing admission circuit did not open over a valid active release");
  }
  return { disabled: true, circuitOpen: true };
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
  if (!["verify", "disable", "disable-current"].includes(args.mode)) {
    throw new TypeError("processing admission --mode must be verify, disable, or disable-current");
  }
  const base = ["mode", "account-id", "database-id"];
  const expectedRelease = ["expected-version-id", "expected-release-report-sha256"];
  const expected =
    args.mode === "verify"
      ? [...base, ...expectedRelease]
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
      : args.mode === "disable"
        ? await disableProcessingAdmissionInD1({ ...input, now: parseCanonicalTimestamp(args.now) })
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
