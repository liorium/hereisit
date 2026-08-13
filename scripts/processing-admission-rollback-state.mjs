#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postD1Query } from "./apply-worker-version-attestations.mjs";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  readBoundedRegularFile,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const accountPattern = /^[0-9a-f]{32}$/;
const snapshotSql = `SELECT
  control.circuit_open AS circuitOpen,
  control.reason AS circuitReason,
  control.opened_at AS openedAt,
  active.version_id AS versionId,
  active.worker_module_sha256 AS workerModuleSha256,
  active.generated_config_sha256 AS generatedConfigSha256,
  active.release_report_sha256 AS releaseReportSha256,
  active.public_admission_allowed AS publicAdmissionAllowed,
  active.observed_at AS observedAt
FROM rollout_control AS control
JOIN worker_version_attestations AS active ON active.kind = 'active'
WHERE control.id = 1`;
const exactTuplePredicate = `EXISTS (
  SELECT 1 FROM worker_version_attestations AS target
  WHERE target.version_id = ?
    AND target.worker_module_sha256 = ?
    AND target.generated_config_sha256 = ?
    AND target.release_report_sha256 = ?
)`;

function validateSnapshot(value) {
  const snapshot = assertObject(value, "admission rollback snapshot");
  assertExactKeys(snapshot, ["schema", "state"], "admission rollback snapshot");
  if (snapshot.schema !== "hereisit-processing-admission-rollback@1") {
    throw new TypeError("admission rollback snapshot schema is invalid");
  }
  const state = assertObject(snapshot.state, "admission rollback state");
  assertExactKeys(
    state,
    [
      "circuitOpen",
      "circuitReason",
      "openedAt",
      "versionId",
      "workerModuleSha256",
      "generatedConfigSha256",
      "releaseReportSha256",
      "publicAdmissionAllowed",
      "observedAt",
    ],
    "admission rollback state",
  );
  if (![0, 1].includes(state.circuitOpen) || ![0, 1].includes(state.publicAdmissionAllowed)) {
    throw new TypeError("admission rollback booleans are invalid");
  }
  if (!idPattern.test(state.versionId))
    throw new TypeError("admission rollback version is invalid");
  for (const key of ["workerModuleSha256", "generatedConfigSha256", "releaseReportSha256"]) {
    assertSha256(state[key], `admission rollback ${key}`);
  }
  if (!Number.isSafeInteger(state.observedAt) || state.observedAt < 0) {
    throw new TypeError("admission rollback observed time is invalid");
  }
  for (const key of ["circuitReason", "openedAt"]) {
    if (
      state[key] !== null &&
      (key === "openedAt" ? !Number.isSafeInteger(state[key]) : typeof state[key] !== "string")
    ) {
      throw new TypeError(`admission rollback ${key} is invalid`);
    }
  }
  return snapshot;
}

function coordinates({ accountId, databaseId, apiToken }) {
  if (!accountPattern.test(accountId ?? "") || !idPattern.test(databaseId ?? "")) {
    throw new TypeError("admission rollback Cloudflare coordinates are invalid");
  }
  if (typeof apiToken !== "string" || apiToken.length < 1) {
    throw new TypeError("admission rollback D1 token is required");
  }
}

function url(accountId, databaseId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

export async function captureProcessingAdmissionRollbackState({
  accountId,
  databaseId,
  apiToken,
  output,
  fetchImpl = fetch,
}) {
  coordinates({ accountId, databaseId, apiToken });
  const [result] = await postD1Query({
    url: url(accountId, databaseId),
    apiToken,
    body: { sql: snapshotSql, params: [] },
    expectedCount: 1,
    fetchImpl,
  });
  if (result.results.length !== 1) throw new TypeError("admission rollback state is ambiguous");
  const snapshot = validateSnapshot({
    schema: "hereisit-processing-admission-rollback@1",
    state: result.results[0],
  });
  await writeCanonicalJsonAtomic(resolve(output), snapshot, { refuseOverwrite: true, mode: 0o600 });
  return snapshot;
}

export function createProcessingAdmissionRollbackBatch(snapshotValue, now) {
  const snapshot = validateSnapshot(snapshotValue);
  if (!Number.isSafeInteger(now) || now < snapshot.state.observedAt) {
    throw new TypeError("admission rollback time is invalid");
  }
  const state = snapshot.state;
  return [
    {
      sql: `UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = 0, retired_at = ? WHERE kind = ? AND version_id <> ? AND EXISTS (SELECT 1 FROM rollout_control WHERE id = 1) AND ${exactTuplePredicate}`,
      params: [
        "retired",
        now,
        "active",
        state.versionId,
        state.versionId,
        state.workerModuleSha256,
        state.generatedConfigSha256,
        state.releaseReportSha256,
      ],
    },
    {
      sql: "UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = ?, retired_at = NULL WHERE version_id = ? AND worker_module_sha256 = ? AND generated_config_sha256 = ? AND release_report_sha256 = ? AND EXISTS (SELECT 1 FROM rollout_control WHERE id = 1)",
      params: [
        "active",
        state.publicAdmissionAllowed,
        state.versionId,
        state.workerModuleSha256,
        state.generatedConfigSha256,
        state.releaseReportSha256,
      ],
    },
    {
      sql: `UPDATE rollout_control SET circuit_open = ?, reason = ?, opened_at = ? WHERE id = 1 AND ${exactTuplePredicate}`,
      params: [
        state.circuitOpen,
        state.circuitReason,
        state.openedAt,
        state.versionId,
        state.workerModuleSha256,
        state.generatedConfigSha256,
        state.releaseReportSha256,
      ],
    },
  ];
}

export async function restoreProcessingAdmissionRollbackState({
  accountId,
  databaseId,
  apiToken,
  snapshot: snapshotValue,
  now = Date.now(),
  fetchImpl = fetch,
}) {
  coordinates({ accountId, databaseId, apiToken });
  const snapshot = validateSnapshot(snapshotValue);
  const endpoint = url(accountId, databaseId);
  const statements = createProcessingAdmissionRollbackBatch(snapshot, now);
  const results = await postD1Query({
    url: endpoint,
    apiToken,
    body: { batch: statements },
    expectedCount: statements.length,
    fetchImpl,
  });
  if (results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1) {
    throw new Error("admission rollback exact prior tuple prerequisite was not satisfied");
  }
  const [result] = await postD1Query({
    url: endpoint,
    apiToken,
    body: { sql: snapshotSql, params: [] },
    expectedCount: 1,
    fetchImpl,
  });
  if (canonicalJson(result.results) !== canonicalJson([snapshot.state])) {
    throw new Error("admission rollback state was not restored exactly");
  }
  return { restored: true, versionId: snapshot.state.versionId };
}

export async function runProcessingAdmissionRollbackStateCli(
  argv,
  { env = process.env, stdout = process.stdout } = {},
) {
  const args = parseCliArguments(argv);
  const common = ["mode", "account-id", "database-id", "file"];
  assertExactKeys(args, common, "admission rollback arguments");
  const input = {
    accountId: args["account-id"],
    databaseId: args["database-id"],
    apiToken: env.CLOUDFLARE_D1_API_TOKEN,
  };
  const result =
    args.mode === "capture"
      ? await captureProcessingAdmissionRollbackState({ ...input, output: args.file })
      : args.mode === "restore"
        ? await restoreProcessingAdmissionRollbackState({
            ...input,
            snapshot: JSON.parse(
              (
                await readBoundedRegularFile(
                  resolve(args.file),
                  64 * 1024,
                  "admission rollback snapshot",
                )
              ).toString("utf8"),
            ),
          })
        : (() => {
            throw new TypeError("admission rollback mode is invalid");
          })();
  stdout.write(canonicalJson(result));
  return result;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingAdmissionRollbackStateCli(process.argv.slice(2));
  } catch {
    process.stderr.write("admission rollback state command failed\n");
    process.exitCode = 1;
  }
}
