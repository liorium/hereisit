import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postD1Query, verifyAttestationMigration } from "./apply-worker-version-attestations.mjs";
import {
  assertExactKeys,
  assertObject,
  parseCliArguments,
  readBoundedRegularFile,
} from "./image-lab-common.mjs";
import { verifyActiveWorkerDeployment } from "./verify-worker-version-chain.mjs";

const accountIdPattern = /^[0-9a-f]{32}$/;
const databaseIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const versionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const migrationName = "0002_worker_version_attestations.sql";
const stateSql =
  "SELECT COUNT(*) AS rowCount, COALESCE(SUM(CASE WHEN kind = 'active' THEN 1 ELSE 0 END), 0) AS activeCount, MAX(CASE WHEN kind = 'active' THEN version_id END) AS versionId, MAX(CASE WHEN kind = 'active' THEN public_admission_allowed END) AS publicAdmissionAllowed, MAX(CASE WHEN kind = 'active' THEN retired_at END) AS retiredAt FROM worker_version_attestations";

export function resolveAttestedActiveWorkerVersion({ rows }) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new TypeError("Worker attestation state query must return exactly one row");
  }
  const row = assertObject(rows[0], "Worker attestation state");
  assertExactKeys(
    row,
    ["rowCount", "activeCount", "versionId", "publicAdmissionAllowed", "retiredAt"],
    "Worker attestation state",
  );
  if (!Number.isSafeInteger(row.rowCount) || row.rowCount < 0) {
    throw new TypeError("Worker attestation row count is invalid");
  }
  if (!Number.isSafeInteger(row.activeCount) || row.activeCount < 0) {
    throw new TypeError("Worker attestation active count is invalid");
  }
  if (row.rowCount === 0) {
    if (
      row.activeCount !== 0 ||
      row.versionId !== null ||
      row.publicAdmissionAllowed !== null ||
      row.retiredAt !== null
    ) {
      throw new TypeError("empty Worker attestation state is inconsistent");
    }
    return "none";
  }
  if (
    row.activeCount !== 1 ||
    typeof row.versionId !== "string" ||
    !versionIdPattern.test(row.versionId) ||
    row.publicAdmissionAllowed !== 1 ||
    row.retiredAt !== null
  ) {
    throw new TypeError(
      "Worker attestation state must contain exactly one admissible active version",
    );
  }
  return row.versionId;
}

export function resolvePreviousActiveWorkerVersion({ rows, deployment }) {
  const versionId = resolveAttestedActiveWorkerVersion({ rows });
  if (versionId === "none") {
    const active = assertObject(deployment, "first Worker deployment state");
    if (!Array.isArray(active.versions) || active.versions.length !== 0) {
      throw new TypeError("first Worker deployment must not have an active Worker");
    }
  } else {
    verifyActiveWorkerDeployment(deployment, versionId, "pre-deploy Worker");
  }
  return versionId;
}

async function readAttestedActiveWorkerVersion({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = fetch,
}) {
  if (typeof accountId !== "string" || !accountIdPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (typeof databaseId !== "string" || !databaseIdPattern.test(databaseId)) {
    throw new TypeError("Cloudflare D1 database ID is invalid");
  }
  if (typeof apiToken !== "string" || apiToken.length === 0) {
    throw new TypeError("Cloudflare D1 API token is required");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  await verifyAttestationMigration({ url, apiToken, fetchImpl });
  const [result] = await postD1Query({
    url,
    apiToken,
    body: { sql: stateSql },
    expectedCount: 1,
    fetchImpl,
  });
  return result.results;
}

async function resolveAttestedActiveWorkerVersionFromD1(input) {
  const rows = await readAttestedActiveWorkerVersion(input);
  return resolveAttestedActiveWorkerVersion({ rows });
}

export async function resolvePreviousActiveWorkerVersionFromD1({ deployment, ...input }) {
  const rows = await readAttestedActiveWorkerVersion(input);
  return resolvePreviousActiveWorkerVersion({ rows, deployment });
}

export async function runPreviousActiveWorkerVersionCli(
  argv,
  { env = process.env, fetchImpl = fetch, stdout = process.stdout } = {},
) {
  const args = parseCliArguments(argv);
  if (!env.CLOUDFLARE_D1_API_TOKEN) {
    throw new TypeError("CLOUDFLARE_D1_API_TOKEN environment variable is required");
  }
  if (args["attestation-only"] === "true") {
    assertExactKeys(
      args,
      ["account-id", "database-id", "attestation-only"],
      "previous active arguments",
    );
    const value = await resolveAttestedActiveWorkerVersionFromD1({
      accountId: args["account-id"],
      databaseId: args["database-id"],
      apiToken: env.CLOUDFLARE_D1_API_TOKEN,
      fetchImpl,
    });
    stdout.write(`${value}\n`);
    return value;
  }
  assertExactKeys(args, ["account-id", "database-id", "deployment"], "previous active arguments");
  const bytes = await readBoundedRegularFile(
    resolve(args.deployment),
    1024 * 1024,
    "pre-deploy Worker deployment",
  );
  let deployment;
  try {
    deployment = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("pre-deploy Worker deployment JSON is invalid");
  }
  const value = await resolvePreviousActiveWorkerVersionFromD1({
    accountId: args["account-id"],
    databaseId: args["database-id"],
    apiToken: env.CLOUDFLARE_D1_API_TOKEN,
    deployment,
    fetchImpl,
  });
  stdout.write(`${value}\n`);
  return value;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runPreviousActiveWorkerVersionCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "previous active resolution failed"}\n`,
    );
    process.exitCode = 1;
  }
}

export { migrationName, stateSql };
