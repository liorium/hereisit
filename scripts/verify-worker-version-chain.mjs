import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import { readWranglerOutput } from "./read-wrangler-output.mjs";

const versionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const authorIdPattern = /^[0-9a-f]{32}$/;
const allowedSources = new Set([
  "unknown",
  "api",
  "wrangler",
  "terraform",
  "dash",
  "cf_cli",
  "dash_template",
  "integration",
  "quick_editor",
  "playground",
  "workersci",
]);
const artifactFileLimits = Object.freeze({
  workerModule: 16 * 1024 * 1024,
  generatedConfig: 1024 * 1024,
  releaseReport: 2 * 1024 * 1024,
});

function assertCanonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

function validateVersion(value, label) {
  const version = assertObject(value, label);
  assertExactKeys(version, ["id", "number", "metadata", "annotations"], label);
  if (typeof version.id !== "string" || !versionIdPattern.test(version.id)) {
    throw new TypeError(`${label} Version Metadata ID is invalid`);
  }
  if (!Number.isSafeInteger(version.number) || version.number < 1) {
    throw new TypeError(`${label} number is invalid`);
  }

  const metadata = assertObject(version.metadata, `${label} metadata`);
  assertExactKeys(
    metadata,
    ["author_email", "author_id", "created_on", "has_preview", "source"],
    `${label} metadata`,
  );
  if (typeof metadata.author_email !== "string" || metadata.author_email.length > 320) {
    throw new TypeError(`${label} author email is invalid`);
  }
  if (typeof metadata.author_id !== "string" || !authorIdPattern.test(metadata.author_id)) {
    throw new TypeError(`${label} author ID is invalid`);
  }
  assertCanonicalTimestamp(metadata.created_on, `${label} creation time`);
  if (typeof metadata.has_preview !== "boolean") {
    throw new TypeError(`${label} preview flag is invalid`);
  }
  if (!allowedSources.has(metadata.source)) throw new TypeError(`${label} source is invalid`);

  const annotations = assertObject(version.annotations, `${label} annotations`);
  assertExactKeys(annotations, ["workers/triggered_by"], `${label} annotations`);
  if (
    annotations["workers/triggered_by"] !== "upload" &&
    annotations["workers/triggered_by"] !== "secret"
  ) {
    throw new TypeError(`${label} trigger is invalid`);
  }
  return version;
}

export function validateWorkerVersionSnapshot(value, label = "Worker version") {
  if (!Array.isArray(value) || value.length > 10) {
    throw new TypeError(`${label} snapshot must contain at most ten versions`);
  }
  const versions = value.map((entry, index) => validateVersion(entry, `${label}[${index}]`));
  const ids = new Set();
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    if (ids.has(version.id)) throw new TypeError(`${label} snapshot contains a duplicate version`);
    ids.add(version.id);
    if (index > 0) {
      const previous = versions[index - 1];
      if (
        version.number <= previous.number ||
        Date.parse(version.metadata.created_on) <= Date.parse(previous.metadata.created_on)
      ) {
        throw new TypeError(`${label} snapshot is not ordered by creation`);
      }
    }
  }
  return versions;
}

function assertSameVersion(left, right, label) {
  if (sha256Canonical(left) !== sha256Canonical(right)) {
    throw new TypeError(`${label} retained version changed between snapshots`);
  }
}

function verifyTransition(previous, next, expectedNewCount, label, expectedTrigger) {
  const expectedLength = Math.min(10, previous.length + expectedNewCount);
  if (next.length !== expectedLength) {
    throw new TypeError(`${label} transition contains an unexplained version count`);
  }
  const retainedCount = next.length - expectedNewCount;
  const retained = previous.slice(previous.length - retainedCount);
  for (let index = 0; index < retainedCount; index += 1) {
    assertSameVersion(retained[index], next[index], label);
  }

  const added = next.slice(retainedCount);
  const predecessor = previous.at(-1);
  for (let index = 0; index < added.length; index += 1) {
    const version = added[index];
    const expectedNumber = (predecessor?.number ?? version.number - 1) + index + 1;
    if (version.number !== expectedNumber) {
      throw new TypeError(`${label} transition contains an unexplained version`);
    }
    if (version.metadata.source !== "wrangler") {
      throw new TypeError(`${label} version source must be Wrangler`);
    }
    if (version.annotations["workers/triggered_by"] !== expectedTrigger) {
      throw new TypeError(`${label} version must have the ${expectedTrigger} trigger`);
    }
  }
  return added;
}

function validateHashes(value, label) {
  const hashes = assertObject(value, label);
  assertExactKeys(
    hashes,
    ["workerModuleSha256", "generatedConfigSha256", "releaseReportSha256"],
    label,
  );
  for (const [key, hash] of Object.entries(hashes)) assertSha256(hash, `${label} ${key}`);
  return hashes;
}

function calculateWorkerArtifactHashes({ workerModule, generatedConfig, releaseReport }) {
  for (const [label, value] of [
    ["Worker module", workerModule],
    ["generated config", generatedConfig],
    ["release report", releaseReport],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${label} bytes are required`);
    }
  }

  let config;
  try {
    config = JSON.parse(generatedConfig);
  } catch {
    throw new TypeError("generated config JSON is invalid");
  }
  const configObject = assertObject(config, "generated config");
  const versionMetadata = assertObject(
    configObject.version_metadata,
    "generated config version metadata",
  );
  if (versionMetadata.binding !== "WORKER_VERSION") {
    throw new TypeError("generated config must bind WORKER_VERSION metadata");
  }
  const variables = assertObject(configObject.vars, "generated config variables");
  if (variables.IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT !== "0") {
    throw new RangeError("artifact witness requires rollout-zero public admission");
  }

  const releaseReportSha256 = sha256Bytes(releaseReport);
  if (variables.RELEASE_REPORT_SHA256 !== releaseReportSha256) {
    throw new TypeError("generated config release report hash does not match");
  }
  return {
    workerModuleSha256: sha256Bytes(workerModule),
    generatedConfigSha256: sha256Bytes(generatedConfig),
    releaseReportSha256,
  };
}

export function createWorkerArtifactHashWitness({
  workerModule,
  generatedConfig,
  releaseReport,
  capturedAt,
}) {
  return {
    schema: "hereisit-worker-artifact-hashes@1",
    version: 1,
    capturedAt: assertCanonicalTimestamp(capturedAt, "artifact witness capture time"),
    ...calculateWorkerArtifactHashes({ workerModule, generatedConfig, releaseReport }),
  };
}

function validateWorkerArtifactHashWitness(value) {
  const witness = assertObject(value, "Worker artifact hash witness");
  assertExactKeys(
    witness,
    [
      "schema",
      "version",
      "capturedAt",
      "workerModuleSha256",
      "generatedConfigSha256",
      "releaseReportSha256",
    ],
    "Worker artifact hash witness",
  );
  if (witness.schema !== "hereisit-worker-artifact-hashes@1" || witness.version !== 1) {
    throw new TypeError("Worker artifact hash witness schema is invalid");
  }
  assertCanonicalTimestamp(witness.capturedAt, "artifact witness capture time");
  validateHashes(
    {
      workerModuleSha256: witness.workerModuleSha256,
      generatedConfigSha256: witness.generatedConfigSha256,
      releaseReportSha256: witness.releaseReportSha256,
    },
    "artifact witness hashes",
  );
  return witness;
}

export function verifyWorkerArtifactHashWitness(witnessValue, artifacts) {
  const witness = validateWorkerArtifactHashWitness(witnessValue);
  const actual = calculateWorkerArtifactHashes(artifacts);
  const expected = {
    workerModuleSha256: witness.workerModuleSha256,
    generatedConfigSha256: witness.generatedConfigSha256,
    releaseReportSha256: witness.releaseReportSha256,
  };
  if (sha256Canonical(actual) !== sha256Canonical(expected)) {
    throw new TypeError("Worker artifacts changed after the bootstrap hash witness");
  }
  return actual;
}

async function readBoundedUtf8File(file, maximumBytes, label) {
  if (typeof file !== "string" || file.length === 0)
    throw new TypeError(`${label} file is required`);
  let handle;
  try {
    handle = await open(file, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} input must be a regular file`);
    if (metadata.size > maximumBytes) throw new RangeError(`${label} exceeds its maximum size`);
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new RangeError(`${label} exceeds its maximum size`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new TypeError(`${label} must be valid UTF-8`);
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new Error(`${label} file could not be read`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function captureWorkerArtifactHashWitnessFile({
  workerModuleFile,
  configFile,
  releaseReportFile,
  outputFile,
  capturedAt,
}) {
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    throw new TypeError("artifact witness output file is required");
  }
  const workerModule = await readBoundedUtf8File(
    workerModuleFile,
    artifactFileLimits.workerModule,
    "Worker module",
  );
  const generatedConfig = await readBoundedUtf8File(
    configFile,
    artifactFileLimits.generatedConfig,
    "generated config",
  );
  const releaseReport = await readBoundedUtf8File(
    releaseReportFile,
    artifactFileLimits.releaseReport,
    "release report",
  );
  const witness = createWorkerArtifactHashWitness({
    workerModule,
    generatedConfig,
    releaseReport,
    capturedAt,
  });
  try {
    await writeCanonicalJsonAtomic(outputFile, witness, { refuseOverwrite: true });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("artifact witness output already exists; overwrite is prohibited");
    }
    throw new Error("artifact witness output could not be written");
  }
  return witness;
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }
}

export async function finalizeWorkerVersionChainFiles({
  beforeFile,
  afterBootstrapFile,
  afterSecretsFile,
  afterFinalFile,
  bootstrapOutputFile,
  finalOutputFile,
  bootstrapWitnessFile,
  workerModuleFile,
  configFile,
  releaseReportFile,
  outputFile,
  previousActiveVersionId,
  previousActiveDeploymentFile,
  verifiedAt,
}) {
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    throw new TypeError("Worker version attestation output file is required");
  }
  const snapshots = {
    before: parseJsonText(
      await readBoundedUtf8File(beforeFile, 1024 * 1024, "before snapshot"),
      "before snapshot",
    ),
    afterBootstrap: parseJsonText(
      await readBoundedUtf8File(afterBootstrapFile, 1024 * 1024, "after-bootstrap snapshot"),
      "after-bootstrap snapshot",
    ),
    afterSecrets: parseJsonText(
      await readBoundedUtf8File(afterSecretsFile, 1024 * 1024, "after-secrets snapshot"),
      "after-secrets snapshot",
    ),
    afterFinal: parseJsonText(
      await readBoundedUtf8File(afterFinalFile, 1024 * 1024, "after-final snapshot"),
      "after-final snapshot",
    ),
  };
  const bootstrapDeployment = readWranglerOutput({
    text: await readBoundedUtf8File(bootstrapOutputFile, 1024 * 1024, "bootstrap Wrangler output"),
    event: "deploy",
  });
  const finalDeployment = readWranglerOutput({
    text: await readBoundedUtf8File(finalOutputFile, 1024 * 1024, "final Wrangler output"),
    event: "deploy",
  });
  const witness = parseJsonText(
    await readBoundedUtf8File(bootstrapWitnessFile, 256 * 1024, "bootstrap artifact witness"),
    "bootstrap artifact witness",
  );
  const workerModule = await readBoundedUtf8File(
    workerModuleFile,
    artifactFileLimits.workerModule,
    "Worker module",
  );
  const generatedConfig = await readBoundedUtf8File(
    configFile,
    artifactFileLimits.generatedConfig,
    "generated config",
  );
  const releaseReport = await readBoundedUtf8File(
    releaseReportFile,
    artifactFileLimits.releaseReport,
    "release report",
  );
  const finalHashes = verifyWorkerArtifactHashWitness(witness, {
    workerModule,
    generatedConfig,
    releaseReport,
  });
  const bootstrapHashes = {
    workerModuleSha256: witness.workerModuleSha256,
    generatedConfigSha256: witness.generatedConfigSha256,
    releaseReportSha256: witness.releaseReportSha256,
  };
  const previousActiveDeployment = parseJsonText(
    await readBoundedUtf8File(
      previousActiveDeploymentFile,
      256 * 1024,
      "previous active deployment",
    ),
    "previous active deployment",
  );
  const attestation = verifyWorkerVersionChain({
    snapshots,
    bootstrapDeployment,
    finalDeployment,
    bootstrapHashes,
    finalHashes,
    previousActiveVersionId,
    previousActiveDeployment,
    publicAdmissionPercent: 0,
    verifiedAt,
  });

  const bootstrapVersion = snapshots.afterBootstrap.find(
    (version) => version.id === bootstrapDeployment.version_id,
  );
  const firstSecretVersion = snapshots.afterSecrets.find(
    (version) => version.id === attestation.versions[1].versionId,
  );
  const finalVersion = snapshots.afterFinal.find(
    (version) => version.id === attestation.activeVersionId,
  );
  const capturedAtMs = Date.parse(witness.capturedAt);
  if (
    capturedAtMs < Date.parse(bootstrapVersion.metadata.created_on) ||
    capturedAtMs >= Date.parse(firstSecretVersion.metadata.created_on)
  ) {
    throw new TypeError(
      "bootstrap artifact witness was not captured between bootstrap and secrets",
    );
  }
  if (Date.parse(verifiedAt) < Date.parse(finalVersion.metadata.created_on)) {
    throw new TypeError("Worker version attestation predates the final deployment");
  }

  try {
    await writeCanonicalJsonAtomic(outputFile, attestation, { refuseOverwrite: true });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Worker version attestation output already exists; overwrite is prohibited");
    }
    throw new Error("Worker version attestation output could not be written");
  }
  return { attestation, batch: createWorkerVersionAttestationBatch(attestation) };
}

export async function finalizeWorkerAdmissionFiles({
  beforeFile,
  afterFile,
  deploymentOutputFile,
  beforeDeploymentFile,
  afterDeploymentFile,
  currentAttestationFile,
  workerModuleFile,
  currentConfigFile,
  nextConfigFile,
  releaseReportFile,
  outputFile,
  verifiedAt,
}) {
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    throw new TypeError("Worker admission attestation output file is required");
  }
  const attestation = verifyWorkerAdmissionTransition({
    before: parseJsonText(
      await readBoundedUtf8File(beforeFile, 1024 * 1024, "admission before snapshot"),
      "admission before snapshot",
    ),
    after: parseJsonText(
      await readBoundedUtf8File(afterFile, 1024 * 1024, "admission after snapshot"),
      "admission after snapshot",
    ),
    deployment: readWranglerOutput({
      text: await readBoundedUtf8File(
        deploymentOutputFile,
        1024 * 1024,
        "admission Wrangler output",
      ),
      event: "deploy",
    }),
    beforeDeployment: parseJsonText(
      await readBoundedUtf8File(beforeDeploymentFile, 64 * 1024, "admission deployment before"),
      "admission deployment before",
    ),
    afterDeployment: parseJsonText(
      await readBoundedUtf8File(afterDeploymentFile, 64 * 1024, "admission deployment after"),
      "admission deployment after",
    ),
    currentAttestation: parseJsonText(
      await readBoundedUtf8File(currentAttestationFile, 64 * 1024, "current Worker attestation"),
      "current Worker attestation",
    ),
    workerModule: await readBoundedUtf8File(
      workerModuleFile,
      artifactFileLimits.workerModule,
      "Worker module",
    ),
    currentConfig: await readBoundedUtf8File(
      currentConfigFile,
      artifactFileLimits.generatedConfig,
      "current generated config",
    ),
    nextConfig: await readBoundedUtf8File(
      nextConfigFile,
      artifactFileLimits.generatedConfig,
      "next generated config",
    ),
    releaseReport: await readBoundedUtf8File(
      releaseReportFile,
      artifactFileLimits.releaseReport,
      "release report",
    ),
    fromPublicAdmissionPercent: 0,
    publicAdmissionPercent: 100,
    verifiedAt,
  });
  try {
    await writeCanonicalJsonAtomic(outputFile, attestation, {
      refuseOverwrite: true,
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "Worker admission attestation output already exists; overwrite is prohibited",
      );
    }
    throw new Error("Worker admission attestation output could not be written");
  }
  return { attestation, batch: createWorkerAdmissionAttestationBatch(attestation) };
}

export function validateWorkerVersionAttestation(value) {
  const attestation = assertObject(value, "Worker version attestation");
  assertExactKeys(
    attestation,
    [
      "schema",
      "version",
      "verifiedAt",
      "workerModuleSha256",
      "generatedConfigSha256",
      "releaseReportSha256",
      "activeVersionId",
      "previousActive",
      "versions",
    ],
    "Worker version attestation",
  );
  if (
    attestation.schema !== "hereisit-worker-version-attestations@1" ||
    attestation.version !== 1
  ) {
    throw new TypeError("Worker version attestation schema is invalid");
  }
  assertCanonicalTimestamp(attestation.verifiedAt, "Worker version attestation verification time");
  validateHashes(
    {
      workerModuleSha256: attestation.workerModuleSha256,
      generatedConfigSha256: attestation.generatedConfigSha256,
      releaseReportSha256: attestation.releaseReportSha256,
    },
    "Worker version attestation hashes",
  );
  if (
    typeof attestation.activeVersionId !== "string" ||
    !versionIdPattern.test(attestation.activeVersionId)
  ) {
    throw new TypeError("Worker version attestation active version ID is invalid");
  }

  if (attestation.previousActive !== null) {
    const previous = assertObject(attestation.previousActive, "previous active version");
    assertExactKeys(previous, ["versionId", "state", "retireAfter"], "previous active version");
    if (typeof previous.versionId !== "string" || !versionIdPattern.test(previous.versionId)) {
      throw new TypeError("previous active version ID is invalid");
    }
    if (previous.state !== "retiring")
      throw new TypeError("previous active version must be retiring");
    assertCanonicalTimestamp(previous.retireAfter, "previous active retirement time");
  }

  if (!Array.isArray(attestation.versions) || attestation.versions.length !== 6) {
    throw new TypeError("Worker version attestation must contain exactly six new versions");
  }
  const expectedStates = [
    "bootstrap",
    "secret-intermediate",
    "secret-intermediate",
    "secret-intermediate",
    "secret-intermediate",
    "active",
  ];
  const seen = new Set();
  for (const [index, valueEntry] of attestation.versions.entries()) {
    const entry = assertObject(valueEntry, `Worker version attestation versions[${index}]`);
    assertExactKeys(
      entry,
      ["versionId", "state", "publicAdmissionPercent"],
      `Worker version attestation versions[${index}]`,
    );
    if (typeof entry.versionId !== "string" || !versionIdPattern.test(entry.versionId)) {
      throw new TypeError("attested Worker version ID is invalid");
    }
    if (seen.has(entry.versionId))
      throw new TypeError("attested Worker version IDs must be unique");
    seen.add(entry.versionId);
    if (entry.state !== expectedStates[index]) {
      throw new TypeError("attested Worker version state order is invalid");
    }
    if (entry.publicAdmissionPercent !== 0) {
      throw new TypeError("attested Worker version chain must remain rollout zero");
    }
  }
  if (attestation.versions.at(-1).versionId !== attestation.activeVersionId) {
    throw new TypeError("Worker version attestation active version does not match");
  }
  return attestation;
}

const upsertAttestationSql =
  "INSERT INTO worker_version_attestations (version_id, worker_module_sha256, generated_config_sha256, release_report_sha256, kind, public_admission_allowed, observed_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(version_id) DO UPDATE SET kind = excluded.kind, public_admission_allowed = excluded.public_admission_allowed, observed_at = excluded.observed_at, retired_at = excluded.retired_at WHERE worker_module_sha256 = excluded.worker_module_sha256 AND generated_config_sha256 = excluded.generated_config_sha256 AND release_report_sha256 = excluded.release_report_sha256";

export function createWorkerVersionAttestationBatch(attestationValue) {
  const attestation = validateWorkerVersionAttestation(attestationValue);
  const observedAt = Date.parse(attestation.verifiedAt);
  const statements = [];
  if (attestation.previousActive !== null) {
    statements.push({
      sql: "UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = 0, retired_at = ? WHERE version_id = ?",
      params: [
        "retired",
        Date.parse(attestation.previousActive.retireAfter),
        attestation.previousActive.versionId,
      ],
    });
  }
  for (const version of attestation.versions) {
    statements.push({
      sql: upsertAttestationSql,
      params: [
        version.versionId,
        attestation.workerModuleSha256,
        attestation.generatedConfigSha256,
        attestation.releaseReportSha256,
        version.state,
        version.state === "active" ? 1 : 0,
        observedAt,
        null,
      ],
    });
  }
  const stateIds = [
    ...(attestation.previousActive === null ? [] : [attestation.previousActive.versionId]),
    ...attestation.versions.map((version) => version.versionId),
  ];
  const stateExpected = [
    ...(attestation.previousActive === null
      ? []
      : [
          {
            versionId: attestation.previousActive.versionId,
            kind: "retired",
            publicAdmissionAllowed: 0,
            retiredAt: Date.parse(attestation.previousActive.retireAfter),
          },
        ]),
    ...attestation.versions.map((version) => ({
      versionId: version.versionId,
      kind: version.state,
      publicAdmissionAllowed: version.state === "active" ? 1 : 0,
      retiredAt: null,
    })),
  ].sort((left, right) => left.versionId.localeCompare(right.versionId));
  const newIds = attestation.versions.map((version) => version.versionId);
  const hashExpected = attestation.versions
    .map((version) => ({
      versionId: version.versionId,
      workerModuleSha256: attestation.workerModuleSha256,
      generatedConfigSha256: attestation.generatedConfigSha256,
      releaseReportSha256: attestation.releaseReportSha256,
    }))
    .sort((left, right) => left.versionId.localeCompare(right.versionId));
  return {
    version: 1,
    statements,
    verification: [
      {
        sql: `SELECT version_id AS versionId, kind, public_admission_allowed AS publicAdmissionAllowed, retired_at AS retiredAt FROM worker_version_attestations WHERE version_id IN (${stateIds.map(() => "?").join(", ")}) ORDER BY version_id`,
        params: stateIds,
        expected: stateExpected,
      },
      {
        sql: `SELECT version_id AS versionId, worker_module_sha256 AS workerModuleSha256, generated_config_sha256 AS generatedConfigSha256, release_report_sha256 AS releaseReportSha256 FROM worker_version_attestations WHERE version_id IN (${newIds.map(() => "?").join(", ")}) ORDER BY version_id`,
        params: newIds,
        expected: hashExpected,
      },
    ],
  };
}

function validateWorkerAdmissionAttestation(value) {
  const attestation = assertObject(value, "Worker admission attestation");
  assertExactKeys(
    attestation,
    [
      "schema",
      "version",
      "verifiedAt",
      "fromVersionId",
      "activeVersionId",
      "fromPublicAdmissionPercent",
      "publicAdmissionPercent",
      "workerModuleSha256",
      "previousConfigSha256",
      "generatedConfigSha256",
      "releaseReportSha256",
      "versions",
    ],
    "Worker admission attestation",
  );
  if (
    attestation.schema !== "hereisit-worker-admission-transition@1" ||
    attestation.version !== 1
  ) {
    throw new TypeError("Worker admission attestation schema is invalid");
  }
  assertCanonicalTimestamp(attestation.verifiedAt, "Worker admission verification time");
  for (const [label, valueHash] of [
    ["Worker module", attestation.workerModuleSha256],
    ["previous config", attestation.previousConfigSha256],
    ["generated config", attestation.generatedConfigSha256],
    ["release report", attestation.releaseReportSha256],
  ]) {
    assertSha256(valueHash, `${label} hash`);
  }
  for (const [label, valueId] of [
    ["previous", attestation.fromVersionId],
    ["active", attestation.activeVersionId],
  ]) {
    if (typeof valueId !== "string" || !versionIdPattern.test(valueId)) {
      throw new TypeError(`Worker admission ${label} version ID is invalid`);
    }
  }
  if (
    attestation.fromVersionId === attestation.activeVersionId ||
    attestation.fromPublicAdmissionPercent !== 0 ||
    attestation.publicAdmissionPercent !== 100
  ) {
    throw new TypeError("Worker admission transition must be zero-to-100 across two versions");
  }
  if (!Array.isArray(attestation.versions) || attestation.versions.length !== 1) {
    throw new TypeError("Worker admission attestation must contain exactly one new version");
  }
  const version = assertObject(attestation.versions[0], "Worker admission version");
  assertExactKeys(
    version,
    ["versionId", "state", "publicAdmissionPercent"],
    "Worker admission version",
  );
  if (
    version.versionId !== attestation.activeVersionId ||
    version.state !== "active" ||
    version.publicAdmissionPercent !== 100
  ) {
    throw new TypeError("Worker admission active version is invalid");
  }
  return attestation;
}

export function createWorkerAdmissionAttestationBatch(attestationValue) {
  const attestation = validateWorkerAdmissionAttestation(attestationValue);
  const observedAt = Date.parse(attestation.verifiedAt);
  const stateIds = [attestation.fromVersionId, attestation.activeVersionId];
  return {
    version: 1,
    statements: [
      {
        sql: "UPDATE worker_version_attestations SET kind = ?, public_admission_allowed = 0, retired_at = ? WHERE version_id = ?",
        params: ["retired", observedAt, attestation.fromVersionId],
      },
      {
        sql: upsertAttestationSql,
        params: [
          attestation.activeVersionId,
          attestation.workerModuleSha256,
          attestation.generatedConfigSha256,
          attestation.releaseReportSha256,
          "active",
          1,
          observedAt,
          null,
        ],
      },
    ],
    verification: [
      {
        sql: `SELECT version_id AS versionId, kind, public_admission_allowed AS publicAdmissionAllowed, retired_at AS retiredAt FROM worker_version_attestations WHERE version_id IN (${stateIds.map(() => "?").join(", ")}) ORDER BY version_id`,
        params: stateIds,
        expected: [
          {
            versionId: attestation.fromVersionId,
            kind: "retired",
            publicAdmissionAllowed: 0,
            retiredAt: observedAt,
          },
          {
            versionId: attestation.activeVersionId,
            kind: "active",
            publicAdmissionAllowed: 1,
            retiredAt: null,
          },
        ].sort((left, right) => left.versionId.localeCompare(right.versionId)),
      },
      {
        sql: "SELECT version_id AS versionId, worker_module_sha256 AS workerModuleSha256, generated_config_sha256 AS generatedConfigSha256, release_report_sha256 AS releaseReportSha256 FROM worker_version_attestations WHERE version_id IN (?) ORDER BY version_id",
        params: [attestation.activeVersionId],
        expected: [
          {
            versionId: attestation.activeVersionId,
            workerModuleSha256: attestation.workerModuleSha256,
            generatedConfigSha256: attestation.generatedConfigSha256,
            releaseReportSha256: attestation.releaseReportSha256,
          },
        ],
      },
    ],
  };
}

function assertCliArguments(args, allowed, required) {
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError("unknown Worker version chain argument");
  }
  for (const name of required) {
    if (args[name] === undefined) throw new TypeError(`--${name} is required`);
  }
}

function assertCliArgumentOrder(argv, expected) {
  if (
    argv.length !== expected.length * 2 ||
    expected.some((name, index) => argv[index * 2] !== `--${name}`)
  ) {
    throw new TypeError("Worker admission arguments are out of order");
  }
}

export async function runWorkerVersionChainCli(argv, { now = () => new Date() } = {}) {
  const args = parseCliArguments(argv);
  if (args.mode === "capture-bootstrap") {
    const required = ["mode", "worker-module", "config", "release-report", "output"];
    assertCliArguments(args, new Set(required), required);
    return captureWorkerArtifactHashWitnessFile({
      workerModuleFile: resolve(args["worker-module"]),
      configFile: resolve(args.config),
      releaseReportFile: resolve(args["release-report"]),
      outputFile: resolve(args.output),
      capturedAt: now().toISOString(),
    });
  }
  if (args.mode === "finalize") {
    const required = [
      "mode",
      "before",
      "after-bootstrap",
      "after-secrets",
      "after-final",
      "bootstrap-output",
      "final-output",
      "bootstrap-witness",
      "worker-module",
      "config",
      "release-report",
      "output",
      "previous-active-version-id",
      "before-deployment",
    ];
    assertCliArguments(args, new Set(required), required);
    return finalizeWorkerVersionChainFiles({
      beforeFile: resolve(args.before),
      afterBootstrapFile: resolve(args["after-bootstrap"]),
      afterSecretsFile: resolve(args["after-secrets"]),
      afterFinalFile: resolve(args["after-final"]),
      bootstrapOutputFile: resolve(args["bootstrap-output"]),
      finalOutputFile: resolve(args["final-output"]),
      bootstrapWitnessFile: resolve(args["bootstrap-witness"]),
      workerModuleFile: resolve(args["worker-module"]),
      configFile: resolve(args.config),
      releaseReportFile: resolve(args["release-report"]),
      outputFile: resolve(args.output),
      previousActiveVersionId:
        args["previous-active-version-id"] === "none" ? null : args["previous-active-version-id"],
      previousActiveDeploymentFile: resolve(args["before-deployment"]),
      verifiedAt: now().toISOString(),
    });
  }
  if (args.mode === "finalize-admission") {
    const required = [
      "mode",
      "before",
      "after",
      "deployment-output",
      "before-deployment",
      "after-deployment",
      "current-attestation",
      "worker-module",
      "current-config",
      "next-config",
      "release-report",
      "output",
    ];
    assertCliArguments(args, new Set(required), required);
    assertCliArgumentOrder(argv, required);
    return finalizeWorkerAdmissionFiles({
      beforeFile: resolve(args.before),
      afterFile: resolve(args.after),
      deploymentOutputFile: resolve(args["deployment-output"]),
      beforeDeploymentFile: resolve(args["before-deployment"]),
      afterDeploymentFile: resolve(args["after-deployment"]),
      currentAttestationFile: resolve(args["current-attestation"]),
      workerModuleFile: resolve(args["worker-module"]),
      currentConfigFile: resolve(args["current-config"]),
      nextConfigFile: resolve(args["next-config"]),
      releaseReportFile: resolve(args["release-report"]),
      outputFile: resolve(args.output),
      verifiedAt: now().toISOString(),
    });
  }
  throw new TypeError(
    "Worker version chain --mode must be capture-bootstrap, finalize, or finalize-admission",
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runWorkerVersionChainCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker version chain command failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function deploymentVersionId(value, label) {
  const deployment = assertObject(value, `${label} deployment output`);
  if (typeof deployment.version_id !== "string" || !versionIdPattern.test(deployment.version_id)) {
    throw new TypeError(`${label} deployment Version Metadata ID is missing or invalid`);
  }
  return deployment.version_id;
}

export function verifyActiveWorkerDeployment(value, expectedVersionId, label = "Worker") {
  if (typeof expectedVersionId !== "string" || !versionIdPattern.test(expectedVersionId)) {
    throw new TypeError(`${label} expected active version ID is invalid`);
  }
  const deployment = assertObject(value, `${label} active deployment`);
  if (
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    deployment.versions[0]?.version_id !== expectedVersionId ||
    deployment.versions[0]?.percentage !== 100
  ) {
    throw new TypeError(`${label} active deployment does not serve the expected version at 100%`);
  }
}

export function verifyWorkerVersionChain(inputValue) {
  const input = assertObject(inputValue, "Worker version chain input");
  if (input.publicAdmissionPercent !== 0) {
    throw new RangeError("Worker version chain requires rollout-zero public admission");
  }
  const verifiedAt = assertCanonicalTimestamp(input.verifiedAt, "version chain verification time");
  const snapshots = assertObject(input.snapshots, "Worker version snapshots");
  assertExactKeys(
    snapshots,
    ["before", "afterBootstrap", "afterSecrets", "afterFinal"],
    "Worker version snapshots",
  );
  const before = validateWorkerVersionSnapshot(snapshots.before, "before");
  const afterBootstrap = validateWorkerVersionSnapshot(snapshots.afterBootstrap, "after-bootstrap");
  const afterSecrets = validateWorkerVersionSnapshot(snapshots.afterSecrets, "after-secrets");
  const afterFinal = validateWorkerVersionSnapshot(snapshots.afterFinal, "after-final");

  const [bootstrap] = verifyTransition(before, afterBootstrap, 1, "bootstrap", "upload");
  const secretVersions = verifyTransition(afterBootstrap, afterSecrets, 4, "secret", "secret");
  const [final] = verifyTransition(afterSecrets, afterFinal, 1, "final", "upload");
  if (deploymentVersionId(input.bootstrapDeployment, "bootstrap") !== bootstrap.id) {
    throw new TypeError("bootstrap deployment Version Metadata ID does not match");
  }
  if (deploymentVersionId(input.finalDeployment, "final") !== final.id) {
    throw new TypeError("final deployment Version Metadata ID does not match");
  }

  const bootstrapHashes = validateHashes(input.bootstrapHashes, "bootstrap hashes");
  const finalHashes = validateHashes(input.finalHashes, "final hashes");
  if (sha256Canonical(bootstrapHashes) !== sha256Canonical(finalHashes)) {
    throw new TypeError("Worker module, generated config, or release hash was mutable");
  }

  let previousVersionId;
  if (input.previousActiveVersionId === null) {
    const deployment = assertObject(
      input.previousActiveDeployment,
      "first Worker deployment state",
    );
    if (!Array.isArray(deployment.versions) || deployment.versions.length !== 0) {
      throw new TypeError("first Worker deployment must not claim a previous active deployment");
    }
    previousVersionId = undefined;
  } else {
    if (
      typeof input.previousActiveVersionId !== "string" ||
      !versionIdPattern.test(input.previousActiveVersionId)
    ) {
      throw new TypeError("previous active Worker version ID is invalid");
    }
    verifyActiveWorkerDeployment(
      input.previousActiveDeployment,
      input.previousActiveVersionId,
      "previous Worker",
    );
    previousVersionId = input.previousActiveVersionId;
  }
  return {
    schema: "hereisit-worker-version-attestations@1",
    version: 1,
    verifiedAt,
    ...finalHashes,
    activeVersionId: final.id,
    previousActive:
      previousVersionId === undefined
        ? null
        : {
            versionId: previousVersionId,
            state: "retiring",
            retireAfter: new Date(Date.parse(verifiedAt) + 10 * 60_000).toISOString(),
          },
    versions: [
      { versionId: bootstrap.id, state: "bootstrap", publicAdmissionPercent: 0 },
      ...secretVersions.map((version) => ({
        versionId: version.id,
        state: "secret-intermediate",
        publicAdmissionPercent: 0,
      })),
      { versionId: final.id, state: "active", publicAdmissionPercent: 0 },
    ],
  };
}

function parseAdmissionConfig(text, label) {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError(`${label} generated config bytes are required`);
  }
  const config = assertObject(parseJsonText(text, `${label} generated config`), `${label} config`);
  const variables = assertObject(config.vars, `${label} config variables`);
  return { config, variables };
}

function verifyAdmissionConfigPair(currentText, nextText, fromPercent, toPercent) {
  const current = parseAdmissionConfig(currentText, "current");
  const next = parseAdmissionConfig(nextText, "next");
  const key = "IMAGE_COMPRESS_SERVER_ROLLOUT_PERCENT";
  if (current.variables[key] !== String(fromPercent) || next.variables[key] !== String(toPercent)) {
    throw new RangeError("Worker admission rollout transition does not match");
  }
  current.variables[key] = "<rollout>";
  next.variables[key] = "<rollout>";
  for (const [label, parsed, expected] of [
    ["current", current, null],
    ["next", next, "22002"],
  ]) {
    if (!Array.isArray(parsed.config.ratelimits)) {
      throw new TypeError(`${label} config rate limits are invalid`);
    }
    const matches = parsed.config.ratelimits.filter(
      (entry) => entry?.name === "NETWORK_JOB_RATE_LIMITER",
    );
    if (matches.length !== 1 || !/^[1-9][0-9]*$/.test(matches[0].namespace_id)) {
      throw new TypeError(`${label} config network rate limit is invalid`);
    }
    if (
      (expected === null && matches[0].namespace_id === "22002") ||
      (expected !== null && matches[0].namespace_id !== expected)
    ) {
      throw new TypeError("Worker admission network rate limit transition is invalid");
    }
    matches[0].namespace_id = "<network>";
  }
  if (sha256Canonical(current.config) !== sha256Canonical(next.config)) {
    throw new TypeError("Worker admission config changed outside rollout");
  }
}

export function verifyWorkerAdmissionTransition(inputValue) {
  const input = assertObject(inputValue, "Worker admission transition input");
  if (input.fromPublicAdmissionPercent !== 0 || input.publicAdmissionPercent !== 100) {
    throw new RangeError("Worker admission supports only a zero-to-100 transition");
  }

  const verifiedAt = assertCanonicalTimestamp(input.verifiedAt, "admission verification time");
  const before = validateWorkerVersionSnapshot(input.before, "admission before");
  const after = validateWorkerVersionSnapshot(input.after, "admission after");
  const [active] = verifyTransition(before, after, 1, "admission", "upload");
  if (deploymentVersionId(input.deployment, "admission") !== active.id) {
    throw new TypeError("admission deployment Version Metadata ID does not match");
  }
  if (Date.parse(verifiedAt) < Date.parse(active.metadata.created_on)) {
    throw new TypeError("Worker admission attestation predates the deployment");
  }

  const currentAttestation = validateWorkerVersionAttestation(input.currentAttestation);
  const currentActive = currentAttestation.versions.at(-1);
  if (
    !before.some((version) => version.id === currentAttestation.activeVersionId) ||
    currentActive.versionId !== currentAttestation.activeVersionId ||
    currentActive.publicAdmissionPercent !== 0
  ) {
    throw new TypeError("Worker admission predecessor is not the active rollout-zero version");
  }
  verifyActiveWorkerDeployment(
    input.beforeDeployment,
    currentAttestation.activeVersionId,
    "canary",
  );
  verifyActiveWorkerDeployment(input.afterDeployment, active.id, "public");

  verifyAdmissionConfigPair(
    input.currentConfig,
    input.nextConfig,
    input.fromPublicAdmissionPercent,
    input.publicAdmissionPercent,
  );
  const workerModuleSha256 = sha256Bytes(input.workerModule);
  const previousConfigSha256 = sha256Bytes(input.currentConfig);
  const generatedConfigSha256 = sha256Bytes(input.nextConfig);
  const releaseReportSha256 = sha256Bytes(input.releaseReport);
  if (
    currentAttestation.workerModuleSha256 !== workerModuleSha256 ||
    currentAttestation.generatedConfigSha256 !== previousConfigSha256 ||
    currentAttestation.releaseReportSha256 !== releaseReportSha256
  ) {
    throw new TypeError("Worker admission artifacts do not match the canary attestation");
  }
  for (const [label, configText] of [
    ["current", input.currentConfig],
    ["next", input.nextConfig],
  ]) {
    const { variables } = parseAdmissionConfig(configText, label);
    if (variables.RELEASE_REPORT_SHA256 !== releaseReportSha256) {
      throw new TypeError(`${label} config release report hash does not match`);
    }
  }

  return {
    schema: "hereisit-worker-admission-transition@1",
    version: 1,
    verifiedAt,
    fromVersionId: currentAttestation.activeVersionId,
    activeVersionId: active.id,
    fromPublicAdmissionPercent: 0,
    publicAdmissionPercent: 100,
    workerModuleSha256,
    previousConfigSha256,
    generatedConfigSha256,
    releaseReportSha256,
    versions: [{ versionId: active.id, state: "active", publicAdmissionPercent: 100 }],
  };
}
