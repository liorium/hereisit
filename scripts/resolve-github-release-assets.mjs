import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExactKeys,
  assertObject,
  assertSha256,
  canonicalJson,
  parseCliArguments,
  sha256Bytes,
  sha256Canonical,
  writeCanonicalJsonAtomic,
} from "./image-lab-common.mjs";
import {
  readProcessingReleaseAssetField,
  validateProcessingReleaseAssets,
} from "./read-processing-release-assets.mjs";
import { verifyAndExtractTreeArchive } from "./verify-and-extract-tree-archive.mjs";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_API_ORIGIN = "https://api.github.com";
const REPOSITORY = "liorium/hereisit";
const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024;
const MAXIMUM_CANDIDATE_BYTES = 1024 * 1024;
const MAXIMUM_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const releaseTagPattern = /^processing-release-([0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*)$/;
const gitShaPattern = /^[0-9a-f]{40}$/;

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("GitHub API origin is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new TypeError("GitHub API origin must be an exact HTTPS or loopback HTTP origin");
  }
  return url.origin;
}

function apiHeaders(token, accept = "application/vnd.github+json") {
  if (typeof token !== "string" || token.length < 1 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new TypeError("GitHub token is invalid");
  }
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "hereisit-release-asset-resolver/1",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function readBoundedResponse(response, maximumBytes, label) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new RangeError(`${label} exceeds the size limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new RangeError(`${label} exceeds the size limit`);
  if (declared !== null && Number(declared) !== bytes.byteLength) {
    throw new TypeError(`${label} content length does not match`);
  }
  return bytes;
}

async function requestJson(origin, path, headers) {
  const response = await fetch(`${origin}${path}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  const bytes = await readBoundedResponse(response, MAXIMUM_JSON_BYTES, "GitHub API response");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("GitHub API response is not valid JSON");
  }
}

function validateRelease(document, origin, repository, releaseTag) {
  const release = assertObject(document, "GitHub release");
  const id = assertPositiveSafeInteger(release.id, "GitHub release ID");
  if (
    release.tag_name !== releaseTag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.url !== `${origin}/repos/${repository}/releases/${id}` ||
    release.assets_url !== `${origin}/repos/${repository}/releases/${id}/assets` ||
    release.html_url !== `https://github.com/${repository}/releases/tag/${releaseTag}`
  ) {
    throw new TypeError("GitHub release identity does not match");
  }
  return id;
}

async function resolveAnnotatedTag(origin, repository, releaseTag, headers, expectedTargetSha) {
  const reference = assertObject(
    await requestJson(origin, `/repos/${repository}/git/ref/tags/${releaseTag}`, headers),
    "Git tag reference",
  );
  const object = assertObject(reference.object, "Git tag reference object");
  if (
    reference.ref !== `refs/tags/${releaseTag}` ||
    object.type !== "tag" ||
    typeof object.sha !== "string" ||
    !gitShaPattern.test(object.sha)
  ) {
    throw new TypeError("release tag must be one immutable annotated tag");
  }
  const tag = assertObject(
    await requestJson(origin, `/repos/${repository}/git/tags/${object.sha}`, headers),
    "annotated Git tag",
  );
  const target = assertObject(tag.object, "annotated Git tag target");
  if (
    tag.tag !== releaseTag ||
    tag.sha !== object.sha ||
    target.type !== "commit" ||
    target.sha !== expectedTargetSha
  ) {
    throw new TypeError("release tag target SHA does not match the candidate source");
  }
}

async function listReleaseAssets(origin, repository, releaseId, headers) {
  const assets = [];
  for (let page = 1; page <= 10; page += 1) {
    const document = await requestJson(
      origin,
      `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      headers,
    );
    if (!Array.isArray(document)) throw new TypeError("GitHub release asset list is invalid");
    assets.push(...document);
    if (document.length < 100) break;
    if (page === 10) throw new RangeError("GitHub release asset list exceeds the fixed limit");
  }
  const ids = assets.map((asset) => assertObject(asset, "GitHub release asset").id);
  const names = assets.map((asset) => asset.name);
  if (new Set(ids).size !== ids.length)
    throw new TypeError("GitHub release asset IDs are duplicated");
  if (new Set(names).size !== names.length) {
    throw new TypeError("GitHub release asset names are duplicated");
  }
  return assets;
}

async function loadCandidate(candidateRoot, expectedReleaseId) {
  const root = resolve(candidateRoot);
  if ((await realpath(root)) !== root)
    throw new TypeError("candidate root must not be a symbolic link");
  const path = join(root, "processing-candidate.json");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new TypeError("processing candidate manifest must not be a symbolic link");
    }
    throw error;
  }
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new TypeError("processing candidate manifest must be a regular file");
    }
    if (metadata.size < 1 || metadata.size > MAXIMUM_CANDIDATE_BYTES) {
      throw new RangeError("processing candidate manifest exceeds the size limit");
    }
    bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) {
      throw new TypeError("processing candidate manifest changed while reading");
    }
  } finally {
    await handle.close();
  }
  let candidate;
  try {
    candidate = assertObject(JSON.parse(bytes), "processing candidate manifest");
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new TypeError("processing candidate manifest is invalid JSON");
    throw error;
  }
  if (
    candidate.schema !== "hereisit-processing-candidate@1" ||
    candidate.version !== 1 ||
    candidate.state !== "finalized" ||
    candidate.releaseId !== expectedReleaseId ||
    typeof candidate.gitSha !== "string" ||
    !gitShaPattern.test(candidate.gitSha)
  ) {
    throw new TypeError("processing candidate identity is invalid");
  }
  assertObject(candidate.releaseAssets, "candidate release assets");
  return { candidate, bytes, root };
}

function expectedAssets(candidate, candidateBytes, releaseId) {
  const assets = assertObject(candidate.releaseAssets, "candidate release assets");
  const engine = assertObject(assets.engine, "candidate engine assets");
  const web = assertObject(assets.web, "candidate web assets");
  const evidence = assertObject(assets.evidence, "candidate evidence assets");
  const generic = (key, suffix, identity) => {
    const value = assertObject(identity, `candidate ${key} asset`);
    assertPositiveSafeInteger(value.sizeBytes, `candidate ${key} asset size`);
    assertSha256(value.sha256, `candidate ${key} asset SHA-256`);
    if (value.path !== suffix) throw new TypeError(`candidate ${key} asset path does not match`);
    return {
      key,
      name: `candidate-v1--${releaseId}--${suffix}`,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
    };
  };
  const webAsset = (environment, identity) => {
    const value = assertObject(identity, `candidate ${environment} web asset`);
    assertPositiveSafeInteger(value.sizeBytes, `candidate ${environment} web asset size`);
    assertSha256(value.archiveSha256, `candidate ${environment} web archive SHA-256`);
    assertSha256(value.treeSha256, `candidate ${environment} web tree SHA-256`);
    return {
      key: `web.${environment}`,
      name: `candidate-v1--${releaseId}--web-${environment}.tar`,
      sizeBytes: value.sizeBytes,
      sha256: value.archiveSha256,
      treeSha256: value.treeSha256,
      processingApiOrigin: value.processingApiOrigin,
      environment,
    };
  };
  const evidenceAsset = (key, suffix, identity) => {
    const value = generic(key, suffix, identity);
    return { ...value, name: suffix };
  };
  return [
    {
      key: "candidate",
      name: `candidate-v1--${releaseId}--processing-candidate.json`,
      sizeBytes: candidateBytes.byteLength,
      sha256: sha256Bytes(candidateBytes),
    },
    generic("report", "processing-release-report.json", assets.report),
    generic("engine.oci", "image-engine-linux-amd64.oci.tar", engine.oci),
    generic("engine.docker", "image-engine-linux-amd64.docker.tar", engine.docker),
    generic("worker", "api-worker.mjs", assets.worker),
    webAsset("staging", web.staging),
    webAsset("production", web.production),
    evidenceAsset(
      "evidence.bundle",
      `evidence-v1--${releaseId}--processing-evidence.json`,
      evidence.bundle,
    ),
    evidenceAsset(
      "evidence.signature",
      `evidence-v1--${releaseId}--processing-evidence.sig`,
      evidence.signature,
    ),
  ];
}

function validateAssetMetadata(asset, expected, origin, repository, releaseTag) {
  const value = assertObject(asset, "GitHub release asset");
  const assetId = assertPositiveSafeInteger(value.id, "GitHub release asset ID");
  if (
    value.name !== expected.name ||
    value.size !== expected.sizeBytes ||
    value.state !== "uploaded" ||
    value.digest !== `sha256:${expected.sha256}` ||
    value.url !== `${origin}/repos/${repository}/releases/assets/${assetId}` ||
    value.browser_download_url !==
      `https://github.com/${repository}/releases/download/${releaseTag}/${expected.name}`
  ) {
    throw new TypeError(`GitHub release asset metadata does not match for ${expected.key}`);
  }
  return assetId;
}

function assertDownloadUrl(value, apiOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("release asset redirect URL is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new TypeError("release asset redirect URL is unsafe");
  }
  if (apiOrigin.startsWith("http://127.0.0.1:") && url.origin !== apiOrigin) {
    throw new TypeError("loopback release asset redirect changed origin");
  }
  return url.href;
}

async function writeChunk(handle, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten < 1) throw new Error("release asset download stopped before completion");
    offset += bytesWritten;
  }
}

async function downloadAsset({ origin, repository, assetId, headers, expected, output }) {
  const response = await fetch(`${origin}/repos/${repository}/releases/assets/${assetId}`, {
    headers: { ...headers, accept: "application/octet-stream" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 302) {
    throw new Error(`GitHub release asset download returned HTTP ${response.status}`);
  }
  const location = response.headers.get("location");
  if (location === null) throw new TypeError("release asset download redirect is missing");
  const download = await fetch(assertDownloadUrl(location, origin), {
    headers: { "user-agent": "hereisit-release-asset-resolver/1" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!download.ok || download.body === null) {
    throw new Error(`release asset byte download returned HTTP ${download.status}`);
  }
  const declared = download.headers.get("content-length");
  if (declared !== null && Number(declared) !== expected.sizeBytes) {
    throw new TypeError("release asset download size does not match metadata");
  }
  if (expected.sizeBytes > MAXIMUM_ASSET_BYTES) {
    throw new RangeError("release asset exceeds the size limit");
  }
  const hash = createHash("sha256");
  const handle = await open(output, "wx", 0o600);
  let sizeBytes = 0;
  try {
    for await (const rawChunk of download.body) {
      const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > expected.sizeBytes || sizeBytes > MAXIMUM_ASSET_BYTES) {
        throw new RangeError("release asset download exceeds the expected size");
      }
      hash.update(chunk);
      await writeChunk(handle, chunk);
    }
  } finally {
    await handle.close();
  }
  if (sizeBytes !== expected.sizeBytes) {
    throw new TypeError("release asset downloaded size does not match metadata");
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expected.sha256) throw new TypeError("downloaded release asset SHA-256 mismatch");
  return { sizeBytes, sha256 };
}

function buildManifest({ releaseTag, targetSha, releaseIdNumber, resolved }) {
  const get = (key) => resolved.get(key);
  const payload = {
    schema: "hereisit-processing-release-assets@1",
    version: 1,
    apiOrigin: GITHUB_API_ORIGIN,
    repository: REPOSITORY,
    release: { id: releaseIdNumber, tag: releaseTag, targetSha },
    candidate: get("candidate"),
    report: get("report"),
    engine: { oci: get("engine.oci"), docker: get("engine.docker") },
    worker: get("worker"),
    web: { staging: get("web.staging"), production: get("web.production") },
    evidence: { bundle: get("evidence.bundle"), signature: get("evidence.signature") },
  };
  return { ...payload, verificationSha256: sha256Canonical(payload) };
}

export async function resolveGitHubReleaseAssets({
  repository,
  releaseTag,
  candidateRoot,
  output,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone resolver intentionally follows the GitHub Actions API-origin contract outside Turbo tasks.
  apiOrigin = process.env.GITHUB_API_URL ?? GITHUB_API_ORIGIN,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: credentials are runtime-only CLI inputs and must never enter Turbo cache keys.
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
}) {
  if (repository !== REPOSITORY) throw new TypeError("repository must be liorium/hereisit");
  const releaseMatch = releaseTagPattern.exec(releaseTag);
  if (releaseMatch === null) throw new TypeError("release tag is invalid");
  const releaseId = releaseMatch[1];
  const origin = assertApiOrigin(apiOrigin);
  const headers = apiHeaders(token);
  const outputPath = resolve(output);
  try {
    await lstat(outputPath);
    throw new Error("output file already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = await realpath(dirname(outputPath));
  if (join(parent, basename(outputPath)) !== outputPath) {
    throw new TypeError("output path parent is not canonical");
  }

  const loaded = await loadCandidate(candidateRoot, releaseId);
  const expected = expectedAssets(loaded.candidate, loaded.bytes, releaseId);
  const release = await requestJson(
    origin,
    `/repos/${repository}/releases/tags/${releaseTag}`,
    headers,
  );
  const releaseIdNumber = validateRelease(release, origin, repository, releaseTag);
  await resolveAnnotatedTag(origin, repository, releaseTag, headers, loaded.candidate.gitSha);
  const assets = await listReleaseAssets(origin, repository, releaseIdNumber, headers);
  if (assets.length !== expected.length) {
    throw new TypeError("GitHub release must contain the exact candidate and evidence asset set");
  }
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  if (expected.some(({ name }) => !byName.has(name))) {
    throw new TypeError("GitHub release contains an unexpected or missing asset");
  }

  const temporary = await mkdtemp(join(parent, ".hereisit-release-assets-"));
  const resolvedAssets = new Map();
  try {
    for (const identity of expected) {
      const metadata = byName.get(identity.name);
      const assetId = validateAssetMetadata(metadata, identity, origin, repository, releaseTag);
      const path = join(temporary, `${assetId}.asset`);
      await downloadAsset({
        origin,
        repository,
        assetId,
        headers,
        expected: identity,
        output: path,
      });
      if (identity.environment !== undefined) {
        const extracted = join(temporary, `${identity.environment}-tree`);
        await verifyAndExtractTreeArchive({
          archive: path,
          expectedArchiveSha256: identity.sha256,
          expectedTreeSha256: identity.treeSha256,
          output: extracted,
        });
        await rm(extracted, { recursive: true, force: true });
      }
      await rm(path, { force: true });
      const apiUrl = `${GITHUB_API_ORIGIN}/repos/${repository}/releases/assets/${assetId}`;
      const record = {
        assetId,
        name: identity.name,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sha256,
        apiUrl,
      };
      resolvedAssets.set(
        identity.key,
        identity.environment === undefined
          ? record
          : {
              ...record,
              archiveSha256: identity.sha256,
              treeSha256: identity.treeSha256,
              processingApiOrigin: identity.processingApiOrigin,
            },
      );
    }
    const manifest = buildManifest({
      releaseTag,
      targetSha: loaded.candidate.gitSha,
      releaseIdNumber,
      resolved: resolvedAssets,
    });
    validateProcessingReleaseAssets(manifest);
    await readProcessingReleaseAssetField(manifest, loaded.root, "worker.assetId");
    await writeCanonicalJsonAtomic(outputPath, manifest, { refuseOverwrite: true });
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  assertExactKeys(
    args,
    ["repo", "release-tag", "candidate-root", "output"],
    "GitHub release asset resolver arguments",
  );
  const manifest = await resolveGitHubReleaseAssets({
    repository: args.repo,
    releaseTag: args["release-tag"],
    candidateRoot: args["candidate-root"],
    output: args.output,
  });
  process.stdout.write(
    `${canonicalJson({
      version: 1,
      releaseId: manifest.release.id,
      releaseTag: manifest.release.tag,
      targetSha: manifest.release.targetSha,
      verificationSha256: manifest.verificationSha256,
    })}`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
