import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments, sha256Canonical } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { verifyProcessingCandidate } from "./verify-processing-candidate.mjs";

const maximumManifestBytes = 1024 * 1024;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const maximumSecurityGateBytes = 1024 * 1024;
const maximumSecurityEvidenceBytes = 8 * 1024 * 1024;

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readBuiltCandidate(root) {
  const manifestPath = join(root, "processing-candidate.json");
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError("built candidate manifest is symbolic");
    throw new Error("built candidate manifest could not be read");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumManifestBytes) {
      throw new RangeError("built candidate manifest is not a bounded regular file");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) {
      throw new TypeError("built candidate manifest changed while reading");
    }
    let value;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new TypeError("built candidate manifest is not valid JSON");
    }
    const candidate = validateProcessingCandidate(value);
    if (candidate.state !== "built") throw new TypeError("candidate must be in the built state");
    return candidate;
  } finally {
    await handle.close();
  }
}

async function copyAndHash(source, destination, destinationName, maximumBytes = maximumAssetBytes) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${destinationName} must not be symbolic`);
    throw new Error(`${destinationName} could not be read`);
  }
  try {
    const metadata = await sourceHandle.stat({ bigint: true });
    const sizeBytes = Number(metadata.size);
    if (!metadata.isFile() || metadata.size < 1n || metadata.size > BigInt(maximumBytes)) {
      throw new RangeError(`${destinationName} is not a bounded regular file`);
    }
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const hash = createHash("sha256");
    let totalBytes = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.byteLength;
      if (totalBytes > sizeBytes) throw new TypeError(`${destinationName} changed while reading`);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await destinationHandle.write(
          chunk,
          written,
          chunk.byteLength - written,
          totalBytes - chunk.byteLength + written,
        );
        written += result.bytesWritten;
      }
    }
    const finalMetadata = await sourceHandle.stat({ bigint: true });
    if (
      totalBytes !== sizeBytes ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeNs !== metadata.mtimeNs ||
      finalMetadata.ctimeNs !== metadata.ctimeNs
    )
      throw new TypeError(`${destinationName} changed while reading`);
    await destinationHandle.sync();
    return { path: destinationName, sizeBytes: totalBytes, sha256: hash.digest("hex") };
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

function assertCopiedIdentity(copied, expected, label, hashField = "sha256") {
  if (
    copied.path !== expected.path ||
    copied.sizeBytes !== expected.sizeBytes ||
    copied.sha256 !== expected[hashField]
  ) {
    throw new TypeError(`${label} changed while finalizing`);
  }
}

export async function finalizeProcessingCandidate({
  builtRoot,
  outputRoot,
  reportPath,
  evidenceBundlePath,
  evidenceSignaturePath,
}) {
  const requestedBuiltRoot = resolve(builtRoot);
  const canonicalBuiltRoot = await realpath(requestedBuiltRoot);
  if (canonicalBuiltRoot !== requestedBuiltRoot) {
    throw new TypeError("built candidate root must be canonical and must not be symbolic");
  }
  const builtMetadata = await lstat(canonicalBuiltRoot);
  if (!builtMetadata.isDirectory()) throw new TypeError("built candidate root must be a directory");
  const built = await readBuiltCandidate(canonicalBuiltRoot);
  await verifyProcessingCandidate({
    manifestPath: join(canonicalBuiltRoot, "processing-candidate.json"),
    root: canonicalBuiltRoot,
    requiredState: "built",
    expectedGitSha: built.gitSha,
  });

  const outputParent = await realpath(dirname(resolve(outputRoot)));
  const finalOutputRoot = join(outputParent, basename(resolve(outputRoot)));
  const outputRelative = relative(canonicalBuiltRoot, finalOutputRoot);
  if (
    outputRelative === "" ||
    (!outputRelative.startsWith(`..${sep}`) &&
      outputRelative !== ".." &&
      !isAbsolute(outputRelative))
  ) {
    throw new TypeError("finalized candidate output must be outside the built root");
  }
  if (await pathExists(finalOutputRoot))
    throw new Error("finalized candidate output already exists");
  const temporaryRoot = await mkdtemp(join(outputParent, ".hereisit-finalized-candidate-"));
  let published = false;
  try {
    const copyBuilt = async (
      asset,
      label,
      hashField = "sha256",
      maximumBytes = maximumAssetBytes,
    ) => {
      const copied = await copyAndHash(
        join(canonicalBuiltRoot, asset.path),
        join(temporaryRoot, asset.path),
        asset.path,
        maximumBytes,
      );
      assertCopiedIdentity(copied, asset, label, hashField);
      return copied;
    };
    const copiedOci = await copyBuilt(built.releaseAssets.engine.oci, "OCI asset");
    const copiedDocker = await copyBuilt(built.releaseAssets.engine.docker, "Docker asset");
    const copiedPdfOci = await copyBuilt(built.releaseAssets.pdfEngine.oci, "PDF OCI asset");
    const copiedPdfDocker = await copyBuilt(
      built.releaseAssets.pdfEngine.docker,
      "PDF Docker asset",
    );
    const copiedPdfQuality = {};
    for (const [name, asset] of Object.entries(built.releaseAssets.pdfQuality)) {
      copiedPdfQuality[name] = await copyBuilt(
        asset,
        `${name} PDF quality asset`,
        "sha256",
        maximumSecurityEvidenceBytes,
      );
    }
    const copiedWorker = await copyBuilt(built.releaseAssets.worker, "Worker asset");
    const copiedReleaseInputs = await copyBuilt(
      built.releaseAssets.releaseInputs,
      "processing release inputs asset",
    );
    const copiedCostModel = await copyBuilt(built.releaseAssets.costModel, "live cost model asset");
    await copyBuilt(built.releaseAssets.web.staging, "staging web asset", "archiveSha256");
    await copyBuilt(built.releaseAssets.web.production, "production web asset", "archiveSha256");
    for (const [groupName, group] of Object.entries(built.releaseAssets.security)) {
      for (const [name, asset] of Object.entries(group)) {
        await copyBuilt(
          asset,
          `${name} security ${groupName} asset`,
          "sha256",
          groupName === "gates" ? maximumSecurityGateBytes : maximumSecurityEvidenceBytes,
        );
      }
    }

    const report = await copyAndHash(
      resolve(reportPath),
      join(temporaryRoot, "processing-release-report.json"),
      "processing-release-report.json",
    );
    const bundleName = `evidence-v1--${built.releaseId}--processing-evidence.json`;
    const signatureName = `evidence-v1--${built.releaseId}--processing-evidence.sig`;
    const evidenceBundle = await copyAndHash(
      resolve(evidenceBundlePath),
      join(temporaryRoot, bundleName),
      bundleName,
    );
    const evidenceSignature = await copyAndHash(
      resolve(evidenceSignaturePath),
      join(temporaryRoot, signatureName),
      signatureName,
    );

    const { verificationSha256: _verificationSha256, ...builtPayload } = built;
    const payload = {
      ...builtPayload,
      state: "finalized",
      releaseAssets: {
        report,
        engine: { oci: copiedOci, docker: copiedDocker },
        pdfEngine: { oci: copiedPdfOci, docker: copiedPdfDocker },
        pdfQuality: copiedPdfQuality,
        worker: copiedWorker,
        releaseInputs: copiedReleaseInputs,
        costModel: copiedCostModel,
        web: built.releaseAssets.web,
        security: built.releaseAssets.security,
        evidence: { bundle: evidenceBundle, signature: evidenceSignature },
      },
    };
    const finalized = validateProcessingCandidate({
      ...payload,
      verificationSha256: sha256Canonical(payload),
    });
    const manifestPath = join(temporaryRoot, "processing-candidate.json");
    await writeFile(manifestPath, canonicalJson(finalized), { flag: "wx", mode: 0o600 });
    await verifyProcessingCandidate({
      manifestPath,
      root: temporaryRoot,
      requiredState: "finalized",
      expectedGitSha: finalized.gitSha,
    });
    if (await pathExists(finalOutputRoot)) {
      throw new Error("finalized candidate output already exists");
    }
    await rename(temporaryRoot, finalOutputRoot);
    published = true;
    return finalized;
  } finally {
    if (!published) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runProcessingCandidateFinalizer(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const keys = ["built-root", "output-root", "report", "evidence-bundle", "evidence-signature"];
  if (
    Object.keys(args).length !== keys.length ||
    Object.keys(args).some((key) => !keys.includes(key))
  ) {
    throw new TypeError("candidate finalizer arguments are invalid");
  }
  const candidate = await finalizeProcessingCandidate({
    builtRoot: args["built-root"],
    outputRoot: args["output-root"],
    reportPath: args.report,
    evidenceBundlePath: args["evidence-bundle"],
    evidenceSignaturePath: args["evidence-signature"],
  });
  stdout.write(
    canonicalJson({
      schema: "hereisit-processing-candidate-finalization@1",
      version: 1,
      state: candidate.state,
      releaseId: candidate.releaseId,
      gitSha: candidate.gitSha,
    }),
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingCandidateFinalizer(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "candidate finalization failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
