import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseCliArguments } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";
import { verifyAndExtractTreeArchive } from "./verify-and-extract-tree-archive.mjs";
import {
  verifyDockerImageArchive,
  verifyOciImageArchive,
} from "./verify-image-archive-identities.mjs";

const maximumManifestBytes = 1024 * 1024;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const gitShaPattern = /^[a-f0-9]{40}$/;

async function readBoundedRegularFile(path, maximumBytes, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} must be a regular file`);
    if (metadata.size < 1 || metadata.size > maximumBytes) {
      throw new RangeError(`${label} exceeds the size limit`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new TypeError(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyAsset(root, asset, label, hashField = "sha256") {
  const path = join(root, ...asset.path.split("/"));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new TypeError(`${label} must not be a symbolic link`);
    throw new Error(`${label} could not be read`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new TypeError(`${label} must be a regular file`);
    if (metadata.size !== asset.sizeBytes || metadata.size > maximumAssetBytes) {
      throw new TypeError(`${label} size does not match`);
    }
    const hash = createHash("sha256");
    let totalBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      totalBytes += chunk.byteLength;
      if (totalBytes > asset.sizeBytes) throw new TypeError(`${label} changed while reading`);
      hash.update(chunk);
    }
    if (totalBytes !== asset.sizeBytes) throw new TypeError(`${label} changed while reading`);
    if (hash.digest("hex") !== asset[hashField])
      throw new TypeError(`${label} hash does not match`);
    return path;
  } finally {
    await handle.close();
  }
}

function releaseAssetEntries(candidate) {
  const assets = candidate.releaseAssets;
  const entries = [[assets.worker, "Worker asset"]];
  if (candidate.state === "finalized") {
    entries.unshift([assets.report, "release report asset"]);
    entries.push(
      [assets.evidence.bundle, "evidence bundle asset"],
      [assets.evidence.signature, "evidence signature asset"],
    );
  }
  return entries;
}

async function verifyWebAsset(root, asset, environment) {
  const archivePath = await verifyAsset(root, asset, `${environment} web asset`, "archiveSha256");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hereisit-candidate-web-verification-"));
  try {
    return await verifyAndExtractTreeArchive({
      archive: archivePath,
      expectedArchiveSha256: asset.archiveSha256,
      expectedTreeSha256: asset.treeSha256,
      output: join(temporaryRoot, "tree"),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyProcessingCandidate({
  manifestPath,
  root,
  requiredState,
  expectedGitSha,
}) {
  if (requiredState !== "built" && requiredState !== "finalized") {
    throw new TypeError("required candidate state is invalid");
  }
  if (typeof expectedGitSha !== "string" || !gitShaPattern.test(expectedGitSha)) {
    throw new TypeError("expected git SHA is invalid");
  }
  const requestedRoot = resolve(root);
  const rootMetadata = await stat(requestedRoot);
  if (!rootMetadata.isDirectory()) throw new TypeError("candidate root must be a directory");
  const canonicalRoot = await realpath(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new TypeError("candidate root must not be a symbolic link or non-canonical path");
  }
  const canonicalManifestPath = join(canonicalRoot, "processing-candidate.json");
  if (resolve(manifestPath) !== canonicalManifestPath) {
    throw new TypeError("candidate manifest path must be canonical and inside the candidate root");
  }
  const manifestBytes = await readBoundedRegularFile(
    canonicalManifestPath,
    maximumManifestBytes,
    "processing candidate manifest",
  );
  let candidate;
  try {
    candidate = validateProcessingCandidate(JSON.parse(manifestBytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("processing candidate JSON is invalid");
    throw error;
  }
  if (candidate.state !== requiredState) {
    throw new TypeError("processing candidate state does not match the required state");
  }
  if (candidate.gitSha !== expectedGitSha) {
    throw new TypeError("processing candidate source SHA does not match");
  }

  await verifyOciImageArchive({
    archivePath: join(canonicalRoot, candidate.releaseAssets.engine.oci.path),
    asset: candidate.releaseAssets.engine.oci,
    expectedIdentity: candidate.engine.oci,
  });
  await verifyDockerImageArchive({
    archivePath: join(canonicalRoot, candidate.releaseAssets.engine.docker.path),
    asset: candidate.releaseAssets.engine.docker,
    expectedIdentity: candidate.engine.docker,
    expectedRepoTag: candidate.engine.loadedImage,
  });

  const entries = releaseAssetEntries(candidate);
  for (const [asset, label] of entries) await verifyAsset(canonicalRoot, asset, label);
  const staging = await verifyWebAsset(
    canonicalRoot,
    candidate.releaseAssets.web.staging,
    "staging",
  );
  const production = await verifyWebAsset(
    canonicalRoot,
    candidate.releaseAssets.web.production,
    "production",
  );
  return {
    schema: "hereisit-processing-candidate-verification@1",
    version: 1,
    state: candidate.state,
    releaseId: candidate.releaseId,
    gitSha: candidate.gitSha,
    assetCount: entries.length + 4,
    web: {
      staging: {
        archiveSha256: staging.archiveSha256,
        treeSha256: staging.treeSha256,
        fileCount: staging.fileCount,
        totalBytes: staging.totalBytes,
      },
      production: {
        archiveSha256: production.archiveSha256,
        treeSha256: production.treeSha256,
        fileCount: production.fileCount,
        totalBytes: production.totalBytes,
      },
    },
  };
}

export async function runProcessingCandidateVerifier(argv, stdout = process.stdout) {
  const args = parseCliArguments(argv);
  const expectedKeys = ["manifest", "root", "required-state", "expected-git-sha"];
  if (
    Object.keys(args).length !== expectedKeys.length ||
    Object.keys(args).some((key) => !expectedKeys.includes(key))
  ) {
    throw new TypeError("candidate verifier arguments are invalid");
  }
  const summary = await verifyProcessingCandidate({
    manifestPath: args.manifest,
    root: args.root,
    requiredState: args["required-state"],
    expectedGitSha: args["expected-git-sha"],
  });
  stdout.write(canonicalJson(summary));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await runProcessingCandidateVerifier(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "processing candidate verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
