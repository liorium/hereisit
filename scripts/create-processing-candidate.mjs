import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments, sha256Canonical } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { verifyAndExtractTreeArchive } from "./verify-and-extract-tree-archive.mjs";
import {
  inspectDockerImageArchive,
  inspectOciImageArchive,
} from "./verify-image-archive-identities.mjs";
import { verifyProcessingCandidate } from "./verify-processing-candidate.mjs";

const releaseIdPattern = /^\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const gitShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maximumProviderSchemaBytes = 1024 * 1024;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const sourceNames = Object.freeze({
  oci: "image-engine-linux-amd64.oci.tar",
  docker: "image-engine-linux-amd64.docker.tar",
  worker: "api-worker.mjs",
  stagingWeb: "web-staging.tar",
  productionWeb: "web-production.tar",
});

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyAndHashRegularFile(source, destination, destinationName) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new TypeError(`${destinationName} must not be a symbolic link`);
    throw new Error(`${destinationName} source could not be read`);
  }
  try {
    const metadata = await sourceHandle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumAssetBytes) {
      throw new TypeError(`${destinationName} source must be a non-empty regular file`);
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
      if (totalBytes > metadata.size)
        throw new TypeError(`${destinationName} changed while reading`);
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
    if (totalBytes !== metadata.size)
      throw new TypeError(`${destinationName} changed while reading`);
    await destinationHandle.sync();
    return { path: destinationName, sizeBytes: totalBytes, sha256: hash.digest("hex") };
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

async function hashBoundedRegularFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new RangeError(`${label} is not a bounded regular file`);
    }
    const hash = createHash("sha256");
    let totalBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.byteLength;
      if (totalBytes > metadata.size) throw new TypeError(`${label} changed while reading`);
      hash.update(chunk);
    }
    if (totalBytes !== metadata.size) throw new TypeError(`${label} changed while reading`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function verifyWebIdentity(archivePath, asset, treeSha256, environment) {
  const extractionRoot = await mkdtemp(join(tmpdir(), "hereisit-built-web-verification-"));
  try {
    const result = await verifyAndExtractTreeArchive({
      archive: archivePath,
      expectedArchiveSha256: asset.sha256,
      expectedTreeSha256: treeSha256,
      output: join(extractionRoot, "tree"),
    });
    return {
      archiveSha256: result.archiveSha256,
      treeSha256: result.treeSha256,
      processingApiOrigin: environment,
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

function assertInput(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export async function createBuiltProcessingCandidate({
  sourceRoot,
  outputRoot,
  releaseId,
  gitSha,
  stagingProcessingApiOrigin,
  productionProcessingApiOrigin,
  stagingWebTreeSha256,
  productionWebTreeSha256,
  trivyDbDigest,
  providerUsageSchemaPath,
}) {
  assertInput(releaseId, releaseIdPattern, "processing release ID");
  assertInput(gitSha, gitShaPattern, "processing source git SHA");
  assertInput(stagingWebTreeSha256, /^[a-f0-9]{64}$/, "staging web tree hash");
  assertInput(productionWebTreeSha256, /^[a-f0-9]{64}$/, "production web tree hash");
  assertInput(trivyDbDigest, digestPattern, "Trivy DB digest");

  const requestedSourceRoot = resolve(sourceRoot);
  const canonicalSourceRoot = await realpath(requestedSourceRoot);
  if (canonicalSourceRoot !== requestedSourceRoot) {
    throw new TypeError("candidate source root must be canonical and must not be a symbolic link");
  }
  const sourceMetadata = await lstat(canonicalSourceRoot);
  if (!sourceMetadata.isDirectory())
    throw new TypeError("candidate source root must be a directory");

  const outputParent = await realpath(dirname(resolve(outputRoot)));
  const finalOutputRoot = join(outputParent, basename(resolve(outputRoot)));
  const outputRelative = relative(canonicalSourceRoot, finalOutputRoot);
  if (
    outputRelative === "" ||
    (!outputRelative.startsWith(`..${sep}`) &&
      outputRelative !== ".." &&
      !isAbsolute(outputRelative))
  ) {
    throw new TypeError("built candidate output must be outside the source root");
  }
  if (await pathExists(finalOutputRoot)) throw new Error("built candidate output already exists");
  const temporaryRoot = await mkdtemp(join(outputParent, ".hereisit-built-candidate-"));
  let published = false;
  try {
    const copied = {};
    for (const [key, name] of Object.entries(sourceNames)) {
      copied[key] = await copyAndHashRegularFile(
        join(canonicalSourceRoot, name),
        join(temporaryRoot, name),
        name,
      );
    }

    const loadedImage = `hereisit-image-engine:${gitSha}`;
    const oci = await inspectOciImageArchive({
      archivePath: join(temporaryRoot, sourceNames.oci),
      asset: copied.oci,
    });
    const docker = await inspectDockerImageArchive({
      archivePath: join(temporaryRoot, sourceNames.docker),
      asset: copied.docker,
      expectedRepoTag: loadedImage,
    });
    if (
      oci.configDigest !== docker.configDigest ||
      oci.diffIds.length !== docker.diffIds.length ||
      oci.diffIds.some((digest, index) => digest !== docker.diffIds[index])
    ) {
      throw new TypeError("OCI and Docker source archive identities do not match");
    }

    const stagingWeb = await verifyWebIdentity(
      join(temporaryRoot, sourceNames.stagingWeb),
      copied.stagingWeb,
      stagingWebTreeSha256,
      stagingProcessingApiOrigin,
    );
    const productionWeb = await verifyWebIdentity(
      join(temporaryRoot, sourceNames.productionWeb),
      copied.productionWeb,
      productionWebTreeSha256,
      productionProcessingApiOrigin,
    );
    const providerUsageSchemaSha256 = await hashBoundedRegularFile(
      resolve(providerUsageSchemaPath),
      maximumProviderSchemaBytes,
      "provider usage schema",
    );

    const webReleaseAsset = (asset, identity) => ({
      path: asset.path,
      sizeBytes: asset.sizeBytes,
      archiveSha256: identity.archiveSha256,
      treeSha256: identity.treeSha256,
      processingApiOrigin: identity.processingApiOrigin,
    });
    const payload = {
      schema: "hereisit-processing-candidate@1",
      version: 1,
      state: "built",
      releaseId,
      gitSha,
      engine: { loadedImage, oci, docker },
      web: { staging: stagingWeb, production: productionWeb },
      security: { trivyDbDigest },
      providerUsage: { schemaSha256: providerUsageSchemaSha256 },
      releaseAssets: {
        engine: { oci: copied.oci, docker: copied.docker },
        worker: copied.worker,
        web: {
          staging: webReleaseAsset(copied.stagingWeb, stagingWeb),
          production: webReleaseAsset(copied.productionWeb, productionWeb),
        },
      },
    };
    const candidate = validateProcessingCandidate({
      ...payload,
      verificationSha256: sha256Canonical(payload),
    });
    const manifestPath = join(temporaryRoot, "processing-candidate.json");
    await writeFile(manifestPath, canonicalJson(candidate), { flag: "wx", mode: 0o600 });
    await verifyProcessingCandidate({
      manifestPath,
      root: temporaryRoot,
      requiredState: "built",
      expectedGitSha: gitSha,
    });
    if (await pathExists(finalOutputRoot)) throw new Error("built candidate output already exists");
    await rename(temporaryRoot, finalOutputRoot);
    published = true;
    return candidate;
  } finally {
    if (!published) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runProcessingCandidateCreator(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const keys = [
    "source-root",
    "output-root",
    "release-id",
    "git-sha",
    "staging-processing-api-origin",
    "production-processing-api-origin",
    "staging-web-tree-sha256",
    "production-web-tree-sha256",
    "trivy-db-digest",
    "provider-usage-schema",
  ];
  if (
    Object.keys(args).length !== keys.length ||
    Object.keys(args).some((key) => !keys.includes(key))
  ) {
    throw new TypeError("built candidate creator arguments are invalid");
  }
  const candidate = await createBuiltProcessingCandidate({
    sourceRoot: args["source-root"],
    outputRoot: args["output-root"],
    releaseId: args["release-id"],
    gitSha: args["git-sha"],
    stagingProcessingApiOrigin: args["staging-processing-api-origin"],
    productionProcessingApiOrigin: args["production-processing-api-origin"],
    stagingWebTreeSha256: args["staging-web-tree-sha256"],
    productionWebTreeSha256: args["production-web-tree-sha256"],
    trivyDbDigest: args["trivy-db-digest"],
    providerUsageSchemaPath: args["provider-usage-schema"],
  });
  stdout.write(
    canonicalJson({
      schema: "hereisit-processing-candidate-creation@1",
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
    await runProcessingCandidateCreator(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "built candidate creation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
