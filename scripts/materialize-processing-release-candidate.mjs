import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { verifyProcessingCandidate } from "./verify-processing-candidate.mjs";

const releaseTagPattern = /^processing-release-(\d{4}-\d{2}-\d{2}\.[1-9]\d*)$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const oneMiB = 1024 * 1024;
const eightMiB = 8 * oneMiB;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const candidateSuffixes = Object.freeze([
  "processing-candidate.json",
  "processing-release-report.json",
  "image-engine-linux-amd64.oci.tar",
  "image-engine-linux-amd64.docker.tar",
  "api-worker.mjs",
  "processing-release-inputs.json",
  "live-cost-model.json",
  "web-staging.tar",
  "web-production.tar",
  "security-image-engine-license-gate.json",
  "security-application-supply-chain-gate.json",
  "security-vulnerability-gate.json",
  "security-sbom-engine.cdx.json",
  "security-sbom-web-staging.cdx.json",
  "security-sbom-web-production.cdx.json",
  "security-sbom-worker.cdx.json",
  "security-sbom-lockfile.cdx.json",
  "security-trivy-engine.json",
  "security-trivy-web-staging.json",
  "security-trivy-web-production.json",
  "security-trivy-worker.json",
  "security-trivy-lockfile.json",
]);

function processingReleaseMaterializationPlan(releaseTag, names) {
  const releaseId = releaseTagPattern.exec(releaseTag)?.[1];
  if (
    releaseId === undefined ||
    !Array.isArray(names) ||
    names.some((name) => typeof name !== "string")
  ) {
    throw new TypeError("release asset namespace is invalid");
  }
  const prefix = `candidate-v1--${releaseId}--`;
  const expected = new Map(
    candidateSuffixes.map((destination) => [`${prefix}${destination}`, destination]),
  );
  for (const suffix of ["processing-evidence.json", "processing-evidence.sig"]) {
    const name = `evidence-v1--${releaseId}--${suffix}`;
    expected.set(name, name);
  }
  if (
    names.length !== expected.size ||
    new Set(names).size !== names.length ||
    names.some((name) => !expected.has(name))
  ) {
    throw new TypeError("download tree must contain the exact release asset namespace");
  }
  return [...expected].map(([source, destination]) => ({ source, destination }));
}

function releaseAssetPlan(candidate) {
  const assets = candidate.releaseAssets;
  const result = new Map();
  const add = (descriptor, maximumBytes, hashField = "sha256", exactBytes) => {
    result.set(descriptor.path, { descriptor, exactBytes, hashField, maximumBytes });
  };
  add(assets.report, oneMiB);
  add(assets.engine.oci, maximumAssetBytes);
  add(assets.engine.docker, maximumAssetBytes);
  add(assets.worker, maximumAssetBytes);
  add(assets.releaseInputs, oneMiB);
  add(assets.costModel, oneMiB);
  add(assets.web.staging, maximumAssetBytes, "archiveSha256");
  add(assets.web.production, maximumAssetBytes, "archiveSha256");
  for (const descriptor of Object.values(assets.security.gates)) add(descriptor, oneMiB);
  for (const group of [assets.security.sboms, assets.security.vulnerabilityReports]) {
    for (const descriptor of Object.values(group)) add(descriptor, eightMiB);
  }
  add(assets.evidence.bundle, eightMiB);
  add(assets.evidence.signature, 64, "sha256", 64);
  if (result.size !== 23) throw new TypeError("candidate release asset set is invalid");
  return result;
}

function unchanged(before, after) {
  return (
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function copyRegularFile(
  source,
  destination,
  { maximumBytes, expectedSize, expectedSha256, exactBytes, afterCopyChunk },
) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      (exactBytes !== undefined && before.size !== BigInt(exactBytes)) ||
      (expectedSize !== undefined && before.size !== BigInt(expectedSize))
    ) {
      throw new TypeError("release asset must be a bounded unlinked regular file");
    }
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash("sha256");
    let offset = 0n;
    while (offset < before.size) {
      const length = Number(
        before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset,
      );
      const { bytesRead } = await input.read(buffer, 0, length, Number(offset));
      if (bytesRead < 1) throw new TypeError("release asset changed while materializing");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten < 1) throw new Error("release asset materialization stopped");
        written += result.bytesWritten;
      }
      offset += BigInt(bytesRead);
      await afterCopyChunk?.();
    }
    if (!unchanged(before, await input.stat({ bigint: true }))) {
      throw new TypeError("release asset changed while materializing");
    }
    const sha256 = hash.digest("hex");
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new TypeError("release asset hash does not match the finalized candidate");
    }
    return { sha256, sizeBytes: Number(offset) };
  } finally {
    try {
      await output?.close();
    } finally {
      await input.close();
    }
  }
}

export async function materializeProcessingReleaseCandidate(
  { releaseTag, downloadRoot, outputRoot, expectedGitSha },
  adapters = {},
) {
  if (!gitShaPattern.test(expectedGitSha)) throw new TypeError("expected Git SHA is invalid");
  const sourceRoot = resolve(downloadRoot);
  if ((await realpath(sourceRoot)) !== sourceRoot) {
    throw new TypeError("release download root must be canonical and must not be symbolic");
  }
  const sourceHandle = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY);
  let directoryMetadata;
  try {
    directoryMetadata = await sourceHandle.stat();
  } finally {
    await sourceHandle.close();
  }
  if (!directoryMetadata.isDirectory())
    throw new TypeError("release download root must be a directory");
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new TypeError("release download root may contain only regular files");
  }
  const plan = processingReleaseMaterializationPlan(
    releaseTag,
    entries.map((entry) => entry.name),
  );
  const finalRoot = resolve(outputRoot);
  const parent = await realpath(dirname(finalRoot));
  if (join(parent, basename(finalRoot)) !== finalRoot) {
    throw new TypeError("candidate output path must be canonical");
  }
  const temporaryRoot = await mkdtemp(join(parent, ".hereisit-release-candidate-"));
  let reserved = false;
  let published = false;
  try {
    const manifestEntry = plan.find(
      ({ destination }) => destination === "processing-candidate.json",
    );
    if (manifestEntry === undefined) throw new TypeError("candidate manifest asset is missing");
    await copyRegularFile(
      join(sourceRoot, manifestEntry.source),
      join(temporaryRoot, manifestEntry.destination),
      { maximumBytes: oneMiB },
    );
    const manifestBytes = await readFile(join(temporaryRoot, "processing-candidate.json"));
    let candidate;
    try {
      candidate = validateProcessingCandidate(JSON.parse(manifestBytes));
    } catch (error) {
      if (error instanceof SyntaxError) throw new TypeError("processing candidate JSON is invalid");
      throw error;
    }
    if (!manifestBytes.equals(Buffer.from(canonicalJson(candidate)))) {
      throw new TypeError("processing candidate manifest is not canonical JSON");
    }
    if (
      candidate.state !== "finalized" ||
      candidate.releaseId !== releaseTagPattern.exec(releaseTag)[1] ||
      candidate.gitSha !== expectedGitSha
    ) {
      throw new TypeError("processing candidate identity does not match the release");
    }
    const expected = releaseAssetPlan(candidate);
    for (const entry of plan) {
      if (entry === manifestEntry) continue;
      const bound = expected.get(entry.destination);
      if (bound === undefined) throw new TypeError("candidate release asset set is invalid");
      if (
        bound.descriptor.sizeBytes > bound.maximumBytes ||
        (bound.exactBytes !== undefined && bound.descriptor.sizeBytes !== bound.exactBytes)
      ) {
        throw new RangeError("candidate release asset size exceeds its bound");
      }
      await copyRegularFile(
        join(sourceRoot, entry.source),
        join(temporaryRoot, entry.destination),
        {
          maximumBytes: bound.maximumBytes,
          exactBytes: bound.exactBytes,
          expectedSize: bound.descriptor.sizeBytes,
          expectedSha256: bound.descriptor[bound.hashField],
          afterCopyChunk: () => adapters.afterCopyChunk?.(entry.destination),
        },
      );
    }
    await verifyProcessingCandidate({
      manifestPath: join(temporaryRoot, "processing-candidate.json"),
      root: temporaryRoot,
      requiredState: "finalized",
      expectedGitSha,
    });
    await adapters.beforeReserve?.();
    try {
      await mkdir(finalRoot, { mode: 0o700 });
      reserved = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("candidate output already exists");
      throw error;
    }
    for (const { destination } of plan) {
      await rename(join(temporaryRoot, destination), join(finalRoot, destination));
    }
    const verification = await verifyProcessingCandidate({
      manifestPath: join(finalRoot, "processing-candidate.json"),
      root: finalRoot,
      requiredState: "finalized",
      expectedGitSha,
    });
    published = true;
    return verification;
  } finally {
    if (!published && reserved) await rm(finalRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const required = ["release-tag", "download-root", "output-root", "expected-git-sha"];
  if (
    Object.keys(args).length !== required.length ||
    Object.keys(args).some((name) => !required.includes(name))
  ) {
    throw new TypeError("release candidate materializer arguments are invalid");
  }
  const result = await materializeProcessingReleaseCandidate({
    releaseTag: args["release-tag"],
    downloadRoot: args["download-root"],
    outputRoot: args["output-root"],
    expectedGitSha: args["expected-git-sha"],
  });
  process.stdout.write(canonicalJson(result));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch {
    process.stderr.write("processing release candidate materialization failed\n");
    process.exitCode = 1;
  }
}
