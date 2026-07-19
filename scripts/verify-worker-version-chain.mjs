import {
  assertExactKeys,
  assertObject,
  assertSha256,
  sha256Canonical,
} from "./image-lab-common.mjs";

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
    ["author_email", "author_id", "created_on", "hasPreview", "modified_on", "source"],
    `${label} metadata`,
  );
  if (typeof metadata.author_email !== "string" || metadata.author_email.length === 0) {
    throw new TypeError(`${label} author email is invalid`);
  }
  if (typeof metadata.author_id !== "string" || !authorIdPattern.test(metadata.author_id)) {
    throw new TypeError(`${label} author ID is invalid`);
  }
  assertCanonicalTimestamp(metadata.created_on, `${label} creation time`);
  assertCanonicalTimestamp(metadata.modified_on, `${label} modification time`);
  if (metadata.hasPreview !== true) throw new TypeError(`${label} must be deployable`);
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

function validateSnapshot(value, label) {
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

function deploymentVersionId(value, label) {
  const deployment = assertObject(value, `${label} deployment output`);
  if (typeof deployment.version_id !== "string" || !versionIdPattern.test(deployment.version_id)) {
    throw new TypeError(`${label} deployment Version Metadata ID is missing or invalid`);
  }
  return deployment.version_id;
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
  const before = validateSnapshot(snapshots.before, "before");
  const afterBootstrap = validateSnapshot(snapshots.afterBootstrap, "after-bootstrap");
  const afterSecrets = validateSnapshot(snapshots.afterSecrets, "after-secrets");
  const afterFinal = validateSnapshot(snapshots.afterFinal, "after-final");

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

  const previous = before.at(-1);
  return {
    schema: "hereisit-worker-version-attestations@1",
    version: 1,
    verifiedAt,
    ...finalHashes,
    activeVersionId: final.id,
    previousActive:
      previous === undefined
        ? null
        : {
            versionId: previous.id,
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
