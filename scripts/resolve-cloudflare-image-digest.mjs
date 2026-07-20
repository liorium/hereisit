import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./image-lab-common.mjs";
import { validateProcessingCandidate } from "./read-processing-candidate.mjs";

const accountPattern = /^[0-9a-f]{32}$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function validateRequestedReference(imageRef, accountId) {
  if (typeof accountId !== "string" || !accountPattern.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid");
  }
  if (typeof imageRef !== "string") throw new TypeError("image reference is invalid");
  const pattern = new RegExp(
    `^registry\\.cloudflare\\.com/${accountId}/hereisit-image-engine:([0-9a-f]{40})$`,
  );
  if (!pattern.test(imageRef)) {
    throw new TypeError(
      "image reference must be the same-account Cloudflare repository with an immutable git tag",
    );
  }
}

function descriptorPlatform(entry) {
  const descriptor = assertObject(entry.Descriptor, "registry descriptor");
  const platform = assertObject(descriptor.platform, "registry descriptor platform");
  if (typeof platform.os !== "string" || typeof platform.architecture !== "string") {
    throw new TypeError("registry descriptor platform is malformed");
  }
  return `${platform.os}/${platform.architecture}`;
}

function selectRunnableDescriptor(manifest) {
  const entries = Array.isArray(manifest) ? manifest : [manifest];
  if (entries.length === 0) throw new TypeError("registry descriptor list is empty");
  const runnable = [];
  for (const entryValue of entries) {
    const entry = assertObject(entryValue, "registry manifest descriptor");
    const platform = descriptorPlatform(entry);
    if (platform === "linux/amd64") runnable.push(entry);
    else if (platform !== "unknown/unknown") {
      throw new TypeError(`unexpected registry platform descriptor: ${platform}`);
    }
  }
  if (runnable.length !== 1) {
    throw new TypeError("registry response must contain exactly one linux/amd64 descriptor");
  }
  return runnable[0];
}

function validateCandidateIdentity(value) {
  const identity = assertObject(value, "finalized candidate image identity");
  const configDigest = assertDigest(identity.configDigest, "candidate config digest");
  if (
    !Array.isArray(identity.distributionLayerDigests) ||
    identity.distributionLayerDigests.length === 0
  ) {
    throw new TypeError("candidate distribution layer digests must be a non-empty array");
  }
  const distributionLayerDigests = identity.distributionLayerDigests.map((digest) =>
    assertDigest(digest, "candidate distribution layer digest"),
  );
  return { configDigest, distributionLayerDigests };
}

export function resolveCloudflareImageDigest({ manifest, imageRef, accountId, candidateIdentity }) {
  validateRequestedReference(imageRef, accountId);
  const expected = validateCandidateIdentity(candidateIdentity);
  const selected = selectRunnableDescriptor(manifest);
  const descriptor = assertObject(selected.Descriptor, "selected registry descriptor");
  const digest = assertDigest(descriptor.digest, "selected registry manifest digest");
  if (selected.Ref !== `${imageRef}@${digest}`) {
    throw new TypeError("selected registry Ref does not match the requested image and digest");
  }
  const imageManifest = assertObject(selected.SchemaV2Manifest, "selected registry image manifest");
  if (imageManifest.schemaVersion !== 2) {
    throw new TypeError("selected registry image manifest schema is unsupported");
  }
  const config = assertObject(imageManifest.config, "registry image config");
  const configDigest = assertDigest(config.digest, "registry image config digest");
  if (configDigest !== expected.configDigest) {
    throw new TypeError("registry image config does not match the finalized candidate");
  }
  if (!Array.isArray(imageManifest.layers) || imageManifest.layers.length === 0) {
    throw new TypeError("registry image layers are missing");
  }
  const layerDigests = imageManifest.layers.map((layer) =>
    assertDigest(assertObject(layer, "registry image layer").digest, "registry layer digest"),
  );
  if (
    layerDigests.length !== expected.distributionLayerDigests.length ||
    layerDigests.some(
      (layerDigest, index) => layerDigest !== expected.distributionLayerDigests[index],
    )
  ) {
    throw new TypeError("registry image ordered layers do not match the finalized candidate");
  }
  return `registry.cloudflare.com/${accountId}/hereisit-image-engine@${digest}`;
}

export function candidateIdentityFromManifest(candidate) {
  const root = validateProcessingCandidate(candidate);
  if (root.state !== "finalized") throw new TypeError("candidate manifest must be finalized");
  return validateCandidateIdentity({
    configDigest: root.engine.oci.configDigest,
    distributionLayerDigests: root.engine.oci.distributionLayerDigests,
  });
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const allowed = new Set(["manifest", "candidate-manifest", "image-ref", "account-id", "output"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) {
    throw new TypeError("unknown Cloudflare image resolver argument");
  }
  for (const key of allowed) {
    if (args[key] === undefined) throw new TypeError(`--${key} is required`);
  }
  const [manifest, candidate] = await Promise.all([
    readFile(resolve(args.manifest), "utf8").then(JSON.parse),
    readFile(resolve(args["candidate-manifest"]), "utf8").then(JSON.parse),
  ]);
  const image = resolveCloudflareImageDigest({
    manifest,
    imageRef: args["image-ref"],
    accountId: args["account-id"],
    candidateIdentity: candidateIdentityFromManifest(candidate),
  });
  await writeFile(resolve(args.output), `${image}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
